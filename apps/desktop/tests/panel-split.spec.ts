import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot } from '../src/lib/types';

const key = 'sidetask-browser-preview-v1';
const label = '调整今日与截止日期区域的比例';
type Probe = { writes: Snapshot[]; locks: boolean[]; fail: boolean; pointerId?: number };
type ProbeWindow = Window & { panelProbe: Probe };
const separator = (page: Page) => page.getByRole('separator', { name: label, exact: true });
const initial = () => createSeed('2026-09-25');
async function ready(page: Page) {
  await page.setViewportSize({ width: 368, height: 610 });
  await page.clock.setFixedTime(new Date('2026-09-25T04:00:00.000Z'));
  await page.goto('/?surface=edge-panel');
  await expect(separator(page)).toBeVisible();
}
async function preview(context: BrowserContext, page: Page, snapshot = initial()) {
  await context.addInitScript(({ key, snapshot }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(snapshot));
    const probe: Probe = { writes: [], locks: [], fail: false };
    (window as ProbeWindow).panelProbe = probe;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key && probe.fail) throw new Error('合成分区保存失败');
      original.call(this, name, value);
      if (name === key) probe.writes.push(JSON.parse(value));
    };
    document.addEventListener('pointerdown', event => { probe.pointerId = event.pointerId; }, true);
    window.addEventListener('sidetask:preview-interaction', event => probe.locks.push(Boolean((event as CustomEvent).detail.locked)));
  }, { key, snapshot });
  await ready(page);
  return snapshot;
}
async function stored(page: Page): Promise<Snapshot> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key); }
async function writes(page: Page) { return page.evaluate(() => (window as ProbeWindow).panelProbe.writes); }
async function drag(page: Page, value: number) {
  const divider = separator(page);
  const handle = (await divider.boundingBox())!;
  const zones = (await page.locator('.edge-zones').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, zones.y + handle.height / 2 + (zones.height - handle.height) * value / 100, { steps: 4 });
  await expect(divider).toHaveAttribute('aria-valuenow', String(value));
}
async function repeatKey(page: Page, name: string, count: number) {
  await separator(page).focus();
  for (let index = 0; index < count; index++) await page.keyboard.down(name);
}

// The native protocol harness records commands while using the actual preview
// domain implementation for commits. It does not certify OS focus or geometry.
async function nativeHarness(page: Page) {
  const snapshot = initial();
  await page.addInitScript(initial => {
    let current = initial;
    let next = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const probe = { calls: [] as { command: string; args: any }[], pointerId: 0, delayMutation: false, releaseMutation: () => {}, snapshot: () => structuredClone(current) };
    document.addEventListener('pointerdown', event => { probe.pointerId = event.pointerId; }, true);
    Object.assign(window, {
      splitHarness: probe,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => listeners.delete(id) },
      __TAURI_INTERNALS__: {
        transformCallback(callback: (value: unknown) => void) { const id = ++next; callbacks.set(id, callback); return id; },
        async invoke(command: string, args: any = {}) {
          probe.calls.push({ command, args });
          if (command === 'plugin:event|listen') { const id = ++next; listeners.set(id, args); return id; }
          if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
          if (command === 'get_snapshot') return structuredClone(current);
          if (command === 'get_pending_exit') return null;
          if (command === 'window_action') return;
          if (command === 'mutate') {
            if (probe.delayMutation) await new Promise<void>(resolve => { probe.releaseMutation = resolve; });
            const path = '/src/lib/domain.ts';
            const domain = await import(path);
            current = domain.applyPreviewAction(current, args.action, args.expectedRevision);
            return structuredClone(current);
          }
          if (command === 'get_pending_exit') return null;
          throw new Error(`Unexpected IPC: ${command}`);
        },
      },
    });
  }, snapshot);
  await ready(page);
  await page.evaluate(() => { (window as any).splitHarness.calls = []; });
  return snapshot;
}
async function mutationCalls(page: Page) {
  return page.evaluate(() => (window as any).splitHarness.calls.filter((call: any) => call.command === 'mutate'));
}
async function assertOnlyInteraction(page: Page, explicitPointer = false) {
  const calls = await page.evaluate(() => (window as any).splitHarness.calls.filter((call: any) => call.command === 'window_action'));
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((call: any) => call.args.action === 'interaction' || (explicitPointer && call.args.action === 'focusPanel'))).toBe(true);
  expect(calls.at(-1).args.payload.locked).toBe(false);
}

test('保留挂载的小窗隐藏取消未松开的分区键盘调整，重新显示仍是已存比例', async ({ page, context }) => {
  const before = await preview(context, page);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/?surface=console');
  await page.locator('.sidebar').getByRole('button', { name: '打开边缘小窗', exact: true }).click();
  const panel = page.getByTestId('browser-edge-preview');
  const divider = panel.getByRole('separator', { name: label, exact: true });
  await divider.focus();
  await page.keyboard.down('ArrowDown');
  await expect(divider).toHaveAttribute('aria-valuenow', '59');
  await panel.getByRole('button', { name: '收起小窗', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
  await expect(divider).toBeHidden();
  await page.keyboard.up('ArrowDown');
  await page.locator('.sidebar').getByRole('button', { name: '打开边缘小窗', exact: true }).click();
  await expect(divider).toHaveAttribute('aria-valuenow', '54');
  expect(await writes(page)).toEqual([]);
  expect(await stored(page)).toEqual(before);
});

test('拖动仅在松手保存一次，重载和另一窗口恢复比例且任务计划不变', async ({ page, context }) => {
  const before = await preview(context, page);
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '54');
  const other = await context.newPage();
  await ready(other);
  await drag(page, 65);
  expect(await writes(page)).toHaveLength(0);
  expect((await stored(page)).settings.panelSplit).toBe(54);
  await page.mouse.up();
  await expect.poll(async () => (await stored(page)).settings.panelSplit).toBe(65);
  expect(await writes(page)).toHaveLength(1);
  await expect(separator(other)).toHaveAttribute('aria-valuenow', '65');
  const committed = await stored(page);
  expect(committed.tasks).toEqual(before.tasks);
  expect(committed.plans).toEqual(before.plans);
  expect(committed.settings).toEqual({ ...before.settings, panelSplit: 65 });
  expect(committed.revision).toBe(before.revision + 1);
  expect((await page.evaluate(() => (window as ProbeWindow).panelProbe.locks)).at(-1)).toBe(false);
  await page.reload();
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '65');
  expect(await stored(page)).toEqual(committed);
});

test('取消和真实捕获丢失回退且释放锁，非主指针不启动，正常松手只提交一次', async ({ page }) => {
  const before = await nativeHarness(page);
  const divider = separator(page);
  await drag(page, 66);
  await divider.evaluate(element => element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: (window as any).splitHarness.pointerId, isPrimary: true, button: 0 })));
  await page.mouse.up();
  await expect(divider).toHaveAttribute('aria-valuenow', '54');
  expect(await mutationCalls(page)).toHaveLength(0);
  await assertOnlyInteraction(page, true);

  await drag(page, 38);
  await divider.evaluate(element => element.releasePointerCapture((window as any).splitHarness.pointerId));
  await page.mouse.move(180, 210);
  await page.mouse.up();
  await expect(divider).toHaveAttribute('aria-valuenow', '54');
  expect(await mutationCalls(page)).toHaveLength(0);
  await assertOnlyInteraction(page, true);
  const callCount = await page.evaluate(() => (window as any).splitHarness.calls.length);
  await divider.dispatchEvent('pointerdown', { pointerId: 91, pointerType: 'touch', isPrimary: false, button: 0, bubbles: true });
  await divider.dispatchEvent('pointerdown', { pointerId: 92, pointerType: 'mouse', isPrimary: true, button: 2, bubbles: true });
  expect(await page.evaluate(() => (window as any).splitHarness.calls.length)).toBe(callCount);
  await expect(divider).toHaveAttribute('aria-valuenow', '54');

  await drag(page, 61);
  expect(await mutationCalls(page)).toHaveLength(0);
  await page.mouse.up();
  await expect.poll(async () => (await mutationCalls(page)).length).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as any).splitHarness.snapshot().settings.panelSplit)).toBe(61);
  await assertOnlyInteraction(page, true);
  expect((await mutationCalls(page))[0].args.action).toEqual({ type: 'updateSettings', changes: { panelSplit: 61 } });
  const committed = await page.evaluate(() => (window as any).splitHarness.snapshot());
  expect(committed.tasks).toEqual(before.tasks);
  expect(committed.plans).toEqual(before.plans);
});

test('键盘连发在keyup或失焦合并提交，不调用原生几何或显隐命令', async ({ page }) => {
  await nativeHarness(page);
  await repeatKey(page, 'ArrowDown', 3);
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '69');
  expect(await mutationCalls(page)).toHaveLength(0);
  await page.evaluate(() => { (window as any).splitHarness.delayMutation = true; });
  await page.keyboard.up('ArrowDown');
  await expect.poll(async () => (await mutationCalls(page)).length).toBe(1);
  await expect(separator(page)).toHaveAttribute('aria-disabled', 'true');
  expect(await page.evaluate(() => (window as any).splitHarness.snapshot().settings.panelSplit)).toBe(54);
  await expect.poll(() => page.evaluate(() => (window as any).splitHarness.calls.filter((call: any) => call.command === 'window_action').at(-1).args.payload.locked)).toBe(true);
  await page.keyboard.press('ArrowDown');
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '69');
  expect(await mutationCalls(page)).toHaveLength(1);
  await page.evaluate(() => { const harness = (window as any).splitHarness; harness.delayMutation = false; harness.releaseMutation(); });
  await expect.poll(() => page.evaluate(() => (window as any).splitHarness.snapshot().settings.panelSplit)).toBe(69);
  await repeatKey(page, 'ArrowUp', 2);
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '59');
  expect(await mutationCalls(page)).toHaveLength(1);
  await page.getByRole('button', { name: '打开设置', exact: true }).focus();
  await page.keyboard.up('ArrowUp');
  await expect.poll(async () => (await mutationCalls(page)).length).toBe(2);
  await expect.poll(() => page.evaluate(() => (window as any).splitHarness.snapshot().settings.panelSplit)).toBe(59);
  await assertOnlyInteraction(page);
  expect((await mutationCalls(page)).map((call: any) => call.args.action)).toEqual([
    { type: 'updateSettings', changes: { panelSplit: 69 } },
    { type: 'updateSettings', changes: { panelSplit: 59 } },
  ]);
});

test('保存失败保留比例草稿，支持重试或恢复已保存比例并释放交互锁', async ({ page, context }) => {
  const before = await preview(context, page);
  await page.evaluate(() => { (window as ProbeWindow).panelProbe.fail = true; });
  await repeatKey(page, 'ArrowDown', 1);
  await page.keyboard.up('ArrowDown');
  await expect(page.getByText('分区比例未保存，请重试。', { exact: true })).toBeVisible();
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '59');
  await expect(separator(page)).toHaveAttribute('aria-disabled', 'true');
  expect(await stored(page)).toEqual(before);
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).panelProbe.locks.at(-1))).toBe(false);
  await page.evaluate(() => { (window as ProbeWindow).panelProbe.fail = false; });
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect.poll(async () => (await stored(page)).settings.panelSplit).toBe(59);
  await expect(separator(page)).toHaveAttribute('aria-disabled', 'false');
  const committed = await stored(page);
  expect(committed.tasks).toEqual(before.tasks);
  expect(committed.plans).toEqual(before.plans);

  await page.evaluate(() => { (window as ProbeWindow).panelProbe.fail = true; });
  await repeatKey(page, 'ArrowUp', 1);
  await page.keyboard.up('ArrowUp');
  await expect(page.getByText('分区比例未保存，请重试。', { exact: true })).toBeVisible();
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '54');
  await page.getByRole('button', { name: '恢复已保存比例', exact: true }).click();
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '59');
  await expect(separator(page)).toHaveAttribute('aria-disabled', 'false');
  expect(await stored(page)).toEqual(committed);
  await page.reload();
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '59');
});

test('另一窗口改变同一比例时保留草稿并明确确认，只改比例不覆盖其他设置', async ({ page, context }) => {
  const before = await preview(context, page);
  await page.evaluate(() => { (window as ProbeWindow).panelProbe.fail = true; });
  await repeatKey(page, 'ArrowDown', 1);
  await page.keyboard.up('ArrowDown');
  await expect(page.getByText('分区比例未保存，请重试。', { exact: true })).toBeVisible();
  const other = await context.newPage();
  await ready(other);
  await repeatKey(other, 'ArrowDown', 2);
  await other.keyboard.up('ArrowDown');
  await expect.poll(async () => (await stored(other)).settings.panelSplit).toBe(64);
  await other.getByLabel('截止任务排序', { exact: true }).selectOption('priority');
  await expect.poll(async () => (await stored(other)).settings.ddlSort).toBe('priority');
  await expect(page.getByText('分区比例已在另一处改变，你的调整尚未保存。', { exact: true })).toBeVisible();
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '59');
  await expect(separator(page)).toHaveAttribute('aria-disabled', 'true');
  expect((await stored(page)).settings.panelSplit).toBe(64);
  expect(await writes(page)).toHaveLength(0);
  await page.evaluate(() => { (window as ProbeWindow).panelProbe.fail = false; });
  await page.getByRole('button', { name: '使用此比例', exact: true }).click();
  await expect.poll(async () => (await stored(page)).settings.panelSplit).toBe(59);
  await expect(separator(other)).toHaveAttribute('aria-valuenow', '59');
  const committed = await stored(page);
  expect(committed.settings.ddlSort).toBe('priority');
  expect(committed.tasks).toEqual(before.tasks);
  expect(committed.plans).toEqual(before.plans);
  expect(await writes(page)).toHaveLength(1);
});
