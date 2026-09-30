import { describe, it, expect } from "vitest";
import {
  commanderOutputRefSchema,
  commanderOutputRefsSchema,
  MAX_OUTPUT_REFS_PER_MESSAGE,
  MAX_OUTPUT_REF_TITLE_LENGTH,
} from "../commander-output-refs.js";

const validRef = {
  v: 1,
  kind: "artifact",
  id: "art-123",
  versionId: "ver-456",
  versionNumber: 2,
  title: "GTM Plan",
  action: "created",
  toolCallId: null,
  mimeType: null,
};

describe("commanderOutputRefSchema", () => {
  it("accepts a valid ref", () => {
    expect(commanderOutputRefSchema.safeParse(validRef).success).toBe(true);
  });

  it("accepts minimal ref (optional fields absent)", () => {
    const minimal = { v: 1, kind: "artifact", id: "a1", action: "referenced" };
    expect(commanderOutputRefSchema.safeParse(minimal).success).toBe(true);
  });

  it("rejects unknown kind, bad action, missing id, wrong v", () => {
    expect(commanderOutputRefSchema.safeParse({ ...validRef, kind: "task" }).success).toBe(false);
    expect(commanderOutputRefSchema.safeParse({ ...validRef, action: "made" }).success).toBe(false);
    expect(commanderOutputRefSchema.safeParse({ ...validRef, id: "" }).success).toBe(false);
    expect(commanderOutputRefSchema.safeParse({ ...validRef, v: 2 }).success).toBe(false);
  });

  it("rejects title over the cap", () => {
    const long = { ...validRef, title: "x".repeat(MAX_OUTPUT_REF_TITLE_LENGTH + 1) };
    expect(commanderOutputRefSchema.safeParse(long).success).toBe(false);
  });

  it("accepts title of EXACTLY MAX_OUTPUT_REF_TITLE_LENGTH chars", () => {
    const exact = { ...validRef, title: "x".repeat(MAX_OUTPUT_REF_TITLE_LENGTH) };
    expect(commanderOutputRefSchema.safeParse(exact).success).toBe(true);
  });

  it("array schema rejects > MAX refs", () => {
    const tooMany = Array.from({ length: MAX_OUTPUT_REFS_PER_MESSAGE + 1 }, () => validRef);
    expect(commanderOutputRefsSchema.safeParse(tooMany).success).toBe(false);
    expect(commanderOutputRefsSchema.safeParse([validRef]).success).toBe(true);
  });

  it("array schema accepts EXACTLY MAX_OUTPUT_REFS_PER_MESSAGE refs", () => {
    const exact = Array.from({ length: MAX_OUTPUT_REFS_PER_MESSAGE }, () => validRef);
    expect(commanderOutputRefsSchema.safeParse(exact).success).toBe(true);
  });

  it("bounds on new string fields: id/versionId/toolCallId/mimeType capped at 256", () => {
    // id of 257 chars fails
    expect(commanderOutputRefSchema.safeParse({ ...validRef, id: "x".repeat(257) }).success).toBe(false);
    // versionId of "" fails (min(1) when not null)
    expect(commanderOutputRefSchema.safeParse({ ...validRef, versionId: "" }).success).toBe(false);
    // versionId of null passes (nullish allows null)
    expect(commanderOutputRefSchema.safeParse({ ...validRef, versionId: null }).success).toBe(true);
  });
});
