#!/usr/bin/env node
// Fetch `wasmer/tests/wasix/` at the pinned SHA and extract into
// `tests/wasix-vendor/wasmer/tests/wasix/`.
//
// We don't do a full git clone — just pull the tarball for the pinned
// commit and unpack the `tests/wasix/` subtree. This keeps the vendored
// directory small and the fetch fast.
//
// Behaviour:
//   - Idempotent: if the target directory already contains a
//     `.pinned-sha` matching `WASMER_SHA`, skip the fetch entirely.
//   - Writes `.pinned-sha` alongside the extracted tree so re-runs
//     after a bump repopulate deterministically.
//   - Exits 0 on network failure with a diagnostic — CI controls
//     whether that's fatal by branching on `test:prepare:wasix-suite`
//     separately.

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { pipeline } from "node:stream/promises";

import { WASMER_SHA, WASIX_VENDOR_DIR } from "./wasix-suite.constants.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(__dirname, "..");
const vendorRoot = join(pkgDir, WASIX_VENDOR_DIR, "wasmer");
const pinnedShaFile = join(vendorRoot, ".pinned-sha");

if (existsSync(pinnedShaFile)) {
  const current = readFileSync(pinnedShaFile, "utf8").trim();
  if (current === WASMER_SHA) {
    console.log(
      `[fetch-wasmer-tests] already at pinned SHA ${WASMER_SHA}; skipping fetch.`,
    );
    process.exit(0);
  }
  console.log(
    `[fetch-wasmer-tests] vendored SHA ${current} differs from pinned ${WASMER_SHA}; refetching.`,
  );
  rmSync(vendorRoot, { recursive: true, force: true });
}

mkdirSync(vendorRoot, { recursive: true });

const url = `https://codeload.github.com/wasmerio/wasmer/tar.gz/${WASMER_SHA}`;
const tmpFile = join(
  tmpdir(),
  `wasmer-${WASMER_SHA.slice(0, 12)}-${process.pid}.tar.gz`,
);

try {
  await downloadTarball(url, tmpFile);
} catch (err) {
  console.warn(
    `[fetch-wasmer-tests] failed to download ${url}: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(0);
}

// Extract only `wasmer-<sha>/tests/wasix/`, stripping the leading
// `wasmer-<sha>/` path component.
const stripComponents = 1;
const extractArgs = [
  "-xzf",
  tmpFile,
  "-C",
  vendorRoot,
  "--strip-components",
  String(stripComponents),
  `wasmer-${WASMER_SHA}/tests/wasix`,
];

const extract = spawnSync("tar", extractArgs, {
  stdio: ["ignore", "inherit", "inherit"],
});

// Always clean up the tarball.
try {
  rmSync(tmpFile, { force: true });
} catch {
  // best effort
}

if (extract.status !== 0) {
  console.warn(
    `[fetch-wasmer-tests] tar extraction failed (exit ${extract.status}).`,
  );
  process.exit(0);
}

writeFileSync(pinnedShaFile, `${WASMER_SHA}\n`);
console.log(
  `[fetch-wasmer-tests] extracted tests/wasix/ at ${WASMER_SHA} into ${vendorRoot}.`,
);

/** Download `url` to `dest` via native fetch streaming. */
async function downloadTarball(url, dest) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "runno-wasix-suite-fetch" },
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  await pipeline(res.body, createWriteStream(dest));
}
