// Tiny shared data layer: one in-memory cache for every backend read.
//
//   const { data, error, status, isFetching, refetch } =
//     useQuery(['portfolio'], () => HelixAPI.portfolio(), { refreshMs: 300000, enabled: live });
//
// - key: string or array; components using the same key share one cache entry
//   and one in-flight request (dedupe).
// - refreshMs: re-fetch on that cadence while the tab is visible.
// - Refetch on window focus / tab visible when the entry is older than staleMs.
// - A failed refetch keeps the last good data (error is set alongside it).
// - invalidate(prefix) marks every key starting with `prefix` stale and re-fetches
//   the ones that are on screen; fetchQuery() reads through the cache outside React.
// - Generations: every entry has a `gen`. invalidate / refetch / setQueryData bump
//   it, and a response only commits if its request's gen is still current. So a
//   request that started before a mutation can never overwrite newer data, and
//   invalidating while such a request is in flight starts a fresh one.

import React from 'react';

const DEFAULT_STALE_MS = 15000;
const entries = new Map();   // hash -> entry

const toKey = (key) => (Array.isArray(key) ? key : [key]);
const hashKey = (key) => JSON.stringify(toKey(key));

const getEntry = (key) => {
  const hash = hashKey(key);
  let e = entries.get(hash);
  if (!e) {
    e = { key: toKey(key), data: undefined, error: null, updatedAt: 0, gen: 0, promise: null, promiseGen: -1, fetcher: null, subs: new Set() };
    entries.set(hash, e);
  }
  return e;
};

const emit = (e) => e.subs.forEach(fn => { try { fn(); } catch (err) { console.error(err); } });

// Start (or join) a fetch for the entry's current generation. A request whose
// generation went stale meanwhile resolves to whatever is cached, without writing.
const run = (e, fetcher) => {
  if (fetcher) e.fetcher = fetcher;
  if (e.promise && e.promiseGen === e.gen) return e.promise;
  if (!e.fetcher) return Promise.resolve(e.data);
  const gen = e.gen;
  const p = Promise.resolve().then(() => e.fetcher()).then(
    data => {
      if (gen !== e.gen) return e.data;
      e.data = data; e.error = null; e.updatedAt = Date.now();
      return data;
    },
    err => {
      if (gen !== e.gen) return e.data;
      e.error = err || new Error('Request failed'); e.updatedAt = Date.now();
      throw e.error;
    },
  ).finally(() => {
    if (e.promise === p) { e.promise = null; e.promiseGen = -1; }
    emit(e);
  });
  e.promise = p;
  e.promiseGen = gen;
  emit(e);   // isFetching flips on
  return p;
};

// Drop whatever is in flight and fetch again.
const refetchEntry = (e) => { e.gen += 1; return run(e); };

const isStale = (e, staleMs) => !e.updatedAt || Date.now() - e.updatedAt >= staleMs;

// Read through the cache (fresh data returned as-is, otherwise fetched).
const fetchQuery = (key, fetcher, { staleMs = DEFAULT_STALE_MS } = {}) => {
  const e = getEntry(key);
  if (fetcher) e.fetcher = fetcher;
  if (!(e.promise && e.promiseGen === e.gen) && e.data !== undefined && !e.error && !isStale(e, staleMs)) return Promise.resolve(e.data);
  return run(e);
};

const prefixMatch = (key, prefix) => prefix.every((part, i) => JSON.stringify(key[i]) === JSON.stringify(part));

// Mark matching entries stale; re-fetch those with mounted subscribers.
const invalidate = (prefix = []) => {
  const pre = toKey(prefix);
  const pending = [];
  entries.forEach(e => {
    if (!prefixMatch(e.key, pre)) return;
    e.gen += 1;
    e.updatedAt = 0;
    if (e.subs.size && e.fetcher) pending.push(run(e).catch(() => {}));
  });
  return Promise.all(pending);
};

const setQueryData = (key, updater) => {
  const e = getEntry(key);
  e.gen += 1;   // an older in-flight response must not overwrite this
  e.data = typeof updater === 'function' ? updater(e.data) : updater;
  e.error = null;
  e.updatedAt = Date.now();
  emit(e);
};

const getQueryData = (key) => entries.get(hashKey(key))?.data;

const useQuery = (key, fetcher, { refreshMs = 0, enabled = true, staleMs = DEFAULT_STALE_MS } = {}) => {
  const hash = hashKey(key);
  const e = getEntry(key);
  if (enabled) e.fetcher = fetcher;   // latest closure wins
  const [, force] = React.useReducer(x => x + 1, 0);

  React.useEffect(() => {
    const entry = getEntry(JSON.parse(hash));
    entry.subs.add(force);
    return () => { entry.subs.delete(force); };
  }, [hash]);

  React.useEffect(() => {
    if (!enabled) return undefined;
    const entry = getEntry(JSON.parse(hash));
    const maybe = (ms) => { if (isStale(entry, ms)) run(entry).catch(() => {}); };
    maybe(staleMs);
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    // Interval ticks only fetch when the entry is due, so several components
    // polling the same key still produce one request per period.
    const iv = refreshMs ? setInterval(() => { if (visible()) maybe(refreshMs * 0.9); }, refreshMs) : null;
    const onFocus = () => { if (visible()) maybe(staleMs); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      if (iv) clearInterval(iv);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [hash, enabled, refreshMs, staleMs]);

  const refetch = React.useCallback(() => refetchEntry(getEntry(JSON.parse(hash))), [hash]);
  const status = !enabled && e.data === undefined ? 'idle'
    : e.data !== undefined ? 'success'
      : e.error ? 'error' : 'loading';
  return {
    data: e.data, error: e.error, status, updatedAt: e.updatedAt,
    isLoading: status === 'loading', isFetching: !!e.promise, refetch,
  };
};

// Minimal mutation helper: tracks pending/error and invalidates keys on success.
const useMutation = (fn, { invalidates = [], onSuccess, onError } = {}) => {
  const [state, setState] = React.useState({ pending: false, error: null });
  const alive = React.useRef(true);
  React.useEffect(() => () => { alive.current = false; }, []);
  const mutate = React.useCallback(async (...args) => {
    setState({ pending: true, error: null });
    try {
      const out = await fn(...args);
      await Promise.all(invalidates.map(k => invalidate(k)));
      if (alive.current) setState({ pending: false, error: null });
      onSuccess && onSuccess(out, ...args);
      return out;
    } catch (err) {
      if (alive.current) setState({ pending: false, error: err });
      if (onError) onError(err, ...args); else throw err;
      return undefined;
    }
  }, [fn, onSuccess, onError, JSON.stringify(invalidates)]);
  return { mutate, isPending: state.pending, error: state.error };
};

// Test/debug helper.
const clearQueryCache = () => entries.clear();

// Non-hook refetch (drops any in-flight request for the key).
const refetchQuery = (key) => refetchEntry(getEntry(key));

export { useQuery, useMutation, fetchQuery, invalidate, refetchQuery, setQueryData, getQueryData, clearQueryCache };
