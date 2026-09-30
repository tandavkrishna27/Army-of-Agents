/**
 * Idempotent startup backfill: reconcile every founder's fine-grained permission
 * grants.
 *
 * A cloud_auth founder is authorized ENTIRELY through
 * `principal_permission_grants` — `canUser()`/`hasPermission()` read grant rows,
 * not the `userRoles` founder row, and `isInstanceAdmin()` returns false under
 * tenant isolation. `ensureRealOperator` historically seeded a founder's role +
 * owner membership WITHOUT the grants, so:
 *   - founders created before that gap was closed, and
 *   - every founder on an instance flipped from `authenticated` → `cloud_auth`
 *     (where they previously rode the now-disabled instance-admin short-circuit),
 * have a founder role row but ZERO grants and get 403'd on every canUser-gated
 * route (Providers `agents:create`, routines / projects `tasks:assign`, …).
 *
 * This reconciles them: for every `userRoles` founder row, seed the full founder
 * grant set (all `PERMISSION_KEYS`), self-granted, `ON CONFLICT DO NOTHING`. Runs
 * at boot like `backfillAllCompaniesIdentityMemory`; idempotent — a second boot
 * (or a founder who already has grants) inserts 0 rows. Best-effort — never
 * blocks startup.
 */
import type { Db } from "@armyofagents/db";
import { companyMemberships, principalPermissionGrants, userRoles } from "@armyofagents/db";
import { and, eq } from "drizzle-orm";
import { PERMISSION_KEYS } from "@armyofagents/shared";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "founder-grants-backfill" });

export async function backfillFounderGrants(db: Db): Promise<{ founders: number; granted: number }> {
  // Only reconcile founders who still have an ACTIVE company membership.
  // hasPermission() gates on membership.status='active' anyway, so seeding grants
  // for a founder whose membership was deactivated (deliberate offboarding) would
  // be dead rows AND would wrongly re-arm access if that membership were ever
  // reactivated — so we must NOT re-grant an offboarded founder. This inner join
  // also keeps the `granted` count honest (only real heals are counted).
  const founders = await db
    .select({ companyId: userRoles.companyId, userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(
      companyMemberships,
      and(
        eq(companyMemberships.companyId, userRoles.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userRoles.userId),
        eq(companyMemberships.status, "active"),
      ),
    )
    .where(eq(userRoles.role, "founder"));

  let granted = 0;
  for (const founder of founders) {
    const inserted = await db
      .insert(principalPermissionGrants)
      .values(
        PERMISSION_KEYS.map((permissionKey) => ({
          companyId: founder.companyId,
          principalType: "user" as const,
          principalId: founder.userId,
          permissionKey,
          scope: null,
          grantedByUserId: founder.userId,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: principalPermissionGrants.id });
    granted += inserted.length;
  }

  if (granted > 0) {
    log.info({ founders: founders.length, granted }, "founder-grants backfill seeded missing grants");
  }
  return { founders: founders.length, granted };
}
