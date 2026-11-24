// Legacy structured-row OCR review: the scanned page with the selected row's box on the left,
// extracted rows (approve / correct / reject / reset) on the right. Draw a box to add a missing row.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { askPrompt, Button, Card, toast, cx } from '../../ui';
import { BackLink, InboxStatus, reopenVerifiedOcrReview } from './shared.jsx';
import { OCRPublishPanel } from './publish-panel.jsx';

const ROW_FIELDS = [['code', 'Code'], ['metric', 'Label'], ['section', 'Section'], ['curr', 'Current'], ['prev', 'Previous'], ['page', 'Page'], ['confidence', 'Confidence']];

const OCRRowEditor = ({ editing, setField, save, cancel }) => (
  <div className="ocr-row-editor">
    <div className="ocr-row-editor-title">{editing.mode === 'manual' ? 'Add missing row' : 'Correct OCR row'}</div>
    <div className="ocr-row-editor-grid">
      {ROW_FIELDS.map(([key, label]) => <label key={key} className="ocr-field">{label}<input className="ocr-input" value={editing.data[key] ?? ''} onChange={e => setField(key, e.target.value)} /></label>)}
    </div>
    <div className="ocr-actions-end"><Button size="sm" onClick={cancel}>Cancel</Button><Button size="sm" variant="primary" onClick={save}>Save row</Button></div>
  </div>
);

const OCRRowReview = ({ item, review, setReview, load, onBack, setPage }) => {
  const [selectedId, setSelectedId] = React.useState(null);
  const [editing, setEditing] = React.useState(null);
  const [drawing, setDrawing] = React.useState(false);
  const drawStart = React.useRef(null);

  const selected = review.rows.find(row => row.id === selectedId) || review.rows[0];
  const selectedBox = selected?.bbox;
  const locked = ['verified', 'published'].includes(review.status);

  const updateReview = next => { setReview(next); setEditing(null); };
  const rowAction = async (row, action, data, reason) => {
    try { updateReview(await HelixAPI.ocrReviewAction(review.id, row.id, action, review.revision, data, reason)); }
    catch (e) { toast?.(e.message, { type: 'error' }); if (e.message?.includes('refresh')) load(); }
  };
  const reject = async row => {
    const reason = await askPrompt({ title: 'Reject OCR row', label: 'Reason', placeholder: 'Duplicate, header, irrelevant…', confirmText: 'Reject' });
    if (reason) rowAction(row, 'reject', null, reason);
  };
  const beginEdit = row => {
    const source = row.reviewed || row.raw;
    setEditing({ mode: 'correct', row, data: { ...source, bbox: { ...row.bbox }, page: row.page, confidence: row.confidence } });
  };
  const setField = (field, value) => setEditing(e => ({ ...e, data: { ...e.data, [field]: value } }));
  const saveEdit = async () => {
    const data = { ...editing.data, page: Number(editing.data.page), confidence: Number(editing.data.confidence) };
    try {
      if (editing.mode === 'manual') updateReview(await HelixAPI.ocrReviewAdd(review.id, review.revision, data));
      else await rowAction(editing.row, 'correct', data);
    } catch (e) { toast?.(e.message, { type: 'error' }); }
  };

  const pointerPos = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)) };
  };
  const finishDraw = e => {
    if (!drawing || !drawStart.current) return;
    const end = pointerPos(e), start = drawStart.current;
    const bbox = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
    setDrawing(false); drawStart.current = null;
    if (bbox.width < .01 || bbox.height < .01) return;
    setEditing({ mode: 'manual', data: { code: '', metric: '', section: 'balance', curr: '', prev: '', page: selected?.page || 1, confidence: 100, bbox } });
  };

  const verify = async () => {
    try { setReview(await HelixAPI.ocrReviewVerify(review.id, review.revision)); await load(); toast?.('OCR review verified', { type: 'success' }); }
    catch (e) { toast?.(e.message, { type: 'error' }); }
  };
  const reopen = async () => {
    try {
      const result = await reopenVerifiedOcrReview(item, review);
      if (!result) return;
      await load();
      toast?.('Review reopened — verify it again when done', { type: 'success' });
    } catch (e) { toast?.(e.message, { type: 'error' }); }
  };

  return (
    <div className="page ocr-page ocr-review">
      <div className="ocr-review-bar">
        <div className="ocr-review-head">
          <BackLink onBack={onBack} />
          <h1 className="page-title ocr-review-title">{item.filename}</h1>
          <p className="page-sub">{review.counts.resolved} of {review.counts.total} rows resolved · revision {review.revision}</p>
        </div>
        <div className="ocr-review-actions">
          <Button onClick={() => { setDrawing(true); setEditing(null); }}>Add missing row</Button>
          {review.status === 'verified'
            ? <Button onClick={reopen} title="Make this verified review editable again">Reopen review</Button>
            : <Button variant="primary" disabled={review.counts.pending > 0 || review.status === 'published'} onClick={verify}>Verify review</Button>}
        </div>
      </div>

      <div className="ocr-split">
        <section className="card ocr-scan" aria-label="Source page">
          <div className="ocr-scan-body">
            <div className={cx('ocr-scan-frame', drawing && 'is-drawing')}
              onMouseDown={e => { if (drawing) drawStart.current = pointerPos(e); }} onMouseUp={finishDraw}>
              <img className="ocr-scan-img" src={HelixAPI.ocrInboxPageUrl(item.id, selected?.page || 1)} alt={`Source PDF page ${selected?.page || 1}`} />
              {selectedBox && !drawing && <div className="ocr-bbox" style={{ left: `${selectedBox.x * 100}%`, top: `${selectedBox.y * 100}%`, width: `${selectedBox.width * 100}%`, height: `${selectedBox.height * 100}%` }} />}
            </div>
            {drawing && <div className="ocr-scan-hint">Drag a rectangle around the missing source row</div>}
          </div>
        </section>

        <Card className="ocr-pane" title="Extracted rows" actions={<InboxStatus status={review.status} />} flush>
          <ul className="ocr-rows" aria-label="Extracted rows">
            {review.rows.map(row => {
              const data = row.reviewed || row.raw;
              const active = row.id === selected?.id;
              return <li key={row.id} className={cx('ocr-xrow', active && 'is-active')} onClick={() => setSelectedId(row.id)}>
                <button type="button" className="ocr-xrow-main" aria-pressed={active} onClick={() => setSelectedId(row.id)}>
                  <span className="num ocr-small">{data.code || data.id}</span>
                  <span className="ocr-xrow-label">{data.metric || data.label}</span>
                  <span className="num ocr-al-right">{data.curr}</span>
                  <span className="num ocr-al-right ocr-muted ocr-small">{data.prev || '—'}</span>
                </button>
                <div className="ocr-xrow-meta">
                  <InboxStatus status={row.status} /><span className="ocr-muted ocr-tiny">p.{row.page} · {row.confidence}%</span><span className="ocr-grow" />
                  {!locked && <>
                    <button type="button" className="card-action" onClick={e => { e.stopPropagation(); rowAction(row, 'approve'); }}>Approve</button>
                    <button type="button" className="card-action" onClick={e => { e.stopPropagation(); beginEdit(row); }}>Correct</button>
                    <button type="button" className="card-action" onClick={e => { e.stopPropagation(); reject(row); }}>Reject</button>
                    {row.status !== 'pending' && <button type="button" className="card-action" onClick={e => { e.stopPropagation(); rowAction(row, 'restore'); }}>Reset</button>}
                  </>}
                </div>
                {row.rejection_reason && <div className="ocr-error-text ocr-small">{row.rejection_reason}</div>}
              </li>;
            })}
          </ul>
          {editing && <OCRRowEditor editing={editing} setField={setField} save={saveEdit} cancel={() => setEditing(null)} />}
          {['verified', 'ready_to_publish', 'published'].includes(item.status) && <OCRPublishPanel item={item} reload={load} setPage={setPage} />}
        </Card>
      </div>
    </div>
  );
};

export { OCRRowReview };
