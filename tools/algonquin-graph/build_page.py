#!/usr/bin/env python3
"""Generate index.html: full-park directions app over the Algonquin canoe graph.

Embeds a compact graph (nodes, edges with drawing geometry), simplified lake
polygons and reach polylines. Routing runs client-side (Dijkstra in router.js).
"""
import csv
import json
import math
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
RAW = ROOT / "raw"
DATA = ROOT / "data"

CENTER_ID = 2411726  # Canoe Lake
VIEW_ID = CENTER_ID


def load_csv(name):
    with open(DATA / name, newline="") as f:
        return list(csv.DictReader(f))


def hav(a1, o1, a2, o2):
    p = math.pi / 180
    x = (math.sin((a2 - a1) * p / 2) ** 2
         + math.cos(a1 * p) * math.cos(a2 * p) * math.sin((o2 - o1) * p / 2) ** 2)
    return 12742000 * math.asin(math.sqrt(x))


def simplify_ring(pts, step=3, max_pts=90):
    if len(pts) <= max_pts:
        return pts
    out = pts[::step]
    if out[-1] != pts[-1]:
        out.append(pts[-1])
    if len(out) > max_pts * 2:
        out = out[::2]
    return out


def r5(v):
    return round(v, 5)


def main():
    wgeo = {(e["type"], e["id"]): e for e in
            json.loads((RAW / "water_geom.json").read_text())["elements"]}

    def way_rings(el):
        if el["type"] == "way":
            g = el.get("geometry") or []
            if len(g) < 4:
                return []
            return [g if g[0] == g[-1] else g + [g[0]]]
        segs = [g for m in el.get("members", [])
                if m.get("type") == "way" and m.get("geometry")
                and m.get("role", "outer") in ("outer", "")
                for g in [m["geometry"]] if len(g) >= 2]
        used = [False] * len(segs)
        rings = []
        for i in range(len(segs)):
            if used[i]:
                continue
            used[i] = True
            chain = segs[i][:]
            cur = (round(chain[-1]["lat"], 6), round(chain[-1]["lon"], 6))
            while True:
                nxt = None
                for k, g in enumerate(segs):
                    if used[k]:
                        continue
                    s = (round(g[0]["lat"], 6), round(g[0]["lon"], 6))
                    e = (round(g[-1]["lat"], 6), round(g[-1]["lon"], 6))
                    if s == cur:
                        nxt = (k, False)
                        break
                    if e == cur:
                        nxt = (k, True)
                        break
                if not nxt:
                    break
                k, rev = nxt
                used[k] = True
                gg = segs[k][::-1] if rev else segs[k]
                chain.extend(gg[1:])
                cur = (round(chain[-1]["lat"], 6), round(chain[-1]["lon"], 6))
            if chain[0] != chain[-1]:
                chain.append(chain[0])
            if len(chain) >= 4:
                rings.append(chain)
        return rings

    # ---- nodes ----
    nodes = []
    water = {}
    for r in load_csv("water.csv"):
        wid = int(r["id"])
        name = r["name"] or None
        water[wid] = {"name": name, "kind": r["kind"], "lat": float(r["lat"]),
                      "lon": float(r["lon"]), "area": float(r["area_m2"])}
        nodes.append([wid, name, r["kind"], float(r["lat"]), float(r["lon"]), int(r["dm"])])

    # ---- edges: portages ----
    pgeo = {e["id"]: e.get("geometry") or [] for e in
            json.loads((RAW / "portages.json").read_text())["elements"]}
    obstacles = {}
    for r in load_csv("edge_obstacles.csv"):
        if r["edge_kind"] == "portage":
            obstacles.setdefault(int(r["edge_id"]), []).append(r["type"])

    # portage steepness: cumulative climb/descent along the trail (p0 -> p1)
    climbs = {}
    climbs_csv = DATA / "climbs.csv"
    if climbs_csv.exists():
        with open(climbs_csv, newline="") as f:
            for r in csv.DictReader(f):
                prof = [int(float(x)) for x in r["prof"].split(";")] if r.get("prof") else None
                climbs[int(r["osm_id"])] = (int(r["up"]), int(r["down"]), prof)
    def portage_gain(p):
        c = climbs.get(int(p["osm_id"]))
        if c is None:
            return (None, None, None)
        return c

    edges = []
    portage_geo = {}
    for p in load_csv("portages.csv"):
        oid = int(p["osm_id"])
        a, b = p["from_id"], p["to_id"]
        if a in ("", "None") or b in ("", "None"):
            continue
        a, b = int(a), int(b)
        if a == b:
            continue
        g = pgeo.get(oid) or []
        if len(g) < 2:
            continue
        line = [[r5(q["lon"]), r5(q["lat"])] for q in g]
        m = round(float(p["length_m"]))
        o = sorted(set(obstacles.get(oid, [])))
        el, ed, prof = portage_gain(p)   # cumulative up/down + sparkline, p0 (a end) -> p1 (b end)
        # orient geometry so g[0] sits on the s-side of each directed edge
        if a == int(p["from_id"]):
            g_fwd, g_rev = line, line[::-1]
        else:
            g_fwd, g_rev = line[::-1], line
        edges.append({"s": a, "d": b, "k": "portage", "id": oid, "m": m, "n": p["name"] or None,
                      "o": o, "g": g_fwd, "el": el, "ed": ed, "pf": prof})
        edges.append({"s": b, "d": a, "k": "portage", "id": oid, "m": m, "n": p["name"] or None,
                      "o": o, "g": g_rev, "el": ed, "ed": el, "pf": prof[::-1] if prof else None})
        portage_geo[oid] = line
    print(f"portage edges: {len(edges)}")

    # ---- reach lines (simplified) ----
    reach_ways = json.loads((DATA / "reach_lines.json").read_text())
    reaches = {}
    for rid_str, obj in reach_ways.items():
        rid = int(rid_str)
        lines = []
        for line in obj["lines"]:
            simp = line[::4]
            if simp[-1] != line[-1]:
                simp.append(line[-1])
            if len(simp) < 2:
                simp = [line[0], line[-1]]
            lines.append([[r5(lon), r5(lat)] for lon, lat in simp])
        lines = [line for line in lines if len(line) >= 2]
        if not lines:
            continue
        reaches[rid] = {"n": obj.get("name") or None, "lines": lines}
    print(f"reach lines: {len(reaches)}")

    # ---- edges: water links with touch-point geometry ----
    def ring_pts(oid):
        el = wgeo.get(("way", oid)) or wgeo.get(("relation", oid))
        if not el:
            return []
        pts = [p for r in way_rings(el) for p in r]
        # dedupe consecutive
        out = []
        for p in pts:
            if not out or (p["lat"], p["lon"]) != (out[-1]["lat"], out[-1]["lon"]):
                out.append(p)
        return out

    link_edges = []
    for r in load_csv("water_links.csv"):
        a, b = int(r["from_id"]), int(r["to_id"])
        if r["kind"] == "river":
            lake_id, reach_id = (a, b) if b < 0 else (b, a)
            wa = water.get(lake_id)
            rc = reaches.get(reach_id)
            if not wa or not rc:
                continue
            rpts = [(c[1], c[0]) for line in rc["lines"] for c in line]
            if not rpts:
                continue
            nearest = min(rpts, key=lambda q: hav(wa["lat"], wa["lon"], q[0], q[1]))
            shore = ring_pts(lake_id)
            if not shore:
                continue
            landing = min(shore, key=lambda q: hav(nearest[0], nearest[1],
                                                   q["lat"], q["lon"]))
            g = [[r5(landing["lon"]), r5(landing["lat"])],
                 [r5(nearest[1]), r5(nearest[0])]]
            m = round(hav(landing["lat"], landing["lon"], nearest[0], nearest[1]))
        else:
            wa, wb = water.get(a), water.get(b)
            if not wa or not wb:
                continue
            pa, pb = ring_pts(a), ring_pts(b)
            if not pa or not pb:
                continue
            va = min(pa, key=lambda q: hav(wb["lat"], wb["lon"], q["lat"], q["lon"]))
            vb = min(pb, key=lambda q: hav(va["lat"], va["lon"], q["lat"], q["lon"]))
            if (va["lat"], va["lon"]) == (vb["lat"], vb["lon"]):
                v = [r5(va["lon"]), r5(va["lat"])]
                g, m = [v, v], 0  # lakes share a vertex: anchor both ends there
            else:
                g = [[r5(va["lon"]), r5(va["lat"])], [r5(vb["lon"]), r5(vb["lat"])]]
                m = round(hav(va["lat"], va["lon"], vb["lat"], vb["lon"]))
        for s_node, d_node, g_oriented in ((a, b, g), (b, a, g[::-1])):
            link_edges.append({"s": s_node, "d": d_node, "k": r["kind"], "m": m,
                               "n": r["via"], "o": [], "g": g_oriented})
    edges.extend(link_edges)
    print(f"link edges: {len(link_edges)}")

    # ---- access nodes + edges ----
    official_geo = {r["num"]: r for r in load_csv("access_official_geo.csv")}
    official = []
    for r in load_csv("access_osm.csv"):
        aid = 1000000000000 + int(r["osm_id"])
        wid = int(r["water_id"])
        lat, lon = float(r["lat"]), float(r["lon"])
        wname = water.get(wid, {}).get("name")
        nm = r["name"] or (f"launch on {wname}" if wname else "launch point")
        # enrich with the official access-point identity when this OSM point IS one
        off = next((g for g in official_geo.values()
                    if g["osm_id"] and int(g["osm_id"]) == int(r["osm_id"])), None)
        if off:
            nm = f"Access Point #{off['num']}: {off['name'].replace(' Access Point', '')}"
            # pin at the physical boat ramp / rental / parking when known
            lat, lon = float(off["lat"]), float(off["lon"])
            official.append({"id": aid, "num": int(off["num"]), "name": nm,
                             "lat": lat, "lon": lon, "approx": False})
        nodes.append([aid, nm, "access", lat, lon])
        wa = water.get(wid)
        if not wa:
            continue
        shore = ring_pts(wid)
        if shore:
            landing = min(shore, key=lambda q: hav(lat, lon, q["lat"], q["lon"]))
            wpt = [r5(landing["lon"]), r5(landing["lat"])]
        else:
            wpt = [r5(wa["lon"]), r5(wa["lat"])]
        m = round(hav(lat, lon, wpt[1], wpt[0]))
        g = [[r5(lon), r5(lat)], wpt]
        edges.append({"s": aid, "d": wid, "k": "access", "m": m, "n": None,
                      "o": [], "g": g})
        edges.append({"s": wid, "d": aid, "k": "access", "m": m, "n": None,
                      "o": [], "g": g[::-1]})
    # official access points without a mapped OSM launch: anchor at their water body
    for num, off in official_geo.items():
        if any(o["num"] == int(num) for o in official):
            continue
        aid = 3000000000000 + int(num)
        lat, lon = float(off["lat"]), float(off["lon"])
        nm = f"Access Point #{off['num']}: {off['name'].replace(' Access Point', '')}"
        nodes.append([aid, nm, "access", lat, lon])
        wid = int(off["water_id"])
        wa = water.get(wid)
        if not wa:
            continue
        m = round(hav(lat, lon, wa["lat"], wa["lon"]))
        g = [[r5(lon), r5(lat)], [r5(wa["lon"]), r5(wa["lat"])]]
        edges.append({"s": aid, "d": wid, "k": "access", "m": m, "n": None,
                      "o": [], "g": g})
        edges.append({"s": wid, "d": aid, "k": "access", "m": m, "n": None,
                      "o": [], "g": g[::-1]})
        official.append({"id": aid, "num": int(num), "name": nm, "lat": lat,
                         "lon": lon, "approx": off["match"] != "osm-access-point"})
    official.sort(key=lambda o: o["num"])
    data_official = official
    print(f"access edges: {sum(1 for e in edges if e['k'] == 'access')} | official access points: {len(official)}")

    # ---- lake polygons (assembled + merged + simplified) ----
    feats = []
    for oid, w in water.items():
        if w["kind"] == "reach":
            continue
        el = wgeo.get(("way", oid)) or wgeo.get(("relation", oid))
        if not el:
            continue
        rings = way_rings(el)
        if not rings:
            continue
        feats.append({
            "type": "Feature",
            "geometry": {"type": "MultiPolygon", "coordinates": [
                [[ [r5(p["lon"]), r5(p["lat"])] for p in ring ]]
                for ring in rings]},
            "properties": {"name": w["name"], "kind": w["kind"],
                           "area_ha": round(w["area"] / 1e4, 1), "osm_id": oid},
        })
    # merge same-name touching
    used = [False] * len(feats)
    vsets = [{(round(p[1], 6), round(p[0], 6))
              for poly in f["geometry"]["coordinates"] for ring in poly for p in ring}
             for f in feats]
    merged = []
    for i, f in enumerate(feats):
        if used[i]:
            continue
        used[i] = True
        nm = f["properties"]["name"]
        grp = [i]
        if nm:
            changed = True
            while changed:
                changed = False
                for j in range(len(feats)):
                    if used[j] or feats[j]["properties"]["name"] != nm:
                        continue
                    if any(vsets[g] & vsets[j] for g in grp):
                        used[j] = True
                        grp.append(j)
                        changed = True
        props = dict(feats[grp[0]]["properties"])
        props["area_ha"] = round(sum(feats[g]["properties"]["area_ha"] for g in grp), 1)
        props["ids"] = sorted(int(feats[g]["properties"]["osm_id"]) for g in grp)
        merged.append({
            "type": "Feature",
            "geometry": {"type": "MultiPolygon", "coordinates": [
                [ring] for g in grp for poly in feats[g]["geometry"]["coordinates"]
                for ring in poly]},
            "properties": props,
        })
    for f in merged:
        polys = []
        for poly in f["geometry"]["coordinates"]:
            ring = poly[0]
            simp = simplify_ring(ring)
            polys.append([simp])
        f["geometry"]["coordinates"] = polys
    print(f"lake features: {len(merged)}")

    center = water[CENTER_ID]

    roads = json.loads((DATA / "roads.json").read_text()) if (DATA / "roads.json").exists() else None
    campsites = [[int(c["osm_id"]), c["name"] or None, c["ref"] or None,
                  float(c["lat"]), float(c["lon"]), int(c["water_id"])]
                 for c in load_csv("campsites.csv")] if (DATA / "campsites.csv").exists() else []

    data = {
        "center": [round(center["lat"], 6), round(center["lon"], 6)],
        "nodes": nodes,
        "edges": edges,
        "lakes": {"type": "FeatureCollection", "features": merged},
        "reaches": reaches,
        "official": data_official,
        "roads": roads,
        "campsites": campsites,
    }
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    (DATA / "router_data.json").write_text(payload)
    (ROOT / "router_data.json").write_text(payload)   # served next to index.html
    print(f"router_data.json: {len(payload) / 1e6:.1f} MB")

    template = (ROOT / "router_template.html").read_text()
    build = str(int(max((ROOT / "router.js").stat().st_mtime,
                        (ROOT / "router_data.json").stat().st_mtime)))
    html = template.replace("__DATA__", payload).replace("__BUILD__", build)
    (ROOT / "index.html").write_text(html)
    print(f"index.html: {(ROOT / 'index.html').stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
