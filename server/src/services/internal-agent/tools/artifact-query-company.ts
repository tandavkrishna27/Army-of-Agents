// server/src/services/internal-agent/tools/artifact-query-company.ts
//
// Commander previously had no company-wide artifact query; this tool fills that gap.
// listing (query_artifacts is thread-scoped). category `query` confers no
// capability (see authorize-tool.ts CAPABILITY_TO_CATEGORY), matching the
// other read tools. Company scoping comes from ctx.companyId — never params.
import type { AgentTool, ToolResult } from "../types.js";
import { ARTIFACT_TYPES, ARTIFACT_STATUSES } from "@armyofagents/shared";

const VALID_TYPES = new Set<string>(ARTIFACT_TYPES);
const VALID_STATUSES = new Set<string>(ARTIFACT_STATUSES);

export const queryCompanyArtifactsTool: AgentTool = {
  name: "query_company_artifacts",
  description:
    "List the company's recent artifacts (deliverables) across all threads and tasks, newest first. Optional filters: type (document|presentation|code|design|report|other), status (draft|active|archived), limit (default 20, max 50). Use when asked what artifacts/documents/deliverables exist.",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", description: "Filter by artifact type" },
      status: { type: "string", description: "Filter by artifact status" },
      limit: { type: "number", description: "Max rows (default 20, max 50)" },
    },
    required: [],
  },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    const { type, status, limit } = (params ?? {}) as {
      type?: unknown;
      status?: unknown;
      limit?: unknown;
    };
    const typeFilter = typeof type === "string" && VALID_TYPES.has(type) ? type : null;
    const statusFilter = typeof status === "string" && VALID_STATUSES.has(status) ? status : null;
    const cap = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 50);

    const droppedFilters: string[] = [];
    if (typeof type === "string" && !typeFilter) droppedFilters.push(`type="${type.slice(0, 40)}"`);
    if (typeof status === "string" && !statusFilter) droppedFilters.push(`status="${status.slice(0, 40)}"`);

    const rows = await ctx.services.artifacts.list(ctx.companyId, {
      includeArchived: statusFilter === "archived",
    });
    const filtered = (Array.isArray(rows) ? rows : [])
      .filter((a: any) => (typeFilter ? a.type === typeFilter : true))
      .filter((a: any) => (statusFilter ? a.status === statusFilter : true));
    const list = filtered.slice(0, cap).map((a: any) => ({
      artifactId: a.id,
      title: a.title,
      type: a.type,
      currentVersionId: a.currentVersionId ?? null,
      status: a.status,
      updatedAt: a.updatedAt,
    }));

    const total = filtered.length;
    const summary =
      total > list.length
        ? `Showing ${list.length} of ${total} artifacts in the company (raise limit for more)`
        : `Found ${list.length} artifact${list.length === 1 ? "" : "s"} in the company`;

    const summaryWithNotes =
      droppedFilters.length > 0 ? `${summary} (ignored invalid filter ${droppedFilters.join(", ")})` : summary;

    return {
      success: true,
      data: list,
      summary: summaryWithNotes,
    };
  },
};
