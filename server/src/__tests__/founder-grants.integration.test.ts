/**
 * Cloud_auth founders must be able to pass canUser()-gated routes.
 *
 * Regression: `ensureRealOperator` seeded a founder's `userRoles` founder row +
 * owner membership but NO `principal_permission_grants`. Under tenant isolation
 * `canUser()`/`hasPermission()` read grant rows and `isInstanceAdmin()` is false,
 * so a freshly-created cloud_auth founder was 403'd on every canUser-gated route
 * (Providers `agents:create`, routines/projects `tasks:assign`, …). This proves:
 *   1. `ensureRealOperator` now seeds the full founder grant set → canUser true.
 *   2. `backfillFounderGrants` heals a pre-existing founder that has the role +
 *      membership but zero grants (the flipped-instance case).
 *
 * Real PostgreSQL, because the assertion is entirely about grant rows a mocked DB
 * could not prove. Skipped on Windows by default (embedded-postgres can't start
 * on CI's `runneradmin` — Issue #114); Linux CI is the authoritative gate. To run
 * locally on Windows, temporarily flip `skipIf(process.platform !== "linux")` to
 * `skipIf(false)` (REVERT before commit).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import {
  applyPendingMigrations,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  organizations,
  principalPermissionGrants,
  userRoles,
  type Db,
} from "@armyofagents/db";
import { PERMISSION_KEYS } from "@armyofagents/shared";
import { accessService } from "../services/access.js";
import { backfillFounderGrants } from "../services/founder-grants-backfill.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

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

// To run locally on Windows, temporarily flip this to `describe.skipIf(false)`.
describe.skipIf(process.platform !== "linux")("founder permission grants (real PostgreSQL)", () => {
  let db: Db;
  const orgId = randomUUID();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-founder-grants-"));
    const port = await allocateEmbeddedPgPort();
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const conn = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(conn);
    db = createDb(conn);
    await db.insert(organizations).values({
      id: orgId,
      name: "Founder Grants Org",
      slug: `founder-grants-org-${randomUUID()}`,
      status: "active",
      plan: "beta",
    });
  }, 180_000);

  afterAll(async () => {
    try { if (pg) await pg.stop(); } catch { /* ignore */ }
    try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 60_000);

  async function insertCompany(name: string): Promise<string> {
    const [company] = await db
      .insert(companies)
      .values({
        name,
        issuePrefix: `FG${Math.floor(Math.random() * 1e6)}`,
        organizationId: orgId,
      })
      .returning();
    return company.id;
  }

  async function insertFounderUser(): Promise<string> {
    const userId = `founder-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({
      id: userId,
      name: "Founder",
      email: `${userId}@example.test`,
      createdAt: now,
      updatedAt: now,
    });
    return userId;
  }

  it("ensureRealOperator seeds the founder's full permission-grant set", async () => {
    const companyId = await insertCompany(`Create Path ${randomUUID()}`);
    const userId = await insertFounderUser();
    const access = accessService(db);

    await access.ensureRealOperator(companyId, userId);

    // Every founder permission is now grantable → canUser true for all keys,
    // including the `agents:create` bar the Providers tab enforces.
    for (const key of PERMISSION_KEYS) {
      expect(await access.canUser(companyId, userId, key)).toBe(true);
    }
    // Owner membership is active (hasPermission requires status='active').
    const [membership] = await db
      .select({ status: companyMemberships.status })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalId, userId),
        ),
      );
    expect(membership?.status).toBe("active");
  });

  it("backfillFounderGrants heals a founder with role + membership but no grants", async () => {
    const companyId = await insertCompany(`Flipped ${randomUUID()}`);
    const userId = await insertFounderUser();
    const access = accessService(db);

    // Simulate the pre-fix / flipped-instance state: founder role + active owner
    // membership, but ZERO principal_permission_grants.
    await db.insert(userRoles).values({ companyId, userId, role: "founder" });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
    });

    // Pre-condition: no grants → every canUser-gated route 403s.
    expect(await access.canUser(companyId, userId, "agents:create")).toBe(false);

    const res = await backfillFounderGrants(db);
    expect(res.granted).toBeGreaterThanOrEqual(PERMISSION_KEYS.length);

    for (const key of PERMISSION_KEYS) {
      expect(await access.canUser(companyId, userId, key)).toBe(true);
    }

    // Idempotent: a second run seeds nothing new for this founder.
    const grantWhere = and(
      eq(principalPermissionGrants.companyId, companyId),
      eq(principalPermissionGrants.principalId, userId),
    );
    const before = await db
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(grantWhere);
    await backfillFounderGrants(db);
    const after = await db
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(grantWhere);
    expect(after.length).toBe(before.length);
  });

  it("backfillFounderGrants does NOT re-grant an offboarded founder (inactive membership)", async () => {
    const companyId = await insertCompany(`Offboarded ${randomUUID()}`);
    const userId = await insertFounderUser();

    // A deliberately-offboarded founder: founder role row lingers but membership
    // is inactive. hasPermission gates on active membership, so re-seeding grants
    // here would be dead rows / a latent re-arm — the backfill must skip them.
    await db.insert(userRoles).values({ companyId, userId, role: "founder" });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "suspended",
      membershipRole: "owner",
    });

    await backfillFounderGrants(db);

    const grants = await db
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.companyId, companyId),
          eq(principalPermissionGrants.principalId, userId),
        ),
      );
    expect(grants).toHaveLength(0);
  });
});
