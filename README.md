# Trails to Love — Blog Post Editor

A local, keyboard-driven markdown editor for this Hugo blog. Draft posts in a
proper UI instead of your IDE: pick a post, edit the markdown with syntax
highlighting, manage front matter with a form, drop in photos, and watch the
real Hugo-rendered preview update beside your writing.

## Requirements

- [Node.js](https://nodejs.org) (v18+)
- [Hugo](https://gohugo.io) (extended binary)
- macOS/Linux with a local dev setup — the editor only listens on
  `127.0.0.1` and is meant for local drafting, not remote use.

## Setup

```sh
npm install          # one-time: installs editor + theme deps
npm run start        # terminal 1: Hugo dev server (port 1414) + tailwind watch
npm run editor       # terminal 2: editor UI (1415) + file API (1416)
```

Then open **http://localhost:1415**.

> Hugo must be running on port 1414 for the live preview pane to work.
> `npm run start` already launches it (`hugo server`, with tailwind watching).

## Ports

| Port | Service |
|------|---------|
| 1414 | Hugo dev server (blog + live preview content) |
| 1415 | Editor UI (Vite dev server) |
| 1416 | Editor API (Express; proxied through the UI at `/api/`) |

## Using the editor

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

## New posts

Each post lives at `content/posts/YYYY-MM-DD-<slug>/index.md` (Hugo page
bundle). Copy an existing post's front matter shape or see
`content/posts/2026-09-11-three-days-in-algonquin/` for a canoe-trip template —
newest post conventions there are the current standard (categories use
activity + province, `stats` block drives the listing card).

## Development

```sh
npm test            # vitest — API roundtrip, front matter, permalinks (15 tests)
npx tsc --noEmit -p .  # type check
```

Code layout:

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

## Notes & gotchas

- The preview needs `hugo server` running (`npm run start` starts it). Saving
  refreshes the preview after ~1.5s to let Hugo's fast-render rebuild land.
- Hugo's draft semantics: a post is **published unless it has
  `draft: true`**. The sidebar dots and the Draft checkbox follow that.
- Hugo tolerates front matter preceded by a blank line; the editor's parser
  handles that too (several existing posts rely on it).
- The editor's Vite dev server ignores `public/**` and `content/**` in its
  watcher — Hugo rewrites `public/` on every save, and without the ignore
  rule the editor would reload (losing state) on each save.
- Sidebar post permalinks in the preview are derived with the same URL
  algorithm Hugo uses (`blog/:year/:month/:title/`), verified against every
  published post; if you change `[permalinks]` in `config.toml`, update
  `permalinkOf()` in `server/app.ts`.
