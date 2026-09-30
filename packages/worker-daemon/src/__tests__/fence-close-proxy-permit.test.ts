import { describe, expect, it } from "vitest";

import { FenceCloseProxy } from "../lease/fence-close-proxy.js";
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

describe("fence-close-proxy-permit — while the fence is live, all four governed effects pass the guard", () => {
  it("commit / readSecret / complete / openEgress run their executor and return its value", async () => {
    const sink = collectingEventSink();
    const proxy = new FenceCloseProxy({ fence, identity, eventSink: sink });

    expect(proxy.isActive()).toBe(true);
    await expect(proxy.commit(() => "committed")).resolves.toBe("committed");
    await expect(proxy.readSecret(() => "secret")).resolves.toBe("secret");
    await expect(proxy.complete(() => "completed")).resolves.toBe("completed");
    await expect(proxy.openEgress(() => "egressed")).resolves.toBe("egressed");

    // No network_denied is emitted while the fence is live.
    expect(sink.events).toHaveLength(0);
    expect(proxy.isActive()).toBe(true);
  });
});
