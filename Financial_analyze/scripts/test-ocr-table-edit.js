// node scripts/test-ocr-table-edit.js — OCR table edit helpers (src/pages/inbox-ocr/ocr-table-edit.js).
const assert = require('assert');
const E = require('../src/pages/inbox-ocr/ocr-table-edit.js');

// TSV paste: Excel/Numbers end the range with a newline (often \r\n) — no extra empty row.
assert.deepStrictEqual(E.parseClipboardTable('1.000\t2.000\r\n3.000\t4.000\r\n'), [['1.000', '2.000'], ['3.000', '4.000']]);
assert.deepStrictEqual(E.parseClipboardTable('5.512.408\n'), [['5.512.408']]);
assert.deepStrictEqual(E.parseClipboardTable('a\tb\rc\td'), [['a', 'b'], ['c', 'd']]);   // old Mac \r
assert.deepStrictEqual(E.parseClipboardTable('a\tb\nc\td'), [['a', 'b'], ['c', 'd']]);   // internal copy, no trailing newline
assert.deepStrictEqual(E.parseClipboardTable('a\n\n'), [['a'], ['']]);                    // only ONE trailing break is dropped
assert.deepStrictEqual(E.parseClipboardTable('x\t\ty'), [['x', '', 'y']]);               // empty cells kept

// HTML-table edit keeps the Markdown after the table (regression: everything after it was deleted).
const page = ['# Thuyết minh 7', '', '<table><tr><td>Cho vay</td><td>1</td></tr>', '</table>', '', 'Ghi chú sau bảng', '| A | B |'];
const end = E.findHtmlTableEnd(page, 2);
assert.strictEqual(end, 4);
const edited = E.replaceLineRange(page, 2, end, '<table><tr><td>Cho vay</td><td>2</td></tr></table>');
assert.strictEqual(edited, ['# Thuyết minh 7', '', '<table><tr><td>Cho vay</td><td>2</td></tr></table>', '', 'Ghi chú sau bảng', '| A | B |'].join('\n'));
assert.ok(edited.endsWith('Ghi chú sau bảng\n| A | B |'));
assert.strictEqual(E.findHtmlTableEnd(['<table><tr><td>1</td></tr></table>', 'after'], 0), 1);   // one-line table
assert.strictEqual(E.findHtmlTableEnd(['<table>', '<tr>'], 0), 2);                                  // unclosed → to the end
assert.strictEqual(E.replaceLineRange(['a', 'b', 'c'], 1, 2, 'x\ny'), 'a\nx\ny\nc');

console.log('ocr-table-edit: all checks passed');
