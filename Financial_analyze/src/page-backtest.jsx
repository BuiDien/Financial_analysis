// Backtest — replay a long-only strategy on past daily bars and compare it to
// buy-and-hold. Live backend only (no mock data): POST /api/backtest/run.

const BT_MARKET_DEFAULTS = {
  VN: { capital: '100,000,000', fee: '0.15', tax: '0.1' },
  US: { capital: '10,000', fee: '0', tax: '0' },
};

const btIsoDate = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const btDefaultStart = () => { const d = new Date(); d.setFullYear(d.getFullYear() - 5); return btIsoDate(d); };
const btTime = (date) => Math.floor(Date.parse(String(date).slice(0, 10) + 'T00:00:00Z') / 1000);

const btMoney = (value, currency = 'USD') => {
  if (value == null) return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const digits = currency === 'VND' ? 0 : 2;
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n); }
  catch { return `${currency} ${n.toLocaleString(undefined, { maximumFractionDigits: digits })}`; }
};
const btPct = (value, signed = true) => {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  return `${signed && n > 0 ? '+' : ''}${n.toFixed(2)}%`;
};
const btNum = (value, digits = 2) => (value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits));
const btSign = (value) => (value == null || !Number.isFinite(Number(value)) ? '' : Number(value) >= 0 ? 'pos' : 'neg');
// Blank input → null (server applies the market default); commas allowed in capital.
const btOptNumber = (s) => {
  const t = String(s ?? '').replace(/,/g, '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

const BT_FIELD = { width: '100%', padding: '9px 11px', background: 'var(--bg-sunken)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 5, fontFamily: 'inherit' };
const BT_LABEL = { display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 5 };

const BtField = ({ label, children, hint }) => (
  <div>
    <label style={BT_LABEL}>{label}</label>
    {children}
    {hint && <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginTop: 5 }}>{hint}</div>}
  </div>
);

const BtMetric = ({ label, value, bench, tone }) => (
  <div className="stat">
    <div className="stat-label">{label}</div>
    <div className={`stat-value num ${tone || ''}`} style={{ fontSize: 22 }}>{value}</div>
    {bench !== undefined && <div className="stat-delta" style={{ color: 'var(--text-muted)', fontSize: 12 }}>Buy &amp; hold: <span className="num">{bench}</span></div>}
  </div>
);

const btSettingsNote = (ticker, s) => {
  if (!s) return '';
  const market = String(ticker || '').toUpperCase().startsWith('VN:') ? 'VN' : 'US';
  const parts = [`lot ${Number(s.lot_size).toLocaleString()}`, `fee ${s.fee_pct}%`, `tax ${s.sell_tax_pct}%`];
  if (s.min_hold_bars > 0) {
    parts.push(`sells settle T+${s.min_hold_bars - 1} (earliest sell ${s.min_hold_bars} sessions after buy)`);
  }
  return `${market}: ${parts.join(' · ')}`;
};

const PageBacktest = () => {
  const api = window.HelixAPI;
  const [live, setLive] = React.useState(!!api?.live);
  const [checking, setChecking] = React.useState(!!api && !api.checked);
  const [strategies, setStrategies] = React.useState([]);
  const [strategyId, setStrategyId] = React.useState('');
  const [params, setParams] = React.useState({});
  const [ticker, setTicker] = React.useState('VN:VNM');
  const [start, setStart] = React.useState(btDefaultStart);
  const [end, setEnd] = React.useState(() => btIsoDate(new Date()));
  const [capital, setCapital] = React.useState('');
  const [fee, setFee] = React.useState('');
  const [tax, setTax] = React.useState('');
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState('');
  const [result, setResult] = React.useState(null);
  const [runId, setRunId] = React.useState(0);

  const connect = React.useCallback(async (force = false) => {
    if (!api) { setLive(false); setChecking(false); return; }
    setChecking(true);
    try { if (force || !api.checked) await api.detect(); } catch {}
    setLive(!!api.live);
    setChecking(false);
  }, [api]);

  React.useEffect(() => { connect(); }, [connect]);

  // Load the strategy catalogue once the backend is reachable.
  React.useEffect(() => {
    if (!live) return;
    let cancelled = false;
    api.backtestStrategies()
      .then(list => {
        if (cancelled || !Array.isArray(list)) return;
        setStrategies(list);
        const initial = list.find(s => s.id === 'sma_cross') || list[0];
        if (initial) {
          setStrategyId(id => id || initial.id);
        }
      })
      .catch(e => { if (!cancelled) setError(e.message || String(e)); });
    return () => { cancelled = true; };
  }, [live]);

  const strategy = strategies.find(s => s.id === strategyId) || null;

  // Reset params to the strategy's defaults whenever the strategy changes.
  React.useEffect(() => {
    if (!strategy) return;
    setParams(Object.fromEntries((strategy.params || []).map(p => [p.key, String(p.default)])));
  }, [strategyId, strategies.length]);

  const market = ticker.trim().toUpperCase().startsWith('VN:') ? 'VN' : 'US';
  const defaults = BT_MARKET_DEFAULTS[market];

  const run = async () => {
    setError('');
    const t = ticker.trim().toUpperCase();
    if (!t) { setError('Enter a ticker.'); return; }
    if (!strategy) { setError('Choose a strategy.'); return; }
    const numParams = {};
    for (const p of strategy.params || []) {
      const n = Number(params[p.key]);
      if (params[p.key] === '' || !Number.isFinite(n)) { setError(`${p.label} must be a number.`); return; }
      numParams[p.key] = n;
    }
    const body = {
      ticker: t, strategy: strategy.id, params: numParams, start, end,
      initial_capital: btOptNumber(capital), fee_pct: btOptNumber(fee), sell_tax_pct: btOptNumber(tax),
    };
    for (const [k, label] of [['initial_capital', 'Capital'], ['fee_pct', 'Fee %'], ['sell_tax_pct', 'Sell tax %']]) {
      if (Number.isNaN(body[k])) { setError(`${label} must be a number.`); return; }
    }
    setRunning(true);
    try {
      const res = await api.backtestRun(body);
      setResult(res);
      setRunId(n => n + 1);
    } catch (e) {
      setError(e.message || String(e));
    }
    setRunning(false);
  };

  // Chart inputs — memoized so LWChart only re-pushes data on a new run.
  const scale = Number(result?.settings?.price_scale) || 1;
  const equityLines = React.useMemo(() => {
    if (!result) return null;
    const toLine = rows => (rows || []).map(r => ({ time: btTime(r.date), value: Number(r.value) })).filter(p => Number.isFinite(p.time) && Number.isFinite(p.value));
    return [
      { data: toLine(result.equity), color: 'var(--accent)', title: 'Strategy' },
      { data: toLine(result.benchmark_equity), color: 'var(--text-muted)', title: 'Buy & hold' },
    ];
  }, [result]);
  const bars = React.useMemo(() => (result?.bars || []).map(b => ({
    time: btTime(b.date), open: b.open * scale, high: b.high * scale, low: b.low * scale, close: b.close * scale, volume: b.volume,
  })), [result, scale]);
  const markers = React.useMemo(() => {
    const out = [];
    for (const t of result?.trades || []) {
      out.push({ time: btTime(t.entry_date), kind: 'BUY', quantity: t.shares });
      if (!t.open && t.exit_date) out.push({ time: btTime(t.exit_date), kind: 'SELL', quantity: t.shares });
    }
    return out;
  }, [result]);
  const emptyData = React.useMemo(() => [], []);

  const ccy = result?.currency || 'USD';
  const m = result?.metrics || {};
  const b = result?.benchmark_metrics || {};

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Backtest</h1>
          <p className="page-sub">Replay a strategy on past daily prices and compare it to buy-and-hold. Signals decide at the close and fill at the next open.</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header"><h3 className="card-title">Setup</h3></div>
        <div className="card-body stack">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <BtField label="Ticker">
              <input style={BT_FIELD} value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} placeholder="VN:VNM or AAPL"
                onKeyDown={e => { if (e.key === 'Enter' && live && !running) run(); }} />
              <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginTop: 4 }}>VN stocks: VN:VNM · US: AAPL</div>
            </BtField>
            <BtField label="Strategy">
              <select style={BT_FIELD} value={strategyId} disabled={!strategies.length} onChange={e => setStrategyId(e.target.value)}>
                {!strategies.length && <option value="">{live ? 'Loading…' : '—'}</option>}
                {strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </BtField>
            <BtField label="Start">
              <input style={BT_FIELD} type="date" value={start} max={end} onChange={e => setStart(e.target.value)} />
            </BtField>
            <BtField label="End">
              <input style={BT_FIELD} type="date" value={end} min={start} onChange={e => setEnd(e.target.value)} />
            </BtField>
          </div>
          {strategy?.description && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{strategy.description}</div>}

          {strategy?.params?.length > 0 && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              {strategy.params.map(p => (
                <BtField key={p.key} label={p.label}>
                  <input style={BT_FIELD} type="number" min={p.min} max={p.max} step={p.step}
                    value={params[p.key] ?? ''} onChange={e => setParams(prev => ({ ...prev, [p.key]: e.target.value }))} />
                </BtField>
              ))}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <BtField label="Capital">
              <input style={BT_FIELD} inputMode="decimal" value={capital} onChange={e => setCapital(e.target.value)} placeholder={defaults.capital} />
            </BtField>
            <BtField label="Fee %">
              <input style={BT_FIELD} type="number" min="0" step="0.01" value={fee} onChange={e => setFee(e.target.value)} placeholder={defaults.fee} />
            </BtField>
            <BtField label="Sell tax %">
              <input style={BT_FIELD} type="number" min="0" step="0.01" value={tax} onChange={e => setTax(e.target.value)} placeholder={defaults.tax} />
            </BtField>
          </div>
        </div>
        <div className="card-header" style={{ justifyContent: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          {checking ? (
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Checking backend…</span>
          ) : live ? (
            <>
              <button className="btn btn-primary" disabled={running || !strategy} onClick={run}>{running ? 'Running…' : 'Run backtest'}</button>
              {error && <span style={{ color: 'var(--neg)', fontSize: 12 }}>{error}</span>}
            </>
          ) : (
            <>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Backend offline — start the backend to run backtests.</span>
              <button className="btn" onClick={() => connect(true)}>Retry</button>
            </>
          )}
        </div>
      </div>

      {result && (
        <>
          <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
            <span className="ticker">{result.ticker}</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{result.strategy?.name} · {result.start} → {result.end} · capital {btMoney(result.settings?.initial_capital, ccy)}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginBottom: 12 }}>{btSettingsNote(result.ticker, result.settings)}</div>

          <div className="stat-grid" style={{ marginBottom: 20 }}>
            <BtMetric label="Total return" value={btPct(m.total_return_pct)} bench={btPct(b.total_return_pct)} tone={btSign(m.total_return_pct)} />
            <BtMetric label="CAGR" value={btPct(m.cagr_pct)} bench={btPct(b.cagr_pct)} tone={btSign(m.cagr_pct)} />
            <BtMetric label="Max drawdown" value={btPct(m.max_drawdown_pct)} bench={btPct(b.max_drawdown_pct)} />
            <BtMetric label="Sharpe" value={btNum(m.sharpe)} bench={btNum(b.sharpe)} />
          </div>
          <div className="stat-grid" style={{ marginBottom: 20 }}>
            <BtMetric label="Trades" value={m.trades == null ? '—' : Number(m.trades).toLocaleString()} />
            <BtMetric label="Win rate" value={btPct(m.win_rate_pct, false)} />
            <BtMetric label="Exposure" value={btPct(m.exposure_pct, false)} />
            <BtMetric label="Final equity" value={btMoney(m.final_equity, ccy)} bench={btMoney(b.final_equity, ccy)} />
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <h3 className="card-title">Equity</h3>
              <div className="row" style={{ gap: 14, fontSize: 11, color: 'var(--text-muted)' }}>
                <span className="row" style={{ gap: 6 }}><span style={{ width: 14, height: 2, background: 'var(--accent)', display: 'inline-block' }} />Strategy</span>
                <span className="row" style={{ gap: 6 }}><span style={{ width: 14, height: 2, background: 'var(--text-muted)', display: 'inline-block' }} />Buy &amp; hold</span>
              </div>
            </div>
            <div className="card-body">
              <LWChart key={`eq-${runId}`} type="area" volume={false} height={300} range="1D" data={emptyData} lines={equityLines} />
            </div>
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <h3 className="card-title">Price &amp; trades</h3>
              <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>B = buy fill · S = sell fill</span>
            </div>
            <div className="card-body">
              {bars.length > 1
                ? <LWChart key={`px-${runId}`} type="candle" height={380} range="1D" volume={true} data={bars} markers={markers} />
                : <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-subtle)' }}>No price bars in range.</div>}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <h3 className="card-title">Trades</h3>
              <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{(() => {
                const all = result.trades || [];
                const open = all.filter(t => t.open).length;
                return `${all.length - open} closed${open ? ` · ${open} open` : ''}`;
              })()}</span>
            </div>
            <div className="card-body flush" style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Entry date</th><th className="right">Entry price</th><th>Exit date</th><th className="right">Exit price</th>
                    <th className="right">Shares</th><th className="right">Sessions held</th><th className="right">P/L</th><th className="right">Return %</th>
                  </tr>
                </thead>
                <tbody>
                  {(result.trades || []).map((t, i) => (
                    <tr key={`${t.entry_date}-${i}`}>
                      <td className="num">{t.entry_date}</td>
                      <td className="right num">{btMoney(t.entry_price == null ? null : t.entry_price * scale, ccy)}</td>
                      <td className="num">{t.open ? <span className="pill">open</span> : (t.exit_date || '—')}</td>
                      <td className="right num">{btMoney(t.exit_price == null ? null : t.exit_price * scale, ccy)}</td>
                      <td className="right num">{t.shares == null ? '—' : Number(t.shares).toLocaleString()}</td>
                      <td className="right num">{t.bars_held ?? '—'}</td>
                      <td className="right"><span className={`num ${btSign(t.pnl)}`}>{btMoney(t.pnl, ccy)}</span></td>
                      <td className="right"><span className={`num ${btSign(t.return_pct)}`}>{btPct(t.return_pct)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!(result.trades || []).length && <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-subtle)' }}>No trades in this period.</div>}
              {Number(result.skipped_buys) > 0 && (
                <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text-muted)' }}>
                  {Number(result.skipped_buys).toLocaleString()} buy signals could not be filled — capital is below the cost of one lot (lot × price).
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

window.PageBacktest = PageBacktest;
