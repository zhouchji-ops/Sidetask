import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeNativeSmoke } from '../scripts/windows-native-smoke-finalizer.mjs';

function runOptions(overrides = {}) {
  return {
    report: {},
    completed: true,
    phase: 'console-crud',
    event() {},
    async diagnostics() {},
    async cleanup() { return { ok: true, errors: [] }; },
    ...overrides,
  };
}

test('failure log write errors still allow diagnostics and process cleanup', async () => {
  const calls = [];
  const options = runOptions({
    error: new Error('native assertion failed'),
    event() { calls.push('event'); throw new Error('ENOSPC writing events.jsonl'); },
    async diagnostics() { calls.push('diagnostics'); },
    async cleanup() { calls.push('cleanup'); return { ok: true, errors: [] }; },
  });

  assert.equal(await finalizeNativeSmoke(options), 1);
  assert.deepEqual(calls, ['event', 'diagnostics', 'cleanup']);
  assert.equal(options.report.outcome, 'fail');
  assert.equal(options.report.cleanup.ok, true);
  assert.match(options.report.failure.message, /native assertion failed/);
  assert.deepEqual(options.report.evidenceErrors, [{ step: 'failure-event', message: 'ENOSPC writing events.jsonl' }]);
});

test('diagnostic failure cannot prevent process cleanup or hide the original failure', async () => {
  let cleanupCalls = 0;
  const options = runOptions({
    error: new Error('native assertion failed'),
    async diagnostics() { throw new Error('screenshot write failed'); },
    async cleanup() { cleanupCalls++; return { ok: true, errors: [] }; },
  });

  assert.equal(await finalizeNativeSmoke(options), 1);
  assert.equal(cleanupCalls, 1);
  assert.match(options.report.failure.message, /native assertion failed/);
  assert.deepEqual(options.report.evidenceErrors, [{ step: 'diagnostics', message: 'screenshot write failed' }]);
});

test('completed business checks pass only after successful cleanup', async () => {
  let cleanupCalls = 0;
  const options = runOptions({
    async cleanup() { cleanupCalls++; return { ok: true, errors: [] }; },
    event() { assert.fail('successful runs should not log a failure'); },
    async diagnostics() { assert.fail('successful runs should not collect failure diagnostics'); },
  });

  assert.equal(await finalizeNativeSmoke(options), 0);
  assert.equal(cleanupCalls, 1);
  assert.equal(options.report.businessOutcome, 'pass');
  assert.equal(options.report.outcome, 'pass');
});

test('session-only success remains distinct from completed business checks', async () => {
  const options = runOptions({ completed: false });
  assert.equal(await finalizeNativeSmoke(options), 0);
  assert.equal(options.report.outcome, 'session-only-pass');
});

test('reported cleanup errors fail the run while preserving business success', async () => {
  const cleanupResult = { ok: false, errors: [{ step: 'confirm-application-exit', message: 'process remains' }] };
  const options = runOptions({ async cleanup() { return cleanupResult; } });

  assert.equal(await finalizeNativeSmoke(options), 1);
  assert.equal(options.report.businessOutcome, 'pass');
  assert.equal(options.report.outcome, 'fail');
  assert.deepEqual(options.report.cleanup, cleanupResult);
});

test('unexpected cleanup rejection fails the run with its reason', async () => {
  const options = runOptions({ async cleanup() { throw new Error('process query failed'); } });

  assert.equal(await finalizeNativeSmoke(options), 1);
  assert.equal(options.report.businessOutcome, 'pass');
  assert.equal(options.report.outcome, 'fail');
  assert.deepEqual(options.report.cleanup, { ok: false, errors: [{ step: 'cleanup', message: 'process query failed' }] });
});
