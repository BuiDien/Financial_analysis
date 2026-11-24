// Screener model: rule columns, value formatting and rule normalisation. Plain JS (no JSX).

import { formatDate, formatDateTime, formatNumber, formatPct, isNum, toDate } from '../../lib/format.js';

export const SCR_STAGES = [
  { id: 'good', title: 'Good company rules' },
  { id: 'oversold', title: 'Oversold highlight' },
];
export const SCR_BANK_OPTS = { any: 'Any', exclude: 'Exclude banks', no_financials: 'Exclude financials', only: 'Banks only' };
export const SCR_EXCHANGES = ['HOSE', 'HNX', 'UPCOM'];
export const SCR_FLAG_LABEL = { warning: 'Warning', control: 'Control', restricted: 'Restricted', suspended: 'Suspended' };

// Per-rule table column: short header + value format.
export const SCR_COLS = {
  roe_years: ['ROE', 'pct'], profit_growth: ['Profit growth', 'pct'], revenue_growth: ['Revenue growth', 'pct'],
  debt_to_equity: ['Debt/Eq', 'num'], ocf_to_profit: ['Cash flow/profit', 'pct'], pe_vs_industry: ['P/E vs industry', 'pct'],
  profit_growth_min: ['Worst yr growth', 'pct'], receivable_days_change: ['Recv days Δ', 'days'],
  inventory_days_change: ['Inv days Δ', 'days'], gross_margin_change: ['Gross margin Δ', 'pts'],
  share_dilution: ['Dilution', 'pct'], foreign_room: ['Foreign room', 'pct'],
  pb: ['P/B', 'num'], dividend_yield: ['Div yield', 'pct'], traded_value: ['Value bn', 'bn'], market_cap: ['Mkt cap bn', 'bn'],
  bank_npl: ['NPL', 'pct'], bank_nim: ['NIM', 'pct'], bank_cir: ['CIR', 'pct'], bank_car: ['CAR', 'pct'],
  rsi: ['RSI', 'num0'], price_drop: ['Drop', 'pct'], volume_spike: ['Volume', 'x'],
};
export const SCR_OVER = ['rsi', 'price_drop', 'volume_spike'];

const signed = (v, decimals) => `${v > 0 ? '+' : ''}${formatNumber(v, decimals)}`;

export const scrFmt = (id, v) => {
  if (!isNum(v)) return '—';
  const f = (SCR_COLS[id] || [])[1];
  if (f === 'pct') return formatPct(v, { decimals: Math.abs(v) < 10 ? 1 : 0, sign: false });
  if (f === 'bn') return formatNumber(v, 0);
  if (f === 'days') return `${signed(v, 0)}d`;
  if (f === 'pts') return `${signed(v, 1)} pts`;
  if (f === 'x') return `${formatNumber(v, 1)}×`;
  if (f === 'num0') return formatNumber(v, 0);
  return formatNumber(v, 2);
};

export const scrDefaultCfg = (spec) => {
  const cfg = { id: spec.id, on: false };
  Object.entries(spec.params).forEach(([k, p]) => { cfg[k] = p.default; });
  return cfg;
};

// Canonical form for dirty comparison / sending: every catalog rule, numbers as numbers.
export const scrNormalize = (catalog, rules) => Object.values(catalog).map((spec) => {
  const found = rules.find(r => r.id === spec.id);
  const cfg = found ? { ...scrDefaultCfg(spec), ...found } : scrDefaultCfg(spec);
  if (spec.id === 'scope') cfg.on = true;
  Object.keys(spec.params).forEach((k) => {
    if (spec.id !== 'scope') cfg[k] = typeof cfg[k] === 'string' && cfg[k].trim() !== '' ? Number(cfg[k]) : cfg[k];
  });
  return cfg;
});

export const scrPayload = (catalog, rules) => {
  const norm = scrNormalize(catalog, rules);
  const bad = norm.some(c => c.id !== 'scope' && Object.keys(catalog[c.id].params).some(k => typeof c[k] !== 'number' || Number.isNaN(c[k])));
  return bad ? null : norm;
};

// Step for wheel / arrow keys / spinner: 0.1 for small ratios (D/E, P/B, volume ×), else 1.
export const scrStep = (p) => p.step || (((p.unit === 'x' || !p.unit) && p.max <= 20) ? 0.1 : 1);  // days/pts → 1

// Freshness stamp: "Nov 24, 2026, 14:05" or "never".
export const fmtAge = (iso) => {
  return toDate(iso) ? formatDateTime(iso) : 'never';
};

export const fmtDate = (iso) => {
  return toDate(iso) ? formatDate(iso) : '';
};

// Score cell tone: green dot = well above the bar, amber = just above it.
export const scoreTone = (cell) => (!cell || !isNum(cell.score) ? null : cell.score >= 50 ? 'hi' : 'lo');
export const scoreClass = (cell) => (!cell || !isNum(cell.score) ? '' : cell.score >= 66 ? 'scan-s3' : cell.score >= 33 ? 'scan-s2' : '');
