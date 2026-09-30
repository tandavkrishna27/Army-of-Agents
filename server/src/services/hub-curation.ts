import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { hubItems } from "@armyofagents/db";
import {
  HUB_SEMANTIC_TYPES,
  hubCurationMetadataSchema,
  laneForSemanticType,
  type HubCurationMetadata,
  type HubItemPriority,
  type HubItemStatus,
  type HubOwnerPool,
  type HubSemanticType,
} from "@armyofagents/shared";
import { conflict, unprocessable } from "../errors.js";
import { redactSecretsInString } from "../redaction.js";
import { publishLiveEvent } from "./live-events.js";

export interface HubCurationSourceItem {
  id: string;
  companyId: string;
  semanticType: HubSemanticType | string | null;
  sourceType: string | null;
  scopeKey: string | null;
  groupKey: string | null;
  ownerUserId: string | null;
  ownerPool: HubOwnerPool | string | null;
  priority: HubItemPriority | string;
  slaAt: Date | string | null;
  version: number;
  curationRevision: number;
}

export interface DerivedHubCuration {
  effectiveGroupKey: string;
  curationGroupLabel: string;
  curationGroupSummary: string | null;
  curationReason: string | null;
  curationPriorityReason: string | null;
  nextCurationRevision: number;
  nextVersion: number;
}

export interface UpdateHubCurationSummaryInput {
  companyId: string;
  hubItemId: string;
  expectedCurationRevision: number;
  curationGroupLabel?: string | null;
  curationGroupSummary?: string | null;
  curationReason?: string | null;
  curationPriorityReason?: string | null;
  curatedByAgentId?: string | null;
}

function ownershipScope(item: HubCurationSourceItem): string {
  if (item.ownerPool) return `pool:${item.ownerPool}`;
  if (item.ownerUserId) return `owner:${item.ownerUserId}`;
  return "owner:unassigned";
}

function sourceScope(item: HubCurationSourceItem): string {
  return [
    item.companyId,
    item.semanticType ?? "unknown",
    item.scopeKey ?? "global",
    item.sourceType ?? "unknown",
    ownershipScope(item),
  ].join(":");
}

function labelFromGroupKey(key: string): string {
  const parts = key.split(":").filter(Boolean);
  return parts[parts.length - 1] ?? key;
}

function minutesUntil(slaAt: Date | string | null, now: Date): number | null {
  if (!slaAt) return null;
  const date = slaAt instanceof Date ? slaAt : new Date(slaAt);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  return Math.floor((time - now.getTime()) / 60_000);
}

export function deriveCurationForHubItem(
  item: HubCurationSourceItem,
  now = new Date(),
): DerivedHubCuration {
  const effectiveGroupKey = item.groupKey ?? `auto:${sourceScope(item)}`;
  const slaMinutes = minutesUntil(item.slaAt, now);
  const isUrgent = item.priority === "urgent";
  const isHigh = item.priority === "high";
  const curationPriorityReason = isUrgent
    ? "Urgent priority is set on this hub item."
    : isHigh
      ? "High priority is set on this hub item."
      : null;
  const curationReason =
    slaMinutes != null && slaMinutes <= 60
      ? slaMinutes < 0
        ? "SLA is overdue."
        : `SLA is due in ${slaMinutes} minutes.`
      : null;

  return {
    effectiveGroupKey,
    curationGroupLabel: labelFromGroupKey(effectiveGroupKey),
    curationGroupSummary: null,
    curationReason,
    curationPriorityReason,
    nextCurationRevision: item.curationRevision + 1,
    nextVersion: item.version,
  };
}

function isHubSemanticType(value: string | null): value is HubSemanticType {
  return !!value && (HUB_SEMANTIC_TYPES as readonly string[]).includes(value);
}

function safeCurationText(value: string | null | undefined): string | null {
  if (value == null) return null;
  return redactSecretsInString(value).trim();
}

export function hubCurationService(
  db?: Db,
  deps: { now?: () => Date } = {},
) {
  const now = deps.now ?? (() => new Date());

  return {
    deriveForItem: deriveCurationForHubItem,

    async updateSummary(args: UpdateHubCurationSummaryInput) {
      if (!db) throw new Error("hubCurationService.updateSummary requires a db");
      const nextRevision = args.expectedCurationRevision + 1;
      const curatedAt = now();
      const safeMetadata: Partial<HubCurationMetadata> = {
        curationRevision: nextRevision,
        curatedAt: curatedAt.toISOString(),
        curatedByAgentId: args.curatedByAgentId ?? null,
      };
      if (args.curationGroupLabel !== undefined) {
        safeMetadata.curationGroupLabel = safeCurationText(args.curationGroupLabel);
      }
      if (args.curationGroupSummary !== undefined) {
        safeMetadata.curationGroupSummary = safeCurationText(args.curationGroupSummary);
      }
      if (args.curationReason !== undefined) {
        safeMetadata.curationReason = safeCurationText(args.curationReason);
      }
      if (args.curationPriorityReason !== undefined) {
        safeMetadata.curationPriorityReason = safeCurationText(args.curationPriorityReason);
      }

      const parsed = hubCurationMetadataSchema.partial().safeParse(safeMetadata);
      if (!parsed.success) {
        throw unprocessable("Invalid hub curation metadata", parsed.error.flatten());
      }
      const setValues: Record<string, unknown> = {
        curationRevision: parsed.data.curationRevision,
        curatedAt,
        curatedByAgentId: parsed.data.curatedByAgentId,
      };
      if ("curationGroupLabel" in parsed.data) {
        setValues.curationGroupLabel = parsed.data.curationGroupLabel;
      }
      if ("curationGroupSummary" in parsed.data) {
        setValues.curationGroupSummary = parsed.data.curationGroupSummary;
      }
      if ("curationReason" in parsed.data) {
        setValues.curationReason = parsed.data.curationReason;
      }
      if ("curationPriorityReason" in parsed.data) {
        setValues.curationPriorityReason = parsed.data.curationPriorityReason;
      }

      const [row] = await db
        .update(hubItems)
        .set(setValues)
        .where(
          and(
            eq(hubItems.id, args.hubItemId),
            eq(hubItems.companyId, args.companyId),
            eq(hubItems.curationRevision, args.expectedCurationRevision),
          ),
        )
        .returning({
          id: hubItems.id,
          companyId: hubItems.companyId,
          semanticType: hubItems.semanticType,
          status: hubItems.status,
          version: hubItems.version,
          curationRevision: hubItems.curationRevision,
        });

      if (!row) {
        throw conflict("Hub curation metadata changed. Recompute and retry.");
      }

      if (isHubSemanticType(row.semanticType)) {
        publishLiveEvent({
          companyId: row.companyId,
          type: "hub.item.changed",
          payload: {
            itemId: row.id,
            semanticType: row.semanticType,
            lane: laneForSemanticType(row.semanticType),
            status: row.status as HubItemStatus,
            version: row.version,
            change: "updated",
          },
        });
      }

      return row;
    },
  };
}
