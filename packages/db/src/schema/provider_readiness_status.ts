import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
// Deep import, NOT the `@armyofagents/shared` barrel: drizzle-kit loads the
// schema graph through a CJS require hook, and pulling the barrel drags in
// every shared module (which then fails to resolve its own relative `.js`
// specifiers). `probe-outcome.ts` has no imports of its own, so it loads
// cleanly. Same deep-import form as `@armyofagents/shared/marketplace`.
import { PROBE_OUTCOMES } from "@armyofagents/shared/probe-outcome";
import { companies } from "./companies.js";
import { authUsers } from "./auth.js";

/**
 * Cached result of the last provider readiness probe.
 *
 * Probing a provider spawns a real CLI (~1-3s each, 8+ providers), so the
 * Settings -> Providers tab renders from this cache rather than probing on
 * every page load.
 *
 * SCOPED, not one row per (company, provider). Authentication is
 * configuration-specific: an agent's explicit `adapterConfig.env` binding WINS
 * over the company default key, so "the company default authenticates" does NOT
 * imply "this agent can run". A single unscoped row would let the UI show
 * "Ready" while Commander still 401s on its own revoked binding — the exact bug
 * class this feature exists to eliminate.
 *
 *   scopeType "company_default" -> scopeId null  (company key / host login only)
 *   scopeType "agent"           -> scopeId = agents.id (that agent's real config)
 */
export const providerReadinessStatus = pgTable(
  "provider_readiness_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    /**
     * Catalog PROVIDER ID — e.g. `"anthropic"`, `"openai"`, `"google"`.
     *
     * NOT the adapter type (`"claude_local"`). Reads key on the catalog id, so
     * persisting an adapter type here mints a row that silently never matches.
     * See PROVIDER_IDS in packages/shared/src/providers/provider-catalog.ts.
     */
    providerId: text("provider_id").notNull(),
    scopeType: text("scope_type", { enum: ["company_default", "agent"] }).notNull(),
    /**
     * Null for `company_default`; the agent id for `agent` scope.
     *
     * Deliberately NOT an FK to `agents.id`: cache rows are disposable and a
     * dangling scope id is harmless (it simply never matches a read), whereas a
     * cascade would couple agent deletion to this table.
     */
    scopeId: uuid("scope_id"),
    /** Mirrors `ProbeOutcome` in `@armyofagents/shared` — derived, never retyped. */
    outcome: text("outcome", { enum: PROBE_OUTCOMES }).notNull(),
    /**
     * Structured probe checks.
     *
     * NOT safe by construction: probe messages can echo credential material
     * (env var values, auth headers, CLI error text quoting a key). The writer
     * is responsible for REDACTING these before insert. Do not assume anything
     * read out of this column is safe to render or log verbatim.
     */
    checks: jsonb("checks")
      .$type<
        { code: string; level: string; message: string; detail?: string; hint?: string }[]
      >()
      .notNull()
      .default([]),
    testedAt: timestamp("tested_at", { withTimezone: true }).notNull().defaultNow(),
    /** Who ran the probe. Nulled (not cascaded) when the user is deleted. */
    testedByUserId: text("tested_by_user_id").references(() => authUsers.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    /**
     * `nullsNotDistinct()` is REQUIRED. Postgres treats NULLs as distinct, so
     * without it every `company_default` row (scope_id IS NULL) is unique and
     * the upsert target never matches — producing duplicate default rows and
     * unstable cache reads. Same pattern as
     * `packages/db/src/schema/plugin_state.ts`. Requires PostgreSQL 15+.
     */
    scopeUq: unique("provider_readiness_scope_uq")
      .on(table.companyId, table.providerId, table.scopeType, table.scopeId)
      .nullsNotDistinct(),
    /**
     * Ties `scope_type` to `scope_id` nullability, which the unique constraint
     * alone does NOT do.
     *
     * Without this, `('agent', NULL)` is a legal row — and under
     * `NULLS NOT DISTINCT` it is *distinct* from `('company_default', NULL)`,
     * so a writer bug could park one global agent-scoped row per
     * (company, provider). Symmetrically `('company_default', <uuid>)` would
     * mint a second "default" that the default read never sees.
     *
     * Defence in depth: the writer is responsible for scope discipline, but a
     * scope mix-up is exactly the failure mode this table exists to prevent.
     */
    scopeShapeValid: check(
      "provider_readiness_scope_shape_check",
      sql`(scope_type = 'company_default' AND scope_id IS NULL) OR (scope_type = 'agent' AND scope_id IS NOT NULL)`,
    ),
  }),
);
