import { expect, test } from '@playwright/test';
import { createSeed } from '../src/lib/domain';

// Isolated browser storage exercises the shared console/draft UI contract.
// It is not evidence of native window or SQLite behavior.
test('恢复提示使用当前草稿门禁，继续编辑后仍可保存并查看恢复任务', async ({ page }) => {
  const initial = createSeed('2026-09-25');
  const [restoredTask, editedTask] = initial.tasks.filter(task => !task.completed);
  const draftTitle = '恢复提示打开前，另一任务尚未保存的修改';
  await page.clock.setFixedTime(new Date('2026-09-25T04:00:00Z'));
  await page.addInitScript(snapshot => {
    if (!localStorage.getItem('sidetask-browser-preview-v1')) {
      localStorage.setItem('sidetask-browser-preview-v1', JSON.stringify(snapshot));
    }
  }, initial);
  await page.goto('/?surface=console&page=all');
  await page.getByRole('button', { name: `编辑任务：${restoredTask.title}`, exact: true }).click();
  await page.locator('.task-detail').getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.locator('.toast').getByRole('button', { name: '恢复', exact: true }).click();
  const viewRestored = page.locator('.toast').getByRole('button', { name: '查看任务', exact: true });
  await expect(viewRestored).toBeVisible();

  await page.getByRole('button', { name: `编辑任务：${editedTask.title}`, exact: true }).click();
  const detailTitle = page.locator('.task-detail').getByLabel('任务名称', { exact: true });
  await detailTitle.fill(draftTitle);
  await viewRestored.click();
  const guard = page.getByRole('dialog', { name: '保留正在编辑的内容？' });
  await expect(guard).toBeVisible();
  await expect(detailTitle).toHaveValue(draftTitle);
  await expect(page.locator('.toast')).not.toContainText('已重新加入今日');
  await guard.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(guard).toBeHidden();
  await expect(detailTitle).toHaveValue(draftTitle);
  await expect(viewRestored).toBeVisible();

  await viewRestored.click();
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '保存并离开', exact: true }).click();
  await expect(guard).toBeHidden();
  await expect(detailTitle).toHaveValue(restoredTask.title);
  const committed = await page.evaluate(() => JSON.parse(localStorage.getItem('sidetask-browser-preview-v1')!));
  expect(committed.tasks.find((task: { id: string }) => task.id === editedTask.id)).toMatchObject({
    id: editedTask.id, title: draftTitle, notes: editedTask.notes,
    completed: editedTask.completed, revision: editedTask.revision + 1,
  });
  expect(committed.tasks.find((task: { id: string }) => task.id === restoredTask.id).deletedAt).toBeFalsy();
  expect(committed.plans).toEqual(initial.plans);

  await page.reload();
  await page.getByRole('button', { name: /^全部任务/ }).click();
  await page.getByRole('button', { name: `编辑任务：${draftTitle}`, exact: true }).click();
  await expect(detailTitle).toHaveValue(draftTitle);
});

test('另一窗口再次删除后，回收站行内恢复保留同任务详情草稿', async ({ page, context }) => {
  const initial = createSeed('2026-09-25');
  const task = initial.tasks.find(item => !item.completed)!;
  const draftTitle = '跨窗口删除后仍须保留的恢复草稿';
  await page.clock.setFixedTime(new Date('2026-09-25T04:00:00Z'));
  await page.addInitScript(snapshot => {
    if (!localStorage.getItem('sidetask-browser-preview-v1')) {
      localStorage.setItem('sidetask-browser-preview-v1', JSON.stringify(snapshot));
    }
  }, initial);
  await page.goto('/?surface=console&page=all');
  await page.getByRole('button', { name: `编辑任务：${task.title}`, exact: true }).click();
  await page.locator('.task-detail').getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('button', { name: /^回收站/ }).click();
  await page.getByRole('button', { name: `查看已删除任务：${task.title}`, exact: true }).click();
  await page.getByRole('button', { name: '恢复此任务', exact: true }).click();
  const detail = page.locator('.task-detail');
  const title = detail.getByLabel('任务名称', { exact: true });
  await expect(title).toBeEditable();
  await title.fill(draftTitle);

  const otherWindow = await context.newPage();
  await otherWindow.clock.setFixedTime(new Date('2026-09-25T04:00:00Z'));
  await otherWindow.goto('/?surface=console&page=all');
  await otherWindow.getByRole('button', { name: `编辑任务：${task.title}`, exact: true }).click();
  await otherWindow.getByRole('button', { name: '移入回收站', exact: true }).click();
  await expect(detail).toContainText('草稿仍保留');
  await expect(title).toHaveValue(draftTitle);
  await expect(title).not.toBeEditable();

  await page.getByRole('button', { name: `恢复任务：${task.title}`, exact: true }).click();
  await expect(detail).toBeVisible();
  await expect(title).toHaveValue(draftTitle);
  await expect(title).toBeEditable();
  // Restoring the record does not silently rebase or save the old draft.
  await expect(detail.getByRole('button', { name: '保存修改', exact: true })).toBeDisabled();
  await detail.getByRole('button', { name: '保留草稿，基于最新版本保存', exact: true }).click();
  await detail.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(detail.getByRole('button', { name: '已保存', exact: true })).toBeVisible();
  const committed = await page.evaluate(() => JSON.parse(localStorage.getItem('sidetask-browser-preview-v1')!));
  expect(committed.tasks.find((item: { id: string }) => item.id === task.id)).toMatchObject({
    id: task.id, title: draftTitle, notes: task.notes, completed: task.completed,
  });
  expect(committed.tasks.find((item: { id: string }) => item.id === task.id).deletedAt).toBeFalsy();
  expect(committed.plans).toEqual(initial.plans);
});
