"""Decklists loaded from a file, e.g. the full decklists of an event that its organiser sent.

The file is a "long format" CSV, one row per card: `name,identity,card,card_count` (other columns
are ignored). Each player is found in the Cobra tournament by name, read from Cobra's export in
memory only: the stored record keeps the Cobra player ID, the identity and the cards, never the name.
The record goes to `import/cobra/<id>.json`, which the crawler never writes, so later runs never
replace it; importing the same tournament again replaces the earlier import.
"""

from __future__ import annotations

import csv
import io
import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from market_research import logs
from market_research.catalog import Catalog
from market_research.records import (
    CardQty,
    CobraPlayer,
    CobraTournament,
    ImportedDeck,
    ImportedDecks,
    NrdbCatalog,
    Side,
)
from market_research.storage import ObjectStore

log = logs.get("market_research.imports")

IMPORT_PREFIX = "import/"
ORIGIN = re.compile(r"[a-z0-9_-]{1,32}")
QTY = re.compile(r"[0-9]{1,2}")
COLUMNS = ("name", "identity", "card", "card_count")
MAX_FILE_BYTES = 5_000_000


class DeckImportError(ValueError):
    """The file or the tournament cannot be imported at all (nothing is written)."""


def import_key(cobra_id: int) -> str:
    return f"{IMPORT_PREFIX}cobra/{cobra_id}.json"


def name_key(name: str) -> str:
    """Compares names typed in two places: case, width, accents and anything but letters and digits
    are ignored, so "Ann-Marie " finds "annmarie"."""
    t = unicodedata.normalize("NFKD", name)
    return "".join(ch for ch in t.casefold() if ch.isalnum() and not unicodedata.combining(ch))


@dataclass
class _Row:
    line: int
    name: str
    identity: str
    card: str
    qty: str


@dataclass
class ImportReport:
    """Counts and CSV line numbers only: no names, so it can be logged."""

    players_in_file: int = 0
    decks_in_file: int = 0
    decks_imported: int = 0
    rejected: Counter[str] = field(default_factory=Counter)
    # The first CSV line of each player or deck that was left out, by reason.
    lines: dict[str, list[int]] = field(default_factory=dict)
    cobra_players: int = 0
    # Swiss ranks of Cobra players the file has no deck for (ranks are public, names are not).
    cobra_without_deck: list[int] = field(default_factory=list)

    def reject(self, reason: str, line: int, n: int = 1) -> None:
        self.rejected[reason] += n
        self.lines.setdefault(reason, []).append(line)

    def to_json(self) -> dict[str, Any]:
        return {
            "players_in_file": self.players_in_file,
            "decks_in_file": self.decks_in_file,
            "decks_imported": self.decks_imported,
            "rejected": dict(sorted(self.rejected.items())),
            "lines": {k: sorted(v) for k, v in sorted(self.lines.items())},
            "cobra_players": self.cobra_players,
            "cobra_without_deck": sorted(self.cobra_without_deck),
        }


def read_rows(data: bytes) -> list[_Row]:
    """Parses the CSV. A file without the needed columns cannot be imported; single bad rows are
    caught later, deck by deck."""
    if len(data) > MAX_FILE_BYTES:
        raise DeckImportError(f"file over {MAX_FILE_BYTES} bytes")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise DeckImportError("file is not UTF-8") from e
    reader = csv.DictReader(io.StringIO(text, newline=""))
    out = []
    start = 1
    try:
        missing = [c for c in COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise DeckImportError(f"missing columns: {', '.join(missing)}")
        start = reader.line_num + 1
        for r in reader:
            # line_num is where the row ends; a quoted cell can span lines, so keep where it starts.
            out.append(
                _Row(start, r["name"] or "", r["identity"] or "", r["card"] or "", r["card_count"] or "")
            )
            start = reader.line_num + 1
    except csv.Error as e:
        raise DeckImportError(f"CSV not readable at line {start}") from e
    return out


def load_catalog(source: ObjectStore) -> Catalog:
    recs = {}
    for k in ("cards", "printings", "card_sets", "formats", "restrictions", "snapshots"):
        obj = source.get_json(f"nrdb/catalog/{k}.json")
        if obj is not None:
            recs[k] = NrdbCatalog.model_validate(obj)
    return Catalog(recs)


def match_players(names: list[str], nrtm_players: list[dict[str, Any]]) -> dict[str, int | None]:
    """Name in the file -> Cobra player ID: the exact name, else the only player whose name_key is
    the same. None when no player or more than one player fits."""
    exact: dict[str, list[int]] = {}
    loose: dict[str, list[int]] = {}
    for p in nrtm_players:
        n = str(p.get("name") or "")
        pid = p.get("id")
        if not isinstance(pid, int) or isinstance(pid, bool):
            continue
        exact.setdefault(n.strip(), []).append(pid)
        loose.setdefault(name_key(n), []).append(pid)
    out: dict[str, int | None] = {}
    for n in names:
        if not name_key(n):
            out[n] = None
            continue
        hits = exact.get(n.strip()) or loose.get(name_key(n)) or []
        out[n] = hits[0] if len(set(hits)) == 1 else None
    return out


def build_import(
    rows: list[_Row],
    t: CobraTournament,
    nrtm_players: list[dict[str, Any]],
    catalog: Catalog,
    origin: str,
    imported_at: str,
) -> tuple[ImportedDecks, ImportReport]:
    """Turns the file's rows into one record. Each deck is checked on its own: a deck with a card or
    identity that is not in the catalog, a bad count, or an identity that differs from the one in
    Cobra is left out, and the rest are still imported."""
    rep = ImportReport(cobra_players=len(t.players))
    by_player: dict[str, list[_Row]] = {}
    for r in rows:
        by_player.setdefault(r.name, []).append(r)
    rep.players_in_file = len(by_player)
    pids = match_players(list(by_player), nrtm_players)
    players = {p.pid: p for p in t.players}
    decks: dict[tuple[int, str], ImportedDeck] = {}
    for name, prow in by_player.items():
        by_ident: dict[str, list[_Row]] = {}
        for r in prow:
            by_ident.setdefault(r.identity, []).append(r)
        rep.decks_in_file += len(by_ident)
        pid = pids[name]
        if pid is None or pid not in players:
            rep.reject("player_not_found", prow[0].line, len(by_ident))
            continue
        for ident_title, drows in by_ident.items():
            deck = _deck(pid, ident_title, drows, players[pid], catalog, rep)
            if deck is None:
                continue
            if (pid, deck.side) in decks:
                rep.reject("two_decks_for_one_side", drows[0].line)
                continue
            decks[(pid, deck.side)] = deck
    rep.decks_imported = len(decks)
    with_deck = {pid for pid, _ in decks}
    rep.cobra_without_deck = [p.swiss_rank or 0 for p in t.players if p.pid not in with_deck]
    rec = ImportedDecks(
        cobra_id=t.id,
        origin=origin,
        imported_at=imported_at,
        decks=[decks[k] for k in sorted(decks)],
    ).hashed()
    return rec, rep


def _deck(
    pid: int,
    ident_title: str,
    rows: list[_Row],
    player: CobraPlayer,
    catalog: Catalog,
    rep: ImportReport,
) -> ImportedDeck | None:
    first = rows[0].line
    card = catalog.cards.get(catalog.card_of_title(ident_title) or "")
    if card is None or not card.card_type_id.endswith("identity") or card.side_id not in ("corp", "runner"):
        rep.reject("unknown_identity", first)
        return None
    side: Side = "corp" if card.side_id == "corp" else "runner"
    cobra_ident = catalog.identity_of_title(
        player.corp_identity if side == "corp" else player.runner_identity
    )
    if cobra_ident is not None and cobra_ident != card.id:
        rep.reject("identity_differs_from_cobra", first)
        return None
    cards: dict[str, int] = {}
    for r in rows:
        cid = catalog.card_of_title(r.card)
        if cid is None:
            rep.reject("unknown_card", r.line)
            return None
        if not QTY.fullmatch(r.qty) or int(r.qty) == 0:
            rep.reject("bad_count", r.line)
            return None
        cards[cid] = cards.get(cid, 0) + int(r.qty)
    return ImportedDeck(
        pid=pid,
        side=side,
        identity=card.id,
        cards=[CardQty(card_id=k, qty=v) for k, v in sorted(cards.items())],
    )
