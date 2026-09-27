"""NSG Cobra (tournaments.nullsignal.games): public JSON:API, NRTM export and deck pages."""

from __future__ import annotations

import json
from datetime import date
from typing import Any

from selectolax.parser import HTMLParser

from market_research.config import COBRA_HOST
from market_research.http import PoliteHttp
from market_research.records import (
    CardRef,
    CobraCatalog,
    CobraDeck,
    CobraDeckCard,
    CobraPairing,
    CobraPlayer,
    CobraStage,
    CobraTournament,
    DeckVisibility,
    NamedRef,
    Visibility,
)
from market_research.scrub import IngestQuality
from market_research.sources.common import (
    NotFound,
    ParseError,
    as_bool,
    attributes,
    jsonapi_pages,
    opt_float,
    opt_int,
    opt_printing,
    opt_slug,
    parse_date,
    strict_int,
    strict_uuid_or_int,
    url,
)

BASE = f"https://{COBRA_HOST}"
API = "/api/v1/public"

# Every attribute the public tournament resource is known to return. Personal and free-text
# fields are listed so they are recognised (not reported as drift) but they are never kept.
TOURNAMENT_ATTRS = frozenset({
    "id", "name", "slug", "abr_code", "private", "user_id", "tournament_organizer", "date", "time_zone",
    "registration_starts", "tournament_starts", "organizer_contact", "event_link", "stream_url",
    "description", "additional_prizes_description", "official_prize_kit_id", "official_prize_kit_name",
    "stage", "manual_seed", "self_registration", "nrdb_deck_registration", "decklist_required",
    "allow_self_reporting", "allow_streaming_opt_out", "all_players_unlocked", "any_player_unlocked",
    "registration_closed", "swiss_deck_visibility", "cut_deck_visibility", "swiss_format",
    "tournament_type_id", "format_id", "format_name", "deckbuilding_restriction_id",
    "deckbuilding_restriction_name", "card_set_id", "active_player_count", "dropped_player_count",
    "created_at", "updated_at",
})  # fmt: skip
NRTM_KEYS = frozenset({
    "name", "date", "cutToTop", "preliminaryRounds", "tournamentOrganiser", "players",
    "eliminationPlayers", "rounds", "uploadedFrom", "links",
})  # fmt: skip
NRTM_PLAYER_KEYS = frozenset({
    "id", "name", "rank", "corpFaction", "corpIdentity", "runnerFaction", "runnerIdentity",
    "matchPoints", "strengthOfSchedule", "extendedStrengthOfSchedule", "pronouns",
})  # fmt: skip
NRTM_ELIM_KEYS = frozenset({"id", "name", "rank", "seed"})
NRTM_PAIRING_KEYS = frozenset(
    {"table", "player1", "player2", "intentionalDraw", "twoForOne", "eliminationGame"}
)
NRTM_PSIDE_KEYS = frozenset({"id", "role", "runnerScore", "corpScore", "combinedScore", "winner"})
DECK_DETAIL_KEYS = frozenset({
    "id", "player_id", "user_id", "name", "identity_title", "identity_nrdb_card_id",
    "identity_nrdb_printing_id", "side_id", "faction_id", "max_influence", "min_deck_size",
    "nrdb_uuid", "created_at", "updated_at", "mine", "player_name",
})  # fmt: skip
DECK_CARD_KEYS = frozenset({
    "id", "deck_id", "title", "quantity", "influence", "influence_cost", "nrdb_card_id",
    "nrdb_printing_id", "card_type_id", "faction_id", "created_at", "updated_at",
})  # fmt: skip
PLAYER_ATTRS = frozenset({
    "id", "tournament_id", "user_id", "name", "pronouns", "active", "seed", "fixed_table_number",
    "manual_seed", "first_round_bye", "include_in_stream", "registration_locked",
    "corp_identity_id", "runner_identity_id",
})  # fmt: skip
CATALOG_ATTRS = {
    "formats": frozenset({"id", "name", "position", "created_at", "updated_at"}),
    "tournament_types": frozenset(
        {"id", "name", "nsg_format", "description", "position", "created_at", "updated_at"}
    ),
    "deckbuilding_restrictions": frozenset(
        {"id", "name", "date_start", "play_format_id", "created_at", "updated_at"}
    ),
}


def visibility(value: object) -> Visibility:
    v = str(value or "").lower()
    if v.endswith("public"):
        return "public"
    if v.endswith("open"):
        return "open"
    return "private"


# ---------------- URLs (always built here, never taken from data) ----------------


def index_url(page: int, size: int) -> str:
    return url(BASE, f"{API}/tournaments", {"page[number]": page, "page[size]": size, "sort": "-id"})


def show_url(tid: int) -> str:
    return url(BASE, f"{API}/tournaments/{strict_int(tid)}")


def nrtm_url(tid: int) -> str:
    return url(BASE, f"/tournaments/{strict_int(tid)}.json")


def decks_url(tid: int, pid: int) -> str:
    return url(BASE, f"/tournaments/{strict_int(tid)}/players/{strict_int(pid)}/view_decks")


# ---------------- parsers ----------------


def parse_index_item(item: dict[str, Any], q: IngestQuality, fetched_at: str) -> tuple[CobraTournament, bool]:
    """Returns the tournament's metadata record and whether it is private."""
    a = attributes(item)
    q.check_drift("cobra.tournament.attributes", a.keys(), TOURNAMENT_ATTRS)
    rec = CobraTournament(
        id=strict_int(a.get("id")),
        fetched_at=fetched_at,
        abr_code=str(a["abr_code"])[:32] if a.get("abr_code") not in (None, "") else None,
        date=parse_date(a.get("date")),
        type_id=opt_int(a.get("tournament_type_id")),
        format_id=opt_int(a.get("format_id")),
        restriction_id=opt_slug(a.get("deckbuilding_restriction_id")),
        card_set_id=opt_slug(a.get("card_set_id")),
        swiss_format=_enum(a.get("swiss_format"), {"single_sided", "double_sided"}),
        deck_visibility=DeckVisibility(
            swiss=visibility(a.get("swiss_deck_visibility")), cut=visibility(a.get("cut_deck_visibility"))
        ),
        players_active=opt_int(a.get("active_player_count")),
        players_dropped=opt_int(a.get("dropped_player_count")),
        stage=_enum(a.get("stage"), {"swiss", "double_elim", "single_elim"}),
    )
    return rec.hashed(), as_bool(a.get("private"))


def created_date(item: dict[str, Any]) -> date | None:
    """The index item's creation date, or None when it is missing or unreadable."""
    try:
        return date.fromisoformat(parse_date(attributes(item).get("created_at")))
    except ValueError:  # ParseError included
        return None


def _enum(value: object, allowed: set[str]) -> str | None:
    s = str(value) if value is not None else None
    return s if s in allowed else None


def parse_nrtm(payload: object, meta: CobraTournament, q: IngestQuality, fetched_at: str) -> CobraTournament:
    if not isinstance(payload, dict):
        raise ParseError("NRTM export is not an object")
    q.check_drift("cobra.nrtm", payload.keys(), NRTM_KEYS)
    prelim = opt_int(payload.get("preliminaryRounds")) or 0
    cut_to = opt_int(payload.get("cutToTop")) or 0
    cut_rank: dict[int, int] = {}
    for e in payload.get("eliminationPlayers") or []:
        q.check_drift("cobra.nrtm.elimination_player", e.keys(), NRTM_ELIM_KEYS)
        if e.get("id") is not None and e.get("rank") is not None:
            cut_rank[strict_int(e["id"])] = strict_int(e["rank"])
    players = []
    for p in payload.get("players") or []:
        q.check_drift("cobra.nrtm.player", p.keys(), NRTM_PLAYER_KEYS)
        pid = strict_int(p.get("id"))
        players.append(
            CobraPlayer(
                pid=pid,
                active=None,
                corp_identity=_title(p.get("corpIdentity")),
                runner_identity=_title(p.get("runnerIdentity")),
                swiss_rank=opt_int(p.get("rank")),
                cut_rank=cut_rank.get(pid),
                points=opt_int(p.get("matchPoints")),
                sos=opt_float(p.get("strengthOfSchedule")),
                esos=opt_float(p.get("extendedStrengthOfSchedule")),
            )
        )
    double_sided = meta.swiss_format == "double_sided"
    pairings: list[CobraPairing] = []
    swiss_rounds = 0
    cut_rounds = 0
    for rnd in payload.get("rounds") or []:
        if not isinstance(rnd, list):
            raise ParseError("round is not a list")
        elimination = any(as_bool(g.get("eliminationGame")) for g in rnd) or (swiss_rounds >= prelim > 0)
        if elimination:
            cut_rounds += 1
            stage, rno = 2, cut_rounds
        else:
            swiss_rounds += 1
            stage, rno = 1, swiss_rounds
        for g in rnd:
            q.check_drift("cobra.nrtm.pairing", g.keys(), NRTM_PAIRING_KEYS)
            pairings.append(_pairing(g, stage, rno, elimination, double_sided, q))
    stages = [
        CobraStage(
            n=1, format="swiss" if double_sided else "single_sided_swiss", rounds=swiss_rounds or prelim
        )
    ]
    if cut_to:
        stages.append(CobraStage(n=2, format="elimination", rounds=cut_rounds, size=cut_to))
    rec = meta.model_copy(
        update={
            "fetched_at": fetched_at,
            "results_fetched": True,
            "stages": stages,
            "players": sorted(players, key=lambda p: (p.swiss_rank or 10**6, p.pid)),
            "pairings": pairings,
        }
    )
    return CobraTournament.model_validate(rec.model_dump(by_alias=True)).hashed()


def _title(value: object) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    return s[:120] or None


def _pairing(
    g: dict[str, Any], stage: int, rno: int, elimination: bool, double_sided: bool, q: IngestQuality
) -> CobraPairing:
    p1 = g.get("player1") or {}
    p2 = g.get("player2") or {}
    for p in (p1, p2):
        q.check_drift("cobra.nrtm.pairing_player", p.keys(), NRTM_PSIDE_KEYS)
    side = p1.get("role")
    winner = None
    if elimination:
        if p1.get("winner") is True:
            winner = 1
        elif p2.get("winner") is True:
            winner = 2
    return CobraPairing(
        stage=stage,
        round=rno,
        table=opt_int(g.get("table")),
        p1=opt_int(p1.get("id")),
        p2=opt_int(p2.get("id")),
        p1_side=side if side in ("corp", "runner") and not double_sided else None,
        p1_corp_score=opt_int(p1.get("corpScore")),
        p1_runner_score=opt_int(p1.get("runnerScore")),
        p2_corp_score=opt_int(p2.get("corpScore")),
        p2_runner_score=opt_int(p2.get("runnerScore")),
        intentional_draw=as_bool(g.get("intentionalDraw")),
        two_for_one=as_bool(g.get("twoForOne")),
        elimination=elimination,
        winner=winner,
    )


def has_unreported(t: CobraTournament) -> bool:
    if not t.pairings:
        return True
    for p in t.pairings:
        if p.p2 is None:
            continue  # bye
        if p.elimination:
            if p.winner is None:
                return True
        elif t.swiss_format == "double_sided":
            if None in (p.p1_corp_score, p.p1_runner_score, p.p2_corp_score, p.p2_runner_score):
                return True
        elif p.p1_corp_score is None and p.p1_runner_score is None:
            return True
    return False


def parse_view_decks(
    html_text: str, tid: int, pid: int, t: CobraTournament, q: IngestQuality
) -> list[CobraDeck]:
    """Reads the hidden #corp_deck / #runner_deck inputs. No scripts run; only these inputs are read."""
    tree = HTMLParser(html_text)
    in_cut = any(p.pid == pid and p.cut_rank is not None for p in t.players)
    vis = t.deck_visibility.swiss
    if t.deck_visibility.swiss != "public" and in_cut:
        vis = t.deck_visibility.cut
    decks = []
    for side in ("corp", "runner"):
        node = tree.css_first(f"input#{side}_deck")
        raw = node.attributes.get("value") if node is not None else None
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ParseError("deck JSON does not parse") from e
        if not isinstance(obj, dict):
            continue
        details = obj.get("details") or {}
        cards = obj.get("cards") or []
        q.check_drift("cobra.deck.details", details.keys(), DECK_DETAIL_KEYS)
        if str(details.get("side_id", side)) != side:
            raise ParseError("deck side does not match its input")
        out_cards: dict[tuple[str | None, str | None], int] = {}
        for c in cards:
            q.check_drift("cobra.deck.card", c.keys(), DECK_CARD_KEYS)
            key = (opt_slug(c.get("nrdb_card_id")), opt_printing(c.get("nrdb_printing_id")))
            qty = opt_int(c.get("quantity")) or 0
            if qty > 0:
                out_cards[key] = out_cards.get(key, 0) + qty
        uuid = details.get("nrdb_uuid")
        decks.append(
            CobraDeck(
                tournament_id=tid,
                pid=pid,
                side=side,
                stage_visibility=vis,
                identity=CardRef(
                    nrdb_card_id=opt_slug(details.get("identity_nrdb_card_id")),
                    nrdb_printing_id=opt_printing(details.get("identity_nrdb_printing_id")),
                ),
                nrdb_uuid=strict_uuid_or_int(str(uuid)) if uuid else None,
                cards=[
                    CobraDeckCard(nrdb_card_id=k[0], nrdb_printing_id=k[1], qty=v)
                    for k, v in sorted(out_cards.items(), key=lambda kv: (kv[0][0] or "", kv[0][1] or ""))
                ],
            ).hashed()
        )
    return decks


def parse_catalog(kind: str, items: list[dict[str, Any]], q: IngestQuality) -> CobraCatalog:
    out = []
    for it in items:
        a = attributes(it)
        q.check_drift(f"cobra.{kind}", a.keys(), CATALOG_ATTRS[kind])
        extra = None
        if kind == "deckbuilding_restrictions":
            extra = f"{a.get('play_format_id') or ''}|{a.get('date_start') or ''}"
        out.append(NamedRef(id=str(a["id"])[:80], name=str(a.get("name") or "")[:120], extra=extra))
    return CobraCatalog(kind=kind, items=sorted(out, key=lambda r: r.id)).hashed()


def parse_players_api(items: list[dict[str, Any]], q: IngestQuality) -> list[CobraPlayer]:
    """Scrubs the JSON:API players resource (kept for reference; ingest uses the NRTM export)."""
    out = []
    for it in items:
        a = attributes(it)
        q.check_drift("cobra.player.attributes", a.keys(), PLAYER_ATTRS)
        out.append(CobraPlayer(pid=strict_int(a.get("id")), active=as_bool(a.get("active"))))
    return out


# ---------------- fetchers ----------------


def fetch_catalog(
    http: PoliteHttp, kind: str, q: IngestQuality, *, etag: str | None = None, size: int = 250
) -> tuple[CobraCatalog, str | None] | None:
    """Returns None when the first page is unchanged (304)."""
    first = http.get(
        url(BASE, f"{API}/{kind}", {"page[number]": 1, "page[size]": size}),
        etag=etag,
        accept="application/vnd.api+json, application/json",
    )
    if first.not_modified:
        return None
    if first.status != 200:
        raise NotFound(f"status {first.status}")
    doc = first.json()
    if not isinstance(doc, dict) or not isinstance(doc.get("data"), list):
        raise ParseError("not a JSON:API document")
    items: list[dict[str, Any]] = list(doc["data"])
    if len(items) >= size:
        for n, page in enumerate(jsonapi_pages(http, BASE, f"{API}/{kind}", size=size)):
            if n:
                items.extend(page)
    return parse_catalog(kind, items, q), first.etag


def fetch_players_api(http: PoliteHttp, tid: int, q: IngestQuality, size: int = 50) -> list[CobraPlayer]:
    items: list[dict[str, Any]] = []
    for page in jsonapi_pages(http, BASE, f"{API}/tournaments/{strict_int(tid)}/players", size=size):
        items.extend(page)
    return parse_players_api(items, q)


def parse_show(doc: object, q: IngestQuality, fetched_at: str) -> CobraTournament:
    if not isinstance(doc, dict) or not isinstance(doc.get("data"), dict):
        raise ParseError("not a JSON:API document")
    return parse_index_item(doc["data"], q, fetched_at)[0]
