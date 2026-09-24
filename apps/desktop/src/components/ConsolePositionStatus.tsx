import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isDesktop, windowAction } from '../lib/native';

type PositionStatus = { pending: boolean; error: string | null };
type PositionAction = 'retryConsolePosition' | 'discardConsolePosition';
type Notice = { title: string; reason: string };
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

/** Reports device-position persistence without participating in task drafts. */
export default function ConsolePositionStatus() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [working, setWorking] = useState(false);
  const perform = useRef<((action: PositionAction) => Promise<void>) | null>(null);
  const focusAfterAction = useRef<Element | null>(null);

  useLayoutEffect(() => {
    if (working) return;
    const previous = focusAfterAction.current;
    focusAfterAction.current = null;
    // Wait for the DOM commit that re-enables a failed action's button.
    // A successful action removes it and requires no focus transfer here.
    if (document.hasFocus() && previous instanceof HTMLElement && previous.isConnected && !previous.matches(':disabled') && (document.activeElement === document.body || !document.activeElement?.isConnected)) previous.focus({ preventScroll: true });
  }, [working, notice]);

  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    let subscription: Promise<void> | undefined;
    let eventVersion = 0;
    let queryVersion = 0;
    let inFlight = false;

    function apply(status: PositionStatus, actionError?: string) {
      if (disposed) return;
      setNotice(status.error
        ? { title: '本次窗口位置未保存', reason: status.error }
        : actionError ? { title: '窗口位置操作未完成', reason: actionError } : null);
    }
    async function subscribe() {
      if (stop) return;
      subscription ??= (async () => {
        const cleanup = await listen<PositionStatus>('sidetask:console-position-status', ({ payload }) => {
          if (disposed) return;
          eventVersion++;
          apply(payload);
        });
        if (disposed) cleanup(); else stop = cleanup;
      })();
      try { await subscription; } finally { subscription = undefined; }
    }
    async function query(actionError?: string) {
      const version = eventVersion;
      const request = ++queryVersion;
      try {
        const status = await invoke<PositionStatus>('get_console_position_status');
        if (request === queryVersion && version === eventVersion) apply(status, actionError);
      } catch (reason) {
        if (!disposed && request === queryVersion && version === eventVersion) setNotice({ title: '暂时无法确认窗口位置是否已保存', reason: message(reason) });
      }
    }
    async function run(action: PositionAction) {
      if (disposed || inFlight) return;
      inFlight = true;
      const previousFocus = document.activeElement;
      setWorking(true);
      try {
        await subscribe();
        if (disposed) return;
        let actionError: string | undefined;
        try { await windowAction(action); } catch (reason) { actionError = message(reason); }
        if (!disposed) await query(actionError);
      } catch (reason) {
        if (!disposed) setNotice({ title: '暂时无法确认窗口位置是否已保存', reason: message(reason) });
      } finally {
        inFlight = false;
        if (!disposed) {
          focusAfterAction.current = previousFocus;
          setWorking(false);
        }
      }
    }
    perform.current = run;
    void (async () => {
      try { await subscribe(); if (!disposed) await query(); }
      catch (reason) { if (!disposed) setNotice({ title: '暂时无法确认窗口位置是否已保存', reason: message(reason) }); }
    })();
    return () => {
      disposed = true;
      focusAfterAction.current = null;
      stop?.();
      if (perform.current === run) perform.current = null;
    };
  }, []);

  if (!isDesktop || !notice) return null;
  return <div className="error-banner console-position-status" role="alert" aria-busy={working}>
    <div className="console-position-message"><strong>{notice.title}</strong><span>{notice.reason}</span></div>
    <div className="console-position-actions">
      <button type="button" className="secondary-button" disabled={working} onClick={() => void perform.current?.('retryConsolePosition')}>重试保存位置</button>
      <button type="button" className="secondary-button" disabled={working} onClick={() => void perform.current?.('discardConsolePosition')}>不保存本次位置</button>
    </div>
  </div>;
}
