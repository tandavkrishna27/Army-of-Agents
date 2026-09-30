import { describe, expect, it } from "vitest";

import { FenceCloseProxy, FenceClosedError } from "../lease/fence-close-proxy.js";
import { createMetrics } from "../metrics/metrics.js";
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

describe("governed-egress-denied-emits-event — a post-close egress attempt is denied AND emits network_denied", () => {
  it("emits exactly one schema-valid network_denied event into the injected sink and rejects", async () => {
    const sink = collectingEventSink();
    const metrics = createMetrics();
    const proxy = new FenceCloseProxy({ fence, identity, eventSink: sink, metrics });
    proxy.close();

    await expect(
      proxy.openEgress(() => "should-not-run", { destinationClass: "control_plane", reason: "egress after fence close" }),
    ).rejects.toBeInstanceOf(FenceClosedError);

    // Exactly one network_denied event, carrying the frozen payload shape.
    expect(sink.events).toHaveLength(1);
    const event = sink.events[0]!;
    expect(event.eventType).toBe("network_denied");
    expect(event.leaseId).toBe(POLL_FIXTURE_IDS.lease);
    expect(event.fenceToken).toBe(FENCE_TOKEN);
    expect(event.payload).toMatchObject({ destinationClass: "control_plane", reason: "egress after fence close" });

    // The denial is also metered.
    expect(metrics.renderPrometheus()).toContain('governed_effect_denied{effect="governed_egress"} 1');
  });

  it("defaults the denial destination class to not_allowlisted when the attempt is undescribed", async () => {
    const sink = collectingEventSink();
    const proxy = new FenceCloseProxy({ fence, identity, eventSink: sink });
    proxy.close();

    await expect(proxy.openEgress(() => 1)).rejects.toBeInstanceOf(FenceClosedError);
    expect(sink.events[0]!.payload).toMatchObject({ destinationClass: "not_allowlisted" });
  });
});
