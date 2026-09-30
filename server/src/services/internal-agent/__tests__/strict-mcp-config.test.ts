import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * D2 invariant: every Claude argv AoA constructs that passes --mcp-config MUST
 * also pass --strict-mcp-config. Without it the CLI additionally loads the host
 * machine's ~/.claude.json and project .mcp.json (and claude.ai connectors).
 */
function assertStrictWhenConfigured(args: string[]) {
  if (args.includes("--mcp-config")) {
    expect(args).toContain("--strict-mcp-config");
  }
}

describe("strict mcp config invariant", () => {
  it("holds for an argv that pairs the two flags", () => {
    assertStrictWhenConfigured(["--mcp-config", "/tmp/x.json", "--strict-mcp-config", "--print"]);
  });

  it("throws for an argv that omits the strict flag", () => {
    expect(() => assertStrictWhenConfigured(["--mcp-config", "/tmp/x.json"])).toThrow();
  });
});

/**
 * The crew argv is built inside runAoaAgent (needs a full DB-backed run to
 * invoke), so — mirroring claude-not-bridged.test.ts — we assert the real
 * construction at the source level: the claude-family branch must place
 * "--strict-mcp-config" immediately after cfgPath. The Commander builder is
 * covered against its real code path in cli-invocation-stdin.test.ts.
 */
describe("crew runner argv pairs --mcp-config with --strict-mcp-config (D2)", () => {
  it("injects --strict-mcp-config right after cfgPath in the claude-family branch", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const runnerPath = resolve(here, "../aoa-agents/runner.ts");
    const src = readFileSync(runnerPath, "utf8");
    // Task 12: AoA's own prefix — --mcp-config cfgPath followed IMMEDIATELY by
    // --strict-mcp-config — is prepended into the ADAPTER-PREFERRED arg key
    // (`[argKey]`, which is `extraArgs` when the founder set one, else `args`;
    // see execute.ts preference). Only the user tail from that same key is
    // sanitized (stripUserMcpArgs) to close the escape hatch; AoA's prefix never
    // traverses the sanitizer. This asserts the strict flag sits right after
    // cfgPath in that construction.
    expect(src).toContain('[argKey]: ["--mcp-config", cfgPath, "--strict-mcp-config", ...stripUserMcpArgs(userTail)]');
  });
});
