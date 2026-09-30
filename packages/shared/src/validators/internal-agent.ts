import { z } from "zod";
import {
  AGENT_EXECUTION_MODES,
  AGENT_PROVIDERS,
  AGENT_CAPABILITIES,
  NOTIFICATION_PREFERENCES,
} from "../constants.js";
import { INBOUND_ROUTING_LEVELS } from "../inbound-routing.js";

export const updateInternalAgentConfigSchema = z.object({
  executionMode: z.enum(AGENT_EXECUTION_MODES).optional(),
  provider: z.enum(AGENT_PROVIDERS).optional().nullable(),
  model: z.string().optional().nullable(),
  crewModel: z.string().optional().nullable(),
  cliTool: z.string().optional().nullable(),
  // D18 dial-split: `autonomyLevel` is Commander's; `crewAutonomyLevel` drives
  // crew task runs, org-agent heartbeat runs, and Adjutant/thread flows. They
  // are set independently — never mirror one onto the other.
  autonomyLevel: z.number().int().min(0).max(2).optional(),
  crewAutonomyLevel: z.number().int().min(0).max(2).optional(),
  enabledCapabilities: z.array(z.enum(AGENT_CAPABILITIES)).optional(),
  notificationPreference: z.enum(NOTIFICATION_PREFERENCES).optional(),
  contextTokenBudget: z.number().int().positive().optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional().nullable(),
  proactiveIntervalMinutes: z.number().int().min(15).optional(),
  cheapModel: z.string().optional().nullable(),
  runtimeApprovalsEnabled: z.boolean().optional(),
  runtimeAllowAlwaysEnabled: z.boolean().optional(),
  vendorCliBypassEnabled: z.boolean().optional(),
  // Task 0.7 (Inbound Dirty-Data Routing): per-company routing dial.
  // Derives allowed values from INBOUND_ROUTING_LEVELS to stay in sync.
  inboundRoutingLevel: z
    .enum(
      INBOUND_ROUTING_LEVELS.map((l) => l.value) as [string, ...string[]],
    )
    .optional(),
  // Viewer Upgrade Phase 5: per-company default viewer control level.
  viewerControlLevel: z.enum(["manual", "own_output", "full"]).optional(),
});

export type UpdateInternalAgentConfig = z.infer<typeof updateInternalAgentConfigSchema>;

export const commanderContextSurfaceSchema = z.enum([
  "home",
  "commander",
  "department",
  "project",
  "goal",
  "task",
  "memory",
  "discussion",
  "budget",
  "team",
  "settings",
]);

export const commanderContextScopeSchema = z.object({
  surface: commanderContextSurfaceSchema.default("commander"),
  route: z.string().max(500).optional().nullable(),
  departmentId: z.string().uuid().optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  taskId: z.string().uuid().optional().nullable(),
  memoryFolderPath: z.string().max(500).optional().nullable(),
});

export type CommanderContextScope = z.infer<typeof commanderContextScopeSchema>;

export const chatMessageSchema = z.object({
  message: z.string().min(1).max(10000),
  pageContext: z.string().max(5000).optional().nullable(),
  conversationId: z.string().uuid().optional().nullable(),
  // Client-generated idempotency key. A retried Send (same key) replays the
  // original turn instead of persisting a duplicate message or re-running the CLI.
  clientSubmissionId: z.string().trim().min(1).max(200).optional().nullable(),
  contextScope: commanderContextScopeSchema.optional().nullable(),
  departmentContext: z.string().uuid().optional().nullable(),
  // Composer attachment asset IDs. The server resolves company-owned files and
  // delivers text-readable content into the turn (runtime delivery v1).
  attachmentAssetIds: z.array(z.string().uuid()).max(5).optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
