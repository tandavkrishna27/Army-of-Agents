# Provider-credential broker — implementation plan (wiring + tests + deploy)

> REQUIRED SUB-SKILL: superpowers:executing-plans. Substrate (migration 0281 + meta + manifest) is DONE + committed (`2408b9613`). This plan is the resolver wiring, tests, CI, and gated deploy.

**Goal:** route the distributed/isolated run's credential resolution through the 0281 SECURITY DEFINER functions over the `aoa_operator` pool, so it resolves the company key without the (enforced) owner-only table grant — self-hosted/embedded untouched.

**Architecture:** `buildResolveDeps` gains a definer path used only when `trustBoundary === "multi_tenant"` AND a module-level operator handle is set (registered once at boot, read LAZILY per call — the composition-root-port lesson: capturing it at build time would be a no-op for anything built earlier). No call-site threading. Kill-switch `AOA_PROVIDER_RESOLVER=legacy` still bypasses.

**Tech stack:** drizzle `db.execute(sql\`SELECT * FROM public.fn(...)\`)`, mirroring `canary-preflight-evidence.ts` row-shape handling (coerce numeric-as-string; scalar/NULL). Decryption via `getSecretProvider().resolveVersion()` (unchanged, Node).

---

## Task 1 — operator handle registry (deps.ts)

**Files:** Modify `server/src/services/provider-resolution-deps.ts`; Modify `server/src/index.ts`.

- [ ] Add at module top of deps.ts:
```ts
let brokerOperatorDb: import("@armyofagents/db").Db | undefined;
/** Composition root sets the aoa_operator pool once at boot; read LAZILY so ordering is irrelevant. */
export function setProviderCredentialBrokerDb(db: import("@armyofagents/db").Db): void {
  brokerOperatorDb = db;
}
```
- [ ] In `server/src/index.ts`, right after `distributedExecutionDatabases` is opened and non-null (near index.ts:619), call `setProviderCredentialBrokerDb(distributedExecutionDatabases.operatorDb)` (import it). Guarded by the same `if (distributedExecutionDatabases)`.
- [ ] Commit: `feat(provider-resolution): operator-pool registry for the credential broker`.

## Task 2 — Function A path in loadCandidateRows (deps.ts) + unit test

**Files:** Modify deps.ts; Test `server/src/__tests__/provider-resolution-broker.test.ts` (new).

- [ ] In `buildResolveDeps`, compute `const useBroker = topology.trustBoundary === "multi_tenant";` Inside `loadCandidateRows`, when `useBroker && brokerOperatorDb`, replace the direct select with:
```ts
const rows = await brokerOperatorDb.execute(sql`
  SELECT * FROM public.resolve_provider_assignment_candidates(
    ${args.organizationId}::uuid, ${args.companyId}::uuid, ${args.provider}::text)`);
```
map each raw row → `CandidateRow` (coerce: `priority: Number(r.priority)`, `connectionUpdatedAt: r.connection_updated_at ? new Date(r.connection_updated_at as string).getTime() : 0`, `config: (r.config as Record<string,unknown>) ?? {}`, string fields as-is, `secretRef: r.secret_ref`), then the SAME `.filter(candidateMatchesScope)` as today. Else keep the existing drizzle select.
- [ ] Test: with a fake `brokerOperatorDb.execute` returning one company_default raw row, `loadCandidateRows` returns it mapped + scope-filtered; with a fake returning an org-mismatched org_default row, it is filtered out.

## Task 3 — Function B+C path in resolveSecretValueForConnection (deps.ts) + unit test

**Files:** Modify deps.ts; same test file.

- [ ] Add a private `resolveSecretValueViaBroker(operatorDb, args, row)` that reproduces `secrets.ts resolveSecretValue` DB layer using the definers. Sequence (all checks/decryption in Node; audit timing = after decrypt):
```ts
const b = (await operatorDb.execute(sql`SELECT * FROM public.resolve_company_secret_bundle(
  ${args.companyId}::uuid, ${row.secretRef}::uuid, NULL::integer,
  ${args.context.consumerType}::text, ${args.context.consumerId}::text,
  ${`provider_connection.${row.connectionId}`}::text)`)).rows?.[0] ?? (await ...)[0];
// checks mirroring resolveSecretValue (throw SecretCandidateUnavailableError with the SAME codes):
//   !secret_found -> "secret_missing"; secret_is_deleted -> "secret_missing"; company mismatch -> unprocessable;
//   secret_status !== 'active' -> "secret_inactive"; binding enforced (shouldEnforceSecretBinding + configPath)
//   && !binding_found -> "secret_unbound"; !version_found -> "secret_version_missing";
//   provider_config_id set && !provider_config_found -> unprocessable; provider_config_disabled -> "provider_config_disabled".
// then: value = await getSecretProvider(secret_provider).resolveVersion({ material: version_material, externalRef: secret_external_ref, providerConfig, versionSelector: "latest" });
// audit success + touch: operatorDb.execute(record_company_secret_access(..., 'success', NULL));
// on any thrown err: operatorDb.execute(record_company_secret_access(..., 'failure', errorCode(err))); rethrow.
```
Reuse the existing `errorCode`/`SecretCandidateUnavailableError`/`getSecretProvider`/`providerConfigForSecret`-shape from secrets.ts (import or replicate the tiny `SecretProviderVaultRuntimeConfig` shape). `shouldEnforceSecretBinding` import from secrets.ts.
- [ ] In `resolveSecretValueForConnection`, when `useBroker && brokerOperatorDb` → `return resolveSecretValueViaBroker(...)`; else the existing `secrets.resolveSecretValue(...)`.
- [ ] Tests: fake bundle → returns decrypted value + fires a success audit; missing binding → throws `secret_unbound` + fires a failure audit; disabled provider config → throws `provider_config_disabled`.

## Task 4 — real-role integration test

**Files:** `server/src/__tests__/provider-credential-broker-real-role.integration.test.ts` (new), shape of `canary-preflight-real-role.integration.test.ts`.

- [ ] As `aoa_operator`: (a) direct `SELECT` on each credential table raises `42501`; (b) `resolve_provider_assignment_candidates` returns a seeded active company_default assignment; (c) `resolve_company_secret_bundle` returns material for the seeded secret; (d) `record_company_secret_access` inserts an audit row + touches `last_resolved_at`.

## Task 5 — startup/manifest guard

- [ ] Rely on `distributed-execution-db-startup.integration.test.ts` (reproduces the boot assertion) — it validates the three new manifest entries (identityArguments/authorityRelations/executionConfig/bodySha256) against real PG. Add the three function names to `security-definer-manifest.test.ts` expectations if it asserts an explicit set (check first; if it iterates the manifest, no change).

## Task 6 — CI heap fix on this branch

**Files:** Modify `.github/workflows/pr.yml`.

- [ ] Add the workflow-level `env: NODE_OPTIONS: --max-old-space-size=8192` (same as PR #463) so `verify` clears the pre-existing `server`-tsc OOM and actually runs the tests + the boot-assertion integration test. Without it CI can't validate this change.

## Task 7 — validate + gated deploy + prove

- [ ] Push branch; open PR against `docs/replatform-program`; iterate CI to green — the boot-assertion + real-role integration tests are the safety net for the manifest/hashes.
- [ ] Comprehensive review (adversarial workflow + code-reviewer) over the WHOLE change (substrate + wiring). Fix findings.
- [ ] **Gated deploy (reconfirm with the user first):** rebuild the CP image with 0281 + manifest + wiring; apply migration as the OWNER connection; restart CP — must pass app-authority for BOTH replicas; if `distributed_execution_app_authority` throws, fix the manifest, do not force.
- [ ] Re-prove: dispatch → isolated/lease run → E2B; no `no_assignment`/`secret_unbound`; agent completes; fresh `secret_access_events` row + updated `last_resolved_at`; `pnpm verify:e7-1-distributed-run`.

## Self-review notes
- Deviation from the design's "thread operatorDb to call sites": using a boot-set module handle read lazily instead — smaller blast radius, no 4-call-site threading, matches the lazy-composition-root lesson. Flag for reviewer.
- Behavioral risk is contained: the broker path is gated on `multi_tenant` AND the handle being set; self-hosted/embedded and every test that injects deps directly keep the exact current path. Kill-switch preserved.
