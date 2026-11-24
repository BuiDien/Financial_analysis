// Market pulse: the four VN index tiles, then the global strip.

import React from 'react';
import { useApiLive } from '../../../api-client.jsx';
import { ChangeText, StatGrid, StatTile } from '../../../ui';
import { formatNumber, isNum } from '../../../lib/format.js';
import { VN_INDICES, useGlobalIndices, useVnIndices } from '../../../lib/data.js';

const TILE_LABEL = { VNINDEX: 'VN-INDEX', VN30: 'VN30', HNXINDEX: 'HNX', UPCOMINDEX: 'UPCOM' };

const tileNote = (live, q, r) => {
  if (!live) return 'Backend offline';
  if (q.isLoading) return 'Loading…';
  if (!isNum(r.val)) return 'No quote';
  return r.state === 'CLOSED' ? 'Market closed' : 'today';
};

const GlobalStrip = ({ live }) => {
  const q = useGlobalIndices();
  const note = !live ? 'Backend offline' : q.isLoading ? 'Loading…' : q.error ? 'Unavailable right now' : 'No data';
  return (
    <div className="td-global">
      <span className="td-global-label" id="td-global-label">Global</span>
      {!q.data ? <span className="td-muted">{note}</span> : (
        <div className="td-global-items" role="list" aria-labelledby="td-global-label">
          {q.data.map(g => (
            <span key={g.sym} className="td-global-item" role="listitem">
              <span className="td-global-sym">{g.sym}</span>
              <span className="num">{isNum(g.val) ? `${g.prefix || ''}${formatNumber(g.val, 2)}${g.suffix || ''}` : '—'}</span>
              {isNum(g.chg) && <ChangeText value={g.chg} />}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

const MarketPulse = () => {
  const { live } = useApiLive();
  const vn = useVnIndices();
  const rows = vn.data || VN_INDICES.map(m => ({ ...m, val: null, chg: null }));
  return (
    <section className="td-pulse" aria-label="Market pulse">
      <StatGrid className="td-vn">
        {rows.map(r => (
          <StatTile key={r.sym} label={TILE_LABEL[r.sym] || r.label} live={live && isNum(r.val) && r.state !== 'CLOSED'}
            value={isNum(r.val) ? formatNumber(r.val, 2) : '—'} delta={r.chg} deltaLabel={tileNote(live, vn, r)} />
        ))}
      </StatGrid>
      <GlobalStrip live={live} />
    </section>
  );
};

export { MarketPulse };
