import { describe, it, expect } from "vitest";
import { memoryFolderCreateSchema, normalizeMemoryFolderPath } from "../memory-folder.js";

describe("memoryFolderCreateSchema", () => {
  it("accepts a valid folder", () => {
    const result = memoryFolderCreateSchema.safeParse({
      departmentId: "00000000-0000-0000-0000-000000000001",
      path: "Engineering/Decisions",
      displayName: "Decisions",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty path", () => {
    const result = memoryFolderCreateSchema.safeParse({
      departmentId: null,
      path: "",
      displayName: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects paths starting with /", () => {
    const result = memoryFolderCreateSchema.safeParse({
      departmentId: null,
      path: "/Engineering/Decisions",
      displayName: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects paths with empty segments", () => {
    const result = memoryFolderCreateSchema.safeParse({
      departmentId: null,
      path: "Engineering//Decisions",
      displayName: "x",
    });
    expect(result.success).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    const result = memoryFolderCreateSchema.safeParse({
      departmentId: null,
      path: "Engineering/../Marketing",
      displayName: "x",
    });
    expect(result.success).toBe(false);
  });
});

describe("normalizeMemoryFolderPath", () => {
  it("trims whitespace and collapses slashes", () => {
    expect(normalizeMemoryFolderPath("  Engineering / Decisions  ")).toBe("Engineering/Decisions");
  });

  it("strips trailing slashes", () => {
    expect(normalizeMemoryFolderPath("Engineering/Decisions/")).toBe("Engineering/Decisions");
  });
});
