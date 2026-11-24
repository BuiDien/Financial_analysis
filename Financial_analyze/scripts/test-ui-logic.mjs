// node scripts/test-ui-logic.mjs — src/ui/logic.js (DataTable groups, Menu placement and keys,
// Select disabled options, AreaChart tick density, Toast dedupe).
import assert from 'node:assert/strict';
import { isGroupMarker, groupRows, placeMenu, cycleIndex, stepEnabled, tickCount, thinLabels, findTwin, sameAction } from '../src/ui/logic.js';
import { sortRows } from '../src/ui/sort.js';

// ── DataTable group markers ──
assert.equal(isGroupMarker({ group: 'Banks' }), true);
assert.equal(isGroupMarker({ group: 'Banks', meta: '3', key: 'b' }), true);
assert.equal(isGroupMarker({ group: 'Banks', ticker: 'VCB' }), false, 'a data row with a group field is not a marker');
assert.equal(isGroupMarker({ group: null }), false);
assert.equal(isGroupMarker(null), false);
assert.equal(isGroupMarker(['group']), false);

const rows = [
  { id: 'X', v: 9 },                        // before any marker → leading group, no header
  { group: 'Banks', meta: '2' },
  { id: 'VCB', v: 1 }, { id: 'TCB', v: 3 },
  { group: 'Tech' },
  { id: 'FPT', v: 2 },
];
const g = groupRows(rows, null);
assert.deepEqual(g.map(x => x.label), [null, 'Banks', 'Tech']);
assert.deepEqual(g.map(x => x.rows.map(r => r.id)), [['X'], ['VCB', 'TCB'], ['FPT']]);
assert.equal(g[1].meta, '2');
// Sorting applies inside each group, never across.
const desc = (list) => sortRows(list, r => r.v, 'desc');
assert.deepEqual(groupRows(rows, null, desc).map(x => x.rows.map(r => r.id)), [['X'], ['TCB', 'VCB'], ['FPT']]);
// groupBy (field or function), first-appearance order, missing label → '—'.
const flat = [{ id: 'A', s: 'Tech' }, { id: 'B', s: 'Banks' }, { id: 'C', s: 'Tech' }, { id: 'D' }];
assert.deepEqual(groupRows(flat, 's').map(x => [x.label, x.rows.map(r => r.id).join('')]), [['Tech', 'AC'], ['Banks', 'B'], ['—', 'D']]);
assert.deepEqual(groupRows(flat, r => (r.s || 'Other').length).map(x => x.label), [4, 5]);
assert.equal(groupRows(flat, null), null, 'no markers and no groupBy → not grouped');

// ── Menu placement ──
const V = { vw: 1000, vh: 800, mw: 200, mh: 150 };
assert.deepEqual(placeMenu({ ...V, x: 100, y: 100 }), { left: 100, top: 100, origin: 'left top' });
assert.deepEqual(placeMenu({ ...V, x: 950, y: 700 }), { left: 750, top: 550, origin: 'right bottom' }, 'flips at both edges');
assert.equal(placeMenu({ ...V, vw: 375, x: 360, y: 10, mw: 300 }).left, 60, 'kept inside a phone viewport');
const a = { left: 600, right: 700, top: 300, bottom: 330 };
assert.deepEqual(placeMenu({ ...V, anchorRect: a }), { left: 600, top: 336, origin: 'left top' });
assert.deepEqual(placeMenu({ ...V, anchorRect: a, align: 'end' }), { left: 500, top: 336, origin: 'right top' });
const low = { left: 600, right: 700, top: 700, bottom: 730 };
assert.deepEqual(placeMenu({ ...V, anchorRect: low }), { left: 600, top: 544, origin: 'left bottom' }, 'flips above the anchor');
// Menu keyboard cycling over enabled indices.
assert.equal(cycleIndex([0, 2, 5], -1, 1), 0);
assert.equal(cycleIndex([0, 2, 5], -1, -1), 5);
assert.equal(cycleIndex([0, 2, 5], 2, 1), 0, 'wraps forward');
assert.equal(cycleIndex([0, 2, 5], 0, -1), 5, 'wraps back');
assert.equal(cycleIndex([], 0, 1), -1);

// ── Select disabled options ──
const opts = [{ value: 1 }, { value: 2, disabled: true }, { value: 3 }, { value: 4, disabled: true }];
assert.equal(stepEnabled(opts, 0, 1), 2, 'skips a disabled option');
assert.equal(stepEnabled(opts, 2, 1), 2, 'clamps at the last enabled one');
assert.equal(stepEnabled(opts, 2, -1), 0);
assert.equal(stepEnabled([{ value: 1 }, { value: 2 }], 0, 1), 1, 'no disabled options: same as before');

// ── AreaChart density ──
assert.equal(tickCount(300), 5, 'desktop hero: the old 5 lines');
assert.equal(tickCount(180), 5);
assert.equal(tickCount(130), 3, 'short chart: fewer lines');
assert.equal(tickCount(60), 2);
assert.equal(tickCount(20), 2, 'never fewer than 2');
assert.equal(tickCount(1000, 4), 4, 'never more than max');
assert.deepEqual(thinLabels([100, 50, 0]), [2, 1, 0], 'spaced labels all stay (returned top-down)');
assert.deepEqual(thinLabels([30, 20, 10, 0], 12).sort(), [1, 3], 'labels closer than 12px are skipped');

// ── Toast dedupe ──
const list = [{ id: 1, message: 'Saved', type: 'success' }, { id: 2, message: 'Saved', type: 'error' }, { id: 3, message: 'Gone', type: 'info', gone: true }];
assert.equal(findTwin(list, { message: 'Saved', type: 'success' }).id, 1);
assert.equal(findTwin(list, { message: 'Saved', type: 'info' }), null, 'type must match');
assert.equal(findTwin(list, { message: 'Gone', type: 'info' }), null, 'an exiting toast is not reused');
assert.equal(findTwin(list, { message: 'Saved', type: 'success', dedupe: false }), null, 'dedupe:false always stacks');
assert.equal(findTwin(list, { message: 'Saved', type: 'success' }, [2, 3]), null, 'only live ids count');

// Toast dedupe with actions (fix round 1): only same-onClick or no-action pairs merge.
const undoA = () => 'A', undoB = () => 'B';
const withA = [{ id: 10, message: 'Deleted', type: 'info', action: { label: 'Undo', onClick: undoA } }];
assert.equal(findTwin(withA, { message: 'Deleted', type: 'info', action: { label: 'Undo', onClick: undoB } }), null, 'Undo of another item stacks');
assert.equal(findTwin(withA, { message: 'Deleted', type: 'info', action: null }), null, 'a no-action repeat does not join a toast with an action');
assert.equal(findTwin(withA, { message: 'Deleted', type: 'info', action: { label: 'Undo again', onClick: undoA } }).id, 10, 'same onClick merges');
assert.equal(findTwin([{ id: 11, message: 'Deleted', type: 'info', action: null }], { message: 'Deleted', type: 'info', action: { label: 'Undo', onClick: undoA } }), null, 'an action repeat does not join a plain toast');
assert.equal(sameAction(null, undefined), true);
assert.equal(sameAction({ onClick: undoA }, null), false);

console.log('test-ui-logic: ok');
