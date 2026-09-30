import type { Db } from "@armyofagents/db";
import { issueService } from "./issues.js";
import { heartbeatService } from "./heartbeat.js";
import { resolveCrewRole } from "./internal-agent/aoa-agents/resolve-crew-role.js";
import { logger } from "../middleware/logger.js";
export interface AssigneeWakeupInput {
  companyId: string; agentId: string; issueId: string;
  source: "assignment" | "automation"; reason: string; mutation?: string;
  extraPayload?: Record<string, unknown>;
  requestedByActorType?: "user" | "agent" | "system"; requestedByActorId?: string | null;
}
export async function enqueueIssueAssigneeWakeup(db: Db, input: AssigneeWakeupInput): Promise<void> {
  const issuesSvc = issueService(db);
  const kinds = await issuesSvc.resolveAgentKinds([input.agentId]);
  const isAoa = kinds.get(input.agentId) === "aoa";
  const basePayload: Record<string, unknown> = {
    issueId: input.issueId,
    ...(input.mutation ? { mutation: input.mutation } : {}),
    ...(input.extraPayload ?? {}),
  };
  if (isAoa) {
    const role = await resolveCrewRole(db, input.agentId);
    // L3: best-effort, symmetric with the org `heartbeat.wakeup` branch below.
    // The caller awaits this post-commit (after the DB write committed), so a
    // crew enqueue failure must not throw and unwind a committed mutation —
    // log + swallow, exactly as the org branch does.
    await issuesSvc
      .enqueueAoaMentionWakeup(input.companyId, input.agentId, {
        source: input.source, reason: input.reason,
        payload: role ? { ...basePayload, role } : basePayload,
      })
      .catch((err) => logger.warn({ err, issueId: input.issueId, agentId: input.agentId }, "failed to wake crew assignee"));
    return;
  }
  await heartbeatService(db)
    .wakeup(input.agentId, {
      source: input.source, triggerDetail: "system", reason: input.reason,
      payload: basePayload,
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issueId, source: input.reason },
    })
    .catch((err) => logger.warn({ err, issueId: input.issueId, agentId: input.agentId }, "failed to wake org assignee"));
}
