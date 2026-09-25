import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot } from '../src/lib/types';

const key = 'sidetask-browser-preview-v1';
const separator = (page: Page) => page.getByRole('separator', { name: '调整今日与截止日期区域的比例', exact: true });
type Probe = { writes: Snapshot[]; locks: boolean[]; dragStarts: number; dragEnds: number; pointerId: number };
type ProbeWindow = Window & { gestureProbe: Probe };

async function ready(page: Page) {
  const snapshot = createSeed('2026-09-25');
  await page.addInitScript(({ key, snapshot }) => {
    localStorage.setItem(key, JSON.stringify(snapshot));
    const probe: Probe = { writes: [], locks: [], dragStarts: 0, dragEnds: 0, pointerId: 0 };
    (window as ProbeWindow).gestureProbe = probe;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      original.call(this, name, value);
      if (name === key) probe.writes.push(JSON.parse(value));
    };
    document.addEventListener('pointerdown', event => { probe.pointerId = event.pointerId; }, true);
    window.addEventListener('sidetask:preview-interaction', event => probe.locks.push(Boolean((event as CustomEvent).detail.locked)));
    window.addEventListener('sidetask:drag-start', () => { probe.dragStarts++; });
    window.addEventListener('sidetask:drag-end', () => { probe.dragEnds++; });
  }, { key, snapshot });
  await page.setViewportSize({ width: 368, height: 610 });
  await page.clock.setFixedTime(new Date('2026-09-25T04:00:00.000Z'));
  await page.goto('/?surface=edge-panel');
  await expect(separator(page)).toBeVisible();
  return snapshot;
}

test('分区指针拖动按 Esc 立即回退，后续移动和松手不保存且释放捕获', async ({ page }) => {
  const before = await ready(page);
  const divider = separator(page);
  const bounds = (await divider.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 45, { steps: 3 });
  await expect(divider).not.toHaveAttribute('aria-valuenow', String(before.settings.panelSplit));
  await page.keyboard.press('Escape');
  await expect(divider).toHaveAttribute('aria-valuenow', String(before.settings.panelSplit));
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).gestureProbe.locks.at(-1))).toBe(false);
  expect(await divider.evaluate(element => element.hasPointerCapture((window as ProbeWindow).gestureProbe.pointerId))).toBe(false);
  await page.mouse.move(x, y + 65);
  await page.mouse.up();
  expect(await page.evaluate(() => (window as ProbeWindow).gestureProbe.writes)).toEqual([]);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key)).toEqual(before);
});

test('分区从非中心位置拖出再回原点不改比例或 revision', async ({ page }) => {
  const before = await ready(page);
  const divider = separator(page);
  const bounds = (await divider.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + 1;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 45, { steps: 3 });
  await expect(divider).not.toHaveAttribute('aria-valuenow', String(before.settings.panelSplit));
  await page.mouse.move(x, y, { steps: 3 });
  await page.mouse.up();
  await expect(divider).toHaveAttribute('aria-valuenow', String(before.settings.panelSplit));
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).gestureProbe.locks.at(-1))).toBe(false);
  expect(await page.evaluate(() => (window as ProbeWindow).gestureProbe.writes)).toEqual([]);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key)).toEqual(before);
});

test('标题在主指针按下时启动原生拖动，每次只发送一次结束', async ({ page }) => {
  await ready(page);
  const title = page.getByRole('button', { name: '拖动小窗', exact: true });
  await title.click();
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).gestureProbe.dragStarts)).toBe(1);
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).gestureProbe.dragEnds)).toBe(1);
  const bounds = (await title.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).gestureProbe.dragStarts)).toBe(2);
  await page.mouse.move(x + 2, y + 2);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).gestureProbe.dragEnds)).toBe(2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 8, y, { steps: 3 });
  await page.mouse.move(x + 20, y + 10, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).gestureProbe.dragStarts)).toBe(3);
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).gestureProbe.dragEnds)).toBe(3);
  // Native frame comparison, not this browser harness, owns zero-write clicks.
});
