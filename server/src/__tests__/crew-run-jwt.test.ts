import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createLocalAgentJwt, verifyLocalAgentJwt } from "../agent-auth-jwt.js";

describe("crew run-JWT (U3)", () => {
  it("mints and verifies a per-run agent JWT with the crew claim shape", () => {
    // AOA_AGENT_JWT_SECRET must be set for jwtConfig() to return non-null.
    process.env.AOA_AGENT_JWT_SECRET = "test-secret-at-least-32-chars-long-xx";
    const token = createLocalAgentJwt("agent-123", "co-abc", "claude_local", "run-xyz");
    expect(token).not.toBeNull();
    const claims = verifyLocalAgentJwt(token!);
    expect(claims).toMatchObject({ sub: "agent-123", company_id: "co-abc", run_id: "run-xyz" });
  });

  it("runner.ts no longer hard-codes an undefined crew auth token", () => {
    const runnerPath = resolve(
      __dirname,
      "../services/internal-agent/aoa-agents/runner.ts",
    );
    const source = readFileSync(runnerPath, "utf8");

    // The literal `authToken: undefined,` in the adapter.execute({...}) block
    // must be gone — the crew path now mints a real run-JWT (mirroring the
    // org/heartbeat path) instead of passing a hardcoded undefined identity.
    expect(source).not.toMatch(/authToken:\s*undefined/);

    // The mint must be wired via createLocalAgentJwt (imported + referenced).
    expect(source).toMatch(/createLocalAgentJwt/);
  });
});
