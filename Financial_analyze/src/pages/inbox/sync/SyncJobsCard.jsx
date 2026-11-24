// Sync job queue: every dispatched document, its worker, live progress and the next action.

import React from 'react';
import { askConfirm, Badge, Button, Card, DataTable, EmptyState, ProgressBar } from '../../../ui';

const TERMINAL = {
  done: { tone: 'pos', label: 'Returned' },
  failed: { tone: 'neg', label: 'Failed' },
  error: { tone: 'neg', label: 'Failed' },
  held: { tone: 'warn', label: 'Held' },
  stopped: { tone: 'neg', label: 'Stopped' },
};

const JobStatusCell = ({ job }) => {
  const t = TERMINAL[job.status];
  if (t) return <Badge tone={t.tone}>{t.label}</Badge>;
  const running = job.status === 'parsing';
  return (
    <ProgressBar size="sm" status={running ? 'running' : 'queued'} value={running ? job.progress : null}
      label={<span className="syn-cap">{job.status}</span>} meta={running ? undefined : ''} ariaLabel={`${job.filename} progress`} />
  );
};

const JobActions = ({ job, onControl, onResume, onReview, onVerify }) => {
  if (['sent', 'parsing'].includes(job.status) && job.kind === 'inbox') {
    return (
      <div className="syn-actions">
        <Button size="sm" onClick={() => onControl(job, 'hold')}>Hold</Button>
        <Button size="sm" variant="danger" onClick={async () => {
          const ok = await askConfirm({ title: 'Stop OCR job', message: `Stop processing "${job.filename}"? You can send it again later.`, confirmText: 'Stop', danger: true });
          if (ok) onControl(job, 'stop');
        }}>Stop</Button>
      </div>
    );
  }
  if (['holding', 'stopping'].includes(job.status)) return <span className="ibx-muted">Sending command…</span>;
  if (job.status === 'held' && job.kind === 'inbox') return <Button size="sm" variant="primary" onClick={() => onResume(job)}>Resume</Button>;
  if (job.status === 'done') {
    if (job.kind === 'inbox') return <Button size="sm" variant="primary" onClick={onReview}>Review in Inbox</Button>;
    if (job.applied) return <Badge tone="pos" sans>Applied</Badge>;
    return <Button size="sm" variant="primary" onClick={() => onVerify(job)}>Verify data</Button>;
  }
  return null;
};

const SyncJobsCard = ({ jobs, onClearDone, ...handlers }) => {
  const doneCount = jobs.filter(j => j.status === 'done').length;
  const active = jobs.filter(j => !TERMINAL[j.status]).length;
  const columns = [
    {
      key: 'document', label: 'Document', sortValue: j => j.ticker || j.filename,
      render: j => (
        <div className="syn-doc">
          <span className="syn-doc-title">{j.ticker || (j.kind === 'inbox' ? 'OCR Inbox' : '—')}</span>
          <span className="syn-doc-sub" title={j.filename}>{j.filename}</span>
        </div>
      ),
    },
    { key: 'worker', label: 'Worker', render: j => <span className="ibx-muted">{j.worker || '—'}</span> },
    { key: 'status', label: 'Status', width: 210, sortable: false, render: j => <JobStatusCell job={j} /> },
    { key: 'metrics', label: 'Metrics', numeric: true, sortValue: j => j.rows?.length, render: j => (j.rows ? j.rows.length : '—') },
    { key: 'actions', label: '', sortable: false, align: 'right', width: 200, render: j => <JobActions job={j} {...handlers} /> },
  ];
  return (
    <Card title="Job queue" subtitle={jobs.length ? `${active} active · ${doneCount} returned` : undefined} flush
      actions={doneCount > 0 ? <Button size="sm" variant="ghost" onClick={onClearDone}>Clear completed</Button> : null}>
      <div className="ibx-table">
        <DataTable ariaLabel="Sync job queue" rows={jobs} rowKey="id" columns={columns} highlightNew
          empty={<EmptyState size="sm" plain title="No jobs yet" description="Dispatch a filing above and watch it flow: sent → parsing → returned." />} />
      </div>
    </Card>
  );
};

export { SyncJobsCard };
