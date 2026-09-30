/**
 * E0-F013 Decision 3.2 (slice 2) — the FOURTEEN tenant-less deny sites record to
 * the OPERATOR-ONLY sink (`company_id NULL`), and the write is BOUNDED.
 *
 * ★ WHAT THE FOUNDER RULED (2026-09-11, option (c) with a write bound). The six
 * `authorizeUpgrade` board/session/`!key` branches and the eight plugin-cloud-gate
 * branches resolve NO actor tenant, so a cross-tenant refusal at them cannot be
 * filed under a refusing tenant the way Class-1 rows are. They record instead to
 * the operator-only sink: `company_id NULL`, the caller-supplied requested company
 * in `entity_id` (evidence, never attribution), in the reserved
 * `security.denied.*` namespace so slice 1 already hides them from every
 * tenant-facing reader and `GET /instance/security-denials` shows them.
 *
 * ★ WHY THIS IS NOT A READ-BACK. Each DE-21 arm calls the REAL `authorizeUpgrade`
 * against real PostgreSQL and then asserts the durable row the refusal itself left
 * behind — no denial is constructed. The DE-16 arm drives the real
 * `recordCloudPluginDenial` wrapper the route helper calls.
 *
 * ★ THE BOUND is proven deterministically (injected clock + sink) in
 * `bounded-denial-recorder.test.ts`; this file proves the WIRING writes real
 * operator-sink rows and that they are operator-visible / tenant-invisible.
 *
 * Skipped on Windows CI by default (the `runneradmin` account cannot start
 * embedded-postgres — Issue #114); Linux CI is the authoritative gate. On a
 * Windows dev box set `AOA_RUN_WIN_INTEGRATION=1` to run it for real. Harness
 * modeled on de-21-live-events-upgrade-denial-audit.integration.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { authorizeUpgrade } from "../realtime/live-events-ws.js";
import { LIVE_EVENTS_UPGRADE_UNATTRIBUTED_SURFACE } from "../realtime/live-events-tenantless-denial-audit.js";
import {
  recordCloudPluginDenial,
  CLOUD_PLUGIN_EXECUTION_DENIAL_SURFACE,
} from "../services/cloud-plugin-denial-audit.js";
import { sharedBoundedDenialRecorder } from "../services/bounded-denial-recorder.js";
import { activityService } from "../services/activity.js";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
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

interface DenialRow {
  company_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown> | null;
}

async function unattributedUpgradeRows(): Promise<DenialRow[]> {
  return rowsOf<DenialRow>(
    await db.execute(sql`
      SELECT company_id, actor_type, actor_id, action, entity_type, entity_id, details
      FROM activity_log
      WHERE action = ${"security.denied." + LIVE_EVENTS_UPGRADE_UNATTRIBUTED_SURFACE}
      ORDER BY created_at ASC`),
  );
}

let coA = "";
let coB = "";

function bearerReq(token: string): IncomingMessage {
  return { headers: { authorization: `Bearer ${token}` } } as unknown as IncomingMessage;
}
function originReq(): IncomingMessage {
  return { headers: { origin: "http://localhost" } } as unknown as IncomingMessage;
}
function noOriginReq(): IncomingMessage {
  return { headers: {} } as unknown as IncomingMessage;
}
function wsUrl(companyId: string): URL {
  return new URL(`http://localhost/api/companies/${companyId}/events/ws`);
}
const TRUSTED = ["http://localhost"];
function sessionFor(userId: string | null) {
  return async (): Promise<BetterAuthSessionResult | null> =>
    (userId ? ({ user: { id: userId } } as unknown as BetterAuthSessionResult) : null);
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-d3-sink-"));
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
    // The wiring records through the shared process-wide recorder; reset its
    // in-memory buckets so a prior suite in this worker cannot perturb the counts.
    sharedBoundedDenialRecorder.reset();
  } catch (err) {
    setupError = err;
    setupFailed = true;
    // eslint-disable-next-line no-console
    console.error("[decision3-tenantless-sink] embedded-postgres setup failed:", err);
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
  "E0-F013 Decision 3.2 — the tenant-less deny sites record to the operator-only sink",
  () => {
    it("setup: two organizations and two companies", async () => {
      assertSetupOk();
      const orgA = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'D3 org A', 'd3-a') RETURNING id`),
      );
      const orgB = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO organizations (id, name, slug)
          VALUES (gen_random_uuid(), 'D3 org B', 'd3-b') RETURNING id`),
      );
      coA = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (id, organization_id, name, issue_prefix)
          VALUES (gen_random_uuid(), ${orgA}, 'D3 Co A', 'D3A') RETURNING id`),
      );
      coB = firstId(
        await db.execute<{ id: string }>(sql`
          INSERT INTO companies (id, organization_id, name, issue_prefix)
          VALUES (gen_random_uuid(), ${orgB}, 'D3 Co B', 'D3B') RETURNING id`),
      );
      expect(await unattributedUpgradeRows()).toHaveLength(0);
    });

    // ── DE-21: the SIX tenant-less authorizeUpgrade branches ─────────────────

    it("★ :297 no-session-resolver — refused, and records ONE operator-sink row (company NULL, requested company in entity_id)", async () => {
      assertSetupOk();
      const ctx = await authorizeUpgrade(db, noOriginReq(), coB, wsUrl(coB), {
        deploymentMode: "authenticated",
        trustedOrigins: TRUSTED,
        // no resolveSessionFromHeaders
      });
      expect(ctx).toBeNull();
      const rows = await unattributedUpgradeRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].company_id).toBeNull();
      expect(rows[0].action).toBe("security.denied.live_events_upgrade_unattributed");
      expect(rows[0].entity_id).toBe(coB);
      expect(rows[0].entity_type).toBe("live_events_stream");
      expect(rows[0].details?.reason).toBe("board_no_session_resolver");
      expect(rows[0].details?.crossing).toBe("DE-21");
      expect(rows[0].details?.requestedCompanyId).toBe(coB);
    });

    it("★ :308 untrusted/missing Origin — refused and recorded (board_untrusted_origin)", async () => {
      assertSetupOk();
      const ctx = await authorizeUpgrade(db, noOriginReq(), coB, wsUrl(coB), {
        deploymentMode: "authenticated",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders: sessionFor("u-1"),
      });
      expect(ctx).toBeNull();
      const rows = await unattributedUpgradeRows();
      expect(rows[rows.length - 1].details?.reason).toBe("board_untrusted_origin");
      expect(rows[rows.length - 1].company_id).toBeNull();
      expect(rows[rows.length - 1].entity_id).toBe(coB);
    });

    it("★ :315 session with no userId — refused and recorded (board_no_user)", async () => {
      assertSetupOk();
      const ctx = await authorizeUpgrade(db, originReq(), coB, wsUrl(coB), {
        deploymentMode: "authenticated",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders: sessionFor(null),
      });
      expect(ctx).toBeNull();
      const row = (await unattributedUpgradeRows()).at(-1)!;
      expect(row.details?.reason).toBe("board_no_user");
      expect(row.actor_id).toBe("anonymous");
    });

    it("★ :326 cloud_auth, no membership — refused and recorded, actor_id = the userId", async () => {
      assertSetupOk();
      const userId = `u-${randomUUID()}`;
      const ctx = await authorizeUpgrade(db, originReq(), coB, wsUrl(coB), {
        deploymentMode: "cloud_auth",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders: sessionFor(userId),
      });
      expect(ctx).toBeNull();
      const row = (await unattributedUpgradeRows()).at(-1)!;
      expect(row.details?.reason).toBe("board_no_cloud_membership");
      expect(row.actor_id).toBe(userId);
      expect(row.company_id).toBeNull();
    });

    it("★ :372 authenticated, no admin + no membership — refused and recorded (board_no_membership)", async () => {
      assertSetupOk();
      const userId = `u-${randomUUID()}`;
      const ctx = await authorizeUpgrade(db, originReq(), coB, wsUrl(coB), {
        deploymentMode: "authenticated",
        trustedOrigins: TRUSTED,
        resolveSessionFromHeaders: sessionFor(userId),
      });
      expect(ctx).toBeNull();
      const row = (await unattributedUpgradeRows()).at(-1)!;
      expect(row.details?.reason).toBe("board_no_membership");
      expect(row.actor_id).toBe(userId);
      expect(row.details?.membershipCount).toBe(0);
    });

    it("★ :400 `!key` unknown token — refused and recorded (agent_key_unknown), raw token never stored", async () => {
      assertSetupOk();
      const token = `aoa_${randomUUID()}`;
      const ctx = await authorizeUpgrade(db, bearerReq(token), coB, wsUrl(coB), {
        deploymentMode: "authenticated",
        trustedOrigins: TRUSTED,
      });
      expect(ctx).toBeNull();
      const row = (await unattributedUpgradeRows()).at(-1)!;
      expect(row.details?.reason).toBe("agent_key_unknown");
      expect(row.actor_type).toBe("agent");
      expect(row.actor_id).toBe("unknown");
      // The raw token must not appear anywhere in the row.
      expect(JSON.stringify(row)).not.toContain(token);
    });

    it("★ ALL SIX branches recorded, every row company NULL and in the reserved namespace", async () => {
      assertSetupOk();
      const rows = await unattributedUpgradeRows();
      expect(rows.length).toBe(6);
      const reasons = new Set(rows.map((r) => r.details?.reason));
      expect(reasons).toEqual(
        new Set([
          "board_no_session_resolver",
          "board_untrusted_origin",
          "board_no_user",
          "board_no_cloud_membership",
          "board_no_membership",
          "agent_key_unknown",
        ]),
      );
      for (const row of rows) {
        expect(row.company_id).toBeNull();
        expect(row.action).toBe("security.denied.live_events_upgrade_unattributed");
      }
    });

    it("POSITIVE CONTROL — the probed tenant's own activity feed does NOT return these rows (slice 1 hides them; they are company NULL anyway)", async () => {
      assertSetupOk();
      const tenantRows = await activityService(db).list({ companyId: coB });
      expect(tenantRows.map((r) => r.action)).not.toContain(
        "security.denied.live_events_upgrade_unattributed",
      );
    });

    it("★ THE COMPLEMENT — the operator reader surfaces the tenant-less rows (hidden, not lost)", async () => {
      assertSetupOk();
      const rows = await activityService(db).securityDenials({
        surface: LIVE_EVENTS_UPGRADE_UNATTRIBUTED_SURFACE,
      });
      expect(rows.length).toBe(6);
      for (const r of rows) {
        expect(r.companyId).toBeNull();
        expect(r.action).toBe("security.denied.live_events_upgrade_unattributed");
      }
    });

    // ── DE-16: the plugin-cloud-gate wrapper ─────────────────────────────────

    it("★ DE-16 recordCloudPluginDenial writes an operator-sink row (company NULL, caller-supplied company in entity_id)", async () => {
      assertSetupOk();
      await recordCloudPluginDenial(db, {
        requestedCompanyId: coA,
        pluginId: "some-plugin",
        sink: "loader",
        source: "direct",
        actorId: "board-user-1",
        sourceKey: "203.0.113.44",
        control: "server/src/routes/plugins.ts:rejectBlockedCloudExecution",
      });
      const rows = await activityService(db).securityDenials({
        surface: CLOUD_PLUGIN_EXECUTION_DENIAL_SURFACE,
      });
      expect(rows.length).toBe(1);
      expect(rows[0].companyId).toBeNull();
      expect(rows[0].action).toBe("security.denied.cloud_plugin_execution");
      expect(rows[0].entityId).toBe(coA);
      expect(rows[0].entityType).toBe("cloud_plugin_execution");
      expect((rows[0].details as Record<string, unknown>)?.reason).toBe(
        "cloud_plugin_execution_blocked",
      );
      expect((rows[0].details as Record<string, unknown>)?.pluginId).toBe("some-plugin");
    });
  },
);
