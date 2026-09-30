// packages/db/src/__tests__/execution-targets-org-delete-cascade.integration.test.ts
//
// REAL embedded-postgres proof that deleting an organization CASCADE-deletes its
// dedicated execution_targets rows instead of PROMOTING them to system rows.
//
// Security property (why a schema-literal "FK is cascade" assertion is VACUOUS):
// `organization_id IS NULL` is the security-defining "system/shared, operator-
// trusted" signal — such rows are cross-tenant visible and may carry a custom
// network/isolation profile. The FK used to be ON DELETE SET NULL, so deleting an
// org would silently NULL its dedicated tenant targets' organization_id, PROMOTING
// them into trusted shared infra. Only a real DELETE against a real applied chain
// proves the row is GONE (0 rows) rather than surviving with organization_id NULL.
//
// This test applies the FULL migration chain (through 0196), seeds one org + a
// dedicated_worker target that references it (and a system NULL-org target), then
// `DELETE FROM organizations WHERE id = <org>` and asserts:
//   - the dedicated target is GONE (0 rows) — not surviving with org NULL;
//   - the system (NULL-org) target SURVIVES the org delete (never a child of the
//     org, so never cascaded).
//
// RED/GREEN: against the pre-0196 chain (ON DELETE SET NULL) the org delete leaves
// the dedicated target alive with organization_id = NULL, so the "0 rows"
// assertion FAILS (RED). After the fix + migration 0196 (ON DELETE CASCADE) the
// row is deleted and it passes (GREEN).
//
// Windows CI can't start embedded-postgres on the `runneradmin` runner (Issue
// #114), so this is gated `describe.skipIf(process.platform === "win32")`. To run
// locally on Windows, temporarily flip that to `describe.skipIf(false)` — the
// UTF-8 initdbFlags below make the cluster locale-safe. ALWAYS restore the win32
// predicate before committing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { applyPendingMigrations } from "../client.js";

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

async function targetCount(id: string): Promise<number> {
  const rows = await client<{ count: number }[]>`
    SELECT count(*)::int AS count FROM execution_targets WHERE id = ${id}`;
  return rows[0]!.count;
}
async function targetOrgId(id: string): Promise<string | null> {
  const rows = await client<{ organization_id: string | null }[]>`
    SELECT organization_id FROM execution_targets WHERE id = ${id}`;
  return rows[0] ? rows[0].organization_id : null;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-exec-target-cascade-integ-"));
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
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    // Apply the WHOLE chain (0000..latest) — including 0196, which flips the
    // execution_targets org FK to ON DELETE CASCADE.
    await applyPendingMigrations(connectionString);
    client = postgres(connectionString, { max: 1 });
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[exec-target-cascade] embedded-postgres setup failed:", err);
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

describe.skipIf(process.platform === "win32")(
  "deleting an organization cascades its dedicated execution_targets",
  () => {
    it("removes the org's dedicated target (0 rows) and leaves system NULL-org targets intact", async () => {
      if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);

      // A fresh tenant org with NOTHING else pointing at it, so its DELETE only
      // has execution_targets as a child (isolates the cascade under test).
      const [{ id: orgId }] = await client<{ id: string }[]>`
        INSERT INTO organizations (id, name, slug, status, plan)
        VALUES (gen_random_uuid(), 'Cascade Tenant', 'cascade-tenant', 'active', 'beta')
        RETURNING id`;

      // A dedicated tenant target bound to that org (the row that MUST NOT survive
      // as a promoted NULL-org system row).
      const [{ id: dedicatedId }] = await client<{ id: string }[]>`
        INSERT INTO execution_targets (id, organization_id, slug, kind, trust_class)
        VALUES (gen_random_uuid(), ${orgId}, 'cascade-dedicated', 'dedicated_worker', 'dedicated_tenant')
        RETURNING id`;

      // A system/shared target (organization_id IS NULL) — never a child of any
      // org, so the org delete must NOT touch it.
      const [{ id: systemId }] = await client<{ id: string }[]>`
        INSERT INTO execution_targets (id, organization_id, slug, kind, trust_class)
        VALUES (gen_random_uuid(), NULL, 'cascade-system', 'pooled_gvisor', 'shared_multitenant')
        RETURNING id`;

      // Preconditions: both rows exist; the dedicated row carries the org FK.
      expect(await targetCount(dedicatedId)).toBe(1);
      expect(await targetOrgId(dedicatedId)).toBe(orgId);
      expect(await targetCount(systemId)).toBe(1);
      expect(await targetOrgId(systemId)).toBeNull();

      // Delete the org (nothing else references it).
      await client`DELETE FROM organizations WHERE id = ${orgId}`;

      // CASCADE: the dedicated target is GONE — NOT surviving with org NULL. Under
      // the old ON DELETE SET NULL this asserts RED (row alive, org NULL).
      expect(await targetCount(dedicatedId)).toBe(0);

      // The system NULL-org target survives untouched.
      expect(await targetCount(systemId)).toBe(1);
      expect(await targetOrgId(systemId)).toBeNull();
    });
  },
);
