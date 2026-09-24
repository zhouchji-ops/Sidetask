import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';

// IPC is simulated here to exercise frontend failure/exit behavior. These are
// not substitutes for native ACL, SQLite or OS quit/focus acceptance tests.
async function nativeHarness(page: Page) {
  await page.addInitScript(initial => {
    let snapshot = initial;
    let sequence = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const harness = {
      failMutation: false,
      delayMutation: false,
      releaseMutation: () => {},
      calls: [] as { command: string; args: Record<string, any> }[],
      emit(event: string, payload: unknown) {
        for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ id, event, payload });
      },
      advance() { snapshot = { ...snapshot, revision: snapshot.revision + 1 }; harness.emit('sidetask:changed', {}); },
      snapshot: () => structuredClone(snapshot),
    };
    Object.assign(window, {
      __harness: harness,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => listeners.delete(id) },
      __TAURI_INTERNALS__: {
        transformCallback(callback: (value: unknown) => void) { const id = ++sequence; callbacks.set(id, callback); return id; },
        async invoke(command: string, args: Record<string, any> = {}) {
          harness.calls.push({ command, args });
          if (command === 'plugin:event|listen') { const id = ++sequence; listeners.set(id, args as { event: string; handler: number }); return id; }
          if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
          if (command === 'get_snapshot') return structuredClone(snapshot);
          if (command === 'get_pending_exit') return null;
          if (command === 'get_window_status') return { pending: false, error: null };
          if (command === 'resolve_exit' || command === 'window_action') return;
          if (command === 'mutate') {
            if (harness.failMutation) throw new Error('模拟磁盘写入失败');
            if (harness.delayMutation) await new Promise<void>(resolve => { harness.releaseMutation = resolve; });
            const modulePath = '/src/lib/domain.ts';
            const domain = await import(modulePath);
            snapshot = domain.applyPreviewAction(snapshot, args.action, args.expectedRevision);
            return structuredClone(snapshot);
          }
          if (command === 'export_backup') return { path: '/synthetic/exports/tasks.json' };
          if (command === 'preview_restore') { const backup = JSON.parse(args.content); if (backup.schemaVersion !== 1) throw new Error('备份版本不受支持'); return { taskCount: backup.tasks.length, planCount: backup.plans.length, exportedAt: backup.exportedAt }; }
          if (command === 'restore_backup') {
            if (snapshot.revision !== args.expectedRevision) throw new Error('数据在预览后更新');
            const backup = JSON.parse(args.content);
            snapshot = { ...snapshot, tasks: backup.tasks, plans: backup.plans, revision: snapshot.revision + 1 };
            return { snapshot: structuredClone(snapshot), safetyBackupPath: '/synthetic/before-restore.sqlite3' };
          }
          throw new Error(`Unexpected IPC: ${command}`);
        },
      },
    });
  }, createSeed());
  await page.goto('/?surface=console');
  await expect(page.locator('.console-shell')).toBeVisible();
}
async function quit(page: Page, requestId: number) {
  await page.evaluate(id => (window as any).__harness.emit('sidetask:exit-requested', { requestId: id }), requestId);
}
async function approvals(page: Page) {
  return page.evaluate(() => (window as any).__harness.calls.filter((call: any) => call.command === 'resolve_exit'));
}

test('新任务取消与嵌套 Esc 保留草稿，状态栏反映尚未保存', async ({ page }) => {
  await page.goto('/?surface=console');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建任务', exact: true });
  await create.getByLabel('任务名称', { exact: true }).fill('不可丢失的新任务草稿');
  await expect(page.locator('.workspace-statusbar')).toContainText('有尚未保存的修改');
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('dialog', { name: '保留新任务草稿？' });
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(create.getByLabel('任务名称', { exact: true })).toHaveValue('不可丢失的新任务草稿');
  await create.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(create).toBeHidden();
  await expect(page.locator('.workspace-statusbar')).toContainText('更改已保存在本机');
});

test('退出可取消；新任务保存失败不会退出且保留输入，重试成功后批准', async ({ page }) => {
  await nativeHarness(page);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建任务', exact: true });
  await create.getByLabel('任务名称', { exact: true }).fill('退出前必须保存');
  await quit(page, 10);
  const dialog = page.getByRole('dialog', { name: '退出前保存修改？' });
  await dialog.getByRole('button', { name: '取消退出', exact: true }).click();
  expect(await approvals(page)).toEqual([{ command: 'resolve_exit', args: { requestId: 10, allow: false } }]);
  await expect(create.getByLabel('任务名称', { exact: true })).toHaveValue('退出前必须保存');
  await page.evaluate(() => { (window as any).__harness.failMutation = true; });
  await quit(page, 11);
  await dialog.getByRole('button', { name: '保存并退出', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('保存未完成');
  expect((await approvals(page)).some((call: any) => call.args.allow)).toBe(false);
  await page.evaluate(() => { (window as any).__harness.failMutation = false; });
  await dialog.getByRole('button', { name: '保存并退出', exact: true }).click();
  await expect.poll(async () => (await approvals(page)).filter((call: any) => call.args.allow).length).toBe(1);
  expect(await page.evaluate(() => (window as any).__harness.snapshot().tasks.some((task: any) => task.title === '退出前必须保存'))).toBe(true);
});

test('已有详情和新任务两份草稿退出时逐一保存；放弃退出不写入', async ({ page }) => {
  await nativeHarness(page);
  await page.getByRole('button', { name: '编辑任务：完成交互设计课程作业', exact: true }).click();
  await page.locator('.task-detail').getByLabel('备注').fill('第一份草稿');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByRole('dialog', { name: '新建任务', exact: true }).getByLabel('任务名称', { exact: true }).fill('第二份草稿');
  await quit(page, 20);
  await page.getByRole('dialog', { name: '退出前保存修改？' }).getByRole('button', { name: '保存并退出', exact: true }).click();
  await expect.poll(async () => (await approvals(page)).filter((call: any) => call.args.allow).length).toBe(1);
  const saved = await page.evaluate(() => (window as any).__harness.snapshot());
  expect(saved.tasks.some((task: any) => task.notes === '第一份草稿')).toBe(true);
  expect(saved.tasks.some((task: any) => task.title === '第二份草稿')).toBe(true);
  await page.locator('.task-detail').getByLabel('备注').fill('这次放弃');
  await quit(page, 21);
  await page.getByRole('dialog', { name: '退出前保存修改？' }).getByRole('button', { name: '放弃并退出', exact: true }).click();
  expect((await page.evaluate(() => (window as any).__harness.snapshot())).tasks.some((task: any) => task.notes === '这次放弃')).toBe(false);
});

test('同一设置在另一窗口更新时阻止旧草稿静默覆盖', async ({ page, context }) => {
  await page.goto('/?surface=console&page=settings');
  await page.getByLabel('小窗宽度', { exact: true }).fill('400');
  const other = await context.newPage();
  await other.goto('/?surface=console&page=settings');
  await other.getByLabel('小窗宽度', { exact: true }).fill('420');
  await other.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('.inline-warning')).toContainText('设置已在另一处修改');
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  await expect(page.getByLabel('小窗宽度', { exact: true })).toHaveValue('400');
  await page.getByRole('button', { name: '确认以我的设置草稿覆盖' }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(other.getByLabel('小窗宽度', { exact: true })).toHaveValue('400');
});

test('原生备份入口显示真实路径；恢复需预览确认且拒绝过期预览', async ({ page }) => {
  await nativeHarness(page);
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '导出任务备份' }).click();
  await expect(page.locator('.backup-path')).toContainText('/synthetic/exports/tasks.json');
  const backup = { schemaVersion: 1, exportedAt: '2026-09-25T00:00:00Z', tasks: [], plans: [] };
  const input = page.getByLabel('选择任务备份文件');
  await input.setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  const dialog = page.getByRole('dialog', { name: '恢复这份任务备份？' });
  await expect(dialog).toContainText('0 项任务');
  await page.evaluate(() => (window as any).__harness.advance());
  await expect(dialog.getByRole('button', { name: '备份当前数据并恢复' })).toBeDisabled();
  await dialog.getByRole('button', { name: '取消恢复' }).click();
  await input.setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
  await dialog.getByRole('button', { name: '备份当前数据并恢复' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.backup-path')).toContainText('before-restore.sqlite3');
  expect((await page.evaluate(() => (window as any).__harness.snapshot())).tasks).toHaveLength(0);
});

test('保存等待期间冻结输入和离开操作，已提交草稿不会覆盖后续输入', async ({ page }) => {
  await nativeHarness(page);
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('小窗宽度', { exact: true }).fill('400');
  await page.evaluate(() => { (window as any).__harness.delayMutation = true; });
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByLabel('小窗宽度', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeDisabled();
  await page.getByRole('navigation').getByRole('button', { name: /^今日/ }).click();
  await expect(page.locator('.page-heading h1')).toHaveText('设置');
  await page.evaluate(() => (window as any).__harness.releaseMutation());
  await expect(page.getByLabel('小窗宽度', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('小窗宽度', { exact: true })).toHaveValue('400');
  await page.getByLabel('小窗宽度', { exact: true }).fill('410');
  await expect(page.locator('.workspace-statusbar')).toContainText('有尚未保存的修改');
});

test('已保存设置的系统应用失败可见，提供重试且不误报已同步', async ({ page }) => {
  await nativeHarness(page);
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('.settings-save')).toContainText('设置已与应用同步');
  await page.evaluate(() => (window as any).__harness.emit('sidetask:window-status', { pending: true, error: '显示器暂不可用' }));
  await expect(page.locator('.settings-save')).toContainText('窗口应用失败');
  await page.getByRole('button', { name: '重试应用窗口设置' }).click();
  await expect(page.locator('.settings-save')).toContainText('设置已与应用同步');
  expect(await page.evaluate(() => (window as any).__harness.calls.some((call: any) => call.command === 'window_action' && call.args.action === 'retryWindowSettings'))).toBe(true);
});

test('午夜与精确 DDL 到达后无需持久化事件即刷新列表和逾期标识', async ({ page }) => {
  const seed = createSeed('2026-09-25');
  seed.tasks[0].dueDate = '2026-09-26'; seed.tasks[0].dueTime = '00:00';
  await page.addInitScript(value => localStorage.setItem('sidetask-browser-preview-v1', JSON.stringify(value)), seed);
  await page.clock.install({ time: new Date('2026-09-25T15:59:59.000Z') });
  await page.goto('/?surface=console&page=deadlines');
  const row = page.locator('.main-content .task-row').filter({ has: page.getByRole('button', { name: '编辑任务：完成交互设计课程作业', exact: true }) });
  await expect(row).not.toContainText('已逾期');
  await page.clock.fastForward(1100);
  await expect(row).toContainText('已逾期');
  await page.getByRole('navigation').getByRole('button', { name: /^今日/ }).click();
  await expect(page.locator('.backlog-section')).toContainText('此前未完成');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sidetask-browser-preview-v1')!).revision)).toBe(seed.revision);
});
