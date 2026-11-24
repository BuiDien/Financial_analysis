// OCR spreadsheet review: one OCR table as an editable grid (select, sum, merge, copy / paste,
// label levels, total mismatches, Ollama label suggestions). State lives in use-table-selection.js.
//
// Keyboard (on a cell): arrows move · Shift+arrows extend · Enter edits · ⌘/Ctrl C X V copy, cut, paste.
// In the cell editor: Enter saves · Escape cancels. Right-click (or the row number) opens the menu.

import React from 'react';
import { cx } from '../../ui';
import { parseExactDecimal, spreadsheetColumnLabel, LABEL_LEVELS, labelLevelCode, labelLevelIndent, inferredLabelLevel, visibleCellText } from './ocr-inbox-utils.js';
import { LabelLevelBadge, MarkdownInline, indentClass } from './shared.jsx';
import { useTableSelection } from './use-table-selection.js';
import { TableToolbar, FormulaBar, TableContextMenu } from './table-review-parts.jsx';

const ACCEPTED = ['accepted', 'edited'];
const alignClass = align => (align === 'right' ? 'ocr-al-right' : align === 'center' ? 'ocr-al-center' : 'ocr-al-left');
const levelClass = level => (level === null ? null : level <= 0 ? 'ocr-l-total' : `ocr-l-${level}`);

const SuggestionNote = ({ ind, children, className }) => <div className={cx('ocr-cell-note', ind, className)}>{children}</div>;

const OCRTableReview = ({ headers = [], rows, alignments = [], tableKey, tableNumber = 1, rowNumberOffset = 1, onMergeRows, onEditCell, onPasteCells, onSetCellLevel, onSelectionSummary, mismatchCells = {}, mismatchTarget = null, labelSuggestions = [], markedLabelRows = [], onToggleLabelMark = null, onAskHermesForLabel = null, onDecideLabelSuggestion = null, embeddedHeaders = false, headerRows = 0 }) => {
  const s = useTableSelection({ rows, tableNumber, rowNumberOffset, headerRows, embeddedHeaders, mismatchTarget, markedLabelRows, onMergeRows, onEditCell, onPasteCells, onSetCellLevel, onSelectionSummary });
  const maxColumns = Math.max(headers.length, ...rows.map(row => row.reduce((count, cell) => count + (typeof cell === 'object' ? cell.colSpan : 1), 0)));

  const renderCell = (row, rowIndex, cell, cellIndex, { reviewableRow, rowSuggestion, markedForHermes }) => {
    const cellValue = visibleCellText(cell);
    const numeric = reviewableRow && Boolean(parseExactDecimal(cellValue));
    const isHeader = embeddedHeaders && (cell.header || rowIndex < headerRows);
    const Cell = isHeader ? 'th' : 'td';
    const selected = s.isCellSelected(rowIndex, cellIndex);
    const inlineEditing = s.editingCell?.row === rowIndex && s.editingCell?.col === cellIndex;
    const labelLevel = inferredLabelLevel(cell, row, cellIndex, isHeader);
    const labelCell = labelLevel !== null && cellIndex === 0 && !isHeader;
    const mismatch = mismatchCells[`${rowIndex}:${cellIndex}`];
    const mismatchMessage = mismatch?.messages.join('\n');
    const hermesSuggestion = labelCell ? rowSuggestion : null;
    const hermesMessage = hermesSuggestion ? (hermesSuggestion.suggested_label
      ? `Ollama suggests “${hermesSuggestion.suggested_label}” (${hermesSuggestion.confidence} confidence).`
      : `Ollama suggests ${labelLevelCode(hermesSuggestion.user_edited_level ?? hermesSuggestion.suggested_level)} (${hermesSuggestion.confidence} confidence).`) : '';
    const accessibleLabel = mismatchMessage || hermesMessage || (markedForHermes && labelCell ? `Marked for Ollama review: ${cellValue}` : null) || (labelCell ? `${LABEL_LEVELS[labelLevel]}: ${cellValue}` : undefined);
    const align = labelCell ? 'left' : (typeof cell === 'object' && cell.align) || alignments[cellIndex] || (numeric ? 'right' : 'left');
    const ind = labelCell ? indentClass(labelLevelIndent(labelLevel)) : null;
    const accepted = hermesSuggestion && ACCEPTED.includes(hermesSuggestion.decision);
    const focusable = selected || ((!s.selection && !s.extraSelectedCells.size) && s.initialPoint?.row === rowIndex && s.initialPoint?.col === cellIndex);
    return <Cell key={`c-${cellIndex}`} role="gridcell" data-ocr-table={tableNumber} data-ocr-row={rowIndex + rowNumberOffset} data-ocr-column={cellIndex + 1}
      tabIndex={focusable ? 0 : -1} aria-selected={Boolean(selected)} aria-invalid={mismatch ? 'true' : undefined} aria-label={accessibleLabel}
      title={mismatchMessage || hermesMessage || (markedForHermes && labelCell ? 'Marked for Ollama review' : null) || (labelLevel !== null ? `${labelLevelCode(labelLevel)} · ${LABEL_LEVELS[labelLevel]}` : undefined)}
      rowSpan={typeof cell === 'object' ? cell.rowSpan : undefined} colSpan={typeof cell === 'object' ? cell.colSpan : undefined}
      className={cx('ocr-cell', alignClass(align), isHeader && 'is-head', levelClass(labelLevel), numeric && 'is-num', inlineEditing && 'is-editing',
        markedForHermes && labelCell && 'is-marked', hermesSuggestion && 'is-suggested',
        mismatch && 'is-mismatch', mismatch && (mismatch.priority ? 'mm-3' : mismatch.parent ? 'mm-2' : 'mm-1'), selected && 'is-selected')}
      onMouseDown={event => { if (inlineEditing || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); const additive = event.metaKey || event.ctrlKey; if (additive) { s.toggleAdditiveCell(rowIndex, cellIndex); s.setDragging(false); } else { s.selectCell(rowIndex, cellIndex, !event.shiftKey); s.setDragging(true); } }}
      onMouseEnter={event => { if (s.dragging && s.selectionAnchor && (event.buttons & 1) === 1) s.setSelection({ start: s.selectionAnchor, end: { row: rowIndex, col: cellIndex } }); else if (s.dragging && (event.buttons & 1) === 0) s.setDragging(false); }}
      onContextMenu={event => { if (event.ctrlKey) { event.preventDefault(); return; } if (!selected) s.selectCell(rowIndex, cellIndex, true); s.openContextMenu(event, { row: rowIndex, col: cellIndex }); }}
      onDoubleClick={() => s.beginEdit(rowIndex, cellIndex)}
      onKeyDown={event => { const shortcut = event.metaKey || event.ctrlKey; const key = event.key.toLowerCase(); if (shortcut && ['c', 'x', 'v'].includes(key)) { event.preventDefault(); if (key === 'c') s.copyCells(false); if (key === 'x') s.copyCells(true); if (key === 'v') s.pasteCells(); } else if (event.key === 'Enter') s.beginEdit(rowIndex, cellIndex); else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { const r = event.currentTarget.getBoundingClientRect(); s.openContextMenu({ preventDefault: () => event.preventDefault(), clientX: r.left + 12, clientY: r.bottom }, { row: rowIndex, col: cellIndex }); } else s.moveSelection(event, rowIndex, cellIndex); }}>
      {inlineEditing
        ? <input autoFocus className="ocr-cell-input" value={s.editValue} aria-label={`Edit cell ${s.activeName}`}
          onMouseDown={event => event.stopPropagation()} onChange={event => s.setEditValue(event.target.value)} onBlur={s.saveEdit}
          onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { s.refocusRef.current = true; event.currentTarget.blur(); } if (event.key === 'Escape') { s.cancelEditRef.current = true; s.refocusRef.current = true; event.currentTarget.blur(); } }} />
        : labelCell ? <>
          <div className={cx('ocr-label', ind)}><LabelLevelBadge level={labelLevel} /><span className="ocr-label-text"><MarkdownInline text={cellValue} prefix={`c-${tableKey}-${rowIndex}-${cellIndex}`} /></span></div>
          {markedForHermes && <SuggestionNote ind={ind} className="is-marked">Marked for Ollama</SuggestionNote>}
          {hermesSuggestion && <SuggestionNote ind={ind} className="is-ai">Ollama → {hermesSuggestion.suggested_label || labelLevelCode(hermesSuggestion.user_edited_level ?? hermesSuggestion.suggested_level)} · {hermesSuggestion.confidence}</SuggestionNote>}
        </> : <MarkdownInline text={cellValue} prefix={`c-${tableKey}-${rowIndex}-${cellIndex}`} />}
      {!inlineEditing && labelCell && hermesSuggestion && onDecideLabelSuggestion && <div className={cx('ocr-cell-note ocr-ai-actions', ind)}>
        <button type="button" className={cx('ocr-ai-btn is-accept', accepted && 'is-done')} disabled={accepted} onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onDecideLabelSuggestion(hermesSuggestion, 'accepted'); }}>{accepted ? 'Accepted' : 'Accept'}</button>
        <button type="button" className="ocr-ai-btn" onMouseDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onDecideLabelSuggestion(hermesSuggestion, 'rejected'); }}>Reject</button>
      </div>}
      {!inlineEditing && onEditCell && mismatch?.suggestedValue && <button type="button" className={cx('ocr-use-suggested', selected && 'is-selected')}
        onMouseDown={event => event.stopPropagation()}
        onClick={event => s.applySuggestedValue(event, rowIndex, cellIndex, mismatch.suggestedValue)}
        title={`Replace ${cellValue} with the lower-level total ${mismatch.suggestedValue}. This remains unsaved until you save the page correction.`}
      >{mismatch.priority ? 'Check first · use' : 'Use suggested'} {mismatch.suggestedValue}</button>}
    </Cell>;
  };

  return <div className="ocr-tbl">
    <TableToolbar s={s} onMergeRows={onMergeRows} onToggleLabelMark={onToggleLabelMark} />
    {s.tableError && <div role="alert" className="ocr-tbl-msg is-error">{s.tableError}</div>}
    {s.tableNotice && <div role="status" className="ocr-tbl-msg is-notice">{s.tableNotice}</div>}
    <FormulaBar s={s} onSetCellLevel={onSetCellLevel} onEditCell={onEditCell} />
    {s.contextMenu && <TableContextMenu s={s} onAskHermesForLabel={onAskHermesForLabel} onToggleLabelMark={onToggleLabelMark} onMergeRows={onMergeRows} onPasteCells={onPasteCells} onEditCell={onEditCell} onSetCellLevel={onSetCellLevel} />}
    <div className="ocr-scroll-x">
      <table role="grid" aria-label="OCR spreadsheet review" aria-multiselectable="true" className={cx('ocr-grid', s.dragging && 'is-dragging')}
        onMouseUp={() => s.setDragging(false)} onMouseLeave={() => s.setDragging(false)} style={{ minWidth: Math.max(560, maxColumns * 120) }}>
        <thead><tr>
          <th scope="col" className="ocr-rownum-head" aria-label="Row numbers" />
          {Array.from({ length: maxColumns }, (_, cellIndex) => <th key={`letter-${cellIndex}`} scope="col" className="ocr-col-letter">{spreadsheetColumnLabel(cellIndex)}</th>)}
        </tr>
        {!embeddedHeaders && <tr className="ocr-head-row">
          <th scope="col" className="ocr-rownum-head">1</th>
          {headers.map((header, cellIndex) => <th key={`h-${cellIndex}`} scope="col" className={cx('ocr-col-head', alignClass(alignments[cellIndex]))}><MarkdownInline text={header} prefix={`h-${tableKey}-${cellIndex}`} /></th>)}
        </tr>}
        </thead>
        <tbody>{rows.map((row, rowIndex) => {
          const reviewableRow = !embeddedHeaders || rowIndex >= headerRows;
          const rowSuggestion = labelSuggestions.find(suggestion => (
            suggestion.row === rowIndex + rowNumberOffset
            && !['rejected', 'stale'].includes(suggestion.decision)
            && suggestion.applied_revision === null
          ));
          const markedForHermes = markedLabelRows.some(target => target.table === tableNumber && target.row === rowIndex + rowNumberOffset);
          const rowSelected = s.selectedRows.includes(rowIndex);
          const rowNumber = embeddedHeaders ? rowIndex + 1 : rowIndex + 2;
          return <tr key={`r-${rowIndex}`} className={rowSelected ? 'is-row-selected' : undefined}>
            <th scope="row" className="ocr-rownum" onContextMenu={event => { if (!rowSelected) s.selectRow(rowIndex, true); s.openContextMenu(event); }}>
              {reviewableRow && onMergeRows
                ? <button type="button" className="ocr-rownum-btn" onClick={() => s.selectRow(rowIndex)} aria-label={`Select OCR row ${rowIndex + 1}`}>{rowNumber}</button>
                : rowNumber}
            </th>
            {row.map((cell, cellIndex) => renderCell(row, rowIndex, cell, cellIndex, { reviewableRow, rowSuggestion, markedForHermes }))}
          </tr>;
        })}</tbody>
      </table>
    </div>
  </div>;
};

export { OCRTableReview };
