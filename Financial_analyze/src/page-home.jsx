// Home — real-time watch board for indices, commodities (gold), and stocks.
// Live-polls the backend when reachable; otherwise simulates gentle ticks so
// the board always feels alive. Watch list is editable and persists locally.

const HOME_WATCH_KEY = 'helix_home_watch_v1';

// Catalog of trackable instruments. `seed` drives the mock price walk.
const INSTRUMENTS = {
  // Indices
  'SPX':  { name: 'S&P 500', cls: 'Index', base: 5847.32, dp: 2 },
  'NDX':  { name: 'Nasdaq 100', cls: 'Index', base: 20634.21, dp: 2 },
  'DJI':  { name: 'Dow Jones', cls: 'Index', base: 42893.11, dp: 2 },
  'RUT':  { name: 'Russell 2000', cls: 'Index', base: 2341.55, dp: 2 },
  'VIX':  { name: 'Volatility Index', cls: 'Index', base: 14.23, dp: 2 },
  'FTSE': { name: 'FTSE 100', cls: 'Index', base: 8234.10, dp: 2 },
  'N225': { name: 'Nikkei 225', cls: 'Index', base: 38901.40, dp: 2 },
  // Commodities
  'XAU':  { name: 'Gold (spot /oz)', cls: 'Commodity', base: 2683.10, dp: 2, unit: '$' },
  'XAG':  { name: 'Silver (spot /oz)', cls: 'Commodity', base: 31.42, dp: 2, unit: '$' },
  'WTI':  { name: 'Crude Oil WTI', cls: 'Commodity', base: 71.24, dp: 2, unit: '$' },
  'NG':   { name: 'Natural Gas', cls: 'Commodity', base: 2.94, dp: 3, unit: '$' },
  'HG':   { name: 'Copper /lb', cls: 'Commodity', base: 4.21, dp: 3, unit: '$' },
  // Rates / FX
  'US10Y':{ name: 'US 10Y Yield', cls: 'Rates', base: 4.21, dp: 2, unit: '%' },
  'DXY':  { name: 'US Dollar Index', cls: 'Rates', base: 106.43, dp: 2 },
  'BTC':  { name: 'Bitcoin', cls: 'Crypto', base: 98234.50, dp: 2, unit: '$' },
  // Stocks
  'NVDA': { name: 'NVIDIA', cls: 'Stock', base: 142.36, dp: 2, unit: '$' },
  'AAPL': { name: 'Apple', cls: 'Stock', base: 234.18, dp: 2, unit: '$' },
  'MSFT': { name: 'Microsoft', cls: 'Stock', base: 421.95, dp: 2, unit: '$' },
  'TSLA': { name: 'Tesla', cls: 'Stock', base: 348.67, dp: 2, unit: '$' },
  'AMZN': { name: 'Amazon', cls: 'Stock', base: 218.94, dp: 2, unit: '$' },
  'GOOGL':{ name: 'Alphabet', cls: 'Stock', base: 178.42, dp: 2, unit: '$' },
  'META': { name: 'Meta', cls: 'Stock', base: 587.23, dp: 2, unit: '$' },
  'GLD':  { name: 'SPDR Gold Shares', cls: 'Stock', base: 248.30, dp: 2, unit: '$' },
  'NEM':  { name: 'Newmont (gold miner)', cls: 'Stock', base: 42.18, dp: 2, unit: '$' },
};

// Map of our symbols to backend tickers for live quotes (yfinance)
const LIVE_TICKER = {
  SPX: '^GSPC', NDX: '^NDX', DJI: '^DJI', RUT: '^RUT', VIX: '^VIX',
  FTSE: '^FTSE', N225: '^N225', XAU: 'GC=F', XAG: 'SI=F', WTI: 'CL=F',
  NG: 'NG=F', HG: 'HG=F', US10Y: '^TNX', DXY: 'DX-Y.NYB', BTC: 'BTC-USD',
  NVDA: 'NVDA', AAPL: 'AAPL', MSFT: 'MSFT', TSLA: 'TSLA', AMZN: 'AMZN',
  GOOGL: 'GOOGL', META: 'META', GLD: 'GLD', NEM: 'NEM',
};

const DEFAULT_WATCH = ['XAU', 'SPX', 'NDX', 'US10Y', 'NVDA', 'BTC', 'WTI', 'VIX'];

// Display currencies with approximate FX rates vs USD (1 USD = rate units).
// Dollar-denominated instruments are converted; indices, %, and DXY are not.
const HOME_CCY = {
  USD: { symbol: '$', rate: 1 },
  EUR: { symbol: '€', rate: 0.92 },
  GBP: { symbol: '£', rate: 0.79 },
  JPY: { symbol: '¥', rate: 157.0 },
  CAD: { symbol: 'C$', rate: 1.37 },
  AUD: { symbol: 'A$', rate: 1.51 },
  CHF: { symbol: 'Fr', rate: 0.88 },
  CNY: { symbol: '¥', rate: 7.24 },
};
const CURRENCY_KEY = 'helix_home_currency_v1';

const loadWatch = () => {
  try {
    const s = JSON.parse(localStorage.getItem(HOME_WATCH_KEY));
    if (Array.isArray(s) && s.length) return s.filter(x => INSTRUMENTS[x]);
  } catch {}
  return DEFAULT_WATCH;
};

// Seeded random walk for a sparkline + live tick feel (mock mode)
const makeSeries = (base, seed, n = 40) => {
  let s = seed * 7919;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const out = [];
  let v = base * (0.97 + rnd() * 0.02);
  for (let i = 0; i < n; i++) {
    v = v * (1 + (rnd() - 0.5) * 0.006);
    out.push(v);
  }
  out[out.length - 1] = base;
  return out;
};

const PageHome = ({ setActiveAsset, setPage }) => {
  const [watch, setWatch] = React.useState(loadWatch);
  const [focus, setFocus] = React.useState(() => loadWatch()[0]);
  const [showAdd, setShowAdd] = React.useState(false);
  const [live, setLive] = React.useState(!!window.HelixAPI?.live);
  const [now, setNow] = React.useState(new Date());
  const [currency, setCurrency] = React.useState(() => localStorage.getItem(CURRENCY_KEY) || 'USD');
  React.useEffect(() => { localStorage.setItem(CURRENCY_KEY, currency); }, [currency]);

  // Per-symbol live state: { price, chg, series }
  const [quotes, setQuotes] = React.useState(() => {
    const q = {};
    watch.forEach((sym, i) => {
      const inst = INSTRUMENTS[sym];
      const series = makeSeries(inst.base, sym.charCodeAt(0) + i);
      const prevClose = series[0];
      q[sym] = { price: inst.base, chg: ((inst.base - prevClose) / prevClose) * 100, series };
    });
    return q;
  });

  React.useEffect(() => { localStorage.setItem(HOME_WATCH_KEY, JSON.stringify(watch)); }, [watch]);

  // Ensure new symbols get a series
  React.useEffect(() => {
    setQuotes(prev => {
      const next = { ...prev };
      watch.forEach((sym, i) => {
        if (!next[sym]) {
          const inst = INSTRUMENTS[sym];
          const series = makeSeries(inst.base, sym.charCodeAt(0) + i);
          next[sym] = { price: inst.base, chg: ((inst.base - series[0]) / series[0]) * 100, series };
        }
      });
      return next;
    });
  }, [watch]);

  // Clock
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Live polling (backend) OR simulated ticks (mock)
  React.useEffect(() => {
    let cancelled = false;

    const tickMock = () => {
      setQuotes(prev => {
        const next = { ...prev };
        for (const sym of watch) {
          const cur = next[sym];
          if (!cur) continue;
          const drift = (Math.random() - 0.5) * 0.0016;
          const price = cur.price * (1 + drift);
          const series = [...cur.series.slice(1), price];
          const prevClose = series[0];
          next[sym] = { price, chg: ((price - prevClose) / prevClose) * 100, series };
        }
        return next;
      });
    };

    const pollLive = async () => {
      try {
        const results = await Promise.all(watch.map(sym =>
          window.HelixAPI.quote(LIVE_TICKER[sym] || sym).then(q => ({ sym, q })).catch(() => null)));
        if (cancelled) return;
        setQuotes(prev => {
          const next = { ...prev };
          for (const r of results) {
            if (r && r.q && r.q.price) {
              const cur = next[r.sym] || { series: makeSeries(r.q.price, 1) };
              const series = [...cur.series.slice(1), r.q.price];
              next[r.sym] = { price: r.q.price, chg: r.q.change_pct ?? cur.chg ?? 0, series };
            }
          }
          return next;
        });
      } catch {}
    };

    const interval = setInterval(() => {
      if (window.HelixAPI?.live) { setLive(true); pollLive(); }
      else { setLive(false); tickMock(); }
    }, 2000);

    return () => { cancelled = true; clearInterval(interval); };
  }, [watch]);

  const addInstrument = (sym) => { if (!watch.includes(sym)) setWatch(w => [...w, sym]); setShowAdd(false); };
  const removeInstrument = (sym) => {
    setWatch(w => w.filter(x => x !== sym));
    if (focus === sym) setFocus(watch.find(x => x !== sym));
  };

  const focusInst = INSTRUMENTS[focus];
  const focusQ = quotes[focus];

  const fmtPrice = (sym, v) => {
    const inst = INSTRUMENTS[sym];
    if (v == null) return '—';
    // Convert only true dollar-denominated instruments into the chosen currency
    const convertible = inst.unit === '$';
    const cur = HOME_CCY[currency] || HOME_CCY.USD;
    const val = convertible ? v * cur.rate : v;
    const dp = (convertible && currency === 'JPY') ? 0 : inst.dp;
    const s = val.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    if (convertible) return cur.symbol + s;
    return s + (inst.unit === '%' ? '%' : '');
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Watch board.</h1>
          <p className="page-sub">
            Real-time tracking · {focusInst ? `focused on ${focusInst.name}` : 'pick an instrument'}
          </p>
        </div>
        <div className="row">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: live ? 'var(--pos)' : 'var(--accent)', animation: 'pulse 2s infinite', display: 'inline-block' }}></span>
            {live ? 'Live feed' : 'Simulated'} · {now.toLocaleTimeString('en-US', { hour12: false })}
          </span>
          <select value={currency} onChange={e => setCurrency(e.target.value)} title="Display currency"
            style={{ padding: '6px 10px', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-mono)', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)', cursor: 'pointer' }}>
            {Object.keys(HOME_CCY).map(c => <option key={c} value={c}>{HOME_CCY[c].symbol} {c}</option>)}
          </select>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}><Icon name="plus" size={12} /> Add instrument</button>
        </div>
      </div>

      {/* Focus hero */}
      {focusInst && focusQ && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr', gap: 0 }}>
            <div style={{ padding: 24, borderRight: '1px solid var(--border)' }}>
              <div className="row" style={{ gap: 8, marginBottom: 12 }}>
                <span className="ticker" style={{ fontSize: 13, padding: '3px 8px', background: 'var(--bg-sunken)', borderRadius: 4 }}>{focus}</span>
                <span style={{ fontSize: 11, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{focusInst.cls}</span>
              </div>
              <div style={{ fontFamily: 'var(--font-serif)', fontSize: 20, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 8, cursor: focusInst.cls === 'Stock' ? 'pointer' : 'default' }}
                onClick={() => { if (focusInst.cls === 'Stock') { setActiveAsset(focus); setPage('detail'); } }}
                title={focusInst.cls === 'Stock' ? 'Open full analysis' : undefined}>
                {focusInst.name}
                {focusInst.cls === 'Stock' && <Icon name="arrowRight" size={14} />}
              </div>
              <div className="num" style={{ fontSize: 44, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 8 }}>
                {fmtPrice(focus, focusQ.price)}
              </div>
              <div className="row" style={{ gap: 10, marginTop: 6 }}>
                <span className={focusQ.chg >= 0 ? 'pill pill-pos' : 'pill pill-neg'} style={{ fontSize: 13 }}>
                  {focusQ.chg >= 0 ? '▲' : '▼'} {focusQ.chg >= 0 ? '+' : ''}{focusQ.chg.toFixed(2)}%
                </span>
                <span className="num" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  {focusQ.chg >= 0 ? '+' : ''}{fmtPrice(focus, Math.abs(focusQ.price * focusQ.chg / 100)).replace(/^([^\d.-])/, '$1')} today
                </span>
              </div>
            </div>
            <div style={{ position: 'relative', minHeight: 220 }}>
              <AreaChart data={focusQ.series} width={760} height={220} padding={{ t: 16, r: 50, b: 16, l: 0 }} />
            </div>
          </div>
        </div>
      )}

      {/* Watch grid */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">My Instruments · {watch.length}</h3>
          <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Click to focus · updates every 2s</span>
        </div>
        <div className="card-body">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {watch.map(sym => {
              const inst = INSTRUMENTS[sym];
              const q = quotes[sym];
              if (!q) return null;
              const up = q.chg >= 0;
              return (
                <div key={sym} onClick={() => setFocus(sym)}
                  className="home-tile"
                  style={{
                    position: 'relative', padding: 14, borderRadius: 8, cursor: 'pointer',
                    border: focus === sym ? '1px solid var(--accent)' : '1px solid var(--border)',
                    background: focus === sym ? 'var(--accent-bg)' : 'var(--bg-elev)',
                    transition: 'border-color 150ms',
                  }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <div className="ticker" style={{ fontSize: 13 }}>{sym}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-subtle)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 }}>{inst.name}</div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); removeInstrument(sym); }}
                      className="home-remove"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-subtle)', padding: 2, opacity: 0, transition: 'opacity 150ms' }}>
                      <Icon name="close" size={12} />
                    </button>
                  </div>
                  <div className="num" style={{ fontSize: 22, fontWeight: 600, marginTop: 10 }}>{fmtPrice(sym, q.price)}</div>
                  <div style={{ marginTop: 2 }}>
                    <span className="num" style={{ fontSize: 12, fontWeight: 600, color: up ? 'var(--pos)' : 'var(--neg)' }}>
                      {up ? '+' : ''}{q.chg.toFixed(2)}%
                    </span>
                  </div>
                  <div style={{ marginTop: 8, width: '100%' }}>
                    <div style={{ width: '100%', height: 48 }}>
                      <svg width="100%" height="48" viewBox="0 0 190 48" preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}>
                        {(() => {
                          const d = q.series;
                          const min = Math.min(...d), max = Math.max(...d), range = (max - min) || 1;
                          const step = 190 / (d.length - 1);
                          const pts = d.map((v, idx) => [idx * step, 48 - ((v - min) / range) * 46 - 1]);
                          const line = pts.map(([x, y], idx) => `${idx ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
                          const area = `${line} L190,48 L0,48 Z`;
                          const col = up ? 'var(--pos)' : 'var(--neg)';
                          return <>
                            <path d={area} fill={col} opacity="0.12" />
                            <path d={line} fill="none" stroke={col} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
                          </>;
                        })()}
                      </svg>
                    </div>
                  </div>
                </div>
              );
            })}
            {/* Add tile */}
            <button onClick={() => setShowAdd(true)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6,
                padding: 14, borderRadius: 8, cursor: 'pointer', minHeight: 110,
                border: '1px dashed var(--border-strong)', background: 'transparent', color: 'var(--text-muted)',
                fontFamily: 'inherit', fontSize: 12,
              }}>
              <Icon name="plus" size={18} />
              Add instrument
            </button>
          </div>
        </div>
      </div>

      {showAdd && <AddInstrumentDialog current={watch} onAdd={addInstrument} onClose={() => setShowAdd(false)} />}
    </div>
  );
};

const AddInstrumentDialog = ({ current, onAdd, onClose }) => {
  const [q, setQ] = React.useState('');
  const groups = {};
  Object.entries(INSTRUMENTS).forEach(([sym, inst]) => {
    if (current.includes(sym)) return;
    if (q && !(`${sym} ${inst.name}`.toLowerCase().includes(q.toLowerCase()))) return;
    (groups[inst.cls] = groups[inst.cls] || []).push([sym, inst]);
  });

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 1000, display: 'grid', placeItems: 'center', padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 8, width: '100%', maxWidth: 520, maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 className="serif" style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Add to watch board</h3>
            <button className="icon-btn" onClick={onClose}><Icon name="close" size={12} /></button>
          </div>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search index, gold, stock…"
            style={{ width: '100%', padding: '9px 11px', fontSize: 13, fontFamily: 'inherit', background: 'var(--bg-sunken)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', color: 'var(--text)', outline: 'none' }} />
        </div>
        <div style={{ overflowY: 'auto', padding: 12 }}>
          {Object.keys(groups).length === 0 && <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>No matches</div>}
          {Object.entries(groups).map(([cls, items]) => (
            <div key={cls} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '4px 6px' }}>{cls}</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {items.map(([sym, inst]) => (
                  <button key={sym} onClick={() => onAdd(sym)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', border: '1px solid var(--border)', background: 'var(--bg-sunken)', textAlign: 'left', fontFamily: 'inherit' }}>
                    <span className="ticker" style={{ fontSize: 12, minWidth: 44 }}>{sym}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{inst.name}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// Hover-to-reveal remove button
if (!document.getElementById('home-style')) {
  const s = document.createElement('style');
  s.id = 'home-style';
  s.textContent = `.home-remove { opacity: 0; }
    .home-tile:hover .home-remove { opacity: 0.6; }
    .home-remove:hover { opacity: 1 !important; color: var(--neg) !important; }`;
  document.head.appendChild(s);
}

window.PageHome = PageHome;
