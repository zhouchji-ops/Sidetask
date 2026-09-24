import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot } from '../src/lib/types';

// These isolated browser contexts exercise real preview persistence and window
// notifications. They do not access personal SQLite data or certify native IPC.
const storageKey = 'sidetask-browser-preview-v1';
const date = '2026-09-25';
const fixedTime = new Date(`${date}T04:00:00.000Z`);
const titles = ['合成写作练习', '合成阅读笔记', '合成数学作业', '合成已完成复习', '合成周末资料', '合成参考材料'];

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

async function setup(context: BrowserContext, page: Page, snapshot = fixture()): Promise<Snapshot> {
  await context.addInitScript(({ key, value }) => {
    // Reload and a second surface must read the committed state, never reseed it.
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
  }, { key: storageKey, value: snapshot });
  await page.clock.setFixedTime(fixedTime);
  await page.goto('/?surface=console');
  await expect(consoleTitles(page)).toHaveText(titles.slice(0, 3));
  return snapshot;
}

async function openPanel(context: BrowserContext): Promise<Page> {
  const panel = await context.newPage();
  await panel.clock.setFixedTime(fixedTime);
  await panel.setViewportSize({ width: 368, height: 610 });
  await panel.goto('/?surface=edge-panel');
  await expect(panel.locator('.edge-panel')).toBeVisible();
  return panel;
}

function consoleTitles(page: Page): Locator {
  return page.locator('.main-content .task-list .task-title');
}

function panelZone(panel: Page, name: string): Locator {
  return panel.locator('.edge-zone').filter({ has: panel.getByRole('heading', { name, exact: true }) });
}

function panelTitles(panel: Page): Locator {
  return panelZone(panel, '今日计划').locator('.task-row:not(.is-completed) .task-title');
}

async function readSnapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
}

function preservedPlans(snapshot: Snapshot) {
  const completedIds = new Set(snapshot.tasks.filter(task => task.completed).map(task => task.id));
  return snapshot.plans.filter(plan => plan.date !== date || completedIds.has(plan.taskId));
}

test('上移下移跨窗口同步并在重载后保留，只修改今日未完成计划的顺序', async ({ page, context }) => {
  const initial = await setup(context, page);
  const panel = await openPanel(context);
  await expect(panelTitles(panel)).toHaveText(titles.slice(0, 3));
  const deadlineTitles = await panelZone(panel, '截止日期').locator('.task-title').allTextContents();
  await expect(page.getByRole('button', { name: `上移任务：${titles[0]}`, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: `下移任务：${titles[2]}`, exact: true })).toBeDisabled();

  // Tab skips the disabled first-row Up control and exposes a visible focus ring.
  await page.getByRole('button', { name: `编辑任务：${titles[0]}`, exact: true }).focus();
  await page.keyboard.press('Tab');
  const down = page.getByRole('button', { name: `下移任务：${titles[0]}`, exact: true });
  await expect(down).toBeFocused();
  await expect(down).toBeInViewport();
  expect(await down.evaluate(element => {
    const style = getComputedStyle(element);
    return element.matches(':focus-visible') && parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== 'none';
  })).toBe(true);
  await expect(page.locator('.task-row').filter({ has: down }).locator('.task-quick-actions')).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await expect(consoleTitles(page)).toHaveText([titles[1], titles[0], titles[2]]);
  await expect(panelTitles(panel)).toHaveText([titles[1], titles[0], titles[2]]);

  await page.getByRole('button', { name: `上移任务：${titles[2]}`, exact: true }).click();
  const arranged = [titles[1], titles[2], titles[0]];
  await expect(consoleTitles(page)).toHaveText(arranged);
  await expect(panelTitles(panel)).toHaveText(arranged);
  await expect(page.getByRole('button', { name: `上移任务：${titles[1]}`, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: `下移任务：${titles[0]}`, exact: true })).toBeDisabled();
  await expect(panelZone(panel, '截止日期').locator('.task-title')).toHaveText(deadlineTitles);

  const committed = await readSnapshot(page);
  expect(committed.tasks).toEqual(initial.tasks);
  expect(committed.settings).toEqual(initial.settings);
  expect(preservedPlans(committed)).toEqual(preservedPlans(initial));
  expect(committed.revision).toBe(initial.revision + 2);
  await page.reload();
  await panel.reload();
  await expect(consoleTitles(page)).toHaveText(arranged);
  await expect(panelTitles(panel)).toHaveText(arranged);
  expect(await readSnapshot(page)).toEqual(committed);
});

test('边缘移出今日保留任务和截止日期，控制台同步且可重新加入', async ({ page, context }) => {
  const initial = await setup(context, page);
  const panel = await openPanel(context);
  const task = initial.tasks[0];
  const deadlines = panelZone(panel, '截止日期');
  const deadlineRow = deadlines.locator('.task-row').filter({ has: panel.getByRole('button', { name: `编辑任务：${task.title}`, exact: true }) });
  await expect(deadlineRow.locator('.today-indicator')).toBeVisible();
  await panelZone(panel, '今日计划').getByRole('button', { name: `将${task.title}移出今日`, exact: true }).click();
  await expect(panelTitles(panel)).toHaveText([titles[1], titles[2]]);
  await expect(consoleTitles(page)).toHaveText([titles[1], titles[2]]);
  await expect(page.locator('.backlog-section')).toContainText(task.title);
  await expect(deadlineRow).toBeVisible();
  await expect(deadlineRow.locator('.today-indicator')).toHaveCount(0);
  await expect(deadlineRow.getByRole('button', { name: `将${task.title}加入今日`, exact: true })).toBeVisible();
  const removed = await readSnapshot(page);
  expect(removed.tasks).toEqual(initial.tasks);
  expect(removed.settings).toEqual(initial.settings);
  expect(removed.plans).toEqual(initial.plans.filter(plan => !(plan.date === date && plan.taskId === task.id)));

  await panel.locator('.edge-feedback').getByRole('button', { name: '重新加入', exact: true }).click();
  await expect(panelTitles(panel)).toHaveText([titles[1], titles[2], titles[0]]);
  await expect(consoleTitles(page)).toHaveText([titles[1], titles[2], titles[0]]);
  await expect(deadlineRow.locator('.today-indicator')).toBeVisible();
  const restored = await readSnapshot(page);
  expect(restored.tasks).toEqual(initial.tasks);
  expect(restored.plans.filter(plan => plan.date !== date)).toEqual(initial.plans.filter(plan => plan.date !== date));
  expect(restored.plans.find(plan => plan.date === date && plan.taskId === initial.tasks[3].id)).toBeDefined();
  expect(restored.plans.filter(plan => plan.date === date && plan.taskId === task.id)).toHaveLength(1);
  expect(restored.revision).toBe(initial.revision + 2);
});

test('全局搜索涵盖已完成和未安排任务，隐藏排序并在清除后返回今日顺序', async ({ page, context }) => {
  await setup(context, page);
  await page.getByRole('button', { name: `上移任务：${titles[2]}`, exact: true }).click();
  const arranged = [titles[0], titles[2], titles[1]];
  await expect(consoleTitles(page)).toHaveText(arranged);
  const committed = await readSnapshot(page);
  const search = page.getByRole('textbox', { name: '搜索任务', exact: true });
  await search.fill('合成');
  await expect(page.locator('.list-heading')).toContainText('全部任务中的搜索结果');
  await expect(consoleTitles(page)).toHaveText(titles);
  await expect(page.getByRole('button', { name: /^(上移任务：|下移任务：)/ })).toHaveCount(0);
  await search.fill(titles[3]);
  await expect(consoleTitles(page)).toHaveText([titles[3]]);
  await expect(page.locator('.task-list .task-row')).toHaveClass(/is-completed/);
  await search.fill(titles[4]);
  await expect(consoleTitles(page)).toHaveText([titles[4]]);
  await expect(page.getByRole('button', { name: `将${titles[4]}加入今日`, exact: true })).toBeVisible();
  await page.getByTitle('清除搜索', { exact: true }).click();
  await expect(page.locator('.page-heading h1')).toHaveText('今日');
  await expect(consoleTitles(page)).toHaveText(arranged);
  await expect(page.getByRole('button', { name: `上移任务：${titles[2]}`, exact: true })).toBeEnabled();
  expect(await readSnapshot(page)).toEqual(committed);
});


test('连续移出留下顺序空洞后，重新加入和新建都排在今日末尾', async ({ page, context }) => {
  const seed = fixture();
  seed.plans = seed.plans.filter(plan => plan.date === date && !seed.tasks.find(task => task.id === plan.taskId)!.completed);
  const initial = await setup(context, page, seed);
  const panel = await openPanel(context);
  await page.getByRole('button', { name: `将${titles[0]}移出今日`, exact: true }).click();
  await page.getByRole('button', { name: `将${titles[1]}移出今日`, exact: true }).click();
  await expect(consoleTitles(page)).toHaveText([titles[2]]);
  await page.getByRole('button', { name: '重新加入今日', exact: true }).click();
  await expect(consoleTitles(page)).toHaveText([titles[2], titles[1]]);
  await expect(panelTitles(panel)).toHaveText([titles[2], titles[1]]);
  expect((await readSnapshot(page)).tasks).toEqual(initial.tasks);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByRole('textbox', { name: '任务名称', exact: true }).fill('合成最后加入的任务');
  await page.getByRole('button', { name: '创建任务', exact: true }).click();
  const expected = [titles[2], titles[1], '合成最后加入的任务'];
  await expect(consoleTitles(page)).toHaveText(expected);
  await expect(panelTitles(panel)).toHaveText(expected);
  await page.reload();
  await expect(consoleTitles(page)).toHaveText(expected);
});
