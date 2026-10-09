from __future__ import annotations

import io
import random
from datetime import UTC, datetime
from pathlib import Path

import pytest

from market_research.clock import FakeClock
from market_research.config import Settings, load_settings

FIXTURES = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 9, 27, 4, 0, tzinfo=UTC)


@pytest.fixture(autouse=True)
def _fresh_logs():
    """Leaves no log setup behind: the CLI points structlog at the runner's stdout, closed after the
    test, and registers secrets for redaction, which are forgotten again."""
    yield
    from market_research import logs

    logs.stop_capture()
    logs.configure(io.StringIO())
    logs.forget_secrets()


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock(NOW)


@pytest.fixture
def settings() -> Settings:
    return load_settings({"CONTACT": "ops@example.invalid"})


@pytest.fixture
def rng() -> random.Random:
    return random.Random(1234)


@pytest.fixture(scope="session")
def fixture_run(tmp_path_factory):
    """One ingest + normalize over the recorded fixtures, shared by read-only tests."""
    from helpers import make_env
    from market_research.ingest import Ingestor
    from market_research.normalize import normalize

    root = tmp_path_factory.mktemp("fixture_run")
    env = make_env(root, FakeClock(NOW))
    ing = Ingestor(env.settings, env.clock, env.http(), env.stores, parallel=False)
    ing.run()
    data, q = normalize(env.stores, env.settings)
    return env, ing, data, q
