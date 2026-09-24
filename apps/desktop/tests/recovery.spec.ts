import { expect, test, type Page } from '@playwright/test';

// Frontend IPC simulation only. Disk safety, restart and native recovery-mode
// ACLs are validated independently in Rust and an isolated macOS app profile.
async function recoveryHarness(page: Page, options: { empty?: boolean; bootError?: boolean; busy?: boolean } = {}) {
  await page.addInitScript(options => {
    const harness = {
      bootError: !!options.bootError,
      mode: 'success',
      release: () => {},
      calls: [] as { command: string; args: any }[],
      state: {
        dataDirectory: '/synthetic/侧笺 数据',
        error: '数据库校验失败：snapshot 缺失。',
        scanError: null,
        busy: !!options.busy,
        recovered: null as null | { preservedDirectory: string; restartRequired: true },
        candidates: options.empty ? [] : [{ id: 'opaque-name#sha256', fileName: 'sidetask-safety-backup-synthetic.sqlite3', kind: 'safety-backup', schemaVersion: 2, taskCount: 12, planCount: 8, revision: 10, sizeBytes: 8192, modifiedAt: '2026-09-25T00:00:00Z' }],
      },
    };
    Object.assign(window, {
      __recovery: harness,
      __TAURI_INTERNALS__: {
        async invoke(command: string, args: any = {}) {
          harness.calls.push({ command, args });
          if (command === 'get_startup_recovery') {
            if (harness.bootError) throw new Error('启动状态暂时不可用');
            return structuredClone(harness.state);
          }
          if (command === 'recover_startup_backup') {
            if (harness.mode === 'wait') await new Promise<void>(resolve => { harness.release = resolve; });
            if (harness.mode === 'stale') {
              harness.state.candidates[0].id = 'changed#newhash';
              throw new Error('备份在选择后发生变化，请重新检查。');
            }
            harness.state.recovered = { preservedDirectory: '/synthetic/侧笺 原文件保留/recovery-original-123', restartRequired: true };
            if (harness.mode === 'lost-response') throw new Error('恢复响应丢失');
            return structuredClone(harness.state.recovered);
          }
          if (command === 'restart_after_recovery') return;
          throw new Error(`Unexpected recovery IPC: ${command}`);
        },
      },
    });
  }, options);
  await page.goto('/?surface=console');
}

test('坏库只打开恢复页面，需选择和二次确认；恢复中阻止重复提交，成功后再重启', async ({ page }) => {
  await recoveryHarness(page);
  await expect(page.getByRole('heading', { name: '需要恢复本地数据' })).toBeVisible();
  const next = page.getByRole('button', { name: '检查并恢复所选备份' });
  await expect(next).toBeDisabled();
  await page.getByRole('radio').check();
  await next.click();
  await expect(page.getByRole('heading', { name: '确认恢复这份备份？' })).toBeVisible();
  await expect(page.getByRole('radio')).toBeDisabled();
  expect(await page.evaluate(() => (window as any).__recovery.calls.some((call: any) => call.command === 'recover_startup_backup' || call.command === 'get_snapshot'))).toBe(false);
  await page.evaluate(() => { (window as any).__recovery.mode = 'wait'; });
  await page.getByRole('button', { name: '保留原文件并恢复' }).click();
  await expect(page.getByRole('button', { name: '保留原文件并恢复' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '返回选择' })).toBeDisabled();
  await page.evaluate(() => (window as any).__recovery.release());
  await expect(page.getByRole('heading', { name: '本地数据已恢复' })).toBeFocused();
  await expect(page.locator('.recovery-path')).toContainText('/synthetic/侧笺 原文件保留/');
  await page.getByRole('button', { name: '重新启动侧笺' }).click();
  const calls = await page.evaluate(() => (window as any).__recovery.calls);
  expect(calls.filter((call: any) => call.command === 'recover_startup_backup')).toEqual([{ command: 'recover_startup_backup', args: { candidateId: 'opaque-name#sha256' } }]);
  expect(calls.filter((call: any) => call.command === 'restart_after_recovery')).toHaveLength(1);
  expect(calls.some((call: any) => call.command === 'get_snapshot')).toBe(false);
});

test('启动状态读取失败保留重试入口；无有效备份不能创建空任务库', async ({ page }) => {
  await recoveryHarness(page, { empty: true, bootError: true });
  await expect(page.getByRole('alert')).toContainText('启动状态暂时不可用');
  await expect(page.locator('.console-shell')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__recovery.bootError = false; });
  await page.getByRole('button', { name: '重试检查' }).click();
  await expect(page.getByText('未找到验证通过的本机备份。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '检查并恢复所选备份' })).toBeDisabled();
  await page.getByRole('button', { name: '重新检查备份' }).click();
  expect(await page.evaluate(() => (window as any).__recovery.calls.every((call: any) => call.command === 'get_startup_recovery'))).toBe(true);
});

test('确认后候选变更要求重新选择；恢复响应丢失时查询结果避免重复恢复', async ({ page }) => {
  await recoveryHarness(page);
  await page.getByRole('radio').check();
  await page.getByRole('button', { name: '检查并恢复所选备份' }).click();
  await page.evaluate(() => { (window as any).__recovery.mode = 'stale'; });
  await page.getByRole('button', { name: '保留原文件并恢复' }).click();
  await expect(page.getByRole('alert')).toContainText('备份在选择后发生变化');
  await expect(page.getByRole('radio')).not.toBeChecked();
  await page.getByRole('button', { name: '重新检查备份' }).click();
  await page.getByRole('radio').check();
  await page.getByRole('button', { name: '检查并恢复所选备份' }).click();
  await page.evaluate(() => { (window as any).__recovery.mode = 'lost-response'; });
  await page.getByRole('button', { name: '保留原文件并恢复' }).click();
  await expect(page.getByRole('heading', { name: '本地数据已恢复' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保留原文件并恢复' })).toHaveCount(0);
});

test('重新载入遇到仍在执行的恢复时查询最终状态，长文件名和窄窗口保持可读', async ({ page }) => {
  await recoveryHarness(page, { busy: true });
  await expect(page.getByRole('radio')).toBeDisabled();
  await page.setViewportSize({ width: 480, height: 640 });
  await page.evaluate(() => {
    const harness = (window as any).__recovery;
    harness.state.busy = false;
    harness.state.candidates[0].fileName = 'sidetask-safety-backup-' + 'a'.repeat(180) + '.sqlite3';
  });
  await expect(page.getByRole('radio')).toBeEnabled();
  expect(await page.locator('.recovery-shell').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/sidetask-recovery-narrow.png', fullPage: true });
});
