import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot } from '../src/lib/types';

const key = 'sidetask-browser-preview-v1';
type FocusProbe = { fail: boolean; attempts: number; releaseWrite?: () => void };
type ProbeWindow = Window & { splitFocusProbe: FocusProbe };
const separator = (page: Page) => page.getByRole('separator', { name: '调整今日与截止日期区域的比例', exact: true });
const retry = (page: Page) => page.getByRole('button', { name: '重试保存', exact: true });

async function preview(page: Page) {
  await page.addInitScript(({ key, snapshot }) => {
    localStorage.setItem(key, JSON.stringify(snapshot));
    const probe: FocusProbe = { fail: true, attempts: 0 };
    (window as ProbeWindow).splitFocusProbe = probe;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) probe.attempts++;
      if (name === key && probe.fail) throw new Error('合成分区保存失败');
      original.call(this, name, value);
    };
  }, { key, snapshot: createSeed('2026-09-25') });
  await page.setViewportSize({ width: 368, height: 610 });
  await page.clock.setFixedTime(new Date('2026-09-25T04:00:00.000Z'));
  await page.goto('/?surface=edge-panel');
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '54');
  expect(await page.evaluate(() => document.hasFocus())).toBe(true);
}
async function failWrites(page: Page, fail: boolean) {
  await page.evaluate(fail => { (window as ProbeWindow).splitFocusProbe.fail = fail; }, fail);
}
async function storedSplit(page: Page) {
  return page.evaluate(key => (JSON.parse(localStorage.getItem(key)!) as Snapshot).settings.panelSplit, key);
}
async function settleFocus(page: Page) {
  // The hook restores focus after React removes its temporary action buttons.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function failedAdjustment(page: Page, key = 'ArrowDown') {
  await separator(page).focus();
  await page.keyboard.press(key);
  await expect(retry(page)).toBeEnabled();
  await expect(separator(page)).toHaveAttribute('aria-disabled', 'true');
}

test('键盘重试失败保留按钮焦点，重试成功及恢复后可继续调整分区', async ({ page }) => {
  await preview(page);
  await failedAdjustment(page);
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '59');
  expect(await storedSplit(page)).toBe(54);

  await retry(page).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).splitFocusProbe.attempts)).toBe(2);
  await expect(retry(page)).toBeEnabled();
  await settleFocus(page);
  await expect(retry(page)).toBeFocused();
  expect(await storedSplit(page)).toBe(54);

  await failWrites(page, false);
  await page.keyboard.press('Enter');
  await expect(retry(page)).toHaveCount(0);
  await expect(separator(page)).toBeFocused();
  await expect.poll(() => storedSplit(page)).toBe(59);
  // No explicit refocus: ArrowDown must continue from the recovered separator.
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => storedSplit(page)).toBe(64);

  await failWrites(page, true);
  await failedAdjustment(page, 'ArrowUp');
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '59');
  await page.getByRole('button', { name: '恢复已保存比例', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(retry(page)).toHaveCount(0);
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '64');
  await expect(separator(page)).toBeFocused();
  expect(await storedSplit(page)).toBe(64);
  await failWrites(page, false);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => storedSplit(page)).toBe(69);
});

test('保存等待时不抢走已移动的焦点，外部相同比例提交后恢复键盘入口', async ({ page, browserName }) => {
  if (browserName === 'chromium') {
    // Slow rendering can let a RAF run before React removes the error controls.
    const renderer = await page.context().newCDPSession(page);
    await renderer.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  }
  await preview(page);
  await failedAdjustment(page);
  await failWrites(page, false);
  // Hold the real browser-preview write lock; the UI remains free to move focus.
  await page.evaluate(() => new Promise<void>(resolve => {
    void navigator.locks.request('sidetask-preview-write', () => new Promise<void>(release => {
      (window as ProbeWindow).splitFocusProbe.releaseWrite = release;
      resolve();
    }));
  }));
  await retry(page).focus();
  await page.keyboard.press('Enter');
  await expect(retry(page)).toBeDisabled();
  const settings = page.getByRole('button', { name: '打开设置', exact: true });
  await settings.focus();
  await expect(settings).toBeFocused();
  await page.evaluate(() => { (window as ProbeWindow).splitFocusProbe.releaseWrite!(); });
  await expect.poll(() => storedSplit(page)).toBe(59);
  await expect(retry(page)).toHaveCount(0);
  await settleFocus(page);
  await expect(settings).toBeFocused();

  await failWrites(page, true);
  await failedAdjustment(page);
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '64');
  await retry(page).focus();
  await expect(retry(page)).toBeFocused();
  expect(await page.evaluate(() => document.hasFocus())).toBe(true);
  // A committed snapshot notification models another window saving this draft.
  // This is a browser focus regression, not native application-focus evidence.
  await page.evaluate(async key => {
    const path = '/src/lib/domain.ts';
    const domain = await import(path);
    const current = JSON.parse(localStorage.getItem(key)!) as Snapshot;
    const next = domain.applyPreviewAction(current, { type: 'updateSettings', changes: { panelSplit: 64 } }, current.revision);
    (window as ProbeWindow).splitFocusProbe.fail = false;
    localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  }, key);
  await expect(retry(page)).toHaveCount(0);
  await expect(separator(page)).toHaveAttribute('aria-disabled', 'false');
  expect(await page.evaluate(() => document.hasFocus())).toBe(true);
  await expect(separator(page)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => storedSplit(page)).toBe(69);
});
