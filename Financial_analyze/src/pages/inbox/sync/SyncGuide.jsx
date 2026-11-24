// Sync: live pairing checklist ("Connect a worker laptop") and the coordinator event log.

import React from 'react';
import { Card, CopyButton, EmptyState, JobSteps } from '../../../ui';

const PairingSteps = ({ live, listening, workers, jobs, wsUrl, pairCode }) => {
  const paired = workers.length > 0;
  const dispatched = jobs.length > 0;
  const returned = jobs.some(j => j.status === 'done');
  const command = `python -m worker --connect ${wsUrl} --code ${pairCode}`;
  const steps = [
    { key: 'backend', label: 'Backend running', status: live ? 'done' : 'fail', meta: live ? undefined : 'scripts/run.sh' },
    { key: 'listen', label: 'Start listening on this machine', status: listening ? 'done' : live ? 'run' : 'wait' },
    { key: 'pair', label: 'Worker laptop paired', status: paired ? 'done' : listening ? 'run' : 'wait', meta: paired ? workers.map(w => w.name).join(', ') : undefined },
    { key: 'send', label: 'Send an OCR Inbox PDF', status: dispatched ? 'done' : paired ? 'run' : 'wait' },
    { key: 'review', label: 'Review returned rows in OCR Inbox', status: returned ? 'done' : dispatched ? 'run' : 'wait' },
  ];
  return (
    <Card title="Connect a worker laptop" subtitle="Both laptops must be on the same network">
      <JobSteps bare steps={steps} ariaLabel="Worker pairing" />
      <div className="syn-cmd">
        <div className="syn-cell-label">On the worker laptop, run the OCR agent</div>
        <div className="syn-cmd-row">
          <code className="syn-code is-block">{command}</code>
          <CopyButton size="sm" text={command} label="Copy command" />
        </div>
      </div>
    </Card>
  );
};

const LOG_TAG = { sys: 'SYS', worker: 'WORKER', out: 'SENT→', in: '←RECV', error: 'ERR' };

const SyncLogCard = ({ log }) => (
  <Card title="Activity" subtitle="Coordinator events this session" flush>
    {log.length === 0 ? (
      <EmptyState size="sm" plain title="Events appear here." />
    ) : (
      <ol className="syn-log" aria-label="Coordinator events">
        {log.map(e => (
          <li key={e.id} className={`syn-log-row is-${LOG_TAG[e.kind] ? e.kind : 'sys'}`}>
            <time className="syn-log-time">{e.ts.toLocaleTimeString('en-US', { hour12: false })}</time>
            <span className="syn-log-tag">{LOG_TAG[e.kind] || 'LOG'}</span>
            <span className="syn-log-text">{e.text}</span>
          </li>
        ))}
      </ol>
    )}
  </Card>
);

export { PairingSteps, SyncLogCard };
