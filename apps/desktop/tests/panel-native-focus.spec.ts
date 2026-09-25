import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';

const separator = (page: Page) => page.getByRole('separator', { name: '调整今日与截止日期区域的比例', exact: true });
const grip = (page: Page) => page.getByRole('button', { name: '调整小窗宽度和高度', exact: true });

// This harness proves focus intent and async gesture handling, not AppKit focus.
async function ready(page: Page) {
  await page.addInitScript(snapshot => {
    let sequence = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const probe = { calls: [] as { command: string; args: any }[], fail: false, hold: false, release: () => {} };
    Object.assign(window, {
      focusProbe: probe,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        transformCallback(callback: (value: unknown) => void) { const id = ++sequence; callbacks.set(id, callback); return id; },
        async invoke(command: string, args: any = {}) {
          probe.calls.push({ command, args });
          if (command === 'plugin:event|listen') return ++sequence;
          if (command === 'plugin:event|unlisten') return;
          if (command === 'get_snapshot') return structuredClone(snapshot);
          if (command === 'window_action') {
            if (args.action === 'focusPanel') {
              if (probe.hold) await new Promise<void>(resolve => { probe.release = resolve; });
              if (probe.fail) throw new Error('合成原生获焦失败');
            }
            return;
          }
          throw new Error(`Unexpected IPC: ${command}`);
        },
      },
    });
  }, createSeed('2026-09-25'));
  await page.setViewportSize({ width: 368, height: 610 });
  await page.goto('/?surface=edge-panel');
  await expect(separator(page)).toBeVisible();
}

async function actions(page: Page) {
  return page.evaluate(() => (window as any).focusProbe.calls.filter((call: any) => call.command === 'window_action').map((call: any) => call.args));
}

test('悬停与标题点击不请求焦点，分区和尺寸主指针明确操作才请求', async ({ page }) => {
  await ready(page);
  await separator(page).hover();
  await grip(page).hover();
  await page.getByRole('button', { name: '拖动小窗', exact: true }).click();
  expect((await actions(page)).filter(action => action.action === 'focusPanel')).toHaveLength(0);
  await separator(page).click();
  await expect.poll(async () => (await actions(page)).filter(action => action.action === 'focusPanel').length).toBe(1);
  await grip(page).click();
  await expect.poll(async () => (await actions(page)).filter(action => action.action === 'focusPanel').length).toBe(2);
  await separator(page).dispatchEvent('pointerdown', { pointerId: 90, isPrimary: false, button: 0 });
  await grip(page).dispatchEvent('pointerdown', { pointerId: 91, isPrimary: true, button: 2 });
  expect((await actions(page)).filter(action => action.action === 'focusPanel')).toHaveLength(2);
  expect((await actions(page)).filter(action => ['showPanel', 'hidePanel', 'openConsole'].includes(action.action))).toHaveLength(0);
});

test('获焦失败显示原因且释放手势锁，重新点击可以再试', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => { (window as any).focusProbe.fail = true; });
  await separator(page).click();
  await expect(page.getByRole('alert')).toContainText('合成原生获焦失败');
  await expect.poll(async () => (await actions(page)).filter(action => action.action === 'interaction').at(-1)?.payload.locked).toBe(false);
  expect(await page.evaluate(() => (window as any).focusProbe.calls.filter((call: any) => call.command === 'mutate'))).toHaveLength(0);
  await page.evaluate(() => { (window as any).focusProbe.fail = false; });
  await page.getByRole('button', { name: '关闭错误提示', exact: true }).click();
  await separator(page).click();
  await expect.poll(async () => (await actions(page)).filter(action => action.action === 'focusPanel').length).toBe(2);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('获焦请求等待时失焦取消分区预览，迟到响应不恢复旧手势或提交', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => { (window as any).focusProbe.hold = true; });
  const divider = separator(page);
  const bounds = (await divider.boundingBox())!;
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 40, { steps: 3 });
  await expect(divider).not.toHaveAttribute('aria-valuenow', '54');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(divider).toHaveAttribute('aria-valuenow', '54');
  await expect.poll(async () => (await actions(page)).filter(action => action.action === 'interaction').at(-1)?.payload.locked).toBe(false);
  await page.evaluate(() => { (window as any).focusProbe.release(); });
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).focusProbe.calls.filter((call: any) => call.command === 'mutate'))).toHaveLength(0);
  expect((await actions(page)).filter(action => ['showPanel', 'hidePanel'].includes(action.action))).toHaveLength(0);
  await expect(divider).toHaveAttribute('aria-valuenow', '54');
});
