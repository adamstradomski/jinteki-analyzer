"""DuckDB helpers shared by the stages that stage Python rows in a table."""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import date, datetime
from typing import Any

import duckdb


def _json_value(v: object) -> str:
    if isinstance(v, datetime | date):
        return v.isoformat()
    raise TypeError(f"cannot stage a {type(v).__name__} in DuckDB")


def insert_rows(con: duckdb.DuckDBPyConnection, table: str, rows: Sequence[Sequence[Any]]) -> None:
    """Appends rows to `table` in one statement.

    The rows go in as one JSON document of column lists, which DuckDB parses to the table's column
    types; UNNEST zips the lists back into rows. Python values passed as parameters are converted one
    by one, and DuckDB tries `import pandas` for each (twice): without pandas installed that import
    fails every time and is never cached, which made staging 5,000 rows take half a minute.
    `executemany` is slower still: one INSERT per row.
    """
    if not rows:
        return
    types = [str(r[1]) for r in con.execute(f'DESCRIBE "{table}"').fetchall()]
    columns = list(zip(*rows, strict=True))
    if len(columns) != len(types):
        raise ValueError(f"{table}: {len(columns)} values per row for {len(types)} columns")
    doc = json.dumps(
        {f"c{i}": list(c) for i, c in enumerate(columns)},
        default=_json_value,
        ensure_ascii=False,
        allow_nan=False,
    )
    # The structure is built from the table's own column types, never from data.
    structure = json.dumps({f"c{i}": f"{t}[]" for i, t in enumerate(types)})
    unnest = ", ".join(f"UNNEST(j.c{i})" for i in range(len(types)))
    con.execute(
        f"INSERT INTO \"{table}\" SELECT {unnest} FROM (SELECT from_json(?, '{structure}') AS j)", [doc]
    )
