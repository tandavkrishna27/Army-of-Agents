import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  applyPendingMigrations,
  authUsers,
  createDb,
  organizationMemberships,
  organizations,
  type Db,
} from "@armyofagents/db";
import { organizationAccessService } from "../services/organization-access.js";
import { createSelfServeOrganization } from "../services/organizations.js";
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
  "createSelfServeOrganization — atomicity (real PostgreSQL)",
  () => {
    let db: Db;
    const ownerUserId = `org-tx-owner-${randomUUID()}`;

    beforeAll(async () => {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-org-tx-"));
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
      // organization_memberships.user_id -> "user"(id) FK: seed a real user so the
      // happy-path owner-membership write satisfies the FK.
      const now = new Date();
      await db.insert(authUsers).values({
        id: ownerUserId,
        name: "Org Tx Owner",
        email: `${ownerUserId}@example.test`,
        createdAt: now,
        updatedAt: now,
      });
    }, 180_000);

    afterAll(async () => {
      try { if (pg) await pg.stop(); } catch { /* ignore */ }
      try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }, 60_000);

    it("rolls back the org insert when the owner-membership write fails (no orphan org)", async () => {
      const before = await db.select().from(organizations);
      const throwingFactory = (): Pick<
        ReturnType<typeof organizationAccessService>,
        "ensureOrgOwner"
      > => ({
        ensureOrgOwner: async () => {
          throw new Error("forced membership failure");
        },
      });
      await expect(
        createSelfServeOrganization(db, { name: "Rollback Co", ownerUserId }, throwingFactory),
      ).rejects.toThrow();
      const after = await db.select().from(organizations);
      // Atomicity: the org row inserted inside the tx is rolled back together with
      // the failed membership write — no orphan tenant remains.
      // NOTE: this proves the org insert rolls back when the membership write throws,
      // but because the injected fault IS the membership write, it does not by itself
      // prove ensureOrgOwner is bound to `tx` rather than the outer `db` — that binding
      // is asserted structurally by the happy-path test + the slug-retry test below.
      expect(after.length).toBe(before.length);
      expect(after.find((o) => o.name === "Rollback Co")).toBeUndefined();
    });

    it("commits the org row AND the owner membership together on success", async () => {
      const { organization: org } = await createSelfServeOrganization(
        db,
        { name: "Atomic Co", ownerUserId },
        organizationAccessService,
      );
      const otherOwnerUserId = `org-tx-other-owner-${randomUUID()}`;
      const now = new Date();
      await db.insert(authUsers).values({
        id: otherOwnerUserId,
        name: "Other Org Tx Owner",
        email: `${otherOwnerUserId}@example.test`,
        createdAt: now,
        updatedAt: now,
      });
      const { organization: otherOrg } = await createSelfServeOrganization(
        db,
        { name: "Other Atomic Co", ownerUserId: otherOwnerUserId },
        organizationAccessService,
      );
      const rows = await db.select().from(organizations).where(eq(organizations.id, org.id));
      expect(rows).toHaveLength(1);
      const membership = await db
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, org.id),
            eq(organizationMemberships.userId, ownerUserId),
          ),
        );
      expect(membership).toHaveLength(1);
      expect(membership[0].role).toBe("owner");
      expect(membership[0].status).toBe("active");

      const joinedMemberships = await organizationAccessService(db).listOrgMemberships(ownerUserId);
      expect(joinedMemberships).toContainEqual(expect.objectContaining({
        organizationId: org.id,
        organizationName: org.name,
        organizationSlug: org.slug,
      }));
      expect(joinedMemberships).not.toContainEqual(expect.objectContaining({
        organizationId: otherOrg.id,
        organizationName: otherOrg.name,
        organizationSlug: otherOrg.slug,
      }));
    });

    it("replays sequential and concurrent requests with the same creator, key, and payload", async () => {
      const creationRequestId = randomUUID();
      const name = `Replay Org ${randomUUID()}`;
      const create = () =>
        createSelfServeOrganization(
          db,
          { name, ownerUserId, creationRequestId },
          organizationAccessService,
        );

      const first = await create();
      const sequential = await create();
      const [concurrentA, concurrentB] = await Promise.all([create(), create()]);
      expect(new Set([
        first.organization.id,
        sequential.organization.id,
        concurrentA.organization.id,
        concurrentB.organization.id,
      ])).toEqual(new Set([first.organization.id]));
      expect(first.created).toBe(true);
      expect(sequential.created).toBe(false);
      expect(await db.select().from(organizations).where(eq(organizations.name, name)))
        .toHaveLength(1);
    });

    it("returns 409 for a different payload in one scope but permits the same key for another creator", async () => {
      const creationRequestId = randomUUID();
      const name = `Scoped Replay Org ${randomUUID()}`;
      await createSelfServeOrganization(
        db,
        { name, ownerUserId, creationRequestId },
        organizationAccessService,
      );
      await expect(
        createSelfServeOrganization(
          db,
          { name: `${name} changed`, ownerUserId, creationRequestId },
          organizationAccessService,
        ),
      ).rejects.toMatchObject({ status: 409 });

      const otherOwner = `org-replay-owner-${randomUUID()}`;
      const now = new Date();
      await db.insert(authUsers).values({
        id: otherOwner,
        name: "Other Org Replay Owner",
        email: `${otherOwner}@example.test`,
        createdAt: now,
        updatedAt: now,
      });
      const otherScope = await createSelfServeOrganization(
        db,
        { name, ownerUserId: otherOwner, creationRequestId },
        organizationAccessService,
      );
      expect(otherScope.created).toBe(true);
      expect(otherScope.organization.id).not.toBe(
        (await createSelfServeOrganization(
          db,
          { name, ownerUserId, creationRequestId },
          organizationAccessService,
        )).organization.id,
      );
    });

    it("retries with a fresh slug in a NEW transaction on a 23505 slug conflict (same name → acme, acme-2)", async () => {
      // Seed two real users so each attempt's owner-membership write satisfies the
      // organization_memberships.user_id -> "user"(id) FK.
      const now = new Date();
      const ownerA = `org-tx-slug-a-${randomUUID()}`;
      const ownerB = `org-tx-slug-b-${randomUUID()}`;
      await db.insert(authUsers).values([
        { id: ownerA, name: "Slug Owner A", email: `${ownerA}@example.test`, createdAt: now, updatedAt: now },
        { id: ownerB, name: "Slug Owner B", email: `${ownerB}@example.test`, createdAt: now, updatedAt: now },
      ]);

      // Same name twice: the first call takes slug "acme"; the second hits the
      // organizations_slug_uq 23505 INSIDE its transaction, which aborts+rolls back
      // ONLY that attempt's tx. The conflict is caught OUTSIDE the tx (isOrgSlugConflict)
      // and retried with "acme-2" in a brand-new transaction. Regression-guards the
      // slug-retry path now that the 23505 surfaces from inside db.transaction — a
      // future refactor of isOrgSlugConflict or the catch could silently break it.
      const { organization: orgA } = await createSelfServeOrganization(
        db,
        { name: "Acme", ownerUserId: ownerA },
        organizationAccessService,
      );
      const { organization: orgB } = await createSelfServeOrganization(
        db,
        { name: "Acme", ownerUserId: ownerB },
        organizationAccessService,
      );

      // (a) two distinct org rows with distinct slugs.
      expect(orgA.id).not.toBe(orgB.id);
      expect(orgA.slug).toBe("acme");
      expect(orgB.slug).toBe("acme-2");

      // (b) each org has its OWN owner membership for the correct user.
      for (const [org, owner] of [[orgA, ownerA], [orgB, ownerB]] as const) {
        const membership = await db
          .select()
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.organizationId, org.id),
              eq(organizationMemberships.userId, owner),
            ),
          );
        expect(membership).toHaveLength(1);
        expect(membership[0].role).toBe("owner");
        expect(membership[0].status).toBe("active");
      }
    });
  },
);
