// server/src/services/internal-agent/tools/thread-post-scope-proposal.ts
//
// Task C2 batch 1 — `thread.postScopeProposal` (action tool, D9 transactional).
//
// Posts a `scope_proposal` entry to a thread AND populates `thread_plan_steps`
// in ONE transaction. If either side fails, both roll back — we never leave
// the thread with an entry whose plan never materialized (or vice versa).
//
// Why a single tool instead of two: callers (Planner/Adjutant crews) should
// never see a partial state where the entry is visible but the Plan column
// is empty. The transaction is the only place this invariant can be enforced
// reliably.
//
// P1-T7 (A): The proposal's rawContent JSON now includes `proposalCursorSeq`
// — the thread's current `entrySeq` at the moment the proposal was posted.
// The Approve handler (thread-deliverables.ts) reads this back to detect
// whether newer entries arrived after the proposal was made (stale check).

import type { AgentTool } from "../types.js";
import { writeScopeProposal } from "../../scope-proposal-writer.js";

interface ProposedTaskInput {
  title: string;
  [key: string]: unknown;
}

interface ScopeProposalInput {
  summary: string;
  proposedTasks: ProposedTaskInput[];
  autoAdvanceAt?: string;
}

export const threadPostScopeProposalTool: AgentTool = {
  name: "thread.postScopeProposal",
  description:
    "Post a scope_proposal entry to a thread and populate thread_plan_steps (single transaction).",
  parameters: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The thread (discussion) ID" },
      proposal: {
        type: "object",
        description: "Scope proposal payload",
        properties: {
          summary: {
            type: "string",
            description: "Plain-text summary of the proposal",
          },
          proposedTasks: {
            type: "array",
            description: "Ordered list of proposed tasks (each has at least a title)",
            items: { type: "object" },
          },
          autoAdvanceAt: {
            type: "string",
            description:
              "ISO-8601 timestamp when this proposal should auto-advance if unchanged",
          },
        },
        required: ["summary", "proposedTasks"],
      },
    },
    required: ["threadId", "proposal"],
  },
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { threadId, proposal } = (params ?? {}) as {
      threadId?: string;
      proposal?: ScopeProposalInput;
    };
    if (!threadId || typeof threadId !== "string") {
      return {
        success: false,
        data: null,
        summary: "threadId is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!proposal || typeof proposal !== "object") {
      return {
        success: false,
        data: null,
        summary: "proposal is required",
        error: "INVALID_PARAMS",
      };
    }
    if (typeof proposal.summary !== "string" || proposal.summary.length === 0) {
      return {
        success: false,
        data: null,
        summary: "proposal.summary is required",
        error: "INVALID_PARAMS",
      };
    }
    if (!Array.isArray(proposal.proposedTasks)) {
      return {
        success: false,
        data: null,
        summary: "proposal.proposedTasks must be an array",
        error: "INVALID_PARAMS",
      };
    }

    // Delegate to the shared, companyId-validated writer (Task 2.1).
    // writeScopeProposal enforces D9 (entry + plan-steps in ONE transaction),
    // validates companyId before entering the transaction (Codex #14), and
    // converts the one-pending-per-thread unique violation to existing:true.
    try {
      const written = await writeScopeProposal(ctx.db, {
        threadId,
        companyId: ctx.companyId,
        proposal,
        agentId: ctx.agentId ?? null,
      });

      return {
        success: true,
        data: {
          entryId: written.entryId,
          proposalCursorSeq: written.proposalCursorSeq,
          existing: written.existing,
        },
        summary: written.existing
          ? `Scope proposal already pending (returned existing entry ${written.entryId})`
          : `Scope proposal posted with ${proposal.proposedTasks.length} step(s)`,
      };
    } catch (err: any) {
      return {
        success: false,
        data: null,
        summary: `Failed to post scope proposal: ${err?.message ?? "unknown error"}`,
        error: err?.message?.includes("COMPANY_MISMATCH")
          ? "COMPANY_MISMATCH"
          : "TRANSACTION_FAILED",
      };
    }
  },
};
