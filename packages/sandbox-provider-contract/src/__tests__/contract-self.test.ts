import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createFakeSandboxProvider, LIFECYCLE_CHECKPOINTS as FAKE_CHECKPOINTS } from "@armyofagents/sandbox-fake-provider";

import {
  CORE_PROVIDER_OPERATIONS,
  OPTIONAL_PROVIDER_OPERATIONS,
  LIFECYCLE_CHECKPOINTS,
  assertContractReport,
  runSandboxProviderContract,
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

describe("contract self-check against the fake", () => {
  it("the fully-capable fake passes the entire contract", async () => {
    const report = await runSandboxProviderContract(
      () => createFakeSandboxProvider().makeDriver("contract-full"),
      { fixturesDir: FIXTURES_DIR },
    );
    expect(report.checks.length).toBeGreaterThanOrEqual(9);
    assertContractReport(report); // throws with detail on any failed check
    expect(report.passed).toBe(true);
  });

  it("a fake advertising NO optional ops still passes (negotiation branch)", async () => {
    const report = await runSandboxProviderContract(
      () => createFakeSandboxProvider().makeDriver("contract-core", { optionalOps: [] }),
      { fixturesDir: FIXTURES_DIR },
    );
    assertContractReport(report);
    expect(report.passed).toBe(true);
    // The no-optional driver advertises exactly the eight core ops.
    const driver = createFakeSandboxProvider().makeDriver("x", { optionalOps: [] });
    expect([...driver.supportedOperations()].sort()).toEqual([...CORE_PROVIDER_OPERATIONS].sort());
  });

  it("a partially-capable fake (health only) passes negotiation on all three optional ops", async () => {
    const report = await runSandboxProviderContract(
      () => createFakeSandboxProvider().makeDriver("contract-partial", { optionalOps: ["health"] }),
      {},
    );
    assertContractReport(report);
    expect(report.passed).toBe(true);
  });

  it("the fake's lifecycle-checkpoint vocabulary matches the contract's (no drift)", () => {
    expect([...FAKE_CHECKPOINTS]).toEqual([...LIFECYCLE_CHECKPOINTS]);
  });

  it("the optional-op set is exactly checkpoint/restore/health", () => {
    expect([...OPTIONAL_PROVIDER_OPERATIONS].sort()).toEqual(["checkpoint", "health", "restore"]);
  });
});
