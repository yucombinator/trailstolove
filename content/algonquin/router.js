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
    // Search vocabulary. Paddlers do not type the name the map has: trip reports
    // and guides say "Narrowbag", "Red Pine Bay", "Mike's Lake", "Kiosk",
    // "Kio" where OSM has "Narrowbag Lake", "Redpine Lake", "Mink (Little)"
    // and so on. Nineteen of thirty-two published trip reports could not even
    // be replayed because their names did not resolve, so the gaps were as much
    // a UX failure as a measurement one. Add the variants people actually use.
    const search = [];
    const seen = new Set();
    const add = (id, name, kind) => {
      const k = id + "\u0000" + name;
      if (seen.has(k)) return;
      seen.add(k);
      search.push({ id, name, kind });
    };
    const variants = (name) => {
      const out = new Set([name]);
      const core = name.replace(/\s+lake$/i, "").replace(/\s*\(\w+\)\s*$/, "").trim();
      out.add(core);
      out.add(core + " lake");
      out.add("lake " + core);
      // "Ralph Bice (Butt)" -> "Butt Lake"; "Mink (Little)" -> "Little Mink Lake"
      const m = core.match(/^(.+?)\s*\((.+?)\)$/);
      if (m) {
        out.add(`${m[2]} ${m[1]} lake`);
        out.add(`${m[2]} ${m[1]}`);
      }
      // "Mike's Lake" <-> "Mikes Lake"
      out.add(name.replace(/'/g, ""));
      for (const v of [...out]) out.add(v.replace(/'/g, ""));
      return [...out].filter(Boolean);
    };
    for (const n of data.nodes) {
      if (!n[1]) continue;
      for (const v of variants(n[1])) add(n[0], v, n[2]);
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
  // Cost of one edge under a routing goal. Four goals, all of them things a
  // paddler actually weighs: how many carries, how far you walk, how hard they
  // are, and a blend that also charges for the water you have to cross.
  function cost(e, mode, avoidObstacles, penalty, idx) {
    // A shoreline-only link between two differently named bodies is real
    // geometry but not a crossing: it is marked `ph` by build_page.py. Letting
    // it through priced a phantom paddle at zero and stitched the whole graph
    // into one component — Tim River -> Longbow Lake came back "0 portages".
    if (e.ph) return null;
    if (avoidObstacles && e.o && e.o.length) return null;
    if (penalty) {
      const f = penalty.get(e);
      if (f) return cost(e, mode, avoidObstacles, null, idx) * f;
    }
    if (e.haz) {
      // Rapids are paddlable, not impassable — but they must never be the
      // cheap way round. Price them like a portage so a real carry wins when
      // one exists, and fall back to the rapids when the only way through is
      // the water. The directions carry the warning; this only orders them.
      const f = 6;
      if (mode === "carries") return 0.5;
      if (mode === "meters") return e.m * f;
      if (mode === "easiest") return e.m * f * 4;
      return e.m * f;
    }
    if (e.k === "portage") {
      if (mode === "carries") return 1e6 + e.m;     // count first, metres only to break ties
      if (mode === "easiest") return carryEffort(e, 10);
      if (mode === "meters") return e.m;              // the metres you actually walk
      return carryEffort(e, 3);                     // "balanced"
    }
    if (mode === "carries") return 0.5;
    // "meters" means least CARRYING, so paddling must only break ties between
    // routes that walk the same distance. Charging paddling at full weight made
    // this "shortest total route" instead: it preferred 1,116 m of carrying
    // over a route that walked 846 m, because the latter paddled further.
    if (mode === "meters") return e.m * 0.01;
    // "balanced": crossing into another water body costs its size (a big lake is
    // real paddling), floored at a 300 m-carry equivalent, capped at 1.2 km.
    // m=0 channels joining two ways of the SAME water are free-ish (not a lake hop).
    if (e.k === "access") return e.m;
    if (e.m === 0 && idx) {
      const a = idx.nodeById.get(e.s), b = idx.nodeById.get(e.d);
      if (a && b && a.name && a.name === b.name) return 1;
    }
    const t = idx && idx.nodeById.get(e.d);
    return t && t.dm ? Math.min(1200, Math.max(300, t.dm * 0.4)) : 300;
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
    // No mapped waterway between the two landings: report that rather than
    // inventing a straight chord, which drew a false line across the water.
    if (!path) return null;
    // trim to the exact touch points
    const i1 = nearestIdxOn(path, pa.pt), i2 = nearestIdxOn(path, pb.pt);
    const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
    const slice = path.slice(lo, hi + 1);
    if (slice.length >= 2) {
      if (i1 > i2) slice.reverse();               // travel direction A -> B
      return slice;
    }
    return null;
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
        ["balanced", "easiest", "carries", "meters"].filter(x => x !== mode))) {
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
    // polygons are simplified, so an anchor can sit slightly OUTSIDE the rings —
    // and every segment from outside crosses the shore, killing the search.
    // Snap to the nearest point ON a ring (perpendicular foot, not just the
    // nearest vertex: on a 50 km shoreline the vertices are hundreds of metres
    // apart, which is how Burnt Island's 7 km crossing used to fail).
    function snapToShore(p) {
      let best = null, bd = Infinity;
      for (const ring of allRings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const ax = ring[j][0], ay = ring[j][1];
          const bx = ring[i][0], by = ring[i][1];
          const dx = bx - ax, dy = by - ay;
          const L2 = dx * dx + dy * dy;
          let t = L2 ? ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2 : 0;
          t = Math.max(0, Math.min(1, t));
          const fx = ax + t * dx, fy = ay + t * dy;
          const d = (p[0] - fx) * (p[0] - fx) + (p[1] - fy) * (p[1] - fy);
          if (d < bd) { bd = d; best = [fx, fy]; }
        }
      }
      return best || p;
    }
    const A = settle(insideLake(ptA[0], ptA[1]) ? ptA : snapToShore(ptA));
    const B = settle(insideLake(ptB[0], ptB[1]) ? ptB : snapToShore(ptB));
    // A point sitting exactly ON the shoreline breaks both the inside test
    // (ray casting through a vertex is a coin flip) and the blocked test, so
    // the anchor is always resolved to a spot just inside the water: keep it
    // if it is already clearly in, otherwise walk to the nearest ring-vertex
    // pair whose midpoint is inside.
    function settle(p) {
      if (insideLake(p[0], p[1])) return p;
      let best = null, bd = Infinity;
      for (const ring of allRings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const mx = (ring[j][0] + ring[i][0]) / 2, my = (ring[j][1] + ring[i][1]) / 2;
          if (!insideLake(mx, my)) continue;
          const d = (p[0] - mx) * (p[0] - mx) + (p[1] - my) * (p[1] - my);
          if (d < bd) { bd = d; best = [mx, my]; }
        }
      }
      return best || p;
    }


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
    // Hit-testing a 1500-vertex ring for every candidate segment is what made
    // big lakes (Opeongo) fall back to a straight line: pre-simplify the rings
    // for collision tests, and give each test segment a bounding box.
    // Collision rings keep enough points to hold the shoreline shape, but the
    // visibility graph needs density proportional to perimeter: a flat budget
    // leaves 2.3 km between nodes on a 138 km lake like Opeongo, so the graph
    // can no longer chain around the shore and the crossing fails outright.
    // Below this many vertices, hit-test the ring as-is: simplifying it is what
    // broke crossings on mid-size lakes (Burnt Island, Little Otterslide), where
    // the coarse ring no longer threads the real shoreline. The cost stays
    // acceptable because a small ring has few segments to test.
    const EXACT_RING = 400;
    const TEST_PTS = 240;
    function perim(ring) {
      let s = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        s += Math.hypot((ring[i][0] - ring[j][0]) * 78000, (ring[i][1] - ring[j][1]) * 111320);
      }
      return s;
    }
    function budget(ring) {
      // ~150 m per node, clamped to something a browser can chew on
      return Math.max(48, Math.min(900, Math.round(perim(ring) / 150)));
    }
    function simplify(ring, cap) {
      if (ring.length <= cap) return ring;
      const step = ring.length / cap;
      const out = [];
      for (let i = 0; i < cap; i++) out.push(ring[Math.floor(i * step) % ring.length]);
      return out;
    }
    const testRings = allRings.map(r => r.length <= EXACT_RING ? r : simplify(r, Math.max(TEST_PTS, budget(r))));
    // per-segment bbox: [minx, miny, maxx, maxy]
    const segBoxes = testRings.map(ring => {
      const boxes = new Float64Array(ring.length * 4);
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        boxes[i * 4] = Math.min(ring[j][0], ring[i][0]);
        boxes[i * 4 + 1] = Math.min(ring[j][1], ring[i][1]);
        boxes[i * 4 + 2] = Math.max(ring[j][0], ring[i][0]);
        boxes[i * 4 + 3] = Math.max(ring[j][1], ring[i][1]);
      }
      return boxes;
    });
    function blocked(px, py, qx, qy) {
      const lox = Math.min(px, qx), hix = Math.max(px, qx);
      const loy = Math.min(py, qy), hiy = Math.max(py, qy);
      for (let ri = 0; ri < testRings.length; ri++) {
        const ring = testRings[ri], boxes = segBoxes[ri];
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const o = i * 4;
          if (boxes[o] > hix || boxes[o + 2] < lox || boxes[o + 1] > hiy || boxes[o + 3] < loy) continue;
          const a = { x: ring[j][0], y: ring[j][1] };
          const b = { x: ring[i][0], y: ring[i][1] };
          if (segInt({ x: px, y: py }, { x: qx, y: qy }, a, b)) return true;
        }
      }
      return false;
    }

    // Entry and exit sometimes sit on the same shoreline vertex (a lake you
    // paddle into and straight back out of). The visibility graph cannot help
    // there and the inside test on a boundary point is a coin flip, so a
    // near-zero crossing is simply the two points.
    const spanM = Math.hypot((B[0] - A[0]) * 78000, (B[1] - A[1]) * 111320);
    if (spanM < 60) return [A, B];

    // Fast path: on open water the paddler takes a near-straight line. If
    // nothing obstructs the chord, take it (with a midpoint so refinePath can
    // still smooth it) and skip the visibility graph entirely.
    const directOk = !blocked(A[0], A[1], B[0], B[1]) &&
      insideLake((A[0] + B[0]) / 2, (A[1] + B[1]) / 2);
    if (directOk) return [A, [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2], B];

    // A dense visibility graph is quadratic; with ~900 nodes on a big lake
    // that is hundreds of millions of tests and would hang the browser. Keep
    // the graph to a safe node count, and instead of one global step, do a
    // two-tier search: coarse graph first, then re-run locally on the arc that
    // the coarse pass found, where the shoreline detail actually matters.
    // Small rings are cheap to hit-test in full, and subsampling them is what
    // loses narrow water crossings: every other vertex of a 130-vertex lake can
    // miss the thread between two lobes. Only big rings get sampled, and even
    // then the local retry uses full resolution.
    const FULL_BELOW = 300;
    const MAX_NODES = 320;
    const ringsSorted = testRings.slice().sort((x, y) => y.length - x.length);
    const perimSorted = ringsSorted.map(perim).sort((a, b) => b - a);
    const biggest = perimSorted[0] || 1;
    const exact = ringsSorted[0].length <= FULL_BELOW;
    const cap = exact ? ringsSorted[0].length
                      : Math.max(40, Math.min(MAX_NODES, Math.round(biggest / 150)));
    const nodes = [{ x: A[0], y: A[1] }];
    for (const ring of testRings) {
      const step = Math.max(1, Math.ceil(ring.length / cap));
      for (let i = 0; i < ring.length; i += step) nodes.push({ x: ring[i][0], y: ring[i][1] });
    }
    nodes.push({ x: B[0], y: B[1] });

    function search() {
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
      return path;
    }

    // Last resort when the graph finds nothing (a pinched lake where the entry
    // and exit sit on opposite lobes): bow the chord toward open water rather
    // than letting the caller draw a straight line across the shoreline.
    function bowedLine() {
      const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      if (insideLake(mid[0], mid[1]) && !blocked(A[0], A[1], B[0], B[1])) {
        return [A, mid, B];
      }
      // pull the midpoint to the nearest interior point that actually opens up
      let best = null, bd = Infinity;
      for (const ring of allRings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const mx = (ring[j][0] + ring[i][0]) / 2, my = (ring[j][1] + ring[i][1]) / 2;
          if (!insideLake(mx, my)) continue;
          if (blocked(A[0], A[1], mx, my) || blocked(mx, my, B[0], B[1])) continue;
          const d = (mid[0] - mx) * (mid[0] - mx) + (mid[1] - my) * (mid[1] - my);
          if (d < bd) { bd = d; best = [mx, my]; }
        }
      }
      return best ? [A, best, B] : null;
    }

    let coarse = search();
    if (!coarse) return bowedLine();
    if (coarse.length < 3) return coarse;
    // If the winning route is short in node terms but long on the ground, the
    // coarse pass squeezed through a gap the real shoreline would not allow —
    // refine around the anchors with a denser local graph.
    const runLen = Math.hypot((coarse[coarse.length - 1][0] - coarse[0][0]) * 78000,
                              (coarse[coarse.length - 1][1] - coarse[0][1]) * 111320);
    if (runLen > 2000 && cap < ringsSorted[0].length) {
      const dense = ringsSorted[0];
      const saved = testRings[0];
      testRings[0] = dense;                       // full-resolution ring
      const extra = [];
      const step = Math.max(1, Math.ceil(dense.length / MAX_NODES));
      for (let i = 0; i < dense.length; i += step) extra.push({ x: dense[i][0], y: dense[i][1] });
      nodes.length = 0;
      nodes.push({ x: A[0], y: A[1] });
      for (const q of extra) nodes.push(q);
      nodes.push({ x: B[0], y: B[1] });
      const fine = search();
      testRings[0] = saved;
      if (fine && fine.length > coarse.length) return fine;
    }
    return coarse;
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
  // Tracks what has been drawn so a redundant connector is never painted twice.
  // This lived inline in the page, where `opts && opts.force !== true` silently
  // short-circuited on undefined and left the whole check permanently disabled.
  // It lives here so a test can actually exercise it.
  //
  // A connector counts as already-covered only when it is essentially the SAME
  // line as something drawn. Sharing a single landing point is not coverage:
  // treating one coincident point as a match silently dropped whole stretches
  // of river that merely started where a lake path ended.
  function overlapTracker(tolM, coverFrac) {
    const tol = tolM === undefined ? 30 : tolM;              // metres
    const need = coverFrac === undefined ? 0.8 : coverFrac;  // fraction of samples
    const drawn = [];
    function covered(coords) {
      if (!drawn.length || coords.length < 2) return false;
      const step = Math.max(1, Math.floor(coords.length / 6));
      let hits = 0, sampled = 0;
      for (let i = 0; i < coords.length; i += step) {
        sampled++;
        const c = coords[i];
        for (let k = 0; k < drawn.length; k++) {
          if (Math.hypot((c[0] - drawn[k][0]) * 78000, (c[1] - drawn[k][1]) * 111320) < tol) {
            hits++;
            break;
          }
        }
      }
      return sampled > 0 && hits >= sampled * need;
    }
    return {
      covered: covered,
      add: coords => { for (const c of coords) drawn.push(c); },
      size: () => drawn.length,
      reset: () => { drawn.length = 0; },
    };
  }
  // Only what the map calls, plus the seams worth testing. dijkstra/cost/
  // carryEffort stay internal.
  const Router = { buildIndex: buildIndex, overlapTracker: overlapTracker,
    carryRating: carryRating, gradeOf: gradeOf, reachSlice: reachSlice, reachPointOn: reachPointOn, chainRoutes: chainRoutes, lakePath: lakePath, refinePath: refinePath };
  global.Router = Router;
})(typeof window !== "undefined" ? window : globalThis);
