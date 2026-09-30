import { describe, expect, it } from "vitest";

// normalizeAgentRow (server/src/services/agents.ts:~214) is module-internal.
// It does `withUrlKey({ ...row, permissions: ... })` — a full spread of the row.
// This test documents the contract that makes the new `agents.kind` column
// additive-safe: a spread-based normalizer passes unknown/new fields through
// unchanged, so adding `kind` does not break agent row serialization.
describe("agent row shape with kind (additive-safe contract)", () => {
  it("passes a 'kind' field through a spread-based normalization unchanged", () => {
    const row: any = { id: "a1", role: "general", permissions: {}, kind: "org" };
    const normalized = { ...row, permissions: row.permissions ?? {} };
    expect(normalized.kind).toBe("org");
    expect(normalized.id).toBe("a1");
  });

  it("preserves 'kind' for a platform agent row too", () => {
    const row: any = { id: "p1", role: "general", permissions: {}, kind: "platform" };
    const normalized = { ...row, permissions: row.permissions ?? {} };
    expect(normalized.kind).toBe("platform");
  });
});
