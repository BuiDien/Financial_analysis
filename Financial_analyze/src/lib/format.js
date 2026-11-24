// Number / money formatting — the one place the app formats values for display.
// Every formatter returns "—" for a missing or non-finite value (never 0 or NaN).
//
// House style (en-US grouping everywhere, matching the rest of the UI):
//   VND money   500,000,000 ₫      (no minor unit, "₫" suffix — same as listing prices)
//   VND compact 1.5B ₫ / 500M ₫    (English magnitudes, as in market caps)
//   USD money   $1,234.56          compact $1.23B
//   other ccy   €1,234.56 / ¥1,235 (Intl, en-US)
//   prices      53,600 ₫ · 186.64 USD   (a listing's own currency, no FX)
//   percent     +1.25% / -0.40%    (sign on by default)

const DASH = '—';

// A finite number, or a numeric string. Blank strings, booleans, arrays and objects are not numbers.
const isNum = (v) => {
  if (v === null || v === undefined || typeof v === 'boolean' || typeof v === 'object') return false;
  if (typeof v === 'string' && !v.trim()) return false;
  return Number.isFinite(Number(v));
};

// "-0", "-0.00", "-$0.00", "-0 ₫": a value that rounds to zero never shows a minus sign.
const noNegZero = (str) => (str.startsWith('-') && !/[1-9]/.test(str) ? str.slice(1) : str);

const ccyOf = (c) => String(c || 'VND').toUpperCase();

// Minor-unit digits a currency is shown with by default.
const moneyDigits = (currency) => {
  const c = ccyOf(currency);
  if (c === 'VND' || c === 'JPY' || c === 'KRW') return 0;
  return 2;
};

// en-US grouping; rounding is half away from zero (Intl's default), the same for every formatter.
const group = (n, decimals) => noNegZero(Number(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));

// 1234.5 → "1,234.50" (decimals default 0). Missing → "—".
const formatNumber = (value, decimals = 0) => {
  if (!isNum(value)) return DASH;
  return group(value, decimals);
};

const UNITS = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K'], [1, '']];
// Picks the unit for |v|; when rounding at `decimals(x)` reaches 1000 (999.95K → 1000.0K) it steps up
// one unit (→ 1.00M), so a value never prints as 1000 of a smaller unit.
const pickUnit = (v, decimals) => {
  const a = Math.abs(v);
  let k = UNITS.findIndex(([n]) => a >= n);
  if (k < 0) k = UNITS.length - 1;
  while (k > 0) {
    const x = v / UNITS[k][0];
    if (Math.abs(Number(x.toFixed(decimals(x, UNITS[k][1])))) < 1000) break;
    k -= 1;
  }
  return UNITS[k];
};

// Compact magnitude: 3.49T / 832.00B / 21.30M / 4.5K / 950. `digits` overrides the decimals.
const formatCompact = (value, digits) => {
  if (!isNum(value)) return DASH;
  const v = Number(value);
  const dec = (x, u) => digits ?? (u === 'K' ? 1 : u === '' ? 0 : 2);
  const [n, u] = pickUnit(v, dec);
  return noNegZero(`${(v / n).toFixed(dec(v / n, u))}${u}`);
};

// Short compact for money: drops trailing zeros ("1.5B", "500M", "12.3K").
const compactTrim = (value) => {
  const v = Number(value);
  const dec = (x) => (Math.abs(x) >= 100 ? 0 : Math.abs(x) >= 10 ? 1 : 2);
  const [n, u] = pickUnit(v, dec);
  const x = v / n;
  return noNegZero(`${parseFloat(x.toFixed(dec(x)))}${u}`);
};

// formatMoney(500000000, 'VND')                 → "500,000,000 ₫"
// formatMoney(1500000000, 'VND', { compact })   → "1.5B ₫"
// formatMoney(1234.5, 'USD')                    → "$1,234.50"
// formatMoney(-2, 'USD', { sign: true })        → "-$2.00"; sign adds "+" for positives
// options: { compact=false, decimals (override), sign=false }
const formatMoney = (value, currency = 'VND', opts = {}) => {
  if (!isNum(value)) return DASH;
  const { compact = false, sign = false } = opts;
  const c = ccyOf(currency);
  const n = Number(value);
  // "+" only when the shown value is not zero.
  const plusFor = (body) => (sign && n > 0 && /[1-9]/.test(body) ? '+' : '');
  if (c === 'VND') {
    // `decimals` is an explicit escape hatch; the house style for VND is whole đồng.
    const body = compact ? compactTrim(n) : group(n, opts.decimals ?? 0);
    return `${plusFor(body)}${body} ₫`;
  }
  const decimals = opts.decimals ?? moneyDigits(c);
  if (compact) {
    let sym = c;
    try { sym = new Intl.NumberFormat('en-US', { style: 'currency', currency: c, currencyDisplay: 'narrowSymbol' }).formatToParts(0).find(p => p.type === 'currency')?.value || c; } catch { /* unknown code */ }
    const body = compactTrim(Math.abs(n));
    const neg = n < 0 && /[1-9]/.test(body) ? '-' : plusFor(body);
    return sym.length === 1 ? `${neg}${sym}${body}` : `${neg}${body} ${sym}`;
  }
  let body;
  try {
    body = noNegZero(new Intl.NumberFormat('en-US', { style: 'currency', currency: c, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n));
  } catch {
    body = `${group(n, decimals)} ${c}`;
  }
  return plusFor(body) + body;
};

// formatPct(1.234) → "+1.23%"; formatPct(-0.4) → "-0.40%"; { sign:false } drops the "+".
// `decimals` may be passed as a number (old fmtPct style) or in options.
const formatPct = (value, opts = {}) => {
  if (!isNum(value)) return DASH;
  const o = typeof opts === 'number' ? { decimals: opts } : opts;
  const { decimals = 2, sign = true } = o;
  const body = noNegZero(Number(value).toFixed(decimals));
  return `${sign && Number(body) > 0 ? '+' : ''}${body}%`;
};

// A listing's price in its own currency, no FX. VN stock prices are whole đồng:
// formatPrice(53600, 'VND') → "53,600 ₫"; formatPrice(186.64, 'USD') → "186.64 USD".
// { symbol:false } returns the bare number ("53,600").
const formatPrice = (value, currency = 'VND', opts = {}) => {
  if (!isNum(value)) return DASH;
  const c = ccyOf(currency);
  const { symbol = true } = opts;
  if (c === 'VND') return `${group(value, 0)}${symbol ? ' ₫' : ''}`;
  const body = group(value, opts.decimals ?? 2);
  return symbol ? `${body} ${c}` : body;
};

// News timestamp (epoch seconds): "14:05" today, "Nov 10 14:05" otherwise (year added when not this year).
const formatNewsTime = (epochSec) => {
  if (!isNum(epochSec)) return DASH;
  const d = new Date(Number(epochSec) * 1000);
  const hm = d.toTimeString().slice(0, 5);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm;
  const md = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
  return `${md} ${hm}`;
};

// Dates — en-US, 24-hour, in the viewer's time zone:
//   formatDateTime(v)                 → "Nov 24, 2026, 14:05"
//   formatDateTime(v, { year:false }) → "Nov 24, 14:05"
//   formatDate(v)                     → "Nov 24, 2026"
// `v` is a Date, epoch seconds or ms, or an ISO string. A date-only "YYYY-MM-DD" is that
// calendar day (local), and { naiveUtc:true } reads a zone-less ISO datetime as UTC
// (SQLite timestamps). Invalid or missing → "—".
const toDate = (v, { naiveUtc = false } = {}) => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  let d;
  if (v instanceof Date) d = new Date(v.getTime());
  else if (typeof v === 'number') d = new Date(v < 1e12 ? v * 1000 : v);
  else {
    const s = String(v).trim();
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (day) d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    else d = new Date(naiveUtc && /T|\s\d/.test(s) && !/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  }
  return Number.isNaN(d.getTime()) ? null : d;
};

const formatDateTime = (v, { year = true, naiveUtc = false } = {}) => {
  const d = toDate(v, { naiveUtc });
  if (!d) return DASH;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
};

const formatDate = (v) => {
  const d = toDate(v);
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : DASH;
};

export { DASH, isNum, moneyDigits, formatNumber, formatCompact, formatMoney, formatPct, formatPrice, formatNewsTime, toDate, formatDateTime, formatDate };
