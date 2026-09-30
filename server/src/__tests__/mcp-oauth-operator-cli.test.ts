import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const TSX = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const FORCE_EXPIRY = fileURLToPath(
  new URL("../../../scripts/force-mcp-oauth-expiry.ts", import.meta.url),
);
const ROLLBACK = fileURLToPath(
  new URL("../../../scripts/rollback-mcp-oauth-v2.ts", import.meta.url),
);

function run(script: string, args: string[]) {
  return spawnSync(process.execPath, [TSX, script, ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
    timeout: 15_000,
  });
}

describe("MCP OAuth operator CLI safety", () => {
  it("provides offline help for both commands", () => {
    const force = run(FORCE_EXPIRY, ["--help"]);
    const rollback = run(ROLLBACK, ["--help"]);

    expect(force.status).toBe(0);
    expect(force.stdout).toContain("--expected-version=<n>");
    expect(rollback.status).toBe(0);
    expect(rollback.stdout).toContain("--company-id=<uuid>|--all-companies");
  });

  it("rejects ambiguous rollback scope before database access", () => {
    const result = run(ROLLBACK, [
      "--company-id=11111111-1111-4111-8111-111111111111",
      "--all-companies",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Choose exactly one scope");
  });

  it("requires explicit destructive confirmations before database access", () => {
    const force = run(FORCE_EXPIRY, [
      "11111111-1111-4111-8111-111111111112",
      "--company-id=11111111-1111-4111-8111-111111111111",
      "--expected-version=1",
      "--apply",
      "--confirm=wrong",
    ]);
    const rollback = run(ROLLBACK, [
      "--company-id=11111111-1111-4111-8111-111111111111",
      "--apply",
      "--confirm=ROLLBACK-MCP-OAUTH-V2",
    ]);

    expect(force.status).toBe(1);
    expect(force.stderr).toContain("--confirm=FORCE-OAUTH-EXPIRY");
    expect(rollback.status).toBe(1);
    expect(rollback.stderr).toContain("--backup-confirmed");
  });

  it("requires the active instance identity for fleet rollback", () => {
    const result = run(ROLLBACK, [
      "--all-companies",
      "--instance-id=wrong-instance",
      "--apply",
      "--confirm=wrong-instance",
      "--backup-confirmed",
      "--maintenance-confirmed",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must exactly match the active AOA instance");
  });
});
