import { notLike, type SQL } from "drizzle-orm";
import { activityLog } from "@armyofagents/db";

export const MARKETPLACE_RECONCILIATION_ENTITY_TYPE =
  "marketplace_reconciliation";
export const MARKETPLACE_RECONCILIATION_ACTION_PREFIX =
  "marketplace.reconciliation_";

/**
 * Reserved `action` prefix for security-denial audit rows (DE-19 and the
 * denial-audit class behind `E0-F010` / `E0-F013`).
 *
 * ★ WHAT THE RESERVATION IS FOR. These rows are evidence that a security control
 * REFUSED something, and they are the only durable trace such a refusal leaves.
 * If a caller could choose its own `action` and land in this namespace — the
 * generic `insertActivityLog` helper, `activityService.create`, or an
 * authenticated board client POSTing to `/companies/:cid/activity` — then "there
 * is a denial record" would stop implying "a control denied", and an operator
 * reading the log could be reading forgery. Those three are refused here, and
 * `recordSecurityDenial` in `security-denial-audit.ts` deliberately does its own
 * insert rather than going through them.
 *
 * ★ AND WHAT IT IS NOT — MEASURED, because an earlier draft of this comment
 * claimed a chokepoint that does not exist. There is no single funnel for
 * `activity_log`. At the commit that added this text there are THIRTY-FOUR
 * direct `db.insert(activityLog)` / `tx.insert(activityLog)` sites in
 * `server/src`, and this predicate runs at exactly TWO of them —
 * `insertActivityLog` (`activity-log.ts:35`) and `activityService.create`
 * (`activity.ts:188`) — plus the HTTP route's Zod refinement
 * (`routes/activity.ts:33`) ahead of the second. The other thirty-two write
 * straight past it.
 *
 * The property still holds, but for a NARROWER reason than "everything is
 * refused here": those two are the only writers that accept a caller-supplied
 * `action` at all. Every one of the other thirty-two hard-codes it — a string
 * literal, a ternary of literals (`work-question-continuation-terminal.ts:175`),
 * a literal-union parameter (`user-notes.ts:27`), a module-local const
 * (`marketplace-reconcile.ts:380`, `seed-commander-review.ts:267`), or a
 * statically-prefixed template (`hub-items.ts:1186`, `hub_item.${…}`, which
 * cannot reach this namespace whatever the suffix). The one site typed
 * `action: string` (`operator-break-glass.ts:277`) is a private dep hook with
 * three internal literal call sites.
 *
 * SO: this is a reservation over a write surface whose shape was checked, not a
 * structural chokepoint. A NEW direct insert that took a free-form `action`
 * would bypass it and nothing would fail. THE RULE FOR ANYONE ADDING ONE: a
 * direct `insert(activityLog)` must hard-code its `action`; if the action comes
 * from the caller, route through `insertActivityLog` instead. That rule is not
 * mechanically enforced, and the decision not to enforce it is recorded in
 * `docs/replatform/epics/E0-foundation/findings.md` under E0-F013.
 *
 * The reservation is on the ACTION prefix only, deliberately NOT on entityType:
 * a denial row's `entityType`/`entityId` name the REFUSED RESOURCE (e.g.
 * `memory_item`), which is what makes the existing
 * `activity_log_entity_type_id_idx` answer "what was refused on this item".
 * Reserving entityType too would force a synthetic type and lose that.
 */
export const SECURITY_DENIAL_ACTION_PREFIX = "security.denied.";

/**
 * ★ THE READ-SIDE COMPLEMENT OF THE WRITE RESERVATION ABOVE — E0-F013 Decision 3
 * (Q3), founder-ruled 2026-09-11, best-practice throughout.
 *
 * The reservation above keeps forged denial rows OUT of the namespace on the
 * WRITE path. This keeps genuine denial rows out of every TENANT-FACING feed on
 * the READ path. They answer two different halves of one property: a
 * `security.denied.*` row is evidence that a control refused something, and the
 * founder's ruling is that such evidence is disclosed to NO tenant — not the
 * probed tenant (already true: no per-company denial feed exists), and now not
 * the ACTOR's OWN tenant either. A cross-tenant probe mounted from inside tenant
 * A files its refusal under tenant A (actor-attribution, ratified as Q1), so
 * before this predicate the prober's own colleagues — and the prober — read the
 * detection through `/activity`, `/home`, `/cockpit` and Commander's digest. The
 * audit record was a feedback channel to the attacker. This closes it.
 *
 * ★ ONE PREDICATE, FOUR READERS, SO THEY CANNOT DRIFT. Every tenant-facing
 * reader of `activity_log` adds this to its WHERE, and a future reader that omits
 * it is a VISIBLE omission (a missing call to a named helper) rather than an
 * invisible one (four hand-copied `notLike`s, three of which quietly rot). The
 * operator plane (`activityService.securityDenials` / `GET
 * /instance/security-denials`) deliberately does NOT use this — it is the one
 * surface that still sees the whole namespace, gated on the operator, not on
 * company membership.
 *
 * ★ IT IS THE `security.denied.` NAMESPACE ONLY, DELIBERATELY. The sibling
 * `security.retention.` and `security.object_access.` namespaces are DE-11's and
 * DE-06's audit clauses, are written only under a locked lease with an FK-valid
 * company, and are NOT what Decision 3 rules over. Widening this predicate to
 * them would answer a question the founder did not sign.
 */
export function notDenialNamespace(): SQL {
  return notLike(activityLog.action, `${SECURITY_DENIAL_ACTION_PREFIX}%`);
}

/**
 * ★ THE EXPLICIT RETENTION WINDOW for `security.denied.*` audit rows — E0-F013
 * Decision 3.3 (Q4), founder-ruled 2026-09-11 ("rule the lifetime explicitly …
 * bounded, with a purge that itself leaves a record").
 *
 * 365 days is the best-practice default for a security-denial audit trail: long
 * enough to survive a quarterly incident-response cycle and an annual review,
 * bounded so evidence does not accumulate without limit. This constant is the
 * NAMED, RECORDED policy the founder's ruling requires — it replaces "unbounded,
 * and nothing says so" with "365 days, stated here".
 *
 * ★ IT IS A POLICY DECLARATION, NOT AN ENFORCEMENT. Nothing reads this constant
 * to purge yet, and this file does NOT wire a sweeper. Slice 3 ships Q4 as an
 * explicit, recorded window and DEFERS the bounded purge to a follow-up, because
 * the founder's "a purge that itself leaves a record" half collides with the
 * partial CHECK (`activity_log_company_or_denial_check`): an instance-wide purge
 * has no single company, so its durable purge-audit row would carry a NULL
 * `company_id` under a NON-`security.denied.` action, which the CHECK REJECTS.
 * Making the record-leaving purge legal needs either a further CHECK change on
 * `activity_log` or a separate operator-audit store — a decision beyond wiring a
 * cron, filed as E0-F018 (`docs/replatform/epics/E0-foundation/findings.md`).
 * A FALSE CLAIM OF ENFORCEMENT IS WORSE THAN A MISSING CHECK: this window is
 * declared and unenforced, and both the constant and E0-F018 say so plainly.
 *
 * ★ SCOPE, when the purge IS wired: it may delete ONLY `security.denied.*` rows
 * OLDER than this window (`created_at < now() - 365d`), in capped batches, and
 * NEVER a row younger than the window nor any other namespace.
 */
export const SECURITY_DENIAL_RETENTION_DAYS = 365;

/**
 * Reserved `action` prefix for CONTROL-PLANE RETENTION DECISIONS (DE-11's
 * `audit` clause, "sensitive-artifact access and retention are audited").
 *
 * ★ WHY THIS IS A SEPARATE NAMESPACE FROM `security.denied.`, AND NOT A
 * CONVENIENCE. A retention override is NOT a refusal. `resolveStoredRetention`
 * ignores a worker's declared class and stores the derived one; the authority's
 * own doc comment says why that is not an attack — "a worker declaring a SHORTER
 * class than derived is not an attack, but it is the same bug class". Filing
 * those rows under `security.denied.` would make "count the denial rows" answer
 * a different question than "count the refusals", which is precisely the
 * property the denial reservation above exists to protect. So: a distinct
 * prefix, a distinct recorder (`artifact-retention-audit.ts`), and a distinct
 * reservation, enforced at the same two caller-supplied-`action` writers.
 *
 * ★ THE PARTIAL CHECK DOES NOT COVER THIS PREFIX, DELIBERATELY.
 * `activity_log_company_or_denial_check` (migration `0274`) reads
 * `company_id IS NOT NULL OR action LIKE 'security.denied.%'`. A retention row
 * is written from `artifact-commit.ts` inside a LOCKED LEASE, so `ctx.companyId`
 * is always an FK-valid company and the row satisfies the NOT NULL arm. If a
 * future caller ever tries to write a company-less retention row the database
 * refuses it, which is the correct answer: a retention decision with no tenant
 * is not a record anyone can act on.
 */
export const SECURITY_RETENTION_ACTION_PREFIX = "security.retention.";

/**
 * Reserved `action` prefix for OBJECT-ACCESS AUTHORIZATIONS — DE-06's `audit`
 * clause, "object put/get and rejected-key attempts are audited", PUT/GET HALF.
 *
 * ★ WHY THIS IS A THIRD NAMESPACE AND NOT `security.denied.`. A granted transfer
 * is the OPPOSITE of a refusal. The denial reservation exists so that "count the
 * `security.denied.` rows" answers "count the refusals" and nothing else; filing
 * successful grants there would break exactly that property, which is the same
 * argument `SECURITY_RETENTION_ACTION_PREFIX` above makes for its own prefix.
 *
 * ★ WHAT A ROW IN THIS NAMESPACE MEANS, AND WHAT IT DOES NOT. It means the
 * control plane HANDED a named worker a presigned URL capable of a PUT or a GET
 * against a named object key, in a named tenant. It does NOT mean bytes moved:
 * the grant is redeemed DIRECTLY against object storage and the control plane
 * never observes the redemption (that is the whole point of the presigned
 * design — see `artifact-transfer-grant.ts`). So this record OVER-reports
 * access: an issued-but-never-redeemed GET still writes a row. Over-reporting is
 * the safe direction for a disclosure audit — a missed disclosure is
 * unrecoverable, a spurious one is merely noise — but a reader must not read a
 * row as proof of transfer. See `artifact-object-access-audit.ts`.
 *
 * ★ THE PARTIAL CHECK DOES NOT COVER THIS PREFIX, DELIBERATELY, for the same
 * reason it does not cover `security.retention.`: an object-access row is
 * written under a LOCKED LEASE, so `ctx.companyId` is always an FK-valid
 * company and the row satisfies `activity_log_company_or_denial_check`'s NOT
 * NULL arm (migration `0274`). A company-less object access should be refused by
 * the database, not laundered into the tenantless sink.
 */
export const SECURITY_OBJECT_ACCESS_ACTION_PREFIX = "security.object_access.";

/**
 * Reserved `action` prefix for CLOUD-PLUGIN BOOT RECONCILIATION — DE-16's `audit`
 * clause, RECONCILIATIONS CONJUNCT ("blocked plugin routes, dispatch, and
 * reconciliations are audited").
 *
 * ★ WHY A FOURTH NAMESPACE AND NOT `security.denied.`. A boot reconciliation is a
 * STATE/REVOCATION event, not a refused request. `reconcileCloudBlockedPlugins`
 * (`server/src/services/plugin-lifecycle.ts`) runs at `cloud_auth` boot and flips
 * a stale non-uninstalled `plugins` row to the blocked metadata-only state — it
 * refuses nothing, it records that a row was moved. Filing it under
 * `security.denied.` would make "count the denial rows" stop answering "count the
 * refusals", which is the exact property the denial reservation exists to hold —
 * the same argument `SECURITY_RETENTION_ACTION_PREFIX` and
 * `SECURITY_OBJECT_ACCESS_ACTION_PREFIX` make for their own prefixes, and the
 * reasoning the DE-12 generation-roll used for its own non-denial action. So: a
 * distinct prefix, a distinct recorder (`cloud-plugin-reconcile-audit.ts`), and a
 * distinct reservation, enforced at the same two caller-supplied-`action` writers.
 *
 * ★ THE ROUTE/DISPATCH CONJUNCT IS A DIFFERENT SHAPE AND STAYS IN `security.denied.`.
 * DE-16's route + dispatch deny sites are genuine REFUSALS of a caller-supplied
 * request that holds no trusted tenant, so E0-F013 Decision 3.2 records them via
 * `recordCloudPluginDenial` under `security.denied.cloud_plugin_execution` with a
 * NULL `company_id`. A reconciliation is the opposite: it carries a REAL,
 * FK-valid `plugins.company_id` (NOT NULL, references `companies`), so its row is
 * a normal company-attributed audit row, not a tenantless operator-sink row.
 *
 * ★ THE PARTIAL CHECK DOES NOT COVER THIS PREFIX, DELIBERATELY, for the same
 * reason it does not cover `security.retention.` / `security.object_access.`: a
 * reconciliation row always carries the reconciled plugin's own
 * `plugins.company_id`, which is NOT NULL and FK-valid, so the row satisfies
 * `activity_log_company_or_denial_check`'s NOT NULL arm (migration `0274`). A
 * company-less reconciliation is not a thing the reconciler can produce, and the
 * database refusing one would be the correct answer.
 */
export const SECURITY_RECONCILE_ACTION_PREFIX = "security.reconcile.";

export class ReservedActivityNamespaceError extends Error {
  constructor(message?: string) {
    super(
      message ??
        "Marketplace reconciliation audit events are reserved for the reconciliation service",
    );
  }
}

export function assertUnreservedActivityNamespace(input: {
  action: string;
  entityType: string;
}): void {
  if (
    input.entityType === MARKETPLACE_RECONCILIATION_ENTITY_TYPE ||
    input.action.startsWith(MARKETPLACE_RECONCILIATION_ACTION_PREFIX)
  ) {
    throw new ReservedActivityNamespaceError();
  }
  if (input.action.startsWith(SECURITY_DENIAL_ACTION_PREFIX)) {
    throw new ReservedActivityNamespaceError(
      "Security-denial audit events are reserved for the security-denial recorder",
    );
  }
  if (input.action.startsWith(SECURITY_RETENTION_ACTION_PREFIX)) {
    throw new ReservedActivityNamespaceError(
      "Retention-decision audit events are reserved for the retention recorder",
    );
  }
  if (input.action.startsWith(SECURITY_OBJECT_ACCESS_ACTION_PREFIX)) {
    throw new ReservedActivityNamespaceError(
      "Object-access audit events are reserved for the object-access recorder",
    );
  }
  if (input.action.startsWith(SECURITY_RECONCILE_ACTION_PREFIX)) {
    throw new ReservedActivityNamespaceError(
      "Reconciliation audit events are reserved for the cloud-plugin reconciliation recorder",
    );
  }
}
