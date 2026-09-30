import type { Db } from "@armyofagents/db";
import type {
  accessService,
  agentService,
  approvalService,
  artifactService,
  companyService,
  debriefService,
  extractionService,
  goalService,
  issueApprovalService,
  issueService,
  mcpService,
  memoryService,
  permissionService,
  projectService,
} from "../../services/index.js";
import type { getActorInfo } from "../../routes/authz.js";

export type McpUserScope =
  | { kind: "founder"; userId: string }
  | { kind: "scoped"; userId: string; projectIds: Set<string> };

/**
 * Identity of the caller of an MCP route.
 *
 * `source` differentiates how the caller authenticated:
 *   - "mcp"       — Bearer token matched an mcp_api_keys row (external client)
 *   - "board"     — board session cookie (founder/team_lead from browser)
 *   - "agent"     — short-lived run JWT issued to a CLI worker agent
 *   - "commander" — internal-agent JWT (reserved; only meaningful once
 *                   reserved for Commander CLI work)
 *
 * Worker-tool gating (allowedActors) reads `source` to decide whether
 * a given tool is callable by the caller.
 *
 * `agentId`/`runId` are populated for agent + commander actors and let
 * tools like memory.retain (auto-approve self-personal scope) identify
 * the calling agent without trusting a caller-supplied parameter.
 */
export type ProtocolActor = {
  userId: string;
  companyId: string | null;
  keyId: string | null;
  source: "mcp" | "board" | "agent" | "commander";
  /** Set for agent + commander actors. Null for mcp + board. */
  agentId?: string | null;
  /** Set when the agent is calling during an active heartbeat run. */
  runId?: string | null;
};

export interface ToolServices {
  issuesSvc: ReturnType<typeof issueService>;
  goalsSvc: ReturnType<typeof goalService>;
  memorySvc: ReturnType<typeof memoryService>;
  artifactsSvc: ReturnType<typeof artifactService>;
  debriefsSvc: ReturnType<typeof debriefService>;
  extractionSvc: ReturnType<typeof extractionService>;
  companiesSvc: ReturnType<typeof companyService>;
  mcpSvc: ReturnType<typeof mcpService>;
  permissionsSvc: ReturnType<typeof permissionService>;
  accessSvc: ReturnType<typeof accessService>;
  agentsSvc: ReturnType<typeof agentService>;
  projectsSvc: ReturnType<typeof projectService>;
  approvalsSvc: ReturnType<typeof approvalService>;
  issueApprovalsSvc: ReturnType<typeof issueApprovalService>;
}

export interface ToolContext {
  db: Db;
  companyId: string;
  actor: ProtocolActor;
  scope: McpUserScope;
  services: ToolServices;
  actorInfo: ReturnType<typeof getActorInfo>;
  resolveRole: (companyId: string, userId: string) => Promise<string>;
  resolveScopedAgentIds: (
    companyId: string,
    scope: McpUserScope,
  ) => Promise<Set<string> | null>;
}

export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; status: number; code: number; message: string };

export type ToolHandler = (
  ctx: ToolContext,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

export const ok = (data: unknown): ToolResult => ({ ok: true, data });

export const err = (status: number, code: number, message: string): ToolResult => ({
  ok: false,
  status,
  code,
  message,
});

export const notFoundResult = (message: string): ToolResult => err(404, -32004, message);
export const forbiddenResult = (message: string): ToolResult => err(403, -32003, message);
