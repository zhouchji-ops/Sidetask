import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';

// These tests use the browser preview adapter and isolated synthetic storage.
// They verify UI flows, not native Tauri window focus, multi-monitor bounds, or SQLite.

const sampleTask = '完成交互设计课程作业';
const dueDate = '2028-10-15';

async function openConsole(page: Page) {
  await page.goto('/?surface=console');
  await expect(page.locator('.page-heading h1')).toHaveText('今日');
}

async function seedHoverPreview(page: Page) {
  const snapshot = createSeed();
  snapshot.settings.revealMode = 'hover';
  await page.addInitScript(snapshot => localStorage.setItem('sidetask-browser-preview-v1', JSON.stringify(snapshot)), snapshot);
}

async function navigate(page: Page, name: string) {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
}

async function createTask(page: Page, title: string, planned = true) {
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('任务名称', { exact: true })).toBeFocused();
  await dialog.getByLabel('任务名称', { exact: true }).fill(title);
  await dialog.getByLabel('截止日期').fill(dueDate);
  await dialog.getByLabel('具体时间').fill('18:30');
  await dialog.getByLabel('重要程度', { exact: true }).selectOption('high');
  await dialog.getByLabel('备注').fill('测试合成数据：准备最终报告。');
  const toggle = dialog.getByRole('switch', { name: '安排到今日' });
  if ((await toggle.getAttribute('aria-checked')) !== String(planned)) await toggle.click();
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test('创建精确 DDL；今日和截止列表引用同一任务，完成后可撤销', async ({ page }) => {
  await openConsole(page);
  const title = '提交系统设计报告';
  await createTask(page, title);
  const main = page.locator('.main-content');
  await expect(main.getByRole('button', { name: `编辑任务：${title}`, exact: true })).toHaveCount(1);
  await navigate(page, '截止日期');
  await main.getByRole('button', { name: `编辑任务：${title}`, exact: true }).click();
  const detail = page.locator('.task-detail');
  await expect(detail.getByLabel('截止日期', { exact: true })).toHaveValue(dueDate);
  await expect(detail.getByLabel('具体时间', { exact: true })).toHaveValue('18:30');
  await expect(detail.getByRole('button', { name: '已安排', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '关闭任务详情' }).click();
  await main.getByRole('button', { name: `完成：${title}`, exact: true }).click();
  await expect(main.getByRole('button', { name: `编辑任务：${title}`, exact: true })).toHaveCount(0);
  await page.locator('.toast').getByRole('button', { name: '撤销', exact: true }).click();
  await expect(main.getByRole('button', { name: `完成：${title}`, exact: true })).toBeVisible();
  await navigate(page, '今日');
  await expect(main.getByRole('button', { name: `完成：${title}`, exact: true })).toBeVisible();
  await page.reload();
  await expect(main.getByRole('button', { name: `完成：${title}`, exact: true })).toBeVisible();
});

test('移出今日保留任务和 DDL；可以重新安排', async ({ page }) => {
  await openConsole(page);
  const title = '完成研究报告';
  await createTask(page, title);
  await page.locator('.main-content').getByRole('button', { name: `编辑任务：${title}`, exact: true }).click();
  const detail = page.locator('.task-detail');
  await detail.getByRole('button', { name: '已安排', exact: true }).click();
  await expect(page.locator('.main-content').getByRole('button', { name: `编辑任务：${title}`, exact: true })).toHaveCount(0);
  await expect(detail.getByLabel('截止日期', { exact: true })).toHaveValue(dueDate);
  await detail.getByRole('button', { name: '关闭任务详情' }).click();
  await navigate(page, '截止日期');
  await page.getByRole('button', { name: `将${title}加入今日`, exact: true }).click();
  await navigate(page, '今日');
  await expect(page.locator('.main-content').getByRole('button', { name: `完成：${title}`, exact: true })).toBeVisible();
});

test('修改任务保存；未保存内容离开前可保留', async ({ page }) => {
  await openConsole(page);
  await page.locator('.main-content').getByRole('button', { name: `编辑任务：${sampleTask}`, exact: true }).click();
  const detail = page.locator('.task-detail');
  const title = '完成课程最终展示';
  await detail.getByLabel('任务名称', { exact: true }).fill(title);
  await navigate(page, '全部任务');
  const confirmation = page.getByRole('dialog', { name: '保留正在编辑的内容？' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: '继续编辑' }).click();
  await expect(detail.getByLabel('任务名称', { exact: true })).toHaveValue(title);
  await detail.getByLabel('备注').fill('更新后的报告要求。');
  await detail.getByRole('button', { name: '保存修改' }).click();
  await expect(page.locator('.toast')).toContainText('任务已保存');
  await expect(detail.getByRole('button', { name: '已保存', exact: true })).toBeDisabled();
  await detail.getByLabel('备注').fill('连续第二次保存的要求。');
  await expect(detail.locator('.inline-warning')).toHaveCount(0);
  await detail.getByRole('button', { name: '保存修改' }).click();
  await expect(detail.getByRole('button', { name: '已保存', exact: true })).toBeDisabled();
  await detail.getByRole('button', { name: '关闭任务详情' }).click();
  await navigate(page, '全部任务');
  await page.locator('.main-content').getByRole('button', { name: `编辑任务：${title}`, exact: true }).click();
  await expect(detail.getByLabel('备注')).toHaveValue('连续第二次保存的要求。');
});

test('小窗完成与控制台同步；撤销恢复今日和 DDL', async ({ page, context }) => {
  await openConsole(page);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 368, height: 610 });
  await panel.goto('/?surface=edge-panel');
  const today = panel.locator('.edge-zone').first();
  const deadlines = panel.locator('.edge-zone').last();
  await today.getByRole('button', { name: `完成：${sampleTask}`, exact: true }).click();
  await expect(today.getByRole('button', { name: `完成：${sampleTask}`, exact: true })).toHaveCount(0);
  await expect(deadlines.getByRole('button', { name: `编辑任务：${sampleTask}`, exact: true })).toHaveCount(0);
  await expect(page.locator('.main-content').getByRole('button', { name: `撤销完成：${sampleTask}`, exact: true })).toBeVisible();
  await panel.locator('.edge-feedback').getByRole('button', { name: '撤销', exact: true }).click();
  await expect(today.getByRole('button', { name: `完成：${sampleTask}`, exact: true })).toBeVisible();
  await expect(deadlines.getByRole('button', { name: `完成：${sampleTask}`, exact: true })).toBeVisible();
  await expect(page.locator('.main-content').getByRole('button', { name: `完成：${sampleTask}`, exact: true })).toBeVisible();
});

test('搜索空状态、备注查询与截止排序', async ({ page }) => {
  await openConsole(page);
  await navigate(page, '全部任务');
  await page.getByRole('textbox', { name: '搜索任务' }).fill('不存在的任务');
  await expect(page.getByRole('heading', { name: '没有找到相关任务' })).toBeVisible();
  await page.getByRole('textbox', { name: '搜索任务' }).fill('交互设计');
  await expect(page.locator('.main-content .task-row')).toHaveCount(1);
  await page.getByRole('button', { name: '清除搜索' }).click();
  await navigate(page, '截止日期');
  await page.getByRole('main').getByLabel('截止任务排序').selectOption('priority');
  await expect(page.getByRole('main').getByLabel('截止任务排序')).toHaveValue('priority');
  await expect(page.locator('.main-content .task-row').first()).toContainText('高优先级');
  await page.reload();
  await navigate(page, '截止日期');
  await expect(page.getByRole('main').getByLabel('截止任务排序')).toHaveValue('priority');
});

test('另一个窗口修改任务时保留当前草稿，并要求显式解决冲突', async ({ page, context }) => {
  await openConsole(page);
  await page.locator('.main-content').getByRole('button', { name: `编辑任务：${sampleTask}`, exact: true }).click();
  const detail = page.locator('.task-detail');
  const draft = '我的未保存草稿';
  await detail.getByLabel('任务名称', { exact: true }).fill(draft);
  const other = await context.newPage();
  await openConsole(other);
  await other.locator('.main-content').getByRole('button', { name: `编辑任务：${sampleTask}`, exact: true }).click();
  await other.locator('.task-detail').getByLabel('备注').fill('另一个窗口的修改');
  await other.locator('.task-detail').getByRole('button', { name: '保存修改' }).click();
  await expect(other.locator('.toast')).toContainText('任务已保存');
  await expect(detail.locator('.inline-warning')).toContainText('你的草稿仍保留');
  await expect(detail.getByLabel('任务名称', { exact: true })).toHaveValue(draft);
  await expect(detail.getByRole('button', { name: '保存修改' })).toBeDisabled();
  await detail.getByRole('button', { name: '保留草稿，基于最新版本保存' }).click();
  await detail.getByRole('button', { name: '保存修改' }).click();
  await expect(page.locator('.toast')).toContainText('任务已保存');
  await expect(other.locator('.main-content').getByRole('button', { name: `编辑任务：${draft}`, exact: true })).toBeVisible();
});

test('设置保存主题、尺寸与停靠方向，重载后保留', async ({ page }) => {
  await openConsole(page);
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  // Default width is 368 px. Saving just a theme must not fail HTML step validation.
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '左侧', exact: true }).click();
  await page.getByLabel('小窗宽度', { exact: true }).fill('420');
  await page.getByLabel('小窗高度', { exact: true }).fill('700');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  await page.reload();
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('小窗宽度', { exact: true })).toHaveValue('420');
  await expect(page.getByLabel('小窗高度', { exact: true })).toHaveValue('700');
  await expect(page.getByRole('button', { name: '左侧', exact: true })).toHaveClass(/segment-active/);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('浏览器小窗预览支持悬停、自动收起与保持展开', async ({ page }) => {
  await seedHoverPreview(page);
  await openConsole(page);
  const preview = page.getByTestId('browser-edge-preview');
  await preview.getByRole('button', { name: '展开侧笺；按住拖动可调整位置' }).hover();
  await expect(preview.getByRole('heading', { name: '今日计划', exact: true })).toBeVisible();
  await page.mouse.move(400, 100);
  await expect(preview.locator('.edge-panel')).toBeHidden();
  await preview.getByRole('button', { name: '展开侧笺；按住拖动可调整位置' }).hover();
  await preview.getByRole('button', { name: '保持展开', exact: true }).click();
  await page.mouse.move(400, 100);
  await expect(preview.getByRole('button', { name: '取消保持展开', exact: true })).toBeVisible();
  await preview.getByRole('button', { name: '收起小窗', exact: true }).click();
  await page.mouse.move(400, 100);
  await expect(preview.locator('.edge-panel')).toBeHidden();
});

test('独立小窗的新建入口原地添加今日任务', async ({ page }) => {
  await page.goto('/?surface=edge-panel');
  await page.getByRole('button', { name: '快速添加今日任务', exact: true }).click();
  await expect(page).toHaveURL(/surface=edge-panel$/);
  const title = page.getByRole('textbox', { name: '今日任务名称', exact: true });
  await expect(title).toBeFocused();
  await title.fill('从边缘开始的任务');
  await page.getByRole('button', { name: '添加到今日', exact: true }).click();
  await expect(title).toHaveValue('');
  await expect(page.getByRole('button', { name: '完成：从边缘开始的任务', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '新建任务', exact: true })).toHaveCount(0);
});

test('浏览器预览可拖动小窗尺寸，松手后设置保存', async ({ page }) => {
  await seedHoverPreview(page);
  await openConsole(page);
  const preview = page.getByTestId('browser-edge-preview');
  await preview.getByRole('button', { name: '展开侧笺；按住拖动可调整位置' }).hover();
  await preview.getByRole('button', { name: '保持展开', exact: true }).click();
  const grip = preview.getByRole('button', { name: '调整小窗宽度和高度', exact: true });
  const bounds = await grip.boundingBox();
  expect(bounds).not.toBeNull();
  const x = bounds!.x + bounds!.width / 2;
  const y = bounds!.y + bounds!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 52, y + 80, { steps: 10 });
  await page.mouse.up();
  await expect(preview).toHaveCSS('width', '420px');
  await expect(preview).toHaveCSS('height', '690px');
  await preview.getByRole('button', { name: '收起小窗', exact: true }).click();
  await page.mouse.move(400, 100);
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByLabel('小窗宽度', { exact: true })).toHaveValue('420');
  await expect(page.getByLabel('小窗高度', { exact: true })).toHaveValue('690');
});

test('桌面控制台与最小、最大小窗布局无水平溢出', async ({ page }, testInfo) => {
  await openConsole(page);
  await expect(page.locator('.console-shell')).toBeVisible();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('console-light.png'), fullPage: true });
  await page.locator('.main-content').getByRole('button', { name: `编辑任务：${sampleTask}`, exact: true }).click();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('console-detail.png'), fullPage: true });
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('console-create.png'), fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '关闭任务详情' }).click();
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('settings-dark-appearance.png'), fullPage: true });
  await page.locator('.settings-content').evaluate(element => { element.scrollTop = 0; });
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('settings-dark.png'), fullPage: true });
  await navigate(page, '今日');
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('console-dark.png'), fullPage: true });
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  for (const size of [{ width: 300, height: 380 }, { width: 368, height: 610 }, { width: 640, height: 1000 }]) {
    await page.setViewportSize(size);
    await page.goto('/?surface=edge-panel');
    await expect(page.getByRole('heading', { name: '今日计划', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '截止日期', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '管理任务', exact: true })).toBeInViewport();
    const dimensions = await page.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, height: window.innerHeight, scrollHeight: document.documentElement.scrollHeight }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
    expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`edge-${size.width}x${size.height}.png`) });
  }
});
