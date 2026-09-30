/**
 * @fileoverview Plan 3a Task 13 — embedded-Postgres integration proof for the
 * CONNECTOR CREDENTIAL STATE MACHINE.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT A UNIT TEST.
 *
 * Every credential-axis test written so far (`approvals-connector-credentials`,
 * `mcp-connector-install-adversarial`, `mcp-connector-approval-adversarial`)
 * drives the state machine over MOCKED rows. That was unavoidable: until Task 11
 * `requiresSecret: true` was UNREACHABLE in production — no route could produce a
 * connector row with it set, because the BYO create route hard-codes
 * `requiresSecret: false` and the catalog install route did not exist (recorded as
 * FU-16). The catalog install route is the FIRST code path that mints one. So the
 * `needs_credentials` state — the state the whole credential axis was built for —
 * had never been exercised against a real database by any test in the repo.
 *
 * This file closes that. It uses the REAL express routers (`mcpConnectorRoutes`,
 * `approvalRoutes`), the REAL services behind them (`createConnector`,
 * `approvalService`, `applyConnectorApproval`/`applyConnectorRejection`,
 * `secretService`, `permissionService`), and a REAL Postgres with ALL migrations
 * applied. The ONLY injected fake is the connector CATALOG (`opts.catalog`), which
 * exists solely so the suite never touches the network — the route's factory has
 * an injection point for exactly this reason. Nothing about status derivation,
 * governance, RBAC, secrets, or delivery is stubbed.
 *
 * WHAT IS PROVEN, against a real DB:
 *  1. The core journey — catalog install with `requiresSecret` lands
 *     `needs_credentials` / `source: "catalog"` / `secretRef: null`; the real
 *     loader delivers NOTHING for it even to an explicitly-enabled agent; binding
 *     a real encrypted company secret flips it `active`; the loader then delivers
 *     it with the decrypted value.
 *  2. Approval cannot activate an uncredentialed connector (`authenticated`):
 *     install → `pending_approval` → approve → `needs_credentials`, NOT `active`,
 *     and still undelivered.
 *  3. Rejecting a connector sitting in `needs_credentials` disables it (this was a
 *     silent no-op before C2).
 *  4. `disabled` is terminal on approve — a disabled connector with a still-open
 *     approval is not resurrected by approving it.
 *  5. Cross-tenant: company B's connector is unreachable from company A through
 *     install, bind, and PATCH.
 *  6. FU-17 end-to-end: the connector-approval role gate, over REAL `user_roles`
 *     rows and the real `permissionService` (the unit suite mocks the latter).
 *
 * DEPLOYMENT MODE is driven through `AOA_DEPLOYMENT_MODE`, because `loadConfig()`
 * is uncached and re-reads the environment on every call — which is what lets one
 * process exercise both `local_trusted` and `authenticated` honestly. Each block
 * sets it explicitly rather than relying on ambient state.
 *
 * Skipped on Windows CI (embedded-postgres cannot start on the `runneradmin`
 * runner — Issue #114); Linux CI is the authoritative gate. `initdbFlags` are
 * passed so it CAN be run locally on Windows by removing the skip. A setup
 * failure is RETHROWN inside each test rather than swallowed — a green run must
 * never mean "the database never started".
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import type { McpConnectorCatalogEntry } from "@armyofagents/shared";
import { mcpConnectorRoutes } from "../routes/mcp-connectors.js";
import { approvalRoutes } from "../routes/approvals.js";
import { mcpConnectorService } from "../services/mcp-connectors-crud.js";
import { loadEnabledConnectorRows } from "../services/mcp-connectors-loader.js";
import { secretService } from "../services/secrets.js";
import { errorHandler } from "../middleware/index.js";

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
let originalDeploymentMode: string | undefined;

const PORT = 58900 + Math.floor(Math.random() * 600);
const SECRET_PLAINTEXT = "notion-integration-secret-do-not-leak";

/**
 * The curated entry under test. `requiresSecret: true` is the whole point —
 * this is the state no route could previously produce (FU-16).
 *
 * `http` + `trust.tier: "verified"` keeps D7 and the consent gate out of the way:
 * both are exhaustively covered in the adversarial suites, and dragging them in
 * here would make a credential-axis failure look like a governance failure.
 */
const CATALOG_ENTRY: McpConnectorCatalogEntry = {
  id: "notion-http",
  displayName: "Notion",
  serverName: "notion",
  transport: "http",
  url: "https://mcp.notion.example/v1",
  args: [],
  headerTemplateKeys: ["Authorization"],
  envTemplateKeys: [],
  requiresSecret: true,
  trust: { tier: "verified" },
};

/** A second entry so a cross-tenant install has something distinct to aim at. */
const CATALOG_ENTRY_2: McpConnectorCatalogEntry = {
  ...CATALOG_ENTRY,
  id: "linear-http",
  displayName: "Linear",
  serverName: "linear",
  url: "https://mcp.linear.example/v1",
};

const fakeCatalog = {
  load: async () => ({ entries: [CATALOG_ENTRY, CATALOG_ENTRY_2], stale: false }),
};

beforeAll(async () => {
  try {
    originalDeploymentMode = process.env.AOA_DEPLOYMENT_MODE;
    // Deterministic 32-byte master key so the local_encrypted provider can
    // create + resolve secrets without touching a key file.
    process.env.AOA_SECRETS_MASTER_KEY = "b".repeat(64);
    dataDir = await mkdtemp(join(tmpdir(), "aoa-conn-install-"));
    const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
      default: EmbeddedPostgresCtor;
    };
    pg = new EmbeddedPostgres({
      databaseDir: join(dataDir, "db"),
      user: "test",
      password: "test",
      port: PORT,
      persistent: false,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
    });
    await pg.initialise();
    await pg.start();
    const connectionString = `postgres://test:test@localhost:${PORT}/postgres`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  } catch (err) {
    setupError = err;
    // eslint-disable-next-line no-console
    console.error("[conn-install] embedded-postgres setup failed:", err);
  }
}, 180_000);

afterAll(async () => {
  if (originalDeploymentMode === undefined) delete process.env.AOA_DEPLOYMENT_MODE;
  else process.env.AOA_DEPLOYMENT_MODE = originalDeploymentMode;
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
});

async function firstRow<T = Record<string, unknown>>(query: unknown): Promise<T> {
  const res = (await query) as { rows?: T[] } | T[];
  const rows = Array.isArray(res) ? res : (res.rows ?? []);
  return rows[0] as T;
}

/** Board actor shapes. `source: "session"` so `assertRole` really runs. */
function boardActor(userId: string, companyIds: string[]) {
  return {
    type: "board" as const,
    source: "session" as const,
    userId,
    companyIds,
    isInstanceAdmin: false,
  };
}

/**
 * The REAL routers, with only the actor injected (the auth middleware is the one
 * thing a supertest harness cannot boot) and the fake CATALOG so no network is
 * touched. `db` is the real handle, so `db.transaction` is a real transaction.
 */
function app(actor: unknown) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use("/api", mcpConnectorRoutes(db, { catalog: fakeCatalog }));
  server.use("/api", approvalRoutes(db));
  server.use(errorHandler);
  // `request(...)` and not the bare app: an express app also has `.post`, which
  // REGISTERS a route instead of issuing one — a silent no-op that would make
  // every assertion below vacuous.
  return request(server);
}

/**
 * `companies.issue_prefix` is UNIQUE with a fixed default, so every company in
 * this file needs its own. Sequential rather than random: a collision here would
 * surface as an unrelated-looking 23505 mid-test.
 */
let companySeq = 0;

/** A company + a founder + a team_member + an agent, all real rows. */
async function seedCompany(name: string) {
  companySeq += 1;
  const prefix = `T${String(companySeq).padStart(2, "0")}`;
  const company = await firstRow<{ id: string }>(
    db.execute(
      sql`INSERT INTO companies (name, issue_prefix) VALUES (${name}, ${prefix}) RETURNING id`,
    ),
  );
  const founderId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  for (const [id, label] of [
    [founderId, "Founder"],
    [memberId, "Member"],
  ] as const) {
    await db.execute(sql`
      INSERT INTO "user" (id, name, email, created_at, updated_at)
      VALUES (${id}, ${label}, ${`${id}@example.test`}, now(), now())
    `);
  }
  await db.execute(sql`
    INSERT INTO user_roles (company_id, user_id, role) VALUES (${company.id}, ${founderId}, 'founder')
  `);
  await db.execute(sql`
    INSERT INTO user_roles (company_id, user_id, role) VALUES (${company.id}, ${memberId}, 'team_member')
  `);
  const agent = await firstRow<{ id: string }>(
    db.execute(sql`
      INSERT INTO agents (company_id, name, adapter_type, status, kind)
      VALUES (${company.id}, 'Scout', 'claude_local', 'active', 'org')
      RETURNING id
    `),
  );
  return { companyId: company.id, founderId, memberId, agentId: agent.id };
}

/** Reads the connector row straight from the DB — never from a response body. */
async function connectorRow(id: string) {
  return firstRow<{
    id: string;
    status: string;
    source: string;
    secret_ref: string | null;
    requires_secret: boolean;
  }>(db.execute(sql`SELECT * FROM company_mcp_connectors WHERE id = ${id}`));
}

// Skipped on Windows CI (Issue #114). Runs locally on Windows if the skip is
// removed — `initdbFlags` above are what make that possible.
describe.skipIf(process.platform === "win32")(
  "MCP connector install — credential state machine (real routes, real DB)",
  () => {
    it("[1] core journey: catalog install → needs_credentials → not delivered → bind → active → delivered", async () => {
      if (setupError) throw setupError;
      process.env.AOA_DEPLOYMENT_MODE = "local_trusted";

      const { companyId, founderId, agentId } = await seedCompany("Journey Co");
      const founder = app(boardActor(founderId, [companyId]));

      // ── Install the curated entry. This is the FIRST route in the codebase
      //    that can produce `requiresSecret: true` (FU-16). ────────────────────
      const installed = await founder
        .post(`/api/companies/${companyId}/mcp-connectors/install`)
        .send({ entryId: CATALOG_ENTRY.id });
      expect(installed.status).toBe(201);
      const connectorId = installed.body.id as string;

      // Asserted off the DB, not the response: the row is what the loader reads.
      const afterInstall = await connectorRow(connectorId);
      expect({
        status: afterInstall.status,
        source: afterInstall.source,
        secretRef: afterInstall.secret_ref,
        requiresSecret: afterInstall.requires_secret,
      }).toEqual({
        status: "needs_credentials",
        source: "catalog",
        secretRef: null,
        requiresSecret: true,
      });
      // local_trusted has no governance gate, so no approval is minted.
      expect(installed.body.approvalId).toBeNull();

      // ── THE DELIVERY ALLOWLIST. Enable it for the agent FIRST, so the only
      //    thing standing between the connector and the CLI is its STATUS. This
      //    is the "never delivered while unconfigured" guarantee, checked in its
      //    strongest form. ────────────────────────────────────────────────────
      const enabled = await founder
        .put(`/api/companies/${companyId}/mcp-connectors/${connectorId}/agents`)
        .send({ agentIds: [agentId] });
      expect(enabled.status).toBe(200);

      expect(await loadEnabledConnectorRows(db, { companyId, agentId })).toEqual([]);
      // ...and Commander (D3-exempt from the per-agent opt-in) gets it no sooner.
      expect(await loadEnabledConnectorRows(db, { companyId, agentId: null })).toEqual([]);

      // ── Bind a REAL encrypted company secret through the credentials route. ──
      await secretService(db).create(companyId, {
        name: "mcp:notion",
        provider: "local_encrypted",
        managedMode: "aoa_managed",
        value: SECRET_PLAINTEXT,
      });
      const bound = await founder
        .post(`/api/companies/${companyId}/mcp-connectors/${connectorId}/credentials`)
        .send({ secretRef: "mcp:notion" });
      expect(bound.status).toBe(200);

      const afterBind = await connectorRow(connectorId);
      expect(afterBind.status).toBe("active");
      expect(afterBind.secret_ref).toBe("mcp:notion");

      // ── The loader now delivers it, with the secret decrypted off the real DB. ─
      const delivered = await loadEnabledConnectorRows(db, { companyId, agentId });
      expect(delivered.map((row) => row.serverName)).toEqual(["notion"]);
      expect(delivered[0].secretValue).toBe(SECRET_PLAINTEXT);

      // An agent that was never enabled still gets nothing — activation is not
      // a company-wide grant.
      const otherAgent = await firstRow<{ id: string }>(
        db.execute(sql`
          INSERT INTO agents (company_id, name, adapter_type, status, kind)
          VALUES (${companyId}, 'Bystander', 'claude_local', 'active', 'org')
          RETURNING id
        `),
      );
      expect(await loadEnabledConnectorRows(db, { companyId, agentId: otherAgent.id })).toEqual([]);
    }, 120_000);

    it("[2] approval cannot activate an uncredentialed connector", async () => {
      if (setupError) throw setupError;
      process.env.AOA_DEPLOYMENT_MODE = "authenticated";

      const { companyId, founderId, agentId } = await seedCompany("Governed Co");
      const founder = app(boardActor(founderId, [companyId]));

      const installed = await founder
        .post(`/api/companies/${companyId}/mcp-connectors/install`)
        .send({ entryId: CATALOG_ENTRY.id });
      expect(installed.status).toBe(201);
      const connectorId = installed.body.id as string;
      const approvalId = installed.body.approvalId as string;

      expect((await connectorRow(connectorId)).status).toBe("pending_approval");
      expect(approvalId).toBeTruthy();

      await founder
        .put(`/api/companies/${companyId}/mcp-connectors/${connectorId}/agents`)
        .send({ agentIds: [agentId] });

      // ── Approve through the REAL route → the REAL side-effect. ──────────────
      const approved = await founder
        .post(`/api/approvals/${approvalId}/approve`)
        .send({ decisionNote: "ok" });
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe("approved");

      // THE ASSERTION THIS WHOLE FILE EXISTS FOR: the governance axis is
      // satisfied, the credential axis is not, so the connector lands in
      // `needs_credentials` — never `active`.
      const afterApprove = await connectorRow(connectorId);
      expect(afterApprove.status).toBe("needs_credentials");
      expect(afterApprove.status).not.toBe("active");
      expect(afterApprove.secret_ref).toBeNull();

      // ...and it is still not delivered to the agent it was enabled for.
      expect(await loadEnabledConnectorRows(db, { companyId, agentId })).toEqual([]);

      // Completing the credential axis (still in `authenticated`) is what
      // activates it — proving `needs_credentials` was the ONLY thing missing.
      await secretService(db).create(companyId, {
        name: "mcp:notion",
        provider: "local_encrypted",
        managedMode: "aoa_managed",
        value: SECRET_PLAINTEXT,
      });
      const bound = await founder
        .post(`/api/companies/${companyId}/mcp-connectors/${connectorId}/credentials`)
        .send({ secretRef: "mcp:notion" });
      expect(bound.status).toBe(200);
      expect((await connectorRow(connectorId)).status).toBe("active");
      expect(
        (await loadEnabledConnectorRows(db, { companyId, agentId })).map((r) => r.serverName),
      ).toEqual(["notion"]);
    }, 120_000);

    it("[2b] FU-17: a team_member cannot approve or reject the install; the founder can", async () => {
      if (setupError) throw setupError;
      process.env.AOA_DEPLOYMENT_MODE = "authenticated";

      const { companyId, founderId, memberId } = await seedCompany("RBAC Co");
      const founder = app(boardActor(founderId, [companyId]));
      const member = app(boardActor(memberId, [companyId]));

      const installed = await founder
        .post(`/api/companies/${companyId}/mcp-connectors/install`)
        .send({ entryId: CATALOG_ENTRY.id });
      const connectorId = installed.body.id as string;
      const approvalId = installed.body.approvalId as string;

      // Over REAL `user_roles` rows and the real permissionService — the unit
      // suite mocks `getEffectiveRole`, so this is the first end-to-end check.
      for (const action of ["approve", "reject", "request-revision"]) {
        const res = await member.post(`/api/approvals/${approvalId}/${action}`).send({});
        expect({ action, status: res.status }).toEqual({ action, status: 403 });
      }
      // The refusal left both the approval AND the connector untouched.
      expect((await connectorRow(connectorId)).status).toBe("pending_approval");
      const approvalAfter = await firstRow<{ status: string }>(
        db.execute(sql`SELECT status FROM approvals WHERE id = ${approvalId}`),
      );
      expect(approvalAfter.status).toBe("pending");

      // The founder is unaffected.
      const ok = await founder.post(`/api/approvals/${approvalId}/approve`).send({});
      expect(ok.status).toBe(200);
      expect((await connectorRow(connectorId)).status).toBe("needs_credentials");
    }, 120_000);

    it("[3] rejecting a connector sitting in needs_credentials disables it", async () => {
      if (setupError) throw setupError;
      process.env.AOA_DEPLOYMENT_MODE = "authenticated";

      const { companyId, founderId, agentId } = await seedCompany("Reject Co");
      const founder = app(boardActor(founderId, [companyId]));

      const installed = await founder
        .post(`/api/companies/${companyId}/mcp-connectors/install`)
        .send({ entryId: CATALOG_ENTRY.id });
      const connectorId = installed.body.id as string;
      const approvalId = installed.body.approvalId as string;

      // Reach `needs_credentials` the real way: approve the install.
      await founder.post(`/api/approvals/${approvalId}/approve`).send({});
      expect((await connectorRow(connectorId)).status).toBe("needs_credentials");

      // A SECOND approval row is inserted directly, and this is the one place in
      // the file that does not go through a route — deliberately, because NO
      // route can mint one: `install_mcp_connector` approvals are created only
      // inside `createConnector`, and the first one is now closed. The rejection
      // path for `needs_credentials` is nonetheless real production code
      // (`applyConnectorRejection` covers that status precisely because an
      // approved-but-uncredentialed connector sits there), and before C2 rejecting
      // it was a SILENT NO-OP. The row below is seeded to look exactly like one
      // `createConnector` writes; everything downstream of it is the real route.
      const second = await firstRow<{ id: string }>(
        db.execute(sql`
          INSERT INTO approvals (company_id, type, status, payload, requested_by_user_id)
          VALUES (
            ${companyId},
            'install_mcp_connector',
            'pending',
            ${JSON.stringify({ connectorId, serverName: "notion" })}::jsonb,
            ${founderId}
          )
          RETURNING id
        `),
      );

      const rejected = await founder
        .post(`/api/approvals/${second.id}/reject`)
        .send({ decisionNote: "not this one" });
      expect(rejected.status).toBe(200);
      expect(rejected.body.status).toBe("rejected");

      // Disabled, not deleted — the audit trail survives.
      const after = await connectorRow(connectorId);
      expect(after.status).toBe("disabled");
      expect(after.id).toBe(connectorId);

      // A rejected connector is never delivered, even once a secret exists.
      await secretService(db).create(companyId, {
        name: "mcp:notion",
        provider: "local_encrypted",
        managedMode: "aoa_managed",
        value: SECRET_PLAINTEXT,
      });
      await founder
        .put(`/api/companies/${companyId}/mcp-connectors/${connectorId}/agents`)
        .send({ agentIds: [agentId] });
      expect(await loadEnabledConnectorRows(db, { companyId, agentId })).toEqual([]);

      // And binding a credential does NOT resurrect it (the `disabled`
      // short-circuit in the credentials route).
      const bind = await founder
        .post(`/api/companies/${companyId}/mcp-connectors/${connectorId}/credentials`)
        .send({ secretRef: "mcp:notion" });
      expect(bind.status).toBe(200);
      expect((await connectorRow(connectorId)).status).toBe("disabled");
    }, 120_000);

    it("[4] disabled is terminal on approve", async () => {
      if (setupError) throw setupError;
      process.env.AOA_DEPLOYMENT_MODE = "authenticated";

      const { companyId, founderId, agentId } = await seedCompany("Terminal Co");
      const founder = app(boardActor(founderId, [companyId]));

      const installed = await founder
        .post(`/api/companies/${companyId}/mcp-connectors/install`)
        .send({ entryId: CATALOG_ENTRY.id });
      const connectorId = installed.body.id as string;
      const approvalId = installed.body.approvalId as string;

      // PATCH → disabled is the ONE status change C2 permits in `authenticated`.
      const patched = await founder
        .patch(`/api/companies/${companyId}/mcp-connectors/${connectorId}`)
        .send({ status: "disabled" });
      expect(patched.status).toBe(200);
      expect((await connectorRow(connectorId)).status).toBe("disabled");

      // The approval is still open. Approving it must NOT resurrect the connector
      // — the founder's explicit disable is the later, more specific signal.
      const approved = await founder.post(`/api/approvals/${approvalId}/approve`).send({});
      expect(approved.status).toBe(200);
      expect(approved.body.status).toBe("approved");
      expect((await connectorRow(connectorId)).status).toBe("disabled");

      await founder
        .put(`/api/companies/${companyId}/mcp-connectors/${connectorId}/agents`)
        .send({ agentIds: [agentId] });
      expect(await loadEnabledConnectorRows(db, { companyId, agentId })).toEqual([]);
    }, 120_000);

    it("[5] cross-tenant: company B's connector is unreachable from company A", async () => {
      if (setupError) throw setupError;
      process.env.AOA_DEPLOYMENT_MODE = "authenticated";

      const a = await seedCompany("Tenant A");
      const b = await seedCompany("Tenant B");
      const founderA = app(boardActor(a.founderId, [a.companyId]));
      const founderB = app(boardActor(b.founderId, [b.companyId]));

      const bInstalled = await founderB
        .post(`/api/companies/${b.companyId}/mcp-connectors/install`)
        .send({ entryId: CATALOG_ENTRY.id });
      expect(bInstalled.status).toBe(201);
      const bConnectorId = bInstalled.body.id as string;
      const bApprovalId = bInstalled.body.approvalId as string;

      // INSTALL into B's company — refused at `assertCompanyAccess`.
      const crossInstall = await founderA
        .post(`/api/companies/${b.companyId}/mcp-connectors/install`)
        .send({ entryId: CATALOG_ENTRY_2.id });
      expect(crossInstall.status).toBe(403);

      await secretService(db).create(a.companyId, {
        name: "mcp:notion",
        provider: "local_encrypted",
        managedMode: "aoa_managed",
        value: SECRET_PLAINTEXT,
      });

      // BIND B's connector via A's own company path — the id is not A's, so the
      // route 404s rather than reaching across the tenant boundary.
      const crossBind = await founderA
        .post(`/api/companies/${a.companyId}/mcp-connectors/${bConnectorId}/credentials`)
        .send({ secretRef: "mcp:notion" });
      expect(crossBind.status).toBe(404);

      // PATCH the same way.
      const crossPatch = await founderA
        .patch(`/api/companies/${a.companyId}/mcp-connectors/${bConnectorId}`)
        .send({ status: "disabled" });
      expect(crossPatch.status).toBe(404);

      // Approving B's install approval from A is refused by company access.
      const crossApprove = await founderA.post(`/api/approvals/${bApprovalId}/approve`).send({});
      expect(crossApprove.status).toBe(403);

      // B's connector is untouched by every attempt above.
      expect((await connectorRow(bConnectorId)).status).toBe("pending_approval");

      // And nothing of B's ever reaches an agent of A.
      expect(await loadEnabledConnectorRows(db, { companyId: a.companyId, agentId: a.agentId })).toEqual([]);
      expect(
        (await mcpConnectorService(db).list(a.companyId)).map((row: { id: string }) => row.id),
      ).not.toContain(bConnectorId);
    }, 120_000);
  },
);
