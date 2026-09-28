"""Check the page and the router agree on the Router API.

The app is shipped as a BUNDLE: app.html, router.js and router_data.json sit
side by side, and they are produced by different steps (the template is edited
by hand, router.js is source, the payload is a build product). A page built
from a newer template than the router.js beside it fails at runtime, in the
browser, for every user — `Router.overlapTracker is not a function` broke
route drawing that way.

This reads the DEPLOYED bundle and asserts every Router.* the page calls is
actually exported by the router it loads. Skips cleanly when the bundle is not
present (e.g. running inside tools/algonquin-graph on its own).
"""
import os
import pathlib
import re
import unittest

HERE = pathlib.Path(__file__).resolve().parent
# .../tools/algonquin-graph/tests -> .../content/algonquin
BUNDLE = HERE.parent.parent.parent / "content" / "algonquin"
ROUTER_CALL = re.compile(r"\bRouter\.([A-Za-z_$][\w$]*)")
EXPORT_BLOCK = re.compile(r"const\s+Router\s*=\s*\{(.*?)\}", re.S)
EXPORT_KEY = re.compile(r"([A-Za-z_$][\w$]*)\s*:")


def find_bundle():
    """Which app.html/router.js pair to check.

    Defaults to the locally built one: in CI the deployed bundle is from the
    previous run until the deploy step runs, so preferring it would fail on
    stale-but-correct files. Set ALGONQUIN_BUNDLE to check the deployed copy
    instead, which is what the post-deploy CI step does.
    """
    override = os.environ.get("ALGONQUIN_BUNDLE")
    if override:
        p = pathlib.Path(override)
        if not p.is_absolute():
            p = pathlib.Path.cwd() / p
        if not (p / "router.js").exists():
            raise AssertionError(
                f"ALGONQUIN_BUNDLE={override} has no router.js (resolved to {p}). "
                "It must be absolute: a relative path resolves against the "
                "working directory, and this step changes it.")
        return p
    local = HERE.parent
    if (local / "index.html").exists() and (local / "router.js").exists():
        return local
    if (BUNDLE / "app.html").exists() and (BUNDLE / "router.js").exists():
        return BUNDLE
    return None

class TestRouterApiContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = find_bundle()
        if cls.bundle is None:
            raise unittest.SkipTest("no built or deployed bundle found")
        # the deployed page is app.html; a local build writes index.html
        page = cls.bundle / "app.html"
        if not page.exists():
            page = cls.bundle / "index.html"
        cls.html = page.read_text()
        cls.router = (cls.bundle / "router.js").read_text()

    def exported(self):
        block = EXPORT_BLOCK.search(self.router)
        self.assertIsNotNone(block, "could not find the Router export object")
        return set(EXPORT_KEY.findall(block.group(1)))

    def called(self):
        # everything the page reaches for, minus the definition site itself
        return set(ROUTER_CALL.findall(self.html))

    def test_every_router_call_is_exported(self):
        exported = self.exported()
        called = self.called()
        missing = sorted(called - exported)
        self.assertEqual(missing, [],
                         f"{self.bundle.name}: the page calls Router.{missing} but "
                         f"router.js does not export it. The bundle is out of sync — "
                         f"rebuild the page and copy router.js alongside it.")

    def test_the_page_actually_uses_the_router(self):
        self.assertGreater(len(self.called()), 3,
                            "no Router calls found - the extraction pattern is stale")

    def test_router_js_is_valid_javascript(self):
        import subprocess
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
            f.write(self.router)
            p = f.name
        r = subprocess.run(["node", "--check", p], capture_output=True, text=True)
        if r.returncode != 0:
            self.fail(f"router.js does not parse:\n{r.stderr}")


class TestBundleIntegrity(unittest.TestCase):
    """The bundle ships router.js as source but app.html/router_data.json as
    build products, so only router.js can be compared to the tools copy."""

    def test_shipped_router_js_matches_the_source(self):
        if not (BUNDLE / "router.js").exists():
            self.skipTest("no deployed bundle in this checkout")
        src = HERE.parent / "router.js"
        self.assertTrue(src.exists(), f"missing router source at {src}")
        self.assertEqual((BUNDLE / "router.js").read_text(), src.read_text(),
                         "content/algonquin/router.js is stale — copy it from "
                         "tools/algonquin-graph/router.js or the page calls a "
                         "Router function the deployed script does not have")


if __name__ == "__main__":
    unittest.main()
