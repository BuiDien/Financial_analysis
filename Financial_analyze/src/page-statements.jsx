// Financial Statements analysis page

// ── Live mode: company history from verified OCR statements (spec §6.7) ─────────────
// Only verified data is shown — no demo numbers. Values are integers in đồng from the API,
// shown in tỷ đồng. "Add statement" hands the ticker to OCR Inbox (window.__ocrTarget).

const HX_MAX_LINES = 8;
const HX_SLOTS = Array.from({ length: HX_MAX_LINES }, (_, i) => `var(--lx-series-${i + 1})`);
const HX_KIND = { balance: 'Balance sheet', income: 'Income statement', cashflow: 'Cash flow' };
const HX_SCOPE = { consolidated: 'Consolidated', separate: 'Separate' };

const hxStore = {
  get(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};

// Vietnamese grouping ("1.615.764", "12,5"); tỷ = 1e9 đồng.
const hxTy = (v) => {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  const t = v / 1e9, a = Math.abs(t);
  const digits = a === 0 ? 0 : a < 10 ? 2 : a < 100 ? 1 : 0;
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: digits }).format(t);
};
// Raw tỷ for copying: "." decimal, no thousands grouping, exact from integer đồng.
const hxTyRaw = (v) => {
  if (v === null || v === undefined || !isFinite(v)) return '';
  const digits = String(Math.abs(Math.round(v))).padStart(10, '0');
  const whole = digits.slice(0, -9).replace(/^0+(?=\d)/, '');
  const frac = digits.slice(-9).replace(/0+$/, '');
  return `${v < 0 ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
};
const hxDong = (v) => (v === null || v === undefined ? '—' : `${new Intl.NumberFormat('vi-VN').format(v)} đồng`);
const hxDate = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const hxQuarter = (iso) => { const [y, m] = iso.split('-').map(Number); return `Q${Math.ceil(m / 3)} ${y}`; };
const hxEnd = (y, m) => `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
// Every quarter end (or every 31/12) from the period ending at/after `first` up to `last`.
const hxPeriodRun = (first, last, grain) => {
  const out = [];
  let y = Number(first.slice(0, 4)), m = Number(first.slice(5, 7));
  if (grain === 'year') m = 12; else m = Math.ceil(m / 3) * 3;
  for (let guard = 0; guard < 400; guard++) {
    const iso = hxEnd(y, m);
    if (iso > last) break;
    out.push(iso);
    if (grain === 'year') y += 1; else { m += 3; if (m > 12) { m -= 12; y += 1; } }
  }
  return out;
};
const hxXLabel = (iso, grain) => (grain === 'year' ? iso.slice(0, 4) : hxQuarter(iso));

const hxPeriodText = (p) => {
  if (!p) return '';
  if (p.period_type === 'instant') return `at ${hxDate(p.period_end)}`;
  if (p.period_type === 'year') return `FY ${p.period_end.slice(0, 4)} · ${hxDate(p.period_start)} – ${hxDate(p.period_end)}`;
  return `${hxQuarter(p.period_end)} · ${hxDate(p.period_start)} – ${hxDate(p.period_end)}`;
};
// How a calculated quarter was derived (history_facts.derive_missing_quarters): Q4 = FY − 9M,
// Q3 = 9M − 6M, Q2 = 6M − 3M (or Q1), Q1 = 3M.
const hxFormula = (p) => {
  if (!p || p.period_type !== 'quarter' || !p.period_start) return 'calculated from printed periods';
  const y = p.period_start.slice(0, 4), m = Number(p.period_start.slice(5, 7));
  if (m === 10) return `calculated: FY ${y} − 9M ${y}`;
  if (m === 7) return `calculated: 9M ${y} − 6M ${y}`;
  if (m === 4) return `calculated: 6M ${y} − Q1 ${y}`;
  return `calculated: 3M ${y}`;
};
const hxStatusText = (p) => {
  if (!p) return '';
  if (p.status === 'conflict') return `${p.sources.length} · values differ`;
  if (p.status === 'agree') return `${new Set(p.sources.map(s => s.inbox_item_id)).size} sources agree`;
  if (p.status === 'resolved') return 'chosen by you';
  return '1 source';
};

const HxEmpty = ({ title, children }) => (
  <div className="card" style={{ padding: '36px 24px', textAlign: 'center' }}>
    <div className="serif" style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>{title}</div>
    <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 460, margin: '0 auto' }}>{children}</div>
  </div>
);

const HxField = ({ label, children, style }) => (
  <div style={{ minWidth: 0, ...style }}>
    <span style={{ display: 'block', margin: '0 2px 7px', fontSize: 12.5, fontWeight: 700, color: 'var(--text-subtle)' }}>{label}</span>
    {children}
  </div>
);

// Jump to OCR Inbox with the company pre-set; the inbox asks for year, period and scope.
const hxAddStatement = (ticker, setPage) => {
  window.__ocrTarget = ticker ? { ticker } : null;
  setPage && setPage('ocr-inbox');
};

const HxStatementsShell = ({ sub, action, children }) => (
  <div className="page">
    <div className="page-header" style={{ flexWrap: 'wrap' }}>
      <div>
        <h1 className="page-title">Financial statements.</h1>
        <p className="page-sub">{sub}</p>
      </div>
      {action}
    </div>
    {children}
  </div>
);

const CompanyHistory = ({ companies, wanted = null, setPage }) => {
  const options = React.useMemo(() => companies.map(c => ({
    value: `${c.ticker}|${c.scope}`,
    label: `${c.ticker} · ${HX_SCOPE[c.scope] || c.scope}`,
    hint: `${c.documents} document${c.documents === 1 ? '' : 's'} · to ${hxDate(c.last_period_end)}`,
  })), [companies]);
  const [company, setCompany] = React.useState(() => {
    const byHint = wanted && options.find(o => o.value.startsWith(`${wanted}|`));
    const saved = hxStore.get('hx_history_company');
    return (byHint || options.find(o => o.value === saved) || options[0]).value;
  });
  const [ticker, scope] = company.split('|');
  const storeKey = `hx_history_lines_${ticker}_${scope}`;

  const [catalog, setCatalog] = React.useState([]);
  const [picked, setPicked] = React.useState([]); // [{key, slot}]
  const [grain, setGrain] = React.useState('quarter');
  const [view, setView] = React.useState('small');
  const [range, setRange] = React.useState({ from: '', to: '' });
  const [data, setData] = React.useState(null); // series lines, in API order
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const [reload, setReload] = React.useState(0);
  const [panel, setPanel] = React.useState(null); // {key, factKey}
  const [busy, setBusy] = React.useState(false);
  const [showTable, setShowTable] = React.useState(false);
  const seq = React.useRef(0);

  // Line catalogue for this company and scope; restore the last picks (and their colours).
  React.useEffect(() => {
    let alive = true;
    hxStore.set('hx_history_company', company);
    setCatalog([]); setData(null); setPanel(null); setRange({ from: '', to: '' });
    const saved = hxStore.get(storeKey);
    setPicked(Array.isArray(saved) ? saved.filter(p => p && p.key && p.slot >= 0 && p.slot < HX_MAX_LINES) : []);
    HelixAPI.historyLines(ticker, scope)
      .then(list => {
        if (!alive) return;
        setCatalog(list || []);
        const keys = new Set((list || []).map(l => l.key));
        setPicked(cur => cur.filter(p => keys.has(p.key)));
      })
      .catch(e => { if (alive) { setError(e.message); window.toast && window.toast(`Could not load lines: ${e.message}`, { type: 'error' }); } });
    return () => { alive = false; };
  }, [company]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => { hxStore.set(storeKey, picked); }, [picked, storeKey]);

  const pickedKeys = picked.map(p => p.key).join(',');
  React.useEffect(() => {
    if (!pickedKeys) { setData(null); setLoading(false); return; }
    const mine = ++seq.current;
    setLoading(true); setError('');
    HelixAPI.historySeries(ticker, scope, { lines: pickedKeys.split(','), grain })
      .then(res => { if (mine === seq.current) setData(res.lines || []); })
      .catch(e => {
        if (mine !== seq.current) return;
        setError(e.message);
        window.toast && window.toast(`Could not load the history: ${e.message}`, { type: 'error' });
      })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [ticker, scope, pickedKeys, grain, reload]);

  const byKey = React.useMemo(() => new Map(catalog.map(l => [l.key, l])), [catalog]);
  const lineOf = key => (data || []).find(l => l.key === key) || null;
  const nameOf = key => lineOf(key)?.name || byKey.get(key)?.name || key;

  const addLine = (s) => setPicked(cur => {
    if (cur.length >= HX_MAX_LINES || cur.some(p => p.key === s.key)) return cur;
    const used = new Set(cur.map(p => p.slot));
    const slot = HX_SLOTS.findIndex((_, i) => !used.has(i));
    return [...cur, { key: s.key, slot }];
  });
  const removeLine = (key) => {
    setPicked(cur => cur.filter(p => p.key !== key));
    if (panel && panel.key === key) setPanel(null);
  };

  // Periods present in the fetched series; the range filter applies to every chart and the table.
  // The x axis is the full consecutive run of periods for the grain (every quarter end, or every
  // 31/12) from the earliest to the latest point, so time is spaced evenly and a period that no
  // picked line has stays an empty slot (lines break there) instead of dropping out of the axis.
  const allXs = React.useMemo(() => {
    const set = new Set();
    (data || []).forEach(l => l.points.forEach(p => set.add(p.period_end)));
    const have = [...set].sort();
    if (!have.length) return [];
    const run = hxPeriodRun(have[0], have[have.length - 1], grain);
    have.forEach(x => { if (!run.includes(x)) run.push(x); }); // off-grid dates are kept, never dropped
    return run.sort();
  }, [data, grain]);
  const from = range.from && allXs.includes(range.from) ? range.from : allXs[0];
  const to = range.to && allXs.includes(range.to) ? range.to : allXs[allXs.length - 1];
  const xs = allXs.filter(x => x >= from && x <= to);
  const fmtX = x => hxXLabel(String(x), grain);

  const series = picked.map(p => {
    const line = lineOf(p.key);
    return {
      key: p.key, name: nameOf(p.key), color: HX_SLOTS[p.slot], kind: line?.kind || byKey.get(p.key)?.kind,
      points: (line ? line.points : []).filter(q => q.period_end >= from && q.period_end <= to)
        .map(q => ({ x: q.period_end, y: q.value, status: q.status, origin: q.origin, raw: q })),
    };
  }).filter(s => lineOf(s.key));

  const suggestions = React.useMemo(() => catalog.map(l => ({ key: l.key, label: l.name })), [catalog]);
  const items = picked.map(p => ({ key: p.key, label: nameOf(p.key), color: HX_SLOTS[p.slot] }));
  const rangeOptions = allXs.map(x => ({ value: x, label: fmtX(x), hint: hxDate(x) }));

  // Source panel: the clicked point, with J / K (or the arrows) stepping through that line's points.
  const panelLine = panel ? series.find(s => s.key === panel.key) : null;
  const panelIdx = panelLine ? panelLine.points.findIndex(q => q.raw.fact_key === panel.factKey) : -1;
  const panelPoint = panelIdx >= 0 ? panelLine.points[panelIdx].raw : null;
  const openPoint = (s, p) => setPanel({ key: s.key, factKey: p.raw.fact_key });
  const stepPanel = d => {
    if (!panelLine) return;
    const next = panelLine.points[panelIdx + d];
    if (next) setPanel({ key: panelLine.key, factKey: next.raw.fact_key });
  };

  const choose = async (src) => {
    if (!panelLine || !panelPoint) return;
    setBusy(true);
    try {
      await HelixAPI.historyResolve(ticker, scope, {
        statement_kind: panelLine.kind, fact_key: panelPoint.fact_key, chosen_fact_id: src.fact_id,
      });
      window.toast && window.toast(`Using ${hxTy(src.value)} tỷ from ${src.filename || 'the calculation'}`, { type: 'success' });
      setReload(n => n + 1);
    } catch (e) {
      window.toast && window.toast(`Could not save the choice: ${e.message}`, { type: 'error' });
    } finally { setBusy(false); }
  };

  const copyTable = async () => {
    const head = ['Period', ...series.map(s => `${s.name} (tỷ đồng)`)].join('\t');
    const rows = xs.map(x => [fmtX(x), ...series.map(s => {
      const q = s.points.find(p => p.x === x);
      if (!q) return '';
      return q.status === 'conflict' ? 'sources differ' : hxTyRaw(q.y);
    })].join('\t'));
    try {
      await navigator.clipboard.writeText([head, ...rows].join('\n'));
      window.toast && window.toast('Table copied', { type: 'success' });
    } catch {
      window.toast && window.toast('Copy is blocked in this browser — select the table instead', { type: 'error' });
    }
  };

  const conflicts = series.reduce((n, s) => n + s.points.filter(p => p.status === 'conflict').length, 0);

  return (
    <div className="page">
      <div className="page-header" style={{ flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Financial statements.</h1>
          <p className="page-sub">Company history from verified OCR statements · values in tỷ đồng</p>
        </div>
        <button className="btn btn-primary" onClick={() => hxAddStatement(ticker, setPage)}><Icon name="plus" size={12} /> Add statement</button>
      </div>

      {/* Filters: one block above everything they scope. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 14 }}>
        <HxField label="Company · scope" style={{ flex: '1 1 200px', maxWidth: 260 }}>
          <LxSelect value={company} options={options} onChange={setCompany} ariaLabel="Company and scope" />
        </HxField>
        <HxField label="From" style={{ flex: '1 1 130px', maxWidth: 170 }}>
          <LxSelect value={from || ''} options={rangeOptions.filter(o => !to || o.value <= to)} placeholder="—"
            disabled={!allXs.length} ariaLabel="From period" onChange={v => setRange(r => ({ ...r, from: v }))} />
        </HxField>
        <HxField label="To" style={{ flex: '1 1 130px', maxWidth: 170 }}>
          <LxSelect value={to || ''} options={rangeOptions.filter(o => !from || o.value >= from)} placeholder="—"
            disabled={!allXs.length} ariaLabel="To period" onChange={v => setRange(r => ({ ...r, to: v }))} />
        </HxField>
        <HxField label="Periods">
          <LxSegmented value={grain} ariaLabel="Quarter or year"
            options={[{ value: 'quarter', label: 'Quarter' }, { value: 'year', label: 'Year' }]}
            onChange={g => { setGrain(g); setRange({ from: '', to: '' }); setPanel(null); }} />
        </HxField>
        <HxField label="View">
          <LxSegmented value={view} ariaLabel="Chart view"
            options={[{ value: 'small', label: 'Small charts' }, { value: 'growth', label: 'Growth (start = 100)' }]}
            onChange={setView} />
        </HxField>
        <HxField label={`Lines · ${picked.length} / ${HX_MAX_LINES}`} style={{ flex: '1 1 100%' }}>
          <LxTagInput items={items} suggestions={suggestions} onAdd={addLine} onRemove={removeLine}
            max={HX_MAX_LINES} maxMessage={`Up to ${HX_MAX_LINES} lines`} ariaLabel="Add a line" idleSuggestions={picked.length ? 0 : 8}
            placeholder={catalog.length ? 'Search lines, e.g. “tổng tài sản”, press Enter' : 'Loading lines…'} />
        </HxField>
      </div>

      {!picked.length && (
        <HxEmpty title="Pick lines to compare">
          Search the line catalogue above and add up to {HX_MAX_LINES} lines. Each line keeps its colour while it is on screen.
        </HxEmpty>
      )}

      {picked.length > 0 && !data && loading && <HxEmpty title="Loading the history…">Reading the verified facts for {ticker}.</HxEmpty>}
      {picked.length > 0 && !data && !loading && error && <HxEmpty title="The history could not be loaded">{error}</HxEmpty>}

      {picked.length > 0 && data && (
        <div style={{ opacity: loading ? 0.55 : 1, transition: 'opacity .2s' }} aria-busy={loading ? 'true' : 'false'}>
          {!xs.length ? (
            <HxEmpty title="No values in this range">
              {grain === 'year' ? 'Year view shows full-year values and year-end balances only.' : 'Quarter view shows quarters and balance dates; year-to-date values are never plotted.'}
            </HxEmpty>
          ) : view === 'small' ? (
            <LxSmallMultiples series={series} xs={xs} formatX={fmtX} formatValue={v => hxTy(v)}
              title={`${ticker} · ${HX_SCOPE[scope] || scope} · tỷ đồng`} onPointClick={openPoint} />
          ) : (
            <LxGrowthChart series={series} xs={xs} formatX={fmtX} formatValue={v => `${hxTy(v)} tỷ`}
              title={`${ticker} · ${HX_SCOPE[scope] || scope} · growth, first period = 100`} onPointClick={openPoint} />
          )}

          <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center', margin: '12px 4px 0', fontSize: 12, color: 'var(--text-muted)' }}>
            <span><b style={{ color: 'var(--text)' }}>●</b> printed</span>
            <span><b style={{ color: 'var(--text)' }}>○</b> calculated</span>
            <span><b style={{ color: 'var(--neg)' }}>◯</b> ⚠ sources differ{conflicts ? ` (${conflicts} open)` : ''}</span>
            <span>Click a point for its source.</span>
            <span style={{ flex: 1 }} />
            <button className="btn" aria-expanded={showTable} aria-controls="hx-table" onClick={() => setShowTable(v => !v)}>
              {showTable ? 'Hide table' : 'Show table'}
            </button>
          </div>

          {showTable && xs.length > 0 && (
            <div className="card" id="hx-table" style={{ marginTop: 12 }}>
              <div className="card-header">
                <h3 className="card-title">Same values as a table</h3>
                <div className="row" style={{ gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>tỷ đồng · c = calculated</span>
                  <button className="btn" onClick={copyTable}>Copy</button>
                </div>
              </div>
              <div className="card-body flush" style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Period</th>
                      {series.map(s => <th key={s.key} scope="col" style={{ textAlign: 'right', whiteSpace: 'normal', minWidth: 120 }}>
                        <span aria-hidden="true" style={{ display: 'inline-block', width: 12, height: 2, background: s.color, verticalAlign: 'middle', marginRight: 6 }} />{s.name}
                      </th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {xs.map(x => <tr key={x}>
                      <th scope="row" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{fmtX(x)}</th>
                      {series.map(s => {
                        const q = s.points.find(p => p.x === x);
                        return <td key={s.key} className="num" style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                          {!q ? '' : q.status === 'conflict'
                            ? <button className="btn" style={{ color: 'var(--neg)', padding: '2px 8px' }} onClick={() => openPoint(s, q)}>⚠ sources differ</button>
                            : <>{hxTy(q.y)}{q.origin === 'calculated' && <sup title="calculated" style={{ marginLeft: 2, color: 'var(--text-subtle)' }}>c</sup>}</>}
                        </td>;
                      })}
                    </tr>)}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <LxSidePanel open={!!panelPoint} onClose={() => setPanel(null)}
        title={panelLine ? panelLine.name : ''}
        subtitle={panelLine ? `${HX_KIND[panelLine.kind] || panelLine.kind} · ${ticker} · ${HX_SCOPE[scope] || scope}` : ''}
        indexLabel={panelLine ? `${panelIdx + 1} / ${panelLine.points.length}` : ''}
        contentKey={panel ? panel.factKey : ''}
        onPrev={panelIdx > 0 ? () => stepPanel(-1) : undefined}
        onNext={panelLine && panelIdx < panelLine.points.length - 1 ? () => stepPanel(1) : undefined}>
        {panelPoint && <HxSourceBody point={panelPoint} busy={busy} onChoose={choose} />}
      </LxSidePanel>
    </div>
  );
};

const HxSourceBody = ({ point, busy, onChoose }) => {
  const conflict = point.status === 'conflict';
  const canChoose = conflict || point.status === 'resolved';
  return <>
    <div className="u273-kv">
      <div><small>Value</small><b style={conflict ? { color: 'var(--neg)' } : undefined}>{conflict ? '⚠ sources differ' : `${hxTy(point.value)} tỷ`}</b></div>
      <div><small>Period</small><b>{point.period_type === 'instant' ? hxDate(point.period_end) : hxQuarterOrYear(point)}</b></div>
      <div><small>Origin</small><b>{point.origin === 'calculated' ? 'Calculated' : 'Printed'}</b></div>
      <div><small>Sources</small><b>{hxStatusText(point)}</b></div>
    </div>
    <small style={{ display: 'block', marginTop: 8, fontSize: 10.5, fontWeight: 650, color: 'var(--ux-ink-3)' }}>
      {hxPeriodText(point)}{!conflict && point.value !== null ? ` · ${hxDong(point.value)}` : ''}
    </small>
    {point.origin === 'calculated' && <>
      <h5>How it was calculated</h5>
      <div className="u273-ac">{hxFormula(point)}</div>
      {point.inputs && point.inputs.length > 0 && <div className="u273-ac">inputs: {point.inputs.map(i => `fact #${i}`).join(', ')} (printed, verified)</div>}
    </>}
    <h5>{conflict ? 'Sources — pick the right one, or correct the OCR page' : 'Sources'}</h5>
    {point.sources.map(src => {
      const chosen = point.status === 'resolved' && src.value === point.value;
      return <div key={src.fact_id} style={{ marginTop: 6, padding: '9px 10px', borderRadius: 10, background: 'var(--ux-surface-2)' }}>
        {src.origin === 'printed' ? <>
          <div style={{ fontSize: 11.5, fontWeight: 800, overflowWrap: 'anywhere' }}>{src.filename || `Document #${src.inbox_item_id}`}</div>
          <div style={{ marginTop: 2, fontSize: 10.5, fontWeight: 650, color: 'var(--ux-ink-3)' }}>
            page {src.page} · row “{src.row_label || `#${src.row}`}” · reviewed ✓
          </div>
        </> : <div style={{ fontSize: 11.5, fontWeight: 800 }}>Calculated by Helix · {hxFormula(point).replace('calculated: ', '')}</div>}
        <div className="row" style={{ marginTop: 7, gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <b style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', marginRight: 'auto' }}>{hxTy(src.value)} tỷ{chosen ? ' · your choice' : ''}</b>
          {src.origin === 'printed' && src.page && <button type="button" className="btn" style={{ padding: '3px 9px', fontSize: 11 }}
            onClick={() => window.open(HelixAPI.ocrInboxPageUrl(src.inbox_item_id, src.page), '_blank', 'noopener')}>Open scan</button>}
          {canChoose && !chosen && <button type="button" className="btn btn-primary" style={{ padding: '3px 9px', fontSize: 11 }}
            disabled={busy} onClick={() => onChoose(src)}>Use this value</button>}
        </div>
      </div>;
    })}
  </>;
};
const hxQuarterOrYear = (p) => (p.period_type === 'year' ? `FY ${p.period_end.slice(0, 4)}` : hxQuarter(p.period_end));

// Live when the backend answers and at least one company has history; otherwise the demo.
const PageStatements = ({ setPage }) => {
  const [state, setState] = React.useState({ mode: 'checking', companies: [] });
  // Ticker handed over by another page (screener → detail → Financials). Read once;
  // clearing it ("See companies with statements") falls back to the company list.
  const [wanted, setWanted] = React.useState(() => {
    const hint = window.__statementsTicker;
    window.__statementsTicker = null;
    return hint ? String(hint).toUpperCase().replace(/^VN:/, '') : null;
  });
  React.useEffect(() => {
    let alive = true;
    const check = async (live) => {
      if (!live) { if (alive) setState({ mode: 'offline', companies: [] }); return; }
      try {
        const list = await HelixAPI.historyCompanies();
        if (alive) setState({ mode: 'live', companies: list || [] });
      } catch {
        if (alive) setState({ mode: 'offline', companies: [] });
      }
    };
    const onStatus = (live) => check(live);
    HelixAPI.onStatusChange(onStatus);
    if (HelixAPI.checked) check(HelixAPI.live);
    return () => { alive = false; HelixAPI.listeners = HelixAPI.listeners.filter(fn => fn !== onStatus); };
  }, []);

  if (state.mode === 'checking') return <HxStatementsShell sub="Looking for company history…" />;
  if (state.mode === 'offline') {
    return <HxStatementsShell sub="Company history from verified OCR statements">
      <HxEmpty title="Can't reach the backend">Start the backend to see verified financial statements.</HxEmpty>
    </HxStatementsShell>;
  }
  const { companies } = state;
  const hasWanted = wanted && companies.some(c => c.ticker === wanted);
  if (wanted && !hasWanted) {
    return <HxStatementsShell sub={`${wanted} · no verified statements yet`}
      action={<button className="btn btn-primary" onClick={() => hxAddStatement(wanted, setPage)}><Icon name="plus" size={12} /> Add statement</button>}>
      <HxEmpty title={`No statements for ${wanted} yet`}>
        Found {wanted}'s financial report on the company website? Use <b>Add statement</b>, choose the year and quarter,
        and drop the PDF into OCR Inbox. After you check it and use <b>Add to history</b>, the numbers show up here.
        {companies.length > 0 && <div style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => setWanted(null)}>See companies with statements ({companies.length})</button>
        </div>}
      </HxEmpty>
    </HxStatementsShell>;
  }
  if (!companies.length) {
    return <HxStatementsShell sub="Company history from verified OCR statements"
      action={<button className="btn btn-primary" onClick={() => hxAddStatement(null, setPage)}><Icon name="plus" size={12} /> Add statement</button>}>
      <HxEmpty title="No statements yet">
        Pick a stock in Screener and open <b>Financials</b>, or use <b>Add statement</b> to upload a company's financial report.
      </HxEmpty>
    </HxStatementsShell>;
  }
  return <CompanyHistory companies={companies} wanted={hasWanted ? wanted : null} setPage={setPage} />;
};

window.PageStatements = PageStatements;
