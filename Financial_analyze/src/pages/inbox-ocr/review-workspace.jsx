// OCR Inbox — focused review workspace (?ocrReview=<item id>). Loads the item and its review, then
// hands over to the page-Markdown review (page_markdown_v2) or the legacy structured-row review.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { Button, Card, ErrorState, JobSteps, SkeletonText } from '../../ui';
import { BackLink, InboxStatus } from './shared.jsx';
import { OCRRowReview } from './row-review.jsx';
import { OCRMarkdownReviewWorkspace } from './markdown-review.jsx';
import './inbox-ocr.css';

// Where a document without a review stands: upload → OCR worker → review.
const lifecycleSteps = item => {
  const status = item?.status;
  const attempt = item?.attempt;
  const pages = attempt?.expected_pages ? `${attempt.received_pages || 0}/${attempt.expected_pages} pages` : attempt ? `${attempt.progress || 0}%` : null;
  return [
    { label: 'Uploaded', status: 'done', meta: item?.pages ? `${item.pages} pages` : null },
    { label: status === 'held' ? 'Held — resume from the inbox' : 'Queued for the OCR worker', status: !attempt ? 'wait' : ['queued', 'held'].includes(status) ? 'run' : 'done', meta: attempt?.worker || null },
    { label: 'OCR running', status: status === 'processing' ? 'run' : status === 'failed' ? 'fail' : attempt && !['queued', 'held', 'uploaded'].includes(status) ? 'done' : 'wait', meta: pages },
    { label: 'Ready for review', status: 'wait' },
  ];
};

const OCRReviewWorkspace = ({ itemId, onBack, setPage }) => {
  const [item, setItem] = React.useState(null);
  const [review, setReview] = React.useState(null);
  // loading → ready, or error / no-review (each with Retry and Back) instead of an endless spinner.
  const [loadState, setLoadState] = React.useState('loading');
  const [loadError, setLoadError] = React.useState('');

  // Also handed to the workspaces as `reload`; they catch its errors themselves.
  const load = React.useCallback(async () => {
    const nextItem = await HelixAPI.ocrInboxItem(itemId);
    setItem(nextItem);
    if (nextItem.review) {
      const nextReview = await HelixAPI.ocrReview(nextItem.review.id);
      setReview(nextReview);
      setLoadState('ready');
    } else {
      setLoadState(state => (state === 'ready' ? state : 'no-review'));
    }
  }, [itemId]);

  const firstLoad = React.useCallback(() => {
    setLoadState('loading');
    setLoadError('');
    return load().catch(e => { setLoadError(e.message || 'Could not load this OCR review'); setLoadState('error'); });
  }, [load]);

  React.useEffect(() => { firstLoad(); }, [firstLoad]);
  if (loadState !== 'ready' || !item || !review) {
    return <div className="page ocr-page">
      <BackLink onBack={onBack} />
      {loadState === 'error' ? (
        <Card className="ocr-state" role="alert">
          <ErrorState title="Could not load this review" message={loadError} label="Review unavailable" onRetry={firstLoad} />
          <div className="ocr-actions-center"><Button onClick={onBack}>Back to OCR Inbox</Button></div>
        </Card>
      ) : loadState === 'no-review' ? (
        <Card className="ocr-state" role="status" title={`${item?.filename || 'This document'} has no OCR review yet`}
          subtitle="The review opens once the OCR worker returns this PDF. Run OCR from the inbox, then retry."
          actions={item?.status && <InboxStatus status={item.status} />}>
          <JobSteps steps={lifecycleSteps(item)} bare ariaLabel="OCR progress" />
          <div className="ocr-actions-start"><Button variant="primary" onClick={firstLoad}>Retry</Button><Button onClick={onBack}>Back to OCR Inbox</Button></div>
        </Card>
      ) : <Card className="ocr-state" aria-label="Loading review"><SkeletonText lines={5} /></Card>}
    </div>;
  }

  if (review.result_format === 'page_markdown_v2') {
    return <OCRMarkdownReviewWorkspace item={item} review={review} setReview={setReview} reload={load} onBack={onBack} />;
  }
  return <OCRRowReview item={item} review={review} setReview={setReview} load={load} onBack={onBack} setPage={setPage} />;
};

export { OCRReviewWorkspace };
