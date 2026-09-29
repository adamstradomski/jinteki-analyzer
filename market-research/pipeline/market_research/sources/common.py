"""Shared helpers for source clients: strict ID parsing, URL building and JSON:API pages.

IDs and integers are checked with `fullmatch` and `[0-9]`: with `match`, a pattern ending in `$`
also accepts a trailing newline ("123\\n"), and `\\d` also matches other scripts' digits ("٧").
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from datetime import date, datetime
from typing import Any
from urllib.parse import urlencode

from market_research.http import PoliteHttp

INT_ID = re.compile(r"^[0-9]{1,9}$")
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
SLUG_ID = re.compile(r"^[a-z0-9_]{1,80}$")
PRINTING_ID = re.compile(r"^[0-9]{1,6}$")


class ParseError(ValueError):
    """A response could not be turned into a record."""


class NotFound(Exception):
    """The source says the entity does not exist or is not visible."""


def strict_int(value: object) -> int:
    s = str(value)
    if not INT_ID.fullmatch(s):
        raise ParseError("bad integer id")
    return int(s)


def strict_uuid_or_int(value: str) -> str:
    v = value.lower()
    if INT_ID.fullmatch(v) or UUID.fullmatch(v):
        return v
    raise ParseError("bad deck id")


def url(base: str, path: str, params: dict[str, object] | None = None) -> str:
    """Builds a URL from constant parts and validated values; never from data."""
    q = ("?" + urlencode(sorted((k, str(v)) for k, v in params.items()))) if params else ""
    return f"{base}{path}{q}"


def parse_date(value: object) -> str:
    """Accepts YYYY-MM-DD, YYYY.MM.DD. and ISO timestamps; returns YYYY-MM-DD."""
    s = str(value or "").strip()
    m = re.match(r"^([0-9]{4})[-.]([0-9]{2})[-.]([0-9]{2})", s)
    if not m:
        raise ParseError("bad date")
    try:
        return date(int(m[1]), int(m[2]), int(m[3])).isoformat()
    except ValueError:  # e.g. 2026.02.30.: callers skip a ParseError, not any ValueError
        raise ParseError("bad date") from None


def opt_int(value: object) -> int | None:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    s = str(value)
    if re.fullmatch(r"-?[0-9]+", s):
        return int(s)
    raise ParseError("bad integer")


def opt_float(value: object) -> float | None:
    if value is None or value == "":
        return None
    if isinstance(value, int | float) and not isinstance(value, bool):
        return round(float(value), 6)
    try:
        return round(float(str(value)), 6)
    except ValueError:
        raise ParseError("bad number") from None


def as_bool(value: object) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return value != 0
    return str(value).strip().lower() in ("1", "true", "yes")


def opt_printing(value: object) -> str | None:
    # ABR sometimes sends the string "null" instead of JSON null for a missing identity.
    if value is None or value in ("", "null"):
        return None
    s = str(value)
    if not PRINTING_ID.fullmatch(s):
        raise ParseError("bad printing id")
    return s


def opt_title(value: object) -> str | None:
    """A public event name: control characters removed, whitespace collapsed, at most 120 characters."""
    if value is None:
        return None
    s = " ".join("".join(ch if ch.isprintable() else " " for ch in str(value)).split())
    return s[:120] or None


def opt_slug(value: object) -> str | None:
    if value is None or value == "":
        return None
    s = str(value)
    if not SLUG_ID.fullmatch(s):
        raise ParseError("bad card id")
    return s


def jsonapi_pages(
    http: PoliteHttp, base: str, path: str, *, size: int, extra: dict[str, object] | None = None
) -> Iterator[list[dict[str, Any]]]:
    """Yields JSON:API `data` arrays page by page, building every page URL itself."""
    number = 1
    while True:
        params: dict[str, object] = {"page[number]": number, "page[size]": size}
        params.update(extra or {})
        r = http.get(url(base, path, params), accept="application/vnd.api+json, application/json")
        if r.status != 200:
            raise NotFound(f"status {r.status}")
        doc = r.json()
        if not isinstance(doc, dict) or not isinstance(doc.get("data"), list):
            raise ParseError("not a JSON:API document")
        data = doc["data"]
        yield data
        if len(data) < size:
            return
        number += 1


def attributes(item: dict[str, Any]) -> dict[str, Any]:
    attrs = item.get("attributes")
    if not isinstance(attrs, dict):
        raise ParseError("JSON:API item without attributes")
    out = dict(attrs)
    out.setdefault("id", item.get("id"))
    return out


def iso_now(now: datetime) -> str:
    return now.replace(microsecond=0).isoformat().replace("+00:00", "Z")
