"""Scrubber: records match the expected scrubbed records, and no canary value survives anywhere."""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest

from helpers import CANARY, EXPECTED, HTTP, all_files, assert_no_canary, make_env
from market_research.ingest import Ingestor
from market_research.records import AbrTournament, CobraDeck, NrdbDecklist, Record
from market_research.scrub import IngestQuality
from market_research.sources import abr, cobra, nrdb

UPDATE = os.environ.get("MR_UPDATE_GOLDEN") == "1"


def test_fixtures_contain_canaries():
    # Sanity: the raw fixtures really carry the personal-data canaries the scrubber must drop.
    raw = b"".join(p.read_bytes() for p in all_files(HTTP))
    for c in (
        "PII_CANARY_NAME_",
        "PII_CANARY_PRONOUNS",
        "PII_CANARY_DECKNAME_",
        "PII_CANARY_USER_1234",
        "PII_CANARY_ADDRESS",
        "PII_CANARY_CONTACT",
        "PII_CANARY_DESCRIPTION",
        "PII_CANARY_TOURNAMENT",
    ):
        assert c.encode() in raw, c


@pytest.fixture(scope="module")
def ingested(tmp_path_factory):
    from conftest import NOW
    from market_research.clock import FakeClock

    root = tmp_path_factory.mktemp("scrub")
    env = make_env(root, FakeClock(NOW))
    ing = Ingestor(env.settings, env.clock, env.http(), env.stores, parallel=False)
    ing.run()
    return env, ing


def test_source_records_match_expected(ingested):
    env, _ = ingested
    src = env.stores.source.root  # type: ignore[attr-defined]
    got = {p.relative_to(src).as_posix(): p for p in all_files(src) if ".meta" not in p.parts}
    exp_root = EXPECTED / "source"
    if UPDATE:
        shutil.rmtree(exp_root, ignore_errors=True)
        for rel, p in got.items():
            out = exp_root / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(json.dumps(json.loads(p.read_bytes()), indent=1, sort_keys=True) + "\n")
    expected = {p.relative_to(exp_root).as_posix(): p for p in all_files(exp_root)}
    assert sorted(got) == sorted(expected)
    for rel, p in got.items():
        assert json.loads(p.read_bytes()) == json.loads(expected[rel].read_bytes()), rel


def test_no_canary_in_records_state_or_logs(ingested):
    env, ing = ingested
    assert_no_canary(env.root, env.log.getvalue(), json.dumps(ing.quality.to_json()))


def test_drift_warning_names_the_field_only(ingested):
    env, ing = ingested
    assert ing.quality.drift == {"abr.tournament": {"stream_viewers"}}
    lines = [json.loads(line) for line in env.log.getvalue().splitlines() if "drift_warning" in line]
    assert lines and lines[0]["unknown_fields"] == ["stream_viewers"]
    assert "PII_CANARY_DRIFT_VALUE" not in env.log.getvalue()


def test_records_are_allowlisted():
    # Models forbid extra fields, so nothing unexpected can be stored.
    with pytest.raises(ValueError):
        NrdbDecklist(id="1", cards=[], name="x")  # type: ignore[call-arg]
    with pytest.raises(ValueError):
        AbrTournament(id=1, fetched_at="t", date="2026-01-01", title="x")  # type: ignore[call-arg]


def test_record_hash_ignores_fetch_time_and_dropped_fields():
    q = IngestQuality()
    ev = {
        "id": 9,
        "date": "2026.09.01.",
        "format": "standard",
        "approved": 1,
        "concluded": True,
        "players_count": 10,
        "title": "PII_CANARY_TOURNAMENT_A",
        "creator_name": "PII_CANARY_NAME_A",
    }
    a = abr.parse_event(ev, q, "2026-09-01T00:00:00Z")
    b = abr.parse_event(
        dict(ev, title="PII_CANARY_TOURNAMENT_B", creator_name="PII_CANARY_NAME_B"), q, "2026-09-27T00:00:00Z"
    )
    assert a.record_hash == b.record_hash
    assert a.record_hash.startswith("sha256:") and len(a.record_hash) == 71
    assert CANARY not in json.dumps(a.model_dump(mode="json"))


def test_record_hash_is_sha256_of_sorted_canonical_json():
    import hashlib

    d = NrdbDecklist(id="5", cards=[]).hashed()
    body = {
        "cards": [],
        "id": "5",
        "identity_printing_id": None,
        "kind": "decklist",
        "published": None,
        "schema": "nrdb.decklist/1",
        "uuid": None,
    }
    exp = hashlib.sha256(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    assert d.record_hash == "sha256:" + exp


def test_cobra_deck_page_scrubbed():
    html = (
        HTTP / "tournaments.nullsignal.games__tournaments__4990__players__59690__view_decks.html"
    ).read_text()
    t = cobra.CobraTournament.model_validate(
        json.loads((EXPECTED / "source/cobra/tournament/4990.json").read_text())
    )
    decks = cobra.parse_view_decks(html, 4990, 59690, t, IngestQuality())
    assert {d.side for d in decks} == {"corp", "runner"}
    for d in decks:
        assert isinstance(d, CobraDeck)
        blob = json.dumps(d.model_dump(mode="json"))
        assert CANARY not in blob and "title" not in blob


def test_off_allowlist_deck_url_is_dropped():
    q = IngestQuality()
    assert abr.parse_deck_ref("https://evil.example/en/decklist/12345/x", q) is None
    assert abr.parse_deck_ref("https://netrunnerdb.com.evil.example/en/decklist/1/x", q) is None
    assert abr.parse_deck_ref("https://netrunnerdb.com/en/decklist/1/x?next=https://evil", q) is None
    assert abr.parse_deck_ref("javascript:alert(1)", q) is None
    assert q.rejected_refs == 4
    assert abr.parse_deck_ref("https://netrunnerdb.com/en/decklist/98588/some-slug", q).id == "98588"  # type: ignore[union-attr]
    ref = abr.parse_deck_ref("https://netrunnerdb.com/en/deck/view/4b2c9e1a-77d0-4c1b-9a51-2f0d3c6e8a10", q)
    assert ref is not None and ref.kind == "deck"


def test_nrdb_decklist_drops_names_and_users():
    raw = json.loads(
        (HTTP / "netrunnerdb.com__api__2.0__public__decklists__by_date__2026-09-20.json").read_text()
    )
    rec = nrdb.parse_by_date(__import__("datetime").date(2026, 9, 20), raw, IngestQuality())
    blob = json.dumps(rec.model_dump(mode="json"))
    assert rec.decklists and CANARY not in blob


def test_every_stored_record_is_a_known_schema(ingested):
    env, _ = ingested
    for info in env.stores.source.list():
        obj = env.stores.source.get_json(info.key)
        assert obj["schema"] in {
            "cobra.tournament/1",
            "cobra.deck/1",
            "cobra.catalog/1",
            "abr.tournament/1",
            "abr.entries/1",
            "nrdb.decklist/1",
            "nrdb.by_date/1",
            "nrdb.catalog/1",
        }, info.key


def _unused(r: Record) -> None:  # keeps the import used for type checkers
    del r


def test_expected_dir_exists():
    assert Path(EXPECTED / "source").is_dir()
