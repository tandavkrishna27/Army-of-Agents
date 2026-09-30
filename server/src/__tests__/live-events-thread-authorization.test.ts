import { describe, expect, it, vi } from "vitest";
import {
  ThreadSubscriptionRegistry,
  ThreadPresenceStore,
} from "../services/live-events.js";
import {
  startSocketAuthorizationCheck,
  subscribeToAuthorizedThread,
  touchAuthorizedThreadPresence,
} from "../realtime/live-events-ws.js";

describe("live-events client thread authorization", () => {
  it("does not register or broadcast a foreign-company thread", async () => {
    const registry = new ThreadSubscriptionRegistry<object>();
    const connection = {};
    const presence = new ThreadPresenceStore();
    const threadCompany = new Map<string, string>();
    const broadcast = vi.fn();
    const foreignThreadId = "thread-company-b";

    const subscribed = await subscribeToAuthorizedThread({
      registry,
      connection,
      threadId: foreignThreadId,
      authorize: async () => false,
    });
    expect(subscribed).toBe(false);
    expect(registry.isSubscribed(foreignThreadId, connection)).toBe(false);

    // Defense in depth for an already-poisoned/legacy registry entry: presence
    // revalidates before touching the global roster or combining working agents.
    registry.subscribe(foreignThreadId, connection);
    const touched = await touchAuthorizedThreadPresence({
      registry,
      connection,
      threadId: foreignThreadId,
      actorId: "user-company-a",
      companyId: "company-a",
      typing: true,
      now: Date.now(),
      authorize: async () => false,
      threadCompany,
      touch: (threadId, actorId, now, typing) =>
        presence.touch(threadId, actorId, now, typing),
      broadcast,
    });
    expect(touched).toBe(false);
    expect(presence.list(foreignThreadId)).toEqual([]);
    expect(threadCompany.has(foreignThreadId)).toBe(false);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects a conflicting company mapping before presence mutation", async () => {
    const registry = new ThreadSubscriptionRegistry<object>();
    const connection = {};
    const presence = new ThreadPresenceStore();
    const threadCompany = new Map([["thread-b", "company-b"]]);
    const broadcast = vi.fn();
    registry.subscribe("thread-b", connection);

    const touched = await touchAuthorizedThreadPresence({
      registry,
      connection,
      threadId: "thread-b",
      actorId: "user-a",
      companyId: "company-a",
      typing: false,
      now: Date.now(),
      authorize: async () => true,
      threadCompany,
      touch: (threadId, actorId, now, typing) =>
        presence.touch(threadId, actorId, now, typing),
      broadcast,
    });

    expect(touched).toBe(false);
    expect(presence.list("thread-b")).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("serializes authorization rechecks per socket", async () => {
    const socket = {};
    const inFlight = new Set<object>();
    let resolveCheck!: () => void;
    const check = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCheck = resolve;
        })
    );

    expect(startSocketAuthorizationCheck(socket, inFlight, check)).toBe(true);
    expect(startSocketAuthorizationCheck(socket, inFlight, check)).toBe(false);
    expect(check).toHaveBeenCalledOnce();
    resolveCheck();
    await Promise.resolve();
    await Promise.resolve();
    expect(inFlight.has(socket)).toBe(false);
    expect(startSocketAuthorizationCheck(socket, inFlight, check)).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });
});
