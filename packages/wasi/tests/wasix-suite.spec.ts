// Wasmer wasix integration suite runner.
//
// Iterates over every `.wasm` under `public/bin/wasix-tests/` that the
// build harness produced, runs it through `WASIX.start` in each browser
// project, and expects exit code 0.
//
// Tests listed in `WASIX_SUITE_SKIPS` are marked `test.fixme()` with the
// structured reason token — they still show up in the Playwright report
// so triage can see the categorised skip distribution.
//
// Per-test wiring:
//   - Each wasmer test directory ships a `run.sh` of the form:
//       `$WASMER_RUN main.wasm --volume . -- <subcommand tokens>`
//     The tokens after `--` are the guest `args`. The harness parses
//     them at Node-time and passes them into `page.evaluate` so each
//     test sees the right argv.
//   - `--volume .` maps the test directory's input files (everything
//     beyond `main.c` / `run.sh`) into the guest's preopen tree. The
//     wasmer runner mounts `--volume .` at `/home` because that's
//     wasix-libc's compiled-in default cwd, so the harness mirrors
//     that: inputs are seeded under `/home/<rel-path>`, the FS
//     provider exposes `/home` as a preopen at fd 4, and `PWD` is set
//     so libc's startup path resolver finds the cwd before calling
//     `getcwd`.
//   - Each test run starts with a fresh in-memory filesystem seeded
//     from those inputs, so per-test isolation is preserved.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

import type {
  WASIX,
  WASIXContext,
  WASIXWorkerHost,
  WASIDriveFileSystemProvider,
  WASIFS,
} from "../lib/main";
import {
  WASIX_SUITE_BIN_DIR,
  WASIX_SUITE_MODES,
  WASIX_VENDOR_DIR,
  type WASIXSuiteMode,
} from "./wasix-suite.constants";
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

/**
 * Files the wasmer runner produces at runtime in the test directory
 * (the `--volume .` mount is the test source dir, into which wasmer
 * also writes `main.wasm` and the redirected `output` capture). They
 * are not present on disk for us to read, so the harness synthesises
 * empty placeholders alongside the on-disk inputs. Tests that
 * iterate the cwd listing (e.g. `closing-pre-opened-dirs`) assert
 * against these names.
 */
const SYNTHESIZED_RUNTIME_FILES = ["main.wasm", "output"] as const;

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
  /**
   * Absolute guest paths that the wasmer runner mounts via
   * `--volume host:guest` (e.g. `/data`, `/temp1`). The harness
   * pre-seeds each as an empty directory so file ops under those
   * mounts pass POSIX parent-exists checks.
   */
  mounts: string[];
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
  const tokens = runShTokens(source);
  const sep = tokens.indexOf("--");
  if (sep === -1) return [];
  return tokens.slice(sep + 1);
}

/**
 * Extract the absolute guest paths that the wasmer run.sh mounts via
 * `--volume host:guest` (or `--volume=host:guest`). A bare
 * `--volume host` (no colon) maps to wasix-libc's default cwd
 * (`/home`) and is already handled by the input seeding, so it is
 * skipped here.
 *
 * Used to pre-seed mount-point directories in the in-memory FS so
 * `open(O_CREAT)` under those mounts passes the drive's POSIX
 * parent-exists check (the wasmer runner provides them implicitly).
 */
function parseRunShVolumeMounts(source: string): string[] {
  const tokens = runShTokens(source);
  const stop = tokens.indexOf("--");
  const head = stop === -1 ? tokens : tokens.slice(0, stop);
  const targets: string[] = [];
  for (let i = 0; i < head.length; i++) {
    const tok = head[i];
    let arg: string | undefined;
    if (tok === "--volume" || tok === "--mapdir") {
      arg = head[i + 1];
      i++;
    } else if (tok.startsWith("--volume=") || tok.startsWith("--mapdir=")) {
      arg = tok.slice(tok.indexOf("=") + 1);
    } else {
      continue;
    }
    if (!arg) continue;
    const colon = arg.indexOf(":");
    if (colon === -1) continue;
    const guest = arg.slice(colon + 1);
    if (guest.startsWith("/")) {
      targets.push(guest);
    }
  }
  return targets;
}

function runShTokens(source: string): string[] {
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

  return shellSplit(runLine);
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
      const bytes = readFileSync(abs);
      out.push({ path: rel, bytes: Array.from(bytes) });
    }
  };
  walk("");
  // Append empty placeholders for the runtime artefacts that wasmer
  // would otherwise produce in the test directory (the binary itself
  // and the captured `output`). Tests that iterate cwd contents
  // assert these names, but our harness fetches the wasm separately
  // and never produces an output file.
  for (const synthetic of SYNTHESIZED_RUNTIME_FILES) {
    if (out.some((existing) => existing.path === synthetic)) continue;
    out.push({ path: synthetic, bytes: [] });
  }
  return out;
}

function planForTest(name: string): TestPlan {
  const srcDir = join(wasixTestsDir, name);
  const runShPath = join(srcDir, "run.sh");
  let args: string[] = [];
  let mounts: string[] = [];
  if (existsSync(runShPath)) {
    const source = readFileSync(runShPath, "utf8");
    try {
      args = parseRunSh(source);
    } catch {
      args = [];
    }
    try {
      mounts = parseRunShVolumeMounts(source);
    } catch {
      mounts = [];
    }
  }
  return {
    name,
    wasmUrl: `/bin/wasix-tests/${name}.wasm`,
    args,
    inputs: collectInputs(srcDir),
    mounts,
  };
}

const binaries = listWasmBinaries();

test.describe("wasix integration suite (wasmer/tests/wasix)", () => {
  test("at least one wasix-suite binary was built", () => {
    expect(
      binaries.length,
      "public/bin/wasix-tests/ is empty — run `npm run test:prepare:wasix-suite` " +
        "(install wasixcc via `npm run wasix:install-tools` first).",
    ).toBeGreaterThan(0);
  });

  if (binaries.length === 0) {
    return;
  }

  test.beforeEach(async ({ page }) => {
    await page.goto("http://localhost:5173");
    await page.waitForLoadState("domcontentloaded");
  });

  for (const file of binaries) {
    const name = file.replace(/\.wasm$/, "");
    const skip: SkipEntry | undefined = WASIX_SUITE_SKIPS[name];

    const plan = planForTest(name);

    for (const mode of WASIX_SUITE_MODES) {
      test(`wasix-suite [${mode}]: ${name}`, async ({ page }) => {
        if (skip) {
          test.info().annotations.push({
            type: "wasix-skip",
            description: skip.note
              ? `${skip.reason} — ${skip.note}`
              : skip.reason,
          });
          test.fixme(true, `wasix-skip:${skip.reason}`);
        }

        const result = await page.evaluate(
          async (input: { plan: TestPlan; mode: WASIXSuiteMode }) => {
            const p = input.plan;
            while (
              (window as unknown as { WASIX?: unknown })["WASIX"] === undefined
            ) {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }

            const w = window as unknown as {
              WASIX: typeof WASIX;
              WASIXContext: typeof WASIXContext;
              WASIXWorkerHost: typeof WASIXWorkerHost;
              WASIDriveFileSystemProvider: typeof WASIDriveFileSystemProvider;
            };

            // Seed a fresh WASIFS under /home for this run — the wasmer
            // runner mounts `--volume .` at /home (wasix-libc's default
            // cwd), so per-test inputs land at /home/<rel-path>. The
            // provider exposes /home as a preopen at fd 4 alongside the
            // implicit fd 3 = ".", and PWD primes the libc startup
            // resolver before it falls back to getcwd().
            const now = new Date();
            const fs: WASIFS = {};
            for (const input of p.inputs) {
              const guestPath = `/home/${input.path}`;
              fs[guestPath] = {
                path: guestPath,
                timestamps: { access: now, modification: now, change: now },
                mode: "binary",
                content: new Uint8Array(input.bytes),
              };
            }

            // Pre-seed each `--volume host:guest` target plus the implicit
            // `/tmp` MemFS mount as empty directories. The WASIDrive uses
            // `.runno` sentinel files to model directory presence, so the
            // mount points appear as real dirs to subsequent path ops
            // (POSIX parent-exists checks). Mirrors what the wasmer runner
            // provides without requiring per-test harness wiring.
            for (const guest of ["/tmp", ...p.mounts]) {
              const trimmed = guest.endsWith("/") ? guest.slice(0, -1) : guest;
              if (!trimmed) continue;
              const marker = `${trimmed}/.runno`;
              fs[marker] = {
                path: marker,
                timestamps: { access: now, modification: now, change: now },
                mode: "string",
                content: "",
              };
            }

            const preopens = [{ name: "/home", prefix: "/home/" }];

            let stdout = "";
            let stderr = "";

            if (input.mode === "main") {
              const wasiResult = await w.WASIX.start(
                fetch(p.wasmUrl),
                new w.WASIXContext({
                  args: p.args,
                  env: { PWD: "/home" },
                  stdout: (out: string) => {
                    stdout += out;
                  },
                  stderr: (err: string) => {
                    stderr += err;
                  },
                  stdin: () => null,
                  fs: new w.WASIDriveFileSystemProvider(fs, { preopens }),
                }),
              );
              return { exitCode: wasiResult.exitCode, stdout, stderr };
            }

            if (input.mode === "worker-fs-async") {
              // Same `fs` data, but wrapped in an async proxy that runs on
              // the main thread. Every FS call routes through the bridge.
              const sync = new w.WASIDriveFileSystemProvider(fs, {
                preopens,
              });
              const asyncFs = {} as Record<
                string,
                (...args: unknown[]) => unknown
              >;
              const syncRecord = sync as unknown as Record<
                string,
                (...args: unknown[]) => unknown
              >;
              for (const key of [
                "fdRead",
                "fdWrite",
                "fdSeek",
                "fdClose",
                "fdFdstatGet",
                "fdFdstatSetFlags",
                "fdFilestatGet",
                "fdPrestatGet",
                "fdPrestatDirName",
                "fdReaddir",
                "pathOpen",
                "pathFilestatGet",
                "pathCreateDirectory",
                "pathUnlinkFile",
                "pathRemoveDirectory",
                "pathRename",
              ]) {
                asyncFs[key] = async (...args: unknown[]) => {
                  await Promise.resolve();
                  return syncRecord[key].call(sync, ...args);
                };
              }
              // Cast — the proxy implements every method by hand, and the
              // host accepts an AsyncFileSystemProvider on this slot.
              const asyncHost = new w.WASIXWorkerHost(fetch(p.wasmUrl), {
                args: p.args,
                env: { PWD: "/home" },
                fs: asyncFs as unknown as WASIFS,
                stdout: (out: string) => {
                  stdout += out;
                },
                stderr: (err: string) => {
                  stderr += err;
                },
                stdin: () => null,
              });
              const asyncResult = await asyncHost.start();
              return { exitCode: asyncResult.exitCode, stdout, stderr };
            }

            // worker mode — WASIXWorkerHost spawns a dedicated worker and
            // drives it through the bridge. fs and preopens cross postMessage
            // as plain data; the worker reconstructs the
            // WASIDriveFileSystemProvider with the same preopen config.
            const host = new w.WASIXWorkerHost(fetch(p.wasmUrl), {
              args: p.args,
              env: { PWD: "/home" },
              fs,
              preopens,
              stdout: (out: string) => {
                stdout += out;
              },
              stderr: (err: string) => {
                stderr += err;
              },
              stdin: () => null,
            });
            const workerResult = await host.start();
            return { exitCode: workerResult.exitCode, stdout, stderr };
          },
          { plan, mode },
        );

        expect(
          result.exitCode,
          `mode: ${mode}\nargs: ${JSON.stringify(plan.args)}\ninputs: ${plan.inputs
            .map((i) => i.path)
            .join(", ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        ).toBe(0);
      });
    }
  }
});
