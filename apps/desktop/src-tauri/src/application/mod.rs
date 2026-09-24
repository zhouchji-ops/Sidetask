use crate::domain::{Action, Plan, Snapshot, Task};
use crate::infrastructure::Repository;
use serde::{Deserialize, Serialize};

pub const MAX_BACKUP_BYTES: usize = 10 * 1024 * 1024;
const MAX_BACKUP_TASKS: usize = 10_000;
const MAX_BACKUP_PLANS: usize = 100_000;
const MAX_SAFE_REVISION: u64 = 9_007_199_254_740_991;

/// Portable task backup: device preferences and screen placement stay local.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskBackup {
    schema_version: u32,
    exported_at: String,
    tasks: Vec<Task>,
    plans: Vec<Plan>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub task_count: usize,
    pub plan_count: usize,
    pub exported_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub snapshot: Snapshot,
    pub safety_backup_path: String,
}
fn encode_backup(snapshot: &Snapshot) -> Result<String, String> {
    if snapshot.tasks.len() > MAX_BACKUP_TASKS || snapshot.plans.len() > MAX_BACKUP_PLANS {
        return Err("任务或计划数量超出可恢复备份容量，未保存。".into());
    }
    let backup = TaskBackup {
        schema_version: 1,
        exported_at: chrono::Utc::now().to_rfc3339(),
        tasks: snapshot.tasks.clone(),
        plans: snapshot.plans.clone(),
    };
    let content = serde_json::to_string(&backup).map_err(|error| error.to_string())?;
    if content.len() > MAX_BACKUP_BYTES {
        return Err("任务数据超过 10 MiB 的可恢复备份容量，未保存；请减少本次输入。".into());
    }
    Ok(content)
}

fn parse_backup(content: &str) -> Result<TaskBackup, String> {
    if content.len() > MAX_BACKUP_BYTES {
        return Err("备份超过 10 MiB，未读取或恢复。".into());
    }
    let backup: TaskBackup =
        serde_json::from_str(content).map_err(|e| format!("备份格式无效，原数据未更改：{e}"))?;
    if backup.schema_version != 1 {
        return Err(format!(
            "备份版本 {} 不受支持，原数据未更改。",
            backup.schema_version
        ));
    }
    if backup.tasks.len() > MAX_BACKUP_TASKS || backup.plans.len() > MAX_BACKUP_PLANS {
        return Err("备份任务或计划数量超出此版本限制，原数据未更改。".into());
    }
    chrono::DateTime::parse_from_rfc3339(&backup.exported_at)
        .map_err(|_| "备份导出时间无效，原数据未更改。")?;
    let snapshot = Snapshot {
        tasks: backup.tasks.clone(),
        plans: backup.plans.clone(),
        revision: backup
            .tasks
            .iter()
            .map(|task| task.revision)
            .max()
            .unwrap_or(1),
        ..Snapshot::empty()
    };
    snapshot
        .validate()
        .map_err(|e| format!("备份数据校验失败，原数据未更改：{e}"))?;
    Ok(backup)
}

pub struct TaskService {
    pub snapshot: Snapshot,
    pub repository: Box<dyn Repository>,
}
impl TaskService {
    pub fn new(mut repository: Box<dyn Repository>) -> Result<Self, String> {
        let snapshot = match repository.load()? {
            Some(snapshot) => snapshot,
            None => {
                let snapshot = Snapshot::empty();
                repository.save(&snapshot)?;
                snapshot
            }
        };
        snapshot.validate()?;
        Ok(Self {
            snapshot,
            repository,
        })
    }
    pub fn mutate(&mut self, action: Action, expected: u64) -> Result<Snapshot, String> {
        let next = self.snapshot.apply(action, expected)?;
        // Never accept new content that this version cannot export and restore.
        encode_backup(&next)?;
        self.repository.save(&next)?;
        self.snapshot = next;
        Ok(self.snapshot.clone())
    }
    pub fn export_backup(&self) -> Result<String, String> {
        self.snapshot.validate()?;
        let content = encode_backup(&self.snapshot)?;
        // An exported file must also be accepted by this version's restore path.
        parse_backup(&content)?;
        Ok(content)
    }
    pub fn preview_restore(&self, content: &str) -> Result<RestorePreview, String> {
        let backup = parse_backup(content)?;
        Ok(RestorePreview {
            task_count: backup.tasks.len(),
            plan_count: backup.plans.len(),
            exported_at: backup.exported_at,
        })
    }
    pub fn restore_backup(
        &mut self,
        content: &str,
        expected_revision: u64,
    ) -> Result<RestoreResult, String> {
        if self.snapshot.revision != expected_revision {
            return Err("数据在恢复预览后已更新，请重新预览备份。原数据未更改。".into());
        }
        let backup = parse_backup(content)?;
        let revision = backup
            .tasks
            .iter()
            .map(|task| task.revision)
            .chain(std::iter::once(self.snapshot.revision))
            .max()
            .unwrap_or(1)
            .checked_add(1)
            .filter(|revision| *revision <= MAX_SAFE_REVISION)
            .ok_or("修订号已达上限，原数据未更改。")?;
        let mut next = Snapshot {
            tasks: backup.tasks,
            plans: backup.plans,
            settings: self.snapshot.settings.clone(),
            revision,
        };
        // Reusing imported task revisions could let an existing editor overwrite
        // the restore after its store receives the new global revision.
        for task in &mut next.tasks {
            task.revision = revision;
        }
        next.validate()?;
        encode_backup(&next)?;
        let safety_backup = self.repository.backup()?;
        self.repository.save(&next).map_err(|e| {
            format!(
                "恢复未完成，原数据仍保留；安全备份：{}。{e}",
                safety_backup.display()
            )
        })?;
        self.snapshot = next;
        Ok(RestoreResult {
            snapshot: self.snapshot.clone(),
            safety_backup_path: safety_backup.to_string_lossy().into_owned(),
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    struct FailingRepo;
    impl Repository for FailingRepo {
        fn load(&self) -> Result<Option<Snapshot>, String> {
            Ok(Some(Snapshot::demo("2026-09-24")))
        }
        fn save(&mut self, _: &Snapshot) -> Result<(), String> {
            Err("disk full".into())
        }
        fn load_placement(&self) -> Result<Option<String>, String> {
            Ok(None)
        }
        fn save_placement(&mut self, _: &Snapshot, _: &str) -> Result<(), String> {
            Err("disk full".into())
        }
    }
    #[test]
    fn failed_write_never_publishes_uncommitted_state() {
        let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
        let id = service.snapshot.tasks[0].id.clone();
        assert!(service
            .mutate(
                Action::SetCompleted {
                    id,
                    completed: true,
                    expected_revision: 1
                },
                1
            )
            .is_err());
        assert_eq!(service.snapshot.revision, 1);
        assert!(!service.snapshot.tasks[0].completed);
    }
    #[test]
    fn failed_reorder_save_preserves_the_published_plan_order_and_revision() {
        let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
        let before = serde_json::to_value(&service.snapshot).unwrap();
        let task_ids = service
            .snapshot
            .tasks
            .iter()
            .filter(|task| {
                !task.completed
                    && service
                        .snapshot
                        .plans
                        .iter()
                        .any(|plan| plan.date == "2026-09-24" && plan.task_id == task.id)
            })
            .map(|task| task.id.clone())
            .rev()
            .collect();
        let error = service
            .mutate(
                Action::ReorderToday {
                    date: "2026-09-24".into(),
                    task_ids,
                },
                service.snapshot.revision,
            )
            .unwrap_err();
        assert_eq!(error, "disk full");
        assert_eq!(serde_json::to_value(&service.snapshot).unwrap(), before);
    }
    #[test]
    fn invalid_imports_share_preview_validation_and_never_publish_changes() {
        let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
        let valid: serde_json::Value =
            serde_json::from_str(&service.export_backup().unwrap()).unwrap();
        let original = serde_json::to_value(&service.snapshot).unwrap();
        let mut cases = vec![
            serde_json::json!({}),
            serde_json::json!({"schemaVersion":99}),
        ];
        for mutate in [
            ("schemaVersion", serde_json::json!(99)),
            ("exportedAt", serde_json::json!("not-a-timestamp")),
            ("settings", serde_json::json!({"theme":"dark"})),
        ] {
            let mut value = valid.clone();
            value[mutate.0] = mutate.1;
            cases.push(value);
        }
        let mut orphan = valid.clone();
        orphan["plans"][0]["taskId"] = serde_json::json!("missing");
        cases.push(orphan);
        let mut duplicate = valid.clone();
        duplicate["tasks"][1]["id"] = duplicate["tasks"][0]["id"].clone();
        cases.push(duplicate);
        let mut invalid_date = valid.clone();
        invalid_date["plans"][0]["date"] = serde_json::json!("2026-02-30");
        cases.push(invalid_date);
        let mut invalid_state = valid.clone();
        invalid_state["tasks"][0]["completed"] = serde_json::json!(true);
        invalid_state["tasks"][0]["completedAt"] = serde_json::Value::Null;
        cases.push(invalid_state);
        for value in cases {
            let content = serde_json::to_string(&value).unwrap();
            assert!(service.preview_restore(&content).is_err(), "{content}");
            assert!(
                service
                    .restore_backup(&content, service.snapshot.revision)
                    .is_err(),
                "{content}"
            );
            assert_eq!(serde_json::to_value(&service.snapshot).unwrap(), original);
        }
        let oversized = " ".repeat(MAX_BACKUP_BYTES + 1);
        assert!(service.preview_restore(&oversized).is_err());
        assert!(service
            .restore_backup(&oversized, service.snapshot.revision)
            .is_err());
    }
    #[test]
    fn safety_backup_failure_and_stale_preview_leave_live_state_unchanged() {
        let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
        let content = service.export_backup().unwrap();
        let original = serde_json::to_value(&service.snapshot).unwrap();
        assert!(service.preview_restore(&content).is_ok());
        assert!(service.restore_backup(&content, 999).is_err());
        let error = service
            .restore_backup(&content, service.snapshot.revision)
            .err()
            .unwrap();
        assert!(error.contains("安全备份"));
        assert_eq!(serde_json::to_value(&service.snapshot).unwrap(), original);
    }
    #[test]
    fn restore_rejects_revision_exhaustion_before_creating_backup() {
        let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
        let mut value: serde_json::Value =
            serde_json::from_str(&service.export_backup().unwrap()).unwrap();
        value["tasks"][0]["revision"] = serde_json::json!(MAX_SAFE_REVISION);
        let content = serde_json::to_string(&value).unwrap();
        assert!(service.preview_restore(&content).is_ok());
        let error = service
            .restore_backup(&content, service.snapshot.revision)
            .err()
            .unwrap();
        assert!(error.contains("修订号"));
        assert_eq!(service.snapshot.revision, 1);
    }
    #[test]
    fn capacity_guard_keeps_new_mutations_exportable_without_publishing_failure() {
        let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
        let template = service.snapshot.tasks[0].clone();
        service.snapshot.tasks = (0..MAX_BACKUP_TASKS)
            .map(|index| {
                let mut task = template.clone();
                task.id = format!("synthetic-capacity-{index}");
                task
            })
            .collect();
        service.snapshot.plans.clear();
        let error = service.mutate(Action::CreateTask {
            task: serde_json::json!({"title":"beyond supported capacity", "addToToday":false}),
            date:"2026-09-24".into()
        },service.snapshot.revision).unwrap_err();
        assert!(error.contains("可恢复备份容量"));
        assert_eq!(service.snapshot.tasks.len(), MAX_BACKUP_TASKS);
        assert_eq!(service.snapshot.revision, 1);
    }
}
