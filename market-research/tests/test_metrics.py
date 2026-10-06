"""Metrics on a tiny hand-computed dataset, plus additivity."""

from __future__ import annotations

from datetime import UTC, date, datetime

import duckdb
import pytest
from hypothesis import given
from hypothesis import settings as hsettings
from hypothesis import strategies as st

from market_research.catalog import Catalog
from market_research.config import load_settings
from market_research.metrics import CARD_COLUMNS, FACTION_FIELDS, compute_counts, faction_view, wilson
from market_research.normalize import Canonical
from market_research.publish import SliceIndex, SnapshotBuilder
from market_research.records import CatCard, CatRestriction, CatSnapshot, NrdbCatalog

R = "std_r"


def catalog() -> Catalog:
    def card(cid, side, typ, fac="hb"):
        return CatCard(
            id=cid,
            title=cid.upper(),
            side_id=side,
            card_type_id=typ,
            faction_id=fac,
            card_pool_ids=["pool"],
            printing_ids=[str(10000 + sum(map(ord, cid)))],
        )

    cards = [
        card("corp_id", "corp", "corp_identity"),
        card("runner_id", "runner", "runner_identity", "shaper"),
        card("c1", "corp", "operation"),
        card("c2", "corp", "ice"),
        card("r1", "runner", "program", "shaper"),
        # For in- and out-of-faction counts: a Jinteki and a neutral identity, a Jinteki card, a
        # neutral card and an agenda.
        card("corp_id_j", "corp", "corp_identity", "jinteki"),
        card("corp_id_n", "corp", "corp_identity", "neutral_corp"),
        card("cj", "corp", "ice", "jinteki"),
        card("cn", "corp", "operation", "neutral_corp"),
        card("ca", "corp", "agenda"),
    ]
    return Catalog(
        {
            "cards": NrdbCatalog(kind="cards", cards=cards),
            "restrictions": NrdbCatalog(
                kind="restrictions", restrictions=[CatRestriction(id=R, name="R", date_start="2026-01-01")]
            ),
            "snapshots": NrdbCatalog(
                kind="snapshots",
                snapshots=[
                    CatSnapshot(
                        id="s1",
                        format_id="standard",
                        card_pool_id="pool",
                        restriction_id=R,
                        date_start="2026-01-01",
                    )
                ],
            ),
        }
    )


def tournament(tid, d, tier, cut, cov=1.0):
    return {
        "tid": tid,
        "cobra_id": None,
        "abr_id": None,
        "date": d,
        "type": tier,
        "tier": tier,
        "format": "standard",
        "restriction_id": R,
        "card_set": None,
        "country": None,
        "online": False,
        "players": 8,
        "cut_size": cut,
        "has_games": True,
        "deck_visibility": "x",
        "decklist_coverage": cov,
        "name": None,
        "swiss_format": None,
    }


def entry(tid, no, cut):
    return {
        "tid": tid,
        "entry_no": no,
        "cut_rank": 1 if cut else None,
        "made_cut": cut,
        "corp_identity": "corp_id",
        "runner_identity": "runner_id",
        "points": 0,
        "cobra_pid": None,
        "abr_swiss_rank": None,
    }


def deck(tid, no, side, cards, legal=True, ident=None):
    did = f"{tid}-{no}-{side}"
    d = {
        "deck_id": did,
        "tid": tid,
        "entry_no": no,
        "side": side,
        "identity_card": ident or f"{side}_id",
        "source": "cobra",
        "source_ref": did,
        "card_count": sum(cards.values()),
        "plain_text": "",
        "content_hash": "",
        "comparison": "cobra_only",
        "legal": legal,
        "issues": "",
    }
    return d, [{"deck_id": did, "card_id": c, "qty": q, "printing_id": None} for c, q in cards.items()]


def game(tid, rnd, corp, runner, result):
    return {
        "tid": tid,
        "stage": 1,
        "round": rnd,
        "table": corp * 10 + runner,
        "side": "corp",
        "corp_entry": corp,
        "runner_entry": runner,
        "result": result,
        "elimination": False,
    }


def dataset() -> Canonical:
    c = Canonical()
    c.rows["tournament"] = [
        tournament("T1", date(2026, 8, 10), "megacity", 2),
        tournament("T2", date(2026, 9, 5), "gnk", 0),
    ]
    c.rows["entry"] = [
        entry("T1", 1, True),
        entry("T1", 2, True),
        entry("T1", 3, False),
        entry("T1", 4, False),
        entry("T2", 1, False),
        entry("T2", 2, False),
    ]
    for d, cards in [
        deck("T1", 1, "corp", {"c1": 3, "c2": 1}),
        deck("T1", 2, "corp", {"c1": 2}),
        deck("T1", 3, "corp", {"c2": 2}),
        deck("T2", 1, "corp", {"c1": 1}),
        deck("T1", 1, "runner", {"r1": 3}),
        deck("T2", 1, "runner", {"r1": 2}),
        deck("T1", 4, "corp", {"c1": 3}, legal=False),
    ]:
        c.rows["deck"].append(d)
        c.rows["deck_card"].extend(cards)
    c.rows["game"] = [
        game("T1", 1, 1, 2, "corp_win"),
        game("T1", 1, 2, 1, "runner_win"),
        game("T1", 2, 3, 1, "draw"),
        game("T1", 2, 1, 3, "corp_win"),
        game("T1", 3, 2, 4, "intentional_draw"),
        game("T1", 3, 4, 1, "corp_win"),
        game("T2", 1, 1, 2, "runner_win"),
        game("T2", 1, 2, 1, "corp_win"),
        game("T2", 2, 1, 2, "corp_win"),
        game("T2", 2, 2, 1, "draw"),
    ]
    return c


def counts(con, table="card_counts"):
    cols = [d[0] for d in con.execute(f"SELECT * FROM {table} LIMIT 0").description]
    return [
        dict(zip(cols, r, strict=True)) for r in con.execute(f"SELECT * FROM {table} ORDER BY ALL").fetchall()
    ]


@pytest.fixture
def con():
    c = duckdb.connect()
    dataset().load_into(c)
    compute_counts(c, catalog(), load_settings({}))
    yield c
    c.close()


def test_card_counts_by_hand(con):
    rows = {(r["side"], r["month"], r["card_id"]): r for r in counts(con)}
    c1_aug = rows[("corp", "2026-08", "c1")]
    assert (
        c1_aug["decks_with_card"],
        c1_aug["copies_sum"],
        c1_aug["qty1"],
        c1_aug["qty2"],
        c1_aug["qty3"],
    ) == (2, 5, 0, 1, 1)
    assert (c1_aug["games_total"], c1_aug["games_won"]) == (3, 2.0)
    assert (
        c1_aug["entries_with_card_hc"],
        c1_aug["cut_with_card_hc"],
        c1_aug["tournaments_hc_with_card"],
    ) == (2, 2, 1)
    c1_sep = rows[("corp", "2026-09", "c1")]
    assert (c1_sep["decks_with_card"], c1_sep["copies_sum"], c1_sep["games_total"], c1_sep["games_won"]) == (
        1,
        1,
        2,
        1.0,
    )
    assert (c1_sep["entries_with_card_hc"], c1_sep["cut_with_card_hc"]) == (0, 0)  # T2 has no cut
    c2 = rows[("corp", "2026-08", "c2")]
    assert (c2["decks_with_card"], c2["copies_sum"], c2["games_total"], c2["games_won"]) == (
        2,
        3,
        3,
        2.5,
    )  # a draw is half
    assert (c2["entries_with_card_hc"], c2["cut_with_card_hc"]) == (2, 1)
    r1a = rows[("runner", "2026-08", "r1")]
    assert (r1a["games_total"], r1a["games_won"], r1a["entries_with_card_hc"], r1a["cut_with_card_hc"]) == (
        3,
        1.5,
        1,
        1,
    )
    r1s = rows[("runner", "2026-09", "r1")]
    assert (r1s["games_total"], r1s["games_won"]) == (2, 0.5)


def test_baselines_by_hand(con):
    b = {(r["side"], r["month"]): r for r in counts(con, "side_counts")}
    aug = b[("corp", "2026-08")]
    # The illegal deck and the intentional draw are excluded.
    assert (
        aug["side_decks"],
        aug["side_games"],
        aug["side_wins"],
        aug["side_entries_hc"],
        aug["side_cut_hc"],
    ) == (3, 4, 2.5, 3, 2)
    assert (aug["tournaments"], aug["tournaments_hc"]) == (1, 1)
    sep = b[("corp", "2026-09")]
    assert (sep["side_decks"], sep["side_games"], sep["side_wins"], sep["tournaments_hc"]) == (1, 2, 1.0, 0)
    assert (b[("runner", "2026-08")]["side_games"], b[("runner", "2026-08")]["side_wins"]) == (3, 1.5)


def test_wilson_bounds():
    lo, hi = wilson(3, 5)  # type: ignore[misc]
    assert lo == pytest.approx(0.2307, abs=1e-4) and hi == pytest.approx(0.8824, abs=1e-4)
    lo, hi = wilson(0, 10)  # type: ignore[misc]
    assert lo == 0.0 and hi == pytest.approx(0.2775, abs=1e-4)
    assert wilson(0, 0) is None


def test_summary_view_by_hand(con):
    b = SnapshotBuilder(con, catalog(), load_settings({}), datetime(2026, 9, 27, 4, tzinfo=UTC))
    s = b.summary("corp", "all", "all")
    assert s["period"] == {"from": "2026-07", "to": "2026-09"} and s["previous_period"] is None
    assert s["baseline"]["decks"] == 4 and s["baseline"]["games"] == 6 and s["baseline"]["wins"] == 3.5
    c1 = next(c for c in s["cards"] if c["card_id"] == "c1")
    assert c1["rank"] == 1 and c1["decks"] == 3
    assert c1["popularity"] == 0.75
    assert c1["avg_copies"] == 2.0
    assert c1["copies_mode"] == 1  # qty1=1, qty2=1, qty3=1: ties go to the lowest count
    assert c1["winrate"] == 0.6
    assert c1["winrate_diff_pp"] == round((0.6 - 3.5 / 6) * 100, 2)
    lo, hi = wilson(3, 5)  # type: ignore[misc]
    assert c1["wilson_low_pp"] == round((lo - 3.5 / 6) * 100, 2)
    assert c1["wilson_high_pp"] == round((hi - 3.5 / 6) * 100, 2)
    assert c1["winrate_status"] == "insufficient"  # 5 games < 30
    assert c1["conversion"] == 1.0 and c1["entries_hc"] == 2
    assert c1["conversion_ratio"] == round(1.0 / (2 / 3), 3)
    assert c1["conversion_status"] == "insufficient"  # 2 entries < 20
    assert s["baseline"]["cut_rate"] == round(2 / 3, 4)
    c2 = next(c for c in s["cards"] if c["card_id"] == "c2")
    assert c2["popularity"] == 0.5 and c2["winrate"] == round(2.5 / 3, 4)
    # Identities: every entry carries its identity (6 entries), conversion only where there is a cut.
    idents = b.identities("corp", "all", "all")
    assert idents["period"] == s["period"]
    corp = idents["identities"][0]
    assert corp["card_id"] == "corp_id" and corp["entries"] == 6 and corp["share"] == 1.0
    assert corp["cut_entries"] == 4 and corp["cut_made"] == 2


def test_tier_slice_and_thresholds(con):
    b = SnapshotBuilder(
        con,
        catalog(),
        load_settings({"MR_MIN_GAMES": "3", "MR_MIN_ENTRIES": "2"}),
        datetime(2026, 9, 27, tzinfo=UTC),
    )
    s = b.summary("corp", "all", "megacity")
    c1 = next(c for c in s["cards"] if c["card_id"] == "c1")
    assert c1["decks"] == 2 and c1["popularity"] == round(2 / 3, 4)
    assert c1["winrate_status"] == "ok" and c1["conversion_status"] == "ok"
    s = b.summary("corp", "all", "store")
    assert s["cards"] == [] and s["period"] is None


def test_trends_rows_sum_to_summary(con):
    b = SnapshotBuilder(con, catalog(), load_settings({}), datetime(2026, 9, 27, tzinfo=UTC))
    tr = b.trends("corp", "all", "all")
    s = b.summary("corp", "all", "all")
    for c in s["cards"]:
        rows = tr["cards"][c["card_id"]]
        assert sum(r[2] for r in rows) == c["decks"]
        assert sum(r[2 + CARD_COLUMNS.index("games_total")] for r in rows) == c["games"]
    assert sum(r[2] for r in tr["baseline"]) == s["baseline"]["decks"]
    per_faction: dict[str, int] = {}
    for r in tr["faction_baseline"]:
        per_faction[tr["factions"][r[2]]] = per_faction.get(tr["factions"][r[2]], 0) + r[3]
    assert per_faction == s["baseline"]["faction_decks"]


def test_slice_index_yields_what_a_filtered_scan_would_in_order():
    rows = [
        (side, r, tier, month, cid, 1.0)
        for side in ("corp", "runner")
        for r in ("b1", "b2")
        for tier in ("community", "store", None)
        for month in ("2026-08", "2026-09")
        for cid in ("c1", "c2")
        if tier is not None or r == "b2"
    ]
    rows.sort(key=lambda x: tuple("" if v is None else v for v in x[:5]))
    idx = SliceIndex(rows)
    for side in ("corp", "runner", "id"):
        for restriction in ("all", "b1", "b2", "b3"):
            for group in ("all", "community", "store"):
                scan = [
                    x
                    for x in rows
                    if x[0] == side and restriction in ("all", x[1]) and group in ("all", x[2])
                ]
                assert list(idx.rows(side, restriction, group)) == scan


def test_slice_index_rejects_unordered_rows():
    a, b = ("corp", "b1", "store", "2026-09"), ("corp", "b2", "store", "2026-09")
    with pytest.raises(ValueError, match="seen twice"):
        SliceIndex([a, b, a])


# ---------------------------------------------------------------- additivity

cards_st = st.dictionaries(st.sampled_from(["c1", "c2"]), st.integers(1, 3), min_size=1)


@st.composite
def random_data(draw):
    c = Canonical()
    n_t = draw(st.integers(1, 4))
    for t in range(n_t):
        tid = f"T{t}"
        month = draw(st.sampled_from([8, 9]))
        cut = draw(st.sampled_from([0, 2]))
        c.rows["tournament"].append(
            tournament(
                tid,
                date(2026, month, 1 + t),
                draw(st.sampled_from(["gnk", "store"])),
                cut,
                draw(st.sampled_from([0.5, 1.0])),
            )
        )
        n_e = draw(st.integers(2, 4))
        for e in range(1, n_e + 1):
            c.rows["entry"].append(entry(tid, e, cut > 0 and e <= cut))
            if draw(st.booleans()):
                ident = draw(st.sampled_from(["corp_id", "corp_id_j"]))
                d, dc = deck(tid, e, "corp", draw(cards_st), legal=draw(st.booleans()), ident=ident)
                c.rows["deck"].append(d)
                c.rows["deck_card"].extend(dc)
        for g in range(draw(st.integers(0, 5))):
            a, b = draw(st.integers(1, n_e)), draw(st.integers(1, n_e))
            if a != b:
                c.rows["game"].append(
                    game(
                        tid,
                        g + 1,
                        a,
                        b,
                        draw(st.sampled_from(["corp_win", "runner_win", "draw", "intentional_draw"])),
                    )
                )
    return c


def _counts_for(data: Canonical) -> dict:
    con = duckdb.connect()
    data.load_into(con)
    compute_counts(con, catalog(), load_settings({"MR_MIN_PLAYERS": "1"}))
    out: dict = {}
    for r in counts(con):
        k = (r["side"], r["card_id"])
        acc = out.setdefault(k, dict.fromkeys(CARD_COLUMNS, 0))
        for col in CARD_COLUMNS:
            acc[col] += r[col]
    con.close()
    return out


@hsettings(max_examples=40, deadline=None)
@given(random_data())
def test_monthly_counts_add_up(data):
    """Summing two months' counts equals computing over both months at once."""
    per_month = _counts_for(data)
    merged = Canonical({k: [dict(r) for r in v] for k, v in data.rows.items()})
    for t in merged.rows["tournament"]:
        t["date"] = date(2026, 8, 1)
    assert per_month == _counts_for(merged)


# ---------------------------------------------------------------- in and out of faction


def faction_dataset() -> Canonical:
    """One event (T1, with a cut): HB decks 1-2, a Jinteki deck 3 and a neutral-identity deck 4.
    Only deck 1 makes the cut."""
    c = Canonical()
    c.rows["tournament"] = [tournament("T1", date(2026, 8, 10), "megacity", 2)]
    c.rows["entry"] = [entry("T1", n, n == 1) for n in (1, 2, 3, 4)]
    for d, cards in [
        deck("T1", 1, "corp", {"c1": 3, "cj": 1, "cn": 2}),
        deck("T1", 2, "corp", {"c1": 1}),
        deck("T1", 3, "corp", {"c1": 2, "cj": 3}, ident="corp_id_j"),
        deck("T1", 4, "corp", {"cn": 1}, ident="corp_id_n"),
    ]:
        c.rows["deck"].append(d)
        c.rows["deck_card"].extend(cards)
    return c


@pytest.fixture
def fcon():
    c = duckdb.connect()
    faction_dataset().load_into(c)
    compute_counts(c, catalog(), load_settings({}))
    yield c
    c.close()


def _decks(con, table="card_counts"):
    return {r["card_id"]: (r["decks_with_card"], r["decks_in_faction"]) for r in counts(con, table)}


def test_a_card_in_a_deck_of_its_faction_counts_in_faction(fcon):
    assert _decks(fcon)["cj"] == (2, 1)  # the Jinteki deck; the HB deck splashes it


def test_a_card_in_a_deck_of_another_faction_counts_out_of_faction(fcon):
    assert _decks(fcon)["c1"] == (3, 2)  # two HB decks, splashed by the Jinteki deck


def test_neutral_card_in_a_neutral_identity_deck_matches_its_faction(fcon):
    # Raw counts compare factions as they are; faction_view leaves neutral cards out.
    assert _decks(fcon)["cn"] == (2, 1)


def test_faction_counts_count_decks_per_identity_faction(fcon):
    rows = {r["faction"]: r["decks"] for r in counts(fcon, "faction_counts")}
    assert rows == {"hb": 2, "jinteki": 1, "neutral_corp": 1}


def test_faction_counts_of_top_cut_decks_count_only_those(fcon):
    assert {r["faction"]: r["decks"] for r in counts(fcon, "faction_counts_cut")} == {"hb": 1}
    assert _decks(fcon, "card_counts_cut")["cj"] == (1, 0)  # deck 1 is HB and splashes cj


def test_a_deck_whose_identity_is_not_in_the_catalog_has_no_faction():
    c = faction_dataset()
    c.rows["deck"][1]["identity_card"] = "made_up_id"
    con = duckdb.connect()
    c.load_into(con)
    compute_counts(con, catalog(), load_settings({}))
    # Left out of the per-faction decks, which validation then reports against side_decks.
    assert {r["faction"]: r["decks"] for r in counts(con, "faction_counts")} == {
        "hb": 1,
        "jinteki": 1,
        "neutral_corp": 1,
    }
    assert _decks(con)["c1"] == (3, 1)
    con.close()


def test_summary_carries_faction_figures_by_hand(fcon):
    b = SnapshotBuilder(fcon, catalog(), load_settings({}), datetime(2026, 9, 27, tzinfo=UTC))
    s = b.summary("corp", "all", "all")
    assert s["baseline"]["faction_decks"] == {"hb": 2, "jinteki": 1, "neutral_corp": 1}
    c1 = next(c for c in s["cards"] if c["card_id"] == "c1")
    assert (c1["decks_in_faction"], c1["popularity_in"], c1["popularity_out"], c1["splash_share"]) == (
        2,
        1.0,  # both HB decks
        0.5,  # one of the two other decks
        round(1 / 3, 4),
    )
    cn = next(c for c in s["cards"] if c["card_id"] == "cn")
    assert {k: cn[k] for k in FACTION_FIELDS} == dict.fromkeys(FACTION_FIELDS)


# faction_view on summed counts: one rule per test.

S = load_settings({})
BASE = {"side_decks": 10.0}
FACTIONS = {"hb": 4.0, "jinteki": 6.0}


def counted_card(decks, in_faction):
    return {"decks_with_card": float(decks), "decks_in_faction": float(in_faction)}


def view(c, *, prev=None, prev_base=None, prev_factions=None, faction="hb", typ="ice", settings=S):
    return faction_view(c, BASE, FACTIONS, prev, prev_base, prev_factions, faction, typ, settings)


def test_faction_view_popularity_in_divides_by_decks_of_the_cards_faction():
    assert view(counted_card(3, 2))["popularity_in"] == 0.5  # 2 of 4 HB decks


def test_faction_view_popularity_out_divides_by_decks_of_other_factions():
    assert view(counted_card(3, 2))["popularity_out"] == round(1 / 6, 4)  # 1 of 6 Jinteki decks


def test_faction_view_splash_share_divides_by_decks_with_the_card():
    assert view(counted_card(4, 1))["splash_share"] == 0.75


def test_faction_view_neutral_card_has_no_faction_figures():
    assert view(counted_card(3, 3), faction="neutral_corp") == dict.fromkeys(FACTION_FIELDS)


def test_faction_view_identity_has_no_faction_figures():
    assert view(counted_card(3, 3), typ="corp_identity") == dict.fromkeys(FACTION_FIELDS)


def test_faction_view_card_without_catalog_entry_has_no_faction_figures():
    assert view(counted_card(3, 3), faction=None, typ=None) == dict.fromkeys(FACTION_FIELDS)


def test_faction_view_agenda_has_in_faction_figures_only():
    v = view(counted_card(3, 3), typ="agenda")
    assert v["popularity_in"] == 0.75
    assert [v[k] for k in FACTION_FIELDS[4:]] == [None] * 7


def test_faction_view_no_decks_of_the_cards_faction_gives_no_popularity_in():
    v = view(counted_card(2, 0), faction="nbn")
    assert v["popularity_in"] is None and v["popularity_out"] == 0.2  # 2 of 10 decks, none NBN


def test_faction_view_no_decks_of_other_factions_gives_no_popularity_out():
    v = faction_view(counted_card(2, 2), BASE, {"hb": 10.0}, None, None, None, "hb", "ice", S)
    assert v["popularity_in"] == 0.2 and v["popularity_out"] is None


@pytest.mark.parametrize(("decks", "status"), [(19, "insufficient"), (20, "ok"), (21, "ok")])
def test_faction_view_splash_status_at_the_minimum_decks(decks, status):
    assert view(counted_card(decks, 0))["splash_status"] == status


def test_faction_view_minimum_decks_comes_from_settings():
    v = view(counted_card(5, 0), settings=load_settings({"MR_MIN_SPLASH_DECKS": "5"}))
    assert v["splash_status"] == "ok"


def test_faction_view_without_a_previous_period_has_no_change():
    v = view(counted_card(3, 2))
    assert [
        v[k] for k in ("prev_popularity_in", "change_in_pp", "prev_splash_share", "change_splash_pp")
    ] == [None] * 4


def test_faction_view_card_not_played_before_was_at_zero_with_no_splash_share():
    v = view(counted_card(3, 2), prev=None, prev_base={"side_decks": 5.0}, prev_factions={"hb": 5.0})
    assert (v["prev_popularity_in"], v["change_in_pp"]) == (0.0, 50.0)
    assert (v["prev_popularity_out"], v["change_out_pp"]) == (None, None)  # no other faction's decks then
    assert (v["prev_splash_share"], v["change_splash_pp"]) == (None, None)


def test_faction_view_change_compares_with_the_previous_period():
    v = view(
        counted_card(4, 2),
        prev=counted_card(2, 2),
        prev_base={"side_decks": 8.0},
        prev_factions={"hb": 4.0, "jinteki": 4.0},
    )
    assert (v["prev_popularity_in"], v["change_in_pp"]) == (0.5, 0.0)
    assert (v["prev_popularity_out"], v["change_out_pp"]) == (0.0, round(2 / 6 * 100, 2))
    assert (v["prev_splash_share"], v["change_splash_pp"]) == (0.0, 50.0)
