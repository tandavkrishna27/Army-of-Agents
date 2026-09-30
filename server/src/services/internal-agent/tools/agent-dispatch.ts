// server/src/services/internal-agent/tools/agent-dispatch.ts
//
// Task C2 batch 4 (T15) — `agent.dispatch` (coordination tool).
//
// Inserts a row into `agent_wakeup_requests` to dispatch another AoA agent.
// Does NOT directly invoke heartbeat — it queues a wakeup that the dispatcher's
// drain loop picks up. The lower-level sibling to `delegate_to_subagent`:
//   - delegate_to_subagent: targets by name, founder-only, requires confirmation,
//     instruction string in payload.
//   - agent.dispatch (this tool): targets by UUID, team_member, no confirmation,
//     dedup-aware via `${agentId}:${threadId}:queued`. Designed for the new
//     thread-pipeline dispatch path where collaboration is normal — not every
//     hop is a high-stakes founder action.
//
// Hop-count cap (MAX_HOP_COUNT=3) mirrors thread-events.ts so any
// agent-to-agent cascade — whether sourced from a @mention or an explicit
// `agent.dispatch` call — is bounded by the same ceiling. Three hops = the
// agent that received a dispatch can itself dispatch one more, but no further.
// Humans always reset hopCount to 0; only agent→agent edges count toward the
// cap.

import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, discussions, issues } from "@armyofagents/db";
import type { AgentTool } from "../types.js";
import { buildConveneAgentIdempotencyKey } from "./thread-action-keys.js";

/** Matches thread-events.ts MAX_HOP_COUNT. Keep in sync. */
const MAX_HOP_COUNT = 3;

// SECURITY (Layer A — sanitize at the source). The caller FULLY controls the
// `context` object, and its keys are written verbatim into the wakeup payload
// (direct insert) or the queued thread action's `context` (controller-action-
// gate). The dispatcher later spreads that payload into `runAoaAgent`, so any
// trust/scope key riding inside `context` — most dangerously `companyId` —
// would override the trusted, server-set run company and let a company-A agent
// operate in company B (cross-tenant escalation). Build the forwarded context
// from an ALLOWLIST of the content-reference keys this tool legitimately
// carries; every other key (companyId, source, effectiveAutonomy, wakeupId,
// resolvedModel, continuation keys, userId, agentId, …) is DROPPED. Allowlist
// (not a denylist) so the next trust key someone adds is dropped by default.
//
// The allowlisted set mirrors what the parallel @mention dispatch path enqueues
// (thread-events.ts: threadId, mentionEntryId, hopCount) plus the task/entry
// reference keys the crew runner + trigger prompt read downstream. threadId and
// issueId are additionally ownership-validated below before they can enter the
// payload. hopCount is auto-managed (always overwritten with incomingHopCount+1)
// and is therefore never taken from the caller.
const FORWARDABLE_CONTEXT_KEYS = [
  "threadId",
  "issueId",
  "entryId",
  "mentionEntryId",
  "parentEntryId",
] as const;

/**
 * Build the wakeup/thread-action payload from ONLY the allowlisted content keys
 * of the caller-supplied context, then stamp the server-managed hopCount. A
 * `companyId` (or any other non-allowlisted key) in `context` is dropped and can
 * never reach the runner's trigger payload.
 */
function buildForwardedContext(
  context: Record<string, unknown> | undefined,
  hopCount: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (context) {
    for (const key of FORWARDABLE_CONTEXT_KEYS) {
      if (context[key] !== undefined) out[key] = context[key];
    }
  }
  out.hopCount = hopCount;
  return out;
}

export const agentDispatchTool: AgentTool = {
  name: "agent.dispatch",
  description:
    "Dispatch another AoA agent by inserting a wakeup row. Does NOT call heartbeat directly — the dispatcher's drain loop picks it up. Respects hop-count cap (max 3) and dedupes within a single thread context.",
  parameters: {
    type: "object",
    properties: {
      agentId: { type: "string", description: "Target agent UUID" },
      context: {
        type: "object",
        description:
          "Optional context payload (threadId, mentionEntryId, etc.). hopCount is auto-managed.",
      },
      reason: {
        type: "string",
        description:
          "Human-readable dispatch reason (default 'agent_dispatch')",
      },
    },
    required: ["agentId"],
  },
  category: "coordination",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { agentId, context, reason } = (params ?? {}) as {
      agentId?: string;
      context?: Record<string, unknown>;
      reason?: string;
    };

    if (!agentId || typeof agentId !== "string") {
      return {
        success: false,
        data: null,
        summary: "agentId is required",
        error: "INVALID_PARAMS",
      };
    }

    // Read incoming hopCount from the caller's context, defaulting to 0 when
    // missing (treated as human-originated). The stored row will carry
    // incomingHopCount+1 to record the new edge.
    const incomingHopCount =
      typeof context?.hopCount === "number" ? context.hopCount : 0;
    if (incomingHopCount >= MAX_HOP_COUNT) {
      return {
        success: false,
        data: null,
        summary: `Hop count limit reached (max ${MAX_HOP_COUNT})`,
        error: "HOP_LIMIT_EXCEEDED",
      };
    }

    // Resolve the target agent — required to enforce the cross-company guard
    // and to confirm the agent exists before queuing a wakeup row.
    const threadId = (context?.threadId as string | undefined) ?? null;
    const issueId = (context?.issueId as string | undefined) ?? null;

    // SECURITY — cross-tenant guard at the SOURCE (root cause). The caller
    // controls `context`, and any entity ids inside it are written verbatim
    // into the wakeup payload (or the queued thread action) and later consumed
    // by the dispatcher's thread-flag gate, the task-claim path, and the crew
    // context builders. Validate that a caller-supplied threadId / issueId
    // resolves WITHIN the caller's own company BEFORE it can enter the payload,
    // so a foreign id can never be enqueued. Mirrors the "Cross-company
    // dispatch forbidden" guard applied to the target agent below.
    if (threadId) {
      const [thread] = await ctx.db
        .select({ id: discussions.id })
        .from(discussions)
        .where(and(eq(discussions.id, threadId), eq(discussions.companyId, ctx.companyId)))
        .limit(1);
      if (!thread) {
        return {
          success: false,
          data: null,
          summary: "Cross-company dispatch forbidden: threadId does not belong to your company",
          error: "CROSS_COMPANY_FORBIDDEN",
        };
      }
    }
    if (issueId) {
      const [issue] = await ctx.db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, ctx.companyId)))
        .limit(1);
      if (!issue) {
        return {
          success: false,
          data: null,
          summary: "Cross-company dispatch forbidden: issueId does not belong to your company",
          error: "CROSS_COMPANY_FORBIDDEN",
        };
      }
    }

    if (ctx.discussionRunMode === "controller_action_gate") {
      if (!ctx.runId) {
        return {
          success: false,
          data: null,
          summary: "Cannot queue agent dispatch without a run id",
          error: "MISSING_RUN_ID",
        };
      }
      if (!threadId) {
        return {
          success: false,
          data: null,
          summary: "threadId is required in action-gated discussion dispatch context",
          error: "INVALID_PARAMS",
        };
      }

      const { threadAgentActionService } = await import("../../thread-agent-actions.js");
      const action = await threadAgentActionService(ctx.db).proposeThreadAction({
        companyId: ctx.companyId,
        threadId,
        runId: ctx.runId,
        agentId: ctx.agentId ?? null,
        actionType: "convene_agent",
        payload: {
          targetAgentId: agentId,
          reason: reason ?? "agent_dispatch",
          // Layer A: allowlist-sanitized — a caller-supplied companyId (or any
          // other trust/scope key) never enters the queued action's context.
          context: buildForwardedContext(context, incomingHopCount + 1),
        },
        // hopCount is intentionally NOT folded into the key: the payload's
        // incomingHopCount+1 can differ across re-proposes, so including it would
        // split the key across runs. Leaving it out returns the existing wakeup
        // row as-is and hops are not re-incremented.
        idempotencyKey: buildConveneAgentIdempotencyKey({
          threadId,
          agentId: ctx.agentId,
          targetAgentId: agentId,
          reason: reason ?? "agent_dispatch",
          // Turn anchor: latest human entry seq at run start (null → content-only). #198.
          turnAnchor:
            ctx.threadFreshness?.latestHumanSeq != null
              ? String(ctx.threadFreshness.latestHumanSeq)
              : null,
        }),
        freshness: ctx.threadFreshness ?? {},
      }) as { id?: string };

      return {
        success: true,
        data: { actionId: action.id, queued: true, hopCount: incomingHopCount + 1 },
        summary: "Queued agent dispatch for freshness-checked commit",
      };
    }

    const [agent] = await ctx.db
      .select({
        id: agents.id,
        companyId: agents.companyId,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) {
      return {
        success: false,
        data: null,
        summary: "Target agent not found",
        error: "AGENT_NOT_FOUND",
      };
    }

    if (agent.companyId !== ctx.companyId) {
      return {
        success: false,
        data: null,
        summary: "Cross-company dispatch forbidden",
        error: "CROSS_COMPANY_FORBIDDEN",
      };
    }

    // dedupKey shape must match thread-events.ts so the same partial unique
    // index (`agent_wakeup_requests_dedup_key_queued_uq` from A4) handles both
    // @mention dispatches and explicit agent.dispatch calls. Format:
    //   `${agentId}:${threadId}:queued`
    // When threadId is absent we deliberately leave dedupKey NULL so the
    // partial unique index doesn't fire — a dispatch with no thread context
    // is treated as a one-off rather than a recurring stream.
    const dedupKey = threadId ? `${agentId}:${threadId}:queued` : null;

    const inserted = await ctx.db
      .insert(agentWakeupRequests)
      .values({
        companyId: ctx.companyId,
        agentId,
        source: "agent.dispatch",
        reason: reason ?? "agent_dispatch",
        // Layer A: allowlist-sanitized — a caller-supplied companyId (or any
        // other trust/scope key) never enters the wakeup payload, so the
        // dispatcher's spread can't redirect the run into another tenant.
        payload: buildForwardedContext(context, incomingHopCount + 1) as Record<string, unknown>,
        dedupKey,
        status: "queued",
      })
      .onConflictDoNothing()
      .returning({ id: agentWakeupRequests.id });

    const wakeupId = inserted[0]?.id ?? null;

    return {
      success: true,
      data: { wakeupId, hopCount: incomingHopCount + 1 },
      summary: wakeupId ? "Dispatched" : "Already queued (dedupKey conflict)",
    };
  },
};
