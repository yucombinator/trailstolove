# hikewithyu.com

A Hugo blog about backpacking, plus one thing on it that is not a blog post:
an interactive **canoe route planner for Algonquin Provincial Park**.

Three loosely-related things live in this repository, and each has its own
documentation:

| | what it is | documented in |
|---|---|---|
| **The blog** | trail reports — mostly the Pacific Northwest and Ontario | below |
| **The post editor** | a local markdown editor with a live Hugo preview | [below](#the-post-editor) |
| **The Algonquin Planner** | a client-side canoe route planner over ~7,000 water bodies and 600+ portages | [`tools/algonquin-graph/README.md`](tools/algonquin-graph/README.md) |

The blog's own map page (`/map/`, every trip pinned on one Leaflet map) has a
third: [`tools/places/README.md`](tools/places/README.md).

---

## Requirements

- [Hugo](https://gohugo.io) **extended** — the theme's pipeline needs it
- [Node.js](https://nodejs.org) 18+ — Tailwind build and the editor
- Python 3.12+ — **only** for the planner's data pipeline, and only if you are
  changing map data. Nothing in the blog build needs it.

## Running it locally

```sh
npm install     # one-time
npm run build   # tailwind + hugo --minify  ->  public/
npm run start   # tailwind --watch + hugo server
```

`hugo server` listens on **1313** by default.

> **Gotcha:** the editor's Vite proxy expects Hugo on **1414**
> (`vite.config.ts`), not 1313. For the live-preview pane to work, run
> `npx hugo server --port 1414` alongside `npm run editor`, or amend the proxy
> target. This mismatch is pre-existing and has bitten the preview pane more
> than once.

---

## The blog

Standard Hugo: `content/` + `themes/hugo-atlantic/` + overrides in
`layouts/`, with `config.toml` holding permalinks, taxonomies and the menu.

### Writing a post

Each post is a page bundle at `content/posts/YYYY-MM-DD-<slug>/index.md`. Copy
the front matter of the newest post —
`content/posts/2026-09-11-three-days-in-algonquin/` is the current template.
Categories are `activity` + `province`, and the `stats` block drives the
listing card.

A post is **published unless its front matter says `draft: true`**.

### Pinning a post to the map

Every trip also gets a pin on `/map/`. Add a row to
`tools/places/places.csv` (hand-edited and hand-checked) and run
`python3 tools/places/test_places.py`, which fails if a published post has
neither a coordinate nor a deliberate exclusion. A missing pin beats a pin in
the wrong country. Details in [`tools/places/README.md`](tools/places/README.md).

### Things that bite

- The `/map/` page is a client-rendered Leaflet map whose coordinates come from
  a CSV, not from the post's front matter.
- Basemaps: OpenTopoMap, faded with a CSS filter. CARTO needs an API key and
  serves a watermark tile without one.
- Do not hand-edit `public/`; it is gitignored and rebuilt on every deploy.

---

## The Algonquin Planner

A full-screen canoe route planner: pick any named lake, portage landing or one
of the 29 official access points, and it routes you across the park under four
cost models — balanced, easiest portages, fewest portages, or least total
portaging — drawing every carry, its length, its climb and an elevation
profile.

It ships as three files that must agree, and its ~18,000-edge graph is rebuilt
from OpenStreetMap by a pipeline that runs twice a day:

```
content/algonquin/
  app.html          the page (built from tools/algonquin-graph/router_template.html)
  router.js         the router — source, hand-edited
  router_data.json  12.5 MB payload — a build product, never hand-edited
```

**Read [`tools/algonquin-graph/README.md`](tools/algonquin-graph/README.md)
before touching any of it.** It covers the data model, the pipeline, how to run
it locally, and the vocabulary this project uses.

---

## The data-refresh workflows

Three GitHub Actions jobs. **They are the main operational risk in this repo,
and each one's behaviour is deliberate** — see
[`tools/algonquin-graph/README.md`](tools/algonquin-graph/README.md#the-refresh-jobs)
for what each one learned the hard way.

| workflow | triggers | what it does |
|---|---|---|
| `pages.yml` | every push to `master` | builds the site, runs the editor API contract test (can block a deploy), publishes to GitHub Pages. Cancels any in-flight deploy. |
| `refresh-advisories.yml` | 06:20 / 18:20 UTC | scrapes the current Algonquin park advisories, checks they are actually fresh, commits `data/conditions.csv`. **The safety-relevant half of the planner, and deliberately the small, fast, reliable one** — conditions a paddler needs must still update when the graph job is having a bad day. |
| `refresh-graph.yml` | 07:50 / 19:50 UTC, or a push touching it or the pipeline | fetches OSM, rebuilds and checks the graph payload, deploys it into `content/algonquin/`, commits. 90 minutes behind the advisories job so the two never race each other to `git push`. A run in flight is never cancelled, because cancelling throws away the fetch. |

A note on the cron schedules: they have been observed running **hours late**
(the 06:20 job fired at 14:07). Treat the timings as "twice a day", not as
clock times.

---

## The post editor

A local, keyboard-driven markdown editor for this Hugo blog. Draft posts in a
proper UI instead of your IDE: pick a post, edit the markdown with syntax
highlighting, manage front matter with a form, drop in photos, and watch the
real Hugo-rendered preview update beside your writing.

```sh
npm run editor   # terminal 2: Vite UI (1415) + Express API (1416)
```

Hugo must be running on 1414 for the live preview pane to work — see the
gotcha above.

**Layout** — post list on the left, markdown editor front and center, Hugo
preview on the right (toggle it with the `Preview` button). `Details` opens a
slide-over drawer with the post's front matter; close with `Esc`.

- **Editing** — the center pane is Monaco (same engine as VS Code), markdown
  language, word wrap on. **⌘S / Ctrl+S saves**; a pulsing `unsaved` pill shows
  pending changes, and closing the tab with unsaved work is blocked.
- **Front matter** — edit title, meta title, description, trip stats
  (where/distance/elevation/dates), categories, tags, thumbnail, hero image,
  and the draft toggle in the Details drawer. Any front-matter keys you don't
  touch are preserved verbatim on save (including YAML order).
- **Photos** — drag images from Finder anywhere onto the editor pane, or use
  `Upload photos`. Files are written into the post's page bundle next to
  `index.md` and immediately inserted at the cursor:
  - 1 photo → `![caption](file.jpg)`
  - 2 photos → `{{< side-by-side "a.jpg" "b.jpg" "cap 1" "cap 2" >}}` (captions
    prompted, prefilled from the filename)
  - 3+ photos → successive side-by-side pairs, trailing single as plain image

  Uploaded photos also appear as chips below the editor — click to insert.
- **Preview** — renders the actual Hugo page (shortcodes, theme CSS, stats
  box), not an approximation. Assets are proxied so images and styling are
  exact. Lazy-loaded images are forced eager so nothing below the fold shows
  blank. `📱 phone` frames the preview at 375px to check mobile rendering.
- **Publish toggle** — hover a post in the sidebar and click its status dot
  (amber = draft, gray = published) to flip it without opening the post.
- **Word count** — live `N words · ~M min read` in the toolbar.
- **Dark mode** — 🌙/☀️ toggle in the sidebar header. Persists across
  sessions; first visit follows your OS preference. The preview inverts to a
  matching dark theme (photos keep their true colors).

### Development

```sh
npm test                    # vitest — API roundtrip, front matter, permalinks
npx tsc --noEmit -p .       # type check
```

```
server/          Express API (Express 5, port 1416)
  app.ts         routes: GET posts, GET/PUT post, PATCH draft, POST photo
  frontmatter.ts YAML parse/serialize preserving key order
editor/          React + Vite UI (port 1415)
  Editor.tsx     the whole editor UI
  api.ts         typed fetch client
layouts/partials/blog/post-row.html
                 nil-safe thumbnail override of the theme partial
vite.config.ts   dev server config + proxy rules (api + hugo assets)
```

The API only ever writes inside `content/posts/**` (slug validation +
path-traversal guard) and only accepts image uploads (`jpg/jpeg/png/gif/webp/avif`,
30 MB max). It binds to `127.0.0.1` only — there is no auth by design; don't
expose it.

### Gotchas

- The preview needs `hugo server` running on 1414. Saving refreshes the preview
  after ~1.5s to let Hugo's fast-render rebuild land.
- The editor's Vite dev server ignores `public/**` and `content/**` in its
  watcher — Hugo rewrites `public/` on every save, and without the ignore rule
  the editor would reload (losing state) on each save.
- Sidebar post permalinks in the preview are derived with the same URL
  algorithm Hugo uses (`blog/:year/:month/:title/`), verified against every
  published post; if you change `[permalinks]` in `config.toml`, update
  `permalinkOf()` in `server/app.ts`.
