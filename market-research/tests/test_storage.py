"""R2ObjectStore against a stubbed S3 client: which errors mean "missing" and which propagate."""

from __future__ import annotations

import io

import boto3
import pytest
from botocore.exceptions import ClientError
from botocore.response import StreamingBody
from botocore.stub import Stubber

from market_research.storage import LocalObjectStore, ObjectHead, R2ObjectStore

BUCKET = "mr-published"


@pytest.fixture
def s3():
    client = boto3.client(
        "s3",
        endpoint_url="https://example.invalid",
        aws_access_key_id="test",
        aws_secret_access_key="test",
        region_name="auto",
    )
    with Stubber(client) as stub:
        yield client, stub
        stub.assert_no_pending_responses()


def test_exists_uses_head_not_get(s3):
    client, stub = s3
    stub.add_response(
        "head_object",
        {
            "ContentType": "application/json",
            "CacheControl": "public, max-age=60",
            "ETag": '"abc"',
            "ContentLength": 42,
        },
        {"Bucket": BUCKET, "Key": "manifest.json"},
    )
    assert R2ObjectStore(BUCKET, client).exists("manifest.json")  # a get_object would fail the stub


@pytest.mark.parametrize("code", ["404", "NoSuchKey", "NotFound"])
def test_exists_is_false_only_for_a_missing_key(s3, code):
    client, stub = s3
    stub.add_client_error("head_object", service_error_code=code, http_status_code=404)
    assert not R2ObjectStore(BUCKET, client).exists("v=2026-09-27T040000Z/catalog/cards.json")


@pytest.mark.parametrize(("code", "status"), [("403", 403), ("AccessDenied", 403), ("500", 500)])
def test_exists_propagates_other_errors(s3, code, status):
    """A denied or failed HEAD must not read as "free": free_version() would reuse a published version."""
    client, stub = s3
    stub.add_client_error("head_object", service_error_code=code, http_status_code=status)
    with pytest.raises(ClientError):
        R2ObjectStore(BUCKET, client).exists("manifest.json")


def test_head_returns_metadata_without_the_body(s3):
    client, stub = s3
    stub.add_response(
        "head_object",
        {
            "ContentType": "application/json",
            "CacheControl": "public, max-age=60",
            "ETag": '"abc"',
            "ContentLength": 42,
        },
        {"Bucket": BUCKET, "Key": "manifest.json"},
    )
    stub.add_client_error("head_object", service_error_code="404", http_status_code=404)
    store = R2ObjectStore(BUCKET, client)
    assert store.head("manifest.json") == ObjectHead("application/json", "public, max-age=60", "abc", 42)
    assert store.head("gone.json") is None


def test_get_returns_none_only_for_a_missing_key(s3):
    client, stub = s3
    body = b'{"a":1}'
    stub.add_response(
        "get_object",
        {"Body": StreamingBody(io.BytesIO(body), len(body))},
        {"Bucket": BUCKET, "Key": "state/x.json"},
    )
    stub.add_client_error("get_object", service_error_code="NoSuchKey", http_status_code=404)
    stub.add_client_error("get_object", service_error_code="AccessDenied", http_status_code=403)
    store = R2ObjectStore(BUCKET, client)
    assert store.get_json("state/x.json") == {"a": 1}
    assert store.get("state/y.json") is None
    with pytest.raises(ClientError):
        store.get("state/z.json")


def test_put_and_list(s3):
    client, stub = s3
    stub.add_response(
        "put_object",
        {},
        {
            "Bucket": BUCKET,
            "Key": "manifest.json",
            "Body": b"{}",
            "ContentType": "application/json",
            "CacheControl": "public, max-age=60",
        },
    )
    stub.add_response(
        "list_objects_v2",
        {"Contents": [{"Key": "v=1/a.json", "ETag": '"e1"', "Size": 3}], "IsTruncated": False},
        {"Bucket": BUCKET, "Prefix": "v=1/"},
    )
    store = R2ObjectStore(BUCKET, client)
    store.put("manifest.json", b"{}", cache_control="public, max-age=60")
    assert [(o.key, o.etag, o.size) for o in store.list("v=1/")] == [("v=1/a.json", "e1", 3)]


def test_keys_are_checked_before_any_request(s3):
    client, _ = s3
    with pytest.raises(ValueError, match="invalid object key"):
        R2ObjectStore(BUCKET, client).exists("../etc/passwd")


def test_local_head_and_exists(tmp_path):
    store = LocalObjectStore(tmp_path)
    assert not store.exists("a/b.json") and store.head("a/b.json") is None
    store.put("a/b.json", b"[1]", cache_control="no-store")
    assert store.exists("a/b.json")
    head = store.head("a/b.json")
    assert head is not None
    assert (head.content_type, head.cache_control, head.size) == ("application/json", "no-store", 3)
