"""Metrics as additive counts. Every ratio is a sum divided by a sum, so any months or tiers combine.

Definitions (docs/market-research/metrics.md has them verbatim):

- popularity = decks_with_card / decks_total
- avg_copies = copies_sum / decks_with_card
- winrate = games_won / games_total, over games where the card's deck played on the card's side,
  excluding intentional draws; draws count as half a win. Shown as winrate - side baseline winrate,
  with the Wilson 95% interval.
- conversion = cut_with_card_hc / entries_with_card_hc, compared with side_cut_hc / side_entries_hc
- Winrate and conversion are `insufficient` below a minimum sample (default 30 games or 20 entries).
"""

from __future__ import annotations

import math
from typing import Any

import duckdb

from market_research.catalog import Catalog
from market_research.config import Settings
from market_research.db import insert_rows

Z95 = 1.959963984540054

CARD_COLUMNS = [
    "decks_with_card", "copies_sum", "qty1", "qty2", "qty3", "games_total", "games_won",
    "entries_with_card_hc", "cut_with_card_hc", "tournaments_hc_with_card",
]  # fmt: skip
BASELINE_COLUMNS = [
    "side_decks", "side_games", "side_wins", "side_entries_hc", "side_cut_hc", "tournaments", "tournaments_hc",
    "side_games_all", "side_wins_all",
]  # fmt: skip
IDENTITY_COLUMNS = ["entries", "games_total", "games_won", "cut_entries", "cut_made"]
IDENTITY_BASELINE_COLUMNS = ["side_entries", "side_games", "side_wins", "side_cut_entries", "side_cut_made"]


def wilson(wins: float, n: float, z: float = Z95) -> tuple[float, float] | None:
    if n <= 0:
        return None
    p = wins / n
    denom = 1 + z * z / n
    center = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return max(0.0, center - half), min(1.0, center + half)


def ratio(a: float, b: float) -> float | None:
    return a / b if b else None


def _counts_sql(suffix: str, d: str, dg: str, g: str, t: str) -> str:
    """card_counts{suffix} and side_counts{suffix} over the given deck, deck-game, game and event tables."""
    return f"""
        CREATE OR REPLACE TABLE card_counts{suffix} AS
        WITH per_deck AS (
            SELECT d.*, dc.card_id, dc.qty FROM {d} d JOIN deck_card dc USING (deck_id)
            JOIN legal l ON l.card_id = dc.card_id AND l.restriction_id = d.restriction_id
        ),
        decks AS (
            SELECT side, restriction_id, tier, month, card_id,
                   count(*) AS decks_with_card, sum(qty) AS copies_sum,
                   count(*) FILTER (WHERE qty = 1) AS qty1, count(*) FILTER (WHERE qty = 2) AS qty2,
                   count(*) FILTER (WHERE qty >= 3) AS qty3,
                   count(*) FILTER (WHERE hc) AS entries_with_card_hc,
                   count(*) FILTER (WHERE hc AND made_cut) AS cut_with_card_hc,
                   count(DISTINCT tid) FILTER (WHERE hc) AS tournaments_hc_with_card
            FROM per_deck GROUP BY ALL
        ),
        games AS (
            SELECT dg.side, dg.restriction_id, dg.tier, dg.month, dc.card_id,
                   count(*) AS games_total, sum(dg.won) AS games_won
            FROM {dg} dg JOIN deck_card dc USING (deck_id)
            JOIN legal l ON l.card_id = dc.card_id AND l.restriction_id = dg.restriction_id
            GROUP BY ALL
        )
        SELECT decks.side, decks.restriction_id, decks.tier, decks.month, decks.card_id,
               decks_with_card, copies_sum, qty1, qty2, qty3,
               coalesce(games_total, 0) AS games_total, coalesce(games_won, 0.0) AS games_won,
               entries_with_card_hc, cut_with_card_hc, tournaments_hc_with_card
        FROM decks LEFT JOIN games USING (side, restriction_id, tier, month, card_id);

        CREATE OR REPLACE TABLE side_counts{suffix} AS
        WITH sides AS (SELECT * FROM (VALUES ('corp'), ('runner')) s(side)),
        dk AS (
            SELECT side, restriction_id, tier, month, count(*) AS side_decks,
                   count(*) FILTER (WHERE hc) AS side_entries_hc,
                   count(*) FILTER (WHERE hc AND made_cut) AS side_cut_hc
            FROM {d} GROUP BY ALL
        ),
        gm AS (
            SELECT side, restriction_id, tier, month, count(*) AS side_games, sum(won) AS side_wins
            FROM {dg} GROUP BY ALL
        ),
        -- Every game, deck known or not: the headline side winrate (corp + runner = 100%).
        ga AS (
            SELECT side, restriction_id, tier, month, count(*) AS side_games_all, sum(won) AS side_wins_all
            FROM {g} GROUP BY ALL
        ),
        tn AS (
            SELECT restriction_id, tier, month, count(*) AS tournaments, count(*) FILTER (WHERE hc) AS tournaments_hc
            FROM {t} GROUP BY ALL
        )
        SELECT s.side, tn.restriction_id, tn.tier, tn.month,
               coalesce(dk.side_decks, 0) AS side_decks, coalesce(gm.side_games, 0) AS side_games,
               coalesce(gm.side_wins, 0.0) AS side_wins, coalesce(dk.side_entries_hc, 0) AS side_entries_hc,
               coalesce(dk.side_cut_hc, 0) AS side_cut_hc, tn.tournaments, tn.tournaments_hc,
               coalesce(ga.side_games_all, 0) AS side_games_all, coalesce(ga.side_wins_all, 0.0) AS side_wins_all
        FROM tn CROSS JOIN sides s
        LEFT JOIN dk ON dk.side = s.side AND dk.restriction_id = tn.restriction_id AND dk.tier = tn.tier AND dk.month = tn.month
        LEFT JOIN gm ON gm.side = s.side AND gm.restriction_id = tn.restriction_id AND gm.tier = tn.tier AND gm.month = tn.month
        LEFT JOIN ga ON ga.side = s.side AND ga.restriction_id = tn.restriction_id AND ga.tier = tn.tier AND ga.month = tn.month;
    """


def compute_counts(con: duckdb.DuckDBPyConnection, catalog: Catalog, settings: Settings) -> None:
    """Creates card_counts, side_counts, identity_counts and identity_side_counts from canonical tables,
    plus card_counts_cut and side_counts_cut for decks that made the cut in events that had one."""
    t = settings.thresholds
    con.execute("CREATE OR REPLACE TABLE legal (card_id VARCHAR, restriction_id VARCHAR)")
    restrictions = [
        r[0]
        for r in con.execute(
            "SELECT DISTINCT restriction_id FROM tournament WHERE restriction_id IS NOT NULL"
        ).fetchall()
    ]
    rows = [(cid, r) for r in restrictions for cid in sorted(catalog.cards) if catalog.legal_in(cid, r)]
    insert_rows(con, "legal", rows)
    con.execute(
        f"""
        CREATE OR REPLACE TABLE t AS
        SELECT tid, restriction_id, tier, strftime(date, '%Y-%m') AS month,
               (decklist_coverage >= {float(t.coverage_hc)} AND cut_size > 0) AS hc
        FROM tournament WHERE restriction_id IS NOT NULL AND players >= {int(t.min_players)};

        CREATE OR REPLACE TABLE d AS
        SELECT d.deck_id, d.tid, d.entry_no, d.side, e.made_cut, t.restriction_id, t.tier, t.month, t.hc
        FROM deck d JOIN t USING (tid) JOIN entry e ON e.tid = d.tid AND e.entry_no = d.entry_no
        WHERE d.legal;

        CREATE OR REPLACE TABLE g AS
        SELECT g.tid, t.restriction_id, t.tier, t.month, side_name AS side,
               CASE WHEN side_name = 'corp' THEN g.corp_entry ELSE g.runner_entry END AS entry_no,
               CAST(CASE WHEN g.result = 'draw' THEN 0.5
                    WHEN (g.result = 'corp_win') = (side_name = 'corp') THEN 1.0 ELSE 0.0 END AS DOUBLE) AS won
        FROM game g JOIN t USING (tid), (VALUES ('corp'), ('runner')) s(side_name)
        WHERE g.result <> 'intentional_draw';

        CREATE OR REPLACE TABLE dg AS
        SELECT d.deck_id, g.won, d.side, d.restriction_id, d.tier, d.month
        FROM g JOIN d ON d.tid = g.tid AND d.entry_no = g.entry_no AND d.side = g.side;

        {_counts_sql("", "d", "dg", "g", "t")}
        CREATE OR REPLACE TABLE ie AS
        SELECT e.tid, e.entry_no, s.side,
               CASE WHEN s.side = 'corp' THEN e.corp_identity ELSE e.runner_identity END AS identity,
               e.made_cut, tn.cut_size > 0 AS cut_exists, t.restriction_id, t.tier, t.month
        FROM entry e JOIN t USING (tid) JOIN tournament tn USING (tid), (VALUES ('corp'), ('runner')) s(side);

        -- Identity conversion uses only events with a cut where identities are known for most entries.
        CREATE OR REPLACE TABLE ie AS
        SELECT ie.* EXCLUDE (cut_exists),
               ie.cut_exists AND (count(ie.identity) OVER w)::DOUBLE / (count(*) OVER w) >= {float(t.coverage_hc)} AS has_cut
        FROM ie WINDOW w AS (PARTITION BY ie.tid, ie.side);

        CREATE OR REPLACE TABLE ie AS
        SELECT ie.* FROM ie JOIN legal l ON l.card_id = ie.identity AND l.restriction_id = ie.restriction_id;

        CREATE OR REPLACE TABLE identity_counts AS
        WITH en AS (
            SELECT side, restriction_id, tier, month, identity, count(*) AS entries,
                   count(*) FILTER (WHERE has_cut) AS cut_entries,
                   count(*) FILTER (WHERE has_cut AND made_cut) AS cut_made
            FROM ie GROUP BY ALL
        ),
        gm AS (
            SELECT g.side, g.restriction_id, g.tier, g.month, ie.identity, count(*) AS games_total, sum(g.won) AS games_won
            FROM g JOIN ie ON ie.tid = g.tid AND ie.entry_no = g.entry_no AND ie.side = g.side GROUP BY ALL
        )
        SELECT en.side, en.restriction_id, en.tier, en.month, en.identity, entries,
               coalesce(games_total, 0) AS games_total, coalesce(games_won, 0.0) AS games_won, cut_entries, cut_made
        FROM en LEFT JOIN gm USING (side, restriction_id, tier, month, identity);

        CREATE OR REPLACE TABLE identity_side_counts AS
        SELECT side, restriction_id, tier, month, sum(entries) AS side_entries, sum(games_total) AS side_games,
               sum(games_won) AS side_wins, sum(cut_entries) AS side_cut_entries, sum(cut_made) AS side_cut_made
        FROM identity_counts GROUP BY ALL;
        """
    )
    # Top-cut scope: only decks (and players) that made the cut, in events that had one. The same
    # counts as above, so the page can switch every card view to what top-cut decks played.
    con.execute(
        f"""
        CREATE OR REPLACE TABLE t_cut AS SELECT t.* FROM t JOIN tournament tn USING (tid) WHERE tn.cut_size > 0;
        CREATE OR REPLACE TABLE d_cut AS SELECT d.* FROM d JOIN t_cut USING (tid) WHERE d.made_cut;
        CREATE OR REPLACE TABLE dg_cut AS SELECT dg.* FROM dg JOIN d_cut USING (deck_id);
        CREATE OR REPLACE TABLE g_cut AS
        SELECT g.* FROM g JOIN t_cut USING (tid)
        JOIN entry e ON e.tid = g.tid AND e.entry_no = g.entry_no WHERE e.made_cut;
        {_counts_sql("_cut", "d_cut", "dg_cut", "g_cut", "t_cut")}
        """
    )


def card_view(
    c: dict[str, float],
    base: dict[str, float],
    prev: dict[str, float] | None,
    prev_base: dict[str, float] | None,
    settings: Settings,
) -> dict[str, Any]:
    """Ratios for one card from summed counts (used for the precomputed default views)."""
    t = settings.thresholds
    pop = ratio(c["decks_with_card"], base["side_decks"])
    prev_pop = (
        ratio(prev["decks_with_card"], prev_base["side_decks"])
        if prev and prev_base
        else (0.0 if prev_base and prev_base["side_decks"] else None)
    )
    base_wr = ratio(base["side_wins"], base["side_games"])
    wr = ratio(c["games_won"], c["games_total"])
    ci = wilson(c["games_won"], c["games_total"])
    conv = ratio(c["cut_with_card_hc"], c["entries_with_card_hc"])
    base_conv = ratio(base["side_cut_hc"], base["side_entries_hc"])
    qty = {1: c["qty1"], 2: c["qty2"], 3: c["qty3"]}
    mode = max(qty, key=lambda k: (qty[k], -k)) if c["decks_with_card"] else None
    return {
        "decks": int(c["decks_with_card"]),
        "popularity": _r(pop),
        "avg_copies": _r(ratio(c["copies_sum"], c["decks_with_card"]), 3),
        "copies_mode": mode,
        "prev_popularity": _r(prev_pop),
        "change_pp": _r((pop - prev_pop) * 100, 2) if pop is not None and prev_pop is not None else None,
        "games": int(c["games_total"]),
        "wins": c["games_won"],
        "winrate": _r(wr),
        "winrate_diff_pp": _r((wr - base_wr) * 100, 2) if wr is not None and base_wr is not None else None,
        "wilson_low_pp": _r((ci[0] - base_wr) * 100, 2) if ci and base_wr is not None else None,
        "wilson_high_pp": _r((ci[1] - base_wr) * 100, 2) if ci and base_wr is not None else None,
        "winrate_status": "ok" if c["games_total"] >= t.min_games else "insufficient",
        "entries_hc": int(c["entries_with_card_hc"]),
        "cut_hc": int(c["cut_with_card_hc"]),
        "tournaments_hc": int(c["tournaments_hc_with_card"]),
        "conversion": _r(conv),
        "conversion_ratio": _r(conv / base_conv, 3) if conv is not None and base_conv else None,
        "conversion_diff_pp": _r((conv - base_conv) * 100, 2)
        if conv is not None and base_conv is not None
        else None,
        "conversion_status": "ok" if c["entries_with_card_hc"] >= t.min_entries else "insufficient",
    }


def identity_view(c: dict[str, float], base: dict[str, float], settings: Settings) -> dict[str, Any]:
    t = settings.thresholds
    wr = ratio(c["games_won"], c["games_total"])
    base_wr = ratio(base["side_wins"], base["side_games"])
    ci = wilson(c["games_won"], c["games_total"])
    conv = ratio(c["cut_made"], c["cut_entries"])
    base_conv = ratio(base["side_cut_made"], base["side_cut_entries"])
    return {
        "entries": int(c["entries"]),
        "share": _r(ratio(c["entries"], base["side_entries"])),
        "games": int(c["games_total"]),
        "wins": c["games_won"],
        "winrate": _r(wr),
        "winrate_diff_pp": _r((wr - base_wr) * 100, 2) if wr is not None and base_wr is not None else None,
        "wilson_low_pp": _r((ci[0] - base_wr) * 100, 2) if ci and base_wr is not None else None,
        "wilson_high_pp": _r((ci[1] - base_wr) * 100, 2) if ci and base_wr is not None else None,
        "winrate_status": "ok" if c["games_total"] >= t.min_games else "insufficient",
        "cut_entries": int(c["cut_entries"]),
        "cut_made": int(c["cut_made"]),
        "conversion": _r(conv),
        "conversion_ratio": _r(conv / base_conv, 3) if conv is not None and base_conv else None,
        "conversion_status": "ok" if c["cut_entries"] >= t.min_entries else "insufficient",
    }


def _r(v: float | None, nd: int = 4) -> float | None:
    return None if v is None else round(v, nd)
