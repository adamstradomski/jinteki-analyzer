"""Normalization: source records -> canonical tables (tournament, entry, deck, deck_card, game).

Source records are the durable truth. Each run loads `state/source_cache.parquet` (every source
record's JSON keyed by object ETag), fetches only the records that are new or changed since, and
rebuilds the canonical tables deterministically in an in-memory DuckDB before writing them back.
"""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from collections import Counter
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

import duckdb

from market_research import logs
from market_research.catalog import Catalog
from market_research.config import Settings, tier_config
from market_research.records import (
    AbrEntries,
    AbrTournament,
    CobraDeck,
    CobraTournament,
    NrdbByDate,
    NrdbCatalog,
    NrdbDecklist,
)
from market_research.storage import ObjectStore, Stores

log = logs.get("market_research.normalize")

CACHE_KEY = "state/source_cache.parquet"
TABLE_PREFIX = "tables/"
# Share of an ABR event's identity pairs that must also be in the Cobra event for the fallback link.
LINK_MIN_IDENTITY_SHARE = 0.9
NORMALIZE_QUALITY_KEY = "state/normalize_quality.json"

TABLES: dict[str, list[tuple[str, str]]] = {
    "tournament": [
        ("tid", "VARCHAR"), ("cobra_id", "BIGINT"), ("abr_id", "BIGINT"), ("date", "DATE"), ("type", "VARCHAR"),
        ("tier", "VARCHAR"), ("format", "VARCHAR"), ("restriction_id", "VARCHAR"), ("card_set", "VARCHAR"),
        ("country", "VARCHAR"), ("online", "BOOLEAN"), ("players", "INTEGER"), ("cut_size", "INTEGER"),
        ("has_games", "BOOLEAN"), ("deck_visibility", "VARCHAR"), ("decklist_coverage", "DOUBLE"),
        ("name", "VARCHAR"), ("swiss_format", "VARCHAR"),
    ],
    "entry": [
        ("tid", "VARCHAR"), ("entry_no", "INTEGER"), ("cut_rank", "INTEGER"), ("made_cut", "BOOLEAN"),
        ("corp_identity", "VARCHAR"), ("runner_identity", "VARCHAR"), ("points", "INTEGER"),
        ("cobra_pid", "BIGINT"), ("abr_swiss_rank", "INTEGER"),
    ],
    "deck": [
        ("deck_id", "VARCHAR"), ("tid", "VARCHAR"), ("entry_no", "INTEGER"), ("side", "VARCHAR"),
        ("identity_card", "VARCHAR"), ("source", "VARCHAR"), ("source_ref", "VARCHAR"), ("card_count", "INTEGER"),
        ("plain_text", "VARCHAR"), ("content_hash", "VARCHAR"), ("comparison", "VARCHAR"), ("legal", "BOOLEAN"),
        ("issues", "VARCHAR"),
    ],
    "deck_card": [("deck_id", "VARCHAR"), ("card_id", "VARCHAR"), ("qty", "INTEGER"), ("printing_id", "VARCHAR")],
    "game": [
        ("tid", "VARCHAR"), ("stage", "INTEGER"), ("round", "INTEGER"), ("table", "INTEGER"), ("side", "VARCHAR"),
        ("corp_entry", "INTEGER"), ("runner_entry", "INTEGER"), ("result", "VARCHAR"), ("elimination", "BOOLEAN"),
    ],
}  # fmt: skip
TABLE_KEYS: dict[str, list[str]] = {
    "tournament": ["tid"],
    "entry": ["tid", "entry_no"],
    "deck": ["deck_id"],
    "deck_card": ["deck_id", "card_id"],
    "game": ["tid", "stage", "round", "table", "side"],
}


@dataclass
class Canonical:
    rows: dict[str, list[dict[str, Any]]] = field(default_factory=lambda: {t: [] for t in TABLES})

    def sort(self) -> None:
        for t, keys in TABLE_KEYS.items():
            self.rows[t].sort(key=lambda r: tuple("" if r[k] is None else str(r[k]).zfill(12) for k in keys))

    def load_into(self, con: duckdb.DuckDBPyConnection) -> None:
        for t, cols in TABLES.items():
            con.execute(f'CREATE OR REPLACE TABLE "{t}" (' + ", ".join(f'"{c}" {ty}' for c, ty in cols) + ")")
            data = [tuple(r[c] for c, _ in cols) for r in self.rows[t]]
            if data:
                con.executemany(f'INSERT INTO "{t}" VALUES (' + ",".join("?" * len(cols)) + ")", data)


@dataclass
class NormQuality:
    unresolved_cards: Counter[str] = field(default_factory=Counter)
    unresolved_identities: Counter[str] = field(default_factory=Counter)
    link_mismatches: list[dict[str, Any]] = field(default_factory=list)
    links: list[dict[str, Any]] = field(default_factory=list)
    skipped: Counter[str] = field(default_factory=Counter)
    illegal_decks: int = 0
    comparisons: Counter[str] = field(default_factory=Counter)
    restriction_overrides: list[dict[str, Any]] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "unresolved_cards": dict(sorted(self.unresolved_cards.items())),
            "unresolved_identities": dict(sorted(self.unresolved_identities.items())),
            "link_mismatches": sorted(self.link_mismatches, key=lambda x: (x["tid"], x.get("entry_no", 0))),
            "links": sorted(self.links, key=lambda x: x["tid"]),
            "skipped_tournaments": dict(sorted(self.skipped.items())),
            "illegal_decks": self.illegal_decks,
            "deck_comparison": dict(sorted(self.comparisons.items())),
            "restriction_overrides": sorted(self.restriction_overrides, key=lambda x: x["tid"]),
        }


# Deck precedence: Cobra's locked registration, then the ABR-claimed NRDB decklist, then a private NRDB deck.
SOURCE_ORDER = {"cobra": 0, "nrdb_decklist": 1, "nrdb_deck": 2}
# Evidence needed to replace an event's ban list with one its decks fit better (see choose_restriction).
BANLIST_MIN_GAIN = 2
BANLIST_MIN_SHARE = 0.1
# Names of other formats, for Cobra events without a format setting (see cobra_not_standard).
OTHER_FORMAT_NAME = re.compile(
    r"\b(start ?up|eternal|sealed|draft|cube|throwback|system gateway|1\.1\.1\.1)\b",
    re.IGNORECASE,
)


def _best(sources: list[_Deck], entry_ident: str | None) -> tuple[str | None, dict[str, int]]:
    """(identity, cards) of the deck that counts for an entry-side."""
    best = min(sources, key=lambda s: SOURCE_ORDER[s.source])
    return best.identity or entry_ident, best.cards


# ------------------------------------------------------------------ source cache


def load_sources(store: ObjectStore, canonical: ObjectStore, *, workers: int = 16) -> dict[str, bytes]:
    """Returns {key: body} for every source record, re-reading only changed objects."""
    cache: dict[str, tuple[str, bytes]] = {}
    raw = canonical.get(CACHE_KEY)
    if raw is not None:
        with tempfile.TemporaryDirectory() as tmp:
            p = os.path.join(tmp, "c.parquet")
            with open(p, "wb") as fh:
                fh.write(raw)
            con = duckdb.connect()
            try:
                for key, etag, body in con.execute(
                    f"SELECT key, etag, body FROM read_parquet('{p}')"
                ).fetchall():
                    cache[key] = (etag, body.encode("utf-8"))
            finally:
                con.close()
    listing = {o.key: o.etag for o in store.list("") if o.key.endswith(".json")}
    stale = sorted(k for k, e in listing.items() if cache.get(k, ("",))[0] != e)

    def fetch(k: str) -> tuple[str, bytes | None]:
        return k, store.get(k)

    with ThreadPoolExecutor(max_workers=workers) as ex:
        for k, body in ex.map(fetch, stale):
            if body is not None:
                cache[k] = (listing[k], body)
    out = {k: cache[k][1] for k in sorted(listing) if k in cache}
    if stale or len(cache) != len(listing):
        con = duckdb.connect()
        try:
            con.execute("CREATE TABLE c (key VARCHAR, etag VARCHAR, body VARCHAR)")
            rows = [(k, listing[k], out[k].decode("utf-8")) for k in sorted(out)]
            if rows:
                con.executemany("INSERT INTO c VALUES (?, ?, ?)", rows)
            with tempfile.TemporaryDirectory() as tmp:
                p = os.path.join(tmp, "c.parquet")
                con.execute(f"COPY c TO '{p}' (FORMAT PARQUET, COMPRESSION ZSTD)")
                with open(p, "rb") as rf:
                    canonical.put(CACHE_KEY, rf.read(), content_type="application/vnd.apache.parquet")
        finally:
            con.close()
    log.info("source_cache", records=len(out), refreshed=len(stale))
    return out


# ------------------------------------------------------------------ normalization


def _json(b: bytes) -> Any:
    import json

    return json.loads(b)


def deck_id(tid: str, entry_no: int, side: str) -> str:
    return hashlib.sha256(f"{tid}|{entry_no}|{side}".encode()).hexdigest()[:16]


@dataclass
class _Deck:
    source: str
    ref: str
    identity: str | None
    cards: dict[str, int]
    printings: dict[str, str]


class Normalizer:
    def __init__(self, sources: dict[str, bytes], settings: Settings) -> None:
        self.settings = settings
        self.tiers = tier_config()
        self.q = NormQuality()
        cat: dict[str, NrdbCatalog] = {}
        for k in ("cards", "printings", "card_sets", "formats", "restrictions", "snapshots"):
            b = sources.get(f"nrdb/catalog/{k}.json")
            if b is not None:
                cat[k] = NrdbCatalog.model_validate(_json(b))
        self.catalog = Catalog(cat)
        self.cobra_t: dict[int, CobraTournament] = {}
        self.cobra_decks: dict[tuple[int, int, str], CobraDeck] = {}
        self.abr_t: dict[int, AbrTournament] = {}
        self.abr_e: dict[int, AbrEntries] = {}
        self.decklists: dict[str, NrdbDecklist] = {}
        self.decks: dict[str, NrdbDecklist] = {}
        self.cobra_names: dict[str, dict[str, str]] = {}
        for key in sorted(sources):
            obj = _json(sources[key])
            parts = key[:-5].split("/")
            if key.startswith("cobra/tournament/"):
                t = CobraTournament.model_validate(obj)
                self.cobra_t[t.id] = t
            elif key.startswith("cobra/deck/"):
                d = CobraDeck.model_validate(obj)
                self.cobra_decks[(d.tournament_id, d.pid, d.side)] = d
            elif key.startswith("cobra/catalog/"):
                self.cobra_names[parts[-1]] = {i["id"]: i["name"] for i in obj.get("items", [])}
            elif key.startswith("abr/tournament/"):
                a = AbrTournament.model_validate(obj)
                self.abr_t[a.id] = a
            elif key.startswith("abr/entries/"):
                e = AbrEntries.model_validate(obj)
                self.abr_e[e.tournament_id] = e
            elif key.startswith("nrdb/decklists/by_date/"):
                for dl in NrdbByDate.model_validate(obj).decklists:
                    self.decklists[dl.id] = dl
                    if dl.uuid:
                        self.decklists[dl.uuid] = dl
            elif key.startswith("nrdb/decklist/"):
                dl = NrdbDecklist.model_validate(obj)
                self.decklists.setdefault(parts[-1], dl)
                if dl.uuid:
                    self.decklists.setdefault(dl.uuid, dl)
            elif key.startswith("nrdb/deck/"):
                self.decks[parts[-1]] = NrdbDecklist.model_validate(obj)

    # ----- helpers -----

    def cobra_standard(self, t: CobraTournament) -> bool:
        name = self.cobra_names.get("formats", {}).get(str(t.format_id), "")
        return name.strip().lower() == "standard"

    def cobra_not_standard(self, t: CobraTournament, a: AbrTournament | None) -> str | None:
        """Why a Cobra event is left out as not Standard, or None when it counts.

        Events created before Cobra had a format setting (early 2025) carry none. For them the
        linked ABR event's format decides; without one, a name naming another format rules it out,
        and otherwise every identity must be legal in Standard around the event date (Eternal
        decks play rotated ones). Startup events without the word in their name pass as Standard;
        their card pool is a subset of it.
        """
        if t.format_id is not None:
            return None if self.cobra_standard(t) else "not_standard"
        if a is not None:
            return None if a.format == "standard" else "not_standard"
        if OTHER_FORMAT_NAME.search(t.name or ""):
            return "not_standard_name"
        titles = {title for p in t.players for title in (p.corp_identity, p.runner_identity) if title}
        idents = {c for c in map(self.catalog.identity_of_title, titles) if c}
        order = self.catalog.standard_restrictions()
        snap = self.catalog.snapshot_at(t.date)
        if not idents or snap is None or snap.restriction_id not in order:
            return "format_unknown"
        i = order.index(snap.restriction_id)
        near = order[max(0, i - 1) : i + 2]
        if any(not any(self.catalog.legal_in(c, r) for r in near) for c in idents):
            return "not_standard_identities"
        return None

    def restriction_for(self, cobra_rid: str | None, d: str) -> str | None:
        if cobra_rid and self.catalog.is_standard_restriction(cobra_rid):
            return cobra_rid
        snap = self.catalog.snapshot_at(d)
        return snap.restriction_id if snap else None

    def choose_restriction(
        self, tid: str, given: str | None, d: str, decks: list[tuple[int, str, str | None, list[_Deck]]]
    ) -> str | None:
        """The ban list an event's decks were built for.

        Organisers sometimes play a new list before it takes effect, keep an old one, or cannot pick
        the right one in Cobra; ABR events have no setting at all. So the candidates are the given
        list, the one in force on the event date and its neighbours, and the one under which most of
        the event's decks are legal wins. It replaces the given list only on clear evidence: at least
        BANLIST_MIN_GAIN more legal decks, and at least BANLIST_MIN_SHARE of the event's decks, so one
        player's illegal deck cannot move a whole event. Without decks the given list stays.
        """
        if not decks:
            return given
        order = self.catalog.standard_restrictions()
        snap = self.catalog.snapshot_at(d)
        in_force = snap.restriction_id if snap else None
        cands: list[str] = [r for r in (given, in_force) if r]
        if in_force in order:
            i = order.index(in_force)
            cands += order[max(0, i - 1) : i] + order[i + 1 : i + 2]
        cands = list(dict.fromkeys(cands))
        if not cands:
            return given
        picked = [(*_best(sources, ident), side) for _, side, ident, sources in decks]

        def legal(rid: str) -> int:
            return sum(
                1
                for ident, cards, side in picked
                if not self.catalog.check_deck(side, ident, cards, rid).issues
            )

        counts = {r: legal(r) for r in cands}
        best = max(cands, key=lambda r: (counts[r], r == given, r == in_force))
        gain = counts[best] - counts.get(given, 0) if given is not None else 0
        if (
            best != given
            and given is not None
            and gain >= max(BANLIST_MIN_GAIN, BANLIST_MIN_SHARE * len(picked))
        ):
            self.q.restriction_overrides.append(
                {
                    "tid": tid,
                    "from": given,
                    "to": best,
                    "decks": len(picked),
                    "legal_before": counts[given],
                    "legal_after": counts[best],
                }
            )
            return best
        return given if given is not None else best

    def ident_from_title(self, title: str | None) -> str | None:
        if not title:
            return None
        cid = self.catalog.identity_of_title(title)
        if cid is None:
            self.q.unresolved_identities[title] += 1
        return cid

    def ident_from_printing(self, pid: str | None) -> str | None:
        if not pid:
            return None
        cid = self.catalog.card_of_printing(pid)
        if cid is None:
            self.q.unresolved_cards[f"printing:{pid}"] += 1
        return cid

    def cards_from_printings(self, dl: NrdbDecklist) -> tuple[str | None, dict[str, int], dict[str, str]]:
        cards: dict[str, int] = {}
        printings: dict[str, str] = {}
        ident = self.ident_from_printing(dl.identity_printing_id)
        for pq in dl.cards:
            cid = self.catalog.card_of_printing(pq.printing_id)
            if cid is None:
                self.q.unresolved_cards[f"printing:{pq.printing_id}"] += 1
                continue
            c = self.catalog.cards[cid]
            if c.card_type_id.endswith("identity"):
                ident = ident or cid
                continue
            cards[cid] = cards.get(cid, 0) + pq.qty
            printings.setdefault(cid, pq.printing_id)
        return ident, cards, printings

    def cobra_deck(self, d: CobraDeck) -> _Deck:
        cards: dict[str, int] = {}
        printings: dict[str, str] = {}
        for c in d.cards:
            cid = (
                c.nrdb_card_id
                if c.nrdb_card_id in self.catalog.cards
                else self.catalog.card_of_printing(c.nrdb_printing_id)
            )
            if cid is None:
                self.q.unresolved_cards[f"card:{c.nrdb_card_id or c.nrdb_printing_id}"] += 1
                continue
            cards[cid] = cards.get(cid, 0) + c.qty
            if c.nrdb_printing_id:
                printings.setdefault(cid, c.nrdb_printing_id)
        ident = (
            d.identity.nrdb_card_id
            if d.identity.nrdb_card_id in self.catalog.cards
            else self.ident_from_printing(d.identity.nrdb_printing_id)
        )
        return _Deck("cobra", f"cobra:{d.tournament_id}:{d.pid}", ident, cards, printings)

    def nrdb_deck(self, kind: str, ref: str) -> _Deck | None:
        dl = (self.decklists if kind == "decklist" else self.decks).get(ref)
        if dl is None:
            return None
        ident, cards, printings = self.cards_from_printings(dl)
        return _Deck(
            "nrdb_decklist" if kind == "decklist" else "nrdb_deck", f"{kind}:{ref}", ident, cards, printings
        )

    # ----- linking -----

    def link(self) -> dict[int, int]:
        """Cobra id -> ABR id, via abr_code or the fallback match."""
        links: dict[int, int] = {}
        used: set[int] = set()
        for cid, t in sorted(self.cobra_t.items()):
            code = (t.abr_code or "").strip()
            if code.isdigit() and int(code) in self.abr_t:
                links[cid] = int(code)
                used.add(int(code))
                self.q.links.append({"tid": f"c{cid}", "abr_id": int(code), "method": "abr_code"})
            elif code:
                self.q.link_mismatches.append({"tid": f"c{cid}", "reason": "abr_code_unresolved"})
        for cid, t in sorted(self.cobra_t.items()):
            if cid in links or not t.results_fetched:
                continue
            idents = Counter(
                (self.ident_from_title(p.corp_identity), self.ident_from_title(p.runner_identity))
                for p in t.players
            )
            cands = []
            near: list[dict[str, Any]] = []
            played = date.fromisoformat(t.date)
            for aid, a in sorted(self.abr_t.items()):
                if aid in used:
                    continue
                # ABR events can span several days (end_date); allow a day either side for time zones.
                start = date.fromisoformat(a.date)
                end = date.fromisoformat(a.end_date) if a.end_date else start
                if not (start - timedelta(days=1) <= played <= end + timedelta(days=1)):
                    continue
                if a.players_count != len(t.players):
                    continue
                e = self.abr_e.get(aid)
                if e is not None:
                    # ABR leaves unclaimed spots out of its entries, so its identity pairs are compared
                    # as a near-subset of Cobra's: most of the pairs ABR has must also be in Cobra.
                    a_idents = Counter(
                        (
                            self.ident_from_printing(x.corp.identity),
                            self.ident_from_printing(x.runner.identity),
                        )
                        for x in e.entries
                        if x.corp.identity and x.runner.identity
                    )
                    known = sum(a_idents.values())
                    shared = sum((a_idents & idents).values())
                    if known and shared < LINK_MIN_IDENTITY_SHARE * known:
                        near.append({"abr_id": aid, "shared_pairs": shared, "abr_pairs": known})
                        continue
                cands.append(aid)
            if len(cands) == 1:
                links[cid] = cands[0]
                used.add(cands[0])
                self.q.links.append({"tid": f"c{cid}", "abr_id": cands[0], "method": "date_size_identities"})
            elif len(cands) > 1:
                self.q.link_mismatches.append({"tid": f"c{cid}", "reason": "ambiguous_fallback_match"})
            elif near:
                # Same dates and size but too few shared identities: probably the same event, not linked.
                self.q.link_mismatches.append(
                    {"tid": f"c{cid}", "reason": "fallback_identities_differ", **near[0]}
                )
        return links

    # ----- build -----

    def run(self) -> Canonical:
        out = Canonical()
        if not self.catalog.ok():
            log.warning("catalog_missing")
            return out
        links = self.link()
        linked_abr = set(links.values())
        cobra_types = self.cobra_names.get("tournament_types", {})
        for cid, t in sorted(self.cobra_t.items()):
            if not t.results_fetched:
                self.q.skipped["cobra_no_results"] += 1
                continue
            aid = links.get(cid)
            a = self.abr_t.get(aid) if aid else None
            reason = self.cobra_not_standard(t, a)
            if reason:
                self.q.skipped[reason] += 1
                continue
            if len(t.players) < self.settings.thresholds.min_players:
                self.q.skipped["too_small"] += 1
                continue
            if a is not None and (a.approved != 1 or a.claim_conflict):
                self.q.skipped["abr_guard"] += 1
                continue
            label, tier = self.tiers.cobra_tier(cobra_types.get(str(t.type_id)))
            if a is not None and a.type_id is not None:
                abr_label, abr_tier = self.tiers.abr_tier(a.type_id)
                if tier == self.tiers.default_group:
                    label, tier = abr_label, abr_tier
            self.build_cobra(out, t, a, label, tier)
        for aid, a in sorted(self.abr_t.items()):
            if aid in linked_abr:
                continue
            if a.format != "standard" or a.approved != 1 or a.claim_conflict or not a.concluded:
                self.q.skipped["abr_guard"] += 1
                continue
            if a.players_count < self.settings.thresholds.min_players:
                self.q.skipped["too_small"] += 1
                continue
            if aid not in self.abr_e:
                self.q.skipped["abr_no_entries"] += 1
                continue
            label, tier = self.tiers.abr_tier(a.type_id)
            self.build_abr(out, a, label, tier)
        out.sort()
        return out

    def _tournament_row(
        self,
        tid: str,
        *,
        cobra_id: int | None,
        abr: AbrTournament | None,
        d: str,
        label: str,
        tier: str,
        restriction: str | None,
        card_set: str | None,
        players: int,
        cut_size: int,
        visibility: str,
        name: str | None = None,
        swiss_format: str | None = None,
    ) -> dict[str, Any]:
        # Online when AlwaysBeRunning says so (location "online"), when the name or type says so
        # (an "Online Continental" is a Megacity+ event played online), or for online event types.
        online = (
            (abr is not None and abr.online)
            or bool(re.search(r"\bonline\b", f"{name or ''} {label}", re.IGNORECASE))
            or (abr is not None and str(abr.type_id or "").lower() in self.tiers.online_abr_types)
        )
        return {
            "tid": tid,
            "cobra_id": cobra_id,
            "abr_id": abr.id if abr else None,
            "date": date.fromisoformat(d),
            "type": label,
            "tier": tier,
            "format": "standard",
            "restriction_id": restriction,
            "card_set": card_set,
            "country": abr.country if abr else None,
            "online": online,
            "players": players,
            "cut_size": cut_size,
            "has_games": False,
            "deck_visibility": visibility,
            "decklist_coverage": 0.0,
            "name": name,
            "swiss_format": swiss_format,
        }

    def build_cobra(
        self, out: Canonical, t: CobraTournament, a: AbrTournament | None, label: str, tier: str
    ) -> None:
        tid = f"c{t.id}"
        restriction = self.restriction_for(t.restriction_id, t.date)
        cut_size = next((s.size or 0 for s in t.stages if s.n == 2), 0)
        trow = self._tournament_row(
            tid,
            cobra_id=t.id,
            abr=a,
            d=t.date,
            label=label,
            tier=tier,
            restriction=restriction,
            card_set=t.card_set_id,
            players=len(t.players),
            cut_size=cut_size,
            visibility=f"swiss:{t.deck_visibility.swiss},cut:{t.deck_visibility.cut}",
            name=t.name or (a.title if a else None),
            swiss_format=t.swiss_format,
        )
        abr_by_rank = {e.swiss_rank: e for e in self.abr_e[a.id].entries} if a and a.id in self.abr_e else {}
        pid_entry: dict[int, int] = {}
        decks_found = 0
        pending: list[tuple[int, str, str | None, list[_Deck]]] = []
        for p in t.players:
            if p.swiss_rank is None:
                continue
            no = p.swiss_rank
            pid_entry[p.pid] = no
            corp_i = self.ident_from_title(p.corp_identity)
            runner_i = self.ident_from_title(p.runner_identity)
            ae = abr_by_rank.get(no)
            if ae is not None:
                ac = self.catalog.card_of_printing(ae.corp.identity)
                ar = self.catalog.card_of_printing(ae.runner.identity)
                if (ac and corp_i and ac != corp_i) or (ar and runner_i and ar != runner_i):
                    self.q.link_mismatches.append({"tid": tid, "entry_no": no, "reason": "identity_mismatch"})
                    ae = None
            out.rows["entry"].append(
                {
                    "tid": tid,
                    "entry_no": no,
                    "cut_rank": p.cut_rank,
                    "made_cut": p.cut_rank is not None,
                    "corp_identity": corp_i,
                    "runner_identity": runner_i,
                    "points": p.points,
                    "cobra_pid": p.pid,
                    "abr_swiss_rank": ae.swiss_rank if ae else None,
                }
            )
            for side, ident in (("corp", corp_i), ("runner", runner_i)):
                sources: list[_Deck] = []
                cd = self.cobra_decks.get((t.id, p.pid, side))
                if cd is not None and cd.cards:
                    sources.append(self.cobra_deck(cd))
                if ae is not None:
                    ref = (ae.corp if side == "corp" else ae.runner).deck_ref
                    if ref is not None:
                        nd = self.nrdb_deck(ref.kind, ref.id)
                        if nd is not None:
                            sources.append(nd)
                if cd is not None and cd.nrdb_uuid and not any(s.source == "nrdb_deck" for s in sources):
                    nd = self.nrdb_deck("deck", cd.nrdb_uuid)
                    if nd is not None and not cd.cards:
                        sources.append(nd)
                if sources:
                    decks_found += 1
                    pending.append((no, side, ident, sources))
        restriction = self.choose_restriction(tid, restriction, t.date, pending)
        trow["restriction_id"] = restriction
        for no, side, ident, sources in pending:
            self.add_deck(out, tid, no, side, ident, sources, restriction)
        trow["decklist_coverage"] = round(decks_found / (2 * len(pid_entry)), 6) if pid_entry else 0.0
        games = list(self.games(t, pid_entry, tid))
        out.rows["game"].extend(games)
        trow["has_games"] = bool(games)
        out.rows["tournament"].append(trow)

    def build_abr(self, out: Canonical, a: AbrTournament, label: str, tier: str) -> None:
        tid = f"a{a.id}"
        restriction = self.restriction_for(None, a.date)
        e = self.abr_e[a.id]
        decks_found = 0
        pending: list[tuple[int, str, str | None, list[_Deck]]] = []
        has_cut = a.top_count > 0
        for x in e.entries:
            cut = x.cut_rank if x.cut_rank and x.cut_rank > 0 else None
            corp_i = self.ident_from_printing(x.corp.identity)
            runner_i = self.ident_from_printing(x.runner.identity)
            out.rows["entry"].append(
                {
                    "tid": tid,
                    "entry_no": x.swiss_rank,
                    "cut_rank": cut,
                    "made_cut": has_cut and cut is not None,
                    "corp_identity": corp_i,
                    "runner_identity": runner_i,
                    "points": None,
                    "cobra_pid": None,
                    "abr_swiss_rank": x.swiss_rank,
                }
            )
            for side, s in (("corp", x.corp), ("runner", x.runner)):
                if s.deck_ref is None:
                    continue
                nd = self.nrdb_deck(s.deck_ref.kind, s.deck_ref.id)
                if nd is not None:
                    decks_found += 1
                    pending.append((x.swiss_rank, side, corp_i if side == "corp" else runner_i, [nd]))
        restriction = self.choose_restriction(tid, restriction, a.date, pending)
        for no, side, ident, sources in pending:
            self.add_deck(out, tid, no, side, ident, sources, restriction)
        n = max(len(e.entries), a.players_count)
        trow = self._tournament_row(
            tid,
            cobra_id=None,
            abr=a,
            d=a.date,
            label=label,
            tier=tier,
            restriction=restriction,
            card_set=None,
            players=a.players_count,
            cut_size=a.top_count,
            visibility="n/a",
            name=a.title,
        )
        trow["decklist_coverage"] = round(decks_found / (2 * n), 6) if n else 0.0
        out.rows["tournament"].append(trow)

    def add_deck(
        self,
        out: Canonical,
        tid: str,
        no: int,
        side: str,
        entry_ident: str | None,
        sources: list[_Deck],
        restriction: str | None,
    ) -> None:
        sources = sorted(sources, key=lambda s: SOURCE_ORDER[s.source])
        best = sources[0]
        ident = best.identity or entry_ident
        if len(sources) > 1:
            other = sources[1]
            same = other.cards == best.cards and (other.identity or ident) == ident
            comparison = "match" if same else "mismatch"
        else:
            comparison = "cobra_only" if best.source == "cobra" else "nrdb_only"
        self.q.comparisons[comparison] += 1
        leg = self.catalog.check_deck(side, ident, best.cards, restriction or "")
        issues = list(leg.issues)
        if entry_ident and ident and entry_ident != ident:
            issues.append("identity_differs_from_entry")
        legal = not issues
        if not legal:
            self.q.illegal_decks += 1
        text = self.catalog.plain_text(ident, best.cards)
        did = deck_id(tid, no, side)
        out.rows["deck"].append(
            {
                "deck_id": did,
                "tid": tid,
                "entry_no": no,
                "side": side,
                "identity_card": ident,
                "source": best.source,
                "source_ref": best.ref,
                "card_count": sum(best.cards.values()),
                "plain_text": text,
                "content_hash": "sha256:" + hashlib.sha256(text.encode()).hexdigest(),
                "comparison": comparison,
                "legal": legal,
                "issues": ";".join(issues),
            }
        )
        for cid, qty in sorted(best.cards.items()):
            out.rows["deck_card"].append(
                {"deck_id": did, "card_id": cid, "qty": qty, "printing_id": best.printings.get(cid)}
            )

    # ----- games -----

    def games(self, t: CobraTournament, pid_entry: dict[int, int], tid: str) -> Iterable[dict[str, Any]]:
        double = t.swiss_format == "double_sided"
        for p in t.pairings:
            if p.p1 is None or p.p2 is None or p.p1 not in pid_entry or p.p2 not in pid_entry:
                continue
            e1, e2 = pid_entry[p.p1], pid_entry[p.p2]
            base = {
                "tid": tid,
                "stage": p.stage,
                "round": p.round,
                "table": p.table or 0,
                "elimination": p.elimination,
            }
            if p.elimination:
                if p.winner is None or p.p1_side is None:
                    continue
                corp_is_p1 = p.p1_side == "corp"
                winner_is_corp = (p.winner == 1) == corp_is_p1
                yield self._game(base, corp_is_p1, e1, e2, "corp_win" if winner_is_corp else "runner_win")
            elif double:
                if p.two_for_one:
                    continue  # a single combined result cannot be split into two games
                for corp_is_p1 in (True, False):
                    cs = p.p1_corp_score if corp_is_p1 else p.p2_corp_score
                    rs = p.p2_runner_score if corp_is_p1 else p.p1_runner_score
                    res = "intentional_draw" if p.intentional_draw else _result(cs, rs)
                    if res:
                        yield self._game(base, corp_is_p1, e1, e2, res)
            else:
                if p.p1_side is None:
                    continue
                corp_is_p1 = p.p1_side == "corp"
                cs = p.p1_corp_score if corp_is_p1 else p.p2_corp_score
                rs = p.p2_runner_score if corp_is_p1 else p.p1_runner_score
                res = "intentional_draw" if p.intentional_draw else _result(cs, rs)
                if res:
                    yield self._game(base, corp_is_p1, e1, e2, res)

    @staticmethod
    def _game(base: dict[str, Any], corp_is_p1: bool, e1: int, e2: int, result: str) -> dict[str, Any]:
        return {
            **base,
            "side": "corp" if corp_is_p1 else "runner",
            "corp_entry": e1 if corp_is_p1 else e2,
            "runner_entry": e2 if corp_is_p1 else e1,
            "result": result,
        }


def _result(corp_score: int | None, runner_score: int | None) -> str | None:
    if corp_score == 3 or (corp_score is None and runner_score == 0):
        return "corp_win"
    if runner_score == 3 or (runner_score is None and corp_score == 0):
        return "runner_win"
    if corp_score == 0 and runner_score == 0:
        return None  # both lost: an unusual report, not a game result
    if corp_score == 1 or runner_score == 1:
        return "draw"
    if corp_score == 0:
        return "runner_win"
    if runner_score == 0:
        return "corp_win"
    return None


# ------------------------------------------------------------------ persistence


def save_tables(canonical: ObjectStore, data: Canonical) -> None:
    con = duckdb.connect()
    try:
        data.load_into(con)
        with tempfile.TemporaryDirectory() as tmp:
            for t in TABLES:
                p = os.path.join(tmp, f"{t}.parquet")
                keys = ", ".join(f'"{k}"' for k in TABLE_KEYS[t])
                con.execute(f"COPY (SELECT * FROM \"{t}\" ORDER BY {keys}) TO '{p}' (FORMAT PARQUET)")
                with open(p, "rb") as fh:
                    canonical.put(
                        f"{TABLE_PREFIX}{t}.parquet", fh.read(), content_type="application/vnd.apache.parquet"
                    )
    finally:
        con.close()


def load_tables(canonical: ObjectStore, con: duckdb.DuckDBPyConnection, tmp: str) -> None:
    for t, cols in TABLES.items():
        raw = canonical.get(f"{TABLE_PREFIX}{t}.parquet")
        if raw is None:
            con.execute(f'CREATE OR REPLACE TABLE "{t}" (' + ", ".join(f'"{c}" {ty}' for c, ty in cols) + ")")
            continue
        p = os.path.join(tmp, f"{t}.parquet")
        with open(p, "wb") as fh:
            fh.write(raw)
        con.execute(f"CREATE OR REPLACE TABLE \"{t}\" AS SELECT * FROM read_parquet('{p}')")


def normalize(stores: Stores, settings: Settings) -> tuple[Canonical, NormQuality]:
    sources = load_sources(stores.source, stores.canonical)
    n = Normalizer(sources, settings)
    data = n.run()
    save_tables(stores.canonical, data)
    stores.canonical.put_json(NORMALIZE_QUALITY_KEY, n.q.to_json())
    log.info(
        "normalized",
        tournaments=len(data.rows["tournament"]),
        entries=len(data.rows["entry"]),
        decks=len(data.rows["deck"]),
        games=len(data.rows["game"]),
    )
    return data, n.q
