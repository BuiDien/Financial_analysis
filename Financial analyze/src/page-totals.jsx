// Totals — a single consolidated view of EVERYTHING collected across the app:
//   • Headline statement totals (latest fiscal year)
//   • Full consolidated line-item table (income + balance + cash flow)
//   • Aggregated Data Tracker entries saved from every filing (localStorage)
//   • Captured flags/observations across all filings

const TOTALS_TRACKER_PREFIX = 'helix_reader_tracker_v1_';

// Pull every saved filing tracker out of localStorage
const collectTrackers = () => {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(TOTALS_TRACKER_PREFIX)) {
      try {
        const t = JSON.parse(localStorage.getItem(key));
        out.push({ filingId: key.slice(TOTALS_TRACKER_PREFIX.length), tracker: t });
      } catch {}
    }
  }
  return out;
};

// Map a filing id back to its name from the filings library
const filingNameFor = (id) => {
  try {
    const filings = JSON.parse(localStorage.getItem('helix_filings_v1') || '[]');
    const f = filings.find(x => String(x.id) === String(id));
    return f ? { name: f.name, ticker: f.ticker, period: f.period } : null;
  } catch { return null; }
};

const PageTotals = ({ setPage }) => {
  const FS_DATA = window.FS_DATA;
  const fmtCompact = window.fmtCompact;
  const [trackers, setTrackers] = React.useState(collectTrackers);

  // Refresh when returning to the page
  React.useEffect(() => {
    const onFocus = () => setTrackers(collectTrackers());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const years = FS_DATA.years;
  const lastIdx = years.length - 1;

  // Aggregate counts across all filing trackers
  const agg = React.useMemo(() => {
    let metricsFilled = 0, flagsCount = 0;
    const flagsByKind = { strength: 0, risk: 0, question: 0, investigate: 0 };
    const allFlags = [];
    trackers.forEach(({ filingId, tracker }) => {
      ['income', 'balance', 'cashflow'].forEach(sec => {
        (tracker[sec] || []).forEach(r => { if (r.curr) metricsFilled++; });
      });
      (tracker.flags || []).forEach(f => {
        flagsCount++;
        if (flagsByKind[f.kind] !== undefined) flagsByKind[f.kind]++;
        allFlags.push({ ...f, filingId });
      });
    });
    return { metricsFilled, flagsCount, flagsByKind, allFlags };
  }, [trackers]);

  const cagr = (vals) => {
    const first = vals[0], last = vals[lastIdx];
    if (!(first > 0) || !(last > 0)) return null;
    return (Math.pow(last / first, 1 / lastIdx) - 1) * 100;
  };
  const yoy = (vals) => {
    const prev = vals[lastIdx - 1], last = vals[lastIdx];
    if (!prev) return null;
    return ((last - prev) / Math.abs(prev)) * 100;
  };

  const groups = [
    { name: 'Income Statement', color: 'var(--accent)', rows: FS_DATA.income },
    { name: 'Balance Sheet', color: '#1D4ED8', rows: FS_DATA.balance },
    { name: 'Cash Flow', color: '#15803D', rows: FS_DATA.cashflow },
  ];
  const totalLineItems = groups.reduce((s, g) => s + g.rows.length, 0);

  const rev = FS_DATA.income.find(r => r.key === 'revenue').values;
  const ni = FS_DATA.income.find(r => r.key === 'ni').values;
  const cfo = FS_DATA.cashflow.find(r => r.key === 'cfo').values;
  const fcf = FS_DATA.cashflow.find(r => r.key === 'fcf').values;
  const ta = FS_DATA.balance.find(r => r.key === 'ta').values;
  const te = FS_DATA.balance.find(r => r.key === 'te').values;
  const headline = [
    { label: 'Total Revenue', vals: rev },
    { label: 'Net Income', vals: ni },
    { label: 'Operating Cash Flow', vals: cfo },
    { label: 'Free Cash Flow', vals: fcf },
    { label: 'Total Assets', vals: ta },
    { label: 'Total Equity', vals: te },
  ];

  const flagKindMeta = {
    strength: { label: 'Strengths', color: '#15803D', icon: '↑' },
    risk: { label: 'Risks', color: '#B91C1C', icon: '▲' },
    question: { label: 'Questions', color: '#A16207', icon: '?' },
    investigate: { label: 'To look up', color: '#1D4ED8', icon: '◎' },
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Totals.</h1>
          <p className="page-sub">Everything we collect — statement totals, tracked data, and observations in one place</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setPage('statements')}><Icon name="portfolio" size={12} /> Statements</button>
          <button className="btn btn-primary" onClick={() => setPage('statements')}>Open filings →</button>
        </div>
      </div>

      {/* Collection overview */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat">
          <div className="stat-label">Line items tracked</div>
          <div className="stat-value">{totalLineItems}</div>
          <div className="stat-delta" style={{ color: 'var(--text-muted)' }}>across 3 statements · {years.length} years</div>
        </div>
        <div className="stat">
          <div className="stat-label">Filings analyzed</div>
          <div className="stat-value">{trackers.length}</div>
          <div className="stat-delta" style={{ color: 'var(--text-muted)' }}>{agg.metricsFilled} data points captured</div>
        </div>
        <div className="stat">
          <div className="stat-label">Observations flagged</div>
          <div className="stat-value">{agg.flagsCount}</div>
          <div className="stat-delta" style={{ color: 'var(--text-muted)' }}>{agg.flagsByKind.risk} risks · {agg.flagsByKind.strength} strengths</div>
        </div>
        <div className="stat">
          <div className="stat-label">Latest revenue</div>
          <div className="stat-value">{fmtCompact(rev[lastIdx])}</div>
          <div className="stat-delta pos">+{yoy(rev).toFixed(0)}% YoY</div>
        </div>
      </div>

      {/* Headline totals */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <h3 className="card-title">Headline Totals · {years[lastIdx]}</h3>
          <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{FS_DATA.name}</span>
        </div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 1, background: 'var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          {headline.map((h, i) => {
            const y = yoy(h.vals);
            return (
              <div key={i} style={{ background: 'var(--bg-elev)', padding: 14 }}>
                <div style={{ fontSize: 10, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{h.label}</div>
                <div className="num" style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{fmtCompact(h.vals[lastIdx])}</div>
                {y !== null && (
                  <div className="num" style={{ fontSize: 11, fontWeight: 600, color: y >= 0 ? 'var(--pos)' : 'var(--neg)', marginTop: 2 }}>
                    {y >= 0 ? '+' : ''}{y.toFixed(0)}% YoY
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Consolidated line-item table */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <h3 className="card-title">Consolidated Totals</h3>
          <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>USD millions · every collected metric</span>
        </div>
        <div className="card-body flush">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: '34%' }}>Line item</th>
                <th className="right">{years[lastIdx - 1]}</th>
                <th className="right">{years[lastIdx]}</th>
                <th className="right">YoY</th>
                <th className="right">5Y CAGR</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <React.Fragment key={g.name}>
                  <tr style={{ cursor: 'default' }}>
                    <td colSpan={5} style={{ background: 'var(--bg-sunken)', padding: '8px 12px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: g.color }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: g.color }}></span>
                        {g.name}
                      </span>
                    </td>
                  </tr>
                  {g.rows.map((r, i) => {
                    const c = cagr(r.values);
                    const y = yoy(r.values);
                    return (
                      <tr key={i} style={{ cursor: 'default' }}>
                        <td style={{
                          fontWeight: r.bold ? 600 : 400,
                          color: r.accent ? 'var(--accent)' : (r.bold ? 'var(--text)' : 'var(--text-muted)'),
                          paddingLeft: r.bold ? 12 : 24,
                        }}>{r.label}</td>
                        <td className="right num" style={{ color: 'var(--text-muted)' }}>
                          {r.format === 'currency' ? '$' + r.values[lastIdx - 1].toFixed(2) : fmtCompact(r.values[lastIdx - 1])}
                        </td>
                        <td className="right num" style={{ fontWeight: r.bold ? 600 : 400 }}>
                          {r.format === 'currency' ? '$' + r.values[lastIdx].toFixed(2) : fmtCompact(r.values[lastIdx])}
                        </td>
                        <td className="right num" style={{ fontWeight: 600, color: y === null ? 'var(--text-subtle)' : y >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
                          {y !== null ? `${y >= 0 ? '+' : ''}${y.toFixed(0)}%` : '—'}
                        </td>
                        <td className="right num" style={{ fontWeight: 600 }}>
                          {c !== null ? <span className={c >= 0 ? 'pos' : 'neg'}>{c >= 0 ? '+' : ''}{c.toFixed(1)}%</span> : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Tracked data from filings + flags */}
      <div className="grid-2">
        {/* Data captured per filing */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Data Captured From Filings</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{trackers.length} {trackers.length === 1 ? 'filing' : 'filings'}</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {trackers.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                No filing data yet. Open a filing in the Reader and use the Data Tracker to capture figures — they'll total up here.
                <div style={{ marginTop: 12 }}>
                  <button className="btn" onClick={() => setPage('statements')}>Go to Filings</button>
                </div>
              </div>
            ) : (
              trackers.map(({ filingId, tracker }) => {
                const meta = filingNameFor(filingId);
                const filled = ['income', 'balance', 'cashflow'].reduce((s, sec) =>
                  s + (tracker[sec] || []).filter(r => r.curr).length, 0);
                const flags = (tracker.flags || []).length;
                return (
                  <div key={filingId} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12, padding: '12px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500 }}>{meta?.name || `Filing ${filingId}`}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{meta ? `${meta.ticker} · ${meta.period}` : 'Tracked data'}</div>
                    </div>
                    <span className="pill pill-neutral">{filled} metrics</span>
                    {flags > 0 && <span className="pill" style={{ background: 'var(--neg-bg)', color: 'var(--neg)' }}>{flags} flags</span>}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Flag rollup */}
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Observations Rollup</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{agg.flagsCount} total</span>
          </div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 14 }}>
              {Object.entries(flagKindMeta).map(([kind, meta]) => (
                <div key={kind} style={{ padding: 10, background: 'var(--bg-sunken)', borderRadius: 6, textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: meta.color }}>{agg.flagsByKind[kind]}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>{meta.icon} {meta.label}</div>
                </div>
              ))}
            </div>
            {agg.allFlags.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, fontStyle: 'italic' }}>
                Flags you capture while reading filings collect here.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflowY: 'auto' }}>
                {agg.allFlags.slice(0, 12).map((f, i) => {
                  const meta = flagKindMeta[f.kind] || flagKindMeta.risk;
                  return (
                    <div key={i} style={{ display: 'flex', gap: 8, padding: '8px 10px', background: 'var(--bg-sunken)', borderRadius: 4, borderLeft: `3px solid ${meta.color}` }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: meta.color }}>{meta.icon}</span>
                      <span style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.45 }}>{f.text}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

window.PageTotals = PageTotals;
