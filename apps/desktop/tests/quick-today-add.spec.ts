import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createSeed } from '../src/lib/domain';
import type { Snapshot, UIStyle } from '../src/lib/types';

// Isolated browser-preview persistence and keyboard coverage. Synthetic IME
// events do not certify native candidate windows, AppKit focus, or SQLite IPC.
const storageKey = 'sidetask-browser-preview-v1';
const date = '2026-09-25';
const fixedTime = new Date(`${date}T04:00:00.000Z`);
type ProbeWindow = Window & { quickAddProbe: { writes: number; fail: boolean; release?: () => void; locks: boolean[] } };
const titleInput = (root: Page | Locator) => root.getByRole('textbox', { name: '今日任务名称', exact: true });
const headingAdd = (root: Page | Locator) => root.getByRole('button', { name: '添加今日任务', exact: true });
const footerAdd = (root: Page | Locator) => root.getByRole('button', { name: '快速添加今日任务', exact: true });
const submit = (root: Page | Locator) => root.getByRole('button', { name: '添加到今日', exact: true });
const closeAdd = (root: Page | Locator) => root.getByRole('button', { name: '收起添加任务', exact: true });
const today = (page: Page) => page.locator('.edge-zone').filter({ has: page.getByRole('heading', { name: '今日计划', exact: true }) });
const deadlines = (page: Page) => page.locator('.edge-zone').filter({ has: page.getByRole('heading', { name: '截止日期', exact: true }) });

function fixture(style: UIStyle = 'paper'): Snapshot {
  const snapshot = createSeed(date);
  snapshot.revision = 11;
  snapshot.tasks = snapshot.tasks.slice(0, 1);
  snapshot.tasks[0].title = '合成既有截止任务';
  snapshot.plans = [];
  snapshot.settings.uiStyle = style;
  snapshot.settings.pinned = false;
  return snapshot;
}

async function seed(context: BrowserContext, snapshot = fixture()) {
  await context.addInitScript(({ key, snapshot }) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(snapshot));
    localStorage.setItem('sidetask-usage-guide-seen-v1', '1');
    const probe = { writes: 0, fail: false, locks: [] as boolean[] };
    (window as ProbeWindow).quickAddProbe = probe;
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name === key) {
        probe.writes++;
        if (probe.fail) throw new Error('合成今日任务写入失败');
      }
      return original.call(this, name, value);
    };
    window.addEventListener('sidetask:preview-interaction', event => probe.locks.push(Boolean((event as CustomEvent).detail.locked)));
  }, { key: storageKey, snapshot });
  return snapshot;
}

async function openPanel(page: Page) {
  await page.clock.setFixedTime(fixedTime);
  await page.setViewportSize({ width: 368, height: 610 });
  await page.goto('/?surface=edge-panel');
  await expect(headingAdd(page)).toBeVisible();
}

async function openPreview(page: Page) {
  await page.clock.setFixedTime(fixedTime);
  await page.goto('/?surface=console');
  const preview = page.getByTestId('browser-edge-preview');
  await preview.getByRole('button', { name: '展开侧笺；按住拖动可调整位置', exact: true }).hover();
  await expect(headingAdd(preview)).toBeVisible();
  return preview;
}

async function persisted(page: Page): Promise<Snapshot> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), storageKey);
}

async function holdWrites(page: Page) {
  await page.evaluate(() => new Promise<void>(ready => {
    void navigator.locks.request('sidetask-preview-write', () => new Promise<void>(release => {
      (window as ProbeWindow).quickAddProbe.release = release;
      ready();
    }));
  }));
}

async function releaseWrites(page: Page) {
  await page.evaluate(() => (window as ProbeWindow).quickAddProbe.release?.());
}

async function failWrites(page: Page, fail: boolean) {
  await page.evaluate(value => { (window as ProbeWindow).quickAddProbe.fail = value; }, fail);
}

test('小窗新建同一今日任务并同步控制台，完成和撤销保留 ID 与计划', async ({ page, context }) => {
  const initial = await seed(context);
  await page.clock.setFixedTime(fixedTime);
  await page.goto('/?surface=console');
  const panel = await context.newPage();
  await openPanel(panel);
  const title = '合成小窗即时创建';
  await headingAdd(panel).click();
  await expect(titleInput(panel)).toBeFocused();
  await titleInput(panel).fill(`  ${title}  `);
  await panel.keyboard.press('Enter');
  await expect(titleInput(panel)).toHaveValue('');
  await expect(titleInput(panel)).toBeFocused();
  await expect(panel.getByRole('status')).toContainText('已加入今日');
  await expect(today(panel).getByRole('button', { name: `完成：${title}`, exact: true })).toBeVisible();
  const main = page.locator('.main-content');
  await expect(main.getByRole('button', { name: `完成：${title}`, exact: true })).toBeVisible();
  await expect(deadlines(panel).getByRole('button', { name: `编辑任务：${title}`, exact: true })).toHaveCount(0);
  await expect(panel).toHaveURL(/surface=edge-panel$/);
  await expect(page.getByRole('dialog', { name: '新建任务', exact: true })).toHaveCount(0);

  const created = await persisted(panel);
  expect(created.revision).toBe(initial.revision + 1);
  expect(created.settings).toEqual(initial.settings);
  expect(created.tasks.filter(task => task.id === initial.tasks[0].id)).toEqual(initial.tasks);
  const task = created.tasks.find(task => task.title === title)!;
  expect(task).toMatchObject({ notes: '', priority: 'normal', dueDate: null, dueTime: null, completed: false, completedAt: null });
  expect(created.tasks).toHaveLength(initial.tasks.length + 1);
  expect(created.plans).toEqual([{ taskId: task.id, date, sortOrder: 0 }]);

  await today(panel).getByRole('button', { name: `完成：${title}`, exact: true }).click();
  await expect(main.getByRole('button', { name: `完成：${title}`, exact: true })).toHaveCount(0);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: /^已完成/ }).click();
  await expect(main.getByRole('button', { name: `撤销完成：${title}`, exact: true })).toBeVisible();
  await main.getByRole('button', { name: `撤销完成：${title}`, exact: true }).click();
  await expect(today(panel).getByRole('button', { name: `完成：${title}`, exact: true })).toBeVisible();
  const restored = await persisted(panel);
  expect(restored.tasks.find(item => item.id === task.id)).toMatchObject({ title, completed: false, completedAt: null, revision: task.revision + 2 });
  expect(restored.tasks).toHaveLength(created.tasks.length);
  expect(restored.plans).toEqual(created.plans);
  await panel.reload();
  await expect(today(panel).getByRole('button', { name: `完成：${title}`, exact: true })).toBeVisible();
});

test('标题与底部加号共用原地草稿，关闭可继续编辑或明确放弃', async ({ page, context }) => {
  const initial = await seed(context);
  await openPanel(page);
  await footerAdd(page).click();
  await expect(titleInput(page)).toBeFocused();
  await titleInput(page).fill('合成仍在编辑的标题');
  await headingAdd(page).click();
  await expect(titleInput(page)).toHaveCount(1);
  await expect(titleInput(page)).toHaveValue('合成仍在编辑的标题');
  await expect(titleInput(page)).toBeFocused();
  await closeAdd(page).click();
  await expect(page.getByRole('button', { name: '保存并收起', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(titleInput(page)).toBeFocused();
  await expect(titleInput(page)).toHaveValue('合成仍在编辑的标题');
  expect(await persisted(page)).toEqual(initial);
  await closeAdd(page).click();
  await page.getByRole('button', { name: '放弃草稿', exact: true }).click();
  await expect(titleInput(page)).toBeHidden();
  await footerAdd(page).click();
  await expect(titleInput(page)).toHaveValue('');
  await expect(page.getByRole('dialog', { name: '新建任务', exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/surface=edge-panel$/);
  expect(await persisted(page)).toEqual(initial);
});

test('纯键盘 Esc 打开草稿确认并聚焦继续编辑，再次 Esc 保留草稿返回输入', async ({ page, context }) => {
  const initial = await seed(context);
  await openPanel(page);
  await headingAdd(page).focus();
  await page.keyboard.press('Enter');
  await expect(titleInput(page)).toBeFocused();
  await page.keyboard.insertText('合成全键盘保留草稿');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeFocused();
  await expect(titleInput(page)).toHaveValue('合成全键盘保留草稿');
  expect(await persisted(page)).toEqual(initial);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeHidden();
  await expect(titleInput(page)).toBeFocused();
  await expect(titleInput(page)).toHaveValue('合成全键盘保留草稿');
  await page.keyboard.press('Enter');
  await expect(titleInput(page)).toHaveValue('');
  await expect(titleInput(page)).toBeFocused();
  await expect(today(page).getByRole('button', { name: '完成：合成全键盘保留草稿', exact: true })).toBeVisible();
  expect((await persisted(page)).revision).toBe(initial.revision + 1);
});

test('空白不创建，组合输入及 229 Enter 阻止默认提交，确认后可连续新建', async ({ page, context }) => {
  const initial = await seed(context);
  await openPanel(page);
  await headingAdd(page).click();
  const input = titleInput(page);
  await input.fill('   ');
  await page.keyboard.press('Enter');
  expect(await persisted(page)).toEqual(initial);
  await input.fill('合成中文输入确认');
  for (const composition of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
    const prevented = await input.evaluate((element, composition) => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, ...composition });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    }, composition);
    expect(prevented, '组合 Enter 必须取消原生表单提交').toBe(true);
    await expect(input).toHaveValue('合成中文输入确认');
    expect(await persisted(page)).toEqual(initial);
  }
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await input.fill('合成继续添加下一项');
  await page.keyboard.press('Enter');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  const saved = await persisted(page);
  expect(saved.tasks.filter(task => task.title.startsWith('合成中文') || task.title.startsWith('合成继续')).map(task => task.title)).toEqual(['合成中文输入确认', '合成继续添加下一项']);
  expect(saved.plans.map(plan => plan.sortOrder)).toEqual([0, 1]);
  expect(saved.revision).toBe(initial.revision + 2);
});

test('保存尚未返回时重复 Enter 和提交不产生重复任务', async ({ page, context }) => {
  const initial = await seed(context);
  await openPanel(page);
  await headingAdd(page).click();
  await titleInput(page).fill('合成只创建一次');
  await holdWrites(page);
  try {
    await page.keyboard.press('Enter');
    await expect(submit(page)).toBeDisabled();
    await expect(closeAdd(page)).toBeDisabled();
    await page.keyboard.press('Enter');
    await titleInput(page).evaluate(element => {
      element.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      element.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(await persisted(page)).toEqual(initial);
  } finally { await releaseWrites(page); }
  await expect(titleInput(page)).toHaveValue('');
  await expect(titleInput(page)).toBeFocused();
  const saved = await persisted(page);
  expect(saved.tasks.filter(task => task.title === '合成只创建一次')).toHaveLength(1);
  expect(saved.plans).toHaveLength(1);
  expect(saved.revision).toBe(initial.revision + 1);
  expect(await page.evaluate(() => (window as ProbeWindow).quickAddProbe.writes)).toBe(1);
});

test('写入失败保留标题与已提交列表，解除故障后 Enter 重试仅创建一次', async ({ page, context }) => {
  const initial = await seed(context);
  await openPanel(page);
  await headingAdd(page).click();
  await titleInput(page).fill('合成失败后重试');
  await failWrites(page, true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('form', { name: '快速添加今日任务', exact: true }).getByRole('alert')).toContainText('合成今日任务写入失败');
  await expect(titleInput(page)).toHaveValue('合成失败后重试');
  await expect(submit(page)).toBeEnabled();
  await expect(today(page).getByRole('button', { name: '编辑任务：合成失败后重试', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).not.toContainText('已加入今日');
  expect(await persisted(page)).toEqual(initial);
  await failWrites(page, false);
  await titleInput(page).focus();
  await page.keyboard.press('Enter');
  await expect(titleInput(page)).toHaveValue('');
  await expect(titleInput(page)).toBeFocused();
  await expect(today(page).getByRole('button', { name: '完成：合成失败后重试', exact: true })).toBeVisible();
  const saved = await persisted(page);
  expect(saved.tasks.filter(task => task.title === '合成失败后重试')).toHaveLength(1);
  expect(saved.revision).toBe(initial.revision + 1);
});

test('保存等待时用户主动移到分区控件，完成后不抢回输入焦点', async ({ page, context }) => {
  await seed(context);
  await openPanel(page);
  await headingAdd(page).click();
  await titleInput(page).fill('合成保存时继续查看分区');
  await holdWrites(page);
  const separator = page.getByRole('separator', { name: '调整今日与截止日期区域的比例', exact: true });
  try {
    await page.keyboard.press('Enter');
    await expect(submit(page)).toBeDisabled();
    await separator.focus();
    await expect(separator).toBeFocused();
  } finally { await releaseWrites(page); }
  await expect(titleInput(page)).toHaveValue('');
  await expect(submit(page)).toBeEnabled();
  // Give the component's post-commit focus restoration its actual RAF turn.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(separator).toBeFocused();
  await expect(today(page).getByRole('button', { name: '完成：合成保存时继续查看分区', exact: true })).toBeVisible();
});

test('保存并收起等待和失败都保留草稿，成功后才收起', async ({ page, context }) => {
  const initial = await seed(context);
  await openPanel(page);
  await headingAdd(page).click();
  await titleInput(page).fill('合成保存后再收起');
  await closeAdd(page).click();
  await failWrites(page, true);
  await holdWrites(page);
  try {
    await page.getByRole('button', { name: '保存并收起', exact: true }).click();
    await expect(page.getByRole('button', { name: '继续编辑', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: '放弃草稿', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(titleInput(page)).toHaveValue('合成保存后再收起');
    expect(await persisted(page)).toEqual(initial);
  } finally { await releaseWrites(page); }
  await expect(page.getByRole('form', { name: '快速添加今日任务', exact: true }).getByRole('alert')).toContainText('合成今日任务写入失败');
  await expect(titleInput(page)).toHaveValue('合成保存后再收起');
  const save = page.getByRole('button', { name: '保存并收起', exact: true });
  await expect(save).toBeEnabled();
  await failWrites(page, false);
  await save.click();
  await expect(titleInput(page)).toBeHidden();
  await expect(today(page).getByRole('button', { name: '完成：合成保存后再收起', exact: true })).toBeVisible();
  expect((await persisted(page)).revision).toBe(initial.revision + 1);
});

test('小窗草稿阻止悬停收起，显式隐藏再展开保留草稿且快捷键不打开控制台新建', async ({ page, context }) => {
  const initial = await seed(context);
  const preview = await openPreview(page);
  await headingAdd(preview).click();
  await titleInput(preview).fill('合成隐藏期间保留');
  for (const modifier of ['Meta', 'Control']) {
    await page.keyboard.press(`${modifier}+n`);
    await expect(page.getByRole('dialog', { name: '新建任务', exact: true })).toHaveCount(0);
    await expect(titleInput(preview)).toHaveValue('合成隐藏期间保留');
    await expect(titleInput(preview)).toBeFocused();
  }
  await page.mouse.move(400, 100);
  // Deliver the actual preview hide-timer event without making elapsed time a
  // pass condition. The panel's interaction owner must reject this automatic hide.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('sidetask:preview-leave')));
  await expect(titleInput(preview)).toBeVisible();
  await preview.getByRole('button', { name: '收起小窗', exact: true }).click();
  await page.mouse.move(400, 100);
  await expect(titleInput(preview)).toBeHidden();
  await preview.getByRole('button', { name: '展开侧笺；按住拖动可调整位置', exact: true }).hover();
  await expect(titleInput(preview)).toHaveValue('合成隐藏期间保留');
  await expect(page.getByRole('dialog', { name: '新建任务', exact: true })).toHaveCount(0);
  expect(await persisted(page)).toEqual(initial);
  await submit(preview).click();
  await expect(titleInput(preview)).toHaveValue('');
  await expect(page.locator('.main-content').getByRole('button', { name: '完成：合成隐藏期间保留', exact: true })).toBeVisible();
});

test('收起快速添加只释放自己的交互锁，其他交互仍能阻止自动隐藏', async ({ page, context }) => {
  await seed(context);
  const preview = await openPreview(page);
  await headingAdd(preview).click();
  await page.evaluate(async () => {
    const path = '/src/lib/native.ts';
    const native = await import(path);
    await native.setInteractionLock(true, 'synthetic-other-editor');
  });
  await closeAdd(preview).click();
  await expect(titleInput(preview)).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).quickAddProbe.locks.at(-1))).toBe(true);
  await page.mouse.move(400, 100);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('sidetask:preview-leave')));
  await expect(preview.locator('.edge-panel')).toBeVisible();
  await page.evaluate(async () => {
    const path = '/src/lib/native.ts';
    const native = await import(path);
    await native.setInteractionLock(false, 'synthetic-other-editor');
    window.dispatchEvent(new CustomEvent('sidetask:preview-leave'));
  });
  await expect(preview.locator('.edge-panel')).toBeHidden();
});

for (const style of ['paper', 'studio', 'editorial', 'mono'] as const) {
  test(`${style} 风格在 300×380 小窗内可添加与确认草稿，控件无溢出遮挡`, async ({ page, context }, testInfo) => {
    await seed(context, fixture(style));
    await openPanel(page);
    await headingAdd(page).click();
    if (style === 'paper') await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('paper-368x610.png') });
    await page.setViewportSize({ width: 300, height: 380 });
    await expect(page.locator('html')).toHaveAttribute('data-style', style);
    const input = titleInput(page);
    await input.fill('合成最小尺寸下仍可编辑和创建的今日任务');
    await expect(input).toBeInViewport();
    await expect(submit(page)).toBeInViewport();
    await expect(page.getByRole('heading', { name: '截止日期', exact: true })).toBeInViewport();
    await closeAdd(page).click();
    for (const name of ['保存并收起', '放弃草稿', '继续编辑']) {
      const control = page.getByRole('button', { name, exact: true });
      await expect(control).toBeInViewport();
      expect(await control.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return !!hit && element.contains(hit);
      }), `${style} 的 ${name} 应可点击且不被相邻控件遮挡`).toBe(true);
    }
    if (style === 'paper') await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('paper-confirm-300x380.png') });
    expect(await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }))).toEqual({ width: 300, height: 380 });
    await page.getByRole('button', { name: '保存并收起', exact: true }).click();
    await expect(input).toBeHidden();
    await expect(today(page).getByRole('button', { name: '完成：合成最小尺寸下仍可编辑和创建的今日任务', exact: true })).toBeVisible();
  });
}
