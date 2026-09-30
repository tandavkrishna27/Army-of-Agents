import { describe, it, expect } from "vitest";
import { buildAoaRunResultFromAdapter } from "../aoa-run-result.js";

describe("buildAoaRunResultFromAdapter — loud transport-failure", () => {
  it("marks the run FAILED when raw stdout shows Transport closed even on exit 0 + null errorMessage (the bug)", () => {
    const r = buildAoaRunResultFromAdapter(
      { exitCode: 0, errorMessage: null, resultJson: { stdout: '{"type":"error","error":"Transport closed"}', stderr: "" } },
      { mcpAttempted: true, markerSupported: true },
    );
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toMatch(/transport failed/i);
  });
  it("does NOT false-positive on a clean run (no marker, exit 0)", () => {
    const r = buildAoaRunResultFromAdapter(
      { exitCode: 0, errorMessage: null, resultJson: { stdout: '{"type":"item.completed"}', stderr: "" } },
      { mcpAttempted: true, markerSupported: true },
    );
    expect(r.status).toBe("succeeded");
  });
  it("does NOT mark gemini failed when there is no marker (unknown is not failed)", () => {
    const r = buildAoaRunResultFromAdapter(
      { exitCode: 0, errorMessage: null, resultJson: { stdout: "all good", stderr: "" } },
      { mcpAttempted: true, markerSupported: false },
    );
    expect(r.status).toBe("succeeded");
  });
  it("still fails normally on a non-zero exit (unchanged behavior)", () => {
    const r = buildAoaRunResultFromAdapter({ exitCode: 1, errorMessage: "boom" });
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toBe("boom");
  });

  it("detects a transport marker in stderr-only (not just stdout)", () => {
    const r = buildAoaRunResultFromAdapter(
      { exitCode: 0, errorMessage: null, resultJson: { stdout: "", stderr: "MCP error: Transport closed" } },
      { mcpAttempted: true, markerSupported: true },
    );
    expect(r.status).toBe("failed");
    expect(r.errorMessage).toMatch(/transport failed/i);
  });

  it("does NOT detect a gemini failure when resultJson is a parsed event object (no string stdout/stderr) — accepted gap", () => {
    // gemini sets resultJson = parsed.resultEvent (an object), so there are no string
    // stdout/stderr to scan; markerSupported:false → unknown → not failed. Documents the gap.
    const r = buildAoaRunResultFromAdapter(
      { exitCode: 0, errorMessage: null, resultJson: { type: "result", isError: false, summary: "done" } },
      { mcpAttempted: true, markerSupported: false },
    );
    expect(r.status).toBe("succeeded");
  });

  it("errs toward loud-fail: a marker anywhere in raw output fails the run (accepted v1 tradeoff)", () => {
    // DELIBERATE: favors catching real transport regressions over avoiding the rare
    // false-positive where an agent merely discusses "transport closed". Documented in
    // transport-failure.ts. A future telemetry-based anchor can tighten this.
    const r = buildAoaRunResultFromAdapter(
      { exitCode: 0, errorMessage: null, resultJson: { stdout: "agent note: the transport closed mid-call, retried", stderr: "" } },
      { mcpAttempted: true, markerSupported: true },
    );
    expect(r.status).toBe("failed");
  });
});
