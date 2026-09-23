/**
 * Markdown front-matter parsing/serialization for Hugo posts.
 * Preserves front-matter key order on roundtrip (Hugo doesn't care,
 * but humans diffing index.md do).
 */
import { load as yamlLoad, dump as yamlDump } from "js-yaml";

export interface ParsedPost {
  frontMatter: Record<string, unknown>;
  frontMatterOrder: string[];
  body: string;
}

// Hugo tolerates leading whitespace before the opening --- fence.
const FM_RE = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parsePost(raw: string): ParsedPost {
  const match = FM_RE.exec(raw);
  if (!match) {
    return { frontMatter: {}, frontMatterOrder: [], body: raw };
  }
  const doc = yamlLoad(match[1]);
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { frontMatter: {}, frontMatterOrder: [], body: raw };
  }
  const frontMatter = doc as Record<string, unknown>;
  return {
    frontMatter,
    frontMatterOrder: Object.keys(frontMatter),
    body: raw.slice(match[0].length),
  };
}

export function serializePost(
  frontMatter: Record<string, unknown>,
  frontMatterOrder: string[],
  body: string
): string {
  // Keep known keys in their original order, append any new ones at the end.
  const ordered: Record<string, unknown> = {};
  for (const key of frontMatterOrder) {
    if (key in frontMatter) ordered[key] = frontMatter[key];
  }
  for (const key of Object.keys(frontMatter)) {
    if (!(key in ordered)) ordered[key] = frontMatter[key];
  }
  const fm = yamlDump(ordered, {
    lineWidth: -1, // don't wrap long descriptions
    forceQuotes: false,
  });
  return `---\n${fm}---\n${body}`;
}
