#!/usr/bin/env tsx
// server/src/cli/resolve-unattributable-record.ts
//
// MIG-010 Unit 2.5 (E7-F006) — the OPERATOR REMEDY for one `unattributable` crosswalk record.
//
//   DATABASE_URL=postgres://aoa_operator:...@host/db \
//     pnpm resolve:unattributable-record \
//       --company <companyId> --resource-key <resourceKey> --reason "<justification>"
//
// THE PROBLEM THIS EXISTS FOR. `assertClosure` fails on ANY record whose disposition is
// `unattributable` (`legacy-resource-reconciliation.ts:290`), and `resolveResourceType`
// produces that disposition for a lease that is not `ephemeral` and carries no `agentId`,
// `commanderConversationId` or `executionWorkspaceId`. The crosswalk is APPEND-ONLY —
// migration `0256` grants no DELETE, `insertRecordIfAbsent` is `onConflictDoNothing`, and
// until this file no application code updated a record — so one such record refused the
// canary gate PERMANENTLY, with no remedy anywhere in the repository.
//
// ★ NO MIGRATION WAS NEEDED. `aoa_operator` has held `SELECT, INSERT, UPDATE` on the
// crosswalk since `0256` (`db/job-control-legacy-grants.ts:319-321`), and the
// `legacy_resource_reconciliation_operator_write` policy is `ALL` with `USING (true)` /
// `WITH CHECK (true)`. The grant existed and nothing used it; this is its first consumer.
//
// ★★★ THE TRANSITION IS `unattributable -> terminal_cleanup`, AND NOTHING ELSE.
// It is enforced in the `WHERE` clause rather than in TypeScript, which buys three
// properties a code-side check does not:
//
//   * IT MAY NEVER MINT `mapped`. `mapped` is the disposition that says "a live resource is
//     accounted for and left for drain" (`legacy-resource-reconciliation.ts:130-140`). An
//     operator asserting THAT about a resource nobody could classify is precisely the
//     forgeable claim — design section 9.2 rejects it by name. The SET list is a constant in
//     this file; there is no flag, no argument and no code path that produces any other
//     disposition.
//   * IT IS IDEMPOTENT, and a second run is a NO-OP rather than a silent overwrite of an
//     already-resolved record's justification. The predicate stops matching the moment the
//     first run commits.
//   * IT CANNOT REWRITE A `mapped` OR `terminal_cleanup` RECORD by mistake, including one
//     named by a mistyped `--resource-key` that happens to hit a real row.
//
// ★ WHAT IT IS NOT. There is NO bulk mode, deliberately: a bulk clear is how a register of
// unresolved problems becomes a register of nothing. One `(company, resourceKey)` per
// invocation, each with its own written justification.
//
// ★ THIS FLIPS NO GATE BY ITSELF. It removes ONE refusal. The canary preflight re-derives
// closure independently and refuses for many other reasons, and E7-1 remains gated by
// E7-F003 (the capability half) and the execution substrate.
//
// Follows the operator-entrypoint precedents `reconcile-legacy-resources.ts`,
// `verify-cp-am-keypair.ts` and `verify-e7-1-distributed-run.ts`: a CLI, not an HTTP route,
// because the crosswalk's own security model calls this "a SERVER-SIDE system/operator pass,
// NOT a per-tenant-request writer" and a cutover repair is a deliberate operator act.

import { sql } from "drizzle-orm";
import { createDb } from "@armyofagents/db";

/** The ONLY role this command may run as. See `assertOperatorRole`. */
const REQUIRED_ROLE = "aoa_operator";

/** The ONLY disposition this command may write. Not a parameter — a constant. */
const RESOLVED_DISPOSITION = "terminal_cleanup";

/**
 * The `cleanup_outcome` an operator resolution records. Distinct from `delegated_cli004` and
 * `no_handle`, which the PASS writes: a reader must be able to tell a machine-derived
 * terminal record from one a human asserted, and the justification in `reason` is the rest
 * of that audit trail.
 */
const RESOLVED_CLEANUP_OUTCOME = "operator_resolved";

interface Args {
  companyId?: string;
  resourceKey?: string;
  reason?: string;
  operator?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const out: Args = {};
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--company") out.companyId = rest[++i];
    else if (arg === "--resource-key") out.resourceKey = rest[++i];
    else if (arg === "--reason") out.reason = rest[++i];
    else if (arg === "--operator") out.operator = rest[++i];
  }
  return out;
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

/**
 * ★ ASSERT THE CONNECTED ROLE BEFORE THE FIRST READ.
 *
 * Identical in intent to `reconcile-legacy-resources.ts`, and load-bearing for the same
 * reason: an operator who exports a DATABASE_URL for the OWNER — the obvious thing to reach
 * for when a run fails on a permission error — gets a green run that establishes NOTHING
 * about the grant model. The owner bypasses every GRANT and every RLS policy, so this
 * command would succeed identically if `0256` had never granted `aoa_operator` UPDATE at
 * all. That is the BLOCKER E-1 defect wearing a different hat.
 *
 * It runs before the UPDATE, not after, so an owner connection changes no row.
 */
async function assertOperatorRole(db: ReturnType<typeof createDb>): Promise<void> {
  const rows = rowsOf<{ role: string }>(await db.execute(sql`SELECT current_user AS role`));
  const role = rows[0]?.role;
  if (role !== REQUIRED_ROLE) {
    console.error(
      `refusing to run as "${role ?? "<unknown>"}": this command must connect as ${REQUIRED_ROLE}.\n` +
        `Running it as the owner would succeed while proving nothing about the grant model — ` +
        `every GRANT and RLS policy would be bypassed.`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { companyId, resourceKey, reason, operator } = parseArgs(process.argv);

  if (!companyId || !resourceKey || reason === undefined || operator === undefined) {
    console.error(
      "usage: resolve-unattributable-record --company <companyId> " +
        '--resource-key <resourceKey> --reason "<justification>" --operator <handle>',
    );
    process.exit(2);
  }

  // ★ A BLANK JUSTIFICATION IS WORSE THAN NONE, because it LOOKS like a record. The whole
  // point of the `reason` rewrite is that a human said, in writing, why an unclassifiable
  // resource is safe to treat as terminal; whitespace says nothing and reads as something.
  const justification = reason.trim();
  if (justification.length === 0) {
    console.error(
      "--reason must be a non-empty justification: it is the audit trail this record carries " +
        "in place of a machine-derived classification.",
    );
    process.exit(2);
  }

  // ★ ATTESTATION, NOT AUTHENTICATION — and the difference is worth stating where someone
  // reading the row will look. `assertOperatorRole` below establishes the ONLY authenticated
  // fact available here: the role this process connected as. `--operator` is a self-declared
  // handle, exactly as forgeable as `--reason`, supplied by whoever already holds the
  // aoa_operator DATABASE_URL. It is recorded so an incident has a name to start from, not so
  // anyone can be held to it. Describing it as identity would be the false-enforcement claim
  // this programme treats as worse than a missing check.
  const operatorHandle = operator.trim();
  if (operatorHandle.length === 0) {
    console.error(
      "--operator must be a non-empty handle: it is the name an incident review starts from.",
    );
    process.exit(2);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }

  const db = createDb(dbUrl);
  await assertOperatorRole(db);

  // ★★★ THE TRANSITION GUARD LIVES HERE, IN THE `WHERE` CLAUSE. See the header: this is what
  // makes minting `mapped` structurally impossible, makes the command idempotent, and makes
  // a mistyped resource key a no-op instead of an overwrite. Moving this predicate into a
  // TypeScript pre-check would leave the UPDATE itself unguarded and reintroduce all three.
  //
  // ★★ AND `reason` IS NO LONGER TOUCHED (Codex P1). `reason` is the CLASSIFIER's verdict and
  // this crosswalk is EVIDENCE; an operator's prose overwriting it is a write over evidence,
  // even though the string it replaced is a compile-time constant. The justification now lands
  // in `resolution_reason` beside it, so the row carries both what the machine concluded and
  // what the human decided.
  //
  // ★ `resolved_at = now()` is the DATABASE clock, in the SAME statement that flips the
  // disposition — which is how the finding's "atomically" requirement is met without a
  // transaction, and without the operator pool needing any authority it does not already hold.
  // Before this, the only timestamp on a resolved row was `created_at`: the PASS's insert time,
  // which PREDATES the decision it records.
  const updated = rowsOf<{
    resource_key: string;
    disposition: string;
    cleanup_outcome: string;
    resolved_at: string;
    resolved_by: string;
  }>(
    await db.execute(sql`
      UPDATE legacy_resource_reconciliation
         SET disposition = ${RESOLVED_DISPOSITION},
             cleanup_outcome = ${RESOLVED_CLEANUP_OUTCOME},
             resolution_reason = ${justification},
             resolved_by = ${operatorHandle},
             resolved_at = now()
       WHERE company_id = ${companyId}
         AND resource_key = ${resourceKey}
         AND disposition = 'unattributable'
      RETURNING resource_key, disposition, cleanup_outcome, resolved_at, resolved_by`),
  );

  // 0 rows is NOT success. It means "no such unattributable record" — either the key names
  // nothing, or it names a record that is already resolved or was never unattributable — and
  // an operator who cannot tell that apart from a repair will believe a gate was unblocked
  // when it was not.
  if (updated.length === 0) {
    console.error(
      `no unattributable record for company ${companyId} resource_key ${resourceKey}: ` +
        `nothing was changed. The record may not exist, or may already be resolved — ` +
        `this command only ever transitions unattributable -> ${RESOLVED_DISPOSITION}.`,
    );
    process.exit(1);
  }

  for (const row of updated) {
    console.log(
      `resolved ${row.resource_key}: unattributable -> ${row.disposition} ` +
        `(cleanup_outcome=${row.cleanup_outcome})`,
    );
  }
  console.log(`rows changed: ${updated.length}`);
  console.log(
    `\nThis flips no gate on its own: it removes ONE refusal. The canary preflight ` +
      `re-derives closure independently and refuses for other reasons, and E7-1 remains ` +
      `gated by E7-F003 and the execution substrate.`,
  );

  process.exit(0);
}

void main().catch((error) => {
  // An unreadable or failed repair is NOT a repair. Fail with a non-zero exit.
  console.error(
    `resolve-unattributable-record failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
});
