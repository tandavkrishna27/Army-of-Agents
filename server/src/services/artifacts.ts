import { eq, desc, and, ne } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { artifacts, artifactVersions, issues, assets } from "@armyofagents/db";
import { badRequest } from "../errors.js";

/** Tenant isolation: an asset backing a version must belong to the same company. */
async function assertAssetOwned(db: Pick<Db, "select">, companyId: string, assetId: string | null | undefined) {
  if (!assetId) return;
  const [row] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.companyId, companyId)));
  if (!row) throw badRequest("assetId does not belong to this company");
}

function storageKindForVersion(storageKind: string | null | undefined, assetId: string | null | undefined) {
  return assetId ? "asset" : (storageKind ?? "inline");
}

/** Fetch artifact row + its versions (newest first) */
async function fetchWithVersions(db: Db, artifactId: string) {
  const artifact = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.id, artifactId))
    .then((rows) => rows[0] ?? null);
  if (!artifact) return null;

  const versions = await db
    .select()
    .from(artifactVersions)
    .where(eq(artifactVersions.artifactId, artifactId))
    .orderBy(desc(artifactVersions.versionNumber));

  return { ...artifact, versions };
}

export function artifactService(db: Db) {
  return {
    list: async (companyId: string, opts?: { includeArchived?: boolean }) => {
      const where = opts?.includeArchived
        ? eq(artifacts.companyId, companyId)
        : and(eq(artifacts.companyId, companyId), ne(artifacts.status, "archived"));
      return db.select().from(artifacts).where(where).orderBy(desc(artifacts.updatedAt));
    },

    getById: async (id: string) => {
      return fetchWithVersions(db, id);
    },

    create: async (
      companyId: string,
      createdById: string,
      data: {
        title: string;
        description?: string | null;
        type: string;
        source?: string;
        sourceDetail?: string | null;
        changelog?: string | null;
        content?: string | null;
        fileUrl?: string | null;
        sourceActionId?: string | null;
        storageKind?: string | null;
        assetId?: string | null;
        filename?: string | null;
        contentType?: string | null;
        extension?: string | null;
        byteSize?: number | null;
        sha256?: string | null;
      },
    ) => {
      const {
        source, sourceDetail, changelog, content, fileUrl, sourceActionId,
        storageKind, assetId, filename, contentType, extension, byteSize, sha256,
        ...artifactData
      } = data;

      await assertAssetOwned(db, companyId, assetId);

      return db.transaction(async (tx) => {
        const [artifact] = await tx
          .insert(artifacts)
          .values({ ...artifactData, companyId, createdById, sourceActionId: sourceActionId ?? null })
          .returning();

        if (source) {
          const [version] = await tx
            .insert(artifactVersions)
            .values({
              artifactId: artifact.id,
              versionNumber: 1,
              source,
              sourceDetail: sourceDetail ?? null,
              changelog: changelog ?? null,
              content: content ?? null,
              fileUrl: fileUrl ?? null,
              storageKind: storageKindForVersion(storageKind, assetId),
              assetId: assetId ?? null,
              filename: filename ?? null,
              contentType: contentType ?? null,
              extension: extension ?? null,
              byteSize: byteSize ?? null,
              sha256: sha256 ?? null,
            })
            .returning();

          const [updated] = await tx
            .update(artifacts)
            .set({ currentVersionId: version.id, updatedAt: new Date() })
            .where(eq(artifacts.id, artifact.id))
            .returning();

          return { ...updated, versions: [version] };
        }

        return { ...artifact, versions: [] };
      });
    },

    update: async (
      id: string,
      data: {
        title?: string;
        description?: string | null;
        type?: string;
        status?: string;
      },
    ) => {
      return db
        .update(artifacts)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(artifacts.id, id))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    /** Soft-archive active artifacts only, so unarchive never promotes drafts. */
    archive: async (id: string) => {
      const [updated] = await db
        .update(artifacts)
        .set({ status: "archived", updatedAt: new Date() })
        .where(and(eq(artifacts.id, id), eq(artifacts.status, "active")))
        .returning();
      if (updated) return updated;

      const [existing] = await db
        .select({ status: artifacts.status })
        .from(artifacts)
        .where(eq(artifacts.id, id));
      if (existing && existing.status !== "active") {
        throw badRequest("Only active artifacts can be archived");
      }

      return null;
    },

    /** Reverse archive only from archived state, so direct calls never promote drafts. */
    unarchive: async (id: string) => {
      const [updated] = await db
        .update(artifacts)
        .set({ status: "active", updatedAt: new Date() })
        .where(and(eq(artifacts.id, id), eq(artifacts.status, "archived")))
        .returning();
      if (updated) return updated;

      const [existing] = await db
        .select({ status: artifacts.status })
        .from(artifacts)
        .where(eq(artifacts.id, id));
      if (existing && existing.status !== "archived") {
        throw badRequest("Only archived artifacts can be unarchived");
      }

      return null;
    },

    addVersion: async (
      artifactId: string,
      data: {
        source: string;
        sourceDetail?: string | null;
        changelog?: string | null;
        parentVersionId?: string | null;
        content?: string | null;
        fileUrl?: string | null;
        storageKind?: string | null;
        assetId?: string | null;
        filename?: string | null;
        contentType?: string | null;
        extension?: string | null;
        byteSize?: number | null;
        sha256?: string | null;
      },
    ) => {
      if (data.assetId) {
        const [art] = await db.select({ companyId: artifacts.companyId }).from(artifacts).where(eq(artifacts.id, artifactId));
        if (!art) throw badRequest("artifact not found");
        await assertAssetOwned(db, art.companyId, data.assetId);
      }

      return db.transaction(async (tx) => {
        // Branching guard: a supplied parentVersionId MUST belong to THIS
        // artifact. The FK only constrains it to *some* artifact_versions row,
        // so without this check a caller could branch off (and re-point
        // currentVersionId at) a version owned by another artifact — or another
        // company. Same-artifact enforces same-company transitively because the
        // route scopes the artifact by company before reaching here.
        if (data.parentVersionId) {
          const [parent] = await tx
            .select({ artifactId: artifactVersions.artifactId })
            .from(artifactVersions)
            .where(eq(artifactVersions.id, data.parentVersionId));
          if (!parent || parent.artifactId !== artifactId) {
            throw badRequest("parentVersionId does not belong to this artifact");
          }
        }

        // Read max version inside transaction for atomicity
        const existing = await tx
          .select({ versionNumber: artifactVersions.versionNumber })
          .from(artifactVersions)
          .where(eq(artifactVersions.artifactId, artifactId))
          .orderBy(desc(artifactVersions.versionNumber))
          .limit(1);

        const nextVersion = existing.length > 0 ? existing[0].versionNumber + 1 : 1;

        const [version] = await tx
          .insert(artifactVersions)
          .values({
            artifactId,
            versionNumber: nextVersion,
            source: data.source,
            sourceDetail: data.sourceDetail ?? null,
            changelog: data.changelog ?? null,
            parentVersionId: data.parentVersionId ?? null,
            content: data.content ?? null,
            fileUrl: data.fileUrl ?? null,
            storageKind: storageKindForVersion(data.storageKind, data.assetId),
            assetId: data.assetId ?? null,
            filename: data.filename ?? null,
            contentType: data.contentType ?? null,
            extension: data.extension ?? null,
            byteSize: data.byteSize ?? null,
            sha256: data.sha256 ?? null,
          })
          .returning();

        await tx
          .update(artifacts)
          .set({ currentVersionId: version.id, updatedAt: new Date() })
          .where(eq(artifacts.id, artifactId));

        return version;
      });
    },

    /** Returns { companyId } for the issue, or null if issue not found */
    getIssueCompanyId: async (issueId: string) => {
      return db
        .select({ companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
    },

    getByIssueId: async (issueId: string) => {
      const issue = await db
        .select({ artifactId: issues.artifactId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      if (!issue?.artifactId) return null;

      return fetchWithVersions(db, issue.artifactId);
    },
  };
}
