import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Regression guard for Sprint 2A Commit 2: the internal-agent loop must
// route ALL traffic through cli-mode.ts, never through the API-mode
// providers. The providers/ module is intentionally kept as an internal
// util for extraction + embeddings, but agent-loop.ts must not touch it.
// See docs/superpowers/specs/2026-04-24-sprint-2a-drop-api-adapters-design.md
describe("agent-loop dispatch after Sprint 2A", () => {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const agentLoopPath = resolve(
    thisDir,
    "../services/internal-agent/agent-loop.ts",
  );
  const source = readFileSync(agentLoopPath, "utf8");

  it("agent-loop.ts does not import from ./providers/", () => {
    // The providers/ module stays (extraction.ts + embeddings.ts use it)
    // but agent-loop.ts must not — it always dispatches through cli-mode.
    expect(source).not.toMatch(/from ["']\.\/providers\//);
    expect(source).not.toMatch(/from ["']\.\/providers["']/);
  });

  it("agent-loop.ts does not reference createProvider or getProviderApiKey", () => {
    // These are the provider SDK entry points. The CLI-mode path does
    // not need them.
    expect(source).not.toContain("createProvider");
    expect(source).not.toContain("getProviderApiKey");
  });

  it("agent-loop.ts still imports cliModeService (the only execution path)", () => {
    expect(source).toMatch(/cliModeService/);
  });

  it("agent-loop.ts does not branch on executionMode === \"api\"", () => {
    // If any branch says `executionMode === "api"`, the API dispatch
    // path still exists and the refactor is incomplete.
    expect(source).not.toMatch(/executionMode\s*===\s*["']api["']/);
  });
});
