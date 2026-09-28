from __future__ import annotations

from datetime import timedelta

from market_research.frontier import (
    DAY,
    LIVE_INTERVAL,
    SIGNAL_BONUS,
    Frontier,
    ceiling_s,
    event_priority,
)
from market_research.storage import LocalObjectStore


def add(f: Frontier, clock, key="abr:entries:1", kind="abr_entries", event_days_ago=5, priority=10.0):
    ev = (clock.now() - timedelta(days=event_days_ago)).date().isoformat()
    it, _ = f.upsert(
        key, source="abr", kind=kind, entity_id="1", now=clock.now(), priority=priority, event_date=ev
    )
    return it


def test_ceilings_by_age():
    assert ceiling_s(0) == DAY
    assert ceiling_s(13) == DAY
    assert ceiling_s(14) == 7 * DAY
    assert ceiling_s(89) == 7 * DAY
    assert ceiling_s(90) == 30 * DAY
    assert ceiling_s(364) == 30 * DAY
    assert ceiling_s(365) is None


def test_unchanged_doubles_up_to_ceiling_and_change_resets(clock):
    f = Frontier()
    it = add(f, clock, event_days_ago=40)  # weekly ceiling
    seen = []
    for _ in range(5):
        f.complete(it, clock.now(), changed=False, status="ok")
        seen.append(it.interval_s)
    assert seen == [2 * DAY, 4 * DAY, 7 * DAY, 7 * DAY, 7 * DAY]
    f.complete(it, clock.now(), changed=True, status="ok")
    assert it.interval_s == DAY
    assert it.next_due == clock.now() + timedelta(days=1)


def test_daily_while_young(clock):
    f = Frontier()
    it = add(f, clock, event_days_ago=3)
    for _ in range(3):
        f.complete(it, clock.now(), changed=False, status="ok")
    assert it.interval_s == DAY


def test_monthly_then_frozen_after_a_year(clock):
    f = Frontier()
    it = add(f, clock, event_days_ago=200)
    for _ in range(6):
        f.complete(it, clock.now(), changed=False, status="ok")
    assert it.interval_s == 30 * DAY
    old = add(f, clock, key="abr:entries:2", event_days_ago=400)
    f.complete(old, clock.now(), changed=False, status="ok")
    assert old.frozen


def test_ageing_moves_the_ceiling(clock):
    f = Frontier()
    it = add(f, clock, event_days_ago=10)
    f.complete(it, clock.now(), changed=False, status="ok")
    assert it.interval_s == DAY
    clock.advance(10 * DAY)  # now 20 days old
    f.complete(it, clock.now(), changed=False, status="ok")
    assert it.interval_s == 2 * DAY


def test_live_cobra_tournament_checked_four_times_a_day(clock):
    f = Frontier()
    it = add(f, clock, key="cobra:tournament:1", kind="cobra_tournament", event_days_ago=0)
    f.complete(it, clock.now(), changed=False, status="ok", live=True)
    assert it.interval_s == LIVE_INTERVAL == 6 * 3600


def test_once_items_freeze(clock):
    f = Frontier()
    it = add(f, clock, key="cobra:deck:1:2", kind="cobra_deck")
    f.complete(it, clock.now(), changed=True, status="ok")
    assert it.frozen
    assert f.due(clock.now()) == []


def test_change_signal_promotes_and_reopens(clock):
    f = Frontier()
    a = add(f, clock, key="abr:entries:1", priority=5)
    b = add(f, clock, key="abr:entries:2", priority=50)
    f.complete(a, clock.now(), changed=False, status="ok")
    f.complete(b, clock.now(), changed=False, status="ok")
    a.frozen = True
    assert f.due(clock.now()) == []
    f.signal("abr:entries:1", clock.now())
    due = f.due(clock.now())
    assert [i.key for i in due] == ["abr:entries:1"]
    assert due[0].priority >= SIGNAL_BONUS and not due[0].frozen
    f.complete(a, clock.now(), changed=True, status="ok")
    assert a.priority == 5  # bonus consumed


def test_priority_ordering(clock):
    f = Frontier()
    add(f, clock, key="k:small", priority=event_priority("gnk", 10))
    add(f, clock, key="k:mega", priority=event_priority("megacity", 60))
    add(f, clock, key="k:store", priority=event_priority("store", 300))
    add(f, clock, key="k:mega-big", priority=event_priority("megacity", 160))
    assert [i.key for i in f.due(clock.now())] == ["k:mega-big", "k:mega", "k:store", "k:small"]


def test_upsert_keeps_existing_and_failures_back_off(clock):
    f = Frontier()
    it = add(f, clock)
    again, created = f.upsert(it.key, source="abr", kind="abr_entries", entity_id="1", now=clock.now())
    assert again is it and not created
    f.fail(it, clock.now(), "FetchFailed")
    first = it.next_due
    f.fail(it, clock.now(), "FetchFailed")
    assert it.next_due > first and it.fail_count == 2
    for _ in range(6):
        f.fail(it, clock.now(), "FetchFailed")
    assert it.frozen


def test_parquet_roundtrip(clock, tmp_path):
    store = LocalObjectStore(tmp_path)
    f = Frontier()
    it = add(f, clock)
    it.etag = 'W/"x"'
    f.complete(it, clock.now(), changed=True, status="ok", record_hash="sha256:ab")
    f.mark_known(
        "cobra:tournament:9",
        source="cobra",
        kind="cobra_tournament",
        entity_id="9",
        now=clock.now(),
        status="skipped_private",
    )
    f.save(store)
    g = Frontier.load(store)
    assert g.items.keys() == f.items.keys()
    for k in f.items:
        assert g.items[k] == f.items[k]
    assert Frontier.load(LocalObjectStore(tmp_path / "empty")).items == {}
