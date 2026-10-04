import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot } from '../src/lib/types';

// Exercise real preview persistence and cross-window notifications with synthetic
// data. Pointer input here does not certify native Windows/macOS dragging.
const storageKey = 'sidetask-browser-preview-v1';
const date = '2026-09-25';
const fixedTime = new Date(`${date}T04:00:00.000Z`);
const titles = ['合成写作练习', '合成阅读笔记', '合成数学作业', '合成已完成复习', '合成周末资料', '合成参考材料'];
type ProbeWindow = Window & { orderProbe: { attempts: number; writes: number; fail: boolean; locks: boolean[]; release?: () => void } };

function fixture(): Snapshot {
  const snapshot = createSeed(date);
  snapshot.revision = 20;
  snapshot.tasks.forEach((task, index) => {
    task.title = titles[index];
    task.notes = `保留备注 ${index}`;
    task.createdAt = '2026-09-20T04:00:00.000Z';
    task.completedAt = task.completed ? '2026-09-24T04:00:00.000Z' : null;
  });
  snapshot.plans.find(plan => plan.taskId === snapshot.tasks[3].id)!.sortOrder = 41;
  snapshot.plans.push({ taskId: snapshot.tasks[0].id, date: '2026-09-24', sortOrder: 17 });
  snapshot.plans.push({ taskId: snapshot.tasks[1].id, date: '2026-09-26', sortOrder: 23 });
  return snapshot;
}

async function seed(context: BrowserContext, snapshot = fixture()) {
  await context.addInitScript(({ key, snapshot }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(snapshot));
    localStorage.setItem('sidetask-usage-guide-seen-v1', '1');
    const probe = { attempts: 0, writes: 0, fail: false, locks: [] as boolean[] };
    (window as ProbeWindow).orderProbe = probe;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) {
        probe.attempts++;
        if (probe.fail) throw new Error('合成任务顺序写入失败');
        const result = original.call(this, name, value);
        probe.writes++;
        return result;
      }
      return original.call(this, name, value);
    };
    window.addEventListener('sidetask:preview-interaction', event => probe.locks.push(Boolean((event as CustomEvent).detail.locked)));
  }, { key: storageKey, snapshot });
  return snapshot;
}

async function open(page: Page, surface: 'console' | 'edge-panel' = 'console') {
  await page.clock.setFixedTime(fixedTime);
  if (surface === 'edge-panel') await page.setViewportSize({ width: 368, height: 610 });
  await page.goto(`/?surface=${surface}`);
  await expect(today(page, surface)).toBeVisible();
}
async function openWithControlledFrames(page: Page, frameInterval: number) {
  await page.clock.install({ time: new Date(fixedTime.getTime() - 60 * 60 * 1000) });
  await page.goto('/?surface=console');
  await expect(today(page)).toBeVisible();
  await page.clock.pauseAt(fixedTime);
  // Drive the real drag handler at a known refresh rate, independently of the
  // runner's rendering speed. Use the clock's monotonic timestamp for each RAF.
  await page.evaluate(interval => {
    window.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), interval);
    window.cancelAnimationFrame = id => window.clearTimeout(id);
  }, frameInterval);
}
function longListFixture() {
  const initial = fixture();
  const template = initial.tasks[0];
  initial.tasks = Array.from({ length: 250 }, (_, index) => ({ ...template, id: `drag-task-${index}`, title: `合成长列表第${String(index).padStart(3, '0')}项`, dueDate: null, dueTime: null }));
  initial.plans = initial.tasks.map((task, sortOrder) => ({ taskId: task.id, date, sortOrder }));
  return initial;
}
function today(page: Page, surface: 'console' | 'edge-panel' = 'console') {
  return page.getByRole('list', { name: surface === 'console' ? '今日' : '今日未完成任务', exact: true });
}
function titleList(list: Locator) { return list.locator('.task-title'); }
function handle(list: Locator, title: string) { return list.getByRole('button', { name: `拖动排序：${title}`, exact: true }); }
function row(list: Locator, title: string) {
  return list.getByRole('listitem').filter({ has: list.page().getByRole('button', { name: `拖动排序：${title}`, exact: true }) });
}
async function snapshot(page: Page): Promise<Snapshot> { return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey); }
async function probe(page: Page) { return page.evaluate(() => (window as ProbeWindow).orderProbe); }
async function settle(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
async function beginDrag(page: Page, list: Locator, title: string) {
  await handle(list, title).scrollIntoViewIfNeeded();
  const bounds = await handle(list, title).boundingBox();
  expect(bounds).not.toBeNull();
  const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  return point;
}
async function moveToRow(page: Page, list: Locator, title: string, after = true) {
  const bounds = await row(list, title).boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + 12, bounds!.y + bounds!.height * (after ? .75 : .25), { steps: 6 });
}
async function drag(page: Page, list: Locator, source: string, target: string, after = true) {
  await beginDrag(page, list, source);
  await moveToRow(page, list, target, after);
  await page.mouse.up();
}
function preservedPlans(value: Snapshot) {
  const completed = new Set(value.tasks.filter(task => task.completed).map(task => task.id));
  return value.plans.filter(plan => plan.date !== date || completed.has(plan.taskId));
}

test('今日拖动仅松手保存一次，两窗双向同步且重载保留任务和其他日期计划', async ({ page, context }) => {
  const initial = await seed(context);
  await open(page);
  const panel = await context.newPage();
  await open(panel, 'edge-panel');
  const consoleList = today(page);
  const panelList = today(panel, 'edge-panel');
  await beginDrag(page, consoleList, titles[0]);
  await moveToRow(page, consoleList, titles[2]);
  await expect(consoleList.locator('[data-dragging]')).toHaveCount(1);
  expect(await snapshot(page)).toEqual(initial);
  expect((await probe(page)).writes).toBe(0);
  await expect(titleList(panelList)).toHaveText(titles.slice(0, 3));
  await page.mouse.up();
  await expect(titleList(consoleList)).toHaveText([titles[1], titles[2], titles[0]]);
  await expect(titleList(panelList)).toHaveText([titles[1], titles[2], titles[0]]);
  expect((await probe(page)).writes).toBe(1);

  await drag(panel, panelList, titles[0], titles[1], false);
  await expect(titleList(consoleList)).toHaveText(titles.slice(0, 3));
  await expect(titleList(panelList)).toHaveText(titles.slice(0, 3));
  expect((await probe(panel)).writes).toBe(1);
  const committed = await snapshot(page);
  expect(committed.tasks).toEqual(initial.tasks);
  expect(committed.settings).toEqual(initial.settings);
  expect(committed.taskOrder).toEqual(initial.taskOrder);
  expect(committed.deadlineOrder).toEqual(initial.deadlineOrder);
  expect(preservedPlans(committed)).toEqual(preservedPlans(initial));
  expect(committed.revision).toBe(initial.revision + 2);
  await page.reload();
  await panel.reload();
  await expect(titleList(today(page))).toHaveText(titles.slice(0, 3));
  await expect(titleList(today(panel, 'edge-panel'))).toHaveText(titles.slice(0, 3));
  expect(await snapshot(page)).toEqual(committed);
});

test('全部任务与截止日期分别拖动，DDL自动转手动并跨窗保留，切换日期排序不抹掉自定义顺序', async ({ page, context }) => {
  const initial = await seed(context);
  await open(page);
  const panel = await context.newPage();
  await open(panel, 'edge-panel');
  const panelDeadlines = panel.getByRole('list', { name: '截止日期任务', exact: true });
  const dated = [titles[0], titles[2], titles[4], titles[5]];
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^全部任务/ }).click();
  const all = page.getByRole('list', { name: '全部任务', exact: true });
  await drag(page, all, titles[5], titles[0], false);
  const allOrder = [titles[5], titles[0], titles[1], titles[2], titles[4]];
  await expect(titleList(all)).toHaveText(allOrder);
  await expect(titleList(today(panel, 'edge-panel'))).toHaveText(titles.slice(0, 3));
  await expect(titleList(panelDeadlines)).toHaveText(dated);
  const allCommitted = await snapshot(page);
  expect(allCommitted.plans).toEqual(initial.plans);
  expect(allCommitted.deadlineOrder).toEqual(initial.deadlineOrder);

  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^截止日期/ }).click();
  const deadlines = page.getByRole('list', { name: '截止日期', exact: true });
  await expect(page.getByRole('main').getByLabel('截止任务排序', { exact: true })).toHaveValue('date');
  await drag(page, deadlines, titles[5], titles[0], false);
  const manual = [titles[5], titles[0], titles[2], titles[4]];
  await expect(titleList(deadlines)).toHaveText(manual);
  await expect(titleList(panelDeadlines)).toHaveText(manual);
  await expect(page.getByRole('main').getByLabel('截止任务排序', { exact: true })).toHaveValue('manual');
  await expect(panel.getByLabel('截止任务排序', { exact: true })).toHaveValue('manual');
  const ddlCommitted = await snapshot(page);
  expect(ddlCommitted.tasks).toEqual(initial.tasks);
  expect(ddlCommitted.plans).toEqual(initial.plans);
  expect(ddlCommitted.taskOrder).toEqual(allCommitted.taskOrder);
  expect(ddlCommitted.revision).toBe(initial.revision + 2);
  expect((await probe(page)).writes).toBe(2);

  await panel.getByLabel('截止任务排序', { exact: true }).selectOption('date');
  await expect(titleList(deadlines)).toHaveText(dated);
  await expect(titleList(panelDeadlines)).toHaveText(dated);
  await panel.getByLabel('截止任务排序', { exact: true }).selectOption('manual');
  await expect(titleList(deadlines)).toHaveText(manual);
  await expect(titleList(panelDeadlines)).toHaveText(manual);
  expect((await snapshot(page)).deadlineOrder).toEqual(ddlCommitted.deadlineOrder);
  await panel.reload();
  await expect(titleList(panel.getByRole('list', { name: '截止日期任务', exact: true }))).toHaveText(manual);
  await page.reload();
  await expect(titleList(today(page))).toHaveText(titles.slice(0, 3));
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^全部任务/ }).click();
  await expect(titleList(page.getByRole('list', { name: '全部任务', exact: true }))).toHaveText(allOrder);
});

test('小窗DDL直接拖动，失败保留日期模式，成功将手动顺序和模式一次提交到两窗', async ({ page, context }, testInfo) => {
  const initial = fixture();
  initial.tasks.pop();
  await seed(context, initial);
  await open(page);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^截止日期/ }).click();
  const panel = await context.newPage();
  await open(panel, 'edge-panel');
  const list = panel.getByRole('list', { name: '截止日期任务', exact: true });
  await panel.evaluate(() => { (window as ProbeWindow).orderProbe.fail = true; });
  await drag(panel, list, titles[2], titles[0], false);
  await expect(panel.locator('.reorder-notice[role="alert"]')).toContainText('合成任务顺序写入失败');
  await expect(panel.getByLabel('截止任务排序', { exact: true })).toHaveValue('date');
  expect(await snapshot(panel)).toEqual(initial);
  await panel.evaluate(() => { (window as ProbeWindow).orderProbe.fail = false; });
  await drag(panel, list, titles[2], titles[0], false);
  const expected = [titles[2], titles[0], titles[4]];
  await expect(titleList(list)).toHaveText(expected);
  await expect(titleList(page.getByRole('list', { name: '截止日期', exact: true }))).toHaveText(expected);
  await expect(panel.getByLabel('截止任务排序', { exact: true })).toHaveValue('manual');
  await expect(page.getByRole('main').getByLabel('截止任务排序', { exact: true })).toHaveValue('manual');
  const committed = await snapshot(panel);
  expect(committed.revision).toBe(initial.revision + 1);
  expect(committed.tasks).toEqual(initial.tasks);
  expect(committed.plans).toEqual(initial.plans);
  expect(committed.taskOrder).toEqual(initial.taskOrder);
  expect((await probe(panel)).writes).toBe(1);
  expect((await probe(panel)).locks.at(-1)).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('console-ddl-manual.png') });
  await panel.setViewportSize({ width: 300, height: 610 });
  await expect(panel.getByLabel('截止任务排序', { exact: true })).toBeInViewport();
  await panel.screenshot({ path: testInfo.outputPath('panel-ddl-manual-300.png') });
});

for (const surface of ['console', 'edge-panel'] as const) {
  test(`${surface}单击、原位松手、Esc与列表外松手不提交，连续拖动按下不跳位`, async ({ page, context }) => {
    const initial = await seed(context);
    await open(page, surface);
    const list = today(page, surface);
    await handle(list, titles[0]).click();
    let point = await beginDrag(page, list, titles[0]);
    await page.mouse.move(point.x + 7, point.y, { steps: 3 });
    await page.mouse.up();
    await beginDrag(page, list, titles[0]);
    await moveToRow(page, list, titles[2]);
    await expect(list.locator('[data-dragging]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(list.locator('[data-dragging]')).toHaveCount(0);
    await page.mouse.up();
    point = await beginDrag(page, list, titles[0]);
    await page.mouse.move(point.x + 7, point.y, { steps: 3 });
    await page.mouse.move(1, 1, { steps: 3 });
    await page.mouse.up();
    await settle(page);
    expect((await probe(page)).attempts).toBe(0);
    expect(await snapshot(page)).toEqual(initial);
    await expect(titleList(list)).toHaveText(titles.slice(0, 3));
    if (surface === 'edge-panel') expect((await probe(page)).locks.at(-1)).toBe(false);
    await drag(page, list, titles[2], titles[0], false);
    await expect(titleList(list)).toHaveText([titles[2], titles[0], titles[1]]);
    expect((await probe(page)).writes).toBe(1);
    await expect(page.locator('.reorder-notice').filter({ hasText: '顺序已保存' })).toBeVisible();
    // The previous drop may leave this short panel partially scrolled. Start
    // this notice-layout check at the top: otherwise edge auto-scroll can move
    // the first row below the stale target point before mouse-up, legitimately
    // turning the drop into an outside-list cancellation.
    await list.evaluate(element => { element.closest<HTMLElement>('.main-content,.edge-scroll')!.scrollTop = 0; });
    await settle(page);
    await handle(list, titles[0]).scrollIntoViewIfNeeded();
    const beforeSecondDrag = await row(list, titles[0]).boundingBox();
    await beginDrag(page, list, titles[0]);
    await settle(page);
    const afterPointerDown = await row(list, titles[0]).boundingBox();
    expect(Math.abs(afterPointerDown!.y - beforeSecondDrag!.y)).toBeLessThan(1);
    await moveToRow(page, list, titles[2], false);
    await page.mouse.up();
    await expect(titleList(list)).toHaveText([titles[0], titles[2], titles[1]]);
    expect((await probe(page)).writes).toBe(2);
  });

  test(`${surface}键盘Alt方向键移动并保留焦点，首尾边界不写入`, async ({ page, context }) => {
    const initial = await seed(context);
    await open(page, surface);
    const list = today(page, surface);
    await handle(list, titles[0]).focus();
    await page.keyboard.press('Alt+ArrowUp');
    expect((await probe(page)).attempts).toBe(0);
    await page.keyboard.press('Alt+ArrowDown');
    await expect(titleList(list)).toHaveText([titles[1], titles[0], titles[2]]);
    await expect(handle(list, titles[0])).toBeFocused();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(titleList(list)).toHaveText([titles[1], titles[2], titles[0]]);
    await expect(handle(list, titles[0])).toBeFocused();
    await page.keyboard.press('Alt+ArrowDown');
    await settle(page);
    expect((await probe(page)).writes).toBe(2);
    expect((await snapshot(page)).revision).toBe(initial.revision + 2);
    if (surface === 'edge-panel') expect((await probe(page)).locks.at(-1)).toBe(false);
  });

  test(`${surface}排序写入失败保留原顺序与数据，重试只保存一次`, async ({ page, context }) => {
    const initial = await seed(context);
    await open(page, surface);
    const list = today(page, surface);
    await page.evaluate(() => { (window as ProbeWindow).orderProbe.fail = true; });
    await drag(page, list, titles[2], titles[0], false);
    await expect(page.locator('.reorder-notice[role="alert"]')).toContainText('合成任务顺序写入失败');
    await expect(titleList(list)).toHaveText(titles.slice(0, 3));
    expect(await snapshot(page)).toEqual(initial);
    expect((await probe(page)).writes).toBe(0);
    await expect(handle(list, titles[2])).toBeEnabled();
    if (surface === 'edge-panel') expect((await probe(page)).locks.at(-1)).toBe(false);
    await page.evaluate(() => { (window as ProbeWindow).orderProbe.fail = false; });
    await drag(page, list, titles[2], titles[0], false);
    await expect(titleList(list)).toHaveText([titles[2], titles[0], titles[1]]);
    const committed = await snapshot(page);
    expect(committed.revision).toBe(initial.revision + 1);
    expect(committed.tasks).toEqual(initial.tasks);
    expect((await probe(page)).writes).toBe(1);
  });
}

test('拖动期间另一窗口更新相同任务集合的顺序会取消，不能覆盖最新提交', async ({ page, context }) => {
  const initial = await seed(context);
  await open(page);
  const panel = await context.newPage();
  await open(panel, 'edge-panel');
  const list = today(page);
  await beginDrag(page, list, titles[0]);
  await moveToRow(page, list, titles[2]);
  await expect(list.locator('[data-dragging]')).toHaveCount(1);
  // The other surface's real storage event arrives without stealing browser
  // focus, so cancellation must observe revision rather than merely window blur.
  const external = structuredClone(initial);
  external.revision++;
  const changedIds = [initial.tasks[2].id, initial.tasks[1].id, initial.tasks[0].id];
  external.plans.forEach(plan => { if (plan.date === date && changedIds.includes(plan.taskId)) plan.sortOrder = changedIds.indexOf(plan.taskId); });
  await panel.evaluate(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  }, { key: storageKey, value: external });
  await expect(list.locator('[data-dragging]')).toHaveCount(0);
  await expect(page.locator('.reorder-notice')).toContainText('列表已更新');
  await page.mouse.up();
  await expect(titleList(list)).toHaveText([titles[2], titles[1], titles[0]]);
  await expect(titleList(today(panel, 'edge-panel'))).toHaveText([titles[2], titles[1], titles[0]]);
  expect((await probe(page)).writes).toBe(0);
  expect(await snapshot(page)).toEqual(external);
});

test('搜索和已完成列表没有拖把手，退出搜索后恢复今日顺序', async ({ page, context }) => {
  const initial = await seed(context);
  await open(page);
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('合成');
  await expect(page.getByRole('list', { name: '全部任务搜索结果', exact: true }).getByRole('button', { name: /^拖动排序：/ })).toHaveCount(0);
  await page.getByTitle('清除搜索', { exact: true }).click();
  await expect(titleList(today(page))).toHaveText(titles.slice(0, 3));
  await expect(today(page).getByRole('button', { name: /^拖动排序：/ })).toHaveCount(3);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^已完成/ }).click();
  await expect(page.getByRole('list', { name: '已完成', exact: true }).getByRole('button', { name: /^拖动排序：/ })).toHaveCount(0);
  expect(await snapshot(page)).toEqual(initial);
});

test('松手后等待存储锁时其他窗口先提交，旧拖动版本被拒绝而不覆盖最新顺序', async ({ page, context }) => {
  const initial = await seed(context);
  await open(page);
  const panel = await context.newPage();
  await open(panel, 'edge-panel');
  await page.evaluate(() => new Promise<void>(ready => {
    void navigator.locks.request('sidetask-preview-write', () => new Promise<void>(release => {
      (window as ProbeWindow).orderProbe.release = release;
      ready();
    }));
  }));
  const list = today(page);
  await drag(page, list, titles[0], titles[2]);
  await expect(handle(list, titles[0])).toBeDisabled();
  expect((await probe(page)).writes).toBe(0);
  const external = structuredClone(initial);
  external.revision++;
  const changedIds = [initial.tasks[2].id, initial.tasks[1].id, initial.tasks[0].id];
  external.plans.forEach(plan => { if (plan.date === date && changedIds.includes(plan.taskId)) plan.sortOrder = changedIds.indexOf(plan.taskId); });
  await panel.evaluate(({ key, value }) => {
    localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new StorageEvent('storage', { key }));
  }, { key: storageKey, value: external });
  await expect(titleList(list)).toHaveText([titles[2], titles[1], titles[0]]);
  await page.evaluate(() => (window as ProbeWindow).orderProbe.release?.());
  await expect(page.locator('.reorder-notice[role="alert"]')).toContainText('另一窗口更新');
  await expect(handle(list, titles[0])).toBeEnabled();
  expect((await probe(page)).writes).toBe(0);
  expect(await snapshot(page)).toEqual(external);
});

test('250项虚拟列表在10Hz下持续自动滚动，可放入起初未挂载的位置且只写一次', async ({ page, context }) => {
  const initial = longListFixture();
  await seed(context, initial);
  await openWithControlledFrames(page, 100);
  const list = today(page);
  await expect(list).toHaveAttribute('data-virtualized', 'true');
  expect(await list.getByRole('listitem').count()).toBeLessThan(60);
  const initialLast = Math.max(...(await list.locator('[data-task-list-index]').evaluateAll(rows => rows.map(row => Number((row as HTMLElement).dataset.taskListIndex)))));
  const point = await beginDrag(page, list, initial.tasks[0].title);
  const scroll = page.locator('main.main-content');
  const bounds = await scroll.boundingBox();
  await page.mouse.move(point.x, Math.min(bounds!.y + bounds!.height, 960) - 8, { steps: 10 });
  await page.clock.runFor(2_500);
  expect(await scroll.evaluate(element => element.scrollTop)).toBeGreaterThan(1_800);
  await expect(list.locator('[data-task-list-id="drag-task-0"][data-dragging]')).toHaveCount(1);
  expect(await list.getByRole('listitem').count()).toBeLessThan(60);
  expect((await probe(page)).writes).toBe(0);
  expect(await snapshot(page)).toEqual(initial);
  await page.mouse.up();
  await expect.poll(async () => (await snapshot(page)).revision).toBe(initial.revision + 1);
  const committed = await snapshot(page);
  const ordered = committed.plans.filter(plan => plan.date === date).sort((a, b) => a.sortOrder - b.sortOrder).map(plan => plan.taskId);
  expect(ordered.indexOf('drag-task-0')).toBeGreaterThan(initialLast);
  expect(new Set(ordered).size).toBe(250);
  expect(ordered.filter(id => id !== 'drag-task-0')).toEqual(initial.tasks.slice(1).map(task => task.id));
  expect(committed.tasks).toEqual(initial.tasks);
  expect((await probe(page)).writes).toBe(1);
  await expect(handle(list, initial.tasks[0].title)).toBeFocused();
  await expect(handle(list, initial.tasks[0].title)).toBeInViewport();
  await page.reload();
  await expect(today(page)).toHaveAttribute('data-virtualized', 'true');
  expect(await snapshot(page)).toEqual(committed);
});

test('高刷新率自动滚动保持正常速度，长帧恢复不大跳且取消后停止', async ({ page, context }) => {
  const initial = longListFixture();
  await seed(context, initial);
  await openWithControlledFrames(page, 8);
  const list = today(page);
  const point = await beginDrag(page, list, initial.tasks[0].title);
  const scroll = page.locator('main.main-content');
  const bounds = await scroll.boundingBox();
  await page.mouse.move(point.x, Math.min(bounds!.y + bounds!.height, 960) - 8, { steps: 10 });
  const before = await scroll.evaluate(element => element.scrollTop);
  await page.clock.runFor(1_000);
  const after = await scroll.evaluate(element => element.scrollTop);
  // The same near-edge position should travel about 864 px per second, not
  // multiply its speed when 125 frames are delivered instead of 60.
  expect(after - before).toBeGreaterThan(750);
  expect(after - before).toBeLessThan(1_000);
  await page.clock.fastForward(2_000);
  const resumed = await scroll.evaluate(element => element.scrollTop);
  expect(resumed - after).toBeGreaterThan(0);
  expect(resumed - after).toBeLessThan(120);
  expect((await probe(page)).writes).toBe(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(list.locator('[data-dragging]')).toHaveCount(0);
  const cancelled = await scroll.evaluate(element => element.scrollTop);
  await page.clock.runFor(1_000);
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(cancelled);
  expect(await snapshot(page)).toEqual(initial);
  expect((await probe(page)).writes).toBe(0);
});

for (const completion of ['resolve', 'reject'] as const) {
  test(`原生交互准备迟到${completion}时，已取消的拖动不能抢焦点、释放新会话锁或取消新拖动`, async ({ page }) => {
    await page.addInitScript(initial => {
      let committed = initial; let sequence = 0; let delayed = false;
      const callbacks = new Map<number, (value: unknown) => void>();
      const listeners = new Map<number, { event: string; handler: number }>();
      const harness = {
        calls: [] as Array<{ command: string; args: any }>,
        pending: false,
        settle: (_completion: 'resolve' | 'reject') => {},
        snapshot: () => committed,
      };
      Object.assign(window, {
        __dragNative: harness,
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: (_event: string, id: number) => listeners.delete(id) },
        __TAURI_INTERNALS__: {
          transformCallback(callback: (value: unknown) => void) { const id = ++sequence; callbacks.set(id, callback); return id; },
          async invoke(command: string, args: any = {}) {
            harness.calls.push({ command, args });
            if (command === 'plugin:event|listen') { const id = ++sequence; listeners.set(id, args); return id; }
            if (command === 'plugin:event|unlisten') return listeners.delete(args.eventId);
            if (command === 'get_snapshot') return structuredClone(committed);
            if (command === 'get_pending_exit') return null;
            if (command === 'window_action') {
              if (args.action === 'interaction' && args.payload.locked && !delayed) {
                delayed = true; harness.pending = true;
                await new Promise<void>((resolve, reject) => {
                  harness.settle = result => {
                    harness.pending = false;
                    if (result === 'resolve') resolve(); else reject(new Error('合成旧会话准备失败'));
                  };
                });
              }
              return;
            }
            if (command === 'mutate') {
              const modulePath = '/src/lib/domain.ts';
              committed = (await import(modulePath)).applyPreviewAction(committed, args.action, args.expectedRevision);
              return structuredClone(committed);
            }
            throw new Error(`Unexpected ${command}`);
          },
        },
      });
    }, fixture());
    await open(page, 'edge-panel');
    const list = today(page, 'edge-panel');
    await beginDrag(page, list, titles[0]);
    await moveToRow(page, list, titles[1]);
    await expect.poll(() => page.evaluate(() => (window as any).__dragNative.pending)).toBe(true);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await beginDrag(page, list, titles[2]);
    await moveToRow(page, list, titles[0], false);
    await expect(list.locator('[data-dragging]')).toHaveCount(1);
    await page.evaluate(value => (window as any).__dragNative.settle(value), completion);
    await expect.poll(() => page.evaluate(() => (window as any).__dragNative.calls.filter((call: any) => call.args.action === 'focusPanel').length)).toBe(1);
    await expect(row(list, titles[2])).toHaveAttribute('data-dragging', 'true');
    const beforeDrop = await page.evaluate(() => (window as any).__dragNative.calls);
    expect(beforeDrop.filter((call: any) => call.args.action === 'interaction').at(-1).args.payload.locked).toBe(true);
    expect(beforeDrop.filter((call: any) => call.command === 'mutate')).toHaveLength(0);
    await page.mouse.up();
    await expect(titleList(list)).toHaveText([titles[2], titles[0], titles[1]]);
    const final = await page.evaluate(() => ({ calls: (window as any).__dragNative.calls, snapshot: (window as any).__dragNative.snapshot() }));
    expect(final.calls.filter((call: any) => call.args.action === 'focusPanel')).toHaveLength(1);
    expect(final.calls.filter((call: any) => call.command === 'mutate')).toHaveLength(1);
    expect(final.calls.filter((call: any) => call.args.action === 'interaction').at(-1).args.payload.locked).toBe(false);
    expect(final.snapshot.revision).toBe(fixture().revision + 1);
  });
}
