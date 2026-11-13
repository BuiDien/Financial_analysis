// Main app — wires it all together

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "density": "normal",
  "accent": "#C2410C",
  "aiOpenDefault": true
}/*EDITMODE-END*/;

// Alert types the in-app monitor can evaluate from a live quote. RSI and
// volume alerts need indicator data the monitor doesn't fetch yet.
const MONITORED_ALERT_TYPES = new Set(['price_above', 'price_below', 'pct_move']);

const describeAlertShort = (a, currency = 'USD') => {
  const px = fmtNativePrice(a.value, currency);
  const map = { price_above: `above ${px}`, price_below: `below ${px}`, pct_move: `moved ${a.value}%`, rsi_above: `RSI > ${a.value}`, rsi_below: `RSI < ${a.value}`, volume_spike: `volume ${a.value}× avg` };
  return map[a.type] || 'condition met';
};

// Header/dashboard index strip, in display order. key = field of GET
// /api/indices; BTC isn't in that response, so it's a direct quote.
const INDEX_SOURCES = [
  { sym: 'S&P 500', key: 'sp500' }, { sym: 'NASDAQ', key: 'nasdaq' }, { sym: 'DOW', key: 'dow' },
  { sym: 'RUSSELL', key: 'russell' }, { sym: 'VIX', key: 'vix' }, { sym: '10Y YIELD', key: 'ten_year' },
  { sym: 'BTC', quote: 'BTC-USD' }, { sym: 'GOLD', key: 'gold' }, { sym: 'OIL', key: 'oil' },
];

// Live-mode app data before anything has loaded: every value missing ("—"),
// each section with its own status. Never seeded from the mock snapshot.
const emptyLiveData = () => ({
  demo: false,
  indices: INDEX_SOURCES.map(i => ({ sym: i.sym, val: null, chg: null })),
  watchlist: [],
  portfolio: { demo: false, status: 'loading', holdings: [] },
  news: [],
  sectors: [],
  status: { indices: 'loading', portfolio: 'loading', news: 'loading' },
});

const mapNews = (items) => (items || []).map(n => ({
  time: fmtNewsTime(n.published),
  published: n.published ?? null,
  title: n.title, src: n.publisher || 'Wire',
  tickers: Array.isArray(n.tickers) ? n.tickers : [],
  tags: (n.tickers || []).slice(0, 3),
  url: safeHttpUrl(n.url), region: n.region, category: n.category,
}));

const mapPortfolio = (pf) => ({
  demo: false, status: 'ok',
  totalValue: pf.total_value ?? null, totalGain: pf.total_gain ?? null, totalGainPct: pf.total_gain_pct ?? null,
  dayChange: pf.today_change ?? null, dayChangePct: pf.today_change_pct ?? null,
  cash: pf.cash_value ?? null, displayCurrency: pf.display_currency || 'USD',
  holdings: (pf.holdings || []).map(h => ({
    sym: h.ticker, currency: h.currency, shares: h.shares, avgCost: h.avg_cost ?? (h.shares ? h.cost_basis / h.shares : null),
    price: h.price ?? null, value: h.value ?? null, gain: h.gain ?? null, gainPct: h.gain_pct ?? null,
    weight: h.weight ?? (pf.total_value && h.value != null ? (h.value / pf.total_value) * 100 : null),
  })),
});

const ACCENTS = [
  { id: '#C2410C', label: 'Burnt Orange' },
  { id: '#1D4ED8', label: 'Royal Blue' },
  { id: '#15803D', label: 'Forest Green' },
  { id: '#7C3AED', label: 'Indigo' },
  { id: '#BE185D', label: 'Rose' },
  { id: '#0F766E', label: 'Teal' },
];

// Catches a crash inside any single page so it can't blank the whole app.
class PageErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(err, info) { console.error('Page crashed:', err, info); }
  componentDidUpdate(prev) { if (prev.pageKey !== this.props.pageKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 64, textAlign: 'center' }}>
          <div style={{ fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 600, marginBottom: 8 }}>This page hit an error.</div>
          <div className="num" style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18 }}>{String((this.state.error && this.state.error.message) || this.state.error)}</div>
          <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

const App = () => {
  const focusedOCRReviewId = new URLSearchParams(window.location.search).get('ocrReview');
  // Offline demo snapshot — only ever shown while the backend is unreachable,
  // and flagged demo so every page labels it.
  const demoData = React.useMemo(() => ({ ...JSON.parse(document.getElementById('market-data').textContent), demo: true }), []);
  const { live: apiLive, checked: apiChecked } = useApiLive();
  const [liveData, setLiveData] = React.useState(emptyLiveData);
  const liveDataRef = React.useRef(liveData);
  liveDataRef.current = liveData;
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [page, setPage] = React.useState(() => {
    if (focusedOCRReviewId) return 'ocr-inbox';
    try {
      const s = JSON.parse(localStorage.getItem('helix_settings_v1') || '{}');
      if (s.defaultLanding === 'last') return localStorage.getItem('helix_last_page') || 'home';
      return s.defaultLanding || 'home';
    } catch { return 'home'; }
  });
  const [activeAsset, setActiveAsset] = React.useState('NVDA');
  const [aiOpen, setAiOpen] = React.useState(tweaks.aiOpenDefault);

  // When a backend that was down at load comes up, remount the page once so
  // it fetches real data instead of keeping its offline state. Later
  // reconnects don't remount (that could drop unsaved edits); pages refresh
  // from the re-hydrated data / their own status subscriptions instead.
  const [pageEpoch, setPageEpoch] = React.useState(0);
  const everLive = React.useRef(false);
  const sawOffline = React.useRef(false);
  React.useEffect(() => {
    if (!apiChecked) return;
    if (!apiLive) { sawOffline.current = true; return; }
    if (!everLive.current && sawOffline.current) setPageEpoch(e => e + 1);
    everLive.current = true;
  }, [apiLive, apiChecked]);

  const data = apiLive ? liveData : demoData;

  // Remember the last page for the "Last visited" landing option
  React.useEffect(() => { try { localStorage.setItem('helix_last_page', page); } catch {} }, [page]);

  // ── Browser back/forward ────────────────────────────────────────────
  // The app never touched window.history, so the mouse back button did
  // nothing. Seed one entry on mount, push a new entry on every
  // page/asset change, and restore state on popstate (fired for both
  // back and forward). historyMounted guards the seed effect's own
  // [page, activeAsset] dependency from pushing a duplicate entry;
  // fromHistory guards a popstate-driven state update from re-pushing.
  const historyMounted = React.useRef(false);
  const fromHistory = React.useRef(false);

  React.useEffect(() => {
    window.history.replaceState({ page, activeAsset }, '');
  }, []);

  React.useEffect(() => {
    if (!historyMounted.current) { historyMounted.current = true; return; }
    if (fromHistory.current) { fromHistory.current = false; return; }
    window.history.pushState({ page, activeAsset }, '');
  }, [page, activeAsset]);

  React.useEffect(() => {
    const onPopState = (e) => {
      fromHistory.current = true;
      const s = e.state || {};
      setPage(s.page || 'home');
      setActiveAsset(s.activeAsset || 'NVDA');
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // ── Live data ────────────────────────────────────────────────────────
  // The shell renders as soon as the first /health check resolves. While
  // live, each section (indices, portfolio, news) hydrates independently —
  // a slow or failing upstream only affects its own card. A section that
  // fails keeps its last real values, or shows an error/empty state if it
  // never loaded; it never falls back to the mock snapshot. Refreshes every
  // 5 minutes and on every offline → live transition.
  React.useEffect(() => {
    if (focusedOCRReviewId || !apiLive) return undefined;
    let cancelled = false;
    const api = window.HelixAPI;
    setLiveData(emptyLiveData());

    const setStatus = (key, value) => setLiveData(d => ({ ...d, status: { ...d.status, [key]: value } }));
    const hasReal = (key) => {
      const d = liveDataRef.current;
      if (key === 'indices') return d.indices.some(i => i.val != null);
      if (key === 'portfolio') return d.portfolio.status === 'ok';
      return d.news.length > 0;
    };
    const failed = (key) => { if (!cancelled) setStatus(key, hasReal(key) ? 'stale' : 'error'); };

    const hydrate = () => {
      if (!api.live) return;
      api.indices().then(idx => {
        if (cancelled) return;
        setLiveData(d => ({
          ...d,
          indices: d.indices.map(i => {
            const src = INDEX_SOURCES.find(x => x.sym === i.sym);
            if (!src?.key) return i;
            const q = idx?.[src.key];
            return q && isNum(q.price) ? { sym: i.sym, val: q.price, chg: isNum(q.change_pct) ? q.change_pct : null } : i;
          }),
          status: { ...d.status, indices: 'ok' },
        }));
      }).catch(() => failed('indices'));
      INDEX_SOURCES.filter(i => i.quote).forEach(src => {
        api.quote(src.quote).then(q => {
          if (cancelled || !q || !isNum(q.price)) return;
          setLiveData(d => ({ ...d, indices: d.indices.map(i => i.sym === src.sym ? { sym: i.sym, val: q.price, chg: isNum(q.change_pct) ? q.change_pct : null } : i) }));
        }).catch(() => {});
      });
      api.portfolio().then(pf => {
        if (cancelled) return;
        if (!pf || !Array.isArray(pf.holdings)) { failed('portfolio'); return; }
        setLiveData(d => ({ ...d, portfolio: mapPortfolio(pf), status: { ...d.status, portfolio: 'ok' } }));
      }).catch(() => {
        if (cancelled) return;
        if (!hasReal('portfolio')) setLiveData(d => ({ ...d, portfolio: { demo: false, status: 'error', holdings: [] } }));
        failed('portfolio');
      });
      api.news(30).then(items => {
        if (cancelled) return;
        setLiveData(d => ({ ...d, news: Array.isArray(items) ? mapNews(items) : d.news, status: { ...d.status, news: 'ok' } }));
      }).catch(() => failed('news'));
    };

    hydrate();
    const REFRESH_MS = 5 * 60 * 1000;
    const interval = setInterval(hydrate, REFRESH_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [focusedOCRReviewId, apiLive]);

  // Apply theme
  React.useEffect(() => {
    document.documentElement.setAttribute('data-theme', tweaks.theme);
  }, [tweaks.theme]);

  React.useEffect(() => {
    document.documentElement.setAttribute('data-density', tweaks.density);
  }, [tweaks.density]);

  // Apply accent color via CSS variable
  React.useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--accent', tweaks.accent);
    // Derive soft + bg variants
    const accent = tweaks.accent;
    root.style.setProperty('--accent-soft', accent + '40');
    root.style.setProperty('--accent-bg', accent + '14');
  }, [tweaks.accent]);

  const setTheme = (t) => setTweak('theme', t);

  // ── Alert monitoring ───────────────────────────────────────────────
  // Live only: fetch real quotes for every ticker with an active,
  // monitorable alert (price / % move), now and every 5 minutes. When a
  // condition is newly met, mark it triggered, toast, and notify the Alerts
  // page. Never evaluated against demo prices.
  React.useEffect(() => {
    if (!apiLive || focusedOCRReviewId) return undefined;
    let cancelled = false;
    const readAlerts = () => { try { return JSON.parse(localStorage.getItem('helix_alerts_v1') || '[]') || []; } catch { return []; } };
    const ccyOf = (sym) => (liveDataRef.current.portfolio.holdings || []).find(h => h.sym === sym)?.currency;
    const check = async () => {
      const pending = readAlerts().filter(a => a.active && !a.triggered && MONITORED_ALERT_TYPES.has(a.type));
      if (!pending.length) return;
      await QuoteStore.ensure(pending.map(a => helixMarketFor(a.ticker, a.currency || ccyOf(a.ticker)).market));
      if (cancelled || !window.HelixAPI.live) return;
      let changed = false;
      const next = readAlerts().map(a => {   // re-read: the user may have edited meanwhile
        if (!a.active || a.triggered || !MONITORED_ALERT_TYPES.has(a.type)) return a;
        const q = liveQuoteFor(a.ticker, a.currency || ccyOf(a.ticker));
        if (q.status !== 'ok') return a;
        let hit = false;
        if (a.type === 'price_above') hit = q.price > a.value;
        else if (a.type === 'price_below') hit = q.price < a.value;
        else if (a.type === 'pct_move') hit = q.chg != null && Math.abs(q.chg) >= a.value;
        if (!hit) return a;
        changed = true;
        window.toast && window.toast(`${a.ticker} alert: ${describeAlertShort(a, q.currency)} · now ${fmtNativePrice(q.price, q.currency)}`, { type: 'info', duration: 6000 });
        return { ...a, triggered: true, triggeredAt: Date.now(), triggeredPrice: q.price, currency: q.currency };
      });
      if (changed) {
        localStorage.setItem('helix_alerts_v1', JSON.stringify(next));
        window.dispatchEvent(new Event('helix-alerts-updated'));
      }
    };
    check();
    const iv = setInterval(check, 5 * 60 * 1000);
    const onSaved = () => check();
    window.addEventListener('helix-alerts-saved', onSaved);
    return () => { cancelled = true; clearInterval(iv); window.removeEventListener('helix-alerts-saved', onSaved); };
  }, [apiLive, focusedOCRReviewId]);

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  React.useEffect(() => {
    window.HelixShortcuts.install();
    window.HelixShortcuts.setHandlers({
      'command-palette': () => window.dispatchEvent(new Event('open-command-palette')),
      'toggle-ai':       () => setAiOpen(o => !o),
      'toggle-theme':    () => setTweak('theme', document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'),
      'open-settings':   () => setPage('settings'),
      'show-shortcuts':  () => window.dispatchEvent(new Event('show-shortcuts')),
      'go-home':       () => setPage('home'),
      'go-dashboard':  () => setPage('dashboard'),
      'go-detail':     () => setPage('detail'),
      'go-portfolio':  () => setPage('portfolio'),
      'go-statements': () => setPage('statements'),
      'go-screener':   () => setPage('screener'),
      'go-backtest':   () => setPage('backtest'),
      'go-sync':       () => setPage('sync'),
      'go-ocr-inbox':  () => setPage('ocr-inbox'),
      'go-news':       () => setPage('news'),
      'go-alerts':     () => setPage('alerts'),
    });
  }, []);

  if (focusedOCRReviewId) {
    return (
      <>
        <div className="app" data-focus="ocr-review" data-ai="closed">
          <main className="main" data-screen-label="ocr-review">
            <PageErrorBoundary pageKey={`ocr-review-${focusedOCRReviewId}`}>
              <PageOCRInbox setPage={setPage} />
            </PageErrorBoundary>
          </main>
        </div>
        <ToastHost />
        <PromptHost />
      </>
    );
  }

  if (!apiChecked) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid var(--border)', borderTopColor: 'var(--accent)', animation: 'helix-spin 0.8s linear infinite' }} />
        <div className="num" style={{ fontSize: 12, color: 'var(--text-muted)' }}>Connecting to the backend…</div>
        <style>{'@keyframes helix-spin { to { transform: rotate(360deg); } }'}</style>
      </div>
    );
  }

  // Command-palette tickers: every symbol in the user's watchlists.
  const paletteTickers = [...new Set(WatchlistStore.getLists().flatMap(l => l.symbols))]
    .map(sym => ({ sym, name: (SYMBOL_CATALOG[String(sym).replace(/^VN:/, '')] || {}).name || sym }));

  const Page = {
    home: PageHome,
    dashboard: PageDashboard,
    detail: PageDetail,
    portfolio: PagePortfolio,
    screener: PageScreener,
    backtest: PageBacktest,
    statements: PageStatements,
    sync: PageSync,
    'ocr-inbox': PageOCRInbox,
    news: PageNews,
    alerts: PageAlerts,
  }[page] || PageDashboard;

  return (
    <>
      <div className="app" data-ai={aiOpen ? 'open' : 'closed'}>
        <Sidebar page={page} setPage={setPage} />
        <Header indices={data.indices} theme={tweaks.theme} setTheme={setTheme} aiOpen={aiOpen} setAiOpen={setAiOpen} setPage={setPage} />
        <main className="main" data-screen-label={page}>
          <PageErrorBoundary pageKey={`${page}-${pageEpoch}`}>
          {page === 'settings' ? (
            <PageSettings
              theme={tweaks.theme} setTheme={t => setTweak('theme', t)}
              density={tweaks.density} setDensity={d => setTweak('density', d)}
              accent={tweaks.accent} setAccent={a => setTweak('accent', a)}
              accents={ACCENTS} />
          ) : (
            <Page key={pageEpoch} data={data} setPage={setPage} setActiveAsset={setActiveAsset} activeAsset={activeAsset} />
          )}
          </PageErrorBoundary>
        </main>
        {aiOpen && (
          <PageErrorBoundary pageKey="ai-panel">
            <AIPanel page={page} activeAsset={activeAsset} data={data} live={apiLive} onClose={() => setAiOpen(false)} />
          </PageErrorBoundary>
        )}
      </div>

      <ToastHost />
      <PromptHost />
      <ShortcutCheatsheet />
      <CommandPalette
        nav={[
          { id: 'home', label: 'Home', icon: 'home' },
          { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
          { id: 'detail', label: 'Asset Detail', icon: 'chart' },
          { id: 'portfolio', label: 'Portfolio', icon: 'portfolio' },
          { id: 'screener', label: 'Screener', icon: 'screener' },
          { id: 'backtest', label: 'Backtest', icon: 'trending' },
          { id: 'statements', label: 'Financial Statements', icon: 'portfolio' },
          { id: 'sync', label: 'Sync', icon: 'sync' },
          { id: 'ocr-inbox', label: 'OCR Inbox', icon: 'search' },
          { id: 'news', label: 'News & Insights', icon: 'news' },
          { id: 'alerts', label: 'Alerts', icon: 'alerts' },
          { id: 'settings', label: 'Settings', icon: 'settings' },
        ]}
        tickers={paletteTickers}
        onNavigate={(id) => setPage(id)}
        onPickTicker={(sym) => { setActiveAsset(sym); setPage('detail'); window.toast(`Opened ${sym}`, { type: 'info' }); }}
      />

      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakRadio label="Mode" value={tweaks.theme}
          options={['light', 'dark']}
          onChange={v => setTweak('theme', v)} />
        <TweakSection label="Density" />
        <TweakRadio label="Rows" value={tweaks.density}
          options={['compact', 'normal', 'comfortable']}
          onChange={v => setTweak('density', v)} />
        <TweakSection label="Accent color" />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {ACCENTS.map(a => (
            <button key={a.id} title={a.label}
              onClick={() => setTweak('accent', a.id)}
              style={{
                width: 26, height: 26, borderRadius: 6,
                background: a.id, border: tweaks.accent === a.id ? '2px solid #29261b' : '2px solid transparent',
                cursor: 'pointer', padding: 0,
              }} />
          ))}
        </div>
        <TweakSection label="Layout" />
        <TweakToggle label="AI sidebar"
          value={aiOpen}
          onChange={v => { setTweak('aiOpenDefault', v); setAiOpen(v); }} />
      </TweaksPanel>
    </>
  );
};

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
