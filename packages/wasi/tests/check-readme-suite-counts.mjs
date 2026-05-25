#!/usr/bin/env node
//
// Verify the README's wasmer-suite pass/skip line is in sync with the
// latest Playwright JSON report. Designed to run in CI after the suite
// step but also locally via `npm run test:wasix-suite:check-readme`.
//
// Inputs:
//   - playwright-report/wasix-suite.json (Playwright's --reporter=json output)
//   - README.md (must contain the canonical line between the
//     <!-- WASIX_SUITE_COUNTS --> sentinels)
//
// Behaviour:
//   - Aggregates pass / skip counts and the wasix-skip-annotation breakdown
//     using the same shape the workflow's jq query computes.
//   - Builds the canonical line and compares against what the README has
//     between the sentinels.
//   - Exits non-zero with an unambiguous diff message if drift is detected,
//     printing the expected text so a developer can paste it.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(HERE, "..");
const REPORT_PATH = join(PKG_DIR, "playwright-report", "wasix-suite.json");
const README_PATH = join(PKG_DIR, "README.md");

const SENTINEL_OPEN = "<!-- WASIX_SUITE_COUNTS -->";
const SENTINEL_CLOSE = "<!-- /WASIX_SUITE_COUNTS -->";

function fail(msg) {
  process.stderr.write(`check-readme-suite-counts: ${msg}\n`);
  process.exit(1);
}

if (!existsSync(REPORT_PATH)) {
  fail(
    `no Playwright JSON report at ${REPORT_PATH}. Run \`npx playwright test tests/wasix-suite.spec.ts --reporter=json\` first.`,
  );
}

let report;
try {
  report = JSON.parse(readFileSync(REPORT_PATH, "utf8"));
} catch (err) {
  fail(`failed to parse ${REPORT_PATH}: ${err.message}`);
}

const stats = report?.stats ?? {};
const passed = Number(stats.expected ?? 0);
const skipped = Number(stats.skipped ?? 0);
const total =
  passed + Number(stats.unexpected ?? 0) + skipped + Number(stats.flaky ?? 0);

// Walk the suites tree the same way the CI workflow's jq query does:
//   .suites[]?.suites[]?.specs[]?.tests[]?.annotations[]
// Collect every annotation typed `wasix-skip` and group by reason token.
function collectAnnotations(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.annotations)) {
    for (const ann of node.annotations) {
      if (ann?.type === "wasix-skip" && typeof ann.description === "string") {
        // The description is shaped `<token> — <note>` by the spec; we only
        // care about the token.
        const token = ann.description.split(" — ")[0].trim();
        out.push(token);
      }
    }
  }
  for (const key of ["suites", "specs", "tests"]) {
    const arr = node[key];
    if (Array.isArray(arr)) {
      for (const child of arr) collectAnnotations(child, out);
    }
  }
}

const tokens = [];
if (Array.isArray(report?.suites)) {
  for (const suite of report.suites) collectAnnotations(suite, tokens);
}

// Group + sort alphabetically by token.
const counts = new Map();
for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
const breakdown = [...counts.entries()]
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([reason, count]) => `${reason}: ${count}`)
  .join(", ");

const canonical =
  breakdown.length > 0
    ? `${passed}/${total} wasmer tests pass, ${skipped} skipped: ${breakdown}`
    : `${passed}/${total} wasmer tests pass, ${skipped} skipped`;

if (!existsSync(README_PATH)) {
  fail(`README not found at ${README_PATH}`);
}
const readme = readFileSync(README_PATH, "utf8");

const openIdx = readme.indexOf(SENTINEL_OPEN);
const closeIdx = readme.indexOf(SENTINEL_CLOSE);
if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) {
  fail(
    `README is missing the ${SENTINEL_OPEN} / ${SENTINEL_CLOSE} sentinel block. Expected line:\n  ${canonical}`,
  );
}

const between = readme.slice(openIdx + SENTINEL_OPEN.length, closeIdx);

if (!between.includes(canonical)) {
  process.stderr.write(
    [
      "README pass/skip line is out of date.",
      "",
      "Expected (between the WASIX_SUITE_COUNTS sentinels):",
      `  ${canonical}`,
      "",
      "Found:",
      between
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    ].join("\n") + "\n",
  );
  process.exit(1);
}

process.stdout.write(`README pass/skip line OK: ${canonical}\n`);
