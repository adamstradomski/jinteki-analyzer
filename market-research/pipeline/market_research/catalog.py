"""The card catalog view used by normalization, legality and publishing (from NRDB catalog records)."""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from market_research.records import CatCard, CatRestriction, CatSnapshot, NrdbCatalog

STANDARD = "standard"
TYPE_ORDER = [
    "corp_identity", "runner_identity", "agenda", "asset", "upgrade", "operation", "ice",
    "event", "hardware", "resource", "program",
]  # fmt: skip


def title_key(title: str) -> str:
    # NFKD splits "é" into "e" and an accent, which is dropped, as is any other non-ASCII letter or
    # digit. Other non-ASCII characters (curly quotes, dashes, ellipses) separate words like the
    # ASCII punctuation an export may straighten them to, so "O’Brian" keys like "O'Brian".
    t = "".join(
        ch if ch.isascii() else "" if ch.isalnum() else " "
        for ch in unicodedata.normalize("NFKD", title)
        if not unicodedata.combining(ch)
    )
    return re.sub(r"[^a-z0-9]+", " ", t.lower()).strip()


@dataclass
class Legality:
    legal: bool
    issues: list[str]


class Catalog:
    def __init__(self, records: dict[str, NrdbCatalog]) -> None:
        self.cards: dict[str, CatCard] = (
            {c.id: c for c in records["cards"].cards} if "cards" in records else {}
        )
        self.printing_to_card: dict[str, str] = {}
        if "printings" in records:
            for p in records["printings"].printings:
                self.printing_to_card[p.id] = p.card_id
        for c in self.cards.values():
            for pid in c.printing_ids:
                self.printing_to_card.setdefault(pid, c.id)
        self.restrictions: dict[str, CatRestriction] = (
            {r.id: r for r in records["restrictions"].restrictions} if "restrictions" in records else {}
        )
        snaps = records["snapshots"].snapshots if "snapshots" in records else []
        self.standard_snapshots: list[CatSnapshot] = sorted(
            (s for s in snaps if s.format_id == STANDARD and s.date_start),
            key=lambda s: (s.date_start or "", s.id),
        )
        self.identity_by_title: dict[str, str] = {}
        for c in sorted(self.cards.values(), key=lambda c: c.id):
            if c.card_type_id.endswith("identity"):
                self.identity_by_title.setdefault(title_key(c.title), c.id)

    def ok(self) -> bool:
        return bool(self.cards) and bool(self.standard_snapshots)

    def card_of_printing(self, printing_id: str | None) -> str | None:
        return self.printing_to_card.get(printing_id or "")

    def identity_of_title(self, title: str | None) -> str | None:
        if not title:
            return None
        k = title_key(title)
        if k in self.identity_by_title:
            return self.identity_by_title[k]
        # NRTM exports sometimes carry only the identity's short name (before the colon).
        matches = {v for t, v in self.identity_by_title.items() if t.startswith(k + " ") or t == k}
        return matches.pop() if len(matches) == 1 else None

    def is_standard_restriction(self, rid: str | None) -> bool:
        return any(s.restriction_id == rid for s in self.standard_snapshots) if rid else False

    def snapshot_at(self, d: str) -> CatSnapshot | None:
        """The Standard snapshot in force on a date."""
        cur = None
        for s in self.standard_snapshots:
            if (s.date_start or "") <= d:
                cur = s
        return cur

    def snapshot_for_restriction(self, rid: str) -> CatSnapshot | None:
        for s in reversed(self.standard_snapshots):
            if s.restriction_id == rid:
                return s
        return None

    def standard_restrictions(self) -> list[str]:
        seen: list[str] = []
        for s in self.standard_snapshots:
            if s.restriction_id and s.restriction_id not in seen:
                seen.append(s.restriction_id)
        return seen

    def legal_in(self, card_id: str, rid: str) -> bool:
        c = self.cards.get(card_id)
        snap = self.snapshot_for_restriction(rid)
        r = self.restrictions.get(rid)
        if c is None or snap is None:
            return False
        if snap.card_pool_id and snap.card_pool_id not in c.card_pool_ids:
            return False
        return not (r and card_id in r.verdicts.banned)

    def banned_in(self, card_id: str, rid: str) -> bool:
        """Whether the ban list itself bans the card (not rotation or a card pool it is missing from)."""
        r = self.restrictions.get(rid)
        return bool(r and card_id in r.verdicts.banned)

    def type_rank(self, card_id: str) -> int:
        t = self.cards[card_id].card_type_id if card_id in self.cards else ""
        return TYPE_ORDER.index(t) if t in TYPE_ORDER else len(TYPE_ORDER)

    def plain_text(self, identity: str | None, cards: dict[str, int]) -> str:
        lines = []
        if identity:
            lines.append(self.title(identity))
        for cid in sorted(cards, key=lambda c: (self.type_rank(c), title_key(self.title(c)), c)):
            lines.append(f"{cards[cid]} {self.title(cid)}")
        return "\n".join(lines)

    def title(self, card_id: str) -> str:
        c = self.cards.get(card_id)
        return c.title if c else card_id

    def check_deck(self, side: str, identity: str | None, cards: dict[str, int], rid: str) -> Legality:
        issues: list[str] = []
        ident = self.cards.get(identity or "")
        if ident is None:
            return Legality(False, ["unknown_identity"])
        if ident.side_id != side:
            issues.append("identity_side")
        if not self.legal_in(ident.id, rid):
            issues.append(f"identity_not_legal:{ident.id}")
        r = self.restrictions.get(rid)
        total = 0
        influence = 0
        restricted = 0
        points = 0
        agenda_points = 0
        for cid, qty in sorted(cards.items()):
            c = self.cards.get(cid)
            if c is None:
                issues.append(f"unknown_card:{cid}")
                continue
            total += qty
            if c.side_id != side:
                issues.append(f"wrong_side:{cid}")
            if c.card_type_id.endswith("identity"):
                issues.append(f"extra_identity:{cid}")
            if qty > (c.deck_limit if c.deck_limit is not None else 3):
                issues.append(f"copies:{cid}")
            if not self.legal_in(cid, rid):
                issues.append(f"not_legal:{cid}")
            if c.faction_id != ident.faction_id and not c.faction_id.startswith("neutral"):
                influence += (c.influence_cost or 0) * qty
            if r is not None:
                influence += r.verdicts.universal_faction_cost.get(cid, 0) * qty
                if cid in r.verdicts.restricted:
                    restricted += 1
                points += r.verdicts.points.get(cid, 0)
            if c.card_type_id == "agenda":
                agenda_points += (c.agenda_points or 0) * qty
        min_size = ident.minimum_deck_size or 0
        if total < min_size:
            issues.append("deck_size")
        if ident.influence_limit is not None and influence > ident.influence_limit:
            issues.append("influence")
        if restricted > 1:
            issues.append("restricted")
        if r is not None and r.point_limit is not None and points > r.point_limit:
            issues.append("points")
        if side == "corp":
            need = 2 * (max(total, min_size) // 5) + 2
            if agenda_points not in (need, need + 1):
                issues.append("agenda_points")
        return Legality(not issues, issues)
