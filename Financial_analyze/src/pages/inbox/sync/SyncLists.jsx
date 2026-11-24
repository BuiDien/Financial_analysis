// Sync side lists: OCR Inbox PDFs to dispatch, and the connected worker laptops.

import React from 'react';
import { Icon } from '../../../icons.jsx';
import { Badge, Button, Card, EmptyState, Skeleton } from '../../../ui';

const prettyStatus = (s) => String(s || '').replaceAll('_', ' ');
const ACTIVE_JOB_DONE = ['done', 'failed', 'held', 'stopped'];

const DispatchCard = ({ inboxItems, inboxLoading, jobs, listening, workers, onDispatch, setPage }) => (
  <Card title="Dispatch a filing for OCR" subtitle={`${inboxItems.length} in OCR Inbox`} flush>
    {inboxLoading ? (
      <div className="syn-list-pad"><Skeleton height={40} /><Skeleton height={40} /></div>
    ) : inboxItems.length === 0 ? (
      <EmptyState size="sm" title="No PDFs in OCR Inbox yet" description="Upload a PDF there, then dispatch it here."
        action={{ label: 'Go to OCR Inbox', onClick: () => setPage('ocr-inbox') }} />
    ) : (
      <ul className="syn-list" aria-label="OCR Inbox PDFs">
        {inboxItems.map((item) => {
          const pending = jobs.find(j => j.inboxItemId === item.id && !ACTIVE_JOB_DONE.includes(j.status));
          const canDispatch = ['uploaded', 'held', 'failed'].includes(item.status);
          const blocked = !listening || !workers.length || !!pending;
          return (
            <li key={item.id} className="syn-row">
              <div className="syn-row-main">
                <div className="syn-row-title" title={item.filename}>{item.filename}</div>
                <div className="syn-row-sub">{item.pages} pages · {prettyStatus(item.status)}</div>
              </div>
              {canDispatch ? (
                <Button size="sm" icon={pending ? null : 'sync'} disabled={blocked} onClick={() => onDispatch(item)}
                  title={!listening ? 'Start listening first' : !workers.length ? 'Pair a worker first' : undefined}>
                  {pending ? 'In queue…' : item.status === 'failed' ? 'Retry OCR' : item.status === 'held' ? 'Resume OCR' : 'Send to worker'}
                </Button>
              ) : item.review ? (
                <Button size="sm" onClick={() => setPage('ocr-inbox')}>Open in Inbox</Button>
              ) : <Badge tone="neutral" sans>{prettyStatus(item.status)}</Badge>}
            </li>
          );
        })}
      </ul>
    )}
  </Card>
);

const WorkersCard = ({ workers, listening }) => (
  <Card title="Connected workers" subtitle={workers.length ? `${workers.length} paired` : undefined} flush>
    {workers.length === 0 ? (
      <EmptyState size="sm" plain title={listening ? 'Waiting for a worker to pair…' : 'No workers connected'}
        description={listening ? 'Run the OCR agent on the worker laptop with the pairing code.' : 'Start listening, then connect a worker laptop with the pairing code.'} />
    ) : (
      <ul className="syn-list" aria-label="Connected workers">
        {workers.map(w => (
          <li key={w.id} className="syn-row">
            <span className="syn-avatar" aria-hidden="true"><Icon name="laptop" size={18} /></span>
            <div className="syn-row-main">
              <div className="syn-row-title">{w.name}</div>
              <div className="syn-row-sub num">{w.ip} · {w.done} parsed</div>
            </div>
            <Badge tone={w.status === 'busy' ? 'accent' : 'pos'} dot>{w.status === 'busy' ? 'Working' : 'Idle'}</Badge>
          </li>
        ))}
      </ul>
    )}
  </Card>
);

export { DispatchCard, WorkersCard };
