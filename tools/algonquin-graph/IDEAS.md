# Algonquin Planner — roadmap

Built (see git history): balanced routing model (lake-crossing weight), portage
elevation gain/loss + uphill arrows, carry difficulty ratings derived from the
DEM, an "easiest carries" model that weights climb, per-carry elevation
sparklines, Hwy 60 layer, campsites layer, park boundary, lake hover tooltips,
sample routes, shareable-URL routing, mobile bottom-sheet sidebar, and a
twice-daily OSM + park-conditions refresh action.

## Remaining ideas, by value

### High value
- **Campsite-aware multi-day planning** — auto-split a route into days:
  night N must have a campsite on-route; cap paddling+carrying per day;
  generate a day-by-day itinerary. (Campsites layer ships first; this builds on it.)
- ~~**Cumulative-climb routing penalty**~~ — shipped: the balanced model charges
  `carryEffort(e, 3)` and the dedicated "easiest" model `carryEffort(e, 10)`.
- **Loop routes** — start = end with a distance/hour budget; "day-trip radius"
  mode from any access point.
- **Offline PWA** — service worker + cached payload; the park has no signal, the
  map is most useful exactly there.

### Model accuracy
- DEM is 90 m and sampled coarsely; re-sample portage trails at higher density
  and clip DEM noise harder on short trails. (Elevations now come from
  OpenTopoData's SRTM90m endpoint, not Open-Meteo.)
- Portage CONDITION data (rooted/overgrown/wet) isn't in OSM. The park's portage
  signage page is cached, but only ever yields a park-wide standing row; per-
  portage condition rows would need real parsing of that page.
- Reach stitching currently unions any ways sharing a node id — a mis-stitched
  reach can bridge unrelated waters; add a length sanity cap per stitch.
- Way-split lakes: same-name channel hops are already free in routing and folded
  in the itinerary, and drawn crossings run a visibility graph constrained to the
  lake polygon with shoreline snapping. Worth re-checking whether any drawn chain
  still cuts across a way boundary.

### UX polish
- ~~**Elevation sparkline per carry**~~ — shipped: `profileSVG()` renders it on
  every carry leg.
- Slider exposing the lake-crossing weight (currently a 300 m-carry equivalent).
- Portage-length cap preset ("no carry over 800 m").
- Quiet-routes mode (avoid motor-tagged lakes/waterways).
- Outfitter/rental layer (data already in amenities fetch).
- Printable/PDF itinerary (waterproof printout for the canoe).
- Per-leg time estimates (paddle ~4 km/h, carry ~3 km/h + pack time).
- Keyboard navigation for the autocomplete; ←/→ to move between steps.

### Ops
- ~~**Raw cache on the Actions cache**~~ — shipped: `refresh-planner.yml` caches
  `tools/algonquin-graph/raw` and `fetch_osm.py` age-gates every group, so a
  twice-daily run fetches ~24 tiles instead of ~100.
- Node-side unit tests for the router (golden routes per cost model) so
  routing refactors get a safety net.
- Error tracking (Sentry or similar) for the client app.
