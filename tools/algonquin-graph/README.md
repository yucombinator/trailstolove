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
| `access_official` | All 29 official backcountry access points (number, name, slug, source URL) harvested from algonquinpark.on.ca. |
| `conditions` | Special conditions: category (`low-water` / `closure` / `boil-water` / `permit` / `info`), scope (water body name or `park-wide`), note, source URL, as-of date. Rebuilt wholesale by `fetch_conditions.py` from the official advisories page on each run — hand-edits do not survive. |
| `nodes` | Uniform node list for routing: `water` UNION access points (access ids offset by 1e12). |

Directed link ids are `-(from_id * 2000000000 + to_id)` (negative, overflow-safe
for current OSM id ranges) and are written by `parse_osm.py` and consumed by
`build_db.sql` — keep them in sync. The page build path does not use edge ids at
all; it re-derives the same composite in `build_page.py` to attach river
obstacles, and keys portage obstacles by OSM way id.

## The shipped app, and what you must not edit

The live planner is served from `content/algonquin/` as **three files that must
agree**:

```
content/algonquin/
  app.html          the page — a build product of router_template.html
  router.js         the router — source, hand-edited
  router_data.json  12.5 MB payload — a build product, never hand-edited
```

`app.html` is emitted verbatim by `layouts/_default/app.html` in the Hugo
site. `build_page.py` substitutes `__BUILD__` (a hash of `router.js` +
`router_data.json`) and nothing else, so the two files should be byte-identical
apart from that token.

Do not copy it by hand. `sync_build.py` does the whole chain, and is the only
supported way to get a template edit into the bundle:

```sh
python3 tools/algonquin-graph/sync_build.py /tmp/algonquin-graph
```

It copies `router_template.html` and `router.js` into the build directory, runs
`build_page.py` there, and writes `app.html`, `router_data.json` and
`router.js` into `content/algonquin/`.

**It takes a build directory because `raw/` is gitignored.** The OSM snapshots
only exist where someone has fetched them, so the build has to run there; the
sources come from git either way, which is what stops the two trees drifting.
Copying the template across by hand was a recurring source of "my change isn't
showing" — ten times, in the end.

**It refuses to publish less than is already live.** A build from a stale local
`raw/` can quietly ship less than the site is serving; the first run of this
script did exactly that, dropping the park outline because the local copy had no
`raw/park_boundary.json`. The hand-copy it replaces could not do that by
accident, so the replacement must not either. If the new payload loses the park
boundary, lakes, reaches, access points, edges or nodes, it stops and says
which, and publishes nothing.

**A bundle where `app.html` is newer than the `router.js` beside it fails in
the browser for every visitor** — `Router.x is not a function` is how that
looked the one time it shipped. `tests/test_api_contract.py` asserts every
`Router.*` the page calls is actually exported by the router it loads.

## Vocabulary

The UI says **portage**, never *carry*. Algonquin signage, maps and the park's
own material call it a portage; "carry" is only the generic English verb for
the act. So: *4 portages*, *Portage 2: 381 m*, *least total portaging*.

Internal identifiers still say carry in places — `res.carries`,
`Router.carryRating`, `Router.carryEffort` — because renaming the router's
API would churn the golden-route tests for no user-visible gain. The CSS
vocabulary was renamed (`--portage`, `.portage-badge`) since that was free. Match the UI's vocabulary in anything user-facing: markup,
meta tags, structured data, and comments that describe what the reader sees.

## The refresh jobs

`.github/workflows/` runs two jobs against this data. Both are in the repo root,
but they exist for this tool and their behaviour is deliberate.

**`refresh-advisories.yml`** (06:20 / 18:20 UTC) scrapes the current park
advisory page, checks the rows are actually fresh — the scraper deliberately
keeps the previous file when a scrape comes back empty, so a silently broken
scraper would otherwise look like success — and commits
`data/conditions.csv`. **This is the safety-relevant half of the product and it
is deliberately the small, fast, reliable one.** If the graph job is having a
bad day, the conditions a paddler needs must still update.

**`refresh-graph.yml`** (07:50 / 19:50 UTC, 90 minutes behind the advisories
job so the two never race each other to `git push`) fetches OSM, rebuilds the
payload, checks it, deploys it into `content/algonquin/`, and commits. A run in
flight is never cancelled — cancelling throws away the fetch.

Four things it learned the hard way, all load-bearing:

- **The fetch is bounded by wall clock** (`FETCH_DEADLINE_MINUTES`, 45). See
  the `fetch_osm.py` section above for why. The job timeout is 300 minutes,
  which is an hour over the chain's documented worst case — it used to be 150,
  which was *below* the documented runtime, so a run that behaved as described
  could never finish.
- **The OSM tile cache is saved immediately after the fetch**, not in the job's
  post step. `actions/cache` only saves when the whole job succeeds, so a
  failure anywhere after the fetch threw the whole thing away and left the next
  run cold — which is what made the fetch the step that overran its ceiling.
  `raw/` is ~290 MB and is not in git.
- **A snapshot is only as good as its tiles.** `group_due()` asks how old a
  merged snapshot is, and a snapshot that is newer than its budget but missing
  tiles is indistinguishable from a good one by age alone — it gets skipped
  forever, and no amount of re-running fixes it. The fetch checks tile
  completeness first and re-merges from cache when tiles are missing.
- **A payload smaller than the live one is held, not published.** The data on
  the site is still the best available, so the commit is skipped and the run
  still goes green. Failing there would mean one bad Overpass day could stop
  the refresh permanently. Missing payload *fields* still fail — that is a
  pipeline regression, not a network day.

The cron schedules have been observed running **hours late** (the 06:20 job
fired at 14:07). Treat them as "twice a day", not as clock times.

## How it was generated

Everything comes from four sources: **OpenStreetMap** (the spatial backbone,
ODbL licensed), **official Algonquin/Ontario Parks web pages** (access list,
notices), **OpenTopoData** (Copernicus SRTM 90 m elevations, used to derive
carry climb profiles) and **OpenTopoMap / CARTO** basemap tiles. Portage
difficulty is *not* in OSM — the ratings and steepness weighting shipped in the
app are derived from the DEM, so treat them as guidance rather than ground
truth.

### 1. `fetch_osm.py` — Overpass API → `raw/*.json`

- Park boundary: OSM relation **910784** (`boundary=national_park`, name
  "Algonquin Provincial Park"), fetched once with `out geom` (member ways carry
  inline coordinates) and saved to `raw/park_boundary.json`.
- Feature categories, each fetched over the park's bbox split into 0.4° × 0.5°
  tiles, merged and deduplicated by (type, id):
  - `water_geom` — `way`/`relation` with `natural=water`, `out geom`
  - `portages` — ways with `portage` or `canoe=portage`
  - `obstacles` — `waterway`/`man_made` in (rapids, waterfall, dam, weir)
  - `access` — `canoe`, `canoe_access`, `leisure=slipway`, `amenity=boat_rental`
  - `amenities` — `amenity=parking`, `shop`/`amenity=boat_rental` (pin anchors)
  - `roads` — `ref=60` / `name=Highway 60`, drawn as map context
  - `campsites` — `tourism=camp_site`, drawn as green dots
  - `waterways` — `waterway` in (river, stream, canal), `out body` + child nodes
- Each group declares how old its snapshot may get in `GROUP_MAX_AGE_DAYS`;
  anything fresher is skipped, and `OVERPASS_FORCE=water_geom,portages` overrides
  that. A daily run therefore drops from ~100 tile fetches to ~24.
- **The fetch has a wall clock.** `FETCH_DEADLINE_MINUTES` (default 45) bounds
  the whole thing. Overpass is one shared API with no service level: a query that
  normally answers in 20s can sit for the 600s the query itself allows, and a
  park-wide sync is ~100 of those. Without a bound the job runs until something
  kills it, and because a group is only written once all its tiles are done, the
  next run starts that group from the same place. On expiry the group is left
  alone and its *previous* snapshot is used — a partial merge is a smaller
  dataset, which is worse than a stale one. Tiles already fetched stay cached,
  so the next run only pays for the ones left. `[budget]` lines report it.
- **Groups are fetched in value order**, not file order: campsites, obstacles,
  access, portages, amenities, then the heavy multi-year-cadence groups
  (`waterways`, `water_geom`, `roads`). Running out of time costs the least
  valuable freshness first.
- Overpass quirks this works around (they cost real debugging time):
  - The park's Overpass `area` index entry does not exist on current mirrors;
    area-filtered queries silently return empty sets. **No `area()` filter is used** —
    the park polygon is applied client-side instead.
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
   access-point numbers. Conditions are *not* seeded here — `fetch_conditions.py`
   owns that file, and `parse_osm` only writes starter rows if it is missing.

Latest run: 7,036 water polygons in park, 3,204 reaches, 896 portages (864 with
both endpoints resolved, of which 263 are self-loops, leaving 601 routable),
7,019 paddle links, 314 obstacles (5,227 edge attachments), 1,501 access points.
The script prints this split itself on every run.

### 3. `build_db.sql` — `data/*.csv` → `algonquin.duckdb`

Creates the tables, the `hav()` haversine macro, and the derived views
(`nodes`, `graph_edges` — undirected source data duplicated in both directions —
`route_edges`; `edge_flags` and `edge_obstacles` are materialised tables), then
prints sanity checks (dangling refs, self-loops, attachment counts). The build
shown in the sanity output: zero dangling water references, zero edges with
missing endpoints. `parse_osm.py` also exports `data/reach_lines.json` — the
authoritative reach polylines used by the map page.

### 3b. `build_page.py` + `router.js` — interactive directions page

`index.html` is a small directions app (65 KB, Leaflet from CDN) that fetches
`router_data.json` (12.5 MB: the graph, lake polygons, reach lines, park
boundary and conditions) and `router.js` alongside itself. Serve all three from
one directory — `serve.py` does that with caching off, which the page needs so a
rebuilt graph is picked up on reload.

- **Graph**: all water nodes, every routable edge with drawing geometry — portages
  carry their full trail geometry, river/channel links carry a short touch-point
  spur, access links connect launches to their lake.
- **Routing**: Dijkstra client-side (`router.js`), four cost models —
  *balanced* (default: portage metres + a 300 m-carry equivalent per water body
  crossed, so lake-zigzag routes lose to cleaner ones), *fewest portages* (pure
  count), *least total portaging*, *easiest portages* (weights portage effort, so
  steep ones are avoided) — plus an "avoid flagged obstacles" toggle, which
  reads the `o` field on river links as well as portages, so rapids, waterfalls
  and dams actually reroute you.
- **Park boundary**: drawn as a faint dashed line beneath the water. The OSM
  relation hands back its ring as separate open ways, so `build_page.py` chains
  them end-to-end first; without that the ring has near-zero area.
- **Endpoints**: type in the search boxes (any named water body, river reach or
  access point), or click a lake on the map and use the popup buttons.
- **Official access-point pins** sit at the physical launch infrastructure, not the
  mapped canoe put-in: the OSM slipway named for the access point
  (`... Access Point (#N)`) when one exists anywhere in the park, else the nearest
  boat ramp / boat rental / parking within 400 m. A handful of pins therefore sit
  kilometres from the water, which is deliberate — it is where you park.
  (`build_access_geo.py` — `access_official_geo.csv` carries the chosen pin coordinates.)
- Route output: portage count, total portaging metres, lakes crossed,
  step-by-step itinerary, and the route drawn with real portage trail geometry.
- Rebuild with `python3 build_page.py`. It reads `data/*.csv` plus
  `data/{reach_lines,roads}.json` and `raw/{water_geom,portages,park_boundary}.json`,
  and writes both `router_data.json` and `index.html`.

### 4. Official data (no OSM)

- **Access points**: numbers #1–#29 and names taken from the 29 pages under
  `https://www.algonquinpark.on.ca/visit/camping/*-access-point.php`, whose HTML
  is kept in `raw/ap_pages/` and parsed into `access_official`.
  `build_access_geo.py` then picks a pin coordinate for each and writes
  `access_official_geo.csv`.
  `fetch_access_pages.py` re-fetches those pages (cached 30 days, paced, one dead
  page is a warning). The slugs come from `access_official.csv` itself, which is
  the durable list of *which* pages exist; adding an access point is still a
  manual row, which is a change someone should mean.
  Nothing fetched these pages until that script existed, and `raw/` is
  gitignored — so a clean runner had none, and `parse_osm.py` was free to write
  an empty table over a good one. It did, once, and deleted all 29 access points:
  no numbered pins, and no way to start or end a route at one. `parse_osm.py`
  now follows the same rule as `conditions.csv` — a file it cannot populate is
  not one it may empty — so the scraper is an improvement rather than a rescue.
- **Conditions**: `fetch_conditions.py` scrapes the park advisories page
  (`algonquinpark.on.ca/news/algonquin_park_advisories.php`) for the bulleted
  text under its Closures / Boil Water / Low Water headings, adds a few standing
  rows (permit requirement, portage signage), and rewrites `conditions.csv`
  wholesale. Rows carry `source` and `as_of`; treat low-water rows as stale
  after a few weeks. Hand-edits do not survive a run.
- **Elevations**: `fetch_elevations.py` samples each portage trail, fetches
  SRTM 90 m elevations from OpenTopoData, caches them in `data/elevations.csv`
  and writes `data/climbs.csv` (up, down and a 12-point profile per portage).
- **Serving**: `serve.py` is a no-cache static server for the built page.

## How to use

```bash
cd algonquin-graph

# refresh only what has aged past its budget, then rebuild
python3 fetch_osm.py
python3 fetch_access_pages.py
python3 fetch_conditions.py
python3 fetch_elevations.py
python3 build_access_geo.py
python3 parse_osm.py
python3 build_page.py

# optional: the DuckDB side, for SQL exploration
duckdb algonquin.duckdb < build_db.sql
duckdb algonquin.duckdb < queries.sql

# serve the page (no-cache, so a rebuild shows up on reload)
python3 serve.py
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
  maps and signage. Portaging distances are geometric path lengths, close to but
  not certified against official posted lengths (signed lengths appear in portage
  names where OSM has them).
- **River reaches are assumed paddleable end to end**: a reach link means the water
  ways physically touch the lake, not that you can legally or practically paddle the
  whole system. Obstacle flags are proximity-based (100 m of a portage landing,
  50 m of a reach), not a hydrological guarantee, and routing does not block on
  obstacles — filter with `NOT has_rapids` etc. if you want conservative routes.
- **Verify before you go**: cross-check with the official canoe-routes map
  (algonquinpark.on.ca) and current Ontario Parks alerts before reserving.
