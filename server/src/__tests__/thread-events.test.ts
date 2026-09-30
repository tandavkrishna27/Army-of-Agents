import { describe, it, expect } from "vitest";
import {
  publishLiveEvent,
  subscribeCompanyLiveEvents,
} from "../services/live-events.js";
import type { LiveEvent, LiveEventType } from "@armyofagents/shared";

// Plan 7 Task 1: the thread.* event types are valid LiveEventType members and
// flow through the in-process company bus. We match the *real* exports:
//   publishLiveEvent({ companyId, type, payload })  (single-object signature)
//   subscribeCompanyLiveEvents(companyId, listener)
describe("thread events", () => {
  it("delivers thread.entry.created to a company subscriber", () => {
    const received: LiveEvent[] = [];
    const unsub = subscribeCompanyLiveEvents("co1", (e) => received.push(e));
    publishLiveEvent({
      companyId: "co1",
      type: "thread.entry.created",
      payload: { threadId: "t1" },
    });
    unsub();

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("thread.entry.created");
    expect(received[0].companyId).toBe("co1");
    expect(received[0].payload).toEqual({ threadId: "t1" });
  });

  it("accepts every Plan 7 thread.* event type", () => {
    const threadTypes: LiveEventType[] = [
      "thread.entry.created",
      "thread.scope.changed",
      "thread.phase.changed",
      "thread.summary.updated",
      "thread.participant.changed",
      "thread.presence",
    ];

    const received: LiveEvent[] = [];
    const unsub = subscribeCompanyLiveEvents("co2", (e) => received.push(e));
    for (const type of threadTypes) {
      publishLiveEvent({ companyId: "co2", type, payload: { threadId: "t9" } });
    }
    unsub();

    expect(received.map((e) => e.type)).toEqual(threadTypes);
  });

  it("does not deliver another company's events", () => {
    const received: LiveEvent[] = [];
    const unsub = subscribeCompanyLiveEvents("coA", (e) => received.push(e));
    publishLiveEvent({
      companyId: "coB",
      type: "thread.entry.created",
      payload: { threadId: "t1" },
    });
    unsub();
    expect(received).toHaveLength(0);
  });
});
