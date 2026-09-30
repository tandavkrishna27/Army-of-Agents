// server/src/services/execution-kill-switch-policy.ts
//
// REL-004 Lane C — the `aoa_app` read of the kill-switch policy document (clause 3a).
//
// A FAILED READ IS NOT AN ABSENT DOCUMENT, and keeping those two apart is the whole job of
// this module. "No policy has ever been set" is the steady state of every install that has
// never thrown a switch, so it must permit; treating it as fail-closed would stop all work on
// a fresh instance. "I could not load the policy" is precisely the case a kill switch exists
// for, so it must refuse. A `catch { return undefined }` would collapse the second into the
// first and let a database blip silently re-permit a killed provider.
//
// The distinction is carried by a sentinel that is deliberately NOT a plain object, so
// `evaluateKillSwitches` refuses it through its SINGLE unreadable path. A second, hand-written
// verdict at the call site would be a second thing to keep correct.
//
// Read OUTSIDE a tenant transaction: `instance_settings` is an instance singleton with no
// organization column and no RLS, so a tenant context would add a SET LOCAL and mean nothing.
// This mirrors MIG-008's app-side read of `legacy_resource_reconciliation`.
//
// DORMANCY — NO LONGER DORMANT, and the comment is corrected rather than left to rot.
// This was imported only by `job-leasing.ts` (reachable only under
// AOA_DISTRIBUTED_EXECUTION_ENABLED). REL-004 Lane D added a second consumer,
// `warm-sandbox-reaper.ts`, which is registered at module scope and therefore ALWAYS loaded.
// That is deliberate: the reaper is the reclaim path for a killed provider and must not be
// gated on the distributed flag, since the legacy sandboxes it reclaims are minted regardless
// of it. The db barrel and the infrastructure logger are already always-loaded, so this still
// pulls nothing new into the flag-off graph — verified by `tenant-app-db-startup.test.ts`.

import { eq } from "drizzle-orm";
import { instanceSettings, type Db } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";

/**
 * The document could not be read.
 *
 * A symbol, not an object, on purpose: `evaluateKillSwitches` accepts a plain object as a
 * candidate document, so an object sentinel would be parsed rather than refused. Do not change
 * this to `{}` or a string — the `execution-kill-switch-policy.test.ts` "not a plain object"
 * case exists to catch exactly that.
 */
export const KILL_SWITCH_POLICY_UNREADABLE: unique symbol = Symbol(
  "kill-switch-policy-unreadable",
);

const SINGLETON_KEY = "default";

export interface KillSwitchPolicyReader {
  /**
   * The stored document, `undefined` when none has ever been set, or
   * {@link KILL_SWITCH_POLICY_UNREADABLE} when the read failed. Never throws: a leasing path
   * must get a value, not an exception.
   */
  read(): Promise<unknown>;
}

export function createKillSwitchPolicyReader(input: { appDb: Db }): KillSwitchPolicyReader {
  return {
    async read(): Promise<unknown> {
      try {
        const rows = await input.appDb
          .select({ killSwitches: instanceSettings.killSwitches })
          .from(instanceSettings)
          .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
          .limit(1);
        // A missing row and a NULL column are the same fact: no policy has ever been set.
        // The value is returned VERBATIM otherwise — normalizing a document we do not
        // understand into "absent" here is how an unreadable policy becomes a permit.
        return rows[0]?.killSwitches ?? undefined;
      } catch {
        logger.error({
          action: "execution.kill_switch.policy_read_failed",
          reasonCode: "kill_switch_policy_unreadable",
        }, "kill-switch policy unreadable");
        return KILL_SWITCH_POLICY_UNREADABLE;
      }
    },
  };
}
