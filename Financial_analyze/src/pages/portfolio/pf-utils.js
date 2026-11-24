// Portfolio helpers shared by the tabs and dialogs. Money always goes through
// lib/format.js (VND without decimals, ₫ suffix).

import { formatDate, formatMoney, formatNumber } from '../../lib/format.js';

const PORTFOLIO_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'CNY', 'VND'];
const TX_TYPES = ['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX'];

const pfMoney = (v, c) => formatMoney(v, c || 'VND');
// Share counts: whole shares grouped, fractional (US) shares up to 6 places.
const pfShares = (v) => {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return Number.isInteger(n) ? formatNumber(n) : formatNumber(n, Math.min(6, (String(n).split('.')[1] || '').length));
};
// Zero/empty counts read as "—" in the per-ticker breakdown.
const tkNum = (v) => (v ? pfShares(v) : '—');
const pfDate = (iso) => formatDate(iso);

const pfLocalDateTime = (value = new Date()) => {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

const download = (href, name) => {
  const a = document.createElement('a');
  a.href = href;
  if (name) a.download = name;
  a.click();
};

const plural = (n, one, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

// Toast for POST /api/gmail/check → { summary: { new, downloaded, errors, import } }.
// `import` is the SSI import summary, { deferred: true } or { error }.
const gmailSyncToast = (summary = {}) => {
  const imp = summary.import || {};
  const parts = [summary.new ? `${plural(summary.new, 'new email')}` : 'No new emails'];
  let type = 'success';
  if (imp.error) { parts.push(`import failed: ${imp.error}`); type = 'error'; }
  else if (imp.deferred) parts.push('more emails waiting — sync again to import');
  else {
    parts.push(`${plural(imp.trades || 0, 'trade')} imported`);
    const replaced = (imp.replaced_manual || 0) + (imp.statements?.replaced_manual || 0);
    if (replaced) parts.push(`${plural(replaced, 'manual entry', 'manual entries')} replaced`);
    const added = Object.values(imp.statements?.added || {}).reduce((a, b) => a + b, 0);
    if (added) parts.push(`${plural(added, 'statement row')} added`);
    const failed = (imp.failed_reports?.length || 0) + (imp.statements?.failed_reports?.length || 0);
    if (failed) { parts.push(`${plural(failed, 'report')} could not be read`); type = 'error'; }
  }
  if (summary.errors) { parts.push(`${plural(summary.errors, 'download error')}`); type = 'error'; }
  return { message: `Gmail: ${parts.join(' · ')}`, type };
};
// POST /api/gmail/check answers 400 with one of these when the address / app password is missing.
const gmailNotSetUp = (err) => err?.status === 400 && /address is not set|password is not saved/i.test(err.message || '');

// Rebuild jobs the Gmail import scheduled (daily reports, statements): wait for them before refreshing.
const syncJobIds = (summary) => [summary?.import?.job_id, summary?.import?.statements?.job_id].filter(Boolean);

// Pasted-order preview row → status shown in the dialog. Duplicates can't be added; a similar
// ledger trade (same day/ticker/side, other qty or price) is only a warning.
const pasteRowStatus = (row) => {
  if (row.duplicate) return row.duplicate_reason === 'repeated in pasted text'
    ? { label: 'Repeated in text', tone: 'neutral' } : { label: 'Already in ledger', tone: 'warn' };
  if (row.similar) return { label: 'Similar trade in ledger', tone: 'info',
    hint: `Ledger #${row.similar.id}: ${pfShares(row.similar.quantity)} @ ${formatMoney(row.similar.price, 'VND')} on the same day — check before adding` };
  return { label: 'OK', tone: 'pos' };
};
// DataTable row id: unique even if a backend regression ever repeats a key.
const pasteRowId = (row, i) => `${row.key}#${i}`;

export { PORTFOLIO_CURRENCIES, TX_TYPES, pfMoney, pfShares, tkNum, pfDate, pfLocalDateTime, download, gmailSyncToast, gmailNotSetUp, pasteRowStatus, pasteRowId, syncJobIds };
