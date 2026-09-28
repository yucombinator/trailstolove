#!/bin/sh
# Run everything. Zero dependencies: node:test and unittest are both stdlib.
# Usage: sh tests/run.sh
set -e
cd "$(dirname "$0")/.."

# The app is a build product, so check the thing that actually ships. The page
# has several <script> blocks; only the one after router.js is the app, and
# checking the first one is a false green. This caught a brace imbalance that a
# regex-based check had been passing.
echo "== build integrity =="
python3 build_page.py > /dev/null
python3 - <<'PY'
import pathlib, subprocess, sys, tempfile
h = pathlib.Path("index.html").read_text()
i = h.index('<script src="router.js')
s = h.index('<script>', i) + len('<script>')
e = h.index('</script>', s)
src = h[s:e]
with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
    f.write(src); p = f.name
r = subprocess.run(["node", "--check", p], capture_output=True, text=True)
if r.returncode != 0:
    sys.exit("app script does not parse:\n" + r.stderr)
print(f"app script parses ({len(src.splitlines())} lines)")
PY

echo
echo "== router + functionality (node) =="
# unquoted on purpose: the shell expands it to real paths, which every Node
# version accepts. Quoted, only Node 21+ treats it as a glob — the runner's
# preinstalled Node saw a literal "tests/*.test.js" and found no such module.
node --test tests/*.test.js

echo
echo "== pipeline (python) =="
python3 -m unittest discover -s tests -p "test_*.py"
