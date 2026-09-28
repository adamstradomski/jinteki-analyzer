"""CLI option checks that stop a command before it touches storage or the network."""

from __future__ import annotations

import pytest
from typer.testing import CliRunner

from market_research.cli import app


@pytest.mark.parametrize("extra", [["--since", "2026-01-01"], ["--plan"], ["--phase", "1"]])
def test_reload_cannot_be_combined_with_a_backfill_option(extra):
    r = CliRunner().invoke(app, ["backfill", "--cobra", "4990", "--abr", "5284", *extra])
    assert r.exit_code == 1
    assert "--cobra/--abr cannot be combined with --since, --plan or --phase." in r.output


@pytest.mark.parametrize("args", [[], ["--cobra", "4990", "--abr", "5284"]])
def test_fixtures_refresh_takes_exactly_one_tournament(args):
    r = CliRunner().invoke(app, ["fixtures", "refresh", *args])
    assert r.exit_code == 1
    assert "Give exactly one of --cobra or --abr." in r.output


def test_backfill_phase_is_1_to_3():
    r = CliRunner().invoke(app, ["backfill", "--phase", "4"])
    assert r.exit_code == 2  # Typer's usage error
