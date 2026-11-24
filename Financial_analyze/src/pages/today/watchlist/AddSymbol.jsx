// Add-symbol field with catalog autocomplete (SearchInput #429).

import React from 'react';
import { Button, SearchInput, toast } from '../../../ui';
import { SYMBOL_CATALOG } from '../../../watchlist-store.jsx';

const AddSymbol = ({ onAdd, existing }) => {
  const [q, setQ] = React.useState('');

  const suggestions = React.useCallback((text) => {
    const term = String(text || '').trim().toUpperCase();
    if (!term) return [];
    return Object.keys(SYMBOL_CATALOG)
      .filter(s => !existing.includes(s))
      .filter(s => s.includes(term) || SYMBOL_CATALOG[s].name.toUpperCase().includes(term))
      .slice(0, 6)
      .map(s => ({ value: s, label: s, meta: SYMBOL_CATALOG[s].name }));
  }, [existing]);

  // Catalog symbols are added as-is; anything else is treated as a Vietnamese
  // listing ("VN:FPT") so it is quoted from VCI, not a same-named US ticker.
  const commit = (sym) => {
    const s = String(sym || q).trim().toUpperCase();
    if (!s) return;
    if (!/^[A-Z0-9.:\-]{1,15}$/.test(s)) { toast(`"${s}" doesn't look like a ticker`, { type: 'error' }); return; }
    const stored = SYMBOL_CATALOG[s] || s.includes(':') ? s : `VN:${s}`;
    setQ('');
    if (existing.includes(stored) || existing.includes(s)) { toast(`${s} is already in this watchlist`, { type: 'info' }); return; }
    onAdd(stored);
  };

  return (
    <div className="wl-add">
      <SearchInput value={q} onChange={setQ} size="sm" placeholder="Add ticker (e.g. FPT)…" ariaLabel="Add ticker to watchlist"
        suggestions={suggestions} onSelect={(item) => commit(item.value)} onSubmit={(text) => commit(text)} />
      <Button size="sm" icon="plus" onClick={() => commit()}>Add</Button>
    </div>
  );
};

export { AddSymbol };
