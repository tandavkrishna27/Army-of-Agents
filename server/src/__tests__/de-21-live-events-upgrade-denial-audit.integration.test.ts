/**
 * DE-21, audit clause — a refused live-events WebSocket upgrade is durably
 * distinguishable from a handshake that never happened, and ATTRIBUTABLE, on the
 * deny branches that have a DB-resolved tenant.
 *
 * ★ WHAT WAS THERE. `docs/architecture/distributed-execution-threat-controls.json`
 * DE-21 asserts "subscribe, replay and denial events are audited". A refused
 * upgrade called `rejectUpgrade`, whose entire body writes an HTTP status line to
 * the socket and destroys it — no row, no metric, no log line. The same file logs
 * at eight sites, including a `logger.error` that fires only when the
 * authorization function THREW. So an internal fault was loud and a cross-tenant
 * probe was silent. That is `E0-F010`, and it is what the arms below change for
 * four of the seven deny branches.
 *
 * ★ WHAT THIS FILE DOES NOT PROVE, first, because DE-21's clause is CONJUNCTIVE
 * and this delivers a fraction of one conjunct.
 *   - "subscribe" and "replay" events: NOT audited. Nothing here writes a row on
 *     a successful subscribe or on a replay, and no arm asserts one.
 *   - "denial events", board/session branches (`:293`, `:304`, `:311`, `:322`,
 *     `:358`): NOT audited. Four of them hold only a caller-supplied path
 *     segment; `:358` holds the actor's OTHER memberships, plural, possibly
 *     empty, and never the tenant that refused. They are `E0-F013`'s Decision 3
 *     and are asserted below to write NOTHING — they are this file's NAMED
 *     POSITIVE CONTROLS.
 *   - "denial events", the `!key` arm of `:376`: NOT audited. An unknown or
 *     revoked token matches no `agent_api_keys` row, so no DB-resolved company
 *     exists at all. This is the DOMINANT probe case and splitting it off the
 *     tenant-mismatch arm is the whole point: THE UNIT OF CORRECTION IS THE
 *     DISJUNCT, NOT THE BRANCH.
 *   DE-21 therefore stays OPEN and in `E0-F010`'s cohort. Nothing here closes it.
 *
 * ★ WHY THIS IS NOT A READ-BACK. Every arm calls the real `authorizeUpgrade`
 * against real PostgreSQL with the real committed migration chain, with a real
 * `agent_api_keys` row and a real `agents` row, and then asserts the durable row
 * the refusal itself left behind. No denial is constructed.
 *
 * ★ ATTRIBUTION IS THE ASSERTION, and the tenant half of it is the interesting
 * one: a cross-tenant probe must be filed under the KEY's own company, never
 * under the company it reached for, or the audit record becomes the disclosure
 * channel it exists to avoid (the DE-19 precedent). That is asserted separately
 * from "a row exists".
 *
 * Skipped on Windows CI by default (the `runneradmin` account cannot start
 * embedded-postgres — Issue #114); Linux CI `push` is the authoritative gate. On
 * a Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real. Harness
 * modeled on de-19-memory-denial-audit.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { authorizeUpgrade } from "../realtime/live-events-ws.js";
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
let db: Db;
let setupError: unknown = null;
let setupFailed = false;

function assertSetupOk(): void {
  const dbReady = (db as Db | undefined) !== undefined;
  if (!setupFailed && dbReady) return;
  throw new Error(
    `embedded-postgres setup failed (see the console.error above): ${
      setupError instanceof Error ? setupError.message : String(setupError)
    }`,
  );
}

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as { id: string })?.id;
  return (result as { rows?: { id: string }[] }).rows?.[0]?.id;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

/** Tenant A — owns the keys that are used as probes. */
let orgA = "";
let coA = "";
/** Tenant B — the tenant the probes reach FOR. It must learn nothing. */
let orgB = "";
let coB = "";

let liveAgent = "";
let terminatedAgent = "";
let pendingAgent = "";
/** An agent row whose company was moved out from under its key (revocation desync). */
let driftedAgent = "";
/** A key whose `agent_id` names a row that does not exist. */
let orphanKeyAgentId = "";

interface DenialRow {
  company_id: string;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown> | null;
}

async function upgradeDenialRows(): Promise<DenialRow[]> {
  return rowsOf<DenialRow>(
    await db.execute(sql`
      SELECT company_id, actor_type, actor_id, action, entity_type, entity_id, details
      FROM activity_log
      WHERE action = 'security.denied.live_events_upgrade'
      ORDER BY created_at ASC`),
  );
}

async function activityRowCount(companyId: string): Promise<number> {
  const rows = rowsOf<{ n: string }>(
    await db.execute(sql`SELECT count(*)::text AS n FROM activity_log WHERE company_id = ${companyId}`),
  );
  return Number(rows[0]?.n ?? "-1");
}

/** Mint a real `agent_api_keys` row and return the plaintext token. */
async function mintKey(opts: { agentId: string; companyId: string; name: string }): Promise<{
  token: string;
  keyId: string;
}> {
  const token = `aoa_${randomUUID()}`;
  const keyHash = createHash("sha256").update(token).digest("hex");
  const keyId = firstId(
    await db.execute<{ id: string }>(sql`
      INSERT INTO agent_api_keys (id, agent_id, company_id, name, key_hash)
      VALUES (gen_random_uuid(), ${opts.agentId}, ${opts.companyId}, ${opts.name}, ${keyHash})
      RETURNING id`),
  );
  return { token, keyId };
}

/** The real upgrade request shape: a bearer token on an `IncomingMessage`. */
function bearerReq(token: string): IncomingMessage {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as IncomingMessage;
}

function wsUrl(companyId: string): URL {
  return new URL(`http://localhost/api/companies/${companyId}/events/ws`);
}

const AGENT_OPTS = { deploymentMode: "authenticated" as const, trustedOrigins: ["http://localhost"] };

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-de21-upgrade-"));
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
    const connectionString = `postgres://test:test@localhost:${port}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
    setupFailed = true;
    // eslint-disable-next-line no-console
    console.error("[de21-upgrade-denial] embedded-postgres setup failed:", err);
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

describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")(
  "DE-21 audit clause — a refused live-events upgrade leaves an attributable durable record on the branches that have a tenant",
  () => {
    it("setup: two organizations, two companies, and four agent rows covering each refusing disjunct", async () => {
      assertSetupOk();

      orgA = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'DE-21 org A', 'de-021-a') RETURNING id`),
      );
      orgB = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'DE-21 org B', 'de-021-b') RETURNING id`),
      );
      coA = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (id, organization_id, name, issue_prefix)
          VALUES (gen_random_uuid(), ${orgA}, 'DE-21 Co A', 'D21A') RETURNING id`),
      );
      coB = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (id, organization_id, name, issue_prefix)
          VALUES (gen_random_uuid(), ${orgB}, 'DE-21 Co B', 'D21B') RETURNING id`),
      );
      const mkAgent = async (companyId: string, name: string, status: string): Promise<string> =>
        firstId(
          await db.execute<{ id: string }>(sql`
            INSERT INTO agents (id, company_id, name, kind, status)
            VALUES (gen_random_uuid(), ${companyId}, ${name}, 'org', ${status}) RETURNING id`),
        );
      liveAgent = await mkAgent(coA, "DE-21 live", "idle");
      terminatedAgent = await mkAgent(coA, "DE-21 terminated", "terminated");
      pendingAgent = await mkAgent(coA, "DE-21 pending", "pending_approval");
      driftedAgent = await mkAgent(coA, "DE-21 drifted", "idle");
      // The orphan case: an agent row that exists only long enough to hang a key
      // off, then is deleted. `agent_api_keys.agent_id` cascades on delete, so the
      // key has to be re-inserted afterwards — done in its own arm.
      orphanKeyAgentId = await mkAgent(coA, "DE-21 orphan", "idle");

      expect(await activityRowCount(coA)).toBe(0);
      expect(await activityRowCount(coB)).toBe(0);
    });

    // ───────────────────────────────────────────────────────────────────────
    // ★ THE CROSS-TENANT ARM — DE-21's whole subject.
    // ───────────────────────────────────────────────────────────────────────

    it("★ A LIVE KEY AIMED AT ANOTHER COMPANY IS REFUSED, and the refusal writes ONE row attributing WHO / TENANT / RESOURCE / WHY", async () => {
      assertSetupOk();
      const { token, keyId } = await mintKey({
        agentId: liveAgent,
        companyId: coA,
        name: "cross-tenant probe",
      });

      // POSITIVE CONTROL for the fixture: the branch really is reached, and the
      // wire answer is the same opaque refusal it always was.
      const ctx = await authorizeUpgrade(db, bearerReq(token), coB, wsUrl(coB), AGENT_OPTS);
      expect(ctx).toBeNull();

      const rows = await upgradeDenialRows();
      expect(rows).toHaveLength(1);
      // WHO — the agent the key names.
      expect(rows[0].actor_id).toBe(liveAgent);
      expect(rows[0].actor_type).toBe("agent");
      // ★ TENANT — the KEY's own company, resolved from `agent_api_keys`. NOT the
      // company that was probed. This is the assertion the whole design turns on.
      expect(rows[0].company_id).toBe(coA);
      expect(rows[0].company_id).not.toBe(coB);
      // RESOURCE — the stream that was asked for, which is the OTHER tenant's.
      expect(rows[0].entity_type).toBe("live_events_stream");
      expect(rows[0].entity_id).toBe(coB);
      // WHY — a stable machine code, plus the evidence the 403 could not carry.
      expect(rows[0].details?.reason).toBe("agent_key_tenant_mismatch");
      expect(rows[0].details?.crossing).toBe("DE-21");
      expect(rows[0].details?.requestedCompanyId).toBe(coB);
      expect(rows[0].details?.keyId).toBe(keyId);
      expect(rows[0].details?.transport).toBe("websocket");
    });

    it("★ THE PROBED TENANT LEARNS NOTHING — the cross-tenant probe wrote into the prober's own tenant and left tenant B's log empty", async () => {
      assertSetupOk();
      expect(await activityRowCount(coB)).toBe(0);
      expect(await activityRowCount(coA)).toBe(1);
    });

    // ───────────────────────────────────────────────────────────────────────
    // ★ THE `:395` DISJUNCTS — four of them, four codes, one unchanged 403.
    // Control only reaches them when `key` is non-null, which is what makes
    // every one of them attributable.
    // ───────────────────────────────────────────────────────────────────────

    it("★ A TERMINATED AGENT'S SURVIVING KEY IS REFUSED AND NAMED — `agent_terminated`, in the key's own tenant", async () => {
      assertSetupOk();
      const { token } = await mintKey({
        agentId: terminatedAgent,
        companyId: coA,
        name: "terminated agent key",
      });
      expect(await authorizeUpgrade(db, bearerReq(token), coA, wsUrl(coA), AGENT_OPTS)).toBeNull();

      const rows = await upgradeDenialRows();
      const row = rows[rows.length - 1];
      expect(row.details?.reason).toBe("agent_terminated");
      expect(row.company_id).toBe(coA);
      expect(row.actor_id).toBe(terminatedAgent);
      // The requested company here IS the key's own, so `entity_id` and
      // `company_id` coincide — the cross-tenant arm above is what tells them apart.
      expect(row.entity_id).toBe(coA);
      expect(row.details?.agentStatus).toBe("terminated");
    });

    it("★ REASON IS READ FROM THE DISJUNCT, NOT STAMPED — a `pending_approval` agent on the SAME path records a DIFFERENT code behind the SAME 403", async () => {
      assertSetupOk();
      const { token } = await mintKey({
        agentId: pendingAgent,
        companyId: coA,
        name: "pending agent key",
      });
      expect(await authorizeUpgrade(db, bearerReq(token), coA, wsUrl(coA), AGENT_OPTS)).toBeNull();

      const rows = await upgradeDenialRows();
      const row = rows[rows.length - 1];
      expect(row.details?.reason).toBe("agent_pending_approval");
      expect(row.details?.agentStatus).toBe("pending_approval");
      expect(row.actor_id).toBe(pendingAgent);
    });

    it("★ A KEY WHOSE AGENT MOVED TENANT IS REFUSED AND NAMED — `agent_key_company_drift`, with both companies in evidence", async () => {
      assertSetupOk();
      const { token } = await mintKey({
        agentId: driftedAgent,
        companyId: coA,
        name: "drifted agent key",
      });
      // The desync DE-21 exists for: the key still says tenant A, the agent row
      // has been moved to tenant B.
      await db.execute(sql`UPDATE agents SET company_id = ${coB} WHERE id = ${driftedAgent}`);
      expect(await authorizeUpgrade(db, bearerReq(token), coA, wsUrl(coA), AGENT_OPTS)).toBeNull();

      const rows = await upgradeDenialRows();
      const row = rows[rows.length - 1];
      expect(row.details?.reason).toBe("agent_key_company_drift");
      // Filed under the KEY's company, with the agent's new one as evidence.
      expect(row.company_id).toBe(coA);
      expect(row.details?.agentCompanyId).toBe(coB);
    });

    it("★ A KEY WHOSE AGENT ROW IS GONE IS REFUSED AND NAMED — `agent_missing`, with a null agent status rather than a fabricated one", async () => {
      assertSetupOk();
      const { token } = await mintKey({
        agentId: orphanKeyAgentId,
        companyId: coA,
        name: "orphan key",
      });
      // Break the reference the way a revocation desync does. `agent_api_keys`
      // cascades on agent delete, so the row is detached rather than deleted: the
      // key must survive its agent for this branch to be reachable at all.
      await db.execute(sql`
        ALTER TABLE agent_api_keys DROP CONSTRAINT IF EXISTS agent_api_keys_agent_id_agents_id_fk`);
      await db.execute(sql`DELETE FROM agents WHERE id = ${orphanKeyAgentId}`);

      expect(await authorizeUpgrade(db, bearerReq(token), coA, wsUrl(coA), AGENT_OPTS)).toBeNull();

      const rows = await upgradeDenialRows();
      const row = rows[rows.length - 1];
      expect(row.details?.reason).toBe("agent_missing");
      expect(row.company_id).toBe(coA);
      expect(row.details?.agentStatus).toBeNull();
      expect(row.details?.agentCompanyId).toBeNull();
    });

    // ───────────────────────────────────────────────────────────────────────
    // ★ THE NAMED POSITIVE CONTROLS — the branches this unit deliberately does
    // NOT record. They must stay green when the recorder is removed, and they
    // are what stops "always write a denial" from passing this file.
    // ───────────────────────────────────────────────────────────────────────

    it("POSITIVE CONTROL / THE `!key` ARM — an unknown token is refused and writes NOTHING (no key row means no DB-resolved company: Decision 3, not this unit)", async () => {
      assertSetupOk();
      const before = await upgradeDenialRows();
      const unknown = `aoa_${randomUUID()}`;
      expect(await authorizeUpgrade(db, bearerReq(unknown), coA, wsUrl(coA), AGENT_OPTS)).toBeNull();
      expect(
        await upgradeDenialRows(),
        "the `!key` arm now records — it must not, because the only company in hand is the caller-supplied path segment",
      ).toHaveLength(before.length);
    });

    it("POSITIVE CONTROL / THE `!key` ARM, REVOKED — a revoked key is refused and writes NOTHING (the SELECT filters on `revoked_at IS NULL`, so no row comes back)", async () => {
      assertSetupOk();
      const { token } = await mintKey({ agentId: liveAgent, companyId: coA, name: "revoked key" });
      await db.execute(sql`
        UPDATE agent_api_keys SET revoked_at = now()
        WHERE key_hash = ${createHash("sha256").update(token).digest("hex")}`);
      const before = await upgradeDenialRows();
      expect(await authorizeUpgrade(db, bearerReq(token), coA, wsUrl(coA), AGENT_OPTS)).toBeNull();
      expect(await upgradeDenialRows()).toHaveLength(before.length);
    });

    it("POSITIVE CONTROL / THE BOARD BRANCHES — a session-less cookie upgrade is refused and writes NOTHING (`:311`, Decision 3)", async () => {
      assertSetupOk();
      const before = await upgradeDenialRows();
      const req = { headers: { origin: "http://localhost" } } as unknown as IncomingMessage;
      const ctx = await authorizeUpgrade(db, req, coA, wsUrl(coA), {
        ...AGENT_OPTS,
        resolveSessionFromHeaders: async () => null,
      });
      expect(ctx).toBeNull();
      expect(await upgradeDenialRows()).toHaveLength(before.length);
    });

    it("POSITIVE CONTROL / `:358` — a session holder with NO memberships is refused and writes NOTHING, which is the measurement that keeps that branch out of this unit", async () => {
      assertSetupOk();
      const userId = `de21-user-${randomUUID()}`;
      const before = await upgradeDenialRows();
      const req = { headers: { origin: "http://localhost" } } as unknown as IncomingMessage;
      const ctx = await authorizeUpgrade(db, req, coA, wsUrl(coA), {
        ...AGENT_OPTS,
        resolveSessionFromHeaders: async () =>
          ({ user: { id: userId } }) as unknown as Awaited<
            ReturnType<NonNullable<Parameters<typeof authorizeUpgrade>[4]["resolveSessionFromHeaders"]>>
          >,
      });
      expect(ctx).toBeNull();
      // ★ THE POINT: `memberships` is EMPTY here, so there is no FK-valid company
      // in hand at all — which is why `:358` cannot be recorded by widening this
      // unit and is left to Decision 3's attribution rule.
      expect(await upgradeDenialRows()).toHaveLength(before.length);
    });

    it("POSITIVE CONTROL — a GRANTED upgrade writes NO denial row (so 'always write a denial' fails this file)", async () => {
      assertSetupOk();
      const { token } = await mintKey({ agentId: liveAgent, companyId: coA, name: "good key" });
      const before = await upgradeDenialRows();
      const ctx = await authorizeUpgrade(db, bearerReq(token), coA, wsUrl(coA), AGENT_OPTS);
      expect(ctx).not.toBeNull();
      expect(ctx?.actorType).toBe("agent");
      expect(await upgradeDenialRows()).toHaveLength(before.length);
    });

    it("★ EVERY ROW LANDED IN THE RESERVED NAMESPACE AND IN TENANT A, and tenant B — which was probed — still holds nothing", async () => {
      assertSetupOk();
      const rows = await upgradeDenialRows();
      expect(rows.length).toBe(5);
      for (const row of rows) {
        expect(row.action).toBe("security.denied.live_events_upgrade");
        expect(row.company_id).toBe(coA);
      }
      const reasons = new Set(rows.map((r) => r.details?.reason));
      expect(reasons).toEqual(
        new Set([
          "agent_key_tenant_mismatch",
          "agent_terminated",
          "agent_pending_approval",
          "agent_key_company_drift",
          "agent_missing",
        ]),
      );
      expect(await activityRowCount(coB)).toBe(0);
    });
  },
);
