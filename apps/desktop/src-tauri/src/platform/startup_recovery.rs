//! Startup recovery has no task service and never fabricates an empty dataset.
//! Only this coordinator may enter the offline file replacement operation.
use crate::infrastructure::recovery::{self, RecoveryCandidate, RecoveryOutcome};
use serde::Serialize;
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    path::PathBuf,
    sync::Mutex,
};
use tauri::Manager;

#[derive(Default, Debug, PartialEq)]
enum Phase {
    #[default]
    Idle,
    Recovering,
    Recovered,
    Exiting,
}

#[derive(Default)]
struct RecoveryGate {
    phase: Phase,
    exit_requested: bool,
}

impl RecoveryGate {
    fn begin(&mut self) -> Result<(), String> {
        if self.phase != Phase::Idle {
            return Err("恢复正在进行、已完成或应用正在退出，不能重复恢复。".into());
        }
        self.phase = Phase::Recovering;
        Ok(())
    }

    fn finish(&mut self, success: bool) -> bool {
        self.phase = if self.exit_requested {
            Phase::Exiting
        } else if success {
            Phase::Recovered
        } else {
            Phase::Idle
        };
        self.exit_requested
    }

    fn request_exit(&mut self) -> bool {
        self.exit_requested = true;
        if self.phase == Phase::Recovering {
            false
        } else {
            self.phase = Phase::Exiting;
            true
        }
    }

    fn restart(&mut self) -> Result<(), String> {
        if self.phase != Phase::Recovered {
            return Err("尚未完成数据库恢复，不能从恢复页面重新启动。".into());
        }
        self.phase = Phase::Exiting;
        Ok(())
    }
}

struct RecoveryRuntime {
    gate: RecoveryGate,
    candidates: Vec<RecoveryCandidate>,
    scan_error: Option<String>,
    operation_error: Option<String>,
    recovered: Option<RecoveryOutcome>,
}

pub struct RecoveryState {
    data_dir: PathBuf,
    startup_error: String,
    runtime: Mutex<RecoveryRuntime>,
}

struct CompletedRecovery {
    result: Result<RecoveryOutcome, String>,
    exit_requested: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryStatus {
    pub error: String,
    pub data_directory: String,
    pub candidates: Vec<RecoveryCandidate>,
    pub scan_error: Option<String>,
    pub busy: bool,
    pub recovered: Option<RecoveryOutcome>,
}

impl RecoveryState {
    pub fn new(data_dir: PathBuf, startup_error: String) -> Self {
        Self {
            data_dir,
            startup_error,
            runtime: Mutex::new(RecoveryRuntime {
                gate: RecoveryGate::default(),
                candidates: Vec::new(),
                scan_error: None,
                operation_error: None,
                recovered: None,
            }),
        }
    }

    fn status(&self) -> Result<RecoveryStatus, String> {
        let should_scan = self
            .runtime
            .lock()
            .map_err(|_| "恢复服务暂不可用。")?
            .gate
            .phase
            == Phase::Idle;
        if should_scan {
            // Read-only scanning never holds the short lifecycle lock while
            // doing disk I/O, so native Quit can be handled without blocking UI.
            let scan = recovery::list_candidates(&self.data_dir);
            let mut runtime = self.runtime.lock().map_err(|_| "恢复服务暂不可用。")?;
            if runtime.gate.phase == Phase::Idle {
                match scan {
                    Ok(candidates) => {
                        runtime.candidates = candidates;
                        runtime.scan_error = None;
                    }
                    Err(error) => {
                        runtime.candidates.clear();
                        runtime.scan_error = Some(error);
                    }
                }
            }
        }
        let runtime = self.runtime.lock().map_err(|_| "恢复服务暂不可用。")?;
        Ok(RecoveryStatus {
            error: runtime
                .operation_error
                .clone()
                .unwrap_or_else(|| self.startup_error.clone()),
            data_directory: self.data_dir.to_string_lossy().into_owned(),
            candidates: runtime.candidates.clone(),
            scan_error: runtime.scan_error.clone(),
            busy: runtime.gate.phase == Phase::Recovering,
            recovered: runtime.recovered.clone(),
        })
    }

    pub fn is_exit_authorized(&self) -> bool {
        self.runtime
            .lock()
            .map(|r| r.gate.phase == Phase::Exiting)
            .unwrap_or(false)
    }

    pub fn request_exit(&self) -> Result<bool, String> {
        Ok(self
            .runtime
            .lock()
            .map_err(|_| "恢复服务暂不可用。")?
            .gate
            .request_exit())
    }

    fn recover(&self, candidate_id: &str) -> Result<CompletedRecovery, String> {
        {
            let mut runtime = self.runtime.lock().map_err(|_| "恢复服务暂不可用。")?;
            if !runtime
                .candidates
                .iter()
                .any(|candidate| candidate.id == candidate_id)
            {
                return Err("此备份不在已列出的恢复候选中，请刷新列表后选择。".into());
            }
            runtime.gate.begin()?;
            runtime.operation_error = None;
        }
        // A filesystem error or unexpected panic cannot strand the application
        // in a permanently busy state with every exit request blocked.
        let result = catch_unwind(AssertUnwindSafe(|| {
            recovery::recover_from_backup(&self.data_dir, candidate_id)
        }))
        .unwrap_or_else(|_| Err("恢复操作异常中止；原数据与保留副本需要检查，未加载任务。".into()));
        let mut runtime = self.runtime.lock().map_err(|_| "恢复服务暂不可用。")?;
        match &result {
            Ok(outcome) => runtime.recovered = Some(outcome.clone()),
            Err(error) => runtime.operation_error = Some(error.clone()),
        }
        let exit_requested = runtime.gate.finish(result.is_ok());
        Ok(CompletedRecovery {
            result,
            exit_requested,
        })
    }
}

pub fn status(app: &tauri::AppHandle) -> Result<Option<RecoveryStatus>, String> {
    app.try_state::<RecoveryState>()
        .map(|state| state.status())
        .transpose()
}

pub fn recover(app: &tauri::AppHandle, candidate_id: &str) -> Result<RecoveryOutcome, String> {
    if app.try_state::<crate::AppState>().is_some() {
        return Err("任务服务正在运行；请使用设置中的正常备份恢复入口。".into());
    }
    let state = app
        .try_state::<RecoveryState>()
        .ok_or("应用不在启动恢复模式。")?;
    let completed = state.recover(candidate_id)?;
    if completed.exit_requested {
        app.exit(0);
    }
    completed.result
}

pub fn restart(app: &tauri::AppHandle) -> Result<(), String> {
    if app.try_state::<crate::AppState>().is_some() {
        return Err("任务服务正在运行，不使用启动恢复的重启入口。".into());
    }
    let state = app
        .try_state::<RecoveryState>()
        .ok_or("应用不在启动恢复模式。")?;
    state
        .runtime
        .lock()
        .map_err(|_| "恢复服务暂不可用。")?
        .gate
        .restart()?;
    // Called by an async command, after replacement and every lifecycle guard
    // has been released. The new process must open the real database normally.
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_waits_until_recovery_finishes_in_both_success_and_failure_paths() {
        for success in [true, false] {
            let mut gate = RecoveryGate::default();
            gate.begin().unwrap();
            assert!(!gate.request_exit());
            assert_eq!(gate.phase, Phase::Recovering);
            assert!(gate.begin().is_err());
            assert!(gate.restart().is_err());
            assert!(gate.finish(success));
            assert_eq!(gate.phase, Phase::Exiting);
            assert!(gate.begin().is_err());
        }
    }

    #[test]
    fn idle_recovery_can_exit_and_only_success_can_restart() {
        let mut exiting = RecoveryGate::default();
        assert!(exiting.request_exit());
        assert!(exiting.begin().is_err());
        let mut gate = RecoveryGate::default();
        assert!(gate.restart().is_err());
        gate.begin().unwrap();
        assert!(!gate.finish(false));
        assert_eq!(gate.phase, Phase::Idle);
        gate.begin().unwrap();
        assert!(!gate.finish(true));
        assert_eq!(gate.phase, Phase::Recovered);
        assert!(gate.begin().is_err());
        gate.restart().unwrap();
        assert_eq!(gate.phase, Phase::Exiting);
    }

    #[test]
    fn an_unlisted_candidate_cannot_start_recovery_or_modify_the_database() {
        let directory =
            std::env::temp_dir().join(format!("sidetask-recovery-gate-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let database = directory.join("sidetask.sqlite3");
        let original = b"synthetic damaged database";
        std::fs::write(&database, original).unwrap();
        let state = RecoveryState::new(directory.clone(), "database damaged".into());
        assert!(state.recover("../unlisted.sqlite3").is_err());
        assert_eq!(state.runtime.lock().unwrap().gate.phase, Phase::Idle);
        assert_eq!(std::fs::read(database).unwrap(), original);
        assert!(state.request_exit().unwrap());
        assert!(state.is_exit_authorized());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
