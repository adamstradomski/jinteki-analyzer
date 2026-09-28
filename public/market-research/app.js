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
let trendCards = []; // [{ id, slot }] – colour slots stay with the card
let detailCard = null;
let sideToggle = null;

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

const slice = (kind, s = state) => getJson(D.sliceUrl(base, manifest, kind, { side: s.side, restriction: s.restriction, tier: s.tier }));

async function boot() {
  JW.mountThemeSwitcher($('theme-switcher'));
  JW.mountModeToggle($('mode-toggle'));
  JW.enablePanelCollapse();
  try {
    manifest = await getJson(D.joinUrl(base, 'manifest.json'));
  } catch {
    let last = null;
    try { last = localStorage.getItem(LAST_SEEN_KEY); } catch { /* storage may be blocked */ }
    $('status').textContent = `Market Research data is unavailable right now.${last ? ` Last updated ${last}.` : ''} Try again later.`;
    return;
  }
  try { localStorage.setItem(LAST_SEEN_KEY, manifest.data_as_of || manifest.generated_at); } catch { /* ignore */ }
  catalog = await getJson(D.joinUrl(base, manifest.base_path + manifest.paths.catalog));
  cards = D.catalogIndex(catalog);
  state = D.parseHash(location.hash, manifest);
  setupFilters();
  setupSearch();
  window.addEventListener('hashchange', () => {
    const next = D.parseHash(location.hash, manifest);
    if (D.formatHash(next) !== D.formatHash(state)) { state = next; syncFilters(); refresh(); }
  });
  document.addEventListener('jw:themechange', () => { drawTrends(); drawScatter(); drawDetailChart(); });
  window.addEventListener('resize', debounce(() => { drawTrends(); drawScatter(); drawDetailChart(); }, 150));
  $('detail-close').addEventListener('click', () => { detailCard = null; $('detail').hidden = true; });
  $('app').hidden = false;
  await refresh();
  loadQuality();
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
  $('f-restriction').replaceChildren(...manifest.restrictions.map((r) => option(r.id, r.name, r.id === state.restriction)));
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
  $('status').hidden = false;
  $('status').textContent = 'Loading data…';
  document.documentElement.style.setProperty('--mr-side', `var(--${state.side})`);
  try {
    const summary = await slice('summary');
    identities = await slice('identities');
    let v = summary;
    if (state.custom && summary.period && (state.from !== summary.period.from || state.to !== summary.period.to)) {
      const trends = await slice('trends');
      v = D.summarize(trends, { from: state.from, to: state.to }, manifest.thresholds, 'all');
    }
    if (token !== refreshToken) return;
    view = v;
    if (!state.custom && view.period) { state.from = view.period.from; state.to = view.period.to; syncFilters(); }
    $('status').hidden = true;
    renderAll();
  } catch (e) {
    if (token !== refreshToken) return;
    $('status').textContent = 'This slice could not be loaded. Try another filter or reload the page.';
  }
}

function renderAll() {
  renderStats();
  renderPlayed();
  renderIdentities();
  renderWinrate();
  renderConversion();
  renderScatter();
  initTrendCards();
  renderTrends();
  if (detailCard) openDetail(detailCard, false);
}

function renderStats() {
  const b = view.baseline;
  const side = state.side === 'corp' ? 'Corp' : 'Runner';
  const stat = (num, label, cls = '') => el('div', { class: `stat ${cls}` }, el('span', { class: 'num', text: num }), el('span', { class: 'label', text: label }));
  $('stats').replaceChildren(
    stat(manifest.data_as_of || '–', 'Data as of'),
    stat(fmtInt(b.tournaments), 'Tournaments'),
    stat(fmtInt(b.decks), `${side} decks`, state.side),
    stat(b.games_all == null ? fmtInt(b.games) : `${fmtInt(b.games)} / ${fmtInt(b.games_all)}`, `${side} games (with decklists / total)`, state.side),
    stat(fmtPct(b.winrate_all ?? b.winrate), `${side} winrate (all games)`),
    stat(fmtPct(b.cut_rate), 'Baseline top-cut rate'),
  );
  const p = view.period;
  $('period-note').textContent = p
    ? `Showing ${monthName(p.from)} → ${monthName(p.to)}${view.previous_period ? `, compared with ${monthName(view.previous_period.from)} → ${monthName(view.previous_period.to)}` : ''}.`
    : 'No Standard tournaments match this filter.';
}

// ---------------------------------------------------------------- tables

/** A sortable table with real header buttons and an optional "show all" button. */
function dataTable(host, columns, rows, { initial, sortKey = null, sortDir = 'descending', rowClass = () => '', limit = TABLE_ROWS, empty = 'No cards in this filter.' }) {
  let key = sortKey;
  let dir = sortDir;
  let all = false;
  const draw = () => {
    const col = columns.find((c) => c.key === key);
    const sorted = key ? D.sortRows(rows, key, dir, col?.value || ((r) => r[key])) : initial ? initial(rows) : rows;
    const shown = all ? sorted : sorted.slice(0, limit);
    const head = el('tr', {}, ...columns.map((c) => {
      const th = el('th', { class: c.num ? 'num' : '', scope: 'col', 'aria-sort': c.key === key ? dir : null });
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
        all ? `Show top ${limit}` : `Show all ${fmtInt(sorted.length)} cards`));
    }
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
  const rows = view.cards.filter((c) => c.decks > 0);
  dataTable($('played-body'), [
    { key: 'rank', label: 'Rank', num: true, cell: (r) => el('td', { class: 'num', text: fmtInt(r.rank) }) },
    { key: 'title', label: 'Card', value: (r) => cardName(r.card_id), cell: (r) => cardCell(r.card_id) },
    { key: 'type', label: 'Type', value: (r) => D.typeName(cards.get(r.card_id)?.type), cell: (r) => el('td', { text: D.typeName(cards.get(r.card_id)?.type) }) },
    { key: 'popularity', label: 'Inclusion', num: true, cell: (r) => meterCell(r.popularity) },
    { key: 'avg_copies', label: 'Avg copies', num: true, cell: (r) => el('td', { class: 'num', text: fmtNum(r.avg_copies) }) },
    { key: 'change_pp', label: 'Change', num: true, cell: (r) => changeCell(r.change_pp) },
    { key: 'decks', label: 'Decks', num: true, cell: (r) => el('td', { class: 'num', text: fmtN(r.decks) }) },
  ], rows, { sortKey: 'rank', sortDir: 'ascending' });
}

function renderIdentities() {
  const list = identities?.identities || [];
  const p = identities?.period;
  $('identities-note').textContent = p
    ? `Share of entries, winrate difference from the ${state.side === 'corp' ? 'Corp' : 'Runner'} baseline and top-cut conversion, ${monthName(p.from)} → ${monthName(p.to)}.${state.custom && view.period && (p.from !== view.period.from || p.to !== view.period.to) ? ' Identities always show the default period.' : ''}`
    : '';
  dataTable($('identities-body'), [
    { key: 'rank', label: 'Rank', num: true, cell: (r) => el('td', { class: 'num', text: fmtInt(r.rank) }) },
    { key: 'title', label: 'Identity', value: (r) => cardName(r.card_id), cell: (r) => cardCell(r.card_id) },
    { key: 'share', label: 'Share', num: true, cell: (r) => meterCell(r.share) },
    { key: 'winrate_diff_pp', label: 'Winrate vs baseline', num: true, cell: (r) => diffCell(r.winrate_diff_pp, r.winrate_status !== 'ok') },
    { key: 'games', label: 'Games', num: true, cell: (r) => el('td', { class: 'num', text: fmtN(r.games) }) },
    { key: 'conversion', label: 'Conversion', num: true, cell: (r) => el('td', { class: 'num', text: `${fmtPct(r.conversion)} (${fmtRatio(r.conversion_ratio)})` }) },
    { key: 'cut_entries', label: 'Entries in cut events', num: true, cell: (r) => el('td', { class: 'num', text: fmtN(r.cut_entries) }) },
  ], list, { sortKey: 'rank', sortDir: 'ascending', rowClass: (r) => (r.winrate_status !== 'ok' ? 'mr-insufficient' : ''), empty: 'No identities in this filter.' });
}

function renderWinrate() {
  $('winrate-note').textContent = `Game winrate of decks with the card minus the ${state.side === 'corp' ? 'Corp' : 'Runner'} baseline over games with decklists (${fmtPct(view.baseline.winrate)}), with the Wilson 95% interval. Draws count as half a win; intentional draws are excluded. Rows under ${manifest.thresholds.min_games} games are greyed and listed last.`;
  const rows = D.winrateRows(view.cards);
  dataTable($('winrate-body'), [
    { key: 'title', label: 'Card', value: (r) => cardName(r.card_id), cell: (r) => cardCell(r.card_id) },
    { key: 'winrate_diff_pp', label: 'Winrate vs baseline', num: true, cell: (r) => diffCell(r.winrate_diff_pp, r.winrate_status !== 'ok') },
    { key: 'wilson_low_pp', label: '95% interval', num: true, sortable: false, cell: (r) => el('td', { class: 'num', text: `${fmtPp(r.wilson_low_pp)} → ${fmtPp(r.wilson_high_pp)}` }) },
    { key: 'winrate', label: 'Winrate', num: true, cell: (r) => el('td', { class: 'num', text: fmtPct(r.winrate) }) },
    { key: 'games', label: 'Games', num: true, cell: (r) => el('td', { class: 'num', text: fmtN(r.games) }) },
  ], rows, { rowClass: (r) => (r.winrate_status !== 'ok' ? 'mr-insufficient' : ''), empty: 'No games with decklists in this filter.' });
}

function renderConversion() {
  const b = view.baseline;
  $('conversion-note').textContent = `Share of entries with the card that made the top cut, against ${fmtPct(b.cut_rate)} for all ${state.side === 'corp' ? 'Corp' : 'Runner'} entries. Only tournaments with a cut and at least ${Math.round(manifest.thresholds.coverage_hc * 100)}% decklist coverage count (${fmtInt(b.tournaments_hc)} in this filter). Rows under ${manifest.thresholds.min_entries} entries are greyed and listed last.`;
  const rows = D.conversionRows(view.cards);
  dataTable($('conversion-body'), [
    { key: 'title', label: 'Card', value: (r) => cardName(r.card_id), cell: (r) => cardCell(r.card_id) },
    { key: 'conversion', label: 'Conversion', num: true, cell: (r) => el('td', { class: 'num', text: fmtPct(r.conversion) }) },
    { key: 'conversion_diff_pp', label: 'vs baseline', num: true, cell: (r) => diffCell(r.conversion_diff_pp, r.conversion_status !== 'ok') },
    { key: 'conversion_ratio', label: 'Ratio', num: true, cell: (r) => el('td', { class: 'num', text: fmtRatio(r.conversion_ratio) }) },
    { key: 'entries_hc', label: 'Entries', num: true, cell: (r) => el('td', { class: 'num', text: fmtN(r.entries_hc) }) },
    { key: 'tournaments_hc', label: 'Tournaments', num: true, cell: (r) => el('td', { class: 'num', text: fmtN(r.tournaments_hc) }) },
  ], rows, { rowClass: (r) => (r.conversion_status !== 'ok' ? 'mr-insufficient' : ''), empty: 'No high-coverage tournaments with a cut in this filter.' });
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

function initTrendCards() {
  const played = view.cards.filter((c) => c.decks > 0);
  const valid = new Set(played.map((c) => c.card_id));
  trendCards = trendCards.filter((t) => valid.has(t.id));
  if (!trendCards.length) trendCards = played.slice(0, 5).map((c, i) => ({ id: c.card_id, slot: i }));
  $('trend-add').replaceChildren(option('', 'Choose a card', true), ...played
    .filter((c) => !trendCards.some((t) => t.id === c.card_id))
    .map((c) => option(c.card_id, cardName(c.card_id), false)));
  $('trend-add').onchange = (e) => { if (e.target.value) addTrendCard(e.target.value); };
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
  $('trend-chart').replaceChildren(el('p', { class: 'mr-note', text: 'Loading trends…' }));
  try {
    const t = await slice('trends', s);
    if (D.formatHash(s) !== D.formatHash(state)) return;
    trendsData = t;
    drawTrends();
  } catch {
    $('trend-chart').replaceChildren(el('p', { class: 'mr-note', text: 'Trends could not be loaded.' }));
  }
}

function trendRange() {
  return state.from && state.to ? { from: state.from, to: state.to } : null;
}

function lineChart(host, series, markers, { height = 260, label }) {
  const months = series[0]?.points.map((p) => p.month) || [];
  if (!months.length) { host.replaceChildren(el('p', { class: 'mr-note', text: 'No data in this period.' })); return; }
  const { s, width, m, iw, ih } = chartBox(host, height);
  s.setAttribute('aria-label', label);
  const maxV = niceMax(Math.max(0.01, ...series.flatMap((x) => x.points.map((p) => p.popularity || 0))));
  const x = (i) => m.l + (months.length === 1 ? iw / 2 : (i * iw) / (months.length - 1));
  const y = (v) => m.t + ih - (v / maxV) * ih;
  for (let k = 0; k <= 4; k++) {
    const v = (maxV * k) / 4;
    s.append(svg('line', { class: k === 0 ? 'chart-axis' : 'chart-grid', x1: m.l, x2: width - m.r, y1: y(v), y2: y(v) }));
    s.append(svg('text', { class: 'chart-tick', x: m.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, `${Math.round(v * 100)}%`));
  }
  const step = Math.ceil(months.length / Math.max(2, Math.floor(iw / 70)));
  months.forEach((mo, i) => {
    if (i % step === 0 || i === months.length - 1) {
      s.append(svg('text', { class: 'chart-tick', x: x(i), y: m.t + ih + 16, 'text-anchor': 'middle' }, shortMonth(mo)));
    }
  });
  for (const mk of markers) {
    const i = months.indexOf(mk.month);
    if (i < 0) continue;
    s.append(svg('line', { class: 'chart-marker', x1: x(i), x2: x(i), y1: m.t, y2: m.t + ih }));
    const right = x(i) > m.l + iw * 0.6;
    s.append(svg('text', { class: 'chart-tick', x: x(i) + (right ? -4 : 4), y: m.t + 9, 'text-anchor': right ? 'end' : 'start' }, mk.name));
  }
  for (const ser of series) {
    let d = '';
    ser.points.forEach((p, i) => {
      if (p.popularity === null) return;
      d += `${d ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.popularity).toFixed(1)} `;
    });
    s.append(svg('path', { d, fill: 'none', stroke: ser.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    ser.points.forEach((p, i) => {
      if (p.popularity !== null && ser.points.length <= 24) s.append(svg('circle', { cx: x(i), cy: y(p.popularity), r: 3, fill: ser.color }));
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
    showTip(ev.clientX, ev.clientY, [monthName(months[i]), ...series.map((ser) => {
      const p = ser.points[i];
      return `${ser.name}: ${fmtPct(p.popularity)} (${fmtN(p.decks)} of ${fmtInt(p.total)})`;
    })]);
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
  const head = el('tr', {}, el('th', { scope: 'col', text: 'Month' }), ...series.map((x) => el('th', { class: 'num', scope: 'col', text: x.name })));
  const rows = months.map((mo, i) => el('tr', {}, el('td', { text: monthName(mo) }), ...series.map((x) => el('td', { class: 'num', text: fmtPct(x.points[i].popularity) }))));
  $('trend-table').replaceChildren(el('div', { class: 'mr-scroll' }, el('table', { class: 'data-table' }, el('thead', {}, head), el('tbody', {}, ...rows))));
}

// ---------------------------------------------------------------- scatter

function renderScatter() {
  drawScatter();
  const pts = D.scatterPoints(view.cards);
  dataTable($('scatter-table'), [
    { key: 'title', label: 'Card', value: (r) => cardName(r.card_id), cell: (r) => cardCell(r.card_id) },
    { key: 'x', label: 'Inclusion', num: true, cell: (r) => el('td', { class: 'num', text: `${r.x.toFixed(1)}%` }) },
    { key: 'y', label: 'Winrate vs baseline', num: true, cell: (r) => diffCell(r.y, !r.sufficient) },
    { key: 'games', label: 'Games', num: true, cell: (r) => el('td', { class: 'num', text: fmtN(r.games) }) },
  ], pts, { sortKey: 'x', rowClass: (r) => (r.sufficient ? '' : 'mr-insufficient') });
}

function drawScatter() {
  const host = $('scatter-chart');
  if (!view || !host) return;
  const pts = D.scatterPoints(view.cards);
  if (!pts.length) { host.replaceChildren(el('p', { class: 'mr-note', text: 'No games with decklists in this filter.' })); return; }
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
  const labelled = pts.filter((p) => p.sufficient).sort((a, b) => b.x - a.x).slice(0, 8);
  for (const p of labelled) {
    const right = x(p.x) > m.l + iw * 0.75;
    const dx = r(p.games) + 3;
    s.append(svg('text', { class: 'chart-tick mr-label', x: right ? x(p.x) - dx : x(p.x) + dx, y: y(p.y) + 3,
      'text-anchor': right ? 'end' : 'start' }, cardName(p.card_id)));
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

function setupSearch() {
  const input = $('card-search');
  const list = $('card-options');
  let active = -1;
  let hits = [];
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  const pick = (c) => { input.value = c.title; close(); openDetail(c.id); };
  const draw = () => {
    hits = D.searchCards(catalog, input.value, { limit: 8 });
    list.replaceChildren(...hits.map((c, i) => {
      const f = D.faction(c.faction);
      const li = el('li', { id: `opt-${i}`, role: 'option', class: 'mr-option', 'aria-selected': i === active ? 'true' : 'false' },
        el('span', { text: c.title }), ' ', el('span', { class: `faction ${f.className}`, text: `${f.name} · ${c.side === 'corp' ? 'Corp' : 'Runner'}` }));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(c); });
      return li;
    }));
    list.hidden = !hits.length;
    input.setAttribute('aria-expanded', String(!!hits.length));
    if (active >= 0) input.setAttribute('aria-activedescendant', `opt-${active}`);
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
      stat(`${fmtPp(m.wilson_low_pp)} → ${fmtPp(m.wilson_high_pp)}`, '95% interval'),
      stat(fmtPct(m.conversion), `Top-cut conversion (${fmtN(m.entries_hc)}${m.conversion_status === 'ok' ? '' : ', small sample'})`)];
  body.replaceChildren(head, el('div', { class: 'summary-grid mr-stats' }, ...stats), el('h3', { text: 'Inclusion by month' }), el('div', { id: 'detail-chart', class: 'mr-chart' }));
  if (scroll) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    trendsData = trendsData && trendsData.side === state.side && trendsData.restriction === state.restriction && trendsData.tier_group === state.tier
      ? trendsData : await slice('trends');
    drawDetailChart();
  } catch {
    $('detail-chart').replaceChildren(el('p', { class: 'mr-note', text: 'Trends could not be loaded.' }));
  }
}

function drawDetailChart() {
  const host = document.getElementById('detail-chart');
  if (!host || !detailCard || !trendsData || !trendsData.cards[detailCard]) {
    if (host && detailCard && trendsData) host.replaceChildren(el('p', { class: 'mr-note', text: 'Identities have no deck-inclusion series.' }));
    return;
  }
  const points = D.monthlySeries(trendsData, detailCard, trendRange());
  const months = points.map((p) => p.month);
  lineChart(host, [{ name: cardName(detailCard), color: JW.sideColor(state.side), points }], D.banlistMarkers(manifest, months),
    { height: 200, label: `Monthly inclusion of ${cardName(detailCard)}` });
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

boot();
