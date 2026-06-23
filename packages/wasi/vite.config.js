// vite.config.js
import typescript from "@rollup/plugin-typescript";
import { resolve } from "path";
import { defineConfig } from "vite";

// Cross-origin isolation headers.
//
// wasix-libc binaries import a shared `env.memory`, and WASIXWorkerHost
// uses SharedArrayBuffer + Atomics.wait between the main thread and the
// dedicated worker. Browsers gate both behind cross-origin isolation,
// which requires:
//
//   Cross-Origin-Opener-Policy:   same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//
// We set them on both the dev server (`vite`) and the preview server
// (`vite preview`); the `npm run test:server` script used by Playwright
// points at `vite --port 5173` and picks them up from here.
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  server: {
    headers: crossOriginIsolationHeaders,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
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
