#!/usr/bin/env python3
"""Parse raw Overpass JSON into graph CSVs under data/.

Outputs:
  water.csv           id,name,kind,lat,lon,area_m2,major  (water bodies + river reaches)
  portages.csv        osm_id,name,length_m,p0/p1 coords,from_id,to_id,snaps,tags
  water_links.csv     from_id,to_id,kind,length_m,via    (kind: river | channel)
  obstacles.csv       osm_id,type,name,lat,lon
  edge_obstacles.csv  edge_kind,edge_id,obstacle_id,type
  access_osm.csv      osm_id,name,kind,lat,lon,water_id
  access_official.csv num,name,slug,url
  conditions.csv      category,scope,note,source,as_of

Dependency-free geometry: haversine, ray-casting PIP, bbox-prefiltered distances.
"""
import csv
import json
import math
import os
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
RAW = pathlib.Path(os.environ.get("AG_RAW", ROOT / "raw"))
DATA = pathlib.Path(os.environ.get("AG_DATA", ROOT / "data"))
DATA.mkdir(parents=True, exist_ok=True)

MAX_SNAP = 250.0    # m — max portage endpoint snap
ADJ_MAX = 15.0      # m — lake-lake shoreline adjacency
REACH_ADJ = 30.0    # m — reach-lake touch
OBST_EDGE = 100.0   # m — obstacle near portage endpoint
OBST_REACH = 50.0   # m — obstacle on reach
MIN_REACH = 300.0   # m — min waterway length to keep as reach node
GRID = 0.05         # deg — spatial grid cell for park boundary points


def load(name):
    return json.loads((RAW / f"{name}.json").read_text())


def hav(a1, o1, a2, o2):
    p = math.pi / 180
    x = (math.sin((a2 - a1) * p / 2) ** 2
         + math.cos(a1 * p) * math.cos(a2 * p) * math.sin((o2 - o1) * p / 2) ** 2)
    return 12742000 * math.asin(math.sqrt(x))


def d_seg(plat, plon, lat_a, lon_a, lat_b, lon_b):
    m = math.cos(math.radians((plat + lat_a + lat_b) / 3))
    dx, dy = (lon_b - lon_a) * m, lat_b - lat_a
    wx, wy = (plon - lon_a) * m, plat - lat_a
    l2 = dx * dx + dy * dy
    if l2 == 0:
        return math.hypot(wx, wy) * 111320
    t = max(0.0, min(1.0, (wx * dx + wy * dy) / l2))
    return math.hypot(wx - t * dx, wy - t * dy) * 111320


def bbox_of(ring):
    la = [p["lat"] for p in ring]
    lo = [p["lon"] for p in ring]
    return min(la), min(lo), max(la), max(lo)


def in_ring(plat, plon, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        yi, xi = ring[i]["lat"], ring[i]["lon"]
        yj, xj = ring[j]["lat"], ring[j]["lon"]
        if (yi > plat) != (yj > plat):
            if plon < (xj - xi) * (plat - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def d_ring(plat, plon, ring, stop):
    best = 1e18
    j = len(ring) - 1
    for i in range(len(ring)):
        d = d_seg(plat, plon, ring[j]["lat"], ring[j]["lon"], ring[i]["lat"], ring[i]["lon"])
        if d < stop:
            return d
        if d < best:
            best = d
        j = i
    return best


def d_rings(r1, r2, stop):
    best = 1e18
    for p in r1:
        d = d_ring(p["lat"], p["lon"], r2, stop)
        if d < stop:
            return d
        if d < best:
            best = d
    for p in r2:
        d = d_ring(p["lat"], p["lon"], r1, stop)
        if d < stop:
            return d
        if d < best:
            best = d
    return best


def area_of(ring):
    lat0 = sum(p["lat"] for p in ring) / len(ring)
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110540
    s = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]["lon"] * kx, ring[i]["lat"] * ky
        x2, y2 = ring[(i + 1) % n]["lon"] * kx, ring[(i + 1) % n]["lat"] * ky
        s += x1 * y2 - x2 * y1
    return abs(s) / 2


def centroid_of(ring):
    lat0 = sum(p["lat"] for p in ring) / len(ring)
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110540
    a = cx = cy = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]["lon"] * kx, ring[i]["lat"] * ky
        x2, y2 = ring[(i + 1) % n]["lon"] * kx, ring[(i + 1) % n]["lat"] * ky
        f = x1 * y2 - x2 * y1
        a += f
        cx += (x1 + x2) * f
        cy += (y1 + y2) * f
    if a == 0:
        return lat0, sum(p["lon"] for p in ring) / len(ring)
    return cy / (3 * a) / ky, cx / (3 * a) / kx


class UF:
    def __init__(self):
        self.p = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb


def main():
    # ---------- 1) water polygons ----------
    lakes = {}
    for el in load("water_geom")["elements"]:
        tags = el.get("tags", {})
        if el["type"] == "way":
            g = el.get("geometry") or []
            if len(g) < 4:
                continue
            rings = [g]
        elif el["type"] == "relation":
            rings = [m["geometry"] for m in el.get("members", [])
                     if m.get("type") == "way" and m.get("geometry")
                     and m.get("role", "outer") in ("outer", "")]
            if not rings:
                continue
        else:
            continue
        rings = [r if r[0] == r[-1] else r + [r[0]] for r in rings]
        area = sum(area_of(r) for r in rings)
        boxes = [bbox_of(r) for r in rings]
        lat, lon = centroid_of(max(rings, key=len))
        kind = ("river" if tags.get("waterway") == "riverbank" else
                {"pond": "pond", "reservoir": "reservoir", "canal": "canal",
                 "oxbow": "pond", "wastewater": "pond"}.get(tags.get("water", ""), "lake"))
        lakes[int(el["id"])] = {
            "name": tags.get("name"), "kind": kind, "rings": rings, "area": area,
            "bbox": (min(b[0] for b in boxes), min(b[1] for b in boxes),
                     max(b[2] for b in boxes), max(b[3] for b in boxes)),
            "lat": lat, "lon": lon,
        }

    # ---------- 0) park-boundary filter ----------
    pb = load("park_boundary")["elements"]
    park_rel = next(e for e in pb if e["type"] == "relation")
    park_rings = [m["geometry"] for m in park_rel.get("members", [])
                  if m.get("type") == "way" and m.get("geometry")]
    park_bboxes = [bbox_of(r) for r in park_rings]

    park_grid = {}
    for p in (q for r in park_rings for q in r):
        park_grid.setdefault((int(p["lat"] // GRID), int(p["lon"] // GRID)), []).append(p)

    def near_boundary(lat, lon, tol):
        padg = tol / 111320.0
        k = (int(lat // GRID), int(lon // GRID))
        rr = int(math.ceil(padg / GRID)) + 1
        for di in range(-rr, rr + 1):
            for dj in range(-rr, rr + 1):
                for p in park_grid.get((k[0] + di, k[1] + dj), ()):
                    if hav(lat, lon, p["lat"], p["lon"]) <= tol:
                        return True
        return False

    def inside_park(lat, lon, tol=0.0):
        padg = tol / 111320.0
        for r, bb in zip(park_rings, park_bboxes):
            if bb[0] - padg <= lat <= bb[2] + padg and bb[1] - padg <= lon <= bb[3] + padg:
                if in_ring(lat, lon, r):
                    return True
        return tol > 0 and near_boundary(lat, lon, tol)

    kept = {}
    for oid, lk in lakes.items():
        if inside_park(lk["lat"], lk["lon"], 0.0) or \
           any(inside_park(p["lat"], p["lon"], 0.0) for r in lk["rings"] for p in r):
            kept[oid] = lk
    lakes = kept
    lake_items = list(lakes.items())
    print(f"[park] water polygons inside park: {len(lakes)}", flush=True)

    # ---------- 2) waterways -> reaches ----------
    ww = load("waterways")["elements"]
    node_pos = {e["id"]: (e["lat"], e["lon"]) for e in ww if e["type"] == "node"}
    ways = {e["id"]: e for e in ww if e["type"] == "way" and e.get("nodes")}
    uf = UF()
    for wid in ways:
        uf.find(wid)
    for wid, w in ways.items():
        for nid in w["nodes"]:
            key = ("n", nid)
            if key in uf.p:
                uf.union(wid, uf.find(key))
            else:
                uf.p[key] = key
                uf.union(wid, key)
    comps = {}
    for wid in ways:
        comps.setdefault(uf.find(wid), []).append(wid)

    reaches = []
    reach_ways = {}  # reach_id -> {"name", "lines": [[[lon, lat], ...], ...]}
    for root, wids in comps.items():
        length, pts, name_count = 0.0, [], {}
        seen_pairs = set()
        wlines = []
        for wid in wids:
            w = ways[wid]
            nm = w.get("tags", {}).get("name")
            if nm:
                name_count[nm] = name_count.get(nm, 0) + 1
            coords = [node_pos[n] for n in w["nodes"] if n in node_pos]
            wlines.append([[lo, la] for (la, lo) in coords])
            for a, b in zip(coords, coords[1:]):
                key = tuple(sorted((a, b)))
                if key in seen_pairs:
                    continue
                seen_pairs.add(key)
                length += hav(a[0], a[1], b[0], b[1])
            pts.extend(coords)
        if length < MIN_REACH or not pts:
            continue
        longest = max(wids, key=lambda wid: len(ways[wid]["nodes"]))
        c = [node_pos[n] for n in ways[longest]["nodes"] if n in node_pos]
        if not c:
            continue
        mid = c[len(c) // 2]
        name = max(name_count, key=name_count.get) if name_count else ""
        # sample points for proximity tests
        step = max(1, len(pts) // 400)
        if not any(inside_park(la, lo, 500.0) for (la, lo) in pts[::step]):
            continue
        rid = -len(reaches) - 1
        reach_ways[str(rid)] = {"name": name, "lines": wlines}
        reaches.append({
            "reach_id": rid, "name": name,
            "length_m": round(length, 1),
            "lat": round(mid[0], 6), "lon": round(mid[1], 6),
            "pts": pts[::step],
        })

    # reach-point grid for resolve()'s fallback
    rg = {}
    for r in reaches:
        for (la, lo) in r["pts"]:
            rg.setdefault((int(la // GRID), int(lo // GRID)), []).append((la, lo, r["reach_id"]))

    def resolve(lat, lon, max_m=MAX_SNAP):
        pad = max_m / 111320.0
        best_d, bid = 1e18, None
        for oid, lk in lake_items:
            b = lk["bbox"]
            if not (b[0] - pad <= lat <= b[2] + pad and b[1] - pad <= lon <= b[3] + pad):
                continue
            for r in lk["rings"]:
                if in_ring(lat, lon, r):
                    return int(oid), 0.0
            d = min(d_ring(lat, lon, r, max_m) for r in lk["rings"])
            if d < best_d and d < max_m:
                best_d, bid = d, oid
        if bid is not None:
            return bid, best_d
        # fallback: nearest stitched waterway reach point
        padg = max_m / 111320.0
        k = (int(lat // GRID), int(lon // GRID))
        rr = int(math.ceil(padg / GRID)) + 1
        best_r, best_rid = 1e18, None
        for di in range(-rr, rr + 1):
            for dj in range(-rr, rr + 1):
                for la, lo, rid in rg.get((k[0] + di, k[1] + dj), ()):
                    d = hav(lat, lon, la, lo)
                    if d < best_r:
                        best_r, best_rid = d, rid
        if best_rid is not None and best_r <= max_m:
            return best_rid, best_r
        return None, None

    # ---------- 3) portages ----------
    portages = []
    for el in load("portages")["elements"]:
        if el["type"] != "way":
            continue
        g = el.get("geometry") or []
        if len(g) < 2:
            continue
        length = sum(hav(g[i]["lat"], g[i]["lon"], g[i + 1]["lat"], g[i + 1]["lon"])
                     for i in range(len(g) - 1))
        a_id, a_d = resolve(g[0]["lat"], g[0]["lon"])
        b_id, b_d = resolve(g[-1]["lat"], g[-1]["lon"])
        if not (inside_park(g[0]["lat"], g[0]["lon"], 500.0)
                or inside_park(g[-1]["lat"], g[-1]["lon"], 500.0)):
            continue
        tags = {k: v for k, v in el.get("tags", {}).items() if k != "name"}
        portages.append({
            "osm_id": el["id"],
            "name": el.get("tags", {}).get("name") or "",
            "length_m": round(length, 1),
            "p0_lat": round(g[0]["lat"], 6), "p0_lon": round(g[0]["lon"], 6),
            "p1_lat": round(g[-1]["lat"], 6), "p1_lon": round(g[-1]["lon"], 6),
            "from_id": a_id, "to_id": b_id,
            "from_dist": a_d, "to_dist": b_d,
            "tags": json.dumps(tags) if tags else "",
        })

    # ---------- 4) reach-lake links ----------
    links = []
    for r in reaches:
        pad = REACH_ADJ / 111320.0
        rla = [p[0] for p in r["pts"]]
        rlo = [p[1] for p in r["pts"]]
        rb = (min(rla), min(rlo), max(rla), max(rlo))
        for oid, lk in lake_items:
            b = lk["bbox"]
            if b[0] - pad > rb[2] or b[2] + pad < rb[0] or b[1] - pad > rb[3] or b[3] + pad < rb[1]:
                continue
            d = 1e18
            for (la, lo) in r["pts"]:
                for ring in lk["rings"]:
                    dd = d_ring(la, lo, ring, REACH_ADJ)
                    if dd < d:
                        d = dd
                    if d == 0.0:
                        break
            if d <= REACH_ADJ:
                links.append({"from_id": int(oid), "to_id": r["reach_id"],
                              "kind": "river", "length_m": round(d, 1),
                              "via": r["name"] or "unnamed waterway"})

    # ---------- 4b) vertex sets ----------
    for lk in lakes.values():
        lk["vset"] = {(round(p["lat"], 6), round(p["lon"], 6))
                      for r in lk["rings"] for p in r}

    # ---------- 5) lake-lake shoreline adjacency ----------
    big = list(lake_items)
    pad = ADJ_MAX / 111320.0
    for i in range(len(big)):
        oid, lk = big[i]
        b1 = lk["bbox"]
        for j in range(i + 1, len(big)):
            oid2, lk2 = big[j]
            b2 = lk2["bbox"]
            if b2[0] > b1[2] + pad or b2[2] < b1[0] - pad or \
               b2[1] > b1[3] + pad or b2[3] < b1[1] - pad:
                continue
            d = 1e18
            if not (lk["vset"] & lk2["vset"]):
                for r1 in lk["rings"]:
                    for r2 in lk2["rings"]:
                        d = min(d, d_rings(r1, r2, ADJ_MAX))
                        if d == 0.0:
                            break
                if d > ADJ_MAX:
                    continue
            links.append({"from_id": int(oid), "to_id": int(oid2),
                          "kind": "channel", "length_m": 0.0,
                          "via": "shared shore"})

    # ---------- 6) obstacles ----------
    obstacles = []
    for el in load("obstacles")["elements"]:
        t = el.get("tags", {})
        typ = t.get("waterway") or t.get("man_made")
        if not typ:
            continue
        if el["type"] == "node":
            lat, lon = el["lat"], el["lon"]
        else:
            g = el.get("geometry") or []
            if not g:
                continue
            lat, lon = g[len(g) // 2]["lat"], g[len(g) // 2]["lon"]
        if not inside_park(lat, lon, 500.0):
            continue
        obstacles.append({"osm_id": el["id"], "type": typ,
                          "name": t.get("name") or "",
                          "lat": lat, "lon": lon})

    # ---------- 7) access points (OSM) ----------
    access = []
    for el in load("access")["elements"]:
        t = el.get("tags", {})
        if t.get("waterway") == "access_point":
            pass  # official canoe access points — keep even when canoe=designated
        elif t.get("waterway"):
            continue  # waterway=link/flowline canoe-route connectors, not launches
        elif t.get("canoe") in ("link", "flowline", "river", "stream", "permit",
                                "designated", "no", "waterfall"):
            continue  # canoe-route member ways, not access points
        if el["type"] == "node":
            lat, lon = el["lat"], el["lon"]
        else:
            g = el.get("geometry") or []
            if not g:
                continue
            lat, lon = g[0]["lat"], g[0]["lon"]
        if not inside_park(lat, lon, 1000.0):
            continue
        wid, wd = resolve(lat, lon, 500.0)
        if wid is None:
            continue
        access.append({"osm_id": el["id"],
                       "name": t.get("name") or t.get("description") or "",
                       "kind": "launch", "lat": round(lat, 6), "lon": round(lon, 6),
                       "water_id": int(wid)})

    # ---------- 7b) obstacle -> edge proximity (id formula mirrors build_db.sql) ----------
    edge_obs = []
    for o in obstacles:
        for p in portages:
            if p["from_id"] is None or p["to_id"] is None:
                continue
            d0 = hav(o["lat"], o["lon"], p["p0_lat"], p["p0_lon"])
            d1 = hav(o["lat"], o["lon"], p["p1_lat"], p["p1_lon"])
            if min(d0, d1) <= OBST_EDGE:
                edge_obs.append({"edge_kind": "portage", "edge_id": p["osm_id"],
                                 "obstacle_id": o["osm_id"], "type": o["type"]})
        for r in reaches:
            hit = any(hav(o["lat"], o["lon"], la, lo) <= OBST_REACH for (la, lo) in r["pts"])
            if not hit:
                continue
            for ln in links:
                if ln["to_id"] != r["reach_id"]:
                    continue
                edge_obs.append({"edge_kind": "river",
                                 "edge_id": -(ln["from_id"] * 2000000000 + ln["to_id"]),
                                 "obstacle_id": o["osm_id"], "type": o["type"]})
                edge_obs.append({"edge_kind": "river",
                                 "edge_id": -(ln["to_id"] * 2000000000 + ln["from_id"]),
                                 "obstacle_id": o["osm_id"], "type": o["type"]})

    # ---------- write CSVs ----------
    (DATA / "reach_lines.json").write_text(json.dumps(reach_ways, ensure_ascii=False))
    with open(DATA / "water.csv", "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "name", "kind", "lat", "lon", "area_m2", "major", "dm"])
        for oid, lk in lakes.items():
            # crossing scale: bbox diagonal in metres (paddling-distance proxy)
            b = lk["bbox"]
            dm = round(hav(b[0], b[1], b[2], b[3]))
            w.writerow([oid, lk["name"] or "", lk["kind"],
                        round(lk["lat"], 6), round(lk["lon"], 6),
                        round(lk["area"]), 1 if lk["name"] else 0, dm])
        for r in reaches:
            w.writerow([r["reach_id"], r["name"], "reach",
                        r["lat"], r["lon"], 0, 0, round(r["length_m"] / 2)])

    # ---------- 7d) backcountry campsites ----------
    camps = []
    for el in load("campsites")["elements"]:
        t = el.get("tags", {})
        if el["type"] == "node":
            lat, lon = el["lat"], el["lon"]
        else:
            g = el.get("geometry") or []
            if not g:
                continue
            lat, lon = g[0]["lat"], g[0]["lon"]
        if not inside_park(lat, lon, 300.0):
            continue
        wid, _ = resolve(lat, lon, 250.0)
        if wid is None:
            continue
        camps.append({"osm_id": el["id"], "name": t.get("name") or "",
                      "ref": t.get("ref") or "", "lat": round(lat, 6),
                      "lon": round(lon, 6), "water_id": int(wid)})
    with open(DATA / "campsites.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, ["osm_id", "name", "ref", "lat", "lon", "water_id"])
        wr.writeheader()
        wr.writerows(camps)
    print(f"campsites: {len(camps)}", flush=True)


    with open(DATA / "portages.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, ["osm_id", "name", "length_m", "p0_lat", "p0_lon",
                                "p1_lat", "p1_lon", "from_id", "to_id",
                                "from_dist", "to_dist", "tags"])
        wr.writeheader()
        wr.writerows(portages)

    with open(DATA / "water_links.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, ["from_id", "to_id", "kind", "length_m", "via"])
        wr.writeheader()
        wr.writerows(links)

    with open(DATA / "edge_obstacles.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, ["edge_kind", "edge_id", "obstacle_id", "type"])
        wr.writeheader()
        wr.writerows(edge_obs)

    with open(DATA / "obstacles.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, ["osm_id", "type", "name", "lat", "lon"])
        wr.writeheader()
        wr.writerows(obstacles)

    with open(DATA / "access_osm.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, ["osm_id", "name", "kind", "lat", "lon", "water_id"])
        wr.writeheader()
        wr.writerows(access)

    # ---------- 7c) Highway 60 corridor (map context) ----------
    r_uf, r_ways = UF(), {}
    for el in load("roads")["elements"]:
        if el["type"] != "way" or not el.get("nodes"):
            continue
        g = el.get("geometry") or []
        if len(g) < 2:
            continue
        if not any(inside_park(q["lat"], q["lon"], 500.0)
                   for q in g[::max(1, len(g) // 20)]):
            continue
        r_ways[el["id"]] = el
        r_uf.find(el["id"])
        for nid in el["nodes"]:
            key = ("n", nid)
            if key in r_uf.p:
                r_uf.union(el["id"], r_uf.find(key))
            else:
                r_uf.p[key] = key
                r_uf.union(el["id"], key)
    r_comps = {}
    for wid, el in r_ways.items():
        r_comps.setdefault(r_uf.find(wid), []).append(el)
    hw60 = []
    for root, els in r_comps.items():
        # chain member ways into continuous lines by node id
        segs = {el["id"]: [(q["lon"], q["lat"]) for q in el["geometry"]] for el in els}
        used = set()
        for wid2 in list(segs):
            if wid2 in used:
                continue
            line = list(segs[wid2])
            used.add(wid2)
            changed = True
            while changed:
                changed = False
                for wid3 in segs:
                    if wid3 in used:
                        continue
                    s = segs[wid3]
                    if s[0] == line[-1]:
                        line.extend(s[1:]); used.add(wid3); changed = True
                    elif s[-1] == line[-1]:
                        line.extend(s[::-1][1:]); used.add(wid3); changed = True
                    elif s[-1] == line[0]:
                        line[:] = s[:-1] + line; used.add(wid3); changed = True
                    elif s[0] == line[0]:
                        line[:] = s[::-1][:-1] + line; used.add(wid3); changed = True
            simp = line[::4]
            if simp[-1] != line[-1]:
                simp.append(line[-1])
            hw60.append([list(q) for q in simp])
    with open(DATA / "roads.json", "w") as f:
        json.dump({"name": "Ontario Highway 60", "lines": hw60}, f,
                  ensure_ascii=False, separators=(",", ":"))
    print(f"hwy 60: {len(hw60)} line(s) from {len(r_ways)} ways", flush=True)

    # ---------- 8) official access points from the 29 harvested pages ----------
    import re
    off_rows = []
    for p in sorted((RAW / "ap_pages").glob("*.html")):
        html = p.read_text(errors="ignore")
        title = re.search(r"<title>([^<]+)</title>", html)
        title = title.group(1) if title else p.stem
        num = re.search(r"#(\d+)", title)
        nm = re.search(r"^(.*?)\s*(?:\(#\d+\))?\s*\|", title)
        off_rows.append({
            "num": num.group(1) if num else "",
            "name": (nm.group(1).strip() if nm else p.stem),
            "slug": p.stem,
            "url": f"https://www.algonquinpark.on.ca/visit/camping/{p.stem}-access-point.php",
        })
    with open(DATA / "access_official.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, ["num", "name", "slug", "url"])
        wr.writeheader()
        wr.writerows(off_rows)

    # ---------- 9) conditions seed (official sources) ----------
    conds = [
        ("low-water", "Varley Lake",
         "Low water: Varley Lake from Carl Wilson Lake; may not be passable; seek alternate route.",
         "https://www.ontarioparks.ca/park/algonquin/alerts", "2026-09-25"),
        ("low-water", "Latour Creek",
         "Low water: Latour Creek north of Rosebary Lake (between P1370 and P845); near Tim River Access Point #2.",
         "https://www.ontarioparks.ca/park/algonquin/alerts", "2026-09-25"),
        ("low-water", "Carcajou Creek",
         "Low water: Carcajou Creek north toward Greenleaf Lake; near Grand Lake/Achray Access Point #22.",
         "https://www.ontarioparks.ca/park/algonquin/alerts", "2026-09-25"),
        ("low-water", "Craig Lake",
         "Low water reported at Craig Lake; may not be passable.",
         "https://www.ontarioparks.ca/park/algonquin/alerts", "2026-09-25"),
        ("low-water", "David Creek",
         "Low water: David Creek off Mubwayaka Lake.",
         "https://www.ontarioparks.ca/park/algonquin/alerts", "2026-09-25"),
        ("low-water", "Timberwolf Lake",
         "Low water: the creek between Timberwolf Lake and Misty Lake.",
         "https://www.ontarioparks.ca/park/algonquin/alerts", "2026-09-25"),
        ("closure", "Provoking Falls",
         "Provoking Falls bridge (Highland Backpacking Trail) CLOSED; bridge removed; re-route adds ~2.5 km.",
         "https://www.ontarioparks.ca/park/algonquin/alerts", "2026-09-25"),
        ("closure", "Highview Cabin",
         "Highview Ranger Cabin closed for the 2026 season for repairs.",
         "https://www.ontarioparks.ca/park/algonquin/alerts", "2026-09-25"),
        ("permit", "park-wide",
         "Interior (backcountry) camping requires an advance reservation and backcountry permit via Ontario Parks reservation service.",
         "https://reservations.ontarioparks.ca", "2026-09-24"),
        ("info", "park-wide",
         "Every portage is signed with a yellow sign listing the connecting water bodies and the portage length in metres.",
         "https://www.algonquinpark.on.ca/visit/camping/portages.php", "2026-09-24"),
        ("info", "park-wide",
         "29 official backcountry access points ring the park and the Highway 60 corridor.",
         "https://www.algonquinpark.on.ca/visit/camping/access-points-for-backcountry-canoeing.php", "2026-09-24"),
    ]
    with open(DATA / "conditions.csv", "w", newline="") as f:
        wr = csv.writer(f)
        wr.writerow(["category", "scope", "note", "source", "as_of"])
        wr.writerows(conds)

    n_res = sum(1 for p in portages if p["from_id"] is not None and p["to_id"] is not None
                and p["from_id"] != p["to_id"])
    print(f"water nodes: {len(lakes)} + {len(reaches)} reaches | "
          f"portages: {len(portages)} (fully resolved: {n_res}) | "
          f"links: {len(links)} | obstacles: {len(obstacles)} "
          f"(attached to edges: {len(edge_obs)}) | access: {len(access)}")


if __name__ == "__main__":
    main()
