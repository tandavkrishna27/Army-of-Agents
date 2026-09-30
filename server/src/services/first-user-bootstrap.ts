import type { Db } from "@armyofagents/db";
import { instanceUserRoles } from "@armyofagents/db";
import { and, eq, sql } from "drizzle-orm";
import type { DeploymentMode } from "@armyofagents/shared";

const LOCAL_BOARD_USER_ID = "local-board";

/**
 * RB3/A7 — promote the given real user to `instance_admin` IFF no real
 * `instance_admin` exists yet. A leftover synthetic `local-board` admin from
 * the dev escape hatch is replaced transactionally during that handoff.
 *
 * Race-safe: serialized by a transaction-scoped Postgres advisory lock so two
 * concurrent new users cannot both become admin (the `(userId, role)` unique
 * index alone would NOT stop two DIFFERENT users each inserting). Idempotent —
 * a second call once an admin exists is a no-op.
 *
 * Email/password sign-up is removed, so Google OAuth is the only path that
 * creates a user — every created user is a Google user. If a second provider is
 * ever added, gate the caller on a Google account link (RC4).
 */
/**
 * revA A10/R16 — the CLI board-claim bootstrap is retired from the normal human
 * flow (the first Google user becomes admin via {@link promoteFirstUserToInstanceAdmin}).
 * The board-claim challenge is only initialized for headless/self-hosted server
 * setups via `AOA_HEADLESS_BOOTSTRAP`. Off by default.
 */
export function shouldEnableHeadlessBootstrap(config: { headlessBootstrap: boolean }): boolean {
  return config.headlessBootstrap === true;
}

export async function promoteFirstUserToInstanceAdmin(
  db: Db,
  userId: string,
  opts: { preserveSyntheticAdmin?: boolean } = {},
): Promise<boolean> {
  return await (
    db as unknown as { transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T> }
  ).transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('aoa:first-admin-bootstrap'))`);
    const existing = await tx
      .select({ userId: instanceUserRoles.userId })
      .from(instanceUserRoles)
      .where(eq(instanceUserRoles.role, "instance_admin"));

    const syntheticAdminExists = existing.some(
      (admin: { userId: string }) => admin.userId === LOCAL_BOARD_USER_ID,
    );
    const realAdminExists = existing.some(
      (admin: { userId: string }) => admin.userId !== LOCAL_BOARD_USER_ID,
    );
    const removeSyntheticAdmin = async () => {
      await tx
        .delete(instanceUserRoles)
        .where(
          and(
            eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID),
            eq(instanceUserRoles.role, "instance_admin"),
          ),
        );
    };

    if (realAdminExists) {
      if (syntheticAdminExists) await removeSyntheticAdmin();
      return false;
    }
    if (opts.preserveSyntheticAdmin && syntheticAdminExists) return false;
    if (userId === LOCAL_BOARD_USER_ID) return false;

    await tx.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    if (syntheticAdminExists) await removeSyntheticAdmin();
    return true;
  });
}

/**
 * Single chokepoint gating EVERY instance_admin promotion path. `cloud_auth`
 * (hosted multi-tenant beta) mints zero runtime instance_admins — the platform
 * operator is provisioned out-of-band; instance_admin is self-hosted/break-glass
 * only. Self-hosted local_trusted/authenticated keep the first-user bootstrap.
 */
export function instanceAdminBootstrapEnabled(mode: DeploymentMode): boolean {
  return mode !== "cloud_auth";
}

/** Boot-time invariant: cloud_auth must never have a runtime promotion path enabled. */
export function assertInstanceAdminBootstrapInvariant(
  config: { deploymentMode: DeploymentMode },
  resolver: (mode: DeploymentMode) => boolean = instanceAdminBootstrapEnabled,
): void {
  if (config.deploymentMode === "cloud_auth" && resolver(config.deploymentMode)) {
    throw new Error(
      "Startup invariant violated: cloud_auth must not mint runtime instance_admin.",
    );
  }
}
