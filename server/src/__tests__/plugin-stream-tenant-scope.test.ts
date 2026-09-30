import { describe, expect, it, vi } from "vitest";
import { createPluginStreamBus } from "../services/plugin-stream-bus.js";
import {
  createPluginStreamNotificationHandler,
  forwardPluginStreamNotification,
} from "../services/plugin-loader.js";

describe("plugin worker stream tenant wiring", () => {
  it("forwards own-company worker events to the matching SSE subscriber", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("plugin-a", "progress", "company-a", listener);

    forwardPluginStreamNotification(
      bus,
      "plugin-a",
      "company-a",
      "streams.emit",
      {
        channel: "progress",
        companyId: "company-a",
        event: { percent: 50 },
      }
    );

    expect(listener).toHaveBeenCalledWith({ percent: 50 }, "message");
  });

  it("drops a worker notification that names a foreign company", () => {
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("plugin-a", "progress", "company-b", listener);

    forwardPluginStreamNotification(
      bus,
      "plugin-a",
      "company-a",
      "streams.emit",
      {
        channel: "progress",
        companyId: "company-b",
        event: { secret: true },
      }
    );

    expect(listener).not.toHaveBeenCalled();
  });

  it("preserves worker notification order across async availability checks", async () => {
    let selectCall = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            const call = selectCall++;
            if (call === 0)
              await new Promise((resolve) => setTimeout(resolve, 5));
            return call % 2 === 0
              ? [{ companyId: "company-a", status: "ready" }]
              : [];
          },
        }),
      }),
    } as any;
    const bus = createPluginStreamBus();
    const received: string[] = [];
    bus.subscribe("plugin-a", "progress", "company-a", (_event, type) => {
      received.push(type);
    });
    const handle = createPluginStreamNotificationHandler(
      db,
      bus,
      "plugin-a",
      "company-a"
    );

    void handle("streams.open", {
      channel: "progress",
      companyId: "company-a",
    });
    void handle("streams.emit", {
      channel: "progress",
      companyId: "company-a",
      event: { n: 1 },
    });
    await handle("streams.close", {
      channel: "progress",
      companyId: "company-a",
    });

    expect(received).toEqual(["open", "message", "close"]);
  });

  it("drops a stream event when the company overlay is disabled", async () => {
    let selectCall = 0;
    const db = {
      select: () => ({
        from: () => ({
          where: async () =>
            selectCall++ === 0
              ? [{ companyId: "company-a", status: "ready" }]
              : [{ enabled: false }],
        }),
      }),
    } as any;
    const bus = createPluginStreamBus();
    const listener = vi.fn();
    bus.subscribe("plugin-a", "progress", "company-a", listener);
    const handle = createPluginStreamNotificationHandler(
      db,
      bus,
      "plugin-a",
      "company-a"
    );

    await handle("streams.emit", {
      channel: "progress",
      companyId: "company-a",
      event: { secret: true },
    });
    expect(listener).not.toHaveBeenCalled();
  });
});
