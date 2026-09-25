import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot } from '../src/lib/types';

const taskKey = 'sidetask-browser-preview-v1';
const guideKey = 'sidetask-usage-guide-seen-v1';
const guide = (page: Page) => page.locator('.usage-guide');
const acknowledge = (page: Page) => guide(page).getByRole('button', { name: '知道了', exact: true });
const openPanel = (page: Page) => guide(page).getByRole('button', { name: '打开边缘小窗', exact: true });
const settings = (page: Page) => page.locator('.sidebar').getByRole('button', { name: '设置', exact: true });
const seed = () => createSeed('2026-09-25');

async function ready(page: Page, query = '') {
  await page.clock.setFixedTime(new Date('2026-09-25T04:00:00.000Z'));
  await page.goto(`/?surface=console${query}`);
  await expect(page.locator('.console-shell')).toBeVisible();
}
async function preview(context: BrowserContext, page: Page, snapshot = seed(), seen = false) {
  await context.addInitScript(({ taskKey, guideKey, snapshot, seen }) => {
    if (localStorage.getItem(taskKey) === null) {
      localStorage.setItem(taskKey, JSON.stringify(snapshot));
      if (seen) localStorage.setItem(guideKey, '1');
    }
  }, { taskKey, guideKey, snapshot, seen });
  await ready(page);
}
async function stored(page: Page): Promise<Snapshot> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), taskKey);
}

// This harness exercises the IPC contract, not native storage or menu behavior.
async function native(page: Page, options: { readFails?: boolean; readDelay?: boolean } = {}) {
  const snapshot = seed();
  await page.addInitScript(({ snapshot, options }) => {
    let sequence = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const h = {
      readFails: !!options.readFails, readDelay: !!options.readDelay,
      ackFails: false, ackDelay: false, openFails: false,
      reads: [] as (() => void)[], acks: [] as (() => void)[],
      calls: [] as { command: string; args: any }[],
      releaseReads() { h.reads.splice(0).forEach(resolve => resolve()); },
      releaseAcks() { h.acks.splice(0).forEach(resolve => resolve()); },
      snapshot: () => structuredClone(snapshot),
    };
    Object.assign(window, {
      __guide: h,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => listeners.delete(id) },
      __TAURI_INTERNALS__: {
        transformCallback(callback: (value: unknown) => void) { const id = ++sequence; callbacks.set(id, callback); return id; },
        async invoke(command: string, args: any = {}) {
          h.calls.push({ command, args });
          if (command === 'plugin:event|listen') { const id = ++sequence; listeners.set(id, args); return id; }
          if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
          if (command === 'get_startup_recovery' || command === 'get_pending_exit') return null;
          if (command === 'get_snapshot') return structuredClone(snapshot);
          if (command === 'get_window_status' || command === 'get_console_position_status') return { pending: false, error: null };
          if (command === 'get_usage_guide_seen') {
            const captured = localStorage.getItem('synthetic-native-guide-seen') === '1';
            if (h.readDelay) await new Promise<void>(resolve => h.reads.push(resolve));
            if (h.readFails) throw new Error('合成说明读取失败');
            return captured;
          }
          if (command === 'acknowledge_usage_guide') {
            if (h.ackDelay) await new Promise<void>(resolve => h.acks.push(resolve));
            if (h.ackFails) throw new Error('合成说明写入失败');
            localStorage.setItem('synthetic-native-guide-seen', '1');
            return;
          }
          if (command === 'window_action') {
            if (args.action === 'showPanel' && h.openFails) throw new Error('合成小窗打开失败');
            return;
          }
          if (command === 'resolve_exit') return;
          throw new Error(`Unexpected IPC: ${command}`);
        },
      },
    });
  }, { snapshot, options });
  await ready(page);
  return snapshot;
}
async function assertNoMutations(page: Page, snapshot: Snapshot) {
  expect(await page.evaluate(() => (window as any).__guide.calls.filter((call: any) => call.command === 'mutate'))).toEqual([]);
  expect(await page.evaluate(() => (window as any).__guide.snapshot())).toEqual(snapshot);
}

// Each independent cold-start/reload case gets its own fixture and timeout;
// six contexts in one test exceeded CI's shared 30-second budget on Windows.
for (const kind of ['empty', 'active', 'trash']) for (const seen of [false, true]) {
  test(`首次说明独立于任务数量：${kind}，本机${seen ? '已确认' : '未确认'}，重载后设置仍保留说明`, async ({ context, page }) => {
    const snapshot = seed();
    if (kind === 'empty') { snapshot.tasks = []; snapshot.plans = []; }
    if (kind === 'trash') snapshot.tasks.forEach(task => { task.deletedAt = '2026-09-24T04:00:00.000Z'; });
    await preview(context, page, snapshot, seen);
    await expect(guide(page)).toHaveCount(seen ? 0 : 1);
    await expect(page.locator('.edge-panel')).toHaveCount(0);
    if (!seen) {
      await expect(guide(page)).toContainText('菜单栏或系统托盘');
      await acknowledge(page).focus();
      await page.keyboard.press('Enter');
      await expect(guide(page)).toHaveCount(0);
      await expect(page.getByRole('main', { name: '今日', exact: true })).toBeFocused();
    }
    expect(await stored(page)).toEqual(snapshot);
    expect(await page.evaluate(key => localStorage.getItem(key), guideKey)).toBe('1');
    await page.reload();
    await expect(page.locator('.console-shell')).toBeVisible();
    await expect(guide(page)).toHaveCount(0);
    await settings(page).click();
    await expect(guide(page).getByRole('heading', { name: '使用说明', exact: true })).toBeVisible();
    await expect(guide(page)).toContainText('退出 SideTask');
    await expect(acknowledge(page)).toHaveCount(0);
  });
}

test('读取与打开失败可重试，不默认展开或确认，读取恢复不卸载任务草稿', async ({ page }) => {
  const snapshot = await native(page, { readFails: true });
  await expect(page.locator('.usage-guide-status')).toContainText('合成说明读取失败');
  expect(await page.evaluate(() => (window as any).__guide.calls.filter((call: any) => call.command === 'window_action' && call.args.action === 'showPanel'))).toEqual([]);
  await page.getByRole('button', { name: `编辑任务：${snapshot.tasks[0].title}`, exact: true }).click();
  const title = page.locator('.task-detail').getByLabel('任务名称', { exact: true });
  await title.fill('读说明不丢失的任务草稿');
  await title.evaluate(element => { (window as any).__editor = element; });
  await page.evaluate(() => { (window as any).__guide.readFails = false; });
  await page.getByRole('button', { name: '重试读取', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(acknowledge(page)).toBeVisible();
  await expect(guide(page).getByRole('heading')).toBeFocused();
  await expect(title).toHaveValue('读说明不丢失的任务草稿');
  expect(await title.evaluate(element => element === (window as any).__editor)).toBe(true);
  await page.evaluate(() => { (window as any).__guide.openFails = true; });
  await openPanel(page).click();
  await expect(guide(page).getByRole('alert')).toContainText('合成小窗打开失败');
  await page.evaluate(() => { (window as any).__guide.openFails = false; });
  await openPanel(page).click();
  await expect(guide(page).getByRole('alert')).toHaveCount(0);
  await expect(acknowledge(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__guide.calls.filter((call: any) => call.command === 'acknowledge_usage_guide'))).toEqual([]);
  await assertNoMutations(page, snapshot);
});

test('键盘读取重试再次失败后聚焦新按钮，等待期间主动移走焦点则不抢回', async ({ page }) => {
  const snapshot = await native(page, { readFails: true });
  const retry = page.getByRole('button', { name: '重试读取', exact: true });
  await expect(retry).toBeVisible();
  await page.evaluate(() => { (window as any).__guide.readDelay = true; });
  await retry.focus(); await page.keyboard.press('Enter');
  await expect(retry).toHaveCount(0);
  await expect(page.locator('.usage-guide-status')).toContainText('正在读取使用说明');
  await page.evaluate(() => (window as any).__guide.releaseReads());
  await expect(page.locator('.usage-guide-status')).toContainText('合成说明读取失败');
  await expect(retry).toBeFocused();
  expect(await retry.evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none')).toBe(true);

  await page.keyboard.press('Enter');
  await expect(retry).toHaveCount(0);
  const search = page.getByRole('textbox', { name: '搜索任务', exact: true });
  await search.fill('读取等待期间继续查找');
  await page.evaluate(() => (window as any).__guide.releaseReads());
  await expect(retry).toBeVisible();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('读取等待期间继续查找');

  await page.evaluate(() => { const h = (window as any).__guide; h.readDelay = false; h.readFails = false; });
  await retry.focus(); await page.keyboard.press('Enter');
  await expect(guide(page).getByRole('heading')).toBeFocused();
  await assertNoMutations(page, snapshot);
});

test('慢确认失败保留说明和草稿，成功才隐藏，键盘确认还焦点但不打断继续编辑', async ({ page }) => {
  const snapshot = await native(page);
  await page.getByRole('button', { name: `编辑任务：${snapshot.tasks[0].title}`, exact: true }).click();
  const title = page.locator('.task-detail').getByLabel('任务名称', { exact: true });
  await title.fill('确认说明期间的草稿');
  await page.evaluate(() => { const h = (window as any).__guide; h.ackDelay = true; h.ackFails = true; });
  await acknowledge(page).focus();
  await page.keyboard.press('Enter');
  await expect(guide(page).getByRole('button', { name: '正在保存…', exact: true })).toBeDisabled();
  await title.fill('慢保存期间继续输入');
  await page.evaluate(() => (window as any).__guide.releaseAcks());
  await expect(guide(page).getByRole('alert')).toContainText('合成说明写入失败');
  await expect(title).toBeFocused();
  await expect(title).toHaveValue('慢保存期间继续输入');
  await expect(acknowledge(page)).toBeEnabled();
  await page.evaluate(() => { const h = (window as any).__guide; h.ackDelay = false; h.ackFails = false; });
  await acknowledge(page).focus();
  await page.keyboard.press('Enter');
  await expect(guide(page)).toHaveCount(0);
  const main = page.getByRole('main', { name: '今日', exact: true });
  await expect(main).toBeFocused();
  expect(await main.evaluate(element => element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none')).toBe(true);
  await expect(title).toHaveValue('慢保存期间继续输入');
  expect(await page.evaluate(() => (window as any).__guide.calls.filter((call: any) => call.command === 'acknowledge_usage_guide').map((call: any) => call.args))).toEqual([{}, {}]);
  await assertNoMutations(page, snapshot);
});

test('设置中的确认不覆盖未保存设置，晚到的首次读取不能撤销确认，重启仍记住', async ({ page }) => {
  const snapshot = await native(page, { readDelay: true });
  await expect(page.locator('.usage-guide-status')).toContainText('正在读取使用说明');
  await settings(page).click();
  const width = page.getByRole('spinbutton', { name: '小窗宽度', exact: true });
  await width.fill('499');
  await width.evaluate(element => { (window as any).__editor = element; });
  await acknowledge(page).focus();
  await page.keyboard.press('Enter');
  await expect(acknowledge(page)).toHaveCount(0);
  await expect(openPanel(page)).toBeFocused();
  await page.evaluate(() => { const h = (window as any).__guide; h.readDelay = false; h.releaseReads(); });
  await expect(acknowledge(page)).toHaveCount(0);
  await expect(width).toHaveValue('499');
  expect(await width.evaluate(element => element === (window as any).__editor)).toBe(true);
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  await assertNoMutations(page, snapshot);
  page.once('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page.locator('.console-shell')).toBeVisible();
  await expect(guide(page)).toHaveCount(0);
});

test('边缘入口暂停时解释如何开启，确认与设置草稿都不擅自开启小窗', async ({ page, context }) => {
  const snapshot = seed(); snapshot.settings.edgeEnabled = false;
  await preview(context, page, snapshot);
  await expect(guide(page)).toContainText('边缘入口已暂停，可在设置中开启');
  await expect(openPanel(page)).toBeDisabled();
  await acknowledge(page).click();
  expect(await stored(page)).toEqual(snapshot);
  await settings(page).click();
  await expect(openPanel(page)).toBeDisabled();
  await page.getByRole('switch', { name: '启用边缘入口', exact: true }).click();
  await expect(openPanel(page)).toBeDisabled();
  await expect(page.locator('.edge-panel')).toHaveCount(0);
  expect((await stored(page)).settings.edgeEnabled).toBe(false);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(openPanel(page)).toBeEnabled();
  await expect(guide(page)).not.toContainText('边缘入口已暂停');
  await expect(page.locator('.edge-panel')).toHaveCount(0);
  await openPanel(page).click();
  await expect(page.locator('.edge-panel')).toBeVisible();
  expect((await stored(page)).tasks).toEqual(snapshot.tasks);
  expect((await stored(page)).plans).toEqual(snapshot.plans);
});

test('浏览器标记写入失败不假装确认，重试成功只写独立标记并同步另一控制台', async ({ page, context }) => {
  await context.addInitScript(key => {
    const h = { fail: true, writes: [] as string[] }; (window as any).__localGuide = h;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key && h.fail) throw new DOMException('合成本机存储不可写', 'QuotaExceededError');
      original.call(this, name, value); h.writes.push(name);
    };
  }, guideKey);
  await preview(context, page);
  const other = await context.newPage(); await ready(other);
  await acknowledge(page).click();
  await expect(guide(page).getByRole('alert')).toContainText('合成本机存储不可写');
  await expect(guide(other)).toHaveCount(1);
  expect(await page.evaluate(key => localStorage.getItem(key), guideKey)).toBeNull();
  const before = await stored(page);
  await page.evaluate(() => { const h = (window as any).__localGuide; h.fail = false; h.writes = []; });
  await acknowledge(page).click();
  await expect(guide(page)).toHaveCount(0);
  await expect(guide(other)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__localGuide.writes)).toEqual([guideKey]);
  expect(await stored(page)).toEqual(before);
});

test('四种风格与浅深色的窄窗说明保持正常文档流和可用按钮', async ({ page, context }, testInfo) => {
  const snapshot = seed(); snapshot.tasks = []; snapshot.plans = [];
  await page.setViewportSize({ width: 640, height: 480 });
  await preview(context, page, snapshot);
  for (const uiStyle of ['paper', 'studio', 'editorial', 'mono'] as const) for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(({ key, uiStyle, theme }) => {
      const snapshot = JSON.parse(localStorage.getItem(key)!);
      snapshot.settings.uiStyle = uiStyle; snapshot.settings.theme = theme;
      localStorage.setItem(key, JSON.stringify(snapshot));
    }, { key: taskKey, uiStyle, theme });
    await page.reload();
    await expect(guide(page)).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    for (const button of [openPanel(page), acknowledge(page), page.getByRole('button', { name: '新建任务', exact: true })]) {
      await expect(button).toBeInViewport();
      await button.click({ trial: true });
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.x + bounds.width).toBeLessThanOrEqual(640);
    }
    await openPanel(page).focus(); await page.keyboard.press('Tab');
    await expect(acknowledge(page)).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`guide-${uiStyle}-${theme}-640x480.png`) });
  }
});
