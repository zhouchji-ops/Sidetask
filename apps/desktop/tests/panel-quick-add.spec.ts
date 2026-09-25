import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';

const storageKey = 'sidetask-browser-preview-v1';
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-25T04:00:00Z'));
});
async function panel(page: Page) {
  await page.setViewportSize({ width: 368, height: 610 });
  await page.goto('/?surface=edge-panel');
  await page.getByRole('button', { name: '添加今日任务', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '今日任务名称' })).toBeFocused();
}

test('小窗连续新建直接加入今日，同事务保留原任务并同步控制台', async ({ page, context }) => {
  await panel(page);
  const initial = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
  const consolePage = await context.newPage();
  await consolePage.clock.setFixedTime(new Date('2026-09-25T04:00:00Z'));
  await consolePage.goto('/?surface=console');
  const input = page.getByRole('textbox', { name: '今日任务名称' });
  await input.fill('小窗写作练习');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: '完成：小窗写作练习', exact: true })).toBeVisible();
  await expect(consolePage.locator('.main-content').getByRole('button', { name: '完成：小窗写作练习', exact: true })).toBeVisible();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await input.fill('小窗阅读练习');
  await page.getByRole('button', { name: '添加到今日', exact: true }).click();
  // Clicking dispatches the async transaction; wait for its committed UI before
  // reading storage, including on runners where navigator.locks resolves later.
  await expect(page.getByRole('button', { name: '完成：小窗阅读练习', exact: true })).toBeVisible();
  await expect(consolePage.locator('.main-content').getByRole('button', { name: '完成：小窗阅读练习', exact: true })).toBeVisible();
  const next = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
  expect(next.tasks.slice(0, initial.tasks.length)).toEqual(initial.tasks);
  expect(next.revision).toBe(initial.revision + 2);
  for (const title of ['小窗写作练习', '小窗阅读练习']) {
    const task = next.tasks.find((value: any) => value.title === title);
    expect(task.dueDate).toBeNull();
    expect(task.completed).toBe(false);
    expect(next.plans.filter((plan: any) => plan.taskId === task.id)).toEqual([{ taskId: task.id, date: '2026-09-25', sortOrder: expect.any(Number) }]);
  }
  await expect(page).toHaveURL(/surface=edge-panel$/);
  await page.reload();
  await expect(page.getByRole('button', { name: '完成：小窗阅读练习', exact: true })).toBeVisible();
});

test('空输入不提交，中文候选确认不误建，收起输入前确认保留草稿', async ({ page }) => {
  await panel(page);
  const initial = await page.evaluate(key => localStorage.getItem(key), storageKey);
  const input = page.getByRole('textbox', { name: '今日任务名称' });
  await input.fill('   ');
  await page.getByRole('button', { name: '添加到今日', exact: true }).click();
  await expect(page.locator('.edge-quick-add-error')).toContainText('请输入任务名称');
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(initial);
  await input.fill('中文任务');
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: '完成：中文任务', exact: true })).toHaveCount(0);
  await input.dispatchEvent('compositionend');
  await page.getByRole('button', { name: '收起添加任务', exact: true }).click();
  await expect(page.getByRole('group', { name: '处理今日任务草稿', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(input).toHaveValue('中文任务');
  await expect(input).toBeFocused();
  await input.press('Escape');
  await page.getByRole('button', { name: '放弃草稿', exact: true }).click();
  await expect(input).toBeHidden();
  await page.getByRole('button', { name: '添加今日任务', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(initial);
});

// Failure/quit messages use a frontend IPC harness; native permissions and
// multi-window exit sequencing are independently exercised in Rust/native runs.
async function nativePanel(page: Page) {
  await page.addInitScript(initial => {
    let snapshot = initial; let sequence = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const harness = { fail: false, delay: false, release: () => {}, calls: [] as any[],
      emit(event: string, payload: unknown) { for (const [id, listener] of listeners) if (listener.event === event) callbacks.get(listener.handler)?.({ id, event, payload }); },
      snapshot: () => snapshot,
    };
    Object.assign(window, { __quick: harness,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_: string, id: number) => listeners.delete(id) },
      __TAURI_INTERNALS__: {
        transformCallback(callback: (value: unknown) => void) { const id = ++sequence; callbacks.set(id, callback); return id; },
        async invoke(command: string, args: any = {}) {
          harness.calls.push({ command, args });
          if (command === 'plugin:event|listen') { const id = ++sequence; listeners.set(id, args); return id; }
          if (command === 'plugin:event|unlisten') return listeners.delete(args.eventId);
          if (command === 'get_snapshot') return structuredClone(snapshot);
          if (command === 'get_pending_exit') return null;
          if (command === 'window_action') return;
          if (command === 'resolve_exit') {
            if (!args.allow) harness.emit('sidetask:exit-cancelled', { requestId: args.requestId });
            return;
          }
          if (command === 'mutate') {
            if (harness.delay) await new Promise<void>(resolve => { harness.release = resolve; });
            if (harness.fail) throw new Error('写入失败，请重试');
            const modulePath = '/src/lib/domain.ts';
            snapshot = (await import(modulePath)).applyPreviewAction(snapshot, args.action, args.expectedRevision);
            return structuredClone(snapshot);
          }
          throw new Error(`Unexpected ${command}`);
        },
      },
    });
  }, createSeed('2026-09-25'));
  await panel(page);
}

test('失败保留草稿，保存中阻止重复提交且持有防收起锁', async ({ page }) => {
  await nativePanel(page);
  const input = page.getByRole('textbox', { name: '今日任务名称' });
  await input.fill('失败后仍在的草稿');
  await page.evaluate(() => { (window as any).__quick.fail = true; });
  await page.getByRole('button', { name: '添加到今日', exact: true }).click();
  await expect(page.locator('.edge-quick-add-error')).toContainText('写入失败');
  await expect(input).toHaveValue('失败后仍在的草稿');
  await page.evaluate(() => { (window as any).__quick.fail = false; (window as any).__quick.delay = true; });
  await input.press('Enter');
  await expect(input).toBeDisabled();
  await expect(page.getByRole('button', { name: '添加到今日', exact: true })).toBeDisabled();
  await page.getByRole('form', { name: '快速添加今日任务', exact: true }).evaluate(element => {
    element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  const calls = await page.evaluate(() => (window as any).__quick.calls);
  expect(calls.filter((call: any) => call.command === 'mutate')).toHaveLength(2);
  expect(calls.filter((call: any) => call.args.action === 'interaction').at(-1).args.payload.locked).toBe(true);
  expect(calls.some((call: any) => call.args.action === 'openConsole')).toBe(false);
  await page.evaluate(() => { (window as any).__quick.delay = false; (window as any).__quick.release(); });
  await expect(input).toHaveValue('');
  expect(await page.evaluate(() => (window as any).__quick.snapshot().tasks.filter((task: any) => task.title === '失败后仍在的草稿'))).toHaveLength(1);
});

test('小窗草稿退出可取消，保存失败不能批准退出，重试后才批准', async ({ page }) => {
  await nativePanel(page);
  const input = page.getByRole('textbox', { name: '今日任务名称' });
  await input.fill('退出前的小窗任务');
  await page.evaluate(() => (window as any).__quick.emit('sidetask:exit-requested', { requestId: 4, window: 'console' }));
  await expect(page.getByRole('dialog', { name: '正在确认退出', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '退出前保存今日任务？', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__quick.calls.filter((call: any) => call.command === 'resolve_exit'))).toEqual([]);
  await page.evaluate(() => (window as any).__quick.emit('sidetask:exit-cancelled', { requestId: 4 }));
  await expect(page.locator('.panel-exit-surface')).not.toHaveAttribute('inert', '');
  await page.evaluate(() => (window as any).__quick.emit('sidetask:exit-requested', { requestId: 5, window: 'edge-panel' }));
  await page.getByRole('button', { name: '取消退出', exact: true }).click();
  await expect(input).toHaveValue('退出前的小窗任务');
  await expect(input).toBeFocused();
  await page.evaluate(() => { (window as any).__quick.fail = true; (window as any).__quick.emit('sidetask:exit-requested', { requestId: 6, window: 'edge-panel' }); });
  await page.getByRole('button', { name: '保存并继续退出', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '退出前保存今日任务？', exact: true }).getByRole('alert')).toContainText('保存未完成');
  await expect(page.locator('.edge-quick-add-error')).toContainText('写入失败');
  expect(await page.evaluate(() => (window as any).__quick.calls.filter((call: any) => call.command === 'resolve_exit'))).toEqual([{ command: 'resolve_exit', args: { requestId: 5, allow: false } }]);
  await page.evaluate(() => { (window as any).__quick.fail = false; });
  await page.getByRole('button', { name: '保存并继续退出', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__quick.calls.filter((call: any) => call.command === 'resolve_exit').at(-1))).toEqual({ command: 'resolve_exit', args: { requestId: 6, allow: true } });
  await expect(page.getByRole('dialog', { name: '正在确认退出', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__quick.snapshot().tasks.filter((task: any) => task.title === '退出前的小窗任务'))).toHaveLength(1);
});

for (const style of ['paper', 'studio', 'editorial', 'mono']) for (const theme of ['light', 'dark']) {
  test(`最小小窗输入与添加可触达且不水平溢出：${style}/${theme}`, async ({ page }) => {
    await panel(page);
    await page.setViewportSize({ width: 300, height: 380 });
    await page.evaluate(({ style, theme }) => { document.documentElement.dataset.style = style; document.documentElement.dataset.theme = theme; }, { style, theme });
    await expect(page.getByRole('textbox', { name: '今日任务名称' })).toBeInViewport();
    await expect(page.getByRole('button', { name: '添加到今日', exact: true })).toBeInViewport();
    expect(await page.locator('.edge-panel').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  });
}
