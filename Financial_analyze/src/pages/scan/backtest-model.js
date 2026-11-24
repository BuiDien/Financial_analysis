// Backtest helpers: market defaults, dates, input parsing and the settings note. Plain JS.

import { formatMoney, formatNumber, formatPct, isNum } from '../../lib/format.js';

export const BT_MARKET_DEFAULTS = {
  VN: { capital: '100,000,000', fee: '0.15', tax: '0.1' },
  US: { capital: '10,000', fee: '0', tax: '0' },
};

export const btIsoDate = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
export const btYearsAgo = (years, from = new Date()) => { const d = new Date(from); d.setFullYear(d.getFullYear() - years); return btIsoDate(d); };
export const btDefaultStart = () => btYearsAgo(5);
export const btTime = (date) => Math.floor(Date.parse(String(date).slice(0, 10) + 'T00:00:00Z') / 1000);

// Quick period presets for the Start date (End stays as chosen).
export const BT_PERIODS = [
  { value: '1', label: '1Y' }, { value: '3', label: '3Y' }, { value: '5', label: '5Y' }, { value: '10', label: '10Y' },
];
// Which preset the current start/end match, else 'custom'.
export const btPeriodOf = (start, end) => {
  const hit = BT_PERIODS.find(p => btYearsAgo(Number(p.value), new Date(end + 'T00:00:00')) === start);
  return hit ? hit.value : 'custom';
};

export const btMoney = (value, currency = 'USD') => formatMoney(value, currency);
export const btPct = (value, signed = true) => formatPct(value, { sign: signed });
export const btNum = (value, digits = 2) => formatNumber(value, digits);
export const btSign = (value) => (!isNum(value) ? '' : Number(value) >= 0 ? 'pos' : 'neg');

// Blank input → null (server applies the market default); commas allowed in capital.
export const btOptNumber = (s) => {
  const t = String(s ?? '').replace(/,/g, '').trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

export const btMarketOf = (ticker) => (String(ticker || '').trim().toUpperCase().startsWith('VN:') ? 'VN' : 'US');

export const btSettingsNote = (ticker, s) => {
  if (!s) return '';
  const parts = [`lot ${formatNumber(s.lot_size)}`, `fee ${s.fee_pct}%`, `tax ${s.sell_tax_pct}%`];
  if (s.min_hold_bars > 0) {
    parts.push(`sells settle T+${s.min_hold_bars - 1} (earliest sell ${s.min_hold_bars} sessions after buy)`);
  }
  return `${btMarketOf(ticker)}: ${parts.join(' · ')}`;
};
