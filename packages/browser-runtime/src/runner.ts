// packages/browser-runtime/src/runner.ts
//
// BRW-002 — THE IN-GUEST ENTRYPOINT. This is the boot root.
//
// Adversarial review found that the guards, the orchestrator and the driver were all
// unreachable: nothing in the tree imported the package, and `index.ts` did not even export
// the orchestrator. A pure function no boot root reaches enforces nothing — the programme's
// signature defect, reproduced inside the module written to prevent it. This file is the
// answer: the process the sandbox actually executes.
//
// WHY IT RUNS IN-GUEST. The CDP pipe rides file descriptors 3 and 4 of the spawned child
// (`playwright-core/lib/server/browserType.js:268-269`), and only the spawning process can
// hold them. The host stages this file plus a config, starts it, and reads its output. It
// cannot drive Playwright across the sandbox boundary, so the driver has to be here.
//
//   host: writeFiles(runner + session.json) -> exec(node runner.js session.json)
//   guest: THIS -> launchPersistentContext -> pipe on fds 3/4 -> drive -> persist -> close
//   host: destroys the sandbox
//
// ★ CORRECTION (BRW-003). This header used to say "host: reads the NDJSON on stdout" and that
// "the host's only channel back is the command's stdout stream". BOTH WERE FALSE, and shipping
// them taught a contract that cannot hold:
//
//   * The worker-daemon `SandboxProvider` port is FROZEN (handoff §7, listed beside
//     packages/worker-protocol) and its stated invariant is explicit — supervisor/provider.ts:169:
//     "No stdout/stderr content crosses this boundary."
//   * The E2B provider therefore returns placeholder `ref:stdout:<sandboxId>` values and DISCARDS
//     the command's stdout. That is the invariant working, not a gap to widen.
//
// So nothing reads these lines today. They are kept because they are the right SHAPE — one
// self-describing event per line, and a failure reported as BOTH an event and a non-zero exit,
// since an exit code alone loses the reason while an event alone lets a failed session look
// successful to a caller that only checks the code.
//
// BRW-003 carries these events to the host the way the architecture already provides for: the
// FROZEN `event_upload` transport op, through the worker's EventSequencer, its durable outbox and
// per-run secret redaction. A stdout pipe would have bypassed all three, so it was never merely
// blocked — it was strictly worse than the path that already exists.
import { readFile } from "node:fs/promises";
import { createPlaywrightDriver } from "./playwright-driver.js";
import { readListeningPorts } from "./listening-ports.js";
import { resolveUnderRoot, safeDownloadName } from "./path-adapter.js";
import { runBrowserSession, type SessionConfig, type SessionResult } from "./run-session.js";

/** What the host stages next to this file. */
export interface RunnerConfig extends SessionConfig {
  /** Chromium profile directory. A PARAMETER of launchPersistentContext, never an argument. */
  readonly userDataDir: string;
  /** Where Playwright stages downloads before `saveAs` persists them. */
  readonly downloadsStagingPath: string;
  readonly videoDir?: string;
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * Execute one browser session from a staged config file.
 *
 * Exported separately from the CLI wrapper so it is directly testable — a boot root that can
 * only be exercised by spawning a process is a boot root most tests will skip.
 */
export async function runFromConfig(config: RunnerConfig): Promise<SessionResult> {
  const result = await runBrowserSession(config, {
    driver: createPlaywrightDriver({
      userDataDir: config.userDataDir,
      downloadsStagingPath: config.downloadsStagingPath,
      videoDir: config.videoDir,
    }),
    // The containment measurement reads the real /proc tables. On a platform without them
    // this THROWS rather than reporting "clean", so an unmeasurable environment fails the
    // session instead of silently passing it.
    measurePorts: () => readListeningPorts((path) => readFile(path, "utf8")),
    resolvePath: (root, name) => {
      const safe = safeDownloadName(name);
      if (safe === null) {
        return { ok: false, reason: "unusable_name", detail: `suggested filename ${name} is unusable` };
      }
      return resolveUnderRoot(root, safe);
    },
    env: process.env,
  });
  return result;
}

/** The CLI wrapper the sandbox executes: `node runner.js /path/to/session.json`. */
export async function main(argv: readonly string[]): Promise<number> {
  const configPath = argv[2];
  if (configPath === undefined) {
    emit({ type: "session_failed", reason: "no_config", detail: "usage: runner.js <session.json>" });
    return 2;
  }

  let config: RunnerConfig;
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as RunnerConfig;
  } catch (error) {
    emit({
      type: "session_failed",
      reason: "config_unreadable",
      detail: error instanceof Error ? error.message : String(error),
    });
    return 2;
  }

  emit({ type: "session_started", downloadRoot: config.downloadRoot, steps: config.steps.length });

  let result: SessionResult;
  try {
    result = await runFromConfig(config);
  } catch (error) {
    // Nothing may escape as an unhandled rejection: the host would see a bare non-zero exit
    // with no reason, which is exactly the "failure surfaces far from its cause" shape this
    // epic exists to remove.
    emit({
      type: "session_failed",
      reason: "runner_error",
      detail: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }

  if (result.ok) {
    emit({ type: "session_completed", savedDownloads: result.savedDownloads });
    return 0;
  }
  emit({ type: "session_failed", reason: result.reason, detail: result.detail });
  return 1;
}

// Executed only when this module is the process entrypoint, so importing it in a test does
// not launch a browser.
const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("runner.js") || invokedPath.endsWith("runner.ts")) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      emit({
        type: "session_failed",
        reason: "runner_error",
        detail: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    });
}
