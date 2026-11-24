// Main app — wires it all together: hash routes (lib/router.js), the shared
// data layer (lib/query.js + lib/data.js), shell, and the alert monitor.

import React from 'react';
import { TweakRadio, TweakSection, TweakToggle, TweaksPanel, useTweaks } from './pages/settings/tweaks-panel.jsx';
import { useApiLive } from './api-client.jsx';
import { CommandPalette, DialogHost, ErrorState, ToastHost, TooltipHost, toast, useMediaQuery, useSidebarRail } from './ui/index.js';
import { HelixShortcuts } from './shortcuts.jsx';
import { ShortcutCheatsheet } from './shortcuts-ui.jsx';
import { formatPrice } from './lib/format.js';
import { QuoteStore, SYMBOL_CATALOG, WatchlistStore, helixMarketFor, liveQuoteFor } from './watchlist-store.jsx';
import { Sidebar } from './sidebar.jsx';
import { Header } from './header.jsx';
import { AIPanel } from './pages/today/ai-panel/AIPanel.jsx';
import { PageTodaySection } from './pages/today/TodaySection.jsx';
import { PageScan } from './pages/scan/PageScan.jsx';
import { PageCompany } from './pages/company/PageCompany.jsx';
import { PagePortfolio } from './pages/portfolio/PagePortfolio.jsx';
import { PageInbox } from './pages/inbox/PageInbox.jsx';
import { PageSettings } from './pages/settings/PageSettings.jsx';
import { PageOCRInbox } from './pages/inbox-ocr/inbox-page.jsx';
import { handoff } from './handoff.js';
import { getQueryData, invalidate, useQuery } from './lib/query.js';
import { alertsApi, mapPortfolio, readAlerts, useGlobalIndices, useNews, usePortfolioRaw, useVnIndices } from './lib/data.js';
import {
  buildHash, lastTicker, navigate, normTicker, parseHash, rememberLastPage, rememberTicker, resolveTarget, useRoute,
} from './lib/router.js';

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "density": "normal",
  "accent": "#C2410C",
  "aiOpenDefault": true
}/*EDITMODE-END*/;

const AI_DRAWER_QUERY = '(max-width: 900px)';

// Alert types the in-app monitor can evaluate from a live quote. RSI and
// volume alerts need indicator data the monitor doesn't fetch yet.
const MONITORED_ALERT_TYPES = new Set(['price_above', 'price_below', 'pct_move']);

const describeAlertShort = (a, currency = 'USD') => {
  const px = formatPrice(a.value, currency);
  const map = { price_above: `above ${px}`, price_below: `below ${px}`, pct_move: `moved ${a.value}%`, rsi_above: `RSI > ${a.value}`, rsi_below: `RSI < ${a.value}`, volume_spike: `volume ${a.value}× avg` };
  return map[a.type] || 'condition met';
};

// Route → the page id the AI panel uses for its context and greeting.
const aiPageFor = (r) => {
  switch (r.section) {
    case 'today': return r.tab === 'news' ? 'news' : r.tab === 'alerts' ? 'alerts' : 'dashboard';
    case 'scan': return r.tab === 'backtest' ? 'backtest' : 'screener';
    case 'company': return r.tab === 'statements' ? 'statements' : 'detail';
    case 'inbox': return r.tab === 'sync' ? 'sync' : r.tab === 'gmail' ? 'gmail' : r.tab === 'activity' ? 'activity' : 'ocr-inbox';
    default: return r.section;
  }
};

const bareSym = (t) => normTicker(t).replace(/^VN:/, '');

// Dev-only component gallery (#/dev/ui). import.meta.env.DEV is false in `npm run build`, so the
// gallery and its chunk are dropped from the production bundle.
const DevGallery = import.meta.env.DEV ? React.lazy(() => import('./ui/Gallery.jsx')) : null;

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
        <div className="page-crash">
          <ErrorState title="This page hit an error." label="Crashed"
            message={String((this.state.error && this.state.error.message) || this.state.error)}
            detail={this.state.error && this.state.error.stack ? String(this.state.error.stack).split('\n').slice(0, 8).join('\n') : undefined}
            onRetry={() => this.setState({ error: null })} />
        </div>
      );
    }
    return this.props.children;
  }
}

const App = () => {
  const focusedOCRReviewId = new URLSearchParams(window.location.search).get('ocrReview');
  const { live: apiLive, checked: apiChecked } = useApiLive();
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const route = useRoute();
  // On narrow screens the AI panel floats over the page, so it starts closed there.
  const [aiOpen, setAiOpen] = React.useState(() => tweaks.aiOpenDefault && !(window.matchMedia && window.matchMedia('(max-width: 1100px)').matches));
  // ≤ 900px the AI panel is a modal drawer over a backdrop (it starts closed there: ≤ 1100px above).
  const aiDrawer = useMediaQuery(AI_DRAWER_QUERY);
  const [rail, toggleRail, railForced] = useSidebarRail();

  // ── Routing ─────────────────────────────────────────────────────────
  // The active asset is the company route's ticker; elsewhere it is the last
  // one opened (so "Company" in the nav, the AI panel and old setPage('detail')
  // calls know which ticker to use).
  const assetRef = React.useRef(lastTicker());
  if (route.section === 'company' && route.ticker) assetRef.current = route.ticker;
  const activeAsset = assetRef.current;

  React.useEffect(() => {
    if (route.section === 'company' && !route.ticker) {
      navigate(buildHash({ section: 'company', ticker: assetRef.current, tab: route.tab }), { replace: true });
      return;
    }
    if (route.section === 'company') rememberTicker(route.ticker);
    if (!focusedOCRReviewId) rememberLastPage(buildHash(route));
  }, [route]);

  // Pages call setActiveAsset(sym) then setPage('detail'); on the Company page
  // a new ticker switches the route in place (same tab).
  const setActiveAsset = React.useCallback((sym) => {
    const t = normTicker(sym);
    if (!t) return;
    assetRef.current = t;
    rememberTicker(t);
    const cur = parseHash(window.location.hash);
    if (cur && cur.section === 'company' && cur.ticker !== t) navigate(buildHash({ ...cur, ticker: t }));
  }, []);

  // Accepts a route hash ('#/scan/backtest') or an old page id ('screener').
  const setPage = React.useCallback((target) => {
    let ticker = assetRef.current;
    const hint = handoff.statementsTicker;
    if (target === 'statements') {
      // The route carries the ticker, so the hand-off slot is consumed here.
      handoff.statementsTicker = null;
      if (hint && bareSym(hint) !== bareSym(ticker)) ticker = normTicker(hint);
    }
    navigate(resolveTarget(target, ticker));
  }, []);

  // When a backend that was down at load comes up, remount the page once so
  // it fetches real data instead of keeping its offline state, and refresh
  // every cached query. Later reconnects only refresh the cache (a remount
  // could drop unsaved edits).
  const [pageEpoch, setPageEpoch] = React.useState(0);
  const everLive = React.useRef(false);
  const sawOffline = React.useRef(false);
  React.useEffect(() => {
    if (!apiChecked) return;
    if (!apiLive) { sawOffline.current = true; return; }
    if (sawOffline.current) invalidate([]);
    if (!everLive.current && sawOffline.current) setPageEpoch(e => e + 1);
    everLive.current = true;
  }, [apiLive, apiChecked]);

  // ── Live data (shared query cache) ──────────────────────────────────
  // Each section hydrates independently and refreshes every 5 minutes; a
  // failing source only affects its own card and never falls back to samples.
  const portfolioQ = usePortfolioRaw();
  const newsQ = useNews(30);
  const vnQ = useVnIndices();
  const globalQ = useGlobalIndices();
  const data = React.useMemo(() => ({
    indices: [...(vnQ.data || []), ...(globalQ.data || [])].map(r => ({ sym: r.sym, val: r.val, chg: r.chg })),
    portfolio: portfolioQ.data ? mapPortfolio(portfolioQ.data)
      : { status: !apiLive ? 'offline' : portfolioQ.error ? 'error' : 'loading', holdings: [] },
    news: newsQ.data || [],
    watchlist: [],
  }), [vnQ.data, globalQ.data, portfolioQ.data, portfolioQ.error, newsQ.data, apiLive]);

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
  // Live only: fetch real quotes for every ticker with an active, monitorable
  // alert (price / % move), now and every 5 minutes (and right after an alert
  // is created — alertsApi.create invalidates ['alerts']). A newly met
  // condition is PATCHed as triggered on the backend and toasted.
  useQuery(['alerts', 'monitor'], async () => {
    const ccyOf = (sym) => (getQueryData(['portfolio'])?.holdings || []).find(h => h.ticker === sym)?.currency;
    const pending = ((await readAlerts()) || []).filter(a => a.active && !a.triggered && MONITORED_ALERT_TYPES.has(a.type));
    if (!pending.length) return Date.now();
    await QuoteStore.ensure(pending.map(a => helixMarketFor(a.ticker, a.currency || ccyOf(a.ticker)).market));
    for (const a of pending) {
      const q = liveQuoteFor(a.ticker, a.currency || ccyOf(a.ticker));
      if (q.status !== 'ok') continue;
      let hit = false;
      if (a.type === 'price_above') hit = q.price > a.value;
      else if (a.type === 'price_below') hit = q.price < a.value;
      else if (a.type === 'pct_move') hit = q.chg != null && Math.abs(q.chg) >= a.value;
      if (!hit) continue;
      try {
        await alertsApi.update(a.id, { triggered: true, triggeredAt: Date.now(), triggeredPrice: q.price, currency: q.currency });
        toast(`${a.ticker} alert: ${describeAlertShort(a, q.currency)} · now ${formatPrice(q.price, q.currency)}`, { type: 'info', duration: 6000 });
      } catch (e) { console.warn('Could not mark alert triggered', e); }
    }
    return Date.now();
  }, { refreshMs: 5 * 60 * 1000, enabled: apiLive && !focusedOCRReviewId });

  // ── Keyboard shortcuts ─────────────────────────────────────────────
  React.useEffect(() => {
    HelixShortcuts.install();
    HelixShortcuts.setHandlers({
      'command-palette': () => window.dispatchEvent(new Event('toggle-command-palette')),
      'toggle-ai':       () => setAiOpen(o => !o),
      'toggle-theme':    () => setTweak('theme', document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'),
      'open-settings':   () => setPage('#/settings'),
      'show-shortcuts':  () => window.dispatchEvent(new Event('show-shortcuts')),
      'go-home':       () => setPage('#/today'),
      'go-dashboard':  () => setPage('#/today'),
      'go-detail':     () => setPage('detail'),
      'go-portfolio':  () => setPage('#/portfolio'),
      'go-statements': () => setPage('statements'),
      'go-screener':   () => setPage('#/scan'),
      'go-backtest':   () => setPage('#/scan/backtest'),
      'go-sync':       () => setPage('#/inbox/sync'),
      'go-ocr-inbox':  () => setPage('#/inbox/ocr'),
      'go-news':       () => setPage('#/today/news'),
      'go-alerts':     () => setPage('#/today/alerts'),
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
        <DialogHost />
        <TooltipHost />
      </>
    );
  }

  if (!apiChecked) {
    return (
      <div className="app-boot" role="status">
        <div className="app-boot-spin" aria-hidden="true" />
        <div className="num app-boot-text">Connecting to the backend…</div>
      </div>
    );
  }

  // Command-palette tickers: every symbol in the user's watchlists.
  const paletteTickers = [...new Set(WatchlistStore.getLists().flatMap(l => l.symbols))]
    .map(sym => ({ sym, name: (SYMBOL_CATALOG[String(sym).replace(/^VN:/, '')] || {}).name || sym }));

  const pageProps = { data, setPage, setActiveAsset, activeAsset };
  let content = null;
  switch (route.section) {
    case 'scan': content = <PageScan route={route} {...pageProps} />; break;
    case 'company': content = route.ticker ? <PageCompany route={route} {...pageProps} /> : null; break;
    case 'portfolio': content = <PagePortfolio {...pageProps} />; break;
    case 'inbox': content = <PageInbox route={route} {...pageProps} />; break;
    case 'dev': content = DevGallery ? <React.Suspense fallback={null}><DevGallery theme={tweaks.theme} setTheme={setTheme} /></React.Suspense> : null; break;
    case 'settings': content = (
      <PageSettings
        theme={tweaks.theme} setTheme={t => setTweak('theme', t)}
        density={tweaks.density} setDensity={d => setTweak('density', d)}
        accent={tweaks.accent} setAccent={a => setTweak('accent', a)}
        accents={ACCENTS} />
    ); break;
    default: content = <PageTodaySection route={route} {...pageProps} />;
  }
  const routeKey = buildHash(route);
  const aiPage = aiPageFor(route);

  return (
    <>
      <div className="app" data-ai={aiOpen ? 'open' : 'closed'} data-rail={rail ? 'true' : 'false'}>
        <Sidebar route={route} setPage={setPage} rail={rail} forced={railForced} onToggleRail={toggleRail} />
        <Header theme={tweaks.theme} setTheme={setTheme} aiOpen={aiOpen} setAiOpen={setAiOpen} setPage={setPage} />
        <main className="main" data-screen-label={routeKey}>
          <PageErrorBoundary pageKey={`${routeKey}-${pageEpoch}`}>
            <React.Fragment key={pageEpoch}>{content}</React.Fragment>
          </PageErrorBoundary>
        </main>
        {aiOpen && aiDrawer && <div className="ai-backdrop" aria-hidden="true" onClick={() => setAiOpen(false)} />}
        {aiOpen && (
          <PageErrorBoundary pageKey="ai-panel">
            <AIPanel page={aiPage} activeAsset={activeAsset} data={data} live={apiLive} drawer={aiDrawer} onClose={() => setAiOpen(false)} />
          </PageErrorBoundary>
        )}
      </div>

      <ToastHost />
      <DialogHost />
      <TooltipHost />
      <ShortcutCheatsheet />
      <CommandPalette
        nav={[
          { id: '#/today', label: 'Today', icon: 'home' },
          { id: '#/today/news', label: 'News', icon: 'news' },
          { id: '#/today/alerts', label: 'Alerts', icon: 'alerts' },
          { id: '#/scan', label: 'Scan · Screener', icon: 'screener' },
          { id: '#/scan/backtest', label: 'Scan · Backtest', icon: 'trending' },
          { id: buildHash({ section: 'company', ticker: activeAsset, tab: 'overview' }), label: `Company · ${bareSym(activeAsset)}`, icon: 'chart' },
          { id: buildHash({ section: 'company', ticker: activeAsset, tab: 'statements' }), label: `Statements · ${bareSym(activeAsset)}`, icon: 'portfolio' },
          { id: '#/portfolio', label: 'Portfolio', icon: 'portfolio' },
          { id: '#/inbox/ocr', label: 'Inbox · OCR', icon: 'search' },
          { id: '#/inbox/sync', label: 'Inbox · Sync', icon: 'sync' },
          { id: '#/inbox/gmail', label: 'Inbox · Gmail import', icon: 'download' },
          { id: '#/inbox/activity', label: 'Inbox · Activity', icon: 'trending' },
          { id: '#/settings', label: 'Settings', icon: 'settings' },
        ]}
        tickers={paletteTickers}
        onNavigate={(id) => setPage(id)}
        onPickTicker={(sym) => { navigate(buildHash({ section: 'company', ticker: sym, tab: 'overview' })); toast(`Opened ${bareSym(sym)}`, { type: 'info' }); }}
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

export { App };
