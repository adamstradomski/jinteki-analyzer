# Market Research: metrics

## Additive counts, not ratios

The pipeline stores counts per `(side, restriction, tier_group, month, card_id)`:

`decks_total, decks_with_card, copies_sum, games_total, games_won, entries_total_hc, entries_with_card_hc, cut_total_hc, cut_with_card_hc, decks_in_faction`

- `_hc` counts come only from **high-coverage tournaments**: decklist coverage ≥ 0.7 (configurable) and a cut exists.
- Baselines per slice and month: `side_decks, side_games, side_wins, side_entries_hc, side_cut_hc,
  side_games_all, side_wins_all`. `side_games`/`side_wins` count only games where that side's deck is
  known (the baseline cards are compared with); `side_games_all`/`side_wins_all` count every game, so
  the headline Corp and Runner winrates (`side_wins_all / side_games_all`) sum to 100%.

In `trends.json` the per-slice totals (`decks_total`, `entries_total_hc`, `cut_total_hc`) live once
in the baseline rows (`side_decks`, `side_entries_hc`, `side_cut_hc`) instead of being repeated on
every card row. Card rows also carry `qty1`, `qty2`, `qty3` (decks playing 1, 2, 3+ copies, for the
most common copy count) and `tournaments_hc_with_card`; baseline rows also carry `tournaments` and
`tournaments_hc`. All of these are additive too: each tournament falls in exactly one month, ban
list and tier group.

Decks per identity faction are a third table, `faction_baseline` in `trends.json`: rows of
`[month, ban list, faction, decks]` indexing the file's `factions` list, adding up to `side_decks`
for each month and ban list. They are the denominators of in- and out-of-faction popularity
(`faction_decks` in a summary's baseline).

Because every ratio is a sum divided by a sum, the UI can combine any months or tiers and compute
popularity, winrate, conversion and the Wilson interval itself (`public/market-research/data.js`).
The default views are precomputed anyway (`summary.json`, `identities.json`).

## Top-cut decks

Each slice also has a top-cut scope, `cut/summary.json` and `cut/trends.json` (manifest paths
`summary_cut`, `trends_cut`): the same card and baseline counts, computed only over decks that made
the cut in events that had one (`cut_size > 0`), and the games those decks played. Popularity is then
the share of top-cut decks playing a card, and winrate is compared with the winrate of all top-cut
decks. `side_games_all` / `side_wins_all` count every game of the players who made the cut. The period
is always the one of the all-decks scope, so both scopes cover the same months. The page's "Top-cut
decks only" switch reads these files; identities have no top-cut scope.

## Included tournaments

`meta/{restriction}/{tier_group}/tournaments.json` (manifest path `tournaments`, the same for both sides)
lists every tournament the slice counts, newest first: the events of the counts' `t` table (Standard, with a
ban list, at least the minimum players). Per event: public name, date, ban list, tier and type, online or
not, country, players, swiss format, cut size, Cobra and ABR IDs, whether it has game results,
`decklist_coverage` (entry-sides with any decklist ÷ 2 × players) and `decklists` (legal decks, the ones the
statistics use). Validation checks that the all/all list has exactly as many events as the counts.

## Definitions

- popularity = decks_with_card / decks_total
- avg_copies = copies_sum / decks_with_card
- winrate = games_won / games_total, over games where the card's deck played on the card's side, excluding intentional draws; draws count as half a win. The UI shows winrate − side baseline winrate, with the Wilson 95% interval.
- conversion = cut_with_card_hc / entries_with_card_hc, compared with side_cut_hc / side_entries_hc
- popularity_in = decks_in_faction / decks whose identity has the card's faction
- popularity_out = (decks_with_card − decks_in_faction) / (side_decks − decks whose identity has the card's faction)
- splash_share = (decks_with_card − decks_in_faction) / decks_with_card
- Winrate and conversion are marked `insufficient` below a minimum sample (default 30 games or 20 entries, configurable),
  splash share below 20 decks playing the card (`MR_MIN_SPLASH_DECKS`).
- Identities have their own section: share, winrate and conversion per identity.

## Details that follow from the definitions

- **Which decks count.** Only legal decks (card count, copies, influence, ban list, card pool, agenda
  points; see `catalog.py`) in Standard tournaments that pass the guards (ABR `approved = 1`, no
  `claim_conflict`, at least 8 players). Illegal decks stay in the canonical tables with their issues
  but never reach a metric.
- **Baseline winrate** uses the same population as the card winrate: games in the slice where the
  side's deck is known and legal. Otherwise a card played by well-documented events would be compared
  with a baseline from other events.
- **Baseline cut rate** is over entries of high-coverage tournaments that have a legal deck for the
  side.
- **Wilson 95% interval** for w wins in n games, z = 1.95996: centre (p + z²/2n)/(1 + z²/n), half-width
  z·√(p(1−p)/n + z²/4n²)/(1 + z²/n). The shown bounds are the interval minus the baseline winrate
  (the baseline's own uncertainty is not included).
- **Current and previous period.** `summary.json` covers the last `period_months` (default 3) months
  up to the slice's latest month with data; the previous period is the same number of months just
  before it. Change = popularity now − popularity before, in percentage points. Risers and fallers are
  the ten largest positive and negative changes.
- **Identities.** Share = entries with the identity / entries with a known identity for the side.
  Identity winrate uses every reported game (identities are known for all Cobra entries), with the
  same draw rules. Identity conversion uses tournaments with a cut in which identities are known for
  at least 70% of entries (the same survivor-bias guard as decks).
- **In and out of faction.** A deck plays a card in faction when its identity's faction (NetrunnerDB
  `faction_id`) is the card's, out of faction (paying influence) otherwise. Neutral cards
  and identities have no in- or out-of-faction figures. Agendas can't be played outside their
  faction, so they have in-faction popularity only. Decks on neutral or mini-faction identities
  (Adam, Apex, Sunny Lebeau) are a faction of their own: every faction card they play is out of
  faction. The previous period's figures follow `prev_popularity` (0% for a card not played then);
  a card not played then has no previous splash share.
- **Every card played in a slice** is listed, not a top N. A card played only in the previous period
  appears with 0% popularity so it can show up as a faller.
