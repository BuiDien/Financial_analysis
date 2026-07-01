// Asset detail page — chart + key stats + financials + news

const PORTFOLIO_NAMES = { VTI: 'Vanguard Total Mkt', 'BRK.B': 'Berkshire Hathaway B', TLT: 'iShares 20+Y Treasury', JNJ: 'Johnson & Johnson', AVGO: 'Broadcom' };

const PageDetail = ({ activeAsset = 'NVDA', data, setActiveAsset, setPage }) => {
  const [range, setRange] = React.useState('1M');
  const [chartType, setChartType] = React.useState('candle'); // candle | area
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const store = useWatchlists();

  // Deterministic pseudo daily change for portfolio-only names
  const estChg = (sym) => { let s = 0; for (const c of sym) s += c.charCodeAt(0); return (s % 600) / 100 - 3; };
  // Resolve the active symbol from the watchlist first, then portfolio holdings
  const resolveAsset = (sym) => {
    const w = data.watchlist.find(x => x.sym === sym);
    if (w) return w;
    const h = (data.portfolio?.holdings || []).find(x => x.sym === sym);
    if (h) return { sym: h.sym, name: PORTFOLIO_NAMES[h.sym] || h.sym, price: h.price, chg: estChg(h.sym), vol: '—', mcap: '—', spark: null };
    return data.watchlist[0];
  };
  const asset = resolveAsset(activeAsset);
  const holdings = data.portfolio?.holdings || [];
  const inWatchlist = store.isInAny(activeAsset);
  const activeListName = store.getActive()?.name || 'watchlist';

  const genOhlc = React.useMemo(() => {
    const counts = { '1D': 60, '1W': 30, '1M': 30, '3M': 60, '1Y': 52, '5Y': 60 };
    const seed = activeAsset.charCodeAt(0) + activeAsset.charCodeAt(1);
    return genOHLC(counts[range] || 30, asset.price * 0.85, 0.025, seed);
  }, [activeAsset, range, asset.price]);

  // Live history overlay — uses real OHLC from the backend when reachable
  const [liveOhlc, setLiveOhlc] = React.useState(null);
  React.useEffect(() => {
    let cancelled = false;
    setLiveOhlc(null);
    if (window.HelixAPI?.live) {
      const periodMap = { '1D': '1d', '1W': '5d', '1M': '1mo', '3M': '3mo', '1Y': '1y', '5Y': '5y' };
      window.HelixAPI.history(activeAsset, periodMap[range] || '1mo')
        .then(rows => {
          if (!cancelled && Array.isArray(rows) && rows.length > 1) {
            setLiveOhlc(rows.map((r, i) => ({ open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume, idx: i })));
          }
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [activeAsset, range]);

  const ohlc = liveOhlc || genOhlc;

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
            {activeAsset.slice(0, 2)}
          </div>
          <div>
            <div className="row" style={{ gap: 12, position: 'relative' }}>
              <button onClick={() => setSwitcherOpen(o => !o)}
                title="Switch stock"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
                <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 28, fontWeight: 600, margin: 0, color: 'var(--text)' }}>{asset.name}</h1>
                <Icon name={switcherOpen ? 'arrowUp' : 'arrowDown'} size={18} style={{ color: 'var(--text-muted)' }} />
              </button>
              <span className="ticker" style={{ fontSize: 14, padding: '2px 8px', background: 'var(--bg-sunken)', borderRadius: 4, color: 'var(--text-muted)' }}>NASDAQ: {asset.sym}</span>

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
                      Your portfolio · {holdings.length} holdings
                    </div>
                    {holdings.map(h => {
                      const a = resolveAsset(h.sym);
                      const active = h.sym === activeAsset;
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
                          <span style={{ fontSize: 12, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</span>
                          <span className="num" style={{ fontSize: 12, fontWeight: 600 }}>${fmtNum(h.price)}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
            <div className="row" style={{ gap: 16, marginTop: 6 }}>
              <span className="num" style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em' }}>${fmtNum(asset.price)}</span>
              <Pill value={asset.chg} />
              <span className="num" style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                {asset.chg >= 0 ? '+' : ''}${(asset.price * asset.chg / 100).toFixed(2)} today
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>
                <span className="live-dot"></span> Real-time · 09:42 ET
              </span>
            </div>
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => { store.toggleInActive(activeAsset); window.toast(inWatchlist ? `Removed ${activeAsset} from ${activeListName}` : `Added ${activeAsset} to ${activeListName}`, { type: inWatchlist ? 'info' : 'success' }); }}
            title={inWatchlist ? 'Remove from active watchlist' : `Add to ${activeListName}`}
            style={inWatchlist ? { background: 'var(--accent-bg)', borderColor: 'var(--accent-soft)', color: 'var(--accent)' } : undefined}>
            <Icon name={inWatchlist ? 'starFill' : 'star'} size={12} /> {inWatchlist ? 'In watchlist' : 'Watchlist'}
          </button>
          <button className="btn" onClick={() => { window.__statementsTicker = asset.sym; setPage && setPage('statements'); }}><Icon name="portfolio" size={12} /> Financials</button>
          <button className="btn" onClick={() => { window.__alertTicker = asset.sym; setPage && setPage('alerts'); }}><Icon name="alerts" size={12} /> Alert</button>
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
          <div className="row">
            <div className="range-chips">
              {['1D','1W','1M','3M','1Y','5Y'].map(r => (
                <button key={r} className="range-chip" aria-selected={range === r} onClick={() => setRange(r)}>{r}</button>
              ))}
            </div>
            <button className="icon-btn"><Icon name="expand" size={12} /></button>
          </div>
        </div>
        <div className="chart-wrap" style={{ height: 420 }}>
          <LWChart data={ohlc} type={chartType} height={420} volume={true} range={range} />
        </div>
      </div>

      {/* Stats strip */}
      <div className="stat-grid" style={{ marginBottom: 20, gridTemplateColumns: 'repeat(6, 1fr)' }}>
        <StatBlock label="Open" value="$140.21" />
        <StatBlock label="Day Range" value="$139.42 – $143.12" />
        <StatBlock label="52W Range" value="$87.10 – $152.89" />
        <StatBlock label="Volume" value={asset.vol} />
        <StatBlock label="Mkt Cap" value={asset.mcap} />
        <StatBlock label="P/E" value="67.4" />
      </div>

      {/* Two col: technicals + ratios */}
      <div className="grid-2" style={{ marginBottom: 20 }}>
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Technical Indicators</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Daily</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <Indicator label="RSI (14)" value={64.2} signal="Approaching overbought" gauge={64} />
            <Indicator label="MACD (12,26,9)" value="+1.84" signal="Bullish crossover" gauge={72} />
            <Indicator label="MA 50" value="$128.42" signal="Above · +10.9%" gauge={80} />
            <Indicator label="MA 200" value="$112.18" signal="Above · +26.9%" gauge={90} />
            <Indicator label="Stochastic" value="78.4" signal="Overbought territory" gauge={78} />
            <Indicator label="Bollinger" value="Upper band" signal="Above mean +1.2σ" gauge={70} last />
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Key Ratios</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>TTM</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <RatioRow label="P/E (TTM)" value="67.4" benchmark="Sector: 32.1" />
            <RatioRow label="P/S" value="38.2" benchmark="Sector: 8.4" />
            <RatioRow label="EPS (TTM)" value="$2.11" benchmark="+ 168% YoY" />
            <RatioRow label="Revenue Growth" value="+94%" benchmark="YoY" pos />
            <RatioRow label="Gross Margin" value="76.0%" benchmark="Sector: 54%" pos />
            <RatioRow label="Dividend Yield" value="0.03%" benchmark="—" />
            <RatioRow label="Beta (5Y)" value="1.68" benchmark="High volatility" />
            <RatioRow label="Short Interest" value="1.2%" benchmark="Low" last />
          </div>
        </div>
      </div>

      {/* Analyst + News */}
      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">Analyst Consensus</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>42 analysts · 30 days</span>
          </div>
          <div className="card-body">
            <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
              <div style={{ textAlign: 'center' }}>
                <div className="serif" style={{ fontSize: 36, fontWeight: 600, color: 'var(--pos)' }}>BUY</div>
                <div style={{ fontSize: 11, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Strong Buy</div>
              </div>
              <div style={{ flex: 1 }}>
                <RatingBar label="Strong Buy" value={28} max={42} color="var(--pos)" />
                <RatingBar label="Buy" value={9} max={42} color="var(--pos)" alpha={0.6} />
                <RatingBar label="Hold" value={4} max={42} color="var(--text-muted)" />
                <RatingBar label="Sell" value={1} max={42} color="var(--neg)" alpha={0.6} />
                <RatingBar label="Strong Sell" value={0} max={42} color="var(--neg)" />
              </div>
            </div>
            <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-sunken)', borderRadius: 6, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, textAlign: 'center' }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Low</div>
                <div className="num" style={{ fontWeight: 600 }}>$112</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Avg Target</div>
                <div className="num" style={{ fontWeight: 600, color: 'var(--accent)' }}>$168</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>High</div>
                <div className="num" style={{ fontWeight: 600 }}>$220</div>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">{asset.sym} News</h3>
          </div>
          <div className="card-body" style={{ padding: '0 16px' }}>
            {data.news.filter(n => n.tags.includes(asset.sym) || n.tags.includes('AI')).slice(0, 4).map((n, i) => (
              <div key={i} className="news-row" style={{ gridTemplateColumns: '50px 1fr' }}>
                <span className="news-time">{n.time}</span>
                <div>
                  <div className="news-title" style={{ fontSize: 13 }}>{n.title}</div>
                  <div className="news-meta">
                    <span style={{ color: 'var(--text-subtle)' }}>{n.src}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
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
    <div style={{ height: 6, background: 'var(--bg-sunken)', borderRadius: 3, position: 'relative' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${gauge}%`, background: gauge > 70 ? 'var(--accent)' : 'var(--text-muted)', borderRadius: 3 }} />
    </div>
  </div>
);

const RatioRow = ({ label, value, benchmark, last, pos }) => (
  <div style={{
    display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12,
    padding: '10px 16px', borderBottom: last ? 'none' : '1px solid var(--border)',
    alignItems: 'center',
  }}>
    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
    <span className="num" style={{ fontSize: 13, fontWeight: 600, color: pos ? 'var(--pos)' : 'var(--text)' }}>{value}</span>
    <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{benchmark}</span>
  </div>
);

const RatingBar = ({ label, value, max, color, alpha = 1 }) => (
  <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 30px', gap: 8, alignItems: 'center', marginBottom: 4 }}>
    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
    <div style={{ height: 8, background: 'var(--bg-sunken)', borderRadius: 4 }}>
      <div style={{ height: '100%', width: `${(value / max) * 100}%`, background: color, opacity: alpha, borderRadius: 4 }} />
    </div>
    <span className="num" style={{ fontSize: 11, fontWeight: 600, textAlign: 'right' }}>{value}</span>
  </div>
);

window.PageDetail = PageDetail;
