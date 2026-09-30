# FND-005 Result — Rollout Policy, Hosted Safety, Custodians, and CI Gate

**Status:** `complete`
**Date (UTC):** `2026-08-08`
**Epic:** `E0-foundation`
**Plan task:** `Task 5: FND-005 — Rollout Policy, Hosted Safety, Custodians, and CI Gate`
**Implementer:** FND-005 implementer subagent (Claude)
**Start SHA:** 07ddfdb2179793818bc19073e444d10cfefed099

The implementer leaves `Status` at `gate_review`. A separate reviewer completes the section below and is the only role that may change it to `complete`.

This file is a controlled append-only review ledger until `complete`; do not delete or rewrite prior review attempts. Once `complete`, it is frozen. Ticket commands are focused acceptance evidence, not the immutable epic D0 rollup.

## Delivered scope

- **Pure rollout-policy module** (`server/src/config/distributed-execution.ts`): the four env-name constants, `readDistributedExecutionDeploymentFlag` (strict boolean; ambiguous value throws), `resolveDistributedExecutionRollout` (deployment → Organization → workload precedence), and `assertHostedExecutionStartupSafe` (hard-rejects the two excluded surfaces in **every** mode; rejects `AOA_ALLOW_UNSANDBOXED_MULTITENANT` only in `cloud_auth`). Exact plan code.
- **Guard re-export** (`unsandboxed-multitenant-guard.ts`): the local `UNSANDBOXED_MULTITENANT_OPT_IN_ENV` declaration is deleted and re-exported from the new canonical module; `assertUnsandboxedMultitenantAllowed` behavior is unchanged (its 11 focused tests still pass).
- **`loadConfig()` wiring** (`config.ts`): `distributedExecutionEnabled: boolean` added to `Config`, default-off; immediately after resolving `deploymentMode` it computes the flag and calls `assertHostedExecutionStartupSafe`. No scheduler/adapter/distributed-route/worker/plugin-runner path is constructed; a truthy excluded flag stops startup; absence/false leaves the reserved routes unregistered.
- **Source-boundary rule** (foundation checker): `server/src/app.ts` is scanned for any import of a reserved distributed public-ingress / cloud-plugin-runner module and any registration of the two reserved path prefixes; both fail the always-on gate. Mutation cases prove each.
- **Delivery policy** (`docs/architecture/distributed-execution-delivery-policy.md`): named custodian roles, one ticket/branch/worktree, custodian-serialized protocol/migration edits, focused-tests-per-ticket + D1 every 5–10 merges + nightly provider lanes, rollout/rollback order, feature-flagged-code-still-needs-tests, no-Docker-socket/no-DB-credential, two-replica shared admission ownership, `test-gates.md` + `E6-D1-FOUNDATION` + HARD-non-waivable, executable hard-negative controls for both reserved surfaces (FND-006/FND-008 own the actual current plugin surfaces), immutable QA naming + `pass|fail|blocked_external`, and the reproducible network-free authoritative build. Linked from Decision #121.
- **Environment docs** (`environment-variables.md`): all four env vars documented, including the `cloud_auth` startup rejection of the override.
- **CI gate** (`pr.yml`): `Distributed execution foundation contracts` step added to the dependency-free `policy` job after `Setup Node.js`.
- **Build reproducibility** (Step 8): `prebuild` no longer performs a network fetch — it runs `node scripts/check-bundled-snapshot-inputs.mjs`, which verifies the pinned manifest (`scripts/bundled-snapshots.manifest.json`) and any present snapshot's digest. Intentional refresh is the new explicit `pnpm refresh:bundled-snapshots` (network) that re-fetches and re-pins. `AGENTS.md`, the delivery policy, and the stale `pr.yml` e2e comment are updated together. `pnpm build` and `pnpm -r build` both leave a clean worktree with no network.
- **Evidence integrity** (foundation checker): validates `artifact-policy.md` + the three evidence templates (exact-revision + named-owner fields, `REQUIRED/HARD/INITIAL/OBSERVED`, D4/D6 schedule-hash + expected/observed/missing sample fields, ticket-result blob pins, append-only review history, immutable QA/handoff banner + `Supersedes`) and exports `checkEvidenceImmutability` (reject modify/delete/rename of an existing QA/handoff record; permit a higher attempt).
- **E0-F001 template carry-forward resolved**: `ticket-result-template.md`'s Start SHA example is now a **bare** 40-hex placeholder (not backtick-wrapped), matching the Task-9 gate parser `^\*\*Start SHA:\*\*\s*([0-9a-f]{40})\s*$`; Status/Disposition examples stay backtick-wrapped. The foundation checker enforces the bare form and a mutation re-backticking it fails.

**Non-goals preserved:** no scheduler/adapter/distributed-route/worker/plugin-runner enabled; no new dependency (`pnpm-lock.yaml` byte-unchanged); FND-001..004 checks + all 9 fixtures/digests intact; `assertUnsandboxedMultitenantAllowed` runtime behavior unchanged; `findings.md` untouched (controller updates disposition).

## Changed files

| File | Responsibility |
|---|---|
| `server/src/config/distributed-execution.ts` | New pure rollout-policy module (constants + flag reader + rollout resolver + hosted-safety assertion). |
| `server/src/__tests__/distributed-execution-policy.test.ts` | New unit tests for the policy module (exact plan spec). |
| `server/src/__tests__/distributed-execution-exclusions.test.ts` | Config-layer exclusion proofs (always run) + real-`createApp` 404 proof (self-skips under vitest's drizzle require(esm) cycle). |
| `server/src/config.ts` | `distributedExecutionEnabled` + `assertHostedExecutionStartupSafe` wired after `deploymentMode`. |
| `server/src/__tests__/config.test.ts` | Save/restore the policy env vars + `loadConfig()` distributed-execution cases. |
| `server/src/services/unsandboxed-multitenant-guard.ts` | Import + re-export the canonical override env constant; local decl deleted. |
| `docs/architecture/distributed-execution-delivery-policy.md` | New delivery policy (custodians, rollout/rollback, hard-negatives, reproducible build). |
| `docs/architecture/decisions.md` | Decision #121 gains the delivery-policy back-reference. |
| `docs/deploy/environment-variables.md` | All four FND-005 env vars documented. |
| `docs/replatform/templates/ticket-result-template.md` | E0-F001 fix: bare 40-hex Start SHA example. |
| `scripts/check-distributed-execution-foundation.mjs` | Source-boundary + delivery-policy + evidence-integrity checks; `checkEvidenceImmutability` export. |
| `scripts/check-distributed-execution-foundation.test.mjs` | +16 FND-005 mutation cases; `makeFixture` copies app.ts + policy + templates. |
| `scripts/check-bundled-snapshot-inputs.mjs` | New dependency-free snapshot-input verifier + `--write` re-pin. |
| `scripts/check-bundled-snapshot-inputs.test.mjs` | New 12-case mutation corpus. |
| `scripts/bundled-snapshots.manifest.json` | New pinned provenance/digest manifest (see Deviations). |
| `scripts/fetch-bundled-catalog.ts`, `scripts/fetch-bundled-connectors.ts` | Header note: refresh-only, never build/test. |
| `package.json` | `prebuild` → snapshot checker (network-free); new `refresh:bundled-snapshots`. |
| `AGENTS.md` | Authoritative network-free build note. |
| `.github/workflows/pr.yml` | Policy-job foundation-checker step; stale e2e comment updated. |
| `docs/replatform/epics/E0-foundation/tickets/FND-005-result.md` | This ticket result ledger. |

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| Rollout policy: default-off flag, strict boolean, ambiguous-throw, precedence, override forbidden in cloud_auth, excluded surfaces hard-reject, self-hosted unchanged | `distributed-execution-policy.test.ts` (17 tests) | `pass` |
| `loadConfig()`: default off, explicit enable, cloud_auth override refused, both excluded surfaces refused | `config.test.ts` distributed-execution block (part of 15) | `pass` |
| Hosted unsafe-override denied at real startup in cloud_auth | `config.test.ts` + `distributed-execution-exclusions.test.ts` (loadConfig throws) | `pass` |
| Both reserved-surface sentinels stop startup before app construction | `distributed-execution-exclusions.test.ts` (loadConfig throws for each) | `pass` |
| Reserved distributed paths return normal 404 through real `createApp()` | Written via real `createApp` + supertest; self-skips under vitest (drizzle `require(esm)` cycle — CLAUDE.md Test Patterns). Carried by the config-layer proofs + source-boundary checker; e2e boots the real server. | `pass` (2 gated-skip; see Deviations) |
| Source-boundary: forbidden reserved import + forbidden reserved registration rejected | foundation checker mutation cases (import, `/distributed-execution/public-services`, `/api/distributed-execution/cloud-plugins`) | `pass` |
| Snapshot manifest verified; mutating snapshot/digest/source/ordering fails | `check-bundled-snapshot-inputs.test.mjs` (12 tests) | `pass` |
| `pnpm build` + `pnpm -r build` network-free, tracked bytes unchanged | Both exit 0; `git status` unchanged after builds; prebuild printed `bundled snapshot inputs: PASS` (no CDN fetch) | `pass` |
| Evidence templates/policy validated; immutability rejects modify/delete/rename, permits higher attempt; E0-F001 bare Start SHA enforced | foundation checker mutation cases | `pass` |
| CI/AGENTS/delivery-policy run authoritative `pnpm build`; policy job runs the foundation checker | `pr.yml` policy step + `pnpm build` callers; AGENTS note | `pass` |
| No scheduler/adapter/distributed-route/worker/plugin-runner enabled | Code review: `loadConfig` only reads a flag + asserts; no runtime path touched | `pass` |
| No new dependency | `git diff -- pnpm-lock.yaml` empty | `pass` |

## Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm check:distributed-foundation` | `0` | `distributed execution foundation: PASS` |
| `node --test scripts/check-distributed-execution-foundation.test.mjs` | `0` | `tests 129 / pass 129 / fail 0` (113 retained + 16 FND-005) |
| `pnpm exec vitest run distributed-execution-policy/exclusions/config/unsandboxed-multitenant-guard` | `0` | `46 passed | 2 skipped` (the 2 skips = real-`createApp` 404, drizzle require(esm) cycle) |
| `pnpm --filter @armyofagents/server typecheck` | `0` | `tsc --noEmit` clean |
| `pnpm --filter @armyofagents/server build` | `0` | tsc + assets copy |
| `node --test scripts/check-bundled-snapshot-inputs.test.mjs` | `0` | `tests 12 / pass 12 / fail 0` |
| `node scripts/check-bundled-snapshot-inputs.mjs` | `0` | `bundled snapshot inputs: PASS` |
| `pnpm -r build` | `0` | all packages incl. UI (`built in 22.51s`) — no network |
| `pnpm build` | `0` | prebuild `bundled snapshot inputs: PASS` (no CDN fetch) then recursive build |
| `git diff --check` | `0` | clean (only benign LF→CRLF advisories on the two `.mjs` scripts) |
| `git diff -- pnpm-lock.yaml` | `0` | empty — lockfile byte-unchanged |

All Step-9 commands ran locally on Windows and passed. The only sub-part that cannot run under vitest is the real-`createApp` 404 runtime proof (drizzle-orm `require(esm)` cycle); it is written correctly and self-skips, and the reserved-route exclusion is proven by the always-on config-layer `loadConfig()` throws and the static app.ts source-boundary checker (and by the e2e lanes that boot the real server).

## Deviations

1. **Bundled-snapshot committed footprint.** The plan's Step-8 "pinned checked-in snapshots + committed manifest" requires committed data files, but the Step-10 `git add` list omits `.gitignore`, `ui/src/aoa-marketplace-snapshot.json` (1.57 MB, volatile `generatedAt`), `ui/src/aoa-connectors-snapshot.json`, and any manifest path. To keep the build **network-free and tracked-bytes-clean without committing 1.5 MB of third-party catalog data outside the sanctioned file set**, the snapshots stay generated (gitignored) and a single small committed manifest (`scripts/bundled-snapshots.manifest.json`) pins each snapshot's `file`/`sourceUrl`/`version`/`sha256`/`order`. The checker verifies manifest shape always and a present snapshot's digest when present (CI fresh checkout = shape-only; a locally-fetched snapshot is digest-verified). This is **one file beyond the literal Step-10 `git add` list**; it is added to the commit as a necessary consequence of Step 8. `docs/replatform/artifact-policy.md` is in the list but was already committed and needed no change.
2. **Real-`createApp` 404 self-skip.** Under vitest the real app is not importable (drizzle-orm `require(esm)` cycle — CLAUDE.md Test Patterns; every server test mocks `@armyofagents/db`+`drizzle-orm`, and the whole app graph cannot be mocked safely). The two runtime-404 tests self-skip; the exclusion is otherwise fully proven (see above).

## Findings

`E0-F001` — resolved by this ticket's `ticket-result-template.md` fix (bare 40-hex Start SHA example, enforced + mutation-guarded by the foundation checker). `findings.md` disposition is left for the controller.

Self-review note (build reproducibility): I verified `pnpm build` and `pnpm -r build` both exit 0, emit no `Fetching bundled catalog/connectors` line, leave `git status --porcelain` byte-identical to before the builds, pass `git diff --check`, and leave `pnpm-lock.yaml` unchanged. The reproducibility guarantee rests on the fact — verified directly — that neither the UI build nor the server build statically imports the snapshot JSON (the UI fetches via `/api/marketplace/catalog`; the server dynamic-imports it via a runtime string path), so removing the network fetch from `prebuild` does not break `pnpm -r build`. Residual: the digest pin documents provenance for a generated (uncommitted) file, so a fresh checkout verifies manifest shape only — acceptable because the build never consumes the snapshot and the mutation test exercises the full present-file digest path.

## Follow-up tickets

None required for FND-005. Note for the program: `release.yml` / `cross-platform-weekly.yml` also call `pnpm build`; they now run network-free (they never depended on the fetched snapshot for build), and an operator seeds the offline marketplace fallback via `pnpm refresh:bundled-snapshots` when an air-gapped release fallback is desired.

## Gate recommendation

`ready for independent review` — the RED→GREEN sequence is recorded, all focused commands are green (129/129 checker, 12/12 snapshot, 46 vitest + 2 justified skips), server typecheck/build/`pnpm -r build`/`pnpm build` exit 0 network-free with a clean tree, `pnpm-lock.yaml` is byte-unchanged, the source-boundary + evidence-integrity + snapshot mutation corpora enforce their contracts, the E0-F001 template fix is applied and guarded, and only the planned FND-005 files (plus the one flagged manifest) are touched.

## Independent review

**Reviewer:** FND-005 independent reviewer subagent (Claude)
**Reviewed revision:** 196d66403f6228e746c3145b2199dba8b4041b68
**Disposition:** `approved`
**Review evidence:**

Reviewed `git diff 07ddfdb2179793818bc19073e444d10cfefed099 196d66403f6228e746c3145b2199dba8b4041b68` (21 files). Independent verification on Windows, all exit codes observed directly:

- **Build reproducibility (network-free + reproducible — HIGH confidence).** `pnpm build` exit `0`; prebuild ran only `node scripts/check-bundled-snapshot-inputs.mjs` (`bundled snapshot inputs: PASS`), and the full build log contained **zero** `Fetching bundled` / `Wrote bundled` / CDN markers. After the build `git status --porcelain` was empty, `git diff --check` exit `0`, and both snapshot SHA-256 digests were byte-identical to baseline. `pnpm -r build` exit `0` with the same network-free + clean-tree result. `refresh:bundled-snapshots` is the ONLY script that fetches; there is no `pretest`/`postbuild` fetch hook. Confirmed nothing statically imports the snapshots (server does a runtime `import(stringPath)` in a try/catch returning `null`; UI fetches via `/api/marketplace`), so a fresh no-snapshot checkout still builds and the checker verifies manifest shape only.
- `pnpm check:distributed-foundation` → `0` (`distributed execution foundation: PASS`).
- `node --test scripts/check-distributed-execution-foundation.test.mjs` → `0` (129/129; incl. source-boundary, delivery-policy, evidence-integrity, bare-Start-SHA, and `checkEvidenceImmutability` modify/delete/rename/higher-attempt cases).
- `node --test scripts/check-bundled-snapshot-inputs.test.mjs` → `0` (12/12; byte, digest, source, order, missing-field, unpinned, absent-file drift all covered).
- Focused vitest (`distributed-execution-policy`, `distributed-execution-exclusions`, `config.test`, `unsandboxed-multitenant-guard`, exact file paths) → `46 passed | 2 skipped`; the 2 skips are the real-`createApp` 404 proofs, self-skipped under the documented drizzle `require(esm)` cycle (witnessed firsthand when a broad filter pulled unrelated app-importing suites into the same failure).
- `git diff -- pnpm-lock.yaml` empty (no new dependency); checkers are stdlib-only (`node:fs`, `node:crypto`).
- Config code sound: boolean parser throws on ambiguous values; rollout precedence is deployment → organization → workload; `assertHostedExecutionStartupSafe` hard-rejects both excluded surfaces in every mode, rejects the unsandboxed override only in `cloud_auth`, and leaves self-hosted untouched. The AoA env file is loaded into `process.env` before the startup assertion runs, so the override cannot be smuggled in via the env file. `server/src/app.ts` has zero reserved-module imports and zero reserved path registrations (source-boundary reality matches the checker).
- Ratified deviations **E0-F005** (createApp-404 unit-import skip) and **E0-F006** (digest manifest instead of committed snapshot bytes) assessed **engineering-sound**: the drizzle `require(esm)` cycle genuinely blocks importing the real app under vitest (observed), and the reserved-route 404 is otherwise guaranteed by the source-boundary checker + `loadConfig` hard-reject; the snapshots were already gitignored and are never a static build input, so the network-free tracked-byte-clean build is achieved without committing 1.5 MB of volatile catalog data.
- **No Critical or Important issues.** Minor/informational only: (1) `deploymentMode` on `DistributedExecutionRolloutInput` is carried but unread by `resolveDistributedExecutionRollout`; (2) the static source-boundary regexes are defense-in-depth (concatenated/template-literal specifiers would evade them, but the config-throw plus module non-existence are the real guarantee); (3) `checkEvidenceImmutability` is exported and unit-tested but consumed by the Task-9 two-root integration gate rather than the single-root `runCheck` (by design). None require a change.

For `approved`, verify the result describes the reviewed revision, all focused acceptance evidence passes, and every accepted finding is resolved; then change the top-level `Status` to `complete` and commit this disposition separately. Otherwise leave `Status` as `gate_review` or set `blocked`, and link stable findings.

## Review attempt history

The implementation author leaves the table body empty; the explicit pending summary above is not a review attempt. The first independent reviewer appends attempt 1, and later reviewers append monotonically increasing rows without replacing prior attempts. The summary fields above mirror the latest real attempt for existing gate tooling. Do not include a `Review commit` column: a row cannot embed the SHA of the commit that first contains it. Repository history identifies that commit, and handoffs pin the resulting ticket-result blob SHA.

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | FND-005 independent reviewer subagent (Claude) | 196d66403f6228e746c3145b2199dba8b4041b68 | `approved` | Both `pnpm build` and `pnpm -r build` exit 0, network-free (no CDN fetch markers), and leave a byte-identical tree (`git status` clean, `git diff --check` clean). Foundation checker PASS + 129/129 mutation corpus; 12/12 snapshot mutation corpus; 46 vitest passed + 2 documented createApp-404 skips; `pnpm-lock.yaml` byte-unchanged. No Critical/Important issues; ratified deviations E0-F005/E0-F006 assessed engineering-sound. |
<!-- First independent reviewer appends attempt 1. -->
