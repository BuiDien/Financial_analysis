// Paste SSI orders: text copied from a "Thông báo kết quả giao dịch" email/PDF → server parse
// (arithmetic-verified, never guessed) → preview with ledger-duplicate flags → add the checked
// rows. The commit sends the text again and the server re-parses it; only row keys come from here.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { Badge, Button, Checkbox, DataTable, Dialog, EmptyState } from '../../ui';
import { formatDate, formatMoney, formatNumber } from '../../lib/format.js';
import { pasteRowId, pasteRowStatus } from './pf-utils.js';

const EXAMPLE = '1  06/11/2026  10/11/2026  Mua  VCB  200  53,600  10,720,000  16,080  10,736,080';

const PasteDialog = ({ onClose, onCommitted }) => {
  const [text, setText] = React.useState('');
  const [preview, setPreview] = React.useState(null);
  const [selected, setSelected] = React.useState(() => new Set());
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  const runPreview = async () => {
    if (!text.trim()) return;
    setBusy(true); setError('');
    try {
      const p = await HelixAPI.portfolioPastePreview(text);
      setPreview(p);
      setSelected(new Set(p.trades.filter(t => !t.duplicate).map(t => t.key)));
    } catch (e) { setError(e.message || String(e)); }
    setBusy(false);
  };
  const commit = async () => {
    setBusy(true); setError('');
    try { onCommitted(await HelixAPI.portfolioPasteCommit(text, [...selected])); }
    catch (e) { setError(e.message || String(e)); setBusy(false); }
  };
  const back = () => { setPreview(null); setError(''); };
  const toggle = (key, on) => setSelected(s => { const n = new Set(s); if (on) n.add(key); else n.delete(key); return n; });

  const addable = preview ? preview.trades.filter(t => !t.duplicate) : [];
  const n = selected.size;
  const allOn = addable.length > 0 && addable.every(t => selected.has(t.key));
  const columns = [
    {
      key: 'pick', sortable: false,
      label: <Checkbox aria-label="Select all new trades" checked={allOn} indeterminate={n > 0 && !allOn}
        disabled={!addable.length || busy}
        onChange={on => setSelected(new Set(on ? addable.map(t => t.key) : []))} />,
      render: t => <Checkbox aria-label={`Add row ${t.no} ${t.ticker}`} checked={selected.has(t.key)}
        disabled={t.duplicate || busy} onChange={on => toggle(t.key, on)} />,
    },
    { key: 'trade_date', label: 'Date', className: 'num', render: t => formatDate(t.trade_date) },
    { key: 'side', label: 'Side', render: t => <Badge tone={t.side === 'BUY' ? 'pos' : 'neg'}>{t.side === 'BUY' ? 'Buy' : 'Sell'}</Badge> },
    { key: 'ticker', label: 'Ticker', render: t => <span className="ticker">{t.ticker}</span> },
    { key: 'quantity', label: 'Qty', numeric: true, render: t => formatNumber(t.quantity) },
    { key: 'price', label: 'Price', numeric: true, render: t => formatMoney(t.price, 'VND') },
    { key: 'fee', label: 'Fee', numeric: true, render: t => formatMoney(t.fee, 'VND') },
    { key: 'taxes', label: 'Tax', numeric: true, render: t => formatMoney(t.taxes, 'VND') },
    { key: 'amount', label: 'Amount', numeric: true, render: t => formatMoney(t.amount, 'VND') },
    {
      key: 'status', label: 'Status', sortable: false,
      render: t => {
        const s = pasteRowStatus(t);
        return <span className="pf-paste-status"><Badge tone={s.tone} dot>{s.label}</Badge>{s.hint && <span className="pf-paste-sim">{s.hint}</span>}</span>;
      },
    },
  ];
  const repeated = preview ? preview.trades.filter(t => t.duplicate_reason === 'repeated in pasted text').length : 0;
  const dupes = preview ? preview.trades.length - addable.length - repeated : 0;

  return (
    <Dialog open onClose={onClose} size={preview ? 'xl' : 'lg'} busy={busy} className="pf-paste"
      title="Paste SSI orders"
      description={preview
        ? `${preview.account ? `Account ${preview.account}` : 'No account number in the text'} · ${preview.trades.length} rows read · ${dupes} already in ledger${repeated ? ` · ${repeated} repeated` : ''} · ${preview.errors.length} ${preview.errors.length === 1 ? 'error' : 'errors'}`
        : 'Copy the rows of an SSI “Thông báo kết quả giao dịch” email or PDF and paste them here. Every row is checked (qty × price, fees, taxes) before it can be added.'}
      actions={preview ? <>
        <Button onClick={back} disabled={busy}>Edit text</Button>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!n} onClick={commit}>
          {`Add ${n} ${n === 1 ? 'trade' : 'trades'}`}
        </Button>
      </> : <>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={runPreview}>Preview</Button>
      </>}>
      {!preview ? (
        <label className="pf-paste-field">
          <span className="pf-paste-label">Order rows</span>
          <textarea className="pf-paste-text" value={text} onChange={e => setText(e.target.value)} disabled={busy}
            rows={10} spellCheck={false} placeholder={`e.g.\n${EXAMPLE}`} aria-describedby="pf-paste-hint" />
          <span id="pf-paste-hint" className="pf-paste-hint">Tabs, extra spaces and wrapped lines are fine. Nothing is written until you add the trades.</span>
        </label>
      ) : (
        <div className="pf-paste-preview">
          <DataTable ariaLabel="Pasted orders" rows={preview.trades} rowKey={pasteRowId} sortable={false} dense maxHeight={360}
            empty={<EmptyState size="sm" plain title="No trade rows could be read." description="See the errors below." />}
            columns={columns} />
          {preview.errors.length > 0 && (
            <div className="pf-validate is-bad pf-paste-errors" role="alert">
              <strong>{preview.errors.length} {preview.errors.length === 1 ? 'row was' : 'rows were'} not read — fix the text or add them by hand:</strong>
              {preview.errors.map((e, i) => <div key={i} className="pf-validate-row pf-paste-err">{e}</div>)}
            </div>
          )}
          <p className="pf-paste-hint">Added rows are manual entries; when the SSI email or monthly statement for the same trade is imported later it replaces them, so nothing is counted twice.</p>
        </div>
      )}
      {error && <p className="pf-error" role="alert">{error}</p>}
    </Dialog>
  );
};

export { PasteDialog };
