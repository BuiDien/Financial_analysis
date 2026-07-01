// Financial Statements analysis page

const COMPANIES = {
  NVDA: {
    ticker: 'NVDA', name: 'NVIDIA Corp', exchange: 'NASDAQ', sector: 'Semiconductors', fyEnd: 'Jan',
    lastReported: { label: 'Q4 FY25', date: 'Feb 26, 2026' },
    years: ['FY21', 'FY22', 'FY23', 'FY24', 'FY25'],
    income: [
      { label: 'Revenue', key: 'revenue', values: [16675, 26914, 26974, 60922, 130497], bold: true },
      { label: 'Cost of Revenue', key: 'cogs', values: [6279, 9439, 11618, 16621, 32500] },
      { label: 'Gross Profit', key: 'gp', values: [10396, 17475, 15356, 44301, 97997], bold: true },
      { label: 'R&D', key: 'rd', values: [3924, 5268, 7339, 8675, 12914] },
      { label: 'SG&A', key: 'sga', values: [1940, 2166, 2440, 2654, 3494] },
      { label: 'Operating Income', key: 'opinc', values: [4532, 10041, 5577, 32972, 81588], bold: true },
      { label: 'Net Income', key: 'ni', values: [4332, 9752, 4368, 29760, 72880], bold: true, accent: true },
      { label: 'EPS (diluted)', key: 'eps', values: [1.73, 3.85, 1.74, 11.93, 29.76], format: 'currency' },
    ],
    balance: [
      { label: 'Cash & Equivalents', key: 'cash', values: [11561, 21208, 13296, 25984, 38487] },
      { label: 'Total Current Assets', key: 'tca', values: [16055, 28829, 23073, 44345, 80126], bold: true },
      { label: 'Total Assets', key: 'ta', values: [28791, 44187, 41182, 65728, 111601], bold: true, accent: true },
      { label: 'Total Current Liabilities', key: 'tcl', values: [3925, 4335, 6563, 10631, 18047] },
      { label: 'Long-Term Debt', key: 'ltd', values: [5964, 10946, 9703, 8460, 8463] },
      { label: 'Total Liabilities', key: 'tl', values: [11898, 17575, 19081, 22750, 32309], bold: true },
      { label: 'Total Equity', key: 'te', values: [16893, 26612, 22101, 42978, 79292], bold: true },
    ],
    cashflow: [
      { label: 'Operating Cash Flow', key: 'cfo', values: [5822, 9108, 5641, 28090, 64089], bold: true, accent: true },
      { label: 'Capex', key: 'capex', values: [-1128, -976, -1833, -1069, -3236] },
      { label: 'Free Cash Flow', key: 'fcf', values: [4694, 8132, 3808, 27021, 60853], bold: true },
      { label: 'Investing Activities', key: 'cfi', values: [-19675, -9830, 7375, -10566, -20421] },
      { label: 'Dividends Paid', key: 'div', values: [-395, -399, -398, -395, -834] },
      { label: 'Buybacks', key: 'buyback', values: [0, -2883, -10039, -9533, -33706] },
      { label: 'Financing Activities', key: 'cff', values: [3804, -11617, -11617, -13633, -42359] },
      { label: 'Net Change in Cash', key: 'nccash', values: [-10049, -12339, 1399, 4001, 1309] },
    ],
    ratios: [
      { group: 'Profitability', items: [
        { label: 'Gross Margin', val: 75.1, pct: true, peer: 53.4, signal: 'pos' },
        { label: 'Operating Margin', val: 62.5, pct: true, peer: 24.8, signal: 'pos' },
        { label: 'Net Margin', val: 55.8, pct: true, peer: 18.2, signal: 'pos' },
        { label: 'Return on Equity', val: 119.2, pct: true, peer: 18.4, signal: 'pos' },
        { label: 'Return on Assets', val: 65.3, pct: true, peer: 8.1, signal: 'pos' },
      ]},
      { group: 'Liquidity & Solvency', items: [
        { label: 'Current Ratio', val: 4.44, peer: 1.82, signal: 'pos' },
        { label: 'Quick Ratio', val: 3.81, peer: 1.41, signal: 'pos' },
        { label: 'Debt / Equity', val: 0.11, peer: 0.62, signal: 'pos' },
        { label: 'Interest Coverage', val: 187.4, suffix: '×', peer: 14.2, signal: 'pos' },
      ]},
      { group: 'Efficiency', items: [
        { label: 'Asset Turnover', val: 1.17, suffix: '×', peer: 0.84, signal: 'pos' },
        { label: 'Inventory Days', val: 198, suffix: 'd', peer: 78, signal: 'neg' },
        { label: 'Receivables Days', val: 67, suffix: 'd', peer: 54, signal: 'neutral' },
      ]},
      { group: 'Valuation', items: [
        { label: 'P/E (TTM)', val: 47.8, suffix: '×', peer: 32.1, signal: 'neg' },
        { label: 'P/S', val: 26.7, suffix: '×', peer: 8.4, signal: 'neg' },
        { label: 'P/B', val: 44.0, suffix: '×', peer: 6.8, signal: 'neg' },
        { label: 'EV/EBITDA', val: 41.2, suffix: '×', peer: 18.4, signal: 'neg' },
        { label: 'PEG', val: 0.42, peer: 1.85, signal: 'pos' },
      ]},
    ],
    scorecard: [
      { label: 'Profitability', score: 9.2, note: 'Best-in-class margins' },
      { label: 'Growth', score: 9.6, note: '114% revenue YoY' },
      { label: 'Balance Sheet', score: 8.8, note: 'Low leverage, ample cash' },
      { label: 'Cash Generation', score: 9.4, note: '$60B FCF, +125%' },
      { label: 'Valuation', score: 5.4, note: 'Premium to peers' },
    ],
  },

  AAPL: {
    ticker: 'AAPL', name: 'Apple Inc', exchange: 'NASDAQ', sector: 'Consumer Electronics', fyEnd: 'Sep',
    lastReported: { label: 'Q4 FY24', date: 'Nov 1, 2024' },
    years: ['FY20', 'FY21', 'FY22', 'FY23', 'FY24'],
    income: [
      { label: 'Revenue', key: 'revenue', values: [274515, 365817, 394328, 383285, 391035], bold: true },
      { label: 'Cost of Revenue', key: 'cogs', values: [169559, 212981, 223546, 214137, 210352] },
      { label: 'Gross Profit', key: 'gp', values: [104956, 152836, 170782, 169148, 180683], bold: true },
      { label: 'R&D', key: 'rd', values: [18752, 21914, 26251, 29915, 31370] },
      { label: 'SG&A', key: 'sga', values: [19916, 21973, 25094, 24932, 26097] },
      { label: 'Operating Income', key: 'opinc', values: [66288, 108949, 119437, 114301, 123216], bold: true },
      { label: 'Net Income', key: 'ni', values: [57411, 94680, 99803, 96995, 93736], bold: true, accent: true },
      { label: 'EPS (diluted)', key: 'eps', values: [3.28, 5.61, 6.11, 6.13, 6.08], format: 'currency' },
    ],
    balance: [
      { label: 'Cash & Equivalents', key: 'cash', values: [38016, 34940, 23646, 29965, 29943] },
      { label: 'Total Current Assets', key: 'tca', values: [143713, 134836, 135405, 143566, 152987], bold: true },
      { label: 'Total Assets', key: 'ta', values: [323888, 351002, 352755, 352583, 364980], bold: true, accent: true },
      { label: 'Total Current Liabilities', key: 'tcl', values: [105392, 125481, 153982, 145308, 176392] },
      { label: 'Long-Term Debt', key: 'ltd', values: [98667, 109106, 98959, 95281, 85750] },
      { label: 'Total Liabilities', key: 'tl', values: [258549, 287912, 302083, 290437, 308030], bold: true },
      { label: 'Total Equity', key: 'te', values: [65339, 63090, 50672, 62146, 56950], bold: true },
    ],
    cashflow: [
      { label: 'Operating Cash Flow', key: 'cfo', values: [80674, 104038, 122151, 110543, 118254], bold: true, accent: true },
      { label: 'Capex', key: 'capex', values: [-7309, -11085, -10708, -10959, -9447] },
      { label: 'Free Cash Flow', key: 'fcf', values: [73365, 92953, 111443, 99584, 108807], bold: true },
      { label: 'Investing Activities', key: 'cfi', values: [-4289, -14545, -22354, 3705, 2935] },
      { label: 'Dividends Paid', key: 'div', values: [-14081, -14467, -14841, -15025, -15234] },
      { label: 'Buybacks', key: 'buyback', values: [-72358, -85971, -89402, -77550, -94949] },
      { label: 'Financing Activities', key: 'cff', values: [-86820, -93353, -110749, -108488, -121983] },
      { label: 'Net Change in Cash', key: 'nccash', values: [-10435, -3860, -10952, 5760, -794] },
    ],
    ratios: [
      { group: 'Profitability', items: [
        { label: 'Gross Margin', val: 46.2, pct: true, peer: 38.0, signal: 'pos' },
        { label: 'Operating Margin', val: 31.5, pct: true, peer: 14.2, signal: 'pos' },
        { label: 'Net Margin', val: 24.0, pct: true, peer: 9.8, signal: 'pos' },
        { label: 'Return on Equity', val: 164.6, pct: true, peer: 22.0, signal: 'pos' },
        { label: 'Return on Assets', val: 25.7, pct: true, peer: 7.4, signal: 'pos' },
      ]},
      { group: 'Liquidity & Solvency', items: [
        { label: 'Current Ratio', val: 0.87, peer: 1.40, signal: 'neg' },
        { label: 'Quick Ratio', val: 0.83, peer: 1.10, signal: 'neg' },
        { label: 'Debt / Equity', val: 1.51, peer: 0.65, signal: 'neg' },
        { label: 'Interest Coverage', val: 41.2, suffix: '×', peer: 12.0, signal: 'pos' },
      ]},
      { group: 'Efficiency', items: [
        { label: 'Asset Turnover', val: 1.07, suffix: '×', peer: 0.80, signal: 'pos' },
        { label: 'Inventory Days', val: 10, suffix: 'd', peer: 45, signal: 'pos' },
        { label: 'Receivables Days', val: 58, suffix: 'd', peer: 52, signal: 'neutral' },
      ]},
      { group: 'Valuation', items: [
        { label: 'P/E (TTM)', val: 34.2, suffix: '×', peer: 24.0, signal: 'neg' },
        { label: 'P/S', val: 8.2, suffix: '×', peer: 3.1, signal: 'neg' },
        { label: 'P/B', val: 51.0, suffix: '×', peer: 7.5, signal: 'neg' },
        { label: 'EV/EBITDA', val: 25.5, suffix: '×', peer: 15.0, signal: 'neg' },
        { label: 'PEG', val: 3.10, peer: 1.90, signal: 'neg' },
      ]},
    ],
    scorecard: [
      { label: 'Profitability', score: 9.0, note: 'Elite margins, huge ROE' },
      { label: 'Growth', score: 5.5, note: 'Revenue ~2% YoY' },
      { label: 'Balance Sheet', score: 6.5, note: 'Negative working capital' },
      { label: 'Cash Generation', score: 9.5, note: '$109B FCF' },
      { label: 'Valuation', score: 5.8, note: 'Premium multiple' },
    ],
  },

  MSFT: {
    ticker: 'MSFT', name: 'Microsoft Corp', exchange: 'NASDAQ', sector: 'Software', fyEnd: 'Jun',
    lastReported: { label: 'Q4 FY24', date: 'Jul 30, 2024' },
    years: ['FY20', 'FY21', 'FY22', 'FY23', 'FY24'],
    income: [
      { label: 'Revenue', key: 'revenue', values: [143015, 168088, 198270, 211915, 245122], bold: true },
      { label: 'Cost of Revenue', key: 'cogs', values: [46078, 52232, 62650, 65863, 74114] },
      { label: 'Gross Profit', key: 'gp', values: [96937, 115856, 135620, 146052, 171008], bold: true },
      { label: 'R&D', key: 'rd', values: [19269, 20716, 24512, 27195, 29510] },
      { label: 'SG&A', key: 'sga', values: [24709, 25224, 27725, 30334, 32554] },
      { label: 'Operating Income', key: 'opinc', values: [52959, 69916, 83383, 88523, 109433], bold: true },
      { label: 'Net Income', key: 'ni', values: [44281, 61271, 72738, 72361, 88136], bold: true, accent: true },
      { label: 'EPS (diluted)', key: 'eps', values: [5.76, 8.05, 9.65, 9.68, 11.80], format: 'currency' },
    ],
    balance: [
      { label: 'Cash & Equivalents', key: 'cash', values: [13576, 14224, 13931, 34704, 18315] },
      { label: 'Total Current Assets', key: 'tca', values: [181915, 184406, 169684, 184257, 159734], bold: true },
      { label: 'Total Assets', key: 'ta', values: [301311, 333779, 364840, 411976, 512163], bold: true, accent: true },
      { label: 'Total Current Liabilities', key: 'tcl', values: [72310, 88657, 95082, 104149, 125286] },
      { label: 'Long-Term Debt', key: 'ltd', values: [59578, 50074, 47032, 41990, 42688] },
      { label: 'Total Liabilities', key: 'tl', values: [183007, 191791, 198298, 205753, 243686], bold: true },
      { label: 'Total Equity', key: 'te', values: [118304, 141988, 166542, 206223, 268477], bold: true },
    ],
    cashflow: [
      { label: 'Operating Cash Flow', key: 'cfo', values: [60675, 76740, 89035, 87582, 118548], bold: true, accent: true },
      { label: 'Capex', key: 'capex', values: [-15441, -20622, -23886, -28107, -44477] },
      { label: 'Free Cash Flow', key: 'fcf', values: [45234, 56118, 65149, 59475, 74071], bold: true },
      { label: 'Investing Activities', key: 'cfi', values: [-12223, -27577, -30311, -22680, -96970] },
      { label: 'Dividends Paid', key: 'div', values: [-15137, -16521, -18135, -19800, -21771] },
      { label: 'Buybacks', key: 'buyback', values: [-22968, -27385, -32696, -22245, -17254] },
      { label: 'Financing Activities', key: 'cff', values: [-46031, -48486, -58876, -43935, -36737] },
      { label: 'Net Change in Cash', key: 'nccash', values: [2080, 661, -818, 21243, -16389] },
    ],
    ratios: [
      { group: 'Profitability', items: [
        { label: 'Gross Margin', val: 69.8, pct: true, peer: 58.0, signal: 'pos' },
        { label: 'Operating Margin', val: 44.6, pct: true, peer: 22.0, signal: 'pos' },
        { label: 'Net Margin', val: 36.0, pct: true, peer: 15.5, signal: 'pos' },
        { label: 'Return on Equity', val: 32.8, pct: true, peer: 19.0, signal: 'pos' },
        { label: 'Return on Assets', val: 17.2, pct: true, peer: 7.8, signal: 'pos' },
      ]},
      { group: 'Liquidity & Solvency', items: [
        { label: 'Current Ratio', val: 1.27, peer: 1.40, signal: 'neutral' },
        { label: 'Quick Ratio', val: 1.22, peer: 1.10, signal: 'pos' },
        { label: 'Debt / Equity', val: 0.16, peer: 0.55, signal: 'pos' },
        { label: 'Interest Coverage', val: 40.5, suffix: '×', peer: 13.0, signal: 'pos' },
      ]},
      { group: 'Efficiency', items: [
        { label: 'Asset Turnover', val: 0.48, suffix: '×', peer: 0.70, signal: 'neg' },
        { label: 'Inventory Days', val: 18, suffix: 'd', peer: 40, signal: 'pos' },
        { label: 'Receivables Days', val: 75, suffix: 'd', peer: 55, signal: 'neg' },
      ]},
      { group: 'Valuation', items: [
        { label: 'P/E (TTM)', val: 36.5, suffix: '×', peer: 26.0, signal: 'neg' },
        { label: 'P/S', val: 13.1, suffix: '×', peer: 5.0, signal: 'neg' },
        { label: 'P/B', val: 11.9, suffix: '×', peer: 6.5, signal: 'neg' },
        { label: 'EV/EBITDA', val: 25.8, suffix: '×', peer: 16.0, signal: 'neg' },
        { label: 'PEG', val: 2.30, peer: 1.90, signal: 'neg' },
      ]},
    ],
    scorecard: [
      { label: 'Profitability', score: 9.3, note: 'Software-grade margins' },
      { label: 'Growth', score: 8.5, note: '16% revenue YoY' },
      { label: 'Balance Sheet', score: 9.0, note: 'Fortress balance sheet' },
      { label: 'Cash Generation', score: 8.8, note: '$74B FCF, +25%' },
      { label: 'Valuation', score: 5.6, note: 'Rich but justified' },
    ],
  },
};

const FS_DATA = COMPANIES.NVDA;
const RATIOS = COMPANIES.NVDA.ratios;

// Derive 4 quarters from the latest fiscal year for the Quarterly view.
// Flow items (income/cash flow) are split across quarters; balance-sheet
// items (point-in-time) ramp from prior year-end to latest year-end.
const toQuarterly = (company) => {
  const li = company.years.length - 1;
  const split = [0.22, 0.24, 0.26, 0.28]; // seasonal weights, sum = 1
  const make = (rows, isBalance) => rows.map(r => {
    const last = r.values[li];
    const prev = r.values[li - 1] ?? last;
    let vals;
    if (isBalance) {
      vals = [0, 1, 2, 3].map(q => Math.round(prev + (last - prev) * ((q + 1) / 4)));
    } else if (r.format === 'currency') {
      vals = split.map(s => +(last * s).toFixed(2));
    } else {
      vals = split.map(s => Math.round(last * s));
    }
    return { ...r, values: vals };
  });
  return {
    ...company,
    years: ['Q1', 'Q2', 'Q3', 'Q4'],
    income: make(company.income, false),
    balance: make(company.balance, true),
    cashflow: make(company.cashflow, false),
  };
};

const fmtCompact = (n) => {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  // Respect Settings → Number formatting ('full' = 1,234M)
  let full = false;
  try { full = JSON.parse(localStorage.getItem('helix_settings_v1') || '{}').numberFormat === 'full'; } catch {}
  if (full) {
    const s = n < 0 ? '(' : '';
    const c = n < 0 ? ')' : '';
    return `${s}${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}M${c}`;
  }
  const sign = n < 0 ? '(' : '';
  const close = n < 0 ? ')' : '';
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(2)}B${close}`;
  return `${sign}${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}M${close}`;
};

const yoy = (curr, prev) => {
  if (!prev || prev === 0) return null;
  return ((curr - prev) / Math.abs(prev)) * 100;
};

const StatementTable = ({ rows, years }) => {
  return (
    <table className="table">
      <thead>
        <tr>
          <th style={{ width: '30%' }}>Line item</th>
          {years.map(y => <th key={y} className="right">{y}</th>)}
          <th className="right" style={{ width: 90 }}>5Y CAGR</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const last = r.values[r.values.length - 1];
          const first = r.values[0];
          let cagr = null;
          if (first > 0 && last > 0) {
            cagr = (Math.pow(last / first, 1 / (r.values.length - 1)) - 1) * 100;
          }
          return (
            <tr key={i} style={{ cursor: 'default' }}>
              <td style={{
                fontWeight: r.bold ? 600 : 400,
                color: r.accent ? 'var(--accent)' : (r.bold ? 'var(--text)' : 'var(--text-muted)'),
                paddingLeft: r.bold ? 12 : 24,
              }}>
                {r.label}
              </td>
              {r.values.map((v, j) => {
                const yoyChange = j > 0 ? yoy(v, r.values[j - 1]) : null;
                return (
                  <td key={j} className="right num" style={{ fontWeight: r.bold ? 600 : 400 }}>
                    <div>{r.format === 'currency' ? '$' + v.toFixed(2) : fmtCompact(v)}</div>
                    {yoyChange !== null && (
                      <div style={{ fontSize: 10, color: yoyChange >= 0 ? 'var(--pos)' : 'var(--neg)', fontWeight: 500 }}>
                        {yoyChange >= 0 ? '+' : ''}{yoyChange.toFixed(0)}%
                      </div>
                    )}
                  </td>
                );
              })}
              <td className="right num" style={{ fontWeight: 600 }}>
                {cagr !== null ? (
                  <span className={cagr >= 0 ? 'pos' : 'neg'}>{cagr >= 0 ? '+' : ''}{cagr.toFixed(1)}%</span>
                ) : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

const TrendBars = ({ data, label, color = 'var(--accent)', format = 'compact', years = FS_DATA.years }) => {
  const max = Math.max(...data.map(Math.abs));
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 80 }}>
        {data.map((v, i) => {
          const h = (Math.abs(v) / max) * 70;
          return (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div className="num" style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>
                {format === 'compact' ? (v >= 1000 ? (v/1000).toFixed(1)+'B' : v.toFixed(0)+'M') : v.toFixed(1)+'%'}
              </div>
              <div style={{
                width: '100%', height: h, background: v >= 0 ? color : 'var(--neg)',
                borderRadius: '2px 2px 0 0', minHeight: 2,
              }} />
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
        {years.map(y => (
          <div key={y} style={{ flex: 1, textAlign: 'center', fontSize: 10, color: 'var(--text-subtle)', fontFamily: 'var(--font-mono)' }}>{y}</div>
        ))}
      </div>
    </div>
  );
};

const RatioCard = ({ item }) => {
  const beats = item.signal === 'pos';
  const lags = item.signal === 'neg';
  return (
    <div style={{
      padding: '10px 12px',
      borderBottom: '1px solid var(--border)',
      display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, alignItems: 'center',
    }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{item.label}</span>
      <span className="num" style={{ fontSize: 13, fontWeight: 600 }}>
        {item.val}{item.pct ? '%' : (item.suffix || '')}
      </span>
      <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', fontWeight: 600,
        color: beats ? 'var(--pos)' : lags ? 'var(--neg)' : 'var(--text-subtle)',
        padding: '2px 6px',
        background: beats ? 'var(--pos-bg)' : lags ? 'var(--neg-bg)' : 'var(--bg-sunken)',
        borderRadius: 3, minWidth: 60, textAlign: 'right',
      }}>
        {beats ? 'BEATS' : lags ? 'LAGS' : 'INLINE'} {item.peer}{item.pct ? '%' : (item.suffix || '')}
      </span>
    </div>
  );
};

// Deterministic synthetic dataset for any ticker without a hand-built one,
// so every watchlist stock is selectable in the statements view.
const synthCompany = (ticker, name, w) => {
  let seed = 0; for (const c of ticker) seed += c.charCodeAt(0);
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const years = ['FY21', 'FY22', 'FY23', 'FY24', 'FY25'];
  // Base revenue loosely from market cap if available
  const capNum = w && typeof w.mcap === 'string'
    ? parseFloat(w.mcap) * (w.mcap.includes('T') ? 1000 : 1)
    : 200 + rnd() * 800;
  let rev0 = Math.max(2000, capNum * (0.15 + rnd() * 0.25) * 1000);
  const growth = 0.05 + rnd() * 0.22;
  const series = (mult, drift = growth) => years.map((_, i) => Math.round(rev0 * mult * Math.pow(1 + drift, i)));
  const revenue = series(1);
  const gm = 0.35 + rnd() * 0.4, om = gm * (0.45 + rnd() * 0.3), nm = om * (0.6 + rnd() * 0.25);
  const gp = revenue.map(r => Math.round(r * gm));
  const opinc = revenue.map(r => Math.round(r * om));
  const ni = revenue.map(r => Math.round(r * nm));
  const eps = ni.map(v => +(v / (1500 + rnd() * 2000)).toFixed(2));
  const ta = revenue.map(r => Math.round(r * (1.2 + rnd() * 0.8)));
  const te = ta.map(v => Math.round(v * (0.35 + rnd() * 0.3)));
  const cfo = ni.map(v => Math.round(v * (1.05 + rnd() * 0.25)));
  const capex = revenue.map(r => -Math.round(r * (0.03 + rnd() * 0.05)));
  const fcf = cfo.map((v, i) => v + capex[i]);
  const mkRow = (label, key, values, extra = {}) => ({ label, key, values, ...extra });
  const pe = +(12 + rnd() * 40).toFixed(1);
  return {
    ticker, name: name || ticker, exchange: 'NASDAQ', sector: 'Equity', fyEnd: 'Dec',
    lastReported: { label: 'FY25', date: '2026' }, years, synthetic: true,
    income: [
      mkRow('Revenue', 'revenue', revenue, { bold: true }),
      mkRow('Gross Profit', 'gp', gp, { bold: true }),
      mkRow('Operating Income', 'opinc', opinc, { bold: true }),
      mkRow('Net Income', 'ni', ni, { bold: true, accent: true }),
      mkRow('EPS (diluted)', 'eps', eps, { format: 'currency' }),
    ],
    balance: [
      mkRow('Total Current Assets', 'tca', ta.map(v => Math.round(v * 0.5)), { bold: true }),
      mkRow('Total Assets', 'ta', ta, { bold: true, accent: true }),
      mkRow('Long-Term Debt', 'ltd', te.map(v => Math.round(v * (0.1 + rnd() * 0.4)))),
      mkRow('Total Equity', 'te', te, { bold: true }),
    ],
    cashflow: [
      mkRow('Operating Cash Flow', 'cfo', cfo, { bold: true, accent: true }),
      mkRow('Capex', 'capex', capex),
      mkRow('Free Cash Flow', 'fcf', fcf, { bold: true }),
    ],
    ratios: [
      { group: 'Profitability', items: [
        { label: 'Gross Margin', val: +(gm * 100).toFixed(1), pct: true, peer: 45, signal: gm > 0.45 ? 'pos' : 'neg' },
        { label: 'Operating Margin', val: +(om * 100).toFixed(1), pct: true, peer: 20, signal: om > 0.2 ? 'pos' : 'neg' },
        { label: 'Net Margin', val: +(nm * 100).toFixed(1), pct: true, peer: 14, signal: nm > 0.14 ? 'pos' : 'neg' },
      ]},
      { group: 'Valuation', items: [
        { label: 'P/E (TTM)', val: pe, suffix: '×', peer: 24, signal: pe < 24 ? 'pos' : 'neg' },
      ]},
    ],
    scorecard: [
      { label: 'Profitability', score: +(5 + nm * 20).toFixed(1), note: 'Synthetic estimate' },
      { label: 'Growth', score: +(4 + growth * 25).toFixed(1), note: `${(growth * 100).toFixed(0)}% rev CAGR` },
      { label: 'Valuation', score: +(Math.max(2, 10 - pe / 6)).toFixed(1), note: `P/E ${pe}×` },
    ],
  };
};

const PageStatements = ({ data }) => {
  const [tab, setTab] = React.useState('summary');
  const [view, setView] = React.useState('annual'); // annual | quarterly
  const [ticker, setTicker] = React.useState(() => {
    const hint = window.__statementsTicker;
    window.__statementsTicker = null;
    return hint || 'NVDA';
  });

  // Full company list: real datasets (COMPANIES) + every watchlist ticker.
  // Watchlist names without a hand-built dataset get a deterministic synthetic one.
  const companyList = React.useMemo(() => {
    const list = Object.values(COMPANIES).map(c => ({ ticker: c.ticker, name: c.name }));
    const seen = new Set(list.map(c => c.ticker));
    (data?.watchlist || []).forEach(w => {
      if (!seen.has(w.sym)) { list.push({ ticker: w.sym, name: w.name }); seen.add(w.sym); }
    });
    return list;
  }, [data]);

  const fs = React.useMemo(() => {
    if (COMPANIES[ticker]) return COMPANIES[ticker];
    const w = (data?.watchlist || []).find(x => x.sym === ticker);
    return synthCompany(ticker, w ? w.name : ticker, w);
  }, [ticker, data]);
  const ratios = fs.ratios;
  const lastIdx = fs.years.length - 1;
  const activeFs = React.useMemo(() => view === 'quarterly' ? toQuarterly(fs) : fs, [view, fs]);
  const yoyOf = (key, statement = 'income') => {
    const row = fs[statement].find(r => r.key === key);
    if (!row) return null;
    const last = row.values[lastIdx], prev = row.values[lastIdx - 1];
    if (!prev) return null;
    return ((last - prev) / Math.abs(prev)) * 100;
  };
  const valOf = (key, statement = 'income') => {
    const row = fs[statement].find(r => r.key === key);
    return row ? row.values[lastIdx] : null;
  };
  const pctStr = (n) => n === null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(0)}%`;

  const exportStatementsCSV = () => {
    const rows = [['Statement', 'Line item', ...fs.years].join(',')];
    const groups = [['Income Statement', fs.income], ['Balance Sheet', fs.balance], ['Cash Flow', fs.cashflow]];
    for (const [name, list] of groups) {
      for (const r of list) {
        rows.push([name, `"${r.label}"`, ...r.values].join(','));
      }
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${ticker}_financials.csv`; a.click();
    URL.revokeObjectURL(url);
    window.toast && window.toast(`Exported ${ticker} financials`, { type: 'success' });
  };

  const tabs = [
    { id: 'summary', label: 'Summary', rows: null },
    { id: 'income', label: 'Income Statement', rows: activeFs.income },
    { id: 'balance', label: 'Balance Sheet', rows: activeFs.balance },
    { id: 'cashflow', label: 'Cash Flow', rows: activeFs.cashflow },
    { id: 'ratios', label: 'Ratios & Health', rows: null },
    { id: 'filings', label: 'Filings (PDF)', rows: null },
  ];
  const activeTab = tabs.find(t => t.id === tab);

  // Margin trend data
  const revenue = activeFs.income.find(r => r.key === 'revenue').values;
  const grossProfit = activeFs.income.find(r => r.key === 'gp').values;
  const opIncome = activeFs.income.find(r => r.key === 'opinc').values;
  const netIncome = activeFs.income.find(r => r.key === 'ni').values;
  const grossMargins = revenue.map((r, i) => (grossProfit[i] / r) * 100);
  const opMargins = revenue.map((r, i) => (opIncome[i] / r) * 100);
  const netMargins = revenue.map((r, i) => (netIncome[i] / r) * 100);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Financial statements.</h1>
          <p className="page-sub">Income, balance, cash flow & ratios — multi-year, peer-benchmarked</p>
        </div>
        <div className="row">
          <select className="search" value={ticker} onChange={e => setTicker(e.target.value)} style={{ width: 180, cursor: 'pointer' }}>
            {companyList.map(c => (
              <option key={c.ticker} value={c.ticker}>{c.ticker} · {c.name}</option>
            ))}
          </select>
          <div className="range-chips">
            <button className="range-chip" aria-selected={view === 'annual'} onClick={() => setView('annual')}>Annual</button>
            <button className="range-chip" aria-selected={view === 'quarterly'} onClick={() => setView('quarterly')}>Quarterly</button>
          </div>
          <button className="btn" onClick={exportStatementsCSV}><Icon name="download" size={12} /> Export CSV</button>
          <button className="btn btn-primary" onClick={() => setTab('filings')}>Filings →</button>
        </div>
      </div>

      {/* Company strip */}
      <div className="card" style={{ marginBottom: 20, padding: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr', gap: 24, alignItems: 'center' }}>
          <div className="row" style={{ gap: 14 }}>
            <div style={{
              width: 48, height: 48, borderRadius: 8,
              background: 'linear-gradient(135deg, var(--accent), #7C2D12)',
              color: 'white', display: 'grid', placeItems: 'center',
              fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 15,
            }}>{ticker.slice(0, 2)}</div>
            <div>
              <div className="serif" style={{ fontSize: 18, fontWeight: 600 }}>{fs.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fs.exchange}: {ticker} · {fs.sector} · Fiscal year ends {fs.fyEnd}</div>
            </div>
          </div>
          <FSStat label="Latest revenue" value={fmtCompact(valOf('revenue'))} delta={pctStr(yoyOf('revenue'))} pos={yoyOf('revenue') >= 0} />
          <FSStat label="Net income" value={fmtCompact(valOf('ni'))} delta={pctStr(yoyOf('ni'))} pos={yoyOf('ni') >= 0} />
          <FSStat label="Free cash flow" value={fmtCompact(valOf('fcf', 'cashflow'))} delta={pctStr(yoyOf('fcf', 'cashflow'))} pos={yoyOf('fcf', 'cashflow') >= 0} />
          <FSStat label="Last reported" value={fs.lastReported.label} delta={fs.lastReported.date} />
        </div>
      </div>

      {/* Margin trend strip */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <h3 className="card-title">Margin Profile · 5 Year</h3>
          <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Higher is better</span>
        </div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24 }}>
          <TrendBars data={revenue} label="Revenue" years={activeFs.years} />
          <TrendBars data={grossMargins} label="Gross margin" format="pct" color="var(--pos)" years={activeFs.years} />
          <TrendBars data={opMargins} label="Operating margin" format="pct" color="var(--pos)" years={activeFs.years} />
          <TrendBars data={netMargins} label="Net margin" format="pct" color="var(--pos)" years={activeFs.years} />
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {tabs.map(t => (
          <button key={t.id} className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {/* Statement table or ratios grid */}
      {tab === 'summary' && <SummaryView fs={activeFs} years={activeFs.years} />}

      {tab !== 'ratios' && tab !== 'filings' && tab !== 'summary' && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">{activeTab.label}</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>USD millions · {view === 'annual' ? 'Fiscal years' : 'Latest FY quarters'}</span>
          </div>
          <div className="card-body flush">
            <StatementTable rows={activeTab.rows} years={activeFs.years} />
          </div>
        </div>
      )}

      {tab === 'filings' && <PageFilings />}

      {tab === 'ratios' && (
        <>
          <div className="grid-2" style={{ marginBottom: 20 }}>
            {ratios.slice(0, 2).map(g => (
              <div className="card" key={g.group}>
                <div className="card-header">
                  <h3 className="card-title">{g.group}</h3>
                  <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>vs. sector peer median</span>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                  {g.items.map((it, i) => <RatioCard key={i} item={it} />)}
                </div>
              </div>
            ))}
          </div>
          <div className="grid-2">
            {ratios.slice(2).map(g => (
              <div className="card" key={g.group}>
                <div className="card-header">
                  <h3 className="card-title">{g.group}</h3>
                  <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>vs. sector peer median</span>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                  {g.items.map((it, i) => <RatioCard key={i} item={it} />)}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Health summary */}
      <div className="card" style={{ marginTop: 20 }}>
        <div className="card-header">
          <h3 className="card-title">Health Scorecard</h3>
          <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Composite assessment</span>
        </div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16 }}>
          {fs.scorecard.map((s, i) => (
            <ScoreTile key={i} label={s.label} score={s.score} note={s.note} />
          ))}
        </div>
      </div>
    </div>
  );
};

// Consolidated totals across every statement we collect
const SummaryView = ({ years, fs = FS_DATA }) => {
  const lastIdx = years.length - 1;
  const cagr = (vals) => {
    const first = vals[0], last = vals[lastIdx];
    if (!(first > 0) || !(last > 0)) return null;
    return (Math.pow(last / first, 1 / lastIdx) - 1) * 100;
  };
  const yoy = (vals) => {
    const prev = vals[lastIdx - 1], last = vals[lastIdx];
    if (!prev) return null;
    return ((last - prev) / Math.abs(prev)) * 100;
  };

  const groups = [
    { name: 'Income Statement', color: 'var(--accent)', rows: fs.income },
    { name: 'Balance Sheet', color: '#1D4ED8', rows: fs.balance },
    { name: 'Cash Flow', color: '#15803D', rows: fs.cashflow },
  ];

  // Headline totals row
  const rev = fs.income.find(r => r.key === 'revenue').values;
  const ni = fs.income.find(r => r.key === 'ni').values;
  const cfo = fs.cashflow.find(r => r.key === 'cfo').values;
  const fcf = fs.cashflow.find(r => r.key === 'fcf').values;
  const ta = fs.balance.find(r => r.key === 'ta').values;
  const te = fs.balance.find(r => r.key === 'te').values;

  const headline = [
    { label: 'Total Revenue', vals: rev },
    { label: 'Net Income', vals: ni },
    { label: 'Operating Cash Flow', vals: cfo },
    { label: 'Free Cash Flow', vals: fcf },
    { label: 'Total Assets', vals: ta },
    { label: 'Total Equity', vals: te },
  ];

  // Count of everything collected
  const totalMetrics = groups.reduce((s, g) => s + g.rows.length, 0);

  return (
    <>
      {/* Headline totals */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <h3 className="card-title">Everything We Collect · {years[lastIdx]}</h3>
          <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{totalMetrics} line items across 3 statements · {years.length} fiscal years</span>
        </div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 1, background: 'var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          {headline.map((h, i) => {
            const y = yoy(h.vals);
            return (
              <div key={i} style={{ background: 'var(--bg-elev)', padding: 14 }}>
                <div style={{ fontSize: 10, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{h.label}</div>
                <div className="num" style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{fmtCompact(h.vals[lastIdx])}</div>
                {y !== null && (
                  <div className="num" style={{ fontSize: 11, fontWeight: 600, color: y >= 0 ? 'var(--pos)' : 'var(--neg)', marginTop: 2 }}>
                    {y >= 0 ? '+' : ''}{y.toFixed(0)}% YoY
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Consolidated table — every collected line item */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">Consolidated Totals</h3>
          <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>USD millions · all collected metrics</span>
        </div>
        <div className="card-body flush">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: '34%' }}>Line item</th>
                <th className="right">{years[lastIdx - 1]}</th>
                <th className="right">{years[lastIdx]}</th>
                <th className="right">YoY</th>
                <th className="right">5Y CAGR</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <React.Fragment key={g.name}>
                  <tr style={{ cursor: 'default' }}>
                    <td colSpan={5} style={{ background: 'var(--bg-sunken)', padding: '8px 12px' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: g.color }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: g.color }}></span>
                        {g.name}
                      </span>
                    </td>
                  </tr>
                  {g.rows.map((r, i) => {
                    const c = cagr(r.values);
                    const y = yoy(r.values);
                    return (
                      <tr key={i} style={{ cursor: 'default' }}>
                        <td style={{
                          fontWeight: r.bold ? 600 : 400,
                          color: r.accent ? 'var(--accent)' : (r.bold ? 'var(--text)' : 'var(--text-muted)'),
                          paddingLeft: r.bold ? 12 : 24,
                        }}>{r.label}</td>
                        <td className="right num" style={{ color: 'var(--text-muted)' }}>
                          {r.format === 'currency' ? '$' + r.values[lastIdx - 1].toFixed(2) : fmtCompact(r.values[lastIdx - 1])}
                        </td>
                        <td className="right num" style={{ fontWeight: r.bold ? 600 : 400 }}>
                          {r.format === 'currency' ? '$' + r.values[lastIdx].toFixed(2) : fmtCompact(r.values[lastIdx])}
                        </td>
                        <td className="right num" style={{ fontWeight: 600, color: y === null ? 'var(--text-subtle)' : y >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
                          {y !== null ? `${y >= 0 ? '+' : ''}${y.toFixed(0)}%` : '—'}
                        </td>
                        <td className="right num" style={{ fontWeight: 600 }}>
                          {c !== null ? <span className={c >= 0 ? 'pos' : 'neg'}>{c >= 0 ? '+' : ''}{c.toFixed(1)}%</span> : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
};

const FSStat = ({ label, value, delta, pos }) => (
  <div>
    <div style={{ fontSize: 10, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{label}</div>
    <div className="num" style={{ fontSize: 18, fontWeight: 600, marginTop: 2 }}>{value}</div>
    {delta && <div className="num" style={{ fontSize: 11, color: pos ? 'var(--pos)' : 'var(--text-muted)', fontWeight: 500 }}>{delta}</div>}
  </div>
);

const ScoreTile = ({ label, score, note }) => {
  const color = score >= 8 ? 'var(--pos)' : score >= 6 ? 'var(--accent)' : score >= 4 ? 'var(--warn)' : 'var(--neg)';
  return (
    <div style={{ padding: 14, background: 'var(--bg-sunken)', borderRadius: 6 }}>
      <div style={{ fontSize: 11, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{label}</div>
      <div className="serif" style={{ fontSize: 32, fontWeight: 600, color, marginTop: 4 }}>
        {score.toFixed(1)}<span style={{ fontSize: 14, color: 'var(--text-subtle)', fontWeight: 400 }}>/10</span>
      </div>
      <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, marginTop: 6 }}>
        <div style={{ height: '100%', width: `${score * 10}%`, background: color, borderRadius: 2 }} />
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>{note}</div>
    </div>
  );
};

window.PageStatements = PageStatements;
window.FS_DATA = FS_DATA;
window.COMPANIES = COMPANIES;
window.fmtCompact = fmtCompact;
