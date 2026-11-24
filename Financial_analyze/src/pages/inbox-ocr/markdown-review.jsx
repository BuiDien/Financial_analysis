// Page-Markdown OCR review: sticky toolbar, then the source PDF page beside the extracted page
// (spreadsheet / rendered page / Markdown source). State and actions: use-markdown-review.js.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { Button, Card, ErrorState, IconButton, ProgressBar, SkeletonText } from '../../ui';
import { HISTORY_EMPTY_DRAFT } from './ocr-inbox-utils.js';
import { BackLink, ocrNeedsReopen } from './shared.jsx';
import { useMarkdownReview } from './use-markdown-review.js';
import { ContentHeader, StatusBar } from './markdown-review-parts.jsx';
import { MarkdownPreview } from './markdown-preview.jsx';
import { OCRPublishPanel } from './publish-panel.jsx';
import { OCRHistoryWizard } from './history-wizard.jsx';

const ReviewToolbar = ({ r }) => {
  const { item, review } = r;
  const { resolved, total } = review.counts;
  return <div className="ocr-review-bar">
    <div className="ocr-review-head">
      <BackLink onBack={r.leave} />
      <h1 className="page-title ocr-review-title" title={item.filename}>{item.filename}</h1>
      <div className="ocr-review-progress">
        <p className="page-sub">{resolved} of {total} pages resolved · revision {review.revision}</p>
        <ProgressBar size="sm" ariaLabel="Pages resolved" value={total ? (resolved / total) * 100 : 0} status={total && resolved === total ? 'done' : 'running'} meta="" />
      </div>
    </div>
    <div className="ocr-review-actions">
      <a className="btn btn-sm" href={HelixAPI.ocrReviewMarkdownUrl(review.id, 'raw')} target="_blank" rel="noreferrer">Raw document</a>
      <a className="btn btn-sm" href={HelixAPI.ocrReviewMarkdownUrl(review.id, 'effective')} target="_blank" rel="noreferrer">Reviewed document</a>
      <Button size="sm" aria-expanded={r.labelsOpen} onClick={() => r.setLabelsOpen(open => !open)}>{r.labelsMissing ? 'Labels ⚠' : 'Labels'}</Button>
      {r.canReopen
        ? <Button size="sm" disabled={r.saving} onClick={r.reopen} title="Make this verified review editable again">Reopen review</Button>
        : <Button size="sm" variant="primary" disabled={r.saving || r.dirty || review.counts.pending > 0 || r.visibleHermesSuggestions.length > 0 || r.locked}
          title={r.dirty ? 'Save or discard changes first' : undefined} onClick={r.verify}>Verify review</Button>}
      <Button size="sm" variant="accent" disabled={r.saving || !r.locked} title={r.locked ? 'Turn this verified statement into company history' : 'Verify the review first'} onClick={() => r.setHistoryOpen(true)}>Add to history</Button>
    </div>
  </div>;
};

const PagePane = ({ r }) => (
  <section className="card ocr-scan" aria-label="Source PDF page">
    <div className="ocr-scan-nav">
      <Button size="sm" disabled={r.pageBusy || r.selectedPage <= 1} onClick={() => r.navigate(r.selectedPage - 1)}>← Previous</Button>
      <label className="ocr-inline-field">
        PDF page
        <select className="ocr-select" value={r.selectedPage} disabled={r.pageBusy} onChange={event => r.navigate(Number(event.target.value))}>
          {r.review.pages.map(page => <option key={page.page} value={page.page}>{page.page} · {page.status}{page.total_check?.likely_misreads?.length ? ' · ⚠ totals' : ''}</option>)}
        </select>
        <span className="num">of {r.pageCount}</span>
      </label>
      <Button size="sm" disabled={r.pageBusy || r.selectedPage >= r.pageCount} onClick={() => r.navigate(r.selectedPage + 1)}>Next →</Button>
    </div>
    <div className="ocr-scan-body">
      <div className="ocr-scan-frame">
        <img className="ocr-scan-img" src={HelixAPI.ocrInboxPageUrl(r.item.id, r.selectedPage)} alt={`Source PDF page ${r.selectedPage}`} />
      </div>
    </div>
  </section>
);

const PageContent = ({ r }) => {
  if (r.pageLoading || (!r.pageError && !r.pageReady)) return <div aria-label="Loading Markdown page"><SkeletonText lines={4} /></div>;
  if (r.pageError) return <ErrorState size="sm" title="Could not load this page" message={r.pageError} onRetry={r.loadPage} />;
  if (r.editing) {
    return <textarea className="ocr-md-editor" value={r.markdown} onChange={event => r.updateMarkdown(event.target.value)}
      readOnly={r.busyEditing} aria-busy={r.busyEditing || undefined}
      aria-label={`Correct Markdown for page ${r.selectedPage}`} spellCheck="false" />;
  }
  if (r.viewMode === 'tables') {
    return <MarkdownPreview markdown={r.markdown} tablesOnly interactiveTables onMarkdownChange={r.locked || r.busyEditing ? null : r.updateMarkdown} levelVerification={r.levelVerification} mismatchTarget={r.mismatchTarget} onSelectionSummary={r.updateSelectionSummary} labelSuggestions={r.visibleHermesSuggestions} markedLabelRows={r.markedHermesRows} onToggleLabelMark={r.locked ? null : r.toggleHermesLabelMark} onAskHermesForLabel={r.locked ? null : target => r.startHermesLabelReview([target])} onDecideLabelSuggestion={r.locked ? null : r.decideHermesSuggestion} />;
  }
  if (r.viewMode === 'preview') return <MarkdownPreview markdown={r.markdown} />;
  return <pre className="ocr-pre ocr-source">{r.markdown || 'This page contains no OCR text.'}</pre>;
};

const OCRMarkdownReviewWorkspace = ({ item, review, setReview, reload, onBack }) => {
  const r = useMarkdownReview({ item, review, setReview, reload, onBack });
  return (
    <div className="page ocr-page ocr-review">
      <ReviewToolbar r={r} />

      {r.actionError && <div role="alert" className="ocr-alert">
        <span>{r.actionError}</span>
        {ocrNeedsReopen(r.actionError) && r.canReopen && <Button size="sm" disabled={r.saving} onClick={r.reopen}>Reopen review</Button>}
      </div>}
      {r.staleNotice && <div role="status" className="ocr-notice">
        <span>{r.staleNotice}</span>
        <Button size="sm" onClick={r.reloadPage}>Reload page</Button>
        <IconButton icon="close" size="sm" label="Dismiss" onClick={() => r.setStaleNotice('')} />
      </div>}
      {r.labelsOpen && <Card className="ocr-labels-card" flush>
        <OCRPublishPanel key={`${item.id}-${review.revision}`} item={item} reload={reload} setPage={() => {}} canPublish={false} title="Upload labels" />
      </Card>}
      {r.historyOpen && <OCRHistoryWizard item={item} review={review} draft={r.historyDraft} setDraft={r.setHistoryDraft}
        onClose={() => r.setHistoryOpen(false)}
        onOpenLabels={() => { r.setHistoryOpen(false); r.setLabelsOpen(true); }}
        onWritten={async () => { r.setHistoryOpen(false); r.setHistoryDraft(HISTORY_EMPTY_DRAFT); await reload(); }} />}

      <div className="ocr-split">
        <PagePane r={r} />
        <section className="card ocr-pane" aria-label="Extracted page">
          <ContentHeader r={r} />
          <div className={`ocr-pane-body${r.busyEditing ? ' is-busy' : ''}`} aria-busy={r.busyEditing || undefined}><PageContent r={r} /></div>
          {r.pageReady && !r.pageError && (!r.locked || (!r.editing && r.viewMode === 'tables')) && <StatusBar r={r} />}
        </section>
      </div>
    </div>
  );
};

export { OCRMarkdownReviewWorkspace };
