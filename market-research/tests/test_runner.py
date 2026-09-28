"""Runner helpers that need no fetching: backfill phases, the plan's text and --now."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from market_research.frontier import SIGNAL_BONUS, Frontier, event_priority
from market_research.runner import format_plan, parse_now, phase_of, tier_of_priority

TODAY = date(2026, 9, 27)


def item(kind: str, *, event_date: str | None = None, priority: float = 0.0):
    it, _ = Frontier().upsert(
        f"k:{kind}",
        source="abr",
        kind=kind,
        entity_id="1",
        now=datetime(2026, 9, 27, tzinfo=UTC),
        priority=priority,
        event_date=event_date,
    )
    return it


@pytest.mark.parametrize(
    "kind",
    ["nrdb_by_date", "nrdb_catalog", "nrdb_catalog_bulk", "cobra_catalog", "cobra_index", "abr_list_full"],
)
def test_listings_and_card_data_run_with_every_phase(kind):
    assert phase_of(item(kind, event_date="2020-01-01"), TODAY) == 0


def test_events_by_age_then_tier():
    def days_ago(n: int) -> str:
        return (TODAY - timedelta(days=n)).isoformat()

    mega, store = event_priority("megacity", 120), event_priority("store", 40)
    assert phase_of(item("abr_entries", event_date=days_ago(90), priority=store), TODAY) == 1
    assert phase_of(item("cobra_tournament", event_date=days_ago(91), priority=mega), TODAY) == 2
    assert phase_of(item("cobra_tournament", event_date=days_ago(91), priority=store), TODAY) == 3
    # A change signal lifts the priority but keeps the tier; so does the private deck bonus.
    assert phase_of(item("abr_entries", event_date=days_ago(400), priority=mega + SIGNAL_BONUS), TODAY) == 2
    assert phase_of(item("nrdb_deck", event_date=days_ago(400), priority=mega + SIGNAL_BONUS / 2), TODAY) == 2
    assert phase_of(item("nrdb_decklist"), TODAY) == 1  # no event date


def test_tier_of_priority():
    for tier in ("megacity", "store", "gnk", "online"):
        assert tier_of_priority(event_priority(tier, 999, recency_days=0)) == tier
    assert tier_of_priority(event_priority(None, 8)) == "online"
    assert tier_of_priority(0.0) == "online"


def test_now_needs_a_time_zone():
    assert parse_now("2026-09-27T04:00:00Z") == datetime(2026, 9, 27, 4, tzinfo=UTC)
    assert parse_now("2026-09-27T06:00:00+02:00") == datetime(2026, 9, 27, 4, tzinfo=UTC)
    with pytest.raises(ValueError, match="needs a timezone"):
        parse_now("2026-09-27T04:00:00")


def test_plan_text():
    plan = {
        "since": "2026-06-01",
        "today": "2026-09-27",
        "hosts": {
            "abr": {"interval_s": 2.0, "requests": {"0": 2, "1": 4, "2": 1, "3": 0}, "total": 7},
            "nrdb": {"interval_s": 1.0, "requests": {"0": 125, "1": 3700, "2": 4, "3": 0}, "total": 3829},
        },
        "phases": {
            "0": {"duration_s": 125, "slowest_host": "nrdb"},
            "1": {"duration_s": 3700, "slowest_host": "nrdb"},
            "2": {"duration_s": 4, "slowest_host": "nrdb"},
            "3": {"duration_s": 0, "slowest_host": "abr"},
        },
        "total_duration_s": 3829,
    }
    assert format_plan(plan).split("\n") == [
        "Backfill plan since 2026-06-01 (as of 2026-09-27); hosts run in parallel at their own rate.",
        "",
        "host        rate   phase 0   phase 1   phase 2   phase 3     total",
        "abr         1/2s         2         4         1         0         7",
        "nrdb        1/1s       125      3700         4         0      3829",
        "",
        "phase 0: ~2m 05s (slowest host: nrdb)",
        "phase 1: ~1h 01m (slowest host: nrdb)",
        "phase 2: ~0m 04s (slowest host: nrdb)",
        "phase 3: ~0m 00s (slowest host: abr)",
        "total: ~1h 03m",
    ]
