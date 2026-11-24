// One headline row: time, title, source / region / ticker badges. Used by the News page feed and Today's latest-news card.

import React from 'react';
import { Badge } from '../../../ui';

const REGION_LABEL = { vn: 'VN', us: 'US' };

const NewsMeta = ({ n, maxTags = 3 }) => (
  <span className="nw-meta">
    <Badge sans outline className="nw-src">{n.src}</Badge>
    {REGION_LABEL[n.region] && <Badge sans>{REGION_LABEL[n.region]}</Badge>}
    {(n.tags || []).slice(0, maxTags).map(t => <Badge key={t} tone="info" className="nw-tk">{t}</Badge>)}
  </span>
);

// onOpen: open the story panel (News page). Without it, the title links out.
const NewsRow = ({ n, onOpen, compact = false }) => (
  <li className={`nw-row${compact ? ' is-compact' : ''}`}>
    <span className="nw-time num">{n.time}</span>
    <div className="nw-body">
      {onOpen ? (
        <button type="button" className="nw-title" onClick={() => onOpen(n)}>{n.title}</button>
      ) : n.url ? (
        <a className="nw-title" href={n.url} target="_blank" rel="noopener noreferrer">{n.title}</a>
      ) : <span className="nw-title">{n.title}</span>}
      <NewsMeta n={n} maxTags={compact ? 2 : 3} />
    </div>
  </li>
);

export { NewsRow, NewsMeta };
