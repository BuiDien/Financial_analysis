// By ticker — one row per stock: orders, shares bought / received / sold, money in and out,
// dividends, and a method-free net P/L. Click a row for every event. Totals are per currency
// (amounts in different currencies are never summed).

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { Card, EmptyState, ErrorState, SkeletonText, StatGrid, StatTile } from '../../ui';
import { formatNumber } from '../../lib/format.js';
import { cx } from '../../ui/util.js';
import { pfMoney, tkNum } from './pf-utils.js';
import { PL, TickerEvents } from './TickerEvents.jsx';

const TickerRow = ({ t, open, onToggle, multiCcy }) => {
  const m = v => pfMoney(v, t.currency);
  return <>
    <tr onClick={onToggle} className={cx('is-click', t.shares_now <= 0 && 'is-closed')} tabIndex={0} aria-expanded={open}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
      <td><span className="ticker">{open ? '▾' : '▸'} {t.ticker}</span>{multiCcy && <span className="pf-ccy">{t.currency}</span>}</td>
      <td className="right num">{t.orders_buy} / {t.orders_sell}</td>
      <td className="right num">{tkNum(t.shares_bought)}</td>
      <td className={cx('right num', t.shares_received && 'pos')}>{t.shares_received ? '+' + tkNum(t.shares_received) : '—'}</td>
      <td className="right num">{tkNum(t.shares_sold)}</td>
      <td className="right num pf-strong">{tkNum(t.shares_now)}</td>
      <td className="right num">{m(t.paid)}</td>
      <td className="right num">{m(t.received)}</td>
      <td className="right num">{t.dividends ? m(t.dividends) : '—'}</td>
      <td className="right num">{t.shares_now > 0 ? m(t.value) : '—'}</td>
      <td className="right"><PL value={t.net} pct={t.net_pct} currency={t.currency} /></td>
      <td className="right">{t.orders_sell ? <PL value={t.realized_fifo} currency={t.currency} /> : '—'}</td>
    </tr>
    {open && <tr className="pf-expand"><td colSpan={12}><TickerEvents t={t} /></td></tr>}
  </>;
};

const TickerPanel = ({ live, revision, holdings }) => {
  const [data, setData] = React.useState(null);
  const [error, setError] = React.useState('');
  const [open, setOpen] = React.useState(null);
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    if (!live) return undefined;
    let alive = true;
    setError('');
    HelixAPI.portfolioTickers().then(d => { if (alive) setData(d); }).catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [live, revision, reload]);
  if (!live) return <Card><EmptyState size="sm" plain title="Backend offline" description="Connect the backend to see the per-ticker breakdown." /></Card>;
  if (error) return <ErrorState card title="Could not load tickers" message={error} onRetry={() => { setReload(n => n + 1); return Promise.resolve(); }} />;
  if (!data) return <Card><SkeletonText lines={5} /></Card>;

  // Holding prices are native-currency; match on ticker + currency.
  const price = Object.fromEntries((holdings || []).map(h => [`${h.ticker}|${h.currency}`, h.price]));
  const rows = data.tickers.map(t => {
    const px = price[`${t.ticker}|${t.currency}`];
    const value = t.shares_now > 0 ? (px != null ? px * t.shares_now : null) : 0;
    const net = value == null ? null : t.received + t.dividends + value - t.paid;
    return { ...t, value, net, net_pct: net != null && t.paid ? net / t.paid * 100 : null };
  });
  const totals = {};
  rows.forEach(r => {
    const c = r.currency || 'VND';
    const a = totals[c] || (totals[c] = { paid: 0, received: 0, dividends: 0, value: 0, net: 0, orders: 0, missing: false });
    a.paid += r.paid; a.received += r.received; a.dividends += r.dividends;
    a.value += r.value || 0; a.net += r.net || 0; a.orders += r.orders_buy + r.orders_sell;
    if (r.net == null) a.missing = true;
  });
  const ccys = Object.keys(totals).sort();
  const single = ccys.length === 1 ? totals[ccys[0]] : null;
  const perCcy = (fn) => (ccys.length ? ccys.map(c => fn(totals[c], c)).join(' · ') : '—');
  const totalOrders = rows.reduce((s, r) => s + r.orders_buy + r.orders_sell, 0);

  return <>
    <StatGrid className="pf-stats">
      <StatTile label="Net P/L, all tickers" value={perCcy((a, c) => pfMoney(a.net, c))}
        delta={single && single.paid && !single.missing ? single.net / single.paid * 100 : undefined} />
      <StatTile label="Paid for shares" value={perCcy((a, c) => pfMoney(a.paid, c))} />
      <StatTile label="Received (sells + dividends)" value={perCcy((a, c) => pfMoney(a.received + a.dividends, c))} />
      <StatTile label="Orders" value={formatNumber(totalOrders)} />
    </StatGrid>
    {Object.values(totals).some(a => a.missing) && (
      <div className="pf-banner is-muted">Some open positions have no current price, so their value and net P/L are left out of the totals.</div>
    )}
    <Card title="By ticker" flush
      subtitle="Net P/L = money from sells + dividends + value now − money paid (fees & taxes included). Same result for FIFO or average. Click a ticker for every order and share event.">
      <div className="pf-scroll">
        <table className="table pf-table">
          <thead><tr>
            <th>Ticker</th><th className="right">Orders<span className="pf-th-sub">buy / sell</span></th>
            <th className="right">Bought</th><th className="right">Received<span className="pf-th-sub">bonus / rights</span></th><th className="right">Sold</th><th className="right">Hold now</th>
            <th className="right">Paid</th><th className="right">From sells</th><th className="right">Dividends</th><th className="right">Value now</th>
            <th className="right">Net P/L</th><th className="right">FIFO realized</th>
          </tr></thead>
          <tbody>{rows.map(t => (
            <TickerRow key={`${t.ticker}|${t.currency}`} t={t} multiCcy={ccys.length > 1}
              open={open === t.ticker} onToggle={() => setOpen(open === t.ticker ? null : t.ticker)} />
          ))}</tbody>
          <tfoot>{ccys.map(c => { const a = totals[c]; return (
            <tr key={c} className="pf-total">
              <td>Total{ccys.length > 1 ? ` · ${c}` : ''}</td><td className="right num">{a.orders}</td><td colSpan={4}></td>
              <td className="right num">{pfMoney(a.paid, c)}</td><td className="right num">{pfMoney(a.received, c)}</td>
              <td className="right num">{pfMoney(a.dividends, c)}</td><td className="right num">{pfMoney(a.value, c)}</td>
              <td className="right"><PL value={a.net} currency={c} /></td><td></td>
            </tr>
          ); })}</tfoot>
        </table>
      </div>
    </Card>
  </>;
};

export { TickerPanel };
