import { and, asc, eq, inArray, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type {
  ThreadAgentActionStatus,
  ThreadAgentActionType,
  ThreadPhase,
} from "@armyofagents/shared";
import {
  agentWakeupRequests,
  agents,
  artifacts,
  discussionEntries,
  discussionEntryAttachments,
  discussions,
  internalAgentConfig,
  internalAgentRuns,
  threadAgentActions,
  threadOrchestrationState,
  threadScopeItems,
} from "@armyofagents/db";
import type { Db } from "@armyofagents/db";
import {
  compareFreshnessSnapshot,
  type ThreadFreshnessSnapshot,
  type ThreadFreshnessComparison,
} from "./thread-agent-action-freshness.js";
import { discussionService } from "./discussions.js";
import { threadScopeVersionService } from "./thread-scope-versions.js";
import { artifactService } from "./artifacts.js";
import { threadService, ensureAgentParticipant } from "./threads.js";
import { buildConveneWakeupDedupKey } from "./internal-agent/tools/thread-action-keys.js";
import { resolveRoleToAgentId } from "./internal-agent/tools/crew-role-map.js";
import { resolveScopeAutoAcceptGate, dispatchCreatedCrewTasks } from "./crew-task-service.js";
import { preflightCrewDispatch } from "./crew-budget.js";
import { approvalService } from "./approvals.js";
import { buildApprovalHubEmit, emitHubItem } from "./hub-source-producers.js";
import { logActivity } from "./activity-log.js";
import { extractionService } from "./extraction.js";
import { logger } from "../middleware/logger.js";
import { isUniqueViolation } from "./db-errors.js";

const log = logger.child({ service: "thread-agent-actions" });

// Action types whose side-effects are NOT durably idempotent under a cross-run RETRY,
// so a reaped/failed row of these types must NOT be re-selected (re-running would
// duplicate the side-effect). They still commit on their FIRST (`proposed`) attempt; on
// failure they are terminal and the agent re-proposes next turn if the work is still
// wanted. (Codex P2)
//   - convene_agent: its wakeup dedup (`agent_wakeup_requests_dedup_key_queued_uq`) is
//     scoped to `status = 'queued'`, so once the first wakeup is claimed/finished a retry
//     enqueues a SECOND wakeup.
//   - create_scope_draft: mints a `thread_scope_versions` row with no `source_action_id`;
//     `createDraftFromThread`'s "return existing draft" idempotency only holds while a
//     draft still exists, so a retry after the draft is accepted/rejected mints a new one.
// The other four types ARE retry-safe: post_reply / add_scope_item / create_artifact_candidate
// converge on their `source_action_id` partial-unique indexes, and advance_phase is absolute
// (re-applying the same phase is a no-op / rejected by canAdvancePhase).
const NON_IDEMPOTENT_RETRY_TYPES = ["convene_agent", "create_scope_draft"] as const;

type QueryChain = PromiseLike<unknown[]> & {
  from: (table: unknown) => QueryChain;
  where: (...args: unknown[]) => QueryChain;
  orderBy: (...args: unknown[]) => QueryChain;
  limit: (...args: unknown[]) => QueryChain;
  values: (value: unknown) => QueryChain;
  set: (value: unknown) => QueryChain;
  onConflictDoNothing: (...args: unknown[]) => QueryChain;
  returning: (...args: unknown[]) => QueryChain;
};

type DbLike = {
  select: (...args: unknown[]) => QueryChain;
  insert: (...args: unknown[]) => QueryChain;
  update: (...args: unknown[]) => QueryChain;
  transaction?: <T>(fn: (tx: DbLike) => Promise<T> | T) => Promise<T>;
};

type ThreadActionRow = {
  id: string;
  companyId: string;
  threadId: string;
  runId: string | null;
  agentId: string | null;
  actionType: string;
  status: string;
  blockedReason?: string | null;
  payload: unknown;
  idempotencyKey: string;
  freshness: ThreadFreshnessSnapshot;
  attemptCount?: number;
  maxAttempts?: number;
  // Null on a NO-OP create_scope_draft commit (no_entries/no_items) — the
  // discriminator the round-10 no-op revive keys on.
  committedScopeVersionId?: string | null;
};

export type ProposeThreadActionInput = {
  companyId: string;
  threadId: string;
  runId?: string | null;
  agentId?: string | null;
  actionType: ThreadAgentActionType;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  freshness?: Record<string, unknown>;
};

export type CommitThreadAgentActionsInput = {
  companyId: string;
  threadId: string;
  // #198 PR-B: the commit is THREAD-scoped, not run-scoped — any run drains the
  // thread's pending actions. `runId` is retained as an OPTIONAL audit stamp (the
  // run that triggered this commit tick); it is NOT used to filter the SELECT. The
  // fenced CAS claim + the source_action_id partial-unique indexes are the
  // duplicate-suppression backstop, so a thread-wide drain is safe.
  runId?: string;
};

export type CommitThreadAgentActionsResult = {
  committed: number;
  suppressed: number;
  blocked: number;
  failed: number;
  // Rows that lost the fenced CAS claim to a concurrent committer (or a reaper/failure
  // flipped them in the check→claim window). They were NOT committed/failed/suppressed
  // here, so the controller must reschedule rather than treat the batch as done. (Codex P2)
  lostRace: number;
};

type DiscussionCommitService = {
  addEntry: (
    companyId: string,
    discussionId: string,
    data: {
      inputType: string;
      rawContent: string;
      parentEntryId?: string | null;
      authorAgentId?: string | null;
      sourceInfo?: Record<string, unknown> | null;
      sourceActionId?: string | null;
    },
    actorId: string,
  ) => Promise<{ id: string }>;
};

type ScopeVersionCommitService = {
  createDraftFromThread: (
    companyId: string,
    threadId: string,
    actor: { userId?: string; agentId?: string; isHuman?: boolean },
    input: {
      summary?: string;
      assumptions?: unknown[];
      decisions?: unknown[];
      openQuestions?: unknown[];
      // W1a: Adjutant-supplied tasks (role-resolved to assigneeAgentId) forwarded to the compiler.
      proposedTasks?: Array<{ title: string; assigneeAgentId?: string | null }>;
      // W2: extraction already ran (extract-then-scope) — zero-item compiles must not
      // synthesize the fallback task card (no fake card, D6).
      suppressFallbackTask?: boolean;
      // Codex #270 P1: a truncated extraction pass caps the draft's range at the last
      // processed entry so the unprocessed tail stays in the next scope's range.
      sourceEndSeqOverride?: number;
    },
  ) => Promise<{ status: string; version?: { id: string } }>;
  // W1b: per-item apply (version-preserving). Memory candidates stay draft for the founder (D12).
  createOutputItem?: (
    companyId: string,
    threadId: string,
    scopeVersionId: string,
    itemId: string,
    actor: { userId?: string; agentId?: string; isHuman?: boolean },
    options?: { dispatchMode?: "standard" | "planning"; memoryStatus?: "approved" | "pending" },
  ) => Promise<{ ok: boolean; createdTask?: { id: string; assigneeAgentId: string | null; workMode: string | null } | undefined } | undefined>;
};

type ArtifactCommitService = {
  create: (
    companyId: string,
    actorId: string,
    input: {
      title: string;
      type: string;
      source: string;
      content?: string | null;
      fileUrl?: string | null;
      storageKind?: "inline" | "asset";
      assetId?: string | null;
      filename?: string | null;
      contentType?: string | null;
      extension?: string | null;
      byteSize?: number | null;
      sha256?: string | null;
      sourceActionId?: string | null;
    },
  ) => Promise<{ id: string; versions?: Array<{ id: string }> }>;
};

type ThreadCommitService = {
  advancePhase: (
    companyId: string,
    threadId: string,
    toPhase: string,
    actor: { userId: string; role: "team_member"; isHuman: false },
  ) => Promise<unknown>;
};

type ThreadAgentActionDeps = {
  compareFreshnessSnapshot?: (
    db: DbLike,
    threadId: string,
    snapshot: ThreadFreshnessSnapshot,
    actionType: string,
    // A-M7: scope-version id THIS batch already produced (see freshness service). Optional
    // so existing dep overrides / callers remain signature-compatible.
    batchProducedScopeVersionId?: string | null,
  ) => Promise<ThreadFreshnessComparison>;
  discussions?: DiscussionCommitService;
  scopeVersions?: ScopeVersionCommitService;
  artifacts?: ArtifactCommitService;
  threads?: ThreadCommitService;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function isThreadPhase(value: unknown): value is ThreadPhase {
  return value === "discuss" || value === "scope" || value === "assign" || value === "done";
}

async function updateActionStatus(
  db: DbLike,
  actionId: string,
  values: {
    status: ThreadAgentActionStatus;
    blockedReason?: string | null;
    committedEntryId?: string | null;
    committedScopeVersionId?: string | null;
    committedScopeItemId?: string | null;
    // When set, atomically bump attempt_count (used on the failed-retry path
    // so a poison row eventually stops being re-selected). (Review fix (c).)
    bumpAttempt?: boolean;
  },
) {
  const { bumpAttempt, ...rest } = values;
  const [updated] = await db
    .update(threadAgentActions)
    .set({
      ...rest,
      ...(bumpAttempt
        ? { attemptCount: sql`${threadAgentActions.attemptCount} + 1` }
        : {}),
      committedAt: values.status === "committed" ? new Date() : undefined,
      updatedAt: new Date(),
    })
    .where(eq(threadAgentActions.id, actionId))
    .returning();
  return updated;
}

/**
 * Fenced compare-and-swap for the proposed→committing claim. (PR-B Release-1.)
 *
 * Unlike {@link updateActionStatus} (which keys only on `id` and is used for the
 * downstream transitions this committer already owns), the claim must be a CAS:
 * it only wins if the row is still claimable (`status IN ('proposed','failed')`) AND
 * its `attempt_count` still matches the value observed when the row was SELECTed.
 * Together those close the check-then-act gap between the per-action freshness
 * re-check and the claim: a concurrent committer that already claimed the row flips
 * `status` out of the claimable set, and a concurrent reaper/failure that bumps
 * `attempt_count` changes the fence — either way the UPDATE touches 0 rows and the
 * empty `.returning()` signals a LOST RACE, so the caller skips the action.
 *
 * NOTE: `updated_at` is deliberately NOT a fence token. The column is microsecond
 * `timestamptz`, but a SELECTed value round-trips through a millisecond JS `Date`, so
 * `eq(updated_at, observed)` would almost never match a freshly-proposed row (its
 * default `now()` is microsecond) and the legitimate first claimer would phantom-lose.
 * `attempt_count` is an exact integer and advances on every failure/reaper flip, so it
 * fences the only mutation that matters here without the precision hazard.
 *
 * Mirrors the inbox-router status-CAS idiom. Strict narrowing of the previously-
 * unconditional claim → backward-compatible with the still-present run-scoped SELECT.
 */
async function claimActionForCommit(
  db: DbLike,
  actionId: string,
  fence: { attemptCount?: number },
) {
  const [claimed] = await db
    .update(threadAgentActions)
    .set({ status: "committing", updatedAt: new Date() })
    .where(
      and(
        eq(threadAgentActions.id, actionId),
        or(
          // `ready` = sealed (the producer promoted it on run success); `failed` = post-gate retry.
          // `proposed` is NOT claimable — an unsealed row is never committed (Decision #99 gate).
          eq(threadAgentActions.status, "ready"),
          eq(threadAgentActions.status, "failed"),
        ),
        eq(threadAgentActions.attemptCount, fence.attemptCount ?? 0),
      ),
    )
    .returning();
  return claimed;
}

export function threadAgentActionService(db: Db | DbLike, deps: ThreadAgentActionDeps = {}) {
  const actionDb = db as unknown as DbLike;
  const discussionCommitter =
    deps.discussions ?? discussionService(db as unknown as Db);
  const scopeVersionCommitter =
    deps.scopeVersions ?? threadScopeVersionService(db as unknown as Db);
  const artifactCommitter =
    deps.artifacts ?? artifactService(db as unknown as Db);
  const threadCommitter =
    deps.threads ?? threadService(db as unknown as Db);
  // Tx-bound resolvers for the create_artifact_candidate transaction (fix (e)):
  // artifact + draft + scope-item + attach must commit/roll back together. When
  // a dep override is supplied (tests), it is used verbatim — the fake does not
  // need a real tx binding; otherwise the committer is re-bound to the tx handle.
  const resolveScopeVersionCommitter = (dbArg: DbLike): ScopeVersionCommitService =>
    deps.scopeVersions ?? threadScopeVersionService(dbArg as unknown as Db);
  const resolveArtifactCommitter = (dbArg: DbLike): ArtifactCommitService =>
    deps.artifacts ?? artifactService(dbArg as unknown as Db);
  // Run `fn` inside a DB transaction when the handle supports it; otherwise fall
  // back to running against the bare handle (defensive — production `Db` always
  // exposes `.transaction`).
  const runInTransaction = <T>(fn: (tx: DbLike) => Promise<T>): Promise<T> =>
    actionDb.transaction ? actionDb.transaction(fn) : fn(actionDb);
  const compare = deps.compareFreshnessSnapshot ?? compareFreshnessSnapshot;

  return {
    proposeThreadAction: async (input: ProposeThreadActionInput) => {
      const [thread] = await actionDb
        .select({ id: discussions.id })
        .from(discussions)
        .where(and(eq(discussions.id, input.threadId), eq(discussions.companyId, input.companyId)))
        .limit(1);

      if (!thread) {
        // No row matched (id AND companyId). This fires for a genuinely-deleted
        // thread AND for a cross-company access attempt — both must be rejected
        // (the latter is a tenant-isolation boundary). proposeThreadAction is
        // only ever called from live internal-agent tools, never a background
        // sweep, so throwing here is correct; the runner's best-effort try/catch
        // swallows the deleted-thread case without surfacing a tool error.
        throw new Error("Thread not found");
      }

      // Outbox SEAL key-set (Mechanism B'): record that THIS run proposed this idempotency key,
      // so the runner / controller can seal it (proposed→ready) on run SUCCESS — the producer-gate
      // that keeps a failed/crashed run's actions from ever committing. Recorded BEFORE the insert
      // and regardless of insert-vs-collision (a re-proposed/collided key still counts as
      // proposed-by-this-run, which is how a later run recovers a crashed run's action). Durable on
      // the run row because proposeThreadAction runs in the bridge SUBPROCESS while the seal runs in
      // the runner — an in-memory key-set can't cross. 0-row update if the run is absent — harmless.
      if (input.runId) {
        await actionDb
          .update(internalAgentRuns)
          .set({
            proposedActionKeys: sql`${internalAgentRuns.proposedActionKeys} || ${JSON.stringify([input.idempotencyKey])}::jsonb`,
          })
          .where(eq(internalAgentRuns.id, input.runId));
      }

      // Race-safe insert: onConflictDoNothing on the (companyId, idempotencyKey)
      // unique index means a concurrent propose with the same key does NOT throw
      // a 500 unique-violation — it returns no row, and we re-select the existing
      // row instead. (Review fix (minor): TOCTOU between check and insert.)
      const [inserted] = await actionDb
        .insert(threadAgentActions)
        .values({
          companyId: input.companyId,
          threadId: input.threadId,
          runId: input.runId ?? null,
          agentId: input.agentId ?? null,
          actionType: input.actionType,
          status: "proposed",
          payload: input.payload ?? {},
          idempotencyKey: input.idempotencyKey,
          freshness: input.freshness ?? {},
        })
        .onConflictDoNothing({
          target: [threadAgentActions.companyId, threadAgentActions.idempotencyKey],
        })
        .returning();

      if (inserted) return inserted;

      // Conflict suppressed → the row already exists. Re-select and return it so
      // callers see the canonical (idempotent) action.
      const [existing] = (await actionDb
        .select()
        .from(threadAgentActions)
        .where(
          and(
            eq(threadAgentActions.companyId, input.companyId),
            eq(threadAgentActions.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1)) as ThreadActionRow[];

      // (PR-B) Thread-scoped commit sees rows regardless of runId, so the runId re-home is gone.
      // We keep ONE narrow case: a same-turn re-proposal (same idempotencyKey) that collides with a
      // terminal `suppressed_stale` row must revive it to `proposed` so the thread-scoped SELECT can
      // re-pick it — otherwise the action is stranded. We DO NOT forward runId, but we DO adopt the
      // re-proposal's freshness (Codex P2): a same-turn retry under a new run captured a snapshot
      // reflecting the CURRENT thread state, so keeping the old (already-failed) snapshot would
      // re-suppress the revived row on the next commit — e.g. a scope-coupled action stuck on
      // newer_scope_version even though THIS run observed the new scope. Persist input.freshness so
      // the row commits against what THIS run saw. (Mirrors the #202 re-home freshness fix.)
      // Revive a TERMINAL row a same-turn re-proposal should re-open, adopting the re-proposal's fresh
      // freshness: `suppressed_stale` (the world moved, then settled) OR `blocked_policy`/`run_not_sealed`
      // (a failed/crashed producer's row the GC terminalized, now re-proposed by a fresh successful run).
      // The latter is required because the GC self-heal re-seals such a row by the completed run's
      // key-set — without re-stamping freshness here it would carry the FAILED run's stale snapshot and
      // wrongly suppress a scope-coupled action as newer_scope_version even though THIS run saw the new
      // scope (Codex round-8; same class as the suppressed_stale revive + the #202 re-home freshness fix).
      // Codex #270 P2 (round 10): a create_scope_draft that committed WITHOUT minting a
      // draft (no_entries / no_items — e.g. extraction found no usable CLI) is a NO-OP
      // commit: there is no effect for idempotency to protect. Its run-independent,
      // turn-anchored key would otherwise absorb every same-turn re-proposal, so the
      // draft could never be re-attempted after the founder fixes extraction (until a
      // new human entry moves the turn anchor). Draft-minting AND existing_draft
      // commits both record the version id → non-null → stay terminal.
      const reviveFrom =
        existing &&
        (existing.status === "suppressed_stale" ||
          (existing.status === "blocked_policy" && existing.blockedReason === "run_not_sealed") ||
          (existing.status === "committed" &&
            existing.actionType === "create_scope_draft" &&
            existing.committedScopeVersionId == null))
          ? existing.status
          : null;
      if (existing && reviveFrom) {
        const [revived] = await actionDb
          .update(threadAgentActions)
          .set({
            status: "proposed",
            blockedReason: null,
            freshness: input.freshness ?? existing.freshness,
            // A revived no-op commit sheds its committedAt so the row reads as
            // genuinely in-flight again (committedScopeVersionId is already null).
            ...(reviveFrom === "committed" ? { committedAt: null } : {}),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(threadAgentActions.id, existing.id),
              eq(threadAgentActions.status, reviveFrom),
              // TOCTOU discipline: re-assert the no-op discriminator INSIDE the
              // guarded UPDATE — never revive a committed row that has a version.
              ...(reviveFrom === "committed"
                ? [isNull(threadAgentActions.committedScopeVersionId)]
                : []),
            ),
          )
          .returning();
        if (revived) return revived;
      }
      return existing;
    },

    // Outbox SEAL (Decision #99 producer-gate). A producing run, ON SUCCESS, promotes the
    // actions IT proposed this turn from `proposed` (in-flight, NOT committable) to `ready`
    // (committable by the relay). Sealed by the run's idempotency-KEY SET (Mechanism B) so a
    // re-proposed / collided row is covered regardless of which run's id is on it — no re-home.
    // A run that fails/crashes never seals → its `proposed` rows are never drained (the GC
    // reaps them). Caller wraps this + the run-status write in ONE tx by constructing the
    // service with the tx handle. See docs/aoa/plans/2026-06-19-prb-outbox-seal-design.md §0.
    sealRunActions: async (input: {
      companyId: string;
      threadId: string;
      idempotencyKeys: string[];
    }): Promise<number> => {
      if (input.idempotencyKeys.length === 0) return 0;
      const sealed = (await actionDb
        .update(threadAgentActions)
        .set({ status: "ready" satisfies ThreadAgentActionStatus, updatedAt: new Date() })
        .where(
          and(
            eq(threadAgentActions.companyId, input.companyId),
            eq(threadAgentActions.threadId, input.threadId),
            eq(threadAgentActions.status, "proposed"),
            inArray(threadAgentActions.idempotencyKey, input.idempotencyKeys),
          ),
        )
        .returning()) as unknown[];
      return sealed.length;
    },

    commitThreadAgentActions: async (
      input: CommitThreadAgentActionsInput,
    ): Promise<CommitThreadAgentActionsResult> => {
      const result: CommitThreadAgentActionsResult = {
        committed: 0,
        suppressed: 0,
        blocked: 0,
        failed: 0,
        lostRace: 0,
      };

      // #198 PR-B: the selection is THREAD-scoped, not run-scoped. The previous
      // `eq(runId, input.runId)` coupled a commit to the single run that proposed
      // each row, so a pending action stranded by an earlier run (re-proposed under
      // a new run, reaped to `failed`, etc.) could only ever be flushed by that
      // original run. Dropping the run filter lets ANY run drain the thread's
      // pending actions. Safe because: (1) the per-action fenced CAS claim
      // (`claimActionForCommit`) serializes concurrent committers on the same row,
      // and (2) the `source_action_id` partial-unique indexes make the side-effects
      // themselves idempotent. The existing
      // `thread_agent_actions_company_thread_status_idx` (companyId, threadId,
      // status, createdAt) covers this WHERE — no new index / migration needed.
      //
      // Select both "proposed" rows and "failed" rows that are still under their
      // attempt cap. A transient per-action failure (status="failed") is thus
      // retried on the next commit tick instead of being permanently dropped;
      // once attemptCount >= maxAttempts the row is no longer re-selected (poison
      // pill stops). (Review fix (c) part 3.)
      const actions = await actionDb
        .select()
        .from(threadAgentActions)
        .where(
          and(
            eq(threadAgentActions.companyId, input.companyId),
            eq(threadAgentActions.threadId, input.threadId),
            or(
              // The relay drains only SEALED `ready` rows — a producing run promoted them on
              // SUCCESS (Decision #99 producer-gate) — plus post-gate `failed` retries. An unsealed
              // `proposed` row (a run that failed, was cancelled, crashed, or is still in flight) is
              // NEVER drained: that is the structural fix for the failed-run-leak (Codex P1). The
              // freshness gate still applies per action; orphaned `proposed` rows are reaped by the GC.
              eq(threadAgentActions.status, "ready"),
              and(
                eq(threadAgentActions.status, "failed"),
                lt(threadAgentActions.attemptCount, threadAgentActions.maxAttempts),
                // Non-idempotent types are terminal on failure — never retried cross-run
                // (re-running would duplicate the wakeup / scope version). (Codex P2)
                notInArray(threadAgentActions.actionType, NON_IDEMPOTENT_RETRY_TYPES as unknown as string[]),
              ),
            ),
          ),
        )
        .orderBy(asc(threadAgentActions.createdAt)) as ThreadActionRow[];

      // Freshness is re-checked INSIDE the per-action loop (not once up front) so
      // a human entry arriving mid-commit suppresses the *remaining* actions, not
      // just the ones evaluated before the batch started. (Review fix (minor).)
      const freshActions: ThreadActionRow[] = actions;

      // Fallback artifact↔reply attachment state, PARTITIONED BY runId (Codex P2).
      // The thread-scoped SELECT now drains rows from MULTIPLE runs in one batch, so a
      // batch-global accumulator would attach a stranded run-A artifact candidate to a
      // run-B reply. Keying by runId keeps the implicit "same-run" attachment honest.
      // Actions with a null runId (run-independent) get NO implicit attach — there is
      // no reliable same-run signal, and the artifact is still created, just unattached.
      const sameRunArtifacts = new Map<string, Array<{ artifactId: string; attachedEntryId: string | null }>>();
      const sameRunReplyEntryId = new Map<string, string>();

      // A-M7: the scope-draft version id THIS batch has produced so far. The drain runs the
      // per-action freshness re-check BEFORE each commit body, and the freshness snapshot is
      // captured ONCE per run (shared across all of a run's proposed actions). So when an earlier
      // scope-producing action in this batch (create_scope_draft / add_scope_item /
      // create_artifact_candidate) mints a NEW draft, it advances the live latestScopeVersionId
      // past every sibling's snapshot — falsely tripping `newer_scope_version` on a sibling whose
      // own commit would REUSE that very draft (createDraftFromThread early-returns the existing
      // draft). Threading the produced version id into compare() lets the freshness check treat
      // "the live scope advanced, but only to the draft THIS batch made" as non-conflicting.
      let batchProducedScopeVersionId: string | null = null;
      const attachArtifactToEntry = async (
        artifactId: string,
        entryId: string,
        dbArg: DbLike = actionDb,
      ) => {
        await dbArg
          .insert(discussionEntryAttachments)
          .values({
            discussionEntryId: entryId,
            artifactId,
          })
          .returning();
      };

      // Validate that a caller-supplied target entry actually belongs to THIS
      // thread (and company) before attaching an artifact to it. Prevents a
      // cross-thread attachment within a company via a forged attachToEntryId.
      // (Review fix (minor): attachToEntryId not scoped to thread/company.)
      const isEntryInThread = async (entryId: string): Promise<boolean> => {
        const [row] = (await actionDb
          .select({ id: discussionEntries.id })
          .from(discussionEntries)
          .where(
            and(
              eq(discussionEntries.id, entryId),
              eq(discussionEntries.discussionId, input.threadId),
            ),
          )
          .limit(1)) as Array<{ id: string }>;
        return Boolean(row);
      };

      for (const action of freshActions) {
        try {
          // Claim FIRST (fenced CAS), THEN run the per-action freshness re-check + any suppress — so the
          // suppress writes only a row THIS committer exclusively owns (Codex round-7). With the
          // thread-scoped drain, two committers (a direct/mention run's in-band commit and the controller
          // sweep) can SELECT the same `ready` row; the fenced claim (status IN ('ready','failed') AND
          // attempt_count match) lets exactly one win. The loser's claim returns 0 rows → lostRace → skip,
          // so it can never clobber the winner's committing/committed row back to `suppressed_stale` —
          // which, for convene_agent, would later revive into a DUPLICATE wakeup. `ready` = sealed (the
          // producer promoted it on run success), `failed` = post-gate retry; `proposed` is NOT claimable.
          // Cross-run side-effect idempotency for the other types still rides on the run-independent
          // stable keys + `source_action_id` partial unique indexes (the branches below converge on the
          // unique violation); a reaper for stale `committing` rows is wired via reapStaleThreadAgentActions.
          const claimed = await claimActionForCommit(actionDb, action.id, {
            attemptCount: action.attemptCount,
          });
          if (!claimed) {
            // Lost the fenced CAS to a concurrent committer/reaper. Count it so the controller
            // reschedules instead of treating an all-lost batch as success (and advancing the cursor
            // past still-uncommitted work). (Codex P2)
            result.lostRace += 1;
            continue;
          }

          // Per-action freshness re-check AFTER owning the claim: re-evaluate against the live thread
          // state so a human entry that arrives mid-commit suppresses this (now-owned) action and the
          // REMAINING actions in the batch. updateActionStatus-by-id is safe here precisely because we
          // hold the claim — no concurrent committer can be on this row. Claiming a stale action we then
          // suppress is free: claimActionForCommit does NOT bump attempt_count, and suppressed_stale is
          // terminal (the row is not re-selected).
          const freshness = await compare(
            actionDb,
            input.threadId,
            action.freshness,
            action.actionType,
            batchProducedScopeVersionId,
          );
          if (!freshness.fresh) {
            await updateActionStatus(actionDb, action.id, {
              status: "suppressed_stale",
              blockedReason: freshness.reason,
            });
            result.suppressed += 1;
            continue;
          }

          if (action.actionType === "post_reply") {
            const payload = asRecord(action.payload);
            const rawContent = asString(payload.rawContent);
            if (!rawContent || !action.agentId) {
              await updateActionStatus(actionDb, action.id, {
                status: "blocked_policy",
                blockedReason: "invalid_post_reply_payload",
              });
              result.blocked += 1;
              continue;
            }

            // Same boundary as post-entry-tool.ts: the server engaged this agent
            // on the thread (gated crew run) — register it as a participant
            // BEFORE committing its reply, or the posting authz inside addEntry
            // 404s ("Thread not found") on any thread the agent can't otherwise
            // view. Third chokepoint of the crew-posting fix (live-QA 2026-07-16).
            // (Cast: DbLike is this service's loose structural handle; the
            // helper only runs insert().values().onConflictDoNothing().)
            await ensureAgentParticipant(actionDb as unknown as Db, input.companyId, input.threadId, action.agentId);

            let entry: { id: string };
            try {
              entry = await discussionCommitter.addEntry(
                input.companyId,
                input.threadId,
                {
                  inputType: "agent",
                  rawContent,
                  parentEntryId: asString(payload.parentEntryId) ?? null,
                  authorAgentId: action.agentId,
                  // Review fix (f): carry `sourceInfo` from the action payload
                  // through the commit so the committed entry preserves the same
                  // metadata the non-gated path persists (post-entry-tool.ts).
                  sourceInfo: (payload.sourceInfo as Record<string, unknown> | null) ?? null,
                  // #197: stamp the action id so the partial unique index makes this
                  // commit idempotent — the SAME action can never produce two entries.
                  sourceActionId: action.id,
                },
                `agent:${action.agentId}`,
                {
                  userId: action.agentId,
                  role: "team_member",
                  isHuman: false,
                  principalType: "agent",
                },
              );
            } catch (err) {
              if (!isUniqueViolation(err, "discussion_entries_source_action_uq")) throw err;
              // #197: the entry for this action already exists (single-invocation
              // partial crash, or the reaper flipped a stranded `committing` row to
              // `failed` after the entry write succeeded). Re-select it and converge —
              // no duplicate, NOT counted as a failure. NOTE: a fresh same-run artifact
              // is not drained onto this re-selected entry here (rare mid-batch crash);
              // tracked as a #198 residual.
              const [existing] = (await actionDb
                .select({ id: discussionEntries.id })
                .from(discussionEntries)
                .where(
                  and(
                    eq(discussionEntries.discussionId, input.threadId),
                    eq(discussionEntries.sourceActionId, action.id),
                  ),
                )
                .limit(1)) as Array<{ id: string }>;
              await updateActionStatus(actionDb, action.id, {
                status: "committed",
                committedEntryId: existing?.id ?? null,
              });
              result.committed += 1;
              continue;
            }
            // Record this reply as the same-run attach target + drain any artifacts
            // already accumulated for THIS run (run-scoped — see declarations above).
            if (action.runId) {
              sameRunReplyEntryId.set(action.runId, entry.id);
              for (const artifactRef of sameRunArtifacts.get(action.runId) ?? []) {
                if (artifactRef.attachedEntryId) continue;
                await attachArtifactToEntry(artifactRef.artifactId, entry.id);
                artifactRef.attachedEntryId = entry.id;
              }
            }
            await updateActionStatus(actionDb, action.id, {
              status: "committed",
              committedEntryId: entry.id,
            });
            result.committed += 1;

            // @mention summons are enqueued to the transactional outbox INSIDE
            // discussionCommitter.addEntry's tx (with hopCount:1 for this
            // agent-authored, inputType:'agent' reply) and drained exactly-once by
            // the mention-outbox worker (PR #291 round-8 #1). The previous direct
            // processMentions call here double-summoned on top of the outbox
            // (hop bump / double participation). Removed — the outbox is now the
            // single summon path for this committed reply.
            continue;
          }

          if (action.actionType === "create_scope_draft") {
            const payload = asRecord(action.payload);

            // Resolve each proposed task's assigneeRole → crew agentId (server-side;
            // the controller tool drops this in controller mode). Unknown/missing roles
            // resolve to null (unassigned task — not an error). (W1a Task 4)
            const rawTasks = (asArray(payload.proposedTasks) ?? []) as Array<{ title?: unknown; assigneeRole?: unknown }>;
            const proposedTasks = await Promise.all(
              rawTasks
                .filter((t) => typeof t?.title === "string" && (t.title as string).trim().length > 0)
                .map(async (t) => ({
                  title: t.title as string,
                  assigneeAgentId:
                    typeof t.assigneeRole === "string"
                      ? (await resolveRoleToAgentId(actionDb as unknown as { select: Function }, input.companyId, t.assigneeRole)) ?? null
                      : null,
                })),
            );

            // W2 (D6 extract-then-scope): run keyless CLI extraction over the thread's
            // never-extracted entries and WAIT, so the draft compiles from real items.
            // Best-effort — extraction failure (CLI missing/not authed/timeout) must never
            // block draft creation; the compiler then sees zero items and, because we pass
            // suppressFallbackTask below, emits NO fake card (D6). The helper itself is
            // bounded (25-entry cap + 180s wall-clock deadline) and never throws; the
            // try/catch is defense-in-depth.
            //
            // Codex #270 P2: SKIPPED when the Adjutant supplied proposedTasks — those
            // already define the draft's work (the compiler suppresses extracted task
            // cards under D1 anyway), so extracting here would only persist pending
            // task items a founder could later approve into DUPLICATE tasks.
            let sourceEndSeqOverride: number | undefined;
            if (proposedTasks.length === 0) {
              try {
                const extraction = await extractionService(
                  actionDb as unknown as import("@armyofagents/db").Db,
                ).extractThreadEntriesAwait(input.companyId, input.threadId);
                log.info(
                  { threadId: input.threadId, ...extraction },
                  "extract-then-scope completed before draft compile",
                );
                // Codex #270 P1+P2 (rounds 3-6): the helper folds every range signal —
                // count-cap/deadline truncation AND the first entry whose extraction did
                // not complete — into rangeEndCap. Cap the draft's range there so
                // unprocessed/failed entries stay in the NEXT scope's range (an
                // all-failed pass caps below the start -> no_entries -> no draft, and
                // everything stays retryable). Round 9: if the capped range holds only
                // permanently non-extractable entries (e.g. a short "ok" prefix before
                // the first failure), the zero-item compile returns no_items instead of
                // minting an EMPTY draft that would block later passes behind
                // existing_draft.
                if (extraction.rangeEndCap != null) {
                  sourceEndSeqOverride = extraction.rangeEndCap;
                }
              } catch (err) {
                log.warn({ err, threadId: input.threadId },
                  "extract-then-scope failed — compiling draft from existing items only");
              }

              // Codex #270 P1: the awaited extraction above can run for minutes — long
              // enough for a founder to add newer human entries. The per-action freshness
              // re-check ran BEFORE that wait, so re-run it here: a thread that moved on
              // must suppress this action (same terminal outcome as the pre-commit check),
              // not mint a draft covering input the proposing run never saw. (Tied to the
              // extraction branch — the proposedTasks path performs no comparable wait.)
              const postExtractionFreshness = await compare(
                actionDb,
                input.threadId,
                action.freshness,
                action.actionType,
                batchProducedScopeVersionId,
              );
              if (!postExtractionFreshness.fresh) {
                await updateActionStatus(actionDb, action.id, {
                  status: "suppressed_stale",
                  blockedReason: postExtractionFreshness.reason,
                });
                result.suppressed += 1;
                continue;
              }
            }

            const draft = await scopeVersionCommitter.createDraftFromThread(
              input.companyId,
              input.threadId,
              { agentId: action.agentId ?? undefined, isHuman: false },
              {
                summary: asString(payload.summary),
                assumptions: asArray(payload.assumptions),
                decisions: asArray(payload.decisions),
                openQuestions: asArray(payload.openQuestions),
                ...(proposedTasks.length > 0 ? { proposedTasks } : {}),
                // W2: extraction already ran (or proposedTasks define the work) — an
                // empty compile must not invent a fake card.
                suppressFallbackTask: true,
                ...(sourceEndSeqOverride != null ? { sourceEndSeqOverride } : {}),
              },
            );

            // W1b: autonomy-gated auto-accept of the freshly-created draft.
            if (draft.status === "created" && draft.version?.id) {
              try {
                // effectiveAutonomy = thread.autonomyLevel ?? company.crewAutonomyLevel
                // (mirror controller-adjutant-runner). D18: the company fallback is the
                // agent-work dial — scope auto-accept creates and dispatches crew tasks.
                const [threadRow] = (await actionDb.select({ autonomyLevel: discussions.autonomyLevel })
                  .from(discussions).where(eq(discussions.id, input.threadId)).limit(1)) as Array<{ autonomyLevel: number | null }>;
                const [cfg] = (await actionDb.select({ autonomyLevel: internalAgentConfig.crewAutonomyLevel })
                  .from(internalAgentConfig).where(eq(internalAgentConfig.companyId, input.companyId)).limit(1)) as Array<{ autonomyLevel: number }>;
                const effectiveAutonomy = threadRow?.autonomyLevel != null ? threadRow.autonomyLevel : (cfg?.autonomyLevel ?? 0);
                const gate = resolveScopeAutoAcceptGate(effectiveAutonomy);

                if (gate !== "draft_only") {
                  // Codex #265 P1: the Drive gate applies AND dispatches real crew work in one
                  // shot, so it must honor the same budget hard-stop + thread pause/disable
                  // preflight as crewTaskService.approveAndDispatch. When blocked, we neither
                  // apply nor dispatch — the created draft is left for the founder to accept
                  // manually (identical to the draft_only outcome). Assist (accept_apply →
                  // planning tasks, no dispatch) consumes no budget and defers its dispatch gate
                  // to the founder's W1c approval, so it is exempt from the preflight here.
                  let driveBlocked = false;
                  if (gate === "accept_apply_dispatch") {
                    const preflight = await preflightCrewDispatch(
                      actionDb as unknown as import("@armyofagents/db").Db,
                      {
                        companyId: input.companyId,
                        agentId: action.agentId ?? "",
                        threadId: input.threadId,
                      },
                    );
                    if (!preflight.allowed) {
                      driveBlocked = true;
                      log.info(
                        { threadId: input.threadId, versionId: draft.version.id, reasonCode: preflight.reasonCode },
                        "W1b Drive auto-dispatch blocked by preflight — draft left for manual accept",
                      );
                    }
                  }

                  if (!driveBlocked) {
                    const dispatchMode = gate === "accept_apply_dispatch" ? "standard" : "planning";
                    // Apply ONLY task_proposal items, one-by-one via createOutputItem (version-preserving).
                    // memory_candidate/decision items stay draft → founder-gated (D12). NOT applyAcceptedDraft (it closes
                    // the version and would strand un-accepted memory items).
                    const taskItems = (await actionDb.select({ id: threadScopeItems.id })
                      .from(threadScopeItems)
                      .where(and(
                        eq(threadScopeItems.scopeVersionId, draft.version.id),
                        eq(threadScopeItems.kind, "task_proposal"),
                        eq(threadScopeItems.status, "draft"),
                      ))) as Array<{ id: string }>;
                    const createdTasks: Array<{ id: string; assigneeAgentId: string | null; workMode: string | null }> = [];
                    for (const { id: itemId } of taskItems) {
                      const res = await scopeVersionCommitter.createOutputItem?.(
                        input.companyId, input.threadId, draft.version.id, itemId,
                        { agentId: action.agentId ?? undefined, isHuman: false },
                        { dispatchMode },
                      );
                      if (res?.ok && res.createdTask) createdTasks.push(res.createdTask);
                    }
                    if (gate === "accept_apply_dispatch" && createdTasks.length > 0) {
                      await dispatchCreatedCrewTasks(actionDb as unknown as import("@armyofagents/db").Db, input.companyId, createdTasks);
                    }
                    // W1c: Assist auto-creates the tasks as 'planning' but does not
                    // dispatch — instead enqueue ONE crew-dispatch approval into the
                    // Inbox. Approving it (via /approvals) flips these tasks to
                    // 'standard' and dispatches them (approvals.ts crew_dispatch branch).
                    // system-originated: requestedBy* = null so the approve route's
                    // generic requester-wakeup + trust-score bump do not fire.
                    if (gate === "accept_apply" && createdTasks.length > 0) {
                      const created = await approvalService(
                        actionDb as unknown as import("@armyofagents/db").Db,
                      ).create(input.companyId, {
                        type: "crew_dispatch",
                        status: "pending",
                        requestedByAgentId: null,
                        requestedByUserId: null,
                        payload: {
                          threadId: input.threadId,
                          scopeVersionId: draft.version.id,
                          taskIds: createdTasks.map((t) => t.id),
                          proposedByAgentId: action.agentId ?? null,
                        },
                        decisionNote: null,
                        decidedByUserId: null,
                        decidedAt: null,
                        updatedAt: new Date(),
                      });
                      if (created) {
                        await emitHubItem(
                          actionDb as unknown as import("@armyofagents/db").Db,
                          buildApprovalHubEmit(created),
                        );
                        // Codex #267 P2: this Assist path creates the approval directly,
                        // bypassing the /approvals route's approval.created activity write.
                        // Log it here so system-created crew_dispatch approvals are audited
                        // like route-created ones.
                        await logActivity(actionDb as unknown as import("@armyofagents/db").Db, {
                          companyId: input.companyId,
                          actorType: action.agentId ? "agent" : "system",
                          actorId: action.agentId ?? "system",
                          agentId: action.agentId ?? null,
                          action: "approval.created",
                          entityType: "approval",
                          entityId: created.id,
                          details: {
                            type: "crew_dispatch",
                            taskIds: createdTasks.map((t) => t.id),
                            source: "assist_auto_apply",
                          },
                        });
                      }
                    }
                  }
                }
              } catch (err) {
                log.warn({ err, threadId: input.threadId, versionId: draft.version?.id },
                  "W1b auto-accept failed — draft left for manual accept");
              }
            }

            // A-M7: record the draft this batch just produced so a SUBSEQUENT scope-coupled
            // sibling (which will reuse this exact draft) is not falsely suppressed as
            // newer_scope_version against the shared, pre-batch snapshot.
            if (draft.version?.id) batchProducedScopeVersionId = draft.version.id;
            await updateActionStatus(actionDb, action.id, {
              status: "committed",
              committedScopeVersionId: draft.version?.id ?? null,
            });
            result.committed += 1;
            continue;
          }

          if (action.actionType === "add_scope_item") {
            const payload = asRecord(action.payload);
            const kind = asString(payload.kind);
            const title = asString(payload.title);
            if (!kind || !title) {
              await updateActionStatus(actionDb, action.id, {
                status: "blocked_policy",
                blockedReason: "invalid_scope_item_payload",
              });
              result.blocked += 1;
              continue;
            }

            const draft = await scopeVersionCommitter.createDraftFromThread(
              input.companyId,
              input.threadId,
              { agentId: action.agentId ?? undefined, isHuman: false },
              {},
            );
            const scopeVersionId = draft.version?.id;
            if (!scopeVersionId) {
              await updateActionStatus(actionDb, action.id, {
                status: "blocked_policy",
                blockedReason: "scope_draft_unavailable",
              });
              result.blocked += 1;
              continue;
            }
            // A-M7: this draft is now the live latest scope version — record it so a later
            // scope-coupled sibling reusing it is not falsely suppressed (see above).
            batchProducedScopeVersionId = scopeVersionId;

            let item: { id?: string } | undefined;
            try {
              [item] = (await actionDb
                .insert(threadScopeItems)
                .values({
                  companyId: input.companyId,
                  scopeVersionId,
                  kind,
                  status: "draft",
                  title,
                  description: asString(payload.content) ?? asString(payload.description) ?? null,
                  payload,
                  sourceEntryIds: asArray(payload.sourceEntryIds) ?? [],
                  // #198: stamp the action id so the partial unique index makes this
                  // commit idempotent — the SAME action can never produce two items.
                  sourceActionId: action.id,
                })
                .returning()) as Array<{ id?: string }>;
            } catch (err) {
              if (!isUniqueViolation(err, "thread_scope_items_source_action_uq")) throw err;
              // #198: this action already produced a scope item (single-invocation
              // partial crash, or the reaper flipped a stranded `committing` row to
              // `failed` after the item write succeeded). Re-select and converge — no
              // duplicate, NOT counted as a failure. Stamp the EXISTING row's scope
              // version (a re-run may have landed in a new draft version).
              const [existing] = (await actionDb
                .select({
                  id: threadScopeItems.id,
                  scopeVersionId: threadScopeItems.scopeVersionId,
                })
                .from(threadScopeItems)
                .where(
                  and(
                    eq(threadScopeItems.companyId, input.companyId),
                    eq(threadScopeItems.sourceActionId, action.id),
                  ),
                )
                .limit(1)) as Array<{ id: string; scopeVersionId: string }>;
              await updateActionStatus(actionDb, action.id, {
                status: "committed",
                committedScopeVersionId: existing?.scopeVersionId ?? scopeVersionId,
                committedScopeItemId: existing?.id ?? null,
              });
              result.committed += 1;
              continue;
            }

            await updateActionStatus(actionDb, action.id, {
              status: "committed",
              committedScopeVersionId: scopeVersionId,
              committedScopeItemId: (item as { id?: string } | undefined)?.id ?? null,
            });
            result.committed += 1;
            continue;
          }

          if (action.actionType === "convene_agent") {
            const payload = asRecord(action.payload);
            const targetAgentId = asString(payload.targetAgentId);
            if (!targetAgentId) {
              await updateActionStatus(actionDb, action.id, {
                status: "blocked_policy",
                blockedReason: "invalid_convene_agent_payload",
              });
              result.blocked += 1;
              continue;
            }

            const [targetAgent] = await actionDb
              .select({ id: agents.id, companyId: agents.companyId })
              .from(agents)
              .where(eq(agents.id, targetAgentId))
              .limit(1) as Array<{ id: string; companyId: string }>;

            if (!targetAgent || targetAgent.companyId !== input.companyId) {
              await updateActionStatus(actionDb, action.id, {
                status: "blocked_policy",
                blockedReason: "target_agent_not_in_company",
              });
              result.blocked += 1;
              continue;
            }

            const context = asRecord(payload.context);
            const reason = asString(payload.reason) ?? "agent_dispatch";
            // PR-B2 (#202 P2): discriminate the wakeup dedupKey on the STABLE committing
            // action id — NOT free-text reason — so two genuinely-distinct convene actions
            // to the same target both enqueue a wakeup while a same-action commit race
            // collapses to one. The `:queued` suffix keeps the partial unique index
            // agent_wakeup_requests_dedup_key_queued_uq the cross-process guard (bare
            // onConflictDoNothing below).
            const dedupKey = buildConveneWakeupDedupKey({
              targetAgentId,
              threadId: input.threadId,
              sourceActionId: action.id,
            });
            await actionDb
              .insert(agentWakeupRequests)
              .values({
                companyId: input.companyId,
                agentId: targetAgentId,
                source: "agent.dispatch",
                reason,
                payload: context,
                dedupKey,
                status: "queued",
              })
              .onConflictDoNothing()
              .returning();

            await updateActionStatus(actionDb, action.id, {
              status: "committed",
            });
            result.committed += 1;
            continue;
          }

          if (action.actionType === "create_artifact_candidate") {
            const payload = asRecord(action.payload);
            const title = asString(payload.title);
            const agentId = action.agentId;
            if (!title || !agentId) {
              await updateActionStatus(actionDb, action.id, {
                status: "blocked_policy",
                blockedReason: "invalid_artifact_candidate_payload",
              });
              result.blocked += 1;
              continue;
            }

            const explicitEntryId = asString(payload.attachToEntryId);
            const assetId = asString(payload.assetId);
            const storageKind = asString(payload.storageKind) === "asset" && assetId ? "asset" : "inline";
            const byteSize = typeof payload.byteSize === "number" ? payload.byteSize : null;
            // Validate the caller-supplied attach target is in THIS thread BEFORE
            // any writes — reject a forged cross-thread attachToEntryId up front
            // so no artifact is created for an invalid target. (Review fix (minor).)
            if (explicitEntryId && !(await isEntryInThread(explicitEntryId))) {
              await updateActionStatus(actionDb, action.id, {
                status: "blocked_policy",
                blockedReason: "attach_target_not_in_thread",
              });
              result.blocked += 1;
              continue;
            }

            // Sentinel used to abort the transaction when the scope draft is
            // unavailable — rolls back the artifact + version so no orphan remains.
            const SCOPE_DRAFT_UNAVAILABLE = Symbol("scope_draft_unavailable");

            // Wrap the whole action body in ONE transaction (Review fix (e)): the
            // artifact, its version, the scope draft, the scope item, and the
            // attachment all commit or roll back together. The scope draft is
            // resolved+validated FIRST so an unavailable draft aborts before any
            // artifact row is written — the previously-reachable orphan path is
            // closed.
            let committed: { scopeVersionId: string; scopeItemId: string | null } | null = null;
            try {
              committed = await runInTransaction(async (tx) => {
                const txScopeVersions = resolveScopeVersionCommitter(tx);
                const txArtifacts = resolveArtifactCommitter(tx);

                const draft = await txScopeVersions.createDraftFromThread(
                  input.companyId,
                  input.threadId,
                  { agentId, isHuman: false },
                  {},
                );
                const scopeVersionId = draft.version?.id;
                if (!scopeVersionId) {
                  throw SCOPE_DRAFT_UNAVAILABLE;
                }

                const artifact = await txArtifacts.create(
                  input.companyId,
                  agentId,
                  {
                    title,
                    type: asString(payload.artifactType) ?? "document",
                    source: "agent",
                    content: storageKind === "asset" ? null : (asString(payload.content) ?? null),
                    fileUrl: storageKind === "asset" ? null : (asString(payload.fileRef) ?? null),
                    storageKind,
                    assetId: storageKind === "asset" ? assetId : null,
                    filename: storageKind === "asset" ? (asString(payload.filename) ?? null) : null,
                    contentType: storageKind === "asset" ? (asString(payload.contentType) ?? null) : null,
                    extension: storageKind === "asset" ? (asString(payload.extension) ?? null) : null,
                    byteSize: storageKind === "asset" ? byteSize : null,
                    sha256: storageKind === "asset" ? (asString(payload.sha256) ?? null) : null,
                    // #197: stamp the action id so the partial unique index makes this
                    // artifact commit idempotent across re-runs / reaper re-commits.
                    sourceActionId: action.id,
                  },
                );
                const artifactVersionId = artifact.versions?.[0]?.id ?? null;

                const [item] = await tx
                  .insert(threadScopeItems)
                  .values({
                    companyId: input.companyId,
                    scopeVersionId,
                    kind: "artifact_link",
                    status: "draft",
                    title,
                    description: "Artifact candidate created by agent",
                    artifactId: artifact.id,
                    artifactVersionId,
                    payload: {
                      ...payload,
                      artifactId: artifact.id,
                      artifactVersionId,
                      role: "reference",
                    },
                    sourceEntryIds: explicitEntryId ? [explicitEntryId] : [],
                  })
                  .returning();

                // Implicit attach is run-scoped (Codex P2): only attach to a reply
                // from the SAME run, never across runs in a thread-scoped batch. A
                // null-runId artifact gets no implicit attach (no same-run signal).
                const runReplyEntryId = action.runId ? sameRunReplyEntryId.get(action.runId) : undefined;
                if (explicitEntryId) {
                  await attachArtifactToEntry(artifact.id, explicitEntryId, tx);
                } else if (runReplyEntryId) {
                  await attachArtifactToEntry(artifact.id, runReplyEntryId, tx);
                } else if (action.runId) {
                  const pending = sameRunArtifacts.get(action.runId) ?? [];
                  pending.push({ artifactId: artifact.id, attachedEntryId: null });
                  sameRunArtifacts.set(action.runId, pending);
                }

                return {
                  scopeVersionId,
                  scopeItemId: (item as { id?: string } | undefined)?.id ?? null,
                };
              });
            } catch (txError) {
              if (txError === SCOPE_DRAFT_UNAVAILABLE) {
                // Draft never materialized → artifact (if any) rolled back. Mark
                // the action blocked; no orphan artifact exists.
                await updateActionStatus(actionDb, action.id, {
                  status: "blocked_policy",
                  blockedReason: "scope_draft_unavailable",
                });
                result.blocked += 1;
                continue;
              }
              if (isUniqueViolation(txError, "artifacts_source_action_uq")) {
                // #197: the artifact for this action already exists (single-invocation
                // partial crash / reaper re-commit). The tx rolled back; converge on
                // the existing rows — no duplicate, NOT counted as a failure.
                const [existingArtifact] = (await actionDb
                  .select({ id: artifacts.id })
                  .from(artifacts)
                  .where(
                    and(
                      eq(artifacts.companyId, input.companyId),
                      eq(artifacts.sourceActionId, action.id),
                    ),
                  )
                  .limit(1)) as Array<{ id: string }>;
                const [existingItem] = existingArtifact
                  ? ((await actionDb
                      .select({
                        id: threadScopeItems.id,
                        scopeVersionId: threadScopeItems.scopeVersionId,
                      })
                      .from(threadScopeItems)
                      // Narrow to the artifact_link row this action created (a later,
                      // unrelated draft can reference the same artifactId with a
                      // different kind) and order deterministically so convergence
                      // stamps the ORIGINAL scope version, not a stale one. (Review I1.)
                      .where(
                        and(
                          eq(threadScopeItems.artifactId, existingArtifact.id),
                          eq(threadScopeItems.kind, "artifact_link"),
                        ),
                      )
                      .orderBy(asc(threadScopeItems.createdAt))
                      .limit(1)) as Array<{ id: string; scopeVersionId: string }>)
                  : [];
                // A-M7: a converged (idempotent re-commit) artifact still points at a live
                // scope draft — record it for later scope-coupled siblings in this batch.
                if (existingItem?.scopeVersionId) batchProducedScopeVersionId = existingItem.scopeVersionId;
                await updateActionStatus(actionDb, action.id, {
                  status: "committed",
                  committedScopeVersionId: existingItem?.scopeVersionId ?? null,
                  committedScopeItemId: existingItem?.id ?? null,
                });
                result.committed += 1;
                continue;
              }
              throw txError;
            }

            // A-M7: the artifact candidate's tx produced/reused a scope draft; record it so a
            // later scope-coupled sibling reusing it is not falsely suppressed (see above).
            if (committed.scopeVersionId) batchProducedScopeVersionId = committed.scopeVersionId;
            await updateActionStatus(actionDb, action.id, {
              status: "committed",
              committedScopeVersionId: committed.scopeVersionId,
              committedScopeItemId: committed.scopeItemId,
            });
            result.committed += 1;
            continue;
          }

          if (action.actionType === "advance_phase") {
            const payload = asRecord(action.payload);
            const toPhase = asString(payload.toPhase);
            const effectiveAutonomy =
              typeof payload.effectiveAutonomy === "number" ? payload.effectiveAutonomy : 0;
            if (!isThreadPhase(toPhase)) {
              await updateActionStatus(actionDb, action.id, {
                status: "blocked_policy",
                blockedReason: "invalid_advance_phase_payload",
              });
              result.blocked += 1;
              continue;
            }
            if (effectiveAutonomy < 2) {
              await updateActionStatus(actionDb, action.id, {
                status: "blocked_policy",
                blockedReason: "autonomy_insufficient",
              });
              result.blocked += 1;
              continue;
            }

            await threadCommitter.advancePhase(
              input.companyId,
              input.threadId,
              toPhase,
              {
                userId: action.agentId ?? "aoa-agent",
                role: "team_member",
                isHuman: false,
              },
            );

            await updateActionStatus(actionDb, action.id, {
              status: "committed",
            });
            result.committed += 1;
            continue;
          }

          await updateActionStatus(actionDb, action.id, {
            status: "blocked_policy",
            blockedReason: `unsupported_action:${action.actionType}`,
          });
          result.blocked += 1;
        } catch (error) {
          // Bump attempt_count on every failure so a poison row eventually stops
          // being re-selected once it hits maxAttempts. (Review fix (c) part 3.)
          await updateActionStatus(actionDb, action.id, {
            status: "failed",
            blockedReason: error instanceof Error ? error.message : "commit_failed",
            bumpAttempt: true,
          });
          result.failed += 1;
        }
      }

      return result;
    },
  };
}

/**
 * Default TTL after which a `committing` thread-agent-action row is considered
 * crash-stranded. A commit that takes longer than this almost certainly died
 * mid-flight (process crash, lost connection) rather than legitimately running,
 * so the reaper resets it for a bounded retry.
 */
export const STALE_COMMITTING_TTL_MS = 10 * 60 * 1000;

/**
 * Conservative wall-clock age — measured from run START — past which a still-`running` run that left
 * unsealed `proposed` thread actions is treated as hard-CRASHED by the zombie reaper (GC Step 1).
 *
 * IMPORTANT: this is a START-age signal, NOT a liveness/idle signal. `internal_agent_runs` has no
 * per-event heartbeat column, the runner's stream callbacks don't touch the row mid-run, and the
 * 30-min idle timeout in `cli-mode.ts` governs the interactive SSE chat session — NOT this
 * `controller_action_gate` runner, which has no hard wall-clock cap. So a genuinely-LIVE run that
 * stays continuously active for >2h CAN be force-failed by Step 1. That is made NON-LOSSY by Step 2's
 * self-heal: when the run actually completes, its key-set recovers any rows Step 3 terminalized (≤2-min
 * delay). A true idle-lease (heartbeat column) that avoids the false-reap entirely is a tracked
 * follow-up. 2h is ≫ any realistic coordinator-run duration, so the false-reap is rare in practice.
 */
export const ZOMBIE_RUN_TTL_MS = 2 * 60 * 60 * 1000;

export interface ReapStaleThreadAgentActionsResult {
  reaped: number;
}

/**
 * Reaper for crash-stranded thread-agent-action rows.
 *
 * A row left in `committing` past {@link STALE_COMMITTING_TTL_MS} (because the
 * committing process crashed before it could write a terminal status) would
 * otherwise sit forever — never re-selected by `commitThreadAgentActions`
 * (which only picks `proposed` + retryable `failed`) and never advancing the
 * orchestration cursor. This sweeper flips such rows to `failed` and bumps
 * `attemptCount`, so they become re-selectable under the attempt cap (fix (c))
 * but a perpetually-crashing row eventually stops once it hits `maxAttempts`.
 *
 * Mirrors `sweepExpiredWorkspaces` in `workspace-ttl-sweeper.ts`: a single
 * bounded UPDATE, returns a count, safe to run on the existing sweep cadence.
 *
 * Wired into `runControllerSweep` (`sweep-controller.ts`), which runs on the
 * 2-minute controller-sweep cadence: the reaper fires best-effort at the start
 * of each sweep so stranded `committing` rows are flipped to `failed` (under the
 * attempt cap) before the sweep drains pending threads.
 */
export async function reapStaleThreadAgentActions(
  db: Db | DbLike,
  opts: { ttlMs?: number; now?: Date } = {},
): Promise<ReapStaleThreadAgentActionsResult> {
  const reaperDb = db as unknown as DbLike;
  const ttlMs = opts.ttlMs ?? STALE_COMMITTING_TTL_MS;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - ttlMs);

  const reaped = (await reaperDb
    .update(threadAgentActions)
    .set({
      status: "failed",
      blockedReason: "reaped_stale_committing",
      attemptCount: sql`${threadAgentActions.attemptCount} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        inArray(threadAgentActions.status, ["committing"]),
        lt(threadAgentActions.updatedAt, cutoff),
      ),
    )
    .returning()) as Array<{ threadId?: string }>;

  // Re-arm the controller for every thread we just reaped (Codex P2): the reaper flips
  // committing→failed, but runControllerSweep only drives threads with pendingRun=true,
  // so without this the now-retryable row would sit until some unrelated future trigger.
  // Marking the affected threads pendingRun lets the next sweep re-drive them and the
  // thread-scoped commit re-select the failed row (bounded by attemptCount < maxAttempts).
  const reapedThreadIds = [
    ...new Set(reaped.map((r) => r.threadId).filter((id): id is string => typeof id === "string")),
  ];
  if (reapedThreadIds.length > 0) {
    await reaperDb
      .update(threadOrchestrationState)
      .set({ pendingRun: true, updatedAt: now })
      .where(inArray(threadOrchestrationState.threadId, reapedThreadIds));
  }

  return { reaped: reaped.length };
}

export interface GcOrphanedProposedActionsResult {
  /** Completed (succeeded) runs' proposed rows recovered by re-seal: proposed → ready (Codex #3). */
  resealed: number;
  /** Proposed rows terminalized → blocked_policy (failed/cancelled producers + completed/null orphans). */
  reaped: number;
  /** Genuinely-crashed (zombie) running runs force-failed (#99 rule 3). */
  runsTerminalized: number;
}

/**
 * Garbage-collect UNSEALED `proposed` thread-agent-actions and drive each to a terminal state
 * (Decision #99 outbox completion, must-fix #5). The relay drains only sealed `ready` rows, so the
 * GC is the idempotent-retry RELAY for the producer seal. It enforces both invariants:
 *   - SAFETY:   never commit a failed run's action (terminalize them).
 *   - LIVENESS: never drop a SUCCEEDED run's action, never mistake a slow run for a crashed one,
 *               and never leave a row stuck in `proposed` forever.
 *
 * Four status-driven steps (run order matters — re-seal before terminalize):
 *   1. Zombie reaper — a `running` run past {@link ZOMBIE_RUN_TTL_MS} (≫ the longest legitimate
 *      run) that still has `proposed` rows has hard-crashed → force `failed` (#99 rule 3, guarded on
 *      still-`running`). A long-but-LIVE run is never touched (a false-crash would drop its actions).
 *   2. Re-seal (+ self-heal) — rows whose `idempotency_key` is in some COMPLETED (succeeded) run's
 *      durable `proposed_action_keys` for the same company → `ready`. Mirrors the in-band runner seal
 *      (by company+key-set). Recovers `proposed` rows (transient in-band seal failure / collided rows)
 *      AND `blocked_policy`/`run_not_sealed` rows a prior sweep terminalized — so a Step-1 false-reap of
 *      a long-but-LIVE run is NON-LOSSY once that run completes (its key-set un-blocks the rows here).
 *   3. Terminalize (failed) — remaining `proposed` rows whose run is `failed`/`cancelled` (incl. the
 *      zombies just failed in Step 1) → `blocked_policy` (`run_not_sealed`). Non-zombie `running`
 *      runs' rows are left alone (they may still seal in-band).
 *   4. Terminalize (orphan) — `proposed` rows past {@link STALE_COMMITTING_TTL_MS} whose producer is
 *      terminal-but-unrecoverable: `run_id IS NULL`, or a `completed` run that did NOT re-seal them in
 *      Step 2 (their key never reached the run's key-set — the propose-time append no-op'd / run was
 *      absent). Only ever touches null/`completed` producers, so it cannot false-crash a live run.
 *
 * Finally, threads whose rows Step 2 recovered to `ready` are re-armed (`pendingRun=true`) so the
 * ready-only relay actually drains them (runControllerSweep drives only pendingRun threads) — mirrors
 * the committing reaper. Wired into `runControllerSweep` on the 2-minute cadence, like the reaper.
 */
export async function gcOrphanedProposedActions(
  db: Db | DbLike,
  opts: { zombieRunMs?: number; now?: Date } = {},
): Promise<GcOrphanedProposedActionsResult> {
  const gcDb = db as unknown as DbLike;
  const zombieMs = opts.zombieRunMs ?? ZOMBIE_RUN_TTL_MS;
  const now = opts.now ?? new Date();
  const zombieCutoff = new Date(now.getTime() - zombieMs);

  // Step 1 (#99 rule 3): force-fail a genuinely-CRASHED running run BEFORE touching its rows. Crash =
  // `running` past the conservative zombie TTL with unsealed `proposed` rows — a long-but-LIVE run is
  // never reaped (no false-crash). Guarded on still-`running` so a run about to seal is never clobbered.
  const terminalized = (await gcDb
    .update(internalAgentRuns)
    .set({
      status: "failed",
      errorMessage: "reaped: running run past zombie TTL left unsealed thread actions",
      completedAt: now,
    })
    .where(
      and(
        eq(internalAgentRuns.status, "running"),
        lt(internalAgentRuns.createdAt, zombieCutoff),
        sql`${internalAgentRuns.id} IN (SELECT run_id FROM thread_agent_actions WHERE status = 'proposed' AND run_id IS NOT NULL)`,
      ),
    )
    .returning()) as unknown[];

  // Step 2 (the seal is RETRYABLE + self-healing): re-seal rows a COMPLETED (succeeded) run is entitled
  // to seal — whose idempotency_key is in some completed run's durable key-set (same company). Mirrors the
  // in-band runner seal (sealRunActions, by company+key-set). Recovers BOTH unsealed `proposed` rows
  // (transient in-band seal failure / collided rows) AND rows a prior sweep falsely terminalized to
  // `blocked_policy`/`run_not_sealed` — including the case where Step 1 reaped a >2h-but-still-LIVE run by
  // start-age and Step 3 blocked its rows: once that run actually completes, its key-set recovers them
  // here, so a false-reap is NON-LOSSY (only a ≤2-min recovery delay). Runs BEFORE Steps 3/4 so a
  // recoverable row becomes `ready` first; the terminalize passes only match `status='proposed'`.
  const resealed = (await gcDb
    .update(threadAgentActions)
    .set({ status: "ready" satisfies ThreadAgentActionStatus, blockedReason: null, updatedAt: now })
    .where(
      and(
        or(
          eq(threadAgentActions.status, "proposed"),
          and(
            eq(threadAgentActions.status, "blocked_policy"),
            eq(threadAgentActions.blockedReason, "run_not_sealed"),
          ),
        ),
        sql`${threadAgentActions.idempotencyKey} IN (
          SELECT jsonb_array_elements_text(r.proposed_action_keys)
          FROM internal_agent_runs r
          WHERE r.status = 'completed'
            AND jsonb_array_length(r.proposed_action_keys) > 0
            AND r.company_id = ${threadAgentActions.companyId}
        )`,
      ),
    )
    .returning()) as Array<{ threadId?: string }>;

  // Step 3: terminalize the remaining unsealed `proposed` rows whose run FAILED/cancelled (incl. the
  // zombies just failed in Step 1) and which no completed run re-sealed — these must never commit.
  const reaped = (await gcDb
    .update(threadAgentActions)
    .set({ status: "blocked_policy", blockedReason: "run_not_sealed", updatedAt: now })
    .where(
      and(
        eq(threadAgentActions.status, "proposed"),
        sql`${threadAgentActions.runId} IN (SELECT id FROM internal_agent_runs WHERE status IN ('failed','cancelled'))`,
      ),
    )
    .returning()) as unknown[];

  // Step 4: terminalize ORPHANED proposed rows past a modest age whose producer is terminal-but-
  // unrecoverable — null run_id (no producer), or a `completed` run that did NOT re-seal them in Step 2
  // (their key never reached the run's key-set). Restores the cleanup net the old age-based completed
  // branch gave, without re-introducing false-crashes (never touches a live `running` run).
  const orphanCutoff = new Date(now.getTime() - STALE_COMMITTING_TTL_MS);
  const orphaned = (await gcDb
    .update(threadAgentActions)
    .set({ status: "blocked_policy", blockedReason: "run_not_sealed", updatedAt: now })
    .where(
      and(
        eq(threadAgentActions.status, "proposed"),
        lt(threadAgentActions.updatedAt, orphanCutoff),
        sql`(${threadAgentActions.runId} IS NULL OR ${threadAgentActions.runId} IN (SELECT id FROM internal_agent_runs WHERE status = 'completed'))`,
      ),
    )
    .returning()) as unknown[];

  // Re-arm the controller for every thread whose actions Step 2 recovered to `ready` (Codex round-7):
  // runControllerSweep only drives threads with pendingRun=true, so without this a re-sealed row would
  // sit `ready` until unrelated future activity (the same gap the committing reaper closes above).
  // Placed AFTER the terminalize passes so a failure here can't abort them. Safe: only ever writes
  // pendingRun=true (the round-3/4 claim discriminator keys on pendingRun===false), it is conditional,
  // idempotent, and cannot clobber a concurrent human-entry pendingRun (triggerOnHumanEntry also =true).
  const resealedThreadIds = [
    ...new Set(resealed.map((r) => r.threadId).filter((id): id is string => typeof id === "string")),
  ];
  if (resealedThreadIds.length > 0) {
    await gcDb
      .update(threadOrchestrationState)
      .set({ pendingRun: true, updatedAt: now })
      .where(inArray(threadOrchestrationState.threadId, resealedThreadIds));
  }

  // Crash-window backstop (Codex round-8): a run that sealed its rows (→ready) IN-BAND then crashed
  // before its commit leaves them `ready` on a pendingRun=false thread — the sweep visits only pending
  // threads, and the re-arm above covers only rows THIS GC re-sealed. Re-arm any thread holding `ready`
  // rows older than the commit window (a normal in-band/controller commit drains within seconds; a
  // `ready` row past STALE_COMMITTING_TTL_MS is crash-stranded). Fresh rows the re-seal step just
  // produced (updated_at=now) are excluded by the cutoff, so this never fights the normal commit path.
  // Two-step (typed lt → inArray), mirroring the re-seal re-arm above — avoids a Date in a raw sql subquery.
  const readyCutoff = new Date(now.getTime() - STALE_COMMITTING_TTL_MS);
  const staleReady = (await gcDb
    .select({ threadId: threadAgentActions.threadId })
    .from(threadAgentActions)
    .where(and(eq(threadAgentActions.status, "ready"), lt(threadAgentActions.updatedAt, readyCutoff)))) as Array<{
    threadId?: string;
  }>;
  const staleReadyThreadIds = [
    ...new Set(staleReady.map((r) => r.threadId).filter((id): id is string => typeof id === "string")),
  ];
  if (staleReadyThreadIds.length > 0) {
    await gcDb
      .update(threadOrchestrationState)
      .set({ pendingRun: true, updatedAt: now })
      .where(
        and(
          eq(threadOrchestrationState.pendingRun, false),
          inArray(threadOrchestrationState.threadId, staleReadyThreadIds),
        ),
      );
  }

  return {
    resealed: resealed.length,
    reaped: reaped.length + orphaned.length,
    runsTerminalized: terminalized.length,
  };
}
