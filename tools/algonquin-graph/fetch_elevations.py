#!/usr/bin/env python3
"""Sample portage trail profiles for cumulative climb/descent.

For every routed portage (has geometry + distinct endpoints), take up to 24
points along the trail (endpoints + even spacing), fetch elevations via
Open-Meteo (cached in data/elevations.csv), lightly smooth the profile and sum
positive/negative deltas. Writes data/climbs.csv: osm_id,up,down  (metres,
p0 -> p1 direction). The reverse direction swaps up/down.
"""
import csv
import json
import pathlib
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
DATA = ROOT / "data"
ELEV_CSV = DATA / "elevations.csv"
CLIMBS_CSV = DATA / "climbs.csv"
BATCH = 100
MAX_SAMPLES = 24


def key(lat, lon):
    """Canonical point key: ~11 m grid."""
    return (round(float(lat), 4), round(float(lon), 4))


def trail_points(pgeo):
    """Evenly spaced sample points along a portage trail geometry."""
    if len(pgeo) < 2:
        return []
    step = max(1, (len(pgeo) - 1) // (MAX_SAMPLES - 1))
    idxs = list(range(0, len(pgeo), step))
    if idxs[-1] != len(pgeo) - 1:
        idxs.append(len(pgeo) - 1)
    return [key(q["lat"], q["lon"]) for q in (pgeo[i] for i in idxs)]


def load_cache():
    cache = {}
    if ELEV_CSV.exists():
        with open(ELEV_CSV, newline="") as f:
            for r in csv.DictReader(f):
                cache[key(r["lat"], r["lon"])] = float(r["elev"])
    return cache


def fetch_batch(pts):
    # OpenTopoData / Copernicus DEM (90 m): 100 locations per call, 1 call/sec
    locs = "|".join(f"{p[0]:.5f},{p[1]:.5f}" for p in pts)
    url = ("https://api.opentopodata.org/v1/srtm90m?locations=" +
           urllib.parse.quote(locs, safe=",|") + "&interpolation=cubic")
    req = urllib.request.Request(url, headers={"User-Agent": "algonquin-graph-builder/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        obj = json.loads(resp.read())
    out = []
    for r in obj["results"]:
        e = r["elevation"]
        out.append(e if e is not None else 0.0)
    return out


def smooth(vals):
    """3-point moving average to shave DEM quantisation noise."""
    if len(vals) < 3:
        return vals
    out = [vals[0]]
    for i in range(1, len(vals) - 1):
        out.append((vals[i - 1] + vals[i] + vals[i + 1]) / 3)
    out.append(vals[-1])
    return out


def climb_down(elevs):
    up = down = 0.0
    for a, b in zip(elevs, elevs[1:]):
        d = b - a
        if d > 0:
            up += d
        else:
            down -= d
    return round(up), round(down)


def main():
    portages = list(csv.DictReader(open(DATA / "portages.csv", newline="")))
    pgeo = {e["id"]: e.get("geometry") or []
            for e in json.loads((ROOT / "raw" / "portages.json").read_text())["elements"]}
    cache = load_cache()

    # sample points per routed portage
    trails = {}
    need = set()
    for p in portages:
        oid = p["osm_id"]
        geo = pgeo.get(int(oid)) or []
        if len(geo) < 2 or p["from_id"] in ("", "None") or p["to_id"] in ("", "None"):
            continue
        pts = trail_points(geo)
        trails[oid] = pts
        need.update(q for q in pts if q not in cache)

    print(f"routed portages: {len(trails)} | profile points: {len(trails) and sum(len(v) for v in trails.values())} "
          f"(to fetch: {len(need)})", flush=True)

    missing = sorted(need)
    for i in range(0, len(missing), BATCH):
        batch = missing[i:i + BATCH]
        try:
            elevs = fetch_batch(batch)
        except Exception as exc:  # noqa: BLE001
            print(f"  batch {i // BATCH}: FAILED ({exc})", flush=True)
            time.sleep(60)
            continue
        for q, e in zip(batch, elevs):
            cache[q] = e
        print(f"  batch {i // BATCH}: +{len(batch)}", flush=True)
        time.sleep(1.2)

    # append newly fetched to the cache csv
    if missing:
        have = set()
        if ELEV_CSV.exists():
            with open(ELEV_CSV, newline="") as f:
                have = {(r["lat"], r["lon"]) for r in csv.DictReader(f)}
        new_rows = [(lat, lon, round(cache[(lat, lon)], 1)) for (lat, lon) in missing
                    if (lat, lon) in cache and (lat, lon) not in have]
        if new_rows:
            with open(ELEV_CSV, "a", newline="") as f:
                wr = csv.writer(f)
                if ELEV_CSV.stat().st_size == 0:
                    wr.writerow(["lat", "lon", "elev"])
                wr.writerows(new_rows)

    # climbs per portage (smoothed profile, p0 -> p1)
    rows = []
    for oid, pts in trails.items():
        elevs = [cache.get(q) for q in pts]
        if any(e is None for e in elevs):
            continue
        up, down = climb_down(smooth(elevs))
        rows.append((oid, up, down))

    with open(CLIMBS_CSV, "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["osm_id", "up", "down"])
        wr.writerows(rows)
    print(f"climbs written: {len(rows)} portages "
          f"(steepest: {max(rows, key=lambda r: r[1])[1]} m up)")


if __name__ == "__main__":
    main()
