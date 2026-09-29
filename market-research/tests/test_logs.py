from __future__ import annotations

import io
import json

from market_research import logs


def logged(**event) -> dict:
    buf = io.StringIO()
    logs.configure(buf)
    logs.get("t").info("oops", **event)
    return json.loads(buf.getvalue())


def test_registered_secrets_are_redacted_inside_values():
    logs.register_secret("super-secret-value-123")
    line = logged(detail="token=super-secret-value-123", items=["a super-secret-value-123 b"])
    assert "super-secret-value-123" not in json.dumps(line)
    assert line["detail"] == "token=[redacted]"
    logs.forget_secrets()
    assert logged(detail="token=super-secret-value-123")["detail"] == "token=super-secret-value-123"


def test_sensitive_keys_are_redacted_at_any_depth():
    line = logged(r2_secret_access_key="x", nested={"password": "p", "ok": 1}, authorization="Bearer y")
    assert line["r2_secret_access_key"] == "[redacted]" and line["authorization"] == "[redacted]"
    assert line["nested"] == {"password": "[redacted]", "ok": 1}


class FailingStore:
    def put(self, *_args, **_kw):
        raise OSError("R2 unavailable")


def test_a_failed_log_upload_is_logged_and_never_raises():
    buf = io.StringIO()
    logs.configure(buf)
    key = logs.start_capture("run-all", "2026-09-27T04:00:00+00:00")
    assert key == "logs/2026-09-27/2026-09-27T040000Z-run-all.jsonl.gz"
    logs.get("t").info("hello")
    assert logs.upload(FailingStore()) is None  # type: ignore[arg-type]
    events = [json.loads(line) for line in buf.getvalue().splitlines()]
    assert events[-1] == {**events[-1], "event": "log_upload_failed", "key": key, "error": "OSError"}


def test_upload_without_a_capture_does_nothing():
    assert logs.upload(FailingStore()) is None  # type: ignore[arg-type]
