// Active watchlist (switcher + add/remove) with top movers, from live quotes only.

import React from 'react';
import { useApiLive } from '../../../api-client.jsx';
import { Card, EmptyState, Pill, toast } from '../../../ui';
import { isNum } from '../../../lib/format.js';
import { quoteFor, useQuotes, useWatchlists } from '../../../watchlist-store.jsx';
import { WatchlistCard } from './WatchlistCard.jsx';
import '../shared.css';
import './watchlist.css';

const MoversCard = ({ title, listName, rows, live, hasQuotes, emptyText }) => (
  <Card title={title} actions={<span className="wl-muted wl-small">{listName}</span>}>
    {rows.length === 0 ? <EmptyState plain className="td-quiet" title={hasQuotes ? emptyText : live ? 'No quotes yet' : 'Backend offline'} /> : (
      <ul className="wl-movers">
        {rows.map(r => (
          <li key={r.sym}>
            <span className="ticker">{r.sym}</span>
            <span className="wl-movers-name">{r.name}</span>
            <Pill value={r.chg} />
          </li>
        ))}
      </ul>
    )}
  </Card>
);

const downloadCsv = (quoted) => {
  const lines = [['Ticker', 'Name', 'Price', 'Change %', 'Market Cap'].join(',')];
  quoted.forEach(w => {
    const csvName = String(w.name || '').replaceAll('"', '""');
    lines.push([w.sym, `"${csvName}"`, w.price, w.chg, `"${w.mcap || ''}"`].join(','));
  });
  if (lines.length === 1) { toast('No quotes to export yet', { type: 'info' }); return; }
  const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = 'watchlist.csv'; a.click();
  URL.revokeObjectURL(url);
  toast('Exported watchlist', { type: 'success' });
};

const WatchlistSection = ({ setPage, setActiveAsset }) => {
  const store = useWatchlists();
  const { live } = useApiLive();
  const active = store.getActive();
  useQuotes(active.symbols, live);
  const rows = active.symbols.map(sym => quoteFor(sym));
  // Movers and the CSV only use rows with a real price + change.
  const quoted = rows.filter(r => isNum(r.price) && isNum(r.chg));
  const gainers = quoted.filter(r => r.chg > 0).sort((a, b) => b.chg - a.chg).slice(0, 5);
  const losers = quoted.filter(r => r.chg < 0).sort((a, b) => a.chg - b.chg).slice(0, 5);

  return (
    <div className="wl-section">
      <WatchlistCard rows={rows} onSelect={(sym) => { setActiveAsset(sym); setPage('detail'); }} onExport={() => downloadCsv(quoted)} />
      <div className="wl-movers-col">
        <MoversCard title="Top gainers" listName={active.name} rows={gainers} live={live} hasQuotes={quoted.length > 0} emptyText="Nothing up today" />
        <MoversCard title="Top losers" listName={active.name} rows={losers} live={live} hasQuotes={quoted.length > 0} emptyText="Nothing down today" />
      </div>
    </div>
  );
};

export { WatchlistSection };
