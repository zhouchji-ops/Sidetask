use chrono::{Duration, Local, NaiveDate, Utc};
use std::collections::HashSet;
pub mod deadline;
use deadline::valid_date;
pub const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub notes: String,
    pub priority: String,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_timezone: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_at_utc: Option<String>,
    pub completed: bool,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub revision: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    pub task_id: String,
    pub date: String,
    pub sort_order: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub edge: String,
    pub panel_width: f64,
    pub panel_height: f64,
    pub reveal_delay: u64,
    pub hide_delay: u64,
    pub pinned: bool,
    pub edge_enabled: bool,
    pub theme: String,
    #[serde(default = "default_ui_style")]
    pub ui_style: String,
    pub ddl_sort: String,
}
fn default_ui_style() -> String {
    "paper".into()
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            edge: "right".into(),
            panel_width: 368.,
            panel_height: 610.,
            reveal_delay: 180,
            hide_delay: 450,
            pinned: false,
            edge_enabled: true,
            theme: "light".into(),
            ui_style: default_ui_style(),
            ddl_sort: "date".into(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub tasks: Vec<Task>,
    pub plans: Vec<Plan>,
    pub settings: Settings,
    pub revision: u64,
}
#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Action {
    #[serde(rename = "createTask")]
    CreateTask { task: Value, date: String },
    #[serde(rename = "updateTask", rename_all = "camelCase")]
    UpdateTask {
        id: String,
        changes: Value,
        expected_revision: u64,
    },
    #[serde(rename = "setCompleted", rename_all = "camelCase")]
    SetCompleted {
        id: String,
        completed: bool,
        expected_revision: u64,
    },
    #[serde(rename = "planTask")]
    PlanTask {
        id: String,
        planned: bool,
        date: String,
    },
    #[serde(rename = "updateSettings")]
    UpdateSettings { changes: Value },
    #[serde(rename = "resetDemo")]
    ResetDemo { date: String },
}
fn validate_task(task: &Task) -> Result<(), String> {
    if task.title.trim().is_empty() || task.title.trim().chars().count() > 240 {
        return Err("任务名称需为 1–240 个字。".into());
    }
    if task.notes.chars().count() > 10000 {
        return Err("备注不能超过 10000 个字。".into());
    }
    if !["high", "normal", "low"].contains(&task.priority.as_str()) {
        return Err("重要程度无效。".into());
    }
    deadline::validate(task)
}
fn validate_settings(settings: &Settings) -> Result<(), String> {
    if !["left", "right"].contains(&settings.edge.as_str())
        || !["light", "dark", "system"].contains(&settings.theme.as_str())
        || !["paper", "studio", "editorial", "mono"].contains(&settings.ui_style.as_str())
        || !["date", "priority"].contains(&settings.ddl_sort.as_str())
    {
        return Err("设置选项无效。".into());
    }
    if !settings.panel_width.is_finite()
        || !settings.panel_height.is_finite()
        || !(300. ..=640.).contains(&settings.panel_width)
        || !(380. ..=1000.).contains(&settings.panel_height)
        || settings.reveal_delay > 1500
        || !(100..=2500).contains(&settings.hide_delay)
    {
        return Err("小窗尺寸或延迟超出有效范围。".into());
    }
    Ok(())
}
fn merge_known(target: &mut Value, changes: &Value, allowed: &[&str]) -> Result<(), String> {
    let changes = changes.as_object().ok_or("更改内容无效。")?;
    for (key, val) in changes {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("不支持的字段：{key}"));
        }
        target[key] = val.clone();
    }
    Ok(())
}
impl Snapshot {
    pub fn empty() -> Self {
        Self {
            tasks: Vec::new(),
            plans: Vec::new(),
            settings: Settings::default(),
            revision: 1,
        }
    }
    /// Validate persisted/imported state without normalizing or mutating user data.
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=MAX_SAFE_REVISION).contains(&self.revision) {
            return Err("数据版本无效。".into());
        }
        validate_settings(&self.settings)?;
        let mut ids = HashSet::new();
        for task in &self.tasks {
            validate_task(task)?;
            if task.id.trim().is_empty() || task.id.len() > 128 || !ids.insert(&task.id) {
                return Err("任务 ID 无效或重复。".into());
            }
            if task.revision == 0 || task.revision > self.revision {
                return Err("任务版本无效。".into());
            }
            deadline::parse_utc(&task.created_at)?;
            match (task.completed, &task.completed_at) {
                (true, Some(at)) => {
                    deadline::parse_utc(at)?;
                }
                (false, None) => {}
                _ => return Err("任务完成状态与完成时间不一致。".into()),
            }
        }
        let mut plans = HashSet::new();
        for plan in &self.plans {
            valid_date(&plan.date)?;
            if !ids.contains(&plan.task_id)
                || plan.sort_order as u64 > MAX_SAFE_REVISION
                || !plans.insert((&plan.task_id, &plan.date))
            {
                return Err("计划引用、日期或顺序无效。".into());
            }
        }
        Ok(())
    }
    pub fn demo(date: &str) -> Self {
        let day = NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .unwrap_or_else(|_| Local::now().date_naive());
        let now = Utc::now().to_rfc3339();
        let samples = [
            (
                "完成交互设计课程作业",
                "把想法整理成完整的作品。检查交互流程和最终呈现，完成后提交到课程平台。",
                "high",
                Some(1),
                false,
                true,
            ),
            (
                "读完《设计心理学》",
                "留一点完整的时间给阅读，记下真正想带走的观点。",
                "normal",
                None,
                false,
                true,
            ),
            (
                "提交论文开题报告",
                "整理选题背景、研究目标与参考资料，提交最终版本。",
                "high",
                Some(3),
                false,
                true,
            ),
            (
                "完成本周英语复习",
                "复习本周积累的内容，让知识慢慢沉淀。",
                "low",
                Some(0),
                true,
                true,
            ),
            (
                "提交数据分析实验报告",
                "核对分析结论与图表，保留清晰的实验记录。",
                "normal",
                Some(5),
                false,
                false,
            ),
            (
                "更新个人作品集",
                "选择最能代表自己的作品，讲清每个设计决定。",
                "normal",
                Some(8),
                false,
                false,
            ),
        ];
        let mut tasks = Vec::new();
        let mut plans = Vec::new();
        for (i, (title, notes, priority, offset, completed, planned)) in
            samples.into_iter().enumerate()
        {
            let id = uuid::Uuid::new_v4().to_string();
            if planned {
                plans.push(Plan {
                    task_id: id.clone(),
                    date: day.to_string(),
                    sort_order: i,
                });
            }
            tasks.push(Task {
                id,
                title: title.into(),
                notes: notes.into(),
                priority: priority.into(),
                due_date: offset.map(|d| (day + Duration::days(d)).to_string()),
                due_time: if i == 0 { Some("18:00".into()) } else { None },
                due_timezone: None,
                due_at_utc: None,
                completed,
                created_at: now.clone(),
                completed_at: if completed { Some(now.clone()) } else { None },
                revision: 1,
            });
        }
        Self {
            tasks,
            plans,
            settings: Settings::default(),
            revision: 1,
        }
    }
    fn task_mut(&mut self, id: &str, expected: u64) -> Result<&mut Task, String> {
        let task = self
            .tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or("任务不存在。")?;
        if task.revision != expected {
            return Err("这条任务已在另一个窗口修改。已刷新最新状态，请保留草稿后重试。".into());
        }
        Ok(task)
    }
    pub fn apply(&self, action: Action, expected: u64) -> Result<Self, String> {
        if expected != self.revision {
            return Err("数据已在另一个窗口更新。已刷新最新状态，请重试；编辑草稿仍保留。".into());
        }
        self.validate()?;
        if self.revision == MAX_SAFE_REVISION {
            return Err("数据版本已超出安全范围。".into());
        }
        let mut next = self.clone();
        match action {
            Action::CreateTask { task, date } => {
                valid_date(&date)?;
                let mut item = Task {
                    id: uuid::Uuid::new_v4().to_string(),
                    title: String::new(),
                    notes: String::new(),
                    priority: "normal".into(),
                    due_date: None,
                    due_time: None,
                    due_timezone: None,
                    due_at_utc: None,
                    completed: false,
                    created_at: Utc::now().to_rfc3339(),
                    completed_at: None,
                    revision: 1,
                };
                let mut value = serde_json::to_value(&item).map_err(|e| e.to_string())?;
                let mut fields = task.clone();
                let planned = fields
                    .get("addToToday")
                    .and_then(Value::as_bool)
                    .ok_or("今日计划选项无效。")?;
                if let Some(obj) = fields.as_object_mut() {
                    obj.remove("addToToday");
                }
                merge_known(
                    &mut value,
                    &fields,
                    &[
                        "title",
                        "notes",
                        "priority",
                        "dueDate",
                        "dueTime",
                        "dueTimezone",
                    ],
                )?;
                item = serde_json::from_value(value).map_err(|e| e.to_string())?;
                item.title = item.title.trim().to_string();
                deadline::fix(&mut item, None)?;
                validate_task(&item)?;
                if planned {
                    next.plans.push(Plan {
                        task_id: item.id.clone(),
                        date,
                        sort_order: next.plans.len(),
                    });
                }
                next.tasks.push(item);
            }
            Action::UpdateTask {
                id,
                changes,
                expected_revision,
            } => {
                let task = next.task_mut(&id, expected_revision)?;
                let mut value = serde_json::to_value(&*task).map_err(|e| e.to_string())?;
                merge_known(
                    &mut value,
                    &changes,
                    &[
                        "title",
                        "notes",
                        "priority",
                        "dueDate",
                        "dueTime",
                        "dueTimezone",
                    ],
                )?;
                let mut updated: Task = serde_json::from_value(value).map_err(|e| e.to_string())?;
                updated.title = updated.title.trim().to_string();
                deadline::fix(&mut updated, Some(task))?;
                validate_task(&updated)?;
                updated.revision += 1;
                *task = updated;
            }
            Action::SetCompleted {
                id,
                completed,
                expected_revision,
            } => {
                let task = next.task_mut(&id, expected_revision)?;
                if task.completed != completed {
                    task.completed = completed;
                    task.completed_at = if completed {
                        Some(Utc::now().to_rfc3339())
                    } else {
                        None
                    };
                    task.revision += 1;
                }
            }
            Action::PlanTask { id, planned, date } => {
                valid_date(&date)?;
                if !next.tasks.iter().any(|t| t.id == id) {
                    return Err("任务不存在。".into());
                }
                let exists = next.plans.iter().any(|p| p.task_id == id && p.date == date);
                if planned && !exists {
                    next.plans.push(Plan {
                        task_id: id,
                        date,
                        sort_order: next.plans.len(),
                    });
                } else if !planned {
                    next.plans.retain(|p| p.task_id != id || p.date != date);
                }
            }
            Action::UpdateSettings { changes } => {
                let mut value = serde_json::to_value(&next.settings).map_err(|e| e.to_string())?;
                merge_known(
                    &mut value,
                    &changes,
                    &[
                        "edge",
                        "panelWidth",
                        "panelHeight",
                        "revealDelay",
                        "hideDelay",
                        "pinned",
                        "edgeEnabled",
                        "theme",
                        "uiStyle",
                        "ddlSort",
                    ],
                )?;
                let settings: Settings =
                    serde_json::from_value(value).map_err(|e| e.to_string())?;
                validate_settings(&settings)?;
                next.settings = settings;
            }
            Action::ResetDemo { date } => {
                valid_date(&date)?;
                next = Self::demo(&date);
                next.settings = self.settings.clone();
            }
        }
        next.revision = self.revision + 1;
        next.validate()?;
        Ok(next)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_task_completion_and_reopen_keeps_plan_and_deadline() {
        let initial = Snapshot::demo("2026-09-24");
        let item = initial.tasks[0].clone();
        let done = initial
            .apply(
                Action::SetCompleted {
                    id: item.id.clone(),
                    completed: true,
                    expected_revision: item.revision,
                },
                initial.revision,
            )
            .unwrap();
        assert!(done.tasks[0].completed);
        assert!(done.tasks[0].completed_at.is_some());
        assert_eq!(done.plans[0].task_id, done.tasks[0].id);
        assert_eq!(done.tasks[0].due_date, item.due_date);
        let open = done
            .apply(
                Action::SetCompleted {
                    id: item.id,
                    completed: false,
                    expected_revision: done.tasks[0].revision,
                },
                done.revision,
            )
            .unwrap();
        assert!(!open.tasks[0].completed);
        assert!(open.tasks[0].completed_at.is_none());
        assert_eq!(open.plans.len(), initial.plans.len());
    }
    #[test]
    fn remove_today_preserves_task_deadline_and_yesterdays_plan() {
        let mut initial = Snapshot::demo("2026-09-24");
        let task = initial.tasks[0].clone();
        initial.plans.push(Plan {
            task_id: task.id.clone(),
            date: "2026-09-23".into(),
            sort_order: 0,
        });
        let next = initial
            .apply(
                Action::PlanTask {
                    id: task.id.clone(),
                    planned: false,
                    date: "2026-09-24".into(),
                },
                initial.revision,
            )
            .unwrap();
        assert_eq!(next.tasks[0], task);
        assert!(next
            .plans
            .iter()
            .any(|p| p.task_id == task.id && p.date == "2026-09-23"));
        assert!(!next
            .plans
            .iter()
            .any(|p| p.task_id == task.id && p.date == "2026-09-24"));
    }
    #[test]
    fn prevents_stale_writes_and_duplicate_plans() {
        let initial = Snapshot::demo("2026-09-24");
        let action = || Action::PlanTask {
            id: initial.tasks[0].id.clone(),
            planned: true,
            date: "2026-09-24".into(),
        };
        let next = initial.apply(action(), initial.revision).unwrap();
        assert_eq!(initial.plans.len(), next.plans.len());
        assert!(next.apply(action(), initial.revision).is_err());
        assert!(next
            .apply(
                Action::SetCompleted {
                    id: next.tasks[0].id.clone(),
                    completed: true,
                    expected_revision: 999
                },
                next.revision
            )
            .is_err());
    }
    #[test]
    fn rejects_invalid_date_time_and_empty_title() {
        let snapshot = Snapshot::demo("2026-09-24");
        for changes in [
            serde_json::json!({"dueDate":"2026-02-30"}),
            serde_json::json!({"dueDate":null,"dueTime":"10:00"}),
            serde_json::json!({"title":"   "}),
        ] {
            assert!(snapshot
                .apply(
                    Action::UpdateTask {
                        id: snapshot.tasks[0].id.clone(),
                        changes,
                        expected_revision: 1
                    },
                    1
                )
                .is_err());
        }
    }
    #[test]
    fn rejects_invalid_ui_styles_without_changing_the_snapshot() {
        let snapshot = Snapshot::demo("2026-09-24");
        let before = serde_json::to_value(&snapshot).unwrap();
        for style in [
            serde_json::json!("unknown"),
            serde_json::json!("Paper"),
            serde_json::json!(""),
            serde_json::Value::Null,
            serde_json::json!(1),
        ] {
            assert!(snapshot
                .apply(
                    Action::UpdateSettings {
                        changes: serde_json::json!({"uiStyle": style})
                    },
                    snapshot.revision
                )
                .is_err());
            assert_eq!(serde_json::to_value(&snapshot).unwrap(), before);
        }
    }
}

#[cfg(test)]
mod validation_tests;
