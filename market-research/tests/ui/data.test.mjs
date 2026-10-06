// Unit tests for public/market-research/data.js against the pipeline's golden snapshot,
// so a contract change breaks one side or the other in CI.  Run: node --test market-research/tests/ui/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import * as D from '../../../public/market-research/data.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', 'fixtures', 'expected', 'snapshot');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const load = (url) => JSON.parse(readFileSync(path.join(root, url.replace(/^\/snap\//, '')), 'utf8'));
const slice = (kind, s) => load(D.sliceUrl('/snap/', manifest, kind, s));
const T = manifest.thresholds;
const catalogIdx = D.catalogIndex(load(`/snap/${manifest.base_path}${manifest.paths.catalog}`));
const close = (a, b, tol, msg) => {
  if (a === null || b === null) return assert.equal(a, b, msg);
  assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
};

test('manifest contract', () => {
  assert.equal(manifest.schema, 'mr.manifest/1');
  assert.deepEqual(manifest.sides, ['corp', 'runner']);
  assert.equal(manifest.restrictions[0].id, 'all');
  assert.equal(manifest.tier_groups[0].id, 'all');
  assert.match(manifest.base_path, /^v=\d{4}-\d{2}-\d{2}T\d{6}Z\/$/);
  assert.ok(manifest.attribution.links.some((l) => l.url === 'https://alwaysberunning.net'));
});

test('every slice path built from the manifest exists', () => {
  for (const side of manifest.sides) {
    for (const r of manifest.restrictions) {
      for (const t of manifest.tier_groups) {
        for (const kind of ['summary', 'trends', 'identities', 'summary_cut', 'trends_cut', 'tournaments']) {
          const url = D.sliceUrl('/snap/', manifest, kind, { side, restriction: r.id, tier: t.id });
          assert.ok(existsSync(path.join(root, url.slice(6))), url);
        }
      }
    }
  }
  assert.throws(() => D.sliceUrl('/snap/', manifest, 'summary', { side: 'evil', restriction: 'all', tier: 'all' }));
  assert.throws(() => D.sliceUrl('/snap/', manifest, 'summary', { side: 'corp', restriction: '../x', tier: 'all' }));
});

test('summing trends over the summary period reproduces summary.json (every deck and top-cut decks)', () => {
  for (const [summaryKind, trendsKind] of [['summary', 'trends'], ['summary_cut', 'trends_cut']]) {
  for (const side of manifest.sides) {
    for (const r of manifest.restrictions) {
      for (const t of manifest.tier_groups) {
        const s = { side, restriction: r.id, tier: t.id };
        const summary = slice(summaryKind, s);
        const trends = slice(trendsKind, s);
        if (!summary.period) {
          assert.equal(summary.cards.length, 0);
          continue;
        }
        const mine = D.summarize(trends, summary.period, T, 'all', catalogIdx);
        assert.deepEqual(mine.baseline.faction_decks, summary.baseline.faction_decks);
        assert.equal(mine.baseline.decks, summary.baseline.decks);
        assert.equal(mine.baseline.games, summary.baseline.games);
        close(mine.baseline.winrate, summary.baseline.winrate, 1e-4, 'baseline winrate');
        assert.deepEqual(mine.previous_period, summary.previous_period);
        const theirs = new Map(summary.cards.map((c) => [c.card_id, c]));
        assert.equal(mine.cards.length, summary.cards.length, `${side}/${r.id}/${t.id}`);
        for (const c of mine.cards) {
          const o = theirs.get(c.card_id);
          assert.ok(o, c.card_id);
          assert.equal(c.rank, o.rank);
          assert.equal(c.decks, o.decks);
          assert.equal(c.games, o.games);
          assert.equal(c.copies_mode, o.copies_mode);
          assert.equal(c.winrate_status, o.winrate_status);
          assert.equal(c.conversion_status, o.conversion_status);
          close(c.popularity, o.popularity, 1e-4, 'popularity');
          close(c.avg_copies, o.avg_copies, 1e-3, 'avg copies');
          close(c.change_pp, o.change_pp, 0.01, 'change');
          close(c.winrate_diff_pp, o.winrate_diff_pp, 0.01, 'winrate diff');
          close(c.wilson_low_pp, o.wilson_low_pp, 0.01, 'wilson low');
          close(c.wilson_high_pp, o.wilson_high_pp, 0.01, 'wilson high');
          close(c.conversion, o.conversion, 1e-4, 'conversion');
          close(c.conversion_ratio, o.conversion_ratio, 1e-3, 'conversion ratio');
          assert.equal(c.decks_in_faction, o.decks_in_faction, `${c.card_id} decks in faction`);
          assert.equal(c.splash_status, o.splash_status, `${c.card_id} splash status`);
          for (const k of ['popularity_in', 'prev_popularity_in', 'popularity_out', 'prev_popularity_out', 'splash_share', 'prev_splash_share']) {
            close(c[k], o[k], 1e-4, `${c.card_id} ${k}`);
          }
          for (const k of ['change_in_pp', 'change_out_pp', 'change_splash_pp']) close(c[k], o[k], 0.01, `${c.card_id} ${k}`);
        }
        assert.deepEqual(mine.risers, summary.risers);
        assert.deepEqual(mine.fallers, summary.fallers);
      }
    }
  }
  }
});

test('top-cut slices are a subset of every deck', () => {
  for (const side of manifest.sides) {
    const s = { side, restriction: 'all', tier: 'all' };
    const all = slice('summary', s);
    const cut = slice('summary_cut', s);
    assert.deepEqual(cut.period, all.period);
    assert.ok(cut.baseline.decks <= all.baseline.decks && cut.baseline.games <= all.baseline.games);
    const decks = new Map(all.cards.map((c) => [c.card_id, c.decks]));
    for (const c of cut.cards) assert.ok(c.decks <= (decks.get(c.card_id) ?? 0), c.card_id);
  }
});

test('merging tier groups by summing equals the "all" slice', () => {
  for (const side of manifest.sides) {
    const parts = manifest.tier_groups.filter((t) => t.id !== 'all')
      .map((t) => slice('trends', { side, restriction: 'all', tier: t.id }));
    const merged = D.mergeTrends(parts);
    const all = slice('trends', { side, restriction: 'all', tier: 'all' });
    const range = { from: all.months[0], to: all.months.at(-1) };
    assert.deepEqual(D.sumBaseline(merged, range), D.sumBaseline(all, range));
    assert.deepEqual(D.sumFactions(merged, range), D.sumFactions(all, range));
    for (const cid of Object.keys(all.cards)) {
      assert.deepEqual(D.sumCard(merged, cid, range), D.sumCard(all, cid, range), cid);
    }
  }
});

test('ban list slices add up to the "all" slice and per-ban-list sums work', () => {
  const all = slice('trends', { side: 'corp', restriction: 'all', tier: 'all' });
  const range = { from: all.months[0], to: all.months.at(-1) };
  let decks = 0;
  for (const r of manifest.restrictions.filter((x) => x.id !== 'all')) {
    const one = slice('trends', { side: 'corp', restriction: r.id, tier: 'all' });
    const fromOne = D.sumBaseline(one, range).side_decks;
    assert.equal(D.sumBaseline(all, range, r.id).side_decks, fromOne, r.id);
    assert.deepEqual(D.sumFactions(all, range, r.id), D.sumFactions(one, range), r.id);
    decks += fromOne;
  }
  assert.equal(decks, D.sumBaseline(all, range).side_decks);
});

test('wilson interval matches reference values', () => {
  const [lo, hi] = D.wilson(3, 5);
  close(lo, 0.2307, 1e-4, 'lo');
  close(hi, 0.8824, 1e-4, 'hi');
  assert.equal(D.wilson(0, 0), null);
});

test('cardMetrics: draws, minimum sample, conversion', () => {
  const c = { decks_with_card: 3, copies_sum: 6, qty1: 1, qty2: 1, qty3: 1, games_total: 5, games_won: 3,
    entries_with_card_hc: 2, cut_with_card_hc: 2, tournaments_hc_with_card: 1 };
  const b = { side_decks: 4, side_games: 6, side_wins: 3.5, side_entries_hc: 3, side_cut_hc: 2, tournaments: 2, tournaments_hc: 1 };
  const m = D.cardMetrics(c, b, null, null, { min_games: 30, min_entries: 20 });
  assert.equal(m.popularity, 0.75);
  assert.equal(m.avg_copies, 2);
  close(m.winrate_diff_pp, (0.6 - 3.5 / 6) * 100, 1e-9, 'diff');
  assert.equal(m.winrate_status, 'insufficient');
  assert.equal(m.conversion, 1);
  close(m.conversion_ratio, 1.5, 1e-9, 'ratio');
  assert.equal(m.copies_mode, 1);
  assert.equal(m.change_pp, null);
  const ok = D.cardMetrics(c, b, null, null, { min_games: 5, min_entries: 2 });
  assert.equal(ok.winrate_status, 'ok');
  assert.equal(ok.conversion_status, 'ok');
});

test('hash state round-trips and invalid values fall back to defaults', () => {
  const r = manifest.restrictions[1].id;
  const t = manifest.tier_groups[1].id;
  const lo = manifest.months[0];
  const hi = manifest.months.at(-1);
  const s = D.parseHash(`#${r}/${t}/${lo}..${hi}/runner`, manifest);
  assert.deepEqual([s.restriction, s.tier, s.from, s.to, s.side, s.custom], [r, t, lo, hi, 'runner', true]);
  assert.equal(D.formatHash(s), `#${r}/${t}/${lo}..${hi}/runner`);
  const bad = D.parseHash('#<script>/nope/2026-99..zz/sideways', manifest);
  const def = D.defaultPeriod(manifest);
  assert.deepEqual([bad.restriction, bad.tier, bad.from, bad.to, bad.side, bad.custom], ['all', 'all', def.from, def.to, 'corp', false]);
  const clamped = D.parseHash('#all/all/2000-01..2999-12/corp', manifest);
  assert.deepEqual([clamped.from, clamped.to], [lo, hi]);
  assert.equal(D.parseHash('', manifest).side, 'corp');
  const cut = D.parseHash(`#all/all/${lo}..${hi}/corp/cut`, manifest);
  assert.equal(cut.cut, true);
  assert.equal(D.formatHash(cut), `#all/all/${lo}..${hi}/corp/cut`);
  assert.equal(D.parseHash('#all/all//corp/nope', manifest).cut, false);
  assert.equal(D.parseHash('#all/all//corp/cut', { ...manifest, paths: { summary: 'x' } }).cut, false); // older snapshot
});

test('hash: table view and open card round-trip after the filters', () => {
  const s = D.parseHash('#all/all//corp/cut/show:out/card:hedge_fund', manifest);
  assert.deepEqual([s.cut, s.show, s.card], [true, 'out', 'hedge_fund']);
  assert.equal(D.formatHash(s), '#all/all//corp/cut/show:out/card:hedge_fund');
});

test('hash: the default period is left out so a link follows the newest months', () => {
  const s = D.parseHash('#all/all//corp', manifest);
  assert.ok(s.from && s.to && !s.custom);
  assert.equal(D.formatHash(s), '#all/all//corp');
  assert.equal(D.formatHash({ ...s, custom: true }), `#all/all/${s.from}..${s.to}/corp`);
});

test('hash: an older link without view or card opens the default view and no card', () => {
  const s = D.parseHash('#all/all//runner', manifest);
  assert.deepEqual([s.side, s.show, s.card], ['runner', 'all', null]);
  assert.equal(D.formatHash(s), '#all/all//runner');
});

test('hash: segments after the side may come in any order', () => {
  const s = D.parseHash('#all/all//corp/card:hedge_fund/show:splash/cut', manifest);
  assert.deepEqual([s.cut, s.show, s.card], [true, 'splash', 'hedge_fund']);
});

test('hash: the first valid segment of a kind wins', () => {
  const s = D.parseHash('#all/all//corp/show:nope/show:in/show:out/card:hedge_fund/card:snare', manifest);
  assert.deepEqual([s.show, s.card], ['in', 'hedge_fund']);
});

test('hash: an unknown view falls back to all decks', () => {
  assert.equal(D.parseHash('#all/all//corp/show:best', manifest).show, 'all');
  assert.equal(D.parseHash('#all/all//corp/show:', manifest).show, 'all');
});

test('hash: unknown segments are ignored', () => {
  const s = D.parseHash('#all/all//corp/zoom:3/card:hedge_fund', manifest);
  assert.equal(s.card, 'hedge_fund');
});

for (const [why, seg] of [
  ['an empty id', 'card:'],
  ['upper case', 'card:Hedge_Fund'],
  ['a path', 'card:../x'],
  ['a second colon', 'card:hedge_fund:x'],
  ['a trailing newline', 'card:hedge_fund\n'],
  ['non-ASCII digits', 'card:card_\u0663'],
  ['an accent', 'card:caf\u00e9'],
  ['over 80 characters', `card:${'a'.repeat(81)}`],
]) {
  test(`hash: a card id with ${why} is dropped`, () => {
    assert.equal(D.parseHash(`#all/all//corp/${seg}`, manifest).card, null);
  });
}

test('hash: a card id of exactly 80 characters is kept', () => {
  assert.equal(D.parseHash(`#all/all//corp/card:${'a'.repeat(80)}`, manifest).card, 'a'.repeat(80));
});

test('hash: a card the catalog does not have is dropped when a check is given', () => {
  const isCard = (id) => catalogIdx.has(id);
  assert.equal(D.parseHash('#all/all//corp/card:made_up_card', manifest, isCard).card, null);
  assert.equal(D.parseHash('#all/all//corp/card:hedge_fund', manifest, isCard).card, 'hedge_fund');
});

test('dataHash ignores the table view and the open card', () => {
  const a = D.parseHash('#all/all//corp/cut', manifest);
  const b = D.parseHash('#all/all//corp/cut/show:out/card:hedge_fund', manifest);
  assert.equal(D.dataHash(a), D.dataHash(b));
  assert.notEqual(D.dataHash(a), D.dataHash({ ...b, cut: false }));
});

test('data base accepts only the production host or same-origin paths', () => {
  assert.equal(D.dataBase(''), 'https://data.jinteki.win/');
  assert.equal(D.dataBase('?data=/dev/snap'), '/dev/snap/');
  assert.equal(D.dataBase('?data=https://evil.example/'), 'https://data.jinteki.win/');
  assert.equal(D.dataBase('?data=//evil.example/'), 'https://data.jinteki.win/');
  assert.equal(D.dataBase('?data=javascript:alert(1)'), 'https://data.jinteki.win/');
});

test('months and previous range', () => {
  assert.equal(D.addMonths('2026-01', -1), '2025-12');
  assert.equal(D.addMonths('2026-12', 1), '2027-01');
  assert.deepEqual(D.monthSpan('2026-11', '2027-02'), ['2026-11', '2026-12', '2027-01', '2027-02']);
  assert.deepEqual(D.previousRange('2026-07', '2026-09'), { from: '2026-04', to: '2026-06' });
});

test('series, markers, scatter and table orders', () => {
  const s = { side: 'corp', restriction: 'all', tier: 'all' };
  const summary = slice('summary', s);
  const trends = slice('trends', s);
  const top = summary.cards[0].card_id;
  const series = D.monthlySeries(trends, top);
  assert.equal(series.length, trends.months.length);
  assert.ok(series.every((p) => p.popularity === null || (p.popularity >= 0 && p.popularity <= 1)));
  // Monthly winrate, interval and copies agree with cardMetrics over the same single month.
  for (const p of series) {
    const r = { from: p.month, to: p.month };
    const c = D.cardMetrics(D.sumCard(trends, top, r), D.sumBaseline(trends, r), null, null, T);
    for (const k of ['avg_copies', 'winrate', 'winrate_diff_pp', 'wilson_low_pp', 'wilson_high_pp']) close(p[k], c[k], 1e-9, `${k} ${p.month}`);
    if (p.games) assert.ok(p.winrate_low <= p.winrate && p.winrate <= p.winrate_high, `interval ${p.month}`);
    else assert.equal(p.winrate_low, null);
  }
  assert.ok(series.some((p) => p.games > 0), 'fixture has monthly games');
  const markers = D.banlistMarkers(manifest, trends.months);
  assert.ok(markers.length >= 1 && markers.every((m) => trends.months.includes(m.month)));
  const pts = D.scatterPoints(summary.cards);
  assert.ok(pts.length > 0 && pts.some((p) => !p.sufficient));
  const wr = D.winrateRows(summary.cards);
  const firstInsufficient = wr.findIndex((c) => c.winrate_status === 'insufficient');
  if (firstInsufficient >= 0) assert.ok(wr.slice(firstInsufficient).every((c) => c.winrate_status === 'insufficient'));
  const sorted = D.sortRows(summary.cards, 'avg_copies', 'ascending');
  const vals = sorted.map((c) => c.avg_copies);
  const known = vals.filter((v) => v !== null);
  assert.deepEqual(known, [...known].sort((a, b) => a - b));
  assert.ok(vals.indexOf(null) === -1 || vals.slice(vals.indexOf(null)).every((v) => v === null)); // nulls last
});

test('ban list options: all first, then newest first', () => {
  const m = { restrictions: [
    { id: 'all', name: 'All', date_start: null },
    { id: 'old', name: 'Old', date_start: '2025-03-01' },
    { id: 'new', name: 'New', date_start: '2026-08-01' },
    { id: 'mid', name: 'Mid', date_start: '2026-01-15' },
  ] };
  assert.deepEqual(D.banlistOptions(m).map((r) => r.id), ['all', 'new', 'mid', 'old']);
  assert.equal(D.banlistOptions(manifest)[0].id, 'all');
  assert.equal(m.restrictions[1].id, 'old'); // the manifest itself is not reordered
});

test('included tournaments: period, top-cut filter, totals and format', () => {
  const list = [
    { date: '2026-09-12', cut_size: 8, players: 63, decklists: 44, swiss_format: 'single_sided' },
    { date: '2026-08-02', cut_size: 0, players: 10, decklists: 4, swiss_format: 'double_sided' },
    { date: '2026-06-30', cut_size: 16, players: 90, decklists: 60, swiss_format: null },
  ];
  assert.equal(D.eventsInView(list, { from: '2026-08', to: '2026-09' }).length, 2);
  assert.deepEqual(D.eventsInView(list, { from: '2026-08', to: '2026-09' }, true).map((t) => t.players), [63]);
  const tot = D.eventTotals(D.eventsInView(list, null));
  assert.deepEqual([tot.events, tot.players, tot.decks, tot.decklists], [3, 163, 326, 108]);
  close(tot.share, 108 / 326, 1e-12, 'share');
  assert.equal(D.eventTotals([]).share, null);
  assert.deepEqual(list.map(D.eventFormat), ['Single-sided swiss, top 8', 'Double-sided swiss, no cut', 'Top 16']);
  const pub = slice('tournaments', { side: 'corp', restriction: 'all', tier: 'all' });
  assert.ok(pub.tournaments.length > 0 && pub.tournaments.every((t) => t.decklists <= 2 * t.players));
});

test('scatter name filter and top points per axis', () => {
  const pts = [
    { card_id: 'a', x: 50, y: -1, games: 90 }, { card_id: 'b', x: 40, y: 8, games: 60 },
    { card_id: 'c', x: 5, y: 12, games: 40 }, { card_id: 'd', x: 3, y: -9, games: 35 },
  ];
  const titles = { a: 'Hedge Fund', b: 'Hédge Hog', c: 'Snare!', d: 'IPO' };
  assert.deepEqual(D.filterByName(pts, 'hedge', (id) => titles[id]).map((p) => p.card_id), ['a', 'b']);
  assert.equal(D.filterByName(pts, '  ', (id) => titles[id]).length, 4);
  // top 1 by inclusion (a) plus top 1 by winrate difference (c), in the original order
  assert.deepEqual(D.topPerAxis(pts, 1).map((p) => p.card_id), ['a', 'c']);
  assert.deepEqual(D.topPerAxis(pts, 2).map((p) => p.card_id), ['a', 'b', 'c']);
});

test('catalog search, factions and types', () => {
  const catalog = load(`/snap/${manifest.base_path}${manifest.paths.catalog}`);
  const hits = D.searchCards(catalog, 'hedge');
  assert.equal(hits[0].id, 'hedge_fund');
  assert.equal(D.searchCards(catalog, '').length, 0);
  assert.ok(D.searchCards(catalog, 'a', { side: 'runner', limit: 5 }).every((c) => c.side === 'runner'));
  assert.deepEqual(D.faction('haas_bioroid'), { className: 'hb', name: 'Haas-Bioroid' });
  assert.deepEqual(D.faction('neutral_corp'), { className: '', name: 'Neutral' });
  assert.equal(D.typeName('ice'), 'Ice');
  const idx = D.catalogIndex(catalog);
  const summary = slice('summary', { side: 'runner', restriction: 'all', tier: 'all' });
  assert.ok(summary.cards.every((c) => idx.has(c.card_id)));
});

test('ban periods: a list covers its months until the next list; neighbours merge; clipped to the chart', () => {
  const m = { restrictions: [
    { id: 'all', name: 'All', date_start: null },
    { id: 'b', name: 'B', date_start: '2025-10-03' },
    { id: 'a', name: 'A', date_start: '2025-08-01' },
    { id: 'c', name: 'C', date_start: '2025-12-01' },
    { id: 'd', name: 'D', date_start: '2026-03-13' },
  ] };
  const months = ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04'];
  assert.deepEqual(D.banPeriods(m, { banned_in: ['a', 'b'] }, months), [{ from: '2025-09', to: '2025-11', names: ['A', 'B'] }]);
  assert.deepEqual(D.banPeriods(m, { banned_in: ['b', 'd'] }, months), [
    { from: '2025-10', to: '2025-11', names: ['B'] }, { from: '2026-03', to: '2026-04', names: ['D'] }]);
  assert.deepEqual(D.banPeriods(m, { banned_in: [] }, months), []);
  assert.deepEqual(D.banPeriods(m, { legal_in: ['a'] }, months), []); // catalog from before banned_in
  assert.deepEqual(D.banPeriods(m, { banned_in: ['a'] }, ['2026-01']), []); // outside the chart
});

// ---------------------------------------------------------------- in and out of faction

const counts = (decks, inFaction) => ({ decks_with_card: decks, decks_in_faction: inFaction });
const BASE = { side_decks: 10 };
const FB = { haas_bioroid: 4, jinteki: 6 };
const HB_ICE = { faction: 'haas_bioroid', type: 'ice' };
const fm = (c, card = HB_ICE, opts = {}) => D.factionMetrics(c, BASE, opts.fb === undefined ? FB : opts.fb,
  opts.prev ?? null, opts.prevBase ?? null, opts.prevFb ?? null, card, opts.t ?? { min_splash_decks: 20 });
const allNull = Object.fromEntries(D.FACTION_FIELDS.map((k) => [k, null]));

test('factionScope: a faction card has both figures', () => {
  assert.deepEqual(D.factionScope(HB_ICE), { inF: true, outF: true });
});

test('factionScope: a neutral card has neither', () => {
  assert.deepEqual(D.factionScope({ faction: 'neutral_runner', type: 'event' }), { inF: false, outF: false });
});

test('factionScope: an identity has neither', () => {
  assert.deepEqual(D.factionScope({ faction: 'jinteki', type: 'corp_identity' }), { inF: false, outF: false });
});

test('factionScope: an agenda has in-faction figures only', () => {
  assert.deepEqual(D.factionScope({ faction: 'jinteki', type: 'agenda' }), { inF: true, outF: false });
});

test('factionScope: a card missing from the catalog has neither', () => {
  assert.deepEqual(D.factionScope(undefined), { inF: false, outF: false });
});

test('factionMetrics: in-faction popularity divides by the decks of the card\'s faction', () => {
  assert.equal(fm(counts(3, 2)).popularity_in, 0.5);
});

test('factionMetrics: out-of-faction popularity divides by the decks of other factions', () => {
  assert.equal(fm(counts(3, 2)).popularity_out, 1 / 6);
});

test('factionMetrics: splash share divides by the decks with the card', () => {
  assert.equal(fm(counts(4, 1)).splash_share, 0.75);
});

test('factionMetrics: a neutral card has every figure null', () => {
  assert.deepEqual(fm(counts(3, 3), { faction: 'neutral_corp', type: 'ice' }), allNull);
});

test('factionMetrics: an older snapshot without decks per faction gives null, not 0%', () => {
  assert.deepEqual(fm(counts(3, 2), HB_ICE, { fb: null }), allNull);
});

test('factionMetrics: no decks of the card\'s faction gives no in-faction popularity', () => {
  const m = fm(counts(2, 0), { faction: 'nbn', type: 'ice' });
  assert.deepEqual([m.popularity_in, m.popularity_out], [null, 0.2]);
});

test('factionMetrics: no decks of other factions gives no out-of-faction popularity', () => {
  const m = fm(counts(2, 2), HB_ICE, { fb: { haas_bioroid: 10 } });
  assert.deepEqual([m.popularity_in, m.popularity_out], [0.2, null]);
});

for (const [decks, status] of [[19, 'insufficient'], [20, 'ok'], [21, 'ok']]) {
  test(`factionMetrics: splash status at ${decks} decks with a minimum of 20 is ${status}`, () => {
    assert.equal(fm(counts(decks, 0)).splash_status, status);
  });
}

test('factionMetrics: a manifest without min_splash_decks uses 20', () => {
  assert.equal(fm(counts(19, 0), HB_ICE, { t: {} }).splash_status, 'insufficient');
  assert.equal(fm(counts(20, 0), HB_ICE, { t: {} }).splash_status, 'ok');
});

test('factionMetrics: change compares with the previous period', () => {
  const m = fm(counts(4, 2), HB_ICE, { prev: counts(2, 2), prevBase: { side_decks: 8 }, prevFb: { haas_bioroid: 4, jinteki: 4 } });
  assert.deepEqual([m.prev_popularity_in, m.change_in_pp], [0.5, 0]);
  close(m.change_out_pp, (2 / 6) * 100, 1e-9, 'out');
  assert.deepEqual([m.prev_splash_share, m.change_splash_pp], [0, 50]);
});

test('summarize without the catalog leaves the faction figures null', () => {
  const s = { side: 'corp', restriction: 'all', tier: 'all' };
  const summary = slice('summary', s);
  const mine = D.summarize(slice('trends', s), summary.period, T);
  assert.ok(mine.cards.every((c) => c.popularity_in === null && c.splash_share === null));
});

test('sumFactions of an older trends file is null', () => {
  const t = slice('trends', { side: 'corp', restriction: 'all', tier: 'all' });
  const { faction_baseline: _, ...old } = t;
  assert.equal(D.sumFactions(old, null), null);
});

test('decks per faction add up to the side\'s decks in every month', () => {
  const t = slice('trends', { side: 'runner', restriction: 'all', tier: 'all' });
  for (const m of t.months) {
    const r = { from: m, to: m };
    const fb = D.sumFactions(t, r);
    assert.equal(Object.values(fb).reduce((a, b) => a + b, 0), D.sumBaseline(t, r).side_decks, m);
  }
});

test('monthlySeries: in- and out-of-faction inclusion per month for a faction card', () => {
  const t = slice('trends', { side: 'runner', restriction: 'all', tier: 'all' });
  const card = catalogIdx.get('umbrella');
  for (const p of D.monthlySeries(t, 'umbrella', null, 'all', card)) {
    const r = { from: p.month, to: p.month };
    const m = D.factionMetrics(D.sumCard(t, 'umbrella', r), D.sumBaseline(t, r), D.sumFactions(t, r), null, null, null, card, T);
    close(p.popularity_in, m.popularity_in, 1e-12, `in ${p.month}`);
    close(p.popularity_out, m.popularity_out, 1e-12, `out ${p.month}`);
  }
});

test('monthlySeries: a neutral card has no in- or out-of-faction series', () => {
  const t = slice('trends', { side: 'corp', restriction: 'all', tier: 'all' });
  const series = D.monthlySeries(t, 'hedge_fund', null, 'all', catalogIdx.get('hedge_fund'));
  assert.ok(series.every((p) => p.popularity_in === null && p.popularity_out === null));
});

test('monthlySeries: an agenda has an in-faction series only', () => {
  const t = slice('trends', { side: 'corp', restriction: 'all', tier: 'all' });
  const series = D.monthlySeries(t, 'megaprix_qualifier', null, 'all', catalogIdx.get('megaprix_qualifier'));
  assert.ok(series.some((p) => p.popularity_in > 0) && series.every((p) => p.popularity_out === null));
});

// The most played cards table in each view.
const row = (id, o) => ({ card_id: id, decks: 0, popularity: 0, change_pp: null, decks_in_faction: null, popularity_in: null,
  change_in_pp: null, popularity_out: null, change_out_pp: null, splash_share: null, change_splash_pp: null, splash_status: null, ...o });
const ROWS = [
  row('neutral', { decks: 9, popularity: 0.9, change_pp: 1 }),
  row('agenda', { decks: 4, popularity: 0.4, decks_in_faction: 4, popularity_in: 0.8 }),
  row('splashed', { decks: 30, popularity: 0.3, decks_in_faction: 10, popularity_in: 0.2, popularity_out: 0.5, splash_share: 2 / 3, splash_status: 'ok', change_out_pp: 4 }),
  row('home', { decks: 20, popularity: 0.2, decks_in_faction: 20, popularity_in: 0.9, popularity_out: 0, splash_share: 0, splash_status: 'ok' }),
  row('rare', { decks: 3, popularity: 0.03, decks_in_faction: 0, popularity_in: 0, popularity_out: 0.05, splash_share: 1, splash_status: 'insufficient' }),
  row('gone', { decks: 0, popularity: 0, decks_in_faction: 0, popularity_in: 0, popularity_out: 0, splash_share: null }),
];
const ids = (rows) => rows.map((r) => r.card_id);

test('playedRows: all decks ranks every played card by inclusion', () => {
  assert.deepEqual(ids(D.playedRows(ROWS, 'all')), ['neutral', 'agenda', 'splashed', 'home', 'rare']);
});

test('playedRows: in faction lists cards some deck of their faction plays', () => {
  assert.deepEqual(ids(D.playedRows(ROWS, 'in')), ['home', 'agenda', 'splashed']);
});

test('playedRows: out of faction lists cards another faction splashes', () => {
  const rows = D.playedRows(ROWS, 'out');
  assert.deepEqual(ids(rows), ['splashed', 'rare']);
  assert.deepEqual([rows[0].value, rows[0].change, rows[0].mode_rank], [0.5, 4, 1]);
});

test('playedRows: splash share hides cards under the minimum decks unless asked', () => {
  assert.deepEqual(ids(D.playedRows(ROWS, 'splash')), ['splashed', 'home']);
  assert.deepEqual(ids(D.playedRows(ROWS, 'splash', { hideSmall: false })), ['rare', 'splashed', 'home']);
});

test('playedRows: ties go to more decks, then the card id', () => {
  const tied = [row('b', { decks: 5, popularity: 0.5 }), row('c', { decks: 9, popularity: 0.5 }), row('a', { decks: 5, popularity: 0.5 })];
  assert.deepEqual(ids(D.playedRows(tied, 'all')), ['c', 'a', 'b']);
});

test('playedRows: an unknown view lists all decks', () => {
  assert.deepEqual(ids(D.playedRows(ROWS, 'nope')), ids(D.playedRows(ROWS, 'all')));
});

test('playedCount: the decks behind each view', () => {
  const baseline = { decks: 100, faction_decks: { haas_bioroid: 40, jinteki: 60 } };
  const r = { decks: 30, decks_in_faction: 10 };
  assert.deepEqual(D.playedCount(r, 'all', baseline, HB_ICE), [30, 100]);
  assert.deepEqual(D.playedCount(r, 'in', baseline, HB_ICE), [10, 40]);
  assert.deepEqual(D.playedCount(r, 'out', baseline, HB_ICE), [20, 60]);
  assert.deepEqual(D.playedCount(r, 'splash', baseline, HB_ICE), [20, 30]);
});
