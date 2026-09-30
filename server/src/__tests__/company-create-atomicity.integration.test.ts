/**
 * P3 — company creation must write the company row AND the founder's
 * membership/role atomically, mirroring Fix 5 for org-create.
 *
 * Before this fix, `POST /companies` did a bare committing `db.insert(companies)`
 * and THEN, as a SEPARATE un-transactioned step, `ensureRealOperator(...)`. A
 * fault between them committed a company with NO membership for anyone — an
 * unrecoverable orphan in cloud_auth. `createWithOperator` closes that gap by
 * running the company insert + `ensureRealOperator` inside ONE `db.transaction`,
 * so a transient fault rolls back the whole thing.
 *
 * Real PostgreSQL, because the whole assertion is about a real transaction
 * rolling back on failure — a mocked DB could only prove functions were called,
 * not that the row is actually gone.
 *
 * Skipped on Windows by default (CI's `runneradmin` account can't start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. To run
 * locally on Windows, temporarily flip `skipIf(process.platform !== "linux")` to
 * `skipIf(false)` (REVERT before commit).
 *
 * The one network-bound Group-A seeder (`provisionCompanyCrew`, catalog fetch)
 * is mocked to a no-op so the post-commit best-effort seed stays hermetic and
 * fast; the remaining Group-A seeders (root folder, internal_agent_config,
 * Commander) are DB-only and run for real, which is what the happy path asserts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

const provisionCompanyCrewMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../services/crew-provisioning.js", () => ({
  provisionCompanyCrew: provisionCompanyCrewMock,
}));

import {
  applyPendingMigrations,
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  internalAgentConfig,
  organizations,
  organizationMemberships,
  userRoles,
  type Db,
} from "@armyofagents/db";
import { accessService } from "../services/access.js";
import { companyService } from "../services/companies.js";
import { insertActivityLog } from "../services/activity-log.js";
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
describe.skipIf(process.platform !== "linux")(
  "companyService.createWithOperator — atomicity (real PostgreSQL)",
  () => {
    let db: Db;
    const orgId = randomUUID();
    const ownerUserId = `company-tx-owner-${randomUUID()}`;

    beforeAll(async () => {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-company-tx-"));
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
      const now = new Date();
      // companies.organization_id -> organizations(id) FK (RESTRICT): a real
      // owning org must exist for the company insert to satisfy the FK.
      await db.insert(organizations).values({
        id: orgId,
        name: "Company Tx Org",
        slug: `company-tx-org-${randomUUID()}`,
        status: "active",
        plan: "beta",
      });
      // organization_memberships.user_id + user_roles.user_id + company_memberships.principal_id
      // all reference "user"(id): seed a real owner so the happy-path operator
      // provisioning writes satisfy those FKs.
      await db.insert(authUsers).values({
        id: ownerUserId,
        name: "Company Tx Owner",
        email: `${ownerUserId}@example.test`,
        createdAt: now,
        updatedAt: now,
      });
    }, 180_000);

    afterAll(async () => {
      try { if (pg) await pg.stop(); } catch { /* ignore */ }
      try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }, 60_000);

    it("rolls back the company insert when the operator write fails (no orphan company)", async () => {
      const name = `Rollback Company ${randomUUID()}`;
      const svc = companyService(db);
      const throwingBuildAccess = (): Pick<
        ReturnType<typeof accessService>,
        "ensureRealOperator"
      > => ({
        ensureRealOperator: () => Promise.reject(new Error("boom")),
      });
      await expect(
        svc.createWithOperator(
          { name, organizationId: orgId },
          { requestedByUserId: ownerUserId },
          ownerUserId,
          throwingBuildAccess,
        ),
      ).rejects.toThrow();
      // Atomicity: the company row inserted inside the tx is rolled back together
      // with the failed operator write — no orphan company with no membership.
      const surviving = await db.select().from(companies).where(eq(companies.name, name));
      expect(surviving).toHaveLength(0);
    });

    it("rolls back company, operator, and audit together when audit persistence fails", async () => {
      const name = `Audit Atomic Company ${randomUUID()}`;
      const creationRequestId = randomUUID();
      const svc = companyService(db);

      await expect(
        svc.createWithOperator(
          { name, organizationId: orgId, creationRequestId },
          { requestedByUserId: ownerUserId },
          ownerUserId,
          (tx) => accessService(tx),
          async () => {
            throw new Error("forced audit failure");
          },
        ),
      ).rejects.toThrow("forced audit failure");
      expect(await db.select().from(companies).where(eq(companies.name, name))).toHaveLength(0);
      expect(
        await db
          .select()
          .from(companyMemberships)
          .where(eq(companyMemberships.principalId, ownerUserId)),
      ).toHaveLength(0);
      expect(
        await db.select().from(userRoles).where(eq(userRoles.userId, ownerUserId)),
      ).toHaveLength(0);
      expect(
        await db
          .select()
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.organizationId, orgId),
              eq(organizationMemberships.userId, ownerUserId),
            ),
          ),
      ).toHaveLength(0);

      const result = await svc.createWithOperator(
        { name, organizationId: orgId, creationRequestId },
        { requestedByUserId: ownerUserId },
        ownerUserId,
        (tx) => accessService(tx),
        (tx, company) =>
          insertActivityLog(tx, {
            companyId: company.id,
            actorType: "user",
            actorId: ownerUserId,
            action: "company.created",
            entityType: "company",
            entityId: company.id,
            details: { name },
          }),
      );
      expect(result.created).toBe(true);
      expect(await db.select().from(companies).where(eq(companies.name, name))).toHaveLength(1);
      expect(
        await db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, result.company.id),
              eq(activityLog.action, "company.created"),
            ),
          ),
      ).toHaveLength(1);

      const replay = await svc.createWithOperator(
        { name, organizationId: orgId, creationRequestId },
        { requestedByUserId: ownerUserId },
        ownerUserId,
        (tx) => accessService(tx),
        (tx, company) =>
          insertActivityLog(tx, {
            companyId: company.id,
            actorType: "user",
            actorId: ownerUserId,
            action: "company.created",
            entityType: "company",
            entityId: company.id,
            details: { name },
          }),
      );
      expect(replay.created).toBe(false);
      expect(
        await db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.companyId, result.company.id),
              eq(activityLog.action, "company.created"),
            ),
          ),
      ).toHaveLength(1);
    });

    it("replays sequential and concurrent creates with the same request id", async () => {
      const creationRequestId = randomUUID();
      const name = `Replay Company ${randomUUID()}`;
      const svc = companyService(db);
      const create = () =>
        svc.createWithOperator(
          { name, organizationId: orgId, creationRequestId },
          { requestedByUserId: ownerUserId },
          ownerUserId,
          (tx) => accessService(tx),
        );

      const first = await create();
      const sequential = await create();
      const [concurrentA, concurrentB] = await Promise.all([create(), create()]);
      expect(new Set([
        first.company.id,
        sequential.company.id,
        concurrentA.company.id,
        concurrentB.company.id,
      ])).toEqual(new Set([first.company.id]));
      expect(await db.select().from(companies).where(eq(companies.name, name))).toHaveLength(1);
    });

    it("reconciles idempotent post-commit bootstrap when a create request is replayed", async () => {
      const creationRequestId = randomUUID();
      const name = `Replay Bootstrap ${randomUUID()}`;
      const svc = companyService(db);
      const input = { name, organizationId: orgId, creationRequestId };

      const first = await svc.createWithOperator(
        input,
        { requestedByUserId: ownerUserId },
        ownerUserId,
        (tx) => accessService(tx),
      );
      const laterFounderId = `later-founder-${randomUUID()}`;
      const now = new Date();
      await db.insert(authUsers).values({
        id: laterFounderId,
        name: "Later Founder",
        email: `${laterFounderId}@example.test`,
        createdAt: now,
        updatedAt: now,
      });
      await accessService(db).ensureRealOperator(first.company.id, laterFounderId);
      provisionCompanyCrewMock.mockClear();

      const replay = await svc.createWithOperator(
        input,
        { requestedByUserId: ownerUserId },
        `different-replayer-${randomUUID()}`,
        (tx) => accessService(tx),
      );

      expect(replay.created).toBe(false);
      expect(replay.operatorId).toBe(ownerUserId);
      expect(provisionCompanyCrewMock).toHaveBeenCalledOnce();
    });

    it("recovers the generated local operator identity on replay", async () => {
      const creationRequestId = randomUUID();
      const name = `Local Replay Operator ${randomUUID()}`;
      const svc = companyService(db);
      const input = { name, organizationId: orgId, creationRequestId };

      const first = await svc.createWithOperator(
        input,
        {},
        null,
        (tx) => accessService(tx),
      );
      const replay = await svc.createWithOperator(
        input,
        {},
        null,
        (tx) => accessService(tx),
      );

      expect(replay.created).toBe(false);
      expect(replay.operatorId).toBe(first.operatorId);
      expect(replay.operatorId).not.toBe("board");
    });

    it("returns 409 for different details in one scope but permits the same key in another org", async () => {
      const creationRequestId = randomUUID();
      const originalName = `Original ${randomUUID()}`;
      const svc = companyService(db);
      await svc.createWithOperator(
        { name: originalName, organizationId: orgId, creationRequestId },
        {},
        ownerUserId,
        (tx) => accessService(tx),
      );
      await expect(
        svc.createWithOperator(
          { name: `Different ${randomUUID()}`, organizationId: orgId, creationRequestId },
          {},
          ownerUserId,
          (tx) => accessService(tx),
        ),
      ).rejects.toMatchObject({ status: 409 });

      const otherOrgId = randomUUID();
      await db.insert(organizations).values({
        id: otherOrgId,
        name: "Other Replay Scope",
        slug: `other-replay-${randomUUID()}`,
      });
      const otherScope = await svc.createWithOperator(
        { name: originalName, organizationId: otherOrgId, creationRequestId },
        {},
        ownerUserId,
        (tx) => accessService(tx),
      );
      expect(otherScope.created).toBe(true);
      expect(otherScope.company.organizationId).toBe(otherOrgId);
    });

    it("commits the company row AND the founder membership/role/org membership together on success, and runs Group-A seeders", async () => {
      const name = `Atomic Company ${randomUUID()}`;
      const svc = companyService(db);
      const { company, operatorId } = await svc.createWithOperator(
        { name, organizationId: orgId },
        { requestedByUserId: ownerUserId },
        ownerUserId,
        (tx) => accessService(tx),
      );

      expect(operatorId).toBe(ownerUserId);

      const companyRows = await db.select().from(companies).where(eq(companies.id, company.id));
      expect(companyRows).toHaveLength(1);

      // Owner company membership.
      const membership = await db
        .select()
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, company.id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, ownerUserId),
          ),
        );
      expect(membership).toHaveLength(1);
      expect(membership[0].membershipRole).toBe("owner");
      expect(membership[0].status).toBe("active");

      // Founder role.
      const role = await db
        .select()
        .from(userRoles)
        .where(
          and(
            eq(userRoles.companyId, company.id),
            eq(userRoles.userId, ownerUserId),
            eq(userRoles.role, "founder"),
          ),
        );
      expect(role).toHaveLength(1);

      // Org owner membership (tenant-level).
      const orgMembership = await db
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, orgId),
            eq(organizationMemberships.userId, ownerUserId),
          ),
        );
      expect(orgMembership).toHaveLength(1);
      expect(orgMembership[0].role).toBe("owner");

      // Group-A seeders ran post-commit: internal_agent_config (config dial) and
      // the Commander (kind='aoa') agent are both DB-only and unconditional.
      const config = await db
        .select()
        .from(internalAgentConfig)
        .where(eq(internalAgentConfig.companyId, company.id));
      expect(config).toHaveLength(1);

      const crewAgents = await db
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, company.id), eq(agents.kind, "aoa")));
      expect(crewAgents.length).toBeGreaterThan(0);
    });
  },
);
