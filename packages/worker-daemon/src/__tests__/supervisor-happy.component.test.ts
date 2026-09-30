import { describe, expect, it } from "vitest";

import { verifyWorkerEventDigestV1 } from "@armyofagents/worker-protocol";

import { createMetrics } from "../metrics/metrics.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { createSupervisor } from "../supervisor/supervisor.js";
import { collectingSink, makeHandoff, SUPERVISOR_IDENTITY } from "./support/supervisor-fixtures.js";
import { sha256hex } from "./support/poll-fixtures.js";

describe("supervisor-happy.component — create → execute (inside) → terminal → destroy under effect authority", () => {
  it("drives the full lifecycle, runs the tenant command INSIDE the sandbox, and destroys it", async () => {
    const fake = createFakeSandboxProvider();
    const sink = collectingSink();
    const metrics = createMetrics();
    const supervisor = createSupervisor({ provider: fake, identity: SUPERVISOR_IDENTITY, eventSink: sink, metrics });

    await supervisor.accept(makeHandoff());
    expect(supervisor.activeRunCount()).toBe(0);

    expect(fake.callCount("create")).toBe(1);
    expect(fake.callCount("execute")).toBe(1);
    expect(fake.callCount("destroy")).toBe(1);

    // The tenant command ran INSIDE the sandbox (recorded against the sandboxId).
    const sandboxId = fake.calls().find((c) => c.op === "create")?.sandboxId;
    expect(sandboxId).toBeTruthy();
    expect(fake.executionsOf(sandboxId!)).toEqual([{ command: "codex", args: ["exec", "--json"], insideSandbox: true }]);
    // After a happy run the sandbox is destroyed (reclaimed under effect authority).
    expect(fake.peek(sandboxId!)?.state).toBe("destroyed");

    // The ordered op sequence: create → execute → destroy (destroy under effect).
    const ops = fake.calls().filter((c) => !c.replayed).map((c) => c.op);
    expect(ops).toEqual(["create", "execute", "destroy"]);
  });

  it("emits contiguous, digest-valid attempt_started + terminal(succeeded) events carrying sandbox identity", async () => {
    const fake = createFakeSandboxProvider();
    const sink = collectingSink();
    const supervisor = createSupervisor({ provider: fake, identity: SUPERVISOR_IDENTITY, eventSink: sink });

    await supervisor.accept(makeHandoff());

    expect(sink.events.map((e) => e.eventType)).toEqual(["attempt_started", "terminal"]);
    // Contiguous seq starting at 1.
    expect(sink.events.map((e) => e.seq)).toEqual([1, 2]);
    // attempt_started carries the sandbox identity.
    const started = sink.events[0];
    expect(started.eventType).toBe("attempt_started");
    if (started.eventType === "attempt_started") {
      expect(started.payload.sandboxId).toMatch(/^fake-sbx-/);
    }
    const terminal = sink.events[1];
    expect(terminal.eventType).toBe("terminal");
    if (terminal.eventType === "terminal") {
      expect(terminal.payload.status).toBe("succeeded");
      expect(terminal.payload.exitCode).toBe(0);
    }
    // Every event's digest verifies against the frozen canonicalizer.
    for (const event of sink.events) {
      expect(await verifyWorkerEventDigestV1(event, sha256hex)).toBe(true);
    }
  });

  it("records sandbox-op metrics for create/execute/destroy with closed-set tokens", async () => {
    const fake = createFakeSandboxProvider();
    const metrics = createMetrics();
    const supervisor = createSupervisor({ provider: fake, identity: SUPERVISOR_IDENTITY, eventSink: collectingSink(), metrics });
    await supervisor.accept(makeHandoff());
    const rendered = metrics.renderPrometheus();
    expect(rendered).toContain('sandbox_op{operation="create",outcome="success"}');
    expect(rendered).toContain('sandbox_op{operation="execute",outcome="success"}');
    expect(rendered).toContain('sandbox_op{operation="destroy",outcome="success"}');
  });
});

// -- H1: the workload's budget reaches ctx.deadlineMs --------------------------
//
// `opDeadlineMs` was a construction-time constant that production never set, so 60 s stood
// for every run. It is simultaneously (a) the supervisor's execute race, (b) the E2B SANDBOX
// TTL (`#ttl(ctx)` -> `transport.create({timeoutMs})` + an idempotent `setTimeout`), and
// (c) the E2B COMMAND timeout. So a task budgeted for 600 s was killed at 60 and terminalized
// `failed`, with the workload's own number read by nothing.
//
// These assert the value ARRIVES, on the ops that matter, and that the ops that do NOT matter
// were left alone: a long run budget is not a reason to let a teardown hang.

/** Records `ctx.deadlineMs` per operation while delegating to the real fake. */
function deadlineRecordingProvider(inner: ReturnType<typeof createFakeSandboxProvider>) {
  const seen: Array<{ op: string; deadlineMs: number }> = [];
  const recorder = new Proxy(inner as unknown as Record<string, unknown>, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]) => {
        const ctx = args.find(
          (a): a is { deadlineMs: number } =>
            typeof a === "object" && a !== null && typeof (a as { deadlineMs?: unknown }).deadlineMs === "number",
        );
        if (ctx) seen.push({ op: prop, deadlineMs: ctx.deadlineMs });
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { provider: recorder as unknown as typeof inner, seen };
}

describe("supervisor — H1: the run's workload budget becomes ctx.deadlineMs", () => {
  const deadlinesFor = async (opDeadlineMs: unknown, maxRuntimeSeconds = 3600) => {
    const { provider, seen } = deadlineRecordingProvider(createFakeSandboxProvider());
    const supervisor = createSupervisor({
      provider,
      identity: SUPERVISOR_IDENTITY,
      eventSink: collectingSink(),
      opDeadlineMs: opDeadlineMs as never,
    });
    await supervisor.accept(
      makeHandoff({
        job: {
          ...(makeHandoff().offer.job as unknown as Record<string, unknown>),
          workload: { command: "codex", args: ["exec", "--json"], stdinArtifactId: null, maxRuntimeSeconds },
        },
      }),
    );
    return seen;
  };

  it("a RESOLVER's answer reaches create (the sandbox TTL) and execute (the command timeout)", async () => {
    const seen = await deadlinesFor((h: { offer: { job: { workload: { maxRuntimeSeconds: number } } } }) =>
      h.offer.job.workload.maxRuntimeSeconds * 1000, 180);
    expect(seen.find((s) => s.op === "create")?.deadlineMs).toBe(180_000);
    expect(seen.find((s) => s.op === "execute")?.deadlineMs).toBe(180_000);
  });

  it("the resolver reads THIS run's handoff — two budgets give two deadlines", async () => {
    const resolver = (h: { offer: { job: { workload: { maxRuntimeSeconds: number } } } }) =>
      h.offer.job.workload.maxRuntimeSeconds * 1000;
    expect((await deadlinesFor(resolver, 120)).find((s) => s.op === "execute")?.deadlineMs).toBe(120_000);
    expect((await deadlinesFor(resolver, 240)).find((s) => s.op === "execute")?.deadlineMs).toBe(240_000);
  });

  it("teardown keeps the BASE deadline — a long run budget must not let a destroy hang", async () => {
    const seen = await deadlinesFor(
      (h: { offer: { job: { workload: { maxRuntimeSeconds: number } } } }) =>
        h.offer.job.workload.maxRuntimeSeconds * 1000,
      180,
    );
    expect(seen.find((s) => s.op === "destroy")?.deadlineMs).toBe(60_000);
  });

  // ★ THE RACE, NOT JUST THE CTX. Mutation testing found this: reverting only the
  // supervisor-side execute RACE to the base 60 s left every ctx assertion above green, because
  // the fake provider returns instantly and the race never fires. But that revert is the SAME
  // bug in a new place — a command legitimately running 90 s inside a 180 s ctx budget would be
  // killed by the backstop and reported `execute_timeout` while still inside its budget. The
  // two numbers must be equal, so the armed timer is observed directly.
  it("arms the execute RACE with the run's deadline, not the base one", async () => {
    const armed: number[] = [];
    const fakeSchedule = (_fn: () => void, ms: number): number => { armed.push(ms); return armed.length; };
    const { provider } = deadlineRecordingProvider(createFakeSandboxProvider());
    const supervisor = createSupervisor({
      provider,
      identity: SUPERVISOR_IDENTITY,
      eventSink: collectingSink(),
      opDeadlineMs: ((h: { offer: { job: { workload: { maxRuntimeSeconds: number } } } }) =>
        h.offer.job.workload.maxRuntimeSeconds * 1000) as never,
      setTimeoutFn: fakeSchedule as unknown as typeof setTimeout,
      clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
    });

    await supervisor.accept(
      makeHandoff({
        job: {
          ...(makeHandoff().offer.job as unknown as Record<string, unknown>),
          workload: { command: "codex", args: ["exec", "--json"], stdinArtifactId: null, maxRuntimeSeconds: 180 },
        },
      }),
    );

    // Two races are armed: create (its own `createBudget`, untouched by H1) then execute.
    expect(armed.length).toBeGreaterThanOrEqual(2);
    expect(armed.at(-1)).toBe(180_000);
    expect(armed.at(-1)).not.toBe(60_000);
    // The create race is deliberately NOT the run budget: a slow CREATE is a different failure
    // from a long-running command, and only the latter is what the workload budgets for.
    expect(armed[0]).toBe(30_000);
  });

  it("a plain NUMBER still behaves exactly as before (the desktop root, and every test)", async () => {
    const seen = await deadlinesFor(45_000, 3600);
    for (const entry of seen) expect(entry.deadlineMs, entry.op).toBe(45_000);
  });

  it("an ABSENT dep keeps the 60s default on every op (inert by construction)", async () => {
    const seen = await deadlinesFor(undefined, 3600);
    for (const entry of seen) expect(entry.deadlineMs, entry.op).toBe(60_000);
  });

  // A resolver that throws or returns garbage must NOT become the deadline: `setTimeout(NaN)`
  // fires immediately, so it would kill every run instantly rather than fall back.
  it.each([
    ["throws", () => { throw new Error("boom"); }],
    ["returns NaN", () => Number.NaN],
    ["returns zero", () => 0],
    ["returns a negative", () => -1],
    ["returns Infinity", () => Number.POSITIVE_INFINITY],
    ["returns a non-number", () => "600" as unknown as number],
  ])("falls back to the base deadline when the resolver %s", async (_label, resolver) => {
    const seen = await deadlinesFor(resolver);
    expect(seen.length).toBeGreaterThan(0);
    for (const entry of seen) expect(entry.deadlineMs, entry.op).toBe(60_000);
  });
});
