"""NetrunnerDB: v3 public catalog API and v2 public decklist API."""

from __future__ import annotations

from datetime import date
from typing import Any

from pydantic import ValidationError

from market_research.config import NRDB_API_HOST, NRDB_HOST
from market_research.http import PoliteHttp
from market_research.records import (
    CatalogKind,
    CatCard,
    CatFormat,
    CatPrinting,
    CatRestriction,
    CatSet,
    CatSnapshot,
    NrdbByDate,
    NrdbCatalog,
    NrdbDecklist,
    PrintingQty,
    Verdicts,
)
from market_research.scrub import IngestQuality
from market_research.sources.common import (
    NotFound,
    ParseError,
    as_bool,
    attributes,
    opt_int,
    opt_printing,
    parse_date,
    strict_uuid_or_int,
    url,
)

V3 = f"https://{NRDB_API_HOST}"
V3_PATH = "/api/v3/public"
V2 = f"https://{NRDB_HOST}"
V2_PATH = "/api/2.0/public"

CATALOG_KINDS: tuple[CatalogKind, ...] = (
    "card_sets",
    "restrictions",
    "formats",
    "snapshots",
    "cards",
    "printings",
)
# 500 keeps each page near 2.2 MB, well under max_response_bytes (1000 is already ~4.5 MB).
PAGE_SIZE: dict[str, int] = {"cards": 500, "printings": 500}

CARD_ATTRS = frozenset({
    "id", "stripped_title", "title", "card_type_id", "side_id", "faction_id", "cost",
    "advancement_requirement", "agenda_points", "base_link", "deck_limit", "in_restriction",
    "influence_cost", "influence_limit", "memory_cost", "minimum_deck_size", "num_printings",
    "printing_ids", "date_release", "restriction_ids", "strength", "stripped_text", "text",
    "trash_cost", "is_unique", "card_subtype_ids", "display_subtypes", "attribution", "updated_at",
    "format_ids", "card_pool_ids", "snapshot_ids", "card_cycle_ids", "card_cycle_names",
    "card_set_ids", "card_set_names", "designed_by", "narrative_text", "printings_released_by",
    "pronouns", "pronunciation_approximation", "pronunciation_ipa", "layout_id", "num_extra_faces",
    "faces", "card_abilities", "restrictions", "latest_printing_id", "latest_printing_images",
})  # fmt: skip
PRINTING_ATTRS = CARD_ATTRS | frozenset({
    "card_id", "card_cycle_id", "card_cycle_name", "card_set_id", "card_set_name", "flavor",
    "display_illustrators", "illustrator_ids", "illustrator_names", "position", "position_in_set",
    "quantity", "is_latest_printing", "card_subtype_names", "released_by", "images",
})  # fmt: skip
SET_ATTRS = frozenset({
    "id", "name", "date_release", "size", "card_cycle_id", "card_set_type_id", "legacy_code",
    "position", "first_printing_id", "released_by", "updated_at",
})  # fmt: skip
FORMAT_ATTRS = frozenset({
    "id", "name", "active_snapshot_id", "snapshot_ids", "restriction_ids", "active_card_pool_id",
    "active_restriction_id", "updated_at",
})  # fmt: skip
RESTRICTION_ATTRS = frozenset({
    "id", "name", "date_start", "point_limit", "format_id", "verdicts", "banned_subtypes", "size", "updated_at",
})  # fmt: skip
SNAPSHOT_ATTRS = frozenset({
    "id", "format_id", "active", "card_cycle_ids", "card_set_ids", "card_pool_id", "restriction_id",
    "num_cards", "date_start", "updated_at",
})  # fmt: skip
DECKLIST_KEYS = frozenset({
    "id", "uuid", "date_creation", "date_update", "name", "description", "user_id", "user_name",
    "tournament_badge", "cards", "mwl_code", "votes_count", "favorites_count", "comments_count", "tags",
})  # fmt: skip
ENVELOPE_KEYS = frozenset({"data", "total", "success", "version_number", "last_updated", "msg"})


def catalog_url(kind: str, page: int = 1) -> str:
    if kind not in CATALOG_KINDS:
        raise ValueError(kind)
    return url(V3, f"{V3_PATH}/{kind}", {"page[number]": page, "page[size]": PAGE_SIZE.get(kind, 1000)})


def by_date_url(d: date) -> str:
    return url(V2, f"{V2_PATH}/decklists/by_date/{d.isoformat()}")


def decklist_url(ident: str) -> str:
    return url(V2, f"{V2_PATH}/decklist/{strict_uuid_or_int(ident)}")


def deck_url(ident: str) -> str:
    return url(V2, f"{V2_PATH}/deck/{strict_uuid_or_int(ident)}")


# ---------------- catalog ----------------


def _strs(v: object) -> list[str]:
    return sorted(str(x) for x in v) if isinstance(v, list) else []


def parse_catalog(kind: CatalogKind, items: list[dict[str, Any]], q: IngestQuality) -> NrdbCatalog:
    out: dict[str, Any] = {"kind": kind}
    rows: list[Any] = []
    for it in items:
        a = attributes(it)
        try:
            if kind == "cards":
                q.check_drift("nrdb.card", a.keys(), CARD_ATTRS)
                rows.append(
                    CatCard(
                        id=str(a["id"]),
                        title=str(a.get("title") or a.get("stripped_title") or a["id"])[:120],
                        side_id=str(a.get("side_id")),
                        card_type_id=str(a.get("card_type_id")),
                        faction_id=str(a.get("faction_id")),
                        influence_cost=opt_int(a.get("influence_cost")),
                        influence_limit=opt_int(a.get("influence_limit")),
                        minimum_deck_size=opt_int(a.get("minimum_deck_size")),
                        deck_limit=opt_int(a.get("deck_limit")),
                        agenda_points=opt_int(a.get("agenda_points")),
                        is_unique=as_bool(a.get("is_unique")),
                        card_pool_ids=_strs(a.get("card_pool_ids")),
                        printing_ids=_strs(a.get("printing_ids")),
                    )
                )
            elif kind == "printings":
                q.check_drift("nrdb.printing", a.keys(), PRINTING_ATTRS)
                rows.append(
                    CatPrinting(
                        id=str(a["id"]),
                        card_id=str(a["card_id"]),
                        card_set_id=str(a.get("card_set_id")),
                        date_release=parse_date(a["date_release"]) if a.get("date_release") else None,
                    )
                )
            elif kind == "card_sets":
                q.check_drift("nrdb.card_set", a.keys(), SET_ATTRS)
                rows.append(
                    CatSet(
                        id=str(a["id"]),
                        name=str(a.get("name") or "")[:80],
                        date_release=parse_date(a["date_release"]) if a.get("date_release") else None,
                        card_cycle_id=a.get("card_cycle_id"),
                    )
                )
            elif kind == "formats":
                q.check_drift("nrdb.format", a.keys(), FORMAT_ATTRS)
                rows.append(
                    CatFormat(
                        id=str(a["id"]),
                        name=str(a.get("name") or "")[:80],
                        active_snapshot_id=a.get("active_snapshot_id"),
                        snapshot_ids=_strs(a.get("snapshot_ids")),
                        restriction_ids=_strs(a.get("restriction_ids")),
                    )
                )
            elif kind == "restrictions":
                q.check_drift("nrdb.restriction", a.keys(), RESTRICTION_ATTRS)
                v = a.get("verdicts") or {}
                rows.append(
                    CatRestriction(
                        id=str(a["id"]),
                        name=str(a.get("name") or "")[:80],
                        date_start=parse_date(a["date_start"]) if a.get("date_start") else None,
                        format_id=a.get("format_id"),
                        point_limit=opt_int(a.get("point_limit")),
                        verdicts=Verdicts(
                            banned=_strs(v.get("banned")),
                            restricted=_strs(v.get("restricted")),
                            universal_faction_cost={
                                str(k): int(x) for k, x in (v.get("universal_faction_cost") or {}).items()
                            },
                            global_penalty=_strs(v.get("global_penalty")),
                            points={str(k): int(x) for k, x in (v.get("points") or {}).items()},
                        ),
                    )
                )
            else:
                q.check_drift("nrdb.snapshot", a.keys(), SNAPSHOT_ATTRS)
                rows.append(
                    CatSnapshot(
                        id=str(a["id"]),
                        format_id=str(a.get("format_id")),
                        card_pool_id=a.get("card_pool_id"),
                        restriction_id=a.get("restriction_id"),
                        date_start=parse_date(a["date_start"]) if a.get("date_start") else None,
                        active=as_bool(a.get("active")),
                    )
                )
        except (KeyError, ValidationError) as e:
            raise ParseError(f"bad {kind} item") from e
    out[kind] = sorted(rows, key=lambda r: r.id)
    return NrdbCatalog.model_validate(out).hashed()


def fetch_catalog(
    http: PoliteHttp, kind: CatalogKind, q: IngestQuality, *, etag: str | None, last_modified: str | None
) -> tuple[NrdbCatalog | None, str | None, str | None]:
    """Returns (record or None when unchanged, etag, last_modified) for the first page's validators."""
    items: list[dict[str, Any]] = []
    page = 1
    first_etag, first_lm = etag, last_modified
    size = PAGE_SIZE.get(kind, 1000)
    while True:
        r = http.get(
            catalog_url(kind, page),
            etag=etag if page == 1 else None,
            last_modified=last_modified if page == 1 else None,
            accept="application/vnd.api+json, application/json",
        )
        if r.not_modified:
            return None, first_etag, first_lm
        if r.status != 200:
            raise NotFound(f"status {r.status}")
        if page == 1:
            first_etag, first_lm = r.etag, r.last_modified
        doc = r.json()
        if not isinstance(doc, dict) or not isinstance(doc.get("data"), list):
            raise ParseError("not a JSON:API document")
        items.extend(doc["data"])
        if len(doc["data"]) < size:
            break
        page += 1
    return parse_catalog(kind, items, q), first_etag, first_lm


# ---------------- decklists ----------------


def _envelope(payload: object, q: IngestQuality) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ParseError("not an API envelope")
    q.check_drift("nrdb.v2.envelope", payload.keys(), ENVELOPE_KEYS)
    data = payload.get("data")
    if payload.get("success") is False and not data:
        raise NotFound("success=false")
    if not isinstance(data, list):
        raise ParseError("envelope without data")
    return data


def parse_decklist(
    obj: dict[str, Any],
    q: IngestQuality,
    *,
    kind: str = "decklist",
    identity_printings: frozenset[str] = frozenset(),
) -> NrdbDecklist:
    q.check_drift(f"nrdb.v2.{kind}", obj.keys(), DECKLIST_KEYS)
    cards = obj.get("cards")
    if not isinstance(cards, dict):
        raise ParseError("decklist without cards")
    rows = []
    ident = None
    for code, qty in sorted(cards.items()):
        pid = opt_printing(code)
        n = opt_int(qty) or 0
        if pid is None or n <= 0:
            continue
        if pid in identity_printings:
            ident = pid
            continue
        rows.append(PrintingQty(printing_id=pid, qty=n))
    uuid = obj.get("uuid")
    return NrdbDecklist(
        kind=kind,
        id=strict_uuid_or_int(str(obj.get("id"))),
        uuid=strict_uuid_or_int(str(uuid)) if uuid else None,
        published=parse_date(obj["date_creation"]) if obj.get("date_creation") else None,
        identity_printing_id=ident,
        cards=rows,
    ).hashed()


def parse_by_date(
    d: date, payload: object, q: IngestQuality, identity_printings: frozenset[str] = frozenset()
) -> NrdbByDate:
    try:
        data = _envelope(payload, q)
    except NotFound:
        data = []
    lists = [parse_decklist(o, q, identity_printings=identity_printings) for o in data]
    return NrdbByDate(date=d.isoformat(), decklists=sorted(lists, key=lambda x: int(x.id))).hashed()


def parse_single(
    payload: object, q: IngestQuality, *, kind: str, identity_printings: frozenset[str] = frozenset()
) -> NrdbDecklist:
    data = _envelope(payload, q)
    if not data:
        raise NotFound("empty")
    return parse_decklist(data[0], q, kind=kind, identity_printings=identity_printings)
