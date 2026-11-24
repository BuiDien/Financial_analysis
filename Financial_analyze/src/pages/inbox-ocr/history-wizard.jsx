// OCR Inbox — "Add to history" wizard (company history from a verified Markdown review).
// Every answer re-posts history-preview; the server decides what still blocks. Code here never
// picks a period, unit, line or conflict value for the owner: options are listed, the owner chooses.
// Modal: focus moves in on open, Tab is trapped, Escape or a backdrop click closes.

import React from 'react';
import { HelixAPI } from '../../api-client.jsx';
import { IconButton, LxWizard, toast } from '../../ui';
import { HISTORY_KIND_NAMES, HISTORY_TABLE_CODES, historyMisreadKey, historyPayload, historyRowKey, historyTableKey } from './ocr-inbox-utils.js';
import { tablesStep, linesStep, checksStep, addStep } from './history-steps.jsx';

const OCRHistoryWizard = ({ item, review, draft, setDraft, onClose, onWritten, onOpenLabels }) => {
  const [preview, setPreview] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [writing, setWriting] = React.useState(false);
  const [filter, setFilter] = React.useState('used');
  const [editingColumns, setEditingColumns] = React.useState({});
  const [touched, setTouched] = React.useState({}); // tables answered here stay listed under "Open"
  const dialogRef = React.useRef(null);
  const seq = React.useRef(0);

  // Re-post the preview on every answer (debounced so quick clicks share one request).
  React.useEffect(() => {
    const id = ++seq.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const next = await HelixAPI.historyPreview(review.id, historyPayload(draft, review.revision));
        if (id !== seq.current) return;
        setPreview(next); setError('');
        // A conflict choice only means something while that conflict exists: an answer elsewhere
        // (period, line, kind) can make a fact_key disappear, so drop choices for keys no longer listed.
        const live = new Set((next.conflicts || []).map(c => c.fact_key));
        setDraft(d => {
          const stale = Object.keys(d.resolutions).filter(key => !live.has(key));
          if (!stale.length) return d;
          const resolutions = { ...d.resolutions };
          stale.forEach(key => { delete resolutions[key]; });
          return { ...d, resolutions };
        });
      } catch (e) {
        if (id !== seq.current) return;
        setError(e.message || 'Could not prepare the history preview');
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [draft, review.id, review.revision]);

  React.useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.focus({ preventScroll: true });
    return () => { if (opener && opener.isConnected) opener.focus?.({ preventScroll: true }); };
  }, []);
  const onDialogKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    const focusables = Array.from(dialogRef.current.querySelectorAll('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(el => el.offsetParent !== null && !el.closest('[inert]') && !el.closest('[aria-hidden="true"]'));
    if (!focusables.length) return;
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const blocking = preview?.blocking || [];
  const tables = preview?.tables || [];
  const usedTables = tables.filter(t => t.kind && t.kind !== 'skip');
  // Year-less headers are proposals from the labelled year: the owner confirms each one.
  const unconfirmed = usedTables.flatMap(t => t.columns
    .filter(c => !c.skipped && c.period_source === 'relative')
    .map(c => ({ code: 'period_unconfirmed', page: t.page, table: t.table, column: c.column, message: `Confirm the proposed period of column ${c.header || c.column}` })));
  // A kind proposed from the page heading is only a proposal (spec §6.3): the owner confirms it per table
  // (sent back as an explicit `kind` answer) or picks another kind / Skip.
  const kindUnconfirmed = t => !!t.proposed_kind && t.kind === t.proposed_kind && !draft.tables[historyTableKey(t.page, t.table)]?.kind;
  const unconfirmedKinds = tables.filter(kindUnconfirmed)
    .map(t => ({ code: 'kind_unconfirmed', page: t.page, table: t.table, message: `Confirm that page ${t.page} table ${t.table} is a ${HISTORY_KIND_NAMES[t.kind].toLowerCase()}, or skip it` }));
  const tableBlocking = [...blocking.filter(b => HISTORY_TABLE_CODES.has(b.code)), ...unconfirmedKinds, ...unconfirmed];
  const lineBlocking = blocking.filter(b => b.code === 'line_unanswered');
  const checkBlocking = blocking.filter(b => b.code === 'misread_unaccepted');
  const otherBlocking = blocking.filter(b => !HISTORY_TABLE_CODES.has(b.code) && !['line_unanswered', 'misread_unaccepted'].includes(b.code));
  const blocksFor = (page, table) => tableBlocking.filter(b => b.page === page && b.table === table);
  const globalBlock = blocking.find(b => b.code === 'review_not_verified' || b.code === 'labels_missing');
  const ready = !!preview && !loading && !error;

  const touch = t => setTouched(x => ({ ...x, [historyTableKey(t.page, t.table)]: true }));
  const updateTable = (t, patch) => { touch(t); setDraft(d => {
    const key = historyTableKey(t.page, t.table);
    const prev = d.tables[key] || { columns: {} };
    return { ...d, tables: { ...d.tables, [key]: { ...prev, ...patch, columns: { ...(prev.columns || {}), ...(patch.columns || {}) } } } };
  }); };
  const setColumn = (t, column, answer) => { touch(t); setDraft(d => {
    const key = historyTableKey(t.page, t.table);
    const prev = d.tables[key] || { columns: {} };
    const columns = { ...(prev.columns || {}) };
    if (answer) columns[column] = { column, ...answer }; else delete columns[column];
    return { ...d, tables: { ...d.tables, [key]: { ...prev, columns } } };
  }); };
  const columnAnswer = (t, column) => draft.tables[historyTableKey(t.page, t.table)]?.columns?.[column];
  const pickPeriod = (t, c, value) => {
    if (value === 'skip') { setColumn(t, c.column, { skip: true }); return; }
    const [type, start, end] = String(value).split('|');
    setColumn(t, c.column, { period_type: type, period_start: start || null, period_end: end });
    setEditingColumns(x => ({ ...x, [`${t.page}:${t.table}:${c.column}`]: false }));
  };
  const skipKindless = () => setDraft(d => {
    const next = { ...d.tables };
    tables.filter(t => !t.kind && !t.proposed_kind).forEach(t => {
      const key = historyTableKey(t.page, t.table);
      next[key] = { ...(next[key] || { columns: {} }), kind: 'skip' };
    });
    return { ...d, tables: next };
  });
  const unknownRows = usedTables.flatMap(t => t.rows.filter(r => r.status === 'unknown').map(r => ({ t, r })));
  const namedUnknownRows = unknownRows.filter(({ t, r }) => (r.label || '').trim() && !draft.lines[historyRowKey(t.page, t.table, r.row)]);
  const newLinesForAll = () => setDraft(d => {
    const lines = { ...d.lines };
    namedUnknownRows.forEach(({ t, r }) => { lines[historyRowKey(t.page, t.table, r.row)] = { new_line_name: r.label }; });
    return { ...d, lines };
  });
  const setLineName = (t, r, name) => setDraft(d => ({ ...d, lines: { ...d.lines, [historyRowKey(t.page, t.table, r.row)]: { new_line_name: name } } }));
  const setLine = (t, r, value) => setDraft(d => {
    const lines = { ...d.lines };
    const key = historyRowKey(t.page, t.table, r.row);
    if (!value) delete lines[key];
    else lines[key] = value === '__new__' ? { new_line_name: r.label } : { line_key: value };
    return { ...d, lines };
  });
  const toggleMisread = m => setDraft(d => {
    const misreads = { ...d.misreads };
    const key = historyMisreadKey(m);
    if (misreads[key]) delete misreads[key];
    else misreads[key] = { page: m.page, content_sha256: m.content_sha256, table: m.table, parent_row: m.parent_row, column_label: m.column_label };
    return { ...d, misreads };
  });
  const setResolution = (factKey, value) => setDraft(d => {
    const resolutions = { ...d.resolutions };
    if (value === 'open') delete resolutions[factKey];
    else resolutions[factKey] = value === 'incoming' ? 'incoming' : Number(value);
    return { ...d, resolutions };
  });

  const misreads = preview?.misreads || [];
  const conflicts = preview?.conflicts || [];
  const finish = async () => {
    setWriting(true);
    try {
      const live = new Set(conflicts.map(c => c.fact_key));
      const current = { ...draft, resolutions: Object.fromEntries(Object.entries(draft.resolutions).filter(([key]) => live.has(key))) };
      const result = await HelixAPI.historyWrite(review.id, historyPayload(current, review.revision));
      toast?.(`Added to history: ${result.written} written · ${result.superseded} superseded · ${result.conflicts_open} conflicts open`, { type: 'success', duration: 7000 });
      onWritten?.(result);
    } catch (e) {
      if (e.detail?.blocking) setPreview(p => ({ ...(p || {}), blocking: e.detail.blocking }));
      toast?.(e.message || 'Could not add to history', { type: 'error' });
    } finally { setWriting(false); }
  };

  const tableNeedsAnswer = t => blocksFor(t.page, t.table).length > 0;
  const shownTables = tables.filter(t => filter === 'all' ? true : filter === 'used' ? (t.kind && t.kind !== 'skip') : (tableNeedsAnswer(t) || touched[historyTableKey(t.page, t.table)]));
  const confirmKinds = list => { list.forEach(touch); setDraft(d => {
    const next = { ...d.tables };
    list.forEach(t => { const key = historyTableKey(t.page, t.table); next[key] = { ...(next[key] || { columns: {} }), kind: t.kind }; });
    return { ...d, tables: next };
  }); };
  const remaining = [...tableBlocking, ...lineBlocking, ...checkBlocking, ...otherBlocking];

  const h = {
    item, draft, preview, loading, error, filter, setFilter, editingColumns, setEditingColumns, onOpenLabels,
    tables, usedTables, tableBlocking, lineBlocking, checkBlocking, globalBlock, blocksFor, kindUnconfirmed, tableNeedsAnswer,
    shownTables, shownUnconfirmed: shownTables.filter(kindUnconfirmed), confirmKinds, skipKindless, updateTable, setColumn, columnAnswer, pickPeriod,
    kindlessCount: tables.filter(t => !t.kind && !t.proposed_kind && !draft.tables[historyTableKey(t.page, t.table)]?.kind).length,
    unknownRows, namedUnknownRows, newLinesForAll, setLine, setLineName, misreads, conflicts, toggleMisread, setResolution, remaining,
    newLines: Object.values(draft.lines).filter(l => l.new_line_name).length,
    matchedRows: usedTables.reduce((n, t) => n + t.rows.filter(r => r.status === 'matched').length, 0),
    openConflicts: conflicts.filter(c => draft.resolutions[c.fact_key] === undefined).length,
  };
  const steps = [
    { id: 'tables', title: 'Tables & periods', label: 'Tables', description: 'Confirm what each table is, its unit, and the period of each value column.', render: () => tablesStep(h), canNext: ready && tableBlocking.length === 0 },
    { id: 'lines', title: 'Lines', label: 'Lines', description: 'Rows the history has not seen: the same as an existing line, or a new line?', render: () => linesStep(h), canNext: ready && lineBlocking.length === 0 },
    { id: 'checks', title: 'Checks', label: 'Checks', description: 'Subtotals that do not add up, and values that disagree with the history.', render: () => checksStep(h), canNext: ready && checkBlocking.length === 0 },
    { id: 'add', title: 'Add', label: 'Add', bare: true, render: () => addStep(h), canNext: ready && remaining.length === 0 && !writing },
  ];

  return <div className="ocr-modal" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={`Add ${item.filename} to history`} tabIndex={-1} onKeyDown={onDialogKey} className="ocr-modal-box">
      <LxWizard steps={steps} busy={writing} finishLabel="Add to history" ariaLabel="Add to history steps" onFinish={finish}
        header={<div className="ocr-modal-head">
          <div className="ocr-modal-heading">
            <div className="ocr-modal-title">Add to history</div>
            <div className="ocr-muted ocr-ellipsis">{item.filename}</div>
          </div>
          <IconButton icon="close" label="Close" size="sm" onClick={onClose} />
        </div>} />
    </div>
  </div>;
};

export { OCRHistoryWizard };
