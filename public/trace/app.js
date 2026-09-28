// Trace: renders the stats, charts and tables for a pasted jinteki.net game log.
// The parsing itself lives in parser.js (globalThis.TraceParser), loaded just before this.
// Loaded as a classic script at the end of index.html (the page's CSP forbids inline scripts).

// Series colours come from the current theme (design system tokens), so they are
// resolved at draw time and charts are redrawn when the theme changes.
function seriesColor(idx){
  const colors = JW.chartColors();
  return colors[idx % colors.length];
}

// Neutral colour for a value label shared by both players (same value, same point).
const VALUE_LABEL_SHARED_COLOR = 'var(--dim)';

// Value labels above chart points: 'none', 'changes' (only where a player's value
// differs from their previous turn) or 'all'. One setting shared by every chart.
const VALUE_LABEL_MODES = ['none', 'changes', 'all'];
let valueLabelMode = 'none';
try {
  const saved = localStorage.getItem('valueLabelMode');
  if (VALUE_LABEL_MODES.includes(saved)) valueLabelMode = saved;
} catch (e) {}

function getChartColors(data){
  return data.players.map((p, idx) => {
    const side = data.playerSide[p];
    return (side === 'corp' || side === 'runner') ? JW.sideColor(side) : seriesColor(idx);
  });
}

const { parseLog, evaluateAchievements } = TraceParser;

// ---- UI wiring ----
const logInput = document.getElementById('logInput');
const statusMsg = document.getElementById('statusMsg');
const results = document.getElementById('results');

let currentData = null;
const sortState = {};
const hideZeroState = {};

// Log text (player names, card names, whole lines) is untrusted: anyone can craft a
// #log= link, so every value that goes into innerHTML passes through esc() or fmt().
function esc(v){
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmt(n){ return (typeof n === 'number') ? n.toLocaleString() : esc(n); }

// Easter egg: jinteki.net usernames (lowercase) of Netrunner content creators.
const NET_CELEBRITIES = new Set(['amavric', 'dull_bulb']);

function renderSummary(data){
  const grid = document.getElementById('summaryGrid');
  grid.innerHTML = '';
  const stats = [
    { label: 'Winner', num: data.winner || '—', side: data.playerSide[data.winner] },
    { label: 'Rounds', num: data.rounds || 0 }
  ];
  if (data.undos.length) stats.push({ label: 'Undo commands (see flagged lines)', num: data.undos.length });
  data.players.forEach(p => {
    stats.push({ label: `${p} — turns taken`, num: data.maxTurn[p] || 0, side: data.playerSide[p] });
  });
  stats.forEach(s => {
    const side = s.side || '';
    const div = document.createElement('div');
    div.className = `stat ${side}`;
    div.innerHTML = `<span class="num ${side}">${esc(s.num)}</span><span class="label">${esc(s.label)}</span>`;
    grid.appendChild(div);
  });

  const badgesRow = document.getElementById('badgesRow');
  badgesRow.innerHTML = '';
  const earned = evaluateAchievements(data);
  data.players.forEach(p => {
    const b = data.chatBadges[p] || {};
    const side = data.playerSide[p] || '';
    const chips = [];
    const chip = (label, desc, cls = '') =>
      chips.push(`<span class="badge ${side}${cls}" tabindex="0" data-desc="${esc(desc)}">${esc(label)}<span class="visually-hidden">: ${esc(desc)}</span></span>`);
    if (b.glhf) chip('GLHF', 'Wished good luck / have fun in chat.');
    if (b.gg) chip('GG', 'Said “good game” in chat.');
    if (b.ty) chip('TY4TG', 'Thanked the opponent for the game in chat.');
    if (b.kurwa) chip('Bober *****', 'The player is probably Polish');
    if (b.savedReplay) chip('💾 SAVED', 'Saved a replay of this game.');
    if (data.concededPlayer === p) chip('CONCEDE', 'Conceded the game.', ' concede');
    if (!chips.length){
      if (side === 'runner') chip('Silencer', 'No chat detected from this player.');
      else if (side === 'corp') chip('Subliminal Messaging', 'No chat detected from this player.');
      else chips.push('<span class="no-chat">no chat detected</span>');
    }
    if (NET_CELEBRITIES.has(p.toLowerCase())) chip('Net Celebrity', 'Twitch/YouTube content creator.');
    (earned[p] || []).forEach(a => {
      chips.push(`<span class="badge achievement ${a.side}" tabindex="0" data-desc="${esc(a.description)}">${esc(a.name)}<span class="visually-hidden">: ${esc(a.description)}</span></span>`);
    });
    const div = document.createElement('div');
    div.className = 'player-badges';
    div.innerHTML = `<strong class="badge-player ${side}">${esc(p)}</strong>${chips.join('')}`;
    badgesRow.appendChild(div);
  });
}

function sortRows(rows, key, dir){
  return [...rows].sort((a, b) => {
    let av = a[key], bv = b[key];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return dir === 'asc' ? -1 : 1;
    if (av > bv) return dir === 'asc' ? 1 : -1;
    return 0;
  });
}

function netCell(val){
  const cls = val > 0 ? 'pos' : (val < 0 ? 'neg' : '');
  return `<td class="num ${cls}">${fmt(val)}</td>`;
}

const expandState = {};

function benefitLabel(kind){
  return kind === 'credit' ? 'Credit' : (kind === 'click' ? 'Click' : 'Draw');
}

// The fixed set of Netrunner basic actions, one row per action, for a given
// player/side. `credits` is null (rendered as "—") for actions with no
// tracked credit value.
function basicActionRows(data, player, side){
  const credit = data.clickCredits[player] || { count: 0, gained: 0 };
  const draws = data.drawClicks[player] || 0;
  const installs = data.installClicks[player] || 0;
  const plays = data.eventsPlayed[player] || 0;
  if (side === 'corp'){
    const advance = data.advanceClicks[player] || { count: 0, cost: 0 };
    const trash = data.trashResources[player] || { count: 0, cost: 0 };
    const purge = data.purgeClicks[player] || 0;
    return [
      { label: 'Gain 1 credit', count: credit.count, credits: credit.gained },
      { label: 'Draw 1 card', count: draws, credits: null },
      { label: 'Install 1 card from HQ', count: installs, credits: null },
      { label: 'Play 1 operation from HQ', count: plays, credits: null },
      { label: 'Advance 1 installed card', count: advance.count, credits: -advance.cost },
      { label: 'Trash 1 resource', count: trash.count, credits: -trash.cost },
      { label: 'Purge virus counters', count: purge, credits: null }
    ];
  }
  const runs = data.runsMade[player] || 0;
  const tag = data.tagRemovals[player] || { count: 0, cost: 0 };
  return [
    { label: 'Gain 1 credit', count: credit.count, credits: credit.gained },
    { label: 'Draw 1 card', count: draws, credits: null },
    { label: 'Install 1 card from Grip', count: installs, credits: null },
    { label: 'Play 1 event from Grip', count: plays, credits: null },
    { label: 'Make a run on any server', count: runs, credits: null },
    { label: 'Remove 1 tag', count: tag.count, credits: -tag.cost }
  ];
}

function wireBasicActionsToggles(){
  document.querySelectorAll('[data-hideuntriggered]').forEach(cb => {
    cb.addEventListener('change', () => {
      const tableId = cb.dataset.hideuntriggered;
      document.querySelectorAll(`#${tableId} tbody tr`).forEach(tr => {
        tr.hidden = cb.checked && +tr.dataset.count === 0;
      });
    });
  });
}

function renderInstalledTable(tableId, tbody, rows, hideZero){
  const filtered = hideZero ? rows.filter(r => r.gained !== 0) : rows;
  tbody.innerHTML = '';
  filtered.forEach(r => {
    const rowKey = `${tableId}::${r.player}::${r.name}::${r.instanceIndex || 0}::${r.turnInstalled}`;
    const expanded = !!expandState[rowKey];
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="card">${esc(r.name)}${r.instanceIndex ? ` <span class="instance-tag">#${esc(r.instanceIndex)}</span>` : ''}</td>` +
      `<td class="num">${fmt(r.turnInstalled)}</td>` +
      `<td class="num">${fmt(r.turnLeftDisplay)}</td>` +
      `<td class="num">${fmt(r.turnsInPlay)}</td>` +
      `<td class="num">${fmt(r.events)}</td>` +
      `<td class="num">${fmt(r.gained)}</td>` +
      `<td class="num">${fmt(r.cost)}</td>` +
      netCell(r.net) +
      `<td class="num"><button type="button" class="btn secondary" data-expand-toggle="${esc(rowKey)}" aria-expanded="${expanded}" aria-label="${expanded ? 'Hide' : 'Show'} details for ${esc(r.name)}">${expanded ? '\u2212' : '+'}</button></td>`;
    tbody.appendChild(tr);

    if (expanded){
      if (!r.triggerLog.length){
        const sub = document.createElement('tr');
        sub.className = 'sub-row';
        sub.innerHTML = `<td colspan="9">No individual triggers recorded for this card.</td>`;
        tbody.appendChild(sub);
      }
      r.triggerLog.forEach(ev => {
        const sub = document.createElement('tr');
        sub.className = 'sub-row';
        sub.innerHTML = `<td colspan="9">Turn ${ev.turn} — ${benefitLabel(ev.kind)}: ${fmt(ev.amount)}</td>`;
        tbody.appendChild(sub);
      });
    }
  });

  tbody.querySelectorAll('[data-expand-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.expandToggle;
      expandState[key] = !expandState[key];
      renderAllTables();
    });
  });

  return filtered.length;
}

function renderOpsTable(tableId, tbody, rows, hideZero){
  const filtered = hideZero ? rows.filter(r => r.totalGain !== 0) : rows;
  tbody.innerHTML = '';
  filtered.forEach((r, i) => {
    const rowKey = `${tableId}::${r.player}::${r.name}`;
    const expanded = !!expandState[rowKey];
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="card">${esc(r.name)}</td>` +
      `<td class="num">${fmt(r.triggered)}</td>` +
      `<td class="num">${fmt(r.totalCost)}</td>` +
      `<td class="num">${fmt(r.totalGain)}</td>` +
      netCell(r.totalNet) +
      `<td>${esc(r.turnsList)}</td>` +
      `<td class="num"><button type="button" class="btn secondary" data-expand-toggle="${esc(rowKey)}" aria-expanded="${expanded}" aria-label="${expanded ? 'Hide' : 'Show'} details for ${esc(r.name)}">${expanded ? '\u2212' : '+'}</button></td>`;
    tbody.appendChild(tr);

    if (expanded){
      r.perTurnRows.forEach(pt => {
        const sub = document.createElement('tr');
        sub.className = 'sub-row';
        sub.innerHTML =
          `<td>turn ${pt.turn}${pt.nth ? ` #${pt.nth}` : ''}</td>` +
          `<td></td>` +
          `<td class="num">${fmt(pt.cost)}</td>` +
          `<td class="num">${fmt(pt.gain)}</td>` +
          netCell(pt.net) +
          `<td></td><td></td>`;
        tbody.appendChild(sub);
      });
    }
  });

  tbody.querySelectorAll('[data-expand-toggle]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.expandToggle;
      expandState[key] = !expandState[key];
      renderAllTables();
    });
  });

  return filtered.length;
}

const installedCols = ['name','turnInstalled','turnLeftDisplay','turnsInPlay','events','gained','cost','net'];
const opsCols = ['name','triggered','totalCost','totalGain','totalNet','turnsList'];

function buildPlayerSections(data){
  const container = document.getElementById('playerSections');
  container.innerHTML = '';

  data.players.forEach((player, idx) => {
    const panel = document.createElement('div');
    panel.className = 'panel';

    const installedRows = sortRows(data.installedRows.filter(r => r.player === player), 'net', 'desc');
    const opsRows = sortRows(data.opsRows.filter(r => r.player === player), 'totalNet', 'desc');

    const instTableId = `installed-${idx}`;
    const opsTableId = `ops-${idx}`;

    const side = data.playerSide[player];
    const basicActionsTableId = `basicactions-${idx}`;
    const actionRowsHtml = basicActionRows(data, player, side).map(r => {
      const creditCell = r.credits === null ? '<td class="num">—</td>' : netCell(r.credits);
      const hiddenInitially = r.count === 0 ? ' hidden' : '';
      return `<tr data-count="${r.count}"${hiddenInitially}><td class="card">${esc(r.label)}</td><td class="num">${fmt(r.count)}</td>${creditCell}</tr>`;
    }).join('');

    const permTitle = side === 'corp' ? 'Rezzed cards' : (side === 'runner' ? 'Installed cards' : 'Installed &amp; rezzed cards');
    const opsTitle = side === 'corp' ? 'Operations' : (side === 'runner' ? 'Events' : 'Operations &amp; events');
    const permEmptyNote = side === 'corp' ? 'No rezzed cards to show.' : 'No installed cards to show.';
    const opsEmptyNote = side === 'corp' ? 'No operations generated credits for this side.' : 'No events generated credits for this side.';

    panel.innerHTML = `
      <div class="panel-header">
        <div class="player-head">
          <div class="player-name">${esc(player)}</div>
          <div class="player-sub">${data.maxTurn[player] || 0} turns taken</div>
        </div>
        <button type="button" class="collapse-icon" aria-expanded="true" aria-label="Collapse section">−</button>
      </div>
      <div class="panel-body">

      <div class="table-actions">
        <h3>Basic Actions</h3>
        <div class="controls">
          <label class="toggle"><input type="checkbox" data-hideuntriggered="${basicActionsTableId}" checked> Hide actions that weren’t triggered</label>
        </div>
      </div>
      <div class="table-scroll"><table class="mini-table" id="${basicActionsTableId}">
        <thead><tr><th>Action</th><th class="num">Times</th><th class="num">Credits</th></tr></thead>
        <tbody>${actionRowsHtml}</tbody>
      </table></div>

      <div class="table-actions">
        <h3>${permTitle}</h3>
        <div class="controls">
          <label class="toggle"><input type="checkbox" data-hidezero="${instTableId}" checked> Hide cards that gained no credits</label>
          <button class="btn secondary" data-export="${instTableId}">Export CSV</button>
        </div>
      </div>
      <div class="table-scroll"><table id="${instTableId}">
        <thead>
          <tr>
            <th data-key="name"><button type="button" class="th-sort">Card</button></th>
            <th class="num" data-key="turnInstalled"><button type="button" class="th-sort">In play from</button></th>
            <th class="num" data-key="turnLeftDisplay"><button type="button" class="th-sort">Left play</button></th>
            <th class="num" data-key="turnsInPlay"><button type="button" class="th-sort">Turns in play</button></th>
            <th class="num" data-key="events"><button type="button" class="th-sort">Triggers</button></th>
            <th class="num" data-key="gained"><button type="button" class="th-sort">Gained</button></th>
            <th class="num" data-key="cost"><button type="button" class="th-sort">Cost</button></th>
            <th class="num sorted" data-key="net" aria-sort="descending"><button type="button" class="th-sort">Net credits</button></th>
            <th class="num"><span class="visually-hidden">Details</span></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table></div>
      <div class="empty-note" data-empty="${instTableId}" hidden>${permEmptyNote}</div>

      <div class="table-actions">
        <h3>${opsTitle}</h3>
        <div class="controls">
          <label class="toggle"><input type="checkbox" data-hidezero="${opsTableId}" checked> Hide cards that gained no credits</label>
          <button class="btn secondary" data-export="${opsTableId}">Export CSV</button>
        </div>
      </div>
      <div class="table-scroll"><table id="${opsTableId}">
        <thead>
          <tr>
            <th data-key="name"><button type="button" class="th-sort">Card</button></th>
            <th class="num" data-key="triggered"><button type="button" class="th-sort">Triggered</button></th>
            <th class="num" data-key="totalCost"><button type="button" class="th-sort">Total cost</button></th>
            <th class="num" data-key="totalGain"><button type="button" class="th-sort">Total gain</button></th>
            <th class="num sorted" data-key="totalNet" aria-sort="descending"><button type="button" class="th-sort">Total net</button></th>
            <th data-key="turnsList"><button type="button" class="th-sort">Turns played</button></th>
            <th class="num"><span class="visually-hidden">Details</span></th>
          </tr>
        </thead>
        <tbody></tbody>
      </table></div>
      <div class="empty-note" data-empty="${opsTableId}" hidden>${opsEmptyNote}</div>

      </div>
    `;
    container.appendChild(panel);

    sortState[instTableId] = { key: 'net', dir: 'desc', rows: installedRows, type: 'installed' };
    sortState[opsTableId] = { key: 'totalNet', dir: 'desc', rows: opsRows, type: 'ops' };
    hideZeroState[instTableId] = true;
    hideZeroState[opsTableId] = true;
  });

  wireAllSorts();
  wireHideZeroToggles();
  wireBasicActionsToggles();
  JW.enablePanelCollapse(container);
  renderAllTables();
}

function renderAllTables(){
  Object.keys(sortState).forEach(tableId => {
    const state = sortState[tableId];
    const tbody = document.querySelector(`#${tableId} tbody`);
    const emptyEl = document.querySelector(`[data-empty="${tableId}"]`);
    const hideZero = hideZeroState[tableId];
    let shown;
    if (state.type === 'installed') shown = renderInstalledTable(tableId, tbody, state.rows, hideZero);
    else shown = renderOpsTable(tableId, tbody, state.rows, hideZero);
    if (emptyEl) emptyEl.hidden = !!shown;
  });
}

function wireHideZeroToggles(){
  document.querySelectorAll('[data-hidezero]').forEach(cb => {
    cb.addEventListener('change', () => {
      hideZeroState[cb.dataset.hidezero] = cb.checked;
      renderAllTables();
    });
  });
}

// Card names come from the log, so a text cell starting with = + - @ (or a tab / CR)
// is prefixed with ' to stop spreadsheets from running it as a formula.
function csvCell(v){
  let text = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

function wireAllSorts(){
  Object.keys(sortState).forEach(tableId => {
    const table = document.getElementById(tableId);
    const ths = table.querySelectorAll('th');
    ths.forEach(th => {
      if (!th.dataset.key) return;
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        const state = sortState[tableId];
        state.dir = (state.key === key && state.dir === 'desc') ? 'asc' : 'desc';
        state.key = key;
        state.rows = sortRows(state.rows, key, state.dir);
        ths.forEach(t => { t.classList.remove('sorted', 'sorted-asc'); t.removeAttribute('aria-sort'); });
        th.classList.add(state.dir === 'desc' ? 'sorted' : 'sorted-asc');
        th.setAttribute('aria-sort', state.dir === 'desc' ? 'descending' : 'ascending');
        renderAllTables();
      });
    });
  });

  document.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tableId = btn.dataset.export;
      const state = sortState[tableId];
      const cols = state.type === 'installed' ? installedCols : opsCols;
      const header = cols.join(',');
      const body = state.rows.map(r => cols.map(c => csvCell(r[c])).join(',')).join('\n');
      const csv = header + '\n' + body;
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${tableId}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  });
}

function renderFlagged(flagged){
  const list = document.getElementById('flaggedList');
  const empty = document.getElementById('flaggedEmpty');
  list.innerHTML = '';
  if (!flagged.length){ empty.hidden = false; return; }
  empty.hidden = true;
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = `${flagged.length} flagged line(s): parsing gaps, credit-tracking mismatches and undo commands`;
  details.appendChild(summary);
  flagged.forEach(f => {
    const div = document.createElement('div');
    div.className = 'flag-line';
    div.innerHTML = `<span class="reason">${esc(f.reason)}</span><br>${esc(f.line)}`;
    details.appendChild(div);
  });
  list.appendChild(details);
}

function renderLineChart(ids, series, players, rounds, opts){
  opts = opts || {};
  const legend = document.getElementById(ids.legend);
  const chartDiv = document.getElementById(ids.chart);
  const tableWrap = ids.table ? document.getElementById(ids.table) : null;
  legend.innerHTML = '';
  chartDiv.innerHTML = '';
  if (tableWrap) tableWrap.innerHTML = '';

  if (!rounds){ chartDiv.innerHTML = '<div class="empty-note">No turns detected.</div>'; return; }

  // Series now include an index-0 "game start" baseline (see buildSnapshotSeries
  // etc.), so read the whole array, not just indices 1..rounds.
  let maxVal = 1, minVal = 0;
  players.forEach(p => {
    const s = series[p];
    if (s){ maxVal = Math.max(maxVal, ...s); minVal = Math.min(minVal, ...s); }
  });
  if (opts.yTicks) maxVal = Math.max(maxVal, ...opts.yTicks);
  if (opts.minMaxVal !== undefined) maxVal = Math.max(maxVal, opts.minMaxVal);
  if (opts.referenceLines) maxVal = Math.max(maxVal, ...opts.referenceLines) * 1.05;
  if (maxVal === minVal) maxVal = minVal + 1;

  // Value labels need room above the top point and below the lowest one, so the
  // plot keeps its height and the canvas grows around it when they're shown.
  const labelsOn = valueLabelMode !== 'none';
  const W = 900, padL = 40, padR = 20, padT = labelsOn ? 30 : 16, padB = labelsOn ? 42 : 30;
  const H = 194 + padT + padB;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const tickY = padT + plotH + (labelsOn ? 28 : 16);
  // t now ranges 0..rounds (turn 0 = game start), so a single-turn game (rounds=1)
  // still spans two x positions (0 and 1) instead of collapsing to one dead center point.
  const xFor = t => padL + (rounds > 0 ? (t / rounds) * plotW : plotW / 2);
  const yFor = v => padT + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;

  let svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}">`;
  svg += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT+plotH}" stroke="var(--line)" />`;
  svg += `<line x1="${padL}" y1="${padT+plotH}" x2="${padL+plotW}" y2="${padT+plotH}" stroke="var(--line)" />`;
  svg += `<text x="${padL+plotW}" y="${labelsOn ? 12 : padT-4}" font-size="10" fill="var(--dim)" text-anchor="end">Last turn: ${rounds}</text>`;

  let tickVals;
  if (opts.cappedTicks){
    // Fixed base ticks (e.g. 0..6), plus one extra tick at the actual max only if it exceeds the base range.
    tickVals = opts.cappedTicks.slice();
    const base = tickVals[tickVals.length - 1];
    if (maxVal > base) tickVals.push(Math.round(maxVal));
  } else if (opts.yStep){
    tickVals = [];
    const start = Math.floor(minVal / opts.yStep) * opts.yStep;
    for (let v = start; v <= maxVal; v += opts.yStep) tickVals.push(v);
  } else if (opts.yTicks){
    tickVals = opts.yTicks;
  } else {
    tickVals = [];
    for (let i = 0; i <= 4; i++) tickVals.push(Math.round(minVal + ((maxVal - minVal) / 4) * i));
  }
  // yStep rounds the first tick down (e.g. -5 when the lowest value is -3),
  // which would land below the plot area; skip ticks outside the plotted range.
  tickVals = tickVals.filter(v => v >= minVal);
  tickVals.forEach(v => {
    const y = yFor(v);
    svg += `<text x="${padL - 8}" y="${y + 3}" font-size="9" fill="var(--dim)" text-anchor="end">${v}</text>`;
    svg += `<line x1="${padL}" y1="${y}" x2="${padL+plotW}" y2="${y}" stroke="var(--line)" stroke-dasharray="2,3" />`;
  });

  if (minVal < 0){
    const y0 = yFor(0);
    svg += `<line x1="${padL}" y1="${y0}" x2="${padL+plotW}" y2="${y0}" stroke="var(--dim)" stroke-width="1" />`;
  }

  if (opts.referenceLines){
    opts.referenceLines.forEach(v => {
      const y = yFor(v);
      svg += `<line x1="${padL}" y1="${y}" x2="${padL+plotW}" y2="${y}" stroke="var(--accent2)" stroke-dasharray="5,4" stroke-width="1.2" />`;
      svg += `<text x="${padL+plotW}" y="${y - 3}" font-size="9" fill="var(--accent2)" text-anchor="end">${v}</text>`;
    });
  }

  // Turn 0 (game start) is always shown as its own tick so it's clear the chart
  // begins at the baseline, not mid-game. opts.xLabels (e.g. "C1", "R1", "C2"...)
  // overrides the plain turn number for the sequential/alternative-axis charts.
  const xLabel = t => esc((opts.xLabels && opts.xLabels[t] !== undefined) ? (t === 0 ? 'Start' : opts.xLabels[t]) : (t === 0 ? '0' : t));
  // For the shared turn-order (xLabels) charts, labels alternate Corp/Runner
  // (C1, R1, C2, R2, ...). An even tick step would land on the same parity
  // every time and silently show only one side's letter across the whole
  // axis, so force an odd step here to keep both sides represented.
  let xTickStep = Math.max(1, Math.ceil(rounds / 12));
  if (opts.xLabels && xTickStep % 2 === 0) xTickStep += 1;
  for (let t = 0; t <= rounds; t += xTickStep){
    svg += `<text x="${xFor(t)}" y="${tickY}" font-size="9" fill="var(--dim)" text-anchor="middle">${xLabel(t)}</text>`;
  }
  if (rounds % xTickStep !== 0){
    svg += `<text x="${xFor(rounds)}" y="${tickY}" font-size="9" fill="var(--accent)" text-anchor="middle">${xLabel(rounds)}</text>`;
  }
  // Always show the very first turn pair (C1/R1) on the shared-order axis,
  // even if the step above would otherwise skip past it.
  if (opts.xLabels){
    [1, 2].forEach(t => {
      if (t <= rounds && t % xTickStep !== 0){
        svg += `<text x="${xFor(t)}" y="${tickY}" font-size="9" fill="var(--dim)" text-anchor="middle">${xLabel(t)}</text>`;
      }
    });
  }

  players.forEach((p, idx) => {
    const color = (opts.colors && opts.colors[idx]) || seriesColor(idx);
    const s = series[p];
    if (!s) return;
    if (opts.style === 'bar'){
      const barW = Math.max(2, (plotW / (rounds + 1)) / (players.length + 1));
      const y0 = yFor(0);
      for (let t = 1; t <= rounds; t++){
        const x = xFor(t) - barW * (players.length / 2) + barW * idx;
        const y = yFor(s[t]);
        svg += `<rect x="${x}" y="${Math.min(y, y0)}" width="${barW}" height="${Math.abs(y0 - y)}" fill="${color}" />`;
      }
    } else {
      let points = '';
      for (let t = 0; t <= rounds; t++) points += `${xFor(t)},${yFor(s[t])} `;
      svg += `<polyline points="${points.trim()}" fill="none" stroke="${color}" stroke-width="2" />`;
      // Explicit dots on every point: without these, a chart with very few turns
      // (esp. a 1-turn game, which is now a 2-point line from turn 0 to turn 1)
      // can read as an empty/near-invisible sliver. Dots make each value legible
      // regardless of how many turns there are.
      for (let t = 0; t <= rounds; t++){
        svg += `<circle cx="${xFor(t)}" cy="${yFor(s[t])}" r="2.5" fill="${color}" />`;
      }
    }
  });

  svg += renderValueLabels(series, players, rounds, opts, xFor, yFor, plotW);

  svg += `</svg>`;
  chartDiv.innerHTML = svg;

  players.forEach((p, idx) => {
    const color = (opts.colors && opts.colors[idx]) || seriesColor(idx);
    const div = document.createElement('div');
    div.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = color; // CSSOM, which the CSP allows (a style attribute isn't)
    div.append(swatch, p);
    legend.appendChild(div);
  });

  if (tableWrap){
    let tbl = '<div class="table-scroll"><table><thead><tr><th>Turn</th>';
    players.forEach(p => { tbl += `<th class="num">${esc(p)}</th>`; });
    tbl += '</tr></thead><tbody>';
    for (let t = 0; t <= rounds; t++){
      tbl += `<tr><td class="num">${xLabel(t)}</td>`;
      players.forEach(p => { tbl += `<td class="num">${esc(series[p] ? series[p][t] : 0)}</td>`; });
      tbl += '</tr>';
    }
    tbl += '</tbody></table></div>';
    tableWrap.innerHTML = tbl;
  }
}

// Small value numbers above each point, per valueLabelMode. Uses each player's
// chart colour; when both players sit on the same point (line charts, same value)
// a single grey label is drawn instead of two overlapping ones.
function renderValueLabels(series, players, rounds, opts, xFor, yFor, plotW){
  if (valueLabelMode === 'none') return '';
  const colorOf = idx => (opts.colors && opts.colors[idx]) || seriesColor(idx);
  const isBar = opts.style === 'bar';
  const startT = isBar ? 1 : 0;
  const shows = (s, t) => valueLabelMode === 'all' || t === startT || s[t] !== s[t - 1];
  const label = (x, y, v, color) =>
    `<text x="${x}" y="${y}" font-size="9" fill="${color}" text-anchor="middle" ` +
    `stroke="var(--panel)" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${esc(v)}</text>`;
  let out = '';
  for (let t = startT; t <= rounds; t++){
    const pts = [];
    players.forEach((p, idx) => {
      const s = series[p];
      if (s && s[t] !== undefined) pts.push({ idx, v: s[t], show: shows(s, t) });
    });
    if (!pts.some(pt => pt.show)) continue;
    if (isBar){
      const barW = Math.max(2, (plotW / (rounds + 1)) / (players.length + 1));
      pts.forEach(pt => {
        if (!pt.show) return;
        const x = xFor(t) - barW * (players.length / 2) + barW * pt.idx + barW / 2;
        const y = pt.v < 0 ? yFor(pt.v) + 10 : yFor(pt.v) - 4;
        out += label(x, y, pt.v, colorOf(pt.idx));
      });
      continue;
    }
    const x = xFor(t);
    if (pts.length > 1 && pts.every(pt => pt.v === pts[0].v)){
      out += label(x, yFor(pts[0].v) - 6, pts[0].v, VALUE_LABEL_SHARED_COLOR);
      continue;
    }
    // Different values at the same turn: the highest goes above its dot, the
    // others below theirs, so close values don't print on top of each other.
    const maxV = Math.max(...pts.map(pt => pt.v));
    pts.forEach(pt => {
      if (!pt.show) return;
      const above = pts.length === 1 || pt.v === maxV;
      out += label(x, above ? yFor(pt.v) - 6 : yFor(pt.v) + 13, pt.v, colorOf(pt.idx));
    });
  }
  return out;
}

function syncValueLabelToggles(){
  document.querySelectorAll('.value-labels-toggle').forEach(btn => {
    btn.dataset.mode = valueLabelMode;
    btn.setAttribute('aria-pressed', String(valueLabelMode !== 'none'));
    btn.textContent = 'values: ' + valueLabelMode;
  });
}

function renderAllCharts(data){
  const colors = getChartColors(data);
  const totalTurnsEl = document.getElementById('seqTotalTurnsNum');
  if (totalTurnsEl) totalTurnsEl.textContent = data.totalSeq || 0;
  const mainTotalTurnsEl = document.getElementById('mainTotalTurnsNum');
  if (mainTotalTurnsEl) mainTotalTurnsEl.textContent = data.totalSeq || 0;
  renderLineChart(
    { legend: 'agendaLegend', chart: 'agendaChart', table: 'agendaTableWrap' },
    data.agendaSeries, data.players, data.rounds, { colors, yStep: 1, minMaxVal: 7 }
  );
  renderLineChart(
    { legend: 'creditsGainedLegend', chart: 'creditsGainedChart', table: 'creditsGainedTableWrap' },
    data.creditsNetSeries, data.players, data.rounds, { style: 'bar', colors, yStep: 5 }
  );
  renderLineChart(
    { legend: 'creditPoolLegend', chart: 'creditPoolChart', table: 'creditPoolTableWrap' },
    data.creditPoolSeries, data.players, data.rounds, { colors, yStep: 5 }
  );
  renderLineChart(
    { legend: 'handSizeLegend', chart: 'handSizeChart', table: 'handSizeTableWrap' },
    data.handSizeSeries, data.players, data.rounds, { colors, cappedTicks: [0, 1, 2, 3, 4, 5, 6] }
  );
  renderLineChart(
    { legend: 'cardsDrawnLegend', chart: 'cardsDrawnChart', table: 'cardsDrawnTableWrap' },
    data.cardsDrawnSeries, data.players, data.rounds, { colors, yStep: 10, referenceLines: [40, 45, 49] }
  );

  // Same five metrics, replotted against the shared turn-order axis (see the
  // "Alternative: shared turn order" panel) instead of each player's own turn number.
  const seqOpts = { colors, xLabels: data.seqAxisLabels };
  renderLineChart(
    { legend: 'agendaSeqLegend', chart: 'agendaSeqChart', table: 'agendaSeqTableWrap' },
    data.agendaSeqSeries, data.players, data.totalSeq, Object.assign({}, seqOpts, { yStep: 1, minMaxVal: 7 })
  );
  renderLineChart(
    { legend: 'creditsGainedSeqLegend', chart: 'creditsGainedSeqChart', table: 'creditsGainedSeqTableWrap' },
    data.creditsNetSeqSeries, data.players, data.totalSeq, Object.assign({}, seqOpts, { style: 'bar', yStep: 5 })
  );
  renderLineChart(
    { legend: 'creditPoolSeqLegend', chart: 'creditPoolSeqChart', table: 'creditPoolSeqTableWrap' },
    data.creditPoolSeqSeries, data.players, data.totalSeq, Object.assign({}, seqOpts, { yStep: 5 })
  );
  renderLineChart(
    { legend: 'handSizeSeqLegend', chart: 'handSizeSeqChart', table: 'handSizeSeqTableWrap' },
    data.handSizeSeqSeries, data.players, data.totalSeq, Object.assign({}, seqOpts, { cappedTicks: [0, 1, 2, 3, 4, 5, 6] })
  );
  renderLineChart(
    { legend: 'cardsDrawnSeqLegend', chart: 'cardsDrawnSeqChart', table: 'cardsDrawnSeqTableWrap' },
    data.cardsDrawnSeqSeries, data.players, data.totalSeq, Object.assign({}, seqOpts, { yStep: 10, referenceLines: [40, 45, 49] })
  );
}

function renderGameStats(data){
  const wrap = document.getElementById('gameStatsWrap');
  const players = data.players;
  if (players.length < 1){ wrap.innerHTML = ''; return; }

  const rows = [];
  rows.push(['Credits gained', p => fmt(data.totalGained[p] || 0)]);
  rows.push(['Credits spent', p => fmt(data.totalSpent[p] || 0)]);
  rows.push(['Credits by basic action', p => fmt((data.clickCredits[p] || {}).gained || 0)]);
  rows.push(['Cards drawn', p => fmt(data.totalDraws[p] || 0)]);
  rows.push(['Cards drawn by basic action', p => fmt(data.drawClicks[p] || 0)]);
  rows.push(['Clicks gained from cards', p => fmt(data.clicksGained[p] || 0)]);
  rows.push(['Cards rezzed', p => data.playerSide[p] === 'corp' ? fmt(data.cardsRezzed[p] || 0) : '—']);
  rows.push(['Tags gained', p => data.playerSide[p] === 'runner' ? fmt(data.tagsGained[p] || 0) : '—']);
  rows.push(['Runs made', p => data.playerSide[p] === 'runner' ? fmt(data.runsMade[p] || 0) : '—']);
  rows.push(['Events played', p => data.playerSide[p] === 'runner' ? fmt(data.eventsPlayed[p] || 0) : '—']);
  rows.push(['Cards accessed — HQ', p => data.playerSide[p] === 'runner' ? fmt((data.cardsAccessed[p] || {}).HQ || 0) : '—']);
  rows.push(['Cards accessed — R&D', p => data.playerSide[p] === 'runner' ? fmt((data.cardsAccessed[p] || {}).RD || 0) : '—']);
  rows.push(['Cards accessed — remote servers', p => data.playerSide[p] === 'runner' ? fmt((data.cardsAccessed[p] || {}).remote || 0) : '—']);
  rows.push(['Times accessed HQ', p => data.playerSide[p] === 'runner' ? fmt((data.breachCounts[p] || {}).HQ || 0) : '—']);
  rows.push(['Times accessed R&D', p => data.playerSide[p] === 'runner' ? fmt((data.breachCounts[p] || {}).RD || 0) : '—']);
  rows.push(['Times accessed Archives', p => data.playerSide[p] === 'runner' ? fmt((data.breachCounts[p] || {}).Archives || 0) : '—']);

  let tbl = '<div class="table-scroll"><table class="mini-table"><thead><tr><th>Stat</th>';
  players.forEach(p => { tbl += `<th class="num">${esc(p)}</th>`; });
  tbl += '</tr></thead><tbody>';
  rows.forEach(([label, fn]) => {
    tbl += `<tr><td class="card">${esc(label)}</td>`;
    players.forEach(p => { tbl += `<td class="num">${fn(p)}</td>`; });
    tbl += '</tr>';
  });
  tbl += '</tbody></table></div>';
  wrap.innerHTML = tbl;
}

function runParse(){
  const text = logInput.value;
  if (!text.trim()){
    statusMsg.textContent = 'Paste a log first.';
    return;
  }
  currentData = parseLog(text);
  if (currentData.playerCountError){
    results.hidden = true;
    statusMsg.textContent = '⚠ ' + currentData.playerCountError;
    statusMsg.classList.add('error');
    return;
  }
  statusMsg.classList.remove('error');
  renderSummary(currentData);
  renderGameStats(currentData);
  renderAllCharts(currentData);
  buildPlayerSections(currentData);
  renderFlagged(currentData.flagged);
  results.hidden = false;
  statusMsg.textContent = `Parsed ${text.trim().split(/\r?\n/).length} lines. Players: ${currentData.players.join(', ')}`;
}

JW.mountThemeSwitcher(document.getElementById('theme-switcher'));
JW.mountModeToggle(document.getElementById('mode-toggle'));
// Collapsible panels use the design system's helper, like Market Research; the per-player
// panels are added after each parse (buildPlayerSections).
JW.enablePanelCollapse();
document.addEventListener('jw:themechange', () => {
  if (currentData && !currentData.playerCountError) renderAllCharts(currentData);
});

document.addEventListener('click', (e) => {
  if (e.target.closest('.value-labels-toggle')){
    valueLabelMode = VALUE_LABEL_MODES[(VALUE_LABEL_MODES.indexOf(valueLabelMode) + 1) % VALUE_LABEL_MODES.length];
    try { localStorage.setItem('valueLabelMode', valueLabelMode); } catch (err) {}
    syncValueLabelToggles();
    if (currentData && !currentData.playerCountError) renderAllCharts(currentData);
  }
});

function warnAgainstBookmarkletClick(e){
  e.preventDefault();
  alert('Drag this button to your bookmarks bar instead of clicking it — clicking it here on this page won\'t find a jinteki.net game log.');
  return false;
}
document.getElementById('bookmarkletBtn').addEventListener('click', warnAgainstBookmarkletClick);

// The bookmarklet's href hardcodes https://jinteki.win/trace/ as its target. When
// the page is served from somewhere else over http(s) — e.g. the test Worker
// on workers.dev — point it at that origin instead, so a bookmark dragged
// from the test site opens games in the test site rather than production.
// Opened as a local file, there's no origin to point at, so it keeps prod.
(function retargetBookmarklet(){
  if (!/^https?:$/.test(location.protocol) || location.hostname === 'jinteki.win') return;
  const btn = document.getElementById('bookmarkletBtn');
  const prod = encodeURIComponent('"https://jinteki.win/trace/#log="');
  const here = encodeURIComponent('"' + location.origin + '/trace/#log="');
  btn.setAttribute('href', btn.getAttribute('href').replace(prod, here));
})();

document.getElementById('skipCopyPasteBtn').addEventListener('click', () => {
  const section = document.getElementById('bookmarkSection');
  const btn = document.getElementById('skipCopyPasteBtn');
  const showing = !section.hidden;
  section.hidden = showing;
  btn.textContent = showing ? 'How to skip copy-paste' : 'Hide Bookmark info';
  btn.setAttribute('aria-expanded', String(!showing));
});

syncValueLabelToggles();

document.getElementById('parseBtn').addEventListener('click', runParse);
// The example logs live in examples.js, loaded on the first click only. A <script>
// tag rather than fetch() so it also works when the page is opened as a local file.
let examplesPromise = null;
function loadExamples(){
  if (globalThis.TRACE_EXAMPLES) return Promise.resolve(globalThis.TRACE_EXAMPLES);
  if (!examplesPromise){
    examplesPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'examples.js';
      script.addEventListener('load', () => resolve(globalThis.TRACE_EXAMPLES));
      script.addEventListener('error', () => {
        examplesPromise = null;
        script.remove();
        reject(new Error('Could not load the example logs.'));
      });
      document.body.appendChild(script);
    });
  }
  return examplesPromise;
}
function showExample(key){
  loadExamples().then(examples => {
    logInput.value = examples[key];
    runParse();
  }, e => {
    statusMsg.textContent = e.message;
  });
}
document.getElementById('example1Btn').addEventListener('click', () => showExample('example1'));
document.getElementById('example2Btn').addEventListener('click', () => showExample('example2'));
document.getElementById('clearBtn').addEventListener('click', () => {
  logInput.value = '';
  results.hidden = true;
  statusMsg.textContent = '';
});

// ---- Shareable link: gzip-compress the log, base64url-encode it into the URL hash
// (never sent to any server) so a whole game log can be shared as a link with no
// copy-paste on the recipient's end and no backend to store anything in.
//
// DISCLAIMER: nothing is "shared" in the sense of a server storing it — the
// entire encoded game log is embedded directly in the URL itself, after the
// #. Anyone who receives this link can open it and see the full log content
// (players' actions, card names, etc.), so treat the link exactly as you
// would the log text: don't post it anywhere you wouldn't paste the log.
//
// The link always points at the real hosted address, not wherever this
// copy of the page happens to be running from (e.g. a local file or a dev
// server) — otherwise a link built while testing locally would be useless
// to anyone else.
const HOSTED_SITE_URL = 'https://jinteki.win/trace/';

function bytesToBase64Url(bytes){
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk){
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(b64){
  let padded = b64.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4) padded += '=';
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gzipBytes(bytes){
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

// Same cap as the shortener (MAX_DECODED_BYTES in src/validate.js): a crafted
// link could otherwise decompress to gigabytes and hang the tab.
const MAX_DECODED_LOG_BYTES = 2 * 1024 * 1024;
const LOG_TOO_LARGE = 'This log is larger than 2 MB once decoded, which is more than any real game log.';

async function gunzipBytes(bytes){
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let total = 0;
  for (;;){
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DECODED_LOG_BYTES){
      await reader.cancel();
      throw new Error(LOG_TOO_LARGE);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks){ out.set(c, offset); offset += c.length; }
  return out;
}

async function encodeLogForUrl(text){
  const utf8 = new TextEncoder().encode(text);
  if (window.CompressionStream){
    const bytes = await gzipBytes(utf8);
    return 'gz.' + bytesToBase64Url(bytes);
  }
  return 'raw.' + bytesToBase64Url(utf8);
}

async function decodeLogFromUrl(encoded){
  const dot = encoded.indexOf('.');
  const method = encoded.slice(0, dot);
  const bytes = base64UrlToBytes(encoded.slice(dot + 1));
  if (method === 'gz'){
    if (!window.DecompressionStream){
      throw new Error("This link uses compression your browser can't decode — try a recent Chrome, Edge, or Firefox.");
    }
    const outBytes = await gunzipBytes(bytes);
    return new TextDecoder().decode(outBytes);
  }
  if (bytes.length > MAX_DECODED_LOG_BYTES) throw new Error(LOG_TOO_LARGE);
  return new TextDecoder().decode(bytes);
}

document.getElementById('permalinkBtn').addEventListener('click', async () => {
  const text = logInput.value;
  const permalinkRow = document.getElementById('permalinkRow');
  const shareInput = document.getElementById('permalinkUrlInput');
  if (!text.trim()){
    statusMsg.textContent = 'Paste a log first.';
    return;
  }
  try {
    const encoded = await encodeLogForUrl(text);
    const url = HOSTED_SITE_URL + '#log=' + encoded;
    shareInput.value = url;
    permalinkRow.hidden = false;
    shareInput.select();
    statusMsg.textContent = `Share link ready (${Math.round(url.length / 1024 * 10) / 10} KB). Note: the whole log is embedded in this link, not stored on a server — anyone with the link can read the full log content, so share it the same way you'd share the log itself.`;
  } catch (e) {
    statusMsg.textContent = 'Could not build a share link: ' + e.message;
  }
});

// ---- Report a bug: opens a prefilled GitHub issue. The log link is built
// the same way the plain "Share link" button does (compressed + embedded in
// the URL fragment, never sent anywhere) and dropped into the issue body —
// but that means a big log can make the resulting GitHub URL too long for
// the browser/GitHub to accept as a prefill, so past a size threshold this
// falls back to copying the template (share link included) to the
// clipboard and opening a blank issue for the user to paste it into.
const BUG_REPORT_TEMPLATE = (logLine) => `**What is the problem:**\n\n\n**How it is now:**\n\n\n**How it is expected to be:**\n\n\n**Link to the log:** ${logLine}\n`;
const NEW_ISSUE_URL = 'https://github.com/adamstradomski/jinteki-analyzer/issues/new';

document.getElementById('reportBugBtn').addEventListener('click', async () => {
  const text = logInput.value;
  let logLine = '(no log pasted — paste your log first so a share link can be included automatically)';
  if (text.trim()){
    try {
      const encoded = await encodeLogForUrl(text);
      logLine = HOSTED_SITE_URL + '#log=' + encoded;
    } catch (e) {
      logLine = '(could not build a share link: ' + e.message + ')';
    }
  }
  const body = BUG_REPORT_TEMPLATE(logLine);
  const prefillUrl = NEW_ISSUE_URL + '?title=' + encodeURIComponent('Bug report') + '&body=' + encodeURIComponent(body);
  if (prefillUrl.length > 8000){
    window.open(NEW_ISSUE_URL, '_blank');
    try {
      await navigator.clipboard.writeText(body);
      statusMsg.textContent = 'The log is too large to prefill via link — opened a blank issue instead and copied the bug report template (with share link) to your clipboard. Paste it in.';
    } catch (e) {
      statusMsg.textContent = "The log is too large to prefill via link, and the template couldn't be copied automatically (" + e.message + '). Opened a blank issue — copy the share link from the "Share link" button above and paste it in manually.';
    }
  } else {
    window.open(prefillUrl, '_blank');
  }
});

document.getElementById('copyPermalinkBtn').addEventListener('click', () => {
  const shareInput = document.getElementById('permalinkUrlInput');
  shareInput.select();
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(shareInput.value);
  } else {
    document.execCommand('copy');
  }
  statusMsg.textContent = 'Link copied.';
});

// ---- Optional: shorten the share link via jinteki.win's own shortener
// (src/ in the repo, run by the same Cloudflare Worker that serves this page). This is opt-in only
// (button click), because unlike the plain share link above — which never
// leaves the browser — shortening stores the encoded log on the server so
// jinteki.win/s/<id> can redirect back to it. If the shortener is
// unavailable (rate limit, free-tier quota, or the page isn't served from
// jinteki.win), the long link keeps working and stays in the box.
// Same Worker serves the page and the API, so production and test
// instances each talk to their own shortener and database.
const SHORTEN_API_URL = '/api/shorten';
document.getElementById('shortenPermalinkBtn').addEventListener('click', async () => {
  const shareInput = document.getElementById('permalinkUrlInput');
  const longUrl = shareInput.value;
  const marker = longUrl.indexOf('#log=');
  if (!longUrl || marker === -1){
    statusMsg.textContent = 'Build a share link first.';
    return;
  }
  const shortenBtn = document.getElementById('shortenPermalinkBtn');
  shortenBtn.disabled = true;
  const prevLabel = shortenBtn.textContent;
  shortenBtn.textContent = 'Shortening…';
  statusMsg.textContent = 'Creating a short link…';
  try {
    const resp = await fetch(SHORTEN_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: longUrl.slice(marker + 5) }),
    });
    let data = {};
    try { data = await resp.json(); } catch (_) {}
    if (resp.status === 429) throw new Error('too many requests, try again in a minute');
    if (!resp.ok || !data.url) throw new Error(data.error || ('HTTP ' + resp.status));
    shareInput.value = data.url;
    shareInput.select();
    statusMsg.textContent = 'Short link ready. The log is stored on jinteki.win, so anyone with this link can open it.';
  } catch (e) {
    statusMsg.textContent = "Couldn't shorten it (" + e.message + '). The long share link above still works.';
  } finally {
    shortenBtn.disabled = false;
    shortenBtn.textContent = prevLabel;
  }
});

(async function loadFromUrlHash(){
  const hash = location.hash;
  if (!hash.startsWith('#log=')) return;
  const encoded = hash.slice(5);
  // Reserve #results' space up front (synchronously, before the await below
  // yields) so revealing it after decode/parse doesn't cause a large CLS hit.
  // The overlay hides this from view entirely; it's still worth doing so the
  // shift doesn't get measured, since CLS doesn't know it was occluded.
  results.classList.add('loading');
  results.hidden = false;
  try {
    statusMsg.textContent = 'Decoding shared log…';
    const text = await decodeLogFromUrl(decodeURIComponent(encoded));
    logInput.value = text;
    runParse();
    statusMsg.textContent += ' Loaded from shared link.';
  } catch (e) {
    results.hidden = true;
    statusMsg.textContent = 'Could not load the log from this link: ' + e.message;
  } finally {
    results.classList.remove('loading');
    // Reveal the finished page (or the error state) in one go, rather than
    // the overlay disappearing mid-render.
    document.getElementById('hashLoadOverlay').style.display = 'none';
  }
})();
