#!/usr/bin/env node
// Build the wasmer/tests/wasix integration suite into
// `public/bin/wasix-tests/<name>.wasm`.
//
// Pre-conditions (prepared by package.json scripts):
//   - The vendored wasmer checkout exists at `tests/wasix-vendor/wasmer/`
//     at the SHA pinned in `wasix-suite.constants.ts`.
//   - `wasixcc` is on PATH. Locally: `npm run wasix:install-tools`.
//
// Behaviour:
//   - For each directory in `resolveWasixIncludeDirs()`, build
//     `tests/wasix-vendor/wasmer/tests/wasix/<dir>/main.c` into
//     `public/bin/wasix-tests/<dir>.wasm`.
//   - If the source directory has no C sources, log and continue (the
//     vendored upstream may have non-C subdirs we don't compile).
//   - If `wasixcc` is missing, the vendor dir is missing, or any
//     individual build fails, exit non-zero. Build failures are not
//     silently absorbed: the fix is to repair the build, not to skip.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveWasixIncludeDirs,
  WASIX_SUITE_BIN_DIR,
  WASIX_VENDOR_DIR,
} from "./wasix-suite.constants.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, "..");

const vendorRoot = join(pkgDir, WASIX_VENDOR_DIR, "wasmer", "tests", "wasix");
const outDir = join(pkgDir, WASIX_SUITE_BIN_DIR);

mkdirSync(outDir, { recursive: true });

const wasixcc = resolveWasixcc();
if (!wasixcc) {
  console.error(
    "[build-wasix-suite] wasixcc not found on PATH.\n" +
      "  Install via `npm run wasix:install-tools` (or follow " +
      "https://github.com/wasix-org/wasix-libc) and re-run.",
  );
  process.exit(1);
}

if (!existsSync(vendorRoot)) {
  console.error(
    `[build-wasix-suite] vendor directory missing: ${vendorRoot}\n` +
      "  Run `npm run test:prepare:wasmer` first.",
  );
  process.exit(1);
}

let built = 0;
let failed = 0;
const buildFailures: string[] = [];

const includeDirs = resolveWasixIncludeDirs();

for (const name of includeDirs) {
  const srcDir = join(vendorRoot, name);
  if (!existsSync(srcDir)) {
    console.warn(`[build-wasix-suite] skip (missing in vendor): ${name}`);
    continue;
  }

  const sources = collectSources(srcDir);
  if (sources.length === 0) {
    console.warn(`[build-wasix-suite] skip (no C sources): ${name}`);
    continue;
  }

  const outPath = join(outDir, `${name}.wasm`);
  // Several upstream wasmer tests call fork() / etc. without including
  // the right wasix-libc headers. wasixcc's clang (C99+) rejects the
  // implicit declarations as errors; demote to warnings so the
  // resulting binaries still link against the wasix-libc symbols.
  const args = [
    "-O2",
    "-Wno-error=implicit-function-declaration",
    "-o",
    outPath,
    ...sources,
  ];

  const result = spawnSync(wasixcc, args, {
    stdio: ["ignore", "inherit", "inherit"],
  });

  if (result.status === 0) {
    built++;
    console.log(`[build-wasix-suite] built: ${name}`);
  } else {
    failed++;
    buildFailures.push(name);
    console.error(
      `[build-wasix-suite] FAILED (exit ${result.status}): ${name}`,
    );
  }
}

console.log(`[build-wasix-suite] summary: built=${built} failed=${failed}`);

if (failed > 0) {
  console.error(
    `[build-wasix-suite] ${failed} test(s) failed to build: ${buildFailures.join(", ")}\n` +
      "  Fix the build — do not skip.",
  );
  process.exit(1);
}

if (built === 0) {
  console.error(
    "[build-wasix-suite] produced zero binaries — vendor dir empty or " +
      "include list is empty. Check `npm run test:prepare:wasmer`.",
  );
  process.exit(1);
}

/** Resolve `wasixcc` from PATH — returns null if not installed. */
function resolveWasixcc(): string | null {
  const probe = spawnSync("wasixcc", ["--version"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return probe.status === 0 ? "wasixcc" : null;
}

/** Collect `.c` files directly under `dir` (non-recursive). */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isFile()) continue;
    if (entry.endsWith(".c")) out.push(full);
  }
  return out;
}
