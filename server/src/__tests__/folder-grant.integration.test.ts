import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres, { type Sql } from "postgres";
import {
  applyPendingMigrations,
  createOperatorDbConnection,
  createTenantAppDbConnection,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import { provisionTenantAppRoleLoginSql } from "../db/rls-tenant.js";
import { createFolderGrantService, FolderGrantError } from "../services/folder-grant.js";
import { allocateEmbeddedPgPort } from "./helpers/embedded-pg-port.js";

// DAT-006 §6 (1),(6),(7) — folder-grant admission + resolver against a real tenant DB.

const ORG = "a7000000-0000-4000-8000-000000000001";
const OTHER_ORG = "a7000000-0000-4000-8000-0000000000aa";
const OWNER = "a7000000-0000-4000-8000-000000000009";
const TARGET = "a7000000-0000-4000-8000-000000000003";
const OTHER_TARGET = "a7000000-0000-4000-8000-0000000000cc";
const PASSWORD = "dat-006-fg-password";
const AUTHORITY_KEY = `owner:${ORG}:${OWNER}`;

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

const integration = describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1");

/** DSK-002 Lane A: resolveCapturedPath now BINDS the grant to the presenting device, so
 * every call supplies the identity the fixture enrolled. A grant is no longer usable by
 * any device in the organization that happens to know its id. */
const PRESENTED = { ownerUserId: OWNER, executionTargetId: TARGET, deviceGeneration: 1 };

integration("DAT-006 folder-grant admission + resolver", () => {
  let embedded: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let operator: NonOwnerDbConnection | null = null;
  let setupError: unknown = null;

  function guardCtx() {
    if (setupError) throw new Error(`embedded-postgres setup failed: ${String(setupError)}`);
    if (!admin || !app || !operator) throw new Error("test setup incomplete");
    return { admin, app, operator };
  }

  beforeAll(async () => {
    try {
      dataDir = await mkdtemp(join(tmpdir(), "aoa-dat006-fg-"));
      const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as { default: EmbeddedPostgresCtor };
      const port = await allocateEmbeddedPgPort();
      embedded = new EmbeddedPostgres({
        databaseDir: join(dataDir, "db"), user: "test", password: "test", port,
        persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"],
      });
      await embedded.initialise();
      await embedded.start();
      const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
      await applyPendingMigrations(adminUrl);
      admin = postgres(adminUrl, { max: 4 });
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", PASSWORD));
      await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_operator", PASSWORD));
      app = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${PASSWORD}`), { max: 16 });
      operator = createOperatorDbConnection(adminUrl.replace("test:test", `aoa_operator:${PASSWORD}`), { max: 8 });
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${ORG}, 'DAT-006 fg org', 'dat-006-fg-org')`;
      await admin`INSERT INTO organizations (id, name, slug) VALUES (${OTHER_ORG}, 'DAT-006 fg other', 'dat-006-fg-other')`;
      await admin`INSERT INTO "user" (id, name, email, created_at, updated_at)
        VALUES (${OWNER}, 'Owner', 'owner@dat006.test', clock_timestamp(), clock_timestamp())`;
      // An OWNER-scoped desktop target (the folder_grants owner-authority CHECK requires
      // target_authority_key = 'owner:<org>:<user>').
      await admin`INSERT INTO execution_targets
        (id, organization_id, owner_user_id, slug, kind, trust_class, status, capabilities, config, scope,
         target_authority_key, device_generation, last_seen_at)
        VALUES (${TARGET}, ${ORG}, ${OWNER}, 'dat-006-desktop', 'desktop', 'local_trusted', 'active', '{}', '{}',
          'owner', ${AUTHORITY_KEY}, 1, clock_timestamp())`;
    } catch (error) {
      setupError = error;
    }
  }, 180_000);

  afterAll(async () => {
    await operator?.close({ timeoutSeconds: 5 }).catch(() => {});
    await app?.close({ timeoutSeconds: 5 }).catch(() => {});
    await admin?.end().catch(() => {});
    await embedded?.stop().catch(() => {});
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  async function reset() {
    const { admin } = guardCtx();
    await admin`DELETE FROM folder_grants`;
  }

  it("(6) admits an explicit grant → a row + a resolvable folderGrantId", async () => {
    const { app, admin } = guardCtx();
    await reset();
    const svc = createFolderGrantService({ appDb: app.db });
    const res = await svc.admit({
      organizationId: ORG, ownerUserId: OWNER, executionTargetId: TARGET,
      targetAuthorityKey: AUTHORITY_KEY, deviceGeneration: 1, declaredBasePath: "project/src",
    });
    expect(res.admitted).toBe(true);
    const [{ n }] = await admin<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM folder_grants`;
    expect(n).toBe(1);
    const resolved = await svc.resolve({ organizationId: ORG, folderGrantId: res.folderGrantId });
    expect(resolved?.declaredBasePath).toBe("project/src");
    expect(resolved?.executionTargetId).toBe(TARGET);
  }, 60_000);

  it("(6b) re-admitting the same base is an idempotent no-op (same folderGrantId, admitted=false)", async () => {
    const { app, admin } = guardCtx();
    await reset();
    const svc = createFolderGrantService({ appDb: app.db });
    const args = {
      organizationId: ORG, ownerUserId: OWNER, executionTargetId: TARGET,
      targetAuthorityKey: AUTHORITY_KEY, deviceGeneration: 1, declaredBasePath: "project/src",
    };
    const first = await svc.admit(args);
    const second = await svc.admit(args);
    expect(first.admitted).toBe(true);
    expect(second.admitted).toBe(false);
    expect(second.folderGrantId).toBe(first.folderGrantId);
    const [{ n }] = await admin<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM folder_grants`;
    expect(n).toBe(1);
  }, 60_000);

  it("(1) resolveCapturedPath admits only paths WITHIN the declared base", async () => {
    const { app } = guardCtx();
    await reset();
    const svc = createFolderGrantService({ appDb: app.db });
    const { folderGrantId } = await svc.admit({
      organizationId: ORG, ownerUserId: OWNER, executionTargetId: TARGET,
      targetAuthorityKey: AUTHORITY_KEY, deviceGeneration: 1, declaredBasePath: "project/src",
    });
    const inside = await svc.resolveCapturedPath({ organizationId: ORG, folderGrantId, capturedPath: "project/src/main.ts", presented: PRESENTED });
    expect(inside.admitted).toBe(true);
    const outside = await svc.resolveCapturedPath({ organizationId: ORG, folderGrantId, capturedPath: "project/other/x.ts", presented: PRESENTED });
    expect(outside.admitted).toBe(false);
  }, 60_000);

  it("(DSK-002/I3) a grant is refused for a DIFFERENT desktop and a stale generation", async () => {
    // The real-DB proof of the binding. resolve() is scoped by org RLS, and an org scope
    // is not a device scope: this grant row is perfectly visible to both desktops. Before
    // Lane A the path below was ADMITTED for either of them.
    const { app } = guardCtx();
    await reset();
    const svc = createFolderGrantService({ appDb: app.db });
    const { folderGrantId } = await svc.admit({
      organizationId: ORG, ownerUserId: OWNER, executionTargetId: TARGET,
      targetAuthorityKey: AUTHORITY_KEY, deviceGeneration: 1, declaredBasePath: "project/src",
    });
    const capturedPath = "project/src/main.ts";

    // Non-vacuity: the enrolled device IS admitted for this exact path.
    await expect(svc.resolveCapturedPath({ organizationId: ORG, folderGrantId, capturedPath, presented: PRESENTED }))
      .resolves.toMatchObject({ admitted: true });

    // Another desktop in the SAME organization.
    await expect(svc.resolveCapturedPath({
      organizationId: ORG, folderGrantId, capturedPath,
      presented: { ...PRESENTED, executionTargetId: OTHER_TARGET },
    })).resolves.toMatchObject({ admitted: false, reason: "wrong_target" });

    // The same desktop, re-enrolled since the grant was given.
    await expect(svc.resolveCapturedPath({
      organizationId: ORG, folderGrantId, capturedPath,
      presented: { ...PRESENTED, deviceGeneration: 2 },
    })).resolves.toMatchObject({ admitted: false, reason: "stale_device_generation" });
  }, 60_000);

  it("(5) resolveCapturedPath EXCLUDES likely-secret paths even inside the declared base", async () => {
    const { app } = guardCtx();
    await reset();
    const svc = createFolderGrantService({ appDb: app.db });
    const { folderGrantId } = await svc.admit({
      organizationId: ORG, ownerUserId: OWNER, executionTargetId: TARGET,
      targetAuthorityKey: AUTHORITY_KEY, deviceGeneration: 1, declaredBasePath: "project/src",
    });
    // Inside the base but a secret → NOT admitted (the always-on floor admitCapturedPaths
    // enforces — a grant stages source, never exfiltrates a credential).
    for (const secret of ["project/src/.env", "project/src/id_rsa", "project/src/deploy.pem", "project/src/credentials"]) {
      const r = await svc.resolveCapturedPath({ organizationId: ORG, folderGrantId, capturedPath: secret, presented: PRESENTED });
      expect(r.admitted, secret).toBe(false);
    }
    // An ordinary source file inside the base is still admitted.
    const ok = await svc.resolveCapturedPath({ organizationId: ORG, folderGrantId, capturedPath: "project/src/app.ts", presented: PRESENTED });
    expect(ok.admitted).toBe(true);
  }, 60_000);

  it("(7) a revoked grant no longer resolves", async () => {
    const { app, admin } = guardCtx();
    await reset();
    const svc = createFolderGrantService({ appDb: app.db });
    const { folderGrantId } = await svc.admit({
      organizationId: ORG, ownerUserId: OWNER, executionTargetId: TARGET,
      targetAuthorityKey: AUTHORITY_KEY, deviceGeneration: 1, declaredBasePath: "project/src",
    });
    await admin`UPDATE folder_grants SET revoked_at = clock_timestamp() WHERE folder_grant_id = ${folderGrantId}`;
    expect(await svc.resolve({ organizationId: ORG, folderGrantId })).toBeNull();
    // A revoked base can be re-admitted (the active-base unique excludes revoked rows).
    const re = await svc.admit({
      organizationId: ORG, ownerUserId: OWNER, executionTargetId: TARGET,
      targetAuthorityKey: AUTHORITY_KEY, deviceGeneration: 1, declaredBasePath: "project/src",
    });
    expect(re.admitted).toBe(true);
    expect(re.folderGrantId).not.toBe(folderGrantId);
  }, 60_000);

  it("rejects an unsafe declared base (absolute path) before any write", async () => {
    const { app, admin } = guardCtx();
    await reset();
    const svc = createFolderGrantService({ appDb: app.db });
    await expect(svc.admit({
      organizationId: ORG, ownerUserId: OWNER, executionTargetId: TARGET,
      targetAuthorityKey: AUTHORITY_KEY, deviceGeneration: 1, declaredBasePath: "/etc/secrets",
    })).rejects.toBeInstanceOf(FolderGrantError);
    const [{ n }] = await admin<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM folder_grants`;
    expect(n).toBe(0);
  }, 60_000);

  it("a foreign-org grant is invisible under this tenant's RLS", async () => {
    const { app, admin } = guardCtx();
    await reset();
    // A cross-org owner target + grant, written as superuser (bypassing RLS).
    await admin`INSERT INTO "user" (id, name, email, created_at, updated_at)
      VALUES ('a7000000-0000-4000-8000-00000000000f', 'Other', 'other@dat006.test', clock_timestamp(), clock_timestamp())
      ON CONFLICT (id) DO NOTHING`;
    await admin`INSERT INTO execution_targets
      (id, organization_id, owner_user_id, slug, kind, trust_class, status, capabilities, config, scope,
       target_authority_key, device_generation, last_seen_at)
      VALUES (${OTHER_TARGET}, ${OTHER_ORG}, 'a7000000-0000-4000-8000-00000000000f', 'other-desktop', 'desktop',
        'local_trusted', 'active', '{}', '{}', 'owner', ${`owner:${OTHER_ORG}:a7000000-0000-4000-8000-00000000000f`}, 1, clock_timestamp())
      ON CONFLICT (id) DO NOTHING`;
    const foreignGrant = "a7000000-0000-4000-8000-0000000000f1";
    await admin`INSERT INTO folder_grants
      (organization_id, owner_user_id, execution_target_id, target_authority_key, device_generation, folder_grant_id, declared_base_path)
      VALUES (${OTHER_ORG}, 'a7000000-0000-4000-8000-00000000000f', ${OTHER_TARGET},
        ${`owner:${OTHER_ORG}:a7000000-0000-4000-8000-00000000000f`}, 1, ${foreignGrant}, 'secret/base')`;
    const svc = createFolderGrantService({ appDb: app.db });
    // Resolving the FOREIGN grant id under ORG's tenant returns null (RLS scopes it out).
    expect(await svc.resolve({ organizationId: ORG, folderGrantId: foreignGrant })).toBeNull();
    await admin`DELETE FROM folder_grants WHERE folder_grant_id = ${foreignGrant}`;
  }, 60_000);
});
