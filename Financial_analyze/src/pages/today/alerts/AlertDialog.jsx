// "New alert" dialog (#436). Only conditions the monitor evaluates can be created.

import React from 'react';
import { Dialog, NumberInput, Select, Switch, TextInput } from '../../../ui';
import { LIVE_TICKER } from '../watch-board/instruments.js';
import { ALERT_TYPES, alertType } from './alert-types.js';

const CONDITIONS = ALERT_TYPES.filter(t => t.monitored).map(t => ({ value: t.id, label: t.label }));

const valueHint = (t, isVn) => {
  if (!t?.unit) return 'Level';
  if (t.unit === 'price') return isVn ? 'Price in đồng, e.g. 61500' : "Price in the listing's currency";
  return t.unit === '%' ? 'Percent' : t.unit === '×' ? 'Multiple' : 'Level';
};

const AlertDialog = ({ open, defaultSym = '', onClose, onCreate }) => {
  const [ticker, setTicker] = React.useState(defaultSym);
  const [type, setType] = React.useState('price_above');
  const [value, setValue] = React.useState(null);
  const [note, setNote] = React.useState('');
  const [inApp, setInApp] = React.useState(true);
  const [error, setError] = React.useState({});
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setTicker(defaultSym); setType('price_above'); setValue(null); setNote(''); setInApp(true); setError({});
  }, [open, defaultSym]);

  const sym = ticker.trim().toUpperCase();
  const isVn = /^VN:/.test(sym) || LIVE_TICKER[sym]?.startsWith('VN:');
  const selected = alertType(type);

  const submit = async () => {
    if (!sym) { setError({ ticker: 'Enter a ticker symbol' }); return; }
    if (value == null || !Number.isFinite(value)) { setError({ value: 'Enter a numeric value' }); return; }
    if (!selected?.monitored) { setError({ type: 'This condition is not monitored yet' }); return; }
    setBusy(true);
    try {
      await onCreate({
        ticker: sym, type, value, note: note.trim(), active: true, channels: { inApp },
        ...(selected.unit === 'price' && isVn ? { currency: 'VND' } : {}),
      });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New alert" icon="none" onConfirm={submit} confirmText="Create alert" busy={busy}
      description="RSI and volume conditions are not monitored yet, so only price and daily-move alerts can be created.">
      <form className="al-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <TextInput label="Ticker" value={ticker} onChange={v => { setTicker(v.toUpperCase()); setError({}); }} placeholder="e.g. FPT" error={error.ticker} autoComplete="off" />
        <Select size="field" label="Condition" value={type} onChange={v => { setType(v); setError({}); }} options={CONDITIONS} />
        <NumberInput label="Value" value={value} onChange={v => { setValue(v); setError({}); }} hint={valueHint(selected, isVn)}
          error={error.value || error.type} placeholder="0" suffix={selected?.unit === '%' ? '%' : selected?.unit === 'price' && isVn ? '₫' : undefined} />
        <TextInput label="Note (optional)" value={note} onChange={setNote} placeholder="Why this matters to you" />
        <Switch label="Notify in-app" checked={inApp} onChange={setInApp} />
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
};

export { AlertDialog };
