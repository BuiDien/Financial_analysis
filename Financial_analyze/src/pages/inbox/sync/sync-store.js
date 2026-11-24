// Sync coordinator store — module-level, NOT React state.
//
// This machine (the Mac/Core) is the coordinator: it listens, and a worker laptop
// dials IN with a pairing code, receives OCR Inbox PDFs, and returns structured
// statement rows. LIVE mode drives backend/app/routes/sync.py over HelixAPI.sync*
// (GET /api/sync/status, POST /api/sync/pair-code, dispatch). Workers connect to
// HelixAPI.syncWsUrl() ( ws://<base>/ws/ocr ) with the pairing code.
// OFFLINE: nothing is simulated — the page says the backend is offline.
//
// NOTE (OCR_PROTOCOL alignment, follow-up): PDF transfer uses binary chunks.
// Result rows still use tracker `id`; moving to TT200 Mã số `code` belongs to
// the canonical document/OCR phases in PLAN.md.

import * as SyncPoller from '../../../lib/sync-poller.js';
import { HelixAPI } from '../../../api-client.jsx';
import { registerCompanyFromJob } from './sync-company.js';

const SYNC_JOBS_KEY = 'helix_sync_jobs_v1';


// Module-level store — NOT React state. app.jsx swaps in a different top-level
// component for every route (Inbox → Sync is one tab among several), so
// switching away from Sync fully unmounts PageSync and any useState/useRef in
// it is gone. "Listening" needs to survive that (the backend WS coordinator
// doesn't care about the UI at all — it's always live), so connection state,
// and the live-poll interval live here instead, and the
// component just subscribes via React.useSyncExternalStore.
export const SyncStore = (() => {
  let state = {
    listening: false,
    pairCode: '———',         // real code arrives with the first status poll
    liveHost: null,          // real LAN IP, reported by the backend once polling starts
    workers: [],
    jobs: (() => {
      try { return JSON.parse(localStorage.getItem(SYNC_JOBS_KEY) || '[]'); } catch { return []; }
    })(),
    log: [],
  };
  const listeners = new Set();
  const emit = () => listeners.forEach(fn => fn());
  const set = (patch) => {
    state = { ...state, ...patch };
    if ('jobs' in patch) {
      try { localStorage.setItem(SYNC_JOBS_KEY, JSON.stringify(state.jobs)); } catch {}
    }
    emit();
  };

  const isLive = () => !!HelixAPI?.live;
  // Re-render subscribers the moment live/offline status flips, not just on
  // the next unrelated state change (HelixAPI.detect() can resolve well
  // after this store was created).
  if (HelixAPI) HelixAPI.onStatusChange(() => emit());

  const addLog = (kind, text) => {
    set({ log: [{ id: Date.now() + Math.random(), kind, text, ts: new Date() }, ...state.log].slice(0, 60) });
  };

  const getWsUrl = () => {
    // Live mode initially shows the configured API base (often "localhost")
    // — not reachable from a worker laptop. Once a poll tick reports the
    // backend's real LAN IP, swap the hostname in for it.
    if (isLive()) {
      return state.liveHost
        ? HelixAPI.syncWsUrl().replace(/:\/\/[^/:]+/, `://${state.liveHost}`)
        : HelixAPI.syncWsUrl();
    }
    return HelixAPI.syncWsUrl();
  };

  let poller = null;

  // Throws on failure so the poller can back off; logs go out once per outage.
  const pollTick = async () => {
    const s = await HelixAPI.syncStatus();
    const previousById = Object.fromEntries(state.jobs.map(job => [job.id, job]));
    const transitionLogs = [];
    const patch = { workers: (s.workers || []).map(w => ({
      id: w.id, name: w.name, ip: w.ip, status: w.status, done: w.done || 0,
    })) };
    if (s.pair_code) patch.pairCode = s.pair_code;
    if (s.host) patch.liveHost = s.host;
    const appliedMap = {};
    state.jobs.forEach(j => { if (j.applied) appliedMap[j.id] = true; });
    patch.jobs = (s.jobs || []).map(j => ({
      id: j.id, filingId: j.filingId, inboxItemId: j.inboxItemId, kind: j.kind,
      filename: j.filename, ticker: j.ticker,
      worker: j.worker, status: j.status, progress: j.progress || 0,
      rows: j.rows || null, rowCount: j.rowCount ?? j.rows?.length ?? null,
      reviewId: j.reviewId, completedAt: j.completedAt,
      error: j.error, applied: appliedMap[j.id] || false,
    }));
    set(patch);
    patch.jobs.forEach(job => {
      const previous = previousById[job.id];
      if (!previous || previous.status === job.status) return;
      if (job.status === 'parsing') {
        transitionLogs.push(['worker', `${job.worker || 'Worker'} started processing "${job.filename}" (job ${job.id})`]);
      } else if (job.status === 'done') {
        const rows = job.rowCount == null ? '' : ` · ${job.rowCount} rows`;
        const review = job.reviewId == null ? '' : ` · review ${job.reviewId} ready`;
        transitionLogs.push(['in', `${job.worker || 'Worker'} completed "${job.filename}"${rows}${review} (job ${job.id})`]);
      } else if (['failed', 'error'].includes(job.status)) {
        transitionLogs.push(['error', `${job.worker || 'Worker'} failed "${job.filename}" (job ${job.id}): ${job.error || 'unknown error'}`]);
      } else if (job.status === 'held') {
        transitionLogs.push(['worker', `${job.worker || 'Worker'} held "${job.filename}" (job ${job.id})`]);
      } else if (job.status === 'stopped') {
        transitionLogs.push(['worker', `${job.worker || 'Worker'} stopped "${job.filename}" (job ${job.id})`]);
      }
    });
    transitionLogs.forEach(([kind, text]) => addLog(kind, text));
  };
  // Fast while the Sync page is open, slower in the background (job transitions still get
  // logged), paused in a hidden tab, never overlapping, backing off to 30s when unreachable.
  const createStatusPoller = () => SyncPoller.create({
    run: pollTick,
    intervalMs: () => (listeners.size ? 1500 : 10000),
    maxIntervalMs: 30000,
    onError: e => addLog('error', `Coordinator unreachable: ${e.message || e} — retrying with back-off`),
    onRecover: () => addLog('sys', 'Coordinator reachable again.'),
  });

  // ── Start / stop listening ─────────────────────────────────
  const toggleListen = () => {
    if (state.listening) {
      set({ listening: false, workers: [] });
      addLog('sys', 'Stopped listening. Workers disconnected.');
      if (poller) { poller.stop(); poller = null; }
      return;
    }
    if (!isLive()) { addLog('error', 'Backend offline — start with scripts/run.sh, then start listening.'); return; }
    set({ listening: true });
    addLog('sys', `Listening on ${getWsUrl()}`);
    addLog('sys', `Pairing code ${state.pairCode} — share with the worker laptop`);

    addLog('sys', 'Live: coordinator running on the backend. Waiting for a worker to pair…');
    poller = createStatusPoller();
    poller.start();
  };

  const regenCode = async () => {
    if (!isLive()) { addLog('error', 'Backend offline — cannot regenerate the pairing code.'); return; }
    try {
      const r = await HelixAPI.syncRegenCode();
      if (r && r.pair_code) set({ pairCode: r.pair_code });
      addLog('sys', 'Pairing code regenerated.');
    } catch (e) { addLog('error', `Could not regenerate code: ${e.message || e}`); }
  };

  // ── Dispatch an OCR Inbox PDF to a worker ──────────────────
  const dispatch = async (filing) => {
    if (!isLive()) { addLog('error', 'Backend offline — start with scripts/run.sh to dispatch.'); return; }
    try {
      const r = filing.status === 'failed'
        ? await HelixAPI.ocrInboxRetry(filing.id)
        : await HelixAPI.ocrInboxRun(filing.id);
      addLog('out', `Dispatched "${filing.filename}" from OCR Inbox → worker${r.job_id ? ` (job ${r.job_id})` : ''}`);
    } catch (e) {
      addLog('error', `Dispatch failed: ${e.message || e}`);
    }
    // the poll tick reflects job progress + result
  };

  // Apply returned data into that filing's tracker
  const applyResult = (job) => {
    if (!job.rows) return;
    const key = `helix_reader_tracker_v1_${job.filingId}`;
    let tracker;
    try { tracker = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
    if (!tracker) tracker = { income: [], balance: [], cashflow: [], flags: [] };
    job.rows.forEach(r => {
      const arr = tracker[r.section] || (tracker[r.section] = []);
      const existing = arr.find(x => x.id === r.id);
      if (existing) { existing.curr = r.curr; existing.prev = r.prev; }
      else arr.push({ id: r.id, metric: r.metric, curr: r.curr, prev: r.prev, unit: '$M', notes: `Sync · ${job.worker} · p.${r.page}` });
    });
    localStorage.setItem(key, JSON.stringify(tracker));
    if (isLive() && typeof job.filingId === 'number') {
      HelixAPI.saveTracker(job.filingId, tracker).catch(() => {});
    }
    set({ jobs: state.jobs.map(x => x.id === job.id ? { ...x, applied: true } : x) });
    addLog('sys', `Applied ${job.rows.length} metrics into ${job.ticker} tracker`);
  };

  // Step 2 of 2 — confirm: apply data into the tracker AND register the
  // company so it shows up in the Financial Statements list.
  const confirmResult = (job) => {
    applyResult(job);
    const added = registerCompanyFromJob(job);
    if (added) addLog('sys', `${job.ticker} added to the Financial Statements company list`);
    return added;
  };

  const controlJob = async (job, action) => {
    if (!isLive()) { addLog('error', 'Job controls require the live backend.'); return false; }
    try {
      await HelixAPI.syncControlJob(job.id, action);
      set({ jobs: state.jobs.map(x => x.id === job.id
        ? { ...x, status: action === 'hold' ? 'holding' : 'stopping' }
        : x) });
      addLog('out', `${action === 'hold' ? 'Hold' : 'Stop'} sent to ${job.worker} for "${job.filename}"`);
      return true;
    } catch (e) {
      addLog('error', `${action === 'hold' ? 'Hold' : 'Stop'} failed: ${e.message || e}`);
      return false;
    }
  };

  const clearDone = () => set({ jobs: state.jobs.filter(x => x.status !== 'done') });

  return {
    subscribe: (fn) => {
      listeners.add(fn);
      // Coming back to the page: refresh now instead of waiting out the background interval.
      if (listeners.size === 1 && poller) poller.poke();
      return () => listeners.delete(fn);
    },
    getSnapshot: () => state,
    isLive, getWsUrl, addLog, toggleListen, regenCode, dispatch, applyResult, confirmResult, controlJob, clearDone,
  };
})();
