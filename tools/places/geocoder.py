#!/usr/bin/env python3
"""Generate the coordinates behind the /map/ page.

Two outputs, one source of truth:
    data/places.csv    the file you hand-edit and spot-check
    data/places.json   derived, for Hugo — it refuses to load CSV from data/

Run once, by hand. The site never calls a geocoder at build time, so builds
stay deterministic and offline and a flaky API can never take the site down.

Usage:
    python3 tools/places/geocoder.py            # only fill in missing rows
    python3 tools/places/geocoder.py --force    # re-geocode everything
    python3 tools/places/geocoder.py --check    # validate, no network

Anchor priority per post:
  1. an explicit `trailhead:` in front matter — the only one you can be sure of
  2. the park named in `stats.where`

Geocoding is a guess and is checked as one: a result whose display name shares
no meaningful word with the query is rejected, because "Grand Tetons National
Park" once resolved to a mountain in New Caledonia. Anything ambiguous is
flagged for you rather than silently pinned in the wrong country.

Nominatim usage policy: one request at a time, honest User-Agent, run once.
"""
import argparse
import csv
import json
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
POSTS = ROOT / "content" / "posts"
# The CSV lives with the tool, not in data/: Hugo 0.150 tries to load every
# file in data/ and rejects CSV outright ("unexpected data type [][]string").
CSV_OUT = ROOT / "tools" / "places" / "places.csv"
JSON_OUT = ROOT / "data" / "places.json"
UA = "hikewithyu.com-places-map/1.0 (static site build; one-off script)"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
FIELDS = ["slug", "lat", "lng", "anchor", "place", "source", "note"]

# Queries that do not geocode on their own, or geocode to the wrong place.
OVERRIDES = {
    "2023-12-17-rainier-high-hut": (46.8523, -121.7603,
                                    "Mount Rainier NP - 'Mount Tahoma Trail System' is not a place"),
    "2023-07-16-teton-crest-trail": (43.7553, -110.8046,
                                    "Nominatim returned a New Caledonia peak for this"),
}
STOPWORDS = {"national", "park", "forest", "wilderness", "reserve", "recreation",
             "area", "system", "trail", "provincial", "state", "and", "the", "of"}


def front_matter(path):
    """Parse the leading YAML block, tolerating a blank first line."""
    text = path.read_text()
    start = text.find("---")
    if start < 0:
        return {}
    end = text.find("\n---", start + 3)
    if end < 0:
        return {}
    block = text[start + 3:end]
    data = {}
    for line in block.splitlines():
        m = re.match(r"^([A-Za-z_]+):\s*(.*)$", line)
        if m:
            data[m.group(1)] = m.group(2).strip().strip('"')
    m = re.search(r'^\s*where:\s*"?([^"\n]+?)"?\s*$', block, re.M)
    if m:
        data["where"] = m.group(1).strip()
    return data


def tidy_place(name):
    """Drop the region suffix: 'Olympic National Park, WA' -> 'Olympic NP'.

    Also keeps every field comma-free, which keeps the CSV readable in any
    spreadsheet and the derived JSON clean.
    """
    name = re.sub(r",\s*[^,]+$", "", name).strip()
    return name.replace(",", " ").strip()


def words(text):
    return {w for w in re.findall(r"[a-z]+", text.lower()) if w and w not in STOPWORDS}


def candidate_queries(where):
    """Progressively simpler forms of a place name.

    "John Muir Wilderness and Kings Canyon National Park" is two places; the
    first form that resolves wins, so split on and/+ and drop the designation
    suffix until something geocodes.
    """
    base = re.sub(r"\s*,\s*[A-Z]{2}$", "", where).strip()
    out = [base]
    for part in re.split(r"\s+and\s+|\s*\+\s*", base):
        if part.strip() and part.strip() != base:
            out.append(part.strip())
    for p in list(out):
        trimmed = re.sub(
            r"\s+(National Park|National Forest|Wilderness|Provincial Park|State Park"
            r"|Conservation Area|Reserve|Recreation Area|Trail System)\s*$", "", p,
            flags=re.I).strip()
        if trimmed:
            out.append(trimmed)
    seen, uniq = set(), []
    for q in out:
        if q and q.lower() not in seen:
            seen.add(q.lower())
            uniq.append(q)
    return uniq


def geocode(query):
    url = NOMINATIM + "?" + urllib.parse.urlencode(
        {"q": query, "format": "jsonv2", "limit": 1})
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        hits = json.loads(r.read())
    if not hits:
        return None
    h = hits[0]
    display = h.get("display_name", "")
    if words(query) and not (words(query) & words(display)):
        return {"mismatch": display}
    return {"lat": round(float(h["lat"]), 4), "lon": round(float(h["lon"]), 4),
            "display": display}


def load_existing():
    rows = {}
    if CSV_OUT.exists():
        with open(CSV_OUT, newline="") as f:
            for r in csv.DictReader(f):
                rows[r["slug"]] = r
    return rows


def blank_row(slug, anchor, place, source, note):
    return {"slug": slug, "lat": "", "lng": "", "anchor": anchor,
            "place": place, "source": source, "note": note}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-geocode existing rows")
    ap.add_argument("--check", action="store_true", help="validate only, no network")
    args = ap.parse_args()

    posts = sorted(p for p in POSTS.glob("*/index.md") if p.is_file())
    existing = load_existing()
    rows, problems, review = [], [], []

    for post in posts:
        slug = post.parent.name
        fm = front_matter(post)
        where = fm.get("where") or ""
        trailhead = fm.get("trailhead") or ""
        prev = existing.get(slug)
        if prev and prev.get("lat") and not args.force:
            rows.append(prev)
            continue

        target = trailhead or where
        anchor = "trailhead" if trailhead else "park"
        place = tidy_place(target) if target else ""

        if slug in OVERRIDES:
            lat, lng, note = OVERRIDES[slug]
            rows.append({"slug": slug, "lat": lat, "lng": lng, "anchor": anchor,
                         "place": place or target, "source": "override", "note": note})
            review.append(f"{slug}: override - {note}")
            print(f"  OVER {slug:38s} {lat:9.4f} {lng:10.4f}  {note}")
            continue

        if not target:
            problems.append(f"{slug}: no where/trailhead")
            rows.append(blank_row(slug, "", "", "MISSING", "no where"))
            print(f"  MISS {slug:38s} (no where)")
            continue

        got = None
        for q in candidate_queries(target):
            try:
                got = geocode(q)
            except Exception as exc:                       # noqa: BLE001
                print(f"  ! {q}: {exc}", file=sys.stderr)
                got = None
            if got and "mismatch" not in got:
                break
            if got and "mismatch" in got:
                review.append(f"{slug}: {q!r} matched {got['mismatch'][:60]!r} - rejected")
            got = None
            time.sleep(1.1)

        if got:
            rows.append({"slug": slug, "lat": got["lat"], "lng": got["lon"],
                         "anchor": anchor, "place": place, "source": "nominatim",
                         "note": ""})
            review.append(f"{slug}: {place} -> {got['display'][:70]}")
            print(f"  ok   {slug:38s} {got['lat']:9.4f} {got['lon']:10.4f}  {place}")
        else:
            rows.append(blank_row(slug, anchor, place, "UNRESOLVED", "needs manual pin"))
            problems.append(f"{slug}: could not geocode {target!r}")
            print(f"  MISS {slug:38s} {target}")
        time.sleep(1.1)

    if args.check:
        bad = [r["slug"] for r in rows if not r.get("lat")]
        for r in rows:
            if r.get("lat") and not (-90 <= float(r["lat"]) <= 90 and -180 <= float(r["lng"]) <= 180):
                bad.append(r["slug"])
        print(f"{len(rows)} posts, {len(rows) - len(bad)} pinned")
        if bad:
            print("unpinned or invalid:", *bad, sep="\n  ")
            return 1
        return 0

    CSV_OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(CSV_OUT, "w", newline="") as f:
        w = csv.DictWriter(f, FIELDS, extrasaction="ignore", lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    pins = [{"slug": r["slug"], "lat": float(r["lat"]), "lng": float(r["lng"]),
             "place": r["place"]} for r in rows if r.get("lat")]
    JSON_OUT.write_text(json.dumps(pins, indent=1, ensure_ascii=False) + "\n")
    print(f"\nwrote {CSV_OUT.name} ({len(rows)} posts) and {JSON_OUT.name} ({len(pins)} pins)")
    print(f"\n{len(review)} to spot-check:")
    for r in review:
        print(f"  ? {r}")
    if problems:
        print(f"\n{len(problems)} need a manual pin:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
