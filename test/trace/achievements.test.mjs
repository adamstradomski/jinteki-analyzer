// Achievements (ACHIEVEMENTS and evaluateAchievements in public/trace/parser.js), evaluated on
// hand-built parse results so each rule is checked on its own. Most are never earned in the golden
// logs.   node --test test/trace/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadParser } from './load-parser.mjs';

const { evaluateAchievements, ACHIEVEMENTS } = loadParser();

// A finished parse result that earns nothing: no winner, a click for credit and a draw click each,
// 5 credits left, nothing scored, trashed, taken or mulliganed.
function game(over = {}){
  return {
    players: ['C', 'R'],
    playerSide: { C: 'corp', R: 'runner' },
    winner: null,
    winReason: null,
    rounds: 10,
    finalScore: { C: 0, R: 0 },
    agendaEvents: [],
    finalCreditPool: { C: 5, R: 5 },
    poolSegments: { C: [], R: [] },
    clickCredits: { C: { count: 1, gained: 1 }, R: { count: 1, gained: 1 } },
    drawClicks: { C: 1, R: 1 },
    flatlinedPlayer: null,
    tagsGiven: {},
    tagsGained: {},
    opposingTrashes: {},
    damageTaken: {},
    mulligans: [],
    ...over,
  };
}

const names = (data) => {
  const earned = evaluateAchievements(data);
  return { C: Array.from(earned.C, (a) => a.name), R: Array.from(earned.R, (a) => a.name) };
};
const agenda = (player, points) => ({ player, points, turn: 1, seq: 1 });
const pool = (start, over = {}) => ({ start, values: [], end: null, expected: null, ok: null, ...over });
const corpWin = { winner: 'C' };
const runnerWin = { winner: 'R' };

// [achievement, data that earns it, what each player earns from that data]
const CASES = [
  ['Off the Books', { ...corpWin, clickCredits: { C: { count: 0, gained: 0 } } }, { C: ['Off the Books'] }],
  ['No Day Job', { ...runnerWin, clickCredits: { R: { count: 0, gained: 0 } } }, { R: ['No Day Job'] }],
  ['Mandatory Minimum', { ...corpWin, drawClicks: { R: 1 } }, { C: ['Mandatory Minimum'] }],
  ['A Diesel a Day', { ...runnerWin, drawClicks: { C: 1 } }, { R: ['A Diesel a Day'] }],
  ['Too Big to Fail', { poolSegments: { C: [pool(5, { values: [12, 30] })] } }, { C: ['Too Big to Fail'] }],
  ['Savvy Investor', { poolSegments: { R: [pool(30)] } }, { R: ['Savvy Investor'] }],
  ['Unhedged', { ...corpWin, finalCreditPool: { C: 0, R: 5 } }, { C: ['Unhedged'] }],
  ['Sure Gamble', { ...runnerWin, finalCreditPool: { C: 5, R: 0 } }, { R: ['Sure Gamble'] }],
  ['Boom!', { ...corpWin, winReason: 'flatline', flatlinedPlayer: 'R' }, { C: ['Boom!'] }],
  ['One Step From Freedom', { flatlinedPlayer: 'R', finalScore: { C: 0, R: 6 } }, { R: ['One Step From Freedom'] }],
  ['Keyhole', { ...runnerWin, winReason: 'decked', finalScore: { C: 0, R: 2 } }, { R: ['Keyhole'] }],
  ['Apocalypse', { ...runnerWin, winReason: 'decked' }, { R: ['Keyhole', 'Apocalypse'] }],
  ['Government Takeover', { ...corpWin, winReason: 'agenda', agendaEvents: [agenda('C', 7)] }, { C: ['Government Takeover'] }],
  ['Inside Job', { ...runnerWin, winReason: 'agenda', agendaEvents: [agenda('R', 7)] }, { R: ['Inside Job'] }],
  ['Crisis Management', { ...corpWin, winReason: 'agenda', agendaEvents: [agenda('R', 6), agenda('C', 7)] }, { C: ['Crisis Management'] }],
  ['Out of the Ashes', { ...runnerWin, winReason: 'agenda', agendaEvents: [agenda('C', 6), agenda('R', 7)] }, { R: ['Out of the Ashes'] }],
  ['Fast Advance', { ...corpWin, winReason: 'agenda', rounds: 6, agendaEvents: [agenda('R', 1), agenda('C', 7)] }, { C: ['Fast Advance'] }],
  ['Early Bird', { ...runnerWin, winReason: 'agenda', rounds: 6, agendaEvents: [agenda('C', 1), agenda('R', 7)] }, { R: ['Early Bird'] }],
  ['Public Enemy Made', { ...corpWin, tagsGiven: { C: 10 } }, { C: ['Public Enemy Made'] }],
  ['Most Wanted', { ...runnerWin, tagsGained: { R: 10 } }, { R: ['Most Wanted'] }],
  ['Asset Seizure', { opposingTrashes: { C: 5 } }, { C: ['Asset Seizure'] }],
  ['Demolition Run', { opposingTrashes: { R: 5 } }, { R: ['Demolition Run'] }],
  ['Acceptable Losses', { ...corpWin, opposingTrashes: { R: 5 } }, { C: ['Acceptable Losses'], R: ['Demolition Run'] }],
  ['Scar Tissue', { ...runnerWin, damageTaken: { R: 5 } }, { R: ['Scar Tissue'] }],
  ['Board Restructure', { ...corpWin, mulligans: ['C'] }, { C: ['Board Restructure'] }],
  ['Fresh Identity', { ...runnerWin, mulligans: ['R'] }, { R: ['Fresh Identity'] }],
];

test('the baseline game earns nothing, even for the winner', () => {
  assert.deepEqual(names(game()), { C: [], R: [] });
  assert.deepEqual(names(game(corpWin)), { C: [], R: [] });
  assert.deepEqual(names(game(runnerWin)), { C: [], R: [] });
});

for (const [name, over, expected] of CASES){
  test(`earns ${name}`, () => {
    assert.deepEqual(names(game(over)), { C: [], R: [], ...expected });
  });
}

test('every achievement has a case above, a side, a unique name and a description', () => {
  assert.deepEqual(Array.from(ACHIEVEMENTS, (a) => a.name).sort(), CASES.map(([name]) => name).sort());
  for (const a of ACHIEVEMENTS){
    assert.ok(a.side === 'corp' || a.side === 'runner', a.name);
    assert.ok(a.description.endsWith('.'), a.name);
  }
});

test('thresholds are not met one short', () => {
  const cases = [
    { poolSegments: { C: [pool(29, { values: [29], expected: 29 })] } },
    { flatlinedPlayer: 'R', finalScore: { C: 0, R: 5 } },
    { ...corpWin, winReason: 'agenda', rounds: 7, agendaEvents: [agenda('R', 1), agenda('C', 7)] },
    { ...corpWin, winReason: 'agenda', agendaEvents: [agenda('R', 5), agenda('C', 7)] },
    { ...corpWin, tagsGiven: { C: 9 } },
    { ...runnerWin, tagsGained: { R: 9 } },
    { opposingTrashes: { C: 4, R: 4 } },
    { ...runnerWin, damageTaken: { R: 4 } },
    { ...runnerWin, winReason: 'decked', finalScore: { C: 0, R: 1 } },
  ];
  for (const over of cases){
    const got = names(game(over));
    assert.deepEqual([...got.C, ...got.R].filter((n) => n !== 'Keyhole'), [], JSON.stringify(over));
  }
});

test("a credit stretch that overshoots the printed total can't earn the rich achievement", () => {
  // The derived pool reached 32, but the stretch ended 4 above what the log printed, so some
  // gain was misread: its values are lowered by that overshoot (32 - 4 = 28).
  const overshoot = pool(10, { values: [32, 24], end: 24, expected: 20, ok: false });
  assert.deepEqual(names(game({ poolSegments: { C: [overshoot] } })).C, []);
  // Falling short of the printed total (a missed spend) lowers nothing.
  const short = pool(10, { values: [30, 16], end: 16, expected: 20, ok: false });
  assert.deepEqual(names(game({ poolSegments: { C: [short] } })).C, ['Too Big to Fail']);
});

test('a player without a known side earns nothing', () => {
  const d = game({ winner: 'C', playerSide: { R: 'runner' }, clickCredits: {}, drawClicks: {} });
  assert.deepEqual(names(d), { C: [], R: [] });
});
