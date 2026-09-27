# Algonquin Planner — roadmap

Built (see git history): balanced routing model (lake-crossing weight), portage
elevation gain/loss + uphill arrows, Hwy 60 layer, lake hover tooltips, sample
routes, shareable-URL routing, mobile bottom-sheet sidebar, campsites layer,
nightly OSM refresh action.

## Remaining ideas, by value

### High value
- **Campsite-aware multi-day planning** — auto-split a route into days:
  night N must have a campsite on-route; cap paddling+carrying per day;
  generate a day-by-day itinerary. (Campsites layer ships first; this builds on it.)
- **Cumulative-climb routing penalty** — fold the per-portage climb data into the
  balanced cost (steep carries cost more than flat ones of equal length).
- **Loop routes** — start = end with a distance/hour budget; "day-trip radius"
  mode from any access point.
- **Offline PWA** — service worker + cached payload; the park has no signal, the
  map is most useful exactly there.

### Model accuracy
- DEM is 90 m and sampled coarsely; re-sample portage trails at higher density
  when Open-Meteo raises limits, and clip DEM noise harder on short trails.
- Portage CONDITION data (rooted/overgrown/wet) isn't in OSM — scrape the
  official portage tables when available and weight routes by condition.
- Reach stitching currently unions any ways sharing a node id — a mis-stitched
  reach can bridge unrelated waters; add a length sanity cap per stitch.
- Way-split lakes: same-name channel hops are free in routing but the drawn
  path still cuts across way boundaries; snap the drawn chain to the union.

### UX polish
- Elevation sparkline per carry in the directions list.
- Slider exposing the lake-crossing weight (currently a 300 m-carry equivalent).
- Portage-length cap preset ("no carry over 800 m").
- Quiet-routes mode (avoid motor-tagged lakes/waterways).
- Outfitter/rental layer (data already in amenities fetch).
- Printable/PDF itinerary (waterproof printout for the canoe).
- Per-leg time estimates (paddle ~4 km/h, carry ~3 km/h + pack time).
- Keyboard navigation for the autocomplete; ←/→ to move between steps.

### Ops
- Nightly action currently refetches everything (raw/ is gitignored); move the
  raw cache to a GitHub Release artifact orActions cache to cut Overpass load.
- Node-side unit tests for the router (golden routes per cost model) so
  routing refactors get a safety net.
- Error tracking (Sentry or similar) for the client app.
