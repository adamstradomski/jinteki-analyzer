from __future__ import annotations

import random
from datetime import date

import pytest

from helpers import make_env
from market_research.runner import Runtime, backfill, default_since, format_plan, plan
from market_research.testing import FixtureTransport, normalize_url

SINCE = date(2026, 6, 1)


def rt(env) -> Runtime:
    return Runtime(
        settings=env.settings,
        clock=env.clock,
        stores=env.stores,
        rng=random.Random(3),
        transport=FixtureTransport(env.routes),
        parallel=False,
    )


def test_plan_lists_only_and_counts_match_fixtures(tmp_path, clock):
    env = make_env(tmp_path, clock)
    p = plan(rt(env), SINCE)
    urls = [normalize_url(str(c.url)) for c in env.routes.calls]
    for u in urls:
        assert (
            u.endswith("/robots.txt")
            or "/api/tournaments/results" in u
            or "/public/tournaments?" in u
            or "/public/formats" in u
            or "/public/tournament_types" in u
            or "/public/deckbuilding_restrictions" in u
        ), u
    assert not any("entries" in u or "view_decks" in u or "by_date" in u or u.endswith(".json") for u in urls)
    h = p["hosts"]
    days = (date(2026, 9, 27) - SINCE).days + 1
    assert h["abr"]["requests"] == {
        "0": 2,
        "1": 4,
        "2": 1,
        "3": 0,
    }  # 5284, 5310, 5301, 5240 recent; 5250 megacity older
    assert h["cobra"]["requests"] == {"0": 5, "1": 3 + 16 + 10, "2": 0, "3": 0}  # 5012's decks are not public
    assert h["nrdb"]["requests"]["0"] == 1 + 6 + days
    assert h["nrdb"]["requests"]["1"] == 5 and h["nrdb"]["requests"]["2"] == 4
    assert env.stores.source.puts == [] and env.stores.canonical.puts == []  # type: ignore[attr-defined]
    text = format_plan(p)
    assert "phase 0" in text and "nrdb" in text and "total" in text


def test_backfill_phases_publish_in_order_and_skip_rules(tmp_path, clock):
    env = make_env(tmp_path, clock)
    res = backfill(rt(env), SINCE)
    assert res.phases_published == [1, 2, 3]
    manifests = [k for k in env.stores.published.puts if k == "manifest.json"]  # type: ignore[attr-defined]
    assert len(manifests) == 3
    versions = [k.split("/")[0] for k in env.stores.published.puts if k.endswith("catalog/cards.json")]  # type: ignore[attr-defined]
    assert versions == sorted(versions) and len(set(versions)) == 3
    urls = [normalize_url(str(c.url)) for c in env.routes.calls]
    assert not any("entries?id=5305" in u for u in urls)  # no claims, no match data
    assert not any("/tournaments/5012/players/" in u for u in urls)  # open stage: no deck pages
    bulk = set()
    for info in env.stores.source.list("nrdb/decklists/by_date/"):
        for d in env.stores.source.get_json(info.key)["decklists"]:
            bulk |= {d["id"], d["uuid"]}
    singles = [u.rsplit("/", 1)[1] for u in urls if "/public/decklist/" in u]
    assert singles and not set(singles) & bulk
    days = [u for u in urls if "/decklists/by_date/" in u]
    assert len(days) == len(set(days)) == (date(2026, 9, 27) - SINCE).days + 1


def test_interrupted_backfill_resumes_without_refetching(tmp_path, clock):
    env = make_env(tmp_path, clock)
    boom = "https://tournaments.nullsignal.games/tournaments/4990/players/59700/view_decks"

    def explode(request):
        if normalize_url(str(request.url)) == normalize_url(boom):
            raise RuntimeError("network gone")
        return env.routes.respond(request)

    first = rt(env)
    first.transport = _Transport(explode)
    with pytest.raises(RuntimeError):
        backfill(first, SINCE)
    done_first = [normalize_url(str(c.url)) for c in env.routes.calls]
    assert done_first
    env.routes.calls.clear()
    res = backfill(rt(env), SINCE)
    assert res.phases_published == [1, 2, 3]
    again = [normalize_url(str(c.url)) for c in env.routes.calls]
    refetched = [u for u in again if u in done_first and not u.endswith("robots.txt")]
    assert normalize_url(boom) in again
    assert refetched == []


def test_default_since(tmp_path, clock):
    env = make_env(tmp_path, clock)
    assert default_since(date(2026, 9, 27), env.stores) == date(2024, 9, 1)
    backfill(rt(env), date(2026, 9, 1), phase=1)
    # Oldest ban list of the current card pool (2026-03-13) vs 24 months: the earlier wins.
    assert default_since(date(2026, 9, 27), env.stores) == date(2024, 9, 1)
    assert default_since(date(2027, 12, 1), env.stores) == date(2025, 12, 1)
    assert default_since(date(2028, 6, 1), env.stores) == date(2026, 3, 13)


class _Transport(FixtureTransport):
    def __init__(self, fn):
        self.fn = fn

    def handle_request(self, request):
        return self.fn(request)
