// packages/db/src/__tests__/revert-0188.integration.test.ts
//
// REAL embedded-postgres proof for the 0188 rollback ESCAPE HATCH
// (packages/db/src/revert-0188.ts). The sibling revert-0188-guard.test.ts only
// greps the source string — it never EXECUTES the revert, which is exactly why
// two dead-on-arrival bugs slipped through:
//   FIX A: `DROP TABLE organizations` (no CASCADE) aborts once later phases add
//          org FKs from other tables (provider_connections @ 0190,
//          execution_targets @ 0191). Being inside sql.begin, the whole revert
//          rolls back.
//   FIX B: `DELETE ... WHERE name = '0188_organizations.sql'` throws
//          `column "name" does not exist` — the drizzle journal is keyed by the
//          sha256 `hash` of the migration file, not a name.
//
// This test applies the FULL migration chain (through the tenant + provider +
// execution phases) against a real DB, seeds a single org + a company + rows in
// provider_connections/execution_targets that reference the org, then runs
// revert0188 and asserts the tenant schema is fully removed, the global uniques
// are restored, the provider/execution tables survive WITHOUT their org FK, and
// EXACTLY ONE journal row (the 0188 one, matched by the migrator's stored hash)
// is deleted. A negative case proves the single-org guard still refuses.
//
// Windows CI can't start embedded-postgres on the `runneradmin` runner (Issue
// #114), so this is gated `describe.skipIf(process.platform === "win32")`. To
// run locally on Windows, temporarily flip that to `describe.skipIf(false)` —
// the UTF-8 initdbFlags below make the cluster locale-safe. ALWAYS restore the
// win32 predicate before committing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { applyPendingMigrations } from "../client.js";
import { revert0188 } from "../revert-0188.js";

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
let client: ReturnType<typeof postgres>;
let setupError: unknown = null;
let hash0188 = "";
let connectionString = "";

async function allocatePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((err) => {
        if (err) return reject(err);
        if (!address || typeof address === "string") {
          return reject(new Error("Failed to allocate test port"));
        }
        resolve(address.port);
      });
    });
    server.on("error", reject);
  });
}

async function orgCount(): Promise<number> {
  const rows = await client<{ count: number }[]>`SELECT count(*)::int AS count FROM organizations`;
  return rows[0]!.count;
}
async function tableExists(name: string): Promise<boolean> {
  const rows = await client<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${name}
    ) AS ok`;
  return rows[0]!.ok === true;
}
async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await client<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
    ) AS ok`;
  return rows[0]!.ok === true;
}
async function indexExists(name: string): Promise<boolean> {
  const rows = await client<{ ok: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'i' AND c.relname = ${name}
    ) AS ok`;
  return rows[0]!.ok === true;
}
async function constraintExists(name: string): Promise<boolean> {
  const rows = await client<{ ok: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ${name}) AS ok`;
  return rows[0]!.ok === true;
}
async function journalCount(): Promise<number> {
  const rows = await client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  return rows[0]!.count;
}
async function journalRowsForHash(hash: string): Promise<number> {
  const rows = await client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE hash = ${hash}`;
  return rows[0]!.count;
}
// The sha256 of every migration ordered AFTER 0188 in the journal (0189..latest),
// computed the same way the migrator (and revert-0188's own helper) does — read
// the file, no normalization. Used by the positive test to DELETE those journal
// rows (simulating a "0188 is the newest applied migration" DB) so the revert's
// later-migration guard sees nothing applied after 0188 and proceeds.
async function laterMigrationHashes(): Promise<string[]> {
  const journalRaw = await readFile(
    new URL("../migrations/meta/_journal.json", import.meta.url),
    "utf8",
  );
  const journal = JSON.parse(journalRaw) as {
    entries?: Array<{ idx?: number; tag?: string }>;
  };
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const baseIdx = entries.find((entry) => entry.tag === "0188_organizations")?.idx ?? -1;
  const laterTags = entries
    .filter(
      (entry): entry is { idx: number; tag: string } =>
        typeof entry.idx === "number" &&
        entry.idx > baseIdx &&
        typeof entry.tag === "string",
    )
    .map((entry) => entry.tag);
  return Promise.all(
    laterTags.map(async (tag) => {
      const content = await readFile(
        new URL(`../migrations/${tag}.sql`, import.meta.url),
        "utf8",
      );
      return createHash("sha256").update(content).digest("hex");
    }),
  );
}
// The only concurrent work in the race test is revert connection A (blocked) and
// insert connection B (holding), so ANY ungranted lock in the cluster is A
// waiting — for the ACCESS EXCLUSIVE lock (with the fix) or for the DROP later in
// the txn (without it). Either way this is the signal that A has reached its
// blocking point and it is safe to commit B.
async function anyWaitingLock(): Promise<boolean> {
  const rows = await client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM pg_locks WHERE NOT granted`;
  return rows[0]!.count > 0;
}
async function waitForBlockedRevert(deadlineMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await anyWaitingLock()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for revert connection A to block on a lock");
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-revert-0188-integ-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    const port = await allocatePort();
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port,
      persistent: false,
      // Force UTF-8 so migration SQL with non-Latin1 chars applies; without this
      // initdb inherits the host locale (WIN1252 on Windows) and rejects them.
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    connectionString = `postgres://test:test@localhost:${port}/postgres`;
    // Apply the WHOLE chain (0000..latest) — this covers 0188 (organizations),
    // 0190 (provider_connections org FK) and 0191 (execution_targets org FK),
    // which is what actually exercises FIX A's dependent-FK path. 0188's own
    // migration seeds exactly one sentinel org, so the guard precondition holds.
    await applyPendingMigrations(connectionString);
    client = postgres(connectionString, { max: 1 });

    // Independently compute the sha256 the migrator stored for 0188 (same file,
    // same read path — no normalization) so the tests can prove FIX B's hash
    // DELETE targets the real row.
    const migration0188 = await readFile(
      new URL("../migrations/0188_organizations.sql", import.meta.url),
      "utf8",
    );
    hash0188 = createHash("sha256").update(migration0188).digest("hex");

    // Seed a company (organization_id defaults to the sentinel org) plus rows in
    // the two later-phase tables that carry an org FK, so DROP TABLE would abort
    // without FIX A's dynamic FK drop.
    const [{ id: orgId }] = await client<{ id: string }[]>`SELECT id FROM organizations LIMIT 1`;
    const [{ id: companyId }] = await client<{ id: string }[]>`
      INSERT INTO companies (organization_id, id, name, issue_prefix)
      VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'Revert Co', 'RVT')
      RETURNING id`;
    // auth_method 'oauth' satisfies both provider_connections shape CHECKs
    // (neither 'api_key' nor 'personal_subscription') so no secret_ref is needed.
    await client`
      INSERT INTO provider_connections (id, organization_id, company_id, provider, auth_method)
      VALUES (gen_random_uuid(), ${orgId}, ${companyId}, 'anthropic', 'oauth')`;
    await client`
      INSERT INTO execution_targets (id, organization_id, slug, kind, trust_class, scope, target_authority_key)
      VALUES (gen_random_uuid(), ${orgId}, 'et-1', 'local', 'trusted', 'organization', ${`organization:${orgId}`})`;
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[revert-0188] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (client) await client.end();
  } catch {
    /* ignore */
  }
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

describe.skipIf(process.platform === "win32")("revert0188 against a real applied migration chain", () => {
  // NEGATIVE first: it is non-destructive (rejects at the guard, before the
  // transaction), so it must run before the positive case drops the schema.
  it("refuses when more than one organization exists (one-way-door guard)", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    expect(await orgCount()).toBe(1);

    const [{ id: secondOrgId }] = await client<{ id: string }[]>`
      INSERT INTO organizations (id, name, slug, status, plan)
      VALUES (gen_random_uuid(), 'Second Tenant', 'second-tenant', 'active', 'beta')
      RETURNING id`;
    try {
      await expect(revert0188(client)).rejects.toThrow(/expected exactly 1 organization/i);
      // Nothing was touched: guard runs before hash-read + before sql.begin.
      expect(await tableExists("organizations")).toBe(true);
      expect(await columnExists("companies", "organization_id")).toBe(true);
      expect(await constraintExists("companies_organization_id_organizations_id_fk")).toBe(true);
      expect(await journalRowsForHash(hash0188)).toBe(1);
    } finally {
      await client`DELETE FROM organizations WHERE id = ${secondOrgId}`;
    }
  });

  // CONCURRENCY / TOCTOU: the destructive rollback must NOT proceed when a second
  // org commits AFTER the cheap pre-check. With the fix, revert connection A takes
  // an ACCESS EXCLUSIVE lock on organizations as its first in-txn statement and
  // blocks (B holds RowExclusive from an uncommitted insert); once B commits and
  // releases, A's post-lock RECHECK sees 2 orgs and REFUSES with the single-org
  // message — before any destructive statement runs. This test is non-vacuous by
  // construction: it asserts that EXACT refusal message, which ONLY the post-lock
  // recheck produces. Remove the LOCK+recheck and A instead runs the drops to
  // completion against the now-two-org table and RESOLVES (destroying both
  // tenants), so the /expected exactly 1 organization/ assertion fails — i.e. RED
  // without the lock, GREEN with it. Runs BEFORE the positive case (which drops
  // the schema); non-destructive on the happy path (cleans up its 2nd org).
  it("refuses under a concurrent org-insert race (ACCESS EXCLUSIVE lock closes the TOCTOU window)", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    expect(await orgCount()).toBe(1);

    // B: a separate reserved connection that inserts a 2nd org and leaves it
    // UNCOMMITTED, so B holds RowExclusive on organizations and the pre-check
    // above still sees exactly 1.
    const sqlB = postgres(connectionString, { max: 1 });
    // A: the revert connection. lock_timeout is a generous safety net so a stuck
    // test fails fast instead of hanging forever; on the happy path B commits and
    // releases A well before it fires.
    const sqlA = postgres(connectionString, { max: 1, connection: { lock_timeout: 10000 } });
    const rb = await sqlB.reserve();
    let revertPromise: Promise<void> | undefined;
    let bSettled = false;
    try {
      await rb.unsafe("BEGIN");
      await rb.unsafe(
        "INSERT INTO organizations (id, name, slug, status, plan) " +
          "VALUES (gen_random_uuid(), 'Concurrent Tenant', 'concurrent-tenant', 'active', 'beta')",
      );
      // Start the revert; it will block (on the ACCESS EXCLUSIVE lock with the
      // fix, or on a later DROP without it). Do NOT await yet.
      revertPromise = revert0188(sqlA);
      // Wait until A is actually blocked, THEN release B by committing — this is
      // exactly "a second tenant commits after the pre-check".
      await waitForBlockedRevert();
      await rb.unsafe("COMMIT");
      bSettled = true;

      // With the fix: A acquires the lock, rechecks, sees 2, refuses with the
      // single-org message BEFORE any destructive work. Without it: A resolves.
      await expect(revertPromise).rejects.toThrow(/expected exactly 1 organization/i);

      // No destructive work happened: the tenant schema + journal row are intact.
      expect(await tableExists("organizations")).toBe(true);
      expect(await columnExists("companies", "organization_id")).toBe(true);
      expect(await constraintExists("companies_organization_id_organizations_id_fk")).toBe(true);
      expect(await tableExists("organization_memberships")).toBe(true);
      expect(await journalRowsForHash(hash0188)).toBe(1);
    } finally {
      if (!bSettled) {
        try {
          await rb.unsafe("ROLLBACK");
        } catch {
          /* ignore */
        }
      }
      // Settle A on failure paths so no rejection goes unhandled.
      if (revertPromise) await revertPromise.catch(() => undefined);
      try {
        await rb.release();
      } catch {
        /* ignore */
      }
      await sqlB.end();
      await sqlA.end();
      // Restore the single-org precondition for the positive destructive test.
      try {
        await client`DELETE FROM organizations WHERE slug = 'concurrent-tenant'`;
      } catch {
        /* ignore (a proof run with the lock removed may have dropped the table) */
      }
    }
    expect(await orgCount()).toBe(1);
  });

  // FORWARD-CONSISTENCY guard: the beforeAll applied the FULL chain, so 0189..0196
  // are recorded as applied. Even with a single org, reverting now would delete
  // ONLY the 0188 journal row while the later phases stay applied — a forward
  // redeploy would then re-run 0188 alone and never restore the org FKs/indexes
  // those later phases added (which the revert's FK sweep drops), leaving a
  // permanently inconsistent schema. So revert0188 must REFUSE with the
  // later-migration message. RED before the guard (the old code proceeds and
  // corrupts migration state); GREEN with it. Non-destructive (rejects before any
  // destructive statement), so it runs BEFORE the positive case that drops the
  // schema, and it needs the later rows still present — i.e. before the positive
  // test deletes them.
  it("refuses when migrations after 0188 are still applied (forward-consistency guard)", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    expect(await orgCount()).toBe(1);
    // Sanity: at least one later phase (0190 provider_connections org FK) is applied.
    expect(await journalRowsForHash(hash0188)).toBe(1);
    expect(await constraintExists("provider_connections_organization_id_organizations_id_fk")).toBe(true);

    await expect(revert0188(client)).rejects.toThrow(/migrations after 0188 are applied/i);

    // Nothing was touched: the guard fires before any destructive statement.
    expect(await tableExists("organizations")).toBe(true);
    expect(await columnExists("companies", "organization_id")).toBe(true);
    expect(await constraintExists("companies_organization_id_organizations_id_fk")).toBe(true);
    expect(await constraintExists("provider_connections_organization_id_organizations_id_fk")).toBe(true);
    expect(await journalRowsForHash(hash0188)).toBe(1);
  });

  it("removes tenant schema, restores global uniques, and strips exactly the 0188 journal row", async () => {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);

    // Preconditions the migrator established.
    expect(await orgCount()).toBe(1);
    expect(await journalRowsForHash(hash0188)).toBe(1); // migrator stored the 0188 row by hash
    expect(await indexExists("companies_org_issue_prefix_idx")).toBe(false);
    expect(await indexExists("companies_issue_prefix_idx")).toBe(true);
    expect(await constraintExists("provider_connections_organization_id_organizations_id_fk")).toBe(true);
    expect(await constraintExists("execution_targets_organization_id_organizations_id_fk")).toBe(true);

    // Simulate a DB whose newest APPLIED migration is 0188: delete the 0189..latest
    // journal rows. Only the JOURNAL rows are removed — the SCHEMA + FKs those
    // phases created stay intact, so FIX-A's dependent-FK sweep is still exercised.
    // With no later hashes recorded, the forward-consistency guard sees nothing
    // applied after 0188 and allows the revert to run its FIX-A/FIX-B work.
    const later = await laterMigrationHashes();
    expect(later.length).toBeGreaterThan(0);
    await client`DELETE FROM drizzle.__drizzle_migrations WHERE hash = ANY(${later})`;
    // The later-phase FKs must still exist (we only deleted journal rows).
    expect(await constraintExists("provider_connections_organization_id_organizations_id_fk")).toBe(true);
    expect(await constraintExists("execution_targets_organization_id_organizations_id_fk")).toBe(true);

    const journalBefore = await journalCount();

    // FIX A + FIX B: this must RESOLVE (old code threw on DROP TABLE, then on the
    // name-column DELETE).
    await expect(revert0188(client)).resolves.toBeUndefined();

    // Tenant tables gone.
    expect(await tableExists("organizations")).toBe(false);
    expect(await tableExists("organization_memberships")).toBe(false);
    expect(await tableExists("organization_invitations")).toBe(false);
    // Tenant column gone; org-scoped index gone; global uniques restored.
    expect(await columnExists("companies", "organization_id")).toBe(false);
    expect(await indexExists("companies_org_issue_prefix_idx")).toBe(false);
    expect(await indexExists("companies_issue_prefix_idx")).toBe(true);
    expect(await indexExists("issues_identifier_idx")).toBe(true);
    // Later-phase tables survive (single-org rollback leaves their now-inert,
    // nullable organization_id columns in place) but their org FK is gone.
    expect(await tableExists("provider_connections")).toBe(true);
    expect(await tableExists("execution_targets")).toBe(true);
    expect(await constraintExists("provider_connections_organization_id_organizations_id_fk")).toBe(false);
    expect(await constraintExists("execution_targets_organization_id_organizations_id_fk")).toBe(false);
    expect(await columnExists("provider_connections", "organization_id")).toBe(true);
    expect(await columnExists("execution_targets", "organization_id")).toBe(true);

    // FIX B proof: EXACTLY the one 0188 row (matched by the migrator's hash) was
    // removed — journal count dropped by 1 and no row with that hash remains.
    const journalAfter = await journalCount();
    expect(journalBefore - journalAfter).toBe(1);
    expect(await journalRowsForHash(hash0188)).toBe(0);
  });
});
