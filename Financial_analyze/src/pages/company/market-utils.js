// Company overview: pure market helpers (bars, quotes, polling, technical indicators).
// Every number on the Overview tab comes from the backend (quote, history, ratios) or is
// computed here from real daily closes. Nothing is invented.

import { helixMarketFor } from '../../watchlist-store.jsx';

// Candle timeframes: [first window to load, bar interval]. Scrolling left loads older
// windows, so the window only sets how much shows at first. 3M (quarter) candles are
// built from monthly bars — no provider serves them.
const DETAIL_RANGES = {
  '5m': ['5d', '5m'], '15m': ['1mo', '15m'], '1H': ['3mo', '1h'],
  '1D': ['1y', '1d'], '1W': ['5y', '1wk'], '1M': ['5y', '1mo'], '3M': ['5y', '1mo'],
};

// How far back each scroll-back request reaches, per bar size.
const OLDER_CHUNK = { '5m': '5d', '15m': '1mo', '1h': '3mo', '1d': '1y', '1wk': '5y', '1mo': '5y' };

// How often the page re-pulls the quote / chart while visible. The backend caches quotes
// 120s and history 300s, so faster polling buys nothing. Daily+ candles: the live quote
// updates the last bar.
const QUOTE_POLL_MS = 60 * 1000;
const CHART_POLL_MS = { '5m': 2 * 60 * 1000, '15m': 2 * 60 * 1000, '1H': 5 * 60 * 1000 };

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

// App ticker → backend market symbol + price scale (shared rule in watchlist-store.jsx):
// "VN:" → vnstock/VCI, VN stock prices ×1000 (nghìn đồng → đồng), VN indices unscaled.
const resolveMarket = (sym, holding) => helixMarketFor(sym, holding?.currency);

// Bars are plotted in the exchange's own clock: the wall-clock part of the date string
// ("2026-11-05 09:15:00" for HOSE, "2026-11-03 09:30:00-05:00" for NASDAQ) is stored as if
// it were UTC, which is what Lightweight Charts displays. `off` keeps the exchange's UTC
// offset in minutes (VCI strings carry none — they are Vietnam time, UTC+7).
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

export {
  DETAIL_RANGES, OLDER_CHUNK, QUOTE_POLL_MS, CHART_POLL_MS, VN_OFFSET_MIN,
  toQuarters, resolveMarket, toBar, fmtOffset, scaleQuote, computeTechnicals, clampPct,
};
