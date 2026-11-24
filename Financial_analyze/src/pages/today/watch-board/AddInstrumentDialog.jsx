// Add-to-watch-board dialog: pick from the catalog, or type any ticker and
// verify it against the live backend before it is added.

import React from 'react';
import { HelixAPI } from '../../../api-client.jsx';
import { Dialog, EmptyState, SearchInput } from '../../../ui';
import { CUSTOM_MARKETS, INSTRUMENTS, saveCustomInstrument } from './instruments.js';

const AddInstrumentDialog = ({ open, current, onAdd, onClose }) => {
  const [q, setQ] = React.useState('');
  const [lookingUp, setLookingUp] = React.useState(null);
  const [lookupError, setLookupError] = React.useState('');
  const typed = q.trim().toUpperCase();
  const canLookUp = /^[A-Z0-9.\-]{1,12}$/.test(typed) && !INSTRUMENTS[typed];
  React.useEffect(() => { setLookupError(''); }, [q]);
  React.useEffect(() => { if (!open) setQ(''); }, [open]);

  const lookUp = async (market) => {
    if (!HelixAPI?.live) { setLookupError('Start the backend to add new tickers — prices come from the live feed.'); return; }
    setLookingUp(market.key);
    setLookupError('');
    try {
      const quote = await HelixAPI.quote(market.live(typed));
      if (!quote || typeof quote.price !== 'number') throw new Error('no price');
      saveCustomInstrument(typed, { name: `${typed} (${market.label})`, cls: market.cls, dp: 2, unit: market.unit, live: market.live(typed) });
      onAdd(typed);
    } catch {
      setLookupError(`No ${market.label.toLowerCase()} quote found for ${typed}.`);
    } finally {
      setLookingUp(null);
    }
  };

  const groups = {};
  Object.entries(INSTRUMENTS).forEach(([sym, inst]) => {
    if (current.includes(sym)) return;
    if (q && !`${sym} ${inst.name}`.toLowerCase().includes(q.toLowerCase())) return;
    (groups[inst.cls] = groups[inst.cls] || []).push([sym, inst]);
  });

  return (
    <Dialog open={open} onClose={onClose} title="Add to watch board" size="lg"
      description="Search the catalog, or type any ticker (e.g. MBB) to look it up.">
      <SearchInput value={q} onChange={setQ} placeholder="Search, or type any ticker…" ariaLabel="Search instruments" autoFocus />
      <div className="wb-pick">
        {canLookUp && (
          <div className="wb-pick-group">
            <div className="wb-pick-label">Add ticker {typed}</div>
            <div className="wb-pick-grid">
              {CUSTOM_MARKETS.map(market => (
                <button type="button" key={market.key} className="wb-pick-item is-lookup" disabled={!!lookingUp} onClick={() => lookUp(market)}>
                  <span className="ticker">{typed}</span>
                  <span className="wb-pick-name">{lookingUp === market.key ? 'Checking price…' : market.label}</span>
                </button>
              ))}
            </div>
            {lookupError && <div role="alert" className="wb-pick-error">{lookupError}</div>}
          </div>
        )}
        {Object.keys(groups).length === 0 && !canLookUp && <EmptyState plain title="No matches" />}
        {Object.entries(groups).map(([cls, items]) => (
          <div key={cls} className="wb-pick-group">
            <div className="wb-pick-label">{cls}</div>
            <div className="wb-pick-grid">
              {items.map(([sym, inst]) => (
                <button type="button" key={sym} className="wb-pick-item" onClick={() => onAdd(sym)}>
                  <span className="ticker">{sym}</span>
                  <span className="wb-pick-name">{inst.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
};

export { AddInstrumentDialog };
