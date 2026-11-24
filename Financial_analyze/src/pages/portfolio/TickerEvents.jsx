// Every order and share event for one ticker (By-ticker tab and the holdings popup), plus the
// popup itself. Amounts are in the ticker's own currency; SELL rows expand to their FIFO lots.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { Button, Dialog, EmptyState, Pill, SkeletonText } from '../../ui';
import { cx } from '../../ui/util.js';
import { pfDate, pfMoney, tkNum } from './pf-utils.js';

const EVENT_STYLE = {
  BUY: { label: 'Buy', tone: 'is-buy' },
  SELL: { label: 'Sell', tone: 'is-sell' },
  BONUS: { label: 'Bonus / stock dividend', tone: 'is-recv' },
  RIGHTS: { label: 'Rights issue', tone: 'is-recv' },
  DIVIDEND: { label: 'Cash dividend', tone: 'is-recv' },
};

// P/L amount (pos/neg coloured) with an optional % pill underneath.
const PL = ({ value, pct, currency }) => (value == null ? '—' : (
  <>
    <span className={cx('num', value >= 0 ? 'pos' : 'neg')}>{pfMoney(value, currency)}</span>
    {pct != null && <div><Pill value={pct} /></div>}
  </>
));

const TickerEvents = ({ t }) => {
  const [openEvent, setOpenEvent] = React.useState(null);
  const c = t.currency;
  const m = v => pfMoney(v, c);
  return <>
    <p className="pf-ev-summary">
      <strong>{t.ticker}</strong>: {t.orders_buy} buy orders ({tkNum(t.shares_bought)} shares) · {t.orders_sell} sell orders ({tkNum(t.shares_sold)} shares)
      {t.shares_received ? <> · <span className="pos">received {tkNum(t.shares_received)} shares</span> (bonus, stock dividends, rights)</> : null}
      {' '}· holding {tkNum(t.shares_now)} · FIFO cost of holding {m(t.open_cost)} · fees {m(t.fees)} · taxes {m(t.taxes)}
    </p>
    <div className="pf-scroll">
      <table className="table pf-table pf-ev-table">
        <thead><tr><th>Date</th><th>Event</th><th className="right">Shares</th><th className="right">Price</th><th className="right">Cash</th><th className="right">Fee + tax</th><th className="right">Shares after</th><th className="right">FIFO P/L</th></tr></thead>
        <tbody>{t.events.map(e => {
          const st = EVENT_STYLE[e.kind] || { label: e.kind };
          const expandable = e.kind === 'SELL' && e.lots?.length;
          const open = openEvent === e.id;
          const toggle = () => expandable && setOpenEvent(open ? null : e.id);
          return <React.Fragment key={e.id}>
            <tr onClick={toggle} className={cx(expandable && 'is-click')} title={e.note || ''}
              tabIndex={expandable ? 0 : undefined} aria-expanded={expandable ? open : undefined}
              onKeyDown={expandable ? (ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); } }) : undefined}>
              <td className="num">{pfDate(e.date)}</td>
              <td className={cx('pf-ev-kind', st.tone)}>{expandable ? (open ? '▾ ' : '▸ ') : ''}{st.label}{e.source === 'ssi_statement' ? <span className="pf-ev-src"> · from monthly statement</span> : null}</td>
              <td className="right num">{e.quantity != null ? (e.kind === 'SELL' ? '−' : '+') + tkNum(e.quantity) : '—'}</td>
              <td className="right num">{e.price ? m(e.price) : (e.kind === 'BONUS' ? 'free' : '—')}</td>
              <td className="right num"><span className={e.amount >= 0 ? 'pos' : ''}>{e.amount ? m(e.amount) : '—'}</span></td>
              <td className="right num">{e.fees + e.taxes ? m(e.fees + e.taxes) : '—'}</td>
              <td className="right num">{e.kind === 'DIVIDEND' ? '' : tkNum(e.shares_after)}</td>
              <td className="right">{e.kind === 'SELL' ? <PL value={e.fifo_gain} currency={c} /> : ''}</td>
            </tr>
            {open && e.lots.map((l, i) => (
              <tr key={i} className="pf-ev-lot">
                <td></td>
                <td colSpan={2}>↳ from lot bought {pfDate(l.buy_date)}</td>
                <td className="right num">{tkNum(l.quantity)} × {l.unit_cost ? m(l.unit_cost) : 'free'}</td>
                <td className="right num">cost {m(l.cost)}</td>
                <td colSpan={3}></td>
              </tr>
            ))}
          </React.Fragment>;
        })}</tbody>
      </table>
    </div>
  </>;
};

// Popup opened from the Overview holdings table.
const TickerHistoryDialog = ({ ticker, revision, price, onClose, onChart }) => {
  const [t, setT] = React.useState(null);
  const [error, setError] = React.useState('');
  React.useEffect(() => {
    HelixAPI.portfolioTickers().then(d => {
      const row = d.tickers.find(x => x.ticker === ticker);
      row ? setT(row) : setError(`No trades recorded for ${ticker}.`);
    }).catch(e => setError(e.message));
  }, [ticker, revision]);
  const value = t && price != null ? price * t.shares_now : null;
  const net = t && value != null ? t.received + t.dividends + value - t.paid : null;
  return (
    <Dialog open onClose={onClose} size="lg" className="pf-dialog-xl" title={`${ticker} · my orders`}
      description={t ? `Paid ${pfMoney(t.paid, t.currency)} · from sells ${pfMoney(t.received, t.currency)} · dividends ${pfMoney(t.dividends, t.currency)} · value now ${pfMoney(value, t.currency)}` : undefined}
      actions={<>
        {net != null && <span className="pf-net">Net P/L <PL value={net} pct={t.paid ? net / t.paid * 100 : null} currency={t.currency} /></span>}
        <Button onClick={onChart} icon="chart">Open chart</Button>
        <Button variant="primary" onClick={onClose}>Close</Button>
      </>}>
      {error ? <EmptyState size="sm" plain title={error} /> : !t ? <SkeletonText lines={5} /> : <TickerEvents t={t} />}
    </Dialog>
  );
};

export { TickerEvents, TickerHistoryDialog, PL };
