from __future__ import annotations

import random

import httpx
import pytest
import respx

from market_research.clock import FakeClock
from market_research.config import Settings
from market_research.http import (
    BudgetExhausted,
    FetchFailed,
    HostTripped,
    PoliteHttp,
    RequestRefused,
    ResponseTooLarge,
)
from market_research.storage import LocalObjectStore

ABR = "https://alwaysberunning.net"
NRDB = "https://netrunnerdb.com"


def make(settings: Settings, clock: FakeClock, rng: random.Random, **kw: object) -> PoliteHttp:
    return PoliteHttp(settings, clock, rng=rng, **kw)  # type: ignore[arg-type]


@pytest.fixture
def mock():
    with respx.mock(assert_all_called=False) as m:
        for host in (
            "alwaysberunning.net",
            "netrunnerdb.com",
            "tournaments.nullsignal.games",
            "api.netrunnerdb.com",
        ):
            m.get(f"https://{host}/robots.txt").respond(200, text="User-agent: *\nDisallow: /private/\n")
        yield m


def test_rate_limit_and_jitter_bounds(settings, clock, rng, mock):
    mock.get(f"{ABR}/api/x").respond(200, json={})
    h = make(settings, clock, rng)
    for _ in range(20):
        h.get(f"{ABR}/api/x")
    waits = [s for s in clock.sleeps if s > 0]
    # robots + 20 requests = 21 requests; every one after the first waits 2s ±20%.
    assert len(waits) == 20
    assert all(1.6 - 1e-9 <= w <= 2.4 + 1e-9 for w in waits)
    assert len({round(w, 6) for w in waits}) > 1  # jittered
    assert h.stats()["abr"].requests == 21


def test_user_agent_and_gzip(settings, clock, rng, mock):
    route = mock.get(f"{ABR}/api/x").respond(200, json={})
    make(settings, clock, rng).get(f"{ABR}/api/x")
    req = route.calls.last.request
    assert req.headers["user-agent"].startswith(
        "MarketResearch/0.1.0 (+https://jinteki.win/market-research; "
    )
    assert "ops@example.invalid" in req.headers["user-agent"]
    assert "gzip" in req.headers["accept-encoding"]


def test_retry_after_is_honoured(settings, clock, rng, mock):
    mock.get(f"{ABR}/api/x").mock(
        side_effect=[httpx.Response(429, headers={"Retry-After": "17"}), httpx.Response(200, json={})]
    )
    r = make(settings, clock, rng).get(f"{ABR}/api/x")
    assert r.status == 200
    assert 17 in clock.sleeps


def test_retry_after_http_date(settings, clock, rng, mock):
    mock.get(f"{ABR}/api/x").mock(
        side_effect=[
            httpx.Response(503, headers={"Retry-After": "Sun, 27 Sep 2026 04:00:30 GMT"}),
            httpx.Response(200, json={}),
        ]
    )
    make(settings, clock, rng).get(f"{ABR}/api/x")
    assert any(25 <= s <= 30 for s in clock.sleeps)


def test_exponential_backoff_then_fail(settings, clock, rng, mock):
    settings.max_failures = 99
    mock.get(f"{ABR}/api/x").respond(500)
    h = make(settings, clock, rng)
    with pytest.raises(FetchFailed):
        h.get(f"{ABR}/api/x")
    backoffs = [s for s in clock.sleeps if s in (2.0, 4.0, 8.0)]
    assert backoffs == [2.0, 4.0, 8.0]


def test_backoff_cap(settings, clock, rng, mock):
    settings.backoff_base_s = 200
    settings.max_failures = 99
    mock.get(f"{ABR}/api/x").respond(502)
    with pytest.raises(FetchFailed):
        make(settings, clock, rng).get(f"{ABR}/api/x")
    assert max(clock.sleeps) == 300


def test_circuit_breaker_trips_after_five_failures(settings, clock, rng, mock):
    mock.get(f"{ABR}/api/x").respond(500)
    ok = mock.get(f"{NRDB}/api/ok").respond(200, json={})
    h = make(settings, clock, rng)
    with pytest.raises(FetchFailed):
        h.get(f"{ABR}/api/x")  # 4 failures
    with pytest.raises(HostTripped):
        h.get(f"{ABR}/api/x")  # 5th trips
    assert h.is_tripped("abr")
    before = h.stats()["abr"].requests
    with pytest.raises(HostTripped):
        h.get(f"{ABR}/api/x")
    assert h.stats()["abr"].requests == before  # no further requests to a tripped host
    h.get(f"{NRDB}/api/ok")  # other hosts unaffected
    assert ok.called


def test_budget_exhaustion(settings, clock, rng, mock):
    settings.hosts["abr"].budget = 3
    mock.get(f"{ABR}/api/x").respond(200, json={})
    h = make(settings, clock, rng)
    h.get(f"{ABR}/api/x")
    h.get(f"{ABR}/api/x")  # robots + 2 = 3
    with pytest.raises(BudgetExhausted):
        h.get(f"{ABR}/api/x")
    assert h.remaining("abr") == 0


def test_unlimited_budget(settings, clock, rng, mock):
    settings.hosts["abr"].budget = 1
    mock.get(f"{ABR}/api/x").respond(200, json={})
    h = make(settings, clock, rng, unlimited_budget=True)
    for _ in range(3):
        h.get(f"{ABR}/api/x")
    assert h.remaining("abr") == float("inf")


def test_conditional_headers_and_304(settings, clock, rng, mock):
    route = mock.get(f"{NRDB}/api/c").respond(304)
    h = make(settings, clock, rng)
    r = h.get(f"{NRDB}/api/c", etag='"abc"', last_modified="Sat, 26 Sep 2026 10:00:00 GMT")
    assert r.not_modified
    req = route.calls.last.request
    assert req.headers["if-none-match"] == '"abc"'
    assert req.headers["if-modified-since"] == "Sat, 26 Sep 2026 10:00:00 GMT"
    assert h.stats()["nrdb"].not_modified == 1


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example/x",
        "http://alwaysberunning.net/api",
        "https://alwaysberunning.net:8443/api",
        "https://user:pw@alwaysberunning.net/api",
        "https://makers-eye.com/",
        "file:///etc/passwd",
    ],
)
def test_off_allowlist_refused(settings, clock, rng, mock, url):
    with pytest.raises(RequestRefused):
        make(settings, clock, rng).get(url)


def test_cross_host_redirect_refused(settings, clock, rng, mock):
    mock.get(f"{ABR}/r1").respond(302, headers={"Location": "https://netrunnerdb.com/x"})
    mock.get(f"{ABR}/r2").respond(302, headers={"Location": "https://evil.example/x"})
    h = make(settings, clock, rng)
    with pytest.raises(RequestRefused):
        h.get(f"{ABR}/r1")
    with pytest.raises(RequestRefused):
        h.get(f"{ABR}/r2")


def test_same_host_redirect_followed(settings, clock, rng, mock):
    mock.get(f"{ABR}/r").respond(301, headers={"Location": "/api/final"})
    mock.get(f"{ABR}/api/final").respond(200, json={"ok": 1})
    assert make(settings, clock, rng).get(f"{ABR}/r").json() == {"ok": 1}


def test_size_cap_aborts(settings, clock, rng, mock):
    settings.max_response_bytes = 1000
    mock.get(f"{ABR}/big").respond(200, content=b"x" * 5000)
    mock.get(f"{ABR}/declared").respond(200, headers={"Content-Length": "999999"}, content=b"x")
    h = make(settings, clock, rng)
    with pytest.raises(ResponseTooLarge):
        h.get(f"{ABR}/big")
    with pytest.raises(ResponseTooLarge):
        h.get(f"{ABR}/declared")


def test_robots_disallow_obeyed(settings, clock, rng, mock):
    route = mock.get(f"{ABR}/private/thing").respond(200)
    with pytest.raises(RequestRefused):
        make(settings, clock, rng).get(f"{ABR}/private/thing")
    assert not route.called


def test_robots_cached_in_store_for_24h(settings, clock, rng, mock, tmp_path):
    store = LocalObjectStore(tmp_path)
    mock.get(f"{ABR}/api/x").respond(200, json={})
    make(settings, clock, rng, robots_store=store).get(f"{ABR}/api/x")
    robots = mock.routes[0]
    assert robots.call_count == 1
    make(settings, clock, rng, robots_store=store).get(f"{ABR}/api/x")
    assert robots.call_count == 1  # served from the store
    clock.advance(25 * 3600)
    make(settings, clock, rng, robots_store=store).get(f"{ABR}/api/x")
    assert robots.call_count == 2


def test_missing_robots_allows_and_5xx_robots_disallows(settings, clock, rng):
    with respx.mock() as m:
        m.get(f"{ABR}/robots.txt").respond(404)
        m.get(f"{ABR}/a").respond(200)
        m.get(f"{NRDB}/robots.txt").respond(503)
        make(settings, clock, rng).get(f"{ABR}/a")
        settings.max_failures = 99
        with pytest.raises(FetchFailed):
            make(settings, clock, rng).get(f"{NRDB}/a")


def test_transport_error_retried(settings, clock, rng, mock):
    mock.get(f"{ABR}/t").mock(side_effect=[httpx.ConnectError("boom"), httpx.Response(200, json={})])
    assert make(settings, clock, rng).get(f"{ABR}/t").status == 200


def test_404_is_not_a_failure(settings, clock, rng, mock):
    mock.get(f"{ABR}/nf").respond(404)
    h = make(settings, clock, rng)
    assert h.get(f"{ABR}/nf").status == 404
    assert h.stats()["abr"].consecutive_failures == 0
