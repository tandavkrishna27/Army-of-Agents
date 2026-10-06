import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  applyPendingMigrations,
  authUsers,
  companies,
  companyImportOperations,
  companyMemberships,
  createDb,
  onboardingProgress,
  organizationMemberships,
  organizations,
  userRoles,
  type Db,
} from "@armyofagents/db";
import { orderedStatesFor, type OnboardingJourney } from "@armyofagents/shared";
import { onboardingRoutes } from "../routes/onboarding.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };

describe.skipIf(process.platform !== "linux")("setup readiness authorization (real PostgreSQL)", () => {
  let pg: Pg;
  let dir = "";
  let db: Db;
  const orgId = randomUUID();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "aoa-onboarding-ready-"));
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const port = await allocateEmbeddedPgPort();
    pg = new EmbeddedPostgres({ databaseDir: join(dir, "pg"), user: "test", password: "test", port,
      persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
    await pg.initialise();
    await pg.start();
    const url = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(url);
    db = createDb(url);
    await db.insert(organizations).values({ id: orgId, name: "Readiness Test Org", slug: `readiness-${orgId}` });
  }, 180_000);

  afterAll(async () => {
    try { if (pg) await pg.stop(); } catch { /* ignore */ }
    try { if (dir) await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 60_000);

  async function workspace(name: string) {
    const founderId = `founder-${randomUUID()}`;
    const companyId = randomUUID();
    const prefix = randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase();
    const now = new Date();
    await db.insert(authUsers).values({ id: founderId, email: `${founderId}@example.test`, name: founderId, createdAt: now, updatedAt: now });
    await db.insert(companies).values({ id: companyId, organizationId: orgId, name, issuePrefix: prefix,
      agentExecutionSetupState: "pending" });
    await db.insert(organizationMemberships).values({ organizationId: orgId, userId: founderId, role: "owner", status: "active" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: founderId,
      status: "active", membershipRole: "owner" });
    await db.insert(userRoles).values({ companyId, userId: founderId, role: "founder" });
    return { companyId, founderId };
  }

  async function addMember(companyId: string, role: string) {
    const userId = `member-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: userId, email: `${userId}@example.test`, name: userId, createdAt: now, updatedAt: now });
    await db.insert(organizationMemberships).values({ organizationId: orgId, userId, role: "member", status: "active" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId,
      status: "active", membershipRole: role });
    await db.insert(userRoles).values({ companyId, userId, role });
    return userId;
  }

  async function seedProgress(userId: string, companyId: string, journey: OnboardingJourney,
    firstRunCompletedAt?: Date) {
    const states = orderedStatesFor(journey);
    const completed = states.slice(0, -1);
    const [row] = await db.insert(onboardingProgress).values({ userId, companyId, journey,
      currentState: completed.at(-1)!, completedStates: completed, firstRunCompletedAt }).returning();
    return row!;
  }

  function app(actor: Record<string, unknown>) {
    const result = express();
    result.use(express.json());
    result.use((req: any, _res, next) => { req.actor = actor; next(); });
    result.use("/api", onboardingRoutes(db));
    return result;
  }

  function setupRequest(journey: OnboardingJourney = "founder") {
    return { journey, requestedState: "SETUP_COMPLETE" };
  }

  it("allows an active founder-owner to complete setup atomically and replays idempotently", async () => {
    const { companyId, founderId } = await workspace("Founder Readiness");
    await seedProgress(founderId, companyId, "founder");
    const actor = { type: "board", source: "session", userId: founderId, companyIds: [companyId], organizationIds: [orgId] };

    const first = await request(app(actor)).patch("/api/onboarding/progress")
      .send({ ...setupRequest(), companyId });
    expect(first.status).toBe(200);
    expect(first.body.progress.completedStates).toContain("SETUP_COMPLETE");
    expect((await db.select({ state: companies.agentExecutionSetupState }).from(companies)
      .where(eq(companies.id, companyId)))[0]!.state).toBe("ready");
    const version = first.body.progress.version;
    const replay = await request(app(actor)).patch("/api/onboarding/progress")
      .send({ ...setupRequest(), companyId });
    expect(replay.status).toBe(200);
    expect(replay.body.progress.version).toBe(version);
  });

  it("does not let an invited member complete readiness, including with a forged founder journey", async () => {
    const { companyId } = await workspace("Invited Readiness");
    const invitedId = await addMember(companyId, "team_member");
    const [initialProgress] = await db.insert(onboardingProgress).values({ userId: invitedId, companyId, journey: "invited",
      currentState: "PROFILE_SET", completedStates: ["AUTHENTICATED", "PROFILE_SET"] }).returning();
    const actor = { type: "board", source: "session", userId: invitedId, companyIds: [companyId], organizationIds: [orgId] };

    const forged = await request(app(actor)).patch("/api/onboarding/progress")
      .send({ ...setupRequest("founder"), companyId });
    expect(forged.status).toBe(409);
    const afterForgery = (await db.select().from(onboardingProgress).where(and(
      eq(onboardingProgress.userId, invitedId), eq(onboardingProgress.companyId, companyId),
    )))[0]!;
    expect(afterForgery).toMatchObject({ id: initialProgress!.id, journey: "invited", version: initialProgress!.version,
      currentState: "PROFILE_SET", completedStates: ["AUTHENTICATED", "PROFILE_SET"] });
    expect((await db.select({ state: companies.agentExecutionSetupState }).from(companies)
      .where(eq(companies.id, companyId)))[0]!.state).toBe("pending");

    const join = await request(app(actor)).patch("/api/onboarding/progress")
      .send({ journey: "invited", requestedState: "JOIN_REQUESTED", companyId });
    expect(join.status).toBe(200);
    const completed = await request(app(actor)).patch("/api/onboarding/progress")
      .send({ ...setupRequest("invited"), companyId });
    expect(completed.status).toBe(200);
    expect(completed.body.progress.completedStates).toContain("SETUP_COMPLETE");
    expect((await db.select({ state: companies.agentExecutionSetupState }).from(companies)
      .where(eq(companies.id, companyId)))[0]!.state).toBe("pending");
  });

  it("permits the server-trusted local implicit operator without a user membership", async () => {
    const { companyId } = await workspace("Local Trusted Readiness");
    const localUserId = `local-board-${randomUUID()}`;
    await seedProgress(localUserId, companyId, "founder");
    const res = await request(app({ type: "board", source: "local_implicit", userId: localUserId }))
      .patch("/api/onboarding/progress").send({ ...setupRequest(), companyId });
    expect(res.status).toBe(200);
    expect((await db.select({ state: companies.agentExecutionSetupState }).from(companies)
      .where(eq(companies.id, companyId)))[0]!.state).toBe("ready");
  });

  it("does not use first-run completion as an execution-readiness signal", async () => {
    const { companyId, founderId } = await workspace("First Run Is Not Readiness");
    await seedProgress(founderId, companyId, "founder");
    const actor = { type: "board", source: "session", userId: founderId, companyIds: [companyId], organizationIds: [orgId] };
    const res = await request(app(actor)).patch("/api/onboarding/first-run").send({ companyId, completed: true });
    expect(res.status).toBe(200);
    expect(res.body.progress.firstRunCompletedAt).not.toBeNull();
    expect((await db.select({ state: companies.agentExecutionSetupState }).from(companies)
      .where(eq(companies.id, companyId)))[0]!.state).toBe("pending");
  });

  it("keeps imported-company readiness owned by the durable import operation", async () => {
    const { companyId, founderId } = await workspace("Imported Readiness");
    await seedProgress(founderId, companyId, "founder");
    await db.insert(companyImportOperations).values({ companyId, organizationId: orgId, operationId: randomUUID(),
      actorUserId: founderId, fingerprint: "fixture-fingerprint", status: "failed" });
    const actor = { type: "board", source: "session", userId: founderId, companyIds: [companyId], organizationIds: [orgId] };
    const res = await request(app(actor)).patch("/api/onboarding/progress")
      .send({ ...setupRequest(), companyId });
    expect(res.status).toBe(200);
    expect((await db.select({ state: companies.agentExecutionSetupState }).from(companies)
      .where(eq(companies.id, companyId)))[0]!.state).toBe("pending");
  });

  it("rolls progress back if the readiness write fails", async () => {
    const { companyId, founderId } = await workspace("Readiness Rollback");
    const progress = await seedProgress(founderId, companyId, "founder");
    const triggerName = `readiness_fault_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${companyId}' AND NEW.agent_execution_setup_state = 'ready'
        THEN RAISE EXCEPTION 'synthetic readiness write failure'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`));
    try {
      const actor = { type: "board", source: "session", userId: founderId, companyIds: [companyId], organizationIds: [orgId] };
      await request(app(actor)).patch("/api/onboarding/progress").send({ ...setupRequest(), companyId });
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER ${triggerName} ON companies`));
      await db.execute(sql.raw(`DROP FUNCTION ${triggerName}()`));
    }
    const [after] = await db.select().from(onboardingProgress).where(eq(onboardingProgress.id, progress.id));
    expect(after!.completedStates).not.toContain("SETUP_COMPLETE");
    expect((await db.select({ state: companies.agentExecutionSetupState }).from(companies)
      .where(eq(companies.id, companyId)))[0]!.state).toBe("pending");
  });
});
