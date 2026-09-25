import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';

// Native IPC is simulated; these checks do not claim AppKit/IME acceptance.
async function nativePanel(page: Page, pending: { requestId: number; window: string } | null = null) {
  await page.clock.setFixedTime(new Date('2026-09-25T04:00:00Z'));
  await page.addInitScript(({ initial, initialPending }) => {
    let snapshot = initial;
    let active = initialPending;
    let sequence = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const harness = {
      calls: [] as { command: string; args: Record<string, any> }[],
      failMutation: false, delayMutation: false, releaseMutation: () => {},
      delayExit: false, releaseExit: () => {},
      snapshot: () => structuredClone(snapshot),
      emit(event: string, payload: any) {
        if (event === 'sidetask:exit-requested') active = payload;
        if (event === 'sidetask:exit-cancelled') active = null;
        for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ id, event, payload });
      },
    };
    Object.assign(window, {
      __panelExit: harness,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => listeners.delete(id) },
      __TAURI_INTERNALS__: {
        transformCallback(callback: (value: unknown) => void) { const id = ++sequence; callbacks.set(id, callback); return id; },
        async invoke(command: string, args: Record<string, any> = {}) {
          harness.calls.push({ command, args });
          if (command === 'plugin:event|listen') { const id = ++sequence; listeners.set(id, args as { event: string; handler: number }); return id; }
          if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
          if (command === 'get_snapshot') return structuredClone(snapshot);
          if (command === 'get_pending_exit') return active;
          if (command === 'window_action') return;
          if (command === 'resolve_exit') {
            if (args.allow) active = { requestId: args.requestId, window: 'console' };
            else harness.emit('sidetask:exit-cancelled', { requestId: args.requestId });
            if (args.allow && harness.delayExit) await new Promise<void>(resolve => { harness.releaseExit = resolve; });
            return;
          }
          if (command === 'mutate') {
            if (harness.failMutation) throw new Error('模拟写入失败');
            if (harness.delayMutation) await new Promise<void>(resolve => { harness.releaseMutation = resolve; });
            const modulePath = '/src/lib/domain.ts';
            const domain = await import(modulePath);
            snapshot = domain.applyPreviewAction(snapshot, args.action, args.expectedRevision);
            return structuredClone(snapshot);
          }
          throw new Error(`Unexpected IPC: ${command}`);
        },
      },
    });
  }, { initial: createSeed('2026-09-25'), initialPending: pending });
  await page.goto('/?surface=edge-panel');
  await expect(page.locator('.edge-panel')).toBeVisible();
}
async function draft(page: Page, title: string) {
  await page.getByRole('button', { name: '添加今日任务', exact: true }).click();
  await page.getByRole('textbox', { name: '今日任务名称' }).fill(title);
}
async function quit(page: Page, requestId: number) {
  await page.evaluate(id => (window as any).__panelExit.emit('sidetask:exit-requested', { requestId: id, window: 'edge-panel' }), requestId);
}
async function replies(page: Page) {
  return page.evaluate(() => (window as any).__panelExit.calls.filter((call: any) => call.command === 'resolve_exit').map((call: any) => call.args));
}

test('小窗退出取消保留草稿并恢复编辑，显示确认使用受限原生入口', async ({ page }) => {
  await nativePanel(page); await draft(page, '退出前的小窗草稿'); await quit(page, 101);
  const dialog = page.getByRole('dialog', { name: '退出前保存今日任务？' });
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__panelExit.calls.some((call: any) => call.command === 'window_action' && call.args.action === 'showPanelExit' && call.args.payload.requestId === 101))).toBe(true);
  await expect(page.locator('.panel-exit-surface')).toHaveAttribute('inert', '');
  await dialog.getByRole('button', { name: '取消退出' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('textbox', { name: '今日任务名称' })).toHaveValue('退出前的小窗草稿');
  await expect(page.locator('.panel-exit-surface')).not.toHaveAttribute('inert', '');
  expect(await replies(page)).toEqual([{ requestId: 101, allow: false }]);
});

test('小窗退出保存失败不批准，重试提交同一任务后等待控制台并冻结新增', async ({ page }) => {
  await nativePanel(page); await draft(page, '退出时保存小窗任务');
  await page.evaluate(() => { (window as any).__panelExit.failMutation = true; });
  await quit(page, 102);
  const dialog = page.getByRole('dialog', { name: '退出前保存今日任务？' });
  await dialog.getByRole('button', { name: '保存并继续退出' }).click();
  await expect(dialog.getByRole('alert')).toContainText('保存未完成');
  await expect(page.locator('input[aria-label="今日任务名称"]')).toHaveValue('退出时保存小窗任务');
  expect(await replies(page)).toEqual([]);
  await page.evaluate(() => { (window as any).__panelExit.failMutation = false; });
  await dialog.getByRole('button', { name: '保存并继续退出' }).click();
  await expect(page.getByRole('dialog', { name: '正在确认退出' })).toBeVisible();
  expect(await replies(page)).toEqual([{ requestId: 102, allow: true }]);
  const snapshot = await page.evaluate(() => (window as any).__panelExit.snapshot());
  const tasks = snapshot.tasks.filter((task: any) => task.title === '退出时保存小窗任务');
  expect(tasks).toHaveLength(1);
  expect(snapshot.plans.some((plan: any) => plan.taskId === tasks[0].id && plan.date === '2026-09-25')).toBe(true);
  await expect(page.locator('.panel-exit-surface')).toHaveAttribute('inert', '');
  await page.evaluate(() => (window as any).__panelExit.emit('sidetask:exit-cancelled', { requestId: 102 }));
  await expect(page.locator('.panel-exit-surface')).not.toHaveAttribute('inert', '');
  await expect(page.getByRole('textbox', { name: '今日任务名称' })).toHaveValue('');
});

test('小窗放弃只确认自身阶段，等待中仍可取消整体退出', async ({ page }) => {
  await nativePanel(page); await draft(page, '明确放弃这份草稿'); await quit(page, 103);
  await page.getByRole('button', { name: '放弃并继续退出' }).click();
  const waiting = page.getByRole('dialog', { name: '正在确认退出' });
  await expect(waiting).toBeVisible();
  expect(await replies(page)).toEqual([{ requestId: 103, allow: true }]);
  expect(await page.evaluate(() => (window as any).__panelExit.calls.some((call: any) => call.command === 'mutate'))).toBe(false);
  await waiting.getByRole('button', { name: '取消退出' }).click();
  await expect(waiting).toBeHidden();
  expect(await replies(page)).toEqual([{ requestId: 103, allow: true }, { requestId: 103, allow: false }]);
  await expect(page.getByRole('textbox', { name: '今日任务名称' })).toHaveValue('');
});

test('小窗在途提交完成前不批准退出，完成后不重复新建', async ({ page }) => {
  await nativePanel(page); await draft(page, '正在保存时退出');
  await page.evaluate(() => { (window as any).__panelExit.delayMutation = true; });
  await page.getByRole('button', { name: '添加到今日', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__panelExit.calls.filter((call: any) => call.command === 'mutate').length)).toBe(1);
  await quit(page, 104);
  await expect(page.getByRole('button', { name: '保存并继续退出' })).toBeDisabled();
  expect(await replies(page)).toEqual([]);
  await page.evaluate(() => (window as any).__panelExit.releaseMutation());
  await expect(page.getByRole('dialog', { name: '正在确认退出' })).toBeVisible();
  expect(await replies(page)).toEqual([{ requestId: 104, allow: true }]);
  expect(await page.evaluate(() => (window as any).__panelExit.snapshot().tasks.filter((task: any) => task.title === '正在保存时退出').length)).toBe(1);
});

test('重新接入已批准的小窗保持冻结，不重复批准控制台阶段', async ({ page }) => {
  await nativePanel(page, { requestId: 105, window: 'console' });
  await expect(page.getByRole('dialog', { name: '正在确认退出' })).toBeVisible();
  expect(await replies(page)).toEqual([]);
  await expect(page.locator('.panel-exit-surface')).toHaveAttribute('inert', '');
  await page.evaluate(() => (window as any).__panelExit.emit('sidetask:exit-cancelled', { requestId: 105 }));
  await expect(page.locator('.panel-exit-surface')).not.toHaveAttribute('inert', '');
  await draft(page, '取消退出后继续添加');
});

test('控制台取消先于小窗放弃回执，迟到回执不清空新草稿或新退出请求', async ({ page }) => {
  await nativePanel(page); await draft(page, '旧请求准备放弃');
  await page.evaluate(() => { (window as any).__panelExit.delayExit = true; });
  await quit(page, 106);
  await page.getByRole('button', { name: '放弃并继续退出' }).click();
  await expect.poll(() => replies(page)).toEqual([{ requestId: 106, allow: true }]);
  await page.evaluate(() => {
    (window as any).__panelExit.emit('sidetask:exit-cancelled', { requestId: 106 });
    (window as any).__panelExit.delayExit = false;
  });
  // A native event queues a React render. Wait until a real user could type;
  // Playwright fill can target an input before its inert ancestor is removed.
  await expect(page.locator('.panel-exit-surface')).not.toHaveAttribute('inert', '');
  await expect(page.getByRole('dialog', { name: '退出前保存今日任务？' })).toBeHidden();
  await page.getByRole('textbox', { name: '今日任务名称' }).fill('取消后重新输入的新草稿');
  await expect(page.getByRole('textbox', { name: '今日任务名称' })).toHaveValue('取消后重新输入的新草稿');
  await quit(page, 107);
  await page.evaluate(() => (window as any).__panelExit.releaseExit());
  const dialog = page.getByRole('dialog', { name: '退出前保存今日任务？' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('input[aria-label="今日任务名称"]')).toHaveValue('取消后重新输入的新草稿');
  await dialog.getByRole('button', { name: '取消退出' }).click();
  expect(await replies(page)).toEqual([{ requestId: 106, allow: true }, { requestId: 107, allow: false }]);
});
