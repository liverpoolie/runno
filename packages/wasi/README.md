# A WASI runner for the web (`@runno/wasi`)

There are a bunch of different WASI runners out there, some of them even work in
the browser. This one is focused on sandboxed emulation. Not system integration.
It has been developed for the particular requirements of [Runno](https://runno.dev),
but you may find it useful as well.

This package allows you to run WASI binaries on the web with an emulated
filesystem. If the binary receives calls to stdin/out/err then you get callbacks
you'll need to handle. In future there may be other callbacks to intercept
interesting system level events, or hooks into the filesystem.

## Quickstart

The quickest way to get started with Runno is by using the `WASI.start` class
method. It will set up everything you need and run the Wasm binary directly.

Be aware that this will run on the main thread, not inside a worker. So you will
interrupt any interactive use of the browser until it completes.

```js
import { WASI } from "@runno/wasi";

//...

const result = WASI.start(fetch("/binary.wasm"), {
  args: ["binary-name", "--do-something", "some-file.txt"],
  env: { SOME_KEY: "some value" },
  stdout: (out) => console.log("stdout", out),
  stderr: (err) => console.error("stderr", err),
  stdin: () => prompt("stdin:"),
  fs: {
    "/some-file.txt": {
      path: "/some-file.txt",
      timestamps: {
        access: new Date(),
        change: new Date(),
        modification: new Date(),
      },
      mode: "string",
      content: "Some content for the file.",
    },
  },
});
```

You can see a more complete example in `src/main.ts`.

_Note: The `args` should start with the name of the binary. Like when you run
a terminal command, you write `cat somefile` the name of the binary is `cat`._

## Custom Instantiation

There are two parts to running a WASI binary with Runno. The `WASI` instance
which represents the emulated system, and the WebAssembly runtime provided by
the browser. If you'd like to customise the way the WebAssembly runtime is
instantiated, you can split these parts up.

```js
import { WASI } from "@runno/wasi";

// First set up the WASI emulated system
const wasi = new WASI({
  args: ["binary-name", "--do-something", "some-file.txt"],
  env: { SOME_KEY: "some value" },
  stdout: (out) => console.log("stdout", out),
  stderr: (err) => console.error("stderr", err),
  stdin: () => prompt("stdin:"),
  fs: {
    "/some-file.txt": {
      path: "/some-file.txt",
      timestamps: {
        access: new Date(),
        change: new Date(),
        modification: new Date(),
      },
      mode: "string",
      content: "Some content for the file.",
    },
  },
});

const myMemory = new WebAssembly.Memory({ initial: 32, maximum: 10000 });

// Then instantiate your binary with the imports provided by the wasi object
const wasm = await WebAssembly.instantiateStreaming(fetch("/binary.wasm"), {
  ...wasi.getImportObject(),

  // Your own custom imports (e.g. custom memory)
  env: {
    memory: myMemory,
  },
});

// Finally start the WASI binary (with the custom memory)
const result = wasi.start(wasm, {
  memory: myMemory,
});
```

If you are working with a Reactor instead of a command, you can instead use:

```js
const exports = wasi.initialize(wasm, {
  memory: myMemory,
});
```

The returned exports will be the exports from your WebAssembly module.

## Using the WASIWorker

A worker is provided for using the WASI runner outside of the main thread. It
requires the availability of `SharedArrayBuffer` which is only available when
the browser is Cross-Origin Isolated (see below).

### Using the WASIWorkerHost

The `WASIWorkerHost` will create a worker and then communicate with it. In this
mode `stdin` does not work as a callback, instead it must be pushed onto a
buffer which is then handled asynchronously. See `@runno/runtime` for examples
on how to do this.

```ts
import { WASIWorkerHost } from "@runno/wasi";

// ...

const workerHost = new WASIWorkerHost(binaryURL, {
  args: ["binary-name", "--do-something", "some-file.txt"],
  env: { SOME_KEY: "some value" },
  stdout: (out) => console.log("stdout", out),
  stderr: (err) => console.error("stderr", err),
  fs: {
    "/some-file.txt": {
      path: "/some-file.txt",
      timestamps: {
        access: new Date(),
        change: new Date(),
        modification: new Date(),
      },
      mode: "string",
      content: "Some content for the file.",
    },
  },
});

const result = await workerHost.start();

// ... Somewhere else

workerHost.pushStdin("Some text from the user");
```

The `WASIWorkerHost` will manage fetching the WASM binary and the WASIContext.
If you've already fetched the binary you can use `URL.createObjectURL` to get a
valid URL.

### Cross-Origin Headers

To get `SharedArrayBuffer` to work on your page you must provide a
[Cross-Origin Isolated](https://web.dev/cross-origin-isolation-guide/) context.

To make your website Cross-Origin Isolated set the following headers in your
HTTP response:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

You can test that your page is Cross-Origin Isolated by opening the browser
console and checking `crossOriginIsolated` (see: [mdn docs](https://developer.mozilla.org/en-US/docs/Web/API/crossOriginIsolated)).

## Initializing a WASI Reactor

Reactors are modules that respond to calls, rather than running as a command.

You can initialize a WASI Reactor with `initialize` instead of `start`:

```js
import { WASI } from "@runno/wasi";

//...

const exports = WASI.initialize(fetch("/binary.wasm"), {
  args: ["binary-name", "--do-something", "some-file.txt"],
  env: { SOME_KEY: "some value" },
  stdout: (out) => console.log("stdout", out),
  stderr: (err) => console.error("stderr", err),
  stdin: () => prompt("stdin:"),
  fs: {
    "/some-file.txt": {
      path: "/some-file.txt",
      timestamps: {
        access: new Date(),
        change: new Date(),
        modification: new Date(),
      },
      mode: "string",
      content: "Some content for the file.",
    },
  },
});
```

The `WASI.initialize` call will return the exports from the WebAssembly module.

## The filesystem

`@runno/wasi` internally emulates a unix-like filesystem (FS) from a flat
structure. All files must start with a `/` to indicate they are in the root
directory. The `/` directory is preopened by `@runno/wasi` for your WASI binary
to use.

Paths provided to the FS can include directory names `/like/this.png`. The FS
will treat files with the same prefix `/like/so.png` as if they are in the same
folder. Any folders created will contain an empty `.runno` file `/like/.runno`
as a placeholder.

WASI has a complex permissions system that is entirely ignored. All files you
provide can be accessed by the WASI binary, with all permissions.

## Which WASI standards are supported?

Currently `@runno/wasi` supports running `unstable`, `snapshot-preview1`, and
`wasix_32v1`. The `snapshot-preview1` standard is more recent than `unstable`,
and preferred. WASIX (`wasix_32v1`) is supported via the provider model
described in the [WASIX](#wasix) section below; existing preview1 / unstable
binaries continue to work unchanged.

Other extension standards like WASMEdge are currently not supported. WASI
Modules are also not supported, but I'm interested in learning more about
them.

# WASIX

`@runno/wasi` runs `wasix_32v1` binaries through the same sandbox philosophy
as the existing WASI surface: the runtime marshals between Wasm memory and JS
plain-data shapes, and the host supplies every syscall semantic via a
pluggable provider. The runtime never performs a real syscall — there is no
real socket, no real thread, no real `proc_fork`. Hosts simulate.

Because semantics are entirely host-supplied, swapping the bundled
`SystemClockProvider` for `FixedClockProvider` (or `SystemRandomProvider` for
`SeededRandomProvider`) makes a run reproducible without touching the runtime.
Determinism is a knob, not a build mode.

See [`WASIX-PLAN.md`](./WASIX-PLAN.md) for the full design doc.

## Quickstart — `WASIX.start`

```js
import { WASIX, WASIXContext } from "@runno/wasi";

const result = await WASIX.start(
  fetch("/wasix-binary.wasm"),
  new WASIXContext({
    args: ["wasix-binary"],
    env: { LANG: "en_US.UTF-8" },
    stdout: (out) => console.log(out),
    stderr: (err) => console.error(err),
    stdin: () => null,
    fs: {},
    // No providers passed → defaults give system clock + system random;
    // every other syscall slot returns ENOSYS.
  }),
);
```

`WASIX.start(...)` runs on the main thread. Every provider it accepts is
synchronous — passing an async-capable provider here is a type error. For
async providers (HTTP, IndexedDB-backed FS), use `WASIXWorkerHost` below.

## Worker mode — `WASIXWorkerHost`

`WASIXWorkerHost` runs the guest in a dedicated worker and bridges syscalls
back to the main thread, so its provider slots accept async-capable variants
(e.g. `HTTPProvider`).

```js
import { WASIXWorkerHost, HTTPProvider } from "@runno/wasi";

const host = new WASIXWorkerHost("/wasix-binary.wasm", {
  args: ["wasix-binary"],
  fs: {},
  stdout: (out) => console.log(out),
  stderr: (err) => console.error(err),
  stdin: () => null,
  sockets: new HTTPProvider({
    outgoing: (request) => fetch(request),
  }),
});

const result = await host.start();
```

Worker mode requires `SharedArrayBuffer`, which needs the page to be
[Cross-Origin Isolated](#cross-origin-headers). Async-capable provider
methods may return either a value or a `Promise`; the bridge awaits the
Promise and feeds the resolved value into the inner sync runtime.

## Provider model — raw vs ergonomic

Every WASIX syscall family routes through a provider slot on `WASIXContext`.
The runtime offers two levels of engagement:

- **Raw providers** stay close to the WASIX ABI (fds, `sockaddr`, signo).
  Implement them when you want deep control — a host that wires real OS
  sockets, real OS threads, etc.
- **Ergonomic providers** wrap raw providers in web-native shapes (Fetch
  Requests / Responses, the existing `WASIDrive`, the legacy stdio
  callbacks). Drop one in when its assumptions match your host.

Both levels coexist — using `HTTPProvider` for sockets while implementing
`SocketsProvider` for UDP is normal.

### Raw providers

Each row links to the interface and the bundled simulation that drives the
wasmer integration suite under `WASIX.start` defaults.

| Interface                                        | Bundled simulation                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| [`ClockProvider`](./lib/wasix/providers.ts)      | [`SystemClockProvider`](./lib/wasix/providers/system-clock.ts), [`FixedClockProvider`](./lib/wasix/providers/fixed-clock.ts)       |
| [`RandomProvider`](./lib/wasix/providers.ts)     | [`SystemRandomProvider`](./lib/wasix/providers/system-random.ts), [`SeededRandomProvider`](./lib/wasix/providers/seeded-random.ts) |
| [`TTYProvider`](./lib/wasix/providers.ts)        | (no bundled simulation; use `ConsoleTTYProvider`)                                                                                  |
| [`ThreadsProvider`](./lib/wasix/providers.ts)    | [`CooperativeThreadsProvider`](./lib/wasix/providers/cooperative-threads.ts)                                                       |
| [`FutexProvider`](./lib/wasix/providers.ts)      | [`SimulatedFutexProvider`](./lib/wasix/providers/simulated-futex.ts)                                                               |
| [`SignalsProvider`](./lib/wasix/providers.ts)    | [`SelfSignalProvider`](./lib/wasix/providers/self-signal.ts)                                                                       |
| [`SocketsProvider`](./lib/wasix/providers.ts)    | [`LoopbackSocketsProvider`](./lib/wasix/providers/loopback-sockets.ts)                                                             |
| [`ProcProvider`](./lib/wasix/providers.ts)       | [`InProcessProcProvider`](./lib/wasix/providers/in-process-proc.ts)                                                                |
| [`FileSystemProvider`](./lib/wasix/providers.ts) | (drive lives behind `WASIDriveFileSystemProvider`)                                                                                 |

### Ergonomic providers

| Class                                                                                   | Use when                                                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`HTTPProvider`](./lib/wasix/providers/ergonomic/http-provider.ts)                      | The host wants to expose HTTP via Fetch — guest socket calls translate to `Request` / `Response` pairs. Worker-only (async).    |
| [`WASIDriveFileSystemProvider`](./lib/wasix/providers/ergonomic/filesystem-provider.ts) | The host wants the existing in-memory `WASIDrive` (the same FS the WASI surface uses) backing WASIX file syscalls. Sync.        |
| [`ConsoleTTYProvider`](./lib/wasix/providers/ergonomic/console-tty-provider.ts)         | The host already wires `stdin` / `stdout` / `stderr` / `isTTY` callbacks the WASI way and wants a `TTYProvider` for free. Sync. |

## Bundled simulations

Runno ships the simulation set the wasmer integration suite runs against.
None of them touch the host OS — they exist to let WASIX binaries make
forward progress in a sandbox.

| Simulation                                                                   | What it simulates / what it deliberately doesn't                                                                                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`SystemClockProvider`](./lib/wasix/providers/system-clock.ts)               | `Date.now()` / `performance.now()`. Does **not** expose finer-grained CPU-time clocks.                                                                                                    |
| [`SystemRandomProvider`](./lib/wasix/providers/system-random.ts)             | `crypto.getRandomValues()`. Non-deterministic by design.                                                                                                                                  |
| [`FixedClockProvider`](./lib/wasix/providers/fixed-clock.ts)                 | Pinned epoch + tickable monotonic for replay. Does **not** model wall-clock drift.                                                                                                        |
| [`SeededRandomProvider`](./lib/wasix/providers/seeded-random.ts)             | SFC32 PRNG keyed by an integer seed. Does **not** provide cryptographic randomness.                                                                                                       |
| [`CooperativeThreadsProvider`](./lib/wasix/providers/cooperative-threads.ts) | Single-threaded round-robin scheduling. Does **not** preempt; does **not** provide actual parallelism (`parallelism()` returns 1).                                                        |
| [`SimulatedFutexProvider`](./lib/wasix/providers/simulated-futex.ts)         | In-memory wait queues keyed by `(memory, addr)`. Does **not** wake waiters across worker boundaries.                                                                                      |
| [`LoopbackSocketsProvider`](./lib/wasix/providers/loopback-sockets.ts)       | In-process TCP/UDP fabric where listeners and connectors registered on the same instance can speak to each other. Does **not** reach off-realm.                                           |
| [`SelfSignalProvider`](./lib/wasix/providers/self-signal.ts)                 | Synchronous signal handler dispatch driven by the guest's own `proc_raise` / `raise_interval` / `signal_thread` calls. Does **not** preempt running guest code.                           |
| [`InProcessProcProvider`](./lib/wasix/providers/in-process-proc.ts)          | `proc_spawn` / `proc_exec` / `proc_join` / pipes by running children as fresh `WASIX` instances in the same JS realm. Does **not** support `proc_fork` (returns ENOSYS — needs Asyncify). |
| [`PipeRingBuffer`, `createPipe`](./lib/wasix/providers/pipes.ts)             | SPSC ring buffers for the in-process proc simulation. Does **not** block — empty reads with the writer open throw `EAGAIN`.                                                               |

## Determinism

The default providers (`SystemClockProvider`, `SystemRandomProvider`) are
non-deterministic. To pin a run, swap them in `WASIXContext`:

```js
import {
  WASIX,
  WASIXContext,
  FixedClockProvider,
  SeededRandomProvider,
} from "@runno/wasi";

await WASIX.start(
  fetch("/wasix-binary.wasm"),
  new WASIXContext({
    // ...
    clock: new FixedClockProvider(0n),
    random: new SeededRandomProvider(42),
  }),
);
```

Both providers are constructor-configurable; everything else about the run is
already a function of host inputs (args, env, fs, stdin) so swapping clock

- random is sufficient for byte-for-byte reproducibility.

## wasmer integration suite

WASIX is validated against
[`wasmerio/wasix-integration-tests`](https://github.com/wasmerio/wasix-integration-tests),
a pinned upstream suite. CI runs it under the bundled simulation set in both
main and worker mode; the table below tracks the latest counts. The
[`tests/check-readme-suite-counts.mjs`](./tests/check-readme-suite-counts.mjs)
script (run in CI) fails the build if this line drifts from the Playwright
report.

<!-- WASIX_SUITE_COUNTS -->

_Run `npm run test:wasix-suite:check-readme` after a wasixcc-built suite run
to populate this line. CI will print the expected text on first drift._

<!-- /WASIX_SUITE_COUNTS -->

Skip-reason vocabulary (the tokens after the colon above):

- `requires-asyncify` — needs Asyncify / JSPI to reify the guest's call
  stack from JS (post-fork resumption, async signal preemption, cross-frame
  setjmp/longjmp). See `WASIX-PLAN.md` § _Future: Asyncify opt-in_.
- `requires-provider-*` — host has not wired the named provider; the
  bundled simulation cannot drive the test.
- `requires-wasixcc-build-fix` — test failed to build under the pinned
  wasixcc toolchain; tracked upstream.

## Roadmap

- **Asyncify opt-in** — lift the `requires-asyncify` skips by running the
  Binaryen pass on the guest at load time. See
  [`WASIX-PLAN.md` § Future: Asyncify opt-in](./WASIX-PLAN.md#future-asyncify-opt-in).
- **`wasix_64v1`** — Memory64 / wasm64 variant. Deferred per
  [`WASIX-PLAN.md` § Non-goals](./WASIX-PLAN.md#scope) until toolchain output
  drives demand.
- **Real-world providers** (Node sockets, IndexedDB FS, native threads).
  Host responsibility — Runno is a sandbox and does not ship them.

# Contributing

The most useful way to contribute to `@runno/wasi` is to add tests. Particularly
if you find something that doesn't work!

## Running Tests

If this is the first time running tests, please run the prepare script first.
This will build the test programs and download existing test suites.

_You'll need to have cargo installed to run the tests_

```sh
npm run test:prepare
```

Then run the test suite:

```sh
npm run test
```

The test suite includes the following tests:

- args - tests of program args (mine)
- stdio - tests of stdio (mine)
- wasi-test-suite https://github.com/caspervonb/wasi-test-suite
  - core - the core WASI functionality called from assemblyscript
  - libc - WASI functionality called from libc (C)
  - libstd - WASI functionality called from libstd (Rust)
- [TODO] wasi-tests https://github.com/bytecodealliance/wasmtime/tree/main/crates/test-programs/wasi-tests
