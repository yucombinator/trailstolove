import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createApp, type EditorApp } from "./app";
import { permalinkOf } from "./app";
import { parsePost } from "./frontmatter";

let contentDir: string;
let handle: EditorApp | undefined;
let base: string;

function makePost(slug: string, markdown: string) {
  const dir = join(contentDir, "posts", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "index.md"), markdown);
  return dir;
}

beforeAll(async () => {
  contentDir = mkdtempSync(join(tmpdir(), "editor-test-"));
  makePost(
    "2026-09-11-algonquin-canoe",
    `---
title: "Algonquin Provincial Park"
meta_title: "Canoe Trip in Algonquin"
date: 2026-09-11
draft: true
stats:
  where: "Algonquin Provincial Park, Ontario"
  distance: "TBD"
categories: ["Canoe", "Ontario"]
tags: ["Canoeing"]
---

Hello body.
`
  );
  handle = createApp({ contentDir });
  await new Promise<void>((resolve) => {
    handle!.server.listen(0, () => {
      base = `http://127.0.0.1:${(handle!.server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(() => {
  handle?.server.close();
  rmSync(contentDir, { recursive: true, force: true });
});

describe("GET /api/posts", () => {
  it("lists posts with slug, title, draft status, and date", async () => {
    const res = await fetch(`${base}/api/posts`);
    expect(res.status).toBe(200);
    const posts = (await res.json()) as Array<{ slug: string; title: string; draft: boolean; date: string }>;
    expect(posts).toHaveLength(1);
    expect(posts[0].slug).toBe("2026-09-11-algonquin-canoe");
    expect(posts[0].title).toBe("Algonquin Provincial Park");
    expect(posts[0].draft).toBe(true);
    expect(posts[0].date).toContain("2026-09-11");
  });

  it("treats absent draft key as published", async () => {
    const dir = join(contentDir, "posts", "1999-01-01-published-post");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.md"), "---\ntitle: \"Published\"\ndate: 1999-01-01\n---\n\nBody\n");
    const res = await fetch(`${base}/api/posts`);
    const posts = (await res.json()) as Array<{ slug: string; draft: boolean }>;
    const found = posts.find((p) => p.slug === "1999-01-01-published-post");
    expect(found?.draft).toBe(false);
  });

  it("parses front matter preceded by a blank line (Hugo tolerates it)", async () => {
    const dir = join(contentDir, "posts", "1999-02-02-blank-line-post");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.md"), "\n---\ntitle: \"Blank Lead\"\ndate: 1999-02-02\n---\n\nBody\n");
    const res = await fetch(`${base}/api/post/1999-02-02-blank-line-post`);
    const post = (await res.json()) as { frontMatter: Record<string, unknown> };
    expect(post.frontMatter.title).toBe("Blank Lead");
  });
});

describe("GET /api/post/:slug", () => {
  it("returns front matter as object and raw body", async () => {
    const res = await fetch(`${base}/api/post/2026-09-11-algonquin-canoe`);
    expect(res.status).toBe(200);
    const post = (await res.json()) as { frontMatter: Record<string, unknown>; body: string; resources: string[] };
    expect(post.frontMatter.title).toBe("Algonquin Provincial Park");
    expect(post.frontMatter.draft).toBe(true);
    expect(post.frontMatter.stats).toEqual({ where: "Algonquin Provincial Park, Ontario", distance: "TBD" });
    expect(post.body).toContain("Hello body.");
    expect(post.resources).toEqual([]);
  });

  it("404s for unknown slug", async () => {
    const res = await fetch(`${base}/api/post/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("rejects path traversal", async () => {
    const res = await fetch(`${base}/api/post/..%2F..%2Fetc`);
    expect([400, 404]).toContain(res.status);
  });
});

describe("PUT /api/post/:slug", () => {
  it("roundtrips front matter and body back to disk", async () => {
    const res = await fetch(`${base}/api/post/2026-09-11-algonquin-canoe`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        frontMatter: {
          title: "Algonquin Provincial Park",
          meta_title: "Canoe Trip in Algonquin",
          date: "2026-09-11",
          draft: false,
          stats: { where: "Algonquin Provincial Park, Ontario", distance: "48 km" },
          categories: ["Canoe", "Ontario"],
          tags: ["Canoeing", "Trail Report"],
        },
        body: "Hello body.\n\nNew paragraph.\n",
      }),
    });
    expect(res.status).toBe(200);
    const raw = readFileSync(
      join(contentDir, "posts", "2026-09-11-algonquin-canoe", "index.md"),
      "utf8"
    );
    const rewritten = parsePost(raw);
    expect(rewritten.frontMatter.title).toBe("Algonquin Provincial Park");
    expect(rewritten.frontMatter.draft).toBe(false);
    expect(rewritten.frontMatter.stats).toEqual({
      where: "Algonquin Provincial Park, Ontario",
      distance: "48 km",
    });
    expect(rewritten.frontMatter.categories).toEqual(["Canoe", "Ontario"]);
    expect(rewritten.body).toContain("New paragraph.");
  });

  it("404s for unknown slug", async () => {
    const res = await fetch(`${base}/api/post/nope`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frontMatter: {}, body: "" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/photo/:slug", () => {
  it("writes the file into the post bundle and returns its name", async () => {
    const pngBytes = Buffer.from(
      "89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082",
      "hex"
    );
    const form = new FormData();
    form.append("file", new Blob([pngBytes], { type: "image/png" }), "lake-ohara-pano.jpg");
    const res = await fetch(`${base}/api/photo/2026-09-11-algonquin-canoe`, { method: "POST", body: form });
    expect(res.status).toBe(200);
    const { filename, resources } = (await res.json()) as { filename: string; resources: string[] };
    expect(filename).toBe("lake-ohara-pano.jpg");
    const dir = join(contentDir, "posts", "2026-09-11-algonquin-canoe");
    expect(existsSync(join(dir, "lake-ohara-pano.jpg"))).toBe(true);
    expect(resources).toContain("lake-ohara-pano.jpg");
  });

  it("rejects non-image uploads", async () => {
    const form = new FormData();
    form.append("file", new Blob(["<html>evil</html>"], { type: "text/html" }), "evil.html");
    const res = await fetch(`${base}/api/photo/2026-09-11-algonquin-canoe`, { method: "POST", body: form });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/post/:slug/draft", () => {
  it("flips draft without touching other front matter or body", async () => {
    // Snapshot state first — earlier tests in this file may have modified it.
    const before = (await (await fetch(`${base}/api/post/2026-09-11-algonquin-canoe`)).json()) as {
      frontMatter: Record<string, unknown>;
      body: string;
    };
    const res = await fetch(`${base}/api/post/2026-09-11-algonquin-canoe/draft`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: false }),
    });
    expect(res.status).toBe(200);
    const raw = readFileSync(join(contentDir, "posts", "2026-09-11-algonquin-canoe", "index.md"), "utf8");
    const parsed = parsePost(raw);
    expect(parsed.frontMatter.draft).toBe(false);
    expect(parsed.frontMatter.title).toEqual(before.frontMatter.title);
    expect(parsed.frontMatter.stats).toEqual(before.frontMatter.stats);
    expect(parsed.body).toBe(before.body);
    // and back to draft
    const res2 = await fetch(`${base}/api/post/2026-09-11-algonquin-canoe/draft`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: true }),
    });
    expect(res2.status).toBe(200);
  });

  it("404s for unknown slug", async () => {
    const res = await fetch(`${base}/api/post/nope/draft`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft: false }),
    });
    expect(res.status).toBe(404);
  });
});

describe("permalinkOf — mirrors Hugo blog/:year/:month/:title/", () => {
  it("drops apostrophes without separator (Lake O'Hara → lake-ohara)", () => {
    expect(permalinkOf({ title: "Lake O'Hara", date: "2026-07-01" })).toBe("blog/2026/07/lake-ohara/");
  });

  it("keeps periods (Climbing Mt.Whitney → climbing-mt.whitney)", () => {
    expect(permalinkOf({ title: "Climbing Mt.Whitney", date: "2024-08-10" })).toBe("blog/2024/08/climbing-mt.whitney/");
  });

  it("collapses punctuation runs to dashes (The Enchantments → the-enchantments)", () => {
    expect(permalinkOf({ title: "Enchantments Traverse", date: "2022-08-27" })).toBe("blog/2022/08/enchantments-traverse/");
  });
});
