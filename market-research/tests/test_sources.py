"""Source helpers and the ABR parser: strict ID and value parsing, JSON:API paging, lenient events."""

from __future__ import annotations

import json
from urllib.parse import parse_qs, urlsplit

import pytest

from market_research.http import HttpResult
from market_research.scrub import IngestQuality
from market_research.sources import abr
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
    opt_title,
    parse_date,
    strict_int,
    strict_uuid_or_int,
    url,
)

UUID = "4b2c9e1a-77d0-4c1b-9a51-2f0d3c6e8a10"


def test_strict_ids_accept_only_the_exact_shape():
    assert strict_int("42") == 42 and strict_int(7) == 7
    assert strict_uuid_or_int("123") == "123"
    assert strict_uuid_or_int(UUID.upper()) == UUID
    # A trailing newline once slipped through: `match` lets `$` match before it.
    for bad in ("", "-1", "1e3", "1234567890", " 1", "1\n", "None", "True", "1.0"):
        with pytest.raises(ParseError):
            strict_int(bad)
    for bad in ("12a", UUID + "\n", UUID[:-1], "../123", "1234567890"):
        with pytest.raises(ParseError):
            strict_uuid_or_int(bad)


def test_printing_and_card_ids():
    # Seen live on alwaysberunning.net: one event had winner_corp_identity "null" (a string).
    assert opt_printing("null") is None and opt_printing("") is None and opt_printing(None) is None
    assert opt_printing("34096") == "34096" and opt_printing(34096) == "34096"
    assert opt_slug("hedge_fund") == "hedge_fund" and opt_slug("") is None
    for bad in ("nul", "1234567", "30010\n"):
        with pytest.raises(ParseError):
            opt_printing(bad)
    for bad in ("Hedge Fund", "hedge-fund", "hedge_fund\n", "x" * 81):
        with pytest.raises(ParseError):
            opt_slug(bad)


def test_dates_accept_abr_and_iso_forms():
    assert parse_date("2026.09.05.") == "2026-09-05"
    assert parse_date("2026-09-05") == "2026-09-05"
    assert parse_date("2026-09-05T18:00:00.000Z") == "2026-09-05"
    # Seen live on Cobra: "20260-05-21". Impossible dates are a ParseError too, which callers skip
    # item by item; a bare ValueError from datetime.date used to escape them.
    for bad in ("20260-05-21", "2026-13-01", "2026-02-30", "05.09.2026", "", None):
        with pytest.raises(ParseError):
            parse_date(bad)


def test_numbers_and_flags():
    assert [opt_int(v) for v in (None, "", "7", "-3", 7, 2.9, True)] == [None, None, 7, -3, 7, 2, 1]
    for bad in ("7.5", "seven", " 7"):
        with pytest.raises(ParseError):
            opt_int(bad)
    assert [opt_float(v) for v in (None, "", "0.1234567", 3, "2")] == [None, None, 0.123457, 3.0, 2.0]
    with pytest.raises(ParseError):
        opt_float("most")
    assert [as_bool(v) for v in (True, 1, 0, 0.0, "1", "true", " Yes ", "no", "", None)] == [
        True,
        True,
        False,
        False,
        True,
        True,
        True,
        False,
        False,
        False,
    ]


def test_event_names_are_cleaned():
    assert opt_title("  Worlds\n2026\t Top Cut ") == "Worlds 2026 Top Cut"
    assert opt_title("Cup\x00\x1b[31m") == "Cup [31m"
    assert opt_title("x" * 200) == "x" * 120
    assert opt_title("   ") is None and opt_title(None) is None


def test_urls_sort_their_parameters():
    assert url("https://h", "/p") == "https://h/p"
    assert url("https://h", "/p", {"b": 2, "a": "x y"}) == "https://h/p?a=x+y&b=2"


def test_attributes_flatten_a_jsonapi_item():
    assert attributes({"id": "5", "attributes": {"name": "n"}}) == {"name": "n", "id": "5"}
    assert attributes({"id": "5", "attributes": {"id": 6}}) == {"id": 6}
    with pytest.raises(ParseError):
        attributes({"id": "5"})


class FakePages:
    """Answers JSON:API page requests from a list of pages; records the URLs asked for."""

    def __init__(self, pages: list[list[dict[str, int]]], status: int = 200, body: object = None) -> None:
        self.pages, self.status, self.body = pages, status, body
        self.urls: list[str] = []

    def get(self, u: str, **_: object) -> HttpResult:
        self.urls.append(u)
        n = int(parse_qs(urlsplit(u).query)["page[number]"][0])
        doc = (
            self.body
            if self.body is not None
            else {"data": self.pages[n - 1] if n <= len(self.pages) else []}
        )
        return HttpResult(url=u, status=self.status, body=json.dumps(doc).encode(), headers={})


def test_jsonapi_pages_reads_until_a_short_page():
    http = FakePages([[{"i": 1}, {"i": 2}], [{"i": 3}, {"i": 4}], [{"i": 5}]])
    pages = list(jsonapi_pages(http, "https://h", "/api", size=2, extra={"sort": "-id"}))  # type: ignore[arg-type]
    assert pages == [[{"i": 1}, {"i": 2}], [{"i": 3}, {"i": 4}], [{"i": 5}]]
    assert http.urls == [f"https://h/api?page%5Bnumber%5D={n}&page%5Bsize%5D=2&sort=-id" for n in (1, 2, 3)]
    # A last page that happens to be full costs one more request, which comes back empty.
    http = FakePages([[{"i": 1}, {"i": 2}]])
    assert list(jsonapi_pages(http, "https://h", "/api", size=2)) == [[{"i": 1}, {"i": 2}], []]  # type: ignore[arg-type]


def test_jsonapi_pages_refuses_errors_and_other_documents():
    with pytest.raises(NotFound):
        list(jsonapi_pages(FakePages([], status=404), "https://h", "/api", size=2))  # type: ignore[arg-type]
    with pytest.raises(ParseError):
        list(jsonapi_pages(FakePages([], body={"data": {}}), "https://h", "/api", size=2))  # type: ignore[arg-type]


EVENT = {
    "id": 1,
    "date": "2026.09.05.",
    "format": "Standard",
    "approved": 1,
    "concluded": True,
    "players_count": "24",
    "type": "store championship",
}


def test_abr_event_is_parsed_leniently():
    q = IngestQuality()
    ev = abr.parse_event(dict(EVENT, end_date="2026.09.06.", location_country="Poland"), q, "t")
    assert (ev.date, ev.end_date, ev.format, ev.players_count, ev.type_id) == (
        "2026-09-05",
        "2026-09-06",
        "standard",
        24,
        "store championship",
    )
    assert ev.country == "Poland" and ev.record_hash.startswith("sha256:")
    # An unreadable or not-later end date is dropped, not the event.
    assert abr.parse_event(dict(EVENT, end_date="soon"), q, "t").end_date is None
    assert abr.parse_event(dict(EVENT, end_date="2026.09.31."), q, "t").end_date is None
    assert abr.parse_event(dict(EVENT, end_date="2026.09.05."), q, "t").end_date is None
    # A country that isn't a plain name is dropped.
    for country in ("Poland\n", "<b>PL</b>", "P"):
        assert abr.parse_event(dict(EVENT, location_country=country), q, "t").country is None
    assert abr.parse_event(dict(EVENT, type_id=5, type="x"), q, "t").type_id == "5"
    assert not q.drift
    with pytest.raises(ParseError):
        abr.parse_event(["not", "an", "object"], q, "t")  # type: ignore[arg-type]
    with pytest.raises(ParseError):
        abr.parse_events({"data": []}, q, "t")


def test_abr_entries_keep_one_entry_per_swiss_rank():
    q = IngestQuality()
    raw = [
        {"rank_swiss": 2, "rank_top": None, "user_id": 0, "corp_deck_identity_id": "30010"},
        {
            "rank_swiss": 1,
            "rank_top": 1,
            "user_id": 77,
            "runner_deck_url": "https://netrunnerdb.com/en/decklist/98588/x",
        },
        {"rank_swiss": 1, "user_id": 78},  # a second row for the same rank
        {"rank_swiss": None, "user_id": 79},  # no rank: not an entry
        {"rank_swiss": 3, "user_id": "0", "corp_deck_url": f"https://netrunnerdb.com/en/deck/view/{UUID}"},
        {"rank_swiss": 4, "corp_deck_url": "https://example.com/deck/1"},
    ]
    rec = abr.parse_entries(9, raw, q)
    assert [e.swiss_rank for e in rec.entries] == [1, 2, 3, 4]
    one, two, three, four = rec.entries
    assert one.claimed and one.cut_rank == 1 and one.runner.deck_ref is not None
    assert one.runner.deck_ref.kind == "decklist" and one.runner.deck_ref.id == "98588"
    assert not two.claimed and two.corp.identity == "30010" and two.cut_rank is None
    assert three.claimed and three.corp.deck_ref is not None and three.corp.deck_ref.kind == "deck"
    # A claimed deck URL off the allowlist still marks the entry claimed, but is not kept.
    assert four.claimed and four.corp.deck_ref is None and q.rejected_refs == 1
    for bad in ({"rank_swiss": 1}, [["rank_swiss", 1]]):
        with pytest.raises(ParseError):
            abr.parse_entries(9, bad, q)
