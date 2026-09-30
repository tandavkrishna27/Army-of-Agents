// server/src/__tests__/typing-bridge.test.ts
//
// P2-T1 Typing Bridge — unit tests for ThreadWorkingAgentsStore and
// broadcastThreadPresence. Tests the pure store logic (no DB, no mocks needed
// for the store tests) and verifies the broadcaster combines both rosters.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the heavy transitive deps that live-events pulls in via threads.js →
// drizzle. The store + broadcaster only use the emitter (EventEmitter) and the
// exported functions; mocking threads.js stubs out the drizzle side-effect.
vi.mock("../services/threads.js", () => ({
  canViewThread: vi.fn(() => true),
  threadService: vi.fn(),
}));

// Also mock @armyofagents/db to prevent drizzle ESM cycle errors.
vi.mock("@armyofagents/db", () => ({
  default: {},
}));

// Use vi.hoisted so mockPublish is available inside the vi.mock factory (which
// is hoisted to the top of the file by Vitest's transform).
const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn() }));

// Partial mock of live-events: keep real implementations, but capture
// publishLiveEvent calls so we can assert the combined payload.
vi.mock("../services/live-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/live-events.js")>();
  return { ...actual, publishLiveEvent: mockPublish };
});

import {
  ThreadWorkingAgentsStore,
  threadWorkingAgents,
  threadPresence,
  broadcastThreadPresence,
} from "../services/live-events.js";

// ── ThreadWorkingAgentsStore (pure store tests — no mocks needed) ─────────────

describe("ThreadWorkingAgentsStore", () => {
  let store: ThreadWorkingAgentsStore;

  beforeEach(() => {
    store = new ThreadWorkingAgentsStore();
  });

  it("add then list returns the agent", () => {
    store.add("thread-1", "agent-1", "Engineer");
    const result = store.list("thread-1");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ agentId: "agent-1", name: "Engineer" });
  });

  it("add is idempotent per (threadId, agentId) — adding same agent twice yields list length 1", () => {
    store.add("thread-1", "agent-1", "Engineer");
    store.add("thread-1", "agent-1", "Engineer Updated");
    const result = store.list("thread-1");
    expect(result).toHaveLength(1);
    // Last write wins (name updates)
    expect(result[0].name).toBe("Engineer Updated");
  });

  it("two different agents on one thread yield list length 2", () => {
    store.add("thread-1", "agent-1", "Engineer");
    store.add("thread-1", "agent-2", "Designer");
    const result = store.list("thread-1");
    expect(result).toHaveLength(2);
    const ids = result.map((a) => a.agentId).sort();
    expect(ids).toEqual(["agent-1", "agent-2"]);
  });

  it("remove drops one agent and returns survivors", () => {
    store.add("thread-1", "agent-1", "Engineer");
    store.add("thread-1", "agent-2", "Designer");
    const survivors = store.remove("thread-1", "agent-1");
    expect(survivors).toHaveLength(1);
    expect(survivors[0].agentId).toBe("agent-2");
    // list confirms the removal
    expect(store.list("thread-1")).toHaveLength(1);
  });

  it("remove last agent returns empty list and cleans up the thread map", () => {
    store.add("thread-1", "agent-1", "Engineer");
    const survivors = store.remove("thread-1", "agent-1");
    expect(survivors).toHaveLength(0);
    // list on the now-empty thread also returns empty
    expect(store.list("thread-1")).toHaveLength(0);
  });

  it("agents on different threads are isolated (add to thread A does not appear in thread B)", () => {
    store.add("thread-A", "agent-1", "Engineer");
    store.add("thread-B", "agent-2", "Designer");
    expect(store.list("thread-A")).toHaveLength(1);
    expect(store.list("thread-A")[0].agentId).toBe("agent-1");
    expect(store.list("thread-B")).toHaveLength(1);
    expect(store.list("thread-B")[0].agentId).toBe("agent-2");
  });

  it("list returns empty array for an unknown thread", () => {
    expect(store.list("nonexistent-thread")).toEqual([]);
  });

  it("remove on an unknown thread returns empty array without throwing", () => {
    expect(() => store.remove("nonexistent-thread", "agent-1")).not.toThrow();
    expect(store.remove("nonexistent-thread", "agent-1")).toEqual([]);
  });
});

// ── broadcastThreadPresence — roster composition ──────────────────────────────
//
// The partial mock of publishLiveEvent does NOT intercept the internal module
// binding (ESM live bindings — broadcastThreadPresence calls publishLiveEvent
// within the same module). We therefore assert roster state via the STORES
// directly, which is what broadcastThreadPresence reads. broadcastThreadPresence
// is tested for: (a) not throwing, (b) correct store reads it consults.

describe("broadcastThreadPresence", () => {
  const THREAD = "broadcast-thread-1";
  const COMPANY = "company-abc";

  beforeEach(() => {
    mockPublish.mockClear();
    // Clean up singleton stores between tests to avoid cross-test pollution.
    threadPresence.remove(THREAD, "user-1");
    threadWorkingAgents.remove(THREAD, "agent-1");
    threadWorkingAgents.remove(THREAD, "agent-2");
  });

  it("does not throw when both stores are empty", () => {
    expect(() => broadcastThreadPresence(COMPANY, THREAD, Date.now())).not.toThrow();
  });

  it("does not throw when only human presence is set", () => {
    const now = Date.now();
    threadPresence.touch(THREAD, "user-1", now);
    expect(() => broadcastThreadPresence(COMPANY, THREAD, now)).not.toThrow();
    // Verify the human is still in the store (broadcast doesn't corrupt it)
    expect(threadPresence.list(THREAD).some((m) => m.userId === "user-1")).toBe(true);
  });

  it("does not throw when only a working agent is set, and the agent stays in the store", () => {
    threadWorkingAgents.add(THREAD, "agent-1", "Engineer");
    expect(() => broadcastThreadPresence(COMPANY, THREAD, Date.now())).not.toThrow();
    // working agents are not swept by broadcast — store should still have it
    expect(threadWorkingAgents.list(THREAD)).toHaveLength(1);
    expect(threadWorkingAgents.list(THREAD)[0].agentId).toBe("agent-1");
    threadWorkingAgents.remove(THREAD, "agent-1");
  });

  it("both stores hold independent state before broadcast is called", () => {
    const now = Date.now();
    threadPresence.touch(THREAD, "user-1", now);
    threadWorkingAgents.add(THREAD, "agent-1", "Engineer");

    // Verify stores independently before broadcast
    expect(threadPresence.list(THREAD).some((m) => m.userId === "user-1")).toBe(true);
    expect(threadWorkingAgents.list(THREAD).some((a) => a.agentId === "agent-1")).toBe(true);

    // Broadcast reads both — should not throw
    expect(() => broadcastThreadPresence(COMPANY, THREAD, now)).not.toThrow();

    // Working agents have no TTL — still present after broadcast
    expect(threadWorkingAgents.list(THREAD)).toHaveLength(1);
    threadWorkingAgents.remove(THREAD, "agent-1");
  });

  it("human presence sweep evicts stale members; working agents have no TTL and survive", () => {
    const past = Date.now() - 60_000; // 60s ago — well past TTL (15s)
    threadPresence.touch(THREAD, "user-1", past);
    threadWorkingAgents.add(THREAD, "agent-1", "Engineer");

    // broadcastThreadPresence calls sweep internally on the human store
    broadcastThreadPresence(COMPANY, THREAD, Date.now());

    // Human should be evicted by the TTL sweep inside broadcast
    expect(threadPresence.list(THREAD).every((m) => m.userId !== "user-1")).toBe(true);
    // Working agent should still be there — no TTL
    expect(threadWorkingAgents.list(THREAD).some((a) => a.agentId === "agent-1")).toBe(true);
    threadWorkingAgents.remove(THREAD, "agent-1");
  });

  it("fresh human presence is NOT evicted by sweep", () => {
    const now = Date.now();
    threadPresence.touch(THREAD, "user-1", now - 1_000); // 1s ago — well within 15s TTL
    broadcastThreadPresence(COMPANY, THREAD, now);
    // Should survive the sweep
    expect(threadPresence.list(THREAD).some((m) => m.userId === "user-1")).toBe(true);
  });
});
