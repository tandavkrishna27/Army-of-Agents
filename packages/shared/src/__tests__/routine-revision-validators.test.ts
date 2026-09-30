import { describe, expect, it } from "vitest";
import {
  updateRoutineSchema,
  restoreRoutineRevisionSchema,
} from "../validators/routine.js";

describe("updateRoutineSchema with baseRevisionId", () => {
  it("accepts a valid baseRevisionId UUID", () => {
    const result = updateRoutineSchema.safeParse({
      title: "New title",
      baseRevisionId: "12345678-1234-4234-8234-123456789abc",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-UUID baseRevisionId", () => {
    const result = updateRoutineSchema.safeParse({
      title: "New title",
      baseRevisionId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a patch without baseRevisionId (backward compat)", () => {
    const result = updateRoutineSchema.safeParse({ title: "New title" });
    expect(result.success).toBe(true);
  });

  it("accepts null to guard an initial routine revision", () => {
    const result = updateRoutineSchema.safeParse({ title: "New title", baseRevisionId: null });
    expect(result.success).toBe(true);
  });
});

describe("restoreRoutineRevisionSchema", () => {
  it("accepts a valid revisionId UUID", () => {
    const result = restoreRoutineRevisionSchema.safeParse({
      revisionId: "12345678-1234-4234-8234-123456789abc",
      baseRevisionId: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing revisionId", () => {
    const result = restoreRoutineRevisionSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID revisionId", () => {
    const result = restoreRoutineRevisionSchema.safeParse({ revisionId: "not-a-uuid", baseRevisionId: null });
    expect(result.success).toBe(false);
  });

  it("rejects null revisionId", () => {
    const result = restoreRoutineRevisionSchema.safeParse({ revisionId: null, baseRevisionId: null });
    expect(result.success).toBe(false);
  });

  it("accepts an omitted baseRevisionId for backward compatibility", () => {
    const result = restoreRoutineRevisionSchema.safeParse({
      revisionId: "12345678-1234-4234-8234-123456789abc",
    });
    expect(result.success).toBe(true);
  });
});
