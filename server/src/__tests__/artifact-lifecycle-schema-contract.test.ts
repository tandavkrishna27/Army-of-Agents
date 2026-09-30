import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type DrizzleJournal = {
  entries: Array<{ tag: string }>;
};

type DrizzleSnapshot = {
  tables: Record<
    string,
    {
      columns: Record<string, unknown>;
      indexes: Record<string, unknown>;
      foreignKeys: Record<string, unknown>;
    }
  >;
};

function latestSnapshot(): DrizzleSnapshot {
  const metaDir = join(__dirname, "../../../packages/db/src/migrations/meta");
  const journal = JSON.parse(
    readFileSync(join(metaDir, "_journal.json"), "utf8"),
  ) as DrizzleJournal;
  const latest = journal.entries.at(-1);
  if (!latest) throw new Error("No Drizzle migrations found");
  return JSON.parse(
    readFileSync(join(metaDir, `${latest.tag.split("_")[0]}_snapshot.json`), "utf8"),
  ) as DrizzleSnapshot;
}

describe("artifact_versions file metadata schema", () => {
  const artifactVersions = latestSnapshot().tables["public.artifact_versions"];

  it("has additive file metadata columns", () => {
    expect(Object.keys(artifactVersions.columns)).toEqual(
      expect.arrayContaining([
        "storage_kind",
        "asset_id",
        "filename",
        "content_type",
        "extension",
        "byte_size",
        "sha256",
      ]),
    );
  });

  it("preserves existing version columns", () => {
    expect(Object.keys(artifactVersions.columns)).toEqual(
      expect.arrayContaining([
        "id",
        "artifact_id",
        "version_number",
        "source",
        "content",
        "file_url",
      ]),
    );
  });

  it("indexes and constrains the optional asset reference", () => {
    expect(Object.keys(artifactVersions.indexes)).toContain("artifact_versions_asset_idx");
    expect(Object.keys(artifactVersions.foreignKeys)).toContain(
      "artifact_versions_asset_id_assets_id_fk",
    );
  });
});
