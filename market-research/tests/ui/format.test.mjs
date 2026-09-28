// Unit tests for the Market Research page's DOM-free helpers: the formatters (format.js) and the
// chart axis helpers (charts.js). Run: node --test market-research/tests/ui/
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as F from '../../../public/market-research/format.js';
import { niceMax, niceAxis } from '../../../public/market-research/charts.js';

test('missing values format as an en dash', () => {
  for (const f of [F.fmtInt, F.fmtPct, F.fmtPp, F.fmtRatio, F.fmtNum]) {
    assert.equal(f(null), '–');
    assert.equal(f(undefined), '–');
  }
  assert.equal(F.fmtN(null), 'n=–');
});

test('integers use British grouping', () => {
  assert.equal(F.fmtInt(0), '0');
  assert.equal(F.fmtInt(1234567), '1,234,567');
  assert.equal(F.fmtN(1500), 'n=1,500');
});

test('percentages, ratios and plain numbers', () => {
  assert.equal(F.fmtPct(0.5), '50.0%');
  assert.equal(F.fmtPct(0.12345, 2), '12.35%');
  assert.equal(F.fmtPct(0.126, 0), '13%');
  assert.equal(F.fmtPct(0), '0.0%');
  assert.equal(F.fmtRatio(1.234), '1.23×');
  assert.equal(F.fmtNum(2.5), '2.50');
  assert.equal(F.fmtNum(2.5, 1), '2.5');
});

test('percentage points carry a sign, with a true minus and ± for zero', () => {
  assert.equal(F.MINUS, '−');
  assert.equal(F.fmtPp(3.21), '+3.2 pp');
  assert.equal(F.fmtPp(-3.26), '−3.3 pp');
  assert.equal(F.fmtPp(0), '±0.0 pp');
  assert.equal(F.fmtPp(1, 0), '+1 pp');
});

test('month labels are UTC and do not drift with the local time zone', () => {
  assert.equal(F.monthName('2026-05'), 'May 2026');
  assert.equal(F.monthName('2025-12'), 'Dec 2025');
  assert.equal(F.shortMonth('2026-01'), 'Jan');
  assert.equal(F.shortMonth('2026-12'), 'Dec');
});

test('niceMax rounds up to 1, 2, 2.5 or 5 times a power of ten', () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(-3), 1);
  assert.equal(niceMax(1), 1);
  assert.equal(niceMax(1.1), 2);
  assert.equal(niceMax(2.2), 2.5);
  assert.equal(niceMax(3), 5);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(0.37), 0.5);
  assert.equal(niceMax(42), 50);
});

test('niceAxis widens [lo, hi] to whole nice steps', () => {
  assert.deepEqual(niceAxis(0, 1), { lo: 0, hi: 1, step: 0.25 });
  assert.deepEqual(niceAxis(-7, 7), { lo: -10, hi: 10, step: 5 });
  assert.deepEqual(niceAxis(0, 3), { lo: 0, hi: 3, step: 1 });
  const a = niceAxis(0.31, 0.58);
  assert.ok(a.lo <= 0.31 && a.hi >= 0.58, JSON.stringify(a));
  assert.ok(Math.abs((a.hi - a.lo) / a.step - Math.round((a.hi - a.lo) / a.step)) < 1e-9);
  // An empty range still gets an axis.
  const z = niceAxis(2, 2);
  assert.ok(z.hi > z.lo);
});
