"""Snapshots: compute every slice, validate, upload `v=<version>/` then `manifest.json` last."""

from __future__ import annotations

import json
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from functools import cache
from importlib import resources
from typing import Any

import duckdb
import jsonschema

from market_research import logs
from market_research.catalog import Catalog
from market_research.config import SIDES, Settings, tier_config
from market_research.metrics import (
    BASELINE_COLUMNS,
    CARD_COLUMNS,
    IDENTITY_BASELINE_COLUMNS,
    IDENTITY_COLUMNS,
    card_view,
    compute_counts,
    identity_view,
)
from market_research.normalize import NORMALIZE_QUALITY_KEY, Normalizer, load_sources, load_tables
from market_research.storage import Stores

log = logs.get("market_research.publish")

MAX_SLICE_BYTES = 2 * 1024 * 1024
IMMUTABLE = "public, max-age=31536000, immutable"
MANIFEST_CACHE = "public, max-age=60"
SCHEMAS = {
    "manifest": "mr.manifest/1",
    "summary": "mr.summary/1",
    "trends": "mr.trends/1",
    "identities": "mr.identities/1",
    "catalog": "mr.catalog/1",
    "quality": "mr.quality/1",
}
PATHS = {
    "catalog": "catalog/cards.json",
    "summary": "meta/{side}/{restriction}/{tier_group}/summary.json",
    "trends": "meta/{side}/{restriction}/{tier_group}/trends.json",
    "identities": "meta/{side}/{restriction}/{tier_group}/identities.json",
    "quality": "quality/report.json",
}
ATTRIBUTION = {
    "text": "Tournament results from AlwaysBeRunning.net and NSG Cobra; decklists from NetrunnerDB.",
    "links": [
        {"name": "AlwaysBeRunning.net", "url": "https://alwaysberunning.net"},
        {"name": "NSG Cobra", "url": "https://tournaments.nullsignal.games"},
        {"name": "NetrunnerDB", "url": "https://netrunnerdb.com"},
    ],
}
DISCLAIMER = "Fan project, not affiliated with Null Signal Games."


class PublishError(Exception):
    """Validation failed; nothing was published."""


@cache
def schema(name: str) -> dict[str, Any]:
    text = resources.files("market_research").joinpath(f"schemas/{name}.schema.json").read_text("utf-8")
    loaded: dict[str, Any] = json.loads(text)
    return loaded


def encode(obj: Any) -> bytes:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=False).encode("utf-8")


def version_of(now: datetime) -> str:
    return now.strftime("%Y-%m-%dT%H%MZ")


def add_months(month: str, n: int) -> str:
    y, m = (int(x) for x in month.split("-"))
    idx = y * 12 + (m - 1) + n
    return f"{idx // 12:04d}-{idx % 12 + 1:02d}"


def month_range(a: str, b: str) -> list[str]:
    out = []
    cur = a
    while cur <= b:
        out.append(cur)
        cur = add_months(cur, 1)
    return out


@dataclass
class Snapshot:
    version: str
    files: dict[str, Any]  # path under v=<version>/ -> object
    manifest: dict[str, Any]


def _rows(
    con: duckdb.DuckDBPyConnection, table: str, keys: list[str], cols: list[str]
) -> list[tuple[Any, ...]]:
    sel = ", ".join(keys + [f"CAST({c} AS DOUBLE)" for c in cols])
    return con.execute(f"SELECT {sel} FROM {table} ORDER BY {', '.join(keys)}").fetchall()


def _num(v: Any) -> float | int:
    if isinstance(v, float):
        return int(v) if v.is_integer() else round(v, 4)
    return int(v)


class SnapshotBuilder:
    def __init__(
        self, con: duckdb.DuckDBPyConnection, catalog: Catalog, settings: Settings, now: datetime
    ) -> None:
        self.con = con
        self.catalog = catalog
        self.settings = settings
        self.now = now
        self.tiers = tier_config()
        self.version = version_of(now)
        compute_counts(con, catalog, settings)
        self.cards = _rows(
            con, "card_counts", ["side", "restriction_id", "tier", "month", "card_id"], CARD_COLUMNS
        )
        self.base = _rows(con, "side_counts", ["side", "restriction_id", "tier", "month"], BASELINE_COLUMNS)
        self.idents = _rows(
            con, "identity_counts", ["side", "restriction_id", "tier", "month", "identity"], IDENTITY_COLUMNS
        )
        self.ibase = _rows(
            con,
            "identity_side_counts",
            ["side", "restriction_id", "tier", "month"],
            IDENTITY_BASELINE_COLUMNS,
        )
        order = {r: i for i, r in enumerate(catalog.standard_restrictions())}
        present = {r[1] for r in self.base}
        self.restrictions = sorted(present, key=lambda r: (order.get(r, 10**6), r))
        self.months = (
            month_range(min(r[3] for r in self.base), max(r[3] for r in self.base)) if self.base else []
        )
        self.data_as_of = con.execute("SELECT max(date) FROM tournament").fetchone()
        self.groups = [g["id"] for g in self.tiers.groups]

    # ----- slicing -----

    @staticmethod
    def _match(row: tuple[Any, ...], side: str, restriction: str, group: str) -> bool:
        return row[0] == side and restriction in ("all", row[1]) and group in ("all", row[2])

    def _period(self, side: str, restriction: str, group: str) -> tuple[list[str], list[str]]:
        months = sorted({r[3] for r in self.base if self._match(r, side, restriction, group) and r[4] > 0})
        if not months:
            return [], []
        to = months[-1]
        p = self.settings.thresholds.period_months
        cur = month_range(add_months(to, -(p - 1)), to)
        prev = month_range(add_months(to, -(2 * p - 1)), add_months(to, -p))
        return cur, prev

    def summary(self, side: str, restriction: str, group: str) -> tuple[dict[str, Any], dict[str, Any]]:
        cur, prev = self._period(side, restriction, group)
        cs, ps = set(cur), set(prev)
        base_c = dict.fromkeys(BASELINE_COLUMNS, 0.0)
        base_p = dict.fromkeys(BASELINE_COLUMNS, 0.0)
        for r in self.base:
            if self._match(r, side, restriction, group):
                tgt = base_c if r[3] in cs else base_p if r[3] in ps else None
                if tgt is not None:
                    for i, col in enumerate(BASELINE_COLUMNS):
                        tgt[col] += r[4 + i]
        per_c: dict[str, dict[str, float]] = defaultdict(lambda: dict.fromkeys(CARD_COLUMNS, 0.0))
        per_p: dict[str, dict[str, float]] = defaultdict(lambda: dict.fromkeys(CARD_COLUMNS, 0.0))
        for r in self.cards:
            if self._match(r, side, restriction, group) and (r[3] in cs or r[3] in ps):
                tgt = per_c[r[4]] if r[3] in cs else per_p[r[4]]
                for i, col in enumerate(CARD_COLUMNS):
                    tgt[col] += r[5 + i]
        cards = []
        empty = dict.fromkeys(CARD_COLUMNS, 0.0)
        has_prev = base_p["side_decks"] > 0
        for cid in sorted(set(per_c) | set(per_p)):
            v = card_view(
                per_c.get(cid, empty),
                base_c,
                per_p.get(cid) if has_prev else None,
                base_p if has_prev else None,
                self.settings,
            )
            cards.append({"card_id": cid, **v})
        cards.sort(key=lambda c: (-c["decks"], c["card_id"]))
        for i, c in enumerate(cards, start=1):
            c["rank"] = i if c["decks"] > 0 else None
        movers = [c for c in cards if c["change_pp"] is not None and max(c["decks"], 1) >= 1]
        risers = [
            c["card_id"]
            for c in sorted(movers, key=lambda c: (-c["change_pp"], c["card_id"]))
            if c["change_pp"] > 0
        ][:10]
        fallers = [
            c["card_id"]
            for c in sorted(movers, key=lambda c: (c["change_pp"], c["card_id"]))
            if c["change_pp"] < 0
        ][:10]
        base_wr = base_c["side_wins"] / base_c["side_games"] if base_c["side_games"] else None
        base_cut = base_c["side_cut_hc"] / base_c["side_entries_hc"] if base_c["side_entries_hc"] else None
        head = self._head("summary", side, restriction, group)
        s = {
            **head,
            "period": {"from": cur[0], "to": cur[-1]} if cur else None,
            "previous_period": {"from": prev[0], "to": prev[-1]} if has_prev else None,
            "baseline": {
                "decks": int(base_c["side_decks"]),
                "games": int(base_c["side_games"]),
                "wins": _num(base_c["side_wins"]),
                "winrate": round(base_wr, 4) if base_wr is not None else None,
                "entries_hc": int(base_c["side_entries_hc"]),
                "cut_hc": int(base_c["side_cut_hc"]),
                "cut_rate": round(base_cut, 4) if base_cut is not None else None,
                "tournaments": int(base_c["tournaments"]),
                "tournaments_hc": int(base_c["tournaments_hc"]),
            },
            "cards": [c for c in cards if c["decks"] > 0 or c["prev_popularity"]],
            "risers": risers,
            "fallers": fallers,
        }
        idents = self.identities(side, restriction, group, cur)
        return s, idents

    def identities(self, side: str, restriction: str, group: str, cur: list[str]) -> dict[str, Any]:
        cs = set(cur)
        base = dict.fromkeys(IDENTITY_BASELINE_COLUMNS, 0.0)
        for r in self.ibase:
            if self._match(r, side, restriction, group) and r[3] in cs:
                for i, col in enumerate(IDENTITY_BASELINE_COLUMNS):
                    base[col] += r[4 + i]
        per: dict[str, dict[str, float]] = defaultdict(lambda: dict.fromkeys(IDENTITY_COLUMNS, 0.0))
        for r in self.idents:
            if self._match(r, side, restriction, group) and r[3] in cs:
                for i, col in enumerate(IDENTITY_COLUMNS):
                    per[r[4]][col] += r[5 + i]
        rows = [{"card_id": cid, **identity_view(v, base, self.settings)} for cid, v in per.items()]
        rows.sort(key=lambda x: (-x["entries"], x["card_id"]))
        for i, x in enumerate(rows, start=1):
            x["rank"] = i
        base_wr = base["side_wins"] / base["side_games"] if base["side_games"] else None
        base_conv = base["side_cut_made"] / base["side_cut_entries"] if base["side_cut_entries"] else None
        return {
            **self._head("identities", side, restriction, group),
            "period": {"from": cur[0], "to": cur[-1]} if cur else None,
            "baseline": {
                "entries": int(base["side_entries"]),
                "games": int(base["side_games"]),
                "wins": _num(base["side_wins"]),
                "winrate": round(base_wr, 4) if base_wr is not None else None,
                "cut_entries": int(base["side_cut_entries"]),
                "cut_made": int(base["side_cut_made"]),
                "cut_rate": round(base_conv, 4) if base_conv is not None else None,
            },
            "identities": rows,
        }

    def trends(self, side: str, restriction: str, group: str) -> dict[str, Any]:
        m_idx = {m: i for i, m in enumerate(self.months)}
        r_idx = {r: i for i, r in enumerate(self.restrictions)}
        base: dict[tuple[int, int], list[float]] = defaultdict(lambda: [0.0] * len(BASELINE_COLUMNS))
        for r in self.base:
            if self._match(r, side, restriction, group):
                acc = base[(m_idx[r[3]], r_idx[r[1]])]
                for i in range(len(BASELINE_COLUMNS)):
                    acc[i] += r[4 + i]
        cards: dict[str, dict[tuple[int, int], list[float]]] = defaultdict(
            lambda: defaultdict(lambda: [0.0] * len(CARD_COLUMNS))
        )
        for r in self.cards:
            if self._match(r, side, restriction, group):
                acc = cards[r[4]][(m_idx[r[3]], r_idx[r[1]])]
                for i in range(len(CARD_COLUMNS)):
                    acc[i] += r[5 + i]
        return {
            **self._head("trends", side, restriction, group),
            "months": self.months,
            "restrictions": self.restrictions,
            "columns": CARD_COLUMNS,
            "baseline_columns": BASELINE_COLUMNS,
            "baseline": [[m, ri, *(_num(x) for x in v)] for (m, ri), v in sorted(base.items()) if any(v)],
            "cards": {
                cid: [[m, ri, *(_num(x) for x in v)] for (m, ri), v in sorted(rows.items())]
                for cid, rows in sorted(cards.items())
            },
        }

    def _head(self, kind: str, side: str, restriction: str, group: str) -> dict[str, Any]:
        return {
            "schema": SCHEMAS[kind],
            "version": self.version,
            "side": side,
            "restriction": restriction,
            "tier_group": group,
        }

    # ----- whole snapshot -----

    def catalog_file(self) -> dict[str, Any]:
        cards = []
        for cid in sorted(self.catalog.cards):
            c = self.catalog.cards[cid]
            legal = [r for r in self.restrictions if self.catalog.legal_in(cid, r)]
            if not legal:
                continue
            cards.append(
                {
                    "id": cid,
                    "title": c.title,
                    "side": c.side_id,
                    "type": c.card_type_id,
                    "faction": c.faction_id,
                    "printings": sorted(c.printing_ids),
                    "legal_in": legal,
                }
            )
        return {
            "schema": SCHEMAS["catalog"],
            "version": self.version,
            "restrictions": self.restrictions,
            "cards": cards,
        }

    def restriction_list(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = [{"id": "all", "name": "All ban lists", "date_start": None}]
        for r in self.restrictions:
            meta = self.catalog.restrictions.get(r)
            out.append(
                {"id": r, "name": meta.name if meta else r, "date_start": meta.date_start if meta else None}
            )
        return out

    def build(self, quality: dict[str, Any]) -> Snapshot:
        files: dict[str, Any] = {PATHS["catalog"]: self.catalog_file()}
        for side in SIDES:
            for restriction in ["all", *self.restrictions]:
                for group in ["all", *self.groups]:
                    fmt = {"side": side, "restriction": restriction, "tier_group": group}
                    summary, idents = self.summary(side, restriction, group)
                    files[PATHS["summary"].format(**fmt)] = summary
                    files[PATHS["identities"].format(**fmt)] = idents
                    files[PATHS["trends"].format(**fmt)] = self.trends(side, restriction, group)
        files[PATHS["quality"]] = {"schema": SCHEMAS["quality"], "version": self.version, **quality}
        as_of = self.data_as_of[0] if self.data_as_of else None
        manifest = {
            "schema": SCHEMAS["manifest"],
            "version": self.version,
            "base_path": f"v={self.version}/",
            "generated_at": self.now.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "data_as_of": as_of.isoformat() if isinstance(as_of, date) else None,
            "formats": ["standard"],
            "sides": list(SIDES),
            "restrictions": self.restriction_list(),
            "tier_groups": [{"id": "all", "name": "All tiers"}, *self.tiers.groups],
            "months": self.months,
            "period_months": self.settings.thresholds.period_months,
            "thresholds": {
                "min_games": self.settings.thresholds.min_games,
                "min_entries": self.settings.thresholds.min_entries,
                "coverage_hc": self.settings.thresholds.coverage_hc,
                "min_players": self.settings.thresholds.min_players,
            },
            "paths": PATHS,
            "schemas": SCHEMAS,
            "attribution": ATTRIBUTION,
            "disclaimer": DISCLAIMER,
        }
        return Snapshot(self.version, files, manifest)


def quality_report(
    stores: Stores, con: duckdb.DuckDBPyConnection, norm_q: dict[str, Any], settings: Settings
) -> dict[str, Any]:
    ingest_q = stores.canonical.get_json("state/ingest_quality.json") or {}
    one = con.execute(
        """SELECT count(*), count(*) FILTER (WHERE has_games), count(*) FILTER (WHERE decklist_coverage >= ? AND cut_size > 0),
                  coalesce(round(avg(decklist_coverage), 4), 0)
           FROM tournament""",
        [settings.thresholds.coverage_hc],
    ).fetchone()
    assert one is not None
    decks = con.execute("SELECT count(*), count(*) FILTER (WHERE legal) FROM deck").fetchone()
    assert decks is not None
    by_source = dict(con.execute("SELECT source, count(*) FROM deck GROUP BY 1 ORDER BY 1").fetchall())
    entries = con.execute("SELECT count(*) FROM entry").fetchone()
    games = con.execute("SELECT count(*) FROM game").fetchone()
    return {
        "coverage": {
            "tournaments": one[0],
            "tournaments_with_games": one[1],
            "tournaments_high_coverage": one[2],
            "mean_decklist_coverage": float(one[3]),
            "entries": entries[0] if entries else 0,
            "games": games[0] if games else 0,
            "decks": decks[0],
            "legal_decks": decks[1],
            "illegal_decks": decks[0] - decks[1],
            "decks_by_source": by_source,
            "deck_comparison": norm_q.get("deck_comparison", {}),
        },
        "unresolved_cards": norm_q.get("unresolved_cards", {}),
        "unresolved_identities": norm_q.get("unresolved_identities", {}),
        "parser_failures": ingest_q.get("quarantine", []),
        "link_mismatches": norm_q.get("link_mismatches", []),
        "links": norm_q.get("links", []),
        "drift_warnings": ingest_q.get("drift", {}),
        "rejected_deck_refs": int(
            ingest_q.get("rejected_deck_refs_total", ingest_q.get("rejected_deck_refs", 0))
        ),
        "skipped_tournaments": norm_q.get("skipped_tournaments", {}),
    }


def validate(snap: Snapshot, con: duckdb.DuckDBPyConnection) -> list[str]:
    errors: list[str] = []
    kinds = {
        "catalog": "catalog",
        "summary": "summary",
        "trends": "trends",
        "identities": "identities",
        "report": "quality",
    }
    known = {c["id"] for c in snap.files[PATHS["catalog"]]["cards"]}
    for path, obj in sorted(snap.files.items()):
        name = path.rsplit("/", 1)[1].removesuffix(".json")
        kind = kinds["catalog" if path == PATHS["catalog"] else name]
        try:
            jsonschema.validate(obj, schema(kind))
        except jsonschema.ValidationError as e:
            errors.append(f"{path}: {e.message[:200]}")
        size = len(encode(obj))
        if size > MAX_SLICE_BYTES:
            errors.append(f"{path}: {size} bytes exceeds the 2 MB slice limit")
        ids: set[str] = set()
        if kind == "summary":
            ids = {c["card_id"] for c in obj["cards"]} | set(obj["risers"]) | set(obj["fallers"])
        elif kind == "identities":
            ids = {c["card_id"] for c in obj["identities"]}
        elif kind == "trends":
            ids = set(obj["cards"])
        missing = ids - known
        if missing:
            errors.append(f"{path}: card ids not in the catalog: {sorted(missing)[:5]}")
    try:
        jsonschema.validate(snap.manifest, schema("manifest"))
    except jsonschema.ValidationError as e:
        errors.append(f"manifest.json: {e.message[:200]}")
    # Totals in the published slices must match the canonical tables.
    for side in SIDES:
        tr = snap.files[PATHS["trends"].format(side=side, restriction="all", tier_group="all")]
        pub = sum(row[2] for row in tr["baseline"])
        row = con.execute("SELECT count(*) FROM d WHERE side = ?", [side]).fetchone()
        canon = row[0] if row else 0
        if pub != canon:
            errors.append(f"{side}: published decks {pub} != canonical {canon}")
        games = sum(row[3] for row in tr["baseline"])
        row = con.execute("SELECT count(*) FROM dg WHERE side = ?", [side]).fetchone()
        if games != (row[0] if row else 0):
            errors.append(f"{side}: published games {games} != canonical")
    return errors


def build(stores: Stores, settings: Settings, now: datetime) -> tuple[Snapshot, list[str]]:
    sources_catalog = {
        k: v
        for k, v in load_sources(stores.source, stores.canonical).items()
        if k.startswith("nrdb/catalog/")
    }
    catalog = Normalizer(sources_catalog, settings).catalog
    with tempfile.TemporaryDirectory() as tmp:
        con = duckdb.connect()
        try:
            load_tables(stores.canonical, con, tmp)
            norm_q = stores.canonical.get_json(NORMALIZE_QUALITY_KEY) or {}
            builder = SnapshotBuilder(con, catalog, settings, now)
            snap = builder.build(quality_report(stores, con, norm_q, settings))
            errors = validate(snap, con)
        finally:
            con.close()
    return snap, errors


def publish(stores: Stores, snap: Snapshot, errors: list[str]) -> int:
    """Uploads the version, then the manifest. Returns the number of slice files published."""
    if errors:
        for e in errors[:20]:
            log.error("snapshot_invalid", error=e)
        raise PublishError(f"{len(errors)} validation errors; nothing published")
    prefix = f"v={snap.version}/"
    for path, obj in sorted(snap.files.items()):
        stores.published.put(
            prefix + path, encode(obj), content_type="application/json", cache_control=IMMUTABLE
        )
    stores.published.put(
        "manifest.json", encode(snap.manifest), content_type="application/json", cache_control=MANIFEST_CACHE
    )
    log.info("published", version=snap.version, files=len(snap.files))
    return len(snap.files)
