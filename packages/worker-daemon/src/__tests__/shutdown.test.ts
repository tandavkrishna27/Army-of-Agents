import { describe, expect, it, vi } from "vitest";

import { createShutdownHandler, type ShutdownStep } from "../lifecycle/shutdown.js";

function silentLogger() {
  return { info: vi.fn(), error: vi.fn() };
}

describe("createShutdownHandler", () => {
  it("runs ordered steps exactly once under two concurrent signals", async () => {
    const order: string[] = [];
    const steps: ShutdownStep[] = [
      { name: "leasing", stop: () => void order.push("leasing") },
      { name: "drain", stop: async () => void order.push("drain") },
      { name: "health-server", stop: async () => void order.push("health-server") },
    ];
    const exit = vi.fn();
    const handler = createShutdownHandler({ steps, logger: silentLogger(), exit });

    await Promise.all([handler("SIGINT"), handler("SIGTERM")]);

    // Each step ran once, in registration order.
    expect(order).toEqual(["leasing", "drain", "health-server"]);
    // Exit happened exactly once despite two competing signals.
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("returns the same in-flight promise for a repeated signal", async () => {
    const exit = vi.fn();
    const handler = createShutdownHandler({
      steps: [{ name: "only", stop: async () => {} }],
      logger: silentLogger(),
      exit,
    });
    const first = handler("SIGINT");
    const second = handler("SIGINT");
    expect(first).toBe(second);
    await first;
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("still reaches process exit when a step throws", async () => {
    const ran: string[] = [];
    const logger = silentLogger();
    const exit = vi.fn();
    const handler = createShutdownHandler({
      steps: [
        { name: "leasing", stop: () => void ran.push("leasing") },
        {
          name: "drain",
          stop: async () => {
            throw new Error("drain blew up");
          },
        },
        { name: "health-server", stop: () => void ran.push("health-server") },
      ],
      logger,
      exit,
    });

    await handler("SIGTERM");

    // A failing step does not abort the sequence, and exit still runs.
    expect(ran).toEqual(["leasing", "health-server"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    // The failure was logged, not swallowed silently.
    expect(logger.error).toHaveBeenCalled();
  });

  it("invokes the optional flush before exit", async () => {
    const events: string[] = [];
    const handler = createShutdownHandler({
      steps: [{ name: "health-server", stop: () => void events.push("stop") }],
      logger: silentLogger(),
      exit: () => void events.push("exit"),
      flush: async () => void events.push("flush"),
    });
    await handler("SIGINT");
    expect(events).toEqual(["stop", "flush", "exit"]);
  });
});
