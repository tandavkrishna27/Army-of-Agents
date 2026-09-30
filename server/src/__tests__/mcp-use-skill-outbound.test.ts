import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(
  resolve(__dirname, "../mcp/tools/index.ts"),
  "utf8",
);

describe("outbound MCP: use_skill tool", () => {
  it("exports or registers use_skill in the outbound tool index", () => {
    expect(src).toContain("use_skill");
  });

  it("includes skill key parameter in schema", () => {
    // The tool must accept a 'key' parameter (e.g. 'skill:aoa/brainstorm')
    expect(src).toContain('"key"');
  });

  it("allowlists both board and commander actors for use_skill", () => {
    // Contract: the HTTP MCP dispatch gate (mcp/server.ts) reads toolAllowedActors
    // and returns 403 to any actor not in the list. "board" = founder sessions.
    // "commander" is pre-wiring/hardening for the HTTP MCP path — Commander's CLI
    // bridge dispatches via tool-registry (executeTool) and does NOT consult this
    // map, so adding "commander" here does not fix a live Commander 403; it hardens
    // the HTTP endpoint against future direct calls. Worker agents + mcp remain
    // excluded (skill markdown may contain company IP).
    // (Source-string style mirrors the assertions above; importing
    // toolAllowedActors directly would pull drizzle handlers / cause cycles.)
    const match = src.match(/"use_skill":\s*(\[[^\]]*\])/);
    expect(match).not.toBeNull();
    const allowlist = match![1];
    expect(allowlist).toContain('"board"');
    expect(allowlist).toContain('"commander"');
  });
});
