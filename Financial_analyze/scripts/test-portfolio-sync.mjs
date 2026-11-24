// node scripts/test-portfolio-sync.mjs — Portfolio › Sync email toast and paste-row status helpers.
import assert from 'node:assert/strict';
import { gmailSyncToast, gmailNotSetUp, pasteRowStatus, syncJobIds, pasteRowId } from '../src/pages/portfolio/pf-utils.js';

assert.deepEqual(gmailSyncToast({ new: 0, errors: 0, import: { trades: 0, failed_reports: [] } }),
  { message: 'Gmail: No new emails · 0 trades imported', type: 'success' });
assert.deepEqual(gmailSyncToast({ new: 2, errors: 0, import: { trades: 1, replaced_manual: 1, failed_reports: [] } }),
  { message: 'Gmail: 2 new emails · 1 trade imported · 1 manual entry replaced', type: 'success' });
assert.deepEqual(gmailSyncToast({ new: 1, errors: 0, import: { trades: 0, failed_reports: [{ id: 1 }],
  statements: { added: { 'ssi_cash:DEPOSIT': 2, 'ssi_statement:BUY': 1 }, failed_reports: [] } } }),
  { message: 'Gmail: 1 new email · 0 trades imported · 3 statement rows added · 1 report could not be read', type: 'error' });
assert.equal(gmailSyncToast({ new: 30, errors: 1, import: { deferred: true } }).message,
  'Gmail: 30 new emails · more emails waiting — sync again to import · 1 download error');
assert.equal(gmailSyncToast({ new: 1, import: { error: 'boom' } }).type, 'error');
assert.equal(gmailSyncToast().message, 'Gmail: No new emails · 0 trades imported');

const err = (status, message) => Object.assign(new Error(message), { status });
assert.equal(gmailNotSetUp(err(400, 'Gmail address is not set.')), true);
assert.equal(gmailNotSetUp(err(400, 'App password is not saved.')), true);
assert.equal(gmailNotSetUp(err(400, 'cannot reach imap.gmail.com: x')), false);
assert.equal(gmailNotSetUp(err(409, 'A Gmail check is already running.')), false);
assert.equal(gmailNotSetUp(null), false);

assert.deepEqual(pasteRowStatus({ duplicate: true }), { label: 'Already in ledger', tone: 'warn' });
assert.deepEqual(pasteRowStatus({ duplicate: true, duplicate_reason: 'already in ledger' }), { label: 'Already in ledger', tone: 'warn' });
assert.deepEqual(pasteRowStatus({ duplicate: true, duplicate_reason: 'repeated in pasted text' }), { label: 'Repeated in text', tone: 'neutral' });
assert.deepEqual(pasteRowStatus({ duplicate: false, similar: { id: 4, quantity: 100, price: 53600 } }),
  { label: 'Similar trade in ledger', tone: 'info', hint: 'Ledger #4: 100 @ 53,600 ₫ on the same day — check before adding' });
assert.deepEqual(pasteRowStatus({ duplicate: false }), { label: 'OK', tone: 'pos' });

// Statement replacements count with daily ones.
assert.equal(gmailSyncToast({ new: 1, import: { trades: 0, replaced_manual: 1, failed_reports: [],
  statements: { added: { 'ssi_statement:BUY': 1 }, replaced_manual: 1, failed_reports: [] } } }).message,
  'Gmail: 1 new email · 0 trades imported · 2 manual entries replaced · 1 statement row added');

// Rebuild jobs the import scheduled (daily + statements), to wait for before refreshing.
assert.deepEqual(syncJobIds({ import: { job_id: 'a', statements: { job_id: 'b' } } }), ['a', 'b']);
assert.deepEqual(syncJobIds({ import: { trades: 0 } }), []);
assert.deepEqual(syncJobIds({ import: { deferred: true } }), []);
assert.deepEqual(syncJobIds(undefined), []);

// Row ids stay unique even if two preview rows share a key.
assert.notEqual(pasteRowId({ key: 'k' }, 0), pasteRowId({ key: 'k' }, 1));

console.log('test-portfolio-sync: ok');
