import { z } from "zod";
import { AGENT_ADAPTER_TYPES } from "../constants.js";
import {
  HUB_AUTOPILOT_ACTIONS,
  HUB_AUTOPILOT_MODES,
  HUB_DENSITIES,
  HUB_GROUP_MODES,
  HUB_ITEM_STATUSES,
  HUB_LANDING_TARGETS,
  HUB_LANES,
  RUNTIME_DECISION_KINDS,
  RUNTIME_DECISION_PERMISSION_DECISIONS,
  RUNTIME_DECISION_STATUSES,
  RUNTIME_DECISION_TIMEOUT_POLICIES,
  HUB_SEMANTIC_TYPES,
  isFounderGatedAutopilotType,
} from "../hub.js";

const queryBoolean = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .optional()
  .transform((v) => v === true || v === "true" || v === "1");

// ── List query (GET /companies/:companyId/hub-items) ──────────────────────────
// Query-string params arrive as strings; coerce `includeDismissed` to a boolean
// and constrain `lane`/`status` to the shared enums.
export const listHubItemsQuery = z
  .object({
    lane: z.enum(HUB_LANES).optional(),
    status: z.enum(HUB_ITEM_STATUSES).optional(),
    q: z
      .string()
      .trim()
      .max(120)
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    cursor: z.string().trim().min(1).optional(),
    groupMode: z.enum(HUB_GROUP_MODES).optional(),
    // Accept "true"/"false"/"1"/"0" from the query string.
    includeDismissed: queryBoolean,
    includeSnoozed: queryBoolean,
    limit: z.coerce.number().int().min(1).max(50).optional().default(50),
  })
  .strict();

export type ListHubItemsQuery = z.infer<typeof listHubItemsQuery>;

const visibleLanesSchema = z
  .array(z.enum(HUB_LANES))
  .min(1)
  .refine((lanes) => new Set(lanes).size === lanes.length, {
    message: "visibleLanes must not contain duplicates",
  });

export const hubPreferencesSchema = z
  .object({
    defaultLanding: z.enum(HUB_LANDING_TARGETS),
    visibleLanes: visibleLanesSchema,
    groupMode: z.enum(HUB_GROUP_MODES),
    density: z.enum(HUB_DENSITIES),
    showAutopilotEntry: z.boolean(),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();

export type HubPreferences = z.infer<typeof hubPreferencesSchema>;

export const updateHubPreferencesSchema = z
  .object({
    defaultLanding: z.enum(HUB_LANDING_TARGETS).optional(),
    visibleLanes: visibleLanesSchema.optional(),
    groupMode: z.enum(HUB_GROUP_MODES).optional(),
    density: z.enum(HUB_DENSITIES).optional(),
    showAutopilotEntry: z.boolean().optional(),
  })
  .strict();

export type UpdateHubPreferencesInput = z.infer<typeof updateHubPreferencesSchema>;

export const hubListRowSchema = z
  .object({
    id: z.string().min(1),
    groupKey: z.string().nullable(),
    groupLabel: z.string().nullable(),
    groupCount: z.number().int().nonnegative().nullable(),
    scopeKey: z.string().nullable(),
    slaAt: z.string().datetime().nullable(),
  })
  .passthrough();

export type HubListRow = z.infer<typeof hubListRowSchema>;

export const hubListResponseSchema = z
  .object({
    items: z.array(hubListRowSchema),
    nextCursor: z.string().nullable(),
    totalKnown: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type HubListResponse = z.infer<typeof hubListResponseSchema>;

const nullableBoundedText = (max: number) => z.string().trim().min(1).max(max).nullable();

export const hubCurationMetadataSchema = z
  .object({
    curationGroupLabel: nullableBoundedText(120),
    curationGroupSummary: nullableBoundedText(500),
    curationReason: nullableBoundedText(500),
    curationPriorityReason: nullableBoundedText(500),
    curationRevision: z.number().int().nonnegative(),
    curatedAt: z.string().datetime().nullable(),
    curatedByAgentId: z.string().uuid().nullable(),
  })
  .strict();

export type HubCurationMetadata = z.infer<typeof hubCurationMetadataSchema>;

const runtimeDecisionAnswerBaseSchema = z.object({
  expectedSourceRevision: z.number().int().nonnegative(),
  nonce: z.string().trim().min(1).max(256),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
});

export const runtimeDecisionAnswerSchema = z.discriminatedUnion("kind", [
  runtimeDecisionAnswerBaseSchema
    .extend({
      kind: z.literal("permission"),
      decision: z.enum(RUNTIME_DECISION_PERMISSION_DECISIONS),
    })
    .strict(),
  runtimeDecisionAnswerBaseSchema
    .extend({
      kind: z.literal("work_question"),
      answer: z.record(z.unknown()),
    })
    .strict(),
]);

export type RuntimeDecisionAnswerInput = z.infer<typeof runtimeDecisionAnswerSchema>;

export const runtimeDecisionDetailSchema = z
  .object({
    id: z.string().uuid(),
    hubItemId: z.string().uuid().nullable(),
    companyId: z.string().uuid(),
    agentId: z.string().uuid(),
    runId: z.string().uuid(),
    adapterType: z.enum(AGENT_ADAPTER_TYPES),
    adapterSessionId: z.string().nullable(),
    kind: z.enum(RUNTIME_DECISION_KINDS),
    status: z.enum(RUNTIME_DECISION_STATUSES),
    sourceRevision: z.number().int().nonnegative(),
    nonce: z.string().min(1),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(1000).nullable(),
    promptText: z.string().trim().min(1).max(4000).nullable(),
    toolName: z.string().trim().min(1).max(160).nullable(),
    command: z.string().trim().min(1).max(1000).nullable(),
    cwd: z.string().trim().min(1).max(1000).nullable(),
    path: z.string().trim().min(1).max(1000).nullable(),
    networkTarget: z.string().trim().min(1).max(1000).nullable(),
    riskClass: z.string().trim().min(1).max(80).nullable(),
    allowRunEligible: z.boolean().optional(),
    allowRunReason: z.string().trim().min(1).max(240).nullable().optional(),
    options: z
      .array(
        z
          .object({
            label: z.string().min(1),
            value: z.string().min(1),
            // Optional card detail (D-tabbed). Carried through the JSON options
            // column; the RuntimeDecisionPanel renders them when present. The
            // content source (asking agent / Commander) is a deferred follow-up.
            description: z.string().min(1).optional(),
            rationale: z.string().min(1).optional(),
          })
          .passthrough(),
      )
      .nullable(),
    timeoutPolicy: z.enum(RUNTIME_DECISION_TIMEOUT_POLICIES),
    expiresAt: z.string().datetime().nullable(),
    answeredAt: z.string().datetime().nullable(),
    relayedAt: z.string().datetime().nullable(),
    relayError: z.string().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type RuntimeDecisionDetail = z.infer<typeof runtimeDecisionDetailSchema>;

// ── Action (POST /companies/:companyId/hub-items/:id/action) ──────────────────
// Optimistic-concurrency action envelope. `expectedVersion` is the version the
// client last saw → a mismatch yields 409. `nextStatus` is the target lifecycle
// state (W1a covers single-item resolve/archive/snooze).
export const hubActionSchema = z
  .object({
    action: z.enum(["resolve", "archive", "claim", "release"]),
    expectedVersion: z.number().int().min(0),
    idempotencyKey: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

export type HubActionInput = z.infer<typeof hubActionSchema>;

// ── Per-user state (PATCH /companies/:companyId/hub-items/:id/state) ───────────
// A discriminated union over the three divergence kinds a principal can record:
// read, snooze (until a datetime), or dismiss. Each writes the matching column
// on the sparse `hub_item_user_state` row.
export const hubUserStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read") }).strict(),
  z.object({ kind: z.literal("unread") }).strict(),
  z.object({ kind: z.literal("snooze"), until: z.string().datetime() }).strict(),
  z.object({ kind: z.literal("unsnooze") }).strict(),
  z.object({ kind: z.literal("dismiss") }).strict(),
  z.object({ kind: z.literal("undismiss") }).strict(),
]);

export type HubUserStateInput = z.infer<typeof hubUserStateSchema>;

const bulkSharedLifecycleItemSchema = z
  .object({
    id: z.string().uuid(),
    action: z.enum(["resolve", "archive", "claim", "release"]),
    expectedVersion: z.number().int().min(0),
    idempotencyKey: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

const bulkDismissItemSchema = z
  .object({
    id: z.string().uuid(),
    action: z.literal("dismiss"),
    idempotencyKey: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

const bulkSnoozeItemSchema = z
  .object({
    id: z.string().uuid(),
    action: z.literal("snooze"),
    until: z.string().datetime(),
    idempotencyKey: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

export const hubBulkActionSchema = z
  .object({
    bulkId: z.string().trim().min(1).optional(),
    items: z
      .array(
        z.discriminatedUnion("action", [
          bulkSharedLifecycleItemSchema,
          bulkDismissItemSchema,
          bulkSnoozeItemSchema,
        ]),
      )
      .min(1)
      .max(50),
  })
  .strict();

export type HubBulkActionInput = z.infer<typeof hubBulkActionSchema>;

export const hubUndoSchema = z
  .object({
    auditId: z.string().trim().min(1),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

export type HubUndoInput = z.infer<typeof hubUndoSchema>;

function rejectDuplicateSemanticTypes(
  rules: Array<{ semanticType: string }>,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (seen.has(rule.semanticType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rules", index, "semanticType"],
        message: "Autopilot policy cannot contain duplicate semantic type rules",
      });
    }
    seen.add(rule.semanticType);
  }
}

export const hubAutopilotRuleSchema = z
  .object({
    semanticType: z.enum(HUB_SEMANTIC_TYPES),
    action: z.enum(HUB_AUTOPILOT_ACTIONS),
    minTrustScore: z.number().int().min(0).max(100),
    enabled: z.boolean(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.enabled && rule.action !== "none" && isFounderGatedAutopilotType(rule.semanticType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "Founder-gated hub categories cannot be auto-handled in W3 core",
      });
    }
  });

export type HubAutopilotRule = z.infer<typeof hubAutopilotRuleSchema>;

export const hubAutopilotPolicySchema = z
  .object({
    mode: z.enum(HUB_AUTOPILOT_MODES),
    handledToday: z.number().int().nonnegative(),
    lastHandledAt: z.string().datetime().nullable(),
    rules: z.array(hubAutopilotRuleSchema),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((policy, ctx) => rejectDuplicateSemanticTypes(policy.rules, ctx));

export type HubAutopilotPolicy = z.infer<typeof hubAutopilotPolicySchema>;

export const updateHubAutopilotPolicySchema = z
  .object({
    mode: z.enum(HUB_AUTOPILOT_MODES).optional(),
    rules: z.array(hubAutopilotRuleSchema).optional(),
  })
  .strict()
  .superRefine((patch, ctx) => rejectDuplicateSemanticTypes(patch.rules ?? [], ctx));

export type UpdateHubAutopilotPolicyInput = z.infer<typeof updateHubAutopilotPolicySchema>;

export const hubAutopilotEvaluationResultSchema = z
  .object({
    decision: z.enum(["noop", "auto_handle", "escalate"]),
    action: z.enum(HUB_AUTOPILOT_ACTIONS),
    reason: z.string().min(1),
    autonomyLevel: z.enum(HUB_AUTOPILOT_MODES),
  })
  .strict();

export type HubAutopilotEvaluationResult = z.infer<typeof hubAutopilotEvaluationResultSchema>;

export const hubAutopilotActionRowSchema = z
  .object({
    auditId: z.string().min(1),
    hubItemId: z.string().nullable(),
    title: z.string(),
    semanticType: z.enum(HUB_SEMANTIC_TYPES).nullable(),
    action: z.enum(["resolve", "archive"]),
    autonomyLevel: z.enum(HUB_AUTOPILOT_MODES).nullable(),
    reason: z.string().nullable(),
    decisionContext: z.unknown(),
    undoDeadline: z.string().datetime().nullable(),
    itemStatus: z.enum(HUB_ITEM_STATUSES).nullable(),
    itemVersion: z.number().int().nonnegative().nullable(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type HubAutopilotActionRow = z.infer<typeof hubAutopilotActionRowSchema>;

export const hubAutopilotActionsResponseSchema = z
  .object({
    items: z.array(hubAutopilotActionRowSchema),
  })
  .strict();

export type HubAutopilotActionsResponse = z.infer<typeof hubAutopilotActionsResponseSchema>;
