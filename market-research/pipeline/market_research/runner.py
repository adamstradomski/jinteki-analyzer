"""Run orchestration shared by the CLI: runtime wiring, run-all, backfill phases and the plan."""

from __future__ import annotations

import math
import random
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from market_research import logs
from market_research.clock import Clock
from market_research.config import Settings
from market_research.frontier import SIGNAL_BONUS, TIER_WEIGHT, Item
from market_research.http import PoliteHttp
from market_research.ingest import Ingestor, ReloadNotFound
from market_research.normalize import normalize
from market_research.publish import PublishError, build, publish
from market_research.records import AbrTournament, CobraTournament
from market_research.storage import Stores, local_stores

log = logs.get("market_research.runner")

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_PARTIAL = 2
PLAN_SINGLE_DECKLIST_SHARE = 0.1  # share of claimed decklists expected to be missing from by_date files
PLAN_CUT_DECKS = 16  # deck pages assumed when only the cut's decks are public
PHASE1_DAYS = 90


@dataclass
class Runtime:
    settings: Settings
    clock: Clock
    stores: Stores
    transport: httpx.BaseTransport | None = None
    rng: random.Random = field(default_factory=random.Random)
    parallel: bool = True  # hosts concurrently; tests run hosts one after another for determinism

    def http(self, *, unlimited: bool = False, stores: Stores | None = None) -> PoliteHttp:
        return PoliteHttp(
            self.settings,
            self.clock,
            rng=self.rng,
            transport=self.transport,
            robots_store=(stores or self.stores).canonical,
            unlimited_budget=unlimited,
        )


@dataclass
class RunResult:
    exit_code: int = EXIT_OK
    requests: dict[str, int] = field(default_factory=dict)
    not_modified: dict[str, int] = field(default_factory=dict)
    tripped: list[str] = field(default_factory=list)
    new_records: int = 0
    decks_added: int = 0
    slices_published: int = 0
    phases_published: list[int] = field(default_factory=list)
    started: float = field(default_factory=time.monotonic)

    def absorb_http(self, http: PoliteHttp) -> None:
        for g, s in http.stats().items():
            self.requests[g] = self.requests.get(g, 0) + s.requests
            self.not_modified[g] = self.not_modified.get(g, 0) + s.not_modified
            if s.tripped and g not in self.tripped:
                self.tripped.append(g)

    def summary(self) -> dict[str, Any]:
        return {
            "requests": dict(sorted(self.requests.items())),
            "not_modified": dict(sorted(self.not_modified.items())),
            "tripped": sorted(self.tripped),
            "new_records": self.new_records,
            "decks_added": self.decks_added,
            "slices_published": self.slices_published,
            "duration_s": round(time.monotonic() - self.started, 1),
            "exit_code": self.exit_code,
        }


def dry_run_stores() -> tuple[Stores, Path]:
    root = Path(tempfile.mkdtemp(prefix="market-research-dry-run-"))
    return local_stores(root), root


def do_ingest(
    rt: Runtime, res: RunResult, *, budget: int | None = None, sources: set[str] | None = None
) -> Ingestor:
    if budget is not None:
        for pol in rt.settings.hosts.values():
            pol.budget = budget
    http = rt.http()
    try:
        ing = Ingestor(rt.settings, rt.clock, http, rt.stores, parallel=rt.parallel)
        stats = ing.run(sources=sources)
    finally:
        http.close()
    res.absorb_http(http)
    res.new_records += stats.new_records
    res.decks_added += stats.decks_added
    if res.tripped:
        res.exit_code = EXIT_PARTIAL
    return ing


def do_normalize(rt: Runtime) -> None:
    normalize(rt.stores, rt.settings)


def do_compute(
    rt: Runtime, res: RunResult, *, publish_it: bool = True, started_at: datetime | None = None
) -> None:
    """Builds and publishes a snapshot. Its version and generated_at are the run's start time
    (`started_at`), so they don't depend on how long ingest took or how many requests it made."""
    snap, errors = build(rt.stores, rt.settings, started_at or rt.clock.now())
    if not publish_it:
        if errors:
            raise PublishError(f"{len(errors)} validation errors")
        log.info("compute_only", files=len(snap.files), version=snap.version)
        return
    res.slices_published += publish(rt.stores, snap, errors)


def run_all(rt: Runtime, *, budget: int | None = None, sources: set[str] | None = None) -> RunResult:
    res = RunResult()
    started_at = rt.clock.now()
    try:
        do_ingest(rt, res, budget=budget, sources=sources)
        do_normalize(rt)
        do_compute(rt, res, started_at=started_at)
    except PublishError:
        res.exit_code = EXIT_FAILURE
    return res


# ------------------------------------------------------------------ backfill


def default_since(today: date, stores: Stores) -> date:
    """The start of the oldest ban list still relevant to Standard, or 24 months, whichever is earlier."""
    two_years = date(today.year - 2, today.month, 1)
    snaps = stores.source.get_json("nrdb/catalog/snapshots.json") or {}
    std = sorted(
        s["date_start"]
        for s in snaps.get("snapshots", [])
        if s.get("format_id") == "standard" and s.get("date_start")
    )
    active = [s for s in snaps.get("snapshots", []) if s.get("format_id") == "standard" and s.get("active")]
    if std and active:
        pool = active[0].get("card_pool_id")
        same_pool = [
            s["date_start"]
            for s in snaps["snapshots"]
            if s.get("card_pool_id") == pool and s.get("date_start")
        ]
        oldest = date.fromisoformat(min(same_pool))
        return min(oldest, two_years)
    return two_years


def tier_of_priority(priority: float) -> str:
    weight = int((priority % SIGNAL_BONUS) // 1000)
    for g, w in TIER_WEIGHT.items():
        if w == weight:
            return g
    return "online"


def phase_of(it: Item, today: date) -> int:
    if it.kind in (
        "nrdb_by_date",
        "nrdb_catalog",
        "nrdb_catalog_bulk",
        "cobra_catalog",
        "cobra_index",
    ) or it.kind.startswith("abr_list"):
        return 0
    if not it.event_date:
        return 1
    age = (today - date.fromisoformat(it.event_date)).days
    if age <= PHASE1_DAYS:
        return 1
    return 2 if tier_of_priority(it.priority) == "megacity" else 3


def backfill(rt: Runtime, since: date, *, phase: int | None = None) -> RunResult:
    """Loads history phase by phase with no per-run budget. Resumable: finished items are skipped."""
    res = RunResult()
    started_at = rt.clock.now()
    http = rt.http(unlimited=True)
    ing = Ingestor(rt.settings, rt.clock, http, rt.stores, since=since, backfill=True, parallel=rt.parallel)
    today = started_at.date()

    def accept_for(p: int) -> Callable[[Item], bool]:
        return lambda it: phase_of(it, today) in (0, p)

    phases = [phase] if phase else [1, 2, 3]
    try:
        for p in phases:
            log.info("backfill_phase", phase=p, since=since.isoformat())
            stats = ing.run(accept=accept_for(p))
            res.new_records += stats.new_records
            res.decks_added += stats.decks_added
            do_normalize(rt)
            try:
                # Every phase starts from the backfill's start time; free_version() moves each
                # later phase a second on, so their versions stay unique and in order.
                do_compute(rt, res, started_at=started_at)
            except PublishError:
                res.exit_code = EXIT_FAILURE
                break
            res.phases_published.append(p)
            logs.upload(rt.stores.canonical)  # a long backfill leaves its log so far after every phase
    finally:
        http.close()
        res.absorb_http(http)
    if res.tripped and res.exit_code == EXIT_OK:
        res.exit_code = EXIT_PARTIAL
    return res


def reload(rt: Runtime, *, cobra_ids: list[int], abr_ids: list[int]) -> RunResult:
    """Fetches the given tournaments again in full (see Ingestor.reload), then normalizes and
    publishes once. Exits with failure, writing nothing, when a tournament cannot be found."""
    res = RunResult()
    started_at = rt.clock.now()
    http = rt.http(unlimited=True)
    ing = Ingestor(rt.settings, rt.clock, http, rt.stores, parallel=rt.parallel)
    try:
        try:
            stats = ing.reload(cobra_ids=cobra_ids, abr_ids=abr_ids)
        except ReloadNotFound as e:
            log.error("reload_not_found", tournaments=e.missing)
            res.exit_code = EXIT_FAILURE
            return res
        res.new_records += stats.new_records
        res.decks_added += stats.decks_added
        do_normalize(rt)
        try:
            do_compute(rt, res, started_at=started_at)
        except PublishError:
            res.exit_code = EXIT_FAILURE
    finally:
        http.close()
        res.absorb_http(http)
    if res.tripped and res.exit_code == EXIT_OK:
        res.exit_code = EXIT_PARTIAL
    return res


def plan(rt: Runtime, since: date) -> dict[str, Any]:
    """Makes only Phase 0 listing requests, then estimates requests and duration per host and phase."""
    tmp_stores, _ = dry_run_stores()
    http = rt.http(unlimited=True, stores=tmp_stores)
    ing = Ingestor(rt.settings, rt.clock, http, tmp_stores, since=since, backfill=True, parallel=rt.parallel)
    listing = {"abr_list_full", "cobra_index", "cobra_catalog"}
    try:
        ing.run(accept=lambda it: it.kind in listing)
    finally:
        http.close()
    today = rt.clock.now().date()
    req: dict[str, dict[int, float]] = {g: {0: 0.0, 1: 0.0, 2: 0.0, 3: 0.0} for g in ("abr", "cobra", "nrdb")}
    for g, s in http.stats().items():
        req[g][0] += s.requests
    days = (today - since).days + 1
    req["nrdb"][0] += 1 + 6 + days  # robots, six catalog tables, one by_date request per day
    for it in ing.frontier.items.values():
        p = phase_of(it, today)
        if it.kind == "abr_entries":
            req["abr"][p] += 1
            ev = AbrTournament.model_validate(
                tmp_stores.source.get_json(f"abr/tournament/{it.entity_id}.json")
            )
            req["nrdb"][p] += ev.claim_count * 2 * PLAN_SINGLE_DECKLIST_SHARE
        elif it.kind == "cobra_tournament" and not it.frozen:
            req["cobra"][p] += 1
            t = CobraTournament.model_validate(
                tmp_stores.source.get_json(f"cobra/tournament/{it.entity_id}.json")
            )
            n = t.players_active or 0
            if t.deck_visibility.swiss == "public":
                req["cobra"][p] += n
            elif t.deck_visibility.cut == "public":
                req["cobra"][p] += min(n, PLAN_CUT_DECKS)
    out: dict[str, Any] = {"since": since.isoformat(), "today": today.isoformat(), "hosts": {}, "phases": {}}
    for g, per in req.items():
        interval = rt.settings.policy(g).interval_s
        out["hosts"][g] = {
            "interval_s": interval,
            "requests": {str(p): math.ceil(v) for p, v in per.items()},
            "total": math.ceil(sum(per.values())),
        }
    for p in range(4):
        per_host = {g: math.ceil(req[g][p]) * rt.settings.policy(g).interval_s for g in req}
        out["phases"][str(p)] = {
            "duration_s": round(max(per_host.values())),
            "slowest_host": max(per_host, key=lambda g: per_host[g]),
        }
    out["total_duration_s"] = sum(v["duration_s"] for v in out["phases"].values())
    return out


def format_plan(p: dict[str, Any]) -> str:
    lines = [
        f"Backfill plan since {p['since']} (as of {p['today']}); hosts run in parallel at their own rate.",
        "",
    ]
    lines.append(
        f"{'host':<8}{'rate':>8}{'phase 0':>10}{'phase 1':>10}{'phase 2':>10}{'phase 3':>10}{'total':>10}"
    )
    for g, h in p["hosts"].items():
        r = h["requests"]
        lines.append(
            f"{g:<8}{'1/' + format(h['interval_s'], 'g') + 's':>8}{r['0']:>10}{r['1']:>10}{r['2']:>10}{r['3']:>10}{h['total']:>10}"
        )
    lines.append("")
    for k, v in p["phases"].items():
        lines.append(f"phase {k}: ~{_dur(v['duration_s'])} (slowest host: {v['slowest_host']})")
    lines.append(f"total: ~{_dur(p['total_duration_s'])}")
    return "\n".join(lines)


def _dur(s: float) -> str:
    total = int(timedelta(seconds=int(s)).total_seconds())
    h, rem = divmod(total, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}h {m:02d}m" if h else f"{m}m {sec:02d}s"


def parse_now(value: str) -> datetime:
    d = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if d.tzinfo is None:
        raise ValueError("--now needs a timezone, e.g. 2026-09-27T04:00:00Z")
    return d
