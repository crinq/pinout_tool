// Diagnostic shim: install onerror BEFORE dynamic import so init failures in
// the impl module reach the main thread with a real message/stack. The import
// is kicked off eagerly so its module graph loads in parallel with worker
// spawn instead of waiting for the first message.
// ponytail: shim exists only to unmask opaque worker load errors.
function reportInitError(msg: string, stack?: string): void {
  self.postMessage({
    _wire: true,
    mcuRef: '',
    solutions: [],
    errors: [{ type: 'error', message: `Worker init: ${msg}${stack ? '\n' + stack : ''}` }],
    statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 },
  });
}

self.onerror = (msg, url, line, col, err) => {
  reportInitError(`${msg} @ ${url ?? '?'}:${line ?? '?'}:${col ?? '?'}`, err?.stack);
  return true;
};
self.onunhandledrejection = (e) => {
  const err = (e as PromiseRejectionEvent).reason;
  reportInitError(String(err), err instanceof Error ? err.stack : undefined);
};

// Eager: start loading impl right now so vite dev-mode module fetches happen
// during worker spawn, not on first message.
const implLoad = import('./solver-worker-impl').catch((err) => {
  reportInitError(`import failed: ${err instanceof Error ? err.message : String(err)}`, err instanceof Error ? err.stack : undefined);
  throw err;
});

self.onmessage = async (e: MessageEvent) => {
  try {
    const mod = await implLoad;
    mod.handle(e);
  } catch (err) {
    self.postMessage({
      _wire: true,
      mcuRef: '',
      solutions: [],
      errors: [{ type: 'error', message: `Solver crashed: ${err instanceof Error ? err.message : String(err)}${err instanceof Error && err.stack ? '\n' + err.stack : ''}` }],
      statistics: { totalCombinations: 0, evaluatedCombinations: 0, validSolutions: 0, solveTimeMs: 0, configCombinations: 0 },
    });
  }
};
