import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Page } from './types';

export const isDesktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let previewHide: ReturnType<typeof setTimeout> | undefined;
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
  if (action === 'showPanel' || action === 'hoverEnter') {
    clearTimeout(previewHide);
    window.dispatchEvent(new CustomEvent('sidetask:preview', { detail: { visible: true } }));
  }
  if (action === 'hidePanel') window.dispatchEvent(new CustomEvent('sidetask:preview', { detail: { visible: false } }));
  if (action === 'hoverLeave') {
    clearTimeout(previewHide);
    previewHide = setTimeout(() => window.dispatchEvent(new CustomEvent('sidetask:preview-leave')), 450);
  }
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
export async function setInteractionLock(locked: boolean): Promise<void> { await windowAction('interaction', { locked }); }
export async function attachNativeNavigation(): Promise<() => void> {
  if (!isDesktop) return () => {};
  return listen<{ page?: Page; taskId?: string; newTask?: boolean }>('sidetask:navigate', ({ payload }) => {
    if (!payload || typeof payload !== 'object') return;
    window.dispatchEvent(new CustomEvent('sidetask:navigate', { detail: payload }));
  });
}

export async function attachExitRequests(receive: (requestId: number) => void): Promise<() => void> {
  if (!isDesktop) return () => {};
  const stop = await listen<{ requestId: number }>('sidetask:exit-requested', ({ payload }) => receive(payload.requestId));
  try {
    const pending = await invoke<{ requestId: number } | null>('get_pending_exit');
    if (pending) receive(pending.requestId);
    return stop;
  } catch (error) { stop(); throw error; }
}
export async function resolveExit(requestId: number, allow: boolean): Promise<void> {
  if (isDesktop) await invoke('resolve_exit', { requestId, allow });
}
