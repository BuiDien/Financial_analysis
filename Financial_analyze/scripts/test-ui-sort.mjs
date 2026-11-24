// node scripts/test-ui-sort.mjs — src/ui/sort.js (DataTable sorting of raw and formatted values).
import assert from 'node:assert/strict';
import { lenientNumber, compareValues, sortRows } from '../src/ui/sort.js';

assert.equal(lenientNumber('1,234'), 1234);
assert.equal(lenientNumber('500,000,000 ₫'), 5e8);
assert.equal(lenientNumber('+1.25%'), 1.25);
assert.equal(lenientNumber('−10%'), -10);
assert.equal(lenientNumber('3.49T'), 3.49e12);
assert.equal(lenientNumber('$1.2B'), 1.2e9);
assert.equal(lenientNumber('184M ₫'), 184e6);
assert.ok(Number.isNaN(lenientNumber('FPT')));
assert.ok(Number.isNaN(lenientNumber('VN30')));
assert.ok(Number.isNaN(lenientNumber('')));

const by = (vals, dir = 'asc') => sortRows(vals.map(v => ({ v })), r => r.v, dir).map(r => r.v);
assert.deepEqual(by(['999', '1,234', '50']), ['50', '999', '1,234']);
assert.deepEqual(by(['-5%', '-10%', '+2%', '0.00%']), ['-10%', '-5%', '0.00%', '+2%']);
assert.deepEqual(by(['1.5B ₫', '500M ₫', '2T ₫']), ['500M ₫', '1.5B ₫', '2T ₫']);
assert.deepEqual(by([3, null, 1, '—', 2], 'desc'), [3, 2, 1, null, '—']);
assert.deepEqual(by([3, null, 1, 2], 'asc'), [1, 2, 3, null]);
assert.deepEqual(by(['VCB', 'FPT', 'HPG']), ['FPT', 'HPG', 'VCB']);
assert.deepEqual(by(['b', 2, 'a', 1]), [1, 2, 'a', 'b']);
// stable for ties
assert.deepEqual(sortRows([{ k: 'a', v: 1 }, { k: 'b', v: 1 }, { k: 'c', v: 0 }], r => r.v, 'desc').map(r => r.k), ['a', 'b', 'c']);
assert.ok(compareValues('10', '9') > 0);
console.log('ui-sort: all passed');
