use super::*;
use crate::application::TaskService;
use crate::domain::Action;

fn connected_state(mut state: SyncState) -> SyncState {
    use crate::sync::state::{SyncBinding, SyncConfig};
    state.binding = Some(SyncBinding {
        user_id: uuid::Uuid::new_v4().to_string(),
        email: "synthetic@example.test".into(),
        config: SyncConfig {
            project_url: "https://synthetic.supabase.co".into(),
            publishable_key: "sb_publishable_synthetic_test_key".into(),
        },
    });
    state.enabled = true;
    state
}

#[test]
fn schema_six_migration_preserves_raw_values_and_persists_device_identity() {
    let temp = super::tests::TempDatabase::new();
    let legacy = temp.legacy_version(6);
    let raw = format!("\n{legacy}\n");
    let placement = r#"{ "offset":0.4, "console":{"width":900}, "usageGuideSeen":true }"#;
    let connection = Connection::open(&temp.path).unwrap();
    connection
        .execute("UPDATE app_state SET value=?1 WHERE key='snapshot'", [&raw])
        .unwrap();
    connection
        .execute(
            "INSERT INTO app_state(key,value) VALUES('placement',?1)",
            [placement],
        )
        .unwrap();
    drop(connection);

    let repo = SqliteRepository::open(&temp.path).unwrap();
    assert_eq!(verify_database(&repo.connection).unwrap(), 7);
    assert_eq!(read_snapshot(&repo.connection).unwrap().0, raw);
    assert_eq!(repo.load_placement().unwrap().as_deref(), Some(placement));
    let sync = repo.load_sync().unwrap().unwrap();
    uuid::Uuid::parse_str(&sync.device_id).unwrap();
    assert!(!sync.enabled && sync.binding.is_none());
    let backups = recovery::list_candidates(&temp.directory).unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0].kind, "before-schema-7");
    assert_eq!(backups[0].schema_version, 6);
    let backup = Connection::open_with_flags(
        temp.directory.join(&backups[0].file_name),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(verify_database(&backup).unwrap(), 6);
    assert_eq!(read_snapshot(&backup).unwrap().0, raw);
    assert!(read_sync(&backup).unwrap().is_none());
    assert_eq!(
        backup
            .query_row(
                "SELECT value FROM app_state WHERE key='placement'",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        placement
    );
    drop(backup);
    drop(repo);
    let reopened = TaskService::new(Box::new(SqliteRepository::open(&temp.path).unwrap())).unwrap();
    assert_eq!(reopened.sync.device_id, sync.device_id);
    assert_eq!(temp.backups().len(), 1);
}

#[test]
fn failed_sync_initialization_rolls_back_schema_seven_migration() {
    let temp = super::tests::TempDatabase::new();
    let raw = temp.legacy_version(6);
    let mut connection = Connection::open(&temp.path).unwrap();
    configure(&connection).unwrap();
    let result = migrate_schema(&mut connection, &temp.path, 6,
        "PRAGMA user_version=7; CREATE TRIGGER reject_sync_init BEFORE INSERT ON app_state WHEN NEW.key='sync' BEGIN SELECT RAISE(ABORT,'injected initialization failure'); END;");
    assert!(result.unwrap_err().contains("安全备份"));
    assert_eq!(verify_database(&connection).unwrap(), 6);
    assert_eq!(read_snapshot(&connection).unwrap().0, raw);
    assert!(read_sync(&connection).unwrap().is_none());
    let candidates = recovery::list_candidates(&temp.directory).unwrap();
    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].kind, "before-schema-7");
    assert_eq!(candidates[0].schema_version, 6);
}

#[test]
fn first_run_device_identity_survives_reopen_without_mutating_snapshot() {
    let temp = super::tests::TempDatabase::new();
    let repo = SqliteRepository::open(&temp.path).unwrap();
    let raw = read_snapshot(&repo.connection).unwrap().0;
    let sync = repo.load_sync().unwrap().unwrap();
    drop(repo);
    let repo = SqliteRepository::open(&temp.path).unwrap();
    assert_eq!(repo.load_sync().unwrap().unwrap().device_id, sync.device_id);
    assert_eq!(read_snapshot(&repo.connection).unwrap().0, raw);
    assert!(temp.backups().is_empty());
}

#[test]
fn schema_one_through_six_reject_sync_rows_before_migration() {
    for version in 1..=6 {
        let temp = super::tests::TempDatabase::new();
        let raw = temp.legacy_version(version);
        let connection = Connection::open(&temp.path).unwrap();
        let state = encode_sync(&SyncState::default()).unwrap();
        connection
            .execute(
                "INSERT INTO app_state(key,value) VALUES('sync',?1)",
                [state],
            )
            .unwrap();
        drop(connection);
        assert!(SqliteRepository::open(&temp.path).is_err());
        let connection = Connection::open(&temp.path).unwrap();
        assert_eq!(read_snapshot(&connection).unwrap().0, raw);
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            version
        );
        assert!(temp.backups().is_empty());
    }
}

#[test]
fn invalid_sync_metadata_is_rejected_by_open_and_recovery_scan() {
    for invalid in ["{broken", r#"{"deviceId":"invalid","enabled":false}"#] {
        let temp = super::tests::TempDatabase::new();
        let repo = SqliteRepository::open(&temp.path).unwrap();
        repo.connection
            .execute("UPDATE app_state SET value=?1 WHERE key='sync'", [invalid])
            .unwrap();
        drop(repo);
        let backup = temp.directory.join(format!(
            "sidetask-safety-backup-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        fs::copy(&temp.path, &backup).unwrap();
        assert!(recovery::list_candidates(&temp.directory)
            .unwrap()
            .is_empty());
        assert!(SqliteRepository::open(&temp.path).is_err());
        let connection = Connection::open(&temp.path).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT value FROM app_state WHERE key='sync'", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            invalid
        );
    }
}

#[test]
fn oversized_sync_is_rejected_before_deserialization() {
    let repo = SqliteRepository::open(Path::new(":memory:")).unwrap();
    repo.connection
        .execute(
            "UPDATE app_state SET value=CAST(zeroblob(?1) AS TEXT) WHERE key='sync'",
            [MAX_SYNC_BYTES as i64 + 1],
        )
        .unwrap();
    assert!(read_sync(&repo.connection).err().unwrap().contains("过大"));
}

#[test]
fn sync_and_snapshot_write_rollback_together_and_can_retry() {
    for rejected in ["sync", "snapshot"] {
        let mut repo = SqliteRepository::open(Path::new(":memory:")).unwrap();
        let original = Snapshot::demo("2026-10-04");
        repo.save(&original).unwrap();
        let old_snapshot = read_snapshot(&repo.connection).unwrap().0;
        let old_sync = read_sync(&repo.connection).unwrap().unwrap().0;
        let mut next_sync = repo.load_sync().unwrap().unwrap();
        next_sync.device_id = uuid::Uuid::new_v4().to_string();
        let next = original
            .apply(
                Action::UpdateTask {
                    id: original.tasks[0].id.clone(),
                    changes: serde_json::json!({"title":"Atomic synthetic update"}),
                    expected_revision: original.tasks[0].revision,
                },
                original.revision,
            )
            .unwrap();
        repo.connection.execute_batch(&format!("CREATE TRIGGER fail_sync_write BEFORE UPDATE ON app_state WHEN OLD.key='{rejected}' BEGIN SELECT RAISE(ABORT,'injected failure'); END;")).unwrap();
        assert!(repo.save_with_sync(&next, &next_sync).is_err());
        assert_eq!(read_snapshot(&repo.connection).unwrap().0, old_snapshot);
        assert_eq!(read_sync(&repo.connection).unwrap().unwrap().0, old_sync);
        assert_eq!(*repo.baseline.borrow(), old_snapshot);
        assert_eq!(*repo.sync_baseline.borrow(), Some(old_sync));
        repo.connection
            .execute_batch("DROP TRIGGER fail_sync_write;")
            .unwrap();
        repo.save_with_sync(&next, &next_sync).unwrap();
        assert_eq!(repo.load().unwrap().unwrap().tasks, next.tasks);
        assert_eq!(
            repo.load_sync().unwrap().unwrap().device_id,
            next_sync.device_id
        );
    }
}

#[test]
fn sync_only_cas_rejects_unseen_metadata_change() {
    let temp = super::tests::TempDatabase::new();
    let mut first = SqliteRepository::open(&temp.path).unwrap();
    let mut second = SqliteRepository::open(&temp.path).unwrap();
    let snapshot = first.load().unwrap().unwrap();
    let mut state = first.load_sync().unwrap().unwrap();
    state.device_id = uuid::Uuid::new_v4().to_string();
    first.save_with_sync(&snapshot, &state).unwrap();
    let stale = second.sync_baseline.borrow().clone();
    assert!(second
        .save_with_sync(&snapshot, &SyncState::default())
        .unwrap_err()
        .contains("同步状态已被另一实例更新"));
    assert_eq!(*second.sync_baseline.borrow(), stale);
    assert_eq!(
        first.load_sync().unwrap().unwrap().device_id,
        state.device_id
    );
}

#[test]
fn schema_seven_missing_metadata_initializes_once_without_reencoding_tasks() {
    let temp = super::tests::TempDatabase::new();
    let raw = temp.legacy_version(7);
    let repo = SqliteRepository::open(&temp.path).unwrap();
    assert_eq!(read_snapshot(&repo.connection).unwrap().0, raw);
    let id = repo.load_sync().unwrap().unwrap().device_id;
    drop(repo);
    let repo = SqliteRepository::open(&temp.path).unwrap();
    assert_eq!(repo.load_sync().unwrap().unwrap().device_id, id);
}

#[test]
fn local_task_changes_remain_pending_across_restart_but_settings_do_not() {
    use crate::sync::data::SyncData;
    let temp = super::tests::TempDatabase::new();
    let mut service =
        TaskService::new(Box::new(SqliteRepository::open(&temp.path).unwrap())).unwrap();
    let baseline = service.sync.baseline.clone();
    assert_eq!(SyncData::from_snapshot(&service.snapshot), baseline);
    service
        .mutate(
            Action::UpdateSettings {
                changes: serde_json::json!({"theme":"dark","panelWidth":400,"ddlSort":"priority"}),
            },
            service.snapshot.revision,
        )
        .unwrap();
    assert_eq!(SyncData::from_snapshot(&service.snapshot), baseline);
    service
        .mutate(
            Action::CreateTask {
                task: serde_json::json!({"title":"Offline synthetic task","addToToday":true}),
                date: "2026-10-04".into(),
            },
            service.snapshot.revision,
        )
        .unwrap();
    let pending = SyncData::from_snapshot(&service.snapshot);
    assert_ne!(pending, baseline);
    assert_eq!(service.sync.baseline, baseline);
    let task_id = service.snapshot.tasks[0].id.clone();
    drop(service);
    let service = TaskService::new(Box::new(SqliteRepository::open(&temp.path).unwrap())).unwrap();
    assert_eq!(SyncData::from_snapshot(&service.snapshot), pending);
    assert_eq!(service.sync.baseline, baseline);
    assert_eq!(service.snapshot.tasks[0].id, task_id);
    assert_eq!(service.snapshot.settings.theme, "dark");
}

#[test]
fn service_sync_metadata_commits_without_changing_local_revisions() {
    let temp = super::tests::TempDatabase::new();
    let mut repo = SqliteRepository::open(&temp.path).unwrap();
    repo.save(&Snapshot::demo("2026-10-04")).unwrap();
    let mut service = TaskService::new(Box::new(repo)).unwrap();
    let original = serde_json::to_value(&service.snapshot).unwrap();
    let mut state = service.sync.clone();
    state.device_id = uuid::Uuid::new_v4().to_string();
    service.persist_sync(state.clone()).unwrap();
    assert_eq!(serde_json::to_value(&service.snapshot).unwrap(), original);
    drop(service);
    let service = TaskService::new(Box::new(SqliteRepository::open(&temp.path).unwrap())).unwrap();
    assert_eq!(service.sync.device_id, state.device_id);
    assert_eq!(serde_json::to_value(&service.snapshot).unwrap(), original);
}

#[test]
fn service_remote_commit_preserves_local_settings_and_invalidates_task_editor() {
    use crate::sync::data::SyncData;
    let temp = super::tests::TempDatabase::new();
    let mut repo = SqliteRepository::open(&temp.path).unwrap();
    let mut initial = Snapshot::demo("2026-10-04");
    initial.settings.theme = "dark".into();
    initial.settings.panel_width = 400.;
    repo.save(&initial).unwrap();
    let mut service = TaskService::new(Box::new(repo)).unwrap();
    let mut incoming = SyncData::from_snapshot(&initial);
    incoming.tasks[0].title = "Synthetic remote title".into();
    let mut state = connected_state(service.sync.clone());
    state.baseline = incoming.clone();
    state.remote_revision = 2;
    state.last_synced_at = Some("2026-10-04T00:00:00Z".into());
    let committed = service
        .commit_sync(&incoming, state, initial.revision)
        .unwrap();
    assert_eq!(committed.settings, initial.settings);
    assert_eq!(committed.revision, initial.revision + 1);
    assert_eq!(committed.tasks[0].revision, initial.tasks[0].revision + 1);
    assert!(service
        .mutate(
            Action::UpdateTask {
                id: initial.tasks[0].id.clone(),
                changes: serde_json::json!({"notes":"stale edit"}),
                expected_revision: initial.tasks[0].revision
            },
            committed.revision
        )
        .is_err());
    let same = service
        .commit_sync(&incoming, service.sync.clone(), committed.revision)
        .unwrap();
    assert_eq!(same.revision, committed.revision);
    drop(service);
    let service = TaskService::new(Box::new(SqliteRepository::open(&temp.path).unwrap())).unwrap();
    assert_eq!(
        serde_json::to_value(&service.snapshot).unwrap(),
        serde_json::to_value(committed).unwrap()
    );
    assert_eq!(service.sync.baseline, incoming);
    assert_eq!(service.sync.remote_revision, 2);
    assert!(service.sync.enabled);
}

#[test]
fn account_metadata_contains_public_configuration_but_no_credentials() {
    let mut repo = SqliteRepository::open(Path::new(":memory:")).unwrap();
    let snapshot = repo.load().unwrap().unwrap();
    let state = connected_state(repo.load_sync().unwrap().unwrap());
    repo.save_with_sync(&snapshot, &state).unwrap();
    let (raw, loaded) = read_sync(&repo.connection).unwrap().unwrap();
    assert_eq!(loaded.binding.unwrap().email, "synthetic@example.test");
    assert!(raw.contains("sb_publishable_synthetic_test_key"));
    let mut json: Value = serde_json::from_str(&raw).unwrap();
    let binding = json["binding"].as_object().unwrap();
    assert_eq!(binding.len(), 3);
    assert_eq!(binding["config"].as_object().unwrap().len(), 2);
    assert!(
        !raw.contains("accessToken") && !raw.contains("refreshToken") && !raw.contains("password")
    );
    json["accessToken"] = Value::String("synthetic-must-not-persist".into());
    repo.connection
        .execute(
            "UPDATE app_state SET value=?1 WHERE key='sync'",
            [serde_json::to_string(&json).unwrap()],
        )
        .unwrap();
    assert!(verify_database(&repo.connection).is_err());
}

#[test]
fn failed_service_sync_commit_does_not_publish_or_acknowledge_pending_changes() {
    use crate::sync::data::SyncData;
    let temp = super::tests::TempDatabase::new();
    let mut repo = SqliteRepository::open(&temp.path).unwrap();
    let initial = Snapshot::demo("2026-10-04");
    repo.save(&initial).unwrap();
    let mut service = TaskService::new(Box::new(repo)).unwrap();
    let mut incoming = SyncData::from_snapshot(&initial);
    incoming.tasks[0].title = "Synthetic incoming state".into();
    let mut next = connected_state(service.sync.clone());
    next.baseline = incoming.clone();
    next.remote_revision = 1;
    let old_sync = serde_json::to_value(&service.sync).unwrap();
    let connection = Connection::open(&temp.path).unwrap();
    connection.execute_batch("CREATE TRIGGER reject_sync BEFORE UPDATE ON app_state WHEN OLD.key='sync' BEGIN SELECT RAISE(ABORT,'injected disk failure'); END;").unwrap();
    assert!(service
        .commit_sync(&incoming, next, initial.revision)
        .is_err());
    assert_eq!(
        serde_json::to_value(&service.snapshot).unwrap(),
        serde_json::to_value(&initial).unwrap()
    );
    assert_eq!(serde_json::to_value(&service.sync).unwrap(), old_sync);
    assert_eq!(read_snapshot(&connection).unwrap().1.tasks, initial.tasks);
    assert_eq!(
        serde_json::to_value(read_sync(&connection).unwrap().unwrap().1).unwrap(),
        old_sync
    );
    connection
        .execute_batch("DROP TRIGGER reject_sync;")
        .unwrap();
}
