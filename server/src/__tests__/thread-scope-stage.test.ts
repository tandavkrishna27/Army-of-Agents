import { describe, expect, it } from "vitest";
import { deriveThreadStage } from "../services/thread-scope-versions.js";

describe("deriveThreadStage", () => {
  it("returns live for live threads", () => {
    expect(deriveThreadStage({ subtype: "live", status: "active", entrySeq: 4, latest: null })).toMatchObject({
      stage: "live",
      label: "Live intake",
    });
  });

  it("returns discussing v1 before any scope version", () => {
    expect(deriveThreadStage({ subtype: "normal", status: "active", entrySeq: 2, latest: null })).toMatchObject({
      stage: "discussing",
      versionNumber: 1,
      label: "Discussing v1",
    });
  });

  it("returns scoping for a draft", () => {
    expect(deriveThreadStage({
      subtype: "normal",
      status: "active",
      entrySeq: 2,
      latest: { id: "sv1", versionNumber: 1, status: "draft", sourceEndSeq: 2, appliedItemCount: 0 },
    })).toMatchObject({ stage: "scoping", label: "Scoping v1" });
  });

  it("returns discussing next version when new entries arrive after completion", () => {
    expect(deriveThreadStage({
      subtype: "normal",
      status: "active",
      entrySeq: 7,
      latest: { id: "sv1", versionNumber: 1, status: "completed", sourceEndSeq: 5, appliedItemCount: 2 },
    })).toMatchObject({
      stage: "discussing",
      versionNumber: 2,
      hasNewEntries: true,
      newEntryCount: 2,
      label: "Discussing v2",
    });
  });

  it("derives an un-scoped discussing stage for a rejected latest version", () => {
    // Defect (i): a rejected version must not render as an active "Scoped vN"
    // and must not expose its scopeVersionId.
    const result = deriveThreadStage({
      subtype: "normal",
      status: "active",
      entrySeq: 2,
      latest: { id: "sv-rejected", versionNumber: 1, status: "rejected", sourceEndSeq: 2, appliedItemCount: 0 },
    });

    expect(result).toMatchObject({
      stage: "discussing",
      versionNumber: 2,
      label: "Discussing v2",
      scopeVersionId: null,
    });
    expect(result.scopeVersionId).toBeNull();
  });

  it("flags new entries on a rejected version when the thread advanced past it", () => {
    const result = deriveThreadStage({
      subtype: "normal",
      status: "active",
      entrySeq: 5,
      latest: { id: "sv-rejected", versionNumber: 1, status: "rejected", sourceEndSeq: 2, appliedItemCount: 0 },
    });

    expect(result).toMatchObject({
      stage: "discussing",
      scopeVersionId: null,
      hasNewEntries: true,
      newEntryCount: 3,
    });
  });
});
