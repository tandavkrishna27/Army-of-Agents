/**
 * MIG-005 — the Commander turn's shadow observation.
 *
 * Two halves, tested two ways:
 *   CONTENT  — `buildCommanderTurnShadowInput` is pure, so its record is asserted
 *              directly rather than through a mocked spawn surface.
 *   PLACEMENT — a source contract test, because the seam sits inside a long generator
 *              whose position relative to the target resolution and the D1 gate is the
 *              property that matters and is not observable from the return value.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildCommanderTurnShadowInput } from "../services/internal-agent/cli-mode.js";

const BASE = {
  companyId: "co-1",
  userId: "u-1",
  userRole: "founder",
  runId: "turn-1",
  conversationId: "conv-1",
  cliTool: "claude",
  model: "claude-sonnet",
  executionTargetType: "provider-sandbox",
};

describe("MIG-005 content — the Commander turn snapshot", () => {
  it("carries the turn's own identity and no fabricated task fields", () => {
    const input = buildCommanderTurnShadowInput(BASE);
    expect(input.source).toEqual({
      kind: "commander_turn",
      internalAgentRunId: "turn-1",
      conversationId: "conv-1",
    });
    // The FROZEN commander_turn variant is `.strict()`: a runId/issueId here would be
    // refused outright, and CM-007 forbids inventing them regardless.
    expect(input.source).not.toHaveProperty("runId");
    expect(input.source).not.toHaveProperty("issueId");
    expect(input.source).not.toHaveProperty("assigneeAgentId");
  });

  it("records the RESOLVED target", () => {
    expect(buildCommanderTurnShadowInput(BASE).routing.executionTargetType).toBe(
      "provider-sandbox",
    );
  });

  it("records `local` when Commander runs host-direct, rather than an absence", () => {
    // Self-hosted Commander spawns on the host. That IS the legacy routing, so the
    // record should say so; a null would read as "unknown" and pollute the evidence.
    const input = buildCommanderTurnShadowInput({ ...BASE, executionTargetType: null });
    expect(input.routing.executionTargetType).toBe("local");
  });

  it("carries the acting user as the principal — commander_turn admits no agent", () => {
    expect(buildCommanderTurnShadowInput(BASE).principal).toEqual({
      kind: "user",
      id: "u-1",
      role: "founder",
    });
  });

  it("does not invent a completion policy for something that is not a task", () => {
    const input = buildCommanderTurnShadowInput(BASE);
    expect(input.policy.effectiveCompletionPolicy).toBe("not_applicable");
    expect(input.policy.budgetPolicyId).toBeNull();
    expect(input.policy.model).toBe("claude-sonnet");
  });

  it("characterizes the workload as the CLI the turn will actually spawn", () => {
    expect(buildCommanderTurnShadowInput({ ...BASE, cliTool: "codex" }).workloadCharacterization)
      .toMatchObject({ command: "codex", args: [] });
  });
});

const SRC = readFileSync(
  fileURLToPath(new URL("../services/internal-agent/cli-mode.ts", import.meta.url)),
  "utf8",
);

describe("MIG-005 placement — where the observation sits in the turn", () => {
  it("records exactly once", () => {
    expect(SRC.match(/recordDistributedShadow\(/g) ?? []).toHaveLength(1);
  });

  it("is guarded by params.runId — a turn with no run has no identity to record", () => {
    expect(SRC).toMatch(/if \(params\.runId\) \{\s*await recordDistributedShadow\(/);
  });

  it("sits AFTER the sandbox context resolves, so the recorded target is real", () => {
    const resolveAt = SRC.indexOf("commanderSandbox = await resolveCommanderSandboxContext(");
    const shadowAt = SRC.indexOf("await recordDistributedShadow(");
    expect(resolveAt).toBeGreaterThan(-1);
    expect(shadowAt).toBeGreaterThan(resolveAt);
  });

  it("passes the RESOLVED target into the snapshot, not a literal", () => {
    // A mutation pass caught this: the content tests call the builder directly, and the
    // placement tests only checked ordering, so the seam could have stopped reading
    // `commanderSandbox` entirely and every test would still pass. The builder being
    // correct is worth nothing if the caller feeds it a constant.
    expect(SRC).toMatch(
      /executionTargetType:\s*commanderSandbox\?\.executionTarget\.type \?\? null,/,
    );
  });

  it("sits BEFORE the D1 execution gate, so the record is the intent not the outcome", () => {
    const shadowAt = SRC.indexOf("await recordDistributedShadow(");
    const gateAt = SRC.indexOf("// 4. D1 multi-tenant unsandboxed execution gate");
    expect(gateAt).toBeGreaterThan(-1);
    expect(shadowAt).toBeLessThan(gateAt);
  });
});
