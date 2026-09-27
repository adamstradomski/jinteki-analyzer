"""Structured JSON logs on stdout. Secrets are redacted before rendering."""

from __future__ import annotations

import sys
from collections.abc import MutableMapping
from typing import Any, TextIO

import structlog

_SECRETS: set[str] = set()
_SENSITIVE_KEYS = ("secret", "password", "token", "access_key", "authorization")


def register_secret(value: str | None) -> None:
    if value:
        _SECRETS.add(value)


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


def configure(stream: TextIO | None = None) -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            redact,
            structlog.processors.JSONRenderer(sort_keys=True),
        ],
        logger_factory=structlog.PrintLoggerFactory(file=stream or sys.stdout),
        cache_logger_on_first_use=False,
    )


def get(name: str = "market_research") -> Any:
    return structlog.get_logger(name)
