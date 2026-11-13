// OCR Inbox — focused review workspaces (?ocrReview=<item id>): the legacy row review and
// the page-Markdown review. Split out of page-ocr-inbox.jsx.

const OCRReviewWorkspace = ({ itemId, onBack, setPage }) => {
  const [item, setItem] = React.useState(null);
  const [review, setReview] = React.useState(null);
  const [selectedId, setSelectedId] = React.useState(null);
  const [editing, setEditing] = React.useState(null);
  const [drawing, setDrawing] = React.useState(false);
  const drawStart = React.useRef(null);

  // loading → ready, or error / no-review (each with Retry and Back) instead of an endless spinner.
  const [loadState, setLoadState] = React.useState('loading');
  const [loadError, setLoadError] = React.useState('');

  // Also handed to the workspaces as `reload`; they catch its errors themselves.
  const load = React.useCallback(async () => {
    const nextItem = await window.HelixAPI.ocrInboxItem(itemId);
    setItem(nextItem);
    if (nextItem.review) {
      const nextReview = await window.HelixAPI.ocrReview(nextItem.review.id);
      setReview(nextReview);
      setSelectedId(id => id || nextReview.rows?.[0]?.id || null);
      setLoadState('ready');
    } else {
      setLoadState(state => (state === 'ready' ? state : 'no-review'));
    }
  }, [itemId]);

  const firstLoad = React.useCallback(() => {
    setLoadState('loading');
    setLoadError('');
    load().catch(e => { setLoadError(e.message || 'Could not load this OCR review'); setLoadState('error'); });
  }, [load]);

  React.useEffect(() => { firstLoad(); }, [firstLoad]);
  if (loadState !== 'ready' || !item || !review) {
    return <div className="page">
      <button className="card-action" onClick={onBack}>← OCR Inbox</button>
      {loadState === 'error' ? (
        <div role="alert" className="card" style={{ marginTop: 14, padding: 20 }}>
          <div style={{ fontWeight: 700, color: 'var(--neg)' }}>Could not load this review</div>
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)' }}>{loadError}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}><button className="btn btn-primary" onClick={firstLoad}>Retry</button><button className="btn" onClick={onBack}>Back to OCR Inbox</button></div>
        </div>
      ) : loadState === 'no-review' ? (
        <div role="status" className="card" style={{ marginTop: 14, padding: 20 }}>
          <div style={{ fontWeight: 700 }}>{item?.filename || 'This document'} has no OCR review yet</div>
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {item?.status && <InboxStatus status={item.status} />}
            <span>The review opens once the OCR worker returns this PDF. Run OCR from the inbox, then retry.</span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}><button className="btn btn-primary" onClick={firstLoad}>Retry</button><button className="btn" onClick={onBack}>Back to OCR Inbox</button></div>
        </div>
      ) : <div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading review…</div>}
    </div>;
  }

  if (review.result_format === 'page_markdown_v2') {
    return <OCRMarkdownReviewWorkspace item={item} review={review} setReview={setReview} reload={load} onBack={onBack} />;
  }

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
  const reopen = async () => {
    try {
      const result = await reopenVerifiedOcrReview(item, review);
      if (!result) return;
      await load();
      window.toast?.('Review reopened — verify it again when done', { type: 'success' });
    } catch (e) { window.toast?.(e.message, { type: 'error' }); }
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
          {review.status === 'verified'
            ? <button className="btn" onClick={reopen} title="Make this verified review editable again">Reopen review</button>
            : <button className="btn btn-primary" disabled={review.counts.pending > 0 || review.status === 'published'} onClick={verify}>Verify review</button>}
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

const OCRMarkdownReviewWorkspace = ({ item, review, setReview, reload, onBack }) => {
  const firstPage = review.pages[0]?.page || 1;
  const [selectedPage, setSelectedPage] = React.useState(firstPage);
  const [pageResult, setPageResult] = React.useState(null);
  // The page `pageResult`/`markdown` belong to. Every page-scoped action posts to this page,
  // never to `selectedPage`, so content loaded for one page is never saved onto another.
  const [loadedPage, setLoadedPage] = React.useState(null);
  const pageRequest = React.useRef(0);
  const [pageLoading, setPageLoading] = React.useState(true);
  const [pageError, setPageError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [editing, setEditing] = React.useState(false);
  const [viewMode, setViewMode] = React.useState('preview');
  const [markdown, setMarkdown] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [detectingLevels, setDetectingLevels] = React.useState(false);
  const [verifyingLevelTotals, setVerifyingLevelTotals] = React.useState(false);
  const [levelVerification, setLevelVerification] = React.useState(null);
  const [selectionSummary, setSelectionSummary] = React.useState({ count: 0, total: '—' });
  const [selectedVerificationIssue, setSelectedVerificationIssue] = React.useState('');
  const [mismatchTarget, setMismatchTarget] = React.useState(null);
  const [hermesRun, setHermesRun] = React.useState(null);
  const [startingHermes, setStartingHermes] = React.useState(false);
  const [selectedHermesSuggestion, setSelectedHermesSuggestion] = React.useState('');
  const [markedHermesRows, setMarkedHermesRows] = React.useState([]);
  const labelsMissing = !item.labels?.ticker || !item.labels?.scope || !item.labels?.fiscal_year || !item.labels?.period_code;
  const [labelsOpen, setLabelsOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [historyDraft, setHistoryDraft] = React.useState(HISTORY_EMPTY_DRAFT);
  React.useEffect(() => { setHistoryDraft(HISTORY_EMPTY_DRAFT); }, [review.id]);

  const pageCount = review.pages.length || item.pages || 0;
  const locked = ['verified', 'published'].includes(review.status);
  const dirty = Boolean(pageResult && markdown !== pageResult.effective_markdown);
  const pageReady = Boolean(pageResult) && !pageLoading && loadedPage === selectedPage;
  const contentPage = loadedPage ?? selectedPage;
  // Page navigation waits for the current page and any page-scoped request to finish.
  const pageBusy = pageLoading || saving || detectingLevels || verifyingLevelTotals || startingHermes;

  // Only the newest request may write state: a slow page-2 response must not land under page 3.
  const loadPage = React.useCallback(async () => {
    const requestId = ++pageRequest.current;
    const page = selectedPage;
    setPageLoading(true);
    setPageError('');
    try {
      const [result, latestHermes] = await Promise.all([
        window.HelixAPI.ocrReviewPage(review.id, page),
        window.HelixAPI.ocrHermesLabelReviewLatest(review.id, page),
      ]);
      if (requestId !== pageRequest.current) return;
      setPageResult(result);
      setLoadedPage(page);
      setMarkdown(result.effective_markdown || '');
      setHermesRun(latestHermes.run);
      setLevelVerification(null);
      setSelectionSummary({ count: 0, total: '—' });
      setSelectedVerificationIssue('');
      setSelectedHermesSuggestion('');
      setMarkedHermesRows([]);
      setMismatchTarget(null);
      setEditing(false);
      setViewMode(markdownHasTable(result.effective_markdown) ? 'tables' : 'preview');
    } catch (error) {
      if (requestId !== pageRequest.current) return;
      setPageResult(null);
      setLoadedPage(null);
      setPageError(error.message || 'Could not load this OCR page');
    } finally {
      if (requestId === pageRequest.current) setPageLoading(false);
    }
  }, [review.id, review.revision, selectedPage]);

  React.useEffect(() => {
    loadPage();
    return () => { pageRequest.current += 1; };
  }, [loadPage]);
  React.useEffect(() => {
    if (!hermesRun || !['queued', 'running'].includes(hermesRun.status)) return undefined;
    let canceled = false;
    const runPage = contentPage;
    const poller = window.SyncPoller.create({
      intervalMs: 1200,
      maxIntervalMs: 15000,
      run: async () => {
        const next = await window.HelixAPI.ocrHermesLabelReviewRun(review.id, runPage, hermesRun.id);
        if (!canceled) setHermesRun(next);
      },
      onError: error => { if (!canceled) setActionError(error.message || 'Could not refresh the Ollama label review'); },
    });
    poller.start();
    return () => {
      canceled = true;
      poller.stop();
    };
  }, [hermesRun?.id, hermesRun?.status, review.id, contentPage]);
  React.useEffect(() => {
    if (!dirty) return undefined;
    const warn = event => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const confirmDiscard = async () => {
    if (!dirty) return true;
    return window.askConfirm({
      title: 'Discard Markdown changes?',
      message: 'Your unsaved changes to this OCR page will be lost.',
      confirmText: 'Discard',
      danger: true,
    });
  };

  const navigate = async nextPage => {
    if (pageBusy || nextPage === selectedPage || nextPage < 1 || nextPage > pageCount) return;
    if (!await confirmDiscard()) return;
    setActionError('');
    setLevelVerification(null);
    setSelectionSummary({ count: 0, total: '—' });
    setSelectedVerificationIssue('');
    setHermesRun(null);
    setSelectedHermesSuggestion('');
    setMarkedHermesRows([]);
    setMismatchTarget(null);
    setSelectedPage(nextPage);
  };

  const updateMarkdown = nextMarkdown => {
    setMarkdown(nextMarkdown);
    setLevelVerification(null);
    setSelectedVerificationIssue('');
    setHermesRun(null);
    setSelectedHermesSuggestion('');
    setMarkedHermesRows([]);
    setMismatchTarget(null);
  };

  const updateSelectionSummary = React.useCallback(nextSummary => {
    setSelectionSummary(current => (
      current.tableNumber === nextSummary.tableNumber
      && current.count === nextSummary.count
      && current.total === nextSummary.total
        ? current
        : nextSummary
    ));
  }, []);

  const toggleHermesLabelMark = React.useCallback(target => {
    setMarkedHermesRows(current => {
      const exists = current.some(row => row.table === target.table && row.row === target.row);
      return exists
        ? current.filter(row => row.table !== target.table || row.row !== target.row)
        : [...current, target];
    });
  }, []);

  const leave = async () => {
    if (await confirmDiscard()) onBack();
  };

  const pageAction = async (action, correctedMarkdown = null) => {
    if (!pageReady) return;
    const page = loadedPage;
    setSaving(true);
    setActionError('');
    try {
      const nextReview = await window.HelixAPI.ocrReviewPageAction(
        review.id,
        page,
        action,
        review.revision,
        correctedMarkdown,
      );
      setReview(nextReview);
      setLevelVerification(null);
      setEditing(false);
      if (action === 'correct') setViewMode(markdownHasTable(correctedMarkdown) ? 'tables' : 'preview');
      window.toast?.(
        action === 'correct' ? `Page ${page} correction saved` : `Page ${page} ${action === 'restore' ? 'reset' : 'approved'}`,
        { type: 'success' },
      );
    } catch (error) {
      setActionError(error.message || `Could not ${action} page ${page}`);
      if (error.status === 409 || error.message?.includes('refresh')) await reload().catch(() => {});
    } finally {
      setSaving(false);
    }
  };

  const saveCorrection = async () => {
    if (!dirty) return;
    await pageAction('correct', markdown);
  };

  const detectLabelLevels = async () => {
    if (!pageReady) return;
    setDetectingLevels(true);
    setActionError('');
    try {
      const result = await window.HelixAPI.ocrReviewAutoLevels(
        review.id,
        contentPage,
        review.revision,
        markdown,
      );
      updateMarkdown(result.markdown);
      setViewMode('tables');
      const relationshipText = `${result.relationships} total relationship${result.relationships === 1 ? '' : 's'}`;
      window.toast?.(
        `${relationshipText} found · ${result.leveled_rows} label${result.leveled_rows === 1 ? '' : 's'} proposed. Review, then save the correction.`,
        { type: result.relationships ? 'success' : 'info' },
      );
    } catch (error) {
      setActionError(error.message || 'Could not detect table label levels');
    } finally {
      setDetectingLevels(false);
    }
  };

  const verifyLevelTotals = async () => {
    if (!pageReady) return;
    setVerifyingLevelTotals(true);
    setActionError('');
    try {
      const result = await window.HelixAPI.ocrReviewVerifyLevelTotals(
        review.id,
        contentPage,
        review.revision,
        markdown,
      );
      setLevelVerification(result);
      setSelectedVerificationIssue('');
      setMismatchTarget(null);
    } catch (error) {
      setLevelVerification(null);
      setActionError(error.message || 'Could not verify table level totals');
    } finally {
      setVerifyingLevelTotals(false);
    }
  };

  const startHermesLabelReview = async (targetsOverride = null) => {
    if (!pageReady) return;
    const targets = Array.isArray(targetsOverride) ? targetsOverride : markedHermesRows;
    if (dirty) {
      setActionError('Save or discard table changes before asking Ollama to review labels.');
      return;
    }
    if (['queued', 'running'].includes(hermesRun?.status)) {
      setActionError('Ollama is already reviewing a label. Wait for it to finish.');
      return;
    }
    if (!targets.length) {
      setActionError('Select a label cell, choose “Mark label for Ollama”, then ask Ollama.');
      return;
    }
    setStartingHermes(true);
    setActionError('');
    setSelectedHermesSuggestion('');
    try {
      const run = await window.HelixAPI.ocrHermesLabelReviewStart(
        review.id,
        contentPage,
        review.revision,
        targets,
      );
      setHermesRun(run);
      setMarkedHermesRows([]);
    } catch (error) {
      setActionError(error.message || 'Could not start the Ollama label review');
    } finally {
      setStartingHermes(false);
    }
  };

  const applyLabelSuggestions = async (run, accepted) => {
    const result = await window.HelixAPI.ocrHermesLabelSuggestionsApply(
      review.id,
      contentPage,
      review.revision,
      run.page_content_sha256,
      accepted.map(suggestion => suggestion.id),
    );
    setReview(result.review);
    setPageResult(result.page);
    setMarkdown(result.page.effective_markdown || '');
    setLevelVerification(result.verification);
    const nextRun = result.label_review_run;
    const hasRemaining = nextRun?.suggestions?.some(suggestion => (
      suggestion.applied_revision === null
      && !['rejected', 'stale'].includes(suggestion.decision)
    ));
    setHermesRun(hasRemaining ? nextRun : null);
    setSelectedHermesSuggestion('');
    setMismatchTarget(null);
    return result;
  };

  const decideHermesSuggestion = async (suggestion, decision, userEditedLevel = null) => {
    const applyImmediately = decision === 'accepted';
    if (applyImmediately) setSaving(true);
    setActionError('');
    try {
      const run = await window.HelixAPI.ocrHermesLabelSuggestionDecision(
        suggestion.id,
        decision,
        userEditedLevel,
      );
      setHermesRun(run);
      if (decision === 'rejected') {
        setSelectedHermesSuggestion('');
      } else if (applyImmediately) {
        const accepted = run.suggestions.filter(candidate => (
          candidate.id === suggestion.id
          && ['accepted', 'edited'].includes(candidate.decision)
          && candidate.applied_revision === null
        ));
        if (!accepted.length) throw new Error('The accepted suggestion is no longer available');
        await applyLabelSuggestions(run, accepted);
        window.toast?.(`Label changed to “${accepted[0].suggested_label || labelLevelCode(accepted[0].suggested_level)}”`, { type: 'success' });
      }
    } catch (error) {
      setActionError(error.message || `Could not ${applyImmediately ? 'accept and apply' : 'reject'} the Ollama suggestion`);
    } finally {
      if (applyImmediately) setSaving(false);
    }
  };

  const applyHermesSuggestions = async () => {
    const accepted = (hermesRun?.suggestions || []).filter(suggestion => (
      ['accepted', 'edited'].includes(suggestion.decision)
      && suggestion.applied_revision === null
    ));
    if (!accepted.length) return;
    setSaving(true);
    setActionError('');
    try {
      await applyLabelSuggestions(hermesRun, accepted);
      window.toast?.(`${accepted.length} Ollama label suggestion${accepted.length === 1 ? '' : 's'} applied`, { type: 'success' });
    } catch (error) {
      setActionError(error.message || 'Could not apply the Ollama label suggestions');
    } finally {
      setSaving(false);
    }
  };

  const verify = async () => {
    setSaving(true);
    setActionError('');
    try {
      const nextReview = await window.HelixAPI.ocrReviewVerify(review.id, review.revision);
      setReview(nextReview);
      await reload();
      window.toast?.('Page Markdown review verified', { type: 'success' });
    } catch (error) {
      setActionError(error.message || 'Could not verify the page review');
    } finally {
      setSaving(false);
    }
  };

  const reopen = async () => {
    setSaving(true);
    setActionError('');
    try {
      const result = await reopenVerifiedOcrReview(item, review);
      if (!result) return;
      if (Array.isArray(result.pages) && result.revision !== undefined) setReview(result);
      await reload();
      window.toast?.('Review reopened — verify it again when done', { type: 'success' });
    } catch (error) {
      setActionError(error.message || 'Could not reopen the review');
    } finally {
      setSaving(false);
    }
  };
  const canReopen = review.status === 'verified';

  const selectedMeta = review.pages.find(page => page.page === selectedPage);
  const statusLabel = selectedMeta?.status || pageResult?.status || 'pending';
  const verificationIssues = levelVerification ? [
    ...levelVerification.checks.flatMap(check => check.columns
      .filter(column => !column.matches)
      .map(column => ({
        id: `mismatch-${check.table}-${check.parent_row}-${column.column}`,
        table: check.table,
        row: check.parent_row,
        column: column.column,
        label: `Table ${check.table} · row ${check.parent_row} · L${check.parent_level}→L${check.child_level} · ${column.column_label} · difference ${column.difference}`,
      }))),
    ...(levelVerification.unverifiable || []).map((block, index) => ({
      id: `review-${block.table}-${block.child_rows.join('-')}-${index}`,
      table: block.table,
      row: block.child_rows[0],
      column: 1,
      label: `Table ${block.table} · L${block.child_level} rows ${block.child_rows.join(', ')} · choose parent direction`,
    })),
  ] : [];
  const navigateToVerificationIssue = event => {
    const issueId = event.target.value;
    setSelectedVerificationIssue(issueId);
    const issue = verificationIssues.find(candidate => candidate.id === issueId);
    if (!issue) return;
    setMismatchTarget({ ...issue, token: Date.now() });
  };
  const visibleHermesSuggestions = (hermesRun?.suggestions || []).filter(
    suggestion => (
      suggestion.applied_revision === null
      && !['rejected', 'stale'].includes(suggestion.decision)
    ),
  );
  const acceptedHermesSuggestions = visibleHermesSuggestions.filter(
    suggestion => ['accepted', 'edited'].includes(suggestion.decision),
  );
  const navigateToHermesSuggestion = event => {
    const suggestionId = event.target.value;
    setSelectedHermesSuggestion(suggestionId);
    const suggestion = visibleHermesSuggestions.find(
      candidate => String(candidate.id) === suggestionId,
    );
    if (!suggestion) return;
    setMismatchTarget({
      table: suggestion.table,
      row: suggestion.row,
      column: 1,
      token: Date.now(),
    });
  };
  const activeHermesSuggestion = visibleHermesSuggestions.find(
    suggestion => String(suggestion.id) === selectedHermesSuggestion,
  );

  return (
    <div className="page" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="page-header" style={{ marginBottom: 14 }}>
        <div>
          <button className="card-action" onClick={leave}>← OCR Inbox</button>
          <h1 className="page-title" style={{ marginTop: 8 }}>{item.filename}</h1>
          <p className="page-sub">
            {review.counts.resolved} of {review.counts.total} pages resolved · revision {review.revision}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <a className="btn" href={window.HelixAPI.ocrReviewMarkdownUrl(review.id, 'raw')} target="_blank" rel="noreferrer">Raw document</a>
          <a className="btn" href={window.HelixAPI.ocrReviewMarkdownUrl(review.id, 'effective')} target="_blank" rel="noreferrer">Reviewed document</a>
          <button className="btn" aria-expanded={labelsOpen} onClick={() => setLabelsOpen(open => !open)}>{labelsMissing ? 'Labels ⚠' : 'Labels'}</button>
          {canReopen
            ? <button className="btn" disabled={saving} onClick={reopen} title="Make this verified review editable again">Reopen review</button>
            : <button className="btn btn-primary" disabled={saving || review.counts.pending > 0 || visibleHermesSuggestions.length > 0 || locked} onClick={verify}>Verify review</button>}
          <button className="btn btn-accent" disabled={saving || !locked} title={locked ? 'Turn this verified statement into company history' : 'Verify the review first'} onClick={() => setHistoryOpen(true)}>Add to history</button>
        </div>
      </div>

      {actionError && <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '9px 12px', marginBottom: 10, border: '1px solid var(--neg)', borderRadius: 6, color: 'var(--neg)', fontSize: 12 }}>
        <span style={{ flex: '1 1 260px' }}>{actionError}</span>
        {ocrNeedsReopen(actionError) && canReopen && <button className="btn" disabled={saving} onClick={reopen}>Reopen review</button>}
      </div>}
      {labelsOpen && <div className="card" style={{ marginBottom: 14 }}>
        <OCRPublishPanel key={`${item.id}-${review.revision}`} item={item} reload={reload} setPage={() => {}} canPublish={false} title="Upload labels" />
      </div>}
      {historyOpen && <OCRHistoryWizard item={item} review={review} draft={historyDraft} setDraft={setHistoryDraft}
        onClose={() => setHistoryOpen(false)}
        onOpenLabels={() => { setHistoryOpen(false); setLabelsOpen(true); }}
        onWritten={async () => { setHistoryOpen(false); setHistoryDraft(HISTORY_EMPTY_DRAFT); await reload(); }} />}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(420px,1.1fr) minmax(440px,1fr)', gap: 14, flex: 1, minHeight: 0 }}>
        <div className="card" style={{ minHeight: 0, display: 'flex', flexDirection: 'column', background: '#383b40' }}>
          <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'var(--bg-elev)', borderBottom: '1px solid var(--border)' }}>
            <button className="btn" disabled={pageBusy || selectedPage <= 1} onClick={() => navigate(selectedPage - 1)}>← Previous</button>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 7 }}>
              PDF page
              <select value={selectedPage} disabled={pageBusy} onChange={event => navigate(Number(event.target.value))} style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-elev)', color: 'var(--text)' }}>
                {review.pages.map(page => <option key={page.page} value={page.page}>{page.page} · {page.status}{page.total_check?.likely_misreads?.length ? ' · ⚠ totals' : ''}</option>)}
              </select>
              <span className="num">of {pageCount}</span>
            </label>
            <button className="btn" disabled={pageBusy || selectedPage >= pageCount} onClick={() => navigate(selectedPage + 1)}>Next →</button>
          </div>
          <div style={{ overflow: 'auto', padding: 12, flex: 1 }}>
            <div style={{ maxWidth: 850, margin: '0 auto' }}>
              <img
                src={window.HelixAPI.ocrInboxPageUrl(item.id, selectedPage)}
                alt={`Source PDF page ${selectedPage}`}
                style={{ width: '100%', height: 'auto', display: 'block', background: 'white' }}
              />
            </div>
          </div>
        </div>

        <div className="card" style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="card-header" style={{ gap: 12 }}>
            <div>
              <h3 className="card-title">{viewMode === 'tables' && !editing ? 'Spreadsheet review' : 'Markdown'} · page {selectedPage}</h3>
              {pageResult && <div className="num" style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>{fmtInboxBytes(pageResult.byte_size)} · {pageResult.content_sha256.slice(0, 12)}…</div>}
              {pageResult?.label_check && <div style={{ marginTop: 4, fontSize: 10, color: pageResult.label_check.error ? 'var(--neg)' : 'var(--text-muted)' }}>Label checker: {pageResult.label_check.status}{pageResult.label_check.status === 'checked' ? ` · ${pageResult.label_check.known_count} known · ${pageResult.label_check.candidate_count} to review` : ''}{pageResult.label_check.error ? ` · ${pageResult.label_check.error}` : ''}</div>}
              {pageResult?.total_check?.likely_misreads?.length > 0 && <div role="status" style={{ marginTop: 4, fontSize: 10, color: 'var(--neg)' }}>
                {pageResult.total_check.likely_misreads.map((flag, index) => <div key={index}>⚠ Total check: “{flag.parent_label}” ({flag.column_label}) shows {flag.parent} but its rows add up to {flag.children_sum} — off by {flag.difference}, likely one misread digit. Compare with the PDF.</div>)}
              </div>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {!editing && viewMode === 'tables' && markdownHasTable(markdown) && !locked && <button
                type="button"
                className="btn"
                disabled={dirty || saving || !markedHermesRows.length || startingHermes || ['queued', 'running'].includes(hermesRun?.status)}
                onClick={() => startHermesLabelReview()}
                title={dirty ? 'Save or discard table changes before asking Ollama' : markedHermesRows.length ? 'Send marked labels to Ollama one at a time' : 'Select a label cell and mark it for Ollama first'}
              >{startingHermes || ['queued', 'running'].includes(hermesRun?.status) ? 'Ollama reviewing…' : `Ask Ollama (${markedHermesRows.length})`}</button>}
              {!editing && viewMode === 'tables' && markdownHasTable(markdown) && !locked && <button
                type="button"
                className="btn"
                disabled={saving || detectingLevels || verifyingLevelTotals || ['queued', 'running'].includes(hermesRun?.status)}
                onClick={detectLabelLevels}
                title="Use exact arithmetic to propose label levels from the corrected table values"
              >{detectingLevels ? 'Detecting levels…' : 'Auto-detect levels'}</button>}
              {!editing && viewMode === 'tables' && markdownHasTable(markdown) && <button
                type="button"
                className="btn"
                disabled={saving || detectingLevels || verifyingLevelTotals}
                onClick={verifyLevelTotals}
                title="Check that every L0–L2 parent equals the total of its direct next-level rows"
              >{verifyingLevelTotals ? 'Verifying totals…' : 'Verify level totals'}</button>}
              {!editing && <div className="range-chips" role="tablist" aria-label="Markdown display mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'tables'}
                  className={`range-chip ${viewMode === 'tables' ? 'active' : ''}`}
                  onClick={() => setViewMode('tables')}
                >Spreadsheet</button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'preview'}
                  className={`range-chip ${viewMode === 'preview' ? 'active' : ''}`}
                  onClick={() => setViewMode('preview')}
                >Page</button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === 'source'}
                  className={`range-chip ${viewMode === 'source' ? 'active' : ''}`}
                  onClick={() => setViewMode('source')}
                >Source</button>
              </div>}
              <InboxStatus status={statusLabel} />
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14 }}>
            {pageLoading || (!pageError && !pageReady) ? (
              <div style={{ display: 'grid', gap: 8 }} aria-label="Loading Markdown page">
                <div className="skeleton" style={{ height: 18, width: '65%' }} />
                <div className="skeleton" style={{ height: 12, width: '100%' }} />
                <div className="skeleton" style={{ height: 12, width: '92%' }} />
              </div>
            ) : pageError ? (
              <div role="alert" style={{ color: 'var(--neg)', fontSize: 12 }}>
                <div>{pageError}</div>
                <button className="btn" style={{ marginTop: 10 }} onClick={loadPage}>Retry</button>
              </div>
            ) : editing ? (
              <textarea
                value={markdown}
                onChange={event => updateMarkdown(event.target.value)}
                aria-label={`Correct Markdown for page ${selectedPage}`}
                spellCheck="false"
                style={{ width: '100%', minHeight: '100%', resize: 'vertical', padding: 12, border: '1px solid var(--accent)', borderRadius: 6, background: 'var(--bg-sunken)', color: 'var(--text)', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.6 }}
              />
            ) : viewMode === 'tables' ? (
              <MarkdownPreview markdown={markdown} tablesOnly interactiveTables onMarkdownChange={locked ? null : updateMarkdown} levelVerification={levelVerification} mismatchTarget={mismatchTarget} onSelectionSummary={updateSelectionSummary} labelSuggestions={visibleHermesSuggestions} markedLabelRows={markedHermesRows} onToggleLabelMark={locked ? null : toggleHermesLabelMark} onAskHermesForLabel={locked ? null : target => startHermesLabelReview([target])} onDecideLabelSuggestion={locked ? null : decideHermesSuggestion} />
            ) : viewMode === 'preview' ? (
              <MarkdownPreview markdown={markdown} />
            ) : (
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.65, color: 'var(--text)' }}>{markdown || 'This page contains no OCR text.'}</pre>
            )}
          </div>

          {pageReady && !pageError && (!locked || (!editing && viewMode === 'tables')) && <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap', background: 'var(--bg-elev)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flex: '1 1 420px', minWidth: 0, flexWrap: 'wrap' }}>
              {!editing && viewMode === 'tables' && <>
                <span role="status" aria-live="polite" style={{ display: 'inline-flex', alignItems: 'baseline', gap: 12, whiteSpace: 'nowrap' }}>
                  <strong>Selected: <span className="num">{selectionSummary.count}</span></strong>
                  <strong>Total: <span className="num" style={{ fontSize: 13 }}>{selectionSummary.total}</span></strong>
                </span>
                {levelVerification && <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, color: verificationIssues.length ? 'var(--neg)' : 'var(--pos)', fontSize: 11, fontWeight: 700 }}>
                  Verification
                  <select
                    value={selectedVerificationIssue}
                    disabled={!verificationIssues.length}
                    onChange={navigateToVerificationIssue}
                    aria-label="Go to a level verification issue"
                    style={{ width: 'min(430px, 44vw)', minWidth: 220, padding: '6px 8px', border: `1px solid ${verificationIssues.length ? 'var(--neg-soft)' : 'var(--pos-soft)'}`, borderRadius: 4, background: 'var(--bg-elev)', color: 'var(--text)', fontSize: 11 }}
                  >
                    <option value="">{verificationIssues.length ? `${verificationIssues.length} issue${verificationIssues.length === 1 ? '' : 's'} · ${levelVerification.matched} matched` : `No issues · ${levelVerification.matched} matched`}</option>
                    {verificationIssues.map(issue => <option key={issue.id} value={issue.id}>{issue.label}</option>)}
                  </select>
                </label>}
                {hermesRun && <div role="status" aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap', color: hermesRun.status === 'failed' ? 'var(--neg)' : '#7c3aed', fontSize: 11, fontWeight: 700 }}>
                  <span>{hermesRun.trigger === 'worker_auto' ? 'Automatic Ollama' : 'Ollama'}</span>
                  {['queued', 'running'].includes(hermesRun.status) ? <span>sent label {(hermesRun.processed_count || 0) + 1} of {hermesRun.total_count || hermesRun.selected_rows?.length || 0} to Ollama{hermesRun.active_target ? ` · table ${hermesRun.active_target.table}, row ${hermesRun.active_target.row}` : ''}</span> : hermesRun.status === 'failed' ? <span title={hermesRun.error}>{hermesRun.error || 'review failed'}</span> : visibleHermesSuggestions.length ? <>
                    <select
                      value={selectedHermesSuggestion}
                      onChange={navigateToHermesSuggestion}
                      aria-label="Go to an Ollama label suggestion"
                      style={{ width: 'min(430px, 44vw)', minWidth: 240, padding: '6px 8px', border: '1px solid #7c3aed', borderRadius: 4, background: 'var(--bg-elev)', color: 'var(--text)', fontSize: 11 }}
                    >
                      <option value="">{visibleHermesSuggestions.length} suggestion{visibleHermesSuggestions.length === 1 ? '' : 's'} · {acceptedHermesSuggestions.length} accepted</option>
                      {visibleHermesSuggestions.map(suggestion => <option key={suggestion.id} value={suggestion.id}>Table {suggestion.table} · row {suggestion.row} · {suggestion.suggested_label ? `${suggestion.current_label} → ${suggestion.suggested_label}` : `${suggestion.current_level === null ? 'Unassigned' : labelLevelCode(suggestion.current_level)} → ${labelLevelCode(suggestion.user_edited_level ?? suggestion.suggested_level)}`} · {suggestion.decision}</option>)}
                    </select>
                    {activeHermesSuggestion && <>
                      {activeHermesSuggestion.suggested_label ? <span>Use: {activeHermesSuggestion.suggested_label}</span> : <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>Use
                        <select value={activeHermesSuggestion.user_edited_level ?? activeHermesSuggestion.suggested_level} onChange={event => decideHermesSuggestion(activeHermesSuggestion, 'edited', Number(event.target.value))} aria-label="Change the accepted Ollama label level" style={{ padding: '4px 6px', border: '1px solid #7c3aed', borderRadius: 4, background: 'var(--bg-elev)', color: 'var(--text)', fontSize: 10 }}>
                          {LABEL_LEVEL_VALUES.map(level => <option key={level} value={level}>{labelLevelCode(level)}</option>)}
                        </select>
                      </label>}
                      <button type="button" className="card-action" disabled={['accepted', 'edited'].includes(activeHermesSuggestion.decision)} onClick={() => decideHermesSuggestion(activeHermesSuggestion, 'accepted')}>Accept</button>
                      <button type="button" className="card-action" onClick={() => decideHermesSuggestion(activeHermesSuggestion, 'rejected')}>Reject</button>
                    </>}
                    <button type="button" className="btn btn-primary" disabled={!acceptedHermesSuggestions.length || saving} onClick={applyHermesSuggestions}>Apply accepted ({acceptedHermesSuggestions.length})</button>
                  </> : <span>{hermesRun.suggestions?.some(suggestion => suggestion.applied_revision !== null) ? 'Suggestions applied' : hermesRun.suggestions?.length ? 'All suggestions resolved' : `Ollama reviewed ${hermesRun.processed_count || 0} marked label${(hermesRun.processed_count || 0) === 1 ? '' : 's'} · no changes suggested`}</span>}
                </div>}
              </>}
            </div>
            {!locked && <div style={{ display: 'flex', alignItems: 'center', gap: 7, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              {editing ? <>
                <button className="btn" disabled={saving} onClick={() => { updateMarkdown(pageResult?.effective_markdown || ''); setEditing(false); setViewMode(markdownHasTable(pageResult?.effective_markdown) ? 'tables' : 'preview'); }}>Cancel</button>
                <button className="btn btn-primary" disabled={saving || !dirty} onClick={saveCorrection}>{saving ? 'Saving…' : 'Save correction'}</button>
              </> : <>
                {dirty ? <>
                  <button className="btn" disabled={saving} onClick={() => updateMarkdown(pageResult?.effective_markdown || '')}>Discard table changes</button>
                  <button className="btn btn-primary" disabled={saving} onClick={saveCorrection}>{saving ? 'Saving…' : 'Save correction'}</button>
                </> : <>
                  {statusLabel === 'pending' && <button className="btn btn-primary" disabled={saving} onClick={() => pageAction('approve')}>Approve page</button>}
                  <button className="btn" disabled={saving} onClick={() => { updateMarkdown(pageResult?.effective_markdown || ''); setViewMode('source'); setEditing(true); }}>Edit Markdown</button>
                  {statusLabel !== 'pending' && <button className="btn" disabled={saving} onClick={() => pageAction('restore')}>Reset to pending</button>}
                </>}
              </>}
            </div>}
          </div>}
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
