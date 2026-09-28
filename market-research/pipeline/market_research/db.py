"""DuckDB helpers shared by the stages that stage Python rows in a table."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import duckdb


def insert_rows(con: duckdb.DuckDBPyConnection, table: str, rows: Sequence[Sequence[Any]]) -> None:
    """Appends rows to `table` in one statement.

    `executemany` runs one INSERT per row, which is slow for the thousands of rows a run stages.
    Here each column goes in as one list parameter and UNNEST zips the lists back into rows.
    """
    if not rows:
        return
    columns = [list(c) for c in zip(*rows, strict=True)]
    unnest = ", ".join("UNNEST(?)" for _ in columns)
    con.execute(f'INSERT INTO "{table}" SELECT {unnest}', columns)
