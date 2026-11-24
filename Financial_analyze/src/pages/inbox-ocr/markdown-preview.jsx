// Renders one OCR page's Markdown: headings, lists, quotes, code, Markdown tables and raw HTML
// tables. With interactiveTables every table becomes an editable OCRTableReview whose edits are
// written back into the Markdown (onMarkdownChange).

import React from 'react';
import { cx } from '../../ui';
import { splitMarkdownTableRow, isMarkdownTableSeparator, serializeMarkdownTableRow, parseExactDecimal, subtractExactDecimals, labelLevelIndent, explicitLabelLevel, visibleCellText, withLabelLevel, levelMismatchCells, inferredLabelLevel } from './ocr-inbox-utils.js';
import { LabelLevelBadge, MarkdownInline, indentClass } from './shared.jsx';
import { OCRTableReview } from './table-review.jsx';
import { findHtmlTableEnd, replaceLineRange } from './ocr-table-edit.js';
import { HTMLTablePreview } from './html-table-preview.jsx';

// Editing callbacks for one Markdown table (rows start at line `bodyStart`). Each returns '' or an error.
const markdownTableEditors = ({ lines, headers, rows, bodyStart, onMarkdownChange }) => {
  const write = nextLines => { onMarkdownChange(nextLines.join('\n')); return ''; };
  const mergeRows = selected => {
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
    return write(nextLines);
  };
  const editCell = (rowIndex, cellIndex, value) => {
    if (!rows[rowIndex] || cellIndex < 0 || cellIndex >= headers.length) return 'This OCR cell could not be located. Use Source mode instead.';
    const nextRow = [...rows[rowIndex]];
    nextRow[cellIndex] = withLabelLevel(value, explicitLabelLevel(rows[rowIndex][cellIndex]));
    const nextLines = [...lines];
    nextLines[bodyStart + rowIndex] = serializeMarkdownTableRow(nextRow);
    return write(nextLines);
  };
  const setCellLevel = (rowIndex, cellIndex, level) => {
    if (!rows[rowIndex] || cellIndex !== 0 || !visibleCellText(rows[rowIndex][cellIndex]) || parseExactDecimal(visibleCellText(rows[rowIndex][cellIndex]))) return 'Select a label in the first column before changing its level.';
    if (level < 0 && rows[rowIndex].slice(1).some(cell => parseExactDecimal(visibleCellText(cell)) || /^[-–—]$/.test(visibleCellText(cell)))) return 'L is only for a text-only row without financial values.';
    const nextRow = [...rows[rowIndex]];
    nextRow[cellIndex] = withLabelLevel(nextRow[cellIndex], level);
    const nextLines = [...lines];
    nextLines[bodyStart + rowIndex] = serializeMarkdownTableRow(nextRow);
    return write(nextLines);
  };
  const pasteCells = edits => {
    if (edits.some(edit => !rows[edit.row] || edit.col < 0 || edit.col >= headers.length)) return 'The pasted range extends outside this OCR table.';
    const nextRows = rows.map(row => [...row]);
    edits.forEach(edit => { nextRows[edit.row][edit.col] = withLabelLevel(edit.value, explicitLabelLevel(rows[edit.row][edit.col])); });
    const nextLines = [...lines];
    [...new Set(edits.map(edit => edit.row))].forEach(rowIndex => { nextLines[bodyStart + rowIndex] = serializeMarkdownTableRow(nextRows[rowIndex]); });
    return write(nextLines);
  };
  return { mergeRows, editCell, setCellLevel, pasteCells };
};

const StaticMarkdownTable = ({ headers, rows, alignments, index }) => (
  <div className="ocr-static-wrap">
    <table className="ocr-static" style={{ minWidth: Math.max(440, headers.length * 130) }}>
      <thead>
        <tr>{headers.map((header, cellIndex) => <th key={`h-${cellIndex}`} className={cx('ocr-static-cell is-col-head', `ocr-al-${alignments[cellIndex] || 'left'}`)}><MarkdownInline text={header} prefix={`h-${index}-${cellIndex}`} /></th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => <tr key={`r-${rowIndex}`}>{row.map((cell, cellIndex) => {
          const labelLevel = inferredLabelLevel(cell, row, cellIndex, false);
          const labelCell = labelLevel !== null && cellIndex === 0;
          const text = visibleCellText(cell);
          return <td key={`c-${cellIndex}`} className={cx('ocr-static-cell', labelCell ? 'ocr-al-left' : `ocr-al-${alignments[cellIndex] || 'left'}`,
            labelLevel !== null && (labelLevel <= 0 ? 'ocr-l-total' : `ocr-l-${labelLevel}`), /^[-+()\d.,%\s]+$/.test(text) && 'is-num')}>
            {labelCell
              ? <div className={cx('ocr-label', indentClass(labelLevelIndent(labelLevel)))}><LabelLevelBadge level={labelLevel} /><span><MarkdownInline text={text} prefix={`c-${index}-${rowIndex}-${cellIndex}`} /></span></div>
              : <MarkdownInline text={text} prefix={`c-${index}-${rowIndex}-${cellIndex}`} />}
          </td>;
        })}</tr>)}
      </tbody>
    </table>
  </div>
);

const MarkdownPreview = ({ markdown, tablesOnly = false, interactiveTables = false, onMarkdownChange, levelVerification = null, mismatchTarget = null, onSelectionSummary = null, labelSuggestions = [], markedLabelRows = [], onToggleLabelMark = null, onAskHermesForLabel = null, onDecideLabelSuggestion = null }) => {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const tableBlocks = [];
  let index = 0;
  let tableNumber = 0;
  const reviewProps = { mismatchTarget, onSelectionSummary, markedLabelRows, onToggleLabelMark, onAskHermesForLabel, onDecideLabelSuggestion };

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
  const collect = pattern => {
    const items = [];
    while (index < lines.length && pattern.test(lines[index])) {
      items.push(lines[index].replace(pattern, ''));
      index += 1;
    }
    return items;
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
      blocks.push(<pre key={`code-${index}`} className="ocr-md-code"><code data-language={language || undefined}>{code.join('\n')}</code></pre>);
      continue;
    }

    if (/^<table(?:\s|>)/i.test(line.trim())) {
      const htmlStart = index;
      const htmlEnd = findHtmlTableEnd(lines, htmlStart);
      const html = lines.slice(htmlStart, htmlEnd);
      index = htmlEnd;
      const updateHtml = interactiveTables && onMarkdownChange
        ? nextHtml => onMarkdownChange(replaceLineRange(lines, htmlStart, htmlEnd, nextHtml))
        : null;
      const htmlSource = html.join('\n');
      const tableNumberStart = tableNumber + 1;
      tableNumber += (htmlSource.match(/<table(?:\s|>)/gi) || []).length;
      const block = <HTMLTablePreview key={`html-table-${htmlStart}`} html={htmlSource} interactive={interactiveTables} onHtmlChange={updateHtml} verification={levelVerification} tableNumberStart={tableNumberStart} labelSuggestions={labelSuggestions} {...reviewProps} />;
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
      const editors = interactiveTables && onMarkdownChange ? markdownTableEditors({ lines, headers, rows, bodyStart, onMarkdownChange }) : {};
      const block = interactiveTables
        ? <OCRTableReview key={`table-review-${tableStart}`} headers={headers} rows={rows} alignments={alignments} tableKey={tableStart} tableNumber={currentTableNumber} rowNumberOffset={2} mismatchCells={levelMismatchCells(levelVerification, currentTableNumber, 2)} labelSuggestions={labelSuggestions.filter(suggestion => suggestion.table === currentTableNumber)} {...reviewProps}
          onMergeRows={editors.mergeRows || null} onEditCell={editors.editCell || null} onPasteCells={editors.pasteCells || null} onSetCellLevel={editors.setCellLevel || null} />
        : <StaticMarkdownTable key={`table-${tableStart}`} headers={headers} rows={rows} alignments={alignments} index={index} />;
      blocks.push(block);
      tableBlocks.push(block);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const Heading = `h${heading[1].length}`;
      blocks.push(<Heading key={`heading-${index}`} className="ocr-md-h"><MarkdownInline text={heading[2]} prefix={`heading-${index}`} /></Heading>);
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = collect(/^\s*[-*+]\s+/);
      blocks.push(<ul key={`ul-${index}`} className="ocr-md-list">{items.map((item, itemIndex) => <li key={itemIndex}><MarkdownInline text={item} prefix={`ul-${index}-${itemIndex}`} /></li>)}</ul>);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items = collect(/^\s*\d+\.\s+/);
      blocks.push(<ol key={`ol-${index}`} className="ocr-md-list">{items.map((item, itemIndex) => <li key={itemIndex}><MarkdownInline text={item} prefix={`ol-${index}-${itemIndex}`} /></li>)}</ol>);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = collect(/^\s*>\s?/);
      blocks.push(<blockquote key={`quote-${index}`} className="ocr-md-quote"><MarkdownInline text={quote.join(' ')} prefix={`quote-${index}`} /></blockquote>);
      continue;
    }

    if (/^\s*((-{3,})|(\*{3,})|(_{3,}))\s*$/.test(line)) {
      blocks.push(<hr key={`hr-${index}`} className="ocr-md-hr" />);
      index += 1;
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !startsBlock(index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(<p key={`p-${index}`} className="ocr-md-p"><MarkdownInline text={paragraph.join(' ')} prefix={`p-${index}`} /></p>);
  }

  const visibleBlocks = tablesOnly ? tableBlocks : blocks;
  if (!visibleBlocks.length) return <div className="ocr-md-empty">{tablesOnly ? 'No table detected on this page. You can approve it or continue to the next page.' : 'This page contains no OCR text.'}</div>;
  return <div className="ocr-md">{visibleBlocks}</div>;
};

export { MarkdownPreview };
