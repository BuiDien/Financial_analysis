// Statements helpers: Vietnamese tỷ formatting (deliberate exception to lib/format.js, see
// src/ui/README.md), period labels and the calculated-quarter explanations.

const HX_MAX_LINES = 8;
const HX_SLOTS = Array.from({ length: HX_MAX_LINES }, (_, i) => `var(--lx-series-${i + 1})`);
const HX_KIND = { balance: 'Balance sheet', income: 'Income statement', cashflow: 'Cash flow' };
const HX_SCOPE = { consolidated: 'Consolidated', separate: 'Separate' };

const hxStore = {
  get(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
};

// Vietnamese grouping ("1.615.764", "12,5"); tỷ = 1e9 đồng.
const hxTy = (v) => {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  const t = v / 1e9, a = Math.abs(t);
  const digits = a === 0 ? 0 : a < 10 ? 2 : a < 100 ? 1 : 0;
  return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: digits }).format(t);
};
// Raw tỷ for copying: "." decimal, no thousands grouping, exact from integer đồng.
const hxTyRaw = (v) => {
  if (v === null || v === undefined || !isFinite(v)) return '';
  const digits = String(Math.abs(Math.round(v))).padStart(10, '0');
  const whole = digits.slice(0, -9).replace(/^0+(?=\d)/, '');
  const frac = digits.slice(-9).replace(/0+$/, '');
  return `${v < 0 ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
};
const hxDong = (v) => (v === null || v === undefined ? '—' : `${new Intl.NumberFormat('vi-VN').format(v)} đồng`);
const hxDate = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const hxQuarter = (iso) => { const [y, m] = iso.split('-').map(Number); return `Q${Math.ceil(m / 3)} ${y}`; };
const hxEnd = (y, m) => `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
// Every quarter end (or every 31/12) from the period ending at/after `first` up to `last`.
const hxPeriodRun = (first, last, grain) => {
  const out = [];
  let y = Number(first.slice(0, 4)), m = Number(first.slice(5, 7));
  if (grain === 'year') m = 12; else m = Math.ceil(m / 3) * 3;
  for (let guard = 0; guard < 400; guard++) {
    const iso = hxEnd(y, m);
    if (iso > last) break;
    out.push(iso);
    if (grain === 'year') y += 1; else { m += 3; if (m > 12) { m -= 12; y += 1; } }
  }
  return out;
};
const hxXLabel = (iso, grain) => (grain === 'year' ? iso.slice(0, 4) : hxQuarter(iso));
const hxQuarterOrYear = (p) => (p.period_type === 'year' ? `FY ${p.period_end.slice(0, 4)}` : hxQuarter(p.period_end));

const hxPeriodText = (p) => {
  if (!p) return '';
  if (p.period_type === 'instant') return `at ${hxDate(p.period_end)}`;
  if (p.period_type === 'year') return `FY ${p.period_end.slice(0, 4)} · ${hxDate(p.period_start)} – ${hxDate(p.period_end)}`;
  return `${hxQuarter(p.period_end)} · ${hxDate(p.period_start)} – ${hxDate(p.period_end)}`;
};
// How a calculated quarter was derived (history_facts.derive_missing_quarters): Q4 = FY − 9M,
// Q3 = 9M − 6M, Q2 = 6M − 3M (or Q1), Q1 = 3M.
const hxFormula = (p) => {
  if (!p || p.period_type !== 'quarter' || !p.period_start) return 'calculated from printed periods';
  const y = p.period_start.slice(0, 4), m = Number(p.period_start.slice(5, 7));
  if (m === 10) return `calculated: FY ${y} − 9M ${y}`;
  if (m === 7) return `calculated: 9M ${y} − 6M ${y}`;
  if (m === 4) return `calculated: 6M ${y} − Q1 ${y}`;
  return `calculated: 3M ${y}`;
};
const hxStatusText = (p) => {
  if (!p) return '';
  if (p.status === 'conflict') return `${p.sources.length} · values differ`;
  if (p.status === 'agree') return `${new Set(p.sources.map(s => s.inbox_item_id)).size} sources agree`;
  if (p.status === 'resolved') return 'chosen by you';
  return '1 source';
};

export {
  HX_MAX_LINES, HX_SLOTS, HX_KIND, HX_SCOPE, hxStore, hxTy, hxTyRaw, hxDong, hxDate, hxQuarter,
  hxPeriodRun, hxXLabel, hxQuarterOrYear, hxPeriodText, hxFormula, hxStatusText,
};
