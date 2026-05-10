// vite.config.js
import typescript from "@rollup/plugin-typescript";
import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  // wasix-libc binaries import a shared `env.memory`. Browsers reject
  // SharedArrayBuffer-backed memories unless the host page is
  // cross-origin-isolated (COOP `same-origin` + COEP `require-corp`).
  // The Playwright suite drives the dev server via `test:server`, so the
  // headers carry into every test run.
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    copyPublicDir: false, // Public dir contains testing binaries
    lib: {
      formats: ["es"],
      entry: resolve(__dirname, "lib/main.ts"),
      fileName: "lib/main",
    },
    rollupOptions: {
      // make sure to externalize deps that shouldn't be bundled
      // into your library
      external: [],
      output: {
        // Provide global variables to use in the UMD build
        // for externalized deps
        globals: {},
      },
    },
  },
  plugins: [
    {
      ...typescript({ outDir: "dist", exclude: ["src"] }),
      apply: "build",
    },
  ],
});
