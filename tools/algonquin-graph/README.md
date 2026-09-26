# Algonquin Canoe-Routes Graph Database

A graph database of Algonquin Provincial Park canoe routes: named lakes, portages,
river connections, access points, obstacles (rapids, waterfalls, dams, weirs), and
special conditions. Stored as a single DuckDB file, queryable with plain SQL.

Database: `algonquin.duckdb` (DuckDB v1.5.x, no extensions required)

## Contents

| Table / View | What it holds |
|---|---|
| `water` | Graph nodes: lakes, ponds, reservoirs, riverbank polygons + stitched river reaches. `id` = OSM way/relation id, or negative id for reaches. `major=1` marks named features. |
| `portages` | Mapped portage ways: OSM id, name (often carries the official signed length, e.g. `Canoe Lake to Joe Lake Portage (295m)`), geometric length in metres, endpoint coordinates, resolved endpoints (`from_id`, `to_id` → `water.id`), snap distances, full OSM tags as JSON. |
| `water_links` | Direct paddle connections: `channel` (lakes sharing shoreline / same water split across OSM ways, distance ≤ 15 m) and `river` (lake touching a stitched waterway reach, distance ≤ 30 m). |
| `obstacles` | Rapids, waterfalls, dams, weirs from OSM nodes/ways, filtered to the park. |
| `edge_obstacles` | Obstacle-to-edge attachments: within 100 m of a portage endpoint, or 50 m of a river reach (both directions of each link are flagged). |
| `edge_flags` / `route_edges` | Per-edge obstacle booleans (`has_rapids`, `has_waterfall`, `has_dam`) — `route_edges` is the uniform directed edge list for routing. |
| `access_osm` | Canoe launches mapped in OSM (`canoe=access_point`, `canoe_access=yes`, `leisure=slipway`, `amenity=boat_rental`), linked to the nearest water body. |
| `access_official` | All 29 official backcountry access points (number, name, source URL) harvested from algonquinpark.on.ca. 25 join to mapped lakes by name. |
| `conditions` | Special conditions: category (`low-water` / `closure` / `permit` / `info`), scope (water body name or `park-wide`), note, source URL, as-of date. Seeded from official Ontario Parks / Friends of Algonquin pages; extend freely. |
| `nodes` | Uniform node list for routing: `water` UNION access points (access ids offset by 1e12). |

Composite edge ids: portages use their OSM way id (positive); water links use
`-(from_id * 2000000000 + to_id)` (negative; overflow-safe for current OSM id ranges);
access edges use `2e12 + osm_id`. The same formula exists in `parse_osm.py` and
`build_db.sql` — keep them in sync.

## How it was generated

Everything comes from two sources: **OpenStreetMap** (the spatial backbone, ODbL
licensed) and **official Algonquin/Ontario Parks web pages** (access list, notices).
No portage difficulty ratings were invented — OSM does not carry them.

### 1. `fetch_osm.py` — Overpass API → `raw/*.json`

- Park boundary: OSM relation **910784** (`boundary=national_park`, name
  "Algonquin Provincial Park"), fetched once with `out geom` (member ways carry
  inline coordinates) and saved to `raw/park_boundary.json`.
- Feature categories, each fetched over the park's bbox split into ~0.4° × 0.5°
  tiles, merged and deduplicated by (type, id):
  - `water_geom` — `way`/`relation` with `natural=water`, `out geom` (13,112 elements)
  - `portages` — ways with `portage` or `canoe=portage` (1,070)
  - `obstacles` — `waterway`/`man_made` in (rapids, waterfall, dam, weir) (561)
  - `access` — `canoe`, `canoe_access`, `leisure=slipway`, `amenity=boat_rental` (5,123)
  - `amenities` — `amenity=parking`, `shop`/`amenity=boat_rental` (pin anchors)
  - `waterways` — `waterway` in (river, stream, canal), `out body` + child nodes (890,400)
- Overpass quirks this works around (they cost real debugging time):
  - The park's Overpass `area` index entry does not exist on current mirrors;
    area-filtered queries silently return empty sets. **No `area()` filter is used** —
    the park polygon is applied client-side instead.
  - This Overpass build rejects arithmetic inside `area()` (literal integer ids only).
  - Unions require a trailing `;` before the closing paren.
  - Runtime timeouts return HTTP 200 with an empty element list — the fetcher
    checks the `remark` field and retries.
- Cached tiles are resumed on re-run (`[resume] ... cached`) — re-running the
  fetch does not re-download anything unless a tile file is missing.
- Every query sets a custom `User-Agent`; default `curl`/`python-urllib` UAs get
  406/429 from the mirrors.

### 2. `parse_osm.py` — `raw/*.json` → `data/*.csv`

Dependency-free geometry (haversine in metres, ray-casting point-in-polygon,
bbox-prefiltered point/segment distances):

1. Build water polygons from ways and multipolygon relations (outer rings only).
2. Drop water polygons entirely outside the park (point-in-polygon against the
   boundary, or any ring vertex).
3. Stitch waterway ways into **reaches** (union-find over shared OSM node ids);
   keep reaches ≥ 300 m whose sampled points fall inside the park (tolerance 500 m).
4. Resolve portage endpoints: point-in-polygon against any water body, else nearest
   water body within 250 m, else nearest reach point within 250 m. Portages that
   still fail to resolve on an endpoint are kept in the table but excluded from routing.
5. Build paddle links: reach↔lake touches (≤ 30 m) and lake↔lake shoreline
   adjacency (≤ 15 m, shared-vertex fast path).
6. Attach obstacles to edges by proximity; official access-point pages parsed for
   access-point numbers; conditions seeded from official sources.

Latest run (2026-09-25): 7,036 water polygons in park, 3,204 reaches, 896 portages
(601 fully resolved + routed, 263 self-loops/endpoint-failures kept but excluded),
7,019 paddle links, 314 obstacles (5,227 edge attachments), 2,280 access points.

### 3. `build_db.sql` — `data/*.csv` → `algonquin.duckdb`

Creates the tables, the `hav()` haversine macro, and the derived views
(`nodes`, `graph_edges` — undirected source data duplicated in both directions —
`edge_flags`, `route_edges`), then prints sanity checks (dangling refs, self-loops,
attachment counts). The build shown in the sanity output: zero dangling water
references, zero edges with missing endpoints. `parse_osm.py` also exports
`data/reach_lines.json` — the authoritative reach polylines used by the map page.

### 3b. `build_page.py` + `router.js` — interactive directions page

`index.html` is a self-contained directions app (Leaflet from CDN, graph embedded
as JSON, ~12 MB):

- **Graph**: all water nodes, every routable edge with drawing geometry — portages
  carry their full trail geometry, river/channel links carry a short touch-point
  spur, access links connect launches to their lake.
- **Routing**: Dijkstra client-side (`router.js`), five cost models —
  *balanced* (default: portage metres + a 300 m-carry equivalent per water body
  crossed, so lake-zigzag routes lose to cleaner ones), fewest carries (pure
  carry count), least total carrying, *portages only* (ignores mapped river
  links — use this if you don't trust paddleable creeks), fewest steps — plus
  an "avoid flagged obstacles" toggle.
- **Endpoints**: type in the search boxes (any named water body, river reach or
  access point), or click a lake on the map and use the popup buttons.
- **Official access-point pins** sit at the physical launch infrastructure, not the
  mapped canoe put-in: the OSM slipway named for the access point (`... Access Point (#N)`)
  when present, else the nearest boat ramp / boat rental / parking within 400 m
  (`build_access_geo.py` — `access_official_geo.csv` carries the chosen pin coordinates).
- Route output: carries count, total carry metres, lakes crossed, step-by-step
  itinerary, and the route drawn with real portage trail geometry.
- Rebuild with `python3 build_page.py` (needs `router_data.json` inputs from parse).

### 4. Official data (no OSM)

- **Access points**: all 29 pages under
  `https://www.algonquinpark.on.ca/visit/camping/*-access-point.php`
  (numbers #1–#29, names) — saved HTML in `raw/ap_pages/`, parsed into
  `access_official`.
- **Conditions**: Ontario Parks alerts (`ontarioparks.ca/park/algonquin/alerts`),
  Friends of Algonquin advisories
  (`algonquinpark.on.ca/news/algonquin_park_advisories.php`), the portage-signage
  page, and the Ontario Parks reservation service. Rows carry `source` and `as_of`;
  treat low-water rows as stale after a few weeks — re-check the source and update.

## How to use

```bash
cd algonquin-graph

# rebuild from scratch (skips cached fetches if raw/ exists)
python3 fetch_osm.py
python3 parse_osm.py
duckdb algonquin.duckdb < build_db.sql

# explore
duckdb algonquin.duckdb < queries.sql
```

`queries.sql` includes: summary counts, largest lakes, portages around a lake,
obstacles and conditions near a lake, connectivity counts, and the routing demo.

Routing is a plain recursive CTE (fewest hops, tie-broken by cumulative portage
metres) — e.g. Canoe Lake → Lake Opeongo resolves in 13 hops / 3,816 m portaging.
Depth cap 18 covers cross-park routes; raise it for longer searches. For a loop,
run the three legs and concatenate (the CTE finds single-source shortest paths;
edge labels and lengths come from joining `graph_edges` on consecutive path nodes).

> Note: the `duckpgq` community extension installs on DuckDB 1.5.4 but its SQL/PGQ
> parser hook (`CREATE PROPERTY GRAPH`, `GRAPH_TABLE`, `SHORTEST_PATH`) does not
> parse in this build. The tables above work unchanged with `SHORTEST_PATH` once it
> catches up.

## Caveats

- **OSM completeness**: crowd-sourced. 295 of 896 mapped portage ways are excluded
  from routing (263 resolve to the same water body on both ends — overland carries
  between parts of one water system — and 32 have an endpoint nothing resolves to
  within 250 m). All 896 stay in `portages` for inspection. Some unmapped portages
  mean the graph may lack connections that exist on the ground.
- **No difficulty ratings**: portage effort/condition is not in OSM; use official
  maps and signage. Carrying distances are geometric path lengths, close to but not
  certified against official posted lengths (signed lengths appear in portage
  names where OSM has them).
- **River reaches are assumed paddleable end to end**: a reach link means the water
  ways physically touch the lake, not that you can legally or practically paddle the
  whole system. Obstacle flags are proximity-based (100 m of a portage landing,
  50 m of a reach), not a hydrological guarantee, and routing does not block on
  obstacles — filter with `NOT has_rapids` etc. if you want conservative routes.
- **Verify before you go**: cross-check with the official canoe-routes map
  (algonquinpark.on.ca) and current Ontario Parks alerts before reserving.
