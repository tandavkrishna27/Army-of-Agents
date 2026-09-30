/**
 * DE-16, `audit` clause — RECONCILIATIONS CONJUNCT. A cloud-plugin boot
 * reconciliation-to-blocked is durable and attributable.
 *
 * ★ WHAT THIS TEST IS FOR, AND THE PREMISE IT RETIRES.
 * `docs/architecture/distributed-execution-threat-controls.json` DE-16 asserts
 * that "blocked plugin routes, dispatch, and reconciliations are audited". The
 * clause is a CONJUNCTION. The route + dispatch half is delivered by E0-F013
 * Decision 3.2 (`recordCloudPluginDenial` -> `security.denied.cloud_plugin_execution`).
 * The RECONCILIATIONS conjunct was not: `reconcileCloudBlockedPlugins`
 * (`server/src/services/plugin-lifecycle.ts`) flips every stale non-uninstalled
 * `plugins` row to the blocked, metadata-only state at `cloud_auth` boot and
 * called only `recordCloudPluginBootReconciled` — a PROCESS-MEMORY counter that
 * resets on every restart. No durable row was written, so a reboot that
 * reconciled a company's stale `ready` plugin to blocked left EXACTLY the same
 * trace as a boot that reconciled nothing. That is the gap this file proves
 * closed.
 *
 * ★★★ WHAT THIS FILE DOES NOT PROVE — first, because DE-16's clause is a
 * conjunction and a delivered conjunct is not the conjunction.
 *   - the ROUTE + DISPATCH conjuncts are delivered separately (under
 *     `security.denied.`, see `cloud-plugin-denial-audit.ts`), and NOTHING below
 *     asserts a denial row on their behalf.
 *   - DE-16's non-audit clauses (confidentiality/TTL, revocation's other halves,
 *     REL-005) are untouched here.
 *   ⇒ **DE-16 DOES NOT CLOSE ON THIS FILE AND STAYS `partial`.**
 *
 * ★ WHY THIS IS NOT A READ-BACK. This file never constructs a reconciliation
 * record. It drives the REAL boot function `reconcileCloudBlockedPlugins(db)` —
 * the exact function `server/src/index.ts` calls at `cloud_auth` startup — over
 * a real embedded Postgres with the committed migration chain, against a real
 * seeded `plugins` row, and then asserts the durable row the function itself
 * left behind. A read-back verifies what was DECLARED, never what is ENFORCED
 * (the measured lesson of DE-08).
 *
 * ★ ATTRIBUTION IS THE ASSERTION. A row saying "a reconciliation happened"
 * satisfies no crossing, so each question is asserted separately:
 *   WHO      -> actor_type "system" / actor_id the stable boot identity
 *   TENANT   -> company_id the reconciled plugin's own FK-valid company, org null
 *   RESOURCE -> entity_type "plugin" / entity_id the reconciled plugin id
 *   WHAT     -> details.priorStatus (moved FROM) + statusReasonCode (moved TO)
 *
 * ★ THE MUTATION ARMS THAT MUST BITE. Drop-the-write reds "THE RECORD" (the
 * row-present + field assertions). A wrong action namespace reds "NOT A DENIAL".
 * A wrong entity_id / actor_type reds the attribution assertions in "THE RECORD".
 * The IDEMPOTENCY arm reds if the reconciler ever double-writes on a re-boot.
 *
 * Real Postgres (embedded-postgres + the committed migration chain) via
 * `createDb` — the OWNER connection, which is the exact connection
 * `server/src/index.ts` passes to `reconcileCloudBlockedPlugins` at boot
 * (`db = createDb(...)`).
 *
 * Skipped on Windows CI by default (the `runneradmin` account cannot start
 * embedded-postgres — Issue #114); on a Windows dev box set
 * `AOA_RUN_WIN_INTEGRATION=1` to run it for real. Linux CI `push` is the
 * authoritative gate. Harness modeled on `plugin-broker-cloud.integration.test.ts`
 * (createDb) and `de-11-retention-audit.integration.test.ts` (audit read-back).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";
import { setDeploymentMode } from "../config/deployment-mode.js";
import {
  reconcileCloudBlockedPlugins,
  reconcileOnePluginToBlocked,
} from "../services/plugin-lifecycle.js";
import {
  CLOUD_PLUGIN_BLOCK_MESSAGE,
  PLUGIN_WORKER_BLOCKED_IN_CLOUD,
  isCloudPluginExecutionBlocked,
} from "../services/cloud-plugin-execution.js";
import {
  CLOUD_PLUGIN_BOOT_RECONCILE_ACTOR,
  CLOUD_PLUGIN_RECONCILE_ACTION,
  type RecordCloudPluginReconcileToBlocked,
} from "../services/cloud-plugin-reconcile-audit.js";
import {
  SECURITY_DENIAL_ACTION_PREFIX,
  SECURITY_RECONCILE_ACTION_PREFIX,
} from "../services/activity-namespace.js";
import type { PaperclipPluginManifestV1 } from "@armyofagents/shared";

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

interface AuditRow {
  company_id: string | null;
  organization_id: string | null;
  actor_type: string;
  actor_id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown> | null;
}

const PLUGIN_KEY = "acme.reconcile";
const SEEDED_STATUS = "ready";

const MANIFEST: PaperclipPluginManifestV1 = {
  id: PLUGIN_KEY,
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Acme Reconcile Plugin",
  description: "A minimal plugin used to provoke a boot reconciliation-to-blocked",
  author: "test",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "worker.js" },
};

function firstId(result: unknown): string {
  if (Array.isArray(result)) return (result[0] as { id: string })?.id;
  return (result as { rows?: { id: string }[] }).rows?.[0]?.id;
}

let pg: EmbeddedPostgresInstance | null = null;
let dataDir = "";
let db: Db | undefined;
let setupError: unknown = null;
let setupFailed = false;

let companyId = "";
let pluginId = "";

function assertSetupOk(): void {
  if (!setupFailed && db !== undefined) return;
  throw new Error(
    `embedded-postgres setup failed (see the console.error above): ${
      setupError instanceof Error ? setupError.message : String(setupError)
    }`,
  );
}

function ctxDb(): Db {
  assertSetupOk();
  return db as Db;
}

/** Every reconciliation-namespace row for one plugin. */
async function reconcileRowsFor(entityId: string): Promise<AuditRow[]> {
  const res = await ctxDb().execute<AuditRow>(sql`
    SELECT company_id, organization_id, actor_type, actor_id, action, entity_type, entity_id, details
    FROM activity_log
    WHERE entity_id = ${entityId} AND action LIKE ${`${SECURITY_RECONCILE_ACTION_PREFIX}%`}
    ORDER BY created_at`);
  return (Array.isArray(res) ? res : (res as { rows?: AuditRow[] }).rows) ?? [];
}

/** Count of reconciliation-namespace rows for a company. */
async function reconcileRowCount(): Promise<number> {
  const res = await ctxDb().execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM activity_log
    WHERE company_id = ${companyId} AND action LIKE ${`${SECURITY_RECONCILE_ACTION_PREFIX}%`}`);
  const rows = (Array.isArray(res) ? res : (res as { rows?: { n: string }[] }).rows) ?? [];
  return Number(rows[0]?.n ?? "-1");
}

/** Rows in the DENIAL namespace, company-wide. The separation control. */
async function denialRowCount(): Promise<number> {
  const res = await ctxDb().execute<{ n: string }>(sql`
    SELECT count(*)::text AS n FROM activity_log
    WHERE company_id = ${companyId} AND action LIKE ${`${SECURITY_DENIAL_ACTION_PREFIX}%`}`);
  const rows = (Array.isArray(res) ? res : (res as { rows?: { n: string }[] }).rows) ?? [];
  return Number(rows[0]?.n ?? "-1");
}

type PluginStatusRow = { status: string; status_reason_code: string | null; last_error: string | null };

async function pluginStatusById(id: string): Promise<PluginStatusRow | null> {
  const res = await ctxDb().execute<PluginStatusRow>(sql`
    SELECT status, status_reason_code, last_error FROM plugins WHERE id = ${id} LIMIT 1`);
  const rows = (Array.isArray(res) ? res : (res as { rows?: PluginStatusRow[] }).rows) ?? [];
  return rows[0] ?? null;
}

async function pluginRow(): Promise<PluginStatusRow | null> {
  return pluginStatusById(pluginId);
}

/** Seed an independent plugin row (unique key) for the shared company. */
async function seedPlugin(pluginKey: string, status: string): Promise<string> {
  return firstId(
    await ctxDb().execute<{ id: string }>(sql`
      INSERT INTO plugins (id, company_id, plugin_key, package_name, version, api_version, categories, manifest_json, status, trust_tier)
      VALUES (
        gen_random_uuid(), ${companyId}, ${pluginKey}, ${`aoa-plugin-${pluginKey.replace(/\./g, "-")}`}, '1.0.0', 1,
        ${JSON.stringify(["automation"])}::jsonb,
        ${JSON.stringify({ ...MANIFEST, id: pluginKey })}::jsonb,
        ${status}, 'trusted'
      )
      RETURNING id`),
  );
}

beforeAll(async () => {
  try {
    dataDir = await mkdtemp(join(tmpdir(), "aoa-de016-"));
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

    // The Default Organization (00000000-…-0001) is seeded by migration 0188, so
    // a company can reference it directly. One company, one plugin, seeded in a
    // NON-blocked status so the reconciler has real work to do.
    companyId = firstId(
      await db.execute<{ id: string }>(sql`
        INSERT INTO companies (organization_id, id, name, issue_prefix)
        VALUES ('00000000-0000-0000-0000-000000000001', gen_random_uuid(), 'DE-16 Reconcile Co', 'D16R')
        RETURNING id`),
    );
    pluginId = firstId(
      await db.execute<{ id: string }>(sql`
        INSERT INTO plugins (id, company_id, plugin_key, package_name, version, api_version, categories, manifest_json, status, trust_tier)
        VALUES (
          gen_random_uuid(), ${companyId}, ${PLUGIN_KEY}, 'aoa-plugin-acme-reconcile', '1.0.0', 1,
          ${JSON.stringify(["automation"])}::jsonb,
          ${JSON.stringify(MANIFEST)}::jsonb,
          ${SEEDED_STATUS}, 'trusted'
        )
        RETURNING id`),
    );
  } catch (err) {
    setupError = err;
    setupFailed = true;
    // eslint-disable-next-line no-console
    console.error("[de-16-reconciliation-audit] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  setDeploymentMode("local_trusted");
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
  "DE-16 (reconciliations conjunct) — a cloud-plugin boot reconciliation-to-blocked is durable and attributable",
  () => {
    it("setup: a ready plugin exists, cloud_auth is forced, the gate is on, and NO reconciliation has been recorded yet", async () => {
      assertSetupOk();
      expect(companyId).toBeTruthy();
      expect(pluginId).toBeTruthy();
      setDeploymentMode("cloud_auth");
      // REACHABILITY CONTROL: without the gate on, reconcile is a 0-row no-op and
      // every arm below would pass by vacuity.
      expect(isCloudPluginExecutionBlocked()).toBe(true);
      const seeded = await pluginRow();
      expect(seeded?.status).toBe(SEEDED_STATUS);
      expect(seeded?.status_reason_code).toBeNull();
      expect(await reconcileRowCount()).toBe(0);
    });

    it("★ THE RECORD — the REAL boot reconciler flips the stale row to blocked AND writes ONE row naming WHO / TENANT / RESOURCE / PRIOR-STATUS", async () => {
      setDeploymentMode("cloud_auth");
      expect(await reconcileRowsFor(pluginId)).toHaveLength(0);

      // The exact function server/src/index.ts calls at cloud_auth boot.
      const reconciled = await reconcileCloudBlockedPlugins(ctxDb());
      // REACHABILITY CONTROL, asserted FIRST: the reconciler actually did work.
      expect(reconciled).toBe(1);

      // (a) The plugin row itself flipped to the blocked, metadata-only state.
      const after = await pluginRow();
      expect(after?.status).toBe("error");
      expect(after?.status_reason_code).toBe(PLUGIN_WORKER_BLOCKED_IN_CLOUD);
      expect(after?.last_error).toBe(CLOUD_PLUGIN_BLOCK_MESSAGE);

      // (b) EXACTLY ONE durable, attributable audit row for the transition.
      const rows = await reconcileRowsFor(pluginId);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;

      // WHO — a boot/machine identity, no principal.
      expect(row.actor_type).toBe("system");
      expect(row.actor_id).toBe(CLOUD_PLUGIN_BOOT_RECONCILE_ACTOR);
      // TENANT — the plugin's own FK-valid company; NO control-plane-attested org.
      expect(row.company_id).toBe(companyId);
      expect(row.organization_id).toBeNull();
      // RESOURCE — the reconciled plugin.
      expect(row.entity_type).toBe("plugin");
      expect(row.entity_id).toBe(pluginId);
      // ACTION — the reserved reconciliation action, composed from the exported
      // prefix + surface so a rename of either reds here rather than writing
      // silently elsewhere.
      expect(row.action).toBe(CLOUD_PLUGIN_RECONCILE_ACTION);
      // WHAT — the two values the record exists for: moved FROM / moved TO.
      expect(row.details?.priorStatus).toBe(SEEDED_STATUS);
      expect(row.details?.statusReasonCode).toBe(PLUGIN_WORKER_BLOCKED_IN_CLOUD);
      expect(row.details?.crossing).toBe("DE-16");
      expect(String(row.details?.control)).toContain("plugin-lifecycle.ts");
      expect(row.details?.operation).toBe("boot_reconcile");
    });

    it("★ A RECONCILIATION IS NOT A DENIAL — the row is OUTSIDE `security.denied.` and INSIDE `security.reconcile.`, and the denial count did not move", async () => {
      const beforeDenials = await denialRowCount();
      const rows = await reconcileRowsFor(pluginId);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      // Were it to land in the denial namespace, "count the denial rows" would
      // stop answering "count the refusals" — the exact property
      // `activity-namespace.ts`'s denial reservation exists to hold. A boot
      // reconciliation refuses nothing; it records a state transition.
      expect(row.action.startsWith(SECURITY_DENIAL_ACTION_PREFIX)).toBe(false);
      expect(row.action.startsWith(SECURITY_RECONCILE_ACTION_PREFIX)).toBe(true);
      // The reconciliation wrote NO denial row.
      expect(await denialRowCount()).toBe(beforeDenials);
    });

    it("★★★ AN IDEMPOTENT RE-BOOT RECONCILES NOTHING, SO IT AUDITS NOTHING — a SECOND reconcile pass over the now-blocked row returns 0 and writes NO second row", async () => {
      setDeploymentMode("cloud_auth");
      const before = await reconcileRowCount();
      expect(before).toBe(1);

      // The already-blocked row (error + PLUGIN_WORKER_BLOCKED_IN_CLOUD) is the
      // reconciler's idempotent-skip branch — a re-boot / a second replica.
      const reconciledAgain = await reconcileCloudBlockedPlugins(ctxDb());
      expect(reconciledAgain).toBe(0);

      // No new row, and the ONE row still describes the transition that happened.
      expect(await reconcileRowCount()).toBe(before);
      expect(await reconcileRowsFor(pluginId)).toHaveLength(1);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Codex PR #446 findings, accepted and proven here (each RED-first via a
    // targeted mutation recorded in the PR): the flip+audit is atomic (P1), a
    // concurrent replica that loses the row lock records nothing (P2), and the
    // durable priorStatus is the status read UNDER the lock, not a stale snapshot
    // (P2 on 943d3fed5).
    // ─────────────────────────────────────────────────────────────────────────
    it("★★★ LOCKED CLAIM (P2) — a concurrent replica that lost the row lock writes NO audit row; the claim is a locked read, not just the read-skip", async () => {
      setDeploymentMode("cloud_auth");
      const id = await seedPlugin("acme.cas", "ready");

      // Replica A — locks the row, sees it unblocked, claims + audits it.
      expect(await reconcileOnePluginToBlocked(ctxDb(), { id, companyId, status: "ready" })).toBe(true);
      const afterA = await pluginStatusById(id);
      expect(afterA?.status).toBe("error");
      expect(afterA?.status_reason_code).toBe(PLUGIN_WORKER_BLOCKED_IN_CLOUD);
      expect(await reconcileRowsFor(id)).toHaveLength(1);

      // Replica B — the SAME stale `ready` snapshot (as if it read `listInstalled`
      // before A committed), driven straight through the claim so the read-time
      // skip does NOT mask the race. Its `SELECT … FOR UPDATE` reads the now-blocked
      // row and returns false, so B does NOT audit — the property the unconditional
      // `updateStatus` lacked.
      expect(await reconcileOnePluginToBlocked(ctxDb(), { id, companyId, status: "ready" })).toBe(false);
      expect(await reconcileRowsFor(id)).toHaveLength(1);
    });

    it("★★★ TRUE PRIOR STATUS (P2 on 943d3fed5) — priorStatus is the status read UNDER the lock, NOT the caller's stale `listInstalled` snapshot", async () => {
      setDeploymentMode("cloud_auth");
      // The DB row is `disabled`, but the caller's snapshot still says `ready` — as
      // if a `ready → disabled` lifecycle change landed after `listInstalled()`
      // returned and before this transaction acquired the lock.
      const id = await seedPlugin("acme.priorstatus", "disabled");

      expect(await reconcileOnePluginToBlocked(ctxDb(), { id, companyId, status: "ready" })).toBe(true);
      const after = await pluginStatusById(id);
      expect(after?.status).toBe("error");
      expect(after?.status_reason_code).toBe(PLUGIN_WORKER_BLOCKED_IN_CLOUD);

      // The durable record names the status ACTUALLY overwritten (`disabled`, read
      // under the lock), NOT the stale snapshot (`ready`). Under the pre-fix code
      // (`priorStatus = row.status`) this would have recorded `ready`.
      const rows = await reconcileRowsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.details?.priorStatus).toBe("disabled");
      expect(rows[0]!.details?.priorStatus).not.toBe("ready");
    });

    it("★★★ ATOMIC ROLLBACK (P1) — a failed audit insert rolls the flip back (the row is NOT left blocked-but-unaudited), and a later clean pass completes it", async () => {
      setDeploymentMode("cloud_auth");
      const id = await seedPlugin("acme.rollback", "ready");

      // Inject a recorder that throws INSIDE the transaction, exactly as a
      // transient insert failure would.
      const boom: RecordCloudPluginReconcileToBlocked = async () => {
        throw new Error("audit boom");
      };
      await expect(
        reconcileOnePluginToBlocked(ctxDb(), { id, companyId, status: "ready" }, boom),
      ).rejects.toThrow("audit boom");

      // The flip rolled back WITH the failed audit: the row is still `ready` — NOT
      // committed-but-unaudited — and no audit row exists. Under the old
      // best-effort recorder the flip would have committed and this would be
      // `error`/blocked with zero audit rows, i.e. permanently unattributable.
      const afterFail = await pluginStatusById(id);
      expect(afterFail?.status).toBe("ready");
      expect(afterFail?.status_reason_code).toBeNull();
      expect(await reconcileRowsFor(id)).toHaveLength(0);

      // RETRIABLE — because the failed transition was never committed, a clean
      // pass completes the whole flip-plus-audit atomically.
      expect(await reconcileOnePluginToBlocked(ctxDb(), { id, companyId, status: "ready" })).toBe(true);
      const afterOk = await pluginStatusById(id);
      expect(afterOk?.status).toBe("error");
      expect(afterOk?.status_reason_code).toBe(PLUGIN_WORKER_BLOCKED_IN_CLOUD);
      expect(await reconcileRowsFor(id)).toHaveLength(1);
    });
  },
);
