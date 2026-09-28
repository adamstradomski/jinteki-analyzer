"""Privacy scrubbing helpers: drift detection (field names only) and quarantine (no payloads)."""

from __future__ import annotations

import threading
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from market_research import logs
from market_research.records import sha256_hex

log = logs.get("market_research.scrub")


@dataclass
class IngestQuality:
    """Drift warnings and quarantine entries collected during a run. Never holds field values."""

    drift: dict[str, set[str]] = field(default_factory=dict)
    quarantine: list[dict[str, str]] = field(default_factory=list)
    rejected_refs: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def check_drift(self, kind: str, keys: Iterable[str], known: frozenset[str]) -> None:
        unknown = sorted({str(k) for k in keys} - known)
        if not unknown:
            return
        with self._lock:
            new = set(unknown) - self.drift.get(kind, set())
            self.drift.setdefault(kind, set()).update(unknown)
        if new:
            log.warning("drift_warning", payload_kind=kind, unknown_fields=sorted(new))

    def add_quarantine(self, key: str, error: str, payload: bytes | None) -> None:
        entry = {
            "key": key,
            "error": error[:200],
            "payload_sha256": "sha256:" + sha256_hex(payload or b""),
        }
        with self._lock:
            self.quarantine.append(entry)
        log.warning("quarantined", key=key, error=entry["error"])

    def rejected_ref(self) -> None:
        with self._lock:
            self.rejected_refs += 1

    def to_json(self) -> dict[str, Any]:
        return {
            "drift": {k: sorted(v) for k, v in sorted(self.drift.items())},
            "quarantine": sorted(self.quarantine, key=lambda e: (e["key"], e["error"])),
            "rejected_deck_refs": self.rejected_refs,
        }
