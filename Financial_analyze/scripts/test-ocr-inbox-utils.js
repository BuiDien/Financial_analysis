// node scripts/test-ocr-inbox-utils.js — pure OCR Inbox helpers (src/pages/inbox-ocr/ocr-inbox-utils.js).
const assert = require('assert');
const U = require('../src/pages/inbox-ocr/ocr-inbox-utils.js');

// Markdown table rows
assert.deepStrictEqual(U.splitMarkdownTableRow('| a | b \\| c | 1,0 |'), ['a', 'b | c', '1,0']);
assert.deepStrictEqual(U.splitMarkdownTableRow('a|b'), ['a', 'b']);
assert.strictEqual(U.serializeMarkdownTableRow(['a', 'b | c', null]), '| a | b \\| c |  |');
assert.deepStrictEqual(U.splitMarkdownTableRow(U.serializeMarkdownTableRow(['x', 'y|z'])), ['x', 'y|z']);
assert.strictEqual(U.isMarkdownTableSeparator('|---|:---:|---:|'), true);
assert.strictEqual(U.isMarkdownTableSeparator('| -- | --- |'), false);
assert.strictEqual(U.isMarkdownTableSeparator('no pipes'), false);
assert.strictEqual(U.isMarkdownTableSeparator(undefined), false);
assert.strictEqual(U.markdownHasTable('| A | B |\n|---|---|\n| 1 | 2 |'), true);
assert.strictEqual(U.markdownHasTable('<TABLE><tr><td>1</td></tr></TABLE>'), true);
assert.strictEqual(U.markdownHasTable('# Heading\nplain | text'), false);
assert.strictEqual(U.markdownHasTable(null), false);

// Exact decimals (VN and EN separators, parentheses negatives, no floats)
assert.deepStrictEqual(U.parseExactDecimal('1.234.567'), { units: '1234567', scale: 0 });
assert.deepStrictEqual(U.parseExactDecimal('1,234,567'), { units: '1234567', scale: 0 });
assert.deepStrictEqual(U.parseExactDecimal('(1.234,56)'), { units: '-123456', scale: 2 });
assert.deepStrictEqual(U.parseExactDecimal('**-12.5**'), { units: '-125', scale: 1 });
assert.deepStrictEqual(U.parseExactDecimal('−7'), { units: '-7', scale: 0 });
assert.deepStrictEqual(U.parseExactDecimal('0'), { units: '0', scale: 0 });
assert.strictEqual(U.parseExactDecimal('12%'), null);
assert.strictEqual(U.parseExactDecimal('Doanh thu'), null);
assert.strictEqual(U.parseExactDecimal('-'), null);
assert.strictEqual(U.parseExactDecimal(''), null);
const sum = U.sumExactDecimals(['99999999999999999999', '1', '(0,5)'].map(U.parseExactDecimal));
assert.strictEqual(U.formatExactDecimal(sum), '99,999,999,999,999,999,999.5');
assert.strictEqual(U.formatExactDecimal(U.sumExactDecimals(['10', '-10'].map(U.parseExactDecimal))), '0');
assert.strictEqual(U.formatExactDecimal(U.subtractExactDecimals(U.parseExactDecimal('1.000'), U.parseExactDecimal('1.000,25'))), '-0.25');
assert.strictEqual(U.subtractExactDecimals(U.parseExactDecimal('1.500'), U.parseExactDecimal('1,500')).units, '0');
assert.strictEqual(U.addExactUnits('-5', '3'), '-2');
assert.strictEqual(U.addExactUnits('5', '-5'), '0');

// Spreadsheet helpers
assert.deepStrictEqual([0, 25, 26, 27, 701, 702].map(U.spreadsheetColumnLabel), ['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
assert.strictEqual(U.safeTableSpan('3'), 3);
assert.strictEqual(U.safeTableSpan('0'), 1);
assert.strictEqual(U.safeTableSpan('999'), 100);
assert.strictEqual(U.safeTableSpan(null), 1);
assert.strictEqual(U.safeTableSpan('x'), 1);

// Label level markers
assert.strictEqual(U.labelLevelCode(-1), 'L');
assert.strictEqual(U.labelLevelCode(2), 'L2');
assert.strictEqual(U.labelLevelIndent(-1), 0);
assert.strictEqual(U.labelLevelIndent(3), 4);
assert.strictEqual(U.withLabelLevel('Tiền', 1), '<!--ocr-label-level:1-->Tiền');
assert.strictEqual(U.withLabelLevel('Tiền', -4), '<!--ocr-label-level:L-->Tiền');
assert.strictEqual(U.withLabelLevel('<!--ocr-label-level:2-->Tiền', null), 'Tiền');
assert.strictEqual(U.explicitLabelLevel('<!-- ocr-label-level:3;source:auto -->x'), 3);
assert.strictEqual(U.explicitLabelLevel('<!--ocr-label-level:L-->x'), -1);
assert.strictEqual(U.explicitLabelLevel({ text: 'x', level: 0 }), 0);
assert.strictEqual(U.explicitLabelLevel('plain'), null);
assert.strictEqual(U.visibleCellText('<!--ocr-label-level:1--> Tiền '), 'Tiền');
assert.strictEqual(U.visibleCellText({ text: 'A' }), 'A');

// Inferred levels
const row = (label, ...values) => [label, ...values];
assert.strictEqual(U.inferredLabelLevel('TỔNG CỘNG TÀI SẢN', row('TỔNG CỘNG TÀI SẢN', '1.000'), 0, false), 0);
assert.strictEqual(U.inferredLabelLevel('TÀI SẢN NGẮN HẠN', row('TÀI SẢN NGẮN HẠN', '600'), 0, false), 1);
assert.strictEqual(U.inferredLabelLevel('- Tiền mặt', row('- Tiền mặt', '5'), 0, false), 3);
assert.strictEqual(U.inferredLabelLevel('Section', row('Section', ''), 0, false), -1);
assert.strictEqual(U.inferredLabelLevel('Header', row('Header', '1'), 0, true), -1);
assert.strictEqual(U.inferredLabelLevel('1.000', row('1.000'), 0, false), null);
assert.strictEqual(U.inferredLabelLevel('Tiền', row('Tiền', '5'), 1, false), null);
assert.strictEqual(U.inferredLabelLevel('<!--ocr-label-level:2-->Tiền', row('x', '5'), 0, false), 2);

// Level-total mismatches map onto row/cell keys
const verification = { checks: [
  { table: 1, parent_row: 2, parent_level: 0, child_level: 1, child_rows: [3, 4], columns: [{ column: 2, matches: false, parent: '10', children_sum: '9', difference: '1' }] },
  { table: 1, parent_row: 3, parent_level: 1, child_level: 2, child_rows: [5], columns: [{ column: 2, matches: true }] },
  { table: 2, parent_row: 2, parent_level: 0, child_level: 1, child_rows: [3], columns: [{ column: 2, matches: false, parent: '1', children_sum: '2', difference: '-1' }] },
] };
const issues = U.levelMismatchCells(verification, 1, 2);
assert.deepStrictEqual(Object.keys(issues).sort(), ['0:1', '1:1', '2:1']);
assert.strictEqual(issues['0:1'].parent, true);
assert.strictEqual(issues['0:1'].suggestedValue, '9');
assert.match(issues['1:1'].messages[0], /Included in the mismatched L1 sum for parent row 2/);
assert.deepStrictEqual(U.levelMismatchCells(null, 1, 2), {});

// History helpers
assert.strictEqual(U.historyDmy('2026-09-30'), '30/09/2026');
assert.deepStrictEqual(U.historyPeriodText({ type: 'quarter', start: '2026-07-01', end: '2026-09-30' }), { label: 'Q3 2026', hint: '01/07/2026 – 30/09/2026' });
assert.strictEqual(U.historyPeriodText({ type: 'instant', start: null, end: '2026-06-30' }).label, 'At 30/06/2026');
assert.strictEqual(U.historyPeriodText({ type: 'ytd', start: '2026-01-01', end: '2026-09-30' }).label, '9M 2026 year to date');
assert.strictEqual(U.historyPeriodText({ type: 'year', start: '2025-01-01', end: '2025-12-31' }).label, 'FY 2025');
assert.strictEqual(U.historyPeriodText(null).label, 'Unknown period');
const periodOptions = U.historyPeriodOptions(2026, null);
assert.strictEqual(periodOptions.at(-1).value, 'skip');
assert.strictEqual(new Set(periodOptions.map(o => o.value)).size, periodOptions.length, 'no duplicate period options');
assert.ok(periodOptions.some(o => o.value === 'quarter|2025-10-01|2025-12-31'));
assert.strictEqual(U.historyPayload({
  tables: { '3:1': { kind: 'balance', unit_multiplier: 1000000, columns: { a: { column: 2, period: null } } } },
  lines: { '3:1:4': { line_key: 'cash' }, '3:1:5': { new_line_name: '  Other  ' }, '3:1:6': { new_line_name: ' ' } },
  misreads: { m: { page: 3 } },
  resolutions: { 'fact-1': 'new' },
}, 7).lines.length, 2);
assert.deepStrictEqual(U.historyPayload({ tables: { '3:1': { kind: 'income', columns: {} } }, lines: { '3:1:5': { new_line_name: '  Other  ' } }, misreads: {}, resolutions: { f: 'old' } }, 2), {
  revision: 2,
  tables: [{ page: 3, table: 1, columns: [], kind: 'income' }],
  lines: [{ page: 3, table: 1, row: 5, new_line_name: 'Other' }],
  accepted_misreads: [],
  resolutions: [{ fact_key: 'f', chosen: 'old' }],
});
assert.strictEqual(U.historyMoney(null), '—');

// Inbox labels
assert.strictEqual(U.inboxLabelSummary({ ticker: 'MBB', scope: 'consolidated', fiscal_year: 2026, period_code: 'Q3' }), 'MBB · Consolidated · Q3 2026');
assert.strictEqual(U.inboxLabelSummary({ ticker: 'MBB' }), null);
assert.deepStrictEqual(U.inboxLatestQuarter(new Date(2026, 10, 12)), { fiscal_year: 2026, period_code: 'Q3' });
assert.deepStrictEqual(U.inboxLatestQuarter(new Date(2027, 1, 1)), { fiscal_year: 2026, period_code: 'Q4' });
const years = U.historyFiscalYearOptions(1990).map(o => o.value);
assert.ok(years.includes(1990) && years[0] > years[1]);
assert.strictEqual(U.fmtInboxBytes(2 * 1048576), '2.0 MB');
assert.strictEqual(U.fmtInboxBytes(10), '1 KB');

console.log('ocr-inbox-utils: all checks passed');
