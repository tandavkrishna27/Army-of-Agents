import { describe, expect, it } from "vitest";
import type { ArtifactVersion, ArtifactWithVersions } from "@armyofagents/shared";
import {
  assetUrlForArtifactVersion,
  contentTypeForArtifactVersion,
  filenameForArtifactVersion,
} from "../artifact-version-viewer";

const artifact = {
  id: "artifact-1",
  title: "Uploaded report",
  type: "document",
} as ArtifactWithVersions;

function version(overrides: Partial<ArtifactVersion>): ArtifactVersion {
  return {
    id: "version-1",
    artifactId: "artifact-1",
    versionNumber: 1,
    source: "founder",
    sourceDetail: null,
    changelog: null,
    parentVersionId: null,
    content: null,
    fileUrl: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("artifact version viewer helpers", () => {
  it("renders asset-backed versions through the assets content route", () => {
    const assetVersion = version({
      storageKind: "asset",
      assetId: "asset-1",
      filename: "brief.pdf",
      contentType: "application/pdf",
    });

    expect(assetUrlForArtifactVersion(assetVersion)).toBe("/api/assets/asset-1/content");
    expect(filenameForArtifactVersion(artifact, assetVersion)).toBe("brief.pdf");
    expect(contentTypeForArtifactVersion(artifact, assetVersion)).toBe("application/pdf");
  });

  it("falls back to inline content without an asset url", () => {
    const inlineVersion = version({
      storageKind: "inline",
      content: "# Notes",
    });

    expect(assetUrlForArtifactVersion(inlineVersion)).toBeNull();
    expect(contentTypeForArtifactVersion(artifact, inlineVersion)).toBe("text/markdown");
  });
});
