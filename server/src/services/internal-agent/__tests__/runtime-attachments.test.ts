import { describe, it, expect, vi } from "vitest";
import {
  resolveRuntimeAttachments,
  formatRuntimeAttachmentBlock,
  RUNTIME_ATTACHMENT_TEXT_BYTE_CAP,
  type RuntimeAttachmentDeps,
} from "../runtime-attachments.js";

function deps(over: Partial<RuntimeAttachmentDeps> = {}): RuntimeAttachmentDeps {
  return {
    getAsset: vi.fn(async () => null),
    readObjectText: vi.fn(async () => ({ text: "", truncated: false })),
    ...over,
  };
}

const txtAsset = {
  companyId: "co-1",
  contentType: "text/plain",
  objectKey: "k/notes.txt",
  originalFilename: "notes.txt",
  byteSize: 12,
  // Trusted provenance (round-6 #2): a validated composer upload.
  composerValidated: true,
};

describe("resolveRuntimeAttachments", () => {
  it("delivers text content for a company-owned text-readable file", async () => {
    const d = deps({
      getAsset: vi.fn(async () => txtAsset),
      readObjectText: vi.fn(async () => ({ text: "hello world", truncated: false })),
    });
    const out = await resolveRuntimeAttachments(d, "co-1", ["a1"]);
    expect(out).toEqual([
      expect.objectContaining({
        assetId: "a1",
        filename: "notes.txt",
        capability: "text-readable",
        text: "hello world",
        truncated: false,
      }),
    ]);
    expect(d.readObjectText).toHaveBeenCalledWith("co-1", "k/notes.txt", RUNTIME_ATTACHMENT_TEXT_BYTE_CAP);
  });

  it("NEVER reads bytes for a cross-company asset — it is dropped", async () => {
    const readObjectText = vi.fn(async () => ({ text: "secret", truncated: false }));
    const d = deps({
      getAsset: vi.fn(async () => ({ ...txtAsset, companyId: "other-co" })),
      readObjectText,
    });
    const out = await resolveRuntimeAttachments(d, "co-1", ["a1"]);
    expect(out).toEqual([]);
    expect(readObjectText).not.toHaveBeenCalled();
  });

  it("does not read bytes for images/other types — discloses stored-only, no content", async () => {
    const readObjectText = vi.fn(async () => ({ text: "x", truncated: false }));
    const d = deps({
      getAsset: vi.fn(async () => ({ ...txtAsset, contentType: "image/png", originalFilename: "d.png" })),
      readObjectText,
    });
    const out = await resolveRuntimeAttachments(d, "co-1", ["a1"]);
    expect(out[0]).toEqual(
      expect.objectContaining({ capability: "vision-readable", text: null }),
    );
    expect(readObjectText).not.toHaveBeenCalled();
  });

  it("skips unknown/missing asset ids", async () => {
    const out = await resolveRuntimeAttachments(deps(), "co-1", ["missing"]);
    expect(out).toEqual([]);
  });

  it("NEVER reads bytes for a non-composer-validated asset — it is dropped (round-6 #2)", async () => {
    // A namespace=files upload (unrestricted, no sniff) has composerValidated=false.
    // Even though the caller owns it, its bytes must never be decoded into a turn.
    const readObjectText = vi.fn(async () => ({ text: "spoofed payload", truncated: false }));
    const d = deps({
      getAsset: vi.fn(async () => ({ ...txtAsset, composerValidated: false })),
      readObjectText,
    });
    const out = await resolveRuntimeAttachments(d, "co-1", ["a1"]);
    expect(out).toEqual([]);
    expect(readObjectText).not.toHaveBeenCalled();
  });
});

describe("formatRuntimeAttachmentBlock", () => {
  it("returns null when there are no attachments", () => {
    expect(formatRuntimeAttachmentBlock([])).toBeNull();
  });

  it("embeds text content and discloses non-readable files honestly", () => {
    const block = formatRuntimeAttachmentBlock([
      { assetId: "a1", filename: "notes.txt", contentType: "text/plain", capability: "text-readable", text: "line one", truncated: false },
      { assetId: "a2", filename: "diagram.png", contentType: "image/png", capability: "vision-readable", text: null, truncated: false },
    ]);
    expect(block).toContain("notes.txt");
    expect(block).toContain("line one");
    // The image is disclosed, not silently implied as seen.
    expect(block).toContain("diagram.png");
    expect(block?.toLowerCase()).toMatch(/not readable|cannot|stored/);
    expect(block).not.toContain("line two");
  });

  it("marks truncated text so the model knows content was cut", () => {
    const block = formatRuntimeAttachmentBlock([
      { assetId: "a1", filename: "big.txt", contentType: "text/plain", capability: "text-readable", text: "partial", truncated: true },
    ]);
    expect(block?.toLowerCase()).toContain("truncated");
  });
});
