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


def test_sensitive_keys_are_redacted_at_any_depth():
    line = logged(r2_secret_access_key="x", nested={"password": "p", "ok": 1}, authorization="Bearer y")
    assert line["r2_secret_access_key"] == "[redacted]" and line["authorization"] == "[redacted]"
    assert line["nested"] == {"password": "[redacted]", "ok": 1}
