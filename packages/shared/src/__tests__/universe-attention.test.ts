import { describe, expect, it } from "vitest";
import { universeAttentionResponseSchema } from "../validators/universe-attention.js";

describe("Universe attention response", () => {
  it("accepts a bounded canonical projection", () => {
    expect(universeAttentionResponseSchema.parse({
      asOf: "2026-09-20T10:00:00.000Z",
      needsYou: [{
        id: "item-1",
        kind: "hub",
        sourceId: "approval-1",
        title: "Approve",
        summary: null,
        version: 1,
        sourceRef: { kind: "approval", id: "approval-1" },
        stale: false,
      }],
      ready: [],
      comingUp: [],
      nextCursor: null,
    }).needsYou).toHaveLength(1);
  });

  it("rejects executable or stale references", () => {
    const base = {
      asOf: "2026-09-20T10:00:00.000Z",
      ready: [], comingUp: [], nextCursor: null,
    };
    expect(() => universeAttentionResponseSchema.parse({
      ...base,
      needsYou: [{ id: "x", kind: "hub", sourceId: "x", title: "x", summary: null, version: 0, sourceRef: { kind: "url", id: "javascript:alert(1)" }, stale: false }],
    })).toThrow();
    expect(() => universeAttentionResponseSchema.parse({
      ...base,
      needsYou: [{ id: "x", kind: "hub", sourceId: "x", title: "x", summary: null, version: 0, sourceRef: { kind: "hub", id: "x" }, stale: true }],
    })).toThrow();
  });
});
