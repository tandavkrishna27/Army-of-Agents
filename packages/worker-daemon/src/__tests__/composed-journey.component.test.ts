// -----------------------------------------------------------------------------
// CLI-006 / D2 — Sprint 5 Step 1: the COMPOSED dispatch runtime drives ONE lease
// through to a supervised run.
//
// This is the join no prior test made: `composeDispatchRuntime` with its REAL
// factories (poll loop + renewal driver + supervisor + durable outbox drain), a
// per-op FAKE provider, and a real `client`/`session`/`key`/`self` from a real
// enrollment against the protocol-faithful control-plane double. One offer is
// enqueued; the composed loop polls it, self-checks it, ACKs it over the real
// lease-ack POST, hands off to the supervisor, which runs create → execute
// (inside the sandbox) → destroy, and the durable outbox drain uploads the
// terminal event.
//
//   - `poll-offer-ack.component.test.ts` proved the poll/ACK half (real client,
//     no supervisor).
//   - `supervisor-happy.component.test.ts` proved the supervise half (real
//     supervisor, hand-fed handoff).
//   This test JOINS them through `createPollLoop`/`createSupervisor` — the
//   evidence `E4-1-leases-through-protocol` / `E4-2-supervises-sandboxes` name.
//
// No real E2B, no key, no spend. Real E2B is E7-1 (the operator dispatch).
// -----------------------------------------------------------------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composeDispatchRuntime, type DispatchRuntime } from "../lifecycle/dispatch-runtime.js";
import { SessionStore } from "../identity/session.js";
import { createFakeSandboxProvider, type FakeSandboxProvider } from "./support/fake-provider.js";
import { startFakeControlPlane, type FakeControlPlane } from "./support/fake-control-plane.js";
import {
  compatibleOffer,
  enrollFixtureWorker,
  enrollmentCodeConfig,
  fixtureProbes,
  makeSelfModel,
  POLL_FIXTURE_IDS,
} from "./support/poll-fixtures.js";

const CODE = "composed-journey-code";

/** The fake provider derives the sandbox id from the offer's job/attempt/lease labels. */
const SANDBOX_ID = `fake-sbx-${POLL_FIXTURE_IDS.job}-1-${POLL_FIXTURE_IDS.lease}`;

/** A CLI-007-shaped Company provider_key handle: an `env` capability delivered `sandbox_local_only`
 * into an allowlisted provider-auth env var. This is what the canary now mints (CLI-007). */
const SECRET_HANDLE = {
  handleId: POLL_FIXTURE_IDS.secretHandle,
  materialization: { kind: "env", target: "ANTHROPIC_API_KEY" },
  usePolicy: "sandbox_local_only",
} as const;
/** A synthetic fixture value — never a real key. The S4 canary tripwire proves it never logs. */
const REDEEMED_VALUE = "sk-ant-fixture-composed-journey-000";

/** A live-window offer carrying the CLI-007 secret handle on its job envelope. */
function credentialOffer() {
  const offer = liveOffer();
  (offer.job as Record<string, unknown>).secretHandles = [SECRET_HANDLE];
  return offer;
}

let fake: FakeControlPlane;
let workDir: string;
let runtime: DispatchRuntime | null;

beforeEach(async () => {
  fake = await startFakeControlPlane({ enrollments: [enrollmentCodeConfig(CODE)] });
  workDir = mkdtempSync(join(tmpdir(), "composed-journey-"));
  runtime = null;
});

afterEach(async () => {
  if (runtime) {
    runtime.leasing.stopLeasing();
    await runtime.leasing.drain().catch(() => {});
    runtime.renewal.stop();
    runtime.eventOutbox.stopDrain();
    await runtime.eventOutbox.flush().catch(() => {});
    runtime.eventOutbox.closeStore();
  }
  await fake.close();
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * Wait up to `timeoutMs` for `predicate`, RESOLVING to whether it became true (never throws).
 * The specifics are then asserted explicitly, so a mutant that skips a hop is killed by a clear
 * assertion — never by an unrelated suite deadline (go-book §2.2).
 */
async function settle(predicate: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

/** A live-window offer (the fixture's ackDeadline/expiresAt are historical). */
function liveOffer(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return compatibleOffer({
    ackDeadline: new Date(now + 5 * 60_000).toISOString(),
    expiresAt: new Date(now + 10 * 60_000).toISOString(),
    ...overrides,
  });
}

async function composeWith(offer: Record<string, unknown>, provider: FakeSandboxProvider): Promise<DispatchRuntime> {
  const { session, key, client } = await enrollFixtureWorker(fake, CODE);
  const self = await makeSelfModel();
  const store = new SessionStore(
    {
      now: () => Date.now(),
      renew: async () => {
        throw new Error("unexpected renew: the enrolled session should outlive this test");
      },
      bootstrap: async () => {
        throw new Error("unexpected bootstrap: the store is seeded with a live session");
      },
    },
    session,
  );
  fake.enqueuePoll({ kind: "offer", offer });
  const rt = await composeDispatchRuntime({
    provider,
    self,
    key,
    store,
    client,
    eventOutboxPath: join(workDir, "outbox.db"),
    concurrency: { batch: 1, browser: 0, service: 0 },
    backoff: { baseMs: 1, maxMs: 5, jitter: 0 } as never,
    workDir,
    probes: fixtureProbes(),
  });
  return rt;
}

describe("composed-journey.component — createPollLoop + createSupervisor take ONE lease and run it", () => {
  // E4-1 and E4-2 are asserted in SEPARATE cases (not one) so a mutation isolates each anchor at the
  // case level: M-E42 (remove trackHandoff at poll-loop.ts:559) leaves the E4-1 lease case GREEN
  // (the ACK still fires) and reddens ONLY the E4-2 supervise case (no create/execute/destroy).
  it("★ E4-1 — the composed loop LEASES: real self-check + ACK over the real protocol", async () => {
    const provider = createFakeSandboxProvider({});
    runtime = await composeWith(liveOffer(), provider);
    runtime.start();

    await settle(() => fake.ackCountFor(POLL_FIXTURE_IDS.lease) === 1);

    // The composed loop took a real lease through the protocol (one ACK, for the offered lease).
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(1);
    expect(fake.acks()[0]).toMatchObject({ leaseId: POLL_FIXTURE_IDS.lease, workerId: POLL_FIXTURE_IDS.worker });
  });

  it("★ E4-2 — a real ACK reaches createSupervisor, which runs create→execute(inside)→destroy", async () => {
    const provider = createFakeSandboxProvider({});
    runtime = await composeWith(liveOffer(), provider);
    runtime.start();

    await settle(() => provider.callCount("destroy") === 1);

    // A real ACK reached the supervisor, which ran the sandbox lifecycle.
    const ops = provider.calls().filter((c) => !c.replayed).map((c) => c.op);
    expect(ops).toEqual(["create", "execute", "destroy"]);
    // The tenant command ran INSIDE the sandbox (the offer's workload), never spawned in-process.
    expect(provider.executionsOf(SANDBOX_ID)).toEqual([
      { command: "codex", args: ["exec", "--json"], insideSandbox: true },
    ]);
    expect(provider.peek(SANDBOX_ID)?.state).toBe("destroyed");
  });

  it("★ stream — the supervisor's terminal event is drained to the control plane, digest-valid", async () => {
    const provider = createFakeSandboxProvider({});
    runtime = await composeWith(liveOffer(), provider);
    runtime.start();

    await settle(() => fake.ackCountFor(POLL_FIXTURE_IDS.lease) === 1 && provider.callCount("destroy") === 1);
    // Force the durable outbox to upload before asserting (the drain is otherwise timer-paced).
    await runtime.eventOutbox.flush();

    await settle(() => fake.eventUploads().some((u) => u.count >= 2), 4000);
    const uploaded = fake.eventUploads();
    // attempt_started + terminal were uploaded (the fake plane independently recomputes each digest,
    // so a re-stamp bug would 400 here rather than pass).
    const total = uploaded.reduce((sum, u) => sum + u.count, 0);
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it("★ credential (CLI-007) — the composed loop REDEEMS the handle into the sandbox env, and the value never leaks", async () => {
    fake.seedSecretResolution(SECRET_HANDLE.handleId, { envTarget: "ANTHROPIC_API_KEY", value: REDEEMED_VALUE });
    const provider = createFakeSandboxProvider({});
    runtime = await composeWith(credentialOffer(), provider);
    runtime.start();

    await settle(() => fake.ackCountFor(POLL_FIXTURE_IDS.lease) === 1 && provider.callCount("destroy") === 1);

    // The lease was taken and the credentialed run completed.
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(1);
    const ops = provider.calls().filter((c) => !c.replayed).map((c) => c.op);
    expect(ops).toEqual(["create", "execute", "destroy"]);

    // The redeemed value reached the sandbox env: job.secretHandles → resolveExecutionSecret →
    // synthesiseRunSecrets → createSpecFor(spec.env) → provider.create. Exactly one resolve.
    expect(fake.resolveCountFor(SECRET_HANDLE.handleId)).toBe(1);
    expect(provider.peek(SANDBOX_ID)?.env.ANTHROPIC_API_KEY).toBe(REDEEMED_VALUE);

    // Decision #104 — the redeemed value reaches ONLY the sandbox env, never the uploaded event
    // stream. Scan the DECRYPTED event BODIES the drain uploaded (not just the upload metadata).
    // The assertion is NON-VACUOUS by its positive control: the emitted attempt_started carries the
    // sandboxId, so the bodies DO contain real event content — and the redeemed value is NOT among
    // it. Honest scope: the composed happy path never STREAMS the value (no observeRun/stdout yet),
    // so this is a CONTAINMENT check on the composed path, not a redaction proof. The redaction
    // MECHANISM for an emitted value is proven on BOTH streams with a planted-leak positive control
    // by DAT-008 slice 5 (supervisor-secret-materialization.test.ts); the per-run canary tripwire is
    // armed here (synthesiseRunSecrets returns the value as env AND as a canary from one call).
    await runtime.eventOutbox.flush();
    await settle(() => fake.eventBodies().length >= 2, 3000);
    const bodies = JSON.stringify(fake.eventBodies());
    expect(bodies).toContain(SANDBOX_ID); // positive control: the bodies carry real emitted content
    expect(bodies).not.toContain(REDEEMED_VALUE); // the credential value is absent from the stream
  });

  it("★ fail-closed — a DENIED redemption fails the run: no sandbox is ever created", async () => {
    // No seeded resolution ⇒ the fake plane denies the handle ⇒ synthesiseRunSecrets throws ⇒ the
    // supervisor fails the attempt CLOSED before create (DAT-008's core invariant, on the composed path).
    const provider = createFakeSandboxProvider({});
    runtime = await composeWith(credentialOffer(), provider);
    runtime.start();

    // The lease is still taken (redemption happens INSIDE the supervisor, after the ACK).
    await settle(() => fake.ackCountFor(POLL_FIXTURE_IDS.lease) === 1 && fake.resolveCountFor(SECRET_HANDLE.handleId) >= 1);
    expect(fake.ackCountFor(POLL_FIXTURE_IDS.lease)).toBe(1);
    // Give the (failing) supervise a moment to settle, then assert NO sandbox was created.
    await settle(() => provider.callCount("create") > 0, 500);
    expect(provider.callCount("create")).toBe(0);
  });
});
