// OCR pages sometimes contain raw <table> HTML. Interactive: each table becomes an OCRTableReview
// that edits the HTML in place; otherwise a read-only table.

import React from 'react';
import { cx } from '../../ui';
import { parseExactDecimal, subtractExactDecimals, safeTableSpan, labelLevelIndent, levelMismatchCells, inferredLabelLevel } from './ocr-inbox-utils.js';
import { indentClass } from './shared.jsx';
import { OCRTableReview } from './table-review.jsx';

const cellsOf = row => Array.from(row?.children || []).filter(cell => ['TD', 'TH'].includes(cell.tagName));

const HTMLTablePreview = ({ html, interactive = false, onHtmlChange, verification = null, tableNumberStart = 1, mismatchTarget = null, onSelectionSummary = null, labelSuggestions = [], markedLabelRows = [], onToggleLabelMark = null, onAskHermesForLabel = null, onDecideLabelSuggestion = null }) => {
  if (typeof window.DOMParser !== 'function') {
    return <pre className="ocr-pre">{html}</pre>;
  }

  const document = new window.DOMParser().parseFromString(String(html || ''), 'text/html');
  const tables = Array.from(document.body.querySelectorAll('table'));
  if (!tables.length) return <p className="ocr-md-p">{document.body.textContent || ''}</p>;

  return <>{tables.map((table, tableIndex) => {
    const rows = Array.from(table.querySelectorAll('tr')).map(row => cellsOf(row)
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
        const domCell = cellsOf(Array.from(table.querySelectorAll('tr'))[rowIndex])[cellIndex];
        if (!domCell) return 'This OCR cell could not be located. Use Edit Markdown instead.';
        domCell.textContent = value;
        onHtmlChange(document.body.innerHTML);
        return '';
      } : null;
      const setCellLevel = onHtmlChange ? (rowIndex, cellIndex, level) => {
        const domCells = cellsOf(Array.from(table.querySelectorAll('tr'))[rowIndex]);
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
        const resolved = edits.map(edit => ({ ...edit, domCell: cellsOf(domRows[edit.row])[edit.col] }));
        if (resolved.some(edit => !edit.domCell)) return 'The pasted range extends outside this OCR table.';
        resolved.forEach(edit => { edit.domCell.textContent = edit.value; });
        onHtmlChange(document.body.innerHTML);
        return '';
      } : null;
      const mergeRows = onHtmlChange ? selected => {
        const domRows = Array.from(table.querySelectorAll('tr'));
        const selectedDomRows = selected.map(rowIndex => domRows[rowIndex]);
        const selectedCells = selectedDomRows.map(cellsOf);
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
      const number = tableNumberStart + tableIndex;
      return <OCRTableReview key={`html-table-review-${tableIndex}`} rows={rows} tableKey={`html-${tableIndex}`} tableNumber={number} rowNumberOffset={1} embeddedHeaders headerRows={headerRows} mismatchCells={levelMismatchCells(verification, number, 1)} mismatchTarget={mismatchTarget} labelSuggestions={labelSuggestions.filter(suggestion => suggestion.table === number)} markedLabelRows={markedLabelRows} onToggleLabelMark={onToggleLabelMark} onAskHermesForLabel={onAskHermesForLabel} onDecideLabelSuggestion={onDecideLabelSuggestion} onSelectionSummary={onSelectionSummary} onMergeRows={mergeRows} onEditCell={editCell} onPasteCells={pasteCells} onSetCellLevel={setCellLevel} />;
    }

    return <div key={`html-table-${tableIndex}`} className="ocr-static-wrap">
      <table className="ocr-static ocr-static-html">
        <tbody>{rows.map((row, rowIndex) => <tr key={`row-${rowIndex}`}>
          {row.map((cell, cellIndex) => {
            const isHeader = cell.header || rowIndex < headerRows;
            const numeric = /^[-+()\d.,%\s]+$/.test(cell.text) && /\d/.test(cell.text);
            const labelLevel = inferredLabelLevel(cell, row, cellIndex, isHeader);
            const Cell = isHeader ? 'th' : 'td';
            return <Cell key={`cell-${cellIndex}`} rowSpan={cell.rowSpan} colSpan={cell.colSpan} scope={Cell === 'th' ? 'col' : undefined}
              className={cx('ocr-static-cell', cellIndex === 0 && 'is-first', cell.align ? `ocr-al-${cell.align}` : numeric ? 'ocr-al-right' : 'ocr-al-left',
                isHeader && 'is-head', labelLevel !== null && (labelLevel <= 0 ? 'ocr-l-total' : `ocr-l-${labelLevel}`), numeric && 'is-num',
                labelLevel !== null && indentClass(labelLevelIndent(labelLevel)))}
            >{cell.text}</Cell>;
          })}
        </tr>)}</tbody>
      </table>
    </div>;
  })}</>;
};

export { HTMLTablePreview };
