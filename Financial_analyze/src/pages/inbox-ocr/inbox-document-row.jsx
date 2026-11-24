// One document in the OCR Inbox list: name + labels chip, status and OCR attempt progress,
// review progress, and the row actions. Labels open inline below the row.

import React from 'react';
import { Button, ProgressBar, cx } from '../../ui';
import { Icon } from '../../icons.jsx';
import { fmtInboxBytes, inboxLabelSummary } from './ocr-inbox-utils.js';
import { InboxStatus, openStatementsFor } from './shared.jsx';
import { OCRPublishPanel } from './publish-panel.jsx';

// OCR attempt → ProgressBar status. Queued animates (waiting for a worker); held is paused, so it
// shows a static partial fill; processing fills; failed turns red.
const ATTEMPT_BAR = { queued: 'queued', held: 'running', processing: 'running', failed: 'failed' };

const reviewHref = id => {
  const url = new URL(window.location.href);
  url.searchParams.set('ocrReview', id);
  return url.toString();
};

const AttemptProgress = ({ item }) => {
  const { attempt } = item;
  if (!attempt) return null;
  const bar = ATTEMPT_BAR[item.status];
  const who = attempt.worker || 'Waiting for worker';
  const pages = attempt.expected_pages ? ` · ${attempt.received_pages || 0}/${attempt.expected_pages} pages` : '';
  if (!bar) return <div className="ocr-muted ocr-small">{who} · {attempt.progress || 0}%</div>;
  return <ProgressBar size="sm" className="ocr-doc-bar" ariaLabel={`OCR progress for ${item.filename}`}
    value={item.status === 'queued' ? null : attempt.progress || 0} status={bar}
    label={`${who}${pages}`} meta={item.status === 'queued' ? 'queued' : item.status === 'held' ? `paused · ${attempt.progress || 0}%` : `${attempt.progress || 0}%`} />;
};

const InboxDocumentRow = ({ item, labelsOpen, onToggleLabels, act, refresh, setPage }) => {
  const summary = inboxLabelSummary(item.labels);
  const review = item.review;
  return (
    <li className="ocr-doc">
      <div className="ocr-doc-row">
        <div className="ocr-doc-main">
          <div className="ocr-doc-name" title={item.filename}>{item.filename}</div>
          <div className="ocr-muted ocr-small">{item.pages} pages · {fmtInboxBytes(item.size_bytes)}</div>
          <button type="button" className={cx('ocr-chip', !summary && 'is-missing')} onClick={onToggleLabels} aria-expanded={labelsOpen}>
            {summary || '⚠ No labels — set ticker & period'}
          </button>
          {item.error && <div className="ocr-error-text ocr-small">{item.error}</div>}
        </div>
        <div className="ocr-doc-status">
          <InboxStatus status={item.status} />
          <AttemptProgress item={item} />
          {review ? <div className="ocr-doc-review">
            <div className="ocr-small"><span className="num">{review.counts.resolved}/{review.counts.total}</span> resolved</div>
            <ProgressBar size="sm" className="ocr-doc-bar" ariaLabel={`Review progress for ${item.filename}`}
              value={review.counts.total ? (review.counts.resolved / review.counts.total) * 100 : 0}
              status={review.counts.total && review.counts.resolved === review.counts.total ? 'done' : 'running'} meta="" />
          </div> : <div className="ocr-muted ocr-small">Not reviewed</div>}
        </div>
        <div className="ocr-doc-actions">
          {['uploaded', 'held', 'failed'].includes(item.status) && <Button size="sm" variant="primary" onClick={() => act(item, item.status === 'failed' ? 'retry' : 'run')}>{item.status === 'failed' ? 'Retry' : item.status === 'held' ? 'Resume OCR' : 'Run OCR'}</Button>}
          {item.status === 'queued' && <Button size="sm" onClick={() => act(item, 'cancel')}>Cancel</Button>}
          {review?.status === 'verified' && !item.published_filing_id && <Button size="sm" title="Make this verified review editable again" onClick={() => act(item, 'reopen')}>Reopen review</Button>}
          {review && <a className="btn btn-sm" href={reviewHref(item.id)} target="_blank" rel="noopener noreferrer"><Icon name="eye" size={12} /> Open review</a>}
          {!item.published_filing_id && !['queued', 'processing'].includes(item.status) && <Button size="sm" variant="ghost" onClick={() => act(item, 'delete')}>Delete</Button>}
          {item.published_filing_id && <Button size="sm" onClick={() => openStatementsFor(item, setPage)}>Open filing</Button>}
          {!item.published_filing_id && <Button size="sm" aria-expanded={labelsOpen} onClick={onToggleLabels}>Labels</Button>}
        </div>
      </div>
      {labelsOpen && <OCRPublishPanel key={`labels-${item.id}`} item={item} reload={refresh} setPage={setPage} canPublish={false} title="Upload labels" />}
    </li>
  );
};

export { InboxDocumentRow };
