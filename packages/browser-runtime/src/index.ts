// packages/browser-runtime/src/index.ts
//
// BRW-002 — the sandbox-local browser runtime.
//
// It is staged into the job sandbox and executed there, next to Chromium, because the CDP
// pipe rides file descriptors 3 and 4 of the spawned child
// (`playwright-core/lib/server/browserType.js:268-269`) and only the spawning process can hold
// them. A host-side orchestrator can start this and read its output; it cannot drive
// Playwright across the sandbox boundary.
//
// EVERYTHING the runtime needs is exported. An earlier version exported only the three pure
// guards, which left `runBrowserSession` and `createPlaywrightDriver` unreachable from any
// consumer — adversarial review found the whole package had no importer at all, which makes a
// guard a function rather than an enforcement.
export {
  checkBrowserLaunchSafety,
  normalizeSwitchName,
  type BrowserLaunchCheck,
  type BrowserLaunchOptions,
  type BrowserLaunchRefusal,
} from "./launch-guard.js";
export {
  listeningPortDelta,
  parseListeningPorts,
  readListeningPorts,
  type ReadProcFile,
} from "./listening-ports.js";
export {
  resolveUnderRoot,
  safeDownloadName,
  type PathRefusal,
  type ResolvedUnderRoot,
} from "./path-adapter.js";
export {
  runBrowserSession,
  type BrowserDriver,
  type BrowserPage,
  type DownloadHandle,
  type SessionConfig,
  type SessionFailure,
  type SessionResult,
  type SessionStep,
} from "./run-session.js";
export {
  awaitApprovalDecision,
  buildApprovalIntent,
  classifyBrowserPermissionDecision,
  inertRefusingResolver,
  navigationTarget,
  type ApprovalOutcome,
  type ApprovalRefusalReason,
  type ApprovalResolver,
  type BrowserApprovalAction,
  type BrowserApprovalIntent,
  type BrowserPermissionDecision,
  type Delay,
} from "./approval.js";
export { createPlaywrightDriver, type PlaywrightDriverOptions } from "./playwright-driver.js";
export { startFixtureSite, type FixtureSite } from "./fixture-site.js";
export { main as runnerMain, runFromConfig, type RunnerConfig } from "./runner.js";
