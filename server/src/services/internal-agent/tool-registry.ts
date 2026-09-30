import type { AgentTool, ToolContext, ToolResult } from "./types.js";
import {
  authorizeToolInvocation,
  resolveCommanderToolPolicy,
} from "./authorize-tool.js";
import { createQueryTools } from "./tools/query-tools.js";
import { createActionTools } from "./tools/action-tools.js";
import { createMemoryTools } from "./tools/memory-tools.js";
import { createDiscussionTools } from "./tools/discussion-tools.js";
import { createWorkflowTools } from "./tools/workflow-tools.js";
import { createFileTools } from "./tools/file-tools.js";
import { createCoordinationTools } from "./tools/coordination-tools.js";
import { createAnalysisTools } from "./tools/analysis-tools.js";
import { submitExtractedItemsTool } from "./tools/submit-extracted-items.js";
import { delegateToSubagentTool } from "./tools/delegate-to-subagent.js";
import { useSkillTool } from "./tools/skill-tools.js";
import { createThreadTools } from "./tools/thread-tools.js";
import { createPostEntryTool } from "./tools/post-entry-tool.js";
import { createAdvancePhaseTool } from "./tools/advance-phase-tool.js";
import { createNotifyOwnerTool } from "./tools/notify-owner-tool.js";
import { createArtifactTool } from "./tools/create-artifact-tool.js";
// Task C2 batch 1 — 7 thread + query tools (T15)
import { threadListEntriesTool } from "./tools/thread-list-entries.js";
import { threadSetIntentTool } from "./tools/thread-set-intent.js";
import { threadPostScopeProposalTool } from "./tools/thread-post-scope-proposal.js";
import { threadUpdateSummaryTool } from "./tools/thread-update-summary.js";
import { threadCreateLinkTool } from "./tools/thread-create-link.js";
import { getThreadSummaryTool } from "./tools/thread-get-summary.js";
import { findSimilarThreadsTool } from "./tools/thread-find-similar.js";
// Task C2 batch 2 — 5 navigator + artifact + workspace tools (T15)
import { attachToThreadTool } from "./tools/inbox-attach-to-thread.js";
import { spinOffThreadTool } from "./tools/thread-spin-off.js";
import { createArtifactVersionTool } from "./tools/artifact-create-version.js";
import { queryArtifactsTool } from "./tools/artifact-query.js";
import { queryCompanyArtifactsTool } from "./tools/artifact-query-company.js";
import { requestThreadWorkspaceTool } from "./tools/workspace-request-for-thread.js";
// Task C2 batch 3 — 7 memory tools (T15)
// Extraction wrappers (4) call into C1's named exports (extractMemoryCandidates
// + filtered helpers in server/src/services/extraction.ts). The HNSW search
// tool uses direct pgvector (mirrors find_similar_threads). propose_memory_from_thread
// + archive_stale_memory are new memory-management operations.
import { extractMemoryCandidatesTool } from "./tools/memory-extract-candidates.js";
import { extractDecisionsTool } from "./tools/memory-extract-decisions.js";
import { extractInsightsTool } from "./tools/memory-extract-insights.js";
import { extractReferencesTool } from "./tools/memory-extract-references.js";
import { findSimilarMemoryHnswTool } from "./tools/memory-find-similar.js";
import { proposeMemoryFromThreadTool } from "./tools/memory-propose.js";
import { archiveStaleMemoryTool } from "./tools/memory-archive-stale.js";
// Task 9 W3 — write_memory crew tool (write + RAG-index, status=pending, Critical Rule #6)
import { writeMemoryTool } from "./tools/memory-write.js";
// Task C2 batch 4 — agent.dispatch (T15)
// Lower-level sibling to delegate_to_subagent. Inserts wakeup rows with
// dedup + hop-count cap. Kept alongside delegate_to_subagent — they target
// different ergonomics (founder approval vs collaborative crew dispatch).
import { agentDispatchTool } from "./tools/agent-dispatch.js";
// Task 2.4 — propose_crew_work (Crew Work-as-Tasks chokepoint tool).
// Adjutant-only (ADJUTANT_TOOL_ALLOWLIST in ensure-adjutant.ts). Routes through
// crewTaskService.proposeWork — the unified D11 gate — using ctx.effectiveAutonomy.
import { proposeCrewWorkTool } from "./tools/propose-crew-work.js";
// Routing-card redesign — new Navigator tools
import { listThreadCardsTool } from "./tools/list-thread-cards.js";
import { promoteInboxToThreadTool } from "./tools/promote-inbox-to-thread.js";
import { deferInboxToHumanTool } from "./tools/defer-inbox-to-human.js";
// Spec B Task 2 — get_task (query category, company-scoped). Lets a crew agent
// read its assigned task's full context. `query` confers no capability, so it
// does NOT widen system_actions; getById has no company filter, so the tool
// enforces row.companyId === ctx.companyId itself (returns not-found on miss).
import { getTaskTool } from "./tools/get-task-tool.js";
// Spec B Task 3 — result-write tools. A crew agent writes its task result back:
// post_task_comment (comment authored by the agent) + attach_task_artifact
// (agent-sourced artifact linked to the task + recorded in task_outputs). BOTH
// are `coordination` category — coordination confers no capability (it is absent
// from authorize-tool.ts's CAPABILITY_TO_CATEGORY), so exposing these write tools
// never widens the calling agent's capability set. Each company-scopes the task
// itself (getById/addComment/update have no company filter).
import { postTaskCommentTool } from "./tools/post-task-comment-tool.js";
import { attachTaskArtifactTool } from "./tools/attach-task-artifact-tool.js";
// Spec B Task 4 — set_task_status. A crew agent moves its OWN task forward,
// dial-gated. Re-implements NO policy: delegates ownership + dial enforcement to
// the Task-1 A4 guard (assertAgentStatusTransition, invoked by issueService.update)
// by forwarding effectiveDial = ctx.effectiveAutonomy ?? 0 via the actor arg.
// `coordination` category — confers no capability, so it never widens the agent's
// capability set (like the other three Spec B task tools).
import { setTaskStatusTool } from "./tools/set-task-status-tool.js";
import {
  hubReadCurationContextTool,
  hubUpdateCurationSummaryTool,
} from "./tools/hub-curation-tools.js";
// Plan 3 Task 2 (B2) — Approval-family oversight port. 5 founder-only tools
// wrapping ctx.services.approvals / ctx.services.issueApprovals (Task 1).
// See approval-tools.ts header for the RBAC divergence rationale (no
// team_lead authorization project set on Commander's ToolContext — R2).
import { approvalTools } from "./tools/approval-tools.js";
// Plan 3 Task 3 (B2) — get_heartbeat_context port. Lets review-agent-output /
// daily-triage read a task's recent comments (the auto-run-summary comment
// posted after each heartbeat/crew run) without a dedicated run-history tool.
// Company-scoped in-tool (getById/listComments have no company filter).
import { getHeartbeatContextTool } from "./tools/heartbeat-context-tool.js";
import { askFounderCompatibilityTool, askHumanTool } from "./tools/ask-human-tool.js";

export function createToolRegistry(): AgentTool[] {
  return [
    ...createQueryTools(),
    ...createActionTools(),
    ...createMemoryTools(),
    ...createDiscussionTools(),
    submitExtractedItemsTool,
    ...createWorkflowTools(),
    ...createFileTools(),
    ...createCoordinationTools(),
    delegateToSubagentTool,
    ...createAnalysisTools(),
    useSkillTool,
    // P2 crew collaboration tools
    ...createThreadTools(),
    createPostEntryTool(),
    createAdvancePhaseTool(),
    createNotifyOwnerTool(),
    createArtifactTool(),
    // Task C2 batch 1 — 7 thread + query tools (T15)
    threadListEntriesTool,
    threadSetIntentTool,
    threadPostScopeProposalTool,
    threadUpdateSummaryTool,
    threadCreateLinkTool,
    getThreadSummaryTool,
    findSimilarThreadsTool,
    // Task C2 batch 2 — 5 navigator + artifact + workspace tools (T15).
    // attach_to_thread, spin_off_thread → Navigator (formerly Router)
    // allowlist (see ensure-command-staff.ts roleToolAllowlist['navigator']).
    // Phase D batch 1 (T6) closed the original TODO: create_artifact_version,
    // query_artifacts, request_thread_workspace are now on the Engineer
    // allowlist in ensure-engineer.ts. Planner also gets create_artifact_version
    // + query_artifacts for the plan-as-artifact flow, and Dispatcher gets
    // query_artifacts to read the plan before creating tasks.
    attachToThreadTool,
    spinOffThreadTool,
    listThreadCardsTool,        // NEW — card-fetch tool for Navigator (T6)
    promoteInboxToThreadTool,   // NEW — Navigator inbox→new-thread action (C1/T7)
    deferInboxToHumanTool,      // NEW — Navigator "unsure" finalization (Codex P1 #2)
    createArtifactVersionTool,
    queryArtifactsTool,
    queryCompanyArtifactsTool,
    requestThreadWorkspaceTool,
    // Task C2 batch 3 — 7 memory tools (T15)
    // Memory Keeper allowlist (ensure-command-staff.ts roleToolAllowlist['memory_keeper'])
    // is extended to cover all 7 of these. extract_memory_candidates is also
    // added to the Adjutant allowlist so it can extract mid-discussion when
    // checking phase readiness.
    extractMemoryCandidatesTool,
    extractDecisionsTool,
    extractInsightsTool,
    extractReferencesTool,
    findSimilarMemoryHnswTool,
    proposeMemoryFromThreadTool,
    archiveStaleMemoryTool,
    // Task 9 W3 — write_memory: unified write+RAG-index crew tool (status=pending,
    // Critical Rule #6 — agents cannot self-approve; founder approves identity/domain).
    writeMemoryTool,
    // Task C2 batch 4 — agent.dispatch (T15)
    // Coordination-category tool that queues a wakeup row for a target AoA
    // agent with hop-count cap + dedup. Added to the Adjutant allowlist so
    // it can hand off to another role mid-thread. delegate_to_subagent
    // remains as the founder-only, name-targeted, confirmation-gated
    // alternative — both serve distinct ergonomics.
    agentDispatchTool,
    // Task 2.4 — propose_crew_work (Crew Work-as-Tasks chokepoint tool).
    // Adjutant-only. Routes through crewTaskService.proposeWork (D11 gate).
    // Allowlisted ONLY in ensure-adjutant.ts — default-deny for all other
    // AoA roles and for Commander (not in commanderToolPermissions).
    proposeCrewWorkTool,
    // Spec B Task 2 — get_task. Query-category read tool: a crew agent reads
    // its assigned task's full context. Company-scoped inside the tool.
    getTaskTool,
    // Spec B Task 3 — post_task_comment + attach_task_artifact. Coordination-
    // category result-write tools (coordination confers no capability). Each
    // company-scopes the task itself.
    postTaskCommentTool,
    attachTaskArtifactTool,
    // Spec B Task 4 — set_task_status. Coordination-category own-task transition
    // tool (coordination confers no capability). Company-scopes the task itself
    // and delegates ownership + autonomy-dial enforcement to the A4 guard via
    // issueService.update's actor.effectiveDial.
    setTaskStatusTool,
    // W4 Steward â€” bounded display-only hub curation metadata write. This
    // never performs lifecycle/source actions and is allowlisted only for Steward.
    hubReadCurationContextTool,
    hubUpdateCurationSummaryTool,
    // Plan 3 Task 2 (B2) — Approval-family oversight port (founder-only R1).
    ...approvalTools,
    // Plan 3 Task 3 (B2) — get_heartbeat_context: task + 10 recent comments
    // (query category, team_member role, company-scoped in-tool).
    getHeartbeatContextTool,
    askHumanTool,
    askFounderCompatibilityTool,
  ];
}

export function filterAuthorizedToolsForContext(
  tools: AgentTool[],
  ctx: Pick<
    ToolContext,
    | "userRole"
    | "enabledCapabilities"
    | "agentKind"
    | "toolAllowlist"
    | "actorType"
    | "commanderToolPermissions"
    | "runtimeApprovalsEnabled"
  >,
): AgentTool[] {
  return tools.filter((tool) => {
    if (ctx.actorType === "commander") {
      return resolveCommanderToolPolicy(tool, ctx).allowed;
    }

    return authorizeToolInvocation(
      tool,
      ctx.userRole,
      ctx.enabledCapabilities,
      { agentKind: ctx.agentKind, toolAllowlist: ctx.toolAllowlist },
    ).allowed;
  });
}

const CORE_TOOLS = new Set(["query_tasks", "query_memory", "query_goals", "use_skill", "query_company"]);

const INTENT_KEYWORDS: Record<string, string[]> = {
  query: ["team", "org", "organization", "hierarchy", "reports to", "roster", "humans", "people", "agents"],
  action: ["create", "add", "new", "make", "assign", "wake", "wakeup", "trigger"],
  memory: ["memory", "remember", "knowledge", "recall", "forget"],
  workflow: ["workflow", "pipeline", "template", "step", "process"],
  discussion: ["discussion", "debrief", "extract", "conversation", "transcript"],
  analysis: ["workload", "suggest", "improve", "analyze", "balance", "optimize"],
  coordination: ["dependency", "dependencies", "blocking", "blocked", "depends", "chain"],
  file: ["artifact", "file", "document", "version", "read_file"],
};

const MAX_TOOLS = 15;

export function getToolsForMessage(message: string, allTools: AgentTool[]): AgentTool[] {
  const lower = message.toLowerCase();
  const selected = new Set<string>();

  for (const name of CORE_TOOLS) {
    selected.add(name);
  }

  const matchedCategories = new Set<string>();
  for (const [category, keywords] of Object.entries(INTENT_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) {
      matchedCategories.add(category);
    }
  }

  for (const tool of allTools) {
    if (matchedCategories.has(tool.category)) {
      selected.add(tool.name);
    }
  }

  if (matchedCategories.size === 0) {
    for (const tool of allTools) {
      if (tool.category === "query") {
        selected.add(tool.name);
      }
    }
  }

  const result: AgentTool[] = [];
  for (const tool of allTools) {
    if (selected.has(tool.name) && result.length < MAX_TOOLS) {
      result.push(tool);
    }
  }
  return result;
}

export function toolToAnthropicFormat(tool: AgentTool) {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

export function toolToOpenAIFormat(tool: AgentTool) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

export async function executeTool(
  tool: AgentTool,
  params: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  if (ctx.actorType === "commander") {
    const commanderPolicy = resolveCommanderToolPolicy(tool, ctx);
    if (!commanderPolicy.allowed) {
      return {
        success: false,
        data: null,
        summary: commanderPolicy.summary,
        error: commanderPolicy.error,
      };
    }
  }

  // Role + capability gate (closes C13) + D2 AoA tool allowlist gate
  const decision = authorizeToolInvocation(
    tool,
    ctx.userRole,
    ctx.enabledCapabilities,
    { agentKind: ctx.agentKind, toolAllowlist: ctx.toolAllowlist },
  );
  if (!decision.allowed) {
    return {
      success: false,
      data: null,
      summary: decision.summary,
      error: decision.error,
    };
  }

  try {
    return await tool.execute(params, ctx);
  } catch (error: any) {
    if (error?.status === 403) {
      return {
        success: false,
        data: null,
        summary: `Permission denied: ${error.message}`,
        error: "FORBIDDEN",
      };
    }
    return {
      success: false,
      data: null,
      summary: error?.message ?? "Unknown error",
      error: "INTERNAL",
    };
  }
}
