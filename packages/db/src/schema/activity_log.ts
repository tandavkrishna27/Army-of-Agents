import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, jsonb, index, check } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { organizations } from "./organizations.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * ★ E0-F013 DECISION 2, RULED (a2) — 2026-09-09.
 * `docs/replatform/DECISION-REQUEST-unattributable-denial-sink.md` §4.
 *
 * `company_id` was `NOT NULL` and that NOT NULL was, for every product writer,
 * the ONLY enforcement that a row belongs to a company. It was also the reason a
 * denial with no FK-valid tenant — a replayed worker proof (DE-03), a fleet-wide
 * provider kill (DE-15), five of DE-06's six fence throws — could not be
 * recorded at all: `recordSecurityDenial` logged and returned null, so those
 * refusals stayed indistinguishable from traffic that never happened.
 *
 * The ruling relaxes the column and REPLACES the guarantee it carried, rather
 * than trading it away:
 *
 *   1. `company_id` becomes NULLABLE.
 *   2. a NULLABLE `organization_id` is added, because the residual sinks hold a
 *      TOKEN-ATTESTED organization even when they hold no company. A row that
 *      says "this organization was refused" is worth more than one that says
 *      "someone was refused somewhere". ★ It is not stamped by the caller: see
 *      the recorder's contract in `security-denial-audit.ts`.
 *   3. the partial CHECK below retains the NOT NULL guarantee for EVERY product
 *      writer and relaxes it ONLY inside the reserved `security.denied.` action
 *      namespace that `assertUnreservedActivityNamespace` already fences off.
 *      All ~34 direct `insert(activityLog)` product sites are still rejected by
 *      the database if they omit `companyId`.
 *
 * ★ THE CHECK IS THE INVARIANT THE RULING TURNS ON, and a LIKE over text is
 * strictly weaker than NOT NULL, so it carries its own provocation: a NON-denial
 * row with a null `company_id` must be REJECTED
 * (`e0-f013-unattributable-denial-sink.integration.test.ts`, arm 1), observed
 * red against the unchanged tree and mutated to prove the predicate is load
 * bearing.
 *
 * ★ N/N-1 COMPATIBILITY. `remote-compose-deploy.sh` rolls the binary back
 * WITHOUT reverting the database, so this must be expand-only: `DROP NOT NULL`
 * widens the set of rows the old binary can write (it never wrote a null, and
 * still cannot — the CHECK stops it outside the denial namespace) and the old
 * binary's SELECTs never name `organization_id`, so a nullable ADD COLUMN is
 * invisible to it.
 */
export const activityLog = pgTable(
  "activity_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // NULLABLE since E0-F013 Decision 2 (a2). Null is admissible ONLY for rows
    // in the reserved `security.denied.` namespace — see `companyOrDenial` below.
    //
    // ★ ON DELETE set null since E0-F013 Decision 3.3 (Q5), founder-ruled
    // 2026-09-11. A `security.denied.*` denial record must SURVIVE the deletion of
    // the company it incriminates — otherwise a hostile founder erases the operator
    // plane's only copy of their own probing by deleting their own tenant (§7.2 of
    // `docs/replatform/DECISION-REQUEST-denial-retention-and-disclosure.md`). Under
    // the previous `cascade`, deleting the company destroyed every denial row filed
    // under it. `set null` makes the COMPANY axis agree with the ORGANIZATION axis's
    // existing `restrict` (§7.4): on both, denial evidence outlives the tenant.
    //
    // ★ WHY `set null` AND NOT `restrict` HERE. `restrict` on the company axis would
    // make ANY company holding a denial row UNDELETABLE, breaking the product's
    // erasure mechanism. `set null` keeps the company deletable while orphaning (not
    // destroying) the denial evidence. It is safe ONLY because the partial CHECK
    // below confines a null company_id to the `security.denied.` namespace: a null
    // set on a NON-denial row would violate the CHECK and make the delete fail. So
    // `companyService.remove` deletes ordinary rows BEFORE the company delete (and
    // nulls the denial rows itself, belt-and-suspenders), leaving no non-denial row
    // for the FK's set-null to touch. Any future writer that lands a non-denial row
    // on this FK path owes that same ordering, or the company becomes undeletable.
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    // The second tenant axis. Null on ~100% of rows by design: no product writer
    // populates it, and it exists so an organization-only denial is attributable
    // to something rather than to nothing. `restrict` (not `cascade`) mirrors
    // `companies.organization_id`: denial evidence must not be deletable by
    // deleting the organization it incriminates.
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("activity_log_company_created_idx").on(table.companyId, table.createdAt),
    runIdIdx: index("activity_log_run_id_idx").on(table.runId),
    entityIdx: index("activity_log_entity_type_id_idx").on(table.entityType, table.entityId),
    organizationIdx: index("activity_log_organization_idx").on(table.organizationId),
    /**
     * ★ THE DENIAL-PREFIX INDEX — E0-F013 Decision 2, acceptance condition (a),
     * second half. Filed NOT-DONE by the unit that shipped the reader because
     * this file was that wave's other unit's; that collision is over (`0274`
     * landed), so it is paid here.
     *
     * WHY THIS SHAPE, and not `(action)`. The reader
     * (`activityService.securityDenials`) is `WHERE action LIKE
     * 'security.denied.%'` under a TOTAL order `created_at DESC, id DESC`, and
     * it pages by a row-value keyset over that same pair. A plain `(action)`
     * btree cannot serve `LIKE 'prefix%'` under the C locale as a range without
     * `text_pattern_ops`, and even where it could it would still leave the Sort
     * in place. Putting the namespace in the index PREDICATE instead of the key
     * makes the predicate free, and keying on `(created_at DESC, id DESC)` makes
     * the ordering free too — so the plan becomes an ordered index scan feeding
     * the LIMIT directly, with no Sort and no Seq Scan.
     *
     * ★ IT IS ONLY REACHED WHEN THE PLANNER CAN PROVE THE PREDICATE. Postgres
     * matches a partial index by implication against the query's own WHERE, and
     * the reader emits the identical `action LIKE 'security.denied.%'` literal,
     * so the match holds. That literal is the value of
     * `SECURITY_DENIAL_ACTION_PREFIX` — the same constant the CHECK below is
     * written against and that `activity-reserved-namespace.test.ts` pins, so
     * the index, the CHECK and the reader cannot drift apart silently.
     *
     * ★ WHAT IT DOES NOT DO. It does not make the reader safe, cheap for
     * non-denial queries, or smaller: it indexes ONLY denial rows, so every
     * ordinary product row costs nothing to maintain and is invisible to it.
     * The measured plan change is pasted in
     * `docs/replatform/epics/E0-foundation/findings.md`.
     *
     * ★ `nullsFirst()` IS LOAD BEARING, AND IT IS NOT COSMETIC. Postgres will
     * only walk an index to satisfy an ORDER BY when the NULLS ordering matches
     * too, and bare `DESC` in a query means `DESC NULLS FIRST` while drizzle's
     * bare `.desc()` emits `DESC NULLS LAST` for an index. The first generated
     * version of this index used the default and was measured: the planner
     * still put a `Sort` on top, so it removed the Seq Scan and left the O(n
     * log n) behind. Both columns are NOT NULL so no row's placement changes —
     * this exists solely so the ordering MATCHES `securityDenials`' ORDER BY.
     */
    denialCreatedIdx: index("activity_log_denial_created_idx")
      .on(table.createdAt.desc().nullsFirst(), table.id.desc().nullsFirst())
      .where(sql`action LIKE 'security.denied.%'`),
    // ★ The retained NOT NULL. `action` is the only column that identifies the
    // denial namespace, and the prefix is the literal value of
    // `SECURITY_DENIAL_ACTION_PREFIX` (`server/src/services/activity-namespace.ts`);
    // `activity-reserved-namespace.test.ts` pins that constant so this predicate
    // and that guard cannot drift apart silently.
    companyOrDenial: check(
      "activity_log_company_or_denial_check",
      sql`company_id IS NOT NULL OR action LIKE 'security.denied.%'`,
    ),
  }),
);
