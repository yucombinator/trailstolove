-- Route-finding queries for algonquin.duckdb.
-- Usage (run from the project directory):  duckdb algonquin.duckdb < queries.sql
--
-- Routing: plain recursive CTEs (fewest hops, tie-broken by portage metres).
-- NOTE: the duckpgq community extension loads on duckdb v1.5.4 but its SQL/PGQ
-- parser hook (CREATE PROPERTY GRAPH / GRAPH_TABLE) does not parse in this build;
-- when it catches up, the same `route_edges`/`nodes` tables work unchanged with
-- SHORTEST_PATH. The CTE below is version-agnostic.

-- 1) Summary -----------------------------------------------------------------
SELECT
  (SELECT count(*) FROM water WHERE major = 1)          AS named_water_bodies,
  (SELECT count(*) FROM water WHERE major = 0)          AS unnamed_water_bodies,
  (SELECT count(*) FROM water WHERE kind = 'reach')     AS river_reaches,
  (SELECT count(*) FROM portages)                        AS portages,
  (SELECT count(*) FROM graph_edges)                     AS directed_edges,
  (SELECT count(*) FROM obstacles)                       AS obstacles,
  (SELECT count(*) FROM edge_obstacles)                  AS obstacle_attachments,
  (SELECT count(*) FROM access_osm)                      AS osm_access_points,
  (SELECT count(*) FROM access_official)                 AS official_access_points;

-- 2) Ten largest named lakes
SELECT name, round(area_m2 / 10000.0, 1) AS area_ha, lat, lon
FROM water WHERE major = 1 AND kind IN ('lake', 'reservoir', 'pond')
ORDER BY area_m2 DESC LIMIT 10;

-- 3) Portages touching a given lake (by name)
SELECT p.name AS portage, p.length_m,
       f.name AS from_lake, t.name AS to_lake
FROM portages p
JOIN water f ON f.id = p.from_id
JOIN water t ON t.id = p.to_id
WHERE 'Canoe Lake' IN (f.name, t.name)
ORDER BY p.length_m;

-- 4) Obstacles near a lake's edges
SELECT o.type, o.name, o.lat, o.lon
FROM obstacles o
JOIN edge_obstacles eo ON eo.obstacle_id = o.osm_id
JOIN portages p ON p.osm_id = eo.edge_id
WHERE p.from_id = (SELECT id FROM water WHERE name = 'Canoe Lake' LIMIT 1)
   OR p.to_id   = (SELECT id FROM water WHERE name = 'Canoe Lake' LIMIT 1);

-- 5) Conditions affecting a lake
SELECT c.category, c.note, c.source, c.as_of
FROM conditions c
WHERE c.scope = 'park-wide'
   OR c.scope IN (SELECT name FROM water WHERE name ILIKE '%varley%')
ORDER BY c.category;

-- 6) ROUTE: fewest portages Canoe Lake -> Lake Opeongo (recursive BFS with portage tally)
-- (depth cap 18 is enough for cross-park routes; raise for longer searches)
WITH RECURSIVE walk AS (
  SELECT id AS node, [id] AS path, 0::INT AS hops, 0.0::DOUBLE AS port_m
  FROM water WHERE name = 'Canoe Lake'
  UNION ALL
  SELECT e.dst, w.path || [e.dst], w.hops + 1,
         w.port_m + CASE WHEN e.kind = 'portage' THEN e.meters ELSE 0 END
  FROM walk w
  JOIN route_edges e ON e.src = w.node
  WHERE w.hops < 18 AND NOT list_contains(w.path, e.dst)
)
SELECT path, hops, port_m
FROM walk
WHERE node = (SELECT id FROM water WHERE name = 'Lake Opeongo' LIMIT 1)
ORDER BY hops, port_m
LIMIT 1;

-- 7) Same route rendered step by step
WITH RECURSIVE walk AS (
  SELECT id AS node, [id] AS path, 0::INT AS hops, 0.0::DOUBLE AS port_m
  FROM water WHERE name = 'Canoe Lake'
  UNION ALL
  SELECT e.dst, w.path || [e.dst], w.hops + 1,
         w.port_m + CASE WHEN e.kind = 'portage' THEN e.meters ELSE 0 END
  FROM walk w
  JOIN route_edges e ON e.src = w.node
  WHERE w.hops < 18 AND NOT list_contains(w.path, e.dst)
),
best AS (
  SELECT path, hops, port_m FROM walk
  WHERE node = (SELECT id FROM water WHERE name = 'Lake Opeongo' LIMIT 1)
  ORDER BY hops, port_m LIMIT 1
),
steps AS (
  SELECT UNNEST(best.path) AS nid,
         generate_subscripts(best.path, 1) AS i,
         best.hops, best.port_m
  FROM best
)
SELECT s.i AS step, n.name, n.kind, s.hops, round(s.port_m, 0) AS portage_meters_so_far
FROM steps s JOIN nodes n ON n.id = s.nid
ORDER BY s.i;

-- 8) Connectivity check: distinct water bodies reachable from Canoe Lake within 6 hops
WITH RECURSIVE walk AS (
  SELECT id AS node, [id] AS path, 0::INT AS hops
  FROM water WHERE name = 'Canoe Lake'
  UNION ALL
  SELECT e.dst, w.path || [e.dst], w.hops + 1
  FROM walk w JOIN route_edges e ON e.src = w.node
  WHERE w.hops < 6 AND NOT list_contains(w.path, e.dst)
)
SELECT count(DISTINCT node) AS reachable_within_6_hops FROM walk;
