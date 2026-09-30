import { describe, expect, it } from "vitest";

import {
  assertContractReport,
  assertIsolationReport,
  runSandboxIsolationConformance,
  runSandboxProviderContract,
  type SandboxProviderDriver,
} from "@armyofagents/sandbox-provider-contract";

import { E2bSandboxProvider } from "../e2b-provider.js";
import { MockE2bTransport } from "../mock-transport.js";
import { perOpToInvokeDriver } from "../per-op-adapter.js";

// -----------------------------------------------------------------------------
// D3 — BOTH certified conformance suites run GREEN against the REAL E2B driver
// logic over the deterministic, key-less mock transport, through the E6-F008
// adapter. This is the no-key core's central proof: the driver's protocol
// behaviour (op routing, denial throws, redaction, idempotent cleanup, TTL-shape,
// monotonic convergence) is validated with NO key and NO network.
// -----------------------------------------------------------------------------

// Thread ONE destroy-retry ceiling into BOTH the adapter and the isolation suite,
// so §2.4(c)'s bounded-ceiling assertion can never pass by coincidence.
const CEIL = 3;

const makeDriver = (): SandboxProviderDriver =>
  perOpToInvokeDriver(new E2bSandboxProvider({ transport: new MockE2bTransport() }), {
    providerId: "e2b-conformance",
    maxDestroyAttempts: CEIL,
  });

describe("CLI-001/D3 — E2B driver (mock transport) passes the DEP-000 happy-path contract", () => {
  it("all nine contract checks pass", async () => {
    const report = await runSandboxProviderContract(makeDriver, {});
    assertContractReport(report); // throws with detail on any failure
    expect(report.passed).toBe(true);
    // 8 core checks + optional-negotiation; golden-corpus check is skipped (no dir).
    expect(report.checks.length).toBe(8);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });
});

describe("CLI-001/D3 — E2B driver (mock transport) passes the DEP-008 hostile isolation suite", () => {
  it("all eight isolation invariants pass", async () => {
    const report = await runSandboxIsolationConformance(makeDriver, { maxDestroyAttempts: CEIL });
    assertIsolationReport(report); // throws with detail on any failure
    expect(report.passed).toBe(true);
    expect(report.checks.length).toBe(8);
    expect(report.checks.every((c) => c.ok)).toBe(true);
  });
});
