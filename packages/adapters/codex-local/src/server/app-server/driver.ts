/**
 * W5c Task 3 — `codex app-server` turn driver.
 *
 * Runs ONE turn to completion over the transport-only JSON-RPC client
 * (`jsonrpc-client.ts`, Task 2) and returns a NEUTRAL INTERMEDIATE — the fields
 * the result assembler (Task 4) needs, plus the resolved `sessionId`,
 * `timedOut`, and `clearSession` (mirroring `execute.ts`'s `toResult`).
 *
 * Scope boundaries:
 * - This driver owns LIFECYCLE (initialize → initialized → thread/start | resume
 *   → turn/start → drive to turn/completed | turn/failed), RESUME semantics
 *   (replicated from `execute.ts`), the TIMEOUT path, APPROVAL routing (server
 *   request → injected `onServerApproval` → `respond({decision})`, fail-closed),
 *   and NOTIFICATION routing to an injected `accumulator`.
 * - It does NOT parse/remap notifications into the intermediate — that is the
 *   accumulator's job (Task 4). Here we route every notification to
 *   `accumulator.onNotification(...)` and call `accumulator.result()` at the end.
 *
 * Testability: the client, accumulator, approval callback, and the
 * server-request / notification registration hooks are all injected, so the
 * unit test drives a scripted fake with no real codex process. The real caller
 * (Task 5) builds the client via `spawnAppServerClient`, wiring its
 * `onServerRequest` / `onNotification` into the register hooks below, and passes
 * the tracked child's `terminate` for the timeout path.
 */
import path from "node:path";
import { isCodexUnknownSessionError } from "../parse.js";

/** The subset of the JSON-RPC client the driver depends on (Task 2 shape). */
export interface AppServerDriverClient {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  respond(id: number | string, result: unknown): void;
  respondError(
    id: number | string,
    error: { code: number; message: string; data?: unknown },
  ): void;
  onClose(cb: () => void): void;
  close(err?: Error): void;
}

/** A single text input part for `turn/start`. */
export interface AppServerInputText {
  type: "text";
  text: string;
}

/**
 * The neutral intermediate the driver returns. Task 4's accumulator produces the
 * `summary`/`usage`/`error*` core; the driver augments it with session fields.
 * The base (accumulator-produced) fields are intentionally minimal here — the
 * accumulator may add more, so this is a lower bound, not an exhaustive shape.
 */
export interface NeutralIntermediate {
  summary: string;
  usage: unknown | null;
  errorMessage: string | null;
  errorCode: string | null;
  /** Extra fields the Task-4 accumulator may attach (items, diff, tokenUsage…). */
  [key: string]: unknown;
}

/** The driver's return value: intermediate + resolved session lifecycle fields. */
export interface DriverResult extends NeutralIntermediate {
  /** Resolved thread id (created or resumed), or null if none was obtained. */
  sessionId: string | null;
  /** True when the turn was force-terminated on timeout. */
  timedOut: boolean;
  /**
   * Set ONLY when a resume was expected (a stored id was present + resumable)
   * but no replacement id was obtained. Mirrors `execute.ts` toResult:
   * `Boolean(clearSessionOnMissingSession && !resolvedSessionId)`. NEVER set for
   * a freshly-created thread id.
   */
  clearSession: boolean;
}

/**
 * The notification accumulator (Task 4 supplies the real one). The driver routes
 * every notification here and reads `result()` at the end.
 */
export interface AppServerAccumulator {
  onNotification(method: string, params: unknown): void;
  result(): NeutralIntermediate;
}

/** A stored, potentially-resumable session (from prior run's sessionParams). */
export interface AppServerStoredSession {
  sessionId: string;
  /** cwd the session was created in ("" = unknown/portable). */
  cwd?: string;
}

export interface DriveCodexAppServerInput {
  runId: string;
  cwd: string;
  input: AppServerInputText[];
  /** codex v2 AskForApproval policy. The bridge uses "untrusted" (see §2 doc). */
  approvalPolicy: string;
  /** Turn timeout in seconds. 0 = no timeout. */
  timeoutSec: number;

  /** Injected transport client (Task 2). */
  client: AppServerDriverClient;
  /** Injected notification accumulator (Task 4 supplies the real one). */
  accumulator: AppServerAccumulator;

  /**
   * Injected approval bridge (Task 5 supplies the real one). Given the server
   * request method+params, returns the decision string. If absent or throwing,
   * the driver fails CLOSED with `{ decision: "decline" }`.
   */
  onServerApproval?: (method: string, params: unknown) => Promise<string>;

  /**
   * Wire the driver's server-request handler into the client. The real caller
   * forwards `spawnAppServerClient`'s `onServerRequest` here; the test sets its
   * fake's dispatcher. Called once, synchronously, before the handshake.
   */
  registerServerRequestHandler: (
    handler: (id: number | string, method: string, params: unknown) => void | Promise<void>,
  ) => void;
  /** Wire the driver's notification handler into the client (symmetric). */
  registerNotificationHandler: (
    handler: (method: string, params: unknown) => void,
  ) => void;

  /** Stored session to attempt to resume (cwd-guarded, see resume rules). */
  session?: AppServerStoredSession;

  /** Force-terminate the app-server child on timeout (tracked handle terminate). */
  terminate?: () => void;

  /** Non-fatal warning sink (cwd-mismatch skip, etc.). Defaults to no-op. */
  onWarn?: (message: string) => void;
}

const DECLINE = { decision: "decline" } as const;

/**
 * codex 0.130 app-server REQUIRES `params.clientInfo` on `initialize` —
 * live-verified: omitting params → -32600 "missing field `params`";
 * `params:{}` → "missing field `clientInfo`"; name+version required, title
 * optional. Same shape the Task-1 spike proved live (appserver-spike.test.ts).
 */
const INITIALIZE_PARAMS = {
  clientInfo: {
    name: "aoa-codex-local",
    title: "AoA codex_local runtime-decision bridge",
    version: "1.0.0",
  },
} as const;

/**
 * Replicates `execute.ts` `canResumeSession` (~line 348): resumable only when
 * the stored cwd is empty OR resolves to the same path as the run cwd.
 */
function canResumeSession(storedCwd: string, cwd: string): boolean {
  return storedCwd.length === 0 || path.resolve(storedCwd) === path.resolve(cwd);
}

/** Extract a thread id from a thread/start | thread/resume response. */
function extractThreadId(result: unknown): string | null {
  if (result && typeof result === "object") {
    const thread = (result as { thread?: unknown }).thread;
    if (thread && typeof thread === "object") {
      const id = (thread as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) return id;
    }
    // Some shapes may surface a top-level threadId.
    const top = (result as { threadId?: unknown }).threadId;
    if (typeof top === "string" && top.length > 0) return top;
  }
  return null;
}

/** True if a rejected `thread/resume` means "unknown/expired session". */
function isUnknownSessionRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  // Reuse parse.ts semantics (stdout+stderr haystack) against the error message.
  return isCodexUnknownSessionError(message, "");
}

const FILE_CHANGE_APPROVAL_METHOD = "item/fileChange/requestApproval";
const MCP_ELICITATION_METHOD = "mcpServer/elicitation/request";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function isTrustedAoaMcpToolCall(params: unknown): boolean {
  const request = asRecord(params);
  const meta = asRecord(request?._meta);
  const schema = asRecord(request?.requestedSchema);
  const properties = asRecord(schema?.properties);
  return (
    request?.serverName === "aoa" &&
    request?.mode === "form" &&
    meta?.codex_approval_kind === "mcp_tool_call" &&
    schema?.type === "object" &&
    properties != null &&
    Object.keys(properties).length === 0
  );
}

/**
 * If this `item/started` | `item/completed` notification carries a fileChange
 * item, return `[itemId, paths]`; otherwise null. A fileChange item is one whose
 * `type === "fileChange"` OR (defensively) that carries a `changes[]` array —
 * so we still capture even if a codex version omits/renames the type tag.
 */
function readFileChangeItem(params: unknown): { itemId: string; paths: string[] } | null {
  const item = asRecord(asRecord(params)?.item);
  if (!item) return null;
  const changes = Array.isArray(item.changes) ? item.changes : null;
  const isFileChange = item.type === "fileChange" || changes != null;
  if (!isFileChange || changes == null) return null;
  const itemId = typeof item.id === "string" ? item.id : null;
  if (!itemId) return null;
  const paths: string[] = [];
  for (const change of changes) {
    const p = asRecord(change)?.path;
    if (typeof p === "string" && p.length > 0) paths.push(p);
  }
  return { itemId, paths };
}

export async function driveCodexAppServer(
  input: DriveCodexAppServerInput,
): Promise<DriverResult> {
  const {
    cwd,
    approvalPolicy,
    timeoutSec,
    client,
    accumulator,
    onServerApproval,
    registerServerRequestHandler,
    registerNotificationHandler,
    session,
    terminate,
    onWarn = () => {},
  } = input;

  // --- Turn-resolution promise: resolved by a turn/completed | turn/failed
  //     notification, or by the timeout path. ---------------------------------
  let resolveTurn!: () => void;
  const turnDone = new Promise<void>((resolve) => {
    resolveTurn = resolve;
  });
  let turnResolved = false;
  const settleTurn = (): void => {
    if (turnResolved) return;
    turnResolved = true;
    resolveTurn();
  };

  // --- Unexpected-close unwind (SECURITY / no-hang) --------------------------
  // If the transport closes while the turn is still unresolved — the classic
  // "run cancelled mid-approval" path (heartbeat.cancelRun signals the tracked
  // child → child dies → jsonrpc-client.close() rejects all pending requests +
  // fires onClose) — a terminal turn/completed | turn/failed NOTIFICATION will
  // NEVER arrive. Without this hook the driver would wait for `turnDone` until
  // the timeout fires (or forever when timeoutSec === 0). Settle a SYNTHESIZED
  // turn/failed so the drive() promise resolves promptly.
  //
  // Double-settle safety: settleTurn is idempotent (`turnResolved`). If a real
  // terminal notification already resolved the turn, this close hook is a no-op;
  // if the close beats a late terminal notification, the later notification is
  // still routed to the accumulator but settleTurn ignores the second call.
  client.onClose(() => {
    if (turnResolved) return;
    accumulator.onNotification("turn/failed", {
      turn: { error: { message: "app-server closed" } },
    });
    settleTurn();
  });

  // --- fileChange path tracking (run-local) ---------------------------------
  // The `item/fileChange/requestApproval` server request carries only itemId (no
  // path). The path/diff arrive on the item/started + item/completed frames for
  // the same itemId. We record itemId → change paths here (last-write-wins:
  // item/completed refines item/started) so the approval can be ENRICHED before
  // it reaches the bridge (whose cwd trust boundary reads item.changes[].path).
  const fileChangePaths = new Map<string, string[]>();

  // --- Notification routing: accumulator + turn-terminal watch ---------------
  registerNotificationHandler((method, params) => {
    if (method === "item/started" || method === "item/completed") {
      const fc = readFileChangeItem(params);
      if (fc) fileChangePaths.set(fc.itemId, fc.paths);
    }
    accumulator.onNotification(method, params);
    if (method === "turn/completed" || method === "turn/failed") {
      settleTurn();
    }
  });

  // --- Approval routing: fail-closed ----------------------------------------
  registerServerRequestHandler(async (id, method, params) => {
    if (method === MCP_ELICITATION_METHOD) {
      if (isTrustedAoaMcpToolCall(params)) {
        // AoA tools are independently authorized by the MCP bridge using the
        // run actor, company, task, role, and explicit tool allowlist. This
        // response permits exactly this one invocation; it does not persist a
        // Codex grant or relax shell/filesystem/network policy.
        client.respond(id, { action: "accept", content: {}, _meta: null });
      } else {
        onWarn("[aoa] Declined unsupported Codex MCP elicitation request.");
        client.respond(id, { action: "decline", content: null, _meta: null });
      }
      return;
    }
    let decision: string;
    try {
      if (!onServerApproval) throw new Error("no approval bridge");
      decision = await onServerApproval(method, enrichApprovalParams(method, params));
    } catch {
      client.respond(id, DECLINE);
      return;
    }
    client.respond(id, { decision });
  });

  // Enrich ONLY a fileChange approval whose itemId we captured a path for,
  // merging `item: { changes: [{ path }] }` into the params (preserving all
  // original fields). NON-fileChange methods and unknown itemIds pass through
  // unchanged (an unknown itemId → the bridge fail-closes on "no change paths").
  function enrichApprovalParams(method: string, params: unknown): unknown {
    if (method !== FILE_CHANGE_APPROVAL_METHOD) return params;
    const rec = asRecord(params);
    const itemId = rec && typeof rec.itemId === "string" ? rec.itemId : null;
    if (!itemId) return params;
    const paths = fileChangePaths.get(itemId);
    if (!paths || paths.length === 0) return params;
    // Intentionally REPLACE any `params.item` with our tracked paths: the approval
    // frame carries no path (only itemId), and the bridge consumes ONLY
    // `item.changes[].path` (+ top-level reason/cwd, preserved by the spread). If a
    // future codex version starts populating `item` on the approval frame, the
    // tracked-from-frames paths remain the authoritative source for the boundary.
    return {
      ...rec,
      item: { changes: paths.map((p) => ({ path: p })) },
    };
  }

  // --- Lifecycle: initialize → initialized ----------------------------------
  await client.request("initialize", INITIALIZE_PARAMS);
  client.notify("initialized");

  // --- Resume decision (mirrors execute.ts) ----------------------------------
  const storedSessionId = session?.sessionId ?? "";
  const storedCwd = session?.cwd ?? "";
  const resumable =
    storedSessionId.length > 0 && canResumeSession(storedCwd, cwd);
  if (storedSessionId.length > 0 && !resumable) {
    // Replicate execute.ts warn-and-skip intent (~line 352).
    onWarn(
      `[aoa] Codex session "${storedSessionId}" was saved for cwd "${storedCwd}" ` +
        `and will not be resumed in "${cwd}".`,
    );
  }

  let threadId: string | null = null;
  // Track whether a resume was expected-missing so clearSession mirrors
  // toResult's `clearSessionOnMissingSession && !resolvedSessionId`.
  let clearSessionOnMissingSession = false;

  const startFresh = async (): Promise<void> => {
    const started = await client.request("thread/start", {
      cwd,
      approvalPolicy,
    });
    threadId = extractThreadId(started);
  };

  if (resumable) {
    try {
      const resumed = await client.request("thread/resume", {
        threadId: storedSessionId,
      });
      threadId = extractThreadId(resumed) ?? storedSessionId;
    } catch (err) {
      if (isUnknownSessionRejection(err)) {
        // Resume unavailable: a resume WAS expected but the id is gone. Fall
        // back to a fresh thread; clearSession is set ONLY IF no new id lands.
        clearSessionOnMissingSession = true;
        onWarn(
          `[aoa] Codex resume session "${storedSessionId}" is unavailable; ` +
            `retrying with a fresh thread.`,
        );
        await startFresh();
      } else {
        // Non-session error: surface it (the client already rejected).
        throw err;
      }
    }
  } else {
    await startFresh();
  }

  // --- turn/start ------------------------------------------------------------
  // Fire the turn but do NOT await its response to completion — the turn is
  // driven to done by the turn/completed | turn/failed NOTIFICATION. The
  // request response (turn accepted) may arrive before or after; we ignore it
  // for resolution but must not leave it unhandled.
  void client
    .request("turn/start", {
      threadId,
      approvalPolicy,
      input: input.input,
    })
    .catch((err) => {
      // A turn/start rejection means the turn will never complete — settle so we
      // don't hang; the accumulator surfaces the error if it was notified.
      // NOTE (seam contract for the Task 4 accumulator): if the server ALSO emits
      // a real turn/failed notification, the accumulator observes two terminal
      // events (one real, one synthesized here). settleTurn() is idempotent so the
      // driver never double-resolves, but result() must be idempotent/last-wins
      // over terminal turn events.
      accumulator.onNotification("turn/failed", {
        turn: { error: { message: err instanceof Error ? err.message : String(err) } },
      });
      settleTurn();
    });

  // --- Timeout race ----------------------------------------------------------
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (timeoutSec > 0) {
    await Promise.race([
      turnDone,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutSec * 1000);
      }),
    ]);
  } else {
    await turnDone;
  }
  if (timer) clearTimeout(timer);

  if (timedOut) {
    try {
      terminate?.();
    } catch {
      // terminate must not throw into the caller.
    }
  }

  // --- Assemble the neutral intermediate + session lifecycle fields ----------
  const intermediate = accumulator.result();
  const resolvedSessionId = threadId;

  return {
    ...intermediate,
    sessionId: resolvedSessionId,
    timedOut,
    // Mirror execute.ts toResult (~line 554): clear ONLY when a resume was
    // expected-missing AND no replacement id was obtained. A freshly captured
    // thread id (resolvedSessionId truthy) is NEVER wiped.
    clearSession: Boolean(clearSessionOnMissingSession && !resolvedSessionId),
  };
}
