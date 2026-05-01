// Constants shared between the build script, the fetch script, and the
// Playwright spec. Run by Node directly via the built-in TS type-stripping
// (Node 24+); imported by Playwright's TS pipeline for the spec.

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pinned wasmer SHA. To bump:
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
 */
export function resolveWasixIncludeDirs(): string[] {
  const root = join(pkgDir, WASIX_VENDOR_DIR, "wasmer", "tests", "wasix");
  if (!existsSync(root)) return [];
  const entries: string[] = [];
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
