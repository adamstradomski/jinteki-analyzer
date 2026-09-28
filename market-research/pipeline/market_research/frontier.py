"""The crawl frontier: what to fetch next, when, and in which order. Stored as state/frontier.parquet."""

from __future__ import annotations

import os
import tempfile
from dataclasses import asdict, dataclass, fields
from datetime import UTC, date, datetime, timedelta

import duckdb

from market_research.db import insert_rows
from market_research.storage import ObjectStore

FRONTIER_KEY = "state/frontier.parquet"
DAY = 86400
HOUR = 3600

# Discovery and reference items run on a fixed schedule instead of decaying.
FIXED_INTERVAL: dict[str, int] = {
    "abr_list_recent": HOUR,  # every run
    "abr_list_sweep": 7 * DAY,  # weekly: 60 days to 1 year
    "abr_list_full": 30 * DAY,  # monthly: everything
    "cobra_index": HOUR,
    "cobra_catalog": 7 * DAY,
    "nrdb_catalog": HOUR,  # conditional request each run
}
# Items fetched once and then frozen (until a change signal re-opens them).
ONCE = frozenset({"cobra_deck", "nrdb_decklist", "nrdb_deck", "nrdb_catalog_bulk"})
# Decaying items: changed content resets to the minimum, unchanged doubles up to an age ceiling.
MIN_INTERVAL: dict[str, int] = {
    "abr_entries": DAY,
    "cobra_tournament": DAY,
    "cobra_settings": DAY,
    "nrdb_by_date": DAY,
}
LIVE_INTERVAL = 6 * HOUR  # a live Cobra tournament is checked up to 4 times a day
SIGNAL_BONUS = 100_000.0
TIER_WEIGHT = {"megacity": 4, "store": 3, "gnk": 2, "online": 1}


@dataclass
class Item:
    key: str
    source: str
    kind: str
    entity_id: str
    next_due: datetime
    interval_s: int
    priority: float
    etag: str | None
    last_modified: str | None
    record_hash: str | None
    last_status: str | None
    fail_count: int
    frozen: bool
    first_seen: datetime
    last_changed: datetime | None
    # Not in the brief's column list, but needed for the age-based ceilings.
    event_date: str | None = None

    def age_days(self, now: datetime) -> float | None:
        if not self.event_date:
            return None
        d = date.fromisoformat(self.event_date)
        return (now.date() - d).days


def ceiling_s(age_days: float | None) -> int | None:
    """Maximum interval by event age; None means the item is old enough to freeze."""
    if age_days is None or age_days < 14:
        return DAY
    if age_days < 90:
        return 7 * DAY
    if age_days < 365:
        return 30 * DAY
    return None


def event_priority(
    tier_group: str | None, players: int | None, *, recency_days: float | None = None
) -> float:
    p = TIER_WEIGHT.get(tier_group or "", 1) * 1000.0 + min(players or 0, 999)
    if recency_days is not None:
        p += max(0.0, 365.0 - recency_days) / 1000.0
    return p


def _naive(v: object) -> object:
    """Parquet stores UTC timestamps without a zone (DuckDB would need pytz to return aware ones)."""
    if isinstance(v, datetime) and v.tzinfo is not None:
        return v.astimezone(UTC).replace(tzinfo=None)
    return v


class Frontier:
    def __init__(self, items: dict[str, Item] | None = None) -> None:
        self.items: dict[str, Item] = items or {}
        self.dirty = False

    # ----- persistence -----

    @classmethod
    def load(cls, store: ObjectStore) -> Frontier:
        raw = store.get(FRONTIER_KEY)
        if raw is None:
            return cls()
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "f.parquet")
            with open(path, "wb") as fh:
                fh.write(raw)
            con = duckdb.connect()
            try:
                rows = con.execute(f"SELECT * FROM read_parquet('{path}') ORDER BY key").fetchall()
                cols = [d[0] for d in con.description or []]
            finally:
                con.close()
        items: dict[str, Item] = {}
        names = {f.name for f in fields(Item)}
        for row in rows:
            d = {c: v for c, v in zip(cols, row, strict=True) if c in names}
            for k in ("next_due", "first_seen", "last_changed"):
                if isinstance(d.get(k), datetime) and d[k].tzinfo is None:
                    d[k] = d[k].replace(tzinfo=UTC)
            items[d["key"]] = Item(**d)
        return cls(items)

    def save(self, store: ObjectStore) -> None:
        con = duckdb.connect()
        try:
            con.execute(
                """CREATE TABLE f (key VARCHAR, source VARCHAR, kind VARCHAR, entity_id VARCHAR,
                next_due TIMESTAMP, interval_s BIGINT, priority DOUBLE, etag VARCHAR, last_modified VARCHAR,
                record_hash VARCHAR, last_status VARCHAR, fail_count INTEGER, frozen BOOLEAN,
                first_seen TIMESTAMP, last_changed TIMESTAMP, event_date VARCHAR)"""
            )
            rows = [
                tuple(_naive(v) for v in asdict(i).values())
                for i in sorted(self.items.values(), key=lambda i: i.key)
            ]
            insert_rows(con, "f", rows)
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, "f.parquet")
                con.execute(f"COPY (SELECT * FROM f ORDER BY key) TO '{path}' (FORMAT PARQUET)")
                with open(path, "rb") as fh:
                    store.put(FRONTIER_KEY, fh.read(), content_type="application/vnd.apache.parquet")
        finally:
            con.close()
        self.dirty = False

    # ----- scheduling -----

    def get(self, key: str) -> Item | None:
        return self.items.get(key)

    def upsert(
        self,
        key: str,
        *,
        source: str,
        kind: str,
        entity_id: str,
        now: datetime,
        priority: float = 0.0,
        event_date: str | None = None,
    ) -> tuple[Item, bool]:
        """Creates the item due now if it does not exist. Returns (item, created)."""
        it = self.items.get(key)
        if it is not None:
            if priority > it.priority and not it.frozen:
                it.priority = priority
                self.dirty = True
            if event_date and not it.event_date:
                it.event_date = event_date
                self.dirty = True
            return it, False
        it = Item(
            key=key,
            source=source,
            kind=kind,
            entity_id=entity_id,
            next_due=now,
            interval_s=FIXED_INTERVAL.get(kind, MIN_INTERVAL.get(kind, DAY)),
            priority=priority,
            etag=None,
            last_modified=None,
            record_hash=None,
            last_status=None,
            fail_count=0,
            frozen=False,
            first_seen=now,
            last_changed=None,
            event_date=event_date,
        )
        self.items[key] = it
        self.dirty = True
        return it, True

    def signal(self, key: str, now: datetime, bonus: float = SIGNAL_BONUS) -> None:
        """A change signal pulls the item forward (and re-opens it if frozen)."""
        it = self.items.get(key)
        if it is None:
            return
        it.frozen = False
        it.next_due = min(it.next_due, now)
        if it.priority < bonus:
            it.priority += bonus
        it.interval_s = MIN_INTERVAL.get(it.kind, it.interval_s)
        self.dirty = True

    def mark_known(
        self, key: str, *, source: str, kind: str, entity_id: str, now: datetime, status: str
    ) -> None:
        """Records an item that is known but never fetched (skipped at discovery)."""
        it, _ = self.upsert(key, source=source, kind=kind, entity_id=entity_id, now=now)
        it.frozen = True
        it.last_status = status
        self.dirty = True

    def due(self, now: datetime, source: str | None = None) -> list[Item]:
        out = [
            i
            for i in self.items.values()
            if not i.frozen and i.next_due <= now and (source is None or i.source == source)
        ]
        return sorted(out, key=lambda i: (-i.priority, i.next_due, i.key))

    def complete(
        self,
        it: Item,
        now: datetime,
        *,
        changed: bool,
        status: str,
        record_hash: str | None = None,
        etag: str | None = None,
        last_modified: str | None = None,
        live: bool = False,
    ) -> None:
        """Applies a successful fetch (changed or not) to the item's schedule."""
        self.dirty = True
        it.last_status = status
        it.fail_count = 0
        if etag is not None:
            it.etag = etag
        if last_modified is not None:
            it.last_modified = last_modified
        if record_hash is not None:
            it.record_hash = record_hash
        if changed:
            it.last_changed = now
        if it.priority >= SIGNAL_BONUS:
            it.priority -= SIGNAL_BONUS
        if it.kind in FIXED_INTERVAL:
            it.interval_s = FIXED_INTERVAL[it.kind]
        elif it.kind in ONCE:
            it.frozen = True
            return
        elif live:
            it.interval_s = LIVE_INTERVAL
        else:
            minimum = MIN_INTERVAL.get(it.kind, DAY)
            ceiling = ceiling_s(it.age_days(now))
            if ceiling is None:
                it.frozen = True
                return
            it.interval_s = (
                minimum if changed else min(max(it.interval_s, minimum) * 2, max(ceiling, minimum))
            )
        it.next_due = now + timedelta(seconds=it.interval_s)

    def fail(self, it: Item, now: datetime, status: str, *, retry_s: int = 6 * HOUR) -> None:
        self.dirty = True
        it.last_status = status
        it.fail_count += 1
        if it.fail_count >= 8:
            it.frozen = True
        it.next_due = now + timedelta(seconds=min(retry_s * (2 ** (it.fail_count - 1)), 30 * DAY))

    def freeze(self, it: Item, status: str) -> None:
        self.dirty = True
        it.frozen = True
        it.last_status = status
