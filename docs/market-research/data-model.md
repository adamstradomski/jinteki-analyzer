# Market Research: data model and privacy

Three layers, three R2 buckets: scrubbed **source records** (`mr-source`), **canonical tables**
and pipeline state (`mr-canonical`), and published **snapshots** (`mr-published`, see
[snapshot-contract/](snapshot-contract/)).

## Privacy rules

- **Allowlist, not blocklist.** Each response is parsed in memory into a pydantic model that lists
  exactly the fields kept (`pipeline/market_research/records.py`); models forbid extra fields, so
  nothing else can be stored. Original payloads are never stored.
- **Drift check.** Unknown fields are ignored; their **names** (never values) are logged as a
  `drift_warning` and listed in the quality report.
- **Dropped everywhere:** player names, pronouns, NRDB/Cobra/ABR user IDs, `user_import_name`, deck
  names and titles, deck and tournament descriptions, organiser names and contacts, event and
  stream links, addresses, venues, coordinates, and card titles from decks (the catalog provides
  titles).
- **The one text kept** is a tournament's public name (ABR's `title`, Cobra's `name`), with control
  characters removed, whitespace collapsed and at most 120 characters, for the published list of
  tournaments counted.
- **Players exist only as source-local keys:** the Cobra player ID and the ABR `rank_swiss`. There is
  no global player identity and nothing links a player across tournaments.
- **Snapshots are aggregates only:** IDs, catalog card titles, tournament names and numbers. Nothing
  per player or per entry is published, and no other free text appears anywhere.
- **Quarantine.** An unparsable response is recorded as its frontier key, the error class and
  message (never payload text) and a payload hash field, and the run continues. No payload is kept.
- **Tests prove it.** Every personal field in the fixtures holds a `PII_CANARY_*` value; the tests
  scan all source records, state files, canonical tables, snapshots, logs and the quality report
  and fail if a canary appears.

**Record hash** = `sha256:` + SHA-256 of the canonical JSON (sorted keys, compact) of the scrubbed
record, excluding `record_hash` and `fetched_at`. A record is rewritten only when its hash changes,
so edits to dropped fields (a renamed deck, a new description) never count as changes.

## Source records (`mr-source`)

```
cobra/tournament/{id}.json                  cobra.tournament/1
cobra/deck/{tournamentId}/{playerId}-{side}.json   cobra.deck/1
cobra/catalog/{formats|tournament_types|deckbuilding_restrictions}.json   cobra.catalog/1 (public reference data)
abr/tournament/{id}.json                    abr.tournament/1
abr/entries/{id}.json                       abr.entries/1
nrdb/decklist/{id}.json                     nrdb.decklist/1  (kind "decklist": fetched singly)
nrdb/deck/{id}.json                         nrdb.decklist/1  (kind "deck": private shared deck)
nrdb/decklists/by_date/{date}.json          nrdb.by_date/1   (every decklist published that day, cards only)
nrdb/catalog/{cards|printings|card_sets|formats|restrictions|snapshots}.json   nrdb.catalog/1
import/cobra/{tournamentId}.json            import.decks/1   (decklists loaded from a file; never written by the crawler)
```

The shapes follow the brief's examples, with these differences (see [sources.md](sources.md)):

- `cobra.tournament/1` adds `stage` (Cobra's current stage) and `results_fetched`; players carry the
  identity **titles** from the NRTM export; `active`, `corp_points`, `runner_points` are null
  because the export does not include them; elimination pairings carry `winner` (1 or 2) instead of
  scores; stage 2's `format` is `elimination`.
- `abr.tournament/1` stores `type_id` as a string (ABR may send an ID or a name).
- Private shared decks use the `nrdb.decklist/1` schema with `kind: "deck"` and live under `nrdb/deck/`.
- `import.decks/1` holds one Cobra tournament's decklists loaded by `market-research import-decks`:
  `cobra_id`, `origin` (a label such as `nsg`), `imported_at`, and per deck the Cobra player ID, side,
  identity card ID and `cards` (card ID and quantity). The player's name in the file is only used to
  find the Cobra player and is not kept. Importing the tournament again replaces the record.

Examples of every record type are in `market-research/tests/fixtures/expected/source/`.

## Canonical tables (`mr-canonical/tables/*.parquet`)

| Table | Key | Columns |
|---|---|---|
| `tournament` | `tid` | cobra_id, abr_id, name, date, type, tier, format, swiss_format, restriction_id, card_set, country, online, players, cut_size, has_games, deck_visibility, decklist_coverage |
| `entry` | `tid, entry_no` (= swiss rank) | cut_rank, made_cut, corp_identity, runner_identity, points, cobra_pid, abr_swiss_rank |
| `deck` | `deck_id` = hash(tid, entry_no, side) | side, identity_card, source (`import` > `cobra` > `nrdb_decklist` > `nrdb_deck`), source_ref, card_count, plain_text, content_hash, comparison (`match`, `mismatch`, `import_only`, `cobra_only`, `nrdb_only`), legal, issues |
| `deck_card` | `deck_id, card_id` | qty, printing_id |
| `game` | `tid, stage, round, table, side` | corp_entry, runner_entry, result (`corp_win`, `runner_win`, `draw`, `intentional_draw`), elimination |

- `tid` is `c<cobra id>` for Cobra tournaments (linked or not) and `a<abr id>` for ABR-only events.
  `deck` also stores `tid` and `entry_no` for joins. `game.side` is player 1's side in that game, so the
  two games of a double-sided pairing have distinct keys.
- **Card identity** is the NetrunnerDB card ID across printings; titles, types, factions and influence
  come only from the catalog.
- **Deck precedence:** Cobra's registered list (locked at the start of the event) → the NRDB decklist
  from the ABR claim → the NRDB deck referenced by Cobra's `nrdb_uuid` (used only when the Cobra
  deck has no cards). With two sources, `comparison` records whether their cards match.
- **plain_text:** identity on the first line, then `"{qty} {catalog title}"` sorted by card type
  (agenda, asset, upgrade, operation, ice; event, hardware, resource, program) then title. It is
  identical for identical lists from any source; `content_hash` is its SHA-256.
- **Standard and ban list:** Standard when Cobra's format is named "Standard" or ABR's `format` is
  `standard`. A Cobra event without a format (created before early 2025) follows its linked ABR
  event; unlinked, it is left out when its name names another format (`not_standard_name`), an
  identity is not legal in Standard around its date (`not_standard_identities`), or no identity is
  known and the name does not say Standard (`format_unknown`). The ban list starts as Cobra's `deckbuilding_restriction_id` when it is a Standard
  restriction, otherwise the NRDB Standard snapshot in force on the event date. It is then checked
  against the event's decks: of that list, the one in force and its neighbours, the one under which
  most decks are legal replaces it, but only with at least 2 more legal decks and at least 10% of the
  event's decks (organisers play new lists early, keep old ones, or cannot pick them in Cobra). Each
  replacement is listed in the quality report's `restriction_overrides`.
- **Linking:** a Cobra `abr_code` that is an existing ABR ID links directly; otherwise a unique ABR
  event whose dates (`date` to `end_date` for multi-day events, ±1 day for time zones) include the
  Cobra date, with the same player count, and where at least 90% of ABR's (corp, runner) identity
  pairs are also in the Cobra event (ABR leaves unclaimed spots out of its entries). A candidate that
  fails only on identities is reported as `fallback_identities_differ` in the quality report.
  ABR entries attach to Cobra players by swiss rank and must agree on identities; a disagreement goes
  to the quality report and that entry's ABR claim is not used.
- **Games** are derived from pairings: single-sided swiss gives one game per pairing (3 = win,
  1 = draw); double-sided swiss gives two (one per side; a 2-for-1 pairing yields none); elimination
  gives one with the reported winner. Byes and unreported pairings yield none.
- **decklist_coverage** = entry-sides with a deck / (2 × entries).
- **Guards:** only ABR `approved = 1`, `concluded`, no `claim_conflict` (a Cobra event linked to an
  ABR event must pass the first and last too), at least 8 players (configurable), and results
  (Cobra) or entries (ABR) stored. Each event left out is counted by reason in the quality
  report's `skipped_tournaments`.
- **Tier groups** (`pipeline/market_research/data/tiers.json`): GNK/CTK; Store/District;
  Megacity+ (megacity, national, continental, intercontinental, worlds, CBI); Online/Community/Other.

## State (`mr-canonical/state/`)

| Object | What |
|---|---|
| `frontier.parquet` | the crawl frontier: `key, source, kind, entity_id, next_due, interval_s, priority, etag, last_modified, record_hash, last_status, fail_count, frozen, first_seen, last_changed` plus `event_date` (needed for the age-based ceilings). Timestamps are UTC. |
| `source_cache.parquet` | every source record's JSON keyed by object ETag, so normalization re-reads only changed records |
| `robots/{host}.json` | robots.txt per host, reused for 24 h |
| `ingest_quality.json` | drift warnings, quarantine entries, rejected deck references |
| `normalize_quality.json` | unresolved cards and identities, links and link mismatches, skipped tournaments |
| `cobra_abr_codes.json` | Cobra ID → ABR code, to skip ABR entries of linked events without claims |

Frontier keys: `abr:list:{recent|sweep|full}`, `abr:event:{id}`, `abr:entries:{id}`, `cobra:index`,
`cobra:catalog:{kind}`, `cobra:tournament:{id}`, `cobra:settings:{id}`, `cobra:deck:{tid}:{pid}`,
`nrdb:catalog:{kind}`, `nrdb:by_date:{date}`, `nrdb:decklist:{id}`, `nrdb:deck:{id}`.
