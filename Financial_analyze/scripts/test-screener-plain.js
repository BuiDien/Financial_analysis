// node scripts/test-screener-plain.js — checks the Easy / Normal / Strict logic.
const assert = require('assert');
const P = require('../src/pages/scan/screener-plain.js');

const cat = {
  roe_years: { kind: 'at_least', params: { x: { min: 0, max: 100 }, n: { min: 1, max: 8 } } },
  debt_to_equity: { kind: 'at_most', params: { x: { min: 0, max: 10 } } },
  rsi: { kind: 'at_most', params: { x: { min: 1, max: 99 } } },
  price_drop: { kind: 'drop', params: { x: { min: 0, max: 80 }, d: { min: 1, max: 20 } } },
  volume_spike: { kind: 'at_least', params: { x: { min: 1, max: 20 } } },
  traded_value: { kind: 'at_least', params: { x: { min: 0, max: 1000 } } },
  scope: { kind: 'scope', params: { banks: {} } },
};
const base = [
  { id: 'scope', on: true, banks: 'no_financials' },
  { id: 'roe_years', on: true, x: 12, n: 3 },
  { id: 'debt_to_equity', on: true, x: 1.0 },
  { id: 'rsi', on: true, x: 35 },
  { id: 'price_drop', on: true, x: 7, d: 5 },
  { id: 'volume_spike', on: true, x: 1.3 },
  { id: 'traded_value', on: true, x: 1 },
];
const x = (rules, id) => rules.find(r => r.id === id).x;

const easy = P.applyLevel(cat, base, 'easy');
const strict = P.applyLevel(cat, base, 'strict');

// Easy loosens, Strict tightens, in each rule's own direction.
assert.strictEqual(x(easy, 'roe_years'), 9);
assert.strictEqual(x(strict, 'roe_years'), 15);
assert.strictEqual(x(easy, 'debt_to_equity'), 1.3);      // at_most: looser = higher
assert.strictEqual(x(strict, 'debt_to_equity'), 0.7);
assert.strictEqual(x(easy, 'rsi'), 40);                  // rsi < x: looser = higher
assert.strictEqual(x(strict, 'rsi'), 30);
assert.strictEqual(x(easy, 'price_drop'), 4);            // drop: looser = smaller drop
assert.strictEqual(x(strict, 'price_drop'), 10);
assert.strictEqual(x(easy, 'volume_spike'), 1.1);        // float noise rounded
assert.strictEqual(x(strict, 'volume_spike'), 1.5);
assert.strictEqual(x(easy, 'traded_value'), 0);          // clamped to min
// Other params and scope untouched; base not mutated.
assert.strictEqual(easy.find(r => r.id === 'roe_years').n, 3);
assert.deepStrictEqual(easy[0], base[0]);
assert.strictEqual(x(base, 'roe_years'), 12);
assert.deepStrictEqual(P.applyLevel(cat, base, 'normal'), base);

// detectLevel
assert.strictEqual(P.detectLevel(cat, base, base), 'normal');
assert.strictEqual(P.detectLevel(cat, base, easy), 'easy');
assert.strictEqual(P.detectLevel(cat, base, [...strict].reverse()), 'strict');   // order-insensitive
const custom = base.map(r => (r.id === 'roe_years' ? { ...r, x: 13 } : r));
assert.strictEqual(P.detectLevel(cat, base, custom), 'custom');
const nChanged = easy.map(r => (r.id === 'roe_years' ? { ...r, n: 2 } : r));
assert.strictEqual(P.detectLevel(cat, base, nChanged), 'custom');
const strX = base.map(r => (r.id === 'roe_years' ? { ...r, x: '12' } : r));       // typed text
assert.strictEqual(P.detectLevel(cat, base, strX), 'normal');

// Sentences
assert.match(P.sentence('roe_years', { x: 12, n: 3 }), /12 đồng per 100 đồng .* 3 years/);
assert.match(P.sentence('gross_margin_change', { x: -2, n: 3 }), /fell by no more than 2 points/);
assert.match(P.sentence('gross_margin_change', { x: 1, n: 3 }), /rose by at least 1 points/);
assert.strictEqual(P.scopeSummary({ banks: 'any', exchanges: [], flagged: 'include' }), 'All companies on HOSE, HNX and UPCOM');
assert.match(P.scopeSummary({ banks: 'no_financials', exchanges: ['HOSE'], flagged: 'exclude' }), /brokers .* only HOSE .* warning/);

// Every catalog rule a user can see has plain text and a step.
for (const id of ['roe_years', 'profit_growth', 'profit_growth_min', 'revenue_growth', 'debt_to_equity', 'ocf_to_profit',
  'pe_vs_industry', 'pb', 'dividend_yield', 'traded_value', 'market_cap', 'bank_npl', 'bank_nim', 'bank_cir', 'bank_car',
  'receivable_days_change', 'inventory_days_change', 'gross_margin_change', 'share_dilution', 'foreign_room',
  'rsi', 'price_drop', 'volume_spike']) {
  assert.ok(P.PLAIN[id] && P.STEPS[id], id);
}
// "n/a" cells: rule not applicable to this company type — neutral, not fail, not skipped.
assert.strictEqual(P.cellStatus({ status: 'n/a', value: null, score: null }), 'n/a');
assert.strictEqual(P.cellStatus({ status: 'not_applicable' }), 'n/a');
assert.strictEqual(P.cellStatus({ status: 'pass', value: 1 }), 'pass');
assert.strictEqual(P.cellStatus({ status: 'fail' }), 'fail');
assert.strictEqual(P.cellStatus({ value: 3 }), 'pass');            // legacy cells without status
assert.strictEqual(P.cellStatus(undefined), 'empty');
assert.strictEqual(P.isNotApplicable({ status: 'n/a' }), true);
assert.strictEqual(P.isNotApplicable({ status: 'missing' }), false);
assert.deepStrictEqual(P.notApplicableIds({ rules: { bank_npl: { status: 'n/a' }, roe_years: { status: 'pass' }, pb: { status: 'missing' } } }), ['bank_npl']);
assert.deepStrictEqual(P.notApplicableIds(null), []);
assert.match(P.NA_TIP, /not applicable to this company type/i);

console.log('screener-plain: all checks passed');
