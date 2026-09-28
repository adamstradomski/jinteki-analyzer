"""Builds the anonymised HTTP fixtures in tests/fixtures/http/.

Usage (manual, once; the output is committed):

    python tests/fixtures/generate.py --cards-json /path/to/netrunner-cards-json

The card data (IDs, printings, identities, restrictions) is real, taken from a checkout of
github.com/NetrunnerDB/netrunner-cards-json. Tournaments, pairings and decks are synthetic but
shaped exactly like the sources (Cobra NRTM export, Cobra JSON:API, Cobra view_decks pages, ABR
API, NetrunnerDB v2 and v3 APIs). Every personal field holds a PII_CANARY_* value so tests can
prove none of it survives scrubbing. Output is deterministic for a given card-data checkout.
"""

from __future__ import annotations

import argparse
import html
import json
import random
import shutil
import zlib
from datetime import UTC, date, datetime, timedelta
from email.utils import format_datetime
from pathlib import Path
from typing import Any

HERE = Path(__file__).parent
OUT = HERE / "http"
TODAY = date(2026, 9, 27)
POOL = "standard_2026_vantage_point"
STD_SNAPSHOTS = ["standard_31", "standard_32", "standard_33", "standard_34", "standard_35", "standard_36"]
STARTUP_SNAPSHOT_IDS = ["startup_1"]
RESTRICTION_FOR = [
    (date(2026, 8, 1), "standard_balance_update_26_08"),
    (date(2026, 5, 1), "standard_ban_list_26_05"),
    (date(2026, 3, 13), "standard_ban_list_26_03"),
]
UUID_DECKLIST = "e0054f23-1dab-4f56-82e5-b3bdcb816af3"
UUID_PRIVATE = "4b2c9e1a-77d0-4c1b-9a51-2f0d3c6e8a10"
UUID_COBRA_PRIVATE = "9d3f6b2e-0c4a-4e7b-8b1d-5a6c7e8f9012"

routes: list[dict[str, Any]] = []
canary_n = 0


def public_name() -> str:
    """Tournament names are public and stored; they use the canary counter but are not canaries."""
    return canary("TOURNAMENT").replace("PII_CANARY_TOURNAMENT_", "Fixture Tournament ")


def canary(kind: str) -> str:
    global canary_n
    canary_n += 1
    return f"PII_CANARY_{kind}_{canary_n:02d}"


def http_date(d: date) -> str:
    return format_datetime(datetime(d.year, d.month, d.day, 12, 0, tzinfo=UTC), usegmt=True)


def add_route(
    url: str,
    body: bytes | str | None,
    *,
    status: int = 200,
    headers: dict[str, str] | None = None,
    name: str | None = None,
    content_type: str = "application/json",
) -> None:
    rel = None
    if body is not None:
        data = body.encode("utf-8") if isinstance(body, str) else body
        rel = name or url.split("://", 1)[1].replace("?", "__").replace("&", "_").replace("[", "(").replace(
            "]", ")"
        )
        rel = rel.replace("=", "-").replace("/", "__")
        ext = (
            ".html"
            if content_type.startswith("text/html")
            else (".txt" if content_type.startswith("text/plain") else ".json")
        )
        rel = rel + ext
        (OUT / rel).write_bytes(data)
    h = {"Content-Type": content_type}
    h.update(headers or {})
    routes.append({"url": url, "status": status, "file": rel, "headers": h})


def jdump(obj: Any) -> str:
    return json.dumps(obj, indent=1, ensure_ascii=False)


def restriction_at(d: date) -> str:
    for start, rid in RESTRICTION_FOR:
        if d >= start:
            return rid
    return RESTRICTION_FOR[-1][1]


# ------------------------------------------------------------------ card data


class Cards:
    def __init__(self, root: Path) -> None:
        v2 = root / "v2"
        self.cards = {p.stem: json.loads(p.read_text()) for p in (v2 / "cards").glob("*.json")}
        self.sets = {s["id"]: s for s in json.loads((v2 / "card_sets.json").read_text())}
        self.printings: list[dict[str, Any]] = []
        for p in sorted((v2 / "printings").glob("*.json")):
            self.printings += json.loads(p.read_text())
        self.pools = {p["id"]: p for p in json.loads((v2 / "card_pools" / "standard.json").read_text())}
        self.pools.update({p["id"]: p for p in json.loads((v2 / "card_pools" / "startup.json").read_text())})
        self.std = json.loads((v2 / "formats" / "standard.json").read_text())
        self.startup = json.loads((v2 / "formats" / "startup.json").read_text())
        self.restrictions = {}
        for f in ("standard", "startup"):
            for p in (v2 / "restrictions" / f).glob("*.json"):
                self.restrictions[p.stem] = json.loads(p.read_text())
        self.by_card: dict[str, list[dict[str, Any]]] = {}
        for pr in self.printings:
            self.by_card.setdefault(pr["card_id"], []).append(pr)
        for v in self.by_card.values():
            v.sort(key=lambda x: x["id"])

    def cycles_of_pool(self, pool_id: str) -> set[str]:
        p = self.pools[pool_id]
        if "card_cycle_ids" in p:
            return set(p["card_cycle_ids"])
        return {self.sets[s]["card_cycle_id"] for s in p.get("card_set_ids", [])}

    def pools_of(self, card_id: str) -> list[str]:
        cycles = {self.sets[p["card_set_id"]]["card_cycle_id"] for p in self.by_card.get(card_id, [])}
        return sorted(pid for pid in self.pools if self.cycles_of_pool(pid) & cycles)

    def in_pool(self, card_id: str, pool_id: str = POOL) -> bool:
        return pool_id in self.pools_of(card_id)

    def latest_printing(self, card_id: str) -> str:
        return self.by_card[card_id][-1]["id"]

    def banned(self, rid: str) -> set[str]:
        return set(self.restrictions[rid].get("banned", []))


# ------------------------------------------------------------------ decks


def build_deck(cd: Cards, identity: str, rng: random.Random, rid: str, *, variant: int = 0) -> dict[str, int]:
    ident = cd.cards[identity]
    side = ident["side_id"]
    fac = ident["faction_id"]
    neutral = f"neutral_{side}"
    banned = cd.banned(rid)
    size = ident["minimum_deck_size"]
    pool = sorted(
        c
        for c, v in cd.cards.items()
        if v["side_id"] == side
        and not v["card_type_id"].endswith("identity")
        and c not in banned
        and cd.in_pool(c)
        and v["faction_id"] in (fac, neutral)
    )
    staples = [
        c
        for c in (
            ["hedge_fund", "ipo", "regolith_mining_license"]
            if side == "corp"
            else ["sure_gamble", "dirty_laundry", "creative_commission"]
        )
        if c in pool
    ]
    deck: dict[str, int] = {}
    total = 0
    if side == "corp":
        need = 2 * (size // 5) + 2
        agendas = [c for c in pool if cd.cards[c]["card_type_id"] == "agenda"]
        agendas.sort(key=lambda c: (-cd.cards[c].get("agenda_points", 0), c))
        rng.shuffle(agendas)
        pts = 0
        for a in agendas:
            ap = cd.cards[a].get("agenda_points", 0)
            lim = min(3, cd.cards[a].get("deck_limit", 3))
            q = 0
            while q < lim and pts + ap <= need + 1:
                q += 1
                pts += ap
            if q:
                deck[a] = q
                total += q
            if pts >= need:
                break
        assert need <= pts <= need + 1, (identity, pts, need)
        pool = [c for c in pool if cd.cards[c]["card_type_id"] != "agenda"]
    rest = [c for c in pool if c not in staples]
    rng.shuffle(rest)
    order = staples + rest
    if variant:
        order = staples[: max(0, len(staples) - variant)] + rest
    for c in order:
        if total >= size:
            break
        lim = (
            1
            if cd.cards[c].get("is_unique") and rng.random() < 0.5
            else min(3, cd.cards[c].get("deck_limit", 3))
        )
        q = min(lim, size - total)
        deck[c] = deck.get(c, 0) + q
        total += q
    assert total == size, (identity, total, size)
    return deck


def splash(cd: Cards, deck: dict[str, int], identity: str, rng: random.Random, rid: str) -> None:
    """Swap three filler copies for an out-of-faction card within the influence limit."""
    ident = cd.cards[identity]
    side = ident["side_id"]
    banned = cd.banned(rid)
    cands = sorted(
        c
        for c, v in cd.cards.items()
        if v["side_id"] == side
        and v["faction_id"] not in (ident["faction_id"], f"neutral_{side}")
        and not v["card_type_id"].endswith("identity")
        and v["card_type_id"] != "agenda"
        and c not in banned
        and cd.in_pool(c)
        and 1 <= v.get("influence_cost", 0) <= 3
    )
    pick = rng.choice(cands)
    fillers = [c for c, q in sorted(deck.items()) if q == 3 and cd.cards[c]["card_type_id"] != "agenda"]
    victim = fillers[-1]
    del deck[victim]
    deck[pick] = 3


# ------------------------------------------------------------------ catalog (NRDB v3)


def jsonapi(type_: str, items: list[dict[str, Any]], base: str) -> dict[str, Any]:
    return {
        "data": [
            {
                "id": it["id"],
                "type": type_,
                "attributes": {k: v for k, v in it.items() if k != "id"},
                "links": {"self": f"{base}/{it['id']}"},
            }
            for it in items
        ],
        "links": {"self": base, "first": f"{base}?page%5Bnumber%5D=1", "last": f"{base}?page%5Bnumber%5D=1"},
        "meta": {"stats": {"total": {"count": len(items)}}},
    }


def build_catalog(cd: Cards, used: set[str]) -> None:
    base = "https://api.netrunnerdb.com/api/v3/public"
    identities = {c for c, v in cd.cards.items() if v["card_type_id"].endswith("identity") and cd.in_pool(c)}
    rotated = ["account_siphon", "jackson_howard"]  # real cards outside the current Standard pool
    keep = sorted(used | identities | {c for c in rotated if c in cd.cards})
    std_snaps = [s for s in cd.std["snapshots"] if s["id"] in STD_SNAPSHOTS]
    std_restr = [s["restriction_id"] for s in std_snaps]
    cards = []
    for cid in keep:
        v = cd.cards[cid]
        prs = [p["id"] for p in cd.by_card.get(cid, [])]
        pools = cd.pools_of(cid)
        cards.append(
            {
                "id": cid,
                "stripped_title": v["stripped_title"],
                "title": v["title"],
                "card_type_id": v["card_type_id"],
                "side_id": v["side_id"],
                "faction_id": v["faction_id"],
                "cost": v.get("cost"),
                "advancement_requirement": v.get("advancement_requirement"),
                "agenda_points": v.get("agenda_points"),
                "base_link": v.get("base_link"),
                "deck_limit": v.get("deck_limit"),
                "in_restriction": False,
                "influence_cost": v.get("influence_cost"),
                "influence_limit": v.get("influence_limit"),
                "memory_cost": v.get("memory_cost"),
                "minimum_deck_size": v.get("minimum_deck_size"),
                "num_printings": len(prs),
                "printing_ids": prs,
                "date_release": None,
                "restriction_ids": [r for r in std_restr if cid in cd.banned(r)],
                "strength": v.get("strength"),
                "stripped_text": v.get("stripped_text"),
                "text": v.get("text"),
                "trash_cost": v.get("trash_cost"),
                "is_unique": v.get("is_unique", False),
                "card_subtype_ids": v.get("subtypes", []),
                "display_subtypes": " - ".join(v.get("subtypes", [])),
                "attribution": v.get("attribution"),
                "updated_at": "2026-08-31T00:00:00Z",
                "format_ids": ["standard"] if POOL in pools else [],
                "card_pool_ids": pools,
                "snapshot_ids": [],
                "card_cycle_ids": [],
                "card_cycle_names": [],
                "card_set_ids": [],
                "card_set_names": [],
                "designed_by": v.get("designed_by"),
                "narrative_text": None,
                "printings_released_by": [],
                "pronouns": None,
                "pronunciation_approximation": None,
                "pronunciation_ipa": None,
                "layout_id": "normal",
                "num_extra_faces": 0,
                "faces": [],
                "card_abilities": {},
                "restrictions": {},
                "latest_printing_id": prs[-1] if prs else None,
                "latest_printing_images": {},
            }
        )
    printings = []
    for cid in keep:
        for p in cd.by_card.get(cid, []):
            s = cd.sets[p["card_set_id"]]
            printings.append(
                {
                    "id": p["id"],
                    "card_id": cid,
                    "card_cycle_id": s["card_cycle_id"],
                    "card_cycle_name": None,
                    "card_set_id": p["card_set_id"],
                    "card_set_name": s["name"],
                    "flavor": p.get("flavor"),
                    "display_illustrators": p.get("illustrator"),
                    "illustrator_ids": [],
                    "illustrator_names": [],
                    "position": p.get("position"),
                    "position_in_set": p.get("position"),
                    "quantity": p.get("quantity"),
                    "date_release": s.get("date_release"),
                    "updated_at": "2026-08-31T00:00:00Z",
                    "title": cd.cards[cid]["title"],
                    "card_type_id": cd.cards[cid]["card_type_id"],
                    "side_id": cd.cards[cid]["side_id"],
                    "faction_id": cd.cards[cid]["faction_id"],
                }
            )
    sets = [
        {
            "id": s["id"],
            "name": s["name"],
            "date_release": s.get("date_release"),
            "size": s.get("size"),
            "card_cycle_id": s["card_cycle_id"],
            "card_set_type_id": s.get("card_set_type_id"),
            "legacy_code": s.get("legacy_code"),
            "position": s.get("position"),
            "first_printing_id": None,
            "released_by": s.get("released_by"),
            "updated_at": "2026-08-31T00:00:00Z",
        }
        for s in sorted(cd.sets.values(), key=lambda s: s["id"])
        if s["card_cycle_id"] in cd.cycles_of_pool(POOL)
    ]
    formats = [
        {
            "id": "standard",
            "name": "Standard",
            "active_snapshot_id": "standard_36",
            "snapshot_ids": [s["id"] for s in std_snaps],
            "restriction_ids": std_restr,
            "active_card_pool_id": POOL,
            "active_restriction_id": "standard_balance_update_26_08",
            "updated_at": "2026-08-01T00:00:00Z",
        },
        {
            "id": "startup",
            "name": "Startup",
            "active_snapshot_id": "startup_1",
            "snapshot_ids": ["startup_1"],
            "restriction_ids": [],
            "active_card_pool_id": "startup_2026",
            "active_restriction_id": None,
            "updated_at": "2026-08-01T00:00:00Z",
        },
    ]
    restrictions = []
    for rid in std_restr:
        r = cd.restrictions[rid]
        restrictions.append(
            {
                "id": rid,
                "name": r["name"],
                "date_start": r["date_start"],
                "point_limit": None,
                "format_id": "standard",
                "verdicts": {
                    "banned": sorted(r.get("banned", [])),
                    "restricted": [],
                    "universal_faction_cost": {},
                    "global_penalty": [],
                    "points": {},
                },
                "banned_subtypes": [],
                "size": len(r.get("banned", [])),
                "updated_at": "2026-08-01T00:00:00Z",
            }
        )
    snapshots = [
        {
            "id": s["id"],
            "format_id": "standard",
            "active": s.get("active", False) or s["id"] == "standard_36",
            "card_cycle_ids": [],
            "card_set_ids": [],
            "card_pool_id": s["card_pool_id"],
            "restriction_id": s.get("restriction_id"),
            "num_cards": 0,
            "date_start": s["date_start"],
            "updated_at": "2026-08-01T00:00:00Z",
        }
        for s in std_snaps
    ]
    snapshots = [dict(s, active=(s["id"] == "standard_36")) for s in snapshots]
    snapshots.append(
        {
            "id": "startup_1",
            "format_id": "startup",
            "active": True,
            "card_cycle_ids": [],
            "card_set_ids": [],
            "card_pool_id": "startup_2026",
            "restriction_id": None,
            "num_cards": 0,
            "date_start": "2026-03-13",
            "updated_at": "2026-08-01T00:00:00Z",
        }
    )
    for name, items, size in (
        ("cards", cards, 500),
        ("printings", printings, 500),
        ("card_sets", sets, 1000),
        ("formats", formats, 1000),
        ("restrictions", restrictions, 1000),
        ("snapshots", snapshots, 1000),
    ):
        url = f"{base}/{name}?page%5Bnumber%5D=1&page%5Bsize%5D={size}"
        add_route(
            url, jdump(jsonapi(name, items, f"{base}/{name}")), headers={"ETag": f'W/"nrdb3-{name}-v1"'}
        )


# ------------------------------------------------------------------ tournaments


class Player:
    def __init__(
        self,
        pid: int,
        corp_id: str,
        runner_id: str,
        corp_deck: dict[str, int],
        runner_deck: dict[str, int],
        skill: float,
    ) -> None:
        self.pid = pid
        self.corp_id = corp_id
        self.runner_id = runner_id
        self.corp_deck = corp_deck
        self.runner_deck = runner_deck
        self.skill = skill
        self.name = canary("NAME")
        self.pronouns = "PII_CANARY_PRONOUNS"
        self.points = 0
        self.corp_points = 0
        self.runner_points = 0
        self.opps: list[int] = []
        self.swiss_rank = 0
        self.cut_rank: int | None = None


def game(rng: random.Random, corp: Player, runner: Player) -> str:
    p = 0.5 + (corp.skill - runner.skill) * 0.35
    r = rng.random()
    if r < 0.03:
        return "draw"
    return "corp" if r < p else "runner"


CORP_IDS = [
    "haas_bioroid_precision_design",
    "jinteki_restoring_humanity",
    "weyland_consortium_built_to_last",
    "epiphany_analytica_nations_undivided",
    "a_teia_ip_recovery",
    "thunderbolt_armaments_peace_through_power",
    "earth_station_sea_headquarters",
    "synapse_global_faster_than_thought",
]
RUNNER_IDS = [
    "zahya_sadeghi_versatile_smuggler",
    "tao_salonga_telepresence_magician",
    "rene_loup_arcemont_party_animal",
    "barry_baz_wong_tri_maf_veteran",
    "esa_afontov_eco_insurrectionist",
    "lat_ethical_freelancer",
    "topan_ormas_leader",
    "magdalene_keino_chemutai_cryptarchitect",
]


def make_players(cd: Cards, rng: random.Random, n: int, pid0: int, rid: str, used: set[str]) -> list[Player]:
    players = []
    for i in range(n):
        ci = CORP_IDS[(i * 3 + pid0) % len(CORP_IDS)]
        ri = RUNNER_IDS[(i * 5 + pid0) % len(RUNNER_IDS)]
        cdk = build_deck(cd, ci, random.Random(zlib.crc32(f"{ci}:{i % 3}".encode())), rid, variant=i % 2)
        rdk = build_deck(cd, ri, random.Random(zlib.crc32(f"{ri}:{i % 3}".encode())), rid, variant=i % 2)
        if i % 4 == 1:
            splash(cd, cdk, ci, random.Random(i), rid)
        if i % 4 == 2:
            splash(cd, rdk, ri, random.Random(i + 100), rid)
        used.update(cdk, rdk, [ci, ri])
        players.append(Player(pid0 + i, ci, ri, cdk, rdk, rng.random()))
    return players


def swiss_pairs(rng: random.Random, players: list[Player]) -> list[tuple[Player, Player]]:
    order = sorted(players, key=lambda p: (-p.points, rng.random()))
    pairs = []
    pool = order[:]
    while len(pool) >= 2:
        a = pool.pop(0)
        j = next((k for k, b in enumerate(pool) if b.pid not in a.opps), 0)
        b = pool.pop(j)
        a.opps.append(b.pid)
        b.opps.append(a.pid)
        pairs.append((a, b))
    return pairs


def run_sss(rng: random.Random, players: list[Player], rounds: int) -> list[list[dict[str, Any]]]:
    out = []
    for r in range(rounds):
        rnd = []
        for t, (a, b) in enumerate(swiss_pairs(rng, players), start=1):
            a_corp = (r + t) % 2 == 0
            corp, runner = (a, b) if a_corp else (b, a)
            idraw = r == rounds - 1 and t == 1
            res = "draw" if idraw else game(rng, corp, runner)
            cs, rs = {"corp": (3, 0), "runner": (0, 3), "draw": (1, 1)}[res]
            corp.points += cs
            corp.corp_points += cs
            runner.points += rs
            runner.runner_points += rs

            def entry(p: Player, role: str) -> dict[str, Any]:
                s = cs if role == "corp" else rs
                return {
                    "id": p.pid,
                    "role": role,
                    "combinedScore": s,
                    "runnerScore": s if role == "runner" else None,
                    "corpScore": s if role == "corp" else None,
                }

            e1 = entry(a, "corp" if a_corp else "runner")
            e2 = entry(b, "runner" if a_corp else "corp")
            rnd.append(
                {
                    "table": t,
                    "player1": e1,
                    "player2": e2,
                    "intentionalDraw": idraw,
                    "twoForOne": False,
                    "eliminationGame": False,
                }
            )
        out.append(rnd)
    return out


def run_dss(rng: random.Random, players: list[Player], rounds: int) -> list[list[dict[str, Any]]]:
    out = []
    for r in range(rounds):
        rnd = []
        for t, (a, b) in enumerate(swiss_pairs(rng, players), start=1):
            idraw = r == rounds - 1 and t == 2
            g1 = "draw" if idraw else game(rng, a, b)  # a corp
            g2 = "draw" if idraw else game(rng, b, a)  # b corp
            if r == 0 and t == 1:
                g1 = "draw"  # a timed-out game counted as a tie
            s1 = {"corp": (3, 0), "runner": (0, 3), "draw": (1, 1)}[g1]
            s2 = {"corp": (3, 0), "runner": (0, 3), "draw": (1, 1)}[g2]
            a_c, b_r = s1
            b_c, a_r = s2
            a.points += a_c + a_r
            b.points += b_c + b_r
            a.corp_points += a_c
            a.runner_points += a_r
            b.corp_points += b_c
            b.runner_points += b_r
            rnd.append(
                {
                    "table": t,
                    "player1": {
                        "id": a.pid,
                        "runnerScore": a_r,
                        "corpScore": a_c,
                        "combinedScore": a_c + a_r,
                    },
                    "player2": {
                        "id": b.pid,
                        "runnerScore": b_r,
                        "corpScore": b_c,
                        "combinedScore": b_c + b_r,
                    },
                    "intentionalDraw": idraw,
                    "twoForOne": False,
                    "eliminationGame": False,
                }
            )
            a.opps.append(b.pid)
            b.opps.append(a.pid)
        out.append(rnd)
    return out


def standings(players: list[Player]) -> list[Player]:
    by = {p.pid: p for p in players}
    for p in players:
        p.sos = round(sum(by[o].points for o in p.opps) / max(len(p.opps), 1) / 3, 4)  # type: ignore[attr-defined]
    for p in players:
        p.esos = round(sum(by[o].sos for o in p.opps) / max(len(p.opps), 1), 4)  # type: ignore[attr-defined]
    ranked = sorted(players, key=lambda p: (-p.points, -p.sos, -p.esos, p.pid))  # type: ignore[attr-defined]
    for i, p in enumerate(ranked, start=1):
        p.swiss_rank = i
    return ranked


def run_de4(rng: random.Random, top: list[Player]) -> list[list[dict[str, Any]]]:
    def play(a: Player, b: Player, a_corp: bool, table: int) -> tuple[dict[str, Any], Player, Player]:
        corp, runner = (a, b) if a_corp else (b, a)
        res = game(rng, corp, runner)
        while res == "draw":
            res = game(rng, corp, runner)
        winner = corp if res == "corp" else runner
        loser = runner if winner is corp else corp
        g = {
            "table": table,
            "player1": {"id": a.pid, "role": "corp" if a_corp else "runner", "winner": winner is a},
            "player2": {"id": b.pid, "role": "runner" if a_corp else "corp", "winner": winner is b},
            "intentionalDraw": False,
            "twoForOne": False,
            "eliminationGame": True,
        }
        return g, winner, loser

    s1, s2, s3, s4 = top
    g1, w1, l1 = play(s1, s4, True, 1)
    g2, w2, l2 = play(s2, s3, False, 2)
    g3, w3, l3 = play(l1, l2, True, 3)
    l3.cut_rank = 4
    g4, w4, l4 = play(w1, w2, False, 4)
    g5, w5, l5 = play(l4, w3, True, 5)
    l5.cut_rank = 3
    g6, w6, l6 = play(w4, w5, True, 6)
    w6.cut_rank = 1
    l6.cut_rank = 2
    return [[g1, g2], [g3, g4], [g5], [g6]]


def nrtm(
    tname: str,
    d: date,
    players: list[Player],
    rounds: list[list[dict[str, Any]]],
    elim: list[list[dict[str, Any]]],
    cut: list[Player],
    cd: Cards,
) -> dict[str, Any]:
    return {
        "name": tname,
        "date": d.isoformat(),
        "cutToTop": len(cut),
        "preliminaryRounds": len(rounds),
        "tournamentOrganiser": {"nrdbId": "PII_CANARY_USER_1234", "nrdbUsername": canary("NAME")},
        "players": [
            {
                "id": p.pid,
                "name": p.name,
                "rank": p.swiss_rank,
                "corpFaction": cd.cards[p.corp_id]["faction_id"],
                "corpIdentity": cd.cards[p.corp_id]["title"],
                "runnerFaction": cd.cards[p.runner_id]["faction_id"],
                "runnerIdentity": cd.cards[p.runner_id]["title"],
                "matchPoints": p.points,
                "strengthOfSchedule": p.sos,
                "extendedStrengthOfSchedule": p.esos,  # type: ignore[attr-defined]
                "pronouns": p.pronouns,
            }
            for p in sorted(players, key=lambda p: p.swiss_rank)
        ],
        "eliminationPlayers": [
            {"id": p.pid, "name": p.name, "rank": p.cut_rank, "seed": i + 1}
            for i, p in sorted(enumerate(cut), key=lambda x: x[1].cut_rank or 99)
        ],
        "rounds": rounds + elim,
        "uploadedFrom": "Cobra",
        "links": [
            {
                "rel": "schemaderivedfrom",
                "href": "https://tournaments.nullsignal.games/schemas/tournament-schema.json",
            },
            {"rel": "uploadedfrom", "href": "https://tournaments.nullsignal.games/PII_CANARY_LINK"},
        ],
    }


def cobra_tournament_attrs(
    tid: int,
    d: date,
    *,
    type_id: int,
    format_id: int,
    rid: str | None,
    swiss_format: str,
    swiss_vis: str,
    cut_vis: str,
    active: int,
    abr_code: str | None,
    private: bool = False,
    stage: str = "double_elim",
) -> dict[str, Any]:
    return {
        "name": public_name(),
        "slug": "PII_CANARY_SLUG",
        "abr_code": abr_code,
        "private": private,
        "user_id": "PII_CANARY_USER_1234",
        "tournament_organizer": canary("NAME"),
        "date": d.isoformat(),
        "time_zone": "Europe/Warsaw",
        "registration_starts": None,
        "tournament_starts": None,
        "organizer_contact": "PII_CANARY_CONTACT@example.invalid",
        "event_link": "https://PII_CANARY_LINK.example/",
        "stream_url": "https://PII_CANARY_STREAM.example/",
        "description": canary("DESCRIPTION"),
        "additional_prizes_description": canary("DESCRIPTION"),
        "official_prize_kit_id": None,
        "official_prize_kit_name": None,
        "stage": stage,
        "manual_seed": False,
        "self_registration": True,
        "nrdb_deck_registration": True,
        "decklist_required": True,
        "allow_self_reporting": True,
        "allow_streaming_opt_out": True,
        "all_players_unlocked": False,
        "any_player_unlocked": False,
        "registration_closed": True,
        "swiss_deck_visibility": swiss_vis,
        "cut_deck_visibility": cut_vis,
        "swiss_format": swiss_format,
        "tournament_type_id": type_id,
        "format_id": format_id,
        "format_name": {1: "Standard", 2: "Startup", 3: "Eternal"}[format_id],
        "deckbuilding_restriction_id": rid,
        "deckbuilding_restriction_name": None,
        "card_set_id": "vantage_point",
        "active_player_count": active,
        "dropped_player_count": 0,
        "created_at": f"{(d - timedelta(days=30)).isoformat()}T10:00:00Z",
        "updated_at": f"{d.isoformat()}T22:00:00Z",
    }


def deck_json(
    cd: Cards, p: Player, side: str, tid: int, deck_override: dict[str, int] | None = None
) -> dict[str, Any]:
    ident = p.corp_id if side == "corp" else p.runner_id
    deck = deck_override or (p.corp_deck if side == "corp" else p.runner_deck)
    iv = cd.cards[ident]
    return {
        "details": {
            "id": p.pid * 10 + (1 if side == "corp" else 2),
            "player_id": p.pid,
            "user_id": "PII_CANARY_USER_1234",
            "name": canary("DECKNAME"),
            "identity_title": iv["title"],
            "identity_nrdb_card_id": ident,
            "identity_nrdb_printing_id": cd.latest_printing(ident),
            "side_id": side,
            "faction_id": iv["faction_id"],
            "max_influence": iv.get("influence_limit"),
            "min_deck_size": iv.get("minimum_deck_size"),
            "nrdb_uuid": UUID_COBRA_PRIVATE if (p.pid == 59700 and side == "corp") else None,
            "created_at": "2026-09-18T10:00:00Z",
            "updated_at": "2026-09-18T10:00:00Z",
            "mine": False,
            "player_name": p.name,
        },
        "cards": [
            {
                "id": i + 1,
                "deck_id": p.pid * 10,
                "title": cd.cards[c]["title"],
                "quantity": q,
                "influence": cd.cards[c].get("influence_cost", 0),
                "influence_cost": cd.cards[c].get("influence_cost", 0),
                "nrdb_card_id": c,
                "nrdb_printing_id": cd.latest_printing(c),
                "card_type_id": cd.cards[c]["card_type_id"],
                "faction_id": cd.cards[c]["faction_id"],
                "created_at": "2026-09-18T10:00:00Z",
                "updated_at": "2026-09-18T10:00:00Z",
            }
            for i, (c, q) in enumerate(sorted(deck.items(), key=lambda x: cd.cards[x[0]]["title"]))
        ],
    }


def view_decks_html(p: Player, corp: dict[str, Any] | None, runner: dict[str, Any] | None) -> str:
    def attr(v: dict[str, Any] | None) -> str:
        return html.escape(json.dumps(v), quote=True) if v is not None else ""

    return f"""<!DOCTYPE html>
<html>
<head>
<title>Cobra</title>
<meta name="csrf-token" content="PII_CANARY_TOKEN">
<script src="/vite/assets/application.js"></script>
</head>
<body>
<nav class="navbar"><a class="navbar-brand" href="/">Cobra</a><a href="/login">Sign in</a></nav>
<div class="container">
<input id="corp_deck_name" type="hidden" value="{html.escape(corp["details"]["name"]) if corp else ""}">
<input id="runner_deck_name" type="hidden" value="{html.escape(runner["details"]["name"]) if runner else ""}">
<input id="corp_deck" type="hidden" value="{attr(corp)}">
<input id="runner_deck" type="hidden" value="{attr(runner)}">
<div class="container"><div class="row mb-2"><div class="col"><h4>{html.escape(p.name)} ({p.pronouns})</h4></div></div>
<div class="row" id="display_player_decks"></div></div>
</div>
<footer>Contact PII_CANARY_CONTACT@example.invalid</footer>
</body>
</html>
"""


def nrdb_v2_decklist(
    cd: Cards, dl_id: int, uuid: str, published: date, identity: str, deck: dict[str, int]
) -> dict[str, Any]:
    cards = {cd.latest_printing(identity): 1}
    for c, q in sorted(deck.items()):
        cards[cd.latest_printing(c)] = q
    return {
        "id": dl_id,
        "uuid": uuid,
        "date_creation": f"{published.isoformat()}T18:30:00+00:00",
        "date_update": f"{published.isoformat()}T18:30:00+00:00",
        "name": canary("DECKNAME"),
        "description": canary("DESCRIPTION"),
        "user_id": "PII_CANARY_USER_1234",
        "user_name": canary("NAME"),
        "tournament_badge": True,
        "cards": cards,
        "mwl_code": None,
        "votes_count": 3,
        "favorites_count": 1,
        "comments_count": 0,
    }


def v2_envelope(data: list[dict[str, Any]], last: date | None) -> dict[str, Any]:
    return {
        "data": data,
        "total": len(data),
        "success": True,
        "version_number": "2.0",
        "last_updated": f"{last.isoformat()}T18:30:00+00:00" if last else None,
    }


def abr_event(
    eid: int,
    d: date,
    *,
    type_id: int,
    players: int,
    top: int,
    claims: int,
    matchdata: bool,
    fmt: str = "standard",
    approved: int | None = 1,
    conflict: bool = False,
    winner: tuple[str, str] | None = None,
    country: str = "Poland",
    extra: bool = False,
) -> dict[str, Any]:
    ev = {
        "id": eid,
        "title": public_name(),
        "contact": "PII_CANARY_CONTACT@example.invalid",
        "approved": approved,
        "registration_count": players,
        "photos": 0,
        "url": f"https://alwaysberunning.net/tournaments/{eid}/PII_CANARY_SLUG",
        "link_facebook": "https://PII_CANARY_LINK.example/",
        "creator_id": "PII_CANARY_USER_1234",
        "creator_name": canary("NAME"),
        "creator_supporter": 0,
        "creator_class": "",
        "location": "PII_CANARY_ADDRESS",
        "location_address": "PII_CANARY_ADDRESS",
        "location_store": "PII_CANARY_VENUE",
        "location_place_id": "PII_CANARY_PLACE",
        "location_lat": "PII_CANARY_LAT",
        "location_lng": "PII_CANARY_LNG",
        "location_country": country,
        "location_state": "PII_CANARY_ADDRESS",
        "date": d.strftime("%Y.%m.%d."),
        "type": type_id,
        "format": fmt,
        "mwl": "PII_CANARY_DESCRIPTION",
        "cardpool": "Vantage Point",
        "concluded": True,
        "players_count": players,
        "top_count": top,
        "claim_count": claims,
        "claim_conflict": conflict,
        "matchdata": matchdata,
        "videos": 0,
        "winner_runner_identity": winner[1] if winner else None,
        "winner_corp_identity": winner[0] if winner else None,
    }
    if extra:
        ev["stream_viewers"] = "PII_CANARY_DRIFT_VALUE"  # an unknown field: drift
    return ev


def abr_entry(
    cd: Cards,
    rank: int,
    cut: int | None,
    corp: str | None,
    runner: str | None,
    corp_url: str | None,
    runner_url: str | None,
    claimed: bool,
) -> dict[str, Any]:
    def side(ident: str | None, url: str | None, prefix: str) -> dict[str, Any]:
        return {
            f"{prefix}_deck_title": canary("DECKNAME") if url else None,
            f"{prefix}_deck_identity_id": cd.latest_printing(ident) if ident else None,
            f"{prefix}_deck_url": url,
            f"{prefix}_deck_identity_title": cd.cards[ident]["title"] if ident else None,
            f"{prefix}_deck_identity_faction": cd.cards[ident]["faction_id"] if ident else None,
        }

    e = {
        "user_id": "PII_CANARY_USER_1234" if claimed else 0,
        "user_name": canary("NAME") if claimed else None,
        "user_import_name": canary("NAME"),
        "rank_swiss": rank,
        "rank_top": cut,
    }
    e.update(side(runner, runner_url, "runner"))
    e.update(side(corp, corp_url, "corp"))
    return e


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cards-json", required=True, type=Path)
    args = ap.parse_args()
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    cd = Cards(args.cards_json)
    rng = random.Random(4990)
    used: set[str] = set()

    for host in (
        "alwaysberunning.net",
        "tournaments.nullsignal.games",
        "netrunnerdb.com",
        "api.netrunnerdb.com",
    ):
        add_route(
            f"https://{host}/robots.txt",
            "User-agent: *\nDisallow: /admin/\n",
            content_type="text/plain",
            name=f"robots-{host}",
        )

    cobra = "https://tournaments.nullsignal.games"
    api = f"{cobra}/api/v1/public"

    # --- Cobra reference tables (JSON:API)
    fmts = [
        {"id": "1", "name": "Standard", "position": 1},
        {"id": "2", "name": "Startup", "position": 2},
        {"id": "3", "name": "Eternal", "position": 3},
    ]
    types = [
        (1, "GNK / Seasonal"),
        (2, "Store Championship"),
        (3, "District Championship"),
        (4, "Megacity Championship"),
        (5, "Continental Championship"),
        (6, "Intercontinental Championship"),
        (7, "Circuit Breaker Invitational"),
        (8, "Community Tournament"),
        (9, "Casual Event"),
        (10, "National Championship"),
    ]
    ttypes = [
        {
            "id": str(i),
            "name": n,
            "nsg_format": i <= 7,
            "description": None,
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z",
        }
        for i, n in types
    ]
    restr = [
        {
            "id": rid,
            "name": cd.restrictions[rid]["name"],
            "date_start": cd.restrictions[rid]["date_start"],
            "play_format_id": "standard",
            "created_at": "2026-08-01T00:00:00Z",
            "updated_at": "2026-08-01T00:00:00Z",
        }
        for _, rid in RESTRICTION_FOR
    ]
    for name, items in (
        ("formats", fmts),
        ("tournament_types", ttypes),
        ("deckbuilding_restrictions", restr),
    ):
        add_route(
            f"{api}/{name}?page%5Bnumber%5D=1&page%5Bsize%5D=250",
            jdump(
                jsonapi(
                    name,
                    [dict(i, created_at="2025-01-01T00:00:00Z") if name == "formats" else i for i in items],
                    f"{api}/{name}",
                )
            ),
            headers={"ETag": f'W/"cobra-{name}-v1"'},
        )

    # --- Cobra 4990: Worlds-like, single-sided swiss + top-4 double elimination, decks public
    d4990 = date(2026, 9, 19)
    r4990 = restriction_at(d4990)
    p4990 = make_players(cd, rng, 16, 59690, r4990, used)
    # One illegal deck: a banned card in place of a filler.
    illegal = p4990[5]
    bad = sorted(
        c
        for c in cd.banned(r4990)
        if c in cd.cards
        and cd.cards[c]["side_id"] == "runner"
        and cd.cards[c]["card_type_id"] not in ("runner_identity",)
        and cd.in_pool(c)
    )[0]
    victim = sorted(c for c, q in illegal.runner_deck.items() if q == 3)[0]
    del illegal.runner_deck[victim]
    illegal.runner_deck[bad] = 3
    used.add(bad)
    rounds4990 = run_sss(rng, p4990, 6)
    ranked = standings(p4990)
    elim4990 = run_de4(rng, ranked[:4])
    add_route(
        f"{cobra}/tournaments/4990.json",
        jdump(nrtm(public_name(), d4990, p4990, rounds4990, elim4990, ranked[:4], cd)),
        headers={"ETag": 'W/"nrtm-4990-v1"'},
    )
    deck_pages: list[tuple[int, Player, dict[str, Any] | None, dict[str, Any] | None]] = []
    for p in p4990:
        deck_pages.append((4990, p, deck_json(cd, p, "corp", 4990), deck_json(cd, p, "runner", 4990)))

    # --- Cobra 5012: double-sided swiss, 8 players, no cut, swiss decks open (participants only)
    d5012 = date(2026, 9, 12)
    p5012 = make_players(cd, rng, 8, 60100, restriction_at(d5012), used)
    rounds5012 = run_dss(rng, p5012, 3)
    standings(p5012)
    add_route(
        f"{cobra}/tournaments/5012.json",
        jdump(nrtm(public_name(), d5012, p5012, rounds5012, [], [], cd)),
        headers={"ETag": 'W/"nrtm-5012-v1"'},
    )

    # --- Cobra 5015: GNK, single-sided swiss, 10 players, no cut, decks public; not on ABR
    d5015 = date(2026, 8, 22)
    p5015 = make_players(cd, rng, 10, 60200, restriction_at(d5015), used)
    rounds5015 = run_sss(rng, p5015, 4)
    standings(p5015)
    add_route(
        f"{cobra}/tournaments/5015.json",
        jdump(nrtm(public_name(), d5015, p5015, rounds5015, [], [], cd)),
        headers={"ETag": 'W/"nrtm-5015-v1"'},
    )
    for p in p5015:
        deck_pages.append(
            (
                5015,
                p,
                deck_json(cd, p, "corp", 5015),
                deck_json(cd, p, "runner", 5015) if p.pid != 60203 else None,
            )
        )

    for tid, p, cdeck, rdeck in deck_pages:
        add_route(
            f"{cobra}/tournaments/{tid}/players/{p.pid}/view_decks",
            view_decks_html(p, cdeck, rdeck),
            content_type="text/html; charset=utf-8",
            headers={"ETag": f'W/"decks-{p.pid}"'},
        )

    # --- Cobra tournaments index (newest id first)
    index = [
        (
            5025,
            cobra_tournament_attrs(
                5025,
                date(2026, 10, 3),
                type_id=2,
                format_id=1,
                rid=r4990,
                swiss_format="single_sided",
                swiss_vis="swiss_decks_public",
                cut_vis="cut_decks_public",
                active=0,
                abr_code=None,
                stage="swiss",
            ),
        ),
        (
            5021,
            cobra_tournament_attrs(
                5021,
                date(2026, 9, 20),
                type_id=1,
                format_id=1,
                rid=r4990,
                swiss_format="single_sided",
                swiss_vis="swiss_decks_public",
                cut_vis="cut_decks_public",
                active=12,
                abr_code=None,
                private=True,
            ),
        ),
        (
            5020,
            cobra_tournament_attrs(
                5020,
                date(2026, 9, 13),
                type_id=1,
                format_id=2,
                rid=None,
                swiss_format="single_sided",
                swiss_vis="swiss_decks_public",
                cut_vis="cut_decks_public",
                active=14,
                abr_code=None,
            ),
        ),
        (
            5015,
            cobra_tournament_attrs(
                5015,
                d5015,
                type_id=1,
                format_id=1,
                rid=restriction_at(d5015),
                swiss_format="single_sided",
                swiss_vis="swiss_decks_public",
                cut_vis="cut_decks_public",
                active=10,
                abr_code=None,
                stage="swiss",
            ),
        ),
        (
            5012,
            cobra_tournament_attrs(
                5012,
                d5012,
                type_id=2,
                format_id=1,
                rid=restriction_at(d5012),
                swiss_format="double_sided",
                swiss_vis="swiss_decks_open",
                cut_vis="cut_decks_private",
                active=8,
                abr_code=None,
                stage="swiss",
            ),
        ),
        (
            4990,
            cobra_tournament_attrs(
                4990,
                d4990,
                type_id=6,
                format_id=1,
                rid=r4990,
                swiss_format="single_sided",
                swiss_vis="swiss_decks_public",
                cut_vis="cut_decks_public",
                active=16,
                abr_code="5284",
            ),
        ),
    ]
    for size in (250, 4):
        pages = [index[i : i + size] for i in range(0, len(index), size)] + [[]]
        for n, page in enumerate(pages, start=1):
            doc = {
                "data": [
                    {
                        "id": str(t),
                        "type": "tournaments",
                        "attributes": dict(a),
                        "relationships": {
                            "players": {"links": {"related": f"/api/v1/public/tournaments/{t}/players"}}
                        },
                    }
                    for t, a in page
                ],
                "meta": {"stats": {"total": {"count": len(index)}}},
                "links": {"self": f"{api}/tournaments?page[number]={n}&page[size]={size}"},
            }
            add_route(
                f"{api}/tournaments?page%5Bnumber%5D={n}&page%5Bsize%5D={size}&sort=-id",
                jdump(doc),
                headers={"ETag": f'W/"index-{size}-{n}-v1"'},
            )
            if not page:
                break

    # Tournament show endpoint, read again after the event when decks were not public.
    for t, a in index:
        if t == 5012:
            add_route(
                f"{api}/tournaments/{t}",
                jdump({"data": {"id": str(t), "type": "tournaments", "attributes": dict(a)}}),
                headers={"ETag": f'W/"show-{t}-v1"'},
            )

    # --- Cobra JSON:API players (paginated), standings and pairings for 4990: shape reference
    for n in (1, 2):
        chunk = p4990[(n - 1) * 10 : n * 10]
        doc = {
            "data": [
                {
                    "id": str(p.pid),
                    "type": "players",
                    "attributes": {
                        "id": p.pid,
                        "tournament_id": 4990,
                        "user_id": "PII_CANARY_USER_1234",
                        "name": p.name,
                        "pronouns": p.pronouns,
                        "active": True,
                        "seed": None,
                        "fixed_table_number": None,
                        "manual_seed": None,
                        "first_round_bye": False,
                        "include_in_stream": True,
                        "registration_locked": True,
                        "corp_identity_id": 100 + CORP_IDS.index(p.corp_id),
                        "runner_identity_id": 200 + RUNNER_IDS.index(p.runner_id),
                    },
                }
                for p in chunk
            ],
            "meta": {"stats": {"total": {"count": 16}}},
        }
        add_route(f"{api}/tournaments/4990/players?page%5Bnumber%5D={n}&page%5Bsize%5D=10", jdump(doc))
    add_route(
        f"{api}/tournaments/4990/standings?page%5Bnumber%5D=1&page%5Bsize%5D=1000",
        jdump(
            {
                "data": [
                    {
                        "id": str(p.swiss_rank),
                        "type": "standings",
                        "attributes": {
                            "id": str(p.swiss_rank),
                            "stage_id": 1,
                            "player_id": p.pid,
                            "position": p.swiss_rank,
                            "points": p.points,
                            "sos": p.sos,
                            "extended_sos": p.esos,
                            "corp_points": p.corp_points,  # type: ignore[attr-defined]
                            "runner_points": p.runner_points,
                            "bye_points": 0,
                            "side_bias": 0,
                        },
                    }
                    for p in ranked
                ],
                "meta": {"stats": {"total": {"count": 16}}},
            }
        ),
    )
    add_route(
        f"{api}/tournaments/4990/pairings?page%5Bnumber%5D=1&page%5Bsize%5D=1000",
        jdump(
            {
                "data": [
                    {
                        "id": str(1000 + i),
                        "type": "pairings",
                        "attributes": {
                            "id": 1000 + i,
                            "table_number": g["table"],
                            "side": "player1_is_corp"
                            if g["player1"].get("role") == "corp"
                            else "player1_is_runner",
                            "score1": g["player1"].get("combinedScore"),
                            "score2": g["player2"].get("combinedScore"),
                            "player1_id": g["player1"]["id"],
                            "player2_id": g["player2"]["id"],
                            "reported": True,
                            "intentional_draw": g["intentionalDraw"],
                            "two_for_one": False,
                        },
                    }
                    for i, g in enumerate([g for r in rounds4990 for g in r])
                ],
                "meta": {"stats": {"total": {"count": 48}}},
            }
        ),
    )

    # --- NetrunnerDB decklists
    nrdb2 = "https://netrunnerdb.com/api/2.0/public"
    by_date: dict[date, list[dict[str, Any]]] = {}
    dl = 98588

    def publish(
        p: Player,
        side: str,
        published: date,
        *,
        uuid: str | None = None,
        deck: dict[str, int] | None = None,
        in_bulk: bool = True,
    ) -> str:
        nonlocal dl
        did = dl
        dl += 1
        ident = p.corp_id if side == "corp" else p.runner_id
        u = uuid or f"{did:08x}-0000-4000-8000-{did:012x}"
        body = nrdb_v2_decklist(
            cd, did, u, published, ident, deck or (p.corp_deck if side == "corp" else p.runner_deck)
        )
        if in_bulk:
            by_date.setdefault(published, []).append(body)
        else:
            add_route(
                f"{nrdb2}/decklist/{did}",
                jdump(v2_envelope([body], published)),
                headers={"Last-Modified": http_date(published)},
            )
        return f"https://netrunnerdb.com/en/decklist/{uuid or did}/PII_CANARY_SLUG-{side}"

    # ABR 5284 = Cobra 4990: 6 claims.
    pub = date(2026, 9, 20)
    claims: dict[int, tuple[str | None, str | None]] = {}
    claims[ranked[0].pid] = (
        publish(ranked[0], "corp", pub),
        publish(ranked[0], "runner", pub, in_bulk=False),
    )
    mism = dict(ranked[1].corp_deck)
    k = sorted(c for c, q in mism.items() if q == 3 and cd.cards[c]["card_type_id"] != "agenda")[0]
    mism[k] = 2
    extra = sorted(
        c
        for c in cd.cards
        if cd.cards[c]["side_id"] == "corp"
        and cd.cards[c]["faction_id"] == "neutral_corp"
        and cd.in_pool(c)
        and cd.cards[c]["card_type_id"] == "operation"
        and c not in mism
        and c not in cd.banned(r4990)
    )[0]
    mism[extra] = 1
    used.add(extra)
    claims[ranked[1].pid] = (
        publish(ranked[1], "corp", pub, uuid=UUID_DECKLIST, deck=mism),
        publish(ranked[1], "runner", pub),
    )
    priv_body = {
        "id": 3111,
        "uuid": UUID_PRIVATE,
        "date_creation": "2026-09-18T09:00:00+00:00",
        "date_update": "2026-09-18T09:00:00+00:00",
        "name": canary("DECKNAME"),
        "description": canary("DESCRIPTION"),
        "mwl_code": None,
        "tags": "PII_CANARY_DESCRIPTION",
        "cards": {
            cd.latest_printing(ranked[2].corp_id): 1,
            **{cd.latest_printing(c): q for c, q in sorted(ranked[2].corp_deck.items())},
        },
    }
    add_route(
        f"{nrdb2}/deck/{UUID_PRIVATE}",
        jdump(v2_envelope([priv_body], date(2026, 9, 18))),
        headers={"Last-Modified": http_date(date(2026, 9, 18))},
    )
    claims[ranked[2].pid] = (
        f"https://netrunnerdb.com/en/deck/view/{UUID_PRIVATE}",
        "https://evil.example/en/decklist/12345/x",
    )
    claims[ranked[3].pid] = (publish(ranked[3], "corp", date(2026, 9, 21)), None)
    claims[ranked[6].pid] = (publish(ranked[6], "corp", pub), publish(ranked[6], "runner", pub))
    claims[ranked[9].pid] = (None, publish(ranked[9], "runner", pub))
    ent5284 = []
    for p in ranked:
        cu, ru = claims.get(p.pid, (None, None))
        ent5284.append(
            abr_entry(
                cd,
                p.swiss_rank,
                p.cut_rank if p.swiss_rank <= 4 else None,
                p.corp_id,
                p.runner_id,
                cu,
                ru,
                p.pid in claims,
            )
        )
    abr = "https://alwaysberunning.net/api"
    add_route(f"{abr}/entries?id=5284", jdump(ent5284))

    # ABR 5310 = Cobra 5012 (fallback link by date, size and identities): 3 claims, decks only on NRDB.
    r5012 = standings(p5012)
    ent5310 = []
    for i, p in enumerate(r5012):
        cu = publish(p, "corp", date(2026, 9, 13)) if i < 3 else None
        ru = publish(p, "runner", date(2026, 9, 13)) if i < 3 else None
        ent5310.append(abr_entry(cd, p.swiss_rank, 0, p.corp_id, p.runner_id, cu, ru, i < 3))
    add_route(f"{abr}/entries?id=5310", jdump(ent5310))

    # ABR-only events with claims (no match data): 5301 (HC, cut), 5250 megacity (previous ban list), 5240 store.
    def abr_only(eid: int, d: date, n: int, top: int, nclaims: int, pid0: int) -> list[Player]:
        ps = make_players(cd, rng, n, pid0, restriction_at(d), used)
        for p in ps:
            p.points = int(rng.random() * 15)
        ps = sorted(ps, key=lambda p: (-p.points, p.pid))
        for i, p in enumerate(ps, start=1):
            p.swiss_rank = i
        order = list(range(1, top + 1))
        rng.shuffle(order)
        for i, p in enumerate(ps[:top]):
            p.cut_rank = order[i]
        ents = []
        claimed = set(rng.sample(range(n), nclaims))
        for i, p in enumerate(ps):
            c = i in claimed
            cu = publish(p, "corp", d + timedelta(days=1)) if c else None
            ru = publish(p, "runner", d + timedelta(days=1)) if c else None
            ents.append(
                abr_entry(
                    cd,
                    p.swiss_rank,
                    p.cut_rank if top else 0,
                    p.corp_id if c else None,
                    p.runner_id if c else None,
                    cu,
                    ru,
                    c,
                )
            )
        add_route(f"{abr}/entries?id={eid}", jdump(ents))
        return ps

    abr_only(5301, date(2026, 9, 5), 10, 4, 7, 61000)
    abr_only(5250, date(2026, 6, 20), 20, 8, 16, 61100)
    abr_only(5240, date(2026, 7, 11), 12, 4, 9, 61200)

    # by_date responses for every day in the fixture window (most are empty)
    d = date(2026, 5, 1)
    unrelated = 0
    while d <= TODAY:
        items = by_date.get(d, [])
        if d == date(2026, 9, 20):
            # a decklist nobody claimed in a tournament
            unrelated += 1
            items = [
                *items,
                nrdb_v2_decklist(
                    cd,
                    97000 + unrelated,
                    f"00000000-0000-4000-8000-0000000970{unrelated:02d}",
                    d,
                    "haas_bioroid_precision_design",
                    p4990[0].corp_deck
                    if p4990[0].corp_id == "haas_bioroid_precision_design"
                    else ranked[0].corp_deck,
                ),
            ]
        add_route(
            f"{nrdb2}/decklists/by_date/{d.isoformat()}",
            jdump(v2_envelope(items, d if items else None)),
            headers={"Last-Modified": http_date(d)} if items else {},
        )
        d += timedelta(days=1)

    # --- ABR tournament lists
    w = p4990 and ranked[0]
    ev = {
        5284: abr_event(
            5284,
            d4990,
            type_id=5,
            players=16,
            top=4,
            claims=6,
            matchdata=True,
            winner=(
                cd.latest_printing([p for p in p4990 if p.cut_rank == 1][0].corp_id),
                cd.latest_printing([p for p in p4990 if p.cut_rank == 1][0].runner_id),
            ),
            extra=True,
        ),
        5310: abr_event(5310, date(2026, 9, 12), type_id=2, players=8, top=0, claims=3, matchdata=True),
        5301: abr_event(5301, date(2026, 9, 5), type_id=1, players=10, top=4, claims=7, matchdata=False),
        5302: abr_event(
            5302, date(2026, 9, 6), type_id=1, players=12, top=4, claims=5, matchdata=False, approved=None
        ),
        5303: abr_event(
            5303, date(2026, 9, 6), type_id=2, players=14, top=4, claims=6, matchdata=False, conflict=True
        ),
        5304: abr_event(
            5304, date(2026, 9, 7), type_id=1, players=10, top=0, claims=4, matchdata=False, fmt="startup"
        ),
        5305: abr_event(5305, date(2026, 9, 8), type_id=1, players=12, top=0, claims=0, matchdata=False),
        5306: abr_event(5306, date(2026, 9, 9), type_id=1, players=6, top=0, claims=4, matchdata=False),
        5250: abr_event(
            5250,
            date(2026, 6, 20),
            type_id=17,
            players=20,
            top=8,
            claims=16,
            matchdata=False,
            country="Germany",
        ),
        5240: abr_event(
            5240,
            date(2026, 7, 11),
            type_id=2,
            players=12,
            top=4,
            claims=9,
            matchdata=False,
            country="United Kingdom",
        ),
    }
    del w
    recent = [ev[i] for i in (5284, 5310, 5301, 5303, 5304, 5305, 5306)]  # approved=1 filter drops 5302
    sweep = [ev[i] for i in (5240, 5250)]
    add_route(f"{abr}/tournaments?approved=1&concluded=1&desc=1&start=2026.07.29.", jdump(recent))
    add_route(
        f"{abr}/tournaments?approved=1&concluded=1&desc=1&end=2026.07.29.&start=2025.09.27.", jdump(sweep)
    )
    allv = sorted(ev.values(), key=lambda e: -e["id"])
    add_route(f"{abr}/tournaments/results?limit=200&offset=0", jdump(allv))
    add_route(f"{abr}/tournaments/results?limit=200&offset=200", jdump([]))
    # Unknown events requested by edge-case tests
    build_catalog(cd, used)

    (OUT / "routes.json").write_text(json.dumps(sorted(routes, key=lambda r: r["url"]), indent=1) + "\n")
    print(f"wrote {len(routes)} routes, {len(used)} cards used")


if __name__ == "__main__":
    main()
