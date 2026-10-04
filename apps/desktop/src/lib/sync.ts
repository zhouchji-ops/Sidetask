import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isDesktop } from './native';

export interface SyncConflict { id: string; label: string; local: unknown; remote: unknown }
export interface SyncStatus {
  phase: 'disabled' | 'signedOut' | 'idle' | 'syncing' | 'error' | 'conflict';
  enabled: boolean;
  email: string | null;
  projectUrl: string | null;
  lastSyncedAt: string | null;
  pending: boolean;
  error: string | null;
  conflicts: SyncConflict[];
}
export interface SyncSignIn { projectUrl: string; publishableKey: string; email: string; password: string; mergeLocal: true }
export type SyncChoices = Record<string, 'local' | 'remote'>;
export const syncAvailable = isDesktop;

function desktopOnly() { if (!syncAvailable) throw new Error('云同步仅在桌面版使用'); }
export async function getSyncStatus(): Promise<SyncStatus> { desktopOnly(); return invoke('sync_status'); }
export async function signInSync(config: SyncSignIn): Promise<SyncStatus> { desktopOnly(); return invoke('sync_sign_in', { ...config }); }
export async function signOutSync(): Promise<SyncStatus> { desktopOnly(); return invoke('sync_sign_out'); }
export async function syncNow(): Promise<SyncStatus> { desktopOnly(); return invoke('sync_now'); }
export async function resolveSync(choices: SyncChoices): Promise<SyncStatus> { desktopOnly(); return invoke('sync_resolve', { choices }); }
export async function onSyncChanged(refresh: () => void): Promise<() => void> {
  if (!syncAvailable) return () => {};
  return listen('sidetask:sync-changed', refresh);
}

/** Basic input feedback only. The native boundary validates again before I/O. */
export function validateSyncSignIn(config: Omit<SyncSignIn, 'mergeLocal'>, mergeLocal: boolean): string | null {
  try {
    const url = new URL(config.projectUrl.trim());
    if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(url.hostname) || url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error();
  } catch { return '请输入有效的 Supabase 项目地址，例如 https://项目编号.supabase.co。'; }
  const key = config.publishableKey.trim();
  let publicKey = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (!publicKey && key.split('.').length === 3) {
    try {
      const payload = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      publicKey = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))).role === 'anon';
    } catch { /* An invalid JWT is not a public client key. */ }
  }
  if (!publicKey) return '请填写 Publishable key 或 anon key；不能使用 secret 或 service_role key。';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email.trim())) return '请输入账号邮箱。';
  if (!config.password) return '请输入账号密码。';
  if (!mergeLocal) return '请先确认将本机任务与此账号合并。';
  return null;
}
