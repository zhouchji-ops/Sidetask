import { expect, test, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot } from '../src/lib/types';

const storageKey = 'sidetask-browser-preview-v1';
type ReviewWindow = Window & { releaseLifecycleWrite?: () => void; failLifecycleWrite?: boolean };

// Real isolated preview writes, held by the same Web Lock used by the store.
// The hold controls the async boundary; elapsed time is not a pass condition.
async function holdWrites(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>(ready => {
      void navigator.locks.request('sidetask-preview-write', () => new Promise<void>(release => {
        (window as ReviewWindow).releaseLifecycleWrite = release;
        ready();
      }));
    });
  });
}
async function releaseWrites(page: Page) {
  await page.evaluate(() => (window as ReviewWindow).releaseLifecycleWrite?.());
}
async function setup(page: Page, initial: Snapshot, target = 'all') {
  await page.clock.setFixedTime(new Date('2026-09-25T04:00:00.000Z'));
  await page.addInitScript(({ key, snapshot }) => localStorage.setItem(key, JSON.stringify(snapshot)), { key: storageKey, snapshot: initial });
  await page.goto(`/?surface=console&page=${target}`);
  await expect(page.locator('.console-shell')).toBeVisible();
}
async function persisted(page: Page): Promise<Snapshot> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
}

test('保存并离开等待写入时禁用继续和关闭，Escape不会取消后再意外跳页', async ({ page }) => {
  const initial = createSeed('2026-09-25');
  const task = initial.tasks[0];
  await setup(page, initial);
  await page.getByRole('button', { name: `编辑任务：${task.title}`, exact: true }).click();
  await page.locator('.task-detail').getByLabel('任务名称', { exact: true }).fill('等待写入完成的任务标题');
  await page.getByRole('button', { name: /^回收站/ }).click();
  const guard = page.getByRole('dialog', { name: '保留正在编辑的内容？' });
  await holdWrites(page);
  try {
    await guard.getByRole('button', { name: '保存并离开', exact: true }).click();
    await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeDisabled();
    await expect(guard.getByRole('button', { name: '继续编辑', exact: true })).toBeDisabled();
    await expect(guard.getByRole('button', { name: '关闭对话框', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(guard).toBeVisible();
    await expect(page.locator('.page-heading h1')).toHaveText('全部任务');
    expect(await persisted(page)).toEqual(initial);
  } finally {
    await releaseWrites(page);
  }
  await expect(guard).toBeHidden();
  await expect(page.locator('.page-heading h1')).toHaveText('回收站');
  const expected = structuredClone(initial);
  expected.revision += 1;
  expected.tasks[0].revision += 1;
  expected.tasks[0].title = '等待写入完成的任务标题';
  expect(await persisted(page)).toEqual(expected);
});

test('键盘恢复写入失败归还原按钮以便重试，用户主动移开的焦点不被抢回', async ({ page }) => {
  const initial = createSeed('2026-09-25');
  initial.revision = 10;
  initial.tasks = initial.tasks.slice(0, 2).map(task => ({ ...task, deletedAt: '2026-09-24T04:00:00.000Z', revision: 2 }));
  initial.plans = initial.plans.filter(plan => initial.tasks.some(task => task.id === plan.taskId));
  const [first, second] = initial.tasks;
  await setup(page, initial, 'trash');
  await page.evaluate(key => {
    (window as ReviewWindow).failLifecycleWrite = true;
    const write = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key && (window as ReviewWindow).failLifecycleWrite) throw new Error('合成恢复写入失败');
      return write.call(this, name, value);
    };
  }, storageKey);
  const firstRestore = page.getByRole('button', { name: `恢复任务：${first.title}`, exact: true });
  await firstRestore.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.error-banner')).toContainText('合成恢复写入失败');
  await expect(firstRestore).toBeEnabled();
  await expect(firstRestore).toBeFocused();
  expect(await persisted(page)).toEqual(initial);

  // Enter retries the same record without searching for a lost focus position.
  await page.evaluate(() => { (window as ReviewWindow).failLifecycleWrite = false; });
  await page.keyboard.press('Enter');
  await expect(firstRestore).toHaveCount(0);
  await expect(page.locator('.trash-task-row')).toHaveCount(1);
  const expected = structuredClone(initial);
  expected.revision += 1;
  expected.tasks[0].revision += 1;
  expected.tasks[0].deletedAt = null;
  expect(await persisted(page)).toEqual(expected);

  await page.evaluate(() => { (window as ReviewWindow).failLifecycleWrite = true; });
  await holdWrites(page);
  const secondRestore = page.getByRole('button', { name: `恢复任务：${second.title}`, exact: true });
  const search = page.getByRole('textbox', { name: '搜索回收站', exact: true });
  try {
    await secondRestore.focus();
    await page.keyboard.press('Enter');
    await expect(secondRestore).toBeDisabled();
    await search.focus();
    await expect(search).toBeFocused();
  } finally {
    await releaseWrites(page);
  }
  await expect(page.locator('.error-banner')).toContainText('合成恢复写入失败');
  await expect(secondRestore).toBeEnabled();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(search).toBeFocused();
  expect(await persisted(page)).toEqual(expected);
});
