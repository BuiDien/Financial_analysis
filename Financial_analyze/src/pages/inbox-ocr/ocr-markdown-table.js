// OCR Inbox: Markdown table row parsing / serializing and table geometry helpers (pure; node-testable).

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

export { splitMarkdownTableRow, isMarkdownTableSeparator, markdownHasTable, serializeMarkdownTableRow, safeTableSpan, spreadsheetColumnLabel };
