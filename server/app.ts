import express, { type Express, type Request, type Response } from "express";
import type { Server } from "http";
import multer from "multer";
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { join, basename, extname, resolve, sep } from "path";
import { parsePost, serializePost } from "./frontmatter";

export interface EditorApp {
  app: Express;
  server: Server;
}

export interface CreateAppOptions {
  /** Absolute path to the hugo `content/` directory. */
  contentDir: string;
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif"]);

function isSlug(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && !s.startsWith(".");
}

/**
 * Express 5 types route params as string | string[]; slugs never contain
 * separators, so collapse arrays defensively and reject non-strings.
 * Used at every route param site to keep validation uniform.
 */
function slugParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(",");
  return typeof value === "string" ? value : "";
}

/**
 * Mirrors Hugo's permalink pattern blog/:year/:month/:title/ — :title is the
 * urlized front-matter title. Verified against every published post's public/
 * output (see app.test.ts permalink test). Keep in sync with config.toml
 * [permalinks] posts.
 */
export function permalinkOf(frontMatter: Record<string, unknown>): string {
  const title = typeof frontMatter.title === "string" ? frontMatter.title : "";
  const date = typeof frontMatter.date === "string" ? frontMatter.date : "";
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const urlized = title
    .replace(/['’"]/g, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._~-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `blog/${y}/${m}/${urlized}/`;
}

function postDir(contentDir: string, slug: string): string | null {
  if (!isSlug(slug)) return null;
  const dir = resolve(contentDir, "posts", slug);
  // Defense in depth beyond the slug regex.
  if (!dir.startsWith(resolve(contentDir, "posts") + sep)) return null;
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  return dir;
}

export function createApp({ contentDir }: CreateAppOptions): EditorApp {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024 },
  });

  // Per-request destination: multer's storage destination can't see req params,
  // so we write manually after validating the slug.
  app.post("/api/photo/:slug", upload.single("file"), (req: Request, res: Response) => {
    const dir = postDir(contentDir, slugParam(req.params.slug));
    const file = req.file;
    if (!dir) {
      res.status(404).json({ error: "unknown post" });
      return;
    }
    if (!file) {
      res.status(400).json({ error: "no file" });
      return;
    }
    const ext = extname(file.originalname).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      res.status(400).json({ error: `not an image: ${ext}` });
      return;
    }
    const target = join(dir, basename(file.originalname));
    writeFileSync(target, file.buffer);
    res.json({ filename: basename(target), resources: listResources(dir) });
  });

  function listResources(dir: string): string[] {
    return readdirSync(dir).filter(
      (f) => f !== "index.md" && IMAGE_EXTENSIONS.has(extname(f).toLowerCase())
    );
  }

  app.get("/api/posts", (_req: Request, res: Response) => {
    const postsRoot = join(contentDir, "posts");
    if (!existsSync(postsRoot)) {
      res.json([]);
      return;
    }
    const posts = readdirSync(postsRoot)
      .filter((name) => {
        const p = join(postsRoot, name);
        return statSync(p).isDirectory() && existsSync(join(p, "index.md"));
      })
      .map((slug) => {
        const parsed = parsePost(readFileSync(join(postsRoot, slug, "index.md"), "utf8"));
        return {
          slug,
          title: typeof parsed.frontMatter.title === "string" ? parsed.frontMatter.title : slug,
          draft: parsed.frontMatter.draft === true,
          date: typeof parsed.frontMatter.date === "string" ? parsed.frontMatter.date : "",
          categories: Array.isArray(parsed.frontMatter.categories) ? parsed.frontMatter.categories : [],
        };
      })
      .sort((a, b) => b.slug.localeCompare(a.slug));
    res.json(posts);
  });

  app.get("/api/post/:slug", (req: Request, res: Response) => {
    const dir = postDir(contentDir, slugParam(req.params.slug));
    if (!dir) {
      res.status(404).json({ error: "unknown post" });
      return;
    }
    const parsed = parsePost(readFileSync(join(dir, "index.md"), "utf8"));
    res.json({
      slug: slugParam(req.params.slug),
      frontMatter: parsed.frontMatter,
      frontMatterOrder: parsed.frontMatterOrder,
      body: parsed.body,
      resources: listResources(dir),
      permalink: permalinkOf(parsed.frontMatter),
    });
  });

  app.put("/api/post/:slug", (req: Request, res: Response) => {
    const dir = postDir(contentDir, slugParam(req.params.slug));
    if (!dir) {
      res.status(404).json({ error: "unknown post" });
      return;
    }
    const { frontMatter, frontMatterOrder, body } = req.body as {
      frontMatter?: Record<string, unknown>;
      frontMatterOrder?: string[];
      body?: string;
    };
    if (typeof frontMatter !== "object" || frontMatter === null || typeof body !== "string") {
      res.status(400).json({ error: "expected { frontMatter, body }" });
      return;
    }
    const existing = parsePost(readFileSync(join(dir, "index.md"), "utf8"));
    const order = Array.isArray(frontMatterOrder) && frontMatterOrder.length
      ? frontMatterOrder
      : existing.frontMatterOrder;
    writeFileSync(join(dir, "index.md"), serializePost(frontMatter, order, body));
    res.json({ ok: true, resources: listResources(dir) });
  });

  app.patch("/api/post/:slug/draft", (req: Request, res: Response) => {
    const dir = postDir(contentDir, slugParam(req.params.slug));
    const { draft } = req.body as { draft?: unknown };
    if (!dir) {
      res.status(404).json({ error: "unknown post" });
      return;
    }
    if (typeof draft !== "boolean") {
      res.status(400).json({ error: "expected { draft: boolean }" });
      return;
    }
    const file = join(dir, "index.md");
    const parsed = parsePost(readFileSync(file, "utf8"));
    writeFileSync(file, serializePost({ ...parsed.frontMatter, draft }, parsed.frontMatterOrder, parsed.body));
    res.json({ ok: true, draft });
  });

  const server = app.listen(0, "127.0.0.1");
  return { app, server };
}
