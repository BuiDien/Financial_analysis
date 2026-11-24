// OCR spreadsheet review — the table's toolbar, formula bar and right-click menu.
// `s` is the state object from use-table-selection.js.

import React from 'react';
import { Button } from '../../ui';
import { LABEL_LEVEL_VALUES, LABEL_LEVELS, LABEL_LEVEL_SHORT, labelLevelCode } from './ocr-inbox-utils.js';
import { LabelLevelBadge } from './shared.jsx';

const TableToolbar = ({ s, onMergeRows, onToggleLabelMark }) => (
  <div className="ocr-tbl-toolbar">
    {onMergeRows && <Button size="sm" disabled={!s.selectedAreAdjacent} onClick={s.merge}>Merge rows</Button>}
    <Button size="sm" disabled={!s.selection && !s.extraSelectedCells.size && !s.selectedRows.length} onClick={s.clearCellSelection}>Clear selection</Button>
    {onToggleLabelMark && <Button size="sm" disabled={!s.active.labelTarget} onClick={() => s.active.labelTarget && onToggleLabelMark(s.active.labelTarget)}>{s.active.labelMarked ? 'Unmark label' : 'Mark label for Ollama'}</Button>}
    <span className="ocr-tbl-hint">Drag or Shift-click for a range. Command-click on Mac or Ctrl-click elsewhere toggles individual cells. Double-click edits a cell.</span>
    <span className="ocr-tbl-legend" aria-label="Label hierarchy: L text-only label, level 0 total, level 1 group, level 2 item, level 3 detail">
      <strong>Hierarchy</strong>
      {LABEL_LEVEL_VALUES.map(level => <span key={level} className={level === 3 ? 'is-detail' : undefined}><LabelLevelBadge level={level} />{LABEL_LEVEL_SHORT[level]}</span>)}
    </span>
  </div>
);

const FormulaBar = ({ s, onSetCellLevel, onEditCell }) => (
  <div className="ocr-tbl-formula">
    <div className="num ocr-tbl-name" aria-label="Active cell">{s.activeName}</div>
    <div className="ocr-tbl-value" title={s.activeValue}>{s.activeValue || 'Select a cell'}</div>
    <div className="ocr-tbl-formula-tools">
      {s.active.labelLevel !== null && onSetCellLevel && <label className="ocr-inline-field">Label level
        <select className="ocr-select" value={s.active.labelLevel} onChange={event => s.setActiveLabelLevel(Number(event.target.value))}>
          {LABEL_LEVEL_VALUES.map(level => <option key={level} value={level}>{labelLevelCode(level)} · {LABEL_LEVELS[level]}</option>)}
        </select>
      </label>}
      {s.activeCell && onEditCell && <button type="button" className="card-action" onClick={() => s.beginEdit(s.activeCell.row, s.activeCell.col)}>Edit cell</button>}
    </div>
  </div>
);

// Right-click menu. Focus moves into it on open (so Escape closes it) and back to the grid on close.
const TableContextMenu = ({ s, onAskHermesForLabel, onToggleLabelMark, onMergeRows, onPasteCells, onEditCell, onSetCellLevel }) => {
  const menuRef = React.useRef(null);
  const openerRef = React.useRef(null);
  React.useEffect(() => {
    openerRef.current = document.activeElement;
    (menuRef.current?.querySelector('[role=menuitem]:not([disabled])') || menuRef.current)?.focus({ preventScroll: true });
    // Only when focus was dropped with the menu (an opened cell editor keeps its own focus).
    return () => {
      const el = openerRef.current;
      const lost = !document.activeElement || document.activeElement === document.body;
      if (lost && el && el.isConnected) el.focus?.({ preventScroll: true });
    };
  }, []);
  const close = () => s.setContextMenu(null);
  const { contextCell, context, activeCell } = s;
  const level = context.labelLevel;
  const run = fn => () => { fn(); close(); };
  const onKeyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll('[role=menuitem]:not([disabled])') || []);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  };
  return <>
    <div aria-hidden="true" className="ocr-menu-scrim" onMouseDown={close} onContextMenu={event => { event.preventDefault(); close(); }} />
    <div ref={menuRef} tabIndex={-1} role="menu" aria-label="Spreadsheet actions" className="ocr-menu" onKeyDown={onKeyDown}
      style={{ left: s.contextMenu.x, top: s.contextMenu.y }}>
      {onAskHermesForLabel && <button type="button" role="menuitem" className="ocr-menu-item is-ai" disabled={!context.labelTarget} onClick={run(() => { if (context.labelTarget) onAskHermesForLabel(context.labelTarget); })}>Ask Ollama now</button>}
      {onToggleLabelMark && <button type="button" role="menuitem" className="ocr-menu-item is-strong" disabled={!context.labelTarget} onClick={run(() => { if (context.labelTarget) onToggleLabelMark(context.labelTarget); })}>{context.labelMarked ? 'Unmark Ollama label' : 'Mark label for Ollama'}</button>}
      {onMergeRows && <button type="button" role="menuitem" className="ocr-menu-item" disabled={!s.selectedAreAdjacent} onClick={run(s.merge)}>Merge selected rows</button>}
      <button type="button" role="menuitem" className="ocr-menu-item" disabled={!s.continuousSelection} onClick={run(() => s.copyCells(false))}>Copy <kbd>⌘C</kbd></button>
      <button type="button" role="menuitem" className="ocr-menu-item" disabled={!s.continuousSelection} onClick={run(() => s.copyCells(true))}>Cut / move <kbd>⌘X</kbd></button>
      <button type="button" role="menuitem" className="ocr-menu-item" disabled={!activeCell || !onPasteCells} onClick={run(() => s.pasteCells())}>Paste <kbd>⌘V</kbd></button>
      <button type="button" role="menuitem" className="ocr-menu-item" disabled={!activeCell || !onEditCell} onClick={run(() => s.beginEdit(activeCell.row, activeCell.col))}>Edit cell</button>
      <button type="button" role="menuitem" className="ocr-menu-item" disabled={level === null || !onSetCellLevel || level === -1} onClick={run(() => s.setActiveLabelLevel(level - 1, contextCell))}>Promote to {labelLevelCode(Math.max(-1, (level ?? 0) - 1))}</button>
      <button type="button" role="menuitem" className="ocr-menu-item" disabled={level === null || !onSetCellLevel || level === 3} onClick={run(() => s.setActiveLabelLevel(level + 1, contextCell))}>Demote to {labelLevelCode(Math.min(3, (level ?? 2) + 1))}</button>
    </div>
  </>;
};

export { TableToolbar, FormulaBar, TableContextMenu };
