import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';

// Exercise UI protocol failures with synthetic IPC. Rust independently checks
// transaction/permission rules; this cannot certify native SQLite or OS quit.
async function setup(page: Page) {
  const initial = createSeed('2026-09-25');
  await page.clock.setFixedTime(new Date('2026-09-25T04:00:00Z'));
  await page.addInitScript(initial => {
    let snapshot = initial;
    let sequence = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const harness = {
      failAction: '', delayAction: '', concurrentSave: false,
      release: () => {}, calls: [] as { command: string; args: any }[],
      emit(event: string, payload: unknown) { for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ id, event, payload }); },
      snapshot: () => structuredClone(snapshot),
      async foreign(action: any) {
        const path = '/src/lib/domain.ts'; const domain = await import(path);
        snapshot = domain.applyPreviewAction(snapshot, action, snapshot.revision);
        harness.emit('sidetask:changed', {});
      },
    };
    Object.assign(window, {
      __lifecycle: harness,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => listeners.delete(id) },
      __TAURI_INTERNALS__: {
        transformCallback(callback: (value: unknown) => void) { const id = ++sequence; callbacks.set(id, callback); return id; },
        async invoke(command: string, args: any = {}) {
          harness.calls.push({ command, args });
          if (command === 'plugin:event|listen') { const id = ++sequence; listeners.set(id, args); return id; }
          if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
          if (command === 'get_startup_recovery' || command === 'get_pending_exit') return null;
          if (command === 'get_snapshot') return structuredClone(snapshot);
          if (command === 'get_usage_guide_seen') return true;
          if (command === 'acknowledge_usage_guide') return;
          if (command === 'get_window_status' || command === 'get_console_position_status') return { pending: false, error: null };
          if (command === 'window_action' || command === 'resolve_exit') return;
          if (command === 'mutate') {
            if (harness.delayAction === args.action.type) await new Promise<void>(resolve => { harness.release = resolve; });
            if (harness.failAction === args.action.type) throw new Error('合成写入失败');
            const path = '/src/lib/domain.ts'; const domain = await import(path);
            snapshot = domain.applyPreviewAction(snapshot, args.action, args.expectedRevision);
            const committed = structuredClone(snapshot);
            if (harness.concurrentSave && args.action.type === 'updateTask') {
              harness.concurrentSave = false;
              const task = snapshot.tasks.find(task => task.id === args.action.id)!;
              await harness.foreign({ type: 'updateTask', id: task.id, expectedRevision: task.revision, changes: { notes: '另一窗口刚保存的备注' } });
            }
            return committed;
          }
          throw new Error(`Unexpected IPC: ${command}`);
        },
      },
    });
  }, initial);
  await page.goto('/?surface=console');
  await page.getByRole('button', { name: `编辑任务：${initial.tasks[0].title}`, exact: true }).click();
  return initial.tasks[0];
}
const detail = (page: Page) => page.locator('.task-detail');
const prompt = (page: Page) => page.getByRole('dialog', { name: '移入回收站前保留修改？' });

test('保存失败不删除草稿，重试的两步操作冻结界面并延后退出', async ({ page }) => {
  const task = await setup(page);
  await detail(page).getByLabel('任务名称', { exact: true }).fill('需要保留的修改');
  await detail(page).getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.evaluate(() => { (window as any).__lifecycle.failAction = 'updateTask'; });
  await prompt(page).getByRole('button', { name: '保存后移入', exact: true }).click();
  await expect(prompt(page)).toContainText('草稿已保留');
  await expect(detail(page).getByLabel('任务名称', { exact: true })).toHaveValue('需要保留的修改');
  expect(await page.evaluate(() => (window as any).__lifecycle.calls.some((call: any) => call.args.action?.type === 'trashTask'))).toBe(false);
  await page.evaluate(() => { const h = (window as any).__lifecycle; h.failAction = ''; h.delayAction = 'trashTask'; });
  await prompt(page).getByRole('button', { name: '保存后移入', exact: true }).click();
  await expect(prompt(page).getByRole('button', { name: '继续编辑', exact: true })).toBeDisabled();
  await expect(detail(page).getByLabel('任务名称', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeDisabled();
  await page.evaluate(() => (window as any).__lifecycle.emit('sidetask:exit-requested', { requestId: 42 }));
  expect(await page.evaluate(() => (window as any).__lifecycle.calls.filter((call: any) => call.command === 'resolve_exit'))).toHaveLength(0);
  await page.evaluate(() => (window as any).__lifecycle.release());
  await expect(detail(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__lifecycle.calls.filter((call: any) => call.command === 'resolve_exit').length)).toBe(1);
  const stored = await page.evaluate(id => (window as any).__lifecycle.snapshot().tasks.find((task: any) => task.id === id), task.id);
  expect(stored.title).toBe('需要保留的修改'); expect(stored.deletedAt).toBeTruthy();
});

test('自己保存返回后出现并发修改，后续删除冲突且保留他人的新内容', async ({ page }) => {
  const task = await setup(page);
  await detail(page).getByLabel('任务名称', { exact: true }).fill('本次已保存的标题');
  await detail(page).getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.evaluate(() => { (window as any).__lifecycle.concurrentSave = true; });
  await prompt(page).getByRole('button', { name: '保存后移入', exact: true }).click();
  await expect(prompt(page)).toContainText('修改已保存，但未能移入回收站');
  const state = await page.evaluate(id => {
    const h = (window as any).__lifecycle;
    return { task: h.snapshot().tasks.find((task: any) => task.id === id), actions: h.calls.filter((call: any) => call.command === 'mutate').map((call: any) => call.args.action) };
  }, task.id);
  expect(state.task.deletedAt).toBeFalsy(); expect(state.task.notes).toBe('另一窗口刚保存的备注'); expect(state.task.title).toBe('本次已保存的标题');
  expect(state.actions.at(-1)).toMatchObject({ type: 'trashTask', expectedRevision: task.revision + 1 });
  await prompt(page).getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(detail(page)).toBeVisible();
});

test('旧恢复提示不能撤销另一窗口后来再次删除的任务', async ({ page }) => {
  const task = await setup(page);
  await detail(page).getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(page.locator('.toast')).toContainText('已移入回收站');
  await page.evaluate(async id => {
    const h = (window as any).__lifecycle;
    const revision = () => h.snapshot().tasks.find((task: any) => task.id === id).revision;
    await h.foreign({ type: 'restoreTask', id, expectedRevision: revision() });
    await h.foreign({ type: 'trashTask', id, expectedRevision: revision() });
  }, task.id);
  await page.locator('.toast').getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.locator('.error-banner')).toBeVisible();
  const stored = await page.evaluate(id => (window as any).__lifecycle.snapshot().tasks.find((task: any) => task.id === id), task.id);
  expect(stored.deletedAt).toBeTruthy(); expect(stored.revision).toBe(task.revision + 3);
  await page.getByRole('button', { name: /^回收站/ }).click();
  await expect(page.getByRole('button', { name: `查看已删除任务：${task.title}`, exact: true })).toBeVisible();
});
