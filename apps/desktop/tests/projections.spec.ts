import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot } from '../src/lib/types';

const date = '2026-09-24';
async function seedPage(page: Page, snapshot: Snapshot, surface = 'console') {
  await page.addInitScript(value => localStorage.setItem('sidetask-browser-preview-v1', JSON.stringify(value)), snapshot);
  await page.clock.install({ time: new Date('2026-09-24T04:00:00.000Z') });
  await page.clock.pauseAt(new Date('2026-09-24T15:59:59.000Z'));
  await page.goto(`/?surface=${surface}`);
}

test('今日页搜索全部任务和完成记录，清除搜索回到原来的今日计划', async ({ page }) => {
  const snapshot = createSeed(date);
  await seedPage(page, snapshot);
  const search = page.getByRole('textbox', { name: '搜索任务' });
  const main = page.locator('.main-content');
  await expect(search).toHaveAttribute('placeholder', '搜索全部任务');
  await expect(main.locator('.task-list .task-row')).toHaveCount(3);

  const unplanned = snapshot.tasks[4];
  await search.fill(unplanned.title);
  await expect(main.locator('.list-heading')).toContainText('全部任务中的搜索结果');
  await expect(main.getByRole('button', { name: `编辑任务：${unplanned.title}`, exact: true })).toBeVisible();
  await expect(main.getByRole('button', { name: `将${unplanned.title}加入今日`, exact: true })).toBeVisible();

  const completed = snapshot.tasks[3];
  await search.fill(completed.title);
  await expect(main.getByRole('button', { name: `撤销完成：${completed.title}`, exact: true })).toBeVisible();
  await expect(main.locator('.task-row')).toHaveClass(/is-completed/);
  await expect(main.locator('.today-indicator')).toHaveText('今日');

  await search.fill('');
  await expect(page.locator('.page-heading h1')).toHaveText('今日');
  await expect(main.locator('.task-list .task-row')).toHaveCount(3);
  await expect(main.getByRole('button', { name: `编辑任务：${unplanned.title}`, exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sidetask-browser-preview-v1')!).revision)).toBe(snapshot.revision);
});

test('两窗口共享此前未完成规则；午夜和时钟回调重新计算计划且不写库', async ({ page, context }) => {
  const snapshot = createSeed(date);
  snapshot.plans = snapshot.plans.filter(plan => plan.taskId !== 'demo-design');
  snapshot.plans.push(
    { taskId: 'demo-design', date: '2026-09-23', sortOrder: 0 },
    { taskId: 'demo-design', date: '2026-09-25', sortOrder: 0 },
    { taskId: 'demo-lab', date: '2026-09-23', sortOrder: 1 },
  );
  await seedPage(page, snapshot);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 368, height: 610 });
  await seedPage(panel, snapshot, 'edge-panel');
  await expect(page.locator('.backlog-section .task-row')).toHaveCount(1);
  await expect(page.locator('.backlog-section')).toContainText('提交数据分析实验报告');
  await expect(panel.locator('.edge-backlog-link')).toContainText('此前未完成 1');

  for (const surface of [page, panel]) await surface.clock.fastForward(1100);
  await expect(page.locator('.task-list .task-row')).toHaveCount(1);
  await expect(page.locator('.task-list')).toContainText('完成交互设计课程作业');
  await expect(page.locator('.backlog-section .task-row')).toHaveCount(3);
  await expect(panel.locator('.edge-zone').first().locator('.task-row')).toHaveCount(1);
  await expect(panel.locator('.edge-backlog-link')).toContainText('此前未完成 3');

  for (const surface of [page, panel]) {
    await surface.clock.setSystemTime(new Date('2026-09-24T04:00:00.000Z'));
    await surface.clock.fastForward(1100);
  }
  await expect(page.locator('.task-list .task-row')).toHaveCount(2);
  await expect(page.locator('.backlog-section .task-row')).toHaveCount(1);
  await expect(panel.locator('.edge-backlog-link')).toContainText('此前未完成 1');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('sidetask-browser-preview-v1')!))).toEqual(snapshot);
});
