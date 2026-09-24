# Test games

jinteki.net game logs for checking the parser by hand: paste one into the
analyzer and compare the result with the notes below. Player names are
replaced with `Corp` and `Runner`.

| File | Source | What it covers |
|---|---|---|
| `nbn-agenda-win-undo-click.log` | real game (unanonymised version of built-in example 1) | Corp agenda win, Corp mulligan, Runner `/undo-click` taking back a whole run (confirmed by credits), forced loss larger than the pool (Artificial Cryptocrash), chat lines. Credit tracking matches every turn. Achievements: Corp — Public Enemy Made, Board Restructure. |
| `hyoubu-flatline-win.log` | real game | Corp flatline win (Complete Image), both players mulligan, `/undo-click` by each side (Runner's confirmed by credits; Corp's Vera install is a best guess, since it doesn't change credits), `/undo-paid-ability` on Moon Pool (confirmed by credits), damage, Regenesis adding an agenda to the score area. Achievements: Corp — Boom!, Board Restructure. |
| `jinteki-agenda-win.log` | built-in example 2 | Long Corp agenda win (25 rounds), net damage, Runner trashing Corp cards. Credit tracking has one known 2-credit mismatch (Runner turn 19, unexplained). No achievements. |
| `synthetic-mill-win.log` | made up | Runner mill win ("Corp is decked."). Wording from jinteki.net's message strings, not a real log. Achievements: Runner — A Diesel a Day, Keyhole, Apocalypse. |
| `synthetic-myoshu-fast-win.log` | made up | Corp agenda win on turn 3 with Myōshu adding itself to the score area, Runner forfeit, comeback from 0–6, ending on 0 credits. Credit tracking matches every turn. Achievements: Corp — Off the Books, Mandatory Minimum, Unhedged, Crisis Management, Fast Advance, Board Restructure. |
