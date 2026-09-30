#!/usr/bin/env python3
"""Build the app and publish the bundle, without copying files by hand.

The pipeline lives in git (tools/algonquin-graph) but the raw OSM snapshots it
needs are gitignored, so the build actually runs in a working copy that has
them — historically /tmp/algonquin-graph. That split has a cost: the template
has to be copied across by hand before every build, and the result copied
back into content/algonquin before it is live. Both copies were forgotten
often enough to be a recurring source of "I can't see my change".

So do it here, in one step:

    python3 tools/algonquin-graph/sync_build.py /tmp/algonquin-graph

copies router_template.html and router.js into the build directory, runs
build_page.py there, and writes the built page and payload into
content/algonquin/. The build directory must already have raw/; the sources
come from git either way, so the two trees cannot drift.

With no argument it builds in this directory, which only works if raw/ is
here.
"""
import json
import pathlib
import shutil
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parents[1]                      # tools/algonquin-graph -> repo root
BUNDLE = REPO / "content" / "algonquin"
SOURCES = ("router_template.html", "router.js")


def main():
    build_dir = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT
    if not (build_dir / "raw").is_dir():
        print(f"[fatal] {build_dir}/raw is missing. That is where the OSM snapshots\n"
              f"        live; they are gitignored, so the build has to run there.\n"
              f"        Fetch them with: python3 fetch_osm.py", flush=True)
        return 1
    if not (build_dir / "data").is_dir():
        print(f"[fatal] {build_dir}/data is missing", flush=True)
        return 1

    for name in SOURCES:
        src, dst = ROOT / name, build_dir / name
        # the router is the one thing that must not be stale: a page built
        # against a newer router.js than the one beside it dies in the browser
        # with "Router.x is not a function".
        if not src.exists() and name == "router_template.html":
            print(f"[fatal] {src} is missing", flush=True)
            return 1
        if src.exists() and src.read_bytes() != (dst.read_bytes() if dst.exists() else b""):
            shutil.copy2(src, dst)
            print(f"[sync] {name}", flush=True)

    print(f"[build] in {build_dir}", flush=True)
    r = subprocess.run([sys.executable, "build_page.py"], cwd=build_dir)
    if r.returncode:
        print("[fatal] build_page.py failed; nothing published", flush=True)
        return r.returncode

    built = build_dir / "index.html"
    if not built.exists():
        print("[fatal] build_page.py produced no index.html", flush=True)
        return 1

    # A build from a stale local raw/ can quietly ship LESS than what is
    # already live. It happened the first time this ran: the local copy has no
    # raw/park_boundary.json, so the park outline vanished from the map. The
    # hand-copy this replaces could not do that by accident, so the replacement
    # must not either. Check before publishing, not after.
    live = BUNDLE / "router_data.json"
    fresh = build_dir / "router_data.json"
    if live.exists() and fresh.exists():
        old, new = json.loads(live.read_text()), json.loads(fresh.read_text())
        losses = []
        for key, label in (("park", "park boundary"),
                           ("lakes", "lake polygons"),
                           ("reaches", "river reaches")):
            def feats(d):
                v = d.get(key)
                return len((v or {}).get("features") or []) if isinstance(v, dict) else 0
            was, now = feats(old), feats(new)
            if now < was:
                losses.append(f"{label} {was} -> {now}")
        for key, label in (("official", "official access points"),
                           ("edges", "edges"), ("nodes", "nodes")):
            was, now = len(old.get(key) or []), len(new.get(key) or [])
            if now < was:
                losses.append(f"{label} {was} -> {now}")
        if losses:
            print("[fatal] this build would publish LESS data than is already live:",
                  flush=True)
            for l in losses:
                print(f"          {l}", flush=True)
            print("          your local raw/ is probably stale: run fetch_osm.py there,\n"
                  "          or build from a directory whose raw/ is current.\n"
                  "          Nothing was published.", flush=True)
            return 1

    BUNDLE.mkdir(parents=True, exist_ok=True)
    for name, out in (("index.html", "app.html"),
                      ("router_data.json", "router_data.json"),
                      ("router.js", "router.js")):
        src = build_dir / name
        if src.exists():
            shutil.copy2(src, BUNDLE / out)
            print(f"[publish] content/algonquin/{out}", flush=True)
    print("[done] bundle published; `hugo` to see it, or push to deploy", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
