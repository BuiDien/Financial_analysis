// OCR Inbox — upload unlabeled PDFs, send them to a paired worker, review every returned row
// against its source, then label and publish verified data. ?ocrReview=<id> opens the focused
// review workspace instead of the list (app.jsx renders this page alone in that mode).

import React from 'react';
import * as SyncPoller from '../../lib/sync-poller.js';
import { handoff } from '../../handoff.js';
import { HelixAPI } from '../../api-client.jsx';
import { askConfirm, Button, Card, EmptyState, IconButton, LxSelect, SkeletonText, toast } from '../../ui';
import { HISTORY_SCOPE_OPTIONS, HISTORY_PERIOD_CODE_OPTIONS, inboxLatestQuarter, historyFiscalYearOptions } from './ocr-inbox-utils.js';
import { reopenVerifiedOcrReview } from './shared.jsx';
import { InboxDocumentRow } from './inbox-document-row.jsx';
import { OCRReviewWorkspace } from './review-workspace.jsx';
import './inbox-ocr.css';

const dropFiles = handler => ({
  onDragOver: e => e.preventDefault(),
  onDrop: e => { e.preventDefault(); handler(Array.from(e.dataTransfer.files || [])); },
});

// Opened from Financial Statements → "Add statement": the company is known; the owner picks
// year, period and scope before dropping the PDF.
const TargetCard = ({ target, setTarget, uploading, choose, uploadFiles, setPage }) => (
  <Card className="ocr-target" overflow {...dropFiles(uploadFiles)}>
    <div className="ocr-target-row">
      <div className="ocr-target-who">
        <div className="ocr-muted">Adding a statement for</div>
        <div className="ticker ocr-target-ticker">{target.ticker}</div>
      </div>
      <div className="ocr-target-field is-year"><LxSelect label="Year" value={target.fiscal_year} options={historyFiscalYearOptions(target.fiscal_year)} onChange={v => setTarget(t => ({ ...t, fiscal_year: Number(v) }))} /></div>
      <div className="ocr-target-field is-period"><LxSelect label="Period" value={target.period_code} options={HISTORY_PERIOD_CODE_OPTIONS} onChange={v => setTarget(t => ({ ...t, period_code: v }))} /></div>
      <div className="ocr-target-field is-scope"><LxSelect label="Scope" value={target.scope} options={HISTORY_SCOPE_OPTIONS} onChange={v => setTarget(t => ({ ...t, scope: v }))} /></div>
      <Button variant="primary" icon="plus" disabled={uploading || !HelixAPI?.live} onClick={choose}>
        {uploading ? 'Uploading…' : `Choose ${target.period_code} ${target.fiscal_year} PDF`}
      </Button>
      <Button onClick={() => { handoff.statementsTicker = target.ticker; setPage && setPage('statements'); }}>Back to {target.ticker}</Button>
      <IconButton icon="close" label="Stop adding for this company" onClick={() => setTarget(null)} />
    </div>
    <p className="ocr-muted ocr-target-hint">Drop the PDF here or choose it. Year, period and scope are saved on it; set the unit while checking the numbers.</p>
  </Card>
);

const PageOCRInbox = ({ setPage }) => {
  const focusedReviewId = new URLSearchParams(window.location.search).get('ocrReview');
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [uploading, setUploading] = React.useState(false);
  const [labelsFor, setLabelsFor] = React.useState(null); // inbox item id whose labels form is open
  const [target, setTarget] = React.useState(() => {
    const hint = handoff.ocrTarget;
    handoff.ocrTarget = null;
    return hint && hint.ticker ? { ticker: String(hint.ticker).toUpperCase(), scope: 'consolidated', ...inboxLatestQuarter() } : null;
  });
  const inputRef = React.useRef(null);

  // One poller: no overlapping requests, back-off while the backend is down, paused in a
  // hidden tab, and one toast per outage (plus one when it comes back).
  const pollerRef = React.useRef(null);
  React.useEffect(() => {
    if (focusedReviewId) return undefined;
    let alive = true;
    const poller = SyncPoller.create({
      intervalMs: 1800,
      maxIntervalMs: 30000,
      run: async () => {
        if (!HelixAPI?.live) { if (alive) setLoading(false); return; }
        try {
          const next = await HelixAPI.ocrInbox();
          if (alive) setItems(next);
        } finally { if (alive) setLoading(false); }
      },
      onError: e => { if (alive) toast?.(`Could not load OCR Inbox: ${e.message} — retrying in the background`, { type: 'error' }); },
      onRecover: () => { if (alive) toast?.('OCR Inbox reconnected', { type: 'success' }); },
    });
    pollerRef.current = poller;
    poller.start();
    return () => { alive = false; poller.stop(); if (pollerRef.current === poller) pollerRef.current = null; };
  }, [focusedReviewId]);
  const refresh = React.useCallback(() => (pollerRef.current ? pollerRef.current.poke() : Promise.resolve()), []);

  const uploadFiles = async (files, allowDuplicate = false) => {
    if (!files?.length) return;
    if (files.length > 20) { toast?.('Choose at most 20 PDFs', { type: 'error' }); return; }
    if (target && files.length > 1) { toast?.(`Add one PDF at a time for ${target.ticker} — each one is a single period`, { type: 'error' }); return; }
    setUploading(true);
    try {
      await HelixAPI.ocrInboxUpload(files, allowDuplicate, target);
      toast?.(target
        ? `Added ${target.ticker} ${target.period_code} ${target.fiscal_year} to the OCR Inbox`
        : `${files.length} PDF${files.length === 1 ? '' : 's'} added to the OCR Inbox`, { type: 'success' });
      await refresh();
    } catch (e) {
      if (e.status === 409 && await askConfirm({ title: 'Upload another OCR copy?', message: `${e.message}. Upload another OCR copy anyway?`, confirmText: 'Upload anyway' })) {
        await uploadFiles(files, true);
      } else toast?.(e.message || 'Upload failed', { type: 'error' });
    } finally { setUploading(false); if (inputRef.current) inputRef.current.value = ''; }
  };

  const act = async (item, action) => {
    try {
      if (action === 'run') await HelixAPI.ocrInboxRun(item.id);
      if (action === 'retry') await HelixAPI.ocrInboxRetry(item.id);
      if (action === 'cancel') await HelixAPI.ocrInboxCancel(item.id);
      if (action === 'delete' && await askConfirm({ title: `Delete ${item.filename}?`, message: 'The PDF and its OCR history are removed from this computer.', confirmText: 'Delete', danger: true })) await HelixAPI.ocrInboxDelete(item.id);
      if (action === 'reopen' && await reopenVerifiedOcrReview(item, item.review)) toast?.(`${item.filename}: review reopened`, { type: 'success' });
      await refresh();
    } catch (e) { toast?.(e.message, { type: 'error' }); }
  };

  if (focusedReviewId) {
    const leaveReview = () => {
      const url = new URL(window.location.href);
      url.searchParams.delete('ocrReview');
      window.location.assign(url.toString());
    };
    return <OCRReviewWorkspace itemId={focusedReviewId} onBack={leaveReview} setPage={setPage} />;
  }

  const live = !!HelixAPI?.live;
  const choose = () => inputRef.current?.click();
  return (
    <div className="page ocr-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">OCR Inbox.</h1>
          <p className="page-sub">Send PDFs to the OCR worker before they become financial statements</p>
        </div>
        <Button variant="primary" icon="plus" disabled={uploading || !live} onClick={choose}>{uploading ? 'Uploading…' : 'Add PDFs'}</Button>
        <input ref={inputRef} type="file" multiple accept=".pdf,application/pdf" hidden onChange={e => uploadFiles(Array.from(e.target.files || []))} />
      </div>

      {!live && <Card className="ocr-offline"><EmptyState plain title="Backend offline" description="The backend must be running to use the persistent OCR Inbox." /></Card>}

      {target && <TargetCard target={target} setTarget={setTarget} uploading={uploading} choose={choose} uploadFiles={uploadFiles} setPage={setPage} />}

      <Card title="Documents" flush actions={<span className="num ocr-muted ocr-small">{items.length} stored locally</span>}>
        {loading ? <div className="ocr-loading" aria-label="Loading documents"><SkeletonText lines={4} /></div> : items.length === 0 ? (
          <div className="ocr-drop" {...dropFiles(uploadFiles)}>
            <EmptyState size="sm" title="Drop financial-statement PDFs here" description="No ticker or reporting period required yet"
              action={live ? { label: 'Choose PDFs', icon: 'plus', onClick: choose } : undefined} />
          </div>
        ) : (
          <ul className="ocr-docs">
            {items.map(item => <InboxDocumentRow key={item.id} item={item} labelsOpen={labelsFor === item.id}
              onToggleLabels={() => setLabelsFor(id => id === item.id ? null : item.id)} act={act} refresh={refresh} setPage={setPage} />)}
          </ul>
        )}
      </Card>
    </div>
  );
};

export { PageOCRInbox };
