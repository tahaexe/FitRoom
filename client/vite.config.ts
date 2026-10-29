import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
  preview: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // Installed Vite 8 builds on Rolldown: extra pages enter through
    // build.rolldownOptions.input (build.rollupOptions is its deprecated
    // alias), so /store.html is a real file in dist, never the SPA fallback.
    rolldownOptions: {
      input: {
        main: resolve(here, "index.html"),
        store: resolve(here, "store.html"),
      },
    },
  },
});
