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
        for (const kind of ['summary', 'trends', 'identities', 'summary_cut', 'trends_cut']) {
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
        const mine = D.summarize(trends, summary.period, T);
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
