import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("work-question continuation scheduler wiring", () => {
  const source = readFileSync(resolve(__dirname, "../index.ts"), "utf8");

  it("prevents overlapping continuation ticks within one server process", () => {
    expect(source).toContain("workQuestionContinuationTickInFlight");
    expect(source).toMatch(/if \(!workQuestionContinuationTickInFlight\)/);
    expect(source).toContain("workQuestionContinuationTickInFlight = true");
    expect(source).toContain("workQuestionContinuationTickInFlight = false");
    expect(source).toMatch(/workQuestionContinuations\s*\.processDue\(now\)/);
  });

  it("keeps durable question workers outside the heartbeat scheduler gate", () => {
    const heartbeatGate = source.indexOf("if (config.heartbeatSchedulerEnabled)");
    const workerSetup = source.indexOf("const workQuestionContinuations");
    const workerInterval = source.indexOf("setInterval(() => tickWorkQuestionWorkers(), config.heartbeatSchedulerIntervalMs)");
    expect(heartbeatGate).toBeGreaterThan(-1);
    expect(workerSetup).toBeGreaterThan(-1);
    expect(workerInterval).toBeGreaterThan(-1);
    expect(workerSetup).toBeLessThan(heartbeatGate);
    expect(workerInterval).toBeLessThan(heartbeatGate);
  });
});
