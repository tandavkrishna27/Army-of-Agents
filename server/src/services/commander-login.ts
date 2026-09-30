/**
 * Interactive CLI-login lifecycle (Plan 3 / §6.2 Task 4).
 *
 * Orchestrates a `claude login` / `codex login` device flow started from
 * onboarding: spawn (via the provider streaming runner), surface the
 * verification URL, persist a DURABLE record (so a detached child can be reaped
 * after a hard restart), and finalize status from the child's exit + the
 * provider's credential-file evidence.
 *
 * Storage is behind {@link ChallengeStore} so the lifecycle is unit-testable
 * with an in-memory store; the route wires a Drizzle-backed impl.
 */

export type CommanderLoginProvider = "anthropic" | "openai";
export type ChallengeStatus = "pending" | "completed" | "failed" | "timeout";

export interface ChallengeRow {
  id: string;
  companyId: string;
  provider: CommanderLoginProvider;
  authHome: string;
  loginUrl: string | null;
  pid: number | null;
  pgid: number | null;
  status: ChallengeStatus;
  startedByUserId: string | null;
  startedAt: Date;
}

export interface ChallengeClaimArgs {
  provider: CommanderLoginProvider;
  authHome: string;
  /** The new pending row to insert (pid/pgid/loginUrl null until the child spawns). */
  row: ChallengeRow;
  /**
   * Called with the existing pending row for (provider, authHome) — across ALL
   * companies — if one exists, INSIDE the store's mutual-exclusion boundary.
   * Throw to abort the claim (nothing changes); return to take over (the
   * existing row is removed before `row` is inserted). Conflict/takeover
   * SEMANTICS stay in the service; the store only guarantees atomicity.
   */
  onExisting: (existing: ChallengeRow) => void;
}

export interface ChallengeStore {
  /**
   * Atomically claim the (provider, authHome) single-flight slot:
   * find the pending row → consult `onExisting` → remove it on takeover →
   * insert `row`. Implementations MUST make the whole sequence mutually
   * exclusive across concurrent claims — the `(provider, auth_home, status)`
   * index is NON-unique, so a plain find-then-insert lets two overlapping
   * starts both pass (Codex P1). The drizzle impl uses a transaction +
   * `pg_advisory_xact_lock`; an in-memory store is atomic by being synchronous.
   */
  claim(args: ChallengeClaimArgs): Promise<ChallengeRow>;
  get(id: string): Promise<ChallengeRow | null>;
  /**
   * Apply `patch` to the row and return the number of rows it AFFECTED. A return
   * of 0 means the row no longer exists — it was concurrently removed before the
   * pid/pgid backfill landed (Codex round-8 P1). Since the F1 refusal, a same-company
   * takeover can no longer delete an in-flight pid-null row, so the residual remover
   * is a founder `cancel` or the boot `reapOrphans` racing the spawn window. Callers
   * that must detect being superseded inspect this count; callers that don't ignore it.
   */
  update(id: string, patch: Partial<ChallengeRow>): Promise<number>;
  remove(id: string): Promise<void>;
  /** All rows still `pending` (orphans after a restart). */
  listActive(): Promise<ChallengeRow[]>;
}

/** The subset of a streaming login run the lifecycle consumes. */
export interface LoginRunLike {
  handle: { pid: number | null; pgid: number | null; terminate: () => void };
  urlPromise: Promise<string>;
  exitPromise: Promise<number | null>;
  authHome: string;
  /** Codex device authorization code. Memory-only; never persisted. */
  userCodePromise?: Promise<string>;
  /**
   * Deliver a pasted auth code to the LIVE child's stdin.
   *
   * Claude's `claude auth login` blocks reading this; codex self-completes via
   * a local callback and its stdin is deliberately not piped, so codex's
   * implementation always returns false. Callers must not read that as a
   * failure — see `SubmitCodeResult`.
   */
  submitCode: (code: string) => boolean;
}

/**
 * Outcome of delivering a pasted auth code.
 *  - "delivered"    — written to the live child's stdin
 *  - "unsupported"  — this provider does not accept a pasted code (codex
 *                     self-completes via its local callback)
 *  - "not-live"     — no LIVE, SAME-COMPANY child to deliver to: the registry
 *                     has no entry for this challengeId (server restarted,
 *                     challenge belongs to another process, or already
 *                     finalized/cancelled), OR the entry belongs to a
 *                     DIFFERENT company (cross-tenant call) — both report as
 *                     absent, indistinguishable from "unknown challenge",
 *                     mirroring `getStatus`/`cancel`.
 *  - "write-failed" — a live, same-company child WAS found and the write was
 *                     attempted, but the child refused it (e.g. already past
 *                     the prompt, or the process is exiting).
 */
export type SubmitCodeResult = "delivered" | "unsupported" | "not-live" | "write-failed";

export interface CommanderLoginServiceDeps {
  store: ChallengeStore;
  resolveAuthHome: (
    provider: CommanderLoginProvider,
    env: NodeJS.ProcessEnv,
    scope: { companyId: string; userId: string; executionTargetId: string | null },
  ) => string;
  runLogin: (
    provider: CommanderLoginProvider,
    args: { runId: string; env: NodeJS.ProcessEnv; authHome: string },
  ) => LoginRunLike;
  /** Provider-specific completion evidence (codex auth.json / claude credential file). */
  credentialPresent: (provider: CommanderLoginProvider, authHome: string) => Promise<boolean>;
  /** Persist the logical owner/target record after provider-native evidence exists. */
  onCredentialEvidence?: (args: {
    companyId: string;
    provider: CommanderLoginProvider;
    userId: string;
    executionTargetId: string;
  }) => Promise<void>;
  /**
   * Kill a login child by its PERSISTED pid/pgid. `expected.startedAt` is
   * REQUIRED — every caller of this seam kills a pid that came from a DB row,
   * which after a crash + restart may have been REUSED by an unrelated process,
   * so the impl MUST verify the target's OS start time against `startedAt` before
   * signalling (a reused pid is spared). All three persisted-pid paths route
   * through here identity-verified:
   *   - `reapOrphans` (BOOT, killing DURABLE rows from a PRIOR process),
   *   - the single-flight takeover in `startChallenge`'s `onExisting` (the
   *     existing row may be a DURABLE prior-process row — the boot reap runs
   *     un-awaited, so a takeover can beat it),
   *   - `cancel` (the UI fires cancel-on-unmount with a challengeId the BROWSER
   *     retains across a server restart / after the CLI already exited, so the
   *     row's pid may likewise be reused — Codex round-7 P1).
   * The ONLY kills that stay UNCONDITIONAL are those using a LIVE in-memory child
   * handle from the current process (`run.handle.terminate()`), which is not
   * PID-reuse-prone and never routes through this seam (Codex P1, round 6 →
   * round 7).
   */
  terminate: (pid: number, pgid: number | null, expected: { startedAt: Date }) => void;
  /**
   * Schedule the post-URL completion deadline (Codex round-7 P2) and return a
   * canceller invoked when the child finalizes FIRST. Injected so tests drive the
   * deadline deterministically without real timers or a leaked open handle; the
   * default (see `defaultDeadlineTimer`) uses an UNREF'd `setTimeout` so a pending
   * deadline never keeps the process (or a test runner) alive.
   */
  setDeadlineTimer?: (fn: () => void, ms: number) => () => void;
  newId: () => string;
  env: () => NodeJS.ProcessEnv;
  now?: () => Date;
}

export class LoginChallengeConflictError extends Error {
  status = 409;
  constructor(message: string) {
    super(message);
    this.name = "LoginChallengeConflictError";
  }
}

export interface StartChallengeResult {
  challengeId: string;
  loginUrl: string;
  userCode: string | null;
  expiresAt: string;
  /** Resolves once the login has finalized (completed/failed). Route can ignore it; tests await it. */
  completion: Promise<void>;
}

export interface CommanderLoginService {
  startChallenge(args: {
    companyId: string;
    provider: CommanderLoginProvider;
    startedByUserId: string | null;
    executionTargetId?: string | null;
  }): Promise<StartChallengeResult>;
  /** Company-scoped: a challenge owned by another company is reported absent. */
  getStatus(
    companyId: string,
    id: string,
    expectedProvider?: CommanderLoginProvider | null,
    startedByUserId?: string,
  ): Promise<{ status: ChallengeStatus; loginUrl: string | null } | null>;
  /** Company-scoped: a cross-tenant cancel is a silent no-op (as if absent). */
  cancel(
    companyId: string,
    id: string,
    expectedProvider?: CommanderLoginProvider | null,
    startedByUserId?: string,
  ): Promise<void>;
  reapOrphans(): Promise<void>;
  /**
   * Deliver a pasted auth code to the challenge's LIVE child in THIS process.
   *
   * Company-scoped, exactly like `getStatus`/`cancel` — and here it matters
   * MORE than in either sibling: this is the one method in the service that
   * performs a WRITE into a live child process (its stdin), not merely a
   * read or a self-owned terminate. Without the check, a founder of company
   * A who obtains company B's challengeId could deliver an attacker-chosen
   * OAuth code into B's live `claude auth login` stdin, leaving B's shared
   * credential home authenticated as the attacker — a confused-deputy WRITE
   * into another tenant's child, not an information leak. A company mismatch
   * is therefore treated exactly like an unknown challengeId (`"not-live"`),
   * the same non-leaking "report as absent" convention `getStatus`/`cancel`
   * already use.
   */
  submitCode(
    companyId: string,
    challengeId: string,
    code: string,
    startedByUserId?: string,
  ): SubmitCodeResult;
}

/**
 * How long the lifecycle waits, AFTER the verification URL is surfaced, for the
 * login child to finalize before it is force-terminated and the row is marked
 * `timeout` (Codex round-7 P2). Chosen a few minutes: long enough for a real
 * device-code flow (open browser → sign in → possibly 2FA) to complete without
 * being cut off, short enough to reliably free the codex :1455 callback port and
 * the global (provider, authHome) single-flight slot when a child hangs without
 * ever exiting. If the CLI honors the device-code's own expiry it exits on its
 * own (→ completed/failed) well before this backstop; the deadline only fires
 * when the child neither exits nor is cancelled within the window.
 */
export const LOGIN_COMPLETION_DEADLINE_MS = 5 * 60_000;

/**
 * How many times a TERMINAL status write (`completed`/`failed`/`timeout`) is
 * retried before the lifecycle gives up and instead REMOVES the row to release
 * the single-flight slot (Codex round-8 P2 :348). A transient reject on the
 * terminal write must never strand the row `pending` forever — that would block
 * the global (provider, authHome) slot even after the DB recovers, 409-ing every
 * future login. A lost terminal status is far less harmful than a permanently
 * stuck slot (the child is already exited/terminated on every path that writes a
 * terminal status), so on total failure we drop the row.
 */
export const FINALIZE_WRITE_ATTEMPTS = 3;

/**
 * Default completion-deadline timer: an UNREF'd `setTimeout` so a pending login
 * deadline never keeps the process (or a test runner) alive, plus a canceller
 * that clears it. Overridable via `deps.setDeadlineTimer` for deterministic tests.
 */
function defaultDeadlineTimer(fn: () => void, ms: number): () => void {
  const handle = setTimeout(fn, ms);
  (handle as { unref?: () => void }).unref?.();
  return () => clearTimeout(handle);
}

export function createCommanderLoginService(deps: CommanderLoginServiceDeps): CommanderLoginService {
  const now = deps.now ?? (() => new Date());
  const setDeadlineTimer = deps.setDeadlineTimer ?? defaultDeadlineTimer;

  /**
   * Challenges started by THIS process, keyed by challengeId.
   *
   * Deliberately in-memory and NOT persisted: delivering a pasted code requires
   * the live child's stdin, which exists only in the process that spawned it. A
   * challenge from a prior process therefore cannot receive a code, and the
   * honest answer is "start again" — mirroring the LIVE-handle vs DURABLE-row
   * distinction this service already draws for kills (see `terminate` above).
   *
   * Entries are added once the child has spawned (so `run.submitCode` exists)
   * and removed on every terminal path: pid-backfill failure, superseded
   * (0-row backfill), URL-discovery failure, normal
   * finalize (completed/failed/timeout, inside `finalize`), and `cancel`.
   */
  const liveRuns = new Map<
    string,
    {
      companyId: string;
      startedByUserId: string | null;
      provider: CommanderLoginProvider;
      loginUrl: string | null;
      submitCode: (code: string) => boolean;
    }
  >();

  /**
   * Resilient terminal-status write (Codex round-8 P2 :348 + its siblings). Write
   * `status` to the row; on a transient reject retry a bounded number of times and,
   * if EVERY attempt fails, best-effort REMOVE the row to release the single-flight
   * slot. NEVER throws — every caller has already terminated/observed the child, so
   * masking the write error and guaranteeing the slot is freed is the correct
   * trade (a stranded `pending` row is the worse failure). Shared by the async
   * completion `finalize` AND the synchronous spawn/backfill/url-failure cleanup
   * paths so no terminal-status write anywhere can leave a `pending` row behind.
   */
  async function settleTerminal(id: string, status: ChallengeStatus): Promise<void> {
    for (let attempt = 1; attempt <= FINALIZE_WRITE_ATTEMPTS; attempt++) {
      try {
        await deps.store.update(id, { status });
        return;
      } catch {
        if (attempt === FINALIZE_WRITE_ATTEMPTS) {
          await deps.store.remove(id).catch(() => {
            /* best-effort — even remove failed; the boot reaper is the last resort */
          });
        }
      }
    }
  }

  async function startChallenge(args: {
    companyId: string;
    provider: CommanderLoginProvider;
    startedByUserId: string | null;
    executionTargetId?: string | null;
  }): Promise<StartChallengeResult> {
    const env = deps.env();
    const authHome = deps.resolveAuthHome(args.provider, env, {
      companyId: args.companyId,
      userId: args.startedByUserId ?? "board",
      executionTargetId: args.executionTargetId ?? null,
    });
    const id = deps.newId();

    // Single-flight per (provider, authHome), decided ATOMICALLY inside the
    // store's claim (transaction + advisory lock in the drizzle impl) — a
    // check-then-act find→spawn→insert let two overlapping starts both spawn
    // children that fight over the credential home + codex callback port
    // (:1455). A pending challenge owned by ANOTHER company blocks (409). For
    // the SAME company, a re-attempt must not leave a second child alive, so
    // we cancel the prior child (free the port) and start ONE clean login.
    // The row is durable BEFORE the child spawns; pid/pgid are backfilled.
    await deps.store.claim({
      provider: args.provider,
      authHome,
      row: {
        id,
        companyId: args.companyId,
        provider: args.provider,
        authHome,
        loginUrl: null,
        pid: null,
        pgid: null,
        status: "pending",
        startedByUserId: args.startedByUserId,
        startedAt: now(),
      },
      onExisting: (existing) => {
        if (existing.companyId !== args.companyId) {
          throw new LoginChallengeConflictError(
            `another company is already signing in with ${args.provider} at ${authHome}`,
          );
        }
        // F1 (Codex round-8 review): REFUSE to take over an IN-FLIGHT (pid-null)
        // same-company row. The row is durable at CLAIM time but its pid/pgid are
        // backfilled only AFTER the child spawns — OUTSIDE this advisory-locked
        // claim (the lock is released at claim-commit). So a concurrent same-company
        // start can acquire the lock and land HERE while the prior start's child is
        // still mid-spawn (pid null). We have no pid to identity-verify-kill, and
        // silently letting the store DELETE this row opens the last two-children
        // window: if that delete LOSES the row-lock race to the in-flight start's
        // pid backfill, the backfill matches 1 row (NOT superseded → its round-8
        // 0-row self-terminate never triggers) and its child lives on as an orphan
        // while THIS start spawns a SECOND child — the two duel for the codex :1455
        // callback port + the shared credential home until the 5-min deadline reaps
        // one. Backing off with a 409 (throw → the claim tx rolls back, nothing
        // deleted or inserted, exactly like the cross-company conflict) means the
        // in-flight start's delete NEVER happens, so its backfill ALWAYS matches 1
        // row → exactly one child. (The round-8 0-row-backfill self-terminate stays
        // as defense-in-depth for any residual delete.) This pid-null row cannot
        // linger and deadlock the slot: within a healthy process it resolves inside
        // the spawn window (backfill sets pid) or is removed by `settleTerminal` on
        // a spawn-throw / backfill-reject; a hard crash mid-spawn leaves it for the
        // boot `reapOrphans`, which removes pid-null pending rows unconditionally.
        if (existing.pid == null) {
          throw new LoginChallengeConflictError(
            `a ${args.provider} sign-in is already starting at ${authHome}`,
          );
        }
        // Identity-verified takeover kill (Codex P1, round 6 follow-on). Here
        // `existing.pid` is SET — the backfill completed, so this is a REAL prior
        // child (possibly HUNG). This is the legitimate round-2 takeover: a
        // re-attempt cancels the prior child and starts one clean login. The
        // single-flight slot is reclaimed whether or not the kill fires (the row
        // is removed/replaced by the store either way), but the `existing` row
        // may be DURABLE — persisted by a PRIOR process whose pid has since been
        // reused, because the boot reaper (`reapOrphans`) is fired UN-awaited at
        // startup (index.ts) and a same-(provider,authHome) start served early
        // in boot can hit this callback before that reap clears the stale row.
        // So route through the SAME `expected.startedAt` identity check the
        // reaper uses — a reused pid is skipped, a genuine this-session child
        // (start time ≤ startedAt + tolerance) is still killed so the codex
        // :1455 callback port is freed for the fresh login.
        deps.terminate(existing.pid, existing.pgid, { startedAt: existing.startedAt });
        // The existing row is removed as part of this takeover (see `claim`
        // above) — if it happens to be one of THIS process's own live runs
        // (e.g. a hung same-process retry), a pasted code must no longer
        // reach it once its row is gone. Harmless no-op otherwise (the
        // common case: `existing` is a DURABLE row from another process).
        liveRuns.delete(existing.id);
      },
    });

    let run: LoginRunLike;
    try {
      run = deps.runLogin(args.provider, { runId: id, env, authHome });
    } catch (err) {
      // Spawn failed — release the slot (never leave a dangling `pending` row).
      await settleTerminal(id, "failed");
      throw err;
    }
    // Register the live child NOW — `submitCode` needs a real child, and every
    // path below that can end this challenge (backfill failure, superseded,
    // URL-discovery failure, normal finalize, cancel)
    // removes this entry so a dead/foreign challenge never looks live.
    liveRuns.set(id, {
      companyId: args.companyId,
      startedByUserId: args.startedByUserId,
      provider: args.provider,
      loginUrl: null,
      submitCode: run.submitCode,
    });
    // Capture the child's ACTUAL spawn instant (Codex round-8 P2 :202). `startedAt`
    // was set at CLAIM time — before the advisory-lock wait + spawn. If that wait
    // exceeds `terminateByPidIfMatches`'s 2s tolerance, the child's real OS start
    // time drifts past `startedAt + tolerance`, so the identity check would
    // misclassify the GENUINE child as a reused pid and REFUSE to kill it (a
    // permanent un-killable orphan). Persist the real spawn time — now that `run`
    // exists — so the identity check compares against when the child truly started.
    // Use the `now()` clock seam (no bare Date()) so tests stay deterministic.
    const spawnedAt = now();
    let backfilled: number;
    try {
      backfilled = await deps.store.update(id, {
        pid: run.handle.pid,
        pgid: run.handle.pgid,
        startedAt: spawnedAt,
      });
    } catch (err) {
      // The pid/pgid backfill rejected AFTER the child spawned (transient DB
      // disconnect). The child SURVIVES — holding the shared credential home
      // and, for codex, the :1455 callback port — but the row is still `pending`
      // with pid: null. The boot reaper terminates BY pid, so it can't kill this
      // process; a same-company retry's `onExisting` also guards on pid != null,
      // so it would leave this child alive and spawn a SECOND one; a different
      // company retry gets a permanent 409. Terminate the child NOW, best-effort
      // — this frees the port even if the compensating status write also fails,
      // which is the load-bearing part.
      try {
        run.handle.terminate();
      } catch {
        // best-effort
      }
      // We throw before wiring the exit finalizer below — keep a rejecting
      // exitPromise from becoming an unhandled rejection.
      run.exitPromise.catch(() => {});
      // The child is dead/dying — a pasted code can no longer reach it.
      liveRuns.delete(id);
      // Mark failed (resilient: retries, then removes to release the slot) so the
      // single-flight slot isn't falsely held; the port is already freed above.
      // Rethrow the ORIGINAL error (settleTerminal never throws, so it can't mask it).
      await settleTerminal(id, "failed");
      throw err;
    }
    if (backfilled === 0) {
      // Superseded (Codex round-8 P1 :222), retained as DEFENSE-IN-DEPTH behind the
      // F1 refusal (round-8 review). Our row is gone, so this update affected 0 rows
      // WITHOUT throwing. F1 now stops a concurrent SAME-company start from ever
      // DELETING our in-flight (pid-null) row — its `onExisting` refuses the takeover
      // of a pid-null row (409) rather than deleting it — so the ONLY residual way our
      // row disappears before this backfill lands is a concurrent REMOVAL: a founder
      // `cancel` or the boot `reapOrphans` racing the spawn window (both remove a
      // pid-null pending row). Whatever the cause, a 0-row result means we are the
      // LOSER and our just-spawned child would be an orphan dueling for the codex
      // :1455 callback port + the shared credential home. Self-clean: terminate OUR
      // OWN live child (an in-memory handle → an unconditional kill is correct here;
      // it is NOT a persisted, possibly-reused pid) and ABORT before awaiting the URL
      // or wiring the completion chain (either would keep the loser alive). Nothing to
      // mark terminal — the row no longer exists. Surfaces as the 409 the route already
      // maps, converging the slot to exactly one child.
      try {
        run.handle.terminate();
      } catch {
        // best-effort
      }
      run.exitPromise.catch(() => {});
      liveRuns.delete(id); // our own row is already gone; nothing to deliver a code to
      throw new LoginChallengeConflictError(
        `a concurrent ${args.provider} sign-in superseded this attempt`,
      );
    }

    let loginUrl: string;
    try {
      loginUrl = await run.urlPromise;
    } catch (err) {
      // The child SURVIVES URL-discovery failure (it keeps holding the shared
      // credential home and, for codex, the :1455 callback port) and the boot
      // reaper only sweeps `pending` rows — kill it now, best-effort.
      try {
        run.handle.terminate();
      } catch {
        // best-effort
      }
      // We throw before wiring the exit finalizer below — keep a rejecting
      // exitPromise from becoming an unhandled rejection.
      run.exitPromise.catch(() => {});
      // `login-url-timeout` is the runner's documented discovery-window
      // rejection (adapter-utils streaming-login). The UI treats failed and
      // timeout identically (VerifyStep), so `timeout` is contract-safe AND
      // more honest for that case; everything else stays `failed`.
      // Never leave a dangling `pending` row — it would falsely hold the lock.
      // Resilient (retries, then removes) so a DB blip here can't strand pending,
      // and the ORIGINAL url error still propagates (settleTerminal never throws).
      const status: ChallengeStatus =
        err instanceof Error && err.message === "login-url-timeout" ? "timeout" : "failed";
      liveRuns.delete(id); // child killed above — no longer reachable for a pasted code
      await settleTerminal(id, status);
      throw err;
    }
    /* Login URLs are short-lived bearer material and intentionally stay in memory. */
    const liveRun = liveRuns.get(id);
    if (liveRun) liveRun.loginUrl = loginUrl;
    let userCode: string | null = null;
    if (run.userCodePromise) {
      try {
        userCode = await run.userCodePromise;
      } catch (err) {
        try {
          run.handle.terminate();
        } catch {
          // best-effort
        }
        run.exitPromise.catch(() => {});
        liveRuns.delete(id);
        const status: ChallengeStatus =
          err instanceof Error && err.message === "device-code-timeout" ? "timeout" : "failed";
        await settleTerminal(id, status);
        throw err;
      }
    }
    // Finalize asynchronously from the child's exit + credential evidence, BUT
    // bound the wait with a completion deadline (Codex round-7 P2). After the URL
    // is surfaced the child normally finalizes from its own exit (exit 0 +
    // credential → completed; else failed). If the user never completes the
    // browser flow — or closes the tab before the fire-and-forget cancel reaches
    // the server — the CLI can wait INDEFINITELY: the exit never fires, the
    // URL-discovery timer is already cleared, and the row would sit `pending`
    // forever while the child keeps the codex :1455 callback port and the global
    // (provider, authHome) slot → every OTHER company 409s until a restart. So
    // race the exit against a server-side deadline and, on elapse, kill the LIVE
    // child (this process's own handle → an unconditional terminate is correct
    // here; it is NOT a persisted, possibly-reused pid) and finalize `timeout`.
    const completion = (async () => {
      let settled = false;
      let cancelDeadline: (() => void) | null = null;

      // First-wins finalizer: the completion outcome and the deadline can land
      // ~together (the terminal determination resolving as the timer fires). Only
      // the FIRST outcome finalizes — we never overwrite a completed/failed with
      // `timeout` (or vice-versa) — and we always clear the pending deadline timer
      // so no timer/open-handle leaks past completion. The terminal write itself is
      // RESILIENT (Codex round-8 P2 :348): a transient reject retries, then removes
      // the row to release the slot, so a finalize failure can never strand the row
      // `pending` forever (which would block the global slot after the DB recovers).
      const finalize = async (status: ChallengeStatus): Promise<void> => {
        if (settled) return;
        settled = true;
        cancelDeadline?.();
        cancelDeadline = null;
        // Terminal for THIS run (completed/failed/timeout) — the live-child
        // registry entry is no longer valid for a pasted code either way.
        liveRuns.delete(id);
        await settleTerminal(id, status);
      };

      const deadlineHit = new Promise<"deadline">((resolve) => {
        cancelDeadline = setDeadlineTimer(() => resolve("deadline"), LOGIN_COMPLETION_DEADLINE_MS);
      });
      // A rejection handler is attached here, so the raw `exitPromise` never
      // becomes an unhandled rejection even when the deadline wins the race and we
      // stop awaiting the exit.
      const exited = run.exitPromise.then(
        (code) => ({ kind: "exit" as const, code }),
        () => ({ kind: "exit-error" as const }),
      );

      // The FULL completion determination — the child's exit AND the subsequent
      // `credentialPresent` check — must sit INSIDE the raced promise (Codex
      // round-8 P2 :342). Previously `credentialPresent` was awaited AFTER the race
      // had already resolved on exit, so if it HUNG (an unresponsive auth-home FS)
      // the deadline could no longer fire and the row sat `pending` forever. Folding
      // it in means a hang there still trips the deadline → terminate + `timeout`.
      // The trailing `.then` reject-handler maps a `credentialPresent` REJECTION to
      // `failed` so a late reject (after the deadline already won the race) can never
      // surface as an unhandled rejection; a genuine HANG simply never settles and
      // the deadline wins. When it completes in time the original semantics hold:
      // exit 0 + credential present → completed, else failed.
      const completed = (async (): Promise<ChallengeStatus> => {
        const result = await exited;
        if (result.kind === "exit-error") return "failed";
        const ok =
          result.code === 0 && (await deps.credentialPresent(args.provider, authHome));
        if (ok && args.startedByUserId) {
          await deps.onCredentialEvidence?.({
            companyId: args.companyId,
            provider: args.provider,
            userId: args.startedByUserId,
            executionTargetId: args.executionTargetId ?? "control-plane",
          });
        }
        return ok ? "completed" : "failed";
      })().then(
        (status) => ({ kind: "done" as const, status }),
        () => ({ kind: "done" as const, status: "failed" as ChallengeStatus }),
      );

      const outcome = await Promise.race([completed, deadlineHit]);
      if (outcome === "deadline") {
        // Deadline elapsed before the child finalized — it never exited, or it
        // exited but the credential check is hanging. Kill the LIVE child (this
        // process's own handle → an unconditional terminate is correct here) and
        // finalize `timeout`.
        try {
          run.handle.terminate();
        } catch {
          /* best-effort — the row is finalized regardless */
        }
        await finalize("timeout");
        return;
      }
      await finalize(outcome.status);
    })().catch(() => {
      // Completion is fire-and-forget from the route's perspective; store writes
      // are best-effort, so a failed finalize must never surface as an unhandled
      // rejection.
    });

    return {
      challengeId: id,
      loginUrl,
      userCode,
      expiresAt: new Date(now().getTime() + LOGIN_COMPLETION_DEADLINE_MS).toISOString(),
      completion,
    };
  }

  async function getStatus(
    companyId: string,
    id: string,
    expectedProvider?: CommanderLoginProvider | null,
    startedByUserId?: string,
  ): Promise<{ status: ChallengeStatus; loginUrl: string | null } | null> {
    const row = await deps.store.get(id);
    // Company-scoped (Codex P1): a row owned by another company is reported
    // NOT FOUND — never leak existence (or the OAuth loginUrl) across tenants.
    if (
      !row ||
      row.companyId !== companyId ||
      (expectedProvider != null && row.provider !== expectedProvider) ||
      (startedByUserId !== undefined && row.startedByUserId !== startedByUserId)
    )
      return null;
    return { status: row.status, loginUrl: liveRuns.get(id)?.loginUrl ?? null };
  }

  async function cancel(
    companyId: string,
    id: string,
    expectedProvider?: CommanderLoginProvider | null,
    startedByUserId?: string,
  ): Promise<void> {
    const row = await deps.store.get(id);
    // Cross-tenant cancel is a silent no-op — as if absent (no distinct error
    // that would leak existence), and NEVER terminate another company's child.
    if (
      !row ||
      row.companyId !== companyId ||
      (expectedProvider != null && row.provider !== expectedProvider) ||
      (startedByUserId !== undefined && row.startedByUserId !== startedByUserId)
    )
      return;
    // Identity-verified cancel (Codex round-7 P1). The UI fires cancel-on-unmount
    // (VerifyStep) with a challengeId the BROWSER retains across a server restart /
    // after the CLI already exited, so this row's persisted pid can belong to an
    // UNRELATED, reused-pid process by now. Two guards, mirroring reapOrphans /
    // onExisting so NO persisted-pid kill anywhere stays unconditional:
    //   (a) only a still-`pending` row's child is ours to signal — a terminal
    //       (completed/failed/timeout) row's pid is no longer ours; never kill it.
    //   (b) even a pending row routes through the SAME start-time identity check —
    //       a genuine same-session live child (start ≤ startedAt + tolerance) is
    //       still killed (no regression to legitimate live cancel), a reused pid is
    //       spared.
    // Release the slot (remove the row) regardless of whether the kill fired.
    if (row.status === "pending" && row.pid != null)
      deps.terminate(row.pid, row.pgid, { startedAt: row.startedAt });
    // The row is gone either way — no code can be delivered to it anymore.
    liveRuns.delete(id);
    await deps.store.remove(id);
  }

  async function reapOrphans(): Promise<void> {
    const rows = await deps.store.listActive();
    for (const row of rows) {
      // Identity-verified terminate (Codex P1, round 6): these rows were persisted
      // by a PRIOR process, so the pid may have been reused after a crash + restart.
      // Passing `startedAt` makes the terminate impl kill ONLY when the target's OS
      // start time matches — a reused pid is left untouched. The row is removed
      // either way (releases the single-flight slot), exactly as before.
      if (row.pid != null) deps.terminate(row.pid, row.pgid, { startedAt: row.startedAt });
      // Mostly a no-op (these rows are normally DURABLE, from a prior process),
      // but harmless + correct if a same-process row is ever swept here too.
      liveRuns.delete(row.id);
      await deps.store.remove(row.id);
    }
  }

  function submitCode(
    companyId: string,
    challengeId: string,
    code: string,
    startedByUserId?: string,
  ): SubmitCodeResult {
    const live = liveRuns.get(challengeId);
    // Registry miss OR cross-tenant: report as absent, mirroring
    // getStatus/cancel — never distinguish "unknown" from "belongs to
    // another company" (that distinction is itself information a foreign
    // caller should not learn), and never write into another tenant's child.
    if (
      !live ||
      live.companyId !== companyId ||
      (startedByUserId !== undefined && live.startedByUserId !== startedByUserId)
    )
      return "not-live";
    // Codex never accepts a pasted code: its stdin is not piped by design.
    if (live.provider === "openai") return "unsupported";
    // The write was attempted against a live, same-company child; the child
    // itself refused it (already past the prompt, or exiting).
    return live.submitCode(code) ? "delivered" : "write-failed";
  }

  return { startChallenge, getStatus, cancel, reapOrphans, submitCode };
}
