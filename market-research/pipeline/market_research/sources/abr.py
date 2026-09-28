"""AlwaysBeRunning (alwaysberunning.net) public API. Please link back to alwaysberunning.net."""

from __future__ import annotations

import re
from datetime import date
from typing import Any

from market_research.config import ABR_HOST
from market_research.records import AbrEntries, AbrEntry, AbrSide, AbrTournament, DeckRef
from market_research.scrub import IngestQuality
from market_research.sources.common import (
    ParseError,
    as_bool,
    opt_int,
    opt_printing,
    parse_date,
    strict_int,
    url,
)

BASE = f"https://{ABR_HOST}"
MAX_PAGE = 200  # the API docs warn not to exceed 500; we never ask for more than 200

EVENT_KEYS = frozenset({
    "id", "title", "contact", "approved", "registration_count", "photos", "url", "link_facebook",
    "creator_id", "creator_name", "creator_supporter", "creator_class", "location", "location_address",
    "location_store", "location_place_id", "location_lat", "location_lng", "location_country",
    "location_state", "date", "type", "type_id", "format", "mwl", "cardpool", "concluded",
    "players_count", "top_count", "claim_count", "claim_conflict", "matchdata", "videos",
    "winner_runner_identity", "winner_corp_identity", "end_date", "recurring_day", "description",
})  # fmt: skip
ENTRY_KEYS = frozenset({
    "user_id", "user_name", "user_import_name", "rank_swiss", "rank_top",
    "runner_deck_title", "runner_deck_identity_id", "runner_deck_url", "runner_deck_identity_title",
    "runner_deck_identity_faction", "corp_deck_title", "corp_deck_identity_id", "corp_deck_url",
    "corp_deck_identity_title", "corp_deck_identity_faction",
})  # fmt: skip

_ID = r"(\d{1,9}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"
DECKLIST_URL = re.compile(rf"^https://(?:www\.)?netrunnerdb\.com/[a-z]{{2}}/decklist/{_ID}(?:/[^?#\s]*)?$")
DECK_URL = re.compile(rf"^https://(?:www\.)?netrunnerdb\.com/[a-z]{{2}}/deck/view/{_ID}(?:/[^?#\s]*)?$")


def abr_date(d: date) -> str:
    return d.strftime("%Y.%m.%d.")


def list_url(start: date, end: date | None = None) -> str:
    params: dict[str, object] = {"concluded": 1, "approved": 1, "start": abr_date(start), "desc": 1}
    if end is not None:
        params["end"] = abr_date(end)
    return url(BASE, "/api/tournaments", params)


def results_url(offset: int, limit: int = MAX_PAGE) -> str:
    return url(BASE, "/api/tournaments/results", {"limit": min(limit, MAX_PAGE), "offset": max(offset, 0)})


def entries_url(tid: int) -> str:
    return url(BASE, "/api/entries", {"id": strict_int(tid)})


def parse_deck_ref(value: object, q: IngestQuality) -> DeckRef | None:
    """Only the ID is taken from a deck URL, with a strict regex. The URL itself is never fetched."""
    if value in (None, ""):
        return None
    s = str(value).strip()
    m = DECKLIST_URL.match(s)
    if m:
        return DeckRef(kind="decklist", id=m[1].lower())
    m = DECK_URL.match(s)
    if m:
        return DeckRef(kind="deck", id=m[1].lower())
    q.rejected_ref()
    return None


def parse_event(ev: dict[str, Any], q: IngestQuality, fetched_at: str) -> AbrTournament:
    if not isinstance(ev, dict):
        raise ParseError("event is not an object")
    q.check_drift("abr.tournament", ev.keys(), EVENT_KEYS)
    type_value = ev.get("type_id", ev.get("type"))
    country = ev.get("location_country")
    start = parse_date(ev.get("date"))
    try:
        end: str | None = parse_date(ev.get("end_date")) if ev.get("end_date") else None
    except ParseError:
        end = None  # optional; a bad end date must not lose the event
    return AbrTournament(
        id=strict_int(ev.get("id")),
        fetched_at=fetched_at,
        date=start,
        end_date=end if end is not None and end > start else None,
        type_id=str(type_value)[:60] if type_value not in (None, "") else None,
        format=str(ev.get("format") or "").strip().lower()[:40] or None,
        cardpool=str(ev.get("cardpool") or "")[:80] or None,
        approved=opt_int(ev.get("approved")),
        concluded=as_bool(ev.get("concluded")),
        players_count=opt_int(ev.get("players_count")) or 0,
        top_count=opt_int(ev.get("top_count")) or 0,
        claim_count=opt_int(ev.get("claim_count")) or 0,
        claim_conflict=as_bool(ev.get("claim_conflict")),
        matchdata=as_bool(ev.get("matchdata")),
        country=str(country)[:60] if country and re.match(r"^[A-Za-z .'-]{2,60}$", str(country)) else None,
        winner_corp_identity=opt_printing(ev.get("winner_corp_identity")),
        winner_runner_identity=opt_printing(ev.get("winner_runner_identity")),
    ).hashed()


def parse_events(payload: object, q: IngestQuality, fetched_at: str) -> list[AbrTournament]:
    if not isinstance(payload, list):
        raise ParseError("tournament list is not an array")
    return [parse_event(ev, q, fetched_at) for ev in payload]


def parse_entries(tid: int, payload: object, q: IngestQuality) -> AbrEntries:
    if not isinstance(payload, list):
        raise ParseError("entries are not an array")
    entries = []
    seen: set[int] = set()
    for e in payload:
        if not isinstance(e, dict):
            raise ParseError("entry is not an object")
        q.check_drift("abr.entry", e.keys(), ENTRY_KEYS)
        rank = opt_int(e.get("rank_swiss"))
        if rank is None or rank in seen:
            continue  # the entry key within a tournament is rank_swiss
        seen.add(rank)
        corp_ref = parse_deck_ref(e.get("corp_deck_url"), q)
        runner_ref = parse_deck_ref(e.get("runner_deck_url"), q)
        user = e.get("user_id")
        claimed = bool(user not in (None, 0, "0", "")) or bool(
            e.get("corp_deck_url") or e.get("runner_deck_url")
        )
        entries.append(
            AbrEntry(
                swiss_rank=rank,
                cut_rank=opt_int(e.get("rank_top")),
                claimed=claimed,
                corp=AbrSide(identity=opt_printing(e.get("corp_deck_identity_id")), deck_ref=corp_ref),
                runner=AbrSide(identity=opt_printing(e.get("runner_deck_identity_id")), deck_ref=runner_ref),
            )
        )
    return AbrEntries(tournament_id=tid, entries=sorted(entries, key=lambda x: x.swiss_rank)).hashed()
