/**
 * Real-DB integration test for company-scoped issue-identifier resolution
 * (Codex PR #316 round-6 finding). Identifiers are PER-COMPANY
 * (`issues_identifier_idx` on (company_id, identifier)), so raw/imported data
 * can contain the same identifier in two companies even while the temporary
 * global route-prefix constraint gives those companies distinct prefixes.
 *
 * `issueService.getByIdentifierInCompany(companyId, id)` must return THIS
 * company's `ACM-1` — never the other org's. The old/global
 * `getByIdentifier(id)` filters on identifier alone; rather than resolve an
 * arbitrary row, it now REJECTS an ambiguous identifier with a 409 (LIMIT 2 →
 * throw when two rows come back). This closes the wrong-task-mutation risk for
 * a dual-org member on the bare `/issues/:id…` routes (which carry no company
 * in the URL); we assert the global call throws `{ status: 409 }`.
 *
 * Skipped off Linux (embedded-postgres / migration-chain, Issue #114); Linux CI
 * is the authoritative gate. `initdbFlags` are baked into the EmbeddedPostgres
 * ctor (committed), so the suite is Windows-runnable by temporarily flipping
 * `describe.skipIf(process.platform !== "linux")` to `describe.skipIf(false)`
 * (do NOT commit that edit), then reverting.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { issueService } from "../services/issues.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string; user: string; password: string; port: number; persistent: boolean; initdbFlags?: string[];
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let svc: ReturnType<typeof issueService>;
let setupError: unknown = null;

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as { id: string })?.id;
  return (result as { rows?: Array<{ id: string }> }).rows?.[0]?.id as string;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-issue-id-scope-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocateEmbeddedPgPort();
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
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
    svc = issueService(db);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[issue-identifier-company-scope] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try { if (pg) await pg.stop(); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe.skipIf(process.platform !== "linux")(
  "issueService identifier resolution — company-scoped vs global (multi-org ACM-1)",
  () => {
    let orgAId: string;
    let orgBId: string;
    let companyAId: string;
    let companyBId: string;
    let issueAId: string;
    let issueBId: string;
    let issueA2Id: string;

    it("setup: two orgs with distinct route prefixes but the same stored issue identifier", async () => {
      if (setupError) {
        throw new Error(
          `embedded-postgres setup failed; cannot run integration test: ${String(setupError)}`,
        );
      }
      orgAId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO organizations (id, name, slug) VALUES (gen_random_uuid(), 'Org A', 'org-a-idscope') RETURNING id
      `));
      orgBId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO organizations (id, name, slug) VALUES (gen_random_uuid(), 'Org B', 'org-b-idscope') RETURNING id
      `));

      // Route prefixes are globally unique until company-qualified URLs ship.
      companyAId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO companies (id, name, issue_prefix, organization_id)
        VALUES (gen_random_uuid(), 'ACME (org A)', 'ACM', ${orgAId}) RETURNING id
      `));
      companyBId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO companies (id, name, issue_prefix, organization_id)
        VALUES (gen_random_uuid(), 'ACME (org B)', 'ACMB', ${orgBId}) RETURNING id
      `));

      // Both companies have an issue ACM-1 — legal because identifiers are
      // per-company (issues_identifier_idx is on (company_id, identifier)).
      issueAId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO issues (id, company_id, title, identifier)
        VALUES (gen_random_uuid(), ${companyAId}, 'Company A task', 'ACM-1') RETURNING id
      `));
      issueBId = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO issues (id, company_id, title, identifier)
        VALUES (gen_random_uuid(), ${companyBId}, 'Company B task', 'ACM-1') RETURNING id
      `));

      // ACM-2 lives in company A ONLY — single-tenant identifier: the global
      // (undefined = all-access) resolve must still return it (no collision).
      issueA2Id = firstId(await db.execute<{ id: string }>(sql`
        INSERT INTO issues (id, company_id, title, identifier)
        VALUES (gen_random_uuid(), ${companyAId}, 'Company A task 2', 'ACM-2') RETURNING id
      `));

      expect(companyAId).toBeTruthy();
      expect(companyBId).toBeTruthy();
      expect(issueAId).toBeTruthy();
      expect(issueBId).toBeTruthy();
      expect(issueA2Id).toBeTruthy();
      expect(issueAId).not.toBe(issueBId);
    });

    it("getByIdentifierInCompany(A, 'ACM-1') returns company A's issue (never B's)", async () => {
      if (setupError) throw new Error(String(setupError));
      const issue = await svc.getByIdentifierInCompany(companyAId, "ACM-1");
      expect(issue?.id).toBe(issueAId);
      expect(issue?.companyId).toBe(companyAId);
    });

    it("getByIdentifierInCompany(B, 'ACM-1') returns company B's issue (never A's)", async () => {
      if (setupError) throw new Error(String(setupError));
      const issue = await svc.getByIdentifierInCompany(companyBId, "ACM-1");
      expect(issue?.id).toBe(issueBId);
      expect(issue?.companyId).toBe(companyBId);
    });

    it("getByIdentifierInCompany lowercases input safely (case-insensitive)", async () => {
      if (setupError) throw new Error(String(setupError));
      const issue = await svc.getByIdentifierInCompany(companyAId, "acm-1");
      expect(issue?.id).toBe(issueAId);
    });

    it("getByIdentifierInCompany returns null when the identifier is absent in that company", async () => {
      if (setupError) throw new Error(String(setupError));
      const issue = await svc.getByIdentifierInCompany(companyAId, "ACM-999");
      expect(issue).toBeNull();
    });

    it("global getByIdentifier('ACM-1') (undefined = all-access sentinel) throws 409 when the identifier collides across companies (reject-ambiguous)", async () => {
      if (setupError) throw new Error(String(setupError));
      await expect(svc.getByIdentifier("ACM-1")).rejects.toMatchObject({ status: 409 });
    });

    it("scoped getByIdentifier('ACM-1', [A]) resolves company A's issue (no 409, no cross-tenant leak)", async () => {
      if (setupError) throw new Error(String(setupError));
      const issue = await svc.getByIdentifier("ACM-1", [companyAId]);
      expect(issue?.id).toBe(issueAId);
      expect(issue?.companyId).toBe(companyAId);
    });

    it("scoped getByIdentifier('ACM-1', [B]) resolves company B's issue", async () => {
      if (setupError) throw new Error(String(setupError));
      const issue = await svc.getByIdentifier("ACM-1", [companyBId]);
      expect(issue?.id).toBe(issueBId);
      expect(issue?.companyId).toBe(companyBId);
    });

    it("scoped getByIdentifier('ACM-1', [A, B]) still throws 409 (ambiguous within the accessible set)", async () => {
      if (setupError) throw new Error(String(setupError));
      await expect(svc.getByIdentifier("ACM-1", [companyAId, companyBId])).rejects.toMatchObject({
        status: 409,
      });
    });

    it("scoped getByIdentifier('ACM-1', []) returns null (actor can access nothing)", async () => {
      if (setupError) throw new Error(String(setupError));
      const issue = await svc.getByIdentifier("ACM-1", []);
      expect(issue).toBeNull();
    });

    it("single-tenant preservation: global getByIdentifier('ACM-2') resolves the only company that owns it", async () => {
      if (setupError) throw new Error(String(setupError));
      const issue = await svc.getByIdentifier("ACM-2");
      expect(issue?.id).toBe(issueA2Id);
      expect(issue?.companyId).toBe(companyAId);
    });

    it("getById returns null (not a 22P02 throw) for a non-UUID id", async () => {
      // The bare `/issues/:id…` param-normalizer passes the RAW identifier
      // through to getById when getByIdentifier scopes to zero accessible rows
      // (a member of company A hitting `ACM-1` that lives only in company B, or a
      // nonexistent `ACM-999`). A non-UUID id must resolve to null → the route's
      // not-found (404) path, never letting eq(issues.id, <non-uuid>) throw
      // Postgres 22P02 (invalid uuid syntax) → an un-statused 500.
      if (setupError) throw new Error(String(setupError));
      await expect(svc.getById("ACM-1")).resolves.toBeNull();
      await expect(svc.getById("not-a-uuid")).resolves.toBeNull();
    });
  },
);
