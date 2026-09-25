import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Page, Settings, Snapshot } from './types';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export async function windowAction(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
  if (isDesktop) {
    if (action === 'hoverEnter' || action === 'hoverLeave') return;
    if (action === 'newTask') return invoke('window_action', { action: 'openConsole', payload: { page: 'today', newTask: true } });
    return invoke('window_action', { action, payload });
  }
  if (action === 'newTask') return windowAction('openConsole', { page: 'today', newTask: true });
  if (action === 'openConsole') {
    if (new URLSearchParams(location.search).get('surface') === 'edge-panel') {
      location.href = `/?surface=console&page=${encodeURIComponent(String(payload.page || 'today'))}${payload.taskId ? `&taskId=${encodeURIComponent(String(payload.taskId))}` : ''}${payload.newTask ? '&newTask=1' : ''}`;
    } else {
      window.dispatchEvent(new CustomEvent('sidetask:navigate', { detail: payload }));
      window.dispatchEvent(new CustomEvent('sidetask:preview', { detail: { visible: false } }));
    }
  }
  if (action === 'showPanel') window.dispatchEvent(new CustomEvent('sidetask:preview', { detail: { visible: true } }));
  if (action === 'hidePanel') window.dispatchEvent(new CustomEvent('sidetask:preview', { detail: { visible: false } }));
  if (action === 'hoverEnter' || action === 'hoverLeave') window.dispatchEvent(new CustomEvent('sidetask:preview-hover', { detail: { inside: action === 'hoverEnter' } }));
  if (action === 'startDrag') window.dispatchEvent(new CustomEvent('sidetask:drag-start'));
  if (action === 'finishDrag') window.dispatchEvent(new CustomEvent('sidetask:drag-end'));
  if (action === 'interaction') window.dispatchEvent(new CustomEvent('sidetask:preview-interaction', { detail: payload }));
  if (action === 'resizePanel') return new Promise<void>((resolve, reject) => {
    window.dispatchEvent(new CustomEvent('sidetask:preview-resize', { detail: { ...payload, resolve, reject } }));
  });
  return null;
}
export async function openConsole(page: Page = 'today', taskId?: string): Promise<void> {
  await windowAction('openConsole', { page, taskId: taskId ?? null });
}
export async function startWindowDrag(): Promise<void> { await windowAction('startDrag'); }
const interactionOwners = new Set<string | symbol>();
let interactionQueue: Promise<unknown> = Promise.resolve();
export async function setInteractionLock(locked: boolean, owner: string | symbol = 'default'): Promise<void> {
  if (locked) interactionOwners.add(owner); else interactionOwners.delete(owner);
  const held = interactionOwners.size > 0;
  interactionQueue = interactionQueue.catch(() => {}).then(() => windowAction('interaction', { locked: held }));
  await interactionQueue;
}

export function sameSettings(a: Settings, b: Settings): boolean {
  const keys = Object.keys(a) as (keyof Settings)[];
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}

/** Browser-only counterpart of the native resize session; no per-frame writes. */
export function createPreviewResizeHandler(
  settings: () => Settings | undefined,
  show: (size: { width: number; height: number } | null) => void,
  commit: (width: number, height: number) => Promise<Snapshot>,
) {
  let active: { session: string; base: Settings } | null = null;
  let committed: Settings[] = [];
  return async (event: Event) => {
    const detail = (event as CustomEvent).detail;
    try {
      const { phase, session } = detail;
      if (typeof session !== 'string' || !session) throw new Error('缺少有效的缩放会话。');
      if (phase === 'cancel') {
        if (active?.session === session) { active = null; show(null); }
        detail.resolve(); return;
      }
      const observed = settings();
      if (!observed) throw new Error('正在读取窗口设置。');
      const seen = committed.findIndex(value => sameSettings(value, observed));
      const current = seen >= 0 ? committed[committed.length - 1] : observed;
      committed = seen >= 0 ? committed.slice(seen) : [];
      if (phase === 'start') {
        if (active) throw new Error('请先结束当前缩放。');
        if (!detail.expectedSettings || !sameSettings(current, detail.expectedSettings)) throw new Error('缩放期间设置已更新，请重新调整。');
        active = { session, base: { ...current } };
        detail.resolve(); return;
      }
      if (phase !== 'preview' && phase !== 'commit') throw new Error('不支持的缩放操作。');
      if (!active || active.session !== session) throw new Error('缩放已结束，请重新调整。');
      if (!sameSettings(current, active.base)) throw new Error('缩放期间设置已更新，请重新调整。');
      const { width, height } = detail;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 300 || width > 640 || height < 380 || height > 1000) throw new Error('窗口尺寸无效。');
      show({ width, height });
      if (phase === 'commit') {
        const next = await commit(width, height);
        const visible = settings() ?? observed;
        if (committed.length && sameSettings(committed[committed.length - 1], current) && committed.some(value => sameSettings(value, visible))) committed = [...committed, next.settings];
        else if (sameSettings(visible, observed) || sameSettings(visible, current) || sameSettings(visible, next.settings)) committed = [current, next.settings];
        else committed = [];
        active = null;
      }
      detail.resolve();
    } catch (reason) {
      // A stale request must not cancel a newer session.
      if (active?.session === detail.session) { active = null; show(null); }
      detail.reject(reason);
    }
  };
}
export async function attachNativeNavigation(): Promise<() => void> {
  if (!isDesktop) return () => {};
  return listen<{ page?: Page; taskId?: string; newTask?: boolean }>('sidetask:navigate', ({ payload }) => {
    if (!payload || typeof payload !== 'object') return;
    window.dispatchEvent(new CustomEvent('sidetask:navigate', { detail: payload }));
  });
}

export async function attachExitRequests(receive: (requestId: number, stage?: string) => void, cancelled?: (requestId: number) => void): Promise<() => void> {
  if (!isDesktop) return () => {};
  const cancelledIds = new Set<number>();
  const stopCancel = cancelled ? await listen<{ requestId: number }>('sidetask:exit-cancelled', ({ payload }) => { cancelledIds.add(payload.requestId); cancelled(payload.requestId); }) : () => {};
  let stopRequest = () => {};
  try {
    stopRequest = await listen<{ requestId: number; window?: string }>('sidetask:exit-requested', ({ payload }) => { if (!cancelledIds.has(payload.requestId)) receive(payload.requestId, payload.window); });
    const pending = await invoke<{ requestId: number; window?: string } | null>('get_pending_exit');
    if (pending && !cancelledIds.has(pending.requestId)) receive(pending.requestId, pending.window);
    return () => { stopRequest(); stopCancel(); };
  } catch (error) { stopRequest(); stopCancel(); throw error; }
}
export async function resolveExit(requestId: number, allow: boolean): Promise<void> {
  if (isDesktop) await invoke('resolve_exit', { requestId, allow });
}
