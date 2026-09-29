"""Structured JSON logs on stdout. Secrets are redacted before rendering.

A run can also keep a copy of its log (`start_capture`) and upload it, gzipped, to the canonical
store (`upload`), since the runner keeps nothing on local disk between runs.
"""

from __future__ import annotations

import gzip
import sys
import tempfile
import threading
from collections.abc import MutableMapping
from typing import IO, TYPE_CHECKING, Any, TextIO

import structlog

if TYPE_CHECKING:
    from market_research.storage import ObjectStore

LOG_PREFIX = "logs/"

_SECRETS: set[str] = set()
_SENSITIVE_KEYS = ("secret", "password", "token", "access_key", "authorization")


def register_secret(value: str | None) -> None:
    if value:
        _SECRETS.add(value)


def forget_secrets() -> None:
    """Drops every registered secret (a new process starts with none; tests need the same)."""
    _SECRETS.clear()


def _redact_value(v: Any) -> Any:
    if isinstance(v, str):
        for s in _SECRETS:
            if s and s in v:
                v = v.replace(s, "[redacted]")
        return v
    if isinstance(v, dict):
        return {k: ("[redacted]" if _is_sensitive(k) else _redact_value(x)) for k, x in v.items()}
    if isinstance(v, list | tuple):
        return [_redact_value(x) for x in v]
    return v


def _is_sensitive(key: object) -> bool:
    k = str(key).lower()
    return any(s in k for s in _SENSITIVE_KEYS)


def redact(_logger: Any, _name: str, event: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    for k in list(event.keys()):
        event[k] = "[redacted]" if _is_sensitive(k) else _redact_value(event[k])
    return event


class _Capture:
    """Rendered log lines of the current run, spooled to a temporary file once large."""

    def __init__(self, key: str) -> None:
        self.key = key
        self.lock = threading.Lock()
        # Open for the whole run and closed by stop_capture, so not a `with` block.
        self.spool: IO[str] = tempfile.SpooledTemporaryFile(  # noqa: SIM115
            max_size=8 * 1024 * 1024, mode="w+", encoding="utf-8"
        )

    def write(self, text: str) -> None:
        with self.lock:
            self.spool.write(text)

    def gzipped(self) -> bytes:
        with self.lock:
            self.spool.flush()
            pos = self.spool.tell()
            self.spool.seek(0)
            data = self.spool.read().encode("utf-8")
            self.spool.seek(pos)
        return gzip.compress(data, mtime=0)


class _Active:
    capture: _Capture | None = None


_active = _Active()


class _Tee:
    """What structlog prints to: the real stream, plus the capture when one is active."""

    def __init__(self, stream: TextIO) -> None:
        self.stream = stream

    def write(self, text: str) -> int:
        n = self.stream.write(text)
        cap = _active.capture
        if cap is not None:
            cap.write(text)
        return n

    def flush(self) -> None:
        self.stream.flush()


def start_capture(command: str, started: str) -> str:
    """Starts keeping this run's log. `started` is an ISO UTC time; returns the upload key."""
    day, time_ = started[:10], started[11:19].replace(":", "")
    _active.capture = _Capture(f"{LOG_PREFIX}{day}/{day}T{time_}Z-{command}.jsonl.gz")
    return _active.capture.key


def stop_capture() -> None:
    cap, _active.capture = _active.capture, None
    if cap is not None:
        with cap.lock:
            cap.spool.close()


def upload(store: ObjectStore) -> str | None:
    """Uploads the log captured so far (replacing any earlier upload of this run). Never raises."""
    cap = _active.capture
    if cap is None:
        return None
    try:
        store.put(cap.key, cap.gzipped(), content_type="application/gzip")
    except Exception as e:  # a failed log upload must not change the run's outcome
        get("market_research.logs").warning("log_upload_failed", key=cap.key, error=type(e).__name__)
        return None
    return cap.key


def configure(stream: TextIO | None = None) -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            redact,
            structlog.processors.JSONRenderer(sort_keys=True),
        ],
        logger_factory=structlog.PrintLoggerFactory(file=_Tee(stream or sys.stdout)),  # type: ignore[arg-type]
        cache_logger_on_first_use=False,
    )


def get(name: str = "market_research") -> Any:
    return structlog.get_logger(name)
