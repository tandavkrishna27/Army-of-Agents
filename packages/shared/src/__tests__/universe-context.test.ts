import { describe, expect, it } from "vitest";
import { universeContextSchema } from "../validators/universe-context.js";

const C = "10000000-0000-4000-8000-000000000001";
const A = "20000000-0000-4000-8000-000000000001";
const V = "30000000-0000-4000-8000-000000000001";

describe("universeContextSchema", () => {
  it("accepts a bounded versioned context snapshot", () => {
    expect(universeContextSchema.parse({
      schemaVersion: 1,
      conversationId: C,
      selected: { kind: "artifact", id: A, versionId: V },
      visible: [{ kind: "artifact", id: A, versionId: V }],
      viewport: { width: 1440, height: 900, x: 0, y: 0, zoom: 1 },
    }).selected).toEqual({ kind: "artifact", id: A, versionId: V });
  });

  it("rejects invalid references, non-finite viewports, and excess fan-out", () => {
    const base = {
      schemaVersion: 1 as const,
      conversationId: C,
      selected: null,
      viewport: { width: 1440, height: 900, x: 0, y: 0, zoom: 1 },
    };
    expect(() => universeContextSchema.parse({ ...base, visible: [{ kind: "task", id: "not-a-uuid" }] })).toThrow();
    expect(() => universeContextSchema.parse({ ...base, visible: [], viewport: { ...base.viewport, zoom: 0 } })).toThrow();
    expect(() => universeContextSchema.parse({ ...base, visible: Array.from({ length: 21 }, () => ({ kind: "task", id: A })) })).toThrow();
  });

  it("rejects unknown fields that could smuggle authority", () => {
    expect(() => universeContextSchema.parse({
      schemaVersion: 1,
      conversationId: C,
      selected: null,
      visible: [],
      viewport: { width: 1, height: 1, x: 0, y: 0, zoom: 1 },
      execute: true,
    })).toThrow();
  });
});
