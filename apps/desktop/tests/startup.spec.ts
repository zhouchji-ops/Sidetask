import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';

// Synthetic IPC plus real module requests. This verifies startup ordering and
// fallback UI without invoking an OS window or a personal database.
async function native(page: Page, navigateOnAttach = false) {
  const snapshot = createSeed('2026-09-25');
  await page.clock.setFixedTime(new Date('2026-09-25T04:00:00Z'));
  await page.addInitScript(({ snapshot, navigateOnAttach }) => {
    let sequence = 0;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const h = { calls: [] as { command: string; args: any }[], snapshot: () => structuredClone(snapshot) };
    Object.assign(window, {
      __startup: h,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => listeners.delete(id) },
      __TAURI_INTERNALS__: {
        transformCallback(callback: (value: unknown) => void) { const id = ++sequence; callbacks.set(id, callback); return id; },
        async invoke(command: string, args: any = {}) {
          h.calls.push({ command, args });
          if (command === 'plugin:event|listen') {
            const id = ++sequence; listeners.set(id, args);
            if (navigateOnAttach && args.event === 'sidetask:navigate') callbacks.get(args.handler)?.({ id, event: args.event, payload: { page: 'all', newTask: true } });
            return id;
          }
          if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
          if (command === 'get_startup_recovery' || command === 'get_pending_exit') return null;
          if (command === 'get_snapshot') return structuredClone(snapshot);
          if (command === 'get_usage_guide_seen') return true;
          if (command === 'get_window_status' || command === 'get_console_position_status') return { pending: false, error: null };
          if (command === 'window_action' || command === 'resolve_exit') return;
          throw new Error(`Unexpected IPC: ${command}`);
        },
      },
    });
  }, { snapshot, navigateOnAttach });
  return snapshot;
}

for (const entry of [
  { surface: 'console', module: 'ConsoleApplication', ready: '.console-shell' },
  { surface: 'edge-panel', module: 'PanelApplication', ready: '.edge-panel' },
  { surface: 'edge-handle', module: 'HandleApplication', ready: '.edge-handle' },
]) {
  test(`${entry.surface}懒加载失败保留重试入口，重试只挂载对应界面且不写任务`, async ({ page }) => {
    const before = await native(page);
    let fail = true;
    const requested: string[] = [];
    const errors: string[] = [];
    page.on('request', request => requested.push(new URL(request.url()).pathname));
    page.on('pageerror', error => errors.push(error.message));
    await page.route(`**/src/startup/${entry.module}.tsx*`, async route => {
      if (fail) { fail = false; await route.abort('failed'); }
      else await route.continue();
    });
    await page.goto(`/?surface=${entry.surface}`);
    const retry = page.getByRole('button', { name: entry.surface === 'edge-handle' ? '侧笺未能加载，点击重试' : '重新加载', exact: true });
    await expect(retry).toBeVisible();
    expect(await page.evaluate(() => (window as any).__startup.calls)).toEqual([]);
    await retry.focus(); await page.keyboard.press('Enter');
    await expect(retry).toHaveCount(0);
    await expect(page.locator(entry.ready)).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__startup.calls.filter((call: any) => call.command === 'get_snapshot').length)).toBeGreaterThan(0);
    const entries = requested.filter(path => /\/src\/startup\/.*Application\.tsx$/.test(path));
    expect(entries).toContain(`/src/startup/${entry.module}.tsx`);
    expect(entries.every(path => path.endsWith(`/${entry.module}.tsx`) || path.endsWith('/NativeApplication.tsx'))).toBe(true);
    expect(requested.some(path => path.endsWith('/BrowserEdgePreview.tsx'))).toBe(false);
    if (entry.surface !== 'console') {
      expect(requested.some(path => path.endsWith('/UsageGuide.tsx') || path.endsWith('/style-picker.css'))).toBe(false);
    }
    expect(await page.evaluate(() => (window as any).__startup.calls.some((call: any) => call.command === 'mutate'))).toBe(false);
    expect(await page.evaluate(() => (window as any).__startup.snapshot())).toEqual(before);
    expect(errors).toEqual([]);
  });
}

test('慢控制台模块加载完成后才连接原生导航，首个新任务意图不丢失', async ({ page }) => {
  const before = await native(page, true);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let requested = false;
  await page.route('**/src/startup/ConsoleApplication.tsx*', async route => {
    requested = true;
    await gate;
    await route.continue();
  });
  await page.goto('/?surface=console', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => requested).toBe(true);
  expect(await page.evaluate(() => (window as any).__startup.calls)).toEqual([]);
  release();
  await expect(page.getByRole('heading', { name: '全部任务', exact: true })).toBeVisible();
  const dialog = page.getByRole('dialog', { name: '新建任务', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('任务名称', { exact: true })).toBeFocused();
  await expect(dialog.getByLabel('任务名称', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => (window as any).__startup.calls.some((call: any) => call.command === 'mutate'))).toBe(false);
  expect(await page.evaluate(() => (window as any).__startup.snapshot())).toEqual(before);
});
