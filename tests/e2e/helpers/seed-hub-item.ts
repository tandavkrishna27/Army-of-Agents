import { createDb, hubItems } from "../../../packages/db/src/index";
import type { HubItemPriority, HubOwnerPool, HubSemanticType } from "../../../packages/shared/src/hub";

export interface SeedHubItemInput {
  companyId: string;
  semanticType: HubSemanticType;
  sourceType: string;
  sourceId: string;
  title: string;
  summary?: string | null;
  ownerUserId?: string | null;
  ownerPool?: HubOwnerPool | null;
  priority?: HubItemPriority;
  groupKey?: string | null;
  curationGroupLabel?: string | null;
  curationGroupSummary?: string | null;
  curationReason?: string | null;
  curationPriorityReason?: string | null;
  curationRevision?: number;
  curatedAt?: Date | null;
  curatedByAgentId?: string | null;
}

function e2eDatabaseUrl() {
  const explicit =
    process.env.AOA_E2E_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  const port = process.env.AOA_E2E_DB_PORT?.trim() || "54329";
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

export async function seedHubItem(input: SeedHubItemInput) {
  const db = createDb(e2eDatabaseUrl());
  try {
    const sourceUniqueKey = [
      input.companyId,
      input.sourceType,
      input.sourceId,
      input.semanticType,
      "",
    ].join(":");
    const [row] = await db
      .insert(hubItems)
      .values({
        companyId: input.companyId,
        userId: input.ownerUserId ?? "e2e-board",
        type: input.semanticType,
        title: input.title,
        message: input.summary ?? null,
        semanticType: input.semanticType,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceUniqueKey,
        summary: input.summary ?? null,
        ownerUserId: input.ownerUserId ?? null,
        ownerPool: input.ownerPool ?? null,
        priority: input.priority ?? "normal",
        groupKey: input.groupKey ?? null,
        curationGroupLabel: input.curationGroupLabel ?? null,
        curationGroupSummary: input.curationGroupSummary ?? null,
        curationReason: input.curationReason ?? null,
        curationPriorityReason: input.curationPriorityReason ?? null,
        curationRevision: input.curationRevision ?? 0,
        curatedAt: input.curatedAt ?? null,
        curatedByAgentId: input.curatedByAgentId ?? null,
        status: "open",
      })
      .onConflictDoUpdate({
        target: hubItems.sourceUniqueKey,
        set: {
          title: input.title,
          message: input.summary ?? null,
          summary: input.summary ?? null,
          priority: input.priority ?? "normal",
          ownerUserId: input.ownerUserId ?? null,
          ownerPool: input.ownerPool ?? null,
          groupKey: input.groupKey ?? null,
          curationGroupLabel: input.curationGroupLabel ?? null,
          curationGroupSummary: input.curationGroupSummary ?? null,
          curationReason: input.curationReason ?? null,
          curationPriorityReason: input.curationPriorityReason ?? null,
          curationRevision: input.curationRevision ?? 0,
          curatedAt: input.curatedAt ?? null,
          curatedByAgentId: input.curatedByAgentId ?? null,
        },
      })
      .returning();
    return row;
  } finally {
    const client = (db as unknown as { $client?: { end: () => Promise<void> } }).$client;
    await client?.end();
  }
}

export async function bumpHubItemVersionForTest(item: Pick<typeof hubItems.$inferSelect, "id" | "version">) {
  const db = createDb(e2eDatabaseUrl());
  try {
    const client = (db as unknown as {
      $client?: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
    }).$client;
    if (!client) throw new Error("Test DB client is unavailable");
    await client`UPDATE notifications SET version = ${item.version + 1} WHERE id = ${item.id}`;
  } finally {
    const client = (db as unknown as { $client?: { end: () => Promise<void> } }).$client;
    await client?.end();
  }
}
