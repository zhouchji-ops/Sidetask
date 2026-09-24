//! Offline recovery only: the caller must have no TaskService or SQLite write
//! connection, and must serialize recovery/exit under the single-instance gate.
//! A persisted intent blocks normal startup until every DB/sidecar move finishes.
use super::{
    configure, parent_directory, private_new_file, read_snapshot, sync_parent, verify_schema,
};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const DATABASE: &str = "sidetask.sqlite3";
const FILES: [&str; 4] = [
    DATABASE,
    "sidetask.sqlite3-wal",
    "sidetask.sqlite3-shm",
    "sidetask.sqlite3-journal",
];
const PENDING: &str = "sidetask-recovery-pending.json";
const EVIDENCE_PREFIX: &str = "sidetask-recovery-evidence-";
const MAX_CANDIDATE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_EVIDENCE_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCandidate {
    /// Opaque selection token: controlled filename plus the validated SHA-256.
    pub id: String,
    pub file_name: String,
    pub kind: String,
    pub schema_version: i64,
    pub task_count: usize,
    pub plan_count: usize,
    pub revision: u64,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryOutcome {
    pub preserved_directory: String,
    pub restart_required: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvidenceFile {
    name: String,
    size_bytes: u64,
    sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvidenceManifest {
    format_version: u32,
    created_at: String,
    files: Vec<EvidenceFile>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingRecovery {
    format_version: u32,
    evidence_directory: String,
}
struct Evidence {
    directory: PathBuf,
    manifest: EvidenceManifest,
    pending: PendingRecovery,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    Preserved,
    Staged,
    Marked,
    Detached,
    Replaced,
}

fn error(message: impl std::fmt::Display) -> String {
    format!("安全恢复未完成：{message}")
}
fn uuid_suffix(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .and_then(|id| {
            uuid::Uuid::parse_str(id)
                .ok()
                .map(|uuid| uuid.to_string() == id)
        })
        .unwrap_or(false)
}
fn candidate_kind(name: &str) -> Option<&'static str> {
    let name = name.strip_suffix(".sqlite3")?;
    if uuid_suffix(name, "sidetask-before-schema-2-") {
        Some("before-schema-2")
    } else if uuid_suffix(name, "sidetask-before-schema-3-") {
        Some("before-schema-3")
    } else if uuid_suffix(name, "sidetask-before-schema-4-") {
        Some("before-schema-4")
    } else if uuid_suffix(name, "sidetask-safety-backup-") {
        Some("safety-backup")
    } else {
        None
    }
}
fn digest_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn candidate_parts(id: &str) -> Result<(&str, &str), String> {
    let (name, digest) = id.split_once('#').ok_or("备份选择已失效，请重新扫描。")?;
    if candidate_kind(name).is_none() || !digest_valid(digest) {
        return Err("备份选择无效；不接受路径或外部文件。".into());
    }
    Ok((name, digest))
}
fn require_directory(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(error("数据或证据目录不是独立的普通目录。"));
    }
    Ok(())
}
fn regular_metadata(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(error)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(error("文件不是普通文件；不会读取链接、目录或设备。"));
    }
    Ok(metadata)
}
fn present(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(error(e)),
    }
}
fn private_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    let mut builder = fs::DirBuilder::new();
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(error)
}
fn hash_file(path: &Path) -> Result<(u64, String), String> {
    let before = regular_metadata(path)?;
    let mut file = File::open(path).map_err(error)?;
    let opened = file.metadata().map_err(error)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != opened.dev() || before.ino() != opened.ino() {
            return Err(error("读取时文件发生变化。"));
        }
    }
    let mut digest = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(error)?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > before.len() {
            return Err(error("读取期间文件增长，已停止读取。"));
        }
        digest.update(&buffer[..read]);
    }
    let after = file.metadata().map_err(error)?;
    if size != before.len()
        || size != opened.len()
        || size != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err(error("读取期间文件变化，请停止其他写入后重试。"));
    }
    Ok((size, format!("{:x}", digest.finalize())))
}
fn copy_checked(source: &Path, destination: &Path) -> Result<(u64, String), String> {
    let expected = hash_file(source)?;
    let mut input = File::open(source).map_err(error)?;
    let mut output = private_new_file(destination)?;
    let copied = std::io::copy(
        &mut (&mut input).take(expected.0.saturating_add(1)),
        &mut output,
    )
    .map_err(error)?;
    if copied != expected.0 {
        return Err(error("复制期间文件大小发生变化，已停止复制。"));
    }
    output.sync_all().map_err(error)?;
    drop(output);
    drop(input);
    if hash_file(destination)? != expected || hash_file(source)? != expected {
        return Err(error("文件复制校验失败，原数据未被移动。"));
    }
    Ok(expected)
}
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let mut file = private_new_file(path)?;
    file.write_all(&serde_json::to_vec(value).map_err(error)?)
        .map_err(error)?;
    file.sync_all().map_err(error)?;
    drop(file);
    sync_parent(path)
}
fn publish_marker(directory: &Path, pending: &PendingRecovery) -> Result<(), String> {
    // Publish only a fully written record. A killed process cannot leave a
    // half-JSON intent that would make an otherwise recoverable retry unreadable.
    let staged = directory.join(format!(
        "sidetask-recovery-intent-{}.tmp",
        uuid::Uuid::new_v4()
    ));
    write_json(&staged, pending)?;
    let result = fs::hard_link(&staged, directory.join(PENDING)).map_err(error);
    let _ = fs::remove_file(&staged);
    result?;
    sync_parent(&directory.join(PENDING))
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    if regular_metadata(path)?.len() > 16 * 1024 {
        return Err(error("恢复记录过大。"));
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(error)?
        .take(16 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() > 16 * 1024 {
        return Err(error("恢复记录过大。"));
    }
    serde_json::from_slice(&bytes).map_err(error)
}
fn immutable_connection(path: &Path) -> Result<Connection, String> {
    let absolute = fs::canonicalize(path).map_err(error)?;
    let text = absolute
        .to_str()
        .ok_or_else(|| error("备份路径无法编码。"))?;
    #[cfg(windows)]
    let text = {
        let value = text
            .strip_prefix(r"\\?\")
            .unwrap_or(text)
            .replace('\\', "/");
        if value.starts_with("UNC/") || value.starts_with("//") {
            return Err(error("此版本恢复只支持本机数据目录。"));
        }
        format!("/{value}")
    };
    let encoded = text
        .as_bytes()
        .iter()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b':' | b'-' | b'_' | b'.' | b'~' => {
                (*byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect::<String>();
    let connection = Connection::open_with_flags(
        format!("file:{encoded}?mode=ro&immutable=1"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(error)?;
    configure(&connection)?;
    Ok(connection)
}
fn inspect_candidate(directory: &Path, name: &str) -> Result<RecoveryCandidate, String> {
    let kind = candidate_kind(name).ok_or("备份文件名无效。")?;
    let path = directory.join(name);
    let metadata = regular_metadata(&path)?;
    if metadata.len() == 0 || metadata.len() > MAX_CANDIDATE_BYTES {
        return Err(error("备份文件大小超出有效范围。"));
    }
    for suffix in ["-wal", "-shm", "-journal"] {
        if present(&directory.join(format!("{name}{suffix}")))? {
            return Err(error("备份含附属日志，不能作为独立恢复副本。"));
        }
    }
    let fingerprint = hash_file(&path)?;
    let connection = immutable_connection(&path)?;
    let version = verify_schema(&connection)?;
    let (_, snapshot) = read_snapshot(&connection)?;
    drop(connection);
    if hash_file(&path)? != fingerprint {
        return Err(error("验证期间备份发生变化。"));
    }
    Ok(RecoveryCandidate {
        id: format!("{name}#{}", fingerprint.1),
        file_name: name.into(),
        kind: kind.into(),
        schema_version: version,
        task_count: snapshot.tasks.len(),
        plan_count: snapshot.plans.len(),
        revision: snapshot.revision,
        size_bytes: fingerprint.0,
        modified_at: metadata.modified().ok().map(|time| {
            chrono::DateTime::<chrono::Utc>::from(time)
                .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
        }),
    })
}
/// Read-only scan. Invalid names, links, unsupported/corrupt databases and
/// candidate sidecars are excluded. Returned metadata never contains task text.
pub fn list_candidates(directory: &Path) -> Result<Vec<RecoveryCandidate>, String> {
    require_directory(directory)?;
    let mut candidates = Vec::new();
    for entry in fs::read_dir(directory).map_err(error)? {
        let entry = entry.map_err(error)?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if candidate_kind(&name).is_some() {
            if let Ok(candidate) = inspect_candidate(directory, &name) {
                candidates.push(candidate);
            }
        }
    }
    candidates.sort_by(|a, b| {
        b.modified_at
            .cmp(&a.modified_at)
            .then(a.file_name.cmp(&b.file_name))
    });
    Ok(candidates)
}
/// Must run before Connection::open or creating an empty DB. A crash during the
/// multi-file replacement cannot silently boot a database with missing WAL.
pub(super) fn ensure_no_pending(database_path: &Path) -> Result<(), String> {
    if database_path == Path::new(":memory:") {
        return Ok(());
    }
    if present(&parent_directory(database_path).join(PENDING))? {
        return Err("上次数据库恢复尚未完成。原始数据证据已保留，请在恢复界面重新选择安全备份；当前不会打开或初始化任务库。".into());
    }
    Ok(())
}
fn database_files(path: &Path) -> Vec<PathBuf> {
    ["", "-wal", "-shm", "-journal"]
        .into_iter()
        .map(|suffix| {
            let mut name = path.as_os_str().to_os_string();
            name.push(suffix);
            PathBuf::from(name)
        })
        .collect()
}
pub(super) fn ensure_no_orphan_sidecars(path: &Path) -> Result<(), String> {
    for sidecar in database_files(path).iter().skip(1) {
        if present(sidecar)? {
            return Err(
                "主数据库缺失但附属日志仍存在。不会创建空库或修改日志，请先恢复已有数据。".into(),
            );
        }
    }
    Ok(())
}
/// Never let SQLite inspect an unverified live file: even a READ_ONLY open can
/// change SHM, and closing a READ_WRITE connection can checkpoint/delete WAL.
/// Inspect a private full copy with normal WAL/hot-journal handling instead of
/// immutable mode, which would silently ignore committed WAL records.
pub(super) fn verify_before_open(path: &Path) -> Result<(), String> {
    let files = database_files(path);
    let directory =
        parent_directory(path).join(format!("sidetask-startup-check-{}", uuid::Uuid::new_v4()));
    private_directory(&directory)?;
    let result = (|| {
        let mut records = Vec::new();
        let mut total = 0u64;
        for source in &files {
            if !present(source)? {
                records.push(None);
                continue;
            }
            total = total
                .checked_add(regular_metadata(source)?.len())
                .ok_or_else(|| error("数据库和日志大小无效。"))?;
            if total > MAX_EVIDENCE_BYTES {
                return Err(error("数据库与日志超过1GiB，启动检查未接触原文件。"));
            }
            let name = source.file_name().ok_or("数据路径无效。")?;
            records.push(Some(copy_checked(source, &directory.join(name))?));
        }
        let unchanged = || -> Result<(), String> {
            for (source, record) in files.iter().zip(&records) {
                match (present(source)?, record) {
                    (false, None) => {}
                    (true, Some(expected)) if &hash_file(source)? == expected => {}
                    _ => {
                        return Err(error(
                            "启动检查期间数据库或日志发生变化，请停止其他写入后重试。",
                        ))
                    }
                }
            }
            Ok(())
        };
        unchanged()?;
        let connection = Connection::open_with_flags(
            directory.join(path.file_name().ok_or("数据路径无效。")?),
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .map_err(error)?;
        configure(&connection)?;
        super::verify_database(&connection)?;
        drop(connection);
        unchanged()
    })();
    // This disposable directory contains only copies created by this call.
    // Original main/WAL/SHM/journal paths have never been opened by SQLite.
    let _ = fs::remove_dir_all(&directory);
    result
}
fn verify_evidence(evidence: &Evidence) -> Result<(), String> {
    require_directory(&evidence.directory)?;
    if evidence.manifest.format_version != 1
        || evidence.pending.format_version != 1
        || evidence.manifest.files.len() > FILES.len()
    {
        return Err(error("恢复证据格式不受支持。"));
    }
    let mut seen = std::collections::HashSet::new();
    let mut total = 0u64;
    for file in &evidence.manifest.files {
        if !FILES.contains(&file.name.as_str())
            || !seen.insert(&file.name)
            || !digest_valid(&file.sha256)
        {
            return Err(error("恢复证据含无效文件标识。"));
        }
        total = total
            .checked_add(file.size_bytes)
            .ok_or_else(|| error("恢复证据大小无效。"))?;
        if total > MAX_EVIDENCE_BYTES
            || regular_metadata(&evidence.directory.join(&file.name))?.len() != file.size_bytes
        {
            return Err(error("恢复证据不完整。"));
        }
        if hash_file(&evidence.directory.join(&file.name))?
            != (file.size_bytes, file.sha256.clone())
        {
            return Err(error("原始证据校验失败，未开始恢复。"));
        }
    }
    Ok(())
}
fn read_pending(directory: &Path) -> Result<Option<Evidence>, String> {
    let marker = directory.join(PENDING);
    if !present(&marker)? {
        return Ok(None);
    }
    let pending: PendingRecovery = read_json(&marker)?;
    if pending.format_version != 1 || !uuid_suffix(&pending.evidence_directory, EVIDENCE_PREFIX) {
        return Err(error("恢复标记无效；不会访问外部证据路径。"));
    }
    let evidence_directory = directory.join(&pending.evidence_directory);
    require_directory(&evidence_directory)?;
    let manifest = read_json(&evidence_directory.join("manifest.json"))?;
    let evidence = Evidence {
        directory: evidence_directory,
        manifest,
        pending,
    };
    verify_evidence(&evidence)?;
    Ok(Some(evidence))
}
fn preserve_originals(directory: &Path) -> Result<Evidence, String> {
    let name = format!("{EVIDENCE_PREFIX}{}", uuid::Uuid::new_v4());
    let destination = directory.join(&name);
    private_directory(&destination)?;
    let mut files = Vec::new();
    let mut total = 0u64;
    for name in FILES {
        let source = directory.join(name);
        if !present(&source)? {
            continue;
        }
        total = total
            .checked_add(regular_metadata(&source)?.len())
            .ok_or_else(|| error("原数据库大小无效。"))?;
        if total > MAX_EVIDENCE_BYTES {
            return Err(error(
                "原数据库与日志超过1GiB，请先做离线完整备份；未移动原文件。",
            ));
        }
        let (size_bytes, sha256) = copy_checked(&source, &destination.join(name))?;
        files.push(EvidenceFile {
            name: name.into(),
            size_bytes,
            sha256,
        });
    }
    let evidence = Evidence {
        directory: destination,
        manifest: EvidenceManifest {
            format_version: 1,
            created_at: chrono::Utc::now().to_rfc3339(),
            files,
        },
        pending: PendingRecovery {
            format_version: 1,
            evidence_directory: name,
        },
    };
    write_json(
        &evidence.directory.join("manifest.json"),
        &evidence.manifest,
    )?;
    sync_parent(&evidence.directory)?;
    verify_evidence(&evidence)?;
    verify_originals_unchanged(directory, &evidence)?;
    Ok(evidence)
}
fn verify_originals_unchanged(directory: &Path, evidence: &Evidence) -> Result<(), String> {
    for name in FILES {
        let record = evidence
            .manifest
            .files
            .iter()
            .find(|file| file.name == name);
        match (present(&directory.join(name))?, record) {
            (false, None) => {}
            (true, Some(file))
                if hash_file(&directory.join(name))? == (file.size_bytes, file.sha256.clone()) => {}
            _ => {
                return Err(error(
                    "原数据库或日志在准备期间发生变化，请停止其他进程后重新尝试。",
                ))
            }
        }
    }
    Ok(())
}
fn ensure_marker(directory: &Path, evidence: &Evidence) -> Result<(), String> {
    if let Some(existing) = read_pending(directory)? {
        if existing.pending.evidence_directory != evidence.pending.evidence_directory {
            return Err(error("已有另一恢复操作，未替换数据。"));
        }
        Ok(())
    } else {
        publish_marker(directory, &evidence.pending)
    }
}
fn detach_sidecars(directory: &Path, detached: &Path) -> Result<(), String> {
    for name in FILES.iter().skip(1) {
        let path = directory.join(name);
        if present(&path)? {
            regular_metadata(&path)?;
            fs::rename(&path, detached.join(name)).map_err(error)?;
        }
    }
    sync_parent(&directory.join(DATABASE))
}
fn rollback(directory: &Path, evidence: &Evidence) -> Result<(), String> {
    verify_evidence(evidence)?;
    ensure_marker(directory, evidence)?;
    for name in FILES {
        let live = directory.join(name);
        if let Some(record) = evidence
            .manifest
            .files
            .iter()
            .find(|file| file.name == name)
        {
            if present(&live)? {
                regular_metadata(&live)?;
            }
            let staged = directory.join(format!(
                "sidetask-recovery-rollback-{}",
                uuid::Uuid::new_v4()
            ));
            let copied = copy_checked(&evidence.directory.join(name), &staged)?;
            if copied != (record.size_bytes, record.sha256.clone()) {
                return Err(error("回滚副本校验失败。"));
            }
            fs::rename(&staged, &live).map_err(error)?;
        } else if present(&live)? {
            regular_metadata(&live)?;
            fs::rename(
                &live,
                evidence
                    .directory
                    .join(format!("unexpected-{}", uuid::Uuid::new_v4())),
            )
            .map_err(error)?;
        }
    }
    sync_parent(&directory.join(DATABASE))?;
    verify_originals_unchanged(directory, evidence)?;
    fs::remove_file(directory.join(PENDING)).map_err(error)?;
    sync_parent(&directory.join(PENDING))
}
fn recover_with_hook(
    directory: &Path,
    id: &str,
    mut hook: impl FnMut(Step) -> Result<(), String>,
) -> Result<RecoveryOutcome, String> {
    require_directory(directory)?;
    let (name, digest) = candidate_parts(id)?;
    let candidate = inspect_candidate(directory, name)?;
    if candidate.id != id {
        return Err(error("备份自预览后已改变，请重新扫描并确认。"));
    }
    let pending = read_pending(directory)?;
    let interrupted = pending.is_some();
    let evidence = match pending {
        Some(evidence) => evidence,
        None => preserve_originals(directory)?,
    };
    hook(Step::Preserved)?;
    let staged = directory.join(format!(
        "sidetask-recovery-stage-{}.sqlite3",
        uuid::Uuid::new_v4()
    ));
    let prepare = (|| {
        let copied = copy_checked(&directory.join(name), &staged)?;
        if copied.1 != digest {
            return Err(error("备份在复制期间发生变化。"));
        }
        let connection = immutable_connection(&staged)?;
        verify_schema(&connection)?;
        read_snapshot(&connection)?;
        drop(connection);
        hook(Step::Staged)?;
        if !interrupted {
            verify_originals_unchanged(directory, &evidence)?;
        }
        let detached = evidence
            .directory
            .join(format!("detached-{}", uuid::Uuid::new_v4()));
        private_directory(&detached)?;
        ensure_marker(directory, &evidence)?;
        Ok(detached)
    })();
    let detached = match prepare {
        Ok(path) => path,
        Err(reason) => {
            let _ = fs::remove_file(&staged);
            return Err(format!(
                "{reason}；本次未移动数据文件，证据副本：{}",
                evidence.directory.display()
            ));
        }
    };
    let replace: Result<(), String> = (|| {
        hook(Step::Marked)?;
        detach_sidecars(directory, &detached)?;
        hook(Step::Detached)?;
        if present(&directory.join(DATABASE))? {
            regular_metadata(&directory.join(DATABASE))?;
        }
        // Both files are in the same directory. std::fs::rename replaces the
        // destination atomically on Unix and uses the platform replacement API
        // on Windows; it never first deletes the only main database.
        fs::rename(&staged, directory.join(DATABASE)).map_err(error)?;
        hook(Step::Replaced)?;
        sync_parent(&directory.join(DATABASE))?;
        fs::remove_file(directory.join(PENDING)).map_err(error)?;
        sync_parent(&directory.join(PENDING))?;
        Ok(())
    })();
    if let Err(reason) = replace {
        let _ = fs::remove_file(&staged);
        return match rollback(directory, &evidence) {
            Ok(()) => Err(format!(
                "{reason}；原数据库及日志已回滚，原始证据：{}",
                evidence.directory.display()
            )),
            Err(rollback_error) => {
                let marker_retained = ensure_marker(directory, &evidence).is_ok()
                    || present(&directory.join(PENDING)).unwrap_or(false);
                let state = if marker_retained {
                    "恢复标记保留，正常启动继续暂停。"
                } else {
                    "操作系统也拒绝保存恢复标记，请保持应用退出并使用原始证据进行离线恢复。"
                };
                Err(format!(
                    "{reason}；回滚仍遇到错误：{rollback_error}。原始证据保留在 {}；{state}",
                    evidence.directory.display()
                ))
            }
        };
    }
    Ok(RecoveryOutcome {
        preserved_directory: evidence.directory.to_string_lossy().into_owned(),
        restart_required: true,
    })
}
/// Called only after explicit confirmation in startup recovery mode. No paths
/// are accepted from the UI. The backup is copied, never consumed; restart is
/// required so no window can retain a stale pre-recovery Snapshot.
pub fn recover_from_backup(directory: &Path, id: &str) -> Result<RecoveryOutcome, String> {
    recover_with_hook(directory, id, |_| Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        domain::Snapshot,
        infrastructure::{Repository, SqliteRepository},
    };
    use std::collections::BTreeMap;
    struct Temp {
        root: PathBuf,
    }
    impl Temp {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("sidetask-recovery-test-{}", uuid::Uuid::new_v4()));
            private_directory(&root).unwrap();
            Self { root }
        }
        fn valid_backup(&self) -> (PathBuf, Snapshot) {
            let mut repo = SqliteRepository::open(&self.root.join(DATABASE)).unwrap();
            let mut snapshot = Snapshot::demo("2026-09-24");
            snapshot.tasks[0].title =
                "Private synthetic text must not appear in recovery metadata".into();
            repo.save(&snapshot).unwrap();
            let path = repo.backup().unwrap();
            drop(repo);
            (path, snapshot)
        }
        fn corrupt(&self) {
            fs::write(self.root.join(DATABASE), b"synthetic damaged sqlite header").unwrap();
            fs::write(self.root.join(FILES[1]), b"synthetic WAL evidence").unwrap();
            fs::write(self.root.join(FILES[2]), b"synthetic SHM evidence").unwrap();
            fs::write(
                self.root.join(FILES[3]),
                b"synthetic rollback journal evidence",
            )
            .unwrap();
        }
        fn originals(&self) -> BTreeMap<String, Vec<u8>> {
            FILES
                .iter()
                .filter_map(|name| {
                    fs::read(self.root.join(name))
                        .ok()
                        .map(|bytes| ((*name).into(), bytes))
                })
                .collect()
        }
        fn token(&self) -> String {
            list_candidates(&self.root).unwrap().remove(0).id
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
    #[test]
    fn scan_is_read_only_metadata_only_and_excludes_bad_inputs() {
        let temp = Temp::new();
        let (backup, snapshot) = temp.valid_backup();
        temp.corrupt();
        let candidate_name = backup.file_name().unwrap().to_str().unwrap();
        let original = temp.originals();
        let backup_before = fs::read(&backup).unwrap();
        fs::write(
            temp.root.join(format!(
                "sidetask-safety-backup-{}.sqlite3",
                uuid::Uuid::new_v4()
            )),
            b"{\"schemaVersion\":1}",
        )
        .unwrap();
        fs::write(temp.root.join("arbitrary.sqlite3"), &backup_before).unwrap();
        fs::create_dir(temp.root.join(format!(
            "sidetask-safety-backup-{}.sqlite3",
            uuid::Uuid::new_v4()
        )))
        .unwrap();
        let entries_before = fs::read_dir(&temp.root).unwrap().count();
        let candidates = list_candidates(&temp.root).unwrap();
        assert_eq!(candidates.len(), 1);
        let candidate = &candidates[0];
        assert_eq!(candidate.file_name, candidate_name);
        assert_eq!(candidate.schema_version, super::super::SCHEMA_VERSION);
        assert_eq!(candidate.kind, "safety-backup");
        assert_eq!(candidate.task_count, snapshot.tasks.len());
        assert_eq!(candidate.plan_count, snapshot.plans.len());
        assert_eq!(candidate.revision, snapshot.revision);
        assert!(candidate
            .modified_at
            .as_ref()
            .is_some_and(|date| chrono::DateTime::parse_from_rfc3339(date).is_ok()));
        let metadata = serde_json::to_string(&candidates).unwrap();
        assert!(!metadata.contains(&snapshot.tasks[0].title));
        assert!(!metadata.contains("notes"));
        assert_eq!(temp.originals(), original);
        assert_eq!(fs::read(&backup).unwrap(), backup_before);
        assert_eq!(
            fs::read_dir(&temp.root).unwrap().count(),
            entries_before,
            "immutable inspection must not create WAL/SHM sidecars"
        );
    }
    #[test]
    fn restore_copies_backup_and_preserves_all_original_files_before_replacement() {
        let temp = Temp::new();
        let (backup, snapshot) = temp.valid_backup();
        temp.corrupt();
        let originals = temp.originals();
        let backup_before = fs::read(&backup).unwrap();
        let token = temp.token();
        let outcome = recover_from_backup(&temp.root, &token).unwrap();
        assert!(outcome.restart_required);
        let evidence = PathBuf::from(outcome.preserved_directory);
        assert!(evidence.starts_with(&temp.root));
        for (name, bytes) in &originals {
            assert_eq!(&fs::read(evidence.join(name)).unwrap(), bytes);
        }
        assert_eq!(
            fs::read(&backup).unwrap(),
            backup_before,
            "recovery cannot consume or rewrite the selected safety backup"
        );
        assert!(!temp.root.join(PENDING).exists());
        for name in FILES.iter().skip(1) {
            assert!(!temp.root.join(name).exists());
        }
        let repo = SqliteRepository::open(&temp.root.join(DATABASE)).unwrap();
        assert_eq!(repo.load().unwrap().unwrap().tasks, snapshot.tasks);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&evidence).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(evidence.join(DATABASE))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn errors_at_each_switch_stage_roll_back_original_database_and_sidecars() {
        for fail_at in [Step::Marked, Step::Detached, Step::Replaced] {
            let temp = Temp::new();
            let (backup, _) = temp.valid_backup();
            temp.corrupt();
            let original = temp.originals();
            let token = temp.token();
            let backup_before = fs::read(&backup).unwrap();
            let result = recover_with_hook(&temp.root, &token, |step| {
                if step == fail_at {
                    Err("injected I/O failure".into())
                } else {
                    Ok(())
                }
            });
            assert!(result.unwrap_err().contains("已回滚"), "{fail_at:?}");
            assert_eq!(temp.originals(), original, "{fail_at:?}");
            assert!(!temp.root.join(PENDING).exists());
            assert_eq!(fs::read(&backup).unwrap(), backup_before);
            assert!(
                recover_from_backup(&temp.root, &token).is_ok(),
                "rollback must leave a retryable recovery"
            );
        }
    }
    #[test]
    fn interrupted_switch_blocks_startup_and_retry_keeps_the_original_evidence() {
        for interrupted_at in [Step::Marked, Step::Detached, Step::Replaced] {
            let temp = Temp::new();
            temp.valid_backup();
            temp.corrupt();
            let original = temp.originals();
            let token = temp.token();
            let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = recover_with_hook(&temp.root, &token, |step| {
                    assert_ne!(step, interrupted_at, "simulate process interruption");
                    Ok(())
                });
            }));
            assert!(interrupted.is_err());
            assert!(temp.root.join(PENDING).exists());
            assert!(SqliteRepository::open(&temp.root.join(DATABASE)).is_err());
            let pending = read_pending(&temp.root).unwrap().unwrap();
            let first_evidence = pending.directory.clone();
            for (name, bytes) in &original {
                assert_eq!(&fs::read(first_evidence.join(name)).unwrap(), bytes);
            }
            let outcome = recover_from_backup(&temp.root, &token).unwrap();
            assert_eq!(PathBuf::from(outcome.preserved_directory), first_evidence);
            for (name, bytes) in &original {
                assert_eq!(&fs::read(first_evidence.join(name)).unwrap(), bytes);
            }
            assert!(SqliteRepository::open(&temp.root.join(DATABASE)).is_ok());
        }
    }
    #[test]
    fn marker_prevents_implicit_empty_initialization_and_untrusted_marker_paths() {
        let temp = Temp::new();
        let marker = temp.root.join(PENDING);
        fs::write(&marker, b"unfinished partial marker").unwrap();
        assert!(SqliteRepository::open(&temp.root.join(DATABASE)).is_err());
        assert!(!temp.root.join(DATABASE).exists());
        fs::write(
            &marker,
            br#"{"formatVersion":1,"evidenceDirectory":"../../outside"}"#,
        )
        .unwrap();
        assert!(read_pending(&temp.root).is_err());
        assert!(!temp.root.join(DATABASE).exists());
    }
    #[test]
    fn path_escape_stale_tokens_and_backup_sidecars_never_replace_originals() {
        let temp = Temp::new();
        let (backup, _) = temp.valid_backup();
        temp.corrupt();
        let original = temp.originals();
        let token = temp.token();
        for id in [
            "../sidetask.sqlite3",
            "/tmp/sidetask.sqlite3",
            "sidetask.sqlite3",
            "",
            "sidetask-safety-backup-invalid.sqlite3#1234",
        ] {
            assert!(recover_from_backup(&temp.root, id).is_err());
            assert_eq!(temp.originals(), original);
        }
        let bytes = fs::read(&backup).unwrap();
        fs::write(&backup, b"modified after preview").unwrap();
        assert!(recover_from_backup(&temp.root, &token).is_err());
        assert_eq!(temp.originals(), original);
        fs::write(&backup, &bytes).unwrap();
        fs::write(
            PathBuf::from(format!("{}-wal", backup.display())),
            b"untrusted sidecar",
        )
        .unwrap();
        assert!(list_candidates(&temp.root).unwrap().is_empty());
        assert!(recover_from_backup(&temp.root, &token).is_err());
        assert_eq!(temp.originals(), original);
    }
    #[test]
    fn valid_but_changed_candidate_requires_a_new_confirmation_token() {
        let temp = Temp::new();
        let (backup, _) = temp.valid_backup();
        let old_token = temp.token();
        let connection = Connection::open(&backup).unwrap();
        connection
            .execute(
                "UPDATE app_state SET value=json_set(value,'$.revision',42) WHERE key='snapshot'",
                [],
            )
            .unwrap();
        drop(connection);
        temp.corrupt();
        let original = temp.originals();
        assert!(recover_from_backup(&temp.root, &old_token)
            .unwrap_err()
            .contains("预览后已改变"));
        assert_eq!(temp.originals(), original);
        let new_token = temp.token();
        assert_ne!(new_token, old_token);
        assert!(recover_from_backup(&temp.root, &new_token).is_ok());
    }
    #[test]
    fn evidence_tampering_after_interruption_is_rejected_without_further_moves() {
        let temp = Temp::new();
        temp.valid_backup();
        temp.corrupt();
        let token = temp.token();
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = recover_with_hook(&temp.root, &token, |step| {
                assert_ne!(step, Step::Detached);
                Ok(())
            });
        }));
        let pending = read_pending(&temp.root).unwrap().unwrap();
        fs::write(
            pending.directory.join(DATABASE),
            b"tampered original evidence",
        )
        .unwrap();
        let before = temp.originals();
        assert!(recover_from_backup(&temp.root, &token).is_err());
        assert_eq!(temp.originals(), before);
        assert!(temp.root.join(PENDING).exists());
    }
    #[test]
    fn originals_changing_during_staging_are_not_overwritten() {
        let temp = Temp::new();
        temp.valid_backup();
        temp.corrupt();
        let token = temp.token();
        let error = recover_with_hook(&temp.root, &token, |step| {
            if step == Step::Staged {
                fs::write(temp.root.join(FILES[1]), b"external newer WAL").unwrap();
            }
            Ok(())
        })
        .unwrap_err();
        assert!(error.contains("发生变化"));
        assert_eq!(
            fs::read(temp.root.join(FILES[1])).unwrap(),
            b"external newer WAL"
        );
        assert!(!temp.root.join(PENDING).exists());
    }
    #[cfg(unix)]
    #[test]
    fn symbolic_links_are_not_candidates_or_original_evidence() {
        use std::os::unix::fs::symlink;
        let temp = Temp::new();
        let (backup, _) = temp.valid_backup();
        let alias = temp.root.join(format!(
            "sidetask-safety-backup-{}.sqlite3",
            uuid::Uuid::new_v4()
        ));
        symlink(&backup, &alias).unwrap();
        assert_eq!(list_candidates(&temp.root).unwrap().len(), 1);
        temp.corrupt();
        let token = temp.token();
        fs::remove_file(temp.root.join(FILES[1])).unwrap();
        symlink(&backup, temp.root.join(FILES[1])).unwrap();
        let source = fs::read(&backup).unwrap();
        assert!(recover_from_backup(&temp.root, &token).is_err());
        assert_eq!(fs::read(&backup).unwrap(), source);
    }
    #[test]
    fn marker_publication_never_clobbers_existing_intent() {
        let temp = Temp::new();
        let first = PendingRecovery {
            format_version: 1,
            evidence_directory: format!("{EVIDENCE_PREFIX}{}", uuid::Uuid::new_v4()),
        };
        let second = PendingRecovery {
            format_version: 1,
            evidence_directory: format!("{EVIDENCE_PREFIX}{}", uuid::Uuid::new_v4()),
        };
        publish_marker(&temp.root, &first).unwrap();
        assert!(publish_marker(&temp.root, &second).is_err());
        let stored: PendingRecovery = read_json(&temp.root.join(PENDING)).unwrap();
        assert_eq!(stored.evidence_directory, first.evidence_directory);
    }
    #[test]
    fn rollback_io_failure_retains_intent_and_original_evidence_for_retry() {
        let temp = Temp::new();
        temp.valid_backup();
        temp.corrupt();
        let original = temp.originals();
        let token = temp.token();
        let result = recover_with_hook(&temp.root, &token, |step| {
            if step == Step::Detached {
                fs::remove_file(temp.root.join(DATABASE)).unwrap();
                fs::create_dir(temp.root.join(DATABASE)).unwrap();
            }
            Ok(())
        });
        assert!(result.unwrap_err().contains("回滚仍遇到错误"));
        let pending = read_pending(&temp.root).unwrap().unwrap();
        for (name, bytes) in &original {
            assert_eq!(&fs::read(pending.directory.join(name)).unwrap(), bytes);
        }
        assert!(SqliteRepository::open(&temp.root.join(DATABASE)).is_err());
        fs::remove_dir(temp.root.join(DATABASE)).unwrap();
        let outcome = recover_from_backup(&temp.root, &token).unwrap();
        assert_eq!(
            PathBuf::from(outcome.preserved_directory),
            pending.directory
        );
        assert!(!temp.root.join(PENDING).exists());
    }
    #[test]
    fn unicode_and_uri_metacharacters_in_data_directory_are_supported() {
        let outer = Temp::new();
        let temp = Temp {
            root: outer.root.join("中文 # % space"),
        };
        private_directory(&temp.root).unwrap();
        temp.valid_backup();
        temp.corrupt();
        let token = temp.token();
        recover_from_backup(&temp.root, &token).unwrap();
        assert!(SqliteRepository::open(&temp.root.join(DATABASE)).is_ok());
    }
    #[test]
    fn failed_startup_keeps_corrupt_main_and_all_sidecar_bytes_untouched() {
        let temp = Temp::new();
        temp.valid_backup();
        temp.corrupt();
        let original = temp.originals();
        assert!(SqliteRepository::open(&temp.root.join(DATABASE)).is_err());
        assert_eq!(temp.originals(), original);
        assert!(!temp.root.join(PENDING).exists());
    }
    #[test]
    fn orphan_sidecars_never_trigger_empty_initialization() {
        for name in FILES.iter().skip(1) {
            let temp = Temp::new();
            let bytes = b"synthetic orphaned evidence";
            fs::write(temp.root.join(name), bytes).unwrap();
            assert!(SqliteRepository::open(&temp.root.join(DATABASE)).is_err());
            assert!(!temp.root.join(DATABASE).exists());
            assert_eq!(fs::read(temp.root.join(name)).unwrap(), bytes);
        }
    }
    fn wal_fixture(target: &Temp, valid: bool) -> Snapshot {
        // Copy while the synthetic writer remains open, then close only the
        // writer's separate source directory. The target models a crashed app:
        // committed WAL is present and has never been checkpointed on target.
        let source = Temp::new();
        let repo = SqliteRepository::open(&source.root.join(DATABASE)).unwrap();
        drop(repo);
        let connection = Connection::open(source.root.join(DATABASE)).unwrap();
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        let mut snapshot = Snapshot::demo("2026-09-24");
        snapshot.revision = 73;
        let raw = if valid {
            serde_json::to_string(&snapshot).unwrap()
        } else {
            "{invalid snapshot in committed WAL".into()
        };
        connection
            .execute("UPDATE app_state SET value=?1 WHERE key='snapshot'", [raw])
            .unwrap();
        for name in FILES {
            let path = source.root.join(name);
            if path.exists() {
                fs::copy(path, target.root.join(name)).unwrap();
            }
        }
        assert!(fs::metadata(target.root.join(FILES[1])).unwrap().len() > 32);
        drop(connection);
        snapshot
    }
    #[test]
    fn invalid_committed_wal_is_rejected_without_checkpointing_any_original_file() {
        let temp = Temp::new();
        wal_fixture(&temp, false);
        let original = temp.originals();
        assert_eq!(original.len(), 3);
        // The checkpointed main is valid and empty: immutable-only inspection
        // would accept it and miss the invalid committed snapshot in WAL.
        let main = immutable_connection(&temp.root.join(DATABASE)).unwrap();
        assert!(read_snapshot(&main).unwrap().1.tasks.is_empty());
        drop(main);
        assert!(SqliteRepository::open(&temp.root.join(DATABASE)).is_err());
        assert_eq!(temp.originals(), original);
        assert!(list_candidates(&temp.root).unwrap().is_empty());
        assert_eq!(temp.originals(), original);
    }
    #[test]
    fn valid_committed_wal_is_included_in_preflight_and_normal_startup() {
        let temp = Temp::new();
        let expected = wal_fixture(&temp, true);
        let original = temp.originals();
        verify_before_open(&temp.root.join(DATABASE)).unwrap();
        assert_eq!(temp.originals(), original);
        let repo = SqliteRepository::open(&temp.root.join(DATABASE)).unwrap();
        let snapshot = repo.load().unwrap().unwrap();
        assert_eq!(snapshot.tasks, expected.tasks);
        assert_eq!(snapshot.revision, 73);
    }
    #[test]
    fn legacy_backup_is_not_upgraded_during_scan_or_recovery_copy() {
        for (version, kind) in [
            (1, "before-schema-2"),
            (2, "before-schema-3"),
            (3, "before-schema-4"),
        ] {
            let temp = Temp::new();
            let (original_backup, _) = temp.valid_backup();
            let backup = temp
                .root
                .join(format!("sidetask-{kind}-{}.sqlite3", uuid::Uuid::new_v4()));
            fs::rename(original_backup, &backup).unwrap();
            let connection = Connection::open(&backup).unwrap();
            connection
                .pragma_update(None, "user_version", version)
                .unwrap();
            connection
                .pragma_update(
                    None,
                    "application_id",
                    if version == 1 {
                        0
                    } else {
                        super::super::APPLICATION_ID
                    },
                )
                .unwrap();
            drop(connection);
            let bytes = fs::read(&backup).unwrap();
            temp.corrupt();
            let token = temp.token();
            let candidates = list_candidates(&temp.root).unwrap();
            assert_eq!(candidates[0].schema_version, version);
            assert_eq!(candidates[0].kind, kind);
            recover_from_backup(&temp.root, &token).unwrap();
            assert_eq!(fs::read(&backup).unwrap(), bytes);
            assert_eq!(fs::read(temp.root.join(DATABASE)).unwrap(), bytes);
            let repo = SqliteRepository::open(&temp.root.join(DATABASE)).unwrap();
            assert_eq!(
                super::super::verify_database(&repo.connection).unwrap(),
                super::super::SCHEMA_VERSION
            );
            assert_eq!(fs::read(&backup).unwrap(), bytes);
        }
    }
}
