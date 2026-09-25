import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot } from '../src/lib/types';

const key = 'sidetask-browser-preview-v1';
const grip = (page: Page) => page.getByRole('button', { name: '调整小窗宽度和高度', exact: true });
const initial = () => createSeed('2026-09-25');
async function ready(page: Page) {
  await page.setViewportSize({ width: 368, height: 610 });
  await page.clock.setFixedTime(new Date('2026-09-25T04:00:00Z'));
  await page.goto('/?surface=edge-panel');
  await expect(grip(page)).toBeVisible();
}
async function native(page: Page) {
  const seed = initial();
  await page.addInitScript(seed => {
    let current = seed;
    let sequence = 0;
    let active: { session: string; base: Snapshot['settings'] } | null = null;
    const callbacks = new Map<number, (value: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    const h = {
      calls: [] as { command: string; args: any }[], fail: '', hold: '', release: () => {}, pointerId: 0,
      notify: true, nextRead: null as Snapshot | null, snapshot: () => structuredClone(current),
      emit() { for (const [id, listener] of listeners) if (listener.event === 'sidetask:changed') callbacks.get(listener.handler)?.({ id, event: listener.event, payload: { revision: current.revision } }); },
      async change(changes: Partial<Snapshot['settings']>) {
        const path = '/src/lib/domain.ts';
        const domain = await import(path);
        current = domain.applyPreviewAction(current, { type: 'updateSettings', changes }, current.revision);
        h.emit();
      },
    };
    document.addEventListener('pointerdown', event => { h.pointerId = event.pointerId; }, true);
    Object.assign(window, {
      resizeProbe: h,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => listeners.delete(id) },
      __TAURI_INTERNALS__: {
        transformCallback(callback: (value: unknown) => void) { const id = ++sequence; callbacks.set(id, callback); return id; },
        async invoke(command: string, args: any = {}) {
          h.calls.push({ command, args });
          if (command === 'plugin:event|listen') { const id = ++sequence; listeners.set(id, args); return id; }
          if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
          if (command === 'get_snapshot') { const value = h.nextRead ?? current; h.nextRead = null; return structuredClone(value); }
          if (command === 'get_pending_exit') return null;
          if (command === 'window_action') {
            if (args.action !== 'resizePanel') return;
            const p = args.payload;
            if (h.hold === p.phase) await new Promise<void>(resolve => { h.release = resolve; });
            if (p.phase === 'cancel') { if (active?.session === p.session) active = null; return; }
            if (h.fail === p.phase) { if (active?.session === p.session) active = null; throw new Error(`合成${p.phase}失败`); }
            if (p.phase === 'start') {
              if (active || JSON.stringify(p.expectedSettings) !== JSON.stringify(current.settings)) throw new Error('设置冲突，请重新调整。');
              active = { session: p.session, base: structuredClone(current.settings) }; return;
            }
            if (!active || active.session !== p.session) throw new Error('会话已结束。');
            if (JSON.stringify(active.base) !== JSON.stringify(current.settings)) { active = null; throw new Error('设置冲突，请重新调整。'); }
            if (p.phase === 'preview') return;
            if (p.phase === 'commit') {
              const path = '/src/lib/domain.ts';
              const domain = await import(path);
              current = domain.applyPreviewAction(current, { type: 'updateSettings', changes: { panelWidth: p.width, panelHeight: p.height } }, current.revision);
              active = null;
              if (h.notify) h.emit();
              return;
            }
            throw new Error(`Unexpected phase: ${p.phase}`);
          }
          throw new Error(`Unexpected IPC: ${command}`);
        },
      },
    });
  }, seed);
  await ready(page);
  return seed;
}
async function calls(page: Page, phase?: string) {
  return page.evaluate(phase => (window as any).resizeProbe.calls.filter((call: any) => call.command === 'window_action' && call.args.action === 'resizePanel' && (!phase || call.args.payload.phase === phase)).map((call: any) => call.args.payload), phase);
}
async function locks(page: Page) { return page.evaluate(() => (window as any).resizeProbe.calls.filter((call: any) => call.command === 'window_action' && call.args.action === 'interaction').map((call: any) => call.args.payload.locked)); }
async function snapshot(page: Page): Promise<Snapshot> { return page.evaluate(() => (window as any).resizeProbe.snapshot()); }
async function settled(page: Page) { await expect(grip(page)).toHaveAttribute('aria-busy', 'false'); await expect.poll(async () => (await locks(page)).at(-1)).toBe(false); }
async function down(page: Page) {
  const box = (await grip(page).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  return { x, y };
}

test.describe('逻辑尺寸协议', () => {
  test.use({ deviceScaleFactor: 2 });
  test('主指针拖动使用CSS尺寸，松手只提交一次且不改任务计划', async ({ page }) => {
    const before = await native(page);
    const { x, y } = await down(page);
    await grip(page).dispatchEvent('pointermove', { pointerId: 999, screenX: -900, screenY: 900, isPrimary: false });
    await grip(page).dispatchEvent('pointerup', { pointerId: 999, isPrimary: false });
    expect(await calls(page, 'preview')).toHaveLength(0);
    expect(await calls(page, 'commit')).toHaveLength(0);
    await page.mouse.move(x - 52, y + 80, { steps: 6 });
    await expect.poll(async () => (await calls(page, 'preview')).length).toBeGreaterThan(0);
    expect(await calls(page, 'commit')).toHaveLength(0);
    await page.mouse.up();
    await settled(page);
    const commits = await calls(page, 'commit');
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ width: 420, height: 690 });
    expect(new Set((await calls(page)).map(call => call.session)).size).toBe(1);
    const after = await snapshot(page);
    expect(after.settings).toEqual({ ...before.settings, panelWidth: 420, panelHeight: 690 });
    expect(after.tasks).toEqual(before.tasks); expect(after.plans).toEqual(before.plans);
    expect(after.revision).toBe(before.revision + 1);
  });
});

test('取消、捕获丢失、失焦、Esc及无移动点击均不提交夹小后的尺寸', async ({ page }) => {
  const before = await native(page);
  await page.evaluate(() => (window as any).resizeProbe.change({ panelHeight: 900 }));
  const saved = await snapshot(page);
  for (const mode of ['pointercancel', 'lostcapture', 'blur', 'escape', 'click']) {
    const { x, y } = await down(page);
    if (mode !== 'click') {
      await page.mouse.move(x - 20, y - 30);
      await expect.poll(async () => (await calls(page, 'preview')).length).toBeGreaterThan(0);
    }
    if (mode === 'pointercancel') await grip(page).dispatchEvent('pointercancel', { pointerId: await page.evaluate(() => (window as any).resizeProbe.pointerId), isPrimary: true, button: 0 });
    if (mode === 'lostcapture') { await grip(page).evaluate(element => element.releasePointerCapture((window as any).resizeProbe.pointerId)); await page.mouse.move(x - 21, y - 31); }
    if (mode === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    if (mode === 'escape') await page.keyboard.press('Escape');
    await page.mouse.up();
    await settled(page);
    expect(await calls(page, 'commit')).toHaveLength(0);
    expect(await snapshot(page)).toEqual(saved);
  }
  expect(saved.tasks).toEqual(before.tasks); expect(saved.plans).toEqual(before.plans);
  const count = (await calls(page)).length;
  await grip(page).dispatchEvent('pointerdown', { pointerId: 90, pointerType: 'touch', isPrimary: false, button: 0 });
  await grip(page).dispatchEvent('pointerdown', { pointerId: 91, pointerType: 'mouse', isPrimary: true, button: 2 });
  expect(await calls(page)).toHaveLength(count);
});

test('键盘连发累积草稿，慢提交不重复，快照通知延迟时下一次按键仍从已提交尺寸开始', async ({ page }) => {
  await native(page);
  await page.evaluate(() => { const h = (window as any).resizeProbe; h.hold = 'commit'; h.notify = false; });
  await grip(page).focus();
  for (let n = 0; n < 3; n++) await page.keyboard.down('ArrowLeft');
  expect(await calls(page, 'commit')).toHaveLength(0);
  await page.keyboard.up('ArrowLeft');
  await expect.poll(async () => (await calls(page, 'commit')).length).toBe(1);
  await expect(grip(page)).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('ArrowLeft');
  expect(await calls(page, 'start')).toHaveLength(1);
  await page.evaluate(() => { const h = (window as any).resizeProbe; h.hold = ''; h.release(); });
  await settled(page);
  expect((await snapshot(page)).settings.panelWidth).toBe(398);
  const firstCommit = await snapshot(page);
  await page.keyboard.press('ArrowLeft');
  await settled(page);
  await expect.poll(async () => (await snapshot(page)).settings.panelWidth).toBe(408);
  expect((await calls(page, 'start'))[1].expectedSettings.panelWidth).toBe(398);
  expect(await calls(page, 'commit')).toHaveLength(2);

  await page.keyboard.down('ArrowLeft');
  await expect.poll(async () => (await calls(page, 'start')).length).toBe(3);
  expect((await calls(page, 'start'))[2].expectedSettings.panelWidth).toBe(408);
  // An older get_snapshot may finish while the next gesture is in progress.
  await page.evaluate(value => { const h = (window as any).resizeProbe; h.nextRead = value; h.emit(); }, firstCommit);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.keyboard.up('ArrowLeft');
  await settled(page);
  await expect.poll(async () => (await snapshot(page)).settings.panelWidth).toBe(418);
  expect(await calls(page, 'commit')).toHaveLength(3);
  expect(await calls(page, 'cancel')).toHaveLength(0);

  await page.keyboard.down('ArrowDown');
  await page.getByRole('button', { name: '打开设置', exact: true }).focus();
  await page.keyboard.up('ArrowDown');
  await settled(page);
  expect(await calls(page, 'commit')).toHaveLength(3);
  await grip(page).focus(); await page.keyboard.down('ArrowDown'); await page.keyboard.press('Escape'); await page.keyboard.up('ArrowDown');
  await settled(page);
  expect(await calls(page, 'commit')).toHaveLength(3);
});

test('夹小工作区仅横向调整保留高度偏好，拖回原点取消且不写入', async ({ page }) => {
  await native(page);
  await page.evaluate(() => (window as any).resizeProbe.change({ panelHeight: 900 }));
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect((await page.locator('.edge-panel').boundingBox())!.height).toBe(610);
  const first = await down(page);
  await page.mouse.move(first.x - 10, first.y);
  await page.mouse.up();
  await settled(page);
  expect((await calls(page, 'commit'))[0]).toMatchObject({ width: 378, height: 900 });
  const saved = await snapshot(page);
  const second = await down(page);
  await page.mouse.move(second.x - 30, second.y - 20);
  await expect.poll(async () => (await calls(page, 'preview')).length).toBeGreaterThan(0);
  await page.mouse.move(second.x, second.y);
  await page.mouse.up();
  await settled(page);
  expect(await calls(page, 'commit')).toHaveLength(1);
  expect(await snapshot(page)).toEqual(saved);
});

test('start拒绝后停止所有排队预览和提交并释放锁', async ({ page }) => {
  const before = await native(page);
  await page.evaluate(() => { (window as any).resizeProbe.fail = 'start'; });
  await grip(page).focus();
  await grip(page).evaluate(element => {
    for (let n = 0; n < 3; n++) element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
  });
  await expect(page.getByRole('alert')).toContainText('合成start失败');
  await settled(page);
  expect((await calls(page)).map(call => call.phase)).toEqual(['start', 'cancel']);
  expect(await snapshot(page)).toEqual(before);
});

test('预览中外部设置更新会取消旧会话，滞后预览及松手不能覆盖新设置', async ({ page }) => {
  await native(page);
  await page.evaluate(() => { (window as any).resizeProbe.hold = 'preview'; });
  const { x, y } = await down(page);
  await page.mouse.move(x - 40, y - 20);
  await expect.poll(async () => (await calls(page, 'preview')).length).toBe(1);
  const oldSession = (await calls(page, 'start'))[0].session;
  await page.mouse.move(x - 60, y - 40);
  await page.evaluate(() => (window as any).resizeProbe.change({ panelWidth: 480, theme: 'dark' }));
  await expect(page.getByRole('alert')).toContainText('设置已更新');
  await page.mouse.up();
  await page.evaluate(() => { const h = (window as any).resizeProbe; h.hold = ''; h.release(); });
  await settled(page);
  expect(await calls(page, 'commit')).toHaveLength(0);
  expect((await snapshot(page)).settings.panelWidth).toBe(480);
  await grip(page).focus(); await page.keyboard.press('ArrowLeft');
  await settled(page);
  expect((await snapshot(page)).settings.panelWidth).toBe(490);
  expect((await calls(page, 'commit')).every(call => call.session !== oldSession)).toBe(true);
  expect((await snapshot(page)).settings.theme).toBe('dark');
});

test('提交失败保留已保存设置，重新手势可恢复且不发任务mutation', async ({ page }) => {
  const before = await native(page);
  await page.evaluate(() => { (window as any).resizeProbe.fail = 'commit'; });
  await grip(page).focus(); await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('alert')).toContainText('合成commit失败');
  await settled(page);
  expect(await snapshot(page)).toEqual(before);
  await page.evaluate(() => { (window as any).resizeProbe.fail = ''; });
  await page.keyboard.press('ArrowLeft');
  await settled(page);
  expect((await snapshot(page)).settings.panelWidth).toBe(378);
  expect(await page.evaluate(() => (window as any).resizeProbe.calls.some((call: any) => call.command === 'mutate'))).toBe(false);
});

test('尺寸取消只释放自己的交互锁，不解除仍在编辑的其他区域', async ({ page }) => {
  await native(page);
  await page.evaluate(async () => { const path = '/src/lib/native.ts'; const api = await import(path); await api.setInteractionLock(true); });
  await grip(page).focus(); await page.keyboard.down('ArrowLeft'); await page.keyboard.press('Escape'); await page.keyboard.up('ArrowLeft');
  await expect(grip(page)).toHaveAttribute('aria-busy', 'false');
  await expect.poll(async () => (await calls(page, 'cancel')).length).toBe(1);
  expect((await locks(page)).at(-1)).toBe(true);
  await page.evaluate(async () => { const path = '/src/lib/native.ts'; const api = await import(path); await api.setInteractionLock(false); });
  await expect.poll(async () => (await locks(page)).at(-1)).toBe(false);
});

test('浏览器预览取消零写入，卸载握柄也取消而不把实际小尺寸存为偏好', async ({ page }) => {
  const seed = initial(); seed.settings.panelHeight = 900;
  await page.addInitScript(({ seed, key }) => {
    localStorage.setItem(key, JSON.stringify(seed));
    const probe = { writes: 0, phases: [] as string[], pointerId: 0 };
    (window as any).previewResize = probe;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) { if (name === key) probe.writes++; original.call(this, name, value); };
    document.addEventListener('pointerdown', event => { probe.pointerId = event.pointerId; }, true);
    window.addEventListener('sidetask:preview-resize', event => probe.phases.push((event as CustomEvent).detail.phase));
  }, { seed, key });
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.goto('/?surface=console');
  const preview = page.getByTestId('browser-edge-preview');
  await preview.getByRole('button', { name: '展开侧笺；按住拖动可调整位置' }).hover();
  await expect(grip(page)).toBeVisible();
  const box = (await grip(page).boundingBox())!;
  await page.mouse.move(box.x + 8, box.y + 8); await page.mouse.down(); await page.mouse.move(box.x - 30, box.y - 30);
  await expect.poll(() => page.evaluate(() => (window as any).previewResize.phases.includes('preview'))).toBe(true);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(grip(page)).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => (window as any).previewResize.writes)).toBe(0);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key)).toEqual(seed);

  const next = (await grip(page).boundingBox())!;
  await page.mouse.move(next.x + 8, next.y + 8); await page.mouse.down(); await page.mouse.move(next.x - 30, next.y - 30);
  await expect.poll(() => page.evaluate(() => (window as any).previewResize.phases.filter((phase: string) => phase === 'start').length)).toBe(2);
  await preview.getByRole('button', { name: '收起小窗', exact: true }).evaluate(element => (element as HTMLButtonElement).click());
  await expect(grip(page)).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).previewResize.phases.filter((phase: string) => phase === 'cancel').length)).toBe(2);
  await page.mouse.up();
  expect(await page.evaluate(() => (window as any).previewResize.writes)).toBe(0);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key)).toEqual(seed);
});

test('真实预览写失败回退，过期请求不能重开或取消更新的会话', async ({ page }) => {
  const seed = initial();
  await page.addInitScript(({ seed, key }) => {
    localStorage.setItem(key, JSON.stringify(seed));
    (window as any).failResizeWrite = true;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key && (window as any).failResizeWrite) throw new Error('合成预览磁盘写入失败');
      original.call(this, name, value);
    };
  }, { seed, key });
  await ready(page);
  const { x, y } = await down(page);
  await page.mouse.move(x + 30, y - 40);
  await expect(page.locator('.edge-panel')).toHaveCSS('width', '338px');
  await page.mouse.up();
  await expect(page.getByRole('alert')).toContainText('合成预览磁盘写入失败');
  await expect(grip(page)).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.edge-panel')).toHaveCSS('width', '368px');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), key)).toEqual(seed);
  const results = await page.evaluate(async key => {
    (window as any).failResizeWrite = false;
    const path = '/src/lib/native.ts'; const api = await import(path);
    const expectedSettings = JSON.parse(localStorage.getItem(key)!).settings;
    const previous = crypto.randomUUID(), current = crypto.randomUUID();
    await api.windowAction('resizePanel', { phase: 'start', session: previous, expectedSettings });
    await api.windowAction('resizePanel', { phase: 'cancel', session: previous });
    await api.windowAction('resizePanel', { phase: 'start', session: current, expectedSettings });
    let rejected = false;
    try { await api.windowAction('resizePanel', { phase: 'commit', session: previous, width: 600, height: 900 }); }
    catch { rejected = true; }
    await api.windowAction('resizePanel', { phase: 'cancel', session: previous });
    await api.windowAction('resizePanel', { phase: 'commit', session: current, width: 380, height: 620 });
    return { rejected, snapshot: JSON.parse(localStorage.getItem(key)!) };
  }, key);
  expect(results.rejected).toBe(true);
  expect(results.snapshot.settings).toEqual({ ...seed.settings, panelWidth: 380, panelHeight: 620 });
  expect(results.snapshot.tasks).toEqual(seed.tasks); expect(results.snapshot.plans).toEqual(seed.plans);
  expect(results.snapshot.revision).toBe(seed.revision + 1);
});
