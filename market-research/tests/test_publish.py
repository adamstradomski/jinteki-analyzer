from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import jsonschema
import pytest

from market_research.publish import IMMUTABLE, MANIFEST_CACHE, PATHS, PublishError, build, publish, schema
from market_research.storage import LocalObjectStore

DOCS = Path(__file__).resolve().parents[2] / "docs" / "market-research" / "snapshot-contract"


@pytest.fixture
def built(fixture_run, tmp_path):
    env, _, _, _ = fixture_run
    stores = replace(env.stores, published=LocalObjectStore(tmp_path / "published"))
    snap, errors = build(stores, env.settings, env.clock.now())
    return stores, snap, errors


def test_snapshot_is_valid(built):
    _, snap, errors = built
    assert errors == []
    names = {
        "catalog": "catalog",
        "summary": "summary",
        "trends": "trends",
        "identities": "identities",
        "report": "quality",
    }
    for path, obj in snap.files.items():
        kind = "catalog" if path == PATHS["catalog"] else names[path.rsplit("/", 1)[1][:-5]]
        jsonschema.validate(obj, schema(kind))
        assert obj["schema"].startswith("mr.")
    jsonschema.validate(snap.manifest, schema("manifest"))


def test_every_slice_path_exists_and_is_deterministic(built):
    _, snap, _ = built
    m = snap.manifest
    for side in m["sides"]:
        for r in m["restrictions"]:
            for g in m["tier_groups"]:
                for kind in ("summary", "trends", "identities", "summary_cut", "trends_cut"):
                    path = m["paths"][kind].format(side=side, restriction=r["id"], tier_group=g["id"])
                    assert path in snap.files, path
    expected = 2 * len(m["restrictions"]) * len(m["tier_groups"]) * 5 + 2
    assert len(snap.files) == expected
    assert m["base_path"] == f"v={m['version']}/"


def test_manifest_written_last_with_cache_headers(built):
    stores, snap, errors = built
    publish(stores, snap, errors)
    pub = stores.published
    assert pub.puts[-1] == "manifest.json"  # type: ignore[attr-defined]
    assert pub.head("manifest.json").cache_control == MANIFEST_CACHE == "public, max-age=60"
    for key in pub.puts[:-1]:  # type: ignore[attr-defined]
        assert key.startswith(snap.manifest["base_path"])
        obj = pub.head(key)
        assert obj.cache_control == IMMUTABLE == "public, max-age=31536000, immutable"
        assert obj.content_type == "application/json"


def test_invalid_snapshot_publishes_nothing(built):
    stores, snap, _ = built
    old = b'{"schema":"mr.manifest/1","version":"old"}'
    stores.published.put("manifest.json", old, cache_control=MANIFEST_CACHE)
    stores.published.puts.clear()  # type: ignore[attr-defined]
    bad = snap.files[PATHS["summary"].format(side="corp", restriction="all", tier_group="all")]
    bad["cards"].append({"card_id": "NOT A CARD"})
    with pytest.raises(PublishError):
        publish(stores, snap, ["forced"])
    assert stores.published.puts == []  # type: ignore[attr-defined]
    assert stores.published.get("manifest.json") == old


def test_validation_catches_bad_content(fixture_run, tmp_path):
    from market_research import publish as pub

    env, _, _, _ = fixture_run
    snap, errors = build(env.stores, env.settings, env.clock.now())
    assert not errors
    s = snap.files[PATHS["summary"].format(side="corp", restriction="all", tier_group="all")]
    s["cards"][0]["card_id"] = "made_up_card"
    snap.files["meta/corp/all/all/trends.json"]["baseline"][0][2] += 1
    import duckdb

    from market_research.normalize import load_tables

    con = duckdb.connect()
    load_tables(env.stores.canonical, con, str(tmp_path))
    from market_research.catalog import Catalog  # noqa: F401
    from market_research.metrics import compute_counts
    from market_research.normalize import Normalizer, load_sources

    src = {
        k: v
        for k, v in load_sources(env.stores.source, env.stores.canonical).items()
        if k.startswith("nrdb/catalog/")
    }
    compute_counts(con, Normalizer(src, env.settings).catalog, env.settings)
    errs = pub.validate(snap, con)
    assert any("not in the catalog" in e for e in errs)
    assert any("published decks" in e for e in errs)
    big = snap.files["meta/corp/all/all/trends.json"]
    big["cards"]["filler"] = [[0, 0, *[123456789012] * 10]] * 20000
    assert any("2 MB" in e for e in pub.validate(snap, con))


def test_only_catalog_titles_and_numbers(built):
    _, snap, _ = built
    catalog = snap.files[PATHS["catalog"]]
    titles = {c["title"] for c in catalog["cards"]}
    for path, obj in snap.files.items():
        if path == PATHS["catalog"]:
            continue
        for s in _strings(obj):
            assert len(s) <= 160, (path, s)
            assert ("<" not in s and ">" not in s) or s in titles


def _strings(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for k, v in o.items():
            yield k
            yield from _strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from _strings(v)


def test_docs_contract_matches_package_schemas():
    for name in ("manifest", "summary", "trends", "identities", "catalog", "quality"):
        doc = json.loads((DOCS / f"{name}.schema.json").read_text())
        assert doc == schema(name), name
    for ex in sorted(DOCS.glob("examples/*.json")):
        obj = json.loads(ex.read_text())
        kind = ex.stem.split(".")[0]
        jsonschema.validate(obj, schema(kind))


def test_catalog_contains_only_standard_legal_cards(built):
    _, snap, _ = built
    cat = snap.files[PATHS["catalog"]]
    ids = {c["id"] for c in cat["cards"]}
    assert "account_siphon" not in ids  # rotated out of Standard
    assert "hedge_fund" in ids
    assert all(c["legal_in"] for c in cat["cards"])
