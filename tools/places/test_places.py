"""Checks on the /map/ page's coordinate data.

Run: python3 tools/places/test_places.py
or:  python3 -m unittest discover -s tools/places -p "test_*.py"

A post with no coordinate is invisible on the map, and nothing else in the
build would notice. These assert that every published post is either pinned
or deliberately unpinned, and that the pins are in the right hemisphere.
"""
import csv
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
POSTS = ROOT / "content" / "posts"
CSV_PATH = ROOT / "tools" / "places" / "places.csv"
JSON_PATH = ROOT / "data" / "places.json"

# Posts that are knowingly not on the map, with a reason. Adding a post here
# is a deliberate act, not a way to make the test pass quietly.
EXCLUDED = {}


def published_slugs():
    return sorted(p.parent.name for p in POSTS.glob("*/index.md") if p.is_file())


class TestPlacesData(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.slugs = published_slugs()
        cls.rows = {r["slug"]: r for r in csv.DictReader(open(CSV_PATH, newline=""))} \
            if CSV_PATH.exists() else {}
        cls.pins = json.loads(JSON_PATH.read_text()) if JSON_PATH.exists() else []

    def test_there_are_posts(self):
        self.assertGreater(len(self.slugs), 0, "no posts found — path wrong?")

    def test_every_post_is_pinned_or_excluded(self):
        unpinned = [s for s in self.slugs
                    if not self.rows.get(s, {}).get("lat") and s not in EXCLUDED]
        self.assertEqual(unpinned, [],
                         f"{len(unpinned)} post(s) would be missing from the map: "
                         f"{unpinned}. Add a row to tools/places/places.csv "
                         f"(python3 tools/places/geocoder.py), or list it in EXCLUDED "
                         f"with a reason.")

    def test_no_extraneous_rows(self):
        stray = [s for s in self.rows if s not in self.slugs]
        self.assertEqual(stray, [], f"places.csv has rows for posts that do not exist: {stray}")

    def test_coordinates_in_range(self):
        for r in self.rows.values():
            if not r.get("lat"):
                continue
            lat, lng = float(r["lat"]), float(r["lng"])
            self.assertTrue(-90 <= lat <= 90, f"{r['slug']}: lat {lat}")
            self.assertTrue(-180 <= lng <= 180, f"{r['slug']}: lng {lng}")

    def test_no_null_island(self):
        """(0, 0) is the classic geocoding failure and renders in the Atlantic."""
        for r in self.rows.values():
            if not r.get("lat"):
                continue
            if float(r["lat"]) == 0 and float(r["lng"]) == 0:
                self.fail(f"{r['slug']} is pinned at 0,0 — geocoding failed")

    def test_json_matches_csv(self):
        """Hugo reads the JSON, not the CSV; a stale JSON means a stale map."""
        self.assertTrue(self.pins, "data/places.json is empty")
        csv_pinned = {s for s, r in self.rows.items() if r.get("lat")}
        json_pinned = {p["slug"] for p in self.pins}
        self.assertEqual(json_pinned, csv_pinned,
                         "data/places.json is out of step with places.csv — "
                         "re-run python3 tools/places/geocoder.py")
        by_slug = {p["slug"]: p for p in self.pins}
        for s in csv_pinned:
            self.assertAlmostEqual(float(self.rows[s]["lat"]), by_slug[s]["lat"], places=4)
            self.assertAlmostEqual(float(self.rows[s]["lng"]), by_slug[s]["lng"], places=4)

    def test_fields_have_no_commas(self):
        """A comma in a CSV field tripped Hugo's data loader."""
        for r in self.rows.values():
            for k, v in r.items():
                if v:
                    self.assertNotIn(",", v, f"{r['slug']}: {k} contains a comma")


if __name__ == "__main__":
    unittest.main()
