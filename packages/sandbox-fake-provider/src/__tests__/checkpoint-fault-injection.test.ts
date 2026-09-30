import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LIFECYCLE_CHECKPOINTS,
  createFakeSandboxProvider,
  loadFixtureFromDir,
  validateFixture,
  type LifecycleCheckpoint,
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

describe("per-checkpoint fault injection", () => {
  it("injects a fault at EACH of the eight lifecycle checkpoints, deterministically", async () => {
    const raw = await loadFixtureFromDir(FIXTURES_DIR, "batch-cancel-during-execution");
    const fixture = await validateFixture(raw);
    const effect = fixture.failureInjection?.effect ?? "cancel_requested";

    for (const point of LIFECYCLE_CHECKPOINTS as readonly LifecycleCheckpoint[]) {
      const provider = createFakeSandboxProvider();
      await provider.script({
        providerId: "fp",
        fixture: raw,
        includeAllCheckpoints: true,
        failureInjection: { point, effect },
      });
      const result = await provider.replay("fp");

      // The fault fired exactly once, at the requested checkpoint, with the effect.
      expect(result.faultInjected, `no fault fired at ${point}`).toBe(true);
      expect(result.effect).toBe(effect);
      const faulted = result.invocations.filter((e) => e.faultInjected);
      expect(faulted, `expected exactly one faulted op at ${point}`).toHaveLength(1);
      expect(faulted[0].checkpoint).toBe(point);
      // Teardown still reconciles → zero live resources even after the fault.
      expect(provider.liveResourceCount("fp"), `residual resources after fault at ${point}`).toBe(0);
    }
  });

  it("is deterministic: two runs with the same injection produce identical ledgers", async () => {
    const raw = await loadFixtureFromDir(FIXTURES_DIR, "batch-cancel-during-execution");
    const injection = { point: "crash" as LifecycleCheckpoint, effect: "worker_process_crash" };

    const provider = createFakeSandboxProvider();
    await provider.script({ providerId: "fp", fixture: raw, includeAllCheckpoints: true, failureInjection: injection });
    const a = await provider.replay("fp");
    provider.reset();
    await provider.script({ providerId: "fp", fixture: raw, includeAllCheckpoints: true, failureInjection: injection });
    const b = await provider.replay("fp");

    expect(JSON.stringify(b.invocations)).toBe(JSON.stringify(a.invocations));
  });

  it("is NON-VACUOUS: with no injection, NO ledger entry is flagged faultInjected", async () => {
    const raw = await loadFixtureFromDir(FIXTURES_DIR, "batch-cancel-during-execution");
    const provider = createFakeSandboxProvider();
    await provider.script({ providerId: "fp", fixture: raw, includeAllCheckpoints: true });
    const result = await provider.replay("fp");
    expect(result.faultInjected).toBe(false);
    expect(result.invocations.some((e) => e.faultInjected)).toBe(false);
  });

  it("rejects a failureInjection whose point is not a lifecycle checkpoint", async () => {
    const raw = await loadFixtureFromDir(FIXTURES_DIR, "batch-success");
    const provider = createFakeSandboxProvider();
    await expect(
      provider.script({
        providerId: "fp",
        fixture: raw,
        failureInjection: { point: "running" as LifecycleCheckpoint, effect: "x" },
      }),
    ).rejects.toThrow(/lifecycle checkpoint/);
  });
});
