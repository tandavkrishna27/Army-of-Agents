# PRT-006 Result — Registered Target, Capability Negotiation, and Initial Conformance Corpus

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E1-worker-protocol`
**Plan task:** `Task 6: PRT-006 — Registered Target, Capability Negotiation, and Initial Conformance Corpus`
**Implementer:** `PRT-006 implementer subagent (Claude)`
**Start SHA:** 94f887dfe86663baea5ff1b46f266cb12d653f28

The implementer leaves `Status` at `gate_review`. A separate reviewer completes the section below and is the only role that may change it to `complete`.

This file is a controlled append-only review ledger until `complete`; do not delete or rewrite prior review attempts. Once `complete`, it is frozen. Ticket commands are focused acceptance evidence, not the immutable epic D0 rollup.

## Delivered scope

- **`packages/worker-protocol/src/capabilities.ts`** — registered target authority + dynamic worker claims + normalized provider-constraint profiles + intersection matching:
  - **Capability vocabulary.** `KNOWN_WORKER_CAPABILITIES` (closed 12: `workload.{batch,browser_session,service}`, `provider.{lifecycle_v1,cleanup_v1,checkpoint_v1,health_v1}`, `artifact.direct_upload`, `secret.proxy`, `sandbox.{filesystem_isolated,process_isolated,filtered_egress}`) + `workerCapabilitySchema` enum. Unknown names fail closed; provider identity/region/template/credentials are never capabilities.
  - **Emission vocabulary (E1-D002).** `NON_EVENT_DISTRIBUTED_EMISSIONS` (the 4 frozen operation/receipt names) + `KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS = WORKER_EVENT_TYPES ∪ those 4` — the reviewed superset the golden-journeys parity check reads. Housed here because `events.ts` is out of this ticket's file scope.
  - **Worker report.** `workerCapacitySchema` (`batchSlots`/`browserSessionSlots`/`serviceSlots`/`freeCpuMillis`/`freeMemoryMiB`/`freeDiskMiB`, non-negative, strict); `workerPlatformSchema` (`os` linux|darwin|windows, `arch` x64|arm64, `runtime` non-empty ≤100 — an opaque provider-neutral label, never a region/template).
  - **Provider-constraint profile.** `providerConstraintProfileRefV1Schema` = the imported PRT-003 `providerConstraintRefV1Schema` (single source of truth, aliased). `PROVIDER_OPERATIONS` (11) split into `CORE_PROVIDER_OPERATIONS` (8, all required) + `OPTIONAL_PROVIDER_OPERATIONS` (`checkpoint`/`restore`/`health`). `providerConstraintProfileV1Schema` (`.strict()`): normalized runtime/idle/resource(`resourceLimitsSchema`)/concurrency/operation/locality ceilings + `checkpointMode` none|snapshot|application + `healthMode` none|poll|stream; superRefine enforces all core ops present, checkpoint⟺restore, checkpoint⟺(mode≠none), health⟺(mode≠none), unique ops/localityTags, unknown op rejected.
  - **Digest verification.** `canonicalProviderConstraintProfileDigestInputV1` uses the ONE shared `canonicalizeJsonV1` (omits `digest`). `verifyAndBrandProviderConstraintProfileV1(profile, sha256Fn)` (INJECTED SHA-256; sync/async; never throws) returns the phantom-branded **non-serializable** `VerifiedProviderConstraintProfileV1` ONLY on a schema-valid profile whose recomputed digest matches; a field mutation reusing the old digest → `null`.
  - **Registered target.** `registeredTargetProfileV1Schema` (`.strict()`): server-assigned target/class/scope, conditional Organization/owner binding (`platform`→null/null, `organization`→org/null, `owner`→org/owner), trust/credential/locality ceilings, provider ref, provider-neutral capability ceiling, device generation, revocation, policy hash. Scope must equal the class's matrix scope and (class,trust,credential,locality) must be a member of the closed `PLACEMENT_MATRIX` row.
  - **Worker hello.** `workerHelloV1Schema` (`.strict()`): worker/target IDs, device generation, agent version, protocol min/max (min≤max), platform, reported capabilities, capacity, policy hash. `.strict()` REJECTS any self-asserted trust/credential/locality/provider/capability-ceiling field — a worker cannot advertise its way into a higher class.
  - **Requirements + matcher.** `targetRequirementsV1Schema` re-exported (imported PRT-003 schema, NOT redefined). `jobCapabilityRequirementsSchema` (`protocol`, `capabilities`, `workloadType`, `targetRequirements`, `policyHash`, `mustUnderstand`). `workerSatisfiesRequirements(profile, verifiedProviderConstraints, worker, requirements)` = INTERSECTION matching: identity/generation/revocation → provider ref/digest equality (both refs vs the verified profile) → protocol overlap (`negotiateProtocolVersion`) → policy coherence → capability intersection (ceiling ∩ report; workload cap + required caps + must-understand all in it; unknown must-understand fails closed) → closed-matrix placement + ordered credential/locality-within-ceiling + owner binding → worker free resources ≤ provider ceiling → free workload slot. Accepts ONLY `VerifiedProviderConstraintProfileV1`; a compile-time `Expect<>` guard in the source proves a raw parsed profile is not assignable.
- **`packages/worker-protocol/src/version.ts`** — added `ProtocolVersionRange` + pure `negotiateProtocolVersion(controlPlane, worker): number | null` (highest overlap or null).
- **`packages/worker-protocol/src/index.ts`** — explicit named re-exports (values + `export type`) of the new `version.ts` + `capabilities.ts` surface; no `export *`. `targetRequirementsV1Schema`/`TargetRequirementsV1` stay exported once (from the `job.ts` block) since capabilities imports the same object.
- **`docs/contracts/worker-protocol/v1/`** — `conformance.json` (`contractVersion` `1.0.0` + the 16 named vectors), `README.md` (additive-only evolution, unknown-enum rejection, manifest regeneration, Protocol Custodian approval), and `manifest.sha256` (deterministic, LF, one line for `conformance.json`).
- **`scripts/update-worker-protocol-contract-manifest.mjs`** + **`.test.mjs`** — deterministic generator with `--check` mode + pure exported `validateContractTextBytes()`/`buildManifestBytes()` helpers; 13-case `node:test` mutation corpus.
- **CI** (`.github/workflows/pr.yml`) — dependency-free `worker-protocol-contract-bytes` matrix (`ubuntu-latest` + `windows-latest`) running the mutation corpus + generator `--check` against committed bytes, routed through `ci-required` (both legs required; never an independently-required branch-protection check). **`.gitattributes`** pins `docs/contracts/worker-protocol/v1/**` to LF. **`package.json`** adds `gen:worker-protocol-contract`; **`packages/worker-protocol/package.json`** + **`pnpm-lock.yaml`** add `ajv@8.18.0` + `ajv-formats@3.0.1` as exact dev deps (committed together).

**Non-goals preserved (per plan).** No transport/control/error schemas, operation wrappers, or HTTP concerns; no frozen-baseline / cross-version compatibility harness — **PRT-007 owns transport/errors and the complete-v1 frozen baseline + future-compatibility harness.** No false sentinel-rejection vector (reserved/unmapped-tenant admission + requester-authority mismatch are TEN-006 / JOB-001 / JOB-010 policy, not this context-free syntax corpus). Frozen E0 fixtures untouched. Runtime source imports only `zod` + relative modules; `TextEncoder` only (no `Buffer`/`node:*`).

## Changed files

| File | Responsibility |
|---|---|
| `packages/worker-protocol/src/capabilities.ts` | NEW. Capability/emission vocabularies, worker capacity/platform, provider-constraint profile (+digest verify/brand), registered target profile, worker hello, job capability requirements, and `workerSatisfiesRequirements` intersection matcher. |
| `packages/worker-protocol/src/capabilities.test.ts` | NEW. 44 cases: vocabulary locks, provider op core/optional rules, digest verify + mutation→null, scope binding + matrix coherence, multi-org logical profiles, worker-can't-self-assert, and the full matcher truth table (identity/provider/protocol/policy/capability-intersection/must-understand/placement/credential-ceiling/owner/over-advertise/slot). |
| `packages/worker-protocol/src/version.ts` | Added `ProtocolVersionRange` + pure `negotiateProtocolVersion`. |
| `packages/worker-protocol/src/version.test.ts` | NEW. 6 cases incl. the N-1 rollout unit test (labeled NOT the frozen-consumer proof), single-point overlap, and non-overlap null. |
| `packages/worker-protocol/src/contract.test.ts` | NEW. Loads `conformance.json`, maps `schema`→4 validators (`job`/`lease_offer`/`event_batch`/`target_worker_pair`), asserts `safeParse().success===valid`, checks `preserveKeys`, the case-10 argv-canary producer-safety assertion, and verifies `manifest.sha256` against exact bytes with `node:crypto`. |
| `packages/worker-protocol/src/golden-journeys.test.ts` | NEW. Ajv2020 + ajv-formats compile `schema-v1.json`, validate all 9 fixtures, an 11-row invalid-mutation table, then E1-D002 membership-parity assertions. |
| `packages/worker-protocol/src/index.ts` | Explicit named re-exports of the `version.ts` + `capabilities.ts` public surface (no `export *`). |
| `docs/contracts/worker-protocol/v1/conformance.json` | NEW. `contractVersion` `1.0.0` + the 16 named accept/reject vectors. |
| `docs/contracts/worker-protocol/v1/README.md` | NEW. Additive-only evolution, unknown-enum rejection, manifest regeneration, scope boundary, Protocol Custodian approval. |
| `docs/contracts/worker-protocol/v1/manifest.sha256` | NEW. Deterministic LF manifest — one `<sha256>  conformance.json` line. |
| `scripts/update-worker-protocol-contract-manifest.mjs` | NEW. Deterministic generator + `--check` + pure `validateContractTextBytes()`/`buildManifestBytes()` helpers. |
| `scripts/update-worker-protocol-contract-manifest.test.mjs` | NEW. 13-case `node:test` mutation corpus (CRLF/CR/BOM/invalid-UTF-8/missing-LF/non-POSIX/duplicate/altered/stale/self-hash). |
| `package.json` | Added `gen:worker-protocol-contract`. |
| `packages/worker-protocol/package.json` | Added `ajv@8.18.0` + `ajv-formats@3.0.1` exact dev deps. |
| `pnpm-lock.yaml` | Regenerated with the two dev deps (+6 lines, committed with the manifest). |
| `.gitattributes` | Pin `docs/contracts/worker-protocol/v1/**` to LF (added BEFORE manifest generation). |
| `.github/workflows/pr.yml` | Added the `worker-protocol-contract-bytes` matrix (ubuntu+windows) and wired it into `ci-required`. |
| `docs/replatform/epics/E1-worker-protocol/tickets/PRT-006-result.md` | This ticket result ledger. |

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| `capabilities.test.ts` + `version.test.ts` fail RED before the modules/function exist | Step 2: `vitest run src/capabilities.test.ts src/version.test.ts` exit 1 — `Cannot find module './capabilities.js'`; `negotiateProtocolVersion is not a function` | `pass` |
| `contract.test.ts` fails RED before the manifest exists; golden-journeys already passes | Step 6: manifest test `ENOENT … manifest.sha256`; 18/19 contract + 31/31 golden green | `pass` |
| Registered target vs worker hello separation; conditional scope binding strict; matrix coherence; multi-org logical profiles | `capabilities.test.ts` "registeredTargetProfileV1Schema" (platform→null/null, organization→org/null, owner→org/owner; scope≠class-scope rejected; forbidden (class,trust,cred,locality) row rejected; two org-scoped profiles accepted; unknown ceiling cap rejected) | `pass` |
| A worker cannot advertise its way into a higher trust/provider/credential/locality/capability class | `capabilities.test.ts` — worker hello `.strict()` rejects `trustCeiling`/`credentialCeiling`/`dataLocalityCeiling`/`providerConstraints`/`capabilityCeiling`; matcher uses ceiling∩report (withheld `secret.proxy` → missing); worker over-report `freeMemoryMiB 999999` > ceiling → false | `pass` |
| Provider profile: core ops required; checkpoint⟺restore⟺mode≠none; health⟺mode≠none; unknown op rejected | `capabilities.test.ts` "providerConstraintProfileV1Schema" (missing core → fail; checkpoint w/o restore → fail; restore+mode none → fail; checkpoint+restore+snapshot → ok; mode≠none w/o ops → fail; health rules; `teleport` op → fail) | `pass` |
| Digest verified through injected SHA-256; mutation with old digest → no verified profile; verified type required by matcher | `capabilities.test.ts` "verifyAndBrand…" (5 mutations→null); matcher param typed `VerifiedProviderConstraintProfileV1`; compile-time `Expect<ProviderConstraintProfileV1 extends Verified ? false : true>` in `capabilities.ts` passes `tsc` (fails if brand dropped) | `pass` |
| Provider-native region/template IDs never enter job/worker messages or a closed capability enum | `workerPlatformSchema.runtime` is a free opaque label; no provider/region/template field on hello/requirements/capability enum (grep + `.strict()`) | `pass` |
| `negotiateProtocolVersion` highest-overlap/null; N-1 case is a rollout unit test | `version.test.ts` 6/6 (`{1,3}`×`{2,4}`→3; `{1,2}`×`{1,1}`→1 labeled rollout; `{2,3}`×`{1,1}`→null; touch-at-one-point→2; identical→1; strictly-below→null) | `pass` |
| `targetRequirementsV1Schema` imported from `job.ts` (not redefined); provider digest uses `canonicalizeJsonV1` | `capabilities.test.ts` `expect(targetRequirementsV1Schema).toBe(job's)`; `capabilities.ts` imports both from `./job.js`/`./canonical-json.js` | `pass` |
| `conformance.json`: 16 named cases, each `{name,schema,valid,preserveKeys?,input}`, reusing PRT-003/004 fixed values; no false sentinel case | `contract.test.ts` all 16 `safeParse().success===valid`; `preserveKeys:["extensions"]` survives on the browser case; names unique; schema set = the 4 | `pass` |
| Case 10: reserved key rejected by schema AND argv canary rejected by producer-safety helper | `contract.test.ts` — nested `apiKey` → `job` rejected; `findSecretCanaryStringMatches(input, ["CANARY-SECRET-9"])` finds `workload.args…` | `pass` |
| `target_worker_pair` case parses each part, verifies+brands the profile, runs the matcher = true | `contract.test.ts` "valid registered target plus worker hello intersection" accepts | `pass` |
| Manifest verified against exact bytes with `node:crypto` | `contract.test.ts` manifest test = `ff4e2dc3a895c6281077634cdb0ad92592595754bf57f40cac88a2c6eb4451c6  conformance.json\n` | `pass` |
| Golden journeys (E1-D002 membership parity): 9 fixtures validate; invalid mutations rejected; source.kind ∈ union; emits ∈ superset; terminalState ∈ set; forbidden/audit non-empty | `golden-journeys.test.ts` 31/31 | `pass` |
| Deterministic manifest: LF-only, no BOM, final LF, sorted POSIX; byte-identical Windows+Linux; generator never self-hashes; CRLF/CR/BOM/invalid-UTF-8/missing-LF/unsorted/altered/stale all fail | `update-…manifest.test.mjs` 13/13; regen produces zero `git diff`; `.gitattributes` LF pin | `pass` |
| ajv/ajv-formats added as EXACT dev deps with lockfile in the same commit | `packages/worker-protocol/package.json` devDeps + `pnpm-lock.yaml` (+6, ajv only); runtime `dependencies` still exactly `["zod"]` (boundary PASS) | `pass` |
| CI `worker-protocol-contract-bytes` matrix (ubuntu+windows), dependency-free, `--check` vs committed bytes, no bytes committed from CI | `pr.yml` job + `ci-required.needs`; YAML parses | `pass` |

### Registered vs reported capability / provider-policy matrices

- **Capability class (server-owned ceiling vs worker report).** Effective set = `capabilityCeiling ∩ reportedCapabilities`. Worker reporting a capability the server withholds does NOT gain it (`secret.proxy` withheld → required-cap and must-understand both fail). Worker `.strict()` rejects any `capabilityCeiling`/trust/credential/locality/provider field, so the report can only narrow.
- **Provider-policy class.** The registered target's provider ref, the job's requested provider ref, and the resolved+**verified** profile must all agree on `{profileId, version, digest}`. A mutated ceiling (runtime/idle/resource/concurrency/locality/checkpoint/health) with the stale digest never yields a verified profile → the matcher cannot be called with it. Worker free resources are clamped: `free* ≤ resourceCeiling.*` or the match fails (no self-expansion of the runtime/resource class).
- **Placement class.** `(targetClass, trustCeiling, credentialCeiling, dataLocalityCeiling)` must be an explicit `PLACEMENT_MATRIX` row and `scope` its matrix scope; the job's requested credential/locality must be within the target's committed ceiling in the class's ascending row order; owner-bound requirements require an exact `ownerPrincipalId` match.

### The 16 conformance vectors

| # | Name | schema | valid |
|---:|---|---|:---:|
| 1 | valid task-run batch job | job | ✓ |
| 2 | valid Commander-turn batch job | job | ✓ |
| 3 | valid crew-run batch job | job | ✓ |
| 4 | valid one-shot extraction job | job | ✓ |
| 5 | valid browser-request job with safe optional extension (`extensions` preserved) | job | ✓ |
| 6 | valid service-reconcile job | job | ✓ |
| 7 | reject fabricated non-task run and issue (commander_turn + runId/issueId) | job | ✗ |
| 8 | reject task executor or assignee mismatch | job | ✗ |
| 9 | reject unknown source or workload (`workloadType: gpu_batch`) | job | ✗ |
| 10 | reject nested plaintext api key and known secret canary | job | ✗ |
| 11 | valid lease offer | lease_offer | ✓ |
| 12 | reject inverted lease times (ackDeadline = expiresAt) | lease_offer | ✗ |
| 13 | valid contiguous event batch (seq 1,2) | event_batch | ✓ |
| 14 | reject event sequence gap (seq 1,3) | event_batch | ✗ |
| 15 | valid registered target plus worker hello intersection | target_worker_pair | ✓ |
| 16 | reject unknown job terminal state vector (`status: done`) | event_batch | ✗ |

- **Manifest digest (conformance.json):** `ff4e2dc3a895c6281077634cdb0ad92592595754bf57f40cac88a2c6eb4451c6`.
- **Provider-constraint profile digest (case 15):** `fb00e722d10f46f235a5141d337029c241412e181eda2830e890dd2197b48479` (computed via the production `canonicalProviderConstraintProfileDigestInputV1` + SHA-256; re-verified at test time by `verifyAndBrandProviderConstraintProfileV1`).

### The 9 E0 golden journeys (E1-D002 membership parity)

Each validates against the compiled `schema-v1.json`; `source.kind ∈ EXECUTION_SOURCE_KINDS`; every `steps[].emits ∈ KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS`; `terminalState ∈` the workload's terminal/status set; forbidden effects + audit actions non-empty.

| Fixture | workloadType | source.kind | terminalState | notable emits |
|---|---|---|---|---|
| `batch-success` | batch | task_run | succeeded | usage, artifact_prepared |
| `batch-cancel-during-execution` | batch | task_run | cancelled | attempt_started, log, terminal |
| `browser-approval-download` | browser_session | browser_request | succeeded | browser_approval_requested, browser_observation |
| `browser-denied-egress` | browser_session | browser_request | failed | network_denied |
| `late-output-quarantine` | batch | task_run | expired | `artifact_transfer_rejected`, `quarantine_grant_issued`, `quarantine_receipt_finalized`, `replacement_lease_activated` (the 4 non-event names) |
| `plaintext-secret-in-argv-rejected` | batch | one_shot | failed | (steps carry no emits) |
| `service-budget-stop` | service | service_reconcile | stopped | service_graceful_stop_observed, service_instance_stopped |
| `service-provider-pause-resume` | service | service_reconcile | healthy | service_checkpoint_prepared, service_instance_lost, service_checkpoint_restored |
| `service-restart-checkpoint` | service | service_reconcile | healthy | service_checkpoint_prepared, service_checkpoint_restored |

Control-plane journey `expectedEvents[].eventType` values (`budget_exhausted`, `lease_lost`, `cancel_requested`, `producer_safety_rejected`, `provider_pause_observed`) are NOT forced into the worker-event union — only the `steps[].emits` vocabulary is asserted.

## Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `vitest run src/capabilities.test.ts src/version.test.ts` (RED, pre-impl) | `1` | `Cannot find module './capabilities.js'`; `negotiateProtocolVersion is not a function` |
| `pnpm gen:worker-protocol-contract` | `0` | wrote `manifest.sha256` (regen produces zero git diff → deterministic) |
| `node --test scripts/update-worker-protocol-contract-manifest.test.mjs` | `0` | tests 13, pass 13, fail 0 |
| `node scripts/update-worker-protocol-contract-manifest.mjs --check` | `0` | `worker-protocol contract manifest: OK` |
| `vitest run src/capabilities.test.ts src/version.test.ts src/contract.test.ts src/golden-journeys.test.ts` | `0` | 4 files, 100 passed (capabilities 44, version 6, contract 19, golden 31) |
| `pnpm --filter @armyofagents/worker-protocol test:run` | `0` | 14 files, 396 passed |
| `pnpm --filter @armyofagents/worker-protocol typecheck` | `0` | `tsc --noEmit` clean (incl. the `Expect<>` brand guard) |
| `pnpm --filter @armyofagents/worker-protocol build` | `0` | `tsc` emits dist clean |
| `pnpm check:worker-protocol-boundary` | `0` | `worker protocol boundary: PASS` (runtime deps still exactly `["zod"]`) |
| `pnpm check:distributed-foundation` | `0` | `distributed execution foundation: PASS` (frozen fixtures untouched) |

## Deviations

1. **Ajv compile options (test-only): `{ strict: true, strictRequired: false }`.** The immutable E0 `schema-v1.json` uses the idiomatic `Source.allOf[0].if/then/required` construct (properties live on the parent `Source`; `required` is asserted in the `then` branch) — valid JSON Schema 2020-12, but Ajv's opinionated `strictRequired` sub-check throws on it. Per E1-D002 the test conforms to the frozen fixtures, so I disabled only `strictRequired` while keeping full strict 2020-12 compilation (`strict: true`) and formatted-error reporting. No schema bytes were changed.
2. **Manifest BOM detection fix vs the plan's illustrative template.** The plan template's `new TextDecoder("utf-8", { fatal: true })` + `charCodeAt(0) === 0xfeff` cannot detect a BOM — `TextDecoder` silently strips a leading BOM by default, so the check never fires. I added `ignoreBOM: true` so a leading BOM is preserved as U+FEFF and rejected; the mutation test proves BOM rejection. All other template semantics (LF/CR/final-LF/POSIX/self-hash) are byte-identical.

Neither changes wire behavior or the frozen fixtures.

Placement note (not a deviation): the emission-vocabulary constants (`KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS`, `NON_EVENT_DISTRIBUTED_EMISSIONS`) live in `capabilities.ts` because `events.ts` is outside this ticket's file scope; they are built from the imported `WORKER_EVENT_TYPES`. The compile-time negative proving the matcher rejects a raw parsed profile is the `Expect<>` type guard in `capabilities.ts` (runtime source is typechecked; `*.test.ts` is excluded from the package `tsc`).

## Findings

- **E1-F002 / E1-D002 (followed, not reopened):** `golden-journeys.test.ts` asserts vocabulary/enum-membership parity (`source.kind ∈ ExecutionSourceV1` discriminants; `emits ∈` worker-event union ∪ the 4 frozen operation/receipt names), NOT a full-object parse. No new findings.

## Follow-up tickets

- **PRT-007** owns transport/control/error contracts and the complete-v1 frozen baseline + future-compatibility (cross-version) harness. This ticket deliberately ships only the context-free syntax corpus.

## Gate recommendation

`ready for independent review` — all focused suites, the full package test/typecheck/build, the deterministic-manifest checks, the boundary guard, and the frozen-foundation check pass; the manifest is byte-deterministic; single-source reuse (`targetRequirementsV1Schema` from `job.ts`, provider digest via `canonicalizeJsonV1`) is preserved; dev deps + lockfile are committed together.

## Independent review

**Reviewer:** `PRT-006 independent reviewer subagent (Claude)`
**Reviewed revision:** `3cda34467978031c4b04a5f856a771c8d071fe08`
**Disposition:** `approved`
**Review evidence:**

Read-only adversarial review. `git rev-parse HEAD` = `3cda34467978031c4b04a5f856a771c8d071fe08`; parent = `94f887dfe86663baea5ff1b46f266cb12d653f28` (matches the bare Start SHA). All implementer counts reproduced independently; no implementation code was modified.

- **Re-run (all exit 0):** `pnpm gen:worker-protocol-contract` → ZERO git diff (deterministic); `node --test …manifest.test.mjs` = 13 pass / 0 fail; `…manifest.mjs --check` = `OK`; focused `vitest run capabilities+version+contract+golden` = **100 passed** (capabilities 44, version 6, contract 19, golden 31); full `test:run` = **396 passed / 14 files**; `typecheck` clean; `build` clean; `check:worker-protocol-boundary` = PASS (`dependencies` exactly `{"zod":"3.24.2"}`); `check:distributed-foundation` = PASS (frozen fixtures untouched); `git diff --check` clean; `git status --porcelain` empty.
- **E1-D002 emission vocabulary (independent recompute):** `WORKER_EVENT_TYPES` = 19 members; `KNOWN_DISTRIBUTED_EXECUTION_EMISSIONS` = exactly the **23**-member set = worker-event union ∪ `{artifact_transfer_rejected, quarantine_grant_issued, quarantine_receipt_finalized, replacement_lease_activated}` — set-equal to the reviewer-computed expected set (no missing, no extra). Confirmed it **EXCLUDES** all five control-plane journey events (`budget_exhausted`, `lease_lost`, `cancel_requested`, `producer_safety_rejected`, `provider_pause_observed`) and **INCLUDES** all four non-event names. All 9 fixtures pass membership parity (`source.kind ∈ EXECUTION_SOURCE_KINDS`; every `steps[].emits ∈` vocabulary). The Ajv invalid-mutation table genuinely fails against the independently compiled `schema-v1.json` (missing tenant / missing requester / bad UUID / bad timestamp / bad digest / oversized-cross-tenant prefix / absent cleanup / absent forbiddenEffects all → `false`; baseline → `true`).
- **Deviation #1 (`strictRequired:false`) — ACCEPTABLE.** Independently reproduced: compiling the frozen `schema-v1.json` under full strict throws `strict mode: required property "runId" is not defined at …/$defs/Source/allOf/0/then (strictRequired)`; `strict:true, strictRequired:false` compiles; strict is otherwise still ON (an injected unknown root keyword is rejected). Only `strictRequired` — an Ajv-ism beyond the JSON-Schema-2020-12 spec — is relaxed; the schema itself is valid 2020-12, so FND-004's "compiles in 2020-12 strict" is not materially contradicted. E1-D002-consistent (test conforms to the frozen fixture); no schema error is masked.
- **Deviation #2 (BOM) — ACCEPTABLE.** `validateContractTextBytes` throws `UTF-8 BOM is forbidden` on a BOM-prefixed input; independently confirmed the default `TextDecoder` strips a leading BOM (so the plan template's `charCodeAt(0)===0xfeff` could never fire) while `ignoreBOM:true` preserves U+FEFF so the guard fires; clean LF input still validates; the mutation corpus covers it.
- **Capability anti-escalation (independent probes):** `verifyAndBrandProviderConstraintProfileV1` returns a branded profile only on a digest match and `null` when any field (runtime/resourceCeiling/localityTags) is mutated while reusing the old digest. Provider-op rules enforced (missing core op / checkpoint-without-restore / checkpoint+restore+mode-none / unknown op / health-mode-without-op all rejected; checkpoint+restore+snapshot accepted). Conditional scope binding strict for all three scopes (platform→null/null, organization→org/null, owner→org/owner; each violation rejected). Worker hello `.strict()` rejects every self-asserted `trustCeiling`/`credentialCeiling`/`dataLocalityCeiling`/`providerConstraints`/`capabilityCeiling`. `workerSatisfiesRequirements` truth table (15 cases) correct: baseline true; false on revocation, generation mismatch, provider ref/digest mismatch, over-advertised free memory, withheld required capability, unknown must-understand (fail-closed), non-overlapping protocol, worker policy-hash mismatch, no free slot, workload-cap missing from ceiling, credential-above-ceiling, and owner-bound-vs-null-owner. The compile-time brand guard genuinely bites: a temp file passing a raw parsed profile into the matcher fails `tsc` with TS2345 (`[verifiedProviderConstraintBrand]` missing). No `region`/`template` string appears in the closed capability enum.
- **Conformance corpus (independent evaluation):** 16 unique named cases; schema set exactly `{job, lease_offer, event_batch, target_worker_pair}`; all 16 `success===valid` verdicts reproduced; `preserveKeys:["extensions"]` survives parse on the browser case; every reject case is a concrete syntactic reason (no false sentinel-rejection / requester-authority case — correctly deferred to TEN-006/JOB-001/JOB-010). `sha256(conformance.json)` via `node:crypto` = `ff4e2dc3a895c6281077634cdb0ad92592595754bf57f40cac88a2c6eb4451c6` = `manifest.sha256`. Case-15 provider digest recomputes to `fb00e722d10f46f235a5141d337029c241412e181eda2830e890dd2197b48479`, byte-equal to the embedded profile digest and to BOTH the registered-target and job refs (the pair is genuinely digest-verified, not merely parsed).
- **Manifest determinism:** `conformance.json` / `README.md` / `manifest.sha256` are all LF-only, no BOM, final-LF. `.gitattributes` pins `docs/contracts/worker-protocol/v1/** text eol=lf`. Generator sorts POSIX paths, rejects the manifest hashing itself, and regen is a zero-diff no-op here.
- **AGENTS §7 + boundary + CI + housekeeping:** `ajv@8.18.0` + `ajv-formats@3.0.1` are exact **dev** deps in `packages/worker-protocol/package.json`, committed together with `pnpm-lock.yaml` in this same commit (importer specifiers match the manifest; the package defs pre-existed as transitive deps, hence +6 lockfile lines); runtime `dependencies` stay exactly `["zod"]` so the boundary gate passes. `targetRequirementsV1Schema` is imported from `job.ts` and re-exported (identity asserted `toBe` in the tests), not redefined; the provider digest input uses the shared `canonicalizeJsonV1`. The `worker-protocol-contract-bytes` CI job is dependency-free (no `pnpm install`), runs on `ubuntu-latest` + `windows-latest`, is routed into `ci-required`'s `needs` and required-gate loop, and commits no generated bytes. `index.ts` uses explicit named exports (no real `export *`). Ledger conventions hold: Status backtick, bare Start SHA = parent, implementer identity, 18 changed files accurate, manifest hash accurate.

Two deviations, both independently justified; no defects; no new findings. Frozen E0 fixtures untouched.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | PRT-006 independent reviewer subagent (Claude) | `3cda34467978031c4b04a5f856a771c8d071fe08` | `approved` | Re-run all green (100 focused / 396 full / 13 manifest-mutation / `--check` OK / typecheck+build+boundary+foundation PASS / zero-diff regen / clean tree). Independently recomputed the E1-D002 emission vocabulary = exactly 23 (19 worker events ∪ 4 non-event; excludes all 5 control-plane events). Both deviations independently justified (full-strict genuinely throws `strictRequired` on the frozen schema, strict otherwise ON; BOM genuinely rejected). Capability anti-escalation truth table (15 cases) + compile-time brand guard (TS2345) + digest verify/mutation→null all confirmed. 16 conformance verdicts + preserveKeys + no-false-sentinel reproduced; `conformance.json` sha256 = `ff4e2dc3…4451c6` = manifest; case-15 digest = `fb00e722…b48479` matches both refs. No defects; no new findings. |
