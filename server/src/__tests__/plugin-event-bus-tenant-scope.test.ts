import { describe, expect, it, vi } from "vitest";
import { createPluginEventBus } from "../services/plugin-event-bus.js";

function coreEvent(companyId: string) {
  return {
    eventId: crypto.randomUUID(),
    eventType: "issue.created" as const,
    companyId,
    occurredAt: new Date().toISOString(),
    actorType: "user" as const,
    actorId: "user-1",
    entityType: "issue" as const,
    entityId: "issue-1",
    payload: {},
  };
}

describe("plugin event bus tenant scope", () => {
  it("isolates same-key subscriptions by plugin row and company", async () => {
    const bus = createPluginEventBus();
    const pluginA = bus.forPlugin("plugin-row-a", "acme.shared", "company-a");
    const pluginB = bus.forPlugin("plugin-row-b", "acme.shared", "company-b");
    const handlerA = vi.fn(async () => {});
    const handlerB = vi.fn(async () => {});
    pluginA.subscribe("issue.created", handlerA);
    pluginB.subscribe("issue.created", handlerB);

    await bus.emit(coreEvent("company-a"));

    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).not.toHaveBeenCalled();

    pluginA.clear();
    await bus.emit(coreEvent("company-b"));
    expect(handlerB).toHaveBeenCalledTimes(1);
    expect(bus.subscriptionCount("plugin-row-a")).toBe(0);
    expect(bus.subscriptionCount("plugin-row-b")).toBe(1);
  });

  it("keeps the manifest key as the public emitted namespace", async () => {
    const bus = createPluginEventBus();
    const pluginA = bus.forPlugin("plugin-row-a", "acme.shared", "company-a");
    const observer = bus.forPlugin("observer-row", "observer", "company-a");
    const handler = vi.fn(async () => {});
    observer.subscribe("plugin.acme.shared.done", handler);

    await pluginA.emit("done", "company-a", { ok: true });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin.acme.shared.done",
        companyId: "company-a",
        actorId: "acme.shared",
      })
    );
  });
});
