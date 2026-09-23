import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "editor",
  publicDir: false, // repo-root public/ is Hugo's output dir; watching it reloads the editor on every hugo rebuild
  plugins: [react()],
  server: {
    port: 1415,
    watch: {
      // Hugo rewrites public/ on every content change; watching it reloads the
      // editor (losing state) on every save. content/ only changes via the
      // editor itself or external tools — neither needs an HMR reload.
      ignored: ["**/public/**", "**/content/**"],
    },
    proxy: {
      "/api/": "http://127.0.0.1:1416",
      // Same-origin Hugo preview: lets the UI inspect the rendered page.
      "/hugo": {
        target: "http://127.0.0.1:1414",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/hugo/, ""),
      },
      // Hugo pages reference assets at root-absolute paths (page bundles live
      // under /blog/..., static under /css|/images|/js); forward them too so
      // the preview iframe renders fully styled with working images.
      "/blog": { target: "http://127.0.0.1:1414", changeOrigin: true },
      "/categories": { target: "http://127.0.0.1:1414", changeOrigin: true },
      "/tags": { target: "http://127.0.0.1:1414", changeOrigin: true },
      "/about": { target: "http://127.0.0.1:1414", changeOrigin: true },
      "/css": { target: "http://127.0.0.1:1414", changeOrigin: true },
      "/images": { target: "http://127.0.0.1:1414", changeOrigin: true },
      "/js": { target: "http://127.0.0.1:1414", changeOrigin: true },
      "/livereload.js": { target: "ws://127.0.0.1:1414", ws: true, changeOrigin: true },
    },
  },
});
