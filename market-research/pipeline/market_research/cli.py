"""Command-line interface: `market-research`."""

from __future__ import annotations

import typer

app = typer.Typer(
    add_completion=False, no_args_is_help=True, help="Market Research tournament card-meta pipeline."
)


def main() -> None:
    app()
