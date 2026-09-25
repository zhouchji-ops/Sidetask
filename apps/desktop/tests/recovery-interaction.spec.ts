import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';

// Browser + simulated IPC regression coverage. Native file-picker cancellation,
// SQLite contents and physical recovery are verified in the isolated Mac app.
async function backupHarness(page: Page) {
  await page.addInitScript(initial => {
    let snapshot = initial;
    let sequence = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const harness = {
      waitPreview: false, waitRestore: false, waitExport: false, failRestore: false, failExport: false,
      releasePreview: () => {}, releaseRestore: () => {}, releaseExport: () => {},
      calls: [] as { command: string; args: Record<string, any> }[],
      snapshot: () => structuredClone(snapshot),
      advance() {
        snapshot = { ...snapshot, revision: snapshot.revision + 1 };
        for (const [id, listener] of listeners) if (listener.event === 'sidetask:changed') callbacks.get(listener.handler)?.({ id, event: listener.event, payload: {} });
      },
    };
    Object.assign(window, {
      __backup: harness,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => listeners.delete(id) },
      __TAURI_INTERNALS__: {
        transformCallback(callback: (value: unknown) => void) { const id = ++sequence; callbacks.set(id, callback); return id; },
        async invoke(command: string, args: Record<string, any> = {}) {
          harness.calls.push({ command, args });
          if (command === 'plugin:event|listen') { const id = ++sequence; listeners.set(id, args as { event: string; handler: number }); return id; }
          if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
          if (command === 'get_snapshot') return structuredClone(snapshot);
          if (command === 'get_usage_guide_seen') return true;
          if (command === 'get_startup_recovery' || command === 'get_pending_exit') return null;
          if (command === 'get_window_status' || command === 'get_console_position_status') return { pending: false, error: null };
          if (command === 'window_action' || command === 'resolve_exit') return;
          if (command === 'mutate') {
            const modulePath = '/src/lib/domain.ts';
            const { applyPreviewAction } = await import(modulePath);
            snapshot = applyPreviewAction(snapshot, args.action, args.expectedRevision);
            return structuredClone(snapshot);
          }
          if (command === 'export_backup') {
            if (harness.waitExport) await new Promise<void>(resolve => { harness.releaseExport = resolve; });
            if (harness.failExport) throw new Error('合成导出目录不可写');
            return { path: '/synthetic/exports/tasks.json' };
          }
          if (command === 'preview_restore') {
            if (harness.waitPreview) await new Promise<void>(resolve => { harness.releasePreview = resolve; });
            const backup = JSON.parse(args.content);
            return { taskCount: backup.tasks.length, trashedTaskCount: backup.tasks.filter((task: any) => task.deletedAt).length, planCount: backup.plans.length, exportedAt: backup.exportedAt };
          }
          if (command === 'restore_backup') {
            if (harness.waitRestore) await new Promise<void>(resolve => { harness.releaseRestore = resolve; });
            if (harness.failRestore) throw new Error('合成安全备份写入失败，原数据未更改');
            if (snapshot.revision !== args.expectedRevision) throw new Error('数据在预览后更新');
            const backup = JSON.parse(args.content);
            snapshot = { ...snapshot, tasks: backup.tasks, plans: backup.plans, revision: snapshot.revision + 1 };
            return { snapshot: structuredClone(snapshot), safetyBackupPath: '/synthetic/before-restore.sqlite3' };
          }
          throw new Error(`Unexpected backup IPC: ${command}`);
        },
      },
    });
  }, createSeed());
  await page.goto('/?surface=console&page=settings');
  await expect(page.getByRole('button', { name: '选择备份恢复', exact: true })).toBeVisible();
}
const emptyBackup = { schemaVersion: 2, exportedAt: '2026-09-25T00:00:00Z', tasks: [], plans: [] };
async function chooseBackup(page: Page, content = JSON.stringify(emptyBackup)) {
  await page.getByLabel('选择任务备份文件', { exact: true }).setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(content) });
}

test('慢预览完成时保留后来输入的设置草稿与焦点，可保存后重新预览', async ({ page }) => {
  await backupHarness(page);
  await page.evaluate(() => { (window as any).__backup.waitPreview = true; });
  await chooseBackup(page);
  await expect.poll(() => page.evaluate(() => (window as any).__backup.calls.filter((call: any) => call.command === 'preview_restore').length)).toBe(1);
  const width = page.getByLabel('小窗宽度', { exact: true });
  await width.fill('417');
  await page.evaluate(() => (window as any).__backup.releasePreview());
  await expect(page.locator('.backup-path')).toContainText('编辑状态已改变，预览已取消');
  await expect(page.getByRole('dialog', { name: '恢复这份任务备份？' })).toHaveCount(0);
  await expect(width).toHaveValue('417');
  await expect(width).toBeFocused();
  await expect(page.getByRole('button', { name: '选择备份恢复', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.evaluate(() => { (window as any).__backup.waitPreview = false; });
  await chooseBackup(page);
  await expect(page.getByRole('dialog', { name: '恢复这份任务备份？' })).toBeVisible();
});

test('慢预览不会盖住后来开始的新建草稿或挪走输入焦点', async ({ page }) => {
  await backupHarness(page);
  await page.evaluate(() => { (window as any).__backup.waitPreview = true; });
  await chooseBackup(page);
  await expect.poll(() => page.evaluate(() => (window as any).__backup.calls.filter((call: any) => call.command === 'preview_restore').length)).toBe(1);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const title = page.getByRole('dialog', { name: '新建任务', exact: true }).getByLabel('任务名称', { exact: true });
  await title.fill('预览等待时开始的新草稿');
  await page.evaluate(() => (window as any).__backup.releasePreview());
  await expect(page.locator('.backup-path')).toContainText('编辑状态已改变，预览已取消');
  await expect(page.getByRole('dialog', { name: '恢复这份任务备份？' })).toHaveCount(0);
  await expect(title).toHaveValue('预览等待时开始的新草稿');
  await expect(title).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.type(' continued');
  await expect(title).toHaveValue('预览等待时开始的新草稿 continued');
});

test('慢预览不会打断尚未输入的空白新建窗口或错置弹窗焦点', async ({ page }) => {
  await backupHarness(page);
  await page.evaluate(() => { (window as any).__backup.waitPreview = true; });
  await chooseBackup(page);
  await expect.poll(() => page.evaluate(() => (window as any).__backup.calls.filter((call: any) => call.command === 'preview_restore').length)).toBe(1);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建任务', exact: true });
  const title = create.getByLabel('任务名称', { exact: true });
  await expect(title).toHaveValue('');
  await expect(title).toBeFocused();
  await page.evaluate(() => (window as any).__backup.releasePreview());
  await expect(page.locator('.backup-path')).toContainText('编辑状态已改变，预览已取消');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(create).toBeVisible();
  await expect(title).toHaveValue('');
  await expect(title).toBeFocused();
  await page.keyboard.type('Continue creating');
  await expect(title).toHaveValue('Continue creating');
});

test('导出与文件校验失败保留键盘入口，同一文件可重新选择；空选择不发请求', async ({ page }) => {
  await backupHarness(page);
  const exportButton = page.getByRole('button', { name: '导出任务备份', exact: true });
  await page.evaluate(() => { Object.assign((window as any).__backup, { failExport: true, waitExport: true }); });
  await exportButton.focus();
  await page.keyboard.press('Enter');
  await expect(exportButton).toBeDisabled();
  await page.evaluate(() => (window as any).__backup.releaseExport());
  await expect(page.getByRole('alert')).toContainText('合成导出目录不可写');
  await expect(exportButton).toBeFocused();
  await page.evaluate(() => { Object.assign((window as any).__backup, { failExport: false, waitExport: false, waitPreview: true }); });
  await page.keyboard.press('Enter');
  await expect(page.locator('.backup-path')).toContainText('/synthetic/exports/tasks.json');
  const chooser = page.getByRole('button', { name: '选择备份恢复', exact: true });
  await chooser.focus();
  await chooseBackup(page, '{');
  await expect.poll(() => page.evaluate(() => (window as any).__backup.calls.filter((call: any) => call.command === 'preview_restore').length)).toBe(1);
  await expect(chooser).toBeDisabled();
  await page.evaluate(() => (window as any).__backup.releasePreview());
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(chooser).toBeFocused();
  const before = await page.evaluate(() => (window as any).__backup.calls.filter((call: any) => ['preview_restore', 'restore_backup', 'export_backup'].includes(call.command)).length);
  await page.getByLabel('选择任务备份文件', { exact: true }).setInputFiles([]);
  expect(await page.evaluate(() => (window as any).__backup.calls.filter((call: any) => ['preview_restore', 'restore_backup', 'export_backup'].includes(call.command)).length)).toBe(before);
  await page.evaluate(() => { (window as any).__backup.waitPreview = false; });
  await chooseBackup(page);
  await expect(page.getByRole('dialog', { name: '恢复这份任务备份？' })).toBeVisible();
});

test('恢复失败保留预览和原快照，键盘可直接重试且进行中不能关闭', async ({ page }) => {
  await backupHarness(page);
  const before = await page.evaluate(() => (window as any).__backup.snapshot());
  await chooseBackup(page);
  const dialog = page.getByRole('dialog', { name: '恢复这份任务备份？' });
  const restore = dialog.getByRole('button', { name: '备份当前数据并恢复', exact: true });
  await page.evaluate(() => { Object.assign((window as any).__backup, { waitRestore: true, failRestore: true }); });
  await restore.focus();
  await page.keyboard.press('Enter');
  await expect(restore).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '关闭对话框', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (window as any).__backup.releaseRestore());
  await expect(dialog.getByRole('alert')).toContainText('合成安全备份写入失败');
  expect(await page.evaluate(() => (window as any).__backup.snapshot())).toEqual(before);
  await expect(restore).toBeFocused();
  await page.evaluate(() => { Object.assign((window as any).__backup, { waitRestore: false, failRestore: false }); });
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.backup-path')).toContainText('before-restore.sqlite3');
  await expect(page.getByRole('button', { name: '选择备份恢复', exact: true })).toBeFocused();
  const after = await page.evaluate(() => (window as any).__backup.snapshot());
  expect(after.settings).toEqual(before.settings);
  expect(after.tasks).toHaveLength(0);
});

test('预览或恢复等待期间任务更新会拒绝覆盖，并允许重新选择', async ({ page }) => {
  await backupHarness(page);
  await page.evaluate(() => { (window as any).__backup.waitPreview = true; });
  await chooseBackup(page);
  await expect.poll(() => page.evaluate(() => (window as any).__backup.calls.filter((call: any) => call.command === 'preview_restore').length)).toBe(1);
  await page.evaluate(() => { (window as any).__backup.advance(); (window as any).__backup.releasePreview(); });
  const dialog = page.getByRole('dialog', { name: '恢复这份任务备份？' });
  await expect(dialog.getByRole('alert')).toContainText('任务已更新');
  await expect(dialog.getByRole('button', { name: '备份当前数据并恢复', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: '取消恢复', exact: true }).click();
  await page.evaluate(() => { Object.assign((window as any).__backup, { waitPreview: false, waitRestore: true }); });
  await chooseBackup(page);
  await dialog.getByRole('button', { name: '备份当前数据并恢复', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__backup.calls.filter((call: any) => call.command === 'restore_backup').length)).toBe(1);
  await page.evaluate(() => { (window as any).__backup.advance(); (window as any).__backup.releaseRestore(); });
  await expect(dialog.getByText('Error: 数据在预览后更新', { exact: true })).toBeVisible();
  expect((await page.evaluate(() => (window as any).__backup.snapshot())).tasks).toHaveLength(createSeed().tasks.length);
  await dialog.getByRole('button', { name: '取消恢复', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择备份恢复', exact: true })).toBeEnabled();
});

test('启动恢复的键盘确认、返回与失败重试都有明确焦点', async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      dataDirectory: '/synthetic/recovery', error: '合成数据库损坏', scanError: null, busy: false,
      recovered: null as null | { preservedDirectory: string; restartRequired: true },
      candidates: [{ id: 'synthetic#hash', fileName: 'sidetask-safety-backup-synthetic.sqlite3', kind: 'safety-backup', schemaVersion: 4, taskCount: 3, planCount: 4, revision: 12, sizeBytes: 8192, modifiedAt: '2026-09-25T00:00:00Z' }],
    };
    const harness = { fail: true, calls: [] as string[] };
    Object.assign(window, {
      __startupKeyboard: harness,
      __TAURI_INTERNALS__: {
        async invoke(command: string) {
          harness.calls.push(command);
          if (command === 'get_startup_recovery') return structuredClone(state);
          if (command === 'recover_startup_backup') {
            if (harness.fail) throw new Error('合成原文件证据写入失败');
            state.recovered = { preservedDirectory: '/synthetic/evidence', restartRequired: true };
            return structuredClone(state.recovered);
          }
          throw new Error(`Unexpected startup IPC: ${command}`);
        },
      },
    });
  });
  await page.goto('/?surface=console');
  await page.getByRole('radio').check();
  const next = page.getByRole('button', { name: '检查并恢复所选备份', exact: true });
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '确认恢复这份备份？', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '返回选择', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('radio')).toBeFocused();
  await next.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const recover = page.getByRole('button', { name: '保留原文件并恢复', exact: true });
  await expect(recover).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('合成原文件证据写入失败');
  await expect(recover).toBeFocused();
  await page.evaluate(() => { (window as any).__startupKeyboard.fail = false; });
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: '本地数据已恢复', exact: true })).toBeFocused();
});
