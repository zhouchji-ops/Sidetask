import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot, Task } from '../src/lib/types';

// Real preview storage and BroadcastChannel in fresh Playwright contexts.
// These cases neither access personal SQLite files nor simulate native IPC.
const storageKey = 'sidetask-browser-preview-v1';
const date = '2026-09-25';
const now = new Date(`${date}T04:00:00.000Z`);
const titles = ['合成写作任务', '合成阅读任务', '合成数学任务', '合成已完成复习', '合成待安排实验', '合成参考材料'];

function fixture(): Snapshot {
  const snapshot = createSeed(date);
  snapshot.revision = 20;
  snapshot.tasks.forEach((task, index) => {
    task.title = titles[index];
    task.notes = `原始备注 ${index}`;
    task.createdAt = '2026-09-20T04:00:00.000Z';
    task.completedAt = task.completed ? '2026-09-24T04:00:00.000Z' : null;
  });
  snapshot.tasks[0].dueTimezone = 'Asia/Shanghai';
  snapshot.tasks[0].dueAtUtc = '2026-09-26T10:00:00.000000000Z';
  snapshot.plans.push({ taskId: snapshot.tasks[0].id, date: '2026-09-24', sortOrder: 17 });
  snapshot.plans.push({ taskId: snapshot.tasks[0].id, date: '2026-09-27', sortOrder: 29 });
  snapshot.plans.push({ taskId: snapshot.tasks[3].id, date: '2026-09-23', sortOrder: 41 });
  return snapshot;
}

async function setup(context: BrowserContext, page: Page, initial = fixture(), clock = now) {
  await context.addInitScript(({ key, value }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
  }, { key: storageKey, value: initial });
  await page.clock.setFixedTime(clock);
  await page.goto('/?surface=console');
  await expect(page.locator('.console-shell')).toBeVisible();
  return initial;
}

async function openSurface(context: BrowserContext, surface: 'console' | 'edge-panel', clock = now) {
  const page = await context.newPage();
  await page.clock.setFixedTime(clock);
  if (surface === 'edge-panel') await page.setViewportSize({ width: 368, height: 610 });
  await page.goto(`/?surface=${surface}`);
  await expect(page.locator(surface === 'console' ? '.console-shell' : '.edge-panel')).toBeVisible();
  return page;
}

function nav(page: Page, label: string) {
  return page.locator('.sidebar').getByRole('button', { name: new RegExp(`^${label}(?:\\s*\\d+)?$`) });
}
function mainTitles(page: Page) { return page.locator('.main-content .task-list .task-title'); }
function detail(page: Page) { return page.locator('.task-detail'); }
function edit(page: Page, title: string) { return page.getByRole('button', { name: `编辑任务：${title}`, exact: true }); }
function edgeZone(page: Page, title: string) {
  return page.locator('.edge-zone').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
}
async function persisted(page: Page): Promise<Snapshot> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
}
function originalFields(task: Task) {
  const { deletedAt: _deletedAt, revision: _revision, ...fields } = task;
  return fields;
}
async function trash(page: Page, title: string) {
  await edit(page, title).click();
  await detail(page).getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(detail(page)).toHaveCount(0);
  await expect(page.locator('.toast')).toContainText('已移入回收站');
}
async function expectVisibleFocus(locator: Locator) {
  await expect(locator).toBeFocused();
  await expect(locator).toBeInViewport();
  expect(await locator.evaluate(element => {
    const style = getComputedStyle(element);
    return element.matches(':focus-visible') && parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none';
  })).toBe(true);
}

test('移入回收站从全部日常视图和小窗计数移除，搜索恢复保留原任务与全部计划', async ({ page, context }) => {
  const initial = await setup(context, page);
  const panel = await openSurface(context, 'edge-panel');
  await expect(edgeZone(panel, '今日计划').locator('.edge-section-heading small')).toHaveText('1 / 4 已完成');
  await expect(edgeZone(panel, '截止日期').locator('.edge-section-heading > div > span')).toHaveText('4');
  await trash(page, titles[0]);
  await expect(edit(page, titles[1])).toBeFocused();
  await expect(edit(panel, titles[0])).toHaveCount(0);
  await expect(edgeZone(panel, '今日计划').locator('.edge-section-heading > div > span')).toHaveText('2');
  await expect(edgeZone(panel, '今日计划').locator('.edge-section-heading small')).toHaveText('1 / 3 已完成');
  await expect(edgeZone(panel, '截止日期').locator('.edge-section-heading > div > span')).toHaveText('3');
  await expect(nav(page, '今日').locator('.nav-count')).toHaveText('2');
  await expect(nav(page, '全部任务').locator('.nav-count')).toHaveText('4');
  await expect(nav(page, '截止日期').locator('.nav-count')).toHaveText('3');
  for (const label of ['全部任务', '截止日期', '已完成', '今日']) {
    await nav(page, label).click();
    await expect(edit(page, titles[0])).toHaveCount(0);
  }
  await expect(page.locator('.list-hint')).toHaveText('已完成 1 / 3');
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill(titles[0]);
  await expect(mainTitles(page)).toHaveCount(0);
  await expect(page.locator('.empty-state')).toContainText('没有找到相关任务');
  await nav(page, '回收站').click();
  await expect(mainTitles(page)).toHaveText([titles[0]]);
  const search = page.getByRole('textbox', { name: '搜索回收站', exact: true });
  await search.fill(titles[1]);
  await expect(mainTitles(page)).toHaveCount(0);
  await search.fill(initial.tasks[0].notes);
  await expect(mainTitles(page)).toHaveText([titles[0]]);
  const deleted = await persisted(page);
  expect(deleted.tasks.map(originalFields)).toEqual(initial.tasks.map(originalFields));
  expect(deleted.tasks[0].deletedAt).toBe(now.toISOString());
  expect(deleted.plans).toEqual(initial.plans);

  await page.getByRole('button', { name: `恢复任务：${titles[0]}`, exact: true }).click();
  await expect(mainTitles(page)).toHaveCount(0);
  await expect(edit(panel, titles[0])).toHaveCount(2);
  await expect(edgeZone(panel, '今日计划').locator('.edge-section-heading small')).toHaveText('1 / 4 已完成');
  await page.locator('.toast').getByRole('button', { name: '查看任务', exact: true }).click();
  await expect(detail(page).getByRole('textbox', { name: '任务名称', exact: true })).toHaveValue(titles[0]);
  const restored = await persisted(page);
  expect(restored.tasks.map(originalFields)).toEqual(initial.tasks.map(originalFields));
  expect(restored.tasks[0].deletedAt ?? null).toBeNull();
  expect(restored.tasks[0].revision).toBe(initial.tasks[0].revision + 2);
  expect(restored.plans).toEqual(initial.plans);
  expect(restored.settings).toEqual(initial.settings);
  await page.reload();
  await panel.reload();
  await expect(edit(panel, titles[0])).toHaveCount(2);
  expect(await persisted(page)).toEqual(restored);
});

test('已完成任务恢复后仍已完成，查看任务定位完成页并保留完成时间', async ({ page, context }) => {
  const initial = await setup(context, page);
  const panel = await openSurface(context, 'edge-panel');
  await nav(page, '已完成').click();
  await trash(page, titles[3]);
  await expect(nav(page, '已完成').locator('.nav-count')).toHaveText('0');
  await expect(edgeZone(panel, '今日计划').locator('.edge-section-heading small')).toHaveText('0 / 3 已完成');
  await expect(panel.getByRole('button', { name: /^已完成/ })).toHaveCount(0);
  await nav(page, '回收站').click();
  const row = page.locator('.trash-task-row');
  await expect(row).toContainText('原状态：已完成');
  await row.getByRole('button', { name: `查看已删除任务：${titles[3]}`, exact: true }).click();
  await expect(detail(page).locator('.task-state-pill')).toHaveText('已完成');
  await expect(detail(page).getByRole('textbox', { name: '任务名称', exact: true })).not.toBeEditable();
  await expect(detail(page).getByRole('button', { name: '撤销完成', exact: true })).toHaveCount(0);
  await detail(page).getByRole('button', { name: '恢复此任务', exact: true }).click();
  await page.locator('.toast').getByRole('button', { name: '查看任务', exact: true }).click();
  await expect(page.locator('.page-heading h1')).toHaveText('已完成');
  await expect(mainTitles(page)).toHaveText([titles[3]]);
  await expect(detail(page).locator('.task-state-pill')).toHaveText('已完成');
  await expect(edgeZone(panel, '今日计划').locator('.edge-section-heading small')).toHaveText('1 / 4 已完成');
  const restored = await persisted(page);
  expect(originalFields(restored.tasks[3])).toEqual(originalFields(initial.tasks[3]));
  expect(restored.plans).toEqual(initial.plans);
});

test('脏详情可继续编辑、保存后移入或明确放弃修改，恢复只保留选择保存的内容', async ({ page, context }) => {
  const initial = await setup(context, page);
  await edit(page, titles[0]).click();
  const notes = detail(page).getByLabel('备注');
  await notes.fill('明确保存的回收站备注');
  const move = detail(page).getByRole('button', { name: '移入回收站', exact: true });
  await move.click();
  const prompt = page.getByRole('dialog', { name: '移入回收站前保留修改？', exact: true });
  await prompt.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(prompt).toBeHidden();
  await expect(notes).toHaveValue('明确保存的回收站备注');
  await expect(move).toBeFocused();
  expect(await persisted(page)).toEqual(initial);
  await move.click();
  await prompt.getByRole('button', { name: '保存后移入', exact: true }).click();
  await expect(detail(page)).toHaveCount(0);
  let saved = await persisted(page);
  expect(originalFields(saved.tasks[0])).toEqual({ ...originalFields(initial.tasks[0]), notes: '明确保存的回收站备注' });
  expect(saved.tasks[0].deletedAt).toBeTruthy();
  expect(saved.plans).toEqual(initial.plans);
  await page.locator('.toast').getByRole('button', { name: '恢复', exact: true }).click();
  await expect(edit(page, titles[0])).toBeVisible();
  await edit(page, titles[0]).click();
  await expect(notes).toHaveValue('明确保存的回收站备注');
  await notes.fill('明确放弃的内容');
  await move.click();
  await prompt.getByRole('button', { name: '放弃修改并移入', exact: true }).click();
  await expect(detail(page)).toHaveCount(0);
  saved = await persisted(page);
  expect(originalFields(saved.tasks[0])).toEqual({ ...originalFields(initial.tasks[0]), notes: '明确保存的回收站备注' });
  expect(saved.plans).toEqual(initial.plans);
  await page.locator('.toast').getByRole('button', { name: '恢复', exact: true }).click();
  await edit(page, titles[0]).click();
  await expect(notes).toHaveValue('明确保存的回收站备注');
  await expect(page.locator('.workspace-statusbar')).toContainText('更改已保存在本机');
});

test('另一控制台删除任务时脏详情保留，恢复后需明确重新确认草稿版本', async ({ page, context }) => {
  const initial = await setup(context, page);
  const other = await openSurface(context, 'console');
  await edit(page, titles[0]).click();
  const notes = detail(page).getByLabel('备注');
  await notes.fill('跨窗口必须保留的草稿');
  await trash(other, titles[0]);
  await expect(detail(page)).toBeVisible();
  await expect(notes).toHaveValue('跨窗口必须保留的草稿');
  await expect(notes).not.toBeEditable();
  await expect(detail(page).locator('.trash-detail-notice')).toContainText('草稿仍保留');
  await expect(detail(page).getByRole('button', { name: '保存修改', exact: true })).toHaveCount(0);
  expect((await persisted(page)).tasks[0].notes).toBe(initial.tasks[0].notes);
  await detail(page).getByRole('button', { name: '恢复此任务', exact: true }).click();
  await expect(notes).toHaveValue('跨窗口必须保留的草稿');
  await expect(notes).toBeEditable();
  const save = detail(page).getByRole('button', { name: '保存修改', exact: true });
  await expect(save).toBeDisabled();
  await detail(page).getByRole('button', { name: '保留草稿，基于最新版本保存', exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.locator('.workspace-statusbar')).toContainText('更改已保存在本机');
  const restored = await persisted(page);
  expect(originalFields(restored.tasks[0])).toEqual({ ...originalFields(initial.tasks[0]), notes: '跨窗口必须保留的草稿' });
  expect(restored.tasks[0].deletedAt ?? null).toBeNull();
  expect(restored.tasks[0].completed).toBe(initial.tasks[0].completed);
  expect(restored.plans).toEqual(initial.plans);
  await edit(other, titles[0]).click();
  await expect(detail(other).getByLabel('备注')).toHaveValue('跨窗口必须保留的草稿');
});

test('跨日恢复不自动安排今天，窄窗回收站可用键盘恢复并查看原任务', async ({ page, context }, testInfo) => {
  const initial = fixture();
  initial.tasks = [initial.tasks[0]];
  initial.tasks[0].deletedAt = '2026-09-25T04:00:00.000Z';
  initial.tasks[0].revision = 2;
  initial.plans = initial.plans.filter(plan => plan.taskId === initial.tasks[0].id && plan.date <= date);
  const tomorrow = new Date('2026-09-26T04:00:00.000Z');
  await page.setViewportSize({ width: 760, height: 760 });
  await setup(context, page, initial, tomorrow);
  const panel = await openSurface(context, 'edge-panel', tomorrow);
  await expect(page.locator('.empty-state')).toContainText('今日暂无任务');
  await nav(page, '回收站').click();
  await expect(mainTitles(page)).toHaveText([titles[0]]);
  const row = page.locator('.trash-task-row');
  const restore = row.getByRole('button', { name: `恢复任务：${titles[0]}`, exact: true });
  await row.getByRole('button', { name: `查看已删除任务：${titles[0]}`, exact: true }).focus();
  await page.keyboard.press('Tab');
  await expectVisibleFocus(restore);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('narrow-trash-keyboard.png'), fullPage: true });
  await page.keyboard.press('Enter');
  await expect(page.locator('.empty-state')).toContainText('回收站为空');
  await expect(page.getByRole('main', { name: '回收站', exact: true })).toBeFocused();
  await expect(edgeZone(panel, '今日计划').locator('.edge-section-heading > div > span')).toHaveText('0');
  const view = page.locator('.toast').getByRole('button', { name: '查看任务', exact: true });
  await view.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.page-heading h1')).toHaveText('全部任务');
  const title = detail(page).getByRole('textbox', { name: '任务名称', exact: true });
  await expect(title).toHaveValue(titles[0]);
  await expect(title).toBeFocused();
  const restored = await persisted(page);
  expect(originalFields(restored.tasks[0])).toEqual(originalFields(initial.tasks[0]));
  expect(restored.plans).toEqual(initial.plans);
  expect(restored.plans.some(plan => plan.date === '2026-09-26')).toBe(false);
  await detail(page).getByRole('button', { name: '关闭任务详情', exact: true }).click();
  await nav(page, '今日').click();
  await expect(mainTitles(page)).toHaveCount(0);
  await expect(page.locator('.backlog-section')).toContainText(titles[0]);
});
