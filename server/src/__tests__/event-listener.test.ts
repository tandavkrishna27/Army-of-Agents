import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── drizzle-orm mock ─────────────────────────────────────────────────────────
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...args: any[]) => args),
  eq: vi.fn((a: any, b: any) => ({ eq: [a, b] })),
  desc: vi.fn((value: any) => ({ desc: value })),
  sql: Object.assign(
    vi.fn((strings: any, ...values: any[]) => ({
      sql: strings,
      values,
      as: vi.fn().mockReturnValue("aliased"),
    })),
    { raw: vi.fn((input: any) => input) },
  ),
}));

// ── DB table stubs ───────────────────────────────────────────────────────────
vi.mock("@armyofagents/db", () => ({
  internalAgentRuns: {
    id: "run_id",
    companyId: "run_company_id",
    triggerType: "run_trigger_type",
    triggerSource: "run_trigger_source",
    status: "run_status",
  },
}));

// ── Mock live-events ─────────────────────────────────────────────────────────
const mockSubscribe = vi.fn();
vi.mock("../services/live-events.js", () => ({
  subscribeCompanyLiveEvents: (...args: any[]) => mockSubscribe(...args),
}));

import {
  createEventListener,
  type EventTriggerResult,
} from "../services/internal-agent/event-listener.js";

describe("event-listener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Event routing ──────────────────────────────────────────────────────
  describe("event routing", () => {
    it("routes heartbeat.run.status events to the heartbeat trigger", () => {
      const onTrigger = vi.fn();
      const db = {
        insert: vi.fn(() => ({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn(() => Promise.resolve([{ id: "run-1" }])),
        })),
      };

      const listener = createEventListener(db as any, "company-1", { onTrigger });

      // Capture the listener function passed to subscribe
      expect(mockSubscribe).toHaveBeenCalledWith("company-1", expect.any(Function));
      const eventHandler = mockSubscribe.mock.calls[0][1];

      // Simulate a heartbeat terminal event
      eventHandler({
        id: 1,
        companyId: "company-1",
        type: "heartbeat.run.status",
        payload: { status: "completed", runId: "run-123" },
        createdAt: new Date().toISOString(),
      });

      expect(onTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "heartbeat.run.status",
          triggerSource: "heartbeat_terminal",
        }),
      );
    });

    it("routes activity.logged events for task status changes", () => {
      const onTrigger = vi.fn();
      const db = {
        insert: vi.fn(() => ({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn(() => Promise.resolve([{ id: "run-1" }])),
        })),
      };

      createEventListener(db as any, "company-1", { onTrigger });
      const eventHandler = mockSubscribe.mock.calls[0][1];

      eventHandler({
        id: 2,
        companyId: "company-1",
        type: "activity.logged",
        payload: { action: "issue.status_changed", entityId: "task-1" },
        createdAt: new Date().toISOString(),
      });

      expect(onTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "activity.logged",
          triggerSource: "task_status_change",
        }),
      );
    });

    it("routes discussion.entry.created events to extraction trigger", () => {
      const onTrigger = vi.fn();
      const db = {
        insert: vi.fn(() => ({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn(() => Promise.resolve([{ id: "run-1" }])),
        })),
      };

      createEventListener(db as any, "company-1", { onTrigger });
      const eventHandler = mockSubscribe.mock.calls[0][1];

      eventHandler({
        id: 3,
        companyId: "company-1",
        type: "discussion.entry.created",
        payload: { discussionId: "disc-1", entryId: "entry-1" },
        createdAt: new Date().toISOString(),
      });

      expect(onTrigger).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "discussion.entry.created",
          triggerSource: "discussion_entry",
        }),
      );
    });

    it("ignores unknown event types", () => {
      const onTrigger = vi.fn();
      const db = {
        insert: vi.fn(() => ({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn(() => Promise.resolve([{ id: "run-1" }])),
        })),
      };

      createEventListener(db as any, "company-1", { onTrigger });
      const eventHandler = mockSubscribe.mock.calls[0][1];

      eventHandler({
        id: 4,
        companyId: "company-1",
        type: "some.random.event",
        payload: {},
        createdAt: new Date().toISOString(),
      });

      expect(onTrigger).not.toHaveBeenCalled();
    });
  });

  // ── Debounce ───────────────────────────────────────────────────────────
  describe("debounce", () => {
    it("prevents duplicate triggers for same entity within 30 seconds", () => {
      const onTrigger = vi.fn();
      const db = {
        insert: vi.fn(() => ({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn(() => Promise.resolve([{ id: "run-1" }])),
        })),
      };

      createEventListener(db as any, "company-1", { onTrigger });
      const eventHandler = mockSubscribe.mock.calls[0][1];

      const event = {
        id: 5,
        companyId: "company-1",
        type: "heartbeat.run.status",
        payload: { status: "completed", runId: "run-123" },
        createdAt: new Date().toISOString(),
      };

      // Fire same event (same runId) twice quickly
      eventHandler(event);
      eventHandler({ ...event, id: 6 });

      // Should only trigger once due to debounce on same entity
      expect(onTrigger).toHaveBeenCalledTimes(1);
    });

    it("allows different entities of the same event type to trigger independently", () => {
      const onTrigger = vi.fn();
      const db = {
        insert: vi.fn(() => ({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn(() => Promise.resolve([{ id: "run-1" }])),
        })),
      };

      createEventListener(db as any, "company-1", { onTrigger });
      const eventHandler = mockSubscribe.mock.calls[0][1];

      // Two different tasks complete within 30s — both should trigger
      eventHandler({
        id: 10,
        companyId: "company-1",
        type: "heartbeat.run.status",
        payload: { status: "completed", runId: "run-AAA" },
        createdAt: new Date().toISOString(),
      });

      eventHandler({
        id: 11,
        companyId: "company-1",
        type: "heartbeat.run.status",
        payload: { status: "completed", runId: "run-BBB" },
        createdAt: new Date().toISOString(),
      });

      // Both should trigger because they have different entity IDs (runId)
      expect(onTrigger).toHaveBeenCalledTimes(2);
    });

    it("allows trigger after debounce window expires", () => {
      const onTrigger = vi.fn();
      const db = {
        insert: vi.fn(() => ({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn(() => Promise.resolve([{ id: "run-1" }])),
        })),
      };

      createEventListener(db as any, "company-1", { onTrigger });
      const eventHandler = mockSubscribe.mock.calls[0][1];

      const event = {
        id: 7,
        companyId: "company-1",
        type: "heartbeat.run.status",
        payload: { status: "completed", runId: "run-123" },
        createdAt: new Date().toISOString(),
      };

      eventHandler(event);
      expect(onTrigger).toHaveBeenCalledTimes(1);

      // Advance past 30-second debounce window
      vi.advanceTimersByTime(31_000);

      eventHandler({ ...event, id: 8 });
      expect(onTrigger).toHaveBeenCalledTimes(2);
    });
  });

  // ── Unsubscribe ────────────────────────────────────────────────────────
  describe("lifecycle", () => {
    it("returns an unsubscribe function", () => {
      const mockUnsub = vi.fn();
      mockSubscribe.mockReturnValueOnce(mockUnsub);

      const db = {
        insert: vi.fn(() => ({
          values: vi.fn().mockReturnThis(),
          returning: vi.fn(() => Promise.resolve([{ id: "run-1" }])),
        })),
      };

      const listener = createEventListener(db as any, "company-1", {});

      expect(listener.unsubscribe).toBeDefined();
      listener.unsubscribe();
      expect(mockUnsub).toHaveBeenCalled();
    });
  });
});
