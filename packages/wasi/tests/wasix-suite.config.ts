// Typed facade over `wasix-suite.constants.mjs`.
//
// The raw constants (pinned SHA, include-dirs list, vendor paths) live in
// the sibling `.mjs` file so the plain Node build script
// (`build-wasix-suite.mjs`) can import them without a TS loader. This
// file re-exports those values with explicit types for TypeScript
// consumers (the Playwright spec, typecheck-time imports).
//
// When bumping the SHA or include-dirs, edit `wasix-suite.constants.mjs`
// — this file only adds types.

import {
  WASMER_SHA as _WASMER_SHA,
  WASIX_INCLUDE_DIRS as _WASIX_INCLUDE_DIRS,
  WASIX_VENDOR_DIR as _WASIX_VENDOR_DIR,
  WASIX_SUITE_BIN_DIR as _WASIX_SUITE_BIN_DIR,
  WASIX_SUITE_MODES as _WASIX_SUITE_MODES,
} from "./wasix-suite.constants.mjs";

export const WASMER_SHA: string = _WASMER_SHA;
export const WASIX_INCLUDE_DIRS: readonly string[] = _WASIX_INCLUDE_DIRS;
export const WASIX_VENDOR_DIR: string = _WASIX_VENDOR_DIR;
export const WASIX_SUITE_BIN_DIR: string = _WASIX_SUITE_BIN_DIR;

/** Execution mode the harness runs each test under. */
export type WASIXSuiteMode = "main" | "worker";
/** The set of modes iterated by the Playwright spec. */
export const WASIX_SUITE_MODES: readonly WASIXSuiteMode[] = _WASIX_SUITE_MODES;
