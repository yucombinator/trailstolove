-- Build algonquin.duckdb from data/*.csv (produced by parse_osm.py).
-- Run:  duckdb algonquin.duckdb < build_db.sql
--
-- Graph model:
--   nodes  = lakes/ponds/riverbank polys (water), stitched river reaches, access points
--   edges  = portages (walk), river links (paddle up/down a waterway),
--            channel links (lakes sharing shore / same water split across ways),
--            access links (launch -> lake)
--   obstacles (rapids/waterfall/dam/weir) are attached to edges by proximity,
--   conditions holds special conditions (low water, closures, permits) for manual extension.

CREATE OR REPLACE MACRO hav(a1, o1, a2, o2) AS
  2 * 6371000 * asin(sqrt(
      power(sin(radians(a2 - a1) / 2), 2)
    + cos(radians(a1)) * cos(radians(a2)) * power(sin(radians(o2 - o1) / 2), 2)));

CREATE OR REPLACE TABLE water (
  id      BIGINT PRIMARY KEY,
  name    TEXT,
  kind    TEXT,      -- lake | pond | reservoir | river | reach
  lat     DOUBLE,
  lon     DOUBLE,
  area_m2 DOUBLE,
  major   INTEGER,   -- 1 = named feature
  dm      DOUBLE     -- bbox diagonal in metres: the scale of a crossing into it
);
INSERT INTO water SELECT * FROM read_csv_auto('data/water.csv', header = true);

CREATE OR REPLACE TABLE portages (
  osm_id   BIGINT PRIMARY KEY,
  name     TEXT,
  length_m DOUBLE,
  p0_lat DOUBLE, p0_lon DOUBLE,
  p1_lat DOUBLE, p1_lon DOUBLE,
  from_id  BIGINT,
  to_id    BIGINT,
  from_dist DOUBLE,
  to_dist   DOUBLE,
  tags     TEXT
);
INSERT INTO portages SELECT * FROM read_csv_auto('data/portages.csv', header = true);

CREATE OR REPLACE TABLE water_links (
  from_id  BIGINT,
  to_id    BIGINT,
  kind     TEXT,      -- river | channel
  length_m DOUBLE,
  via      TEXT
);
INSERT INTO water_links SELECT * FROM read_csv_auto('data/water_links.csv', header = true);

CREATE OR REPLACE TABLE obstacles (
  osm_id BIGINT,
  type   TEXT,        -- rapids | waterfall | dam | weir
  name   TEXT,
  lat    DOUBLE,
  lon    DOUBLE
);
INSERT INTO obstacles SELECT * FROM read_csv_auto('data/obstacles.csv', header = true);

CREATE OR REPLACE TABLE access_osm (
  osm_id   BIGINT,
  name     TEXT,
  kind     TEXT,
  lat      DOUBLE,
  lon      DOUBLE,
  water_id BIGINT
);
INSERT INTO access_osm SELECT * FROM read_csv_auto('data/access_osm.csv', header = true);

CREATE OR REPLACE TABLE access_official (
  num  INTEGER,
  name TEXT,
  slug TEXT,
  url  TEXT
);
INSERT INTO access_official SELECT * FROM read_csv_auto('data/access_official.csv', header = true);

CREATE OR REPLACE TABLE conditions (
  category TEXT,      -- low-water | closure | permit | info | note
  scope    TEXT,      -- lake / waterway name the note applies to, or 'park-wide'
  note     TEXT,
  source   TEXT,
  as_of    DATE
);
INSERT INTO conditions SELECT * FROM read_csv_auto('data/conditions.csv', header = true);

-- ---------------------------------------------------------------
-- Derived views
-- ---------------------------------------------------------------

-- All routable nodes: water bodies + access points (offset ids to avoid way-id collisions).
CREATE OR REPLACE VIEW nodes AS
SELECT id, name, kind, lat, lon, major FROM water
UNION ALL
SELECT 1000000000000 + osm_id AS id, name, 'access' AS kind, lat, lon, 1 AS major
FROM access_osm;

-- Obstacles attached to edges: parsed proximity results (obstacle on portage endpoint
-- within 100 m, or on a reach within 50 m).
CREATE OR REPLACE TABLE edge_obstacles AS
SELECT * FROM read_csv_auto('data/edge_obstacles.csv', header = true);

-- Per-edge obstacle flags.
CREATE OR REPLACE TABLE edge_flags AS
SELECT edge_id, edge_kind,
       count(*) FILTER (type = 'rapids')    AS rapids,
       count(*) FILTER (type = 'waterfall') AS waterfalls,
       count(*) FILTER (type = 'dam')       AS dams,
       count(*) FILTER (type = 'weir')      AS weirs,
       count(*)                             AS n_obstacles
FROM edge_obstacles
GROUP BY edge_id, edge_kind;

-- Uniform directed edge list (undirected source data duplicated both ways).
CREATE OR REPLACE VIEW graph_edges AS
SELECT p.osm_id AS edge_id, 'portage' AS kind,
       p.from_id AS src, p.to_id AS dst,
       p.length_m AS meters, p.name AS label
FROM portages p
WHERE p.from_id IS NOT NULL AND p.to_id IS NOT NULL AND p.from_id <> p.to_id
UNION ALL
SELECT p.osm_id, 'portage', p.to_id, p.from_id, p.length_m, p.name
FROM portages p
WHERE p.from_id IS NOT NULL AND p.to_id IS NOT NULL AND p.from_id <> p.to_id
UNION ALL
SELECT -(l.from_id * 2000000000 + l.to_id), l.kind, l.from_id, l.to_id, l.length_m, l.via
FROM water_links l
UNION ALL
SELECT -(l.to_id * 2000000000 + l.from_id), l.kind, l.to_id, l.from_id, l.length_m, l.via
FROM water_links l
UNION ALL
SELECT 2000000000000 + a.osm_id, 'access', 1000000000000 + a.osm_id, a.water_id,
       hav(a.lat, a.lon, w.lat, w.lon), 'launch'
FROM access_osm a JOIN water w ON w.id = a.water_id
UNION ALL
SELECT 2000000000000 + a.osm_id, 'access', a.water_id, 1000000000000 + a.osm_id,
       hav(a.lat, a.lon, w.lat, w.lon), 'launch'
FROM access_osm a JOIN water w ON w.id = a.water_id;

-- Routable edges enriched with obstacle flags.
-- (edge ids are unique across kinds by construction: portages use positive OSM way ids,
--  river/channel links use negative composite ids, access edges use 2e12+ ids.)
CREATE OR REPLACE VIEW route_edges AS
SELECT g.*,
       COALESCE(f.rapids, 0)      > 0 AS has_rapids,
       COALESCE(f.waterfalls, 0)  > 0 AS has_waterfall,
       COALESCE(f.dams, 0)        > 0 AS has_dam,
       COALESCE(f.n_obstacles, 0)     AS n_obstacles
FROM graph_edges g
LEFT JOIN edge_flags f ON f.edge_id = g.edge_id;

-- ---------------------------------------------------------------
-- Post-build sanity
-- ---------------------------------------------------------------
SELECT 'portages' AS what, count(*) AS total,
       count(*) FILTER (from_id IS NOT NULL AND to_id IS NOT NULL AND from_id <> to_id) AS routable,
       count(*) FILTER (from_id = to_id) AS self_loops
FROM portages;

SELECT 'dangling water refs in links' AS what, count(*) AS n
FROM water_links l
WHERE l.from_id NOT IN (SELECT id FROM water) OR l.to_id NOT IN (SELECT id FROM water);

SELECT 'edges with missing endpoints' AS what, count(*) AS n
FROM graph_edges e
WHERE e.src NOT IN (SELECT id FROM nodes) OR e.dst NOT IN (SELECT id FROM nodes);

SELECT 'obstacles attached' AS what, count(*) AS n FROM edge_obstacles;

SELECT 'conditions seeded' AS what, count(*) AS n FROM conditions;
