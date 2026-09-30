/**
 * cloud-plugin-reconcile-audit.ts — DE-16's `audit` clause, RECONCILIATIONS
 * CONJUNCT ("blocked plugin routes, dispatch, and reconciliations are audited").
 *
 * ★ THE DEFECT THIS CLOSES, AND ITS EXACT SIZE.
 * `docs/architecture/distributed-execution-threat-controls.json` DE-16 asserts
 * that blocked plugin routes, dispatch, AND reconciliations are audited. The
 * clause is a conjunction. The route + dispatch half is delivered by E0-F013
 * Decision 3.2 (`recordCloudPluginDenial`, `security.denied.cloud_plugin_execution`).
 * The RECONCILIATIONS conjunct was not: `reconcileCloudBlockedPlugins`
 * (`plugin-lifecycle.ts`) flips every stale non-uninstalled `plugins` row to the
 * blocked metadata-only state at `cloud_auth` boot and called only
 * `recordCloudPluginBootReconciled` — a PROCESS-MEMORY counter/gauge
 * (`cloud-plugin-execution.ts`) that resets on every restart. No durable row was
 * written, so a reboot that reconciled a company's stale `ready` plugin to
 * blocked left the same trace as a boot that reconciled nothing. This module is
 * the durable record.
 *
 * ★ WHAT IS RECORDED, AND WHAT IS NOT — stated first, because a partial delivery
 * described as a whole one is this programme's own failure class.
 *   RECORDED: one row per plugin ACTUALLY reconciled to blocked at boot — a row
 *     that was non-uninstalled and NOT already blocked. It says WHO (the boot/
 *     machine identity), in WHICH tenant (the plugin's own FK-valid company),
 *     on WHICH resource (the reconciled plugin), and WHAT (the prior status it
 *     was moved FROM, and the blocked reason it was moved TO).
 *   NOT RECORDED, AND NOT A GAP: a row already carrying
 *     `PLUGIN_WORKER_BLOCKED_IN_CLOUD`. The reconciler SKIPS it (idempotent
 *     no-op on a re-boot / a second replica), so no row is reconciled and none is
 *     recorded. A reader must not read "no row this boot" as "nothing is
 *     blocked": the blocked STATE is on the `plugins` row itself. What this
 *     module recovers is the durable, attributable TRANSITION, which the counter
 *     could not.
 *   NOT CLAIMED: the ROUTE + DISPATCH conjuncts (delivered separately under
 *     `security.denied.`, see `cloud-plugin-denial-audit.ts`), and every non-audit
 *     DE-16 clause. This module delivers the reconciliations conjunct and nothing
 *     else — DE-16 stays `partial`.
 *
 * ★ ATTRIBUTION IS A REAL-TENANT, SYSTEM-ACTOR ROW — a DIFFERENT SHAPE from the
 * route/dispatch half's company-NULL operator rows, and deliberately so.
 *   - `companyId` = `plugins.company_id`. It is NOT NULL and FK-valid (references
 *     `companies`), read from the DB row, NEVER caller-supplied — so this is a
 *     normal company-attributed audit row, and it satisfies the partial CHECK
 *     `activity_log_company_or_denial_check`'s NOT NULL arm.
 *   - `organizationId` = null. A boot reconciliation holds no control-plane-
 *     attested organization: unlike the denial recorder, whose org is trustworthy
 *     ONLY from an HMAC-minted token, there is no token here. Null is the honest
 *     answer, not a missing one.
 *   - `actorType` = "system". A boot pass has no principal — no `agents` row, no
 *     `auth` row — so neither `agent` nor `user` is truthful, matching the
 *     worker→"system" convention the retention/object-access recorders use.
 *   - `actorId` = a stable plain-text identifier (`CLOUD_PLUGIN_BOOT_RECONCILE_ACTOR`)
 *     with no FK, the same plain-text-no-FK choice those recorders make for a
 *     worker id.
 *   - `entityType`/`entityId` = the reconciled plugin.
 *
 * ★ WHY `activity_log`. The same three properties that put the denial, retention
 * and object-access recorders there: it is the live product audit store with an
 * existing redaction pass, it is deliberately outside the tenant RLS kernel, and
 * `action`/`entityType` are free text with a jsonb `details`, so this needs no
 * schema change and no DDL.
 *
 * ★ IT THROWS ON A FAILED INSERT, AND THAT IS DELIBERATE — the caller runs it
 * INSIDE THE SAME TRANSACTION as the state flip (see
 * `reconcileCloudBlockedPlugins` in `plugin-lifecycle.ts`). An earlier revision
 * swallowed the failure and returned null "best-effort"; Codex (P1 on PR #446,
 * accepted) showed why that is wrong here: the flip commits UNCONDITIONALLY, so a
 * lost audit left the plugin permanently `PLUGIN_WORKER_BLOCKED_IN_CLOUD` while
 * every later boot took the already-blocked skip branch and NEVER retried the
 * missing record — the transition once again indistinguishable from one that
 * never happened, violating AGENTS.md's "log mutations atomically" invariant.
 * Now the recorder throws, the caller's transaction rolls the CLAIM back with it,
 * the row stays claimable, and the next boot retries the whole flip-plus-audit.
 * Boot never crashes because the caller wraps each row in a try/catch that logs
 * and moves on — but the failed transition is retried rather than lost. The cost
 * of the old swallow was that a silently-broken writer looked like a quiet
 * system; `de-16-reconciliation-audit.integration.test.ts` drives the atomic
 * rollback and the compare-and-set directly.
 *
 * ★ THE `db` HANDLE IS THE CALLER'S TRANSACTION, not a pool handle. A drizzle
 * `PgTransaction` is not assignable to `Db`, so the caller passes it as
 * `tx as unknown as Db` (the codebase's established idiom — see `hub-items.ts`);
 * every method this recorder uses is present on the transaction at runtime.
 * Unlike the retention/denial recorders — which drain on a POOL handle AFTER a
 * TENANT transaction, precisely to escape RLS-rollback coupling — this runs at
 * `cloud_auth` boot on the OWNER connection, where there is no tenant transaction
 * to escape, so binding the audit to the flip's transaction is both safe and the
 * point.
 */
import type { Db } from "@armyofagents/db";
import { activityLog } from "@armyofagents/db";
import { sanitizeRecord } from "../redaction.js";
import { SECURITY_RECONCILE_ACTION_PREFIX } from "./activity-namespace.js";
import { PLUGIN_WORKER_BLOCKED_IN_CLOUD } from "./cloud-plugin-execution.js";

/** The surface slug for a cloud-plugin boot reconciliation-to-blocked. */
export const CLOUD_PLUGIN_RECONCILE_BLOCKED_SURFACE = "cloud_plugin_blocked";

/** The action a reconciliation row carries → `security.reconcile.cloud_plugin_blocked`. */
export const CLOUD_PLUGIN_RECONCILE_ACTION = `${SECURITY_RECONCILE_ACTION_PREFIX}${CLOUD_PLUGIN_RECONCILE_BLOCKED_SURFACE}`;

/**
 * The stable plain-text `actor_id` for the boot reconciliation. It is a
 * machine/boot identity with NO FK — a reconciliation pass has no principal — so
 * it is stored directly, the same plain-text-no-FK choice the worker recorders
 * make for a worker id.
 */
export const CLOUD_PLUGIN_BOOT_RECONCILE_ACTOR = "cloud-plugin-boot-reconciliation";

/** The shape the recorder needs about a reconciled plugin. */
export interface CloudPluginReconcileAuditInput {
  /** The reconciled plugin's id (`plugins.id`). */
  pluginId: string;
  /** The reconciled plugin's own company id (`plugins.company_id`, NOT NULL / FK-valid). */
  companyId: string;
  /** The status the plugin held BEFORE it was reconciled to the blocked state. */
  priorStatus: string;
}

/** The recorder's type — so the reconciler can accept an injected stand-in in its rollback test. */
export type RecordCloudPluginReconcileToBlocked = (
  db: Db,
  input: CloudPluginReconcileAuditInput,
) => Promise<string>;

/**
 * Record one cloud-plugin boot reconciliation-to-blocked durably and
 * attributably, returning the new row id. THROWS if the insert fails — the
 * caller runs this INSIDE the same transaction as the state flip, so a throw
 * rolls the claim back and the transition is retried on the next boot rather
 * than left committed-but-unaudited (see the header, and Codex P1 on PR #446).
 *
 * Deliberately does NOT publish a live event, for the reason the sibling
 * recorders give: an audit record that broadcasts is one that can be used as a
 * channel.
 */
export const recordCloudPluginReconcileToBlocked: RecordCloudPluginReconcileToBlocked = async (
  db,
  input,
) => {
  const details = sanitizeRecord({
    crossing: "DE-16",
    control: "server/src/services/plugin-lifecycle.ts:reconcileCloudBlockedPlugins",
    operation: "boot_reconcile",
    // The two values the record exists for: what it was moved FROM, and the
    // blocked reason it was moved TO.
    priorStatus: input.priorStatus,
    statusReasonCode: PLUGIN_WORKER_BLOCKED_IN_CLOUD,
  });

  const [row] = await db
    .insert(activityLog)
    .values({
      // A REAL, FK-valid company read from the plugin row — not caller-supplied.
      companyId: input.companyId,
      // No control-plane-attested organization at boot; see the header.
      organizationId: null,
      // Boot/machine identity, no principal — same convention as the worker
      // recorders.
      actorType: "system",
      actorId: CLOUD_PLUGIN_BOOT_RECONCILE_ACTOR,
      action: CLOUD_PLUGIN_RECONCILE_ACTION,
      entityType: "plugin",
      entityId: input.pluginId,
      // Left null: `agent_id`/`run_id` are FK'd to `agents`/`heartbeat_runs`
      // and a boot reconciliation has a row in neither.
      agentId: null,
      runId: null,
      details,
    })
    .returning({ id: activityLog.id });
  if (!row) {
    // An INSERT ... RETURNING that yields no row is an anomaly; throw so the
    // caller's transaction rolls back the un-audited claim rather than counting
    // a reconciliation whose record was silently lost.
    throw new Error(
      `cloud-plugin reconcile audit insert returned no row for plugin ${input.pluginId}`,
    );
  }
  return row.id;
};
