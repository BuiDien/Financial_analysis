// Screener — rule-based Vietnam stock screener: strategy chips, editable rules
// panel, debounced server-side evaluation. Broad-scan data is third-party
// (vnstock) and stays UNVERIFIED.

const SCR_STAGES = [
  { id: 'good', title: 'Good company rules' },
  { id: 'oversold', title: 'Oversold highlight' },
];
const SCR_BANK_OPTS = { any: 'Any', exclude: 'Exclude banks', no_financials: 'Exclude financials', only: 'Banks only' };
const SCR_EXCHANGES = ['HOSE', 'HNX', 'UPCOM'];
const SCR_FLAG_LABEL = { warning: 'Warning', control: 'Control', restricted: 'Restricted', suspended: 'Suspended' };

// Per-rule table column: short header + value format.
const SCR_COLS = {
  roe_years: ['ROE', 'pct'], profit_growth: ['Profit growth', 'pct'], revenue_growth: ['Revenue growth', 'pct'],
  debt_to_equity: ['Debt/Eq', 'num'], ocf_to_profit: ['Cash flow/profit', 'pct'], pe_vs_industry: ['P/E vs industry', 'pct'],
  profit_growth_min: ['Worst yr growth', 'pct'], receivable_days_change: ['Recv days Δ', 'days'],
  inventory_days_change: ['Inv days Δ', 'days'], gross_margin_change: ['Gross margin Δ', 'pts'],
  share_dilution: ['Dilution', 'pct'], foreign_room: ['Foreign room', 'pct'],
  pb: ['P/B', 'num'], dividend_yield: ['Div yield', 'pct'], traded_value: ['Value bn', 'bn'], market_cap: ['Mkt cap bn', 'bn'],
  bank_npl: ['NPL', 'pct'], bank_nim: ['NIM', 'pct'], bank_cir: ['CIR', 'pct'], bank_car: ['CAR', 'pct'],
  rsi: ['RSI', 'num0'], price_drop: ['Drop', 'pct'], volume_spike: ['Volume', 'x'],
};
const SCR_OVER = ['rsi', 'price_drop', 'volume_spike'];
const SCR_NAMES = ['Quality', 'Deep value', 'Dividend', 'Banks'];

const scrFmt = (id, v) => {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const f = (SCR_COLS[id] || [])[1];
  const sign = (n) => (n < 0 ? '−' : '');
  if (f === 'pct') return `${sign(v)}${Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)}%`;
  if (f === 'bn') return Math.round(v).toLocaleString();
  if (f === 'days') return `${v > 0 ? '+' : sign(v)}${Math.abs(v).toFixed(0)}d`;
  if (f === 'pts') return `${v > 0 ? '+' : sign(v)}${Math.abs(v).toFixed(1)} pts`;
  if (f === 'x') return `${v.toFixed(1)}×`;
  if (f === 'num0') return v.toFixed(0);
  return v.toFixed(2);
};

const scrRow = (symbol, strength, oversold, vals) => ({
  symbol, exchange: 'HOSE', industry: null, strength, oversold,
  rules: Object.fromEntries(Object.entries(vals).map(([id, [value, score]]) => [id, { status: 'pass', value, score }])),
});
// Shown (read-only) when the backend is offline. Fake tickers, layout only.
const SAMPLE_RESULT = {
  counts: { universe: 1519, in_scope: 1200, passed: 5, oversold: 2, skipped: 1 },
  freshness: { prices_as_of: null, financials_as_of: null },
  skipped: [{ symbol: 'FFF', missing: ['roe_years'] }],
  rows: [
    scrRow('AAA', 82, 'yes', { roe_years: [24, 90], profit_growth: [18, 70], debt_to_equity: [0.3, 90], pe_vs_industry: [78, 60], rsi: [26, null], price_drop: [-13, null], volume_spike: [2.4, null] }),
    scrRow('BBB', 64, 'yes', { roe_years: [19, 40], profit_growth: [11, 20], debt_to_equity: [0.6, 50], pe_vs_industry: [65, 90], rsi: [28, null], price_drop: [-11, null], volume_spike: [1.8, null] }),
    scrRow('CCC', 91, 'no', { roe_years: [31, 95], profit_growth: [27, 90], debt_to_equity: [0.2, 95], pe_vs_industry: [82, 50], rsi: [52, null], price_drop: [2, null], volume_spike: [1.1, null] }),
    scrRow('DDD', 77, 'no', { roe_years: [26, 80], profit_growth: [16, 50], debt_to_equity: [0.5, 60], pe_vs_industry: [85, 45], rsi: [44, null], price_drop: [-3, null], volume_spike: [0.9, null] }),
    scrRow('EEE', 58, 'missing', { roe_years: [20, 40], profit_growth: [12, 20], debt_to_equity: [0.6, 55], pe_vs_industry: [94, 20], rsi: [null, null], price_drop: [null, null], volume_spike: [null, null] }),
  ],
};

const scrDefaultCfg = (spec) => {
  const cfg = { id: spec.id, on: false };
  Object.entries(spec.params).forEach(([k, p]) => { cfg[k] = p.default; });
  return cfg;
};

// Canonical form for dirty comparison / sending: every catalog rule, numbers as numbers.
const scrNormalize = (catalog, rules) => Object.values(catalog).map((spec) => {
  const found = rules.find(r => r.id === spec.id);
  const cfg = found ? { ...scrDefaultCfg(spec), ...found } : scrDefaultCfg(spec);
  if (spec.id === 'scope') cfg.on = true;
  Object.keys(spec.params).forEach((k) => {
    if (spec.id !== 'scope') cfg[k] = typeof cfg[k] === 'string' && cfg[k].trim() !== '' ? Number(cfg[k]) : cfg[k];
  });
  return cfg;
});

const scrPayload = (catalog, rules) => {
  const norm = scrNormalize(catalog, rules);
  const bad = norm.some(c => c.id !== 'scope' && Object.keys(catalog[c.id].params).some(k => typeof c[k] !== 'number' || Number.isNaN(c[k])));
  return bad ? null : norm;
};

const ScrToggle = ({ value, onChange, label }) => (
  <button type="button" role="switch" aria-checked={value} aria-label={label} onClick={() => onChange(!value)}
    style={{ width: 30, height: 16, borderRadius: 999, border: 'none', cursor: 'pointer', flexShrink: 0, position: 'relative',
      background: value ? 'var(--accent)' : 'var(--border-strong)', transition: 'background 150ms', padding: 0 }}>
    <span style={{ position: 'absolute', top: 2, left: value ? 16 : 2, width: 12, height: 12, borderRadius: '50%', background: 'white', transition: 'left 150ms', boxShadow: '0 1px 2px rgba(0,0,0,0.2)' }} />
  </button>
);

const ScrSegmented = ({ options, value, onChange }) => (
  <div style={{ display: 'inline-flex', background: 'var(--bg-sunken)', borderRadius: 6, padding: 2, gap: 2 }}>
    {options.map(o => (
      <button key={o.id} type="button" onClick={() => onChange(o.id)}
        style={{ padding: '4px 10px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
          background: value === o.id ? 'var(--bg-elev)' : 'transparent',
          color: value === o.id ? 'var(--text)' : 'var(--text-muted)',
          boxShadow: value === o.id ? '0 1px 2px rgba(0,0,0,0.06)' : 'none' }}>{o.label}</button>
    ))}
  </div>
);

const scrInputStyle = {
  width: 64, padding: '3px 6px', background: 'var(--bg-sunken)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', color: 'var(--text)', fontSize: 12, fontWeight: 600, textAlign: 'right',
};
const scrLinkBtn = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontFamily: 'inherit', fontSize: 12, fontWeight: 600, padding: 0 };
const scrSubtle = { fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', fontWeight: 700, color: 'var(--text-subtle)' };

// Step for wheel / arrow keys / spinner: 0.1 for small ratios (D/E, P/B, volume ×), else 1.
const scrStep = (p) => p.step || (((p.unit === 'x' || !p.unit) && p.max <= 20) ? 0.1 : 1);  // days/pts → 1

// Number box: type a value, or hover and scroll the mouse wheel (Shift = 10 steps),
// or use ↑/↓. Clamped to the rule's min/max.
const ScrNumInput = ({ value, p, onChange }) => {
  const ref = React.useRef(null);
  const step = scrStep(p);
  const latest = React.useRef({ value, onChange });
  latest.current = { value, onChange };
  const bump = React.useCallback((dir, big) => {
    const cur = parseFloat(latest.current.value);
    const base = Number.isFinite(cur) ? cur : (p.default ?? p.min ?? 0);
    const dec = step < 1 ? 1 : 0;
    let next = +(base + dir * step * (big ? 10 : 1)).toFixed(dec);
    if (p.min != null) next = Math.max(p.min, next);
    if (p.max != null) next = Math.min(p.max, next);
    latest.current.onChange(String(next));
  }, [step, p.min, p.max, p.default]);
  React.useEffect(() => {
    const el = ref.current;
    // Non-passive so the page does not scroll while adjusting the value.
    const onWheel = (e) => { e.preventDefault(); bump(e.deltaY < 0 ? 1 : -1, e.shiftKey); };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [bump]);
  return (
    <input ref={ref} type="number" className="num" value={value} min={p.min} max={p.max} step={step}
      style={scrInputStyle} title="Type a number, or scroll / ↑↓ to adjust (Shift = ×10)"
      onKeyDown={e => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault(); bump(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
        }
      }}
      onChange={e => onChange(e.target.value === '' ? '' : e.target.value)} />
  );
};

const ScrRuleRow = ({ spec, cfg, onChange }) => (
  <div className="row" style={{ gap: 10, padding: '7px 16px', borderTop: '1px solid var(--border)', opacity: cfg.on ? 1 : 0.55 }}>
    <ScrToggle value={cfg.on} onChange={(on) => onChange({ on })} label={spec.label} />
    <span style={{ flex: 1, fontSize: 13 }} title={(window.ScrPlain.PLAIN[spec.id] || {}).help || ''}>
      {(window.ScrPlain.PLAIN[spec.id] || {}).name || spec.label}
      <span style={{ display: 'block', fontSize: 11, color: 'var(--text-subtle)' }}>{spec.label}</span>
    </span>
    {Object.entries(spec.params).map(([k, p]) => (
      <label key={k} className="row" style={{ gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>
        <span className="num" style={{ textTransform: 'uppercase' }}>{k}</span>
        <ScrNumInput value={cfg[k]} p={p} onChange={v => onChange({ [k]: v })} />
        {p.unit && <span style={{ minWidth: 28 }}>{p.unit}</span>}
      </label>
    ))}
  </div>
);

// Simple view: one active check as a plain sentence with an ⓘ explanation.
const ScrPlainRule = ({ id, cfg }) => {
  const [open, setOpen] = React.useState(false);
  const P = window.ScrPlain.PLAIN[id] || { name: id, help: '' };
  return (
    <div style={{ padding: '8px 16px', borderTop: '1px solid var(--border)' }}>
      <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
        <span style={{ color: 'var(--green, #16a34a)', fontWeight: 700 }}>✓</span>
        <span style={{ flex: 1 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{P.name}</span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{window.ScrPlain.sentence(id, cfg)}</span>
          {open && <span style={{ display: 'block', fontSize: 12, color: 'var(--text-subtle)', marginTop: 4 }}>{P.help}</span>}
        </span>
        {P.help && <button type="button" onClick={() => setOpen(!open)} aria-label={`What does “${P.name}” mean?`} title={P.help}
          style={{ ...scrLinkBtn, color: open ? 'var(--accent)' : 'var(--text-subtle)', fontSize: 14 }}>ⓘ</button>}
      </div>
    </div>
  );
};

const ScrTh = ({ k, sort, onSort, children, left }) => (
  <th className={left ? '' : 'right'} onClick={() => onSort(k)} style={{ cursor: 'pointer', whiteSpace: 'nowrap' }}>
    {children}{sort.key === k && <span style={{ marginLeft: 4, color: 'var(--accent)' }}>{sort.dir === 'asc' ? '↑' : '↓'}</span>}
  </th>
);

const PageScreener = ({ setActiveAsset, setPage }) => {
  const api = window.HelixAPI;
  const [catalog, setCatalog] = React.useState(null);
  const [strategies, setStrategies] = React.useState([]);
  const [activeId, setActiveId] = React.useState(null);
  const [rules, setRules] = React.useState([]);          // working copy
  const [result, setResult] = React.useState(null);      // last good evaluate response
  const [loadErr, setLoadErr] = React.useState(null);
  const [evaluating, setEvaluating] = React.useState(false);
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [rstatus, setRstatus] = React.useState(null);  // GET /refresh
  const [sort, setSort] = React.useState({ key: 'strength', dir: 'desc' });
  const [showSkipped, setShowSkipped] = React.useState(false);
  const [advanced, setAdvancedState] = React.useState(() => { try { return localStorage.getItem('scr-advanced') === '1'; } catch (e) { return false; } });
  const setAdvanced = (v) => { setAdvancedState(v); try { localStorage.setItem('scr-advanced', v ? '1' : '0'); } catch (e) { /* ignore */ } };
  const SP = window.ScrPlain;
  const lastDone = React.useRef('');
  const seq = React.useRef(0);
  const timer = React.useRef(null);

  const toast = (msg, type = 'info') => window.toast && window.toast(msg, { type });
  const active = strategies.find(s => s.id === activeId) || null;
  const dirty = !!(catalog && active) &&
    JSON.stringify(scrNormalize(catalog, rules)) !== JSON.stringify(scrNormalize(catalog, active.rules));
  const isStarter = !!(active && active.starter_key);
  // Easy / Normal / Strict: Normal = the strategy as saved; the others move every number one step.
  const level = catalog && active ? SP.detectLevel(catalog, active.rules, rules) : 'normal';

  // Debounced evaluation (250 ms). seq is bumped when an evaluate is SCHEDULED, so any older
  // in-flight response (or pending timer) can never paint over newer rules. Failures keep the last good result.
  const evaluate = (nextRules, strategyId, immediate = false, cat = catalog) => {
    clearTimeout(timer.current);
    const mine = ++seq.current;
    const run = async () => {
      const payload = scrPayload(cat, nextRules);
      if (!payload) { setEvaluating(false); return; }    // a field is blank; wait for a number
      setEvaluating(true);
      try {
        const res = await api.screenerEvaluate(strategyId ?? null, payload);
        if (mine === seq.current) setResult(res);
      } catch (e) {
        if (mine === seq.current) toast(e.message || 'Evaluate failed', 'error');
      } finally {
        if (mine === seq.current) setEvaluating(false);
      }
    };
    if (immediate) run(); else timer.current = setTimeout(run, 250);
  };

  // Latest values for async callbacks (polling) without stale closures.
  const latest = React.useRef({});
  latest.current = { rules, activeId, dirty, catalog };

  // Refresh polling: every 5 s only while a refresh runs or is queued.
  const busy = !!(rstatus && (rstatus.running || (rstatus.queued || []).length));
  React.useEffect(() => {
    if (!busy) return undefined;
    const iv = setInterval(async () => {
      try {
        const st = await api.screenerRefreshStatus();
        const prev = lastDone.current;
        lastDone.current = `${st.running}:${st.kind}:${st.done}`;
        setRstatus(st);
        if (lastDone.current !== prev) {
          const L = latest.current;
          evaluate(L.rules, L.dirty ? null : L.activeId, true, L.catalog);
        }
      } catch (e) { /* transient; next tick retries */ }
    }, 5000);
    return () => clearInterval(iv);
  }, [busy]);

  const requestRefresh = async (kind) => {
    try {
      const st = await api.screenerRefresh(kind);
      lastDone.current = `${st.running}:${st.kind}:${st.done}`;
      setRstatus(st);
    } catch (e) {
      toast(e.status === 409 ? 'Already refreshing' : (e.message || 'Refresh failed'), e.status === 409 ? 'info' : 'error');
      if (e.status === 409) {
        try { const st = await api.screenerRefreshStatus(); lastDone.current = `${st.running}:${st.kind}:${st.done}`; setRstatus(st); } catch (e2) { /* ignore */ }
      }
    }
  };

  // Mount: catalog + strategies + last used strategy.
  React.useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const [rulesRes, strats, state] = await Promise.all([api.screenerRules(), api.screenerStrategies(), api.screenerState()]);
        api.screenerRefreshStatus().then(st => { if (!dead) { lastDone.current = `${st.running}:${st.kind}:${st.done}`; setRstatus(st); } }).catch(() => {});
        if (dead) return;
        const pick = strats.find(s => s.id === state?.last_strategy_id) || strats.find(s => s.starter_key === 'quality') || strats[0];
        setCatalog(rulesRes.catalog);
        setStrategies(strats);
        if (pick) {
          setActiveId(pick.id);
          setRules(pick.rules);
          evaluate(pick.rules, pick.id, true, rulesRes.catalog);
        }
      } catch (e) {
        if (!dead) setLoadErr(e.message || 'Could not load the screener');
      }
    })();
    return () => { dead = true; clearTimeout(timer.current); };
  }, []);

  const selectStrategy = async (s) => {
    if (s.id === activeId) return;
    if (dirty && !(await window.askConfirm({ title: 'Discard changes', message: `Discard your unsaved changes to “${active.name}”?`, confirmText: 'Discard', danger: true }))) return;
    setActiveId(s.id);
    setRules(s.rules);
    evaluate(s.rules, s.id, true);
  };

  const editRule = (id, patch) => {
    const spec = catalog[id];
    const next = rules.some(r => r.id === id)
      ? rules.map(r => r.id === id ? { ...r, ...patch } : r)
      : [...rules, { ...scrDefaultCfg(spec), ...patch }];
    setRules(next);
    evaluate(next, null);   // modified rules are not the stored strategy — don't record them as last-used
  };

  const setLevel = (lv) => {
    if (!active) return;
    const next = SP.applyLevel(catalog, active.rules, lv);
    setRules(next);
    evaluate(next, lv === 'normal' ? active.id : null, true);
  };

  const refreshList = async () => {
    const strats = await api.screenerStrategies();
    setStrategies(strats);
    return strats;
  };

  const save = async () => {
    const payload = scrPayload(catalog, rules);
    if (!payload) return toast('Fill in every number first', 'error');
    try {
      const s = await api.screenerUpdateStrategy(activeId, { rules: payload });
      await refreshList();
      setRules(s.rules);
      toast(`Saved “${s.name}”`, 'success');
      evaluate(s.rules, s.id, true);
    } catch (e) { toast(e.message || 'Save failed', 'error'); }
  };

  const saveAsNew = async () => {
    const payload = scrPayload(catalog, rules);
    if (!payload) return toast('Fill in every number first', 'error');
    const name = await window.askPrompt({ title: 'New strategy', label: 'Name', placeholder: 'e.g. My value screen', confirmText: 'Create' });
    if (!name) return;
    try {
      const s = await api.screenerCreateStrategy(name, payload);
      await refreshList();
      setActiveId(s.id); setRules(s.rules);
      toast(`Created “${s.name}”`, 'success');
      evaluate(s.rules, s.id, true);
    } catch (e) { toast(e.message || 'Create failed', 'error'); }
  };

  const discard = () => { setRules(active.rules); evaluate(active.rules, active.id, true); };

  const resetStarter = async () => {
    try {
      const s = await api.screenerResetStrategy(activeId);
      await refreshList();
      setRules(s.rules);
      toast(`Reset “${s.name}” to default`, 'success');
      evaluate(s.rules, s.id, true);
    } catch (e) { toast(e.message || 'Reset failed', 'error'); }
  };

  const rename = async () => {
    const name = await window.askPrompt({ title: 'Rename strategy', label: 'Name', value: active.name, confirmText: 'Rename' });
    if (!name || name === active.name) return;
    try {
      await api.screenerUpdateStrategy(activeId, { name });
      await refreshList();
      toast(`Renamed to “${name}”`, 'success');
    } catch (e) { toast(e.message || 'Rename failed', 'error'); }
  };

  const remove = async () => {
    if (!await window.askConfirm({ title: 'Delete strategy', message: `Delete “${active.name}”? This can't be undone.`, confirmText: 'Delete', danger: true })) return;
    try {
      await api.screenerDeleteStrategy(activeId);
      const strats = await refreshList();
      const fallback = strats.find(s => s.starter_key === 'quality') || strats[0];
      setActiveId(fallback.id); setRules(fallback.rules);
      toast('Strategy deleted', 'success');
      evaluate(fallback.rules, fallback.id, true);
    } catch (e) { toast(e.message || 'Delete failed', 'error'); }
  };

  const scopeCfg = catalog ? scrNormalize(catalog, rules).find(c => c.id === 'scope') : null;
  const banks = scopeCfg ? scopeCfg.banks : 'any';
  const exchanges = (scopeCfg && scopeCfg.exchanges) || [];
  const flagged = scopeCfg ? (scopeCfg.flagged || 'exclude') : 'exclude';
  const visible = (spec) => !(spec.applies_to === 'bank' && (banks === 'exclude' || banks === 'no_financials')) && !(spec.applies_to === 'nonbank' && banks === 'only');

  const offline = !!loadErr;
  const shown = offline ? SAMPLE_RESULT : result;
  const fmtAge = (iso) => iso ? new Date(iso).toLocaleString() : 'never';
  const fresh = (shown && shown.freshness) || {};
  const pAsOf = rstatus ? rstatus.prices_as_of : fresh.prices_as_of;
  const fAsOf = rstatus ? rstatus.financials_as_of : fresh.financials_as_of;
  const kindWord = rstatus && rstatus.kind === 'financials' ? 'financials' : 'prices';

  // ── Table model ───────────────────────────────────────────
  const rows = shown ? shown.rows : [];
  const goodIds = shown && rows.length
    ? Object.keys(SCR_COLS).filter(id => !SCR_OVER.includes(id) && rows[0].rules[id]) : [];
  const overIds = shown && rows.length ? SCR_OVER.filter(id => rows[0].rules[id]) : [];
  const dDays = (rules.find(r => r.id === 'price_drop') || {}).d || 5;
  const headerOf = (id) => (SP.PLAIN[id] ? SP.PLAIN[id].short : SCR_COLS[id][0]);
  const sortVal = (r, key) => key === 'strength' ? r.strength : key === 'symbol' ? r.symbol : (r.rules[key] && !SP.isNotApplicable(r.rules[key]) ? r.rules[key].value : null);
  const sortRows = (list) => [...list].sort((x, y) => {
    const a = sortVal(x, sort.key), b = sortVal(y, sort.key);
    if (a === null || a === undefined) return (b === null || b === undefined) ? 0 : 1;   // blanks last
    if (b === null || b === undefined) return -1;
    const c = typeof a === 'string' ? a.localeCompare(b) : a - b;
    return sort.dir === 'asc' ? c : -c;
  });
  const hot = sortRows(rows.filter(r => r.oversold === 'yes'));
  const rest = sortRows(rows.filter(r => r.oversold !== 'yes'));
  const clickSort = (key) => setSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'symbol' ? 'asc' : 'desc' });
  const colSpan = 3 + goodIds.length + overIds.length;
  const labelOf = (id) => (SP.PLAIN[id] ? SP.PLAIN[id].name : catalog && catalog[id] ? catalog[id].label : id);
  const tipOf = (id) => (SP.PLAIN[id] ? `${SP.PLAIN[id].name} — ${SP.PLAIN[id].help}` : labelOf(id));
  const ruleCfg = (id) => (catalog ? scrNormalize(catalog, rules).find(c => c.id === id) : null);
  // Row tooltip: why this ticker passed, in plain words.
  const whyOf = (r) => ['Why it passed:', ...goodIds.map((id) => {
    const c = r.rules[id];
    if (!c) return null;
    if (SP.isNotApplicable(c)) return `– ${labelOf(id)}: ${SP.NA_TIP.toLowerCase()}`;
    const how = c.score === null || c.score === undefined ? '' : c.score >= 50 ? ' (well above the bar)' : ' (just above the bar)';
    return `✓ ${labelOf(id)}: ${scrFmt(id, c.value)}${how}`;
  }).filter(Boolean), ...(r.oversold === 'yes' ? ['⚡ Price just dropped hard — possible bounce'] : [])].join('\n');

  const cellClass = (cell) => !cell || cell.score === null || cell.score === undefined ? '' : cell.score >= 66 ? 'scr-s3' : cell.score >= 33 ? 'scr-s2' : '';
  // Green dot = well above the bar, amber = just above it.
  const dot = (cell) => (!cell || cell.score === null || cell.score === undefined ? null
    : <span title={cell.score >= 50 ? 'Well above the bar' : 'Just above the bar'}
        style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', marginRight: 5, verticalAlign: 'middle',
          background: cell.score >= 50 ? 'var(--green, #16a34a)' : 'var(--amber, #d97706)' }} />);
  // "n/a" = rule not applicable to this company type: neutral, neither a fail nor missing data.
  const naCell = (id) => <td key={id} className="right scr-na" title={`${labelOf(id)}: ${SP.NA_TIP.toLowerCase()}`}>n/a</td>;
  let rank = 0;
  const renderRow = (r, isHot) => {
    rank += 1;
    return (
      <tr key={r.symbol} className={isHot ? 'scr-hot' : ''} style={{ cursor: offline ? 'default' : 'pointer' }} title={whyOf(r)}
        onClick={() => { if (!offline) { setActiveAsset && setActiveAsset('VN:' + r.symbol); setPage && setPage('detail'); } }}>
        <td className="right num" style={{ color: 'var(--text-subtle)' }}>{rank}</td>
        <td>
          <span className="ticker">{r.symbol}</span>
          {r.flag && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: 'var(--red-soft, rgba(220,38,38,0.12))', color: 'var(--red, #dc2626)' }}
            title="Exchange status (HOSE/HNX warning, control, restriction or suspension)">{SCR_FLAG_LABEL[r.flag] || r.flag}</span>}
          {r.note_latest_at && <span style={{ marginLeft: 6 }} title={`Last note ${new Date(r.note_latest_at).toLocaleDateString()}`}>📝</span>}
          {r.oversold === 'yes' && <span style={{ color: 'var(--amber, #d97706)', fontWeight: 700, marginLeft: 6 }} title="Price just dropped hard — possible bounce">⚡</span>}
          {r.oversold === 'missing' && <span style={{ color: 'var(--text-subtle)', fontSize: 11, marginLeft: 6 }}>no recent price data</span>}
        </td>
        <td>
          <span style={{ display: 'inline-block', width: 54, height: 6, borderRadius: 3, background: 'var(--bg-sunken)', verticalAlign: 'middle', marginRight: 6, overflow: 'hidden' }}>
            <i style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(100, r.strength))}%`, background: 'var(--green, #16a34a)' }} />
          </span>
          <span className="num">{r.strength}</span>
        </td>
        {goodIds.map(id => { const c = r.rules[id]; if (SP.isNotApplicable(c)) return naCell(id); return <td key={id} className={`right num ${cellClass(c)}`}>{dot(c)}{scrFmt(id, c ? c.value : null)}</td>; })}
        {overIds.map(id => { const c = r.rules[id]; if (SP.isNotApplicable(c)) return naCell(id); return <td key={id} className="right num" style={r.oversold === 'yes' ? { color: 'var(--amber, #d97706)', fontWeight: 700 } : undefined}>{scrFmt(id, c ? c.value : null)}</td>; })}
      </tr>
    );
  };

  const exportCSV = () => {
    const ids = [...goodIds, ...overIds];
    const q = v => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v;
    const out = [['#', 'Ticker', 'Oversold', 'Strength', ...ids.map(headerOf)].map(q).join(',')];
    [...hot, ...rest].forEach((r, i) => out.push([i + 1, r.symbol, r.oversold, r.strength, ...ids.map(id => { if (SP.isNotApplicable(r.rules[id])) return 'n/a'; const v = r.rules[id] ? r.rules[id].value : null; return v === null || v === undefined ? '' : v; })].map(q).join(',')));
    const url = URL.createObjectURL(new Blob([out.join('\n')], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'screener_results.csv'; a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} rows`, 'success');
  };

  const funnelBox = { border: '1px solid var(--border)', borderRadius: 6, padding: '4px 10px', fontSize: 12 };
  const emptyMarket = shown && shown.counts.universe === 0;

  const chip = (s) => (
    <button key={s.id} type="button" onClick={() => selectStrategy(s)}
      style={{ padding: '5px 12px', borderRadius: 999, fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', fontWeight: 600,
        border: `1px solid ${s.id === activeId ? 'var(--accent)' : 'var(--border)'}`,
        background: s.id === activeId ? 'var(--accent)' : 'var(--bg-elev)',
        color: s.id === activeId ? 'white' : 'var(--text)' }}
      title={SP.STRATEGY_DESC[s.starter_key] || 'Your own strategy'}>{s.name}</button>
  );
  const starters = strategies.filter(s => s.starter_key);
  const mine = strategies.filter(s => !s.starter_key);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Stock screener.</h1>
          <p className="page-sub">Pick a strategy, tweak the rules, see who passes</p>
        </div>
        <div className="row">
          <button className="btn" disabled={offline || busy} onClick={() => requestRefresh('financials')}>Refresh financials</button>
          <button className="btn btn-primary" disabled={offline || busy} onClick={() => requestRefresh('prices')}>Refresh prices ↻</button>
        </div>
      </div>

      {offline && (
        <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={scrSubtle}>Strategy</span>
          {SCR_NAMES.map((n, i) => (
            <span key={n} style={{ padding: '5px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, opacity: 0.6, border: `1px solid ${i === 0 ? 'var(--accent)' : 'var(--border)'}`, background: i === 0 ? 'var(--accent)' : 'var(--bg-elev)', color: i === 0 ? 'white' : 'var(--text)' }}>{n}</span>
          ))}
          <span title={loadErr} style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', padding: '2px 7px', borderRadius: 999, background: 'var(--bg-sunken)', color: 'var(--text-muted)', border: '1px solid var(--border)' }}>Sample data — backend offline</span>
        </div>
      )}

      {catalog && (
        <>
          <div className="row" style={{ gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <span style={scrSubtle}>Strategy</span>
            {starters.map(chip)}
            {mine.map(chip)}
            <button type="button" onClick={saveAsNew}
              style={{ padding: '5px 12px', borderRadius: 999, fontSize: 12, fontFamily: 'inherit', cursor: 'pointer', fontWeight: 600, border: '1px dashed var(--border-strong)', background: 'transparent', color: 'var(--text-muted)' }}>+ My own</button>
          </div>
          {active && (
            <div style={{ marginTop: -8, marginBottom: 16, fontSize: 13, color: 'var(--text-muted)' }}>
              <b style={{ color: 'var(--text)' }}>{active.name}:</b> {SP.STRATEGY_DESC[active.starter_key] || 'Your own strategy'}
            </div>
          )}

          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <h3 className="card-title">{advanced ? 'Advanced rules' : 'What we look for'}{active ? ` — ${active.name}` : ''}</h3>
              <div className="row" style={{ gap: 12 }}>
                {dirty && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>Modified</span>}
                {dirty && <button style={scrLinkBtn} onClick={save}>Save</button>}
                {dirty && <button style={scrLinkBtn} onClick={saveAsNew}>Save as new</button>}
                {dirty && <button style={scrLinkBtn} onClick={discard}>Discard</button>}
                {isStarter && <button style={scrLinkBtn} onClick={resetStarter}>Reset to default</button>}
                {active && !isStarter && <button style={scrLinkBtn} onClick={rename}>Rename</button>}
                {active && !isStarter && <button style={{ ...scrLinkBtn, color: 'var(--red, #dc2626)' }} onClick={remove}>Delete</button>}
                <button className="card-action" onClick={() => setAdvanced(!advanced)} title="Show every rule and its exact numbers">{advanced ? 'Simple view' : 'Advanced ⚙'}</button>
                <button className="card-action" onClick={() => setPanelOpen(!panelOpen)}>{panelOpen ? 'Collapse ▴' : 'Expand ▾'}</button>
              </div>
            </div>
            {panelOpen && !advanced && (
              <div className="card-body flush">
                <div className="row" style={{ gap: 10, padding: '12px 16px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>How picky?</span>
                  {level === 'custom' && <span style={{ fontSize: 11, color: 'var(--text-subtle)' }} title="You changed numbers in Advanced">Custom numbers</span>}
                  <ScrSegmented value={level} onChange={setLevel}
                    options={SP.LEVELS.map(id => ({ id, label: SP.LEVEL_LABEL[id] }))} />
                </div>
                <div style={{ padding: '0 16px 10px', fontSize: 12, color: 'var(--text-subtle)' }}>
                  Easy shows more stocks, Strict shows only the best. {SP.scopeSummary(scopeCfg)}.
                </div>
                <div style={{ ...scrSubtle, padding: '10px 16px 4px', borderTop: '1px solid var(--border)' }}>A stock must pass every check</div>
                {Object.values(catalog).filter(sp => sp.stage === 'good' && visible(sp) && (ruleCfg(sp.id) || {}).on).map(sp => (
                  <ScrPlainRule key={sp.id} id={sp.id} cfg={ruleCfg(sp.id)} />
                ))}
                {SCR_OVER.some(id => (ruleCfg(id) || {}).on) && (
                  <>
                    <div style={{ ...scrSubtle, padding: '10px 16px 4px', borderTop: '1px solid var(--border)' }}>⚡ Bounce signal — marks passing stocks whose price just dropped hard</div>
                    {SCR_OVER.filter(id => (ruleCfg(id) || {}).on).map(id => <ScrPlainRule key={id} id={id} cfg={ruleCfg(id)} />)}
                  </>
                )}
              </div>
            )}
            {panelOpen && advanced && (
              <div className="card-body flush">
                <div className="row" style={{ gap: 10, padding: '10px 16px' }}>
                  <span style={{ ...scrSubtle, flex: 1 }}>Scope · banks</span>
                  <ScrSegmented value={banks} onChange={(v) => editRule('scope', { banks: v })}
                    options={Object.entries(SCR_BANK_OPTS).filter(([k]) => catalog.scope.params.banks.options.includes(k)).map(([id, label]) => ({ id, label }))} />
                </div>
                {catalog.scope.params.exchanges && (
                  <div className="row" style={{ gap: 10, padding: '0 16px 10px' }}>
                    <span style={{ ...scrSubtle, flex: 1 }} title="None selected = all exchanges">Scope · exchanges</span>
                    <div style={{ display: 'inline-flex', gap: 4 }}>
                      {SCR_EXCHANGES.map(ex => {
                        const on = exchanges.includes(ex);
                        return (
                          <button key={ex} type="button" aria-pressed={on}
                            onClick={() => editRule('scope', { exchanges: on ? exchanges.filter(e => e !== ex) : [...exchanges, ex] })}
                            style={{ padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, fontFamily: 'inherit', cursor: 'pointer',
                              border: '1px solid ' + (on ? 'var(--accent)' : 'var(--border)'),
                              background: on ? 'var(--accent-soft, var(--bg-sunken))' : 'transparent',
                              color: on ? 'var(--accent)' : 'var(--text-muted)' }}>{ex}</button>
                        );
                      })}
                      {exchanges.length === 0 && <span style={{ fontSize: 11, color: 'var(--text-subtle)', alignSelf: 'center', marginLeft: 4 }}>all</span>}
                    </div>
                  </div>
                )}
                {catalog.scope.params.flagged && (
                  <div className="row" style={{ gap: 10, padding: '0 16px 10px' }}>
                    <ScrToggle value={flagged === 'exclude'} label="Hide warned / controlled stocks"
                      onChange={(on) => editRule('scope', { flagged: on ? 'exclude' : 'include' })} />
                    <span style={{ flex: 1, fontSize: 13 }}>Hide stocks under exchange warning, control, restriction or suspension</span>
                  </div>
                )}
                {SCR_STAGES.map(stage => (
                  <div key={stage.id}>
                    <div style={{ ...scrSubtle, padding: '10px 16px 4px', borderTop: '1px solid var(--border)' }}>{stage.title}</div>
                    {Object.values(catalog).filter(sp => sp.stage === stage.id && visible(sp)).map(sp => {
                      const cfg = scrNormalize(catalog, rules).find(c => c.id === sp.id);
                      const raw = rules.find(r => r.id === sp.id);
                      const shownCfg = raw ? { ...cfg, ...Object.fromEntries(Object.keys(sp.params).map(k => [k, raw[k]])) } : cfg;
                      return <ScrRuleRow key={sp.id} spec={sp} cfg={shownCfg} onChange={(patch) => editRule(sp.id, patch)} />;
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {!shown && catalog && !evaluating && (
        <div className="card"><div className="card-body" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Could not evaluate the rules. <button type="button" style={scrLinkBtn} onClick={() => evaluate(rules, dirty ? null : activeId, true)}>Retry</button>
        </div></div>
      )}

      {shown && (
        <>
          <div className="row" style={{ gap: 6, marginBottom: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-subtle)' }}>
            <span>Prices as of {fmtAge(pAsOf)} · financials as of {fmtAge(fAsOf)}</span>
            <span>·</span>
            <span title="Broad-scan data is third-party (vnstock) and unverified — for screening only. Deep-dive a symbol to verify." style={{ fontWeight: 700, letterSpacing: '0.06em' }}>UNVERIFIED</span>
            {rstatus && rstatus.running && <span>· {rstatus.total > 0 ? `Refreshing ${kindWord} ${rstatus.done.toLocaleString()} / ${rstatus.total.toLocaleString()}…` : `Refreshing ${kindWord}…`}</span>}
            {rstatus && rstatus.last_error &&<span style={{ opacity: 0.7 }}>· last error: {rstatus.last_error}</span>}
            {evaluating && <span>· evaluating…</span>}
          </div>

          <div className="row" style={{ gap: 6, marginBottom: 12, flexWrap: 'wrap', fontSize: 12 }}>
            <span style={funnelBox}>Whole market <b className="num">{shown.counts.universe.toLocaleString()}</b></span> →
            <span style={funnelBox}>Pass every check <b className="num">{shown.counts.passed.toLocaleString()}</b></span> →
            <span style={{ ...funnelBox, borderColor: 'var(--amber, #d97706)', color: 'var(--amber, #d97706)' }}>Bounce chance now <b className="num">{shown.counts.oversold.toLocaleString()}</b> ⚡</span>
            {shown.counts.skipped > 0 && (
              <button type="button" style={{ ...scrLinkBtn, marginLeft: 'auto' }} onClick={() => setShowSkipped(!showSkipped)}>
                {shown.counts.skipped.toLocaleString()} skipped, missing data {showSkipped ? '▴' : '▾'}
              </button>
            )}
          </div>

          {showSkipped && (
            <div className="card" style={{ marginBottom: 12, maxHeight: 220, overflow: 'auto' }}>
              <div className="card-body flush">
                {(shown.skipped || []).map(sk => (
                  <div key={sk.symbol} className="row" style={{ gap: 10, padding: '6px 16px', borderTop: '1px solid var(--border)', fontSize: 12 }}>
                    <span className="ticker" style={{ minWidth: 56 }}>{sk.symbol}</span>
                    <span style={{ color: 'var(--text-muted)' }}>missing: {sk.missing.map(labelOf).join(' · ')}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-header">
              <h3 className="card-title">{rows.length.toLocaleString()} passing</h3>
              <button className="btn" onClick={exportCSV} disabled={!rows.length}><Icon name="download" size={12} /> Export</button>
            </div>
            <div className="card-body flush" style={{ overflowX: 'auto' }}>
              {emptyMarket ? (
                <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
                  <div style={{ marginBottom: 12 }}>No market data yet. Refresh prices and financials to start.</div>
                  <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
                    <button className="btn" disabled={busy} onClick={() => requestRefresh('financials')}>Refresh financials</button>
                    <button className="btn btn-primary" disabled={busy} onClick={() => requestRefresh('prices')}>Refresh prices ↻</button>
                  </div>
                </div>
              ) : rows.length === 0 ? (
                <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No stock passes every check. Try <b>Easy</b> under “How picky?”.</div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th className="right">#</th>
                      <ScrTh sort={sort} onSort={clickSort} k="symbol" left>Ticker</ScrTh>
                      <ScrTh sort={sort} onSort={clickSort} k="strength" left><span title="0–100: how far past the bar the stock is, on average over all checks">Score</span></ScrTh>
                      {goodIds.map(id => <ScrTh key={id} sort={sort} onSort={clickSort} k={id}><span title={tipOf(id)}>{headerOf(id)}</span></ScrTh>)}
                      {overIds.map(id => <ScrTh key={id} sort={sort} onSort={clickSort} k={id}><span title={tipOf(id)}>{headerOf(id)}</span></ScrTh>)}
                    </tr>
                  </thead>
                  <tbody>
                    {hot.length > 0 && <tr className="scr-sep"><td colSpan={colSpan} style={{ ...scrSubtle, textAlign: 'left', paddingTop: 12 }}>⚡ Good company, price just dropped hard — possible bounce</td></tr>}
                    {hot.map(r => renderRow(r, true))}
                    {rest.length > 0 && <tr className="scr-sep"><td colSpan={colSpan} style={{ ...scrSubtle, textAlign: 'left', paddingTop: 12 }}>Good companies</td></tr>}
                    {rest.map(r => renderRow(r, false))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <style>{`
            .scr-hot td { background: color-mix(in srgb, var(--amber, #d97706) 10%, transparent); }
            .scr-s3 { color: var(--green, #16a34a); font-weight: 700; }
            .scr-s2 { color: var(--green, #16a34a); }
            .scr-na { color: var(--text-subtle); font-style: italic; cursor: help; }
          `}</style>
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-subtle)' }}>
            Every stock here passed all the checks. Score = how far past the bar, 0–100. <span style={{ color: 'var(--green, #16a34a)' }}>●</span> well above the bar · <span style={{ color: 'var(--amber, #d97706)' }}>●</span> just above it. <i>n/a</i> = not applicable to this company type. Hover a row to see why it passed, hover a column name for what it means, click a column to sort.
          </div>
        </>
      )}
    </div>
  );
};

window.PageScreener = PageScreener;
