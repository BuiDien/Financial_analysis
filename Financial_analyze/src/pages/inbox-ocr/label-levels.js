// OCR Inbox: label-level markers (<!-- ocr-label-level:Lx -->), cell text and level inference (pure; node-testable).
import { parseExactDecimal } from './exact-decimal.js';

const LABEL_LEVEL_VALUES = [-1, 0, 1, 2, 3];
const LABEL_LEVELS = { '-1': 'Text-only section label', 0: 'Section / grand total', 1: 'Group / subtotal', 2: 'Line item', 3: 'Detail' };
const LABEL_LEVEL_SHORT = { '-1': 'Label', 0: 'Total', 1: 'Group', 2: 'Item', 3: 'Detail' };
const LABEL_LEVEL_MARKER = /<!--\s*ocr-label-level:(L|[0-3])(?:;source:auto)?\s*-->/i;
const labelLevelCode = level => level < 0 ? 'L' : `L${level}`;
const labelLevelIndent = level => Math.max(0, level + 1);

const explicitLabelLevel = cell => {
  if (cell && typeof cell === 'object' && Number.isInteger(cell.level)) return cell.level;
  const match = String(cell || '').match(LABEL_LEVEL_MARKER);
  return match ? (match[1].toUpperCase() === 'L' ? -1 : Number(match[1])) : null;
};
const visibleCellText = cell => {
  const value = typeof cell === 'object' ? cell.text : cell;
  return String(value || '').replace(LABEL_LEVEL_MARKER, '').trim();
};
const withLabelLevel = (value, level) => {
  if (level === null || level === undefined) return visibleCellText(value);
  const normalized = Math.min(3, Math.max(-1, level));
  const token = normalized < 0 ? 'L' : normalized;
  return `<!--ocr-label-level:${token}-->${visibleCellText(value)}`;
};
const levelMismatchCells = (verification, tableNumber, rowNumberOffset) => {
  const issues = {};
  const failures = (verification?.checks || [])
    .filter(check => check.table === tableNumber)
    .flatMap(check => check.columns
      .filter(column => !column.matches)
      .map(column => ({ check, column })));
  const addIssue = (rowNumber, columnNumber, message, suggestion = null) => {
    const rowIndex = rowNumber - rowNumberOffset;
    const cellIndex = columnNumber - 1;
    if (rowIndex < 0 || cellIndex < 0) return;
    const key = `${rowIndex}:${cellIndex}`;
    const current = issues[key] || { messages: [] };
    current.messages.push(message);
    if (suggestion) Object.assign(current, suggestion);
    issues[key] = current;
  };
  failures.forEach(({ check, column }) => {
      const failsUpperLevel = failures.some(({ check: upperCheck, column: upperColumn }) => (
        upperColumn.column === column.column
        && upperCheck.parent_level + 1 === check.parent_level
        && upperCheck.child_rows.includes(check.parent_row)
      ));
      const calculation = `L${check.parent_level} total mismatch: ${column.parent} − L${check.child_level} sum ${column.children_sum} = ${column.difference}.`;
      const suggestionMessage = `${failsUpperLevel ? 'Check this subtotal first. It also contributes to a mismatched upper-level total. ' : ''}If the L${check.child_level} rows are correct, the suggested L${check.parent_level} value is ${column.children_sum}.`;
      addIssue(check.parent_row, column.column, `${calculation} ${suggestionMessage}`, {
        parent: true,
        priority: failsUpperLevel,
        suggestedValue: column.children_sum,
      });
      check.child_rows.forEach(rowNumber => addIssue(
        rowNumber,
        column.column,
        `Included in the mismatched L${check.child_level} sum for parent row ${check.parent_row}. ${calculation}`,
      ));
    });
  return issues;
};
const inferredLabelLevel = (cell, row, cellIndex, isHeader) => {
  const explicit = explicitLabelLevel(cell);
  if (explicit !== null) return explicit;
  const text = visibleCellText(cell);
  if (!text || parseExactDecimal(text) || cellIndex !== 0) return null;
  if (isHeader) return -1;
  const letters = text.replace(/[^A-Za-zÀ-ỹĐđ]/g, '');
  const uppercase = letters.length >= 3 && letters === letters.toUpperCase();
  const rowHasNumber = row.slice(1).some(value => {
    const visible = visibleCellText(value);
    return Boolean(parseExactDecimal(visible)) || /^[-–—]$/.test(visible);
  });
  if (!rowHasNumber) return -1;
  if (/^(TỔNG|TOTAL|GRAND TOTAL)\b/i.test(text)) return 0;
  if (uppercase) return rowHasNumber ? 1 : 0;
  if (/^[-–—•+]/.test(text)) return 3;
  if (/^(lợi nhuận|profit|doanh thu thuần|net revenue)\b/i.test(text)) return 1;
  return rowHasNumber ? 1 : 2;
};

export { LABEL_LEVEL_VALUES, LABEL_LEVELS, LABEL_LEVEL_SHORT, LABEL_LEVEL_MARKER, labelLevelCode, labelLevelIndent, explicitLabelLevel, visibleCellText, withLabelLevel, levelMismatchCells, inferredLabelLevel };
