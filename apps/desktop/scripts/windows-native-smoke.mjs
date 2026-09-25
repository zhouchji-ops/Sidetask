import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { finalizeNativeSmoke } from './windows-native-smoke-finalizer.mjs';

const exec = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(scriptDir, '..');
const args = Object.fromEntries(process.argv.slice(2).map((arg, i, all) => arg.startsWith('--') ? [arg.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true] : []).filter(item => item.length));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const identifierPrefix = 'com.changjin.sidetask.windows-smoke.';
const bounds = { total: 15 * 60_000, session: 90_000, ready: 30_000, action: 15_000, exit: 30_000 };

if (args.help) {
  console.log('Prepare: node scripts/windows-native-smoke.mjs --prepare [--output ABS_DIR]\nRun: node scripts/windows-native-smoke.mjs --config ABS_JSON --exe ABS_EXE --tauri-driver ABS_EXE --edge-driver ABS_EXE [--session-only]\nSee scripts/windows-native-smoke.md. No build or install is performed.');
  process.exit(0);
}
if (args.prepare) {
  const output = resolve(typeof args.output === 'string' ? args.output : join(tmpdir(), `sidetask-windows-smoke-${Date.now()}`));
  mkdirSync(output, { recursive: false });
  const identifier = `${identifierPrefix}r${randomUUID().replaceAll('-', '')}`;
  const config = join(output, 'windows-smoke.tauri.json');
  writeFileSync(config, JSON.stringify({ productName: 'SideTask Windows Smoke', identifier, bundle: { active: false } }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ config, identifier, evidenceDirectory: join(output, 'evidence'), targetDirectory: join(output, 'target'), appData: process.env.APPDATA ? join(process.env.APPDATA, identifier) : null }, null, 2));
  process.exit(0);
}

const outputDir = typeof args.config === 'string' ? join(dirname(resolve(args.config)), 'evidence', `${Date.now()}-${process.pid}`) : join(tmpdir(), `sidetask-windows-smoke-error-${Date.now()}`);
mkdirSync(outputDir, { recursive: true });
const report = { startedAt: new Date().toISOString(), scope: 'real Windows console + edge-panel UI sync + existing IPC lifecycle + SQLite', assertions: [], bounds, outcome: 'running' };
const eventsPath = join(outputDir, 'events.jsonl');
let phase = 'preflight';
let sessionId;
let driver;
let driverPort;
let exe;
let dataDir;
let appPid;
let appStarted = false;
let finalizing = false;
let logFd;
let completed = false;
const runAbort = new AbortController();
const started = Date.now();
function event(name, status, detail = {}) {
  const entry = { at: new Date().toISOString(), elapsedMs: Date.now() - started, phase, name, status, ...detail };
  report.assertions.push(entry);
  const line = JSON.stringify(entry);
  appendFileSync(eventsPath, `${line}\n`);
  console.log(line);
}
function saveReport() { writeFileSync(join(outputDir, 'report.json'), JSON.stringify(report, null, 2)); }
async function shell(file, argv, timeout = 15_000, duringFinish = false) {
  if (finalizing && !duringFinish) throw new Error('Native smoke is stopping');
  const result = await exec(file, argv, { timeout, signal: duringFinish ? undefined : runAbort.signal, windowsHide: true, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' });
  return result.stdout.trim().replace(/^\uFEFF/, '');
}
async function probe(action, owner = 0, duringFinish = false, timeout = 15_000) {
  return JSON.parse(await shell('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(scriptDir, 'windows-native-probe.ps1'), '-Action', action, '-Executable', exe || '', '-OwnerProcessId', String(owner)], timeout, duringFinish));
}
async function processes(duringFinish = false) { return await probe('processes', 0, duringFinish, duringFinish ? 5000 : 15_000); }
async function poll(name, operation, timeout = bounds.action) {
  const deadline = Math.min(Date.now() + timeout, started + bounds.total);
  let last;
  while (Date.now() < deadline) {
    if (finalizing) throw new Error('Native smoke is stopping');
    try { const value = await operation(); if (value) return value; }
    catch (error) { last = error; }
    await delay(200);
  }
  throw new Error(`${name} exceeded ${timeout}ms${last ? `: ${last.message}` : ''}`);
}
async function request(method, path, body, timeout = bounds.action, duringFinish = false) {
  if (finalizing && !duringFinish) throw new Error('Native smoke is stopping');
  if (!duringFinish && Date.now() >= started + bounds.total) throw new Error('Global native smoke deadline exceeded');
  const response = await fetch(`http://127.0.0.1:${driverPort}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: duringFinish ? AbortSignal.timeout(timeout) : AbortSignal.any([AbortSignal.timeout(timeout), runAbort.signal]),
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) throw new Error(`${method} ${path}: ${payload.value?.error ?? response.status}: ${String(payload.value?.message ?? '').slice(0, 4000)}`);
  return payload.value;
}
const command = (method, path, body, timeout, duringFinish) => request(method, `/session/${sessionId}${path}`, body, timeout, duringFinish);
const execute = (script, ...args) => command('POST', '/execute/sync', { script, args });
async function invoke(name, payload = {}) {
  const result = await command('POST', '/execute/async', { script: `const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value => done({ok: true, value}), error => done({ok: false, error: String(error)}));`, args: [name, payload] });
  assert.equal(result.ok, true, result.error);
  return result.value;
}
const snapshot = () => invoke('get_snapshot');
async function find(selector) {
  return poll(`element ${selector}`, async () => {
    const values = await command('POST', '/elements', { using: 'css selector', value: selector });
    if (values.length !== 1) return false;
    const id = values[0]['element-6066-11e4-a52e-4f735466cecf'];
    return await command('GET', `/element/${id}/displayed`) && await command('GET', `/element/${id}/enabled`) ? id : false;
  });
}
async function clickElement(id) {
  // Center within the real scroll container before a standard WebDriver click.
  // End-aligned WebDriver scrolling can place settings controls under its sticky
  // save footer. Interception still fails; this never dispatches a JS click.
  await execute('arguments[0].scrollIntoView({block: "center", inline: "nearest", behavior: "instant"});', { 'element-6066-11e4-a52e-4f735466cecf': id });
  await command('POST', `/element/${id}/click`, {});
}
async function click(selector) { await clickElement(await find(selector)); }
async function hover(selector) {
  const id = await find(selector);
  await command('POST', '/actions', { actions: [{ type: 'pointer', id: 'smoke-mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', duration: 120, origin: { 'element-6066-11e4-a52e-4f735466cecf': id }, x: 0, y: 0 }] }] });
}
const label = name => `button[aria-label=${JSON.stringify(name)}]`;
async function button(text, scope = 'body') {
  const element = await poll(`button ${text}`, () => execute(`const matches = [...document.querySelectorAll(arguments[0] + ' button')].filter(e => e.getClientRects().length && !e.disabled && e.textContent.trim() === arguments[1]); return matches.length === 1 ? matches[0] : null;`, scope, text));
  await clickElement(element['element-6066-11e4-a52e-4f735466cecf']);
}
async function fill(selector, text) {
  const id = await find(selector);
  await command('POST', `/element/${id}/clear`, {});
  await command('POST', `/element/${id}/value`, { text, value: [...text] });
}
async function dateValue(selector, value) {
  // WebDriver date typing is locale dependent. Set the DOM input value, then
  // dispatch the same input/change events; React and the real Rust IPC still run.
  await find(selector);
  await execute(`const field = document.querySelector(arguments[0]); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, arguments[1]); field.dispatchEvent(new Event('input', {bubbles:true})); field.dispatchEvent(new Event('change', {bubbles:true}));`, selector, value);
}
async function navigation(name) {
  const element = await poll(`navigation ${name}`, () => execute(`return [...document.querySelectorAll('.sidebar .nav-item')].find(e => e.querySelector('span')?.textContent === arguments[0]) || null;`, name));
  await clickElement(element['element-6066-11e4-a52e-4f735466cecf']);
}
async function switchSurface(surface) {
  return poll(`real ${surface} WebView`, async () => {
    for (const handle of await command('GET', '/window/handles')) {
      await command('POST', '/window', { handle });
      const identity = await execute(`return {url: location.href, native: typeof window.__TAURI_INTERNALS__?.invoke === 'function'};`);
      if (identity.native && new URL(identity.url).searchParams.get('surface') === surface) return { handle, ...identity };
    }
    return false;
  });
}
async function taskState(id, predicate) { return poll(`committed task ${id}`, async () => { const state = await snapshot(); const task = state.tasks.find(task => task.id === id); return task && predicate(task, state) ? state : false; }); }
async function port() { const server = createServer(); await new Promise((r, j) => { server.once('error', j); server.listen(0, '127.0.0.1', r); }); const p = server.address().port; await new Promise(r => server.close(r)); return p; }

async function startSession(number) {
  phase = `session-${number}`;
  assert.equal((await processes()).length, 0, 'No earlier instance of the smoke executable may be running');
  appStarted = true;
  // Deliberately one POST /session per launch: a session failure ends this run.
  const session = await request('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'wry', 'tauri:options': { application: exe } } } }, bounds.session);
  sessionId = session.sessionId;
  assert.ok(sessionId, 'WebDriver returned a session id');
  await command('POST', '/timeouts', { script: bounds.action, implicit: 0, pageLoad: bounds.ready });
  const app = await poll('exact application PID', async () => { const items = await processes(); assert.ok(items.length <= 1, 'Multiple smoke app processes'); return items[0]; }, bounds.ready);
  appPid = app.ProcessId;
  report[`pid${number}`] = appPid;
  const found = await poll('real console WebView ready', async () => {
    const handles = await command('GET', '/window/handles');
    for (const handle of handles) {
      await command('POST', '/window', { handle });
      const state = await execute(`return {url: location.href, native: typeof window.__TAURI_INTERNALS__?.invoke === 'function', heading: document.querySelector('.page-heading h1')?.textContent, recovery: !!document.querySelector('.recovery-shell, .recovery-page'), userAgent: navigator.userAgent};`);
      if (state.recovery) throw new Error('App entered startup recovery');
      if (state.native && new URL(state.url).searchParams.get('surface') === 'console' && state.heading === '今日' && !/localhost:1420|127\.0\.0\.1:1420/.test(state.url)) return { ...state, handle, handleCount: handles.length };
    }
    return false;
  }, bounds.ready);
  assert.ok(existsSync(join(dataDir, 'sidetask.sqlite3')), 'The expected isolated real SQLite database exists');
  const windowStatus = await poll('native window settings settled', async () => { const status = await invoke('get_window_status'); return !status.pending || status.error ? status : false; }, bounds.ready);
  assert.ok(!windowStatus.error && !windowStatus.pending, `Native window settings failed: ${JSON.stringify(windowStatus)}`);
  const windows = await probe('windows', appPid);
  const startupAlert = await execute(`return document.querySelector('.error-banner')?.textContent ?? null;`);
  assert.equal(startupAlert, null, `Native startup left a visible error: ${startupAlert}`);
  assert.equal(windows.filter(w => w.Title === '侧笺 · SideTask' && w.Visible).length, 1);
  const handles = windows.filter(w => w.Title === 'SideTask' && w.Visible);
  assert.equal(handles.length, 1, 'Collapsed startup has exactly one visible auxiliary window');
  const handle = handles[0];
  assert.equal(handle.CoordinateSpace, 'physical-pixels');
  const rect = handle.Bounds;
  const physicalScreens = report.environment.screens;
  const overlap = screen => Math.max(0, Math.min(rect.Right, screen.bounds.X + screen.bounds.Width) - Math.max(rect.Left, screen.bounds.X)) * Math.max(0, Math.min(rect.Bottom, screen.bounds.Y + screen.bounds.Height) - Math.max(rect.Top, screen.bounds.Y));
  const screen = physicalScreens.toSorted((a, b) => overlap(b) - overlap(a))[0];
  assert.ok(screen && overlap(screen) > 0, 'Handle belongs to an observed physical monitor');
  const area = screen.workArea;
  const expectedWidth = Math.min(Math.round(18 * handle.Dpi / 96), area.Width);
  const expectedHeight = Math.min(Math.round(92 * handle.Dpi / 96), area.Height);
  assert.equal(rect.Right - rect.Left, expectedWidth, 'Native handle width must not be enlarged by Windows minimum tracking size');
  assert.equal(rect.Bottom - rect.Top, expectedHeight, 'Native handle height matches DPI');
  assert.ok(rect.Left >= area.X && rect.Top >= area.Y && rect.Right <= area.X + area.Width && rect.Bottom <= area.Y + area.Height, 'Native handle is inside its physical monitor work area');
  event('collapsed-handle-physical-bounds', 'pass', { handle: handle.Handle, dpi: handle.Dpi, bounds: rect, width: expectedWidth, height: expectedHeight, screen });
  event('real-console-ready', 'pass', { pid: appPid, webview: found, windows, windowStatus });
  return found;
}
async function explicitExit(number) {
  phase = `exit-${number}`;
  // The tray menu calls the same production quit action. Tray clicking itself is
  // not claimed here. A dirty draft exercises the actual UI exit handshake.
  const quit = invoke('window_action', { action: 'quit', payload: {} });
  await quit;
  // App exit may tear down the transport before WebDriver acknowledges click.
  // Only actual process termination and later SQLite assertions can accept it.
  await button('保存并退出', '[role="dialog"]').catch(error => event('exit-click-transport', 'info', { message: error.message }));
  await poll('product exit (PID ended before driver cleanup)', async () => !(await processes()).some(p => p.ProcessId === appPid), bounds.exit);
  event('product-exit', 'pass', { pid: appPid, entry: 'existing window_action quit IPC + save-and-exit UI', forced: false });
  try { await command('DELETE', '', undefined, 5000); } catch (error) { event('closed-session-cleanup', 'info', { detail: error.message }); }
  sessionId = undefined;
  appPid = undefined;
}
async function sqliteCheck(expected, name) {
  phase = name;
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(dataDir, 'sidetask.sqlite3');
  const db = new DatabaseSync(path, { readOnly: true });
  let state;
  try {
    assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(db.prepare('PRAGMA application_id').get().application_id, 0x5344544b);
    state = JSON.parse(db.prepare("SELECT value FROM app_state WHERE key='snapshot'").get().value);
    assert.deepEqual(state.tasks, expected.tasks);
    assert.deepEqual(state.plans, expected.plans);
    assert.equal(state.revision, expected.revision);
  } finally { db.close(); }
  event('sqlite-readonly-integrity-and-content', 'pass', { schema: 5, revision: state.revision, taskId: state.tasks[0]?.id, snapshotSha256: sha(JSON.stringify(state)), databaseSha256: sha(readFileSync(path)) });
  return state;
}
async function diagnostics() {
  // At most 14 seconds of diagnostics leaves most of the 45-second finalizer
  // for process cleanup, including an unresponsive WebDriver session.
  if (exe) { try { event('diagnostic-processes', 'info', { processes: await probe('processes', 0, true, 4000) }); } catch {} }
  if (appPid) { try { event('diagnostic-windows', 'info', { windows: await probe('windows', appPid, true, 4000) }); } catch {} }
  if (sessionId) {
    try { const body = await command('GET', '/source', undefined, 3000, true); writeFileSync(join(outputDir, 'last-page.html'), body.slice(0, 500_000)); } catch {}
    try { const png = await command('GET', '/screenshot', undefined, 3000, true); writeFileSync(join(outputDir, 'last-screen.png'), Buffer.from(png, 'base64')); } catch {}
  }
}
async function cleanup() {
  // Cleanup is recorded separately and can never satisfy the product-exit test.
  const errors = [];
  const attempt = async (step, operation) => {
    try { return await operation(); }
    catch (error) {
      const failure = { step, message: String(error.message || error).slice(0, 4000) };
      errors.push(failure);
      try { event('cleanup-error', 'fail', failure); }
      catch (logError) { errors.push({ step: 'write-cleanup-evidence', message: String(logError.message || logError).slice(0, 4000) }); }
      return undefined;
    }
  };
  if (appStarted && exe) {
    const owned = await attempt('enumerate-application', () => processes(true));
    for (const p of owned || []) {
      await attempt(`terminate-application-${p.ProcessId}`, async () => {
        await shell('taskkill.exe', ['/PID', String(p.ProcessId), '/T', '/F'], 5000, true);
        event('forced-cleanup', 'info', { pid: p.ProcessId });
      });
    }
  }
  if (driver?.pid && driver.exitCode === null && driver.signalCode === null) {
    await attempt('terminate-driver', () => shell('taskkill.exe', ['/PID', String(driver.pid), '/T', '/F'], 5000, true));
  }
  // A successful taskkill invocation is not proof that all owned processes ended.
  // Reuse the exact executable-path probe; never broaden cleanup by image name.
  if (appStarted && exe) {
    await attempt('confirm-application-exit', async () => {
      const remaining = await processes(true);
      assert.equal(remaining.length, 0, `Smoke application processes remain: ${remaining.map(p => p.ProcessId).join(', ')}`);
    });
  }
  if (driver?.pid) {
    await attempt('confirm-driver-exit', async () => {
      const deadline = Date.now() + 5000;
      while (driver.exitCode === null && driver.signalCode === null && Date.now() < deadline) await delay(100);
      assert.ok(driver.exitCode !== null || driver.signalCode !== null, 'Owned tauri-driver did not exit within 5000ms');
    });
  }
  if (logFd !== undefined) {
    await attempt('close-driver-log', () => { closeSync(logFd); logFd = undefined; });
  }
  return { ok: errors.length === 0, errors };
}
async function finish(error) {
  if (finalizing) return;
  finalizing = true;
  // Unexpected failures while writing final evidence must not fall through as 0.
  process.exitCode = 1;
  runAbort.abort(new Error('Native smoke is stopping'));
  clearTimeout(watchdog);
  // A second deadline prevents diagnostics/cleanup from extending the run forever.
  const cleanupDeadline = setTimeout(() => { report.outcome = 'fail'; report.cleanupTimeout = true; saveReport(); process.exit(1); }, 45_000);
  const exitCode = await finalizeNativeSmoke({ report, error, completed, phase, event, diagnostics, cleanup });
  report.finishedAt = new Date().toISOString();
  report.elapsedMs = Date.now() - started;
  report.unverified = ['tray menu interaction', 'IME', 'mixed-DPI multi-monitor geometry', 'sleep/resume', 'installer/upgrade', 'sustained performance'];
  if (!report.assertions.some(a => a.name === 'real-two-window-completion-sync' && a.status === 'pass')) report.unverified.push('edge-panel cross-view UI');
  saveReport();
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n### Windows native smoke: ${report.outcome}\n\n- Business checks: ${report.businessOutcome}\n- Cleanup: ${report.cleanup.ok ? 'pass' : 'fail'}\n- Commit: \`${report.commit || 'unknown'}\`\n- EXE SHA-256: \`${report.exeSha256 || 'unknown'}\`\n- PIDs: ${report.pid1 || 'none'} / ${report.pid2 || 'none'}\n- Evidence: \`${outputDir}\`\n- Failure: ${report.failure?.message.split('\n')[0] || report.cleanup.errors.map(error => `${error.step}: ${error.message}`).join('; ') || 'none'}\n- Scope: ${report.scope}; listed manual acceptance scenarios remain unverified.\n`);
  console.log(JSON.stringify({ outcome: report.outcome, businessOutcome: report.businessOutcome, cleanup: report.cleanup.ok, report: join(outputDir, 'report.json'), elapsedMs: report.elapsedMs }));
  clearTimeout(cleanupDeadline);
  process.exit(exitCode);
}
const watchdog = setTimeout(() => { void finish(new Error('Global native smoke deadline exceeded')); }, bounds.total);
process.once('SIGINT', () => { void finish(new Error('Interrupted')); });

try {
  assert.equal(process.platform, 'win32', 'Real Windows is required');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24+ required for built-in SQLite');
  for (const option of ['config', 'exe', 'tauri-driver', 'edge-driver']) assert.equal(typeof args[option], 'string', `--${option} is required`);
  exe = resolve(args.exe);
  const config = JSON.parse(readFileSync(resolve(args.config), 'utf8'));
  assert.ok(new RegExp(`^${identifierPrefix.replaceAll('.', '\\.')}r[0-9a-f]{32}$`).test(config.identifier), 'Use a fresh --prepare isolation config');
  assert.ok(process.env.APPDATA, 'APPDATA must resolve to the current test account');
  dataDir = join(process.env.APPDATA, config.identifier);
  assert.equal(existsSync(dataDir), false, 'Isolated data directory already exists; prepare a new run, do not delete unknown data');
  assert.ok(/\.exe$/i.test(exe) && !/setup|installer/i.test(exe), 'Use the application executable, not NSIS');
  const bytes = readFileSync(exe);
  assert.ok(bytes.includes(Buffer.from(config.identifier)), 'EXE does not embed this isolation identifier; rebuild with the generated config');
  report.exeSha256 = sha(bytes);
  report.identifier = config.identifier;
  report.configSha256 = sha(readFileSync(args.config));
  report.commit = await shell('git', ['rev-parse', 'HEAD']);
  report.worktree = await shell('git', ['status', '--short']);
  report.node = process.version;
  report.rust = await shell('rustc', ['--version']);
  report.environment = await probe('environment');
  assert.ok(report.environment.interactive && report.environment.inputDesktop && report.environment.sessionId > 0 && report.environment.screens.length > 0, 'Interactive unlocked Windows desktop required');
  // tauri-driver 2.0.6 has no --version option. Verify Cargo's installation
  // receipt beside bin/ instead of treating an unsupported flag as a version.
  const receiptPath = join(dirname(dirname(resolve(args['tauri-driver']))), '.crates2.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const installed = Object.entries(receipt.installs || {}).find(([name, value]) => name.startsWith('tauri-driver 2.0.6 ') && value.bins?.includes('tauri-driver.exe'));
  assert.ok(installed, 'Pin tauri-driver 2.0.6 with cargo install; its .crates2.json receipt is required');
  report.tauriDriver = installed[0];
  report.tauriDriverSha256 = sha(readFileSync(resolve(args['tauri-driver'])));
  report.edgeDriver = await shell(resolve(args['edge-driver']), ['--version']);
  report.edgeDriverSha256 = sha(readFileSync(resolve(args['edge-driver'])));
  const driverVersion = report.edgeDriver.match(/\d+\.\d+\.\d+\.\d+/)?.[0];
  assert.ok(driverVersion, 'Unable to determine Edge driver version');
  assert.ok(report.environment.webview2.some(r => r.pv?.split('.').slice(0, 3).join('.') === driverVersion.split('.').slice(0, 3).join('.')), 'WebView2 runtime and Edge driver first three version components must match');
  assert.equal((await processes()).length, 0, 'Smoke binary is already running');
  event('environment-and-isolation', 'pass', { commit: report.commit, exeSha256: report.exeSha256, identifier: config.identifier, driver: report.edgeDriver, tauriDriver: report.tauriDriver, environment: report.environment });
  driverPort = await port();
  let nativePort = await port();
  while (nativePort === driverPort) nativePort = await port();
  logFd = openSync(join(outputDir, 'driver.log'), 'wx');
  driver = spawn(resolve(args['tauri-driver']), ['--port', String(driverPort), '--native-port', String(nativePort), '--native-driver', resolve(args['edge-driver'])], { cwd: desktopDir, windowsHide: true, stdio: ['ignore', logFd, logFd] });
  let spawnError;
  driver.on('error', error => { spawnError = error; });
  await poll('driver ready', async () => { if (spawnError) throw spawnError; if (driver.exitCode !== null) throw new Error(`driver ended: ${driver.exitCode}`); return await request('GET', '/status', undefined, 2000); });
  const firstWebview = await startSession(1);
  // Modern user agents may reduce patch versions. Identify the actual runtime
  // executable in this application process tree instead of trusting the UA.
  const actualRuntimes = await probe('runtime', appPid);
  assert.ok(actualRuntimes.length > 0, 'Observe actual WebView2 child processes');
  for (const runtime of actualRuntimes) assert.equal(runtime.version.match(/\d+\.\d+\.\d+/)?.[0], driverVersion.split('.').slice(0, 3).join('.'), 'Actually launched WebView2 must match driver');
  report.actualRuntimes = actualRuntimes;
  event('actual-webview2-version', 'pass', { runtimes: actualRuntimes, userAgent: firstWebview.userAgent });
  const initial = await snapshot();
  assert.equal(initial.tasks.length, 0, 'Fresh native database must not contain demo tasks');
  assert.equal(initial.plans.length, 0);
  event('fresh-native-database', 'pass', { revision: initial.revision });
  if (!args['session-only']) {
    phase = 'console-crud';
    const title = `Windows 合成验收 ${Date.now()}`;
    await click('.new-task-button');
    await fill('#new-title', title);
    await fill('#new-notes', '合成数据：真实 Windows 原生冒烟。');
    await dateValue('#new-date', '2028-10-15');
    await dateValue('#new-time', '18:30');
    await button('创建任务', '[role="dialog"]');
    const created = await poll('UI-created task committed', async () => { const s = await snapshot(); return s.tasks.length === 1 && s.tasks[0].title === title ? s : false; });
    const id = created.tasks[0].id;
    assert.equal(created.tasks[0].dueDate, '2028-10-15');
    assert.equal(created.tasks[0].dueTime, '18:30');
    assert.ok(created.tasks[0].dueTimezone && created.tasks[0].dueAtUtc);
    assert.equal(created.plans.length, 1);
    assert.equal(created.plans[0].taskId, id);
    report.taskId = id;
    await click(`.main-content ${label(`编辑任务：${title}`)}`);
    await fill('#detail-notes', '合成数据：修改备注已持久化。');
    await dateValue('#detail-date', '2028-10-16');
    await button('保存修改', '.task-detail');
    const edited = await taskState(id, t => t.notes === '合成数据：修改备注已持久化。' && t.dueDate === '2028-10-16');
    const deadline = t => ({ dueDate: t.dueDate, dueTime: t.dueTime, dueTimezone: t.dueTimezone, dueAtUtc: t.dueAtUtc });
    const expectedDeadline = deadline(edited.tasks[0]);
    assert.equal(expectedDeadline.dueTime, '18:30');
    assert.ok(expectedDeadline.dueTimezone && expectedDeadline.dueAtUtc);
    await click(label('关闭任务详情'));
    await click(`.main-content ${label(`完成：${title}`)}`);
    const done = await taskState(id, t => t.completed);
    assert.deepEqual(deadline(done.tasks[0]), expectedDeadline);
    assert.deepEqual(done.plans, edited.plans);
    await button('撤销', '.toast');
    const undone = await taskState(id, t => !t.completed);
    assert.deepEqual(deadline(undone.tasks[0]), expectedDeadline);
    assert.deepEqual(undone.plans, edited.plans);
    await hover(`.main-content ${label(`编辑任务：${title}`)}`);
    await click(`.main-content ${label(`将${title}移出今日`)}`);
    const unplanned = await taskState(id, (t, s) => !t.completed && t.dueDate === '2028-10-16' && s.plans.length === 0);
    assert.deepEqual(deadline(unplanned.tasks[0]), expectedDeadline);
    await navigation('截止日期');
    await hover(`.main-content ${label(`编辑任务：${title}`)}`);
    await click(`.main-content ${label(`将${title}加入今日`)}`);
    const planned = await taskState(id, (t, s) => s.plans.some(p => p.taskId === id));
    assert.deepEqual(deadline(planned.tasks[0]), expectedDeadline);
    await click(`.main-content ${label(`编辑任务：${title}`)}`);
    await button('移入回收站', '.task-detail');
    const trashed = await taskState(id, (t, s) => !!t.deletedAt && s.plans.some(p => p.taskId === id));
    assert.deepEqual(deadline(trashed.tasks[0]), expectedDeadline);
    assert.deepEqual(trashed.plans, planned.plans);
    await navigation('回收站');
    await click(`.main-content ${label(`恢复任务：${title}`)}`);
    const restored = await taskState(id, (t, s) => !t.deletedAt && !t.completed && t.dueDate === '2028-10-16' && s.plans.some(p => p.taskId === id));
    assert.equal(restored.tasks.length, 1);
    assert.deepEqual(deadline(restored.tasks[0]), expectedDeadline);
    assert.deepEqual(restored.plans, planned.plans);
    event('console-crud-and-plan-invariants', 'pass', { taskId: id, revision: restored.revision });

    phase = 'two-window-sync';
    // Pin through real settings UI before opening the panel; this avoids using
    // synthetic interaction locks or racing the user's pointer against hideDelay.
    await navigation('设置');
    await click('button[aria-label="保持小窗展开"]');
    await button('保存设置', '.settings-form');
    await poll('panel pin setting committed', async () => (await snapshot()).settings.pinned);
    await button('打开边缘小窗', '.sidebar');
    const edgeIdentity = await switchSurface('edge-panel');
    await find(`.edge-zone:first-of-type ${label(`完成：${title}`)}`);
    await find(`.edge-zone:last-of-type ${label(`完成：${title}`)}`);
    assert.equal((await snapshot()).tasks[0].id, id);
    await click(`.edge-zone:first-of-type ${label(`完成：${title}`)}`);
    const completedFromEdge = await taskState(id, t => t.completed);
    assert.deepEqual(deadline(completedFromEdge.tasks[0]), expectedDeadline);
    assert.deepEqual(completedFromEdge.plans, planned.plans);
    const consoleIdentity = await switchSurface('console');
    assert.notEqual(edgeIdentity.handle, consoleIdentity.handle, 'Two separate WebViews were driven');
    await navigation('已完成');
    await click(`.main-content ${label(`撤销完成：${title}`)}`);
    await taskState(id, t => !t.completed);
    await switchSurface('edge-panel');
    await find(`.edge-zone:first-of-type ${label(`完成：${title}`)}`);
    await find(`.edge-zone:last-of-type ${label(`完成：${title}`)}`);
    const syncedBack = await snapshot();
    assert.equal(syncedBack.tasks[0].id, id);
    assert.deepEqual(deadline(syncedBack.tasks[0]), expectedDeadline);
    assert.deepEqual(syncedBack.plans, planned.plans);
    event('real-two-window-completion-sync', 'pass', { taskId: id, console: consoleIdentity, panel: edgeIdentity, revision: syncedBack.revision });
    await click(label('收起小窗'));
    await switchSurface('console');
    await navigation('今日');

    phase = 'console-close-restore';
    const originalConsole = (await probe('windows', appPid)).find(w => w.Title === '侧笺 · SideTask' && w.Visible);
    assert.ok(originalConsole, 'Visible console before WM_CLOSE');
    await probe('close', appPid);
    await poll('WM_CLOSE hides console without terminating app', async () => { const w = await probe('windows', appPid); return w.some(w => w.Title === '侧笺 · SideTask' && !w.Visible); });
    await invoke('window_action', { action: 'openConsole', payload: { page: 'today' } });
    const windows = await poll('same native console restored', async () => { const w = await probe('windows', appPid); return w.filter(w => w.Title === '侧笺 · SideTask' && w.Visible).length === 1 ? w : false; });
    assert.equal(windows.find(w => w.Title === '侧笺 · SideTask' && w.Visible).Handle, originalConsole.Handle, 'Restore must reuse the console HWND');
    event('console-close-restore', 'pass', { pid: appPid, restoreEntry: 'existing openConsole IPC', windows });
    await click(`.main-content ${label(`编辑任务：${title}`)}`);
    await fill('#detail-notes', '合成数据：退出门禁保存草稿。');
    await explicitExit(1);
    // Read the expected final snapshot from disk once, then assert that the exit
    // draft is the only task-field change beyond the last committed UI state.
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(dataDir, 'sidetask.sqlite3'), { readOnly: true });
    let persisted;
    try { persisted = JSON.parse(db.prepare("SELECT value FROM app_state WHERE key='snapshot'").get().value); } finally { db.close(); }
    assert.equal(persisted.tasks.length, 1);
    assert.equal(persisted.tasks[0].notes, '合成数据：退出门禁保存草稿。');
    assert.deepEqual({ ...persisted.tasks[0], notes: restored.tasks[0].notes, revision: restored.tasks[0].revision }, restored.tasks[0]);
    assert.deepEqual(persisted.plans, restored.plans);
    assert.ok(persisted.revision > restored.revision && persisted.tasks[0].revision > restored.tasks[0].revision);
    await sqliteCheck(persisted, 'sqlite-after-exit');
    await startSession(2);
    assert.notEqual(report.pid1, report.pid2, 'Restart must have a new PID');
    const reopened = await snapshot();
    assert.deepEqual(reopened.tasks, persisted.tasks);
    assert.deepEqual(reopened.plans, persisted.plans);
    await click(`.main-content ${label(`编辑任务：${title}`)}`);
    assert.equal(await execute('return document.querySelector("#detail-notes").value;'), '合成数据：退出门禁保存草稿。');
    event('restart-persistence', 'pass', { taskId: id, revision: reopened.revision, pid: appPid });
    await fill('#detail-notes', '合成数据：第二次明确退出。');
    // Capture expected data from the real committed service before a final quit.
    await button('保存修改', '.task-detail');
    const finalState = await taskState(id, t => t.notes === '合成数据：第二次明确退出。');
    await click(label('关闭任务详情'));
    const quit = invoke('window_action', { action: 'quit', payload: {} });
    await quit.catch(error => event('exit-transport-ended', 'info', { message: error.message }));
    await poll('second explicit app exit', async () => (await processes()).length === 0, bounds.exit);
    event('second-product-exit', 'pass', { pid: appPid, forced: false });
    sessionId = undefined;
    appPid = undefined;
    await sqliteCheck(finalState, 'sqlite-after-restart');
    completed = true;
  }
  await finish();
} catch (error) { await finish(error); }
