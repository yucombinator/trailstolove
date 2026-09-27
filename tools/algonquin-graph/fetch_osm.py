#!/usr/bin/env python3
"""Fetch Algonquin Provincial Park canoe-route features from OpenStreetMap via Overpass.

No Overpass `area` filter is used (the park's area index entry is missing on current
mirrors, and area filters silently return empty sets). Instead: fetch the park boundary
geometry once, derive its bbox, tile the bbox, and merge per-feature-kind results,
deduplicating by OSM id.

Saves raw JSON snapshots under raw/ so parsing is reproducible without re-hitting the API.
"""
import json
import os
import pathlib
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
RAW = ROOT / "raw"
RAW.mkdir(exist_ok=True)

PARK_REL = 910784  # OSM relation "Algonquin Provincial Park", boundary=national_park
UA = "algonquin-graph-builder/0.1"
MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# CI runners share datacenter IPs that Overpass rate-limits; keep the run alive
# and let the cache converge across nights instead of aborting the job.
TOLERANT = os.environ.get("OVERPASS_TOLERANT", "1") != "0"
BACKOFF = int(os.environ.get("OVERPASS_BACKOFF", "30"))
MISSING: list[str] = []
# Overpass is one API, but the park is not uniform: 48 MB of lake polygons and
# 75 MB of waterway geometry change on a multi-year cadence, while campsites and
# access points churn season to season. Each group declares how old its snapshot
# may get; anything fresher than its budget is skipped outright. Fetch only what
# is stale, and the whole refresh drops from ~100 tiles to ~24 on a daily run.
# Ages in days. 0 = always fetch.
GROUP_MAX_AGE_DAYS = {
    "park_boundary": 365,   # boundary relations do not move
    "water_geom": 180,      # lake shorelines: multi-year
    "waterways": 180,       # river/stitch geometry: multi-year
    "portages": 45,         # re-routes and retagging happen
    "obstacles": 45,        # dams and weirs get built
    "access": 45,           # put-ins added occasionally
    "amenities": 90,        # parking/rental anchors for access pins
    "roads": 365,           # Hwy 60: decade-scale changes
    "campsites": 10,        # sites renumbered / reclassified / closed
}
FORCE = {g.strip() for g in os.environ.get("OVERPASS_FORCE", "").split(",") if g.strip()}
SKIPPED: list[str] = []


def snapshot_age_days(name: str):
    """Age of a group's merged snapshot in days, or None if it has never been built."""
    f = RAW / f"{name}.json"
    if not f.exists():
        return None
    return (time.time() - f.stat().st_mtime) / 86400.0


def group_due(name: str) -> bool:
    """False when the cached snapshot is younger than its policy allows."""
    if name in FORCE:
        return True
    budget = GROUP_MAX_AGE_DAYS.get(name, 0)
    if budget == 0:
        return True
    age = snapshot_age_days(name)
    if age is not None and age < budget:
        print(f"[fresh] {name}: snapshot is {age:.0f}d old (budget {budget}d) — skipping",
              flush=True)
        SKIPPED.append(name)
        return False
    return True


def run(name: str, query: str, tries: int = 6) -> dict:
    backoff = BACKOFF
    out = RAW / f"{name}.json"
    if out.exists():
        try:
            cached = json.loads(out.read_text())
            # trust any cached Overpass response: empty results are real results
            # (the runtime-timeout case never gets cached — the remark check rejects it)
            print(f"[resume] {name}: cached ({len(cached.get('elements', []))} elements)", flush=True)
            return cached
        except Exception:  # noqa: BLE001
            pass  # corrupt cache: refetch
    last = None
    for attempt in range(tries):
        url = MIRRORS[attempt % len(MIRRORS)]
        host = url.split("//")[1].split("/")[0]
        try:
            body = urllib.parse.urlencode({"data": query}).encode()
            req = urllib.request.Request(url, data=body, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=1800) as resp:
                payload = resp.read()
            obj = json.loads(payload)
            remark = (obj or {}).get("remark") or ""
            if "runtime error" in remark or "timed out" in remark:
                # Overpass returns HTTP 200 with an empty element list on timeout.
                raise RuntimeError(f"overpass remark: {remark}")
            out.write_bytes(payload)
            print(f"[ok] {name}: {len(obj.get('elements', []))} elements, "
                  f"{len(payload) / 1e6:.1f} MB", flush=True)
            return obj
        except Exception as exc:  # noqa: BLE001
            last = exc
            print(f"[warn] {name} attempt {attempt + 1} via {host}: {exc}", flush=True)
            time.sleep(backoff)
    if TOLERANT:
        # keep going: a missing tile is retried on the next run while the rest
        # of the graph still refreshes. CI converges tile-by-tile; locally the
        # same leniency keeps a rate-limited run from throwing away an hour.
        print(f"[warn] {name}: giving up after {tries} attempts ({last}) — keeping prior "
              f"state, will retry next run", flush=True)
        MISSING.append(name)
        if out.exists():
            try:
                return json.loads(out.read_text())
            except Exception:  # noqa: BLE001
                return {"elements": []}
        return {"elements": []}
    raise SystemExit(f"[fatal] {name}: {last}")


def main() -> None:
    # 1) Park boundary geometry (members carry inline geometry with `out geom`).
    b = run("park_boundary", f"[out:json][timeout:900];rel({PARK_REL});out geom;")
    rel = next(e for e in b["elements"] if e["type"] == "relation")
    rings = [m["geometry"] for m in rel.get("members", [])
             if m.get("type") == "way" and m.get("geometry")]
    pts = [p for r in rings for p in r]
    lat0, lat1 = min(p["lat"] for p in pts) - 0.02, max(p["lat"] for p in pts) + 0.02
    lon0, lon1 = min(p["lon"] for p in pts) - 0.03, max(p["lon"] for p in pts) + 0.03
    print(f"[park] bbox lat {lat0:.3f}..{lat1:.3f} lon {lon0:.3f}..{lon1:.3f}", flush=True)

    # tile size in degrees; Overpass chokes on a single park-wide geometry query
    TILE_LAT, TILE_LON = 0.4, 0.5

    def tiles():
        lat = lat0
        while lat < lat1:
            lon = lon0
            while lon < lon1:
                yield (lat, lon, min(lat + TILE_LAT, lat1), min(lon + TILE_LON, lon1))
                lon += TILE_LON
            lat += TILE_LAT

    def fetch_tiled(name: str, body: str) -> dict:
        if not group_due(name):
            try:
                return json.loads((RAW / f"{name}.json").read_text())
            except Exception:  # noqa: BLE001
                return {"elements": []}
        merged = {}
        for i, (s, w, n, e) in enumerate(tiles()):
            bbox = f"({s:.4f},{w:.4f},{n:.4f},{e:.4f})"
            q = (f"[out:json][timeout:600];({body.replace('{{bbox}}', bbox)});out geom;")
            out = RAW / f"{name}_t{i:02d}.json"
            cached = out.exists()
            els = run(f"{name}_t{i:02d}", q, 4).get("elements", [])
            for el in els:
                key = (el["type"], el["id"])
                cur = merged.get(key)
                if cur is None or len(ring_points(el)) > len(ring_points(cur)):
                    merged[key] = el
            print(f"  tile {i:02d}: +{len(els)} -> {len(merged)} merged", flush=True)
            if not cached:
                time.sleep(8)   # only pace real network hits
        (RAW / f"{name}.json").write_text(json.dumps({"elements": list(merged.values())}))
        print(f"[ok] {name}: {len(merged)} elements (tiled)", flush=True)
        return merged

    def ring_points(el: dict) -> list:
        out = list(el.get("geometry") or [])
        for m in el.get("members", []) or []:
            out.extend(m.get("geometry") or [])
        return out

    # 2) Lakes / ponds / riverbank polygons — the heavy one; tiled to dodge gateway timeouts.
    fetch_tiled("water_geom", 'way["natural"="water"]{{bbox}};relation["natural"="water"]{{bbox}};')

    # 3) Portage ways.
    fetch_tiled("portages", 'way["portage"]{{bbox}};way["canoe"="portage"]{{bbox}};')

    # 4) Obstacles: rapids, waterfalls, dams, weirs.
    fetch_tiled("obstacles",
                'nwr["waterway"~"^(rapids|waterfall|dam|weir)$"]{{bbox}};'
                'nwr["man_made"~"^(dam|weir)$"]{{bbox}};')

    # 5) Access points: canoe launches / slips / boat rentals.
    fetch_tiled("access",
                'nwr["canoe_access"]{{bbox}};nwr["canoe"]{{bbox}};'
                'nwr["leisure"="slipway"]{{bbox}};nwr["amenity"="boat_rental"]{{bbox}};')

    # 5c) Ramp/rental/parking anchors for official access point pins.
    fetch_tiled("amenities",
                'nwr["amenity"="parking"]{{bbox}};'
                'nwr["shop"="boat_rental"]{{bbox}};'
                'nwr["amenity"="boat_rental"]{{bbox}};')

    # 5d) Highway 60 — the park corridor road, for map context.
    fetch_tiled("roads",
                'way["highway"]["ref"~"^60$"]{{bbox}};'
                'way["name"="Highway 60"]{{bbox}};')

    # 5e) Backcountry campsites (site nodes/ways on lakes).
    fetch_tiled("campsites",
                'nwr["tourism"="camp_site"]{{bbox}};')

    # 6) Waterways for paddle links (tiled: ways + their child nodes).
    # Same age gate as the other groups: without it the per-tile cache in run()
    # pins waterways at whatever the first fetch returned, forever.
    if not group_due("waterways"):
        try:
            waterways = json.loads((RAW / "waterways.json").read_text())
        except Exception:  # noqa: BLE001
            waterways = {"elements": []}
        print(f"[ok] waterways: {len(waterways.get('elements', []))} elements (cached)", flush=True)
    else:
        merged = {}
        for i, (s, w, n, e) in enumerate(tiles()):
            bbox = f"({s:.4f},{w:.4f},{n:.4f},{e:.4f})"
            q = (f"[out:json][timeout:600];"
                 f'way["waterway"~"^(river|stream|canal)$"]{bbox};'
                 "out body;>;out skel qt;")
            tile = RAW / f"waterways_t{i:02d}.json"
            cached = tile.exists()
            els = run(f"waterways_t{i:02d}", q, 4).get("elements", [])
            for el in els:
                key = (el["type"], el["id"])
                merged.setdefault(key, el)
            print(f"  tile {i:02d}: +{len(els)} -> {len(merged)} merged", flush=True)
            if not cached:
                time.sleep(8)   # only pace real network hits
        (RAW / "waterways.json").write_text(json.dumps({"elements": list(merged.values())}))
        print(f"[ok] waterways: {len(merged)} elements (tiled)", flush=True)

    if SKIPPED:
        print(f"[skip] {len(SKIPPED)} group(s) within their age budget, not refetched: "
              f"{', '.join(sorted(set(SKIPPED)))}", flush=True)
    if FORCE:
        print(f"[force] forced refetch: {', '.join(sorted(FORCE))}", flush=True)
    if MISSING:
        print(f"[warn] {len(MISSING)} snapshot(s) unavailable this run: {', '.join(sorted(set(MISSING)))}", flush=True)
        print("[warn] they are retried on the next run; the cache converges tile by tile", flush=True)
    print("[done] all fetches complete", flush=True)


if __name__ == "__main__":
    main()
