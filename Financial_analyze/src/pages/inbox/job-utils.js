// Shared helpers for background-job views (Activity tab, job detail panel).
// Jobs come from GET /api/jobs: { id, kind, status: queued|running|done|failed|cancelled,
// progress, message, payload, result, error, cancellable, created_at, started_at, finished_at }.

import { formatDateTime, toDate } from '../../lib/format.js';

export { toDate };

export const JOB_STATUS = {
  queued: { label: 'Queued', tone: 'warn' },
  running: { label: 'Running', tone: 'accent' },
  done: { label: 'Done', tone: 'pos' },
  failed: { label: 'Failed', tone: 'neg' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const jobStatus = (s) => JOB_STATUS[s] || { label: s || 'Unknown', tone: 'neutral' };

export const isActiveJob = (j) => j && (j.status === 'queued' || j.status === 'running');

// The backend says per job whether POST /cancel would be accepted
// (`cancellable`); without it, only a queued job is offered Cancel.
export const canCancelJob = (j) => !!j && j.id != null && isActiveJob(j)
  && (typeof j.cancellable === 'boolean' ? j.cancellable : j.status === 'queued');

export const fmtWhen = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  return toDate(v) ? formatDateTime(v) : String(v);
};

export const fmtDuration = (start, end) => {
  const a = toDate(start);
  if (!a) return '';
  const b = end ? toDate(end) : new Date();
  if (!b || b < a) return '';
  const s = Math.round((b - a) / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

export const jobProgress = (j) => {
  const n = Number(j?.progress);
  return j?.progress != null && Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
};

// Lifecycle → JobSteps rows (queued → started → finished/failed/cancelled).
export const jobLifecycleSteps = (j) => {
  const st = j?.status;
  const ended = st === 'done' || st === 'failed' || st === 'cancelled';
  const started = Boolean(j?.started_at) || st === 'running' || (ended && st !== 'cancelled');
  const finalLabel = st === 'failed' ? 'Failed' : st === 'cancelled' ? 'Cancelled' : 'Finished';
  return [
    { key: 'queued', label: 'Queued', status: 'done', meta: fmtWhen(j?.created_at) },
    {
      key: 'started', label: 'Started',
      status: started ? 'done' : st === 'cancelled' ? 'fail' : 'wait',
      meta: j?.started_at ? fmtWhen(j.started_at) : undefined,
    },
    {
      key: 'end', label: st === 'running' ? `Running${jobProgress(j) != null ? ` · ${Math.round(jobProgress(j))}%` : ''}` : finalLabel,
      status: st === 'running' ? 'run' : st === 'done' ? 'done' : st === 'failed' || st === 'cancelled' ? 'fail' : 'wait',
      meta: j?.finished_at ? fmtWhen(j.finished_at) : undefined,
    },
  ];
};

export const prettyJson = (v) => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};
