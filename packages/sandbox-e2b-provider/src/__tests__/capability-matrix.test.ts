import { describe, expect, it } from "vitest";

import { CORE_PROVIDER_OPERATIONS, OPTIONAL_PROVIDER_OPERATIONS } from "@armyofagents/worker-protocol";

import { CLI_001_CAPABILITY_MATRIX } from "../capability-matrix.js";

// -----------------------------------------------------------------------------
// D5 — the capability-matrix lint. No REQUIRED isolation/fencing/TTL/kill/inspect/
// cleanup case may be marked unsupported; only the genuinely-optional
// checkpoint/restore/health ops may be unsupported, and only with a fallback.
// -----------------------------------------------------------------------------

const OPTIONAL = new Set<string>(OPTIONAL_PROVIDER_OPERATIONS.map(String));

describe("D5 — capability-matrix disposition lint", () => {
  it("every core provider operation is present and supported (never unsupported)", () => {
    for (const op of CORE_PROVIDER_OPERATIONS) {
      const row = CLI_001_CAPABILITY_MATRIX.operations.find((o) => o.operation === op);
      expect(row, `core op ${op} missing from the matrix`).toBeDefined();
      expect(row?.required, `core op ${op} must be required`).toBe(true);
      expect(row?.supported, `core op ${op} must not be marked unsupported`).toBe(true);
    }
  });

  it("no REQUIRED operation is marked unsupported", () => {
    for (const row of CLI_001_CAPABILITY_MATRIX.operations) {
      if (row.required) expect(row.supported, `required op ${row.operation} marked unsupported`).toBe(true);
    }
  });

  it("only optional ops may be unsupported, and only WITH a recorded fallback", () => {
    for (const row of CLI_001_CAPABILITY_MATRIX.operations) {
      if (row.supported) continue;
      expect(OPTIONAL.has(row.operation), `non-optional op ${row.operation} marked unsupported`).toBe(true);
      expect(typeof row.fallback === "string" && row.fallback.length > 0, `unsupported op ${row.operation} lacks a fallback`).toBe(true);
    }
  });

  it("every isolation/fencing/TTL/kill/inspect/cleanup case is required AND supported", () => {
    expect(CLI_001_CAPABILITY_MATRIX.isolationCases.length).toBe(8);
    for (const c of CLI_001_CAPABILITY_MATRIX.isolationCases) {
      expect(c.required, `isolation case ${c.id} must be required`).toBe(true);
      expect(c.supported, `isolation case ${c.id} must not be marked unsupported`).toBe(true);
    }
  });

  it("the provider-control surface is pinned (template/image/policy/limits)", () => {
    const { pins } = CLI_001_CAPABILITY_MATRIX;
    expect(pins.templateId.length).toBeGreaterThan(0);
    expect(pins.image.length).toBeGreaterThan(0);
    expect(pins.policyVersion.length).toBeGreaterThan(0);
    expect(pins.limits.defaultTtlMs).toBeGreaterThan(0);
    expect(pins.limits.maxTtlMs).toBeGreaterThanOrEqual(pins.limits.defaultTtlMs);
    expect(pins.limits.maxConcurrentSandboxes).toBeGreaterThan(0);
  });
});
