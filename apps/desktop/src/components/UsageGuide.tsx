import { useId, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { UsageGuideState } from '../lib/useUsageGuide';
import { windowAction } from '../lib/native';

export default function UsageGuide({ state, edgeEnabled, permanent = false }: {
  state: UsageGuideState; edgeEnabled: boolean; permanent?: boolean;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const focusRequest = useRef<{ operation: 'read' | 'ack'; trigger: HTMLButtonElement; main: HTMLElement | null } | null>(null);
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState('');

  useLayoutEffect(() => {
    const request = focusRequest.current;
    if (!request || (request.operation === 'ack' ? state.saving : state.loading)) return;
    focusRequest.current = null;
    const active = document.activeElement;
    // A user who moved to an editor while saving keeps that focus and draft.
    if (!document.hasFocus() || (active !== request.trigger && active !== document.body && active?.isConnected)) return;
    if (request.operation === 'read' && !state.readError && state.seen !== true) {
      heading.current?.focus({ preventScroll: true });
    } else if (state.seen) {
      const target = permanent ? (edgeEnabled ? openButton.current : heading.current) : request.main;
      target?.focus({ preventScroll: true });
    } else (request.operation === 'read' ? retryButton.current : request.trigger)?.focus({ preventScroll: true });
  }, [state.seen, state.saving, state.saveError, state.loading, state.readError, permanent, edgeEnabled]);

  function acknowledge(event: MouseEvent<HTMLButtonElement>) {
    if (event.detail === 0) focusRequest.current = { operation: 'ack', trigger: event.currentTarget, main: event.currentTarget.closest('main') };
    void state.acknowledge();
  }
  function refresh(event: MouseEvent<HTMLButtonElement>) {
    if (event.detail === 0) focusRequest.current = { operation: 'read', trigger: event.currentTarget, main: event.currentTarget.closest('main') };
    void state.refresh();
  }
  async function openPanel() {
    if (!edgeEnabled || opening) return;
    setOpening(true); setOpenError('');
    try { await windowAction('showPanel'); }
    catch (reason) { setOpenError(`小窗暂时无法打开，请重试：${String(reason)}`); }
    finally { setOpening(false); }
  }

  if (!permanent && state.seen === true) return null;
  if (!permanent && state.seen === null) return <div className="usage-guide-status" role="status">
    <span>{state.readError || (state.loading ? '正在读取使用说明…' : '使用说明状态尚未读取。')}</span>
    {state.readError && <button ref={retryButton} type="button" className="text-button" onClick={refresh}>重试读取</button>}
  </div>;

  return <section className={`usage-guide${permanent ? ' usage-guide-permanent' : ''}`} aria-labelledby={titleId}>
    <div className="usage-guide-copy">
      <h2 id={titleId} ref={heading} tabIndex={-1}>{permanent ? '使用说明' : '关闭控制台后，侧笺仍在运行'}</h2>
      <p>关闭大窗口后，可从菜单栏或系统托盘重新打开控制台；选择「退出 SideTask」才会结束应用。</p>
      {!edgeEnabled && <p className="usage-guide-paused">边缘入口已暂停，可在设置中开启。</p>}
    </div>
    <div className="usage-guide-actions">
      <button ref={openButton} type="button" className="secondary-button" disabled={!edgeEnabled || opening} onClick={() => void openPanel()}>{opening ? '正在打开…' : '打开边缘小窗'}</button>
      {state.seen !== true && <button type="button" className="text-button" disabled={state.saving} onClick={acknowledge}>{state.saving ? '正在保存…' : '知道了'}</button>}
    </div>
    {(state.saveError || openError) && <p className="usage-guide-error" role="alert">{state.saveError || openError}</p>}
    {permanent && state.readError && <div className="usage-guide-status" role="status"><span>{state.readError}</span><button ref={retryButton} type="button" className="text-button" disabled={state.saving || state.loading} onClick={refresh}>重试读取</button></div>}
  </section>;
}
