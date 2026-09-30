/**
 * Production ParticipantRunner for the orchestration controller (Phase 2 / Task 2.1).
 *
 * `makeThreadParticipationRunner(db)` returns a `ParticipantRunner` that pulls
 * ANY crew agent (Scout, Engineer, Planner, …) into a thread conversation. It
 * generalizes `controller-adjutant-runner.ts` — that factory is hard-wired to
 * the Adjutant; this one is parameterized by the `agentId` the caller passes.
 *
 * It:
 *   1. Resolves the thread's company + thread-level autonomy from `discussions`.
 *   2. Resolves the company-level autonomy fallback from `internal_agent_config`,
 *      then `effectiveAutonomy = thread.autonomyLevel ?? companyLevel` (mirrors
 *      the dispatcher D10 block + controller-adjutant-runner).
 *   3. Resolves the crew role for the agent via `resolveCrewRole` (the SAME path
 *      the dispatcher uses) so the trigger prompt is role-aware (`Routed role:`).
 *   4. Invokes `runAoaAgent(db, agentId, { companyId, source:"thread.participation",
 *      threadId, mention: prompt, effectiveAutonomy, role })`.
 *
 * ### Why it returns "" (the keystone of B1)
 * A crew agent SELF-POSTS its reply via the `post_entry` MCP tool DURING its run
 * (its trigger directive). `runAoaAgent` returns an `AoaRunResult = { status, … }`
 * with NO reply text. If this runner returned that result's text (there is none)
 * or wrapped a synthesized string, `requestParticipation` would post a SECOND
 * entry — a double-post (a real one if we returned text, an empty stray entry if
 * we returned the AoaRunResult shape coerced to string).
 *
 * So this runner returns `""` and `requestParticipation` SKIPS its own entry-
 * insert on an empty/whitespace return — the agent is the sole author of its
 * reply. This mirrors `controller-adjutant-runner.ts`, which returns only
 * `{ status }` and lets the Adjutant self-post via MCP.
 *
 * `deps.runAgent` / `deps.resolveRole` are injectable for tests (no CLI spawn,
 * no aoaAgentTriggers read).
 */

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  discussionEntries,
  discussions,
  internalAgentConfig,
  threadAgentActions,
} from "@armyofagents/db";
// `runner.ts` eagerly builds the full crew tool-registry at module load
// (embeddings, ~40 tool modules). thread-orchestration.ts wires THIS factory as
// its default participantRunner, and discussions.ts imports thread-orchestration
// — so a static `import { runAoaAgent }` would drag that heavy subtree onto the
// discussions module-load path. Import only the TYPES statically (erased by tsc,
// zero runtime cost) and defer the value to call time via dynamic import.
// Same lazy-import discipline as controller-adjutant-runner.ts (Review I1).
import type { AoaTriggerPayload } from "./runner.js";
import type { AoaRunResult } from "./aoa-run-result.js";
import type { CrewRole } from "./autonomy.js";
import { resolveCrewRole } from "./resolve-crew-role.js";
import type { ParticipantRunner } from "../../thread-orchestration.js";
import { logger } from "../../../middleware/logger.js";
import { mapRunFailureToFriendlyReason } from "./thread-participation-failure.js";
import { redactSecretsInString } from "../../../redaction.js";

const log = logger.child({ svc: "thread-participation-runner" });

/** Shape of `runAoaAgent` — declared from its types so the value stays lazily imported. */
type RunAoaAgentFn = (
  db: Db,
  agentId: string,
  payload: AoaTriggerPayload,
) => Promise<AoaRunResult>;

/**
 * Factory returning a production ParticipantRunner. Wired as the default
 * `participantRunner` for `requestParticipation` in thread-orchestration.ts.
 *
 * @param db - Drizzle db instance.
 * @param deps - Dependency injection for tests. Pass `{ runAgent }` to avoid
 *               spawning a real CLI process (also bypasses the dynamic import),
 *               and/or `{ resolveRole }` to control the resolved crew role.
 */
export function makeThreadParticipationRunner(
  db: Db,
  deps: {
    runAgent?: RunAoaAgentFn;
    resolveRole?: (db: Db, agentId: string) => Promise<CrewRole | null>;
  } = {},
): ParticipantRunner {
  return async ({ threadId, agentId, prompt }) => {
    // Step 1: resolve the thread's company + thread-level autonomy.
    const [thread] = await db
      .select({ companyId: discussions.companyId, autonomyLevel: discussions.autonomyLevel })
      .from(discussions)
      .where(eq(discussions.id, threadId))
      .limit(1);

    if (!thread) {
      // Throw (not a silent return) — the caller (requestParticipation) has
      // already incremented the hop for this round; surfacing the error lets the
      // run boundary record it rather than masking a missing thread as success.
      log.warn({ threadId, agentId }, "participation runner: thread not found");
      throw new Error(`thread not found: ${threadId}`);
    }

    // Step 2: resolve effectiveAutonomy = thread.autonomyLevel ?? companyLevel.
    // Mirrors dispatcher.ts D10 block + controller-adjutant-runner: company
    // config is the fallback; the thread-level override wins when set. Forwarded
    // to runAoaAgent → the MCP bridge for tool-level gating.
    const [companyCfg] = await db
      // D18: crew thread participation reads the agent-work dial.
      .select({ autonomyLevel: internalAgentConfig.crewAutonomyLevel })
      .from(internalAgentConfig)
      .where(eq(internalAgentConfig.companyId, thread.companyId))
      .limit(1);
    const companyAutonomyLevel: number = companyCfg?.autonomyLevel ?? 0;
    const effectiveAutonomy: number =
      thread.autonomyLevel != null ? thread.autonomyLevel : companyAutonomyLevel;

    // Step 3: resolve the crew role (same path the dispatcher uses) so the
    // trigger prompt renders a role-aware "Routed role:" line + the role-specific
    // action directive. Null role (unknown agent) → omit the field so the prompt
    // builder's `typeof payload.role === "string"` check skips it cleanly.
    const resolveRole = deps.resolveRole ?? resolveCrewRole;
    const role = await resolveRole(db, agentId);
    const beforeAgentEntryCount = await countAgentThreadEntries(db, threadId, agentId);

    // Step 4: run the agent. wakeupId/entryId are intentionally omitted — the
    // controller participation path has no agentWakeupRequests row, and the
    // mention text is the trigger context (carried as `mention`). runAoaAgent
    // treats threadId/mention/role/effectiveAutonomy as payload extras
    // ([k: string]: unknown) and renders them in the trigger prompt.
    //
    // Resolve runAoaAgent lazily (see import note above): tests inject
    // deps.runAgent and never hit the dynamic import; production loads runner.ts
    // here, off the discussions module-load path.
    const runAgent = deps.runAgent ?? (await import("./runner.js")).runAoaAgent;
    const result = await runAgent(db, agentId, {
      companyId: thread.companyId,
      source: "thread.participation",
      threadId,
      mention: prompt,
      effectiveAutonomy,
      ...(role ? { role } : {}),
    });

    if (result.status === "succeeded") {
      const afterAgentEntryCount = await countAgentThreadEntries(db, threadId, agentId);
      if (afterAgentEntryCount <= beforeAgentEntryCount) {
        // No NEW agent entry landed. In controller_action_gate mode that is NOT
        // automatically a failure: the agent posts via a queued post_reply action
        // that runAoaAgent commits — or suppresses as stale — in its own pass.
        // Review fix (g): inspect the run's post_reply action(s) before deciding.
        //   - suppressed-stale  → benign (a newer human entry arrived; the reply
        //     was correctly discarded). Return info, do NOT throw.
        //   - produced (other)  → the agent DID act; the entry just isn't visible
        //     to this count (committed concurrently / non-entry outcome). Benign.
        //   - none produced     → the agent genuinely posted nothing → throw.
        const post = result.runId
          ? await inspectRunPostReply(db, result.runId)
          : { produced: false, suppressedStale: false, statuses: [] as string[], blockedReasons: [] as string[] };

        if (post.produced) {
          // Live-QA 2026-07-16: a `failed` post_reply row is retryable by the
          // commit CAS (status IN ('proposed','failed')), while `blocked_policy`
          // is TERMINAL — say which one, so an operator doesn't wait on a retry
          // that will never come. We still return benignly either way, but the
          // outcome is NOT silent.
          const hasRetryableFailure = post.statuses.includes("failed");
          const hasTerminalBlock = post.statuses.includes("blocked_policy");
          const hasFailedRow = hasRetryableFailure || hasTerminalBlock;
          const logPayload = {
            threadId,
            agentId,
            role,
            effectiveAutonomy,
            beforeAgentEntryCount,
            afterAgentEntryCount,
            suppressedStale: post.suppressedStale,
            postReplyStatuses: post.statuses,
            postReplyBlockedReasons: post.blockedReasons,
          };
          if (hasFailedRow) {
            log.warn(
              logPayload,
              hasTerminalBlock && !hasRetryableFailure
                ? "participation runner: post_reply commit BLOCKED (terminal — will not retry); investigate blocked reasons"
                : "participation runner: post_reply produced but its commit FAILED — row stays retryable; investigate blocked reasons",
            );
          } else {
            log.info(
              logPayload,
              post.suppressedStale
                ? "participation runner: post_reply suppressed as stale — benign, no agent entry expected"
                : "participation runner: post_reply produced but no new entry counted — treating as benign",
            );
          }
          return "";
        }

        log.error(
          { threadId, agentId, role, effectiveAutonomy, beforeAgentEntryCount, afterAgentEntryCount },
          "participation runner: run succeeded but agent did not post to the thread",
        );
        throw new Error(
          `thread participation run completed without an agent-authored post_entry for thread ${threadId}`,
        );
      }
    }

    // Unit E (Phase 1): surface failed runs instead of silently swallowing them
    // under the misleading "agent self-posted via MCP" debug label.
    //
    // A result.status === "failed" run never self-posted — the agent did not
    // complete. We log at error level with a friendly, secret-redacted reason so
    // operators can diagnose the failure. We still return "" to preserve the B1
    // no-double-post contract: requestParticipation skips its own entry-insert on
    // an empty return, which is correct here — we do NOT want to inject an error
    // message as an agent-authored entry (that would misattribute the error text
    // to the agent).
    //
    // A system-entry insertion path (posting a clearly-marked notice entry on
    // behalf of the system rather than the agent) is not available in this runner
    // without injecting a new dep (an entry-insert function). That enhancement is
    // tracked for a later unit — the minimum correct behaviour is error-level
    // logging with redacted details (no longer silently swallowed/mislabeled).
    if (result.status !== "succeeded") {
      const friendlyReason = mapRunFailureToFriendlyReason(result.errorMessage);
      // Two distinct redaction calls, two distinct inputs — not redundant:
      // this one redacts the raw errorMessage for the `rawError` log field;
      // mapRunFailureToFriendlyReason internally redacts its own static friendly
      // text (defensive future-proofing). Each call guards a different string.
      const redactedRaw = result.errorMessage
        ? redactSecretsInString(result.errorMessage)
        : "(no error message)";
      log.error(
        {
          threadId,
          agentId,
          role,
          effectiveAutonomy,
          status: result.status,
          reason: friendlyReason,
          rawError: redactedRaw,
        },
        "participation runner: agent run failed — not a self-post",
      );
      return "";
    }

    log.debug(
      { threadId, agentId, role, effectiveAutonomy, status: result.status },
      "participation runner: runAoaAgent returned — agent self-posted via MCP; returning empty",
    );

    // The agent posted its own reply via post_entry DURING the run. Return ""
    // so requestParticipation SKIPS its entry-insert (no double-post).
    return "";
  };
}

async function countAgentThreadEntries(db: Db, threadId: string, agentId: string): Promise<number> {
  // Review fix (g): use a COUNT(*) aggregate, not a row LIMIT. The previous
  // `.limit(1000)` + `rows.length` silently capped the count at 1000 — on a busy
  // thread with ≥1000 agent entries the before/after comparison would read equal
  // and the post-detection guard below would wrongly fire.
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(discussionEntries)
    .where(
      and(
        eq(discussionEntries.discussionId, threadId),
        eq(discussionEntries.authorAgentId, agentId),
      ),
    );

  return Number(row?.count ?? 0);
}

/**
 * Review fix (g): distinguish "the agent produced no post action at all" from
 * "the agent's post_reply was correctly suppressed as stale". The participation
 * runner runs in `controller_action_gate` mode, where the agent does NOT insert
 * a discussion entry directly — it queues a `post_reply` thread-agent-action that
 * is committed (or suppressed-stale) inside runAoaAgent's own commit pass. So an
 * unchanged entry count is NOT proof the agent did nothing: a benign stale
 * suppression also leaves the count unchanged.
 *
 * Returns:
 *   - `produced: false` when no post_reply action exists for this run → the agent
 *     genuinely posted nothing (legitimate guard failure → throw).
 *   - `produced: true, suppressedStale: true` when the post_reply was suppressed
 *     as stale (a benign, expected outcome → info return, no throw).
 *   - `produced: true, suppressedStale: false` for any other produced action.
 */
async function inspectRunPostReply(
  db: Db,
  runId: string,
): Promise<{ produced: boolean; suppressedStale: boolean; statuses: string[]; blockedReasons: string[] }> {
  const rows = await db
    .select({
      status: threadAgentActions.status,
      blockedReason: threadAgentActions.blockedReason,
    })
    .from(threadAgentActions)
    .where(
      and(
        eq(threadAgentActions.runId, runId),
        eq(threadAgentActions.actionType, "post_reply"),
      ),
    );
  if (rows.length === 0) {
    return { produced: false, suppressedStale: false, statuses: [], blockedReasons: [] };
  }
  const suppressedStale = rows.every((r) => r.status === "suppressed_stale");
  return {
    produced: true,
    suppressedStale,
    statuses: rows.map((r) => String(r.status)),
    blockedReasons: rows.map((r) => r.blockedReason).filter((r): r is string => Boolean(r)),
  };
}
