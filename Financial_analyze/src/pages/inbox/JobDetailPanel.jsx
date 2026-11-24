// Job detail side panel: lifecycle steps, progress, message/error and raw payload/result.

import React from 'react';
import { Badge, Button, JobSteps, ProgressBar, SidePanel } from '../../ui';
import {
  canCancelJob, fmtDuration, isActiveJob, jobLifecycleSteps, jobProgress, jobStatus, prettyJson,
} from './job-utils.js';

const JsonBlock = ({ label, value }) => {
  const text = prettyJson(value);
  if (!text) return null;
  return (
    <div className="ibx-detail-block">
      <div className="ibx-detail-label">{label}</div>
      <pre className="ibx-json">{text}</pre>
    </div>
  );
};

const JobDetailPanel = ({ open, job, onClose, onPrev, onNext, indexLabel, onCancel, cancelling }) => {
  const st = job ? jobStatus(job.status) : null;
  const pct = job ? jobProgress(job) : null;
  return (
    <SidePanel open={!!open && !!job} onClose={onClose} onPrev={onPrev} onNext={onNext} indexLabel={indexLabel}
      contentKey={job?.id} title={job ? `Job ${job.id}` : ''} subtitle={job?.kind || ''}>
      {job && (
        <div className="ibx-detail">
          <div className="ibx-detail-head">
            <Badge tone={st.tone} dot>{st.label}</Badge>
            <span className="ibx-muted">{fmtDuration(job.started_at, job.finished_at) || '—'}</span>
            {canCancelJob(job) && (
              <Button size="sm" variant="danger" icon="close" loading={cancelling} onClick={() => onCancel(job)}>Cancel job</Button>
            )}
          </div>

          {isActiveJob(job) && (
            <ProgressBar size="sm" status={job.status} value={job.status === 'running' ? pct : null}
              label={job.message || (job.status === 'queued' ? 'Waiting for a worker slot' : 'Working')}
              ariaLabel={`Job ${job.id} progress`} />
          )}

          <JobSteps bare={false} steps={jobLifecycleSteps(job)} startedAt={job.created_at} finishedAt={job.finished_at}
            workingLabel={job.status === 'queued' ? 'Queued' : 'Running'}
            failedLabel={job.status === 'cancelled' ? 'Cancelled' : 'Failed'} ariaLabel="Job lifecycle" />


          {job.message && !job.error && (
            <div className="ibx-detail-block">
              <div className="ibx-detail-label">Message</div>
              <p className="ibx-detail-text">{job.message}</p>
            </div>
          )}
          {job.error && (
            <div className="ibx-detail-block">
              <div className="ibx-detail-label">Error</div>
              <pre className="ibx-json is-error">{prettyJson(job.error)}</pre>
            </div>
          )}
          <JsonBlock label="Payload" value={job.payload} />
          <JsonBlock label="Result" value={job.result} />
        </div>
      )}
    </SidePanel>
  );
};

export { JobDetailPanel };
