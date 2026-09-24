import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/virtual-list.html');
  await expect(page.getByRole('list', { name: '合成任务列表' })).toBeVisible();
});

test('10k任务保持有界DOM，键盘可达末项并离开列表', async ({ page }) => {
  const list = page.getByRole('list', { name: '合成任务列表' });
  await expect(list).toHaveAttribute('data-virtualized', 'true');
  expect(await list.getByRole('listitem').count()).toBeLessThan(60);
  await list.locator('.task-open').first().focus();
  await page.keyboard.press('End');
  await expect(page.locator('[data-task-list-id="task-9999"] .task-open')).toBeFocused();
  await expect(page.locator('[data-task-list-id="task-9999"]')).toBeInViewport();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: '列表之后', exact: true })).toBeFocused();
  expect(await list.getByRole('listitem').count()).toBeLessThan(60);
});

test('跨未挂载行的Tab/方向键保持顺序，搜索回顶且不截断结果', async ({ page }) => {
  const list = page.getByRole('list', { name: '合成任务列表' });
  await list.locator('.task-open').first().focus();
  for (let index = 0; index < 50; index++) await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-task-list-id="task-50"] .task-open')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('[data-task-list-id="task-51"] .task-check')).toBeFocused();
  await page.getByLabel('筛选合成任务').fill('第09999项');
  await expect(page.locator('[data-task-list-id="task-9999"] .task-open')).toBeVisible();
  await expect.poll(() => page.locator('main').evaluate(element => element.scrollTop)).toBe(0);
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await page.getByLabel('筛选合成任务').fill('');
  await expect(page.locator('[data-task-list-id="task-0"] .task-open')).toBeVisible();
  expect(await list.getByRole('listitem').count()).toBeLessThan(60);
});

test('滚走后焦点行仍挂载，完成后焦点落在相邻任务', async ({ page }) => {
  const first = page.locator('[data-task-list-id="task-0"] .task-check');
  await first.focus();
  await page.locator('main').evaluate(element => { element.scrollTop = 35000; });
  await expect(first).toBeFocused();
  await expect(page.locator('[data-task-list-id="task-0"]')).toHaveCount(1);
  await page.keyboard.press('Home');
  await expect(page.locator('[data-task-list-id="task-0"]')).toBeInViewport();
  await page.keyboard.press('ArrowDown');
  const second = page.locator('[data-task-list-id="task-1"] .task-check');
  await expect(second).toBeFocused();
  await page.keyboard.press('Space');
  await expect(second).toHaveCount(0);
  await expect(page.locator('[data-task-list-id="task-2"] .task-check')).toBeFocused();
});

test('移除视口前任务保留当前任务锚点', async ({ page }) => {
  await page.locator('main').evaluate(element => { element.scrollTop = 35000; });
  await expect.poll(() => page.locator('[data-task-list-index]').first().getAttribute('data-task-list-index')).not.toBe('0');
  const anchor = await page.locator('main').evaluate(element => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>('[data-task-list-id]')].find(item => item.getBoundingClientRect().top >= top)!;
    return { id: row.dataset.taskListId!, top: row.getBoundingClientRect().top };
  });
  await page.getByRole('button', { name: '移除列表前十项', exact: true }).click();
  await expect.poll(async () => Math.abs((await page.locator(`[data-task-list-id="${anchor.id}"]`).boundingBox())!.y - anchor.top)).toBeLessThan(3);
});

test('四风格与窄宽度测量长中文行，相邻行贴合', async ({ page }, testInfo) => {
  for (const style of ['paper', 'studio', 'editorial', 'mono']) {
    await page.getByLabel('风格', { exact: true }).selectOption(style);
    await page.getByRole('button', { name: '切换宽度', exact: true }).click();
    await expect.poll(() => page.getByRole('list').evaluate(element => {
      const rows = [...element.querySelectorAll<HTMLElement>('[data-task-list-index]')].map(row => row.getBoundingClientRect());
      return rows.every((row, index) => !index || Math.abs(row.top - rows[index - 1].bottom) < 1.5);
    })).toBe(true);
    const first = page.locator('[data-task-list-id="task-0"]');
    expect((await first.boundingBox())!.height).toBeGreaterThan(80);
  }
  await page.screenshot({ path: testInfo.outputPath('virtual-list-chinese-mono.png') });
});

test('共享滚动容器切回重新挂载的主列表也回顶', async ({ page }) => {
  await page.locator('main').evaluate(element => { element.scrollTop = 3500; });
  await page.getByRole('button', { name: '切换任务页面', exact: true }).click();
  await expect(page.getByText('合成设置页面', { exact: true })).toHaveCount(1);
  expect(await page.locator('main').evaluate(element => element.scrollTop)).toBeGreaterThan(1000);
  await page.getByRole('button', { name: '切换任务页面', exact: true }).click();
  await expect(page.locator('[data-task-list-id="task-0"] .task-open')).toBeVisible();
  await expect.poll(() => page.locator('main').evaluate(element => element.scrollTop)).toBe(0);
});
