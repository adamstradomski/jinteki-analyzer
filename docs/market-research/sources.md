# Market Research: data sources

What each source provides, the endpoints the clients call, the fields kept, and what was verified.

**How this was verified (2026-09-27).** The build environment's network policy blocked
`alwaysberunning.net`, `tournaments.nullsignal.games`, `netrunnerdb.com` and `api.netrunnerdb.com`,
so no live request was made. Cobra and NetrunnerDB are open source, so their behaviour was checked
against their code instead:

| Source | Checked against |
|---|---|
| NSG Cobra | `github.com/Project-NISEI/cobra` @ `4f9c57b` (2026-09-27): `config/routes.rb`, `app/resources/*`, `app/services/nrtm_json.rb`, `app/views/players/view_decks.html.slim`, `app/models/{deck,stage,tournament}.rb`, `db/schema.rb` |
| NetrunnerDB v2 | `github.com/NetrunnerDB/netrunnerdb` @ 2026-09-18: `routing.yml`, `PublicApi20Controller.php`, `Entity/{Decklist,Deck}.php`, `web/robots.txt` |
| NetrunnerDB v3 | `github.com/NetrunnerDB/netrunnerdb-api-server` @ 2026-08-27: `config/routes.rb`, `app/resources/*`, `app/models/restriction.rb` |
| Card data for fixtures | `github.com/NetrunnerDB/netrunner-cards-json` @ 2026-08-31 |
| AlwaysBeRunning | **Not verified.** The API docs at `alwaysberunning.net/apidoc` were unreachable and no source repository was found. The client follows the brief and is deliberately lenient (see below). Check it against the apidoc before the first live run. |

The fixtures in `market-research/tests/fixtures/http/` are shaped from this reading of the code.

## Host rules (all sources)

Only `alwaysberunning.net`, `tournaments.nullsignal.games`, `netrunnerdb.com` and `api.netrunnerdb.com`
are ever contacted, over HTTPS, one request at a time per host, at the configured rate, with
robots.txt obeyed. `netrunnerdb.com` and `api.netrunnerdb.com` share one budget and rate (same
operators). Every URL is built by the client from constants and IDs parsed with strict regexes;
no URL taken from data is ever fetched. `makers-eye.com` disallows crawling and is never fetched.

robots.txt at the time of checking: Cobra's is all comments (nothing disallowed). NetrunnerDB's
disallows only a list of named crawlers (Amazonbot, GPTBot, …), not `MarketResearch`.

## AlwaysBeRunning (ABR)

Please link back to [alwaysberunning.net](https://alwaysberunning.net); the page footer and every
manifest (`attribution`) do.

| Use | Request |
|---|---|
| Recent events (each run) | `GET /api/tournaments?approved=1&concluded=1&desc=1&start=<today−60d as YYYY.MM.DD.>` |
| Weekly sweep | same with `start=<today−1y>&end=<today−60d>` |
| Monthly full sweep, backfill | `GET /api/tournaments/results?limit=200&offset=<n>` (never more than 200 per page) |
| Entries | `GET /api/entries?id=<tournament id>` |

Event fields kept: `id`, `date`, `type` (or `type_id`), `format`, `cardpool`, `approved`, `concluded`,
`players_count`, `top_count`, `claim_count`, `claim_conflict`, `matchdata`, `location_country`,
`winner_corp_identity`, `winner_runner_identity`. Everything else (title, contact, creator, address,
venue, coordinates, links, …) is recognised and dropped.

Entry fields kept: `rank_swiss` (the entry key; ABR entries have no ID), `rank_top`
(`null` = missed the cut, `0` = no cut), `corp_deck_identity_id`, `runner_deck_identity_id`
(NRDB printing codes), and the deck ID parsed from `corp_deck_url` / `runner_deck_url`:
`https://netrunnerdb.com/<lang>/decklist/<id|uuid>/…` → published decklist,
`https://netrunnerdb.com/<lang>/deck/view/<id|uuid>` → private shared deck. Any other URL is dropped
and counted in the quality report as a rejected deck reference. User IDs and names, import names
and deck titles are dropped.

Unverified assumptions, handled leniently:

- The `date` field may be `YYYY.MM.DD.` or ISO; both are accepted.
- `type` may be a number or a name; the tier mapping in `pipeline/market_research/data/tiers.json`
  accepts both. The numeric IDs there (1 GNK … 5 worlds … 17 megacity) are the brief's plus best
  knowledge and **must be checked** against the apidoc.
- `abr_code` from Cobra is resolved to an ABR ID only when it is numeric and that ID exists. The
  exact format of the code ABR returns on upload is not known; otherwise the fallback match is used.

## NSG Cobra (`tournaments.nullsignal.games`)

| Use | Request | Verified |
|---|---|---|
| Discovery | `GET /api/v1/public/tournaments?page[number]=<n>&page[size]=250&sort=-id` | Graphiti resource; `sort` on `id`, pagination on; default page size 25, max 1000. `private` tournaments are already excluded by the public scope. |
| Reference tables | `GET /api/v1/public/{formats,tournament_types,deckbuilding_restrictions}?page[number]=1&page[size]=250` | |
| Results | `GET /tournaments/<id>.json` (NRTM export) | `TournamentsController#show`, `NrtmJson` |
| Settings re-check | `GET /api/v1/public/tournaments/<id>` | only for finished events whose decks are not public |
| Decks | `GET /tournaments/<t>/players/<p>/view_decks` | hidden inputs `#corp_deck`, `#runner_deck` |

Findings, including where Cobra differs from the brief:

- **Games come from the NRTM export, not the pairings API.** The public pairings resource exposes
  only combined `score1`/`score2` and a `side`, so double-sided swiss games cannot be split from it.
  The export gives, per pairing: single-sided `role`, `corpScore`, `runnerScore`; double-sided
  per-side scores for both players; elimination games only a boolean `winner` per player. One request
  per tournament covers players, standings and every round.
- The export's `rounds` is a list of rounds (swiss first, then cut) without stage numbers. The
  first `preliminaryRounds` rounds are stage 1; later rounds (or games flagged `eliminationGame`)
  are stage 2. The export does not say single or double elimination; stages are recorded as
  `swiss` / `single_sided_swiss` and `elimination` with the cut size (`cutToTop`).
- Identities in the export are **titles** (curly quotes replaced), resolved to NRDB card IDs through
  the catalog during normalization. The export has no `active`/dropped flag and no per-side points;
  those record fields stay null.
- `format_id` and `tournament_type_id` are rows of Cobra's own tables, not fixed numbers, so Standard
  is detected by the format **name** ("Standard") from `/formats`, and tiers by the type name.
  Tournaments created before Cobra had a format setting (early 2025) have no `format_id`. They are
  fetched, and normalization decides: the linked ABR event's `format` if there is one, otherwise not
  Standard when the name names another format (Startup, Eternal, draft, …) or an identity is not
  legal in Standard around the event date.
- `deckbuilding_restriction_id` values are NetrunnerDB v3 restriction IDs (Cobra syncs them from
  `api.netrunnerdb.com/api/v3/public/restrictions`), so they are used directly.
- Deck visibility values are enums such as `swiss_decks_public`, `cut_decks_open`; they are mapped to
  `public` / `open` / `private`. A player's decks are visible anonymously only if a stage they are
  registered in is `public` (`Stage#decks_visible_to?`); "open" means participants and the organiser.
  Deck pages are requested only for public stages and never with credentials.
- `view_decks` inputs hold `Deck#as_view`: `{details: {...all deck columns, mine, player_name}, cards:
  [...deck_card columns]}`. Kept: identity card and printing IDs, `nrdb_uuid`, per card
  `nrdb_card_id`, `nrdb_printing_id`, `quantity`. Dropped: deck name, `user_id`, `player_name`, card
  titles and everything else. The page also shows the player's name in an `<h4>`; only the two inputs
  are read (selectolax, no scripts).
- The export and API send ETags (Rails); conditional requests use `If-None-Match`.
- There is no "concluded" flag: an event is live while its date is within 3 days, or while any
  pairing is unreported, up to 14 days after its date; after that it counts as finished even with a
  result missing, so its decks are still fetched. A bye can have the player in either seat (p1 or p2).

## NetrunnerDB

### v3 catalog (`api.netrunnerdb.com/api/v3/public`)

`GET /{card_sets,restrictions,formats,snapshots}?page[number]=1&page[size]=1000` each run
(conditional), and `GET /{cards,printings}?page[number]=<n>&page[size]=500` (about 5 pages each) only when a new card set
or restriction appears. JSON:API (Graphiti), pagination links on; cards and printings allow page
sizes up to 10 000, but a full page of either is about 9 MB (1 000 is already about 4.5 MB), over the
runner's 5 MB response cap, so they are fetched 500 at a time.

Kept: cards (`id`, `title`, `side_id`, `card_type_id`, `faction_id`, `influence_cost`,
`influence_limit`, `minimum_deck_size`, `deck_limit`, `agenda_points`, `is_unique`, `card_pool_ids`,
`printing_ids`); printings (`id`, `card_id`, `card_set_id`, `date_release`); card sets (`id`, `name`,
`date_release`, `card_cycle_id`); formats; restrictions (`id`, `name`, `date_start`, `format_id`,
`point_limit`, `verdicts` = `{banned, restricted, universal_faction_cost, global_penalty, points}`);
snapshots (`id`, `format_id`, `card_pool_id`, `restriction_id`, `date_start`, `active`).

Card IDs are v3 slugs (`hedge_fund`); printing IDs are the numeric codes (`30010`, `36043`) that v2
decklists and ABR use.

### v2 decklists (`netrunnerdb.com/api/2.0/public`)

| Use | Request |
|---|---|
| Bulk (each run: yesterday and today; backfill: every day) | `GET /decklists/by_date/YYYY-MM-DD` |
| One published decklist | `GET /decklist/<id>` or `/decklist/<uuid>` |
| One private shared deck | `GET /deck/<id>` or `/deck/<uuid>` |

Verified: responses are `{data: [...], total, success, version_number, last_updated}`; a missing
decklist returns HTTP 200 with `success: false` (handled as not found); `by_date` uses the decklist's
creation date and refuses future dates; responses carry `Last-Modified` and honour
`If-Modified-Since` (no ETag). `cards` is a map of **printing code → quantity including the
identity**; the identity is identified through the catalog. Private decks are served only when the
owner shares decks (otherwise 403). Kept: `id`, `uuid`, `date_creation` (as `published`), cards.
Dropped: name, description, user, tags, votes, comments.

By-day files are stored per day (`nrdb/decklists/by_date/<date>.json`, cards only). A claimed decklist
is fetched singly only if it is not in any stored by-day file from the day before the event to 14
days after.
