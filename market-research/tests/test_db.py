from __future__ import annotations

import math
import sys
from datetime import date, datetime

import duckdb
import pytest

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


def test_text_round_trips_exactly():
    texts = ["O’Brian — “quoted” é", "it's", 'a"b', r"back\slash", "line\r\nbreak", "ﾅ", "", '{"json": 1}']
    rows = [(t, None, None, None, None, None) for t in texts]
    assert table(rows) == rows


def test_numbers_round_trip_exactly():
    rows = [("a", 2**62, 0.1 + 0.2, True, None, None), ("b", -(2**62), 1e-300, False, None, None)]
    assert table(rows) == rows


def test_dates_round_trip():
    con = duckdb.connect()
    con.execute("CREATE TABLE d (day DATE, seen TIMESTAMP)")
    rows = [(date(2026, 10, 3), datetime(2026, 10, 3, 23, 59, 59, 123456))]
    insert_rows(con, "d", rows)
    assert con.execute("SELECT * FROM d").fetchall() == rows


def test_nan_is_refused():
    with pytest.raises(ValueError):
        table([("a", None, math.nan, None, None, None)])


def test_a_value_json_cannot_hold_is_refused():
    with pytest.raises(TypeError, match="set"):
        table([("a", None, None, None, None, {1})])


@pytest.mark.parametrize("width", [5, 7])
def test_rows_must_have_one_value_per_column(width):
    with pytest.raises(ValueError, match="values per row"):
        table([tuple([None] * width)])


def test_rows_of_different_widths_are_refused():
    with pytest.raises(ValueError):
        table([ROWS[0], ROWS[1][:5]])


def test_values_are_not_converted_one_by_one(monkeypatch):
    """DuckDB tries `import pandas` for every Python value it converts; without pandas installed
    each try fails and rescans sys.path. One JSON parameter keeps that to a constant few."""
    lookups = []

    class Spy:
        def find_spec(self, name, path=None, target=None):
            if name == "pandas":
                lookups.append(name)
            return None

    monkeypatch.delitem(sys.modules, "pandas", raising=False)  # conftest's stub would hide the lookups
    monkeypatch.setattr(sys, "meta_path", [Spy(), *sys.meta_path])
    table([(f"k{i}", i, i / 3, True, None, None) for i in range(1000)])
    assert len(lookups) <= 4
