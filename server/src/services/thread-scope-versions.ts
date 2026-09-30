import type { ThreadDerivedStage } from "@armyofagents/shared";
import type { Db } from "@armyofagents/db";
import {
  artifactVersions,
  artifacts,
  assets,
  discussionEntries,
  discussionEntryAttachments,
  discussionExtractedItems,
  discussions,
  goals,
  projects,
  threadScopeArtifactLinks,
  threadScopeItems,
  threadScopeVersions,
} from "@armyofagents/db";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { isUniqueViolation } from "./db-errors.js";
import { issueService } from "./issues.js";
import { MAX_CONTEXT_BUNDLE_ITEMS } from "./issue-context-bundles.js";
import { memoryService } from "./memory.js";
import { compileThreadScopeDraft } from "./thread-scope-draft-compiler.js";
import { hubItemsService } from "./hub-items.js";

export type DerivedThreadStage = {
  stage: ThreadDerivedStage;
  label: string;
  versionNumber: number | null;
  scopeVersionId: string | null;
  hasNewEntries: boolean;
  newEntryCount: number;
};

export type LatestScopeForStage = {
  id: string;
  versionNumber: number;
  status: string;
  sourceEndSeq: number;
  appliedItemCount: number;
};

type CreatedScopeTask = {
  id: string;
  assigneeAgentId: string | null;
  workMode: string | null;
  sourceDiscussionId?: string | null;
  scopeVersionId?: string | null;
};

export type AcceptScopeDraftResult =
  | {
      ok: true;
      alreadyAccepted: boolean;
      acceptedVersion: typeof threadScopeVersions.$inferSelect;
      appliedItems: Array<{ id: string; kind: string; status: string }>;
      createdTasks: Array<{
        id: string;
        assigneeAgentId: string | null;
        workMode: string | null;
        sourceDiscussionId?: string | null;
        scopeVersionId?: string | null;
      }>;
    }
  | {
      ok: false;
      reason: "not_found" | "rejected" | "stale" | "unsupported_action" | "nothing_accepted";
      message: string;
    };

export type CreateScopeOutputItemResult =
  | {
      ok: true;
      item: typeof threadScopeItems.$inferSelect;
      createdTask?: CreatedScopeTask;
      createdMemoryId?: string;
      artifactLinkId?: string;
    }
  | {
      ok: false;
      reason:
        | "not_found"
        | "item_not_found"
        | "rejected"
        | "stale"
        | "not_draft"
        | "already_applied"
        | "unsupported_action";
      message: string;
    };

export type CreateScopeOutputOptions = {
  memoryStatus?: "approved" | "pending";
  approveMemory?: (memoryItem: {
    layer?: string | null;
    departmentId?: string | null;
  }) => Promise<void>;
  dispatchMode?: "standard" | "planning";
};

function asPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Validate that a task_proposal's payload `projectId` / `goalId` belong to the
 * same company before they are forwarded to issueService.create. The scope item
 * payload is founder-editable and can reference foreign or stale ids;
 * issueService.create does not currently company-scope these fields, so we mirror
 * the assigneeAgentId-style check here (the minimal correct spot — validating in
 * issueService.create would change behavior for all 30+ callers). Only runs when
 * a value is present so the common null case stays a no-op.
 */
async function assertScopeTaskScopeFields(
  tx: Pick<Db, "select">,
  companyId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const projectId = asString(payload.projectId);
  if (projectId) {
    const [row] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .limit(1);
    if (!row) {
      throw unprocessable("projectId does not belong to this company");
    }
  }

  const goalId = asString(payload.goalId);
  if (goalId) {
    const [row] = await tx
      .select({ id: goals.id })
      .from(goals)
      .where(and(eq(goals.id, goalId), eq(goals.companyId, companyId)))
      .limit(1);
    if (!row) {
      throw unprocessable("goalId does not belong to this company");
    }
  }
}

async function resolveMemoryStatus(
  actor: { userId?: string; agentId?: string; isHuman?: boolean },
  payload: Record<string, unknown>,
  options: CreateScopeOutputOptions,
): Promise<"approved" | "pending"> {
  if (options.memoryStatus === "approved" && actor.isHuman) {
    if (!options.approveMemory) {
      throw forbidden("Approved memory requires memory approval authorization");
    }
    await options.approveMemory({
      layer: asString(payload.layer) ?? null,
      departmentId: asString(payload.departmentId) ?? null,
    });
    return "approved";
  }
  return "pending";
}

function buildMemoryCandidateCreateInput(input: {
  item: typeof threadScopeItems.$inferSelect;
  payload: Record<string, unknown>;
  scopeVersionId: string;
  createdBy: string;
  status?: "approved" | "pending";
}) {
  return {
    title: input.item.title,
    content: input.item.description ?? input.item.title,
    category: asString(input.payload.category) ?? "context",
    source: "discussion",
    sourceContext: `thread_scope_version:${input.scopeVersionId}`,
    layer: asString(input.payload.layer) ?? null,
    departmentId: asString(input.payload.departmentId) ?? null,
    projectId: asString(input.payload.projectId) ?? null,
    goalId: asString(input.payload.goalId) ?? null,
    taskId: asString(input.payload.taskId) ?? null,
    folderPath: asString(input.payload.folderPath) ?? "",
    visibility: asString(input.payload.visibility) ?? "scoped",
    priority: asNumber(input.payload.priority) ?? 0,
    tags: asStringArray(input.payload.tags) ?? [],
    createdBy: input.createdBy,
    status: input.status ?? "pending",
  };
}

const HANDOFF_REF_TYPES = new Set([
  "discussion_entry",
  "artifact",
  "asset",
  "url",
  "memory",
  "text",
  "scope_item",
]);

type ScopeHandoffRef = {
  type: string;
  id?: string | null;
  label?: string | null;
  metadata?: Record<string, unknown> | null;
};

function normalizeHandoffRefs(value: unknown): ScopeHandoffRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (!HANDOFF_REF_TYPES.has(type)) return [];
    const id = typeof record.id === "string" ? record.id : null;
    const label = typeof record.label === "string" ? record.label : null;
    const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? record.metadata as Record<string, unknown>
      : {};
    return [{ type, id, label, metadata }];
  });
}

function sourceEntryIdsFromItem(item: typeof threadScopeItems.$inferSelect): string[] {
  return Array.isArray(item.sourceEntryIds)
    ? item.sourceEntryIds.filter((entryId): entryId is string => typeof entryId === "string")
    : [];
}

function scopeItemToHandoffRef(item: typeof threadScopeItems.$inferSelect): ScopeHandoffRef | null {
  const payload = asPayload(item.payload);
  const contentType = asString(payload.contentType);
  const artifactType = asString(payload.artifactType);
  const assetId = asString(payload.assetId);
  const url = asString(payload.url);

  if (item.kind === "artifact_link" && item.artifactId) {
    if (payload.storageKind === "asset" && assetId) {
      return {
        type: "asset",
        id: assetId,
        label: asString(payload.filename) ?? item.title,
        metadata: {
          contentType,
          filename: asString(payload.filename),
          artifactId: item.artifactId,
          artifactVersionId: item.artifactVersionId ?? undefined,
          scopeItemId: item.id,
        },
      };
    }
    return {
      type: "artifact",
      id: item.artifactId,
      label: item.title,
      metadata: {
        artifactVersionId: item.artifactVersionId ?? undefined,
        artifactType: artifactType ?? contentType,
        scopeItemId: item.id,
      },
    };
  }

  if (item.kind !== "source_signal") return null;

  if (assetId) {
    return {
      type: "asset",
      id: assetId,
      label: item.title,
      metadata: { contentType, scopeItemId: item.id },
    };
  }

  if (url) {
    return {
      type: "url",
      label: item.title,
      metadata: { url, scopeItemId: item.id },
    };
  }

  if (item.description) {
    return {
      type: "text",
      label: item.title,
      metadata: { body: item.description, scopeItemId: item.id },
    };
  }

  return null;
}

function handoffRefKey(ref: ScopeHandoffRef): string {
  const metadata = ref.metadata ?? {};
  const url = typeof metadata.url === "string" ? metadata.url : "";
  return [ref.type, ref.id ?? "", url, ref.label ?? ""].join(":");
}

function dedupeHandoffRefs(refs: ScopeHandoffRef[]): ScopeHandoffRef[] {
  const seen = new Set<string>();
  const result: ScopeHandoffRef[] = [];
  for (const ref of refs) {
    const key = handoffRefKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

function buildScopeTaskContextBundle(input: {
  version: typeof threadScopeVersions.$inferSelect;
  item: typeof threadScopeItems.$inferSelect;
  payload: Record<string, unknown>;
  relatedItems?: Array<typeof threadScopeItems.$inferSelect>;
}) {
  const selectedRefs = normalizeHandoffRefs(input.payload.handoffRefs);
  const fallbackRefs = sourceEntryIdsFromItem(input.item).map((entryId) => ({
    type: "discussion_entry",
    id: entryId,
    label: "Source message",
    metadata: { scopeItemId: input.item.id },
  }));
  const relatedRefs = (input.relatedItems ?? [])
    .filter((related) => related.id !== input.item.id && related.status !== "rejected")
    .map(scopeItemToHandoffRef)
    .filter((ref): ref is ScopeHandoffRef => Boolean(ref));
  const items = (selectedRefs.length > 0 ? selectedRefs : dedupeHandoffRefs([...fallbackRefs, ...relatedRefs]))
    // The synthetic fallback task can carry one ref per scoped entry. Threads with
    // >20 entries would exceed MAX_CONTEXT_BUNDLE_ITEMS and trip a 422 rollback in
    // issueService.create's context-bundle validation. Cap the assembled refs so
    // apply succeeds for large threads.
    .slice(0, MAX_CONTEXT_BUNDLE_ITEMS);

  return {
    sourceDiscussionId: input.version.threadId,
    sourceScopeVersionId: input.version.id,
    sourceScopeItemId: input.item.id,
    sourceKind: "discussion_scope",
    brief: input.item.description ?? input.item.title,
    items,
  };
}

async function findBlockingEntriesAfterScope(
  db: Pick<Db, "select">,
  threadId: string,
  sourceEndSeq: number,
) {
  return db
    .select({
      id: discussionEntries.id,
      seq: discussionEntries.seq,
      inputType: discussionEntries.inputType,
      authorAgentId: discussionEntries.authorAgentId,
    })
    .from(discussionEntries)
    .where(and(
      eq(discussionEntries.discussionId, threadId),
      gt(discussionEntries.seq, sourceEndSeq),
    ))
    .then((rows) =>
      rows.filter((entry) =>
        entry.inputType !== "agent" &&
        entry.inputType !== "system" &&
        entry.inputType !== "scope_proposal",
      ),
    );
}

async function isScopeDraftStaleForOutputs(
  db: Pick<Db, "select">,
  thread: typeof discussions.$inferSelect,
  version: typeof threadScopeVersions.$inferSelect,
) {
  if ((thread.entrySeq ?? 0) <= version.sourceEndSeq) return false;
  const blockingEntries = await findBlockingEntriesAfterScope(db, version.threadId, version.sourceEndSeq);
  return blockingEntries.length > 0;
}

type ScopeDraftWriteDb = Pick<Db, "insert">;
type ScopeDirectFinalizeDb = Pick<Db, "select" | "update">;
/** Codex #270 P2 (round 5): applying a scope card that ORIGINATED from an extracted
 *  item must RESOLVE that source item. Otherwise it stays 'pending' in the founder's
 *  review queue — approve-able later into a DUPLICATE task — and holds a stale
 *  pendingItemCount badge. Mirrors the human approve flow (discussions.ts approveItems:
 *  status→'approved' + result linkage + GREATEST-guarded decrement). The UPDATE is
 *  guarded to pending/edited so an already-resolved item is never double-counted.
 */
async function resolveSourceExtractedItem(
  tx: Pick<Db, "update">,
  input: {
    companyId: string;
    extractedItemId: string;
    threadId: string;
    resultTaskId?: string | null;
    resultMemoryId?: string | null;
  },
): Promise<void> {
  const updated = (await tx
    .update(discussionExtractedItems)
    .set({
      status: "approved",
      resultTaskId: input.resultTaskId ?? null,
      resultMemoryId: input.resultMemoryId ?? null,
    })
    .where(and(
      eq(discussionExtractedItems.id, input.extractedItemId),
      inArray(discussionExtractedItems.status, ["pending", "edited"]),
    ))
    .returning({ id: discussionExtractedItems.id })) as Array<{ id: string }>;
  if (updated.length > 0) {
    await tx
      .update(discussions)
      .set({
        pendingItemCount: sql`GREATEST(${discussions.pendingItemCount} - 1, 0)`,
        updatedAt: new Date(),
      })
      .where(eq(discussions.id, input.threadId));
    // Codex #270 P2 (round 6): reconcile the discussion's pending-review hub item
    // immediately — the human approveItems flow does the same after this decrement.
    // Otherwise a last-item apply leaves a stale "Review N pending items" Inbox row
    // until an unrelated sweep runs. Best-effort: a reconcile hiccup must not fail
    // the apply (the sweeper heals; sources stay truth).
    try {
      await hubItemsService(tx as unknown as Db).reconcile(input.companyId, {
        sourceType: "discussion",
        sourceId: input.threadId,
      });
    } catch {
      /* sweeper heals */
    }
  }
}

type ScopeItemReviewStatus = "draft" | "accepted" | "rejected";

const REVIEWABLE_SCOPE_ITEM_STATUSES = new Set(["draft", "accepted", "rejected"]);
const ACTIONABLE_SCOPE_ITEM_KINDS = new Set(["task_proposal", "memory_candidate", "artifact_link"]);
const TERMINAL_DIRECT_SCOPE_STATUSES = new Set(["applied", "rejected"]);

function isScopeItemReviewStatus(status: unknown): status is ScopeItemReviewStatus {
  return typeof status === "string" && REVIEWABLE_SCOPE_ITEM_STATUSES.has(status);
}

function isActionableScopeItem(item: { kind: string }) {
  return ACTIONABLE_SCOPE_ITEM_KINDS.has(item.kind);
}

function isTerminalDirectScopeItem(item: { status: string }) {
  return TERMINAL_DIRECT_SCOPE_STATUSES.has(item.status);
}

async function maybeAcceptDraftAfterDirectCreate(
  tx: ScopeDirectFinalizeDb,
  input: {
    companyId: string;
    threadId: string;
    scopeVersionId: string;
    actor: { userId?: string; agentId?: string; isHuman?: boolean };
  },
) {
  const items = await tx
    .select()
    .from(threadScopeItems)
    .where(and(
      eq(threadScopeItems.companyId, input.companyId),
      eq(threadScopeItems.scopeVersionId, input.scopeVersionId),
    ));

  const actionableItems = items.filter(isActionableScopeItem);
  if (actionableItems.length === 0) return null;
  if (!actionableItems.every(isTerminalDirectScopeItem)) return null;

  const [acceptedVersion] = await tx
    .update(threadScopeVersions)
    .set({
      status: "accepted",
      acceptedByUserId: input.actor.userId ?? null,
      acceptedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(threadScopeVersions.companyId, input.companyId),
      eq(threadScopeVersions.threadId, input.threadId),
      eq(threadScopeVersions.id, input.scopeVersionId),
      eq(threadScopeVersions.status, "draft"),
    ))
    .returning();

  return acceptedVersion ?? null;
}

export function deriveThreadStage(input: {
  subtype: string | null;
  status: string;
  entrySeq: number;
  latest: LatestScopeForStage | null;
}): DerivedThreadStage {
  if (input.status === "archived") {
    return {
      stage: "archived",
      label: "Archived",
      versionNumber: null,
      scopeVersionId: null,
      hasNewEntries: false,
      newEntryCount: 0,
    };
  }

  if (input.subtype === "live") {
    return {
      stage: "live",
      label: "Live intake",
      versionNumber: null,
      scopeVersionId: null,
      hasNewEntries: false,
      newEntryCount: 0,
    };
  }

  if (!input.latest) {
    return {
      stage: "discussing",
      label: "Discussing v1",
      versionNumber: 1,
      scopeVersionId: null,
      hasNewEntries: input.entrySeq > 0,
      newEntryCount: input.entrySeq,
    };
  }

  const newEntryCount = Math.max(0, input.entrySeq - input.latest.sourceEndSeq);
  if (newEntryCount > 0 && ["accepted", "completed"].includes(input.latest.status)) {
    const versionNumber = input.latest.versionNumber + 1;
    return {
      stage: "discussing",
      label: `Discussing v${versionNumber}`,
      versionNumber,
      scopeVersionId: input.latest.id,
      hasNewEntries: true,
      newEntryCount,
    };
  }

  // A rejected scope version means scoping was abandoned — the thread is back to
  // discussing, not actively scoped. Return a discussing-equivalent stage for the
  // next scope attempt (versionNumber + 1) and do NOT expose the rejected
  // scopeVersionId, which would otherwise render as an active "Scoped vN".
  if (input.latest.status === "rejected") {
    const versionNumber = input.latest.versionNumber + 1;
    return {
      stage: "discussing",
      label: `Discussing v${versionNumber}`,
      versionNumber,
      scopeVersionId: null,
      hasNewEntries: newEntryCount > 0,
      newEntryCount,
    };
  }

  if (input.latest.status === "draft") {
    return {
      stage: "scoping",
      label: `Scoping v${input.latest.versionNumber}`,
      versionNumber: input.latest.versionNumber,
      scopeVersionId: input.latest.id,
      hasNewEntries: false,
      newEntryCount: 0,
    };
  }

  if (input.latest.status === "completed") {
    return {
      stage: "complete",
      label: `Complete v${input.latest.versionNumber}`,
      versionNumber: input.latest.versionNumber,
      scopeVersionId: input.latest.id,
      hasNewEntries: false,
      newEntryCount: 0,
    };
  }

  if (input.latest.appliedItemCount > 0) {
    return {
      stage: "assigned",
      label: `Assigned v${input.latest.versionNumber}`,
      versionNumber: input.latest.versionNumber,
      scopeVersionId: input.latest.id,
      hasNewEntries: false,
      newEntryCount: 0,
    };
  }

  return {
    stage: "scoped",
    label: `Scoped v${input.latest.versionNumber}`,
    versionNumber: input.latest.versionNumber,
    scopeVersionId: input.latest.id,
    hasNewEntries: false,
    newEntryCount: 0,
  };
}

export async function loadLatestScopeVersion(db: Db, companyId: string, threadId: string) {
  const [version] = await db
    .select()
    .from(threadScopeVersions)
    .where(and(eq(threadScopeVersions.companyId, companyId), eq(threadScopeVersions.threadId, threadId)))
    .orderBy(desc(threadScopeVersions.versionNumber), desc(threadScopeVersions.createdAt))
    .limit(1);

  return version ?? null;
}

export async function loadLatestScopeForThreadStages(
  db: Db,
  companyId: string,
  threadIds: string[],
): Promise<Map<string, LatestScopeForStage>> {
  if (threadIds.length === 0) return new Map();

  const versions = await db
    .select({
      id: threadScopeVersions.id,
      threadId: threadScopeVersions.threadId,
      versionNumber: threadScopeVersions.versionNumber,
      status: threadScopeVersions.status,
      sourceEndSeq: threadScopeVersions.sourceEndSeq,
      createdAt: threadScopeVersions.createdAt,
    })
    .from(threadScopeVersions)
    .where(and(
      eq(threadScopeVersions.companyId, companyId),
      inArray(threadScopeVersions.threadId, threadIds),
    ))
    .orderBy(desc(threadScopeVersions.versionNumber), desc(threadScopeVersions.createdAt));

  const latestByThread = new Map<string, Omit<LatestScopeForStage, "appliedItemCount">>();
  for (const version of versions) {
    if (latestByThread.has(version.threadId)) continue;
    latestByThread.set(version.threadId, {
      id: version.id,
      versionNumber: version.versionNumber,
      status: version.status,
      sourceEndSeq: version.sourceEndSeq,
    });
  }

  const scopeVersionIds = [...latestByThread.values()].map((version) => version.id);
  const appliedCounts = new Map<string, number>();
  if (scopeVersionIds.length > 0) {
    const rows = await db
      .select({
        scopeVersionId: threadScopeItems.scopeVersionId,
        appliedItemCount: sql<number>`count(${threadScopeItems.id})::int`,
      })
      .from(threadScopeItems)
      .where(and(
        inArray(threadScopeItems.scopeVersionId, scopeVersionIds),
        eq(threadScopeItems.status, "applied"),
      ))
      .groupBy(threadScopeItems.scopeVersionId);

    for (const row of rows) {
      appliedCounts.set(row.scopeVersionId, Number(row.appliedItemCount ?? 0));
    }
  }

  const result = new Map<string, LatestScopeForStage>();
  for (const [threadId, latest] of latestByThread) {
    result.set(threadId, {
      ...latest,
      appliedItemCount: appliedCounts.get(latest.id) ?? 0,
    });
  }
  return result;
}

export function threadScopeVersionService(db: Db) {
  return {
    createDraftFromThread: async (
      companyId: string,
      threadId: string,
      actor: { userId?: string; agentId?: string; isHuman?: boolean },
      input: {
        summary?: string;
        assumptions?: unknown[];
        decisions?: unknown[];
        openQuestions?: unknown[];
        proposedTasks?: Array<{ title: string; assigneeAgentId?: string | null }>;
        /** W2 (D6): set by the Adjutant extract-then-scope path — extraction already ran,
         *  so a zero-item compile must emit NO synthetic fallback task (no fake card).
         *  Absent/false on the human create-draft route (derived-title fallback kept). */
        suppressFallbackTask?: boolean;
        /** Codex #270 P1: when a truncated extraction pass (count cap / deadline) only
         *  processed entries up to some seq, the draft's range must END there — entries
         *  past it were never extracted and belong to the NEXT scope's range
         *  (sourceStartSeq = sourceEndSeq + 1). Without this cap they would be silently
         *  consumed by this draft's range accounting and never scoped. */
        sourceEndSeqOverride?: number;
      },
    ) => {
      const [thread] = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, threadId), eq(discussions.companyId, companyId)))
        .limit(1);

      if (!thread) {
        throw notFound("Discussion not found");
      }
      if (thread.subtype === "live") {
        throw conflict("Live threads cannot be scoped directly; spin off a work thread first");
      }

      const latest = await loadLatestScopeVersion(db, companyId, threadId);
      if (latest?.status === "draft") {
        return { status: "existing_draft" as const, version: latest };
      }

      const sourceStartSeq =
        latest && ["accepted", "completed"].includes(latest.status)
          ? latest.sourceEndSeq + 1
          : 1;
      // Codex #270 P1: a truncated extraction pass caps the range at the last entry it
      // actually processed — the unprocessed tail stays in the NEXT scope's range
      // (sourceStartSeq = sourceEndSeq + 1) instead of being silently consumed. Clamped
      // to the live entrySeq defensively (an override can never widen the range).
      const liveEndSeq = thread.entrySeq ?? 0;
      const sourceEndSeq =
        input.sourceEndSeqOverride != null
          ? Math.min(input.sourceEndSeqOverride, liveEndSeq)
          : liveEndSeq;

      if (sourceEndSeq < sourceStartSeq) {
        return { status: "no_entries" as const, sourceStartSeq, sourceEndSeq };
      }

      const entries = await db
        .select()
        .from(discussionEntries)
        .where(and(
          eq(discussionEntries.discussionId, threadId),
          gte(discussionEntries.seq, sourceStartSeq),
          lte(discussionEntries.seq, sourceEndSeq),
        ))
        .orderBy(asc(discussionEntries.seq));

      const entryIds = entries.map((entry) => entry.id);
      // Only map extracted items that are still actionable (pending OR edited)
      // and have not already produced a task or memory. Without these predicates,
      // re-running scope draft creation re-maps already-resolved items and creates
      // duplicate proposal cards (and, on apply, duplicate tasks/memory). `edited`
      // is included because a founder lightly editing an item before the draft
      // compile must not silently drop it from the scope draft.
      const extractedItems = entryIds.length > 0
        ? await db
          .select()
          .from(discussionExtractedItems)
          .where(and(
            inArray(discussionExtractedItems.discussionEntryId, entryIds),
            inArray(discussionExtractedItems.status, ["pending", "edited"]),
            isNull(discussionExtractedItems.resultTaskId),
            isNull(discussionExtractedItems.resultMemoryId),
          ))
        : [];
      const attachments = entryIds.length > 0
        ? await db
          .select({
            discussionEntryId: discussionEntryAttachments.discussionEntryId,
            assetId: assets.id,
            artifactId: artifacts.id,
            artifactVersionId: artifacts.currentVersionId,
            artifactTitle: artifacts.title,
            artifactType: artifacts.type,
            assetOriginalFilename: assets.originalFilename,
            assetContentType: assets.contentType,
            artifactVersionStorageKind: artifactVersions.storageKind,
            artifactVersionAssetId: artifactVersions.assetId,
            artifactVersionFilename: artifactVersions.filename,
            artifactVersionContentType: artifactVersions.contentType,
            artifactVersionByteSize: artifactVersions.byteSize,
            artifactVersionSha256: artifactVersions.sha256,
          })
          .from(discussionEntryAttachments)
          .leftJoin(artifacts, and(
            eq(discussionEntryAttachments.artifactId, artifacts.id),
            eq(artifacts.companyId, companyId),
          ))
          .leftJoin(artifactVersions, eq(artifacts.currentVersionId, artifactVersions.id))
          .leftJoin(assets, and(
            eq(discussionEntryAttachments.assetId, assets.id),
            eq(assets.companyId, companyId),
          ))
          .where(inArray(discussionEntryAttachments.discussionEntryId, entryIds))
        : [];

      const compiled = compileThreadScopeDraft({
        threadTitle: thread.title ?? null,
        summaryText: input.summary ?? thread.summaryText ?? null,
        entries: entries.map((entry) => ({
          id: entry.id,
          seq: entry.seq ?? 0,
          inputType: entry.inputType,
          rawContent: entry.rawContent,
        })),
        extractedItems: extractedItems
          // Defense-in-depth: even if a future caller bypasses the select
          // predicate above, never re-map an extracted item that already
          // produced a task or memory.
          .filter((item) => !item.resultTaskId && !item.resultMemoryId)
          .map((item) => ({
            id: item.id,
            discussionEntryId: item.discussionEntryId,
            type: item.type,
            title: item.title,
            description: item.description,
            suggestedPriority: item.suggestedPriority,
            suggestedAssigneeId: item.suggestedAssigneeId,
            suggestedDepartmentId: item.suggestedDepartmentId,
            suggestedProjectId: item.suggestedProjectId,
            suggestedLayer: item.suggestedLayer,
            suggestedGoalId: item.suggestedGoalId,
            status: item.status,
            payload: (item as { payload?: Record<string, unknown> | null }).payload,
          })),
        attachments: attachments.map((attachment) => ({
          entryId: attachment.discussionEntryId,
          artifactId: attachment.artifactId,
          artifactVersionId: attachment.artifactVersionId,
          assetId: attachment.artifactVersionAssetId ?? attachment.assetId,
          title: attachment.artifactTitle ?? attachment.artifactVersionFilename ?? attachment.assetOriginalFilename ?? null,
          contentType: attachment.artifactVersionContentType ?? attachment.assetContentType ?? attachment.artifactType ?? null,
          storageKind: attachment.artifactVersionStorageKind,
          filename: attachment.artifactVersionFilename,
          byteSize: attachment.artifactVersionByteSize,
          sha256: attachment.artifactVersionSha256,
          kind: attachment.artifactId ? "artifact" : "asset",
        })),
        proposedTasks: input.proposedTasks,
        suppressFallbackTask: input.suppressFallbackTask,
      });

      // Codex #270 P2 (round 9): with fallback synthesis suppressed, a zero-item
      // compile must NOT mint a draft. An empty draft has nothing to accept, yet
      // it blocks every later scope pass behind existing_draft until a human
      // rejects it — reachable when the capped range holds only permanently
      // non-extractable entries (e.g. a failure cap landing just past a short
      // "ok" prefix). Refusing keeps the range open: failed entries stay
      // retryable and the next successful pass drafts over the full range.
      if (input.suppressFallbackTask && compiled.items.length === 0) {
        return { status: "no_items" as const, sourceStartSeq, sourceEndSeq };
      }

      const versionNumber = latest ? latest.versionNumber + 1 : 1;
      const work = async (tx: ScopeDraftWriteDb) => {
        const [version] = await tx
          .insert(threadScopeVersions)
          .values({
            companyId,
            threadId,
            versionNumber,
            status: "draft",
            sourceStartSeq,
            sourceEndSeq,
            baseVersionId: latest?.id ?? null,
            summary: compiled.summary,
            assumptions: input.assumptions ?? compiled.assumptions,
            decisions: input.decisions ?? compiled.decisions,
            openQuestions: input.openQuestions ?? compiled.openQuestions,
            createdBy: actor.userId ?? actor.agentId ?? "system",
            createdByAgentId: actor.agentId ?? null,
          })
          .returning();

        if (compiled.items.length > 0) {
          await tx.insert(threadScopeItems).values(
            compiled.items.map((item, index) => ({
              companyId,
              scopeVersionId: version.id,
              itemOrder: index + 1,
              kind: item.kind,
              status: "draft",
              title: item.title,
              description: item.description,
              payload: item.payload,
              sourceEntryIds: item.sourceEntryIds,
              extractedItemId: item.extractedItemId ?? null,
              artifactId: item.artifactId ?? null,
              artifactVersionId: item.artifactVersionId ?? null,
            })),
          );
        }

        return version;
      };
      let version: typeof threadScopeVersions.$inferSelect;
      try {
        version = typeof db.transaction === "function"
          ? await db.transaction((tx) => work(tx as unknown as ScopeDraftWriteDb))
          : await work(db);
      } catch (err) {
        // A concurrent createDraft can race past the latest?.status === "draft"
        // check above and both attempt the insert. The loser violates BOTH unique
        // indexes on thread_scope_versions:
        //   - thread_scope_versions_thread_version_uq (threadId, versionNumber)
        //   - thread_scope_versions_one_draft_uq       (threadId WHERE status='draft')
        // The migration creates thread_version_uq FIRST, so Postgres reports that
        // violation FIRST. Converge on EITHER index — reload and return the now-
        // existing draft rather than re-throwing a 23505 as a 500. (A-M18)
        if (
          isUniqueViolation(err, "thread_scope_versions_one_draft_uq") ||
          isUniqueViolation(err, "thread_scope_versions_thread_version_uq")
        ) {
          const existing = await loadLatestScopeVersion(db, companyId, threadId);
          if (existing?.status === "draft") {
            return { status: "existing_draft" as const, version: existing };
          }
        }
        throw err;
      }

      return { status: "created" as const, version };
    },

    listVersions: async (companyId: string, threadId: string) => {
      return db
        .select()
        .from(threadScopeVersions)
        .where(and(eq(threadScopeVersions.companyId, companyId), eq(threadScopeVersions.threadId, threadId)))
        .orderBy(desc(threadScopeVersions.versionNumber), desc(threadScopeVersions.createdAt));
    },

    getVersion: async (companyId: string, threadId: string, scopeVersionId: string) => {
      const [version] = await db
        .select()
        .from(threadScopeVersions)
        .where(and(
          eq(threadScopeVersions.companyId, companyId),
          eq(threadScopeVersions.threadId, threadId),
          eq(threadScopeVersions.id, scopeVersionId),
        ))
        .limit(1);

      if (!version) return null;

      const items = await db
        .select()
        .from(threadScopeItems)
        .where(eq(threadScopeItems.scopeVersionId, scopeVersionId))
        .orderBy(threadScopeItems.itemOrder, threadScopeItems.createdAt);

      return { ...version, items };
    },

    reviewItems: async (
      companyId: string,
      threadId: string,
      scopeVersionId: string,
      input: { items: Array<{ itemId: string; status: ScopeItemReviewStatus }> },
      actor: { userId?: string; agentId?: string; isHuman?: boolean },
    ) => {
      void actor;
      const invalidItem = input.items.find((item) => !isScopeItemReviewStatus(item.status));
      if (invalidItem) {
        return {
          ok: false as const,
          reason: "invalid_status" as const,
          message: "Scope item review status must be draft, accepted, or rejected",
        };
      }

      const [version] = await db
        .select()
        .from(threadScopeVersions)
        .where(and(
          eq(threadScopeVersions.companyId, companyId),
          eq(threadScopeVersions.threadId, threadId),
          eq(threadScopeVersions.id, scopeVersionId),
        ))
        .limit(1);

      if (!version) {
        return {
          ok: false as const,
          reason: "not_found" as const,
          message: "Scope version not found",
        };
      }
      if (version.status !== "draft") {
        return {
          ok: false as const,
          reason: "not_draft" as const,
          message: "Scope version must be draft to review items",
        };
      }

      if (input.items.length === 0) {
        return { ok: true as const, updatedItems: [] };
      }

      const requestedItemIds = [...new Set(input.items.map((item) => item.itemId))];
      const existingItems = await db
        .select({ id: threadScopeItems.id })
        .from(threadScopeItems)
        .where(and(
          eq(threadScopeItems.companyId, companyId),
          eq(threadScopeItems.scopeVersionId, scopeVersionId),
          inArray(threadScopeItems.id, requestedItemIds),
        ));

      if (existingItems.length !== requestedItemIds.length) {
        return {
          ok: false as const,
          reason: "item_not_found" as const,
          message: "Scope item not found",
        };
      }

      // Sentinel used to roll back the batch transaction when a row disappears
      // mid-loop (concurrent change). Thrown inside the transaction so no partial
      // status updates are committed, then translated back to the structured
      // item_not_found result below.
      class ItemMissingDuringReview extends Error {}

      const applyReview = async (tx: Pick<Db, "update">) => {
        const updated: Array<typeof threadScopeItems.$inferSelect> = [];
        for (const item of input.items) {
          const [updatedItem] = await tx
            .update(threadScopeItems)
            .set({ status: item.status, updatedAt: new Date() })
            .where(and(
              eq(threadScopeItems.companyId, companyId),
              eq(threadScopeItems.scopeVersionId, scopeVersionId),
              eq(threadScopeItems.id, item.itemId),
            ))
            .returning();

          if (!updatedItem) {
            throw new ItemMissingDuringReview();
          }
          updated.push(updatedItem);
        }
        return updated;
      };

      try {
        const updatedItems = typeof db.transaction === "function"
          ? await db.transaction((tx) => applyReview(tx as unknown as Pick<Db, "update">))
          : await applyReview(db);
        return { ok: true as const, updatedItems };
      } catch (err) {
        if (err instanceof ItemMissingDuringReview) {
          return {
            ok: false as const,
            reason: "item_not_found" as const,
            message: "Scope item not found",
          };
        }
        throw err;
      }
    },

    updateItem: async (
      companyId: string,
      threadId: string,
      scopeVersionId: string,
      itemId: string,
      patch: {
        title?: string;
        description?: string | null;
        payload?: Record<string, unknown>;
        sourceEntryIds?: string[];
        status?: ScopeItemReviewStatus;
      },
      actor: { userId?: string; agentId?: string; isHuman?: boolean },
    ) => {
      void actor;
      if (patch.status !== undefined && !isScopeItemReviewStatus(patch.status)) {
        return {
          ok: false as const,
          reason: "invalid_status" as const,
          message: "Scope item review status must be draft, accepted, or rejected",
        };
      }

      const [version] = await db
        .select()
        .from(threadScopeVersions)
        .where(and(
          eq(threadScopeVersions.companyId, companyId),
          eq(threadScopeVersions.threadId, threadId),
          eq(threadScopeVersions.id, scopeVersionId),
        ))
        .limit(1);

      if (!version) {
        return {
          ok: false as const,
          reason: "not_found" as const,
          message: "Scope version not found",
        };
      }
      if (version.status !== "draft") {
        return {
          ok: false as const,
          reason: "not_draft" as const,
          message: "Scope version must be draft to edit items",
        };
      }

      const itemPatch: Partial<typeof threadScopeItems.$inferInsert> = { updatedAt: new Date() };
      if (patch.title !== undefined) itemPatch.title = patch.title;
      if (patch.description !== undefined) itemPatch.description = patch.description;
      if (patch.payload !== undefined) itemPatch.payload = patch.payload;
      if (patch.sourceEntryIds !== undefined) itemPatch.sourceEntryIds = patch.sourceEntryIds;
      if (patch.status !== undefined) itemPatch.status = patch.status;

      const [item] = await db
        .update(threadScopeItems)
        .set(itemPatch)
        .where(and(
          eq(threadScopeItems.companyId, companyId),
          eq(threadScopeItems.scopeVersionId, scopeVersionId),
          eq(threadScopeItems.id, itemId),
        ))
        .returning();

      return item
        ? { ok: true as const, item }
        : {
            ok: false as const,
            reason: "item_not_found" as const,
            message: "Scope item not found",
          };
    },

    updateDraft: async (
      companyId: string,
      threadId: string,
      scopeVersionId: string,
      patch: {
        summary?: string;
        assumptions?: unknown[];
        decisions?: unknown[];
        openQuestions?: unknown[];
      },
    ) => {
      const [version] = await db
        .update(threadScopeVersions)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(
          eq(threadScopeVersions.companyId, companyId),
          eq(threadScopeVersions.threadId, threadId),
          eq(threadScopeVersions.id, scopeVersionId),
          eq(threadScopeVersions.status, "draft"),
        ))
        .returning();

      return version ?? null;
    },

    rejectDraft: async (
      companyId: string,
      threadId: string,
      scopeVersionId: string,
      actor: { userId?: string; agentId?: string; isHuman?: boolean },
    ) => {
      const [version] = await db
        .update(threadScopeVersions)
        .set({ status: "rejected", rejectedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(threadScopeVersions.companyId, companyId),
          eq(threadScopeVersions.threadId, threadId),
          eq(threadScopeVersions.id, scopeVersionId),
        ))
        .returning();

      return version ? { ok: true as const, version, actor } : { ok: false as const, reason: "not_found" as const };
    },

    completeVersion: async (
      companyId: string,
      threadId: string,
      scopeVersionId: string,
      actor: { userId?: string; agentId?: string; isHuman?: boolean },
    ) => {
      const [version] = await db
        .update(threadScopeVersions)
        .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(threadScopeVersions.companyId, companyId),
          eq(threadScopeVersions.threadId, threadId),
          eq(threadScopeVersions.id, scopeVersionId),
        ))
        .returning();

      return version ? { ok: true as const, version, actor } : { ok: false as const, reason: "not_found" as const };
    },

    applyAcceptedDraft: async (
      companyId: string,
      threadId: string,
      scopeVersionId: string,
      actor: { userId?: string; agentId?: string; isHuman?: boolean },
    ): Promise<AcceptScopeDraftResult> => {
      const [version] = await db
        .select()
        .from(threadScopeVersions)
        .where(and(
          eq(threadScopeVersions.id, scopeVersionId),
          eq(threadScopeVersions.threadId, threadId),
          eq(threadScopeVersions.companyId, companyId),
        ))
        .limit(1);

      if (!version) {
        return { ok: false, reason: "not_found", message: "Scope draft not found" };
      }
      if (version.status === "rejected") {
        return { ok: false, reason: "rejected", message: "Scope draft has been rejected" };
      }
      if (version.status !== "draft") {
        return {
          ok: true,
          alreadyAccepted: true,
          acceptedVersion: version,
          appliedItems: [],
          createdTasks: [],
        };
      }

      const [thread] = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, version.threadId), eq(discussions.companyId, companyId)))
        .limit(1);

      if (!thread) {
        return { ok: false, reason: "not_found", message: "Discussion not found" };
      }
      if (await isScopeDraftStaleForOutputs(db, thread, version)) {
        return {
          ok: false,
          reason: "stale",
          message: "Scope draft is stale because the thread has newer human entries",
        };
      }

      const items = await db
        .select()
        .from(threadScopeItems)
        .where(and(
          eq(threadScopeItems.companyId, companyId),
          eq(threadScopeItems.scopeVersionId, scopeVersionId),
          eq(threadScopeItems.status, "accepted"),
        ));

      if (items.length === 0) {
        return {
          ok: false,
          reason: "nothing_accepted",
          message: "No accepted scope cards to apply",
        };
      }

      for (const item of items) {
        const payload = asPayload(item.payload);
        if (
          item.kind === "task_change" &&
          ["split", "supersede", "link_artifact"].includes(String(payload.action ?? ""))
        ) {
          return {
            ok: false,
            reason: "unsupported_action",
            message: `Task change action ${String(payload.action)} is not supported in this backend slice`,
          };
        }
        if (item.kind === "artifact_link" && !item.artifactId) {
          return {
            ok: false,
            reason: "unsupported_action",
            message: "Artifact link item requires artifactId",
          };
        }
      }

      return db.transaction(async (tx) => {
        const appliedItems: Array<{ id: string; kind: string; status: string }> = [];
        const createdTasks: Array<{
          id: string;
          assigneeAgentId: string | null;
          workMode: string | null;
          sourceDiscussionId?: string | null;
          scopeVersionId?: string | null;
        }> = [];

        for (const item of items) {
          const payload = asPayload(item.payload);
          let status = "accepted";
          let resultIssueId: string | null = null;
          let resultMemoryId: string | null = null;

          if (item.kind === "task_proposal") {
            await assertScopeTaskScopeFields(tx as unknown as Pick<Db, "select">, companyId, payload);
            const created = await issueService(tx as unknown as Db).create(companyId, {
              title: item.title,
              description: item.description,
              priority: payload.priority ?? "medium",
              projectId: payload.projectId ?? null,
              goalId: payload.goalId ?? null,
              labelIds: asStringArray(payload.labelIds),
              assigneeAgentId: payload.assigneeAgentId ?? null,
              assigneeUserId: payload.assigneeUserId ?? null,
              sourceDiscussionId: version.threadId,
              scopeVersionId: version.id,
              originKind: "crew_thread",
              status: "todo",
              workMode: "planning",
              contextBundle: buildScopeTaskContextBundle({ version, item, payload, relatedItems: items }),
            } as any);
            resultIssueId = created.id;
            createdTasks.push({
              id: created.id,
              assigneeAgentId: created.assigneeAgentId ?? null,
              workMode: created.workMode ?? null,
              sourceDiscussionId: created.sourceDiscussionId ?? version.threadId,
              scopeVersionId: created.scopeVersionId ?? version.id,
            });
            status = "applied";
          }

          if (item.kind === "memory_candidate") {
            const created = await memoryService(tx as unknown as Db).create(
              companyId,
              buildMemoryCandidateCreateInput({
                item,
                payload,
                scopeVersionId: version.id,
                createdBy: actor.userId ?? actor.agentId ?? "system",
              }) as any,
              tx as any,
            );
            resultMemoryId = created.id;
            status = "applied";
          }

          if (item.kind === "artifact_link") {
            await tx.insert(threadScopeArtifactLinks).values({
              companyId,
              scopeVersionId: version.id,
              artifactId: item.artifactId!,
              artifactVersionId: item.artifactVersionId ?? undefined,
              role: String(payload.role ?? "reference"),
              createdBy: actor.userId ?? actor.agentId ?? "system",
            }).returning();
            status = "applied";
          }

          // Codex #270 P2 (rounds 5+7): ANY accepted card that originated from an
          // extracted item resolves its source on apply — including non-entity kinds
          // (decision, source_signal) that produce no resultIssueId/resultMemoryId.
          // An accepted decision card whose source item stayed pending would keep a
          // stale badge and allow a later duplicate approval into memory.
          if (item.extractedItemId) {
            await resolveSourceExtractedItem(tx as unknown as Pick<Db, "update">, {
              companyId,
              extractedItemId: item.extractedItemId,
              threadId: version.threadId,
              resultTaskId: resultIssueId,
              resultMemoryId,
            });
          }

          const [updatedItem] = await tx
            .update(threadScopeItems)
            .set({
              status,
              resultIssueId,
              resultMemoryId,
              appliedByUserId: actor.userId ?? null,
              appliedAt: status === "applied" ? new Date() : null,
              updatedAt: new Date(),
            })
            .where(and(
              eq(threadScopeItems.companyId, companyId),
              eq(threadScopeItems.scopeVersionId, scopeVersionId),
              eq(threadScopeItems.id, item.id),
              eq(threadScopeItems.status, "accepted"),
            ))
            .returning();

          if (!updatedItem) {
            throw conflict("Scope item could not be applied because it changed during apply");
          }

          appliedItems.push({
            id: updatedItem.id,
            kind: item.kind,
            status: updatedItem.status,
          });
        }

        const [acceptedVersion] = await tx
          .update(threadScopeVersions)
          .set({
            status: "accepted",
            acceptedByUserId: actor.userId ?? null,
            acceptedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(
            eq(threadScopeVersions.id, scopeVersionId),
            eq(threadScopeVersions.threadId, threadId),
            eq(threadScopeVersions.companyId, companyId),
            eq(threadScopeVersions.status, "draft"),
          ))
          .returning();

        if (!acceptedVersion) {
          throw conflict("Scope draft could not be accepted because it changed during apply");
        }

        return {
          ok: true as const,
          alreadyAccepted: false,
          acceptedVersion,
          appliedItems,
          createdTasks,
        };
      });
    },

    createOutputItem: async (
      companyId: string,
      threadId: string,
      scopeVersionId: string,
      itemId: string,
      actor: { userId?: string; agentId?: string; isHuman?: boolean },
      options: CreateScopeOutputOptions = {},
    ): Promise<CreateScopeOutputItemResult> => {
      const [version] = await db
        .select()
        .from(threadScopeVersions)
        .where(and(
          eq(threadScopeVersions.id, scopeVersionId),
          eq(threadScopeVersions.threadId, threadId),
          eq(threadScopeVersions.companyId, companyId),
        ))
        .limit(1);

      if (!version) {
        return { ok: false, reason: "not_found", message: "Scope draft not found" };
      }
      if (version.status === "rejected") {
        return { ok: false, reason: "rejected", message: "Scope draft has been rejected" };
      }
      if (version.status !== "draft") {
        return { ok: false, reason: "not_draft", message: "Scope version must be draft to create outputs" };
      }

      const [thread] = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, version.threadId), eq(discussions.companyId, companyId)))
        .limit(1);

      if (!thread) {
        return { ok: false, reason: "not_found", message: "Discussion not found" };
      }
      if (await isScopeDraftStaleForOutputs(db, thread, version)) {
        return {
          ok: false,
          reason: "stale",
          message: "Scope draft is stale because the thread has newer human entries",
        };
      }

      const [item] = await db
        .select()
        .from(threadScopeItems)
        .where(and(
          eq(threadScopeItems.companyId, companyId),
          eq(threadScopeItems.scopeVersionId, scopeVersionId),
          eq(threadScopeItems.id, itemId),
        ))
        .limit(1);

      if (!item) {
        return { ok: false, reason: "item_not_found", message: "Scope item not found" };
      }
      if (item.status === "applied" || item.resultIssueId || item.resultMemoryId) {
        return { ok: false, reason: "already_applied", message: "Scope item has already created an output" };
      }
      if (item.status === "rejected") {
        return { ok: false, reason: "rejected", message: "Scope item has been rejected" };
      }
      if (!["task_proposal", "memory_candidate", "artifact_link"].includes(item.kind)) {
        return {
          ok: false,
          reason: "unsupported_action",
          message: `Scope item kind ${item.kind} cannot create an output yet`,
        };
      }
      if (item.kind === "artifact_link" && !item.artifactId) {
        return {
          ok: false,
          reason: "unsupported_action",
          message: "Artifact link item requires artifactId",
        };
      }

      const relatedItems = item.kind === "task_proposal"
        ? await db
          .select()
          .from(threadScopeItems)
          .where(and(
            eq(threadScopeItems.companyId, companyId),
            eq(threadScopeItems.scopeVersionId, scopeVersionId),
          ))
        : [];

      return db.transaction(async (tx) => {
        const payload = asPayload(item.payload);
        let resultIssueId: string | null = null;
        let resultMemoryId: string | null = null;
        let artifactLinkId: string | undefined;
        let createdTask: CreatedScopeTask | undefined;

        if (item.kind === "task_proposal") {
          await assertScopeTaskScopeFields(tx as unknown as Pick<Db, "select">, companyId, payload);
          const created = await issueService(tx as unknown as Db).create(companyId, {
            title: item.title,
            description: item.description,
            priority: payload.priority ?? "medium",
            projectId: payload.projectId ?? null,
            goalId: payload.goalId ?? null,
            labelIds: asStringArray(payload.labelIds),
            assigneeAgentId: payload.assigneeAgentId ?? null,
            assigneeUserId: payload.assigneeUserId ?? null,
            sourceDiscussionId: version.threadId,
            scopeVersionId: version.id,
            originKind: "crew_thread",
            status: "todo",
            workMode: options.dispatchMode ?? "planning",
            contextBundle: buildScopeTaskContextBundle({ version, item, payload, relatedItems }),
          } as any);
          resultIssueId = created.id;
          createdTask = {
            id: created.id,
            assigneeAgentId: created.assigneeAgentId ?? null,
            workMode: created.workMode ?? null,
            sourceDiscussionId: created.sourceDiscussionId ?? version.threadId,
            scopeVersionId: created.scopeVersionId ?? version.id,
          };
        }

        if (item.kind === "memory_candidate") {
          const status = await resolveMemoryStatus(actor, payload, options);
          const created = await memoryService(tx as unknown as Db).create(
            companyId,
            buildMemoryCandidateCreateInput({
              item,
              payload,
              scopeVersionId: version.id,
              createdBy: actor.userId ?? actor.agentId ?? "system",
              status,
            }) as any,
            tx as any,
          );
          resultMemoryId = created.id;
        }

        if (item.kind === "artifact_link") {
          const [link] = await tx.insert(threadScopeArtifactLinks).values({
            companyId,
            scopeVersionId: version.id,
            artifactId: item.artifactId!,
            artifactVersionId: item.artifactVersionId ?? undefined,
            role: String(payload.role ?? "reference"),
            createdBy: actor.userId ?? actor.agentId ?? "system",
          }).returning();
          artifactLinkId = link?.id;
        }

        // Codex #270 P2 (rounds 5+7): resolve the source extracted item on apply —
        // same rationale as the applyAcceptedDraft path (duplicate-approve + stale
        // badge). Kind-agnostic: null results are recorded as approved-without-links.
        if (item.extractedItemId) {
          await resolveSourceExtractedItem(tx as unknown as Pick<Db, "update">, {
            companyId,
            extractedItemId: item.extractedItemId,
            threadId: version.threadId,
            resultTaskId: resultIssueId,
            resultMemoryId,
          });
        }

        const [updatedItem] = await tx
          .update(threadScopeItems)
          .set({
            status: "applied",
            resultIssueId,
            resultMemoryId,
            appliedByUserId: actor.userId ?? null,
            appliedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(
            eq(threadScopeItems.companyId, companyId),
            eq(threadScopeItems.scopeVersionId, scopeVersionId),
            eq(threadScopeItems.id, item.id),
            eq(threadScopeItems.status, item.status),
          ))
          .returning();

        if (!updatedItem) {
          throw conflict("Scope item could not create an output because it changed during create");
        }

        await maybeAcceptDraftAfterDirectCreate(tx as unknown as ScopeDirectFinalizeDb, {
          companyId,
          threadId,
          scopeVersionId,
          actor,
        });

        return {
          ok: true as const,
          item: updatedItem,
          createdTask,
          createdMemoryId: resultMemoryId ?? undefined,
          artifactLinkId,
        };
      });
    },

    acceptDraft: async (
      companyId: string,
      threadId: string,
      scopeVersionId: string,
      selection: { itemIds: string[] },
      actor: { userId?: string; agentId?: string; isHuman?: boolean },
    ): Promise<AcceptScopeDraftResult> => {
      const [version] = await db
        .select()
        .from(threadScopeVersions)
        .where(and(
          eq(threadScopeVersions.id, scopeVersionId),
          eq(threadScopeVersions.threadId, threadId),
          eq(threadScopeVersions.companyId, companyId),
        ))
        .limit(1);

      if (!version) {
        return { ok: false, reason: "not_found", message: "Scope draft not found" };
      }
      if (version.status === "rejected") {
        return { ok: false, reason: "rejected", message: "Scope draft has been rejected" };
      }
      if (version.status !== "draft") {
        return {
          ok: true,
          alreadyAccepted: true,
          acceptedVersion: version,
          appliedItems: [],
          createdTasks: [],
        };
      }

      const [thread] = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, version.threadId), eq(discussions.companyId, companyId)))
        .limit(1);

      if (!thread) {
        return { ok: false, reason: "not_found", message: "Discussion not found" };
      }
      if (await isScopeDraftStaleForOutputs(db, thread, version)) {
        return {
          ok: false,
          reason: "stale",
          message: "Scope draft is stale because the thread has newer human entries",
        };
      }

      if (selection.itemIds.length > 0) {
        const selectedItems = await db
          .select()
          .from(threadScopeItems)
          .where(and(
            eq(threadScopeItems.companyId, companyId),
            eq(threadScopeItems.scopeVersionId, scopeVersionId),
            inArray(threadScopeItems.id, selection.itemIds),
          ));

        if (selectedItems.length !== new Set(selection.itemIds).size) {
          return { ok: false, reason: "not_found", message: "Scope item not found" };
        }

        for (const item of selectedItems) {
          const payload = asPayload(item.payload);
          if (
            item.kind === "task_change" &&
            ["split", "supersede", "link_artifact"].includes(String(payload.action ?? ""))
          ) {
            return {
              ok: false,
              reason: "unsupported_action",
              message: `Task change action ${String(payload.action)} is not supported in this backend slice`,
            };
          }
          if (item.kind === "artifact_link" && !item.artifactId) {
            return {
              ok: false,
              reason: "unsupported_action",
              message: "Artifact link item requires artifactId",
            };
          }
        }

        await db.transaction(async (tx) => {
          for (const item of selectedItems) {
            const [updatedItem] = await tx
              .update(threadScopeItems)
              .set({ status: "accepted", updatedAt: new Date() })
              .where(and(
                eq(threadScopeItems.companyId, companyId),
                eq(threadScopeItems.scopeVersionId, scopeVersionId),
                eq(threadScopeItems.id, item.id),
                eq(threadScopeItems.status, item.status),
              ))
              .returning();

            if (!updatedItem) {
              throw conflict("Scope item could not be accepted because it changed during apply");
            }
          }
        });
      }

      return threadScopeVersionService(db).applyAcceptedDraft(companyId, threadId, scopeVersionId, actor);
    },
  };
}
