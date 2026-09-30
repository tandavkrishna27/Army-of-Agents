import { and, desc, eq, getTableColumns, gte, isNull, like, or, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { activityLog, heartbeatRuns, issues } from "@armyofagents/db";
import {
  SECURITY_DENIAL_ACTION_PREFIX,
  assertUnreservedActivityNamespace,
  notDenialNamespace,
} from "./activity-namespace.js";

export interface ActivityFilters {
  companyId: string;
  agentId?: string;
  actorType?: "agent" | "user" | "system" | "autonomy";
  actorId?: string;
  entityType?: string;
  entityId?: string;
}

/**
 * Filters for the operator-plane `security.denied.*` reader. Every field is
 * optional: the unfiltered call is the incident-response case ("show me the most
 * recent refusals across the instance"), and the filters narrow it to one
 * crossing, one surface, one actor, one resource, or one tenant.
 *
 * `companyId` is a FILTER here, never a scope — this reader is cross-tenant by
 * construction and is gated on the operator plane, not on company membership.
 */
export interface SecurityDenialQuery {
  /** The threat-controls crossing id, read from the row's `details.crossing`. */
  crossing?: string;
  /** The denial surface slug, i.e. the `action` suffix after the reserved prefix. */
  surface?: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  /** Narrow to ONE tenant's refusals. Never widens; a NULL-company row cannot match. */
  companyId?: string;
  /** Inclusive LOWER time bound. */
  since?: Date;
  /**
   * ★ THE KEYSET CURSOR — strict UPPER bound, and the only way to reach evidence
   * older than one page. See `securityDenials` for why a lower bound plus a
   * limit is not enough.
   *
   * ★ IT IS A STRING, NOT A `Date`, AND THAT IS THE WHOLE POINT. Postgres stores
   * `created_at` at MICROSECOND precision; a JS `Date` — and therefore anything
   * that has been through `JSON.stringify` — holds MILLISECONDS. Measured on
   * real Postgres, 40 rows written by 40 separate statements had 40 distinct
   * microsecond timestamps and only 21 distinct millisecond ones, so a cursor
   * that was truncated to milliseconds anywhere on its round trip would silently
   * SKIP roughly half of them. This value is carried as text end to end and cast
   * to `timestamptz` in SQL so no truncation can occur. The reader emits it as
   * the `cursor` field for exactly this reason — do NOT page on `createdAt`.
   */
  before?: string;
  /**
   * The tiebreaker half of the cursor: the `id` of the last row of the previous
   * page. Required whenever `before` came from a page boundary, because
   * `created_at` is NOT unique — rows written by one statement share `now()`, so
   * a timestamp-only cursor either skips or repeats every row on a tie.
   */
  beforeId?: string;
  limit?: number;
}

/**
 * The full-precision paging key, emitted alongside every denial row.
 *
 * `created_at` reaches a client as JSON, where it is a `Date` truncated to
 * milliseconds — unusable as a keyset cursor (see `SecurityDenialQuery.before`).
 * This projects the same instant as UTC text at microsecond precision, which is
 * exactly what `::timestamptz` reads back, so `cursor` + `id` round-trip the row
 * order losslessly.
 */
const DENIAL_CURSOR_SQL = sql<string>`to_char(${activityLog.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const SECURITY_DENIAL_DEFAULT_LIMIT = 100;
export const SECURITY_DENIAL_MAX_LIMIT = 500;

/**
 * The PAGE SIZE. A missing, non-finite or non-positive value takes the default
 * rather than meaning "no limit".
 *
 * ★ WHAT THIS DOES NOT DO, stated because the earlier version of this comment
 * claimed it did. It bounds the RESULT SET, not the scan. The scan is bounded by
 * an INDEX, and that is a separate mechanism that this function knows nothing
 * about — see below.
 *
 * ★ THE SCAN CLAIM, UPDATED BECAUSE IT IS NOW FALSE AS PREVIOUSLY WRITTEN. This
 * comment used to say the denial query "is planned as
 * `Limit <- Sort <- Seq Scan on activity_log`" and that the missing index was
 * filed NOT-DONE. Migration `0276` added it — a PARTIAL index on
 * `(created_at DESC, id DESC) WHERE action LIKE 'security.denied.%'` — so the
 * plan is now `Limit <- Index Scan using activity_log_denial_created_idx`, with
 * no Sort and no Seq Scan, and the keyset cursor's row-value comparison becomes
 * an `Index Cond` rather than a per-row `Filter`. Measured on real Postgres over
 * 60,300 rows: `Rows Removed by Filter: 60000` and 1,098 shared buffers before,
 * 6 buffers after; on the deep page, 1,098 buffers before and 4 after. Both
 * plans are pasted in `docs/replatform/epics/E0-foundation/findings.md`, and
 * `e0-f013-denial-index-plan.integration.test.ts` asserts the plan — of the
 * query `securityDenials` actually builds, not of a copy of it — so this
 * paragraph cannot go stale silently again.
 */
export function clampDenialLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SECURITY_DENIAL_DEFAULT_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return SECURITY_DENIAL_DEFAULT_LIMIT;
  return Math.min(floored, SECURITY_DENIAL_MAX_LIMIT);
}

export function activityService(db: Db) {
  const issueIdAsText = sql<string>`${issues.id}::text`;
  return {
    list: (filters: ActivityFilters) => {
      // E0-F013 Decision 3 (Q3), founder-ruled 2026-09-11: a `security.denied.*`
      // row is disclosed to NO tenant, including the actor's own. This is a
      // tenant-facing reader (`GET /companies/:cid/activity`, gated on plain
      // company membership), so it excludes the denial namespace. The operator
      // reader `securityDenials` below deliberately does not.
      const conditions = [
        eq(activityLog.companyId, filters.companyId),
        notDenialNamespace(),
      ];

      if (filters.agentId) {
        conditions.push(eq(activityLog.agentId, filters.agentId));
      }
      if (filters.actorType) {
        conditions.push(eq(activityLog.actorType, filters.actorType));
      }
      if (filters.actorId) {
        conditions.push(eq(activityLog.actorId, filters.actorId));
      }
      if (filters.entityType) {
        conditions.push(eq(activityLog.entityType, filters.entityType));
      }
      if (filters.entityId) {
        conditions.push(eq(activityLog.entityId, filters.entityId));
      }

      return db
        .select({ activityLog })
        .from(activityLog)
        .leftJoin(
          issues,
          and(
            eq(activityLog.entityType, sql`'issue'`),
            eq(activityLog.entityId, issueIdAsText),
          ),
        )
        .where(
          and(
            ...conditions,
            or(
              sql`${activityLog.entityType} != 'issue'`,
              isNull(issues.hiddenAt),
            ),
          ),
        )
        .orderBy(desc(activityLog.createdAt))
        .then((rows) => rows.map((r) => r.activityLog));
    },

    /**
     * One task's activity feed, scoped to the tenant that owns the task.
     *
     * ★ THE `companyId` PARAMETER IS A SECURITY FIX, NOT ERGONOMICS — E0-F013
     * Decision 2, acceptance condition (c). This reader used to filter on
     * `entityType='issue'` + `entityId` and nothing else, while its only route
     * (`GET /issues/:id/activity`) gates on THE ISSUE's company, never on the
     * ROW's. `entityType`/`entityId` are caller-supplied free text on the
     * security-denial recorder, so a denial recorded in tenant B and typed
     * `issue` against tenant A's issue id came back to a tenant-A reader. That
     * was measured LATENT rather than live — all three production denial writers
     * hard-code `memory_item` or `job_artifact` — and it is closed here because
     * the ruling that makes `company_id` NULLABLE removes the other half of what
     * was accidentally containing it.
     *
     * ★ IT IS ALSO THE DEFENCE AGAINST THE NULLABLE COLUMN, by construction: a
     * NULL `company_id` never satisfies `company_id = $1`, so a tenantless denial
     * row is invisible to this reader the moment that column lands. Nothing here
     * needs to know the column changed.
     *
     * ★ NOT A CLASS FIX, stated rather than implied. The other company-unscoped
     * `activity_log` reader (`marketplace-reconcile.ts`
     * `inspectMarketplaceReconciliation`) is untouched. It is instance-wide by
     * design — its operation spans many companies, so there is no single company
     * to scope it to — and it was measured separately to discard denial rows
     * anyway: every row it selects is then filtered by exact `action` equality
     * against three `marketplace.reconciliation_*` literals, and only surviving
     * rows reach its output. That is containment by downstream construction, not
     * by this change.
     *
     * The proving test is `e0-f013-denial-disclosure-path.integration.test.ts`,
     * which plants a real denial row through the real recorder and asserts the
     * real route does not return it. It was observed RED on exactly that arm,
     * with its three positive controls green, before this predicate existed.
     */
    forIssue: (companyId: string, issueId: string) =>
      db
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.entityType, "issue"),
            eq(activityLog.entityId, issueId),
            // E0-F013 Decision 3 (Q3), founder-ruled 2026-09-11: this is a tenant-facing
            // reader of `activity_log`, so it excludes the `security.denied.*` namespace too.
            // `recordSecurityDenial` accepts `entityType:'issue'`, so the disclosure boundary
            // must not depend on "no writer happens to file a denial under an issue" (Codex P2,
            // PR #429). The operator reader `securityDenials` still returns them.
            notDenialNamespace(),
          ),
        )
        .orderBy(desc(activityLog.createdAt)),

    runsForIssue: (companyId: string, issueId: string) =>
      db
        .select({
          runId: heartbeatRuns.id,
          status: heartbeatRuns.status,
          agentId: heartbeatRuns.agentId,
          startedAt: heartbeatRuns.startedAt,
          finishedAt: heartbeatRuns.finishedAt,
          createdAt: heartbeatRuns.createdAt,
          invocationSource: heartbeatRuns.invocationSource,
          logStore: heartbeatRuns.logStore,
          logRef: heartbeatRuns.logRef,
          processPid: heartbeatRuns.processPid,
          processStartedAt: heartbeatRuns.processStartedAt,
          lastOutputAt: heartbeatRuns.lastOutputAt,
          activeExecutionMs: heartbeatRuns.activeExecutionMs,
          humanQuestionWaitMs: heartbeatRuns.humanQuestionWaitMs,
          runtimePermissionWaitMs: heartbeatRuns.runtimePermissionWaitMs,
          totalWallClockMs: heartbeatRuns.totalWallClockMs,
          usageJson: heartbeatRuns.usageJson,
          resultJson: heartbeatRuns.resultJson,
          detectedOutputs: heartbeatRuns.detectedOutputs,
          promptSnapshot: heartbeatRuns.promptSnapshot,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            or(
              sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
              sql`exists (
                select 1
                from ${activityLog}
                where ${activityLog.companyId} = ${companyId}
                  and ${activityLog.entityType} = 'issue'
                  and ${activityLog.entityId} = ${issueId}
                  and ${activityLog.runId} = ${heartbeatRuns.id}
              )`,
            ),
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt)),

    companyIdForRun: async (runId: string): Promise<string | null> => {
      const run = await db
        .select({ companyId: heartbeatRuns.companyId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      return run?.companyId ?? null;
    },

    issuesForRun: async (runId: string) => {
      const run = await db
        .select({
          companyId: heartbeatRuns.companyId,
          contextSnapshot: heartbeatRuns.contextSnapshot,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .then((rows) => rows[0] ?? null);
      if (!run) return [];

      const fromActivity = await db
        .selectDistinctOn([issueIdAsText], {
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
        })
        .from(activityLog)
        .innerJoin(issues, eq(activityLog.entityId, issueIdAsText))
        .where(
          and(
            eq(activityLog.companyId, run.companyId),
            eq(activityLog.runId, runId),
            eq(activityLog.entityType, "issue"),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(issueIdAsText);

      const context = run.contextSnapshot;
      const contextIssueId =
        context && typeof context === "object" && typeof (context as Record<string, unknown>).issueId === "string"
          ? ((context as Record<string, unknown>).issueId as string)
          : null;
      if (!contextIssueId) return fromActivity;
      if (fromActivity.some((issue) => issue.issueId === contextIssueId)) return fromActivity;

      const fromContext = await db
        .select({
          issueId: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
        })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, run.companyId),
            eq(issues.id, contextIssueId),
            isNull(issues.hiddenAt),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!fromContext) return fromActivity;
      return [fromContext, ...fromActivity];
    },

    /**
     * ★ THE READER FOR `security.denied.*` — E0-F013 Decision 2, acceptance
     * condition (a).
     *
     * ★ WHY IT HAD TO SHIP THIS WAVE. The decision paper measured that NO
     * production reader of the `security.denied.*` namespace existed anywhere in
     * `server/src` or `ui/src` — three writers, a namespace guard, and prose.
     * Adding a fourth writer (and, under the ruling, rows that no company-scoped
     * reader can ever match) to a store nobody queries produces evidence that is
     * present and unreachable: a claim of coverage with no observation behind it.
     * That is the exact failure class this programme exists to stop, so the
     * ruling made a reader an acceptance condition rather than a follow-up.
     *
     * ★ WHO CAN READ IT, AND WHY IT IS DELIBERATELY NOT A COMPANY SURFACE. This
     * is cross-tenant by design and is served ONLY behind the operator plane
     * (`assertCanManageInstanceSettings` — `req.actor.operator` /
     * `local_implicit`, NOT `isInstanceAdmin`, which is clamped to false in
     * cloud_auth). It is reachable from no company-scoped route.
     *
     * ★ THE DISCLOSURE QUESTION, ANSWERED BY FOLLOWING DE-06's PRECEDENT AND
     * SAYING SO. A cross-tenant denial is evidence about TWO tenants: the actor's
     * and the probed one. Both live writers already answer this the same way —
     * attribute the row to the ACTOR's own tenant, never the probed one — and
     * DE-06's proving test asserts the PROBED tenant's `activity_log` is EMPTY.
     * This reader follows that precedent: it adds NO per-company denial feed, so
     * the probed tenant still learns nothing about having been probed or by whom.
     * That question (whose log a cross-tenant probe belongs in, and whether a
     * probed tenant is entitled to know) is Decision 3's, and this deliberately
     * does not pre-empt it.
     *
     * ★ WHY AN OPERATOR QUERY AND NOT A UI. The evidence is instance-wide and its
     * audience is one operator investigating an incident; a company-scoped UI is
     * the one shape that would answer Decision 3 by accident, in the direction
     * that discloses. A narrow, documented, operator-gated surface is what can be
     * shipped without deciding that. See `docs/api/activity.md`.
     *
     * ★ FORWARD-COMPATIBLE WITH UNIT A, ON PURPOSE. `select()` projects whatever
     * columns the schema carries, so the nullable `company_id` and the new
     * `organization_id` this wave adds appear here the moment they land, with no
     * change to this file and no compile-time coupling to a column that does not
     * exist yet. Rows with a NULL `company_id` are visible ONLY here: no
     * company-scoped reader can match them.
     *
     * ★ WHY THERE IS A CURSOR, AND WHY IT IS A KEYSET ONE. A page size plus a
     * LOWER bound (`since`) is not a pager: moving `since` earlier only ever adds
     * NEWER rows, so past one page of matches the OLDEST rows are unreachable
     * through the only production reader of this namespace. That is evidence
     * written and unreachable — the exact failure acceptance condition (a) exists
     * to prevent, reappearing in the tail — so `before`/`beforeId` are part of the
     * condition being met, not an ergonomic extra.
     *
     * It is a keyset (`(created_at, id) < (before, beforeId)`) rather than an
     * OFFSET because `created_at` is not unique — a single INSERT ... SELECT of
     * denial rows shares one `now()` — and a timestamp-only cursor silently SKIPS
     * rows on a tie, which is the same "unreachable evidence" failure wearing a
     * pagination name. The order is therefore a total one (`created_at DESC, id
     * DESC`) so that the cursor and the ordering agree.
     *
     * ★ AND THE CURSOR IS EMITTED, NOT INFERRED FROM `createdAt`. Page on the
     * `cursor` field plus `id`, never on `createdAt`: `createdAt` arrives at the
     * client as JSON and is therefore truncated to milliseconds, while the rows
     * are ordered at microsecond precision. Measured, this is not theoretical —
     * 40 rows written by 40 separate statements had 40 distinct microsecond
     * timestamps and 21 distinct millisecond ones, so a `createdAt`-based cursor
     * would have skipped 19 of them without erroring. `cursor` carries the same
     * instant as microsecond-precision UTC text and casts back exactly.
     *
     * ★ AND IT IS NOW CHEAP AS WELL AS REACHABLE — the second half of the same
     * acceptance condition, previously filed NOT-DONE here. When this comment
     * was written there was no index on `action`, so every page was a seq scan
     * plus a sort and deep paging was O(table) EACH TIME: the cursor made the
     * evidence reachable and re-read the whole table to reach it. Migration
     * `0276` adds a partial index on `(created_at DESC, id DESC)
     * WHERE action LIKE 'security.denied.%'`, which the predicate and the ORDER
     * BY here are written to match exactly.
     *
     * ★ HOW THAT MATCH IS HELD, STATED PRECISELY BECAUSE THE PREVIOUS VERSION OF
     * THIS PARAGRAPH OVERSTATED IT. It used to say "change either and the
     * planner silently stops using it". Measured, that is true of the ACTION
     * PREFIX (the WHERE stops implying the index predicate) and of the SORT
     * DIRECTION (the index cannot be walked that way), and FALSE of dropping
     * `desc(activityLog.id)` below: `created_at DESC` alone is a PREFIX of the
     * index key order, so the planner keeps the Index Scan and the plan does not
     * change at all. What breaks then is the TOTAL ORDER the keyset cursor
     * needs — pages lose rows on a `created_at` tie, with a 200 and no error.
     *
     * `e0-f013-denial-index-plan.integration.test.ts` covers both halves, and
     * covers them by building its plans from THIS FUNCTION (`getSQL()` off
     * `securityDenials`) rather than from a transcription of its SQL. That is
     * load bearing: while it held hand-copied literals, dropping the tiebreaker
     * left it and its sibling suite 23/23 GREEN, because it was planning a copy
     * of this query rather than this query. Its MATCHED PAIR arm additionally
     * compares the ORDER BY emitted here against `pg_indexes.indexdef`, and that
     * arm is the only thing that sees the TIEBREAKER drift — the one the plan
     * arms cannot see, because dropping `id` leaves a prefix of the index key
     * order and the plan is unchanged. The action-prefix and direction drifts
     * are caught by the plan arms (a changed prefix reds 5 of the 7).
     */
    securityDenials: (filters: SecurityDenialQuery = {}) => {
      const conditions = [
        like(activityLog.action, `${SECURITY_DENIAL_ACTION_PREFIX}%`),
      ];
      if (filters.companyId) {
        conditions.push(eq(activityLog.companyId, filters.companyId));
      }
      if (filters.surface) {
        conditions.push(
          eq(activityLog.action, `${SECURITY_DENIAL_ACTION_PREFIX}${filters.surface}`),
        );
      }
      if (filters.actorId) {
        conditions.push(eq(activityLog.actorId, filters.actorId));
      }
      if (filters.entityType) {
        conditions.push(eq(activityLog.entityType, filters.entityType));
      }
      if (filters.entityId) {
        conditions.push(eq(activityLog.entityId, filters.entityId));
      }
      if (filters.since) {
        conditions.push(gte(activityLog.createdAt, filters.since));
      }
      // ★ The cursor. With `beforeId` this is a row-value comparison, which is
      // exactly the total order the ORDER BY below imposes, so no row on a
      // `created_at` tie can be skipped or repeated across a page boundary.
      // Without it, `before` is still a useful plain upper bound ("refusals
      // older than this moment").
      if (filters.before && filters.beforeId) {
        conditions.push(
          sql`(${activityLog.createdAt}, ${activityLog.id}) < (${filters.before}::timestamptz, ${filters.beforeId}::uuid)`,
        );
      } else if (filters.before) {
        conditions.push(sql`${activityLog.createdAt} < ${filters.before}::timestamptz`);
      }
      // `crossing` lives inside the redacted `details` jsonb rather than a
      // column, because the recorder puts it there; matching it in SQL keeps the
      // filter from being a post-fetch pass over a truncated page.
      if (filters.crossing) {
        conditions.push(sql`${activityLog.details} ->> 'crossing' = ${filters.crossing}`);
      }
      return db
        // ★ `getTableColumns` keeps the forward-compatibility this reader was
        // built for: it is read from the schema object at runtime, so Unit A's
        // nullable `company_id` and new `organization_id` still appear here the
        // moment they land, with no change to this file. It is used instead of a
        // bare `select()` only so the full-precision `cursor` can ride alongside.
        .select({ ...getTableColumns(activityLog), cursor: DENIAL_CURSOR_SQL })
        .from(activityLog)
        .where(and(...conditions))
        // A TOTAL order. `created_at DESC` alone is not one — ties are ordered
        // arbitrarily and differently per plan, which would make the keyset
        // cursor above lose rows.
        .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
        .limit(clampDenialLimit(filters.limit));
    },

    create: (data: typeof activityLog.$inferInsert) => {
      assertUnreservedActivityNamespace(data);
      return db
        .insert(activityLog)
        .values(data)
        .returning()
        .then((rows) => rows[0]);
    },
  };
}
