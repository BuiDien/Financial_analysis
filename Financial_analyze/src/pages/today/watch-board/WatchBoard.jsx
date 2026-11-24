// Watch board — live tiles for indices, commodities and stocks on the Today
// page. Live-only: offline it shows an empty state, never sample prices. Prices
// are in each listing's own currency (no FX). The instrument list persists locally.

import React from 'react';
import { useApiLive } from '../../../api-client.jsx';
import { Button, Card, EmptyState } from '../../../ui';
import { INSTRUMENTS, isVnStock, loadWatch, marketOf, saveWatch } from './instruments.js';
import { useBoardQuotes } from './useBoardQuotes.js';
import { FocusHero, WatchTile } from './WatchTile.jsx';
import { AddInstrumentDialog } from './AddInstrumentDialog.jsx';
import '../shared.css';
import './watch-board.css';

const WatchBoard = ({ setActiveAsset, setPage }) => {
  const [watch, setWatch] = React.useState(loadWatch);
  const [focus, setFocus] = React.useState(() => loadWatch()[0]);
  const [showAdd, setShowAdd] = React.useState(false);
  const { live } = useApiLive();
  const { quotes } = useBoardQuotes(watch, live);

  React.useEffect(() => { saveWatch(watch); }, [watch]);

  const addInstrument = (sym) => { if (!watch.includes(sym)) setWatch(w => [...w, sym]); setShowAdd(false); };
  const removeInstrument = (sym) => {
    setWatch(w => w.filter(x => x !== sym));
    if (focus === sym) setFocus(watch.find(x => x !== sym));
  };
  const openFocus = () => {
    setActiveAsset(isVnStock(focus) ? marketOf(focus) : focus);
    setPage('detail');
  };

  const focusInst = INSTRUMENTS[focus];
  const focusQ = quotes[focus];

  return (
    <Card className="wb" title="Watch board" subtitle={live ? `${watch.length} instruments · select one to focus · updates every 5 min` : null}
      actions={<Button size="sm" icon="plus" onClick={() => setShowAdd(true)}>Add instrument</Button>}
      bodyClassName="wb-body">
      {!live ? (
        <EmptyState plain className="td-quiet" title="Backend offline" description="Start it with scripts/run.sh to see live prices." />
      ) : (
        <>
          {focusInst && focusQ && <FocusHero sym={focus} q={focusQ} onOpen={openFocus} />}
          <div className="wb-grid">
            {watch.map(sym => (quotes[sym] ? (
              <WatchTile key={sym} sym={sym} q={quotes[sym]} focused={focus === sym}
                onFocus={() => setFocus(sym)} onRemove={() => removeInstrument(sym)} />
            ) : null))}
            <button type="button" className="wb-add" onClick={() => setShowAdd(true)}>
              <span aria-hidden="true">+</span> Add instrument
            </button>
          </div>
        </>
      )}
      <AddInstrumentDialog open={showAdd} current={watch} onAdd={addInstrument} onClose={() => setShowAdd(false)} />
    </Card>
  );
};

export { WatchBoard };
