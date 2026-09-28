# Places map

`/places/` pins every trip on the site to a map above the post archive. This
directory owns the coordinates.

## Files

| File | Role |
|---|---|
| `geocoder.py` | Fills in `places.csv` from the `where` in each post's front matter. Run by hand. |
| `places.csv` | **The file you edit.** One row per post, hand-correctable. |
| `test_places.py` | Fails the build if a published post is unpinned. |
| `../../data/places.json` | Derived from the CSV for Hugo. Do not edit. |

## Why the CSV is not in `data/`

Hugo 0.150 refuses to load CSV from its data directory — `unexpected data
type [][]string`, reproducible with a two-line `a,b / 1,2` file. JSON loads
fine, so the build reads `data/places.json` and the CSV stays here where it
is a tool input rather than build data. `test_json_matches_csv` fails if the
two drift.

## Adding a post to the map

Run the geocoder once after publishing a new post:

```bash
python3 tools/places/geocoder.py
```

It fills in only the missing rows. To redo everything, `--force`. To check
without touching the network, `--check`.

Then **spot-check the new row.** The geocoder is a guess, and it has been
wrong: `Grand Tetons National Park` once resolved to a mountain in New
Caledonia. It now rejects any result whose display name shares no meaningful
word with the query, which caught that one, but a park centroid is still
only as good as the geocoder.

## Trailheads

Some posts are not anchored to a trailhead. Lake O'Hara is a bus reservation
to a lakeside destination, and several are hut-to-hut traverses. For those,
the park centroid is the honest answer.

For the ones that *are* trailhead trips, add to the post's front matter:

```yaml
trailhead: "Boulder River Trailhead"
```

It takes priority over `where`, and you can also skip the geocoder entirely
by giving the post its own coordinates:

```yaml
coords: [47.8931, -121.7345]
```

Both are honoured by `layouts/partials/places/pins.html`, so a hand-placed
pin never gets overwritten by a later geocoder run.

## Deliberate exclusions

A post you do not want on the map goes in `EXCLUDED` in `test_places.py`,
with a reason. It is meant to be a deliberate act, not a way to make the
test pass quietly.

## Basemap

OpenTopoMap, not CARTO. CARTO serves an `API KEY REQUIRED` watermark across
every tile without a key. If you ever want a different basemap, that
attribution line in `layouts/_default/places.html` is the only thing to
change.

## Known rough edge

The default view is fitted to all pins, so the Kepler Track in New Zealand
pulls the Pacific Northwest cluster into a mostly-ocean world map. It is
truthful but not pretty, and is a visual call rather than a bug.
