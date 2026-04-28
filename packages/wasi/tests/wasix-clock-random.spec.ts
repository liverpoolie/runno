import { test, expect } from "@playwright/test";

import type {
  WASIX,
  WASIXContext,
  FixedClockProvider,
  SeededRandomProvider,
} from "../lib/main";

test.beforeEach(async ({ page }) => {
  await page.goto("http://localhost:5173");
  await page.waitForLoadState("domcontentloaded");
});

test("wasix-clock-random: monotonic delta > 0 and non-zero random bytes", async ({
  page,
}) => {
  const result = await page.evaluate(async function () {
    while ((window as any)["WASIX"] === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const W: typeof WASIX = (window as any)["WASIX"];
    const WC: typeof WASIXContext = (window as any)["WASIXContext"];

    const wasiResult = await W.start(
      fetch("/bin/tests/wasix-clock-random.wasm"),
      new WC({
        args: [],
        stdout: () => {},
        stderr: () => {},
        stdin: () => null,
        fs: {},
      }),
    );

    return { exitCode: wasiResult.exitCode };
  });

  expect(result.exitCode).toBe(0);
});

test("wasix-deterministic: byte-identical stdout across two runs with fixed providers", async ({
  page,
}) => {
  const result = await page.evaluate(async function () {
    while ((window as any)["WASIX"] === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const W: typeof WASIX = (window as any)["WASIX"];
    const WC: typeof WASIXContext = (window as any)["WASIXContext"];
    const FC: typeof FixedClockProvider = (window as any)["FixedClockProvider"];
    const SR: typeof SeededRandomProvider = (window as any)[
      "SeededRandomProvider"
    ];

    const run = async () => {
      const chunks: string[] = [];
      const wasiResult = await W.start(
        fetch("/bin/tests/wasix-deterministic.wasm"),
        new WC({
          args: [],
          clock: new FC(BigInt(0), BigInt(0)),
          random: new SR(42),
          stdout: (out: string) => {
            chunks.push(out);
          },
          stderr: () => {},
          stdin: () => null,
          fs: {},
        }),
      );
      return { exitCode: wasiResult.exitCode, stdout: chunks.join("") };
    };

    const run1 = await run();
    const run2 = await run();

    return {
      exitCode1: run1.exitCode,
      exitCode2: run2.exitCode,
      stdout1: run1.stdout,
      stdout2: run2.stdout,
    };
  });

  // Golden output: 8 SFC32(seed=42) bytes hex-encoded, then 8 zero bytes from
  // FixedClockProvider(0n, 0n). Pinning the exact bytes catches algorithm drift
  // that mere reproducibility-across-runs would not.
  const expectedStdout = "b4b5424d031fbb710000000000000000";

  expect(result.exitCode1).toBe(0);
  expect(result.exitCode2).toBe(0);
  expect(result.stdout1).toBe(expectedStdout);
  expect(result.stdout2).toBe(expectedStdout);
});
