// node scripts/test-query.mjs — src/lib/query.js cache: dedupe, generations
// (a request started before invalidate/setQueryData/refetch never overwrites
// newer data), error handling, prefix invalidation.
import assert from 'node:assert/strict';
import { fetchQuery, invalidate, refetchQuery, setQueryData, getQueryData, clearQueryCache } from '../src/lib/query.js';

// A fetcher whose calls resolve manually, in any order.
const deferredFetcher = () => {
  const calls = [];
  const fn = () => new Promise((resolve, reject) => calls.push({ resolve, reject }));
  return { fn, calls };
};
const flush = () => new Promise(r => setImmediate(r));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('concurrent reads of one key share one request', async () => {
  clearQueryCache();
  const f = deferredFetcher();
  const a = fetchQuery(['k'], f.fn); const b = fetchQuery(['k'], f.fn);
  await flush();
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve(1);
  assert.deepEqual(await Promise.all([a, b]), [1, 1]);
  assert.equal(await fetchQuery(['k'], f.fn), 1, 'fresh data is served from cache');
  assert.equal(f.calls.length, 1);
});

test('invalidate while a request is in flight starts a fresh one; the stale response is discarded', async () => {
  clearQueryCache();
  const f = deferredFetcher();
  const stale = fetchQuery(['alerts', 'list'], f.fn);
  await flush();
  invalidate(['alerts']);                 // no subscribers: marks stale only
  const fresh = fetchQuery(['alerts', 'list'], f.fn);
  await flush();
  assert.equal(f.calls.length, 2, 'a second request was started');
  f.calls[1].resolve(['new']);            // fresh one lands first
  assert.deepEqual(await fresh, ['new']);
  f.calls[0].resolve(['old']);            // then the stale one
  await stale;
  assert.deepEqual(getQueryData(['alerts', 'list']), ['new'], 'old response did not overwrite');
});

test('setQueryData during an in-flight request wins over that request', async () => {
  clearQueryCache();
  const f = deferredFetcher();
  const inflight = fetchQuery(['alerts', 'list'], f.fn);
  await flush();
  setQueryData(['alerts', 'list'], [{ id: 'a1', triggered: true }]);   // e.g. monitor PATCH result
  f.calls[0].resolve([{ id: 'a1', triggered: false }]);
  await inflight;
  assert.deepEqual(getQueryData(['alerts', 'list']), [{ id: 'a1', triggered: true }]);
});

test('refetch after a mutation does not join the pre-mutation request', async () => {
  clearQueryCache();
  const f = deferredFetcher();
  const before = fetchQuery(['portfolio'], f.fn);
  await flush();
  const after = refetchQuery(['portfolio']);
  await flush();
  assert.equal(f.calls.length, 2);
  assert.notEqual(before, after);
  f.calls[0].resolve({ rev: 1 });          // pre-transaction state arrives late…
  f.calls[1].resolve({ rev: 2 });
  assert.deepEqual(await after, { rev: 2 });
  await before;
  assert.deepEqual(getQueryData(['portfolio']), { rev: 2 });
  // …even when the old one lands last
  const c = refetchQuery(['portfolio']); await flush();
  const d = refetchQuery(['portfolio']); await flush();
  f.calls[3].resolve({ rev: 4 }); await d;
  f.calls[2].resolve({ rev: 3 }); await c;
  assert.deepEqual(getQueryData(['portfolio']), { rev: 4 });
});

test('a failed request keeps the last good data; a stale failure is ignored', async () => {
  clearQueryCache();
  const f = deferredFetcher();
  const first = fetchQuery(['news'], f.fn); await flush();
  f.calls[0].resolve(['n1']); await first;
  const failing = refetchQuery(['news']); await flush();
  f.calls[1].reject(new Error('boom'));
  await assert.rejects(failing, /boom/);
  assert.deepEqual(getQueryData(['news']), ['n1']);
  const stale = refetchQuery(['news']); await flush();
  setQueryData(['news'], ['n2']);
  f.calls[2].reject(new Error('late'));
  assert.deepEqual(await stale, ['n2'], 'stale failure resolves to the current data');
});

test('invalidate matches by key prefix only', async () => {
  clearQueryCache();
  setQueryData(['alerts', 'list'], [1]);
  setQueryData(['alerts-x'], [2]);
  setQueryData(['jobs', { status: 'running' }], [3]);
  const f = deferredFetcher();
  await invalidate(['alerts']);
  // alerts/list is now stale → fetchQuery refetches; alerts-x is fresh → served from cache
  const p = fetchQuery(['alerts', 'list'], f.fn); await flush();
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve([9]); await p;
  assert.deepEqual(await fetchQuery(['alerts-x'], f.fn), [2]);
  assert.equal(f.calls.length, 1);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { failed += 1; console.log(`not ok - ${name}\n  ${e.stack}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
