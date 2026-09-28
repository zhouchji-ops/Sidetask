use chrono::{Duration, Local, NaiveDate, Utc};
use std::collections::{HashMap, HashSet};
pub mod deadline;
use deadline::valid_date;
pub const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(test)]
mod order_tests;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
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
    #[serde(default = "default_panel_split")]
    pub panel_split: u8,
    #[serde(default = "default_reveal_mode")]
    pub reveal_mode: String,
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
fn default_panel_split() -> u8 {
    54
}
fn default_reveal_mode() -> String {
    "click".into()
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            edge: "right".into(),
            panel_width: 368.,
            panel_height: 610.,
            panel_split: default_panel_split(),
            reveal_mode: default_reveal_mode(),
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_order: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deadline_order: Vec<String>,
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
    #[serde(rename = "trashTask", rename_all = "camelCase")]
    TrashTask { id: String, expected_revision: u64 },
    #[serde(rename = "restoreTask", rename_all = "camelCase")]
    RestoreTask { id: String, expected_revision: u64 },
    #[serde(rename = "planTask")]
    PlanTask {
        id: String,
        planned: bool,
        date: String,
    },
    #[serde(rename = "reorderToday", rename_all = "camelCase")]
    ReorderToday { date: String, task_ids: Vec<String> },
    #[serde(rename = "reorderTasks", rename_all = "camelCase")]
    ReorderTasks {
        scope: String,
        task_ids: Vec<String>,
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
    if let Some(at) = &task.deleted_at {
        deadline::parse_utc(at).map_err(|_| "任务移入回收站的时间无效。".to_string())?;
    }
    deadline::validate(task)
}
fn require_active_task(task: &Task) -> Result<(), String> {
    if task.deleted_at.is_some() {
        return Err("任务已移入回收站，请先恢复后再操作。".into());
    }
    Ok(())
}
fn validate_settings(settings: &Settings) -> Result<(), String> {
    if !(30..=70).contains(&settings.panel_split) {
        return Err("小窗分区比例需为 30–70 的整数。".into());
    }
    if !["left", "right"].contains(&settings.edge.as_str())
        || !["click", "hover"].contains(&settings.reveal_mode.as_str())
        || !["light", "dark", "system"].contains(&settings.theme.as_str())
        || !["paper", "studio", "editorial", "mono"].contains(&settings.ui_style.as_str())
        || !["date", "priority", "manual"].contains(&settings.ddl_sort.as_str())
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
            task_order: Vec::new(),
            deadline_order: Vec::new(),
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
        for order in [&self.task_order, &self.deadline_order] {
            let mut ranked = HashSet::new();
            if order
                .iter()
                .any(|id| !ids.contains(id) || !ranked.insert(id))
            {
                return Err("任务排序引用无效或重复。".into());
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
                deleted_at: None,
                revision: 1,
            });
        }
        Self {
            tasks,
            plans,
            task_order: Vec::new(),
            deadline_order: Vec::new(),
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
    fn append_plan(&mut self, task_id: String, date: String) {
        // Removal leaves gaps and older snapshots may contain equal or very
        // large orders. Stable compaction preserves the displayed order while
        // making append unambiguous, without incrementing an unsafe maximum.
        let visible: HashSet<_> = self
            .tasks
            .iter()
            .filter(|task| task.deleted_at.is_none())
            .map(|task| task.id.as_str())
            .collect();
        let mut indices: Vec<_> = self
            .plans
            .iter()
            .enumerate()
            .filter_map(|(index, plan)| {
                (plan.date == date && visible.contains(plan.task_id.as_str())).then_some(index)
            })
            .collect();
        indices.sort_by_key(|index| self.plans[*index].sort_order);
        for (order, index) in indices.iter().enumerate() {
            self.plans[*index].sort_order = order;
        }
        self.plans.push(Plan {
            task_id,
            date,
            sort_order: indices.len(),
        });
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
                    deleted_at: None,
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
                    next.append_plan(item.id.clone(), date);
                }
                next.tasks.push(item);
            }
            Action::UpdateTask {
                id,
                changes,
                expected_revision,
            } => {
                let task = next.task_mut(&id, expected_revision)?;
                require_active_task(task)?;
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
                require_active_task(task)?;
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
            Action::TrashTask {
                id,
                expected_revision,
            } => {
                let task = next.task_mut(&id, expected_revision)?;
                if task.deleted_at.is_none() {
                    task.deleted_at = Some(Utc::now().to_rfc3339());
                    task.revision += 1;
                }
            }
            Action::RestoreTask {
                id,
                expected_revision,
            } => {
                let task = next.task_mut(&id, expected_revision)?;
                if task.deleted_at.is_some() {
                    task.deleted_at = None;
                    task.revision += 1;
                }
            }
            Action::PlanTask { id, planned, date } => {
                valid_date(&date)?;
                let task = next
                    .tasks
                    .iter()
                    .find(|task| task.id == id)
                    .ok_or("任务不存在。")?;
                require_active_task(task)?;
                let exists = next.plans.iter().any(|p| p.task_id == id && p.date == date);
                if planned && !exists {
                    next.append_plan(id, date);
                } else if !planned {
                    next.plans.retain(|p| p.task_id != id || p.date != date);
                }
            }
            Action::ReorderToday { date, task_ids } => {
                valid_date(&date)?;
                let incomplete: HashSet<_> = self
                    .tasks
                    .iter()
                    .filter(|task| !task.completed && task.deleted_at.is_none())
                    .map(|task| task.id.as_str())
                    .collect();
                let planned: HashSet<_> = self
                    .plans
                    .iter()
                    .filter(|plan| plan.date == date && incomplete.contains(plan.task_id.as_str()))
                    .map(|plan| plan.task_id.as_str())
                    .collect();
                let requested: HashSet<_> = task_ids.iter().map(String::as_str).collect();
                if requested.len() != task_ids.len() || requested != planned {
                    return Err("今日计划已变化，排序需要包含全部未完成的今日任务且不能重复。请刷新后重试。".into());
                }
                let positions: HashMap<_, _> = task_ids
                    .iter()
                    .enumerate()
                    .map(|(position, id)| (id.as_str(), position))
                    .collect();
                for plan in next.plans.iter_mut().filter(|plan| plan.date == date) {
                    if let Some(position) = positions.get(plan.task_id.as_str()) {
                        plan.sort_order = *position;
                    }
                }
            }
            Action::ReorderTasks { scope, task_ids } => {
                if !["all", "deadlines"].contains(&scope.as_str()) {
                    return Err("排序列表无效。".into());
                }
                let eligible: HashSet<_> = self
                    .tasks
                    .iter()
                    .filter(|task| {
                        !task.completed
                            && task.deleted_at.is_none()
                            && (scope == "all" || task.due_date.is_some())
                    })
                    .map(|task| task.id.as_str())
                    .collect();
                let requested: HashSet<_> = task_ids.iter().map(String::as_str).collect();
                if requested.len() != task_ids.len() || requested != eligible {
                    return Err(
                        "任务列表已变化，排序需要包含全部未完成任务且不能重复。请刷新后重试。"
                            .into(),
                    );
                }
                let order = if scope == "all" {
                    &mut next.task_order
                } else {
                    &mut next.deadline_order
                };
                let known: HashSet<_> = order.iter().cloned().collect();
                order.extend(task_ids.iter().filter(|id| !known.contains(*id)).cloned());
                // Keep hidden tasks in their existing slots; only active slots
                // participate in this reorder. Restoring does not lose a rank.
                let mut positions = task_ids.into_iter();
                for id in order.iter_mut() {
                    if eligible.contains(id.as_str()) {
                        *id = positions.next().expect("validated complete active set");
                    }
                }
                if scope == "deadlines" {
                    next.settings.ddl_sort = "manual".into();
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
                        "panelSplit",
                        "revealMode",
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
    fn reveal_mode_defaults_legacy_data_to_click_and_preserves_tasks_and_timing() {
        let original = Snapshot::demo("2026-09-25");
        assert_eq!(original.settings.reveal_mode, "click");
        let mut legacy = serde_json::to_value(&original).unwrap();
        legacy["settings"]
            .as_object_mut()
            .unwrap()
            .remove("revealMode");
        legacy["settings"]["revealDelay"] = serde_json::json!(320);
        let restored: Snapshot = serde_json::from_value(legacy.clone()).unwrap();
        restored.validate().unwrap();
        legacy["settings"]["revealMode"] = serde_json::json!("click");
        assert_eq!(serde_json::to_value(restored).unwrap(), legacy);
    }

    #[test]
    fn reveal_mode_changes_preserve_data_and_reject_unknown_modes() {
        let original = Snapshot::demo("2026-09-25");
        let changed = original
            .apply(
                Action::UpdateSettings {
                    changes: serde_json::json!({"revealMode": "hover"}),
                },
                original.revision,
            )
            .unwrap();
        let mut expected = serde_json::to_value(&original).unwrap();
        expected["settings"]["revealMode"] = serde_json::json!("hover");
        expected["revision"] = serde_json::json!(original.revision + 1);
        assert_eq!(serde_json::to_value(&changed).unwrap(), expected);
        for mode in [
            serde_json::json!("auto"),
            serde_json::json!(""),
            serde_json::json!(null),
            serde_json::json!(1),
        ] {
            assert!(changed
                .apply(
                    Action::UpdateSettings {
                        changes: serde_json::json!({"revealMode": mode})
                    },
                    changed.revision
                )
                .is_err());
            assert_eq!(serde_json::to_value(&changed).unwrap(), expected);
        }
    }

    fn active_plan_ids(snapshot: &Snapshot, date: &str) -> Vec<String> {
        let active: HashSet<_> = snapshot
            .tasks
            .iter()
            .filter(|task| !task.completed && task.deleted_at.is_none())
            .map(|task| task.id.as_str())
            .collect();
        let mut plans: Vec<_> = snapshot
            .plans
            .iter()
            .filter(|plan| plan.date == date && active.contains(plan.task_id.as_str()))
            .collect();
        plans.sort_by_key(|plan| plan.sort_order);
        plans.iter().map(|plan| plan.task_id.clone()).collect()
    }

    fn lifecycle_action(kind: &str, task: &Task) -> Action {
        serde_json::from_value(serde_json::json!({
            "type": kind, "id": task.id, "expectedRevision": task.revision
        }))
        .unwrap()
    }

    #[test]
    fn trash_and_restore_preserve_open_and_completed_tasks_and_all_plan_dates() {
        for index in [0, 3] {
            let mut initial = Snapshot::demo("2026-09-24");
            initial.tasks[0].due_timezone = Some("Asia/Shanghai".into());
            initial.tasks[0].due_at_utc = Some("2026-09-25T10:00:00Z".into());
            for (date, order) in [("2026-09-23", 17), ("2026-09-30", 29)] {
                initial.plans.push(Plan {
                    task_id: initial.tasks[index].id.clone(),
                    date: date.into(),
                    sort_order: order,
                });
            }
            initial.validate().unwrap();
            let original = initial.tasks[index].clone();
            let plans = serde_json::to_value(&initial.plans).unwrap();
            let deleted = initial
                .apply(lifecycle_action("trashTask", &original), initial.revision)
                .unwrap();
            deadline::parse_utc(deleted.tasks[index].deleted_at.as_ref().unwrap()).unwrap();
            let mut expected = initial.tasks.clone();
            expected[index].deleted_at = deleted.tasks[index].deleted_at.clone();
            expected[index].revision += 1;
            assert_eq!(deleted.tasks, expected);
            assert_eq!(serde_json::to_value(&deleted.plans).unwrap(), plans);
            assert_eq!(deleted.settings, initial.settings);
            assert_eq!(deleted.revision, initial.revision + 1);

            let restored = deleted
                .apply(
                    lifecycle_action("restoreTask", &deleted.tasks[index]),
                    deleted.revision,
                )
                .unwrap();
            expected[index].deleted_at = None;
            expected[index].revision += 1;
            assert_eq!(restored.tasks, expected);
            assert_eq!(serde_json::to_value(&restored.plans).unwrap(), plans);
            assert_eq!(restored.settings, initial.settings);
            assert_eq!(restored.revision, initial.revision + 2);
            assert!(!restored.plans.iter().any(|plan| plan.date == "2026-09-25"));
        }
    }

    #[test]
    fn deleted_timestamp_is_backward_compatible_and_strict_utc() {
        let initial = Snapshot::demo("2026-09-24");
        let encoded = serde_json::to_value(&initial).unwrap();
        assert!(encoded["tasks"][0].get("deletedAt").is_none());
        let legacy: Snapshot = serde_json::from_value(encoded.clone()).unwrap();
        assert!(legacy.tasks.iter().all(|task| task.deleted_at.is_none()));
        for timestamp in [
            serde_json::Value::Null,
            serde_json::json!("2026-09-25T04:05:06.123456789Z"),
            serde_json::json!("2026-09-25T04:05:06+00:00"),
        ] {
            let mut value = encoded.clone();
            value["tasks"][0]["deletedAt"] = timestamp;
            serde_json::from_value::<Snapshot>(value)
                .unwrap()
                .validate()
                .unwrap();
        }
        for timestamp in [
            "",
            "2026-02-30T00:00:00Z",
            "2026-09-25",
            "2026-09-25T04:05:06",
            "2026-09-25T04:05:06+08:00",
            "2026-09-25T04:05:60Z",
        ] {
            let mut invalid = initial.clone();
            invalid.tasks[0].deleted_at = Some(timestamp.into());
            assert!(invalid.validate().is_err(), "{timestamp}");
        }
        assert!(initial
            .apply(
                Action::UpdateTask {
                    id: initial.tasks[0].id.clone(),
                    changes: serde_json::json!({"deletedAt":"2026-09-25T00:00:00Z"}),
                    expected_revision: 1
                },
                initial.revision
            )
            .is_err());
    }

    #[test]
    fn repeated_lifecycle_intent_keeps_timestamp_and_task_revision_but_checks_versions() {
        let initial = Snapshot::demo("2026-09-24");
        let deleted = initial
            .apply(
                lifecycle_action("trashTask", &initial.tasks[0]),
                initial.revision,
            )
            .unwrap();
        let repeated = deleted
            .apply(
                lifecycle_action("trashTask", &deleted.tasks[0]),
                deleted.revision,
            )
            .unwrap();
        assert_eq!(repeated.tasks, deleted.tasks);
        assert_eq!(
            serde_json::to_value(&repeated.plans).unwrap(),
            serde_json::to_value(&deleted.plans).unwrap()
        );
        assert_eq!(repeated.revision, deleted.revision + 1);
        assert!(repeated
            .apply(
                lifecycle_action("trashTask", &initial.tasks[0]),
                repeated.revision
            )
            .is_err());
        assert!(repeated
            .apply(
                lifecycle_action("trashTask", &repeated.tasks[0]),
                deleted.revision
            )
            .is_err());

        let restored = repeated
            .apply(
                lifecycle_action("restoreTask", &repeated.tasks[0]),
                repeated.revision,
            )
            .unwrap();
        let restored_twice = restored
            .apply(
                lifecycle_action("restoreTask", &restored.tasks[0]),
                restored.revision,
            )
            .unwrap();
        assert_eq!(restored_twice.tasks, restored.tasks);
        assert!(restored_twice
            .apply(
                lifecycle_action("restoreTask", &deleted.tasks[0]),
                restored_twice.revision
            )
            .is_err());
        let deleted_again = restored_twice
            .apply(
                lifecycle_action("trashTask", &restored_twice.tasks[0]),
                restored_twice.revision,
            )
            .unwrap();
        assert!(
            deleted_again
                .apply(
                    lifecycle_action("restoreTask", &deleted.tasks[0]),
                    deleted_again.revision
                )
                .is_err(),
            "an old undo must not restore a later deletion"
        );
    }

    #[test]
    fn deleted_tasks_reject_edits_completion_and_any_plan_changes() {
        let initial = Snapshot::demo("2026-09-24");
        let deleted = initial
            .apply(
                lifecycle_action("trashTask", &initial.tasks[0]),
                initial.revision,
            )
            .unwrap();
        let task = &deleted.tasks[0];
        let mut actions = vec![Action::UpdateTask {
            id: task.id.clone(),
            changes: serde_json::json!({"title":"Changed"}),
            expected_revision: task.revision,
        }];
        for completed in [false, true] {
            actions.push(Action::SetCompleted {
                id: task.id.clone(),
                completed,
                expected_revision: task.revision,
            });
        }
        for date in ["2026-09-23", "2026-09-24", "2026-09-30"] {
            for planned in [false, true] {
                actions.push(Action::PlanTask {
                    id: task.id.clone(),
                    planned,
                    date: date.into(),
                });
            }
        }
        let before = serde_json::to_value(&deleted).unwrap();
        for action in actions {
            assert!(deleted
                .apply(action, deleted.revision)
                .unwrap_err()
                .contains("回收站"));
            assert_eq!(serde_json::to_value(&deleted).unwrap(), before);
        }
        for kind in ["trashTask", "restoreTask"] {
            let mut unknown = task.clone();
            unknown.id = "missing-task".into();
            assert!(deleted
                .apply(lifecycle_action(kind, &unknown), deleted.revision)
                .is_err());
        }
    }

    #[test]
    fn completion_and_trash_reject_stale_intents_in_both_orders() {
        let initial = Snapshot::demo("2026-09-24");
        let complete = || Action::SetCompleted {
            id: initial.tasks[0].id.clone(),
            completed: true,
            expected_revision: initial.tasks[0].revision,
        };
        let completed = initial.apply(complete(), initial.revision).unwrap();
        assert!(completed
            .apply(
                lifecycle_action("trashTask", &initial.tasks[0]),
                initial.revision
            )
            .is_err());
        assert!(completed
            .apply(
                lifecycle_action("trashTask", &initial.tasks[0]),
                completed.revision
            )
            .is_err());
        let deleted_completed = completed
            .apply(
                lifecycle_action("trashTask", &completed.tasks[0]),
                completed.revision,
            )
            .unwrap();
        assert_eq!(
            deleted_completed.tasks[0].completed_at,
            completed.tasks[0].completed_at
        );
        assert!(deleted_completed.tasks[0].completed);

        let deleted = initial
            .apply(
                lifecycle_action("trashTask", &initial.tasks[0]),
                initial.revision,
            )
            .unwrap();
        assert!(deleted.apply(complete(), initial.revision).is_err());
        assert!(deleted.apply(complete(), deleted.revision).is_err());
    }

    #[test]
    fn reorder_and_append_exclude_deleted_tasks_and_preserve_their_plan_orders() {
        let date = "2026-09-24";
        let mut initial = Snapshot::demo(date);
        initial.plans[0].sort_order = 73;
        let order = active_plan_ids(&initial, date);
        let deleted = initial
            .apply(
                lifecycle_action("trashTask", &initial.tasks[0]),
                initial.revision,
            )
            .unwrap();
        let stale_reorder = || Action::ReorderToday {
            date: date.into(),
            task_ids: order.clone(),
        };
        assert!(deleted.apply(stale_reorder(), initial.revision).is_err());
        assert!(deleted.apply(stale_reorder(), deleted.revision).is_err());
        let visible: Vec<_> = active_plan_ids(&deleted, date).into_iter().rev().collect();
        let reordered = deleted
            .apply(
                Action::ReorderToday {
                    date: date.into(),
                    task_ids: visible.clone(),
                },
                deleted.revision,
            )
            .unwrap();
        assert_eq!(active_plan_ids(&reordered, date), visible);
        assert_eq!(reordered.plans[0].sort_order, 73);
        assert_eq!(reordered.tasks, deleted.tasks);
        let appended = reordered
            .apply(
                Action::PlanTask {
                    id: reordered.tasks[4].id.clone(),
                    date: date.into(),
                    planned: true,
                },
                reordered.revision,
            )
            .unwrap();
        assert_eq!(appended.plans[0].sort_order, 73);
        let restored = appended
            .apply(
                lifecycle_action("restoreTask", &appended.tasks[0]),
                appended.revision,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(&restored.plans).unwrap(),
            serde_json::to_value(&appended.plans).unwrap()
        );
        assert!(
            restored
                .apply(
                    Action::ReorderToday {
                        date: date.into(),
                        task_ids: active_plan_ids(&appended, date)
                    },
                    restored.revision
                )
                .is_err(),
            "restored tasks must be included in a fresh complete order"
        );
    }

    #[test]
    fn rejoining_after_reorder_and_removal_appends_after_remaining_plans() {
        let date = "2026-09-24";
        let mut initial = Snapshot::demo(date);
        initial.plans.push(Plan {
            task_id: initial.tasks[0].id.clone(),
            date: "2026-09-23".into(),
            sort_order: 99,
        });
        let order: Vec<_> = active_plan_ids(&initial, date).into_iter().rev().collect();
        let reordered = initial
            .apply(
                Action::ReorderToday {
                    date: date.into(),
                    task_ids: order.clone(),
                },
                initial.revision,
            )
            .unwrap();
        let removed_id = order[0].clone();
        let removed = reordered
            .apply(
                Action::PlanTask {
                    id: removed_id.clone(),
                    date: date.into(),
                    planned: false,
                },
                reordered.revision,
            )
            .unwrap();
        let joined = removed
            .apply(
                Action::PlanTask {
                    id: removed_id.clone(),
                    date: date.into(),
                    planned: true,
                },
                removed.revision,
            )
            .unwrap();
        let expected: Vec<_> = order
            .into_iter()
            .filter(|id| id != &removed_id)
            .chain([removed_id.clone()])
            .collect();
        assert_eq!(active_plan_ids(&joined, date), expected);
        assert_eq!(joined.tasks, initial.tasks);
        assert_eq!(
            serde_json::to_value(joined.plans.iter().find(|plan| plan.date != date)).unwrap(),
            serde_json::to_value(initial.plans.iter().find(|plan| plan.date != date)).unwrap()
        );
        let orders: HashSet<_> = joined
            .plans
            .iter()
            .filter(|plan| plan.date == date)
            .map(|plan| plan.sort_order)
            .collect();
        assert_eq!(
            orders.len(),
            joined.plans.iter().filter(|plan| plan.date == date).count()
        );
    }

    #[test]
    fn new_and_existing_tasks_append_after_gaps_ties_and_maximum_safe_order() {
        let date = "2026-09-24";
        let maximum = MAX_SAFE_REVISION as usize;
        for values in [
            [0, 2, 4, 9],
            [7, 7, 7, 7],
            [maximum - 3, maximum, maximum - 1, maximum],
        ] {
            for create in [false, true] {
                let mut initial = Snapshot::demo(date);
                for (plan, order) in initial.plans.iter_mut().zip(values) {
                    plan.sort_order = order;
                }
                let unplanned = initial
                    .tasks
                    .iter()
                    .find(|task| !initial.plans.iter().any(|plan| plan.task_id == task.id))
                    .unwrap()
                    .id
                    .clone();
                initial.plans.push(Plan {
                    task_id: unplanned.clone(),
                    date: "2026-09-23".into(),
                    sort_order: maximum,
                });
                initial.plans.push(Plan {
                    task_id: initial.tasks[0].id.clone(),
                    date: "2026-09-25".into(),
                    sort_order: 77,
                });
                let history: Vec<_> = initial
                    .plans
                    .iter()
                    .filter(|plan| plan.date != date)
                    .cloned()
                    .collect();
                let mut before: Vec<_> = initial
                    .plans
                    .iter()
                    .filter(|plan| plan.date == date)
                    .collect();
                before.sort_by_key(|plan| plan.sort_order);
                let mut expected: Vec<_> = before.iter().map(|plan| plan.task_id.clone()).collect();
                let action = if create {
                    Action::CreateTask {
                        date: date.into(),
                        task: serde_json::json!({"title":"Synthetic appended task", "addToToday":true}),
                    }
                } else {
                    Action::PlanTask {
                        id: unplanned.clone(),
                        date: date.into(),
                        planned: true,
                    }
                };
                let next = initial.apply(action, initial.revision).unwrap();
                let appended = if create {
                    next.tasks.last().unwrap().id.clone()
                } else {
                    unplanned
                };
                expected.push(appended.clone());
                let mut actual: Vec<_> =
                    next.plans.iter().filter(|plan| plan.date == date).collect();
                actual.sort_by_key(|plan| plan.sort_order);
                assert_eq!(
                    actual
                        .iter()
                        .map(|plan| plan.task_id.clone())
                        .collect::<Vec<_>>(),
                    expected,
                    "{values:?}, create={create}"
                );
                assert_eq!(
                    actual
                        .iter()
                        .map(|plan| plan.sort_order)
                        .collect::<Vec<_>>(),
                    (0..actual.len()).collect::<Vec<_>>()
                );
                assert_eq!(next.tasks[..initial.tasks.len()], initial.tasks);
                assert_eq!(
                    serde_json::to_value(
                        next.plans
                            .iter()
                            .filter(|plan| plan.date != date)
                            .cloned()
                            .collect::<Vec<_>>()
                    )
                    .unwrap(),
                    serde_json::to_value(history).unwrap()
                );
                // A second join is a no-op for all plan data, not a reorder.
                let twice = next
                    .apply(
                        Action::PlanTask {
                            id: appended,
                            date: date.into(),
                            planned: true,
                        },
                        next.revision,
                    )
                    .unwrap();
                assert_eq!(
                    serde_json::to_value(twice.plans).unwrap(),
                    serde_json::to_value(next.plans).unwrap()
                );
            }
        }
    }

    #[test]
    fn today_reorder_preserves_tasks_completed_plans_and_other_dates() {
        let date = "2026-09-24";
        let mut initial = Snapshot::demo(date);
        initial.tasks[1].completed = true;
        initial.tasks[1].completed_at = Some(initial.tasks[1].created_at.clone());
        let completed_ids: HashSet<_> = initial
            .tasks
            .iter()
            .filter(|task| task.completed)
            .map(|task| task.id.clone())
            .collect();
        for (index, plan) in initial.plans.iter_mut().enumerate() {
            if completed_ids.contains(&plan.task_id) {
                plan.sort_order = 41 + index;
            }
        }
        initial.plans.push(Plan {
            task_id: initial.tasks[0].id.clone(),
            date: "2026-09-23".into(),
            sort_order: 19,
        });
        initial.plans.push(Plan {
            task_id: initial.tasks[1].id.clone(),
            date: "2026-09-25".into(),
            sort_order: 27,
        });
        let order: Vec<_> = active_plan_ids(&initial, date).into_iter().rev().collect();
        // Exercise the actual camelCase command payload as well as the rule.
        let action = serde_json::from_value(serde_json::json!({
            "type":"reorderToday", "date":date, "taskIds":order
        }))
        .unwrap();
        let next = initial.apply(action, initial.revision).unwrap();
        assert_eq!(active_plan_ids(&next, date), order);
        assert_eq!(next.tasks, initial.tasks);
        assert_eq!(next.settings, initial.settings);
        assert_eq!(next.revision, initial.revision + 1);
        assert_eq!(next.plans.len(), initial.plans.len());
        for (before, after) in initial.plans.iter().zip(&next.plans) {
            assert_eq!(before.task_id, after.task_id);
            assert_eq!(before.date, after.date);
            if before.date != date || completed_ids.contains(&before.task_id) {
                assert_eq!(
                    serde_json::to_value(before).unwrap(),
                    serde_json::to_value(after).unwrap()
                );
            }
        }
    }

    #[test]
    fn today_reorder_rejects_missing_duplicate_unknown_completed_or_unplanned_ids() {
        let date = "2026-09-24";
        let initial = Snapshot::demo(date);
        let ids = active_plan_ids(&initial, date);
        let completed = initial
            .tasks
            .iter()
            .find(|task| task.completed)
            .unwrap()
            .id
            .clone();
        let unplanned = initial
            .tasks
            .iter()
            .find(|task| !initial.plans.iter().any(|plan| plan.task_id == task.id))
            .unwrap()
            .id
            .clone();
        let mut duplicate = ids.clone();
        duplicate[1] = duplicate[0].clone();
        let mut cases = vec![vec![], ids[..ids.len() - 1].to_vec(), duplicate];
        for additional in [completed, unplanned, "unknown task".into()] {
            let mut invalid = ids.clone();
            invalid.push(additional);
            cases.push(invalid);
        }
        let before = serde_json::to_value(&initial).unwrap();
        for task_ids in cases {
            assert!(initial
                .apply(
                    Action::ReorderToday {
                        date: date.into(),
                        task_ids
                    },
                    initial.revision
                )
                .is_err());
            assert_eq!(serde_json::to_value(&initial).unwrap(), before);
        }
        for date in ["2026-9-24", "2026-02-30", "not a date"] {
            assert!(initial
                .apply(
                    Action::ReorderToday {
                        date: date.into(),
                        task_ids: ids.clone()
                    },
                    initial.revision
                )
                .is_err());
        }
    }

    #[test]
    fn completion_and_reordering_reject_stale_snapshots_in_both_orders() {
        let date = "2026-09-24";
        let initial = Snapshot::demo(date);
        let order: Vec<_> = active_plan_ids(&initial, date).into_iter().rev().collect();
        let task = initial.tasks[0].clone();
        let complete = || Action::SetCompleted {
            id: task.id.clone(),
            completed: true,
            expected_revision: task.revision,
        };
        let reorder = || Action::ReorderToday {
            date: date.into(),
            task_ids: order.clone(),
        };
        let completed = initial.apply(complete(), initial.revision).unwrap();
        assert!(completed.apply(reorder(), initial.revision).is_err());
        assert!(
            completed.apply(reorder(), completed.revision).is_err(),
            "completed tasks are no longer in the reorderable set"
        );
        let current_order = order.iter().filter(|id| **id != task.id).cloned().collect();
        let after = completed
            .apply(
                Action::ReorderToday {
                    date: date.into(),
                    task_ids: current_order,
                },
                completed.revision,
            )
            .unwrap();
        let before_completed_plan = completed
            .plans
            .iter()
            .find(|plan| plan.task_id == task.id)
            .unwrap();
        let after_completed_plan = after
            .plans
            .iter()
            .find(|plan| plan.task_id == task.id)
            .unwrap();
        assert_eq!(
            serde_json::to_value(before_completed_plan).unwrap(),
            serde_json::to_value(after_completed_plan).unwrap()
        );
        assert_eq!(after.tasks, completed.tasks);

        let reordered = initial.apply(reorder(), initial.revision).unwrap();
        assert!(reordered.apply(complete(), initial.revision).is_err());
        let done = reordered.apply(complete(), reordered.revision).unwrap();
        assert!(done.tasks[0].completed);
        assert_eq!(
            serde_json::to_value(&done.plans).unwrap(),
            serde_json::to_value(&reordered.plans).unwrap()
        );
    }

    #[test]
    fn empty_and_single_task_days_can_reorder_without_touching_other_plans() {
        let initial = Snapshot::demo("2026-09-24");
        let empty = initial
            .apply(
                Action::ReorderToday {
                    date: "2026-09-25".into(),
                    task_ids: vec![],
                },
                initial.revision,
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(&empty.plans).unwrap(),
            serde_json::to_value(&initial.plans).unwrap()
        );
        let mut single = initial.clone();
        single
            .plans
            .retain(|plan| plan.task_id == single.tasks[0].id);
        single.plans[0].sort_order = 9;
        let next = single
            .apply(
                Action::ReorderToday {
                    date: "2026-09-24".into(),
                    task_ids: vec![single.tasks[0].id.clone()],
                },
                single.revision,
            )
            .unwrap();
        assert_eq!(next.plans[0].sort_order, 0);
        assert_eq!(next.tasks, single.tasks);
    }

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
    fn missing_reveal_mode_defaults_to_click_without_changing_legacy_content() {
        assert_eq!(Settings::default().reveal_mode, "click");
        let mut legacy = serde_json::to_value(Snapshot::demo("2026-09-24")).unwrap();
        legacy["settings"]
            .as_object_mut()
            .unwrap()
            .remove("revealMode");
        let snapshot: Snapshot = serde_json::from_value(legacy.clone()).unwrap();
        snapshot.validate().unwrap();
        assert_eq!(snapshot.settings.reveal_mode, "click");
        legacy["settings"]["revealMode"] = serde_json::json!("click");
        assert_eq!(serde_json::to_value(snapshot).unwrap(), legacy);
    }

    #[test]
    fn reveal_mode_updates_only_preferences_and_survives_other_setting_changes() {
        let mut snapshot = Snapshot::demo("2026-09-24");
        for mode in ["hover", "click"] {
            let previous = serde_json::to_value(&snapshot).unwrap();
            let changes = serde_json::json!({"revealMode": mode});
            let next = snapshot
                .apply(
                    Action::UpdateSettings {
                        changes: changes.clone(),
                    },
                    snapshot.revision,
                )
                .unwrap();
            let mut expected = previous;
            expected["settings"]["revealMode"] = serde_json::json!(mode);
            expected["revision"] = serde_json::json!(snapshot.revision + 1);
            assert_eq!(serde_json::to_value(&next).unwrap(), expected);
            assert!(next
                .apply(Action::UpdateSettings { changes }, snapshot.revision)
                .is_err());
            snapshot = next.apply(Action::UpdateSettings { changes: serde_json::json!({"pinned":true, "revealDelay":300, "hideDelay":800}) }, next.revision).unwrap();
            assert_eq!(snapshot.settings.reveal_mode, mode);
            assert_eq!(snapshot.settings.reveal_delay, 300);
            assert_eq!(snapshot.settings.hide_delay, 800);
        }
    }

    #[test]
    fn invalid_reveal_modes_fail_updates_and_snapshot_validation() {
        let snapshot = Snapshot::demo("2026-09-24");
        let before = serde_json::to_value(&snapshot).unwrap();
        for mode in [
            serde_json::json!(""),
            serde_json::json!("Hover"),
            serde_json::json!("automatic"),
            serde_json::json!(false),
            serde_json::json!(0),
            Value::Null,
        ] {
            assert!(snapshot
                .apply(
                    Action::UpdateSettings {
                        changes: serde_json::json!({"revealMode":mode.clone()})
                    },
                    snapshot.revision
                )
                .is_err());
            assert_eq!(serde_json::to_value(&snapshot).unwrap(), before);
            let mut persisted = before.clone();
            persisted["settings"]["revealMode"] = mode;
            if let Ok(invalid) = serde_json::from_value::<Snapshot>(persisted) {
                assert!(invalid.validate().is_err());
            }
        }
    }

    #[test]
    fn missing_panel_split_defaults_without_changing_legacy_tasks_or_plans() {
        let mut legacy = serde_json::to_value(Snapshot::demo("2026-09-24")).unwrap();
        legacy["settings"]
            .as_object_mut()
            .unwrap()
            .remove("panelSplit");
        let snapshot: Snapshot = serde_json::from_value(legacy.clone()).unwrap();
        snapshot.validate().unwrap();
        assert_eq!(snapshot.settings.panel_split, 54);
        let mut expected = legacy;
        expected["settings"]["panelSplit"] = serde_json::json!(54);
        assert_eq!(serde_json::to_value(&snapshot).unwrap(), expected);
    }
    #[test]
    fn panel_split_updates_only_its_setting_and_uses_snapshot_concurrency() {
        let mut snapshot = Snapshot::demo("2026-09-24");
        for split in [30, 70, 54] {
            let previous = serde_json::to_value(&snapshot).unwrap();
            let changes = serde_json::json!({"panelSplit": split});
            let next = snapshot
                .apply(
                    Action::UpdateSettings {
                        changes: changes.clone(),
                    },
                    snapshot.revision,
                )
                .unwrap();
            let mut expected = previous;
            expected["settings"]["panelSplit"] = serde_json::json!(split);
            expected["revision"] = serde_json::json!(snapshot.revision + 1);
            assert_eq!(serde_json::to_value(&next).unwrap(), expected);
            assert!(next
                .apply(Action::UpdateSettings { changes }, snapshot.revision)
                .is_err());
            snapshot = next;
        }
    }
    #[test]
    fn invalid_panel_split_is_rejected_in_updates_and_persisted_snapshots() {
        let snapshot = Snapshot::demo("2026-09-24");
        let before = serde_json::to_value(&snapshot).unwrap();
        for split in [
            serde_json::json!(-1),
            serde_json::json!(29),
            serde_json::json!(71),
            serde_json::json!(256),
            serde_json::json!(54.5),
            serde_json::json!("54"),
            serde_json::json!(true),
            serde_json::Value::Null,
        ] {
            assert!(snapshot
                .apply(
                    Action::UpdateSettings {
                        changes: serde_json::json!({"panelSplit": split.clone()})
                    },
                    snapshot.revision,
                )
                .is_err());
            assert_eq!(serde_json::to_value(&snapshot).unwrap(), before);
            let mut persisted = before.clone();
            persisted["settings"]["panelSplit"] = split;
            match serde_json::from_value::<Snapshot>(persisted) {
                Ok(invalid) => assert!(invalid.validate().is_err()),
                Err(_) => continue,
            }
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
