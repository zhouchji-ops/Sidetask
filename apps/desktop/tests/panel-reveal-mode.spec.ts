import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot } from '../src/lib/types';

// Browser-only behavior and committed preference synchronization. These tests
// do not certify native mouse monitoring, focus, or monitor/window geometry.
const storageKey = 'sidetask-browser-preview-v1';
const fixedTime = new Date('2026-09-25T04:00:00.000Z');
const preview = (page: Page) => page.getByTestId('browser-edge-preview');
const panel = (page: Page) => preview(page).locator('.edge-panel');
const handle = (page: Page) => preview(page).getByRole('button', { name: '展开侧笺；按住拖动可调整位置', exact: true });
const modeGroup = (page: Page) => page.getByRole('radiogroup', { name: '小窗展开方式', exact: true });
const clickMode = (page: Page) => modeGroup(page).getByRole('radio', { name: '单击展开', exact: true });
const hoverMode = (page: Page) => modeGroup(page).getByRole('radio', { name: '悬停展开', exact: true });
const revealDelay = (page: Page) => page.getByLabel('展开延迟', { exact: true });
const hideDelay = (page: Page) => page.getByLabel('收起延迟', { exact: true });
const saveSettings = (page: Page) => page.getByRole('button', { name: '保存设置', exact: true });

function fixture(): Snapshot {
  const snapshot = createSeed('2026-09-25');
  snapshot.revision = 21;
  snapshot.tasks[0].notes = '合成内容：修改展开偏好不能更改任务或计划。';
  snapshot.settings.pinned = false;
  snapshot.settings.revealDelay = 400;
  snapshot.settings.hideDelay = 800;
  return snapshot;
}

async function seed(context: BrowserContext, snapshot = fixture()) {
  await context.addInitScript(({ key, snapshot }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(snapshot));
    localStorage.setItem('sidetask-usage-guide-seen-v1', '1');
  }, { key: storageKey, snapshot });
  return snapshot;
}

async function open(page: Page, settings = false) {
  await page.clock.install({ time: fixedTime });
  await page.clock.pauseAt(fixedTime);
  await page.goto(`/?surface=console${settings ? '&page=settings' : ''}`);
  await expect(page.locator('.console-shell')).toBeVisible();
  await expect(handle(page)).toBeVisible();
  if (settings) await expect(modeGroup(page)).toBeVisible();
}

async function persisted(page: Page): Promise<Snapshot> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
}

test('默认单击模式悬停不展开，展开后离开与内部点击不收起，外部点击继续原操作', async ({ page, context }) => {
  const initial = await seed(context);
  expect(initial.settings.revealMode).toBe('click');
  await open(page);
  await handle(page).hover();
  await page.clock.runFor(2_000);
  await expect(panel(page)).toBeHidden();
  await handle(page).click();
  await expect(panel(page)).toBeVisible();
  await page.mouse.move(400, 100);
  await page.clock.runFor(2_000);
  await expect(panel(page)).toBeVisible();
  await preview(page).getByRole('heading', { name: '今日计划', exact: true }).click();
  await expect(panel(page)).toBeVisible();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^全部任务/ }).click();
  await expect(panel(page)).toBeHidden();
  await expect(page.locator('.page-heading h1')).toHaveText('全部任务');
  expect(await persisted(page)).toEqual(initial);
});

test('旧快照缺少展开方式时使用单击，不在读取或重载时改写任务与偏好', async ({ page, context }) => {
  const legacy = fixture();
  delete (legacy.settings as Partial<Snapshot['settings']>).revealMode;
  await seed(context, legacy);
  await open(page, true);
  await expect(clickMode(page)).toBeChecked();
  await expect(revealDelay(page)).toBeHidden();
  await expect(hideDelay(page)).toBeHidden();
  await handle(page).hover();
  await page.clock.runFor(2_000);
  await expect(panel(page)).toBeHidden();
  expect(await persisted(page)).toEqual(legacy);
  await page.reload();
  await expect(clickMode(page)).toBeChecked();
  await handle(page).click();
  await expect(panel(page)).toBeVisible();
  await page.getByRole('heading', { name: '设置', exact: true }).click();
  await expect(panel(page)).toBeHidden();
  expect(await persisted(page)).toEqual(legacy);
});

test('展开方式和延迟按保存同步两窗口，切回单击保留悬停延迟并在重载后恢复', async ({ page, context }) => {
  const initial = await seed(context);
  await open(page, true);
  const other = await context.newPage();
  await open(other, true);
  await expect(clickMode(page)).toBeChecked();
  await expect(clickMode(other)).toBeChecked();
  await expect(revealDelay(page)).toBeHidden();
  await hoverMode(page).check();
  await expect(revealDelay(page)).toHaveValue('400');
  await expect(hideDelay(page)).toHaveValue('800');
  await revealDelay(page).fill('320');
  await hideDelay(page).fill('760');
  await expect(clickMode(other)).toBeChecked();
  expect(await persisted(page)).toEqual(initial);
  await saveSettings(page).click();
  await expect(saveSettings(page)).toBeDisabled();
  await expect(hoverMode(other)).toBeChecked();
  await expect(revealDelay(other)).toHaveValue('320');
  await expect(hideDelay(other)).toHaveValue('760');
  const hovered = await persisted(page);
  expect(hovered).toEqual({ ...initial, revision: initial.revision + 1, settings: { ...initial.settings, revealMode: 'hover', revealDelay: 320, hideDelay: 760 } });

  await clickMode(other).check();
  await expect(revealDelay(other)).toBeHidden();
  await expect(hideDelay(other)).toBeHidden();
  await expect(hoverMode(page)).toBeChecked();
  await saveSettings(other).click();
  await expect(saveSettings(other)).toBeDisabled();
  await expect(clickMode(page)).toBeChecked();
  await expect(revealDelay(page)).toBeHidden();
  await page.reload();
  await other.reload();
  await expect(clickMode(page)).toBeChecked();
  await expect(clickMode(other)).toBeChecked();
  const clicked = await persisted(page);
  expect(clicked).toEqual({ ...hovered, revision: hovered.revision + 1, settings: { ...hovered.settings, revealMode: 'click' } });
  await hoverMode(page).check();
  await expect(revealDelay(page)).toHaveValue('320');
  await expect(hideDelay(page)).toHaveValue('760');
});

test('单击模式外点隐藏保留小窗草稿，原点击获得焦点，重新展开可继续输入保存', async ({ page, context }) => {
  const initial = await seed(context);
  await open(page);
  await handle(page).click();
  await preview(page).getByRole('button', { name: '添加今日任务', exact: true }).click();
  const input = preview(page).getByRole('textbox', { name: '今日任务名称', exact: true });
  await input.fill('合成外点保留');
  const search = page.getByRole('textbox', { name: '搜索任务', exact: true });
  await search.click();
  await expect(panel(page)).toBeHidden();
  await expect(search).toBeFocused();
  await search.fill('搜索仍可输入');
  expect(await persisted(page)).toEqual(initial);
  await handle(page).click();
  await expect(input).toHaveValue('合成外点保留');
  await input.click();
  await expect(input).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.insertText('并继续');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('');
  await page.clock.runFor(20);
  await expect(input).toBeFocused();
  const saved = await persisted(page);
  const created = saved.tasks.filter(task => task.title === '合成外点保留并继续');
  expect(created).toHaveLength(1);
  expect(saved.plans.filter(plan => plan.taskId === created[0].id && plan.date === '2026-09-25')).toHaveLength(1);
  expect(saved.revision).toBe(initial.revision + 1);
});

test('单击模式保持展开后外点仍执行原操作且不收起，显式关闭仍有效', async ({ page, context }) => {
  const initial = await seed(context);
  await open(page);
  await handle(page).click();
  await preview(page).getByRole('button', { name: '保持展开', exact: true }).click();
  await expect(preview(page).getByRole('button', { name: '取消保持展开', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^全部任务/ }).click();
  await expect(page.locator('.page-heading h1')).toHaveText('全部任务');
  await expect(panel(page)).toBeVisible();
  await page.clock.runFor(2_000);
  await expect(panel(page)).toBeVisible();
  await preview(page).getByRole('button', { name: '收起小窗', exact: true }).click();
  await expect(panel(page)).toBeHidden();
  const saved = await persisted(page);
  expect(saved.tasks).toEqual(initial.tasks);
  expect(saved.plans).toEqual(initial.plans);
  expect(saved.settings.pinned).toBe(false);
});

test('悬停模式按配置延迟展开收起，快速返回与提前离开取消旧计时', async ({ page, context }) => {
  const initial = fixture(); initial.settings.revealMode = 'hover';
  await seed(context, initial);
  await open(page);
  await handle(page).hover();
  await page.clock.runFor(399);
  await expect(panel(page)).toBeHidden();
  await page.clock.runFor(1);
  await expect(panel(page)).toBeVisible();
  await page.mouse.move(400, 100);
  await page.clock.runFor(799);
  await expect(panel(page)).toBeVisible();
  await preview(page).getByRole('heading', { name: '今日计划', exact: true }).hover();
  await page.clock.runFor(1_000);
  await expect(panel(page)).toBeVisible();
  await page.mouse.move(400, 100);
  await page.clock.runFor(800);
  await expect(panel(page)).toBeHidden();
  await handle(page).hover();
  await page.clock.runFor(200);
  await page.mouse.move(400, 100);
  await page.clock.runFor(1_000);
  await expect(panel(page)).toBeHidden();
  expect(await persisted(page)).toEqual(initial);
});

test('指针留在外侧时跨窗口解除固定或修改延迟，重新按已保存延迟收起', async ({ page, context }) => {
  const initial = fixture(); initial.settings.revealMode = 'hover';
  await seed(context, initial);
  await open(page, true);
  const other = await context.newPage();
  await open(other, true);
  await handle(page).hover();
  await page.clock.runFor(initial.settings.revealDelay);
  await preview(page).getByRole('button', { name: '保持展开', exact: true }).click();
  const otherPinned = other.getByRole('switch', { name: '保持小窗展开', exact: true });
  await expect(otherPinned).toBeChecked();
  await page.mouse.move(400, 100);
  await page.clock.runFor(2_000);
  await expect(panel(page)).toBeVisible();

  // The first window receives committed preferences without another pointer
  // boundary. Keyboard controls also work if the pinned preview overlaps settings.
  await otherPinned.focus();
  await other.keyboard.press('Space');
  await hideDelay(other).fill('600');
  await saveSettings(other).focus();
  await other.keyboard.press('Enter');
  await expect(preview(page).getByRole('button', { name: '保持展开', exact: true })).toBeVisible();
  await expect(hideDelay(page)).toHaveValue('600');
  await page.clock.runFor(599);
  await expect(panel(page)).toBeVisible();
  await page.clock.runFor(1);
  await expect(panel(page)).toBeHidden();

  await handle(page).hover();
  await page.clock.runFor(initial.settings.revealDelay);
  await expect(panel(page)).toBeVisible();
  await page.mouse.move(400, 100);
  await page.clock.runFor(100);
  await hideDelay(other).fill('1200');
  await saveSettings(other).focus();
  await other.keyboard.press('Enter');
  await expect(hideDelay(page)).toHaveValue('1200');
  await page.clock.runFor(1_199);
  await expect(panel(page)).toBeVisible();
  await page.clock.runFor(1);
  await expect(panel(page)).toBeHidden();
  const saved = await persisted(page);
  expect(saved.tasks).toEqual(initial.tasks);
  expect(saved.plans).toEqual(initial.plans);
  expect(saved.revision).toBe(initial.revision + 3);
});

test('悬停小窗显式关闭后指针原地不重新展开，离开再进入才恢复', async ({ page, context }) => {
  const initial = fixture(); initial.settings.revealMode = 'hover';
  await seed(context, initial);
  await open(page);
  await handle(page).hover();
  await page.clock.runFor(initial.settings.revealDelay);
  await expect(panel(page)).toBeVisible();
  const bounds = (await preview(page).boundingBox())!;
  // Keep the mouse inside the future collapsed handle while invoking the
  // visible Close control by keyboard. Closing must not require moving the mouse.
  await page.mouse.move(bounds.x + bounds.width - 10, bounds.y + 50);
  await preview(page).getByRole('button', { name: '收起小窗', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeHidden();
  await page.clock.runFor(2_000);
  await expect(panel(page)).toBeHidden();
  await page.mouse.move(400, 100);
  await handle(page).hover();
  await page.clock.runFor(initial.settings.revealDelay - 1);
  await expect(panel(page)).toBeHidden();
  await page.clock.runFor(1);
  await expect(panel(page)).toBeVisible();
  expect(await persisted(page)).toEqual(initial);
});

test('另一窗口切回单击时取消尚未完成的悬停展开计时', async ({ page, context }) => {
  const initial = fixture(); initial.settings.revealMode = 'hover';
  await seed(context, initial);
  await open(page, true);
  const other = await context.newPage();
  await open(other, true);
  await handle(page).hover();
  await page.clock.runFor(200);
  await expect(panel(page)).toBeHidden();
  await clickMode(other).check();
  await saveSettings(other).click();
  await expect(clickMode(page)).toBeChecked();
  await page.clock.runFor(1_000);
  await expect(panel(page)).toBeHidden();
  await handle(page).click();
  await expect(panel(page)).toBeVisible();
  await page.mouse.move(400, 100);
  await page.clock.runFor(1_000);
  await expect(panel(page)).toBeVisible();
});

for (const mode of ['click', 'hover'] as const) {
  test(`${mode} 模式拖动把手不会误展开，松手后才保存停靠边`, async ({ page, context }) => {
    const initial = fixture(); initial.settings.revealMode = mode;
    await seed(context, initial);
    await open(page);
    const bounds = (await handle(page).boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 24);
    await page.mouse.down();
    await page.mouse.move(bounds.x - 40, bounds.y + 30);
    await page.mouse.move(40, 260, { steps: 4 });
    await page.clock.runFor(1_000);
    await expect(panel(page)).toBeHidden();
    expect(await persisted(page)).toEqual(initial);
    await page.mouse.up();
    await expect.poll(async () => (await persisted(page)).settings.edge).toBe('left');
    await expect(panel(page)).toBeHidden();
    const saved = await persisted(page);
    expect(saved).toEqual({ ...initial, revision: initial.revision + 1, settings: { ...initial.settings, edge: 'left' } });
  });
}
