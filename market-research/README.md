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
market-research backfill [--since YYYY-MM-DD] [--plan] [--phase 1|2|3]
market-research report                                     # print the latest quality report
market-research fixtures refresh --cobra ID | --abr ID     # manual only
```

Exit codes: `0` success, `2` partial (a host tripped its circuit breaker, publish still happened),
`1` failure (nothing published). Logs are JSON lines on stdout ending with a `run_summary` line.

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
