import { and, asc, eq, ne, or, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import {
  agentWakeupRequests,
  agents,
  aoaAgentTriggers,
  hubItems,
  internalAgentConfig,
} from "@armyofagents/db";
import { logger } from "../../../middleware/logger.js";
import { hubCurationService } from "../../hub-curation.js";

const log = logger.child({ svc: "sweep-steward" });

export const STEWARD_SWEEP_INTERVAL_MS = 2 * 60 * 1000;
export const STEWARD_MAX_ITEMS_PER_COMPANY = 25;
export const STEWARD_MAX_EVIDENCE_PER_WAKEUP = 5;

interface StewardSweepTrigger {
  agentId: string;
  companyId: string;
  config: Record<string, unknown> | null;
}

interface StewardCandidate {
  id: string;
  companyId: string;
  semanticType: string | null;
  sourceType: string | null;
  sourceId: string | null;
  scopeKey: string | null;
  groupKey: string | null;
  ownerUserId: string | null;
  ownerPool: string | null;
  priority: string;
  slaAt: Date | string | null;
  status: string;
  version: number;
  curationRevision: number;
  curationGroupLabel: string | null;
  curationGroupSummary: string | null;
  curatedAt: Date | string | null;
}

interface StewardCurationService {
  deriveForItem: ReturnType<typeof hubCurationService>["deriveForItem"];
  updateSummary: ReturnType<typeof hubCurationService>["updateSummary"];
}

export interface RunStewardSweepResult {
  curated: number;
  queued: number;
}

export async function runStewardSweep(
  db: Db,
  deps: { curationService?: StewardCurationService } = {},
): Promise<RunStewardSweepResult> {
  const allSweepTriggers = await db
    .select({
      agentId: aoaAgentTriggers.agentId,
      companyId: aoaAgentTriggers.companyId,
      config: aoaAgentTriggers.config,
    })
    .from(aoaAgentTriggers)
    .innerJoin(agents, eq(agents.id, aoaAgentTriggers.agentId))
    .where(
      and(
        eq(aoaAgentTriggers.kind, "sweep"),
        eq(aoaAgentTriggers.enabled, true),
        ne(agents.status, "paused"),
        ne(agents.status, "terminated"),
      ),
    );

  const stewardTriggers = (allSweepTriggers as StewardSweepTrigger[]).filter(
    (trigger) => trigger.config?.role === "steward",
  );

  let curated = 0;
  let queued = 0;
  for (const trigger of stewardTriggers) {
    try {
      const result = await queueForCompany(
        db,
        trigger,
        deps.curationService ?? hubCurationService(db),
      );
      curated += result.curated;
      queued += result.queued;
    } catch (err) {
      log.warn({ err, companyId: trigger.companyId }, "sweep-steward: company sweep failed; continuing");
    }
  }

  return { curated, queued };
}

async function queueForCompany(
  db: Db,
  trigger: { agentId: string; companyId: string },
  curationService: StewardCurationService,
): Promise<RunStewardSweepResult> {
  const [companyConfig] = await db
    .select({ crewPaused: internalAgentConfig.crewPaused })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, trigger.companyId))
    .limit(1);

  if (companyConfig?.crewPaused === true) {
    return { curated: 0, queued: 0 };
  }

  const candidates = (await db
    .select({
      id: hubItems.id,
      companyId: hubItems.companyId,
      semanticType: hubItems.semanticType,
      sourceType: hubItems.sourceType,
      sourceId: hubItems.sourceId,
      scopeKey: hubItems.scopeKey,
      groupKey: hubItems.groupKey,
      ownerUserId: hubItems.ownerUserId,
      ownerPool: hubItems.ownerPool,
      priority: hubItems.priority,
      slaAt: hubItems.slaAt,
      status: hubItems.status,
      version: hubItems.version,
      curationRevision: hubItems.curationRevision,
      curationGroupLabel: hubItems.curationGroupLabel,
      curationGroupSummary: hubItems.curationGroupSummary,
      curatedAt: hubItems.curatedAt,
    })
    .from(hubItems)
    .where(
      and(
        eq(hubItems.companyId, trigger.companyId),
        eq(hubItems.status, "open"),
        or(
          isNull(hubItems.curationGroupLabel),
          isNull(hubItems.curatedAt),
          isNull(hubItems.curationGroupSummary),
        ),
      ),
    )
    .orderBy(asc(hubItems.createdAt))
    .limit(STEWARD_MAX_ITEMS_PER_COMPANY)) as StewardCandidate[];

  const groups = new Map<
    string,
    {
      expectedCurationRevision: number;
      evidence: Array<{
        hubItemId: string;
        semanticType: string;
        sourceType: string | null;
        sourceId: string | null;
      }>;
    }
  >();
  let curated = 0;

  for (const item of candidates) {
    const derived = curationService.deriveForItem(item);
    const needsDeterministicUpdate = !item.curationGroupLabel || !item.curatedAt;
    let expectedCurationRevision = item.curationRevision;
    if (needsDeterministicUpdate) {
      const updated = await curationService.updateSummary({
        companyId: item.companyId,
        hubItemId: item.id,
        expectedCurationRevision: item.curationRevision,
        curationGroupLabel: derived.curationGroupLabel,
        curationGroupSummary: item.curationGroupSummary,
        curationReason: derived.curationReason,
        curationPriorityReason: derived.curationPriorityReason,
        curatedByAgentId: null,
      });
      expectedCurationRevision = updated.curationRevision ?? derived.nextCurationRevision;
      curated += 1;
    }

    if (item.curationGroupSummary) continue;
    const group = groups.get(derived.effectiveGroupKey) ?? {
      expectedCurationRevision,
      evidence: [],
    };
    if (group.evidence.length < STEWARD_MAX_EVIDENCE_PER_WAKEUP) {
      group.evidence.push({
        hubItemId: item.id,
        semanticType: item.semanticType ?? "unknown",
        sourceType: item.sourceType,
        sourceId: item.sourceId,
      });
    }
    groups.set(derived.effectiveGroupKey, group);
  }

  let queued = 0;
  for (const [groupKey, group] of groups) {
    if (group.evidence.length === 0) continue;
    await db
      .insert(agentWakeupRequests)
      .values({
        companyId: trigger.companyId,
        agentId: trigger.agentId,
        source: "sweep.steward",
        reason: "hub_curation_summary",
        status: "queued",
        dedupKey: `steward:${trigger.companyId}:group:${groupKey}:queued`,
        payload: {
          role: "steward",
          targetType: "group",
          groupKey,
          companyId: trigger.companyId,
          expectedCurationRevision: group.expectedCurationRevision,
          evidence: group.evidence,
        },
      })
      .onConflictDoNothing();
    queued += 1;
  }

  return { curated, queued };
}
