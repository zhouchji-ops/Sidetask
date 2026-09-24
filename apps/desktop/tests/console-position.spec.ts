import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';

type PositionStatus = { pending: boolean; error: string | null };
const eventName = 'sidetask:console-position-status';
const banner = (page: Page) => page.locator('.console-position-status');
const retry = (page: Page) => page.getByRole('button', { name: '重试保存位置', exact: true });
const discard = (page: Page) => page.getByRole('button', { name: '不保存本次位置', exact: true });

// Synthetic native protocol only: no real window moves or personal database.
async function setup(page: Page, queryFailures = 0) {
  const snapshot = createSeed('2026-09-25');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-09-25T04:00:00Z'));
  await page.addInitScript(({ snapshot, queryFailures, eventName }) => {
    let sequence = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const harness = {
      status: { pending: true, error: '合成窗口位置写入失败' } as PositionStatus,
      calls: [] as { command: string; args: any }[],
      queryFailures, delayQuery: false, delayAction: false, failAction: false,
      releaseQuery: () => {}, releaseAction: () => {}, editor: null as Element | null,
      snapshot: () => structuredClone(snapshot),
      activeListeners: () => [...listeners.values()].filter(listener => listener.event === eventName).length,
      emit(status: PositionStatus) {
        harness.status = status;
        for (const [id, listener] of listeners) if (listener.event === eventName) callbacks.get(listener.handler)?.({ id, event: eventName, payload: status });
      },
    };
    Object.assign(window, {
      __position: harness,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => listeners.delete(id) },
      __TAURI_INTERNALS__: {
        transformCallback(callback: (value: unknown) => void) { const id = ++sequence; callbacks.set(id, callback); return id; },
        async invoke(command: string, args: any = {}) {
          harness.calls.push({ command, args });
          if (command === 'plugin:event|listen') { const id = ++sequence; listeners.set(id, args); return id; }
          if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
          if (command === 'get_startup_recovery' || command === 'get_pending_exit') return null;
          if (command === 'get_snapshot') return structuredClone(snapshot);
          if (command === 'get_window_status') return { pending: false, error: null };
          if (command === 'get_console_position_status') {
            if (harness.queryFailures > 0) { harness.queryFailures--; throw new Error('合成位置状态读取失败'); }
            const captured = structuredClone(harness.status);
            if (harness.delayQuery) await new Promise<void>(resolve => { harness.releaseQuery = resolve; });
            return captured;
          }
          if (command === 'window_action') {
            if (args.action === 'retryConsolePosition' || args.action === 'discardConsolePosition') {
              if (harness.delayAction) await new Promise<void>(resolve => { harness.releaseAction = resolve; });
              if (harness.failAction) {
                harness.status = { pending: true, error: '合成位置操作再次失败' };
                throw new Error(harness.status.error!);
              }
              // No event: the component must query after either action.
              harness.status = { pending: false, error: null };
            }
            return;
          }
          if (command === 'resolve_exit') return;
          throw new Error(`Unexpected IPC: ${command}`);
        },
      },
    });
  }, { snapshot, queryFailures, eventName });
  await page.goto('/?surface=console');
  await expect(page.getByRole('heading', { name: '今日', exact: true })).toBeVisible();
  return { snapshot, errors };
}
async function positionActions(page: Page) {
  return page.evaluate(() => (window as any).__position.calls.filter((call: any) => call.command === 'window_action' && ['retryConsolePosition', 'discardConsolePosition'].includes(call.args.action)).map((call: any) => call.args.action));
}
async function queryCount(page: Page) {
  return page.evaluate(() => (window as any).__position.calls.filter((call: any) => call.command === 'get_console_position_status').length);
}
async function assertNoTaskWrites(page: Page) {
  expect(await page.evaluate(() => (window as any).__position.calls.filter((call: any) => call.command === 'mutate'))).toEqual([]);
}
async function editDraft(page: Page, title: string) {
  await page.getByRole('button', { name: `编辑任务：${title}`, exact: true }).click();
  const input = page.locator('.task-detail').getByLabel('任务名称', { exact: true });
  await input.fill('位置操作期间仍需保留的任务草稿');
  await input.evaluate(element => { (window as any).__position.editor = element; });
  return input;
}

test('先订阅位置状态再查询，初始错误与后续事件可见且慢查询不覆盖新错误', async ({ page }, testInfo) => {
  const { errors } = await setup(page);
  await expect(banner(page)).toContainText('本次窗口位置未保存');
  await expect(banner(page)).toContainText('合成窗口位置写入失败');
  const registration = await page.evaluate(eventName => {
    const h = (window as any).__position;
    return { listen: h.calls.findIndex((call: any) => call.command === 'plugin:event|listen' && call.args.event === eventName), query: h.calls.findIndex((call: any) => call.command === 'get_console_position_status'), active: h.activeListeners() };
  }, eventName);
  expect(registration.listen).toBeGreaterThanOrEqual(0);
  expect(registration.query).toBeGreaterThan(registration.listen);
  expect(registration.active).toBe(1);
  for (const size of [{ width: 1800, height: 1000 }, { width: 640, height: 480 }]) {
    await page.setViewportSize(size);
    for (const control of [banner(page), retry(page), discard(page)]) {
      await expect(control).toBeVisible();
      const bounds = (await control.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height);
    }
    await retry(page).click({ trial: true });
    await discard(page).click({ trial: true });
    await page.screenshot({ path: testInfo.outputPath(`position-error-${size.width}x${size.height}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 960 });

  await page.evaluate(() => (window as any).__position.emit({ pending: true, error: null }));
  await expect(banner(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).__position.emit({ pending: true, error: '重新移动后的保存失败' }));
  await expect(banner(page)).toContainText('重新移动后的保存失败');
  await page.evaluate(() => { (window as any).__position.delayQuery = true; });
  const before = await queryCount(page);
  await retry(page).click();
  await expect.poll(() => queryCount(page)).toBe(before + 1);
  await page.evaluate(() => (window as any).__position.emit({ pending: true, error: '查询期间的新失败' }));
  await page.evaluate(() => { const h = (window as any).__position; h.delayQuery = false; h.releaseQuery(); });
  await expect(retry(page)).toBeEnabled();
  await expect(banner(page)).toContainText('查询期间的新失败');
  await page.evaluate(() => (window as any).__position.emit({ pending: false, error: null }));
  await expect(banner(page)).toHaveCount(0);
  await assertNoTaskWrites(page);
  expect(errors).toEqual([]);
});

test('慢重试冻结重复入口但可继续编辑任务，失败可重试且不卸载草稿', async ({ page, browserName }) => {
  if (browserName === 'chromium') {
    // A slow React commit must not leave the re-enabled retry button unfocused.
    const renderer = await page.context().newCDPSession(page);
    await renderer.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  const { snapshot, errors } = await setup(page);
  const input = await editDraft(page, snapshot.tasks[0].title);
  await page.evaluate(() => { const h = (window as any).__position; h.delayAction = true; h.failAction = true; });
  await retry(page).click();
  await expect(retry(page)).toBeDisabled();
  await expect(discard(page)).toBeDisabled();
  await retry(page).evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
  await discard(page).evaluate(element => (element as HTMLButtonElement).click());
  expect(await positionActions(page)).toEqual(['retryConsolePosition']);
  await expect(input).toBeEnabled();
  await input.fill('慢保存期间继续输入，不保存这份任务草稿');
  await page.evaluate(() => { const h = (window as any).__position; h.delayAction = false; h.releaseAction(); });
  await expect(banner(page)).toContainText('合成位置操作再次失败');
  await expect(retry(page)).toBeEnabled();
  await expect(discard(page)).toBeEnabled();
  await expect(input).toHaveValue('慢保存期间继续输入，不保存这份任务草稿');
  await expect(input).toBeFocused();
  // Repeating a failed action from the keyboard must keep its retry entry.
  await page.evaluate(() => { (window as any).__position.delayAction = true; });
  await retry(page).focus();
  await expect(retry(page)).toBeFocused();
  expect(await page.evaluate(() => document.hasFocus())).toBe(true);
  await page.keyboard.press('Enter');
  await expect(retry(page)).toBeDisabled();
  await page.evaluate(() => { const h = (window as any).__position; h.delayAction = false; h.releaseAction(); });
  await expect(retry(page)).toBeEnabled();
  expect(await page.evaluate(() => document.hasFocus())).toBe(true);
  await expect(retry(page)).toBeFocused();
  await page.evaluate(() => { (window as any).__position.failAction = false; });
  await retry(page).click();
  await expect(banner(page)).toHaveCount(0);
  await expect(input).toHaveValue('慢保存期间继续输入，不保存这份任务草稿');
  expect(await input.evaluate(element => (window as any).__position.editor === element)).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '今日', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__position.snapshot())).toEqual(snapshot);
  expect(await positionActions(page)).toEqual(['retryConsolePosition', 'retryConsolePosition', 'retryConsolePosition']);
  await assertNoTaskWrites(page);
  expect(errors).toEqual([]);
});

test('不保存本次位置仅处理设备状态，重新查询后消失并保留当前草稿', async ({ page }) => {
  const { snapshot, errors } = await setup(page);
  const input = await editDraft(page, snapshot.tasks[0].title);
  const before = await queryCount(page);
  await discard(page).click();
  await expect(banner(page)).toHaveCount(0);
  expect(await queryCount(page)).toBe(before + 1);
  expect(await positionActions(page)).toEqual(['discardConsolePosition']);
  await expect(input).toHaveValue('位置操作期间仍需保留的任务草稿');
  expect(await input.evaluate(element => (window as any).__position.editor === element)).toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await assertNoTaskWrites(page);
  expect(await page.evaluate(() => (window as any).__position.snapshot())).toEqual(snapshot);
  expect(errors).toEqual([]);
});

test('初次查询失败显示未知状态，重试可恢复且没有未捕获异常', async ({ page }) => {
  const { errors } = await setup(page, 1);
  await expect(banner(page)).toContainText('暂时无法确认窗口位置是否已保存');
  await expect(banner(page)).toContainText('合成位置状态读取失败');
  await retry(page).click();
  await expect(banner(page)).toHaveCount(0);
  expect(await queryCount(page)).toBe(2);
  expect(await positionActions(page)).toEqual(['retryConsolePosition']);
  expect(await page.evaluate(() => (window as any).__position.activeListeners())).toBe(1);
  await assertNoTaskWrites(page);
  expect(errors).toEqual([]);
});

test('浏览器预览没有位置状态反馈，也不调用原生查询或事件 API', async ({ page }) => {
  const errors: string[] = [];
  const mockedModules = new Set<string>();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(snapshot => {
    (window as any).__previewIpcCalls = [];
    localStorage.setItem('sidetask-browser-preview-v1', JSON.stringify(snapshot));
  }, createSeed('2026-09-25'));
  await page.route('**/node_modules/.vite/deps/@tauri-apps_api_core.js*', route => {
    mockedModules.add('core');
    return route.fulfill({ contentType: 'text/javascript', body: 'export async function invoke(command) { window.__previewIpcCalls.push(command); throw new Error("Unexpected preview IPC"); }' });
  });
  await page.route('**/node_modules/.vite/deps/@tauri-apps_api_event.js*', route => {
    mockedModules.add('event');
    return route.fulfill({ contentType: 'text/javascript', body: 'export async function listen(event) { window.__previewIpcCalls.push(event); return () => {}; }' });
  });
  await page.goto('/?surface=console');
  await expect(page.getByRole('heading', { name: '今日', exact: true })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await expect(retry(page)).toHaveCount(0);
  await expect(discard(page)).toHaveCount(0);
  expect([...mockedModules].sort()).toEqual(['core', 'event']);
  expect(await page.evaluate(() => (window as any).__previewIpcCalls)).toEqual([]);
  expect(errors).toEqual([]);
});
