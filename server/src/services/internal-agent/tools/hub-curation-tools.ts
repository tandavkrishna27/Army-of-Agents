import { z } from "zod";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { hubItems } from "@armyofagents/db";
import type { AgentTool, ToolResult } from "../types.js";
import { hubCurationService, type UpdateHubCurationSummaryInput } from "../../hub-curation.js";
import { redactSecretsInString } from "../../../redaction.js";

const updateInputSchema = z
  .object({
    companyId: z.string().uuid(),
    hubItemId: z.string().uuid(),
    expectedCurationRevision: z.number().int().nonnegative(),
    curationGroupLabel: z.string().trim().min(1).max(120).nullable().optional(),
    curationGroupSummary: z.string().trim().min(1).max(500).nullable().optional(),
    curationReason: z.string().trim().min(1).max(500).nullable().optional(),
    curationPriorityReason: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict();

const readInputSchema = z
  .object({
    companyId: z.string().uuid(),
    targetType: z.enum(["item", "group"]),
    hubItemId: z.string().uuid().optional(),
    groupKey: z.string().trim().min(1).max(240).optional(),
    limit: z.number().int().min(1).max(5).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.targetType === "item" && !value.hubItemId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hubItemId"],
        message: "hubItemId is required for item targets",
      });
    }
    if (value.targetType === "group" && !value.groupKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groupKey"],
        message: "groupKey is required for group targets",
      });
    }
    if (value.targetType === "item" && value.groupKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groupKey"],
        message: "groupKey is only valid for group targets",
      });
    }
    if (value.targetType === "group" && value.hubItemId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hubItemId"],
        message: "hubItemId is only valid for item targets",
      });
    }
  });

function redactNullable(value: string | null | undefined): string | null {
  if (!value) return null;
  return redactSecretsInString(value);
}

function toCurationContextItem(row: {
  id: string;
  semanticType: string | null;
  sourceType: string | null;
  sourceId: string | null;
  title: string;
  summary: string | null;
  priority: string;
  slaAt: Date | string | null;
  curationRevision: number;
}) {
  return {
    hubItemId: row.id,
    semanticType: row.semanticType,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    title: redactSecretsInString(row.title),
    summary: redactNullable(row.summary),
    priority: row.priority,
    slaAt: row.slaAt instanceof Date ? row.slaAt.toISOString() : row.slaAt,
    curationRevision: row.curationRevision,
  };
}

function derivedGroupKeyExpression() {
  return sql<string>`
    'auto:' || ${hubItems.companyId} ||
    ':' || coalesce(${hubItems.semanticType}, 'unknown') ||
    ':' || coalesce(${hubItems.scopeKey}, 'global') ||
    ':' || coalesce(${hubItems.sourceType}, 'unknown') ||
    ':' || case
      when ${hubItems.ownerPool} is not null then 'pool:' || ${hubItems.ownerPool}
      when ${hubItems.ownerUserId} is not null then 'owner:' || ${hubItems.ownerUserId}
      else 'owner:unassigned'
    end
  `;
}

function groupKeyCondition(groupKey: string) {
  return or(
    eq(hubItems.groupKey, groupKey),
    and(isNull(hubItems.groupKey), eq(derivedGroupKeyExpression(), groupKey)),
  );
}

export const hubReadCurationContextTool: AgentTool = {
  name: "hub.readCurationContext",
  description:
    "Read bounded, redacted hub item context for Steward curation. This returns hub envelopes and source pointers only; it never reads raw source bodies or mutates lifecycle state.",
  parameters: {
    type: "object",
    properties: {
      companyId: { type: "string", description: "The company that owns the hub target" },
      targetType: { type: "string", enum: ["item", "group"], description: "Whether to read one item or a grouped row" },
      hubItemId: { type: "string", description: "Required for item targets" },
      groupKey: { type: "string", description: "Required for group targets" },
      limit: { type: "number", description: "Maximum group evidence rows to return, capped at 5" },
    },
    required: ["companyId", "targetType"],
  },
  category: "coordination",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    const parsed = readInputSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return {
        success: false,
        data: null,
        summary: "Invalid hub curation context input",
        error: "INVALID_PARAMS",
      };
    }

    if (parsed.data.companyId !== ctx.companyId) {
      return {
        success: false,
        data: null,
        summary: "Hub target belongs to a different company",
        error: "COMPANY_MISMATCH",
      };
    }

    const selection = {
      id: hubItems.id,
      semanticType: hubItems.semanticType,
      sourceType: hubItems.sourceType,
      sourceId: hubItems.sourceId,
      title: hubItems.title,
      summary: hubItems.summary,
      priority: hubItems.priority,
      slaAt: hubItems.slaAt,
      curationRevision: hubItems.curationRevision,
    };
    const limit = parsed.data.targetType === "group" ? parsed.data.limit ?? 5 : 1;
    const query = ctx.db
      .select(selection)
      .from(hubItems)
      .where(
        and(
          eq(hubItems.companyId, parsed.data.companyId),
          parsed.data.targetType === "item"
            ? eq(hubItems.id, parsed.data.hubItemId!)
            : groupKeyCondition(parsed.data.groupKey!),
          eq(hubItems.status, "open"),
        ),
      );
    const rows = parsed.data.targetType === "group"
      ? await query.orderBy(asc(hubItems.createdAt)).limit(limit)
      : await query.limit(1);

    return {
      success: true,
      data: {
        targetType: parsed.data.targetType,
        hubItemId: parsed.data.hubItemId ?? null,
        groupKey: parsed.data.groupKey ?? null,
        items: rows.map(toCurationContextItem),
      },
      summary: `Read ${rows.length} hub curation context item${rows.length === 1 ? "" : "s"}`,
    };
  },
};

export const hubUpdateCurationSummaryTool: AgentTool = {
  name: "hub.updateCurationSummary",
  description:
    "Write a bounded Steward curation summary or explanation for a hub item. This only updates display curation metadata and never resolves, archives, approves, rejects, or changes source-side state.",
  parameters: {
    type: "object",
    properties: {
      companyId: { type: "string", description: "The company that owns the hub item" },
      hubItemId: { type: "string", description: "The hub item whose curation metadata should be updated" },
      expectedCurationRevision: {
        type: "number",
        description: "The curation revision from the wakeup payload; stale writes are rejected",
      },
      curationGroupLabel: { type: "string", description: "Optional short group label, max 120 characters" },
      curationGroupSummary: { type: "string", description: "Optional group summary, max 500 characters" },
      curationReason: { type: "string", description: "Optional why-this-is-visible explanation, max 500 characters" },
      curationPriorityReason: { type: "string", description: "Optional deterministic priority/SLA explanation, max 500 characters" },
    },
    required: ["companyId", "hubItemId", "expectedCurationRevision"],
  },
  category: "coordination",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx): Promise<ToolResult> {
    const parsed = updateInputSchema.safeParse(params ?? {});
    if (!parsed.success) {
      return {
        success: false,
        data: null,
        summary: "Invalid hub curation metadata input",
        error: "INVALID_PARAMS",
      };
    }

    if (parsed.data.companyId !== ctx.companyId) {
      return {
        success: false,
        data: null,
        summary: "Hub item belongs to a different company",
        error: "COMPANY_MISMATCH",
      };
    }

    try {
      const updateInput: UpdateHubCurationSummaryInput = {
        companyId: parsed.data.companyId,
        hubItemId: parsed.data.hubItemId,
        expectedCurationRevision: parsed.data.expectedCurationRevision,
        curatedByAgentId: ctx.agentId ?? null,
      };
      if (parsed.data.curationGroupLabel !== undefined) {
        updateInput.curationGroupLabel = parsed.data.curationGroupLabel;
      }
      if (parsed.data.curationGroupSummary !== undefined) {
        updateInput.curationGroupSummary = parsed.data.curationGroupSummary;
      }
      if (parsed.data.curationReason !== undefined) {
        updateInput.curationReason = parsed.data.curationReason;
      }
      if (parsed.data.curationPriorityReason !== undefined) {
        updateInput.curationPriorityReason = parsed.data.curationPriorityReason;
      }

      const row = await hubCurationService(ctx.db).updateSummary(updateInput);

      return {
        success: true,
        data: {
          hubItemId: parsed.data.hubItemId,
          curationRevision: row.curationRevision,
        },
        summary: "Hub curation metadata updated",
      };
    } catch (error: any) {
      if (error?.status === 409) {
        return {
          success: false,
          data: null,
          summary: error.message ?? "Hub curation metadata changed. Recompute and retry.",
          error: "CURATION_CONFLICT",
        };
      }
      if (error?.status === 422) {
        return {
          success: false,
          data: null,
          summary: error.message ?? "Invalid hub curation metadata",
          error: "INVALID_PARAMS",
        };
      }
      throw error;
    }
  },
};
