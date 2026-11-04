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

const splitMarkdownTableRow = line => {
  const escapedPipe = '\u0000HELIX_PIPE\u0000';
  let value = String(line || '').trim().replace(/\\\|/g, escapedPipe);
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map(cell => cell.replaceAll(escapedPipe, '|').trim());
};

const isMarkdownTableSeparator = line => {
  if (!String(line || '').includes('|')) return false;
  const cells = splitMarkdownTableRow(line);
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.replace(/\s/g, '')));
};

const markdownHasTable = markdown => {
  const value = String(markdown || '');
  const lines = value.replace(/\r\n?/g, '\n').split('\n');
  return /<table(?:\s|>)/i.test(value)
    || lines.some((line, index) => line.includes('|') && isMarkdownTableSeparator(lines[index + 1]));
};

const serializeMarkdownTableRow = cells => `| ${cells.map(cell => String(cell || '').replace(/\|/g, '\\|')).join(' | ')} |`;

const parseExactDecimal = input => {
  let value = String(input || '').replace(/(\*\*|__|`)/g, '').trim();
  if (!value || /%/.test(value) || /[A-Za-z]/.test(value)) return null;
  let negative = false;
  if (/^\(.*\)$/.test(value)) { negative = true; value = value.slice(1, -1); }
  value = value.replace(/[−–—]/g, '-').replace(/\s/g, '').replace(/[^\d.,+-]/g, '');
  if (!/^[+-]?[\d.,]+$/.test(value) || !/\d/.test(value)) return null;
  if (value.startsWith('-')) { negative = !negative; value = value.slice(1); }
  else if (value.startsWith('+')) value = value.slice(1);

  const comma = value.lastIndexOf(',');
  const dot = value.lastIndexOf('.');
  let decimalAt = -1;
  if (comma >= 0 && dot >= 0) {
    const last = Math.max(comma, dot);
    const trailing = value.length - last - 1;
    if (trailing > 0 && trailing <= 2) decimalAt = last;
  } else {
    const separator = comma >= 0 ? ',' : dot >= 0 ? '.' : '';
    if (separator) {
      const occurrences = value.split(separator).length - 1;
      const last = value.lastIndexOf(separator);
      const trailing = value.length - last - 1;
      if (occurrences === 1 && trailing > 0 && trailing <= 2) decimalAt = last;
    }
  }

  const scale = decimalAt >= 0 ? value.length - decimalAt - 1 : 0;
  const digits = value.split('').filter((character, index) => /\d/.test(character) && index !== decimalAt).join('');
  if (!digits) return null;
  const magnitude = digits.replace(/^0+(?=\d)/, '');
  const units = negative && magnitude !== '0' ? `-${magnitude}` : magnitude;
  return { units, scale };
};

const exactMagnitude = units => String(units || '0').replace(/^-/, '').replace(/^0+(?=\d)/, '');
const compareExactMagnitudes = (left, right) => left.length !== right.length ? left.length - right.length : left.localeCompare(right);
const addExactMagnitudes = (left, right) => {
  let carry = 0;
  let result = '';
  for (let index = 1; index <= Math.max(left.length, right.length); index += 1) {
    const total = Number(left[left.length - index] || 0) + Number(right[right.length - index] || 0) + carry;
    result = String(total % 10) + result;
    carry = Math.floor(total / 10);
  }
  return `${carry || ''}${result}`.replace(/^0+(?=\d)/, '');
};
const subtractExactMagnitudes = (left, right) => {
  let borrow = 0;
  let result = '';
  for (let index = 1; index <= left.length; index += 1) {
    let digit = Number(left[left.length - index] || 0) - borrow - Number(right[right.length - index] || 0);
    if (digit < 0) { digit += 10; borrow = 1; } else borrow = 0;
    result = String(digit) + result;
  }
  return result.replace(/^0+(?=\d)/, '');
};
const addExactUnits = (leftInput, rightInput) => {
  const left = String(leftInput || '0');
  const right = String(rightInput || '0');
  const leftNegative = left.startsWith('-');
  const rightNegative = right.startsWith('-');
  const leftMagnitude = exactMagnitude(left);
  const rightMagnitude = exactMagnitude(right);
  if (leftNegative === rightNegative) {
    const result = addExactMagnitudes(leftMagnitude, rightMagnitude);
    return leftNegative && result !== '0' ? `-${result}` : result;
  }
  const comparison = compareExactMagnitudes(leftMagnitude, rightMagnitude);
  if (comparison === 0) return '0';
  const leftLarger = comparison > 0;
  const result = subtractExactMagnitudes(leftLarger ? leftMagnitude : rightMagnitude, leftLarger ? rightMagnitude : leftMagnitude);
  const negative = leftLarger ? leftNegative : rightNegative;
  return negative && result !== '0' ? `-${result}` : result;
};
const scaleExactUnits = (units, places) => {
  const value = String(units || '0');
  if (value === '0') return value;
  return `${value}${'0'.repeat(Math.max(0, places))}`;
};
const sumExactDecimals = values => {
  const scale = Math.max(0, ...values.map(value => value.scale));
  return { scale, units: values.reduce((total, value) => addExactUnits(total, scaleExactUnits(value.units, scale - value.scale)), '0') };
};

const subtractExactDecimals = (left, right) => {
  const scale = Math.max(left.scale, right.scale);
  const leftUnits = scaleExactUnits(left.units, scale - left.scale);
  const rightUnits = scaleExactUnits(right.units, scale - right.scale);
  const negativeRight = rightUnits.startsWith('-') ? rightUnits.slice(1) : `-${rightUnits}`;
  return { scale, units: addExactUnits(leftUnits, negativeRight) };
};

const formatExactDecimal = value => {
  const negative = String(value.units).startsWith('-');
  const digits = exactMagnitude(value.units).padStart(value.scale + 1, '0');
  const integer = digits.slice(0, digits.length - value.scale || digits.length).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = value.scale ? digits.slice(-value.scale).replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
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

const safeTableSpan = value => {
  const parsed = Number.parseInt(value || '1', 10);
  return Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 1;
};

const spreadsheetColumnLabel = index => {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
};

const LABEL_LEVEL_VALUES = [-1, 0, 1, 2, 3];
const LABEL_LEVELS = { '-1': 'Text-only section label', 0: 'Section / grand total', 1: 'Group / subtotal', 2: 'Line item', 3: 'Detail' };
const LABEL_LEVEL_SHORT = { '-1': 'Label', 0: 'Total', 1: 'Group', 2: 'Item', 3: 'Detail' };
const LABEL_LEVEL_MARKER = /<!--\s*ocr-label-level:(L|[0-3])(?:;source:auto)?\s*-->/i;
const labelLevelCode = level => level < 0 ? 'L' : `L${level}`;
const labelLevelIndent = level => Math.max(0, level + 1);
const LabelLevelBadge = ({ level }) => <span
  aria-hidden="true"
  title={`${labelLevelCode(level)} · ${LABEL_LEVELS[level]}`}
  style={{ flex: '0 0 auto', minWidth: 22, padding: '1px 4px', border: '1px solid var(--border-strong)', borderRadius: 3, background: level <= 0 ? 'var(--text)' : 'var(--bg-elev)', color: level <= 0 ? 'var(--bg-elev)' : 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 700, lineHeight: 1.35, textAlign: 'center' }}
>{labelLevelCode(level)}</span>;
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
  const inputRef = React.useRef(null);

  const refresh = React.useCallback(async () => {
    if (focusedReviewId) return;
    if (!window.HelixAPI?.live) { setLoading(false); return; }
    try { setItems(await window.HelixAPI.ocrInbox()); }
    catch (e) { window.toast?.(`Could not load OCR Inbox: ${e.message}`, { type: 'error' }); }
    finally { setLoading(false); }
  }, [focusedReviewId]);

  React.useEffect(() => {
    if (focusedReviewId) return undefined;
    refresh();
    const timer = setInterval(refresh, 1800);
    return () => clearInterval(timer);
  }, [focusedReviewId, refresh]);

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
              {item.review && <a className="btn" href={(() => { const url = new URL(window.location.href); url.searchParams.set('ocrReview', item.id); return url.toString(); })()} target="_blank" rel="noopener noreferrer"><Icon name="eye" size={12} /> Open review</a>}
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

const OCRMarkdownReviewWorkspace = ({ item, review, setReview, reload, onBack }) => {
  const firstPage = review.pages[0]?.page || 1;
  const [selectedPage, setSelectedPage] = React.useState(firstPage);
  const [pageResult, setPageResult] = React.useState(null);
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

  const pageCount = review.pages.length || item.pages || 0;
  const locked = ['verified', 'published'].includes(review.status);
  const dirty = Boolean(pageResult && markdown !== pageResult.effective_markdown);

  const loadPage = React.useCallback(async () => {
    setPageLoading(true);
    setPageError('');
    try {
      const [result, latestHermes] = await Promise.all([
        window.HelixAPI.ocrReviewPage(review.id, selectedPage),
        window.HelixAPI.ocrHermesLabelReviewLatest(review.id, selectedPage),
      ]);
      setPageResult(result);
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
      setPageResult(null);
      setPageError(error.message || 'Could not load this OCR page');
    } finally {
      setPageLoading(false);
    }
  }, [review.id, review.revision, selectedPage]);

  React.useEffect(() => { loadPage(); }, [loadPage]);
  React.useEffect(() => {
    if (!hermesRun || !['queued', 'running'].includes(hermesRun.status)) return undefined;
    let canceled = false;
    const poll = window.setInterval(async () => {
      try {
        const next = await window.HelixAPI.ocrHermesLabelReviewRun(review.id, selectedPage, hermesRun.id);
        if (!canceled) setHermesRun(next);
      } catch (error) {
        if (!canceled) setActionError(error.message || 'Could not refresh the Ollama label review');
      }
    }, 1200);
    return () => {
      canceled = true;
      window.clearInterval(poll);
    };
  }, [hermesRun?.id, hermesRun?.status, review.id, selectedPage]);
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
    if (nextPage === selectedPage || nextPage < 1 || nextPage > pageCount) return;
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
    setSaving(true);
    setActionError('');
    try {
      const nextReview = await window.HelixAPI.ocrReviewPageAction(
        review.id,
        selectedPage,
        action,
        review.revision,
        correctedMarkdown,
      );
      setReview(nextReview);
      setLevelVerification(null);
      setEditing(false);
      if (action === 'correct') setViewMode(markdownHasTable(correctedMarkdown) ? 'tables' : 'preview');
      window.toast?.(
        action === 'correct' ? `Page ${selectedPage} correction saved` : `Page ${selectedPage} ${action === 'restore' ? 'reset' : 'approved'}`,
        { type: 'success' },
      );
    } catch (error) {
      setActionError(error.message || `Could not ${action} page ${selectedPage}`);
      if (error.status === 409 || error.message?.includes('refresh')) await reload();
    } finally {
      setSaving(false);
    }
  };

  const saveCorrection = async () => {
    if (!dirty) return;
    await pageAction('correct', markdown);
  };

  const detectLabelLevels = async () => {
    setDetectingLevels(true);
    setActionError('');
    try {
      const result = await window.HelixAPI.ocrReviewAutoLevels(
        review.id,
        selectedPage,
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
    setVerifyingLevelTotals(true);
    setActionError('');
    try {
      const result = await window.HelixAPI.ocrReviewVerifyLevelTotals(
        review.id,
        selectedPage,
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
        selectedPage,
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
      selectedPage,
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
          <button className="btn btn-primary" disabled={saving || review.counts.pending > 0 || visibleHermesSuggestions.length > 0 || locked} onClick={verify}>Verify review</button>
        </div>
      </div>

      {actionError && <div role="alert" style={{ padding: '9px 12px', marginBottom: 10, border: '1px solid var(--neg)', borderRadius: 6, color: 'var(--neg)', fontSize: 12 }}>{actionError}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(420px,1.1fr) minmax(440px,1fr)', gap: 14, flex: 1, minHeight: 0 }}>
        <div className="card" style={{ minHeight: 0, display: 'flex', flexDirection: 'column', background: '#383b40' }}>
          <div style={{ padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: 'var(--bg-elev)', borderBottom: '1px solid var(--border)' }}>
            <button className="btn" disabled={selectedPage <= 1} onClick={() => navigate(selectedPage - 1)}>← Previous</button>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 7 }}>
              PDF page
              <select value={selectedPage} onChange={event => navigate(Number(event.target.value))} style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-elev)', color: 'var(--text)' }}>
                {review.pages.map(page => <option key={page.page} value={page.page}>{page.page} · {page.status}</option>)}
              </select>
              <span className="num">of {pageCount}</span>
            </label>
            <button className="btn" disabled={selectedPage >= pageCount} onClick={() => navigate(selectedPage + 1)}>Next →</button>
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
            {pageLoading ? (
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

          {!pageLoading && !pageError && (!locked || (!editing && viewMode === 'tables')) && <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between', flexWrap: 'wrap', background: 'var(--bg-elev)' }}>
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
