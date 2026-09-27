#!/usr/bin/env python3
"""Fetch remaining road tiles in parallel (the sequential loop keeps hitting 504 retries)."""
import json
import pathlib
import subprocess
from concurrent.futures import ThreadPoolExecutor

RAW = pathlib.Path('/tmp/algonquin-graph/raw')
UA = 'algonquin-graph-builder/0.1'
MIRRORS = ['https://overpass-api.de/api/interpreter',
           'https://overpass.kumi.systems/api/interpreter']

lat0, lat1 = 45.141, 46.173
lon0, lon1 = -79.190, -77.468
step_lat, step_lon = 0.4, 0.5


def tiles():
    lat = lat0
    while lat < lat1:
        lon = lon0
        while lon < lon1:
            yield (lat, lon, min(lat + step_lat, lat1), min(lon + step_lon, lon1))
            lon += step_lon
        lat += step_lat


def fetch(idx, s, w, n, e):
    out = RAW / f'roads_t{idx:02d}.json'
    if out.exists() and json.loads(out.read_text()).get('elements'):
        return f't{idx:02d}: cached'
    q = (f'[out:json][timeout:600];(way["highway"]["ref"~"^60$"]({s:.4f},{w:.4f},{n:.4f},{e:.4f});'
         f'way["name"="Highway 60"]({s:.4f},{w:.4f},{n:.4f},{e:.4f}););out geom;')
    last = None
    for attempt in range(5):
        url = MIRRORS[attempt % 2]
        r = subprocess.run(['curl', '-s', '-A', UA, '--max-time', '300', '--data-urlencode',
                            f'data={q}', url], capture_output=True, text=True)
        try:
            obj = json.loads(r.stdout)
            # Overpass answers HTTP 200 with a remark and no elements on timeout.
            # The old check here was `elements and no remark or no 'runtime'`,
            # which `and`-before-`or` made accept those empty results and cache them.
            remark = (obj or {}).get('remark') or ''
            if 'runtime error' in remark or 'timed out' in remark:
                raise RuntimeError(remark)
            out.write_text(r.stdout)
            return f't{idx:02d}: OK {len(obj.get("elements", []))} elements'
        except Exception as exc:  # noqa: BLE001
            last = exc
    return f't{idx:02d}: FAILED ({last})'


jobs = list(enumerate(tiles()))
with ThreadPoolExecutor(4) as ex:
    for res in ex.map(lambda t: fetch(t[0], *t[1]), jobs):
        print(res, flush=True)
