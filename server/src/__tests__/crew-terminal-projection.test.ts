// server/src/__tests__/crew-terminal-projection.test.ts — MIG-006 slice 2.
//
// The crew distributed-terminal projection: the PURE vocabulary/patch translation that maps the
// heartbeat-shaped projector output onto internal_agent_runs columns, and the STRUCTURAL assertion
// that index.ts actually COMPOSES the projection into onAttemptTerminal (the "a projection nobody
// calls is not a projection" check — the projector machinery itself is unit-tested elsewhere).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  crewRunStatusForProjection,
  crewRunTerminalPatch,
} from "../services/internal-agent/aoa-agents/crew-terminal-projection.js";

describe("crewRunStatusForProjection — heartbeat→internal_agent_runs status vocabulary", () => {
  it("maps succeeded → completed (internal_agent_runs uses 'completed', not 'succeeded')", () => {
    expect(crewRunStatusForProjection("succeeded")).toBe("completed");
  });
  it("passes failed/cancelled through unchanged", () => {
    expect(crewRunStatusForProjection("failed")).toBe("failed");
    expect(crewRunStatusForProjection("cancelled")).toBe("cancelled");
  });
});

describe("crewRunTerminalPatch — heartbeat_runs patch → internal_agent_runs columns", () => {
  it("translates finishedAt/error/usageJson and derives costCents from costUsd (*100, rounded)", () => {
    const finishedAt = new Date("2026-09-19T00:00:00Z");
    expect(
      crewRunTerminalPatch({
        finishedAt,
        error: "boom",
        usageJson: { inputTokens: 10, outputTokens: 20, costUsd: 1.25, durationMs: 5000 },
      }),
    ).toEqual({
      completedAt: finishedAt,
      errorMessage: "boom",
      tokenUsage: { inputTokens: 10, outputTokens: 20 },
      costCents: 125,
      durationMs: 5000,
    });
  });

  it("maps absent fields to null (never a 1-second/NaN trap)", () => {
    expect(crewRunTerminalPatch({})).toEqual({
      completedAt: null,
      errorMessage: null,
      tokenUsage: null,
      costCents: null,
      durationMs: null,
    });
  });

  it("null costUsd yields null costCents (not 0)", () => {
    expect(
      crewRunTerminalPatch({ usageJson: { costUsd: null, inputTokens: 3, outputTokens: 4, durationMs: 100 } }).costCents,
    ).toBeNull();
  });
});

const INDEX_SRC = readFileSync(
  path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "index.ts"),
  "utf8",
);

describe("crew terminal projection wiring — structural (MIG-006 slice 2)", () => {
  it("index.ts composes createCrewAttemptTerminalProjection into the attempt-terminal projection", () => {
    expect(INDEX_SRC).toContain("createCrewAttemptTerminalProjection");
    expect(INDEX_SRC).toContain("projectCrewAttemptTerminal");
  });
});
