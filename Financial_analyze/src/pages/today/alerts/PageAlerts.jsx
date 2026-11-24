// Alerts page — price / daily-move alerts stored on the backend (/api/alerts).
// Old localStorage alerts are imported once (lib/data.js).

import React from 'react';
import { handoff } from '../../../handoff.js';
import { Icon } from '../../../icons.jsx';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, IconButton, Segmented, StatGrid, StatTile, Switch, askConfirm, toast } from '../../../ui';
import { alertsApi, useAlerts } from '../../../lib/data.js';
import { alertStatus, alertType, describeAlert, triggeredAtText } from './alert-types.js';
import { AlertDialog } from './AlertDialog.jsx';
import './alerts.css';

const STATUS_BADGE = {
  triggered: { tone: 'accent', label: 'Triggered', dot: true },
  unmonitored: { tone: 'neutral', label: 'Not monitored', tip: 'RSI and volume alerts are not evaluated yet' },
  active: { tone: 'pos', label: 'Active' },
  paused: { tone: 'neutral', label: 'Paused' },
};

const PageAlerts = ({ setActiveAsset, setPage }) => {
  const q = useAlerts();
  const live = q.live;
  const alerts = q.data || [];
  const [showForm, setShowForm] = React.useState(false);
  const [prefillSym, setPrefillSym] = React.useState('');
  const [filter, setFilter] = React.useState('all');

  // Open the form pre-filled when arriving from the Company page "Alert" button.
  React.useEffect(() => {
    if (handoff.alertTicker) {
      setPrefillSym(handoff.alertTicker);
      setShowForm(true);
      handoff.alertTicker = null;
    }
  }, []);

  const fail = (what) => (e) => toast(`${what}: ${e.message || e}`, { type: 'error' });
  const addAlert = async (a) => {
    try {
      await alertsApi.create({ ...a, id: 'a_' + Date.now(), created: new Date().toISOString().slice(0, 10), triggered: false });
      setShowForm(false);
      toast(`Alert created for ${a.ticker || 'asset'}`, { type: 'success' });
    } catch (e) { fail('Could not create alert')(e); }
  };
  const removeAlert = async (a) => {
    if (!(await askConfirm({ title: 'Delete alert', message: `Delete the ${a.ticker} alert “${describeAlert(a)}”?`, confirmText: 'Delete', danger: true }))) return;
    alertsApi.remove(a.id).then(() => toast('Alert removed', { type: 'info' })).catch(fail('Could not remove alert'));
  };
  const toggleAlert = (a) => alertsApi.update(a.id, { active: !a.active }).catch(fail('Could not update alert'));
  const openTicker = (t) => { setActiveAsset(t); setPage('detail'); };

  const counts = {
    all: alerts.length,
    active: alerts.filter(a => a.active && !a.triggered).length,
    triggered: alerts.filter(a => a.triggered).length,
  };
  const filtered = alerts.filter(a => (filter === 'all' ? true : filter === 'active' ? a.active && !a.triggered : a.triggered));

  const columns = [
    { key: 'icon', label: <span className="sr-only">Type</span>, sortable: false, width: 44,
      render: a => <span className={`al-ico${a.triggered ? ' is-hot' : ''}`} aria-hidden="true"><Icon name={alertType(a.type)?.icon || 'alerts'} size={14} /></span> },
    { key: 'ticker', label: 'Ticker', render: a => <button type="button" className="al-tk ticker" onClick={() => openTicker(a.ticker)}>{a.ticker}</button> },
    { key: 'type', label: 'Condition', sortValue: describeAlert, render: a => describeAlert(a) },
    { key: 'note', label: 'Note', className: 'al-note', render: a => a.note || '—' },
    { key: 'created', label: 'Created', className: 'al-muted num' },
    { key: 'status', label: 'Status', sortValue: alertStatus, render: a => {
      const b = STATUS_BADGE[alertStatus(a)];
      return <Badge tone={b.tone} dot={b.dot} sans data-tip={a.triggered ? triggeredAtText(a) || undefined : b.tip}>{b.label}</Badge>;
    } },
    { key: 'actions', label: <span className="sr-only">Actions</span>, sortable: false, align: 'right', render: a => (
      <span className="al-actions">
        <Switch aria-label={a.active ? `Pause ${a.ticker} alert` : `Resume ${a.ticker} alert`} checked={!!a.active} onChange={() => toggleAlert(a)} />
        <IconButton icon="close" size="sm" variant="ghost" label={`Delete ${a.ticker} alert`} onClick={() => removeAlert(a)} />
      </span>
    ) },
  ];

  const emptyBlock = !live ? <EmptyState plain title="Alerts unavailable while the backend is offline" />
    : <EmptyState size="sm" title={filter === 'all' ? 'No alerts yet' : `No ${filter} alerts`}
      description="Get an in-app notice when a price or daily move crosses your level."
      action={filter === 'all' ? { label: 'Create your first alert', icon: 'plus', onClick: () => setShowForm(true) } : undefined} />;

  return (
    <div className="page al-page">
      <header className="page-header">
        <div>
          <h1 className="page-title">Alerts.</h1>
          <p className="page-sub">In-app notice when a price or daily-move condition is met · checked every 5 minutes while the backend is live</p>
        </div>
        <Button variant="primary" icon="plus" disabled={!live} onClick={() => setShowForm(true)}>New alert</Button>
      </header>

      {!live && <div className="al-banner" role="status"><Icon name="server" size={14} /> Backend offline — start with scripts/run.sh. Alerts are stored on the backend.</div>}
      {live && q.error && !q.data && <ErrorState size="sm" card title="Could not load alerts" message={q.error.message || 'request failed'} onRetry={() => q.refetch?.()} />}

      <StatGrid className="al-stats">
        <StatTile label="Active alerts" value={String(counts.active)} deltaLabel={live ? 'watching live quotes' : 'paused · backend offline'} />
        <StatTile label="Triggered" className={counts.triggered ? "al-hot" : undefined} value={String(counts.triggered)} deltaLabel="need your attention" />
        <StatTile label="Total configured" value={String(counts.all)} deltaLabel="across your watchlist" />
      </StatGrid>

      <Card title="Your alerts" flush overflow
        actions={<Segmented size="sm" ariaLabel="Filter alerts" value={filter} onChange={setFilter}
          options={[{ value: 'all', label: `All ${counts.all}` }, { value: 'active', label: `Active ${counts.active}` }, { value: 'triggered', label: `Triggered ${counts.triggered}` }]} />}>
        <DataTable ariaLabel="Alerts" rows={filtered} rowKey="id" columns={columns} loading={live && q.isLoading}
          rowClassName={a => (a.triggered ? 'al-row-hot' : '')} empty={emptyBlock} />
      </Card>

      <AlertDialog open={showForm} defaultSym={prefillSym} onCreate={addAlert}
        onClose={() => { setShowForm(false); setPrefillSym(''); }} />
    </div>
  );
};

export { PageAlerts };
