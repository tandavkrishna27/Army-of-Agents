import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createFakeSandboxProvider,
  emitFixtureEvents,
  loadFixtureFromDir,
  validateFixture,
} from "../index.js";

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "distributed-execution",
);

describe("fixture determinism", () => {
  it("two replays of one fixture produce byte-identical ledgers and emitted events", async () => {
    const raw = await loadFixtureFromDir(FIXTURES_DIR, "batch-success");
    const provider = createFakeSandboxProvider();

    await provider.script({ providerId: "p1", fixture: raw });
    const first = await provider.replay("p1");

    provider.reset();
    await provider.script({ providerId: "p1", fixture: raw });
    const second = await provider.replay("p1");

    expect(JSON.stringify(second.invocations)).toBe(JSON.stringify(first.invocations));
    expect(JSON.stringify(second.emittedEvents)).toBe(JSON.stringify(first.emittedEvents));
    expect(first.invocations.length).toBeGreaterThan(0);
    // ledger ts + seq are reproduced exactly across replays
    expect(second.invocations.map((e) => e.ts)).toEqual(first.invocations.map((e) => e.ts));
    expect(second.invocations.map((e) => e.seq)).toEqual(first.invocations.map((e) => e.seq));
  });

  it("emitted events carry a recomputed digest that matches the fixture (byte-identical)", async () => {
    const raw = await loadFixtureFromDir(FIXTURES_DIR, "service-restart-checkpoint");
    const fixture = await validateFixture(raw);
    const emitted = emitFixtureEvents(fixture);
    expect(emitted).toEqual(fixture.expectedEvents);
  });

  it("is NON-VACUOUS: a mutated event payload recomputes to a DIFFERENT digest", async () => {
    const raw = await loadFixtureFromDir(FIXTURES_DIR, "batch-success");
    const fixture = await validateFixture(raw);
    const originalDigest = String(fixture.expectedEvents[1].eventDigest);

    // Clone and tamper with the payload of one event (no re-validation).
    const tampered = structuredClone(fixture);
    (tampered.expectedEvents[1].payload as Record<string, unknown>).detail = "TAMPERED";
    const emitted = emitFixtureEvents(tampered);

    expect(String(emitted[1].eventDigest)).not.toBe(originalDigest);
    // Every other (untouched) event still recomputes to its stored digest.
    expect(String(emitted[0].eventDigest)).toBe(String(fixture.expectedEvents[0].eventDigest));
  });

  it("replays every golden-journey fixture deterministically", async () => {
    const names = [
      "batch-success",
      "batch-cancel-during-execution",
      "browser-approval-download",
      "browser-denied-egress",
      "service-restart-checkpoint",
      "service-budget-stop",
      "service-provider-pause-resume",
      "late-output-quarantine",
      "plaintext-secret-in-argv-rejected",
    ] as const;
    for (const name of names) {
      const raw = await loadFixtureFromDir(FIXTURES_DIR, name);
      const provider = createFakeSandboxProvider();
      await provider.script({ providerId: "pp", fixture: raw });
      const a = await provider.replay("pp");
      provider.reset();
      await provider.script({ providerId: "pp", fixture: raw });
      const b = await provider.replay("pp");
      expect(JSON.stringify(b.invocations), `ledger diverged for ${name}`).toBe(JSON.stringify(a.invocations));
      expect(provider.liveResourceCount(), `residual resources for ${name}`).toBe(0);
    }
  });
});
