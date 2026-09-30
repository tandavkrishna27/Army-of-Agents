// server/src/__tests__/helpers/migrated-database.ts
//
// The MINIMAL embedded-Postgres bootstrap for suites that need a real, fully-migrated
// database and a real non-owner `aoa_app` connection â€” nothing more.
//
// `distributed-execution-db-startup.integration.test.ts` has a bootstrap too, but its
// `beforeAll` is entangled with three extra databases and a legacy table-owner role
// because its own assertions need them. Copying that wholesale into a suite that needs
// one database is how a second, subtly-divergent bootstrap gets written. This is the
// shared one: start it, use it, tear it down.
//
// Callers are responsible for skipping on Windows without AOA_RUN_WIN_INTEGRATION=1
// (embedded-postgres cannot start on the `runneradmin` CI runner â€” Issue #114).

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres, { type Sql } from "postgres";
import {
  applyPendingMigrations,
  createTenantAppDbConnection,
  type Db,
  type NonOwnerDbConnection,
} from "@armyofagents/db";
import { provisionTenantAppRoleLoginSql } from "../../db/rls-tenant.js";
import { allocateEmbeddedPgPort } from "./embedded-pg-port.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};
type EmbeddedPostgresCtor = new (opts: Record<string, unknown>) => EmbeddedPostgresInstance;

export type MigratedDatabase = {
  /** Superuser/owner client. Seed through this â€” migrations run as the database owner. */
  readonly admin: Sql;
  /** Drizzle Db on the NON-OWNER `aoa_app` login role. Read through this. */
  readonly appDb: Db;
  /**
   * Drizzle Db on the NON-OWNER `aoa_operator` login role. ROUND 7 â€” the canary preflight's
   * definer functions grant EXECUTE to this role only, so the gate's own reads run here while
   * `appDb` stays the pool that must be DENIED.
   */
  readonly operatorDb: Db;
  /**
   * The connection URLs behind `admin` / `operatorDb`. ADDITIVE, for suites that must drive
   * a real OPERATOR ENTRYPOINT as a subprocess â€” a CLI takes a DATABASE_URL, not a Db, and
   * proving that a `current_user` gate discriminates requires connecting as BOTH roles.
   */
  readonly adminUrl: string;
  readonly operatorUrl: string;
  readonly teardown: () => Promise<void>;
};

export async function startMigratedDatabase(
  options: { label?: string; appPassword?: string; operatorPassword?: string } = {},
): Promise<MigratedDatabase> {
  const label = options.label ?? "aoa-migrated-db-";
  const password = options.appPassword ?? "migrated-database-app-password";
  const operatorPassword = options.operatorPassword ?? "migrated-database-operator-password";
  const dataDir = await mkdtemp(join(tmpdir(), label));
  const { default: EmbeddedPostgres } = (await import("embedded-postgres")) as {
    default: EmbeddedPostgresCtor;
  };
  let port = 0;
  let embedded: EmbeddedPostgresInstance | null = null;
  let admin: Sql | null = null;
  let app: NonOwnerDbConnection | null = null;
  let operator: NonOwnerDbConnection | null = null;
  const teardown = async () => {
    await operator?.close({ timeoutSeconds: 5 }).catch(() => {});
    await app?.close({ timeoutSeconds: 5 }).catch(() => {});
    await admin?.end().catch(() => {});
    await embedded?.stop().catch(() => {});
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  };
  try {
    // A PostgreSQL "ready" line can mean IPv6-only readiness when another
    // fixture took the probed IPv4 port during initdb. Never migrate that URL:
    // it may refuse the connection or belong to the competing cluster.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      port = await allocateEmbeddedPgPort();
      let startupLog = "";
      embedded = new EmbeddedPostgres({
        databaseDir: join(dataDir, "db"), user: "test", password: "test",
        port, persistent: false,
        initdbFlags: ["--encoding=UTF8", "--locale=C"],
        onLog: (message: string) => {
          startupLog = (startupLog + message).slice(-65_536);
          console.log(message);
        },
      });
      await embedded.initialise();
      await embedded.start();
      if (!/could not bind IPv4 address "127\.0\.0\.1": Address already in use/.test(startupLog)) break;
      // stop() also removes this attempt's ephemeral cluster. Retry setup only;
      // migration or assertion failures are never retried or weakened.
      await embedded.stop();
      embedded = null;
      if (attempt === 3) throw new Error("Embedded PostgreSQL IPv4 startup collided on all 3 attempts");
    }
    const adminUrl = `postgres://test:test@127.0.0.1:${port}/postgres`;
    await applyPendingMigrations(adminUrl);
    admin = postgres(adminUrl, { max: 2 });
    await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_app", password));
    app = createTenantAppDbConnection(adminUrl.replace("test:test", `aoa_app:${password}`), {
      max: 4,
    });
    // `provisionTenantAppRoleLoginSql` is role-generic (it runs assertSafeRoleName), and
    // `aoa_operator` is created unconditionally by migration 0213, so this only attaches a
    // login. ROUND 7 needs it because the definer EXECUTE grant now lives on this role.
    await admin.unsafe(provisionTenantAppRoleLoginSql("aoa_operator", operatorPassword));
    const operatorUrl = adminUrl.replace("test:test", `aoa_operator:${operatorPassword}`);
    operator = createTenantAppDbConnection(operatorUrl, { max: 4 });
    return {
      admin,
      appDb: app.db,
      operatorDb: operator.db,
      adminUrl,
      operatorUrl,
      teardown,
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}
