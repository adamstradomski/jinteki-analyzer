// Small hand-written logs for parser behaviour the golden logs (test/*.log) don't exercise:
// other paste formats, line kinds that are rare in real games, and bad input.
//   node --test test/trace/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadParser, plain } from './load-parser.mjs';

const touched = [];
const { parseLog } = loadParser(touched);
const parse = (lines) => plain(parseLog(lines.join('\n')));

// One round with a click for credit each, whose turn-end credits add up.
const ROUND = [
  'Corp started their turn 1 with 5  and 5 cards in HQ.',
  'Corp spends  to use Corp Basic Action Card to gain 1 .',
  'Corp is ending their turn 1 with 6  and 5 cards in HQ.',
  'Runner',
  'Runner',
  'glhf',
  'Runner started their turn 1 with 5  and 5 cards in their Grip.',
  'Runner spends  to use Runner Basic Action Card to gain 1 .',
  'Runner is ending their turn 1 with 6  and 5 cards in their Grip.',
];

test('the plain round parses as expected', () => {
  const d = parse(ROUND);
  assert.deepEqual(d.players, ['Corp', 'Runner']);
  assert.deepEqual(d.playerSide, { Corp: 'corp', Runner: 'runner' });
  assert.deepEqual(d.clickCredits, { Corp: { count: 1, gained: 1 }, Runner: { count: 1, gained: 1 } });
  assert.equal(d.chatBadges.Runner.glhf, true);
  assert.deepEqual(d.flagged, []);
});

test('a copy with timestamps on their own lines parses like the plain log', () => {
  // Copying from jinteki.net with timestamps visible splits "Name message" around the timestamp;
  // a chat message just gets the timestamp between its lines.
  const stamped = [];
  ROUND.forEach((line, i) => {
    const ts = `[12:00:${String(i).padStart(2, '0')}]`;
    const m = line.match(/^(Corp|Runner)( .+)$/);
    if (m) stamped.push(m[1], ts, m[2]);
    else if (line === 'Runner' && ROUND[i + 1] === 'Runner') stamped.push(line, ts);
    else stamped.push(line);
  });
  assert.ok(stamped.includes('[12:00:00]') && stamped.includes(' started their turn 1 with 5  and 5 cards in HQ.'));
  assert.deepEqual(parse(stamped), parse(ROUND));
});

test('timestamps glued to the name by the bookmarklet are removed', () => {
  // textContent joins the timestamp element to the name: "Corp[22:40:21] started ...".
  const glued = ROUND.map((line) => line.replace(/^(Corp|Runner) /, '$1[22:40:21] '));
  assert.notDeepEqual(glued, ROUND);
  assert.deepEqual(parse(glued), parse(ROUND));
});

test('Windows line endings parse like Unix ones', () => {
  assert.deepEqual(plain(parseLog(ROUND.join('\r\n'))), parse(ROUND));
});

test("the Corp's basic actions are counted with their costs", () => {
  const d = parse([
    'Corp started their turn 1 with 5  and 5 cards in HQ.',
    'Corp spends  and pays 2  to use Corp Basic Action Card to trash a resource.',
    'Corp spends  and pays 1  to use Corp Basic Action Card to advance a card in Server 1.',
    'Corp spends  to use Corp Basic Action Card to purge virus counters.',
    'Corp is ending their turn 1 with 2  and 5 cards in HQ.',
  ]);
  assert.deepEqual(d.trashResources, { Corp: { count: 1, cost: 2 } });
  assert.deepEqual(d.advanceClicks, { Corp: { count: 1, cost: 1 } });
  assert.deepEqual(d.purgeClicks, { Corp: 1 });
  assert.deepEqual(d.totalSpent, { Corp: 3 });
  assert.equal(d.playerSide.Corp, 'corp');
  assert.deepEqual(d.flagged, []); // the turn-end credits add up
});

test("credits the Corp's card gives the Runner go to the Runner", () => {
  const d = parse([
    ...ROUND,
    'Corp started their turn 2 with 6  and 5 cards in HQ.',
    'Corp uses Some Asset to let the Runner gain 2 .',
    'Corp is ending their turn 2 with 6  and 5 cards in HQ.',
    'Runner started their turn 2 with 8  and 5 cards in their Grip.',
  ]);
  assert.deepEqual(d.totalGained, { Corp: 1, Runner: 3 });
  assert.deepEqual(d.flagged, []);
});

test('manual agenda point and tag corrections are applied or flagged', () => {
  const d = parse([
    ...ROUND,
    'Corp sets their agenda points to 1 (+1).',
    'Runner sets Tags to 2 (+2).',
  ]);
  assert.deepEqual(d.finalScore, { Corp: 1, Runner: 0 });
  assert.deepEqual(d.tagsGained, { Runner: 0 });
  assert.deepEqual(d.flagged.map((f) => f.reason.split(' — ')[0]), [
    'Manual agenda point adjustment (Corp)',
    'Manual tag adjustment (Runner)',
  ]);
});

test('forfeited agendas lose the points they were scored for, or the lookup value', () => {
  const d = parse([
    ...ROUND,
    'Corp scores Hostile Takeover and gains 2 agenda points.',
    'Corp forfeits Hostile Takeover to use Some Operation.',
    'Corp forfeits Regenesis.', // never scored in this log: 1 point from the lookup table
    'Corp forfeits Unlisted Agenda.',
  ]);
  assert.deepEqual(d.agendaEvents.map((e) => e.points), [2, -2, -1]);
  assert.deepEqual(d.finalScore, { Corp: -1, Runner: 0 });
  assert.equal(d.flagged.length, 1);
  assert.match(d.flagged[0].reason, /^Unlisted Agenda \(Corp\) — forfeited, but its agenda point value isn't known/);
});

test('an agenda revealed into a score area counts only when its points are known', () => {
  const d = parse([
    ...ROUND,
    'Corp uses Regenesis to reveal Fujii Asset Retrieval and add it to their score area.',
    'Corp uses Regenesis to reveal Unlisted Agenda from Archives and add it to their score area.',
  ]);
  assert.deepEqual(d.finalScore, { Corp: 3, Runner: 0 });
  assert.equal(d.flagged.length, 1);
  assert.match(d.flagged[0].reason, /^Unlisted Agenda \(Corp\) — added to score area by another card's effect/);
});

test('a third player means the log did not parse cleanly', () => {
  const d = parse([...ROUND, 'Stray started their turn 1 with 5  and 5 cards in HQ.']);
  assert.match(d.playerCountError, /^Detected 3 distinct players \(Corp, Runner, Stray\)/);
  assert.equal(d.flagged[0].reason, d.playerCountError);
});

test('text without turn lines yields no players and no errors', () => {
  const d = parse(['hello', 'this is not a game log']);
  assert.deepEqual(d.players, []);
  assert.equal(d.rounds, 0);
  assert.equal(d.playerCountError, null);
});

// Last, so it covers every case above (tests in a file run in order).
test('no case touched a browser global', () => {
  assert.deepEqual(touched, []);
});
