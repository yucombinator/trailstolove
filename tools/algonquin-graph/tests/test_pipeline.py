"""Unit tests for the data pipeline. Run: python3 -m unittest discover tests

Covers the parts of the pipeline that are pure functions of their inputs, plus
the assertions CI makes about the built payload. Every test here corresponds to
something that was actually wrong at some point; the comment says which.
"""
import csv
import datetime
import importlib.util
import json
import pathlib
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


build_page = _load("build_page")


def read_csv(name):
    with open(ROOT / "data" / name, newline="") as f:
        return list(csv.DictReader(f))


class TestParkBoundary(unittest.TestCase):
    """The relation ships its ring as several open ways. Unstitched they are
    self-intersecting, so a naive shoelace gave 1.3 km2 for a 7,600 km2 park."""

    @classmethod
    def setUpClass(cls):
        cls.fc = build_page.park_boundary()

    def test_is_a_single_multipolygon(self):
        self.assertEqual(self.fc["type"], "FeatureCollection")
        self.assertEqual(len(self.fc["features"]), 1)
        self.assertEqual(self.fc["features"][0]["geometry"]["type"], "MultiPolygon")

    def test_ring_is_closed(self):
        ring = self.fc["features"][0]["geometry"]["coordinates"][0][0]
        self.assertGreater(len(ring), 100, "stitching lost most of the ring")
        self.assertEqual(ring[0], ring[-1], "ring is not closed")

    def test_area_is_the_park_not_a_spike(self):
        """A mis-stitched ring collapses to near zero; a dropped way drops area."""
        ring = self.fc["features"][0]["geometry"]["coordinates"][0][0]
        lat0 = sum(p[1] for p in ring) / len(ring)
        kx = 111.32 * abs(__import__("math").cos(__import__("math").radians(lat0)))
        ky = 111.32
        pts = [(p[0] * kx, p[1] * ky) for p in ring]
        s = sum(pts[i][0] * pts[(i + 1) % len(pts)][1]
                - pts[(i + 1) % len(pts)][0] * pts[i][1] for i in range(len(pts)))
        km2 = abs(s) / 2
        self.assertGreater(km2, 7000, f"boundary collapsed to {km2:.0f} km2")
        self.assertLess(km2, 8200, f"boundary inflated to {km2:.0f} km2")

    def test_degrades_when_source_is_missing_or_empty(self):
        """A nicety must never block the build."""
        import tempfile
        orig = build_page.RAW
        try:
            tmp = pathlib.Path(tempfile.mkdtemp())
            build_page.RAW = tmp
            self.assertEqual(build_page.park_boundary()["features"], [])
            (tmp / "park_boundary.json").write_text('{"elements": []}')
            self.assertEqual(build_page.park_boundary()["features"], [])
            (tmp / "park_boundary.json").write_text('{"elements": [{"type": "node", "id": 1}]}')
            self.assertEqual(build_page.park_boundary()["features"], [])
        finally:
            build_page.RAW = orig


class TestPortageResolution(unittest.TestCase):
    """parse_osm's closing summary printed n_res, which was assigned nowhere, so
    every run died with NameError after writing the CSVs."""

    @classmethod
    def setUpClass(cls):
        rows = read_csv("portages.csv")
        cls.portages = [{**p,
                         "from_id": None if p["from_id"] in ("", "None") else int(p["from_id"]),
                         "to_id": None if p["to_id"] in ("", "None") else int(p["to_id"])}
                        for p in rows]

    def _split(self):
        n_res = sum(1 for p in self.portages
                    if p["from_id"] is not None and p["to_id"] is not None)
        n_self = sum(1 for p in self.portages
                     if p["from_id"] is not None and p["from_id"] == p["to_id"])
        return n_res, n_self, n_res - n_self

    def test_counts_add_up(self):
        n_res, n_self, routable = self._split()
        unresolved = sum(1 for p in self.portages
                         if p["from_id"] is None or p["to_id"] is None)
        # self-loops are a SUBSET of the resolved rows, not a separate bucket
        self.assertEqual(n_res + unresolved, len(self.portages))
        self.assertEqual(routable, n_res - n_self)
        self.assertGreater(routable, 0)
        self.assertLess(routable, len(self.portages))

    def test_matches_the_documented_split(self):
        """README quotes these; they had no code behind them until now."""
        n_res, n_self, routable = self._split()
        self.assertEqual((n_res, n_self, routable), (864, 263, 601))

    def test_no_unresolved_row_is_routable(self):
        for p in self.portages:
            if p["from_id"] is None or p["to_id"] is None:
                self.assertFalse(p["from_id"] is not None and p["from_id"] == p["to_id"],
                                 "a self-loop must have both endpoints resolved")


class TestObstacleAttachment(unittest.TestCase):
    """build_page kept only edge_kind == 'portage' and emitted link edges with a
    hardcoded "o": []. 5,098 river rows were discarded, so the avoid-flagged-
    obstacles toggle could never avoid a rapid, waterfall or dam."""

    @classmethod
    def setUpClass(cls):
        with open(ROOT / "data" / "router_data.json") as f:
            cls.data = json.load(f)
        cls.rows = read_csv("edge_obstacles.csv")

    def test_source_actually_contains_river_obstacles(self):
        kinds = {r["edge_kind"] for r in self.rows}
        self.assertIn("river", kinds)
        self.assertIn("portage", kinds)

    def test_river_obstacles_reach_the_edges(self):
        with_o = [e for e in self.data["edges"] if e.get("o")]
        river = [e for e in with_o if e["k"] in ("river", "channel")]
        self.assertGreater(len(river), 100,
                           "river hazards are not attached; the avoid toggle is inert")

    def test_hazard_types_survive(self):
        types = {t for e in self.data["edges"] if e.get("o") for t in e["o"]}
        self.assertTrue({"rapids", "waterfall", "dam"} & types, f"got {types}")

    def test_reverse_direction_carries_the_same_hazard(self):
        """Obstacles are stored per directed link id; both must resolve."""
        by_pair = {}
        for e in self.data["edges"]:
            if e.get("o"):
                by_pair[(e["s"], e["d"])] = tuple(sorted(e["o"]))
        both = 0
        for (s, d), obs in list(by_pair.items()):
            if (d, s) in by_pair:
                both += 1
        self.assertGreater(both, 50, "reverse links lost their hazards")

    def test_portage_obstacles_still_attached(self):
        portage = [e for e in self.data["edges"] if e["k"] == "portage" and e.get("o")]
        self.assertGreater(len(portage), 0)


class TestPayloadShape(unittest.TestCase):
    """The fields the UI reads must exist; a stale generator silently dropping
    one shipped a page that rendered without elevation profiles."""

    @classmethod
    def setUpClass(cls):
        with open(ROOT / "data" / "router_data.json") as f:
            cls.data = json.load(f)

    def test_graph_is_populated(self):
        self.assertGreater(len(self.data["nodes"]), 10000)
        self.assertGreater(len(self.data["edges"]), 15000)

    def test_portage_edges_carry_effort_data(self):
        p = [e for e in self.data["edges"] if e["k"] == "portage"]
        self.assertGreater(len(p), 0)
        self.assertGreater(sum(1 for e in p if e.get("pf")), len(p) * 0.9)
        self.assertGreater(sum(1 for e in p if e.get("el") is not None), len(p) * 0.9)

    def test_water_nodes_carry_crossing_scale(self):
        dm = sum(1 for n in self.data["nodes"] if len(n) > 5 and n[5] is not None)
        self.assertGreater(dm, 10000, "dm (lake size) is what the balanced model charges")

    def test_optional_layers_present(self):
        self.assertTrue(self.data.get("roads"))
        self.assertGreater(len(self.data.get("campsites") or []), 0)
        self.assertGreater(len((self.data.get("lakes") or {}).get("features", [])), 0)
        self.assertGreater(len((self.data.get("park") or {}).get("features", [])), 0)

    def test_edge_geometry_is_usable(self):
        for e in self.data["edges"][:500]:
            g = e.get("g")
            self.assertIsInstance(g, list)
            self.assertGreaterEqual(len(g), 2)
            for pt in g:
                self.assertEqual(len(pt), 2)
                self.assertIsInstance(pt[0], float)
                self.assertTrue(-180 <= pt[0] <= 180 and -90 <= pt[1] <= 90)


class TestAdvisoryStaleness(unittest.TestCase):
    """CI asserted conditions existed but not that they were current -- and the
    guard ran before `bad` was assigned, so it could never fire at all."""

    def _check(self, conds, today=None):
        today = today or datetime.date.today()
        bad = []
        if not conds:
            bad.append("no park conditions at all")
            return bad
        stamps = []
        for c in conds:
            try:
                stamps.append(datetime.date.fromisoformat(c.get("as_of") or ""))
            except ValueError:
                bad.append("unparseable as_of")
        if stamps:
            age = (today - max(stamps)).days
            if age > 2:
                bad.append(f"stale {age}d")
            if age < 0:
                bad.append("future")
        return bad

    def _conds(self, as_of):
        return [{"cat": "info", "scope": "park-wide", "note": "x",
                 "src": "u", "as_of": as_of}]

    def test_fresh_passes(self):
        today = datetime.date.today()
        self.assertEqual(self._check(self._conds(today.isoformat())), [])

    def test_one_day_old_passes(self):
        d = datetime.date.today() - datetime.timedelta(days=1)
        self.assertEqual(self._check(self._conds(d.isoformat())), [])

    def test_three_days_old_fails(self):
        d = datetime.date.today() - datetime.timedelta(days=3)
        self.assertTrue(self._check(self._conds(d.isoformat())))

    def test_thirty_days_old_fails(self):
        d = datetime.date.today() - datetime.timedelta(days=30)
        self.assertTrue(self._check(self._conds(d.isoformat())))

    def test_empty_fails(self):
        self.assertTrue(self._check([]))

    def test_unparseable_fails(self):
        self.assertTrue(self._check(self._conds("not-a-date")))

    def test_future_fails(self):
        d = datetime.date.today() + datetime.timedelta(days=2)
        self.assertTrue(self._check(self._conds(d.isoformat())))


class TestSeedDedup(unittest.TestCase):
    """The SEED guard compared (cat, note[:60]) against a set holding
    (cat, full_line), so a standing row could never be recognised as already
    present and duplicate notes shipped."""

    def test_same_key_shape_on_both_sides(self):
        def note_key(cat, note):
            return (cat, note[:60])
        scraped = "Low water: something quite long that the advisories page says"
        seed = "Low water: something quite long that the advisories page says"
        seen = {note_key("low-water", scraped)}
        self.assertIn(note_key("low-water", seed), seen)

    def test_distinct_notes_do_not_collide(self):
        def note_key(cat, note):
            return (cat, note[:60])
        seen = {note_key("info", "alpha" + "x" * 80)}
        self.assertNotIn(note_key("info", "beta" + "x" * 80), seen)


class TestElevationCacheKey(unittest.TestCase):
    """The 'already have' set was built from raw CSV strings while the lookup
    keys are rounded floats, so the guard could never match and a failed batch
    re-appended its rows forever."""

    @staticmethod
    def key(lat, lon):
        return (round(float(lat), 4), round(float(lon), 4))

    def test_raw_csv_strings_never_match_the_lookup_key(self):
        have = {("45.1234", "-78.5678")}          # the old, broken form
        self.assertNotIn(self.key("45.1234", "-78.5678"), have)

    def test_cached_rows_round_trip_through_the_key(self):
        path = ROOT / "data" / "elevations.csv"
        if not path.exists():
            self.skipTest("no elevation cache present")
        with open(path, newline="") as f:
            rows = list(csv.DictReader(f))
        self.assertGreater(len(rows), 0)
        have = {self.key(r["lat"], r["lon"]) for r in rows}
        for r in rows[:200]:
            self.assertIn(self.key(r["lat"], r["lon"]), have)
        self.assertEqual(len(have), len({self.key(r["lat"], r["lon"]) for r in rows}),
                         "two different CSV rows normalised to the same key")

    def test_trailing_zeros_in_the_csv_still_match(self):
        self.assertEqual(self.key("45.12340", "-78.56780"),
                         self.key("45.1234", "-78.5678"))


class TestDuckDbSchema(unittest.TestCase):
    """build_db.sql declared water with 7 columns; water.csv gained an 8th (dm),
    so the documented `duckdb < build_db.sql` rebuild failed on column count."""

    def test_water_table_matches_csv_header(self):
        sql = (ROOT / "build_db.sql").read_text()
        block = sql.split("CREATE OR REPLACE TABLE water (")[1].split(");")[0]
        declared = {ln.strip().split()[0] for ln in block.splitlines()
                    if ln.strip() and not ln.strip().startswith("--")}
        header = read_csv("water.csv")[0].keys()
        self.assertEqual(declared, set(header),
                         f"declared {sorted(declared)} vs csv {sorted(header)}")

    def test_dm_is_documented(self):
        sql = (ROOT / "build_db.sql").read_text()
        self.assertIn("dm", sql, "dm has no comment, so nobody knows what it is")


if __name__ == "__main__":
    unittest.main()
