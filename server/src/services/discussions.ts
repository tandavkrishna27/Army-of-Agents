import { and, eq, desc, sql, inArray, asc, or } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  discussions,
  discussionEntries,
  discussionExtractedItems,
  discussionAnnotations,
  discussionEntryAttachments,
  artifacts,
  artifactVersions,
  assets,
  agents,
  projects,
  goals,
  threadLinks,
  threadPlanSteps,
  threadParticipants,
  threadOrchestrationState,
  authUsers,
} from "@armyofagents/db";
import { badRequest, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { publishLiveEvent } from "./live-events.js";
import { hubItemsService } from "./hub-items.js";
import { buildDiscussionPendingHubEmit, emitHubItem } from "./hub-source-producers.js";
import { issueService } from "./issues.js";
import { memoryService } from "./memory.js";
import { getThreadEventListener } from "./thread-events.js";
import { threadOrchestrationService } from "./thread-orchestration.js";
// parseMentions is a pure regex helper (no DB); resolveMentionTargets adds a
// company-agent-roster read for multi-word crew names (round-13 #2). threads.ts
// is already in the module graph via live-events.ts → threads.ts, so this static
// import adds no new load-time cost or cycle (discussions → threads is one-
// directional; threads.ts does not import discussions.ts).
import { assertCanPostToThread, parseMentions, resolveMentionTargets, type Actor } from "./threads.js";
import { enqueueMentionOutbox } from "./mention-outbox.js";
import { deriveThreadStage, loadLatestScopeForThreadStages } from "./thread-scope-versions.js";
// NOTE: workspace-ttl-sweeper is imported dynamically in `update()` to keep
// the top-level import graph free of execution-workspaces → git → child_process.
// Several test suites (notably cli-mode.test.ts) partially mock node:child_process
// and the eager import causes their indirect resolution chain to fail.

export interface DiscussionFilters {
  status?: string;
  scopeType?: string;
  scopeId?: string;
  hasPendingItems?: boolean;
  inputType?: string;
}

/**
 * Validate that scopeId references the correct table based on scopeType.
 * Gotcha 1.1: Polymorphic scope — Drizzle/PostgreSQL can't enforce polymorphic FKs.
 */
async function validateScope(
  db: Db,
  companyId: string,
  scopeType: string | null | undefined,
  scopeId: string | null | undefined,
) {
  if (!scopeType && !scopeId) return;
  if (scopeType && !scopeId) {
    throw badRequest("scopeId is required when scopeType is set");
  }
  if (!scopeType && scopeId) {
    throw badRequest("scopeType is required when scopeId is set");
  }

  if (scopeType === "department" || scopeType === "project") {
    const row = await db
        .select({ id: projects.id, type: projects.type })
        .from(projects)
      .where(and(eq(projects.id, scopeId!), eq(projects.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) {
      throw badRequest(`${scopeType} with id '${scopeId}' not found`);
    }
    if (scopeType === "department" && row.type !== "department") {
      throw badRequest(`Scope references a project, not a department`);
    }
    if (scopeType === "project" && row.type !== "project") {
      throw badRequest(`Scope references a department, not a project`);
    }
  } else if (scopeType === "goal") {
    const row = await db
        .select({ id: goals.id })
        .from(goals)
      .where(and(eq(goals.id, scopeId!), eq(goals.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) {
      throw badRequest(`Goal with id '${scopeId}' not found`);
    }
  } else {
    throw badRequest(`Invalid scopeType '${scopeType}'`);
  }
}

async function validateEntryAttachments(
  db: Db,
  companyId: string,
  attachments: Array<{ assetId?: string | null; artifactId?: string | null }> | undefined,
) {
  const normalized = (attachments ?? []).filter((attachment) => attachment.assetId || attachment.artifactId);
  if (normalized.length === 0) return;

  const assetIds = [...new Set(normalized.map((attachment) => attachment.assetId).filter(Boolean) as string[])];
  const artifactIds = [...new Set(normalized.map((attachment) => attachment.artifactId).filter(Boolean) as string[])];

  if (assetIds.length > 0) {
    const ownedAssets = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(inArray(assets.id, assetIds), eq(assets.companyId, companyId)));
    if (ownedAssets.length !== assetIds.length) {
      throw badRequest("Attachment asset not found");
    }
  }

  if (artifactIds.length > 0) {
    const ownedArtifacts = await db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(and(inArray(artifacts.id, artifactIds), eq(artifacts.companyId, companyId)));
    if (ownedArtifacts.length !== artifactIds.length) {
      throw badRequest("Attachment artifact not found");
    }
  }
}

/**
 * Sentinel thrown inside addEntry's insert transaction when the entry insert
 * lost a same-key race (onConflictDoNothing returned no row). Aborting the
 * transaction rolls back the entrySeq/entryCount/lastEntryAt bump that ran
 * before the insert — committing it would drift the denormalized entryCount
 * (+1 with no entry) and burn a seq for a row that never landed (PR #291
 * review). Real drizzle rolls back and rethrows on a callback throw; the
 * caller catches this sentinel and re-selects the winner's row.
 */
class EntryInsertRaceLostError extends Error {
  constructor() {
    super("discussion entry insert lost a clientSubmissionId race");
    this.name = "EntryInsertRaceLostError";
  }
}

function isMemoryType(
  type: string,
): type is "decision" | "insight" | "context" | "reference" | "preference" {
  return ["decision", "insight", "context", "reference", "preference"].includes(
    type,
  );
}

/**
 * Minimal entry shape consumed by `emitEntryCreatedSideEffects`. Mirrors the
 * fields read off a freshly-inserted `discussion_entries` row — both `addEntry`'s
 * `entry` and `create()`'s `result.entry` satisfy this.
 */
interface EmittableEntry {
  id: string;
  discussionId: string;
  authorAgentId: string | null;
  inputType: string;
  createdBy: string;
  seq: number;
  rawContent: string;
}

type DiscussionRow = typeof discussions.$inferSelect;

async function enrichDiscussionListRows(
  db: Db,
  companyId: string,
  rows: DiscussionRow[],
) {
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return [];

  const projectScopeIds = [
    ...new Set(
      rows
        .filter(
          (row) =>
            row.scopeId &&
            (row.scopeType === "department" || row.scopeType === "project"),
        )
        .map((row) => row.scopeId!),
    ),
  ];
  const goalScopeIds = [
    ...new Set(
      rows
        .filter((row) => row.scopeId && row.scopeType === "goal")
        .map((row) => row.scopeId!),
    ),
  ];

  const projectScopes = projectScopeIds.length
    ? await db
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(and(inArray(projects.id, projectScopeIds), eq(projects.companyId, companyId)))
    : [];
  const goalScopes = goalScopeIds.length
    ? await db
        .select({ id: goals.id, title: goals.title })
        .from(goals)
        .where(and(inArray(goals.id, goalScopeIds), eq(goals.companyId, companyId)))
    : [];

  const scopeNames = new Map<string, string>();
  for (const scope of projectScopes) scopeNames.set(scope.id, scope.name);
  for (const scope of goalScopes) scopeNames.set(scope.id, scope.title);

  const participantRows = await db
    .select({
      threadId: threadParticipants.threadId,
      principalType: threadParticipants.principalType,
      principalId: threadParticipants.principalId,
      role: threadParticipants.role,
      addedAt: threadParticipants.addedAt,
      userName: authUsers.name,
      userEmail: authUsers.email,
      agentName: agents.name,
    })
    .from(threadParticipants)
    .leftJoin(authUsers, eq(threadParticipants.principalId, authUsers.id))
    .leftJoin(
      agents,
      and(
        eq(threadParticipants.principalId, sql`${agents.id}::text`),
        eq(agents.companyId, companyId),
      ),
    )
    .where(and(inArray(threadParticipants.threadId, ids), eq(threadParticipants.companyId, companyId)))
    .orderBy(asc(threadParticipants.addedAt));

  const participantsByThread = new Map<
    string,
    Array<{ principalType: "user" | "agent"; principalId: string; name: string; role: string }>
  >();
  for (const participant of participantRows) {
    const name =
      participant.principalType === "agent"
        ? participant.agentName ?? "Agent"
        : participant.userName ??
          (participant.userEmail ? participant.userEmail.split("@")[0] : participant.principalId);
    const list = participantsByThread.get(participant.threadId) ?? [];
    list.push({
      principalType: participant.principalType as "user" | "agent",
      principalId: participant.principalId,
      name,
      role: participant.role,
    });
    participantsByThread.set(participant.threadId, list);
  }

  const linkRows = await db
    .select({
      fromThreadId: threadLinks.fromThreadId,
      toThreadId: threadLinks.toThreadId,
    })
    .from(threadLinks)
    .where(
      and(
        eq(threadLinks.companyId, companyId),
        or(inArray(threadLinks.fromThreadId, ids), inArray(threadLinks.toThreadId, ids)),
      ),
    );

  const linkCountByThread = new Map<string, number>();
  for (const link of linkRows) {
    linkCountByThread.set(
      link.fromThreadId,
      (linkCountByThread.get(link.fromThreadId) ?? 0) + 1,
    );
    linkCountByThread.set(
      link.toThreadId,
      (linkCountByThread.get(link.toThreadId) ?? 0) + 1,
    );
  }

  const latestScopesByThread = await loadLatestScopeForThreadStages(db, companyId, ids);

  return rows.map((row) => {
    const participants = participantsByThread.get(row.id) ?? [];
    const latestScope = latestScopesByThread.get(row.id) ?? null;
    return {
      ...row,
      scopeName: row.scopeId ? scopeNames.get(row.scopeId) ?? null : null,
      participantPreview: participants.slice(0, 3),
      participantCount: participants.length,
      linkCount: linkCountByThread.get(row.id) ?? 0,
      derivedStage: deriveThreadStage({
        subtype: row.subtype,
        status: row.status,
        entrySeq: row.entrySeq ?? 0,
        latest: latestScope,
      }),
    };
  });
}

/**
 * Post-entry side effects shared by `addEntry` and `create()` (live-QA BUG-1).
 *
 * After a discussion entry is committed, both the add-entry path AND the
 * create-with-first-entry path must:
 *   1. publish the thread-scoped `thread.entry.created` poke (Plan 7) so live
 *      thread viewers refetch (RBAC-scoped fan-out keyed by `threadId`); and
 *   2. resolve whether the entry directly @mentions a kind='aoa' crew agent
 *      (Task 1.3 de-dup), then notify the thread-event listener's
 *      `onEntryCreated` so it can arm the 30s human-silence Adjutant debounce
 *      (skipping when `hasCrewMention` — the mentioned agent answers directly).
 *
 * Extracted DRY from `addEntry` so `create()` arms proactive crew engagement on
 * the FIRST message of a thread. Behavior-preserving for `addEntry`: same calls,
 * same order. The crew lookup runs only when `rawContent` actually contains an
 * @mention (no extra round-trip for plain chatter). Fire-and-forget: the
 * `onEntryCreated` promise is not awaited and its rejection is swallowed so the
 * caller's happy path is never blocked by listener failures.
 *
 * NOTE: the legacy company-scoped `discussion.entry.created` publish is NOT part
 * of this helper — both callers publish it inline (before invoking this helper)
 * so existing consumers of that event are unaffected and no double-publish occurs.
 */
async function emitEntryCreatedSideEffects(
  db: Db,
  companyId: string,
  entry: EmittableEntry,
): Promise<void> {
  // Plan 7: thread-scoped poke for the live thread view. Carries threadId so
  // the WS envelope-RBAC fan-out only delivers it to viewers who can see the
  // thread. The frontend refetches the thread (refetch-on-poke) using seq.
  publishLiveEvent({
    companyId,
    type: "thread.entry.created",
    payload: {
      threadId: entry.discussionId,
      entryId: entry.id,
      seq: entry.seq,
    },
  });

  // Task 1.3 — de-dup the double-drive. Resolve whether this entry directly
  // @mentions a kind='aoa' crew agent BEFORE notifying the listener. If it
  // does, that agent answers directly via the controller participation path
  // (processMentions → requestParticipation, Task 1.2), so the proactive
  // Adjutant debounce must NOT also arm on the same entry. We stamp
  // `hasCrewMention` onto the event and let onEntryCreated skip arming when
  // true. The lookup is a single lightweight `name IN (...)` query and only
  // runs when the text actually contains an @mention (no extra round-trip
  // for the common case of plain chatter).
  //
  // L5: short-circuit for non-human entries (agent self-posts, system, and
  // scope_proposal). `onEntryCreated` already rejects these via isHumanEntry
  // (thread-events.ts) — and `hasCrewMention` is only ever consumed to GATE that
  // human-entry debounce — so computing it for a non-human entry is wasted work
  // (parseMentions + the agents query). Mirror the isHumanEntry predicate here:
  // skip when an agent authored the entry or its inputType is a non-human signal.
  const isHuman =
    entry.authorAgentId === null &&
    entry.inputType !== "agent" &&
    entry.inputType !== "system" &&
    entry.inputType !== "scope_proposal";

  let hasCrewMention = false;
  // NOTE: this best-effort gate keeps the naive parseMentions tokenizer. A
  // multi-word crew mention ("@Memory Keeper") the SUMMON path resolves (round-13
  // #2, resolveMentionTargets) is NOT recognized here, so the proactive Adjutant
  // debounce may redundantly arm on that entry — the documented worst case is an
  // extra Adjutant wake (double-drive), never a lost summon. Making this
  // multi-word-aware would add a second per-entry roster query on the hot path;
  // it is deferred to the comment-wakeup/mention-resolution consolidation.
  const mentionNames = isHuman
    ? parseMentions(entry.rawContent).map((m) => m.name)
    : [];
  if (mentionNames.length > 0) {
    // Best-effort (PR #291 round-5 review): this lookup only GATES the proactive
    // Adjutant debounce (hasCrewMention). It runs AFTER the entry tx has
    // committed, and it is the only `await` here that can throw — a DB blip
    // would otherwise abort the caller (addEntry) *after* the durable entry
    // exists, so the route never reaches processMentions (the actual @agent
    // summon) and a same-key Retry replays past it, never summoning the agent.
    // Swallow so the entry's critical side-effects always run; the worst case is
    // an unnecessary Adjutant wake (double-drive), not a lost summon.
    try {
      const crewRows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.kind, "aoa"),
            inArray(agents.name, mentionNames),
          ),
        )
        .limit(1);
      hasCrewMention = crewRows.length > 0;
    } catch (err) {
      console.error("[threads] hasCrewMention lookup failed (best-effort):", err);
    }
  }

  // Task B2: notify the thread-event listener so it can debounce and wake
  // Adjutant 30s after the last *human* entry. The listener filters out
  // agent/system/scope_proposal entries internally — we pass everything and
  // let it decide. Fire-and-forget: any failure inside the listener is its
  // own concern (logged there) and must not block the caller's response.
  // getThreadEventListener() returns null in test/bootstrap contexts where
  // the singleton isn't initialized — that's expected, treat as no-op.
  const threadListener = getThreadEventListener();
  if (threadListener) {
    void threadListener
      .onEntryCreated({
        id: entry.id,
        discussionId: entry.discussionId,
        authorAgentId: entry.authorAgentId,
        inputType: entry.inputType,
        createdBy: entry.createdBy,
        hasCrewMention,
      })
      .catch(() => {
        // Listener already logs its own errors; we swallow here so the
        // caller's happy path is unaffected by listener failures.
      });
  }
}

export function discussionService(db: Db) {
  const issues = issueService(db);
  const memory = memoryService(db);

  return {
    /**
     * List discussions with optional filters.
     */
    list: async (companyId: string, filters: DiscussionFilters = {}) => {
      const conditions = [eq(discussions.companyId, companyId)];

      if (filters.status) {
        conditions.push(eq(discussions.status, filters.status));
      }
      if (filters.scopeType) {
        conditions.push(eq(discussions.scopeType, filters.scopeType));
      }
      if (filters.scopeId) {
        conditions.push(eq(discussions.scopeId, filters.scopeId));
      }
      if (filters.hasPendingItems === true) {
        conditions.push(sql`${discussions.pendingItemCount} > 0`);
      }
      if (filters.hasPendingItems === false) {
        conditions.push(sql`${discussions.pendingItemCount} = 0`);
      }

      let rows: DiscussionRow[];

      // If inputType filter is set, join with entries to filter
      if (filters.inputType) {
        const joinedRows = await db
          .selectDistinctOn([discussions.id])
          .from(discussions)
          .innerJoin(
            discussionEntries,
            eq(discussions.id, discussionEntries.discussionId),
          )
          .where(
            and(
              ...conditions,
              eq(discussionEntries.inputType, filters.inputType),
            ),
          )
          .orderBy(discussions.id, desc(discussions.lastEntryAt));

        rows = joinedRows.map((r) => r.discussions);
      } else {
        rows = await db
          .select()
          .from(discussions)
          .where(and(...conditions))
          .orderBy(desc(discussions.lastEntryAt));
      }

      return enrichDiscussionListRows(db, companyId, rows);
    },

    /**
     * Get a discussion by ID with entries and extracted items.
     */
    getById: async (companyId: string, id: string) => {
      const discussion = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (!discussion) return null;

      const entryRows = await db
        .select({
          entry: discussionEntries,
          authorAgentName: agents.name,
          authorAgentAvatar: agents.icon,
        })
        .from(discussionEntries)
        .leftJoin(agents, eq(discussionEntries.authorAgentId, agents.id))
        .where(eq(discussionEntries.discussionId, id))
        .orderBy(discussionEntries.createdAt);

      const entries = entryRows.map((r: { entry: typeof discussionEntries.$inferSelect; authorAgentName: string | null; authorAgentAvatar: string | null }) => ({
        ...r.entry,
        authorAgentName: r.authorAgentName ?? null,
        authorAgentAvatar: r.authorAgentAvatar ?? null,
      }));

      const entryIds = entries.map((e) => e.id);

      let items: (typeof discussionExtractedItems.$inferSelect)[] = [];
      let annotations: (typeof discussionAnnotations.$inferSelect)[] = [];
      // Phase E2: attachments joined via artifacts so the FE can render
      // inline artifact cards (title + type) without a second round-trip.
      let attachmentRows: Array<{
        id: string;
        discussionEntryId: string;
        assetId: string | null;
        artifactId: string | null;
        artifactType: string | null;
        artifactTitle: string | null;
        assetContentType: string | null;
        assetOriginalFilename: string | null;
        assetByteSize: number | null;
        artifactStatus: string | null;
        currentVersionStorageKind: string | null;
        currentVersionFilename: string | null;
        currentVersionContentType: string | null;
        currentVersionByteSize: number | null;
        currentVersionAssetId: string | null;
      }> = [];

      if (entryIds.length > 0) {
        items = await db
          .select()
          .from(discussionExtractedItems)
          .where(inArray(discussionExtractedItems.discussionEntryId, entryIds));

        annotations = await db
          .select()
          .from(discussionAnnotations)
          .where(inArray(discussionAnnotations.discussionEntryId, entryIds));

        attachmentRows = await db
          .select({
            id: discussionEntryAttachments.id,
            discussionEntryId: discussionEntryAttachments.discussionEntryId,
            assetId: discussionEntryAttachments.assetId,
            artifactId: discussionEntryAttachments.artifactId,
            artifactType: artifacts.type,
            artifactTitle: artifacts.title,
            assetContentType: assets.contentType,
            assetOriginalFilename: assets.originalFilename,
            assetByteSize: assets.byteSize,
            artifactStatus: artifacts.status,
            currentVersionStorageKind: artifactVersions.storageKind,
            currentVersionFilename: artifactVersions.filename,
            currentVersionContentType: artifactVersions.contentType,
            currentVersionByteSize: artifactVersions.byteSize,
            currentVersionAssetId: artifactVersions.assetId,
          })
          .from(discussionEntryAttachments)
          .leftJoin(
            artifacts,
            and(
              eq(discussionEntryAttachments.artifactId, artifacts.id),
              eq(artifacts.companyId, companyId),
            ),
          )
          .leftJoin(
            assets,
            and(
              eq(discussionEntryAttachments.assetId, assets.id),
              eq(assets.companyId, companyId),
            ),
          )
          .leftJoin(
            artifactVersions,
            and(
              eq(artifacts.currentVersionId, artifactVersions.id),
              eq(artifactVersions.artifactId, artifacts.id),
            ),
          )
          .where(inArray(discussionEntryAttachments.discussionEntryId, entryIds));
      }

      // Group items and annotations by entry for the frontend
      const itemsByEntry = new Map<string, typeof items>();
      for (const item of items) {
        const list = itemsByEntry.get(item.discussionEntryId) ?? [];
        list.push(item);
        itemsByEntry.set(item.discussionEntryId, list);
      }

      const annotationsByEntry = new Map<string, typeof annotations>();
      for (const ann of annotations) {
        const list = annotationsByEntry.get(ann.discussionEntryId) ?? [];
        list.push(ann);
        annotationsByEntry.set(ann.discussionEntryId, list);
      }

      const attachmentsByEntry = new Map<string, typeof attachmentRows>();
      for (const att of attachmentRows) {
        const list = attachmentsByEntry.get(att.discussionEntryId) ?? [];
        list.push(att);
        attachmentsByEntry.set(att.discussionEntryId, list);
      }

      const enrichedEntries = entries.map((e) => ({
        ...e,
        extractedItems: itemsByEntry.get(e.id) ?? [],
        annotations: annotationsByEntry.get(e.id) ?? [],
        attachments: (attachmentsByEntry.get(e.id) ?? []).map((a) => ({
          id: a.id,
          assetId: a.assetId,
          artifactId: a.artifactId,
          artifactType: a.artifactType,
          artifactTitle: a.artifactTitle,
          assetContentType: a.assetContentType,
          assetOriginalFilename: a.assetOriginalFilename,
          assetByteSize: a.assetByteSize,
          artifactStatus: a.artifactStatus,
          currentVersionStorageKind: a.currentVersionStorageKind,
          currentVersionFilename: a.currentVersionFilename,
          currentVersionContentType: a.currentVersionContentType,
          currentVersionByteSize: a.currentVersionByteSize,
          currentVersionAssetId: a.currentVersionAssetId,
        })),
      }));

      const planSteps = await db
        .select()
        .from(threadPlanSteps)
        .where(eq(threadPlanSteps.threadId, id))
        .orderBy(asc(threadPlanSteps.stepOrder))
        .then((rows: typeof threadPlanSteps.$inferSelect[]) => rows);

      // Phase 1 Phase E batch 2 (T22): static roster of thread_participants
      // with name resolution. principalType branches to authUsers (text id) or
      // agents (uuid stored as text). Both joins are LEFT so a stale row with
      // a deleted principal still surfaces with a fallback name.
      const participantRows = await db
        .select({
          principalType: threadParticipants.principalType,
          principalId: threadParticipants.principalId,
          role: threadParticipants.role,
          addedAt: threadParticipants.addedAt,
          userName: authUsers.name,
          userEmail: authUsers.email,
          agentName: agents.name,
        })
        .from(threadParticipants)
        .leftJoin(authUsers, eq(threadParticipants.principalId, authUsers.id))
        .leftJoin(
          agents,
          and(
            eq(threadParticipants.principalId, sql`${agents.id}::text`),
            eq(agents.companyId, companyId),
          ),
        )
        .where(and(eq(threadParticipants.threadId, id), eq(threadParticipants.companyId, companyId)))
        .orderBy(asc(threadParticipants.addedAt));

      const participants = participantRows.map((p) => {
        const fallback =
          p.principalType === "agent"
            ? p.agentName ?? "Agent"
            : p.userName ?? (p.userEmail ? p.userEmail.split("@")[0] : p.principalId);
        return {
          principalType: p.principalType as "user" | "agent",
          principalId: p.principalId,
          name: fallback,
          role: p.role,
          addedAt:
            p.addedAt instanceof Date
              ? p.addedAt.toISOString()
              : (p.addedAt as unknown as string),
        };
      });

      const latestScopesByThread = await loadLatestScopeForThreadStages(db, companyId, [id]);
      const latestScope = latestScopesByThread.get(id) ?? null;

      // PR-A2: surface the thread's coordination-level error so the founder sees when an agent
      // action didn't go through. Set on commit failure / circuit-breaker / runner-throw and
      // cleared on the next successful run, so the UI banner self-clears on recovery.
      const [orch] = await db
        .select({
          lastError: threadOrchestrationState.lastError,
          consecutiveCommitFailures: threadOrchestrationState.consecutiveCommitFailures,
        })
        .from(threadOrchestrationState)
        .where(eq(threadOrchestrationState.threadId, id))
        .limit(1);

      return {
        ...discussion,
        entries: enrichedEntries,
        planSteps,
        participants,
        derivedStage: deriveThreadStage({
          subtype: discussion.subtype,
          status: discussion.status,
          entrySeq: discussion.entrySeq ?? 0,
          latest: latestScope,
        }),
        lastError: orch?.lastError ?? null,
        consecutiveCommitFailures: orch?.consecutiveCommitFailures ?? 0,
      };
    },

    /**
     * Create a new discussion, optionally with a first entry.
     * Gotcha 1.1: validates scope if provided.
     * Gotcha 1.2: increments denormalized counts in same transaction.
     */
    create: async (
      companyId: string,
      data: {
        title?: string | null;
        scopeType?: string | null;
        scopeId?: string | null;
        tags?: string[];
        entry?: {
          inputType: string;
          rawContent: string;
          title?: string | null;
          departmentId?: string | null;
          projectId?: string | null;
          goalId?: string | null;
          sourceInfo?: Record<string, unknown> | null;
        };
      },
      actorId: string,
      // Round-15: the opening message's @mentions, resolved MULTI-WORD-aware by
      // the route BEFORE this call (round-14 #2, pre-commit). Threaded in so the
      // summon is enqueued in the SAME transaction as the first entry — a
      // committed first entry always carries a pending discussion_mention_outbox
      // row, exactly like addEntry. The outbox worker becomes the sole summon
      // path for this route too (the fire-and-forget processMentions is removed),
      // so a transient summon failure retries instead of permanently skipping the
      // mentioned agent.
      openingMentions?: Array<{ raw: string; name: string }>,
    ) => {
      await validateScope(db, companyId, data.scopeType, data.scopeId);

      const now = new Date();
      const hasEntry = !!data.entry;

      // Wrap in transaction to keep discussion + entry atomic (Gotcha 1.2)
      const result = await db.transaction(async (tx) => {
        const [discussion] = await tx
          .insert(discussions)
          .values({
            companyId,
            title: data.title ?? null,
            scopeType: data.scopeType ?? null,
            scopeId: data.scopeId ?? null,
            tags: data.tags ?? [],
            entryCount: hasEntry ? 1 : 0,
            // L8: when we seed a first entry, advance entrySeq to 1 so it stays
            // consistent with addEntry (which bumps entrySeq before each insert).
            // Without this the counter would stay at 0 while the first entry also
            // carried seq 0, and the NEXT addEntry would bump 0→1 and re-issue
            // seq 1 — a duplicate seq. Seeding entrySeq=1 here reserves seq 1 for
            // the first entry below.
            entrySeq: hasEntry ? 1 : 0,
            lastEntryAt: hasEntry ? now : null,
            createdBy: actorId,
            useControllerPath: true,   // P1-T11: new threads use orchestration controller path
          })
          .returning();

        let entry: typeof discussionEntries.$inferSelect | null = null;

        if (data.entry) {
          [entry] = await tx
            .insert(discussionEntries)
            .values({
              discussionId: discussion.id,
              inputType: data.entry.inputType,
              rawContent: data.entry.rawContent,
              title: data.entry.title ?? null,
              departmentId: data.entry.departmentId ?? null,
              projectId: data.entry.projectId ?? null,
              goalId: data.entry.goalId ?? null,
              sourceInfo: data.entry.sourceInfo ?? null,
              // QA-BUG-015: see addEntry — discuss-phase entries are not
              // auto-extracted; extraction is a deliberate done-phase /
              // Adjutant-judgment activity.
              extractionStatus: "skipped",
              // L8: first entry gets seq 1 (matches addEntry's first-entry seq),
              // so the BUG-1 proactive poke carries seq:1 and a catch-up
              // entriesSince(gt(seq, 0)) includes it instead of skipping it.
              seq: 1,
              createdBy: actorId,
            })
            .returning();

          // Round-15: enqueue the opening message's @mention summons IN THIS TX,
          // exactly as addEntry does — so a committed first entry always carries a
          // pending outbox row and the durable worker (multi-word resolution +
          // per-row claim + backoff, rounds 9/10/13/14) becomes the sole summon
          // path here too. Mentions were resolved pre-commit by the route
          // (round-14 #2). The opening entry is human-authored (createdBy=actorId,
          // authorAgentId null); mirror addEntry's hopCount derivation off
          // inputType so an agent-opened thread (if any) still caps the cascade.
          if (entry && openingMentions && openingMentions.length > 0) {
            const hopCount = data.entry.inputType === "agent" ? 1 : 0;
            await enqueueMentionOutbox(tx as unknown as Db, {
              companyId,
              discussionId: discussion.id,
              entryId: entry.id,
              mentions: openingMentions,
              hopCount,
            });
          }
        }

        return { ...discussion, entry };
      });

      // P1-T3: ensure a thread orchestration controller row exists for every
      // newly created thread. Best-effort — failure must not block thread
      // creation. The ensureController call uses onConflictDoNothing so it is
      // always safe to call; any error here is a monitoring concern only.
      void threadOrchestrationService(db)
        .ensureController(result.id)
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn(
            "[discussions.create] ensureController failed — thread created without controller",
            { threadId: result.id, err },
          );
        });

      // Side effects outside transaction
      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId,
        action: "discussion.created",
        entityType: "discussion",
        entityId: result.id,
        details: { title: result.title, hasEntry },
      });

      if (data.entry && result.entry) {
        publishLiveEvent({
          companyId,
          type: "discussion.entry.created",
          payload: {
            discussionId: result.id,
            entryId: result.entry.id,
            inputType: data.entry.inputType,
          },
        });

        // Live-QA BUG-1: a thread opened WITH a first message must arm proactive
        // crew engagement (and resolve @mentions) exactly like a follow-up entry
        // does. Run the same post-entry side effects addEntry runs — the
        // thread-scoped poke + crew-mention resolution + onEntryCreated debounce
        // arm. Without this the first message never wakes the Adjutant (until a
        // 2nd message) and an @mention in it is dropped. result.entry carries
        // rawContent + seq off the inserted row.
        await emitEntryCreatedSideEffects(db, companyId, {
          id: result.entry.id,
          discussionId: result.id,
          authorAgentId: result.entry.authorAgentId,
          inputType: result.entry.inputType,
          createdBy: result.entry.createdBy,
          seq: result.entry.seq,
          rawContent: result.entry.rawContent,
        });
      }

      return result;
    },

    /**
     * Update a discussion's title, status, scope, or tags.
     * Validates scope if changed. Follows goals.ts update pattern.
     */
    update: async (
      companyId: string,
      id: string,
      data: {
        title?: string | null;
        status?: string;
        scopeType?: string | null;
        scopeId?: string | null;
        tags?: string[];
        autonomyLevel?: number | null;
        // Phase 1 Phase E batch 2 (T22): visibility patch from OriginCard's
        // 3-option dropdown (private | department | company).
        visibility?: "private" | "department" | "company";
        // Phase G3 (T5, D6): per-thread Memory Keeper opt-out. Default true.
        allowMemoryExtraction?: boolean;
      },
    ) => {
      // Validate scope if being changed
      if (data.scopeType !== undefined || data.scopeId !== undefined) {
        // Need to merge with existing values for validation
        const existing = await db
          .select({
            scopeType: discussions.scopeType,
            scopeId: discussions.scopeId,
          })
          .from(discussions)
          .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
          .then((rows) => rows[0] ?? null);

        if (!existing) {
          throw notFound("Discussion not found");
        }

        const newScopeType = data.scopeType !== undefined ? data.scopeType : existing.scopeType;
        const newScopeId = data.scopeId !== undefined ? data.scopeId : existing.scopeId;
        await validateScope(db, companyId, newScopeType, newScopeId);
      }

      const [updated] = await db
        .update(discussions)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
        .returning();

      // Phase G1 (T7/D8): if this update archived the thread, mark any
      // thread-scoped workspaces eligible for cleanup immediately. The
      // generic PATCH /discussions/:id endpoint is the primary archive path
      // (merge has its own hook in threads.ts:merge). Best-effort —
      // workspace cleanup must never block the discussion update. Dynamic
      // import avoids the execution-workspaces → git → child_process chain
      // at module load time (see note above).
      if (updated && data.status === "archived") {
        try {
          const { markThreadWorkspacesForCleanup } = await import(
            "./workspace-ttl-sweeper.js"
          );
          await markThreadWorkspacesForCleanup(db, id);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            "[discussions.update] markThreadWorkspacesForCleanup failed",
            { id, err },
          );
        }

        // P3-T1: capture the closing thread's durable knowledge as Memory Keeper
        // proposals (founder-gated, status: pending) before it goes dormant.
        // Best-effort + idempotent — separate try/catch so a failure here never
        // blocks the archive or the workspace-cleanup hook above. Dynamic import
        // keeps the dispatcher/agent subtree off the discussions module-load path.
        try {
          const { enqueueMemoryExtractionOnClose } = await import(
            "./internal-agent/aoa-agents/memory-extraction-on-close.js"
          );
          await enqueueMemoryExtractionOnClose(db, companyId, id);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            "[discussions.update] enqueueMemoryExtractionOnClose failed",
            { id, err },
          );
        }
      }

      return updated ?? null;
    },

    /**
     * Add an entry to an existing discussion.
     * Entry is created with extractionStatus='pending'. The durable extraction sweeper
     * (server/src/index.ts, 45 s tick, M2 atomic claim) picks it up automatically.
     * "Reprocess" in the UI is a manual fast-path that bypasses the sweeper interval.
     * Updates lastEntryAt, publishes discussion.entry.created LiveEvent.
     * Gotcha 1.2: increments entryCount in same operation.
     */
    addEntry: async (
      companyId: string,
      discussionId: string,
      data: {
        inputType: string;
        rawContent: string;
        title?: string | null;
        departmentId?: string | null;
        projectId?: string | null;
        goalId?: string | null;
        sourceInfo?: Record<string, unknown> | null;
        parentEntryId?: string | null;
        authorAgentId?: string | null;
        sourceActionId?: string | null;
        clientSubmissionId?: string | null;
        attachments?: Array<{ assetId?: string | null; artifactId?: string | null }>;
      },
      actorId: string,
      authorizationActor?: Actor,
    ) => {
      if (data.authorAgentId && data.inputType !== "agent") {
        throw badRequest(
          "inputType must be 'agent' when authorAgentId is set",
        );
      }
      await validateEntryAttachments(db, companyId, data.attachments);

      // HTTP and agent entry points pass their resolved actor. Trusted internal
      // maintenance callers may omit it, but no externally reachable route may.
      if (authorizationActor) {
        await assertCanPostToThread(db, companyId, discussionId, authorizationActor);
      }

      // Verify discussion exists and belongs to company
      const discussion = await db
        .select()
        .from(discussions)
        .where(
          and(
            eq(discussions.id, discussionId),
            eq(discussions.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!discussion) {
        throw notFound("Discussion not found");
      }

      // Idempotent retry: a repeated Send (same key) replays the original entry
      // without bumping the seq/count counters or re-firing extraction/summon
      // side-effects. The partial unique index below is the concurrency backstop.
      const clientSubmissionId = data.clientSubmissionId ?? null;
      if (clientSubmissionId) {
        const existing = await db
          .select()
          .from(discussionEntries)
          .where(
            and(
              eq(discussionEntries.discussionId, discussionId),
              eq(discussionEntries.clientSubmissionId, clientSubmissionId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        // Replay: an entry for this key already exists. Flag it so the caller
        // skips route-level side-effects (processMentions → requestParticipation)
        // that the ORIGINAL post already fired — otherwise a same-key retry
        // double-summons the mentioned crew (PR #291 review, C4).
        if (existing) return { ...existing, replayed: true as const };
      }

      if (data.parentEntryId) {
        const parent = await db
          .select({ id: discussionEntries.id })
          .from(discussionEntries)
          .where(
            and(
              eq(discussionEntries.id, data.parentEntryId),
              eq(discussionEntries.discussionId, discussionId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!parent) {
          throw badRequest(
            "parentEntryId must reference an entry in the same discussion",
          );
        }
      }

      // Provenance boundary (PR #291 round-6 #2 security): a composer attachment
      // that references an ASSET must reference a VALIDATED composer upload —
      // otherwise a caller could upload via the unrestricted namespace=files path
      // (50MB, no allowlist, no byte sniff) and launder it into a discussion
      // attachment. Artifacts (artifactId) are versioned deliverables, not
      // uploads, and are exempt. Checked before the tx so the counter bump never
      // starts for a rejected request.
      if (data.attachments && data.attachments.length > 0) {
        const assetIds = data.attachments
          .map((a) => a.assetId)
          .filter((x): x is string => Boolean(x));
        if (assetIds.length > 0) {
          const validated = await db
            .select({ id: assets.id })
            .from(assets)
            .where(
              and(
                eq(assets.companyId, companyId),
                inArray(assets.id, assetIds),
                eq(assets.composerValidated, true),
              ),
            );
          const validatedIds = new Set(validated.map((r) => r.id));
          if (assetIds.some((id) => !validatedIds.has(id))) {
            throw badRequest("Attachment asset is not a validated composer upload");
          }
        }
      }

      const now = new Date();

      // Plan 7 (D1): assign a per-thread monotonic seq for catch-up. We bump the
      // atomic discussions.entrySeq counter with UPDATE ... RETURNING (atomic per
      // row, so concurrent inserts serialize on the discussions row) instead of
      // max(seq)+1, which races. The counter bump also carries the denormalized
      // count update (Gotcha 1.2) so both land in one statement.
      let entry: typeof discussionEntries.$inferSelect | undefined;
      try {
        entry = await db.transaction(async (tx) => {
          const [{ entrySeq }] = await tx
            .update(discussions)
            .set({
              entrySeq: sql`${discussions.entrySeq} + 1`,
              entryCount: sql`${discussions.entryCount} + 1`,
              lastEntryAt: now,
              updatedAt: now,
            })
            .where(eq(discussions.id, discussionId))
            .returning({ entrySeq: discussions.entrySeq });

          const [inserted] = await tx
            .insert(discussionEntries)
            .values({
              discussionId,
              inputType: data.inputType,
              rawContent: data.rawContent,
              title: data.title ?? null,
              departmentId: data.departmentId ?? null,
              projectId: data.projectId ?? null,
              goalId: data.goalId ?? null,
              sourceInfo: data.sourceInfo ?? null,
              parentEntryId: data.parentEntryId ?? null,
              authorAgentId: data.authorAgentId ?? null,
              // #197: idempotency anchor for action-gated commits; null for normal entries.
              sourceActionId: data.sourceActionId ?? null,
              clientSubmissionId,
              // QA-BUG-015: discuss-phase entries are NOT auto-extracted. Mark
              // 'skipped' so the (gated-off) durable drain never picks them up
              // and the UI doesn't show a misleading "pending extraction"
              // state. Extraction happens later, deliberately, via Memory
              // Keeper at phase=done or Adjutant's extract_memory_candidates.
              extractionStatus: "skipped",
              seq: entrySeq,
              createdBy: actorId,
            })
            // Concurrency backstop for the replay check above: a truly simultaneous
            // duplicate key resolves to one row via the partial unique index.
            // TARGETED at that index only (CI integration catch, 2026-07-16): an
            // unqualified DO NOTHING also swallowed source_action_id conflicts —
            // which the gated-commit machinery RELIES on throwing (#197
            // isUniqueViolation check) — and would silently drop a seq collision.
            // With the arbiter scoped, a NULL-key row can never match it, so all
            // other unique violations raise exactly as before.
            .onConflictDoNothing({
              target: [discussionEntries.discussionId, discussionEntries.clientSubmissionId],
              where: sql`client_submission_id IS NOT NULL`,
            })
            .returning();

          // Lost the same-key insert race → ABORT so the counter bump above
          // rolls back with the transaction. Only the client-submission arbiter
          // can swallow an insert (any other unique violation throws), so a
          // missing row here always means a simultaneous-duplicate loser.
          if (!inserted) {
            throw new EntryInsertRaceLostError();
          }

          // Phase E1: link attachments (assets or artifacts) to the entry in the
          // same transaction so the entry+attachments commit atomically.
          if (data.attachments && data.attachments.length > 0) {
            const rows = data.attachments
              .filter((a) => a.assetId || a.artifactId)
              .map((a) => ({
                discussionEntryId: inserted.id,
                assetId: a.assetId ?? null,
                artifactId: a.artifactId ?? null,
              }));
            if (rows.length > 0) {
              await tx.insert(discussionEntryAttachments).values(rows);
            }
          }

          // Transactional outbox for @mention summons (PR #291 round-6 #3):
          // enqueue the summon IN THE SAME TX as the entry, so a committed entry
          // always carries a pending summon. The drain worker runs processMentions
          // exactly once — replacing the route-level fire-and-forget call that was
          // lost on failure and skipped by a same-key replay. This is now the SOLE
          // summon path for addEntry callers (round-8 #1): the internal writers
          // (post-entry-tool / thread-agent-actions) no longer call processMentions
          // directly, so there is no double-summon.
          // Round-13 #2: resolve mentions MULTI-WORD-aware against the company
          // agent roster (mirrors findMentionedAgents) — the naive parseMentions
          // \w+ tokenizer truncates "@Memory Keeper" → "Memory", which the outbox
          // worker (this is now the SOLE summon path) can never resolve, silently
          // dropping the summon of every multi-word-named crew agent.
          const outboxMentions = await resolveMentionTargets(
            tx as unknown as Db,
            companyId,
            data.rawContent ?? "",
          );
          if (outboxMentions.length > 0) {
            // Preserve the { hopCount: 1 } the internal agent writers used to pass
            // directly (round-8 #1): an agent-authored entry's mentions start one
            // hop into the cascade so MAX_HOP_COUNT caps a chain the same way; a
            // human entry starts at 0. (inputType 'agent' or an authorAgentId both
            // mark an agent-authored reply.)
            const hopCount =
              data.authorAgentId != null || data.inputType === "agent" ? 1 : 0;
            await enqueueMentionOutbox(tx as unknown as Db, {
              companyId,
              discussionId,
              entryId: inserted.id,
              mentions: outboxMentions,
              hopCount,
            });
          }

          return inserted;
        });
      } catch (err) {
        if (!(err instanceof EntryInsertRaceLostError)) throw err;
        entry = undefined;
      }

      // Lost the insert race → the winning entry already fired its side-effects.
      // Return it without re-publishing events, re-arming crew, or re-logging.
      // (Only the client-submission arbiter can swallow the insert, so the key
      // is always non-null on this path.)
      if (!entry) {
        if (!clientSubmissionId) {
          throw new Error(
            "discussion entry insert returned no row without a clientSubmissionId",
          );
        }
        // Race loser: the winner already fired the entry's side-effects. Flag
        // the replay so the caller skips processMentions et al. (PR #291, C4).
        return db
          .select()
          .from(discussionEntries)
          .where(
            and(
              eq(discussionEntries.discussionId, discussionId),
              eq(discussionEntries.clientSubmissionId, clientSubmissionId),
            ),
          )
          .then((rows) => ({ ...rows[0], replayed: true as const }));
      }

      publishLiveEvent({
        companyId,
        type: "discussion.entry.created",
        payload: {
          discussionId,
          entryId: entry.id,
          inputType: data.inputType,
        },
      });

      // Plan 7 + Task 1.3 + Task B2 — thread-scoped poke, crew-mention
      // resolution, and the proactive Adjutant debounce arm. DRY-extracted into
      // emitEntryCreatedSideEffects so create()'s first-entry path runs the
      // identical wiring (live-QA BUG-1). Behavior-preserving for addEntry:
      // same publish, same crew lookup, same fire-and-forget onEntryCreated.
      await emitEntryCreatedSideEffects(db, companyId, {
        id: entry.id,
        discussionId: entry.discussionId,
        authorAgentId: entry.authorAgentId,
        inputType: entry.inputType,
        createdBy: entry.createdBy,
        seq: entry.seq,
        rawContent: data.rawContent,
      });

      // Design §4.9 + §5 (locked): the `discuss` phase is a pure conversation
      // between humans and the crew (Adjutant facilitating, delegating to
      // Scout / Engineer / Navigator). Structured extraction is NOT a
      // fire-on-every-entry behaviour — "Scribe is ELIMINATED" and the
      // extraction logic now runs only as deliberate tool calls:
      //   - Memory Keeper at `phase=done` (extract_decisions / _insights /
      //     _references → propose_memory), the canonical path; and
      //   - Adjutant mid-`discuss` IF it judges something was decided, via
      //     extract_memory_candidates (its own call, not automatic).
      // The previous unconditional extractFromDiscussionEntry call here made
      // Scribe run on every message and dumped decision/task/insight cards
      // into the Scope tab while humans were still talking — premature and
      // against the design (QA-BUG-015). Removed. The thread-event listener
      // above still wakes Adjutant after the 30s human-silence debounce so
      // the conversation moves forward; extraction waits for the right phase.

      // Best-effort (PR #291 round-5 review): the entry is already durable, and
      // the route's processMentions summon still needs to run — an activity-log
      // DB blip must not throw out of addEntry after commit (which would 500 the
      // request and let a Retry replay past the summon). Audit-only; swallow.
      try {
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId,
          action: "discussion.entry.added",
          entityType: "discussion_entry",
          entityId: entry.id,
          details: { discussionId, inputType: data.inputType },
        });
      } catch (err) {
        console.error("[threads] discussion.entry.added activity log failed (best-effort):", err);
      }

      return entry;
    },

    getEntryByClientSubmissionId: async (
      discussionId: string,
      clientSubmissionId: string,
    ) => {
      return db
        .select()
        .from(discussionEntries)
        .where(
          and(
            eq(discussionEntries.discussionId, discussionId),
            eq(discussionEntries.clientSubmissionId, clientSubmissionId),
          ),
        )
        .then((rows) => rows[0] ?? null);
    },

    /**
     * Approve extracted items — atomic transaction.
     * For task items: creates issue. For memory items: creates memoryItem.
     * Sets status='approved', links resultTaskId/resultMemoryId.
     * Decrements pendingItemCount.
     */
    approveItems: async (
      companyId: string,
      discussionId: string,
      itemIds: string[],
      actorId: string,
    ) => {
      if (itemIds.length === 0) {
        throw badRequest("No items to approve");
      }

      // Verify discussion exists
      const discussion = await db
        .select()
        .from(discussions)
        .where(
          and(
            eq(discussions.id, discussionId),
            eq(discussions.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!discussion) {
        throw notFound("Discussion not found");
      }

      const result = await db.transaction(async (tx) => {
        const itemRows = await tx
          .select()
          .from(discussionExtractedItems)
          .where(inArray(discussionExtractedItems.id, itemIds));

        if (itemRows.length !== itemIds.length) {
          throw badRequest("Some item IDs not found");
        }

        // Verify all items belong to entries in this discussion
        const entryIds = [...new Set(itemRows.map((i) => i.discussionEntryId))];
        const entries = await tx
          .select({ id: discussionEntries.id })
          .from(discussionEntries)
          .where(
            and(
              inArray(discussionEntries.id, entryIds),
              eq(discussionEntries.discussionId, discussionId),
            ),
          );

        if (entries.length !== entryIds.length) {
          throw badRequest(
            "Some items do not belong to this discussion",
          );
        }

        const createdTaskIds: string[] = [];
        const createdMemoryIds: string[] = [];
        let approvedCount = 0;

        for (const item of itemRows) {
          if (item.status === "approved") continue; // already approved

          if (item.type === "task") {
            const task = await issues.create(
              companyId,
              {
                title: item.title,
                description: item.description,
                priority: item.priority ?? item.suggestedPriority ?? "medium",
                source: "discussion",
                projectId:
                  item.suggestedDepartmentId ??
                  item.suggestedProjectId ??
                  undefined,
                goalId: item.suggestedGoalId ?? undefined,
                assigneeAgentId: item.suggestedAssigneeId ?? undefined,
                status: item.suggestedAssigneeId ? "todo" : "backlog",
              },
              tx,
            );

            if (task) {
              createdTaskIds.push(task.id);
              await tx
                .update(discussionExtractedItems)
                .set({
                  status: "approved",
                  resultTaskId: task.id,
                  updatedAt: new Date(),
                })
                .where(eq(discussionExtractedItems.id, item.id));
              approvedCount++;
            }
          } else if (isMemoryType(item.type)) {
            const layer = item.layer ?? item.suggestedLayer ?? "domain";
            const content = item.mergedContent?.trim() || item.description?.trim() || item.title;

            const memoryItem = await memory.create(
              companyId,
              {
                title: item.title,
                content,
                category: item.type,
                source: "discussion",
                status: "approved",
                departmentId: item.suggestedDepartmentId ?? null,
                projectId: item.suggestedProjectId ?? null,
                createdBy: actorId,
                layer,
                goalId: item.suggestedGoalId ?? null,
              },
              tx,
            );

            if (memoryItem) {
              createdMemoryIds.push(memoryItem.id);
              await tx
                .update(discussionExtractedItems)
                .set({
                  status: "approved",
                  resultMemoryId: memoryItem.id,
                  updatedAt: new Date(),
                })
                .where(eq(discussionExtractedItems.id, item.id));
              approvedCount++;
            }
          }
        }

        // Gotcha 1.2: decrement pendingItemCount
        if (approvedCount > 0) {
          await tx
            .update(discussions)
            .set({
              pendingItemCount: sql`GREATEST(${discussions.pendingItemCount} - ${approvedCount}, 0)`,
              updatedAt: new Date(),
            })
            .where(eq(discussions.id, discussionId));
          await hubItemsService(tx as unknown as Db).reconcile(companyId, {
            sourceType: "discussion",
            sourceId: discussionId,
          });
        }

        return { createdTaskIds, createdMemoryIds, approvedCount };
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId,
        action: "discussion.items.approved",
        entityType: "discussion",
        entityId: discussionId,
        details: { approvedCount: result.approvedCount, createdTaskIds: result.createdTaskIds, createdMemoryIds: result.createdMemoryIds },
      });

      return result;
    },

    /**
     * Reject extracted items. Sets status='rejected', decrements pendingItemCount.
     */
    rejectItems: async (
      companyId: string,
      discussionId: string,
      itemIds: string[],
      actorId: string,
    ) => {
      if (itemIds.length === 0) {
        throw badRequest("No items to reject");
      }

      // Verify discussion
      const discussion = await db
        .select()
        .from(discussions)
        .where(
          and(
            eq(discussions.id, discussionId),
            eq(discussions.companyId, companyId),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!discussion) {
        throw notFound("Discussion not found");
      }

      // Verify items belong to this discussion
      const itemRows = await db
        .select({
          id: discussionExtractedItems.id,
          entryId: discussionExtractedItems.discussionEntryId,
        })
        .from(discussionExtractedItems)
        .where(inArray(discussionExtractedItems.id, itemIds));

      if (itemRows.length > 0) {
        const entryIds = [...new Set(itemRows.map((i) => i.entryId))];
        const entries = await db
          .select({ id: discussionEntries.id })
          .from(discussionEntries)
          .where(
            and(
              inArray(discussionEntries.id, entryIds),
              eq(discussionEntries.discussionId, discussionId),
            ),
          );
        if (entries.length !== entryIds.length) {
          throw badRequest("Some items do not belong to this discussion");
        }
      }

      const rejectedCount = await db.transaction(async (tx) => {
        const updated = await tx
          .update(discussionExtractedItems)
          .set({ status: "rejected", updatedAt: new Date() })
          .where(
            and(
              inArray(discussionExtractedItems.id, itemIds),
              eq(discussionExtractedItems.status, "pending"),
            ),
          )
          .returning();

        const count = updated.length;
        if (count > 0) {
          await tx
            .update(discussions)
            .set({
              pendingItemCount: sql`GREATEST(${discussions.pendingItemCount} - ${count}, 0)`,
              updatedAt: new Date(),
            })
            .where(eq(discussions.id, discussionId));
          await hubItemsService(tx as unknown as Db).reconcile(companyId, {
            sourceType: "discussion",
            sourceId: discussionId,
          });
        }
        return count;
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId,
        action: "discussion.items.rejected",
        entityType: "discussion",
        entityId: discussionId,
        details: { rejectedCount, itemIds },
      });

      return { rejectedCount };
    },

    /**
     * Update an extracted item's fields (founder edits during review).
     * Gotcha 1.4: sets status to 'edited' so it's included in "Confirm All".
     */
    updateItem: async (
      companyId: string,
      itemId: string,
      data: Partial<
        Pick<
          typeof discussionExtractedItems.$inferInsert,
          | "title"
          | "description"
          | "type"
          | "priority"
          | "layer"
          | "dedupAction"
          | "selectedMemoryId"
          | "mergedContent"
          | "suggestedAssigneeId"
          | "suggestedDepartmentId"
          | "suggestedProjectId"
          | "suggestedGoalId"
        >
      >,
    ) => {
      // Verify item exists and belongs to company's discussion
      const item = await db
        .select({
          id: discussionExtractedItems.id,
          discussionEntryId: discussionExtractedItems.discussionEntryId,
        })
        .from(discussionExtractedItems)
        .where(eq(discussionExtractedItems.id, itemId))
        .then((rows) => rows[0] ?? null);

      if (!item) {
        throw notFound("Extracted item not found");
      }

      // Verify entry's discussion belongs to this company
      const entry = await db
        .select({ discussionId: discussionEntries.discussionId })
        .from(discussionEntries)
        .where(eq(discussionEntries.id, item.discussionEntryId))
        .then((rows) => rows[0] ?? null);

      if (entry) {
        const disc = await db
          .select({ companyId: discussions.companyId })
          .from(discussions)
          .where(eq(discussions.id, entry.discussionId))
          .then((rows) => rows[0] ?? null);

        if (!disc || disc.companyId !== companyId) {
          throw notFound("Extracted item not found");
        }
      }

      // Gotcha 1.4: editing sets status to 'edited'
      const [updated] = await db
        .update(discussionExtractedItems)
        .set({ ...data, status: "edited", updatedAt: new Date() })
        .where(eq(discussionExtractedItems.id, itemId))
        .returning();

      return updated;
    },

    /**
     * Reprocess an entry: reset extraction status, delete extracted items, trigger re-extraction.
     */
    reprocessEntry: async (companyId: string, entryId: string) => {
      // Verify entry belongs to company
      const entry = await db
        .select()
        .from(discussionEntries)
        .where(eq(discussionEntries.id, entryId))
        .then((rows) => rows[0] ?? null);

      if (!entry) {
        throw notFound("Entry not found");
      }

      const disc = await db
        .select({ companyId: discussions.companyId })
        .from(discussions)
        .where(eq(discussions.id, entry.discussionId))
        .then((rows) => rows[0] ?? null);

      if (!disc || disc.companyId !== companyId) {
        throw notFound("Entry not found");
      }

      // P1-T7: a scope_proposal is not an extractable prose entry. Reprocessing
      // it would reset its extractionStatus and feed the proposal JSON to the
      // LLM extractor. Refuse — proposals are approved via the proposals/approve
      // route, not the extraction pipeline.
      if (entry.inputType === "scope_proposal") {
        throw badRequest("Scope proposals cannot be reprocessed for extraction.");
      }

      await db.transaction(async (tx) => {
        const approvedItems = await tx
          .select({ id: discussionExtractedItems.id })
          .from(discussionExtractedItems)
          .where(
            and(
              eq(discussionExtractedItems.discussionEntryId, entryId),
              eq(discussionExtractedItems.status, "approved"),
            ),
          );

        if (approvedItems.length > 0) {
          throw badRequest(
            "Cannot reprocess entry with approved items. Approved items have linked tasks/memory that would be orphaned.",
          );
        }

        const deletedItems = await tx
          .delete(discussionExtractedItems)
          .where(
            and(
              eq(discussionExtractedItems.discussionEntryId, entryId),
              inArray(discussionExtractedItems.status, ["pending", "edited", "rejected"]),
            ),
          )
          .returning({ status: discussionExtractedItems.status });
        const deletedReviewableCount = deletedItems.filter((item) => item.status === "pending" || item.status === "edited").length;

        // Reset extraction status
        await tx
          .update(discussionEntries)
          .set({ extractionStatus: "pending", extractionRunId: null })
          .where(eq(discussionEntries.id, entryId));

        // Reprocess reset (Task 10, D3): the entry is no longer 'failed', so any
        // extraction_failed inbox item for it is stale — archive it now (the
        // discussion_entry reconciler is terminal for non-failed entries) rather
        // than waiting for the async re-extraction to succeed.
        await hubItemsService(tx as unknown as Db).reconcile(companyId, {
          sourceType: "discussion_entry",
          sourceId: entryId,
        });

        // Update pending count on discussion
        if (deletedReviewableCount > 0) {
          await tx
            .update(discussions)
            .set({
              pendingItemCount: sql`GREATEST(${discussions.pendingItemCount} - ${deletedReviewableCount}, 0)`,
              updatedAt: new Date(),
            })
            .where(eq(discussions.id, entry.discussionId));
          await hubItemsService(tx as unknown as Db).reconcile(companyId, {
            sourceType: "discussion",
            sourceId: entry.discussionId,
          });
        }
      });

      // Trigger re-extraction via the event pipeline
      publishLiveEvent({
        companyId,
        type: "discussion.entry.created",
        payload: { discussionId: entry.discussionId, entryId },
      });

      // Trigger extraction directly (fire-and-forget)
      import("./extraction.js")
        .then(({ extractionService }) => {
          extractionService(db)
            .extractFromDiscussionEntry(companyId, entryId)
            .catch(() => {}); // errors handled internally
        })
        .catch(() => {}); // module load error — swallow

      return { entryId, extractionStatus: "pending" as const };
    },

    /**
     * Reprocess all failed/pending/skipped entries in a discussion.
     */
    reprocessAllEntries: async (companyId: string, discussionId: string) => {
      // Verify discussion belongs to company
      const disc = await db
        .select({ id: discussions.id, companyId: discussions.companyId })
        .from(discussions)
        .where(and(eq(discussions.id, discussionId), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);

      if (!disc) {
        throw notFound("Discussion not found");
      }

      // Fetch entries that need reprocessing
      const entries = await db
        .select()
        .from(discussionEntries)
        .where(eq(discussionEntries.discussionId, discussionId));

      const reprocessable = entries.filter(
        (e) =>
          // P1-T7: never re-extract a scope_proposal. Proposals are stored with
          // extractionStatus="skipped" (so they don't auto-extract) and carry
          // their approval lifecycle in proposalStatus. Without this guard,
          // reprocessAllEntries would reset a pending/rejected proposal's
          // extractionStatus to "pending" and feed the proposal JSON to the
          // LLM extractor — corrupting state and burning budget.
          e.inputType !== "scope_proposal" &&
          (e.extractionStatus === "failed" ||
            e.extractionStatus === "pending" ||
            e.extractionStatus === "skipped"),
      );

      let reprocessedCount = 0;
      let skippedCount = 0;
      let deletedPendingCount = 0;
      const entriesToTrigger: Array<typeof discussionEntries.$inferSelect> = [];

      await db.transaction(async (tx) => {
        for (const entry of reprocessable) {
          const approvedItems = await tx
            .select({ id: discussionExtractedItems.id })
            .from(discussionExtractedItems)
            .where(
              and(
                eq(discussionExtractedItems.discussionEntryId, entry.id),
                eq(discussionExtractedItems.status, "approved"),
              ),
            );

          if (approvedItems.length > 0) {
            skippedCount++;
            continue;
          }

          const deletedItems = await tx
            .delete(discussionExtractedItems)
            .where(
              and(
                eq(discussionExtractedItems.discussionEntryId, entry.id),
                inArray(discussionExtractedItems.status, ["pending", "edited", "rejected"]),
              ),
            )
            .returning({ status: discussionExtractedItems.status });
          deletedPendingCount += deletedItems.filter((item) => item.status === "pending" || item.status === "edited").length;

          await tx
            .update(discussionEntries)
            .set({ extractionStatus: "pending", extractionRunId: null })
            .where(eq(discussionEntries.id, entry.id));

          // Reprocess reset (Task 10, D3): archive any stale extraction_failed
          // inbox item for this entry (now non-failed → reconciler terminal).
          await hubItemsService(tx as unknown as Db).reconcile(companyId, {
            sourceType: "discussion_entry",
            sourceId: entry.id,
          });

          reprocessedCount++;
          entriesToTrigger.push(entry);
        }

        // Update pending count on discussion
        if (deletedPendingCount > 0) {
          await tx
            .update(discussions)
            .set({
              pendingItemCount: sql`GREATEST(${discussions.pendingItemCount} - ${deletedPendingCount}, 0)`,
              updatedAt: new Date(),
            })
            .where(eq(discussions.id, discussionId));
          await hubItemsService(tx as unknown as Db).reconcile(companyId, {
            sourceType: "discussion",
            sourceId: discussionId,
          });
        }
      });

      for (const entry of entriesToTrigger) {
        publishLiveEvent({
          companyId,
          type: "discussion.entry.created",
          payload: { discussionId, entryId: entry.id },
        });

        import("./extraction.js")
          .then(({ extractionService }) => {
            extractionService(db)
              .extractFromDiscussionEntry(companyId, entry.id)
              .catch(() => {});
          })
          .catch(() => {});
      }

      return { reprocessedCount, skippedCount };
    },

    /**
     * Add an annotation to an entry.
     */
    addAnnotation: async (
      companyId: string,
      entryId: string,
      data: {
        content: string;
        anchorStart?: number | null;
        anchorEnd?: number | null;
      },
      actorId: string,
    ) => {
      // Verify entry belongs to company
      const entry = await db
        .select({ discussionId: discussionEntries.discussionId })
        .from(discussionEntries)
        .where(eq(discussionEntries.id, entryId))
        .then((rows) => rows[0] ?? null);

      if (!entry) {
        throw notFound("Entry not found");
      }

      const disc = await db
        .select({ companyId: discussions.companyId })
        .from(discussions)
        .where(eq(discussions.id, entry.discussionId))
        .then((rows) => rows[0] ?? null);

      if (!disc || disc.companyId !== companyId) {
        throw notFound("Entry not found");
      }

      const [annotation] = await db
        .insert(discussionAnnotations)
        .values({
          discussionEntryId: entryId,
          content: data.content,
          anchorStart: data.anchorStart ?? null,
          anchorEnd: data.anchorEnd ?? null,
          createdBy: actorId,
        })
        .returning();

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId,
        action: "discussion.annotation.added",
        entityType: "discussion_annotation",
        entityId: annotation.id,
        details: { entryId, discussionId: entry.discussionId },
      });

      return annotation;
    },

    /**
     * Link an entry to a different discussion (move between threads).
     */
    linkEntry: async (
      companyId: string,
      entryId: string,
      targetDiscussionId: string,
    ) => {
      // Verify entry exists
      const entry = await db
        .select()
        .from(discussionEntries)
        .where(eq(discussionEntries.id, entryId))
        .then((rows) => rows[0] ?? null);

      if (!entry) {
        throw notFound("Entry not found");
      }

      const sourceDiscussionId = entry.discussionId;
      if (sourceDiscussionId === targetDiscussionId) {
        throw badRequest("Entry already belongs to this discussion");
      }

      // A-H7 (Codex P2): moving a reply would leave its parentEntryId pointing at
      // an entry that stays in the OLD thread — a cross-thread parent pointer that
      // breaks the same-discussion-parent invariant addEntry enforces and corrupts
      // reply nesting in the target. REJECT rather than clear: clearing would
      // silently promote the reply to a root entry and lose the conversation
      // structure the founder presumably wants to preserve. The founder can move
      // (or unlink) the parent first, then move the reply.
      if (entry.parentEntryId) {
        throw badRequest("Cannot move a reply; move or unlink its parent");
      }

      // Verify both discussions belong to company
      const [sourceDisc, targetDisc] = await Promise.all([
        db
          .select()
          .from(discussions)
          .where(
            and(
              eq(discussions.id, sourceDiscussionId),
              eq(discussions.companyId, companyId),
            ),
          )
          .then((rows) => rows[0] ?? null),
        db
          .select()
          .from(discussions)
          .where(
            and(
              eq(discussions.id, targetDiscussionId),
              eq(discussions.companyId, companyId),
            ),
          )
          .then((rows) => rows[0] ?? null),
      ]);

      if (!sourceDisc) throw notFound("Source discussion not found");
      if (!targetDisc) throw notFound("Target discussion not found");

      return db.transaction(async (tx) => {
        // Count pending items for this entry to move counts
        const pendingItems = await tx
          .select({ id: discussionExtractedItems.id })
          .from(discussionExtractedItems)
          .where(
            and(
              eq(discussionExtractedItems.discussionEntryId, entryId),
              eq(discussionExtractedItems.status, "pending"),
            ),
          );
        const pendingCount = pendingItems.length;

        const now = new Date();

        // A-H7: the moved entry's `seq` is meaningless in the target's
        // independent seq space — keeping the source seq either collides with an
        // existing target entry (partial UNIQUE (discussion_id, seq) WHERE seq<>0
        // → Postgres 23505) or silently shadows the target's next addEntry seq.
        // Allocate a FRESH target seq atomically, exactly like addEntry: bump the
        // target's entry_seq counter with UPDATE ... RETURNING (atomic per row, so
        // concurrent moves/inserts serialize on the discussions row) and carry the
        // denormalized count/lastEntryAt bumps in the same statement.
        const [{ entrySeq: targetSeq }] = await tx
          .update(discussions)
          .set({
            entrySeq: sql`${discussions.entrySeq} + 1`,
            entryCount: sql`${discussions.entryCount} + 1`,
            pendingItemCount: sql`${discussions.pendingItemCount} + ${pendingCount}`,
            lastEntryAt: now,
            updatedAt: now,
          })
          .where(eq(discussions.id, targetDiscussionId))
          .returning({ entrySeq: discussions.entrySeq });

        // Move entry into the target thread AND reassign its seq to the freshly
        // allocated target seq, in the same statement.
        await tx
          .update(discussionEntries)
          .set({ discussionId: targetDiscussionId, seq: targetSeq })
          .where(eq(discussionEntries.id, entryId));

        // Update source discussion counts
        await tx
          .update(discussions)
          .set({
            entryCount: sql`GREATEST(${discussions.entryCount} - 1, 0)`,
            pendingItemCount: sql`GREATEST(${discussions.pendingItemCount} - ${pendingCount}, 0)`,
            updatedAt: now,
          })
          .where(eq(discussions.id, sourceDiscussionId));
        if (pendingCount > 0) {
          const [target] = await tx
            .select()
            .from(discussions)
            .where(eq(discussions.id, targetDiscussionId));
          if (target) {
            await emitHubItem(tx as unknown as Db, buildDiscussionPendingHubEmit(target));
          }
          await hubItemsService(tx as unknown as Db).reconcile(companyId, {
            sourceType: "discussion",
            sourceId: sourceDiscussionId,
          });
          await hubItemsService(tx as unknown as Db).reconcile(companyId, {
            sourceType: "discussion",
            sourceId: targetDiscussionId,
          });
        }

        return { entryId, sourceDiscussionId, targetDiscussionId };
      });
    },
  };
}
