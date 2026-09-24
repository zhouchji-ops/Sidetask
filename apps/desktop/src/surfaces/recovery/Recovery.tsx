import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Brand } from '../../components/TaskUI';
import '../../styles/recovery.css';

export interface RecoveryCandidate {
  id: string;
  fileName: string;
  kind: string;
  schemaVersion: number;
  taskCount: number;
  planCount: number;
  revision: number;
  sizeBytes: number;
  modifiedAt: string | null;
}
interface RecoveryOutcome { preservedDirectory: string; restartRequired: true }
export interface RecoveryStatus {
  dataDirectory: string;
  error: string;
  candidates: RecoveryCandidate[];
  scanError: string | null;
  busy: boolean;
  recovered: RecoveryOutcome | null;
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function backupDate(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return '备份时间未知';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

// A failed boot query must never mount the task store and pretend the database
// is empty. Recovery is a separate surface with no task mutation subscriptions.
export function StartupGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RecoveryStatus | null | undefined>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError('');
    void invoke<RecoveryStatus | null>('get_startup_recovery').then(value => {
      if (!cancelled) setStatus(value);
    }).catch(reason => { if (!cancelled) setError(message(reason)); });
    return () => { cancelled = true; };
  }, [attempt]);
  if (status === null) return children;
  if (status) return <Recovery initialStatus={status} />;
  return <main className="recovery-shell"><div className="recovery-content"><Brand />
    <h1>{error ? '暂时无法读取启动状态' : '正在检查本地数据'}</h1>
    {error ? <><p role="alert" className="recovery-error">{error}</p><p>任务尚未加载。请重试检查；仍无法打开时，可以退出后重新启动侧笺。</p><button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重试检查</button></> : <p role="status">检查完成后将打开任务或恢复页面。</p>}
  </div></main>;
}

function Recovery({ initialStatus }: { initialStatus: RecoveryStatus }) {
  const [status, setStatus] = useState(initialStatus);
  const [selectedId, setSelectedId] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const outcomeHeading = useRef<HTMLHeadingElement>(null);
  const selected = status.candidates.find(candidate => candidate.id === selectedId);
  const busy = working || status.busy;
  async function refreshStatus() {
    const next = await invoke<RecoveryStatus | null>('get_startup_recovery');
    if (!next) throw new Error('恢复状态已改变，请退出后重新启动侧笺。');
    setStatus(next);
    setSelectedId(current => next.candidates.some(candidate => candidate.id === current) ? current : '');
    if (!next.candidates.some(candidate => candidate.id === selectedId)) setConfirm(false);
    if (next.recovered) setError('');
    return next;
  }
  useEffect(() => {
    if (!status.busy || working) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void invoke<RecoveryStatus | null>('get_startup_recovery').then(next => {
        if (cancelled) return;
        if (next) setStatus(next);
        else setError('恢复状态已改变，请退出后重新启动侧笺。');
      }).catch(reason => { if (!cancelled) setError(message(reason)); });
    }, 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [status, working]);
  useEffect(() => { if (status.recovered) outcomeHeading.current?.focus(); }, [status.recovered]);
  async function scan() {
    if (inFlight.current) return;
    inFlight.current = true; setWorking(true); setError(''); setConfirm(false);
    try { await refreshStatus(); } catch (reason) { setError(message(reason)); }
    finally { inFlight.current = false; setWorking(false); }
  }
  async function recover() {
    if (inFlight.current || !selected || !confirm || status.busy || status.recovered) return;
    inFlight.current = true; setWorking(true); setError('');
    try {
      const recovered = await invoke<RecoveryOutcome>('recover_startup_backup', { candidateId: selected.id });
      setStatus(current => ({ ...current, busy: false, recovered }));
      setConfirm(false);
    } catch (reason) {
      setError(message(reason));
      // The replacement may have succeeded even if its IPC response was lost.
      // Re-query before offering another operation or reporting final failure.
      try { await refreshStatus(); } catch { /* Keep the original error and selection. */ }
    } finally { inFlight.current = false; setWorking(false); }
  }
  async function restart() {
    if (inFlight.current) return;
    inFlight.current = true; setWorking(true); setError('');
    try { await invoke('restart_after_recovery'); }
    catch (reason) { setError(message(reason)); }
    finally { inFlight.current = false; setWorking(false); }
  }
  return <main className="recovery-shell"><div className="recovery-content">
    <Brand />
    {status.recovered ? <>
      <h1 ref={outcomeHeading} tabIndex={-1}>本地数据已恢复</h1>
      <p>重新启动侧笺后载入恢复的数据。原数据库及日志文件已保留在：</p>
      <p className="recovery-path">{status.recovered.preservedDirectory}</p>
      {error && <p role="alert" className="recovery-error">{error}</p>}
      <div><button className="primary-button" disabled={busy} onClick={() => void restart()}>{busy ? '正在重新启动…' : '重新启动侧笺'}</button></div>
    </> : <>
      <h1>需要恢复本地数据</h1>
      <p>本地数据库未能通过启动检查，任务暂未加载。选择一份已验证的备份恢复；恢复前会保留原数据库及日志文件。</p>
      <details className="recovery-details"><summary>查看启动检查错误</summary><p>{status.error}</p></details>
      <section aria-labelledby="recovery-backups-title" className="recovery-backups">
        <div className="recovery-section-heading"><h2 id="recovery-backups-title">可用备份</h2><button className="secondary-button" disabled={working} onClick={() => void scan()}>重新检查备份</button></div>
        {status.scanError && <p role="alert" className="recovery-error">备份检查未完成：{status.scanError}</p>}
        {status.candidates.length ? <fieldset className="recovery-options" disabled={busy || confirm}><legend className="sr-only">选择恢复备份</legend>
          {status.candidates.map(candidate => <label className={`recovery-option ${candidate.id === selectedId ? 'is-selected' : ''}`} key={candidate.id}>
            <input type="radio" name="recovery-backup" value={candidate.id} checked={candidate.id === selectedId} onChange={() => { setSelectedId(candidate.id); setError(''); }} />
            <span><strong>{backupDate(candidate.modifiedAt)} · 文件修改时间</strong><span>{candidate.taskCount.toLocaleString()} 项任务 · {candidate.planCount.toLocaleString()} 项计划 · {['before-schema-2', 'before-schema-3', 'before-schema-4'].includes(candidate.kind) ? '升级前备份' : '安全备份'}</span><small>{candidate.fileName}</small></span>
          </label>)}
        </fieldset> : <div className="recovery-empty"><p>未找到验证通过的本机备份。请退出侧笺后保留下面的整个数据目录，再联系维护者协助恢复。</p><p className="recovery-path">{status.dataDirectory}</p><p>请勿删除原数据库或日志文件，也不要将 JSON 备份改名为 SQLite 数据库。另有备份时，请按项目的《数据恢复说明》处理。</p></div>}
      </section>
      {error && <p role="alert" className="recovery-error">恢复尚未完成：{error}</p>}
      {busy && <p role="status">{status.busy || confirm ? '正在处理恢复，请稍候。' : '正在检查备份，请稍候。'}</p>}
      {confirm && selected ? <section className="recovery-confirm" aria-labelledby="recovery-confirm-title">
        <h2 id="recovery-confirm-title">确认恢复这份备份？</h2>
        <p>将从所选文件恢复 {selected.taskCount.toLocaleString()} 项任务和 {selected.planCount.toLocaleString()} 项计划，以及该备份中的本机设置。备份以后的修改不会出现在恢复后的任务中，原文件会另行保留。</p>
        <div className="recovery-actions"><button className="secondary-button" disabled={busy} onClick={() => setConfirm(false)}>返回选择</button><button className="primary-button" disabled={busy} onClick={() => void recover()}>保留原文件并恢复</button></div>
      </section> : <div><button className="primary-button" disabled={busy || !selected} onClick={() => setConfirm(true)}>检查并恢复所选备份</button></div>}
    </>}
  </div></main>;
}
