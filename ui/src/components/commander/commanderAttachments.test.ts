import { describe, expect, it } from "vitest";
import {
  COMPOSER_MAX_ATTACHMENT_BYTES,
} from "@armyofagents/shared";
import {
  attachmentCapability,
  assetResponseToCommanderInputRef,
  validateCommanderAttachmentFiles,
} from "./commanderAttachments";

describe("Commander attachments", () => {
  it("assigns explicit runtime capabilities", () => {
    expect(attachmentCapability("text/plain")).toBe("text-readable");
    expect(attachmentCapability("image/png")).toBe("vision-readable");
    expect(attachmentCapability("application/pdf")).toBe("stored-only");
  });
  it("accepts supported files within the shared count and size limits", () => {
    const image = new File(["image"], "launch.png", { type: "image/png" });
    const pdf = new File(["pdf"], "brief.pdf", { type: "application/pdf" });

    expect(validateCommanderAttachmentFiles([image, pdf], 0)).toEqual({
      accepted: [image, pdf],
      errors: [],
    });
  });

  it("rejects unsupported, empty, oversized, and over-count files", () => {
    const unsupported = new File(["x"], "sheet.csv", { type: "text/csv" });
    const empty = new File([], "empty.txt", { type: "text/plain" });
    const oversized = new File(
      [new Uint8Array(COMPOSER_MAX_ATTACHMENT_BYTES + 1)],
      "huge.pdf",
      { type: "application/pdf" },
    );

    const result = validateCommanderAttachmentFiles(
      [unsupported, empty, oversized],
      4,
    );
    expect(result.accepted).toEqual([]);
    expect(result.errors).toContain("Attach up to 5 files per message.");
    expect(result.errors).toContain("Unsupported attachment type: text/csv.");
  });

  it("creates a typed asset input ref for Commander submission context", () => {
    expect(assetResponseToCommanderInputRef({
      assetId: "asset-1",
      companyId: "company-1",
      provider: "local",
      objectKey: "asset-key",
      contentType: "application/pdf",
      byteSize: 2048,
      sha256: "hash",
      originalFilename: "launch-plan.pdf",
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      contentPath: "/api/assets/asset-1/content",
    }, "fallback.pdf")).toMatchObject({
      kind: "asset",
      id: "asset-1",
      label: "launch-plan.pdf",
      route: "/api/assets/asset-1/content",
      source: "commander-upload",
      detail: "contentType=application/pdf | byteSize=2048 | capability=stored-only",
    });
  });
});
