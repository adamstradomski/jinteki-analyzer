from __future__ import annotations

import json
import os
from datetime import date
from pathlib import Path

import pytest

from helpers import EXPECTED, all_files
from market_research.catalog import Catalog, title_key
from market_research.config import load_settings, tier_config
from market_research.normalize import Normalizer, _result, deck_id
from market_research.records import CobraPairing, CobraPlayer, CobraTournament, DeckVisibility

UPDATE = os.environ.get("MR_UPDATE_GOLDEN") == "1"


def _sources() -> dict[str, bytes]:
    """The source records a fixture ingest stores, read from tests/fixtures/expected/source (which
    test_scrub checks against the ingest). A fresh dict each call, for the caller to edit."""
    root = EXPECTED / "source"
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in all_files(root)}


def rows_json(rows):
    return [{k: (v.isoformat() if isinstance(v, date) else v) for k, v in r.items()} for r in rows]


def test_canonical_tables_match_expected(fixture_run):
    _, _, data, _ = fixture_run
    root = EXPECTED / "canonical"
    for table, rows in data.rows.items():
        p = root / f"{table}.jsonl"
        got = "\n".join(json.dumps(r, sort_keys=True) for r in rows_json(rows)) + "\n"
        if UPDATE:
            root.mkdir(parents=True, exist_ok=True)
            p.write_text(got)
        assert got == p.read_text(), table


def tourney(fmt: str, pairings: list[CobraPairing], n: int = 4) -> CobraTournament:
    return CobraTournament(
        id=1,
        fetched_at="t",
        date="2026-09-01",
        format_id=1,
        swiss_format=fmt,
        results_fetched=True,
        deck_visibility=DeckVisibility(swiss="public", cut="public"),
        players=[CobraPlayer(pid=100 + i, swiss_rank=i + 1) for i in range(n)],
        pairings=pairings,
    )


def test_bye_in_either_seat_is_not_unreported():
    # Seen live: Cobra byes with the player as p2 and p1 empty kept finished events "live" for
    # months, so their public decks were never fetched.
    from market_research.sources.cobra import has_unreported

    done = CobraPairing(
        stage=1, round=1, table=1, p1=100, p2=101, p1_side="corp", p1_corp_score=3, p2_runner_score=0
    )
    for bye in (
        CobraPairing(stage=1, round=1, table=2, p1=102, p2=None),
        CobraPairing(stage=1, round=1, table=2, p1=None, p2=102),
    ):
        assert not has_unreported(tourney("single_sided", [done, bye]))
    missing = CobraPairing(stage=1, round=2, table=1, p1=100, p2=102)
    assert has_unreported(tourney("single_sided", [done, missing]))


def test_event_with_a_missing_result_settles_after_two_weeks():
    from market_research.sources.cobra import is_live

    done = CobraPairing(
        stage=1, round=1, table=1, p1=100, p2=101, p1_side="corp", p1_corp_score=3, p2_runner_score=0
    )
    missing = CobraPairing(stage=2, round=1, table=1, p1=100, p2=101, elimination=True)
    t = tourney("single_sided", [done, missing])  # dated 2026-09-01
    assert is_live(t, date(2026, 9, 3))  # within 3 days: live regardless
    assert is_live(t, date(2026, 9, 10))  # a result is missing: still live
    assert not is_live(t, date(2026, 9, 16))  # 15 days on: settled, decks can be fetched
    assert not is_live(tourney("single_sided", [done]), date(2026, 9, 10))  # all reported


def games_of(t: CobraTournament) -> list[dict]:
    n = Normalizer({}, __import__("market_research.config", fromlist=["load_settings"]).load_settings({}))
    return list(n.games(t, {p.pid: p.swiss_rank for p in t.players}, "c1"))


def test_single_sided_swiss_games():
    t = tourney(
        "single_sided",
        [
            CobraPairing(
                stage=1, round=1, table=1, p1=100, p2=101, p1_side="corp", p1_corp_score=3, p2_runner_score=0
            ),
            CobraPairing(
                stage=1,
                round=1,
                table=2,
                p1=102,
                p2=103,
                p1_side="runner",
                p1_runner_score=3,
                p2_corp_score=0,
            ),
            CobraPairing(
                stage=1,
                round=2,
                table=1,
                p1=100,
                p2=102,
                p1_side="runner",
                p1_runner_score=1,
                p2_corp_score=1,
            ),
            CobraPairing(
                stage=1,
                round=2,
                table=2,
                p1=101,
                p2=103,
                p1_side="corp",
                p1_corp_score=1,
                p2_runner_score=1,
                intentional_draw=True,
            ),
            CobraPairing(stage=1, round=3, table=1, p1=100, p2=None, p1_side="corp"),  # bye
            CobraPairing(stage=1, round=3, table=2, p1=101, p2=102, p1_side="corp"),  # unreported
        ],
    )
    g = games_of(t)
    assert [
        (x["round"], x["table"], x["side"], x["corp_entry"], x["runner_entry"], x["result"]) for x in g
    ] == [
        (1, 1, "corp", 1, 2, "corp_win"),
        (1, 2, "runner", 4, 3, "runner_win"),
        (2, 1, "runner", 3, 1, "draw"),
        (2, 2, "corp", 2, 4, "intentional_draw"),
    ]


def test_double_sided_swiss_games():
    t = tourney(
        "double_sided",
        [
            CobraPairing(
                stage=1,
                round=1,
                table=1,
                p1=100,
                p2=101,
                p1_corp_score=3,
                p1_runner_score=0,
                p2_corp_score=3,
                p2_runner_score=0,
            ),
            CobraPairing(
                stage=1,
                round=1,
                table=2,
                p1=102,
                p2=103,
                p1_corp_score=1,
                p1_runner_score=3,
                p2_corp_score=0,
                p2_runner_score=1,
            ),
            CobraPairing(
                stage=1,
                round=2,
                table=1,
                p1=100,
                p2=102,
                p1_corp_score=1,
                p1_runner_score=1,
                p2_corp_score=1,
                p2_runner_score=1,
                intentional_draw=True,
            ),
            CobraPairing(
                stage=1,
                round=2,
                table=2,
                p1=101,
                p2=103,
                p1_corp_score=6,
                p1_runner_score=0,
                p2_corp_score=0,
                p2_runner_score=0,
                two_for_one=True,
            ),
        ],
    )
    g = games_of(t)
    assert [
        (x["table"], x["round"], x["side"], x["corp_entry"], x["runner_entry"], x["result"]) for x in g
    ] == [
        (1, 1, "corp", 1, 2, "corp_win"),
        (1, 1, "runner", 2, 1, "corp_win"),
        (2, 1, "corp", 3, 4, "draw"),
        (2, 1, "runner", 4, 3, "runner_win"),
        (1, 2, "corp", 1, 3, "intentional_draw"),
        (1, 2, "runner", 3, 1, "intentional_draw"),
    ]


def test_elimination_games():
    t = tourney(
        "single_sided",
        [
            CobraPairing(
                stage=2, round=1, table=1, p1=100, p2=103, p1_side="corp", elimination=True, winner=2
            ),
            CobraPairing(
                stage=2, round=1, table=2, p1=101, p2=102, p1_side="runner", elimination=True, winner=2
            ),
            CobraPairing(
                stage=2, round=2, table=1, p1=103, p2=102, p1_side="corp", elimination=True, winner=None
            ),
        ],
    )
    g = games_of(t)
    assert [(x["side"], x["corp_entry"], x["runner_entry"], x["result"], x["elimination"]) for x in g] == [
        ("corp", 1, 4, "runner_win", True),
        ("runner", 3, 2, "corp_win", True),
    ]


@pytest.mark.parametrize(
    ("cs", "rs", "res"),
    [
        (3, 0, "corp_win"),
        (0, 3, "runner_win"),
        (1, 1, "draw"),
        (3, None, "corp_win"),
        (None, 3, "runner_win"),
        (None, 0, "corp_win"),
        (0, None, "runner_win"),
        (None, None, None),
        (0, 0, None),
    ],
)
def test_result_mapping(cs, rs, res):
    assert _result(cs, rs) == res


def test_fixture_games_counts(fixture_run):
    _, _, data, _ = fixture_run
    by_tid: dict[str, int] = {}
    for g in data.rows["game"]:
        by_tid[g["tid"]] = by_tid.get(g["tid"], 0) + 1
    assert by_tid == {"c4990": 48 + 6, "c5012": 3 * 4 * 2, "c5015": 4 * 5}
    elim = [g for g in data.rows["game"] if g["elimination"]]
    assert len(elim) == 6 and {g["stage"] for g in elim} == {2}


def test_deck_precedence_and_comparison(fixture_run):
    _, _, data, q = fixture_run
    decks = {(d["tid"], d["entry_no"], d["side"]): d for d in data.rows["deck"]}
    c4990 = [d for d in data.rows["deck"] if d["tid"] == "c4990"]
    assert {d["source"] for d in c4990} == {"cobra"}  # Cobra lists win when both exist
    assert sorted({d["comparison"] for d in c4990}) == ["cobra_only", "match", "mismatch"]
    assert sum(d["comparison"] == "mismatch" for d in c4990) == 1
    # Entry 2 claimed a UUID decklist that differs from the registered Cobra list.
    assert decks[("c4990", 2, "corp")]["comparison"] == "mismatch"
    # ABR-only events and the open-stage Cobra event only have NRDB decklists.
    assert {d["source"] for d in data.rows["deck"] if d["tid"] in ("a5301", "a5250", "a5240", "c5012")} == {
        "nrdb_decklist"
    }
    assert {d["comparison"] for d in data.rows["deck"] if d["tid"].startswith("a")} == {"nrdb_only"}
    assert q.comparisons["match"] == 8
    assert decks[("c4990", 1, "corp")]["deck_id"] == deck_id("c4990", 1, "corp")


def test_private_shared_deck_used_for_claim(fixture_run):
    env, _, _, _ = fixture_run
    assert env.stores.source.exists("nrdb/deck/4b2c9e1a-77d0-4c1b-9a51-2f0d3c6e8a10.json")


def test_plain_text_is_identical_across_sources(fixture_run):
    env, _, data, _ = fixture_run
    src = _sources()
    n = Normalizer(src, env.settings)  # type: ignore[arg-type]
    checked = 0
    # Every "match" deck: its Cobra list and its NRDB list render the same plain text.
    t = n.cobra_t[4990]
    abr = {e.swiss_rank: e for e in n.abr_e[5284].entries}
    for p in t.players:
        for side in ("corp", "runner"):
            ae = abr.get(p.swiss_rank or 0)
            cd = n.cobra_decks.get((4990, p.pid, side))
            ref = (ae.corp if side == "corp" else ae.runner).deck_ref if ae else None
            if cd is None or ref is None:
                continue
            a = n.cobra_deck(cd)
            b = n.nrdb_deck(ref.kind, ref.id)
            assert b is not None
            if a.cards == b.cards:
                assert n.catalog.plain_text(a.identity, a.cards) == n.catalog.plain_text(b.identity, b.cards)
                checked += 1
    assert checked == 8
    d = next(
        x for x in data.rows["deck"] if x["tid"] == "c4990" and x["entry_no"] == 1 and x["side"] == "corp"
    )
    first, *rest = d["plain_text"].split("\n")
    assert not first[0].isdigit()  # identity line first
    assert all(line.split(" ", 1)[0].isdigit() for line in rest)


def test_standard_detection_and_banlist(fixture_run):
    _, _, data, _ = fixture_run
    t = {r["tid"]: r for r in data.rows["tournament"]}
    assert t["c4990"]["restriction_id"] == "standard_balance_update_26_08"  # Cobra's own setting
    assert t["a5250"]["restriction_id"] == "standard_ban_list_26_05"  # ABR: snapshot in force on 2026-06-20
    assert t["a5301"]["restriction_id"] == "standard_balance_update_26_08"
    assert "c5020" not in t and "a5304" not in t  # non-Standard events never reach the tables
    assert {r["format"] for r in data.rows["tournament"]} == {"standard"}


def test_non_standard_cobra_dropped_in_normalization(fixture_run):
    env, _, _, _ = fixture_run
    src = _sources()
    t = json.loads(src["cobra/tournament/5015.json"])
    t["format_id"] = 2
    src["cobra/tournament/5015.json"] = json.dumps(t).encode()
    n = Normalizer(src, env.settings)  # type: ignore[arg-type]
    out = n.run()
    assert "c5015" not in {r["tid"] for r in out.rows["tournament"]}
    assert n.q.skipped["not_standard"] == 1


def _without_format(env, tid, **edit):
    src = _sources()
    key = f"cobra/tournament/{tid}.json"
    t = json.loads(src[key])
    t.update(format_id=None, **edit)
    src[key] = json.dumps(t).encode()
    return src


def _kept(n: Normalizer, tid: str) -> bool:
    return tid in {r["tid"] for r in n.run().rows["tournament"]}


def test_cobra_event_without_format_follows_linked_abr_event(fixture_run):
    # Seen live: Cobra events created before early 2025 have no format at all.
    env, _, _, _ = fixture_run
    src = _without_format(env, 4990)
    assert _kept(Normalizer(src, env.settings), "c4990")  # type: ignore[arg-type]
    a = json.loads(src["abr/tournament/5284.json"])
    a["format"] = "eternal"
    src["abr/tournament/5284.json"] = json.dumps(a).encode()
    n = Normalizer(src, env.settings)  # type: ignore[arg-type]
    assert not _kept(n, "c4990")
    assert n.q.skipped["not_standard"] == 1


def test_unlinked_cobra_event_without_format_is_judged_by_name_and_identities(fixture_run):
    env, _, _, _ = fixture_run
    assert _kept(Normalizer(_without_format(env, 5015), env.settings), "c5015")  # type: ignore[arg-type]

    n = Normalizer(_without_format(env, 5015, name="Startup Saturday"), env.settings)  # type: ignore[arg-type]
    assert not _kept(n, "c5015")
    assert n.q.skipped["not_standard_name"] == 1

    n = Normalizer(_without_format(env, 5015), env.settings)  # type: ignore[arg-type]
    rotated = n.catalog.identity_of_title(n.cobra_t[5015].players[0].corp_identity)
    legal_in = n.catalog.legal_in
    n.catalog.legal_in = lambda c, r: c != rotated and legal_in(c, r)  # type: ignore[method-assign]
    assert not _kept(n, "c5015")
    assert n.q.skipped["not_standard_identities"] == 1


def test_cobra_event_without_format_or_identities_counts_only_when_named_standard(fixture_run):
    # Seen live: a league that recorded no identities, named "... - STANDARD - S10".
    env, _, _, _ = fixture_run
    src = _without_format(env, 5015)
    t = json.loads(src["cobra/tournament/5015.json"])
    for p in t["players"]:
        p["corp_identity"] = p["runner_identity"] = None
    for name, kept in (("Liga Netrunnera - STANDARD - S10", True), ("Liga Netrunnera S10", False)):
        t["name"] = name
        src["cobra/tournament/5015.json"] = json.dumps(t).encode()
        n = Normalizer(src, env.settings)  # type: ignore[arg-type]
        assert _kept(n, "c5015") is kept
    assert n.q.skipped["format_unknown"] == 1


def test_cobra_abr_linking(fixture_run):
    _, _, data, q = fixture_run
    assert {(x["tid"], x["abr_id"], x["method"]) for x in q.links} == {
        ("c4990", 5284, "abr_code"),
        ("c5012", 5310, "date_size_identities"),
    }
    t = {r["tid"]: r for r in data.rows["tournament"]}
    assert t["c5012"]["abr_id"] == 5310 and "a5310" not in t and "a5284" not in t
    entries = [e for e in data.rows["entry"] if e["tid"] == "c4990"]
    assert all(e["abr_swiss_rank"] == e["entry_no"] for e in entries)
    assert q.link_mismatches == []


def test_link_identity_mismatch_goes_to_quality(fixture_run):
    env, _, _, _ = fixture_run
    src = _sources()
    e = json.loads(src["abr/entries/5284.json"])
    e["entries"][0]["corp"]["identity"] = (
        e["entries"][1]["corp"]["identity"]
        if e["entries"][1]["corp"]["identity"] != e["entries"][0]["corp"]["identity"]
        else "35046"
    )
    src["abr/entries/5284.json"] = json.dumps(e).encode()
    n = Normalizer(src, env.settings)  # type: ignore[arg-type]
    n.run()
    assert {"tid": "c4990", "entry_no": 1, "reason": "identity_mismatch"} in n.q.link_mismatches


def test_tier_mapping():
    tc = tier_config()
    assert tc.abr_tier(5)[1] == "megacity"
    assert tc.abr_tier(17)[1] == "megacity"
    assert tc.abr_tier("2")[1] == "store"
    assert tc.abr_tier(1)[1] == "gnk"
    assert tc.abr_tier(7)[1] == "online"
    assert tc.cobra_tier("Intercontinental Championship")[1] == "megacity"
    assert tc.cobra_tier("Circuit Breaker Invitational")[1] == "megacity"
    assert tc.cobra_tier("District Championship")[1] == "store"
    assert tc.cobra_tier("GNK / Seasonal")[1] == "gnk"
    assert tc.cobra_tier("Community Tournament")[1] == "online"
    assert tc.cobra_tier(None)[1] == "online"
    assert tc.group_ids() == ["gnk", "store", "megacity", "online"]


def test_tiers_in_tables(fixture_run):
    _, _, data, _ = fixture_run
    assert {r["tid"]: r["tier"] for r in data.rows["tournament"]} == {
        "a5240": "store",
        "a5250": "megacity",
        "a5301": "gnk",
        "c4990": "megacity",
        "c5012": "store",
        "c5015": "gnk",
    }


def test_legality_flags(fixture_run):
    env, _, data, _ = fixture_run
    illegal = [d for d in data.rows["deck"] if not d["legal"]]
    assert len(illegal) == 1 and illegal[0]["issues"].startswith("not_legal:")
    src = {k: v for k, v in _sources().items() if k.startswith("nrdb/catalog/")}
    cat = Normalizer(src, env.settings).catalog  # type: ignore[arg-type]
    rid = "standard_balance_update_26_08"
    good = next(d for d in data.rows["deck"] if d["legal"] and d["side"] == "corp")
    cards = {c["card_id"]: c["qty"] for c in data.rows["deck_card"] if c["deck_id"] == good["deck_id"]}
    assert cat.check_deck("corp", good["identity_card"], cards, rid).legal
    few = dict(list(cards.items())[:5])
    assert "deck_size" in cat.check_deck("corp", good["identity_card"], few, rid).issues
    four = dict(cards)
    k = next(iter(four))
    four[k] = 4
    assert f"copies:{k}" in cat.check_deck("corp", good["identity_card"], four, rid).issues
    ident = cat.cards[good["identity_card"]]
    splash = [
        c
        for c in sorted(cat.cards.values(), key=lambda c: c.id)
        if c.side_id == "corp"
        and c.faction_id not in (ident.faction_id, "neutral_corp")
        and (c.influence_cost or 0) >= 3
        and c.card_type_id != "agenda"
        and cat.legal_in(c.id, rid)
    ][:2]
    heavy = dict(cards)
    for c in splash:
        heavy[c.id] = 3  # at least 18 influence
    assert "influence" in cat.check_deck("corp", good["identity_card"], heavy, rid).issues
    assert "agenda_points" not in cat.check_deck("corp", good["identity_card"], cards, rid).issues
    assert "unknown_identity" in cat.check_deck("corp", "nope", cards, rid).issues
    assert "identity_side" in cat.check_deck("runner", good["identity_card"], cards, rid).issues


def test_rotated_card_not_legal(fixture_run):
    env, _, _, _ = fixture_run
    src = {k: v for k, v in _sources().items() if k.startswith("nrdb/catalog/")}
    cat: Catalog = Normalizer(src, env.settings).catalog  # type: ignore[arg-type]
    assert "account_siphon" in cat.cards
    assert not cat.legal_in("account_siphon", "standard_balance_update_26_08")
    assert cat.legal_in("hedge_fund", "standard_balance_update_26_08")
    # Rotation is not a ban; only the ban list's own verdict is.
    assert not cat.banned_in("account_siphon", "standard_balance_update_26_08")
    assert not cat.banned_in("hedge_fund", "standard_balance_update_26_08")
    assert cat.banned_in("red_level_clearance", "standard_balance_update_26_08")
    assert not cat.banned_in("red_level_clearance", "standard_ban_list_26_05")


def test_title_matching():
    assert title_key("Haas-Bioroid: Precision Design") == "haas bioroid precision design"
    assert title_key("Az McCaffrey: Mechanical Prodigy") == title_key("AZ MCCAFFREY: MECHANICAL PRODIGY")


def test_coverage(fixture_run):
    _, _, data, _ = fixture_run
    t = {r["tid"]: r for r in data.rows["tournament"]}
    assert t["c4990"]["decklist_coverage"] == 1.0
    assert t["c5015"]["decklist_coverage"] == 0.95  # one player registered no runner deck
    assert t["a5301"]["decklist_coverage"] == 0.7
    assert t["c5012"]["decklist_coverage"] == 0.375


def test_expected_canonical_dir():
    assert Path(EXPECTED / "canonical").is_dir() or UPDATE


def _linking(env, edit_tournament, edit_entries):
    src = _sources()
    t = json.loads(src["abr/tournament/5310.json"])
    e = json.loads(src["abr/entries/5310.json"])
    edit_tournament(t)
    edit_entries(e["entries"])
    src["abr/tournament/5310.json"] = json.dumps(t).encode()
    src["abr/entries/5310.json"] = json.dumps(e).encode()
    n = Normalizer(src, env.settings)  # type: ignore[arg-type]
    n.run()
    return {x["tid"]: x["abr_id"] for x in n.q.links}, n.q.link_mismatches


def test_link_multi_day_abr_event_with_unclaimed_spot(fixture_run):
    # Seen live: a continental championship listed 11-13 Sep on ABR and 12 Sep on Cobra, where ABR's
    # entries leave out one unclaimed spot.
    env, _, _, _ = fixture_run

    def days(t):
        t["date"], t["end_date"] = "2026-09-10", "2026-09-13"

    def unclaimed(entries):
        entries[:] = [x for x in entries if x["swiss_rank"] != 5]

    links, mismatches = _linking(env, days, unclaimed)
    assert links["c5012"] == 5310
    assert mismatches == []


def test_link_rejects_too_few_shared_identities(fixture_run):
    env, _, _, _ = fixture_run

    def swap(entries):
        for a, b in ((0, 1), (2, 3), (4, 5)):
            entries[a]["corp"]["identity"], entries[b]["corp"]["identity"] = (
                entries[b]["corp"]["identity"],
                entries[a]["corp"]["identity"],
            )

    links, mismatches = _linking(env, lambda t: None, swap)
    assert "c5012" not in links
    assert [m["reason"] for m in mismatches if m["tid"] == "c5012"] == ["fallback_identities_differ"]


def test_ban_list_follows_the_decks(fixture_run):
    # Organisers may play a new ban list early, keep an old one, or be unable to pick it in Cobra
    # (seen live: an event on 25 Apr set to a list starting 1 May). The list under which most of
    # an event's decks are legal wins, and the change is reported.
    from market_research.catalog import Legality

    env, _, _, q = fixture_run
    assert q.restriction_overrides == []  # the fixtures' own settings already fit their decks
    src = _sources()
    n = Normalizer(src, env.settings)  # type: ignore[arg-type]
    older = "standard_ban_list_26_05"
    n.catalog.check_deck = lambda side, ident, cards, rid: Legality(
        rid == older, [] if rid == older else ["x"]
    )  # type: ignore[method-assign]
    out = n.run()
    over = {o["tid"]: o for o in n.q.restriction_overrides}
    assert over["c4990"]["from"] == "standard_balance_update_26_08" and over["c4990"]["to"] == older
    assert over["c4990"]["legal_after"] == over["c4990"]["decks"] > over["c4990"]["legal_before"] == 0
    t = {r["tid"]: r for r in out.rows["tournament"]}
    assert t["c4990"]["restriction_id"] == older
    assert all(d["legal"] for d in out.rows["deck"] if d["tid"] == "c4990")
    # One deck is not enough evidence: with a single deck illegal under the given list, nothing moves.
    bad: list[int] = []

    def one_bad(side, ident, cards, rid):
        if not bad:
            bad.append(id(cards))
        ok = rid == older or id(cards) != bad[0]
        return Legality(ok, [] if ok else ["x"])

    n2 = Normalizer(src, env.settings)  # type: ignore[arg-type]
    n2.catalog.check_deck = one_bad  # type: ignore[method-assign]
    n2.run()
    assert n2.q.restriction_overrides == []


def test_tournaments_keep_public_names_and_swiss_format(fixture_run):
    _, _, data, _ = fixture_run
    t = {r["tid"]: r for r in data.rows["tournament"]}
    assert all(r["name"] and r["name"].startswith("Fixture Tournament ") for r in t.values())
    assert t["c4990"]["swiss_format"] in ("single_sided", "double_sided")
    assert all(r["swiss_format"] is None for tid, r in t.items() if tid.startswith("a"))


def test_online_events_are_recognised(fixture_run):
    # Seen live: "EMEA Online Continental 2026" is a Megacity+ event (ABR location "online") and was
    # listed as offline because only the Online tier could be online.
    from market_research.scrub import IngestQuality
    from market_research.sources import abr

    ev = {
        "id": 1,
        "date": "2026.09.05.",
        "format": "standard",
        "approved": 1,
        "concluded": True,
        "players_count": 99,
        "title": "EMEA Online Continental 2026",
        "location": "online",
    }
    assert abr.parse_event(ev, IngestQuality(), "t").online
    assert not abr.parse_event(dict(ev, location="Warsaw"), IngestQuality(), "t").online

    env, _, _, _ = fixture_run
    src = _sources()
    rec = json.loads(src["cobra/tournament/5012.json"])
    rec["name"] = "Polish Online Store Championship"
    src["cobra/tournament/5012.json"] = json.dumps(rec).encode()
    out = Normalizer(src, env.settings).run()  # type: ignore[arg-type]
    t = {r["tid"]: r for r in out.rows["tournament"]}
    assert t["c5012"]["online"] and t["c5012"]["tier"] == "store"
    assert not t["c4990"]["online"]


def _normalized(src: dict[str, bytes]) -> tuple[set[str], Normalizer]:
    n = Normalizer(src, load_settings({}))
    return {r["tid"] for r in n.run().rows["tournament"]}, n


def _edited(key: str, edit) -> dict[str, bytes]:
    src = _sources()
    rec = json.loads(src[key])
    edit(rec)
    src[key] = json.dumps(rec).encode()
    return src


@pytest.fixture(scope="module")
def unedited() -> tuple[set[str], Normalizer]:
    return _normalized(_sources())


@pytest.mark.parametrize(
    ("key", "edit", "tid", "reason"),
    [
        (
            "cobra/tournament/5015.json",
            lambda t: t.update(results_fetched=False),
            "c5015",
            "cobra_no_results",
        ),
        ("cobra/tournament/5015.json", lambda t: t.update(players=t["players"][:7]), "c5015", "too_small"),
        # A Cobra event follows the guards of the ABR event it is linked to.
        ("abr/tournament/5284.json", lambda a: a.update(approved=0), "c4990", "abr_guard"),
        ("abr/tournament/5284.json", lambda a: a.update(claim_conflict=True), "c4990", "abr_guard"),
        ("abr/tournament/5301.json", lambda a: a.update(approved=0), "a5301", "abr_guard"),
        ("abr/tournament/5301.json", lambda a: a.update(concluded=False), "a5301", "abr_guard"),
        ("abr/tournament/5301.json", lambda a: a.update(claim_conflict=True), "a5301", "abr_guard"),
        ("abr/tournament/5240.json", lambda a: a.update(players_count=7), "a5240", "too_small"),
    ],
)
def test_guards_leave_events_out_and_count_why(unedited, key, edit, tid, reason):
    kept_before, before = unedited
    assert tid in kept_before
    kept, n = _normalized(_edited(key, edit))
    assert tid not in kept
    assert n.q.skipped[reason] == before.q.skipped[reason] + 1


def test_abr_event_without_entries_is_left_out(unedited):
    kept_before, before = unedited
    src = _sources()
    del src["abr/entries/5240.json"]
    kept, n = _normalized(src)
    assert "a5240" in kept_before and "a5240" not in kept
    assert n.q.skipped["abr_no_entries"] == before.q.skipped["abr_no_entries"] + 1


def test_two_fallback_candidates_link_neither(unedited):
    _, before = unedited
    assert "c5012" in {x["tid"] for x in before.q.links}
    src = _sources()
    for kind, field in (("tournament", "id"), ("entries", "tournament_id")):
        twin = json.loads(src[f"abr/{kind}/5310.json"])
        twin[field] = 5311
        src[f"abr/{kind}/5311.json"] = json.dumps(twin).encode()
    _, n = _normalized(src)
    assert "c5012" not in {x["tid"] for x in n.q.links}
    assert {"tid": "c5012", "reason": "ambiguous_fallback_match"} in n.q.link_mismatches


def test_unknown_abr_code_is_reported():
    kept, n = _normalized(_edited("cobra/tournament/5015.json", lambda t: t.update(abr_code="9999")))
    assert "c5015" in kept
    assert {"tid": "c5015", "reason": "abr_code_unresolved"} in n.q.link_mismatches
