import { expect, test, type Page } from '@playwright/test';

// Browser focus and synthetic keyboard regressions only. These do not claim
// native macOS input-source, candidate-window or WebView IME acceptance.
const createDialog = (page: Page) => page.getByRole('dialog', { name: '新建任务', exact: true });

async function openDraftGuard(page: Page) {
  await page.goto('/?surface=console');
  await page.getByRole('button', { name: '编辑任务：完成交互设计课程作业', exact: true }).click();
  await page.locator('.task-detail').getByLabel('备注').fill('快捷键不能打断这份草稿');
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^全部任务/ }).click();
  const guard = page.getByRole('dialog', { name: '保留正在编辑的内容？' });
  await expect(guard).toBeVisible();
  return guard;
}

test('关闭新建任务后，键盘焦点回到打开它的入口', async ({ page }) => {
  await page.goto('/?surface=console');
  const opener = page.getByRole('button', { name: '新建任务', exact: true });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(createDialog(page).getByLabel('任务名称', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(createDialog(page)).toBeHidden();
  await expect(opener).toBeFocused();

  await page.keyboard.press('Enter');
  await createDialog(page).getByLabel('任务名称', { exact: true }).fill('放弃后仍可从入口继续');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: '保留新任务草稿？' }).getByRole('button', { name: '放弃新任务' }).click();
  await expect(createDialog(page)).toBeHidden();
  await expect(opener).toBeFocused();
});

test('草稿确认期间斜线不把键盘焦点移到背后搜索框', async ({ page }) => {
  const guard = await openDraftGuard(page);
  const close = guard.getByRole('button', { name: '关闭对话框' });
  await expect(close).toBeFocused();
  await page.keyboard.press('/');
  await expect(close).toBeFocused();
  await expect(page.getByRole('textbox', { name: '搜索任务', exact: true })).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(guard).toBeHidden();
  await expect(page.locator('.task-detail').getByLabel('备注')).toHaveValue('快捷键不能打断这份草稿');
});

test('草稿确认期间新建快捷键不叠加另一个编辑器', async ({ page }) => {
  const guard = await openDraftGuard(page);
  for (const modifier of ['Meta', 'Control']) {
    await page.keyboard.press(`${modifier}+n`);
    await expect(createDialog(page)).toHaveCount(0);
    await expect(guard.getByRole('button', { name: '关闭对话框' })).toBeFocused();
  }
  await page.keyboard.press('Escape');
  await expect(guard).toBeHidden();
  // The same shortcut must still work once the confirmation has closed.
  await page.keyboard.press('Meta+n');
  await expect(createDialog(page)).toBeVisible();
});

test('组合输入的 Escape 不关闭弹层，确认输入之后的普通 Escape 仍保护草稿', async ({ page }) => {
  await page.goto('/?surface=console');
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const title = createDialog(page).getByLabel('任务名称', { exact: true });
  await title.fill('输入法候选仍在编辑');
  for (const composition of [{ isComposing: true, keyCode: 27 }, { isComposing: false, keyCode: 229 }]) {
    await title.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', ...composition });
    await expect(page.getByRole('dialog', { name: '保留新任务草稿？' })).toHaveCount(0);
    await expect(title).toBeFocused();
    await expect(title).toHaveValue('输入法候选仍在编辑');
  }
  await page.keyboard.press('Escape');
  const guard = page.getByRole('dialog', { name: '保留新任务草稿？' });
  await expect(guard).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(guard).toBeHidden();
  await expect(title).toBeFocused();
  await expect(title).toHaveValue('输入法候选仍在编辑');
});

test('输入法处理过的按键不触发新建，普通 Enter 仍可提交新任务', async ({ page }) => {
  await page.goto('/?surface=console');
  const search = page.getByRole('textbox', { name: '搜索任务', exact: true });
  await search.focus();
  for (const composition of [{ isComposing: true, keyCode: 78 }, { isComposing: false, keyCode: 229 }]) {
    await search.dispatchEvent('keydown', { key: 'n', code: 'KeyN', metaKey: true, ...composition });
    await expect(createDialog(page)).toHaveCount(0);
    await expect(search).toBeFocused();
  }
  await page.keyboard.press('Meta+n');
  await createDialog(page).getByLabel('任务名称', { exact: true }).fill('确认文字后再创建');
  await page.keyboard.press('Enter');
  await expect(createDialog(page)).toBeHidden();
  await expect(page.getByRole('button', { name: '编辑任务：确认文字后再创建', exact: true })).toBeVisible();
  await expect(search).toBeFocused();
});
