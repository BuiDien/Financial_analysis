// Portfolio › Transactions: audited ledger with search / type filter, paging, edit / void,
// export, and the import actions (CSV upload, Sync email = Gmail check now, Paste SSI orders).

import React from 'react';
import { Badge, Button, Card, DataTable, EmptyState, SearchInput, Select } from '../../ui';
import { TX_TYPES, pfDate, pfMoney, pfShares } from './pf-utils.js';

const TYPE_OPTIONS = [{ value: '', label: 'All types' }, ...TX_TYPES.map(t => ({ value: t, label: t }))];

const TransactionsPanel = ({ data, filter, setFilter, query, setQuery, onPage, onAdd, onEdit, onVoid, onExport, onImportCsv, onSyncEmail, syncing, onPaste, onGmailSettings, live }) => {
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  return (
    <Card className="pf-tx" title="Transaction ledger" subtitle={`${data.total} audited records`} flush
      actions={<>
        <Button size="sm" icon="download" onClick={onImportCsv} disabled={!live}>Import CSV</Button>
        <Button size="sm" icon="sync" loading={syncing} onClick={onSyncEmail} disabled={!live} title="Check Gmail for new SSI trade emails and statements and import them">Sync email</Button>
        <Button size="sm" variant="ghost" onClick={onGmailSettings}>Gmail settings</Button>
        <Button size="sm" icon="plus" onClick={onPaste} disabled={!live}>Paste orders</Button>
        <Button size="sm" icon="download" onClick={onExport}>Export</Button>
        <Button size="sm" variant="primary" icon="plus" onClick={onAdd}>Add</Button>
      </>}
      footer={(
        <div className="pf-pager">
          <Button size="sm" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>Previous</Button>
          <span className="num">Page {data.page} of {pages}</span>
          <Button size="sm" disabled={data.page * data.page_size >= data.total} onClick={() => onPage(data.page + 1)}>Next</Button>
        </div>
      )}>
      <div className="pf-tx-filters">
        <SearchInput size="sm" value={query} onChange={setQuery} placeholder="Ticker or note…" ariaLabel="Search transactions" />
        <div className="pf-tx-type"><Select size="sm" value={filter} onChange={setFilter} options={TYPE_OPTIONS} ariaLabel="Transaction type" /></div>
      </div>
      <DataTable ariaLabel="Transactions" rows={data.items} rowKey="id" sortable={false}
        empty={<EmptyState size="sm" plain title="No transactions match this filter." />}
        columns={[
          { key: 'effective_at', label: 'Date', className: 'num', render: tx => pfDate(tx.effective_at) },
          { key: 'type', label: 'Type', render: tx => <span className="ticker">{tx.type}</span> },
          { key: 'ticker', label: 'Ticker', render: tx => tx.ticker || '—' },
          { key: 'quantity', label: 'Quantity', numeric: true, render: tx => (tx.quantity == null ? '—' : pfShares(tx.quantity)) },
          { key: 'amount', label: 'Price / cash', numeric: true, render: tx => pfMoney(tx.unit_price ?? tx.cash_amount, tx.currency) },
          { key: 'currency', label: 'Currency' },
          { key: 'source', label: 'Source' },
          { key: 'status', label: 'Status', render: tx => <Badge tone={tx.status === 'active' ? 'pos' : 'neutral'}>{tx.status}</Badge> },
          {
            key: 'actions', label: <span className="sr-only">Actions</span>, align: 'right',
            render: tx => tx.status === 'active' && (
              <span className="pf-row-actions">
                <Button size="sm" variant="ghost" onClick={() => onEdit(tx)}>Edit</Button>
                <Button size="sm" variant="ghost" className="pf-void" onClick={() => onVoid(tx)}>Void</Button>
              </span>
            ),
          },
        ]} />
    </Card>
  );
};

export { TransactionsPanel };
