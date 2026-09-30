import { createHash, randomUUID } from "node:crypto";
import {
  agentRuntimeDecisions,
  createDb,
  heartbeatRuns,
  hubItems,
} from "../../../packages/db/src/index";

function e2eDatabaseUrl() {
  const explicit =
    process.env.AOA_E2E_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  const port = process.env.AOA_E2E_DB_PORT?.trim() || "54329";
  return `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
}

function hashString(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export async function seedRuntimePermissionDecision(input: {
  companyId: string;
  agentId: string;
  title?: string;
  promptText?: string;
  command?: string;
}) {
  const db = createDb(e2eDatabaseUrl());
  try {
    const client = (db as unknown as {
      $client?: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
    }).$client;
    if (!client) throw new Error("Test DB client is unavailable");

    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        invocationSource: "on_demand",
        status: "running",
        startedAt: new Date(),
        livenessState: "waiting_on_human",
        livenessReason: "runtime_decision",
      })
      .returning();

    const nonce = `e2e-${randomUUID()}`;
    const title = input.title ?? "Allow runtime command?";
    const promptText = input.promptText ?? "The agent wants to run a guarded command.";
    const command = input.command ?? "pnpm test:run";
    const [decision] = await db
      .insert(agentRuntimeDecisions)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        runId: run.id,
        adapterType: "test_bridge",
        kind: "permission",
        status: "created",
        nonce,
        sourceRevision: 0,
        promptHash: hashString(JSON.stringify({ kind: "permission", title, promptText, command })),
        sourceUniqueKey: `runtime:${input.companyId}:${run.id}:${nonce}`,
        title,
        summary: "Waiting for a runtime permission decision.",
        promptText,
        toolName: "shell",
        command,
        cwd: "C:/aoa/e2e",
        riskClass: "medium",
        timeoutPolicy: "deny",
      })
      .returning();

    await client`
      UPDATE heartbeat_runs
      SET next_action = ${`runtime_decision:${decision.id}`}, updated_at = now()
      WHERE id = ${run.id}
    `;

    const [hubItem] = await db
      .insert(hubItems)
      .values({
        companyId: input.companyId,
        userId: "e2e-board",
        type: "agent_runtime_decision",
        title,
        message: "Waiting for a runtime permission decision.",
        semanticType: "agent_runtime_decision",
        sourceType: "runtime_decision",
        sourceId: decision.id,
        sourceUniqueKey: [
          input.companyId,
          "runtime_decision",
          decision.id,
          "agent_runtime_decision",
          "",
        ].join(":"),
        summary: "Waiting for a runtime permission decision.",
        priority: "high",
        relatedEntityType: "heartbeat_run",
        relatedEntityId: run.id,
        sourceActorType: "agent",
        sourceActorId: input.agentId,
        sourcePermissionRevision: "0",
        status: "open",
      })
      .returning();

    return { run, decision, hubItem };
  } finally {
    const client = (db as unknown as { $client?: { end: () => Promise<void> } }).$client;
    await client?.end();
  }
}

export async function markRuntimeDecisionRelayed(input: {
  runId: string;
  decisionId: string;
}) {
  const db = createDb(e2eDatabaseUrl());
  try {
    const client = (db as unknown as {
      $client?: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
    }).$client;
    if (!client) throw new Error("Test DB client is unavailable");

    await client`
      UPDATE agent_runtime_decisions
      SET status = 'relayed', relayed_at = now(), source_revision = 2, updated_at = now()
      WHERE id = ${input.decisionId}
    `;
    await client`
      UPDATE heartbeat_runs
      SET
        status = 'succeeded',
        finished_at = now(),
        liveness_state = null,
        liveness_reason = null,
        next_action = null,
        updated_at = now()
      WHERE id = ${input.runId}
    `;
  } finally {
    const client = (db as unknown as { $client?: { end: () => Promise<void> } }).$client;
    await client?.end();
  }
}
