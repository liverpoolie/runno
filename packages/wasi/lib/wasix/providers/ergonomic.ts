// Barrel for ergonomic providers — drop-in classes that wrap raw provider
// interfaces in web-native shapes. Mirrors WASIX-PLAN.md § Public surface.

export {
  ConsoleTTYProvider,
  type ConsoleTTYOptions,
} from "./ergonomic/console-tty-provider.js";
export { WASIDriveFileSystemProvider } from "./ergonomic/filesystem-provider.js";
export {
  HTTPProvider,
  type HTTPProviderOptions,
  type OutgoingHandler,
  type IncomingHandler,
} from "./ergonomic/http-provider.js";
