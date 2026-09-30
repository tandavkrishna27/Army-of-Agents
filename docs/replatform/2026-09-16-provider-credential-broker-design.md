# Provider-credential resolution for distributed/isolated runs — design spec

**Date:** 2026-09-16
**Status:** approved design (source-grounded); pending spec review
**Area:** `packages/db` (migration) + `server/src` (resolver wiring, definer manifest)
**Ticket context:** E7-1 distributed canary — the credential-resolution half of "make a real distributed run work" (worker/heartbeat half shipped separately on `claude/worker-daemon-heartbeat`).

## Problem (verified live on the staging canary)

A distributed/isolated agent run fails before it can call the model:
`ProviderUnavailableError: No usable anthropic provider credential for this run (no_assignment)`
at `resolveProviderCredential` (`server/src/services/provider-resolution.ts:303`).

The credential model for the canary company `df827ba2` (org `0febb760`) is **fully configured**: an ACTIVE `provider_assignments` row (`company_default`, anthropic) → a `verified` `provider_connections` row (`aa53e878`, `auth_method=api_key`) → `company_secrets` `ANTHROPIC_API_KEY` with version material present. The founder's provider-key setup is complete.

The failure is a **substrate gap**: the runtime DB roles cannot read the credential model.

- `SET ROLE aoa_app; SELECT … provider_assignments` → `permission denied` (zero grants).
- `SET ROLE aoa_operator; SELECT … provider_assignments` → `permission denied` (zero grants too).
- No `SECURITY DEFINER` function brokers the read. Only the table owner (superuser) can read the five credential tables.

So the resolver's assignment query returns zero rows → `hadAssignment=false` → `no_assignment`.

### Why a plain GRANT is the wrong fix (verified the hard way)

Granting `aoa_app` SELECT/UPDATE on the credential tables made the query work — but on the next control-plane restart the CP **exited on boot** with `DistributedExecutionStartupError: distributed_execution_app_authority`. A startup assertion (`server/src/db/distributed-execution-databases.ts` ~1749-1762, via `assertExactServingRoleAuthority`) enforces the **exact** grant posture of the serving roles. Ad-hoc credential-table grants violate it. The grant was reverted and the CP is healthy. Conclusion: **the credential tables being owner-only is a deliberate, enforced security boundary**, not an oversight. The runtime must reach the credential model through a sanctioned, narrow mechanism — not a direct grant.

## Approach (approved) — a SECURITY DEFINER broker

Add **two owner-owned `SECURITY DEFINER` functions** (Decision #122 class-b cluster/security DDL), `EXECUTE`-granted to **`aoa_operator` only** (never the tenant-facing `aoa_app`), invoked over the existing **`operatorDb`** pool, and wired into `buildResolveDeps` behind the two DB reads that currently hit owner-only tables.

This is the mechanism the repo **already uses** to let a non-owner pool read `company_secret_versions`: `canary_preflight_evidence_scalars` (`server/src/db/security-definer-manifest.ts` ~122-142, migration `0267`). We add the deliberate, reviewed exception whose return type carries the resolved credential material — that is the function's purpose.

**Why this passes the boot assertion:** `assertExactServingRoleAuthority` scans **table/column/sequence** grants — it never inspects definer functions. Definers are governed by a *separate* structure, the definer manifest (`assertSecurityDefinerManifest`), which we extend with a matching entry **in the same commit**. No table ACL changes → the table-grant scans see nothing new → boot stays green.

**Why `aoa_operator` + `operatorDb`:** every existing definer grants EXECUTE to `aoa_operator` only and keeps owner authority off `aoa_app` ("the binder is the grantee, not the parameter"). Provider-credential resolution during dispatch is a control-plane action, so operator is the correct binder, matching precedent. `operatorDb` already exists at the composition root (`index.ts:993`) and is already used this exact way by `canary-preflight-evidence.ts`.

### Alternatives rejected

- **Direct `GRANT SELECT … TO aoa_app` in a custom migration.** Legal under the assertion only if wired through all coupling points, but RLS is OFF on these tables on this deployment, so a plain grant lets the tenant pool enumerate *every* tenant's assignment/connection metadata (cross-tenant read, no predicate) — and still can't decrypt the secret, so you pay the definer tax anyway. Strictly dominated.
- **Route resolution through an owner/operator handle with direct selects (no new SQL).** Non-viable: `aoa_operator` also has zero credential grants, and its own authority assertion forbids adding them. An owner-authority runtime handle contradicts the "control plane serves as non-owner" posture.
- **Reuse the DAT-008 worker secret-broker.** That covers the worker fence/lease context, not the in-process org-heartbeat/crew pre-dispatch path, and still bottoms out in owner reads. It's a consumer of this substrate, not a substitute.

## Components

### 1. Migration `0281_provider_credential_broker.sql` (delta-free `--custom`)

Two functions. Scope-matching (`candidateMatchesScope`) and AES-256-GCM decryption stay in the audited Node layer (SQL cannot read the app-held master key), so the functions return rows/material, not decisions or plaintext.

- **Function A — `resolve_provider_assignment_candidates(p_organization_id uuid, p_company_id uuid, p_provider text)`**: `LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''`. Returns the `provider_assignments ⋈ provider_connections` columns the resolver selects today (`provider-resolution-deps.ts:30-72`), predicate-scoped to `provider=p_provider AND state='active' AND (company_id=p_company_id OR org_default for p_organization_id)`. No secret material.
- **Function B — secret resolve + audit**: `LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''`. Reproduces the DB layer of `secretService.resolveSecretValue` (`secrets.ts:458-501`): reads `company_secrets` + latest `company_secret_versions.material` + `company_secret_bindings` (agent-context) + `company_secret_provider_configs`, performs the `lastResolvedAt`/`updatedAt` UPDATE on `company_secrets` (`secrets.ts:494`) and the `secret_access_events` INSERT (success and failure, `secrets.ts:495,498`), and RETURNS the encrypted material + `external_ref` + provider-config for the Node layer to decrypt via `getSecretProvider().resolveVersion()`.

Both functions: `REVOKE ALL … FROM PUBLIC; REVOKE ALL … FROM "aoa_app"; GRANT EXECUTE … TO "aoa_operator";`

Meta: since it's delta-free, `meta/0281_snapshot.json` = `0280`'s snapshot with new `id`/`prevId` only; append the `0281` entry to `meta/_journal.json`. Header follows the `0266`/`0267` C14 / Decision #122 banner.

### 2. `server/src/db/security-definer-manifest.ts` — two new entries

One per function, with exact `identityArguments` (`pg_get_function_identity_arguments` byte-for-byte, e.g. `timestamp with time zone` not `timestamptz`), `authorityRelations` (owner-pinned tables each function reads/writes), `executionConfig` (`SET search_path=''`), and `bodySha256` regenerated with `scripts/definer-body-sha256.mjs` against the final migration text (CR-strip normalization matters on Windows checkouts).

### 3. `server/src/services/provider-resolution-deps.ts` — resolver wiring

`buildResolveDeps` takes an operator handle. `loadCandidateRows` calls Function A via `db.execute(sql\`SELECT * FROM public.resolve_provider_assignment_candidates(...)\`)` over `operatorDb`; `resolveSecretValueForConnection` calls Function B then decrypts in Node. Mirror `canary-preflight-evidence.ts` for `db.execute` row-shape handling (coerce numeric-as-string; scalar/NULL semantics). Keep the `AOA_PROVIDER_RESOLVER=legacy` kill-switch.

### 4. Call sites thread `operatorDb`

`runner.ts` (~598-636), `heartbeat.ts` (~3500-3585), `one-shot-provider-credential.ts` (~62-143). Source from `distributedExecutionDatabases.operatorDb`. Guard on `topology.trustBoundary !== "multi_tenant"` (`selfHostedSingleTenant`) so self-hosted/embedded keeps the owner-`db` direct-select path — provably untouched.

## Complete privilege set (resolve + materialize)

| Table | Privilege the logic needs | Held by |
|---|---|---|
| `provider_assignments` | SELECT | Function A (owner) |
| `provider_connections` | SELECT | Function A (owner) |
| `company_secrets` | SELECT + UPDATE (`lastResolvedAt`) | Function B (owner) |
| `company_secret_versions` | SELECT (`.material`) | Function B (owner) |
| `company_secret_bindings` | SELECT | Function B (owner) |
| `company_secret_provider_configs` | SELECT | Function B (owner) |
| `secret_access_events` | INSERT (audit, success+failure) | Function B (owner) |

**Runtime role (`aoa_operator`) net new privilege: EXECUTE on the two functions. Nothing else.** No table/column/sequence grant to either serving role → both `assertExactServingRoleAuthority` passes stay green. Materialization into E2B is a Node env overlay (`applyResolvedCredential` → `one-shot-sandbox-cli.ts` allowlist), never the wire (`FORBIDDEN_WIRE_KEYS`).

## Testing

- Unit: `candidateMatchesScope` tests unchanged; new deps test asserts the resolver calls the definer RPCs and Node still does decryption + binding decision.
- Manifest/certificate: extend `security-definer-manifest.test.ts`; rely on `distributed-execution-db-startup.integration.test.ts` (reproduces the boot assertion) — a wrong `bodySha256` or missing `authorityRelations` fails here, not in prod.
- Real-role integration: `provider-credential-broker-real-role.integration.test.ts` (shape of `canary-preflight-real-role.integration.test.ts`): as `aoa_operator`, (a) direct SELECT on the credential tables still raises `42501`, and (b) `SELECT * FROM resolve_provider_assignment_candidates(...)` returns the row + Function B returns material for the seeded company.

## Deploy / verify

1. Rebuild the control-plane image with 0281 + manifest + wiring.
2. Apply the migration with the **owner/superuser** connection (functions are owner-owned; `CREATE FUNCTION … SECURITY DEFINER` requires it).
3. Restart the CP; boot must pass the app-authority phase for **both** replicas. If it throws `distributed_execution_app_authority`, the manifest and the live catalog disagree (usually `bodySha256` or a missing `authorityRelations` owner-pin) — fix the manifest, do NOT force.
4. Re-prove: dispatch a task → isolated/lease run → E2B; confirm no `no_assignment`/`secret_unbound`, the sandbox receives `ANTHROPIC_API_KEY` in its env overlay, the agent completes, and a fresh `secret_access_events` row + updated `company_secrets.last_resolved_at` prove the definer's writes fired under owner authority. Then `pnpm verify:e7-1-distributed-run`.

## Risks

- The exact failure already hit = live ACL diverging from the manifest. This design changes **no** table ACL; the only new coupling is the definer manifest. Regenerate `bodySha256` after any whitespace edit; get `identityArguments`/`authorityRelations`/`executionConfig` exact.
- Do NOT touch `JOB_CONTROL_LEGACY_GRANTS`, do NOT enable RLS on a table absent from `RLS_RELATIONS`, do NOT grant EXECUTE to `PUBLIC`, do NOT `GRANT … TO aoa_app` on any credential table, do NOT serialize the key onto the wire.
- Migration must run as owner. Keep the `AOA_PROVIDER_RESOLVER=legacy` kill-switch honored and gate the new path on `multi_tenant` so self-hosted is untouched.

## Out of scope

No RLS changes; no change to the worker secret-broker (DAT-008); no new adapter/provider; the worker/heartbeat fix is separate (`claude/worker-daemon-heartbeat`).
