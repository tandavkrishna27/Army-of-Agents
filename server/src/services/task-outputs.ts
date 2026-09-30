import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agents,
  artifacts,
  artifactVersions,
  assets,
  executionWorkspaces,
  heartbeatRuns,
  issues,
  taskOutputs,
  workspaceRuntimeServices,
} from "@armyofagents/db";
import type { MutableTaskOutput, UpsertTaskOutput } from "@armyofagents/shared";
import { notFound } from "../errors.js";

type TaskOutputRow = typeof taskOutputs.$inferSelect;
type TaskOutputInsert = typeof taskOutputs.$inferInsert;
type TaskOutputDb = Pick<Db, "select" | "insert" | "update" | "transaction">;

function normalizedInsert(
  companyId: string,
  projectId: string | null,
  issueId: string,
  input: UpsertTaskOutput,
): TaskOutputInsert {
  return {
    companyId,
    projectId,
    issueId,
    type: input.type,
    provider: input.provider ?? "aoa",
    externalId: input.externalId ?? null,
    artifactId: input.artifactId ?? null,
    artifactVersionId: input.artifactVersionId ?? null,
    assetId: input.assetId ?? null,
    executionWorkspaceId: input.executionWorkspaceId ?? null,
    runtimeServiceId: input.runtimeServiceId ?? null,
    url: input.url ?? null,
    title: input.title,
    status: input.status ?? "active",
    reviewState: input.reviewState ?? "none",
    isPrimary: input.isPrimary ?? false,
    healthStatus: input.healthStatus ?? "unknown",
    summary: input.summary ?? null,
    metadata: input.metadata ?? null,
    createdByRunId: input.createdByRunId ?? null,
    createdByAgentId: input.createdByAgentId ?? null,
    createdByUserId: input.createdByUserId ?? null,
  };
}

async function getIssueForCompany(db: TaskOutputDb, companyId: string, issueId: string) {
  return db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
}

async function clearSiblingPrimaries(
  db: TaskOutputDb,
  companyId: string,
  issueId: string,
) {
  await db
    .update(taskOutputs)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(and(eq(taskOutputs.companyId, companyId), eq(taskOutputs.issueId, issueId)));
}

async function assertCompanyOwnedRef(
  db: TaskOutputDb,
  table: { id: unknown; companyId: unknown },
  id: string | null | undefined,
  companyId: string,
  label: string,
) {
  if (!id) return;
  const ownedTable = table as {
    id: Parameters<typeof eq>[0];
  };
  const row = await db
    .select()
    .from(table as never)
    .where(eq(ownedTable.id, id))
    .then((rows) => rows[0] as { id: string; companyId: string } | undefined);
  if (!row || row.companyId !== companyId) throw notFound(`${label} not found`);
}

async function assertArtifactVersionRef(
  db: TaskOutputDb,
  input: UpsertTaskOutput,
  companyId: string,
) {
  if (!input.artifactVersionId) return;
  const version = await db
    .select({ id: artifactVersions.id, artifactId: artifactVersions.artifactId })
    .from(artifactVersions)
    .where(eq(artifactVersions.id, input.artifactVersionId))
    .then((rows) => rows[0] as { id: string; artifactId: string } | undefined);
  if (!version) throw notFound("Artifact version not found");
  if (input.artifactId && input.artifactId !== version.artifactId) {
    throw notFound("Artifact version not found");
  }
  await assertCompanyOwnedRef(db, artifacts, version.artifactId, companyId, "Artifact version");
}

async function assertTaskOutputRefs(
  db: TaskOutputDb,
  companyId: string,
  input: UpsertTaskOutput,
) {
  await assertCompanyOwnedRef(db, artifacts, input.artifactId, companyId, "Artifact");
  await assertArtifactVersionRef(db, input, companyId);
  await assertCompanyOwnedRef(db, assets, input.assetId, companyId, "Asset");
  await assertCompanyOwnedRef(db, executionWorkspaces, input.executionWorkspaceId, companyId, "Execution workspace");
  await assertCompanyOwnedRef(db, workspaceRuntimeServices, input.runtimeServiceId, companyId, "Runtime service");
  await assertCompanyOwnedRef(db, heartbeatRuns, input.createdByRunId, companyId, "Heartbeat run");
  await assertCompanyOwnedRef(db, agents, input.createdByAgentId, companyId, "Agent");
}

export function taskOutputService(db: Db) {
  const serviceDb = db as TaskOutputDb;

  return {
    listForIssue: async (companyId: string, issueId: string): Promise<TaskOutputRow[]> => {
      return serviceDb
        .select()
        .from(taskOutputs)
        .where(and(eq(taskOutputs.companyId, companyId), eq(taskOutputs.issueId, issueId)))
        .orderBy(desc(taskOutputs.updatedAt));
    },

    getById: async (companyId: string, id: string): Promise<TaskOutputRow | null> => {
      return serviceDb
        .select()
        .from(taskOutputs)
        .where(and(eq(taskOutputs.id, id), eq(taskOutputs.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
    },

    upsertForIssue: async (
      companyId: string,
      issueId: string,
      input: UpsertTaskOutput,
    ): Promise<TaskOutputRow> => {
      return serviceDb.transaction(async (tx) => {
        const scopedDb = tx as TaskOutputDb;
        const issue = await getIssueForCompany(scopedDb, companyId, issueId);
        if (!issue) throw notFound("Task not found");

        const values = normalizedInsert(companyId, issue.projectId, issueId, input);
        await assertTaskOutputRefs(scopedDb, companyId, input);
        if (values.isPrimary) {
          await clearSiblingPrimaries(scopedDb, companyId, issueId);
        }

        if (values.externalId) {
          const provider = values.provider ?? "aoa";
          const existing = await scopedDb
            .select()
            .from(taskOutputs)
            .where(
              and(
                eq(taskOutputs.companyId, companyId),
                eq(taskOutputs.issueId, issueId),
                eq(taskOutputs.provider, provider),
                eq(taskOutputs.externalId, values.externalId),
              ),
            )
            .then((rows) => rows[0] ?? null);

          if (existing) {
            const [updated] = await scopedDb
              .update(taskOutputs)
              .set({ ...values, updatedAt: new Date() })
              .where(and(eq(taskOutputs.id, existing.id), eq(taskOutputs.companyId, companyId)))
              .returning();
            return updated;
          }
        }

        const [created] = await scopedDb
          .insert(taskOutputs)
          .values(values)
          .returning();
        return created;
      });
    },

    updateMutable: async (
      companyId: string,
      id: string,
      input: MutableTaskOutput,
    ): Promise<TaskOutputRow | null> => {
      return serviceDb.transaction(async (tx) => {
        const scopedDb = tx as TaskOutputDb;
        const existing = await scopedDb
          .select()
          .from(taskOutputs)
          .where(and(eq(taskOutputs.id, id), eq(taskOutputs.companyId, companyId)))
          .then((rows) => rows[0] ?? null);

        if (!existing) return null;

        if (input.isPrimary === true) {
          await clearSiblingPrimaries(scopedDb, companyId, existing.issueId);
        }

        const [updated] = await scopedDb
          .update(taskOutputs)
          .set({ ...input, updatedAt: new Date() })
          .where(and(eq(taskOutputs.id, id), eq(taskOutputs.companyId, companyId)))
          .returning();
        return updated ?? null;
      });
    },
  };
}
