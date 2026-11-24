// OCR spreadsheet review — selection, clipboard, inline-edit and context-menu state for one table.
// Pure state + handlers (no markup); table-review.jsx renders what this returns.

import React from 'react';
import {
  parseExactDecimal, sumExactDecimals, formatExactDecimal, spreadsheetColumnLabel,
  LABEL_LEVELS, labelLevelCode, visibleCellText, inferredLabelLevel,
} from './ocr-inbox-utils.js';
import { parseClipboardTable } from './ocr-table-edit.js';

// Cells are already in the DOM (only their tabIndex changes), so focus moves synchronously and a
// fast second key press lands on the new cell.
const focusGridCell = (tableNumber, rowNumber, columnNumber) => {
  window.document.querySelector(`[data-ocr-table="${tableNumber}"][data-ocr-row="${rowNumber}"][data-ocr-column="${columnNumber}"]`)
    ?.focus({ preventScroll: false });
};

const useTableSelection = ({
  rows, tableNumber, rowNumberOffset, headerRows, embeddedHeaders, mismatchTarget, markedLabelRows,
  onMergeRows, onEditCell, onPasteCells, onSetCellLevel, onSelectionSummary,
}) => {
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
  const refocusRef = React.useRef(false); // set by Enter/Escape in the cell editor: focus returns to the cell
  const [clipboard, setClipboard] = React.useState(null);
  const [contextMenu, setContextMenu] = React.useState(null);

  const cellText = visibleCellText;
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
  // Arrow keys move the active cell (Shift extends the range); keyboard focus follows it so the
  // next key press continues from the new cell.
  const moveSelection = (event, row, col) => {
    const movement = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
    if (!movement) return;
    event.preventDefault();
    const nextRow = Math.max(0, Math.min(rows.length - 1, row + movement[0]));
    const nextCol = Math.max(0, Math.min((rows[nextRow]?.length || 1) - 1, col + movement[1]));
    selectCell(nextRow, nextCol, !event.shiftKey);
    focusGridCell(tableNumber, nextRow + rowNumberOffset, nextCol + 1);
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
    const refocus = refocusRef.current;
    refocusRef.current = false;
    if (refocus) focusGridCell(tableNumber, editingCell.row + rowNumberOffset, editingCell.col + 1);
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
  const activeCell = selection?.end || additiveActiveCell;
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
    const matrix = parseClipboardTable(text);
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

  // Facts about a cell (the active one, or the one the context menu opened on).
  const describe = cell => {
    const isHeader = cell ? embeddedHeaders && (rows[cell.row]?.[cell.col]?.header || cell.row < headerRows) : false;
    const labelLevel = cell ? inferredLabelLevel(rows[cell.row]?.[cell.col], rows[cell.row] || [], cell.col, isHeader) : null;
    const labelTarget = cell && cell.col === 0 && !isHeader && visibleCellText(rows[cell.row]?.[cell.col])
      ? { table: tableNumber, row: cell.row + rowNumberOffset }
      : null;
    const labelMarked = labelTarget && markedLabelRows.some(target => target.table === labelTarget.table && target.row === labelTarget.row);
    return { isHeader, labelLevel, labelTarget, labelMarked };
  };
  const activeName = activeCell ? `${spreadsheetColumnLabel(activeCell.col)}${activeCell.row + 1}` : '—';
  const activeValue = activeCell ? cellText(rows[activeCell.row]?.[activeCell.col]) || '' : '';
  const active = describe(activeCell);
  const contextCell = contextMenu ? contextMenu.cell : activeCell;
  const context = describe(contextCell);

  return {
    initialPoint, selectedRows, selection, selectionAnchor, setSelection, extraSelectedCells, dragging, setDragging,
    tableError, tableNotice, editingCell, editValue, setEditValue, cancelEditRef, refocusRef, contextMenu, setContextMenu,
    isCellSelected, selectedAreAdjacent, continuousSelection, selectRow, selectCell, toggleAdditiveCell, moveSelection,
    beginEdit, saveEdit, clearCellSelection, copyCells, pasteCells, openContextMenu, setActiveLabelLevel, merge,
    applySuggestedValue, activeCell, activeName, activeValue, active, contextCell, context,
  };
};

export { useTableSelection };
