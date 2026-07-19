// Main app — wires it all together

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "density": "normal",
  "accent": "#C2410C",
  "aiOpenDefault": true
}/*EDITMODE-END*/;

const describeAlertShort = (a) => {
  const map = { price_above: `above $${a.value}`, price_below: `below $${a.value}`, pct_move: `moved ${a.value}%`, rsi_above: `RSI > ${a.value}`, rsi_below: `RSI < ${a.value}`, volume_spike: `volume ${a.value}× avg` };
  return map[a.type] || 'condition met';
};

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
  const mockData = React.useMemo(() => JSON.parse(document.getElementById('market-data').textContent), []);
  // null = still deciding real-vs-mock. Renders a loading screen instead of
  // ever painting mock numbers when the backend turns out to be live.
  const [data, setData] = React.useState(null);
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
  // `data` starts null. If the backend is live we wait for a full real
  // snapshot (all 4 sections, fetched concurrently) before the first
  // setData — the app never paints mock numbers when it's about to show
  // real ones. Only when the backend is unreachable does mock data get
  // shown at all. After that first snapshot, refresh on a 5-minute timer.
  const applyIndices = (base, idx) => {
    const map = { 'S&P 500': 'sp500', 'NASDAQ': 'nasdaq', 'DOW': 'dow', 'RUSSELL': 'russell', 'VIX': 'vix', '10Y YIELD': 'ten_year', 'GOLD': 'gold', 'OIL': 'oil' };
    return base.indices.map(i => {
      const q = idx?.[map[i.sym]];
      return q && q.price ? { ...i, val: q.price, chg: q.change_pct ?? i.chg } : i;
    });
  };
  const applyWatchlist = (base, quotes) => base.watchlist.map(w => {
    const hit = quotes?.find(x => x && x.sym === w.sym);
    return hit && hit.q.price ? { ...w, price: hit.q.price, chg: hit.q.change_pct ?? w.chg } : w;
  });
  const applyPortfolio = (base, pf) => {
    if (!pf || !Array.isArray(pf.holdings)) return base.portfolio;
    return {
      ...base.portfolio,
      totalValue: pf.total_value || 0, totalGain: pf.total_gain || 0, totalGainPct: pf.total_gain_pct || 0,
      dayChange: pf.today_change || 0, dayChangePct: pf.today_change_pct || 0,
      cash: pf.cash_value || 0, displayCurrency: pf.display_currency || 'USD', demo: false,
      holdings: pf.holdings.map(h => ({
        sym: h.ticker, shares: h.shares, avgCost: h.avg_cost ?? (h.cost_basis / (h.shares || 1)),
        price: h.price, value: h.value, gain: h.gain, gainPct: h.gain_pct,
        weight: h.weight ?? (pf.total_value ? (h.value / pf.total_value) * 100 : 0),
      })),
    };
  };
  const applyNews = (base, news) => {
    if (!Array.isArray(news) || !news.length) return base.news;
    return news.map(n => ({
      time: n.published ? new Date(n.published * 1000).toTimeString().slice(0, 5) : '—',
      title: n.title, src: n.publisher || 'Wire',
      tags: (n.tickers || []).slice(0, 3), sentiment: 'neutral',
      url: n.url, region: n.region, category: n.category,
    }));
  };

  React.useEffect(() => {
    if (focusedOCRReviewId) return undefined;
    let cancelled = false;

    const hydrate = async () => {
      if (!window.HelixAPI) { setData(prev => prev || mockData); return; }
      if (!window.HelixAPI.checked) await window.HelixAPI.detect();
      if (!window.HelixAPI.live) { setData(prev => prev || mockData); return; }

      const [idx, quotes, pf, news] = await Promise.all([
        window.HelixAPI.indices().catch(() => null),
        Promise.all(mockData.watchlist.map(w =>
          window.HelixAPI.quote(w.sym).then(q => ({ sym: w.sym, q })).catch(() => null))),
        window.HelixAPI.portfolio().catch(() => null),
        window.HelixAPI.news(9).catch(() => null),
      ]);
      if (cancelled) return;
      setData(prev => {
        const base = prev || mockData;
        return {
          ...base,
          indices: applyIndices(base, idx),
          watchlist: applyWatchlist(base, quotes),
          portfolio: applyPortfolio(base, pf),
          news: applyNews(base, news),
        };
      });
    };

    hydrate();
    const REFRESH_MS = 5 * 60 * 1000;   // keep indices/quotes/portfolio/news live, not just on load
    const interval = setInterval(hydrate, REFRESH_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [focusedOCRReviewId, mockData]);

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
  // Evaluate saved alerts against current watchlist quotes. When a
  // condition is newly met, mark it triggered, fire a toast, and let the
  // Alerts page know so its list + the sidebar badge refresh.
  React.useEffect(() => {
    if (!data?.watchlist?.length) return;
    let alerts;
    try { alerts = JSON.parse(localStorage.getItem('helix_alerts_v1') || 'null'); } catch { alerts = null; }
    if (!alerts) return;
    const quote = (sym) => data.watchlist.find(w => w.sym === sym);
    let changed = false;
    const next = alerts.map(a => {
      if (!a.active || a.triggered) return a;
      const q = quote(a.ticker);
      if (!q) return a;
      let hit = false;
      if (a.type === 'price_above') hit = q.price > a.value;
      else if (a.type === 'price_below') hit = q.price < a.value;
      else if (a.type === 'pct_move') hit = Math.abs(q.chg) >= a.value;
      if (hit) {
        changed = true;
        window.toast && window.toast(`${a.ticker} alert: ${describeAlertShort(a)}`, { type: 'info', duration: 6000 });
        return { ...a, triggered: true, triggeredAt: Date.now() };
      }
      return a;
    });
    if (changed) {
      localStorage.setItem('helix_alerts_v1', JSON.stringify(next));
      window.dispatchEvent(new Event('helix-alerts-updated'));
    }
  }, [data]);

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

  if (!data) {
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', border: '3px solid var(--border)', borderTopColor: 'var(--accent)', animation: 'helix-spin 0.8s linear infinite' }} />
        <div className="num" style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading market data…</div>
        <style>{'@keyframes helix-spin { to { transform: rotate(360deg); } }'}</style>
      </div>
    );
  }

  const Page = {
    home: PageHome,
    dashboard: PageDashboard,
    detail: PageDetail,
    portfolio: PagePortfolio,
    screener: PageScreener,
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
          <PageErrorBoundary pageKey={page}>
          {page === 'settings' ? (
            <PageSettings
              theme={tweaks.theme} setTheme={t => setTweak('theme', t)}
              density={tweaks.density} setDensity={d => setTweak('density', d)}
              accent={tweaks.accent} setAccent={a => setTweak('accent', a)}
              accents={ACCENTS} />
          ) : (
            <Page data={data} setPage={setPage} setActiveAsset={setActiveAsset} activeAsset={activeAsset} />
          )}
          </PageErrorBoundary>
        </main>
        {aiOpen && <AIPanel page={page} portfolio={data.portfolio} onClose={() => setAiOpen(false)} />}
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
          { id: 'statements', label: 'Financial Statements', icon: 'portfolio' },
          { id: 'sync', label: 'Sync', icon: 'sync' },
          { id: 'ocr-inbox', label: 'OCR Inbox', icon: 'search' },
          { id: 'news', label: 'News & Insights', icon: 'news' },
          { id: 'alerts', label: 'Alerts', icon: 'alerts' },
          { id: 'settings', label: 'Settings', icon: 'settings' },
        ]}
        tickers={data.watchlist}
        filings={(() => { try { return JSON.parse(localStorage.getItem('helix_filings_v1') || '[]'); } catch { return []; } })()}
        onNavigate={(id) => setPage(id)}
        onPickTicker={(sym) => { setActiveAsset(sym); setPage('detail'); window.toast(`Opened ${sym}`, { type: 'info' }); }}
        onOpenFiling={() => setPage('statements')}
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
