import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { applyPreviewAction, createSeed, nextTimeBoundary, normalizePreviewSnapshot } from './domain';
import { isDesktop } from './native';
import type { Action, Snapshot } from './types';

const PREVIEW_KEY = 'sidetask-browser-preview-v1';
function previewRead(): Snapshot {
  const raw = localStorage.getItem(PREVIEW_KEY);
  if (raw) {
    return normalizePreviewSnapshot(JSON.parse(raw));
  }
  const initial = createSeed();
  localStorage.setItem(PREVIEW_KEY, JSON.stringify(initial));
  return initial;
}
interface Store {
  snapshot: Snapshot | null;
  loading: boolean;
  error: string | null;
  busy: boolean;
  mutate: (action: Action, expectedRevision?: number) => Promise<Snapshot>;
  restoreBackup: (content: string, expectedRevision: number) => Promise<string>;
  clearError: () => void;
}
const Context = createContext<Store | null>(null);
export function AppStoreProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<Snapshot | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const inflight = useRef(false);
  const apply = useCallback((value: Snapshot) => {
    if (!ref.current || value.revision >= ref.current.revision) {
      ref.current = value;
      setSnapshot(value);
    }
  }, []);
  const refresh = useCallback(async () => {
    const value = isDesktop ? await invoke<Snapshot>('get_snapshot') : previewRead();
    apply(value);
  }, [apply]);
  useEffect(() => {
    let disposed = false;
    const stops: Array<() => void> = [];
    const onFocus = () => { void refresh().catch(err => setError(String(err))); };
    const onStorage = (event: StorageEvent) => { if (event.key === PREVIEW_KEY) onFocus(); };
    void (async () => {
      try {
        if (isDesktop) {
          const changed = await listen('sidetask:changed', onFocus);
          if (disposed) { changed(); return; }
          stops.push(changed);
          const shown = await listen('sidetask:shown', onFocus);
          if (disposed) { shown(); return; }
          stops.push(shown);
          const windowError = await listen<string>('sidetask:window-error', ({ payload }) => setError(payload));
          if (disposed) { windowError(); return; }
          stops.push(windowError);
        } else {
          channel.current = new BroadcastChannel('sidetask-preview');
          channel.current.onmessage = onFocus;
          window.addEventListener('storage', onStorage);
        }
        await refresh();
      } catch (err) { if (!disposed) setError(String(err)); }
      finally { if (!disposed) setLoading(false); }
    })();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      disposed = true;
      stops.forEach(stop => stop());
      channel.current?.close();
      channel.current = null;
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);
  const mutate = useCallback(async (action: Action, observedRevision?: number) => {
    if (inflight.current || !ref.current) throw new Error('正在保存，请稍后再试');
    inflight.current = true;
    setBusy(true);
    setError(null);
    const expectedRevision = observedRevision ?? ref.current.revision;
    try {
      if (expectedRevision !== ref.current.revision) throw new Error('任务已在另一窗口更新，请重新排序');
      if (isDesktop) {
        const committed = await invoke<Snapshot>('mutate', { action, expectedRevision });
        apply(committed);
        return committed;
      } else {
        const write = async () => {
          const next = applyPreviewAction(previewRead(), action, expectedRevision);
          localStorage.setItem(PREVIEW_KEY, JSON.stringify(next));
          apply(next);
          channel.current?.postMessage({ revision: next.revision });
          return next;
        };
        if (navigator.locks) return await navigator.locks.request('sidetask-preview-write', write);
        return await write();
      }
    } catch (err) {
      setError(String(err));
      await refresh().catch(() => {});
      throw err;
    } finally { inflight.current = false; setBusy(false); }
  }, [apply, refresh]);
  const restoreBackup = useCallback(async (content: string, expectedRevision: number) => {
    if (!isDesktop || inflight.current || !ref.current) throw new Error('暂时无法恢复，请稍后再试');
    inflight.current = true; setBusy(true); setError(null);
    try {
      const result = await invoke<{ snapshot: Snapshot; safetyBackupPath: string }>('restore_backup', { content, expectedRevision });
      apply(result.snapshot);
      return result.safetyBackupPath;
    } catch (reason) {
      setError(String(reason)); await refresh().catch(() => {}); throw reason;
    } finally { inflight.current = false; setBusy(false); }
  }, [apply, refresh]);
  useEffect(() => {
    const theme = snapshot?.settings.theme || 'light';
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => document.documentElement.dataset.theme = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [snapshot?.settings.theme]);
  useEffect(() => {
    document.documentElement.dataset.style = snapshot?.settings.uiStyle || 'paper';
  }, [snapshot?.settings.uiStyle]);
  // Poll clock drift cheaply; render at a deadline/midnight boundary, on clock
  // jumps or offset changes. Sleeping timers never determine persisted dates.
  useEffect(() => {
    let previous = Date.now();
    let offset = new Date().getTimezoneOffset();
    let boundary = nextTimeBoundary(ref.current?.tasks || [], previous);
    const timer = setInterval(() => {
      const now = Date.now(); const nextOffset = new Date().getTimezoneOffset();
      if (now >= boundary || now < previous || now - previous > 2_000 || nextOffset !== offset) {
        boundary = nextTimeBoundary(ref.current?.tasks || [], now);
        setSnapshot(value => value ? { ...value } : value);
      }
      previous = now; offset = nextOffset;
    }, 1_000);
    return () => clearInterval(timer);
  }, [snapshot?.revision]);
  return <Context.Provider value={{ snapshot, loading, error, busy, mutate, restoreBackup, clearError: () => setError(null) }}>{children}</Context.Provider>;
}
export function useAppStore(): Store {
  const store = useContext(Context);
  if (!store) throw new Error('AppStoreProvider is missing');
  return store;
}
