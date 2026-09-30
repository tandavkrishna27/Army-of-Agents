# DSK-001 — Desktop enrollment and OS key storage

**Epic:** E10 — Desktop / migration / realtime
**Depends on:** JOB-002, JOB-009, WRK-002, DAT-004
**Program spec:** `docs/replatform/program-design.md:894-899`
**Gates:** `docs/replatform/test-gates.md:215` (DSK-00), `:217-228` (DSK-01..10, conditional)
**Status:** design, pre-implementation. Nothing in this document has been built.

---

## 1. Scope + framing

### 1.1 The framing decision

The ticket text bundles five deliverables. Four of them have no host, no channel, or no artifact to act on. One is reachable today against a complete, landed server surface. This design ships the reachable one properly, delivers the ports the other four will need, and proves the disabled posture — and it says out loud which acceptance clauses that leaves unmet.

Three facts set the shape.

**(a) Three of the four "disables AoA use" clauses are already enforced, per-operation, at one chokepoint.** `server/src/middleware/worker-session-auth.ts:158-165` re-checks against live DB on *every* worker operation: `target.status === "disabled"`, `worker.status === "revoked"`, `worker.revokedAt !== null`, `!current.ownerMembershipActive`, `target.deviceGeneration !== claims.generation`, `worker.deviceGeneration !== claims.generation`. So *revocation*, *target replacement*, and *owner membership loss* are closed at the authority layer. DSK-001's job on those three is **prove, not build**, and the proof is cheap because there is one function to point a test at.

What is genuinely missing on the owner-binding axis is upstream of that chokepoint: `issueTenantCode` (`server/src/services/worker-enrollment.ts:195-229`) validates only the scope↔`ownerUserId` pairing and the existence of an ACTIVE target row — it never checks that `ownerUserId` is still an active organization member. An admin can mint a valid 10-minute enrollment ticket for a user removed from the org yesterday, and that device enrolls. DSK-001 closes that (D11).

**(b) "Credential values never leave the OS store" must be won by unrepresentability, not by scanning.** `packages/worker-protocol/src/wire-safety.ts:45-59` inspects key *names* by whole-normalized-key equality against 12 entries (`:18-31`) and never looks at a value — empirically, `findForbiddenWireKeys({ keychainAccount: "sk-live-abc" })` returns `[]`. The only value-level scrubber, `scrubEventStrings` (`packages/worker-daemon/src/supervisor/redaction.ts:64-70`), is **inert in production**: every non-test construction passes `redactionCanaries ?? []` (`supervisor/supervisor.ts:281-284`, `lease/fence-close-proxy.ts:107-128`) and it returns the input unchanged at zero needles. A scanner-based defence would be theatre. The durable guarantee is DAT-004's existing shape — `DeviceLocalHandoff` (`server/src/services/secret-broker.ts:85-92`) has no `value` field and `dispatchResolvedSecret` short-circuits `device_local` before any broker (`:138-151`). DSK-001 *extends* that shape and never adds a value-bearing field. Because the value never enters daemon process memory, DSK-001 seeds nothing into `redactionCanaries`: the correct answer to an inert scrubber is to arrange for there to be no bytes.

**(c) The single highest-probability catastrophic bug is a fail-open key store, and it was re-measured
first-hand — the result is worse than a simple fail-open.** Controller measurement on this machine
(Windows PowerShell 5.1), tampering the HMAC region of a `ProtectedData.Protect` blob so
`Unprotect` raises a genuine `CryptographicException` ("The data is invalid"):

| Invocation shape | Exit code | stdout |
|---|---|---|
| `powershell.exe -NoProfile -EncodedCommand <b64>` | **1** | empty |
| `powershell.exe -NoProfile -File <script.ps1>` | **0** | empty |

So the failure signal is **invocation-shape dependent**: the same exception surfaces as a non-zero
exit under `-EncodedCommand` and as a clean success under `-File`. Both produce empty stdout. An
earlier draft of this design asserted a flat "exits 0" — that is true only of the `-File` shape, and
the corrected finding is strictly more dangerous, because a later refactor from one shape to the
other silently flips the oracle with no test failing.

The consequence chain is unchanged and is what makes this catastrophic. `DeviceKeyStore.load()` is
contractually `DeviceKey | null` where `null` means *never enrolled*
(`packages/worker-daemon/src/identity/key-store.ts:33-34`), so an adapter that maps empty output to
`null` hands `loadOrCreateKey` (`enrollment/enroll.ts:131-136`) a "no key" verdict; it mints a fresh
key and enrols under a **new** device identity — exactly what the module header at
`identity/key-store.ts:4-11` forbids. The server then denies the second identity permanently
(`worker-enrollment.ts:418-423` `worker_transfer_denied`), and `findWorkerForBinding` filters only on
scope / target / organization / owner with **no status predicate**
(`packages/db/src/repositories/tenant/worker-enrollment.ts:274-287` — verified first-hand), so even a
revoked row keeps matching and blocks re-enrolment forever with no reset route.

**Therefore the design must not use exit code OR emptiness as the failure oracle.** Both are
unreliable across shapes. Success must be signalled by an explicit in-band sentinel that only the
success path can produce, and anything else — non-zero exit, empty stdout, absent sentinel, malformed
payload — must resolve to a distinct `unavailable` outcome that is never `null`. That is precisely
what the six-valued `DeviceIdentityStore` in §1.2 Lane A exists to express, and it is the same defect
class as CLI-006's "an absent sandbox has no existence oracle" finding already in the program ledger.

### 1.2 What DSK-001 IS

Four lanes. The recommended split is at the end of §6.

**Lane A — device custody + a real enrollment client.** A new leaf workspace package `@armyofagents/worker-keystore` implementing the existing `DeviceKeyStore` port over a six-valued `DeviceIdentityStore`, with a pure OS-outcome classifier, a Windows DPAPI adapter, a POSIX-file adapter, a fail-closed default, an exported conformance battery, and a named-mode fault injector for DSK-002/003. Plus the four enrollment-client inputs that do not exist today: a code/ticket reader over `config.enrollmentCodeSource`, a production `WorkerHelloV1` builder, an atomic device-identity artifact, and an `identityStore` seam on `BootstrapDeps` so `config.keyStoreMode` — read today only to be logged at `bin/worker-daemon.ts:121` — actually selects a store.

**Lane B — the device-local credential-handle contract.** The `DeviceLocalCredentialBroker` port + fail-closed default that DAT-004 named but never declared; the `ref_id ↔ provider_credentials` sub-contracts DAT-004 left unpinned (residual B); and the redacted, owner-scoped device listing. All value-free by construction.

**Lane C — DSK-00 negative closure (prerequisite bug-fix, not an assertion).** The disabled posture does not hold today, and Lane D creates desktop targets, so the holes must be closed before anything asserts around them.

**Lane D — the minimum user-visible enrollment surface.** One Settings section: create a desktop target → mint a ticket → display once → list enrolled devices redacted → revoke.

### 1.3 What DSK-001 is NOT

- Not an installer, host packaging, autostart, code signing, notarization, or uninstall retain/delete. DSK-003 (`program-design.md:908-912`). No desktop app or package exists; `docs/deploy/distribution.md:17` says "Docker + NPM only. No desktop installer in Phase H." Lane A ships one *unpackaged, unsigned developer host* (D13) so the adapter has a production consumer; that is a composition root, not a product.
- Not leasing, not running work, not a zero-upload E2E of *work*. Enroll returns only a provider **ref** (`packages/worker-protocol/src/transport.ts:197-206`), not the `WorkerSelfModel` `createPollLoop` requires (`packages/worker-daemon/src/poll/capacity.ts:112-116`) — stated verbatim in the composition root at `bin/worker-daemon.ts:48-54`. DSK-001 proves zero-upload of **key material** (I5), a narrower claim than the ticket's wording, and does not dress it up as the broader one.
- Not a device-side credential *read*. Six links are missing (§2, F12).
- Not sustained desktop operation. See D14 and §7 R1.
- Not macOS or Linux key storage in production. D4.
- Not DSK-10 support-bundle redaction, and not DSK-05 folder confinement. §6.

---

## 2. Load-bearing facts

Every fact below was verified first-hand against `C:\e3` on the current revision. Nothing here is inference; inference is labelled as such where it appears later.

**Boundary and packaging**

- **F1.** `scripts/check-worker-daemon-boundary.mjs:70` sets `sourceRoot = path.join(packageRoot, "src")` and `:131` performs `await walk(sourceRoot)` — the **sole** walk. No other path in the repo is read by this gate.
- **F2.** `scripts/lib/worker-daemon-boundary.mjs:112-113` — `if (isAllowedBareImport(value)) continue; errors.push(...forbidden runtime import...)` — rejects a bare specifier **only when a scanned file names it**.
- **F3.** `scripts/lib/worker-daemon-boundary.mjs:144-152` unions five runtime-effective manifest fields (`dependencies`, `optionalDependencies`, `peerDependencies`, `bundledDependencies`, `bundleDependencies`) and `:153-159` requires exact equality with `REQUIRED_RUNTIME_DEPENDENCIES = ["@armyofagents/worker-protocol","pino"]` (`:53`). `devDependencies` is deliberately excluded.
- **F4.** `isAllowedBareImport` (`:79-87`) falls through to `isNodeBuiltin` (`:71-76`), true for any `node:` specifier; `FORBIDDEN_BRIDGE_BUILTINS` (`:67`) carves out only `module`/`node:module` (the `createRequire` escape). `packages/worker-daemon/src/snapshot/git-runner.ts:20` already has a static `import { execFile } from "node:child_process"` in shipped runtime source and the gate is green.
- **F5.** `evaluateRuntimeSourceImports:97-100` hard-rejects any non-literal dynamic import. Platform dispatch by computed specifier is impossible.
- **F6.** `bin/worker-daemon.ts` lives at `packages/worker-daemon/src/bin/`, i.e. **inside** the scanned tree, and is the shipped entrypoint (`docker/worker/Dockerfile:112`, asserted at `docker/images/__tests__/dockerfile-static.test.mjs:212`). It can never import a keystore package.
- **F7.** `packages/sandbox-e2b-provider/package.json:24-30` declares `@armyofagents/sandbox-provider-contract`, `@armyofagents/worker-daemon`, `@armyofagents/worker-protocol`, `e2b`, `zod` as runtime dependencies — the house precedent for a leaf adapter that depends on the daemon. Its own checker confines the vendor SDK import and the credential token string to one file basename (`scripts/lib/sandbox-e2b-provider-boundary.mjs:56,58,113-114,126-127`) and pins its manifest by exact equality (`:47,153-156`).
- **F8.** `docker/worker/Dockerfile:37` runs `pnpm install --frozen-lockfile --prod --filter "@armyofagents/worker-daemon..."`; `:55-60` states the deps stage is exactly the runtime closure, parity-validated by `scripts/check-image-deps-stages.mjs`.
- **F9.** `Dockerfile:44-64` lists one `COPY <dir>/package.json <dir>/` per workspace package. The always-on `policy` step "Validate Dockerfile deps stage" (`.github/workflows/pr.yml:215-253`) derives search roots from `pnpm-workspace.yaml`, runs `find $search_roots -maxdepth 2 -name package.json`, and **fails** if any workspace package.json lacks a matching COPY line in the root deps stage.
- **F10.** Root `vitest.config.ts` uses a hardcoded `projects: [...]` allowlist (22 entries; `packages/worker-keystore` is not among them). A new workspace package's vitest suites **do not run** in the required `verify` lane unless it is added.

**Enrollment and identity**

- **F11.** `createEnroller` (`packages/worker-daemon/src/enrollment/enroll.ts:139`) has zero production callers — only its definition and the re-export at `index.ts:109`. `EnrollerDeps.keyStore` is a `DeviceKeyStore` declared in-package (`enroll.ts:38,97`).
- **F12.** `packages/worker-daemon/src/identity/key-store.ts:48` — `export type OsKeychainKeyStore = DeviceKeyStore` is a **bare type alias**, not an implementation. The only implementations are `MountedSecretKeyStore` (`:61`, raw PKCS8 DER at 0600, skipping the perm check on Windows at `:109-115`) and `InMemoryKeyStore` (`:123`). Both serialize **only** the private key (`:89-101`, `:135-137`).
- **F13.** `workerId` is client-chosen (`packages/worker-protocol/src/capabilities.ts:369` → branded uuid `ids.ts:39`) and the server inserts it as the `workers` primary key (`worker-enrollment.ts:459-460`). A differently-identified re-enroll is denied `worker_transfer_denied` (`:418-423`); `findWorkerForBinding` does not filter on `status`/`revokedAt` (`packages/db/src/repositories/tenant/worker-enrollment.ts:274-287`); no route frees the binding — revoke bumps the generation and keeps the row (`server/src/routes/execution-targets.ts:218`).
- **F14.** The enroll path does **not** validate `policyHash`, `reportedCapabilities`, or `capacity`. `worker-enrollment.ts:389` checks only `hello.targetId !== target.id`; the generation branches at `:418-426` and `:450-452` check only `deviceGeneration`; the hello is then hashed and stored verbatim as `profileSnapshot` (`:459-472`). Capability semantics are enforced at **match** time (`packages/worker-protocol/src/capabilities.ts:474-475,481-486`).
- **F15.** `config.enrollmentCodeSource` retains only the SOURCE — `{kind:'path',path}` | `{kind:'env',envVar}` (`config/config.ts:29-31,103-121`, comment at `:114-115`) — and **no code anywhere reads it**. `config.keyStoreMode` is parsed at `:136` and consumed only as a log field (`bin/worker-daemon.ts:121`). There is no key-store path env var; the full ENV map is `config.ts:56-71`.
- **F16.** `CODE_TTL_MS = 10 * 60_000` and `SESSION_TTL_MS = 15 * 60_000` (`worker-enrollment.ts:22-23`); `SESSION_MAX_MS` is enforced at mint **and** verify (`server/src/middleware/worker-session-auth.ts:80,100-101`). `createWorkerSessionToken` has exactly two call sites, both inside `enrollment.enroll` (`:369`, `:489`). The only route named `renew` is `/worker-control/leases/:leaseId/renew` — a lease fence, audience `worker_run`. There is no device-session renewal endpoint.
- **F17.** `issueTenantCode` (`worker-enrollment.ts:195-229`) validates the scope↔`ownerUserId` pairing and an ACTIVE target row; it performs **no** organization-membership check on `ownerUserId`.
- **F18.** `worker-session-auth.ts:158-165` re-checks all six revocation conditions (including `!current.ownerMembershipActive`) on every worker operation, throwing `WorkerSessionError("target_revoked")`.

**Measured OS behaviour (Windows 11, this machine)**

- **F19.** `cmdkey /?` exposes exactly `/add|/generic`, `/delete`, `/list`. There is **no read/reveal verb**; `/list` emits credential names, never values. It also takes the secret on argv (`/pass:`). It structurally cannot implement `load()`.
- **F20.** DPAPI via `execFile("powershell.exe", ["-NoProfile","-NonInteractive",...], { windowsHide: true })` with material on **child stdin**, using `Add-Type -AssemblyName System.Security` + `[Security.Cryptography.ProtectedData]::Protect/Unprotect(bytes, entropy, CurrentUser)`: a 48-byte Ed25519 PKCS8 DER → 278-byte blob; `blob.includes(der) === false`; unprotect is byte-exact; wrong entropy throws; a single-byte tamper throws.
- **F21.** Controller-measured on Windows PowerShell 5.1: a genuine `CryptographicException` from `Unprotect` yields **exit 0 + empty stdout under `-File`**, and **exit 1 + empty stdout under `-EncodedCommand`**. The oracle is invocation-shape dependent, so neither exit code nor emptiness may be trusted (see §1.1(c)). With `$ErrorActionPreference = 'Stop'` + `try { …; exit 0 } catch { [Console]::Error.Write($_.Exception.Message); exit 3 }`, wrong entropy and tampered blob both yield exit 3 with empty stdout and a real `execFile` error.
- **F22.** `powershell.exe` resolves in-box to `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`. `pwsh.exe` is **not** on PATH.

**DAT-004 seam**

- **F23.** `DeviceLocalHandoff` (`secret-broker.ts:85-92`) has six fields and no `value`; it is built at `:139-151` from `AuthorizedSecretResolution` (`packages/db/src/repositories/tenant/job-control.ts:532-546`) and silently drops five, including `companyId` — annotated there as the scope the broker dispatch resolves in, and the scope `DAT-004-design.md:103` says device_local is validated against. `provider_credentials` is company-scoped (`packages/db/src/schema/provider_credentials.ts:14-16`); `job_secret_handles` is org-scoped (`job_secret_handles.ts:18-20`).
- **F24.** `authorizeSecretResolve` (`packages/db/src/repositories/tenant/job-fence.ts:219-295`) admits `device_local` with `sandbox_local_only` **or** `fence_proxy`, rejecting only `remote_server_fenced` (`:256-258`). The rule's own comment at `:250-255` says so verbatim: "A `device_local` OS-keystore credential resolves ONLY as `sandbox_local_only` or `fence_proxy` (never a remote-server materialization)." Rule 4b (`:270-272`) additionally requires a network-use handle to carry a bound destination (`network_destination_missing`), and rule 6 (`:285-291`) requires `device_local` to be owner-bound with a live active membership (`owner_membership_lost`).
- **F25.** `resolveExecutionSecret` (`job-control.ts:2663-2784`) never reads `provider_credentials`; `SecretResolveAuthzInput` (`job-fence.ts:180-189`) has no credential-state field. This is DAT-004 residual B (HIGH, deferred).
- **F26.** Nothing mints handles in production: `server/src/services/job-leasing.ts:349` ships `secretHandles: []`; the only insert path's sole caller is the test graph builder (`server/src/testing/tenant-graph.ts:351` region). The frozen lease element carries `{handleId, materialization, usePolicy}` only (`packages/worker-protocol/src/policy.ts:171-177`) — no `refId`. `WORKER_PROTOCOL_OPERATIONS` is a closed ten with no secret op (`transport.ts:756-768`). `egress-proxy.ts:216-217` denies `device_handoff` as `malformed`, and `createFenceAwareEgressProxy` (`:146`) has zero production callers. `FenceCloseProxy.readSecret` (`packages/worker-daemon/src/lease/fence-close-proxy.ts:91,157-160`) has zero production call sites.

**DSK-00 posture (currently violated)**

- **F27.** The `if (opts.distributedExecutionEnabled)` block in `server/src/app.ts` opens at `:438` and closes at `:461`. `executionTargetRoutes` is mounted at **`:535`**, 74 lines outside it. `createExecutionTargetSchema.kind` accepts `"desktop"` (`packages/shared/src/validators/execution-target.ts:32`; `EXECUTION_TARGET_KINDS` at `packages/shared/src/constants.ts:432-438`) and `status` defaults to `"active"` (`:34`). Flag-off, an org owner/admin can create an **active** desktop target and `GET` lists it.
- **F28.** `executionTargetToAdapterConfig` (`server/src/services/execution-target-resolver.ts:254-284`) handles only `local_host` and `pooled_gvisor`/`dedicated_worker`; `desktop` **and** `e2b` fall through to `return null` at `:283` → no adapter override → the run silently executes on the control-plane host. The pin branch at `:180-186` returns any active row including desktop.
- **F29.** What already holds: `workerControlRoutes` is dynamically imported *inside* the flag block (`app.ts:449-460`), so enroll and enrollment-codes 404 when off; the no-pin fallback is `active.find(t => t.kind === "pooled_gvisor")` (`execution-target-resolver.ts:195`), never desktop.

**UI**

- **F30.** `executionTargetsApi` exposes only `list`/`rotateToken`/`revoke` and has no `create` (`ui/src/api/execution-targets.ts:22-32`); only `list` has a consumer (`EnvironmentsSection.tsx:257,602-606`). Grepping `ui/src` for `enrollment` or `secretHandle` returns nothing. `POST /organizations/:orgId/execution-targets` returns a plaintext `workerToken` once (`server/src/routes/execution-targets.ts:169`) that no UI has ever displayed.
- **F31.** The redacted `WorkerSummary` allowlist (`server/src/services/job-operations.ts:111-123`, type at `packages/shared/src/types/job-control.ts:146-157`) drops `ownerUserId`, so it cannot serve an owner-scoped view.

**CI**

- **F32.** `.github/workflows/pr.yml` required jobs run `ubuntu-latest`. The only non-Linux PR-time job is `worker-protocol-contract-bytes` (`:488-509`) — matrix `[ubuntu-latest, windows-latest]`, node 24, **no pnpm install**, 5-minute cap — and it **is** gating: it appears in `ci-required.needs` (`:1005`), is captured as `R_WP_BYTES` (`:1016`), and is folded into the **unconditional** verdict loop (`:1039`). macOS/Windows verify+e2e live in `cross-platform-weekly.yml` with `continue-on-error: true`.
- **F33.** `scripts/lib/ci-lanes.mjs:61-65` `DEFAULT_REQUIRED_NEEDS` covers only protocol/schema/provider → `distributed-contract` path-class pairs. An unconditional job in `needs` + verdict requires no lane registration; `check-ci-lanes.mjs` must still be run, not assumed.

---

## 3. Invariants

Each is stated so a test can fail it. Lane in brackets.

| # | Invariant | Proving test |
|---|---|---|
| **I1** | `classifyStoreOutcome` never returns `absent` for any input where absence was not positively signalled. In particular `{exitCode: 0, stdout: ""}` → `corrupt`, never `absent`. [A] | `scripts/check-device-keystore-vectors.test.mjs` — generated corpus over `exitCode ∈ {null,0..6} × stdout ∈ {empty, short, valid, truncated, non-base64} × signal ∈ {null, SIGKILL}` (≥10,000 vectors per D0-T03, `test-gates.md:59`). **Non-vacuity:** a mutation that reclassifies "empty stdout ⇒ absent" must make the corpus fail. |
| **I2** | Every outcome other than `present`/`absent` surfaces as a thrown `DeviceKeyStoreError`; `load()` never returns a key it could not authenticate. [A] | `packages/worker-keystore/src/testing/conformance.ts`, one case per outcome kind, driven by a scripted `CommandRunner`. Linux-runnable. |
| **I3** | A store that cannot open **never** results in a new identity. [A] | `enroll.fail-closed.test.ts`: `createEnroller` over a store whose `load()` throws → enroll rejects, and a `generateDeviceKey` spy records zero calls. This is the direct test of F21 → `enroll.ts:131-136`. |
| **I4** | `saveIfAbsent` is compare-and-set: two concurrent enrollers over one store yield exactly one `workerId` and one surviving envelope. [A] | Conformance battery, interleaved calls: one `"stored"`, one `"already_present"`. |
| **I5** | Private key material never reaches argv, any log line, any file other than the protected blob, or the enrollment ticket. [A] | Canary key bytes + spies on `execFile` args, the pino destination, and every path written under the state dir; assert zero occurrences of raw/base64/hex forms and `blob.includes(der) === false` (F20). |
| **I6** | `workerId` and the private key are one artifact: no filesystem state has one without the other. [A] | Crash-point property test over temp+rename — every intermediate state loads as `absent` or a complete record. |
| **I7** | `workerId` is minted at most once per store and is byte-stable across restarts, including after a failed enroll. [A] | Injected `randomUUID` spy; run the coordinator twice, then again with the client forced to 401/500. One mint, identical `hello.workerId`. |
| **I8** | The enrollment ticket carries `{v, targetId, code}` and nothing else, round-trips exactly, and rejects malformed input. [A] | Ticket parse/serialize vectors incl. extra fields, wrong version, bad base64url, oversized, plus a forbidden-substring scan. |
| **I9** | Protection scope is `CurrentUser`, never `LocalMachine`; the binary is an absolute System32 path, never a PATH lookup; script text and argv are byte-identical to the committed fixture. [A] | Byte-equality vitest in a `*.test.ts` (never `__tests__/support/*.ts`, which classify as runtime under F1) against `tests/fixtures/device-keystore/v1/vectors.json`; a `LocalMachine` or bare-`powershell.exe` variant must be rejected. |
| **I10** | Wrong entropy, tampered blob, and missing blob are three distinguishable outcomes. [A] | `scripts/probe-os-vault.mjs` on the Windows leg, executing real DPAPI against the same fixture (F20/F21). |
| **I11** | `keyStoreMode: "os_keychain"` with no injected `identityStore` exits non-zero before any network I/O. [A] | Bootstrap test over the injectable `env`/`proc` seam (`bin/worker-daemon.ts:38-89`), same shape as the existing invalid-config test at `:107-114`. |
| **I12** | A DSK-001 desktop worker can never be matched work. [A] | Property test: N generated `jobCapabilityRequirements` against `buildDesktopHello(...)` through the **real** matcher (`capabilities.ts:474-486`) → no-match, 100%. Pins F14 in both directions. **CORRECTED (see D13):** the test must NOT assert through `capacity`. `evaluateStaticLeaseEligibility` overwrites it with `NEUTRAL_LEASE_MATCHER_CAPACITY` (`server/src/services/job-lease-eligibility.ts:20-27, :213`), which forces all three slot counts to 1, so an all-zero capacity contributes ZERO unmatchability and a test that mutates only `capacity` would pass vacuously. Assert through the axis that actually decides, and include a non-vacuity case proving a *matchable* hello IS matched. |
| **I13** | The session token is never persisted and is dropped after enrollment. [A] | After `enrollOnce`, assert no file under the state dir and no log record contains it, and that the bootstrap result exposes no token field. |
| **I14** | Revocation and target replacement each disable the *next* worker operation, and the daemon does not re-mint. [A/D] | Embedded-PG integration against `worker-session-auth.ts:158-165`: for `worker.status='revoked'` and `target.deviceGeneration+1` → `WorkerSessionError("target_revoked")`; re-enroll → 401 → `stopAndBackoff`; store still holds the original `workerId`. |
| **I15** | Owner membership loss disables AoA use at **both** ends: an inactive member's `ownerUserId` cannot be issued an enrollment ticket, and an already-enrolled device fails its next operation. [B/D] | (a) service test on `issueTenantCode` with an inactive/removed membership → `unauthorized` (closes F17); (b) the `!ownerMembershipActive` arm of I14. |
| **I16** | The device listing is an exhaustive allowlist **and** non-vacuous. [B] | `desktop-devices.test.ts`: seed canary bytes into every dropped column (`ownerUserId`, `targetAuthorityKey`, `config`, `capabilities`, `workerTokenHash`, `devicePublicKey`, `profileSnapshot`), assert none appear in the serialized response, and assert the allowlist is exhaustive against the table's column list so a **future** column defaults hidden. Mirrors `projectionLeakKeys` (`packages/sandbox-provider-contract/src/port.ts:87-100`). |
| **I17** | Only the owning user sees their devices; a second org member, including an org admin who is not the owner, sees zero rows. [B/D] | Route test on `GET /organizations/:orgId/desktop-devices`. |
| **I18** | Every field name DSK-001 emits is safe under **both** redactors. [B] | Meta-test asserting the projection key list intersects neither `FORBIDDEN_WIRE_KEYS` after `normalizeWireKey` (`wire-safety.ts:18-31,35-37`) nor the daemon logger's `SENSITIVE_SUBSTRINGS` after its own lowercase+`[_-]` strip (`packages/worker-daemon/src/logging/logger.ts:36-56`). The two guards disagree: `credentialHandleId` and `handleToken` are `[redacted]` in logs yet pass the wire; `handleId`, `refKind`, `usePolicy` pass both. |
| **I19** | No type reachable from `DeviceLocalCredentialBroker` or `DeviceLocalHandoff` has a value-bearing field, at runtime as well as statically. [B] | Structural test asserting `Object.keys` of a constructed descriptor equals a frozen allowlist — catches a widened runtime object when the static type is clean. |
| **I20** | `device_local` resolve refuses a `provider_credentials` row whose `state !== "verified"`, and requires the owner triple. [B] | New reject vectors (`device_local_credential_pending|revoked|suspended`, `device_local_owner_mismatch`) verified twice — by `authorizeSecretResolve` and by `decideResolve` in `scripts/check-secret-resolve-vectors.mjs`. **Closes DAT-004 residual B.** |
| **I21** | `device_local + fence_proxy` remains **admitted** by authorization and carries a bound destination; `device_local + remote_server_fenced` remains rejected. [B] | An **admit** vector added for `device_local + proxy + fence_proxy` with a non-null destination, alongside the existing `device_local_remote_server_fenced` reject and a new `network_destination_missing` reject. Pins F24's deliberate decision so DSK-002 inherits it explicitly rather than accidentally. |
| **I22** | DSK-00 negative closure, seven clauses. [C] | `server/src/__tests__/desktop-disabled.negative.test.ts` + `scripts/check-desktop-surface-disabled.mjs`: (1) flag-off `POST …/execution-targets {kind:"desktop"}` → 400 and `GET` never returns a desktop row (fails today, F27); (2) flag-off `/worker-control/enroll` and `…/enrollment-codes` → 404 (holds today, F29 — assert it); (3) `executionTargetToAdapterConfig({kind:"desktop"})` **throws** and the heartbeat pin path surfaces it (fails today, F28); (4) `chooseExecutionTargetRow` with no pin never returns desktop (holds, F29 — assert it); (5) no desktop option renders in `EnvironmentsSection.tsx`/`environment-target-form.ts`; (6) `docs/deploy/distribution.md:17` still says no desktop installer (doc-pin guard in the style of `pr.yml:307-308`); (7) no desktop package/update/manifest route exists — the fourth negative surface `program-design.md:1017` demands. |
| **I23** | `packages/worker-daemon/src` never names `@armyofagents/worker-keystore`, its runtime-dep union still equals `["@armyofagents/worker-protocol","pino"]`, and `node:child_process` appears in exactly one runtime source file of the keystore package. [A] | Existing always-on `scripts/check-worker-daemon-boundary.mjs` + an explicit case added to `packages/worker-daemon/src/__tests__/dependency-boundary.test.ts:77-83`, plus the new `scripts/check-worker-keystore-boundary.mjs` with a mutation corpus (add a dep, move the import, add a non-literal import, add `node:module`). |
| **I24** | The plaintext `workerToken` minted by target creation (F30) is never rendered, never persisted to browser storage, and never logged. [D] | UI test asserting the create response's `workerToken` is discarded at the API-client boundary and never enters component state, plus a grep guard in the negative checker. |

---

## 4. Decisions

### D1 — The OS binding lives in a new leaf package `@armyofagents/worker-keystore`, injected type-only; it does not live in `packages/worker-daemon`

**The exact boundary rule that makes it legal — two independent grounds, either sufficient:**

1. **Scope.** `scripts/check-worker-daemon-boundary.mjs:70,131` (F1): the gate reads exactly one directory tree, `packages/worker-daemon/src`. A package at `packages/worker-keystore/` is outside every path it touches.
2. **Manifest.** `scripts/lib/worker-daemon-boundary.mjs:144-159` (F3): if worker-daemon's manifest does not declare the package in any of the five runtime-effective fields, the union is unchanged and still equals `["@armyofagents/worker-protocol","pino"]`.

The line that would kill it is **`scripts/lib/worker-daemon-boundary.mjs:112-113`** (F2), which rejects a bare specifier the moment a scanned file names it. Legality therefore reduces to one rule: **no file under `packages/worker-daemon/src` may name `@armyofagents/worker-keystore` in an import specifier.** Injection is type-only — `EnrollerDeps.keyStore` and the new `BootstrapDeps.identityStore` are types declared in-package (F11) — so nothing is named. The dependency arrow points keystore → daemon, exactly as `packages/sandbox-e2b-provider` already does (F7).

**Rejected A — implement inside `packages/worker-daemon/src` via `node:child_process`.** Also legal (F4; `git-runner.ts:20` is the shipped precedent). Rejected because it permanently forecloses a native in-process binding, and macOS is precisely the OS where shelling out is unsafe (D4). It also puts subprocess code inside the package whose two-dependency manifest is a controller-approval STOP.

**Rejected B — add the keystore to worker-daemon's `devDependencies`.** It would *pass* the gate, because the manifest union excludes `devDependencies` (F3). Rejected anyway: it perturbs the `--prod --filter` runtime closure that `check-image-deps-stages.mjs` polices (F8).

**Rejected C — `createRequire("keytar")` or `@napi-rs/keyring` as a worker-daemon dependency.** `FORBIDDEN_BRIDGE_BUILTINS` (F4) exists to kill the first; F3 kills the second. Blocked by CI, not by convention.

**Packaging bookkeeping this decision obliges (all three are always-on gates, all three fail on the first push if skipped):**
- Add `COPY packages/worker-keystore/package.json packages/worker-keystore/` to the root `Dockerfile` deps stage beside `:60-64` — the `policy` step at `pr.yml:215-253` derives its search roots from `pnpm-workspace.yaml` and will find the new manifest (F9).
- Add `"packages/worker-keystore"` to the root `vitest.config.ts` `projects` allowlist, or its suites silently never run in the required `verify` lane (F10).
- Do **not** add it to `docker/worker/Dockerfile` or `docker/control-plane/Dockerfile`; it is in neither split closure, and DEP-001 enforces "no fewer and no more."
- Declare runtime deps `["@armyofagents/worker-daemon","@armyofagents/worker-protocol"]`, mirroring F7 — under pnpm's strict `node_modules`, worker-daemon's `.d.ts` re-exports of protocol types do not resolve without the second entry.

### D2 — The keystore package gets its own confining boundary checker

Forked in structure from `scripts/lib/sandbox-e2b-provider-boundary.mjs` (F7): exact manifest equality against `REQUIRED_RUNTIME_DEPENDENCIES`, plus `SUBPROCESS_HOST_BASENAME = "command-runner.ts"` — `node:child_process` may be imported from that file and no other — plus the F5 non-literal-import and F4 `node:module` rejections. Added to the always-on `policy` job beside the eleven existing checkers (`pr.yml:142-212`).

**Rejected:** relying on review to keep the subprocess surface small. The e2b provider already demonstrates that a mechanical basename confinement is the repo's answer to "one dangerous capability, one file."

### D3 — Windows uses DPAPI `CurrentUser`, not Windows Credential Manager

**Rejected — `cmdkey`.** F19: no read verb, so it structurally cannot implement `load()`; and it takes the secret on argv. Recorded so nobody re-proposes it.

**Chosen — DPAPI protect/unprotect** with material on child stdin (F20). Measured properties in F20/F21. DPAPI is not a store — the adapter persists the blob itself at `%LOCALAPPDATA%\AoA\worker\device-identity.v1.bin`. `LOCALAPPDATA` is deliberately non-roaming: a roamed `CurrentUser` blob on a second machine is an undecryptable footgun. `MountedSecretKeyStore`'s Windows perm-check skip (F12, `key-store.ts:109-115`) is **not** inherited — the new adapter asserts blob-file ownership/ACL on Windows rather than early-returning.

### D4 — macOS and Linux ship as ports and command plans, not as production adapters

**Rejected — a macOS `security(1)` shell-out now.** `security add-generic-password -w <secret>` puts the private key on argv, visible to same-user `ps`; omitting the value makes it prompt interactively, useless for a daemon. That is strictly *worse* than the 0600 file it would replace. `security import` from a 0600 file is the candidate that avoids argv exposure; **it has not been tested and no macOS host exists in this environment.** The macOS adapter therefore ships with read/delete planned and `put()` throwing `unsupported`, which means macOS `os_keychain` enrollment is not deliverable in DSK-001. Linux `secret-tool` requires a live D-Bus session and an unlocked keyring; containers use `mounted_secret`. Both inherit the conformance battery (D9) when DSK-003 lands their bindings.

**Consequence, stated plainly:** DSK-001's Test clause says "per-OS key-store adapter." It delivers a per-OS *port and command-plan contract* and **one** production adapter. §5 and §6 say so; the ticket does not claim three.

### D5 — Absence is a positive signal; a fault may never become `null`

The port is six-valued and never overloads output length:

```ts
export type KeyStoreProbeOutcome =
  | { kind: "present"; envelope: Uint8Array }
  | { kind: "absent" }                        // ONLY from the platform's explicit absence channel
  | { kind: "locked" }                        // store present, cannot open
  | { kind: "denied" }                        // wrong OS user / ACL
  | { kind: "corrupt"; detail: string }
  | { kind: "unavailable"; detail: string };  // binary missing, spawn failure

export function classifyStoreOutcome(r: {
  exitCode: number | null; signal: string | null; stdout: Uint8Array; stderr: string;
}): KeyStoreProbeOutcome;
```

The absence channel is per-platform and explicit: **Windows** — `ENOENT` on the blob file (the filesystem is the oracle; an unprotect failure is *always* a fault). **macOS** — `security find-generic-password` exit 44 (INFERENCE, unverified, F-none). **Linux** — an explicit `secret-tool lookup` probe. Everything else maps to `DeviceKeyStoreError` at the port boundary, so `load()` throws and the daemon exits non-zero per `key-store.ts:4-11`. `OsIdentityStore` has exactly one `return null`, guarded by `kind === "absent"`.

**Rejected — inferring absence from empty output or from a generic non-zero exit.** That is the measured fail-open (F21) and the unrecoverable-lockout path (F13).

All PowerShell is hardened per F21. The security-critical logic is `classifyStoreOutcome`, which is **pure and OS-free** — this is the decomposition that makes the invariant that actually caused the bug (I1) gatable on the required Linux lane.

### D6 — Script delivery is `-EncodedCommand`; script text is generated by a pure planner

**Rejected — a committed `.ps1` on disk.** `tsc` does not copy non-`.ts` files into `dist`, so the shipped package would be missing its scripts. **Rejected — a runtime-written temp script.** That creates a substitution TOCTOU: an attacker who can write the temp path gets a script that receives the key on stdin.

**Chosen** — `powershell.exe -NoProfile -NonInteractive -EncodedCommand <base64-utf16le>`, with the script text produced by a pure `planVaultCommand(op, ref, platform)` in `src/command-plan.ts`. No script file, no quoting hazard; argv carries only non-secret script text; the key crosses stdin only. The planner's output (argv + script text + stdin kind + exit-code map) is the committed fixture that the Windows probe and the TypeScript both read (D12).

Authoring hazard to encode in review: PowerShell's escape character is a backtick and `${…}` inside a JS template literal is interpolated — script text must be built from ordinary quoted strings, never template literals.

### D7 — `workerId` and the private key are ONE atomic artifact

The record is `{version: 1, workerId, targetId, deviceGeneration, pkcs8}`, encoded deterministically and stored as a single protected blob, written temp-file + rename.

**Rejected — a plaintext `identity.json` sidecar.** Torn state becomes representable, and a rolled-back or swapped sidecar produces a *different* `workerId` against a store that still holds the right key → `worker_transfer_denied` → **permanent, unrecoverable** lockout of that target with no reset route (F13). Atomicity here is an availability control, not a nicety. (A signature binding the sidecar to the key was considered and dropped: with one blob there is nothing to bind, and a signature would only have converted a corruption into a DoS.)

**Rejected — deriving `workerId` deterministically from the device thumbprint.** `workerIdSchema` is a branded UUID (F13); a derived UUIDv5 would keep the same `workerId` across a legitimate key rotation and defeat the `deviceGeneration` rebind logic at `worker-enrollment.ts:424-426`.

`save` is exposed as `saveIfAbsent(envelope): "stored" | "already_present"` — a compare-and-set, because `loadOrCreateKey` has no guard and two concurrent daemon instances would otherwise race two identities onto one target (I4).

### D8 — `createEnroller` is not modified

**Rejected — widening `DeviceKeyStore.load()` to `Promise<…>` or editing `loadOrCreateKey`.** Both churn a landed, reviewed WRK-002 file and its suite for no benefit at the single call site; `load()` runs once at boot and blocking is the correct semantics there.

**Chosen** — `asDeviceKeyStore(identityStore): DeviceKeyStore`. The `enrollOnce` coordinator performs the mint-once itself and hands `createEnroller` a frozen view whose `load()` returns the already-resolved key (so `loadOrCreateKey` never mints) and whose `save`/`clear` are no-ops. Custody belongs to the `DeviceIdentityStore`; the enroller sees a view. Zero diff in `enroll.ts` beyond an optional `identityStore` field on `EnrollerDeps`. The adapters use `execFileSync(..., { input: der, windowsHide: true, maxBuffer })` — `input:` delivers the secret on stdin, preserving D6 in the sync form.

**Forward note:** the *credential* path is different — DSK-002 reads device-local credentials per job, off the boot path. `DeviceLocalCredentialBroker` (D10) is therefore `async` from day one. Fixing both shapes now is the point of the port-first split.

### D9 — Ship an exported conformance battery and a named-mode fault injector

`packages/worker-keystore/src/testing/conformance.ts` exports a battery every `DeviceIdentityStore` implementation must pass (absent / locked / denied / corrupt / unavailable / CAS race), and `src/fakes/fault-injecting-store.ts` exposes named modes: `locked`, `unavailable`, `wrong_os_user`, `exit_zero_empty_stdout`, `tampered`, `spawn_failure`. DSK-002 and DSK-003 test *against* these instead of re-deriving them, and DSK-003's macOS adapter inherits the coverage rather than a checklist.

### D10 — The device-local credential adapter returns an **activation**, never bytes

```ts
export interface DeviceLocalCredentialBroker {
  activate(input: DeviceLocalActivationRequest): Promise<DeviceLocalActivation>;
  deactivate(activationId: string): Promise<void>;
}
export interface DeviceLocalActivation {
  activationId: string;
  materialization: "env" | "file" | "proxy";
  /** OS-protected reference the consumer uses. Never the value. */
  reference:
    | { kind: "file_path"; path: string }
    | { kind: "env_name"; name: string }
    | { kind: "proxy_endpoint"; url: string };
  expiresAt: string;   // <= lease deadline
}
export const failClosedDeviceLocalBroker: DeviceLocalCredentialBroker = { /* throws */ };
```

There is no `value` field anywhere in the type (I19), mirroring `DeviceLocalHandoff`'s invariant (F23). `device_local` must **not** be routed into `SecretBrokerSet` (`secret-broker.ts:107-114`), whose two methods return `Promise<string>` — a `Promise<string>` *is* the leak. The fail-closed default mirrors `failClosedSecretBrokers` (`:119-126`).

Note the `proxy` arm: it exists because F24 admits `device_local + fence_proxy` deliberately, and DSK-002's Outcome is to mediate device-local handles "through the DAT-004 broker plus fence-aware egress path." Omitting it would force DSK-002 to widen this type immediately.

**Rejected — returning the value and relying on scanning.** Empirically defeated (§1.1(b)).

### D11 — Owner-membership enforcement is pull-based, and DSK-001 closes the code-issue gap

There is no user-facing membership-removal route to hook — the only non-test delete of `organizationMemberships` is the break-glass teardown (`server/src/services/operator-break-glass.ts:249`), and `execution_targets.ownerUserId` carries `onDelete("restrict")` (`packages/db/src/schema/execution_targets.ts:83-87`), so deleting the user is blocked rather than cascaded. A push hook has nothing to hook.

Three pull-based chokepoints, two of which already exist: (a) **new** — `issueTenantCode` asserts an active `organizationMemberships` row for `ownerUserId` inside its existing `runInTenant` block, closing F17; (b) **exists** — the per-operation re-check at F18; (c) **exists** — `authorizeSecretResolve` rule 6 `owner_membership_lost` (F24). `organizationMemberships.status` is the durable signal and `canOrg` already requires `"active"` (`server/src/services/organization-access.ts:50`).

**Rejected — treating this clause as vacuous because there is no leasing.** Lane D creates owner-scoped targets and mints tickets; the clause is live the moment that ships.

### D12 — Pin four `ref_id ↔ provider_credentials` sub-contracts; **do not narrow `device_local` to `sandbox_local_only`**

This closes DAT-004 residual B (F25), whose stated deferral rationale — "the OS broker validates the underlying credential when reading it" — is not implementable, because the device has no DB access.

1. **`refId` domain.** For `refKind === "device_local"`, `ref_id` **is** `provider_credentials.id` (uuid PK, `packages/db/src/schema/provider_credentials.ts:13`). The "id-or-slug" ambiguity in the column comment (`job_secret_handles.ts:37-39`) is retired for this ref_kind. The committed fixture's literal `"provider-credential-1"` becomes a UUID. *Rejected:* the composite natural key `provider_credentials_identity_uq` (`:37-43`) — five columns, unstable under slug rename.
2. **Company scope.** `DeviceLocalHandoff` gains `companyId`, `handleId`, and `boundTargetGeneration` — today `dispatchResolvedSecret` drops them (F23), so the company-scoped lookup `DAT-004-design.md:103` promises is *not performable from the descriptor*. *Rejected:* moving the lookup inside the fenced tx and reading the credential store server-side on the device_local path — that is the one thing the invariant forbids.
3. **State gate.** Admit only `provider_credentials.state === "verified"` (`provider_credentials.ts:23`; matching `markScopedSubscriptionVerified`, `server/src/services/provider-credentials.ts:66-79`). Checked **server-side in the same fenced transaction**, as a sibling of the owner+membership re-check at `job-control.ts:2707-2723`.
4. **Owner triple.** `ownerPrincipalKind === "user"` **and** `ownerPrincipalId === provider_credentials.owner_user_id === execution_targets.owner_user_id`, plus D11's active membership. Three owner columns exist today with nothing forcing agreement (`job_secret_handles.ts:42-43` free text; `provider_credentials.ts:18-20` FK; `execution_targets.ts:26,83-87` FK).

**Explicitly rejected — narrowing `device_local` to `sandbox_local_only` and adding a `device_local + fence_proxy` reject vector.** An earlier draft proposed this on the theory that the mode was an admitted-but-dead contradiction. It is not. `job-fence.ts:250-255` states the rule verbatim as a deliberate design ("resolves ONLY as `sandbox_local_only` or `fence_proxy`"); `DAT-004-design.md:58` names both modes; DAT-004's review deliberately scoped its fix to `device_local ⇒ not remote_server_fenced`; rule 4b (`:270-272`) exists to *bind the destination* of exactly this mode for DAT-005 to enforce; and `program-design.md:148` disables *direct* network use "or through that same reauthorization path" — the path being the fence-aware egress proxy. Most decisively, DSK-002's Outcome requires mediating device-local handles "through the DAT-004 broker plus fence-aware egress path." Narrowing would force DSK-002 to reverse a coordinated four-artifact change across the most fragile gate in the ticket. The mode is dead today only because its device-side consumer is DSK-002's unbuilt job (F26).

**Instead:** add an **admit** vector for `device_local + proxy + fence_proxy` with a bound destination, plus a `network_destination_missing` reject (I21), so the decision is pinned rather than accidental, and record in the ticket result that `egress-proxy.ts:216-217`'s `malformed` denial is the server correctly declining to egress a value it cannot hold — the consumer is device-side and belongs to DSK-002.

**Cost, stated plainly:** (3) changes `SecretResolveAuthzInput` (`job-fence.ts:180-189`), forcing coordinated edits to `job-control.ts`, `tests/fixtures/secret-resolve/v1/vectors.json`, and `scripts/check-secret-resolve-vectors.mjs`'s independent `decideResolve`. That dual derivation is the gate working as designed, but Lane B **cannot land partially**.

### D13 — The hello is deliberately unmatchable, and DSK-001 ships one unpackaged composition host

> **CORRECTION (found by adversarially attacking this design before implementing it).** This decision
> originally claimed the all-zero `capacity` was one of two axes on which job matching fails closed.
> **It is not an axis at all.** Neither real call site consults the hello's capacity:
> `evaluateStaticLeaseEligibility` replaces it wholesale with `NEUTRAL_LEASE_MATCHER_CAPACITY`
> (`server/src/services/job-lease-eligibility.ts:213`), a frozen constant whose `batchSlots`,
> `browserSessionSlots` and `serviceSlots` are all **1** and whose free-resource fields are 0
> (`:20-27`) — so the slot check always passes and the zero free-resource values trivially satisfy
> the `>` ceiling comparisons. The placement path substitutes live poll capacity instead
> (`job-placement.ts:544-546`).
>
> Keep the all-zero capacity for byte-stability, but unmatchability must rest on the OTHER axis
> alone, and I12's property test must not assert through capacity — it would pass for the wrong
> reason and prove nothing. This is exactly the vacuous-guard failure mode the program's process
> exists to catch, caught here before a line of code was written rather than after.


`buildDesktopHello` emits `reportedCapabilities: []`, all-zero `capacity` (legal — `nonNegativeIntSchema`, `capabilities.ts:89-98`), a real `platform` from `node:os`/`process` against the closed enums at `:101-113` (`windows` is a legal `WORKER_OS`), and `policyHash = UNPROVISIONED_POLICY_HASH` — a named exported constant, `sha256("aoa.worker.policy.unprovisioned.v1")`, satisfying `sha256DigestSchema` while being structurally unable to equal a real profile hash. Job matching then fails closed on **both** axes (`capabilities.ts:474-486`). This works because the enroll path validates neither field (F14).

**This turns DSK-00's disabled posture into a property of the artifact rather than a property of a flag.** A DSK-001 desktop can enrol for real and can be matched nothing.

**Rejected — blocking enrolment until the self-model exists.** That defers the entire ticket behind DSK-002 for no security gain: the hello is a self-report the server does not trust at enroll time anyway.

To give the Windows adapter a real production consumer — and to make an end-to-end enrolment demonstrable rather than theoretical — Lane A also ships `packages/worker-keystore/src/bin/aoa-worker-desktop.ts`: a ~60-line composition root that imports `bootstrapWorkerDaemon` (already exported, `packages/worker-daemon/src/index.ts:59-60`), constructs the OS identity store, and injects it. It is **unpackaged, unsigned, has no autostart, and enters no container image** (D1 bookkeeping). DSK-003 replaces it with the signed installer host. This exists because F6 makes `bin/worker-daemon.ts` structurally unable to do the job.

### D14 — Enrollment runs at the existing startup seam; the session token is discarded

`enrollOnce` runs at `bin/worker-daemon.ts:131-136` — after the health server is listening (`:128`, so the compose healthcheck at `scripts/check-staging-manifest.test.mjs:91` answers while enrolment retries) and before signal registration (`:151`). A `DeviceKeyStoreError` exits non-zero exactly like invalid config (`:107-114`). `config.keyStoreMode` stops being log-only: `mounted_secret` constructs the existing store from a new `AOA_WORKER_KEY_STORE_PATH`; `os_keychain` **requires** an injected `identityStore` and exits 1 without one (I11).

**Rejected — silently degrading `os_keychain` to a file store.** That makes the mode a lie and re-introduces the fail-open in a different costume.

The returned session token is used for nothing — there is no work to lease and no renewal route (F16) — so DSK-001 constructs no `SessionStore`, persists nothing, logs nothing containing it, and drops the reference (I13). This converts the 15-minute TTL from a blocker into a non-issue *for this slice*, and it is honest: the device is enrolled and idle. `IdentityLifecycle.acquireSession()` is landed as the seam the renewal successor implements without reshaping callers.

### D15 — Enrollment input is a single-paste ticket over the existing source config

The code carries no `targetId` but the server requires `hello.targetId === target.id` (F14), so a client-side-only envelope `aoa_tkt_<base64url({v:1,targetId,code})>` carries both in one paste. **No server or protocol change.** The reader accepts either a ticket or a bare `aoa_enr_…` code plus a new optional `AOA_WORKER_TARGET_ID`, so the existing container path is unchanged.

Crucially this closes F15: `config.enrollmentCodeSource` finally gets a reader, and the invariant that config retains only the **source** and never the value is preserved — a third arm `{kind:"stdin"}` behind `AOA_WORKER_ENROLLMENT_CODE_STDIN` is added (exactly-one-of-three), for the interactive host. This is what satisfies the acceptance clause "credential values never … enter repository config."

**Rejected — putting the control-plane URL in the ticket.** That would force `AOA_WORKER_CONTROL_PLANE_URL` to become optional and unpick `loadWorkerConfig`'s fail-closed parse.

### D16 — Close the DSK-00 holes by rejecting and throwing, not by hiding

Per F27/F28: reject `kind:"desktop"` at create when desktop is disabled (reusing `opts.workerSession`, which is already exactly the distributed flag — a two-line change, no new plumbing); make the pin branch throw on a desktop-kind target when disabled; and replace the implicit `return null` fallthrough at `execution-target-resolver.ts:283` with an **exhaustive switch that throws** for `desktop` and for any unhandled kind. `e2b` has the identical fallthrough and is audited in the same pass.

**Rejected — filtering desktop rows out of `GET`.** That hides an already-enabled row instead of neutralising it — strictly worse for incident review.

This is a behaviour change to shipped code paths and belongs in the release note: any deployment that already created a desktop target will see it rejected, which is the point — today such a target silently runs work on the control plane.

### D17 — The device listing is a server-side allowlist projection, not a protocol shape

The frozen wire cannot carry handle metadata: `secretHandleRefSchema` is `.strict()` with exactly three fields (F26), byte-gated at `pr.yml:488-509`. So the listing is REST over the org's own `kind='desktop'` targets joined to `workers` inside `runInTenant`, following the `PROVIDER_PROJECTION_KEYS`/`projectionLeakKeys` precedent (`packages/sandbox-provider-contract/src/port.ts:70-100`). Constructing the join *from the org's own targets outward* is why it is safe where a generic worker join is not — F31 is exactly why `WORKER_SUMMARY_COLUMNS` had to drop `executionTargetId`.

Field names obey I18. `refId`, `ownerPrincipalId`, `destination`, `organizationId`, and `jobId` are excluded. The route is mounted **inside** the flag-gated router so DSK-00 clause (a) holds by construction — unlike F27.

**Rejected — reusing `WorkerSummary`.** It drops `ownerUserId` (F31), so "to the owning user" is unimplementable over it, and it is org-admin-scoped.

---

## 5. Test + CI strategy

### 5.1 The blunt fact, and the one exception

Required jobs run `ubuntu-latest` only. `docs/replatform/test-gates.md:217` requires DSK-01..03 to pass "For every advertised OS/version", and `test-gates.md:13` makes an unlabelled gate bullet REQUIRED. DEC-01/DEC-03 do not let an advisory lane satisfy a required condition. **DSK-001 does not create per-OS gating, and this design does not pretend otherwise.**

The one exception is real and is the design's leverage: `worker-protocol-contract-bytes` (F32) proves that a **node-only, no-pnpm-install, multi-OS PR-time job can gate a merge** in this repo, because branch protection requires only `ci-required` and that job is folded into its unconditional verdict loop.

### 5.2 Three tiers, honestly labelled

**Tier 1 — gated, Linux, the bulk.** Everything pure runs in the existing required lanes: `classifyStoreOutcome` and the ≥10,000-vector corpus (I1), the conformance battery over a scripted `CommandRunner` (I2, I3, I4), identity atomicity and mint-once (I6, I7), ticket vectors (I8), the unmatchable-hello property test (I12), bootstrap fail-closed (I11), token non-persistence (I13), the projection and naming meta-tests (I16, I18, I19), the resolve vectors (I20, I21), the DSK-00 negative suite (I22), the boundary checkers (I23), and the UI token-discard test (I24). I14/I15 run as embedded-PG integration tests. **This tier contains the invariant that caused the measured bug (I1), because D5 made the classifier pure.**

**Tier 2 — proposed new gated lane (a CI-topology change; here is its exact cost).**

```yaml
  device-keystore-os:
    if: ${{ github.event_name != 'pull_request' || !github.event.pull_request.draft }}
    strategy: { fail-fast: false, matrix: { os: [ubuntu-latest, windows-latest] } }
    runs-on: ${{ matrix.os }}
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@...
      - uses: actions/setup-node@...        # node-version: 24
      - shell: bash
        run: |
          node --test scripts/check-device-keystore-vectors.test.mjs
          node scripts/check-device-keystore-vectors.mjs
          node scripts/probe-os-vault.mjs   # no-ops off Windows
```

Plus three edits: `ci-required.needs` (`pr.yml:1005`), an `R_KEYSTORE` capture beside `:1016`, and the **unconditional** verdict loop at `:1039`. `scripts/check-ci-lanes.mjs` needs no change (F33) — but it must be **run**, not assumed. Do not add a `paths:` filter: a skipped required check passes silently.

- **Cost:** ~2 minutes of a Windows runner per non-draft PR, billed at the private-repo 2× multiplier (~4 billable minutes), and it becomes a **merge blocker**, so a flaky `powershell.exe` invocation blocks all merges. Mitigations: hermetic (no network, no install, no admin rights), 5-minute cap, `fail-fast: false`.
- **What it buys:** merge-time proof of I9 and I10 on the OS where the fail-open manifests, and a real DPAPI round-trip rather than a mock.
- **What it does not buy:** the "wrong OS user" case — GitHub's Windows runner executes as `runneradmin`, cross-user DPAPI needs a second account, and `runas` needs a password. (This repo already carries the `runneradmin` scar: embedded-postgres cannot start there, Issue #114.) It also does not cover the adapter's filesystem half (ENOENT oracle, temp+rename) on Windows; that runs in Linux vitest and in the advisory weekly lane.
- **macOS is deliberately excluded from the matrix.** A macOS leg bills at 10× and would prove nothing while D4 leaves the write path unresolved. Adding it is DSK-003's call. **This is an open gate condition, recorded here rather than glossed.**

`scripts/probe-os-vault.mjs` is **not** a second implementation of the vault logic in `.mjs`. It reads the same committed `tests/fixtures/device-keystore/v1/vectors.json` the TypeScript reads and asserts reality matches it — the "two consumers, one fixture" pattern `scripts/check-secret-resolve-vectors.mjs` already uses against `authorizeSecretResolve`. The shipped adapter is bound to that fixture by the byte-equality vitest in I9.

**Tier 3 — advisory / manual, explicitly labelled.** Cross-user DPAPI denial (a second Windows local account, two blobs, assert cross-decrypt fails); the macOS locked-keychain case (needs a GUI unlock prompt no runner can produce); and an end-to-end enrolment through `aoa-worker-desktop` against a flag-on server. All recorded under EVID-04 (`test-gates.md:38`) at `docs/replatform/epics/E10-desktop/qa/<YYYY-MM-DD>-<lane>-<scope>-<sha12>-a<attempt>.md`, on the same 40-char revision as the candidate (EVID-01/02).

### 5.3 DSK-00 evidence

I22's seven clauses are the negative evidence `test-gates.md:215` requires, plus the fourth "update" surface `program-design.md:1017` adds. Two of the seven **fail today** (F27, F28) and are prerequisite fixes (D16), not assertions — writing a test around the current behaviour would enshrine it.

---

## 6. Non-goals and scope honesty

| Not delivered | Owner | Why (verified) |
|---|---|---|
| macOS / Linux production key stores | DSK-003 | D4. macOS `security -w` exposes the key on argv and has no non-interactive stdin write path; `security import` is an untested candidate. Linux `secret-tool` needs D-Bus + an unlocked keyring. The port, command plan, and conformance battery land now so the binding is a one-file addition. |
| Sustained device sessions | new server ticket (E4-F007 scale) | F16. `CODE_TTL_MS` gates even the replay path (`worker-enrollment.ts:289-297`); `SESSION_MAX_MS` is enforced at mint and verify. A daemon enrolled at T0 loses replay at T0+10min and its session at T0+15min, then the poll loop stops with `reenrollment_required` (`poll-loop.ts:424`). "Re-paste a code every 10 minutes" is not a shippable UX. `IdentityLifecycle.acquireSession()` is the drop-in seam; the fix is a device-proof-bound renewal endpoint, and the material exists (`worker-session-auth.ts:130-141` re-verifies key + thumbprint per operation). |
| Leasing, work execution, zero-upload E2E of work | DSK-002 | Enroll returns a provider ref, not a `WorkerSelfModel` (`transport.ts:197-206` vs `poll/capacity.ts:112-116`), stated at `bin/worker-daemon.ts:48-54`. Also: `capacity.ts:45-50` has no production `CapacityProbes`. DSK-001 proves zero-upload of **key material** (I5) only. |
| Handle **minting**, and the device→control-plane resolve channel | JOB-009 / DSK-002 | F26 — six independent missing links; two of them are byte-frozen contracts. Inventing an eleventh operation contradicts the E1 freeze. |
| "Every local credential **grant** is explicit" | DSK-002 | DSK-001 defines explicitness as: enrolment requires a human-pasted, single-use, 10-minute ticket (no ambient discovery, D15), and every credential grant is a per-job `job_secret_handles` row minted by an authorized principal. Since nothing mints one (F26), what DSK-001 can deliver is the port + the fail-closed default + the pinned resolve contract. **The consent surface itself — per-grant prompt vs enrollment-time blanket — is an unmade decision** (OQ-2). |
| "Device loss → a revocation an owner can reach" (end-to-end convergence) | MIG-008 / a scheduler ticket | `createExecutionTargetRevocationFanout` (`server/src/services/execution-target-revocation-fanout.ts:43`) has **zero production callers**; its only reference outside its module is `server/src/__tests__/worker-revocation.integration.test.ts:18,53`. DSK-001 proves the **chokepoint** cutoff (I14 — which is what actually stops new work) and Lane D gives the owner a reachable revoke button. It explicitly declines DSK-08's 5-minute active-work kill. |
| Uninstall retain/delete choice | DSK-003 | No installable host exists (`docs/deploy/distribution.md:17`). The ticket text mis-files this under DSK-001; DSK-003 should inherit it explicitly. |
| DSK-10 diagnostic / support-bundle redaction | new ticket | **No support-bundle or diagnostic-export surface exists anywhere** in `server/src`, `ui/src`, or `packages/`. There is no artifact to scan. The nearest thing, `scripts/lib/d1-evidence-bundle.mjs:23-24`, assembles logs + events + dbState + object manifests and SHA-256s them with **no redaction pass**. DSK-001's contribution is I18: pin a naming vocabulary now so a future bundle inherits safe field names. |
| DSK-05 folder confinement (10k traversal cases) | DSK-002 | `program-design.md:900-905`. |

**Recommended split.** With D16 (a prerequisite fix in another area) and D12 (a HIGH residual from a shipped ticket) absorbed, this is materially larger than the ticket's "(M)". If reviewable PRs are wanted:

1. **DSK-000** — Lane C only (D16 + the seven negative assertions, I22). Small, independently valuable, unblocks the DSK-00 gate, and nothing in `docs/replatform/epics/E10-desktop-migration-realtime/README.md:5,10` currently owns it.
2. **DSK-001a** — Lane A (package, ports, adapters, fakes, enrollment client, bootstrap seam, dev host) + the Tier 2 CI lane.
3. **DSK-001b** — Lane B (D10/D12/D17) + Lane D. Lane B's dual-derivation fixture change cannot land partially, so isolating it keeps `policy` green independently.

---

## 7. Risks and open questions

**R1 — A desktop worker cannot stay enrolled, and DSK-001 cannot fix it.** F16. Anyone reading "desktop enrollment works" should understand the device is enrolled and idle, and goes authority-less ~15 minutes later. **Recommend filing the session-renewal successor now, before DSK-003 is planned** — DSK-003's background host is unshippable without it.

**R2 — macOS is entirely unverified; this is the largest technical gap.** D4. Every macOS claim here (exit 44 for absence, `-T` ACL semantics, locked-keychain behaviour, `security import` as the argv-free write path) is INFERENCE from documented interfaces. If the write path resolves differently, D4's rejection is wrong. **This is the single most likely place this design is factually wrong** and needs real hardware before DSK-003 plans its macOS installer.

**R3 — Cross-user DPAPI isolation is unmeasured.** F20/F21 measured same-user round-trip, wrong-entropy failure, and tamper failure. **Not measured:** that a different OS user cannot `Unprotect` the blob — which is precisely what DSK-001's "wrong OS user" test is about. CurrentUser scope binding is documented behaviour; it is asserted here from documentation, not observation. Tier 3 manual evidence.

**R4 — `powershell.exe` may be unavailable or hostile in exactly the environments DSK-003 targets.** `Add-Type -AssemblyName System.Security` fails under WDAC/AppLocker **Constrained Language Mode**, and a background service spawning `powershell.exe` is an EDR signal in managed enterprises. In those environments the adapter fails closed (correct) but the product does not work, and a native Windows binding becomes mandatory. Bounded by D1: the `identityStore` injection seam makes the swap a one-file change, and the port, envelope, ENOENT oracle, coordinator, ticket parser, conformance battery, and UI all survive it. Named here so DSK-003 budgets for it rather than discovering it during a pilot.

**R5 — `workerId` loss is unrecoverable per target and D7 only removes the desync class.** A user who deletes `%LOCALAPPDATA%\AoA` or reimages still hits `worker_transfer_denied` permanently (F13), and no route frees the binding. The operator workaround is to create a *new* execution target. This is a genuine product gap in the landed server surface that DSK-001 surfaces rather than fixes; it deserves its own ticket (a target-scoped worker-binding reset).

**R6 — D13's unmatchable-hello gambit depends on an absence of validation (F14).** If a future server change adds enroll-time `policyHash` validation, DSK-001 enrolment breaks. Mitigation: `UNPROVISIONED_POLICY_HASH` is a named exported constant with a docblock citing `worker-enrollment.ts:389` and `capabilities.ts:474-475`, and I12 pins the fail-closed behaviour, so a change in either direction fails a test rather than silently shipping a *matchable* desktop.

**R7 — Lane B's fixture change is a coordinated four-way edit** (`job-fence.ts`, `job-control.ts`, `vectors.json`, `check-secret-resolve-vectors.mjs`) across a gate whose entire purpose is that two independent derivations must agree. Getting them out of sync is the most likely way this ticket reddens `policy`. That is the gate working; it should be budgeted, and it is why §6 isolates Lane B.

**R8 — An untraced possible owner-membership bypass, flagged as risk not finding.** `packages/db/src/repositories/operator/job-placement.ts:49` hardcodes `ownerMembershipActive: true` on every row it returns (the operator DB presumably cannot see tenant memberships), and that snapshot flows through `server/src/services/job-placement-transaction.ts:74`. If any authorization decision consumes the *operator* snapshot rather than the tenant one (`job-control.ts:1697`), D11's clause has a bypass on that path. **This was not traced.** It must be resolved before I15 is claimed as a full proof rather than a chokepoint proof.

**R9 — D16 is a behaviour change to shipped paths.** See D16. Release-note item, not a diff detail.

**OQ-1 — Does the program owner ratify the Tier 2 Windows lane?** It adds a permanent merge blocker and ~4 billable minutes per non-draft PR. If declined, I9/I10 drop to the advisory weekly lane and the per-OS gate condition widens accordingly. This is a shared-resource decision, not the ticket author's to assume.

**OQ-2 — What is the consent model for a device-local credential grant?** Enrollment-time blanket, per-job prompt, or per-credential opt-in. DSK-001 pins the *authorization* contract (D12) but not the *consent surface*. DSK-002 cannot design its folder grants without an answer.

**OQ-3 — Does the macOS write path exist without argv exposure?** Blocks D4 and DSK-003's macOS adapter. Needs real hardware.

### Operator actions required (with lead time)

| Action | Needed by | Lead time |
|---|---|---|
| **Ratify the Tier 2 CI lane** (OQ-1) — adds a required Windows job to every non-draft PR. | Before DSK-001a merges. | Same-day decision; no procurement. |
| **Provide a macOS host (physical or hosted) for D4 / OQ-3 evaluation.** | Before DSK-003 planning; ideally before DSK-001a locks the macOS command plan. | Days if a runner already exists; weeks if hardware must be procured. |
| **Provide a second Windows local account (or a self-hosted Windows runner) for R3.** | Before DSK-001's per-OS evidence record is written. | Hours on a dev box; days for a self-hosted runner. |
| **Windows Authenticode code-signing certificate — EV or Azure Trusted Signing.** Not needed by DSK-001 (which ships no installer), but issuance is the long pole for DSK-003. EV certificates require organizational identity validation and hardware-token or cloud-HSM delivery. | DSK-003. | **2–6 weeks**, longer if the legal entity's validation documents are not already on file. Start now. |
| **Apple Developer Program membership + Developer ID Application certificate and notarization credentials** (app-specific password or App Store Connect API key) for DSK-003's macOS installer. | DSK-003. | **1–2 weeks** for enrollment (longer for organizational enrollment requiring a D-U-N-S number); notarization itself is minutes once credentials exist. Start alongside the certificate above. |
| **Decide whether the E10 README adopts DSK-000** (`docs/replatform/epics/E10-desktop-migration-realtime/README.md:5,10` lists DSK-001..004 + MIG-001..008 and owns none of Lane C). | Before Lane C is written, either way. | Same-day. |