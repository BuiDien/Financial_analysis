// Sync — distributed OCR coordinator.
//
// This machine (the Mac/Core) is the coordinator: it listens, and a worker
// laptop dials IN with a pairing code, receives PDF filings to OCR, and returns
// structured statement rows. This page is the control panel.
//
// LIVE mode (backend reachable): drives backend/app/routes/sync.py over
//   HelixAPI.sync* — GET /api/sync/status (poll workers+jobs), POST /api/sync/pair-code,
//   POST /api/sync/dispatch/{filingId}. Workers connect to HelixAPI.syncWsUrl()
//   ( ws://<base>/ws/ocr ) with the pairing code.
// OFFLINE mode (no backend): a built-in simulation runs so the flow is demoable.
//
// NOTE (OCR_PROTOCOL alignment, follow-ups): the live wire currently uses the
// backend's pdf_b64 + row `id`; the target protocol is binary chunks + Mã số
// `code`. Tracked in OCR_PROTOCOL.md; not blocking this integration.

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

const loadFilingsLib = () => {
  try { return JSON.parse(localStorage.getItem('helix_filings_v1') || '[]'); }
  catch { return []; }
};

const PageSync = ({ setPage }) => {
  const isLive = () => !!window.HelixAPI?.live;

  const [listening, setListening] = React.useState(false);
  const [pairCode, setPairCode] = React.useState(genPairCode);
  const [host] = React.useState(() => localIP());
  const port = 8000;

  const [workers, setWorkers] = React.useState([]);      // connected laptops
  const [jobs, setJobs] = React.useState(() => {
    try { return JSON.parse(localStorage.getItem(SYNC_JOBS_KEY) || '[]'); } catch { return []; }
  });
  const [log, setLog] = React.useState([]);
  const [filings] = React.useState(loadFilingsLib);
  const [verifyJob, setVerifyJob] = React.useState(null);
  const timersRef = React.useRef([]);

  React.useEffect(() => {
    localStorage.setItem(SYNC_JOBS_KEY, JSON.stringify(jobs));
  }, [jobs]);

  React.useEffect(() => () => timersRef.current.forEach(clearTimeout), []);

  const addLog = (kind, text) => {
    setLog(l => [{ id: Date.now() + Math.random(), kind, text, ts: new Date() }, ...l].slice(0, 60));
  };

  const wsUrl = isLive() ? window.HelixAPI.syncWsUrl() : `ws://${host}:${port}/ws/ocr`;

  // ── LIVE: poll the backend coordinator for workers + jobs while listening ──
  React.useEffect(() => {
    if (!listening || !isLive()) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await window.HelixAPI.syncStatus();
        if (cancelled) return;
        if (s.pair_code) setPairCode(s.pair_code);
        setWorkers((s.workers || []).map(w => ({
          id: w.id, name: w.name, ip: w.ip, status: w.status, done: w.done || 0,
        })));
        setJobs(prev => {
          const appliedMap = {};
          prev.forEach(j => { if (j.applied) appliedMap[j.id] = true; });
          return (s.jobs || []).map(j => ({
            id: j.id, filingId: j.filingId, filename: j.filename, ticker: j.ticker,
            worker: j.worker, status: j.status, progress: j.progress || 0,
            rows: j.rows || null, applied: appliedMap[j.id] || false,
          }));
        });
      } catch (e) { /* keep last state; backend may be momentarily unreachable */ }
    };
    tick();
    const iv = setInterval(tick, 1500);
    return () => { cancelled = true; clearInterval(iv); };
  }, [listening]);

  // ── Start / stop listening ─────────────────────────────────
  const toggleListen = () => {
    if (listening) {
      setListening(false);
      setWorkers([]);
      addLog('sys', 'Stopped listening. Workers disconnected.');
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      return;
    }
    setListening(true);
    addLog('sys', `Listening on ${wsUrl}`);
    addLog('sys', `Pairing code ${pairCode} — share with the worker laptop`);

    if (isLive()) {
      addLog('sys', 'Live: coordinator running on the backend. Waiting for a worker to pair…');
      return;  // the poll effect takes over
    }

    // Simulate a worker connecting shortly after (offline demo)
    const t = setTimeout(() => {
      const w = { id: 'w1', name: "Dien's MacBook Pro", ip: localIP(), status: 'idle', done: 0, connectedAt: new Date() };
      setWorkers([w]);
      addLog('worker', `${w.name} connected from ${w.ip}`);
    }, 2200);
    timersRef.current.push(t);
  };

  const regenCode = async () => {
    if (isLive()) {
      try {
        const r = await window.HelixAPI.syncRegenCode();
        if (r && r.pair_code) setPairCode(r.pair_code);
        addLog('sys', 'Pairing code regenerated.');
        return;
      } catch (e) { addLog('error', `Could not regenerate code: ${e.message || e}`); return; }
    }
    setPairCode(genPairCode());
    addLog('sys', 'Pairing code regenerated.');
  };

  // ── Dispatch a filing to a worker for OCR ──────────────────
  const dispatch = async (filing) => {
    if (isLive()) {
      try {
        const r = await window.HelixAPI.syncDispatch(filing.id);
        addLog('out', `Dispatched "${filing.name}" → worker (job ${r.jobId || '?'})`);
      } catch (e) {
        addLog('error', `Dispatch failed: ${e.message || e}`);
      }
      return;  // the poll effect reflects job progress + result
    }

    // Offline simulation
    const worker = workers.find(w => w.status === 'idle') || workers[0];
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
    setJobs(j => [job, ...j]);
    addLog('out', `Sent "${filing.name}" → ${worker.name}`);
    setWorkers(ws => ws.map(w => w.id === worker.id ? { ...w, status: 'busy' } : w));

    const t1 = setTimeout(() => {
      setJobs(j => j.map(x => x.id === job.id ? { ...x, status: 'parsing' } : x));
      addLog('worker', `${worker.name} parsing ${filing.ticker}…`);
      let p = 0;
      const iv = setInterval(() => {
        p += 12 + Math.random() * 10;
        if (p >= 100) { p = 100; clearInterval(iv); }
        setJobs(j => j.map(x => x.id === job.id ? { ...x, progress: Math.min(100, Math.round(p)) } : x));
      }, 260);
    }, 900);
    const t2 = setTimeout(() => {
      setJobs(j => j.map(x => x.id === job.id ? { ...x, status: 'done', progress: 100, rows: WORKER_RESULT_ROWS, doneAt: new Date() } : x));
      setWorkers(ws => ws.map(w => w.id === worker.id ? { ...w, status: 'idle', done: w.done + 1 } : w));
      addLog('in', `${worker.name} returned ${WORKER_RESULT_ROWS.length} metrics for ${filing.ticker}`);
    }, 4200);
    timersRef.current.push(t1, t2);
  };

  // Step 2 of 2 — confirm: apply data into the tracker AND register the
  // company so it shows up in the Financial Statements list.
  const confirmResult = (job) => {
    applyResult(job);
    const added = registerCompanyFromJob(job);
    if (added) addLog('sys', `${job.ticker} added to the Financial Statements company list`);
    window.toast && window.toast(`${job.ticker} verified & added to companies`, { type: 'success' });
    setVerifyJob(null);
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
    setJobs(j => j.map(x => x.id === job.id ? { ...x, applied: true } : x));
    addLog('sys', `Applied ${job.rows.length} metrics into ${job.ticker} tracker`);
  };

  const clearDone = () => setJobs(j => j.filter(x => x.status !== 'done'));

  const activeJobs = jobs.filter(j => j.status !== 'done');
  const doneJobs = jobs.filter(j => j.status === 'done');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Sync.</h1>
          <p className="page-sub">Hand off PDF filings to a worker laptop for OCR — parsed statement data comes back automatically</p>
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
                onClick={() => { navigator.clipboard?.writeText(wsUrl); addLog('sys', 'Address copied to clipboard'); }}>
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
        {/* Dispatch filings */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Dispatch a Filing for OCR</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{filings.length} in library</span>
          </div>
          <div className="card-body flush">
            {filings.length === 0 ? (
              <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                No filings yet. Upload PDFs in Financial Statements → Filings, then dispatch them here.
                <div style={{ marginTop: 12 }}><button className="btn" onClick={() => setPage('statements')}>Go to Filings</button></div>
              </div>
            ) : filings.map(f => {
              const pending = jobs.find(j => j.filingId === f.id && j.status !== 'done');
              return (
                <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{f.ticker} · {f.type} · {f.period}</div>
                  </div>
                  <button className="btn" disabled={!listening || !workers.length || !!pending}
                    onClick={() => dispatch(f)}
                    style={(!listening || !workers.length || !!pending) ? { opacity: 0.5 } : undefined}>
                    {pending ? 'In queue…' : <><Icon name="sync" size={12} /> Send to worker</>}
                  </button>
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
                  <th className="right" style={{ width: 120 }}></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(j => (
                  <tr key={j.id} style={{ cursor: 'default' }}>
                    <td>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{j.ticker}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-subtle)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 200 }}>{j.filename}</span>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text-muted)' }}>{j.worker}</td>
                    <td>
                      {j.status === 'done' ? (
                        <span className="pill pill-pos">✓ Returned</span>
                      ) : j.status === 'error' ? (
                        <span className="pill pill-neg">Failed</span>
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
                      {j.status === 'done' && (
                        j.applied
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
              <li>Click <strong>Send to worker</strong> on any filing — it OCR-parses locally and returns statement data.</li>
              <li>Click <strong>Apply data</strong> to merge results into that filing's tracker.</li>
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
