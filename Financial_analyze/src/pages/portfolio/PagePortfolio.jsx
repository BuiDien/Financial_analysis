// Portfolio — trustworthy overview + audited transaction ledger. Route: #/portfolio.
// Holdings, cash and performance are read from the local ledger, never from sample data.

import React from 'react';
import { handoff } from '../../handoff.js';
import { HelixAPI } from '../../api-client.jsx';
import { usePortfolioRaw } from '../../lib/data.js';
import { invalidate } from '../../lib/query.js';
import { formatDateTime } from '../../lib/format.js';
import { Badge, Button, Card, EmptyState, ErrorState, ProgressBar, Select, Skeleton, Tabs, askConfirm, toast } from '../../ui';
import { PORTFOLIO_CURRENCIES, download, gmailNotSetUp, gmailSyncToast, syncJobIds } from './pf-utils.js';
import { OverviewPanel } from './OverviewPanel.jsx';
import { TickerPanel } from './TickerPanel.jsx';
import { TransactionsPanel } from './TransactionsPanel.jsx';
import { TickerHistoryDialog } from './TickerEvents.jsx';
import { TransactionDialog } from './TransactionDialog.jsx';
import { ImportDialog } from './ImportDialog.jsx';
import { PasteDialog } from './PasteDialog.jsx';
import './portfolio.css';

const TABS = [{ value: 'overview', label: 'Overview' }, { value: 'tickers', label: 'By ticker' }, { value: 'transactions', label: 'Transactions' }];
const CCY_OPTIONS = PORTFOLIO_CURRENCIES.map(c => ({ value: c, label: c }));
const EMPTY_TX = { items: [], total: 0, page: 1, page_size: 50 };

const PortfolioStatus = ({ portfolio }) => {
  if (portfolio.projection_status !== 'ready') return <Badge tone="accent" dot>{portfolio.projection_status}</Badge>;
  if (!portfolio.complete) return <Badge tone="neg" dot>Incomplete valuation</Badge>;
  if (portfolio.stale?.length) return <Badge tone="warn" dot>Stale data</Badge>;
  return <Badge tone="pos" dot>Verified live</Badge>;
};

const Header = ({ sub, status, actions }) => (
  <div className="page-header">
    <div>
      <div className="pf-title-row"><h1 className="page-title">Your portfolio.</h1>{status}</div>
      <p className="page-sub">{sub}</p>
    </div>
    {actions && <div className="pf-actions">{actions}</div>}
  </div>
);

const PagePortfolio = ({ setActiveAsset, setPage }) => {
  // Shared query cache entry (Today's holdings card reads the same one).
  const pfQ = usePortfolioRaw();
  const live = pfQ.live;
  const portfolio = pfQ.data || null;
  const loading = live && pfQ.isLoading;
  const [error, setError] = React.useState('');
  const loadError = pfQ.error && !portfolio ? (pfQ.error.message || String(pfQ.error)) : '';
  const [tab, setTab] = React.useState('overview');
  const [range, setRange] = React.useState('1y');
  const [chartMode, setChartMode] = React.useState('value');
  const [performance, setPerformance] = React.useState([]);
  const [transactions, setTransactions] = React.useState(EMPTY_TX);
  const [txFilter, setTxFilter] = React.useState('');
  const [txQuery, setTxQuery] = React.useState('');
  const [showTx, setShowTx] = React.useState(false);
  const [editTx, setEditTx] = React.useState(null);
  const [showImport, setShowImport] = React.useState(false);
  const [showPaste, setShowPaste] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
  const [historyTicker, setHistoryTicker] = React.useState(null);
  const [busy, setBusyState] = React.useState('');
  const [job, setJob] = React.useState(null);   // { type, progress } of the running rebuild job
  const mounted = React.useRef(true);
  const setBusy = React.useCallback((v) => { if (mounted.current) setBusyState(v); }, []);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // AI panel reads the live snapshot from the hand-off slot.
  React.useEffect(() => {
    if (live && portfolio) handoff.livePortfolioContext = portfolio;
    else delete handoff.livePortfolioContext;
  }, [live, portfolio]);
  const loadPortfolio = React.useCallback(async () => {
    setError('');
    try { await pfQ.refetch(); } catch (e) { setError(e.message || String(e)); }
  }, [pfQ.refetch]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadPerformance = React.useCallback(async () => {
    if (!HelixAPI?.live) { setPerformance([]); return; }
    try { setPerformance((await HelixAPI.portfolioPerformance(range)).items || []); }
    catch { setPerformance([]); }
  }, [range]);

  const loadTransactions = React.useCallback(async (page = 1) => {
    if (!HelixAPI?.live) { setTransactions(EMPTY_TX); return; }
    try { setTransactions(await HelixAPI.portfolioTransactions({ page, page_size: 50, ...(txFilter ? { type: txFilter } : {}), ...(txQuery ? { q: txQuery } : {}) })); }
    catch (e) { setError(e.message || String(e)); }
  }, [txFilter, txQuery]);

  React.useEffect(() => { if (live) loadPerformance(); }, [live, range, loadPerformance]);
  React.useEffect(() => {
    if (!(live && tab === 'transactions')) return undefined;
    const id = setTimeout(() => loadTransactions(1), 250);
    return () => clearTimeout(id);
  }, [live, tab, txFilter, txQuery, loadTransactions]);

  const awaitJob = async (jobId) => {
    if (!jobId) return;
    try {
      for (let i = 0; i < 120; i++) {
        if (!mounted.current) return;   // page left: stop polling, the backend job carries on
        const j = await HelixAPI.portfolioJob(jobId);
        if (!mounted.current) return;
        setJob({ type: j.type.replaceAll('_', ' '), progress: j.progress });
        if (j.status === 'completed') return;
        if (j.status === 'failed') throw new Error(j.error || 'Portfolio rebuild failed');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('Portfolio rebuild timed out');
    } finally { if (mounted.current) setJob(null); }
  };
  const refreshAll = async () => { await loadPortfolio(); await loadPerformance(); if (tab === 'transactions') await loadTransactions(transactions.page); };

  const saveTransaction = async (payload) => {
    if (!live) return;
    setBusy(editTx ? 'Replacing transaction…' : 'Adding transaction…');
    try {
      const result = editTx ? await HelixAPI.replaceTransaction(editTx.id, payload) : await HelixAPI.addTransaction(payload);
      await awaitJob(result.job_id); setShowTx(false); setEditTx(null); await refreshAll();
      toast(editTx ? 'Transaction replaced' : 'Transaction added', { type: 'success' });
    } catch (e) { toast(e.message || String(e), { type: 'error', duration: 7000 }); }
    setBusy('');
  };
  const voidTransaction = async (tx) => {
    if (!await askConfirm({ title: 'Void transaction', message: `Void this ${tx.type.toLowerCase()} transaction? Its audit history will be preserved.`, confirmText: 'Void', danger: true })) return;
    setBusy('Voiding transaction…');
    try { const result = await HelixAPI.voidTransaction(tx.id); await awaitJob(result.job_id); await refreshAll(); toast('Transaction voided', { type: 'success' }); }
    catch (e) { toast(e.message || String(e), { type: 'error' }); }
    setBusy('');
  };
  const changeCurrency = async (currency) => {
    if (!live || currency === portfolio.display_currency) return;
    setBusy(`Converting to ${currency}…`);
    try {
      const result = await HelixAPI.setPortfolioCurrency(currency); await awaitJob(result.job_id); await refreshAll();
      const settings = JSON.parse(localStorage.getItem('helix_settings_v1') || '{}');
      localStorage.setItem('helix_settings_v1', JSON.stringify({ ...settings, baseCurrency: currency }));
    } catch (e) { toast(e.message || String(e), { type: 'error', duration: 7000 }); }
    setBusy('');
  };
  const onImported = async (result) => {
    setShowImport(false); setBusy('Importing…');
    try { await awaitJob(result.job_id); await refreshAll(); toast(`Imported ${result.imported} transactions`, { type: 'success' }); }
    catch (e) { toast(e.message, { type: 'error' }); }
    setBusy('');
  };
  const onPasted = async (result) => {
    setShowPaste(false); setBusy('Adding pasted trades…');
    try {
      await awaitJob(result.job_id); await refreshAll(); invalidate(['portfolio']);
      const skipped = result.skipped?.length ? ` · ${result.skipped.length} already in ledger, skipped` : '';
      toast(`Added ${result.added} ${result.added === 1 ? 'trade' : 'trades'}${skipped}`, { type: 'success' });
    } catch (e) { toast(e.message || String(e), { type: 'error', duration: 7000 }); }
    setBusy('');
  };
  const openGmailSettings = () => setPage && setPage('#/inbox/gmail');
  // Pull new SSI emails now; the backend imports them into the ledger in the same call.
  const syncEmail = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const { summary } = await HelixAPI.checkGmail();
      const t = gmailSyncToast(summary);
      toast(t.message, { type: t.type, duration: t.type === 'error' ? 9000 : 6000,
        ...(t.type === 'error' ? { action: { label: 'Gmail settings', onClick: openGmailSettings } } : {}) });
      // The import queued a ledger rebuild: wait for it, so the refreshed page shows the new trades.
      const jobs = syncJobIds(summary);
      if (jobs.length && mounted.current) {
        setBusy('Rebuilding after email import…');
        try { for (const id of jobs) await awaitJob(id); }
        catch (e) { toast(e.message || String(e), { type: 'error', duration: 7000 }); }
        setBusy('');
      }
      if (mounted.current) { await refreshAll(); invalidate(['portfolio']); }
    } catch (e) {
      if (gmailNotSetUp(e)) toast('Gmail is not set up yet', { type: 'info', duration: 9000, action: { label: 'Set up Gmail', onClick: openGmailSettings } });
      else toast(e.message || String(e), { type: e.status === 409 ? 'info' : 'error', duration: 7000 });
    }
    if (mounted.current) setSyncing(false);
  };
  const exportHoldings = () => {
    const rows = [['Ticker', 'Native Currency', 'Shares', 'Avg Cost', 'Last', `Value (${portfolio.display_currency})`, `Gain (${portfolio.display_currency})`, 'Gain %', 'Weight %']];
    portfolio.holdings.forEach(h => rows.push([h.ticker, h.currency, h.shares, h.avg_cost, h.price ?? '', h.value ?? '', h.gain ?? '', h.gain_pct ?? '', h.weight ?? '']));
    const blob = new Blob([rows.map(row => row.join(',')).join('\n')], { type: 'text/csv' });
    const href = URL.createObjectURL(blob); download(href, 'portfolio_holdings.csv'); URL.revokeObjectURL(href);
  };
  const openAdd = () => { setEditTx(null); setShowTx(true); };

  if (!live) return (
    <div className="page pf-page">
      <Header sub="Ledger-backed positions, cash and performance" status={<Badge tone="neutral" dot>Backend offline</Badge>} />
      <Card><EmptyState title="Backend offline" description="Start with scripts/run.sh — the portfolio is read from the local ledger, never from sample data." /></Card>
    </div>
  );
  // A failed first load must show the error, not an endless skeleton.
  if (!portfolio && loadError && !loading) return (
    <div className="page pf-page">
      <Header sub="Ledger-backed positions, cash and performance" />
      <ErrorState card title="Could not load the portfolio." message={loadError} onRetry={loadPortfolio} />
    </div>
  );
  if (loading || !portfolio) return (
    <div className="page pf-page" aria-busy="true">
      <Header sub="Loading the ledger…" />
      <Skeleton height={96} /><Skeleton height={220} />
    </div>
  );
  const currency = portfolio.display_currency;

  return (
    <div className="page pf-page">
      <Header status={<PortfolioStatus portfolio={portfolio} />}
        sub={`${portfolio.holdings.length} positions · Ledger revision ${portfolio.ledger_revision || 0}${portfolio.as_of ? ` · ${formatDateTime(portfolio.as_of)}` : ''}`}
        actions={<>
          <div className="pf-ccy-select" data-tip="Display currency only — native records are unchanged">
            <Select size="sm" value={currency} options={CCY_OPTIONS} onChange={changeCurrency} disabled={!!busy} ariaLabel="Display currency" />
          </div>
          <Button size="sm" icon="download" onClick={() => download(HelixAPI.portfolioStatementUrl())}>Statement</Button>
          <Button size="sm" icon="download" onClick={() => setShowImport(true)}>Import CSV</Button>
          <Button size="sm" icon="sync" loading={syncing} onClick={syncEmail} title="Check Gmail for new SSI trade emails and statements and import them">Sync email</Button>
          <Button size="sm" icon="plus" onClick={() => setShowPaste(true)} disabled={!live || !!busy}
            title={live ? 'Paste trade rows from an SSI trade-report email or PDF' : 'Needs the local backend'}>Paste orders</Button>
          <Button size="sm" variant="primary" icon="plus" onClick={openAdd}>Add transaction</Button>
        </>} />

      {busy && <ProgressBar card title={busy} subtitle={job ? job.type : undefined} value={job ? job.progress : null} status={job ? 'running' : 'queued'} ariaLabel="Portfolio job" />}
      {error && <div className="pf-banner is-neg" role="alert">{error}</div>}
      {portfolio.missing?.length > 0 && <div className="pf-banner is-neg">Incomplete valuation: {portfolio.missing.map(x => x.key).join(', ')}</div>}
      {portfolio.stale?.length > 0 && <div className="pf-banner is-muted">Using last-known data for {portfolio.stale.map(x => x.key).join(', ')}. Values are visibly retained, never generated.</div>}

      <Tabs ariaLabel="Portfolio sections" value={tab} onChange={setTab} tabs={TABS} className="pf-tabs" />

      {tab === 'overview' ? (
        <OverviewPanel portfolio={portfolio} currency={currency} performance={performance} range={range} setRange={setRange}
          chartMode={chartMode} setChartMode={setChartMode} live={live} onAdd={openAdd} onImport={() => setShowImport(true)}
          onSelect={setHistoryTicker} onExport={exportHoldings} />
      ) : tab === 'tickers' ? (
        <TickerPanel live={live} revision={portfolio.projection_revision} holdings={portfolio.holdings} />
      ) : (
        <TransactionsPanel data={transactions} filter={txFilter} setFilter={setTxFilter} query={txQuery} setQuery={setTxQuery}
          onPage={loadTransactions} onAdd={openAdd} onEdit={tx => { setEditTx(tx); setShowTx(true); }} onVoid={voidTransaction}
          onExport={() => download(HelixAPI.portfolioTransactionsExportUrl())} live={live}
          onImportCsv={() => setShowImport(true)} onSyncEmail={syncEmail} syncing={syncing}
          onPaste={() => setShowPaste(true)} onGmailSettings={openGmailSettings} />
      )}

      {historyTicker && <TickerHistoryDialog ticker={historyTicker} revision={portfolio.projection_revision}
        price={portfolio.holdings.find(h => h.ticker === historyTicker)?.price} onClose={() => setHistoryTicker(null)}
        onChart={() => { setActiveAsset(historyTicker); setPage('detail'); }} />}
      {showTx && <TransactionDialog initial={editTx} currency={currency} onClose={() => { setShowTx(false); setEditTx(null); }} onSave={saveTransaction} busy={!!busy} />}
      {showImport && <ImportDialog onClose={() => setShowImport(false)} onCommitted={onImported} />}
      {showPaste && <PasteDialog onClose={() => setShowPaste(false)} onCommitted={onPasted} />}
    </div>
  );
};

export { PagePortfolio };
