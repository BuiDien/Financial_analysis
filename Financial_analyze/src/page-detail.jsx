// Asset detail page — chart + key stats + technicals + ratios + news.
// Every number on this page comes from the backend (quote, history, ratios)
// or is computed from real daily closes. Nothing is invented: when a source
// is missing the field shows "—" or an empty state.

// Candle timeframes: [first window to load, bar interval]. Scrolling left
// loads older windows, so the window only sets how much shows at first.
// 3M (quarter) candles are built from monthly bars — no provider serves them.
const DETAIL_RANGES = {
  '5m': ['5d', '5m'], '15m': ['1mo', '15m'], '1H': ['3mo', '1h'],
  '1D': ['1y', '1d'], '1W': ['5y', '1wk'], '1M': ['5y', '1mo'], '3M': ['5y', '1mo'],
};

// Merge monthly bars into calendar quarters (bar times are exchange-clock UTC).
const toQuarters = (bars) => {
  const out = [];
  for (const b of bars) {
    const d = new Date(b.time * 1000);
    const q = d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3);
    const last = out[out.length - 1];
    if (last && last.q === q) {
      last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low);
      last.close = b.close; last.volume = (last.volume || 0) + (b.volume || 0);
    } else {
      out.push({ ...b, q, time: Math.floor(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1) / 1000) });
    }
  }
  return out;
};

// How often the page re-pulls the quote / chart while visible. The backend
// caches quotes 120s and history 300s, so faster polling buys nothing.
const QUOTE_POLL_MS = 60 * 1000;
const CHART_POLL_MS = { '5m': 2 * 60 * 1000, '15m': 2 * 60 * 1000, '1H': 5 * 60 * 1000 };   // daily+ candles: live quote updates the last bar

// Map an app ticker to the backend market symbol + price scale — shared rule
// in watchlist-store.jsx (helixMarketFor): "VN:" → vnstock/VCI, VN stock
// prices ×1000 (nghìn đồng → đồng), VN indices unscaled.
const resolveMarket = (sym, holding) => helixMarketFor(sym, holding?.currency);

// Bars are plotted in the exchange's own clock: the wall-clock part of the
// date string ("2026-11-05 09:15:00" for HOSE, "2026-11-03 09:30:00-05:00"
// for NASDAQ) is stored as if it were UTC, which is what Lightweight Charts
// displays. `off` keeps the exchange's UTC offset in minutes (VCI strings carry
// none — they are Vietnam time, UTC+7).
const VN_OFFSET_MIN = 7 * 60;
const toBar = (r, scale = 1) => {
  const raw = r.date ? String(r.date).trim().replace(' ', 'T') : '';
  const m = raw.match(/(Z|[+-]\d\d:?\d\d)$/);
  const wall = m ? raw.slice(0, -m[0].length) : raw;
  const t = wall ? Date.parse(wall.length <= 10 ? wall + 'T00:00:00Z' : wall + 'Z') : NaN;
  let off = VN_OFFSET_MIN;
  if (m) off = m[0] === 'Z' ? 0 : (m[0][0] === '-' ? -1 : 1) * (Number(m[0].slice(1, 3)) * 60 + Number(m[0].slice(-2)));
  return {
    time: Number.isFinite(t) ? Math.floor(t / 1000) : undefined, off,
    open: r.open * scale, high: r.high * scale, low: r.low * scale, close: r.close * scale, volume: r.volume,
  };
};
const fmtOffset = (min) => `UTC${min >= 0 ? '+' : '−'}${Math.floor(Math.abs(min) / 60)}${Math.abs(min) % 60 ? ':' + String(Math.abs(min) % 60).padStart(2, '0') : ''}`;

const scaleQuote = (q, scale) => {
  if (!q || scale === 1) return q;
  const out = { ...q };
  for (const k of ['price', 'open', 'previous_close', 'day_high', 'day_low', 'year_high', 'year_low', 'change']) {
    if (out[k] != null) out[k] *= scale;
  }
  return out;
};

// Run fn now and every `ms` while the tab is visible; re-run on refocus.
const usePoll = (fn, ms, deps) => {
  React.useEffect(() => {
    let cancelled = false;
    const tick = () => { if (!cancelled && document.visibilityState === 'visible') fn(() => cancelled); };
    fn(() => cancelled);
    const iv = ms ? setInterval(tick, ms) : null;
    const onVis = () => { if (ms) tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { cancelled = true; if (iv) clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, deps);
};

// ── Technical indicators from real closes ───────────────────────────────
const sma = (xs, n) => xs.length >= n ? xs.slice(-n).reduce((a, b) => a + b, 0) / n : null;
const emaSeries = (xs, n) => {
  if (xs.length < n) return [];
  const k = 2 / (n + 1);
  let e = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const out = [e];
  for (let i = n; i < xs.length; i++) { e = xs[i] * k + e * (1 - k); out.push(e); }
  return out;
};
const rsi14 = (xs) => {
  const n = 14;
  if (xs.length <= n) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = xs[i] - xs[i - 1]; if (d > 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  for (let i = n + 1; i < xs.length; i++) {
    const d = xs[i] - xs[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
};
const computeTechnicals = (bars) => {
  const closes = bars.map(b => b.close);
  const last = closes[closes.length - 1];
  const out = {};
  if (last == null) return out;
  out.rsi = rsi14(closes);
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  if (e26.length) {
    const macd = e26.map((v, i) => e12[i + 14] - v);           // e12 starts 14 bars earlier
    const sig = emaSeries(macd, 9);
    if (sig.length >= 2) {
      const m = macd[macd.length - 1], s = sig[sig.length - 1];
      const pm = macd[macd.length - 2], ps = sig[sig.length - 2];
      out.macd = { line: m, signal: s, crossUp: pm <= ps && m > s, crossDown: pm >= ps && m < s };
    }
  }
  out.ma50 = sma(closes, 50);
  out.ma200 = sma(closes, 200);
  if (bars.length >= 14) {
    const win = bars.slice(-14);
    const hi = Math.max(...win.map(b => b.high)), lo = Math.min(...win.map(b => b.low));
    out.stoch = hi > lo ? ((last - lo) / (hi - lo)) * 100 : null;
  }
  if (closes.length >= 20) {
    const w = closes.slice(-20), mean = w.reduce((a, b) => a + b, 0) / 20;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mean) ** 2, 0) / 20);
    out.boll = sd > 0 ? { z: (last - mean) / sd, pctB: ((last - (mean - 2 * sd)) / (4 * sd)) * 100 } : null;
  }
  out.last = last;
  return out;
};

const clampPct = (v) => Math.max(0, Math.min(100, v));
const zoneSignal = (v, hi, lo) => v == null ? '' : v >= hi ? 'Overbought' : v <= lo ? 'Oversold' : 'Neutral';
const maSignal = (ma, last) => {
  if (ma == null || last == null) return 'Not enough history';
  const d = ((last - ma) / ma) * 100;
  return `${d >= 0 ? 'Above' : 'Below'} · ${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
};

// Dated notes log per ticker (backend: /api/notes). Symbol is stored without any "VN:" prefix.
const NotesCard = ({ symbol }) => {
  const sym = String(symbol).toUpperCase().replace(/^VN:/, '');
  const live = !!window.HelixAPI?.live;
  const [notes, setNotes] = React.useState(null);   // null = loading
  const [failed, setFailed] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [editId, setEditId] = React.useState(null);
  const [editText, setEditText] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [reload, setReload] = React.useState(0);
  const alive = React.useRef(true);   // card is keyed by symbol, so unmount == symbol switch
  React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  React.useEffect(() => {
    setNotes(null); setFailed(false);
    if (!live) return undefined;
    let cancelled = false;
    window.HelixAPI.notesList(sym).then(r => { if (!cancelled) setNotes(r); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [sym, live, reload]);

  const offline = !live;
  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); } catch (e) { if (alive.current) setErr(e.message || 'Request failed'); }
    if (alive.current) setBusy(false);
  };
  const add = () => run(async () => {
    const n = await window.HelixAPI.notesAdd(sym, draft);
    if (!alive.current) return;
    setNotes(list => [n, ...(list || [])]); setDraft('');
  });
  const save = (id) => run(async () => {
    const n = await window.HelixAPI.notesEdit(id, editText);
    if (!alive.current) return;
    setNotes(list => (list || []).map(x => x.id === id ? n : x)); setEditId(null);
  });
  const del = async (n) => {
    if (!await window.askConfirm({ title: 'Delete note', message: 'Delete this note? This can\'t be undone.', confirmText: 'Delete', danger: true })) return;
    run(async () => { await window.HelixAPI.notesDelete(n.id); if (!alive.current) return; setNotes(list => (list || []).filter(x => x.id !== n.id)); });
  };
  const when = (iso) => new Date(iso).toLocaleString();
  const link = { background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11 };

  return (
    <div className="card">
      <div className="card-header"><h3 className="card-title">Notes</h3></div>
      <div className="card-body" style={{ padding: 16 }}>
        {offline ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Notes need the backend</div>
        ) : failed ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Could not load notes. <button className="btn" onClick={() => setReload(k => k + 1)}>Retry</button>
          </div>
        ) : (
          <>
            <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={3} disabled={busy}
              placeholder={`Why is ${sym} a good company?`}
              style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', font: 'inherit', fontSize: 12, padding: 8, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
            <div className="row" style={{ marginTop: 8, gap: 8, alignItems: 'center' }}>
              <button className="btn btn-primary" onClick={add} disabled={busy || !draft.trim()}>Add note</button>
              {err && <span style={{ fontSize: 11, color: 'var(--red, #dc2626)' }}>{err}</span>}
            </div>
            <div style={{ marginTop: 12 }}>
              {notes === null && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading…</div>}
              {notes && notes.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No notes yet.</div>}
              {(notes || []).map(n => (
                <div key={n.id} style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
                  <div className="row" style={{ gap: 8, fontSize: 11, color: 'var(--text-subtle)', alignItems: 'center' }}>
                    <span>{when(n.created_at)}</span>
                    {n.updated_at && <span title={`Edited ${when(n.updated_at)}`}>edited</span>}
                    <span style={{ flex: 1 }} />
                    {editId !== n.id && <button style={link} onClick={() => { setEditId(n.id); setEditText(n.body); }} disabled={busy}>Edit</button>}
                    <button style={link} onClick={() => del(n)} disabled={busy}>Delete</button>
                  </div>
                  {editId === n.id ? (
                    <div style={{ marginTop: 6 }}>
                      <textarea value={editText} onChange={e => setEditText(e.target.value)} rows={3} disabled={busy}
                        style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', font: 'inherit', fontSize: 12, padding: 8, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6 }} />
                      <div className="row" style={{ gap: 8, marginTop: 6 }}>
                        <button className="btn btn-primary" onClick={() => save(n.id)} disabled={busy || !editText.trim()}>Save</button>
                        <button className="btn" onClick={() => setEditId(null)} disabled={busy}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ marginTop: 4, fontSize: 12, whiteSpace: 'pre-wrap' }}>{n.body}</div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const PageDetail = ({ activeAsset = 'NVDA', data, setActiveAsset, setPage }) => {
  const [range, setRange] = React.useState('1D');   // candle timeframe
  const [chartType, setChartType] = React.useState('candle'); // candle | area
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const store = useWatchlists();
  const live = !!window.HelixAPI?.live;

  const holdings = data.portfolio?.holdings || [];
  // The screener opens VN tickers as "VN:HDB" so a bare symbol that is also a US
  // ticker (HDB) is not routed to Yahoo; holdings, names and tags use the bare symbol.
  const bareAsset = String(activeAsset).toUpperCase().replace(/^VN:/, '');
  const sameSym = (sym) => sym === activeAsset || sym === bareAsset;
  const nameOf = (sym) => {
    const bare = String(sym).toUpperCase().replace(/^VN:/, '');
    return (data.watchlist || []).find(x => x.sym === sym || x.sym === bare)?.name || (window.SYMBOL_CATALOG || {})[bare]?.name || sym;
  };
  const holding = holdings.find(h => sameSym(h.sym));
  // Vietnamese tickers without a fixed route are stored as "VN:XXX" so the
  // watchlist quotes them from VCI, not a same-named US listing.
  const vnAsset = String(activeAsset).toUpperCase().startsWith('VN:') || holding?.currency === 'VND';
  const watchSym = vnAsset && !(window.HOME_LIVE_TICKER || {})[bareAsset] ? `VN:${bareAsset}` : bareAsset;
  const inWatchlist = store.isInAny(bareAsset) || store.isInAny(`VN:${bareAsset}`);
  const toggleWatch = () => {
    const active = store.getActive();
    const present = [bareAsset, `VN:${bareAsset}`].filter(x => active.symbols.includes(x));
    if (present.length) present.forEach(x => store.removeSymbol(active.id, x));
    else store.addSymbol(active.id, watchSym);
    return !present.length;
  };
  const activeListName = store.getActive()?.name || 'watchlist';

  const { market, vn, scale } = resolveMarket(activeAsset, holding);

  // Live quote — polled while the tab is visible
  const [quote, setQuote] = React.useState(null);
  const [quoteErr, setQuoteErr] = React.useState(false);
  React.useEffect(() => { setQuote(null); setQuoteErr(false); }, [market]);
  usePoll((isCancelled) => {
    if (!live) return;
    window.HelixAPI.quote(market)
      .then(q => { if (!isCancelled()) { setQuote(scaleQuote(q, scale)); setQuoteErr(false); } })
      .catch(() => { if (!isCancelled()) setQuoteErr(true); });
  }, QUOTE_POLL_MS, [market, scale, live]);

  // Ratios + 1Y daily bars (technicals, 52W fallback) — once per asset
  const [ratios, setRatios] = React.useState(null);
  const [daily, setDaily] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    setRatios(null); setDaily(null);
    if (!live) return undefined;
    const api = window.HelixAPI;
    if (!vn) api.ratios(market).then(r => { if (!cancelled) setRatios(r); }).catch(() => {});
    api.history(market, '1y', '1d')
      .then(rows => { if (!cancelled && Array.isArray(rows)) setDaily(rows.map(r => toBar(r, scale))); })
      .catch(() => { if (!cancelled) setDaily([]); });
    return () => { cancelled = true; };
  }, [market, scale, vn, live]);

  // Chart bars for the selected range — short ranges refresh on a timer
  const [bars, setBars] = React.useState(null);
  const [chartState, setChartState] = React.useState('loading'); // loading | ready | empty
  // Older bars loaded by scrolling left — kept apart so the polled refresh
  // of the recent window doesn't drop them.
  const [older, setOlder] = React.useState([]);
  const [olderState, setOlderState] = React.useState('idle'); // idle | loading | done
  const olderBusy = React.useRef(false);
  React.useEffect(() => { setBars(null); setOlder([]); setOlderState('idle'); olderBusy.current = false; setChartState(live ? 'loading' : 'empty'); }, [market, range, live]);
  usePoll((isCancelled) => {
    if (!live) return;
    const [period, interval] = DETAIL_RANGES[range] || DETAIL_RANGES['1D'];
    window.HelixAPI.history(market, period, interval)
      .then(rows => {
        if (isCancelled()) return;
        if (Array.isArray(rows) && rows.length > 1) { setBars(rows.map(r => toBar(r, scale))); setChartState('ready'); }
        else setChartState(s => (s === 'ready' ? s : 'empty'));
      })
      .catch(() => { if (!isCancelled()) setChartState(s => (s === 'ready' ? s : 'empty')); });
  }, CHART_POLL_MS[range] || 0, [market, scale, range, live]);

  // Exchange UTC offset (minutes), from the latest bar's date string.
  const marketOff = (bars && bars.length ? bars[bars.length - 1].off : null) ?? (vn ? VN_OFFSET_MIN : 0);

  // My trades on this ticker (from the portfolio ledger) — drawn as chart markers
  const [myTicker, setMyTicker] = React.useState(null);
  const [showTrades, setShowTrades] = React.useState(true);
  React.useEffect(() => {
    let cancelled = false;
    setMyTicker(null);
    if (!live || !window.HelixAPI.portfolioTickers) return undefined;
    const sym = market.startsWith('VN:') ? market.slice(3) : market;
    window.HelixAPI.portfolioTickers()
      .then(d => { if (!cancelled) setMyTicker((d.tickers || []).find(t => t.ticker === sym || t.ticker === String(activeAsset).toUpperCase()) || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [market, activeAsset, live]);
  const tradeMarkers = React.useMemo(() => {
    if (!showTrades || !myTicker) return null;
    return myTicker.events.map(e => ({ time: Math.floor(Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(e.date) ? e.date : e.date + 'Z') / 1000) + marketOff * 60, kind: e.kind, quantity: e.quantity }));  // ledger times are UTC → exchange clock
  }, [myTicker, showTrades, marketOff]);

  // Prices are shown in the listing's own currency, exactly as the exchange
  // quotes them — no FX conversion. VND → "53,600 ₫"; others → "186.64 USD".
  const nativeCcy = (quote?.currency || holding?.currency || (vn ? 'VND' : 'USD')).toUpperCase();
  const money = (n) => fmtNativePrice(n, nativeCcy);

  // How far back each scroll-back request reaches, per bar size.
  const OLDER_CHUNK = { '5m': '5d', '15m': '1mo', '1h': '3mo', '1d': '1y', '1wk': '5y', '1mo': '5y' };
  const loadOlder = React.useCallback(() => {
    if (!live || olderBusy.current || olderState === 'done') return;
    const first = (older[0] || (bars && bars[0]));
    if (!first || !Number.isFinite(first.time)) return;
    const [, interval] = DETAIL_RANGES[range] || DETAIL_RANGES['1D'];
    const end = new Date(first.time * 1000).toISOString().slice(0, 10);  // exchange-local date
    olderBusy.current = true; setOlderState('loading');
    const key = `${market}|${range}`;
    window.HelixAPI.history(market, OLDER_CHUNK[interval] || '1y', interval, end)
      .then(rows => {
        if (`${market}|${range}` !== key) return;
        const add = (Array.isArray(rows) ? rows : []).map(r => toBar(r, scale)).filter(b => Number.isFinite(b.time) && b.time < first.time);
        if (!add.length) { setOlderState('done'); return; }
        setOlder(o => [...add, ...o]);
        setOlderState('idle');
      })
      .catch(() => setOlderState('done'))
      .finally(() => { olderBusy.current = false; });
  }, [live, olderState, older, bars, range, market, scale]);

  // Fold the live quote into the latest candle so the chart moves between history refreshes
  const ohlc = React.useMemo(() => {
    if (!bars || !bars.length) return bars;
    let out = older.length ? [...older.filter(b => b.time < bars[0].time), ...bars] : bars;
    const px = quote?.price;
    if (px != null && Number.isFinite(px)) {
      const lb = out[out.length - 1];
      out = [...out.slice(0, -1), { ...lb, close: px, high: Math.max(lb.high, px), low: Math.min(lb.low, px) }];
    }
    return range === '3M' ? toQuarters(out) : out;
  }, [bars, older, quote?.price, range]);

  const tech = React.useMemo(() => (daily && daily.length ? computeTechnicals(daily) : {}), [daily]);
  // VCI gives no 52W range — derive it from the real 1Y daily bars
  const yearLow = quote?.year_low ?? (daily?.length ? Math.min(...daily.map(b => b.low)) : null);
  const yearHigh = quote?.year_high ?? (daily?.length ? Math.max(...daily.map(b => b.high)) : null);

  // Holding price is a real (ledger-valued) fallback only when live — never the demo snapshot.
  const price = quote?.price ?? (live && !data.portfolio?.demo ? holding?.price : null) ?? null;
  const chg = quote?.change_pct ?? null;
  const chgAbs = quote?.change ?? null;
  const lastVolume = daily && daily.length ? daily[daily.length - 1].volume : null;
  const v = ratios?.valuation || {}, p = ratios?.profitability || {}, l = ratios?.liquidity || {};
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const num = (x, d = 2) => (x == null ? '—' : Number(x).toFixed(d));

  const statusText = !live
    ? 'Backend offline — no market data'
    : quote
      ? `${({ REGULAR: 'Market open', PRE: 'Pre-market', POST: 'After hours' })[quote.market_state] || 'Market closed'} · ${vn ? 'VCI' : 'Yahoo'} · as of ${new Date(quote.ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · auto-refresh 60s${quoteErr ? ' · last refresh failed' : ''}`
      : quoteErr ? `No quote for ${market}` : 'Loading quote…';

  const macd = tech.macd;
  // Related news: the feed's ticker tags first, then a whole-word title match
  // on the symbol (3+ letters, to avoid noise) or the company name.
  const assetName = nameOf(activeAsset);
  const titleRe = (() => {
    const terms = [];
    if (bareAsset.length >= 3) terms.push(bareAsset);
    if (assetName && assetName !== activeAsset && assetName.length >= 4) terms.push(assetName.split(' ')[0]);
    const esc = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return esc.length ? new RegExp(`(^|[^\\p{L}\\p{N}])(${esc.join('|')})(?=$|[^\\p{L}\\p{N}])`, 'iu') : null;
  })();
  const tickerHit = (n) => (n.tickers || n.tags || []).some(t => sameSym(String(t).toUpperCase().replace(/^VN:/, '')));
  const newsForAsset = [
    ...(data.news || []).filter(tickerHit),
    ...(data.news || []).filter(n => !tickerHit(n) && titleRe && titleRe.test(n.title || '')),
  ].slice(0, 6);

  return (
    <div className="page">
      {/* Asset header */}
      <div className="page-header" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: 16 }}>
          <div style={{
            width: 56, height: 56, borderRadius: 8,
            background: 'linear-gradient(135deg, var(--accent), #7C2D12)',
            color: 'white', display: 'grid', placeItems: 'center',
            fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 18,
          }}>
            {activeAsset.replace(/^VN:/, '').slice(0, 2)}
          </div>
          <div>
            <div className="row" style={{ gap: 12, position: 'relative' }}>
              <button onClick={() => setSwitcherOpen(o => !o)}
                title="Switch stock"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 28, fontWeight: 600, margin: 0, color: 'var(--text)' }}>{nameOf(activeAsset)}</h1>
                <Icon name={switcherOpen ? 'arrowUp' : 'arrowDown'} size={18} style={{ color: 'var(--text-muted)' }} />
              </button>
              <span className="ticker" style={{ fontSize: 14, padding: '2px 8px', background: 'var(--bg-sunken)', borderRadius: 4, color: 'var(--text-muted)' }}>{activeAsset}</span>

              {switcherOpen && (
                <>
                  <div onClick={() => setSwitcherOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
                  <div style={{
                    position: 'absolute', top: 'calc(100% + 8px)', left: 0, zIndex: 41,
                    width: 320, maxHeight: 380, overflowY: 'auto',
                    background: 'var(--bg-elev)', border: '1px solid var(--border)',
                    borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,0.16)', padding: 6,
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)', padding: '8px 10px 4px' }}>
                      {data.portfolio?.demo ? `Sample portfolio (offline demo) · ${holdings.length} holdings` : `Your portfolio · ${holdings.length} holdings`}
                    </div>
                    {holdings.length === 0 && (
                      <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '8px 10px' }}>
                        {data.portfolio?.status === 'error' ? 'Portfolio unavailable right now.' : data.portfolio?.status === 'loading' ? 'Loading portfolio…' : 'No holdings yet.'}
                      </div>
                    )}
                    {holdings.map(h => {
                      const active = sameSym(h.sym);
                      return (
                        <button key={h.sym}
                          onClick={() => { setActiveAsset && setActiveAsset(h.sym); setSwitcherOpen(false); }}
                          style={{
                            display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center',
                            width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: 6,
                            border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                            background: active ? 'var(--accent-bg)' : 'transparent',
                          }}
                          onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                          onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
                          <span className="ticker" style={{ fontSize: 13, color: active ? 'var(--accent)' : 'var(--text)' }}>{h.sym}</span>
                          <span style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(h.sym)}</span>
                          <span className="num" style={{ fontSize: 12, fontWeight: 600 }}>{fmtNativePrice(h.price, (h.currency || 'USD').toUpperCase())}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
            <div className="row" style={{ gap: 16, marginTop: 6 }}>
              <span className="num" style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em' }}>{money(price)}</span>
              {chg != null && <Pill value={chg} />}
              {chgAbs != null && (
                <span className="num" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  {chgAbs >= 0 ? '+' : ''}{money(chgAbs)} today
                </span>
              )}
              <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>
                {live && quote?.market_state === 'REGULAR' && <span className="live-dot"></span>} {statusText}
              </span>
            </div>
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => { const added = toggleWatch(); window.toast(added ? `Added ${bareAsset} to ${activeListName}` : `Removed ${bareAsset} from ${activeListName}`, { type: added ? 'success' : 'info' }); }}
            title={inWatchlist ? 'Remove from active watchlist' : `Add to ${activeListName}`}
            style={inWatchlist ? { background: 'var(--accent-bg)', borderColor: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}>
            <Icon name={inWatchlist ? 'starFill' : 'star'} size={12} /> {inWatchlist ? 'In watchlist' : 'Watchlist'}
          </button>
          <button className="btn" onClick={() => { window.__statementsTicker = bareAsset; setPage && setPage('statements'); }}><Icon name="portfolio" size={12} /> Financials</button>
          <button className="btn" onClick={() => { window.__alertTicker = watchSym; setPage && setPage('alerts'); }}><Icon name="alerts" size={12} /> Alert</button>
        </div>
      </div>

      {/* Chart */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <div className="row">
            <h3 className="card-title">Price Chart</h3>
            <div style={{ display: 'inline-flex', background: 'var(--bg-sunken)', borderRadius: 4, padding: 2 }}>
              <button className="range-chip" aria-selected={chartType === 'candle'} onClick={() => setChartType('candle')}>Candles</button>
              <button className="range-chip" aria-selected={chartType === 'area'} onClick={() => setChartType('area')}>Area</button>
            </div>
          </div>
          <span style={{ fontSize: 11, color: 'var(--text-subtle)' }} title="Chart times are the exchange's local time">{vn ? 'Vietnam time' : 'Exchange time'} ({fmtOffset(marketOff)})</span>
          {myTicker && <button className="range-chip" aria-selected={showTrades} onClick={() => setShowTrades(v => !v)} title="Show my buys (▲) and sells (▼) on the chart">My trades · {myTicker.orders_buy + myTicker.orders_sell}</button>}
          <div className="range-chips">
            {Object.keys(DETAIL_RANGES).map(r => (
              <button key={r} className="range-chip" aria-selected={range === r} onClick={() => setRange(r)}>{r}</button>
            ))}
          </div>
        </div>
        <div className="chart-wrap" style={{ height: 420, position: 'relative' }}>
          {chartState === 'ready' && olderState !== 'idle' && <div style={{ position: 'absolute', left: 12, bottom: 40, zIndex: 4, fontSize: 11, color: 'var(--text-subtle)', background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 8px', pointerEvents: 'none' }}>{olderState === 'loading' ? 'Loading older bars…' : 'Start of available history'}</div>}
          {chartState === 'ready' && ohlc
            ? <LWChart data={ohlc} type={chartType} height={420} volume={true} range={range} markers={tradeMarkers} onReachStart={loadOlder} />
            : (
              <div style={{ height: 420, display: 'grid', placeItems: 'center', color: 'var(--text-subtle)', fontSize: 13 }}>
                {chartState === 'loading' ? 'Loading price history…' : live ? `No price history for ${activeAsset} in this range.` : 'Connect the backend to load price history.'}
              </div>
            )}
        </div>
      </div>

      {/* Stats strip */}
      <div className="stat-grid" style={{ marginBottom: 20, gridTemplateColumns: 'repeat(6, 1fr)' }}>
        <StatBlock label="Open" value={money(quote?.open)} />
        <StatBlock label="Day Range" value={quote?.day_low != null && quote?.day_high != null ? `${money(quote.day_low)} – ${money(quote.day_high)}` : '—'} />
        <StatBlock label="52W Range" value={yearLow != null && yearHigh != null ? `${money(yearLow)} – ${money(yearHigh)}` : '—'} />
        <StatBlock label="Volume" value={fmtBig(lastVolume)} />
        <StatBlock label="Mkt Cap" value={quote?.market_cap == null ? '—' : `${fmtBig(quote.market_cap)} ${nativeCcy === 'VND' ? '₫' : nativeCcy}`} />
        <StatBlock label="P/E" value={num(v.pe_trailing, 1)} />
      </div>

      {/* Two col: technicals + ratios */}
      <div className="grid-2" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Technical Indicators</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Daily · from 1Y closes</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {!daily || !daily.length ? (
              <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)' }}>
                {live ? (daily ? 'No daily history available.' : 'Loading…') : 'Connect the backend to compute indicators.'}
              </div>
            ) : (
              <>
                <Indicator label="RSI (14)" value={num(tech.rsi, 1)} signal={zoneSignal(tech.rsi, 70, 30)} gauge={tech.rsi} />
                <Indicator label="MACD (12,26,9)" value={macd ? `${macd.line >= 0 ? '+' : ''}${macd.line.toFixed(2)}` : '—'}
                  signal={!macd ? 'Not enough history' : macd.crossUp ? 'Bullish crossover' : macd.crossDown ? 'Bearish crossover' : macd.line > macd.signal ? 'Above signal line' : 'Below signal line'} />
                <Indicator label="MA 50" value={money(tech.ma50)} signal={maSignal(tech.ma50, tech.last)} />
                <Indicator label="MA 200" value={money(tech.ma200)} signal={maSignal(tech.ma200, tech.last)} />
                <Indicator label="Stochastic %K (14)" value={num(tech.stoch, 1)} signal={zoneSignal(tech.stoch, 80, 20)} gauge={tech.stoch} />
                <Indicator label="Bollinger (20,2)" value={tech.boll ? `${tech.boll.z >= 0 ? '+' : ''}${tech.boll.z.toFixed(2)}σ` : '—'}
                  signal={!tech.boll ? 'Not enough history' : tech.boll.pctB > 100 ? 'Above upper band' : tech.boll.pctB < 0 ? 'Below lower band' : 'Inside bands'}
                  gauge={tech.boll ? clampPct(tech.boll.pctB) : null} last />
              </>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Key Ratios</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>TTM</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {!ratios ? (
              <div style={{ padding: 16, fontSize: 12, color: 'var(--text-muted)' }}>
                {!live ? 'Connect the backend to load ratios.' : vn ? 'No ratio source for Vietnamese listings yet — see Financials for statement data.' : 'Ratios unavailable for this ticker.'}
              </div>
            ) : (
              <>
                <RatioRow label="P/E (TTM)" value={num(v.pe_trailing, 1)} />
                <RatioRow label="P/E (Forward)" value={num(v.pe_forward, 1)} />
                <RatioRow label="P/S" value={num(v.ps, 1)} />
                <RatioRow label="P/B" value={num(v.pb, 1)} />
                <RatioRow label="EV/EBITDA" value={num(v.ev_ebitda, 1)} />
                <RatioRow label="Gross Margin" value={pct(p.gross_margin)} />
                <RatioRow label="Net Margin" value={pct(p.net_margin)} />
                <RatioRow label="ROE" value={pct(p.roe)} />
                <RatioRow label="Debt / Equity" value={l.debt_to_equity == null ? '—' : `${(l.debt_to_equity / 100).toFixed(2)}x`} last />
              </>
            )}
          </div>
        </div>

        <NotesCard key={String(activeAsset).toUpperCase().replace(/^VN:/, '')} symbol={activeAsset} />
      </div>

      {/* News */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">{activeAsset} News</h3>
        </div>
        <div className="card-body" style={{ padding: '0 16px' }}>
          {newsForAsset.length === 0 && (
            <div style={{ padding: '16px 0', fontSize: 12, color: 'var(--text-muted)' }}>No recent news tagged {activeAsset}.</div>
          )}
          {newsForAsset.map((n, i) => (
            <div key={i} className="news-row" style={{ gridTemplateColumns: '96px 1fr' }}>
              <span className="news-time">{n.time}</span>
              <div>
                <div className="news-title" style={{ fontSize: 13 }}>
                  {safeHttpUrl(n.url) ? <a href={safeHttpUrl(n.url)} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>{n.title}</a> : n.title}
                </div>
                <div className="news-meta">
                  <span style={{ color: 'var(--text-subtle)' }}>{n.src}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const StatBlock = ({ label, value }) => (
  <div className="stat" style={{ padding: '12px 14px' }}>
    <div className="stat-label">{label}</div>
    <div className="num" style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>{value}</div>
  </div>
);

const Indicator = ({ label, value, signal, gauge, last }) => (
  <div style={{
    display: 'grid', gridTemplateColumns: '1fr auto 100px', gap: 12,
    padding: '12px 16px', borderBottom: last ? 'none' : '1px solid var(--border)',
    alignItems: 'center',
  }}>
    <div>
      <div style={{ fontSize: 12, fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{signal}</div>
    </div>
    <div className="num" style={{ fontSize: 14, fontWeight: 600 }}>{value}</div>
    <div style={{ height: 6, background: gauge == null ? 'transparent' : 'var(--bg-sunken)', borderRadius: 3, position: 'relative' }}>
      {gauge != null && (
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${clampPct(gauge)}%`, background: gauge > 70 ? 'var(--accent)' : 'var(--text-muted)', borderRadius: 3 }} />
      )}
    </div>
  </div>
);

const RatioRow = ({ label, value, last }) => (
  <div style={{
    display: 'grid', gridTemplateColumns: '1fr auto', gap: 12,
    padding: '10px 16px', borderBottom: last ? 'none' : '1px solid var(--border)',
    alignItems: 'center',
  }}>
    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
    <span className="num" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{value}</span>
  </div>
);

window.PageDetail = PageDetail;
