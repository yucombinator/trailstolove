/* Dijkstra router over the Algonquin canoe graph. Pure functions, no DOM. */
(function (global) {
  "use strict";

  function buildIndex(data) {
    const nodeById = new Map();
    for (const n of data.nodes) {
      nodeById.set(n[0], { id: n[0], name: n[1], kind: n[2], lat: n[3], lon: n[4], dm: n[5] || 0 });
    }
    const adj = new Map();
    for (const e of data.edges) {
      if (!adj.has(e.s)) adj.set(e.s, []);
      adj.get(e.s).push(e);
    }
    const search = [];
    for (const n of data.nodes) {
      if (n[1]) search.push({ id: n[0], name: n[1], kind: n[2] });
    }
    return { nodeById, adj, search };
  }

  // Steepness of a carry: climb over horizontal run, 0 when unknown.
  function gradeOf(e) {
    if (!e.m || e.el === null || e.el === undefined || e.el <= 0) return 0;
    return Math.min(e.el / e.m, 0.6);
  }
  // Carry effort in metres-equivalent. A canoe goes uphill badly, so grade is
  // charged with a steep multiplier (2.5x at a 50% grade, capped) on top of
  // the flat distance: 500 m flat costs 500, 500 m at 20% costs 800.
  function carryEffort(e, k) {
    const g = gradeOf(e);
    return e.m * (1 + (k === undefined ? 3 : k) * g) + (e.el || 0) * 0.5;
  }
  // Human rating for the directions list.
  function carryRating(e) {
    const g = gradeOf(e);
    if (!e.m) return null;
    if (e.el === null || e.el === undefined) return { label: 'grade unknown', cls: 'r-unknown' };
    if (e.el < 3) return { label: 'flat', cls: 'r-flat' };
    if (g < 0.05) return { label: 'gentle', cls: 'r-flat' };
    if (g < 0.10) return { label: 'moderate', cls: 'r-moderate' };
    if (g < 0.15) return { label: 'steep', cls: 'r-steep' };
    if (g < 0.22) return { label: 'very steep', cls: 'r-vsteep' };
    return { label: 'brutal', cls: 'r-brutal' };
  }
  function cost(e, mode, avoidObstacles, penalty, idx) {
    if (avoidObstacles && e.o && e.o.length) return null;
    if (penalty) {
      const f = penalty.get(e);
      if (f) return cost(e, mode, avoidObstacles, null, idx) * f;
    }
    if (mode === "conservative" && e.k === "river") return null;
    if (e.k === "portage") {
      if (mode === "carries") return 1e6 + e.m;
      if (mode === "easiest") return carryEffort(e, 10);
      if (mode === "balanced") return carryEffort(e, 3);
      if (mode === "meters") return e.m;
      return 1 + e.m / 1e7; // "edges": fewest hops, tie-broken by carry metres
    }
    if (mode === "carries") return 0.5;
    // "balanced": crossing into another water body costs its size (a big lake is
    // real paddling), floored at a 300 m-carry equivalent, capped at 1.2 km.
    // m=0 channels joining two ways of the SAME water are free-ish (not a lake hop).
    if (mode === "balanced") {
      if (e.k === "access") return e.m;
      if (e.m === 0 && idx) {
        const a = idx.nodeById.get(e.s), b = idx.nodeById.get(e.d);
        if (a && b && a.name && a.name === b.name) return 1;
      }
      const t = idx && idx.nodeById.get(e.d);
      return t && t.dm ? Math.min(1200, Math.max(300, t.dm * 0.4)) : 300;
    }
    if (mode === "meters") return Math.max(e.m, 0.001);
    return 1;
  }

  function dijkstra(data, idx, fromId, toId, mode, avoidObstacles, penalty) {
    if (!idx.nodeById.has(fromId) || !idx.nodeById.has(toId)) return null;
    const dist = new Map();
    const prev = new Map();
    dist.set(fromId, 0);
    const heap = [[0, fromId]];
    function push(d, id) {
      heap.push([d, id]);
      let i = heap.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        const t = heap[p]; heap[p] = heap[i]; heap[i] = t;
        i = p;
      }
    }
    function pop() {
      if (!heap.length) return null;
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = 2 * i + 2;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          const t = heap[m]; heap[m] = heap[i]; heap[i] = t;
          i = m;
        }
      }
      return top;
    }
    while (heap.length) {
      const [d, u] = pop();
      if (d > (dist.has(u) ? dist.get(u) : Infinity)) continue;
      if (u === toId) break;
      const out = idx.adj.get(u) || [];
      for (let i = 0; i < out.length; i++) {
        const e = out[i];
        const c = cost(e, mode, avoidObstacles, penalty, idx);
        if (c === null) continue;
        const nd = d + c;
        if (nd < (dist.has(e.d) ? dist.get(e.d) : Infinity)) {
          dist.set(e.d, nd);
          prev.set(e.d, { from: u, edge: e });
          push(nd, e.d);
        }
      }
    }
    if (!dist.has(toId)) return null;
    const steps = [];
    let cur = toId;
    while (cur !== fromId) {
      const p = prev.get(cur);
      steps.unshift({ node: cur, edge: p.edge });
      cur = p.from;
    }
    steps.unshift({ node: fromId, edge: null });
    const portageLegs = steps.filter(s => s.edge && s.edge.k === "portage");
    return {
      fromId: fromId,
      toId: toId,
      nodeIds: steps.map(s => s.node),
      legs: steps.filter(s => s.edge).map(s => s.edge),
      carries: portageLegs.length,
      portageM: portageLegs.reduce((s, st) => s + st.edge.m, 0),
      edges: steps.length - 1,
    };
  }

  // Reaches are stitched from many OSM ways (up to 266 lines for one river) and
  // the lines are NOT in path order, so a greedy chain yields chords across the
  // map. Build an endpoint graph per reach and BFS the true path between points.
  const reachCache = new WeakMap();
  const SNAP_DEG = 1.5 / 111320;           // endpoints within ~1.5 m are one node
  function reachGraph(lines) {
    if (reachCache.has(lines)) return reachCache.get(lines);
    const nodes = [];
    const nodeOf = pt => {
      for (let i = 0; i < nodes.length; i++) {
        if (Math.abs(nodes[i][0] - pt[0]) <= SNAP_DEG && Math.abs(nodes[i][1] - pt[1]) <= SNAP_DEG) return i;
      }
      nodes.push(pt);
      return nodes.length - 1;
    };
    const adj = new Map();
    const ends = [];
    for (const line of lines) {
      if (!line || line.length < 2) continue;
      const a = nodeOf(line[0]);
      const b = nodeOf(line[line.length - 1]);
      ends.push([a, b]);
      if (a === b) continue;
      if (!adj.has(a)) adj.set(a, []);
      if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push(ends.length - 1);
      adj.get(b).push(ends.length - 1);
    }
    const g = { nodes: nodes, adj: adj, ends: ends, lines: lines };
    reachCache.set(lines, g);
    return g;
  }
  function dist2(a, b) {
    const dx = a[0] - b[0], dy = a[1] - b[1];
    return dx * dx + dy * dy;
  }
  // nearest point on the whole reach: {line, i, pt, d2}
  function projectReach(g, pts) {
    let best = null;
    for (let li = 0; li < g.lines.length; li++) {
      const line = g.lines[li];
      if (!line || line.length < 2) continue;
      for (let i = 0; i < line.length; i++) {
        for (const p of pts) {
          const d2 = dist2(line[i], p);
          if (!best || d2 < best.d2) best = { line: li, i: i, pt: line[i], d2: d2 };
        }
      }
    }
    return best;
  }
  // BFS across the endpoint graph, returning the concatenated path or null.
  function walkReach(g, aNode, bNode) {
    if (aNode === bNode) return [g.nodes[aNode]];
    const prev = new Map([[aNode, null]]);
    const queue = [aNode];
    for (let h = 0; h < queue.length; h++) {
      const n = queue[h];
      if (n === bNode) break;
      for (const li of g.adj.get(n) || []) {
        const [ea, eb] = g.ends[li];
        const other = n === ea ? eb : ea;
        if (!prev.has(other)) {
          prev.set(other, { from: n, line: li, forward: n === ea });
          queue.push(other);
        }
      }
    }
    if (!prev.has(bNode)) return null;
    const chain = [];
    let cur = bNode;
    while (prev.get(cur)) {
      const step = prev.get(cur);
      const line = g.lines[step.line];
      chain.push(step.forward ? line : line.slice().reverse());
      cur = step.from;
    }
    chain.reverse();
    const path = [];
    for (const line of chain) {
      for (const pt of line) {
        const last = path[path.length - 1];
        if (last && dist2(last, pt) < SNAP_DEG * SNAP_DEG) continue;   // drop joint dupes
        path.push(pt);
      }
    }
    return path.length >= 2 ? path : null;
  }
  // Slice of the reach between the two given edge geometries.
  function reachSlice(lines, gA, gB) {
    const g = reachGraph(lines);
    const ptsA = Array.isArray(gA && gA[0]) ? gA : [gA];
    const ptsB = Array.isArray(gB && gB[0]) ? gB : [gB];
    const pa = projectReach(g, ptsA), pb = projectReach(g, ptsB);
    if (!pa || !pb) return null;
    // projection far from the touch point => the reach isn't mapped there
    if (pa.d2 > 2.5e-6 || pb.d2 > 2.5e-6) return null;   // ~280 m
    const ia = nearestEndNode(g, pa);
    const ib = nearestEndNode(g, pb);
    if (ia < 0 || ib < 0) return null;
    let path = walkReach(g, ia, ib);
    if (!path) {
      // endpoints on different components: still draw the axis if close
      path = [pa.pt, pb.pt];
    }
    // trim to the exact touch points
    const i1 = nearestIdxOn(path, pa.pt), i2 = nearestIdxOn(path, pb.pt);
    const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
    const slice = path.slice(lo, hi + 1);
    if (slice.length >= 2) {
      if (i1 > i2) slice.reverse();               // travel direction A -> B
      return slice;
    }
    return [pa.pt, pb.pt];
  }
  // graph node on the projected line closest to the projection
  function nearestEndNode(g, proj) {
    const [ea, eb] = g.ends[proj.line];
    if (ea === eb) return ea;
    return dist2(g.nodes[ea], proj.pt) <= dist2(g.nodes[eb], proj.pt) ? ea : eb;
  }
  function nearestIdxOn(line, p) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < line.length; i++) {
      const d = dist2(line[i], p);
      if (d < bd) { bd = d; bi = i; }
    }
    return bi;
  }
  // Point on the reach closest to an edge geometry (dashed creek fallback).
  function reachPointOn(lines, g) {
    const gr = reachGraph(lines);
    const pts = Array.isArray(g && g[0]) ? g : [g];
    const p = projectReach(gr, pts);
    return p ? p.pt : null;
  }

  // Chain Dijkstra legs over multiple waypoints, one combined route per cost model.
  // Returns up to `want` distinct options sorted by (carries, carry metres).
  function chainRoutes(data, idx, pointIds, mode, avoidObstacles, want) {
    const seen = new Set();
    const out = [];
    for (const m of [mode].concat(
        ["balanced", "carries", "meters", "conservative", "edges"].filter(x => x !== mode))) {
      if (out.length >= (want || 3)) break;
      let ok = true;
      const nodeIds = [pointIds[0]];
      const legs = [];
      for (let i = 0; i + 1 < pointIds.length; i++) {
        const r = dijkstra(data, idx, pointIds[i], pointIds[i + 1], m, avoidObstacles, null);
        if (!r) { ok = false; break; }
        for (let j = 1; j < r.nodeIds.length; j++) nodeIds.push(r.nodeIds[j]);
        for (const e of r.legs) legs.push(e);
      }
      if (!ok) continue;
      const key = nodeIds.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      const portageLegs = legs.filter(e => e.k === "portage");
      // distinct lakes by NAME (way-split lakes are several nodes, one lake)
      const lakeNames = new Set(nodeIds.map(id => (idx.nodeById.get(id) || {}).name)
        .filter((n, i, arr) => n && arr.indexOf(n) === i));
      out.push({
        mode: m,
        res: {
          nodeIds: nodeIds,
          legs: legs,
          carries: portageLegs.length,
          portageM: portageLegs.reduce((s, e) => s + e.m, 0),
          lakes: lakeNames.size,
          edges: legs.length,
        },
      });
    }
    // the chosen model's route is the headline answer; the rest are alternatives
    const rest = out.filter(o => o.mode !== mode)
      .sort((a, b) => (a.res.carries - b.res.carries) || (a.res.portageM - b.res.portageM));
    return out.filter(o => o.mode === mode).concat(rest).slice(0, want || 3);
  }

  // Path across a lake that stays inside the lake polygon: visibility graph
  // over the ring vertices (outer shorelines + islands as obstacles), Dijkstra
  // from entry to exit. Inputs/outputs are GeoJSON [lon, lat].
  function lakePath(ptA, ptB, geometry) {
    if (!geometry) return null;
    const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates
      : (geometry.type === 'Polygon' ? [geometry.coordinates] : null);
    if (!polys) return null;
    const outers = polys.map(p => p[0]);
    const islands = polys.flatMap(p => p.slice(1));
    const allRings = outers.concat(islands);

    // Landing anchors come from full-resolution geometry while the drawn lake
    // polygons are simplified — anchors can sit just OUTSIDE the rings, which
    // kills the visibility graph (every segment from outside crosses the shore).
    // Snap any anchor that isn't inside to the nearest ring vertex.
    function nearestVertex(p) {
      let best = null, bd = Infinity;
      for (const ring of allRings) {
        for (const v of ring) {
          const d = (v[0] - p[0]) * (v[0] - p[0]) + (v[1] - p[1]) * (v[1] - p[1]);
          if (d < bd) { bd = d; best = v; }
        }
      }
      return best ? [best[0], best[1]] : p;
    }
    const A = insideLake(ptA[0], ptA[1]) ? ptA : nearestVertex(ptA);
    const B = insideLake(ptB[0], ptB[1]) ? ptB : nearestVertex(ptB);

    function segInt(p1, p2, p3, p4) {
      const d1 = (p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x);
      const d2 = (p4.x - p3.x) * (p2.y - p3.y) - (p4.y - p3.y) * (p2.x - p3.x);
      const d3 = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
      const d4 = (p2.x - p1.x) * (p4.y - p1.y) - (p2.y - p1.y) * (p4.x - p1.x);
      return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
             ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
    }
    function inRing(px, py, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], yi = ring[i][1];
        const xj = ring[j][0], yj = ring[j][1];
        if ((yi > py) !== (yj > py) &&
            px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
    function insideLake(px, py) {
      let n = 0;
      for (const ring of allRings) if (inRing(px, py, ring)) n++;
      return n % 2 === 1;
    }
    function blocked(px, py, qx, qy) {
      for (const ring of allRings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = { x: ring[j][0], y: ring[j][1] };
          const b = { x: ring[i][0], y: ring[i][1] };
          if (segInt({ x: px, y: py }, { x: qx, y: qy }, a, b)) return true;
        }
      }
      return false;
    }

    const nodes = [{ x: A[0], y: A[1] }];
    for (const ring of allRings) {
      const step = Math.max(1, Math.ceil(ring.length / 60));
      for (let i = 0; i < ring.length; i += step) nodes.push({ x: ring[i][0], y: ring[i][1] });
    }
    nodes.push({ x: B[0], y: B[1] });

    const n = nodes.length;
    const dist = new Array(n).fill(Infinity);
    const prev = new Array(n).fill(-1);
    dist[0] = 0;
    const done = new Array(n).fill(false);
    for (;;) {
      let u = -1, du = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < du) { du = dist[i]; u = i; }
      if (u === -1 || u === n - 1) break;
      done[u] = true;
      for (let v = 0; v < n; v++) {
        if (done[v]) continue;
        if (blocked(nodes[u].x, nodes[u].y, nodes[v].x, nodes[v].y)) continue;
        const mx = (nodes[u].x + nodes[v].x) / 2, my = (nodes[u].y + nodes[v].y) / 2;
        if (!insideLake(mx, my)) continue;
        const d = Math.hypot(nodes[v].x - nodes[u].x, nodes[v].y - nodes[u].y);
        if (du + d < dist[v]) { dist[v] = du + d; prev[v] = u; }
      }
    }
    if (!isFinite(dist[n - 1])) return null;
    const path = [];
    for (let v = n - 1; v !== -1; v = prev[v]) path.unshift([nodes[v].x, nodes[v].y]);
    // a bare 2-point crossing refines to nothing — inject a midpoint so
    // refinePath can bend it off the straight chord
    if (path.length === 2) {
      path.splice(1, 0, [(path[0][0] + path[1][0]) / 2, (path[0][1] + path[1][1]) / 2]);
    }
    return path;
  }

  // Curve + center a path inside its water body: push interior points away from
  // shorelines by `margin`, then smooth with Catmull-Rom. Inputs GeoJSON [lon, lat].
  function refinePath(points, geometry, margin) {
    if (points.length < 3) return points;
    const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates
      : (geometry.type === 'Polygon' ? [geometry.coordinates] : null);
    if (!polys) return points;
    const rings = polys.flatMap(p => p);
    const DEG_M = 111320;   // metres per degree of latitude

    function pushOff(p) {
      const [px, py] = p;
      let bx = 0, by = 0, bd = Infinity;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const ax = ring[j][0], ay = ring[j][1];
          const cx = ring[i][0], cy = ring[i][1];
          const dx = cx - ax, dy = cy - ay;
          const L2 = dx * dx + dy * dy;
          let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
          t = Math.max(0, Math.min(1, t));
          const px2 = ax + t * dx, py2 = ay + t * dy;
          const d = Math.hypot(px - px2, py - py2);
          if (d < bd) { bd = d; bx = px2; by = py2; }
        }
      }
      if (!isFinite(bd) || bd * DEG_M >= margin) return [px, py];
      const vx = px - bx, vy = py - by;
      const L = Math.hypot(vx, vy) || 1;
      const push = (margin - bd * DEG_M) / DEG_M;   // displacement in degrees
      return [px + (vx / L) * push, py + (vy / L) * push];
    }

    const pts2 = [points[0]];
    for (let i = 1; i < points.length - 1; i++) pts2.push(pushOff(points[i]));
    pts2.push(points[points.length - 1]);

    if (pts2.length < 3) return pts2;
    const P = i => ({ x: pts2[Math.max(0, Math.min(pts2.length - 1, i))][0],
                      y: pts2[Math.max(0, Math.min(pts2.length - 1, i))][1] });
    const out = [pts2[0]];
    for (let i = 0; i + 1 < pts2.length; i++) {
      const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
      for (let s = 1; s <= 3; s++) {
        const t = s / 4, t2 = t * t, t3 = t2 * t;
        out.push([0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
                  0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)]);
      }
    }
    out.push(pts2[pts2.length - 1]);
    // guard: the spline must stay near the input path — on any wild excursion
    // fall back to the unrefined path (which drawRoute can draw safely)
    let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity;
    for (const p of pts2) {
      if (p[0] < mnX) mnX = p[0]; if (p[0] > mxX) mxX = p[0];
      if (p[1] < mnY) mnY = p[1]; if (p[1] > mxY) mxY = p[1];
    }
    const slack = 0.05;   // ~5 km — the spline may bulge, never wander
    for (const p of out) {
      if (p[0] < mnX - slack || p[0] > mxX + slack || p[1] < mnY - slack || p[1] > mxY + slack) return points;
    }
    return out;
  }

  const Router = { buildIndex: buildIndex, dijkstra: dijkstra, cost: cost,
    carryRating: carryRating, carryEffort: carryEffort, gradeOf: gradeOf, reachSlice: reachSlice, reachPointOn: reachPointOn, chainRoutes: chainRoutes, lakePath: lakePath, refinePath: refinePath };
  global.Router = Router;
})(typeof window !== "undefined" ? window : globalThis);
