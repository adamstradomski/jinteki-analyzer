"""The catalog view: printings, identities by title, Standard snapshots and deck legality.

Built from a handful of hand-made cards, so every legality rule is checked on its own.
"""

from __future__ import annotations

from typing import Any

import pytest

from market_research.catalog import Catalog, title_key
from market_research.records import CatCard, CatPrinting, CatRestriction, CatSnapshot, NrdbCatalog, Verdicts

NEW, OLD = "pool_new", "pool_old"


def card(cid: str, side: str, type_id: str, faction: str, title: str = "", **kw: Any) -> CatCard:
    kw.setdefault("card_pool_ids", [NEW])
    return CatCard(
        id=cid,
        title=title or cid.replace("_", " ").title(),
        side_id=side,
        card_type_id=type_id,
        faction_id=faction,
        **kw,
    )


CARDS = [
    card("hb_precision", "corp", "corp_identity", "haas_bioroid", "Haas-Bioroid: Precision Design",
         influence_limit=3, minimum_deck_size=5, printing_ids=["1001"]),
    card("hb_engineering", "corp", "corp_identity", "haas_bioroid", "Haas-Bioroid: Engineering the Future",
         influence_limit=12, minimum_deck_size=40),
    card("pe", "corp", "corp_identity", "jinteki", "Jinteki: Personal Evolution",
         influence_limit=15, minimum_deck_size=45, card_pool_ids=[OLD]),
    card("az", "runner", "runner_identity", "anarch", "Az McCaffrey: Mechanical Prodigy",
         influence_limit=15, minimum_deck_size=45),
    card("project", "corp", "agenda", "neutral_corp", agenda_points=2),
    card("wall", "corp", "ice", "neutral_corp", printing_ids=["1002"]),
    card("filler", "corp", "operation", "neutral_corp"),
    card("unique_wall", "corp", "ice", "neutral_corp", deck_limit=1),
    card("jin_ice", "corp", "ice", "jinteki", influence_cost=2),
    card("banned_op", "corp", "operation", "neutral_corp"),
    card("rotated_ice", "corp", "ice", "neutral_corp", card_pool_ids=[OLD]),
    card("restricted_a", "corp", "operation", "neutral_corp"),
    card("restricted_b", "corp", "operation", "neutral_corp"),
    card("ufc_op", "corp", "operation", "neutral_corp"),
    card("pointed_op", "corp", "operation", "neutral_corp"),
    card("sure_gamble", "runner", "event", "neutral_runner"),
]  # fmt: skip
NEW_LIST = CatRestriction(
    id="bl_new",
    name="New list",
    point_limit=1,
    verdicts=Verdicts(
        banned=["banned_op"],
        restricted=["restricted_a", "restricted_b"],
        universal_faction_cost={"ufc_op": 2},
        points={"pointed_op": 2},
    ),
)
SNAPSHOTS = [
    CatSnapshot(id="s_new", format_id="standard", card_pool_id=NEW, restriction_id="bl_new", date_start="2026-03-01", active=True),
    CatSnapshot(id="s_old", format_id="standard", card_pool_id=OLD, restriction_id="bl_old", date_start="2025-06-01"),
    CatSnapshot(id="s_mid", format_id="standard", card_pool_id=OLD, restriction_id="bl_old", date_start="2025-11-01"),
    CatSnapshot(id="s_undated", format_id="standard", card_pool_id=NEW, restriction_id="bl_x"),
    CatSnapshot(id="s_startup", format_id="startup", card_pool_id=NEW, restriction_id="bl_startup", date_start="2026-04-01"),
]  # fmt: skip


@pytest.fixture(scope="module")
def cat() -> Catalog:
    return Catalog(
        {
            "cards": NrdbCatalog(kind="cards", cards=CARDS),
            "printings": NrdbCatalog(
                kind="printings", printings=[CatPrinting(id="2001", card_id="wall", card_set_id="set")]
            ),
            "restrictions": NrdbCatalog(
                kind="restrictions", restrictions=[NEW_LIST, CatRestriction(id="bl_old", name="Old list")]
            ),
            "snapshots": NrdbCatalog(kind="snapshots", snapshots=SNAPSHOTS),
        }
    )


# Five cards with four agenda points: the smallest legal deck for Precision Design.
LEGAL = {"project": 2, "wall": 3}


def issues(cat: Catalog, cards: dict[str, int], ident: str = "hb_precision", side: str = "corp") -> list[str]:
    return cat.check_deck(side, ident, cards, "bl_new").issues


def test_a_legal_deck_has_no_issues(cat):
    assert cat.check_deck("corp", "hb_precision", LEGAL, "bl_new").legal
    assert issues(cat, {**LEGAL, "wall": 2, "unique_wall": 1}) == []


@pytest.mark.parametrize(
    ("change", "expected"),
    [
        ({"mystery_card": 1}, ["unknown_card:mystery_card"]),
        ({"sure_gamble": 1}, ["wrong_side:sure_gamble"]),
        ({"hb_engineering": 1}, ["extra_identity:hb_engineering"]),
        ({"wall": 4}, ["copies:wall"]),
        ({"unique_wall": 2}, ["copies:unique_wall"]),
        ({"banned_op": 1}, ["not_legal:banned_op"]),
        ({"rotated_ice": 1}, ["not_legal:rotated_ice"]),
        ({"jin_ice": 2}, ["influence"]),  # 4 influence over the identity's 3
        ({"ufc_op": 1}, []),  # universal faction cost counts even on a neutral card: 2 of 3
        ({"ufc_op": 2}, ["influence"]),
        ({"restricted_a": 1}, []),
        ({"restricted_a": 1, "restricted_b": 1}, ["restricted"]),
        ({"pointed_op": 1}, ["points"]),  # 2 points over the list's limit of 1
        ({"project": 3}, ["agenda_points"]),  # 6 points in 6 cards; 5 to 9 cards need 4 or 5
        ({"project": 3, "unique_wall": 1, "filler": 3}, []),  # 10 cards need 6 or 7
    ],
)
def test_each_rule_on_its_own(cat, change, expected):
    assert issues(cat, {**LEGAL, **change}) == expected


def test_deck_size_and_identity_rules(cat):
    assert issues(cat, {"project": 2, "wall": 2}) == ["deck_size"]
    assert issues(cat, LEGAL, ident="nobody") == ["unknown_identity"]
    assert issues(cat, LEGAL, ident="az", side="corp")[0] == "identity_side"
    assert "identity_not_legal:pe" in issues(cat, LEGAL, ident="pe")
    # A runner deck has no agenda point rule.
    assert issues(cat, {"sure_gamble": 3}, ident="az", side="runner") == ["deck_size"]


def test_legality_needs_the_card_pool_and_no_ban(cat):
    assert cat.legal_in("wall", "bl_new") and not cat.legal_in("wall", "bl_old")
    assert cat.legal_in("rotated_ice", "bl_old") and not cat.legal_in("rotated_ice", "bl_new")
    assert not cat.legal_in("banned_op", "bl_new")
    assert not cat.legal_in("mystery_card", "bl_new") and not cat.legal_in("wall", "bl_unknown")
    # Only the list's own verdict is a ban; rotation is not.
    assert cat.banned_in("banned_op", "bl_new") and not cat.banned_in("rotated_ice", "bl_new")
    assert not cat.banned_in("banned_op", "bl_unknown")


def test_standard_snapshots_in_date_order(cat):
    assert cat.ok()
    assert cat.standard_restrictions() == ["bl_old", "bl_new"]  # dated Standard snapshots only
    assert cat.is_standard_restriction("bl_new") and not cat.is_standard_restriction("bl_startup")
    assert not cat.is_standard_restriction(None)
    assert cat.snapshot_at("2025-05-31") is None
    assert cat.snapshot_at("2025-06-01").id == "s_old"  # type: ignore[union-attr]
    assert cat.snapshot_at("2026-02-28").id == "s_mid"  # type: ignore[union-attr]
    assert cat.snapshot_at("2026-09-27").id == "s_new"  # type: ignore[union-attr]
    assert cat.snapshot_for_restriction("bl_old").id == "s_mid"  # type: ignore[union-attr]
    assert cat.snapshot_for_restriction("bl_startup") is None


def test_identities_by_title_and_short_name(cat):
    assert cat.identity_of_title("Haas-Bioroid: Precision Design") == "hb_precision"
    assert cat.identity_of_title("haas bioroid  PRECISION design") == "hb_precision"
    assert cat.identity_of_title("Az McCaffrey") == "az"  # NRTM exports may carry only the short name
    assert cat.identity_of_title("Haas-Bioroid") is None  # two identities share it
    assert cat.identity_of_title("Wall") is None  # not an identity
    assert cat.identity_of_title("") is None and cat.identity_of_title(None) is None
    # Curly quotes, dashes and other typographic punctuation key like the ASCII an export uses.
    assert title_key("“Knickknack” O’Brian") == title_key('"Knickknack" O\'Brian') == "knickknack o brian"
    assert title_key("‘Loup’ Arcemont") == title_key("'Loup' Arcemont") == "loup arcemont"
    assert title_key("Mars–Venus—Io…") == title_key("Mars-Venus--Io...") == "mars venus io"
    # Accents are dropped, not turned into separators.
    assert title_key("René “Loup” Arcemont") == "rene loup arcemont"
    assert title_key("Esâ Afontov") == "esa afontov"


def test_printings_resolve_to_cards(cat):
    assert cat.card_of_printing("2001") == "wall"  # from the printings table
    assert cat.card_of_printing("1002") == "wall"  # from the card's own printing list
    assert cat.card_of_printing("9999") is None and cat.card_of_printing(None) is None


def test_plain_text_lists_identity_then_cards_by_type_and_title(cat):
    text = cat.plain_text("hb_precision", {"wall": 3, "banned_op": 1, "project": 2, "jin_ice": 1})
    assert text.split("\n") == [
        "Haas-Bioroid: Precision Design",
        "2 Project",
        "1 Banned Op",
        "1 Jin Ice",
        "3 Wall",
    ]


def test_without_cards_or_snapshots_the_catalog_is_not_usable():
    assert not Catalog({}).ok()
    assert not Catalog({"cards": NrdbCatalog(kind="cards", cards=CARDS)}).ok()
