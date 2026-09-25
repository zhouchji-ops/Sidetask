// Keep failure evidence best-effort, but always attempt process cleanup.
// Dependencies are injected so this lifecycle contract can run without Windows
// processes, drivers, or a writable evidence directory.
export async function finalizeNativeSmoke({ report, error, completed, phase, event, diagnostics, cleanup }) {
  report.businessOutcome = error ? 'fail' : completed ? 'pass' : 'session-only-pass';
  report.outcome = report.businessOutcome;
  report.evidenceErrors = [];
  const recordEvidence = async (step, operation) => {
    try { await operation(); }
    catch (evidenceError) {
      report.evidenceErrors.push({ step, message: String(evidenceError.message || evidenceError).slice(0, 4000) });
    }
  };
  try {
    if (error) {
      report.failure = { phase, message: String(error.stack || error).slice(0, 12_000) };
      await recordEvidence('failure-event', () => event('run', 'fail', { message: error.message }));
      await recordEvidence('diagnostics', diagnostics);
    }
  } finally {
    try { report.cleanup = await cleanup(); }
    catch (cleanupError) {
      report.cleanup = { ok: false, errors: [{ step: 'cleanup', message: String(cleanupError.message || cleanupError).slice(0, 4000) }] };
    }
  }
  if (!report.cleanup.ok || report.evidenceErrors.length) report.outcome = 'fail';
  return report.outcome === 'fail' ? 1 : 0;
}
