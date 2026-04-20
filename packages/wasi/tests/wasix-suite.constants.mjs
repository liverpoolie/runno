// Plain ES-module constants shared between the TypeScript Playwright
// spec and the Node build script. Kept as `.mjs` so `node` can import
// it directly (no ts-loader), while `wasix-suite.config.ts` re-exports
// from here for type-checked consumers.
//
// When bumping the pinned wasmer SHA, update this file only — the `.ts`
// facade just re-exports.

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pinned wasmer SHA (2026-04-21). To bump:
 *   1. Update the constant here.
 *   2. Re-run `npm run test:prepare:wasmer` to refresh the vendored
 *      `tests/wasix-vendor/wasmer/` checkout.
 *   3. Triage any newly-failing tests into `wasix-suite.skip.ts`.
 */
export const WASMER_SHA = "261a337d428148a9f06884c10478dd634a1f1da7";

/**
 * Relative path (from `packages/wasi/`) where the vendored wasmer checkout
 * lives. Kept out of git — `.gitignore` excludes `tests/wasix-vendor/`.
 */
export const WASIX_VENDOR_DIR = "tests/wasix-vendor";

/**
 * Output directory for built .wasm binaries, relative to `packages/wasi/`.
 * The Playwright spec fetches from `/bin/wasix-tests/<name>.wasm`.
 */
export const WASIX_SUITE_BIN_DIR = "public/bin/wasix-tests";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, "..");

/**
 * Resolve the list of wasmer test directories currently present in the
 * vendored checkout. The fetch script is the source of truth for what
 * exists on disk; this helper reads it back so the build script and the
 * Playwright spec iterate the same set without a hand-maintained list
 * that would drift every time a new test category lands upstream.
 *
 * Returns an empty array if the vendor directory is missing (pre-fetch
 * state, or a CI runner where the fetch step degraded). Callers treat
 * an empty result as "no tests to build / run", same as before.
 */
export function resolveWasixIncludeDirs() {
  const root = join(pkgDir, WASIX_VENDOR_DIR, "wasmer", "tests", "wasix");
  if (!existsSync(root)) return [];
  const entries = [];
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    try {
      if (statSync(abs).isDirectory()) entries.push(name);
    } catch {
      // best effort — skip anything we can't stat
    }
  }
  return entries.sort();
}

/**
 * Subdirectories under `wasmer/tests/wasix/` that we consider part of the
 * suite. Populated from the vendored checkout at module-load time; empty
 * on runners where the fetch step hasn't happened yet.
 *
 * Kept as an eagerly-resolved array (not a thunk) so the existing import
 * shape in `wasix-suite.config.ts` stays a plain `readonly string[]`.
 */
export const WASIX_INCLUDE_DIRS = resolveWasixIncludeDirs();
