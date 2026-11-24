// Build a minimal company dataset from OCR rows and register it on window.COMPANIES
// so the Financial Statements dropdown picks it up.

const COMPANY_TEMPLATE = {
  income: [
    { id: 'rev', key: 'revenue', label: 'Revenue', bold: true },
    { id: 'gp', key: 'gp', label: 'Gross Profit', bold: true },
    { id: 'oi', key: 'opinc', label: 'Operating Income', bold: true },
    { id: 'ni', key: 'ni', label: 'Net Income', bold: true, accent: true },
    { id: 'eps', key: 'eps', label: 'EPS (diluted)', format: 'currency' },
  ],
  balance: [
    { id: 'cash', key: 'cash', label: 'Cash & Equivalents' },
    { id: 'ta', key: 'ta', label: 'Total Assets', bold: true, accent: true },
    { id: 'ltd', key: 'ltd', label: 'Long-Term Debt' },
    { id: 'te', key: 'te', label: 'Total Equity', bold: true },
  ],
  cashflow: [
    { id: 'ocf', key: 'cfo', label: 'Operating Cash Flow', bold: true, accent: true },
    { id: 'capex', key: 'capex', label: 'Capex' },
    { id: 'fcf', key: 'fcf', label: 'Free Cash Flow', bold: true },
    { id: 'buyback', key: 'buyback', label: 'Buybacks' },
  ],
};

export const registerCompanyFromJob = (job) => {
  if (!window.COMPANIES || !job.rows) return false;
  const t = job.ticker;
  if (window.COMPANIES[t]) return false; // already present
  const num = (v) => { const n = parseFloat(String(v).replace(/[,$]/g, '')); return isNaN(n) ? 0 : n; };
  const find = (id) => job.rows.find(r => r.id === id);
  const build = (tmpl) => tmpl.map(row => {
    const hit = find(row.id);
    return { ...row, values: [hit ? num(hit.prev) : 0, hit ? num(hit.curr) : 0] };
  });
  window.COMPANIES[t] = {
    ticker: t, name: `${t} (imported)`, exchange: 'OCR', sector: 'Imported via Sync', fyEnd: '—',
    lastReported: { label: 'OCR', date: new Date().toISOString().slice(0, 10) },
    years: ['Prior', 'Latest'],
    income: build(COMPANY_TEMPLATE.income),
    balance: build(COMPANY_TEMPLATE.balance),
    cashflow: build(COMPANY_TEMPLATE.cashflow),
    ratios: [],
    scorecard: [],
  };
  return true;
};
