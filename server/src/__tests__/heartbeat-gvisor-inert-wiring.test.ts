import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const heartbeatSource = readFileSync(
  fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)),
  "utf8",
);

describe("cloud gVisor worker-plane activation boundary", () => {
  it("converts a routed target with the resolved trust boundary before adapter execution", () => {
    const conversionIndex = heartbeatSource.indexOf("executionTargetToAdapterConfig(");
    const trustBoundaryIndex = heartbeatSource.indexOf(
      'hbTopology.trustBoundary === "multi_tenant"',
      conversionIndex,
    );
    const adapterExecutionIndex = heartbeatSource.indexOf("resolveGuardedAdapterExecutionContext(", conversionIndex);

    expect(conversionIndex).toBeGreaterThan(-1);
    expect(trustBoundaryIndex).toBeGreaterThan(conversionIndex);
    expect(adapterExecutionIndex).toBeGreaterThan(trustBoundaryIndex);
  });
});
