// Tests for the routing engine. Run: node --test "tests/*.test.js"
//
// Every test names the defect it locks in. Each of these shipped broken at
// least once, and most were caught by hand rather than by a test.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'router_data.json'), 'utf8'));
const sandbox = {};
new Function('globalThis', fs.readFileSync(path.join(ROOT, 'router.js'), 'utf8'))(sandbox);
const Router = sandbox.Router;
const idx = Router.buildIndex(data);
const idOf = name => (idx.search.find(x => x.name === name) || {}).id;
const plan = (a, b, mode) => Router.chainRoutes(data, idx, [idOf(a), idOf(b)], mode, false, 1)[0].res;
const metres = (p, q) => Math.hypot((q[0] - p[0]) * 78000, (q[1] - p[1]) * 111320);
const pathLength = pts => {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += metres(pts[i - 1], pts[i]);
  return n;
};

describe('overlapTracker', () => {
  // The page used to test coverage inline, where `opts && opts.force !== true`
  // short-circuited on undefined. drawnPts stayed empty forever, so every
  // fallback stub was drawn even where a real line already covered the water.
  test('nothing is covered before anything is added', () => {
    const t = Router.overlapTracker();
    assert.equal(t.covered([[-78.5, 45.5], [-78.4, 45.6]]), false);
  });

  test('an identical line is covered', () => {
    const t = Router.overlapTracker();
    const line = [[-78.5, 45.5], [-78.4, 45.6], [-78.3, 45.7]];
    t.add(line);
    assert.equal(t.covered(line), true);
  });

  test('a reversed copy is covered', () => {
    const t = Router.overlapTracker();
    const line = [[-78.5, 45.5], [-78.4, 45.6], [-78.3, 45.7]];
    t.add(line);
    assert.equal(t.covered([...line].reverse()), true);
  });

  test('a parallel line within tolerance is covered', () => {
    const t = Router.overlapTracker();
    t.add([[-78.5, 45.5], [-78.4, 45.6], [-78.3, 45.7]]);
    // 0.0002 deg latitude is ~22 m, inside the 30 m tolerance
    assert.equal(t.covered([[-78.5, 45.5], [-78.4, 45.6], [-78.3, 45.7002]]), true);
  });

  // Treating a single coincident point as coverage silently dropped whole
  // stretches of river that merely STARTED where a lake path ended.
  test('sharing one endpoint is not coverage', () => {
    const t = Router.overlapTracker();
    t.add([[-78.5, 45.5], [-78.4, 45.6]]);
    assert.equal(t.covered([[-78.5, 45.5], [-78.0, 45.9], [-77.5, 46.2]]), false,
      'a line leaving a shared landing point is new water, not a duplicate');
  });

  test('a distant line is not covered', () => {
    const t = Router.overlapTracker();
    t.add([[-78.5, 45.5], [-78.4, 45.6]]);
    assert.equal(t.covered([[-77.0, 46.5], [-76.9, 46.6]]), false);
  });

  test('partial coverage does not count', () => {
    // 2 of 6 samples match => 33%, below the 80% threshold
    const t = Router.overlapTracker();
    t.add([[-78.5, 45.5], [-78.4, 45.6]]);
    const mixed = [[-78.5, 45.5], [-78.4, 45.6], [-77.0, 46.0], [-76.5, 46.3],
                   [-76.0, 46.6], [-75.5, 46.9]];
    assert.equal(t.covered(mixed), false);
  });

  test('two-point lines are tested, not skipped', () => {
    const t = Router.overlapTracker();
    const seg = [[-78.5, 45.5], [-78.4, 45.6]];
    t.add(seg);
    assert.equal(t.covered(seg), true);
    assert.equal(t.covered([[-78.5, 45.5], [-78.4, 45.7]]), false);
  });

  test('add appends and reset clears', () => {
    const t = Router.overlapTracker();
    t.add([[1, 1], [2, 2]]);
    t.add([[3, 3], [4, 4]]);
    assert.equal(t.size(), 4);
    t.reset();
    assert.equal(t.size(), 0);
    assert.equal(t.covered([[1, 1], [2, 2]]), false);
  });

  test('degenerate input does not throw', () => {
    const t = Router.overlapTracker();
    t.add([[1, 1], [2, 2]]);
    assert.equal(t.covered([[1, 1]]), false);
    assert.equal(t.covered([]), false);
  });
});

describe('reachSlice', () => {
  // It used to answer "no path" with a bare two-point chord, which drew a
  // 10.7 km straight line across the Opeongo's 13.5 km of meander.
  function reachPoints(rc) {
    const pts = [];
    for (const line of rc.lines) for (const p of line) pts.push([p[1], p[0]]);
    return pts;
  }

  test('reports "no mapped path" instead of inventing one off the waterway', () => {
    const rc = Object.values(data.reaches).find(r => r.n === 'Opeongo River');
    assert.ok(rc, 'Opeongo River should be in the payload');
    const slice = Router.reachSlice(rc.lines, [[-76.0, 46.9]], [[-75.8, 47.1]]);
    assert.equal(slice, null, 'must return null rather than a chord');
  });

  test('identical endpoints never yield a long fake line', () => {
    for (const rc of Object.values(data.reaches)) {
      if (!rc.lines || !rc.lines.length) continue;
      const pts = reachPoints(rc);
      if (pts.length < 10) continue;
      const slice = Router.reachSlice(rc.lines, [pts[1]], [pts[1]]);
      if (slice && slice.length >= 2) {
        assert.ok(pathLength(slice) < 50,
          `reach "${rc.n}" turned one point into a ${pathLength(slice).toFixed(0)}m line`);
      }
    }
  });

  // The core invariant, exercised the way the page actually calls it: on the
  // anchors of a real route, where two consecutive legs share a reach.
  test('no long span of a real route is answered with a straight chord', () => {
    let checked = 0, nulls = 0;
    for (const [a, b] of [['Access Point #5: Canoe Lake', 'Booth Lake'],
                          ['Canoe Lake', 'Lake Opeongo'],
                          ['Petawawa River', 'Lake Opeongo'],
                          ['Access Point #5: Canoe Lake', 'Lake Opeongo']]) {
      for (const mode of ['balanced', 'carries', 'meters']) {
        const r = plan(a, b, mode);
        for (let i = 1; i < r.nodeIds.length; i++) {
          const e = r.legs[i - 1], f = r.legs[i];
          if (!e || !f || e.k !== 'river' || f.k !== 'river') continue;
          const rid = e.d < 0 ? e.d : e.s;
          if (f.s !== rid && f.d !== rid) continue;        // not the same reach
          const rc = data.reaches[rid];
          if (!rc || !rc.lines) continue;
          if (!e.g || e.g.length < 2 || !f.g || f.g.length < 2) continue;
          const chord = metres(e.g[e.g.length - 1], f.g[0]);
          if (chord < 200) continue;
          const slice = Router.reachSlice(rc.lines, e.g, f.g);
          if (!slice || slice.length < 2) { nulls++; continue; }
          checked++;
          const along = pathLength(slice);
          assert.ok(along >= chord - 30,
            `${a}->${b} [${mode}] reach ${rid} "${rc.n}": ${chord.toFixed(0)}m apart but the ` +
            `slice is only ${along.toFixed(0)}m over ${slice.length} points`);
        }
      }
    }
    assert.ok(checked + nulls > 5, `expected to exercise real reach spans, got ${checked}`);
  });
});

describe('lakePath / refinePath', () => {
  function lakeFeature(name) {
    for (const f of data.lakes.features) if (f.properties.name === name) return f;
    return null;
  }
  // MultiPolygon -> polygon -> ring -> point. Getting this nesting wrong is how
  // the first version of this test silently passed a 1-point "ring".
  function outerRing(geometry) {
    return geometry.type === 'MultiPolygon'
      ? geometry.coordinates[0][0]
      : geometry.coordinates[0];
  }

  test('a path across a lake is built and is not shorter than the chord', () => {
    const f = lakeFeature('Lake Opeongo');
    assert.ok(f, 'Lake Opeongo should be in the payload');
    const ring = outerRing(f.geometry);
    assert.ok(ring.length > 100, `ring has only ${ring.length} points`);
    const a = ring[0], b = ring[Math.floor(ring.length / 2)];
    const p = Router.lakePath(a, b, f.geometry);
    assert.ok(p && p.length >= 2, 'expected a path inside the lake');
    assert.ok(pathLength(p) >= metres(a, b) - 30);
  });

  test('refinePath keeps the path inside the lake bbox', () => {
    const f = lakeFeature('Lake Opeongo');
    const ring = outerRing(f.geometry);
    const a = ring[0], b = ring[Math.floor(ring.length / 3)];
    const p = Router.lakePath(a, b, f.geometry);
    if (!p) return;
    const refined = Router.refinePath(p, f.geometry, 40);
    assert.ok(refined && refined.length >= 2);
    const lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
    const slack = 0.05;
    for (const pt of refined) {
      assert.ok(pt[0] >= Math.min(...lons) - slack && pt[0] <= Math.max(...lons) + slack &&
                pt[1] >= Math.min(...lats) - slack && pt[1] <= Math.max(...lats) + slack,
        `refined point ${pt} escaped the lake bbox`);
    }
  });

  test('identical endpoints do not throw', () => {
    const f = lakeFeature('Lake Opeongo');
    const pt = outerRing(f.geometry)[0];
    assert.doesNotThrow(() => Router.lakePath(pt, pt, f.geometry));
  });
});

describe('carry rating and effort', () => {
  test('ratings span more than one label', () => {
    const seen = new Set();
    for (const e of data.edges.filter(e => e.k === 'portage')) {
      const r = Router.carryRating(e);
      if (r) seen.add(r.label);
    }
    assert.ok(seen.size >= 2, `expected several ratings, saw ${[...seen]}`);
  });

  test('a steeper carry grades steeper', () => {
    assert.ok(Router.gradeOf({ m: 400, el: 80 }) > Router.gradeOf({ m: 400, el: 0 }));
  });

  test('grade stays finite and in range across every portage', () => {
    for (const e of data.edges.filter(e => e.k === 'portage')) {
      const gr = Router.gradeOf(e);
      assert.ok(Number.isFinite(gr) && gr >= 0 && gr <= 1, `grade ${gr} out of range`);
    }
  });

  test('missing elevation data does not produce NaN', () => {
    const g = Router.gradeOf({ m: 300, el: null, ed: null });
    assert.ok(Number.isFinite(g) || g === 0, `got ${g}`);
  });
});

describe('functionality: planning a trip', () => {
  // Golden routes. If a cost model changes, this names what moved and by how
  // much, instead of leaving a human to spot it on a screenshot.
  const GOLDEN = [
    ['Access Point #5: Canoe Lake', 'Booth Lake', 'balanced', { carries: 8, portageM: 5784, lakes: 15 }],
    ['Access Point #5: Canoe Lake', 'Booth Lake', 'easiest',   { carries: 7, portageM: 3610, lakes: 16 }],
    ['Access Point #5: Canoe Lake', 'Booth Lake', 'carries',   { carries: 2, portageM: 846,  lakes: 18 }],
    ['Access Point #5: Canoe Lake', 'Booth Lake', 'meters',    { carries: 2, portageM: 846,  lakes: 19 }],
    ['Canoe Lake', 'Lake Opeongo', 'balanced',  { carries: 7, portageM: 5140, lakes: 12 }],
    ['Canoe Lake', 'Lake Opeongo', 'easiest',   { carries: 6, portageM: 2966, lakes: 13 }],
    ['Canoe Lake', 'Lake Opeongo', 'meters',    { carries: 2, portageM: 846,  lakes: 15 }],
    ['Petawawa River', 'Lake Opeongo', 'balanced', { carries: 1, portageM: 1893, lakes: 5 }],
    ['Petawawa River', 'Lake Opeongo', 'meters',    { carries: 2, portageM: 476,  lakes: 15 }],
  ];

  for (const [a, b, mode, want] of GOLDEN) {
    test(`${a} -> ${b} [${mode}] is stable`, () => {
      const r = plan(a, b, mode);
      assert.equal(r.carries, want.carries, 'carries changed');
      assert.equal(r.portageM, want.portageM, 'carrying metres changed');
      assert.equal(r.lakes, want.lakes, 'lakes crossed changed');
    });
  }

  test('fewest-carries minimises carry count', () => {
    for (const [a, b] of [['Access Point #5: Canoe Lake', 'Booth Lake'],
                          ['Canoe Lake', 'Lake Opeongo'],
                          ['Petawawa River', 'Lake Opeongo']]) {
      const few = plan(a, b, 'carries');
      for (const m of ['balanced', 'easiest', 'meters']) {
        assert.ok(few.carries <= plan(a, b, m).carries,
          `${a}->${b}: carries=${few.carries} lost to ${m}`);
      }
    }
  });

  // This one was wrong: "meters" charged paddling at full weight, so it
  // minimised total route distance and preferred walking 1,116 m over 846 m.
  test('least-carrying minimises the metres you walk', () => {
    for (const [a, b] of [['Access Point #5: Canoe Lake', 'Booth Lake'],
                          ['Canoe Lake', 'Lake Opeongo'],
                          ['Petawawa River', 'Lake Opeongo']]) {
      const least = plan(a, b, 'meters');
      for (const m of ['balanced', 'easiest', 'carries']) {
        assert.ok(least.portageM <= plan(a, b, m).portageM,
          `${a}->${b} [${m}]: walks ${plan(a, b, m).portageM}m, less than meters=${least.portageM}m`);
      }
    }
  });

  test('all four modes return different routes', () => {
    const sig = m => plan('Access Point #5: Canoe Lake', 'Booth Lake', m).nodeIds.join(',');
    const all = ['balanced', 'easiest', 'carries', 'meters'].map(sig);
    assert.equal(new Set(all).size, 4, 'two cost models produced the same path');
  });

  test('a route starts and ends where asked', () => {
    for (const [a, b] of [['Canoe Lake', 'Lake Opeongo'],
                          ['Petawawa River', 'Booth Lake']]) {
      const r = plan(a, b, 'balanced');
      assert.equal(r.nodeIds[0], idOf(a));
      assert.equal(r.nodeIds[r.nodeIds.length - 1], idOf(b));
    }
  });

  test('every leg has usable geometry inside the park', () => {
    const r = plan('Access Point #5: Canoe Lake', 'Booth Lake', 'balanced');
    for (const e of r.legs) {
      assert.ok(Array.isArray(e.g) && e.g.length >= 2, `leg ${e.k} has no geometry`);
      assert.ok(Number.isFinite(e.m) && e.m >= 0, `leg ${e.k} length ${e.m}`);
      for (const p of e.g) {
        assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]), 'bad coordinate');
        assert.ok(p[0] > -80 && p[0] < -77 && p[1] > 45 && p[1] < 46.5,
          `coordinate outside the park: ${p}`);
      }
    }
  });

  test('a route is contiguous', () => {
    const r = plan('Access Point #5: Canoe Lake', 'Booth Lake', 'balanced');
    for (let i = 1; i < r.nodeIds.length; i++) {
      assert.equal(r.legs[i - 1].d, r.nodeIds[i], `leg ${i} does not end at node ${i}`);
      assert.equal(r.legs[i - 1].s, r.nodeIds[i - 1], `leg ${i} does not start at node ${i - 1}`);
    }
  });

  test('carrying distance equals the sum of the carry legs', () => {
    const r = plan('Access Point #5: Canoe Lake', 'Booth Lake', 'balanced');
    const sum = r.legs.filter(e => e.k === 'portage').reduce((s, e) => s + e.m, 0);
    assert.equal(r.portageM, sum);
  });

  test('intermediate stops are visited, in order', () => {
    const stops = ['Otterslide Lake', 'Lake Opeongo'];
    const r = Router.chainRoutes(data, idx,
      ['Access Point #5: Canoe Lake', ...stops, 'Booth Lake'].map(idOf),
      'balanced', false, 1)[0].res;
    const at = stops.map(s => r.nodeIds.indexOf(idOf(s)));
    for (const i of at) assert.ok(i >= 0, 'a stop was not on the route');
    assert.ok(at[0] < at[1], 'stops were visited out of order');
  });

  test('forcing a stop cannot make the trip cheaper', () => {
    const direct = plan('Access Point #5: Canoe Lake', 'Booth Lake', 'carries');
    const via = Router.chainRoutes(data, idx,
      ['Access Point #5: Canoe Lake', 'Lake Opeongo', 'Booth Lake'].map(idOf),
      'carries', false, 1)[0].res;
    assert.ok(via.portageM >= direct.portageM - 1);
  });

  test('unknown endpoints are reported, not crashed on', () => {
    for (const bad of ['Nowhere Lake', '', 'zzz']) {
      assert.doesNotThrow(() => Router.chainRoutes(data, idx,
        [idOf(bad) || -1, idOf('Booth Lake')], 'balanced', false, 1));
    }
  });

  // 5,098 river hazard rows used to be discarded, so this toggle was inert.
  test('avoiding flagged obstacles changes the route', () => {
    const off = plan('Petawawa River', 'Lake Opeongo', 'balanced');
    const on = Router.chainRoutes(data, idx, ['Petawawa River', 'Lake Opeongo'].map(idOf),
                                  'balanced', true, 1)[0].res;
    assert.notDeepEqual(on.nodeIds, off.nodeIds,
      'avoiding hazards changed nothing - obstacles are not attached to river links');
  });

  test('the avoided route carries no flagged legs', () => {
    const r = Router.chainRoutes(data, idx, ['Petawawa River', 'Lake Opeongo'].map(idOf),
                                 'balanced', true, 1)[0].res;
    for (const e of r.legs) {
      assert.ok(!e.o || !e.o.length, `avoided route still uses a flagged ${e.k} leg`);
    }
  });

  test('hazards reach the edges the UI reads', () => {
    const flagged = data.edges.filter(e => e.o && e.o.length);
    assert.ok(flagged.length > 100, 'almost nothing is flagged');
    const types = new Set(flagged.flatMap(e => e.o));
    assert.ok(types.has('rapids') || types.has('waterfall') || types.has('dam'));
  });

  test('chainRoutes offers distinct alternatives', () => {
    const opts = Router.chainRoutes(data, idx,
      ['Access Point #5: Canoe Lake', 'Booth Lake'].map(idOf), 'balanced', false, 3);
    assert.ok(opts.length >= 2, 'expected more than one option');
    const sigs = new Set(opts.map(o => o.res.nodeIds.join(',')));
    assert.equal(sigs.size, opts.length, 'two options were the same route');
  });

  test('the chosen mode is always offered first', () => {
    for (const m of ['easiest', 'carries', 'meters', 'balanced']) {
      const opts = Router.chainRoutes(data, idx,
        ['Access Point #5: Canoe Lake', 'Booth Lake'].map(idOf), m, false, 3);
      assert.equal(opts[0].mode, m, `${m} was not returned first`);
    }
  });
});
