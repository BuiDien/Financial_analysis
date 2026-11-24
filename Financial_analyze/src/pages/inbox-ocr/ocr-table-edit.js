// Pure text helpers for OCR table edits (no React, no DOM). Pinned by scripts/test-ocr-table-edit.js.

// Clipboard text → rows of cells. Spreadsheet apps (Excel, Numbers, Sheets) end a copied range
// with a newline and may use \r\n: normalise line endings and drop ONE trailing line break, so
// the paste never gains an empty extra row that would blank the cell below the range.
const parseClipboardTable = text => {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\n$/, '');
  return normalized.split('\n').map(row => row.split('\t'));
};

// Index just past the line that closes the <table> opened at `start` (lines.length when unclosed).
const findHtmlTableEnd = (lines, start) => {
  const html = [lines[start]];
  let index = start + 1;
  while (index < lines.length && !html.some(value => /<\/table\s*>/i.test(value))) {
    html.push(lines[index]);
    index += 1;
  }
  return index;
};

// Replace lines [start, end) with `replacement` (a string, split on \n) and return the new text.
// Lines after `end` are kept: the HTML-table editor once spliced to the end of the page.
const replaceLineRange = (lines, start, end, replacement) => {
  const next = [...lines];
  next.splice(start, end - start, ...String(replacement ?? '').split('\n'));
  return next.join('\n');
};

export { parseClipboardTable, findHtmlTableEnd, replaceLineRange };
