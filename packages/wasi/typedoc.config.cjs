/** @type {import('typedoc').TypeDocOptions} */
module.exports = {
  entryPoints: ["./lib/main.ts"],
  out: "docs",
  // titleLink: "/",
  sidebarLinks: {
    Docs: "/docs",
    "@runno/runtime": "/docs/runtime/",
  },
  navigationLinks: {
    Runno: "/",
    WASI: "/wasi",
    Articles: "/articles",
    Docs: "/docs",
    GitHub: "https://github.com/taybenlor/runno",
  },
  // Types referenced from public surface but deliberately kept internal.
  // Listing them here suppresses the "referenced but not included" warning
  // without forcing them into the public API.
  intentionallyNotExported: [
    "WASIDrive",
    "WASIWorkerHostContext",
    "SocketState",
    "ParkableThreads",
  ],
};
