# Market Research: operations

## R2 buckets

Create three buckets in the Cloudflare dashboard (R2 → Create bucket), in one account:

| Bucket | Holds | Public |
|---|---|---|
| `mr-source` | scrubbed source records (JSON) | no |
| `mr-canonical` | canonical Parquet tables and `state/` (frontier, caches, quality) | no |
| `mr-published` | `manifest.json` and `v=<version>/` snapshots | read-only, on `data.jinteki.win` only |

### Token (least privilege)

R2 → Manage R2 API Tokens → Create API token:

- Permissions: **Object Read & Write**.
- Specify buckets: `mr-source`, `mr-canonical`, `mr-published` only.
- No TTL or a long one; rotate yearly.

Put the Access Key ID, Secret Access Key and account ID in `market-research.env` (copy of
[`.env.example`](../../market-research/.env.example)); never commit it. The runner reads secrets
only from environment variables and never logs them (log values containing them are redacted).

### Custom domain and cache rules

- `mr-published` → Settings → Custom Domains → connect `data.jinteki.win`. Do **not** enable the
  `r2.dev` public URL. The other two buckets stay private.
- The runner sets `Cache-Control` itself: `v=…/*` files get
  `public, max-age=31536000, immutable`, `manifest.json` gets `public, max-age=60`. Keep a Cache
  Rule for `data.jinteki.win` that respects origin cache headers (the default); do not add "cache
  everything with edge TTL" overrides for `manifest.json`.
- CORS on `mr-published` (Settings → CORS policy), because the page is served from `jinteki.win`:

  ```json
  [{ "AllowedOrigins": ["https://jinteki.win"], "AllowedMethods": ["GET", "HEAD"], "AllowedHeaders": [], "MaxAgeSeconds": 86400 }]
  ```

  Add the test Worker's `*.workers.dev` origin too if the test deployment should read real data.

### Lifecycle rule (old versions)

The runner never deletes anything. Old versions are removed by an R2 object lifecycle rule on
`mr-published` (Settings → Object lifecycle rules):

- Prefix: `v=`
- Action: delete objects **14 days** after upload.

R2 lifecycle rules are age-based, not count-based. With the normal daily run this keeps about 14
versions (at least the required 7), and the live version is never more than a day old. **If the
runner will be paused for more than 14 days, disable the rule first**, or the live version's files
expire while `manifest.json` still points at them. Never put a lifecycle rule on `manifest.json`,
`mr-source` or `mr-canonical`.

## Image

```sh
docker build -t market-research:0.1.0 market-research
```

The base image is pinned by digest, dependencies are installed from `requirements.lock` with
`--require-hashes`, and the process runs as UID 10001. Behind a TLS-intercepting proxy, pass its CA
at build time only: `docker build --secret id=pip_ca,src=/path/ca.pem …`.

## Running

```sh
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --env-file market-research.env market-research:<tag> run-all
```

Exit codes: `0` success, `2` partial (a host tripped its circuit breaker; the rest was still
published), `1` failure (nothing published; the previous manifest stays live). The last log line is
`run_summary` with requests per host, 304s, new records, decks added, slices published and duration.

### Scheduler: cron (Linux/macOS)

Daily at 04:07 local time, logs kept by the host:

```cron
7 4 * * * docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --env-file /opt/market-research/market-research.env market-research:0.1.0 run-all >> /var/log/market-research.log 2>&1
```

Runs must not overlap; a normal run takes a few minutes, so a daily schedule is safe. Do not
schedule `run-all` while a backfill is running.

### Scheduler: Windows Task Scheduler

Create a task that runs daily at 04:07, "Run whether user is logged on or not", with the action:

- Program: `C:\Program Files\Docker\Docker\resources\bin\docker.exe`
- Arguments: `run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --env-file C:\market-research\market-research.env market-research:0.1.0 run-all`
- Settings: "Do not start a new instance" if already running; stop the task if it runs longer than 2 hours.

Or from an elevated PowerShell:

```powershell
$a = New-ScheduledTaskAction -Execute "docker.exe" -Argument "run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --env-file C:\market-research\market-research.env market-research:0.1.0 run-all"
$t = New-ScheduledTaskTrigger -Daily -At 4:07am
$s = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName "Market Research" -Action $a -Trigger $t -Settings $s
```

## First backfill

The backfill is the only way to load history (no source offers a bulk export), so it is announced.

1. **Tell the source maintainers first.** A few days before, message the ABR maintainer and NSG
   (the Cobra and NetrunnerDB teams): what it is (a fan project for card meta, no personal data),
   when it will run (date and hours, UTC), the rates (ABR and Cobra one request every 2 s, NetrunnerDB
   one per second, one request at a time per host), the User-Agent
   (`MarketResearch/<version> (+https://jinteki.win/market-research; <CONTACT>)`), and how to reach
   you to stop it. Wait for any objection before running.
2. Make sure `CONTACT` is set to an address you read.
3. **Plan:** `docker run … market-research:<tag> backfill --plan` (optionally `--since YYYY-MM-DD`;
   default is the start of the oldest ban list still relevant to Standard or 24 months, whichever is
   earlier). It makes only the listing requests and prints requests per host and per phase with
   estimated durations. Expect roughly 3–4 hours for two years, with Phase 1 published after about
   half an hour.
4. **Run** overnight, with the daily `run-all` schedule paused:
   `docker run … market-research:<tag> backfill`. It publishes after Phase 1, 2 and 3.
5. **If it stops** (sleep, network loss, a tripped host), run the same command again: finished items
   are skipped and it continues where it stopped. `--phase N` runs a single phase.
6. Re-enable the daily schedule, then check the quality report.

## Reloading single tournaments

`docker run … market-research:<tag> backfill --cobra ID --abr ID` (each repeatable) fetches just
those tournaments again, in full, whatever the frontier says: results or entries, settings, deck
pages, claimed decklists and their daily lists. The date window and the Cobra format check of
discovery are skipped; normalization still decides whether an event counts. It then normalizes and
publishes once. Public Cobra deck pages are pulled even while the event still counts as live (the
first 3 days after its date, when scheduled runs wait), so decks published right after a big event
can be loaded straight away. Use it after fixing a parser or a rule, to check a few events before a
full backfill, or to force-pull a fresh event's decks. Every ID is looked up first; if one does not exist, it exits `1` without writing anything.

## Run logs

Every command that fetches or publishes (`ingest`, `normalize`, `compute`, `run-all`, `backfill`,
`backfill --plan`) prints JSON log lines on stdout and also uploads them, gzipped, to the private
`mr-canonical` bucket as `logs/<YYYY-MM-DD>/<start time>-<command>.jsonl.gz`. The key is printed as
the run's first line (`run_log`). The upload happens when the run ends, even if it failed, and after
every backfill phase, so a crashed backfill still leaves its log up to the last phase. Secrets are
redacted before a line is written, so the uploaded copy is redacted the same way. A failed upload only
logs `log_upload_failed` and does not change the exit code. `report` is read-only and keeps no log.

Logs are not deleted automatically (there is no lifecycle rule on `mr-canonical`); a daily run's log
is small, a full backfill's a few MB.

## Reading the quality report

`docker run … market-research:<tag> report` prints the latest published `quality/report.json` (the
page footer shows a summary):

| Field | What to look at |
|---|---|
| `coverage` | tournaments, how many have game results and high decklist coverage, decks by source, `deck_comparison` (a rising `mismatch` count means Cobra and NRDB lists diverge) and illegal decks |
| `unresolved_cards`, `unresolved_identities` | printings or titles the catalog does not know: usually a new set before the catalog refresh; persistent entries need a look |
| `parser_failures` | quarantined responses (frontier key and error, never payloads). Several on one source usually means its format changed; compare with `drift_warnings` |
| `drift_warnings` | field names a source started sending. Decide whether any should be kept (add it to the record model) or is personal data (add it to the known-and-dropped list) |
| `link_mismatches` | Cobra/ABR pairs whose identities disagree, or unresolved `abr_code`s |
| `rejected_deck_refs` | claimed deck URLs that are not NetrunnerDB decklist/deck URLs (never fetched) |
| `skipped_tournaments` | events dropped by the guards (not Standard, too small, unapproved, conflicts, no entries) |

## Updating fixtures

`market-research fixtures refresh --cobra ID` (or `--abr ID`) is manual and opt-in: it fetches one
tournament live, anonymises it with canary values and writes files to `tests/fixtures/refresh/` for
review. It never runs in CI. The main fixture set is generated by `tests/fixtures/generate.py` from
`netrunner-cards-json`; golden outputs are refreshed with `MR_UPDATE_GOLDEN=1 pytest` and reviewed
as a diff.
