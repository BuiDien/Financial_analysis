// Today card: alerts that have fired, newest first.

import React from 'react';
import { Badge, Button, Card, EmptyState } from '../../../ui';
import { useAlerts } from '../../../lib/data.js';
import { describeAlert, triggeredAtText } from '../alerts/alert-types.js';
import { SectionStatus } from './SectionStatus.jsx';

const TriggeredAlerts = ({ setPage, setActiveAsset }) => {
  const q = useAlerts();
  const list = q.data || [];
  const triggered = list.filter(a => a.triggered).sort((a, b) => (b.triggeredAt || 0) - (a.triggeredAt || 0));
  const active = list.filter(a => a.active && !a.triggered).length;

  return (
    <Card title="Triggered alerts" className="td-card"
      actions={<Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => setPage('#/today/alerts')}>All alerts</Button>}>
      {!q.data ? <SectionStatus live={q.live} q={q} emptyText="No alerts yet." />
        : triggered.length === 0 ? (
          <EmptyState plain className="td-quiet" title="Nothing triggered" description={`${active} active alert${active === 1 ? '' : 's'} watching.`} />
        ) : (
          <ul className="td-list">
            {triggered.slice(0, 6).map(a => (
              <li key={a.id}>
                <button type="button" className="td-row" onClick={() => { setActiveAsset(a.ticker); setPage('detail'); }}>
                  <span className="ticker">{a.ticker}</span>
                  <span className="td-row-main">
                    <span className="td-row-title">{describeAlert(a)}</span>
                    {a.triggeredAt && <span className="td-row-meta num">{triggeredAtText(a)}</span>}
                  </span>
                  <Badge tone="accent" dot>Triggered</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
    </Card>
  );
};

export { TriggeredAlerts };
