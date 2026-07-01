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
  const mockData = React.useMemo(() => JSON.parse(document.getElementById('market-data').textContent), []);
  const [data, setData] = React.useState(mockData);
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [page, setPage] = React.useState(() => {
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

  // ── Live data overlay ──────────────────────────────────────────────
  // When the Python backend is reachable, replace mock numbers with real
  // ones. Every fetch is independent and falls back silently, so the UI
  // keeps working whether or not the backend is running.
  React.useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      if (!window.HelixAPI) return;
      if (!window.HelixAPI.checked) await window.HelixAPI.detect();
      if (!window.HelixAPI.live || cancelled) return;

      const next = JSON.parse(JSON.stringify(mockData));

      // Indices
      try {
        const idx = await window.HelixAPI.indices();
        const map = { 'S&P 500': 'sp500', 'NASDAQ': 'nasdaq', 'DOW': 'dow', 'RUSSELL': 'russell', 'VIX': 'vix', '10Y YIELD': 'ten_year' };
        next.indices = next.indices.map(i => {
          const q = idx[map[i.sym]];
          return q && q.price ? { ...i, val: q.price, chg: q.change_pct ?? i.chg } : i;
        });
      } catch {}

      // Watchlist quotes
      try {
        const quotes = await Promise.all(next.watchlist.map(w =>
          window.HelixAPI.quote(w.sym).then(q => ({ sym: w.sym, q })).catch(() => null)));
        next.watchlist = next.watchlist.map(w => {
          const hit = quotes.find(x => x && x.sym === w.sym);
          return hit && hit.q.price ? { ...w, price: hit.q.price, chg: hit.q.change_pct ?? w.chg } : w;
        });
      } catch {}

      // Portfolio
      try {
        const pf = await window.HelixAPI.portfolio();
        if (pf && pf.holdings && pf.holdings.length) {
          next.portfolio = {
            ...next.portfolio,
            totalValue: pf.total_value,
            totalGain: pf.total_gain,
            totalGainPct: pf.total_gain_pct,
            holdings: pf.holdings.map(h => ({
              sym: h.ticker, shares: h.shares, avgCost: h.cost_basis / (h.shares || 1),
              price: h.price, value: h.value, gain: h.gain, gainPct: h.gain_pct,
              weight: pf.total_value ? (h.value / pf.total_value) * 100 : 0,
            })),
          };
        }
      } catch {}

      // News
      try {
        const news = await window.HelixAPI._get('/api/news?limit=9');
        if (Array.isArray(news) && news.length) {
          next.news = news.map(n => ({
            time: n.published ? new Date(n.published * 1000).toTimeString().slice(0, 5) : '—',
            title: n.title, src: n.publisher || 'Wire',
            tags: (n.tickers || []).slice(0, 3), sentiment: 'neutral',
          }));
        }
      } catch {}

      if (!cancelled) setData(next);
    };
    hydrate();
    return () => { cancelled = true; };
  }, [mockData]);

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
      'go-news':       () => setPage('news'),
      'go-alerts':     () => setPage('alerts'),
    });
  }, []);

  const Page = {
    home: PageHome,
    dashboard: PageDashboard,
    detail: PageDetail,
    portfolio: PagePortfolio,
    screener: PageScreener,
    statements: PageStatements,
    sync: PageSync,
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
        {aiOpen && <AIPanel page={page} onClose={() => setAiOpen(false)} />}
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
