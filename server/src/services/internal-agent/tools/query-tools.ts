import type { AgentTool } from "../types.js";
import type { HumanContextBundle, HumanContextResolutionResult, UnifiedOrgNode } from "@armyofagents/shared";
import { searchHumansSchema } from "@armyofagents/shared";

type TeamRosterKind = "human" | "agent";

interface TeamRosterParent {
  id: string;
  kind: TeamRosterKind;
  name: string;
}

interface TeamRosterEntry {
  id: string;
  kind: TeamRosterKind;
  name: string;
  role: string;
  title: string | null;
  status: string;
  email?: string | null;
  userRole?: "founder" | "team_lead" | "team_member";
  departmentName?: string | null;
  adapterType?: string | null;
  parent: TeamRosterParent | null;
  childCount: number;
  depth: number;
  path: string[];
}

function humanContextDisplay(bundle: HumanContextBundle) {
  return bundle.identity.displayName ?? bundle.identity.email ?? bundle.userId;
}

function nodeKind(nodeType: "agent" | "user"): TeamRosterKind {
  return nodeType === "user" ? "human" : "agent";
}

function flattenTeamTree(
  nodes: UnifiedOrgNode[],
  parent: TeamRosterParent | null = null,
  depth = 0,
  path: string[] = [],
): TeamRosterEntry[] {
  const entries: TeamRosterEntry[] = [];
  for (const node of nodes) {
    const name = node.name.trim() ? node.name : node.id;
    const kind = nodeKind(node.nodeType);
    const nextPath = [...path, name];
    const children = Array.isArray(node.children) ? node.children : [];
    const entry: TeamRosterEntry = {
      id: node.id,
      kind,
      name,
      role: node.role,
      title: null,
      status: node.status,
      parent,
      childCount: children.length,
      depth,
      path: nextPath,
    };
    if (kind === "human") {
      entry.email = node.email ?? null;
      entry.userRole = node.userRole;
      entry.departmentName = node.departmentName ?? null;
    } else {
      entry.adapterType = node.adapterType ?? null;
    }
    entries.push(entry);
    entries.push(
      ...flattenTeamTree(
        children,
        { id: node.id, kind, name },
        depth + 1,
        nextPath,
      ),
    );
  }
  return entries;
}

function isGenericHumanRosterQuery(q: string) {
  const mentionsRoster = /\b(humans|people|members|team)\b/i.test(q);
  const asksForList = /\b(all|list|show|who|which)\b/i.test(q);
  const mentionsOrgScope = /\b(org|organization|company|team)\b/i.test(q);
  return mentionsRoster && (asksForList || mentionsOrgScope);
}

export function createQueryTools(): AgentTool[] {
  return [
    {
      name: "query_team_roster",
      description:
        "Read the unified company team roster and hierarchy across humans and org agents. Use for broad questions like who is on the team, who reports to whom, org chart, or humans and agents together.",
      parameters: {
        type: "object",
        properties: {
          includeTree: { type: "boolean", description: "Include the nested org tree. Defaults to true." },
          limit: { type: "number", description: "Max flat roster entries to return, default 100, max 200" },
        },
      },
      category: "query",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const raw = (params ?? {}) as Record<string, unknown>;
        const includeTree = raw.includeTree !== false;
        const rawLimit = typeof raw.limit === "number" && Number.isFinite(raw.limit) ? Math.floor(raw.limit) : 100;
        const limit = Math.min(Math.max(rawLimit, 1), 200);

        const tree = await ctx.services.agents.orgForCompany(ctx.companyId);
        const rosterAll = flattenTeamTree(tree);
        const roster = rosterAll.slice(0, limit);
        const counts = {
          humans: rosterAll.filter((entry) => entry.kind === "human").length,
          agents: rosterAll.filter((entry) => entry.kind === "agent").length,
          total: rosterAll.length,
        };
        return {
          success: true,
          data: {
            companyId: ctx.companyId,
            counts,
            roster,
            ...(includeTree ? { tree } : {}),
          },
          summary: `Found ${counts.total} team member(s): ${counts.humans} human(s), ${counts.agents} agent(s)`,
        };
      },
    },
    {
      name: "query_humans",
      description:
        "List company humans from the team roster. Use for broad questions like who is in this org, who is on the team, or which humans exist.",
      parameters: {
        type: "object",
        properties: {
          role: { type: "string", description: "Optional role filter: founder, team_lead, team_member, or all" },
          departmentId: { type: "string", description: "Optional department id filter" },
          limit: { type: "number", description: "Max results to return, default 20, max 50" },
        },
      },
      category: "query",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const raw = (params ?? {}) as Record<string, unknown>;
        const role = typeof raw.role === "string" ? raw.role : "all";
        const departmentId = typeof raw.departmentId === "string" ? raw.departmentId : null;
        const rawLimit = typeof raw.limit === "number" && Number.isFinite(raw.limit) ? Math.floor(raw.limit) : 20;
        const limit = Math.min(Math.max(rawLimit, 1), 50);
        const summary = await ctx.services.team.listTeam(ctx.companyId, ctx.userId ?? null);
        const results = summary.members
          .filter((member) => role === "all" || member.role === role)
          .filter((member) => departmentId === null || member.departmentId === departmentId)
          .slice(0, limit)
          .map((member) => ({
            userId: member.userId,
            email: member.email,
            displayName: member.displayName,
            avatarUrl: member.avatarUrl,
            title: member.title,
            role: member.role,
            departmentId: member.departmentId,
            departmentName: member.departmentName,
            reportsToUserId: member.parentId,
            isSystemAdmin: member.isSystemAdmin,
          }));
        return {
          success: true,
          data: { companyId: ctx.companyId, results },
          summary: `Found ${results.length} human(s)`,
        };
      },
    },
    {
      name: "find_humans",
      description:
        "Find company humans by profile, role, responsibility, and capability documents. Read-only; use before routing or escalating work.",
      parameters: {
        type: "object",
        properties: {
          q: { type: "string", description: "Search query, such as a skill, responsibility, domain, or person's name" },
          role: { type: "string", description: "Optional role filter: founder, team_lead, team_member, or all" },
          departmentId: { type: "string", description: "Optional department id filter" },
          limit: { type: "number", description: "Max results to return, default 20, max 50" },
        },
        required: ["q"],
      },
      category: "query",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const raw = (params ?? {}) as Record<string, unknown>;
        if (typeof raw.q !== "string" || !raw.q.trim()) {
          return { success: false, error: "q is required", data: null, summary: "Missing search query" };
        }
        const input = searchHumansSchema.parse(params ?? {});
        const result = await ctx.services.humanDiscovery.search(ctx.companyId, input);
        return {
          success: true,
          data: result,
          summary: `Found ${result.results.length} human(s) for "${result.query}"`,
        };
      },
    },
    {
      name: "query_human_context",
      description:
        "Read a company human's operational context bundle by user id, or resolve a natural-language query to the right human when there is exactly one match. Intended for Commander orchestration.",
      parameters: {
        type: "object",
        properties: {
          userId: { type: "string", description: "Human user id to read. Wins when both userId and q are provided." },
          q: { type: "string", description: "Natural-language query to resolve when the human user id is unknown." },
          limit: { type: "number", description: "Candidate limit for query resolution, default 5, max 10" },
        },
      },
      category: "query",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const raw = (params ?? {}) as Record<string, unknown>;
        const userId = typeof raw.userId === "string" ? raw.userId.trim() : "";
        const q = typeof raw.q === "string" ? raw.q.trim() : "";
        const rawLimit = typeof raw.limit === "number" && Number.isFinite(raw.limit) ? Math.floor(raw.limit) : 5;
        const limit = Math.min(Math.max(rawLimit, 1), 10);

        if (userId) {
          const bundle = await ctx.services.humanContext.getBundle(ctx.companyId, userId, ctx.userId ?? null);
          const data: HumanContextResolutionResult = {
            mode: "direct_context",
            query: null,
            selectedHuman: null,
            candidates: [],
            bundle,
          };
          return {
            success: true,
            data,
            summary: `Human context loaded for ${humanContextDisplay(bundle)}`,
          };
        }

        if (!q) {
          return {
            success: false,
            error: "userId or q is required",
            data: null,
            summary: "Missing human context target",
          };
        }

        if (isGenericHumanRosterQuery(q)) {
          return {
            success: false,
            error: "query_humans is required for broad human roster questions",
            data: null,
            summary: "Use query_humans for broad roster questions; use query_human_context for one specific human.",
          };
        }

        const discovery = await ctx.services.humanDiscovery.search(ctx.companyId, { q, role: "all", limit });
        if (discovery.results.length === 0) {
          const data: HumanContextResolutionResult = {
            mode: "no_match",
            query: discovery.query,
            selectedHuman: null,
            candidates: [],
            bundle: null,
          };
          return {
            success: true,
            data,
            summary: `No humans found for "${discovery.query}"`,
          };
        }

        if (discovery.results.length > 1) {
          const data: HumanContextResolutionResult = {
            mode: "multiple_matches",
            query: discovery.query,
            selectedHuman: null,
            candidates: discovery.results,
            bundle: null,
          };
          return {
            success: true,
            data,
            summary: `Found ${discovery.results.length} possible humans for "${discovery.query}"`,
          };
        }

        const selectedHuman = discovery.results[0];
        const bundle = await ctx.services.humanContext.getBundle(ctx.companyId, selectedHuman.userId, ctx.userId ?? null);
        const data: HumanContextResolutionResult = {
          mode: "resolved_context",
          query: discovery.query,
          selectedHuman,
          candidates: discovery.results,
          bundle,
        };
        return {
          success: true,
          data,
          summary: `Resolved "${discovery.query}" to ${humanContextDisplay(bundle)}`,
        };
      },
    },
    {
      name: "query_tasks",
      description: "List and filter tasks. Returns tasks matching the given filters.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status (e.g. todo, in_progress, review, done)" },
          departmentId: { type: "string", description: "Filter by department ID" },
          limit: { type: "number", description: "Max results to return (default 20)" },
        },
      },
      category: "query",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const { status, departmentId, limit } = (params ?? {}) as Record<string, unknown>;
        // Commander monitors the whole company including its own crew (eng-review
        // locked decision #3 — Commander scans = 'all'). The list() default
        // flipped to 'org' on 2026-06-02; pass 'all' so Commander's task queries
        // still see crew-agent work alongside org/human tasks.
        const tasks = await ctx.services.issues.list(ctx.companyId, {
          taskScope: "all",
          ...(status ? { status: status as string } : {}),
          ...(departmentId ? { projectId: departmentId as string } : {}),
        });
        const limited = Array.isArray(tasks) ? tasks.slice(0, (limit as number) ?? 20) : tasks;
        const count = Array.isArray(limited) ? limited.length : 0;
        return { success: true, data: limited, summary: `Found ${count} task(s)` };
      },
    },
    {
      name: "query_goals",
      description: "List goals with optional status filter.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", description: "Filter by status (planned, active, at_risk, achieved, cancelled)" },
          limit: { type: "number", description: "Max results to return" },
        },
      },
      category: "query",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const { status, limit } = (params ?? {}) as Record<string, unknown>;
        const goals = await ctx.services.goals.list(ctx.companyId);
        const filtered = Array.isArray(goals) && status
          ? goals.filter((g: any) => g.status === status)
          : goals;
        const limited = Array.isArray(filtered) ? filtered.slice(0, (limit as number) ?? 20) : filtered;
        const count = Array.isArray(limited) ? limited.length : 0;
        return { success: true, data: limited, summary: `Found ${count} goal(s)` };
      },
    },
    {
      name: "query_agents",
      description: "List agents with optional department filter.",
      parameters: {
        type: "object",
        properties: {
          departmentId: { type: "string", description: "Filter by department ID" },
          limit: { type: "number", description: "Max results to return" },
        },
      },
      category: "query",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const { departmentId, limit } = (params ?? {}) as Record<string, unknown>;
        const agents = await ctx.services.agents.list(ctx.companyId);
        const filtered = Array.isArray(agents) && departmentId
          ? agents.filter((a: any) => a.projectId === departmentId)
          : agents;
        const limited = Array.isArray(filtered) ? filtered.slice(0, (limit as number) ?? 20) : filtered;
        const count = Array.isArray(limited) ? limited.length : 0;
        return { success: true, data: limited, summary: `Found ${count} agent(s)` };
      },
    },
    {
      name: "query_departments",
      description: "List all departments.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max results to return" },
        },
      },
      category: "query",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const { limit } = (params ?? {}) as Record<string, unknown>;
        const departments = await ctx.services.projects.list(ctx.companyId, { type: "department" });
        const limited = Array.isArray(departments) ? departments.slice(0, (limit as number) ?? 20) : departments;
        const count = Array.isArray(limited) ? limited.length : 0;
        return { success: true, data: limited, summary: `Found ${count} department(s)` };
      },
    },
    {
      name: "query_budget",
      description: "Get budget summary for the company.",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["month", "year"], description: "Time period for budget summary" },
        },
      },
      category: "query",
      requiredRole: "team_lead",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const { period } = (params ?? {}) as Record<string, unknown>;
        const range =
          period === "year"
            ? { from: new Date(new Date().getFullYear(), 0, 1), to: new Date() }
            : { from: new Date(new Date().getFullYear(), new Date().getMonth(), 1), to: new Date() };
        const summary = await ctx.services.costs.summary(ctx.companyId, range);
        return { success: true, data: summary, summary: `Budget summary retrieved` };
      },
    },
    {
      name: "query_activity",
      description: "Get recent activity log entries.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max entries to return (default 20)" },
        },
      },
      category: "query",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (params: unknown, ctx) => {
        const { limit } = (params ?? {}) as Record<string, unknown>;
        const activities = await ctx.services.activity.list({ companyId: ctx.companyId });
        const limited = Array.isArray(activities) ? activities.slice(0, (limit as number) ?? 20) : activities;
        const count = Array.isArray(limited) ? limited.length : 0;
        return { success: true, data: limited, summary: `Found ${count} activity entries` };
      },
    },
    {
      name: "query_company",
      description:
        "Get the current company's identity: name, vision, mission, issue prefix, and stage. Call this whenever you need to know who you are working for.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      category: "query",
      requiredRole: "team_member",
      requiresConfirmation: false,
      execute: async (_params: unknown, ctx) => {
        const company = await ctx.services.companies.get(ctx.companyId);
        if (!company) {
          return { success: false, error: "Company not found", data: null, summary: "Company not found" };
        }
        return {
          success: true,
          data: {
            name: company.name ?? null,
            vision: company.vision ?? null,
            mission: company.mission ?? null,
            issuePrefix: company.issuePrefix ?? null,
            stage: company.stage ?? null,
          },
          summary: `Company: ${company.name ?? "unnamed"}`,
        };
      },
    },
  ];
}
