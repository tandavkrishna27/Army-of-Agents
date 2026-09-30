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

describe("fence-close-idempotent-terminal — close() is idempotent + terminal; the proxy never re-opens", () => {
  it("repeated close() fires the fence_close metric ONCE and leaves the fence permanently closed", async () => {
    const metrics = createMetrics();
    const proxy = new FenceCloseProxy({ fence, identity, eventSink: collectingEventSink(), metrics });

    expect(proxy.isActive()).toBe(true);
    proxy.close("lease_lost");
    proxy.close("cancel_requested"); // idempotent — a second close is a no-op
    proxy.close();
    expect(proxy.isActive()).toBe(false);

    // The metric transition fired exactly once (first reason wins).
    const text = metrics.renderPrometheus();
    expect(text).toContain('fence_close{reason="lease_lost"} 1');
    expect(text).not.toContain("cancel_requested");

    // The proxy can NEVER be re-opened — every effect stays denied.
    await expect(proxy.commit(() => "x")).rejects.toBeInstanceOf(FenceClosedError);
  });
});
