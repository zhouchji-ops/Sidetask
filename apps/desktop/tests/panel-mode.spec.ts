import { expect, test } from '@playwright/test';

test('默认单击展开，经过与移开不触发，点击外部才收起，固定展开例外', async ({ page }) => {
  await page.goto('/?surface=console');
  const preview = page.getByTestId('browser-edge-preview');
  const handle = preview.getByRole('button', { name: '展开侧笺；按住拖动可调整位置' });
  await handle.hover();
  await page.waitForTimeout(700);
  await expect(preview.locator('.edge-panel')).toHaveCount(0);
  await handle.click();
  await expect(preview.locator('.edge-panel')).toBeVisible();
  await page.mouse.move(500, 100);
  await page.waitForTimeout(700);
  await expect(preview.locator('.edge-panel')).toBeVisible();
  await page.mouse.click(500, 100);
  await expect(preview.locator('.edge-panel')).toHaveCount(0);
  await handle.click();
  await preview.getByRole('button', { name: '保持展开', exact: true }).click();
  await page.mouse.click(500, 100);
  await expect(preview.locator('.edge-panel')).toBeVisible();
});

test('展开方式替代时间输入，保存悬停模式并重启后保持，切回单击立即停止自动展开', async ({ page }) => {
  await page.goto('/?surface=console');
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '单击展开', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#reveal-delay, #hide-delay')).toHaveCount(0);
  await page.getByRole('button', { name: '悬停展开', exact: true }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  await page.reload();
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '悬停展开', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const preview = page.getByTestId('browser-edge-preview');
  await preview.locator('.edge-handle').hover();
  await expect(preview.locator('.edge-panel')).toBeVisible();
  await page.mouse.move(500, 100);
  await expect(preview.locator('.edge-panel')).toHaveCount(0);
  await page.getByRole('button', { name: '单击展开', exact: true }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  await preview.locator('.edge-handle').hover();
  await page.waitForTimeout(700);
  await expect(preview.locator('.edge-panel')).toHaveCount(0);
});

test('单击模式下小窗输入草稿不被外部点击关闭，收起编辑后可正常点击外部关闭', async ({ page }) => {
  await page.goto('/?surface=console');
  const preview = page.getByTestId('browser-edge-preview');
  await preview.locator('.edge-handle').click();
  await preview.getByRole('button', { name: '添加今日任务', exact: true }).click();
  const input = preview.getByRole('textbox', { name: '今日任务名称' });
  await input.fill('点击外部保留草稿');
  await page.mouse.click(500, 100);
  await expect(input).toHaveValue('点击外部保留草稿');
  await preview.getByRole('button', { name: '添加', exact: true }).click();
  await preview.getByRole('button', { name: '收起添加今日任务', exact: true }).click();
  await page.mouse.click(500, 100);
  await expect(preview.locator('.edge-panel')).toHaveCount(0);
  await preview.locator('.edge-handle').click();
  await expect(preview.getByRole('button', { name: '完成：点击外部保留草稿', exact: true })).toBeVisible();
});
