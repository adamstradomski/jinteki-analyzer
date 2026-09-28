"""Storage behind one interface. Nothing else in the package touches storage directly."""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from market_research.config import Settings

_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._=/-]*$")


def _check_key(key: str) -> str:
    if not _KEY_RE.match(key) or ".." in key or "//" in key:
        raise ValueError(f"invalid object key: {key!r}")
    return key


@dataclass(frozen=True)
class ObjectInfo:
    key: str
    etag: str
    size: int


@dataclass(frozen=True)
class StoredObject:
    body: bytes
    content_type: str
    cache_control: str | None
    etag: str


class ObjectStore(ABC):
    """A flat key/value object store (one bucket)."""

    @abstractmethod
    def get(self, key: str) -> bytes | None: ...

    @abstractmethod
    def head(self, key: str) -> StoredObject | None: ...

    @abstractmethod
    def put(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = "application/json",
        cache_control: str | None = None,
    ) -> None: ...

    @abstractmethod
    def list(self, prefix: str = "") -> Iterator[ObjectInfo]: ...

    def exists(self, key: str) -> bool:
        return self.head(key) is not None

    def get_json(self, key: str) -> Any:
        raw = self.get(key)
        return None if raw is None else json.loads(raw)

    def put_json(self, key: str, obj: Any, *, cache_control: str | None = None) -> None:
        self.put(key, dumps(obj), content_type="application/json", cache_control=cache_control)


def dumps(obj: Any) -> bytes:
    """Deterministic compact JSON used for every stored JSON file."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


class LocalObjectStore(ObjectStore):
    """A bucket backed by a directory. Metadata lives in a sidecar tree under `.meta/`."""

    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self.puts: list[str] = []

    def _path(self, key: str) -> Path:
        return self.root / _check_key(key)

    def _meta(self, key: str) -> Path:
        return self.root / ".meta" / (_check_key(key) + ".json")

    def get(self, key: str) -> bytes | None:
        p = self._path(key)
        return p.read_bytes() if p.is_file() else None

    def head(self, key: str) -> StoredObject | None:
        p = self._path(key)
        if not p.is_file():
            return None
        body = p.read_bytes()
        meta: dict[str, Any] = {}
        mp = self._meta(key)
        if mp.is_file():
            meta = json.loads(mp.read_text("utf-8"))
        return StoredObject(
            body=body,
            content_type=meta.get("content_type", "application/octet-stream"),
            cache_control=meta.get("cache_control"),
            etag=hashlib.md5(body, usedforsecurity=False).hexdigest(),
        )

    def put(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = "application/json",
        cache_control: str | None = None,
    ) -> None:
        p = self._path(key)
        mp = self._meta(key)
        with self._lock:
            p.parent.mkdir(parents=True, exist_ok=True)
            mp.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + ".tmp")
            tmp.write_bytes(body)
            os.replace(tmp, p)
            mp.write_text(json.dumps({"content_type": content_type, "cache_control": cache_control}), "utf-8")
            self.puts.append(key)

    def list(self, prefix: str = "") -> Iterator[ObjectInfo]:
        out: list[ObjectInfo] = []
        for p in self.root.rglob("*"):
            if not p.is_file() or ".meta" in p.relative_to(self.root).parts or p.name.endswith(".tmp"):
                continue
            key = p.relative_to(self.root).as_posix()
            if key.startswith(prefix):
                body = p.read_bytes()
                out.append(ObjectInfo(key, hashlib.md5(body, usedforsecurity=False).hexdigest(), len(body)))
        yield from sorted(out, key=lambda o: o.key)


class R2ObjectStore(ObjectStore):  # pragma: no cover - exercised only against real R2
    """Cloudflare R2 through its S3-compatible API."""

    def __init__(self, bucket: str, account_id: str, access_key_id: str, secret_access_key: str) -> None:
        import boto3
        from botocore.config import Config

        self.bucket = bucket
        self._s3 = boto3.client(
            "s3",
            endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com",
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name="auto",
            config=Config(retries={"max_attempts": 5, "mode": "standard"}, max_pool_connections=32),
        )

    def get(self, key: str) -> bytes | None:
        try:
            r = self._s3.get_object(Bucket=self.bucket, Key=_check_key(key))
        except self._s3.exceptions.NoSuchKey:
            return None
        body: bytes = r["Body"].read()
        return body

    def head(self, key: str) -> StoredObject | None:
        from botocore.exceptions import ClientError

        try:
            r = self._s3.get_object(Bucket=self.bucket, Key=_check_key(key))
        except ClientError:
            return None
        return StoredObject(
            body=r["Body"].read(),
            content_type=r.get("ContentType", ""),
            cache_control=r.get("CacheControl"),
            etag=str(r.get("ETag", "")).strip('"'),
        )

    def put(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = "application/json",
        cache_control: str | None = None,
    ) -> None:
        extra: dict[str, Any] = {"ContentType": content_type}
        if cache_control:
            extra["CacheControl"] = cache_control
        self._s3.put_object(Bucket=self.bucket, Key=_check_key(key), Body=body, **extra)

    def list(self, prefix: str = "") -> Iterator[ObjectInfo]:
        paginator = self._s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for o in page.get("Contents", []):
                yield ObjectInfo(o["Key"], str(o["ETag"]).strip('"'), int(o["Size"]))


@dataclass
class Stores:
    source: ObjectStore
    canonical: ObjectStore
    published: ObjectStore


def local_stores(root: str | Path) -> Stores:
    r = Path(root)
    return Stores(
        source=LocalObjectStore(r / "mr-source"),
        canonical=LocalObjectStore(r / "mr-canonical"),
        published=LocalObjectStore(r / "mr-published"),
    )


def stores_from_settings(settings: Settings) -> Stores:  # pragma: no cover - needs R2
    if settings.local_store:
        return local_stores(settings.local_store)
    if not (settings.r2_account_id and settings.r2_access_key_id and settings.r2_secret_access_key):
        raise RuntimeError(
            "R2 credentials are not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)"
        )
    kid = settings.r2_access_key_id.get_secret_value()
    sec = settings.r2_secret_access_key.get_secret_value()
    return Stores(
        source=R2ObjectStore(settings.bucket_source, settings.r2_account_id, kid, sec),
        canonical=R2ObjectStore(settings.bucket_canonical, settings.r2_account_id, kid, sec),
        published=R2ObjectStore(settings.bucket_published, settings.r2_account_id, kid, sec),
    )
