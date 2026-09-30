import { describe, it, expect } from "vitest";
import { detectTransportFailure } from "../transport-failure.js";

describe("detectTransportFailure", () => {
  it("flags Transport closed from raw stderr", () => {
    expect(detectTransportFailure({ parsedErrorMessages: [], rawStdout: "", rawStderr: "MCP error: Transport closed" }).failed).toBe(true);
  });
  it("flags from a parsed event message", () => {
    expect(detectTransportFailure({ parsedErrorMessages: ["every AoA MCP call failed with Transport closed"], rawStdout: "", rawStderr: "" }).failed).toBe(true);
  });
  it("flags codex's rmcp transport read/parse error (broken-bridge signature)", () => {
    const stderr = "rmcp::transport::async_rw: Error reading from stream: serde error expected ',' or ']' at line 1 column 4";
    expect(detectTransportFailure({ parsedErrorMessages: [], rawStdout: "", rawStderr: stderr, mcpAttempted: true, markerSupported: true }).failed).toBe(true);
  });
  it("does NOT flag a legitimate tool isError", () => {
    expect(detectTransportFailure({ parsedErrorMessages: ["Tool execution error: validation failed"], rawStdout: "", rawStderr: "" }).failed).toBe(false);
  });
  it("returns unknown when there is no marker at all but MCP was used without a clean marker (gemini)", () => {
    const r = detectTransportFailure({ parsedErrorMessages: [], rawStdout: "", rawStderr: "", mcpAttempted: true, markerSupported: false });
    expect(r).toEqual({ failed: false, status: "unknown" });
  });
  it("does NOT flag when mcpAttempted is false (claude path is exempt — never uses the bridge)", () => {
    expect(
      detectTransportFailure({ parsedErrorMessages: ["the transport closed"], rawStdout: "", rawStderr: "Transport closed", mcpAttempted: false }).failed,
    ).toBe(false);
  });
});
