#!/usr/bin/env python3
"""Refresh the volatile, non-OSM data: park conditions and advisories.

The Overpass groups are near-static; this is what actually moves. Pulls the
Algonquin Park advisories page and the Ontario Parks alert feed, extracts the
bulleted conditions, and writes data/conditions.csv with a fetch timestamp so the
UI can show how stale it is. Cached: a page is only re-fetched once its age
budget expires, and the last good file is kept if a fetch fails.

Cheap on purpose: a few HTML pages, no API rate limits, safe to run hourly.
"""
import csv
import html
import pathlib
import re
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
DATA = ROOT / "data"
OUT = DATA / "conditions.csv"
RAW = DATA / "conditions_raw"
UA = "algonquin-graph-builder/0.1"

# hours before a page is considered stale
MAX_AGE_H = {"advisories": 24, "alerts": 24, "permits": 168, "portages": 720}

SOURCES = {
    "advisories": "https://www.algonquinpark.on.ca/news/algonquin_park_advisories.php",
    "alerts": "https://www.ontarioparks.ca/park/algonquin/alerts",
    "permits": "https://reservations.ontarioparks.ca",
    "portages": "https://www.algonquinpark.on.ca/visit/camping/portages.php",
}

# category, scope, note, source, as_of
SEED = [
    ("permit", "park-wide",
     "Interior (backcountry) camping requires an advance reservation and backcountry permit via Ontario Parks reservation service.",
     "https://reservations.ontarioparks.ca"),
    ("info", "park-wide",
     "29 official backcountry access points ring the park and the Highway 60 corridor.",
     "https://www.algonquinpark.on.ca/visit/camping/access-points-for-backcountry-canoeing.php"),
    ("info", "park-wide",
     "Every portage is signed with a yellow sign listing the connecting water bodies and the portage length in metres.",
     "https://www.algonquinpark.on.ca/visit/camping/portages.php"),
]

TAG_RE = re.compile(r"<[^>]+>")
SCRIPT_RE = re.compile(r"<(script|style)\b.*?</\1>", re.I | re.S)
WS_RE = re.compile(r"\s+")

# The advisories page is the one that actually carries trip-affecting text.
# Its body lives in #content_center under section headings (Closures, Boil
# Water Advisories, Low Water Levels); everything outside that block is nav and
# marketing and must never reach a user's safety briefing.
SECTION_CATS = [
    ("closure", r"closur|washout|bridge|remov|dam|sinkhole|closed"),
    ("boil-water", r"boil[- ]water"),
    ("low-water", r"low water|water level|low-water|impassable|shallows"),
    ("info", r"advisory|bulletin|be aware"),
]


def clean(s: str) -> str:
    s = SCRIPT_RE.sub(" ", s)
    s = TAG_RE.sub(" ", s)
    return WS_RE.sub(" ", html.unescape(s)).strip()


def advisory_sections(text: str):
    """(category, sentence) pairs from the advisories page content block."""
    m = re.search(r'<div id="content_center"[^>]*>(.*?)(?=<div id="content_right|</body>)',
                  text, re.I | re.S)
    body = m.group(1) if m else ""
    if not body:
        return []
    out, cat = [], "info"
    # walk the body, tracking the most recent section heading
    for tok in re.split(r"(<h[1-6][^>]*>.*?</h[1-6]>|<li[^>]*>.*?</li>|<p[^>]*>.*?</p>)",
                        body, re.I | re.S):
        t = clean(tok)
        if not t or len(t) > 400:
            continue
        if re.match(r"^(<h[1-6])", tok, re.I):
            for c, pat in SECTION_CATS:
                if re.search(pat, t, re.I):
                    cat = c
                    break
            continue
        if cat == "info" and not re.search(SECTION_CATS[-1][1], t, re.I):
            continue          # skip prose that is not under a real section
        # section lead-ins ("X are in effect at the following locations") are
        # headers, not advisories — the real entries are their list items
        if re.search(r"(are in effect at the following|following list of|"
                     r"are being reported at the following|current \w+ closures in)", t, re.I):
            continue
        if not t[0].isupper() and not t[0].isdigit():
            continue
        if any(junk in t for junk in ("Click the icon", "Support Your Park", "Make A Reservation",
                                      "Reserve your", "Home >", "Skip to main",
                                      "Geographic Locations", "None at this time")):
            continue
        if re.search(r"\b(Current as of|Follow the link)\b", t):
            continue
        if not re.search(r"[.!?)]$", t):
            t += "."
        if (cat, t) not in out:
            out.append((cat, t))
    return out


def page_age_hours(path: pathlib.Path):
    if not path.exists():
        return None
    return (time.time() - path.stat().st_mtime) / 3600.0


def fetch(url: str, dest: pathlib.Path) -> bool:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        dest.write_bytes(r.read())
    return True


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    pages = {}
    for key, url in SOURCES.items():
        dest = RAW / f"{key}.html"
        age = page_age_hours(dest)
        if age is not None and age < MAX_AGE_H.get(key, 24):
            print(f"[fresh] {key}: {age:.0f}h old (budget {MAX_AGE_H.get(key, 24)}h) — skipping")
        else:
            try:
                fetch(url, dest)
                print(f"[ok] {key}: {dest.stat().st_size // 1024} KB")
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] {key}: fetch failed ({exc})"
                      + ("" if dest.exists() else " — no cached copy"))
        if dest.exists():
            pages[key] = dest

    rows, seen = [], set()
    stamp = time.strftime("%Y-%m-%d")

    if "advisories" in pages:
        text = pages["advisories"].read_text(errors="ignore")
        for cat, line in advisory_sections(text):
            if (cat, line) in seen:
                continue
            seen.add((cat, line))
            rows.append((cat, "park-wide", line[:300], SOURCES["advisories"], stamp))
        if not any(r[0] == "closure" for r in rows):
            rows.append(("info", "park-wide",
                         "No closures listed on the park advisories page as of this fetch.",
                         SOURCES["advisories"], stamp))
            seen.add(("info", "No closures"))

    # keep the standing advisories that the pages do not restate
    for cat, scope, note, src in SEED:
        k = (cat, note[:60])
        if k not in seen:
            seen.add(k)
            rows.append((cat, scope, note, src, stamp))

    if not rows:
        print("[warn] nothing extracted — keeping previous conditions.csv")
        raise SystemExit(0)

    with open(OUT, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["category", "scope", "note", "source", "as_of"])
        wr.writerows(rows)
    n_live = sum(1 for r in rows if r[4] == stamp)
    print(f"conditions: {len(rows)} rows ({n_live} from live pages, "
          f"{len(rows) - n_live} standing) as of {stamp}")


if __name__ == "__main__":
    main()
