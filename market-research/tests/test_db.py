from __future__ import annotations

from datetime import datetime

import duckdb

from market_research.db import insert_rows

COLUMNS = "k VARCHAR, n BIGINT, x DOUBLE, ok BOOLEAN, seen TIMESTAMP, note VARCHAR"
ROWS = [
    ("a", 1, 0.5, True, datetime(2026, 9, 1, 12, 30), None),
    ("b", None, 2.0, False, None, None),
    ("c", 3, None, None, datetime(2026, 9, 2), "x"),
]


def table(rows) -> list[tuple]:
    con = duckdb.connect()
    con.execute(f"CREATE TABLE t ({COLUMNS})")
    insert_rows(con, "t", rows)
    return con.execute("SELECT * FROM t").fetchall()


def test_rows_round_trip_in_order_with_nulls():
    assert table(ROWS) == ROWS


def test_matches_executemany():
    con = duckdb.connect()
    con.execute(f"CREATE TABLE t ({COLUMNS})")
    con.executemany("INSERT INTO t VALUES (?, ?, ?, ?, ?, ?)", ROWS)
    assert table(ROWS) == con.execute("SELECT * FROM t").fetchall()


def test_column_of_only_nulls():
    rows = [("a", None, None, None, None, None), ("b", None, None, None, None, None)]
    assert table(rows) == rows


def test_no_rows_is_a_no_op():
    assert table([]) == []
