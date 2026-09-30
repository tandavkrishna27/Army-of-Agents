import { describe, it, expect } from "vitest";
import { createArtifactSchema, createArtifactVersionSchema, mcpArtifactVersionSchema } from "../artifact.js";

describe("artifact validators — asset-backed version fields (P1)", () => {
  it("accepts an asset-backed create payload", () => {
    expect(
      createArtifactSchema.safeParse({
        title: "Brand deck", type: "design", source: "founder",
        storageKind: "asset", assetId: "11111111-1111-1111-1111-111111111111",
        filename: "deck.pdf", contentType: "application/pdf", extension: "pdf", byteSize: 12345, sha256: "abc123",
      }).success,
    ).toBe(true);
  });

  it("rejects storageKind=asset without an assetId", () => {
    expect(createArtifactVersionSchema.safeParse({ source: "founder", storageKind: "asset" }).success).toBe(false);
  });

  it("rejects a non-enum storageKind", () => {
    expect(createArtifactVersionSchema.safeParse({ source: "agent", storageKind: "blob" }).success).toBe(false);
  });

  it("still accepts an inline (text) version with no file fields", () => {
    expect(createArtifactVersionSchema.safeParse({ source: "agent", content: "hello" }).success).toBe(true);
  });

  it("lets MCP push an asset-backed version", () => {
    expect(
      mcpArtifactVersionSchema.safeParse({
        sourceDetail: "claude-desktop", storageKind: "asset",
        assetId: "22222222-2222-2222-2222-222222222222", filename: "report.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", byteSize: 999,
      }).success,
    ).toBe(true);
  });
});
