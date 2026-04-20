// Wasmer wasix integration suite runner.
//
// Iterates over every `.wasm` under `public/bin/wasix-tests/` that the
// build harness produced, runs it through `WASIX.start` in each browser
// project, and expects exit code 0.
//
// Tests listed in `WASIX_SUITE_SKIPS` are marked `test.fixme()` with the
// structured reason token — they still show up in the Playwright report
// so triage can see the categorised skip distribution. Tests that failed
// to build under wasixcc are auto-tagged `requires-wasixcc-build-fix` by
// reading the sidecar `wasix-suite.build-skip.json` the build script
// emits.
//
// Per-test wiring (Issue #4):
//   - Each wasmer test directory ships a `run.sh` of the form:
//       `$WASMER_RUN main.wasm --volume . -- <subcommand tokens>`
//     The tokens after `--` are the guest `args`. The harness parses
//     them at Node-time and passes them into `page.evaluate` so each
//     test sees the right argv.
//   - `--volume .` maps the test directory's input files (everything
//     beyond `main.c` / `run.sh`) into the guest's preopened ".". Each
//     test run starts with a fresh in-memory filesystem seeded from
//     those inputs, so per-test isolation is preserved.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

import type { WASIX, WASIXContext, WASIFS } from "../lib/main";
import { WASIX_SUITE_BIN_DIR, WASIX_VENDOR_DIR } from "./wasix-suite.config";
import type { SkipEntry } from "./wasix-suite.skip";
import { WASIX_SUITE_SKIPS } from "./wasix-suite.skip";

const pkgDir = process.cwd();
const binDir = join(pkgDir, WASIX_SUITE_BIN_DIR);
const wasixTestsDir = join(
  pkgDir,
  WASIX_VENDOR_DIR,
  "wasmer",
  "tests",
  "wasix",
);
const buildSkipPath = join(pkgDir, "tests", "wasix-suite.build-skip.json");

// Files present in every wasmer test directory that are never part of
// the preopened input mapping.
const NON_INPUT_FILES = new Set(["main.c", "run.sh", "Makefile", "README.md"]);

type TestInput = {
  /** Path inside the guest filesystem, relative to the preopen ("."). */
  path: string;
  /** Raw bytes, serialisable across `page.evaluate`. */
  bytes: number[];
};

type TestPlan = {
  name: string;
  wasmUrl: string;
  args: string[];
  inputs: TestInput[];
};

function listWasmBinaries(): string[] {
  try {
    return readdirSync(binDir)
      .filter((name) => name.endsWith(".wasm"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Extract the subcommand tokens from a wasmer `run.sh`.
 *
 * Expected shape:
 *   `$WASMER_RUN main.wasm --volume . -- <subcommand tokens>`
 * Tokens after the first `--` are returned as the guest argv (excluding
 * argv[0]; the runtime prepends the program name). If the script doesn't
 * contain a `--` separator, returns an empty array.
 *
 * Handles `\`-continued line joins, strips a leading `#!` shebang and
 * blank/comment lines, and tokenises the run line with a small POSIX-ish
 * splitter that honours single/double quotes and backslash escapes. We
 * don't need full shell semantics — every wasmer run.sh is a single
 * top-level invocation of the wasmer runner.
 */
function parseRunSh(source: string): string[] {
  const body = source
    .split("\n")
    .filter((line) => !line.startsWith("#!") && !/^\s*#/.test(line))
    .map((line) => line.trimEnd())
    .join("\n")
    // Join backslash-continued lines.
    .replace(/\\\n/g, " ");

  // Find the run line: the first line that mentions `main.wasm` (every
  // wasmer run.sh invokes the runner on exactly one wasm artifact).
  const runLine = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .find((line) => line.includes("main.wasm"));

  if (!runLine) return [];

  const tokens = shellSplit(runLine);
  const sep = tokens.indexOf("--");
  if (sep === -1) return [];
  return tokens.slice(sep + 1);
}

/**
 * Minimal POSIX-style tokeniser: splits on whitespace, honours single
 * and double quotes, and treats `\<ch>` as a literal. Does not expand
 * variables or globs — wasmer `run.sh` scripts are trivial enough that
 * literal tokens survive intact (the `$WASMER_RUN` placeholder tokens
 * are discarded because none of them appear after `--`).
 */
function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else cur += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "\\" && i + 1 < input.length) {
        cur += input[++i];
      } else cur += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i];
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Walk `dir` recursively and return every regular file's bytes keyed by
 * path relative to `dir`. Used to seed the per-test preopen from the
 * test directory's non-source inputs.
 */
function collectInputs(dir: string): TestInput[] {
  if (!existsSync(dir)) return [];
  const out: TestInput[] = [];
  const walk = (sub: string) => {
    for (const entry of readdirSync(join(dir, sub))) {
      const rel = sub === "" ? entry : `${sub}/${entry}`;
      const abs = join(dir, rel);
      const st = statSync(abs);
      if (st.isDirectory()) {
        walk(rel);
        continue;
      }
      if (!st.isFile()) continue;
      // Skip source / metadata files at the top level. Anything nested
      // (e.g. inputs in a `fixture/` subdir) is kept verbatim.
      if (sub === "" && NON_INPUT_FILES.has(entry)) continue;
      const bytes = readFileSync(abs);
      out.push({ path: rel, bytes: Array.from(bytes) });
    }
  };
  walk("");
  return out;
}

function readBuildSkipTests(): Set<string> {
  try {
    const raw = readFileSync(buildSkipPath, "utf8");
    const parsed = JSON.parse(raw) as { tests?: string[] };
    return new Set(parsed.tests ?? []);
  } catch {
    return new Set();
  }
}

function planForTest(name: string): TestPlan {
  const srcDir = join(wasixTestsDir, name);
  const runShPath = join(srcDir, "run.sh");
  let args: string[] = [];
  if (existsSync(runShPath)) {
    try {
      args = parseRunSh(readFileSync(runShPath, "utf8"));
    } catch {
      args = [];
    }
  }
  return {
    name,
    wasmUrl: `/bin/wasix-tests/${name}.wasm`,
    args,
    inputs: collectInputs(srcDir),
  };
}

const binaries = listWasmBinaries();
const buildFailures = readBuildSkipTests();

test.describe("wasix integration suite (wasmer/tests/wasix)", () => {
  if (binaries.length === 0) {
    test("no wasix suite binaries built", () => {
      test.info().annotations.push({
        type: "skip-reason",
        description:
          "public/bin/wasix-tests/ is empty — run `npm run test:prepare:wasix-suite` with wasixcc installed to populate it.",
      });
      test.skip();
    });
    return;
  }

  test.beforeEach(async ({ page }) => {
    await page.goto("http://localhost:5173");
    await page.waitForLoadState("domcontentloaded");
  });

  for (const file of binaries) {
    const name = file.replace(/\.wasm$/, "");
    const handAuthoredSkip: SkipEntry | undefined = WASIX_SUITE_SKIPS[name];
    const skip: SkipEntry | undefined = buildFailures.has(name)
      ? {
          reason: "requires-wasixcc-build-fix",
          note:
            handAuthoredSkip?.note ??
            "wasixcc failed to build this test during prepare step.",
        }
      : handAuthoredSkip;

    const plan = planForTest(name);

    test(`wasix-suite: ${name}`, async ({ page }) => {
      if (skip) {
        test.info().annotations.push({
          type: "wasix-skip",
          description: skip.note
            ? `${skip.reason} — ${skip.note}`
            : skip.reason,
        });
        test.fixme(true, `wasix-skip:${skip.reason}`);
      }

      const result = await page.evaluate(async (p: TestPlan) => {
        while (
          (window as unknown as { WASIX?: unknown })["WASIX"] === undefined
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        const w = window as unknown as {
          WASIX: typeof WASIX;
          WASIXContext: typeof WASIXContext;
        };
        const W = w.WASIX;
        const WC = w.WASIXContext;

        // Seed a fresh WASIFS for this run from the per-test inputs.
        // Paths are rooted at `/` so they resolve through the single
        // preopen (".") the WASIDrive exposes.
        const now = new Date();
        const fs: WASIFS = {};
        for (const input of p.inputs) {
          const guestPath = `/${input.path}`;
          fs[guestPath] = {
            path: guestPath,
            timestamps: { access: now, modification: now, change: now },
            mode: "binary",
            content: new Uint8Array(input.bytes),
          };
        }

        let stdout = "";
        let stderr = "";

        const wasiResult = await W.start(
          fetch(p.wasmUrl),
          new WC({
            args: p.args,
            stdout: (out: string) => {
              stdout += out;
            },
            stderr: (err: string) => {
              stderr += err;
            },
            stdin: () => null,
            fs,
          }),
        );

        return {
          exitCode: wasiResult.exitCode,
          stdout,
          stderr,
        };
      }, plan);

      expect(
        result.exitCode,
        `args: ${JSON.stringify(plan.args)}\ninputs: ${plan.inputs
          .map((i) => i.path)
          .join(", ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
    });
  }
});
