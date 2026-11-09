// Trustworthy portfolio overview + audited transaction ledger.

const PORTFOLIO_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'VND'];
const TX_TYPES = ['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX'];

const pfMoney = (value, currency = 'USD', digits = 2) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n); }
  catch { return `${currency} ${n.toLocaleString(undefined, { maximumFractionDigits: digits })}`; }
};

const pfLocalDateTime = (value = new Date()) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

const demoPortfolio = (data) => {
  const p = data.portfolio;
  return {
    id: null, name: 'Demo portfolio', display_currency: p.displayCurrency || 'USD',
    total_value: p.totalValue || 0, cash_value: p.cash || 0,
    today_change: p.dayChange || 0, today_change_pct: p.dayChangePct || 0,
    total_gain: p.totalGain || 0, total_gain_pct: p.totalGainPct || 0,
    holdings: (p.holdings || []).map(h => ({
      ticker: h.sym, currency: 'USD', shares: h.shares, avg_cost: h.avgCost,
      price: h.price, value: h.value, value_native: h.value,
      gain: h.gain, gain_pct: h.gainPct, weight: h.weight,
    })),
    cash: [{ currency: 'USD', balance: p.cash || 0, converted: p.cash || 0 }],
    complete: true, missing: [], stale: [], projection_status: 'demo', demo: true,
  };
};

const PortfolioStatus = ({ portfolio, live }) => {
  if (!live) return <span className="pill" style={{ color: 'var(--text-muted)' }}>Demo · backend offline</span>;
  if (portfolio.projection_status !== 'ready') return <span className="pill" style={{ color: 'var(--accent)' }}>{portfolio.projection_status}</span>;
  if (!portfolio.complete) return <span className="pill neg">Incomplete valuation</span>;
  if (portfolio.stale?.length) return <span className="pill" style={{ color: 'var(--warn, #a16207)' }}>Stale data</span>;
  return <span className="pill pos">Verified live</span>;
};

const PortfolioMetric = ({ label, value, delta }) => <div className="stat"><div className="stat-label">{label}</div><div className="stat-value" style={{ fontSize: 24 }}>{value}</div>{delta !== undefined && <div className="stat-delta"><ChangeText value={delta} /></div>}</div>;

const PagePortfolio = ({ data, setActiveAsset, setPage }) => {
  const [portfolio, setPortfolio] = React.useState(null);
  const [live, setLive] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [tab, setTab] = React.useState('overview');
  const [range, setRange] = React.useState('1y');
  const [chartMode, setChartMode] = React.useState('value');
  const [performance, setPerformance] = React.useState([]);
  const [transactions, setTransactions] = React.useState({ items: [], total: 0, page: 1, page_size: 50 });
  const [txFilter, setTxFilter] = React.useState('');
  const [txQuery, setTxQuery] = React.useState('');
  const [showTx, setShowTx] = React.useState(false);
  const [editTx, setEditTx] = React.useState(null);
  const [showImport, setShowImport] = React.useState(false);
  const [historyTicker, setHistoryTicker] = React.useState(null);
  const [busy, setBusy] = React.useState('');

  const loadPortfolio = React.useCallback(async () => {
    setError('');
    if (!window.HelixAPI) { delete window.__livePortfolioContext; setPortfolio(demoPortfolio(data)); setLive(false); setLoading(false); return; }
    if (!window.HelixAPI.checked) await window.HelixAPI.detect();
    if (!window.HelixAPI.live) { delete window.__livePortfolioContext; setPortfolio(demoPortfolio(data)); setLive(false); setLoading(false); return; }
    try {
      const pf = await window.HelixAPI.portfolio();
      window.__livePortfolioContext = pf;
      setPortfolio(pf); setLive(true);
    } catch (e) { setError(e.message || String(e)); }
    setLoading(false);
  }, [data]);

  const loadPerformance = React.useCallback(async () => {
    if (!window.HelixAPI?.live) { setPerformance([]); return; }
    try { setPerformance((await window.HelixAPI.portfolioPerformance(range)).items || []); }
    catch { setPerformance([]); }
  }, [range]);

  const loadTransactions = React.useCallback(async (page = 1) => {
    if (!window.HelixAPI?.live) { setTransactions({ items: [], total: 0, page: 1, page_size: 50 }); return; }
    try { setTransactions(await window.HelixAPI.portfolioTransactions({ page, page_size: 50, ...(txFilter ? { type: txFilter } : {}), ...(txQuery ? { q: txQuery } : {}) })); }
    catch (e) { setError(e.message || String(e)); }
  }, [txFilter, txQuery]);

  React.useEffect(() => { loadPortfolio(); const id = setInterval(loadPortfolio, 5 * 60 * 1000); return () => clearInterval(id); }, [loadPortfolio]);
  React.useEffect(() => { if (live) loadPerformance(); }, [live, range, loadPerformance]);
  React.useEffect(() => { if (live && tab === 'transactions') { const id = setTimeout(() => loadTransactions(1), 250); return () => clearTimeout(id); } }, [live, tab, txFilter, txQuery, loadTransactions]);

  const awaitJob = async (jobId) => {
    if (!jobId) return;
    for (let i = 0; i < 120; i++) {
      const job = await window.HelixAPI.portfolioJob(jobId);
      setBusy(`${job.type.replaceAll('_', ' ')} · ${job.progress}%`);
      if (job.status === 'completed') return;
      if (job.status === 'failed') throw new Error(job.error || 'Portfolio rebuild failed');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('Portfolio rebuild timed out');
  };

  const refreshAll = async () => { await loadPortfolio(); await loadPerformance(); if (tab === 'transactions') await loadTransactions(transactions.page); };

  const saveTransaction = async (payload) => {
    if (!live) return;
    setBusy(editTx ? 'Replacing transaction…' : 'Adding transaction…');
    try {
      const result = editTx ? await window.HelixAPI.replaceTransaction(editTx.id, payload) : await window.HelixAPI.addTransaction(payload);
      await awaitJob(result.job_id); setShowTx(false); setEditTx(null); await refreshAll();
      window.toast?.(editTx ? 'Transaction replaced' : 'Transaction added', { type: 'success' });
    } catch (e) { window.toast?.(e.message || String(e), { type: 'error', duration: 7000 }); }
    setBusy('');
  };

  const voidTransaction = async (tx) => {
    if (!await window.askConfirm({ title: 'Void transaction', message: `Void this ${tx.type.toLowerCase()} transaction? Its audit history will be preserved.`, confirmText: 'Void', danger: true })) return;
    setBusy('Voiding transaction…');
    try { const result = await window.HelixAPI.voidTransaction(tx.id); await awaitJob(result.job_id); await refreshAll(); window.toast?.('Transaction voided', { type: 'success' }); }
    catch (e) { window.toast?.(e.message || String(e), { type: 'error' }); }
    setBusy('');
  };

  const changeCurrency = async (currency) => {
    if (!live || currency === portfolio.display_currency) return;
    setBusy(`Converting to ${currency}…`);
    try {
      const result = await window.HelixAPI.setPortfolioCurrency(currency); await awaitJob(result.job_id); await refreshAll();
      const settings = JSON.parse(localStorage.getItem('helix_settings_v1') || '{}');
      localStorage.setItem('helix_settings_v1', JSON.stringify({ ...settings, baseCurrency: currency }));
    } catch (e) { window.toast?.(e.message || String(e), { type: 'error', duration: 7000 }); }
    setBusy('');
  };

  const exportHoldings = () => {
    const rows = [['Ticker', 'Native Currency', 'Shares', 'Avg Cost', 'Last', `Value (${portfolio.display_currency})`, `Gain (${portfolio.display_currency})`, 'Gain %', 'Weight %']];
    portfolio.holdings.forEach(h => rows.push([h.ticker, h.currency, h.shares, h.avg_cost, h.price ?? '', h.value ?? '', h.gain ?? '', h.gain_pct ?? '', h.weight ?? '']));
    const blob = new Blob([rows.map(row => row.join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'portfolio_holdings.csv'; a.click(); URL.revokeObjectURL(a.href);
  };

  if (loading || !portfolio) return <div className="page"><div className="skeleton" style={{ height: 220 }} /></div>;
  const currency = portfolio.display_currency;
  const colors = ['#C2410C', '#1D4ED8', '#15803D', '#7C3AED', '#A16207', '#0E7490', '#BE185D'];
  const segments = portfolio.holdings.filter(h => h.value > 0).map((h, i) => ({ value: h.value, label: h.ticker, color: colors[i % colors.length] }));
  const chartData = performance.map(point => chartMode === 'twr' ? point.twr : point.value);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="row" style={{ marginBottom: 4 }}><h1 className="page-title" style={{ margin: 0 }}>Your portfolio.</h1><PortfolioStatus portfolio={portfolio} live={live} /></div>
          <p className="page-sub">{portfolio.holdings.length} positions · Ledger revision {portfolio.ledger_revision || 0}{portfolio.as_of ? ` · ${new Date(portfolio.as_of).toLocaleString()}` : ''}</p>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <select className="btn" value={currency} disabled={!live || !!busy} onChange={e => changeCurrency(e.target.value)} title="Display currency only — native records are unchanged">
            {PORTFOLIO_CURRENCIES.map(c => <option key={c}>{c}</option>)}
          </select>
          <button className="btn" disabled={!live} onClick={() => { const a = document.createElement('a'); a.href = window.HelixAPI.portfolioStatementUrl(); a.click(); }}><Icon name="download" size={12} /> Statement</button>
          <button className="btn" disabled={!live} onClick={() => setShowImport(true)}><Icon name="download" size={12} /> Import CSV</button>
          <button className="btn btn-primary" disabled={!live} onClick={() => { setEditTx(null); setShowTx(true); }}><Icon name="plus" size={12} /> Add transaction</button>
        </div>
      </div>

      {!live && <div className="card" style={{ padding: 12, marginBottom: 16, color: 'var(--text-muted)', borderColor: 'var(--border-strong)' }}>This is read-only demo data. Connect the FastAPI backend to create and persist a real portfolio.</div>}
      {busy && <div className="card" style={{ padding: 10, marginBottom: 16, color: 'var(--accent)' }}>{busy}</div>}
      {error && <div className="card" style={{ padding: 10, marginBottom: 16, color: 'var(--neg)' }}>{error}</div>}
      {portfolio.missing?.length > 0 && <div className="card" style={{ padding: 10, marginBottom: 16, color: 'var(--neg)' }}>Incomplete valuation: {portfolio.missing.map(x => x.key).join(', ')}</div>}
      {portfolio.stale?.length > 0 && <div className="card" style={{ padding: 10, marginBottom: 16, color: 'var(--text-muted)' }}>Using last-known data for {portfolio.stale.map(x => x.key).join(', ')}. Values are visibly retained, never generated.</div>}

      <div className="row" style={{ marginBottom: 16, borderBottom: '1px solid var(--border)' }}>
        {[['overview', 'Overview'], ['tickers', 'By ticker'], ['transactions', 'Transactions']].map(([id, label]) => <button key={id} className="card-action" onClick={() => setTab(id)} style={{ padding: '10px 4px', marginRight: 18, color: tab === id ? 'var(--accent)' : 'var(--text-muted)', borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent' }}>{label}</button>)}
      </div>

      {tab === 'overview' ? <>
        <div className="stat-grid" style={{ marginBottom: 20 }}>
          <PortfolioMetric label="Total value" value={pfMoney(portfolio.total_value, currency)} />
          <PortfolioMetric label="Today" value={pfMoney(portfolio.today_change, currency)} delta={portfolio.today_change_pct} />
          <PortfolioMetric label="Investment gain" value={pfMoney(portfolio.total_gain, currency)} delta={portfolio.total_gain_pct} />
          <PortfolioMetric label="Cash" value={pfMoney(portfolio.cash_value, currency)} />
        </div>

        {portfolio.holdings.length === 0 ? <PortfolioEmpty onAdd={() => setShowTx(true)} onImport={() => setShowImport(true)} live={live} /> : <>
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header" style={{ flexWrap: 'wrap' }}>
              <div><h3 className="card-title">Performance</h3><span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Deposits and withdrawals are excluded from TWR</span></div>
              <div className="row">
                <div className="range-chips">{['value', 'twr'].map(m => <button key={m} className="range-chip" aria-selected={chartMode === m} onClick={() => setChartMode(m)}>{m === 'twr' ? 'TWR %' : 'Value'}</button>)}</div>
                <div className="range-chips">{['1m', '3m', 'ytd', '1y', 'all'].map(r => <button key={r} className="range-chip" aria-selected={range === r} onClick={() => setRange(r)}>{r.toUpperCase()}</button>)}</div>
              </div>
            </div>
            <div className="card-body" style={{ height: 230 }}>{chartData.length > 1 ? <AreaChart data={chartData} width={1050} height={200} padding={{ t: 10, r: 60, b: 10, l: 0 }} /> : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--text-subtle)' }}>Performance appears after historical prices are available.</div>}<div style={{ fontSize: 11, color: 'var(--text-subtle)', textAlign: 'right' }}>Net contributions in range: {pfMoney(performance.reduce((sum, point) => sum + Number(point.net_flow || 0), 0), currency)}</div></div>
          </div>

          <div className="grid-2" style={{ marginBottom: 20 }}>
            <div className="card"><div className="card-header"><h3 className="card-title">Allocation</h3><span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Verified market value</span></div><div className="card-body" style={{ display: 'flex', gap: 24, alignItems: 'center' }}><Donut segments={segments} size={160} thickness={28} /><div style={{ flex: 1 }}>{portfolio.holdings.slice(0, 7).map((h, i) => <div key={`${h.ticker}-${h.currency}`} style={{ display: 'grid', gridTemplateColumns: '12px 1fr auto', gap: 8, marginBottom: 7, fontSize: 12 }}><span style={{ width: 10, height: 10, background: colors[i % colors.length], borderRadius: 2 }} /><span className="ticker">{h.ticker}</span><span className="num">{Number(h.weight || 0).toFixed(1)}%</span></div>)}</div></div></div>
            <div className="card"><div className="card-header"><h3 className="card-title">Cash balances</h3><span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Native and converted</span></div><div className="card-body">{portfolio.cash.length ? portfolio.cash.map(row => <div key={row.currency} className="between row" style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}><div><span className="ticker">{row.currency}</span>{row.warning && <span className="pill neg" style={{ marginLeft: 8 }}>Unreconciled</span>}</div><div style={{ textAlign: 'right' }}><div className="num">{pfMoney(row.balance, row.currency)}</div>{row.currency !== currency && <div style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{pfMoney(row.converted, currency)}</div>}</div></div>) : <span style={{ color: 'var(--text-subtle)' }}>No cash transactions yet.</span>}</div></div>
          </div>

          <HoldingsTable holdings={portfolio.holdings} currency={currency} onSelect={setHistoryTicker} onExport={exportHoldings} />
        </>}
      </> : tab === 'tickers' ? <TickerPanel live={live} revision={portfolio.projection_revision} holdings={portfolio.holdings} /> : <TransactionsPanel data={transactions} filter={txFilter} setFilter={setTxFilter} query={txQuery} setQuery={setTxQuery} onPage={loadTransactions} onAdd={() => { setEditTx(null); setShowTx(true); }} onEdit={tx => { setEditTx(tx); setShowTx(true); }} onVoid={voidTransaction} onExport={() => { const a = document.createElement('a'); a.href = window.HelixAPI.portfolioTransactionsExportUrl(); a.click(); }} />}

      {historyTicker && <TickerHistoryModal ticker={historyTicker} revision={portfolio.projection_revision} price={portfolio.holdings.find(h => h.ticker === historyTicker)?.price} onClose={() => setHistoryTicker(null)} onChart={() => { setActiveAsset(historyTicker); setPage('detail'); }} />}
      {showTx && <TransactionModal initial={editTx} currency={currency} onClose={() => { setShowTx(false); setEditTx(null); }} onSave={saveTransaction} busy={!!busy} />}
      {showImport && <PortfolioImportModal onClose={() => setShowImport(false)} onCommitted={async result => { setShowImport(false); setBusy('Importing…'); try { await awaitJob(result.job_id); await refreshAll(); window.toast?.(`Imported ${result.imported} transactions`, { type: 'success' }); } catch (e) { window.toast?.(e.message, { type: 'error' }); } setBusy(''); }} />}
    </div>
  );
};

// By ticker — one row per stock: orders, shares bought / received / sold, money
// in and out, dividends, and a method-free net P/L. Click a row for every event.
const EVENT_STYLE = {
  BUY: { label: 'Buy', color: 'var(--text)' },
  SELL: { label: 'Sell', color: 'var(--accent)' },
  BONUS: { label: 'Bonus / stock dividend', color: 'var(--pos)' },
  RIGHTS: { label: 'Rights issue', color: 'var(--pos)' },
  DIVIDEND: { label: 'Cash dividend', color: 'var(--pos)' },
};

const tkMoney = (v, c = 'VND') => v == null ? '—' : pfMoney(v, c, 0);
const tkNum = v => v ? Number(v).toLocaleString() : '—';
const tkPL = (v, pct) => v == null ? '—' : <><span className={v >= 0 ? 'pos num' : 'neg num'}>{tkMoney(v)}</span>{pct != null && <div><Pill value={pct} /></div>}</>;

// Every order and share event for one ticker (shared by the By-ticker tab and the holdings popup).
const TickerEvents = ({ t }) => {
  const [openEvent, setOpenEvent] = React.useState(null);
  const m = tkMoney, n = tkNum, pl = tkPL;
  return <>
    <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text-muted)' }}>
      <strong style={{ color: 'var(--text)' }}>{t.ticker}</strong>: {t.orders_buy} buy orders ({n(t.shares_bought)} shares) · {t.orders_sell} sell orders ({n(t.shares_sold)} shares)
      {t.shares_received ? <> · <span style={{ color: 'var(--pos)' }}>received {n(t.shares_received)} shares</span> (bonus, stock dividends, rights)</> : null}
      {' '}· holding {n(t.shares_now)} · FIFO cost of holding {m(t.open_cost)} · fees {m(t.fees)} · taxes {m(t.taxes)}
    </div>
    <table className="table" style={{ margin: 0 }}>
      <thead><tr><th>Date</th><th>Event</th><th className="right">Shares</th><th className="right">Price</th><th className="right">Cash</th><th className="right">Fee + tax</th><th className="right">Shares after</th><th className="right">FIFO P/L</th></tr></thead>
      <tbody>{t.events.map(e => { const st = EVENT_STYLE[e.kind] || { label: e.kind }; const expandable = e.kind === 'SELL' && e.lots?.length; return <React.Fragment key={e.id}>
        <tr onClick={() => expandable && setOpenEvent(openEvent === e.id ? null : e.id)} style={{ cursor: expandable ? 'pointer' : 'default' }} title={e.note || ''}>
          <td className="num" style={{ fontSize: 12 }}>{new Date(e.date).toLocaleDateString()}</td>
          <td style={{ fontSize: 12, color: st.color, fontWeight: 600 }}>{expandable ? (openEvent === e.id ? '▾ ' : '▸ ') : ''}{st.label}{e.source === 'ssi_statement' ? <span style={{ fontWeight: 400, color: 'var(--text-subtle)' }}> · from monthly statement</span> : null}</td>
          <td className="right num" style={{ fontSize: 12 }}>{e.quantity != null ? (e.kind === 'SELL' ? '−' : '+') + n(e.quantity) : '—'}</td>
          <td className="right num" style={{ fontSize: 12 }}>{e.price ? m(e.price) : (e.kind === 'BONUS' ? 'free' : '—')}</td>
          <td className="right num" style={{ fontSize: 12 }}><span className={e.amount >= 0 ? 'pos' : ''}>{e.amount ? m(e.amount) : '—'}</span></td>
          <td className="right num" style={{ fontSize: 12 }}>{e.fees + e.taxes ? m(e.fees + e.taxes) : '—'}</td>
          <td className="right num" style={{ fontSize: 12 }}>{e.kind === 'DIVIDEND' ? '' : n(e.shares_after)}</td>
          <td className="right" style={{ fontSize: 12 }}>{e.kind === 'SELL' ? pl(e.fifo_gain) : ''}</td>
        </tr>
        {openEvent === e.id && e.lots.map((l, i) => <tr key={i}><td></td><td colSpan={2} style={{ fontSize: 11, color: 'var(--text-muted)' }}>↳ from lot bought {new Date(l.buy_date).toLocaleDateString()}</td><td className="right num" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{n(l.quantity)} × {l.unit_cost ? m(l.unit_cost) : 'free'}</td><td className="right num" style={{ fontSize: 11, color: 'var(--text-muted)' }}>cost {m(l.cost)}</td><td colSpan={3}></td></tr>)}
      </React.Fragment>; })}</tbody>
    </table>
  </>;
};

// Popup opened from the Overview holdings table.
const TickerHistoryModal = ({ ticker, revision, price, onClose, onChart }) => {
  const [t, setT] = React.useState(null);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    window.HelixAPI.portfolioTickers().then(d => {
      const row = d.tickers.find(x => x.ticker === ticker);
      row ? setT(row) : setError(`No trades recorded for ${ticker}.`);
    }).catch(e => setError(e.message));
  }, [ticker, revision]);
  const value = t && price != null ? price * t.shares_now : null;
  const net = t && value != null ? t.received + t.dividends + value - t.paid : null;
  return <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center', padding: 20 }}>
    <div onClick={e => e.stopPropagation()} className="card" style={{ width: '100%', maxWidth: 960, maxHeight: '88vh', overflow: 'auto' }}>
      <div className="card-header"><div><h3 className="card-title"><span className="ticker">{ticker}</span> · my orders</h3>{t && <span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Paid {tkMoney(t.paid)} · from sells {tkMoney(t.received)} · dividends {tkMoney(t.dividends)} · value now {tkMoney(value)}</span>}</div>
        <div className="row">{net != null && <span>Net P/L {tkPL(net, t.paid ? net / t.paid * 100 : null)}</span>}<button className="btn" onClick={onChart}>Open chart</button><button className="icon-btn" onClick={onClose}><Icon name="close" size={12} /></button></div></div>
      <div className="card-body flush" style={{ overflowX: 'auto' }}>
        {error ? <div style={{ padding: 24, color: 'var(--text-muted)' }}>{error}</div> : !t ? <div style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</div> : <TickerEvents t={t} />}
      </div>
    </div>
  </div>;
};

const TickerPanel = ({ live, revision, holdings }) => {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState('');
  const [open, setOpen] = React.useState(null);
  React.useEffect(() => {
    if (!live) return;
    window.HelixAPI.portfolioTickers().then(setData).catch(e => setError(e.message));
  }, [live, revision]);
  if (!live) return <div className="card" style={{ padding: 24, color: 'var(--text-muted)' }}>Connect the backend to see the per-ticker breakdown.</div>;
  if (error) return <div className="card" style={{ padding: 12, color: 'var(--neg)' }}>{error}</div>;
  if (!data) return <div className="card" style={{ padding: 24, color: 'var(--text-muted)' }}>Loading tickers…</div>;

  const price = Object.fromEntries((holdings || []).map(h => [h.ticker, h.price]));
  const rows = data.tickers.map(t => {
    const value = t.shares_now > 0 ? (price[t.ticker] != null ? price[t.ticker] * t.shares_now : null) : 0;
    const net = value == null ? null : t.received + t.dividends + value - t.paid;
    return { ...t, value, net, net_pct: net != null && t.paid ? net / t.paid * 100 : null };
  });
  const tot = rows.reduce((a, r) => ({ paid: a.paid + r.paid, received: a.received + r.received, dividends: a.dividends + r.dividends, value: a.value + (r.value || 0), net: a.net + (r.net || 0), orders: a.orders + r.orders_buy + r.orders_sell }), { paid: 0, received: 0, dividends: 0, value: 0, net: 0, orders: 0 });
  const m = (v, c = 'VND') => v == null ? '—' : pfMoney(v, c, 0);
  const n = v => v ? Number(v).toLocaleString() : '—';
  const pl = (v, pct) => v == null ? '—' : <><span className={v >= 0 ? 'pos num' : 'neg num'}>{m(v)}</span>{pct != null && <div><Pill value={pct} /></div>}</>;

  return <>
    <div className="stat-grid" style={{ marginBottom: 20 }}>
      <PortfolioMetric label="Net P/L, all tickers" value={m(tot.net)} delta={tot.paid ? tot.net / tot.paid * 100 : undefined} />
      <PortfolioMetric label="Paid for shares" value={m(tot.paid)} />
      <PortfolioMetric label="Received (sells + dividends)" value={m(tot.received + tot.dividends)} />
      <PortfolioMetric label="Orders" value={tot.orders.toLocaleString()} />
    </div>
    <div className="card">
      <div className="card-header"><div><h3 className="card-title">By ticker</h3><span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Net P/L = money from sells + dividends + value now − money paid (fees &amp; taxes included). Same result for FIFO or average. Click a ticker for every order and share event.</span></div></div>
      <div className="card-body flush" style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr>
            <th>Ticker</th><th className="right">Orders<div style={{ fontWeight: 400, fontSize: 10 }}>buy / sell</div></th>
            <th className="right">Bought</th><th className="right">Received<div style={{ fontWeight: 400, fontSize: 10 }}>bonus / rights</div></th><th className="right">Sold</th><th className="right">Hold now</th>
            <th className="right">Paid</th><th className="right">From sells</th><th className="right">Dividends</th><th className="right">Value now</th>
            <th className="right">Net P/L</th><th className="right">FIFO realized</th>
          </tr></thead>
          <tbody>{rows.map(t => <React.Fragment key={t.ticker}>
            <tr onClick={() => { setOpen(open === t.ticker ? null : t.ticker); }} style={{ cursor: 'pointer', opacity: t.shares_now > 0 ? 1 : 0.75 }}>
              <td><span className="ticker">{open === t.ticker ? '▾' : '▸'} {t.ticker}</span></td>
              <td className="right num">{t.orders_buy} / {t.orders_sell}</td>
              <td className="right num">{n(t.shares_bought)}</td>
              <td className="right num" style={{ color: t.shares_received ? 'var(--pos)' : undefined }}>{t.shares_received ? '+' + n(t.shares_received) : '—'}</td>
              <td className="right num">{n(t.shares_sold)}</td>
              <td className="right num" style={{ fontWeight: 600 }}>{n(t.shares_now)}</td>
              <td className="right num">{m(t.paid)}</td>
              <td className="right num">{m(t.received)}</td>
              <td className="right num">{t.dividends ? m(t.dividends) : '—'}</td>
              <td className="right num">{t.shares_now > 0 ? m(t.value) : '—'}</td>
              <td className="right">{pl(t.net, t.net_pct)}</td>
              <td className="right">{t.orders_sell ? pl(t.realized_fifo) : '—'}</td>
            </tr>
            {open === t.ticker && <tr><td colSpan={12} style={{ background: 'var(--bg-sunken)', padding: 0 }}><TickerEvents t={t} /></td></tr>}
          </React.Fragment>)}</tbody>
          <tfoot><tr style={{ fontWeight: 600 }}><td>Total</td><td className="right num">{tot.orders}</td><td colSpan={4}></td><td className="right num">{m(tot.paid)}</td><td className="right num">{m(tot.received)}</td><td className="right num">{m(tot.dividends)}</td><td className="right num">{m(tot.value)}</td><td className="right">{pl(tot.net)}</td><td></td></tr></tfoot>
        </table>
      </div>
    </div>
  </>;
};

const PortfolioEmpty = ({ onAdd, onImport, live }) => <div className="card" style={{ padding: 48, textAlign: 'center' }}><h3 className="serif" style={{ fontSize: 22, marginBottom: 8 }}>Start with the ledger.</h3><p style={{ color: 'var(--text-muted)', marginBottom: 20 }}>Add a deposit and buy, or import a CSV. Empty means empty—no sample positions are mixed into live data.</p><div className="row" style={{ justifyContent: 'center' }}><button className="btn btn-primary" disabled={!live} onClick={onAdd}>Add transaction</button><button className="btn" disabled={!live} onClick={onImport}>Import CSV</button></div></div>;

const HoldingsTable = ({ holdings, currency, onSelect, onExport }) => <div className="card"><div className="card-header"><h3 className="card-title">Holdings</h3><button className="btn" onClick={onExport}><Icon name="download" size={12} /> Export</button></div><div className="card-body flush" style={{ overflowX: 'auto' }}><table className="table"><thead><tr><th>Ticker</th><th>Native</th><th className="right">Shares</th><th className="right">Avg FIFO cost</th><th className="right">Last</th><th className="right">Value ({currency})</th><th className="right">Unrealized</th><th className="right">Weight</th></tr></thead><tbody>{holdings.map(h => <tr key={`${h.ticker}-${h.currency}`} onClick={() => onSelect(h.ticker)} style={{ cursor: 'pointer' }} title="Show my orders"><td><span className="ticker">{h.ticker}</span></td><td>{h.currency}</td><td className="right num">{Number(h.shares).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td><td className="right num">{pfMoney(h.avg_cost, h.currency)}</td><td className="right num">{pfMoney(h.price, h.currency)}</td><td className="right num">{pfMoney(h.value, currency)}</td><td className="right"><span className={h.gain >= 0 ? 'pos num' : 'neg num'}>{pfMoney(h.gain, currency)}</span><div><Pill value={h.gain_pct || 0} /></div></td><td className="right num">{Number(h.weight || 0).toFixed(2)}%</td></tr>)}</tbody></table></div></div>;

const TransactionsPanel = ({ data, filter, setFilter, query, setQuery, onPage, onAdd, onEdit, onVoid, onExport }) => <div className="card"><div className="card-header" style={{ flexWrap: 'wrap' }}><div><h3 className="card-title">Transaction ledger</h3><span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>{data.total} audited records</span></div><div className="row"><input className="btn" style={{ width: 150 }} value={query} onChange={e => setQuery(e.target.value)} placeholder="Ticker or note…" /><select className="btn" value={filter} onChange={e => setFilter(e.target.value)}><option value="">All types</option>{TX_TYPES.map(x => <option key={x}>{x}</option>)}</select><button className="btn" onClick={onExport}><Icon name="download" size={12} /> Export</button><button className="btn btn-primary" onClick={onAdd}><Icon name="plus" size={12} /> Add</button></div></div><div className="card-body flush" style={{ overflowX: 'auto' }}><table className="table"><thead><tr><th>Date</th><th>Type</th><th>Ticker</th><th className="right">Quantity</th><th className="right">Price / cash</th><th>Currency</th><th>Source</th><th>Status</th><th></th></tr></thead><tbody>{data.items.map(tx => <tr key={tx.id}><td className="num">{new Date(tx.effective_at).toLocaleDateString()}</td><td><span className="ticker">{tx.type}</span></td><td>{tx.ticker || '—'}</td><td className="right num">{tx.quantity ?? '—'}</td><td className="right num">{pfMoney(tx.unit_price ?? tx.cash_amount, tx.currency)}</td><td>{tx.currency}</td><td>{tx.source}</td><td><span className={`pill ${tx.status === 'active' ? 'pos' : ''}`}>{tx.status}</span></td><td className="right">{tx.status === 'active' && <div className="row" style={{ justifyContent: 'flex-end' }}><button className="card-action" onClick={() => onEdit(tx)}>Edit</button><button className="card-action" style={{ color: 'var(--neg)' }} onClick={() => onVoid(tx)}>Void</button></div>}</td></tr>)}</tbody></table>{data.items.length === 0 && <div style={{ padding: 36, textAlign: 'center', color: 'var(--text-subtle)' }}>No transactions match this filter.</div>}</div><div className="card-header"><button className="btn" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>Previous</button><span className="num" style={{ fontSize: 11 }}>Page {data.page} of {Math.max(1, Math.ceil(data.total / data.page_size))}</span><button className="btn" disabled={data.page * data.page_size >= data.total} onClick={() => onPage(data.page + 1)}>Next</button></div></div>;

const TransactionModal = ({ initial, currency, onClose, onSave, busy }) => {
  const seed = initial || {};
  const [type, setType] = React.useState(seed.type || 'BUY');
  const [effectiveAt, setEffectiveAt] = React.useState(pfLocalDateTime(seed.effective_at || new Date()));
  const [ticker, setTicker] = React.useState(seed.ticker || '');
  const [quantity, setQuantity] = React.useState(seed.quantity ?? '');
  const [unitPrice, setUnitPrice] = React.useState(seed.unit_price ?? '');
  const [cashAmount, setCashAmount] = React.useState(seed.cash_amount ?? '');
  const [nativeCurrency, setNativeCurrency] = React.useState(seed.currency || currency);
  const [fees, setFees] = React.useState(seed.fees || '');
  const [taxes, setTaxes] = React.useState(seed.taxes || '');
  const [note, setNote] = React.useState(seed.note || '');
  const trade = ['BUY', 'SELL'].includes(type);
  const valid = trade ? ticker.trim() && Number(quantity) > 0 && Number(unitPrice) >= 0 : Number(cashAmount) > 0;
  const submit = () => onSave({ type, effective_at: new Date(effectiveAt).toISOString(), ticker: trade || type === 'DIVIDEND' ? (ticker.trim().toUpperCase() || null) : null, quantity: trade ? Number(quantity) : null, unit_price: trade ? Number(unitPrice) : null, cash_amount: trade ? null : Number(cashAmount), currency: nativeCurrency, fees: Number(fees) || 0, taxes: Number(taxes) || 0, note: note || null, source: initial?.source || 'manual', external_id: initial?.external_id || null });
  const field = { width: '100%', padding: '9px 11px', background: 'var(--bg-sunken)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 5, fontFamily: 'inherit' };
  const label = { display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-subtle)', marginBottom: 5 };
  return <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center', padding: 20 }}><div onClick={e => e.stopPropagation()} className="card" style={{ width: '100%', maxWidth: 560 }}><div className="card-header"><h3 className="card-title">{initial ? 'Replace transaction' : 'Add transaction'}</h3><button className="icon-btn" onClick={onClose}><Icon name="close" size={12} /></button></div><div className="card-body stack"><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}><div><label style={label}>Type</label><select style={field} value={type} onChange={e => setType(e.target.value)}>{TX_TYPES.map(x => <option key={x}>{x}</option>)}</select></div><div><label style={label}>Effective time</label><input style={field} type="datetime-local" value={effectiveAt} onChange={e => setEffectiveAt(e.target.value)} /></div></div>{(trade || type === 'DIVIDEND') && <div><label style={label}>Ticker</label><input style={field} value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} placeholder="AAPL or VN:VNM" /></div>}{trade ? <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}><div><label style={label}>Quantity</label><input style={field} type="number" step="any" value={quantity} onChange={e => setQuantity(e.target.value)} /></div><div><label style={label}>Unit price</label><input style={field} type="number" step="any" value={unitPrice} onChange={e => setUnitPrice(e.target.value)} /></div></div> : <div><label style={label}>Cash amount</label><input style={field} type="number" step="any" value={cashAmount} onChange={e => setCashAmount(e.target.value)} /></div>}<div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}><div><label style={label}>Native currency</label><select style={field} value={nativeCurrency} onChange={e => setNativeCurrency(e.target.value)}>{PORTFOLIO_CURRENCIES.map(c => <option key={c}>{c}</option>)}</select></div><div><label style={label}>Fees</label><input style={field} type="number" step="any" value={fees} onChange={e => setFees(e.target.value)} /></div><div><label style={label}>Taxes</label><input style={field} type="number" step="any" value={taxes} onChange={e => setTaxes(e.target.value)} /></div></div><div><label style={label}>Note</label><textarea style={{ ...field, minHeight: 70 }} value={note} onChange={e => setNote(e.target.value)} /></div>{trade && valid && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Gross trade: {pfMoney(Number(quantity) * Number(unitPrice), nativeCurrency)}</div>}</div><div className="card-header" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>{initial ? 'Save replacement' : 'Add transaction'}</button></div></div></div>;
};

const PortfolioImportModal = ({ onClose, onCommitted }) => {
  const [preview, setPreview] = React.useState(null); const [mapping, setMapping] = React.useState({}); const [validation, setValidation] = React.useState(null); const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState('');
  const upload = async file => { if (!file) return; setBusy(true); setError(''); try { const p = await window.HelixAPI.portfolioImportPreview(file); setPreview(p); const auto = {}; p.headers.forEach(h => { const match = p.canonical_fields.find(f => f.toLowerCase() === h.trim().toLowerCase()); if (match) auto[h] = match; }); setMapping(auto); } catch (e) { setError(e.message); } setBusy(false); };
  const validate = async () => { setBusy(true); setError(''); try { setValidation(await window.HelixAPI.portfolioImportValidate(preview.import_id, mapping)); } catch (e) { setError(e.message); } setBusy(false); };
  const commit = async () => { setBusy(true); try { onCommitted(await window.HelixAPI.portfolioImportCommit(preview.import_id)); } catch (e) { setError(e.message); setBusy(false); } };
  return <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.45)', display: 'grid', placeItems: 'center', padding: 20 }}><div onClick={e => e.stopPropagation()} className="card" style={{ width: '100%', maxWidth: 720, maxHeight: '88vh', overflow: 'auto' }}><div className="card-header"><div><h3 className="card-title">Import transaction CSV</h3><span style={{ fontSize: 11, color: 'var(--text-subtle)' }}>Upload → map → validate → atomic commit</span></div><button className="icon-btn" onClick={onClose}><Icon name="close" size={12} /></button></div><div className="card-body">{!preview ? <div style={{ padding: 36, textAlign: 'center' }}><input type="file" accept=".csv,text/csv" disabled={busy} onChange={e => upload(e.target.files?.[0])} /></div> : <><p style={{ color: 'var(--text-muted)' }}>{preview.row_count.toLocaleString()} rows · map source columns to ledger fields.</p><div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{preview.headers.map(h => <div key={h} className="row"><span style={{ flex: 1, fontSize: 12 }}>{h}</span><select className="btn" value={mapping[h] || ''} onChange={e => { setMapping(m => ({ ...m, [h]: e.target.value })); setValidation(null); }}><option value="">Ignore</option>{preview.canonical_fields.map(f => <option key={f}>{f}</option>)}</select></div>)}</div>{validation && <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-sunken)', color: validation.error_rows ? 'var(--neg)' : 'var(--pos)' }}>{validation.valid_rows} valid · {validation.error_rows} errors{validation.errors?.slice(0, 5).map(e => <div key={e.row} style={{ fontSize: 11 }}>Row {e.row}: {e.message}</div>)}{validation.error_rows > 0 && <div style={{ marginTop: 8 }}><a className="btn" href={window.HelixAPI.portfolioImportErrorsUrl(preview.import_id)}>Download error report</a></div>}</div>}</>}{error && <div style={{ color: 'var(--neg)', marginTop: 12 }}>{error}</div>}</div><div className="card-header" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Cancel</button>{preview && <button className="btn" disabled={busy} onClick={validate}>Validate</button>}<button className="btn btn-primary" disabled={busy || !validation?.can_commit} onClick={commit}>Commit atomically</button></div></div></div>;
};

window.PagePortfolio = PagePortfolio;

if (!document.getElementById('portfolio-page-style')) {
  const style = document.createElement('style');
  style.id = 'portfolio-page-style';
  style.textContent = `
    @media (max-width: 900px) {
      .main[data-screen-label="portfolio"] .grid-2 { grid-template-columns: 1fr !important; }
      .main[data-screen-label="portfolio"] .stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
      .main[data-screen-label="portfolio"] .page-header { align-items: flex-start; gap: 12px; }
    }
    @media (max-width: 560px) {
      .main[data-screen-label="portfolio"] .stat-grid { grid-template-columns: 1fr !important; }
      .main[data-screen-label="portfolio"] .page { padding-left: 12px; padding-right: 12px; }
    }
  `;
  document.head.appendChild(style);
}
