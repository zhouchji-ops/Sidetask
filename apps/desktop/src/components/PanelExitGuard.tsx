import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useDrafts } from '../lib/drafts';
import { attachExitRequests, resolveExit, setInteractionLock, windowAction } from '../lib/native';
import { useAppStore } from '../lib/store';
import '../styles/panel-exit.css';

/** The native panel answers first, then stays frozen until the console answers. */
export default function PanelExitGuard({ children }: { children: ReactNode }) {
  const { dirty, saveAll, discardAll } = useDrafts();
  const { busy, loading } = useAppStore();
  const [request, setRequest] = useState<number | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [failure, setFailure] = useState('');
  const requestRef = useRef<number | null>(null);
  const resolvingRef = useRef<number | null>(null);
  const latest = useRef({ dirty, saveAll, discardAll, busy, loading });
  latest.current = { dirty, saveAll, discardAll, busy, loading };
  const dialog = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const lockOwner = useRef(Symbol('panel-exit'));

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void attachExitRequests((id, stage) => {
      if (disposed) return;
      if (requestRef.current !== id) {
        previousFocus.current = document.activeElement as HTMLElement | null;
        requestRef.current = id;
        resolvingRef.current = null; setResolving(false);
        setRequest(id); setWaiting(stage === 'console'); setFailure('');
      } else if (stage === 'console') setWaiting(true);
      // Repeated quit also reveals an existing confirmation hidden by a tray
      // command. Clean panels acknowledge without activating a window.
      if (stage !== 'console' && latest.current.dirty) void setInteractionLock(true, lockOwner.current)
        .then(() => windowAction('showPanelExit', { requestId: id }))
        .catch(reason => { if (requestRef.current === id) setFailure(String(reason)); });
    }, id => {
      if (disposed || requestRef.current !== id) return;
      requestRef.current = null;
      resolvingRef.current = null; setResolving(false);
      setRequest(null); setWaiting(false); setFailure('');
    }).then(cleanup => { if (disposed) cleanup(); else stop = cleanup; }).catch(reason => setFailure(String(reason)));
    return () => { disposed = true; stop?.(); };
  }, []);

  useEffect(() => {
    if (request === null) {
      const previous = previousFocus.current;
      previousFocus.current = null;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      return;
    }
    void setInteractionLock(true, lockOwner.current).catch(reason => setFailure(String(reason)));
    return () => { void setInteractionLock(false, lockOwner.current).catch(reason => setFailure(String(reason))); };
  }, [request]);

  async function finish(save: boolean) {
    const id = requestRef.current;
    if (id === null || resolvingRef.current !== null || latest.current.busy || latest.current.loading) return;
    resolvingRef.current = id; setResolving(true); setFailure('');
    try {
      if (save) {
        const saved = await latest.current.saveAll();
        if (requestRef.current !== id) return;
        if (!saved) { setFailure('保存未完成，草稿仍保留。请继续编辑或重试。'); return; }
      }
      await resolveExit(id, true);
      if (requestRef.current === id) {
        if (!save) latest.current.discardAll();
        setWaiting(true);
      }
    } catch (reason) { if (requestRef.current === id) setFailure(String(reason)); }
    finally { if (resolvingRef.current === id) { resolvingRef.current = null; setResolving(false); } }
  }
  async function cancel() {
    const id = requestRef.current;
    if (id === null || resolvingRef.current !== null) return;
    resolvingRef.current = id; setResolving(true);
    try {
      await resolveExit(id, false);
      if (requestRef.current === id) {
        requestRef.current = null;
        setRequest(null); setWaiting(false); setFailure('');
      }
    } catch (reason) { if (requestRef.current === id) setFailure(String(reason)); }
    finally { if (resolvingRef.current === id) { resolvingRef.current = null; setResolving(false); } }
  }
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;

  useEffect(() => {
    if (request !== null && !waiting && !dirty && !busy && !loading && !resolving && !failure) void finish(false);
  }, [request, waiting, dirty, busy, loading, resolving, failure]);

  const visible = request !== null && (dirty || busy || waiting || !!failure);
  useEffect(() => {
    if (!visible) return;
    cancelButton.current?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); void cancelRef.current();
      } else if (event.key === 'Tab') {
        const elements = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const first = elements[0]; const last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        else if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [visible]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [dirty]);

  return <div className="panel-exit-root">
    <div className="panel-exit-surface" inert={request !== null}>{children}</div>
    {visible && <div className="panel-exit-backdrop"><div className="panel-exit-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <h2 id={titleId}>{waiting ? '正在确认退出' : '退出前保存今日任务？'}</h2>
      <p>{waiting ? '小窗草稿已处理，请在控制台完成退出确认。' : '小窗中还有尚未添加的任务。保存后会加入今日计划。'}</p>
      {failure && <p className="inline-error" role="alert">{failure}</p>}
      <div className="panel-exit-actions">
        <button ref={cancelButton} className="secondary-button" disabled={resolving} onClick={() => void cancel()}>取消退出</button>
        {!waiting && <><button className="secondary-button" disabled={busy || resolving} onClick={() => void finish(false)}>放弃并继续退出</button><button className="primary-button" disabled={busy || resolving} onClick={() => void finish(true)}>保存并继续退出</button></>}
      </div>
    </div></div>}
    {request === null && failure && <div className="panel-exit-error" role="alert">{failure}</div>}
  </div>;
}
