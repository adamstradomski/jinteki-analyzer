from __future__ import annotations

import io
import json
import random
from dataclasses import dataclass
from pathlib import Path

from market_research import logs
from market_research.clock import FakeClock
from market_research.config import Settings, load_settings
from market_research.http import PoliteHttp
from market_research.storage import Stores, local_stores
from market_research.testing import FixtureRoutes, FixtureTransport

FIXTURES = Path(__file__).parent / "fixtures"
HTTP = FIXTURES / "http"
EXPECTED = FIXTURES / "expected"
CANARY = "PII_CANARY"


@dataclass
class Env:
    settings: Settings
    clock: FakeClock
    routes: FixtureRoutes
    stores: Stores
    root: Path
    log: io.StringIO

    def http(self, **kw: object) -> PoliteHttp:
        return PoliteHttp(
            self.settings,
            self.clock,
            rng=random.Random(7),
            transport=FixtureTransport(self.routes),
            robots_store=self.stores.canonical,
            **kw,  # type: ignore[arg-type]
        )


def make_env(root: Path, clock: FakeClock, **env: str) -> Env:
    buf = io.StringIO()
    logs.configure(buf)
    settings = load_settings({"CONTACT": "ops@example.invalid", **env})
    return Env(settings, clock, FixtureRoutes(HTTP), local_stores(root / "store"), root, buf)


def all_files(root: Path) -> list[Path]:
    return sorted(p for p in root.rglob("*") if p.is_file())


def assert_no_canary(root: Path, *texts: str) -> None:
    hits = [str(p) for p in all_files(root) if CANARY.encode() in p.read_bytes()]
    assert not hits, f"canary found in {hits[:5]}"
    for t in texts:
        assert CANARY not in t, "canary found in text output"


def read_json(p: Path) -> object:
    return json.loads(p.read_text("utf-8"))
