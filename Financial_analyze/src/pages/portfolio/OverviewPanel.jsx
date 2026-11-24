// Portfolio › Overview: KPI tiles, performance chart, allocation, cash balances, holdings.

import React from 'react';
import { Donut } from './Donut.jsx';
import { AreaChart, Badge, Button, Card, DataTable, EmptyState, Pill, Segmented, StatGrid, StatTile } from '../../ui';
import { formatPct } from '../../lib/format.js';
import { pfMoney, pfShares } from './pf-utils.js';

// Allocation slices use the chart series tokens, so both themes stay legible.
const SLICE = Array.from({ length: 8 }, (_, i) => `var(--lx-series-${i + 1})`);
const RANGES = [{ value: '1m', label: '1M' }, { value: '3m', label: '3M' }, { value: 'ytd', label: 'YTD' }, { value: '1y', label: '1Y' }, { value: 'all', label: 'All' }];
const MODES = [{ value: 'value', label: 'Value' }, { value: 'twr', label: 'TWR %' }];

const KpiRow = ({ portfolio, currency }) => (
  <StatGrid className="pf-stats">
    <StatTile label="Total value" value={portfolio.total_value} format={v => pfMoney(v, currency)} />
    <StatTile label="Today" value={portfolio.today_change} format={v => pfMoney(v, currency)} delta={portfolio.today_change_pct} deltaLabel="today" />
    <StatTile label="Investment gain" value={portfolio.total_gain} format={v => pfMoney(v, currency)} delta={portfolio.total_gain_pct} deltaLabel="total" />
    <StatTile label="Cash" value={portfolio.cash_value} format={v => pfMoney(v, currency)} />
  </StatGrid>
);

const HoldingsTable = ({ holdings, currency, onSelect, onExport }) => (
  <Card title="Holdings" subtitle={`${holdings.length} position${holdings.length === 1 ? '' : 's'} · click a row for my orders`}
    actions={<Button size="sm" icon="download" onClick={onExport}>Export</Button>} flush>
    <DataTable ariaLabel="Holdings" rows={holdings} rowKey={h => `${h.ticker}-${h.currency}`} onRowClick={h => onSelect(h.ticker)}
      defaultSort={{ key: 'value', dir: 'desc' }}
      empty={<EmptyState size="sm" plain title="No holdings" />}
      columns={[
        { key: 'ticker', label: 'Ticker', render: h => <span className="ticker">{h.ticker}</span> },
        { key: 'currency', label: 'Native' },
        { key: 'shares', label: 'Shares', numeric: true, render: h => pfShares(h.shares) },
        { key: 'avg_cost', label: 'Avg FIFO cost', numeric: true, render: h => pfMoney(h.avg_cost, h.currency) },
        { key: 'price', label: 'Last', numeric: true, render: h => pfMoney(h.price, h.currency) },
        { key: 'value', label: `Value (${currency})`, numeric: true, render: h => pfMoney(h.value, currency) },
        {
          key: 'gain', label: 'Unrealized', numeric: true,
          render: h => (h.gain == null ? '—' : <span className="pf-gain"><span className={h.gain >= 0 ? 'pos' : 'neg'}>{pfMoney(h.gain, currency)}</span><Pill value={h.gain_pct || 0} /></span>),
        },
        { key: 'weight', label: 'Weight', numeric: true, render: h => formatPct(Number(h.weight || 0), { sign: false }) },
      ]} />
  </Card>
);

const OverviewPanel = ({ portfolio, currency, performance, range, setRange, chartMode, setChartMode, live, onAdd, onImport, onSelect, onExport }) => {
  const holdings = portfolio.holdings;
  const segments = holdings.filter(h => h.value > 0).map((h, i) => ({ value: h.value, label: h.ticker, color: SLICE[i % SLICE.length] }));
  const chartData = performance.map(point => (chartMode === 'twr' ? point.twr : point.value));
  const netFlow = performance.reduce((sum, point) => sum + Number(point.net_flow || 0), 0);
  return <>
    <KpiRow portfolio={portfolio} currency={currency} />
    {holdings.length === 0 ? (
      <Card>
        <EmptyState title="Start with the ledger."
          description="Add a deposit and buy, or import a CSV. Empty means empty—no sample positions are mixed into live data."
          action={<div className="pf-actions"><Button variant="primary" icon="plus" disabled={!live} onClick={onAdd}>Add transaction</Button><Button icon="download" disabled={!live} onClick={onImport}>Import CSV</Button></div>} />
      </Card>
    ) : <>
      <Card title="Performance" subtitle="Deposits and withdrawals are excluded from TWR" className="pf-perf"
        actions={<>
          <Segmented size="sm" ariaLabel="Chart value" value={chartMode} onChange={setChartMode} options={MODES} />
          <Segmented size="sm" ariaLabel="Performance range" value={range} onChange={setRange} options={RANGES} />
        </>}
        footer={<span className="pf-perf-foot">Net contributions in range: <b className="num">{pfMoney(netFlow, currency)}</b></span>}>
        <div className="pf-perf-chart">
          {chartData.length > 1
            ? <AreaChart data={chartData} width={1050} height={200} padding={{ t: 10, r: 60, b: 10, l: 0 }} />
            : <EmptyState size="sm" plain title="No performance yet" description="Performance appears after historical prices are available." />}
        </div>
      </Card>

      <div className="pf-grid">
        <Card title="Allocation" subtitle="Verified market value">
          <div className="pf-alloc">
            <Donut segments={segments} size={160} thickness={28} />
            <ul className="pf-legend">
              {holdings.slice(0, 7).map((h, i) => (
                <li key={`${h.ticker}-${h.currency}`}>
                  <i style={{ background: SLICE[i % SLICE.length] }} aria-hidden="true" />
                  <span className="ticker">{h.ticker}</span>
                  <span className="num">{formatPct(Number(h.weight || 0), { decimals: 1, sign: false })}</span>
                </li>
              ))}
            </ul>
          </div>
        </Card>
        <Card title="Cash balances" subtitle="Native and converted">
          {portfolio.cash.length ? (
            <ul className="pf-cash">
              {portfolio.cash.map(row => (
                <li key={row.currency}>
                  <span><span className="ticker">{row.currency}</span>{row.warning && <Badge tone="neg" className="pf-cash-warn">Unreconciled</Badge>}</span>
                  <span className="pf-cash-amt">
                    <span className="num">{pfMoney(row.balance, row.currency)}</span>
                    {row.currency !== currency && <span className="pf-sub num">{pfMoney(row.converted, currency)}</span>}
                  </span>
                </li>
              ))}
            </ul>
          ) : <EmptyState size="sm" plain title="No cash transactions yet." />}
        </Card>
      </div>

      <HoldingsTable holdings={holdings} currency={currency} onSelect={onSelect} onExport={onExport} />
    </>}
  </>;
};

export { OverviewPanel };
