// Market Research page: fetches the manifest, builds slice paths from it and renders panels.
// All arithmetic is in data.js; this module only formats and draws. Every value is written with
// textContent (never innerHTML), even though snapshots carry no free text.
import * as D from './data.js';

const JW = window.JW;
const SVGNS = 'http://www.w3.org/2000/svg';
const TABLE_ROWS = 25;
const MAX_TREND_CARDS = 6;
const LAST_SEEN_KEY = 'mr-last-generated';

const $ = (id) => document.getElementById(id);
const base = D.dataBase(location.search);
const cache = new Map();

let manifest = null;
let catalog = null;
let cards = new Map();
let state = null;
let view = null; // current summary (from summary.json or recomputed from trends)
let identities = null;
let events = null; // the included tournaments of the current ban list and tier
let trendCards = []; // [{ id, slot }] – colour slots stay with the card
let detailCard = null;
let sideToggle = null;
// Per-panel "Hide small samples" switches (cards under the minimum games); on by default.
const hideSmall = { winrate: true, scatter: true };
const scatterView = { query: '', top: false };
const SCATTER_TOP = 10;

// ---------------------------------------------------------------- DOM helpers

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style') setStyle(n, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    n.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return n;
}

// The page's CSP forbids style attributes; the CSSOM is allowed.
function setStyle(n, css) {
  for (const decl of String(css).split(';')) {
    const i = decl.indexOf(':');
    if (i > 0) n.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
  }
}

function svg(tag, attrs = {}, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) n.setAttribute(k, String(v));
  if (text !== undefined) n.textContent = text;
  return n;
}

// ---------------------------------------------------------------- formatting

const nf = new Intl.NumberFormat('en-GB');
const MINUS = '−';
const fmtInt = (v) => (v === null || v === undefined ? '–' : nf.format(v));
const fmtN = (v) => `n=${fmtInt(v)}`;
const fmtPct = (v, d = 1) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(d)}%`);
const sign = (v, d) => (v > 0 ? '+' : v < 0 ? MINUS : '±') + Math.abs(v).toFixed(d);
const fmtPp = (v, d = 1) => (v === null || v === undefined ? '–' : `${sign(v, d)} pp`);
const fmtRatio = (v) => (v === null || v === undefined ? '–' : `${v.toFixed(2)}×`);
const fmtNum = (v, d = 2) => (v === null || v === undefined ? '–' : v.toFixed(d));
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const shortMonth = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });

function changeCell(v) {
  if (v === null || v === undefined) return el('td', { class: 'num', text: '–' });
  const arrow = v > 0 ? '▲ ' : v < 0 ? '▼ ' : '';
  return el('td', { class: `num ${v > 0 ? 'pos' : v < 0 ? 'neg' : ''}`, text: arrow + fmtPp(v) });
}

function diffCell(v, insufficient) {
  const cls = insufficient ? '' : v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  return el('td', { class: `num ${cls}`, text: fmtPp(v) });
}

function cardName(id) {
  const c = cards.get(id);
  return c ? c.title : id;
}

function cardCell(id) {
  const c = cards.get(id);
  const f = D.faction(c?.faction);
  const btn = el('button', { type: 'button', class: 'mr-link', onclick: () => openDetail(id) }, cardName(id));
  return el('td', { class: 'card' }, btn, ' ', el('span', { class: `faction ${f.className}`, text: f.name }));
}

// ---------------------------------------------------------------- loading state

// Panels whose content comes from the card slices; Trends and the card detail load on their own.
const DATA_PANELS = ['stats', 'events', 'played', 'identities', 'scatter', 'winrate'];

/** Blurs the given panels under a spinning wheel (on) or reveals them (off). */
function setBusy(ids, on) {
  for (const id of ids) {
    const n = $(id);
    if (!n) continue;
    if (on && !n.querySelector(':scope > .mr-spinner')) n.append(el('div', { class: 'mr-spinner', 'aria-hidden': 'true' }));
    n.classList.toggle('mr-busy', on);
    n.setAttribute('aria-busy', String(on));
  }
}

/** Empty placeholder tables and charts, shown blurred until the first data arrives. */
function showSkeletons() {
  const skelTable = (cols, rows = 8) => el('div', { class: 'mr-scroll' }, el('table', { class: 'data-table' },
    el('thead', {}, el('tr', {}, ...Array.from({ length: cols }, () => el('th', {}, el('span', { class: 'mr-skel' }))))),
    el('tbody', {}, ...Array.from({ length: rows }, () => el('tr', {}, ...Array.from({ length: cols }, () => el('td', {}, el('span', { class: 'mr-skel' }))))))));
  $('stats').replaceChildren(...Array.from({ length: 5 }, () => el('div', { class: 'stat' },
    el('span', { class: 'num', text: '––' }), el('span', { class: 'label' }, el('span', { class: 'mr-skel' })))));
  $('played-body').replaceChildren(skelTable(7));
  $('identities-body').replaceChildren(skelTable(7));
  $('winrate-body').replaceChildren(skelTable(5));
  $('trend-chart').replaceChildren(el('div', { class: 'mr-skel-chart' }));
  $('scatter-chart').replaceChildren(el('div', { class: 'mr-skel-chart' }));
}

// ---------------------------------------------------------------- data

async function getJson(url) {
  if (!cache.has(url)) {
    cache.set(url, fetch(url, { credentials: 'omit' }).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }));
  }
  try {
    return await cache.get(url);
  } catch (e) {
    cache.delete(url);
    throw e;
  }
}

// Card slices come from the top-cut scope when "Top-cut decks only" is on; identities have none.
const scoped = (kind, s) => (s.cut && (kind === 'summary' || kind === 'trends') ? `${kind}_cut` : kind);
const slice = (kind, s = state) => getJson(D.sliceUrl(base, manifest, scoped(kind, s), { side: s.side, restriction: s.restriction, tier: s.tier }));

async function boot() {
  JW.mountThemeSwitcher($('theme-switcher'));
  JW.mountModeToggle($('mode-toggle'));
  JW.enablePanelCollapse();
  showSkeletons();
  setBusy([...DATA_PANELS, 'trends'], true);
  try {
    manifest = await getJson(D.joinUrl(base, 'manifest.json'));
    catalog = await getJson(D.joinUrl(base, manifest.base_path + manifest.paths.catalog));
  } catch {
    showUnavailable();
    return;
  }
  try { localStorage.setItem(LAST_SEEN_KEY, manifest.data_as_of || manifest.generated_at); } catch { /* ignore */ }
  cards = D.catalogIndex(catalog);
  state = D.parseHash(location.hash, manifest);
  setupFilters();
  setupSearch();
  setupSampleToggle('winrate-small', 'winrate', renderWinrate);
  setupSampleToggle('scatter-small', 'scatter', renderScatter);
  $('scatter-filter').addEventListener('input', debounce(() => { scatterView.query = $('scatter-filter').value; if (view) renderScatter(); }, 150));
  $('scatter-top').addEventListener('click', () => {
    scatterView.top = !scatterView.top;
    $('scatter-top').setAttribute('aria-pressed', String(scatterView.top));
    if (view) renderScatter();
  });
  window.addEventListener('hashchange', () => {
    const next = D.parseHash(location.hash, manifest);
    if (D.formatHash(next) !== D.formatHash(state)) { state = next; syncFilters(); refresh(); }
  });
  document.addEventListener('jw:themechange', () => { drawTrends(); drawScatter(); drawDetailChart(); });
  window.addEventListener('resize', debounce(() => { drawTrends(); drawScatter(); drawDetailChart(); }, 150));
  $('detail-close').addEventListener('click', () => { detailCard = null; $('detail').hidden = true; });
  await refresh();
  loadQuality();
}

/** Replaces the page with a notice when the data can't be loaded, instead of leaving it on placeholders. */
function showUnavailable() {
  let last = null;
  try { last = localStorage.getItem(LAST_SEEN_KEY); } catch { /* storage may be blocked */ }
  $('app').hidden = true;
  $('status').hidden = false;
  $('status').textContent = `Market Research data is unavailable right now.${last ? ` Last updated ${last}.` : ''} Try again later.`;
}

function debounce(fn, ms) {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(fn, ms); };
}

// ---------------------------------------------------------------- filters

function option(value, label, selected) {
  const o = el('option', { value }, label);
  o.selected = selected;
  return o;
}

function setupFilters() {
  sideToggle = JW.mountSideToggle($('side-toggle'), state.side, (side) => { state.side = side; commit(); });
  $('f-restriction').replaceChildren(...D.banlistOptions(manifest).map((r) => option(r.id, r.name, r.id === state.restriction)));
  $('f-tier').replaceChildren(...manifest.tier_groups.map((t) => option(t.id, t.name, t.id === state.tier)));
  for (const id of ['f-from', 'f-to']) {
    $(id).replaceChildren(...manifest.months.map((m) => option(m, monthName(m), false)));
  }
  syncFilters();
  $('f-restriction').addEventListener('change', (e) => { state.restriction = e.target.value; commit(); });
  $('f-tier').addEventListener('change', (e) => { state.tier = e.target.value; commit(); });
  $('f-from').addEventListener('change', (e) => { setPeriod(e.target.value, state.to); });
  $('f-to').addEventListener('change', (e) => { setPeriod(state.from, e.target.value); });
  $('f-reset').addEventListener('click', () => { state = D.parseHash('', manifest); syncFilters(); commit(); });
  $('f-cut-field').hidden = !manifest.paths.summary_cut; // snapshots before the top-cut scope
  $('f-cut').addEventListener('click', () => { state.cut = !state.cut; syncFilters(); commit(); });
}

function setPeriod(from, to) {
  if (from > to) [from, to] = [to, from];
  state.from = from;
  state.to = to;
  state.custom = true;
  syncFilters();
  commit();
}

function syncFilters() {
  $('f-restriction').value = state.restriction;
  $('f-tier').value = state.tier;
  if (state.from) $('f-from').value = state.from;
  if (state.to) $('f-to').value = state.to;
  sideToggle?.set(state.side);
  $('f-cut').setAttribute('aria-pressed', String(!!state.cut));
  $('card-search').placeholder = `Type a ${state.side === 'corp' ? 'Corp' : 'Runner'} card name`;
  document.documentElement.style.setProperty('--mr-side', `var(--${state.side})`);
}

function commit() {
  const h = D.formatHash(state);
  if (location.hash !== h) history.replaceState(null, '', h);
  refresh();
}

// ---------------------------------------------------------------- main refresh

let refreshToken = 0;

async function refresh() {
  const token = ++refreshToken;
  $('status').hidden = true;
  setBusy([...DATA_PANELS, 'trends'], true);
  document.documentElement.style.setProperty('--mr-side', `var(--${state.side})`);
  try {
    const summary = await slice('summary');
    identities = await slice('identities');
    const evs = manifest.paths.tournaments ? await slice('tournaments') : null;
    let v = summary;
    if (state.custom && summary.period && (state.from !== summary.period.from || state.to !== summary.period.to)) {
      const trends = await slice('trends');
      v = D.summarize(trends, { from: state.from, to: state.to }, manifest.thresholds, 'all');
    }
    if (token !== refreshToken) return;
    view = v;
    events = evs;
    if (!state.custom && view.period) { state.from = view.period.from; state.to = view.period.to; syncFilters(); }
    renderAll();
    setBusy(DATA_PANELS, false);
  } catch (e) {
    if (token !== refreshToken) return;
    setBusy([...DATA_PANELS, 'trends'], false);
    $('status').hidden = false;
    $('status').textContent = 'This slice could not be loaded. Try another filter or reload the page.';
  }
}

function renderAll() {
  renderStats();
  renderEvents();
  renderPlayed();
  renderIdentities();
  renderWinrate();
  renderScatter();
  initTrendCards();
  renderTrends();
  if (detailCard) openDetail(detailCard, false);
}

function renderStats() {
  const b = view.baseline;
  const side = state.side === 'corp' ? 'Corp' : 'Runner';
  const who = state.cut ? `top-cut ${side}` : side;
  const stat = (num, label, cls = '') => el('div', { class: `stat ${cls}` }, el('span', { class: 'num', text: num }), el('span', { class: 'label', text: label }));
  $('stats').replaceChildren(
    stat(manifest.data_as_of || '–', 'Data as of'),
    stat(fmtInt(b.tournaments), state.cut ? 'Tournaments with a cut' : 'Tournaments'),
    stat(fmtInt(b.decks), `${who} decks`, state.side),
    stat(b.games_all == null ? fmtInt(b.games) : `${fmtInt(b.games)} / ${fmtInt(b.games_all)}`, `${who} games (with decklists / total)`, state.side),
    stat(fmtPct(b.winrate_all ?? b.winrate), `${who} winrate (all games)`),
  );
  const p = view.period;
  $('period-note').textContent = p
    ? `Showing ${monthName(p.from)} → ${monthName(p.to)}${view.previous_period ? `, compared with ${monthName(view.previous_period.from)} → ${monthName(view.previous_period.to)}` : ''}.${state.cut ? ' Card stats count only decks that made the top cut, in events that had one, and the games they played. Identities always count every entry.' : ''}`
    : 'No Standard tournaments match this filter.';
}

function setupSampleToggle(id, key, render) {
  const btn = $(id);
  btn.addEventListener('click', () => {
    hideSmall[key] = !hideSmall[key];
    btn.setAttribute('aria-pressed', String(hideSmall[key]));
    if (view) render();
  });
}

/** Drops cards below the minimum games when the panel's switch is on. */
const sampled = (key, rows, ok) => (hideSmall[key] ? rows.filter(ok) : rows);

// ---------------------------------------------------------------- column help (header tooltips)

function help() {
  const side = state.side === 'corp' ? 'Corp' : 'Runner';
  const decks = state.cut ? `top-cut ${side} decks (decks that made the cut, in events with a cut)` : `${side} decks`;
  const base = `the winrate of all ${decks} with a known decklist in this filter (${fmtPct(view.baseline.winrate)})`;
  return {
    rank: 'Position by the number of decks playing the card in this period.',
    card: 'Card name and faction. Select it for details and its monthly trend.',
    type: 'Card type.',
    inclusion: `Share of ${decks} with a known decklist in this filter that play at least one copy: decks with the card ÷ all decks.`,
    avgCopies: 'Average number of copies, over the decks that play the card.',
    change: 'Inclusion in this period minus inclusion in the previous period of the same length, in percentage points.',
    decks: `Number of ${decks} with a known decklist that play the card.`,
    winrateDiff: `Winrate of the games played by decks with the card, minus ${base}. Draws count as half a win; intentional draws are excluded.`,
    interval: 'Wilson 95% confidence interval of the card\'s winrate, minus the baseline. When it spans 0, the difference may be chance.',
    winrate: 'Games won ÷ games played by decks with the card. Draws count as half a win.',
    games: 'Games played by decks with the card, where the deck is known.',
    identRank: 'Position by the number of entries.',
    identity: 'Identity name and faction.',
    share: `Share of ${side} entries in this filter (players with a known identity) on this identity.`,
    identWinrate: `Game winrate of players on this identity, minus the winrate of all ${side} players with a known identity. Draws count as half a win.`,
    identGames: 'Games played on this identity.',
    conversion: `Share of entries on this identity that made the top cut, in events with a cut where most identities are known. In brackets: that share ÷ the share for all ${side} entries.`,
    cutEntries: 'Entries on this identity in events with a cut where most identities are known: the sample the conversion is based on.',
  };
}

// ---------------------------------------------------------------- included tournaments

const COBRA_URL = 'https://tournaments.nullsignal.games/tournaments/';
const ABR_URL = 'https://alwaysberunning.net/tournaments/';

function renderEvents() {
  const box = $('events');
  box.hidden = !events;
  if (!events) return;
  const list = D.eventsInView(events.tournaments, trendRange(), state.cut);
  const tot = D.eventTotals(list);
  const banName = new Map(manifest.restrictions.map((r) => [r.id, r.name]));
  $('events-summary').textContent = `Included tournaments (${fmtInt(tot.events)})`;
  $('events-note').textContent = list.length
    ? `${fmtInt(tot.events)} tournaments, ${fmtInt(tot.players)} players: decklists are known for ${fmtInt(tot.decklists)} of ${fmtInt(tot.decks)} decks (${fmtPct(tot.share)}), counting Corp and Runner for each player.${state.cut ? ' Only events with a top cut, as the top-cut switch is on.' : ''}`
    : '';
  const link = (href, id) => el('td', {}, id ? el('a', { href: href + id, rel: 'noopener', target: '_blank' }, `#${id}`) : '–');
  const share = (t) => (t.players ? t.decklists / (2 * t.players) : null);
  dataTable($('events-body'), [
    { key: 'name', label: 'Tournament', help: 'The event\'s public name on Cobra or AlwaysBeRunning.', value: (t) => t.name || '', cell: (t) => el('td', { text: t.name || '–' }) },
    { key: 'date', label: 'Date', help: 'The day the event started.', cell: (t) => el('td', { class: 'num', text: t.date }) },
    { key: 'restriction', label: 'Ban list', help: 'The ban list the event\'s decks were checked against: the organiser\'s, unless the decks clearly fit another one.', value: (t) => banName.get(t.restriction) || t.restriction, cell: (t) => el('td', { text: banName.get(t.restriction) || t.restriction }) },
    { key: 'online', label: 'Location', help: 'Online or in person, with the country when AlwaysBeRunning lists it.', value: (t) => (t.online ? 'Online' : `Offline ${t.country || ''}`), cell: (t) => el('td', { text: t.online ? 'Online' : t.country ? `Offline · ${t.country}` : 'Offline' }) },
    { key: 'players', label: 'Players', num: true, help: 'Players who took part.', cell: (t) => el('td', { class: 'num', text: fmtInt(t.players) }) },
    { key: 'format', label: 'Format', help: 'Swiss rounds (single-sided or double-sided) and the size of the top cut. Events known only from AlwaysBeRunning have no swiss format.', value: (t) => D.eventFormat(t), cell: (t) => el('td', { text: D.eventFormat(t) }) },
    { key: 'decklists', label: 'Decklists', num: true, help: 'Legal decks with a known decklist, out of two per player (Corp and Runner), and that share. Only these decks count in the card statistics.', value: (t) => share(t), cell: (t) => el('td', { class: 'num', text: `${fmtInt(t.decklists)} / ${fmtInt(2 * t.players)} (${fmtPct(share(t), 0)})` }) },
    { key: 'cobra_id', label: 'Cobra', help: 'The event on NSG Cobra.', sortable: false, cell: (t) => link(COBRA_URL, t.cobra_id) },
    { key: 'abr_id', label: 'ABR', help: 'The event on AlwaysBeRunning.net.', sortable: false, cell: (t) => link(ABR_URL, t.abr_id) },
  ], list, { sortKey: 'date', sortDir: 'descending', noun: 'tournaments', empty: 'No tournaments match this filter.' });
}

// ---------------------------------------------------------------- tables

// Tables whose column guide the viewer opened, so it stays open when the table redraws.
const openGuides = new Set();

/** "What do the columns mean?": the header tooltips as a list, for touch screens and screen readers. */
function columnGuide(host, columns) {
  const described = columns.filter((c) => c.help);
  if (!described.length) return null;
  const d = el('details', { class: 'mr-alt mr-guide' }, el('summary', { text: 'What do the columns mean?' }),
    el('dl', {}, ...described.flatMap((c) => [el('dt', { text: c.label }), el('dd', { text: c.help })])));
  d.open = openGuides.has(host.id);
  d.addEventListener('toggle', () => { if (d.open) openGuides.add(host.id); else openGuides.delete(host.id); });
  return d;
}

/** A sortable table with real header buttons and an optional "show all" button. */
function dataTable(host, columns, rows, { initial, sortKey = null, sortDir = 'descending', rowClass = () => '', limit = TABLE_ROWS, empty = 'No cards in this filter.', noun = 'cards' }) {
  let key = sortKey;
  let dir = sortDir;
  let all = false;
  const draw = () => {
    const col = columns.find((c) => c.key === key);
    const sorted = key ? D.sortRows(rows, key, dir, col?.value || ((r) => r[key])) : initial ? initial(rows) : rows;
    const shown = all ? sorted : sorted.slice(0, limit);
    const head = el('tr', {}, ...columns.map((c) => {
      const th = el('th', { class: c.num ? 'num' : '', scope: 'col', 'aria-sort': c.key === key ? dir : null, title: c.help || null });
      if (c.sortable === false) th.textContent = c.label;
      else th.append(el('button', { type: 'button', class: 'mr-sort', onclick: () => {
        if (key === c.key) dir = dir === 'descending' ? 'ascending' : 'descending';
        else { key = c.key; dir = c.num ? 'descending' : 'ascending'; }
        draw();
      } }, c.label));
      return th;
    }));
    const body = shown.map((r) => el('tr', { class: rowClass(r) || null }, ...columns.map((c) => c.cell(r))));
    const table = el('table', { class: 'data-table', style: `--side: var(--${state.side})` }, el('thead', {}, head), el('tbody', {}, ...body));
    const parts = [rows.length ? el('div', { class: 'mr-scroll' }, table) : el('p', { class: 'mr-note', text: empty })];
    if (sorted.length > limit) {
      parts.push(el('button', { type: 'button', class: 'btn secondary mr-more', onclick: () => { all = !all; draw(); } },
        all ? `Show top ${limit}` : `Show all ${fmtInt(sorted.length)} ${noun}`));
    }
    const guide = rows.length ? columnGuide(host, columns) : null;
    if (guide) parts.push(guide);
    host.replaceChildren(...parts);
  };
  draw();
}

function meterCell(v) {
  const pct = v === null ? 0 : Math.max(0, Math.min(100, v * 100));
  return el('td', {}, el('div', { class: 'meter' },
    el('div', { class: 'meter-track' }, el('div', { class: 'meter-fill', style: `width:${pct.toFixed(1)}%` })),
    el('span', { class: 'num', text: fmtPct(v) })));
}

function renderPlayed() {
  const h = help();
  const rows = view.cards.filter((c) => c.decks > 0);
  const emptyPlayed = state.cut ? 'No top-cut decks with known decklists in this filter.' : 'No cards in this filter.';
  dataTable($('played-body'), [
    { key: 'rank', label: 'Rank', num: true, help: h.rank, cell: (r) => el('td', { class: 'num', text: fmtInt(r.rank) }) },
    { key: 'title', label: 'Card', help: h.card, value: (r) => cardName(r.card_id), cell: (r) => cardCell(r.card_id) },
    { key: 'type', label: 'Type', help: h.type, value: (r) => D.typeName(cards.get(r.card_id)?.type), cell: (r) => el('td', { text: D.typeName(cards.get(r.card_id)?.type) }) },
    { key: 'popularity', label: 'Inclusion', num: true, help: h.inclusion, cell: (r) => meterCell(r.popularity) },
    { key: 'avg_copies', label: 'Avg copies', num: true, help: h.avgCopies, cell: (r) => el('td', { class: 'num', text: fmtNum(r.avg_copies) }) },
    { key: 'change_pp', label: 'Change', num: true, help: h.change, cell: (r) => changeCell(r.change_pp) },
    { key: 'decks', label: 'Decks', num: true, help: h.decks, cell: (r) => el('td', { class: 'num', text: fmtN(r.decks) }) },
  ], rows, { sortKey: 'rank', sortDir: 'ascending', empty: emptyPlayed });
}

function renderIdentities() {
  const h = help();
  const list = identities?.identities || [];
  const p = identities?.period;
  $('identities-note').textContent = p
    ? `Share of entries, winrate difference from the ${state.side === 'corp' ? 'Corp' : 'Runner'} baseline and top-cut conversion, ${monthName(p.from)} → ${monthName(p.to)}.${state.custom && view.period && (p.from !== view.period.from || p.to !== view.period.to) ? ' Identities always show the default period.' : ''}`
    : '';
  dataTable($('identities-body'), [
    { key: 'rank', label: 'Rank', num: true, help: h.identRank, cell: (r) => el('td', { class: 'num', text: fmtInt(r.rank) }) },
    { key: 'title', label: 'Identity', help: h.identity, value: (r) => cardName(r.card_id), cell: (r) => cardCell(r.card_id) },
    { key: 'share', label: 'Share', num: true, help: h.share, cell: (r) => meterCell(r.share) },
    { key: 'winrate_diff_pp', label: 'Winrate vs baseline', num: true, help: h.identWinrate, cell: (r) => diffCell(r.winrate_diff_pp, r.winrate_status !== 'ok') },
    { key: 'games', label: 'Games', num: true, help: h.identGames, cell: (r) => el('td', { class: 'num', text: fmtN(r.games) }) },
    { key: 'conversion', label: 'Conversion', num: true, help: h.conversion, cell: (r) => el('td', { class: 'num', text: `${fmtPct(r.conversion)} (${fmtRatio(r.conversion_ratio)})` }) },
    { key: 'cut_entries', label: 'Entries in cut events', num: true, help: h.cutEntries, cell: (r) => el('td', { class: 'num', text: fmtN(r.cut_entries) }) },
  ], list, { sortKey: 'rank', sortDir: 'ascending', rowClass: (r) => (r.winrate_status !== 'ok' ? 'mr-insufficient' : ''), empty: 'No identities in this filter.' });
}

function renderWinrate() {
  const h = help();
  const min = manifest.thresholds.min_games;
  $('winrate-note').textContent = `Game winrate of decks with the card minus the ${state.side === 'corp' ? 'Corp' : 'Runner'} baseline over games with decklists (${fmtPct(view.baseline.winrate)}), with the Wilson 95% interval. Draws count as half a win; intentional draws are excluded. ${hideSmall.winrate ? `Cards under ${min} games are hidden.` : `Rows under ${min} games are greyed and listed last.`}`;
  const rows = sampled('winrate', D.winrateRows(view.cards), (r) => r.winrate_status === 'ok');
  dataTable($('winrate-body'), [
    { key: 'title', label: 'Card', help: h.card, value: (r) => cardName(r.card_id), cell: (r) => cardCell(r.card_id) },
    { key: 'winrate_diff_pp', label: 'Winrate vs baseline', num: true, help: h.winrateDiff, cell: (r) => diffCell(r.winrate_diff_pp, r.winrate_status !== 'ok') },
    { key: 'wilson_low_pp', label: '95% interval', num: true, sortable: false, help: h.interval, cell: (r) => el('td', { class: 'num', text: `${fmtPp(r.wilson_low_pp)} → ${fmtPp(r.wilson_high_pp)}` }) },
    { key: 'winrate', label: 'Winrate', num: true, help: h.winrate, cell: (r) => el('td', { class: 'num', text: fmtPct(r.winrate) }) },
    { key: 'games', label: 'Games', num: true, help: h.games, cell: (r) => el('td', { class: 'num', text: fmtN(r.games) }) },
  ], rows, { rowClass: (r) => (r.winrate_status !== 'ok' ? 'mr-insufficient' : ''), empty: hideSmall.winrate ? `No card has ${min} games with decklists in this filter.` : 'No games with decklists in this filter.' });
}

// ---------------------------------------------------------------- tooltip

function showTip(x, y, lines) {
  const tip = $('tip');
  tip.replaceChildren(...lines.map((l, i) => el('div', { class: i === 0 ? 'mr-tip-title' : '' }, l)));
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 14));
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  tip.style.left = `${left + window.scrollX}px`;
  tip.style.top = `${top + window.scrollY}px`;
}

function hideTip() { $('tip').hidden = true; }

// ---------------------------------------------------------------- charts: shared axes

function chartBox(host, height) {
  const width = Math.max(300, host.clientWidth || 720);
  const m = { l: 44, r: 16, t: 14, b: 30 };
  const s = svg('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' });
  return { s, width, height, m, iw: width - m.l - m.r, ih: height - m.t - m.b };
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((k) => k >= v);
}

// ---------------------------------------------------------------- trends

let trendsData = null;
// The card detail chart's trends: every ban list, whatever the Ban list filter says.
let detailTrends = null;

function initTrendCards() {
  const played = view.cards.filter((c) => c.decks > 0);
  const valid = new Set(played.map((c) => c.card_id));
  trendCards = trendCards.filter((t) => valid.has(t.id));
  if (!trendCards.length) trendCards = played.slice(0, 5).map((c, i) => ({ id: c.card_id, slot: i }));
}

function addTrendCard(id) {
  if (trendCards.some((t) => t.id === id)) return;
  if (trendCards.length >= MAX_TREND_CARDS) trendCards.shift();
  const used = new Set(trendCards.map((t) => t.slot));
  const slot = [0, 1, 2, 3, 4, 5].find((s) => !used.has(s));
  trendCards.push({ id, slot });
  initTrendCards();
  renderTrends();
}

async function renderTrends() {
  const s = { ...state };
  const chips = trendCards.map((t) => el('span', { class: 'badge mr-chip' },
    el('span', { class: 'legend-swatch', style: `background: var(--chart-${t.slot + 1})` }), ' ', cardName(t.id), ' ',
    el('button', { type: 'button', class: 'mr-x', 'aria-label': `Remove ${cardName(t.id)}`, onclick: () => {
      trendCards = trendCards.filter((x) => x.id !== t.id);
      initTrendCards();
      renderTrends();
    } }, '×')));
  $('trend-chips').replaceChildren(...chips);
  $('trend-add').disabled = false;
  setBusy(['trends'], true);
  try {
    const t = await slice('trends', s);
    if (D.formatHash(s) !== D.formatHash(state)) return;
    trendsData = t;
    drawTrends();
    setBusy(['trends'], false);
  } catch {
    if (D.formatHash(s) !== D.formatHash(state)) return;
    setBusy(['trends'], false);
    $('trend-chart').replaceChildren(el('p', { class: 'mr-note', text: 'Trends could not be loaded.' }));
  }
}

function trendRange() {
  return state.from && state.to ? { from: state.from, to: state.to } : null;
}

// Ticks for a value axis: a nice step covering [lo, hi], widened to whole steps.
function niceAxis(lo, hi, ticks = 4) {
  if (hi <= lo) hi = lo + 1;
  const step = niceMax((hi - lo) / ticks);
  return { lo: Math.floor(lo / step + 1e-9) * step, hi: Math.ceil(hi / step - 1e-9) * step, step };
}

// Monthly line chart. Each series plots `value` (the option, or its own), drawn dashed when it
// has `dash`; `interval` shades a band for the first series; points `hollow` flags are drawn open.
function lineChart(host, series, markers, {
  height = 260, label, band = null, value = (p) => p.popularity, interval = null, hollow = null,
  axis = null, tick = (v) => `${Math.round(v * 100)}%`, zero = false, tip = null,
}) {
  const months = series[0]?.points.map((p) => p.month) || [];
  if (!months.length) { host.replaceChildren(el('p', { class: 'mr-note', text: 'No data in this period.' })); return; }
  const val = (ser, p) => (ser.value || value)(p);
  const all = series.flatMap((ser) => ser.points.map((p) => val(ser, p)))
    .concat(interval ? series[0].points.flatMap(interval) : []).filter((v) => v !== null && v !== undefined);
  if (!all.length) { host.replaceChildren(el('p', { class: 'mr-note', text: 'No data in this period.' })); return; }
  const { s, width, m, iw, ih } = chartBox(host, height);
  s.setAttribute('aria-label', label);
  const ax = axis ? axis(all) : (() => { const hi = niceMax(Math.max(0.01, ...all)); return { lo: 0, hi, step: hi / 4 }; })();
  const x = (i) => m.l + (months.length === 1 ? iw / 2 : (i * iw) / (months.length - 1));
  const y = (v) => m.t + ih - ((v - ax.lo) / (ax.hi - ax.lo)) * ih;
  const n = Math.round((ax.hi - ax.lo) / ax.step);
  for (let k = 0; k <= n; k++) {
    const v = ax.lo + k * ax.step;
    const isAxis = zero ? Math.abs(v) < ax.step / 1e6 : k === 0;
    s.append(svg('line', { class: isAxis ? 'chart-axis' : 'chart-grid', x1: m.l, x2: width - m.r, y1: y(v), y2: y(v) }));
    s.append(svg('text', { class: 'chart-tick', x: m.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, tick(v)));
  }
  if (band) {
    // Shade the months selected in the filters; the rest of the timeline stays for context.
    const i0 = months.indexOf(band.from);
    const i1 = months.indexOf(band.to);
    if (i0 >= 0 && i1 >= i0) {
      const half = months.length > 1 ? iw / (months.length - 1) / 2 : iw / 2;
      const x0 = Math.max(m.l, x(i0) - half);
      const x1 = Math.min(m.l + iw, x(i1) + half);
      s.append(svg('rect', { class: 'mr-band', x: x0, y: m.t, width: Math.max(1, x1 - x0), height: ih }));
    }
  }
  const step = Math.ceil(months.length / Math.max(2, Math.floor(iw / 70)));
  months.forEach((mo, i) => {
    if (i % step === 0 || i === months.length - 1) {
      s.append(svg('text', { class: 'chart-tick', x: x(i), y: m.t + ih + 16, 'text-anchor': 'middle' }, shortMonth(mo)));
    }
  });
  // Every ban list gets its line; a label that would overlap one already drawn is left out.
  const taken = [];
  for (const mk of markers) {
    const i = months.indexOf(mk.month);
    if (i < 0) continue;
    s.append(svg('line', { class: 'chart-marker', x1: x(i), x2: x(i), y1: m.t, y2: m.t + ih }));
    const right = x(i) > m.l + iw * 0.6;
    const w = mk.name.length * 5.6;
    const x0 = right ? x(i) - 4 - w : x(i) + 4;
    if (taken.some(([a0, a1]) => x0 < a1 + 6 && x0 + w > a0 - 6)) continue;
    taken.push([x0, x0 + w]);
    s.append(svg('text', { class: 'chart-tick', x: x(i) + (right ? -4 : 4), y: m.t + 9, 'text-anchor': right ? 'end' : 'start' }, mk.name));
  }
  if (interval) {
    // One closed area per run of months that have an interval.
    const ser = series[0];
    let run = [];
    const flush = () => {
      if (run.length) {
        const top = run.map((i) => `${x(i).toFixed(1)} ${y(interval(ser.points[i])[1]).toFixed(1)}`);
        const bottom = run.slice().reverse().map((i) => `${x(i).toFixed(1)} ${y(interval(ser.points[i])[0]).toFixed(1)}`);
        const d = run.length === 1
          ? `M${x(run[0]) - 2} ${y(interval(ser.points[run[0]])[1])} h4 V${y(interval(ser.points[run[0]])[0])} h-4 Z`
          : `M${top.join(' L')} L${bottom.join(' L')} Z`;
        s.append(svg('path', { d, fill: ser.color, 'fill-opacity': 0.15, stroke: 'none' }));
      }
      run = [];
    };
    ser.points.forEach((p, i) => { if (interval(p)[0] === null || interval(p)[0] === undefined) flush(); else run.push(i); });
    flush();
  }
  for (const ser of series) {
    let d = '';
    let gap = true;
    ser.points.forEach((p, i) => {
      const v = val(ser, p);
      if (v === null || v === undefined) { gap = true; return; }
      d += `${gap ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      gap = false;
    });
    s.append(svg('path', { d, fill: 'none', stroke: ser.color, 'stroke-width': ser.dash ? 1.5 : 2, 'stroke-dasharray': ser.dash ? '5 4' : null, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    if (ser.dash) continue;
    ser.points.forEach((p, i) => {
      const v = val(ser, p);
      if (v === null || v === undefined) return;
      const open = hollow && hollow(p);
      // Open points always show (they flag small samples); filled ones only on short timelines.
      if (open || ser.points.length <= 24) {
        s.append(svg('circle', { cx: x(i), cy: y(v), r: 3, fill: open ? 'var(--panel)' : ser.color, stroke: ser.color, 'stroke-width': open ? 1.5 : 0 }));
      }
    });
  }
  const cross = svg('line', { class: 'chart-axis', x1: 0, x2: 0, y1: m.t, y2: m.t + ih, visibility: 'hidden' });
  s.append(cross);
  const hit = svg('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
  hit.addEventListener('pointermove', (ev) => {
    const r = s.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * width;
    const i = Math.max(0, Math.min(months.length - 1, Math.round(((px - m.l) / iw) * (months.length - 1))));
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    showTip(ev.clientX, ev.clientY, [monthName(months[i]), ...(tip ? tip(i) : series.map((ser) => {
      const p = ser.points[i];
      return `${ser.name}: ${fmtPct(p.popularity)} (${fmtN(p.decks)} of ${fmtInt(p.total)})`;
    }))]);
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
  s.append(hit);
  host.replaceChildren(s);
}

function drawTrends() {
  if (!trendsData || !manifest) return;
  const colors = JW.chartColors();
  const range = trendRange();
  const series = trendCards.map((t) => ({
    name: cardName(t.id),
    color: colors[t.slot] || colors[0],
    points: D.monthlySeries(trendsData, t.id, range),
  }));
  const months = series[0]?.points.map((p) => p.month) || [];
  const markers = D.banlistMarkers(manifest, months);
  $('trend-legend').replaceChildren(...trendCards.map((t) => el('span', { class: 'legend-item' },
    el('span', { class: 'legend-swatch', style: `background: var(--chart-${t.slot + 1})` }), cardName(t.id))));
  lineChart($('trend-chart'), series, markers, { label: `Monthly inclusion of ${series.map((x) => x.name).join(', ')}` });
  // Table alternative
  const monthly = `Share of ${state.cut ? 'top-cut ' : ''}${state.side === 'corp' ? 'Corp' : 'Runner'} decks with a known decklist from that month that play the card.`;
  const head = el('tr', {}, el('th', { scope: 'col', text: 'Month' }), ...series.map((x) => el('th', { class: 'num', scope: 'col', text: x.name, title: monthly })));
  const rows = months.map((mo, i) => el('tr', {}, el('td', { text: monthName(mo) }), ...series.map((x) => el('td', { class: 'num', text: fmtPct(x.points[i].popularity) }))));
  $('trend-table').replaceChildren(el('div', { class: 'mr-scroll' }, el('table', { class: 'data-table' }, el('thead', {}, head), el('tbody', {}, ...rows))));
}

// ---------------------------------------------------------------- scatter

function scatterData() {
  let pts = sampled('scatter', D.scatterPoints(view.cards), (p) => p.sufficient);
  if (scatterView.top) pts = D.topPerAxis(pts, SCATTER_TOP);
  return D.filterByName(pts, scatterView.query, cardName);
}

function renderScatter() {
  const b = view.baseline;
  const side = state.side === 'corp' ? 'Corp' : 'Runner';
  $('scatter-note').textContent = `Across: inclusion, the share of ${side} decks with a known decklist in this filter that play the card. Up and down: the card's game winrate minus the baseline, which is the winrate of every ${side} deck with a known decklist in this filter (${fmtPct(b.winrate)} over ${fmtInt(b.games)} games). Point size shows games; hollow points are below the minimum sample.${scatterView.top ? ` Showing the ${SCATTER_TOP} most included cards and the ${SCATTER_TOP} with the best winrate difference.` : ''}`;
  drawScatter();
  const h = help();
  const pts = scatterData();
  dataTable($('scatter-table'), [
    { key: 'title', label: 'Card', help: h.card, value: (r) => cardName(r.card_id), cell: (r) => cardCell(r.card_id) },
    { key: 'x', label: 'Inclusion', num: true, help: h.inclusion, cell: (r) => el('td', { class: 'num', text: `${r.x.toFixed(1)}%` }) },
    { key: 'y', label: 'Winrate vs baseline', num: true, help: h.winrateDiff, cell: (r) => diffCell(r.y, !r.sufficient) },
    { key: 'games', label: 'Games', num: true, help: h.games, cell: (r) => el('td', { class: 'num', text: fmtN(r.games) }) },
  ], pts, { sortKey: 'x', rowClass: (r) => (r.sufficient ? '' : 'mr-insufficient') });
}

function drawScatter() {
  const host = $('scatter-chart');
  if (!view || !host) return;
  const pts = scatterData();
  if (!pts.length) {
    const text = scatterView.query ? 'No card matches that name here.'
      : hideSmall.scatter ? `No card has ${manifest.thresholds.min_games} games with decklists in this filter.` : 'No games with decklists in this filter.';
    host.replaceChildren(el('p', { class: 'mr-note', text }));
    return;
  }
  const { s, width, m, iw, ih } = chartBox(host, 320);
  s.setAttribute('aria-label', 'Scatter of inclusion against winrate difference; the table below lists the same points');
  const color = JW.sideColor(state.side);
  const maxX = niceMax(Math.max(...pts.map((p) => p.x)));
  const ext = niceMax(Math.max(5, ...pts.map((p) => Math.abs(p.y))));
  const maxGames = Math.max(...pts.map((p) => p.games));
  const x = (v) => m.l + (v / maxX) * iw;
  const y = (v) => m.t + ih / 2 - (v / ext) * (ih / 2);
  const r = (g) => 3 + 9 * Math.sqrt(g / maxGames);
  for (let k = -2; k <= 2; k++) {
    const v = (ext * k) / 2;
    s.append(svg('line', { class: k === 0 ? 'chart-axis' : 'chart-grid', x1: m.l, x2: width - m.r, y1: y(v), y2: y(v) }));
    s.append(svg('text', { class: 'chart-tick', x: m.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v)} pp`));
  }
  for (let k = 0; k <= 4; k++) {
    const v = (maxX * k) / 4;
    s.append(svg('text', { class: 'chart-tick', x: x(v), y: m.t + ih + 16, 'text-anchor': 'middle' }, `${Math.round(v)}%`));
  }
  s.append(svg('text', { class: 'chart-tick', x: width - m.r, y: m.t + ih + 28, 'text-anchor': 'end' }, 'inclusion →'));
  const ordered = [...pts].sort((a, b) => b.games - a.games);
  for (const p of ordered) {
    s.append(svg('circle', {
      cx: x(p.x), cy: y(p.y), r: r(p.games),
      fill: p.sufficient ? color : 'none', 'fill-opacity': p.sufficient ? 0.75 : null,
      stroke: color, 'stroke-width': p.sufficient ? 1 : 1.5,
    }));
  }
  // Label every point of a short list (top per axis, a name filter); otherwise the 8 most included.
  const labelled = pts.length <= 2 * SCATTER_TOP ? pts : pts.filter((p) => p.sufficient).sort((a, b) => b.x - a.x).slice(0, 8);
  // Greedy placement, biggest points first: try beside the point, then a line above or below; a
  // label that still overlaps one already placed is left out (hovering still names the card).
  const placed = [];
  const overlaps = (bx) => placed.some((o) => bx.x1 < o.x2 && bx.x2 > o.x1 && bx.y1 < o.y2 && bx.y2 > o.y1);
  for (const p of [...labelled].sort((a, b) => b.games - a.games)) {
    const name = cardName(p.card_id);
    const w = name.length * 6.2;
    const right = x(p.x) > m.l + iw * 0.75;
    const dx = r(p.games) + 3;
    const lx = right ? x(p.x) - dx : x(p.x) + dx;
    const spot = [0, -12, 12, -24, 24].map((dy) => ({ ly: y(p.y) + 3 + dy, box: { x1: right ? lx - w : lx, x2: right ? lx : lx + w, y1: y(p.y) - 6 + dy, y2: y(p.y) + 5 + dy } }))
      .find((c) => !overlaps(c.box));
    if (!spot) continue;
    placed.push(spot.box);
    s.append(svg('text', { class: 'chart-tick mr-label', x: lx, y: spot.ly, 'text-anchor': right ? 'end' : 'start' }, name));
  }
  const hit = svg('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
  hit.addEventListener('pointermove', (ev) => {
    const b = s.getBoundingClientRect();
    const px = ((ev.clientX - b.left) / b.width) * width;
    const py = ((ev.clientY - b.top) / b.height) * s.viewBox.baseVal.height;
    let best = null;
    let bestD = 18 * 18;
    for (const p of pts) {
      const d = (x(p.x) - px) ** 2 + (y(p.y) - py) ** 2;
      if (d < bestD) { best = p; bestD = d; }
    }
    if (!best) { hideTip(); return; }
    showTip(ev.clientX, ev.clientY, [cardName(best.card_id), `Inclusion ${best.x.toFixed(1)}%`,
      `Winrate ${fmtPp(best.y)} vs baseline`, `${fmtN(best.games)} games${best.sufficient ? '' : ' (below minimum sample)'}`]);
  });
  hit.addEventListener('pointerleave', hideTip);
  hit.addEventListener('click', () => { /* the table below offers keyboard access to each card */ });
  s.append(hit);
  host.replaceChildren(s);
}

// ---------------------------------------------------------------- search and card detail

/** A card-name combobox: `find(query)` returns catalog cards, `onPick(card)` handles a choice. */
function cardCombo(input, list, { find, onPick, clearOnPick = false }) {
  let active = -1;
  let hits = [];
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const pick = (c) => { input.value = clearOnPick ? '' : c.title; close(); onPick(c); };
  const draw = () => {
    hits = find(input.value);
    list.replaceChildren(...hits.map((c, i) => {
      const f = D.faction(c.faction);
      const li = el('li', { id: `${list.id}-${i}`, role: 'option', class: 'mr-option', 'aria-selected': i === active ? 'true' : 'false' },
        el('span', { text: c.title }), ' ', el('span', { class: `faction ${f.className}`, text: `${f.name} · ${c.side === 'corp' ? 'Corp' : 'Runner'}` }));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(c); });
      return li;
    }));
    list.hidden = !hits.length;
    input.setAttribute('aria-expanded', String(!!hits.length));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
  };
  input.addEventListener('input', () => { active = -1; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(hits.length - 1, active + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && hits.length) { pick(hits[Math.max(0, active)]); e.preventDefault(); }
    else if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 100));
}

function setupSearch() {
  cardCombo($('card-search'), $('card-options'), {
    find: (q) => D.searchCards(catalog, q, { side: state.side, limit: 8 }), // only the selected side's cards
    onPick: (c) => openDetail(c.id),
  });
  // Trends: only cards played in the current view and not already charted.
  cardCombo($('trend-add'), $('trend-options'), {
    find: (q) => {
      const charted = new Set(trendCards.map((t) => t.id));
      const played = (view?.cards || []).filter((c) => c.decks > 0 && !charted.has(c.card_id)).map((c) => cards.get(c.card_id)).filter(Boolean);
      return D.searchCards({ cards: played }, q, { limit: 10 });
    },
    onPick: (c) => addTrendCard(c.id),
    clearOnPick: true,
  });
}

async function openDetail(id, scroll = true) {
  const c = cards.get(id);
  if (!c) return;
  if (c.side !== state.side) {
    detailCard = id;
    state.side = c.side;
    syncFilters();
    commit();
    return;
  }
  detailCard = id;
  const panel = $('detail');
  panel.hidden = false;
  const body = $('detail-body');
  const f = D.faction(c.faction);
  const head = el('div', { class: 'mr-detail-head' }, el('h3', { class: 'mr-detail-title', text: c.title }),
    el('span', { class: `faction ${f.className}`, text: f.name }), ' ', el('span', { class: 'badge', text: D.typeName(c.type) }),
    ' ', el('span', { class: `badge ${c.side}`, text: c.side === 'corp' ? 'Corp' : 'Runner' }));
  const m = view.cards.find((x) => x.card_id === id);
  const isIdentity = c.type.endsWith('identity');
  const ident = isIdentity ? (identities?.identities || []).find((x) => x.card_id === id) : null;
  if ((!m || !m.decks) && !ident) {
    body.replaceChildren(head, el('p', { class: 'mr-note', text: 'Not played in this filter.' }));
    if (scroll) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const stat = (num, label) => el('div', { class: 'stat' }, el('span', { class: 'num', text: num }), el('span', { class: 'label', text: label }));
  const stats = ident
    ? [stat(fmtPct(ident.share), 'Share of entries'), stat(fmtPp(ident.winrate_diff_pp), `Winrate vs baseline (${fmtN(ident.games)})`),
      stat(`${fmtPp(ident.wilson_low_pp)} → ${fmtPp(ident.wilson_high_pp)}`, '95% interval'), stat(fmtPct(ident.conversion), `Top-cut conversion (${fmtN(ident.cut_entries)})`)]
    : [stat(fmtPct(m.popularity), `Inclusion (${fmtN(m.decks)} decks)`), stat(fmtNum(m.avg_copies), 'Average copies'),
      stat(m.copies_mode ? `${m.copies_mode}×` : '–', 'Most common copy count'),
      stat(fmtPp(m.winrate_diff_pp), `Winrate vs baseline (${fmtN(m.games)}${m.winrate_status === 'ok' ? '' : ', small sample'})`),
      stat(`${fmtPp(m.wilson_low_pp)} → ${fmtPp(m.wilson_high_pp)}`, '95% interval')];
  const charts = isIdentity ? [el('div', { id: 'detail-chart', class: 'mr-chart' })] : detailCharts();
  body.replaceChildren(head, el('div', { class: 'summary-grid mr-stats' }, ...stats),
    el('p', { class: 'mr-note', text: `Charts show every month and every ban list; the months selected in Filters are shaded.${isIdentity ? '' : ` Open winrate points are months with fewer than ${fmtInt(manifest.thresholds.min_games)} games.`}` }), ...charts);
  if (scroll) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    setBusy(['detail'], true);
    detailTrends = await slice('trends', { ...state, restriction: 'all' }); // whole timeline, every ban list
    drawDetailChart();
    setBusy(['detail'], false);
  } catch {
    setBusy(['detail'], false);
    $('detail-chart').replaceChildren(el('p', { class: 'mr-note', text: 'Trends could not be loaded.' }));
  }
}

// Headings, notes and hosts for the card's monthly charts; drawDetailChart fills the hosts.
function detailCharts() {
  const side = state.side === 'corp' ? 'Corp' : 'Runner';
  const color = JW.sideColor(state.side);
  const key = (swatch, text) => el('span', { class: 'legend-item' }, el('span', { class: 'legend-swatch', style: swatch }), text);
  return [
    el('h3', { text: 'Inclusion by month' }),
    el('div', { id: 'detail-chart', class: 'mr-chart' }),
    el('h3', { text: 'Winrate by month' }),
    el('div', { class: 'legend' }, key(`background: ${color}`, 'Game winrate'), key(`background: ${color}; opacity: 0.25; height: 10px`, '95% interval'),
      key('background: repeating-linear-gradient(90deg, var(--dim) 0 5px, transparent 5px 9px); width: 18px; height: 2px', `Baseline (every ${side} deck)`)),
    el('div', { id: 'detail-winrate', class: 'mr-chart' }),
    el('h3', { text: 'Winrate vs baseline by month' }),
    el('p', { class: 'mr-note', text: `The card's winrate minus that month's baseline, with the 95% interval shaded.` }),
    el('div', { id: 'detail-diff', class: 'mr-chart' }),
    el('h3', { text: 'Average copies by month' }),
    el('div', { id: 'detail-copies', class: 'mr-chart' }),
  ];
}

function drawDetailChart() {
  const host = document.getElementById('detail-chart');
  if (!host || !detailCard || !detailTrends || !detailTrends.cards[detailCard]) {
    if (host && detailCard && detailTrends) host.replaceChildren(el('p', { class: 'mr-note', text: 'Identities have no monthly series.' }));
    return;
  }
  const name = cardName(detailCard);
  const points = D.monthlySeries(detailTrends, detailCard, null);
  const months = points.map((p) => p.month);
  const markers = D.banlistMarkers(manifest, months);
  const range = trendRange();
  const shaded = range ? `; ${monthName(range.from)} to ${monthName(range.to)} is shaded` : '';
  const color = JW.sideColor(state.side);
  const card = [{ name, color, points }];
  const small = (p) => p.games > 0 && p.games < manifest.thresholds.min_games;
  const pctAxis = (vals) => niceAxis(Math.max(0, Math.min(...vals)), Math.min(1, Math.max(...vals)));
  const opts = { height: 200, band: range };
  lineChart(host, card, markers,
    { ...opts, label: `Monthly inclusion of ${name} over every month, all ban lists${shaded}` });
  const wr = $('detail-winrate');
  if (wr) {
    lineChart(wr, [...card, { name: 'Baseline', color: 'var(--dim)', points, value: (p) => p.baseline_winrate, dash: true }], markers, {
      ...opts, value: (p) => p.winrate, interval: (p) => [p.winrate_low, p.winrate_high], hollow: small, axis: pctAxis,
      label: `Monthly game winrate of ${name} with its 95% interval, against the baseline${shaded}`,
      tip: (i) => {
        const p = points[i];
        return [`${name}: ${fmtPct(p.winrate)} (${fmtN(p.games)})`, `95% interval: ${fmtPct(p.winrate_low)} → ${fmtPct(p.winrate_high)}`, `Baseline: ${fmtPct(p.baseline_winrate)}`];
      },
    });
  }
  const diff = $('detail-diff');
  if (diff) {
    lineChart(diff, card, markers, {
      ...opts, value: (p) => p.winrate_diff_pp, interval: (p) => [p.wilson_low_pp, p.wilson_high_pp], hollow: small, zero: true,
      axis: (vals) => { const ext = Math.max(5, ...vals.map(Math.abs)); return niceAxis(-ext, ext); },
      tick: (v) => `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(+v.toFixed(1))} pp`,
      label: `Monthly winrate of ${name} minus the baseline, with its 95% interval${shaded}`,
      tip: (i) => {
        const p = points[i];
        return [`vs baseline: ${fmtPp(p.winrate_diff_pp)} (${fmtN(p.games)})`, `95% interval: ${fmtPp(p.wilson_low_pp)} → ${fmtPp(p.wilson_high_pp)}`];
      },
    });
  }
  const copies = $('detail-copies');
  if (copies) {
    lineChart(copies, card, markers, {
      ...opts, value: (p) => p.avg_copies, axis: (vals) => niceAxis(0, Math.max(3, ...vals)), tick: (v) => `${+v.toFixed(2)}×`,
      label: `Monthly average copies of ${name} in the decks that play it${shaded}`,
      tip: (i) => [`Average copies: ${fmtNum(points[i].avg_copies)} (${fmtN(points[i].decks)} decks)`],
    });
  }
}

// ---------------------------------------------------------------- quality footer

async function loadQuality() {
  try {
    const q = await getJson(D.joinUrl(base, manifest.base_path + manifest.paths.quality));
    const c = q.coverage;
    $('quality').textContent = `Data quality: ${fmtInt(c.tournaments)} tournaments (${fmtInt(c.tournaments_with_games)} with game results, ${fmtInt(c.tournaments_high_coverage)} with high decklist coverage), ${fmtInt(c.legal_decks)} legal decks of ${fmtInt(c.decks)}, ${fmtInt(c.games)} games. Unresolved cards: ${fmtInt(Object.keys(q.unresolved_cards).length)}; link mismatches: ${fmtInt(q.link_mismatches.length)}; parser failures: ${fmtInt(q.parser_failures.length)}. Generated ${manifest.generated_at}.`;
  } catch {
    $('quality').textContent = '';
  }
}

boot().catch((e) => {
  console.error(e);
  showUnavailable();
});
