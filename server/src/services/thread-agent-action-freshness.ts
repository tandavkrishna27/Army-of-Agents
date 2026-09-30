import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { discussionEntries, discussions, threadScopeVersions } from "@armyofagents/db";

type DbLike = {
  select: (...args: unknown[]) => QueryChain;
};

type QueryChain = PromiseLike<unknown[]> & {
  from: (table: unknown) => QueryChain;
  where: (...args: unknown[]) => QueryChain;
  orderBy: (...args: unknown[]) => QueryChain;
  limit: (...args: unknown[]) => QueryChain;
};

export type ThreadFreshnessSnapshot = {
  threadId: string;
  threadStatus: string;
  threadPhase: string;
  entrySeq: number;
  latestHumanEntryId: string | null;
  latestHumanSeq: number | null;
  latestScopeVersionId: string | null;
  latestScopeVersionNumber: number | null;
  latestScopeVersionStatus: string | null;
  latestScopeSourceEndSeq: number | null;
};

export type ThreadFreshnessComparison =
  | { fresh: true }
  | {
      fresh: false;
      reason:
        | "thread_missing"
        | "thread_done"
        // The snapshot captured at run start was empty/absent (capture threw, so
        // `runner.ts` stored `{}`). We cannot verify freshness against a baseline
        // we never recorded, so we suppress the action under THIS distinct
        // "could not verify" reason rather than letting an empty snapshot
        // masquerade as a `newer_human_entry` human-conflict (a FALSE reason).
        | "snapshot_unavailable"
        | "newer_human_entry"
        | "newer_scope_version"
        // The thread phase moved on since the action's snapshot. Only suppresses
        // PHASE_COUPLED_ACTIONS (advance_phase): applying a stale advance whose
        // FROM-phase no longer matches the live phase would regress/duplicate the
        // phase transition (a backward jump). See compareFreshnessSnapshot.
        | "phase_changed";
    };

export async function captureFreshnessSnapshot(
  db: DbLike,
  threadId: string,
): Promise<ThreadFreshnessSnapshot | null> {
  const [thread] = (await db
    .select({
      id: discussions.id,
      status: discussions.status,
      phase: discussions.phase,
      entrySeq: discussions.entrySeq,
    })
    .from(discussions)
    .where(eq(discussions.id, threadId))
    .limit(1)) as Array<{ id: string; status: string; phase: string; entrySeq: number }>;

  if (!thread) {
    // Background sweep: thread was torn down (e.g. test cleanup or company delete).
    // Return null so the caller can treat it as a no-op rather than an error.
    return null;
  }

  const [latestHuman] = (await db
    .select({
      id: discussionEntries.id,
      seq: discussionEntries.seq,
    })
    .from(discussionEntries)
    .where(
      and(
        eq(discussionEntries.discussionId, threadId),
        isNull(discussionEntries.authorAgentId),
        notInArray(discussionEntries.inputType, ["agent", "system", "scope_proposal"]),
      ),
    )
    .orderBy(desc(discussionEntries.seq))
    .limit(1)) as Array<{ id: string; seq: number }>;

  const [latestScope] = (await db
    .select({
      id: threadScopeVersions.id,
      versionNumber: threadScopeVersions.versionNumber,
      status: threadScopeVersions.status,
      sourceEndSeq: threadScopeVersions.sourceEndSeq,
    })
    .from(threadScopeVersions)
    .where(eq(threadScopeVersions.threadId, threadId))
    .orderBy(desc(threadScopeVersions.versionNumber), desc(threadScopeVersions.createdAt))
    .limit(1)) as Array<{ id: string; versionNumber: number; status: string; sourceEndSeq: number }>;

  return {
    threadId: thread.id,
    threadStatus: thread.status,
    threadPhase: thread.phase,
    entrySeq: thread.entrySeq,
    latestHumanEntryId: latestHuman?.id ?? null,
    latestHumanSeq: latestHuman?.seq ?? null,
    latestScopeVersionId: latestScope?.id ?? null,
    latestScopeVersionNumber: latestScope?.versionNumber ?? null,
    latestScopeVersionStatus: latestScope?.status ?? null,
    latestScopeSourceEndSeq: latestScope?.sourceEndSeq ?? null,
  };
}

/**
 * A stored snapshot is "unavailable" when freshness capture threw at run start
 * and `runner.ts` persisted an empty `{}` in its place. Detect it by the absence
 * of the always-present baseline fields — a real snapshot ALWAYS carries a string
 * `threadId` and a numeric `entrySeq` (see `captureFreshnessSnapshot`). Treating
 * an empty snapshot as a real baseline would coerce `latestHumanSeq` /
 * `latestScopeVersionNumber` to 0 and falsely report a `newer_human_entry` /
 * `newer_scope_version` conflict for any thread with ≥1 human entry or scope
 * version. Typed loosely because the runtime value may genuinely be `{}` even
 * though the static type says `ThreadFreshnessSnapshot`. Note: `null`
 * `latestScopeVersionId` / `latestHumanSeq` are LEGITIMATE values on a real
 * snapshot (no human entry / no scope version yet) and must NOT be treated as
 * unavailable — hence the baseline check keys off `threadId` + `entrySeq` only.
 */
function isSnapshotUnavailable(snapshot: ThreadFreshnessSnapshot | null | undefined): boolean {
  if (!snapshot || typeof snapshot !== "object") return true;
  const s = snapshot as Partial<ThreadFreshnessSnapshot>;
  return typeof s.threadId !== "string" && typeof s.entrySeq !== "number";
}

// Actions whose validity does NOT depend on the live scope version. A scope-version
// bump must NOT suppress these — their content is independent of the scope, so a
// concurrent/sibling scope change would otherwise terminally drop still-valid work.
// (Repro F1: a fresh post_reply was suppressed_stale as newer_scope_version and lost.)
const SCOPE_INDEPENDENT_ACTIONS: ReadonlySet<string> = new Set(["post_reply", "convene_agent"]);

// Actions whose validity depends on the PHASE they were proposed against. A phase
// change since the snapshot makes them stale: applying a stranded advance_phase whose
// FROM-phase has moved on regresses or duplicates the transition (a backward jump).
// (Repro F2.) Scoped so a phase change does NOT suppress a still-valid post_reply /
// scope action that merely shares the thread-scoped commit batch with an advance.
const PHASE_COUPLED_ACTIONS: ReadonlySet<string> = new Set(["advance_phase"]);

export async function compareFreshnessSnapshot(
  db: DbLike,
  threadId: string,
  snapshot: ThreadFreshnessSnapshot,
  actionType: string,
  // A-M7: the scope-version id THIS commit batch has already produced for the thread
  // (a sibling create_scope_draft / add_scope_item / create_artifact_candidate minted
  // it earlier in the same drain). The freshness snapshot is captured ONCE per run and
  // shared across all of a run's proposed actions, so it predates that sibling draft.
  // When the ONLY thing that advanced the live scope is this batch's own draft, the
  // scope-coupled action's commit will REUSE that draft (createDraftFromThread
  // early-returns the existing draft), so it is NOT genuinely stale and must not be
  // suppressed as `newer_scope_version`. A genuine cross-actor advance (live scope id
  // != this id) still suppresses. Optional + defaulted so other callers are unaffected.
  batchProducedScopeVersionId?: string | null,
): Promise<ThreadFreshnessComparison> {
  // An empty/absent baseline snapshot means freshness capture threw at run start
  // (runner.ts stores `{}` in that case). We have no recorded baseline to compare
  // against — so DO NOT silently drop the work as if a human spoke. A `{}`
  // snapshot has `latestHumanSeq === undefined`, which coerces to 0 below and
  // would falsely trip `newer_human_entry` for any thread with ≥1 human entry.
  // Report the distinct "could not verify" reason instead. The snapshot is
  // detected as empty when it carries neither of its always-present baseline
  // keys (`threadId` string + `entrySeq` number) — see isSnapshotUnavailable.
  if (isSnapshotUnavailable(snapshot)) {
    return { fresh: false, reason: "snapshot_unavailable" };
  }

  let current: ThreadFreshnessSnapshot;
  try {
    const snapshot = await captureFreshnessSnapshot(db, threadId);
    if (!snapshot) {
      return { fresh: false, reason: "thread_missing" };
    }
    current = snapshot;
  } catch {
    return { fresh: false, reason: "thread_missing" };
  }

  if (current.threadPhase === "done") {
    return { fresh: false, reason: "thread_done" };
  }

  if ((current.latestHumanSeq ?? 0) > (snapshot.latestHumanSeq ?? 0)) {
    return { fresh: false, reason: "newer_human_entry" };
  }

  // F2: a phase-coupled action (advance_phase) is stale when the live phase no longer
  // matches the phase it was proposed against. Without this guard, a stranded advance
  // drained by a later thread-scoped commit is applied even though the thread moved on —
  // and because canAdvancePhase permits backward jumps for agent actors, it regresses
  // the phase. Same-run advances still pass: at commit time the live phase is still the
  // pre-advance phase (the advance has not applied yet), so it equals the snapshot.
  if (PHASE_COUPLED_ACTIONS.has(actionType) && current.threadPhase !== snapshot.threadPhase) {
    return { fresh: false, reason: "phase_changed" };
  }

  // F1: newer_scope_version must not suppress scope-INDEPENDENT actions. A post_reply /
  // convene_agent does not depend on the live scope version, so a concurrent scope bump
  // between snapshot and commit must not terminally drop it. Scope-coupled actions
  // (add_scope_item, create_scope_draft, create_artifact_candidate) keep the check.
  //
  // A-M7: but a scope-coupled action must ALSO not be suppressed when the ONLY thing
  // that advanced the live scope is a draft THIS batch just produced — its commit will
  // reuse that same draft, so it is not stale. We detect that by the live scope id
  // matching `batchProducedScopeVersionId`; a genuine cross-actor advance (live id is
  // something else) still trips the check. The match short-circuits BOTH sub-conditions
  // (id change AND version-number bump), since a fresh draft advances both.
  const scopeAdvancedByThisBatchOnly =
    batchProducedScopeVersionId != null &&
    current.latestScopeVersionId === batchProducedScopeVersionId;
  if (
    !SCOPE_INDEPENDENT_ACTIONS.has(actionType) &&
    !scopeAdvancedByThisBatchOnly &&
    (current.latestScopeVersionId !== snapshot.latestScopeVersionId ||
      (current.latestScopeVersionNumber ?? 0) > (snapshot.latestScopeVersionNumber ?? 0))
  ) {
    return { fresh: false, reason: "newer_scope_version" };
  }

  return { fresh: true };
}
