from __future__ import annotations

import random
from datetime import UTC, datetime
from pathlib import Path

import pytest

from market_research.clock import FakeClock
from market_research.config import Settings, load_settings

FIXTURES = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 9, 27, 4, 0, tzinfo=UTC)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock(NOW)


@pytest.fixture
def settings() -> Settings:
    return load_settings({"CONTACT": "ops@example.invalid"})


@pytest.fixture
def rng() -> random.Random:
    return random.Random(1234)
