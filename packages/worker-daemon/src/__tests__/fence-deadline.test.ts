/**
 * DSK-002 Lane C / I7 + I8 — a governed effect past the lease deadline is refused
 * LOCALLY, on the clock, whether or not anything closed the fence.
 *
 * `FenceCloseProxy` gated every effect on `#active` — a boolean flipped by `close()`.
 * It never consulted a clock. `lease-renewal.ts` does close the fence with
 * `deadline_lapse`, and it does so without needing the network, but only while its loop
 * is actually running and only after its retry `sleep` returns. Between real expiry and
 * that closure every governed effect was permitted, and if the loop is stopped, crashed,
 * or was never registered, the window has no bound at all.
 *
 * The four governed effects are exactly the surfaces the acceptance clauses name:
 * `artifact_commit` (clause 1, "cannot auto-commit"), `secret_materialization`
 * (clause 1, "or use a local credential"), `task_completion`, and `governed_egress`
 * (clause 5).
 *
 * I8 is the point of the whole lane: this check reads a clock and nothing else, so
 * REACHABILITY IS NOT AUTHORITY. A device with a perfect Internet connection is refused
 * exactly as an unplugged one is.
 */

import { describe, expect, it, vi } from "vitest";

import { FenceCloseProxy, FenceClosedError } from "../lease/fence-close-proxy.js";
import type { EffectFence } from "../supervisor/effect-authority.js";
import type { EventDeliveryIdentity } from "../supervisor/events.js";

import { FENCE_TOKEN, POLL_FIXTURE_IDS } from "./support/poll-fixtures.js";
import { collectingEventSink } from "./support/renewal-fixtures.js";

// The SHARED fixtures, not hand-rolled stubs. The first draft of this file invented its
// own `identity` and cast it with `as never`; the cast suppressed the type error, and the
// four egress tests then failed inside the event canonicalizer instead — a missing
// `organizationId` reported as `CanonicalJsonError: unsupported value`. Typed fixtures and
// no casts is the fix, and the reason to record it: `as never` in a test disables exactly
// the check that would have caught the mistake at compile time.
const fence: EffectFence = {
  jobId: POLL_FIXTURE_IDS.job,
  attempt: 1,
  leaseId: POLL_FIXTURE_IDS.lease,
  fenceToken: FENCE_TOKEN,
  deviceGeneration: 1,
  observedSeq: 0,
};

const identity: EventDeliveryIdentity = {
  organizationId: POLL_FIXTURE_IDS.org,
  companyId: POLL_FIXTURE_IDS.company,
  workerId: POLL_FIXTURE_IDS.worker,
  jobId: POLL_FIXTURE_IDS.job,
  attempt: 1,
  leaseId: POLL_FIXTURE_IDS.lease,
  fenceToken: FENCE_TOKEN,
};

const EXPIRES_AT = 1_000_000;

function makeProxy(nowMs: number, opts: { withDeadline?: boolean } = {}) {
  const eventSink = collectingEventSink();
  const proxy = new FenceCloseProxy({
    fence,
    identity,
    eventSink,
    ...(opts.withDeadline === false ? {} : { expiresAtMs: EXPIRES_AT, nowMs: () => nowMs }),
  });
  return { proxy, eventSink };
}

describe("DSK-002/I7 — every governed effect checks the deadline, not just `close()`", () => {
  it("permits effects BEFORE the deadline", async () => {
    const { proxy } = makeProxy(EXPIRES_AT - 1);
    await expect(proxy.commit(() => "committed")).resolves.toBe("committed");
    await expect(proxy.readSecret(() => "secret")).resolves.toBe("secret");
    await expect(proxy.complete(() => "done")).resolves.toBe("done");
    await expect(proxy.openEgress(() => "sent")).resolves.toBe("sent");
  });

  it("refuses a COMMIT at and past the deadline, though nothing called close()", async () => {
    // Clause (1): expired offline work cannot auto-commit.
    const { proxy } = makeProxy(EXPIRES_AT);
    expect(proxy.isActive()).toBe(true); // nothing closed it — this is the whole point
    await expect(proxy.commit(() => "committed")).rejects.toBeInstanceOf(FenceClosedError);
  });

  it("refuses a CREDENTIAL read past the deadline", async () => {
    // Clause (1): ...or use a local credential for governed remote effects.
    const { proxy } = makeProxy(EXPIRES_AT + 60_000);
    await expect(proxy.readSecret(() => "secret")).rejects.toBeInstanceOf(FenceClosedError);
  });

  it("refuses COMPLETION and EGRESS past the deadline", async () => {
    const { proxy } = makeProxy(EXPIRES_AT + 1);
    await expect(proxy.complete(() => "done")).rejects.toBeInstanceOf(FenceClosedError);
    await expect(proxy.openEgress(() => "sent")).rejects.toBeInstanceOf(FenceClosedError);
  });

  it("never RUNS the effect it refuses", async () => {
    // A refusal that still executed the body would be theatre — the commit would have
    // hit the network before the error surfaced.
    const { proxy } = makeProxy(EXPIRES_AT + 1);
    const effect = vi.fn(() => "ran");
    await expect(proxy.commit(effect)).rejects.toBeInstanceOf(FenceClosedError);
    await expect(proxy.readSecret(effect)).rejects.toBeInstanceOf(FenceClosedError);
    await expect(proxy.complete(effect)).rejects.toBeInstanceOf(FenceClosedError);
    await expect(proxy.openEgress(effect)).rejects.toBeInstanceOf(FenceClosedError);
    expect(effect).not.toHaveBeenCalled();
  });

  it("closes the fence on the lapse, so the state is terminal and observable", async () => {
    // The deadline is not a per-call veto that leaves the proxy claiming to be live:
    // lapsing IS a close, so `isActive()` tells an operator the truth afterwards.
    const { proxy } = makeProxy(EXPIRES_AT + 1);
    await expect(proxy.commit(() => "x")).rejects.toBeInstanceOf(FenceClosedError);
    expect(proxy.isActive()).toBe(false);
  });
});

describe("DSK-002/I8 — reachability is not authority", () => {
  it("refuses regardless of network state, because it consults only a clock", async () => {
    // There is no network input to this decision by construction. The test states the
    // property the ticket asks for — "even while the public Internet remains reachable" —
    // and the construction is what makes it true: an egress that would SUCCEED is still
    // refused, because the refusal happens before the effect runs.
    const { proxy } = makeProxy(EXPIRES_AT + 1);
    const reachableNetwork = vi.fn(async () => "200 OK");
    await expect(proxy.openEgress(reachableNetwork)).rejects.toBeInstanceOf(FenceClosedError);
    expect(reachableNetwork).not.toHaveBeenCalled();
  });

  it("emits the network_denied event on a lapsed egress, as on a closed one", async () => {
    const { proxy, eventSink } = makeProxy(EXPIRES_AT + 1);
    await expect(proxy.openEgress(() => "sent")).rejects.toBeInstanceOf(FenceClosedError);
    expect(eventSink.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(eventSink.events)).toContain("network_denied");
  });
});

describe("DSK-002 Lane C — the deadline is OPTIONAL and defaults to prior behaviour", () => {
  it("behaves exactly as before when no deadline is supplied", async () => {
    // Every existing construction of this proxy passes no deadline. Absent one, the
    // clock plays no part and `close()` remains the only gate.
    const { proxy } = makeProxy(EXPIRES_AT + 10_000_000, { withDeadline: false });
    await expect(proxy.commit(() => "committed")).resolves.toBe("committed");
    proxy.close("lease_lost");
    await expect(proxy.commit(() => "committed")).rejects.toBeInstanceOf(FenceClosedError);
  });
});
