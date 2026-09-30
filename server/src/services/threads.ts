/**
 * Thread service — lifecycle, ownership, visibility, phase state machine.
 *
 * Threads v1 Plan 2: backend service layer.
 *
 * Key architectural constraints:
 * - RBAC hide-don't-403: private/unclaimed threads throw notFound, never forbidden
 * - Agents never own threads (resolveOwnerOnAction guards this)
 * - D8: issues created from scope items use workMode="planning" (suppresses dispatch)
 * - Goals are a multi-parent DAG (Decision #20 superseded 2026-05-25); integrity enforced on write (cycles + child⊆parent scope)
 * - D4 batched RBAC: list() uses 2 queries, not 2N
 */

import { and, eq, desc, asc, gt, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  discussions,
  threadParticipants,
  threadLinks,
  userRoles,
  discussionEntries,
  discussionExtractedItems,
  scopeItemDependencies,
  taskDependencies,
  issues,
  agents,
  authUsers,
  companyMemberships,
  agentWakeupRequests,
  aoaAgentTriggers,
  threadPlanSteps,
  internalAgentConfig,
} from "@armyofagents/db";
import { badRequest, notFound } from "../errors.js";
import { publishLiveEvent } from "./live-events.js";
import { hubItemsService } from "./hub-items.js";
import { logActivity } from "./activity-log.js";
import { goalService } from "./goals.js";
// NOTE: crew-task-service is imported dynamically inside advancePhase() to keep
// the top-level import graph free of crew-task-service → heartbeat →
// execution-workspaces → git → child_process. Several test suites (notably
// threads-mention.test.ts and cli-mode.test.ts) partially mock @armyofagents/db
// or node:child_process and the eager import causes their indirect resolution
// chain to fail at module-collection time.
//
// NOTE: workspace-ttl-sweeper is imported dynamically in `merge()` to keep
// the top-level import graph free of execution-workspaces → git → child_process.
// Several test suites (notably cli-mode.test.ts) partially mock node:child_process
// and the eager import causes their indirect resolution chain to fail.
import {
  THREAD_PHASES,
  THREAD_LINK_KINDS,
  type ThreadPhase,
  type ThreadLinkKind,
  type ThreadVisibility,
  type ThreadOriginSource,
  type ThreadOriginMedium,
} from "@armyofagents/shared";

// ── Pure helpers (no DB) ─────────────────────────────────────────────────────

/**
 * Forward by exactly one phase (auto-advance) or any backward jump (founder override).
 * Unknown phases always return false.
 */
export function canAdvancePhase(current: ThreadPhase, target: ThreadPhase): boolean {
  const ci = THREAD_PHASES.indexOf(current);
  const ti = THREAD_PHASES.indexOf(target);
  if (ci < 0 || ti < 0) return false;
  // Forward: must be exactly one step ahead
  // Backward: any backward jump allowed (founder override)
  return ti === ci + 1 || ti < ci;
}

/**
 * "Owned by action": returns the userId that should become owner after a
 * governance action, or null to leave ownership unchanged.
 * Agents can never become owners.
 */
export function resolveOwnerOnAction(
  thread: { ownerUserId: string | null },
  actor: { userId: string; isHuman: boolean },
): string | null {
  if (thread.ownerUserId != null) return null; // already owned — no change
  if (!actor.isHuman) return null; // agents never own
  return actor.userId;
}

export interface ThreadViewer {
  role: "founder" | "team_lead" | "team_member";
  hasScopeAccess: boolean;
  isParticipant: boolean;
}

/**
 * Plan 7: the next per-thread entry seq given the current max (or null when the
 * thread has no entries yet). Seqs are 1-based; 0 is reserved for legacy rows.
 * NOTE: this is the documentation/contract helper. Production assignment uses
 * the atomic `UPDATE discussions SET entry_seq = entry_seq + 1 RETURNING`
 * counter (see discussionService.addEntry) to avoid max(seq)+1 races.
 */
export function nextSeq(currentMax: number | null): number {
  return (currentMax ?? 0) + 1;
}

/**
 * Visibility rules (Phase 1 visibility model: private|department|company):
 * - founder: sees everything
 * - unclaimed (ownerUserId=null): visible only to founder or team_lead with scope access
 * - private: visible only to participants (regardless of role)
 * - department / company: visible to anyone with scope access, or participants
 *   (the department/company distinction is enforced via the scope filter on
 *   the calling list query and the `hasScopeAccess` precomputation, not here)
 */
export function canViewThread(
  thread: { ownerUserId: string | null; visibility: ThreadVisibility },
  viewer: ThreadViewer,
): boolean {
  if (viewer.role === "founder") return true;
  if (thread.ownerUserId == null) {
    // Unclaimed — leads with scope can see it, and so can explicit participants
    // (humans invited in, and crew agents the orchestrator engaged — a fresh
    // thread is unclaimed until someone takes ownership, and proactive crew
    // discussion must work in exactly that state).
    return (viewer.role === "team_lead" && viewer.hasScopeAccess) || viewer.isParticipant;
  }
  if (thread.visibility === "private") return viewer.isParticipant;
  // department / company: scope access OR participant
  return viewer.hasScopeAccess || viewer.isParticipant;
}

/**
 * Compute default fields for a new thread based on origin and creator.
 */
export function computeCreateDefaults(input: {
  origin: { source: ThreadOriginSource; medium: ThreadOriginMedium };
  creator: { userId: string; isHuman: boolean };
  departmentDefaultVisibility: ThreadVisibility;
}): {
  phase: ThreadPhase;
  originSource: ThreadOriginSource;
  originMedium: ThreadOriginMedium;
  visibility: ThreadVisibility;
  ownerUserId: string | null;
} {
  return {
    phase: "discuss",
    originSource: input.origin.source,
    originMedium: input.origin.medium,
    visibility: input.departmentDefaultVisibility,
    ownerUserId: input.creator.isHuman ? input.creator.userId : null,
  };
}

// ── @mention parsing ──────────────────────────────────────────────────────────

/**
 * Extract all @mentions from a text string.
 * A mention is a word starting with @ that is either at the start of the string
 * or preceded by whitespace (so email addresses like user@example.com are skipped).
 * Returns deduplicated list preserving first-occurrence order.
 */
export function parseMentions(text: string): Array<{ raw: string; name: string }> {
  // Match @ preceded by start-of-string or whitespace, followed by word chars
  const regex = /(?:^|(?<=\s))@(\w+)/g;
  const seen = new Set<string>();
  const results: Array<{ raw: string; name: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1];
    if (!seen.has(name)) {
      seen.add(name);
      results.push({ raw: `@${name}`, name });
    }
  }
  return results;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Same @mention token shape parseMentions uses: `@` at start-of-string or after
// whitespace, capturing the first word. `matchAll` gives us each token's INDEX so
// resolution can be POSITION-aware (round-14 #3).
const MENTION_TOKEN_RE = /(?:^|(?<=\s))@(\w+)/g;

/**
 * Multi-word-aware mention resolution for the discussion summon paths
 * (PR #291 round-13 #2, round-14 #3).
 *
 * The naive `parseMentions` tokenizer (`\w+`) truncates a multi-word crew name
 * such as `@Memory Keeper` to `Memory`, so the outbox worker / `processMentions`
 * (which exact-matches `agents.name`) can never resolve it and the agent is
 * never summoned — the Discussion composer picker inserts the FULL label.
 *
 * Resolution is POSITION-aware and longest-match-wins PER `@` occurrence
 * (round-14 #3): at each mention token, if a multi-word company agent name
 * matches starting at that exact `@` (with the round-9 #4 trailing boundary
 * `(?![^\s@,!?.])` — so `@Memory Keepers` does NOT match `Memory Keeper`), the
 * full name REPLACES the single-word token it consumed. So a company with BOTH a
 * `Memory` and a `Memory Keeper` agent resolves `@Memory Keeper` to ONLY
 * `Memory Keeper` (not also the prefix `Memory`), a standalone `@Memory` to
 * `Memory`, and `@Memory Keeper and @Memory` to BOTH. Returns `{ raw, name }`
 * with the resolved name so `processMentions`' exact `agents.name` /
 * `authUsers.name` match works unchanged — no outbox schema change. Only org+aoa
 * agents are considered (platform agents are not mentionable), as
 * `findMentionedAgents` does.
 */
export async function resolveMentionTargets(
  db: Db,
  companyId: string,
  text: string,
): Promise<Array<{ raw: string; name: string }>> {
  const tokens = [...text.matchAll(MENTION_TOKEN_RE)];
  // No mention token → no multi-word name can match either (every full-name match
  // begins at a `@Word` token), so skip the roster query entirely.
  if (tokens.length === 0) return [];

  const rows = await db
    .select({ name: agents.name })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.kind, ["org", "aoa"])));
  const multiWordNames = rows.map((r) => r.name).filter((name) => /\s/.test(name));

  const results: Array<{ raw: string; name: string }> = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const slice = text.slice(token.index ?? 0); // starts at this token's `@`
    // Prefer the LONGEST multi-word agent name that matches at this `@` — the
    // full-name match SUPPRESSES the shorter prefix token it consumed.
    let matchedName: string | null = null;
    for (const name of multiWordNames) {
      const re = new RegExp(`^@${escapeRegExp(name)}(?![^\\s@,!?.])`, "i");
      if (re.test(slice) && (!matchedName || name.length > matchedName.length)) {
        matchedName = name;
      }
    }
    const resolvedName = matchedName ?? token[1];
    const key = resolvedName.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      results.push({ raw: `@${resolvedName}`, name: resolvedName });
    }
  }
  return results;
}

/**
 * Resolve each mention to an agent or user and dispatch:
 * - agent match on a CONTROLLER-PATH thread → run the agent via the controller
 *   participation path (`requestParticipation`); the agent self-posts its reply.
 * - agent match on a LEGACY (non-controller) thread → insert a peer-wake
 *   `agentWakeupRequests` row (unchanged behavior).
 * - user match → insert notifications row
 * - no match   → silently skip
 *
 * Task 1.2 (route controller-path mentions through the controller): on modern
 * threads the dispatcher TERMINALIZES peer-wake `thread_mention` rows as
 * `skipped_controller_path` (Task 1.1) — so a peer-wake insert there would be
 * DROPPED and the mentioned agent would never run. To actually answer the
 * mention we instead call `threadOrchestrationService(db).requestParticipation`
 * — which runs the crew agent (it self-posts via the post_entry MCP tool, so
 * Task 2.1's no-double-post applies). The thread row (`useControllerPath`) and
 * the inviting entry's `rawContent` (used as the participation `prompt`) are not
 * in scope today, so we fetch both up front (per call, not per mention).
 */
export async function processMentions(
  db: Db,
  companyId: string,
  threadId: string,
  entryId: string,
  mentions: Array<{ raw: string; name: string }>,
  opts?: { hopCount?: number },
): Promise<void> {
  // Fetch the thread row to learn whether it's controller-path, and the inviting
  // entry's text to use as the participation prompt. Both are per-call.
  const [threadRow] = await db
    .select({
      useControllerPath: discussions.useControllerPath,
      companyId: discussions.companyId,
    })
    .from(discussions)
    .where(and(eq(discussions.id, threadId), eq(discussions.companyId, companyId)))
    .limit(1);

  const [entryRow] = await db
    .select({ rawContent: discussionEntries.rawContent })
    .from(discussionEntries)
    .where(eq(discussionEntries.id, entryId))
    .limit(1);

  const useControllerPath = threadRow?.useControllerPath === true;
  const entryPrompt = entryRow?.rawContent ?? "";
  const controllerParticipations: Array<Promise<unknown>> = [];

  for (const mention of mentions) {
    // 1) Check if name resolves to an AoA agent in this company (kind='aoa' only)
    const agentRows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(
        eq(agents.companyId, companyId),
        eq(agents.name, mention.name),
        eq(agents.kind, "aoa"),
      ))
      .then((rows) => rows);

    if (agentRows.length > 0) {
      // ── Task 1.2: controller-path threads run the agent via participation ──
      // On a controller-path thread, route the @mention through the orchestration
      // controller so the crew agent actually RUNS (it self-posts its reply via
      // the post_entry MCP tool; requestParticipation skips its own insert when
      // the runner returns "" — Task 2.1 no-double-post). A peer-wake row here
      // would be terminalized as `skipped_controller_path` by the dispatcher
      // (Task 1.1) and the mention would be dropped. Lazy/dynamic import of
      // threadOrchestrationService mirrors how thread-orchestration lazy-imports
      // its heavy crew runner — keeping that subtree off the threads.ts (and
      // therefore routes/discussions.ts) module-load path.
      if (useControllerPath) {
        const { threadOrchestrationService } = await import("./thread-orchestration.js");
        controllerParticipations.push(
          threadOrchestrationService(db).requestParticipation(
            threadId,
            { agentId: agentRows[0].id, prompt: entryPrompt },
            {},
          ),
        );
        continue;
      }

      // ── Legacy (non-controller) thread: peer-wake insert (unchanged) ──
      // UAT iteration 2 fix: look up the agent's mention-trigger role so the
      // dispatcher autonomy gate (which reads payload.role) can correctly
      // gate agentic crew roles (router/planner/dispatcher require L2).
      // Without this, every @Router/@Planner/@Dispatcher mention bypassed
      // the autonomy gate because no payload.role was set. The role lives
      // in aoaAgentTriggers.config.role — runtimeConfig.aoa.role is the
      // literal string "member" (a template default, not the actual key).
      const triggerRows = await db
        .select({ config: aoaAgentTriggers.config })
        .from(aoaAgentTriggers)
        .where(and(
          eq(aoaAgentTriggers.agentId, agentRows[0].id),
          eq(aoaAgentTriggers.kind, "mention"),
        ))
        .limit(1)
        .then((rows: Array<{ config: Record<string, unknown> | null }>) => rows);
      const agentRole = (triggerRows[0]?.config as Record<string, unknown> | null | undefined)?.role as
        | string
        | undefined;

      // Create a wakeup request so the dispatcher Phase 3 picks it up
      await db.insert(agentWakeupRequests).values({
        companyId,
        agentId: agentRows[0].id,
        source: "thread_mention",
        triggerDetail: `@mention in thread ${threadId} entry ${entryId}`,
        reason: "thread_mention",
        payload: {
          threadId,
          entryId,
          mention: mention.raw,
          hopCount: opts?.hopCount ?? 0,
          // Include role so dispatcher's autonomy gate can evaluate it.
          ...(agentRole ? { role: agentRole } : {}),
        },
        requestedByActorType: "board",
        requestedByActorId: entryId,
      });
      continue;
    }

    // 2) Check if name resolves to a human user (by name) — restricted to company members
    const userRows = await db
      .select({ id: authUsers.id, name: authUsers.name })
      .from(authUsers)
      .innerJoin(companyMemberships, and(
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, authUsers.id),
        eq(companyMemberships.companyId, companyId),
      ))
      .where(eq(authUsers.name, mention.name))
      .then((rows) => rows);

    if (userRows.length > 0) {
      // Natural-owner item: the mentioned human is the owner. sourceId folds in
      // the recipient + entry so each mentioned user gets a distinct hub row and
      // a re-process of the same entry dedupes onto the same item.
      await hubItemsService(db).emit({
        companyId,
        semanticType: "mention",
        sourceType: "discussion",
        sourceId: `${threadId}:${entryId}:${userRows[0].id}`,
        title: `You were mentioned in a thread`,
        summary: `${mention.raw} in thread`,
        ownerUserId: userRows[0].id,
      });
    }
    // if neither → skip
  }

  if (controllerParticipations.length > 0) {
    // Round-9 #2: a rejected crew participation must NOT resolve this call
    // successfully — otherwise the mention-outbox worker marks the row done and
    // never retries, silently dropping the summon. Await all (so successes still
    // run), then re-surface any rejections so the caller (outbox worker) can
    // retry. The outbox enqueues ONE row per mention (per agent), so a retry
    // re-runs only the failed agent — successes are never re-summoned.
    const settled = await Promise.allSettled(controllerParticipations);
    const rejected = settled.filter(
      (s): s is PromiseRejectedResult => s.status === "rejected",
    );
    if (rejected.length > 0) {
      const reasons = rejected
        .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))
        .join("; ");
      throw new Error(`processMentions: ${rejected.length} participation(s) failed: ${reasons}`);
    }
  }
}

// ── Actor type ────────────────────────────────────────────────────────────────

export interface Actor {
  userId: string;
  role: "founder" | "team_lead" | "team_member";
  isHuman: boolean;
  principalType?: "user" | "agent";
}

type ThreadAccessRow = {
  id: string;
  scopeType: string | null;
  scopeId: string | null;
  ownerUserId: string | null;
  visibility: string;
};

/** Canonical visibility assertion shared by thread reads and posting. */
async function assertCanAccessThread(
  db: Db,
  companyId: string,
  thread: ThreadAccessRow,
  actor: Actor,
): Promise<void> {
  if (actor.role === "founder") return;

  const principalType = actor.principalType ?? "user";
  const participantRows = await db
    .select({ id: threadParticipants.id })
    .from(threadParticipants)
    .where(
      and(
        eq(threadParticipants.threadId, thread.id),
        eq(threadParticipants.principalType, principalType),
        eq(threadParticipants.principalId, actor.userId),
      ),
    );
  const isParticipant = participantRows.length > 0;

  let hasScopeAccess = thread.scopeType == null;
  if (!hasScopeAccess && thread.scopeId && principalType === "user") {
    const roleRows = await db
      .select({ id: userRoles.id })
      .from(userRoles)
      .where(
        and(
          eq(userRoles.companyId, companyId),
          eq(userRoles.userId, actor.userId),
          eq(userRoles.projectId, thread.scopeId),
        ),
      );
    hasScopeAccess = roleRows.length > 0;
  }

  const ok = canViewThread(
    {
      ownerUserId: thread.ownerUserId,
      visibility: thread.visibility as ThreadVisibility,
    },
    { role: actor.role, hasScopeAccess, isParticipant },
  );
  if (!ok) throw notFound("Thread not found");
}

/**
 * Server-internal orchestration primitive: register a crew agent as a thread
 * participant (idempotent). Called from the crew post chokepoints when the
 * server itself engages an agent on a thread (controller turn, dispatcher
 * summon) — the engagement IS the authorization, so no actor check here.
 * Never expose this to externally reachable routes.
 */
export async function ensureAgentParticipant(
  db: Db,
  companyId: string,
  threadId: string,
  agentId: string,
): Promise<void> {
  await db
    .insert(threadParticipants)
    .values({ companyId, threadId, principalType: "agent", principalId: agentId, role: "member" })
    .onConflictDoNothing();
}

/**
 * Assert that an actor may post to a company-scoped thread. Hidden and
 * cross-company threads deliberately return 404 to avoid leaking existence.
 */
export async function assertCanPostToThread(
  db: Db,
  companyId: string,
  threadId: string,
  actor: Actor,
): Promise<void> {
  const thread = await db
    .select({
      id: discussions.id,
      scopeType: discussions.scopeType,
      scopeId: discussions.scopeId,
      ownerUserId: discussions.ownerUserId,
      visibility: discussions.visibility,
    })
    .from(discussions)
    .where(and(eq(discussions.id, threadId), eq(discussions.companyId, companyId)))
    .then((rows) => rows[0] ?? null);

  if (!thread) throw notFound("Thread not found");
  await assertCanAccessThread(db, companyId, thread, actor);
}

// ── Service factory ───────────────────────────────────────────────────────────

export function threadService(db: Db) {
  // ── Internal RBAC helpers ──

  /**
   * Assert the actor can view this thread.
   * Throws notFound (not forbidden) to avoid leaking existence.
   */
  async function assertCanView(
    companyId: string,
    thread: ThreadAccessRow,
    actor: Actor,
  ): Promise<void> {
    await assertCanAccessThread(db, companyId, thread, actor);
  }

  /**
   * Assert the actor can edit this thread (owner, co_owner, or founder).
   * Throws notFound (not forbidden) per hide-don't-403 rule.
   * Codex #5: allowed roles are owner | co_owner | founder.
   */
  async function assertCanEdit(
    thread: { id: string; ownerUserId: string | null },
    actor: Actor,
  ): Promise<void> {
    if (actor.role === "founder") return;
    if (thread.ownerUserId === actor.userId) return;
    // Check threadParticipants for co_owner role
    const participantRows = await db
      .select({ role: threadParticipants.role })
      .from(threadParticipants)
      .where(
        and(
          eq(threadParticipants.threadId, thread.id),
          eq(threadParticipants.principalType, "user"),
          eq(threadParticipants.principalId, actor.userId),
        ),
      );
    const participantRole = participantRows[0]?.role;
    if (participantRole === "owner" || participantRole === "co_owner") return;
    throw notFound("Thread not found");
  }

  /**
   * Get a single thread by id, enforcing visibility (the canonical read path).
   * Returns null if the row doesn't exist; throws notFound if it exists but the
   * actor can't view it. Centralizes the fetch + assertCanView so callers don't
   * re-implement the visibility check (and can't drift on selected columns).
   */
  async function getByIdInternal(companyId: string, id: string, actor: Actor) {
    const thread = await db
      .select()
      .from(discussions)
      .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!thread) return null;
    await assertCanView(companyId, thread, actor);
    return thread;
  }

  return {
    // ── Real-time envelope RBAC (Plan 7) ───────────────────────────────────────

    /**
     * Resolve the envelope-RBAC inputs for a (thread, viewer) pair WITHOUT
     * throwing — used by the WS fan-out to decide whether a connection may
     * receive a thread.* poke. Returns null if the thread row doesn't exist.
     *
     * CRITICAL (Plan 7 amendment): the WS handler calls this PER EVENT and does
     * not cache the result. Caching { role, hasScopeAccess, isParticipant }
     * would need invalidation when a thread goes private or a participant is
     * removed — get that wrong and you leak events. At founding-team scale,
     * recompute per event (cheap).
     */
    resolveViewerForThread: async (
      companyId: string,
      threadId: string,
      viewer: {
        userId: string;
        role: "founder" | "team_lead" | "team_member";
        principalType?: "user" | "agent";
      },
    ): Promise<{
      thread: { ownerUserId: string | null; visibility: ThreadVisibility };
      viewer: ThreadViewer;
    } | null> => {
      const row = await db
        .select({
          ownerUserId: discussions.ownerUserId,
          visibility: discussions.visibility,
          scopeType: discussions.scopeType,
          scopeId: discussions.scopeId,
        })
        .from(discussions)
        .where(and(eq(discussions.id, threadId), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      // Founders see everything — short-circuit the participant/scope queries.
      if (viewer.role === "founder") {
        return {
          thread: { ownerUserId: row.ownerUserId, visibility: row.visibility as ThreadVisibility },
          viewer: { role: "founder", hasScopeAccess: true, isParticipant: true },
        };
      }

      const principalType = viewer.principalType ?? "user";
      const participantRows = await db
        .select({ id: threadParticipants.id })
        .from(threadParticipants)
        .where(
          and(
            eq(threadParticipants.threadId, threadId),
            eq(threadParticipants.principalType, principalType),
            eq(threadParticipants.principalId, viewer.userId),
          ),
        );
      const isParticipant = participantRows.length > 0;

      let hasScopeAccess = row.scopeType == null;
      if (!hasScopeAccess && row.scopeId && principalType === "user") {
        const roleRows = await db
          .select({ id: userRoles.id })
          .from(userRoles)
          .where(
            and(
              eq(userRoles.companyId, companyId),
              eq(userRoles.userId, viewer.userId),
              eq(userRoles.projectId, row.scopeId),
            ),
          );
        hasScopeAccess = roleRows.length > 0;
      }

      return {
        thread: { ownerUserId: row.ownerUserId, visibility: row.visibility as ThreadVisibility },
        viewer: { role: viewer.role, hasScopeAccess, isParticipant },
      };
    },

    // ── Read path ─────────────────────────────────────────────────────────────

    /**
     * Get a single thread by id, enforcing visibility.
     * Returns null if row doesn't exist; throws notFound if exists but not visible.
     */
    getById: async (companyId: string, id: string, actor: Actor) =>
      getByIdInternal(companyId, id, actor),

    /**
     * Plan 7 catch-up: fetch entries with seq > sinceSeq, ordered by seq, for a
     * thread the actor can view. Used by the reconnect-refetch path so a client
     * that missed pokes while disconnected can pull only the gap.
     * RBAC: enforced via the same getById visibility check (throws notFound when
     * the thread exists but isn't visible).
     */
    entriesSince: async (
      companyId: string,
      threadId: string,
      sinceSeq: number,
      actor: Actor,
    ) => {
      // Route the RBAC check through getById so visibility (and the columns it
      // selects) stays centralized — no duplicate fetch that could drift.
      const thread = await getByIdInternal(companyId, threadId, actor);
      if (!thread) throw notFound("Thread not found");

      return db
        .select()
        .from(discussionEntries)
        .where(
          and(
            eq(discussionEntries.discussionId, threadId),
            gt(discussionEntries.seq, sinceSeq),
          ),
        )
        .orderBy(asc(discussionEntries.seq))
        .then((rows) => rows);
    },

    /**
     * List threads with optional phase filter.
     * D4 batched: 1 candidate query + 1 participant batch query + 1 roles query.
     * Visibility filtering done in-memory after batch queries.
     */
    list: async (
      companyId: string,
      actor: Actor,
      filters: { phase?: string } = {},
    ) => {
      const conditions: ReturnType<typeof eq>[] = [
        eq(discussions.companyId, companyId) as ReturnType<typeof eq>,
      ];
      if (filters.phase) {
        conditions.push(eq(discussions.phase, filters.phase) as ReturnType<typeof eq>);
      }

      const rows = await db
        .select()
        .from(discussions)
        .where(and(...conditions))
        .orderBy(desc(discussions.lastEntryAt));

      if (actor.role === "founder") return rows;

      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return [];

      // Batch 1: which threads is this actor a participant of?
      const myParts = await db
        .select({ threadId: threadParticipants.threadId })
        .from(threadParticipants)
        .where(
          and(
            eq(threadParticipants.principalType, "user"),
            eq(threadParticipants.principalId, actor.userId),
            inArray(threadParticipants.threadId, ids),
          ),
        );
      const partSet = new Set(myParts.map((p) => p.threadId));

      // Batch 2: which projects does this actor have a role in?
      const myDepts = await db
        .select({ projectId: userRoles.projectId })
        .from(userRoles)
        .where(
          and(
            eq(userRoles.companyId, companyId),
            eq(userRoles.userId, actor.userId),
          ),
        );
      const deptSet = new Set(
        myDepts.map((d) => d.projectId).filter(Boolean) as string[],
      );

      return rows.filter((t) =>
        canViewThread(
          {
            ownerUserId: t.ownerUserId ?? null,
            visibility: (t.visibility ?? "company") as ThreadVisibility,
          },
          {
            role: actor.role,
            hasScopeAccess:
              t.scopeType == null ||
              (t.scopeId != null && deptSet.has(t.scopeId)),
            isParticipant: partSet.has(t.id),
          },
        ),
      );
    },

    // ── Phase state machine ───────────────────────────────────────────────────

    /**
     * Advance (or rewind) the phase of a thread.
     * Validates the transition via canAdvancePhase.
     * Forward-by-one is auto-advance; any backward jump requires founder (calling layer enforces).
     * Claims ownership on action if unclaimed.
     */
    advancePhase: async (
      companyId: string,
      id: string,
      target: ThreadPhase,
      actor: Actor,
    ) => {
      const thread = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!thread) throw notFound("Thread not found");
      await assertCanView(companyId, thread, actor);

      if (!canAdvancePhase(thread.phase as ThreadPhase, target)) {
        throw badRequest(
          `Cannot advance phase ${thread.phase} -> ${target}`,
        );
      }

      const newOwner = resolveOwnerOnAction(
        { ownerUserId: thread.ownerUserId ?? null },
        { userId: actor.userId, isHuman: actor.isHuman },
      );

      await db
        .update(discussions)
        .set({
          phase: target,
          ...(newOwner ? { ownerUserId: newOwner } : {}),
          updatedAt: new Date(),
        })
        .where(eq(discussions.id, id));

      // Task 2.6: when advancing into the work-producing phase ("assign"), check
      // effectiveAutonomy. At L2 (Drive), auto-approve the pending scope_proposal
      // entry and dispatch work. At L0/L1, leave the pending card for the human.
      //
      // NOTE: The old Dispatcher-wakeup coupling (phase-advance → aoaAgentTriggers
      // → agentWakeupRequests) has been removed here (Task 2.7 retires that role).
      if (target === "assign") {
        // Resolve effectiveAutonomy: thread-level wins; fall back to company
        // internal_agent_config.autonomyLevel (same pattern as controller-adjutant-runner
        // and dispatcher). Default to 0 if no company row exists.
        const [companyCfg] = await db
          // D18: phase-advance auto-approve dispatches crew work — agent-work dial.
          .select({ autonomyLevel: internalAgentConfig.crewAutonomyLevel })
          .from(internalAgentConfig)
          .where(eq(internalAgentConfig.companyId, companyId))
          .limit(1);
        const companyAutonomyLevel: number = companyCfg?.autonomyLevel ?? 0;
        const effectiveAutonomy: number | null =
          thread.autonomyLevel != null ? thread.autonomyLevel : companyAutonomyLevel;
        // Dynamic import: keeps crew-task-service → heartbeat → execution-workspaces
        // → git → execFile out of the top-level import graph (see comment above).
        const { resolveCreationGate, crewTaskService } = await import("./crew-task-service.js");
        const gate = resolveCreationGate(effectiveAutonomy);

        if (gate === "auto_approve") {
          // Find the pending scope_proposal entry for this thread (at most one,
          // enforced by the onePendingScopeProposalIdx partial unique index).
          const [pendingProposal] = await db
            .select({
              id: discussionEntries.id,
            })
            .from(discussionEntries)
            .where(
              and(
                eq(discussionEntries.discussionId, id),
                eq(discussionEntries.inputType, "scope_proposal"),
                eq(discussionEntries.proposalStatus, "pending"),
              ),
            );

          if (pendingProposal) {
            // Auto-approve + dispatch via the shared crew-task-service helper.
            // approverUserId is the actor (founder/team-lead doing the phase advance).
            const crew = crewTaskService(db);
            await crew.approveAndDispatch({
              threadId: id,
              companyId,
              proposalEntryId: pendingProposal.id,
              approverUserId: actor.userId,
              actorType: actor.isHuman ? "user" : "agent",
              actorId: actor.userId,
              agentId: null,
              autonomy: effectiveAutonomy,
            });
          }
          // If no pending proposal: advance only (Adjutant may propose later).
        }
        // L0/L1: leave pending card for the human — no further action.
      }

      await logActivity(db, {
        companyId,
        actorType: actor.isHuman ? "user" : "agent",
        actorId: actor.userId,
        action: "thread.phase.changed",
        entityType: "discussion",
        entityId: id,
        details: { phase: target },
      });
      publishLiveEvent({
        companyId,
        type: "thread.phase.changed",
        payload: { threadId: id, phase: target },
      });
      return { id, phase: target };
    },

    // ── Summary ───────────────────────────────────────────────────────────────

    updateSummary: async (
      companyId: string,
      id: string,
      summary: { text: string; next: string | null },
      actor: Actor,
    ) => {
      const thread = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
        .then((r) => r[0] ?? null);
      if (!thread) throw notFound("Thread not found");
      await assertCanView(companyId, thread, actor);

      await db
        .update(discussions)
        .set({
          summaryText: summary.text,
          summaryNext: summary.next,
          summaryUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)));

      await logActivity(db, {
        companyId,
        actorType: actor.isHuman ? "user" : "agent",
        actorId: actor.userId,
        action: "thread.summary.updated",
        entityType: "discussion",
        entityId: id,
        details: {},
      });
      publishLiveEvent({
        companyId,
        type: "thread.summary.updated",
        payload: { threadId: id },
      });
      return { id };
    },

    // ── Ownership ─────────────────────────────────────────────────────────────

    /**
     * Claim an unclaimed thread. Idempotent — if already owned, returns current owner.
     * Agents cannot claim (resolveOwnerOnAction guards this).
     */
    claim: async (companyId: string, id: string, actor: Actor) => {
      const thread = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!thread) throw notFound("Thread not found");
      await assertCanView(companyId, thread, actor);

      const newOwner = resolveOwnerOnAction(
        { ownerUserId: thread.ownerUserId ?? null },
        { userId: actor.userId, isHuman: actor.isHuman },
      );
      if (!newOwner) return { ownerUserId: thread.ownerUserId ?? null };

      await db
        .update(discussions)
        .set({ ownerUserId: newOwner, updatedAt: new Date() })
        .where(eq(discussions.id, id));

      // Upsert as participant (owner role) — if already a participant, promote their role
      await db
        .insert(threadParticipants)
        .values({
          companyId,
          threadId: id,
          principalType: "user",
          principalId: newOwner,
          role: "owner",
        })
        .onConflictDoUpdate({
          target: [threadParticipants.threadId, threadParticipants.principalType, threadParticipants.principalId],
          set: { role: "owner" },
        });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId,
        action: "thread.claimed",
        entityType: "discussion",
        entityId: id,
        details: { ownerUserId: newOwner },
      });
      publishLiveEvent({
        companyId,
        type: "thread.participant.changed",
        payload: { threadId: id },
      });
      return { ownerUserId: newOwner };
    },

    /**
     * Transfer ownership to another user. Only the current owner or founder can transfer.
     * Demotes previous owner to 'collaborator' in participants.
     */
    transferOwnership: async (
      companyId: string,
      id: string,
      toUserId: string,
      actor: Actor,
    ) => {
      const thread = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!thread) throw notFound("Thread not found");

      // Codex #5: owner | co_owner | founder may transfer. assertCanEdit enforces this.
      await assertCanEdit(thread, actor);

      // Validate the recipient is an active member of this company before
      // writing ownerUserId — prevents a dangling owner pointing at a
      // non-member user id. Mirrors the membership join in processMentions.
      const recipient = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, toUserId),
          ),
        )
        .limit(1);
      if (recipient.length === 0) throw notFound("Thread not found");

      // Demote previous owner to collaborator
      if (thread.ownerUserId) {
        await db
          .update(threadParticipants)
          .set({ role: "collaborator" })
          .where(
            and(
              eq(threadParticipants.threadId, id),
              eq(threadParticipants.principalType, "user"),
              eq(threadParticipants.principalId, thread.ownerUserId),
              eq(threadParticipants.role, "owner"),
            ),
          );
      }

      await db
        .update(discussions)
        .set({ ownerUserId: toUserId, updatedAt: new Date() })
        .where(eq(discussions.id, id));

      // Upsert new owner as participant (owner role) — if already a participant (e.g. co_owner), promote their role
      await db
        .insert(threadParticipants)
        .values({
          companyId,
          threadId: id,
          principalType: "user",
          principalId: toUserId,
          role: "owner",
        })
        .onConflictDoUpdate({
          target: [threadParticipants.threadId, threadParticipants.principalType, threadParticipants.principalId],
          set: { role: "owner" },
        });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId,
        action: "thread.ownership.transferred",
        entityType: "discussion",
        entityId: id,
        details: { toUserId },
      });
      publishLiveEvent({
        companyId,
        type: "thread.participant.changed",
        payload: { threadId: id },
      });
      return { ownerUserId: toUserId };
    },

    // ── Participants ──────────────────────────────────────────────────────────

    addParticipant: async (
      companyId: string,
      id: string,
      p: {
        principalType: "user" | "agent";
        principalId: string;
        role: string;
      },
      actor: Actor,
    ) => {
      const thread = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
        .then((r) => r[0] ?? null);
      if (!thread) throw notFound("Thread not found");
      await assertCanView(companyId, thread, actor);
      await assertCanEdit(thread, actor);

      await db
        .insert(threadParticipants)
        .values({ companyId, threadId: id, ...p })
        .onConflictDoNothing();

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId,
        action: "thread.participant.added",
        entityType: "discussion",
        entityId: id,
        details: { ...p },
      });
      publishLiveEvent({
        companyId,
        type: "thread.participant.changed",
        payload: { threadId: id },
      });
      return { ok: true };
    },

    removeParticipant: async (
      companyId: string,
      id: string,
      participantId: string,
      actor: Actor,
    ) => {
      const thread = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
        .then((r) => r[0] ?? null);
      if (!thread) throw notFound("Thread not found");
      await assertCanView(companyId, thread, actor);
      await assertCanEdit(thread, actor);

      await db
        .delete(threadParticipants)
        .where(eq(threadParticipants.id, participantId));

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId,
        action: "thread.participant.removed",
        entityType: "discussion",
        entityId: id,
        details: { participantId },
      });
      publishLiveEvent({
        companyId,
        type: "thread.participant.changed",
        payload: { threadId: id },
      });
      return { ok: true };
    },

    // ── Promote to goal ───────────────────────────────────────────────────────

    /**
     * Promote a thread to a goal. Creates the goal, links goalId on the thread.
     * Goals are a multi-parent DAG (Decision #20 superseded 2026-05-25); the
     * goal service enforces cycle + child⊆parent scope integrity on write.
     */
    promoteToGoal: async (
      companyId: string,
      id: string,
      goalInput: {
        parentIds?: string[];
        scope?: { mode: "company" | "specific"; projectIds: string[] };
        // Legacy (pre-B4 callers): top-level projectIds; `level` is ignored.
        projectIds?: string[];
      },
      actor: Actor,
    ) => {
      const thread = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!thread) throw notFound("Thread not found");
      await assertCanView(companyId, thread, actor);
      await assertCanEdit(thread, actor);

      if (thread.goalId) throw badRequest("Thread already has a goal");

      // Normalize scope: an explicit `scope` wins; else derive from legacy projectIds.
      const scope = goalInput.scope ?? {
        mode:
          (goalInput.projectIds?.length ?? 0) > 0
            ? ("specific" as const)
            : ("company" as const),
        projectIds: goalInput.projectIds ?? [],
      };
      if (scope.mode === "specific" && scope.projectIds.length < 1) {
        throw badRequest("A scoped goal needs at least one department or project");
      }
      const parentIds = goalInput.parentIds ?? [];

      const gsvc = goalService(db);
      // D3: validate parent scope before creating, so a failure leaves no orphan goal.
      await gsvc.assertParentsValid({
        parentIds,
        childProjectIds: scope.projectIds,
        childCompanyId: companyId,
      });

      const goal = await gsvc.create(companyId, {
        title: thread.title ?? "Untitled goal",
        projectIds: scope.projectIds,
        status: "planned",
      });

      await db
        .update(discussions)
        .set({ goalId: goal.id, updatedAt: new Date() })
        .where(eq(discussions.id, id));

      if (parentIds.length > 0) {
        await gsvc.setGoalParents(goal.id, parentIds);
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId,
        action: "thread.promoted_to_goal",
        entityType: "discussion",
        entityId: id,
        details: { goalId: goal.id },
      });
      publishLiveEvent({
        companyId,
        type: "thread.scope.changed",
        payload: { threadId: id },
      });
      return { goalId: goal.id };
    },

    // ── Fork / merge ──────────────────────────────────────────────────────────

    /**
     * Fork a thread — creates a child thread linked back via thread_links with kind='fork'.
     * Child inherits scope and visibility from source.
     */
    fork: async (companyId: string, id: string, actor: Actor) => {
      const src = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!src) throw notFound("Thread not found");
      await assertCanView(companyId, src, actor);

      const [child] = await db
        .insert(discussions)
        .values({
          companyId,
          title: `${src.title ?? "Thread"} (fork)`,
          scopeType: src.scopeType,
          scopeId: src.scopeId,
          phase: "discuss",
          visibility: src.visibility,
          forkedFromId: src.id,
          ownerUserId: actor.isHuman ? actor.userId : null,
          createdBy: actor.userId,
        })
        .returning();

      await db.insert(threadLinks).values({
        companyId,
        fromThreadId: child.id,
        toThreadId: src.id,
        kind: "fork",
        createdBy: actor.userId,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId,
        action: "thread.forked",
        entityType: "discussion",
        entityId: id,
        details: { childId: child.id },
      });
      return { id: child.id, forkedFromId: src.id };
    },

    /**
     * Merge fromId into intoId. Archives the source thread.
     * Full Scope reconciliation is v1.1 (SPEC §10).
     */
    merge: async (
      companyId: string,
      fromId: string,
      intoId: string,
      actor: Actor,
    ) => {
      const thread = await db
        .select()
        .from(discussions)
        .where(
          and(eq(discussions.id, fromId), eq(discussions.companyId, companyId)),
        )
        .then((r) => r[0] ?? null);
      if (!thread) throw notFound("Thread not found");
      await assertCanView(companyId, thread, actor);
      await assertCanEdit(thread, actor);

      await db
        .update(discussions)
        .set({ mergedIntoId: intoId, status: "archived", updatedAt: new Date() })
        .where(eq(discussions.id, fromId));

      // Phase G1 (T7/D8): merging a thread archives its source — mark any
      // thread-scoped workspaces eligible for cleanup immediately rather
      // than waiting for the TTL sweeper to catch them. Dynamic import
      // keeps execution-workspaces (which pulls in node:child_process via
      // git.ts) out of the threads.ts top-level resolution chain — several
      // test suites mock child_process partially and break on the eager path.
      try {
        const { markThreadWorkspacesForCleanup } = await import(
          "./workspace-ttl-sweeper.js"
        );
        await markThreadWorkspacesForCleanup(db, fromId);
      } catch (err) {
        // Workspace cleanup is best-effort — never block the merge.
        // The next TTL sweep will catch any stragglers via the default
        // 7-day fallback for thread workspaces.
        // eslint-disable-next-line no-console
        console.warn(
          "[threads.merge] markThreadWorkspacesForCleanup failed",
          { fromId, err },
        );
      }

      await db.insert(threadLinks).values({
        companyId,
        fromThreadId: fromId,
        toThreadId: intoId,
        kind: "merge",
        createdBy: actor.userId,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId,
        action: "thread.merged",
        entityType: "discussion",
        entityId: fromId,
        details: { intoId },
      });
      return { mergedInto: intoId };
    },

    // ── Assign scope items → tasks ────────────────────────────────────────────

    /**
     * Convert approved Scope items into issues (Tasks).
     * Founder-gated write (Codex #7).
     * Issues created with workMode='planning' (D8: suppresses heartbeat dispatch).
     * Idempotent: items with existing resultTaskId are skipped.
     *
     * Note: discussionExtractedItems link to threads via discussionEntries.discussionId.
     * This queries through that join to find all approved pending items for this thread.
     */
    assignScopeItems: async (
      companyId: string,
      id: string,
      actor: Actor,
    ) => {
      if (actor.role !== "founder") throw notFound("Thread not found");

      const thread = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
        .then((r) => r[0] ?? null);
      if (!thread) throw notFound("Thread not found");

      let created = 0;

      // Wrap the entire create+link loop in a transaction so a crash mid-loop
      // cannot produce duplicate issues on re-run (idempotency guarantee).
      await db.transaction(async (tx) => {
        // Fetch approved items for this thread via the entry join (inside tx)
        // discussionExtractedItems.discussionEntryId → discussionEntries.id → discussionEntries.discussionId
        const entries = await tx
          .select({ id: discussionEntries.id })
          .from(discussionEntries)
          .where(eq(discussionEntries.discussionId, id));

        const entryIds = entries.map((e) => e.id);
        if (entryIds.length === 0) return;

        const allItems = await tx
          .select()
          .from(discussionExtractedItems)
          .where(
            and(
              inArray(discussionExtractedItems.discussionEntryId, entryIds),
              eq(discussionExtractedItems.status, "approved"),
            ),
          );

        // Filter in-memory for resultTaskId IS NULL (idempotent — skip already-created)
        const pending = allItems.filter((item) => item.resultTaskId == null);

        for (const item of pending) {
          if (item.type === "spin_off_thread") {
            // spin-off: full wiring is Plan 6, skip for now
            continue;
          }

          // Only create tasks for task-type items
          if (item.type !== "task") continue;

          // Create issue with workMode='planning' (D8: suppresses dispatch)
          const projectId = item.departmentId ?? item.suggestedDepartmentId ?? item.suggestedProjectId ?? null;
          const { resolveAgentCompletionPolicy } = await import("./agent-completion-policy.js");
          const completionPolicy = await resolveAgentCompletionPolicy(tx as unknown as Db, {
            companyId,
            projectId,
            lockSources: true,
          });
          const [newIssue] = await tx
            .insert(issues)
            .values({
              companyId,
              title: item.title,
              description: item.description ?? null,
              status: "todo",
              workMode: "planning", // D8: planning mode prevents auto-dispatch
              assigneeAgentId: item.assigneeAgentId ?? null,
              assigneeUserId: item.assigneeUserId ?? null,
              projectId,
              // B6: approved tasks inherit the item's suggested goal, else the
              // thread's goal — so they count toward goal progress roll-up.
              goalId: item.suggestedGoalId ?? thread.goalId ?? null,
              priority: item.priority ?? item.suggestedPriority ?? "medium",
              createdByUserId: actor.userId,
              agentCompletionPolicy: completionPolicy.policy,
              agentCompletionPolicySource: completionPolicy.source,
              agentCompletionPolicySourceId: completionPolicy.sourceId,
              agentCompletionPolicyResolvedAt: completionPolicy.resolvedAt,
            })
            .returning();

          // Link the scope item to the new task (idempotent marker)
          await tx
            .update(discussionExtractedItems)
            .set({ resultTaskId: newIssue.id, updatedAt: new Date() })
            .where(eq(discussionExtractedItems.id, item.id));

          created++;
        }

        // Codex #7: advance phase to 'assign' after items are created
        if (created > 0) {
          await tx
            .update(discussions)
            .set({ phase: "assign" })
            .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)));
        }
      });

      if (created > 0) {
        await logActivity(db, {
          companyId,
          actorType: "user",
          actorId: actor.userId,
          action: "thread.scope.assigned",
          entityType: "discussion",
          entityId: id,
          details: { count: created },
        });
        publishLiveEvent({
          companyId,
          type: "thread.scope.changed",
          payload: { threadId: id, count: created },
        });
      }
      return { created };
    },

    // ── Cross-thread links ────────────────────────────────────────────────────

    /**
     * Create a typed link between two threads.
     * Both threads must be visible to the actor.
     * `kind` must be a valid THREAD_LINK_KINDS value.
     */
    createLink: async (
      companyId: string,
      fromId: string,
      toId: string,
      kind: string,
      actor: Actor,
    ) => {
      if (!THREAD_LINK_KINDS.includes(kind as ThreadLinkKind)) {
        throw badRequest(`Invalid link kind: ${kind}`);
      }

      const fromThread = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, fromId), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!fromThread) throw notFound("Thread not found");
      await assertCanView(companyId, fromThread, actor);

      const toThread = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, toId), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!toThread) throw notFound("Target thread not found");
      await assertCanView(companyId, toThread, actor);

      const [link] = await db
        .insert(threadLinks)
        .values({
          companyId,
          fromThreadId: fromId,
          toThreadId: toId,
          kind,
          createdBy: actor.userId,
        })
        .onConflictDoNothing()
        .returning();

      await logActivity(db, {
        companyId,
        actorType: actor.isHuman ? "user" : "agent",
        actorId: actor.userId,
        action: "thread.link.created",
        entityType: "discussion",
        entityId: fromId,
        details: { toId, kind },
      });
      publishLiveEvent({
        companyId,
        type: "thread.link.created",
        // threadId routes the event at fan-out (threadIdOf reads payload.threadId).
        // Use the source thread so subscribers watching it see when it links out.
        payload: { threadId: fromId, fromThreadId: fromId, toThreadId: toId, kind },
      });
      return link;
    },

    /**
     * List all links where this thread is either the source or destination.
     */
    listLinks: async (
      companyId: string,
      id: string,
      actor: Actor,
    ) => {
      const thread = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, id), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!thread) throw notFound("Thread not found");
      await assertCanView(companyId, thread, actor);

      return db
        .select()
        .from(threadLinks)
        .where(
          and(
            eq(threadLinks.companyId, companyId),
            or(
              eq(threadLinks.fromThreadId, id),
              eq(threadLinks.toThreadId, id),
            ),
          ),
        )
        .then((rows) => rows);
    },

    // ── Scope item dependencies ───────────────────────────────────────────────

    /**
     * Add a blocker→blocked dependency between two scope items (pre-task).
     * These are stored in scope_item_dependencies and graduate to
     * task_dependencies when items get resultTaskIds.
     */
    addScopeItemDependency: async (
      companyId: string,
      threadId: string,
      dep: { blockerItemId: string; blockedItemId: string },
      actor: Actor,
    ) => {
      const thread = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, threadId), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!thread) throw notFound("Thread not found");
      await assertCanView(companyId, thread, actor);
      await assertCanEdit(thread, actor); // write operation requires edit rights

      // Validate that blockerItemId belongs to this discussion (via entry join)
      const blockerItem = await db
        .select({ id: discussionExtractedItems.id })
        .from(discussionExtractedItems)
        .innerJoin(discussionEntries, and(
          eq(discussionEntries.id, discussionExtractedItems.discussionEntryId),
          eq(discussionEntries.discussionId, threadId),
        ))
        .where(eq(discussionExtractedItems.id, dep.blockerItemId))
        .then((rows) => rows[0] ?? null);
      if (!blockerItem) throw notFound("Blocker item not found in this thread");

      // Validate that blockedItemId belongs to this same discussion (via entry join).
      // Without this, an actor with edit rights could point blockedItemId at a
      // scope item from a different thread.
      const blockedItem = await db
        .select({ id: discussionExtractedItems.id })
        .from(discussionExtractedItems)
        .innerJoin(discussionEntries, and(
          eq(discussionEntries.id, discussionExtractedItems.discussionEntryId),
          eq(discussionEntries.discussionId, threadId),
        ))
        .where(eq(discussionExtractedItems.id, dep.blockedItemId))
        .then((rows) => rows[0] ?? null);
      if (!blockedItem) throw notFound("Blocked item not found in this thread");

      await db.insert(scopeItemDependencies).values({
        blockerItemId: dep.blockerItemId,
        blockedItemId: dep.blockedItemId,
      }).onConflictDoNothing();

      return { ok: true };
    },

    /**
     * Graduate scope_item_dependencies → task_dependencies for items that
     * have been converted to tasks (resultTaskId is set).
     * Idempotent: skips pairs that already exist in task_dependencies.
     * Returns count of newly created task dependencies.
     *
     * The caller (test or production) provides pre-joined rows in this shape:
     *   { id, blockerItemId, blockedItemId, blockerResultTaskId, blockedResultTaskId }
     * This avoids complex aliased self-joins that are hard to mock.
     * In the route handler we perform the two-step lookup ourselves before calling this.
     *
     * When called without sidRows, the method fetches them via a simple
     * two-query approach (get all scope_item_dependencies for the thread, then
     * batch-fetch both sides' resultTaskIds).
     */
    graduateScopeItemDependencies: async (
      companyId: string,
      threadId: string,
      actor: Actor,
      /**
       * Optional pre-computed rows from caller (used by route handler).
       * If omitted, the method fetches them from the DB.
       * Each row must include blockerResultTaskId and blockedResultTaskId.
       */
      precomputedRows?: Array<{
        id: string;
        blockerItemId: string;
        blockedItemId: string;
        blockerResultTaskId: string | null;
        blockedResultTaskId: string | null;
      }>,
    ) => {
      const thread = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, threadId), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!thread) throw notFound("Thread not found");
      await assertCanView(companyId, thread, actor);

      // Use pre-computed rows when provided (route handler path + test path)
      const sidRows = precomputedRows ?? [];

      // Fetch existing task_dependencies to detect duplicates (idempotency)
      const existingTdRows = await db
        .select({
          dependentIssueId: taskDependencies.dependentIssueId,
          dependencyIssueId: taskDependencies.dependencyIssueId,
        })
        .from(taskDependencies)
        .where(eq(taskDependencies.companyId, companyId))
        .then((rows) => rows);
      const existingSet = new Set(
        existingTdRows.map((r) => `${r.dependentIssueId}:${r.dependencyIssueId}`),
      );

      let graduated = 0;
      for (const row of sidRows) {
        const blockerTaskId = row.blockerResultTaskId;
        const blockedTaskId = row.blockedResultTaskId;

        if (!blockerTaskId || !blockedTaskId) continue; // skip: not yet a task
        const key = `${blockedTaskId}:${blockerTaskId}`;
        if (existingSet.has(key)) continue; // idempotent: already graduated

        await db.insert(taskDependencies).values({
          companyId,
          dependentIssueId: blockedTaskId,   // the blocked task depends on
          dependencyIssueId: blockerTaskId,  // the blocker task
        });
        graduated++;
      }

      return { graduated };
    },

    // ── Spin-off (child thread from a scope item) ─────────────────────────────

    /**
     * Create a spin-off child thread from a specific scope item.
     * Unlike fork (which copies the whole thread), spin-off creates a new
     * thread linked to a specific scope item as its origin.
     *
     * Creates:
     *   1. New discussion with forkedFromId = parentId
     *   2. threadLinks row with kind="spawned_from_task"
     *   3. First entry copying the scope item's context
     */
    spinOff: async (
      companyId: string,
      parentId: string,
      input: { scopeItemId: string; title?: string },
      actor: Actor,
    ) => {
      const parent = await db
        .select()
        .from(discussions)
        .where(and(eq(discussions.id, parentId), eq(discussions.companyId, companyId)))
        .then((rows) => rows[0] ?? null);
      if (!parent) throw notFound("Thread not found");
      await assertCanView(companyId, parent, actor);

      // Fetch the scope item for title/context
      const scopeItem = await db
        .select()
        .from(discussionExtractedItems)
        .where(eq(discussionExtractedItems.id, input.scopeItemId))
        .then((rows) => rows[0] ?? null);

      const childTitle = input.title ?? scopeItem?.title ?? `${parent.title ?? "Thread"} (spin-off)`;

      // Wrap all three inserts in a transaction for atomicity — all succeed or all roll back
      const child = await db.transaction(async (tx) => {
        const [newChild] = await tx
          .insert(discussions)
          .values({
            companyId,
            title: childTitle,
            scopeType: parent.scopeType,
            scopeId: parent.scopeId,
            phase: "discuss" as const,
            visibility: parent.visibility,
            forkedFromId: parent.id,
            ownerUserId: actor.isHuman ? actor.userId : null,
            createdBy: actor.userId,
          })
          .returning();

        // Create the "spawned_from_task" link
        await tx.insert(threadLinks).values({
          companyId,
          fromThreadId: newChild.id,
          toThreadId: parent.id,
          kind: "spawned_from_task",
          createdBy: actor.userId,
        });

        // Create first entry copying scope item context (if scope item found)
        if (scopeItem) {
          await tx.insert(discussionEntries).values({
            discussionId: newChild.id,
            inputType: "write",
            rawContent: [
              `Spun off from: ${parent.title ?? parentId}`,
              scopeItem.description ?? scopeItem.title,
            ]
              .filter(Boolean)
              .join("\n\n"),
            createdBy: actor.userId,
          });
        }

        return newChild;
      });

      await logActivity(db, {
        companyId,
        actorType: actor.isHuman ? "user" : "agent",
        actorId: actor.userId,
        action: "thread.spun_off",
        entityType: "discussion",
        entityId: parentId,
        details: { childId: child.id, scopeItemId: input.scopeItemId },
      });
      publishLiveEvent({
        companyId,
        type: "thread.scope.changed",
        payload: { threadId: parentId, childId: child.id },
      });
      return { id: child.id, forkedFromId: parent.id, title: child.title };
    },

    // ── Per-item routing ─────────────────────────────────────────────────────

    /**
     * Update the per-item routing fields on a discussion_extracted_items row.
     * Founder-gated: only founders can route items.
     * If assigneeAgentId is set, creates an agentWakeupRequests row so the
     * dispatcher processes the assignment.
     */
    routeItem: async (
      companyId: string,
      itemId: string,
      routing: {
        departmentId?: string;
        assigneeAgentId?: string;
        assigneeUserId?: string;
      },
      actor: Actor,
    ) => {
      // Founder-gated: hide-don't-403
      if (actor.role !== "founder") throw notFound("Thread not found");

      // Fetch the item with companyId guard — join through entry → discussion
      // to ensure the item belongs to this company (prevents cross-company mutation)
      const item = await db
        .select({ item: discussionExtractedItems })
        .from(discussionExtractedItems)
        .innerJoin(discussionEntries, eq(discussionEntries.id, discussionExtractedItems.discussionEntryId))
        .innerJoin(discussions, and(
          eq(discussions.id, discussionEntries.discussionId),
          eq(discussions.companyId, companyId),
        ))
        .where(eq(discussionExtractedItems.id, itemId))
        .then((rows) => rows[0]?.item ?? null);
      if (!item) throw notFound("Item not found");

      // Build update set (only provided fields) — typed to avoid unsound assignments
      const updates = {
        updatedAt: new Date(),
        ...(routing.departmentId !== undefined && { departmentId: routing.departmentId }),
        ...(routing.assigneeAgentId !== undefined && { assigneeAgentId: routing.assigneeAgentId }),
        ...(routing.assigneeUserId !== undefined && { assigneeUserId: routing.assigneeUserId }),
      };

      await db
        .update(discussionExtractedItems)
        .set(updates)
        .where(eq(discussionExtractedItems.id, itemId));

      // If assigneeAgentId is provided, wake the agent
      if (routing.assigneeAgentId) {
        await db.insert(agentWakeupRequests).values({
          companyId,
          agentId: routing.assigneeAgentId,
          source: "item_routing",
          triggerDetail: `Routed scope item ${itemId}`,
          reason: "item_routing",
          payload: { itemId },
          requestedByActorType: "board",
          requestedByActorId: actor.userId,
        });
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: actor.userId,
        action: "thread.item.routed",
        entityType: "discussion_extracted_item",
        entityId: itemId,
        details: routing,
      });
      return { itemId, ...routing };
    },

    // ── Living Plan (thread_plan_steps) ─────────────────────────────────────

    getPlanSteps: async (companyId: string, id: string, actor: Actor) => {
      const thread = await getByIdInternal(companyId, id, actor);
      if (!thread) throw notFound("Thread not found");
      return db
        .select()
        .from(threadPlanSteps)
        .where(eq(threadPlanSteps.threadId, id))
        .orderBy(asc(threadPlanSteps.stepOrder))
        .then((rows: typeof threadPlanSteps.$inferSelect[]) => rows);
    },

    updatePlanSteps: async (
      companyId: string,
      id: string,
      steps: Array<{ title: string; linkedItemId?: string | null; collapsed?: boolean }>,
      actor: Actor,
    ) => {
      const thread = await getByIdInternal(companyId, id, actor);
      if (!thread) throw notFound("Thread not found");
      await assertCanEdit(thread, actor);

      const inserted = await db.transaction(async (tx) => {
        await tx.delete(threadPlanSteps).where(eq(threadPlanSteps.threadId, id));
        if (steps.length === 0) return [] as Array<{ id: string }>;
        return tx
          .insert(threadPlanSteps)
          .values(
            steps.map((s, idx) => ({
              threadId: id,
              stepOrder: idx,
              title: s.title,
              linkedItemId: s.linkedItemId ?? null,
              collapsed: s.collapsed ?? false,
            })),
          )
          .returning({ id: threadPlanSteps.id });
      });

      await logActivity(db, {
        companyId,
        actorType: actor.isHuman ? "user" : "agent",
        actorId: actor.userId,
        action: "thread.plan.updated",
        entityType: "discussion",
        entityId: id,
        details: { count: inserted.length },
      });
      publishLiveEvent({ companyId, type: "thread.scope.changed", payload: { threadId: id } });
      return { count: inserted.length };
    },
  };
}
