import { and, eq } from "drizzle-orm";
import {
  activityLog,
  authUsers,
  companyMemberships,
  costEvents,
  createDb,
  internalAgentReminders,
  notifications,
} from "@armyofagents/db";
import { hubItemsService } from "../services/hub-items.js";

const apiBase = process.env.AOA_API_BASE ?? "http://127.0.0.1:3100/api";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
const companyId = process.env.COMMANDER_SEED_COMPANY_ID;

if (!companyId) {
  throw new Error("Set COMMANDER_SEED_COMPANY_ID to the isolated review company id.");
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return await response.json() as T;
}

async function findOrCreateTask(
  title: string,
  input: Record<string, unknown>,
): Promise<{ id: string; title: string }> {
  const tasks = await api<Array<{ id: string; title: string }>>(`/companies/${companyId}/issues?taskScope=all`);
  const existing = tasks.find((task) => task.title === title);
  if (existing) return existing;
  return api(`/companies/${companyId}/issues`, {
    method: "POST",
    body: JSON.stringify({ title, ...input }),
  });
}

const now = new Date();
const db = createDb(databaseUrl);
const managedHumanId = "commander-review-human";

await db.insert(authUsers).values({
  id: managedHumanId,
  name: "Priya Review",
  displayName: "Priya Review",
  email: "priya.commander-review@local.test",
  emailVerified: true,
  createdAt: now,
  updatedAt: now,
}).onConflictDoNothing();
await db.insert(companyMemberships).values({
  companyId,
  principalType: "user",
  principalId: managedHumanId,
  status: "active",
  membershipRole: "team_member",
  parentType: "user",
  parentId: "local-board",
}).onConflictDoNothing();

const agents = await api<Array<{ id: string; name: string }>>(`/companies/${companyId}/agents`);
const atlas = agents.find((agent) => agent.name === "Atlas");
if (!atlas) throw new Error("Commander review company needs the Atlas agent.");
await api(`/agents/${atlas.id}`, {
  method: "PATCH",
  body: JSON.stringify({
    parentType: "user",
    parentId: managedHumanId,
  }),
});

const dueToday = new Date(now.getTime() + 2 * 60 * 60 * 1000);
const dueTask = await findOrCreateTask("Today: validate Commander full-spectrum data", {
  description: "Real due-today task for Commander coverage.",
  status: "todo",
  priority: "high",
  assigneeUserId: "local-board",
  dueDate: dueToday.toISOString(),
});
const managedHumanTask = await findOrCreateTask("Managed human: prepare launch checklist", {
  description: "Reports through Priya and must appear in Active Work > Managed.",
  status: "in_progress",
  priority: "high",
  assigneeUserId: managedHumanId,
  responsibleUserId: managedHumanId,
});
const managedAgentTask = await findOrCreateTask("Managed agent: verify deployment evidence", {
  description: "Assigned to Atlas under Priya and must appear in Active Work > Managed.",
  status: "blocked",
  priority: "critical",
  assigneeAgentId: atlas.id,
  responsibleUserId: managedHumanId,
});
await findOrCreateTask("Managed human: confirm support handoff", {
  description: "Additional managed work keeps the cockpit card bounded and exercises View all.",
  status: "todo",
  priority: "medium",
  assigneeUserId: managedHumanId,
  responsibleUserId: managedHumanId,
});
await findOrCreateTask("Managed human: archive launch evidence", {
  description: "Lower-ranked managed work belongs in the paginated Active Work queue.",
  status: "backlog",
  priority: "low",
  assigneeUserId: managedHumanId,
  responsibleUserId: managedHumanId,
});
const explicitReviewTask = await findOrCreateTask("Your review: approve Commander interaction contract", {
  description: "Explicit reviewer placement must rank first in Awaiting Review.",
  status: "in_review",
  priority: "high",
  reviewerUserId: "local-board",
});
const teamReviewTask = await findOrCreateTask("Team review: validate managed execution", {
  description: "Hierarchy review work must move out of Active Work.",
  status: "in_review",
  priority: "medium",
  assigneeUserId: managedHumanId,
  responsibleUserId: managedHumanId,
});
await findOrCreateTask("Completed: Commander source audit", {
  description: "A real completed task for the Done today card.",
  status: "done",
  priority: "medium",
  assigneeUserId: "local-board",
});

const goals = await api<Array<{ id: string; title: string }>>(`/companies/${companyId}/goals`);
let goal = goals.find((item) => item.title === "Commander launch readiness");
if (!goal) {
  goal = await api(`/companies/${companyId}/goals`, {
    method: "POST",
    body: JSON.stringify({
      title: "Commander launch readiness",
      description: "At risk until every cockpit source and interaction is verified.",
      level: "company",
      status: "at_risk",
    }),
  });
}
if (!goal) throw new Error("Failed to resolve the Commander review goal.");

const artifacts = await api<Array<{ id: string; title: string }>>(`/companies/${companyId}/artifacts`);
let artifact = artifacts.find((item) => item.title === "Commander full-spectrum evidence");
if (!artifact) {
  artifact = await api(`/companies/${companyId}/artifacts`, {
    method: "POST",
    body: JSON.stringify({
      title: "Commander full-spectrum evidence",
      type: "document",
      source: "founder",
      content: "# Commander evidence\n\nTask, discussion, inbox, approval, watch, notes, and context coverage.",
    }),
  });
}
if (!artifact) throw new Error("Failed to resolve the Commander review artifact.");

for (const pin of [
  { entityType: "task", entityId: dueTask.id },
  { entityType: "goal", entityId: goal.id },
  { entityType: "artifact", entityId: artifact.id },
]) {
  await api(`/companies/${companyId}/pins`, {
    method: "POST",
    body: JSON.stringify(pin),
  });
}

const approvals = await api<Array<{ id: string; type: string; payload?: Record<string, unknown> }>>(
  `/companies/${companyId}/approvals?status=pending`,
);
if (!approvals.some((item) => item.type === "approve_ceo_strategy" && item.payload?.seed === "commander-review")) {
  await api(`/companies/${companyId}/approvals`, {
    method: "POST",
    body: JSON.stringify({
      type: "approve_ceo_strategy",
      payload: {
        seed: "commander-review",
        title: "Approve Commander full-spectrum behavior",
        summary: "Verify entity-specific surfaces and all cockpit source categories.",
      },
      issueIds: [dueTask.id],
    }),
  });
}

await api(`/companies/${companyId}/budgets`, {
  method: "PATCH",
  body: JSON.stringify({ budgetMonthlyCents: 100_000 }),
});

const existingCost = await db
  .select({ id: costEvents.id })
  .from(costEvents)
  .where(and(eq(costEvents.companyId, companyId), eq(costEvents.billingCode, "commander-review-seed")))
  .limit(1);
if (existingCost.length === 0) {
  await api(`/companies/${companyId}/cost-events`, {
    method: "POST",
    body: JSON.stringify({
      agentId: atlas.id,
      issueId: dueTask.id,
      billingCode: "commander-review-seed",
      provider: "local",
      model: "process",
      inputTokens: 1200,
      outputTokens: 400,
      costCents: 42_000,
      occurredAt: now.toISOString(),
    }),
  });
}

const reminderContent = "Review Commander cockpit results before end of day";
const existingReminder = await db
  .select({ id: internalAgentReminders.id })
  .from(internalAgentReminders)
  .where(and(
    eq(internalAgentReminders.companyId, companyId),
    eq(internalAgentReminders.userId, "local-board"),
    eq(internalAgentReminders.content, reminderContent),
  ))
  .limit(1);
if (existingReminder.length === 0) {
  await db.insert(internalAgentReminders).values({
    companyId,
    userId: "local-board",
    content: reminderContent,
    triggerAt: dueToday,
    relatedEntityType: "task",
    relatedEntityId: dueTask.id,
  });
}

const proactiveTitle = "Commander source audit needs attention";
const existingProactive = await db
  .select({ id: notifications.id })
  .from(notifications)
  .where(and(
    eq(notifications.companyId, companyId),
    eq(notifications.userId, "local-board"),
    eq(notifications.title, proactiveTitle),
  ))
  .limit(1);
if (existingProactive.length === 0) {
  await hubItemsService(db).emit({
    companyId,
    ownerUserId: "local-board",
    legacyType: "internal_agent.proactive",
    semanticType: "proactive",
    title: proactiveTitle,
    summary: "Validate the dedicated Discussion pane and task slide-over.",
    relatedEntityType: "task",
    relatedEntityId: dueTask.id,
    sourceType: "commander_review_seed",
    sourceId: dueTask.id,
  });
}

const teammateAction = "commander.review_completed";
const existingActivity = await db
  .select({ id: activityLog.id })
  .from(activityLog)
  .where(and(
    eq(activityLog.companyId, companyId),
    eq(activityLog.actorId, "teammate-reviewer"),
    eq(activityLog.action, teammateAction),
  ))
  .limit(1);
if (existingActivity.length === 0) {
  await db.insert(activityLog).values({
    companyId,
    actorType: "user",
    actorId: "teammate-reviewer",
    action: teammateAction,
    entityType: "issue",
    entityId: dueTask.id,
    details: { title: dueTask.title },
  });
}

await api(`/agents/${atlas.id}`, {
  method: "PATCH",
  body: JSON.stringify({
    adapterType: "process",
    parentType: "user",
    parentId: managedHumanId,
    adapterConfig: process.platform === "win32"
      ? { command: "powershell.exe", args: ["-NoProfile", "-Command", "Start-Sleep", "-Seconds", "600"] }
      : { command: "sleep", args: ["600"] },
  }),
});

const activeRuns = await api<Array<{ agentId: string; status: string }>>(`/companies/${companyId}/live-runs`);
if (!activeRuns.some((run) => run.agentId === atlas.id)) {
  await api(`/agents/${atlas.id}/wakeup`, {
    method: "POST",
    body: JSON.stringify({
      source: "on_demand",
      triggerDetail: "manual",
      reason: "Commander full-spectrum review",
      payload: { issueId: dueTask.id },
    }),
  });
}

const cockpit = await api<Record<string, unknown>>(`/companies/${companyId}/cockpit`);
console.log(JSON.stringify({
  companyId,
  dueTask,
  managedHumanTask,
  managedAgentTask,
  explicitReviewTask,
  teamReviewTask,
  goal,
  artifact,
  cockpit,
}, null, 2));
process.exit(0);
