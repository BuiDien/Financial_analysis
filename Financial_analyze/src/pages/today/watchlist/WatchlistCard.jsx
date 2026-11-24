// Active watchlist card: list switcher (Tabs), new / export / rename / delete,
// the add-symbol field and the quote table.

import React from 'react';
import { Card, DataTable, EmptyState, IconButton, Pill, Tabs, askConfirm, askPrompt, toast } from '../../../ui';
import { formatNumber, formatPrice } from '../../../lib/format.js';
import { useWatchlists } from '../../../watchlist-store.jsx';
import { AddSymbol } from './AddSymbol.jsx';

const lastText = (r) => (r.status === 'loading' ? '…' : r.currency === 'VND' ? formatPrice(r.price, 'VND') : formatNumber(r.price, 2));

const WatchlistCard = ({ rows, onSelect, onExport }) => {
  const store = useWatchlists();
  const lists = store.getLists();
  const active = store.getActive();

  const createList = async () => {
    const n = await askPrompt({ title: 'New watchlist', label: 'Name', placeholder: 'e.g. Banks', confirmText: 'Create' });
    if (n) { store.create(n); toast(`Created "${n}"`, { type: 'success' }); }
  };
  const renameList = async () => {
    const name = await askPrompt({ title: 'Rename watchlist', label: 'Name', value: active.name, confirmText: 'Rename' });
    if (name) { store.rename(active.id, name); toast('Watchlist renamed', { type: 'info' }); }
  };
  const deleteList = async () => {
    if (lists.length <= 1) { toast('Keep at least one watchlist', { type: 'error' }); return; }
    if (await askConfirm({ title: 'Delete watchlist', message: `Delete "${active.name}"? This can't be undone.`, confirmText: 'Delete', danger: true })) {
      store.remove(active.id);
      toast('Watchlist deleted', { type: 'info' });
    }
  };

  const columns = [
    { key: 'sym', label: 'Ticker', render: r => <span className="ticker">{r.sym}</span> },
    { key: 'name', label: 'Name', className: 'wl-name', render: r => r.name },
    { key: 'price', label: 'Last', numeric: true, render: lastText },
    { key: 'chg', label: 'Change', numeric: true, render: r => <Pill value={r.chg} /> },
    { key: 'mcap', label: 'Mkt cap', numeric: true, sortable: false, className: 'wl-muted', render: r => r.mcap || '—' },
    {
      key: 'x', label: <span className="sr-only">Remove</span>, sortable: false, width: 40, align: 'right',
      render: r => (
        <IconButton className="wl-remove-btn" icon="close" size="sm" variant="ghost" label={`Remove ${r.sym}`}
          onClick={(e) => { e.stopPropagation(); store.removeSymbol(active.id, r.sym); }}
          onKeyDown={(e) => e.stopPropagation()} />
      ),
    },
  ];

  return (
    <Card className="wl-card" overflow flush>
      <div className="wl-toolbar">
        <Tabs size="sm" ariaLabel="Watchlists" value={active.id} onChange={(id) => store.setActive(id)}
          tabs={lists.map(l => ({ value: l.id, label: l.name, badge: l.symbols.length || null }))} />
        <div className="wl-actions">
          <IconButton icon="plus" size="sm" label="New watchlist" onClick={createList} />
          {onExport && <IconButton icon="download" size="sm" label="Export CSV" onClick={onExport} />}
          <IconButton icon="settings" size="sm" label="Rename list" onClick={renameList} />
          <IconButton icon="close" size="sm" label="Delete list" onClick={deleteList} />
        </div>
      </div>
      <div className="wl-add-row"><AddSymbol onAdd={(s) => store.addSymbol(active.id, s)} existing={active.symbols} /></div>
      <DataTable ariaLabel={`Watchlist ${active.name}`} rows={rows} rowKey="sym" columns={columns} dense
        onRowClick={(r) => onSelect && onSelect(r.sym)}
        empty={<EmptyState plain title="No symbols yet" description="Add one with the field above." />} />
    </Card>
  );
};

export { WatchlistCard };
