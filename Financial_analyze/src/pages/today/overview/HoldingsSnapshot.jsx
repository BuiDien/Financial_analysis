// Holdings snapshot: totals plus the five largest positions.

import React from 'react';
import { Button, Card, ChangeText, DataTable, StatTile } from '../../../ui';
import { formatMoney, formatPct, formatPrice, isNum } from '../../../lib/format.js';
import { mapPortfolio, usePortfolioRaw } from '../../../lib/data.js';
import { SectionStatus } from './SectionStatus.jsx';

const HoldingsSnapshot = ({ setPage, setActiveAsset }) => {
  const q = usePortfolioRaw();
  const pf = q.data ? mapPortfolio(q.data) : null;
  const ccy = pf?.displayCurrency || 'VND';
  const top = pf ? [...pf.holdings].sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 5) : [];
  const open = (h) => { setActiveAsset(h.currency === 'VND' ? `VN:${h.sym}` : h.sym); setPage('detail'); };

  const columns = [
    { key: 'sym', label: 'Ticker', render: h => <span className="ticker">{h.sym}</span> },
    { key: 'price', label: 'Price', numeric: true, render: h => formatPrice(h.price, h.currency) },
    { key: 'weight', label: 'Weight', numeric: true, render: h => (isNum(h.weight) ? formatPct(h.weight, { decimals: 1, sign: false }) : '—') },
    { key: 'gainPct', label: 'Gain', numeric: true, render: h => <ChangeText value={h.gainPct} /> },
  ];

  return (
    <Card title="Holdings" className="td-card"
      actions={<Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => setPage('#/portfolio')}>Portfolio</Button>}
      flush={!!pf}>
      {!pf ? <SectionStatus live={q.live} q={q} emptyText="No portfolio yet." /> : (
        <>
          <div className="td-hold-stats">
            <StatTile size="sm" label="Total value" value={formatMoney(pf.totalValue, ccy)} />
            <StatTile size="sm" label="Today" value={formatMoney(pf.dayChange, ccy, { sign: true })} delta={pf.dayChangePct} />
            <StatTile size="sm" label="Gain" value={formatMoney(pf.totalGain, ccy, { sign: true })} delta={pf.totalGainPct} />
          </div>
          <DataTable ariaLabel="Largest positions" dense rows={top} rowKey={h => `${h.sym}-${h.currency}`}
            columns={columns} sortable={false} onRowClick={open} empty="No positions yet." />
        </>
      )}
    </Card>
  );
};

export { HoldingsSnapshot };
