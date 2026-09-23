import { useCallback, useEffect, useRef, useState } from "react";
import MonacoEditor from "@monaco-editor/react";
import { api, type PostDetail, type PostSummary } from "./api";

function previewUrl(permalink: string): string {
  return `/hugo/${permalink}`;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block mb-3">
      <span className="block text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">{label}</span>
      <input
        className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-sm text-gray-800 dark:text-gray-100 placeholder:text-gray-300 dark:placeholder:text-gray-600 transition-colors focus:bg-white dark:focus:bg-gray-900 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 dark:focus:ring-emerald-900/60"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function TextArea({
  label,
  value,
  onChange,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <label className="block mb-3">
      <span className="block text-[11px] font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-1">{label}</span>
      <textarea
        className="w-full bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-2.5 py-1.5 text-sm text-gray-800 dark:text-gray-100 resize-none transition-colors focus:bg-white dark:focus:bg-gray-900 focus:outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 dark:focus:ring-emerald-900/40"
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-2 mt-5 mb-2 first:mt-0">
      <span className="text-[11px] font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{children}</span>
      <span className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
    </div>
  );
}

function FrontMatterForm({
  detail,
  onChange,
}: {
  detail: PostDetail;
  onChange: (fm: Record<string, unknown>) => void;
}) {
  const fm = detail.frontMatter;
  const str = (key: string): string => (typeof fm[key] === "string" ? (fm[key] as string) : "");
  const stats = (fm.stats && typeof fm.stats === "object" ? fm.stats : {}) as Record<string, unknown>;
  const list = (key: string): string =>
    Array.isArray(fm[key]) ? (fm[key] as unknown[]).map(String).join(", ") : "";

  const set = (key: string, value: unknown) => onChange({ ...fm, [key]: value });
  const setStats = (key: string, value: string) => set("stats", { ...stats, [key]: value });

  return (
    <div>
      <SectionLabel>Basics</SectionLabel>
      <Field label="Title" value={str("title")} onChange={(v) => set("title", v)} />
      <Field label="Meta title" value={str("meta_title")} onChange={(v) => set("meta_title", v)} />
      <TextArea label="Description" value={str("description")} onChange={(v) => set("description", v)} rows={2} />

      <SectionLabel>Trip stats</SectionLabel>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Where" value={String(stats.where ?? "")} onChange={(v) => setStats("where", v)} />
        <Field label="Distance" value={String(stats.distance ?? "")} onChange={(v) => setStats("distance", v)} />
        <Field label="Elevation" value={String(stats.elevation ?? "")} onChange={(v) => setStats("elevation", v)} />
        <Field label="Trip dates" value={String(stats.date ?? "")} onChange={(v) => setStats("date", v)} />
      </div>

      <SectionLabel>Taxonomy</SectionLabel>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Categories" value={list("categories")} onChange={(v) => set("categories", v.split(/,\s*/).filter(Boolean))} />
        <Field label="Tags" value={list("tags")} onChange={(v) => set("tags", v.split(/,\s*/).filter(Boolean))} />
      </div>

      <SectionLabel>Media</SectionLabel>
      <Field label="Thumbnail" value={str("thumbnail")} onChange={(v) => set("thumbnail", v)} placeholder="images/trips/x.jpg" />
      <Field label="Hero image" value={str("image")} onChange={(v) => set("image", v)} placeholder="pano.jpg" />

      <label className="flex items-center justify-between bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-3 py-2 mt-1 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
          Draft
          <span className="block text-[11px] text-gray-400 dark:text-gray-500 font-normal">Hidden from the live site</span>
        </span>
        <input
          type="checkbox"
          checked={fm.draft !== false}
          onChange={(e) => set("draft", e.target.checked)}
          className="h-4 w-4 accent-emerald-600"
        />
      </label>

      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-3 leading-relaxed">
        Other front-matter keys are preserved on save — {detail.frontMatterOrder.length} total.
      </p>
    </div>
  );
}

export function Editor() {
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [detail, setDetail] = useState<PostDetail | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [previewKey, setPreviewKey] = useState(0);
  const [permalink, setPermalink] = useState("");
  const [phonePreview, setPhonePreview] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [dark, setDark] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const stored = localStorage.getItem("ttl-theme");
    if (stored) return stored === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const editorRef = useRef<{ insertValue: (v: string) => void } | null>(null);
  const detailRef = useRef<PostDetail | null>(null);
  const dirtyRef = useRef(false);
  detailRef.current = detail;
  dirtyRef.current = dirty;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("ttl-theme", dark ? "dark" : "light");
    // Live-sync the preview iframe (it may not reload on theme change).
    const iframe = document.querySelector<HTMLIFrameElement>("iframe[title='Hugo preview']");
    if (iframe && iframe.contentDocument) {
      applyPreviewDark(iframe, dark);
    }
  }, [dark]);

  // Invert the iframe's light site theme; re-invert its images so photos stay
  // true-to-color. Idempotent via a tagged <style> we can remove on light.
  function applyPreviewDark(iframe: HTMLIFrameElement, on: boolean) {
    const doc = iframe.contentDocument;
    if (!doc || !doc.head) return;
    iframe.classList.toggle("dark-preview", on);
    let style = doc.getElementById("ttl-dark-preview") as HTMLStyleElement | null;
    if (on && !style) {
      style = doc.createElement("style");
      style.id = "ttl-dark-preview";
      style.textContent =
        "img, video, picture, [style*='background-image'] { filter: invert(1) hue-rotate(180deg); }";
      doc.head.appendChild(style);
    } else if (!on && style) {
      style.remove();
    }
  }

  const loadPosts = useCallback(() => {
    api.listPosts().then(setPosts).catch((e) => setStatus(`Load failed: ${e.message}`));
  }, []);

  useEffect(loadPosts, [loadPosts]);

  const openPost = (slug: string) => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    api
      .getPost(slug)
      .then((d) => {
        setDetail(d);
        setActiveSlug(slug);
        setPermalink(d.permalink);
        setDirty(false);
        setStatus("");
        setPreviewKey((k) => k + 1);
      })
      .catch((e) => setStatus(`Open failed: ${e.message}`));
  };

  const save = useCallback(async () => {
    const d = detailRef.current;
    if (!d || !activeSlug) return;
    try {
      const r = await api.savePost(activeSlug, d);
      setDetail({ ...d, resources: r.resources });
      setDirty(false);
      setStatus(`Saved · ${new Date().toLocaleTimeString()}`);
      setPosts((ps) => ps.map((p) => (p.slug === activeSlug ? { ...p, title: String(d.frontMatter.title ?? p.title), draft: d.frontMatter.draft === true } : p)));
      // Give hugo server a moment to rebuild before refreshing the preview.
      setTimeout(() => setPreviewKey((k) => k + 1), 1500);
    } catch (e) {
      setStatus(`Save failed: ${(e as Error).message}`);
    }
  }, [activeSlug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  // Block accidental tab close while there are unsaved changes.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!detailRef.current) return;
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Escape closes the details drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowDetails(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const humanize = (filename: string): string =>
    filename.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();

  const insertMarkdownFor = (filenames: string[]): string => {
    if (filenames.length === 0) return "";
    if (filenames.length === 1) {
      const f = filenames[0];
      return `![${humanize(f)}](${f})\n`;
    }
    // Pair images into side-by-side shortcodes; odd trailing image becomes plain.
    let out = "";
    for (let i = 0; i < filenames.length; i += 2) {
      if (i + 1 < filenames.length) {
        const capA = prompt(`Caption for ${filenames[i]}:`, humanize(filenames[i])) ?? "";
        const capB = prompt(`Caption for ${filenames[i + 1]}:`, humanize(filenames[i + 1])) ?? "";
        out += `{{< side-by-side "${filenames[i]}" "${filenames[i + 1]}" "${capA}" "${capB}" >}}\n\n`;
      } else {
        out += `![${humanize(filenames[i])}](${filenames[i]})\n\n`;
      }
    }
    return out;
  };

  const dropPhotos = async (files: FileList | null) => {
    if (!files || files.length === 0 || !activeSlug) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) return;
    try {
      const uploaded: string[] = [];
      for (const [i, file] of images.entries()) {
        const r = await api.uploadPhoto(activeSlug, file);
        uploaded.push(r.filename);
        setDetail((d) => (d ? { ...d, resources: r.resources } : d));
        setStatus(`Uploaded ${i + 1}/${images.length} — ${r.filename}`);
      }
      const md = insertMarkdownFor(uploaded);
      if (md) {
        insert(md);
        setStatus(images.length === 1 ? `Inserted ${uploaded[0]}` : `Inserted ${images.length} photos`);
      }
    } catch (e) {
      setStatus(`Upload failed: ${(e as Error).message}`);
    }
  };

  const toggleDraft = async (slug: string, current: boolean) => {
    // Optimistic flip; revert on failure.
    setPosts((ps) => ps.map((p) => (p.slug === slug ? { ...p, draft: !current } : p)));
    try {
      await api.setDraft(slug, !current);
      setStatus(!current ? `Published ${slug}` : `Unpublished ${slug}`);
      setTimeout(() => setPreviewKey((k) => k + 1), 1200);
    } catch (e) {
      setPosts((ps) => ps.map((p) => (p.slug === slug ? { ...p, draft: current } : p)));
      setStatus(`Toggle failed: ${(e as Error).message}`);
    }
  };

  const insert = (text: string) => {
    editorRef.current?.insertValue(text);
    setDetail((d) => d);
    setDirty(true);
  };

  const insertSideBySide = () => {
    const r = detail?.resources ?? [];
    if (r.length < 2) {
      setStatus("Need at least 2 uploaded photos for side-by-side");
      return;
    }
    const a = prompt("First image:", r[r.length - 2]);
    const b = prompt("Second image:", r[r.length - 1]);
    if (!a || !b) return;
    const cap1 = prompt("Caption 1:", "") ?? "";
    const cap2 = prompt("Caption 2:", "") ?? "";
    insert(`{{< side-by-side "${a}" "${b}" "${cap1}" "${cap2}" >}}\n`);
  };

  const ghostBtn =
    "text-sm px-2.5 py-1.5 rounded-lg border border-transparent text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-white transition-colors";

  return (
    <div className="flex h-screen bg-gray-100 dark:bg-gray-950 text-gray-900 dark:text-gray-100 font-sans antialiased">
      {/* Sidebar: post list */}
      <aside className="w-64 shrink-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 flex flex-col shadow-[1px_0_2px_rgba(0,0,0,0.03)]">
        <div className="px-4 py-4 border-b border-gray-100 dark:border-gray-800 flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-400 to-teal-600 text-white flex items-center justify-center font-black text-lg shadow-sm">
            T
          </div>
          <div>
            <h1 className="font-bold leading-tight">Trails to Love</h1>
            <p className="text-[11px] text-gray-400 dark:text-gray-500 leading-none">post editor</p>
          </div>
          <button
            onClick={() => setDark((d) => !d)}
            title={dark ? "Switch to light mode" : "Switch to dark mode"}
            className="ml-auto h-8 w-8 rounded-lg text-gray-400 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-200 flex items-center justify-center transition-colors"
          >
            {dark ? "☀️" : "🌙"}
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5">
          {posts.map((p) => {
            const active = activeSlug === p.slug;
            return (
              <button
                key={p.slug}
                onClick={() => openPost(p.slug)}
                className={`group block w-full text-left px-2.5 py-2 rounded-lg text-sm transition-colors ${
                  active
                    ? "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-900 dark:text-emerald-100"
                    : "hover:bg-gray-50 dark:hover:bg-gray-800"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    role="button"
                    title={p.draft ? "Draft — click to publish" : "Published — click to unpublish"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggleDraft(p.slug, p.draft);
                    }}
                    className="shrink-0 cursor-pointer p-1.5 -m-1.5 hover:scale-125 transition-transform"
                  >
                    <span
                      className={`block h-1.5 w-1.5 rounded-full ${
                        active
                          ? "bg-emerald-500"
                          : p.draft
                            ? "bg-amber-400"
                            : "bg-gray-300 dark:bg-gray-600"
                      }`}
                    />
                  </span>
                  <span className={`font-medium truncate ${active ? "text-emerald-800 dark:text-emerald-100" : "text-gray-700 dark:text-gray-200"}`}>{p.title}</span>
                </span>
                <span className="ml-3 block text-[11px] text-gray-400 dark:text-gray-500 truncate">{p.date || p.slug}</span>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Main: editor + preview */}
      <main className="flex-1 flex flex-col min-w-0">
        {!detail ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-gray-400 dark:text-gray-500">
            <div className="h-12 w-12 rounded-2xl bg-white dark:bg-gray-900 shadow-sm border border-gray-200 dark:border-gray-800 flex items-center justify-center text-2xl">✏️</div>
            <p className="text-sm">Pick a post from the list to start editing</p>
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
              <span className="font-mono text-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 rounded-md px-2 py-1">{activeSlug}</span>
              {(() => {
                const words = detail.body.split(/\s+/).filter(Boolean).length;
                const mins = Math.max(1, Math.round(words / 200));
                return (
                  <span className="text-[11px] text-gray-400 dark:text-gray-500 whitespace-nowrap">
                    {words} words · ~{mins} min read
                  </span>
                );
              })()}
              {dirty && (
                <span className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-full px-2 py-0.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
                  unsaved
                </span>
              )}
              {status && !dirty && (
                <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-800 rounded-full px-2 py-0.5">
                  {status}
                </span>
              )}
              <div className="flex-1" />
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowDetails((s) => !s)}
                  className={`${ghostBtn} ${showDetails ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white" : ""}`}
                >
                  Details
                </button>
                <button
                  onClick={() => setShowPreview((s) => !s)}
                  className={`${ghostBtn} ${showPreview ? "bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white" : ""}`}
                >
                  Preview
                </button>
                <button onClick={() => document.getElementById("photo-input")?.click()} className={ghostBtn}>
                  Upload photos
                </button>
                <input id="photo-input" type="file" accept="image/*" multiple hidden onChange={(e) => dropPhotos(e.target.files)} />
                <button onClick={insertSideBySide} className={ghostBtn}>
                  Side-by-side
                </button>
                <button
                  onClick={() => void save()}
                  className={`text-sm px-4 py-1.5 rounded-lg font-medium transition-all ${
                    dirty
                      ? "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 hover:shadow"
                      : "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed"
                  }`}
                  disabled={!dirty}
                >
                  Save
                </button>
              </div>
            </div>

            <div className="flex-1 flex min-h-0 gap-px bg-gray-200 dark:bg-gray-800 relative overflow-hidden">
              {/* Markdown editor */}
              <div className="flex-1 min-w-0 flex flex-col bg-white dark:bg-gray-900">
                <div
                  className="flex-1"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    void dropPhotos(e.dataTransfer.files);
                  }}
                >
                  <MonacoEditor
                    defaultLanguage="markdown"
                    theme={dark ? "vs-dark" : "vs"}
                    value={detail.body}
                    onMount={(ed) => {
                      editorRef.current = { insertValue: (v) => ed.executeEdits("insert", [{ range: ed.getSelection()!, text: v }]) };
                    }}
                    onChange={(v) => {
                      setDetail((d) => (d ? { ...d, body: v ?? "" } : d));
                      setDirty(true);
                    }}
                    options={{ minimap: { enabled: false }, wordWrap: "on", fontSize: 14, automaticLayout: true, padding: { top: 12 } }}
                  />
                </div>
                {detail.resources.length > 0 && (
                  <div className="px-3 py-2 border-t border-gray-100 dark:border-gray-800 text-xs flex gap-2 overflow-x-auto bg-white dark:bg-gray-900">
                    <span className="text-gray-300 dark:text-gray-600 shrink-0 py-1">photos:</span>
                    {detail.resources.map((r) => (
                      <button
                        key={r}
                        className="shrink-0 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 rounded-full px-2.5 py-1 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 hover:border-emerald-300 dark:hover:border-emerald-700 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors"
                        onClick={() => insert(`![${r.replace(/\.[a-z]+$/, "")}](${r})`)}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Hugo preview */}
              {showPreview && (
              <div className="flex-1 min-w-0 flex flex-col bg-white dark:bg-gray-900">
                <div className="px-3 py-1.5 text-xs border-b border-gray-100 dark:border-gray-800 flex items-center gap-2 bg-gray-50/50 dark:bg-gray-800">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="font-medium text-gray-500 dark:text-gray-300">Hugo preview</span>
                  <button
                    onClick={() => setPhonePreview((v) => !v)}
                    className={`text-[11px] rounded-full border px-2 py-0.5 transition-colors ${
                      phonePreview
                        ? "bg-emerald-50 dark:bg-emerald-900/30 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300"
                        : "border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                    }`}
                  >
                    📱 phone
                  </button>
                  <button
                    className="ml-auto text-[11px] text-gray-400 dark:text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
                    onClick={() => setPreviewKey((k) => k + 1)}
                  >
                    reload ↻
                  </button>
                </div>
                <div className={`flex-1 flex justify-center ${phonePreview ? "bg-gray-100 dark:bg-gray-800" : ""}`}>
                  <iframe
                    key={previewKey}
                    title="Hugo preview"
                    className={`h-full bg-white ${phonePreview ? "w-[375px] border-x border-gray-200 dark:border-gray-700" : "w-full"}`}
                    src={activeSlug ? previewUrl(permalink) : "about:blank"}
                    onLoad={(e) => {
                      // The preview pane is small, so Hugo's lazy-loaded images
                      // below the fold never enter the browser's load margin and
                      // render blank. Same-origin since we proxy, so force-eager.
                      const doc = (e.target as HTMLIFrameElement).contentDocument;
                      if (doc) {
                        for (const img of Array.from(doc.images)) img.loading = "eager";
                      }
                      applyPreviewDark(e.target as HTMLIFrameElement, dark);
                    }}
                  />
                </div>
              </div>
              )}

              {/* Front-matter slide-over drawer */}
              {showDetails && (
                <div className="absolute inset-y-0 right-0 w-96 bg-white dark:bg-gray-900 shadow-2xl border-l border-gray-200 dark:border-gray-800 overflow-y-auto z-20 animate-[slideIn_.15s_ease-out]">
                  <div className="sticky top-0 bg-white/90 dark:bg-gray-900/90 backdrop-blur border-b border-gray-100 dark:border-gray-800 px-4 py-2.5 flex items-center">
                    <span className="text-sm font-semibold text-gray-700 dark:text-gray-200">Post details</span>
                    <button
                      className="ml-auto text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-lg leading-none px-1"
                      onClick={() => setShowDetails(false)}
                      title="Close (Esc)"
                    >
                      ×
                    </button>
                  </div>
                  <div className="p-4">
                    <FrontMatterForm
                      detail={detail}
                      onChange={(fm) => {
                        setDetail({ ...detail, frontMatter: fm });
                        setDirty(true);
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
