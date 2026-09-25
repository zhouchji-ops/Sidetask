import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { attachExitRequests, resolveExit, setInteractionLock, windowAction } from '../../lib/native';
import { localDate } from '../../lib/domain';
import type { Action, Snapshot } from '../../lib/types';

/** A panel-owned draft: only a committed create clears the entered title. */
export function useQuickAddToday(mutate: (action: Action) => Promise<Snapshot>, busy: boolean) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState('');
  const [message, setMessage] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [exitRequest, setExitRequest] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const owner = useRef(Symbol('quick-add'));
  const inflight = useRef(false);
  const composing = useRef(false);
  const suppressSubmitUntil = useRef(0);
  const latest = useRef({ title, busy, open });
  latest.current = { title, busy, open };
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const restoreTrigger = useRef(false);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void attachExitRequests(id => { setExitRequest(id); setConfirmDiscard(false); }, 'edge-panel')
      .then(cleanup => { if (disposed) cleanup(); else stop = cleanup; })
      .catch(reason => setFailure(String(reason)));
    return () => { disposed = true; stop?.(); };
  }, []);
  useEffect(() => {
    if (open && !working && exitRequest === null && !confirmDiscard) input.current?.focus();
    if (!open && !working && restoreTrigger.current) {
      restoreTrigger.current = false;
      trigger.current?.focus();
    }
  }, [open, working, exitRequest, confirmDiscard]);

  async function activate() {
    if (inflight.current || busy || exitRequest !== null) return;
    if (open) { input.current?.focus(); return; }
    inflight.current = true; setWorking(true); setFailure('');
    try {
      await setInteractionLock(true, owner.current);
      await windowAction('beginQuickAdd');
      setOpen(true); setMessage('');
    } catch (reason) {
      setFailure(String(reason));
      await setInteractionLock(false, owner.current).catch(() => {});
    } finally { inflight.current = false; setWorking(false); }
  }

  async function release() {
    // If native cleanup fails, keep the draft visible and the exit guard held.
    await setInteractionLock(false, owner.current);
    try { await windowAction('endQuickAdd'); }
    catch (reason) { await setInteractionLock(true, owner.current); throw reason; }
    setOpen(false); setConfirmDiscard(false); setTitle(''); setMessage('');
    restoreTrigger.current = true;
  }
  async function closeNow() {
    if (inflight.current || busy) return;
    inflight.current = true; setWorking(true); setFailure('');
    try { await release(); afterClose.current?.(); afterClose.current = undefined; }
    catch (reason) { setFailure(String(reason)); }
    finally { inflight.current = false; setWorking(false); }
  }
  function requestClose(then?: () => void) {
    if (inflight.current || busy || exitRequest !== null) return;
    afterClose.current = then;
    if (title.trim()) setConfirmDiscard(true);
    else void closeNow();
  }
  async function save(): Promise<boolean> {
    const value = latest.current.title.trim();
    if (!value) { setFailure('请输入任务名称。'); return false; }
    try {
      await mutate({ type: 'createTask', task: { title: value, notes: '', priority: 'normal', dueDate: null, dueTime: null, addToToday: true }, date: localDate() });
      setTitle(''); latest.current.title = ''; setMessage(`已加入今日：${value}`);
      return true;
    } catch (reason) { setFailure(String(reason)); return false; }
  }
  async function submit() {
    if (inflight.current || busy || exitRequest !== null || composing.current || Date.now() < suppressSubmitUntil.current) return;
    inflight.current = true; setWorking(true); setFailure('');
    try { await save(); } finally { inflight.current = false; setWorking(false); }
  }
  async function finishExit(decision: 'save' | 'discard' | 'cancel') {
    if (exitRequest === null || inflight.current || busy) return;
    inflight.current = true; setWorking(true); setFailure('');
    try {
      if (decision === 'cancel') await resolveExit(exitRequest, false);
      else {
        if (decision === 'save' && !await save()) return;
        await release();
        await resolveExit(exitRequest, true);
      }
      setExitRequest(null);
    } catch (reason) { setFailure(String(reason)); }
    finally { inflight.current = false; setWorking(false); }
  }
  useEffect(() => {
    if (exitRequest !== null && !title.trim() && !working && !busy && !failure) void finishExit('discard');
  }, [exitRequest, title, working, busy, failure]);

  const editor = (open || failure) && <div className="edge-quick-add" id="edge-quick-add">
    {open && <form aria-label="添加今日任务" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="edge-quick-add-row">
        <input ref={input} aria-label="今日任务名称" placeholder="今天要做什么？" value={title} maxLength={200}
          disabled={working || busy || exitRequest !== null || confirmDiscard}
          onChange={event => { setTitle(event.target.value); setFailure(''); setMessage(''); }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; suppressSubmitUntil.current = Date.now() + 80; }}
          onKeyDown={event => {
            if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229 || Date.now() < suppressSubmitUntil.current) {
              if (event.key === 'Enter') event.preventDefault();
              return;
            }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); requestClose(); }
          }}/>
        <button className="quick-add-submit" type="submit" disabled={working || busy || !title.trim() || exitRequest !== null || confirmDiscard}>{working ? '保存中' : '添加'}</button>
        <button className="icon-button" type="button" aria-label="收起添加今日任务" disabled={working || busy || exitRequest !== null} onClick={() => requestClose()}><X size={14}/></button>
      </div>
      {confirmDiscard && <div className="quick-add-confirm" role="group" aria-label="保留今日任务草稿？"><span>这条任务还未添加。</span><button type="button" disabled={working} onClick={() => setConfirmDiscard(false)}>继续输入</button><button type="button" disabled={working} onClick={() => void closeNow()}>放弃输入</button></div>}
      {exitRequest !== null && <div className="quick-add-confirm" role="group" aria-label="退出前保存今日任务？"><span>退出前添加这条今日任务？</span><button type="button" disabled={working || busy} onClick={() => void finishExit('cancel')}>取消退出</button><button type="button" disabled={working || busy || !title.trim()} onClick={() => void finishExit('save')}>添加后退出</button><button type="button" disabled={working || busy} onClick={() => void finishExit('discard')}>放弃并退出</button></div>}
    </form>}
    {failure && <p className="quick-add-error" role="alert">{failure}</p>}
    {message && <p className="quick-add-success" role="status">{message}</p>}
  </div>;
  return { open, working, trigger, activate, requestClose, editor };
}
