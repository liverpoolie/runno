/**
 * ConsoleTTYProvider — ergonomic shim that wraps the legacy stdio surface.
 *
 * Use this when the host already wires `stdin` / `stdout` / `stderr` /
 * `isTTY` the WASI way and just wants a `TTYProvider` for free without
 * restating the terminal shape. Sync.
 *
 * Pure shim: `get()` returns the host-configured `TTYState`; `set()` stores
 * the new state and returns `SUCCESS`. The actual stdio bytes still flow
 * through the preview1 / wasix stdio paths (which read the callbacks
 * directly). Does **not** implement TTY ioctls — those route through the
 * raw `TTYProvider` slot if the host wires one.
 */

import { Result } from "../../wasix-32v1.js";
import type { TTYProvider, TTYState } from "../../providers.js";

export type ConsoleTTYOptions = {
  isTTY?: boolean;
  cols?: number;
  rows?: number;
  pixelWidth?: number;
  pixelHeight?: number;
  echo?: boolean;
  lineBuffered?: boolean;
  raw?: boolean;
};

const DEFAULT_STATE: TTYState = {
  cols: 80,
  rows: 24,
  pixelWidth: 0,
  pixelHeight: 0,
  echo: true,
  lineBuffered: true,
  raw: false,
};

export class ConsoleTTYProvider implements TTYProvider {
  private state: TTYState;

  constructor(options: ConsoleTTYOptions = {}) {
    this.state = {
      cols: options.cols ?? DEFAULT_STATE.cols,
      rows: options.rows ?? DEFAULT_STATE.rows,
      pixelWidth: options.pixelWidth ?? DEFAULT_STATE.pixelWidth,
      pixelHeight: options.pixelHeight ?? DEFAULT_STATE.pixelHeight,
      echo: options.echo ?? DEFAULT_STATE.echo,
      lineBuffered: options.lineBuffered ?? DEFAULT_STATE.lineBuffered,
      raw: options.raw ?? DEFAULT_STATE.raw,
    };
  }

  get(): TTYState {
    return { ...this.state };
  }

  set(state: TTYState): Result {
    this.state = { ...state };
    return Result.SUCCESS;
  }
}
