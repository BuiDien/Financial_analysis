// node scripts/test-format.mjs — src/lib/format.js house style.
import assert from 'node:assert/strict';
import { formatMoney, formatPct, formatNumber, formatPrice, formatCompact, isNum, toDate, formatDate, formatDateTime } from '../src/lib/format.js';

const cases = [
  [formatMoney(500000000, 'VND'), '500,000,000 ₫'],
  [formatMoney(500000000.4, 'vnd'), '500,000,000 ₫'],
  [formatMoney(1500000000, 'VND', { compact: true }), '1.5B ₫'],
  [formatMoney(500000000, 'VND', { compact: true }), '500M ₫'],
  [formatMoney(-2500000, 'VND', { compact: true }), '-2.5M ₫'],
  [formatMoney(1500000, 'VND', { sign: true }), '+1,500,000 ₫'],
  [formatMoney(1234.5, 'USD'), '$1,234.50'],
  [formatMoney(-2, 'USD'), '-$2.00'],
  [formatMoney(1234567890, 'USD', { compact: true }), '$1.23B'],
  [formatMoney(1234, 'JPY'), '¥1,234'],
  [formatMoney(null, 'VND'), '—'],
  [formatMoney('abc', 'VND'), '—'],
  [formatPct(1.234), '+1.23%'],
  [formatPct(-0.4), '-0.40%'],
  [formatPct(0), '0.00%'],
  [formatPct(5, { sign: false, decimals: 1 }), '5.0%'],
  [formatPct(5, 1), '+5.0%'],
  [formatPct(undefined), '—'],
  [formatNumber(1234.5), '1,235'],
  [formatNumber(1234.5, 2), '1,234.50'],
  [formatNumber(NaN), '—'],
  [formatPrice(53600, 'VND'), '53,600 ₫'],
  [formatPrice(53600.6, 'VND', { symbol: false }), '53,601'],
  [formatPrice(186.64, 'USD'), '186.64 USD'],
  [formatCompact(3.49e12), '3.49T'],
  [formatCompact(4500), '4.5K'],
  // fix round 1: negative zero, unit rollover, blank / array input, VND rounding parity
  [formatMoney(-0.4, 'VND'), '0 ₫'],
  [formatMoney(0.3, 'VND', { sign: true }), '0 ₫'],
  [formatMoney(-0.001, 'USD'), '$0.00'],
  [formatPct(-0.001), '0.00%'],
  [formatPct(0.001), '0.00%'],
  [formatNumber(-0.2), '0'],
  [formatMoney(999950, 'VND', { compact: true }), '1M ₫'],
  [formatMoney(999499, 'VND', { compact: true }), '999K ₫'],
  [formatMoney(-999950, 'VND', { compact: true }), '-1M ₫'],
  [formatCompact(999999), '1.00M'],
  [formatCompact(999949), '999.9K'],
  [formatCompact(999.6), '1.0K'],
  [formatCompact(-0.2), '0'],
  [formatMoney(999999999, 'USD', { compact: true }), '$1B'],
  [formatMoney(' ', 'VND'), '—'],
  [formatMoney('', 'VND'), '—'],
  [formatNumber([]), '—'],
  [formatNumber([5]), '—'],
  [formatPct({}), '—'],
  [formatPrice('  ', 'VND'), '—'],
  [formatPrice(1.5, 'VND'), formatMoney(1.5, 'VND').replace(' ₫', '') + ' ₫'],
  [formatPrice(-1.5, 'VND'), '-2 ₫'],
  [formatMoney(-1.5, 'VND'), '-2 ₫'],
  [formatPrice(2.5, 'VND'), '3 ₫'],
  [formatMoney(2.5, 'VND'), '3 ₫'],
  [formatPrice(53600.5, 'VND', { symbol: false }), '53,601'],
];
let failed = 0;
cases.forEach(([got, want], i) => {
  try { assert.equal(got, want); } catch { failed++; console.error(`FAIL #${i}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
});
assert.equal(isNum(true), false);
// dates (TZ-independent checks)
const local = new Date(2026, 10, 24, 14, 5);
assert.equal(formatDateTime(local), 'Nov 24, 2026, 14:05');
assert.equal(formatDateTime(local, { year: false }), 'Nov 24, 14:05');
assert.equal(formatDate('2026-11-10'), 'Nov 10, 2026');
assert.equal(formatDateTime(new Date(2026, 10, 24, 0, 7)), 'Nov 24, 2026, 00:07');
assert.equal(formatDate(null), '—');
assert.equal(formatDateTime('garbage'), '—');
assert.equal(toDate(1767000000).getTime(), 1767000000000);
assert.equal(toDate(1767000000000).getTime(), 1767000000000);
assert.equal(toDate('2026-11-24T07:05:00', { naiveUtc: true }).toISOString(), '2026-11-24T07:05:00.000Z');
assert.equal(toDate('2026-11-24T07:05:00+00:00', { naiveUtc: true }).toISOString(), '2026-11-24T07:05:00.000Z');
assert.equal(isNum('12'), true);
if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log(`format: ${cases.length} cases passed`);
