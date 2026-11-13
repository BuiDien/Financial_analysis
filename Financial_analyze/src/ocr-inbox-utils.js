// OCR Inbox pure helpers (no React, no DOM): Markdown table parsing, exact decimal
// arithmetic, label-level markers, and the "Add to history" answer helpers.
// Plain JS so it loads before the Babel pages and runs under node
// (scripts/test-ocr-inbox-utils.js). Everything hangs off one global,
// window.OcrInboxUtils; page-ocr-inbox.jsx re-binds the names it uses.
(function (root) {
  const OCR_STATUS = {
    uploaded: ['Uploaded', 'var(--text-muted)'], queued: ['Queued', '#B45309'],
    held: ['Held', '#B45309'],
    processing: ['Processing', '#1D4ED8'], ready_for_review: ['Ready for review', '#7C3AED'],
    reviewing: ['Reviewing', '#7C3AED'], verified: ['Verified · needs labels', '#15803D'],
    ready_to_publish: ['Ready to publish', '#15803D'], published: ['Published', '#15803D'],
    failed: ['Failed', '#B91C1C'],
  };

  const fmtInboxBytes = (n) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

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

  const HISTORY_KIND_OPTIONS = [
    { value: 'balance', label: 'Balance sheet' },
    { value: 'income', label: 'Income statement' },
    { value: 'cashflow', label: 'Cash flow' },
    { value: 'skip', label: 'Skip', hint: 'not a statement table' },
  ];
  const HISTORY_KIND_NAMES = { balance: 'Balance sheet', income: 'Income statement', cashflow: 'Cash flow', skip: 'Skipped' };
  const HISTORY_UNIT_OPTIONS = [
    { value: 1, label: 'đồng' },
    { value: 1000, label: 'nghìn đồng', hint: '× 1,000' },
    { value: 1000000, label: 'triệu đồng', hint: '× 1,000,000' },
    { value: 1000000000, label: 'tỷ đồng', hint: '× 1,000,000,000' },
  ];
  const HISTORY_TABLE_CODES = new Set(['review_not_verified', 'labels_missing', 'table_kind_unknown', 'unit_unknown', 'column_period_unknown', 'period_mismatch']);
  const HISTORY_EMPTY_DRAFT = { tables: {}, lines: {}, misreads: {}, resolutions: {} };

  const historyTableKey = (page, table) => `${page}:${table}`;
  const historyRowKey = (page, table, row) => `${page}:${table}:${row}`;
  const historyMisreadKey = m => `${m.page}:${m.content_sha256}:${m.table}:${m.parent_row}:${m.column_label}`;
  const historyDmy = iso => { const [y, m, d] = String(iso).split('-'); return `${d}/${m}/${y}`; };
  const historyPeriodValue = p => (p ? `${p.type}|${p.start || ''}|${p.end}` : '');
  const historyPeriodText = p => {
    if (!p) return { label: 'Unknown period', hint: '' };
    const year = String(p.end).slice(0, 4);
    if (p.type === 'instant') return { label: `At ${historyDmy(p.end)}`, hint: 'balance date' };
    const range = `${historyDmy(p.start)} – ${historyDmy(p.end)}`;
    if (p.type === 'quarter') return { label: `Q${Math.ceil(Number(String(p.end).slice(5, 7)) / 3)} ${year}`, hint: range };
    if (p.type === 'year') return { label: `FY ${year}`, hint: range };
    const months = (Number(String(p.end).slice(0, 4)) - Number(String(p.start).slice(0, 4))) * 12
      + Number(String(p.end).slice(5, 7)) - Number(String(p.start).slice(5, 7)) + 1;
    return { label: `${months}M ${year} year to date`, hint: range };
  };
  // Every period a column of this filing could plausibly hold, for the owner to pick from.
  const historyPeriodOptions = (fiscalYear, current) => {
    const options = [];
    const add = p => { if (!options.some(o => o.value === historyPeriodValue(p))) options.push({ value: historyPeriodValue(p), ...historyPeriodText(p), period: p }); };
    if (current) add(current);
    const base = Number(fiscalYear) || new Date().getFullYear();
    [base, base - 1].forEach(y => {
      [['01-01', '03-31'], ['04-01', '06-30'], ['07-01', '09-30'], ['10-01', '12-31']].forEach(([a, b]) => add({ type: 'quarter', start: `${y}-${a}`, end: `${y}-${b}` }));
      add({ type: 'ytd', start: `${y}-01-01`, end: `${y}-06-30` });
      add({ type: 'ytd', start: `${y}-01-01`, end: `${y}-09-30` });
      add({ type: 'year', start: `${y}-01-01`, end: `${y}-12-31` });
      ['03-31', '06-30', '09-30', '12-31'].forEach(d => add({ type: 'instant', start: null, end: `${y}-${d}` }));
    });
    options.push({ value: 'skip', label: 'Skip this column', hint: 'not a value column' });
    return options;
  };
  const historyMoney = value => (value === null || value === undefined ? '—' : `${Number(value).toLocaleString('vi-VN')} đ`);

  const historyPayload = (draft, revision) => ({
    revision,
    tables: Object.entries(draft.tables).map(([key, answer]) => {
      const [page, table] = key.split(':').map(Number);
      const out = { page, table, columns: Object.values(answer.columns || {}) };
      if (answer.kind) out.kind = answer.kind;
      if (answer.unit_multiplier) out.unit_multiplier = answer.unit_multiplier;
      return out;
    }),
    // A new line without a name is not an answer yet (the row stays open).
    lines: Object.entries(draft.lines)
      .filter(([, answer]) => answer.line_key || (answer.new_line_name || '').trim())
      .map(([key, answer]) => {
        const [page, table, row] = key.split(':').map(Number);
        return answer.line_key ? { page, table, row, line_key: answer.line_key } : { page, table, row, new_line_name: answer.new_line_name.trim() };
      }),
    accepted_misreads: Object.values(draft.misreads),
    resolutions: Object.entries(draft.resolutions).map(([fact_key, chosen]) => ({ fact_key, chosen })),
  });

  const HISTORY_SCOPE_OPTIONS = [
    { value: 'consolidated', label: 'Consolidated', hint: 'hợp nhất' },
    { value: 'separate', label: 'Separate', hint: 'riêng lẻ' },
  ];
  const HISTORY_PERIOD_CODE_OPTIONS = ['Q1', 'Q2', 'Q3', 'Q4', 'H1', 'FY'].map(code => ({
    value: code, label: code, hint: { H1: 'first half (6 months)', FY: 'full fiscal year' }[code] || 'quarter',
  }));
  // Values are spelled the way backend parse_unit_multiplier understands them.
  const LABEL_UNIT_OPTIONS = [
    { value: 'triệu đồng', label: 'triệu đồng', hint: 'million VND — most BCTC' },
    { value: 'đồng', label: 'đồng', hint: 'VND' },
    { value: 'nghìn đồng', label: 'nghìn đồng', hint: 'thousand VND' },
    { value: 'tỷ đồng', label: 'tỷ đồng', hint: 'billion VND' },
  ];
  const inboxLabelSummary = labels => {
    if (!labels || !labels.ticker || !labels.scope || !labels.fiscal_year || !labels.period_code) return null;
    const scope = labels.scope === 'consolidated' ? 'Consolidated' : labels.scope === 'separate' ? 'Separate' : labels.scope;
    return `${labels.ticker} · ${scope} · ${labels.period_code} ${labels.fiscal_year}`;
  };
  // Latest quarter that has ended (Nov 2026 → Q3 2026; Feb 2027 → Q4 2026).
  const inboxLatestQuarter = (now = new Date()) => {
    const done = Math.floor(now.getMonth() / 3);
    return done === 0 ? { fiscal_year: now.getFullYear() - 1, period_code: 'Q4' } : { fiscal_year: now.getFullYear(), period_code: `Q${done}` };
  };
  const historyFiscalYearOptions = current => {
    const now = new Date().getFullYear();
    const years = [];
    for (let year = now + 1; year >= now - 15; year--) years.push(year);
    if (current && !years.includes(Number(current))) years.push(Number(current));
    return years.sort((a, b) => b - a).map(year => ({ value: year, label: String(year) }));
  };

  const api = {
    OCR_STATUS,
    fmtInboxBytes,
    splitMarkdownTableRow,
    isMarkdownTableSeparator,
    markdownHasTable,
    serializeMarkdownTableRow,
    parseExactDecimal,
    exactMagnitude,
    compareExactMagnitudes,
    addExactMagnitudes,
    subtractExactMagnitudes,
    addExactUnits,
    scaleExactUnits,
    sumExactDecimals,
    subtractExactDecimals,
    formatExactDecimal,
    safeTableSpan,
    spreadsheetColumnLabel,
    LABEL_LEVEL_VALUES,
    LABEL_LEVELS,
    LABEL_LEVEL_SHORT,
    LABEL_LEVEL_MARKER,
    labelLevelCode,
    labelLevelIndent,
    explicitLabelLevel,
    visibleCellText,
    withLabelLevel,
    levelMismatchCells,
    inferredLabelLevel,
    HISTORY_KIND_OPTIONS,
    HISTORY_KIND_NAMES,
    HISTORY_UNIT_OPTIONS,
    HISTORY_TABLE_CODES,
    HISTORY_EMPTY_DRAFT,
    historyTableKey,
    historyRowKey,
    historyMisreadKey,
    historyDmy,
    historyPeriodValue,
    historyPeriodText,
    historyPeriodOptions,
    historyMoney,
    historyPayload,
    HISTORY_SCOPE_OPTIONS,
    HISTORY_PERIOD_CODE_OPTIONS,
    LABEL_UNIT_OPTIONS,
    inboxLabelSummary,
    inboxLatestQuarter,
    historyFiscalYearOptions,
  };
  root.OcrInboxUtils = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
