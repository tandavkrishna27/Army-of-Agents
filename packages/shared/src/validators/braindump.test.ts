import { describe, it, expect } from "vitest";
import { submitBraindumpSchema, BRAINDUMP_CONTENT_MAX_LENGTH } from "./braindump.js";

const DEPT = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";

function parse(input: Record<string, unknown>) {
  return submitBraindumpSchema.safeParse({ idempotencyKey: "k1", ...input });
}

describe("submitBraindumpSchema", () => {
  describe("scope ↔ departmentId", () => {
    it("accepts a department capture with a departmentId", () => {
      expect(parse({ scope: "department", departmentId: DEPT, content: "hi" }).success).toBe(true);
    });

    it("accepts a company capture with departmentId null", () => {
      expect(parse({ scope: "company", departmentId: null, content: "hi" }).success).toBe(true);
    });

    it("rejects a department capture without a departmentId", () => {
      expect(parse({ scope: "department", departmentId: null, content: "hi" }).success).toBe(false);
    });

    it("rejects a company capture that carries a departmentId", () => {
      expect(parse({ scope: "company", departmentId: DEPT, content: "hi" }).success).toBe(false);
    });
  });

  describe("at-least-one-source (text OR files)", () => {
    it("accepts text-only (no assets)", () => {
      expect(parse({ scope: "company", departmentId: null, content: "some notes" }).success).toBe(true);
    });

    it("accepts FILE-ONLY — empty content with assetIds (content must not require min(1))", () => {
      const r = parse({ scope: "company", departmentId: null, content: "", assetIds: [ASSET] });
      expect(r.success).toBe(true);
    });

    it("accepts file-only when content is whitespace", () => {
      expect(parse({ scope: "department", departmentId: DEPT, content: "   ", assetIds: [ASSET] }).success).toBe(true);
    });

    it("rejects neither text nor files", () => {
      expect(parse({ scope: "company", departmentId: null, content: "   ", assetIds: [] }).success).toBe(false);
    });
  });

  it("defaults assetIds to an empty array", () => {
    const r = parse({ scope: "company", departmentId: null, content: "hi" });
    expect(r.success && r.data.assetIds).toEqual([]);
  });

  it("still enforces the content max length", () => {
    const tooLong = "x".repeat(BRAINDUMP_CONTENT_MAX_LENGTH + 1);
    expect(parse({ scope: "company", departmentId: null, content: tooLong }).success).toBe(false);
  });

  it("rejects a non-uuid assetId", () => {
    expect(parse({ scope: "company", departmentId: null, content: "hi", assetIds: ["nope"] }).success).toBe(false);
  });
});
