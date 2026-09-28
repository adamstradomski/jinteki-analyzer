"""`market-research fixtures refresh`: manual, opt-in capture of one live tournament as fixtures.

The raw responses are parsed once with the same scrubber the pipeline uses (so drift shows up),
then every personal field in the raw payload is replaced with a PII_CANARY_* value before the
file is written. Output goes to a review directory; nothing here runs in CI.
"""

from __future__ import annotations

import html
import json
import re
from pathlib import Path
from typing import Any

from selectolax.parser import HTMLParser

from market_research.runner import Runtime
from market_research.scrub import IngestQuality
from market_research.sources import abr, cobra
from market_research.sources.common import iso_now

PII_KEYS = {
    "name", "pronouns", "user_id", "user_name", "user_import_name", "player_name", "title", "description",
    "additional_prizes_description", "contact", "organizer_contact", "event_link", "stream_url", "slug",
    "tournament_organizer", "nrdbUsername", "nrdbId", "creator_id", "creator_name", "location", "location_address",
    "location_store", "location_place_id", "location_lat", "location_lng", "location_state", "link_facebook",
    "url", "corp_deck_title", "runner_deck_title", "tags", "mwl",
}  # fmt: skip
DECK_URL_SLUG = re.compile(r"^(https://netrunnerdb\.com/[a-z]{2}/(?:decklist|deck/view)/[0-9a-f-]+)(/.*)?$")


class Anonymiser:
    def __init__(self) -> None:
        self.seen: dict[tuple[str, str], str] = {}

    def value(self, key: str, v: Any) -> Any:
        if v in (None, "", 0, False):
            return v
        kind = "NAME" if "name" in key else key.upper()
        k = (kind, str(v))
        if k not in self.seen:
            self.seen[k] = f"PII_CANARY_{kind}_{len(self.seen) + 1:02d}"
        return self.seen[k]

    def walk(self, o: Any) -> Any:
        if isinstance(o, dict):
            out = {}
            for k, v in o.items():
                if k in PII_KEYS and not isinstance(v, dict | list):
                    out[k] = self.value(k, v)
                elif k.endswith("_deck_url") and isinstance(v, str):
                    m = DECK_URL_SLUG.match(v)
                    out[k] = (m[1] + "/PII_CANARY_SLUG") if m else "https://PII_CANARY_LINK.example/"
                else:
                    out[k] = self.walk(v)
            return out
        if isinstance(o, list):
            return [self.walk(x) for x in o]
        return o


def refresh(
    rt: Runtime, out: Path, *, cobra: int | None = None, abr: int | None = None
) -> list[Path]:  # pragma: no cover
    http = rt.http(unlimited=True)
    q = IngestQuality()
    an = Anonymiser()
    written: list[Path] = []
    fetched = iso_now(rt.clock.now())
    base = out / (f"cobra-{cobra}" if cobra is not None else f"abr-{abr}")
    base.mkdir(parents=True, exist_ok=True)

    def save(name: str, obj: Any) -> None:
        p = base / name
        p.write_text(json.dumps(obj, indent=1, ensure_ascii=False) + "\n", "utf-8")
        written.append(p)

    try:
        if cobra is not None:
            r = http.get(cobra_mod.show_url(cobra), accept="application/vnd.api+json")
            show = r.json()
            meta = cobra_mod.parse_show(show, q, fetched)
            save("show.json", an.walk(show))
            r = http.get(cobra_mod.nrtm_url(cobra))
            nrtm = r.json()
            t = cobra_mod.parse_nrtm(nrtm, meta, q, fetched)
            save("nrtm.json", an.walk(nrtm))
            if "public" in (t.deck_visibility.swiss, t.deck_visibility.cut):
                for p in t.players:
                    r = http.get(cobra_mod.decks_url(cobra, p.pid), accept="text/html")
                    if r.status != 200:
                        continue
                    tree = HTMLParser(r.body.decode("utf-8", "replace"))
                    decks = {}
                    for side in ("corp", "runner"):
                        node = tree.css_first(f"input#{side}_deck")
                        raw = node.attributes.get("value") if node is not None else None
                        decks[side] = an.walk(json.loads(raw)) if raw else None
                    page = "".join(
                        f'<input id="{s}_deck" type="hidden" value="{html.escape(json.dumps(d), quote=True) if d else ""}">\n'
                        for s, d in decks.items()
                    )
                    path = base / f"view_decks-{p.pid}.html"
                    path.write_text(f"<!DOCTYPE html>\n<html><body>\n{page}</body></html>\n", "utf-8")
                    written.append(path)
        if abr is not None:
            r = http.get(abr_mod.entries_url(abr))
            entries = r.json()
            abr_mod.parse_entries(abr, entries, q)
            save("entries.json", an.walk(entries))
    finally:
        http.close()
    save("drift.json", q.to_json())
    return written


cobra_mod = cobra
abr_mod = abr
