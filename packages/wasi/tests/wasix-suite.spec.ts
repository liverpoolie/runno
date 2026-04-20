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
// The spec deliberately does **not** compare stdout: the upstream suite
// treats exit-code-0 as success and encodes its expectations inline in
// each test. That keeps the harness trivial — if a test wants to check
// something, it `exit(1)`s on failure.

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

import type { WASIX, WASIXContext } from "../lib/main";
import { WASIX_SUITE_BIN_DIR } from "./wasix-suite.config";
import { WASIX_SUITE_SKIPS } from "./wasix-suite.skip";

const binDir = join(process.cwd(), WASIX_SUITE_BIN_DIR);

function listWasmBinaries(): string[] {
  try {
    return readdirSync(binDir)
      .filter((name) => name.endsWith(".wasm"))
      .sort();
  } catch {
    return [];
  }
}

const binaries = listWasmBinaries();

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
    const skip = WASIX_SUITE_SKIPS[name];

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

      const result = await page.evaluate(async (wasmPath: string) => {
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

        let stdout = "";
        let stderr = "";

        const wasiResult = await W.start(
          fetch(wasmPath),
          new WC({
            args: [],
            stdout: (out: string) => {
              stdout += out;
            },
            stderr: (err: string) => {
              stderr += err;
            },
            stdin: () => null,
            fs: {},
          }),
        );

        return {
          exitCode: wasiResult.exitCode,
          stdout,
          stderr,
        };
      }, `/bin/wasix-tests/${file}`);

      expect(
        result.exitCode,
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      ).toBe(0);
    });
  }
});
