import { expect, test } from '@playwright/test';

// Ported Windows branch coverage uses the same persistent preview and mode
// controls as the shared UI. Hiding a panel preserves its mounted draft.
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-25T04:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-25T04:00:00Z'));
  await page.addInitScript(() => localStorage.setItem('sidetask-usage-guide-seen-v1', '1'));
});

test('默认单击展开，经过与移开不触发，点击外部才收起，固定展开例外', async ({ page }) => {
  await page.goto('/?surface=console');
  const preview = page.getByTestId('browser-edge-preview');
  const handle = preview.getByRole('button', { name: '展开侧笺；按住拖动可调整位置' });
  await handle.hover();
  await page.clock.runFor(700);
  await expect(preview.locator('.edge-panel')).toBeHidden();
  await handle.click();
  await expect(preview.locator('.edge-panel')).toBeVisible();
  await page.mouse.move(500, 100);
  await page.clock.runFor(700);
  await expect(preview.locator('.edge-panel')).toBeVisible();
  await page.mouse.click(500, 100);
  await expect(preview.locator('.edge-panel')).toBeHidden();
  await handle.click();
  await preview.getByRole('button', { name: '保持展开', exact: true }).click();
  await page.mouse.click(500, 100);
  await expect(preview.locator('.edge-panel')).toBeVisible();
});

test('单击隐藏延迟输入，悬停保存重载后保留延迟，切回单击停止自动展开', async ({ page }) => {
  await page.goto('/?surface=console');
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  const mode = page.getByRole('radiogroup', { name: '小窗展开方式', exact: true });
  await expect(mode.getByRole('radio', { name: '单击展开', exact: true })).toBeChecked();
  await expect(page.getByLabel('展开延迟', { exact: true })).toBeHidden();
  await expect(page.getByLabel('收起延迟', { exact: true })).toBeHidden();
  await mode.getByRole('radio', { name: '悬停展开', exact: true }).check();
  await page.getByLabel('展开延迟', { exact: true }).fill('300');
  await page.getByLabel('收起延迟', { exact: true }).fill('600');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  await page.reload();
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await expect(mode.getByRole('radio', { name: '悬停展开', exact: true })).toBeChecked();
  await expect(page.getByLabel('展开延迟', { exact: true })).toHaveValue('300');
  await expect(page.getByLabel('收起延迟', { exact: true })).toHaveValue('600');
  const preview = page.getByTestId('browser-edge-preview');
  await preview.locator('.edge-handle').hover();
  await page.clock.runFor(300);
  await expect(preview.locator('.edge-panel')).toBeVisible();
  await page.mouse.move(500, 100);
  await page.clock.runFor(600);
  await expect(preview.locator('.edge-panel')).toBeHidden();
  await mode.getByRole('radio', { name: '单击展开', exact: true }).check();
  await expect(page.getByLabel('展开延迟', { exact: true })).toBeHidden();
  await expect(page.getByLabel('收起延迟', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  await preview.locator('.edge-handle').hover();
  await page.clock.runFor(700);
  await expect(preview.locator('.edge-panel')).toBeHidden();
});

test('单击外点和显式收起小窗都保留草稿，重新展开可继续添加', async ({ page }) => {
  await page.goto('/?surface=console');
  const preview = page.getByTestId('browser-edge-preview');
  await preview.locator('.edge-handle').click();
  await preview.getByRole('button', { name: '添加今日任务', exact: true }).click();
  const input = preview.getByRole('textbox', { name: '今日任务名称' });
  await input.fill('点击外部保留草稿');
  await page.mouse.click(500, 100);
  await expect(preview.locator('.edge-panel')).toBeHidden();
  await preview.locator('.edge-handle').click();
  await expect(input).toHaveValue('点击外部保留草稿');
  await preview.getByRole('button', { name: '收起小窗', exact: true }).click();
  await expect(preview.locator('.edge-panel')).toBeHidden();
  await preview.locator('.edge-handle').click();
  await expect(input).toHaveValue('点击外部保留草稿');
  await expect(preview.getByRole('group', { name: '处理今日任务草稿', exact: true })).toHaveCount(0);
  await preview.getByRole('button', { name: '添加到今日', exact: true }).click();
  await expect(input).toHaveValue('');
  await preview.getByRole('button', { name: '收起添加任务', exact: true }).click();
  await page.mouse.click(500, 100);
  await expect(preview.locator('.edge-panel')).toBeHidden();
  await preview.locator('.edge-handle').click();
  await expect(preview.getByRole('button', { name: '完成：点击外部保留草稿', exact: true })).toBeVisible();
});
