// Financial Statements analysis page

const FS_DATA = {
  ticker: 'NVDA',
  name: 'NVIDIA Corp',
  // 5 fiscal years (FY21 → FY25), values in $M
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
};

const RATIOS = [
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
];

const fmtCompact = (n) => {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
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

const TrendBars = ({ data, label, color = 'var(--accent)', format = 'compact' }) => {
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
        {FS_DATA.years.map(y => (
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

const PageStatements = () => {
  const [tab, setTab] = React.useState('summary');
  const [view, setView] = React.useState('annual'); // annual | quarterly
  const [ticker, setTicker] = React.useState('NVDA');

  const tabs = [
    { id: 'summary', label: 'Summary', rows: null },
    { id: 'income', label: 'Income Statement', rows: FS_DATA.income },
    { id: 'balance', label: 'Balance Sheet', rows: FS_DATA.balance },
    { id: 'cashflow', label: 'Cash Flow', rows: FS_DATA.cashflow },
    { id: 'ratios', label: 'Ratios & Health', rows: null },
    { id: 'filings', label: 'Filings (PDF)', rows: null },
  ];
  const activeTab = tabs.find(t => t.id === tab);

  // Margin trend data
  const revenue = FS_DATA.income.find(r => r.key === 'revenue').values;
  const grossProfit = FS_DATA.income.find(r => r.key === 'gp').values;
  const opIncome = FS_DATA.income.find(r => r.key === 'opinc').values;
  const netIncome = FS_DATA.income.find(r => r.key === 'ni').values;
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
          <div style={{ position: 'relative' }}>
            <input className="search" value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} style={{ width: 130 }} />
          </div>
          <div className="range-chips">
            <button className="range-chip" aria-selected={view === 'annual'} onClick={() => setView('annual')}>Annual</button>
            <button className="range-chip" aria-selected={view === 'quarterly'} onClick={() => setView('quarterly')}>Quarterly</button>
          </div>
          <button className="btn"><Icon name="download" size={12} /> Export CSV</button>
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
              <div className="serif" style={{ fontSize: 18, fontWeight: 600 }}>{FS_DATA.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>NASDAQ: {ticker} · Semiconductors · Fiscal year ends Jan</div>
            </div>
          </div>
          <FSStat label="Latest revenue" value={fmtCompact(130497)} delta="+114%" pos />
          <FSStat label="Net income" value={fmtCompact(72880)} delta="+145%" pos />
          <FSStat label="Free cash flow" value={fmtCompact(60853)} delta="+125%" pos />
          <FSStat label="Last reported" value="Q4 FY25" delta="Feb 26, 2026" />
        </div>
      </div>

      {/* Margin trend strip */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-header">
          <h3 className="card-title">Margin Profile · 5 Year</h3>
          <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Higher is better</span>
        </div>
        <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 24 }}>
          <TrendBars data={revenue} label="Revenue" />
          <TrendBars data={grossMargins} label="Gross margin" format="pct" color="var(--pos)" />
          <TrendBars data={opMargins} label="Operating margin" format="pct" color="var(--pos)" />
          <TrendBars data={netMargins} label="Net margin" format="pct" color="var(--pos)" />
        </div>
      </div>

      {/* Tabs */}
      <div className="tabs">
        {tabs.map(t => (
          <button key={t.id} className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {/* Statement table or ratios grid */}
      {tab === 'summary' && <SummaryView years={FS_DATA.years} />}

      {tab !== 'ratios' && tab !== 'filings' && tab !== 'summary' && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">{activeTab.label}</h3>
            <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>USD millions · {view === 'annual' ? 'Fiscal years' : 'Quarterly'}</span>
          </div>
          <div className="card-body flush">
            <StatementTable rows={activeTab.rows} years={FS_DATA.years} />
          </div>
        </div>
      )}

      {tab === 'filings' && <PageFilings />}

      {tab === 'ratios' && (
        <>
          <div className="grid-2" style={{ marginBottom: 20 }}>
            {RATIOS.slice(0, 2).map(g => (
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
            {RATIOS.slice(2).map(g => (
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
          <ScoreTile label="Profitability" score={9.2} note="Best-in-class margins" />
          <ScoreTile label="Growth" score={9.6} note="114% revenue YoY" />
          <ScoreTile label="Balance Sheet" score={8.8} note="Low leverage, ample cash" />
          <ScoreTile label="Cash Generation" score={9.4} note="$60B FCF, +125%" />
          <ScoreTile label="Valuation" score={5.4} note="Premium to peers" />
        </div>
      </div>
    </div>
  );
};

// Consolidated totals across every statement we collect
const SummaryView = ({ years }) => {
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
    { name: 'Income Statement', color: 'var(--accent)', rows: FS_DATA.income },
    { name: 'Balance Sheet', color: '#1D4ED8', rows: FS_DATA.balance },
    { name: 'Cash Flow', color: '#15803D', rows: FS_DATA.cashflow },
  ];

  // Headline totals row
  const rev = FS_DATA.income.find(r => r.key === 'revenue').values;
  const ni = FS_DATA.income.find(r => r.key === 'ni').values;
  const cfo = FS_DATA.cashflow.find(r => r.key === 'cfo').values;
  const fcf = FS_DATA.cashflow.find(r => r.key === 'fcf').values;
  const ta = FS_DATA.balance.find(r => r.key === 'ta').values;
  const te = FS_DATA.balance.find(r => r.key === 'te').values;

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
window.fmtCompact = fmtCompact;
