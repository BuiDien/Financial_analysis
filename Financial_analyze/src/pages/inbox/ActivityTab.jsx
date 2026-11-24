// Inbox → Activity: background jobs on the backend (GET /api/jobs).
// Row click opens a detail side panel; jobs the backend marks `cancellable`
// can be cancelled (POST /api/jobs/{id}/cancel — 409 with a reason otherwise).

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { useJobs } from '../../lib/data.js';
import { invalidate } from '../../lib/query.js';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, ProgressBar, Select, toast } from '../../ui';
import { canCancelJob, fmtDuration, fmtWhen, isActiveJob, JOB_STATUS, jobProgress, jobStatus, toDate } from './job-utils.js';
import { JobDetailPanel } from './JobDetailPanel.jsx';
import './inbox.css';

const STATUS_OPTIONS = [{ value: '', label: 'All statuses' },
  ...Object.keys(JOB_STATUS).map(s => ({ value: s, label: JOB_STATUS[s].label }))];

const useCancelJob = () => {
  const [busyId, setBusyId] = React.useState(null);
  const cancel = async (job) => {
    setBusyId(job.id);
    try {
      await HelixAPI.cancelJob(job.id);
      toast(`Cancel requested for job ${job.id}`, { type: 'info' });
    } catch (e) {
      // 409's detail says why (already finished / running / kind not cancellable).
      if (e?.status === 409) toast(`Job ${job.id}: ${e.message || "can't be cancelled"}`, { type: 'info' });
      else toast(e?.message || 'Cancel failed', { type: 'error' });
    } finally {
      setBusyId(null);
      invalidate(['jobs']);
    }
  };
  return [cancel, busyId];
};

const jobColumns = ({ cancel, busyId }) => [
  { key: 'id', label: 'Job', numeric: true, width: 70, render: j => j.id ?? '—' },
  { key: 'kind', label: 'Kind', render: j => <span className="ibx-kind">{j.kind || '—'}</span> },
  {
    key: 'status', label: 'Status', width: 120,
    render: (j) => { const st = jobStatus(j.status); return <Badge tone={st.tone} dot={isActiveJob(j)}>{st.label}</Badge>; },
  },
  {
    key: 'progress', label: 'Progress', width: 170, sortValue: jobProgress,
    render: (j) => {
      const pct = jobProgress(j);
      if (isActiveJob(j)) {
        return <ProgressBar size="sm" status={j.status} value={j.status === 'running' ? pct : null}
          meta={pct != null && j.status === 'running' ? undefined : ''} ariaLabel={`Job ${j.id} progress`} />;
      }
      return pct == null ? <span className="ibx-subtle">—</span> : <span className="ibx-subtle num">{Math.round(pct)}%</span>;
    },
  },
  {
    key: 'message', label: 'Message', sortable: false,
    render: j => <span className={j.error ? 'ibx-msg is-error' : 'ibx-msg'} title={String(j.error || j.message || '')}>{j.error || j.message || '—'}</span>,
  },
  {
    key: 'created_at', label: 'Created', sortValue: j => toDate(j.created_at)?.getTime(),
    render: j => (
      <span className="ibx-when-cell">
        <span className="ibx-when">{fmtWhen(j.created_at)}</span>
        {fmtDuration(j.started_at, j.finished_at) && <span className="ibx-subtle">ran {fmtDuration(j.started_at, j.finished_at)}</span>}
      </span>
    ),
  },
  {
    key: 'actions', label: '', sortable: false, align: 'right', width: 96,
    render: j => (canCancelJob(j) ? (
      <Button size="sm" variant="ghost" loading={busyId === j.id} aria-label={`Cancel job ${j.id}`}
        onClick={(e) => { e.stopPropagation(); cancel(j); }}>Cancel</Button>
    ) : null),
  },
];

const ActivityTab = () => {
  const [status, setStatus] = React.useState('');
  const q = useJobs({ status: status || undefined, limit: 100 });
  const jobs = React.useMemo(() => (q.data || []).filter(j => j && typeof j === 'object'), [q.data]);
  const [cancel, busyId] = useCancelJob();
  const [openId, setOpenId] = React.useState(null);
  const lastJob = React.useRef(null);

  const idx = openId == null ? -1 : jobs.findIndex(j => j.id === openId);
  const openJob = idx >= 0 ? jobs[idx] : null;
  if (openJob) lastJob.current = openJob;
  const columns = React.useMemo(() => jobColumns({ cancel, busyId }), [busyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = jobs.reduce((acc, j) => { acc[j.status] = (acc[j.status] || 0) + 1; return acc; }, {});
  const summary = ['running', 'queued', 'failed'].filter(s => counts[s]).map(s => `${counts[s]} ${JOB_STATUS[s].label.toLowerCase()}`).join(' · ');

  let body;
  if (!q.live) body = <EmptyState title="Backend offline" description="Start with scripts/run.sh to see background jobs." />;
  else if (q.unavailable) body = <EmptyState title="Job history unavailable" description="This backend doesn't expose /api/jobs yet." />;
  else if (q.error && !q.data) body = <ErrorState title="Job history unavailable" message={q.error.message || 'Request failed'} onRetry={() => q.refetch()} />;
  else body = (
    <DataTable ariaLabel="Background jobs" rows={jobs} rowKey={j => j.id ?? JSON.stringify(j)} columns={columns}
      loading={!q.data} onRowClick={j => setOpenId(j.id)} selectedKey={openId ?? undefined} highlightNew maxHeight={620}
      empty={<EmptyState size="sm" title="No jobs yet" description={status ? `No ${JOB_STATUS[status]?.label.toLowerCase() || status} jobs.` : 'OCR runs, refreshes and imports will show up here.'} />} />
  );

  return (
    <div className="page ibx-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Activity.</h1>
          <p className="page-sub">Background jobs on the backend — OCR, refreshes, imports{q.isFetching ? ' · refreshing…' : ''}</p>
        </div>
        <div className="row ibx-actions">
          <div className="ibx-filter"><Select size="sm" ariaLabel="Filter by status" value={status} onChange={setStatus} options={STATUS_OPTIONS} /></div>
          <Button size="sm" icon="sync" onClick={() => q.refetch().catch(() => {})} disabled={!q.live}>Refresh</Button>
        </div>
      </div>
      <Card title="Jobs" subtitle={q.live && q.data ? (summary || `${jobs.length} job${jobs.length === 1 ? '' : 's'}`) : undefined} flush>
        <div className="ibx-table">{body}</div>
      </Card>
      <JobDetailPanel open={!!openJob} job={openJob || lastJob.current}
        onClose={() => setOpenId(null)}
        onPrev={idx > 0 ? () => setOpenId(jobs[idx - 1].id) : undefined}
        onNext={idx >= 0 && idx < jobs.length - 1 ? () => setOpenId(jobs[idx + 1].id) : undefined}
        indexLabel={idx >= 0 ? `${idx + 1} / ${jobs.length}` : ''}
        onCancel={cancel} cancelling={openJob ? busyId === openJob.id : false} />
    </div>
  );
};

export { ActivityTab };
