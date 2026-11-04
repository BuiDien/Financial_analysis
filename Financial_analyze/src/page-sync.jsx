// Sync — distributed OCR coordinator.
//
// This machine (the Mac/Core) is the coordinator: it listens, and a worker
// laptop dials IN with a pairing code, receives OCR Inbox PDFs, and returns
// structured statement rows. This page is the control panel.
//
// LIVE mode (backend reachable): drives backend/app/routes/sync.py over
//   HelixAPI.sync* — GET /api/sync/status (poll workers+jobs), POST /api/sync/pair-code,
//   POST /api/sync/dispatch/{filingId}. Workers connect to HelixAPI.syncWsUrl()
//   ( ws://<base>/ws/ocr ) with the pairing code.
// OFFLINE mode (no backend): a built-in simulation runs so the flow is demoable.
//
// NOTE (OCR_PROTOCOL alignment, follow-up): PDF transfer uses binary chunks.
// Result rows still use tracker `id`; moving to TT200 Mã số `code` belongs to
// the canonical document/OCR phases in PLAN.md.

const SYNC_JOBS_KEY = 'helix_sync_jobs_v1';

const genPairCode = () => {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return s.slice(0, 3) + '-' + s.slice(3);
};

const localIP = () => '192.168.1.' + (20 + Math.floor(Math.random() * 80));

// Sample OCR result rows a worker would return (matches OCR dialog schema)
const WORKER_RESULT_ROWS = [
  { id: 'rev',   section: 'income',   metric: 'Revenue',            curr: '130497', prev: '60922', page: 49, confidence: 99 },
  { id: 'gp',    section: 'income',   metric: 'Gross Profit',       curr: '97997',  prev: '44301', page: 49, confidence: 98 },
  { id: 'oi',    section: 'income',   metric: 'Operating Income',   curr: '81589',  prev: '32972', page: 49, confidence: 97 },
  { id: 'ni',    section: 'income',   metric: 'Net Income',         curr: '72880',  prev: '29760', page: 49, confidence: 99 },
  { id: 'ta',    section: 'balance',  metric: 'Total Assets',       curr: '111601', prev: '65728', page: 51, confidence: 96 },
  { id: 'te',    section: 'balance',  metric: 'Total Equity',       curr: '79292',  prev: '42978', page: 52, confidence: 95 },
  { id: 'ocf',   section: 'cashflow', metric: 'Operating Cash Flow',curr: '64089',  prev: '28090', page: 53, confidence: 98 },
  { id: 'fcf',   section: 'cashflow', metric: 'Free Cash Flow',     curr: '60853',  prev: '27021', page: 53, confidence: 94 },
];

// Module-level store — NOT React state. app.jsx swaps in a different top-level
// component for every tab (`{home: PageHome, ..., sync: PageSync}[page]`), so
// switching away from Sync fully unmounts PageSync and any useState/useRef in
// it is gone. "Listening" needs to survive that (the backend WS coordinator
// doesn't care about the UI at all — it's always live), so connection state,
// the live-poll interval, and offline-demo timers live here instead, and the
// component just subscribes via React.useSyncExternalStore.
const SyncStore = (() => {
  let state = {
    listening: false,
    pairCode: genPairCode(),
    liveHost: null,          // real LAN IP, reported by the backend once polling starts
    host: localIP(),         // fake IP for the offline demo, generated once
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

  const isLive = () => !!window.HelixAPI?.live;
  // Re-render subscribers the moment live/offline status flips, not just on
  // the next unrelated state change (HelixAPI.detect() can resolve well
  // after this store was created).
  if (window.HelixAPI) window.HelixAPI.onStatusChange(() => emit());

  const addLog = (kind, text) => {
    set({ log: [{ id: Date.now() + Math.random(), kind, text, ts: new Date() }, ...state.log].slice(0, 60) });
  };

  const getWsUrl = () => {
    // Live mode initially shows the configured API base (often "localhost")
    // — not reachable from a worker laptop. Once a poll tick reports the
    // backend's real LAN IP, swap the hostname in for it.
    if (isLive()) {
      return state.liveHost
        ? window.HelixAPI.syncWsUrl().replace(/:\/\/[^/:]+/, `://${state.liveHost}`)
        : window.HelixAPI.syncWsUrl();
    }
    return `ws://${state.host}:8000/ws/ocr`;
  };

  let pollHandle = null;
  let offlineTimers = [];

  const pollTick = async () => {
    try {
      const s = await window.HelixAPI.syncStatus();
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
    } catch (e) { /* keep last state; backend may be momentarily unreachable */ }
  };

  // ── Start / stop listening ─────────────────────────────────
  const toggleListen = () => {
    if (state.listening) {
      set({ listening: false, workers: [] });
      addLog('sys', 'Stopped listening. Workers disconnected.');
      if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
      offlineTimers.forEach(clearTimeout);
      offlineTimers = [];
      return;
    }
    set({ listening: true });
    addLog('sys', `Listening on ${getWsUrl()}`);
    addLog('sys', `Pairing code ${state.pairCode} — share with the worker laptop`);

    if (isLive()) {
      addLog('sys', 'Live: coordinator running on the backend. Waiting for a worker to pair…');
      pollTick();
      pollHandle = setInterval(pollTick, 1500);
      return;
    }

    // Simulate a worker connecting shortly after (offline demo)
    const t = setTimeout(() => {
      const w = { id: 'w1', name: "Dien's MacBook Pro", ip: localIP(), status: 'idle', done: 0, connectedAt: new Date() };
      set({ workers: [w] });
      addLog('worker', `${w.name} connected from ${w.ip}`);
    }, 2200);
    offlineTimers.push(t);
  };

  const regenCode = async () => {
    if (isLive()) {
      try {
        const r = await window.HelixAPI.syncRegenCode();
        if (r && r.pair_code) set({ pairCode: r.pair_code });
        addLog('sys', 'Pairing code regenerated.');
        return;
      } catch (e) { addLog('error', `Could not regenerate code: ${e.message || e}`); return; }
    }
    set({ pairCode: genPairCode() });
    addLog('sys', 'Pairing code regenerated.');
  };

  // ── Dispatch an OCR Inbox PDF to a worker ──────────────────
  const dispatch = async (filing) => {
    if (isLive()) {
      try {
        const r = filing.status === 'failed'
          ? await window.HelixAPI.ocrInboxRetry(filing.id)
          : await window.HelixAPI.ocrInboxRun(filing.id);
        addLog('out', `Dispatched "${filing.filename}" from OCR Inbox → worker${r.job_id ? ` (job ${r.job_id})` : ''}`);
      } catch (e) {
        addLog('error', `Dispatch failed: ${e.message || e}`);
      }
      return;  // the poll tick reflects job progress + result
    }

    // Offline simulation
    const worker = state.workers.find(w => w.status === 'idle') || state.workers[0];
    if (!worker) { addLog('error', 'No worker connected. Start listening and pair a laptop first.'); return; }
    const job = {
      id: 'job_' + Date.now().toString(36),
      filingId: filing.id,
      filename: filing.name,
      ticker: filing.ticker,
      worker: worker.name,
      status: 'sent',
      progress: 0,
      rows: null,
      sentAt: new Date(),
    };
    set({ jobs: [job, ...state.jobs], workers: state.workers.map(w => w.id === worker.id ? { ...w, status: 'busy' } : w) });
    addLog('out', `Sent "${filing.name}" → ${worker.name}`);

    const t1 = setTimeout(() => {
      set({ jobs: state.jobs.map(x => x.id === job.id ? { ...x, status: 'parsing' } : x) });
      addLog('worker', `${worker.name} parsing ${filing.ticker}…`);
      let p = 0;
      const iv = setInterval(() => {
        p += 12 + Math.random() * 10;
        if (p >= 100) { p = 100; clearInterval(iv); }
        set({ jobs: state.jobs.map(x => x.id === job.id ? { ...x, progress: Math.min(100, Math.round(p)) } : x) });
      }, 260);
      offlineTimers.push(iv);
    }, 900);
    const t2 = setTimeout(() => {
      set({
        jobs: state.jobs.map(x => x.id === job.id ? { ...x, status: 'done', progress: 100, rows: WORKER_RESULT_ROWS, doneAt: new Date() } : x),
        workers: state.workers.map(w => w.id === worker.id ? { ...w, status: 'idle', done: w.done + 1 } : w),
      });
      addLog('in', `${worker.name} returned ${WORKER_RESULT_ROWS.length} metrics for ${filing.ticker}`);
    }, 4200);
    offlineTimers.push(t1, t2);
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
      window.HelixAPI.saveTracker(job.filingId, tracker).catch(() => {});
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
      await window.HelixAPI.syncControlJob(job.id, action);
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
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getSnapshot: () => state,
    isLive, getWsUrl, addLog, toggleListen, regenCode, dispatch, applyResult, confirmResult, controlJob, clearDone,
  };
})();

const PageSync = ({ setPage }) => {
  const { listening, pairCode, workers, jobs, log } = React.useSyncExternalStore(SyncStore.subscribe, SyncStore.getSnapshot);
  const [inboxItems, setInboxItems] = React.useState([]);
  const [inboxLoading, setInboxLoading] = React.useState(true);
  const [verifyJob, setVerifyJob] = React.useState(null);

  const refreshInbox = React.useCallback(async () => {
    if (!window.HelixAPI?.live) { setInboxLoading(false); return; }
    try { setInboxItems(await window.HelixAPI.ocrInbox()); }
    catch (e) { SyncStore.addLog('error', `Could not load OCR Inbox: ${e.message || e}`); }
    finally { setInboxLoading(false); }
  }, []);

  React.useEffect(() => {
    refreshInbox();
    const timer = setInterval(refreshInbox, 1800);
    return () => clearInterval(timer);
  }, [refreshInbox]);

  const wsUrl = SyncStore.getWsUrl();
  const toggleListen = SyncStore.toggleListen;
  const regenCode = SyncStore.regenCode;
  const dispatch = SyncStore.dispatch;
  const controlJob = SyncStore.controlJob;
  const clearDone = SyncStore.clearDone;

  const confirmResult = (job) => {
    SyncStore.confirmResult(job);
    window.toast && window.toast(`${job.ticker} verified & added to companies`, { type: 'success' });
    setVerifyJob(null);
  };

  const doneJobs = jobs.filter(j => j.status === 'done');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Sync.</h1>
          <p className="page-sub">Hand off OCR Inbox PDFs to a worker laptop — parsed statement data comes back for review automatically</p>
        </div>
        <div className="row">
          <button className={`btn ${listening ? '' : 'btn-primary'}`} onClick={toggleListen}>
            <Icon name={listening ? 'close' : 'wifi'} size={12} /> {listening ? 'Stop listening' : 'Start listening'}
          </button>
        </div>
      </div>

      {/* Connection status band */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: 1, background: 'var(--border)' }}>
          {/* This machine */}
          <div style={{ background: 'var(--bg-elev)', padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <Icon name="server" size={16} style={{ color: 'var(--accent)' }} />
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>This machine · Coordinator</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: listening ? 'var(--pos)' : 'var(--text-subtle)', animation: listening ? 'pulse 2s infinite' : 'none' }}></span>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{listening ? 'Listening for workers' : 'Offline'}</span>
            </div>
            <div className="num" style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ padding: '3px 8px', background: 'var(--bg-sunken)', borderRadius: 4 }}>{wsUrl}</span>
              <button className="icon-btn" style={{ width: 26, height: 26 }} title="Copy address"
                onClick={() => { navigator.clipboard?.writeText(wsUrl); SyncStore.addLog('sys', 'Address copied to clipboard'); }}>
                <Icon name="news" size={12} />
              </button>
            </div>
          </div>

          {/* Pairing code */}
          <div style={{ background: 'var(--bg-elev)', padding: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 10 }}>Pairing code</div>
            <div className="num" style={{ fontSize: 28, fontWeight: 700, letterSpacing: '0.1em', color: listening ? 'var(--text)' : 'var(--text-subtle)' }}>
              {pairCode}
            </div>
            <button className="card-action" style={{ marginTop: 8 }} onClick={regenCode}>
              <Icon name="sync" size={11} /> Regenerate
            </button>
          </div>

          {/* Workers connected */}
          <div style={{ background: 'var(--bg-elev)', padding: 18 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 10 }}>Workers</div>
            <div className="num" style={{ fontSize: 28, fontWeight: 700 }}>{workers.length}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
              {workers.filter(w => w.status === 'idle').length} idle · {workers.filter(w => w.status === 'busy').length} busy
            </div>
          </div>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 20 }}>
        {/* Dispatch OCR Inbox PDFs */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Dispatch a Filing for OCR</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{inboxItems.length} in OCR Inbox</span>
          </div>
          <div className="card-body flush">
            {inboxLoading ? (
              <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading OCR Inbox…</div>
            ) : inboxItems.length === 0 ? (
              <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                No PDFs in OCR Inbox yet. Upload a PDF there, then dispatch it here.
                <div style={{ marginTop: 12 }}><button className="btn" onClick={() => setPage('ocr-inbox')}>Go to OCR Inbox</button></div>
              </div>
            ) : inboxItems.map(item => {
              const pending = jobs.find(j => j.inboxItemId === item.id && !['done', 'failed', 'held', 'stopped'].includes(j.status));
              const canDispatch = ['uploaded', 'held', 'failed'].includes(item.status);
              return (
                <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.filename}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-subtle)', textTransform: 'capitalize' }}>{item.pages} pages · {item.status.replaceAll('_', ' ')}</div>
                  </div>
                  {canDispatch ? (
                    <button className="btn" disabled={!listening || !workers.length || !!pending}
                      onClick={async () => { await dispatch(item); await refreshInbox(); }}
                      style={(!listening || !workers.length || !!pending) ? { opacity: 0.5 } : undefined}>
                      {pending ? 'In queue…' : <><Icon name="sync" size={12} /> {item.status === 'failed' ? 'Retry OCR' : item.status === 'held' ? 'Resume OCR' : 'Send to worker'}</>}
                    </button>
                  ) : item.review ? (
                    <button className="btn" onClick={() => setPage('ocr-inbox')}>Open in Inbox</button>
                  ) : <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{item.status.replaceAll('_', ' ')}</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Connected workers */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Connected Workers</h3>
          </div>
          <div className="card-body flush">
            {workers.length === 0 ? (
              <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                {listening ? 'Waiting for a worker to pair…' : 'Start listening, then connect a worker laptop with the pairing code.'}
              </div>
            ) : workers.map(w => (
              <div key={w.id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 12, padding: '14px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--bg-sunken)', display: 'grid', placeItems: 'center' }}>
                  <Icon name="laptop" size={18} style={{ color: 'var(--accent)' }} />
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{w.name}</div>
                  <div className="num" style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{w.ip} · {w.done} parsed</div>
                </div>
                <span className="pill" style={{ background: w.status === 'busy' ? 'var(--accent-bg)' : 'var(--pos-bg)', color: w.status === 'busy' ? 'var(--accent)' : 'var(--pos)' }}>
                  {w.status === 'busy' ? '● Working' : '● Idle'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Active jobs pipeline */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <h3 className="card-title">Job Pipeline</h3>
          {doneJobs.length > 0 && <button className="card-action" onClick={clearDone}>Clear completed</button>}
        </div>
        <div className="card-body flush">
          {jobs.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              No jobs yet. Dispatch a filing above and watch it flow: sent → parsing → returned.
            </div>
          ) : (
            <table className="table sync-jobs-table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Worker</th>
                  <th style={{ width: 200 }}>Status</th>
                  <th className="right">Metrics</th>
                  <th className="right" style={{ width: 190 }}></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(j => (
                  <tr key={j.id} style={{ cursor: 'default' }}>
                    <td>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{j.ticker || (j.kind === 'inbox' ? 'OCR Inbox' : '—')}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-subtle)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{j.filename}</span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{j.worker}</td>
                    <td>
                      {j.status === 'done' ? (
                        <span className="pill pill-pos">✓ Returned</span>
                      ) : ['error', 'failed'].includes(j.status) ? (
                        <span className="pill pill-neg">Failed</span>
                      ) : j.status === 'held' ? (
                        <span className="pill">Held</span>
                      ) : j.status === 'stopped' ? (
                        <span className="pill pill-neg">Stopped</span>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ flex: 1, height: 6, background: 'var(--bg-sunken)', borderRadius: 3, overflow: 'hidden', minWidth: 80 }}>
                            <div style={{ height: '100%', width: `${j.progress}%`, background: 'var(--accent)', borderRadius: 3, transition: 'width 250ms' }}></div>
                          </div>
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', textTransform: 'capitalize', minWidth: 54 }}>{j.status}</span>
                        </div>
                      )}
                    </td>
                    <td className="right num" style={{ color: 'var(--text-muted)' }}>{j.rows ? j.rows.length : '—'}</td>
                    <td className="right">
                      {['sent', 'parsing'].includes(j.status) && j.kind === 'inbox' && (
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
                          <button className="btn" onClick={() => controlJob(j, 'hold')}>Hold</button>
                          <button className="btn" onClick={async () => {
                            const confirmed = await window.askConfirm({ title: 'Stop OCR job', message: `Stop processing "${j.filename}"? You can send it again later.`, confirmText: 'Stop', danger: true });
                            if (confirmed) controlJob(j, 'stop');
                          }}>Stop</button>
                        </div>
                      )}
                      {['holding', 'stopping'].includes(j.status) && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Sending command…</span>}
                      {j.status === 'held' && j.kind === 'inbox' && (
                        <button className="btn btn-primary" onClick={async () => {
                          const item = inboxItems.find(x => x.id === j.inboxItemId);
                          if (item) { await dispatch(item); await refreshInbox(); }
                        }}>Resume</button>
                      )}
                      {j.status === 'done' && (
                        j.kind === 'inbox'
                          ? <button className="btn btn-primary" onClick={() => setPage('ocr-inbox')}>Review in Inbox</button>
                          : j.applied
                          ? <span style={{ fontSize: 11, color: 'var(--pos)', fontWeight: 600 }}>Applied ✓</span>
                          : <button className="btn btn-primary" onClick={() => setVerifyJob(j)}>Verify data</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Two col: how-to + activity log */}
      <div className="grid-2">
        <div className="card">
          <div className="card-header"><h3 className="card-title">Connect a Worker Laptop</h3></div>
          <div className="card-body" style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-muted)' }}>
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              <li>Make sure both laptops are on the same network.</li>
              <li>On the worker laptop, run the OCR agent:
                <div className="num" style={{ fontSize: 11, background: 'var(--bg-sunken)', padding: '8px 10px', borderRadius: 4, margin: '6px 0', color: 'var(--text)' }}>
                  python -m worker --connect {wsUrl} --code {pairCode}
                </div>
              </li>
              <li>The worker appears under <strong>Connected Workers</strong>.</li>
              <li>Upload PDFs in <strong>OCR Inbox</strong>; the same documents appear in the dispatch list here.</li>
              <li>Click <strong>Send to worker</strong> on an Inbox PDF — it OCR-parses locally and returns statement data.</li>
              <li>When processing finishes, open the result in <strong>OCR Inbox</strong> to review every extracted row.</li>
            </ol>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><h3 className="card-title">Activity</h3></div>
          <div className="card-body" style={{ padding: 0, maxHeight: 260, overflowY: 'auto' }}>
            {log.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-subtle)', fontSize: 12, fontStyle: 'italic' }}>Events appear here.</div>
            ) : (
              <div style={{ padding: '8px 0' }}>
                {log.map(e => (
                  <div key={e.id} style={{ display: 'flex', gap: 10, padding: '5px 16px', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                    <span style={{ color: 'var(--text-subtle)', flexShrink: 0 }}>{e.ts.toLocaleTimeString('en-US', { hour12: false })}</span>
                    <span style={{ color: logColor(e.kind), flexShrink: 0 }}>{logTag(e.kind)}</span>
                    <span style={{ color: 'var(--text)' }}>{e.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {verifyJob && (
        <VerifyModal
          job={verifyJob}
          onClose={() => setVerifyJob(null)}
          onConfirm={() => confirmResult(verifyJob)}
          goStatements={() => { setVerifyJob(null); setPage && setPage('statements'); }}
        />
      )}
    </div>
  );
};

// Step 1: review the OCR'd rows before committing them
const VERIFY_SECTIONS = { income: 'Income Statement', balance: 'Balance Sheet', cashflow: 'Cash Flow' };

const VerifyModal = ({ job, onClose, onConfirm, goStatements }) => {
  const [confirmed, setConfirmed] = React.useState(false);
  const rows = job.rows || [];
  const bySection = {};
  rows.forEach(r => { (bySection[r.section] = bySection[r.section] || []).push(r); });

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'grid', placeItems: 'center', padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: 560, maxHeight: '86vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 24px 64px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
        {/* Header with step indicator */}
        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 17, fontWeight: 600 }}>
              {confirmed ? 'Step 2 · Confirm' : 'Step 1 · Verify data'}
            </div>
            <button className="icon-btn" onClick={onClose} style={{ width: 26, height: 26 }}><Icon name="close" size={12} /></button>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <span style={{ flex: 1, height: 3, borderRadius: 2, background: 'var(--accent)' }}></span>
            <span style={{ flex: 1, height: 3, borderRadius: 2, background: confirmed ? 'var(--accent)' : 'var(--border-strong)' }}></span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 10 }}>
            <span className="ticker">{job.ticker}</span> · {rows.length} metrics parsed by {job.worker} from <strong style={{ color: 'var(--text)' }}>{job.filename}</strong>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: confirmed ? 20 : 0 }}>
          {!confirmed ? (
            Object.keys(bySection).map(sec => (
              <div key={sec}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)', padding: '12px 18px 6px', background: 'var(--bg-sunken)' }}>{VERIFY_SECTIONS[sec] || sec}</div>
                {bySection[sec].map(r => (
                  <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 14, alignItems: 'center', padding: '9px 18px', borderBottom: '1px solid var(--border)' }}>
                    <span style={{ fontSize: 13 }}>{r.metric} <span style={{ fontSize: 10, color: 'var(--text-subtle)' }}>p.{r.page}</span></span>
                    <span className="num" style={{ fontSize: 12, color: 'var(--text-muted)', width: 70, textAlign: 'right' }}>{r.prev}</span>
                    <span className="num" style={{ fontSize: 13, fontWeight: 600, width: 70, textAlign: 'right' }}>{r.curr}</span>
                  </div>
                ))}
              </div>
            ))
          ) : (
            <div style={{ textAlign: 'center', padding: '12px 8px' }}>
              <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--pos-bg)', display: 'grid', placeItems: 'center', margin: '0 auto 14px' }}>
                <Icon name="starFill" size={20} style={{ color: 'var(--pos)' }} />
              </div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Add {job.ticker} to your companies?</div>
              <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, maxWidth: 380, margin: '0 auto' }}>
                Confirming applies these {rows.length} metrics to the filing's tracker and adds <strong style={{ color: 'var(--text)' }}>{job.ticker}</strong> to the Financial Statements company list, so you can review it there.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid var(--border)', background: 'var(--bg-sunken)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {!confirmed ? (
            <>
              <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Review the values, then continue</span>
              <div className="row">
                <button className="btn" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={() => setConfirmed(true)}>Looks right → Confirm</button>
              </div>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => setConfirmed(false)}>← Back</button>
              <div className="row">
                <button className="btn" onClick={onConfirm}>Confirm</button>
                <button className="btn btn-primary" onClick={() => { onConfirm(); goStatements(); }}>Confirm & open statements →</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// Build a minimal company dataset from OCR rows and register it on window.COMPANIES
// so the Financial Statements dropdown picks it up.
const COMPANY_TEMPLATE = {
  income: [
    { id: 'rev', key: 'revenue', label: 'Revenue', bold: true },
    { id: 'gp', key: 'gp', label: 'Gross Profit', bold: true },
    { id: 'oi', key: 'opinc', label: 'Operating Income', bold: true },
    { id: 'ni', key: 'ni', label: 'Net Income', bold: true, accent: true },
    { id: 'eps', key: 'eps', label: 'EPS (diluted)', format: 'currency' },
  ],
  balance: [
    { id: 'cash', key: 'cash', label: 'Cash & Equivalents' },
    { id: 'ta', key: 'ta', label: 'Total Assets', bold: true, accent: true },
    { id: 'ltd', key: 'ltd', label: 'Long-Term Debt' },
    { id: 'te', key: 'te', label: 'Total Equity', bold: true },
  ],
  cashflow: [
    { id: 'ocf', key: 'cfo', label: 'Operating Cash Flow', bold: true, accent: true },
    { id: 'capex', key: 'capex', label: 'Capex' },
    { id: 'fcf', key: 'fcf', label: 'Free Cash Flow', bold: true },
    { id: 'buyback', key: 'buyback', label: 'Buybacks' },
  ],
};

const registerCompanyFromJob = (job) => {
  if (!window.COMPANIES || !job.rows) return false;
  const t = job.ticker;
  if (window.COMPANIES[t]) return false; // already present
  const num = (v) => { const n = parseFloat(String(v).replace(/[,$]/g, '')); return isNaN(n) ? 0 : n; };
  const find = (id) => job.rows.find(r => r.id === id);
  const build = (tmpl) => tmpl.map(row => {
    const hit = find(row.id);
    return { ...row, values: [hit ? num(hit.prev) : 0, hit ? num(hit.curr) : 0] };
  });
  window.COMPANIES[t] = {
    ticker: t, name: `${t} (imported)`, exchange: 'OCR', sector: 'Imported via Sync', fyEnd: '—',
    lastReported: { label: 'OCR', date: new Date().toISOString().slice(0, 10) },
    years: ['Prior', 'Latest'],
    income: build(COMPANY_TEMPLATE.income),
    balance: build(COMPANY_TEMPLATE.balance),
    cashflow: build(COMPANY_TEMPLATE.cashflow),
    ratios: [],
    scorecard: [],
  };
  return true;
};
const logTag = (k) => ({ sys: 'SYS', worker: 'WORKER', out: 'SENT→', in: '←RECV', error: 'ERR' }[k] || 'LOG');
const logColor = (k) => ({ sys: 'var(--text-muted)', worker: 'var(--info)', out: 'var(--accent)', in: 'var(--pos)', error: 'var(--neg)' }[k] || 'var(--text-muted)');

if (!document.getElementById('sync-style')) {
  const s = document.createElement('style');
  s.id = 'sync-style';
  s.textContent = `
    .sync-jobs-table td { height: auto; padding-top: 14px; padding-bottom: 14px; }
  `;
  document.head.appendChild(s);
}

window.PageSync = PageSync;
