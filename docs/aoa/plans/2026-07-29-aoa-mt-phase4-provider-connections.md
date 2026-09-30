# AoA Multi-Tenant Phase 4 — provider_connections + provider_assignments + Unified Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `provider_connections` + `provider_assignments` as the source-of-truth for agent LLM credentials, resolved by ONE unified runtime resolver that normalizes every beta auth method (api_key / personal_subscription / enterprise_gateway) to an env-patch, wired into Crew + heartbeat + Commander, with STRANGLER dual-write/dual-read over the two existing credential systems. (bedrock/vertex stay on the ambient-env passthrough this phase — fold in post-beta.)

**Architecture:** New Drizzle tables carry `organization_id` (P1 soft-ref, RLS app-layer context) + nullable `company_id` (null ⇒ org-level). A single `resolveProviderCredential` reads the new model FIRST (precedence: `agent_override > personal_execution_default > company_default > org_default`, org/company defaults restricted to shareable auth methods), falls back to the LEGACY path (`secrets.ts` company-key ladder + `provider-credential-bindings.ts` subscription-home ladder) when no assignment exists. It REUSES `resolveEnvBindings` (owner-hop / secret_ref) and `resolveAgentSubscriptionEnvironment` (home-safety) unchanged — never rewrites them. Every legacy write path is dual-written so the legacy ladder stays correct; legacy removal is a LATER follow-up, NOT this PR.

**Tech Stack:** TypeScript, Drizzle ORM (PostgreSQL 15+), Express 5, Vitest 3. Contract-sync order: `packages/db` → `packages/shared` → `server`. Windows CI skips `*.integration.test.ts` + e2e — all Phase-4 tests are unit/sequence-mock tests that run on every platform.

---

## Context: what exists on this branch (cite before you touch)

- **System (a) — API-key env-injection ladder** (`server/src/services/secrets.ts`): `resolveAdapterConfigForRuntime` (`:1010`) → `resolveEnvBindings` (`:916`) + `applyCompanyKeyFallbackForRuntime` (`:991`). Precedence predicate `needsCompanyKeyFallback(env, target)` (`:196-203`). Company key = `company_secrets` row named `provider:<id>`, written by `saveProviderKey` (`server/src/services/providers/provider-key.ts:129`), owner-hopped by `resolveProviderKeyTarget` (`:79`). **Injects an env VAR value.**
- **System (b) — subscription auth-home ladder** (`server/src/services/provider-credential-bindings.ts`): `chooseGovernedSubscriptionBinding` (`:56-120`, 7 fail-closed gates), `resolveAgentSubscriptionEnvironment` (`:139-200`, returns `{HOME, CODEX_HOME}` or `{HOME, CLAUDE_CONFIG_DIR}`), `mayUseLegacySubscriptionHome` (`:32-41`). Tables `provider_credentials` + `agent_provider_credential_bindings` (`packages/db/src/schema/provider_credentials.ts`). Home derivation `resolveScopedCliAuthHome` (`server/src/services/cli-auth-topology.ts:172`). **Injects auth-home PATHS; secret material never in DB.**
- **Runtime call-sites:** Crew `server/src/services/internal-agent/aoa-agents/runner.ts:522` (system a only — subscription GAP); heartbeat `server/src/services/heartbeat.ts:3040` (system a) + `:3991-4035` (system b); Commander `server/src/services/internal-agent/cli-mode.ts` (per-session managed home).
- **Enterprise gateway / bedrock / vertex** are NOT first-class: plain env vars in `CLAUDE_OVERLAY_AUTH_KEY_SHAPES` (`packages/adapters/claude-local/src/server/ambient-config.ts:415-424`).
- **cloud_auth / multi_tenant:** `providerSubscriptionCapability` (`cli-auth-topology.ts:127-154`) already disables subscription sign-in when `trustBoundary==='multi_tenant'`.
- **Cross-phase:** no `organizations` table (P1) and no `execution_targets` table (P5) exist yet — `organization_id` is a soft column (FK added at P1 merge), `execution_target_id` is a soft `text` ref (`AOA_EXECUTION_TARGET_ID || "control-plane"`, `heartbeat.ts:4024`).
- **#310 MERGE NOTE:** `server/src/services/internal-agent/commander-runtime-auth.ts` (`assertCommanderSubscriptionAgent`, `subscription_commander_only`) does NOT exist here. At #310 merge, that Commander-only gate MUST become the resolver's `owner_only` sharingPolicy check (Task 13) — do not let #310 reintroduce a parallel Commander resolution path.

Patterns reused: schema template `packages/db/src/schema/goals.ts`; `nullsNotDistinct` + shape-CHECK `packages/db/src/schema/provider_readiness_status.ts:91-110`; identity partial-unique `provider_credentials.ts:37-43`; sequence-mock DB tests `server/src/__tests__/runtime-provider-keys.test.ts` + `provider-credential-bindings.test.ts`; route wiring `server/src/app.ts:274`.

Test command form used throughout: `pnpm --filter @armyofagents/server exec vitest run <path> -t "<name>"`. Schema build before generate/typecheck: `pnpm --filter @armyofagents/db build`.

---

## File Structure

- Create `packages/db/src/schema/provider_connections.ts` — both tables (`providerConnections`, `providerAssignments`).
- Modify `packages/db/src/schema/index.ts` — export the two tables.
- Create `packages/shared/src/provider-connections.ts` — `AuthMethod`, `SharingPolicy`, `ScopeType`, zod validators.
- Modify `packages/shared/src/index.ts` — export the new module.
- Create `server/src/services/provider-resolution.ts` — `materializeEnvPatch`, `orderCandidates`, `resolveProviderCredential`, `applyResolvedCredential`.
- Create `server/src/services/provider-connections.ts` — CRUD/state-machine + dual-write.
- Create `server/src/routes/provider-connections.ts` — founder REST; mount in `server/src/app.ts`.
- Create `server/src/services/provider-connections-backfill.ts` — idempotent boot reconciler (dual-write of existing rows).
- Modify `server/src/services/internal-agent/aoa-agents/runner.ts` — wire Crew.
- Modify `server/src/services/heartbeat.ts` — wire org agents.
- Modify `server/src/services/internal-agent/cli-mode.ts` — wire Commander.
- Tests under `server/src/__tests__/`.

---

## Task 1: Drizzle schema — `provider_connections` + `provider_assignments`

**Files:**
- Create: `packages/db/src/schema/provider_connections.ts`
- Modify: `packages/db/src/schema/index.ts` (after the `provider_credentials.js` export block, ~`:128-132`)
- Test: `server/src/__tests__/provider-connections-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/provider-connections-schema.test.ts
import { describe, it, expect } from "vitest";
import { providerConnections, providerAssignments } from "@armyofagents/db";

describe("provider_connections schema", () => {
  it("exposes the expected columns on providerConnections", () => {
    const cols = Object.keys(providerConnections);
    for (const c of [
      "id", "organizationId", "companyId", "provider", "authMethod",
      "ownerUserId", "executionTargetId", "secretRef", "state", "sharingPolicy",
      "maxConcurrency", "config", "termsAttestedAt", "verifiedAt", "revokedAt",
      "suspendedAt", "createdByUserId", "createdAt", "updatedAt",
    ]) {
      expect(cols).toContain(c);
    }
  });

  it("exposes the expected columns on providerAssignments", () => {
    const cols = Object.keys(providerAssignments);
    for (const c of [
      "id", "organizationId", "companyId", "connectionId", "provider",
      "scopeType", "scopeId", "priority", "state", "createdAt", "updatedAt",
    ]) {
      expect(cols).toContain(c);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-connections-schema.test.ts`
Expected: FAIL — `providerConnections`/`providerAssignments` are not exported from `@armyofagents/db`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/db/src/schema/provider_connections.ts
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { organizations } from "./organizations.js";
import { authUsers } from "./auth.js";

/**
 * The credential of record: WHO owns WHAT auth, WHERE it executes.
 *
 * `organization_id` FKs `organizations` (P1 is merged first). `company_id` NULL ⇒
 * an org-level connection shared to every company in the organization. Provider-
 * native subscription material is NEVER stored here (secret_ref stays NULL for
 * personal_subscription); it lives in the scoped on-disk auth home the
 * subscription ladder derives (cli-auth-topology.ts:172).
 *
 * SCOPE (beta): only api_key / personal_subscription / enterprise_gateway are
 * modeled. bedrock/vertex stay on the ambient-env passthrough (fold in post-beta).
 */
export const providerConnections = pgTable(
  "provider_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // P1 is merged first, so the FK is real now (RESTRICT: an org with live
    // connections cannot be hard-deleted out from under them).
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    // Catalog PROVIDER id ("anthropic"/"openai"/"google"), NOT the adapter type.
    provider: text("provider").notNull(),
    authMethod: text("auth_method", {
      enum: ["api_key", "personal_subscription", "enterprise_gateway"],
    }).notNull(),
    ownerUserId: text("owner_user_id").references(() => authUsers.id, { onDelete: "restrict" }),
    // P5 soft-ref (matches provider_credentials.execution_target_id).
    executionTargetId: text("execution_target_id"),
    // Points into the existing encrypted vault. RESTRICT: cannot delete a secret
    // an active connection uses (mirrors runtime_provider_keys.ts:13). NULL for
    // personal_subscription (its material is the on-disk home).
    secretRef: uuid("secret_ref").references(() => companySecrets.id, { onDelete: "restrict" }),
    state: text("state", { enum: ["pending", "verified", "revoked", "suspended"] })
      .notNull()
      .default("pending"),
    sharingPolicy: text("sharing_policy", {
      enum: ["owner_only", "company_agents", "org_agents"],
    })
      .notNull()
      .default("owner_only"),
    maxConcurrency: integer("max_concurrency").notNull().default(1),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    termsAttestedAt: timestamp("terms_attested_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    suspendedAt: timestamp("suspended_at", { withTimezone: true }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgProviderIdx: index("provider_connections_org_provider_idx").on(
      table.organizationId,
      table.provider,
    ),
    companyProviderIdx: index("provider_connections_company_provider_idx").on(
      table.companyId,
      table.provider,
      table.state,
    ),
    ownerIdx: index("provider_connections_owner_idx").on(table.ownerUserId),
    // Identity — mirrors provider_credentials_identity_uq. nullsNotDistinct so a
    // second company-scoped api_key (owner NULL / target NULL) cannot duplicate.
    identityUq: unique("provider_connections_identity_uq")
      .on(
        table.companyId,
        table.provider,
        table.authMethod,
        table.ownerUserId,
        table.executionTargetId,
      )
      .nullsNotDistinct(),
    // personal_subscription MUST have owner+target and MUST NOT hold a secret.
    // Shape-CHECK pattern from provider_readiness_status.ts:107.
    subscriptionShape: check(
      "provider_connections_subscription_shape_check",
      sql`(auth_method <> 'personal_subscription') OR (owner_user_id IS NOT NULL AND execution_target_id IS NOT NULL AND secret_ref IS NULL)`,
    ),
    // api_key MUST carry a vault secret. enterprise_gateway's token is optional
    // (some gateways are network-authed), so it is not required here.
    apiKeyShape: check(
      "provider_connections_api_key_shape_check",
      sql`(auth_method <> 'api_key') OR (secret_ref IS NOT NULL)`,
    ),
  }),
);

/**
 * The routing table: WHICH connection wins for WHOM. `provider` is denormalized
 * from the connection so one precedence query answers "resolve provider X for
 * agent Y". org_default rows carry company_id NULL.
 */
export const providerAssignments = pgTable(
  "provider_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id"),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    scopeType: text("scope_type", {
      enum: ["org_default", "company_default", "agent_override", "personal_execution_default"],
    }).notNull(),
    // NULL for org_default/company_default; agents.id for agent_override;
    // owner_user_id for personal_execution_default. NOT an FK — disposable route
    // rows, dangling ids simply never match (same rationale as
    // provider_readiness_status.scope_id, :52-60).
    scopeId: text("scope_id"),
    priority: integer("priority").notNull().default(0),
    state: text("state", { enum: ["active", "disabled"] }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    lookupIdx: index("provider_assignments_lookup_idx").on(
      table.companyId,
      table.provider,
      table.state,
    ),
    connectionIdx: index("provider_assignments_connection_idx").on(table.connectionId),
    // nullsNotDistinct REQUIRED so a second company_default (scope_id NULL) cannot
    // be minted (same reason as provider_readiness_scope_uq, PG15+).
    scopeUq: unique("provider_assignments_scope_uq")
      .on(table.companyId, table.provider, table.scopeType, table.scopeId)
      .nullsNotDistinct(),
    scopeShape: check(
      "provider_assignments_scope_shape_check",
      sql`(scope_type IN ('org_default','company_default') AND scope_id IS NULL) OR (scope_type IN ('agent_override','personal_execution_default') AND scope_id IS NOT NULL)`,
    ),
  }),
);
```

Then add to `packages/db/src/schema/index.ts` immediately after the `provider_credentials.js` export block (`~:132`):

```ts
export { providerConnections, providerAssignments } from "./provider_connections.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/db build && pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-connections-schema.test.ts`
Expected: PASS (both column-shape tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/provider_connections.ts packages/db/src/schema/index.ts server/src/__tests__/provider-connections-schema.test.ts
git commit -m "feat(db): add provider_connections + provider_assignments schema"
```

---

## Task 2: Generate the DDL migration

**Files:**
- Create: `packages/db/src/migrations/0190_provider_connections.sql` (CONFIRMED number — branch latest is `0186`; P1 consumes `0188`, P2 + P3 (P3 collapsed to a single migration) consume `0189`, P4 = `0190`. If `pnpm db:generate` assigns a different prefix because phase ordering shifted, take the number drizzle-kit assigns and update this reference — never hand-edit the prefix.)

- [ ] **Step 1: Build schema + generate**

Run: `pnpm --filter @armyofagents/db build && pnpm db:generate`
Expected: a new `packages/db/src/migrations/0190_*.sql` containing `CREATE TABLE "provider_connections"` and `CREATE TABLE "provider_assignments"` plus the two `unique(...) NULLS NOT DISTINCT` constraints and the CHECK constraints.

- [ ] **Step 2: Verify the migration contents**

Run: `git status --porcelain packages/db/src/migrations && grep -c "NULLS NOT DISTINCT" packages/db/src/migrations/0190_*.sql`
Expected: one new `.sql` file (prefix `0190`); grep count `>= 2` (both partial-uniques). If the CHECK constraints are absent, STOP — the schema `check(...)` did not serialize; re-run after `pnpm --filter @armyofagents/db build`.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/migrations/
git commit -m "feat(db): generate provider_connections migration"
```

---

## Task 3: Shared types + validators

**Files:**
- Create: `packages/shared/src/provider-connections.ts`
- Modify: `packages/shared/src/index.ts` (add one export line)
- Test: `server/src/__tests__/provider-connections-shared.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/provider-connections-shared.test.ts
import { describe, it, expect } from "vitest";
import {
  AUTH_METHODS,
  SHAREABLE_AUTH_METHODS,
  providerConnectionCreateSchema,
} from "@armyofagents/shared";

describe("provider-connections shared", () => {
  it("lists the three beta auth methods and the two shareable ones", () => {
    expect(AUTH_METHODS).toEqual(["api_key", "personal_subscription", "enterprise_gateway"]);
    expect(SHAREABLE_AUTH_METHODS).not.toContain("personal_subscription");
    expect(SHAREABLE_AUTH_METHODS).toContain("enterprise_gateway");
  });

  it("rejects a personal_subscription create with a secretRef", () => {
    const parsed = providerConnectionCreateSchema.safeParse({
      provider: "anthropic",
      authMethod: "personal_subscription",
      ownerUserId: "u1",
      executionTargetId: "t1",
      secretRef: "s1",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts an enterprise_gateway create with baseUrl", () => {
    const parsed = providerConnectionCreateSchema.safeParse({
      provider: "anthropic",
      authMethod: "enterprise_gateway",
      config: { baseUrl: "https://gw.corp.example/v1" },
      secretRef: "s1",
    });
    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-connections-shared.test.ts`
Expected: FAIL — exports not found in `@armyofagents/shared`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/shared/src/provider-connections.ts
import { z } from "zod";

// SCOPE (beta): bedrock + vertex are NOT modeled first-class here. They remain on
// the existing ambient-env passthrough (adapterConfig.env survives the ambient
// strip via CLAUDE_OVERLAY_AUTH_KEY_SHAPES, ambient-config.ts:415-424) and fold
// into the connection model post-beta.
export const AUTH_METHODS = [
  "api_key",
  "personal_subscription",
  "enterprise_gateway",
] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** org/company defaults may only route these; personal_subscription is owner-only. */
export const SHAREABLE_AUTH_METHODS = [
  "api_key",
  "enterprise_gateway",
] as const satisfies readonly AuthMethod[];

export const SHARING_POLICIES = ["owner_only", "company_agents", "org_agents"] as const;
export type SharingPolicy = (typeof SHARING_POLICIES)[number];

/**
 * Env vars an enterprise_gateway token may bind (config.tokenEnvVar). MUST stay a
 * subset of the claude adapter's overlay-auth allowlist
 * (CLAUDE_OVERLAY_AUTH_KEY_SHAPES, ambient-config.ts:415-424) or the ambient strip
 * deletes the key at spawn. SINGLE source of truth — the resolver's
 * materializeEnvPatch imports this; do not re-declare it server-side.
 */
export const GATEWAY_TOKEN_ENV_ALLOWLIST = new Set([
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);
export const DEFAULT_GATEWAY_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";

export const CONNECTION_STATES = ["pending", "verified", "revoked", "suspended"] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export const ASSIGNMENT_SCOPE_TYPES = [
  "org_default",
  "company_default",
  "agent_override",
  "personal_execution_default",
] as const;
export type AssignmentScopeType = (typeof ASSIGNMENT_SCOPE_TYPES)[number];

export function isShareableAuthMethod(method: AuthMethod): boolean {
  return (SHAREABLE_AUTH_METHODS as readonly AuthMethod[]).includes(method);
}

export const providerConnectionCreateSchema = z
  .object({
    provider: z.string().min(1),
    authMethod: z.enum(AUTH_METHODS),
    ownerUserId: z.string().min(1).optional(),
    executionTargetId: z.string().min(1).optional(),
    secretRef: z.string().min(1).optional(),
    sharingPolicy: z.enum(SHARING_POLICIES).optional(),
    maxConcurrency: z.number().int().nonnegative().optional(),
    config: z.record(z.unknown()).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.authMethod === "personal_subscription") {
      if (!v.ownerUserId || !v.executionTargetId) {
        ctx.addIssue({ code: "custom", message: "personal_subscription requires ownerUserId + executionTargetId" });
      }
      if (v.secretRef) {
        ctx.addIssue({ code: "custom", message: "personal_subscription must not carry a secretRef" });
      }
    }
    if (v.authMethod === "api_key" && !v.secretRef) {
      ctx.addIssue({ code: "custom", message: "api_key requires a secretRef" });
    }
    if (v.authMethod === "enterprise_gateway") {
      const cfg = v.config as Record<string, unknown> | undefined;
      const baseUrl = cfg?.baseUrl;
      if (typeof baseUrl !== "string" || baseUrl.length === 0) {
        ctx.addIssue({ code: "custom", message: "enterprise_gateway requires config.baseUrl" });
      }
      const tokenEnvVar = cfg?.tokenEnvVar;
      if (tokenEnvVar !== undefined && (typeof tokenEnvVar !== "string" || !GATEWAY_TOKEN_ENV_ALLOWLIST.has(tokenEnvVar))) {
        ctx.addIssue({
          code: "custom",
          message: `config.tokenEnvVar must be one of: ${[...GATEWAY_TOKEN_ENV_ALLOWLIST].join(", ")}`,
        });
      }
    }
  });

export const providerAssignmentUpsertSchema = z
  .object({
    connectionId: z.string().min(1),
    scopeType: z.enum(ASSIGNMENT_SCOPE_TYPES),
    scopeId: z.string().min(1).nullable().optional(),
    priority: z.number().int().optional(),
  })
  .superRefine((v, ctx) => {
    const needsId = v.scopeType === "agent_override" || v.scopeType === "personal_execution_default";
    if (needsId && !v.scopeId) ctx.addIssue({ code: "custom", message: `${v.scopeType} requires scopeId` });
    if (!needsId && v.scopeId) ctx.addIssue({ code: "custom", message: `${v.scopeType} must not carry scopeId` });
  });
```

Add to `packages/shared/src/index.ts`:

```ts
export * from "./provider-connections.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/shared build && pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-connections-shared.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/provider-connections.ts packages/shared/src/index.ts server/src/__tests__/provider-connections-shared.test.ts
git commit -m "feat(shared): provider-connections auth-method taxonomy + validators"
```

---

## Task 4: `materializeEnvPatch` — normalize every auth method to an env patch (pure)

**Files:**
- Create: `server/src/services/provider-resolution.ts`
- Test: `server/src/__tests__/provider-resolution-materialize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/provider-resolution-materialize.test.ts
import { describe, it, expect } from "vitest";
import { materializeEnvPatch } from "../services/provider-resolution.js";

describe("materializeEnvPatch", () => {
  it("api_key → provider env var carries the resolved secret value", () => {
    const patch = materializeEnvPatch({
      authMethod: "api_key",
      provider: "anthropic",
      envVar: "ANTHROPIC_API_KEY",
      secretValue: "sk-real",
      config: {},
      subscriptionEnv: null,
    });
    expect(patch).toEqual({ ANTHROPIC_API_KEY: "sk-real" });
  });

  it("enterprise_gateway → base URL + token in the DEFAULT token env var", () => {
    const patch = materializeEnvPatch({
      authMethod: "enterprise_gateway",
      provider: "anthropic",
      envVar: "ANTHROPIC_API_KEY",
      secretValue: "gw-token",
      config: { baseUrl: "https://gw/v1" },
      subscriptionEnv: null,
    });
    expect(patch).toEqual({ ANTHROPIC_BASE_URL: "https://gw/v1", ANTHROPIC_AUTH_TOKEN: "gw-token" });
  });

  it("enterprise_gateway honors a per-connection config.tokenEnvVar in the allowlist", () => {
    const patch = materializeEnvPatch({
      authMethod: "enterprise_gateway", provider: "anthropic", envVar: "ANTHROPIC_API_KEY",
      secretValue: "gw-token", config: { baseUrl: "https://gw/v1", tokenEnvVar: "ANTHROPIC_API_KEY" },
      subscriptionEnv: null,
    });
    expect(patch).toEqual({ ANTHROPIC_BASE_URL: "https://gw/v1", ANTHROPIC_API_KEY: "gw-token" });
  });

  it("enterprise_gateway clamps an out-of-allowlist tokenEnvVar back to the default", () => {
    const patch = materializeEnvPatch({
      authMethod: "enterprise_gateway", provider: "anthropic", envVar: "ANTHROPIC_API_KEY",
      secretValue: "gw-token", config: { baseUrl: "https://gw/v1", tokenEnvVar: "EVIL_EXFIL_URL" },
      subscriptionEnv: null,
    });
    expect(patch).toEqual({ ANTHROPIC_BASE_URL: "https://gw/v1", ANTHROPIC_AUTH_TOKEN: "gw-token" });
  });

  it("personal_subscription → passes through the resolved home env, never a token", () => {
    const patch = materializeEnvPatch({
      authMethod: "personal_subscription",
      provider: "anthropic",
      envVar: "ANTHROPIC_API_KEY",
      secretValue: null,
      config: {},
      subscriptionEnv: { HOME: "/root/.aoa/x", CLAUDE_CONFIG_DIR: "/root/.aoa/x/anthropic" },
    });
    expect(patch).toEqual({ HOME: "/root/.aoa/x", CLAUDE_CONFIG_DIR: "/root/.aoa/x/anthropic" });
    expect(patch.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("empty api_key secret injects NOTHING (preserves secrets.ts:970-973 invariant)", () => {
    const patch = materializeEnvPatch({
      authMethod: "api_key",
      provider: "anthropic",
      envVar: "ANTHROPIC_API_KEY",
      secretValue: "",
      config: {},
      subscriptionEnv: null,
    });
    expect(patch).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-materialize.test.ts`
Expected: FAIL — module `provider-resolution.js` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/provider-resolution.ts
import type { AuthMethod, SharingPolicy } from "@armyofagents/shared";

export interface MaterializeInput {
  authMethod: AuthMethod;
  provider: string;
  /** The provider's canonical api-key env var (envVarForProvider). */
  envVar: string;
  /** Resolved secret VALUE for shareable methods; null when none. */
  secretValue: string | null;
  config: Record<string, unknown>;
  /** For personal_subscription only: the home env from resolveAgentSubscriptionEnvironment. */
  subscriptionEnv: Record<string, string> | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

// GATEWAY_TOKEN_ENV_ALLOWLIST + DEFAULT_GATEWAY_TOKEN_ENV are the SINGLE source of
// truth in @armyofagents/shared (Task 3) — imported, never re-declared, so the
// create-time validation and this materialization clamp cannot drift.
import {
  DEFAULT_GATEWAY_TOKEN_ENV,
  GATEWAY_TOKEN_ENV_ALLOWLIST,
} from "@armyofagents/shared";

/**
 * Normalize any auth method to an env patch. This is the ONE seam that hides the
 * "api-key value vs subscription auth-home" divergence behind a single shape — a
 * patch merged onto config.env by applyResolvedCredential. Empty secret ⇒ inject
 * nothing (secrets.ts:970-973). The token env var for anthropic gateway is
 * ANTHROPIC_AUTH_TOKEN (a bearer for a proxy), NOT ANTHROPIC_API_KEY.
 */
export function materializeEnvPatch(input: MaterializeInput): Record<string, string> {
  switch (input.authMethod) {
    case "api_key": {
      const v = str(input.secretValue);
      return v ? { [input.envVar]: v } : {};
    }
    case "enterprise_gateway": {
      const base = str(input.config.baseUrl);
      const patch: Record<string, string> = {};
      if (base) patch.ANTHROPIC_BASE_URL = base;
      const token = str(input.secretValue);
      if (token) {
        const requested = str(input.config.tokenEnvVar) ?? DEFAULT_GATEWAY_TOKEN_ENV;
        const tokenEnv = GATEWAY_TOKEN_ENV_ALLOWLIST.has(requested)
          ? requested
          : DEFAULT_GATEWAY_TOKEN_ENV;
        patch[tokenEnv] = token;
      }
      return patch;
    }
    case "personal_subscription": {
      return { ...(input.subscriptionEnv ?? {}) };
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-materialize.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/provider-resolution.ts server/src/__tests__/provider-resolution-materialize.test.ts
git commit -m "feat(resolver): materializeEnvPatch normalizes auth methods to env patches"
```

---

## Task 5: Precedence ordering (pure)

**Files:**
- Modify: `server/src/services/provider-resolution.ts`
- Test: `server/src/__tests__/provider-resolution-precedence.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/provider-resolution-precedence.test.ts
import { describe, it, expect } from "vitest";
import { orderCandidates, type Candidate } from "../services/provider-resolution.js";

const c = (over: Partial<Candidate>): Candidate => ({
  connectionId: "x", authMethod: "api_key", scopeType: "company_default",
  priority: 0, connectionUpdatedAt: 0, ...over,
});

describe("orderCandidates", () => {
  it("agent_override > personal_execution_default > company_default > org_default", () => {
    const ordered = orderCandidates([
      c({ connectionId: "org", scopeType: "org_default" }),
      c({ connectionId: "co", scopeType: "company_default" }),
      c({ connectionId: "ped", scopeType: "personal_execution_default" }),
      c({ connectionId: "ag", scopeType: "agent_override" }),
    ]);
    expect(ordered.map((x) => x.connectionId)).toEqual(["ag", "ped", "co", "org"]);
  });

  it("breaks ties by priority DESC then updatedAt DESC", () => {
    const ordered = orderCandidates([
      c({ connectionId: "lo", scopeType: "company_default", priority: 1, connectionUpdatedAt: 100 }),
      c({ connectionId: "hi", scopeType: "company_default", priority: 5, connectionUpdatedAt: 1 }),
      c({ connectionId: "new", scopeType: "company_default", priority: 5, connectionUpdatedAt: 999 }),
    ]);
    expect(ordered.map((x) => x.connectionId)).toEqual(["new", "hi", "lo"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-precedence.test.ts`
Expected: FAIL — `orderCandidates`/`Candidate` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `provider-resolution.ts`)

```ts
import type { AssignmentScopeType } from "@armyofagents/shared";

export interface Candidate {
  connectionId: string;
  authMethod: AuthMethod;
  scopeType: AssignmentScopeType;
  priority: number;
  connectionUpdatedAt: number;
}

const SCOPE_RANK: Record<AssignmentScopeType, number> = {
  agent_override: 3,
  personal_execution_default: 2,
  company_default: 1,
  org_default: 0,
};

/** Deterministic precedence order: scope rank, then priority DESC, then recency DESC. */
export function orderCandidates<T extends Candidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((a, b) => {
    if (SCOPE_RANK[a.scopeType] !== SCOPE_RANK[b.scopeType]) {
      return SCOPE_RANK[b.scopeType] - SCOPE_RANK[a.scopeType];
    }
    if (a.priority !== b.priority) return b.priority - a.priority;
    return b.connectionUpdatedAt - a.connectionUpdatedAt;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-precedence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/provider-resolution.ts server/src/__tests__/provider-resolution-precedence.test.ts
git commit -m "feat(resolver): deterministic candidate precedence ordering"
```

---

## Task 6: Fail-closed gate for a single candidate (pure)

**Files:**
- Modify: `server/src/services/provider-resolution.ts`
- Test: `server/src/__tests__/provider-resolution-gate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/provider-resolution-gate.test.ts
import { describe, it, expect } from "vitest";
import { candidatePassesStaticGates, type GateInput } from "../services/provider-resolution.js";

const base: GateInput = {
  authMethod: "api_key",
  scopeType: "company_default",
  state: "verified",
  termsAttestedAt: new Date(),
  sharingPolicy: "company_agents",
  actorKind: "crew",
  connectionCompanyId: "co1",
  requestCompanyId: "co1",
  connectionOwnerUserId: null,
  requestOwnerUserId: null,
};

describe("candidatePassesStaticGates", () => {
  it("passes a verified, attested, company-shared api_key for crew", () => {
    expect(candidatePassesStaticGates(base).ok).toBe(true);
  });
  it("rejects non-verified state", () => {
    expect(candidatePassesStaticGates({ ...base, state: "suspended" }).ok).toBe(false);
  });
  it("rejects un-attested terms", () => {
    expect(candidatePassesStaticGates({ ...base, termsAttestedAt: null }).ok).toBe(false);
  });
  it("rejects personal_subscription as an org_default (owner-only, locked)", () => {
    expect(
      candidatePassesStaticGates({
        ...base,
        authMethod: "personal_subscription",
        scopeType: "org_default",
      }).ok,
    ).toBe(false);
  });
  it("owner_only rejects an actor who is not the owner", () => {
    expect(
      candidatePassesStaticGates({
        ...base,
        sharingPolicy: "owner_only",
        connectionOwnerUserId: "owner1",
        requestOwnerUserId: "someoneElse",
      }).ok,
    ).toBe(false);
  });
  it("owner_only passes when the acting user IS the owner", () => {
    expect(
      candidatePassesStaticGates({
        ...base,
        sharingPolicy: "owner_only",
        connectionOwnerUserId: "owner1",
        requestOwnerUserId: "owner1",
      }).ok,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-gate.test.ts`
Expected: FAIL — `candidatePassesStaticGates`/`GateInput` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `provider-resolution.ts`)

```ts
import { isShareableAuthMethod, type SharingPolicy } from "@armyofagents/shared";

export type ProviderResolutionActor = "crew" | "org" | "commander";

export interface GateInput {
  authMethod: AuthMethod;
  scopeType: AssignmentScopeType;
  state: string;
  termsAttestedAt: Date | null;
  sharingPolicy: SharingPolicy;
  actorKind: ProviderResolutionActor;
  connectionCompanyId: string | null;
  requestCompanyId: string;
  connectionOwnerUserId: string | null;
  /** The acting/owner user for this run (Commander user, or the target owner). */
  requestOwnerUserId: string | null;
}

export interface GateResult {
  ok: boolean;
  reason?: string;
}

/**
 * Static (non-subscription) fail-closed gates. The personal_subscription
 * candidate ALSO runs chooseGovernedSubscriptionBinding downstream (owner-active,
 * target match, exactly-one) — this gate only enforces the rules that need no DB
 * join. A failing candidate is SKIPPED, not fatal (the caller tries the next).
 */
export function candidatePassesStaticGates(input: GateInput): GateResult {
  if (input.state !== "verified") return { ok: false, reason: "state_not_verified" };
  if (!input.termsAttestedAt) return { ok: false, reason: "terms_not_attested" };
  // org/company defaults may only route shareable methods (locked decision).
  if (
    (input.scopeType === "org_default" || input.scopeType === "company_default") &&
    !isShareableAuthMethod(input.authMethod)
  ) {
    return { ok: false, reason: "non_shareable_default" };
  }
  // Sharing policy.
  switch (input.sharingPolicy) {
    case "owner_only":
      if (!input.requestOwnerUserId || input.requestOwnerUserId !== input.connectionOwnerUserId) {
        return { ok: false, reason: "owner_only_mismatch" };
      }
      break;
    case "company_agents":
      if (input.connectionCompanyId && input.connectionCompanyId !== input.requestCompanyId) {
        return { ok: false, reason: "company_scope_mismatch" };
      }
      break;
    case "org_agents":
      // org-scope enforced by the assignment query (organization_id filter); allow here.
      break;
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/provider-resolution.ts server/src/__tests__/provider-resolution-gate.test.ts
git commit -m "feat(resolver): fail-closed static gates for a candidate"
```

---

## Task 7: `resolveProviderCredential` — dual-read with legacy fallback (DB)

**Files:**
- Modify: `server/src/services/provider-resolution.ts`
- Test: `server/src/__tests__/provider-resolution-resolve.test.ts`

- [ ] **Step 1: Write the failing test** (sequence-mock DB, per `runtime-provider-keys.test.ts` pattern)

```ts
// server/src/__tests__/provider-resolution-resolve.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => ({
  providerConnections: {}, providerAssignments: {}, companyMemberships: {},
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }), eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  or: (...a: unknown[]) => ({ or: a }), isNull: (a: unknown) => ({ isNull: a }),
  inArray: (a: unknown, b: unknown) => ({ inArray: [a, b] }),
}));

import { resolveProviderCredential } from "../services/provider-resolution.js";

// Minimal deps double: no assignment rows → must fall back to the legacy path.
function makeDeps(overrides: Partial<Parameters<typeof resolveProviderCredential>[2]> = {}) {
  return {
    loadCandidateRows: vi.fn(async () => []),
    resolveSecretValueForConnection: vi.fn(async () => null),
    resolveSubscriptionEnv: vi.fn(async () => ({})),
    envVarForProvider: () => "ANTHROPIC_API_KEY",
    // legacy hooks: return a REAL env delta so a legacy company key produces a
    // non-empty patch (empty → host_login_fallback, which contradicts the "legacy"
    // assertion below — M9). Tests that want host_login_fallback override this.
    legacyResolveConfig: vi.fn(async () => ({ env: { ANTHROPIC_API_KEY: "sk-legacy" } })),
    legacySubscriptionEnv: vi.fn(async () => null),
    selfHostedSingleTenant: true,
    ...overrides,
  };
}

const args = {
  organizationId: null, companyId: "co1", agentId: "ag1", actorKind: "crew" as const,
  adapterType: "claude_local", provider: "anthropic", executionTargetId: "control-plane",
  currentEnv: {} as Record<string, string>,
  context: { consumerType: "agent" as const, consumerId: "ag1", actorType: "agent" as const, actorId: "ag1" },
};

describe("resolveProviderCredential", () => {
  it("agent already carries the api key → agent_env_override, no injection", async () => {
    const deps = makeDeps();
    const r = await resolveProviderCredential(
      {} as never,
      { ...args, currentEnv: { ANTHROPIC_API_KEY: "sk-mine" } },
      deps as never,
    );
    expect(r.source).toBe("agent_env_override");
    expect(deps.loadCandidateRows).not.toHaveBeenCalled();
  });

  it("no new-model assignment → falls back to legacy path", async () => {
    const deps = makeDeps();
    const r = await resolveProviderCredential({} as never, args, deps as never);
    expect(r.source).toBe("legacy");
    expect(deps.legacyResolveConfig).toHaveBeenCalled();
  });

  it("verified company_default api_key → connection env patch", async () => {
    const deps = makeDeps({
      loadCandidateRows: vi.fn(async () => [{
        connectionId: "conn1", authMethod: "api_key", scopeType: "company_default",
        priority: 0, connectionUpdatedAt: 1, state: "verified", termsAttestedAt: new Date(),
        sharingPolicy: "company_agents", connectionCompanyId: "co1", connectionOwnerUserId: null,
        executionTargetId: null, config: {}, secretRef: "sec1",
      }]),
      resolveSecretValueForConnection: vi.fn(async () => "sk-company"),
    });
    const r = await resolveProviderCredential({} as never, args, deps as never);
    expect(r.source).toBe("connection");
    if (r.source === "connection") expect(r.envPatch).toEqual({ ANTHROPIC_API_KEY: "sk-company" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-resolve.test.ts`
Expected: FAIL — `resolveProviderCredential` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `provider-resolution.ts`)

```ts
import type { Db } from "@armyofagents/db";
import type { SecretConsumerContext } from "./secrets.js";

export interface ResolveArgs {
  organizationId: string | null;
  companyId: string;
  agentId: string | null;
  actorKind: ProviderResolutionActor;
  adapterType: string;
  provider: string;
  executionTargetId: string;
  currentEnv: Record<string, string>;
  context: Omit<SecretConsumerContext, "configPath">;
}

export interface CandidateRow extends Candidate {
  state: string;
  termsAttestedAt: Date | null;
  sharingPolicy: SharingPolicy;
  connectionCompanyId: string | null;
  connectionOrganizationId: string | null;
  connectionOwnerUserId: string | null;
  executionTargetId: string | null;
  config: Record<string, unknown>;
  secretRef: string | null;
}

/**
 * Per-row scope predicate (pure, unit-testable). The org_default branch is the
 * cross-tenant safety gate (M1): both sides must be present AND equal — NEVER
 * `!args.organizationId`, which admitted every tenant's org_default. Called by
 * buildResolveDeps.loadCandidateRows after the SQL scope filter (defense in depth).
 */
export function candidateMatchesScope(
  row: Pick<CandidateRow, "scopeType" | "scopeId" | "connectionOrganizationId">,
  args: Pick<ResolveArgs, "agentId" | "organizationId">,
): boolean {
  if (row.scopeType === "agent_override") return row.scopeId === args.agentId;
  if (row.scopeType === "personal_execution_default") return true; // owner match in gate
  if (row.scopeType === "org_default") {
    return Boolean(args.organizationId) && row.connectionOrganizationId === args.organizationId;
  }
  return true; // company_default
}

/** Injected so the resolver stays unit-testable and REUSES existing services. */
export interface ResolveDeps {
  loadCandidateRows: (db: Db, args: ResolveArgs) => Promise<CandidateRow[]>;
  resolveSecretValueForConnection: (db: Db, row: CandidateRow, args: ResolveArgs) => Promise<string | null>;
  /** REUSES resolveAgentSubscriptionEnvironment (home safety + owner-hop untouched). */
  resolveSubscriptionEnv: (db: Db, row: CandidateRow, args: ResolveArgs) => Promise<Record<string, string>>;
  envVarForProvider: (provider: string) => string;
  /** LEGACY fallback = secrets.ts resolveAdapterConfigForRuntime output env delta. */
  legacyResolveConfig: (cfg: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** LEGACY subscription home (heartbeat block), or null when N/A. */
  legacySubscriptionEnv: () => Promise<Record<string, string> | null>;
  selfHostedSingleTenant: boolean;
}

export type ResolvedProviderCredential =
  | { source: "agent_env_override" }
  | {
      source: "connection";
      connectionId: string;
      authMethod: AuthMethod;
      sharingScope: SharingPolicy;
      envPatch: Record<string, string>;
      provenance: {
        scopeType: AssignmentScopeType;
        ownerUserId: string | null;
        executionTargetId: string | null;
      };
    }
  | { source: "legacy"; envPatch: Record<string, string> }
  | { source: "host_login_fallback" };

/**
 * P4→P5 SEAM. The NORMALIZED result Phase 5 consumes instead of reading
 * provider_credentials directly (P5 Task 9 references THIS, by name). Maps the
 * five auth methods onto P5's two-value credential kind + the execution-target
 * slug the connection is pinned to.
 *   api_key | enterprise_gateway     → "company_api_key"
 *   personal_subscription            → "personal_subscription"
 *   anything else (override/legacy/host) → null
 */
export interface ExecutionTargetCredentialHint {
  credentialKind: "company_api_key" | "personal_subscription" | null;
  executionTargetSlug: string | null;
}

export function toExecutionTargetHint(
  resolved: ResolvedProviderCredential,
): ExecutionTargetCredentialHint {
  if (resolved.source !== "connection") {
    return { credentialKind: null, executionTargetSlug: null };
  }
  const credentialKind =
    resolved.authMethod === "personal_subscription"
      ? "personal_subscription"
      : "company_api_key";
  return { credentialKind, executionTargetSlug: resolved.provenance.executionTargetId };
}

/**
 * Fail-closed error for cloud (multi_tenant) resolution. A rejected assignment or
 * a total miss in multi-tenant NEVER falls through to an ambient host login —
 * cloud runtime has no operator CLI to borrow. Carries the connection id + reason
 * of the last rejection for a crisp founder-facing diagnosis.
 */
export class ProviderUnavailableError extends Error {
  readonly code = "provider_unavailable";
  constructor(
    readonly provider: string,
    readonly reason: string,
    readonly connectionId: string | null,
  ) {
    super(
      `No usable ${provider} provider credential for this run (${reason}` +
        (connectionId ? `, connection ${connectionId}` : "") +
        "). Cloud resolution fails closed and never uses a host login.",
    );
    this.name = "ProviderUnavailableError";
  }
}

/**
 * The ONE unified resolver. Reads the new model FIRST (Step 1-3); on no-winner it
 * falls back to the LEGACY ladder (Step 4) so unmigrated companies are unaffected.
 * Step 0 preserves "a per-agent value always wins" (secrets.ts:196 / D4). Tail:
 * host_login_fallback is ONLY for self-hosted single-tenant; multi-tenant fails
 * closed via ProviderUnavailableError (locked decision, item 22).
 */
export async function resolveProviderCredential(
  db: Db,
  args: ResolveArgs,
  deps: ResolveDeps,
): Promise<ResolvedProviderCredential> {
  // Step 0 — agent explicit override (api key already present & non-empty).
  const envVar = deps.envVarForProvider(args.provider);
  const existing = args.currentEnv[envVar];
  if (typeof existing === "string" && existing.trim().length > 0) {
    return { source: "agent_env_override" };
  }

  // Step 1 — assignment lookup (new model).
  const rows = await deps.loadCandidateRows(db, args);
  const ordered = orderCandidates(rows);

  // Step 2 — first candidate that passes all gates wins. Track the last rejection
  // so the multi-tenant fail-closed error names a real connection + reason.
  let lastRejection: { connectionId: string; reason: string } | null = null;
  for (const row of ordered) {
    const gate = candidatePassesStaticGates({
      authMethod: row.authMethod,
      scopeType: row.scopeType,
      state: row.state,
      termsAttestedAt: row.termsAttestedAt,
      sharingPolicy: row.sharingPolicy,
      actorKind: args.actorKind,
      connectionCompanyId: row.connectionCompanyId,
      requestCompanyId: args.companyId,
      connectionOwnerUserId: row.connectionOwnerUserId,
      requestOwnerUserId: subscriptionOwnerContext(args, row),
    });
    if (!gate.ok) {
      lastRejection = { connectionId: row.connectionId, reason: gate.reason ?? "gate_failed" };
      continue;
    }

    // Step 3 — materialize.
    let subscriptionEnv: Record<string, string> | null = null;
    let secretValue: string | null = null;
    if (row.authMethod === "personal_subscription") {
      // Delegates to resolveAgentSubscriptionEnvironment (fail-closed on owner
      // inactive / target mismatch / ambiguous / path escape). A throw here is
      // NOT fatal to resolution — skip and try the next candidate.
      try {
        subscriptionEnv = await deps.resolveSubscriptionEnv(db, row, args);
      } catch (err) {
        lastRejection = {
          connectionId: row.connectionId,
          reason: err instanceof Error ? err.message : "subscription_unavailable",
        };
        continue;
      }
    } else if (row.secretRef) {
      secretValue = await deps.resolveSecretValueForConnection(db, row, args);
    }

    const envPatch = materializeEnvPatch({
      authMethod: row.authMethod,
      provider: args.provider,
      envVar,
      secretValue,
      config: row.config,
      subscriptionEnv,
    });
    if (Object.keys(envPatch).length === 0) {
      lastRejection = { connectionId: row.connectionId, reason: "empty_credential" };
      continue; // empty ⇒ do not inject (secrets.ts:970)
    }

    return {
      source: "connection",
      connectionId: row.connectionId,
      authMethod: row.authMethod,
      sharingScope: row.sharingPolicy,
      envPatch,
      provenance: {
        scopeType: row.scopeType,
        ownerUserId: row.connectionOwnerUserId,
        executionTargetId: row.executionTargetId, // P4→P5 seam (toExecutionTargetHint)
      },
    };
  }

  // Step 4 — legacy fallback (STRANGLER). When no NEW assignment produced a
  // winner, defer to today's behavior exactly.
  const hadAssignment = rows.length > 0;
  const legacyEnvBefore = { ...args.currentEnv };
  const legacyCfg = await deps.legacyResolveConfig({ env: legacyEnvBefore });
  const legacyEnv = (legacyCfg.env as Record<string, string> | undefined) ?? {};
  const legacyPatch: Record<string, string> = {};
  for (const [k, v] of Object.entries(legacyEnv)) {
    if (legacyEnvBefore[k] !== v) legacyPatch[k] = v;
  }
  const legacySub = await deps.legacySubscriptionEnv();
  if (legacySub) Object.assign(legacyPatch, legacySub);

  if (Object.keys(legacyPatch).length > 0) return { source: "legacy", envPatch: legacyPatch };

  // Nothing anywhere. Self-hosted single-tenant → keyless host CLI login (D4 tail,
  // reproduces today's behavior). Multi-tenant NEVER borrows a host login — it
  // fails closed whether the miss is a rejected assignment or a total miss
  // (locked decision, item 22).
  if (deps.selfHostedSingleTenant) return { source: "host_login_fallback" };
  throw new ProviderUnavailableError(
    args.provider,
    lastRejection?.reason ?? (hadAssignment ? "assignment_rejected" : "no_assignment"),
    lastRejection?.connectionId ?? null,
  );
}

function subscriptionOwnerContext(args: ResolveArgs, row: CandidateRow): string | null {
  // HONESTY (M2): owner_only only performs *run-time* owner isolation when a TRUE
  // user identity is threaded — today that is Commander (actorType==="user", the
  // signed-in operator in args.context.actorId). For an AGENT run (crew/org,
  // actorType==="agent") there is no dispatching-user on the run context yet, so
  // this returns the connection owner and the owner_only gate compares a value to
  // itself → it PASSES. That is acceptable for beta because personal-subscription
  // isolation for agent runs does NOT rest on this gate — it rests on:
  //   (1) assignment provenance: a personal_subscription may only be an
  //       agent_override / personal_execution_default (never a shared default), so
  //       only agents a founder explicitly bound to it can select it;
  //   (2) chooseGovernedSubscriptionBinding's owner-active + exactly-one gates
  //       (provider-credential-bindings.ts:56) run in resolveSubscriptionEnv; and
  //   (3) personal_subscription is disabled entirely in multi_tenant (Task 9).
  // FOLLOW-UP HARDENING: thread the real dispatching-user id onto agent runs so
  // owner_only becomes a genuine run-time check for crew/org too (tracked, not in
  // this PR).
  return args.context.actorType === "user" ? args.context.actorId ?? null : row.connectionOwnerUserId;
}

/** Merge a resolved patch onto a config's env. No-op for override/host fallback. */
export function applyResolvedCredential(
  config: Record<string, unknown>,
  resolved: ResolvedProviderCredential,
): Record<string, unknown> {
  if (resolved.source === "agent_env_override" || resolved.source === "host_login_fallback") {
    return config;
  }
  const env = { ...((config.env as Record<string, string> | undefined) ?? {}) };
  return { ...config, env: { ...env, ...resolved.envPatch } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-resolve.test.ts`
Expected: PASS (override no-op, legacy fallback, connection win).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/provider-resolution.ts server/src/__tests__/provider-resolution-resolve.test.ts
git commit -m "feat(resolver): resolveProviderCredential with dual-read legacy fallback"
```

---

## Task 8: Live deps — `loadCandidateRows` + secret/subscription bridges

**Files:**
- Create: `server/src/services/provider-resolution-deps.ts`
- Test: `server/src/__tests__/provider-resolution-deps.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/provider-resolution-deps.test.ts
import { describe, it, expect, vi } from "vitest";
vi.mock("@armyofagents/db", () => ({ providerConnections: {}, providerAssignments: {}, companyMemberships: {} }));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }), eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  or: (...a: unknown[]) => ({ or: a }), isNull: (a: unknown) => ({ isNull: a }),
}));
import { buildResolveDeps } from "../services/provider-resolution-deps.js";

describe("buildResolveDeps", () => {
  it("marks self-hosted single-tenant from topology trustBoundary", () => {
    const deps = buildResolveDeps({} as never, {
      trustBoundary: "single_tenant",
    } as never);
    expect(deps.selfHostedSingleTenant).toBe(true);
    const multi = buildResolveDeps({} as never, { trustBoundary: "multi_tenant" } as never);
    expect(multi.selfHostedSingleTenant).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-deps.test.ts`
Expected: FAIL — `buildResolveDeps` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/provider-resolution-deps.ts
import type { Db } from "@armyofagents/db";
import { providerAssignments, providerConnections } from "@armyofagents/db";
import { and, eq, isNull, or } from "drizzle-orm";
import type { CliAuthTopology } from "./cli-auth-topology.js";
import { secretService } from "./secrets.js";
import { companyKeyTargetForAdapter } from "./secrets.js";
import { envVarForProvider } from "./providers/provider-key.js";
import {
  resolveAgentSubscriptionEnvironment,
  type CliSubscriptionProvider,
} from "./provider-credential-bindings.js";
import { candidateMatchesScope } from "./provider-resolution.js";
import type {
  CandidateRow,
  ResolveArgs,
  ResolveDeps,
} from "./provider-resolution.js";

/**
 * Live wiring. Every credential read REUSES an existing service:
 *   - secret_ref value  → secretService.resolveSecretValue (owner-hop respected upstream)
 *   - subscription home → resolveAgentSubscriptionEnvironment (home-safety untouched)
 *   - legacy fallback   → secretService.resolveAdapterConfigForRuntime
 */
export function buildResolveDeps(db: Db, topology: CliAuthTopology): ResolveDeps {
  const secrets = secretService(db);
  return {
    async loadCandidateRows(_db: Db, args: ResolveArgs): Promise<CandidateRow[]> {
      const query = db
        .select({
          connectionId: providerConnections.id,
          authMethod: providerConnections.authMethod,
          scopeType: providerAssignments.scopeType,
          scopeId: providerAssignments.scopeId,
          priority: providerAssignments.priority,
          connectionUpdatedAt: providerConnections.updatedAt,
          state: providerConnections.state,
          termsAttestedAt: providerConnections.termsAttestedAt,
          sharingPolicy: providerConnections.sharingPolicy,
          connectionCompanyId: providerConnections.companyId,
          connectionOrganizationId: providerConnections.organizationId,
          connectionOwnerUserId: providerConnections.ownerUserId,
          executionTargetId: providerConnections.executionTargetId,
          config: providerConnections.config,
          secretRef: providerConnections.secretRef,
        })
        .from(providerAssignments)
        .innerJoin(providerConnections, eq(providerAssignments.connectionId, providerConnections.id));

      // Cross-tenant safety (M1): an org_default row is included ONLY when its
      // organization_id equals the run's organization_id. When the run has no
      // organization_id (pre-P1 company), org_default is skipped entirely — never
      // "include every org_default". Company rows are always scoped by company_id.
      const orgDefaultClause = args.organizationId
        ? and(
            isNull(providerAssignments.companyId),
            eq(providerAssignments.scopeType, "org_default"),
            eq(providerAssignments.organizationId, args.organizationId),
          )
        : null;
      const scopeClause = orgDefaultClause
        ? or(eq(providerAssignments.companyId, args.companyId), orgDefaultClause)
        : eq(providerAssignments.companyId, args.companyId);
      const rowsQuery = query.where(
        and(
          eq(providerAssignments.provider, args.provider),
          eq(providerAssignments.state, "active"),
          scopeClause,
        ),
      );
      const rows = await rowsQuery;

      // Filter scoped rows to THIS agent / owner + defense-in-depth org gate.
      // The org-scope decision is the pure candidateMatchesScope (M1 cross-tenant
      // safety), unit-tested independently in Task 15.
      return rows
        .filter((r) => candidateMatchesScope(r, args))
        .map((r) => ({
          ...r,
          connectionUpdatedAt: r.connectionUpdatedAt ? new Date(r.connectionUpdatedAt).getTime() : 0,
          config: (r.config as Record<string, unknown>) ?? {},
        })) as CandidateRow[];
    },

    async resolveSecretValueForConnection(_db, row, args) {
      if (!row.secretRef) return null;
      return secrets.resolveSecretValue(args.companyId, row.secretRef, "latest", {
        ...args.context,
        configPath: `provider_connection.${row.connectionId}`,
      });
    },

    async resolveSubscriptionEnv(_db, row, args) {
      const provider = args.provider as CliSubscriptionProvider;
      const env = await resolveAgentSubscriptionEnvironment(db, {
        companyId: args.companyId,
        agentId: args.agentId ?? "",
        provider,
        executionTargetId: row.executionTargetId ?? args.executionTargetId,
      });
      // Narrow NodeJS.ProcessEnv → Record<string,string>.
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) if (typeof v === "string") out[k] = v;
      return out;
    },

    envVarForProvider: (provider: string) => {
      // Reuse the same env var the api-key ladder uses (owner-hopped internally).
      try {
        return envVarForProvider(provider);
      } catch {
        const target = companyKeyTargetForAdapter(`${provider}_local`);
        return target?.envVar ?? "ANTHROPIC_API_KEY";
      }
    },

    async legacyResolveConfig(cfg) {
      // Caller passes adapterType-specific closure; here we can't know it, so this
      // default is replaced by the call-site wiring (Tasks 11-13) which binds the
      // real adapterType. Kept as identity so unit tests exercise the seam.
      return cfg;
    },

    async legacySubscriptionEnv() {
      return null;
    },

    selfHostedSingleTenant: topology.trustBoundary !== "multi_tenant",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-deps.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/provider-resolution-deps.ts server/src/__tests__/provider-resolution-deps.test.ts
git commit -m "feat(resolver): live deps bridging secrets + subscription services"
```

> **Wiring note for Tasks 11-13:** each call-site overrides `legacyResolveConfig` with a closure bound to its real `adapterType` (e.g. `(cfg) => secrets.resolveAdapterConfigForRuntime(companyId, adapterType, cfg, context)`) and, for heartbeat/Commander, `legacySubscriptionEnv` with the existing `resolveAgentSubscriptionEnvironment` block guarded by `mayUseLegacySubscriptionHome`.

---

## Task 9: Connection service — create/verify (cloud_auth assert) + dual-write + rotate + revoke

**Files:**
- Create: `server/src/services/provider-connections.ts`
- Test: `server/src/__tests__/provider-connections-service.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/provider-connections-service.test.ts
import { describe, it, expect } from "vitest";
import { assertSubscriptionAllowed } from "../services/provider-connections.js";

describe("BOOT INVARIANT: personal_subscription disabled in multi_tenant/cloud_auth", () => {
  it("throws for personal_subscription in multi_tenant / cloud_auth (create + verify + mint gate)", () => {
    expect(() =>
      assertSubscriptionAllowed("personal_subscription", {
        trustBoundary: "multi_tenant",
      } as never),
    ).toThrow(/subscription/i);
  });
  it("allows personal_subscription in single_tenant (self-hosted)", () => {
    expect(() =>
      assertSubscriptionAllowed("personal_subscription", { trustBoundary: "single_tenant" } as never),
    ).not.toThrow();
  });
  it("never blocks shareable methods, even in multi_tenant", () => {
    expect(() =>
      assertSubscriptionAllowed("api_key", { trustBoundary: "multi_tenant" } as never),
    ).not.toThrow();
    expect(() =>
      assertSubscriptionAllowed("enterprise_gateway", { trustBoundary: "multi_tenant" } as never),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-connections-service.test.ts`
Expected: FAIL — `assertSubscriptionAllowed` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/provider-connections.ts
import type { Db } from "@armyofagents/db";
import { providerConnections, providerAssignments } from "@armyofagents/db";
import { and, eq } from "drizzle-orm";
import type { AuthMethod } from "@armyofagents/shared";
import type { CliAuthTopology } from "./cli-auth-topology.js";
import { unprocessable } from "../errors.js";
import { logActivity } from "./activity-log.js";
import { removeScopedSubscriptionCredentialHome } from "./provider-credentials.js";

/**
 * Locked decision (2) — BOOT INVARIANT: personal_subscription connections cannot
 * be created OR verified in multi_tenant / cloud_auth. This gate MUST be called on
 * EVERY personal_subscription mint/verify path:
 *   - the connection create route (Task 10 create handler),
 *   - this service's verify() (below), and
 *   - the login-runtime mint (commander-login-runtime.ts:244 onCredentialEvidence)
 *     — add an assertSubscriptionAllowed call there when P4 lands so a hosted
 *     instance cannot even record a pending subscription credential.
 * It is ALSO the run-time backstop for the owner_only tautology (M2): because
 * personal_subscription cannot exist at all in multi_tenant, a shared host never
 * resolves one regardless of the owner_only gate. Mirrors
 * providerSubscriptionCapability (cli-auth-topology.ts:133).
 */
export function assertSubscriptionAllowed(authMethod: AuthMethod, topology: CliAuthTopology): void {
  if (authMethod === "personal_subscription" && topology.trustBoundary === "multi_tenant") {
    throw unprocessable(
      "Personal subscription connections are disabled on shared hosted installations. Use a business API key or enterprise gateway.",
      { code: "subscription_disabled_multi_tenant" },
    );
  }
}

export function providerConnectionService(db: Db, topology: CliAuthTopology) {
  return {
    /** Mark a connection verified. Asserts the cloud_auth gate again at verify. */
    async verify(companyId: string, connectionId: string, actorUserId: string) {
      const [conn] = await db
        .select()
        .from(providerConnections)
        .where(and(eq(providerConnections.id, connectionId), eq(providerConnections.companyId, companyId)))
        .limit(1);
      if (!conn) throw unprocessable("Connection not found", { code: "connection_not_found" });
      assertSubscriptionAllowed(conn.authMethod as AuthMethod, topology);
      if (!conn.termsAttestedAt) {
        throw unprocessable("Provider terms must be attested before verification", { code: "terms_not_attested" });
      }
      const now = new Date();
      await db
        .update(providerConnections)
        .set({ state: "verified", verifiedAt: now, updatedAt: now })
        .where(eq(providerConnections.id, connectionId));
      await logActivity(db, {
        companyId, actorType: "user", actorId: actorUserId,
        action: "provider_connection.verified", entityType: "provider_connection", entityId: connectionId,
        details: { provider: conn.provider, authMethod: conn.authMethod },
      });
    },

    /** Rotation for shareable methods: secret_ref is stable; secretService.rotate
     *  appends a version (secrets.ts:691). Nothing here changes — documented no-op
     *  seam so callers rotate the underlying secret, not the connection row. */
    async touchAfterSecretRotation(connectionId: string) {
      await db
        .update(providerConnections)
        .set({ updatedAt: new Date() })
        .where(eq(providerConnections.id, connectionId));
    },

    /** Revoke: state=revoked, disable dependent assignments, wipe on-disk home for
     *  personal_subscription. Generalizes routes/provider-credentials.ts:324-362. */
    async revoke(companyId: string, connectionId: string, actorUserId: string) {
      const [conn] = await db
        .select()
        .from(providerConnections)
        .where(and(eq(providerConnections.id, connectionId), eq(providerConnections.companyId, companyId)))
        .limit(1);
      if (!conn) return null;
      const now = new Date();
      await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        await txDb
          .update(providerConnections)
          .set({ state: "revoked", revokedAt: now, updatedAt: now })
          .where(eq(providerConnections.id, connectionId));
        await txDb
          .update(providerAssignments)
          .set({ state: "disabled", updatedAt: now })
          .where(eq(providerAssignments.connectionId, connectionId));
        await logActivity(txDb, {
          companyId, actorType: "user", actorId: actorUserId,
          action: "provider_connection.revoked", entityType: "provider_connection", entityId: connectionId,
          details: { provider: conn.provider, authMethod: conn.authMethod },
        });
      });
      let filesRemoved = false;
      if (
        conn.authMethod === "personal_subscription" &&
        conn.ownerUserId &&
        conn.executionTargetId &&
        (conn.provider === "openai" || conn.provider === "anthropic")
      ) {
        filesRemoved = await removeScopedSubscriptionCredentialHome({
          companyId, userId: conn.ownerUserId, provider: conn.provider, executionTargetId: conn.executionTargetId,
        });
      }
      return { id: connectionId, state: "revoked", filesRemoved };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-connections-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/provider-connections.ts server/src/__tests__/provider-connections-service.test.ts
git commit -m "feat(connections): service with cloud_auth gate, rotate seam, revoke+home-wipe"
```

---

## Task 10: Founder REST routes + mount

**Files:**
- Create: `server/src/routes/provider-connections.ts`
- Modify: `server/src/app.ts` (import near `:24`; mount near `:274`)
- Test: `server/src/__tests__/provider-connections-route.test.ts`

- [ ] **Step 1: Write the failing test** (mirror `provider-credentials-route.test.ts` fakeDb pattern)

```ts
// server/src/__tests__/provider-connections-route.test.ts
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { providerConnectionRoutes } from "../routes/provider-connections.js";

function appWith(db: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = { type: "board", userId: "u1" }; next(); });
  app.use("/api", providerConnectionRoutes(db as never, { trustBoundary: "single_tenant" } as never));
  return app;
}

describe("provider-connections routes", () => {
  it("401s a non-board actor on list", async () => {
    const app = express();
    app.use((req, _res, next) => { (req as any).actor = { type: "agent" }; next(); });
    app.use("/api", providerConnectionRoutes({} as never, { trustBoundary: "single_tenant" } as never));
    const res = await request(app).get("/api/companies/co1/provider-connections");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-connections-route.test.ts`
Expected: FAIL — `providerConnectionRoutes` not found.

- [ ] **Step 3: Write minimal implementation** (routes are founder-scoped, mirror `provider-credentials.ts:18-42`)

```ts
// server/src/routes/provider-connections.ts
import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { providerConnections } from "@armyofagents/db";
import { eq } from "drizzle-orm";
import { assertRole } from "../middleware/rbac.js";
import { assertCompanyAccess } from "./authz.js";
import type { CliAuthTopology } from "../services/cli-auth-topology.js";
import { providerConnectionService } from "../services/provider-connections.js";

export function providerConnectionRoutes(db: Db, topology: CliAuthTopology): Router {
  const router = Router();
  const svc = providerConnectionService(db, topology);

  router.get("/companies/:companyId/provider-connections", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId); // Phase 3: async 3-arg
    await assertRole(db, req, companyId, "founder");
    const rows = await db
      .select({
        id: providerConnections.id, provider: providerConnections.provider,
        authMethod: providerConnections.authMethod, state: providerConnections.state,
        sharingPolicy: providerConnections.sharingPolicy, ownerUserId: providerConnections.ownerUserId,
        executionTargetId: providerConnections.executionTargetId, verifiedAt: providerConnections.verifiedAt,
      })
      .from(providerConnections)
      .where(eq(providerConnections.companyId, companyId));
    res.json(rows);
  });

  router.post("/companies/:companyId/provider-connections/:id/verify", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) { res.status(401).json({ error: "authentication required" }); return; }
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId); // Phase 3: async 3-arg
    await assertRole(db, req, companyId, "founder");
    await svc.verify(companyId, req.params.id as string, actor.userId);
    res.status(204).end();
  });

  router.delete("/companies/:companyId/provider-connections/:id", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) { res.status(401).json({ error: "authentication required" }); return; }
    const companyId = req.params.companyId as string;
    await assertCompanyAccess(db, req, companyId); // Phase 3: async 3-arg
    await assertRole(db, req, companyId, "founder");
    const result = await svc.revoke(companyId, req.params.id as string, actor.userId);
    if (!result) { res.status(404).json({ error: "Connection not found" }); return; }
    res.json(result);
  });

  return router;
}
```

Mount in `server/src/app.ts` (import after `:24`, mount after `:274`):

```ts
import { providerConnectionRoutes } from "./routes/provider-connections.js";
// ... in the router-mount block, near the existing providerCredentialRoutes mount:
app.use("/api", providerConnectionRoutes(db, cliAuthTopology));
```

(Use the same `CliAuthTopology` instance the app already resolves via `resolveCliAuthTopology`. If none is in scope at the mount site, resolve it once from `opts.deploymentMode` + exposure adjacent to the `providerCredentialRoutes` mount and pass it here.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-connections-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/provider-connections.ts server/src/app.ts server/src/__tests__/provider-connections-route.test.ts
git commit -m "feat(connections): founder REST routes (list/verify/revoke) + mount"
```

---

## Task 11: Wire Crew (`runner.ts`) to the ONE resolver — closes the subscription gap

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/runner.ts:522-527`
- Test: `server/src/__tests__/aoa-runner-provider-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/aoa-runner-provider-resolution.test.ts
import { describe, it, expect, vi } from "vitest";
import { applyResolvedCredential } from "../services/provider-resolution.js";

describe("crew applies resolved credential onto config.env", () => {
  it("connection patch merges over resolved base env", () => {
    const cfg = { env: { FOO: "bar" }, model: "opus" };
    const out = applyResolvedCredential(cfg, {
      source: "connection", connectionId: "c1", authMethod: "personal_subscription",
      sharingScope: "owner_only",
      envPatch: { HOME: "/h", CLAUDE_CONFIG_DIR: "/h/anthropic" },
      provenance: { scopeType: "agent_override", ownerUserId: "u1" },
    });
    expect(out).toEqual({ env: { FOO: "bar", HOME: "/h", CLAUDE_CONFIG_DIR: "/h/anthropic" }, model: "opus" });
  });
  it("agent_env_override is a no-op", () => {
    const cfg = { env: { ANTHROPIC_API_KEY: "sk" } };
    expect(applyResolvedCredential(cfg, { source: "agent_env_override" })).toBe(cfg);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/aoa-runner-provider-resolution.test.ts`
Expected: This unit test PASSES immediately (it exercises the already-built helper). It exists to lock the contract the wiring depends on. Run it, confirm PASS, then proceed — the WIRING itself is verified by the extended `aoa-runner.test.ts` in Step 4.

- [ ] **Step 3: Write the wiring** — in `runner.ts` immediately AFTER the `resolveAdapterConfigForRuntime` call (`:522-527`), before `getProviderStatus` (`:531`):

```ts
// Unified provider-credential resolution (Phase 4). Reads the new
// provider_connections model FIRST; falls back to the legacy company-key /
// subscription ladder when no assignment exists (STRANGLER). This is also where
// crew FINALLY honors a personal_subscription binding — the old runner path never
// called resolveAgentSubscriptionEnvironment.
const { resolveProviderCredential, applyResolvedCredential } = await import(
  "../../provider-resolution.js"
);
const { buildResolveDeps } = await import("../../provider-resolution-deps.js");
const { resolveCliAuthTopology } = await import("../../cli-auth-topology.js");
const topology = resolveCliAuthTopology({
  deploymentMode: adapterDeploymentMode, // the mode already resolved in this runner
  deploymentExposure: adapterDeploymentExposure,
});
const providerId =
  agent.adapterType === "codex_local" ? "openai"
  : agent.adapterType === "claude_local" ? "anthropic" : agent.adapterType;
const resolveDeps = {
  ...buildResolveDeps(db, topology),
  // Bind the legacy fallback to THIS adapter (deps default is identity).
  legacyResolveConfig: async (cfg: Record<string, unknown>) =>
    secretService(db).resolveAdapterConfigForRuntime(agent.companyId, agent.adapterType, cfg, {
      consumerType: "agent", consumerId: agent.id, actorType: "agent", actorId: agent.id,
    }),
};
const resolvedCredential = await resolveProviderCredential(
  db,
  {
    organizationId: null, companyId: agent.companyId, agentId: agent.id, actorKind: "crew",
    adapterType: agent.adapterType, provider: providerId,
    executionTargetId: process.env.AOA_EXECUTION_TARGET_ID?.trim() || "control-plane",
    currentEnv: (runtimeBaseConfig.env as Record<string, string>) ?? {},
    context: { consumerType: "agent", consumerId: agent.id, actorType: "agent", actorId: agent.id },
  },
  resolveDeps,
);
const runtimeBaseConfigResolved = applyResolvedCredential(
  runtimeBaseConfig as Record<string, unknown>,
  resolvedCredential,
);
```

Then change the subsequent `getProviderStatus`/`applyModelResolutionToConfig` calls (`:531-551`) to consume `runtimeBaseConfigResolved` instead of `runtimeBaseConfig`. (The connector-token merge at `:581-588` stays downstream and unchanged.)

- [ ] **Step 4: Run tests to verify wiring**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/aoa-runner-provider-resolution.test.ts src/__tests__/aoa-runner.test.ts`
Expected: PASS. If `aoa-runner.test.ts` mocks `provider-resolution`, add a `vi.mock("../services/provider-resolution.js", ...)` returning a passthrough `applyResolvedCredential` + `resolveProviderCredential → { source: "agent_env_override" }` so existing assertions on config are unchanged.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/runner.ts server/src/__tests__/aoa-runner-provider-resolution.test.ts
git commit -m "feat(crew): route runner.ts through the unified provider resolver"
```

---

## Task 12: Wire heartbeat (org agents) to the ONE resolver

**Files:**
- Modify: `server/src/services/heartbeat.ts:3040` (company-key fallback) and `:3991-4035` (subscription block)
- Test: `server/src/__tests__/heartbeat-provider-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/heartbeat-provider-resolution.test.ts
import { describe, it, expect } from "vitest";
import { applyResolvedCredential } from "../services/provider-resolution.js";

describe("heartbeat resolver merge preserves 3-scope env", () => {
  it("legacy company-key patch merges without dropping model/cwd", () => {
    const cfg = { env: { PROJECT_KEY: "p" }, model: "opus", cwd: "/w" };
    const out = applyResolvedCredential(cfg, {
      source: "legacy", envPatch: { ANTHROPIC_API_KEY: "sk-co" },
    });
    expect(out).toEqual({ env: { PROJECT_KEY: "p", ANTHROPIC_API_KEY: "sk-co" }, model: "opus", cwd: "/w" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails/passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/heartbeat-provider-resolution.test.ts`
Expected: PASS (helper contract). Wiring is validated by the existing `provider-key-heartbeat.test.ts` in Step 4.

- [ ] **Step 3: Write the wiring** — REPLACE the two heartbeat blocks:

(a) At `:3040`, keep the 3-scope `resolvedEnv` assembly (`:3006-3026`), but route the fallback through the resolver instead of `applyCompanyKeyFallbackForRuntime`:

```ts
const { resolveProviderCredential, applyResolvedCredential, toExecutionTargetHint } = await import(
  "./provider-resolution.js"
);
const { buildResolveDeps } = await import("./provider-resolution-deps.js");
const { resolveCliAuthTopology } = await import("./cli-auth-topology.js");
const hbTopology = resolveCliAuthTopology({
  deploymentMode: heartbeatDeploymentMode,
  deploymentExposure: heartbeatDeploymentExposure,
});
const hbProviderId =
  agent.adapterType === "codex_local" ? "openai"
  : agent.adapterType === "claude_local" ? "anthropic" : agent.adapterType;
const hbDeps = {
  ...buildResolveDeps(db, hbTopology),
  legacyResolveConfig: async (cfg: Record<string, unknown>) =>
    secretsSvc.applyCompanyKeyFallbackForRuntime(agent.companyId, agent.adapterType, cfg, {
      consumerType: "agent", consumerId: agent.id, ...secretActorContext,
    }),
  // The existing subscription block becomes the legacy subscription fallback,
  // preserving mayUseLegacySubscriptionHome semantics for unmigrated companies.
  legacySubscriptionEnv: async () => {
    if (hbProviderId !== "openai" && hbProviderId !== "anthropic") return null;
    const cfgEnv = resolvedEnv as Record<string, string>;
    const apiKeyName = hbProviderId === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    if (typeof cfgEnv[apiKeyName] === "string" && cfgEnv[apiKeyName].trim().length > 0) return null;
    try {
      const boundEnv = await resolveAgentSubscriptionEnvironment(db, {
        companyId: agent.companyId, agentId: agent.id, provider: hbProviderId,
        executionTargetId: process.env.AOA_EXECUTION_TARGET_ID?.trim() || "control-plane",
      });
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(boundEnv)) if (typeof v === "string") out[k] = v;
      return out;
    } catch (error) {
      const scopedRequired = /^(1|true|yes)$/i.test(process.env.AOA_SCOPED_CLI_AUTH?.trim() ?? "");
      if (!mayUseLegacySubscriptionHome(error, scopedRequired)) throw error;
      return null;
    }
  },
};
const hbResolved = await resolveProviderCredential(
  db,
  {
    // organizationId null keeps org_default rows INERT (candidateMatchesScope
    // fails closed on a null org id — M1). Threading the company's real
    // organization_id here to activate org_default resolution is a follow-up;
    // company_default + agent_override already work with null.
    organizationId: null, companyId: agent.companyId, agentId: agent.id, actorKind: "org",
    adapterType: agent.adapterType, provider: hbProviderId,
    executionTargetId: process.env.AOA_EXECUTION_TARGET_ID?.trim() || "control-plane",
    currentEnv: resolvedEnv as Record<string, string>,
    context: { consumerType: "agent", consumerId: agent.id, ...secretActorContext },
  },
  hbDeps,
);
const resolvedConfig = applyResolvedCredential(
  { ...mergedConfigWithEnvironmentTarget, env: resolvedEnv } as Record<string, unknown>,
  hbResolved,
) as Record<string, unknown>;

// P4→P5 SEAM (wired). Normalize the resolution for Phase 5's execution-target
// selector. P5 Task 9 reads `p4CredentialHint.credentialKind` +
// `p4CredentialHint.executionTargetSlug` off the run scope instead of querying
// provider_credentials directly. Expose it on the same run-scope object P5 reads
// (alongside runScopedConfig, at the point the run context is assembled).
const p4CredentialHint = toExecutionTargetHint(hbResolved);
// e.g. runScope.p4CredentialHint = p4CredentialHint;  (assign on the actual run
// context object this function returns/threads — the field name is `p4CredentialHint`).
```

(b) DELETE the standalone subscription block at `:3991-4035` (its logic now lives in `legacySubscriptionEnv` above and in the resolver's connection path). Keep `runScopedConfig = resolvedConfigWithEnvironmentAcquisition` initialization and everything downstream unchanged.

> **P5 REBASE NOTE (jointly-owned region `:2946-4035`, executed P4-FIRST):** heartbeat `:2946-4035` is co-owned with Phase 5, and Phase 4 lands first. After this task's delete, the old "dedicated-target throw" that lived at `:4012-4016` (`throw new Error("Governed subscription credentials currently require the dedicated local execution target.")`) now lives **inside** this task's `legacySubscriptionEnv` closure — specifically its `local`-target branch. **P5 must rebase its "dedicated-target throw replacement" onto the post-delete heartbeat** by editing the `legacySubscriptionEnv` closure (and/or the resolver's execution-target seam from Fix 3), NOT the deleted `:3991-4035` block, which no longer exists. Flag this in the P4 PR description so P5's rebase target is unambiguous.

- [ ] **Step 4: Run tests to verify wiring**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/heartbeat-provider-resolution.test.ts src/__tests__/provider-key-heartbeat.test.ts`
Expected: PASS. `provider-key-heartbeat.test.ts` (company-key fallback) must still pass because the legacy closure reproduces its exact behavior.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/heartbeat.ts server/src/__tests__/heartbeat-provider-resolution.test.ts
git commit -m "feat(heartbeat): route org agents through the unified provider resolver"
```

---

## Task 13: Wire Commander (`cli-mode.ts`) + #310 merge note

**Files:**
- Modify: `server/src/services/internal-agent/cli-mode.ts` (credential-provisioning path)
- Test: `server/src/__tests__/commander-provider-resolution.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/commander-provider-resolution.test.ts
import { describe, it, expect } from "vitest";
import { candidatePassesStaticGates } from "../services/provider-resolution.js";

describe("commander owner_only enforcement (stands in for #310 subscription_commander_only)", () => {
  it("rejects a personal subscription for a commander user who is not the owner", () => {
    const r = candidatePassesStaticGates({
      authMethod: "personal_subscription", scopeType: "agent_override", state: "verified",
      termsAttestedAt: new Date(), sharingPolicy: "owner_only", actorKind: "commander",
      connectionCompanyId: "co1", requestCompanyId: "co1",
      connectionOwnerUserId: "owner", requestOwnerUserId: "intruder",
    });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (contract already built in Task 6)

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/commander-provider-resolution.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the wiring** — in `cli-mode.ts`, at the point where the per-session env is assembled (before the codex `spawnEnv`/claude `CLAUDE_CONFIG_DIR` overlay is finalized), call the resolver with `actorKind:"commander"`, `agentId = internalAgentConfig.agentId`, and pass the acting user as `context.actorId` (`actorType:"user"`). Merge the resulting patch into the session spawn env via `applyResolvedCredential`. Bind `legacyResolveConfig` to the existing Commander key path and `legacySubscriptionEnv` to the existing managed-home provisioning so unmigrated companies are unchanged. Add this block comment verbatim:

```ts
// ── #310 MERGE NOTE ─────────────────────────────────────────────────────────
// #310 introduces commander-runtime-auth.ts (assertCommanderSubscriptionAgent /
// subscription_commander_only) which does NOT exist on this branch. At merge,
// that Commander-only gate MUST be expressed as this resolver's owner_only
// sharingPolicy (connection.ownerUserId === acting user) — NOT as a parallel
// Commander credential path. Do not reintroduce a second resolution site.
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/commander-provider-resolution.test.ts && pnpm --filter @armyofagents/server exec vitest run -t commander`
Expected: PASS; existing Commander cli-mode tests unaffected (mock the resolver to `agent_env_override` where those tests assert exact spawn env).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/internal-agent/cli-mode.ts server/src/__tests__/commander-provider-resolution.test.ts
git commit -m "feat(commander): route cli-mode through unified resolver + #310 merge note"
```

---

## Task 14: Idempotent backfill reconciler (dual-write existing rows)

**Files:**
- Create: `server/src/services/provider-connections-backfill.ts`
- Modify: `server/src/index.ts` (invoke once at boot, best-effort, after DB ready)
- Test: `server/src/__tests__/provider-connections-backfill.test.ts`

> **Why a reconciler, not a raw SQL migration:** CLAUDE.md Rule #1 forbids raw SQL migration files. This is a DATA backfill (idempotent `INSERT … ON CONFLICT DO NOTHING` via Drizzle), run once at boot behind the identity uniques from Task 1 — same shape as existing boot reconcilers (e.g. marketplace steward reconcile).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/provider-connections-backfill.test.ts
import { describe, it, expect } from "vitest";
import { planBackfill } from "../services/provider-connections-backfill.js";

describe("planBackfill", () => {
  it("maps a provider:<id> company secret to an api_key connection + company_default assignment", () => {
    const plan = planBackfill({
      companyKeySecrets: [{ companyId: "co1", secretId: "sec1", providerId: "anthropic" }],
      subscriptionBindings: [],
    });
    expect(plan.connections).toContainEqual(expect.objectContaining({
      companyId: "co1", provider: "anthropic", authMethod: "api_key",
      secretRef: "sec1", sharingPolicy: "company_agents",
    }));
    expect(plan.assignments).toContainEqual(expect.objectContaining({
      companyId: "co1", provider: "anthropic", scopeType: "company_default", scopeId: null,
    }));
  });

  it("maps a verified subscription binding to a personal_subscription connection + agent_override", () => {
    const plan = planBackfill({
      companyKeySecrets: [],
      subscriptionBindings: [{
        companyId: "co1", provider: "anthropic", ownerUserId: "u1",
        executionTargetId: "t1", agentId: "ag1",
      }],
    });
    expect(plan.connections).toContainEqual(expect.objectContaining({
      authMethod: "personal_subscription", secretRef: null, ownerUserId: "u1",
      executionTargetId: "t1", sharingPolicy: "owner_only",
    }));
    expect(plan.assignments).toContainEqual(expect.objectContaining({
      scopeType: "agent_override", scopeId: "ag1",
    }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-connections-backfill.test.ts`
Expected: FAIL — `planBackfill` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/services/provider-connections-backfill.ts
import type { Db } from "@armyofagents/db";
import {
  agentProviderCredentialBindings,
  companySecrets,
  providerAssignments,
  providerConnections,
  providerCredentials,
} from "@armyofagents/db";
import { and, eq, isNotNull, isNull, like } from "drizzle-orm";

export interface CompanyKeySecret { companyId: string; secretId: string; providerId: string; }
export interface SubscriptionBindingRow {
  companyId: string; provider: string; ownerUserId: string; executionTargetId: string; agentId: string;
}

export interface BackfillPlan {
  connections: Array<{
    companyId: string; provider: string; authMethod: "api_key" | "personal_subscription";
    secretRef: string | null; ownerUserId: string | null; executionTargetId: string | null;
    sharingPolicy: "company_agents" | "owner_only"; state: "verified";
  }>;
  assignments: Array<{
    companyId: string; provider: string;
    scopeType: "company_default" | "agent_override"; scopeId: string | null;
  }>;
}

/** Pure planner — deterministic, unit-testable. Execution (Step below) inserts
 *  with ON CONFLICT DO NOTHING so re-runs are idempotent (identity uniques). */
export function planBackfill(input: {
  companyKeySecrets: CompanyKeySecret[];
  subscriptionBindings: SubscriptionBindingRow[];
}): BackfillPlan {
  const plan: BackfillPlan = { connections: [], assignments: [] };
  for (const s of input.companyKeySecrets) {
    plan.connections.push({
      companyId: s.companyId, provider: s.providerId, authMethod: "api_key",
      secretRef: s.secretId, ownerUserId: null, executionTargetId: null,
      sharingPolicy: "company_agents", state: "verified",
    });
    plan.assignments.push({
      companyId: s.companyId, provider: s.providerId, scopeType: "company_default", scopeId: null,
    });
  }
  for (const b of input.subscriptionBindings) {
    plan.connections.push({
      companyId: b.companyId, provider: b.provider, authMethod: "personal_subscription",
      secretRef: null, ownerUserId: b.ownerUserId, executionTargetId: b.executionTargetId,
      sharingPolicy: "owner_only", state: "verified",
    });
    plan.assignments.push({
      companyId: b.companyId, provider: b.provider, scopeType: "agent_override", scopeId: b.agentId,
    });
  }
  return plan;
}

/**
 * Idempotent execution: load existing legacy rows, plan, insert-or-ignore. Loads
 * `company_secrets` named `provider:%` and verified personal_subscription
 * provider_credentials + approved bindings. termsAttestedAt + verifiedAt are set
 * to now for backfilled rows (they were already in production use = implicitly
 * attested). Re-runs insert nothing (identity + scope uniques from Task 1).
 */
export interface BackfillSummary {
  inserted: number;
  skipped: number;
  errors: number;
}

export async function runProviderConnectionsBackfill(
  db: Db,
  log: (level: "info" | "warn", msg: string, meta?: Record<string, unknown>) => void = () => {},
): Promise<BackfillSummary> {
  // (1) Company provider API keys → api_key connections.
  const keyRows = await db
    .select({ companyId: companySecrets.companyId, secretId: companySecrets.id, name: companySecrets.name })
    .from(companySecrets)
    .where(
      and(
        like(companySecrets.name, "provider:%"),
        isNull(companySecrets.deletedAt),
        eq(companySecrets.status, "active"),
      ),
    );
  const companyKeySecrets: CompanyKeySecret[] = keyRows.map((r) => ({
    companyId: r.companyId,
    secretId: r.secretId,
    // `provider:<ownerId>` → catalog owner id (the same key the resolver reads).
    providerId: r.name.slice("provider:".length),
  }));

  // (2) Verified personal subscriptions with an approved (unrevoked) binding.
  const subRows = await db
    .select({
      companyId: providerCredentials.companyId,
      provider: providerCredentials.provider,
      ownerUserId: providerCredentials.ownerUserId,
      executionTargetId: providerCredentials.executionTargetId,
      agentId: agentProviderCredentialBindings.agentId,
    })
    .from(providerCredentials)
    .innerJoin(
      agentProviderCredentialBindings,
      eq(agentProviderCredentialBindings.credentialId, providerCredentials.id),
    )
    .where(
      and(
        eq(providerCredentials.kind, "personal_subscription"),
        eq(providerCredentials.state, "verified"),
        // M4: a verified sub with NULL owner/target would violate the connection
        // subscription CHECK (23514) and abort the whole reconciler — pre-filter.
        isNotNull(providerCredentials.ownerUserId),
        isNotNull(providerCredentials.executionTargetId),
        isNotNull(agentProviderCredentialBindings.approvedAt),
        isNull(agentProviderCredentialBindings.revokedAt),
      ),
    );
  const subscriptionBindings: SubscriptionBindingRow[] = subRows.map((r) => ({
    companyId: r.companyId,
    provider: r.provider,
    ownerUserId: r.ownerUserId,
    executionTargetId: r.executionTargetId,
    agentId: r.agentId,
  }));

  const plan = planBackfill({ companyKeySecrets, subscriptionBindings });
  const now = new Date();
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < plan.connections.length; i++) {
    const conn = plan.connections[i]!;
    const asn = plan.assignments[i]!;
    // M4: isolate each item. ONE malformed row must never abort the whole
    // reconciler (which is best-effort at boot and would otherwise swallow the
    // error into a silent zero backfill). A conflict is a skip; a real error is
    // counted and logged, and the loop continues.
    try {
      const didInsert = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
      // Insert-or-ignore the connection; capture id (re-select on conflict).
      const insertedConn = await txDb
        .insert(providerConnections)
        .values({
          companyId: conn.companyId,
          provider: conn.provider,
          authMethod: conn.authMethod,
          ownerUserId: conn.ownerUserId,
          executionTargetId: conn.executionTargetId,
          secretRef: conn.secretRef,
          state: "verified",
          sharingPolicy: conn.sharingPolicy,
          termsAttestedAt: now,
          verifiedAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: providerConnections.identityUq })
        .returning({ id: providerConnections.id });
      let connectionId = insertedConn[0]?.id ?? null;
      const created = connectionId !== null;
      if (!connectionId) {
        const [existing] = await txDb
          .select({ id: providerConnections.id })
          .from(providerConnections)
          .where(
            and(
              conn.companyId
                ? eq(providerConnections.companyId, conn.companyId)
                : isNull(providerConnections.companyId),
              eq(providerConnections.provider, conn.provider),
              eq(providerConnections.authMethod, conn.authMethod),
              conn.ownerUserId
                ? eq(providerConnections.ownerUserId, conn.ownerUserId)
                : isNull(providerConnections.ownerUserId),
              conn.executionTargetId
                ? eq(providerConnections.executionTargetId, conn.executionTargetId)
                : isNull(providerConnections.executionTargetId),
            ),
          )
          .limit(1);
        connectionId = existing?.id ?? null;
      }
        if (!connectionId) return false; // unreachable in practice; skip the assignment safely
        // Assignment is upserted on EVERY pass (even when the connection already
        // existed) so a re-run still links a missing assignment; the scope unique
        // makes the re-insert a no-op.
        await txDb
          .insert(providerAssignments)
          .values({
            companyId: asn.companyId,
            provider: asn.provider,
            connectionId,
            scopeType: asn.scopeType,
            scopeId: asn.scopeId,
            state: "active",
            updatedAt: now,
          })
          .onConflictDoNothing({ target: providerAssignments.scopeUq });
        return created;
      });
      if (didInsert) inserted++;
      else skipped++;
    } catch (err) {
      // M4: one bad row must not abort the reconciler. Count + log + continue.
      errors++;
      log("warn", "provider-connections backfill: item skipped after error", {
        provider: conn.provider,
        authMethod: conn.authMethod,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log("info", "provider-connections backfill complete", { inserted, skipped, errors });
  return { inserted, skipped, errors };
}
```

Invoke best-effort from `server/src/index.ts` after DB init (alongside existing boot reconcilers), wrapped in try/catch, passing the pino logger as `log` — a backfill failure must never block boot, and the `{ inserted, skipped, errors }` summary is logged at boot.

- [ ] **Step 4: Run the pure-planner test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-connections-backfill.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the DB idempotency + robustness integration test**

Real ON CONFLICT idempotency needs a real DB, so this is an embedded-pg integration test (`*.integration.test.ts` — runs on Linux CI, skipped on Windows CI per the platform matrix; run locally with the embedded-pg flag). File: `server/src/__tests__/provider-connections-backfill.integration.test.ts`.

```ts
// server/src/__tests__/provider-connections-backfill.integration.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { runProviderConnectionsBackfill } from "../services/provider-connections-backfill.js";
import { providerConnections, providerAssignments } from "@armyofagents/db";
import { eq } from "drizzle-orm";
// Uses the repo's embedded-pg test harness (see other *.integration.test.ts for
// the exact db bootstrap + seed helpers).
import { withTestDb, seedCompany, seedProviderKeySecret, seedVerifiedSubscription } from "./helpers/it-db.js";

describe("runProviderConnectionsBackfill (DB)", () => {
  it("runs TWICE: first backfills, second inserts 0 with assignments still linked", async () => {
    await withTestDb(async (db) => {
      const { companyId } = await seedCompany(db);
      await seedProviderKeySecret(db, { companyId, providerId: "anthropic" }); // provider:anthropic secret
      await seedVerifiedSubscription(db, { companyId, provider: "anthropic", ownerUserId: "u1", executionTargetId: "t1", agentId: "ag1" });

      const first = await runProviderConnectionsBackfill(db);
      expect(first.inserted).toBe(2); // one api_key + one personal_subscription
      expect(first.errors).toBe(0);

      const second = await runProviderConnectionsBackfill(db);
      expect(second.inserted).toBe(0);
      expect(second.skipped).toBe(2);
      expect(second.errors).toBe(0);

      const conns = await db.select().from(providerConnections).where(eq(providerConnections.companyId, companyId));
      expect(conns).toHaveLength(2); // no duplicates on the second run
      const asns = await db.select().from(providerAssignments).where(eq(providerAssignments.companyId, companyId));
      // Every assignment links a real connection.
      for (const a of asns) expect(conns.some((c) => c.id === a.connectionId)).toBe(true);
    });
  });

  it("a pre-existing connection is skipped, not duplicated, and its assignment still links", async () => {
    await withTestDb(async (db) => {
      const { companyId } = await seedCompany(db);
      await seedProviderKeySecret(db, { companyId, providerId: "anthropic" });
      // Pre-insert the api_key connection the backfill would mint.
      await runProviderConnectionsBackfill(db); // creates it
      const before = await db.select().from(providerConnections).where(eq(providerConnections.companyId, companyId));
      expect(before).toHaveLength(1);

      const again = await runProviderConnectionsBackfill(db);
      expect(again.inserted).toBe(0);
      expect(again.skipped).toBe(1);
      const after = await db.select().from(providerConnections).where(eq(providerConnections.companyId, companyId));
      expect(after).toHaveLength(1); // still exactly one
    });
  });
});
```

> The `seedVerifiedSubscription` helper must also be exercised with a NULL `executionTargetId` row present in the table to prove the M4 pre-filter (`isNotNull`) excludes it — add a third row with null target and assert `inserted` does not count it and `errors` stays 0.

Run: `AOA_RUN_INTEGRATION=1 pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-connections-backfill.integration.test.ts` (Linux/local; Windows CI skips it).
Expected: PASS — 2 inserted then 0; no duplicates; assignments link; null-target row excluded.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/provider-connections-backfill.ts server/src/index.ts server/src/__tests__/provider-connections-backfill.test.ts server/src/__tests__/provider-connections-backfill.integration.test.ts
git commit -m "feat(connections): idempotent boot backfill (skip/error counts) + DB idempotency tests"
```

---

## Task 15: Precedence + leakage test matrix

**Files:**
- Test: `server/src/__tests__/provider-resolution-matrix.test.ts`
- Test: `server/src/__tests__/provider-resolution-overlay-keys.test.ts`

- [ ] **Step 1: Write the precedence + leakage matrix**

```ts
// server/src/__tests__/provider-resolution-matrix.test.ts
import { describe, it, expect, vi } from "vitest";
vi.mock("@armyofagents/db", () => ({ providerConnections: {}, providerAssignments: {}, companyMemberships: {} }));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }), eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  or: (...a: unknown[]) => ({ or: a }), isNull: (a: unknown) => ({ isNull: a }),
}));
import {
  resolveProviderCredential,
  ProviderUnavailableError,
  candidateMatchesScope,
  type CandidateRow,
} from "../services/provider-resolution.js";

const row = (o: Partial<CandidateRow>): CandidateRow => ({
  connectionId: "c", authMethod: "api_key", scopeType: "company_default", priority: 0,
  connectionUpdatedAt: 1, state: "verified", termsAttestedAt: new Date(), sharingPolicy: "company_agents",
  connectionCompanyId: "co1", connectionOrganizationId: null, connectionOwnerUserId: null,
  executionTargetId: null, config: {}, secretRef: "sec", ...o,
});

const baseArgs = {
  organizationId: null, companyId: "co1", agentId: "ag1", actorKind: "crew" as const,
  adapterType: "claude_local", provider: "anthropic", executionTargetId: "control-plane",
  currentEnv: {} as Record<string, string>,
  context: { consumerType: "agent" as const, consumerId: "ag1", actorType: "agent" as const, actorId: "ag1" },
};
const deps = (rows: CandidateRow[], secret = "sk") => ({
  loadCandidateRows: vi.fn(async () => rows),
  resolveSecretValueForConnection: vi.fn(async () => secret),
  resolveSubscriptionEnv: vi.fn(async () => ({ HOME: "/h", CLAUDE_CONFIG_DIR: "/h/anthropic" })),
  envVarForProvider: () => "ANTHROPIC_API_KEY",
  legacyResolveConfig: vi.fn(async (c: Record<string, unknown>) => c),
  legacySubscriptionEnv: vi.fn(async () => null),
  selfHostedSingleTenant: true,
});

describe("precedence matrix", () => {
  it("agent_override wins over company + org", async () => {
    const r = await resolveProviderCredential({} as never, baseArgs, deps([
      row({ connectionId: "org", scopeType: "org_default" }),
      row({ connectionId: "co", scopeType: "company_default" }),
      row({ connectionId: "ag", scopeType: "agent_override" }),
    ]) as never);
    expect(r.source === "connection" && r.connectionId).toBe("ag");
  });

  it("company_default wins over org_default", async () => {
    const r = await resolveProviderCredential({} as never, baseArgs, deps([
      row({ connectionId: "org", scopeType: "org_default" }),
      row({ connectionId: "co", scopeType: "company_default" }),
    ]) as never);
    expect(r.source === "connection" && r.connectionId).toBe("co");
  });

  it("org_default personal_subscription is rejected (owner-only) → falls to legacy", async () => {
    const r = await resolveProviderCredential({} as never, baseArgs, deps([
      row({ connectionId: "orgSub", scopeType: "org_default", authMethod: "personal_subscription",
        ownerUserId: "u1", executionTargetId: "t1", secretRef: null }),
    ]) as never);
    expect(r.source).toBe("host_login_fallback"); // no legacy patch + self-hosted
  });

  it("suspended candidate is skipped", async () => {
    const r = await resolveProviderCredential({} as never, baseArgs, deps([
      row({ connectionId: "susp", state: "suspended" }),
    ]) as never);
    expect(r.source).not.toBe("connection");
  });

  it("business api_key inherits to org actor (Commander/crew/org all resolve it)", async () => {
    for (const actorKind of ["crew", "org", "commander"] as const) {
      const r = await resolveProviderCredential(
        {} as never, { ...baseArgs, actorKind },
        deps([row({ scopeType: "company_default", authMethod: "api_key" })]) as never,
      );
      expect(r.source).toBe("connection");
    }
  });

  it("LEAKAGE: company_agents connection for a different company is skipped", async () => {
    const r = await resolveProviderCredential({} as never, baseArgs, deps([
      row({ connectionCompanyId: "OTHER_CO", sharingPolicy: "company_agents" }),
    ]) as never);
    expect(r.source).not.toBe("connection");
  });

  it("LEAKAGE: empty secret value injects nothing → not a connection win", async () => {
    const r = await resolveProviderCredential({} as never, baseArgs, deps([row({})], "") as never);
    expect(r.source).not.toBe("connection");
  });

  it("multi-tenant with a rejected assignment THROWS ProviderUnavailableError (never host login)", async () => {
    const d = deps([row({ connectionId: "rev1", state: "revoked" })]);
    d.selfHostedSingleTenant = false;
    await expect(resolveProviderCredential({} as never, baseArgs, d as never)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it("multi-tenant with NO assignment and no legacy also fails closed (never host login)", async () => {
    const d = deps([]);
    d.selfHostedSingleTenant = false;
    await expect(resolveProviderCredential({} as never, baseArgs, d as never)).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it("self-hosted single-tenant with no assignment → host_login_fallback (D4 preserved)", async () => {
    const r = await resolveProviderCredential({} as never, baseArgs, deps([]) as never);
    expect(r.source).toBe("host_login_fallback");
  });
});

describe("candidateMatchesScope — M1 cross-tenant leak guard", () => {
  it("companyB (org-2) does NOT match org-1's org_default connection", () => {
    const org1Default = { scopeType: "org_default" as const, scopeId: null, connectionOrganizationId: "org-1" };
    expect(candidateMatchesScope(org1Default, { agentId: "agB", organizationId: "org-2" })).toBe(false);
  });
  it("companyA (org-1) DOES match org-1's org_default connection", () => {
    const org1Default = { scopeType: "org_default" as const, scopeId: null, connectionOrganizationId: "org-1" };
    expect(candidateMatchesScope(org1Default, { agentId: "agA", organizationId: "org-1" })).toBe(true);
  });
  it("a run with no organization_id NEVER matches any org_default (fail-closed)", () => {
    const org1Default = { scopeType: "org_default" as const, scopeId: null, connectionOrganizationId: "org-1" };
    expect(candidateMatchesScope(org1Default, { agentId: "agX", organizationId: null })).toBe(false);
  });
  it("agent_override matches only its own agent id", () => {
    const ovr = { scopeType: "agent_override" as const, scopeId: "ag1", connectionOrganizationId: null };
    expect(candidateMatchesScope(ovr, { agentId: "ag1", organizationId: null })).toBe(true);
    expect(candidateMatchesScope(ovr, { agentId: "ag2", organizationId: null })).toBe(false);
  });
});
```

- [ ] **Step 2: Write the overlay-keys drift guard**

```ts
// server/src/__tests__/provider-resolution-overlay-keys.test.ts
import { describe, it, expect } from "vitest";
import { materializeEnvPatch } from "../services/provider-resolution.js";
import { GATEWAY_TOKEN_ENV_ALLOWLIST } from "@armyofagents/shared";
// Cross-package import is fine in TESTS: assert our enterprise_gateway env keys
// stay in the adapter's overlay-auth allow-list (ambient-config.ts:415-424),
// or the ambient strip would delete them at spawn.
import { CLAUDE_OVERLAY_AUTH_KEYS } from "@armyofagents/adapter-claude-local/server/ambient-config";

describe("resolver env keys survive the ambient strip", () => {
  it("every allowed gateway tokenEnvVar is in CLAUDE_OVERLAY_AUTH_KEYS", () => {
    for (const key of GATEWAY_TOKEN_ENV_ALLOWLIST) {
      expect(CLAUDE_OVERLAY_AUTH_KEYS).toContain(key);
    }
  });

  it("enterprise_gateway emitted keys (base URL + token) are all in CLAUDE_OVERLAY_AUTH_KEYS", () => {
    const gateway = materializeEnvPatch({ authMethod: "enterprise_gateway", provider: "anthropic",
      envVar: "ANTHROPIC_API_KEY", secretValue: "t", config: { baseUrl: "https://g" }, subscriptionEnv: null });
    for (const key of Object.keys(gateway)) {
      expect(CLAUDE_OVERLAY_AUTH_KEYS).toContain(key);
    }
  });
});
```

> If `@armyofagents/adapter-claude-local` is not the exact package specifier, resolve it from `packages/adapters/claude-local/package.json` `name` field and adjust the import; the assertion is what matters.

- [ ] **Step 3: Run both suites**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-matrix.test.ts src/__tests__/provider-resolution-overlay-keys.test.ts`
Expected: PASS (all matrix + leakage + drift cases).

- [ ] **Step 4: Full server typecheck + suite**

Run: `pnpm --filter @armyofagents/server typecheck && pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-*.test.ts src/__tests__/provider-connections-*.test.ts`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/provider-resolution-matrix.test.ts server/src/__tests__/provider-resolution-overlay-keys.test.ts
git commit -m "test(resolver): precedence + credential-leakage + overlay-key drift matrix"
```

---

## Task 16: Resolver kill-switch (`AOA_PROVIDER_RESOLVER=legacy`) — dark-launch insurance

**Files:**
- Modify: `server/src/services/provider-resolution.ts` (ResolveDeps + resolveProviderCredential)
- Modify: `server/src/services/provider-resolution-deps.ts` (read env)
- Test: `server/src/__tests__/provider-resolution-killswitch.test.ts`

> **Why:** reversibility insurance. If the new model misbehaves in production, set `AOA_PROVIDER_RESOLVER=legacy` and every run resolves exactly as it does today (legacy ladder only) with no redeploy — Step 0 agent-override and Step 4 legacy/host-fallback are untouched; only the new-model candidate read (Steps 1-3) is skipped.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/provider-resolution-killswitch.test.ts
import { describe, it, expect, vi } from "vitest";
vi.mock("@armyofagents/db", () => ({ providerConnections: {}, providerAssignments: {}, companyMemberships: {} }));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => ({ and: a }), eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  or: (...a: unknown[]) => ({ or: a }), isNull: (a: unknown) => ({ isNull: a }),
}));
import { resolveProviderCredential } from "../services/provider-resolution.js";

const args = {
  organizationId: null, companyId: "co1", agentId: "ag1", actorKind: "crew" as const,
  adapterType: "claude_local", provider: "anthropic", executionTargetId: "control-plane",
  currentEnv: {} as Record<string, string>,
  context: { consumerType: "agent" as const, consumerId: "ag1", actorType: "agent" as const, actorId: "ag1" },
};

describe("AOA_PROVIDER_RESOLVER=legacy kill-switch", () => {
  it("bypasses the new-model candidate read and resolves via the legacy ladder", async () => {
    const loadCandidateRows = vi.fn(async () => [{ /* would-win connection */ }] as never);
    const r = await resolveProviderCredential({} as never, args, {
      loadCandidateRows,
      resolveSecretValueForConnection: vi.fn(async () => "sk-conn"),
      resolveSubscriptionEnv: vi.fn(async () => ({})),
      envVarForProvider: () => "ANTHROPIC_API_KEY",
      legacyResolveConfig: vi.fn(async () => ({ env: { ANTHROPIC_API_KEY: "sk-legacy" } })),
      legacySubscriptionEnv: vi.fn(async () => null),
      selfHostedSingleTenant: true,
      bypassNewModel: true,
    } as never);
    expect(loadCandidateRows).not.toHaveBeenCalled();
    expect(r.source).toBe("legacy");
    if (r.source === "legacy") expect(r.envPatch).toEqual({ ANTHROPIC_API_KEY: "sk-legacy" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-killswitch.test.ts`
Expected: FAIL — `bypassNewModel` is not honored (candidate rows are still loaded).

- [ ] **Step 3: Write minimal implementation**

In `provider-resolution.ts`, add to the `ResolveDeps` interface:

```ts
  /** AOA_PROVIDER_RESOLVER=legacy → skip the new-model read (Steps 1-3). */
  bypassNewModel: boolean;
```

In `resolveProviderCredential`, replace the Step-1 load line so the kill-switch short-circuits to the legacy tail (Step 0 still runs first):

```ts
  // Step 1 — assignment lookup (new model), UNLESS the kill-switch is set.
  const rows = deps.bypassNewModel ? [] : await deps.loadCandidateRows(db, args);
  const ordered = orderCandidates(rows);
```

In `provider-resolution-deps.ts`, set the flag from env inside `buildResolveDeps`:

```ts
    bypassNewModel: (process.env.AOA_PROVIDER_RESOLVER?.trim().toLowerCase() ?? "") === "legacy",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/provider-resolution-killswitch.test.ts`
Expected: PASS (`loadCandidateRows` not called; `source==="legacy"`).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/provider-resolution.ts server/src/services/provider-resolution-deps.ts server/src/__tests__/provider-resolution-killswitch.test.ts
git commit -m "feat(resolver): AOA_PROVIDER_RESOLVER=legacy kill-switch (dark-launch insurance)"
```

---

## Self-Review

**Spec coverage:** ① schema w/ organization_id FK + CHECK + nullsNotDistinct (T1-2) ✔; ② shared taxonomy (3 beta methods) incl. SHAREABLE + gateway tokenEnvVar allowlist (T3) ✔; ③ materializeEnvPatch — api_key/gateway/subscription only (T4) ✔; ④ precedence (T5) ✔; ⑤ fail-closed gates incl. non-shareable-default + honest owner_only (T6) ✔; ⑥ resolver dual-read + legacy fallback + multi-tenant THROW + candidateMatchesScope (T7-8) ✔; ⑦ cloud_auth subscription BOOT invariant + rotate + revoke+home-wipe (T9) ✔; ⑧ routes w/ async assertCompanyAccess (T10) ✔; ⑨ Crew/heartbeat/Commander wiring to ONE resolver + wired P4→P5 hint (T11-13) ✔; ⑩ #310 merge note (T13) ✔; ⑪ idempotent backfill w/ skip/error counts + DB idempotency tests (T14) ✔; ⑫ precedence + leakage + cross-tenant M1 + business-key-inherits matrix (T15) ✔; ⑬ resolver kill-switch (T16) ✔.

**Eng-review fixes applied:** SCOPE CUT bedrock/vertex → ambient passthrough (note only); B6 P4→P5 seam wired (`p4CredentialHint`, T12); M1 cross-tenant org_default leak closed (`candidateMatchesScope` strict-equality + SQL org predicate + negative test, T7/T8/T15); M2 owner_only tautology documented honestly + backed by BOOT invariant (T6/T9); M4 backfill per-item isolation + isNotNull pre-filter + `{inserted,skipped,errors}` + DB tests (T14); M9 legacy-fallback test made consistent (T7); M6 org_id FK now real (T1); kill-switch added (T16).

**Placeholder scan:** `runProviderConnectionsBackfill` now has a full DB body; the integration test names the seed helpers (`withTestDb`/`seedCompany`/… per the repo's existing `*.integration.test.ts` harness). Heartbeat legacy-source closures are fully specified. No "TBD"/"add error handling"/vague steps remain.

**Type consistency:** `ResolvedProviderCredential` union, `Candidate`/`CandidateRow` (incl. `connectionOrganizationId`), `GateInput`, `ResolveArgs`/`ResolveDeps` (incl. `bypassNewModel`), `materializeEnvPatch` input, `applyResolvedCredential`, `candidateMatchesScope`, `toExecutionTargetHint`, `AUTH_METHODS`/`SHAREABLE_AUTH_METHODS`/`GATEWAY_TOKEN_ENV_ALLOWLIST` are used identically across T3-T16.

## Cross-phase + back-compat notes

- **P1 (Organization):** P1 is merged first, so `provider_connections.organization_id` FKs `organizations` NOW (`onDelete: "restrict"`, Task 1). `org_default`/`org_agents` resolution stays inert at runtime until the call-sites thread the company's real `organization_id` into the resolver (today they pass `null`, which `candidateMatchesScope` fails closed on — M1). RLS predicates on these tables are added with the rest of the app-layer RLS (P1 context).
- **P5 (execution_targets):** `execution_target_id` stays a soft `text` ref; `personal_execution_default.scopeId=ownerUserId` is the pre-P5 proxy. FK-ify at P5 merge. **P4→P5 seam:** P5 Task 9 consumes the resolver's `toExecutionTargetHint(resolved) → { credentialKind, executionTargetSlug }` (defined in `server/src/services/provider-resolution.ts`, Task 7) instead of reading `provider_credentials` directly. `api_key`/`enterprise_gateway` → `"company_api_key"`; `personal_subscription` → itself; `connection.executionTargetId` → `executionTargetSlug`. P5 also rebases its heartbeat "dedicated-target throw replacement" onto this phase's post-delete `legacySubscriptionEnv` closure (Task 12b note).
- **#310:** owner_only sharingPolicy is the reconciliation seam for `subscription_commander_only` (T13 comment).
- **Self-hosted single-tenant preserved:** Step 0 (agent env) + Step 4 (legacy fallback → host_login_fallback) reproduce today's behavior when zero connections exist.
- **STRANGLER:** legacy `company_secrets` + `provider_credentials`/`agent_provider_credential_bindings` stay populated (dual-write via backfill + unchanged existing write paths); resolver dual-reads; legacy-path removal is a LATER follow-up, NOT this PR.

## Execution Handoff

Plan complete and saved. Two execution options: (1) Subagent-Driven (recommended) — fresh subagent per task, two-stage review between tasks; (2) Inline Execution — batch with checkpoints. Choose before implementing.
