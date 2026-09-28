# Market Research

Market Research is the tournament card-meta backend for [jinteki.win](https://jinteki.win/market-research/).
It collects NSG Netrunner **Standard** tournament results and decklists, stores them **without any
personal data**, and publishes precomputed card-meta snapshots that the static page at
`/market-research/` reads from `data.jinteki.win`.

Tournament data comes from [AlwaysBeRunning.net](https://alwaysberunning.net) (please visit and
support it) and [NSG Cobra](https://tournaments.nullsignal.games); decklists and the card catalog
come from [NetrunnerDB](https://netrunnerdb.com).

Fan project, not affiliated with Null Signal Games.

## What it answers

For each side (Corp, Runner), per ban list, tier group and period:

1. **Most played cards**: inclusion rate, average copies, rank. Identities separately.
2. **Popularity trend**: monthly and per-ban-list series, change against the previous period, risers and fallers.
3. **Card winrate**: difference from the side's baseline in the same slice, Wilson 95% interval, minimum sample.
4. **Popularity vs winrate**: both joined, ready for a scatter plot.
5. **Top-cut conversion**: on high-decklist-coverage tournaments only, against the side's cut rate.

Every card played in a slice is included (not a top N). Definitions: [docs/market-research/metrics.md](../docs/market-research/metrics.md).

## Layout

```
market-research/
  pipeline/market_research/   the Python package (CLI: market-research)
    http.py                   PoliteHttp: allowlist, rate limits, backoff, breaker, budget, robots.txt
    sources/                  ABR, Cobra and NetrunnerDB clients (parse into allowlisted records)
    records.py, scrub.py      scrubbed source record schemas, drift and quarantine
    frontier.py, ingest.py    crawl frontier (state/frontier.parquet) and the ingest loop
    normalize.py, catalog.py  canonical Parquet tables, linking, legality
    metrics.py, publish.py    additive counts, snapshot slices, validation, publishing
    runner.py, cli.py         run-all, backfill phases and --plan, CLI
    schemas/                  JSON Schemas of the snapshot contract
    data/tiers.json           the tier-group mapping (the one place it lives)
  tests/                      offline tests (network disabled) and anonymised fixtures
  Dockerfile, requirements.lock, .env.example
```

Docs: [architecture](../docs/market-research/architecture.md), [sources](../docs/market-research/sources.md),
[data model](../docs/market-research/data-model.md), [metrics](../docs/market-research/metrics.md),
[snapshot contract](../docs/market-research/snapshot-contract/), [operations](../docs/market-research/operations.md).

## Development

Python 3.12.

```sh
cd market-research
python3.12 -m venv .venv && . .venv/bin/activate
pip install --require-hashes --no-deps -r requirements-dev.lock
pip install --no-deps --no-build-isolation -e .

ruff check pipeline tests && ruff format --check pipeline tests
mypy
pytest --cov                     # sockets are disabled for every test
```

Run the whole pipeline locally against the recorded fixtures, without network or R2:

```sh
market-research run-all --dry-run --fixtures tests/fixtures/http --now 2026-09-27T04:00:00Z
market-research backfill --plan --since 2026-06-01 --dry-run --fixtures tests/fixtures/http --now 2026-09-27T04:00:00Z
```

`--dry-run` uses a `LocalObjectStore` in a temporary directory (its path is logged). `--fixtures`
and `--now` are hidden development options.

Golden files (`tests/fixtures/expected/`) are regenerated with `MR_UPDATE_GOLDEN=1 pytest`; review the diff.
The raw HTTP fixtures are generated from real card data by `tests/fixtures/generate.py` (see its docstring).
`market-research fixtures refresh --cobra ID | --abr ID` captures one live tournament, anonymised with
canaries, into `tests/fixtures/refresh/` for review. It is manual only and never runs in CI.

## CLI

```
market-research ingest   [--budget N] [--source abr|cobra|nrdb] [--dry-run]
market-research normalize
market-research compute  [--no-publish]
market-research run-all  [--budget N] [--dry-run]         # ingest -> normalize -> compute/publish
market-research backfill [--since YYYY-MM-DD] [--plan] [--phase 1|2|3] [--dry-run]
market-research report                                     # print the latest quality report
market-research fixtures refresh --cobra ID | --abr ID [--out DIR]   # manual only
```

Every command reads its configuration from environment variables ([.env.example](.env.example)).
Without `--dry-run` it uses the R2 buckets, or the directory in `MR_LOCAL_STORE` when that is set.

| Command | What it does | Network | Writes | Publishes | Log in R2 |
|---|---|---|---|---|---|
| `ingest` | Fetches what the crawl frontier says is due, newest and biggest first, within each host's request budget. | ABR, Cobra, NetrunnerDB | source records, frontier and ingest quality state | no | yes |
| `normalize` | Rebuilds the canonical tables (tournament, entry, game, deck, deck_card) from all source records. | none | canonical tables, normalize quality | no | yes |
| `compute` | Computes every slice from the canonical tables, validates it against the schemas and publishes a new `v=<version>/`, `manifest.json` last. | none | published snapshot | yes | yes |
| `run-all` | `ingest`, then `normalize`, then `compute`. The daily scheduled command. | all three hosts | all of the above | yes | yes |
| `backfill` | The initial or extended history load: no per-run budget, in three phases, publishing after each; resumable. | all three hosts | all of the above | after each phase | yes, also after each phase |
| `backfill --plan` | Makes only the listing requests and prints requests and estimated duration per host and phase. | listings only | nothing but its log | no | yes |
| `report` | Prints the latest published `quality/report.json`. | none | nothing | no | no |
| `fixtures refresh` | Fetches one live tournament, anonymises it with canaries and writes fixture files for review. | the chosen host | files in `--out` only | no | no |

Options:

| Option | Commands | Meaning |
|---|---|---|
| `--budget N` | `ingest`, `run-all` | Requests per host for this run (default 400, or `MR_BUDGET`). |
| `--source abr\|cobra\|nrdb` | `ingest` | Fetch from this source only. |
| `--no-publish` | `compute` | Build and validate the snapshot without uploading it. |
| `--since YYYY-MM-DD` | `backfill` | Start date. Default: the start of the oldest ban list still relevant to Standard, or 24 months back, whichever is earlier. A later backfill with an earlier date adds the missing history. |
| `--plan` | `backfill` | Plan only (see above). |
| `--phase 1\|2\|3` | `backfill` | Run one phase: 1 = events of the last 90 days, 2 = older Megacity+ events, 3 = everything else. Listings, card data and daily decklist files (phase 0) run with every phase. |
| `--dry-run` | `ingest`, `run-all`, `backfill` | Use a `LocalObjectStore` in a new temporary directory instead of R2; its path is logged as `dry_run_store`. |
| `--cobra ID` / `--abr ID` | `fixtures refresh` | The tournament to capture; give exactly one. |
| `--out DIR` | `fixtures refresh` | Output directory (default `tests/fixtures/refresh`). |
| `--fixtures DIR` (hidden) | `ingest`, `normalize`, `run-all`, `backfill`, `report` | Serve every HTTP request from a recorded fixture directory. Development and tests only. |
| `--now ISO-TIME` (hidden) | `ingest`, `normalize`, `compute`, `run-all`, `backfill` | Pin the clock, e.g. `2026-09-27T04:00:00Z`. Development and tests only. |

Exit codes: `0` success, `2` partial (a host tripped its circuit breaker, publish still happened),
`1` failure (nothing published; the previous manifest stays live). `report` exits `1` when nothing
has been published yet.

Logs are JSON lines on stdout. The first line (`run_log`) names the R2 key the log is uploaded to
(`logs/<date>/<start>-<command>.jsonl.gz` in the canonical bucket) and the last is `run_summary`
(requests per host, 304s, new records, decks added, slices published, duration). See
[operations.md](../docs/market-research/operations.md#run-logs).

### Through Docker

In production every command runs in the image, with the same arguments after the image name:

```sh
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --env-file market-research/market-research.env market-research:0.1.0 <command> [options]
```

In Git Bash on Windows, prefix it with `MSYS_NO_PATHCONV=1`, or Git Bash rewrites `/tmp` into a
Windows path and Docker refuses it. For a long backfill, run it detached with a name
(`docker run -d --name mr-backfill …`) instead of `--rm`, and follow it with `docker logs -f mr-backfill`.

## Running it

One Docker image, run by the host scheduler; it keeps no state on local disk between runs.

```sh
docker build -t market-research:0.1.0 market-research
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --env-file market-research.env market-research:0.1.0 run-all
```

Configuration comes only from environment variables; see [.env.example](.env.example). Buckets,
the scoped R2 token, the custom domain, cache rules, **the R2 lifecycle rule that removes old
versions** (the runner never deletes), scheduler examples and the first-backfill procedure
(including telling the ABR maintainer and NSG beforehand) are in
[operations.md](../docs/market-research/operations.md).
