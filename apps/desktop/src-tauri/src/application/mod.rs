use crate::domain::{Action, Plan, Snapshot, Task};
use crate::infrastructure::Repository;
use crate::sync::{data::SyncData, state::SyncState};
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    task_order: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    deadline_order: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub task_count: usize,
    pub trashed_task_count: usize,
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
        schema_version: 3,
        exported_at: chrono::Utc::now().to_rfc3339(),
        tasks: snapshot.tasks.clone(),
        plans: snapshot.plans.clone(),
        task_order: snapshot.task_order.clone(),
        deadline_order: snapshot.deadline_order.clone(),
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
    if ![1, 2, 3].contains(&backup.schema_version) {
        return Err(format!(
            "备份版本 {} 不受支持，原数据未更改。",
            backup.schema_version
        ));
    }
    if backup.schema_version == 1 && backup.tasks.iter().any(|task| task.deleted_at.is_some()) {
        return Err("旧版 v1 备份不能携带回收站状态，原数据未更改。".into());
    }
    if backup.schema_version < 3
        && (!backup.task_order.is_empty() || !backup.deadline_order.is_empty())
    {
        return Err("旧版 v1/v2 备份不能携带自定义任务顺序，原数据未更改。".into());
    }
    if backup.tasks.len() > MAX_BACKUP_TASKS || backup.plans.len() > MAX_BACKUP_PLANS {
        return Err("备份任务或计划数量超出此版本限制，原数据未更改。".into());
    }
    chrono::DateTime::parse_from_rfc3339(&backup.exported_at)
        .map_err(|_| "备份导出时间无效，原数据未更改。")?;
    let snapshot = Snapshot {
        tasks: backup.tasks.clone(),
        plans: backup.plans.clone(),
        task_order: backup.task_order.clone(),
        deadline_order: backup.deadline_order.clone(),
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
    pub sync: SyncState,
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
        let sync = repository.load_sync()?.unwrap_or_default();
        sync.validate()?;
        Ok(Self {
            snapshot,
            sync,
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
    pub fn persist_sync(&mut self, state: SyncState) -> Result<(), String> {
        state.validate()?;
        self.repository.save_with_sync(&self.snapshot, &state)?;
        self.sync = state;
        Ok(())
    }
    pub fn commit_sync(
        &mut self,
        data: &SyncData,
        state: SyncState,
        expected_revision: u64,
    ) -> Result<Snapshot, String> {
        if self.snapshot.revision != expected_revision {
            return Err("同步期间本地任务已更新，请重试同步；本地修改仍保留。".into());
        }
        state.validate()?;
        let next = data.apply_to(&self.snapshot)?;
        next.validate()?;
        encode_backup(&next)?;
        self.repository.save_with_sync(&next, &state)?;
        self.snapshot = next;
        self.sync = state;
        Ok(self.snapshot.clone())
    }
    fn ensure_restore_disconnected(&self) -> Result<(), String> {
        if self.sync.enabled || self.sync.binding.is_some() {
            return Err("请先断开同步，再恢复备份；避免旧备份覆盖其他设备的数据。".into());
        }
        Ok(())
    }
    pub fn preview_restore(&self, content: &str) -> Result<RestorePreview, String> {
        self.ensure_restore_disconnected()?;
        let backup = parse_backup(content)?;
        Ok(RestorePreview {
            task_count: backup.tasks.len(),
            trashed_task_count: backup
                .tasks
                .iter()
                .filter(|task| task.deleted_at.is_some())
                .count(),
            plan_count: backup.plans.len(),
            exported_at: backup.exported_at,
        })
    }
    pub fn restore_backup(
        &mut self,
        content: &str,
        expected_revision: u64,
    ) -> Result<RestoreResult, String> {
        self.ensure_restore_disconnected()?;
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
            task_order: backup.task_order,
            deadline_order: backup.deadline_order,
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
    fn unsupported_sync_storage_never_publishes_metadata_or_tasks() {
        let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
        let snapshot = serde_json::to_value(&service.snapshot).unwrap();
        let sync = serde_json::to_value(&service.sync).unwrap();
        let mut next_state = service.sync.clone();
        next_state.device_id = uuid::Uuid::new_v4().to_string();
        assert!(service.persist_sync(next_state.clone()).is_err());
        let mut data = SyncData::from_snapshot(&service.snapshot);
        data.tasks[0].title = "Synthetic remote change".into();
        assert!(service
            .commit_sync(&data, next_state, service.snapshot.revision)
            .is_err());
        assert_eq!(serde_json::to_value(&service.snapshot).unwrap(), snapshot);
        assert_eq!(serde_json::to_value(&service.sync).unwrap(), sync);
    }
    #[test]
    fn stale_sync_result_is_rejected_without_publication() {
        let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
        let before = serde_json::to_value(&service.snapshot).unwrap();
        let data = SyncData::from_snapshot(&service.snapshot);
        let error = service
            .commit_sync(&data, service.sync.clone(), service.snapshot.revision + 1)
            .unwrap_err();
        assert!(error.contains("同步期间本地任务已更新"));
        assert_eq!(serde_json::to_value(&service.snapshot).unwrap(), before);
    }
    #[test]
    fn restore_and_preview_require_disconnecting_even_when_sync_is_paused() {
        use crate::sync::state::{SyncBinding, SyncConfig};
        let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
        let content = service.export_backup().unwrap();
        let before = serde_json::to_value(&service.snapshot).unwrap();
        service.sync.enabled = true;
        assert!(service
            .preview_restore(&content)
            .err()
            .unwrap()
            .contains("先断开同步"));
        assert!(service
            .restore_backup(&content, service.snapshot.revision)
            .err()
            .unwrap()
            .contains("先断开同步"));
        service.sync.enabled = false;
        service.sync.binding = Some(SyncBinding {
            user_id: uuid::Uuid::new_v4().to_string(),
            email: "synthetic@example.test".into(),
            config: SyncConfig {
                project_url: "https://synthetic.supabase.co".into(),
                publishable_key: "sb_publishable_synthetic_test_key".into(),
            },
        });
        assert!(service
            .preview_restore(&content)
            .err()
            .unwrap()
            .contains("先断开同步"));
        assert!(service
            .restore_backup(&content, service.snapshot.revision)
            .err()
            .unwrap()
            .contains("先断开同步"));
        assert_eq!(serde_json::to_value(&service.snapshot).unwrap(), before);
        service.sync.binding = None;
        assert!(service.preview_restore(&content).is_ok());
    }
    #[test]
    fn failed_order_write_never_publishes_order_or_sort_mode() {
        for scope in ["all", "deadlines"] {
            let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
            let task_ids = service
                .snapshot
                .tasks
                .iter()
                .filter(|task| !task.completed && (scope == "all" || task.due_date.is_some()))
                .rev()
                .map(|task| task.id.clone())
                .collect();
            let before = serde_json::to_value(&service.snapshot).unwrap();
            assert_eq!(
                service
                    .mutate(
                        Action::ReorderTasks {
                            scope: scope.into(),
                            task_ids
                        },
                        service.snapshot.revision
                    )
                    .unwrap_err(),
                "disk full"
            );
            assert_eq!(serde_json::to_value(&service.snapshot).unwrap(), before);
        }
    }
    #[test]
    fn portable_v3_validates_orders_and_older_versions_cannot_disguise_them() {
        let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
        service.snapshot.task_order = service
            .snapshot
            .tasks
            .iter()
            .rev()
            .map(|task| task.id.clone())
            .collect();
        service.snapshot.deadline_order = service.snapshot.task_order.clone();
        let content = service.export_backup().unwrap();
        let backup = parse_backup(&content).unwrap();
        assert_eq!(backup.schema_version, 3);
        assert_eq!(backup.task_order, service.snapshot.task_order);
        assert_eq!(backup.deadline_order, service.snapshot.deadline_order);
        let value: serde_json::Value = serde_json::from_str(&content).unwrap();
        for version in [1, 2] {
            let mut old = value.clone();
            old["schemaVersion"] = serde_json::json!(version);
            assert!(parse_backup(&serde_json::to_string(&old).unwrap()).is_err());
            old.as_object_mut().unwrap().remove("taskOrder");
            old.as_object_mut().unwrap().remove("deadlineOrder");
            let parsed = parse_backup(&serde_json::to_string(&old).unwrap()).unwrap();
            assert!(parsed.task_order.is_empty() && parsed.deadline_order.is_empty());
        }
        for key in ["taskOrder", "deadlineOrder"] {
            for order in [
                serde_json::json!(["missing"]),
                serde_json::json!([service.snapshot.tasks[0].id, service.snapshot.tasks[0].id]),
                serde_json::Value::Null,
            ] {
                let mut invalid = value.clone();
                invalid[key] = order;
                assert!(parse_backup(&serde_json::to_string(&invalid).unwrap()).is_err());
            }
        }
    }
    #[test]
    fn failed_trash_and_restore_writes_never_publish_lifecycle_changes() {
        for restore in [false, true] {
            let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
            if restore {
                service.snapshot.tasks[0].deleted_at = Some("2026-09-25T01:02:03Z".into());
            }
            let before = serde_json::to_value(&service.snapshot).unwrap();
            let id = service.snapshot.tasks[0].id.clone();
            let action = if restore {
                Action::RestoreTask {
                    id,
                    expected_revision: 1,
                }
            } else {
                Action::TrashTask {
                    id,
                    expected_revision: 1,
                }
            };
            assert_eq!(
                service
                    .mutate(action, service.snapshot.revision)
                    .unwrap_err(),
                "disk full"
            );
            assert_eq!(serde_json::to_value(&service.snapshot).unwrap(), before);
        }
    }
    #[test]
    fn portable_v1_accepts_missing_or_null_deleted_state_but_rejects_nonempty_trash() {
        let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
        let mut value: serde_json::Value =
            serde_json::from_str(&service.export_backup().unwrap()).unwrap();
        value["schemaVersion"] = serde_json::json!(1);
        for task in value["tasks"].as_array_mut().unwrap() {
            task.as_object_mut().unwrap().remove("deletedAt");
        }
        let content = serde_json::to_string(&value).unwrap();
        assert_eq!(
            service
                .preview_restore(&content)
                .unwrap()
                .trashed_task_count,
            0
        );
        value["tasks"][0]["deletedAt"] = serde_json::Value::Null;
        assert!(service
            .preview_restore(&serde_json::to_string(&value).unwrap())
            .is_ok());
        value["tasks"][0]["deletedAt"] = serde_json::json!("2026-09-25T01:02:03Z");
        let content = serde_json::to_string(&value).unwrap();
        let before = serde_json::to_value(&service.snapshot).unwrap();
        assert!(service
            .preview_restore(&content)
            .err()
            .unwrap()
            .contains("v1"));
        assert!(service
            .restore_backup(&content, service.snapshot.revision)
            .err()
            .unwrap()
            .contains("v1"));
        assert_eq!(serde_json::to_value(&service.snapshot).unwrap(), before);
        value["schemaVersion"] = serde_json::json!(2);
        let preview = service
            .preview_restore(&serde_json::to_string(&value).unwrap())
            .unwrap();
        assert_eq!(preview.trashed_task_count, 1);
        assert_eq!(preview.task_count, service.snapshot.tasks.len());
        value["tasks"][0]["deletedAt"] = serde_json::json!("invalid-time");
        assert!(service
            .preview_restore(&serde_json::to_string(&value).unwrap())
            .is_err());
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
    #[test]
    fn trash_metadata_over_backup_capacity_keeps_the_task_visible_and_unchanged() {
        let mut service = TaskService::new(Box::new(FailingRepo)).unwrap();
        let template = service.snapshot.tasks[0].clone();
        service.snapshot.tasks = (0..2200)
            .map(|index| {
                let mut task = template.clone();
                task.id = format!("synthetic-byte-boundary-{index}");
                task.notes = "x".repeat(5000);
                task
            })
            .collect();
        service.snapshot.plans.clear();
        // Leave a small but valid export margin. Adding a deletion timestamp
        // must not silently produce a state this app cannot back up/restore.
        let sized = TaskBackup {
            schema_version: 3,
            exported_at: chrono::Utc::now().to_rfc3339(),
            tasks: service.snapshot.tasks.clone(),
            plans: vec![],
            task_order: vec![],
            deadline_order: vec![],
        };
        let mut excess = serde_json::to_string(&sized).unwrap().len() - (MAX_BACKUP_BYTES - 16);
        for task in &mut service.snapshot.tasks {
            let removed = excess.min(task.notes.len());
            task.notes.truncate(task.notes.len() - removed);
            excess -= removed;
        }
        assert_eq!(excess, 0);
        assert!(encode_backup(&service.snapshot).is_ok());
        let before = serde_json::to_value(&service.snapshot).unwrap();
        let error = service
            .mutate(
                Action::TrashTask {
                    id: service.snapshot.tasks[0].id.clone(),
                    expected_revision: 1,
                },
                service.snapshot.revision,
            )
            .unwrap_err();
        assert!(error.contains("10 MiB"), "{error}");
        assert_eq!(serde_json::to_value(&service.snapshot).unwrap(), before);
    }
}
