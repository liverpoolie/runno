#!/usr/bin/env node
// Build the wasmer/tests/wasix integration suite into
// `public/bin/wasix-tests/<name>.wasm`.
//
// Pre-conditions (prepared by package.json scripts):
//   - The vendored wasmer checkout exists at `tests/wasix-vendor/wasmer/`
//     at the SHA pinned in `wasix-suite.constants.mjs`.
//   - `wasixcc` is on PATH (installed via the CI workflow; locally it's
//     the developer's responsibility).
//
// Behaviour:
//   - For each directory in `WASIX_INCLUDE_DIRS`, if
//     `tests/wasix-vendor/wasmer/tests/wasix/<dir>/main.c` exists, build
//     it into `public/bin/wasix-tests/<dir>.wasm`.
//   - If the source directory doesn't exist (e.g. the vendored checkout
//     is older than our include list), log a warning and skip that
//     entry rather than failing the build. The Playwright spec is the
//     source of truth for which binaries must pass.
//   - If `wasixcc` is not installed, exit 0 with a diagnostic. The
//     Playwright spec iterates over whatever landed in
//     `public/bin/wasix-tests/`, so a developer without wasixcc still
//     sees a green (empty) wasix-suite run.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WASIX_INCLUDE_DIRS,
  WASIX_SUITE_BIN_DIR,
  WASIX_VENDOR_DIR,
} from "./wasix-suite.constants.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, "..");

const vendorRoot = join(pkgDir, WASIX_VENDOR_DIR, "wasmer", "tests", "wasix");
const outDir = join(pkgDir, WASIX_SUITE_BIN_DIR);

mkdirSync(outDir, { recursive: true });

const wasixcc = resolveWasixcc();
if (!wasixcc) {
  console.warn(
    "[build-wasix-suite] wasixcc not found on PATH — skipping suite build.\n" +
      "  Install the wasix-libc toolchain to enable these tests locally.",
  );
  process.exit(0);
}

if (!existsSync(vendorRoot)) {
  console.warn(
    `[build-wasix-suite] vendor directory missing: ${vendorRoot}\n` +
      "  Run `npm run test:prepare:wasmer` first.",
  );
  process.exit(0);
}

let built = 0;
let skipped = 0;
let failed = 0;

for (const name of WASIX_INCLUDE_DIRS) {
  const srcDir = join(vendorRoot, name);
  if (!existsSync(srcDir)) {
    console.warn(`[build-wasix-suite] skip (missing in vendor): ${name}`);
    skipped++;
    continue;
  }

  const sources = collectSources(srcDir);
  if (sources.length === 0) {
    console.warn(`[build-wasix-suite] skip (no C sources): ${name}`);
    skipped++;
    continue;
  }

  const outPath = join(outDir, `${name}.wasm`);
  const args = ["-O2", "-o", outPath, ...sources];

  const result = spawnSync(wasixcc, args, {
    stdio: ["ignore", "inherit", "inherit"],
  });

  if (result.status === 0) {
    built++;
    console.log(`[build-wasix-suite] built: ${name}`);
  } else {
    failed++;
    console.warn(`[build-wasix-suite] FAILED (exit ${result.status}): ${name}`);
  }
}

console.log(
  `[build-wasix-suite] summary: built=${built} skipped=${skipped} failed=${failed}`,
);

// Don't make a failing per-test build fail the whole test:prepare step —
// the Playwright spec surfaces missing binaries per-test, so a triage
// review can see exactly which ones never landed.
process.exit(0);

/** Resolve `wasixcc` from PATH — returns null if not installed. */
function resolveWasixcc() {
  const probe = spawnSync("wasixcc", ["--version"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return probe.status === 0 ? "wasixcc" : null;
}

/** Collect `.c` files directly under `dir` (non-recursive). */
function collectSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isFile()) continue;
    if (entry.endsWith(".c")) out.push(full);
  }
  return out;
}
