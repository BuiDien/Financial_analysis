// Shared watchlist store — multiple named lists, persisted to localStorage,
// with a tiny pub/sub so the sidebar, dashboard, and detail page stay in sync.
// (Exported from this module.)

import React from 'react';
import { HelixAPI } from './api-client.jsx';
import { useQuery } from './lib/query.js';
import { formatCompact, isNum } from './lib/format.js';
import { LIVE_TICKER as HOME_LIVE_TICKER } from './pages/today/watch-board/instruments.js';

const WATCHLIST_KEY = 'helix_watchlists_v2';

// Symbol catalog — names + sectors for tickers the user can add.
const SYMBOL_CATALOG = {
  NVDA: { name: 'NVIDIA Corp', sector: 'Technology' },
  AAPL: { name: 'Apple Inc', sector: 'Technology' },
  MSFT: { name: 'Microsoft', sector: 'Technology' },
  GOOGL:{ name: 'Alphabet', sector: 'Communication' },
  AMZN: { name: 'Amazon', sector: 'Consumer Disc.' },
  META: { name: 'Meta Platforms', sector: 'Communication' },
  TSLA: { name: 'Tesla', sector: 'Consumer Disc.' },
  AVGO: { name: 'Broadcom', sector: 'Technology' },
  AMD:  { name: 'Adv. Micro Devices', sector: 'Technology' },
  TSM:  { name: 'Taiwan Semi', sector: 'Technology' },
  MU:   { name: 'Micron', sector: 'Technology' },
  ASML: { name: 'ASML Holding', sector: 'Technology' },
  ARM:  { name: 'Arm Holdings', sector: 'Technology' },
  INTC: { name: 'Intel', sector: 'Technology' },
  CRM:  { name: 'Salesforce', sector: 'Technology' },
  ORCL: { name: 'Oracle', sector: 'Technology' },
  ADBE: { name: 'Adobe', sector: 'Technology' },
  NFLX: { name: 'Netflix', sector: 'Communication' },
  JPM:  { name: 'JPMorgan Chase', sector: 'Financials' },
  BAC:  { name: 'Bank of America', sector: 'Financials' },
  V:    { name: 'Visa', sector: 'Financials' },
  MA:   { name: 'Mastercard', sector: 'Financials' },
  BRK_B:{ name: 'Berkshire Hath. B', sector: 'Financials' },
  WMT:  { name: 'Walmart', sector: 'Consumer Staples' },
  COST: { name: 'Costco', sector: 'Consumer Staples' },
  PG:   { name: 'Procter & Gamble', sector: 'Consumer Staples' },
  KO:   { name: 'Coca-Cola', sector: 'Consumer Staples' },
  PEP:  { name: 'PepsiCo', sector: 'Consumer Staples' },
  JNJ:  { name: 'Johnson & Johnson', sector: 'Healthcare' },
  UNH:  { name: 'UnitedHealth', sector: 'Healthcare' },
  LLY:  { name: 'Eli Lilly', sector: 'Healthcare' },
  PFE:  { name: 'Pfizer', sector: 'Healthcare' },
  XOM:  { name: 'Exxon Mobil', sector: 'Energy' },
  CVX:  { name: 'Chevron', sector: 'Energy' },
  HD:   { name: 'Home Depot', sector: 'Consumer Disc.' },
  DIS:  { name: 'Walt Disney', sector: 'Communication' },
  BA:   { name: 'Boeing', sector: 'Industrials' },
  CAT:  { name: 'Caterpillar', sector: 'Industrials' },
  GE:   { name: 'GE Aerospace', sector: 'Industrials' },
  T:    { name: 'AT&T', sector: 'Communication' },
};

// First run starts with one empty list — no sample symbols.
const DEFAULT_WATCHLISTS = () => ([
  { id: 'wl_main', name: 'Watchlist', symbols: [] },
]);

// ── Market symbol routing ──────────────────────────────────────────────
// App ticker → backend market symbol + price scale. Vietnamese listings go to
// vnstock/VCI via "VN:" (Yahoo has no HOSE data); VCI quotes stocks in nghìn
// đồng → ×1000 to đồng. VN indices are points: no scaling.
const HELIX_VN_INDEXES = new Set(['VNINDEX', 'VN30', 'HNXINDEX', 'HNX30', 'UPCOMINDEX']);
const helixMarketFor = (sym, currency) => {
  const s = String(sym || '').toUpperCase();
  const mapped = (HOME_LIVE_TICKER || {})[s];
  const vnHolding = String(currency || '').toUpperCase() === 'VND' && !/[.=^-]/.test(s);
  const market = s.startsWith('VN:') ? s : mapped || (vnHolding ? `VN:${s}` : s);
  const vn = market.startsWith('VN:');
  return { market, vn, scale: vn && !HELIX_VN_INDEXES.has(market.slice(3)) ? 1000 : 1 };
};

// ── Live quote cache ────────────────────────────────────────────────────
// One shared cache for every quote the app shows outside the Detail page:
// watchlists, alert monitor, AI context. Batched with limited concurrency
// (the backend makes one Yahoo/VCI call per symbol) and cached 2 minutes,
// matching the backend's own quote cache.
const QUOTE_TTL_MS = 2 * 60 * 1000;
const QuoteStore = {
  _cache: {},        // market -> { q: quote|null, at, error }
  _inflight: {},     // market -> Promise
  _queue: [],
  _active: 0,
  MAX_CONCURRENT: 4,
  _subs: new Set(),

  subscribe(fn) { this._subs.add(fn); return () => { this._subs.delete(fn); }; },
  _emit() { this._subs.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); },

  peek(market) { return this._cache[market] || null; },
  isFresh(market) { const e = this._cache[market]; return !!e && Date.now() - e.at < QUOTE_TTL_MS; },

  _pump() {
    while (this._active < this.MAX_CONCURRENT && this._queue.length) {
      const job = this._queue.shift();
      this._active++;
      job().finally(() => { this._active--; this._pump(); });
    }
  },

  fetch(market) {
    if (!market || !HelixAPI?.live) return Promise.resolve(this.peek(market)?.q || null);
    if (this._inflight[market]) return this._inflight[market];
    const p = new Promise(resolve => {
      this._queue.push(() => HelixAPI.quote(market)
        .then(q => { this._cache[market] = { q: q && isNum(q.price) ? q : null, at: Date.now(), error: null }; })
        .catch(e => { this._cache[market] = { q: null, at: Date.now(), error: e.message || String(e) }; })
        .finally(() => { delete this._inflight[market]; this._emit(); resolve(this._cache[market]?.q || null); }));
      this._pump();
    });
    this._inflight[market] = p;
    return p;
  },

  // Fetch every market that isn't fresh; resolves when all have landed.
  ensure(markets) {
    const uniq = [...new Set(markets.filter(Boolean))];
    return Promise.all(uniq.map(m => (this.isFresh(m) ? Promise.resolve(this._cache[m].q) : this.fetch(m))));
  },

  clear() { this._cache = {}; this._emit(); },
};

// Quote for an app symbol, scaled to the listing's own currency unit.
// status: 'loading' (not fetched yet) | 'ok' | 'missing' (fetch failed / no price).
const liveQuoteFor = (sym, currency) => {
  const { market, vn, scale } = helixMarketFor(sym, currency);
  const e = QuoteStore.peek(market);
  const q = e?.q || null;
  const num = (v) => (v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
  const price = num(q?.price);
  return {
    market, vn,
    status: !e ? 'loading' : price == null ? 'missing' : 'ok',
    price: price == null ? null : price * scale,
    change: num(q?.change) == null ? null : num(q.change) * scale,
    chg: num(q?.change_pct),
    marketCap: num(q?.market_cap),
    currency: String(q?.currency || (vn ? 'VND' : 'USD')).toUpperCase(),
    marketState: q?.market_state || null,
    ts: q?.ts || null,
  };
};

// Resolve a table row for a symbol: real quote fields or null ("—"), never
// invented — volume and sparklines have no live source here.
const quoteFor = (sym) => {
  const bare = String(sym).toUpperCase().replace(/^VN:/, '');
  const meta = SYMBOL_CATALOG[bare] || {};
  const q = liveQuoteFor(sym);
  return {
    sym, name: meta.name || bare, status: q.status, currency: q.currency,
    price: q.price, chg: q.chg, vol: null,
    mcap: q.marketCap == null ? null : `${formatCompact(q.marketCap)}${q.currency === 'USD' ? '' : q.currency === 'VND' ? ' ₫' : ` ${q.currency}`}`,
    spark: null,
  };
};

// React hook: keep quotes for `symbols` fresh while live (fetch now + every
// 5 minutes through the shared query cache) and re-render when any lands.
const useQuotes = (symbols, live) => {
  const [, force] = React.useReducer(x => x + 1, 0);
  React.useEffect(() => QuoteStore.subscribe(force), []);
  const key = (symbols || []).join(',');
  useQuery(['quotes', key], () => QuoteStore.ensure(key.split(',').map(s => helixMarketFor(s).market)),
    { refreshMs: 5 * 60 * 1000, enabled: !!live && !!key });
};

// Sample lists seeded by the pre-v2 app. Removed on load if the user never edited them.
const LEGACY_SEED_LISTS = {
  wl_ai:  'NVDA,AVGO,AMD,TSM,MU,ASML,ARM,MSFT',
  wl_div: 'JNJ,PG,KO,PEP,XOM,CVX,JPM,V,WMT,HD,MA,T',
  wl_meg: 'AAPL,MSFT,GOOGL,AMZN,META,NVDA',
};
const isLegacySeed = (l) =>
  !!l && LEGACY_SEED_LISTS[l.id] === (Array.isArray(l.symbols) ? l.symbols.join(',') : null);

const WatchlistStore = {
  _subs: [],
  _state: null,

  _load() {
    if (this._state) return this._state;
    try {
      const raw = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || 'null');
      if (raw && Array.isArray(raw.lists)) {
        // Drop the US sample lists the old version seeded — only when untouched.
        const lists = raw.lists.filter(l => !isLegacySeed(l));
        if (lists.length) {
          const pruned = lists.length !== raw.lists.length;
          const activeId = lists.some(l => l.id === raw.activeId) ? raw.activeId : lists[0].id;
          this._state = { ...raw, lists, activeId };
          if (pruned) this._persist();
          return this._state;
        }
      }
    } catch {}
    this._state = { lists: DEFAULT_WATCHLISTS(), activeId: 'wl_main' };
    this._persist();
    return this._state;
  },

  _persist() {
    try { localStorage.setItem(WATCHLIST_KEY, JSON.stringify(this._state)); } catch {}
    this._subs.forEach(fn => fn(this._state));
  },

  subscribe(fn) { this._subs.push(fn); return () => { this._subs = this._subs.filter(x => x !== fn); }; },

  getState() { return this._load(); },
  getLists() { return this._load().lists; },
  getActive() { const s = this._load(); return s.lists.find(l => l.id === s.activeId) || s.lists[0]; },

  setActive(id) { this._load(); this._state.activeId = id; this._persist(); },

  create(name) {
    this._load();
    const id = 'wl_' + Date.now().toString(36);
    this._state.lists.push({ id, name: name || 'New list', symbols: [] });
    this._state.activeId = id;
    this._persist();
    return id;
  },

  rename(id, name) {
    this._load();
    const l = this._state.lists.find(x => x.id === id);
    if (l) { l.name = name; this._persist(); }
  },

  remove(id) {
    this._load();
    if (this._state.lists.length <= 1) return; // keep at least one
    this._state.lists = this._state.lists.filter(x => x.id !== id);
    if (this._state.activeId === id) this._state.activeId = this._state.lists[0].id;
    this._persist();
  },

  addSymbol(listId, sym) {
    this._load();
    const l = this._state.lists.find(x => x.id === listId);
    if (l && !l.symbols.includes(sym)) { l.symbols.unshift(sym); this._persist(); }
  },

  removeSymbol(listId, sym) {
    this._load();
    const l = this._state.lists.find(x => x.id === listId);
    if (l) { l.symbols = l.symbols.filter(s => s !== sym); this._persist(); }
  },

  // Is a symbol in any list? (used for star state on detail page)
  isInAny(sym) { return this._load().lists.some(l => l.symbols.includes(sym)); },

  // Toggle membership in the active list
  toggleInActive(sym) {
    const a = this.getActive();
    if (!a) return;
    if (a.symbols.includes(sym)) this.removeSymbol(a.id, sym);
    else this.addSymbol(a.id, sym);
  },
};

// React hook: subscribe to the store and re-render on change.
const useWatchlists = () => {
  const [, force] = React.useReducer(x => x + 1, 0);
  React.useEffect(() => WatchlistStore.subscribe(force), []);
  return WatchlistStore;
};

export { HELIX_VN_INDEXES, QuoteStore, SYMBOL_CATALOG, WatchlistStore, helixMarketFor, liveQuoteFor, quoteFor, useQuotes, useWatchlists };
