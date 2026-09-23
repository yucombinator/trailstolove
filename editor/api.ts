export interface PostSummary {
  slug: string;
  title: string;
  draft: boolean;
  date: string;
  categories: string[];
}

export interface PostDetail {
  slug: string;
  frontMatter: Record<string, unknown>;
  frontMatterOrder: string[];
  body: string;
  resources: string[];
  permalink: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listPosts: () => fetch("/api/posts").then((r) => json<PostSummary[]>(r)),

  getPost: (slug: string) => fetch(`/api/post/${encodeURIComponent(slug)}`).then((r) => json<PostDetail>(r)),

  savePost: (slug: string, detail: PostDetail) =>
    fetch(`/api/post/${encodeURIComponent(slug)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        frontMatter: detail.frontMatter,
        frontMatterOrder: detail.frontMatterOrder,
        body: detail.body,
      }),
    }).then((r) => json<{ ok: boolean; resources: string[] }>(r)),

  uploadPhoto: async (slug: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return fetch(`/api/photo/${encodeURIComponent(slug)}`, { method: "POST", body: form }).then((r) =>
      json<{ filename: string; resources: string[] }>(r)
    );
  },

  setDraft: (slug: string, draft: boolean) =>
    fetch(`/api/post/${encodeURIComponent(slug)}/draft`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft }),
    }).then((r) => json<{ ok: boolean; draft: boolean }>(r)),
};
