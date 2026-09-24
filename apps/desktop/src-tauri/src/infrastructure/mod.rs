pub mod recovery;

use crate::domain::Snapshot;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use std::{
    cell::RefCell,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};

const SCHEMA_VERSION: i64 = 2;
const APPLICATION_ID: i64 = 0x5344544b;
const MAX_SNAPSHOT_BYTES: i64 = 16 * 1024 * 1024;

/// One shared database and one transaction per command. Schema 1 is retained in
/// a verified SQLite backup before the non-destructive schema 2 upgrade.
pub trait Repository: Send {
    fn load(&self) -> Result<Option<Snapshot>, String>;
    fn save(&mut self, snapshot: &Snapshot) -> Result<(), String>;
    fn load_placement(&self) -> Result<Option<String>, String>;
    fn save_placement(&mut self, snapshot: &Snapshot, placement: &str) -> Result<(), String>;
    fn backup(&self) -> Result<PathBuf, String> {
        Err("此存储不支持安全备份；未恢复数据。".into())
    }
}
pub struct SqliteRepository {
    connection: Connection,
    path: Option<PathBuf>,
    baseline: RefCell<String>,
}

fn storage_error(error: impl std::fmt::Display) -> String {
    format!("本地数据无法读取，原数据未覆盖：{error}")
}
fn configure(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(std::time::Duration::from_secs(3))
        .map_err(storage_error)?;
    connection
        .execute_batch(
            "PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;",
        )
        .map_err(storage_error)
}
fn private_new_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|e| format!("无法新建安全文件（不会覆盖已有文件）：{e}"))
}
fn verify_schema(connection: &Connection) -> Result<i64, String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(storage_error)?;
    let application: i64 = connection
        .query_row("PRAGMA application_id", [], |r| r.get(0))
        .map_err(storage_error)?;
    if ![1, SCHEMA_VERSION].contains(&version) {
        return Err(format!(
            "数据库版本 {version} 不受此版本支持。原数据未覆盖。"
        ));
    }
    if (version == 1 && application != 0)
        || (version == SCHEMA_VERSION && application != APPLICATION_ID)
    {
        return Err("数据库身份不匹配，原数据未覆盖。".into());
    }
    let mut statement = connection
        .prepare(
            "SELECT type,name FROM sqlite_schema WHERE substr(name,1,7) != 'sqlite_' ORDER BY name",
        )
        .map_err(storage_error)?;
    let objects = statement
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(storage_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(storage_error)?;
    if objects != vec![("table".into(), "app_state".into())] {
        return Err("数据库结构异常或含未知对象，原数据未覆盖。".into());
    }
    let mut statement = connection
        .prepare("PRAGMA table_xinfo(app_state)")
        .map_err(storage_error)?;
    let columns = statement
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)?,
            ))
        })
        .map_err(storage_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(storage_error)?;
    if columns
        != vec![
            ("key".into(), "TEXT".into(), 1, 1, 0),
            ("value".into(), "TEXT".into(), 1, 0, 0),
        ]
    {
        return Err("数据库字段或约束异常，原数据未覆盖。".into());
    }
    let unknown: i64 = connection.query_row("SELECT count(*) FROM app_state WHERE key NOT IN ('snapshot','placement') OR typeof(key) != 'text' OR typeof(value) != 'text'", [], |r| r.get(0)).map_err(storage_error)?;
    if unknown != 0 {
        return Err("数据库含未知记录，原数据未覆盖。".into());
    }
    let integrity: String = connection
        .query_row("PRAGMA integrity_check(1)", [], |r| r.get(0))
        .map_err(storage_error)?;
    if integrity != "ok" {
        return Err(storage_error(integrity));
    }
    Ok(version)
}
fn read_snapshot(connection: &Connection) -> Result<(String, Snapshot), String> {
    let length: Option<i64> = connection
        .query_row(
            "SELECT length(CAST(value AS BLOB)) FROM app_state WHERE key='snapshot'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    match length {
        None => {
            return Err("本地数据库缺少任务快照，原数据未覆盖。请使用已验证的备份恢复。".into())
        }
        Some(length) if length > MAX_SNAPSHOT_BYTES => {
            return Err("本地任务快照过大，原数据未覆盖。".into())
        }
        _ => {}
    }
    let json: String = connection
        .query_row(
            "SELECT value FROM app_state WHERE key='snapshot'",
            [],
            |r| r.get(0),
        )
        .map_err(storage_error)?;
    let snapshot: Snapshot = serde_json::from_str(&json).map_err(storage_error)?;
    snapshot.validate().map_err(storage_error)?;
    Ok((json, snapshot))
}
fn verify_database(connection: &Connection) -> Result<i64, String> {
    let version = verify_schema(connection)?;
    read_snapshot(connection)?;
    Ok(version)
}
fn parent_directory(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}
fn sync_parent(path: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = path;
    #[cfg(unix)]
    {
        File::open(parent_directory(path))
            .and_then(|directory| directory.sync_all())
            .map_err(|e| format!("无法同步备份目录，未开始更改数据：{e}"))?;
    }
    Ok(())
}
fn consistent_backup(
    connection: &Connection,
    source: &Path,
    purpose: &str,
) -> Result<PathBuf, String> {
    verify_database(connection)?;
    let directory = parent_directory(source);
    let destination = directory.join(format!(
        "sidetask-{purpose}-{}.sqlite3",
        uuid::Uuid::new_v4()
    ));
    let file = private_new_file(&destination)?;
    let result = (|| {
        let destination_text = destination
            .to_str()
            .ok_or("备份路径无法编码，未开始更改数据。")?;
        // VACUUM INTO copies a consistent committed database, including WAL data.
        // Bound parameters prevent treating a filename as SQL.
        connection
            .execute("VACUUM main INTO ?1", params![destination_text])
            .map_err(|e| format!("无法完成安全备份，未开始更改数据：{e}"))?;
        file.sync_all()
            .map_err(|e| format!("无法同步安全备份：{e}"))?;
        let check = Connection::open_with_flags(&destination, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(storage_error)?;
        configure(&check)?;
        verify_database(&check)?;
        sync_parent(&destination)?;
        Ok(destination.clone())
    })();
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(&destination);
    }
    result
}
fn migrate_schema_one(
    connection: &mut Connection,
    path: &Path,
    migration_sql: &str,
) -> Result<(), String> {
    // The backup is checked and flushed before the transaction. Migration SQL
    // is compiled into the app; neither backup files nor IPC can supply it.
    let backup = consistent_backup(connection, path, "before-schema-2")?;
    let result = (|| {
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        if verify_database(&transaction)? != 1 {
            return Err("数据库在升级前已改变，请重新打开。".into());
        }
        transaction
            .execute_batch(migration_sql)
            .map_err(storage_error)?;
        if verify_database(&transaction)? != SCHEMA_VERSION {
            return Err("升级后的数据库版本无效。".into());
        }
        transaction.commit().map_err(storage_error)
    })();
    result.map_err(|e| {
        format!(
            "数据库升级未完成；原库回滚，安全备份保留在 {}：{e}",
            backup.display()
        )
    })
}

impl SqliteRepository {
    pub fn open(path: &Path) -> Result<Self, String> {
        recovery::ensure_no_pending(path)?;
        let in_memory = path == Path::new(":memory:");
        let is_new = if in_memory {
            true
        } else {
            match fs::symlink_metadata(path) {
                Ok(metadata) if metadata.is_file() => false,
                Ok(_) => return Err("数据路径不是普通文件，未打开或覆盖。".into()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    recovery::ensure_no_orphan_sidecars(path)?;
                    private_new_file(path)?;
                    true
                }
                Err(error) => return Err(storage_error(error)),
            }
        };
        if !is_new {
            recovery::verify_before_open(path)?;
        }
        let result = (|| {
            let mut connection = if in_memory {
                Connection::open_in_memory()
            } else {
                Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            }
            .map_err(storage_error)?;
            configure(&connection)?;
            if is_new {
                let snapshot = serde_json::to_string(&Snapshot::empty()).map_err(storage_error)?;
                let transaction = connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(storage_error)?;
                transaction
                    .execute_batch(include_str!("../../migrations/0001_snapshot.sql"))
                    .map_err(storage_error)?;
                transaction
                    .execute(
                        "INSERT INTO app_state(key,value) VALUES('snapshot',?1)",
                        params![snapshot],
                    )
                    .map_err(storage_error)?;
                transaction
                    .pragma_update(None, "application_id", APPLICATION_ID)
                    .map_err(storage_error)?;
                transaction
                    .pragma_update(None, "user_version", SCHEMA_VERSION)
                    .map_err(storage_error)?;
                transaction.commit().map_err(storage_error)?;
            } else if verify_database(&connection)? == 1 {
                migrate_schema_one(
                    &mut connection,
                    path,
                    "PRAGMA application_id=1396986955; PRAGMA user_version=2;",
                )?;
            }
            verify_database(&connection)?;
            let (baseline, _) = read_snapshot(&connection)?;
            Ok(Self {
                connection,
                path: (!in_memory).then(|| path.to_path_buf()),
                baseline: RefCell::new(baseline),
            })
        })();
        if result.is_err() && is_new && !in_memory {
            let _ = fs::remove_file(path);
        }
        result
    }
    fn persist(&mut self, snapshot: &Snapshot, placement: Option<&str>) -> Result<(), String> {
        snapshot.validate()?;
        let json = serde_json::to_string(snapshot).map_err(|e| e.to_string())?;
        if json.len() > MAX_SNAPSHOT_BYTES as usize {
            return Err("任务数据过大，未保存。".into());
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("无法保存任务：{e}"))?;
        let (stored, _) = read_snapshot(&transaction)?;
        if stored != *self.baseline.borrow() {
            return Err("本地数据已被另一实例更新，未覆盖；请重新打开应用。".into());
        }
        transaction
            .execute(
                "UPDATE app_state SET value=?1 WHERE key='snapshot'",
                params![json],
            )
            .map_err(|e| format!("无法保存任务：{e}"))?;
        if let Some(placement) = placement {
            transaction.execute("INSERT INTO app_state(key,value) VALUES('placement',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![placement]).map_err(|e|format!("无法保存停靠位置：{e}"))?;
        }
        transaction
            .commit()
            .map_err(|e| format!("无法保存任务：{e}"))?;
        *self.baseline.borrow_mut() = json;
        Ok(())
    }
}
impl Repository for SqliteRepository {
    fn load(&self) -> Result<Option<Snapshot>, String> {
        let (json, snapshot) = read_snapshot(&self.connection)?;
        *self.baseline.borrow_mut() = json;
        Ok(Some(snapshot))
    }
    fn save(&mut self, snapshot: &Snapshot) -> Result<(), String> {
        self.persist(snapshot, None)
    }
    fn load_placement(&self) -> Result<Option<String>, String> {
        self.connection
            .query_row(
                "SELECT value FROM app_state WHERE key='placement'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)
    }
    fn save_placement(&mut self, snapshot: &Snapshot, placement: &str) -> Result<(), String> {
        self.persist(snapshot, Some(placement))
    }
    fn backup(&self) -> Result<PathBuf, String> {
        consistent_backup(
            &self.connection,
            self.path
                .as_deref()
                .ok_or("内存数据库不能创建持久安全备份。")?,
            "safety-backup",
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{application::TaskService, domain::Action};
    #[test]
    fn database_roundtrip_preserves_ids_and_revision() {
        let mut repo = SqliteRepository::open(Path::new(":memory:")).unwrap();
        let snapshot = Snapshot::demo("2026-09-24");
        repo.save(&snapshot).unwrap();
        let loaded = repo.load().unwrap().unwrap();
        assert_eq!(loaded.tasks, snapshot.tasks);
        assert_eq!(loaded.revision, snapshot.revision);
        repo.save_placement(&snapshot, "{\"offset\":0.3}").unwrap();
        assert_eq!(repo.load_placement().unwrap().unwrap(), "{\"offset\":0.3}");
    }
    #[test]
    fn legacy_schema_one_without_ui_style_preserves_tasks_and_plans() {
        let repo = SqliteRepository::open(Path::new(":memory:")).unwrap();
        let mut legacy = serde_json::to_value(Snapshot::demo("2026-09-24")).unwrap();
        legacy["settings"]
            .as_object_mut()
            .unwrap()
            .remove("uiStyle");
        // Use existing content that cannot be confused with freshly seeded data.
        legacy["tasks"][0]["title"] = serde_json::json!("Existing task kept across upgrade");
        legacy["revision"] = serde_json::json!(42);
        let encoded = serde_json::to_string(&legacy).unwrap();
        repo.connection
            .execute(
                "INSERT INTO app_state(key,value) VALUES ('snapshot',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![encoded],
            )
            .unwrap();
        let loaded = repo.load().unwrap().unwrap();
        let loaded_json = serde_json::to_value(&loaded).unwrap();
        assert_eq!(loaded.settings.ui_style, "paper");
        assert_eq!(loaded_json["tasks"], legacy["tasks"]);
        assert_eq!(loaded_json["plans"], legacy["plans"]);
        assert_eq!(loaded.revision, 42);
        let stored: String = repo
            .connection
            .query_row(
                "SELECT value FROM app_state WHERE key='snapshot'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            stored, encoded,
            "reading an old snapshot must not rewrite it"
        );
        let service = TaskService::new(Box::new(repo)).unwrap();
        assert_eq!(service.snapshot.tasks, loaded.tasks);
        assert_eq!(service.snapshot.revision, 42);
    }
    #[test]
    fn every_ui_style_persists_and_reloads_without_mutating_tasks_or_plans() {
        let mut repo = SqliteRepository::open(Path::new(":memory:")).unwrap();
        let mut snapshot = Snapshot::demo("2026-09-24");
        let original = serde_json::to_value(&snapshot).unwrap();
        for style in ["studio", "editorial", "mono", "paper"] {
            snapshot = snapshot
                .apply(
                    Action::UpdateSettings {
                        changes: serde_json::json!({"uiStyle": style}),
                    },
                    snapshot.revision,
                )
                .unwrap();
            repo.save(&snapshot).unwrap();
            let loaded = repo.load().unwrap().unwrap();
            assert_eq!(loaded.settings.ui_style, style);
            assert_eq!(loaded.revision, snapshot.revision);
            let loaded_json = serde_json::to_value(&loaded).unwrap();
            assert_eq!(loaded_json["tasks"], original["tasks"]);
            assert_eq!(loaded_json["plans"], original["plans"]);
        }
    }
    struct TempDatabase {
        directory: PathBuf,
        path: PathBuf,
    }
    impl TempDatabase {
        fn new() -> Self {
            let directory = std::env::temp_dir()
                .join(format!("sidetask-storage-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&directory).unwrap();
            Self {
                path: directory.join("tasks.sqlite3"),
                directory,
            }
        }
        fn legacy(&self) -> String {
            let connection = Connection::open(&self.path).unwrap();
            connection
                .execute_batch(include_str!("../../migrations/0001_snapshot.sql"))
                .unwrap();
            connection.pragma_update(None, "user_version", 1).unwrap();
            let mut value = serde_json::to_value(Snapshot::demo("2026-09-24")).unwrap();
            value["settings"].as_object_mut().unwrap().remove("uiStyle");
            value["revision"] = serde_json::json!(42);
            value["tasks"][0]["title"] = serde_json::json!("Synthetic legacy task");
            let raw = serde_json::to_string(&value).unwrap();
            connection
                .execute(
                    "INSERT INTO app_state(key,value) VALUES('snapshot',?1)",
                    params![raw],
                )
                .unwrap();
            raw
        }
        fn backups(&self) -> Vec<PathBuf> {
            fs::read_dir(&self.directory)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| {
                    path.file_name()
                        .unwrap()
                        .to_string_lossy()
                        .starts_with("sidetask-")
                })
                .collect()
        }
    }
    impl Drop for TempDatabase {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
    #[test]
    fn first_run_and_restart_are_empty_without_demo_tasks() {
        let temp = TempDatabase::new();
        let service =
            TaskService::new(Box::new(SqliteRepository::open(&temp.path).unwrap())).unwrap();
        assert!(service.snapshot.tasks.is_empty());
        assert!(service.snapshot.plans.is_empty());
        drop(service);
        let repo = SqliteRepository::open(&temp.path).unwrap();
        assert!(repo.load().unwrap().unwrap().tasks.is_empty());
        assert!(temp.backups().is_empty());
    }
    #[test]
    fn legacy_upgrade_preserves_snapshot_bytes_and_verified_pre_upgrade_copy() {
        let temp = TempDatabase::new();
        let raw = temp.legacy();
        let repo = SqliteRepository::open(&temp.path).unwrap();
        assert_eq!(verify_database(&repo.connection).unwrap(), 2);
        assert_eq!(read_snapshot(&repo.connection).unwrap().0, raw);
        assert_eq!(repo.load().unwrap().unwrap().settings.ui_style, "paper");
        let backups = temp.backups();
        assert_eq!(backups.len(), 1);
        let backup =
            Connection::open_with_flags(&backups[0], OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(verify_database(&backup).unwrap(), 1);
        assert_eq!(read_snapshot(&backup).unwrap().0, raw);
        drop(repo);
        let _repo = SqliteRepository::open(&temp.path).unwrap();
        assert_eq!(
            temp.backups().len(),
            1,
            "an already upgraded database is not migrated twice"
        );
    }
    #[test]
    fn failed_migration_rolls_back_both_version_markers_and_keeps_backup() {
        let temp = TempDatabase::new();
        let raw = temp.legacy();
        let mut connection = Connection::open(&temp.path).unwrap();
        configure(&connection).unwrap();
        let error = migrate_schema_one(&mut connection,&temp.path,
            "PRAGMA application_id=1396986955; PRAGMA user_version=2; SELECT missing_column FROM app_state;").unwrap_err();
        assert!(error.contains("安全备份"));
        assert_eq!(verify_database(&connection).unwrap(), 1);
        assert_eq!(read_snapshot(&connection).unwrap().0, raw);
        let backups = temp.backups();
        assert_eq!(backups.len(), 1);
        let backup =
            Connection::open_with_flags(&backups[0], OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(read_snapshot(&backup).unwrap().0, raw);
    }
    #[test]
    fn unknown_corrupt_or_empty_existing_files_are_never_initialized_over() {
        for bytes in [Vec::new(), b"not a sqlite database".to_vec()] {
            let temp = TempDatabase::new();
            fs::write(&temp.path, &bytes).unwrap();
            assert!(SqliteRepository::open(&temp.path).is_err());
            assert_eq!(fs::read(&temp.path).unwrap(), bytes);
        }
        for sql in [
            "CREATE TABLE unrelated(secret TEXT); PRAGMA user_version=0;",
            "CREATE TABLE app_state(key TEXT,value TEXT); PRAGMA user_version=1;",
            "CREATE TABLE app_state(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL); PRAGMA user_version=99;",
        ] {
            let temp = TempDatabase::new();
            Connection::open(&temp.path).unwrap().execute_batch(sql).unwrap();
            let before = fs::read(&temp.path).unwrap();
            assert!(SqliteRepository::open(&temp.path).is_err());
            assert_eq!(fs::read(&temp.path).unwrap(),before);
            assert!(temp.backups().is_empty());
        }
    }
    #[test]
    fn corrupted_semantics_missing_snapshot_and_schema_objects_fail_closed() {
        for mutation in [
            "DELETE FROM app_state WHERE key='snapshot'",
            "UPDATE app_state SET value='{broken' WHERE key='snapshot'",
            "UPDATE app_state SET value=json_set(value,'$.plans[0].taskId','orphan') WHERE key='snapshot'",
            "CREATE TRIGGER hidden_write AFTER UPDATE ON app_state BEGIN DELETE FROM app_state; END",
            "CREATE TABLE sqlitex_hidden(value TEXT)",
        ] {
            let temp = TempDatabase::new();
            temp.legacy();
            Connection::open(&temp.path).unwrap().execute_batch(mutation).unwrap();
            let before = fs::read(&temp.path).unwrap();
            assert!(SqliteRepository::open(&temp.path).is_err(),"{mutation}");
            assert_eq!(fs::read(&temp.path).unwrap(),before,"{mutation}");
            assert!(temp.backups().is_empty());
        }
        let temp = TempDatabase::new();
        let repo = SqliteRepository::open(&temp.path).unwrap();
        repo.connection
            .execute("DELETE FROM app_state", [])
            .unwrap();
        drop(repo);
        let before = fs::read(&temp.path).unwrap();
        assert!(SqliteRepository::open(&temp.path).is_err());
        assert_eq!(fs::read(&temp.path).unwrap(), before);
    }
    #[test]
    fn failed_placement_transaction_rolls_back_snapshot_and_remains_retryable() {
        let mut repo = SqliteRepository::open(Path::new(":memory:")).unwrap();
        let original = Snapshot::demo("2026-09-24");
        repo.save_placement(&original, "original").unwrap();
        repo.connection.execute_batch("CREATE TRIGGER reject_placement BEFORE UPDATE ON app_state WHEN OLD.key='placement' BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;").unwrap();
        let next = original
            .apply(
                Action::UpdateSettings {
                    changes: serde_json::json!({"theme":"dark"}),
                },
                original.revision,
            )
            .unwrap();
        assert!(repo.save_placement(&next, "changed").is_err());
        assert_eq!(
            read_snapshot(&repo.connection).unwrap().1.revision,
            original.revision
        );
        assert_eq!(repo.load_placement().unwrap().unwrap(), "original");
        repo.connection
            .execute_batch("DROP TRIGGER reject_placement")
            .unwrap();
        repo.save_placement(&next, "changed").unwrap();
        assert_eq!(repo.load().unwrap().unwrap().revision, next.revision);
        assert_eq!(repo.load_placement().unwrap().unwrap(), "changed");
    }
    #[test]
    fn a_second_repository_cannot_overwrite_an_unseen_commit() {
        let temp = TempDatabase::new();
        let mut first = SqliteRepository::open(&temp.path).unwrap();
        let mut stale = SqliteRepository::open(&temp.path).unwrap();
        let first_snapshot = Snapshot::demo("2026-09-24");
        first.save(&first_snapshot).unwrap();
        let stale_snapshot = Snapshot::demo("2026-09-25");
        assert!(stale.save(&stale_snapshot).is_err());
        assert_eq!(first.load().unwrap().unwrap().tasks, first_snapshot.tasks);
    }
    #[test]
    fn sqlite_backup_includes_committed_wal_state_and_has_private_permissions() {
        let temp = TempDatabase::new();
        let mut repo = SqliteRepository::open(&temp.path).unwrap();
        repo.connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        let snapshot = Snapshot::demo("2026-09-24");
        repo.save(&snapshot).unwrap();
        let backup_path = repo.backup().unwrap();
        let backup =
            Connection::open_with_flags(&backup_path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(verify_database(&backup).unwrap(), 2);
        assert_eq!(read_snapshot(&backup).unwrap().1.tasks, snapshot.tasks);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&backup_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn restore_is_backed_up_preserves_device_state_and_invalidates_old_editors() {
        let temp = TempDatabase::new();
        let mut repo = SqliteRepository::open(&temp.path).unwrap();
        let mut original = Snapshot::demo("2026-09-24");
        original.settings.theme = "dark".into();
        repo.save_placement(&original, "retained-screen-placement")
            .unwrap();
        let mut service = TaskService::new(Box::new(repo)).unwrap();
        let content = service.export_backup().unwrap();
        assert!(!content.contains("settings"));
        assert!(!content.contains("placement"));
        let mut backup: serde_json::Value = serde_json::from_str(&content).unwrap();
        backup["tasks"][0]["title"] = serde_json::json!("Restored synthetic content");
        let content = serde_json::to_string(&backup).unwrap();
        let preview = service.preview_restore(&content).unwrap();
        assert_eq!(preview.task_count, original.tasks.len());
        let restored = service.restore_backup(&content, original.revision).unwrap();
        assert_eq!(restored.snapshot.settings, original.settings);
        assert_eq!(
            service.repository.load_placement().unwrap().unwrap(),
            "retained-screen-placement"
        );
        assert!(restored.snapshot.revision > original.revision);
        assert!(restored
            .snapshot
            .tasks
            .iter()
            .all(|task| task.revision == restored.snapshot.revision));
        assert!(service
            .mutate(
                Action::UpdateTask {
                    id: original.tasks[0].id.clone(),
                    changes: serde_json::json!({"title":"stale draft"}),
                    expected_revision: original.tasks[0].revision
                },
                restored.snapshot.revision
            )
            .is_err());
        let safety = Connection::open_with_flags(
            restored.safety_backup_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        assert_eq!(read_snapshot(&safety).unwrap().1.tasks, original.tasks);
        assert_eq!(
            service.repository.load().unwrap().unwrap().tasks[0].title,
            "Restored synthetic content"
        );
    }
    #[test]
    fn restore_failure_after_backup_keeps_database_and_published_snapshot() {
        let temp = TempDatabase::new();
        let mut repo = SqliteRepository::open(&temp.path).unwrap();
        repo.save(&Snapshot::demo("2026-09-24")).unwrap();
        let mut service = TaskService::new(Box::new(repo)).unwrap();
        let content = service.export_backup().unwrap();
        let original = serde_json::to_value(&service.snapshot).unwrap();
        let mut writer = SqliteRepository::open(&temp.path).unwrap();
        let external = Snapshot::demo("2026-09-25");
        writer.save(&external).unwrap();
        assert!(service
            .restore_backup(&content, service.snapshot.revision)
            .is_err());
        assert_eq!(serde_json::to_value(&service.snapshot).unwrap(), original);
        assert_eq!(writer.load().unwrap().unwrap().tasks, external.tasks);
        assert_eq!(
            temp.backups().len(),
            1,
            "failed commit still retains the safety backup"
        );
    }
}
