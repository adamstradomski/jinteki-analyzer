"""PoliteHttp: the one HTTP layer every source client uses.

Host allowlist, one request in flight per host, a jittered per-host interval, Retry-After and
exponential backoff, a per-run circuit breaker and request budget, a response size cap,
robots.txt, and conditional requests.
"""

from __future__ import annotations

import json
import random
import threading
import urllib.robotparser
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import urljoin, urlsplit

import httpx

from market_research import logs
from market_research.clock import Clock
from market_research.config import ALLOWED_HOSTS, HOST_GROUP, Settings
from market_research.storage import ObjectStore

log = logs.get("market_research.http")

MAX_REDIRECTS = 3
MAX_ATTEMPTS = 4
ROBOTS_AGENT = "MarketResearch"


class HttpError(Exception):
    """Base class for PoliteHttp errors."""


class RequestRefused(HttpError):
    """The URL is off the allowlist, disallowed by robots.txt, or redirects off-host."""


class BudgetExhausted(HttpError):
    """The per-run request budget for this host is spent."""


class HostTripped(HttpError):
    """The circuit breaker stopped this host for the rest of the run."""


class ResponseTooLarge(HttpError):
    """The response exceeded the size cap and was aborted."""


class FetchFailed(HttpError):
    """Retries were exhausted without tripping the breaker."""


@dataclass
class HttpResult:
    url: str
    status: int
    body: bytes
    headers: dict[str, str]

    @property
    def not_modified(self) -> bool:
        return self.status == 304

    @property
    def etag(self) -> str | None:
        return self.headers.get("etag")

    @property
    def last_modified(self) -> str | None:
        return self.headers.get("last-modified")

    def json(self) -> object:
        return json.loads(self.body)


@dataclass
class HostStats:
    requests: int = 0
    not_modified: int = 0
    failures: int = 0
    consecutive_failures: int = 0
    tripped: bool = False
    budget_exhausted: bool = False


@dataclass
class _HostState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    next_at: float = 0.0
    stats: HostStats = field(default_factory=HostStats)
    robots: urllib.robotparser.RobotFileParser | None = None
    robots_until: float = -1.0


def host_group(host: str) -> str:
    try:
        return HOST_GROUP[host]
    except KeyError:
        raise RequestRefused(f"host not on allowlist: {host}") from None


def check_url(url: str) -> tuple[str, str]:
    """Validates a URL against the allowlist and returns (host, group)."""
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or host not in ALLOWED_HOSTS or parts.port not in (None, 443):
        raise RequestRefused(f"refused URL for host {host!r}")
    if parts.username or parts.password:
        raise RequestRefused("credentials in URL")
    return host, host_group(host)


class PoliteHttp:
    def __init__(
        self,
        settings: Settings,
        clock: Clock,
        *,
        rng: random.Random | None = None,
        transport: httpx.BaseTransport | None = None,
        robots_store: ObjectStore | None = None,
        unlimited_budget: bool = False,
    ) -> None:
        self.settings = settings
        self.clock = clock
        self.rng = rng or random.Random()  # noqa: S311 - jitter, not crypto
        self.robots_store = robots_store
        self.unlimited_budget = unlimited_budget
        self._hosts: dict[str, _HostState] = {g: _HostState() for g in set(HOST_GROUP.values())}
        self._client = httpx.Client(
            http2=False,
            follow_redirects=False,
            transport=transport,
            timeout=httpx.Timeout(
                connect=settings.connect_timeout_s,
                read=settings.read_timeout_s,
                write=settings.read_timeout_s,
                pool=settings.read_timeout_s,
            ),
            headers={"User-Agent": settings.user_agent, "Accept-Encoding": "gzip"},
        )

    def close(self) -> None:
        self._client.close()

    # ----- public -----

    def stats(self) -> dict[str, HostStats]:
        return {g: s.stats for g, s in sorted(self._hosts.items())}

    def is_tripped(self, group: str) -> bool:
        return self._hosts[group].stats.tripped

    def remaining(self, group: str) -> float:
        if self.unlimited_budget:
            return float("inf")
        return self.settings.policy(group).budget - self._hosts[group].stats.requests

    def get(
        self,
        url: str,
        *,
        etag: str | None = None,
        last_modified: str | None = None,
        accept: str = "application/json",
    ) -> HttpResult:
        host, group = check_url(url)
        state = self._hosts[group]
        with state.lock:
            if state.stats.tripped:
                raise HostTripped(group)
            self._check_robots(host, group, state, url)
            headers = {"Accept": accept}
            if etag:
                headers["If-None-Match"] = etag
            if last_modified:
                headers["If-Modified-Since"] = last_modified
            result = self._request_following(url, headers, group, state)
            if result.status == 304:
                state.stats.not_modified += 1
            return result

    # ----- internals -----

    def _request_following(
        self, url: str, headers: dict[str, str], group: str, state: _HostState
    ) -> HttpResult:
        current = url
        for _ in range(MAX_REDIRECTS + 1):
            result = self._request_with_retries(current, headers, group, state)
            if result.status in (301, 302, 303, 307, 308):
                location = result.headers.get("location")
                if not location:
                    return result
                nxt = urljoin(current, location)
                nhost, ngroup = check_url(nxt)
                if nhost != urlsplit(url).hostname:
                    raise RequestRefused(f"cross-host redirect to {nhost}")
                self._check_robots(nhost, ngroup, state, nxt)
                current = nxt
                continue
            return result
        raise RequestRefused("too many redirects")

    def _request_with_retries(
        self, url: str, headers: dict[str, str], group: str, state: _HostState
    ) -> HttpResult:
        attempt = 0
        while True:
            attempt += 1
            retry_after: float | None = None
            try:
                result = self._send(url, headers, group, state)
            except ResponseTooLarge:
                raise
            except httpx.TransportError as e:
                log.warning("http_transport_error", host_group=group, error=type(e).__name__)
                result = None
            if result is not None and result.status < 500 and result.status != 429:
                state.stats.consecutive_failures = 0
                return result
            if result is not None:
                retry_after = self._retry_after(result.headers.get("retry-after"))
                log.warning("http_retryable_status", host_group=group, status=result.status)
            state.stats.failures += 1
            state.stats.consecutive_failures += 1
            if state.stats.consecutive_failures >= self.settings.max_failures:
                state.stats.tripped = True
                log.error("circuit_breaker_tripped", host_group=group)
                raise HostTripped(group)
            if attempt >= MAX_ATTEMPTS:
                raise FetchFailed(f"{group}: retries exhausted")
            backoff = min(self.settings.backoff_base_s * (2 ** (attempt - 1)), self.settings.backoff_cap_s)
            wait = min(retry_after, self.settings.backoff_cap_s) if retry_after is not None else backoff
            self.clock.sleep(wait)

    def _retry_after(self, value: str | None) -> float | None:
        if not value:
            return None
        v = value.strip()
        if v.isdigit():
            return float(v)
        try:
            when = parsedate_to_datetime(v)
        except (TypeError, ValueError):
            return None
        delta = (when - self.clock.now()).total_seconds()
        return max(delta, 0.0)

    def _wait_turn(self, group: str, state: _HostState) -> None:
        if not self.unlimited_budget and state.stats.requests >= self.settings.policy(group).budget:
            state.stats.budget_exhausted = True
            raise BudgetExhausted(group)
        wait = state.next_at - self.clock.monotonic()
        if wait > 0:
            self.clock.sleep(wait)

    def _schedule_next(self, group: str, state: _HostState) -> None:
        pol = self.settings.policy(group)
        factor = 1.0 + self.rng.uniform(-pol.jitter, pol.jitter)
        state.next_at = self.clock.monotonic() + pol.interval_s * factor

    def _send(self, url: str, headers: dict[str, str], group: str, state: _HostState) -> HttpResult:
        self._wait_turn(group, state)
        state.stats.requests += 1
        cap = self.settings.max_response_bytes
        try:
            with self._client.stream("GET", url, headers=headers) as resp:
                declared = resp.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > cap:
                    raise ResponseTooLarge(f"declared {declared} bytes")
                chunks: list[bytes] = []
                size = 0
                for chunk in resp.iter_bytes():
                    size += len(chunk)
                    if size > cap:
                        raise ResponseTooLarge(f"over {cap} bytes")
                    chunks.append(chunk)
                return HttpResult(
                    url=url,
                    status=resp.status_code,
                    body=b"".join(chunks),
                    headers={k.lower(): v for k, v in resp.headers.items()},
                )
        finally:
            self._schedule_next(group, state)

    # ----- robots.txt -----

    def _check_robots(self, host: str, group: str, state: _HostState, url: str) -> None:
        parser = self._robots_for(host, group, state)
        if not parser.can_fetch(ROBOTS_AGENT, url):
            raise RequestRefused(f"disallowed by robots.txt on {host}")

    def _robots_for(self, host: str, group: str, state: _HostState) -> urllib.robotparser.RobotFileParser:
        now_mono = self.clock.monotonic()
        if state.robots is not None and now_mono < state.robots_until:
            return state.robots
        text = self._load_cached_robots(host)
        if text is None:
            text = self._fetch_robots(host, group, state)
        parser = urllib.robotparser.RobotFileParser()
        parser.parse(text.splitlines())
        state.robots = parser
        state.robots_until = now_mono + self.settings.robots_ttl_s
        return parser

    def _robots_key(self, host: str) -> str:
        return f"state/robots/{host}.json"

    def _load_cached_robots(self, host: str) -> str | None:
        if self.robots_store is None:
            return None
        cached = self.robots_store.get_json(self._robots_key(host))
        if not isinstance(cached, dict):
            return None
        fetched = datetime.fromisoformat(str(cached.get("fetched_at")))
        if self.clock.now() - fetched > timedelta(seconds=self.settings.robots_ttl_s):
            return None
        return str(cached.get("body", ""))

    def _fetch_robots(self, host: str, group: str, state: _HostState) -> str:
        url = f"https://{host}/robots.txt"
        result = self._request_with_retries(url, {"Accept": "text/plain"}, group, state)
        if result.status == 200:
            text = result.body.decode("utf-8", "replace")
        elif 400 <= result.status < 500:
            text = ""  # no robots.txt: everything allowed
        else:
            text = "User-agent: *\nDisallow: /\n"
        if self.robots_store is not None:
            self.robots_store.put_json(
                self._robots_key(host), {"fetched_at": self.clock.now().isoformat(), "body": text}
            )
        return text
