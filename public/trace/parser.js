// Trace parser: turns a pasted jinteki.net game log into the stats, series and
// flags that app.js renders. Pure data in, data out: no DOM, no network, no
// storage, so it also runs in Node (see test/trace/). Loaded as a classic script
// before app.js (the page must keep working opened as a local file, so no ES
// modules); everything it exports hangs off globalThis.TraceParser.
(function(){
'use strict';

const CLICK_GAIN_OVERRIDES = { 'nanomanagement': 2 };

// Agenda point values, sourced from NetrunnerDB (https://netrunnerdb.com/search_new/?q=t%3Aagenda).
// Used only to fill in points for agendas silently added to a score area by another
// card's effect (e.g. Regenesis revealing an agenda from Archives) — the log never
// states the point value for those, unlike a normal steal/score. This list only needs
// to cover agendas that can be revealed this way; it is not a full agenda card list.
const AGENDA_POINTS = {
  'regenesis': 1,
  'fujii asset retrieval': 3,
  'sisyphus protocol': 2,
  'longevity serum': 2,
  'hybrid release': 1,
  'blood in the water': 2,
  'let them dream': 2,
  'send a message': 3
};

// Words that signal the start of appended ability/effect text rather than part of a
// card name. Card names are always Title Case, so a run of lowercase words (or one of
// these specific stop-words, lowercase) marks the boundary — used as a safety net for
// any regex whose capture wasn't already bounded by a known stop-phrase.
const NAME_BOUNDARY_STOPWORDS = new Set([
  'to','gain','gains','draw','draws','trash','trashes','give','gives','place','places',
  'choose','chooses','reveal','reveals','deal','deals','remove','removes','removed',
  'force','forces','look','looks','search','searches','add','adds','install','installs',
  'rez','rezzes','resolve','resolves','break','breaks','pay','pays','spend','spends',
  'take','takes','host','hosts','shuffle','shuffles','discard','discards','score','scores',
  'steal','steals','access','accesses','breach','breaches','approach','approaches',
  'encounter','encounters','pass','passes','continue','continues','indicate','indicates',
  'decline','declines','make','makes','use','uses','swap','swaps','expose','exposes',
  'derez','derezzes','advance','advances','increase','increases','lose','loses',
  'suffer','suffers'
]);

function extractCardNamePrefix(raw){
  const words = raw.trim().split(/\s+/).filter(Boolean);
  const result = [];
  let pendingConnectors = [];
  for (const w of words){
    const isCapOrSymbol = /^[A-Z0-9"]/.test(w);
    if (!isCapOrSymbol){
      // Only a genuinely lowercase word can be ability text — a capitalized word
      // that happens to match a stop-word (e.g. "Access" in "Public Access Plaza")
      // is part of the name, not appended text, so it's never treated as a boundary.
      const lower = w.toLowerCase().replace(/[^a-z]/g, '');
      if (NAME_BOUNDARY_STOPWORDS.has(lower)) break;
      pendingConnectors.push(w);
    } else {
      result.push(...pendingConnectors, w);
      pendingConnectors = [];
    }
  }
  return result.length ? result.join(' ') : raw.trim();
}

function cleanCardName(raw){
  let s = raw.replace(/\.$/, '').trim();
  s = s.replace(/\(paying\s*\d+\s*less\)/i, '').trim();
  s = s.replace(/\s+on\s+.+$/i, '').trim();
  // Strip a trailing zone reference like "from the Grip" / "from HQ" / "from
  // Archives" / "from R&D" / "from the root of Server 3" — this describes
  // where the card came from, not part of its name. "from" alone isn't a
  // safe universal stop-word for extractCardNamePrefix below (it's lowercase,
  // but the zone name right after it is capitalized, so the lowercase-word
  // boundary check never triggers), so it's handled here as its own scoped step.
  s = s.replace(/\s+from\s+(?:the\s+)?(?:Grip|HQ|R&D|Archives|root(?:\s+of\s+.+)?)\b.*$/i, '').trim();
  s = extractCardNamePrefix(s);
  return s;
}

function extractChatBadges(lines){
  const GLHF_RE = /\b(glhf|gl\s*hf|good luck|have fun)\b/i;
  const GG_RE = /\bgg\b/i;
  const TY_RE = /\b(ty4tg|tftg|thank you for the game|thanks for the game|thank you)\b/i;
  // Easter egg. No \b: it fails next to Polish letters, and the inflected
  // forms (kurwy, kurwą, …) should count too.
  const KURWA_RE = /kurw[aąeęioy]/i;
  // System command lines look like "!<player> uses a command: /save-replay" —
  // not a chat message, so it's matched against the raw line directly rather
  // than through the username-repeat chat pattern below.
  const SAVE_REPLAY_RE = /^!(.+?)\s+uses a command:\s*\/save-replay\b/i;
  const badges = {};
  function ensureBadge(player){
    if (!badges[player]) badges[player] = { glhf: false, gg: false, ty: false, savedReplay: false, kurwa: false };
    return badges[player];
  }
  for (let i = 0; i < lines.length - 2; i++){
    if (lines[i] === lines[i+1] && /^[^\s.]+$/.test(lines[i]) && lines[i].length < 40){
      const player = lines[i];
      const text = lines[i+2];
      const b = ensureBadge(player);
      if (GLHF_RE.test(text)) b.glhf = true;
      if (GG_RE.test(text)) b.gg = true;
      if (TY_RE.test(text)) b.ty = true;
      if (KURWA_RE.test(text)) b.kurwa = true;
    }
  }
  for (const line of lines){
    const sm = line.match(SAVE_REPLAY_RE);
    if (sm) ensureBadge(sm[1].trim()).savedReplay = true;
  }
  return badges;
}

// The "Analyze this game" bookmarklet reads the log straight out of the DOM with
// textContent, which — unlike a manual click-and-drag copy — doesn't insert any
// whitespace at element boundaries. jinteki.net's log panel renders each system
// line's timestamp as its own element sitting right next to the actor's name, so
// textContent glues them together with no space: "viljums[22:40:21] has created
// the game." instead of "viljums has created the game.". Left alone, every verb
// regex below (which anchors on "Name<space>verb") captures "viljums[22:40:21]"
// as the player name, silently minting a new bogus player per timestamp. Strip
// any "[H:MM:SS]"/"[HH:MM:SS]" that's glued directly onto a preceding non-space
// character (a real standalone timestamp marker line, used by the manual-copy
// format below, always has only whitespace or nothing before its bracket, so
// this never touches those).
function stripInlineTimestamps(text){
  return text.replace(/(\S)\[\d{1,2}:\d{2}:\d{2}\]/g, '$1');
}

// Some paste sources (e.g. copying from the jinteki.net game log panel with
// timestamps visible) split each log entry across multiple lines:
//   PlayerName
//   [HH:MM:SS]
//    rest of the message (leading space kept from the original "Name message" text)
// or, for chat lines, the timestamp is simply inserted into the existing
// Name / Name / message triplet. This reconstructs the normal single-line-per-entry
// format so the rest of the parser doesn't need to know timestamps exist at all.
function reconstructTimestampedLog(text){
  const rawLines = text.split(/\r?\n/);
  const hasTimestamps = rawLines.some(l => /^\s*\[\d{1,2}:\d{2}:\d{2}\]\s*$/.test(l));
  if (!hasTimestamps) return text;

  const cleaned = [];
  for (const raw of rawLines){
    if (/^\s*\[\d{1,2}:\d{2}:\d{2}\]\s*$/.test(raw)) continue; // drop timestamp marker lines
    if (raw.trim() === '') continue; // drop now-blank lines
    cleaned.push(raw);
  }

  // A line that's followed by a line starting with whitespace is a "Name" line whose
  // message continuation got split off after the timestamp — rejoin them. A line
  // followed by a non-indented line (e.g. the repeated name in a chat triplet) is left
  // alone so the existing chat-badge detection still sees its normal Name/Name/message shape.
  const merged = [];
  let i = 0;
  while (i < cleaned.length){
    const line = cleaned[i];
    const next = cleaned[i + 1];
    if (next !== undefined && /^[ \t]+\S/.test(next)){
      merged.push(line.trim() + next);
      i += 2;
    } else {
      merged.push(line);
      i += 1;
    }
  }
  return merged.join('\n');
}

// jinteki.net substitutes each player's chosen pronoun into its generated log
// text ("X started <pronoun> turn 1 ...") — see select-pronoun in mtgred/netrunner
// src/clj/game/core/say.clj. Every regex that matches a pronoun is built from this.
const PRONOUN = '(?:his|her|their|its|faer|nir|vis|eir|hir|zir|xyr|xir)';

// Turn boundary lines: "X started <pronoun> turn 3 with 5 and 4 cards in HQ." /
// "X is ending <pronoun> turn 3 with 2 and 5 cards in HQ." Groups: player, turn,
// then credits and hand size, which are undefined when the line doesn't carry
// them in the usual form (the undo pass only needs the player and turn).
const turnStartRe = new RegExp(String.raw`^(.+?)\s+started ${PRONOUN} turn (\d+) with\b(?: (\d+)\s+and (\d+) cards? in)?`);
const turnEndRe = new RegExp(String.raw`^(.+?)\s+is ending ${PRONOUN} turn (\d+) with\b(?: (\d+)\s+and (\d+) cards? in)?`);

// ---- Undo commands ----
// jinteki.net's /undo-click and /undo-paid-ability reset the game to a saved
// state, but the log keeps everything printed since. The lines describing
// what was taken back (credits, draws, tags, or a whole run with its rezzes,
// subroutines and credits) would otherwise all be counted. Where the undo
// went back to isn't always visible, though: the undone action or ability
// may have been cancelled mid-resolution, before it printed anything, and
// then removing the previous logged action would be wrong. So every undo is
// resolved by trying each reading of it (nothing taken back, or everything
// from a candidate starting line), re-parsing, and keeping the reading whose
// derived credit pools match the exact values printed at the next turn
// boundary for both players. When the totals can't tell readings apart the
// likeliest one is kept. Either way every undo is flagged.
const UNDO_CLICK_RE = /^\[?!\]?\s*(Corp|Runner) uses the undo-click command\b/i;
const UNDO_PAID_RE = /^\[?!\]?\s*(Corp|Runner) uses the undo-paid-ability command\b/i;
// A click action's first line: "X spends to ...", "X spends and pays N
// to ...", "X spends and spends 1 hosted ..." (the click icon itself is
// lost when the log is copied). A bare "spends 1 hosted counter" is a
// paid ability, not a click action. A run started by a click begins here
// too, so undoing that click takes back the whole run.
const CLICK_ACTION_RE = /^\s+spends\s+(?:to|and)\b/;

// Applies one reading per undo and returns the remaining lines plus what
// each undo did. decisions[i] is -1 for "nothing taken back" or the index of
// the starting line among that undo's candidates (likeliest first).
function applyUndos(lines, decisions){
  const players = new Set();
  lines.forEach(l => { const m = l.match(turnStartRe); if (m) players.add(m[1].trim()); });
  const byPlayer = l => [...players].some(p => l.startsWith(p + ' '));
  const kept = [];
  const undos = [];
  let active = null;
  let turn = 0;
  let clickStarts = [];  // kept indices of this turn's click actions (the engine keeps the last 4)
  let abilityFloor = 0;  // an ability undo can't reach back past the last action or turn boundary
  for (let i = 0; i < lines.length; i++){
    const line = lines[i];
    let m;
    const cm = line.match(UNDO_CLICK_RE);
    const pm = cm ? null : line.match(UNDO_PAID_RE);
    if (cm || pm){
      const kind = cm ? 'click' : 'paid';
      let candidates;
      if (kind === 'click'){
        candidates = clickStarts.length ? [clickStarts[clickStarts.length - 1]] : [];
      } else {
        // Any player line since the last action, nearest first; but if the
        // player's next line repeats one of them (redoing that ability
        // properly), that one is the likeliest start.
        candidates = [];
        for (let k = kept.length - 1; k >= abilityFloor && candidates.length < 8; k--){
          if (byPlayer(kept[k])) candidates.push(k);
        }
        const redo = lines.slice(i + 1).find(byPlayer);
        const r = candidates.findIndex(k => kept[k] === redo);
        if (r > 0) candidates.unshift(candidates.splice(r, 1)[0]);
      }
      const d = decisions[undos.length] === undefined ? 0 : decisions[undos.length];
      const from = d >= 0 && d < candidates.length ? candidates[d] : null;
      const removed = from === null ? [] : kept.splice(from);
      if (from !== null){
        if (kind === 'click') clickStarts.pop();
        clickStarts = clickStarts.filter(k => k < kept.length);
        abilityFloor = Math.min(abilityFloor, kept.length);
      }
      undos.push({ kind, side: (cm || pm)[1], line, active, turn, at: kept.length,
        candidates: candidates.length, decision: from === null ? -1 : d, removed });
      continue;
    }
    if ((m = line.match(turnStartRe))){
      active = m[1].trim();
      turn = +m[2];
      clickStarts = [];
      abilityFloor = kept.length + 1;
    } else if (turnEndRe.test(line)){
      abilityFloor = kept.length + 1;
    } else if (active && line.startsWith(active + ' ') && CLICK_ACTION_RE.test(line.slice(active.length))){
      clickStarts.push(kept.length);
      if (clickStarts.length > 4) clickStarts.shift();
      abilityFloor = kept.length + 1;
    }
    kept.push(line);
  }
  return { lines: kept, undos };
}

// How well one reading of undo #i fits: the number of credit-pool stretches
// spanning the undo (either player's, between the turn boundaries around it)
// whose derived total misses the printed one. checked is false when no such
// stretch closes before the game ends.
function scoreUndoReading(applied, i){
  const data = parseLines(applied.lines, {}, []);
  const at = applied.undos[i].at;
  let bad = 0, checked = false;
  Object.values(data.poolSegments).forEach(segs => segs.forEach(seg => {
    if (seg.startLine < at && (seg.endLine === null || at <= seg.endLine) && seg.ok !== null){
      checked = true;
      if (!seg.ok) bad++;
    }
  }));
  return { bad, checked };
}

function resolveUndos(lines){
  const decisions = applyUndos(lines, []).undos.map(() => 0);
  const verdicts = decisions.map((_, i) => {
    const count = applyUndos(lines, decisions).undos[i].candidates;
    const options = [...Array(count).keys(), -1];
    const scored = options.map(opt => {
      decisions[i] = opt;
      return Object.assign({ opt }, scoreUndoReading(applyUndos(lines, decisions), i));
    });
    const best = scored.reduce((a, b) => (b.bad < a.bad ? b : a));
    decisions[i] = best.opt;
    if (!best.checked) return 'unverifiable';
    if (best.bad > 0) return 'unresolved';
    const rivals = scored.filter(s => s.bad === best.bad && (s.opt === -1) !== (best.opt === -1));
    return rivals.length ? 'ambiguous' : 'confirmed';
  });
  const result = applyUndos(lines, decisions);
  result.undos.forEach((u, i) => { u.verdict = verdicts[i]; });
  return result;
}

function parseLog(text){
  text = stripInlineTimestamps(text);
  text = reconstructTimestampedLog(text);
  const allLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const chatBadges = extractChatBadges(allLines);
  const { lines, undos } = resolveUndos(allLines);
  return parseLines(lines, chatBadges, undos);
}

// ---- Log line patterns ----
// Built once here rather than per call or per line. The /g ones (payFromRe,
// genericGainRe, genericLoseRe, payClauseRe) are reset before every scan.
const VERBS = ['spends','pays','uses','installs','approaches','encounters','breaches',
  'accesses','steals','trashes','is','started','makes','declines','has','will',
  'resolves','indicates','passes','discards','scores','wins','must','jacks','sets',
  'forfeits','takes'];
const playerRe = new RegExp('^(.+?)\\s+(?:' + VERBS.join('|') + ')\\b');

// Jinteki's own generated log text is consistently lowercase ("to gain N"),
// but text pulled verbatim from a card's printed ability wording (e.g. Caveat
// Emptor: "...to Gain 10...") can carry its own capitalization. Case-insensitive
// so a capitalized "Gain" on a card's ability text isn't silently dropped.
// The name capture stops at the first " to " so a mid-ability clause between
// the card and its actual gain ("uses "Knickknack" O'Brian to trash
// Coalescence to gain 2 and draw a card.") can't be swallowed into the name
// — without this, the non-greedy capture runs all the way to whichever "to
// gain" appears first, pulling "to trash Coalescence" into the card name and
// leaving the credit unattributed to the actual card.
const gainDirectRe = /\buses?\s+((?:(?!\sto\s).)+)\s+to\s+gain\s*(\d+)?\b/i;
const gainRevealRe = /\buses?\s+((?:(?!\sto\s).)+)\s+to\s+reveal\s+.+?\s+and\s+gain\s*(\d+)?\b/i;
const gainAndThenRe = /\buses?\s+((?:(?!\sto\s).)+)\s+to\s+.+?\b(?:and|then)\s+gain\s*(\d+)?\b/i;
// "uses <card> to <verb> <target> to gain N" — a trash/discard-for-value
// ability where an intervening clause sits between the card and its "to
// gain", e.g. "Knickknack" O'Brian ("...to trash Coalescence to gain 2 and
// draw a card."). Same name-capture guard as gainDirectRe above.
const gainMidActionRe = /\buses?\s+((?:(?!\sto\s).)+)\s+to\s+.+?\bto\s+gain\s*(\d+)?\b/i;
const payFromRe = new RegExp(String.raw`\bpays\s+(\d+)\s+from\s+(?:${PRONOUN}|the)?\s*(.+?)(?=\s+and\s+|\s+to\s+|\.$|$)`, 'g');
const installRe = /\bto install (.+)$/;
const installCostRe = /pays\s+(.+?)\s+to\s+install\b/;
// "Uses <card> to install ..." / "pays N to use <card> to install ..." is an
// install granted by that card's own ability (e.g. Bahia Bands), not the
// Runner/Corp spending their own basic Install-a-card click — so it must not
// be counted toward the "Install 1 card from HQ/Grip" basic-action stat.
const abilityInstallRe = /\b(?:uses|to\s+use)\s+.+?\s+to\s+install\b/i;
const rezRe = /\bto rez (.+?)\s+(?:in|protecting)\s+(.+?)(?:\s+at\s+position\s+\d+)?\.?$/;
const rezCostRe = /pays\s+(.+?)\s+to\s+rez\b/;
const playCostRe = /pays\s+([^,]+?)\s+to\s+play\s+(.+?)\.?$/;
const useCostRe = /pays\s+(\d+)\s+to\s+use\s+(.+?)\s+to\s+/;
const trashRe = /\btrash(?:es)?\s+(.+?)(?=\s+to\s+use\s+|\s+from\s+the\s+root|\s+from\s+(?:Server\s+\d+|HQ|R&D|Archives)\b|\s+in\s+Server\s+\d+\b|\s+due\s+to|\.$|$)/;
const trashServerRefRe = /\b(?:from|in)\s+(Server\s+\d+|HQ|R&D|Archives)\b/i;
const leftPlayRe = /^(.+?)\s+has left play/;
const shuffleRemoveRe = /\buses?\s+(.+?)\s+to\s+shuffle\b/i;
const selfTrashRe = /\buses?\s+(.+?)\s+to\s+.*?\btrash(?:es)?\s+itself\b/i;
const winRe = /^(.+?)\s+wins the game\.?/;
const drawClickRe = /to use (Corp|Runner) Basic Action Card to draw 1 card/;
const tagRemovalRe = /pays\s+(\d+)\s+to use Runner Basic Action Card to remove 1 tag/;
const trashResourceRe = /pays\s+(\d+)\s+to use Corp Basic Action Card to trash (?:a |an )?resource/i;
const advanceRe = /pays\s+(\d+)\s+to use Corp Basic Action Card to advance\b/i;
// Purge has no printed credit cost (just the click), so this doesn't capture
// an amount — inferred from the consistent "Basic Action Card to <verb>"
// phrasing used by the other basic-action lines above; adjust if a real
// logged purge line turns out to read differently.
const purgeRe = /\bto use Corp Basic Action Card to purge virus counters\b/i;
const stealRe = /\bsteals\s+(.+?)\s+and\s+gains\s+(-?\d+)\s+agenda\s+points?/;
const scoreRe = /\bscores\s+(.+?)\s+and\s+gains\s+(-?\d+)\s+agenda\s+points?/;
// A card that turns itself into an agenda in its player's score area, e.g.
// "Plukind uses Myōshu to add itself to their score area as an Agenda worth
// 2 points." (an operation, so it never shows up as a "scores" line).
const selfToScoreAreaRe = /\buses?\s+(.+?)\s+to\s+add\s+itself\s+to\s+\S+\s+score\s+area\s+as\s+an\s+agenda\s+worth\s+(-?\d+)(?:\s+agenda)?\s+points?/i;
// "forfeits <agenda>" — as a cost or an effect; takes that agenda's points
// back out of the forfeiting player's score.
// Manual corrections with jinteki.net's /agenda-point and /tag commands:
// "X sets their agenda points to 3 (+1).", "X sets Tags to 2 (+1)."
const agendaSetRe = new RegExp(String.raw`\bsets ${PRONOUN} agenda points? to (-?\d+) \(([+-]?\d+)\)`, 'i');
const tagSetRe = /\bsets tags to (\d+) \(([+-]?\d+)\)/i;
const forfeitRe = /\bforfeits\s+(?:\d+\s+agendas?\s+\()?(.+?)\)?(?=\s+to\s+|\.?$)/i;
// Game-end and pre-game system lines (wording from jinteki.net's own
// message strings: "<player> is flatlined.", "<player> is decked.",
// "<player> takes a mulligan.").
const flatlinedRe = /^(.+?)\s+is flatlined\.?$/;
const deckedRe = /^(.+?)\s+is decked\.?$/;
const mulliganRe = /^(.+?)\s+takes a mulligan\.?$/;
// Cards discarded from the grip by damage: one line per damage event,
// listing every card lost ("trashes Curupira and Pennyshaver due to net
// damage"; the list is empty when the grip already was).
const damageDiscardRe = /\btrashes\s*(.*?)\s*due\s+to\s+(?:net|meat|core|brain)\s+damage\b/i;
// "trashes X due to net/meat/core damage" discards from the Runner's grip, never
// from play, so handleTrash must not close an installed copy of the same name.
const damageTrashRe = /\bdue\s+to\s+(?:net|meat|core)\s+damage\b/i;
// Tested on the text right after trashRe's card name: a Runner trashing a
// card that sits in a Corp server or central ("pays 4 to trash La Costa
// Grid from Server 1", "...from the root of R&D", "...from HQ") — always a
// Corp card, even if it was never rezzed. Anchored so a later, unrelated
// "from HQ" ("trashes Cupellation to use Cupellation to access 2
// additional cards from HQ") doesn't count.
const trashFromCorpZoneRe = /^\s+(?:from|in)\s+(?:the\s+root\s+of\s+)?(?:Server\s+\d+|HQ|R&D|Archives)\b/i;
const concedeRe = /^(.+?)\s+concedes?\b/i;
const revealToScoreAreaRe = new RegExp(String.raw`\buses?\s+.+?\s+to\s+reveal\s+(.+?)\s+(?:from\s+.+?\s+)?and\s+add\s+it\s+to\s+${PRONOUN}\s+score\s+area`, 'i');
const anyDrawRe = /\bdraws?\s+(\d+)\s+cards?\b/i;
const cardDrawRe = /\buses?\s+(.+?)\s+to\s+.*?\bdraws?\s+(\d+)\s+cards?\b/i;
const mandatoryDrawRe = new RegExp(String.raw`\bmakes ${PRONOUN} mandatory start of turn draw\b`);
const genericGainRe = /\bgains?\s+(\d+)(?!\s*agenda)/gi;
// Forced credit loss — "Corp Player uses Artificial Cryptocrash to make the
// Runner lose 7." / "...force the Corp to lose 3, and then gain 6." — is a
// real reduction to that side's credit pool that nothing else in the parser
// catches, unlike a normal "pays"/"spends" cost. Left untracked, the derived
// running pool (used by the shared-turn-order chart) drifts upward forever
// since it never sees credits actually leaving. The target side is named
// explicitly in the text, so no recipient-guessing is needed the way
// genericGainRe needs it.
const genericLoseRe = /\b(?:force|forces|make|makes)\s+the\s+(Runner|Corp)\s+(?:to\s+)?lose\s+(\d+)\b/gi;
// "uses <card> to pay N" (bare infinitive "pay", not "pays"/"spends") is
// another real pool cost the "pays"-anchored scan above never sees, e.g.
// "Runner Player uses Fencer Fueno to pay 1." (the actor pays it) and
// "Corp Player uses Attini to force the runner to pay 2." (the named side
// pays it, which may not be the line's grammatical actor).
const forcedPayRe = /\bforce\s+the\s+(Runner|Corp)\s+to\s+pay\s+(\d+)\b/i;
const selfPayRe = /\bto\s+pay\s+(\d+)\b/i;
// "uses <card> to take N ." — e.g. "Runner Player uses Paladin Poemu to
// take 1 ." (moving a hosted credit onto the player's own pool). Anchored
// to the end of the line (optional trailing whitespace/period only) so it
// can't fire on "...to take 1 tag and force the Corp to lose 3..." (Transfer
// of Wealth), which has plenty of text after the number.
// "X sets credit to 9 (+1)." — the /credit command (see change-msg in
// mtgred/netrunner src/clj/game/core/change_vals.clj).
const creditSetRe = /\bsets credits? to (-?\d+) \(([+-]?\d+)\)/i;
const takeCreditRe = /\buses?\s+.+?\s+to\s+take\s+(\d+)\s*\.?\s*$/i;
const giveTagRe = /\bgives?\s+the Runner (\d+) tags?/i;
const takeTagRe = /\btakes?\s+(\d+)\s+tags?/i;
const runRe = /\bmakes? a run on\b/i;
const eventPlayRe = /\bto\s+play\s+(.+?)\.?$/;
const accessFromRe = /\baccesses\s+.+?\s+from\s+(.+?)\.?$/i;
const accessEverythingRe = /\baccesses everything else in\s+(.+?)\.?$/i;
const breachRe = /\bbreaches\s+(.+?)\.?$/i;

function zoneCategory(raw){
  const z = (raw || '').trim();
  if (/the root of R&D/i.test(z)) return 'RD';
  if (/the root of HQ/i.test(z)) return 'HQ';
  if (/the root of Archives/i.test(z)) return 'Archives';
  if (/the root of Server/i.test(z)) return 'remote';
  if (/^HQ/i.test(z)) return 'HQ';
  if (/^R&D/i.test(z)) return 'RD';
  if (/^Archives/i.test(z)) return 'Archives';
  if (/Server\s*\d+/i.test(z)) return 'remote';
  return null;
}

function bump(obj, key, amt){ obj[key] = (obj[key] || 0) + amt; }
function bumpTurn(obj, player, turn, amt){
  if (!obj[player]) obj[player] = {};
  obj[player][turn] = (obj[player][turn] || 0) + amt;
}
function bumpZone(obj, player, zone, amt){
  if (!zone) return;
  if (!obj[player]) obj[player] = { HQ: 0, RD: 0, Archives: 0, remote: 0 };
  obj[player][zone] = (obj[player][zone] || 0) + amt;
}

function sumDigits(str){
  const nums = str.match(/\d+/g) || [];
  return nums.reduce((a, b) => a + +b, 0);
}

// One "<N> from <source>" part of a from-sourced "pays ..." cost (see computePoolSpend).
const payClauseRe = new RegExp(String.raw`(\d+)\s+from\s+((?:${PRONOUN}|the)?\s*credit pool|[^,]+?)(?=\s+and\s+\d|\.$|$|\s+to\s+)`, 'gi');

// Total credits a "pays ..." clause actually took out of the player's own
// credit pool. Handles three shapes:
//  - plain pool cost, e.g. "pays 2 to install X" -> 2
//  - a cost paid entirely from a card's own stash, e.g. "pays 2 from
//    Touchstone and spends 2 hosted power counters ... to increase..." -> 0
//    (never touches the pool; that spend is tracked per-card via payFromRe)
//  - a cost split across several sources under one shared "pays", e.g.
//    "pays 1 from Touchstone and 1 from his credit pool to trash X" -> 1
//    (only the credit-pool portion counts)
// A plain lazy sweep of every digit between "pays" and the next " to "
// (the old approach) is wrong for the last two cases: it either counts a
// non-pool spend, or picks up unrelated numbers from the same clause
// (hosted counter counts, subroutine counts, etc.).
function computePoolSpend(line){
  const paysIdx = line.search(/\bpays\s+\d/);
  if (paysIdx === -1) return null;
  const afterPays = line.slice(paysIdx);
  const toMatch = afterPays.match(/\s+to\s+\S+/);
  const costSpan = toMatch ? afterPays.slice(0, toMatch.index) : afterPays;
  // Only treat this as a from-sourced (possibly multi-source) cost if the
  // number immediately after "pays" itself has its own "from <source>" —
  // e.g. "pays 2 from Touchstone ...". A "from" appearing later in the span
  // for an unrelated clause (e.g. "pays 2 and spends 2 hosted power
  // counters from Revolver") doesn't change that the leading "pays 2" is a
  // plain pool cost; that later "from" belongs to a different verb.
  const leadMatch = costSpan.match(/^pays\s+\d+\s*(from)?/i);
  if (!leadMatch || !leadMatch[1]){
    // Plain pool cost: just the number right after "pays" — never sweep
    // other digits later in the span (hosted counter counts, subroutine
    // counts, an unrelated "from" clause's own number, etc.).
    const bare = line.match(/\bpays\s+(\d+)\b/);
    return bare ? +bare[1] : null;
  }
  let total = 0;
  let cm;
  payClauseRe.lastIndex = 0;
  while ((cm = payClauseRe.exec(costSpan))){
    if (/credit pool/i.test(cm[2])) total += +cm[1];
  }
  return total;
}

function matchGain(line){
  let m = line.match(gainDirectRe); if (m) return m;
  m = line.match(gainRevealRe); if (m) return m;
  m = line.match(gainAndThenRe); if (m) return m;
  m = line.match(gainMidActionRe); if (m) return m;
  return null;
}

// Each play of an event/operation is its own trigger, even when several land on the
// same turn (e.g. two Bravados). Paying "to play" always opens a new trigger; any other
// cost (e.g. Oppo Research's extra 5 to "use" it) adds to the latest trigger that turn;
// a gain settles the earliest trigger on that turn that hasn't gained yet (plays resolve
// in order). Either opens a new trigger when there's nothing to attach to.
function addTrigger(op, turn, kind, amount, rawLine){
  let t = null;
  if (kind === 'gain') t = op.triggers.find(x => x.turn === turn && !x.gained);
  else if (!/ to play /i.test(rawLine || '')){
    const last = op.triggers[op.triggers.length - 1];
    if (last && last.turn === turn) t = last;
  }
  if (!t){ t = { turn, gain: 0, cost: 0, gained: false }; op.triggers.push(t); }
  if (kind === 'gain'){ t.gain += amount; t.gained = true; }
  else t.cost += amount;
}

// ---- Parse state ----
// Everything parseLines accumulates while walking the log, in one object that
// every line handler below reads and updates.
function createParseState(){
  return {
    lineNo: -1,            // index into the parsed lines of the current line (see poolSegments)
    currentTurn: {},       // player -> this player's own last-declared turn number
    maxTurn: {},           // player -> highest turn seen; its keys are the known players
    instances: [],         // installed/rezzed card copies, in install order
    operations: new Map(), // player::name -> events/operations/abilities not tied to an instance
    flagged: [],
    drawClicks: {},
    tagRemovals: {},
    trashResources: {},
    clickCredits: {},
    installClicks: {},
    advanceClicks: {},
    purgeClicks: {},
    playerSide: {},
    agendaEvents: [],
    totalGained: {},
    totalSpent: {},
    totalDraws: {},
    creditsGainedByTurn: {}, // player -> {turn: amount}
    creditsSpentByTurn: {},  // player -> {turn: amount}
    creditPoolByTurn: {},    // player -> {turn: amount}
    handSizeByTurn: {},      // player -> {turn: amount}
    drawsByTurn: {},         // player -> {turn: amount}
    rawTagEvents: [],        // {kind:'give'|'take', actor, amount}
    runsMade: {},
    eventsPlayed: {},
    cardsAccessed: {},       // player -> {HQ,RD,remote}
    breachCounts: {},        // player -> {HQ,RD,Archives}
    cardsRezzed: {},
    clicksGained: {},
    winner: null,
    concededPlayer: null,
    flatlinedPlayer: null,
    deckedPlayer: null,
    mulligans: new Set(),
    damageTaken: {},       // player -> cards lost to damage
    opposingTrashes: {},   // player -> opponent's cards they trashed
    installedBy: {},       // card name -> Set of players who installed/rezzed it
    agendaTitlePoints: {}, // player::agenda -> points it was scored/stolen for
    // Shared turn-order timeline (see handleTurnStart): globalTurnSeq
    // increments once per "started turn N" line of either player, seqOfTurn maps
    // player+turn -> that shared index, turnSeqLog keeps the raw order for the
    // alternative-view axis labels. currentGlobalSeq is "whichever turn is
    // actually active in the log right now" (as opposed to currentTurn[player],
    // which is "this player's own last-declared turn number") — used to
    // bucket gain/spend/draw/agenda events by when they really happened, not by
    // the acting player's own turn counter. This is what makes Corp paying to rez
    // ice mid-Runner's-turn land in the Runner's turn slot on the alternative
    // chart, instead of retroactively worsening Corp's already-finished turn.
    globalTurnSeq: 0,
    currentGlobalSeq: 0,
    seqOfTurn: {},
    turnSeqLog: [],
    creditsGainedBySeq: {},
    creditsSpentBySeq: {},
    drawsBySeq: {},
    // Live credit pool per player, updated line by line as credits are gained,
    // spent or lost, and re-anchored to the exact value printed on every
    // "started/ending turn N with X" line. Anchoring means a missed or misread
    // credit event can only skew the pool until the next turn boundary, never
    // for the rest of the game (the old derived chart series accumulated every
    // such error forever). poolSegments keeps, per player, each stretch between
    // two anchors: the derived values in between and whether the derived value
    // at the closing anchor matched the printed one — a mismatch means some
    // credit event in that stretch wasn't parsed correctly, and is flagged.
    creditPool: {},    // player -> current derived pool (absent until first anchor)
    poolBySeq: {},     // player -> {seq: pool after the last change in that slot}
    poolSegments: {},  // player -> [{fromTurn, fromKind, start, values, end, expected, ok}]
    // player::name -> the instance that most recently received a credit/click trigger.
    // A card that self-trashes on depletion (Daily Casts, Kati Jones, ...) always logs
    // its own "uses X to gain N" line immediately before its "trashes X" line, so the
    // instance that was JUST credited is a far better guess for who is being trashed
    // than "whichever copy is oldest" — oldest is only right when nothing has singled
    // one copy out yet.
    lastCreditedInstance: {},
    // player::name -> instance, reset for every line (see resolveInstance).
    lineInstanceCache: {}
  };
}

const UNDO_VERDICTS = {
  confirmed: 'Confirmed by the credit totals at the next turn boundary.',
  ambiguous: 'The credit totals at the next turn boundary fit either reading, so this is a best guess; draws, runs and tags around it may be off.',
  unresolved: 'No reading matches the credit totals at the next turn boundary; credits and other stats around it may be off.',
  unverifiable: 'The game ended before the next turn boundary, so this could not be checked; stats after it may be off.'
};

function flagUndos(s, undos){
  if (undos.length){
    const clicks = undos.filter(u => u.kind === 'click').length;
    s.flagged.push({ reason: `This game has ${undos.length} undo command${undos.length === 1 ? '' : 's'} (${clicks} undo-click, ${undos.length - clicks} undo-paid-ability). The log keeps what was undone, so each one is resolved as listed below; stats around them can be off.`, line: '(see the undo lines below)' });
  }
  undos.forEach(u => {
    const name = u.kind === 'click' ? 'Undo-click' : 'Undo-paid-ability';
    const when = u.active ? ` (${u.side}, during ${u.active}'s turn ${u.turn})` : ` (${u.side})`;
    const what = u.removed.length
      ? `ignored ${u.removed.length} line${u.removed.length === 1 ? '' : 's'} it took back, starting with “${u.removed[0].replace(/\.$/, '')}”`
      : `nothing ignored; the undone ${u.kind === 'click' ? 'action' : 'ability'} seems to have been cancelled before it was logged`;
    s.flagged.push({ reason: `${name}${when} — ${what}. ${UNDO_VERDICTS[u.verdict] || ''}`, line: u.line });
  });
}

function ensurePlayer(s, p){
  if (!(p in s.maxTurn)) s.maxTurn[p] = 0;
  if (!(p in s.currentTurn)) s.currentTurn[p] = 0;
}

// The known player on a side ('corp' / 'runner'), or undefined. The final
// player list isn't built until the whole log is read, so this looks the
// side up directly via playerSide/maxTurn.
function playerOnSide(s, side){
  return Object.keys(s.maxTurn).find(pl => s.playerSide[pl] === side);
}

// ---- Credit pool ----
function recordPool(s, p){
  if (!s.poolBySeq[p]) s.poolBySeq[p] = {};
  s.poolBySeq[p][s.currentGlobalSeq] = s.creditPool[p];
  const segs = s.poolSegments[p];
  if (segs && segs.length) segs[segs.length - 1].values.push(s.creditPool[p]);
}
function anchorPool(s, p, credits, kind, turnNum, line){
  const segs = s.poolSegments[p] || (s.poolSegments[p] = []);
  const open = segs[segs.length - 1];
  if (open && open.end === null){
    open.endLine = s.lineNo;
    open.end = s.creditPool[p];
    open.expected = credits;
    open.ok = open.end === credits;
    if (!open.ok){
      s.flagged.push({ reason: `Credit tracking (${p}) — log shows ${credits} at the ${kind} of turn ${turnNum}, but the parsed credit events since the previous turn boundary add up to ${open.end}; some gain/spend in between wasn't read correctly`, line });
    }
  }
  segs.push({ fromTurn: turnNum, fromKind: kind, start: credits, values: [], end: null, expected: null, ok: null, startLine: s.lineNo, endLine: null });
  s.creditPool[p] = credits;
  if (!s.poolBySeq[p]) s.poolBySeq[p] = {};
  s.poolBySeq[p][s.currentGlobalSeq] = credits;
}
function gainCredits(s, p, amt){
  bump(s.totalGained, p, amt);
  bumpTurn(s.creditsGainedByTurn, p, s.currentTurn[p] || 0, amt);
  bumpTurn(s.creditsGainedBySeq, p, s.currentGlobalSeq, amt);
  if (p in s.creditPool){ s.creditPool[p] += amt; recordPool(s, p); }
}
// `forced`: a loss imposed by the opponent ("make the Runner lose 7"). The
// game caps it at whatever the player actually has, so only that much is
// really lost — a voluntary payment can never exceed the pool in the first
// place, so it isn't capped (if it would go negative, a gain was missed).
function spendCredits(s, p, amt, forced){
  if (forced && p in s.creditPool) amt = Math.min(amt, Math.max(0, s.creditPool[p]));
  bump(s.totalSpent, p, amt);
  bumpTurn(s.creditsSpentByTurn, p, s.currentTurn[p] || 0, amt);
  bumpTurn(s.creditsSpentBySeq, p, s.currentGlobalSeq, amt);
  if (p in s.creditPool){ s.creditPool[p] -= amt; recordPool(s, p); }
}

// ---- Card instances ----
function findOpenInstance(s, player, name){
  const open = [];
  for (let i = 0; i < s.instances.length; i++){
    const inst = s.instances[i];
    if (inst.player === player && inst.name === name && inst.turnLeft === null) open.push(inst);
  }
  if (open.length === 0) return null;
  if (open.length === 1) return open[0];
  // Multiple simultaneous copies: the log gives no way to know which physical
  // copy a given trigger belongs to. Credit whichever open copy has received
  // the fewest triggers so far (ties broken by install order, i.e. the oldest
  // untouched copy first). For ordinary duplicate cards this still alternates
  // evenly turn over turn, same as a round-robin would. But it also handles
  // cards like Coalescence, which hosts a fixed number of counters and keeps
  // sitting in play — still "open" — after they're spent instead of logging
  // a self-trash: a blind rotation eventually cycles back around to that
  // already-exhausted copy and keeps piling extra uses onto it, starving
  // the copies that still had capacity. Preferring the least-used copy never
  // does that, because a spent copy's count stops being the minimum once any
  // other copy has been used fewer times.
  let best = open[0];
  for (let i = 1; i < open.length; i++){
    if (open[i].events < best.events) best = open[i];
  }
  return best;
}

// For "leaves play" events (trash / shuffle-away / self-trash) there's no way to know
// which physical copy the log line refers to either, but the oldest copy in play is
// the more natural default guess (it's had the most chances to be the one discarded).
function findOldestOpenInstance(s, player, name){
  for (let i = 0; i < s.instances.length; i++){
    const inst = s.instances[i];
    if (inst.player === player && inst.name === name && inst.turnLeft === null) return inst;
  }
  return null;
}

function findOldestOpenInstanceAnyPlayer(s, name){
  for (let i = 0; i < s.instances.length; i++){
    if (s.instances[i].name === name && s.instances[i].turnLeft === null) return s.instances[i];
  }
  return null;
}

// Corp install/rez/trash lines always name a server, so when a card in play is
// trashed and the log states which server it came from, that identifies the exact
// physical copy — no need to guess. Runner cards aren't in servers, so this only
// ever matches corp-side instances (which is correct: runner trashes stay FIFO).
function findInstanceByServerAnyPlayer(s, name, server){
  if (!server) return null;
  for (let i = 0; i < s.instances.length; i++){
    const inst = s.instances[i];
    if (inst.name === name && inst.turnLeft === null && inst.server === server) return inst;
  }
  return null;
}

// When a card's own use empties its last counter (or otherwise causes it to leave
// play) mid-resolution, the game engine can log the trash *before* the rest of that
// same click's effect (e.g. Dr. Nuka Vrolyck's draw) — so the benefit line arrives
// right after its own instance just closed, with no newer instance to belong to.
// Only fall back to it within the same turn, so a genuinely later, unrelated instance
// (or a real re-install) never gets misattributed to old, already-closed history.
function findRecentlyClosedInstance(s, player, name, turn){
  for (let i = s.instances.length - 1; i >= 0; i--){
    const inst = s.instances[i];
    if (inst.player === player && inst.name === name && inst.turnLeft === turn) return inst;
  }
  return null;
}

// The instance a card name on the current line refers to. Cached per line so
// every mention of the same card on one line lands on the same copy.
function resolveInstance(s, player, name){
  const key = player + '::' + name;
  if (key in s.lineInstanceCache) return s.lineInstanceCache[key];
  let inst = findOpenInstance(s, player, name);
  if (!inst) inst = findRecentlyClosedInstance(s, player, name, s.currentTurn[player] || 0);
  s.lineInstanceCache[key] = inst;
  return inst;
}

function logCardDraw(s, player, rawName, amount, turn){
  const name = cleanCardName(rawName);
  const inst = resolveInstance(s, player, name);
  if (inst){
    inst.events++;
    inst.triggerLog.push({ turn, kind: 'draw', amount });
  }
}

// Attributes a card's credit gain or cost: a basic action's click for credit,
// an installed/rezzed copy, or else an event/operation/ability entry.
function routeEvent(s, kind, player, rawName, amount, turn, rawLine){
  let name = cleanCardName(rawName);
  if (kind === 'gain' && (/corp basic action card/i.test(name) || /runner basic action card/i.test(name))){
    s.playerSide[player] = /corp basic action card/i.test(name) ? 'corp' : 'runner';
    if (!s.clickCredits[player]) s.clickCredits[player] = { count: 0, gained: 0 };
    s.clickCredits[player].count++;
    if (amount !== null) s.clickCredits[player].gained += amount;
    else s.flagged.push({ reason: `Click for credit (${player}) — credit amount not readable in log text`, line: rawLine });
    return;
  }

  let inst = resolveInstance(s, player, name);
  if (!inst && kind === 'gain' && /:/.test(name)){
    inst = { name, player, turnInstalled: 1, turnLeft: null, credits: 0, cost: 0, events: 0, isIdentity: true, triggerLog: [], server: null };
    s.instances.push(inst);
    s.lineInstanceCache[player + '::' + name] = inst;
  }

  if (kind === 'gain' && amount === null){
    const clickAmt = CLICK_GAIN_OVERRIDES[name.toLowerCase()] || 1;
    if (inst){
      inst.events++;
      inst.triggerLog.push({ turn, kind: 'click', amount: clickAmt });
      s.lastCreditedInstance[player + '::' + name] = inst;
    } else {
      bump(s.clicksGained, player, clickAmt);
    }
    return;
  }

  if (inst){
    if (kind === 'gain'){
      inst.events++;
      inst.credits += amount;
      inst.triggerLog.push({ turn, kind: 'credit', amount });
      s.lastCreditedInstance[player + '::' + name] = inst;
    } else {
      inst.cost += amount;
    }
    return;
  }

  const key = player + '::' + name;
  let op = s.operations.get(key);
  if (!op){ op = { player, name, gain: 0, cost: 0, triggers: [] }; s.operations.set(key, op); }
  if (kind === 'gain'){
    op.gain += amount; addTrigger(op, turn, 'gain', amount, rawLine);
  } else {
    op.cost += amount; addTrigger(op, turn, 'cost', amount, rawLine);
  }
}

// ---- Line handlers: turn boundaries and other system lines ----
// Each takes the parse state and a line and returns true when the line was
// one of its kind (nothing else is then done with it).

function handleTurnStart(s, line){
  const m = line.match(turnStartRe);
  if (!m || m[3] === undefined) return false;
  const p = m[1].trim(), t = +m[2], credits = +m[3], hand = +m[4];
  ensurePlayer(s, p);
  // Fallback side detection for players who never use a basic action
  // (which is what normally sets playerSide): the Corp's hand is HQ, the
  // Runner's is the Grip.
  if (!s.playerSide[p]) s.playerSide[p] = /\bcards? in HQ\b/.test(line) ? 'corp' : 'runner';
  s.currentTurn[p] = t;
  s.maxTurn[p] = Math.max(s.maxTurn[p] || 0, t);
  s.creditPoolByTurn[p] = s.creditPoolByTurn[p] || {};
  s.creditPoolByTurn[p][t] = credits;
  s.handSizeByTurn[p] = s.handSizeByTurn[p] || {};
  s.handSizeByTurn[p][t] = hand;
  // Corp and Runner each keep their own "turn 1, turn 2, ..." counter, but
  // those numbers don't line up in real time — Corp's turn 3 and Runner's
  // turn 3 aren't simultaneous, and each player can also gain credits/draw
  // cards during the *other* player's turn. seqOfTurn records the order
  // turns actually started in the log, one shared timeline both players'
  // per-turn data can be replotted against (see "Alternative: turn order" charts).
  s.globalTurnSeq += 1;
  s.currentGlobalSeq = s.globalTurnSeq;
  if (!s.seqOfTurn[p]) s.seqOfTurn[p] = {};
  s.seqOfTurn[p][t] = s.globalTurnSeq;
  s.turnSeqLog.push({ player: p, turn: t, seq: s.globalTurnSeq });
  anchorPool(s, p, credits, 'start', t, line);
  return true;
}

function handleTurnEnd(s, line){
  const m = line.match(turnEndRe);
  if (!m || m[3] === undefined) return false;
  const p = m[1].trim(), t = +m[2];
  ensurePlayer(s, p);
  s.maxTurn[p] = Math.max(s.maxTurn[p] || 0, t);
  anchorPool(s, p, +m[3], 'end', t, line);
  return true;
}

function handleGameEnd(s, line){
  let m;
  if ((m = line.match(winRe))){ s.winner = m[1].trim(); return true; }
  if ((m = line.match(flatlinedRe))){ s.flatlinedPlayer = m[1].trim(); return true; }
  if ((m = line.match(deckedRe))){ s.deckedPlayer = m[1].trim(); return true; }
  return false;
}

// Mulligans happen before either player's first turn line, so they're
// handled before the "known player" check the other handlers sit behind.
function handleMulligan(s, line){
  const m = line.match(mulliganRe);
  if (!m) return false;
  s.mulligans.add(m[1].trim());
  return true;
}

const SYSTEM_LINE_HANDLERS = [handleTurnStart, handleTurnEnd, handleGameEnd, handleMulligan];

// ---- Line handlers: a known player's line ----
// Each gets the parse state and the line context { line, player, turn,
// scanLine } and looks for its own kind of event; several can fire on one
// line. They run in the order of PLAYER_LINE_HANDLERS, which matters: e.g.
// a basic-action gain sets the player's side before the credit scan below
// uses it to redirect "the Runner gains" credits.

function handleInstall(s, { line, player, turn }){
  const m = line.match(installRe);
  if (!m) return;
  const raw = m[1];
  const isAbilityInstall = abilityInstallRe.test(line);
  // Every *basic-action* install line costs a click. An install granted by
  // a card's own ability (Bahia Bands etc.) doesn't spend the Install
  // click, so it's excluded here — that click was already spent on the
  // ability itself, tracked separately.
  if (!isAbilityInstall){
    s.installClicks[player] = (s.installClicks[player] || 0) + 1;
  }
  // Some install lines are just a generic placeholder ("a card in the root
  // of Server 3", "a card from the grip", "a card from HQ") with the real
  // card name revealed on a separate, more specific line right after (see
  // the ability-install case above) — these placeholders are never a real
  // card name and must not open a bogus instance.
  if (!/^(a card (?:in|from)\b|ice protecting)/i.test(raw.trim())){
    const name = cleanCardName(raw);
    if (name){
      const inst = { name, player, turnInstalled: turn, turnLeft: null, credits: 0, cost: 0, events: 0, triggerLog: [], server: null };
      (s.installedBy[name] || (s.installedBy[name] = new Set())).add(player);
      const cm = line.match(installCostRe);
      if (cm) inst.cost = sumDigits(cm[1]);
      s.instances.push(inst);
    }
  }
}

function handleRez(s, { line, player, turn }){
  const m = line.match(rezRe);
  if (!m) return;
  const name = cleanCardName(m[1]);
  const server = m[2] ? m[2].trim() : null;
  bump(s.cardsRezzed, player, 1);
  (s.installedBy[name] || (s.installedBy[name] = new Set())).add(player);
  // Each rez is a distinct physical copy — always open a new instance,
  // even if another copy of the same card is already in play unrezzed/rezzed elsewhere.
  const inst = { name, player, turnInstalled: turn, turnLeft: null, credits: 0, cost: 0, events: 0, triggerLog: [], server };
  const cm = line.match(rezCostRe);
  if (cm) inst.cost = sumDigits(cm[1]);
  s.instances.push(inst);
}

// "uses <card> to gain N" and its variants: credits credited to that card.
function handleCardGain(s, { line, player, turn }){
  const m = matchGain(line);
  if (m) routeEvent(s, 'gain', player, m[1], m[2] ? +m[2] : null, turn, line);
}

function handleCardDraw(s, { line, player, turn }){
  const m = line.match(cardDrawRe);
  if (m) logCardDraw(s, player, m[1], +m[2], turn);
}

// Costs charged to a card (playing it, or paying to use it), and credits a
// card spends from its own stash ("pays 2 from Touchstone"), which count
// as that card's gain.
function handleCardCosts(s, { line, player, turn }){
  let m;
  if ((m = line.match(playCostRe))){
    routeEvent(s, 'cost', player, m[2], sumDigits(m[1]), turn, line);
  }
  if ((m = line.match(useCostRe))){
    if (!/basic action card/i.test(m[2])) routeEvent(s, 'cost', player, m[2], +m[1], turn, line);
  }
  payFromRe.lastIndex = 0;
  while ((m = payFromRe.exec(line))){
    const amt = +m[1];
    const name = m[2].trim();
    if (/credit pool/i.test(name)) continue;
    routeEvent(s, 'gain', player, name, amt, turn, line);
  }
}

function handleTrash(s, { line, player, turn }){
  // "trashes X due to net/meat/core damage" discards from the Runner's grip, never
  // from play — an installed copy of the same name should not be closed by this.
  if (damageTrashRe.test(line)) return;
  const m = line.match(trashRe);
  if (!m) return;
  const serverRef = (line.match(trashServerRefRe) || [])[1] || null;
  const fromCorpZone = s.playerSide[player] === 'runner'
    && trashFromCorpZoneRe.test(line.slice(m.index + m[0].length));
  m[1].split(/\s+and\s+/).forEach(raw => {
    const name = cleanCardName(raw);
    // Count cards trashed that belong to the opponent: known either from
    // where the card was (a Runner trashing from a Corp server/central),
    // or from who installed/rezzed a card of that name earlier. Generic
    // placeholders ("a card from HQ", "itself") never count.
    if (name && !/^(?:a card|an? (?:installed|facedown|hosted)|hosted|itself|the top|all)\b/i.test(name)){
      const owners = s.installedBy[name];
      const opponentOwned = owners && !owners.has(player) && owners.size > 0;
      if (fromCorpZone || opponentOwned) bump(s.opposingTrashes, player, 1);
    }
    const recent = s.lastCreditedInstance[player + '::' + name];
    const inst = findInstanceByServerAnyPlayer(s, name, serverRef)
      || (recent && recent.player === player && recent.turnLeft === null ? recent : null)
      || findOldestOpenInstance(s, player, name)
      || findOldestOpenInstanceAnyPlayer(s, name);
    if (inst) inst.turnLeft = s.currentTurn[inst.player] || turn;
  });
}

// Other ways a card leaves play: trashing itself, being shuffled away, or a
// "<card> has left play" system line.
function handleOtherLeavePlay(s, { line, player, turn }){
  let m;
  if ((m = line.match(selfTrashRe))){
    const name = cleanCardName(m[1]);
    const recent = s.lastCreditedInstance[player + '::' + name];
    const inst = (recent && recent.player === player && recent.turnLeft === null ? recent : null)
      || findOldestOpenInstance(s, player, name);
    if (inst) inst.turnLeft = turn;
  }
  if ((m = line.match(shuffleRemoveRe))){
    const name = cleanCardName(m[1]);
    const inst = findOldestOpenInstance(s, player, name);
    if (inst) inst.turnLeft = turn;
  }
  if ((m = line.match(leftPlayRe))){
    const name = cleanCardName(m[1]);
    const inst = findOldestOpenInstanceAnyPlayer(s, name);
    if (inst) inst.turnLeft = s.currentTurn[inst.player] || turn;
  }
}

// Basic action card clicks (draw, remove tag, trash resource, advance, purge);
// each also tells which side the player is on.
function handleBasicActions(s, { line, player }){
  let m;
  if ((m = line.match(drawClickRe))){
    s.playerSide[player] = m[1].toLowerCase() === 'corp' ? 'corp' : 'runner';
    s.drawClicks[player] = (s.drawClicks[player] || 0) + 1;
  }
  if ((m = line.match(tagRemovalRe))){
    s.playerSide[player] = 'runner';
    if (!s.tagRemovals[player]) s.tagRemovals[player] = { count: 0, cost: 0 };
    s.tagRemovals[player].count++;
    s.tagRemovals[player].cost += +m[1];
  }
  if ((m = line.match(trashResourceRe))){
    s.playerSide[player] = 'corp';
    if (!s.trashResources[player]) s.trashResources[player] = { count: 0, cost: 0 };
    s.trashResources[player].count++;
    s.trashResources[player].cost += +m[1];
  }
  if ((m = line.match(advanceRe))){
    s.playerSide[player] = 'corp';
    if (!s.advanceClicks[player]) s.advanceClicks[player] = { count: 0, cost: 0 };
    s.advanceClicks[player].count++;
    s.advanceClicks[player].cost += +m[1];
  }
  if (purgeRe.test(line)){
    s.playerSide[player] = 'corp';
    s.purgeClicks[player] = (s.purgeClicks[player] || 0) + 1;
  }
}

// Total credits gained, spent and lost (an independent, comprehensive scan
// of the quote-stripped line), which also drives the live credit pool.
function handleCreditPool(s, { line, player, scanLine }){
  let m;
  genericGainRe.lastIndex = 0;
  while ((m = genericGainRe.exec(scanLine))){
    const amt = +m[1];
    // The line's grammatical actor isn't always who actually receives the
    // credits: "Inermis2 uses X to let the Runner gain 2..." is Corp's line
    // (Corp is `player`), but the 2cr belongs to the Runner. Check a short
    // window of text right before the number for an explicit "Runner"/"Corp"
    // that names the real recipient, and redirect the credit there instead.
    const context = scanLine.slice(Math.max(0, m.index - 25), m.index);
    let recipient = player;
    if (/\bRunner\b/i.test(context) && s.playerSide[player] !== 'runner'){
      const runnerP = playerOnSide(s, 'runner');
      if (runnerP) recipient = runnerP;
    } else if (/\bCorp\b/i.test(context) && s.playerSide[player] !== 'corp'){
      const corpP = playerOnSide(s, 'corp');
      if (corpP) recipient = corpP;
    }
    gainCredits(s, recipient, amt);
  }
  // "uses <card> to take N ." — a hosted credit moved onto the player's own
  // pool; always self-directed (the line's actor is always the recipient),
  // unlike genericGainRe's "let the Runner gain..." redirect cases.
  if ((m = scanLine.match(takeCreditRe))){
    gainCredits(s, player, +m[1]);
  }
  // total credits lost (forced, e.g. traces/taxes — the losing side is named
  // explicitly in the text, so this reduces that side's pool the same way a
  // spend does, whether or not that side is the line's grammatical actor).
  genericLoseRe.lastIndex = 0;
  while ((m = genericLoseRe.exec(scanLine))){
    const side = m[1].toLowerCase();
    const amt = +m[2];
    const targetPlayer = playerOnSide(s, side) || player;
    spendCredits(s, targetPlayer, amt, true);
  }
  // Only the portion of a "pays ..." clause that actually came out of the
  // player's credit pool counts here — see computePoolSpend above.
  const spentAmt = computePoolSpend(scanLine);
  if (spentAmt !== null) spendCredits(s, player, spentAmt, false);
  // "uses <card> to pay N" / "force the Runner|Corp to pay N" — bare
  // infinitive "pay" cost, never matched by the "pays"-anchored scan above
  // (see forcedPayRe/selfPayRe declarations). Checked as its own line so it
  // stacks with, rather than replaces, any "pays ..." cost already found.
  if ((m = scanLine.match(forcedPayRe))){
    const side = m[1].toLowerCase();
    const targetPlayer = playerOnSide(s, side) || player;
    spendCredits(s, targetPlayer, +m[2], false);
  } else if ((m = scanLine.match(selfPayRe))){
    spendCredits(s, player, +m[1], false);
  }

  // Manual correction with jinteki.net's /credit command, e.g. "X sets
  // credit to 9 (+1)." after a misclick. The delta is applied like any
  // other gain/spend, so the credit-tracking check still catches anything
  // else that was missed in the same turn.
  if ((m = line.match(creditSetRe))){
    const delta = +m[2];
    if (delta > 0) gainCredits(s, player, delta);
    else if (delta < 0) spendCredits(s, player, -delta, false);
    s.flagged.push({ reason: `Manual credit adjustment (${player}) — set to ${m[1]} with the /credit command; applied to the credit pool and totals`, line });
  }
}

function handleDraws(s, { line, player, turn }){
  if (mandatoryDrawRe.test(line)){
    bump(s.totalDraws, player, 1);
    bumpTurn(s.drawsByTurn, player, turn, 1);
    bumpTurn(s.drawsBySeq, player, s.currentGlobalSeq, 1);
  }
  const m = line.match(anyDrawRe);
  if (m){
    const n = +m[1];
    bump(s.totalDraws, player, n);
    bumpTurn(s.drawsByTurn, player, turn, n);
    bumpTurn(s.drawsBySeq, player, s.currentGlobalSeq, n);
  }
}

// Damage is always taken from the Runner's grip, whichever side's line it is.
function handleDamage(s, { line }){
  const m = line.match(damageDiscardRe);
  if (!m) return;
  const runnerP = playerOnSide(s, 'runner');
  const listed = m[1].trim();
  // An empty list is damage taken with an empty grip (the flatline hit).
  const n = listed ? listed.split(/\s*,\s*(?:and\s+)?|\s+and\s+/).filter(Boolean).length : 1;
  if (runnerP) bump(s.damageTaken, runnerP, n);
}

// Tags are scanned on the quote-stripped text, so subroutine text echoed
// in quotes (`resolves 2 unbroken subroutines on Starlit Knight (" Give
// the Runner 1 tag" ...)`) isn't counted as another tag on top of the
// real "uses Starlit Knight to give the Runner 1 tag" lines.
function handleTags(s, { player, scanLine }){
  let m;
  if ((m = scanLine.match(giveTagRe))){
    s.rawTagEvents.push({ kind: 'give', amount: +m[1] });
  }
  if ((m = scanLine.match(takeTagRe))){
    s.rawTagEvents.push({ kind: 'take', actor: player, amount: +m[1] });
  }
}

// Runs made, events/operations played (counted for either side; only shown
// for the Runner), cards accessed by zone and central servers breached.
function handleRunsAndAccess(s, { line, player }){
  let m;
  if (runRe.test(line)) bump(s.runsMade, player, 1);

  if ((m = line.match(eventPlayRe))){
    const evName = cleanCardName(m[1]);
    if (!/basic action card/i.test(evName)) bump(s.eventsPlayed, player, 1);
  }

  if ((m = line.match(accessFromRe))){
    bumpZone(s.cardsAccessed, player, zoneCategory(m[1]), 1);
  } else if ((m = line.match(accessEverythingRe))){
    bumpZone(s.cardsAccessed, player, zoneCategory(m[1]), 1);
  }

  if ((m = line.match(breachRe))){
    const zone = zoneCategory(m[1]);
    if (zone === 'HQ' || zone === 'RD' || zone === 'Archives'){
      bumpZone(s.breachCounts, player, zone, 1);
    }
  }
}

// Agenda points: steals and scores, manual /agenda-point and /tag
// corrections, forfeits, and agendas revealed into a score area.
function handleAgendas(s, { line, player, turn }){
  let m;
  if ((m = line.match(stealRe)) || (m = line.match(scoreRe)) || (m = line.match(selfToScoreAreaRe))){
    const title = cleanCardName(m[1]);
    s.agendaEvents.push({ player, turn, seq: s.currentGlobalSeq, points: +m[2] });
    s.agendaTitlePoints[player + '::' + title.toLowerCase()] = +m[2];
  }
  if ((m = line.match(agendaSetRe))){
    s.agendaEvents.push({ player, turn, seq: s.currentGlobalSeq, points: +m[2] });
    s.flagged.push({ reason: `Manual agenda point adjustment (${player}) — set to ${m[1]} with the /agenda-point command; applied to the score`, line });
  }
  // Tags set by hand aren't counted as given or taken (it's not clear which
  // a correction stands for); flagged so the tag totals can be checked.
  if (tagSetRe.test(line)){
    s.flagged.push({ reason: `Manual tag adjustment (${player}) — not counted in the tag totals`, line });
  }
  if ((m = line.match(forfeitRe))){
    m[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+/).filter(Boolean).forEach(raw => {
      const title = cleanCardName(raw);
      const key = player + '::' + title.toLowerCase();
      const pts = key in s.agendaTitlePoints ? s.agendaTitlePoints[key] : AGENDA_POINTS[title.toLowerCase()];
      if (pts !== undefined){
        s.agendaEvents.push({ player, turn, seq: s.currentGlobalSeq, points: -pts });
        delete s.agendaTitlePoints[key];
      } else {
        s.flagged.push({ reason: `${title} (${player}) — forfeited, but its agenda point value isn't known, so the score isn't reduced`, line });
      }
    });
  }
  if ((m = line.match(revealToScoreAreaRe))){
    const revealedName = cleanCardName(m[1]);
    const pts = AGENDA_POINTS[revealedName.toLowerCase()];
    if (pts !== undefined){
      s.agendaEvents.push({ player, turn, seq: s.currentGlobalSeq, points: pts });
      s.agendaTitlePoints[player + '::' + revealedName.toLowerCase()] = pts;
    } else {
      s.flagged.push({ reason: `${revealedName} (${player}) — added to score area by another card's effect, but its agenda point value isn't in the lookup table, so it's not counted in the agenda chart`, line });
    }
  }
}

function handleConcede(s, { line }){
  const m = line.match(concedeRe);
  if (m) s.concededPlayer = m[1].trim();
}

const PLAYER_LINE_HANDLERS = [
  handleInstall, handleRez, handleCardGain, handleCardDraw, handleCardCosts,
  handleTrash, handleOtherLeavePlay, handleBasicActions, handleCreditPool,
  handleDraws, handleDamage, handleTags, handleRunsAndAccess, handleAgendas,
  handleConcede
];

// ---- Driver ----
function parseLines(rawLines, chatBadges, undos){
  const s = createParseState();
  flagUndos(s, undos);
  for (const line of rawLines){
    s.lineNo++;
    s.lineInstanceCache = {};
    if (SYSTEM_LINE_HANDLERS.some(handle => handle(s, line))) continue;

    const pm = line.match(playerRe);
    const player = pm ? pm[1].trim() : null;
    if (!player || !(player in s.maxTurn)) continue;
    const ctx = {
      line,
      player,
      turn: s.currentTurn[player] || 0,
      // Subroutine/ability reminder text sometimes gets echoed back in quotes
      // (e.g. `Corp Player resolves 3 unbroken subroutines on Attini (" Do 1
      // net damage unless the Runner pays 2 " and ...)`). That's the card's
      // printed wording being narrated, not anyone actually paying/gaining/
      // losing credits on this line — the credit and tag scans use this
      // quote-stripped copy so a quoted "pays N"/"gain N"/"lose N" can't be
      // mistaken for a real event on the line's actual actor.
      scanLine: line.replace(/"[^"]*"/g, '')
    };
    for (const handle of PLAYER_LINE_HANDLERS) handle(s, ctx);
  }
  return buildResult(s, chatBadges, undos);
}

// ---- Result: tables and chart series ----

function buildInstalledRows(s){
  const installedRows = s.instances.map(inst => {
    const endTurn = inst.turnLeft !== null ? inst.turnLeft : (s.maxTurn[inst.player] || inst.turnInstalled);
    const turnsInPlay = Math.max(1, endTurn - inst.turnInstalled + 1);
    return {
      name: inst.name,
      player: inst.player,
      turnInstalled: inst.turnInstalled,
      turnLeftDisplay: inst.turnLeft !== null ? inst.turnLeft : '-',
      turnsInPlay,
      events: inst.events,
      gained: inst.credits,
      cost: inst.cost,
      net: inst.credits - inst.cost,
      instanceIndex: null,
      triggerLog: (inst.triggerLog || []).slice().sort((a, b) => a.turn - b.turn)
    };
  });

  // Number copies of the same card (per player) in chronological order, only when 2+ exist.
  const countByKey = {};
  installedRows.forEach(r => {
    const key = r.player + '::' + r.name;
    countByKey[key] = (countByKey[key] || 0) + 1;
  });
  const seenByKey = {};
  installedRows.forEach(r => {
    const key = r.player + '::' + r.name;
    if (countByKey[key] > 1){
      seenByKey[key] = (seenByKey[key] || 0) + 1;
      r.instanceIndex = seenByKey[key];
    }
  });
  return installedRows;
}

function buildOpsRows(s){
  return Array.from(s.operations.values()).map(op => {
    const triggered = op.triggers.length;
    const perTurnCount = {};
    op.triggers.forEach(t => { perTurnCount[t.turn] = (perTurnCount[t.turn] || 0) + 1; });
    const seenPerTurn = {};
    const perTurnRows = op.triggers
      .map(t => {
        const nth = perTurnCount[t.turn] > 1 ? (seenPerTurn[t.turn] = (seenPerTurn[t.turn] || 0) + 1) : null;
        return { turn: t.turn, nth, cost: t.cost, gain: t.gain, net: t.gain - t.cost };
      })
      .sort((a, b) => a.turn - b.turn || (a.nth || 0) - (b.nth || 0));
    return {
      name: op.name,
      player: op.player,
      triggered,
      totalCost: op.cost,
      totalGain: op.gain,
      totalNet: op.gain - op.cost,
      turnsList: op.triggers.map(t => t.turn).sort((a,b)=>a-b).join(', '),
      perTurnRows
    };
  });
}

// All three builders start at turn 0 = game start (5cr / 5 cards, nothing
// gained/spent/drawn yet), not turn 1. A 1-turn game therefore always has at
// least two plotted points (turn 0 baseline -> turn 1 result), so the line
// charts have something to draw instead of a single invisible dot.
// count is either `rounds` (each player's own turn-number axis) or
// `totalSeq` (the shared turn-order axis used by the "Alternative: turn
// order" charts).
function buildSnapshotSeries(players, byTurn, count){
  const series = {};
  players.forEach(p => {
    const arr = new Array(count + 1).fill(0);
    let last = 5;
    arr[0] = last;
    for (let t = 1; t <= count; t++){
      if (byTurn[p] && byTurn[p][t] !== undefined) last = byTurn[p][t];
      arr[t] = last;
    }
    series[p] = arr;
  });
  return series;
}
function buildDeltaSeries(players, byTurn, count){
  const series = {};
  players.forEach(p => {
    const arr = new Array(count + 1).fill(0);
    for (let t = 0; t <= count; t++) arr[t] = (byTurn[p] && byTurn[p][t]) || 0;
    series[p] = arr;
  });
  return series;
}
function buildCumulativeSeries(players, byTurn, count){
  const series = {};
  players.forEach(p => {
    const arr = new Array(count + 1).fill(0);
    let running = 0;
    for (let t = 0; t <= count; t++){ running += (byTurn[p] && byTurn[p][t]) || 0; arr[t] = running; }
    series[p] = arr;
  });
  return series;
}
function netSeries(players, gained, spent){
  const net = {};
  players.forEach(p => {
    net[p] = gained[p].map((v, i) => v - (spent[p][i] || 0));
  });
  return net;
}

// Series against each player's own turn number.
function buildTurnSeries(s, players, rounds){
  // agenda cumulative series
  const agendaSeries = {};
  players.forEach(p => { agendaSeries[p] = new Array(rounds + 1).fill(0); });
  s.agendaEvents.forEach(e => {
    if (!agendaSeries[e.player]) return;
    const t = Math.max(1, Math.min(rounds, e.turn || 1));
    agendaSeries[e.player][t] += e.points;
  });
  players.forEach(p => {
    let running = 0;
    // Start from turn 0 (0 agenda points at game start) for the same reason as
    // buildSnapshotSeries/buildCumulativeSeries: gives every chart a real
    // baseline point so 1-turn games still draw a line, not a lone dot.
    for (let t = 0; t <= rounds; t++){ running += agendaSeries[p][t]; agendaSeries[p][t] = running; }
  });

  const creditsGainedSeries = buildDeltaSeries(players, s.creditsGainedByTurn, rounds);
  const creditsSpentSeries = buildDeltaSeries(players, s.creditsSpentByTurn, rounds);
  return {
    agendaSeries,
    creditsGainedSeries,
    creditsNetSeries: netSeries(players, creditsGainedSeries, creditsSpentSeries),
    creditPoolSeries: buildSnapshotSeries(players, s.creditPoolByTurn, rounds),
    handSizeSeries: buildSnapshotSeries(players, s.handSizeByTurn, rounds),
    cardsDrawnSeries: buildCumulativeSeries(players, s.drawsByTurn, rounds)
  };
}

// ---- Alternative axis: shared turn-order sequence instead of each player's
// own turn number. Corp turn 3 and Runner turn 3 are not the same moment in
// the game, and both players can gain credits / draw cards on either player's
// turn — so this doesn't just relabel the per-own-turn data (that would still
// dump everything Corp does mid-Runner's-turn into "Corp turn 1"); the
// gain/spend/draw/agenda events were bucketed by currentGlobalSeq — the turn
// that was actually active in the log at that moment — as they were parsed
// (see creditsGainedBySeq etc. and handleTurnStart), so e.g. a
// rez paid for mid-Runner's-turn lands in the Runner's slot here, not Corp's.
function buildSeqSeries(s, players){
  const totalSeq = s.globalTurnSeq;
  function reindexByTurnToSeq(byTurn){
    const bySeq = {};
    players.forEach(p => {
      bySeq[p] = {};
      const map = byTurn[p] || {};
      Object.keys(map).forEach(tKey => {
        const t = +tKey;
        const seq = s.seqOfTurn[p] && s.seqOfTurn[p][t];
        if (seq) bySeq[p][seq] = (bySeq[p][seq] || 0) + map[t];
      });
    });
    return bySeq;
  }
  const creditsGainedSeqSeries = buildDeltaSeries(players, s.creditsGainedBySeq, totalSeq);
  const creditsSpentSeqSeries = buildDeltaSeries(players, s.creditsSpentBySeq, totalSeq);
  // Credit pool here is the live per-line pool tracked during parsing (see
  // creditPool/anchorPool above): it changes the moment a gain/spend actually
  // happens, e.g. Corp paying 4 to rez ice mid-Runner's-turn shows up in the
  // Runner's slot, and it's reset to the exact printed value at every turn
  // boundary so parsing gaps can't drift it for the rest of the game. Each
  // slot shows the pool as it stood at the end of that slot.
  const creditPoolSeqSeries = {};
  players.forEach(p => {
    const arr = new Array(totalSeq + 1).fill(0);
    const bySeq = s.poolBySeq[p] || {};
    let running = 5;
    arr[0] = running;
    for (let seq = 1; seq <= totalSeq; seq++){
      if (bySeq[seq] !== undefined) running = bySeq[seq];
      // Only reachable when a missed gain made a payment look unaffordable;
      // the real pool can never be negative.
      arr[seq] = Math.max(0, running);
    }
    creditPoolSeqSeries[p] = arr;
  });
  // Hand size doesn't have an equivalent derivable series — cards leave a hand
  // via installs, plays, discards and trashes as well as arrive via draws, and
  // not all of those are tracked as discrete counted events — so this one is
  // still the reindexed start-of-own-turn snapshot, with the same "can lag
  // behind a mid-opponent's-turn change" caveat as credits used to have.
  const handSizeSeqSeries = buildSnapshotSeries(players, reindexByTurnToSeq(s.handSizeByTurn), totalSeq);
  const cardsDrawnSeqSeries = buildCumulativeSeries(players, s.drawsBySeq, totalSeq);
  const agendaSeqSeries = {};
  players.forEach(p => { agendaSeqSeries[p] = new Array(totalSeq + 1).fill(0); });
  s.agendaEvents.forEach(e => {
    if (!agendaSeqSeries[e.player]) return;
    const seq = e.seq || totalSeq || 1;
    agendaSeqSeries[e.player][seq] += e.points;
  });
  players.forEach(p => {
    let running = 0;
    for (let seq = 0; seq <= totalSeq; seq++){ running += agendaSeqSeries[p][seq]; agendaSeqSeries[p][seq] = running; }
  });
  // Axis labels for the sequence charts: "C3" / "R2" style, i.e. which player's
  // turn and their own turn-number that shared slot corresponds to.
  const seqAxisLabels = new Array(totalSeq + 1).fill('');
  s.turnSeqLog.forEach(({ player, turn, seq }) => {
    seqAxisLabels[seq] = (s.playerSide[player] === 'corp' ? 'C' : s.playerSide[player] === 'runner' ? 'R' : player[0]) + turn;
  });
  return {
    totalSeq, seqAxisLabels, agendaSeqSeries,
    creditsNetSeqSeries: netSeries(players, creditsGainedSeqSeries, creditsSpentSeqSeries),
    creditPoolSeqSeries, handSizeSeqSeries, cardsDrawnSeqSeries
  };
}

// Tags the Runner took (given by the Corp or taken by the Runner's own
// choice) and tags the Corp gave.
function tagTotals(s, players){
  const runnerPlayer = players.find(p => s.playerSide[p] === 'runner');
  const tagsGained = {};
  if (runnerPlayer){
    let total = 0;
    s.rawTagEvents.forEach(e => {
      if (e.kind === 'give') total += e.amount;
      else if (e.kind === 'take' && e.actor === runnerPlayer) total += e.amount;
    });
    tagsGained[runnerPlayer] = total;
  }
  const corpPlayer = players.find(p => s.playerSide[p] === 'corp');
  const tagsGiven = {};
  if (corpPlayer){
    tagsGiven[corpPlayer] = s.rawTagEvents.filter(e => e.kind === 'give').reduce((a, e) => a + e.amount, 0);
  }
  return { tagsGained, tagsGiven };
}

// Final score per player, in log order (includes forfeits and negative
// agendas), and how the game was won.
function gameOutcome(s, players){
  const finalScore = {};
  players.forEach(p => { finalScore[p] = 0; });
  s.agendaEvents.forEach(e => { if (e.player in finalScore) finalScore[e.player] += e.points; });
  let winReason = null;
  const winner = s.winner;
  if (winner){
    if (s.flatlinedPlayer && s.flatlinedPlayer !== winner) winReason = 'flatline';
    else if (s.deckedPlayer && s.deckedPlayer !== winner) winReason = 'decked';
    else if (s.concededPlayer && s.concededPlayer !== winner) winReason = 'concede';
    else if ((finalScore[winner] || 0) >= 7) winReason = 'agenda';
  }
  return { finalScore, winReason };
}

function buildResult(s, chatBadges, undos){
  const rounds = Object.keys(s.maxTurn).length ? Math.max(...Object.values(s.maxTurn)) : 0;
  const players = Object.keys(s.maxTurn);

  // Netrunner is always exactly corp vs runner. More than 2 distinct "players"
  // means something upstream mis-parsed (e.g. a name got mangled and started
  // being tracked as a separate actor) — surface that clearly instead of quietly
  // rendering extra series the rest of the UI isn't built to handle.
  let playerCountError = null;
  if (players.length > 2){
    playerCountError = `Detected ${players.length} distinct players (${players.join(', ')}), but Netrunner is always exactly 2 (corp vs runner). The log likely didn't parse cleanly — check the pasted text for stray or mangled lines.`;
    s.flagged.unshift({ reason: playerCountError, line: '(see player list above)' });
  }

  const turnSeries = buildTurnSeries(s, players, rounds);
  const seqSeries = buildSeqSeries(s, players);
  const { tagsGained, tagsGiven } = tagTotals(s, players);
  const { finalScore, winReason } = gameOutcome(s, players);

  return {
    installedRows: buildInstalledRows(s), opsRows: buildOpsRows(s), flagged: s.flagged,
    maxTurn: s.maxTurn, rounds, winner: s.winner, concededPlayer: s.concededPlayer, players, playerCountError,
    drawClicks: s.drawClicks, tagRemovals: s.tagRemovals, trashResources: s.trashResources,
    clickCredits: s.clickCredits, installClicks: s.installClicks, advanceClicks: s.advanceClicks,
    purgeClicks: s.purgeClicks,
    playerSide: s.playerSide, chatBadges, agendaSeries: turnSeries.agendaSeries,
    totalGained: s.totalGained, totalSpent: s.totalSpent, totalDraws: s.totalDraws,
    cardsRezzed: s.cardsRezzed, tagsGained, runsMade: s.runsMade, eventsPlayed: s.eventsPlayed,
    cardsAccessed: s.cardsAccessed, breachCounts: s.breachCounts, clicksGained: s.clicksGained,
    creditsGainedSeries: turnSeries.creditsGainedSeries, creditsNetSeries: turnSeries.creditsNetSeries,
    creditPoolSeries: turnSeries.creditPoolSeries, handSizeSeries: turnSeries.handSizeSeries,
    cardsDrawnSeries: turnSeries.cardsDrawnSeries,
    totalSeq: seqSeries.totalSeq, seqAxisLabels: seqSeries.seqAxisLabels,
    agendaSeqSeries: seqSeries.agendaSeqSeries, creditsNetSeqSeries: seqSeries.creditsNetSeqSeries,
    creditPoolSeqSeries: seqSeries.creditPoolSeqSeries,
    poolSegments: s.poolSegments, finalCreditPool: s.creditPool, undos,
    agendaEvents: s.agendaEvents, finalScore, winReason,
    flatlinedPlayer: s.flatlinedPlayer, deckedPlayer: s.deckedPlayer,
    mulligans: players.filter(p => s.mulligans.has(p)),
    damageTaken: s.damageTaken, opposingTrashes: s.opposingTrashes, tagsGiven,
    handSizeSeqSeries: seqSeries.handSizeSeqSeries, cardsDrawnSeqSeries: seqSeries.cardsDrawnSeqSeries
  };
}

// ---- Achievements ----
// Each entry is evaluated per player, only for the side it belongs to. A
// check gets the context built by achievementContext() below and returns
// true when earned. To add one, append an entry here — nothing else needs
// changing.
const ACHIEVEMENTS = [
  { id: 'no-click-credit', side: 'corp', name: 'Off the Books',
    description: 'Won without ever clicking for a credit.',
    check: c => c.won && c.clickCreditCount === 0 },
  { id: 'no-click-credit', side: 'runner', name: 'No Day Job',
    description: 'Won without ever clicking for a credit.',
    check: c => c.won && c.clickCreditCount === 0 },
  { id: 'no-click-draw', side: 'corp', name: 'Mandatory Minimum',
    description: 'Won without ever clicking to draw.',
    check: c => c.won && c.clickDrawCount === 0 },
  { id: 'no-click-draw', side: 'runner', name: 'A Diesel a Day',
    description: 'Won without ever clicking to draw.',
    check: c => c.won && c.clickDrawCount === 0 },
  { id: 'rich', side: 'corp', name: 'Too Big to Fail',
    description: 'Had 30 or more credits in the pool at once.',
    check: c => c.peakPool >= 30 },
  { id: 'rich', side: 'runner', name: 'Savvy Investor',
    description: 'Had 30 or more credits in the pool at once.',
    check: c => c.peakPool >= 30 },
  { id: 'broke-win', side: 'corp', name: 'Unhedged',
    description: 'Won with 0 credits in the pool at the end of the game.',
    check: c => c.won && c.finalPool === 0 },
  { id: 'broke-win', side: 'runner', name: 'Sure Gamble',
    description: 'Won with 0 credits in the pool at the end of the game.',
    check: c => c.won && c.finalPool === 0 },
  { id: 'flatline-win', side: 'corp', name: 'Boom!',
    description: 'Won by flatlining the Runner.',
    check: c => c.won && c.winReason === 'flatline' },
  { id: 'flatlined-at-six', side: 'runner', name: 'One Step From Freedom',
    description: 'Got flatlined while sitting on 6 agenda points.',
    check: c => c.data.flatlinedPlayer === c.player && c.finalScore === 6 },
  { id: 'mill-win', side: 'runner', name: 'Keyhole',
    description: 'Won by milling the Corp: they had to draw from an empty R&D.',
    check: c => c.won && c.winReason === 'decked' },
  { id: 'mill-win-no-points', side: 'runner', name: 'Apocalypse',
    description: 'Won by mill with 0 or fewer agenda points.',
    check: c => c.won && c.winReason === 'decked' && c.finalScore <= 0 },
  { id: 'shutout', side: 'corp', name: 'Government Takeover',
    description: 'Won on agenda points while the Runner stole none.',
    check: c => c.won && c.winReason === 'agenda' && c.oppPointsGained === 0 },
  { id: 'shutout', side: 'runner', name: 'Inside Job',
    description: 'Won on agenda points while the Corp scored none.',
    check: c => c.won && c.winReason === 'agenda' && c.oppPointsGained === 0 },
  { id: 'comeback', side: 'corp', name: 'Crisis Management',
    description: 'Won after trailing 0–6 on agenda points.',
    check: c => c.won && c.trailedZeroSix },
  { id: 'comeback', side: 'runner', name: 'Out of the Ashes',
    description: 'Won after trailing 0–6 on agenda points.',
    check: c => c.won && c.trailedZeroSix },
  { id: 'fast-win', side: 'corp', name: 'Fast Advance',
    description: 'Won on agenda points by the end of turn 6.',
    check: c => c.won && c.winReason === 'agenda' && c.data.rounds <= 6 },
  { id: 'fast-win', side: 'runner', name: 'Early Bird',
    description: 'Won on agenda points by the end of turn 6.',
    check: c => c.won && c.winReason === 'agenda' && c.data.rounds <= 6 },
  { id: 'tags', side: 'corp', name: 'Public Enemy Made',
    description: 'Won after giving the Runner 10 or more tags over the game.',
    check: c => c.won && (c.data.tagsGiven[c.player] || 0) >= 10 },
  { id: 'tags', side: 'runner', name: 'Most Wanted',
    description: 'Won after taking 10 or more tags over the game.',
    check: c => c.won && (c.data.tagsGained[c.player] || 0) >= 10 },
  { id: 'trasher', side: 'corp', name: 'Asset Seizure',
    description: 'Trashed 5 or more of the Runner’s cards.',
    check: c => (c.data.opposingTrashes[c.player] || 0) >= 5 },
  { id: 'trasher', side: 'runner', name: 'Demolition Run',
    description: 'Trashed 5 or more of the Corp’s cards.',
    check: c => (c.data.opposingTrashes[c.player] || 0) >= 5 },
  { id: 'attrition-win', side: 'corp', name: 'Acceptable Losses',
    description: 'Won after the Runner trashed 5 or more of your cards.',
    check: c => c.won && (c.data.opposingTrashes[c.opp] || 0) >= 5 },
  { id: 'attrition-win', side: 'runner', name: 'Scar Tissue',
    description: 'Won after taking 5 or more damage.',
    check: c => c.won && (c.data.damageTaken[c.player] || 0) >= 5 },
  { id: 'mulligan-win', side: 'corp', name: 'Board Restructure',
    description: 'Won after taking a mulligan.',
    check: c => c.won && c.data.mulligans.includes(c.player) },
  { id: 'mulligan-win', side: 'runner', name: 'Fresh Identity',
    description: 'Won after taking a mulligan.',
    check: c => c.won && c.data.mulligans.includes(c.player) }
];

// Highest credit pool a player held at any moment, from the line-by-line
// pool tracked during parsing. Values printed on turn start/end lines are
// exact. Values in between are derived; where a stretch between two turn
// lines didn't add up to the printed value at its end (see poolSegments),
// they're corrected downward by the overshoot, so a misread gain can't
// award the achievement on its own.
function peakCreditPool(data, player){
  let peak = 0;
  (data.poolSegments[player] || []).forEach(seg => {
    peak = Math.max(peak, seg.start);
    if (seg.expected !== null) peak = Math.max(peak, seg.expected);
    const correction = seg.ok === false ? Math.min(0, seg.expected - seg.end) : 0;
    seg.values.forEach(v => { peak = Math.max(peak, v + correction); });
  });
  return peak;
}

function achievementContext(data, player){
  const opp = data.players.find(p => p !== player) || null;
  // Replay agenda events in log order to see whether the player was ever
  // behind 0–6 (current score, so forfeits and negative agendas count).
  const score = {};
  data.players.forEach(p => { score[p] = 0; });
  let trailedZeroSix = false;
  let oppPointsGained = 0;
  data.agendaEvents.forEach(e => {
    if (!(e.player in score)) return;
    score[e.player] += e.points;
    if (e.player === opp && e.points > 0) oppPointsGained += e.points;
    if (opp && score[player] <= 0 && score[opp] >= 6) trailedZeroSix = true;
  });
  const finalPool = data.finalCreditPool[player];
  return {
    data, player, opp,
    side: data.playerSide[player],
    won: data.winner === player,
    winReason: data.winReason,
    finalScore: data.finalScore[player] || 0,
    oppPointsGained,
    trailedZeroSix,
    clickCreditCount: (data.clickCredits[player] || { count: 0 }).count,
    clickDrawCount: data.drawClicks[player] || 0,
    peakPool: peakCreditPool(data, player),
    finalPool: finalPool === undefined ? null : finalPool
  };
}

function evaluateAchievements(data){
  const earned = {};
  data.players.forEach(p => {
    const side = data.playerSide[p];
    const ctx = achievementContext(data, p);
    earned[p] = ACHIEVEMENTS.filter(a => a.side === side && a.check(ctx));
  });
  return earned;
}

globalThis.TraceParser = { parseLog, evaluateAchievements, ACHIEVEMENTS };
})();
