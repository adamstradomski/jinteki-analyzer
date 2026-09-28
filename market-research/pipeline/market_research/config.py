"""Configuration. Secrets and settings come only from environment variables."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from typing import Any

from pydantic import BaseModel, Field, SecretStr

from market_research import __version__

ABR_HOST = "alwaysberunning.net"
COBRA_HOST = "tournaments.nullsignal.games"
NRDB_HOST = "netrunnerdb.com"
NRDB_API_HOST = "api.netrunnerdb.com"
ALLOWED_HOSTS: frozenset[str] = frozenset({ABR_HOST, COBRA_HOST, NRDB_HOST, NRDB_API_HOST})

# Hosts that share one politeness budget and bucket: api.netrunnerdb.com and
# netrunnerdb.com are run by the same people, so they are treated as one host.
HOST_GROUP: Mapping[str, str] = {
    ABR_HOST: "abr",
    COBRA_HOST: "cobra",
    NRDB_HOST: "nrdb",
    NRDB_API_HOST: "nrdb",
}

SIDES = ("corp", "runner")


class HostPolicy(BaseModel):
    interval_s: float
    jitter: float = 0.2
    budget: int = 400


def _default_policies() -> dict[str, HostPolicy]:
    return {
        "abr": HostPolicy(interval_s=2.0),
        "cobra": HostPolicy(interval_s=2.0),
        "nrdb": HostPolicy(interval_s=1.0),
    }


class Thresholds(BaseModel):
    min_players: int = 8
    coverage_hc: float = 0.7
    min_games: int = 30
    min_entries: int = 20
    period_months: int = 3


class Settings(BaseModel):
    r2_account_id: str | None = None
    r2_access_key_id: SecretStr | None = None
    r2_secret_access_key: SecretStr | None = None
    bucket_source: str = "mr-source"
    bucket_canonical: str = "mr-canonical"
    bucket_published: str = "mr-published"
    local_store: str | None = None
    contact: str = "unset"
    hosts: dict[str, HostPolicy] = Field(default_factory=_default_policies)
    thresholds: Thresholds = Thresholds()
    connect_timeout_s: float = 10.0
    read_timeout_s: float = 30.0
    max_response_bytes: int = 5 * 1024 * 1024
    max_failures: int = 5
    backoff_base_s: float = 2.0
    backoff_cap_s: float = 300.0
    robots_ttl_s: float = 24 * 3600
    cobra_page_size: int = 250
    abr_page_size: int = 200
    flush_every_items: int = 100
    flush_every_s: float = 300.0

    @property
    def user_agent(self) -> str:
        return f"MarketResearch/{__version__} (+https://jinteki.win/market-research; {self.contact})"

    def policy(self, group: str) -> HostPolicy:
        return self.hosts[group]

    def redacted(self) -> dict[str, Any]:
        """Settings safe to log: secrets are never included."""
        d = self.model_dump(exclude={"r2_access_key_id", "r2_secret_access_key"})
        d["r2_credentials"] = "set" if self.r2_access_key_id else "unset"
        return d


def _float(env: Mapping[str, str], key: str, default: float) -> float:
    v = env.get(key)
    return float(v) if v not in (None, "") else default


def _int(env: Mapping[str, str], key: str, default: int) -> int:
    v = env.get(key)
    return int(v) if v not in (None, "") else default


def load_settings(env: Mapping[str, str] | None = None) -> Settings:
    e = dict(os.environ if env is None else env)
    hosts = _default_policies()
    for group, pol in hosts.items():
        g = group.upper()
        pol.interval_s = _float(e, f"MR_RATE_{g}_S", pol.interval_s)
        pol.jitter = _float(e, f"MR_JITTER_{g}", pol.jitter)
        pol.budget = _int(e, f"MR_BUDGET_{g}", _int(e, "MR_BUDGET", pol.budget))
    t = Thresholds(
        min_players=_int(e, "MR_MIN_PLAYERS", 8),
        coverage_hc=_float(e, "MR_COVERAGE_HC", 0.7),
        min_games=_int(e, "MR_MIN_GAMES", 30),
        min_entries=_int(e, "MR_MIN_ENTRIES", 20),
        period_months=_int(e, "MR_PERIOD_MONTHS", 3),
    )
    key_id = e.get("R2_ACCESS_KEY_ID")
    secret = e.get("R2_SECRET_ACCESS_KEY")
    return Settings(
        r2_account_id=e.get("R2_ACCOUNT_ID") or None,
        r2_access_key_id=SecretStr(key_id) if key_id else None,
        r2_secret_access_key=SecretStr(secret) if secret else None,
        bucket_source=e.get("MR_BUCKET_SOURCE", "mr-source"),
        bucket_canonical=e.get("MR_BUCKET_CANONICAL", "mr-canonical"),
        bucket_published=e.get("MR_BUCKET_PUBLISHED", "mr-published"),
        local_store=e.get("MR_LOCAL_STORE") or None,
        contact=e.get("CONTACT", "unset"),
        hosts=hosts,
        thresholds=t,
    )


@dataclass(frozen=True)
class TierConfig:
    groups: list[dict[str, str]]
    abr_types: dict[str, str]
    cobra_type_keywords: list[tuple[str, str]]
    default_group: str
    online_abr_types: frozenset[str]

    def group_ids(self) -> list[str]:
        return [g["id"] for g in self.groups]

    def abr_tier(self, type_value: object) -> tuple[str, str]:
        """Returns (type label, tier group) for an ABR type id or name."""
        key = str(type_value).strip().lower() if type_value is not None else ""
        label = self.abr_types.get(key, key)
        return label, self._group_for_label(label)

    def cobra_tier(self, type_name: str | None) -> tuple[str, str]:
        label = (type_name or "").strip().lower()
        return label, self._group_for_label(label)

    def _group_for_label(self, label: str) -> str:
        for keyword, group in self.cobra_type_keywords:
            if keyword in label:
                return group
        return self.default_group


@lru_cache(maxsize=1)
def tier_config() -> TierConfig:
    raw = json.loads(resources.files("market_research").joinpath("data/tiers.json").read_text("utf-8"))
    return TierConfig(
        groups=raw["groups"],
        abr_types={str(k).lower(): v for k, v in raw["abr_types"].items()},
        cobra_type_keywords=[(k.lower(), g) for k, g in raw["type_keywords"]],
        default_group=raw["default_group"],
        online_abr_types=frozenset(str(x).lower() for x in raw["online_types"]),
    )
