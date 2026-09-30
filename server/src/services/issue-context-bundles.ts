import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  assets,
  artifacts,
  discussionEntries,
  discussions,
  issueAttachments,
  issueComments,
  issueContextBundleItems,
  issueContextBundles,
  issues,
  memoryItems,
  threadScopeItems,
  threadScopeVersions,
} from "@armyofagents/db";
import { unprocessable } from "../errors.js";

type ContextBundleDb = Pick<Db, "select" | "insert" | "update">;

export const CONTEXT_BUNDLE_ITEM_TYPES = [
  "comment",
  "attachment",
  "artifact",
  "memory",
  "text",
  "discussion_entry",
  "asset",
  "url",
  "scope_item",
] as const;
export type ContextBundleItemType = (typeof CONTEXT_BUNDLE_ITEM_TYPES)[number];

export type CreateIssueContextBundleItemInput = {
  type: ContextBundleItemType | string;
  id?: string | null;
  label?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type CreateIssueContextBundleInput = {
  companyId: string;
  sourceIssueId?: string | null;
  sourceDiscussionId?: string | null;
  sourceScopeVersionId?: string | null;
  sourceScopeItemId?: string | null;
  sourceKind?: "issue" | "discussion_scope" | string | null;
  targetIssueId: string;
  brief?: string | null;
  items?: CreateIssueContextBundleItemInput[];
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
};

export const MAX_CONTEXT_BUNDLE_ITEMS = 20;

export function isContextBundleItemIncluded(item: { metadata?: Record<string, unknown> | null }) {
  return item.metadata?.includeInAgentContext !== false;
}

function isContextBundleItemType(value: string): value is ContextBundleItemType {
  return (CONTEXT_BUNDLE_ITEM_TYPES as readonly string[]).includes(value);
}

function requireSourceId(item: CreateIssueContextBundleItemInput): string {
  if (!item.id) throw unprocessable(`Context item ${item.type} requires an id`);
  return item.id;
}

async function assertIssueInCompany(db: ContextBundleDb, companyId: string, issueId: string, field: string) {
  const row = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!row) throw unprocessable(`${field} does not belong to this company`);
}

async function assertDiscussionInCompany(db: ContextBundleDb, companyId: string, discussionId: string, field: string) {
  const row = await db
    .select({ id: discussions.id })
    .from(discussions)
    .where(and(eq(discussions.id, discussionId), eq(discussions.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!row) throw unprocessable(`${field} does not belong to this company`);
}

async function assertScopeVersionInCompany(db: ContextBundleDb, companyId: string, scopeVersionId: string, field: string) {
  const row = await db
    .select({ id: threadScopeVersions.id })
    .from(threadScopeVersions)
    .where(and(eq(threadScopeVersions.id, scopeVersionId), eq(threadScopeVersions.companyId, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!row) throw unprocessable(`${field} does not belong to this company`);
}

async function assertContextItemInCompany(db: ContextBundleDb, companyId: string, item: CreateIssueContextBundleItemInput) {
  if (!isContextBundleItemType(item.type)) {
    throw unprocessable(`Unsupported context item type: ${item.type}`);
  }

  if (item.type === "text" || item.type === "url") return;

  const sourceId = requireSourceId(item);
  const lookup =
    item.type === "comment"
      ? db
          .select({ id: issueComments.id })
          .from(issueComments)
          .where(and(eq(issueComments.id, sourceId), eq(issueComments.companyId, companyId)))
      : item.type === "attachment"
        ? db
            .select({ id: issueAttachments.id })
            .from(issueAttachments)
            .where(and(eq(issueAttachments.id, sourceId), eq(issueAttachments.companyId, companyId)))
        : item.type === "artifact"
          ? db
            .select({ id: artifacts.id })
            .from(artifacts)
            .where(and(eq(artifacts.id, sourceId), eq(artifacts.companyId, companyId)))
          : item.type === "memory"
            ? db
                .select({ id: memoryItems.id })
                .from(memoryItems)
                .where(and(eq(memoryItems.id, sourceId), eq(memoryItems.companyId, companyId)))
            : item.type === "discussion_entry"
              ? db
                  .select({ id: discussionEntries.id })
                  .from(discussionEntries)
                  .innerJoin(discussions, eq(discussions.id, discussionEntries.discussionId))
                  .where(and(eq(discussionEntries.id, sourceId), eq(discussions.companyId, companyId)))
              : item.type === "asset"
                ? db
                    .select({ id: assets.id })
                    .from(assets)
                    .where(and(eq(assets.id, sourceId), eq(assets.companyId, companyId)))
                : db
                    .select({ id: threadScopeItems.id })
                    .from(threadScopeItems)
                    .where(and(eq(threadScopeItems.id, sourceId), eq(threadScopeItems.companyId, companyId)));

  const row = await lookup.then((rows) => rows[0] ?? null);
  if (!row) throw unprocessable(`Context item ${item.type} does not belong to this company`);
}

export async function validateContextBundleItems(db: ContextBundleDb, input: CreateIssueContextBundleInput) {
  const items = input.items ?? [];
  if (items.length > MAX_CONTEXT_BUNDLE_ITEMS) {
    throw unprocessable(`At most ${MAX_CONTEXT_BUNDLE_ITEMS} context items are allowed`);
  }

  if (!input.sourceIssueId && !input.sourceDiscussionId) {
    throw unprocessable("Context bundle requires sourceIssueId or sourceDiscussionId");
  }

  if (input.sourceIssueId) {
    await assertIssueInCompany(db, input.companyId, input.sourceIssueId, "sourceIssueId");
  }
  if (input.sourceDiscussionId) {
    await assertDiscussionInCompany(db, input.companyId, input.sourceDiscussionId, "sourceDiscussionId");
  }
  if (input.sourceScopeVersionId) {
    await assertScopeVersionInCompany(db, input.companyId, input.sourceScopeVersionId, "sourceScopeVersionId");
  }
  if (input.sourceScopeItemId) {
    await assertContextItemInCompany(db, input.companyId, {
      type: "scope_item",
      id: input.sourceScopeItemId,
    });
  }
  await assertIssueInCompany(db, input.companyId, input.targetIssueId, "targetIssueId");

  for (const item of items) {
    await assertContextItemInCompany(db, input.companyId, item);
  }
}

export async function createIssueContextBundle(db: ContextBundleDb, input: CreateIssueContextBundleInput) {
  await validateContextBundleItems(db, input);

  const [bundle] = await db
    .insert(issueContextBundles)
    .values({
      companyId: input.companyId,
      sourceIssueId: input.sourceIssueId ?? null,
      sourceDiscussionId: input.sourceDiscussionId ?? null,
      sourceScopeVersionId: input.sourceScopeVersionId ?? null,
      sourceScopeItemId: input.sourceScopeItemId ?? null,
      sourceKind: input.sourceKind ?? (input.sourceDiscussionId ? "discussion_scope" : "issue"),
      targetIssueId: input.targetIssueId,
      brief: input.brief ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      createdByUserId: input.createdByUserId ?? null,
    })
    .returning();

  const itemValues = (input.items ?? []).map((item) => ({
    companyId: input.companyId,
    bundleId: bundle.id,
    itemType: item.type,
    sourceId: item.id ?? null,
    label: item.label ?? null,
    metadata: item.metadata ?? {},
  }));

  const items = itemValues.length > 0
    ? await db.insert(issueContextBundleItems).values(itemValues).returning()
    : [];

  return { ...bundle, items };
}

export async function listIssueContextBundlesForIssue(db: ContextBundleDb, companyId: string, issueId: string) {
  const bundles = await db
    .select()
    .from(issueContextBundles)
    .where(and(eq(issueContextBundles.companyId, companyId), eq(issueContextBundles.targetIssueId, issueId)));

  if (bundles.length === 0) return [];

  const results = [];
  for (const bundle of bundles) {
    const items = await db
      .select()
      .from(issueContextBundleItems)
      .where(and(eq(issueContextBundleItems.companyId, companyId), eq(issueContextBundleItems.bundleId, bundle.id)));
    results.push({ ...bundle, items });
  }
  return results;
}

export async function setIssueContextBundleItemIncluded(
  db: ContextBundleDb,
  input: {
    companyId: string;
    targetIssueId: string;
    itemId: string;
    included: boolean;
  },
) {
  const existing = await db
    .select({
      id: issueContextBundleItems.id,
      metadata: issueContextBundleItems.metadata,
      bundleId: issueContextBundleItems.bundleId,
      targetIssueId: issueContextBundles.targetIssueId,
    })
    .from(issueContextBundleItems)
    .innerJoin(issueContextBundles, eq(issueContextBundles.id, issueContextBundleItems.bundleId))
    .where(and(
      eq(issueContextBundleItems.companyId, input.companyId),
      eq(issueContextBundleItems.id, input.itemId),
      eq(issueContextBundles.targetIssueId, input.targetIssueId),
    ))
    .then((rows) => rows[0] ?? null);

  if (!existing) return null;

  const metadata = {
    ...(existing.metadata ?? {}),
    includeInAgentContext: input.included,
  };

  const [updated] = await db
    .update(issueContextBundleItems)
    .set({ metadata })
    .where(and(
      eq(issueContextBundleItems.companyId, input.companyId),
      eq(issueContextBundleItems.id, input.itemId),
    ))
    .returning();

  return updated ?? null;
}
