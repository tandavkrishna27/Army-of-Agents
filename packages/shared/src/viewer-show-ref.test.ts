import { describe, it, expect } from "vitest";
import { showRefSchema, showRefsSchema, SHOW_REF_KINDS } from "./viewer-show-ref.js";
import type { ShowRef } from "./viewer-show-ref.js";

describe("showRefSchema", () => {
  it("accepts a legacy v:1 artifact ref unchanged", () => {
    const legacy = { v: 1, kind: "artifact", id: "a1", action: "created" };
    expect(showRefSchema.safeParse(legacy).success).toBe(true);
  });

  it("accepts a v:2 ref with expanded kind + provenance", () => {
    const ref: ShowRef = {
      v: 2,
      kind: "discussion",
      id: "d1",
      title: "Q3 planning",
      viewerKind: "markdown",
      action: "referenced",
      provenance: {
        surface: "commander",
        entityId: "conv-1",
        seq: 3,
        emittedAt: "2026-07-18T10:00:00.000Z",
      },
    };
    expect(showRefSchema.safeParse(ref).success).toBe(true);
  });

  it("requires action on a v:2 ref", () => {
    const noAction = { v: 2, kind: "task", id: "t1" };
    expect(showRefSchema.safeParse(noAction).success).toBe(false);
  });

  it("exposes the full v:2 kind set", () => {
    expect([...SHOW_REF_KINDS]).toEqual([
      "artifact", "asset", "output", "task", "discussion", "approval", "memory_item", "url",
    ]);
  });

  it("rejects an unknown kind", () => {
    expect(showRefSchema.safeParse({ v: 2, kind: "nope", id: "x", action: "created" }).success).toBe(false);
  });

  it("rejects a v:2 ref whose provenance is missing required fields", () => {
    const bad = { v: 2, kind: "task", id: "t1", action: "created", provenance: { surface: "commander" } };
    expect(showRefSchema.safeParse(bad).success).toBe(false);
  });

  it("caps arrays at 20", () => {
    const one = { v: 2, kind: "artifact", id: "a", action: "created" };
    expect(showRefsSchema.safeParse(Array(21).fill(one)).success).toBe(false);
    expect(showRefsSchema.safeParse(Array(20).fill(one)).success).toBe(true);
  });
});
