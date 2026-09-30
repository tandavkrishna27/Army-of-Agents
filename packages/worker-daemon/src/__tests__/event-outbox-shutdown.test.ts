import { describe, expect, it } from "vitest";

import {
  createEventOutboxShutdownSteps,
  createShutdownHandler,
  type EventOutboxLifecycle,
  type ShutdownStep,
} from "../lifecycle/shutdown.js";

function recordingOutbox(log: string[]): EventOutboxLifecycle {
  return {
    stopDrain() {
      log.push("stopDrain");
    },
    async flush() {
      log.push("flush");
    },
    closeStore() {
      log.push("closeStore");
    },
  };
}

describe("event-outbox shutdown ordering (WRK-006)", () => {
  it("emits steps in the exact order: stop drain → final flush → close store", () => {
    const steps = createEventOutboxShutdownSteps(recordingOutbox([]));
    expect(steps.map((s) => s.name)).toEqual(["event-outbox-stop", "event-outbox-flush", "event-outbox-close"]);
  });

  it("runs stopDrain → flush → closeStore in order under the shutdown handler", async () => {
    const log: string[] = [];
    const steps = createEventOutboxShutdownSteps(recordingOutbox(log));
    const exits: number[] = [];
    const handler = createShutdownHandler({
      steps,
      logger: { info: () => {}, error: () => {} },
      exit: (code) => exits.push(code),
    });
    await handler("SIGTERM");
    expect(log).toEqual(["stopDrain", "flush", "closeStore"]);
    expect(exits).toEqual([0]);
  });

  it("a failing step never aborts the sequence (flush throws → close still runs, exit still 0)", async () => {
    const log: string[] = [];
    const steps: ShutdownStep[] = [
      { name: "event-outbox-stop", stop: () => void log.push("stopDrain") },
      {
        name: "event-outbox-flush",
        stop: () => {
          log.push("flush");
          throw new Error("flush failed mid-shutdown");
        },
      },
      { name: "event-outbox-close", stop: () => void log.push("closeStore") },
    ];
    const exits: number[] = [];
    const handler = createShutdownHandler({
      steps,
      logger: { info: () => {}, error: () => {} },
      exit: (code) => exits.push(code),
    });
    await handler("SIGINT");
    expect(log).toEqual(["stopDrain", "flush", "closeStore"]);
    expect(exits).toEqual([0]);
  });
});
