import { describe, it, expect, vi } from "vitest";
import {
  createCommanderLoginService,
  LoginChallengeConflictError,
  type ChallengeStore,
  type ChallengeRow,
} from "../services/commander-login.js";
import { terminateByPidIfMatches } from "../utils/terminate-process.js";

/**
 * In-memory ChallengeStore for lifecycle tests. `claim` is synchronous
 * in-process, so it is atomic by nature — it implements the same
 * find→decide→remove→insert contract the drizzle store runs under a
 * transaction + advisory lock.
 */
function memStore(): ChallengeStore & { rows: Map<string, ChallengeRow> } {
  const rows = new Map<string, ChallengeRow>();
  return {
    rows,
    async claim({ provider, authHome, row, onExisting }) {
      const existing =
        [...rows.values()].find(
          (r) => r.provider === provider && r.authHome === authHome && r.status === "pending",
        ) ?? null;
      if (existing) {
        onExisting({ ...existing }); // throws → abort, nothing inserted
        rows.delete(existing.id);
      }
      rows.set(row.id, { ...row });
      return { ...row };
    },
    async get(id) {
      const r = rows.get(id);
      return r ? { ...r } : null;
    },
    async update(id, patch) {
      // Return rows AFFECTED (0 when the row was concurrently removed) — mirrors the
      // drizzle store's `.returning().length`, which the pid/pgid backfill uses to
      // detect a same-company takeover superseding it (Codex round-8 P1).
      const r = rows.get(id);
      if (!r) return 0;
      rows.set(id, { ...r, ...patch });
      return 1;
    },
    async remove(id) {
      rows.delete(id);
    },
    async listActive() {
      return [...rows.values()].filter((r) => r.status === "pending").map((r) => ({ ...r }));
    },
  };
}

/** A controllable fake login run. */
function fakeRun(
  pid = 111,
  pgid = 111,
  submitCode: (code: string) => boolean = vi.fn(() => true),
) {
  let resolveUrl!: (u: string) => void;
  let rejectUrl!: (e: Error) => void;
  let resolveExit!: (code: number | null) => void;
  let rejectExit!: (e: Error) => void;
  const urlPromise = new Promise<string>((res, rej) => {
    resolveUrl = res;
    rejectUrl = rej;
  });
  const exitPromise = new Promise<number | null>((res, rej) => {
    resolveExit = res;
    rejectExit = rej;
  });
  const handle = { child: {} as never, pid, pgid, startedAt: new Date(0), terminate: vi.fn() };
  return {
    run: { handle, urlPromise, exitPromise, authHome: "/home/.codex", submitCode },
    resolveUrl,
    rejectUrl,
    resolveExit,
    rejectExit,
    handle,
    submitCode,
  };
}

function makeService(overrides: Partial<Parameters<typeof createCommanderLoginService>[0]> = {}) {
  const store = memStore();
  const terminate = vi.fn();
  let seq = 0;
  const svc = createCommanderLoginService({
    store,
    resolveAuthHome: () => "/home/.codex",
    runLogin: () => fakeRun().run,
    credentialPresent: async () => true,
    terminate,
    newId: () => `ch-${++seq}`,
    env: () => ({}) as never,
    // No-op completion-deadline seam by default: the background completion never
    // schedules a REAL timer, so tests that don't exercise the deadline leave no
    // open handle. Deadline-specific tests override with a controllable fake.
    setDeadlineTimer: () => () => {},
    ...overrides,
  });
  return { svc, store, terminate };
}

describe("commander-login service (Plan 3 T4)", () => {
  it("(a) keeps loginUrl in memory while the durable row stores only process metadata", async () => {
    const f = fakeRun(222, 222);
    const { svc, store } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=Z9");
    const { challengeId, loginUrl } = await startP;
    expect(loginUrl).toBe("https://chatgpt.com/device?code=Z9");
    const row = store.rows.get(challengeId)!;
    expect(row).toMatchObject({
      companyId: "c1",
      provider: "openai",
      authHome: "/home/.codex",
      pid: 222,
      pgid: 222,
      status: "pending",
      loginUrl: null,
    });
    expect((await svc.getStatus("c1", challengeId, null, "u1"))?.loginUrl).toBe(
      "https://chatgpt.com/device?code=Z9",
    );
  });

  it("(a') the pending row is durable BEFORE the child spawns (claim → spawn → pid update)", async () => {
    // Codex P1 #3 — check-then-act (findPending → spawn → insert) let two
    // overlapping starts both spawn. The claim must commit the row first,
    // then spawn, then backfill pid/pgid.
    const order: string[] = [];
    const store = memStore();
    const baseClaim = store.claim.bind(store);
    store.claim = async (args) => {
      order.push("claim");
      return baseClaim(args);
    };
    const baseUpdate = store.update.bind(store);
    store.update = async (id, patch) => {
      order.push(`update:${Object.keys(patch).sort().join(",")}`);
      return baseUpdate(id, patch);
    };
    const f = fakeRun(888, 888);
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => {
        order.push("spawn");
        return f.run;
      },
      credentialPresent: async () => true,
      terminate: vi.fn(),
      newId: () => "ch-1",
      env: () => ({}) as never,
    });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=A");
    await startP;
    // The post-spawn backfill now writes the ACTUAL spawn `startedAt` alongside
    // pid/pgid (Codex round-8 P2 :202), so the patch keys are pgid,pid,startedAt.
    expect(order.slice(0, 3)).toEqual(["claim", "spawn", "update:pgid,pid,startedAt"]);
    // At claim time the row had no pid yet; the post-spawn update backfilled it.
    expect(store.rows.get("ch-1")).toMatchObject({ pid: 888, pgid: 888 });
  });

  it("(a'') spawn failure marks the already-durable row failed and rethrows", async () => {
    const store = memStore();
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => {
        throw new Error("spawn-fail");
      },
      credentialPresent: async () => true,
      terminate: vi.fn(),
      newId: () => "ch-1",
      env: () => ({}) as never,
    });
    await expect(
      svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" }),
    ).rejects.toThrow(/spawn-fail/);
    const rows = [...store.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed"); // no dangling pending row holding the slot
  });

  it("(b) rejects a second start for a DIFFERENT company sharing (provider, authHome)", async () => {
    const f1 = fakeRun();
    const { svc } = makeService({ runLogin: () => f1.run });
    const p1 = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f1.resolveUrl("https://chatgpt.com/device?code=A");
    await p1;
    await expect(
      svc.startChallenge({ companyId: "c2", provider: "openai", startedByUserId: "u2" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("(b') same company re-start cancels the stale child (frees :1455) and starts fresh", async () => {
    const f1 = fakeRun(555, 555);
    const f2 = fakeRun(666, 666);
    let call = 0;
    const store = memStore();
    const terminate = vi.fn();
    let seq = 0;
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => (call++ === 0 ? f1.run : f2.run),
      credentialPresent: async () => true,
      terminate,
      newId: () => `ch-${++seq}`,
      env: () => ({}) as never,
    });
    const p1 = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f1.resolveUrl("https://chatgpt.com/device?code=A");
    const first = await p1;

    // Capture the first (soon-to-be-existing) row's startedAt — the takeover now
    // forwards it as the identity `expected` so a reused pid would be skipped.
    const firstRow = store.rows.get(first.challengeId)!;

    const p2 = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f2.resolveUrl("https://chatgpt.com/device?code=B");
    const second = await p2;

    // The stale child was killed THROUGH the identity-verified path (3rd arg),
    // exactly like the reaper — not the old unconditional 2-arg kill.
    expect(terminate).toHaveBeenCalledWith(555, 555, { startedAt: firstRow.startedAt });
    expect(second.challengeId).not.toBe(first.challengeId); // a fresh challenge
    expect(second.loginUrl).toBe("https://chatgpt.com/device?code=B");
    // Only the new row survives — no orphaned pending row holding the lock.
    expect([...store.rows.values()].filter((r) => r.status === "pending")).toHaveLength(1);
  });

  it("(b'') cross-company start is 409 and does NOT kill the other company's child", async () => {
    const f1 = fakeRun(777, 777);
    const { svc, terminate, store } = makeService({ runLogin: () => f1.run });
    const p1 = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f1.resolveUrl("https://chatgpt.com/device?code=A");
    await p1;
    await expect(
      svc.startChallenge({ companyId: "c2", provider: "openai", startedByUserId: "u2" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(terminate).not.toHaveBeenCalled();
    // The conflicting claim aborted — c1's pending row is untouched, no c2 row.
    const pending = [...store.rows.values()].filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.companyId).toBe("c1");
  });

  // ── Single-flight TAKEOVER identity check (Codex P1 round-6 follow-on) ──
  // The takeover kill in `onExisting` now routes through the SAME start-time
  // identity check the reaper uses. Rationale: the boot reaper (`reapOrphans`)
  // is fired UN-awaited at startup (index.ts), so a same-(provider,authHome)
  // start served early in boot can take over a DURABLE row persisted by a PRIOR
  // process whose pid was since reused — an unconditional kill there would hit an
  // arbitrary victim (the exact harm the reaper fix avoids). These wire
  // `terminate` to the real `terminateByPidIfMatches` with injected start-time +
  // kill seams (no real processes).
  function takeoverWiredService(opts: {
    queryStartTime: (pid: number) => Date | null;
    kill: (target: number, signal: NodeJS.Signals | number) => void;
  }) {
    const store = memStore();
    const fresh = fakeRun(9999, 9999); // the NEW child the takeover spawns
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => fresh.run,
      credentialPresent: async () => true,
      terminate: (pid, pgid, expected) => {
        // The takeover always passes `expected` (like the reaper); only `cancel`
        // omits it, and these tests never cancel.
        if (expected) {
          terminateByPidIfMatches(pid, pgid, expected, {
            platform: "linux",
            kill: opts.kill,
            queryStartTime: opts.queryStartTime,
          });
        }
      },
      newId: () => "ch-fresh",
      env: () => ({}) as never,
    });
    return { svc, store, fresh };
  }

  function seedDurableRow(store: ReturnType<typeof memStore>, startedAt: Date, pid = 4242) {
    store.rows.set("durable", {
      id: "durable",
      companyId: "c1",
      provider: "openai",
      authHome: "/home/.codex",
      loginUrl: null,
      pid,
      pgid: pid,
      status: "pending",
      startedByUserId: "u1",
      startedAt,
    });
  }

  it("(b3) takeover of a DURABLE row whose pid was REUSED does NOT kill, but still reclaims the slot", async () => {
    const startedAt = new Date("2026-07-17T10:00:00.000Z");
    const kill = vi.fn();
    const { svc, store, fresh } = takeoverWiredService({
      // Same pid, but it now maps to a process started 60s later → reused after a
      // crash + restart. The un-awaited boot reap means the takeover path can hit
      // this exact case, so it must skip the kill just like the reaper does.
      queryStartTime: () => new Date(startedAt.getTime() + 60_000),
      kill,
    });
    seedDurableRow(store, startedAt);
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    fresh.resolveUrl("https://chatgpt.com/device?code=NEW");
    await startP;
    expect(kill).not.toHaveBeenCalled(); // reused pid spared on the takeover path too
    // The slot is still taken over regardless of the skipped kill: the durable
    // row is removed and replaced by the fresh challenge.
    expect(store.rows.has("durable")).toBe(false);
    const pending = [...store.rows.values()].filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe("ch-fresh");
  });

  it("(b4) takeover of a GENUINE child (start time within tolerance) STILL kills — legitimate same-company takeover frees :1455", async () => {
    const startedAt = new Date("2026-07-17T10:00:00.000Z");
    const kill = vi.fn();
    const { svc, store, fresh } = takeoverWiredService({
      // The existing child's pid maps to a process started just after the recorded
      // startedAt (within tolerance) → genuinely ours (this-session child or a
      // real orphan) → kill it so the codex :1455 callback port is freed.
      queryStartTime: () => new Date(startedAt.getTime() + 200),
      kill,
    });
    seedDurableRow(store, startedAt); // pid 4242, pgid 4242
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    fresh.resolveUrl("https://chatgpt.com/device?code=NEW");
    await startP;
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL"); // group kill → :1455 freed
    expect(store.rows.has("durable")).toBe(false); // slot reclaimed by the fresh login
  });

  it("(c) getStatus → completed on exit code 0 with the credential file present", async () => {
    const f = fakeRun();
    const { svc } = makeService({ runLogin: () => f.run, credentialPresent: async () => true });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=A");
    const { challengeId, completion } = await startP;
    f.resolveExit(0);
    await completion;
    expect((await svc.getStatus("c1", challengeId))?.status).toBe("completed");
  });

  it("(c') getStatus → failed on exit code 0 but no credential file", async () => {
    const f = fakeRun();
    const { svc } = makeService({ runLogin: () => f.run, credentialPresent: async () => false });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=A");
    const { challengeId, completion } = await startP;
    f.resolveExit(0);
    await completion;
    expect((await svc.getStatus("c1", challengeId))?.status).toBe("failed");
  });

  it("(c'') startChallenge rejects + marks failed + TERMINATES the child when the URL never appears", async () => {
    const f = fakeRun(999, 999);
    const { svc, store } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.rejectUrl(new Error("no-url"));
    await expect(startP).rejects.toThrow(/no-url/);
    // the pending row was finalized failed (not left dangling pending → no false lock)
    const rows = [...store.rows.values()];
    expect(rows.every((r) => r.status !== "pending")).toBe(true);
    expect(rows.some((r) => r.status === "failed")).toBe(true);
    // Codex P1 #2 — the child survives URL-discovery failure (holding the
    // credential home + codex :1455 port) unless we kill it here: the boot
    // reaper only sweeps `pending` rows, and this row is now `failed`.
    expect(f.handle.terminate).toHaveBeenCalledTimes(1);
  });

  it("(c''') URL discovery timeout finalizes as `timeout` (UI treats it like failed) + terminates", async () => {
    const f = fakeRun();
    const { svc, store } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.rejectUrl(new Error("login-url-timeout")); // streaming-login's documented discovery-window rejection
    await expect(startP).rejects.toThrow(/login-url-timeout/);
    const rows = [...store.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("timeout");
    expect(f.handle.terminate).toHaveBeenCalledTimes(1);
  });

  it("(c3) URL without a Codex device code rejects promptly, terminates, and releases the slot", async () => {
    const f = fakeRun();
    let rejectCode!: (error: Error) => void;
    const userCodePromise = new Promise<string>((_resolve, reject) => {
      rejectCode = reject;
    });
    f.run.userCodePromise = userCodePromise;
    const { svc, store } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({
      companyId: "c1",
      provider: "openai",
      startedByUserId: "u1",
    });
    f.resolveUrl("https://chatgpt.com/device");
    rejectCode(new Error("device-code-timeout"));
    await expect(startP).rejects.toThrow("device-code-timeout");
    expect(f.handle.terminate).toHaveBeenCalledTimes(1);
    expect([...store.rows.values()]).toHaveLength(1);
    expect([...store.rows.values()][0]?.status).toBe("timeout");
  });

  it("(c'''') a rejecting exitPromise after URL failure is swallowed (no unhandled rejection)", async () => {
    const f = fakeRun();
    let exitHandled = false;
    const originalCatch = f.run.exitPromise.catch.bind(f.run.exitPromise);
    (f.run.exitPromise as { catch: unknown }).catch = (fn: (e: unknown) => unknown) => {
      exitHandled = true;
      return originalCatch(fn);
    };
    const { svc } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.rejectUrl(new Error("no-url"));
    await expect(startP).rejects.toThrow(/no-url/);
    expect(exitHandled).toBe(true); // service attached a no-op catch before throwing
    f.rejectExit(new Error("exit-after-kill"));
    await new Promise((r) => setImmediate(r)); // flush — would surface as unhandledRejection otherwise
  });

  // ── Completion DEADLINE after URL discovery (Codex round-7 P2) ──
  // Once the URL is surfaced the child normally finalizes from its own exit. But
  // if the user never completes the browser flow (or closes the tab before the
  // fire-and-forget cancel lands), the CLI can wait INDEFINITELY — the row would
  // sit `pending` forever while the child keeps the codex :1455 callback port and
  // the global (provider, authHome) slot, 409-ing every other company. A
  // server-side deadline races the exit and, on elapse, kills the LIVE child and
  // finalizes the row `timeout`. The injected `setDeadlineTimer` seam makes this
  // deterministic (no real timers, no open handle).

  it("(h) DEADLINE elapses with no exit → LIVE child terminated + row finalized `timeout`", async () => {
    let fire: (() => void) | null = null;
    const f = fakeRun(321, 321);
    const { svc, store } = makeService({
      runLogin: () => f.run,
      setDeadlineTimer: (fn) => {
        fire = fn;
        return () => {};
      },
    });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=A");
    const { challengeId, completion } = await startP;
    // The child neither exits nor is cancelled → the deadline fires.
    expect(fire).toBeTypeOf("function");
    fire!();
    await completion;
    // Kills via the LIVE in-memory handle (this process's own child → unconditional
    // is correct), NOT the persisted-pid `deps.terminate`. The live-handle kill +
    // `timeout` status are the deadline signature (see (h') for the
    // timer-cleared-on-normal-exit assertion).
    expect(f.handle.terminate).toHaveBeenCalledTimes(1);
    expect(store.rows.get(challengeId)?.status).toBe("timeout");
  });

  it("(h') normal exit BEFORE the deadline → completed + timer cleared, and a LATE deadline fire cannot overwrite", async () => {
    let fire: (() => void) | null = null;
    let cancelled = false;
    const f = fakeRun(322, 322);
    const { svc, store } = makeService({
      runLogin: () => f.run,
      credentialPresent: async () => true,
      setDeadlineTimer: (fn) => {
        fire = fn;
        return () => {
          cancelled = true;
        };
      },
    });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=A");
    const { challengeId, completion } = await startP;
    f.resolveExit(0);
    await completion;
    expect(store.rows.get(challengeId)?.status).toBe("completed");
    expect(cancelled).toBe(true); // deadline timer cleared on normal completion (no leak)
    expect(f.handle.terminate).not.toHaveBeenCalled(); // no deadline kill on the live child
    // First-wins: a late deadline fire is ignored — must NOT overwrite `completed`.
    fire?.();
    await new Promise((r) => setImmediate(r));
    expect(store.rows.get(challengeId)?.status).toBe("completed");
  });

  it("(h'') normal exit code≠0 BEFORE the deadline → failed + timer cleared (deadline never fires)", async () => {
    let fire: (() => void) | null = null;
    let cancelled = false;
    const f = fakeRun(323, 323);
    const { svc, store } = makeService({
      runLogin: () => f.run,
      credentialPresent: async () => false,
      setDeadlineTimer: (fn) => {
        fire = fn;
        return () => {
          cancelled = true;
        };
      },
    });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=A");
    const { challengeId, completion } = await startP;
    f.resolveExit(1);
    await completion;
    expect(store.rows.get(challengeId)?.status).toBe("failed");
    expect(cancelled).toBe(true);
    expect(f.handle.terminate).not.toHaveBeenCalled();
  });

  // ── cancel identity-verification (Codex round-7 P1) ──
  // The UI fires cancel-on-unmount (VerifyStep) with a challengeId the BROWSER
  // retains across a server restart / after the CLI already exited, so the row's
  // persisted pid can belong to an UNRELATED, reused-pid process by cancel time.
  // `cancel` therefore mirrors reapOrphans/onExisting: it signals a kill ONLY for
  // a still-`pending` row AND routes it through the SAME start-time identity check
  // (no more unconditional 2-arg kill). It always removes the row (releases slot).
  function cancelWiredService(opts: {
    queryStartTime: (pid: number) => Date | null;
    kill: (target: number, signal: NodeJS.Signals | number) => void;
  }) {
    const store = memStore();
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => fakeRun().run,
      credentialPresent: async () => true,
      terminate: (pid, pgid, expected) =>
        void terminateByPidIfMatches(pid, pgid, expected, {
          platform: "linux",
          kill: opts.kill,
          queryStartTime: opts.queryStartTime,
        }),
      newId: () => "ch-x",
      env: () => ({}) as never,
      setDeadlineTimer: () => () => {},
    });
    return { svc, store };
  }

  function seedCancelRow(
    store: ReturnType<typeof memStore>,
    id: string,
    startedAt: Date,
    status: ChallengeRow["status"],
    pid: number | null = 333,
  ) {
    store.rows.set(id, {
      id,
      companyId: "c1",
      provider: "openai",
      authHome: "/home/.codex",
      loginUrl: "https://chatgpt.com/device?code=A",
      pid,
      pgid: pid,
      status,
      startedByUserId: "u1",
      startedAt,
    });
  }

  it("(d) cancel of a PENDING row with a GENUINE live child kills it (identity-verified) + removes the row", async () => {
    const startedAt = new Date("2026-07-17T10:00:00.000Z");
    const kill = vi.fn();
    const { svc, store } = cancelWiredService({
      // Same-session child: start time within tolerance → genuinely ours → kill.
      queryStartTime: () => new Date(startedAt.getTime() + 200),
      kill,
    });
    seedCancelRow(store, "live", startedAt, "pending", 333);
    await svc.cancel("c1", "live");
    expect(kill).toHaveBeenCalledWith(-333, "SIGKILL"); // legitimate live cancel still kills
    expect(store.rows.has("live")).toBe(false); // slot released
  });

  it("(d2) cancel of a PENDING row whose pid was REUSED does NOT kill but still removes the row", async () => {
    const startedAt = new Date("2026-07-17T10:00:00.000Z");
    const kill = vi.fn();
    const { svc, store } = cancelWiredService({
      // Post-restart the pid maps to a process started 60s later → reused → skip.
      queryStartTime: () => new Date(startedAt.getTime() + 60_000),
      kill,
    });
    seedCancelRow(store, "stale", startedAt, "pending", 333);
    await svc.cancel("c1", "stale");
    expect(kill).not.toHaveBeenCalled(); // the exact PID-reuse harm avoided
    expect(store.rows.has("stale")).toBe(false); // slot still released
  });

  it("(d3) cancel of a TERMINAL row (completed/failed) does NOT terminate at all but still removes the row", async () => {
    const { svc, store, terminate } = makeService();
    // A completed row's pid is no longer ours — the CLI exited; the OS may have
    // reused the pid. cancel must not signal ANY kill (not even the verified one).
    seedCancelRow(store, "done", new Date(0), "completed", 4242);
    await svc.cancel("c1", "done");
    expect(terminate).not.toHaveBeenCalled();
    expect(store.rows.has("done")).toBe(false);

    seedCancelRow(store, "bad", new Date(0), "failed", 4243);
    await svc.cancel("c1", "bad");
    expect(terminate).not.toHaveBeenCalled();
    expect(store.rows.has("bad")).toBe(false);
  });

  it("(d-gen) NO persisted-pid kill stays unconditional: cancel + reaper + takeover ALL pass identity `startedAt`", async () => {
    // Generalization guard: after the round-7 fix, every terminate of a PERSISTED
    // pid (takeover in onExisting, cancel, reaper) forwards `{ startedAt }`. Only
    // the LIVE in-memory `run.handle.terminate()` (this process's own child) may
    // stay bare — and it never routes through `deps.terminate`.
    const terminate = vi.fn();
    const store = memStore();
    const f1 = fakeRun(511, 511);
    const f2 = fakeRun(512, 512);
    let call = 0;
    let seq = 0;
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => (call++ === 0 ? f1.run : f2.run),
      credentialPresent: async () => true,
      terminate,
      newId: () => `ch-${++seq}`,
      env: () => ({}) as never,
      setDeadlineTimer: () => () => {},
    });
    // 1) takeover (onExisting): same-company restart kills the prior child.
    const p1 = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f1.resolveUrl("https://chatgpt.com/device?code=A");
    await p1;
    const p2 = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f2.resolveUrl("https://chatgpt.com/device?code=B");
    const second = await p2;
    // 2) cancel of the (pending) survivor.
    await svc.cancel("c1", second.challengeId);
    // 3) reaper of a durable pending orphan from another company.
    store.rows.set("orphan", {
      id: "orphan",
      companyId: "c9",
      provider: "openai",
      authHome: "/home/.codex",
      loginUrl: null,
      pid: 909,
      pgid: 909,
      status: "pending",
      startedByUserId: "u9",
      startedAt: new Date("2026-07-17T09:00:00.000Z"),
    });
    await svc.reapOrphans();
    // Three persisted-pid kills fired; EVERY one carried an identity object — none
    // was the old unconditional 2-arg form.
    expect(terminate.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const args of terminate.mock.calls) {
      expect(args[2]).toEqual({ startedAt: expect.any(Date) });
    }
  });

  it("(d') CROSS-TENANT cancel is a silent no-op — child NOT terminated, row kept (Codex P1 #1)", async () => {
    const f = fakeRun(333, 333);
    const { svc, store, terminate } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=A");
    const { challengeId } = await startP;
    // Founder of company c2 guesses/leaks c1's challenge id.
    await expect(svc.cancel("c2", challengeId)).resolves.toBeUndefined();
    expect(terminate).not.toHaveBeenCalled();
    expect(store.rows.get(challengeId)?.status).toBe("pending"); // login still running
  });

  it("(d'') CROSS-TENANT getStatus is NOT FOUND — never leaks status or the OAuth loginUrl (Codex P1 #1)", async () => {
    const f = fakeRun();
    const { svc } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=SECRET");
    const { challengeId } = await startP;
    expect(await svc.getStatus("c2", challengeId)).toBeNull(); // indistinguishable from absent
    expect((await svc.getStatus("c1", challengeId))?.loginUrl).toBe(
      "https://chatgpt.com/device?code=SECRET",
    );
  });

  it("records subscription credential evidence for the owner and target before probing", async () => {
    const f = fakeRun();
    const onCredentialEvidence = vi.fn(async () => {});
    const { svc } = makeService({
      runLogin: () => f.run,
      credentialPresent: async () => true,
      onCredentialEvidence,
    });
    const pending = svc.startChallenge({
      companyId: "c1",
      provider: "openai",
      startedByUserId: "u1",
      executionTargetId: "target-1",
    });
    f.resolveUrl("https://chatgpt.com/device");
    const { completion } = await pending;
    f.resolveExit(0);
    await completion;
    expect(onCredentialEvidence).toHaveBeenCalledWith({
      companyId: "c1",
      provider: "openai",
      userId: "u1",
      executionTargetId: "target-1",
    });
  });

  it("scopes status, cancel, and pasted-code delivery to the owning user", async () => {
    const f = fakeRun();
    const { svc, store } = makeService({ runLogin: () => f.run });
    const pending = svc.startChallenge({
      companyId: "c1",
      provider: "anthropic",
      startedByUserId: "u1",
    });
    f.resolveUrl("https://claude.ai/oauth");
    const { challengeId } = await pending;

    expect(await svc.getStatus("c1", challengeId, null, "u2")).toBeNull();
    expect(svc.submitCode("c1", challengeId, "SECRET", "u2")).toBe("not-live");
    await svc.cancel("c1", challengeId, null, "u2");
    expect(store.rows.has(challengeId)).toBe(true);

    expect((await svc.getStatus("c1", challengeId, null, "u1"))?.status).toBe("pending");
    expect(svc.submitCode("c1", challengeId, "SECRET", "u1")).toBe("delivered");
  });

  it("(e) reapOrphans terminates each persisted pending child WITH its recorded identity and clears the rows", async () => {
    const f = fakeRun(444, 444);
    const { svc, store, terminate } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=A");
    await startP;
    // Capture the durable row's startedAt before the reaper removes it — the
    // reaper must forward it so the terminate impl can reject a reused pid.
    const pendingRow = [...store.rows.values()].find((r) => r.status === "pending")!;
    await svc.reapOrphans();
    // Codex P1 round 6: the risky boot path forwards { startedAt } (unlike live
    // cancel, which passes only pid/pgid).
    expect(terminate).toHaveBeenCalledWith(444, 444, { startedAt: pendingRow.startedAt });
    expect([...store.rows.values()].filter((r) => r.status === "pending")).toHaveLength(0);
  });

  // End-to-end reaper behavior wired to the REAL identity-verifying terminate,
  // with an injected start-time query + kill seam (no real processes). Proves the
  // PID-reuse guard end to end: decision (kill vs skip) AND row removal.
  function reaperWiredService(opts: {
    queryStartTime: (pid: number) => Date | null;
    kill: (target: number, signal: NodeJS.Signals | number) => void;
  }) {
    const store = memStore();
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => fakeRun().run,
      credentialPresent: async () => true,
      terminate: (pid, pgid, expected) => {
        // Live cancel (no `expected`) would kill directly; the reaper always
        // passes `expected`, so this test only exercises the verified path.
        if (expected) {
          terminateByPidIfMatches(pid, pgid, expected, {
            platform: "linux",
            kill: opts.kill,
            queryStartTime: opts.queryStartTime,
          });
        }
      },
      newId: () => "ch-x",
      env: () => ({}) as never,
    });
    return { svc, store };
  }

  function seedPendingRow(store: ReturnType<typeof memStore>, startedAt: Date) {
    store.rows.set("orphan", {
      id: "orphan",
      companyId: "c1",
      provider: "openai",
      authHome: "/home/.codex",
      loginUrl: null,
      pid: 4242,
      pgid: 4242,
      status: "pending",
      startedByUserId: "u1",
      startedAt,
    });
  }

  it("(e2) reaper does NOT kill a REUSED pid (queried start time is later than startedAt) but still removes the row", async () => {
    const startedAt = new Date("2026-07-17T10:00:00.000Z");
    const kill = vi.fn();
    const { svc, store } = reaperWiredService({
      // The pid now maps to a process that started 60s later → reused after a
      // crash + restart. Killing it would hit an unrelated victim.
      queryStartTime: () => new Date(startedAt.getTime() + 60_000),
      kill,
    });
    seedPendingRow(store, startedAt);
    await svc.reapOrphans();
    expect(kill).not.toHaveBeenCalled(); // the exact harm avoided
    expect(store.rows.has("orphan")).toBe(false); // slot still released
  });

  it("(e3) reaper KILLS the genuine orphan (queried start time matches startedAt) and removes the row", async () => {
    const startedAt = new Date("2026-07-17T10:00:00.000Z");
    const kill = vi.fn();
    const { svc, store } = reaperWiredService({
      queryStartTime: () => new Date(startedAt.getTime() + 200), // our child, spawned just after
      kill,
    });
    seedPendingRow(store, startedAt);
    await svc.reapOrphans();
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL"); // group kill of the real orphan
    expect(store.rows.has("orphan")).toBe(false);
  });

  it("(e4) reaper does NOT kill when identity is unestablished (query returns null) but still removes the row", async () => {
    const startedAt = new Date("2026-07-17T10:00:00.000Z");
    const kill = vi.fn();
    const { svc, store } = reaperWiredService({
      queryStartTime: () => null, // process gone / access denied / unparseable
      kill,
    });
    seedPendingRow(store, startedAt);
    await svc.reapOrphans();
    expect(kill).not.toHaveBeenCalled(); // conservative: never kill an unverifiable pid
    expect(store.rows.has("orphan")).toBe(false);
  });

  it("(f) pid-backfill rejection TERMINATES the surviving child, marks the row failed, and rethrows (Codex P1 follow-on)", async () => {
    // The atomic claim inserts a durable pending row with pid: null, then the
    // child spawns, then the pid/pgid backfill runs. If that backfill rejects
    // (transient DB disconnect) the child is ALREADY alive — holding the shared
    // credential home + codex :1455 callback port — but the row stays `pending`
    // with pid: null, which the boot reaper can't kill BY pid. So the service
    // must terminate the child here-and-now.
    const f = fakeRun(1234, 1234);
    const store = memStore();
    const baseUpdate = store.update.bind(store);
    store.update = async (id, patch) => {
      if ("pid" in patch) throw new Error("db-disconnect");
      return baseUpdate(id, patch);
    };
    let exitHandled = false;
    const originalCatch = f.run.exitPromise.catch.bind(f.run.exitPromise);
    (f.run.exitPromise as { catch: unknown }).catch = (fn: (e: unknown) => unknown) => {
      exitHandled = true;
      return originalCatch(fn);
    };
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => f.run,
      credentialPresent: async () => true,
      terminate: vi.fn(),
      newId: () => "ch-1",
      env: () => ({}) as never,
    });
    await expect(
      svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" }),
    ).rejects.toThrow(/db-disconnect/); // the ORIGINAL backfill error propagates
    expect(f.handle.terminate).toHaveBeenCalledTimes(1); // child killed → :1455 freed
    // The row is finalized `failed` — the single-flight slot is released, not
    // left dangling as a null-pid `pending` row that nothing can clear or kill.
    const rows = [...store.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("failed");
    expect(exitHandled).toBe(true); // exitPromise neutralized before throwing
    f.rejectExit(new Error("exit-after-kill"));
    await new Promise((r) => setImmediate(r)); // would surface as unhandledRejection otherwise
  });

  it("(f') pid-backfill rejection still terminates the child even when the failed-status write ALSO rejects", async () => {
    // Worst case: the DB is fully unreachable, so both the pid backfill AND the
    // compensating `failed` status write reject. Cleanup is best-effort — the
    // terminate (the load-bearing bit that frees the port) must still fire, and
    // the ORIGINAL error must propagate (the status-write rejection is swallowed).
    const f = fakeRun(1234, 1234);
    const store = memStore();
    const baseUpdate = store.update.bind(store);
    store.update = async (id, patch) => {
      if ("pid" in patch) throw new Error("backfill-failed");
      if (patch.status === "failed") throw new Error("status-write-failed");
      return baseUpdate(id, patch);
    };
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => f.run,
      credentialPresent: async () => true,
      terminate: vi.fn(),
      newId: () => "ch-1",
      env: () => ({}) as never,
    });
    await expect(
      svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" }),
    ).rejects.toThrow(/backfill-failed/); // original error, NOT the swallowed status-write one
    expect(f.handle.terminate).toHaveBeenCalledTimes(1); // best-effort cleanup still killed the child
  });

  it("(g) reapOrphans REMOVES a null-pid pending row (releases the lock) without trying to terminate", async () => {
    // A crash in the pre-backfill window (or a backfill-failure whose status
    // write also failed) leaves a durable `pending` row with pid: null. The
    // reaper can't kill a process it can't identify, but it MUST still clear the
    // row to free the single-flight slot (otherwise every future login 409s).
    const store = memStore();
    const terminate = vi.fn();
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => fakeRun().run,
      credentialPresent: async () => true,
      terminate,
      newId: () => "ch-x",
      env: () => ({}) as never,
    });
    store.rows.set("orphan", {
      id: "orphan",
      companyId: "c1",
      provider: "openai",
      authHome: "/home/.codex",
      loginUrl: null,
      pid: null,
      pgid: null,
      status: "pending",
      startedByUserId: "u1",
      startedAt: new Date(0),
    });
    await svc.reapOrphans();
    expect(terminate).not.toHaveBeenCalled(); // nothing to kill — pid is null
    expect(store.rows.has("orphan")).toBe(false); // but the slot is released
  });

  it("(g') reapOrphans handles a MIXED batch: terminates the pid row, skip-terminates but still removes the null-pid row", async () => {
    const store = memStore();
    const terminate = vi.fn();
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => fakeRun().run,
      credentialPresent: async () => true,
      terminate,
      newId: () => "ch-x",
      env: () => ({}) as never,
    });
    store.rows.set("with-pid", {
      id: "with-pid",
      companyId: "c1",
      provider: "openai",
      authHome: "/home/.codex",
      loginUrl: null,
      pid: 4321,
      pgid: 4321,
      status: "pending",
      startedByUserId: "u1",
      startedAt: new Date(0),
    });
    store.rows.set("null-pid", {
      id: "null-pid",
      companyId: "c2",
      provider: "anthropic",
      authHome: "/home/.claude",
      loginUrl: null,
      pid: null,
      pgid: null,
      status: "pending",
      startedByUserId: "u2",
      startedAt: new Date(0),
    });
    await svc.reapOrphans();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith(4321, 4321, { startedAt: new Date(0) });
    expect([...store.rows.values()].filter((r) => r.status === "pending")).toHaveLength(0);
  });

  // ── Codex round-8 concurrency hardening ──────────────────────────────────

  it("(P1) 0-row-backfill BACKSTOP: A's in-flight row is concurrently REMOVED (cancel/reaper) → A's backfill sees 0 rows → A self-terminates + aborts (defense-in-depth behind F1)", async () => {
    // The round-8 0-row-backfill self-terminate (Codex round-8 P1 :222), retained as
    // DEFENSE-IN-DEPTH behind the F1 refusal (round-8 review). F1 now stops a
    // concurrent SAME-company start from ever DELETING an in-flight (pid-null) row
    // (its `onExisting` refuses the takeover → 409; see (F1)), so the ONLY residual
    // way A's pending row disappears before its pid backfill lands is a concurrent
    // REMOVAL — a founder `cancel` or the boot `reapOrphans` racing the spawn window
    // (both remove a pid-null pending row). When that happens A's backfill affects
    // ZERO rows WITHOUT throwing: A is the LOSER and its just-spawned child would be
    // an orphan holding the codex :1455 port + credential home. The backstop detects
    // the 0-row result → terminate OUR OWN live child and abort (409). No orphan.
    const store = memStore();
    const fA = fakeRun(100, 100);
    let seq = 0;
    const terminate = vi.fn();

    // Hold A's pid backfill open until we've removed its row concurrently.
    let releaseABackfill!: () => void;
    const aBackfillGate = new Promise<void>((r) => {
      releaseABackfill = r;
    });
    const baseUpdate = store.update.bind(store);
    let gatedOnce = false;
    store.update = async (id, patch) => {
      if (id === "ch-1" && "pid" in patch && !gatedOnce) {
        gatedOnce = true;
        await aBackfillGate;
      }
      return baseUpdate(id, patch);
    };

    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => fA.run,
      credentialPresent: async () => true,
      terminate,
      newId: () => `ch-${++seq}`,
      env: () => ({}) as never,
      setDeadlineTimer: () => () => {},
    });

    // Start A → claim inserts ch-1 (pid null), spawns child A, suspends at the gated backfill.
    const pA = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    await new Promise((r) => setImmediate(r)); // let A reach the gate

    // A concurrent removal — a founder `cancel` or the boot `reapOrphans` clearing the
    // pid-null pending row — deletes ch-1 while A is mid-spawn (the residual path F1
    // leaves for this backstop; a same-company start can no longer do this).
    expect(store.rows.has("ch-1")).toBe(true);
    await store.remove("ch-1");

    // Release A's backfill → update(ch-1) now affects 0 rows (row concurrently removed).
    releaseABackfill();
    await expect(pA).rejects.toBeInstanceOf(LoginChallengeConflictError);

    // A self-terminated its OWN live child (in-memory handle → unconditional kill),
    // never routed through the persisted-pid seam, and left no stranded row.
    expect(fA.handle.terminate).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();
    const pending = [...store.rows.values()].filter((r) => r.status === "pending");
    expect(pending).toHaveLength(0);
  });

  it("(F1) B REFUSES to take over A's IN-FLIGHT pid-null row → 409, no delete, no second child; A's backfill wins → ONE child", async () => {
    // The residual two-children window round-8 left open (round-8 review F1). Round-8
    // closed ONLY the ordering where B's DELETE beats A's pid backfill (A sees 0 rows
    // → self-terminates). The OTHER ordering still orphaned a child: A claims (row A,
    // pid null) + spawns child A; B claims (the advisory lock is FREE — A releases it
    // at claim-commit, before spawn+backfill), its SELECT reads row A while pid is
    // STILL null → `onExisting` can't identity-verify-kill (guarded on pid != null) →
    // pre-fix it DELETES row A, inserts row B, spawns child B; then A's pid backfill
    // WINS the row-lock race against B's delete → A matches 1 row → A does NOT
    // self-terminate → child A lives on as an orphan dueling child B for the codex
    // :1455 port + shared credential home. The fix makes `onExisting` REFUSE the
    // takeover of a pid-null (mid-spawn) row: throw a conflict so B backs off (409)
    // instead of deleting A's in-flight row. Then A's backfill always succeeds → one
    // child. (The round-8 0-row self-terminate stays as defense-in-depth.)
    const store = memStore();
    const fA = fakeRun(100, 100);
    const fB = fakeRun(200, 200);
    let call = 0;
    let seq = 0;
    const terminate = vi.fn();
    const runLogin = vi.fn(() => (call++ === 0 ? fA.run : fB.run));

    // Hold A's pid backfill open so B runs its claim while A's row is still pid-null.
    let releaseABackfill!: () => void;
    const aBackfillGate = new Promise<void>((r) => {
      releaseABackfill = r;
    });
    const baseUpdate = store.update.bind(store);
    let gatedOnce = false;
    store.update = async (id, patch) => {
      if (id === "ch-1" && "pid" in patch && !gatedOnce) {
        gatedOnce = true;
        await aBackfillGate;
      }
      return baseUpdate(id, patch);
    };

    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin,
      credentialPresent: async () => true,
      terminate,
      newId: () => `ch-${++seq}`,
      env: () => ({}) as never,
      setDeadlineTimer: () => () => {},
    });

    // Start A → claim inserts ch-1 (pid null), spawns child A, suspends at the gated backfill.
    const pA = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    await new Promise((r) => setImmediate(r)); // let A commit its claim + spawn + reach the gate

    // Start B (same company) while A's row is still IN-FLIGHT (pid null).
    const pB = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    // Resolve fB's URL up front so a pre-fix run (B DOES spawn) completes fast instead
    // of hanging on URL discovery — keeps the RED clean rather than a timeout. Post-fix
    // B never spawns, so this resolution is an ignored no-op.
    fB.resolveUrl("https://chatgpt.com/device?code=B");
    await expect(pB).rejects.toBeInstanceOf(LoginChallengeConflictError); // refused → 409

    // B did NOT take over: it never deleted A's in-flight row and never spawned a child.
    expect(runLogin).toHaveBeenCalledTimes(1); // only A spawned a login child
    expect(fB.handle.terminate).not.toHaveBeenCalled();
    expect(store.rows.has("ch-1")).toBe(true); // A's row untouched by B

    // Release A's backfill → it affects 1 row (still present) → A is NOT superseded.
    releaseABackfill();
    fA.resolveUrl("https://chatgpt.com/device?code=A");
    const aResult = await pA;
    expect(aResult.challengeId).toBe("ch-1");

    // Exactly one surviving child (A's) + one pending row (A's); A never self-terminated,
    // and no persisted-pid kill fired.
    expect(fA.handle.terminate).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    const survivors = [...store.rows.values()].filter((r) => r.status === "pending");
    expect(survivors).toHaveLength(1);
    expect(survivors[0]!.id).toBe("ch-1");
  });

  it("(F1b) a SET-pid existing row is STILL taken over (hung-login takeover preserved; only pid-null is refused)", async () => {
    // The F1 refusal is scoped to pid-NULL (mid-spawn) rows ONLY. A row whose pid is
    // set (backfill completed) is a REAL prior child, possibly hung — the round-2
    // "a re-attempt cancels the prior child and starts one clean login" semantics must
    // still hold: identity-verified-kill the prior child and replace the row.
    const store = memStore();
    const fresh = fakeRun(9999, 9999);
    const terminate = vi.fn();
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => fresh.run,
      credentialPresent: async () => true,
      terminate,
      newId: () => "ch-fresh",
      env: () => ({}) as never,
      setDeadlineTimer: () => () => {},
    });
    const startedAt = new Date("2026-07-17T10:00:00.000Z");
    store.rows.set("hung", {
      id: "hung",
      companyId: "c1",
      provider: "openai",
      authHome: "/home/.codex",
      loginUrl: "https://chatgpt.com/device?code=OLD",
      pid: 4242, // backfill COMPLETED — a real prior child
      pgid: 4242,
      status: "pending",
      startedByUserId: "u1",
      startedAt,
    });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    fresh.resolveUrl("https://chatgpt.com/device?code=NEW");
    const res = await startP;
    // Prior (pid-set, possibly hung) child killed via the identity-verified seam...
    expect(terminate).toHaveBeenCalledWith(4242, 4242, { startedAt });
    // ...and its row replaced by the fresh challenge (round-2 takeover semantics intact).
    expect(store.rows.has("hung")).toBe(false);
    expect(res.challengeId).toBe("ch-fresh");
    const pending = [...store.rows.values()].filter((r) => r.status === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe("ch-fresh");
  });

  it("(P2-202) backfills the ACTUAL spawn time as startedAt so a slow claim can't make the genuine child un-killable", async () => {
    // startedAt is set at claim time; if the advisory-lock wait + spawn exceed the
    // 2s identity tolerance, the child's real OS start time drifts past
    // startedAt + tolerance and the verifier misclassifies the GENUINE child as a
    // reused pid (permanent un-killable orphan). The fix backfills the real spawn
    // instant. Deterministic via an injected clock: claim at T0, spawn 5s later.
    const store = memStore();
    const f = fakeRun(444, 444);
    const T0 = new Date("2026-07-17T10:00:00.000Z");
    const spawnTime = new Date(T0.getTime() + 5_000);
    const times = [T0, spawnTime]; // now(): [0]=claim row, [1]=post-spawn backfill
    let i = 0;
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => f.run,
      credentialPresent: async () => true,
      terminate: vi.fn(),
      newId: () => "ch-1",
      env: () => ({}) as never,
      now: () => times[Math.min(i++, times.length - 1)]!,
      setDeadlineTimer: () => () => {},
    });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=A");
    const { challengeId } = await startP;

    const row = store.rows.get(challengeId)!;
    // Persisted startedAt is the REAL spawn time (T0 + 5s), NOT the pre-claim T0.
    expect(row.startedAt.getTime()).toBe(spawnTime.getTime());

    // Consequence: terminateByPidIfMatches with the recorded startedAt now KILLS the
    // genuine child (real start time within tolerance) instead of sparing it as reused.
    const kill = vi.fn();
    const killed = terminateByPidIfMatches(
      row.pid!,
      row.pgid,
      { startedAt: row.startedAt },
      { platform: "linux", kill, queryStartTime: () => spawnTime },
    );
    expect(killed).toBe(true);
    expect(kill).toHaveBeenCalledWith(-444, "SIGKILL");
  });

  it("(P2-342) DEADLINE covers the credential check: exit(0) then credentialPresent HANGS → deadline fires → live child terminated + row `timeout`", async () => {
    // After exit(0) the lifecycle awaits credentialPresent, which can HANG on an
    // unresponsive auth-home FS. Previously exit had already won the race, so the
    // deadline could no longer fire and the row sat `pending` forever. The fix folds
    // the credential check INSIDE the raced promise so a hang still trips the deadline.
    let fire: (() => void) | null = null;
    const f = fakeRun(555, 555);
    const { svc, store } = makeService({
      runLogin: () => f.run,
      credentialPresent: () => new Promise<boolean>(() => {}), // never settles
      setDeadlineTimer: (fn) => {
        fire = fn;
        return () => {};
      },
    });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=A");
    const { challengeId, completion } = await startP;
    f.resolveExit(0); // child exits cleanly, but the credential check hangs
    await new Promise((r) => setImmediate(r)); // let the exit propagate into the hang
    expect(fire).toBeTypeOf("function");
    fire!(); // deadline elapses while credentialPresent is still hanging
    await completion;
    expect(f.handle.terminate).toHaveBeenCalledTimes(1); // live child force-terminated
    expect(store.rows.get(challengeId)?.status).toBe("timeout"); // NOT stranded pending
  });

  it("(P2-348) finalize terminal write that rejects on EVERY retry REMOVES the row (releases the slot) instead of stranding `pending`", async () => {
    // If the terminal status write transiently rejects, finalize has already set
    // `settled` + cancelled the timer; the outer catch used to swallow it, leaving
    // the row `pending` forever and blocking the global slot after the DB recovers.
    // The fix retries a bounded number of times, then best-effort REMOVES the row.
    const f = fakeRun(666, 666);
    const store = memStore();
    const baseUpdate = store.update.bind(store);
    const baseRemove = store.remove.bind(store);
    let terminalWriteAttempts = 0;
    let removed = false;
    store.update = async (id, patch) => {
      if (patch.status && patch.status !== "pending") {
        terminalWriteAttempts += 1;
        throw new Error("db-down"); // every terminal write attempt rejects
      }
      return baseUpdate(id, patch);
    };
    store.remove = async (id) => {
      removed = true;
      return baseRemove(id);
    };
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => f.run,
      credentialPresent: async () => true,
      terminate: vi.fn(),
      newId: () => "ch-1",
      env: () => ({}) as never,
      setDeadlineTimer: () => () => {},
    });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=A");
    const { challengeId, completion } = await startP;
    f.resolveExit(0); // would finalize `completed`, but the terminal write rejects on all retries
    await completion;
    expect(terminalWriteAttempts).toBe(3); // bounded retry exhausted
    expect(removed).toBe(true); // fell back to remove → slot released
    expect(store.rows.has(challengeId)).toBe(false); // no stranded `pending` row
  });

  it("(sib) never writes the bearer loginUrl to durable storage", async () => {
    const f = fakeRun(789, 789);
    const store = memStore();
    const baseUpdate = store.update.bind(store);
    let durableUrlWriteAttempted = false;
    store.update = async (id, patch) => {
      if ("loginUrl" in patch) durableUrlWriteAttempted = true;
      return baseUpdate(id, patch);
    };
    const svc = createCommanderLoginService({
      store,
      resolveAuthHome: () => "/home/.codex",
      runLogin: () => f.run,
      credentialPresent: async () => true,
      terminate: vi.fn(),
      newId: () => "ch-1",
      env: () => ({}) as never,
      setDeadlineTimer: () => () => {},
    });
    const startP = svc.startChallenge({ companyId: "c1", provider: "openai", startedByUserId: "u1" });
    f.resolveUrl("https://chatgpt.com/device?code=A");
    const { challengeId, completion } = await startP;
    expect(durableUrlWriteAttempted).toBe(false);
    expect(store.rows.get(challengeId)?.loginUrl).toBeNull();
    expect((await svc.getStatus("c1", challengeId, null, "u1"))?.loginUrl).toBe(
      "https://chatgpt.com/device?code=A",
    );
    f.resolveExit(0);
    await completion;
    expect((await svc.getStatus("c1", challengeId, null, "u1"))?.loginUrl).toBeNull();
  });

  // ── Live-challenge registry + submitCode (Plan 3 / §6.2 Task 3) ──
  // `submitCode` delivers a pasted auth code to the LIVE child's stdin. It is
  // process-local by construction: only a challenge THIS process started (and
  // hasn't yet finalized/cancelled) has a live entry to deliver to.

  it("(submitCode-1) anthropic challenge started by this process delivers a pasted code to the live child", async () => {
    const f = fakeRun(111, 111, vi.fn(() => true));
    const { svc } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({
      companyId: "c1",
      provider: "anthropic",
      startedByUserId: "u1",
    });
    f.resolveUrl("https://platform.claude.com/oauth?code=A");
    const { challengeId } = await startP;
    expect(svc.submitCode("c1", challengeId, "SECRET-CODE")).toBe("delivered");
    expect(f.submitCode).toHaveBeenCalledWith("SECRET-CODE");
  });

  it("(submitCode-2) an unknown challengeId is not-live", () => {
    const { svc } = makeService();
    expect(svc.submitCode("c1", "no-such-challenge", "CODE")).toBe("not-live");
  });

  it("(submitCode-3) an openai/codex challenge is unsupported and never reaches the child's submitCode", async () => {
    const f = fakeRun(222, 222, vi.fn(() => true));
    const { svc } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({
      companyId: "c1",
      provider: "openai",
      startedByUserId: "u1",
    });
    f.resolveUrl("https://chatgpt.com/device?code=B");
    const { challengeId } = await startP;
    expect(svc.submitCode("c1", challengeId, "CODE")).toBe("unsupported");
    expect(f.submitCode).not.toHaveBeenCalled();
  });

  it("(submitCode-4) an anthropic child that refuses the stdin write reports write-failed (not a false 'delivered', and not conflated with not-live)", async () => {
    const f = fakeRun(333, 333, vi.fn(() => false));
    const { svc } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({
      companyId: "c1",
      provider: "anthropic",
      startedByUserId: "u1",
    });
    f.resolveUrl("https://platform.claude.com/oauth?code=A");
    const { challengeId } = await startP;
    expect(svc.submitCode("c1", challengeId, "CODE")).toBe("write-failed");
    expect(f.submitCode).toHaveBeenCalledWith("CODE"); // the write WAS attempted, it just failed
  });

  it("(submitCode-5) after cancel the registry entry is cleared — a later submitCode is not-live", async () => {
    const f = fakeRun(444, 444, vi.fn(() => true));
    const { svc } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({
      companyId: "c1",
      provider: "anthropic",
      startedByUserId: "u1",
    });
    f.resolveUrl("https://platform.claude.com/oauth?code=A");
    const { challengeId } = await startP;
    expect(svc.submitCode("c1", challengeId, "BEFORE")).toBe("delivered"); // sanity: live pre-cancel
    await svc.cancel("c1", challengeId);
    expect(svc.submitCode("c1", challengeId, "AFTER")).toBe("not-live");
    expect(f.submitCode).toHaveBeenCalledTimes(1); // "AFTER" never reached the (now-dead) child
  });

  it("(submitCode-6) after normal completion (exit 0 + credential present) the registry entry is cleared", async () => {
    const f = fakeRun(555, 555, vi.fn(() => true));
    const { svc } = makeService({ runLogin: () => f.run, credentialPresent: async () => true });
    const startP = svc.startChallenge({
      companyId: "c1",
      provider: "anthropic",
      startedByUserId: "u1",
    });
    f.resolveUrl("https://platform.claude.com/oauth?code=A");
    const { challengeId, completion } = await startP;
    f.resolveExit(0);
    await completion;
    expect(svc.submitCode("c1", challengeId, "AFTER")).toBe("not-live");
  });

  // ── Cross-tenant submitCode (security fix, Task 4) ──
  // Unlike getStatus/cancel, submitCode performs a WRITE into a live child's
  // stdin — a cross-tenant call here is a confused-deputy write, not merely
  // an info leak. A company mismatch must be indistinguishable from an
  // unknown challengeId ("not-live"), and must NEVER reach the child.

  it("(submitCode-7) refuses a code for a challenge belonging to another company", async () => {
    const f = fakeRun(666, 666, vi.fn(() => true));
    const { svc } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({
      companyId: "company-A",
      provider: "anthropic",
      startedByUserId: "u1",
    });
    f.resolveUrl("https://platform.claude.com/oauth?code=A");
    const { challengeId } = await startP;
    expect(svc.submitCode("company-B", challengeId, "ABC-123")).toBe("not-live");
  });

  it("(submitCode-8) does not call the child's submitCode on a company mismatch", async () => {
    const f = fakeRun(777, 777, vi.fn(() => true));
    const { svc } = makeService({ runLogin: () => f.run });
    const startP = svc.startChallenge({
      companyId: "company-A",
      provider: "anthropic",
      startedByUserId: "u1",
    });
    f.resolveUrl("https://platform.claude.com/oauth?code=A");
    const { challengeId } = await startP;
    svc.submitCode("company-B", challengeId, "ABC-123");
    expect(f.submitCode).not.toHaveBeenCalled();
  });
});
