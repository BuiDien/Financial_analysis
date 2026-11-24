// Backtest — replay a long-only strategy on past daily bars and compare it to
// buy-and-hold. Live backend only (no mock data): POST /api/backtest/run.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { EmptyState } from '../../ui/index.js';
import { btDefaultStart, btIsoDate, btOptNumber } from './backtest-model.js';
import { BacktestForm } from './BacktestForm.jsx';
import { BacktestResults } from './BacktestResults.jsx';
import './scan.css';

const PageBacktest = () => {
  const api = HelixAPI;
  const [live, setLive] = React.useState(!!api?.live);
  const [checking, setChecking] = React.useState(!!api && !api.checked);
  const [strategies, setStrategies] = React.useState([]);
  const [strategyId, setStrategyId] = React.useState('');
  const [params, setParams] = React.useState({});
  const [ticker, setTicker] = React.useState('VN:VNM');
  const [start, setStart] = React.useState(btDefaultStart);
  const [end, setEnd] = React.useState(() => btIsoDate(new Date()));
  const [capital, setCapital] = React.useState('');
  const [fee, setFee] = React.useState('');
  const [tax, setTax] = React.useState('');
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState('');
  const [result, setResult] = React.useState(null);
  const [runId, setRunId] = React.useState(0);

  const connect = React.useCallback(async (force = false) => {
    if (!api) { setLive(false); setChecking(false); return; }
    setChecking(true);
    try { if (force || !api.checked) await api.detect(); } catch {}
    setLive(!!api.live);
    setChecking(false);
  }, [api]);

  React.useEffect(() => { connect(); }, [connect]);

  // Load the strategy catalogue once the backend is reachable.
  React.useEffect(() => {
    if (!live) return;
    let cancelled = false;
    api.backtestStrategies()
      .then(list => {
        if (cancelled || !Array.isArray(list)) return;
        setStrategies(list);
        const initial = list.find(s => s.id === 'sma_cross') || list[0];
        if (initial) setStrategyId(id => id || initial.id);
      })
      .catch(e => { if (!cancelled) setError(e.message || String(e)); });
    return () => { cancelled = true; };
  }, [live]);

  const strategy = strategies.find(s => s.id === strategyId) || null;

  // Reset params to the strategy's defaults whenever the strategy changes.
  React.useEffect(() => {
    if (!strategy) return;
    setParams(Object.fromEntries((strategy.params || []).map(p => [p.key, p.default])));
  }, [strategyId, strategies.length]);

  const run = async () => {
    setError('');
    const t = ticker.trim().toUpperCase();
    if (!t) { setError('Enter a ticker.'); return; }
    if (!strategy) { setError('Choose a strategy.'); return; }
    const numParams = {};
    for (const p of strategy.params || []) {
      const n = Number(params[p.key]);
      if (params[p.key] === '' || params[p.key] == null || !Number.isFinite(n)) { setError(`${p.label} must be a number.`); return; }
      numParams[p.key] = n;
    }
    const body = {
      ticker: t, strategy: strategy.id, params: numParams, start, end,
      initial_capital: btOptNumber(capital), fee_pct: btOptNumber(fee), sell_tax_pct: btOptNumber(tax),
    };
    for (const [k, label] of [['initial_capital', 'Capital'], ['fee_pct', 'Fee %'], ['sell_tax_pct', 'Sell tax %']]) {
      if (Number.isNaN(body[k])) { setError(`${label} must be a number.`); return; }
    }
    setRunning(true);
    try {
      const res = await api.backtestRun(body);
      setResult(res);
      setRunId(n => n + 1);
    } catch (e) {
      setError(e.message || String(e));
    }
    setRunning(false);
  };

  const form = { ticker, setTicker, strategyId, setStrategyId, start, setStart, end, setEnd, params, setParams, capital, setCapital, fee, setFee, tax, setTax };

  return (
    <div className="page scan-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Backtest</h1>
          <p className="page-sub">Replay a strategy on past daily prices and compare it to buy-and-hold. Signals decide at the close and fill at the next open.</p>
        </div>
      </header>

      <BacktestForm f={form} strategies={strategies} strategy={strategy} live={live} checking={checking}
        running={running} error={error} onRun={run} onRetry={() => connect(true)} />

      {result ? <BacktestResults result={result} runId={runId} /> : !checking && (
        <div className="card bt-empty">
          {live
            ? <EmptyState size="sm" title="No backtest yet" description="Pick a ticker and a strategy, then press Run backtest. Results, the equity curve and every trade show up here." />
            : <EmptyState size="sm" title="Backend offline" description="Backtests replay real price history from the local backend. Start it with scripts/run.sh, then press Retry above." />}
        </div>
      )}
    </div>
  );
};

export { PageBacktest };
