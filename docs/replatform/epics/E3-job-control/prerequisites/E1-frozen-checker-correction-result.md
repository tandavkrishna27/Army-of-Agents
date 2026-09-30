# Prerequisite P2 Result - E1 frozen-consumer checker correction

**Status:** `complete`
**Disposition:** `pass`
**Date (UTC):** `2026-08-10`
**Implementer:** `Codex implementer agent (/root/e1_checker_correction_impl)`
**Start SHA:** `baf903bc982c7580b6955b69c624fb6dcab570ae`
**Candidate code revision:** `4fa9df3f08452509f24c94681df73a8909451684`
**Reviewed revision:** `01ad1ab554fe25c5178c7552ec047d4df45b7dcf`
**Fix-round 1 RED revisions:** `eef4db2588505b61ffee0fc864792e3fd8873fa4`, `193cea335cec8cb9b3ed423bdb62bffb9c638a92`
**Fix-round 1 candidate code revision:** `127247f54271bc951db04ea50c016cf4d49e0d66`
**Fix-round 2 RED revision:** `4ffd5e0d822e8d3b3a763bca47f1c3c621072480`
**Fix-round 2 candidate code revision:** `7d649a01802bc2062e91ded370ec7d6385c72931`
**Scope:** Corrective E1 checker/test/evidence work only. No frozen v1 byte, worker-protocol source/schema/bundle, dependency version, or E3 ticket behavior changed.

Distinct review attempts 1 and 2 requested changes. Review attempt 3 approves the
exact fix-round 2 evidence revision. P2 is complete and no longer blocks JOB-001;
this corrective record does not itself implement any E3 ticket.

## Candidate behavior

- The CLI reads `packages/worker-protocol/package.json` and `pnpm-lock.yaml` as raw Git blobs at the fixture-recorded E1 source commit.
- Recorded package/lock SHA-256 values and the Zod/esbuild importer evidence are checked against those immutable blobs, not the later consumer checkout or installed dependencies.
- Missing source commits, source trees, or source blobs fail closed with the missing object/path and a fetch/retry action.
- Existing frozen manifest, bundle, declaration, no-runtime-dependency, path-leak, and isolated server/worker smoke checks remain enforced.
- Git-byte checks are independent of working-tree LF/CRLF conversion and pass in a clean clone with no `node_modules`.

## Strict TDD evidence

### RED

1. Before the correction, `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870ce7509d8baa75409e0ab19da375c88a` exited `1`: the working-tree CRLF bytes made the recorded `packageIntegrity` and `lockfileIntegrity` appear stale even though the corresponding Git blobs were unchanged.
2. With the new behavior tests present and the old checker intact, `node --test scripts/check-frozen-worker-protocol-consumer.test.mjs` exited `1`, `12 passed / 7 failed`. The failures proved coupling to a later consumer lock/manifest and installed versions, CRLF dependence, missing commit/blob fail-open behavior, undetected Zod/esbuild source-snapshot mutations, and clean-clone dependence on installed Zod.
3. Before adding the two source-blob digest comparisons, the expanded integrity corpus exited `1`, `19 passed / 2 failed`; mutations to recorded `packageIntegrity` and `lockfileIntegrity` were incorrectly accepted.

### GREEN candidate

| Command | Outcome |
|---|---|
| `node --test scripts/check-frozen-worker-protocol-consumer.test.mjs` | exit `0`, `21/21` |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870ce7509d8baa75409e0ab19da375c88a` | exit `0`; Zod `3.24.2`, esbuild `0.28.1` |
| `node --test scripts/check-worker-protocol-boundary.test.mjs` | exit `0`, `50/50` |
| `pnpm check:worker-protocol-boundary` | exit `0` |
| `node scripts/check-worker-protocol-package.mjs` | exit `0` |
| `node scripts/update-worker-protocol-contract-manifest.mjs --check` | exit `0` |
| worker-protocol typecheck/build | both exit `0` |
| `pnpm -r typecheck` | exit `0`, 24/25 workspace projects |
| `pnpm build` | exit `0` |
| `pnpm --filter @armyofagents/worker-protocol test:run` | exit `1`: `16` files / `490` tests passed; only the documented Windows collection failure at `cross-version.test.ts:12` failed before collection |
| `pnpm test:run` | exit `1` on the same sole Windows collection failure; not converted into a pass. Linux CI remains DEC-03 authority |

The full repository command was run twice; the local tool truncated the aggregate Vitest count block, so this ledger does not invent a current aggregate count. No second failed suite was reported.

## Immutable evidence

| Evidence | SHA / identity |
|---|---|
| Frozen E1 source commit | `b7a842870ce7509d8baa75409e0ab19da375c88a` |
| Source `packages/worker-protocol/package.json` Git-blob SHA-256 | `41acbb809c75647931a0cd891d92a6065cbd55f6609fbbc36937bca37f1291bb` |
| Source `pnpm-lock.yaml` Git-blob SHA-256 | `134169fe9cf4edecafc6b5c698eb251795a10da8bb69ac30dfbca58e451da426` |
| Frozen bundle SHA-256 | `3c854028f3f1c0e7a792bda328515dc4c801e41bf0b0f3c3ee79a3ac7b7294e9` |
| Frozen fixture Git tree at start and candidate | `e62b3b2977fdd69a20ea62a0be30ecd858aafa20` |
| `packages/worker-protocol` Git tree at start and candidate | `73aeaaeebefeabf660bf8e5a5ff809184fe2e33a` |

`git diff --exit-code baf903bc982c7580b6955b69c624fb6dcab570ae -- packages/worker-protocol tests/fixtures/worker-protocol-consumers/v1 docs/contracts/worker-protocol/v1 scripts/freeze-worker-protocol-consumer.mjs` exits `0`.

## Changed files

- `scripts/check-frozen-worker-protocol-consumer.mjs`
- `scripts/check-frozen-worker-protocol-consumer.test.mjs`
- This result ledger, E1-F008, and the awaiting-review QA/handoff records for the correction

## Review attempt 1 - needs_changes

**Reviewer:** `Codex distinct reviewer (/root/e1_checker_correction_review)`
**Reviewed revision:** `c90908281b43ef5e2fba319d828ed1958ca3bb60`
**Spec verdict:** `fail`
**Quality/security verdict:** `fail`
**Disposition:** `needs_changes`

### Blocking findings

1. **P1 - coordinated frozen bundle and manifest mutation is accepted.** `scripts/check-frozen-worker-protocol-consumer.mjs:143-155` recomputes the manifest and compares it only with the manifest stored beside the bytes it authenticates. The immutable-source check at lines 345-408 anchors the package/lock/dependency evidence but never anchors the frozen fixture, manifest, schema declarations, or bundle to an immutable Git object. In an isolated `--no-local` clean clone of the reviewed revision, the reviewer appended a harmless export to `dist/index.js`, updated the matching `manifest.sha256` line, and ran the actual checker at `b7a842870ce7509d8baa75409e0ab19da375c88a`; it exited `0` with `OK`. This violates the brief's requirement that frozen bundle/fixture mutations fail.
2. **P2 - Git replacement refs can substitute the recorded source commit.** The `git cat-file` calls at `scripts/check-frozen-worker-protocol-consumer.mjs:254-269` honor `refs/replace`. In another isolated clone, the reviewer replaced the recorded source commit with commit `2252845f93dc3a3cc6876ae6feab94ce8a598796`, whose tree mutates `packages/worker-protocol/src/version.ts` while preserving package/lock evidence. The apparent source tree changed from `3ea185d9d6fab12b221d8f477f03a1515e3781b3` to `fbe91e153c1f87615b5ebafe40504636fbef5b3c`; the checker still exited `0` under the original source SHA.
3. **P2 - unauthenticated fixture code executes before static failures are emitted and has no timeout.** The CLI gathers static/source errors at lines 448-462, but always imports the fixture at lines 464-468; `smokeImport` at lines 413-424 has no timeout. A controlled invalid-manifest probe proved a top-level sentinel in the tampered bundle executed in both server and worker children after the manifest mismatch was already known. A hostile mutation can therefore run or hang verification even though the fixture has failed authentication.
4. **P2 - the focused test harness inherits global Git signing and leaks temp repositories on setup failure.** `initSourceRepo` commits at `scripts/check-frozen-worker-protocol-consumer.test.mjs:132-147` without disabling inherited `commit.gpgSign`, and `withSourceRepo` calls setup before entering `try/finally` at lines 196-202. With `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=commit.gpgSign`, and `GIT_CONFIG_VALUE_0=true`, the corpus exited `1` on GPG signing failures and left nine new `frozen-wp-git-*` directories in the OS temp directory.

Non-blocking coverage/maintenance gaps: the missing-tree branch at checker lines 355-357 has no direct case (the corpus covers an unavailable commit and missing lock blob), and the header at lines 13-16 inaccurately calls the Git-subprocess-backed source-snapshot verifier a pure helper.

### Independent acceptance evidence

| Command / probe | Outcome |
|---|---|
| Exact review package compared with `git diff --no-ext-diff --no-color --unified=10 baf903bc982c7580b6955b69c624fb6dcab570ae c90908281b43ef5e2fba319d828ed1958ca3bb60` | byte-identical package, exit `0` |
| `node --check` for checker and focused test | both exit `0` |
| `node --test scripts/check-frozen-worker-protocol-consumer.test.mjs` | exit `0`, `21/21` under default local Git configuration |
| Actual checker at recorded `b7a842...` | exit `0`, Zod `3.24.2`, esbuild `0.28.1` |
| Later consumer/root-lock drift, CRLF, unavailable commit/blob, Zod/esbuild, package/lock-integrity, and no-`node_modules` clean-clone cases | present in and pass the 21-case corpus |
| Coordinated bundle + regenerated manifest probe | **incorrect exit `0`** (`OK`) |
| Recorded-source Git replacement-ref probe | **incorrect exit `0`** (`OK`) |
| Invalid-manifest executable sentinel probe | exit `1`, but sentinel executed twice before rejection |
| Focused corpus with inherited `commit.gpgSign=true` | exit `1`; nine temp repositories leaked |
| Worker-protocol boundary Node suite / boundary CLI | exit `0`, `50/50` / exit `0` |
| Package smoke / contract-manifest check | both exit `0` |
| Worker-protocol typecheck / build | both exit `0` |
| Worker-protocol tests | exit `1`; `16` files and `490` tests passed, sole failed suite was the documented Windows collection SyntaxError at `src/cross-version.test.ts:12` |
| `pnpm -r typecheck` / `pnpm build` | both exit `0` |
| `pnpm test:run` | exit `1`; sole failed suite was the same Windows `src/cross-version.test.ts:12` collection SyntaxError; Linux CI remains DEC-03 authority |
| `git diff --check baf903bc982c7580b6955b69c624fb6dcab570ae c90908281b43ef5e2fba319d828ed1958ca3bb60` | exit `0` |

Direct base/head object comparison is clean: worker-protocol tree `73aeaaeebefeabf660bf8e5a5ff809184fe2e33a`, frozen-fixture tree `e62b3b2977fdd69a20ea62a0be30ecd858aafa20`, protocol source tree `a932ba4bec9dc7b96dd51b1670de92976ceeee69`, frozen bundle blob `260bf29edefb138a37bdfd28e68ceba95f3fdc38`, package blob `51dc7b2c67a1b60884219144a353b7e14e2162b3`, and lock blob `eed4aa6ac1559fff2b9f0788f735fe2473462df1` are unchanged between the base and reviewed head.

### Decision

The immutable boundaries themselves are unchanged and the intended later-consumer/CRLF/dependency correction works, but the checker does not enforce the complete frozen-artifact mutation contract and is unsafe against replacement refs and invalid executable fixture bytes. P2 remains in `gate_review` with `needs_changes`. The awaiting-review E1 QA/handoff are not finalized or superseded by pass artifacts.

## Fix round 1 candidate - awaiting distinct re-review

This section records implementer-observed corrective evidence only. The result remains
`gate_review` / `needs_changes`; it is not a pass and does not authorize JOB-001.

### Strict TDD evidence

- RED revision `eef4db2588505b61ffee0fc864792e3fd8873fa4` produced `22 passed / 7 failed` across 29 cases. The seven expected failures exposed coordinated bundle/manifest and schema/manifest mutation acceptance, replacement-ref substitution, invalid-code execution, the missing bounded-smoke API, inherited signing failure, and setup-time temp-repository leakage.
- RED revision `193cea335cec8cb9b3ed423bdb62bffb9c638a92` added exact non-commit object-type behavior and failed because a blob source SHA was reported only as unavailable.
- GREEN revision `127247f54271bc951db04ea50c016cf4d49e0d66` passes the expanded `30/30` focused corpus while retaining all original 21 cases.

### Candidate correction

1. The fixture is authenticated against exact raw Git blobs under freeze commit `c68053421ac53c5b49066b041c8fbcdd920dad62`, whose sole parent is the recorded E1 source commit `b7a842870ce7509d8baa75409e0ab19da375c88a` and whose fixture tree is `e62b3b2977fdd69a20ea62a0be30ecd858aafa20`. Coordinated bundle/manifest and schema/manifest regeneration now fail without changing or re-blessing any frozen byte.
2. Every verifier Git lookup supplies both `--no-replace-objects` and `GIT_NO_REPLACE_OBJECTS=1`; the checker also rejects replacement refs for the source or anchor SHA. A real `refs/replace` adversarial case proves a substituted source tree cannot pass, and recorded source objects must have exact type `commit`.
3. Static fixture, immutable-source, dependency, and anchor checks complete before fixture import. Smoke execution is an isolated child with a 5-second production timeout, `SIGKILL`, bounded captured output, and explicit failure diagnostics. The corpus proves an invalid sentinel never executes and an infinite-loop fixture is terminated at the focused 100 ms timeout.
4. Synthetic repositories disable commit/tag signing explicitly, use `--no-gpg-sign`, and place initialization inside cleanup boundaries. The reproduced `commit.gpgSign=true` environment passes, and a forced setup failure leaves no `frozen-wp-git-*` temp repository.

### Fix-round verification

| Command | Outcome |
|---|---|
| Checker/test `node --check` | both exit `0` |
| Focused checker corpus | exit `0`, `30/30` |
| Actual checker at `b7a842...` | exit `0`; Zod `3.24.2`, esbuild `0.28.1` |
| Boundary Node suite / boundary CLI | exit `0`, `50/50` / exit `0` |
| Package smoke / contract-manifest check | both exit `0` |
| Worker-protocol typecheck / build | both exit `0` |
| Worker-protocol tests | exit `1`; `16` files and `490` tests passed, with only the documented Windows collection SyntaxError at `cross-version.test.ts:12` |
| `pnpm -r typecheck` / `pnpm build` | both exit `0` |
| `pnpm test:run` | exit `1`; the known Windows `cross-version.test.ts:12` collection failure plus a full-load 30-second `cloud-plugin-process-composition.test.ts` setup timeout |
| Isolated cloud-plugin process-composition lane | exit `0`, `7/7` in about 8 seconds, showing the full-load timeout is not a fix-round behavioral failure |

The immutable/protected diff against `baf903bc982c7580b6955b69c624fb6dcab570ae`
still exits `0`. No worker-protocol source/schema/bundle, frozen fixture, contract,
dependency manifest/lockfile, freeze script, or E3 ticket implementation changed.

Distinct review must inspect the exact evidence revision and issue the only
authoritative pass/needs-changes decision.

## Review attempt 2 - needs_changes

**Reviewer:** `Codex distinct reviewer (/root/e1_checker_correction_review)`
**Reviewed revision:** `2bf5297b66a314858954dbdd3e53c320fba9af25`
**Spec verdict:** `fail`
**Quality/security verdict:** `fail`
**Disposition:** `needs_changes`

### Prior-blocker disposition

1. **Coordinated frozen artifact plus manifest self-authentication: resolved.** Freeze anchor `c68053421ac53c5b49066b041c8fbcdd920dad62` is an exact commit with sole parent `b7a842870ce7509d8baa75409e0ab19da375c88a`, and its frozen fixture tree is `e62b3b2977fdd69a20ea62a0be30ecd858aafa20`. An independent clone with coordinated bundle and schema changes plus a regenerated, internally consistent manifest exited `1` with immutable-anchor mismatches for both artifacts and the manifest.
2. **Replacement-object substitution: resolved.** Independent real `refs/replace` probes targeting the source commit and the freeze anchor each exited `1` with the correct replacement-ref diagnostic. Replacement-disabled object checks preserve both canonical identities.
3. **Invalid fixture execution and unbounded smoke: resolved for ordering, timeout, and output bound.** The coordinated-mutation sentinel was not created. An infinite-loop module was killed in about `110ms` at a `100ms` test timeout. A module emitting more than the `1 MiB` cap returned a bounded `ENOBUFS` failure in about `41ms`.
4. **Inherited Git signing and setup-failure leakage: resolved serially.** The complete corpus under inherited `commit.gpgSign=true` passed `30/30`; the forced setup-failure case passed and produced zero new `frozen-wp-git-*` or `frozen-wp-real-clone-*` directories.

### New Important findings

1. **P2 - the promised empty smoke-child environment is not empty on Windows.** `scripts/check-frozen-worker-protocol-consumer.mjs:569-576` passes `env: {}`, but an independently imported valid probe observed eleven child environment keys on this supported Windows lane: `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, and `WINDIR`. Arbitrary parent values such as `REVIEW_PARENT_SECRET`, `NODE_OPTIONS`, and `NODE_PATH` were excluded, but the explicit empty-environment guarantee and isolation claim are false. The child wrapper must clear `process.env` before a dynamic import, then test zero keys on Windows.
2. **P2 - cleanup can delete another concurrent run's live temporary repository.** `scripts/check-frozen-worker-protocol-consumer.test.mjs:249-257` snapshots the shared OS temp namespace, treats every newly observed `frozen-wp-git-*` directory as its own leak, and recursively removes it. Calls at lines 573 and 590 therefore have no ownership boundary. Two staggered parallel targeted corpus processes independently reproduced the race: both reported `EPERM` at line 256 while attempting to remove the other process's live repository, and failed their signing/cleanup cases. Cleanup must be scoped to a unique per-test parent or exact path created by that test.

### Independent focused acceptance

| Command / probe | Outcome |
|---|---|
| Exact scoped package `## Diff` vs fresh unified-10 `c90908281..2bf5297b6` diff | byte-identical, SHA-256 `46bcb0057f189a92644de85e979173247ccfc84a6743b9824fbae0c25706092c` |
| Checker/test `node --check` | both exit `0` |
| Full focused corpus | exit `0`, `30/30` |
| Focused corpus with inherited `commit.gpgSign=true` | exit `0`, `30/30`; zero new matching temp directories |
| Actual checker at recorded source SHA | exit `0`; Zod `3.24.2`, esbuild `0.28.1` |
| Coordinated bundle + schema + regenerated manifest + sentinel | exit `1`; both artifacts rejected by anchor; sentinel absent |
| Real source and freeze-anchor replacement refs | both exit `1` with actionable diagnostics |
| Timeout / output cap | `100ms` hang terminated in about `110ms`; over-cap output failed with bounded `ENOBUFS` diagnostic |
| Empty child environment | **fails on Windows:** eleven OS/user-path keys present; custom sensitive/test values excluded |
| Two staggered parallel signing/cleanup cases | **fail:** cross-run `EPERM` removal race at test line 256 |
| Clean `--no-local` clone | no `node_modules`; deterministic double invocation passes in the 30-case corpus |
| Boundary Node suite / boundary CLI | exit `0`, `50/50` / exit `0` |
| Package smoke / contract-manifest check | both exit `0` |
| Worker-protocol typecheck / build | both exit `0` |
| Worker-protocol tests | exit `1`; `16` files and `490` tests pass, with only the documented Windows `src/cross-version.test.ts:12` collection SyntaxError |
| `pnpm -r typecheck` / `pnpm build` | both exit `0`, 24/25 workspace projects |
| Scoped `git diff --check` | exit `0` |

The protected diff remains empty. Base/head identities are unchanged: worker-protocol tree `73aeaaeebefeabf660bf8e5a5ff809184fe2e33a`, frozen fixture and anchor tree `e62b3b2977fdd69a20ea62a0be30ecd858aafa20`, contract tree `7d895c4cb71e8b45b810b99f09dcc6ce37866a60`, protocol source tree `a932ba4bec9dc7b96dd51b1670de92976ceeee69`, bundle blob `260bf29edefb138a37bdfd28e68ceba95f3fdc38`, package blob `51dc7b2c67a1b60884219144a353b7e14e2162b3`, and lock blob `eed4aa6ac1559fff2b9f0788f735fe2473462df1`.

### Decision

All four attempt-1 blockers are substantively addressed, but the fix round introduces two independently reproduced Important issues within the requested re-review scope. P2 remains `gate_review` / `needs_changes`; E1-F008 remains open; the a4 awaiting-review QA/handoff are not finalized; no pass artifacts or E3 authorization are issued.

## Fix round 2 candidate - awaiting distinct re-review

This section is implementer-observed evidence only. The result remains
`gate_review` / `needs_changes`; it is not a pass and does not authorize JOB-001.

### Strict TDD evidence

- RED revision `4ffd5e0d822e8d3b3a763bca47f1c3c621072480` adds a valid smoke module that reports `Object.keys(process.env)`. On the unchanged Windows implementation it failed with the same eleven visible keys found in review: `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, and `WINDIR`.
- The same RED revision adds a separate staggered process-isolation suite. Against the unchanged harness, its first complete child corpus passed `30/30` but exited without publishing a unique owned parent/live repository, so the regression failed on the missing ownership boundary before any implementation change.
- GREEN revision `7d649a01802bc2062e91ded370ec7d6385c72931` passes both new isolation cases, the unchanged focused corpus, and the signing-config corpus.

### Candidate correction

1. The smoke child still starts through absolute `process.execPath`, with an absolute module URL, `env: {}`, fixture-local cwd, 5-second timeout, `SIGKILL`, and 1 MiB output cap. Its wrapper now deletes every JavaScript-visible `process.env` key before dynamically importing the authenticated fixture. The valid probe sees exactly zero keys both on the Windows host and in a local Linux Node 24 container. Parent `REVIEW_PARENT_SECRET`, `NODE_OPTIONS`, and `NODE_PATH` remain absent.
2. Every focused-corpus process creates one unique `frozen-wp-corpus-run-*` parent. All fixture, synthetic Git, clone, and hang paths are created only beneath that parent. Leak assertions compare only the owned parent's children; the shared OS-temp prefix sweep and foreign recursive deletion are gone. A suite-level hook removes only the parent's exact path.
3. The staggered regression launches two full `30/30` processes with distinct parents. Each publishes its first live Git repository. Process A completes while process B remains blocked; B's repository and `.git/HEAD` remain present. Both processes then exit `0`, both exact owned parents are absent, and only the outer test's four expected coordination files remain before its own cleanup.

### Fix-round 2 verification

| Command | Outcome |
|---|---|
| Checker and both test files `node --check` | all exit `0` |
| Default focused corpus | exit `0`, `30/30` |
| Focused corpus with inherited `commit.gpgSign=true` | exit `0`, `30/30` |
| Process-isolation suite | exit `0`, `2/2`; zero environment keys plus two staggered complete `30/30` child corpora |
| Linux Node 24 zero-environment probe | exit `0`, `1/1` in the locally available `node:24-bookworm` container |
| Actual checker at `b7a842...` | exit `0`; Zod `3.24.2`, esbuild `0.28.1` |
| Boundary Node suite / CLI | exit `0`, `50/50` / exit `0` |
| Package smoke / contract-manifest check | both exit `0` |
| Worker-protocol and recursive repository typecheck/build | all exit `0`; recursive lanes cover `24/25` projects |
| Worker-protocol tests | exit `1`; `16` files / `490` tests pass, sole failed suite is the documented Windows `cross-version.test.ts:12` collection SyntaxError |
| `pnpm test:run` | exit `1` after about 175.5 seconds; the same Windows `cross-version.test.ts:12` collection SyntaxError is the sole failed suite in this fresh run |
| Protected immutable diff / scoped diff check / owned-temp audit | all clean |

The full 30-case corpus retains coordinated artifact/manifest, replacement-ref,
invalid-sentinel, timeout, dependency, CRLF, missing-object, clean-clone, and later
consumer coverage. No resolved checker security behavior was reopened.

No worker-protocol source/schema/bundle, frozen fixture byte, v1 contract, dependency
manifest/lockfile, freeze script, or E3 ticket implementation changed. Distinct review
must issue the only authoritative pass/needs-changes decision.

## Review attempt 3 - pass

**Reviewer:** `Codex distinct reviewer (/root/e1_checker_correction_review)`
**Reviewed revision:** `01ad1ab554fe25c5178c7552ec047d4df45b7dcf`
**Spec verdict:** `pass`
**Quality/security verdict:** `pass`
**Disposition:** `pass`

### Attempt-2 finding disposition

1. **Zero JavaScript environment: resolved.** The smoke wrapper at
   `scripts/check-frozen-worker-protocol-consumer.mjs:558-577` deletes every
   JavaScript-visible environment key before a dynamic import while retaining an
   absolute executable/module path, fixture-local cwd, empty spawn environment,
   timeout/kill, and output cap. Independent Windows and Linux hostile probes observed
   zero keys, no parent secret, no `NODE_OPTIONS` preload execution, and no
   `NODE_PATH` resolution state.
2. **Cross-process temp ownership: resolved.** The focused corpus at
   `scripts/check-frozen-worker-protocol-consumer.test.mjs:29-39` creates one unique
   parent per process and allocates every fixture/repository below it. The staggered
   regression at `scripts/check-frozen-worker-protocol-consumer-isolation.test.mjs:121-166`
   ran two complete `30/30` child corpora: A completed and removed only its parent while
   B's live `.git/HEAD` remained, then B completed and removed its own parent. Two
   unrelated shared-temp sentinels survived unchanged.

### Independent focused acceptance

| Command / probe | Outcome |
|---|---|
| Exact scoped package `## Diff` vs fresh unified-10 `2bf5297b6..01ad1ab55` diff | byte-identical; SHA-256 `4c78460221ccd42a916cdaef89b0238105189d88ed67af32783a5161386037b8` |
| Checker, main corpus, isolation corpus `node --check` | all exit `0` |
| Default focused corpus | exit `0`, `30/30` |
| Focused corpus with inherited `commit.gpgSign=true` | exit `0`, `30/30` |
| Staggered process-isolation suite | exit `0`, `2/2`; both child corpora `30/30`; A cannot remove B; both owned parents absent; two unrelated sentinels intact |
| Windows hostile environment probe | zero keys; parent secret absent; `NODE_OPTIONS` preload absent; `NODE_PATH` resolution absent |
| Linux Node 24 container environment test / hostile probe | exit `0`, `1/1`; same zero-key and injection-isolation result |
| Actual checker at recorded source SHA | exit `0`; Zod `3.24.2`, esbuild `0.28.1` |
| Coordinated bundle/schema/manifest, invalid sentinel, timeout, later-consumer, CRLF, missing-object, dependency, and clean-clone cases | all pass within the focused `30/30`; clean clone has no `node_modules` and double invocation is deterministic |
| Real source and freeze-anchor replacement refs | both exit `1` with the required replacement-ref diagnostic |
| Output-cap probe | over `1 MiB` fails via bounded `ENOBUFS` in about `52ms`; diagnostic length `108` |
| Boundary Node suite / boundary CLI | exit `0`, `50/50` / exit `0` |
| Package smoke / contract-manifest check | both exit `0` |
| Worker-protocol typecheck / build | both exit `0` |
| `pnpm -r typecheck` / `pnpm build` | both exit `0`, 24/25 workspace projects |
| Worker-protocol tests | exit `1` on the documented Windows-local `src/cross-version.test.ts:12` collection SyntaxError; `16` files and all `490` collected tests pass |
| Protected immutable diff / scoped diff check | both exit `0` |
| Post-run owned-parent audit | zero `frozen-wp-corpus-run-*` and zero `frozen-wp-isolation-run-*` parents |

The package-test collection error is recorded as a Windows-local non-pass and is not
converted into a green local command. Linux CI remains the formal DEC-03 authority.
The correction's dependency-free checker, Windows/Node lane, and local Linux Node 24
container lane were exercised independently.

### Immutable-anchor proof

Replacement-disabled Git confirms source `b7a842870ce7509d8baa75409e0ab19da375c88a`
and anchor `c68053421ac53c5b49066b041c8fbcdd920dad62` are exact commit objects. The anchor
has exactly that source as its sole parent. Anchor/base/reviewed-head fixture tree is
`e62b3b2977fdd69a20ea62a0be30ecd858aafa20`; base/head worker-protocol tree is
`73aeaaeebefeabf660bf8e5a5ff809184fe2e33a`; base/head v1 contract tree is
`7d895c4cb71e8b45b810b99f09dcc6ce37866a60`; and anchor/base/head bundle blob is
`260bf29edefb138a37bdfd28e68ceba95f3fdc38`. The protected diff also includes the
freeze script, root/package manifests, and `pnpm-lock.yaml` and is empty.

### Non-blocking quality observation

The isolation regression's emergency failure cleanup releases and immediately kills
the test-runner controller. A specialist noted that an abnormal assertion/timeout could
temporarily leave the controller's test-file subprocess running until its own bounded
completion. This does not affect the successful two-corpus proof, production checker,
owned cleanup contract, or any required acceptance result, and no leftover parent was
observed. It is informational rather than Critical/Important.

### Decision

Both attempt-2 blockers are fixed, every retained hostile case passes, no new
Critical/Important issue was found, and the frozen/protocol/dependency boundaries are
unchanged. Prerequisite P2 is `complete` / `pass` on reviewed revision
`01ad1ab554fe25c5178c7552ec047d4df45b7dcf`. E1-F008 is resolved. The immutable a6
QA and completion handoff carry the same reviewed revision. No E3 implementation is
part of this evidence commit.
