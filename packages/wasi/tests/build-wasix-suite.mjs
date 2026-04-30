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
//   - If `wasixcc` is not installed, exit 0 with a diagnostic so a
//     developer without wasixcc still sees a green (empty) wasix-suite
//     run. CI overrides this via `WASIX_SUITE_REQUIRE_BUILD=1`, which
//     promotes a missing toolchain or zero produced binaries to a hard
//     failure — silent green on CI is a footgun (Issue #4 review).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveWasixIncludeDirs,
  WASIX_SUITE_BIN_DIR,
  WASIX_VENDOR_DIR,
} from "./wasix-suite.constants.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, "..");

const vendorRoot = join(pkgDir, WASIX_VENDOR_DIR, "wasmer", "tests", "wasix");
const outDir = join(pkgDir, WASIX_SUITE_BIN_DIR);

// Sidecar file of tests that failed to build. The Playwright spec reads
// it alongside the hand-authored skip map and tags those tests
// `requires-wasixcc-build-fix` — per the Issue #4 contract that build
// failures auto-populate into the skip list instead of silently masking
// runtime regressions.
const buildSkipPath = join(__dirname, "wasix-suite.build-skip.json");

mkdirSync(outDir, { recursive: true });

// CI sets this to forbid silent no-ops. See Issue #4 review: a missing
// wasixcc used to greenwash the whole harness with a single categorised
// skip. Locally it stays unset so a casual developer can run other test
// suites without the wasix toolchain installed.
const requireBuild = process.env.WASIX_SUITE_REQUIRE_BUILD === "1";

const wasixcc = resolveWasixcc();
if (!wasixcc) {
  const msg =
    "[build-wasix-suite] wasixcc not found on PATH — install the wasix " +
    "toolchain (wasix-org/wasix-libc + wasix-org/wasixcc) to build the suite.";
  if (requireBuild) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(`${msg}\n  Skipping suite build.`);
  writeBuildSkip([]);
  process.exit(0);
}

if (!existsSync(vendorRoot)) {
  const msg = `[build-wasix-suite] vendor directory missing: ${vendorRoot}`;
  if (requireBuild) {
    console.error(`${msg}\n  Run \`npm run test:prepare:wasmer\` first.`);
    process.exit(1);
  }
  console.warn(`${msg}\n  Run \`npm run test:prepare:wasmer\` first.`);
  writeBuildSkip([]);
  process.exit(0);
}

let built = 0;
let skipped = 0;
let failed = 0;
const buildFailures = [];

// Re-resolve at this point rather than trusting the module-load-time
// snapshot — `test:prepare:wasmer` may have populated the vendor dir
// between module import and the build step in the combined prepare run.
const includeDirs = resolveWasixIncludeDirs();

for (const name of includeDirs) {
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
    buildFailures.push(name);
    console.warn(`[build-wasix-suite] FAILED (exit ${result.status}): ${name}`);
  }
}

writeBuildSkip(buildFailures);

console.log(
  `[build-wasix-suite] summary: built=${built} skipped=${skipped} failed=${failed}`,
);

// In CI, refuse to produce zero binaries. The Playwright spec still
// reports per-test build failures via the `requires-wasixcc-build-fix`
// reason, but a wholesale empty result means the install step is
// broken — surface that loudly instead of greenwashing the job.
if (requireBuild && built === 0) {
  console.error(
    "[build-wasix-suite] WASIX_SUITE_REQUIRE_BUILD=1 set but produced zero " +
      "binaries — refusing to continue. Check the wasixcc install.",
  );
  process.exit(1);
}

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

/**
 * Persist the list of build-failed test names to a sidecar JSON file.
 * The Playwright spec merges this list with the hand-authored skip map
 * using the `requires-wasixcc-build-fix` reason token from Issue #4.
 *
 * Writing an empty list is intentional: it clears a stale sidecar from a
 * previous run so the "green (empty) wasix-suite" degrade path stays
 * truly green instead of inheriting failures from a prior build.
 */
function writeBuildSkip(failures) {
  const payload = {
    generatedAt: new Date().toISOString(),
    reason: "requires-wasixcc-build-fix",
    tests: failures.slice().sort(),
  };
  writeFileSync(buildSkipPath, `${JSON.stringify(payload, null, 2)}\n`);
}
