// Pure sort helpers for DataTable (no React, so node tests can import them).

const SCALE = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

// Lenient number parse for display strings: "1,234" → 1234, "500,000,000 ₫" → 5e8, "+1.25%" → 1.25,
// "−10%" (U+2212) → -10, "3.49T" → 3.49e12, "$1.2B" → 1.2e9, "(12)" stays NaN. Returns NaN if the
// value is not a number after stripping grouping, currency, percent and sign decorations.
const lenientNumber = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  let s = v.trim().replace(/−/g, '-').replace(/[,\s ₫$€£¥%+]/g, '').replace(/đ$/i, '');
  if (!s) return NaN;
  let mul = 1;
  const last = s.slice(-1).toUpperCase();
  if (SCALE[last] && /\d/.test(s.slice(-2, -1))) { mul = SCALE[last]; s = s.slice(0, -1); }
  if (!/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return NaN;
  return Number(s) * mul;
};

const isEmptyVal = (v) => v === null || v === undefined || v === '' || (typeof v === 'string' && !v.trim()) || v === '—'
  || (typeof v === 'number' && !Number.isFinite(v));

// Numbers (and number-like display strings) compare numerically; anything else by locale text.
const compareValues = (a, b) => {
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(a) - Number(b);
  const na = lenientNumber(a), nb = lenientNumber(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  if (Number.isFinite(na) !== Number.isFinite(nb)) return Number.isFinite(na) ? -1 : 1;   // numbers before text
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
};

// Stable sort; empty values last in both directions.
const sortRows = (rows, val, dir) => {
  const d = dir === 'asc' ? 1 : -1;
  return rows.map((r, i) => ({ r, i })).sort((x, y) => {
    const a = val(x.r), b = val(y.r);
    const ea = isEmptyVal(a), eb = isEmptyVal(b);
    if (ea || eb) return ea === eb ? x.i - y.i : ea ? 1 : -1;
    return compareValues(a, b) * d || x.i - y.i;
  }).map(x => x.r);
};

export { lenientNumber, compareValues, isEmptyVal, sortRows };
