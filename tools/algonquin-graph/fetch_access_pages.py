#!/usr/bin/env python3
"""Re-fetch the park's official access point pages into raw/ap_pages/.

parse_osm.py builds data/access_official.csv from the saved HTML in
raw/ap_pages/. Nothing fetched them: raw/ is gitignored and no step scraped
those pages, so a clean runner had an empty directory and parse_osm was free
to write an empty table over a good one. That silently deleted all 29
official access points — no numbered pins on the map, and no way to start or
end a route at one. parse_osm.py no longer empties the table, so a run
without pages is harmless; this makes pages not be missing in the first
place, so the numbers and names can actually track the park.

The slugs come from data/access_official.csv, which is the durable list of
which pages exist — this refreshes what they say, it does not decide how many
there are. Adding a new access point is still a manual row in that CSV,
which is a change someone should mean.

Cached copies are reused for 30 days, so the twice-daily refresh does not
hammer the park's site; `--force` re-fetches everything, `--days N` changes
the window. One page failing is a warning, not a failure: a partial refresh
plus the CSV fallback is strictly better than no attempt at all.
"""
import csv
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
RAW = ROOT / "raw"
DATA = ROOT / "data"
UA = "algonquin-graph-builder/0.1"

BASE = "https://www.algonquinpark.on.ca/visit/camping/{slug}-access-point.php"
FRESH_DAYS = 30


def cached_age_days(path):
    if not path.exists():
        return None
    return (time.time() - path.stat().st_mtime) / 86400


def fetch_one(slug, dest, user_agent, timeout):
    url = BASE.format(slug=slug)
    req = urllib.request.Request(url, headers={"User-Agent": user_agent})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    ctype = resp.headers.get("Content-Type", "")
    if "html" not in ctype.lower():
        print(f"[warn] {slug}: not html ({ctype or 'no content-type'})", flush=True)
        return False
    dest.write_bytes(body)
    return True


def main():
    args = dict(a.split("=", 1) for a in sys.argv[1:] if "=" in a)
    force = "--force" in sys.argv
    days = float(args.get("days", FRESH_DAYS))
    csv_path = DATA / "access_official.csv"
    if not csv_path.exists():
        print(f"[fatal] {csv_path} is gone — nothing to fetch", flush=True)
        raise SystemExit(1)

    with open(csv_path, newline="") as f:
        rows = list(csv.DictReader(f))
    slugs = [r["slug"] for r in rows if r.get("slug")]
    if not slugs:
        print(f"[fatal] {csv_path} lists no slugs", flush=True)
        raise SystemExit(1)

    dest_dir = RAW / "ap_pages"
    dest_dir.mkdir(parents=True, exist_ok=True)
    timeout = int(args.get("timeout", 45))

    fetched = cached = failed = 0
    for slug in slugs:
        dest = dest_dir / f"{slug}.html"
        age = cached_age_days(dest)
        if not force and age is not None and age < days:
            cached += 1
            continue
        try:
            if fetch_one(slug, dest, UA, timeout):
                fetched += 1
                print(f"[ok] {slug} ({dest.stat().st_size} bytes)", flush=True)
            else:
                failed += 1
        except Exception as exc:  # noqa: BLE001 — one dead page must not stop the rest
            failed += 1
            print(f"[warn] {slug}: {exc}", flush=True)
        # sequential and paced: this is a courtesy fetch of a public page
        time.sleep(2)

    print(f"[done] {fetched} fetched, {cached} still fresh, {failed} failed "
          f"of {len(slugs)} pages", flush=True)
    if fetched == 0 and failed:
        # parse_osm keeps the existing table, so this is a degraded run, not a
        # broken one. Say so loudly and let the refresh continue.
        print("[warn] no page could be fetched; access_official.csv will be kept "
              "as-is and the access points stay correct but possibly stale", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
