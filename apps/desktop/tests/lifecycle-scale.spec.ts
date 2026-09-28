import { expect, test } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot } from '../src/lib/types';

// Fresh browser storage only. This covers the actual console, trash rows and
// preview transaction path; timings are observations, not native benchmarks.
test('一万项回收站保留全量数据，末项可用键盘搜索恢复并联动今日与DDL', async ({ page }, testInfo) => {
  const date = '2026-09-25';
  const count = 10_000;
  const initial: Snapshot = {
    revision: 10,
    settings: createSeed(date).settings,
    tasks: Array.from({ length: count }, (_, index) => ({
      id: `trash-${String(index).padStart(5, '0')}`,
      title: `规模任务 ${String(index).padStart(5, '0')}${index % 37 === 0 ? '：整理较长中文背景，检查每个细节并保留原始任务说明。'.repeat(3) : ''}`,
      notes: `合成记录 ${index}`,
      priority: 'normal',
      dueDate: date,
      dueTime: null,
      completed: false,
      createdAt: '2026-09-20T04:00:00.000Z',
      completedAt: null,
      deletedAt: '2026-09-24T04:00:00.000Z',
      revision: 2,
    })),
    plans: Array.from({ length: count }, (_, index) => ({
      taskId: `trash-${String(index).padStart(5, '0')}`, date, sortOrder: index,
    })),
  };
  const last = initial.tasks.at(-1)!;
  initial.plans.push(
    { taskId: last.id, date: '2026-09-24', sortOrder: 41 },
    { taskId: last.id, date: '2026-09-27', sortOrder: 99 },
  );
  await page.clock.setFixedTime(new Date(`${date}T04:00:00.000Z`));
  await page.addInitScript(snapshot => {
    localStorage.setItem('sidetask-browser-preview-v1', JSON.stringify(snapshot));
  }, initial);
  const observations: Record<string, number> = {};
  let started = Date.now();
  await page.goto('/?surface=console');
  await expect(page.locator('.console-shell')).toBeVisible();
  observations.initialLoadMs = Date.now() - started;
  const nav = (name: string) => page.locator('.sidebar').getByRole('button', { name: new RegExp(`^${name}(?:\\s*\\d+)?$`) });
  for (const name of ['今日', '截止日期']) {
    await nav(name).click();
    await expect(nav(name).locator('.nav-count')).toHaveText('0');
    await expect(page.locator('.main-content .task-row')).toHaveCount(0);
  }
  await expect(nav('回收站').locator('.nav-count')).toHaveText(String(count));

  started = Date.now();
  await nav('回收站').click();
  const list = page.getByRole('list', { name: '回收站', exact: true });
  await expect(list).toHaveAttribute('data-virtualized', 'true');
  await expect(list.getByRole('listitem').first()).toHaveAttribute('aria-setsize', String(count));
  await expect(page.locator('.main-content .list-heading .count-badge')).toHaveText(String(count));
  observations.trashOpenMs = Date.now() - started;
  observations.initialMountedRows = await list.getByRole('listitem').count();
  observations.initialDomElements = await page.locator('*').count();
  expect(observations.initialMountedRows).toBeGreaterThan(0);
  expect(observations.initialMountedRows).toBeLessThan(80);
  expect(observations.initialDomElements).toBeLessThan(3_000);

  await list.locator('.task-open').first().focus();
  started = Date.now();
  await page.keyboard.press('End');
  const lastRow = list.locator(`[data-task-list-id="${last.id}"]`);
  await expect(lastRow.locator('.task-open')).toBeFocused();
  await expect(lastRow).toBeInViewport();
  await expect(lastRow).toHaveAttribute('aria-posinset', String(count));
  observations.keyboardEndMs = Date.now() - started;
  observations.endMountedRows = await list.getByRole('listitem').count();
  expect(observations.endMountedRows).toBeLessThan(80);
  expect(await page.locator('*').count()).toBeLessThan(3_000);

  started = Date.now();
  await page.getByRole('textbox', { name: '搜索回收站', exact: true }).fill(last.title);
  const searchResults = page.getByRole('list', { name: '回收站搜索结果', exact: true });
  await expect(searchResults.getByRole('listitem')).toHaveCount(1);
  await expect(searchResults.locator('.task-title')).toHaveText(last.title);
  await expect(page.locator('.main-content .list-heading .count-badge')).toHaveText('1');
  await expect.poll(() => page.locator('.main-content').evaluate(element => element.scrollTop)).toBe(0);
  observations.searchLastMs = Date.now() - started;

  started = Date.now();
  await searchResults.getByRole('button', { name: `恢复任务：${last.title}`, exact: true }).click();
  await expect(nav('回收站').locator('.nav-count')).toHaveText(String(count - 1));
  await expect(page.locator('.main-content .task-row')).toHaveCount(0);
  observations.restoreMs = Date.now() - started;
  for (const name of ['今日', '截止日期']) {
    await nav(name).click();
    await expect(nav(name).locator('.nav-count')).toHaveText('1');
    await expect(page.locator('.main-content .task-row')).toHaveCount(1);
    await expect(page.locator('.main-content').getByRole('button', { name: `编辑任务：${last.title}`, exact: true })).toBeVisible();
  }

  const committed = await page.evaluate(() => JSON.parse(localStorage.getItem('sidetask-browser-preview-v1')!) as Snapshot);
  const expected = structuredClone(initial);
  // Legacy preview snapshots acquire empty list orders on their first write.
  expected.taskOrder = [];
  expected.deadlineOrder = [];
  expected.revision += 1;
  expected.tasks.at(-1)!.revision += 1;
  expected.tasks.at(-1)!.deletedAt = null;
  expect(committed.tasks).toHaveLength(count);
  expect(committed.tasks.filter(task => task.deletedAt != null)).toHaveLength(count - 1);
  // Full equality catches truncation, rewritten records and changed historical
  // or future plans, rather than proving only the visible restored item.
  expect(committed).toEqual(expected);
  observations.payloadUtf8Bytes = new TextEncoder().encode(JSON.stringify(initial)).length;
  console.log(`Lifecycle scale observations (browser preview, no timing pass threshold): ${JSON.stringify(observations)}`);
  await testInfo.attach('browser-scale-observations', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' });
});
