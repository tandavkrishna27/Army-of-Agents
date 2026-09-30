import { describe, it, expect } from "vitest";
import {
  humanToolSummary,
  truncateForWire,
  TOOL_SUMMARY_CAP,
} from "../services/internal-agent/tool-summary.js";

describe("humanToolSummary", () => {
  it("extracts the envelope .summary for mcp tools (not raw JSON)", () => {
    const envelope = JSON.stringify({
      success: true,
      data: { artifactId: "a1" },
      summary: "Created artifact \"Launch Plan Q3\"",
      outputRefs: [{ v: 1, kind: "artifact", id: "a1", action: "created" }],
    });
    expect(humanToolSummary("mcp__aoa__create_artifact", envelope)).toBe(
      'Created artifact "Launch Plan Q3"',
    );
  });

  it("falls through to truncated raw when an mcp payload is not an envelope", () => {
    expect(humanToolSummary("mcp__aoa__weird", "not json at all")).toBe("not json at all");
  });

  it("passes non-mcp tool output through verbatim (no envelope parse)", () => {
    // A built-in tool's output is NOT an envelope, even if it happens to be JSON
    // with a `summary` key — only mcp__ names are envelope-parsed.
    const looksLikeEnvelope = JSON.stringify({ summary: "should be ignored" });
    expect(humanToolSummary("Bash", looksLikeEnvelope)).toBe(looksLikeEnvelope);
  });

  it("truncates over-cap text with an ellipsis", () => {
    const long = "a".repeat(TOOL_SUMMARY_CAP + 50);
    const out = humanToolSummary("Read", long);
    expect(out.length).toBe(TOOL_SUMMARY_CAP + 1); // cap chars + "…"
    expect(out.endsWith("…")).toBe(true);
  });

  it("truncateForWire leaves short text untouched", () => {
    expect(truncateForWire("short")).toBe("short");
  });
});
