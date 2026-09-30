#!/usr/bin/env tsx
// server/src/cli/reconcile-legacy-resources.ts
//
// MIG-010 Unit 2.3 (E10-F002) — the reconciliation pass's OPERATOR ENTRYPOINT.
//
//   DATABASE_URL=postgres://aoa_operator:...@host/db \
//     pnpm reconcile:legacy-resources --organization <organizationId>
//
// Reconciles every Company under one Organization into the append-only
// `legacy_resource_reconciliation` crosswalk, and prints the per-company closure verdict.
// Exit 0 iff EVERY Company closed; exit 1 otherwise, naming the companies that did not.
//
// ★ WHY THIS FILE IS THE POINT OF THE UNIT. `reconcileCompanyLegacyResources` and
// `createDrizzleReconciliationStore` each had ZERO non-test callers for the life of MIG-008.
// The crosswalk was therefore never written, `assertClosure` found every inventory key
// unmapped, and `canary-preflight.ts` answered `reconciliation_incomplete` for every
// organization, forever. That is E10-F002. This is its caller — and
// `scripts/gate-clause-wiring.json` now holds a `wired` declaration naming
// `reconcileOrganizationLegacyResources`, so the guard fails if this call site disappears.
//
// ★ NOT AN HTTP ROUTE AND NOT AUTOMATIC. The crosswalk's own security model
// (packages/db/src/schema/legacy_resource_reconciliation.ts:11-22, migration 0256) calls
// this "a SERVER-SIDE system/operator pass, NOT a per-tenant-request writer", and a cutover
// reconciliation is a deliberate operator act. It follows the two existing precedents,
// `verify-cp-am-keypair.ts` and `verify-e7-1-distributed-run.ts`.
//
// ★ THIS FLIPS NO GATE, AND THE CANARY STAYS SHUT. Unit 2.3 closed E10-F002; Unit 2.4a adds
// the durable MARKER of a completed pass (`legacy_reconciliation_passes`, migration 0269) and
// nothing more. NOTHING READS THE MARKER YET — `canary-preflight.ts` is untouched, there is no
// `reconciliation_stale`, and a lease created after this pass still re-closes the gate
// (E7-F004, design §1.2(1)). That is Unit 2.4b.
//
// READ-ONLY against tenant data (Option R): the only write is the append-only crosswalk
// insert, on the one relation `aoa_operator` is granted. It never kills a live sandbox and
// never claims a paused row.

import { sql } from "drizzle-orm";
import { createDb } from "@armyofagents/db";
import { reconcileOrganizationLegacyResources } from "../services/legacy-resource-reconciliation.js";
import { createDrizzleReconciliationStore } from "../services/legacy-resource-reconciliation-store.js";

/** The ONLY role this pass may run as. See `assertOperatorRole`. */
const REQUIRED_ROLE = "aoa_operator";

function parseArgs(argv: readonly string[]): { organizationId?: string } {
  const out: { organizationId?: string } = {};
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--organization" || arg === "--org") {
      out.organizationId = rest[++i];
    }
  }
  return out;
}

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[];
}

/**
 * ★ ASSERT THE CONNECTED ROLE BEFORE THE FIRST READ.
 *
 * Without this the entire SECURITY DEFINER design is DECORATIVE. An operator who exports a
 * DATABASE_URL for the owner — the obvious thing to reach for when a run fails with a
 * permission error — gets a completely green run that establishes NOTHING about the grant
 * model: the owner satisfies every definer function's authority directly and bypasses every
 * EXECUTE grant, so the pass would succeed identically if 0268 had never been written and
 * `aoa_operator` held no grant at all. That is the E-1 defect wearing a different hat, and it
 * is not hypothetical — it is the single easiest way to run this command wrong.
 *
 * `assertExactServingRoleAuthority` and `assertNonOwnerConnection`
 * (distributed-execution-databases.ts:511, :641) are NOT exported, so this is built here
 * rather than imported. It is deliberately the narrowest possible check: what role am I.
 */
async function assertOperatorRole(db: ReturnType<typeof createDb>): Promise<void> {
  const rows = rowsOf<{ role: string }>(await db.execute(sql`SELECT current_user AS role`));
  const role = rows[0]?.role;
  if (role !== REQUIRED_ROLE) {
    console.error(
      `refusing to run as "${role ?? "<unknown>"}": this pass must connect as ${REQUIRED_ROLE}.\n` +
        `Running it as the owner would succeed while proving nothing about the grant model — ` +
        `every definer function and EXECUTE grant would be bypassed.`,
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const { organizationId } = parseArgs(process.argv);

  if (!organizationId) {
    console.error("usage: reconcile-legacy-resources --organization <organizationId>");
    process.exit(2);
  }

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(2);
  }

  const db = createDb(dbUrl);
  await assertOperatorRole(db);

  const result = await reconcileOrganizationLegacyResources(organizationId, {
    store: createDrizzleReconciliationStore(db),
  });

  console.log(`organization ${result.organizationId}: ${result.companies.length} company(ies)`);
  // The pass identity and the DB-clock snapshot instant every marker this run wrote carries.
  // An operator debugging a `reconciliation_stale` refusal in Unit 2.4b needs both, and
  // reconstructing them from the table afterwards is strictly worse than printing them.
  console.log(
    `  pass ${result.passId} snapshot ${result.snapshotAt.toISOString()} (database clock)`,
  );
  for (const company of result.companies) {
    const { closure } = company;
    console.log(
      `  ${closure.ok ? "OK    " : "REFUSE"} ${company.companyId} ` +
        `inserted=${company.insertedKeys.length} ` +
        `(unmapped=${closure.unmapped.length}, duplicates=${closure.duplicates.length}, ` +
        `unattributable=${closure.unattributable.length})`,
    );
  }
  if (result.companies.length === 0) {
    // The same refusal `canary-preflight.ts:131-137` makes. An empty enumeration is not
    // closure; answering OK here would be the vacuous-closure fail-open.
    console.error(`organization ${organizationId} resolves to no Companies — nothing reconciled`);
  }

  // The canary is NOT opened by this. Said on every run so an operator reading the output
  // cannot mistake a green pass for an open gate.
  console.log(
    `\nreconciled=${result.ok ? "closed" : "NOT closed"}. This flips no gate: the canary ` +
      `preflight re-derives closure independently, and a lease created after this pass ` +
      `re-closes it (E7-F004, Unit 2.4b). A completed-pass marker was written for each ` +
      `company above; nothing reads it yet.`,
  );

  process.exit(result.ok ? 0 : 1);
}

void main().catch((error) => {
  // An unreadable pass is NOT a closure. Fail closed with a non-zero exit.
  console.error(
    `reconcile-legacy-resources failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
