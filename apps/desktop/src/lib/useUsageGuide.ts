import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { isDesktop } from './native';

// A browser preview preference, deliberately separate from the task snapshot.
export const USAGE_GUIDE_KEY = 'sidetask-usage-guide-seen-v1';

export function useUsageGuide() {
  const [seen, setSeen] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const mounted = useRef(false);
  const generation = useRef(0);
  const confirmed = useRef(false);
  const savingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (confirmed.current || savingRef.current) return;
    const request = ++generation.current;
    setLoading(true);
    setReadError('');
    try {
      const value: unknown = isDesktop
        ? await invoke<boolean>('get_usage_guide_seen')
        : localStorage.getItem(USAGE_GUIDE_KEY) === '1';
      if (typeof value !== 'boolean') throw new Error('返回的说明状态无效');
      if (!mounted.current || request !== generation.current || confirmed.current) return;
      confirmed.current = value;
      setSeen(value);
    } catch (reason) {
      if (mounted.current && request === generation.current && !confirmed.current) {
        setReadError(`使用说明状态未能读取：${String(reason)}`);
      }
    } finally {
      if (mounted.current && request === generation.current) setLoading(false);
    }
  }, []);

  const acknowledge = useCallback(async () => {
    if (confirmed.current || savingRef.current) return;
    savingRef.current = true;
    // A read begun before this write must never undo a successful confirmation.
    ++generation.current;
    setLoading(false);
    setSaving(true);
    setSaveError('');
    try {
      if (isDesktop) await invoke('acknowledge_usage_guide');
      else localStorage.setItem(USAGE_GUIDE_KEY, '1');
      confirmed.current = true;
      if (mounted.current) { setSeen(true); setReadError(''); }
    } catch (reason) {
      if (mounted.current) {
        setSeen(previous => previous ?? false);
        setSaveError(`确认未能保存，请重试：${String(reason)}`);
      }
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== localStorage || event.key !== USAGE_GUIDE_KEY || event.newValue !== '1') return;
      confirmed.current = true;
      ++generation.current;
      setSeen(true); setLoading(false); setReadError(''); setSaveError('');
    };
    if (!isDesktop) window.addEventListener('storage', onStorage);
    return () => { mounted.current = false; ++generation.current; window.removeEventListener('storage', onStorage); };
  }, [refresh]);

  return { seen, loading, saving, readError, saveError, refresh, acknowledge };
}

export type UsageGuideState = ReturnType<typeof useUsageGuide>;
