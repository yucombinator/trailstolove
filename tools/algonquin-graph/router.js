/* Dijkstra router over the Algonquin canoe graph. Pure functions, no DOM. */
(function (global) {
  "use strict";

  function buildIndex(data) {
    const nodeById = new Map();
    for (const n of data.nodes) {
      nodeById.set(n[0], { id: n[0], name: n[1], kind: n[2], lat: n[3], lon: n[4] });
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

  function cost(e, mode, avoidObstacles, penalty) {
    if (avoidObstacles && e.o && e.o.length) return null;
    if (penalty) {
      const f = penalty.get(e);
      if (f) return cost(e, mode, avoidObstacles, null) * f;
    }
    if (mode === "conservative" && e.k === "river") return null;
    if (e.k === "portage") {
      if (mode === "carries") return 1e6 + e.m;
      if (mode === "meters") return e.m;
      return 1 + e.m / 1e7; // "edges": fewest hops, tie-broken by carry metres
    }
    if (mode === "carries") return 0.5;
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
        const c = cost(e, mode, avoidObstacles, penalty);
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

  function reachSlice(lines, ptA, ptB) {
    // lines: [[[lon,lat],...],...]; ptA/ptB: [lon, lat]
    // Pick the line whose combined distance to both touch points is smallest,
    // then slice between the two nearest indices on it.
    function nearestIdx(line, p) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < line.length; i++) {
        const dx = line[i][0] - p[0], dy = line[i][1] - p[1];
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bi = i; }
      }
      return { i: bi, d: bd };
    }
    let best = null;
    for (const line of lines) {
      const a = nearestIdx(line, ptA);
      const b = nearestIdx(line, ptB);
      const sum = a.d + b.d;
      if (!best || sum < best.sum) best = { line: line, a: a.i, b: b.i, sum: sum };
    }
    if (!best) return null;
    const lo = Math.min(best.a, best.b), hi = Math.max(best.a, best.b);
    return best.line.slice(lo, hi + 1);
  }

  // Chain Dijkstra legs over multiple waypoints, one combined route per cost model.
  // Returns up to `want` distinct options sorted by (carries, carry metres).
  function chainRoutes(data, idx, pointIds, mode, avoidObstacles, want) {
    const seen = new Set();
    const out = [];
    for (const m of [mode].concat(
        ["carries", "meters", "conservative", "edges"].filter(x => x !== mode))) {
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
      out.push({
        mode: m,
        res: {
          nodeIds: nodeIds,
          legs: legs,
          carries: portageLegs.length,
          portageM: portageLegs.reduce((s, e) => s + e.m, 0),
          edges: legs.length,
        },
      });
    }
    out.sort((a, b) => (a.res.carries - b.res.carries) || (a.res.portageM - b.res.portageM));
    return out.slice(0, want || 3);
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

    const nodes = [{ x: ptA[0], y: ptA[1] }];
    for (const ring of allRings) {
      const step = Math.max(1, Math.ceil(ring.length / 60));
      for (let i = 0; i < ring.length; i += step) nodes.push({ x: ring[i][0], y: ring[i][1] });
    }
    nodes.push({ x: ptB[0], y: ptB[1] });

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

  // Curve + center a path inside its water body: push interior points away from
  // shorelines by `margin`, then smooth with Catmull-Rom. Inputs GeoJSON [lon, lat].
  function refinePath(points, geometry, margin) {
    if (points.length < 3) return points;
    const polys = geometry.type === 'MultiPolygon' ? geometry.coordinates
      : (geometry.type === 'Polygon' ? [geometry.coordinates] : null);
    if (!polys) return points;
    const rings = polys.flatMap(p => p);

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
      if (!isFinite(bd) || bd >= margin) return [px, py];
      const vx = px - bx, vy = py - by;
      const L = Math.hypot(vx, vy) || 1;
      const push = margin - bd;
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
    return out;
  }

  const Router = { buildIndex: buildIndex, dijkstra: dijkstra, cost: cost, reachSlice: reachSlice, chainRoutes: chainRoutes, lakePath: lakePath, refinePath: refinePath };
  global.Router = Router;
})(typeof window !== "undefined" ? window : globalThis);
