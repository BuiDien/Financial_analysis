// Background poller shared by the Sync and OCR Inbox pages. Plain JS (no JSX) so it
// is importable by the bundle and by node (scripts/test-sync-poller.js).
//
//   const poller = SyncPoller.create({ run, intervalMs, maxIntervalMs, onError, onRecover });
//   poller.start(); poller.poke(); poller.stop();
//
// - Never overlaps: a tick is skipped while the previous request is still in flight.
//   poke() during a request queues one follow-up run (so data fetched after an
//   action is never stale) and resolves when that run finishes.
// - Failures back off exponentially (interval × 2^n, capped at maxIntervalMs) and are
//   reported once: onError on the first failure, onRecover on the next success.
// - Pauses while document.hidden; resumes with an immediate run when visible again.
// - intervalMs may be a function, read before every wait.
  function create(options) {
    const opts = options || {};
    const run = opts.run;
    const doc = opts.document !== undefined ? opts.document : (typeof document !== 'undefined' ? document : null);
    const timers = opts.timers || {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: id => clearTimeout(id),
    };
    const baseInterval = () => {
      const value = typeof opts.intervalMs === 'function' ? opts.intervalMs() : opts.intervalMs;
      return Math.max(1, Number(value) || 2000);
    };
    const maxInterval = () => Math.max(baseInterval(), Number(opts.maxIntervalMs) || 30000);

    let running = false;
    let timer = null;
    let inFlight = null;
    let followUp = null;
    let failures = 0;

    const hidden = () => Boolean(opts.pauseWhenHidden !== false && doc && doc.hidden);
    const nextDelay = () => (failures
      ? Math.min(maxInterval(), baseInterval() * Math.pow(2, failures))
      : baseInterval());
    const clearTimer = () => { if (timer !== null) { timers.clearTimeout(timer); timer = null; } };
    const schedule = () => {
      clearTimer();
      if (!running || hidden()) return;
      timer = timers.setTimeout(() => { timer = null; runNow(); }, nextDelay());
    };

    const execute = async () => {
      try {
        await run();
        if (failures) {
          failures = 0;
          if (opts.onRecover) opts.onRecover();
        }
      } catch (error) {
        failures += 1;
        if (failures === 1 && opts.onError) opts.onError(error);
      }
    };

    function runNow() {
      if (inFlight) {
        if (!followUp) followUp = inFlight.then(() => { followUp = null; return runNow(); });
        return followUp;
      }
      clearTimer();
      inFlight = execute().then(() => { inFlight = null; schedule(); });
      return inFlight;
    }

    const onVisibility = () => {
      if (!running) return;
      if (hidden()) clearTimer();
      else if (!inFlight) runNow();
    };

    return {
      start() {
        if (running) return;
        running = true;
        if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisibility);
        if (hidden()) return;
        runNow();
      },
      stop() {
        running = false;
        clearTimer();
        if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
      },
      // Run now (or right after the request in flight); resolves when that run is done.
      poke: () => runNow(),
      get failures() { return failures; },
      get running() { return running; },
      get inFlight() { return Boolean(inFlight); },
      nextDelay,
    };
  }

  const api = { create };

export { create };
export default api;
