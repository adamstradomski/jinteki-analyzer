"""Settings come only from environment variables (see .env.example)."""

from __future__ import annotations

import pytest

from market_research import __version__
from market_research.config import load_settings

# Every variable in README.md's configuration table.
VARIABLES = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "MR_BUCKET_SOURCE",
    "MR_BUCKET_CANONICAL",
    "MR_BUCKET_PUBLISHED",
    "MR_LOCAL_STORE",
    "CONTACT",
    "MR_BUDGET",
    *(f"MR_{kind}_{host}" for kind in ("BUDGET", "JITTER") for host in ("ABR", "COBRA", "NRDB")),
    *(f"MR_RATE_{host}_S" for host in ("ABR", "COBRA", "NRDB")),
    "MR_MIN_PLAYERS",
    "MR_COVERAGE_HC",
    "MR_MIN_GAMES",
    "MR_MIN_ENTRIES",
    "MR_MIN_SPLASH_DECKS",
    "MR_PERIOD_MONTHS",
]


def test_defaults():
    s = load_settings({})
    assert {g: (p.interval_s, p.jitter, p.budget) for g, p in s.hosts.items()} == {
        "abr": (2.0, 0.2, 400),
        "cobra": (2.0, 0.2, 400),
        "nrdb": (1.0, 0.2, 400),
    }
    t = s.thresholds
    assert (
        t.min_players,
        t.coverage_hc,
        t.min_games,
        t.min_entries,
        t.min_splash_decks,
        t.period_months,
    ) == (
        8,
        0.7,
        30,
        20,
        20,
        3,
    )
    assert (s.bucket_source, s.bucket_canonical, s.bucket_published) == (
        "mr-source",
        "mr-canonical",
        "mr-published",
    )
    assert s.local_store is None and s.r2_account_id is None and s.r2_access_key_id is None
    assert s.contact == "unset"


def test_per_host_rate_jitter_and_budget():
    s = load_settings(
        {
            "MR_BUDGET": "50",
            "MR_BUDGET_NRDB": "7",
            "MR_RATE_ABR_S": "3.5",
            "MR_RATE_COBRA_S": "4",
            "MR_JITTER_COBRA": "0",
        }
    )
    assert (s.policy("abr").budget, s.policy("cobra").budget, s.policy("nrdb").budget) == (50, 50, 7)
    assert (s.policy("abr").interval_s, s.policy("cobra").interval_s, s.policy("nrdb").interval_s) == (
        3.5,
        4.0,
        1.0,
    )
    assert (s.policy("abr").jitter, s.policy("cobra").jitter) == (0.2, 0.0)
    # Every load starts from fresh defaults.
    assert load_settings({}).policy("abr").budget == 400


def test_thresholds_and_storage():
    s = load_settings(
        {
            "MR_MIN_PLAYERS": "12",
            "MR_COVERAGE_HC": "0.8",
            "MR_MIN_GAMES": "40",
            "MR_MIN_ENTRIES": "25",
            "MR_MIN_SPLASH_DECKS": "15",
            "MR_PERIOD_MONTHS": "6",
            "MR_BUCKET_PUBLISHED": "mr-published-test",
            "MR_LOCAL_STORE": "/tmp/store",
            "R2_ACCOUNT_ID": "acct",
        }
    )
    t = s.thresholds
    assert (
        t.min_players,
        t.coverage_hc,
        t.min_games,
        t.min_entries,
        t.min_splash_decks,
        t.period_months,
    ) == (
        12,
        0.8,
        40,
        25,
        15,
        6,
    )
    assert (s.bucket_published, s.local_store, s.r2_account_id) == ("mr-published-test", "/tmp/store", "acct")


def test_empty_values_mean_the_default():
    # docker --env-file passes a listed but unfilled variable as an empty string (.env.example
    # lists CONTACT= that way).
    assert load_settings(dict.fromkeys(VARIABLES, "")) == load_settings({})


def test_a_bad_number_fails_at_start():
    with pytest.raises(ValueError):
        load_settings({"MR_BUDGET": "lots"})


def test_secrets_stay_out_of_repr_and_the_logged_settings():
    s = load_settings(
        {"R2_ACCESS_KEY_ID": "key-id-1", "R2_SECRET_ACCESS_KEY": "secret-2", "CONTACT": "ops@example.invalid"}
    )
    assert s.r2_secret_access_key is not None and s.r2_secret_access_key.get_secret_value() == "secret-2"
    for text in (repr(s), str(s.redacted())):
        assert "key-id-1" not in text and "secret-2" not in text
    assert s.redacted()["r2_credentials"] == "set"
    assert load_settings({}).redacted()["r2_credentials"] == "unset"
    assert (
        s.user_agent
        == f"MarketResearch/{__version__} (+https://jinteki.win/market-research; ops@example.invalid)"
    )
