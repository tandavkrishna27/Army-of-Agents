import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, authUsers, companies, companyMemberships, createDb, applyPendingMigrations, organizations, projects, type Db } from "@armyofagents/db";
import { companyPortabilityService } from "../services/company-portability.js";
import { companyService } from "../services/companies.js";
import { accessService } from "../services/access.js";
import { claimCompanyImport } from "../services/company-import-operations.js";
import { companyPortabilityImportSchema, companyPortabilityPreviewSchema } from "@armyofagents/shared";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

// Only the bootstrap's catalog/network boundary is replaced. Import services,
// founder writes, triggers, local encryption, and PostgreSQL run for real.
vi.mock("../services/crew-provisioning.js", () => ({ provisionCompanyCrew: vi.fn(async () => undefined) }));

const owner = `import-owner-${randomUUID()}`;
const org = randomUUID();
let db: Db;
let dir: string;
let pg: { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };

function request(operationId = randomUUID()): any {
  const prefix = operationId.replaceAll("-", "").slice(0, 3).split("")
    .map((digit) => String.fromCharCode(65 + Number.parseInt(digit, 16))).join("");
  return {
    operationId,
    target: { mode: "new_company", newCompanyName: `${prefix} Import ${operationId}` },
    include: { company: true, agents: true, projects: true, issues: true, skills: true, routines: true,
      envInputs: true, internalAgentConfig: true, budgetPolicies: true, costEvents: true,
      financeEvents: true, quotaWindows: true, workflowTemplates: true },
    source: {
      type: "inline",
      files: { "COMPANY.md": "Company", "worker.md": "---\nkind: agent\n---\nWorker prompt", "skill.md": "# Skill" },
      manifest: {
        schemaVersion: 2, generatedAt: "2026-10-06T00:00:00.000Z", source: null,
        includes: { company: true, agents: true }, requiredSecrets: [],
        company: { path: "COMPANY.md", name: "Source", description: null, brandColor: null, requireBoardApprovalForNewAgents: true },
        agents: [{ slug: "worker", name: "Import Worker", path: "worker.md", role: "engineer", title: null, icon: null,
          capabilities: null, reportsToSlug: null, adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
          budgetMonthlyCents: 0, metadata: null, skillKeys: ["import/test-skill"] }],
        projects: [{ slug: "project", name: "Import Project", type: "project" }],
        issues: [{ slug: "task", title: "Imported Task", projectSlug: "project", assigneeAgentSlug: "worker" }],
        skills: [{ key: "import/test-skill", slug: "import-skill", name: "Import Skill", path: "skill.md", sourceType: "url" }],
        routines: [{ slug: "routine", title: "Imported Routine", status: "paused", priority: "medium", projectSlug: "project",
          assigneeAgentSlug: "worker", concurrencyPolicy: "coalesce_if_active", catchUpPolicy: "skip_missed", variables: [],
          triggers: [{ kind: "api", label: null, enabled: true }, { kind: "schedule", label: null, enabled: true, cronExpression: "0 0 * * *", timezone: "UTC" },
            { kind: "webhook", label: null, enabled: true, signingMode: "hmac_sha256", replayWindowSec: 300 }] }],
        envInputs: [],
        internalAgentConfig: { executionMode: "cli", autonomyLevel: 0, notificationPreference: "all", contextTokenBudget: 1000, proactiveIntervalMinutes: 30 },
        budgetPolicies: [{ slug: "budget", scopeType: "company", metric: "cost_cents", windowKind: "month", amountCents: 100,
          warnPercent: 80, hardStopEnabled: true, notifyEnabled: true, isActive: true }],
        costEvents: [{ slug: "cost", agentSlug: "worker", issueSlug: "task", projectSlug: "project", goalSlug: null,
          occurredAt: "2026-10-06T00:00:00Z", provider: "test", model: null, biller: null, billingType: null, billingCode: null,
          inputTokens: 1, outputTokens: 1, costCents: 1 }],
        financeEvents: [{ slug: "finance", agentSlug: "worker", issueSlug: "task", projectSlug: "project", goalSlug: null, costEventSlug: "cost",
          occurredAt: "2026-10-06T00:00:00Z", eventKind: "charge", direction: "debit", biller: "test", provider: null,
          executionAdapterType: null, pricingTier: null, region: null, model: null, quantity: null, unit: null, amountCents: 1,
          currency: "USD", estimated: true, externalInvoiceId: null, billingCode: null, description: null }],
        quotaWindows: [{ slug: "quota", provider: "test", model: null, windowKind: "month", label: null, limitValue: 100,
          usedValue: 1, usedPercent: 1, valueLabel: null, resetAt: null, lastUpdatedAt: "2026-10-06T00:00:00Z" }],
        workflowTemplates: [{ slug: "workflow", name: "Imported Workflow", description: null, workspaceMode: "shared", steps: [], dependencies: [] }],
      },
    },
  };
}

async function operations() {
  return await db.execute(sql`select * from company_import_operations`);
}

async function counts(companyId: string) {
  const tables = ["agents", "projects", "issues", "company_skills", "routines", "routine_triggers", "company_secrets",
    "budget_policies", "cost_events", "finance_events", "provider_quota_windows", "workflow_templates"];
  return Promise.all(tables.map(async (table) => {
    const rows = await db.execute(sql`select count(*)::int as count from ${sql.identifier(table)} where company_id = ${companyId}
      ${table === "agents" ? sql`and kind = 'org'` : sql``}`);
    return [table, rows[0]!.count];
  }));
}

// Faults are database triggers, below the real services and their transactions.
async function failInsert(table: string, input: ReturnType<typeof request>, body = "RAISE EXCEPTION 'synthetic import fault';") {
  const name = `fault_${randomUUID().replaceAll("-", "")}`;
  await db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF EXISTS (SELECT 1 FROM companies WHERE id = NEW.company_id AND name = '${input.target.newCompanyName}')
      ${table === "agents" ? "AND NEW.kind = 'org'" : ""} THEN ${body} END IF; RETURN NEW; END $$`));
  await db.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE INSERT ${table === "internal_agent_config" ? "OR UPDATE" : ""} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`));
  return async () => {
    await db.execute(sql.raw(`DROP TRIGGER ${name} ON ${table}`));
    await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
  };
}

async function operation(input: ReturnType<typeof request>) {
  return (await operations()).find((row) => row.operation_id === input.operationId);
}

describe.skipIf(process.platform !== "linux")("new company import recovery (real PostgreSQL)", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "aoa-import-resume-"));
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({ databaseDir: join(dir, "pg"), user: "test", password: "test", port,
      persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
    await pg.initialise(); await pg.start();
    const url = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(url);
    db = createDb(url);
    await db.insert(organizations).values({ id: org, name: "Import Org", slug: `import-${org}` });
    await db.insert(authUsers).values({ id: owner, name: "Importer", email: `${owner}@example.test`, createdAt: new Date(), updatedAt: new Date() });
  }, 180_000);

  afterAll(async () => {
    if (pg) await pg.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 60_000);

  it("returns stable operation/company IDs and completes readiness atomically; replay duplicates nothing", async () => {
    const input = request();
    const svc = companyPortabilityService(db);
    const first = await svc.importBundle(input, owner, undefined, { organizationId: org });
    expect(first).toHaveProperty("operation.id", input.operationId);
    const before = await counts(first.company.id);
    const replay = await svc.importBundle(input, owner, undefined, { organizationId: org });
    expect(replay.company.id).toBe(first.company.id);
    expect(await counts(first.company.id)).toEqual(before);
    expect(before).toContainEqual(["routine_triggers", 3]);
    const [company] = await db.select().from(companies).where(eq(companies.id, first.company.id));
    expect(company.agentExecutionSetupState).toBe("ready");
    expect((await operations()).find((row) => row.company_id === company.id)).toMatchObject({ status: "completed" });
  });

  it("rejects changed content/options for the same operation without mutating the workspace", async () => {
    const input = request();
    const svc = companyPortabilityService(db);
    const first = await svc.importBundle(input, owner, undefined, { organizationId: org });
    const before = await counts(first.company.id);
    input.source.files["worker.md"] += " changed";
    await expect(svc.importBundle(input, owner, undefined, { organizationId: org })).rejects.toMatchObject({ status: 409 });
    expect(await counts(first.company.id)).toEqual(before);
  });

  it.each(["agents", "projects", "issues", "company_skills", "routine_triggers", "internal_agent_config",
    "budget_policies", "cost_events", "finance_events", "provider_quota_windows", "workflow_templates"])(
    "recovers after a %s write failure without duplicating completed checkpoints", async (table) => {
      const input = request();
      const removeFault = await failInsert(table, input);
      const svc = companyPortabilityService(db);
      try {
        await expect(svc.importBundle(input, owner, undefined, { organizationId: org })).rejects.toMatchObject({
          status: 409, details: { code: "import_failed", operationId: input.operationId },
        });
      } finally { await removeFault(); }
      const failed = await operation(input);
      expect(failed).toMatchObject({ status: "failed" });
      const [pending] = await db.select().from(companies).where(eq(companies.id, failed!.company_id as string));
      expect(pending.agentExecutionSetupState).toBe("pending");
      expect(await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, pending.id))).toContainEqual(
        expect.objectContaining({ principalId: owner, membershipRole: "owner" }));
      const priorAgents = await db.select().from(agents).where(eq(agents.companyId, pending.id));
      const resumed = await svc.importBundle(input, owner, undefined, { organizationId: org });
      expect(resumed.company.id).toBe(pending.id);
      const finalCounts = await counts(pending.id);
      for (const [name, count] of finalCounts) expect(count, String(name)).toBe(name === "routine_triggers" ? 3 : 1);
      for (const prior of priorAgents.filter((agent) => agent.kind === "org"))
        expect(resumed.agents.some((agent) => agent.id === prior.id)).toBe(true);
      expect(await operation(input)).toMatchObject({ status: "completed" });
      expect((await db.select().from(companies).where(eq(companies.id, pending.id)))[0].agentExecutionSetupState).toBe("ready");
    }, 30_000);

  it("returns busy for a concurrent live claim and creates only one workspace", async () => {
    const input = request();
    const removeFault = await failInsert("agents", input, "PERFORM pg_sleep(1);");
    const svc = companyPortabilityService(db);
    const first = svc.importBundle(input, owner, undefined, { organizationId: org });
    // Wait on the durable state, not an assumed service timing.
    let running = false;
    for (let i = 0; i < 150; i++) {
      try { running = (await operation(input))?.status === "running"; } catch { /* pre-migration RED */ }
      if (running) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    try {
      await expect(svc.importBundle(input, owner, undefined, { organizationId: org })).rejects.toMatchObject({
        status: 409, details: { code: "import_busy", operationId: input.operationId },
      });
      const result = await first;
      expect((await operations()).filter((row) => row.operation_id === input.operationId)).toHaveLength(1);
      expect((await db.select().from(companies).where(eq(companies.name, input.target.newCompanyName)))).toHaveLength(1);
      expect(await operation(input)).toMatchObject({ company_id: result.company.id, status: "completed" });
    } finally { await first.catch(() => undefined); await removeFault(); }
  });

  it("reclaims an expired claim and preserves IDs from completed sections", async () => {
    const input = request();
    const removeFault = await failInsert("budget_policies", input);
    const svc = companyPortabilityService(db);
    await svc.importBundle(input, owner, undefined, { organizationId: org }).catch(() => undefined);
    await removeFault();
    const failed = await operation(input);
    expect(failed).toBeDefined();
    const before = await counts(failed!.company_id as string);
    await db.execute(sql`UPDATE company_import_operations SET status = 'running', claim_token = ${randomUUID()},
      lease_until = clock_timestamp() - interval '1 second' WHERE company_id = ${failed!.company_id}`);
    const resumed = await svc.importBundle(input, owner, undefined, { organizationId: org });
    expect(resumed.company.id).toBe(failed!.company_id);
    for (const [name, count] of before.filter(([, count]) => Number(count) > 0))
      expect(await counts(resumed.company.id)).toContainEqual([name, count]);
    expect(await operation(input)).toMatchObject({ status: "completed", claim_token: null, lease_until: null });
  });

  it("rolls back item effects when the lease expires before checkpoint commit", async () => {
    const input = request();
    const removeFault = await failInsert("agents", input,
      "UPDATE company_import_operations SET lease_until = clock_timestamp() - interval '1 second' WHERE company_id = NEW.company_id;");
    try {
      await expect(companyPortabilityService(db).importBundle(input, owner, undefined, { organizationId: org })).rejects.toMatchObject({ status: 409 });
      const row = await operation(input);
      expect(row).toBeDefined();
      expect(await counts(row!.company_id as string)).toContainEqual(["agents", 0]);
      expect((await db.select().from(companies).where(eq(companies.id, row!.company_id as string)))[0].agentExecutionSetupState).toBe("pending");
    } finally { await removeFault(); }
  });

  it("rolls back completion and readiness together when readiness cannot persist", async () => {
    const input = request();
    const name = `ready_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.name = '${input.target.newCompanyName}' AND NEW.agent_execution_setup_state = 'ready'
      THEN RAISE EXCEPTION 'synthetic ready failure'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION ${name}()`));
    const svc = companyPortabilityService(db);
    try { await expect(svc.importBundle(input, owner, undefined, { organizationId: org })).rejects.toMatchObject({ status: 409 }); }
    finally {
      await db.execute(sql.raw(`DROP TRIGGER ${name} ON companies`));
      await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
    }
    const row = await operation(input);
    expect(row).toMatchObject({ status: "failed" });
    expect((await db.select().from(companies).where(eq(companies.id, row!.company_id as string)))[0].agentExecutionSetupState).toBe("pending");
    await svc.importBundle(input, owner, undefined, { organizationId: org });
    expect(await operation(input)).toMatchObject({ status: "completed" });
    expect(await counts(row!.company_id as string)).toContainEqual(["routine_triggers", 3]);
  });

  it("binds normalized options and actor, and journals no source or secret plaintext", async () => {
    const input = request();
    input.source.files["worker.md"] += "\nsynthetic-secret-sentinel";
    const svc = companyPortabilityService(db);
    const first = await svc.importBundle(input, owner, undefined, { organizationId: org });
    expect(JSON.stringify(await operation(input))).not.toContain("synthetic-secret-sentinel");
    await expect(svc.importBundle({ ...input, include: { ...input.include, skills: false } }, owner, undefined, { organizationId: org }))
      .rejects.toMatchObject({ status: 409 });
    await expect(svc.importBundle(input, "other-user", undefined, { organizationId: org })).rejects.toMatchObject({ status: 409 });
    expect((await svc.importBundle({ ...input, collisionStrategy: "rename", agents: "all" }, owner, undefined,
      { organizationId: org })).company.id).toBe(first.company.id);
  });

  it("requires a caller ID before any new-company effects, but permits previews and existing imports without one", async () => {
    const input = request();
    delete input.operationId;
    expect(companyPortabilityImportSchema.safeParse(input).success).toBe(false);
    expect(companyPortabilityPreviewSchema.safeParse(input).success).toBe(true);
    expect(companyPortabilityImportSchema.safeParse({ ...input,
      target: { mode: "existing_company", companyId: randomUUID() } }).success).toBe(true);
    const before = (await operations()).length;
    await expect(companyPortabilityService(db).importBundle(input, owner, undefined, { organizationId: org }))
      .rejects.toMatchObject({ status: 400 });
    expect((await operations()).length).toBe(before);
  });

  it.each(["company_import_operations", "company_memberships"])(
    "rolls company, founder and operation back together on %s failure", async (table) => {
      const input = request();
      const removeFault = await failInsert(table, input);
      try {
        await expect(companyPortabilityService(db).importBundle(input, owner, undefined, { organizationId: org }))
          .rejects.toMatchObject({ status: 409, details: { code: "import_failed", operationId: input.operationId } });
      } finally { await removeFault(); }
      expect(await operation(input)).toBeUndefined();
      expect(await db.select().from(companies).where(eq(companies.name, input.target.newCompanyName))).toHaveLength(0);
      const result = await companyPortabilityService(db).importBundle(input, owner, undefined, { organizationId: org });
      expect(await operation(input)).toMatchObject({ status: "completed", company_id: result.company.id });
    });

  it("a stale worker cannot checkpoint, complete or fail a reclaimed operation", async () => {
    const identity = { operationId: randomUUID(), fingerprint: "synthetic-digest", actorUserId: owner,
      company: { name: `Stale ${randomUUID()}`, organizationId: org } };
    const first = await claimCompanyImport(db, identity);
    await first.checkpoint("first", async (tx) => {
      await tx.update(companies).set({ description: "first" }).where(eq(companies.id, first.company.id));
      return [];
    });
    await db.execute(sql`UPDATE company_import_operations SET lease_until = clock_timestamp() - interval '1 second'
      WHERE operation_id = ${identity.operationId}`);
    const second = await claimCompanyImport(db, identity);
    const before = await operation(identity);
    await expect(first.checkpoint("stale", async (tx) => {
      await tx.update(companies).set({ description: "stale" }).where(eq(companies.id, first.company.id));
      return [];
    })).rejects.toMatchObject({ status: 409, details: { code: "import_busy" } });
    await expect(first.checkpoint("first", async () => [])).rejects.toMatchObject({ status: 409 });
    await expect(first.complete()).rejects.toMatchObject({ status: 409 });
    await first.fail();
    expect(await operation(identity)).toEqual(before);
    expect((await db.select().from(companies).where(eq(companies.id, first.company.id)))[0])
      .toMatchObject({ description: "first", agentExecutionSetupState: "pending" });
    await second.complete();
    expect(await operation(identity)).toMatchObject({ status: "completed" });
  });

  it.each(["agents:", "projects:", "issues:", "skills:", "routines:", "triggers:",
    "internalAgentConfig", "budgetPolicies", "cost-events:", "finance-events:", "quotaWindows", "workflowTemplates"])(
    "rejects a missing checkpoint target in %s without creating replacement rows", async (prefix) => {
      const input = request();
      const svc = companyPortabilityService(db);
      const first = await svc.importBundle(input, owner, undefined, { organizationId: org });
      const row = await operation(input);
      const checkpoints = row!.checkpoints as Record<string, { id: string | null; action: string }[]>;
      const key = Object.keys(checkpoints).find((key) => key.startsWith(prefix))!;
      expect(key).toBeDefined();
      expect(checkpoints[key].length).toBeGreaterThan(0);
      checkpoints[key][0].id = randomUUID();
      await db.execute(sql`UPDATE company_import_operations SET checkpoints = ${JSON.stringify(checkpoints)}::jsonb
        WHERE operation_id = ${input.operationId}`);
      const before = await counts(first.company.id);
      await expect(svc.importBundle(input, owner, undefined, { organizationId: org })).rejects.toMatchObject({
        status: 409, details: { code: "import_conflict", companyId: first.company.id, operationId: input.operationId },
      });
      expect(await counts(first.company.id)).toEqual(before);
      expect(await operation(input)).toMatchObject({ status: "completed" });
    });

  it("validates webhook secret versions on replay", async () => {
    const input = request();
    const svc = companyPortabilityService(db);
    const first = await svc.importBundle(input, owner, undefined, { organizationId: org });
    await db.execute(sql`delete from company_secret_versions where secret_id in
      (select secret_id from routine_triggers where company_id = ${first.company.id} and kind = 'webhook')`);
    await expect(svc.importBundle(input, owner, undefined, { organizationId: org }))
      .rejects.toMatchObject({ status: 409, details: { code: "import_conflict" } });
    expect(await counts(first.company.id)).toContainEqual(["routine_triggers", 3]);
  });

  it.each(["pending", "ready"] as const)("existing-company imports preserve %s readiness", async (state) => {
    const input = request();
    const svc = companyPortabilityService(db);
    // A separate existing company with its own real founder avoids importing
    // twice into the already-populated new-company recovery fixture.
    const { company } = await companyService(db).createWithOperator({
      name: `Existing ${state} ${randomUUID()}`, organizationId: org,
    }, { requestedByUserId: owner }, owner, (tx) => accessService(tx));
    await db.update(companies).set({ agentExecutionSetupState: state }).where(eq(companies.id, company.id));
    const existing = { ...input, operationId: undefined, target: { mode: "existing_company", companyId: company.id },
      collisionStrategy: "skip" };
    const result = await svc.importBundle(existing, owner);
    expect(result.operation).toBeUndefined();
    expect(result.agents).toHaveLength(1);
    expect(await counts(company.id)).toContainEqual(["routine_triggers", 3]);
    expect(await operation(input)).toBeUndefined();
    expect((await db.select().from(companies).where(eq(companies.id, company.id)))[0].agentExecutionSetupState).toBe(state);
  });

  it("reconstructs warnings, env inputs and all relationship mappings after a transient failure", async () => {
    const input = request();
    input.source.manifest.envInputs = [
      { key: "IMPORT_PLAIN", agentSlug: "worker", projectSlug: null, description: null, requirement: "optional",
        kind: "plain", defaultValue: "synthetic-env", portability: "system_dependent" },
      { key: "IMPORT_SECRET", agentSlug: "worker", projectSlug: null, description: null, requirement: "required",
        kind: "secret", defaultValue: null, portability: "portable" },
    ];
    input.source.manifest.budgetPolicies.push({ ...input.source.manifest.budgetPolicies[0],
      slug: "missing-budget", scopeType: "agent", scopeAgentSlug: "missing" });
    const fault = await failInsert("finance_events", input);
    const svc = companyPortabilityService(db);
    try { await expect(svc.importBundle(input, owner, undefined, { organizationId: org })).rejects.toMatchObject({ status: 409 }); }
    finally { await fault(); }
    const resumed = await svc.importBundle(input, owner, undefined, { organizationId: org });
    const replay = await svc.importBundle(input, owner, undefined, { organizationId: org });
    expect(replay).toEqual(resumed);
    expect(replay.warnings).toContainEqual(expect.objectContaining({ section: "quotaWindows" }));
    expect(replay.warnings).toContainEqual(expect.objectContaining({ message: expect.stringContaining("missing-budget") }));
    expect(replay.requiredSecrets).toContainEqual(expect.objectContaining({ key: "IMPORT_SECRET", agentSlug: "worker" }));
    const agentId = resumed.agents[0].id!;
    const projectId = resumed.projects[0].id!;
    const issueId = resumed.issues[0].id!;
    expect((await db.select().from(agents).where(eq(agents.id, agentId)))[0].adapterConfig.env)
      .toMatchObject({ IMPORT_PLAIN: { type: "plain", value: "synthetic-env" } });
    const costs = await db.execute(sql`select * from cost_events where company_id = ${resumed.company.id}`);
    expect(costs[0]).toMatchObject({ agent_id: agentId, project_id: projectId, issue_id: issueId });
    expect((await db.execute(sql`select * from finance_events where company_id = ${resumed.company.id}`))[0])
      .toMatchObject({ agent_id: agentId, project_id: projectId, issue_id: issueId, cost_event_id: costs[0].id });
    expect(JSON.stringify(await operation(input))).not.toContain("synthetic-env");
  });

  it("masks secret-bearing service errors and commits neither effects nor checkpoints on journal failure", async () => {
    const input = request();
    const name = `checkpoint_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.operation_id = '${input.operationId}' AND NEW.checkpoints ? 'agents:0'
        THEN RAISE EXCEPTION 'synthetic-secret-sentinel'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${name} BEFORE UPDATE ON company_import_operations
      FOR EACH ROW EXECUTE FUNCTION ${name}()`));
    let error: unknown;
    try { await companyPortabilityService(db).importBundle(input, owner, undefined, { organizationId: org }); }
    catch (err) { error = err; }
    finally {
      await db.execute(sql.raw(`DROP TRIGGER ${name} ON company_import_operations`));
      await db.execute(sql.raw(`DROP FUNCTION ${name}()`));
    }
    expect(error).toMatchObject({ status: 409, details: { code: "import_failed", resumable: true } });
    expect(String(error)).not.toContain("synthetic-secret-sentinel");
    const failed = await operation(input);
    expect(failed).toMatchObject({ status: "failed", checkpoints: {} });
    expect(JSON.stringify(failed)).not.toContain("synthetic-secret-sentinel");
    expect(await counts(failed!.company_id as string)).toContainEqual(["agents", 0]);
    await companyPortabilityService(db).importBundle(input, owner, undefined, { organizationId: org });
    expect(await operation(input)).toMatchObject({ status: "completed" });
  });

  it("preserves cost/finance batch IDs and source links when the second batch fails", async () => {
    const input = request();
    input.source.manifest.costEvents = Array.from({ length: 1001 }, (_, index) => ({
      ...input.source.manifest.costEvents[0], slug: `cost-${index}`, billingCode: `cost-${index}`,
    }));
    input.source.manifest.financeEvents = Array.from({ length: 1001 }, (_, index) => ({
      ...input.source.manifest.financeEvents[0], slug: `finance-${index}`, costEventSlug: `cost-${index}`,
      billingCode: `cost-${index}`,
    }));
    const removeFault = await failInsert("finance_events", input,
      "IF NEW.billing_code = 'cost-1000' THEN RAISE EXCEPTION 'synthetic batch fault'; END IF;");
    const svc = companyPortabilityService(db);
    try { await expect(svc.importBundle(input, owner, undefined, { organizationId: org })).rejects.toMatchObject({ status: 409 }); }
    finally { await removeFault(); }
    const failed = await operation(input);
    const before = await db.execute(sql`select id from finance_events where company_id = ${failed!.company_id}`);
    expect(before).toHaveLength(1000);
    const resumed = await svc.importBundle(input, owner, undefined, { organizationId: org });
    expect(resumed.company.id).toBe(failed!.company_id);
    expect(await db.execute(sql`select id from finance_events where company_id = ${resumed.company.id}`)).toHaveLength(1001);
    expect(await db.execute(sql`select id from cost_events where company_id = ${resumed.company.id}`)).toHaveLength(1001);
    expect(await db.execute(sql`select f.id from finance_events f left join cost_events c on f.cost_event_id = c.id
      where f.company_id = ${resumed.company.id} and (c.id is null or c.billing_code <> f.billing_code)`)).toHaveLength(0);
    const replay = await svc.importBundle(input, owner, undefined, { organizationId: org });
    expect(replay).toEqual(resumed);
    const after = await db.execute(sql`select id from finance_events where company_id = ${resumed.company.id}`);
    expect(after).toEqual(expect.arrayContaining(before));
  }, 30_000);

  it("keeps routine and trigger identities at source positions when an earlier routine becomes importable on retry", async () => {
    const input = request();
    const [first] = input.source.manifest.routines;
    first.slug = "late-routine";
    first.title = "Late Routine";
    first.assigneeAgentSlug = "late-worker";
    first.triggers = [{ kind: "api", label: "late-trigger", enabled: true }];
    const second = { ...first, slug: "stable-routine", title: "Stable Routine", projectSlug: "project", assigneeAgentSlug: "worker", triggers: [{ kind: "api", label: "stable-trigger", enabled: true }] };
    input.source.manifest.routines.push(second);
    const removeFault = await failInsert("finance_events", input);
    const svc = companyPortabilityService(db);
    try { await expect(svc.importBundle(input, owner, undefined, { organizationId: org })).rejects.toMatchObject({ status: 409 }); }
    finally { await removeFault(); }
    const failed = await operation(input);
    const before = await db.execute(sql`select r.id as routine_id, r.title, t.id as trigger_id from routines r
      join routine_triggers t on t.routine_id = r.id where r.company_id = ${failed!.company_id}`);
    expect(before).toHaveLength(1);
    expect(before[0].title).toBe(second.title);
    await db.insert(agents).values({ companyId: failed!.company_id as string, kind: "org", name: "Late Worker", role: "engineer",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const resumed = await svc.importBundle(input, owner, undefined, { organizationId: org });
    const after = await db.execute(sql`select r.id as routine_id, r.title, t.id as trigger_id from routines r
      join routine_triggers t on t.routine_id = r.id where r.company_id = ${resumed.company.id} order by r.title`);
    expect(after).toHaveLength(1);
    expect(after.find((row) => row.title === second.title)?.routine_id).toBe(before[0].routine_id);
    expect(after.find((row) => row.title === second.title)?.trigger_id).toBe(before[0].trigger_id);
    const replay = await svc.importBundle(input, owner, undefined, { organizationId: org });
    expect(replay).toEqual(resumed);
    expect(await db.execute(sql`select id from routines where company_id = ${resumed.company.id}`)).toHaveLength(1);
  }, 30_000);

  it("retries skipped cost events at stable source positions across fixed batch boundaries", async () => {
    const input = request();
    input.source.manifest.costEvents = Array.from({ length: 1001 }, (_, index) => ({
      ...input.source.manifest.costEvents[0], slug: `position-${index}`, billingCode: `position-${index}`,
      agentSlug: index === 0 ? "late-worker" : "worker",
    }));
    input.source.manifest.financeEvents = Array.from({ length: 1001 }, (_, index) => ({
      ...input.source.manifest.financeEvents[0], slug: `finance-${index}`, costEventSlug: `position-${index}`,
      billingCode: `cost-${index}`,
    }));
    const removeFault = await failInsert("finance_events", input);
    const svc = companyPortabilityService(db);
    try { await expect(svc.importBundle(input, owner, undefined, { organizationId: org })).rejects.toMatchObject({ status: 409 }); }
    finally { await removeFault(); }
    const failed = await operation(input);
    expect(await db.execute(sql`select id from cost_events where company_id = ${failed!.company_id}`)).toHaveLength(1000);
    await db.insert(agents).values({ companyId: failed!.company_id as string, kind: "org", name: "Late Worker", role: "engineer",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    const resumed = await svc.importBundle(input, owner, undefined, { organizationId: org });
    const rows = await db.execute(sql`select billing_code, agent_id from cost_events where company_id = ${resumed.company.id}
      order by billing_code`);
    expect(rows).toHaveLength(1000);
    expect(rows[0].billing_code).toBe("position-1");
    expect(rows[999].billing_code).toBe("position-999");
    expect(rows.some((row) => row.billing_code === "position-0")).toBe(false);
    const linkedFinance = await db.execute(sql`select f.billing_code, c.billing_code as cost_billing_code
      from finance_events f left join cost_events c on c.id = f.cost_event_id
      where f.company_id = ${resumed.company.id} order by f.billing_code`);
    expect(linkedFinance).toHaveLength(1001);
    expect(linkedFinance[0]).toMatchObject({ billing_code: "cost-0", cost_billing_code: null });
    expect(linkedFinance[1]).toMatchObject({ billing_code: "cost-1", cost_billing_code: "position-1" });
    const checkpoints = (await operation(input))!.checkpoints as Record<string, Array<{ id: string | null; action: string }>>;
    expect(checkpoints["cost-events:0"]).toHaveLength(1000);
    expect(checkpoints["cost-events:0"][0]).toEqual({ id: null, action: "skipped" });
    expect(checkpoints["cost-events:0"][1]).toMatchObject({ action: "created" });
    expect(checkpoints["cost-events:1000"]).toHaveLength(1);
    const replay = await svc.importBundle(input, owner, undefined, { organizationId: org });
    expect(replay).toEqual(resumed);
    expect(await db.execute(sql`select id from cost_events where company_id = ${resumed.company.id}`)).toHaveLength(1000);
  }, 30_000);

  it("checkpoints only section-affected rows and tolerates unrelated rows disappearing on replay", async () => {
    const input = request();
    const svc = companyPortabilityService(db);
    const sideEffectName = `side_${randomUUID().replaceAll("-", "")}`;
    const sideEffects = [
      { table: "budget_policies", sql: `CREATE FUNCTION ${sideEffectName}_budget() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.metric = 'cost_cents' THEN INSERT INTO budget_policies (company_id, scope_type, scope_id, metric, window_kind,
          amount_cents, warn_percent, hard_stop_enabled, notify_enabled, is_active)
          VALUES (NEW.company_id, 'company', NEW.company_id, 'requests', 'day', 1, 80, false, true, true); END IF;
        RETURN NEW; END $$` },
      { table: "provider_quota_windows", sql: `CREATE FUNCTION ${sideEffectName}_quota() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.provider = 'test' THEN INSERT INTO provider_quota_windows (company_id, provider, window_kind, limit_value, used_value,
          used_percent, last_updated_at) VALUES (NEW.company_id, 'unrelated-provider', 'day', 1, 0, 0, now()); END IF;
        RETURN NEW; END $$` },
      { table: "workflow_templates", sql: `CREATE FUNCTION ${sideEffectName}_workflow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.name = 'Imported Workflow' THEN INSERT INTO workflow_templates (company_id, name, workspace_mode, steps, dependencies, created_by)
          VALUES (NEW.company_id, 'Unrelated Template', 'shared', '[]'::jsonb, '[]'::jsonb, 'import-test'); END IF;
        RETURN NEW; END $$` },
    ];
    for (const [index, effect] of sideEffects.entries()) {
      const suffix = ["budget", "quota", "workflow"][index]!;
      await db.execute(sql.raw(effect.sql));
      await db.execute(sql.raw(`CREATE TRIGGER ${sideEffectName}_${suffix} BEFORE INSERT ON ${effect.table}
        FOR EACH ROW EXECUTE FUNCTION ${sideEffectName}_${suffix}()`));
    }
    const readyFaultName = `ready_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${readyFaultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.name = '${input.target.newCompanyName}' AND NEW.agent_execution_setup_state = 'ready'
        THEN RAISE EXCEPTION 'synthetic readiness fault'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${readyFaultName} BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION ${readyFaultName}()`));
    try {
      await expect(svc.importBundle(input, owner, undefined, { organizationId: org })).rejects.toMatchObject({ status: 409 });
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${readyFaultName} ON companies`));
      await db.execute(sql.raw(`DROP FUNCTION ${readyFaultName}()`));
      for (const [index, effect] of sideEffects.entries()) {
        const suffix = ["budget", "quota", "workflow"][index]!;
        await db.execute(sql.raw(`DROP TRIGGER ${sideEffectName}_${suffix} ON ${effect.table}`));
        await db.execute(sql.raw(`DROP FUNCTION ${sideEffectName}_${suffix}()`));
      }
    }
    const failed = await operation(input);
    const companyId = failed!.company_id as string;
    const checkpoint = await operation(input);
    const checkpointValues = checkpoint!.checkpoints as Record<string, unknown[]>;
    expect(checkpointValues).toMatchObject({
      budgetPolicies: expect.any(Array),
      quotaWindows: expect.any(Array),
      workflowTemplates: expect.any(Array),
    });
    for (const key of ["budgetPolicies", "quotaWindows", "workflowTemplates"]) {
      expect(checkpointValues[key], key).toHaveLength(1);
    }
    await db.execute(sql`delete from budget_policies where company_id = ${companyId} and metric = 'requests'`);
    await db.execute(sql`delete from provider_quota_windows where company_id = ${companyId} and provider = 'unrelated-provider'`);
    await db.execute(sql`delete from workflow_templates where company_id = ${companyId} and name = 'Unrelated Template'`);
    const replay = await svc.importBundle(input, owner, undefined, { organizationId: org });
    expect(replay.company.id).toBe(companyId);
    expect(await svc.importBundle(input, owner, undefined, { organizationId: org })).toEqual(replay);
  });
});
