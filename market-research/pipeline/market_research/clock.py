"""Injectable clock so politeness and scheduling can be tested without waiting."""

from __future__ import annotations

import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Protocol


class Clock(Protocol):
    def now(self) -> datetime: ...

    def monotonic(self) -> float: ...

    def sleep(self, seconds: float) -> None: ...


class SystemClock:
    def now(self) -> datetime:
        return datetime.now(UTC)

    def monotonic(self) -> float:
        return time.monotonic()

    def sleep(self, seconds: float) -> None:
        if seconds > 0:
            time.sleep(seconds)


class FakeClock:
    """A clock whose sleep advances time instantly. Thread-safe."""

    def __init__(self, start: datetime) -> None:
        if start.tzinfo is None:
            start = start.replace(tzinfo=UTC)
        self._now = start
        self._mono = 0.0
        self._lock = threading.Lock()
        self.sleeps: list[float] = []

    def now(self) -> datetime:
        with self._lock:
            return self._now

    def monotonic(self) -> float:
        with self._lock:
            return self._mono

    def sleep(self, seconds: float) -> None:
        with self._lock:
            self.sleeps.append(seconds)
            if seconds > 0:
                self._now += timedelta(seconds=seconds)
                self._mono += seconds

    def advance(self, seconds: float) -> None:
        """Moves wall time; the monotonic clock only moves forward."""
        with self._lock:
            self._now += timedelta(seconds=seconds)
            self._mono += max(seconds, 0.0)
