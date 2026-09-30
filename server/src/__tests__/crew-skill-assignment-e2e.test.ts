/**
 * T7 (seam proof): the founder-assigned skill loop, end-to-end, on real Postgres.
 *
 * Two prior tasks already shipped, each proven in isolation:
 *   • T6 (delivery)    — companySkillService.listRuntimeSkillEntries(companyId, agentId)
 *                        resolves an agent's skillKeys to the runtime entries the crew
 *                        runner puts on context.skills.
 *   • T9 (enforcement) — use_skill denies a crew agent (actorType "agent", agentKind
 *                        "aoa") any skill not in agents.skillKeys, company-scoped and
 *                        fail-closed.
 *
 * Neither proved the FOUNDER'S actual workflow: attach a skill in the UI -> it reaches
 * the agent -> the agent can use THAT skill but not others -> detach it -> it stops
 * reaching the agent. That single assign -> deliver -> enforce -> revoke loop is what
 * this test proves, driving the REAL assignment route (PATCH /api/agents/:id) against
 * real tables so the whole chain runs against persisted rows rather than mocks.
 *
 * Policy (D17): crew agents ship with NO default skills — agents.skillKeys defaults [].
 * This test never seeds a default; it proves the founder-assigned path is the ONLY path,
 * which is exactly what makes the agent Skills tab honest.
 *
 * Discriminator discipline (a real scar from earlier tasks): every assertion can only
 * pass for the right reason.
 *   • The deny leg uses a DIFFERENT but ALSO-INSTALLED skill, so the denial is the
 *     allowlist (NOT_ENABLED), never a missing skill (NOT_FOUND).
 *   • The revoke leg re-checks the SAME key that worked in the allow leg, so a green
 *     revoke means the attachment — not some unrelated key — was actually withdrawn.
 *
 * Skipped on Windows by default (CI's `runneradmin` account can't start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. On a Windows
 * dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real — the UTF-8 initdbFlags
 * below make the cluster locale-safe. Modeled on crew-run-log-pointer.integration.test.ts.
 */
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, agents, type Db } from "@armyofagents/db";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { companySkillService } from "../services/company-skills.js";
import { useSkillTool } from "../services/internal-agent/tools/skill-tools.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;
let setupFailed = false;

/**
 * Fail LOUDLY and ONCE when embedded-postgres never came up.
 *
 * `setupError = err` alone is not a guard: embedded-postgres can reject with
 * `undefined`, which is falsy, so the old `if (setupError) throw` silently
 * no-oped and every case then ran against an unassigned `db` — a wall of
 * `Cannot read properties of undefined (reading 'insert')` pointing into
 * product code, which reads as a product bug rather than a setup failure.
 * A boolean cannot be falsy-by-accident, and the `db` check covers a throw
 * that happens to leave `setupError` null.
 */
function assertSetupOk(): void {
  const dbReady = (db as Db | undefined) !== undefined;
  if (!setupFailed && dbReady) return;
  throw new Error(
    `embedded-postgres setup failed (see the console.error above): ${
      setupError instanceof Error ? setupError.message : String(setupError)
    }`,
  );
}

const PORT = 62100 + Math.floor(Math.random() * 400);

// Deterministic identifiers so every leg reasons about the same rows.
const companyId = "77777777-7777-4777-8777-777777777777";
const SKILL_A_KEY = "skill:aoa/design-review"; // the one the founder attaches
const SKILL_B_KEY = "skill:aoa/code-review"; // installed but never attached (the discriminator)
let founderId = "";
let crewAgentId = "";

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  return ((result as { rows?: Array<Record<string, unknown>> }).rows ?? []) as Array<
    Record<string, unknown>
  >;
}

/** A board actor carrying the seeded founder's identity — what the real PATCH route gates on. */
const founderActor = () => ({
  type: "board" as const,
  source: "session" as const,
  userId: founderId,
  companyIds: [companyId],
  isInstanceAdmin: false,
});

/** Mount the REAL agents router with the real db + a founder board actor. */
function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = founderActor();
    next();
  });
  app.use("/api", agentRoutes(db));
  app.use(errorHandler);
  return app;
}

/** The crew runtime context use_skill sees: actor=agent, kind=aoa, the agent's own id. */
function crewCtx(agentId: string) {
  return {
    db,
    companyId,
    userId: "sub-user",
    userRole: "team_member",
    actorType: "agent",
    agentKind: "aoa",
    agentId,
  } as any;
}

async function seedInstalledSkill(key: string, slug: string, name: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO company_skills (id, company_id, key, slug, name, markdown, source_type)
    VALUES (gen_random_uuid(), ${companyId}, ${key}, ${slug}, ${name}, ${`# ${name}\nBody for ${slug}.`}, 'catalog')
  `);
}

beforeAll(async () => {
  if (process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1") return;
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-crew-skill-e2e-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);

    // Company.
    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${companyId}, 'Crew Skill E2E Co', 'CSE')
    `);

    // Founder — the only principal allowed to edit an AoA (crew) agent. The PATCH
    // route runs assertRole(..., "founder"), which reads user_roles.
    const founderRows = rowsOf(
      await db.execute(sql`
        INSERT INTO "user" (id, email, name, email_verified, created_at, updated_at)
        VALUES (gen_random_uuid()::text, 'founder@crew-skill-e2e.test', 'Founder', false, now(), now())
        RETURNING id
      `),
    );
    founderId = String(founderRows[0]!.id);
    await db.execute(sql`
      INSERT INTO company_memberships (id, company_id, principal_type, principal_id, membership_role, status, created_at, updated_at)
      VALUES (gen_random_uuid(), ${companyId}, 'user', ${founderId}, 'owner', 'active', now(), now())
    `);
    await db.execute(sql`
      INSERT INTO user_roles (id, company_id, user_id, role)
      VALUES (gen_random_uuid(), ${companyId}, ${founderId}, 'founder')
    `);

    // Crew agent — kind='aoa', D17 default of NO skills attached (skill_keys defaults []).
    const agentRows = rowsOf(
      await db.execute(sql`
        INSERT INTO agents (id, company_id, name, kind, status)
        VALUES (gen_random_uuid(), ${companyId}, 'Engineer', 'aoa', 'idle')
        RETURNING id
      `),
    );
    crewAgentId = String(agentRows[0]!.id);

    // Two installed company skills. Only SKILL_A is ever attached; SKILL_B exists so
    // the deny leg proves the allowlist, not a missing skill.
    await seedInstalledSkill(SKILL_A_KEY, "design-review", "Design Review");
    await seedInstalledSkill(SKILL_B_KEY, "code-review", "Code Review");
  } catch (err) {
    setupError = err;
    setupFailed = true;
    // eslint-disable-next-line no-console
    console.error("[crew-skill-assignment-e2e] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    /* ignore */
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}, 60_000);

describe.skipIf(
  process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1",
)("crew founder-assigned skill loop: assign -> deliver -> enforce -> revoke (real PostgreSQL)", () => {
  it("baseline (D17): with NO skill attached, delivery is empty and use_skill denies the installed skill", async () => {
    assertSetupOk();
    const svc = companySkillService(db);

    // Delivery sees nothing — the agent ships with no default skills.
    expect(await svc.listRuntimeSkillEntries(companyId, crewAgentId)).toEqual([]);

    // The skill EXISTS in the library, yet an unattached crew agent is denied — the
    // denial is the empty allowlist (NOT_ENABLED), not a missing skill (NOT_FOUND).
    const denied = await useSkillTool.execute({ key: SKILL_A_KEY }, crewCtx(crewAgentId));
    expect(denied.success).toBe(false);
    expect(denied.error).toBe("NOT_ENABLED");
    expect(denied.error).not.toBe("NOT_FOUND");
  });

  it("ASSIGN: attaching a skill via the real PATCH route returns 200 and persists the row", async () => {
    assertSetupOk();

    const res = await request(makeApp())
      .patch(`/api/agents/${crewAgentId}`)
      .send({ skillKeys: [SKILL_A_KEY] });
    expect(res.status).toBe(200);
    expect(res.body.skillKeys).toEqual([SKILL_A_KEY]);

    // The persisted row — not just the response — carries the attachment.
    const [row] = await db
      .select({ skillKeys: agents.skillKeys })
      .from(agents)
      .where(eq(agents.id, crewAgentId));
    expect(row!.skillKeys).toEqual([SKILL_A_KEY]);
  });

  it("ASSIGN (slug form): attaching by SLUG persists the CANONICAL key AND survives deliver+enforce", async () => {
    assertSetupOk();

    // The blind spot: the route advertises id/slug/normalizable ref forms as valid,
    // but a store-raw bug meant a non-canonical attach validated 200 yet was stored
    // verbatim — so delivery (compares skill.key) and enforcement (compares skill.key)
    // both silently no-op'd. Drive the SLUG through the real route and prove the whole
    // loop, not just the 200.
    const res = await request(makeApp())
      .patch(`/api/agents/${crewAgentId}`)
      .send({ skillKeys: ["design-review"] }); // SLUG, not the canonical SKILL_A_KEY
    expect(res.status).toBe(200);
    // The response AND the persisted row carry the CANONICAL key, never the raw slug.
    expect(res.body.skillKeys).toEqual([SKILL_A_KEY]);
    const [row] = await db
      .select({ skillKeys: agents.skillKeys })
      .from(agents)
      .where(eq(agents.id, crewAgentId));
    expect(row!.skillKeys).toEqual([SKILL_A_KEY]);

    // DELIVER: the slug-attached skill reaches the agent's runtime context.
    const entries = await companySkillService(db).listRuntimeSkillEntries(companyId, crewAgentId);
    expect(entries.map((e) => e.key)).toEqual([SKILL_A_KEY]);

    // ENFORCE: use_skill with the CANONICAL key now succeeds — the slug attach is honest.
    const allow = await useSkillTool.execute({ key: SKILL_A_KEY }, crewCtx(crewAgentId));
    expect(allow.success).toBe(true);
    expect((allow.data as { key: string }).key).toBe(SKILL_A_KEY);
  });

  it("ASSIGN (validation): an unknown skill key is rejected 422 and does NOT change the row", async () => {
    assertSetupOk();

    const res = await request(makeApp())
      .patch(`/api/agents/${crewAgentId}`)
      .send({ skillKeys: ["skill:aoa/does-not-exist"] });
    expect(res.status).toBe(422);

    // The prior attachment is untouched.
    const [row] = await db
      .select({ skillKeys: agents.skillKeys })
      .from(agents)
      .where(eq(agents.id, crewAgentId));
    expect(row!.skillKeys).toEqual([SKILL_A_KEY]);
  });

  it("DELIVER (T6): listRuntimeSkillEntries returns exactly the attached skill", async () => {
    assertSetupOk();
    const entries = await companySkillService(db).listRuntimeSkillEntries(companyId, crewAgentId);
    expect(entries.map((e) => e.key)).toEqual([SKILL_A_KEY]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.markdown).toContain("Design Review");
  });

  it("ENFORCE allow (T9): use_skill succeeds for the attached skill", async () => {
    assertSetupOk();
    const res = await useSkillTool.execute({ key: SKILL_A_KEY }, crewCtx(crewAgentId));
    expect(res.success).toBe(true);
    expect((res.data as { key: string }).key).toBe(SKILL_A_KEY);
  });

  it("ENFORCE deny (T9): a DIFFERENT installed-but-unattached skill returns NOT_ENABLED, not NOT_FOUND", async () => {
    assertSetupOk();
    // SKILL_B is genuinely installed (seeded above) — so a denial can only be the
    // allowlist. This is the discriminator: if SKILL_B didn't exist, NOT_FOUND would
    // masquerade as enforcement and prove nothing.
    const res = await useSkillTool.execute({ key: SKILL_B_KEY }, crewCtx(crewAgentId));
    expect(res.success).toBe(false);
    expect(res.error).toBe("NOT_ENABLED");
    expect(res.error).not.toBe("NOT_FOUND");
  });

  it("REVOKE: clearing skillKeys via the route stops delivery AND re-denies the SAME key that just worked", async () => {
    assertSetupOk();

    const res = await request(makeApp())
      .patch(`/api/agents/${crewAgentId}`)
      .send({ skillKeys: [] });
    expect(res.status).toBe(200);
    expect(res.body.skillKeys).toEqual([]);

    // Delivery now returns nothing.
    expect(await companySkillService(db).listRuntimeSkillEntries(companyId, crewAgentId)).toEqual([]);

    // The very key that succeeded in the allow leg is now denied — proving the
    // attachment (not some unrelated key) was withdrawn.
    const denied = await useSkillTool.execute({ key: SKILL_A_KEY }, crewCtx(crewAgentId));
    expect(denied.success).toBe(false);
    expect(denied.error).toBe("NOT_ENABLED");
    expect(denied.error).not.toBe("NOT_FOUND");
  });
});
