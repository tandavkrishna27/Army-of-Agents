/**
 * Provider readiness service — reads and writes the `provider_readiness_status`
 * cache.
 *
 * Probing a provider spawns a real CLI (~1-3s each, 8+ providers), so the
 * Settings -> Providers tab renders from the cache and only re-probes what is
 * stale and in use.
 *
 * This module owns TWO invariants the database cannot enforce:
 *
 *   1. OUTCOME VALIDATION. Drizzle's `text(..., { enum })` is a TypeScript-only
 *      constraint — it emits no DB CHECK, so Postgres will persist any string.
 *      A typo'd outcome would poison the cache permanently and render as an
 *      unknown state forever. Validated against PROBE_OUTCOMES before insert.
 *
 *   2. REDACTION BEFORE INSERT. Probe checks carry CLI-produced text that can
 *      echo credential material. Redacting only on the way out over HTTP is not
 *      enough: the cache ROW itself must be clean, because it is also read by
 *      logs, exports and future surfaces. Enforced structurally by the branded
 *      `RedactedCheck` type below.
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { providerReadinessStatus } from "@armyofagents/db";
import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentCheckLevel,
} from "@armyofagents/shared";
import {
  PROBE_OUTCOMES,
  PROVIDER_READINESS_STALE_MS,
  getProviderById,
  getProviderByAdapterType,
  isReadinessStale,
  type ProbeOutcome,
  type ProviderId,
} from "@armyofagents/shared";
import { redactSecretsInString } from "../../redaction.js";
import { badRequest } from "../../errors.js";

/**
 * Re-exported from shared so the server and the Settings -> Providers tab
 * cannot disagree about what "stale" means. See `shared/adapter-probe.ts`.
 */
export const READINESS_STALE_MS = PROVIDER_READINESS_STALE_MS;

/**
 * True when a cached probe is old enough to re-run. Thin alias over the shared
 * predicate — the semantics (missing / unparseable / FUTURE timestamps are all
 * stale) live there and are documented there.
 */
export function isStale(
  testedAt: string | Date | null | undefined,
  thresholdMs = READINESS_STALE_MS,
): boolean {
  return isReadinessStale(testedAt, thresholdMs);
}

/**
 * "In use" = Commander's configured adapter, plus any adapter used by at least
 * one non-archived agent. Only these are auto-refreshed on page load; everything
 * else renders from cache until the user presses Test.
 *
 * Adapters with no catalog entry (process, http, hermes_local, ...) carry no
 * user credential and are skipped rather than rejected.
 */
export function selectInUseProviders(input: {
  commanderAdapterType: string | null;
  agentAdapterTypes: string[];
}): ProviderId[] {
  const types = [
    ...(input.commanderAdapterType ? [input.commanderAdapterType] : []),
    ...input.agentAdapterTypes,
  ];
  const ids = new Set<ProviderId>();
  for (const t of types) {
    const descriptor = getProviderByAdapterType(t);
    if (descriptor) ids.add(descriptor.id);
  }
  return [...ids];
}

/* ─── Redaction ────────────────────────────────────────────────────────── */

declare const redactedBrand: unique symbol;

/**
 * A probe check whose free-text fields have provably been through
 * `redactSecretsInString`.
 *
 * The brand exists because `AdapterEnvironmentCheck` and the column's element
 * type are otherwise STRUCTURALLY IDENTICAL — which is exactly how unredacted
 * CLI output slips into the cache: a future caller passes
 * `result.checks` straight to the insert and nothing complains. With the brand,
 * `redactChecks()` is the only way to produce a value the insert boundary
 * accepts, so skipping redaction is a compile error rather than a code-review
 * catch.
 */
export type RedactedCheck = {
  code: string;
  // The shared union, not `string`: `redactChecks` passes `level` through from
  // AdapterEnvironmentCheck untouched, so widening it here would leak a
  // `string` into the wire DTO and cost the UI its exhaustiveness check.
  level: AdapterEnvironmentCheckLevel;
  message: string;
  detail?: string;
  hint?: string;
} & { readonly [redactedBrand]: true };

/**
 * Redact credential material out of every free-text field of every check.
 *
 * `code` and `level` pass through UNREDACTED, on the assumption that they are
 * adapter-controlled and effectively static (`claude_local_hello_probe_passed`
 * and friends) rather than carrying interpolated runtime text. That assumption
 * is not universal: acpx-local interpolates into `code`
 * (`packages/adapters/acpx-local/src/server/test.ts:190,197,218`) and its
 * `[^a-z0-9]+ -> _` sanitizer would preserve an `sk-ant-…`-shaped value as
 * `sk_ant_…`. acpx is deliberately absent from PROVIDER_CATALOG, so it cannot
 * reach this table today. If a provider whose `code` is built from runtime
 * strings is ever added to the catalog, redact `code` here too.
 */
export function redactChecks(checks: readonly AdapterEnvironmentCheck[]): RedactedCheck[] {
  return checks.map(
    (c) =>
      ({
        code: c.code,
        level: c.level,
        message: typeof c.message === "string" ? redactSecretsInString(c.message) : c.message,
        ...(typeof c.detail === "string" ? { detail: redactSecretsInString(c.detail) } : {}),
        ...(typeof c.hint === "string" ? { hint: redactSecretsInString(c.hint) } : {}),
      }) as RedactedCheck,
  );
}

/* ─── Scope ────────────────────────────────────────────────────────────── */

/**
 * Rows are SCOPED, not one per (company, provider).
 *
 * An agent's own `adapterConfig` env binding WINS over the company default, so
 * "the company default authenticates" does not imply "this agent can run". A
 * single unscoped row would let the UI show green Ready while Commander still
 * 401s on its own revoked binding — the bug class this feature exists to remove.
 */
export type ReadinessScope =
  | { type: "company_default" }
  | { type: "agent"; agentId: string };

export interface RecordReadinessInput {
  companyId: string;
  providerId: ProviderId;
  scope: ReadinessScope;
  outcome: ProbeOutcome;
  /** Raw probe checks. Redacted by this function before they reach the DB. */
  checks: readonly AdapterEnvironmentCheck[];
  testedByUserId?: string | null;
}

const OUTCOME_SET: ReadonlySet<string> = new Set(PROBE_OUTCOMES);

/**
 * The single insert boundary, and the home of BOTH invariants this module owns:
 * redaction (enforced by the `RedactedCheck` type on `row.checks`) and outcome
 * validation (enforced at runtime just below).
 *
 * They live together deliberately. Redaction is enforced by the compiler, so a
 * future second writer — a batch backfill, a migration script — inherits it for
 * free; if outcome validation sat a layer up in `recordReadiness`, that same
 * writer would silently skip it and poison the cache with an outcome nothing
 * can render. Anything that reaches the database goes through here.
 */
async function insertReadinessRow(
  db: Db,
  row: {
    companyId: string;
    providerId: string;
    scopeType: "company_default" | "agent";
    scopeId: string | null;
    outcome: ProbeOutcome;
    checks: RedactedCheck[];
    testedAt: Date;
    testedByUserId: string | null;
  },
) {
  // Drizzle's `text(..., { enum })` is TypeScript-only — it emits no DB CHECK,
  // so Postgres would happily persist "ready" forever.
  if (!OUTCOME_SET.has(row.outcome)) {
    throw badRequest(
      `Unknown probe outcome "${row.outcome}". Expected one of: ${PROBE_OUTCOMES.join(", ")}`,
    );
  }

  const [inserted] = await db
    .insert(providerReadinessStatus)
    .values(row)
    .onConflictDoUpdate({
      // Must match `provider_readiness_scope_uq` exactly. That index is declared
      // `nullsNotDistinct()`; without it every company_default row (scope_id IS
      // NULL) is unique, this target never matches, and defaults duplicate.
      target: [
        providerReadinessStatus.companyId,
        providerReadinessStatus.providerId,
        providerReadinessStatus.scopeType,
        providerReadinessStatus.scopeId,
      ],
      set: {
        outcome: row.outcome,
        checks: row.checks,
        testedAt: row.testedAt,
        testedByUserId: row.testedByUserId,
      },
    })
    .returning();
  return inserted;
}

/** Record the result of a probe, upserting the row for this (company, provider, scope). */
export async function recordReadiness(db: Db, input: RecordReadinessInput) {
  // NOTE: outcome validation lives on the insert boundary in
  // `insertReadinessRow`, alongside the redaction guarantee — see its docblock.
  if (!getProviderById(input.providerId)) {
    throw badRequest(`Unknown provider "${input.providerId}"`);
  }
  // Mirrors `provider_readiness_scope_shape_check`. Failing here gives a usable
  // error instead of a raw constraint violation, and catches the empty-string
  // agent id that the DB CHECK (a NULL check) would let through.
  if (input.scope.type === "agent" && !input.scope.agentId) {
    throw badRequest("Agent-scoped readiness requires an agentId (scope shape)");
  }

  return insertReadinessRow(db, {
    companyId: input.companyId,
    providerId: input.providerId,
    scopeType: input.scope.type,
    scopeId: input.scope.type === "agent" ? input.scope.agentId : null,
    outcome: input.outcome,
    checks: redactChecks(input.checks),
    testedAt: new Date(),
    testedByUserId: input.testedByUserId ?? null,
  });
}

/**
 * Drop the cached row for ONE (provider, scope).
 *
 * Deletion, not a stale-mark, is the correct invalidation. Rewriting `testedAt`
 * leaves `outcome` intact, so the card keeps rendering the OLD verdict until
 * something re-probes — and a verdict derived from a credential that no longer
 * exists is the false-green this table exists to prevent. An absent row reads as
 * `unknown` ("not checked"), which is the honest answer after the credential
 * underneath it changed.
 *
 * Used when a probe could not be run but the cached answer is known to be
 * obsolete — chiefly a key save whose re-probe could not acquire the shared
 * probe slot (see routes/providers.ts).
 */
export async function deleteReadinessForScope(
  db: Db,
  companyId: string,
  providerId: ProviderId,
  scope: ReadinessScope,
) {
  return db
    .delete(providerReadinessStatus)
    .where(
      and(
        eq(providerReadinessStatus.companyId, companyId),
        eq(providerReadinessStatus.providerId, providerId),
        eq(providerReadinessStatus.scopeType, scope.type),
        scope.type === "agent"
          ? eq(providerReadinessStatus.scopeId, scope.agentId)
          : isNull(providerReadinessStatus.scopeId),
      ),
    );
}

/**
 * Drop ALL agent-scoped cached verdicts for one provider.
 *
 * Called when the company-level provider key changes: an agent that sets no env
 * binding of its own resolves through the company fallback, so its cached verdict
 * was answering a question about the OLD key. Clearing (→ unknown/not-checked) is
 * conservative — it never claims Ready for a key that no longer exists. Agents
 * with their own binding are cleared too and simply re-probe from their config
 * page; that is the safe direction (unknown, never false-green).
 */
export async function deleteAgentReadinessForProvider(
  db: Db,
  companyId: string,
  providerId: ProviderId,
) {
  return db
    .delete(providerReadinessStatus)
    .where(
      and(
        eq(providerReadinessStatus.companyId, companyId),
        eq(providerReadinessStatus.providerId, providerId),
        eq(providerReadinessStatus.scopeType, "agent"),
      ),
    );
}

/** All cached readiness rows for a company, across every scope. For the list view. */
export async function readReadiness(db: Db, companyId: string) {
  return db
    .select()
    .from(providerReadinessStatus)
    .where(eq(providerReadinessStatus.companyId, companyId));
}

/**
 * The cached row for ONE (provider, scope), or `undefined` when that exact
 * scope has never been probed.
 *
 * NO FALLBACK TO THE COMPANY DEFAULT. This is the whole point of scoping, and
 * it is a read-side rule, so it is enforced here rather than left to callers.
 * An agent's own `adapterConfig` env binding WINS over the company default —
 * so answering "has this agent been probed?" with the company_default row is
 * precisely the false-green this table exists to prevent: the UI renders
 * "Ready" from the company key while Commander 401s on its own revoked
 * binding. `undefined` means unprobed, and unprobed must render as unknown.
 */
export async function readReadinessForScope(
  db: Db,
  companyId: string,
  providerId: ProviderId,
  scope: ReadinessScope,
) {
  const [row] = await db
    .select()
    .from(providerReadinessStatus)
    .where(
      and(
        eq(providerReadinessStatus.companyId, companyId),
        eq(providerReadinessStatus.providerId, providerId),
        eq(providerReadinessStatus.scopeType, scope.type),
        scope.type === "agent"
          ? eq(providerReadinessStatus.scopeId, scope.agentId)
          : isNull(providerReadinessStatus.scopeId),
      ),
    )
    .limit(1);
  return row;
}
