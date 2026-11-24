// App-wide data hooks on top of lib/query.js. Every hook is live-only: while
// the backend is offline they return no data, never sample numbers.

import { HelixAPI, useApiLive } from '../api-client.jsx';
import { formatNewsTime, isNum } from './format.js';
import { safeHttpUrl } from './safe-url.js';
import { fetchQuery, getQueryData, invalidate, setQueryData, useQuery } from './query.js';

const FIVE_MIN = 5 * 60 * 1000;

// ── Market pulse ────────────────────────────────────────────────────────
// VN indices come from vnstock/VCI via the "VN:" quote route (points, unscaled).
const VN_INDICES = [
  { sym: 'VNINDEX', label: 'VN-Index', market: 'VN:VNINDEX' },
  { sym: 'VN30', label: 'VN30', market: 'VN:VN30' },
  { sym: 'HNXINDEX', label: 'HNX-Index', market: 'VN:HNXINDEX' },
  { sym: 'UPCOMINDEX', label: 'UPCoM', market: 'VN:UPCOMINDEX' },
];

// Global context, in display order: fields of GET /api/indices (`key`), plus
// BTC, which that response lacks, as a direct quote (`quote`).
const GLOBAL_INDICES = [
  { sym: 'S&P 500', key: 'sp500' }, { sym: 'NASDAQ', key: 'nasdaq' }, { sym: 'DOW', key: 'dow' },
  { sym: 'RUSSELL', key: 'russell' }, { sym: 'VIX', key: 'vix' }, { sym: 'US 10Y', key: 'ten_year', suffix: '%' },
  { sym: 'BTC', quote: 'BTC-USD', prefix: '$' }, { sym: 'GOLD', key: 'gold', prefix: '$' }, { sym: 'OIL', key: 'oil', prefix: '$' },
];

// A null quote, or null fields (the backend nulls what Yahoo had no data for), read as
// "no value" (—), never 0: isNum(null) is false, while Number(null) would be 0.
const quoteRow = (meta, q) => ({
  ...meta,
  val: q && isNum(q.price) ? Number(q.price) : null,
  chg: q && isNum(q.change_pct) ? Number(q.change_pct) : null,
  state: q?.market_state || null,
});

const fetchVnIndices = async () => {
  const rows = await Promise.all(VN_INDICES.map(meta =>
    HelixAPI.quote(meta.market).then(q => quoteRow(meta, q)).catch(() => quoteRow(meta, null))));
  if (!rows.some(r => r.val != null)) throw new Error('No VN index quotes available');
  return rows;
};

const useVnIndices = () => {
  const { live } = useApiLive();
  const q = useQuery(['market', 'vn-indices'], fetchVnIndices, { refreshMs: FIVE_MIN, enabled: live });
  return { ...q, data: live ? q.data : undefined };
};

// /api/indices + the direct quotes, merged into one row list. A failed quote
// only blanks its own row; the whole query fails only if /api/indices does.
const fetchGlobalIndices = async () => {
  const [idx, ...quotes] = await Promise.all([
    HelixAPI.indices(),
    ...GLOBAL_INDICES.filter(m => m.quote).map(m => HelixAPI.quote(m.quote).catch(() => null)),
  ]);
  const bySym = Object.fromEntries(GLOBAL_INDICES.filter(m => m.quote).map((m, i) => [m.sym, quotes[i]]));
  return GLOBAL_INDICES.map(meta => quoteRow(meta, meta.quote ? bySym[meta.sym] : idx?.[meta.key]));
};

const useGlobalIndices = () => {
  const { live } = useApiLive();
  const q = useQuery(['market', 'indices'], fetchGlobalIndices, { refreshMs: FIVE_MIN, enabled: live });
  return { ...q, data: live ? q.data : undefined };
};

// ── News ────────────────────────────────────────────────────────────────
const mapNews = (items) => (items || []).map(n => ({
  time: formatNewsTime(n.published),
  published: n.published ?? null,
  title: n.title, src: n.publisher || 'Wire',
  tickers: Array.isArray(n.tickers) ? n.tickers : [],
  tags: (n.tickers || []).slice(0, 3),
  url: safeHttpUrl(n.url), region: n.region, category: n.category,
}));

const useNews = (limit = 30) => {
  const { live } = useApiLive();
  const q = useQuery(['news', limit], () => HelixAPI.news(limit).then(items => mapNews(Array.isArray(items) ? items : [])),
    { refreshMs: FIVE_MIN, enabled: live });
  return { ...q, data: live ? q.data : undefined };
};

// ── Portfolio ───────────────────────────────────────────────────────────
const fetchPortfolio = () => HelixAPI.portfolio().then(pf => {
  if (!pf || !Array.isArray(pf.holdings)) throw new Error('Unexpected portfolio response');
  return pf;
});

// Raw /api/portfolio payload (Portfolio page uses it as-is).
const usePortfolioRaw = () => {
  const { live } = useApiLive();
  // Live quotes still loading on the backend (it answered with stored prices):
  // poll again soon instead of waiting five minutes.
  const pending = getQueryData(['portfolio'])?.quotes_pending > 0;
  const q = useQuery(['portfolio'], fetchPortfolio, { refreshMs: pending ? 8000 : FIVE_MIN, enabled: live });
  return { ...q, data: live ? q.data : undefined, live };
};

// Camel-cased summary used by Today / Company / AI panel.
const mapPortfolio = (pf) => ({
  status: 'ok',
  totalValue: pf.total_value ?? null, totalGain: pf.total_gain ?? null, totalGainPct: pf.total_gain_pct ?? null,
  dayChange: pf.today_change ?? null, dayChangePct: pf.today_change_pct ?? null,
  cash: pf.cash_value ?? null, displayCurrency: pf.display_currency || 'USD',
  holdings: (pf.holdings || []).map(h => ({
    sym: h.ticker, currency: h.currency, shares: h.shares, avgCost: h.avg_cost ?? (h.shares ? h.cost_basis / h.shares : null),
    price: h.price ?? null, value: h.value ?? null, gain: h.gain ?? null, gainPct: h.gain_pct ?? null,
    weight: h.weight ?? (pf.total_value && h.value != null ? (h.value / pf.total_value) * 100 : null),
  })),
});

// ── Alerts (/api/alerts) ────────────────────────────────────────────────
const LEGACY_ALERTS_KEY = 'helix_alerts_v1';
const ALERTS_KEY = ['alerts', 'list'];

const UNIMPORTED_KEY = 'helix_alerts_v1_unimported';
const IMPORT_FAILED_KEY = 'helix_alerts_import_failed';   // sessionStorage

const finiteOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : NaN);

// Split legacy alerts into ones the backend import accepts and ones it would
// reject (non-object, no ticker/type, non-numeric value / triggeredPrice /
// triggeredAt). Numeric strings are coerced.
const sanitizeLegacyAlerts = (list) => {
  const ok = [];
  const bad = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { bad.push(raw); continue; }
    const ticker = typeof raw.ticker === 'string' ? raw.ticker.trim() : '';
    const type = typeof raw.type === 'string' ? raw.type.trim() : '';
    const value = finiteOrNull(raw.value);
    const triggeredPrice = finiteOrNull(raw.triggeredPrice);
    const triggeredAt = finiteOrNull(raw.triggeredAt);
    if (!ticker || !type || value === null || Number.isNaN(value) || Number.isNaN(triggeredPrice) || Number.isNaN(triggeredAt)) { bad.push(raw); continue; }
    const clean = { ...raw, ticker, type, value };
    if (triggeredPrice !== null) clean.triggeredPrice = triggeredPrice;
    if (triggeredAt !== null) clean.triggeredAt = Math.round(triggeredAt);
    if (clean.id !== undefined && clean.id !== null) clean.id = String(clean.id);
    ok.push(clean);
  }
  return { ok, bad };
};

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

// One-time move of the old localStorage alerts into the backend. Invalid items
// are skipped client-side and parked under `helix_alerts_v1_unimported` (never
// silently dropped). The legacy key is removed only after the import call
// returns 2xx; a failed import is not retried again in this browser session.
let migration = null;
const migrateLocalAlerts = () => {
  if (migration) return migration;
  let local = null;
  try { local = JSON.parse(lsGet(LEGACY_ALERTS_KEY) || 'null'); } catch { local = undefined; }
  if (local === null) return (migration = Promise.resolve());
  if (!Array.isArray(local)) {
    // Unparseable / not a list: park the raw value instead of importing it.
    lsSet(UNIMPORTED_KEY, lsGet(LEGACY_ALERTS_KEY) || '');
    lsDel(LEGACY_ALERTS_KEY);
    return (migration = Promise.resolve());
  }
  let failedBefore = false;
  try { failedBefore = sessionStorage.getItem(IMPORT_FAILED_KEY) === '1'; } catch { /* ignore */ }
  if (failedBefore) return (migration = Promise.resolve());
  const { ok, bad } = sanitizeLegacyAlerts(local);
  const park = () => {
    if (!bad.length) return;
    let prev = [];
    try { prev = JSON.parse(lsGet(UNIMPORTED_KEY) || '[]'); } catch { prev = []; }
    lsSet(UNIMPORTED_KEY, JSON.stringify([...(Array.isArray(prev) ? prev : []), ...bad]));
  };
  if (!ok.length) { park(); lsDel(LEGACY_ALERTS_KEY); return (migration = Promise.resolve()); }
  migration = HelixAPI.importAlerts(ok)
    .then(() => { park(); lsDel(LEGACY_ALERTS_KEY); })
    .catch(e => {
      try { sessionStorage.setItem(IMPORT_FAILED_KEY, '1'); } catch { /* ignore */ }
      console.warn('Alert import failed; will retry in a new session', e);
    });
  return migration;
};

const fetchAlerts = async () => {
  await migrateLocalAlerts();
  const list = await HelixAPI.alerts();
  return Array.isArray(list) ? list : [];
};

const useAlerts = () => {
  const { live } = useApiLive();
  const q = useQuery(ALERTS_KEY, fetchAlerts, { refreshMs: FIVE_MIN, enabled: live });
  return { ...q, data: live ? q.data : undefined, live };
};

const readAlerts = () => fetchQuery(ALERTS_KEY, fetchAlerts);

const alertsApi = {
  async create(alert) {
    const saved = await HelixAPI.createAlert(alert);
    setQueryData(ALERTS_KEY, (list = []) => [saved, ...list.filter(a => a.id !== saved.id)]);
    invalidate(['alerts']);
    return saved;
  },
  async update(id, patch) {
    const saved = await HelixAPI.updateAlert(id, patch);
    setQueryData(ALERTS_KEY, (list = []) => list.map(a => (a.id === id ? saved || { ...a, ...patch } : a)));
    return saved;
  },
  async remove(id) {
    await HelixAPI.deleteAlert(id);
    setQueryData(ALERTS_KEY, (list = []) => list.filter(a => a.id !== id));
  },
  async clear() {
    const out = await HelixAPI.clearAlerts();
    setQueryData(ALERTS_KEY, []);
    return out;
  },
};

// ── Jobs (/api/jobs) ────────────────────────────────────────────────────
// Polls fast while something is queued/running, slowly otherwise, and stops
// polling once the endpoint answers 404 (older backend without the job runner).
let jobsMissing = false;   // last call 404'd: stop polling until a manual refresh / remount
const useJobs = ({ status, kind, limit = 100 } = {}) => {
  const { live } = useApiLive();
  const key = ['jobs', { status, kind, limit }];
  const prev = getQueryData(key);
  const busy = Array.isArray(prev) && prev.some(j => j && (j.status === 'running' || j.status === 'queued'));
  const q = useQuery(key, async () => {
    try {
      const out = await HelixAPI.jobs({ status, kind, limit });
      jobsMissing = false;
      return Array.isArray(out?.items) ? out.items : [];  // GET /api/jobs → { items: [...] }
    } catch (e) {
      if (e?.status === 404) jobsMissing = true;
      throw e;
    }
  }, { refreshMs: jobsMissing ? 0 : busy ? 2000 : 15000, enabled: live });
  const unavailable = q.error?.status === 404;
  return { ...q, data: live ? q.data : undefined, live, unavailable };
};

export {
  VN_INDICES, GLOBAL_INDICES,
  useVnIndices, useGlobalIndices, useNews, mapNews,
  usePortfolioRaw, mapPortfolio,
  useAlerts, readAlerts, alertsApi, migrateLocalAlerts, sanitizeLegacyAlerts,
  useJobs,
};
