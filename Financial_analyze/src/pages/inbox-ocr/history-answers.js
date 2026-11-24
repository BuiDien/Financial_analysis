// OCR Inbox: "Add to history" answer helpers — table kinds, units, period options, payload (pure; node-testable).
import { formatMoney } from '../../lib/format.js';

const HISTORY_KIND_OPTIONS = [
  { value: 'balance', label: 'Balance sheet' },
  { value: 'income', label: 'Income statement' },
  { value: 'cashflow', label: 'Cash flow' },
  { value: 'skip', label: 'Skip', hint: 'not a statement table' },
];
const HISTORY_KIND_NAMES = { balance: 'Balance sheet', income: 'Income statement', cashflow: 'Cash flow', skip: 'Skipped' };
const HISTORY_UNIT_OPTIONS = [
  { value: 1, label: 'đồng' },
  { value: 1000, label: 'nghìn đồng', hint: '× 1,000' },
  { value: 1000000, label: 'triệu đồng', hint: '× 1,000,000' },
  { value: 1000000000, label: 'tỷ đồng', hint: '× 1,000,000,000' },
];
const HISTORY_TABLE_CODES = new Set(['review_not_verified', 'labels_missing', 'table_kind_unknown', 'unit_unknown', 'column_period_unknown', 'period_mismatch']);
const HISTORY_EMPTY_DRAFT = { tables: {}, lines: {}, misreads: {}, resolutions: {} };

const historyTableKey = (page, table) => `${page}:${table}`;
const historyRowKey = (page, table, row) => `${page}:${table}:${row}`;
const historyMisreadKey = m => `${m.page}:${m.content_sha256}:${m.table}:${m.parent_row}:${m.column_label}`;
const historyDmy = iso => { const [y, m, d] = String(iso).split('-'); return `${d}/${m}/${y}`; };
const historyPeriodValue = p => (p ? `${p.type}|${p.start || ''}|${p.end}` : '');
const historyPeriodText = p => {
  if (!p) return { label: 'Unknown period', hint: '' };
  const year = String(p.end).slice(0, 4);
  if (p.type === 'instant') return { label: `At ${historyDmy(p.end)}`, hint: 'balance date' };
  const range = `${historyDmy(p.start)} – ${historyDmy(p.end)}`;
  if (p.type === 'quarter') return { label: `Q${Math.ceil(Number(String(p.end).slice(5, 7)) / 3)} ${year}`, hint: range };
  if (p.type === 'year') return { label: `FY ${year}`, hint: range };
  const months = (Number(String(p.end).slice(0, 4)) - Number(String(p.start).slice(0, 4))) * 12
    + Number(String(p.end).slice(5, 7)) - Number(String(p.start).slice(5, 7)) + 1;
  return { label: `${months}M ${year} year to date`, hint: range };
};
// Every period a column of this filing could plausibly hold, for the owner to pick from.
const historyPeriodOptions = (fiscalYear, current) => {
  const options = [];
  const add = p => { if (!options.some(o => o.value === historyPeriodValue(p))) options.push({ value: historyPeriodValue(p), ...historyPeriodText(p), period: p }); };
  if (current) add(current);
  const base = Number(fiscalYear) || new Date().getFullYear();
  [base, base - 1].forEach(y => {
    [['01-01', '03-31'], ['04-01', '06-30'], ['07-01', '09-30'], ['10-01', '12-31']].forEach(([a, b]) => add({ type: 'quarter', start: `${y}-${a}`, end: `${y}-${b}` }));
    add({ type: 'ytd', start: `${y}-01-01`, end: `${y}-06-30` });
    add({ type: 'ytd', start: `${y}-01-01`, end: `${y}-09-30` });
    add({ type: 'year', start: `${y}-01-01`, end: `${y}-12-31` });
    ['03-31', '06-30', '09-30', '12-31'].forEach(d => add({ type: 'instant', start: null, end: `${y}-${d}` }));
  });
  options.push({ value: 'skip', label: 'Skip this column', hint: 'not a value column' });
  return options;
};
const historyMoney = value => formatMoney(value, 'VND');

const historyPayload = (draft, revision) => ({
  revision,
  tables: Object.entries(draft.tables).map(([key, answer]) => {
    const [page, table] = key.split(':').map(Number);
    const out = { page, table, columns: Object.values(answer.columns || {}) };
    if (answer.kind) out.kind = answer.kind;
    if (answer.unit_multiplier) out.unit_multiplier = answer.unit_multiplier;
    return out;
  }),
  // A new line without a name is not an answer yet (the row stays open).
  lines: Object.entries(draft.lines)
    .filter(([, answer]) => answer.line_key || (answer.new_line_name || '').trim())
    .map(([key, answer]) => {
      const [page, table, row] = key.split(':').map(Number);
      return answer.line_key ? { page, table, row, line_key: answer.line_key } : { page, table, row, new_line_name: answer.new_line_name.trim() };
    }),
  accepted_misreads: Object.values(draft.misreads),
  resolutions: Object.entries(draft.resolutions).map(([fact_key, chosen]) => ({ fact_key, chosen })),
});

const HISTORY_SCOPE_OPTIONS = [
  { value: 'consolidated', label: 'Consolidated', hint: 'hợp nhất' },
  { value: 'separate', label: 'Separate', hint: 'riêng lẻ' },
];
const HISTORY_PERIOD_CODE_OPTIONS = ['Q1', 'Q2', 'Q3', 'Q4', 'H1', 'FY'].map(code => ({
  value: code, label: code, hint: { H1: 'first half (6 months)', FY: 'full fiscal year' }[code] || 'quarter',
}));
// Values are spelled the way backend parse_unit_multiplier understands them.
const LABEL_UNIT_OPTIONS = [
  { value: 'triệu đồng', label: 'triệu đồng', hint: 'million VND — most BCTC' },
  { value: 'đồng', label: 'đồng', hint: 'VND' },
  { value: 'nghìn đồng', label: 'nghìn đồng', hint: 'thousand VND' },
  { value: 'tỷ đồng', label: 'tỷ đồng', hint: 'billion VND' },
];
const inboxLabelSummary = labels => {
  if (!labels || !labels.ticker || !labels.scope || !labels.fiscal_year || !labels.period_code) return null;
  const scope = labels.scope === 'consolidated' ? 'Consolidated' : labels.scope === 'separate' ? 'Separate' : labels.scope;
  return `${labels.ticker} · ${scope} · ${labels.period_code} ${labels.fiscal_year}`;
};
// Latest quarter that has ended (Nov 2026 → Q3 2026; Feb 2027 → Q4 2026).
const inboxLatestQuarter = (now = new Date()) => {
  const done = Math.floor(now.getMonth() / 3);
  return done === 0 ? { fiscal_year: now.getFullYear() - 1, period_code: 'Q4' } : { fiscal_year: now.getFullYear(), period_code: `Q${done}` };
};
const historyFiscalYearOptions = current => {
  const now = new Date().getFullYear();
  const years = [];
  for (let year = now + 1; year >= now - 15; year--) years.push(year);
  if (current && !years.includes(Number(current))) years.push(Number(current));
  return years.sort((a, b) => b - a).map(year => ({ value: year, label: String(year) }));
};

export { HISTORY_KIND_OPTIONS, HISTORY_KIND_NAMES, HISTORY_UNIT_OPTIONS, HISTORY_TABLE_CODES, HISTORY_EMPTY_DRAFT, historyTableKey, historyRowKey, historyMisreadKey, historyDmy, historyPeriodValue, historyPeriodText, historyPeriodOptions, historyMoney, historyPayload, HISTORY_SCOPE_OPTIONS, HISTORY_PERIOD_CODE_OPTIONS, LABEL_UNIT_OPTIONS, inboxLabelSummary, inboxLatestQuarter, historyFiscalYearOptions };
