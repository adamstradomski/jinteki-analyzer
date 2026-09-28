# Manual check: Standard Balance Update 26.08, Megacity+

Checked on 2026-09-28 against snapshot `2026-09-28T114117Z` (the first with ban lists chosen by the
decks played).

## Method

Card statistics were recomputed from the canonical tables in R2 (`tournament`, `entry`, `game`,
`deck`, `deck_card`) with SQL written for this check, without the pipeline's `metrics.py` or
`publish.py`, and compared with the published slice
`meta/{side}/standard_balance_update_26_08/megacity/summary.json`.

Same definitions as the page:

- Decks: legal decks with a known decklist, of that side, in the slice's tournaments (at least 8
  players), in the summary period.
- Inclusion: decks with the card ÷ decks. Average copies: copies ÷ decks with the card.
- Games: games those decks played on that side, intentional draws excluded; a draw counts as half a
  win. Baseline: the same over every deck of the side.
- Winrate difference and the Wilson 95% interval (z = 1.96) are shown minus the baseline, in
  percentage points. Fewer than 30 games is a small sample.

## Result

**Every value matches.** The only differences are rounding: the published files keep 3 decimals for
average copies and 2 for percentage points.

## Tournaments

Six tournaments, all continental championships with game results:

| Cobra tournament | Date | Players | Cut | Decklist coverage |
|---|---|---|---|---|
| [4965](https://tournaments.nullsignal.games/tournaments/4965) | 2026-08-01 | 89 | top 16 | 31% |
| [4993](https://tournaments.nullsignal.games/tournaments/4993) | 2026-08-15 | 91 | top 16 | 32% |
| [4977](https://tournaments.nullsignal.games/tournaments/4977) | 2026-08-22 | 133 | top 16 | 37% |
| [5041](https://tournaments.nullsignal.games/tournaments/5041) | 2026-08-29 | 60 | top 8 | 25% |
| [5052](https://tournaments.nullsignal.games/tournaments/5052) | 2026-09-05 | 105 | top 16 | 32% |
| [4792](https://tournaments.nullsignal.games/tournaments/4792) | 2026-09-12 | 63 | top 8 | 35% |

The summary period is July to September 2026 (the last three months with data); all of these games
are from August and September, since Balance Update 26.08 started on 1 August.

## Baselines

| Side | Decks | Games | Winrate |
|---|---|---|---|
| Corp | 177 | 928 | 62.82% |
| Runner | 177 | 942 | 56.00% |

## Cards

| Card | Side | Decks | Inclusion | Avg copies | Games | Wins | Winrate | vs baseline | 95% interval | Sample |
|---|---|---|---|---|---|---|---|---|---|---|
| Measured Response | Corp | 103 | 58.2% | 2.45 | 536 | 340.5 | 63.5% | +0.7 pp | −3.5 → +4.7 pp | ok |
| Slash and Burn Agriculture | Corp | 55 | 31.1% | 2.36 | 289 | 179 | 61.9% | −0.9 pp | −6.6 → +4.5 pp | ok |
| Vampyronassa | Corp | 1 | 0.6% | 1.00 | 6 | 5 | 83.3% | +20.5 pp | −19.2 → +34.2 pp | small |
| Pinhole Threading | Runner | 151 | 85.3% | 2.40 | 805 | 458.5 | 57.0% | +1.0 pp | −2.5 → +4.3 pp | ok |
| Hermes | Runner | 80 | 45.2% | 2.13 | 420 | 242.5 | 57.7% | +1.7 pp | −3.0 → +6.4 pp | ok |
| Maintenance Access | Runner | 7 | 4.0% | 1.00 | 39 | 26 | 66.7% | +10.7 pp | −5.0 → +23.4 pp | ok |

## Reading it

- Every 95% interval spans 0, so on this data none of the six cards has a winrate clearly different
  from the side's average deck. Vampyronassa's +20.5 pp comes from a single deck and 6 games.
- Decklist coverage in these events is 25–37%, so the card statistics describe the decks that were
  published, not every player.
