import { describe, expect, it } from "vitest";

import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { createSupervisor } from "../supervisor/supervisor.js";
import { createRunCanaryCoordinator } from "../supervisor/run-canaries.js";
import { createLeaseRenewalDriver } from "../lease/lease-renewal.js";
import { FenceCloseProxy } from "../lease/fence-close-proxy.js";
import { SecretMaterializationError } from "../lease/secret-redemption.js";
import { generateDeviceKey } from "../identity/device-key.js";
import type { EffectFence } from "../supervisor/effect-authority.js";
import type { EventDeliveryIdentity } from "../supervisor/events.js";
import type { ControlPlaneClient } from "../transport/client.js";
import type { WorkerSession } from "../enrollment/enroll.js";
import { collectingSink, makeGate, makeHandoff, SUPERVISOR_IDENTITY, waitFor } from "./support/supervisor-fixtures.js";
import { FENCE_TOKEN, POLL_FIXTURE_IDS } from "./support/poll-fixtures.js";
import {
  FakeScheduler,
  RENEWAL_IDENTITY,
  collectingEventSink,
  makeRenewalHandoff,
  recordingSupervisor,
  staticSessionProvider,
} from "./support/renewal-fixtures.js";

const SECRET = "sk-ant-SUPERSECRET-value";

function terminalOf(sink: ReturnType<typeof collectingSink>) {
  return sink.events.find((e) => e.eventType === "terminal");
}

describe("supervisor secret materialisation — FAIL CLOSED (A2/A3/A4)", () => {
  it("POSITIVE CONTROL: a materialize that RESOLVES normally lets the run create a sandbox", async () => {
    const fake = createFakeSandboxProvider();
    const sink = collectingSink();
    const sup = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      materializeRunSecrets: async () => ({ env: { ANTHROPIC_API_KEY: SECRET }, canaries: [SECRET] }),
    });
    await sup.accept(makeHandoff());
    expect(fake.callCount("create")).toBe(1); // proves the path is exercised (control)
  });

  it("a DENIED redemption fails CLOSED: NO sandbox created, a failed terminal (A2)", async () => {
    const fake = createFakeSandboxProvider();
    const sink = collectingSink();
    const sup = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      materializeRunSecrets: async () => {
        throw new SecretMaterializationError("target_revoked");
      },
    });
    await sup.accept(makeHandoff());
    expect(fake.callCount("create")).toBe(0); // fail-closed core: never proceeds to create
    const terminal = terminalOf(sink);
    expect(terminal?.payload).toMatchObject({ status: "failed", errorCode: "secret_redemption_failed" });
  });

  it("a HANGING redemption is cut by the budget and fails CLOSED (A3, R6)", async () => {
    const fake = createFakeSandboxProvider();
    const sink = collectingSink();
    const sup = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      secretRedeemDeadlineMs: 50,
      materializeRunSecrets: () => new Promise(() => {}), // never resolves
    });
    await sup.accept(makeHandoff());
    expect(fake.callCount("create")).toBe(0);
    const terminal = terminalOf(sink);
    expect(terminal?.payload).toMatchObject({ status: "failed", errorCode: "secret_redemption_timeout" });
  });
});

describe("supervisor secret materialisation — env synthesis + per-run canary seeding", () => {
  it("the redeemed value reaches the create spec env (A1, M2)", async () => {
    const fake = createFakeSandboxProvider();
    const sup = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: collectingSink(),
      materializeRunSecrets: async () => ({ env: { ANTHROPIC_API_KEY: SECRET }, canaries: [SECRET] }),
    });
    const handoff = makeHandoff();
    await sup.accept(handoff);
    const created = fake.calls().find((c) => c.op === "create");
    expect(created?.sandboxId).toBeTruthy();
    expect(fake.peek(created!.sandboxId!)?.env.ANTHROPIC_API_KEY).toBe(SECRET);
  });

  it("the redeemed value is REDACTED from the lifecycle stream (A6, M12)", async () => {
    const fake = createFakeSandboxProvider();
    const sink = collectingSink();
    const sup = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      materializeRunSecrets: async () => ({ env: { ANTHROPIC_API_KEY: SECRET }, canaries: [SECRET] }),
      // A CLI that echoes its key into stdout — the exact leak the canary catches.
      observeRun: () => ({ logs: [{ stream: "stdout", message: `starting with ${SECRET} now` }] }),
    });
    await sup.accept(makeHandoff());
    const log = sink.events.find((e) => e.eventType === "log");
    expect(log).toBeTruthy();
    // Anti-vacuity: the secret WAS in the message the run produced (see the control below); here it is scrubbed.
    expect(JSON.stringify(log)).not.toContain(SECRET);
    expect(JSON.stringify(log)).toContain("«redacted»");
  });

  it("ANTI-VACUITY CONTROL: with no canary, the same log message leaks the value verbatim", async () => {
    const fake = createFakeSandboxProvider();
    const sink = collectingSink();
    const sup = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: sink,
      materializeRunSecrets: async () => ({ env: {}, canaries: [] }), // nothing seeded
      observeRun: () => ({ logs: [{ stream: "stdout", message: `starting with ${SECRET} now` }] }),
    });
    await sup.accept(makeHandoff());
    const log = sink.events.find((e) => e.eventType === "log");
    expect(JSON.stringify(log)).toContain(SECRET); // proves the leak is real when unredacted
  });

  it("seeds the canary BEFORE create (A9, M11) — the array is already seeded when create is in-flight", async () => {
    const { gate, release } = makeGate();
    const fake = createFakeSandboxProvider({ createGate: gate });
    const coordinator = createRunCanaryCoordinator();
    const handoff = makeHandoff();
    const sup = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: collectingSink(),
      canaryCoordinator: coordinator,
      materializeRunSecrets: async () => ({ env: { ANTHROPIC_API_KEY: SECRET }, canaries: [SECRET] }),
    });
    const done = sup.accept(handoff);
    await waitFor(() => fake.callCount("create") === 1);
    // create is in-flight → the seed already happened (before create), M11.
    expect(coordinator.ensure(handoff.leaseId)).toContain(SECRET);
    release();
    await done;
  });

  it("canaries are PER-RUN, no cross-lease bleed (A8, M14)", async () => {
    const fake = createFakeSandboxProvider();
    const coordinator = createRunCanaryCoordinator();
    const sup = createSupervisor({
      provider: fake,
      identity: SUPERVISOR_IDENTITY,
      eventSink: collectingSink(),
      canaryCoordinator: coordinator,
      materializeRunSecrets: async (h) => ({ env: { ANTHROPIC_API_KEY: `v-${h.leaseId}` }, canaries: [`v-${h.leaseId}`] }),
    });
    const a = makeHandoff({ leaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const b = makeHandoff({ leaseId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    await sup.accept(a);
    await sup.accept(b);
    // Each lease's array carries only its OWN run's canary — a per-supervisor registry would merge them.
    expect(coordinator.ensure(a.leaseId)).toEqual([`v-${a.leaseId}`]);
    expect(coordinator.ensure(b.leaseId)).toEqual([`v-${b.leaseId}`]);
  });
});

describe("fence-close proxy redaction via the shared coordinator array (A7, M13)", () => {
  const FENCE: EffectFence = {
    jobId: POLL_FIXTURE_IDS.job,
    attempt: 1,
    leaseId: POLL_FIXTURE_IDS.lease,
    fenceToken: FENCE_TOKEN,
    deviceGeneration: 1,
    observedSeq: 0,
  };
  const IDENTITY: EventDeliveryIdentity = {
    organizationId: POLL_FIXTURE_IDS.org,
    companyId: POLL_FIXTURE_IDS.company,
    workerId: POLL_FIXTURE_IDS.worker,
    jobId: POLL_FIXTURE_IDS.job,
    attempt: 1,
    leaseId: POLL_FIXTURE_IDS.lease,
    fenceToken: FENCE_TOKEN,
  };

  it("a planted secret in a post-close network_denied reason is REDACTED when the coordinator array is seeded", async () => {
    const coordinator = createRunCanaryCoordinator();
    const sink = collectingSink();
    const proxy = new FenceCloseProxy({
      fence: FENCE,
      identity: IDENTITY,
      eventSink: sink,
      redactionCanaries: coordinator.ensure(FENCE.leaseId), // the SAME array the supervisor would seed
    });
    coordinator.ensure(FENCE.leaseId).push(SECRET); // supervisor seeds it before create
    proxy.close("lease_lost");
    await expect(proxy.openEgress(() => 1, { reason: `blocked ${SECRET} egress` })).rejects.toThrow();
    const denied = sink.events.find((e) => e.eventType === "network_denied");
    expect(denied).toBeTruthy();
    expect(JSON.stringify(denied)).not.toContain(SECRET);
    expect(JSON.stringify(denied)).toContain("«redacted»");
  });

  it("ANTI-VACUITY CONTROL: an UNSEEDED proxy leaks the same reason verbatim", async () => {
    const sink = collectingSink();
    const proxy = new FenceCloseProxy({ fence: FENCE, identity: IDENTITY, eventSink: sink, redactionCanaries: [] });
    proxy.close("lease_lost");
    await expect(proxy.openEgress(() => 1, { reason: `blocked ${SECRET} egress` })).rejects.toThrow();
    const denied = sink.events.find((e) => e.eventType === "network_denied");
    expect(JSON.stringify(denied)).toContain(SECRET);
  });
});

describe("the DRIVER wires the coordinator into the fence-close proxy it builds (M13)", () => {
  const DRIVER_SESSION: WorkerSession = {
    token: "live-session-token",
    workerId: POLL_FIXTURE_IDS.worker,
    targetId: POLL_FIXTURE_IDS.target,
    deviceGeneration: 1,
    obtainedAtMs: 1_000,
    ttlMs: 900_000,
    expiresAtMs: 901_000,
  };

  it("the proxy the REAL makeProxy builds shares the coordinator's array → its network_denied is redacted", async () => {
    const coordinator = createRunCanaryCoordinator();
    const sink = collectingEventSink();
    const driver = createLeaseRenewalDriver({
      client: {} as ControlPlaneClient, // never called: no renewal fires (scheduler not advanced)
      session: staticSessionProvider(DRIVER_SESSION),
      key: generateDeviceKey(),
      identity: RENEWAL_IDENTITY,
      supervisor: recordingSupervisor().supervisor, // accept() stays pending → proxy stays live
      schedule: new FakeScheduler(),
      eventSink: sink,
      canaryCoordinator: coordinator,
    });
    const handoff = makeRenewalHandoff({ windowMs: 100_000 });
    void driver.accept(handoff); // registerLease builds the proxy via the real makeProxy(coordinator)
    const proxy = driver.proxyFor(handoff.leaseId);
    expect(proxy, "the driver must expose the per-lease proxy").toBeTruthy();

    coordinator.ensure(handoff.leaseId).push(SECRET); // the supervisor seeds this SAME array
    proxy!.close("lease_lost");
    await expect(proxy!.openEgress(() => 1, { reason: `blocked ${SECRET} egress` })).rejects.toThrow();
    const denied = sink.events.find((e) => e.eventType === "network_denied");
    expect(denied).toBeTruthy();
    expect(JSON.stringify(denied)).not.toContain(SECRET);
    expect(JSON.stringify(denied)).toContain("«redacted»");
  });
});
