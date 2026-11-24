// Backtest results: headline metrics vs buy-and-hold, equity curve, price chart with fills
// and the trade list.

import React from 'react';
import { Badge, Card, DataTable, EmptyState, StatGrid, StatTile } from '../../ui/index.js';
import { LWChart } from '../../lwchart.jsx';
import { formatNumber, isNum } from '../../lib/format.js';
import { btMoney, btNum, btPct, btSettingsNote, btSign, btTime } from './backtest-model.js';

const diff = (a, b) => (isNum(a) && isNum(b) ? Number(a) - Number(b) : undefined);
const pts = (d) => `${formatNumber(Math.abs(d), 2)} pts`;

const Metric = ({ label, value, bench, delta, deltaLabel }) => (
  <StatTile label={label} value={value} delta={delta} deltaLabel={deltaLabel} deltaFormat={pts}>
    {bench !== undefined && <div className="bt-bench">Buy &amp; hold: <span className="num">{bench}</span></div>}
  </StatTile>
);

const tradeColumns = (ccy, scale) => [
  { key: 'entry_date', label: 'Entry date', className: 'num' },
  { key: 'entry_price', label: 'Entry price', numeric: true, render: t => btMoney(t.entry_price == null ? null : t.entry_price * scale, ccy) },
  { key: 'exit_date', label: 'Exit date', className: 'num', sortValue: t => (t.open ? '9999' : t.exit_date),
    render: t => (t.open ? <Badge tone="info">open</Badge> : (t.exit_date || '—')) },
  { key: 'exit_price', label: 'Exit price', numeric: true, render: t => btMoney(t.exit_price == null ? null : t.exit_price * scale, ccy) },
  { key: 'shares', label: 'Shares', numeric: true, render: t => formatNumber(t.shares) },
  { key: 'bars_held', label: 'Sessions held', numeric: true, render: t => formatNumber(t.bars_held) },
  { key: 'pnl', label: 'P/L', numeric: true, render: t => <span className={btSign(t.pnl)}>{btMoney(t.pnl, ccy)}</span> },
  { key: 'return_pct', label: 'Return %', numeric: true, render: t => <span className={btSign(t.return_pct)}>{btPct(t.return_pct)}</span> },
];

const BacktestResults = ({ result, runId }) => {
  // Chart inputs — memoized so LWChart only re-pushes data on a new run.
  const scale = Number(result?.settings?.price_scale) || 1;
  const equityLines = React.useMemo(() => {
    const toLine = rows => (rows || []).map(r => ({ time: btTime(r.date), value: Number(r.value) })).filter(p => Number.isFinite(p.time) && Number.isFinite(p.value));
    return [
      { data: toLine(result.equity), color: 'var(--accent)', title: 'Strategy' },
      { data: toLine(result.benchmark_equity), color: 'var(--text-muted)', title: 'Buy & hold' },
    ];
  }, [result]);
  const bars = React.useMemo(() => (result.bars || []).map(b => ({
    time: btTime(b.date), open: b.open * scale, high: b.high * scale, low: b.low * scale, close: b.close * scale, volume: b.volume,
  })), [result, scale]);
  const markers = React.useMemo(() => {
    const out = [];
    for (const t of result.trades || []) {
      out.push({ time: btTime(t.entry_date), kind: 'BUY', quantity: t.shares });
      if (!t.open && t.exit_date) out.push({ time: btTime(t.exit_date), kind: 'SELL', quantity: t.shares });
    }
    return out;
  }, [result]);
  const emptyData = React.useMemo(() => [], []);

  const ccy = result.currency || 'USD';
  const m = result.metrics || {};
  const b = result.benchmark_metrics || {};
  const trades = result.trades || [];
  const openCount = trades.filter(t => t.open).length;

  return (
    <div className="bt-results">
      <div className="bt-summary">
        <span className="ticker">{result.ticker}</span>
        <span>{result.strategy?.name} · {result.start} → {result.end} · capital {btMoney(result.settings?.initial_capital, ccy)}</span>
        <span className="scan-hint">{btSettingsNote(result.ticker, result.settings)}</span>
      </div>

      <StatGrid className="bt-stats">
        <Metric label="Total return" value={btPct(m.total_return_pct)} bench={btPct(b.total_return_pct)}
          delta={diff(m.total_return_pct, b.total_return_pct)} deltaLabel="vs buy & hold" />
        <Metric label="CAGR" value={btPct(m.cagr_pct)} bench={btPct(b.cagr_pct)}
          delta={diff(m.cagr_pct, b.cagr_pct)} deltaLabel="vs buy & hold" />
        <Metric label="Max drawdown" value={btPct(m.max_drawdown_pct)} bench={btPct(b.max_drawdown_pct)} />
        <Metric label="Sharpe" value={btNum(m.sharpe)} bench={btNum(b.sharpe)} />
      </StatGrid>
      <StatGrid className="bt-stats">
        <Metric label="Trades" value={formatNumber(m.trades)} />
        <Metric label="Win rate" value={btPct(m.win_rate_pct, false)} />
        <Metric label="Exposure" value={btPct(m.exposure_pct, false)} />
        <Metric label="Final equity" value={btMoney(m.final_equity, ccy)} bench={btMoney(b.final_equity, ccy)} />
      </StatGrid>

      <Card title="Equity" actions={
        <div className="bt-legend">
          <span><i className="bt-swatch is-strategy" />Strategy</span>
          <span><i className="bt-swatch is-bench" />Buy &amp; hold</span>
        </div>}>
        <LWChart key={`eq-${runId}`} type="area" volume={false} height={300} range="1D" data={emptyData} lines={equityLines} />
      </Card>

      <Card title="Price & trades" actions={<span className="scan-hint">B = buy fill · S = sell fill</span>}>
        {bars.length > 1
          ? <LWChart key={`px-${runId}`} type="candle" height={380} range="1D" volume={true} data={bars} markers={markers} />
          : <EmptyState plain title="No price bars in range" />}
      </Card>

      <Card flush title="Trades" subtitle={`${trades.length - openCount} closed${openCount ? ` · ${openCount} open` : ''}`}
        footer={Number(result.skipped_buys) > 0 ? (
          <span className="scan-hint">{formatNumber(result.skipped_buys)} buy signals could not be filled — capital is below the cost of one lot (lot × price).</span>
        ) : undefined}>
        <DataTable ariaLabel="Backtest trades" rows={trades} rowKey="entry_date" columns={tradeColumns(ccy, scale)}
          dense maxHeight={480} empty={<EmptyState plain title="No trades in this period" />} />
      </Card>
    </div>
  );
};

export { BacktestResults };
