"""Decklists imported from a file (imports.py, runner.import_decks and the normalize precedence)."""

from __future__ import annotations

import csv
import io
import json
import shutil

import httpx
import pytest
from typer.testing import CliRunner

from helpers import CANARY, EXPECTED, HTTP, all_files, assert_no_canary, make_env
from market_research import imports
from market_research.cli import app
from market_research.config import load_settings
from market_research.imports import (
    DeckImportError,
    build_import,
    import_key,
    load_catalog,
    match_players,
    name_key,
    read_rows,
)
from market_research.ingest import Ingestor
from market_research.normalize import Normalizer
from market_research.records import CobraTournament, ImportedDecks, dump
from market_research.runner import EXIT_FAILURE, EXIT_OK, Runtime, import_decks
from market_research.storage import LocalObjectStore

TID = 4990
NRTM_URL = f"https://tournaments.nullsignal.games/tournaments/{TID}.json"
SOURCE = EXPECTED / "source"
HEADER = "name,identity,card,card_counts,card_count\r\n"


# ------------------------------------------------------------------ shared read-only inputs


@pytest.fixture(scope="module")
def catalog():
    return load_catalog(LocalObjectStore(SOURCE))


@pytest.fixture(scope="module")
def tournament() -> CobraTournament:
    return CobraTournament.model_validate_json((SOURCE / f"cobra/tournament/{TID}.json").read_bytes())


@pytest.fixture(scope="module")
def nrtm_players() -> list[dict]:
    """The fixture export's players: their names are PII canaries."""
    return json.loads((HTTP / f"tournaments.nullsignal.games__tournaments__{TID}.json.json").read_bytes())[
        "players"
    ]


@pytest.fixture(scope="module")
def cobra_decks() -> dict[tuple[int, str], dict]:
    out = {}
    for p in (SOURCE / f"cobra/deck/{TID}").glob("*.json"):
        d = json.loads(p.read_bytes())
        out[(d["pid"], d["side"])] = d
    return out


def csv_text(cobra_decks, nrtm_players, catalog, *, only: set[int] | None = None) -> str:
    """The fixture's Cobra decks written as a long-format file, the way NSG sent Worlds 2026."""
    names = {p["id"]: p["name"] for p in nrtm_players}
    lines = [HEADER]
    for (pid, _side), d in sorted(cobra_decks.items()):
        if only is not None and pid not in only:
            continue
        ident = catalog.title(d["identity"]["nrdb_card_id"])
        for c in d["cards"]:
            lines.append(_line(names[pid], ident, catalog.title(c["nrdb_card_id"]), str(c["qty"])))
    return "".join(lines)


def _line(*cells: str) -> str:
    buf = io.StringIO()
    name, ident, card, qty = cells
    csv.writer(buf, lineterminator="\r\n").writerow([name, ident, card, "", qty])
    return buf.getvalue()


def rows_of(text: str):
    return read_rows(text.encode("utf-8"))


def edit_row(text: str, line: int, **cells: str) -> str:
    """Replaces cells of the row on 1-based file line `line`."""
    out = text.splitlines(keepends=True)
    row = next(csv.reader([out[line - 1]]))
    cols = {"name": 0, "identity": 1, "card": 2, "card_count": 4}
    for k, v in cells.items():
        row[cols[k]] = v
    buf = io.StringIO()
    csv.writer(buf, lineterminator="\r\n").writerow(row)
    out[line - 1] = buf.getvalue()
    return "".join(out)


@pytest.fixture(scope="module")
def good(cobra_decks, nrtm_players, catalog) -> str:
    return csv_text(cobra_decks, nrtm_players, catalog)


def build(text, tournament, nrtm_players, catalog):
    return build_import(rows_of(text), tournament, nrtm_players, catalog, "nsg", "2026-10-09T00:00:00Z")


# ------------------------------------------------------------------ reading the file


def test_read_rows_keeps_the_file_line_of_each_row():
    rows = rows_of(HEADER + "a,X: Y,Card,,3\r\nb,X: Y,Card,,1\r\n")
    assert [(r.line, r.name, r.qty) for r in rows] == [(2, "a", "3"), (3, "b", "1")]


def test_read_rows_gives_the_line_a_multiline_row_starts_on():
    rows = rows_of(HEADER + 'a,X,"Two\r\nLines",,1\r\nb,X,C,,1\r\n')
    assert [(r.line, r.card) for r in rows] == [(2, "Two\r\nLines"), (4, "C")]


def test_read_rows_refuses_a_file_csv_cannot_read():
    # A cell over the csv module's field size limit (131,072 characters).
    with pytest.raises(DeckImportError, match="line 2"):
        rows_of(HEADER + "a,X," + "C" * 200_000 + ",,1\r\n")


def test_read_rows_accepts_a_byte_order_mark():
    assert rows_of("﻿" + HEADER + "a,X,C,,1\n")[0].name == "a"


def test_read_rows_needs_every_column():
    with pytest.raises(DeckImportError, match="card_count"):
        rows_of("name,identity,card\na,X,C\n")


def test_read_rows_refuses_a_file_that_is_not_utf8():
    with pytest.raises(DeckImportError, match="UTF-8"):
        read_rows((HEADER + "Zoë,X,C,,1\n").encode("latin-1"))


def test_read_rows_refuses_an_oversized_file(monkeypatch):
    data = (HEADER + "a,X,C,,1\n").encode()
    monkeypatch.setattr(imports, "MAX_FILE_BYTES", len(data))
    assert read_rows(data)  # exactly at the limit
    monkeypatch.setattr(imports, "MAX_FILE_BYTES", len(data) - 1)
    with pytest.raises(DeckImportError, match="over"):
        read_rows(data)


# ------------------------------------------------------------------ matching names


PLAYERS = [{"id": 1, "name": "Zoë Smith"}, {"id": 2, "name": "zoe-smith"}, {"id": 3, "name": "Benson "}]


def test_name_key_ignores_case_accents_width_and_punctuation():
    assert name_key("Zoë  Smith") == name_key("ZOE-SMITH") == name_key("Ｚｏｅ’Smith") == "zoesmith"


def test_exact_name_wins_over_a_loose_one():
    assert match_players(["Zoë Smith", "zoe-smith"], PLAYERS) == {"Zoë Smith": 1, "zoe-smith": 2}


def test_surrounding_spaces_do_not_matter():
    assert match_players(["Benson", " Benson "], PLAYERS) == {"Benson": 3, " Benson ": 3}


def test_a_loose_name_two_players_share_matches_neither():
    assert match_players(["ZOE SMITH"], PLAYERS) == {"ZOE SMITH": None}


def test_a_loose_name_one_player_has_matches():
    assert match_players(["BENSON"], PLAYERS) == {"BENSON": 3}


def test_an_empty_name_matches_nobody():
    assert match_players(["", "  ", "--"], [*PLAYERS, {"id": 4, "name": ""}]) == {
        "": None,
        "  ": None,
        "--": None,
    }


def test_players_without_a_numeric_id_are_ignored():
    assert match_players(["a", "b"], [{"id": "7", "name": "a"}, {"id": True, "name": "b"}]) == {
        "a": None,
        "b": None,
    }


# ------------------------------------------------------------------ building the record


def test_every_deck_is_imported_with_its_cobra_player(good, tournament, nrtm_players, catalog, cobra_decks):
    rec, rep = build(good, tournament, nrtm_players, catalog)
    assert rep.decks_imported == rep.decks_in_file == 32 and not rep.rejected
    assert rep.players_in_file == 16 and rep.cobra_without_deck == []
    for d in rec.decks:
        cd = cobra_decks[(d.pid, d.side)]
        assert d.identity == cd["identity"]["nrdb_card_id"]
        assert {c.card_id: c.qty for c in d.cards} == {c["nrdb_card_id"]: c["qty"] for c in cd["cards"]}


def test_the_record_keeps_no_names(good, tournament, nrtm_players, catalog):
    assert CANARY in good
    rec, rep = build(good, tournament, nrtm_players, catalog)
    assert CANARY not in json.dumps(dump(rec)) + json.dumps(rep.to_json())


def test_players_missing_from_the_file_are_listed_by_swiss_rank(
    cobra_decks, nrtm_players, catalog, tournament
):
    first = tournament.players[0]
    text = csv_text(cobra_decks, nrtm_players, catalog, only={p.pid for p in tournament.players[1:]})
    _, rep = build(text, tournament, nrtm_players, catalog)
    assert rep.cobra_without_deck == [first.swiss_rank]


def _rejects(text, tournament, nrtm_players, catalog, reason, n=1):
    rec, rep = build(text, tournament, nrtm_players, catalog)
    assert rep.rejected == {reason: n}
    assert rep.decks_imported == 32 - n == len(rec.decks)  # the other decks are still imported
    return rec, rep


def test_an_unknown_card_leaves_out_only_its_deck(good, tournament, nrtm_players, catalog):
    _, rep = _rejects(
        edit_row(good, 5, card="Not A Real Card"), tournament, nrtm_players, catalog, "unknown_card"
    )
    assert rep.lines == {"unknown_card": [5]}


def test_an_unknown_identity_leaves_out_only_its_deck(good, tournament, nrtm_players, catalog):
    text = good
    lines = good.splitlines()
    ident = next(csv.reader([lines[1]]))[1]
    owner = next(csv.reader([lines[1]]))[0]
    for i, line in enumerate(lines[1:], start=2):
        r = next(csv.reader([line]))
        if r[0] == owner and r[1] == ident:
            text = edit_row(text, i, identity="Nobody: Never Printed")
    _, rep = _rejects(text, tournament, nrtm_players, catalog, "unknown_identity")
    assert rep.lines == {"unknown_identity": [2]}


def test_a_card_title_as_identity_is_an_unknown_identity(good, tournament, nrtm_players, catalog):
    lines = good.splitlines()
    owner, ident = next(csv.reader([lines[1]]))[:2]
    text = good
    for i, line in enumerate(lines[1:], start=2):
        if next(csv.reader([line]))[:2] == [owner, ident]:
            text = edit_row(text, i, identity="Hedge Fund")
    _rejects(text, tournament, nrtm_players, catalog, "unknown_identity")


@pytest.mark.parametrize(
    "qty",
    [
        "0",  # no copies
        "-1",  # negative
        "",  # empty
        "x",  # not a number
        "1.5",  # not whole
        "100",  # more than two digits
        "٣",  # an Arabic-Indic digit (`\d` would accept it)
        "3\n",  # a trailing newline (`$` would accept it)
    ],
)
def test_a_bad_count_leaves_out_only_its_deck(good, tournament, nrtm_players, catalog, qty):
    _, rep = _rejects(edit_row(good, 5, card_count=qty), tournament, nrtm_players, catalog, "bad_count")
    assert rep.lines == {"bad_count": [5]}


def test_an_identity_that_differs_from_cobra_is_left_out(
    good, tournament, nrtm_players, catalog, cobra_decks
):
    # The first player's corp identity, swapped for another corp identity of the catalog.
    lines = good.splitlines()
    owner, ident = next(csv.reader([lines[1]]))[:2]
    other = next(
        c.title
        for c in catalog.cards.values()
        if c.card_type_id == "corp_identity" and c.title != ident and c.card_pool_ids
    )
    text = good
    for i, line in enumerate(lines[1:], start=2):
        if next(csv.reader([line]))[:2] == [owner, ident]:
            text = edit_row(text, i, identity=other)
    _rejects(text, tournament, nrtm_players, catalog, "identity_differs_from_cobra")


def test_an_unknown_player_leaves_out_both_decks(good, tournament, nrtm_players, catalog):
    owner = next(csv.reader([good.splitlines()[1]]))[0]
    text = good.replace(owner + ",", "Somebody Else,")
    _, rep = _rejects(text, tournament, nrtm_players, catalog, "player_not_found", n=2)
    assert rep.lines == {"player_not_found": [2]}


def test_the_same_identity_twice_under_names_matching_one_player_is_rejected(
    good, tournament, nrtm_players, catalog
):
    # "PII_CANARY_NAME_15" and "pii canary name 15" are two players in the file but one in Cobra.
    lines = good.splitlines()
    owner, corp = next(csv.reader([lines[1]]))[:2]
    copy = [ln for ln in lines[1:] if next(csv.reader([ln]))[:2] == [owner, corp]]
    alias = owner.lower().replace("_", " ")
    extra = "".join(ln.replace(owner, alias, 1) + "\r\n" for ln in copy)
    rec, rep = build(good + extra, tournament, nrtm_players, catalog)
    assert rep.rejected == {"two_decks_for_one_side": 1}
    assert rep.lines == {"two_decks_for_one_side": [len(lines) + 1]}
    assert len(rec.decks) == 32


def test_curly_quotes_and_accents_in_titles_resolve(catalog):
    assert catalog.card_of_title("Hedge Fund") == catalog.card_of_title("HEDGE  FUND") == "hedge_fund"
    titled = next(c for c in catalog.cards.values() if "'" in c.title)
    assert catalog.card_of_title(titled.title.replace("'", "’")) == titled.id


def test_a_title_two_cards_share_names_neither():
    from market_research.catalog import Catalog
    from market_research.records import CatCard, NrdbCatalog

    def card(i: str, t: str) -> CatCard:
        return CatCard(id=i, title=t, side_id="corp", card_type_id="asset", faction_id="neutral_corp")

    cat = Catalog(
        {"cards": NrdbCatalog(kind="cards", cards=[card("a", "Café"), card("b", "Cafe"), card("c", "Tea")])}
    )
    assert cat.card_of_title("Cafe") is None
    assert cat.card_of_title("Tea") == "c"


# ------------------------------------------------------------------ normalize


def _sources_with(rec: ImportedDecks) -> dict[str, bytes]:
    src = {p.relative_to(SOURCE).as_posix(): p.read_bytes() for p in all_files(SOURCE)}
    src[import_key(rec.cobra_id)] = json.dumps(dump(rec)).encode()
    return src


def _decks(src: dict[str, bytes]) -> dict[tuple[int, str], dict]:
    out = Normalizer(src, load_settings({})).run()
    return {(d["entry_no"], d["side"]): d for d in out.rows["deck"] if d["tid"] == f"c{TID}"}


def test_an_imported_deck_wins_over_cobra_and_is_compared_with_it(good, tournament, nrtm_players, catalog):
    rec, _ = build(good, tournament, nrtm_players, catalog)
    decks = _decks(_sources_with(rec))
    assert {d["source"] for d in decks.values()} == {"import"}
    assert {d["comparison"] for d in decks.values()} == {"match"}
    rank1 = tournament.players[0]
    assert decks[(rank1.swiss_rank, "corp")]["source_ref"] == f"import:nsg:{TID}:{rank1.pid}"


def test_an_imported_deck_that_differs_from_cobra_is_a_mismatch_and_counts(
    good, tournament, nrtm_players, catalog
):
    rec, _ = build(edit_row(good, 2, card_count="1"), tournament, nrtm_players, catalog)
    d = rec.decks[0]
    decks = _decks(_sources_with(rec))
    p = next(p for p in tournament.players if p.pid == d.pid)
    row = decks[(p.swiss_rank, d.side)]
    assert row["comparison"] == "mismatch" and row["source"] == "import"
    assert row["card_count"] == sum(c.qty for c in d.cards)


def test_an_imported_deck_alone_is_import_only(good, tournament, nrtm_players, catalog, cobra_decks):
    rec, _ = build(good, tournament, nrtm_players, catalog)
    src = _sources_with(rec)
    d = rec.decks[0]
    del src[f"cobra/deck/{TID}/{d.pid}-{d.side}.json"]
    p = next(p for p in tournament.players if p.pid == d.pid)
    decks = _decks(src)
    assert decks[(p.swiss_rank, d.side)]["comparison"] == "import_only"


# ------------------------------------------------------------------ the crawler leaves imports alone


def test_the_crawler_refuses_to_write_imported_data(tmp_path, clock):
    env = make_env(tmp_path, clock)
    ing = Ingestor(env.settings, env.clock, env.http(), env.stores, parallel=False)
    rec = ImportedDecks(cobra_id=TID, origin="nsg", imported_at="t", decks=[])
    with pytest.raises(ValueError, match="never writes imported data"):
        ing.write(import_key(TID), rec)
    assert not env.stores.source.exists(import_key(TID))


def test_a_run_and_a_reload_leave_an_import_untouched(
    tmp_path, clock, good, tournament, nrtm_players, catalog
):
    env = make_env(tmp_path, clock)
    rec, _ = build(good, tournament, nrtm_players, catalog)
    env.stores.source.put_json(import_key(TID), dump(rec))
    before = env.stores.source.get(import_key(TID))
    env.stores.source.puts.clear()
    ing = Ingestor(env.settings, env.clock, env.http(), env.stores, parallel=False)
    ing.run()
    doc = json.loads(env.routes.body(
        "https://tournaments.nullsignal.games/api/v1/public/tournaments?page[number]=1&page[size]=250&sort=-id"
    ))  # fmt: skip
    item = next(i for i in doc["data"] if i["id"] == str(TID))
    env.routes.override(
        f"https://tournaments.nullsignal.games/api/v1/public/tournaments/{TID}",
        httpx.Response(200, json={"data": item}),
    )
    Ingestor(env.settings, env.clock, env.http(), env.stores, parallel=False).reload(cobra_ids=[TID])
    assert env.stores.source.get(import_key(TID)) == before
    assert not [k for k in env.stores.source.puts if k.startswith("import/")]


# ------------------------------------------------------------------ runner.import_decks


@pytest.fixture
def rt(tmp_path, clock):
    """A runtime over a copy of the fixture source records and the fixture HTTP routes."""
    env = make_env(tmp_path, clock)
    shutil.copytree(SOURCE, tmp_path / "store" / "mr-source", dirs_exist_ok=True)
    from market_research.testing import FixtureTransport

    runtime = Runtime(
        env.settings, env.clock, env.stores, transport=FixtureTransport(env.routes), parallel=False
    )
    runtime.routes = env.routes  # type: ignore[attr-defined]
    runtime.log = env.log  # type: ignore[attr-defined]
    return runtime


def test_import_writes_the_record_and_publishes(rt, good, tmp_path):
    res = import_decks(rt, good.encode(), cobra_id=TID, origin="nsg")
    assert res.exit_code == EXIT_OK and res.decks_added == 32 and res.slices_published > 0
    rec = ImportedDecks.model_validate(rt.stores.source.get_json(import_key(TID)))
    assert rec.origin == "nsg" and len(rec.decks) == 32
    assert rt.stores.published.exists("manifest.json")
    assert_no_canary(tmp_path / "store", rt.log.getvalue())


def test_import_logs_its_report_without_names(rt, good):
    import_decks(rt, good.encode(), cobra_id=TID, origin="nsg", check=True)
    reports = [json.loads(ln) for ln in rt.log.getvalue().splitlines() if '"import_report"' in ln]
    assert len(reports) == 1 and reports[0]["decks_imported"] == 32
    assert CANARY not in rt.log.getvalue()


def test_check_only_reports(rt, good):
    res = import_decks(rt, good.encode(), cobra_id=TID, origin="nsg", check=True)
    assert res.exit_code == EXIT_OK
    assert not rt.stores.source.exists(import_key(TID))
    assert not rt.stores.published.exists("manifest.json")


def _fails_and_writes_nothing(rt, data: bytes, cobra_id: int = TID, error: str = "") -> None:
    res = import_decks(rt, data, cobra_id=cobra_id, origin="nsg")
    assert res.exit_code == EXIT_FAILURE
    assert not list(rt.stores.source.list("import/"))
    assert not rt.stores.published.exists("manifest.json")
    assert error in rt.log.getvalue()


def test_an_unknown_tournament_fails(rt, good):
    _fails_and_writes_nothing(rt, good.encode(), cobra_id=99999, error="tournament not stored")


def test_a_tournament_without_players_fails(rt, good):
    key = f"cobra/tournament/{TID}.json"
    t = rt.stores.source.get_json(key)
    rt.stores.source.put_json(key, dict(t, players=[]))
    _fails_and_writes_nothing(rt, good.encode(), error="no players")


def test_a_missing_catalog_fails(rt, good, tmp_path):
    (tmp_path / "store" / "mr-source" / "nrdb" / "catalog" / "cards.json").unlink()
    _fails_and_writes_nothing(rt, good.encode(), error="catalog not stored")


def test_a_bad_file_fails(rt):
    _fails_and_writes_nothing(rt, b"name,card\n", error="missing columns")


@pytest.mark.parametrize(
    ("response", "error"),
    [
        (httpx.Response(404), "status 404"),
        (httpx.Response(200, content=b"<html>"), "not fetched: JSONDecodeError"),
        (httpx.Response(200, json=["players"]), "status 200"),
        (httpx.Response(200, json={"players": "none"}), "status 200"),
        (httpx.Response(500), "not fetched: FetchFailed"),
    ],
)
def test_an_unusable_cobra_export_fails(rt, good, response, error):
    rt.routes.override(NRTM_URL, response)
    _fails_and_writes_nothing(rt, good.encode(), error=error)


def test_a_file_where_no_deck_matches_fails(rt, good):
    names = {
        p["name"]
        for p in json.loads(
            (HTTP / f"tournaments.nullsignal.games__tournaments__{TID}.json.json").read_bytes()
        )["players"]
    }
    text = good
    for n in names:
        text = text.replace(n + ",", "x" + n + "x,")
    _fails_and_writes_nothing(rt, text.encode(), error="no deck matched")


def test_importing_again_replaces_the_earlier_import(rt, good, tournament, monkeypatch):
    from market_research import runner

    # Normalizing and publishing are covered by test_import_writes_the_record_and_publishes.
    monkeypatch.setattr(runner, "do_normalize", lambda rt: None)
    monkeypatch.setattr(runner, "do_compute", lambda rt, res, **kw: None)
    keep = {p.pid for p in tournament.players[:2]}
    names = {
        p["id"]: p["name"]
        for p in json.loads(
            (HTTP / f"tournaments.nullsignal.games__tournaments__{TID}.json.json").read_bytes()
        )["players"]
    }
    assert import_decks(rt, good.encode(), cobra_id=TID, origin="nsg", check=False).exit_code == EXIT_OK
    lines = good.splitlines(keepends=True)
    smaller = lines[0] + "".join(
        ln for ln in lines[1:] if next(csv.reader([ln]))[0] in {names[p] for p in keep}
    )
    assert import_decks(rt, smaller.encode(), cobra_id=TID, origin="nsg2").exit_code == EXIT_OK
    rec = ImportedDecks.model_validate(rt.stores.source.get_json(import_key(TID)))
    assert rec.origin == "nsg2" and {d.pid for d in rec.decks} == keep


# ------------------------------------------------------------------ CLI


@pytest.mark.parametrize("origin", ["", "NSG", "n s g", "a" * 33, "nsg\n"])
def test_cli_refuses_a_bad_origin(tmp_path, origin):
    f = tmp_path / "d.csv"
    f.write_text(HEADER)
    r = CliRunner().invoke(app, ["import-decks", str(f), "--cobra", "1", "--origin", origin])
    assert r.exit_code == 1 and "--origin" in r.output


def test_cli_accepts_the_longest_origin(tmp_path, monkeypatch):
    from market_research import cli

    seen = {}
    monkeypatch.setattr(cli, "_runtime", lambda *a, **k: None)
    monkeypatch.setattr(cli, "import_decks", lambda rt, data, **kw: seen.update(kw) or cli.RunResult())
    f = tmp_path / "d.csv"
    f.write_text(HEADER)
    r = CliRunner().invoke(app, ["import-decks", str(f), "--cobra", "1", "--origin", "a" * 32])
    assert r.exit_code == 0 and seen["origin"] == "a" * 32


def test_cli_refuses_a_missing_file(tmp_path):
    r = CliRunner().invoke(app, ["import-decks", str(tmp_path / "nope.csv"), "--cobra", "1"])
    assert r.exit_code == 1 and "cannot read" in r.output


def test_cli_needs_the_tournament():
    r = CliRunner().invoke(app, ["import-decks", "x.csv"])
    assert r.exit_code == 2  # Typer's usage error
