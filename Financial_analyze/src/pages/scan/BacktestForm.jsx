// Backtest setup form: ticker, strategy, period, strategy parameters and trading costs.

import React from 'react';
import { Button, Card, NumberInput, Segmented, Select, TextInput } from '../../ui/index.js';
import { BT_MARKET_DEFAULTS, BT_PERIODS, btMarketOf, btPeriodOf, btYearsAgo } from './backtest-model.js';

const BacktestForm = ({ f, strategies, strategy, live, checking, running, error, onRun, onRetry }) => {
  const defaults = BT_MARKET_DEFAULTS[btMarketOf(f.ticker)];
  const period = btPeriodOf(f.start, f.end);
  const periods = period === 'custom' ? [...BT_PERIODS, { value: 'custom', label: 'Custom' }] : BT_PERIODS;
  const pickPeriod = (v) => { if (v !== 'custom') f.setStart(btYearsAgo(Number(v), new Date(f.end + 'T00:00:00'))); };
  const strategyOpts = strategies.length
    ? strategies.map(s => ({ value: s.id, label: s.name }))
    : [{ value: '', label: live ? 'Loading…' : '—' }];

  const footer = checking ? (
    <span className="scan-hint">Checking backend…</span>
  ) : live ? (
    <>
      <Button variant="primary" icon="trending" loading={running} disabled={!strategy} onClick={onRun}>{running ? 'Running…' : 'Run backtest'}</Button>
      {error && <span className="bt-error" role="alert">{error}</span>}
    </>
  ) : (
    <>
      <span className="scan-hint">Backend offline: start the backend to run backtests.</span>
      <Button size="sm" onClick={onRetry}>Retry</Button>
    </>
  );

  return (
    <Card title="Setup" overflow className="bt-form" footer={<div className="bt-footer">{footer}</div>}>
      <div className="bt-grid">
        <TextInput label="Ticker" value={f.ticker} onChange={v => f.setTicker(v.toUpperCase())} placeholder="VN:VNM or AAPL"
          hint="VN stocks: VN:VNM · US: AAPL" autoComplete="off" spellCheck={false}
          onKeyDown={e => { if (e.key === 'Enter' && live && !running) onRun(); }} />
        <Select size="field" label="Strategy" value={f.strategyId} disabled={!strategies.length} onChange={f.setStrategyId} options={strategyOpts} />
        <TextInput label="Start" type="date" value={f.start} max={f.end} onChange={f.setStart} />
        <TextInput label="End" type="date" value={f.end} min={f.start} onChange={f.setEnd} />
      </div>
      <div className="bt-period">
        <span className="scan-label">Period</span>
        <Segmented ariaLabel="Backtest period" size="sm" value={period} onChange={pickPeriod} options={periods} />
      </div>
      {strategy?.description && <p className="scan-desc">{strategy.description}</p>}

      {strategy?.params?.length > 0 && (
        <div className="bt-grid">
          {strategy.params.map(p => (
            <NumberInput key={p.key} label={p.label} min={p.min} max={p.max} step={p.step || 1}
              value={f.params[p.key] ?? null} onChange={v => f.setParams(prev => ({ ...prev, [p.key]: v }))} />
          ))}
        </div>
      )}

      <div className="bt-grid">
        <TextInput label="Capital" inputMode="decimal" value={f.capital} onChange={f.setCapital} placeholder={defaults.capital}
          suffix={btMarketOf(f.ticker) === 'VN' ? '₫' : '$'} hint="Blank = market default" />
        <TextInput label="Fee %" type="number" min="0" step="0.01" value={f.fee} onChange={f.setFee} placeholder={defaults.fee} suffix="%" />
        <TextInput label="Sell tax %" type="number" min="0" step="0.01" value={f.tax} onChange={f.setTax} placeholder={defaults.tax} suffix="%" />
      </div>
    </Card>
  );
};

export { BacktestForm };
