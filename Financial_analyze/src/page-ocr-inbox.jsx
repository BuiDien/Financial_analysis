// OCR Inbox — upload unlabeled PDFs, send them to a paired worker, review every
// returned row against its source, then label and publish verified data.

// Pure helpers come from src/ocr-inbox-utils.js (must load first).
const OCR_INBOX_UTILS = window.OcrInboxUtils;
const OCR_STATUS = OCR_INBOX_UTILS.OCR_STATUS;
const fmtInboxBytes = OCR_INBOX_UTILS.fmtInboxBytes;
const splitMarkdownTableRow = OCR_INBOX_UTILS.splitMarkdownTableRow;
const isMarkdownTableSeparator = OCR_INBOX_UTILS.isMarkdownTableSeparator;
const markdownHasTable = OCR_INBOX_UTILS.markdownHasTable;
const serializeMarkdownTableRow = OCR_INBOX_UTILS.serializeMarkdownTableRow;
const parseExactDecimal = OCR_INBOX_UTILS.parseExactDecimal;
const exactMagnitude = OCR_INBOX_UTILS.exactMagnitude;
const compareExactMagnitudes = OCR_INBOX_UTILS.compareExactMagnitudes;
const addExactMagnitudes = OCR_INBOX_UTILS.addExactMagnitudes;
const subtractExactMagnitudes = OCR_INBOX_UTILS.subtractExactMagnitudes;
const addExactUnits = OCR_INBOX_UTILS.addExactUnits;
const scaleExactUnits = OCR_INBOX_UTILS.scaleExactUnits;
const sumExactDecimals = OCR_INBOX_UTILS.sumExactDecimals;
const subtractExactDecimals = OCR_INBOX_UTILS.subtractExactDecimals;
const formatExactDecimal = OCR_INBOX_UTILS.formatExactDecimal;
const safeTableSpan = OCR_INBOX_UTILS.safeTableSpan;
const spreadsheetColumnLabel = OCR_INBOX_UTILS.spreadsheetColumnLabel;
const LABEL_LEVEL_VALUES = OCR_INBOX_UTILS.LABEL_LEVEL_VALUES;
const LABEL_LEVELS = OCR_INBOX_UTILS.LABEL_LEVELS;
const LABEL_LEVEL_SHORT = OCR_INBOX_UTILS.LABEL_LEVEL_SHORT;
const LABEL_LEVEL_MARKER = OCR_INBOX_UTILS.LABEL_LEVEL_MARKER;
const labelLevelCode = OCR_INBOX_UTILS.labelLevelCode;
const labelLevelIndent = OCR_INBOX_UTILS.labelLevelIndent;
const explicitLabelLevel = OCR_INBOX_UTILS.explicitLabelLevel;
const visibleCellText = OCR_INBOX_UTILS.visibleCellText;
const withLabelLevel = OCR_INBOX_UTILS.withLabelLevel;
const levelMismatchCells = OCR_INBOX_UTILS.levelMismatchCells;
const inferredLabelLevel = OCR_INBOX_UTILS.inferredLabelLevel;
const HISTORY_KIND_OPTIONS = OCR_INBOX_UTILS.HISTORY_KIND_OPTIONS;
const HISTORY_KIND_NAMES = OCR_INBOX_UTILS.HISTORY_KIND_NAMES;
const HISTORY_UNIT_OPTIONS = OCR_INBOX_UTILS.HISTORY_UNIT_OPTIONS;
const HISTORY_TABLE_CODES = OCR_INBOX_UTILS.HISTORY_TABLE_CODES;
const HISTORY_EMPTY_DRAFT = OCR_INBOX_UTILS.HISTORY_EMPTY_DRAFT;
const historyTableKey = OCR_INBOX_UTILS.historyTableKey;
const historyRowKey = OCR_INBOX_UTILS.historyRowKey;
const historyMisreadKey = OCR_INBOX_UTILS.historyMisreadKey;
const historyDmy = OCR_INBOX_UTILS.historyDmy;
const historyPeriodValue = OCR_INBOX_UTILS.historyPeriodValue;
const historyPeriodText = OCR_INBOX_UTILS.historyPeriodText;
const historyPeriodOptions = OCR_INBOX_UTILS.historyPeriodOptions;
const historyMoney = OCR_INBOX_UTILS.historyMoney;
const historyPayload = OCR_INBOX_UTILS.historyPayload;
const HISTORY_SCOPE_OPTIONS = OCR_INBOX_UTILS.HISTORY_SCOPE_OPTIONS;
const HISTORY_PERIOD_CODE_OPTIONS = OCR_INBOX_UTILS.HISTORY_PERIOD_CODE_OPTIONS;
const LABEL_UNIT_OPTIONS = OCR_INBOX_UTILS.LABEL_UNIT_OPTIONS;
const inboxLabelSummary = OCR_INBOX_UTILS.inboxLabelSummary;
const inboxLatestQuarter = OCR_INBOX_UTILS.inboxLatestQuarter;
const historyFiscalYearOptions = OCR_INBOX_UTILS.historyFiscalYearOptions;

// Verified reviews are read-only; POST /api/ocr-inbox/{item_id}/review/reopen makes one
// editable again. Resolves null when the owner cancels.
const reopenVerifiedOcrReview = async (item, review) => {
  const confirmed = await window.askConfirm({
    title: 'Reopen verified review?',
    message: 'The review becomes editable again. Verify it again before adding it to history or publishing.',
    confirmText: 'Reopen',
  });
  if (!confirmed) return null;
  const api = window.HelixAPI;
  return api.ocrReviewReopen
    ? api.ocrReviewReopen(item.id, review.revision)
    : api._send('POST', `/api/ocr-inbox/${item.id}/review/reopen`, { revision: review.revision });
};
const ocrNeedsReopen = message => /must be reopened/i.test(String(message || ''));

const InboxStatus = ({ status }) => {
  const spec = OCR_STATUS[status] || [status, 'var(--text-muted)'];
  return <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: spec[1] }}>{spec[0]}</span>;
};

const safeMarkdownHref = href => {
  try {
    const url = new URL(href, window.location.href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
};

const MarkdownInline = ({ text, prefix }) => {
  const tokens = String(text || '').split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return <>{tokens.map((token, index) => {
    const key = `${prefix}-${index}`;
    if (token.startsWith('`') && token.endsWith('`')) return <code key={key} style={{ padding: '1px 4px', borderRadius: 3, background: 'var(--bg-sunken)', fontFamily: 'var(--font-mono)', fontSize: '.92em' }}>{token.slice(1, -1)}</code>;
    if (token.startsWith('**') && token.endsWith('**')) return <strong key={key}>{token.slice(2, -2)}</strong>;
    const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = safeMarkdownHref(link[2]);
      return href ? <a key={key} href={href} target="_blank" rel="noreferrer">{link[1]}</a> : <span key={key}>{link[1]}</span>;
    }
    return <React.Fragment key={key}>{token}</React.Fragment>;
  })}</>;
};

const LabelLevelBadge = ({ level }) => <span
  aria-hidden="true"
  title={`${labelLevelCode(level)} · ${LABEL_LEVELS[level]}`}
  style={{ flex: '0 0 auto', minWidth: 22, padding: '1px 4px', border: '1px solid var(--border-strong)', borderRadius: 3, background: level <= 0 ? 'var(--text)' : 'var(--bg-elev)', color: level <= 0 ? 'var(--bg-elev)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, lineHeight: 1.35, textAlign: 'center' }}
>{labelLevelCode(level)}</span>;

const OCRTableReview = ({ headers = [], rows, alignments = [], tableKey, tableNumber = 1, rowNumberOffset = 1, onMergeRows, onEditCell, onPasteCells, onSetCellLevel, onSelectionSummary, mismatchCells = {}, mismatchTarget = null, labelSuggestions = [], markedLabelRows = [], onToggleLabelMark = null, onAskHermesForLabel = null, onDecideLabelSuggestion = null, embeddedHeaders = false, headerRows = 0 }) => {
  const initialPoint = rows.length ? { row: Math.min(headerRows, rows.length - 1), col: 0 } : null;
  const [selectedRows, setSelectedRows] = React.useState([]);
  const [rowAnchor, setRowAnchor] = React.useState(null);
  const [selection, setSelection] = React.useState(null);
  const [selectionAnchor, setSelectionAnchor] = React.useState(null);
  const [extraSelectedCells, setExtraSelectedCells] = React.useState(() => new Set());
  const [additiveActiveCell, setAdditiveActiveCell] = React.useState(null);
  const [dragging, setDragging] = React.useState(false);
  const [tableError, setTableError] = React.useState('');
  const [tableNotice, setTableNotice] = React.useState('');
  const [editingCell, setEditingCell] = React.useState(null);
  const [editValue, setEditValue] = React.useState('');
  const cancelEditRef = React.useRef(false);
  const [clipboard, setClipboard] = React.useState(null);
  const [contextMenu, setContextMenu] = React.useState(null);

  const cellText = visibleCellText;
  const maxColumns = Math.max(headers.length, ...rows.map(row => row.reduce((count, cell) => count + (typeof cell === 'object' ? cell.colSpan : 1), 0)));
  const selectedBounds = selection ? {
    rowStart: Math.min(selection.start.row, selection.end.row),
    rowEnd: Math.max(selection.start.row, selection.end.row),
    colStart: Math.min(selection.start.col, selection.end.col),
    colEnd: Math.max(selection.start.col, selection.end.col),
  } : null;
  const cellKey = (row, col) => `${row}:${col}`;
  const isCellSelected = (row, col) => Boolean(
    (selectedBounds
      && row >= selectedBounds.rowStart && row <= selectedBounds.rowEnd
      && col >= selectedBounds.colStart && col <= selectedBounds.colEnd)
    || extraSelectedCells.has(cellKey(row, col))
  );

  const numericCells = [];
  rows.forEach((row, rowIndex) => row.forEach((cell, cellIndex) => {
    const text = cellText(cell);
    const parsed = parseExactDecimal(text);
    if (parsed && (!embeddedHeaders || rowIndex >= headerRows)) numericCells.push({ id: `${rowIndex}:${cellIndex}`, rowIndex, cellIndex, text, parsed });
  }));
  const addends = numericCells.filter(cell => isCellSelected(cell.rowIndex, cell.cellIndex));
  const sum = addends.length ? sumExactDecimals(addends.map(cell => cell.parsed)) : null;
  const selectionTotal = sum ? formatExactDecimal(sum) : '—';
  const mergeRowIndexes = selectedRows.length
    ? [...selectedRows].sort((a, b) => a - b)
    : selectedBounds && extraSelectedCells.size === 0 && selectedBounds.rowEnd > selectedBounds.rowStart
      ? Array.from({ length: selectedBounds.rowEnd - selectedBounds.rowStart + 1 }, (_, offset) => selectedBounds.rowStart + offset)
      : [];
  const selectedAreAdjacent = mergeRowIndexes.length >= 2
    && mergeRowIndexes.every((value, index, values) => index === 0 || value === values[index - 1] + 1)
    && (!embeddedHeaders || mergeRowIndexes[0] >= headerRows);
  const continuousSelection = Boolean(selectedBounds && extraSelectedCells.size === 0);

  const selectRow = (rowIndex, restart = false) => {
    setTableError('');
    setTableNotice('');
    if (!restart && rowAnchor !== null) {
      const start = Math.min(rowAnchor, rowIndex);
      const end = Math.max(rowAnchor, rowIndex);
      setSelectedRows(Array.from({ length: end - start + 1 }, (_, offset) => start + offset));
    } else {
      setSelectedRows([rowIndex]);
      setRowAnchor(rowIndex);
    }
    setSelection(null);
    setSelectionAnchor(null);
    setExtraSelectedCells(new Set());
    setAdditiveActiveCell(null);
  };
  const selectCell = (row, col, restart = false) => {
    setTableError('');
    setTableNotice('');
    const point = { row, col };
    const anchor = !restart ? (selectionAnchor || additiveActiveCell || point) : point;
    setSelection({ start: anchor, end: point });
    if (restart || !selectionAnchor) setSelectionAnchor(anchor);
    setExtraSelectedCells(new Set());
    setAdditiveActiveCell(null);
    setSelectedRows([]);
    setRowAnchor(null);
    setEditingCell(null);
    setEditValue(cellText(rows[row]?.[col]) || '');
  };
  React.useEffect(() => {
    onSelectionSummary?.({ tableNumber, count: addends.length, total: selectionTotal });
  }, [tableNumber, addends.length, selectionTotal, onSelectionSummary]);
  React.useEffect(() => {
    if (!mismatchTarget || mismatchTarget.table !== tableNumber) return;
    const row = mismatchTarget.row - rowNumberOffset;
    const col = mismatchTarget.column - 1;
    if (!rows[row] || col < 0 || col >= rows[row].length) return;
    const point = { row, col };
    setSelection({ start: point, end: point });
    setSelectionAnchor(point);
    setExtraSelectedCells(new Set());
    setAdditiveActiveCell(null);
    setSelectedRows([]);
    setRowAnchor(null);
    setEditingCell(null);
    window.requestAnimationFrame(() => {
      const cell = window.document.querySelector(`[data-ocr-table="${tableNumber}"][data-ocr-row="${mismatchTarget.row}"][data-ocr-column="${mismatchTarget.column}"]`);
      cell?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      cell?.focus({ preventScroll: true });
    });
  }, [mismatchTarget?.token, tableNumber, rowNumberOffset]);
  const toggleAdditiveCell = (row, col) => {
    setTableError('');
    setTableNotice('');
    const point = { row, col };
    const id = cellKey(row, col);
    const next = new Set(extraSelectedCells);
    const insideRange = Boolean(selectedBounds
      && row >= selectedBounds.rowStart && row <= selectedBounds.rowEnd
      && col >= selectedBounds.colStart && col <= selectedBounds.colEnd);
    if (insideRange) {
      for (let rangeRow = selectedBounds.rowStart; rangeRow <= selectedBounds.rowEnd; rangeRow += 1) {
        const lastColumn = Math.min(selectedBounds.colEnd, (rows[rangeRow]?.length || 1) - 1);
        for (let rangeCol = selectedBounds.colStart; rangeCol <= lastColumn; rangeCol += 1) {
          const rangeId = cellKey(rangeRow, rangeCol);
          if (rangeId !== id) next.add(rangeId);
        }
      }
      setSelection(null);
      setSelectionAnchor(null);
    } else if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    const lastId = [...next].at(-1);
    const fallback = lastId ? lastId.split(':').map(Number) : null;
    setExtraSelectedCells(next);
    setAdditiveActiveCell(next.has(id) ? point : (!insideRange && selection?.end) || (fallback ? { row: fallback[0], col: fallback[1] } : null));
    setSelectedRows([]);
    setRowAnchor(null);
    setEditingCell(null);
    setEditValue(cellText(rows[row]?.[col]) || '');
  };
  const moveSelection = (event, row, col) => {
    const movement = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
    if (!movement) return;
    event.preventDefault();
    const nextRow = Math.max(0, Math.min(rows.length - 1, row + movement[0]));
    const nextCol = Math.max(0, Math.min((rows[nextRow]?.length || 1) - 1, col + movement[1]));
    selectCell(nextRow, nextCol, !event.shiftKey);
  };
  const beginEdit = (row, col) => {
    if (!onEditCell) return;
    selectCell(row, col, true);
    cancelEditRef.current = false;
    setEditingCell({ row, col });
    setEditValue(cellText(rows[row]?.[col]) || '');
  };
  const saveEdit = () => {
    if (!editingCell || !onEditCell) return;
    if (cancelEditRef.current) { cancelEditRef.current = false; setEditingCell(null); return; }
    const error = onEditCell(editingCell.row, editingCell.col, editValue);
    if (error) { setTableError(error); return; }
    setEditingCell(null);
  };
  const clearCellSelection = () => {
    setSelection(null);
    setSelectionAnchor(null);
    setExtraSelectedCells(new Set());
    setAdditiveActiveCell(null);
    setSelectedRows([]);
    setRowAnchor(null);
    setEditingCell(null);
    setTableError('');
    setTableNotice('');
  };
  const selectedMatrix = () => {
    if (!selectedBounds) return null;
    return Array.from({ length: selectedBounds.rowEnd - selectedBounds.rowStart + 1 }, (_, rowOffset) =>
      Array.from({ length: selectedBounds.colEnd - selectedBounds.colStart + 1 }, (_, colOffset) =>
        cellText(rows[selectedBounds.rowStart + rowOffset]?.[selectedBounds.colStart + colOffset]) || ''));
  };
  const copyCells = async cut => {
    setTableNotice('');
    if (extraSelectedCells.size) {
      setTableError('Copy and cut require one continuous range. Clear the individual cell selection first.');
      return;
    }
    const matrix = selectedMatrix();
    if (!matrix) { setTableError('Select one or more cells first.'); return; }
    const text = matrix.map(row => row.join('\t')).join('\n');
    setClipboard({ text, matrix, cut, bounds: selectedBounds });
    try { await window.navigator.clipboard?.writeText(text); } catch { /* Internal clipboard remains available. */ }
    setTableError('');
    setTableNotice(cut ? 'Cells are ready to move. Select the destination and paste.' : 'Selection copied.');
  };
  const pasteCells = async () => {
    setTableNotice('');
    if (!activeCell || !onPasteCells) { setTableError('Select the destination cell before pasting.'); return; }
    let text = clipboard?.text || '';
    try { text = await window.navigator.clipboard?.readText() || text; } catch { /* Use the internal clipboard. */ }
    if (!text) { setTableError('Nothing is available to paste. Copy cells first.'); return; }
    const matrix = text.replace(/\r\n?/g, '\n').split('\n').map(row => row.split('\t'));
    const edits = [];
    const internalCut = clipboard?.cut && clipboard.text === text;
    if (internalCut) {
      for (let row = clipboard.bounds.rowStart; row <= clipboard.bounds.rowEnd; row += 1) {
        for (let col = clipboard.bounds.colStart; col <= clipboard.bounds.colEnd; col += 1) edits.push({ row, col, value: '' });
      }
    }
    matrix.forEach((values, rowOffset) => values.forEach((value, colOffset) => edits.push({ row: activeCell.row + rowOffset, col: activeCell.col + colOffset, value })));
    const error = onPasteCells(edits);
    if (error) { setTableError(error); return; }
    setSelection({ start: activeCell, end: { row: activeCell.row + matrix.length - 1, col: activeCell.col + Math.max(0, ...matrix.map(row => row.length - 1)) } });
    setSelectionAnchor(activeCell);
    setExtraSelectedCells(new Set());
    setAdditiveActiveCell(null);
    if (internalCut) setClipboard(current => ({ ...current, cut: false }));
    setTableError('');
    setTableNotice(internalCut ? 'Cells moved. Save the page correction when finished.' : 'Cells pasted. Save the page correction when finished.');
  };
  const openContextMenu = (event, cell = null) => {
    event.preventDefault();
    setContextMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 210)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 310)), cell });
  };
  const setActiveLabelLevel = (level, target = activeCell) => {
    if (!target || !onSetCellLevel) return;
    const error = onSetCellLevel(target.row, target.col, level);
    if (error) { setTableError(error); return; }
    setTableError('');
    setTableNotice(`Label changed to ${labelLevelCode(level)} · ${LABEL_LEVELS[level]}. Save the page correction when finished.`);
  };
  const merge = () => {
    setTableNotice('');
    if (!selectedAreAdjacent) {
      setTableError('Select two or more adjacent OCR rows to merge.');
      return;
    }
    const error = onMergeRows?.(mergeRowIndexes);
    if (error) { setTableError(error); return; }
    setSelectedRows([]);
    setRowAnchor(null);
    setSelection(null);
    setSelectionAnchor(null);
    setExtraSelectedCells(new Set());
    setAdditiveActiveCell(null);
  };
  const applySuggestedValue = (event, rowIndex, cellIndex, value) => {
    event.preventDefault();
    event.stopPropagation();
    if (!onEditCell) return;
    const error = onEditCell(rowIndex, cellIndex, value);
    if (error) {
      setTableError(error);
      return;
    }
    setTableError('');
    setTableNotice(`Suggested total applied to ${spreadsheetColumnLabel(cellIndex)}${embeddedHeaders ? rowIndex + 1 : rowIndex + 2}. Review it against the scan, then save the page correction.`);
  };

  const activeCell = selection?.end || additiveActiveCell;
  const activeName = activeCell ? `${spreadsheetColumnLabel(activeCell.col)}${activeCell.row + 1}` : '—';
  const activeValue = activeCell ? cellText(rows[activeCell.row]?.[activeCell.col]) || '' : '';
  const activeIsHeader = activeCell ? embeddedHeaders && (rows[activeCell.row]?.[activeCell.col]?.header || activeCell.row < headerRows) : false;
  const activeLabelLevel = activeCell ? inferredLabelLevel(rows[activeCell.row]?.[activeCell.col], rows[activeCell.row] || [], activeCell.col, activeIsHeader) : null;
  const activeLabelTarget = activeCell && activeCell.col === 0 && !activeIsHeader && visibleCellText(rows[activeCell.row]?.[activeCell.col])
    ? { table: tableNumber, row: activeCell.row + rowNumberOffset }
    : null;
  const activeLabelMarked = activeLabelTarget && markedLabelRows.some(target => target.table === activeLabelTarget.table && target.row === activeLabelTarget.row);
  const contextCell = contextMenu ? contextMenu.cell : activeCell;
  const contextIsHeader = contextCell ? embeddedHeaders && (rows[contextCell.row]?.[contextCell.col]?.header || contextCell.row < headerRows) : false;
  const contextLabelLevel = contextCell ? inferredLabelLevel(rows[contextCell.row]?.[contextCell.col], rows[contextCell.row] || [], contextCell.col, contextIsHeader) : null;
  const contextLabelTarget = contextCell && contextCell.col === 0 && !contextIsHeader && visibleCellText(rows[contextCell.row]?.[contextCell.col])
    ? { table: tableNumber, row: contextCell.row + rowNumberOffset }
    : null;
  const contextLabelMarked = contextLabelTarget && markedLabelRows.some(target => target.table === contextLabelTarget.table && target.row === contextLabelTarget.row);

  return <div style={{ margin: '0 0 16px', border: '1px solid var(--border)', borderRadius: 6 }}>
    <div style={{ position: 'sticky', top: 0, zIndex: 8, padding: 8, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', background: 'var(--bg-sunken)', borderBottom: '1px solid var(--border)', boxShadow: '0 2px 5px rgba(0,0,0,.12)' }}>
      {onMergeRows && <button type="button" className="btn" disabled={!selectedAreAdjacent} onClick={merge}>Merge rows</button>}
      <button type="button" className="btn" disabled={!selection && !extraSelectedCells.size && !selectedRows.length} onClick={clearCellSelection}>Clear selection</button>
      {onToggleLabelMark && <button type="button" className="btn" disabled={!activeLabelTarget} onClick={() => activeLabelTarget && onToggleLabelMark(activeLabelTarget)}>{activeLabelMarked ? 'Unmark label' : 'Mark label for Ollama'}</button>}
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Drag or Shift-click for a range. Command-click on Mac or Ctrl-click elsewhere toggles individual cells. Double-click edits a cell.</span>
      <span aria-label="Label hierarchy: L text-only label, level 0 total, level 1 group, level 2 item, level 3 detail" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', color: 'var(--text-muted)', fontSize: 10 }}>
        <strong style={{ color: 'var(--text)' }}>Hierarchy</strong>
        {LABEL_LEVEL_VALUES.map(level => <span key={level} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontStyle: level === 3 ? 'italic' : 'normal' }}><LabelLevelBadge level={level} />{LABEL_LEVEL_SHORT[level]}</span>)}
      </span>
    </div>
    {tableError && <div role="alert" style={{ padding: '7px 10px', color: 'var(--neg)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{tableError}</div>}
    {tableNotice && <div role="status" style={{ padding: '7px 10px', color: 'var(--pos)', borderBottom: '1px solid var(--border)', fontSize: 11 }}>{tableNotice}</div>}
    <div style={{ display: 'grid', gridTemplateColumns: '58px minmax(0, 1fr) auto', alignItems: 'center', minHeight: 34, borderBottom: '1px solid var(--border)', background: 'var(--bg-elev)' }}>
      <div className="num" aria-label="Active cell" style={{ padding: '7px 9px', textAlign: 'center', borderRight: '1px solid var(--border)', fontSize: 11, fontWeight: 700 }}>{activeName}</div>
      <div title={activeValue} style={{ padding: '7px 10px', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{activeValue || 'Select a cell'}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginRight: 8 }}>
        {activeLabelLevel !== null && onSetCellLevel && <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-muted)', fontSize: 10 }}>Label level
          <select value={activeLabelLevel} onChange={event => setActiveLabelLevel(Number(event.target.value))} style={{ padding: '5px 7px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-elev)', color: 'var(--text)', fontSize: 11 }}>
            {LABEL_LEVEL_VALUES.map(level => <option key={level} value={level}>{labelLevelCode(level)} · {LABEL_LEVELS[level]}</option>)}
          </select>
        </label>}
        {activeCell && onEditCell && <button type="button" className="card-action" onClick={() => beginEdit(activeCell.row, activeCell.col)}>Edit cell</button>}
      </div>
    </div>
    {contextMenu && <>
      <div aria-hidden="true" onMouseDown={() => setContextMenu(null)} onContextMenu={event => { event.preventDefault(); setContextMenu(null); }} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
      <div autoFocus tabIndex={-1} role="menu" aria-label="Spreadsheet actions" onKeyDown={event => { if (event.key === 'Escape') setContextMenu(null); }} style={{ position: 'fixed', left: contextMenu.x, top: contextMenu.y, zIndex: 50, width: 200, padding: 5, border: '1px solid var(--border-strong)', borderRadius: 6, background: 'var(--bg-elev)', boxShadow: '0 8px 24px rgba(0,0,0,.18)' }}>
        {onAskHermesForLabel && <button type="button" role="menuitem" disabled={!contextLabelTarget} onClick={() => { if (contextLabelTarget) onAskHermesForLabel(contextLabelTarget); setContextMenu(null); }} style={{ display: 'block', width: '100%', padding: '8px 9px', border: 0, borderRadius: 4, textAlign: 'left', background: '#7c3aed', color: 'white', cursor: contextLabelTarget ? 'pointer' : 'not-allowed', fontWeight: 700 }}>Ask Ollama now</button>}
        {onToggleLabelMark && <button type="button" role="menuitem" disabled={!contextLabelTarget} onClick={() => { if (contextLabelTarget) onToggleLabelMark(contextLabelTarget); setContextMenu(null); }} style={{ display: 'block', width: '100%', padding: '8px 9px', border: 0, borderRadius: 4, textAlign: 'left', background: 'transparent', color: 'var(--text)', cursor: contextLabelTarget ? 'pointer' : 'not-allowed', fontWeight: 700 }}>{contextLabelMarked ? 'Unmark Ollama label' : 'Mark label for Ollama'}</button>}
        {onMergeRows && <button type="button" role="menuitem" disabled={!selectedAreAdjacent} onClick={() => { merge(); setContextMenu(null); }} style={{ display: 'block', width: '100%', padding: '8px 9px', border: 0, borderRadius: 4, textAlign: 'left', background: 'transparent', color: 'var(--text)', cursor: selectedAreAdjacent ? 'pointer' : 'not-allowed' }}>Merge selected rows</button>}
        <button type="button" role="menuitem" disabled={!continuousSelection} onClick={() => { copyCells(false); setContextMenu(null); }} style={{ display: 'block', width: '100%', padding: '8px 9px', border: 0, borderRadius: 4, textAlign: 'left', background: 'transparent', color: 'var(--text)', cursor: continuousSelection ? 'pointer' : 'not-allowed' }}>Copy <span style={{ float: 'right', color: 'var(--text-muted)' }}>⌘C</span></button>
        <button type="button" role="menuitem" disabled={!continuousSelection} onClick={() => { copyCells(true); setContextMenu(null); }} style={{ display: 'block', width: '100%', padding: '8px 9px', border: 0, borderRadius: 4, textAlign: 'left', background: 'transparent', color: 'var(--text)', cursor: continuousSelection ? 'pointer' : 'not-allowed' }}>Cut / move <span style={{ float: 'right', color: 'var(--text-muted)' }}>⌘X</span></button>
        <button type="button" role="menuitem" disabled={!activeCell || !onPasteCells} onClick={() => { pasteCells(); setContextMenu(null); }} style={{ display: 'block', width: '100%', padding: '8px 9px', border: 0, borderRadius: 4, textAlign: 'left', background: 'transparent', color: 'var(--text)', cursor: activeCell && onPasteCells ? 'pointer' : 'not-allowed' }}>Paste <span style={{ float: 'right', color: 'var(--text-muted)' }}>⌘V</span></button>
        <button type="button" role="menuitem" disabled={!activeCell || !onEditCell} onClick={() => { beginEdit(activeCell.row, activeCell.col); setContextMenu(null); }} style={{ display: 'block', width: '100%', padding: '8px 9px', border: 0, borderRadius: 4, textAlign: 'left', background: 'transparent', color: 'var(--text)', cursor: activeCell && onEditCell ? 'pointer' : 'not-allowed' }}>Edit cell</button>
        <button type="button" role="menuitem" disabled={contextLabelLevel === null || !onSetCellLevel || contextLabelLevel === -1} onClick={() => { setActiveLabelLevel(contextLabelLevel - 1, contextCell); setContextMenu(null); }} style={{ display: 'block', width: '100%', padding: '8px 9px', border: 0, borderRadius: 4, textAlign: 'left', background: 'transparent', color: 'var(--text)', cursor: contextLabelLevel > -1 ? 'pointer' : 'not-allowed' }}>Promote to {labelLevelCode(Math.max(-1, (contextLabelLevel ?? 0) - 1))}</button>
        <button type="button" role="menuitem" disabled={contextLabelLevel === null || !onSetCellLevel || contextLabelLevel === 3} onClick={() => { setActiveLabelLevel(contextLabelLevel + 1, contextCell); setContextMenu(null); }} style={{ display: 'block', width: '100%', padding: '8px 9px', border: 0, borderRadius: 4, textAlign: 'left', background: 'transparent', color: 'var(--text)', cursor: contextLabelLevel !== null && contextLabelLevel < 3 ? 'pointer' : 'not-allowed' }}>Demote to {labelLevelCode(Math.min(3, (contextLabelLevel ?? 2) + 1))}</button>
      </div>
    </>}
    <div style={{ overflowX: 'auto' }}>
      <table role="grid" aria-label="OCR spreadsheet review" aria-multiselectable="true" onMouseUp={() => setDragging(false)} onMouseLeave={() => setDragging(false)} style={{ width: '100%', minWidth: Math.max(560, maxColumns * 120), borderCollapse: 'collapse', fontSize: 12, userSelect: dragging ? 'none' : 'auto' }}>
        <thead><tr>
          <th scope="col" style={{ width: 44, padding: '5px 4px', textAlign: 'center', background: 'var(--bg-sunken)', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 10 }} aria-label="Row numbers" />
          {Array.from({ length: maxColumns }, (_, cellIndex) => <th key={`letter-${cellIndex}`} scope="col" style={{ padding: '5px 8px', textAlign: 'center', background: 'var(--bg-sunken)', borderBottom: '1px solid var(--border)', borderLeft: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 10, fontWeight: 700 }}>{spreadsheetColumnLabel(cellIndex)}</th>)}
        </tr>
        {!embeddedHeaders && <tr>
          <th scope="col" style={{ width: 44, padding: '6px 4px', textAlign: 'center', background: 'var(--bg-sunken)', borderBottom: '1px solid var(--border-strong)', color: 'var(--text-muted)', fontSize: 10 }}>1</th>
          {headers.map((header, cellIndex) => <th key={`h-${cellIndex}`} scope="col" style={{ padding: '8px 10px', textAlign: alignments[cellIndex] || 'left', verticalAlign: 'bottom', background: 'var(--bg-sunken)', borderBottom: '1px solid var(--border-strong)', borderLeft: '1px solid var(--border)', fontWeight: 700 }}><MarkdownInline text={header} prefix={`h-${tableKey}-${cellIndex}`} /></th>)}
        </tr>}
        </thead>
        <tbody>{rows.map((row, rowIndex) => {
          const reviewableRow = !embeddedHeaders || rowIndex >= headerRows;
          const rowSuggestion = labelSuggestions.find(suggestion => (
            suggestion.row === rowIndex + rowNumberOffset
            && !['rejected', 'stale'].includes(suggestion.decision)
            && suggestion.applied_revision === null
          ));
          const markedForHermes = markedLabelRows.some(target => (
            target.table === tableNumber && target.row === rowIndex + rowNumberOffset
          ));
          return <tr key={`r-${rowIndex}`} style={{ background: selectedRows.includes(rowIndex) ? 'var(--bg-sunken)' : 'transparent' }}>
          <th scope="row" onContextMenu={event => { if (!selectedRows.includes(rowIndex)) selectRow(rowIndex, true); openContextMenu(event); }} style={{ width: 44, padding: 0, textAlign: 'center', background: selectedRows.includes(rowIndex) ? 'var(--bg-sunken)' : 'var(--bg-elev)', borderBottom: rowIndex < rows.length - 1 ? '1px solid var(--border)' : 'none', color: 'var(--text-muted)', fontSize: 10 }}>
            {reviewableRow && onMergeRows ? <button type="button" onClick={() => selectRow(rowIndex)} aria-label={`Select OCR row ${rowIndex + 1}`} style={{ width: '100%', minHeight: 32, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' }}>{embeddedHeaders ? rowIndex + 1 : rowIndex + 2}</button> : (embeddedHeaders ? rowIndex + 1 : rowIndex + 2)}
          </th>
          {row.map((cell, cellIndex) => {
            const cellValue = cellText(cell);
            const numeric = reviewableRow && Boolean(parseExactDecimal(cellValue));
            const isHeader = embeddedHeaders && (cell.header || rowIndex < headerRows);
            const Cell = isHeader ? 'th' : 'td';
            const selected = isCellSelected(rowIndex, cellIndex);
            const inlineEditing = editingCell?.row === rowIndex && editingCell?.col === cellIndex;
            const labelLevel = inferredLabelLevel(cell, row, cellIndex, isHeader);
            const labelWeight = labelLevel !== null && labelLevel <= 0 ? 700 : labelLevel === 1 ? 600 : 400;
            const labelCell = labelLevel !== null && cellIndex === 0 && !isHeader;
            const mismatch = mismatchCells[`${rowIndex}:${cellIndex}`];
            const mismatchMessage = mismatch?.messages.join('\n');
            const hermesSuggestion = labelCell ? rowSuggestion : null;
            const hermesMessage = hermesSuggestion ? (hermesSuggestion.suggested_label
              ? `Ollama suggests “${hermesSuggestion.suggested_label}” (${hermesSuggestion.confidence} confidence).`
              : `Ollama suggests ${labelLevelCode(hermesSuggestion.user_edited_level ?? hermesSuggestion.suggested_level)} (${hermesSuggestion.confidence} confidence).`) : '';
            const accessibleLabel = mismatchMessage || hermesMessage || (markedForHermes && labelCell ? `Marked for Ollama review: ${cellValue}` : null) || (labelCell ? `${LABEL_LEVELS[labelLevel]}: ${cellValue}` : undefined);
            return <Cell key={`c-${cellIndex}`} role="gridcell" data-ocr-table={tableNumber} data-ocr-row={rowIndex + rowNumberOffset} data-ocr-column={cellIndex + 1} tabIndex={selected || ((!selection && !extraSelectedCells.size) && initialPoint?.row === rowIndex && initialPoint?.col === cellIndex) ? 0 : -1} aria-selected={Boolean(selected)} aria-invalid={mismatch ? 'true' : undefined} aria-label={accessibleLabel} title={mismatchMessage || hermesMessage || (markedForHermes && labelCell ? 'Marked for Ollama review' : null) || (labelLevel !== null ? `${labelLevelCode(labelLevel)} · ${LABEL_LEVELS[labelLevel]}` : undefined)} rowSpan={typeof cell === 'object' ? cell.rowSpan : undefined} colSpan={typeof cell === 'object' ? cell.colSpan : undefined} onMouseDown={event => { if (inlineEditing || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); const additive = event.metaKey || event.ctrlKey; if (additive) { toggleAdditiveCell(rowIndex, cellIndex); setDragging(false); } else { selectCell(rowIndex, cellIndex, !event.shiftKey); setDragging(true); } }} onMouseEnter={event => { if (dragging && selectionAnchor && (event.buttons & 1) === 1) setSelection({ start: selectionAnchor, end: { row: rowIndex, col: cellIndex } }); else if (dragging && (event.buttons & 1) === 0) setDragging(false); }} onContextMenu={event => { if (event.ctrlKey) { event.preventDefault(); return; } if (!selected) selectCell(rowIndex, cellIndex, true); openContextMenu(event, { row: rowIndex, col: cellIndex }); }} onDoubleClick={() => beginEdit(rowIndex, cellIndex)} onKeyDown={event => { const shortcut = event.metaKey || event.ctrlKey; const key = event.key.toLowerCase(); if (shortcut && ['c', 'x', 'v'].includes(key)) { event.preventDefault(); if (key === 'c') copyCells(false); if (key === 'x') copyCells(true); if (key === 'v') pasteCells(); } else if (event.key === 'Enter') beginEdit(rowIndex, cellIndex); else moveSelection(event, rowIndex, cellIndex); }} style={{ padding: inlineEditing ? 2 : '7px 10px', textAlign: labelCell ? 'left' : (typeof cell === 'object' && cell.align) || alignments[cellIndex] || (numeric ? 'right' : 'left'), verticalAlign: 'top', outline: selected ? '2px solid var(--pos)' : 'none', outlineOffset: -2, boxShadow: !selected && mismatch ? `inset 0 0 0 ${mismatch.priority ? 3 : mismatch.parent ? 2 : 1}px var(--neg)` : !selected && hermesSuggestion ? 'inset 0 0 0 2px #7c3aed' : !selected && markedForHermes && labelCell ? 'inset 0 0 0 2px #2563eb' : 'none', borderBottom: rowIndex < rows.length - 1 ? '1px solid var(--border)' : 'none', borderLeft: '1px solid var(--border)', background: selected ? 'var(--pos-bg)' : mismatch ? 'var(--neg-bg)' : hermesSuggestion ? 'rgba(124,58,237,.10)' : markedForHermes && labelCell ? 'rgba(37,99,235,.10)' : (labelLevel !== null && labelLevel <= 0) || isHeader ? 'var(--bg-sunken)' : 'transparent', fontWeight: labelLevel !== null ? labelWeight : isHeader ? 700 : 400, fontStyle: labelLevel === 3 ? 'italic' : 'normal', color: selected ? 'var(--pos)' : mismatch ? 'var(--neg)' : labelLevel === 3 ? 'var(--text-muted)' : 'var(--text)', fontFamily: numeric ? 'var(--font-mono)' : 'inherit', fontVariantNumeric: 'tabular-nums', cursor: 'cell' }}>
              {inlineEditing ? <input autoFocus value={editValue} onMouseDown={event => event.stopPropagation()} onChange={event => setEditValue(event.target.value)} onBlur={saveEdit} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { cancelEditRef.current = true; event.currentTarget.blur(); } }} aria-label={`Edit cell ${activeName}`} style={{ width: '100%', minWidth: 90, padding: '5px 7px', border: '1px solid var(--accent)', borderRadius: 3, background: 'var(--bg-elev)', color: 'var(--text)', fontFamily: 'inherit', fontSize: 12 }} /> : labelCell ? <><div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, paddingLeft: labelLevelIndent(labelLevel) * 20 }}><LabelLevelBadge level={labelLevel} /><span style={{ minWidth: 0 }}><MarkdownInline text={cellValue} prefix={`c-${tableKey}-${rowIndex}-${cellIndex}`} /></span></div>{markedForHermes && <div style={{ marginTop: 4, marginLeft: labelLevelIndent(labelLevel) * 20 + 29, color: '#2563eb', fontSize: 9, fontStyle: 'normal', fontWeight: 700 }}>Marked for Ollama</div>}{hermesSuggestion && <div style={{ marginTop: 4, marginLeft: labelLevelIndent(labelLevel) * 20 + 29, color: '#7c3aed', fontSize: 9, fontStyle: 'normal', fontWeight: 700 }}>Ollama → {hermesSuggestion.suggested_label || labelLevelCode(hermesSuggestion.user_edited_level ?? hermesSuggestion.suggested_level)} · {hermesSuggestion.confidence}</div>}</> : <MarkdownInline text={cellValue} prefix={`c-${tableKey}-${rowIndex}-${cellIndex}`} />}
              {!inlineEditing && labelCell && hermesSuggestion && onDecideLabelSuggestion && <div style={{ display: 'flex', gap: 5, marginTop: 5, marginLeft: labelLevelIndent(labelLevel) * 20 + 29 }}>
                <button type="button" disabled={['accepted', 'edited'].includes(hermesSuggestion.decision)} onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onDecideLabelSuggestion(hermesSuggestion, 'accepted'); }} style={{ padding: '3px 7px', border: '1px solid #7c3aed', borderRadius: 3, background: ['accepted', 'edited'].includes(hermesSuggestion.decision) ? 'rgba(124,58,237,.14)' : '#7c3aed', color: ['accepted', 'edited'].includes(hermesSuggestion.decision) ? '#7c3aed' : 'white', fontSize: 9, fontWeight: 700, cursor: ['accepted', 'edited'].includes(hermesSuggestion.decision) ? 'default' : 'pointer' }}>{['accepted', 'edited'].includes(hermesSuggestion.decision) ? 'Accepted' : 'Accept'}</button>
                <button type="button" onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onDecideLabelSuggestion(hermesSuggestion, 'rejected'); }} style={{ padding: '3px 7px', border: '1px solid var(--border-strong)', borderRadius: 3, background: 'var(--bg-elev)', color: 'var(--text)', fontSize: 9, fontWeight: 700, cursor: 'pointer' }}>Reject</button>
              </div>}
              {!inlineEditing && onEditCell && mismatch?.suggestedValue && <button
                type="button"
                onMouseDown={event => event.stopPropagation()}
                onClick={event => applySuggestedValue(event, rowIndex, cellIndex, mismatch.suggestedValue)}
                title={`Replace ${cellValue} with the lower-level total ${mismatch.suggestedValue}. This remains unsaved until you save the page correction.`}
                style={{ marginTop: 4, padding: '2px 5px', whiteSpace: 'nowrap', border: `1px solid ${selected ? 'var(--pos-soft)' : 'var(--neg-soft)'}`, borderRadius: 3, background: 'var(--bg-elev)', color: selected ? 'var(--pos)' : 'var(--neg)', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, lineHeight: 1.3, cursor: 'pointer' }}
              >{mismatch.priority ? 'Check first · use' : 'Use suggested'} {mismatch.suggestedValue}</button>}
            </Cell>;
          })}
        </tr>})}</tbody>
      </table>
    </div>
  </div>;
};

const HTMLTablePreview = ({ html, interactive = false, onHtmlChange, verification = null, tableNumberStart = 1, mismatchTarget = null, onSelectionSummary = null, labelSuggestions = [], markedLabelRows = [], onToggleLabelMark = null, onAskHermesForLabel = null, onDecideLabelSuggestion = null }) => {
  if (typeof window.DOMParser !== 'function') {
    return <pre style={{ margin: '0 0 14px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{html}</pre>;
  }

  const document = new window.DOMParser().parseFromString(String(html || ''), 'text/html');
  const tables = Array.from(document.body.querySelectorAll('table'));
  if (!tables.length) return <p style={{ margin: '0 0 12px' }}>{document.body.textContent || ''}</p>;

  return <>{tables.map((table, tableIndex) => {
    const rows = Array.from(table.querySelectorAll('tr')).map(row => Array.from(row.children)
      .filter(cell => ['TD', 'TH'].includes(cell.tagName))
      .map(cell => {
        const levelAttribute = cell.getAttribute('data-ocr-label-level');
        const parsedLevel = levelAttribute?.toUpperCase() === 'L' ? -1 : Number.parseInt(levelAttribute, 10);
        return {
          text: (cell.textContent || '').replace(/\s+/g, ' ').trim(),
          header: cell.tagName === 'TH',
          rowSpan: safeTableSpan(cell.getAttribute('rowspan')),
          colSpan: safeTableSpan(cell.getAttribute('colspan')),
          align: ['left', 'center', 'right'].includes(cell.style.textAlign) ? cell.style.textAlign : null,
          level: Number.isInteger(parsedLevel) && parsedLevel >= -1 && parsedLevel <= 3 ? parsedLevel : null,
        };
      }));
    const firstRowSpan = rows[0]?.some(cell => cell.rowSpan > 1);
    const headerRows = rows[0]?.some(cell => cell.header) ? 1 : firstRowSpan ? 2 : 0;
    if (interactive) {
      const editCell = onHtmlChange ? (rowIndex, cellIndex, value) => {
        const domRow = Array.from(table.querySelectorAll('tr'))[rowIndex];
        const domCell = Array.from(domRow?.children || []).filter(cell => ['TD', 'TH'].includes(cell.tagName))[cellIndex];
        if (!domCell) return 'This OCR cell could not be located. Use Edit Markdown instead.';
        domCell.textContent = value;
        onHtmlChange(document.body.innerHTML);
        return '';
      } : null;
      const setCellLevel = onHtmlChange ? (rowIndex, cellIndex, level) => {
        const domRow = Array.from(table.querySelectorAll('tr'))[rowIndex];
        const domCells = Array.from(domRow?.children || []).filter(cell => ['TD', 'TH'].includes(cell.tagName));
        const domCell = domCells[cellIndex];
        if (!domCell || cellIndex !== 0 || parseExactDecimal(domCell.textContent || '')) return 'Select a label in the first column before changing its level.';
        if (level < 0 && domCells.slice(1).some(cell => parseExactDecimal(cell.textContent || '') || /^[-–—]$/.test((cell.textContent || '').trim()))) return 'L is only for a text-only row without financial values.';
        domCell.setAttribute('data-ocr-label-level', level < 0 ? 'L' : String(level));
        domCell.removeAttribute('data-ocr-label-level-source');
        onHtmlChange(document.body.innerHTML);
        return '';
      } : null;
      const pasteCells = onHtmlChange ? edits => {
        const domRows = Array.from(table.querySelectorAll('tr'));
        const resolved = edits.map(edit => {
          const domRow = domRows[edit.row];
          const domCell = Array.from(domRow?.children || []).filter(cell => ['TD', 'TH'].includes(cell.tagName))[edit.col];
          return { ...edit, domCell };
        });
        if (resolved.some(edit => !edit.domCell)) return 'The pasted range extends outside this OCR table.';
        resolved.forEach(edit => { edit.domCell.textContent = edit.value; });
        onHtmlChange(document.body.innerHTML);
        return '';
      } : null;
      const mergeRows = onHtmlChange ? selected => {
        const domRows = Array.from(table.querySelectorAll('tr'));
        const selectedDomRows = selected.map(rowIndex => domRows[rowIndex]);
        const selectedCells = selectedDomRows.map(row => Array.from(row?.children || []).filter(cell => ['TD', 'TH'].includes(cell.tagName)));
        if (selectedCells.some(cells => !cells.length || cells.length !== selectedCells[0].length || cells.some(cell => safeTableSpan(cell.getAttribute('rowspan')) > 1 || safeTableSpan(cell.getAttribute('colspan')) > 1))) {
          return 'These rows cross a merged HTML cell. Use Edit Markdown for this merge so the table structure is not damaged.';
        }
        const merged = selectedCells[0].map((_, cellIndex) => {
          const values = selectedCells.map(cells => (cells[cellIndex].textContent || '').replace(/\s+/g, ' ').trim()).filter(value => value && !/^[-–—]+$/.test(value));
          const unique = [...new Set(values)];
          const numeric = unique.map(parseExactDecimal).filter(Boolean);
          const numericMatch = numeric.length > 1 && numeric.every(value => subtractExactDecimals(value, numeric[0]).units === '0');
          if (numeric.length > 1 && unique.length > 1 && !numericMatch) return { error: `This column contains different numbers. Use Edit Markdown so no value is lost.` };
          return { value: numericMatch || unique.length <= 1 ? (unique[0] || '') : unique.join(' ') };
        });
        const invalid = merged.find(cell => cell.error);
        if (invalid) return invalid.error;
        merged.forEach((cell, cellIndex) => { selectedCells[0][cellIndex].textContent = cell.value; });
        selectedDomRows.slice(1).forEach(row => row.remove());
        onHtmlChange(document.body.innerHTML);
        return '';
      } : null;
      return <OCRTableReview key={`html-table-review-${tableIndex}`} rows={rows} tableKey={`html-${tableIndex}`} tableNumber={tableNumberStart + tableIndex} rowNumberOffset={1} embeddedHeaders headerRows={headerRows} mismatchCells={levelMismatchCells(verification, tableNumberStart + tableIndex, 1)} mismatchTarget={mismatchTarget} labelSuggestions={labelSuggestions.filter(suggestion => suggestion.table === tableNumberStart + tableIndex)} markedLabelRows={markedLabelRows} onToggleLabelMark={onToggleLabelMark} onAskHermesForLabel={onAskHermesForLabel} onDecideLabelSuggestion={onDecideLabelSuggestion} onSelectionSummary={onSelectionSummary} onMergeRows={mergeRows} onEditCell={editCell} onPasteCells={pasteCells} onSetCellLevel={setCellLevel} />;
    }

    return <div key={`html-table-${tableIndex}`} style={{ overflowX: 'auto', margin: '0 0 16px', border: '1px solid var(--border)', borderRadius: 6 }}>
      <table style={{ width: '100%', minWidth: 560, tableLayout: 'auto', borderCollapse: 'collapse', fontSize: 12 }}>
        <tbody>{rows.map((row, rowIndex) => <tr key={`row-${rowIndex}`}>
          {row.map((cell, cellIndex) => {
            const isHeader = cell.header || rowIndex < headerRows;
            const numeric = /^[-+()\d.,%\s]+$/.test(cell.text) && /\d/.test(cell.text);
            const labelLevel = inferredLabelLevel(cell, row, cellIndex, isHeader);
            const Cell = isHeader ? 'th' : 'td';
            return <Cell
              key={`cell-${cellIndex}`}
              rowSpan={cell.rowSpan}
              colSpan={cell.colSpan}
              scope={Cell === 'th' ? 'col' : undefined}
              style={{
                padding: '7px 10px',
                paddingLeft: labelLevel !== null ? 10 + (labelLevelIndent(labelLevel) * 14) : 10,
                minWidth: cellIndex === 0 ? 220 : 105,
                textAlign: cell.align || (numeric ? 'right' : 'left'),
                verticalAlign: 'top',
                overflowWrap: 'anywhere',
                borderBottom: rowIndex < rows.length - 1 ? '1px solid var(--border)' : 'none',
                borderRight: cellIndex < row.length - 1 ? '1px solid var(--border)' : 'none',
                background: isHeader || (labelLevel !== null && labelLevel <= 0) ? 'var(--bg-sunken)' : 'transparent',
                fontWeight: labelLevel !== null && labelLevel <= 0 ? 700 : labelLevel === 1 ? 600 : isHeader ? 700 : 400,
                fontStyle: labelLevel === 3 ? 'italic' : 'normal',
                color: labelLevel === 3 ? 'var(--text-muted)' : 'var(--text)',
                fontFamily: numeric ? 'var(--font-mono)' : 'inherit',
                fontVariantNumeric: 'tabular-nums',
              }}
            >{cell.text}</Cell>;
          })}
        </tr>)}</tbody>
      </table>
    </div>;
  })}</>;
};

const MarkdownPreview = ({ markdown, tablesOnly = false, interactiveTables = false, onMarkdownChange, levelVerification = null, mismatchTarget = null, onSelectionSummary = null, labelSuggestions = [], markedLabelRows = [], onToggleLabelMark = null, onAskHermesForLabel = null, onDecideLabelSuggestion = null }) => {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const tableBlocks = [];
  let index = 0;
  let tableNumber = 0;

  const startsBlock = position => {
    const line = lines[position] || '';
    const next = lines[position + 1] || '';
    return !line.trim()
      || /^```/.test(line.trim())
      || /^<table(?:\s|>)/i.test(line.trim())
      || /^#{1,6}\s+/.test(line)
      || /^\s*([-*+]\s+|\d+\.\s+|>\s?)/.test(line)
      || /^\s*((-{3,})|(\*{3,})|(_{3,}))\s*$/.test(line)
      || (line.includes('|') && isMarkdownTableSeparator(next));
  };

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim();
      const code = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(<pre key={`code-${index}`} style={{ margin: '0 0 14px', padding: 12, overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-sunken)', fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.55 }}><code data-language={language || undefined}>{code.join('\n')}</code></pre>);
      continue;
    }

    if (/^<table(?:\s|>)/i.test(line.trim())) {
      const htmlStart = index;
      const html = [line];
      index += 1;
      while (index < lines.length && !html.some(value => /<\/table\s*>/i.test(value))) {
        html.push(lines[index]);
        index += 1;
      }
      const updateHtml = interactiveTables && onMarkdownChange ? nextHtml => {
        const nextLines = [...lines];
        nextLines.splice(htmlStart, index - htmlStart, ...String(nextHtml || '').split('\n'));
        onMarkdownChange(nextLines.join('\n'));
      } : null;
      const htmlSource = html.join('\n');
      const tableNumberStart = tableNumber + 1;
      tableNumber += (htmlSource.match(/<table(?:\s|>)/gi) || []).length;
      const block = <HTMLTablePreview key={`html-table-${htmlStart}`} html={htmlSource} interactive={interactiveTables} onHtmlChange={updateHtml} verification={levelVerification} tableNumberStart={tableNumberStart} mismatchTarget={mismatchTarget} onSelectionSummary={onSelectionSummary} labelSuggestions={labelSuggestions} markedLabelRows={markedLabelRows} onToggleLabelMark={onToggleLabelMark} onAskHermesForLabel={onAskHermesForLabel} onDecideLabelSuggestion={onDecideLabelSuggestion} />;
      blocks.push(block);
      tableBlocks.push(block);
      continue;
    }

    if (line.includes('|') && isMarkdownTableSeparator(lines[index + 1])) {
      const tableStart = index;
      tableNumber += 1;
      const currentTableNumber = tableNumber;
      const headers = splitMarkdownTableRow(line);
      const separators = splitMarkdownTableRow(lines[index + 1]);
      const alignments = separators.map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      const rows = [];
      index += 2;
      const bodyStart = index;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const cells = splitMarkdownTableRow(lines[index]);
        rows.push(headers.map((_, cellIndex) => cells[cellIndex] || ''));
        index += 1;
      }
      const mergeRows = interactiveTables && onMarkdownChange ? selected => {
        const merged = headers.map((_, cellIndex) => {
          const values = selected
            .map(rowIndex => visibleCellText(rows[rowIndex]?.[cellIndex]))
            .filter(value => value && !/^[-–—]+$/.test(value));
          const unique = [...new Set(values)];
          const numeric = unique.map(parseExactDecimal).filter(Boolean);
          const numericMatch = numeric.length > 1 && numeric.every(value => subtractExactDecimals(value, numeric[0]).units === '0');
          if (numeric.length > 1 && unique.length > 1 && !numericMatch) return { error: `Column “${headers[cellIndex] || cellIndex + 1}” contains different numbers. Merge the row in Source mode so no value is lost.` };
          if (numericMatch) return { value: unique[0] };
          return { value: unique.length <= 1 ? (unique[0] || '') : unique.join(' ') };
        });
        const invalid = merged.find(cell => cell.error);
        if (invalid) return invalid.error;
        const nextLines = [...lines];
        const first = selected[0];
        const mergedCells = merged.map((cell, cellIndex) => cellIndex === 0 ? withLabelLevel(cell.value, explicitLabelLevel(rows[first]?.[cellIndex])) : cell.value);
        nextLines[bodyStart + first] = serializeMarkdownTableRow(mergedCells);
        [...selected].sort((a, b) => b - a).slice(0, -1).forEach(rowIndex => nextLines.splice(bodyStart + rowIndex, 1));
        onMarkdownChange(nextLines.join('\n'));
        return '';
      } : null;
      const editCell = interactiveTables && onMarkdownChange ? (rowIndex, cellIndex, value) => {
        if (!rows[rowIndex] || cellIndex < 0 || cellIndex >= headers.length) return 'This OCR cell could not be located. Use Source mode instead.';
        const nextRow = [...rows[rowIndex]];
        nextRow[cellIndex] = withLabelLevel(value, explicitLabelLevel(rows[rowIndex][cellIndex]));
        const nextLines = [...lines];
        nextLines[bodyStart + rowIndex] = serializeMarkdownTableRow(nextRow);
        onMarkdownChange(nextLines.join('\n'));
        return '';
      } : null;
      const setCellLevel = interactiveTables && onMarkdownChange ? (rowIndex, cellIndex, level) => {
        if (!rows[rowIndex] || cellIndex !== 0 || !visibleCellText(rows[rowIndex][cellIndex]) || parseExactDecimal(visibleCellText(rows[rowIndex][cellIndex]))) return 'Select a label in the first column before changing its level.';
        if (level < 0 && rows[rowIndex].slice(1).some(cell => parseExactDecimal(visibleCellText(cell)) || /^[-–—]$/.test(visibleCellText(cell)))) return 'L is only for a text-only row without financial values.';
        const nextRow = [...rows[rowIndex]];
        nextRow[cellIndex] = withLabelLevel(nextRow[cellIndex], level);
        const nextLines = [...lines];
        nextLines[bodyStart + rowIndex] = serializeMarkdownTableRow(nextRow);
        onMarkdownChange(nextLines.join('\n'));
        return '';
      } : null;
      const pasteCells = interactiveTables && onMarkdownChange ? edits => {
        if (edits.some(edit => !rows[edit.row] || edit.col < 0 || edit.col >= headers.length)) return 'The pasted range extends outside this OCR table.';
        const nextRows = rows.map(row => [...row]);
        edits.forEach(edit => { nextRows[edit.row][edit.col] = withLabelLevel(edit.value, explicitLabelLevel(rows[edit.row][edit.col])); });
        const nextLines = [...lines];
        [...new Set(edits.map(edit => edit.row))].forEach(rowIndex => { nextLines[bodyStart + rowIndex] = serializeMarkdownTableRow(nextRows[rowIndex]); });
        onMarkdownChange(nextLines.join('\n'));
        return '';
      } : null;
      const block = interactiveTables ? (
        <OCRTableReview key={`table-review-${tableStart}`} headers={headers} rows={rows} alignments={alignments} tableKey={tableStart} tableNumber={currentTableNumber} rowNumberOffset={2} mismatchCells={levelMismatchCells(levelVerification, currentTableNumber, 2)} mismatchTarget={mismatchTarget} labelSuggestions={labelSuggestions.filter(suggestion => suggestion.table === currentTableNumber)} markedLabelRows={markedLabelRows} onToggleLabelMark={onToggleLabelMark} onAskHermesForLabel={onAskHermesForLabel} onDecideLabelSuggestion={onDecideLabelSuggestion} onSelectionSummary={onSelectionSummary} onMergeRows={mergeRows} onEditCell={editCell} onPasteCells={pasteCells} onSetCellLevel={setCellLevel} />
      ) : (
        <div key={`table-${tableStart}`} style={{ overflowX: 'auto', margin: '0 0 16px', border: '1px solid var(--border)', borderRadius: 6 }}>
          <table style={{ width: '100%', minWidth: Math.max(440, headers.length * 130), borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr>{headers.map((header, cellIndex) => <th key={`h-${cellIndex}`} style={{ padding: '8px 10px', textAlign: alignments[cellIndex] || 'left', verticalAlign: 'bottom', background: 'var(--bg-sunken)', borderBottom: '1px solid var(--border-strong)', borderRight: cellIndex < headers.length - 1 ? '1px solid var(--border)' : 'none', fontWeight: 700 }}><MarkdownInline text={header} prefix={`h-${index}-${cellIndex}`} /></th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => <tr key={`r-${rowIndex}`}>{row.map((cell, cellIndex) => {
                const labelLevel = inferredLabelLevel(cell, row, cellIndex, false);
                const labelCell = labelLevel !== null && cellIndex === 0;
                return <td key={`c-${cellIndex}`} style={{ padding: '7px 10px', textAlign: labelCell ? 'left' : alignments[cellIndex] || 'left', verticalAlign: 'top', borderBottom: rowIndex < rows.length - 1 ? '1px solid var(--border)' : 'none', borderRight: cellIndex < headers.length - 1 ? '1px solid var(--border)' : 'none', background: labelLevel !== null && labelLevel <= 0 ? 'var(--bg-sunken)' : 'transparent', fontWeight: labelLevel !== null && labelLevel <= 0 ? 700 : labelLevel === 1 ? 600 : 400, fontStyle: labelLevel === 3 ? 'italic' : 'normal', color: labelLevel === 3 ? 'var(--text-muted)' : 'var(--text)', fontFamily: /^[-+()\d.,%\s]+$/.test(visibleCellText(cell)) ? 'var(--font-mono)' : 'inherit', fontVariantNumeric: 'tabular-nums' }}>{labelCell ? <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, paddingLeft: labelLevelIndent(labelLevel) * 20 }}><LabelLevelBadge level={labelLevel} /><span><MarkdownInline text={visibleCellText(cell)} prefix={`c-${index}-${rowIndex}-${cellIndex}`} /></span></div> : <MarkdownInline text={visibleCellText(cell)} prefix={`c-${index}-${rowIndex}-${cellIndex}`} />}</td>;
              })}</tr>)}
            </tbody>
          </table>
        </div>
      );
      blocks.push(block);
      tableBlocks.push(block);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const Heading = `h${level}`;
      blocks.push(<Heading key={`heading-${index}`} style={{ margin: level <= 2 ? '18px 0 9px' : '14px 0 7px', fontFamily: level <= 2 ? 'var(--font-serif)' : 'inherit', fontSize: level === 1 ? 22 : level === 2 ? 18 : level === 3 ? 15 : 13, lineHeight: 1.3 }}><MarkdownInline text={heading[2]} prefix={`heading-${index}`} /></Heading>);
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push(<ul key={`ul-${index}`} style={{ margin: '0 0 12px', paddingLeft: 22 }}>{items.map((item, itemIndex) => <li key={itemIndex} style={{ marginBottom: 4 }}><MarkdownInline text={item} prefix={`ul-${index}-${itemIndex}`} /></li>)}</ul>);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(<ol key={`ol-${index}`} style={{ margin: '0 0 12px', paddingLeft: 24 }}>{items.map((item, itemIndex) => <li key={itemIndex} style={{ marginBottom: 4 }}><MarkdownInline text={item} prefix={`ol-${index}-${itemIndex}`} /></li>)}</ol>);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(<blockquote key={`quote-${index}`} style={{ margin: '0 0 12px', padding: '7px 11px', borderLeft: '3px solid var(--accent)', background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}><MarkdownInline text={quote.join(' ')} prefix={`quote-${index}`} /></blockquote>);
      continue;
    }

    if (/^\s*((-{3,})|(\*{3,})|(_{3,}))\s*$/.test(line)) {
      blocks.push(<hr key={`hr-${index}`} style={{ margin: '16px 0', border: 0, borderTop: '1px solid var(--border)' }} />);
      index += 1;
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !startsBlock(index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(<p key={`p-${index}`} style={{ margin: '0 0 12px', lineHeight: 1.65 }}><MarkdownInline text={paragraph.join(' ')} prefix={`p-${index}`} /></p>);
  }

  const visibleBlocks = tablesOnly ? tableBlocks : blocks;
  if (!visibleBlocks.length) return <div style={{ padding: 14, border: '1px dashed var(--border)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 12 }}>{tablesOnly ? 'No table detected on this page. You can approve it or continue to the next page.' : 'This page contains no OCR text.'}</div>;
  return <div style={{ fontSize: 12, color: 'var(--text)' }}>{visibleBlocks}</div>;
};

const PageOCRInbox = ({ setPage }) => {
  const focusedReviewId = new URLSearchParams(window.location.search).get('ocrReview');
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [uploading, setUploading] = React.useState(false);
  const [labelsFor, setLabelsFor] = React.useState(null); // inbox item id whose labels form is open
  // Set when opened from Financial Statements → "Add statement": the company is known,
  // the owner picks year, period and scope before dropping the PDF.
  const [target, setTarget] = React.useState(() => {
    const hint = window.__ocrTarget;
    window.__ocrTarget = null;
    return hint && hint.ticker ? { ticker: String(hint.ticker).toUpperCase(), scope: 'consolidated', ...inboxLatestQuarter() } : null;
  });
  const inputRef = React.useRef(null);

  // One poller: no overlapping requests, back-off while the backend is down, paused in a
  // hidden tab, and one toast per outage (plus one when it comes back).
  const pollerRef = React.useRef(null);
  React.useEffect(() => {
    if (focusedReviewId) return undefined;
    let alive = true;
    const poller = window.SyncPoller.create({
      intervalMs: 1800,
      maxIntervalMs: 30000,
      run: async () => {
        if (!window.HelixAPI?.live) { if (alive) setLoading(false); return; }
        try {
          const next = await window.HelixAPI.ocrInbox();
          if (alive) setItems(next);
        } finally { if (alive) setLoading(false); }
      },
      onError: e => { if (alive) window.toast?.(`Could not load OCR Inbox: ${e.message} — retrying in the background`, { type: 'error' }); },
      onRecover: () => { if (alive) window.toast?.('OCR Inbox reconnected', { type: 'success' }); },
    });
    pollerRef.current = poller;
    poller.start();
    return () => { alive = false; poller.stop(); if (pollerRef.current === poller) pollerRef.current = null; };
  }, [focusedReviewId]);
  const refresh = React.useCallback(() => (pollerRef.current ? pollerRef.current.poke() : Promise.resolve()), []);

  const uploadFiles = async (files, allowDuplicate = false) => {
    if (!files?.length) return;
    if (files.length > 20) { window.toast?.('Choose at most 20 PDFs', { type: 'error' }); return; }
    if (target && files.length > 1) { window.toast?.(`Add one PDF at a time for ${target.ticker} — each one is a single period`, { type: 'error' }); return; }
    setUploading(true);
    try {
      await window.HelixAPI.ocrInboxUpload(files, allowDuplicate, target);
      window.toast?.(target
        ? `Added ${target.ticker} ${target.period_code} ${target.fiscal_year} to the OCR Inbox`
        : `${files.length} PDF${files.length === 1 ? '' : 's'} added to the OCR Inbox`, { type: 'success' });
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
      if (action === 'reopen' && await reopenVerifiedOcrReview(item, item.review)) window.toast?.(`${item.filename}: review reopened`, { type: 'success' });
      await refresh();
    } catch (e) { window.toast?.(e.message, { type: 'error' }); }
  };

  if (focusedReviewId) {
    const leaveReview = () => {
      const url = new URL(window.location.href);
      url.searchParams.delete('ocrReview');
      window.location.assign(url.toString());
    };
    return <OCRReviewWorkspace itemId={focusedReviewId} onBack={leaveReview} setPage={setPage} />;
  }

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

      {target && (
        <div className="card" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); uploadFiles(Array.from(e.dataTransfer.files || [])); }}
          style={{ marginBottom: 16, padding: '14px 18px', borderColor: 'var(--accent)', overflow: 'visible', position: 'relative', zIndex: 2 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 160px' }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Adding a statement for</div>
              <div className="ticker" style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>{target.ticker}</div>
            </div>
            <div style={{ width: 120 }}><LxSelect label="Year" value={target.fiscal_year} options={historyFiscalYearOptions(target.fiscal_year)} onChange={v => setTarget(t => ({ ...t, fiscal_year: Number(v) }))} /></div>
            <div style={{ width: 150 }}><LxSelect label="Period" value={target.period_code} options={HISTORY_PERIOD_CODE_OPTIONS} onChange={v => setTarget(t => ({ ...t, period_code: v }))} /></div>
            <div style={{ width: 170 }}><LxSelect label="Scope" value={target.scope} options={HISTORY_SCOPE_OPTIONS} onChange={v => setTarget(t => ({ ...t, scope: v }))} /></div>
            <button className="btn btn-primary" disabled={uploading || !window.HelixAPI?.live} onClick={() => inputRef.current?.click()}>
              <Icon name="plus" size={12} /> {uploading ? 'Uploading…' : `Choose ${target.period_code} ${target.fiscal_year} PDF`}
            </button>
            <button className="btn" onClick={() => { window.__statementsTicker = target.ticker; setPage && setPage('statements'); }}>Back to {target.ticker}</button>
            <button className="btn" aria-label="Stop adding for this company" title="Stop adding for this company" onClick={() => setTarget(null)}>✕</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            Drop the PDF here or choose it. Year, period and scope are saved on it; set the unit while checking the numbers.
          </div>
        </div>
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
        ) : items.map(item => { const summary = inboxLabelSummary(item.labels); return (
          <div key={item.id} style={{ borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px,1.5fr) 150px 130px minmax(220px,auto)', gap: 16, alignItems: 'center', padding: '14px 18px' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.filename}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{item.pages} pages · {fmtInboxBytes(item.size_bytes)}</div>
              <button type="button" onClick={() => setLabelsFor(id => id === item.id ? null : item.id)} aria-expanded={labelsFor === item.id}
                style={{ marginTop: 5, padding: '2px 8px', fontSize: 11, borderRadius: 10, cursor: 'pointer', border: `1px solid ${summary ? 'var(--border)' : 'var(--neg)'}`, background: 'transparent', color: summary ? 'var(--text)' : 'var(--neg)' }}>
                {summary ? summary : '⚠ No labels — set ticker & period'}
              </button>
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
              {item.review?.status === 'verified' && !item.published_filing_id && <button className="btn" title="Make this verified review editable again" onClick={() => act(item, 'reopen')}>Reopen review</button>}
              {item.review && <a className="btn" href={(() => { const url = new URL(window.location.href); url.searchParams.set('ocrReview', item.id); return url.toString(); })()} target="_blank" rel="noopener noreferrer"><Icon name="eye" size={12} /> Open review</a>}
              {!item.published_filing_id && !['queued', 'processing'].includes(item.status) && <button className="btn" onClick={() => act(item, 'delete')}>Delete</button>}
              {item.published_filing_id && <button className="btn" onClick={() => setPage('statements')}>Open filing</button>}
              {!item.published_filing_id && <button className="btn" aria-expanded={labelsFor === item.id} onClick={() => setLabelsFor(id => id === item.id ? null : item.id)}>Labels</button>}
            </div>
          </div>
          {labelsFor === item.id && <OCRPublishPanel key={`labels-${item.id}`} item={item} reload={refresh} setPage={setPage} canPublish={false} title="Upload labels" />}
          </div>
        ); })}
      </div>
    </div>
  );
};

const OCRPublishPanel = ({ item, reload, setPage, canPublish = true, title = 'Label before publication' }) => {
  const [labels, setLabels] = React.useState(() => {
    const stored = Object.fromEntries(Object.entries(item.labels || {}).filter(([, v]) => v !== null && v !== ''));
    const merged = { company: '', ticker: '', filing_type: 'BCTC', period: '', currency: 'VND', unit: null, scope: null, fiscal_year: null, period_code: null, ...stored };
    // Old free-text units ("million") are not understood by company history: make the owner pick.
    if (!LABEL_UNIT_OPTIONS.some(o => o.value === merged.unit)) merged.unit = null;
    return merged;
  });
  const [inHistory, setInHistory] = React.useState(false);
  const [removing, setRemoving] = React.useState(false);
  const set = (key, value) => setLabels(x => ({ ...x, [key]: value }));
  const save = async () => {
    const missing = [['ticker', 'Ticker'], ['scope', 'Scope'], ['fiscal_year', 'Fiscal year'], ['period_code', 'Period'], ['unit', 'Unit']]
      .filter(([key]) => !labels[key]).map(([, name]) => name);
    if (missing.length) { window.toast?.(`Please set: ${missing.join(', ')}`, { type: 'error' }); return; }
    const payload = {
      ...labels,
      company: (labels.company || '').trim() || labels.ticker,
      period: `${labels.period_code} ${labels.fiscal_year}`,
      filing_type: (labels.filing_type || '').trim() || 'BCTC',
      currency: (labels.currency || '').trim() || 'VND',
    };
    try {
      await window.HelixAPI.ocrInboxLabels(item.id, payload);
      setInHistory(false);
      await reload();
      window.toast?.('Labels saved', { type: 'success' });
    } catch (e) {
      if (e.status === 409 && /remove this document from history first/i.test(e.message || '')) setInHistory(true);
      else window.toast?.(e.message, { type: 'error' });
    }
  };
  const removeFromHistory = async () => {
    setRemoving(true);
    try {
      const result = await window.HelixAPI.historyRemove(item.id);
      setInHistory(false);
      await reload();
      window.toast?.(`Removed from history: ${result.superseded} value${result.superseded === 1 ? '' : 's'} superseded. Save the labels again.`, { type: 'success' });
    } catch (e) { window.toast?.(e.message, { type: 'error' }); }
    finally { setRemoving(false); }
  };
  const publish = async () => { try { await window.HelixAPI.ocrInboxPublish(item.id); await reload(); window.toast?.('Verified data published', { type: 'success' }); } catch (e) { window.toast?.(e.message, { type: 'error' }); } };
  if (item.status === 'published') return <div style={{ padding: 16 }}><button className="btn btn-primary" onClick={() => setPage('statements')}>Open published filing</button></div>;
  const textField = (key, label, placeholder) => <LxTextField key={key} label={label} value={labels[key]} placeholder={placeholder} uppercase={key === 'ticker'} onChange={value => set(key, value)} />;
  return <div style={{ padding: 16, borderTop: '2px solid var(--border)' }}>
    <div style={{ fontWeight: 700, marginBottom: 4 }}>{title}</div>
    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>Which company and which report is this PDF? Company history uses these to place every number.</div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
      {textField('ticker', 'Ticker', 'e.g. MBB')}
      <LxSelect label="Scope" value={labels.scope} options={HISTORY_SCOPE_OPTIONS} onChange={value => set('scope', value)} />
      <LxSelect label="Fiscal year" value={labels.fiscal_year} options={historyFiscalYearOptions(labels.fiscal_year)} onChange={value => set('fiscal_year', Number(value))} />
      <LxSelect label="Period" value={labels.period_code} options={HISTORY_PERIOD_CODE_OPTIONS} onChange={value => set('period_code', value)} />
      {textField('company', 'Company', 'e.g. Ngân hàng TMCP Quân đội')}
      <LxSelect label="Unit printed in the PDF" value={labels.unit} options={LABEL_UNIT_OPTIONS} onChange={value => set('unit', value)} />
    </div>
    <details style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
      <summary style={{ cursor: 'pointer' }}>More</summary>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginTop: 8 }}>
        {textField('filing_type', 'Statement type', 'BCTC')}
        {textField('currency', 'Currency', 'VND')}
      </div>
    </details>
    {inHistory && <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 12, padding: '9px 12px', border: '1px solid var(--neg)', borderRadius: 6, color: 'var(--neg)', fontSize: 12 }}>
      <span style={{ flex: '1 1 220px' }}>Remove this document from history first. Its values are in the company history, so its labels cannot change.</span>
      <button className="btn" disabled={removing} onClick={removeFromHistory}>{removing ? 'Removing…' : 'Remove from history'}</button>
    </div>}
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 7, marginTop: 12 }}><button className="btn" onClick={save}>Save labels</button>{canPublish && <button className="btn btn-primary" disabled={item.status !== 'ready_to_publish'} onClick={publish}>Publish verified data</button>}</div>
  </div>;
};

window.PageOCRInbox = PageOCRInbox;
