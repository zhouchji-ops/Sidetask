import { expect, test, type Locator, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot } from '../src/lib/types';

// Browser-only regression coverage. Native window geometry and SQLite are tested separately.
const previewKey = 'sidetask-browser-preview-v1';
const date = '2026-09-24';
const styles = [
  { value: 'paper', name: '纸笺' },
  { value: 'studio', name: '霜序' },
  { value: 'editorial', name: '暖刊' },
  { value: 'mono', name: '极简' },
] as const;
const sampleTitle = '完成交互设计课程作业';
const longTitle = '完成交互设计课程最终作业：整理用户研究与可用性测试，检查从首次使用到任务完成的完整交互流程，核对浅深色界面的文字可读性与边缘窗口的长标题换行，保存最终设计说明并提交作品集。';

async function seed(page: Page, snapshot: unknown) {
  await page.clock.setFixedTime(new Date(`${date}T04:00:00.000Z`));
  await page.addInitScript(({ key, value }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(value));
  }, { key: previewKey, value: snapshot });
}

async function readSnapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), previewKey);
}

async function settings(page: Page) {
  await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '界面风格', exact: true })).toBeVisible();
}

async function today(page: Page) {
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^今日/ }).click();
}

async function expectNoPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    width: innerWidth, height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width);
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.height);
}

async function expectFirstRowsFit(panel: Locator) {
  const firstRows = await panel.locator('.edge-zone').evaluateAll(zones => zones.map(zone => ({
    label: zone.querySelector('h2')!.textContent,
    rowHeight: zone.querySelector('.task-row')!.getBoundingClientRect().height,
    availableHeight: zone.querySelector('.edge-scroll')!.clientHeight,
  })));
  for (const row of firstRows) {
    expect(row.rowHeight, `${row.label} 区应完整显示首项任务及其日期`).toBeLessThanOrEqual(row.availableHeight);
  }
}

test('设置控件滚入视口后不被固定保存栏遮住', async ({ page }) => {
  await page.goto('/?surface=console');
  await settings(page);
  for (const size of [{ width: 1180, height: 790 }, { width: 640, height: 480 }]) {
    await page.setViewportSize(size);
    for (const style of styles) {
      const option = page.getByRole('button', { name: `切换到${style.name}风格`, exact: true });
      await option.click();
      // A style commit changes row heights. Scrolling under the previous style
      // can put the control behind the save bar when that commit finishes.
      await expect(option).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('html')).toHaveAttribute('data-style', style.value);
      await expect(option).toBeEnabled();
      const toggle = page.getByRole('switch', { name: '保持小窗展开', exact: true });
      // Native WebDriver and browser focus scrolling may align an element to
      // the bottom of its scrollport. The sticky save bar must reserve space.
      await toggle.evaluate(element => element.scrollIntoView({ block: 'end' }));
      const visibility = await toggle.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return {
          uncovered: !!hit && element.contains(hit),
          appliedStyle: document.documentElement.dataset.style,
          bounds: rect.toJSON(),
          hitTarget: hit?.outerHTML.slice(0, 300),
        };
      });
      expect(visibility.uncovered, `${style.value} ${size.width}×${size.height}: 设置控件可点击 ${JSON.stringify(visibility)}`).toBe(true);
    }
  }
});

test('四款风格立即保存、跨窗口同步及逐款重载，保留全部任务与计划', async ({ page, context }) => {
  const initial = createSeed(date);
  initial.settings.theme = 'dark';
  initial.tasks[1].notes = '验证换肤保留：备注、完成时间、任务版本和全部历史计划。';
  initial.plans.push({ taskId: initial.tasks[1].id, date: '2026-09-23', sortOrder: 7 });
  await seed(page, initial);
  await page.goto('/?surface=console');
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 368, height: 610 });
  await panel.goto('/?surface=edge-panel');
  const handle = await context.newPage();
  await handle.goto('/?surface=edge-handle');
  await settings(page);

  // End on a non-default style, so a reload cannot pass by silently resetting to paper.
  for (const style of [styles[1], styles[2], styles[0], styles[3]]) {
    const option = page.getByRole('button', { name: `切换到${style.name}风格`, exact: true });
    await option.click();
    await expect(option).toHaveAttribute('aria-pressed', 'true');
    for (const surface of [page, panel, handle]) {
      await expect(surface.locator('html')).toHaveAttribute('data-style', style.value);
      await expect(surface.locator('html')).toHaveAttribute('data-theme', 'dark');
    }
    const saved = await readSnapshot(page);
    expect(saved.tasks).toEqual(initial.tasks);
    expect(saved.plans).toEqual(initial.plans);
    expect(saved.settings.uiStyle).toBe(style.value);
    expect(saved.settings.theme).toBe('dark');
    await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
    await page.reload();
    await panel.reload();
    await expect(page.locator('html')).toHaveAttribute('data-style', style.value);
    await expect(panel.locator('html')).toHaveAttribute('data-style', style.value);
    await settings(page);
    await expect(page.getByRole('button', { name: `切换到${style.name}风格`, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
});

test('旧浏览器快照缺少风格字段时默认纸笺，不重置用户数据', async ({ page }) => {
  const initial = createSeed(date);
  initial.revision = 37;
  initial.tasks[0].title = '旧版本保留下来的用户任务';
  initial.tasks[0].notes = '升级外观不会覆盖已有任务。';
  initial.settings.theme = 'dark';
  initial.settings.panelWidth = 420;
  initial.settings.edge = 'left';
  const legacy = structuredClone(initial) as Omit<Snapshot, 'settings'> & { settings: Record<string, unknown> };
  delete legacy.settings.uiStyle;
  await seed(page, legacy);
  await page.goto('/?surface=console');
  await expect(page.locator('html')).toHaveAttribute('data-style', 'paper');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.main-content').getByRole('button', { name: '编辑任务：旧版本保留下来的用户任务', exact: true })).toBeVisible();
  await settings(page);
  await expect(page.getByRole('button', { name: '切换到纸笺风格', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('小窗宽度', { exact: true })).toHaveValue('420');
  await page.getByRole('button', { name: '切换到暖刊风格', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-style', 'editorial');
  const upgraded = await readSnapshot(page);
  expect(upgraded.tasks).toEqual(initial.tasks);
  expect(upgraded.plans).toEqual(initial.plans);
  expect(upgraded.settings).toEqual({ ...initial.settings, uiStyle: 'editorial' });
  expect(upgraded.revision).toBeGreaterThan(initial.revision);
});

test('立即换肤保留其他设置草稿，保存草稿后不会覆盖新风格', async ({ page }) => {
  const initial = createSeed(date);
  await seed(page, initial);
  await page.goto('/?surface=console');
  await settings(page);
  await page.getByLabel('小窗宽度', { exact: true }).fill('420');
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.getByRole('button', { name: '切换到霜序风格', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-style', 'studio');
  const styleOnly = await readSnapshot(page);
  expect(styleOnly.settings.panelWidth).toBe(initial.settings.panelWidth);
  expect(styleOnly.settings.theme).toBe('light');
  await expect(page.getByLabel('小窗宽度', { exact: true })).toHaveValue('420');
  await expect(page.getByRole('button', { name: '深色', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-style', 'studio');
  const final = await readSnapshot(page);
  expect(final.settings.panelWidth).toBe(420);
  expect(final.settings.uiStyle).toBe('studio');
  expect(final.tasks).toEqual(initial.tasks);
  expect(final.plans).toEqual(initial.plans);
});

test('嵌入控制台的最小小窗按自身高度收紧布局，长标题两区首项均完整可见', async ({ page }, testInfo) => {
  const initial = createSeed(date);
  initial.settings = { ...initial.settings, uiStyle: 'editorial', panelWidth: 300, panelHeight: 380, pinned: true };
  initial.tasks[0].title = longTitle;
  await seed(page, initial);
  await page.setViewportSize({ width: 1180, height: 760 });
  await page.goto('/?surface=console');
  const preview = page.getByTestId('browser-edge-preview');
  await expect(preview).toHaveCSS('width', '300px');
  await expect(preview).toHaveCSS('height', '380px');
  await expect(preview.locator('.edge-date')).toBeInViewport();
  await expect(preview.getByRole('heading', { name: '今日计划', exact: true })).toBeInViewport();
  await expect(preview.getByRole('heading', { name: '截止日期', exact: true })).toBeInViewport();
  await expect(preview.getByRole('button', { name: '管理任务', exact: true })).toBeInViewport();
  await expectFirstRowsFit(preview);
  await preview.screenshot({ animations: 'disabled', path: testInfo.outputPath('editorial-embedded-edge-long-300x380.png') });
});

for (const style of styles) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${style.value}-${theme}：控制台、设置、编辑及两种小窗尺寸`, async ({ page, context }, testInfo) => {
      const initial = createSeed(date);
      initial.settings = { ...initial.settings, uiStyle: style.value, theme };
      await seed(page, initial);
      await page.setViewportSize({ width: 1180, height: 760 });
      await page.goto('/?surface=console');
      await expect(page.locator('.page-heading h1')).toHaveText('今日');
      await expect(page.locator('html')).toHaveAttribute('data-style', style.value);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expectNoPageOverflow(page);
      await expect(page.getByRole('button', { name: '新建任务', exact: true })).toBeInViewport();
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${style.value}-${theme}-console.png`) });

      await settings(page);
      for (const option of styles) {
        await expect(page.getByRole('button', { name: `切换到${option.name}风格`, exact: true })).toBeInViewport();
      }
      await expectNoPageOverflow(page);
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${style.value}-${theme}-settings.png`) });

      const panel = await context.newPage();
      await panel.clock.setFixedTime(new Date(`${date}T04:00:00.000Z`));
      for (const size of [{ width: 300, height: 380 }, { width: 368, height: 610 }]) {
        await panel.setViewportSize(size);
        await panel.goto('/?surface=edge-panel');
        await expect(panel.locator('html')).toHaveAttribute('data-style', style.value);
        await expect(panel.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(panel.getByRole('heading', { name: '今日计划', exact: true })).toBeInViewport();
        await expect(panel.getByRole('heading', { name: '截止日期', exact: true })).toBeInViewport();
        await expect(panel.getByRole('button', { name: '管理任务', exact: true })).toBeInViewport();
        await expectNoPageOverflow(panel);
        await panel.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${style.value}-${theme}-edge-${size.width}x${size.height}.png`) });
      }

      await today(page);
      await page.locator('.main-content').getByRole('button', { name: `编辑任务：${sampleTitle}`, exact: true }).click();
      const detail = page.locator('.task-detail');
      await detail.getByLabel('任务名称', { exact: true }).fill(longTitle);
      await detail.getByLabel('备注').fill('用于布局验证的合成内容。\n'.repeat(8));
      await detail.getByRole('button', { name: '保存修改', exact: true }).click();
      await expect(detail.getByRole('button', { name: '已保存', exact: true })).toBeDisabled();
      await expectNoPageOverflow(page);
      await detail.getByLabel('任务名称', { exact: true }).evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${style.value}-${theme}-detail-long.png`) });
      await panel.setViewportSize({ width: 300, height: 380 });
      await expect(panel.locator('.edge-zone').first().getByRole('button', { name: `编辑任务：${longTitle}`, exact: true })).toBeVisible();
      await expect(panel.getByRole('button', { name: '管理任务', exact: true })).toBeInViewport();
      await expectNoPageOverflow(panel);
      const titleBounds = await panel.locator('.edge-zone').first().locator('.task-title').first().boundingBox();
      expect(titleBounds).not.toBeNull();
      expect(titleBounds!.x).toBeGreaterThanOrEqual(0);
      expect(titleBounds!.x + titleBounds!.width).toBeLessThanOrEqual(300);
      await expectFirstRowsFit(panel.locator('.edge-panel'));
      await panel.screenshot({ animations: 'disabled', path: testInfo.outputPath(`${style.value}-${theme}-edge-long-300x380.png`) });
    });
  }
}
