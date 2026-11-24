// node scripts/test-sync-poller.js — in-flight guard, back-off, one error report, hidden pause.
const assert = require('assert');
const { create } = require('../src/lib/sync-poller.js');

const flush = () => new Promise(resolve => setImmediate(resolve));

const fakeTimers = () => {
  const pending = new Map();
  let id = 0;
  return {
    pending,
    setTimeout: (fn, ms) => { id += 1; pending.set(id, { fn, ms }); return id; },
    clearTimeout: key => pending.delete(key),
    fire() {
      const [key, entry] = [...pending.entries()][0] || [];
      if (!entry) throw new Error('no timer pending');
      pending.delete(key);
      entry.fn();
      return entry.ms;
    },
    nextMs() { const entry = [...pending.values()][0]; return entry ? entry.ms : null; },
  };
};

const fakeDoc = () => {
  const listeners = [];
  return {
    hidden: false,
    addEventListener: (type, fn) => listeners.push(fn),
    removeEventListener: (type, fn) => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    emit() { listeners.forEach(fn => fn()); },
    get listenerCount() { return listeners.length; },
  };
};

(async () => {
  // 1. In-flight guard: timers never stack; poke during a request queues one follow-up.
  {
    const timers = fakeTimers();
    let calls = 0;
    let release;
    const poller = create({ run: () => { calls += 1; return new Promise(r => { release = r; }); }, intervalMs: 1000, timers, document: fakeDoc() });
    poller.start();
    assert.strictEqual(calls, 1);
    assert.strictEqual(timers.pending.size, 0, 'no timer while in flight');
    const p1 = poller.poke();
    const p2 = poller.poke();
    assert.strictEqual(p1, p2, 'pokes during one request share a follow-up');
    assert.strictEqual(calls, 1, 'no overlapping request');
    release(); await flush();
    assert.strictEqual(calls, 2, 'follow-up ran after the first request');
    release(); await p1;
    assert.strictEqual(timers.nextMs(), 1000);
    poller.stop();
    assert.strictEqual(timers.pending.size, 0);
  }

  // 2. Back-off doubles to the cap; error reported once; recovery reported once.
  {
    const timers = fakeTimers();
    const errors = [];
    let recovered = 0;
    let fail = true;
    const poller = create({
      run: async () => { if (fail) throw new Error('down'); },
      intervalMs: 1000, maxIntervalMs: 30000, timers, document: fakeDoc(),
      onError: e => errors.push(e.message), onRecover: () => { recovered += 1; },
    });
    poller.start(); await flush();
    const delays = [timers.nextMs()];
    for (let i = 0; i < 6; i += 1) { timers.fire(); await flush(); delays.push(timers.nextMs()); }
    assert.deepStrictEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    assert.deepStrictEqual(errors, ['down'], 'only the first failure is reported');
    fail = false;
    timers.fire(); await flush();
    assert.strictEqual(recovered, 1);
    assert.strictEqual(timers.nextMs(), 1000, 'back to the normal interval');
    timers.fire(); await flush();
    assert.strictEqual(recovered, 1, 'recovery reported once');
    fail = true;
    timers.fire(); await flush();
    assert.deepStrictEqual(errors, ['down', 'down'], 'a new outage is reported again');
    poller.stop();
  }

  // 3. Hidden tab: no timers; visible again runs immediately.
  {
    const timers = fakeTimers();
    const doc = fakeDoc();
    let calls = 0;
    const poller = create({ run: async () => { calls += 1; }, intervalMs: 1000, timers, document: doc });
    poller.start(); await flush();
    assert.strictEqual(calls, 1);
    doc.hidden = true; doc.emit();
    assert.strictEqual(timers.pending.size, 0, 'paused while hidden');
    doc.hidden = false; doc.emit(); await flush();
    assert.strictEqual(calls, 2, 'runs as soon as the tab is visible');
    assert.strictEqual(timers.nextMs(), 1000);
    poller.stop();
    assert.strictEqual(doc.listenerCount, 0, 'stop removes the visibility listener');
    doc.emit(); await flush();
    assert.strictEqual(calls, 2);
  }

  // 4. Interval may be a function (Sync slows down while its page is closed).
  {
    const timers = fakeTimers();
    let slow = false;
    const poller = create({ run: async () => {}, intervalMs: () => (slow ? 10000 : 1500), timers, document: fakeDoc() });
    poller.start(); await flush();
    assert.strictEqual(timers.nextMs(), 1500);
    slow = true; timers.fire(); await flush();
    assert.strictEqual(timers.nextMs(), 10000);
    poller.stop();
  }

  // 5. poke() while stopped runs once and schedules nothing.
  {
    const timers = fakeTimers();
    let calls = 0;
    const poller = create({ run: async () => { calls += 1; }, intervalMs: 1000, timers, document: fakeDoc() });
    await poller.poke();
    assert.strictEqual(calls, 1);
    assert.strictEqual(timers.pending.size, 0);
  }

  console.log('sync-poller: all checks passed');
})().catch(error => { console.error(error); process.exit(1); });
