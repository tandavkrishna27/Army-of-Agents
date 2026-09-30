// -----------------------------------------------------------------------------
// DEP-011 Slice 1 — the WORKER half of the mint↔labelsFor parity anchor (§1.3, M1).
//
// The control plane mints an OwnedLabelsCapability whose `ownedLabels` MUST equal the
// worker's `labelsFor(handoff)` field-for-field, or the adapter-manager gate rejects
// EVERY networked create (silent, total dispatch failure). `labelsFor` is a
// closure-local inner function (not importable) and the recording fake is worker-daemon
// test-support (not barrel-exported), so the parity is anchored in TWO importable halves
// to ONE explicit, distinct-valued tuple:
//   - HERE (worker): drive a REAL `createSupervisor` create against the recording fake
//     and CAPTURE the real `spec.resourceLabels`, pinning that the supervisor emits the
//     anchor tuple;
//   - server (`server/src/__tests__/owned-labels-mint.test.ts`): prove the mint's
//     `ownedLabelsFromFenceIdentity` produces the SAME anchor tuple from a fence identity.
// Distinct per-field values (esp. attempt=1 != deviceGeneration=7, both numbers; org /
// target / worker / job / lease all different) so a field-swap / wrong-source drift on
// EITHER side diverges from the anchor and fails.
// -----------------------------------------------------------------------------

import { describe, expect, it } from "vitest";

import type { ResourceLabels, WorkerSupervisionIdentity } from "../supervisor/provider.js";
import { createSupervisor } from "../supervisor/supervisor.js";
import { createFakeSandboxProvider } from "./support/fake-provider.js";
import { collectingSink, makeHandoff } from "./support/supervisor-fixtures.js";
import { POLL_FIXTURE_IDS } from "./support/poll-fixtures.js";

// A custom identity whose deviceGeneration (7) is DISTINCT from the fixture job's
// attempt (1) — so a `deviceGeneration <- attempt` swap can never pass unnoticed.
const IDENTITY: WorkerSupervisionIdentity = {
  targetId: POLL_FIXTURE_IDS.target,
  deviceGeneration: 7,
};

// THE ANCHOR TUPLE: exactly what the supervisor's `labelsFor` derives from
// `makeHandoff()` under IDENTITY. The server mint must reproduce this field-for-field.
export const DEP_011_ANCHOR_LABELS: ResourceLabels = {
  organizationId: POLL_FIXTURE_IDS.org,
  targetId: POLL_FIXTURE_IDS.target,
  workerId: POLL_FIXTURE_IDS.worker,
  jobId: POLL_FIXTURE_IDS.job,
  attempt: 1,
  leaseId: POLL_FIXTURE_IDS.lease,
  deviceGeneration: 7,
};

describe("DEP-011 parity — the supervisor's real labelsFor equals the anchor tuple", () => {
  it("a real create captures spec.resourceLabels === the anchor tuple (distinct per-field)", async () => {
    const fake = createFakeSandboxProvider();
    const supervisor = createSupervisor({
      provider: fake,
      identity: IDENTITY,
      eventSink: collectingSink(),
      redactionCanaries: [],
    });

    await supervisor.accept(makeHandoff());

    const created = fake.calls().find((c) => c.op === "create");
    expect(created?.sandboxId).toBeTruthy();
    // `spec.resourceLabels` is stored verbatim by the fake's `create` as the sandbox's labels.
    const captured = fake.peek(created!.sandboxId!)?.labels;
    expect(captured).toEqual(DEP_011_ANCHOR_LABELS);
    // attempt and deviceGeneration are BOTH numbers AND distinct (kills a numeric field-swap).
    expect(typeof captured?.attempt).toBe("number");
    expect(typeof captured?.deviceGeneration).toBe("number");
    expect(captured?.attempt).not.toBe(captured?.deviceGeneration);
  });
});
