// Market Research data module. All arithmetic for the page lives here: slice paths, filter
// state, summing additive counts over months, ban lists and tier groups, ratios, baseline
// differences, Wilson intervals and minimum samples. Rendering code only formats and draws.
// No DOM access, so it runs under `node --test` against the pipeline's golden snapshot.

export const DEFAULT_DATA_BASE = 'https://data.jinteki.win/';
export const Z95 = 1.959963984540054;
export const SIDES = ['corp', 'runner'];
export const CARD_COLUMNS = [
  'decks_with_card', 'copies_sum', 'qty1', 'qty2', 'qty3', 'games_total', 'games_won',
  'entries_with_card_hc', 'cut_with_card_hc', 'tournaments_hc_with_card',
];
export const BASELINE_COLUMNS = [
  'side_decks', 'side_games', 'side_wins', 'side_entries_hc', 'side_cut_hc', 'tournaments', 'tournaments_hc',
  'side_games_all', 'side_wins_all',
];

const MONTH = /^\d{4}-\d{2}$/;
const ID = /^[a-z0-9_]{1,80}$/;

// ---------------------------------------------------------------- paths

/** Builds a slice URL from the manifest alone. */
export function sliceUrl(base, manifest, kind, { side = 'corp', restriction = 'all', tier = 'all' } = {}) {
  const template = manifest.paths[kind];
  if (!template) throw new Error(`unknown slice kind ${kind}`);
  if (!SIDES.includes(side) || !isId(restriction) || !isId(tier)) throw new Error('invalid slice');
  const path = template
    .replace('{side}', side)
    .replace('{restriction}', restriction)
    .replace('{tier_group}', tier);
  return joinUrl(base, manifest.base_path + path);
}

export function joinUrl(base, path) {
  return base.endsWith('/') ? base + path : `${base}/${path}`;
}

/** Only the production host, or a same-origin path for local previews, may serve data. */
export function dataBase(search) {
  const q = new URLSearchParams(search || '');
  const v = q.get('data');
  if (v && /^\/(?!\/)[A-Za-z0-9._\-/]*$/.test(v)) return v.endsWith('/') ? v : `${v}/`;
  return DEFAULT_DATA_BASE;
}

function isId(v) {
  return typeof v === 'string' && (v === 'all' || ID.test(v));
}

// ---------------------------------------------------------------- months

export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export function monthSpan(from, to) {
  const out = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** The same number of months immediately before [from, to]. */
export function previousRange(from, to) {
  const n = monthSpan(from, to).length;
  return { from: addMonths(from, -n), to: addMonths(from, -1) };
}

/** The default period: the manifest's last `period_months` months. */
export function defaultPeriod(manifest) {
  const months = manifest.months || [];
  if (!months.length) return null;
  const to = months[months.length - 1];
  const from = addMonths(to, -((manifest.period_months || 3) - 1));
  return { from: from < months[0] ? months[0] : from, to };
}

// ---------------------------------------------------------------- filter state in the URL hash

/** `#<restriction>/<tier>/<from>..<to>/<side>`; invalid parts fall back to defaults. */
export function parseHash(hash, manifest) {
  const parts = String(hash || '').replace(/^#/, '').split('/');
  const restrictions = manifest.restrictions.map((r) => r.id);
  const tiers = manifest.tier_groups.map((t) => t.id);
  const def = defaultPeriod(manifest);
  const state = { restriction: 'all', tier: 'all', from: def?.from ?? null, to: def?.to ?? null, side: 'corp', custom: false };
  if (restrictions.includes(parts[0])) state.restriction = parts[0];
  if (tiers.includes(parts[1])) state.tier = parts[1];
  const m = /^(\d{4}-\d{2})\.\.(\d{4}-\d{2})$/.exec(parts[2] || '');
  if (m && MONTH.test(m[1]) && MONTH.test(m[2]) && m[1] <= m[2] && manifest.months.length) {
    const lo = manifest.months[0];
    const hi = manifest.months[manifest.months.length - 1];
    if (m[2] >= lo && m[1] <= hi) {
      state.from = m[1] < lo ? lo : m[1];
      state.to = m[2] > hi ? hi : m[2];
      state.custom = true;
    }
  }
  if (SIDES.includes(parts[3])) state.side = parts[3];
  return state;
}

export function formatHash(state) {
  const period = state.from && state.to ? `${state.from}..${state.to}` : '';
  return `#${state.restriction}/${state.tier}/${period}/${state.side}`;
}

// ---------------------------------------------------------------- summing additive counts

/** Merges several trends files (e.g. tier groups) of the same side into one by summing rows. */
export function mergeTrends(list) {
  if (list.length === 1) return list[0];
  const months = [...new Set(list.flatMap((t) => t.months))].sort();
  const restrictions = [...new Set(list.flatMap((t) => t.restrictions))];
  const key = (t, row) => `${months.indexOf(t.months[row[0]])}|${restrictions.indexOf(t.restrictions[row[1]])}`;
  const add = (acc, t, row) => {
    const k = key(t, row);
    const cur = acc.get(k) || [months.indexOf(t.months[row[0]]), restrictions.indexOf(t.restrictions[row[1]]), ...row.slice(2).map(() => 0)];
    for (let i = 2; i < row.length; i++) cur[i] += row[i];
    acc.set(k, cur);
  };
  const base = new Map();
  const cards = new Map();
  for (const t of list) {
    for (const row of t.baseline) add(base, t, row);
    for (const [cid, rows] of Object.entries(t.cards)) {
      if (!cards.has(cid)) cards.set(cid, new Map());
      for (const row of rows) add(cards.get(cid), t, row);
    }
  }
  const sorted = (m) => [...m.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return {
    ...list[0],
    tier_group: 'merged',
    months,
    restrictions,
    baseline: sorted(base),
    cards: Object.fromEntries([...cards.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([c, m]) => [c, sorted(m)])),
  };
}

function monthFilter(trends, range, restriction) {
  const lo = range?.from ?? '0000-00';
  const hi = range?.to ?? '9999-99';
  const rIdx = restriction && restriction !== 'all' ? trends.restrictions.indexOf(restriction) : -1;
  return (row) => {
    const m = trends.months[row[0]];
    return m >= lo && m <= hi && (rIdx < 0 || row[1] === rIdx);
  };
}

function sumInto(names, rows, keep) {
  const acc = Object.fromEntries(names.map((n) => [n, 0]));
  for (const row of rows) {
    if (!keep(row)) continue;
    names.forEach((n, i) => { acc[n] += row[i + 2] ?? 0; }); // older snapshots lack newer columns
  }
  return acc;
}

/** Sums the baseline over a month range (and optionally one ban list). */
export function sumBaseline(trends, range, restriction) {
  return sumInto(BASELINE_COLUMNS, trends.baseline, monthFilter(trends, range, restriction));
}

/** Sums one card's counts over a month range. */
export function sumCard(trends, cardId, range, restriction) {
  return sumInto(CARD_COLUMNS, trends.cards[cardId] || [], monthFilter(trends, range, restriction));
}

// ---------------------------------------------------------------- ratios

export function ratio(a, b) {
  return b ? a / b : null;
}

export function wilson(wins, n, z = Z95) {
  if (!(n > 0)) return null;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/** Metrics for one card from summed counts, as in the pipeline's summary.json. */
export function cardMetrics(c, base, prev, prevBase, thresholds) {
  const pop = ratio(c.decks_with_card, base.side_decks);
  let prevPop = null;
  if (prev && prevBase && prevBase.side_decks) prevPop = ratio(prev.decks_with_card, prevBase.side_decks);
  const baseWr = ratio(base.side_wins, base.side_games);
  const wr = ratio(c.games_won, c.games_total);
  const ci = wilson(c.games_won, c.games_total);
  const conv = ratio(c.cut_with_card_hc, c.entries_with_card_hc);
  const baseConv = ratio(base.side_cut_hc, base.side_entries_hc);
  const qty = [c.qty1, c.qty2, c.qty3];
  let mode = null;
  if (c.decks_with_card) mode = qty.indexOf(Math.max(...qty)) + 1;
  return {
    decks: c.decks_with_card,
    popularity: pop,
    avg_copies: ratio(c.copies_sum, c.decks_with_card),
    copies_mode: mode,
    prev_popularity: prevPop,
    change_pp: pop !== null && prevPop !== null ? (pop - prevPop) * 100 : null,
    games: c.games_total,
    wins: c.games_won,
    winrate: wr,
    winrate_diff_pp: wr !== null && baseWr !== null ? (wr - baseWr) * 100 : null,
    wilson_low_pp: ci && baseWr !== null ? (ci[0] - baseWr) * 100 : null,
    wilson_high_pp: ci && baseWr !== null ? (ci[1] - baseWr) * 100 : null,
    winrate_status: c.games_total >= thresholds.min_games ? 'ok' : 'insufficient',
    entries_hc: c.entries_with_card_hc,
    cut_hc: c.cut_with_card_hc,
    tournaments_hc: c.tournaments_hc_with_card,
    conversion: conv,
    conversion_ratio: conv !== null && baseConv ? conv / baseConv : null,
    conversion_diff_pp: conv !== null && baseConv !== null ? (conv - baseConv) * 100 : null,
    conversion_status: c.entries_with_card_hc >= thresholds.min_entries ? 'ok' : 'insufficient',
  };
}

export function baselineView(b) {
  return {
    decks: b.side_decks,
    games: b.side_games,
    wins: b.side_wins,
    winrate: ratio(b.side_wins, b.side_games),
    entries_hc: b.side_entries_hc,
    cut_hc: b.side_cut_hc,
    cut_rate: ratio(b.side_cut_hc, b.side_entries_hc),
    tournaments: b.tournaments,
    tournaments_hc: b.tournaments_hc,
    // Every game, deck known or not: the headline side winrate. games/winrate above count only
    // games where this side's deck is known, which is the baseline cards are compared with.
    games_all: b.side_games_all,
    wins_all: b.side_wins_all,
    winrate_all: ratio(b.side_wins_all, b.side_games_all),
  };
}

/** A summary (like summary.json) for any month range, computed from trends. */
export function summarize(trends, range, thresholds, restriction = 'all') {
  const prevRange = previousRange(range.from, range.to);
  const base = sumBaseline(trends, range, restriction);
  const prevBase = sumBaseline(trends, prevRange, restriction);
  const hasPrev = prevBase.side_decks > 0;
  const cards = [];
  for (const cid of Object.keys(trends.cards)) {
    const cur = sumCard(trends, cid, range, restriction);
    const prev = hasPrev ? sumCard(trends, cid, prevRange, restriction) : null;
    if (!cur.decks_with_card && !(prev && prev.decks_with_card)) continue;
    cards.push({ card_id: cid, ...cardMetrics(cur, base, prev, hasPrev ? prevBase : null, thresholds) });
  }
  rankCards(cards);
  return {
    period: range,
    previous_period: hasPrev ? prevRange : null,
    baseline: baselineView(base),
    cards,
    ...movers(cards),
  };
}

export function rankCards(cards) {
  cards.sort((a, b) => b.decks - a.decks || (a.card_id < b.card_id ? -1 : 1));
  cards.forEach((c, i) => { c.rank = c.decks > 0 ? i + 1 : null; });
  return cards;
}

export function movers(cards, n = 10) {
  const moving = cards.filter((c) => c.change_pp !== null);
  const risers = moving.filter((c) => c.change_pp > 0).sort((a, b) => b.change_pp - a.change_pp || (a.card_id < b.card_id ? -1 : 1));
  const fallers = moving.filter((c) => c.change_pp < 0).sort((a, b) => a.change_pp - b.change_pp || (a.card_id < b.card_id ? -1 : 1));
  return { risers: risers.slice(0, n).map((c) => c.card_id), fallers: fallers.slice(0, n).map((c) => c.card_id) };
}

// ---------------------------------------------------------------- series and views

/** Monthly inclusion for one card: [{ month, popularity, decks, total }]. */
export function monthlySeries(trends, cardId, range, restriction = 'all') {
  const months = trends.months.filter((m) => (!range || (m >= range.from && m <= range.to)));
  return months.map((m) => {
    const r = { from: m, to: m };
    const c = sumCard(trends, cardId, r, restriction);
    const b = sumBaseline(trends, r, restriction);
    return { month: m, popularity: ratio(c.decks_with_card, b.side_decks), decks: c.decks_with_card, total: b.side_decks };
  });
}

/** Months in which a ban list came into force (for chart markers). */
export function banlistMarkers(manifest, months) {
  const out = [];
  for (const r of manifest.restrictions) {
    if (r.id === 'all' || !r.date_start) continue;
    const m = r.date_start.slice(0, 7);
    if (months.includes(m)) out.push({ month: m, id: r.id, name: r.name, date: r.date_start });
  }
  return out;
}

/** Winrate table order: sufficient samples first by difference, insufficient rows last. */
export function winrateRows(cards) {
  return cards
    .filter((c) => c.games > 0)
    .sort((a, b) => (a.winrate_status === b.winrate_status ? 0 : a.winrate_status === 'ok' ? -1 : 1)
      || (b.winrate_diff_pp ?? -1e9) - (a.winrate_diff_pp ?? -1e9) || b.games - a.games);
}

export function conversionRows(cards) {
  return cards
    .filter((c) => c.entries_hc > 0)
    .sort((a, b) => (a.conversion_status === b.conversion_status ? 0 : a.conversion_status === 'ok' ? -1 : 1)
      || (b.conversion_diff_pp ?? -1e9) - (a.conversion_diff_pp ?? -1e9) || b.entries_hc - a.entries_hc);
}

/** Points for the popularity-vs-winrate scatter. */
export function scatterPoints(cards) {
  return cards
    .filter((c) => c.decks > 0 && c.winrate_diff_pp !== null)
    .map((c) => ({
      card_id: c.card_id,
      x: c.popularity * 100,
      y: c.winrate_diff_pp,
      games: c.games,
      sufficient: c.winrate_status === 'ok',
    }));
}

/** Generic sort for table columns; nulls always last. */
export function sortRows(rows, key, dir = 'descending', text = (r) => r[key]) {
  const mult = dir === 'ascending' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = text(a);
    const y = text(b);
    if (x === null || x === undefined) return 1;
    if (y === null || y === undefined) return -1;
    if (typeof x === 'string') return mult * x.localeCompare(y);
    return mult * (x - y);
  });
}

// ---------------------------------------------------------------- catalog

export function catalogIndex(catalog) {
  const byId = new Map();
  for (const c of catalog.cards) byId.set(c.id, c);
  return byId;
}

function fold(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Autocomplete over catalog titles: prefix matches first, then word and substring matches. */
export function searchCards(catalog, query, { side = null, limit = 8 } = {}) {
  const q = fold(String(query || '').trim());
  if (!q) return [];
  const scored = [];
  for (const c of catalog.cards) {
    if (side && c.side !== side) continue;
    const t = fold(c.title);
    let score = -1;
    if (t.startsWith(q)) score = 0;
    else if (t.split(/[\s:.-]+/).some((w) => w.startsWith(q))) score = 1;
    else if (t.includes(q)) score = 2;
    if (score >= 0) scored.push([score, c.title, c]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
  return scored.slice(0, limit).map((x) => x[2]);
}

const FACTION_CLASS = {
  haas_bioroid: 'hb', jinteki: 'jinteki', nbn: 'nbn', weyland_consortium: 'weyland',
  anarch: 'anarch', criminal: 'criminal', shaper: 'shaper',
};
const FACTION_NAME = {
  haas_bioroid: 'Haas-Bioroid', jinteki: 'Jinteki', nbn: 'NBN', weyland_consortium: 'Weyland',
  anarch: 'Anarch', criminal: 'Criminal', shaper: 'Shaper', neutral_corp: 'Neutral', neutral_runner: 'Neutral',
  adam: 'Adam', apex: 'Apex', sunny_lebeau: 'Sunny Lebeau',
};

export function faction(factionId) {
  return { className: FACTION_CLASS[factionId] || '', name: FACTION_NAME[factionId] || 'Neutral' };
}

const TYPE_NAME = {
  agenda: 'Agenda', asset: 'Asset', upgrade: 'Upgrade', operation: 'Operation', ice: 'Ice',
  event: 'Event', hardware: 'Hardware', resource: 'Resource', program: 'Program',
  corp_identity: 'Identity', runner_identity: 'Identity',
};

export function typeName(typeId) {
  return TYPE_NAME[typeId] || typeId;
}
