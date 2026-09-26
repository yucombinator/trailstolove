#!/usr/bin/env python3
"""Match the 29 official Algonquin access points to coordinates.

For each official access point: find its water body by name (against ALL named
water in the OSM extract, including just outside the park), then snap to the
nearest mapped access point (waterway=access_point) within 3 km; if none, anchor
at the water centroid and mark it approximate. The spur edge always targets the
nearest water NODE of the routing graph.

Writes data/access_official_geo.csv.
"""
import csv
import json
import math
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
DATA = ROOT / "data"
RAW = ROOT / "raw"

ALIASES = {"magetawan": "magnetawan", "wendigoes": "wendigo"}


def hav(a1, o1, a2, o2):
    p = math.pi / 180
    x = (math.sin((a2 - a1) * p / 2) ** 2
         + math.cos(a1 * p) * math.cos(a2 * p) * math.sin((o2 - o1) * p / 2) ** 2)
    return 12742 * math.asin(math.sqrt(x))


def load_csv(name):
    with open(DATA / name, newline="") as f:
        return list(csv.DictReader(f))


def core_tokens(official_name):
    s = re.sub(r"\s*Access Point.*$", "", official_name, flags=re.I)
    s = re.sub(r"#\d+", "", s)
    s_nopar = re.sub(r"\([^)]*\)", " ", s)
    parts = [p.strip().lower() for p in re.split(r"[–\-/,]", s) if p.strip()]
    parts += [p.strip().lower() for p in re.split(r"[–\-/,]", s_nopar) if p.strip()]
    cores = []
    for p in parts:
        p = re.sub(r"\s+", " ", p).strip()
        if not p:
            continue
        variants = [p, re.sub(r"\s+(lake|river|creek)$", "", p).strip()]
        for v in variants:
            v = re.sub(r"\s+", " ", v).strip()
            if v and v not in cores:
                cores.append(v)
    return cores


def main():
    # named water centroids from the raw extract (park + surroundings)
    wgeo = {}
    for el in json.loads((RAW / "water_geom.json").read_text())["elements"]:
        t = el.get("tags", {})
        nm = t.get("name")
        if not nm:
            continue
        if el["type"] == "relation":
            pts = [p for m in el.get("members", []) if m.get("geometry")
                   for p in m["geometry"]]
        else:
            pts = el.get("geometry") or []
        if len(pts) < 4:
            continue
        la = sum(p["lat"] for p in pts) / len(pts)
        lo = sum(p["lon"] for p in pts) / len(pts)
        wgeo.setdefault(nm, {"name": nm, "lat": la, "lon": lo,
                             "kind": ("river" if t.get("waterway") == "riverbank"
                                      else {"pond": "pond", "reservoir": "reservoir"}.get(t.get("water", ""), "lake"))})

    # routing-graph water nodes (for the spur edge)
    graph_water = []
    for r in load_csv("water.csv"):
        graph_water.append({"id": int(r["id"]), "name": r["name"] or "",
                            "lat": float(r["lat"]), "lon": float(r["lon"])})

    els = json.loads((RAW / "access.json").read_text())["elements"]
    mapped = []
    for el in els:
        t = el.get("tags", {})
        if t.get("waterway") != "access_point":
            continue
        if el["type"] == "node":
            lat, lon, oid = el["lat"], el["lon"], el["id"]
        else:
            g = el.get("geometry") or []
            if not g:
                continue
            lat, lon, oid = g[0]["lat"], g[0]["lon"], el["id"]
        mapped.append({"osm_id": oid, "lat": lat, "lon": lon})

    # pin anchors: the physical boat ramp / rental / parking for each access point
    def el_point(el):
        if el["type"] == "node":
            return el["lat"], el["lon"]
        g = el.get("geometry") or []
        if not g:
            return None
        return (sum(p["lat"] for p in g) / len(g), sum(p["lon"] for p in g) / len(g))

    def named_slips():
        out = {}
        for el in els:
            t = el.get("tags", {})
            if t.get("leisure") != "slipway" or not t.get("name"):
                continue
            m = re.search(r"#\s*(\d+)", t["name"])
            if not m:
                continue
            pt = el_point(el)
            if pt:
                out.setdefault(int(m.group(1)), []).append(
                    {"osm_id": el["id"], "lat": pt[0], "lon": pt[1], "name": t["name"]})
        return {k: v[0] for k, v in out.items() if len(v) == 1}

    slips_by_num = named_slips()
    slips = []
    for el in els:
        t = el.get("tags", {})
        if t.get("leisure") != "slipway":
            continue
        pt = el_point(el)
        if pt:
            slips.append({"osm_id": el["id"], "lat": pt[0], "lon": pt[1], "name": t.get("name") or ""})

    rentals = []
    parkings = []
    amen = RAW / "amenities.json"
    if amen.exists():
        for el in json.loads(amen.read_text())["elements"]:
            t = el.get("tags", {})
            kind = ("boat_rental" if (t.get("amenity") == "boat_rental" or t.get("shop") == "boat_rental")
                    else "parking" if t.get("amenity") == "parking" else None)
            if not kind:
                continue
            pt = el_point(el)
            if pt:
                (rentals if kind == "boat_rental" else parkings).append(
                    {"osm_id": el["id"], "lat": pt[0], "lon": pt[1],
                     "name": t.get("name") or "", "kind": kind})

    def nearest(cands, lat, lon, max_m):
        best, best_d = None, max_m / 1000
        for c in cands:
            d = hav(lat, lon, c["lat"], c["lon"])
            if d <= best_d:
                best, best_d = c, d
        return best, round(best_d * 1000) if best else None

    rows = []
    for off in load_csv("access_official.csv"):
        cores = [ALIASES.get(c, c) for c in core_tokens(off["name"])]
        best_w, best_score = None, -1
        for nm, w in wgeo.items():
            wn = nm.lower()
            for c in cores:
                score = 0
                if wn == c:
                    score = len(c) + 6
                elif wn.startswith(c + " "):
                    score = len(c) + 3
                elif c in wn:
                    score = len(c)
                if score > best_score:
                    best_score, best_w = score, w
        if not best_w:
            print(f"[warn] no water match for '{off['name']}' — skipped")
            continue

        best_ap, best_d = None, 1e18
        for m in mapped:
            d = hav(best_w["lat"], best_w["lon"], m["lat"], m["lon"])
            if d < best_d:
                best_d, best_ap = d, m
        if best_ap and best_d <= 3000:
            lat, lon, match = best_ap["lat"], best_ap["lon"], "osm-access-point"
            ap_oid = best_ap["osm_id"]
            matched = f"nearest mapped access point ({round(best_d)} m from {best_w['name']})"
        else:
            lat, lon, match = best_w["lat"], best_w["lon"], "lake-centroid"
            ap_oid = ""
            matched = best_w["name"] + " (centroid — launch not mapped)"

        # pin: physical boat ramp > canoe/boat rental > parking.
        # NOTE: hav() returns kilometres here — all thresholds below use metres.
        num = int(off["num"])
        pin = {"kind": "", "osm_id": "", "name": "", "lat": lat, "lon": lon}
        named = slips_by_num.get(num)
        if named and hav(lat, lon, named["lat"], named["lon"]) * 1000 <= 25000:
            pin = {"kind": "boat ramp", "osm_id": named["osm_id"],
                   "name": named["name"], "lat": named["lat"], "lon": named["lon"]}
            matched += f" — pinned to boat ramp ({round(hav(lat, lon, named['lat'], named['lon']) * 1000)} m)"
        else:
            for cands, kind, max_m in ((slips, "boat ramp", 400),
                                       (rentals, "boat rental", 400),
                                       (parkings, "parking", 400)):
                c, d = nearest(cands, lat, lon, max_m)
                if c:
                    pin = {"kind": kind, "osm_id": c["osm_id"],
                           "name": c.get("name") or "", "lat": c["lat"], "lon": c["lon"]}
                    matched += f" — pinned to {kind} ({d} m)"
                    break

        # spur target: nearest routing-graph water node to the mapped launch;
        # only re-pick when the pin sits far from it (within-water ramps drift
        # the anchor to another part of the SAME water otherwise)
        tgt = min(graph_water, key=lambda q: hav(lat, lon, q["lat"], q["lon"]))
        if hav(pin["lat"], pin["lon"], tgt["lat"], tgt["lon"]) * 1000 > 300:
            near = min(graph_water, key=lambda q: hav(pin["lat"], pin["lon"], q["lat"], q["lon"]))
            if (hav(pin["lat"], pin["lon"], near["lat"], near["lon"])
                    < hav(pin["lat"], pin["lon"], tgt["lat"], tgt["lon"])):
                tgt = near
        rows.append({
            "num": off["num"], "name": off["name"], "lat": round(pin["lat"], 6),
            "lon": round(pin["lon"], 6), "water_id": tgt["id"],
            "water_name": tgt["name"], "osm_id": ap_oid, "match": match,
            "matched_name": matched,
        })

    with open(DATA / "access_official_geo.csv", "w", newline="") as f:
        w = csv.DictWriter(f, ["num", "name", "lat", "lon", "water_id",
                               "water_name", "osm_id", "match", "matched_name"])
        w.writeheader()
        w.writerows(rows)
    print(f"matched {len(rows)}/29 "
          f"({sum(1 for r in rows if r['match'] == 'osm-access-point')} snapped to mapped access points, "
          f"{sum(1 for r in rows if 'pinned' in r['matched_name'])} pinned to ramp/rental/parking)")


if __name__ == "__main__":
    main()
