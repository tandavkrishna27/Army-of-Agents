// packages/db/src/__tests__/sentinel-org-removal.integration.test.ts
//
// REAL embedded-postgres proof of the TEN-006b acceptance criterion: dropping the
// fail-OPEN sentinel DEFAULT on companies.organization_id (migration 0210) makes an
// Organization-omitting company INSERT FAIL CLOSED (NOT NULL, SQLSTATE 23502)
// instead of silently bucketing into the Default Org via the schema default.
//
// Three assertions, applied AFTER the full migration chain (0000..0210):
//   (a) companies.organization_id has NO column default
//       (information_schema.columns.column_default IS NULL) and is still NOT NULL
//       (is_nullable = 'NO').
//   (b) a raw `INSERT INTO companies (...)` that OMITS organization_id is REJECTED
//       with 23502 (not_null_violation) — fail closed.
//   (c) an EXPLICIT-org INSERT still SUCCEEDS — including one on the Default-Org
//       sentinel ('00000000-0000-0000-0000-000000000001'); a company that sits on
//       the sentinel org is a legitimate single-tenant row and is NOT invalid /
//       deleted (E2-D07: the sentinel's dual identity — the "blocker" is
//       admission-time, not row existence).
//
// Why real embedded-Postgres and not a schema-literal grep: only applying the
// generated 0210 migration against a real cluster proves the DEFAULT is actually
// gone AND that the NOT NULL now trips. A `.default(...)` removed from the .ts
// source without the emitted-and-applied migration would slip past a source
// assertion but fail here.
//
// RED (before the .default(...) is dropped + 0210 exists): (a) column_default is
// the sentinel value (not null) → assertion fails; (b) the org-omitting INSERT
// SUCCEEDS (buckets via the schema default) → captureReject throws "expected …
// rejected … but it succeeded". GREEN (after TEN-006b's schema edit + 0210): the
// default is gone and the org-omitting INSERT is rejected 23502.
//
// Gate: E2-D05 env-hatch. Runs automatically on Linux CI
// (process.platform !== "win32") and is Windows-runnable in place via
// AOA_RUN_WIN_INTEGRATION=1 — no source edit-and-restore. It is a `skipIf` (not the
// banned `X ? describe : describe.skip` ternary), so it satisfies the
// integration-test-hygiene meta-test. Boot uses initdbFlags UTF8/C so the cluster
// locale is safe; setupError is captured in beforeAll and re-thrown in the first
// `it` (fail closed).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { applyPendingMigrations } from "../client.js";

// The Default-Org sentinel value (mirror of @armyofagents/shared
// DEFAULT_ORGANIZATION_ID + migration 0188's seed). Seeded by 0188 so an explicit
// INSERT on it is FK-valid.
const SENTINEL_ORG = "00000000-0000-0000-0000-000000000001";

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

// Seeded once (beforeAll): one real (non-sentinel) Organization.
let realOrg = "";

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

// A minimal PostgresError-ish shape (postgres-js surfaces `code` + `column_name`).
type PgError = { code?: string; column_name?: string; constraint_name?: string; message?: string };

// Runs a statement expected to be REJECTED by a DB constraint and returns the
// error. If the statement SUCCEEDS (the RED state, or a regression), this throws —
// which is exactly the failing signal we want (no silent pass on a bypassed check).
async function captureReject(run: () => Promise<unknown>): Promise<PgError> {
  try {
    await run();
  } catch (e) {
    return e as PgError;
  }
  throw new Error(
    "expected the org-omitting INSERT to be rejected by the NOT NULL constraint, but it succeeded",
  );
}

async function seedOrg(slug: string): Promise<string> {
  const rows = await client<{ id: string }[]>`
    INSERT INTO organizations (id, name, slug, status, plan)
    VALUES (gen_random_uuid(), ${slug}, ${slug}, 'active', 'beta')
    RETURNING id`;
  return rows[0]!.id;
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-sentinel-org-removal-"));
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
    // Apply the WHOLE chain (0000..latest) — including 0210 which drops the
    // companies.organization_id sentinel DEFAULT.
    await applyPendingMigrations(connectionString);
    client = postgres(connectionString, { max: 1 });

    // One real, non-sentinel Organization for the positive control.
    realOrg = await seedOrg("tenant-real");
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[sentinel-org-removal] embedded-postgres setup failed:", err);
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

function guard(): void {
  if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
}

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "TEN-006b sentinel org default removal (fail-closed company insert)",
  () => {
    it("seeds a real (non-sentinel) organization and the sentinel default org exists", async () => {
      guard();
      expect(realOrg).not.toBe("");
      expect(realOrg).not.toBe(SENTINEL_ORG);
      // 0188 seeds the sentinel Default Org idempotently; it must be present so an
      // explicit-sentinel company INSERT (part c) is FK-valid.
      const rows = await client<{ id: string }[]>`
        SELECT id FROM organizations WHERE id = ${SENTINEL_ORG}`;
      expect(rows).toHaveLength(1);
    });

    // (a) No column default post-0210; still NOT NULL.
    it("companies.organization_id has NO column default and is still NOT NULL", async () => {
      guard();
      const rows = await client<{ column_default: string | null; is_nullable: string }[]>`
        SELECT column_default, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'companies' AND column_name = 'organization_id'`;
      expect(rows).toHaveLength(1);
      // RED before 0210: column_default = '00000000-…-000000000001'::uuid (not null).
      expect(rows[0]!.column_default).toBeNull();
      // The NOT NULL constraint is preserved (fail closed, not fail open).
      expect(rows[0]!.is_nullable).toBe("NO");
    });

    // (b) An org-omitting INSERT fails closed with 23502.
    it("rejects a raw INSERT that OMITS organization_id with 23502 (fail closed)", async () => {
      guard();
      // Explicit, unique issue_prefix so the ONLY reason for rejection is the
      // missing organization_id (issue_prefix carries a global unique index).
      const err = await captureReject(
        () =>
          client`INSERT INTO companies (id, name, issue_prefix)
                 VALUES (gen_random_uuid(), 'No-Org Co', 'NOORG')`,
      );
      expect(err.code).toBe("23502"); // not_null_violation
      expect(err.column_name).toBe("organization_id");
    });

    // (c) Explicit-org INSERTs still succeed — including on the sentinel Default Org.
    it("allows an EXPLICIT-org INSERT on the sentinel Default Org; the row is valid, not deleted", async () => {
      guard();
      const inserted = await client<{ id: string; organization_id: string }[]>`
        INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (gen_random_uuid(), ${SENTINEL_ORG}, 'Sentinel Default Co', 'SENT')
        RETURNING id, organization_id`;
      expect(inserted).toHaveLength(1);
      expect(inserted[0]!.organization_id).toBe(SENTINEL_ORG);

      // E2-D07: a company on the sentinel org is a legitimate single-tenant row —
      // it exists and is NOT treated as invalid/blocked at the row level.
      const found = await client<{ id: string }[]>`
        SELECT id FROM companies WHERE id = ${inserted[0]!.id}`;
      expect(found).toHaveLength(1);
    });

    it("allows an EXPLICIT-org INSERT on a normal (non-sentinel) organization", async () => {
      guard();
      const inserted = await client<{ id: string; organization_id: string }[]>`
        INSERT INTO companies (id, organization_id, name, issue_prefix)
        VALUES (gen_random_uuid(), ${realOrg}, 'Real Org Co', 'REALO')
        RETURNING id, organization_id`;
      expect(inserted).toHaveLength(1);
      expect(inserted[0]!.organization_id).toBe(realOrg);
    });
  },
);
