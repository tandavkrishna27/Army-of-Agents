import { describe, expect, it } from "vitest";

import { FenceCloseProxy, FenceClosedError } from "../lease/fence-close-proxy.js";
import type { EffectFence } from "../supervisor/effect-authority.js";
import type { EventDeliveryIdentity } from "../supervisor/events.js";

import { FENCE_TOKEN, POLL_FIXTURE_IDS } from "./support/poll-fixtures.js";
import { collectingEventSink } from "./support/renewal-fixtures.js";

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

describe("fence-close-proxy-deny — after close(), every governed effect throws FenceClosedError", () => {
  it("commit / readSecret / complete / openEgress all reject FenceClosedError and never run the executor", async () => {
    const sink = collectingEventSink();
    const proxy = new FenceCloseProxy({ fence, identity, eventSink: sink });
    proxy.close();
    expect(proxy.isActive()).toBe(false);

    let ran = 0;
    const spy = () => {
      ran += 1;
      return "should-not-run";
    };

    await expect(proxy.commit(spy)).rejects.toBeInstanceOf(FenceClosedError);
    await expect(proxy.readSecret(spy)).rejects.toBeInstanceOf(FenceClosedError);
    await expect(proxy.complete(spy)).rejects.toBeInstanceOf(FenceClosedError);
    await expect(proxy.openEgress(spy)).rejects.toBeInstanceOf(FenceClosedError);

    // The executor is NEVER reached once the fence is closed.
    expect(ran).toBe(0);

    // The error names the denied effect.
    await proxy.commit(spy).catch((err: unknown) => {
      expect(err).toBeInstanceOf(FenceClosedError);
      expect((err as FenceClosedError).effect).toBe("artifact_commit");
      expect((err as FenceClosedError).leaseId).toBe(POLL_FIXTURE_IDS.lease);
    });
  });
});
