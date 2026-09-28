"""Clients and the ingest loop against the recorded fixtures."""

from __future__ import annotations

import json
from datetime import date

import httpx
import pytest

from helpers import make_env
from market_research.frontier import Frontier
from market_research.ingest import Ingestor
from market_research.records import CobraTournament, dump
from market_research.sources.common import ParseError, opt_printing
from market_research.testing import normalize_url


def run(env, **kw):
    ing = Ingestor(
        env.settings, env.clock, env.http(**kw.pop("http_kw", {})), env.stores, parallel=False, **kw
    )
    stats = ing.run()
    return ing, stats


def urls(env):
    return [normalize_url(str(c.url)) for c in env.routes.calls]


BACKFILL_SINCE = date(2026, 6, 1)
# The items a backfill reads first to find events; the same set `runner.plan` reads.
LISTINGS = frozenset({"abr_list_full", "cobra_index", "cobra_catalog"})


def discover(env, since: date) -> set[str]:
    """Runs only a backfill's discovery listings. Returns the frontier keys of the events known after."""
    ing = Ingestor(
        env.settings,
        env.clock,
        env.http(unlimited_budget=True),
        env.stores,
        since=since,
        backfill=True,
        parallel=False,
    )
    ing.run(accept=lambda it: it.kind in LISTINGS)
    return {k for k, it in ing.frontier.items.items() if it.kind in ("abr_event", "cobra_tournament")}


def test_first_run_fetches_expected_items(tmp_path, clock):
    env = make_env(tmp_path, clock)
    ing, stats = run(env)
    f = ing.frontier.items
    # Non-Standard and private Cobra events are known but skipped; future ones are not recorded.
    assert f["cobra:tournament:5020"].last_status == "skipped_not_standard"
    assert f["cobra:tournament:5021"].last_status == "skipped_private"
    assert "cobra:tournament:5025" not in f
    # ABR guards: unapproved, conflict, non-Standard, too small events are never followed.
    for eid in (5302, 5303, 5304, 5306):
        assert f"abr:event:{eid}" not in f
    # No entries fetch for an event with no claims and no match data.
    assert "abr:event:5305" in f and "abr:entries:5305" not in f
    fetched = urls(env)
    assert not any("entries?id=5305" in u for u in fetched)
    # Open (participants-only) Cobra stage: no deck pages.
    assert not any("/tournaments/5012/players/" in u for u in fetched)
    # Every 4990 player's deck page was read once.
    assert sum("/tournaments/4990/players/" in u for u in fetched) == 16
    # The off-allowlist deck URL was never requested.
    assert not any("evil.example" in u for u in fetched)
    assert ing.quality.rejected_refs == 1
    assert stats.new_records > 100


def test_decklists_in_bulk_are_never_fetched_individually(tmp_path, clock):
    env = make_env(tmp_path, clock)
    ing, _ = run(env)
    single = [u for u in urls(env) if "/api/2.0/public/decklist/" in u]
    bulk_ids = set()
    for info in env.stores.source.list("nrdb/decklists/by_date/"):
        for d in env.stores.source.get_json(info.key)["decklists"]:
            bulk_ids |= {d["id"], d["uuid"]}
    assert single, "one claimed decklist is missing from by_date and needs a single fetch"
    for u in single:
        assert u.rsplit("/", 1)[1] not in bulk_ids
    in_bulk = [i for i in ing.frontier.items.values() if i.last_status == "in_bulk"]
    assert len(in_bulk) > 50


def test_second_run_is_conditional_and_writes_nothing(tmp_path, clock):
    env = make_env(tmp_path, clock)
    run(env)
    env.routes.calls.clear()
    before = len(env.stores.source.puts)  # type: ignore[attr-defined]
    clock.advance(24 * 3600)
    ing, stats = run(env)
    assert stats.new_records == 0
    assert len(env.stores.source.puts) == before  # type: ignore[attr-defined]
    validators = {}
    for r in env.routes.routes.values():
        h = r["headers"]
        if "ETag" in h or "Last-Modified" in h:
            validators[normalize_url(r["url"])] = h
    sent = [c for c in env.routes.calls if normalize_url(str(c.url)) in validators]
    assert sent
    for c in sent:
        assert "if-none-match" in c.headers or "if-modified-since" in c.headers, c.url
    assert ing.http.stats()["nrdb"].not_modified > 0


def test_304_yields_no_new_record(tmp_path, clock):
    env = make_env(tmp_path, clock)
    run(env)
    clock.advance(3600)
    item = Frontier.load(env.stores.canonical).items["nrdb:catalog:restrictions"]
    assert item.etag
    env.routes.calls.clear()
    before = list(env.stores.source.puts)  # type: ignore[attr-defined]
    run(env)
    req = [c for c in env.routes.calls if "/v3/public/restrictions" in str(c.url)][0]
    assert req.headers["if-none-match"] == item.etag
    assert env.stores.source.puts == before  # type: ignore[attr-defined]


def test_budget_exhaustion_defers_remaining_items(tmp_path, clock):
    env = make_env(tmp_path, clock, MR_BUDGET_COBRA="12")
    ing, _ = run(env)
    decks = [i for i in ing.frontier.items.values() if i.kind == "cobra_deck"]
    pending = [i for i in decks if not i.frozen]
    assert decks and pending, "remaining deck pages wait for the next run"
    assert all(i.next_due <= clock.now() for i in pending)
    assert ing.http.stats()["cobra"].requests == 12
    # The next run (fresh budget) continues where this one stopped.
    env2 = make_env(tmp_path, clock)
    env2.routes = env.routes
    env.routes.calls.clear()
    ing2, _ = run(env2)
    assert all(i.frozen for i in ing2.frontier.items.values() if i.kind == "cobra_deck")
    first_done = {i.key for i in decks if i.frozen}
    refetched = [u for u in urls(env) if "view_decks" in u and any(k.split(":")[3] in u for k in first_done)]
    assert refetched == []


def test_tripped_host_does_not_stop_others(tmp_path, clock):
    env = make_env(tmp_path, clock)
    for u in [r["url"] for r in env.routes.routes.values() if "alwaysberunning.net/api" in r["url"]]:
        env.routes.override(u, httpx.Response(500))
    ing, _ = run(env)
    assert ing.http.is_tripped("abr")
    assert any(i.kind == "cobra_deck" and i.frozen for i in ing.frontier.items.values())


def test_abr_claim_count_increase_enqueues_entries(tmp_path, clock):
    env = make_env(tmp_path, clock)
    ing, _ = run(env)
    it = ing.frontier.items["abr:entries:5284"]
    assert it.next_due > clock.now()
    recent = [
        r for r in env.routes.routes.values() if "start=2026.07.29." in r["url"] and "end" not in r["url"]
    ][0]
    events = json.loads((env.routes.root / recent["file"]).read_bytes())
    for e in events:
        if e["id"] == 5284:
            e["claim_count"] += 1
    env.routes.override(recent["url"], httpx.Response(200, json=events))
    clock.advance(3 * 3600)
    env.routes.calls.clear()
    ing2, _ = run(env)
    assert any("entries?id=5284" in u for u in urls(env))
    assert ing2.frontier.items["abr:entries:5284"].last_status == "ok"


def test_quarantine_on_unparsable_response(tmp_path, clock):
    env = make_env(tmp_path, clock)
    env.routes.override(
        "https://alwaysberunning.net/api/entries?id=5301", httpx.Response(200, content=b"<html>oops")
    )
    ing, _ = run(env)
    q = ing.quality.to_json()["quarantine"]
    assert [e["key"] for e in q] == ["abr:entries:5301"]
    assert set(q[0]) == {"key", "error", "payload_sha256"}
    stored = env.stores.canonical.get_json("state/ingest_quality.json")
    assert stored["quarantine"][0]["key"] == "abr:entries:5301"


def test_oversized_response_is_quarantined(tmp_path, clock):
    env = make_env(tmp_path, clock)
    env.routes.override(
        "https://alwaysberunning.net/api/entries?id=5301",
        httpx.Response(200, content=b"[" + b" " * 6_000_000 + b"]"),
    )
    ing, _ = run(env)
    assert any(e["key"] == "abr:entries:5301" for e in ing.quality.to_json()["quarantine"])


def test_retry_after_on_429(tmp_path, clock):
    env = make_env(tmp_path, clock)
    u = "https://alwaysberunning.net/api/entries?id=5240"
    env.routes.override(u, httpx.Response(429, headers={"Retry-After": "42"}), httpx.Response(200, json=[]))
    run(env)
    assert 42 in clock.sleeps


def test_live_tournament_rechecked_and_decks_wait(tmp_path, clock):
    env = make_env(tmp_path, clock)
    clock.advance(-6 * 86400)  # 2026-09-21: Worlds ended two days ago
    ing, _ = run(env)
    t = ing.frontier.items["cobra:tournament:4990"]
    assert t.interval_s == 6 * 3600
    assert not any(
        i.kind == "cobra_deck" for i in ing.frontier.items.values() if i.entity_id.startswith("4990:")
    )
    clock.advance(4 * 86400)
    ing2, _ = run(env)
    assert any(
        i.kind == "cobra_deck" for i in ing2.frontier.items.values() if i.entity_id.startswith("4990:")
    )


def test_abr_string_null_identity_is_missing():
    # Seen live on alwaysberunning.net: one event had winner_corp_identity "null" (a string).
    assert opt_printing("null") is None
    assert opt_printing("34096") == "34096"
    with pytest.raises(ParseError):
        opt_printing("nul")


def test_event_names_are_cleaned():
    from market_research.sources.common import opt_title

    assert opt_title("  Worlds\n2026\t Top Cut ") == "Worlds 2026 Top Cut"
    assert opt_title("x" * 200) == "x" * 120
    assert opt_title("   ") is None and opt_title(None) is None


def test_longer_backfill_discovers_events_a_shorter_one_did_not_reach(tmp_path, clock):
    # Seen live: a 30-day backfill followed by a two-year one found no older events, because the
    # listings were already done and Cobra's index stopped at the first known event.
    env = make_env(tmp_path / "rerun", clock)
    short = discover(env, date(2026, 9, 1))
    longer = discover(env, BACKFILL_SINCE)
    fresh = discover(make_env(tmp_path / "fresh", clock), BACKFILL_SINCE)
    assert fresh > short
    assert longer == fresh


def test_backfill_index_read_fills_in_a_missing_cobra_name(tmp_path, clock):
    # Tournaments stored before names were kept get theirs on the next backfill's index read.
    env = make_env(tmp_path, clock)
    discover(env, BACKFILL_SINCE)
    key = "cobra/tournament/4990.json"
    stored = CobraTournament.model_validate(env.stores.source.get_json(key))
    assert stored.name
    # As collected before names were kept: no name, and a hash computed without one.
    env.stores.source.put_json(key, dump(stored.model_copy(update={"name": None}).hashed()))
    discover(env, BACKFILL_SINCE)
    assert env.stores.source.get_json(key)["name"] == stored.name


def backfill_ingest(env, since: date = BACKFILL_SINCE):
    ing = Ingestor(
        env.settings,
        env.clock,
        env.http(unlimited_budget=True),
        env.stores,
        since=since,
        backfill=True,
        parallel=False,
    )
    return ing.run()


def test_interrupted_backfill_resumes_without_refetching(tmp_path, clock, monkeypatch):
    env = make_env(tmp_path, clock)
    boom = normalize_url("https://tournaments.nullsignal.games/tournaments/4990/players/59700/view_decks")
    respond = env.routes.respond

    def explode(request):
        if normalize_url(str(request.url)) == boom:
            raise RuntimeError("network gone")
        return respond(request)

    monkeypatch.setattr(env.routes, "respond", explode)
    with pytest.raises(RuntimeError):
        backfill_ingest(env)
    done_first = urls(env)
    assert done_first
    monkeypatch.setattr(env.routes, "respond", respond)
    env.routes.calls.clear()
    backfill_ingest(env)
    again = urls(env)
    # A backfill always re-reads the discovery listings; nothing else is fetched twice.
    listing = ("robots.txt", "/api/tournaments/results", "/public/tournaments?")
    refetched = [u for u in again if u in done_first and not any(x in u for x in listing)]
    assert boom in again
    assert refetched == []
