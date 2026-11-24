// Add / replace one ledger transaction. Trades take ticker + quantity + unit price; cash
// events take an amount. Same payload as before the refactor.

import React from 'react';
import { Button, Dialog, NumberInput, Select, TextInput } from '../../ui';
import { PORTFOLIO_CURRENCIES, TX_TYPES, pfLocalDateTime, pfMoney } from './pf-utils.js';

const TYPE_OPTIONS = TX_TYPES.map(t => ({ value: t, label: t }));
const CCY_OPTIONS = PORTFOLIO_CURRENCIES.map(c => ({ value: c, label: c }));
const num = (v) => (v === '' || v == null ? null : Number(v));

const TransactionDialog = ({ initial, currency, onClose, onSave, busy }) => {
  const seed = initial || {};
  const [type, setType] = React.useState(seed.type || 'BUY');
  const [effectiveAt, setEffectiveAt] = React.useState(pfLocalDateTime(seed.effective_at || new Date()));
  const [ticker, setTicker] = React.useState(seed.ticker || '');
  const [quantity, setQuantity] = React.useState(num(seed.quantity));
  const [unitPrice, setUnitPrice] = React.useState(num(seed.unit_price));
  const [cashAmount, setCashAmount] = React.useState(num(seed.cash_amount));
  const [nativeCurrency, setNativeCurrency] = React.useState(seed.currency || currency);
  const [fees, setFees] = React.useState(num(seed.fees || null));
  const [taxes, setTaxes] = React.useState(num(seed.taxes || null));
  const [note, setNote] = React.useState(seed.note || '');
  const trade = ['BUY', 'SELL'].includes(type);
  const valid = trade ? ticker.trim() && Number(quantity) > 0 && Number(unitPrice) >= 0 : Number(cashAmount) > 0;
  const submit = () => onSave({
    type, effective_at: new Date(effectiveAt).toISOString(),
    ticker: trade || type === 'DIVIDEND' ? (ticker.trim().toUpperCase() || null) : null,
    quantity: trade ? Number(quantity) : null, unit_price: trade ? Number(unitPrice) : null,
    cash_amount: trade ? null : Number(cashAmount), currency: nativeCurrency,
    fees: Number(fees) || 0, taxes: Number(taxes) || 0, note: note || null,
    source: initial?.source || 'manual', external_id: initial?.external_id || null,
  });
  const ccyStep = nativeCurrency === 'VND' ? 100 : 0.01;

  return (
    <Dialog open onClose={onClose} size="lg" busy={busy} className="pf-tx-dialog"
      title={initial ? 'Replace transaction' : 'Add transaction'}
      description={initial ? 'The original stays in the audit history; this replacement becomes the active record.' : 'Recorded in the audited ledger; holdings and cash are rebuilt from it.'}
      actions={<>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="primary" disabled={!valid || busy} loading={busy} onClick={submit}>{initial ? 'Save replacement' : 'Add transaction'}</Button>
      </>}>
      <div className="pf-form">
        <div className="pf-form-row">
          <Select size="sm" label="Type" value={type} onChange={setType} options={TYPE_OPTIONS} ariaLabel="Type" />
          <TextInput label="Effective time" type="datetime-local" value={effectiveAt} onChange={setEffectiveAt} />
        </div>
        {(trade || type === 'DIVIDEND') && <TextInput label="Ticker" value={ticker} onChange={v => setTicker(v.toUpperCase())} placeholder="AAPL or VN:VNM" />}
        {trade ? (
          <div className="pf-form-row">
            <NumberInput label="Quantity" value={quantity} onChange={setQuantity} min={0} step={nativeCurrency === 'VND' ? 100 : 1} />
            <NumberInput label="Unit price" value={unitPrice} onChange={setUnitPrice} min={0} step={ccyStep} />
          </div>
        ) : (
          <NumberInput label="Cash amount" value={cashAmount} onChange={setCashAmount} min={0} step={ccyStep} />
        )}
        <div className="pf-form-row is-3">
          <Select size="sm" label="Native currency" value={nativeCurrency} onChange={setNativeCurrency} options={CCY_OPTIONS} ariaLabel="Native currency" />
          <NumberInput label="Fees" value={fees} onChange={setFees} min={0} step={ccyStep} />
          <NumberInput label="Taxes" value={taxes} onChange={setTaxes} min={0} step={ccyStep} />
        </div>
        <label className="pf-form-field">
          <span className="pf-form-label">Note</span>
          <textarea className="pf-textarea" value={note} onChange={e => setNote(e.target.value)} rows={3} />
        </label>
        {trade && valid && <p className="pf-form-hint">Gross trade: <b className="num">{pfMoney(Number(quantity) * Number(unitPrice), nativeCurrency)}</b></p>}
      </div>
    </Dialog>
  );
};

export { TransactionDialog };
