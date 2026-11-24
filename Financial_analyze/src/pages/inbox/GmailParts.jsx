// Gmail import pieces: setup steps, auto-check card and the pulled-reports table.

import React from 'react';
import { Badge, Card, DataTable, EmptyState, JobSteps, Select, Switch } from '../../ui';
import { formatDateTime } from '../../lib/format.js';

const GMAIL_INTERVALS = [15, 30, 60, 180, 720, 1440];
const gmailIntervalLabel = (m) => (m < 60 ? `${m} min` : m === 1440 ? 'Daily' : `${m / 60} h`);
const INTERVAL_OPTIONS = GMAIL_INTERVALS.map(m => ({ value: m, label: gmailIntervalLabel(m) }));

export const gmailWhen = (iso) => {
  if (!iso) return 'never';
  return formatDateTime(iso, { naiveUtc: true });  // backend timestamps are UTC
};

// Setup checklist derived from the saved config (address → password → login → auto-check).
export const GmailSetupSteps = ({ cfg, dirty, busy }) => {
  const hasAddr = Boolean(cfg.address);
  const hasPw = Boolean(cfg.password_saved);
  const tested = cfg.last_status === 'ok';
  const failed = cfg.last_status === 'error';
  const steps = [
    { key: 'addr', label: 'Gmail address saved', status: hasAddr ? 'done' : 'wait' },
    { key: 'pw', label: 'App password in macOS Keychain', status: hasPw ? 'done' : 'wait' },
    {
      key: 'login', label: 'Login checked',
      status: busy === 'test' || busy === 'check' ? 'run' : tested ? 'done' : failed ? 'fail' : 'wait',
      meta: cfg.last_checked_at ? gmailWhen(cfg.last_checked_at) : undefined,
    },
    { key: 'auto', label: 'Auto-check on', status: cfg.enabled ? 'done' : 'wait', meta: cfg.enabled ? `every ${gmailIntervalLabel(cfg.interval_minutes)}` : undefined },
  ];
  return (
    <Card title="Setup" subtitle={dirty ? 'Unsaved changes — save before testing' : 'Four steps to automatic imports'}>
      <JobSteps bare steps={steps} ariaLabel="Gmail import setup" />
    </Card>
  );
};

export const GmailAutoCheck = ({ cfg, onPatch, busy }) => {
  const statusOk = cfg.last_status === 'ok';
  const summary = cfg.last_summary;
  const ready = cfg.password_saved && cfg.address;
  return (
    <Card title="Auto-check" subtitle="The server checks Gmail in the background while it is running">
      <div className="ibx-form">
        <Switch label="Check Gmail automatically" checked={!!cfg.enabled} disabled={!!busy}
          description={ready ? 'New reports are downloaded once; repeats are skipped' : 'Save address and app password first'}
          onChange={v => onPatch({ enabled: v })} />
        <div className="ibx-field-narrow">
          <Select size="sm" label="Every" value={cfg.interval_minutes} options={INTERVAL_OPTIONS} disabled={!!busy}
            onChange={v => onPatch({ interval_minutes: Number(v) })} />
        </div>
        <div className="ibx-laststatus">
          <Badge tone={!cfg.last_status ? 'neutral' : statusOk ? 'pos' : 'neg'} dot>
            {!cfg.last_status ? 'Not checked' : statusOk ? 'OK' : 'Error'}
          </Badge>
          <span className="ibx-muted">
            Last check: {gmailWhen(cfg.last_checked_at)}
            {summary && ` · ${summary.matches ?? 0} matching, ${summary.new ?? 0} new, ${summary.downloaded ?? 0} downloaded`}
            {summary && summary.errors ? `, ${summary.errors} failed` : ''}
          </span>
        </div>
        {cfg.last_status === 'error' && cfg.last_error && <div className="ibx-mono-error">{cfg.last_error}</div>}
      </div>
    </Card>
  );
};

const REPORT_TONE = { downloaded: 'pos', error: 'neg' };
const REPORT_COLUMNS = [
  { key: 'received_at', label: 'Received', render: r => <span className="ibx-when">{gmailWhen(r.received_at)}</span> },
  { key: 'subject', label: 'Subject', render: r => <span className="ibx-subject">{r.subject}</span> },
  {
    key: 'attachments', label: 'Attachment', sortable: false,
    render: r => <span className="ibx-files">{(r.attachments || []).map(a => <span key={a.filename}>{a.filename}{a.encrypted ? ' (encrypted)' : ''}</span>)}</span>,
  },
  {
    key: 'status', label: 'Status',
    render: r => <Badge tone={REPORT_TONE[r.status] || 'neutral'} title={r.error || ''}>{r.status === 'no_pdf' ? 'no PDF' : r.status}</Badge>,
  },
];

export const GmailReports = ({ reports }) => (
  <Card title="Pulled reports" subtitle="Saved locally in backend/data/gmail_reports — not imported into the portfolio yet" flush>
    <div className="ibx-table">
      <DataTable ariaLabel="Pulled Gmail reports" rows={reports} rowKey="id" columns={REPORT_COLUMNS} dense maxHeight={420}
        empty={<EmptyState size="sm" plain title="Nothing pulled yet" description="Click “Check now”." />} />
    </div>
  </Card>
);
