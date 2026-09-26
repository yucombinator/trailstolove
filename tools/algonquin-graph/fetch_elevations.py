#!/usr/bin/env python3
"""Fetch elevations for every portage endpoint via Open-Meteo (Copernicus DEM).

Writes data/elevations.csv (lat,lon,elev). Cached: only points missing from the
cache are fetched. Batches of 100 coords per request, ~0.6 s apart.
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
BATCH = 100


def load_portage_points():
    pts = set()
    with open(DATA / "portages.csv", newline="") as f:
        for r in csv.DictReader(f):
            pts.add((r["p0_lat"], r["p0_lon"]))
            pts.add((r["p1_lat"], r["p1_lon"]))
    return sorted(pts)


def load_cache():
    cache = {}
    if ELEV_CSV.exists():
        with open(ELEV_CSV, newline="") as f:
            for r in csv.DictReader(f):
                cache[(r["lat"], r["lon"])] = r["elev"]
    return cache


def fetch_batch(pts):
    lats = ",".join(p[0] for p in pts)
    lons = ",".join(p[1] for p in pts)
    url = ("https://api.open-meteo.com/v1/elevation?" +
           urllib.parse.urlencode({"latitude": lats, "longitude": lons}))
    req = urllib.request.Request(url, headers={"User-Agent": "algonquin-graph-builder/0.1"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        obj = json.loads(resp.read())
    return obj["elevation"]


def main():
    pts = load_portage_points()
    cache = load_cache()
    missing = [p for p in pts if p not in cache]
    print(f"portage endpoint points: {len(pts)} (cached: {len(pts) - len(missing)}, to fetch: {len(missing)})")

    new_rows = []
    for i in range(0, len(missing), BATCH):
        batch = missing[i:i + BATCH]
        try:
            elevs = fetch_batch(batch)
        except Exception as exc:  # noqa: BLE001
            print(f"  batch {i // BATCH}: FAILED ({exc})", flush=True)
            time.sleep(30)
            continue
        for p, e in zip(batch, elevs):
            new_rows.append((p[0], p[1], round(e, 1)))
            cache[p] = round(e, 1)
        print(f"  batch {i // BATCH}: +{len(batch)} elevations", flush=True)
        time.sleep(3)

    if new_rows:
        with open(ELEV_CSV, "a", newline="") as f:
            wr = csv.writer(f)
            if not ELEV_CSV.exists() or ELEV_CSV.stat().st_size == 0:
                wr.writerow(["lat", "lon", "elev"])
            wr.writerows(new_rows)
    print(f"elevations cached: {len(cache)} / {len(pts)} points")


if __name__ == "__main__":
    main()
