// OCR Inbox — upload unlabeled PDFs, send them to a paired worker, review every
// returned row against its source, then label and publish verified data.

const OCR_STATUS = {
  uploaded: ['Uploaded', 'var(--text-muted)'], queued: ['Queued', '#B45309'],
  held: ['Held', '#B45309'],
  processing: ['Processing', '#1D4ED8'], ready_for_review: ['Ready for review', '#7C3AED'],
  reviewing: ['Reviewing', '#7C3AED'], verified: ['Verified · needs labels', '#15803D'],
  ready_to_publish: ['Ready to publish', '#15803D'], published: ['Published', '#15803D'],
  failed: ['Failed', '#B91C1C'],
};

const fmtInboxBytes = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

const InboxStatus = ({ status }) => {
  const spec = OCR_STATUS[status] || [status, 'var(--text-muted)'];
  return <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: spec[1] }}>{spec[0]}</span>;
};

const PageOCRInbox = ({ setPage }) => {
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [uploading, setUploading] = React.useState(false);
  const [reviewItem, setReviewItem] = React.useState(null);
  const inputRef = React.useRef(null);

  const refresh = React.useCallback(async () => {
    if (!window.HelixAPI?.live) { setLoading(false); return; }
    try { setItems(await window.HelixAPI.ocrInbox()); }
    catch (e) { window.toast?.(`Could not load OCR Inbox: ${e.message}`, { type: 'error' }); }
    finally { setLoading(false); }
  }, []);

  React.useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 1800);
    return () => clearInterval(timer);
  }, [refresh]);

  const uploadFiles = async (files, allowDuplicate = false) => {
    if (!files?.length) return;
    if (files.length > 20) { window.toast?.('Choose at most 20 PDFs', { type: 'error' }); return; }
    setUploading(true);
    try {
      await window.HelixAPI.ocrInboxUpload(files, allowDuplicate);
      window.toast?.(`${files.length} PDF${files.length === 1 ? '' : 's'} added to the OCR Inbox`, { type: 'success' });
      await refresh();
    } catch (e) {
      if (e.status === 409 && window.confirm(`${e.message}. Upload another OCR copy anyway?`)) {
        await uploadFiles(files, true);
      } else window.toast?.(e.message || 'Upload failed', { type: 'error' });
    } finally { setUploading(false); if (inputRef.current) inputRef.current.value = ''; }
  };

  const act = async (item, action) => {
    try {
      if (action === 'run') await window.HelixAPI.ocrInboxRun(item.id);
      if (action === 'retry') await window.HelixAPI.ocrInboxRetry(item.id);
      if (action === 'cancel') await window.HelixAPI.ocrInboxCancel(item.id);
      if (action === 'delete' && window.confirm(`Delete ${item.filename} and its OCR history?`)) await window.HelixAPI.ocrInboxDelete(item.id);
      await refresh();
    } catch (e) { window.toast?.(e.message, { type: 'error' }); }
  };

  if (reviewItem) return <OCRReviewWorkspace itemId={reviewItem.id} onBack={() => { setReviewItem(null); refresh(); }} setPage={setPage} />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">OCR Inbox.</h1>
          <p className="page-sub">Send PDFs to the OCR worker before they become financial statements</p>
        </div>
        <button className="btn btn-primary" disabled={uploading || !window.HelixAPI?.live} onClick={() => inputRef.current?.click()}>
          <Icon name="plus" size={12} /> {uploading ? 'Uploading…' : 'Add PDFs'}
        </button>
        <input ref={inputRef} type="file" multiple accept=".pdf,application/pdf" style={{ display: 'none' }} onChange={e => uploadFiles(Array.from(e.target.files || []))} />
      </div>

      {!window.HelixAPI?.live && (
        <div className="card" style={{ padding: 24, color: 'var(--text-muted)' }}>The backend must be running to use the persistent OCR Inbox.</div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-header">
          <h3 className="card-title">Documents</h3>
          <span className="num" style={{ fontSize: 11, color: 'var(--text-muted)' }}>{items.length} stored locally</span>
        </div>
        {loading ? <div style={{ padding: 32, color: 'var(--text-muted)' }}>Loading…</div> : items.length === 0 ? (
          <div onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); uploadFiles(Array.from(e.dataTransfer.files || [])); }}
            style={{ padding: 56, textAlign: 'center', color: 'var(--text-muted)', border: '2px dashed var(--border)', margin: 20, borderRadius: 8 }}>
            <Icon name="download" size={28} style={{ marginBottom: 12 }} />
            <div style={{ fontWeight: 600, color: 'var(--text)' }}>Drop financial-statement PDFs here</div>
            <div style={{ fontSize: 12, marginTop: 5 }}>No ticker or reporting period required yet</div>
          </div>
        ) : items.map(item => (
          <div key={item.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(220px,1.5fr) 150px 130px minmax(220px,auto)', gap: 16, alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.filename}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{item.pages} pages · {fmtInboxBytes(item.size_bytes)}</div>
              {item.error && <div style={{ fontSize: 11, color: 'var(--neg)', marginTop: 4 }}>{item.error}</div>}
            </div>
            <div>
              <InboxStatus status={item.status} />
              {item.attempt && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>{item.attempt.worker || 'Waiting for worker'} · {item.attempt.progress || 0}%</div>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {item.review ? `${item.review.counts.resolved}/${item.review.counts.total} resolved` : 'Not reviewed'}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
              {['uploaded', 'held', 'failed'].includes(item.status) && <button className="btn btn-primary" onClick={() => act(item, item.status === 'failed' ? 'retry' : 'run')}>{item.status === 'failed' ? 'Retry' : item.status === 'held' ? 'Resume OCR' : 'Run OCR'}</button>}
              {item.status === 'queued' && <button className="btn" onClick={() => act(item, 'cancel')}>Cancel</button>}
              {item.review && <button className="btn" onClick={() => setReviewItem(item)}><Icon name="eye" size={12} /> Review</button>}
              {!item.published_filing_id && !['queued', 'processing'].includes(item.status) && <button className="btn" onClick={() => act(item, 'delete')}>Delete</button>}
              {item.published_filing_id && <button className="btn" onClick={() => setPage('statements')}>Open filing</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

const OCRReviewWorkspace = ({ itemId, onBack, setPage }) => {
  const [item, setItem] = React.useState(null);
  const [review, setReview] = React.useState(null);
  const [selectedId, setSelectedId] = React.useState(null);
  const [editing, setEditing] = React.useState(null);
  const [drawing, setDrawing] = React.useState(false);
  const drawStart = React.useRef(null);

  const load = React.useCallback(async () => {
    const nextItem = await window.HelixAPI.ocrInboxItem(itemId);
    setItem(nextItem);
    if (nextItem.review) {
      const nextReview = await window.HelixAPI.ocrReview(nextItem.review.id);
      setReview(nextReview);
      setSelectedId(id => id || nextReview.rows[0]?.id || null);
    }
  }, [itemId]);

  React.useEffect(() => { load().catch(e => window.toast?.(e.message, { type: 'error' })); }, [load]);
  if (!item || !review) return <div className="page"><button className="btn" onClick={onBack}>← Inbox</button><div style={{ padding: 40 }}>Loading review…</div></div>;

  const selected = review.rows.find(row => row.id === selectedId) || review.rows[0];
  const evidence = selected ? (selected.reviewed || selected.raw) : null;
  const selectedBox = selected?.bbox;

  const updateReview = next => { setReview(next); setEditing(null); };
  const rowAction = async (row, action, data, reason) => {
    try { updateReview(await window.HelixAPI.ocrReviewAction(review.id, row.id, action, review.revision, data, reason)); }
    catch (e) { window.toast?.(e.message, { type: 'error' }); if (e.message?.includes('refresh')) load(); }
  };
  const reject = async row => {
    const reason = await window.askPrompt({ title: 'Reject OCR row', label: 'Reason', placeholder: 'Duplicate, header, irrelevant…', confirmText: 'Reject' });
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
      if (editing.mode === 'manual') updateReview(await window.HelixAPI.ocrReviewAdd(review.id, review.revision, data));
      else await rowAction(editing.row, 'correct', data);
    } catch (e) { window.toast?.(e.message, { type: 'error' }); }
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
    try { setReview(await window.HelixAPI.ocrReviewVerify(review.id, review.revision)); await load(); window.toast?.('OCR review verified', { type: 'success' }); }
    catch (e) { window.toast?.(e.message, { type: 'error' }); }
  };

  return (
    <div className="page" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header" style={{ marginBottom: 14 }}>
        <div>
          <button className="card-action" onClick={onBack}>← OCR Inbox</button>
          <h1 className="page-title" style={{ marginTop: 8 }}>{item.filename}</h1>
          <p className="page-sub">{review.counts.resolved} of {review.counts.total} rows resolved · revision {review.revision}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={() => { setDrawing(true); setEditing(null); }}>Add missing row</button>
          <button className="btn btn-primary" disabled={review.counts.pending > 0 || ['verified', 'published'].includes(review.status)} onClick={verify}>Verify review</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(420px,1.15fr) minmax(440px,1fr)', gap: 14, flex: 1, minHeight: 0 }}>
        <div className="card" style={{ overflow: 'auto', padding: 12, background: '#383b40' }}>
          <div style={{ maxWidth: 850, margin: '0 auto', position: 'relative', lineHeight: 0, cursor: drawing ? 'crosshair' : 'default', userSelect: 'none' }}
            onMouseDown={e => { if (drawing) drawStart.current = pointerPos(e); }} onMouseUp={finishDraw}>
            <img src={window.HelixAPI.ocrInboxPageUrl(item.id, selected?.page || 1)} style={{ width: '100%', height: 'auto', display: 'block', background: 'white' }} />
            {selectedBox && !drawing && <div style={{ position: 'absolute', left: `${selectedBox.x * 100}%`, top: `${selectedBox.y * 100}%`, width: `${selectedBox.width * 100}%`, height: `${selectedBox.height * 100}%`, border: '2px solid #F97316', background: 'rgba(249,115,22,.14)', pointerEvents: 'none' }} />}
          </div>
          {drawing && <div style={{ color: 'white', textAlign: 'center', fontSize: 12, padding: 10 }}>Drag a rectangle around the missing source row</div>}
        </div>

        <div className="card" style={{ overflow: 'auto' }}>
          <div className="card-header"><h3 className="card-title">Extracted rows</h3><InboxStatus status={review.status} /></div>
          {review.rows.map(row => {
            const data = row.reviewed || row.raw;
            const active = row.id === selected?.id;
            return <div key={row.id} onClick={() => setSelectedId(row.id)} style={{ padding: '11px 14px', borderBottom: '1px solid var(--border)', background: active ? 'var(--accent-bg)' : 'transparent', cursor: 'pointer' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '52px 1fr 80px 80px', gap: 8, alignItems: 'center' }}>
                <span className="num" style={{ fontSize: 11 }}>{data.code || data.id}</span>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{data.metric || data.label}</span>
                <span className="num" style={{ textAlign: 'right', fontSize: 12 }}>{data.curr}</span>
                <span className="num" style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>{data.prev || '—'}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 7 }}>
                <InboxStatus status={row.status} /><span style={{ fontSize: 10, color: 'var(--text-muted)' }}>p.{row.page} · {row.confidence}%</span><span style={{ flex: 1 }} />
                {!['verified', 'published'].includes(review.status) && <>
                  <button className="card-action" onClick={e => { e.stopPropagation(); rowAction(row, 'approve'); }}>Approve</button>
                  <button className="card-action" onClick={e => { e.stopPropagation(); beginEdit(row); }}>Correct</button>
                  <button className="card-action" onClick={e => { e.stopPropagation(); reject(row); }}>Reject</button>
                  {row.status !== 'pending' && <button className="card-action" onClick={e => { e.stopPropagation(); rowAction(row, 'restore'); }}>Reset</button>}
                </>}
              </div>
              {row.rejection_reason && <div style={{ fontSize: 11, color: 'var(--neg)', marginTop: 5 }}>{row.rejection_reason}</div>}
            </div>;
          })}

          {editing && <OCRRowEditor editing={editing} setField={setField} save={saveEdit} cancel={() => setEditing(null)} />}
          {['verified', 'ready_to_publish', 'published'].includes(item.status) && <OCRPublishPanel item={item} reload={load} setPage={setPage} />}
        </div>
      </div>
    </div>
  );
};

const OCRRowEditor = ({ editing, setField, save, cancel }) => {
  const fields = [['code', 'Code'], ['metric', 'Label'], ['section', 'Section'], ['curr', 'Current'], ['prev', 'Previous'], ['page', 'Page'], ['confidence', 'Confidence']];
  return <div style={{ margin: 14, padding: 14, border: '1px solid var(--accent)', borderRadius: 6, background: 'var(--bg-sunken)' }}>
    <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 10 }}>{editing.mode === 'manual' ? 'Add missing row' : 'Correct OCR row'}</div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 8 }}>
      {fields.map(([key, label]) => <label key={key} style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}<input value={editing.data[key] ?? ''} onChange={e => setField(key, e.target.value)} style={{ display: 'block', width: '100%', marginTop: 3, padding: '7px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-elev)', color: 'var(--text)' }} /></label>)}
    </div>
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 10 }}><button className="btn" onClick={cancel}>Cancel</button><button className="btn btn-primary" onClick={save}>Save row</button></div>
  </div>;
};

const OCRPublishPanel = ({ item, reload, setPage }) => {
  const [labels, setLabels] = React.useState({ company: '', ticker: '', filing_type: 'BCTC', period: '', currency: 'VND', unit: 'million', ...(item.labels || {}) });
  const set = (key, value) => setLabels(x => ({ ...x, [key]: value }));
  const save = async () => { try { await window.HelixAPI.ocrInboxLabels(item.id, labels); await reload(); window.toast?.('Labels saved', { type: 'success' }); } catch (e) { window.toast?.(e.message, { type: 'error' }); } };
  const publish = async () => { try { await window.HelixAPI.ocrInboxPublish(item.id); await reload(); window.toast?.('Verified data published', { type: 'success' }); } catch (e) { window.toast?.(e.message, { type: 'error' }); } };
  if (item.status === 'published') return <div style={{ padding: 16 }}><button className="btn btn-primary" onClick={() => setPage('statements')}>Open published filing</button></div>;
  return <div style={{ padding: 16, borderTop: '2px solid var(--border)' }}>
    <div style={{ fontWeight: 700, marginBottom: 10 }}>Label before publication</div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {Object.entries({ company: 'Company', ticker: 'Ticker', filing_type: 'Statement type', period: 'Period', currency: 'Currency', unit: 'Unit' }).map(([key, label]) => <label key={key} style={{ fontSize: 10, color: 'var(--text-muted)' }}>{label}<input value={labels[key] || ''} onChange={e => set(key, e.target.value)} style={{ display: 'block', width: '100%', marginTop: 3, padding: 7, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-elev)', color: 'var(--text)' }} /></label>)}
    </div>
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7, marginTop: 12 }}><button className="btn" onClick={save}>Save labels</button><button className="btn btn-primary" disabled={item.status !== 'ready_to_publish'} onClick={publish}>Publish verified data</button></div>
  </div>;
};

window.PageOCRInbox = PageOCRInbox;
