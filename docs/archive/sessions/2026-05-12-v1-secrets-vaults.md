# feat/v1-secrets-vaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement D10 provider-backed company secrets: AWS Secrets Manager vault config, remote import, binding records, access audit trail, and a first-class Secrets UI while keeping GCP Secret Manager and HashiCorp Vault as explicit stubs.

**Architecture:** Extend the existing `company_secrets` / `company_secret_versions` local-encrypted service into a provider-vault control plane. Company-scoped provider configs select a vault, secret rows point at provider configs, binding rows record which config paths are allowed to resolve each secret, and every runtime read writes a `secret_access_events` audit row. AWS Secrets Manager becomes the only real external provider for v1.0, using the AWS SDK default credential chain plus SigV4 Secrets Manager requests; CI uses mocks and never calls real AWS.

**Tech Stack:** Drizzle ORM | Express 5 routes | Zod validators | Vitest + embedded-postgres integration tests | React 19 + TanStack Query | Tailwind v4 + project design-guide components | `@aws-sdk/client-secrets-manager` in `server/package.json`

**Integration branch:** `v1-upgrade`; this plan branch is `feat/v1-secrets-vaults`.

**Migration slots:** `0092_*` for `company_secret_provider_configs`; `0093_*` for `company_secret_bindings` + `secret_access_events`. If `v1-upgrade` does not already contain migrations `0088` through `0091`, rebase/regenerate after those land and keep these logical slots intact.

**Source references:**
- Upstream commit `778e775c` (`Add secrets provider vaults and remote import`) is the implementation model.
- AoA baseline currently has only `local_encrypted` as production-ready; `server/src/secrets/external-stub-providers.ts` throws for `aws_secrets_manager`, `gcp_secret_manager`, and `vault`.
- `memory/project_v1_to_v2_roadmap.md` was requested but is absent in this worktree. The D10 scope is recovered from `docs/archive/sessions/2026-05-11-v1-upgrade-master.md`, the upstream commit stat, and current AoA code.

---

## Current State

- Branch before this plan: `v1-upgrade`, behind `origin/v1-upgrade` by 15 commits, with unrelated local/untracked files. Do not revert them.
- Created branch: `feat/v1-secrets-vaults` from local `v1-upgrade`.
- Existing secrets API:
  - `GET /api/companies/:companyId/secret-providers`
  - `GET /api/companies/:companyId/secrets`
  - `POST /api/companies/:companyId/secrets`
  - `POST /api/secrets/:id/rotate`
  - `PATCH /api/secrets/:id`
  - `DELETE /api/secrets/:id`
- Existing secret service resolves plaintext via `secretService.resolveSecretValue(companyId, secretId, version)` with no binding check and no access-event audit table.
- Existing UI has reusable env secret selectors in agent/project config, but no dedicated Secrets page.
- `server/package.json` already includes `@aws-sdk/client-s3`; add `@aws-sdk/client-secrets-manager` for D10 and regenerate `pnpm-lock.yaml` in the same PR per AGENTS.md section 7.

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `server/package.json` | Add `@aws-sdk/client-secrets-manager` |
| Modify | `pnpm-lock.yaml` | Lock dependency in same PR as manifest |
| Create | `packages/db/src/schema/company_secret_provider_configs.ts` | Provider vault config table |
| Create | `packages/db/src/schema/company_secret_bindings.ts` | Secret-to-consumer binding table |
| Create | `packages/db/src/schema/secret_access_events.ts` | Runtime read audit table |
| Modify | `packages/db/src/schema/company_secrets.ts` | Add `key`, `status`, `managedMode`, `providerConfigId`, provider metadata, timestamps |
| Modify | `packages/db/src/schema/company_secret_versions.ts` | Add provider version ref, version status, fingerprint field |
| Modify | `packages/db/src/schema/index.ts` | Export new tables |
| Generate | `packages/db/src/migrations/0092_*.sql` | Drizzle-generated provider config migration |
| Generate | `packages/db/src/migrations/0093_*.sql` | Drizzle-generated bindings + access-events migration |
| Modify | `packages/shared/src/constants.ts` | Secret provider config, status, mode, binding, and access outcome constants |
| Modify | `packages/shared/src/types/secrets.ts` | New public secret/vault/import/audit types |
| Modify | `packages/shared/src/validators/secret.ts` | Provider config, binding, remote import validators |
| Modify | `packages/shared/src/index.ts` and `packages/shared/src/validators/index.ts` | Exports |
| Create | `server/src/secrets/aws-secrets-manager-provider.ts` | Real AWS provider |
| Modify | `server/src/secrets/external-stub-providers.ts` | Keep GCP/Vault stubs, remove AWS stub |
| Modify | `server/src/secrets/provider-registry.ts` | Register AWS provider and provider checks |
| Modify | `server/src/secrets/types.ts` | Provider config, import, health, and cleanup interfaces |
| Modify | `server/src/services/secrets.ts` | Provider config CRUD, bindings, import, audit-on-read |
| Modify | `server/src/routes/secrets.ts` | Vault config, binding, import, access-event routes |
| Modify | `server/src/routes/agents.ts`, `server/src/routes/projects.ts`, `server/src/routes/environments.ts`, `server/src/routes/routines.ts` | Sync bindings when env refs change |
| Modify | `server/src/services/heartbeat.ts`, `server/src/services/plugin-secrets-handler.ts`, `server/src/services/routines.ts`, `server/src/routes/github.ts`, `server/src/routes/workspace-git.ts`, `server/src/adapters/api-common.ts`, `server/src/services/internal-agent/providers/index.ts` | Pass consumer context into secret resolution |
| Modify | `ui/src/api/secrets.ts` | New vault/import/binding/audit client methods |
| Modify | `ui/src/lib/queryKeys.ts` | Query keys for vaults, import preview, events |
| Create | `ui/src/pages/Secrets.tsx` | Main Secrets page |
| Create | `ui/src/pages/secrets/ImportFromVaultDialog.tsx` | Remote import dialog |
| Create | `ui/src/components/SecretBindingPicker.tsx` | Reusable bound secret picker |
| Modify | `ui/src/App.tsx`, `ui/src/components/Sidebar.tsx`, `ui/src/components/MobileBottomNav.tsx` | Register Secrets route/nav |
| Modify | `ui/src/pages/DesignGuide.tsx` and `ui/src/components/*` references if reusable components are added | Design-guide showcase and index updates |
| Create/Modify | `server/src/__tests__/*secrets*.test.ts`, `packages/shared/src/validators/secret.test.ts`, `ui/src/pages/Secrets*.test.tsx`, `ui/src/pages/secrets/ImportFromVaultDialog.test.tsx`, `tests/e2e/secrets-vaults.spec.ts` | Coverage |

---

## Execution Split

Sessions 9-10 should execute this plan in two PR-sized chunks on the same sub-branch:

1. **Session 9: Backend + AWS provider**
   - Tasks 1-13.
   - Ends with schema, shared contracts, server routes/services, AWS mocks, and backend tests passing.

2. **Session 10: UI + e2e + polish**
   - Tasks 14-25.
   - Ends with Secrets page, import dialog, binding picker, e2e flow, docs, full verification, and code review fixes.

---

## Task 1: Dependency Manifest

**Files:**
- Modify: `server/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add AWS Secrets Manager SDK**

In `server/package.json`, add the dependency next to the existing AWS SDK entry:

```json
"@aws-sdk/client-s3": "^3.888.0",
"@aws-sdk/client-secrets-manager": "^3.888.0",
```

- [ ] **Step 2: Regenerate lockfile**

Run:

```bash
pnpm install --no-frozen-lockfile
pnpm install --frozen-lockfile
```

Expected: both commands complete successfully. The PR may include `pnpm-lock.yaml` because the manifest changed in the same PR.

- [ ] **Step 3: Commit**

```bash
git add server/package.json pnpm-lock.yaml
git commit -m "feat(secrets): add aws secrets manager dependency"
```

---

## Task 2: Schema Foundation, Migration 0092

**Files:**
- Create: `packages/db/src/schema/company_secret_provider_configs.ts`
- Modify: `packages/db/src/schema/index.ts`
- Generate: `packages/db/src/migrations/0092_*.sql`

- [ ] **Step 0: Verify migration precondition**

Run:

```bash
ls packages/db/src/migrations | tail -n 8
```

Expected before editing schema: migrations `0090_*` and `0091_*` are already present on the branch. If the latest migration is lower than `0091`, stop this task and rebase/merge the prerequisite D4/D3 branches into `v1-upgrade`; generating now would allocate the wrong numbers.

- [ ] **Step 1: Create provider config schema**

```ts
import { sql } from "drizzle-orm";
import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";

export const companySecretProviderConfigs = pgTable(
  "company_secret_provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("ready"),
    isDefault: boolean("is_default").notNull().default(false),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    healthStatus: text("health_status"),
    healthCheckedAt: timestamp("health_checked_at", { withTimezone: true }),
    healthMessage: text("health_message"),
    healthDetails: jsonb("health_details").$type<Record<string, unknown>>(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_secret_provider_configs_company_idx").on(table.companyId),
    companyProviderIdx: index("company_secret_provider_configs_company_provider_idx").on(table.companyId, table.provider),
    defaultPerProviderUq: uniqueIndex("company_secret_provider_configs_default_uq")
      .on(table.companyId, table.provider)
      .where(sql`${table.isDefault} = true`),
  }),
);
```

- [ ] **Step 2: Export the table**

Add to `packages/db/src/schema/index.ts`:

```ts
export { companySecretProviderConfigs } from "./company_secret_provider_configs.js";
```

- [ ] **Step 3: Generate migration**

```bash
pnpm db:generate
```

Expected: generated file is `packages/db/src/migrations/0092_<name>.sql`. Do not hand-edit it.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/company_secret_provider_configs.ts packages/db/src/schema/index.ts packages/db/src/migrations packages/db/src/migrations/meta
git commit -m "feat(secrets): add provider vault config schema"
```

---

## Task 3: Schema Bindings, Audit Trail, and Secret Metadata, Migration 0093

**Files:**
- Create: `packages/db/src/schema/company_secret_bindings.ts`
- Create: `packages/db/src/schema/secret_access_events.ts`
- Modify: `packages/db/src/schema/company_secrets.ts`
- Modify: `packages/db/src/schema/company_secret_versions.ts`
- Modify: `packages/db/src/schema/index.ts`
- Generate: `packages/db/src/migrations/0093_*.sql`

- [ ] **Step 1: Create binding schema**

```ts
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";

export const companySecretBindings = pgTable(
  "company_secret_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    configPath: text("config_path").notNull(),
    versionSelector: text("version_selector").notNull().default("latest"),
    required: boolean("required").notNull().default(true),
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("company_secret_bindings_company_idx").on(table.companyId),
    secretIdx: index("company_secret_bindings_secret_idx").on(table.secretId),
    targetIdx: index("company_secret_bindings_target_idx").on(table.companyId, table.targetType, table.targetId),
    targetPathUq: uniqueIndex("company_secret_bindings_target_path_uq").on(
      table.companyId,
      table.targetType,
      table.targetId,
      table.configPath,
    ),
  }),
);
```

- [ ] **Step 2: Create access-event schema**

```ts
import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { plugins } from "./plugins.js";

export const secretAccessEvents = pgTable(
  "secret_access_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    secretId: uuid("secret_id").notNull().references(() => companySecrets.id, { onDelete: "cascade" }),
    version: integer("version"),
    provider: text("provider").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    consumerType: text("consumer_type").notNull(),
    consumerId: text("consumer_id").notNull(),
    configPath: text("config_path"),
    issueId: uuid("issue_id").references(() => issues.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    pluginId: uuid("plugin_id").references(() => plugins.id, { onDelete: "set null" }),
    outcome: text("outcome").notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyCreatedIdx: index("secret_access_events_company_created_idx").on(table.companyId, table.createdAt),
    secretCreatedIdx: index("secret_access_events_secret_created_idx").on(table.secretId, table.createdAt),
    consumerIdx: index("secret_access_events_consumer_idx").on(table.companyId, table.consumerType, table.consumerId),
    runIdx: index("secret_access_events_run_idx").on(table.heartbeatRunId),
  }),
);
```

- [ ] **Step 3: Extend `company_secrets`**

Add imports:

```ts
import { jsonb } from "drizzle-orm/pg-core";
import { companySecretProviderConfigs } from "./company_secret_provider_configs.js";
```

Add fields after `name` / provider metadata near the existing provider fields:

```ts
    key: text("key"),
    status: text("status").notNull().default("active"),
    managedMode: text("managed_mode").notNull().default("aoa_managed"),
    providerConfigId: uuid("provider_config_id").references(() => companySecretProviderConfigs.id, { onDelete: "set null" }),
    providerMetadata: jsonb("provider_metadata").$type<Record<string, unknown>>(),
    lastResolvedAt: timestamp("last_resolved_at", { withTimezone: true }),
    lastRotatedAt: timestamp("last_rotated_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
```

Replace the unique name index with a status-aware index only if Drizzle generates a clean migration from the current schema. If not, keep the existing unique `(companyId, name)` index for this branch and plan soft-deleted-name reuse as a follow-up, because D10 does not require deleted-name reuse.

- [ ] **Step 4: Extend `company_secret_versions`**

Add fields:

```ts
    providerVersionRef: text("provider_version_ref"),
    status: text("status").notNull().default("current"),
    fingerprintSha256: text("fingerprint_sha256"),
    rotationJobId: text("rotation_job_id"),
```

Keep `valueSha256` during the first pass for backward compatibility. Add service-level writes that set both `valueSha256` and `fingerprintSha256` for locally managed values.

- [ ] **Step 5: Export new tables**

```ts
export { companySecretBindings } from "./company_secret_bindings.js";
export { secretAccessEvents } from "./secret_access_events.js";
```

- [ ] **Step 6: Generate migration**

```bash
pnpm db:generate
```

Expected: generated file is `packages/db/src/migrations/0093_<name>.sql`. Do not hand-edit it.

- [ ] **Step 7: Add a schema integration test**

Create or extend `server/src/__tests__/secrets-schema-integration.test.ts` using the embedded-postgres pattern from `server/src/__tests__/companies-delete-integration.test.ts`. Assert:

```ts
expect(providerConfig.companyId).toBe(company.id);
expect(binding.configPath).toBe("env.OPENAI_API_KEY");
expect(accessEvent.outcome).toBe("success");
```

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema packages/db/src/migrations packages/db/src/migrations/meta server/src/__tests__/secrets-schema-integration.test.ts
git commit -m "feat(secrets): add bindings and access audit schema"
```

---

## Task 4: Shared Contracts

**Files:**
- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/src/types/secrets.ts`
- Modify: `packages/shared/src/validators/secret.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/validators/index.ts`
- Test: `packages/shared/src/validators/secret.test.ts`

- [ ] **Step 1: Add constants**

```ts
export const SECRET_PROVIDER_CONFIG_STATUSES = ["ready", "warning", "coming_soon", "disabled"] as const;
export type SecretProviderConfigStatus = (typeof SECRET_PROVIDER_CONFIG_STATUSES)[number];

export const SECRET_PROVIDER_CONFIG_HEALTH_STATUSES = ["ready", "warning", "error", "coming_soon", "disabled"] as const;
export type SecretProviderConfigHealthStatus = (typeof SECRET_PROVIDER_CONFIG_HEALTH_STATUSES)[number];

export const SECRET_STATUSES = ["active", "disabled", "archived", "deleted"] as const;
export type SecretStatus = (typeof SECRET_STATUSES)[number];

export const SECRET_MANAGED_MODES = ["aoa_managed", "external_reference"] as const;
export type SecretManagedMode = (typeof SECRET_MANAGED_MODES)[number];

export const SECRET_VERSION_STATUSES = ["current", "previous", "disabled", "destroyed"] as const;
export type SecretVersionStatus = (typeof SECRET_VERSION_STATUSES)[number];

export const SECRET_BINDING_TARGET_TYPES = ["agent", "project", "environment", "routine", "system", "plugin", "issue", "run"] as const;
export type SecretBindingTargetType = (typeof SECRET_BINDING_TARGET_TYPES)[number];

export const SECRET_ACCESS_OUTCOMES = ["success", "failure"] as const;
export type SecretAccessOutcome = (typeof SECRET_ACCESS_OUTCOMES)[number];
```

Use `aoa_managed` for new rows and map any legacy upstream managed-mode token at the service boundary to avoid brand-check regressions.

- [ ] **Step 2: Add types**

Add interfaces for:

```ts
CompanySecretProviderConfig
SecretProviderConfigHealthResponse
CompanySecretBinding
CompanySecretUsageBinding
SecretAccessEvent
RemoteSecretImportCandidate
RemoteSecretImportPreviewResult
RemoteSecretImportResult
```

Keep `CompanySecret.name` for current AoA callers and add nullable `key`, `status`, `managedMode`, `providerConfigId`, `providerMetadata`, `lastResolvedAt`, `lastRotatedAt`, and `deletedAt`.

- [ ] **Step 3: Add validators**

Create these schemas:

```ts
export const createSecretProviderConfigSchema = z.object({
  provider: z.enum(SECRET_PROVIDERS),
  displayName: z.string().min(1),
  status: z.enum(SECRET_PROVIDER_CONFIG_STATUSES).optional(),
  isDefault: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
});

export const updateSecretProviderConfigSchema = createSecretProviderConfigSchema.partial().omit({ provider: true });

export const createSecretBindingSchema = z.object({
  secretId: z.string().uuid(),
  targetType: z.enum(SECRET_BINDING_TARGET_TYPES),
  targetId: z.string().min(1),
  configPath: z.string().min(1),
  versionSelector: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
  required: z.boolean().optional(),
  label: z.string().optional().nullable(),
});

export const remoteSecretImportPreviewSchema = z.object({
  providerConfigId: z.string().uuid(),
  query: z.string().optional().nullable(),
  nextToken: z.string().optional().nullable(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

export const remoteSecretImportCommitSchema = z.object({
  providerConfigId: z.string().uuid(),
  secrets: z.array(z.object({
    externalRef: z.string().min(1),
    name: z.string().optional().nullable(),
    key: z.string().optional().nullable(),
    providerVersionRef: z.string().optional().nullable(),
    description: z.string().optional().nullable(),
  })).min(1),
});
```

- [ ] **Step 4: Validate AWS config payload**

Add `secretProviderConfigPayloadSchema` so AWS requires `region` and accepts `namespace`, `secretNamePrefix`, `kmsKeyId`, `ownerTag`, `environmentTag`. GCP and Vault payloads parse but route as `coming_soon`.

- [ ] **Step 5: Add tests**

Add validator tests that assert:

```ts
expect(createSecretProviderConfigSchema.parse({
  provider: "aws_secrets_manager",
  displayName: "Production AWS",
  config: { region: "us-east-1", secretNamePrefix: "aoa/prod" },
}).provider).toBe("aws_secrets_manager");

expect(() => remoteSecretImportPreviewSchema.parse({ providerConfigId: "nope" })).toThrow();
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/types/secrets.ts packages/shared/src/validators/secret.ts packages/shared/src/index.ts packages/shared/src/validators/index.ts packages/shared/src/validators/secret.test.ts
git commit -m "feat(secrets): define vault contracts"
```

---

## Task 5: Provider Interface Upgrade

**Files:**
- Modify: `server/src/secrets/types.ts`
- Modify: `server/src/secrets/provider-registry.ts`
- Modify: `server/src/secrets/local-encrypted-provider.ts`
- Modify: `server/src/secrets/external-stub-providers.ts`
- Test: `server/src/__tests__/secret-provider-registry.test.ts`

- [ ] **Step 1: Expand `SecretProviderModule`**

Add methods and context types:

```ts
export interface SecretProviderVaultRuntimeConfig {
  id: string;
  provider: SecretProvider;
  status: string;
  config: Record<string, unknown>;
}

export interface SecretProviderWriteContext {
  companyId: string;
  secretId?: string;
  secretKey: string;
  secretName: string;
  version: number;
}

export interface PreparedSecretVersion {
  material: StoredSecretVersionMaterial;
  valueSha256: string;
  fingerprintSha256?: string;
  externalRef: string | null;
  providerVersionRef?: string | null;
  providerMetadata?: Record<string, unknown> | null;
}
```

Extend provider methods to accept `providerConfig` and `context`, and add optional methods:

```ts
healthCheck?(...)
listRemoteSecrets?(...)
linkExternalSecret?(...)
deleteOrArchive?(...)
```

- [ ] **Step 2: Keep local provider compatible**

Make `localEncryptedProvider` ignore provider config while returning the same encrypted material. It should set `fingerprintSha256` equal to the existing `valueSha256`.

- [ ] **Step 3: Keep GCP/Vault stubs**

`gcp_secret_manager` and `vault` descriptors must return:

```ts
supportsManagedValues: false,
supportsExternalReferences: false,
configured: false,
```

Their write/read/list methods throw `unprocessable("<provider> provider is not configured in this deployment")`.

- [ ] **Step 4: Add provider checks**

Expose `checkSecretProviders()` from the registry. It should report `local_encrypted` as ready, AWS as configured if a provider config validates, and GCP/Vault as coming soon.

- [ ] **Step 5: Commit**

```bash
git add server/src/secrets/types.ts server/src/secrets/provider-registry.ts server/src/secrets/local-encrypted-provider.ts server/src/secrets/external-stub-providers.ts server/src/__tests__/secret-provider-registry.test.ts
git commit -m "feat(secrets): support configurable provider modules"
```

---

## Task 6: AWS Secrets Manager Provider

**Files:**
- Create: `server/src/secrets/aws-secrets-manager-provider.ts`
- Modify: `server/src/secrets/provider-registry.ts`
- Test: `server/src/__tests__/aws-secrets-manager-provider.test.ts`

- [ ] **Step 1: Port AWS provider with AoA naming**

Use upstream commit `778e775c:server/src/secrets/aws-secrets-manager-provider.ts` as the structural source, but replace user-facing and persisted upstream brand strings:

```ts
const AWS_SECRETS_MANAGER_SCHEME = "aws_secrets_manager_v1";
const DEFAULT_PREFIX = "aoa";
const DEFAULT_OWNER_TAG = "aoa";
const AOA_PENDING_VERSION_STAGE = "AOA_PENDING";
```

Do not introduce upstream brand log prefixes, CSS classes, env vars, persisted managed-mode tokens, or visible upstream brand copy.

- [ ] **Step 2: Use AWS SDK credentials and SigV4 requests**

Implement:

```ts
createSecret
createVersion
resolveVersion
linkExternalSecret
listRemoteSecrets
deleteOrArchive
healthCheck
```

Use `@aws-sdk/client-secrets-manager` request models where practical, and keep the SigV4 signing helper covered by tests. Runtime credentials must come from the AWS SDK default credential provider chain. Do not store AWS bootstrap credentials in `company_secrets`.

- [ ] **Step 3: Guard namespace**

Managed secret names must be derived from:

```ts
<secretNamePrefix>/<companyId>/<secretKey>
```

Reject managed writes when `secretNamePrefix` is missing for AWS configs. For remote import, allow external ARNs/names but canonicalize them before duplicate checks.

- [ ] **Step 4: Sanitize provider errors**

Provider failures returned to routes must expose a stable code and safe message, never request headers, signatures, secret values, or AWS credentials.

- [ ] **Step 5: Mock AWS in tests**

Tests must mock the AWS client/gateway and cover:

```ts
signs Secrets Manager requests with x-amz-target
creates managed secret with AoA tags
resolves AWSCURRENT by externalRef
lists remote secrets with pagination
rejects missing region
rejects missing namespace for managed create
does not include secret material in thrown errors
```

Run:

```bash
pnpm --filter @armyofagents/server exec vitest run src/__tests__/aws-secrets-manager-provider.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add server/src/secrets/aws-secrets-manager-provider.ts server/src/secrets/provider-registry.ts server/src/__tests__/aws-secrets-manager-provider.test.ts
git commit -m "feat(secrets): implement aws secrets manager provider"
```

---

## Task 7: Secret Service Provider Config CRUD

**Files:**
- Modify: `server/src/services/secrets.ts`
- Test: `server/src/__tests__/secrets-service.test.ts`

- [ ] **Step 1: Import new tables and validators**

Add:

```ts
companySecretProviderConfigs,
companySecretBindings,
secretAccessEvents,
createSecretProviderConfigSchema,
updateSecretProviderConfigSchema,
secretProviderConfigPayloadSchema,
```

- [ ] **Step 2: Add provider config helpers**

Implement:

```ts
listProviderConfigs(companyId)
getProviderConfigById(id)
createProviderConfig(companyId, input, actor)
updateProviderConfig(id, patch)
deleteProviderConfig(id)
checkProviderConfig(id)
```

Rules:
- Company-scoped access only.
- `coming_soon` providers cannot be default.
- Setting `isDefault: true` unsets the prior default for the same company + provider inside one transaction.
- Disabled configs set `disabledAt`.
- Config payloads validate through shared Zod schemas.

- [ ] **Step 3: Add tests**

Test:

```ts
it("keeps one default aws vault per company")
it("rejects default coming-soon vault")
it("does not expose vaults across companies")
it("persists health check result")
```

- [ ] **Step 4: Commit**

```bash
git add server/src/services/secrets.ts server/src/__tests__/secrets-service.test.ts
git commit -m "feat(secrets): add provider vault service"
```

---

## Task 8: Secret Service Create, Rotate, Update, Delete Semantics

**Files:**
- Modify: `server/src/services/secrets.ts`
- Test: `server/src/__tests__/secrets-service.test.ts`

- [ ] **Step 1: Support managed and external-reference modes**

Extend create input:

```ts
{
  name: string;
  key?: string | null;
  provider: SecretProvider;
  providerConfigId?: string | null;
  managedMode?: "aoa_managed" | "external_reference";
  value?: string | null;
  externalRef?: string | null;
  providerVersionRef?: string | null;
}
```

Rules:
- `aoa_managed` requires `value`.
- `external_reference` requires `externalRef`.
- Provider config must belong to the same company and provider.
- Secret writes create one `company_secret_versions` row.
- Existing local-encrypted callers continue to work with `{ name, provider, value }`.

- [ ] **Step 2: Support provider config on rotate**

Managed rotation may migrate to a new provider config only through `rotate()`. Generic `PATCH` must not move a managed secret between vaults.

- [ ] **Step 3: Soft-delete external provider material safely**

On delete:
- Mark row `status = "deleted"` and set `deletedAt`.
- Call provider `deleteOrArchive` only when provider config is active.
- Keep hard-delete behavior for local encrypted only if existing tests require it; otherwise soft-delete all secrets and hide deleted rows from list.

- [ ] **Step 4: Add tests**

Test managed create, external import create, provider mismatch rejection, disabled vault rejection, rotate-to-new-vault path, and safe cleanup when DB write fails after remote provider create.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/secrets.ts server/src/__tests__/secrets-service.test.ts
git commit -m "feat(secrets): support provider-backed secret lifecycle"
```

---

## Task 9: Binding Service and Audit-On-Read

**Files:**
- Modify: `server/src/services/secrets.ts`
- Modify: callers listed in File Map
- Test: `server/src/__tests__/secrets-service.test.ts`

- [ ] **Step 1: Add consumer context type**

```ts
type SecretConsumerContext = {
  consumerType: SecretBindingTargetType;
  consumerId: string;
  configPath?: string | null;
  actorType?: "agent" | "user" | "system" | "plugin";
  actorId?: string | null;
  issueId?: string | null;
  heartbeatRunId?: string | null;
  pluginId?: string | null;
};
```

- [ ] **Step 2: Enforce bindings and audit with mandatory context**

`resolveSecretValue(companyId, secretId, version, context)` and `resolveByName(companyId, name, context)` must require a consumer context at the TypeScript boundary. There should be no production no-context secret reads after this task.

Each read must:
- Assert the secret belongs to the company.
- Assert the secret is active.
- If `context.configPath` exists, require a matching `company_secret_bindings` row for company + target + path.
- Record success or failure in `secret_access_events`.
- Update `company_secrets.lastResolvedAt` on success.

- [ ] **Step 3: Add binding methods**

```ts
createBinding(input)
deleteBinding(id)
listBindingsForSecret(companyId, secretId)
listAccessEvents(companyId, secretId)
syncEnvBindingsForTarget(companyId, target, envValue)
resolveEnvBindings(companyId, envValue, context)
```

- [ ] **Step 4: Pass context from runtime callers**

Examples:

```ts
await secretsSvc.resolveEnvBindings(companyId, adapterConfig.env, {
  consumerType: "agent",
  consumerId: agent.id,
  actorType: "agent",
  actorId: agent.id,
  issueId: issue.id,
  heartbeatRunId: run.id,
});
```

For plugin host resolution, pass `consumerType: "plugin"` and `pluginId`. For provider-key reads in `server/src/adapters/api-common.ts` and `server/src/services/internal-agent/providers/index.ts`, pass `consumerType: "system"`, a stable `consumerId` such as `llm-provider:<provider>`, `actorType: "system"`, and `configPath: "provider.<provider>"`.

After updating callers, run:

```bash
rg -n "resolveSecretValue\\(|resolveByName\\(" server/src packages -g "*.ts"
```

Expected: every production call passes context. Tests may use mocks, but no real service call should omit context.

- [ ] **Step 5: Add tests**

Test:

```ts
it("records success access event on resolve")
it("records failure access event when binding is missing")
it("rejects cross-company binding")
it("syncs env secret refs to binding rows")
```

- [ ] **Step 6: Commit**

```bash
git add server/src/services/secrets.ts server/src/services/heartbeat.ts server/src/services/plugin-secrets-handler.ts server/src/services/routines.ts server/src/routes/github.ts server/src/routes/workspace-git.ts server/src/adapters/api-common.ts server/src/services/internal-agent/providers/index.ts server/src/__tests__/secrets-service.test.ts
git commit -m "feat(secrets): audit bound secret resolution"
```

---

## Task 10: Remote Import Service

**Files:**
- Modify: `server/src/services/secrets.ts`
- Test: `server/src/__tests__/secrets-service.test.ts`

- [ ] **Step 1: Add preview**

`previewRemoteImport(companyId, { providerConfigId, query, nextToken, pageSize })` should:
- Load the provider config.
- Call provider `listRemoteSecrets`.
- Call provider `linkExternalSecret` for each candidate to canonicalize refs.
- Return `ready`, `duplicate`, or `conflict` candidates.

- [ ] **Step 2: Add commit**

`importRemoteSecrets(companyId, { providerConfigId, secrets }, actor)` should:
- Link each external secret without reading plaintext.
- Insert `company_secrets` with `managedMode = "external_reference"` and no stored secret value.
- Insert a version row with provider material and `providerVersionRef`.
- Return per-row `imported`, `skipped`, or `error`.

- [ ] **Step 3: Add duplicate maps**

Prevent duplicates by provider config + canonical external ref, by name, and by key within non-deleted company secrets.

- [ ] **Step 4: Add tests**

Test import preview conflicts, successful multi-row import, per-row error isolation, and no plaintext read during import.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/secrets.ts server/src/__tests__/secrets-service.test.ts
git commit -m "feat(secrets): add remote vault import service"
```

---

## Task 11: Secrets Routes

**Files:**
- Modify: `server/src/routes/secrets.ts`
- Test: `server/src/__tests__/secrets-routes.test.ts`

- [ ] **Step 1: Add provider config routes**

```http
GET    /api/companies/:companyId/secret-provider-configs
POST   /api/companies/:companyId/secret-provider-configs
PATCH  /api/secret-provider-configs/:id
DELETE /api/secret-provider-configs/:id
POST   /api/secret-provider-configs/:id/check
```

- [ ] **Step 2: Add binding and audit routes**

```http
GET    /api/secrets/:id/bindings
POST   /api/secrets/:id/bindings
DELETE /api/secret-bindings/:id
GET    /api/secrets/:id/access-events
```

- [ ] **Step 3: Add remote import routes**

```http
POST /api/companies/:companyId/secrets/remote-import/preview
POST /api/companies/:companyId/secrets/remote-import
```

- [ ] **Step 4: Keep auth rules strict**

Every company-prefixed route:
- `assertBoard(req)`
- `assertCompanyAccess(req, companyId)`
- returns `400/401/403/404/409/422/500` consistently via existing error helpers.
- logs activity for mutating actions: provider config create/update/delete/check, binding create/delete, import.

Every id-only route must be row-first:

```ts
const existing = await svc.getProviderConfigById(id);
if (!existing) throw notFound("Provider vault not found");
assertCompanyAccess(req, existing.companyId);
```

Use the same pattern for:
- `PATCH /api/secret-provider-configs/:id`
- `DELETE /api/secret-provider-configs/:id`
- `POST /api/secret-provider-configs/:id/check`
- `GET /api/secrets/:id/bindings`
- `POST /api/secrets/:id/bindings`
- `GET /api/secrets/:id/access-events`
- `DELETE /api/secret-bindings/:id`

For `DELETE /api/secret-bindings/:id`, look up the binding first, derive `companyId` from the binding row, then assert access before deleting. Do not trust a client-provided company id for id-only routes.

- [ ] **Step 5: Add route tests**

Use existing route test patterns and assert cross-company 403/422, imported row response shape, and activity logging.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/secrets.ts server/src/__tests__/secrets-routes.test.ts
git commit -m "feat(secrets): expose vault and import routes"
```

---

## Task 12: Binding Sync in Existing Mutations

**Files:**
- Modify: `server/src/routes/agents.ts`
- Modify: `server/src/routes/projects.ts`
- Modify: `server/src/routes/environments.ts` if present after D3 lands
- Modify: `server/src/routes/routines.ts`
- Test: related route/service tests

- [ ] **Step 1: Sync agent env refs**

After agent create/update normalizes `adapterConfig.env`, call:

```ts
await secretsSvc.syncEnvBindingsForTarget(companyId, {
  targetType: "agent",
  targetId: agent.id,
  pathPrefix: "env",
}, normalized.adapterConfig.env);
```

- [ ] **Step 2: Sync project/environment/routine env refs**

Apply the same pattern with `targetType: "project"`, `targetType: "environment"`, and `targetType: "routine"` where those config maps are stored.

- [ ] **Step 3: Add tests**

For each touched mutation, assert changing env from secret-ref to plain deletes stale binding rows.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/agents.ts server/src/routes/projects.ts server/src/routes/routines.ts server/src/__tests__
git ls-files --error-unmatch server/src/routes/environments.ts >/dev/null 2>&1 && git add server/src/routes/environments.ts
git commit -m "feat(secrets): sync bindings from env references"
```

---

## Task 13: Backend Verification Gate

**Files:** no source changes unless tests expose failures.

- [ ] **Step 1: Run targeted backend tests**

```bash
pnpm --filter @armyofagents/shared exec vitest run src/validators/secret.test.ts
pnpm --filter @armyofagents/server exec vitest run src/__tests__/aws-secrets-manager-provider.test.ts src/__tests__/secret-provider-registry.test.ts src/__tests__/secrets-service.test.ts src/__tests__/secrets-routes.test.ts src/__tests__/secrets-schema-integration.test.ts
```

Expected: all targeted tests pass.

- [ ] **Step 2: Run backend typecheck**

```bash
pnpm --filter @armyofagents/server typecheck
pnpm --filter @armyofagents/shared typecheck
```

Expected: both pass.

- [ ] **Step 3: Commit fixes if needed**

```bash
git add <changed-files>
git commit -m "fix(secrets): stabilize backend vault tests"
```

---

## Task 14: API Client and Query Keys

**Files:**
- Modify: `ui/src/api/secrets.ts`
- Modify: `ui/src/lib/queryKeys.ts`
- Test: compile through UI tests

- [ ] **Step 1: Add API methods**

```ts
providerConfigs: {
  list(companyId)
  create(companyId, data)
  update(id, data)
  remove(id)
  check(id)
}
bindings: {
  list(secretId)
  create(secretId, data)
  remove(id)
}
accessEvents(secretId)
remoteImport: {
  preview(companyId, data)
  commit(companyId, data)
}
```

- [ ] **Step 2: Add query keys**

```ts
secrets: {
  list: (companyId: string) => ["secrets", companyId] as const,
  providers: (companyId: string) => ["secret-providers", companyId] as const,
  providerConfigs: (companyId: string) => ["secret-provider-configs", companyId] as const,
  bindings: (secretId: string) => ["secret-bindings", secretId] as const,
  accessEvents: (secretId: string) => ["secret-access-events", secretId] as const,
}
```

- [ ] **Step 3: Commit**

```bash
git add ui/src/api/secrets.ts ui/src/lib/queryKeys.ts
git commit -m "feat(secrets): add ui vault api client"
```

---

## Task 15: Reusable Secret Binding Picker

**Files:**
- Create: `ui/src/components/SecretBindingPicker.tsx`
- Test: `ui/src/components/SecretBindingPicker.test.tsx`

- [ ] **Step 1: Build picker**

Design-guide requirements:
- Use `Button`, `Popover` or existing select primitives, `Badge`, `Input`, and lucide `KeyRound` / `Link` icons.
- Dense rows, `text-sm`, `text-xs text-muted-foreground`, semantic tokens only.
- No explanatory wall text in-app.

Public props:

```ts
type SecretBindingPickerProps = {
  companyId: string;
  value: { type: "secret_ref"; secretId: string; version?: number | "latest" } | null;
  onChange(value: { type: "secret_ref"; secretId: string; version?: number | "latest" } | null): void;
  configPath: string;
  targetType: SecretBindingTargetType;
  targetId: string;
};
```

- [ ] **Step 2: Add tests**

Assert it renders available secrets, selects one, and calls `onChange` with `version: "latest"`.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/SecretBindingPicker.tsx ui/src/components/SecretBindingPicker.test.tsx
git commit -m "feat(secrets): add binding picker"
```

---

## Task 16: Secrets Page Shell

**Files:**
- Create: `ui/src/pages/Secrets.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/components/Sidebar.tsx`
- Modify: `ui/src/components/MobileBottomNav.tsx`
- Test: `ui/src/pages/Secrets.render.test.tsx`

- [ ] **Step 1: Register route**

Add:

```tsx
import { Secrets } from "./pages/Secrets";
...
<Route path="secrets" element={<Secrets />} />
```

- [ ] **Step 2: Add nav item**

Add a top-level Secrets item if the current sidebar already has settings-adjacent operational items. Use lucide `KeyRound`. The visible label is `Secrets`.

- [ ] **Step 3: Build shell**

Page layout:
- Left/top section: provider vault list.
- Main section: secret inventory table.
- Right/secondary section: selected secret details with bindings + access events.

Use dense table/list surfaces, not marketing cards. Follow `design-guide`: page title `text-xl font-bold`, section titles `text-lg font-semibold`, row metadata `text-xs text-muted-foreground`.

- [ ] **Step 4: Add render test**

Mock `secretsApi` and assert:

```ts
expect(screen.getByRole("heading", { name: "Secrets" })).toBeInTheDocument();
expect(screen.getByText("AWS Secrets Manager")).toBeInTheDocument();
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/pages/Secrets.tsx ui/src/App.tsx ui/src/components/Sidebar.tsx ui/src/components/MobileBottomNav.tsx ui/src/pages/Secrets.render.test.tsx
git commit -m "feat(secrets): add secrets page shell"
```

---

## Task 17: Provider Vault UI

**Files:**
- Modify: `ui/src/pages/Secrets.tsx`
- Test: `ui/src/pages/Secrets.test.tsx`

- [ ] **Step 1: Add provider config CRUD UI**

Controls:
- Provider selector: `local_encrypted`, `aws_secrets_manager`, disabled `gcp_secret_manager`, disabled `vault`.
- AWS fields: display name, region, namespace/prefix, KMS key id, owner tag, environment tag, default toggle.
- Actions: Save, Check, Disable, Delete.

- [ ] **Step 2: Status display**

Use existing `StatusBadge` / status-token patterns rather than one-off color classes:
- `ready` maps to the active/succeeded visual treatment.
- `warning` maps to pending/warning treatment.
- `error` maps to failed/error treatment.
- `coming_soon` maps to planned/backlog neutral treatment.
- `disabled` maps to archived/disabled muted treatment.

- [ ] **Step 3: Add tests**

Assert creating an AWS vault posts:

```ts
{
  provider: "aws_secrets_manager",
  displayName: "Production AWS",
  isDefault: true,
  config: { region: "us-east-1", secretNamePrefix: "aoa/prod" }
}
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/Secrets.tsx ui/src/pages/Secrets.test.tsx
git commit -m "feat(secrets): manage provider vaults in ui"
```

---

## Task 18: Secret Inventory UI

**Files:**
- Modify: `ui/src/pages/Secrets.tsx`
- Test: `ui/src/pages/Secrets.test.tsx`

- [ ] **Step 1: Add inventory table**

Columns:
- Name/key
- Provider
- Mode (`AoA managed` or `External reference`)
- Latest version
- Bindings count
- Last resolved
- Status
- Actions

- [ ] **Step 2: Add create/rotate/update/delete flows**

Local encrypted create remains supported. AWS managed create is allowed only when an AWS provider config is selected. Remote import is handled in the dialog task.

- [ ] **Step 3: Add tests**

Assert secret values are never rendered, including mocked values like `sk-live-secret`.

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/Secrets.tsx ui/src/pages/Secrets.test.tsx
git commit -m "feat(secrets): add secret inventory ui"
```

---

## Task 19: Import From Vault Dialog

**Files:**
- Create: `ui/src/pages/secrets/ImportFromVaultDialog.tsx`
- Test: `ui/src/pages/secrets/ImportFromVaultDialog.test.tsx`

- [ ] **Step 1: Build dialog**

Props:

```ts
type ImportFromVaultDialogProps = {
  companyId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  providerConfigs: CompanySecretProviderConfig[];
};
```

Flow:
1. Select AWS provider config.
2. Search/list remote candidates.
3. Show rows with status `ready`, `duplicate`, `conflict`.
4. Allow selecting importable rows.
5. Commit selected rows.
6. Show per-row results.

- [ ] **Step 2: Design constraints**

Use a compact dialog with table rows and checkboxes. Do not include long instructional copy. Use semantic tokens and lucide icons. Keep button text short: `Import`, `Preview`, `Done`.

- [ ] **Step 3: Add tests**

Test preview, select, import commit, conflict disabled state, and pagination next-token behavior.

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/secrets/ImportFromVaultDialog.tsx ui/src/pages/secrets/ImportFromVaultDialog.test.tsx
git commit -m "feat(secrets): add vault import dialog"
```

---

## Task 20: Secret Detail, Bindings, and Audit UI

**Files:**
- Modify: `ui/src/pages/Secrets.tsx`
- Test: `ui/src/pages/Secrets.test.tsx`

- [ ] **Step 1: Add detail panel**

Selected secret detail shows:
- Metadata
- Binding rows grouped by target type
- Access events, newest first
- Empty states for no bindings or no events

- [ ] **Step 2: Add binding actions**

Allow manual binding create/delete for advanced operators:

```ts
{ targetType, targetId, configPath, versionSelector: "latest", required: true, label }
```

- [ ] **Step 3: Add tests**

Assert access events render `success` and `failure`, actor, consumer, and timestamp, but never secret material.

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/Secrets.tsx ui/src/pages/Secrets.test.tsx
git commit -m "feat(secrets): show bindings and audit trail"
```

---

## Task 21: Design Guide Updates

**Files:**
- Modify: `ui/src/pages/DesignGuide.tsx`
- Modify: `.agents/skills/design-guide/references/component-index.md`

- [ ] **Step 1: Add binding picker showcase**

Add a `SecretBindingPicker` section with empty, selected, disabled/loading, and long-name states.

- [ ] **Step 2: Add Secrets composition pattern**

Show a compact provider row, a secret inventory row, and an access-event row. Keep this in the existing design-guide structure.

- [ ] **Step 3: Update component index**

Add `SecretBindingPicker` to `.agents/skills/design-guide/references/component-index.md` with its purpose, props summary, and usage guidance for env/config binding surfaces.

- [ ] **Step 4: Commit**

```bash
git add ui/src/pages/DesignGuide.tsx .agents/skills/design-guide/references/component-index.md
git commit -m "docs(ui): document secrets components"
```

---

## Task 22: UI Verification

**Files:** no source changes unless tests expose failures.

- [ ] **Step 1: Run targeted UI tests**

```bash
pnpm --filter @armyofagents/ui exec vitest run src/components/SecretBindingPicker.test.tsx src/pages/Secrets.render.test.tsx src/pages/Secrets.test.tsx src/pages/secrets/ImportFromVaultDialog.test.tsx
```

Expected: all targeted UI tests pass.

- [ ] **Step 2: Run UI typecheck/build**

```bash
pnpm --filter @armyofagents/ui typecheck
pnpm --filter @armyofagents/ui build
```

Expected: both pass. Vite chunk-size warnings are acceptable if unchanged from baseline.

- [ ] **Step 3: Browser check**

Start the app:

```bash
pnpm dev
```

Open `http://localhost:3100/secrets` or the company-prefixed equivalent. Verify:
- No overlapping text at desktop and mobile widths.
- Provider config form fits without horizontal scroll.
- Dialog rows remain readable on mobile.

- [ ] **Step 4: Commit fixes if needed**

```bash
git add <changed-files>
git commit -m "fix(secrets): polish secrets ui"
```

---

## Task 23: E2E Flow

**Files:**
- Create: `tests/e2e/secrets-vaults.spec.ts`

- [ ] **Step 1: Add e2e spec**

Mock server-side AWS provider behavior through a test-only provider injection/fake gateway before the browser drives the flow. Browser request interception alone is not enough because backend code must never attempt a real AWS call in e2e. The flow:
1. Navigate to Secrets.
2. Create AWS provider config.
3. Open Import from Vault.
4. Preview candidates.
5. Import one candidate.
6. Confirm imported secret appears as external reference.

- [ ] **Step 2: Run e2e spec**

```bash
pnpm test:e2e -- tests/e2e/secrets-vaults.spec.ts
```

Expected: spec passes locally. No real AWS credentials are required.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/secrets-vaults.spec.ts
git commit -m "test(secrets): cover vault import e2e"
```

---

## Task 24: Docs and Brand Check

**Files:**
- Modify: `docs/deploy/secrets.md`
- Modify: `docs/deploy/environment-variables.md`
- Modify: `docs/api/secrets.md`
- Create if useful: `docs/deploy/secrets-aws-provider.md`

- [ ] **Step 1: Update docs**

Docs must state:
- AWS Secrets Manager is supported for provider vaults.
- GCP Secret Manager and Vault remain stubs/coming soon.
- AWS credentials come from deployment/runtime credential chain, not AoA secrets.
- Remote import links external references without reading plaintext during import.
- Every runtime read is audited in `secret_access_events`.

- [ ] **Step 2: Run brand-check preflight**

```bash
bash -lc "awk '/# 1\\. No pcp_ token prefixes/{flag=1} flag{print} /echo \"Brand check passed/{flag=0}' .github/workflows/pr.yml | sed 's/^          //' | bash"
pnpm exec node scripts/check-forbidden-tokens.mjs
```

Expected: both commands pass. Existing allowed upstream migration references must not be touched unless necessary.

- [ ] **Step 3: Commit**

```bash
git add docs/deploy/secrets.md docs/deploy/environment-variables.md docs/api/secrets.md docs/deploy/secrets-aws-provider.md
git commit -m "docs(secrets): document aws vault setup"
```

---

## Task 25: Final Verification and Review

**Files:** no source changes unless verification/review exposes failures.

- [ ] **Step 1: Run full required checks**

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

Expected: all pass. If any cannot be run, record the exact command and reason in the PR/session handoff.

- [ ] **Step 2: Dispatch code review**

Use `superpowers:requesting-code-review` or a dedicated reviewer subagent. Ask it to check:
- Spec coverage against D10 and this plan.
- Drizzle-only migrations, no raw SQL edits.
- Company scoping and RBAC.
- Audit row on every read success/failure.
- AWS tests are mocked; no real AWS calls in CI.
- No brand-check regressions.
- UI design-guide consistency.

- [ ] **Step 3: Fix blockers**

Apply reviewer findings as fixup commits:

```bash
git add <changed-files>
git commit -m "fix(secrets): address review findings"
```

- [ ] **Step 4: Handoff**

Document final verification output and any residual risks in the session closeout.

---

## Backend Test Matrix

| Area | Required tests |
|---|---|
| AWS provider | SigV4 headers, create/rotate/get/list, namespace guardrails, sanitized errors, credential-provider mocking |
| Provider configs | CRUD, one default per provider, disabled/coming-soon rejection, health check persistence |
| Lifecycle | local encrypted backward compatibility, AWS managed create/rotate/delete, external-reference create/import |
| Bindings | create/delete/list, sync from env refs, stale binding cleanup |
| Audit | success row on resolve, failure row on denied/missing binding/provider failure, `lastResolvedAt` update |
| RBAC/company scope | all routes reject cross-company access and unauthenticated agent-style access |
| Migrations | embedded-postgres boot + table insert/select smoke |

---

## UI Test Matrix

| Area | Required tests |
|---|---|
| Secrets page | renders providers, inventory, detail panel, empty states |
| Provider vault form | creates AWS config, disables GCP/Vault, handles check result |
| Import dialog | preview, conflict rows, selection, commit, row-level errors, pagination |
| Binding picker | lists secrets, selects latest, clears selection |
| Audit UI | renders events and never renders secret material |
| Responsive/browser | desktop and mobile visual check through browser after implementation |

---

## Risks and Guardrails

- **Migration ordering:** D10 depends on D3 migration `0091`; regenerate if earlier branches land after this branch starts.
- **AWS credential custody:** Runtime AWS credentials belong in deployment infrastructure; never store root keys or long-lived IAM access keys in AoA secrets.
- **No real AWS in CI:** All AWS provider tests must use mocks or injected gateway/client abstractions.
- **Secret plaintext exposure:** UI, logs, errors, activity details, and test snapshots must not include resolved values.
- **Binding enforcement rollout:** This branch must remove no-context production reads; every real `resolveSecretValue` / `resolveByName` call passes a consumer context so success and failure reads are audited.
- **Brand check:** Use `aoa_managed`, `AOA_PENDING`, `aoa` tags/prefix defaults, and `[aoa]` logs.

---

## Self-Review

**Spec coverage:** Covered schema tables (`company_secret_provider_configs`, `company_secret_bindings`, `secret_access_events`), manifest dependency, real AWS provider, secrets routes, audit logging on reads, Secrets UI + `ImportFromVaultDialog`, design-guide use, mocked AWS tests, RBAC, audit trail, and split into backend/UI sessions.

**Placeholder scan:** No execution step uses blank-marker language, generic error-handling instructions, or unnamed tests. Large provider/UI implementation points reference concrete files, public methods, validation rules, and expected assertions rather than leaving blank decisions.

**Type consistency:** Shared constants, DB fields, server service method names, UI API methods, and test names use the same provider/config/binding/import vocabulary. AoA-specific persisted mode is `aoa_managed`; if implementers choose to stay backward-compatible with existing rows, add a normalization shim that maps missing or legacy upstream mode to `aoa_managed` at the service boundary.

---

## Execution Handoff

Plan complete for `feat/v1-secrets-vaults`.

Recommended execution:

1. **Session 9:** Backend + AWS provider, Tasks 1-13.
2. **Session 10:** UI + e2e + final verification, Tasks 14-25.

Use subagent-driven execution for both sessions, with review after each task cluster and a final code-review pass before merging back to `v1-upgrade`.
