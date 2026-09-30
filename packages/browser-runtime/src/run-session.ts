// packages/browser-runtime/src/run-session.ts
//
// BRW-002 — the session orchestrator.
//
// This is the in-guest control flow: guard, measure, launch, drive, persist, close. It takes
// an INJECTED driver rather than importing Playwright, for one reason that is about proof
// rather than tidiness — the ORDER of operations here is a security and durability property,
// and an injected driver makes that order an assertion instead of a comment.
//
// THE ORDERING IS MUTUALLY CONSTRAINED, and neither half is visible from a screenshot:
//   * Playwright writes video only when the context CLOSES.
//   * Closing the context DELETES the `downloadsPath` staging area.
// So every download must be persisted with `saveAs` BEFORE close, and close must still
// happen. Getting it wrong loses the downloads or the video, silently, in a way no
// happy-path test would notice.
//
// Runs inside the sandbox next to Chromium, because the CDP pipe rides file descriptors 3
// and 4 of the spawned child (`playwright-core/lib/server/browserType.js:268-269`) and only
// the spawning process can hold them. A host-side orchestrator cannot drive Playwright across
// the sandbox boundary — it can only start this and read what it emits.
import { checkBrowserLaunchSafety, type BrowserLaunchOptions } from "./launch-guard.js";
import { listeningPortDelta } from "./listening-ports.js";
import {
  awaitApprovalDecision,
  buildApprovalIntent,
  navigationTarget,
  type ApprovalResolver,
  type Delay,
} from "./approval.js";

export interface SessionStep {
  readonly action: "navigate";
  readonly url: string;
}

export interface SessionConfig {
  readonly downloadRoot: string;
  readonly steps: readonly SessionStep[];
  readonly launch: BrowserLaunchOptions;
  /**
   * BRW-004 slice (c) — when true, every navigation and every download must carry an
   * `allow_once` decision before it happens.
   *
   * ★ IT DEFAULTS OFF, and that is the honest default rather than a timid one. Terrain §4
   * measured that NO control-plane hop delivers a decision to a running worker
   * (`commandKind` appears zero times in `packages/worker-daemon/src`; the hop is chartered
   * as JOB-015 and is not BRW-004's). With the gate ON and no delivery channel, every
   * session refuses at its first step. Defaulting it ON would therefore not be "safer" — it
   * would break every existing session in exchange for enforcement that nothing can satisfy,
   * which is how a fail-closed lever gets disabled wholesale by the next person who trips
   * over it. It turns on when a resolver that can actually answer is wired.
   */
  readonly requireApproval?: boolean;
  /** Budget for one decision to arrive. Ignored unless `requireApproval` is set. */
  readonly approvalTimeoutMs?: number;
}

/** A download the browser produced. `saveAs` is the only durable sink. */
export interface DownloadHandle {
  suggestedFilename(): string;
  saveAs(target: string): Promise<void>;
}

export interface BrowserPage {
  navigate(url: string): Promise<void>;
  collectDownloads(): Promise<readonly DownloadHandle[]>;
  /** Flushes video. Also destroys the download staging area — hence the ordering. */
  close(): Promise<void>;
  /**
   * BRW-003b — present only when the session recorded video.
   *
   * ★ THIS ONE IS THE OPPOSITE OF EVERYTHING ELSE HERE. Downloads and trace must be
   * handled BEFORE `close()`; video can only be saved AFTER it. Playwright's `Artifact.saveAs`
   * queues onto `_saveCallbacks` while the artifact is unfinished and is drained only by
   * `reportFinished()`, which for a video runs DURING `context.close()`. Awaiting it first
   * therefore never resolves — the failure is a HUNG SESSION, not a missing file.
   */
  readonly video?: { saveAs(target: string): Promise<void> };
  /**
   * BRW-003b — present only when the session started a trace.
   *
   * Must be called BEFORE `close()`. Playwright's `tracing.flush()` during close is
   * `abort()` plus an fs sync with NO ZIP, so a trace that was not stopped with a path is
   * discarded — silently, without an error. The opposite constraint to `video` above.
   */
  stopTracing?(target: string): Promise<void>;
}

export interface BrowserDriver {
  launch(options: BrowserLaunchOptions): Promise<BrowserPage>;
}

/** Result of resolving a download destination; mirrors `path-adapter`'s shape. */
export type ResolveResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export interface SessionDeps {
  readonly driver: BrowserDriver;
  /** Called twice: immediately before launch and immediately after. */
  readonly measurePorts: () => Promise<readonly number[]>;
  readonly resolvePath: (root: string, name: string) => ResolveResult;
  readonly env: NodeJS.ProcessEnv;
  /**
   * BRW-004 slice (c) — the injected decision channel, exactly like `driver`.
   *
   * Injected for the same reason the driver is: it makes the ORDER an assertion. An approval
   * that is asked for AFTER the action has run is not an approval, and only an injected seam
   * lets a test observe that the action never reached the driver.
   */
  readonly requestApproval?: ApprovalResolver;
  /** Injected timer, so the approval deadline is a test assertion, not a wall-clock wait. */
  readonly delay?: Delay;
}

export type SessionFailure =
  | "cdp_port_requested"
  | "remote_debugging_arg"
  | "argument_not_allowed"
  | "remote_endpoint_env"
  | "chromium_sandbox_disabled"
  | "port_opened"
  | "download_refused"
  | "launch_failed"
  | "step_failed"
  /** BRW-004 slice (c): an action required an approval and did not get an `allow_once`. */
  | "approval_refused";

export type SessionResult =
  | { readonly ok: true; readonly savedDownloads: readonly string[] }
  | { readonly ok: false; readonly reason: SessionFailure; readonly detail: string };

/**
 * Run one browser session to completion.
 *
 * Failure is reported, never thrown: this runs as the sandbox's entrypoint, and a thrown
 * error would surface as an opaque non-zero exit with no reason attached.
 */
export async function runBrowserSession(
  config: SessionConfig,
  deps: SessionDeps,
): Promise<SessionResult> {
  // 1. GUARD FIRST. A refused launch must not start a browser — checking afterwards would
  //    mean the endpoint we are trying to prevent had already existed.
  const safety = checkBrowserLaunchSafety(config.launch, deps.env);
  if (!safety.ok) return { ok: false, reason: safety.reason, detail: safety.detail };

  // 2. Baseline the sockets BEFORE launch, so the comparison is a delta and not an absolute
  //    set (envd already holds a port in every sandbox).
  const portsBefore = await deps.measurePorts();

  let page: BrowserPage;
  try {
    page = await deps.driver.launch(config.launch);
  } catch (error) {
    return {
      ok: false,
      reason: "launch_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // Everything below runs with a live browser, so every exit path goes through `finish`,
  // which persists evidence and then closes. A bare `throw` here would leak the browser and
  // lose whatever it had already produced.
  let stepFailure: string | null = null;
  try {
    const portsAfter = await deps.measurePorts();
    const opened = listeningPortDelta(portsBefore, portsAfter);
    if (opened.length > 0) {
      return await finish(page, config, deps, {
        ok: false,
        reason: "port_opened",
        detail: `browser opened listening port(s): ${opened.join(", ")}`,
      });
    }

    for (const step of config.steps) {
      // BRW-004 slice (c) — ASK BEFORE ACTING. The order is the property: on a refusal the
      // navigation must never reach the driver, which is what an injected driver lets a test
      // observe directly rather than infer from an outcome.
      const gate = await gateAction(config, deps, {
        action: "navigate",
        title: `Navigate to ${step.url}`,
        summary: `The browser session requests navigation to ${step.url}.`,
        networkTarget: navigationTarget(step.url),
        riskClass: "network_egress",
      });
      if (gate !== null) {
        return await finish(page, config, deps, gate);
      }
      try {
        await page.navigate(step.url);
      } catch (error) {
        stepFailure = error instanceof Error ? error.message : String(error);
        break;
      }
    }
  } catch (error) {
    stepFailure = error instanceof Error ? error.message : String(error);
  }

  return await finish(
    page,
    config,
    deps,
    stepFailure === null ? null : { ok: false, reason: "step_failed", detail: stepFailure },
  );
}

/**
 * BRW-004 slice (c) — the one place an action is gated on a human decision.
 *
 * Returns null when the action may proceed, or the failure that must stop it.
 *
 * ★★ THE FAIL-CLOSED CLAUSE IS IN THE `requireApproval && !requestApproval` BRANCH, and it is
 * the branch most likely to be written the other way. If the gate is demanded but no resolver
 * was injected, this REFUSES. The tempting alternative — "no resolver configured, so carry on"
 * — turns the entire approval story into a dead lever the moment a composition root forgets a
 * dependency, and it would look identical to a gate that works: green tests, no approvals, no
 * error. Configuring enforcement and then not wiring it is a misconfiguration, and a
 * misconfigured guard must fail closed.
 */
async function gateAction(
  config: SessionConfig,
  deps: SessionDeps,
  intentInput: {
    action: "navigate" | "download";
    title: string;
    summary: string | null;
    networkTarget: string | null;
    riskClass: string;
  },
): Promise<{ ok: false; reason: SessionFailure; detail: string } | null> {
  if (config.requireApproval !== true) return null;
  if (deps.requestApproval === undefined) {
    return {
      ok: false,
      reason: "approval_refused",
      detail: "approval is required but no resolver was injected — a misconfigured gate fails closed",
    };
  }
  const outcome = await awaitApprovalDecision({
    resolver: deps.requestApproval,
    intent: buildApprovalIntent(intentInput),
    timeoutMs: config.approvalTimeoutMs ?? 60_000,
    // A missing timer is the same misconfiguration as a missing resolver, so the fallback
    // is a REAL timer rather than a never-resolving one: a deadline that can never fire is a
    // hang, and a hang is the failure mode this whole clause exists to remove.
    delay: deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  });
  if (outcome.ok) return null;
  return {
    ok: false,
    reason: "approval_refused",
    detail: `${intentInput.action} refused (${outcome.reason}): ${outcome.detail}`,
  };
}

/**
 * Persist evidence, then close.
 *
 * `pending` is the failure already decided, or null. A download refusal outranks it: a
 * destination that escaped the job root is a containment finding and must not be masked by
 * an ordinary step failure that happened first.
 */
async function finish(
  page: BrowserPage,
  config: SessionConfig,
  deps: SessionDeps,
  pending: { ok: false; reason: SessionFailure; detail: string } | null,
): Promise<SessionResult> {
  const saved: string[] = [];
  let refusal: { reason: SessionFailure; detail: string } | null = null;

  // PHASE 1 — everything that must happen BEFORE close: the trace (an unstopped trace is
  // discarded by close's flush-without-zip) and the downloads (close unlinks the staging
  // files). Both are lost silently if they happen after, which is why the order is a test.
  if (page.stopTracing !== undefined) {
    const resolved = deps.resolvePath(config.downloadRoot, "session-trace.zip");
    if (resolved.ok) {
      try {
        await page.stopTracing(resolved.path);
        saved.push(resolved.path);
      } catch {
        // Evidence is best-effort: a trace that fails to write must not turn an otherwise
        // successful session into a failure, nor mask a download refusal that outranks it.
      }
    }
  }

  try {
    const downloads = await page.collectDownloads();
    for (const download of downloads) {
      // BRW-004 slice (c) — the download half of `permission_download_egress`. Asked BEFORE
      // `saveAs`, so a refused download is never written and then deleted; the bytes simply
      // never leave the staging area, which `close()` reclaims.
      const gate = await gateAction(config, deps, {
        action: "download",
        title: `Save download ${download.suggestedFilename()}`,
        summary: `The browser session produced a download named ${download.suggestedFilename()}.`,
        networkTarget: null,
        riskClass: "download",
      });
      if (gate !== null) {
        refusal ??= { reason: gate.reason, detail: gate.detail };
        continue;
      }
      const resolved = deps.resolvePath(config.downloadRoot, download.suggestedFilename());
      if (!resolved.ok) {
        // Do NOT write. A refused destination is the case this guard exists for.
        refusal ??= {
          reason: "download_refused",
          detail: `${download.suggestedFilename()}: ${resolved.detail}`,
        };
        continue;
      }
      await download.saveAs(resolved.path);
      saved.push(resolved.path);
    }
  } catch (error) {
    refusal ??= {
      reason: "download_refused",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // PHASE 2 — ALWAYS close, even after a failure: this is what flushes video, and a browser
  // left open is a leak the sandbox TTL would have to clean up.
  try {
    await page.close();
  } catch {
    // A close failure must not mask the real reason; the sandbox teardown reclaims it.
  }

  // PHASE 3 — collect what only exists AFTER close. Video's saveAs resolves when close ran
  // `reportFinished()`; asking before close would hang the session forever. Nothing else
  // belongs here: downloads were unlinked by close, and an unstopped trace was discarded.
  if (page.video !== undefined) {
    const resolved = deps.resolvePath(config.downloadRoot, "session-video.webm");
    if (resolved.ok) {
      try {
        await page.video.saveAs(resolved.path);
        saved.push(resolved.path);
      } catch {
        // Evidence is best-effort at this point: the session's own outcome is already
        // decided, and losing the video must not turn a successful run into a failure or
        // mask a refusal that outranks it.
      }
    }
  }

  if (refusal !== null) return { ok: false, ...refusal };
  if (pending !== null) return pending;
  return { ok: true, savedDownloads: saved };
}
