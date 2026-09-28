"""Serve recorded fixtures instead of live hosts (tests and `--fixtures` development runs).

`routes.json` lists responses by URL. Query parameters are compared order-independently. The
transport honours If-None-Match / If-Modified-Since against the recorded ETag / Last-Modified, so a
second run over unchanged fixtures sees 304s exactly as it would from a real server.
"""

from __future__ import annotations

import json
import threading
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlsplit

import httpx


def normalize_url(url: str) -> str:
    p = urlsplit(url)
    q = "&".join(f"{k}={v}" for k, v in sorted(parse_qsl(p.query, keep_blank_values=True)))
    return f"{p.scheme}://{p.hostname}{p.path}" + (f"?{q}" if q else "")


class FixtureRoutes:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        routes = json.loads((self.root / "routes.json").read_text("utf-8"))
        self.routes: dict[str, dict[str, Any]] = {normalize_url(r["url"]): r for r in routes}
        self.overrides: dict[str, list[httpx.Response]] = {}
        self.calls: list[httpx.Request] = []
        self._lock = threading.Lock()

    def override(self, url: str, *responses: httpx.Response) -> None:
        """Queue responses for a URL ahead of its recorded fixture (last one repeats)."""
        self.overrides[normalize_url(url)] = list(responses)

    def body(self, url: str) -> bytes:
        r = self.routes[normalize_url(url)]
        return (self.root / r["file"]).read_bytes() if r["file"] else b""

    def respond(self, request: httpx.Request) -> httpx.Response:
        key = normalize_url(str(request.url))
        with self._lock:
            self.calls.append(request)
            queued = self.overrides.get(key)
            if queued:
                resp = queued.pop(0) if len(queued) > 1 else queued[0]
                return httpx.Response(resp.status_code, headers=resp.headers, content=resp.content)
        route = self.routes.get(key)
        if route is None:
            return httpx.Response(404, json={"error": "no fixture"})
        headers = dict(route["headers"])
        etag = headers.get("ETag")
        lm = headers.get("Last-Modified")
        inm = request.headers.get("if-none-match")
        ims = request.headers.get("if-modified-since")
        if etag and inm and inm == etag:
            return httpx.Response(304, headers={"ETag": etag})
        if lm and ims and not inm:
            try:
                if parsedate_to_datetime(lm) <= parsedate_to_datetime(ims):
                    return httpx.Response(304, headers={"Last-Modified": lm})
            except (TypeError, ValueError):
                pass
        content = (self.root / route["file"]).read_bytes() if route["file"] else b""
        return httpx.Response(route["status"], headers=headers, content=content)


class FixtureTransport(httpx.BaseTransport):
    def __init__(self, routes: FixtureRoutes) -> None:
        self.routes = routes

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        return self.routes.respond(request)
