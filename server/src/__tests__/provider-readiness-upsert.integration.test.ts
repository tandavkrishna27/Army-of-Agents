/**
 * End-to-end proof that `provider_readiness_scope_uq` + `nullsNotDistinct()`
 * actually work THROUGH the writer.
 *
 * The previous task could only assert the constraint statically, because no
 * writer existed yet. This is the behavioural half: two `company_default`
 * writes for the same (company, provider) must UPSERT, not duplicate.
 *
 * Postgres treats NULLs as distinct by default, so without `nullsNotDistinct()`
 * every default row (scope_id IS NULL) is unique, the ON CONFLICT target never
 * matches, and the cache silently accumulates duplicate rows with unstable
 * reads. That failure is invisible to a unit test with a mocked db.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import {
  recordReadiness,
  readReadiness,
  readReadinessForScope,
} from "../services/providers/readiness.js";

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
}) => EmbeddedPostgresInstance;

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db;
let setupError: unknown = null;

const PORT = 57000 + Math.floor(Math.random() * 1000);
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
/** A second tenant, so cross-company leakage is provable rather than assumed. */
const OTHER_COMPANY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-provider-readiness-test-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };

    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
    });
    await pg.initialise();
    await pg.start();

    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);

    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${COMPANY_ID}, 'Provider Readiness Co', 'PRC')
    `);
    await db.execute(sql`
      INSERT INTO companies (id, name, issue_prefix)
      VALUES (${OTHER_COMPANY_ID}, 'Other Tenant Co', 'OTC')
    `);
  } catch (err) {
    setupError = err;
  }
}, 180_000);

afterAll(async () => {
  try {
    if (pg) await pg.stop();
  } catch {
    // ignore cleanup failures
  }
  try {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures
  }
}, 60_000);

describe.skipIf(process.platform === "win32")(
  "provider_readiness_status upsert — real DB",
  () => {
    it("upserts the company_default row instead of duplicating it", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }

      await recordReadiness(db, {
        companyId: COMPANY_ID,
        providerId: "anthropic",
        scope: { type: "company_default" },
        outcome: "needs_auth",
        checks: [{ code: "claude_local_auth_required", level: "error", message: "sign in" }],
        testedByUserId: null,
      });

      await recordReadiness(db, {
        companyId: COMPANY_ID,
        providerId: "anthropic",
        scope: { type: "company_default" },
        outcome: "verified",
        checks: [{ code: "claude_local_hello_probe_passed", level: "info", message: "ok" }],
        testedByUserId: null,
      });

      const rows = await readReadiness(db, COMPANY_ID);
      const defaults = rows.filter(
        (r) => r.providerId === "anthropic" && r.scopeType === "company_default",
      );

      // Exactly ONE default row, carrying the SECOND write's outcome.
      expect(defaults).toHaveLength(1);
      expect(defaults[0]!.outcome).toBe("verified");
      expect(defaults[0]!.scopeId).toBeNull();
      expect(defaults[0]!.checks[0]!.code).toBe("claude_local_hello_probe_passed");
    });

    it("keeps an agent-scoped row separate from the company default", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }

      // Seeds its own preconditions: depending on an earlier test's write makes
      // a reorder or a `.only` fail as if scoping were broken.
      await recordReadiness(db, {
        companyId: COMPANY_ID,
        providerId: "google",
        scope: { type: "company_default" },
        outcome: "verified",
        checks: [],
        testedByUserId: null,
      });
      await recordReadiness(db, {
        companyId: COMPANY_ID,
        providerId: "google",
        scope: { type: "agent", agentId: AGENT_ID },
        outcome: "needs_auth",
        checks: [],
        testedByUserId: null,
      });

      const rows = await readReadiness(db, COMPANY_ID);
      const google = rows.filter((r) => r.providerId === "google");

      // The whole point of scoping: the company default can be verified while
      // this agent's own binding is revoked.
      expect(google).toHaveLength(2);
      expect(google.find((r) => r.scopeType === "company_default")!.outcome).toBe("verified");
      const agentRow = google.find((r) => r.scopeType === "agent")!;
      expect(agentRow.outcome).toBe("needs_auth");
      expect(agentRow.scopeId).toBe(AGENT_ID);
    });

    it("does not fall back to the company default for an unprobed agent", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }

      // A verified company default exists...
      await recordReadiness(db, {
        companyId: COMPANY_ID,
        providerId: "grok",
        scope: { type: "company_default" },
        outcome: "verified",
        checks: [],
        testedByUserId: null,
      });

      const def = await readReadinessForScope(db, COMPANY_ID, "grok", {
        type: "company_default",
      });
      expect(def!.outcome).toBe("verified");

      // ...but THIS agent was never probed. Answering with the default row
      // would render Ready for an agent that may 401 on its own binding.
      const agentRow = await readReadinessForScope(db, COMPANY_ID, "grok", {
        type: "agent",
        agentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      });
      expect(agentRow).toBeUndefined();
    });

    it("excludes another company's rows from a read", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }

      await recordReadiness(db, {
        companyId: OTHER_COMPANY_ID,
        providerId: "cursor",
        scope: { type: "company_default" },
        outcome: "verified",
        checks: [],
        testedByUserId: null,
      });

      const rowsA = await readReadiness(db, COMPANY_ID);
      expect(rowsA.some((r) => r.providerId === "cursor")).toBe(false);
      expect(rowsA.every((r) => r.companyId === COMPANY_ID)).toBe(true);

      // And the scoped accessor is tenant-keyed too: company A must not see
      // company B's row even asking for the exact same (provider, scope).
      const leaked = await readReadinessForScope(db, COMPANY_ID, "cursor", {
        type: "company_default",
      });
      expect(leaked).toBeUndefined();
    });

    it("persists REDACTED check text, not the raw CLI output", async () => {
      if (setupError) {
        throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
      }

      await recordReadiness(db, {
        companyId: COMPANY_ID,
        providerId: "openai",
        scope: { type: "company_default" },
        outcome: "failed",
        checks: [
          {
            code: "codex_local_auth_required",
            level: "error",
            message: "bad key sk-ant-abcdefghijklmnop1234567890",
          },
        ],
        testedByUserId: null,
      });

      // Read the raw column, bypassing the service, so this proves the stored
      // bytes are clean rather than the read path scrubbing them.
      const raw = await db.execute(sql`
        SELECT checks::text AS checks FROM provider_readiness_status
        WHERE company_id = ${COMPANY_ID} AND provider_id = 'openai'
      `);
      const stored = JSON.stringify(raw);
      expect(stored).not.toContain("sk-ant-abcdefghijklmnop1234567890");
      expect(stored).toContain("REDACTED");
    });
  },
);
