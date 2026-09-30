# DSK-001 Lane A — Enrollment Client: Implementation Addendum

**Status:** binding addendum to `docs/replatform/epics/E10-desktop/tickets/DSK-001-design.md`. Where this document and the design doc disagree, this document is authoritative; every disagreement is enumerated in §0 and §5 with the evidence that forced it.

**Posture.** Fail-closed on custody, mint-once by construction, and **enrol exactly once per device identity** — not once per boot. The whole plan is derived backwards from three facts about the server that have no client-side remedy:

1. `hello.workerId` is client-chosen and becomes the `workers` primary key verbatim (`server/src/services/worker-enrollment.ts:459-460`).
2. A second `workerId` from the same device is denied at **two** sites — the bound-worker branch (`:418-423`) and the global `findWorker` check (`:453-458`) — and `findWorkerForBinding` (`packages/db/src/repositories/tenant/worker-enrollment.ts:274-287`) carries **no status or `revokedAt` predicate**, so the denial outlives revocation. There is no `delete(workers)` anywhere in `server/src` or `packages/db/src`.
3. Therefore: **no `workerId` may ever reach the control plane without first being durable on the device.** Everything below is machinery around that sentence.

---

## 0. Corrections that reshape the work

These are not stylistic. Each one changes a file list or an invariant statement.

| # | Correction | Evidence |
|---|---|---|
| C1 | **`EnrollerDeps.keyStore` is `DeviceKeyStore`, not `DeviceIdentityStore`.** The built `createOsIdentityStore` is not structurally assignable. D8's own body ("an optional `identityStore` field on `EnrollerDeps`") contradicts its own header ("`createEnroller` is not modified"). Resolved by a *frozen view over a resolved key*, giving `enroll.ts` **zero diff**. | `enroll.ts:96-104` vs `packages/worker-keystore/src/identity-store.ts:47-54`; `identity/key-store.ts:32-40` |
| C2 | **The landed identity envelope is too narrow.** It holds `{workerId, privateKeyPkcs8Der}` (`envelope.ts:24-27`); D7 specified `{version, workerId, targetId, deviceGeneration, pkcs8}` (`DSK-001-design.md:250`). Restore D7's shape. Without `targetId` the device cannot *refuse* a ticket for a second target, and a refusal is the only thing standing between "operator creates a new target" and a permanent double-mint. | §5/A4 |
| C3 | **`saveIfAbsent → "stored"` is not durable.** The store script never calls `Flush($true)` / `WriteThrough`; `grep -rn "Flush\|WriteThrough\|fsync" packages/worker-keystore/ packages/worker-daemon/src/identity/` is empty. Exit 0 means "in the page cache". | §5/A1 |
| C4 | **The absence oracle is `existsSync`, which collapses every errno to `false`.** Measured on real Windows: an existing-but-denied file yields `accessSync → EPERM` and `existsSync → false` → `absenceSignalled: true` → `load()` returns `null` → **mint**. This defeats I3 in every one of the three candidate designs. | `command-runner.ts:59,68`; `outcome.ts` branch 1; `identity-store.ts:81-83` |
| C5 | **I11 cannot live at D14's `:131-136` seam.** `startHealth` binds at `bin/worker-daemon.ts:128`, and the test I11 is told to model asserts `expect(startHealth).not.toHaveBeenCalled()` (`__tests__/entrypoint-signals.test.ts:122`). The *check* moves above `:128`; the *action* stays below it. | `DSK-001-design.md:331` |
| C6 | **D13's capacity-as-a-matching-axis claim is false.** `evaluateStaticLeaseEligibility` overwrites `capacity` with `NEUTRAL_LEASE_MATCHER_CAPACITY` (slots forced to 1, `server/src/services/job-lease-eligibility.ts:20-27,210-215`) and `job-placement.ts:544-546` substitutes live poll capacity. Keep all-zero capacity — but for **replay byte-stability**, and never assert I12 through it. | `capabilities.ts:475,481-486` |
| C7 | **`deviceGeneration` is a fifth missing input.** Server-compared exactly (`:450-452` fresh, `:424-426` rebind); the issue response returns only `{code, expiresAt}` (`:229`); DB default is 1 (`packages/db/src/schema/execution_targets.ts:31`); no `AOA_WORKER_*` var carries it (`config/config.ts:56-71`). Lane A hardcodes 1, **persists it**, and fails loudly. | §7/OQ-2 |
| C8 | **`capabilities.providerConstraints` is an undocumented server-side prerequisite.** `worker-enrollment.ts:485` feeds a required, non-nullable `.strict()` schema (`packages/worker-protocol/src/job.ts:141-143`); nothing in production writes that key (the create route spreads a free-form body, `server/src/routes/execution-targets.ts:146`). The ZodError escapes the typed catch at `worker-control.ts:192` → **503**. A plainly-created desktop target 503s on every enrol. | §7/OQ-3 |
| C9 | **F17 is stale.** Owner-scope code issuance already requires an active `organizationMemberships` row (`packages/db/src/repositories/tenant/worker-enrollment.ts:225-235`, blamed `a042662eba`, covered by `worker-enrollment.integration.test.ts:2018`). D11(a) is an assertion, not a build — a Lane B scope reduction. | — |
| C10 | **F10/D1 bookkeeping is already closed.** `packages/worker-keystore` is in `vitest.config.ts:24`, `Dockerfile:65` has the COPY, and the boundary checker runs in the always-on `policy` job (`.github/workflows/pr.yml:164-165`). Do not redo it. | — |
| C11 | **I7 must be restated.** The *hello* is not byte-stable across a legitimate rebind (which must send `deviceGeneration + 1`). **`workerId` is the stable quantity.** The hello is byte-stable across every *retry of the same enrolment*, which is what the replay branch requires (`:340,:347`). | — |

---

## 1. Files

Placement rule, from D1/F2 and `scripts/lib/worker-daemon-boundary.mjs:112-113`: **no file under `packages/worker-daemon/src` may name `@armyofagents/worker-keystore`.** The daemon therefore owns the protocol half (it already depends on `@armyofagents/worker-protocol`) and declares the custody port structurally; `packages/worker-keystore` owns the OS half and the composition root, which is the only file in the repo that names both packages.

### 1A. New — `packages/worker-daemon/src/`

Every file below imports only `node:*` builtins, `@armyofagents/worker-protocol`, and in-package modules. **No new dependency**, so the two-dependency pin at `worker-daemon-boundary.mjs:153-159` is untouched.

| File | Responsibility |
|---|---|
| `identity/device-identity-store.ts` | The custody port + the custody verdict, types only plus two pure functions. Declares `DeviceIdentityRecord` (`{v:1, workerId, targetId, deviceGeneration, privateKeyPkcs8Der}`), `DeviceEnrollmentReceipt` (`{v:1, workerId, targetId, deviceGeneration, deviceThumbprint}`), and `DeviceRecordStore<T> = { load(): T \| null; saveIfAbsent(r: T): "stored" \| "already_present"; clear(): void }` — structurally identical to `packages/worker-keystore/src/identity-store.ts:47-54`, declared separately so nothing is *named*. Exports `resolveCustody(mode, identityStore, receiptStore)` (pure, the I11 truth table in §4/D3) and `frozenDeviceKeyView(key): DeviceKeyStore`. |
| `enrollment/ticket.ts` | **I8.** `encodeEnrollmentTicket` / `decodeEnrollmentTicket` over `aoa_tkt_<base64url(JSON({v,targetId,code}))>`. Pure; no `process`, no `node:fs`. Rules: prefix exact; remainder matched against `/^[A-Za-z0-9_-]{1,512}$/` **before** decoding (never decode unbounded input); decoded value must be a plain object whose `Object.keys(x).sort()` **equals** `["code","targetId","v"]` (an exhaustive key check, not a destructure — this is what makes "and NOTHING else" testable); `v === 1`; `targetId` via `targetIdSchema` (`packages/worker-protocol/src/ids.ts:40`); `code` against the client mirror of the server regex `/^aoa_enr_[A-Za-z0-9_-]{16,64}\.[A-Za-z0-9_-]{32,128}$/` (`worker-enrollment.ts:80-84`). Fixed serialization key order `{v, targetId, code}`. **Every rejection error names the failing constraint and never interpolates the input** — see §3/I13. |
| `enrollment/enrollment-input.ts` | The reader that closes F15. `readEnrollmentInput(source, env, readFileText)` over `config.enrollmentCodeSource` (`config/config.ts:29-31`, parsed at `:135`, **zero readers today**) → `{ targetId, enrollmentCode }`. The field is named `enrollmentCode`, not `code`, deliberately: `enrollmentcode` is in the daemon logger's `SENSITIVE_SUBSTRINGS` while `code` is not. `{kind:"path"}` **rejects any non-local path before reading** — leading `\\`, `\\?\UNC\`, and network-mapped drive letters — because `parseEnrollmentCodeSource` validates only non-emptiness (`config.ts:103-121`) and a UNC read is an authenticated SMB round-trip (§5/A5). Trims a single trailing newline. Never logs, never returns the raw text, never echoes file contents in an error. |
| `enrollment/desktop-hello.ts` | **I12 + replay byte-stability.** `buildDesktopHello({workerId, targetId, deviceGeneration, platform, arch})`, `UNPROVISIONED_POLICY_HASH`, `DESKTOP_RUNTIME_LABEL = "desktop"`, `FIRST_ENROLLMENT_DEVICE_GENERATION = 1`. Emits `reportedCapabilities: []`, `policyHash: UNPROVISIONED_POLICY_HASH`, all-zero `capacity`, `agentVersion: WORKER_VERSION` (`config/config.ts:18`), `supportedProtocol: {min: MIN_PROTOCOL_VERSION, max: PROTOCOL_VERSION}`, and `platform.runtime` as the **constant** `"desktop"` — never `process.version`. Maps `win32→windows`; **throws a named error** for any `arch` outside `["x64","arm64"]` (`capabilities.ts:102`) rather than letting a ZodError surface from `transport/envelope.ts:40`. Returns `workerHelloV1Schema.parse(...)` output. |
| `enrollment/idempotency.ts` | `deriveEnrollmentIdempotencyKey(workerId, targetId, deviceGeneration)`. `h = sha256("aoa.worker.enroll.idem.v1|" + workerId + "|" + targetId + "|" + deviceGeneration)`; take `h[0..15]`; set `b[6] = (b[6] & 0x0f) \| 0x50`, `b[8] = (b[8] & 0x3f) \| 0x80`; render `8-4-4-4-12` **lowercase** (`semantic_idempotency_key` is `text` compared with `===`, `packages/db/src/schema/worker_enrollment_codes.ts:23`). **No secret is an input** — the enrollment code is deliberately excluded so the wire value is not a derivative of a live credential. |
| `enrollment/enroll-once.ts` | The coordinator. `enrollOnce(deps): Promise<EnrollmentOutcome>`, ordering in §2. `EnrollmentOutcome` is a **frozen object with a fixed key allowlist and no session/token key**: `{ enrolled, minted, skipped, workerId, targetId, deviceGeneration, deviceThumbprint?, failure? }`. Deps: `{ identityStore, receiptStore, client, input, generateKey?, randomWorkerId?, platform?, arch? }` — `generateKey` and `randomWorkerId` are injectable **specifically so I3 and I7 are proven by counting spies, with no module mocking**. |

### 1B. Edited — `packages/worker-daemon/src/`

`bin/worker-daemon.ts` (§4, D1–D5) and `index.ts` (barrel re-exports). **`enrollment/enroll.ts`, `identity/key-store.ts`, `config/config.ts`, and `package.json` get zero lines** — justified in §4.

### 1C. New — `packages/worker-keystore/src/`

Boundary-legal: `node:crypto`/`node:fs`/`node:os`/`node:process` are builtins (`worker-keystore-boundary.mjs:75-86`); only `node:child_process` is basename-confined (`:60,:114`) and only `node:module` is banned (`:73`).

| File | Responsibility |
|---|---|
| `blob-path.ts` | `resolveVaultRefs(env, platform)` → `{ identity: {blobPath}, receipt: {blobPath} }` at the **single fixed location** `%LOCALAPPDATA%\AoA\worker\device-identity.v1.bin` and `…\device-enrollment.v1.bin` (`DSK-001-design.md:208`). **Not** namespaced by `targetId` — see §5/A4. Throws when `platform !== "win32"`, when `LOCALAPPDATA` is absent or not absolute, and never falls back to `APPDATA` (roaming a `CurrentUser` DPAPI blob is D3's named footgun) or to cwd. |
| `receipt-envelope.ts` | `encodeEnrollmentReceipt` / `decodeEnrollmentReceipt`, same base64url+JSON discipline and same partial-record-throws rule as `envelope.ts`. |
| `bin/desktop-host.ts` | The testable host. `runDesktopHost(deps): Promise<{ok: boolean}>` with `{env, proc, platform, argv, createRunner?, bootstrap?, readFileText?, createLogger?}`. Composes the two record stores, calls `bootstrapWorkerDaemon({env, proc, identityStore, receiptStore})`, and owns the **only** caller of `clear()`: the guarded `--reset-identity` subcommand (§3/I7). |
| `bin/aoa-worker-desktop.ts` | Six-line real entry, copying the `invokedDirectly` guard from `bin/worker-daemon.ts:161-171`. |

### 1D. Edited — `packages/worker-keystore/src/` (already-landed, CI-green code)

| File | Edit | Why it is not optional |
|---|---|---|
| `command-runner.ts` | Replace the `deps.fileExists ?? existsSync` oracle (`:59`, used at `:68`) with a **three-valued, errno-discriminating probe**. The injectable seam's *type* changes from `(path) => boolean` to `(path) => "absent" \| "present" \| {fault: string}`, because a boolean cannot express a fault and every fake therefore inherits the bug. Only `ENOENT` yields `absenceSignalled: true`; `ENOTDIR`, `EPERM`, `EACCES`, `EBUSY`, `EIO`, `ELOOP`, `UNKNOWN` and an invalid path return `{exitCode: null, absenceSignalled: false, stderr: "device identity blob probe failed: <code>"}`, landing on `classifyStoreOutcome`'s `unavailable`/`denied` branches. Also: pass an explicit minimal `env:` allowlist to `execFileSync` so the child does not inherit an environment block that may hold the ticket. | §5/A2. `plan.stdin === "none"` matches **`delete` as well as `load`** (`command-plan.ts:175`), so `clear()` inherits the same oracle and today returns success on a failed wipe, contradicting its own contract at `identity-store.ts:52-53`. |
| `command-plan.ts` | `store` branch (`:125-141`): (a) `[IO.Directory]::CreateDirectory` on the parent before `Open`; (b) keep the exclusive `[IO.File]::Open($path,'CreateNew')` on the **final** path — **do not** adopt temp+`Move`; (c) add `$fs.Flush($true)` before `Dispose`; (d) narrow `catch [IO.IOException]` to `exit 4` only for HResult `0x80070050` (ERROR_FILE_EXISTS), letting every other `IOException` fall through to the hardened `exit 3`; (e) emit a fixed success sentinel on stdout after `Dispose`. | (c) is §5/A1. (b) is the *repair of the repair*: `Move` places the publish step after the last flushable point and .NET offers no directory-fsync, converting a fail-closed brick into a fail-open double-mint. (d) currently reports disk-full and network-path-not-found as `already_present`. (e) closes `identity-store.ts:123`, which today infers `"stored"` from `corrupt && exitCode === 0`. |
| `envelope.ts` | Restore D7's shape (C2): `{v, workerId, targetId, deviceGeneration, privateKeyPkcs8B64}`. Rename `k` → `privateKeyPkcs8B64` and **correct the comment at `:31-35`**, which cites the wrong list: the guard that applies to a diagnostic is the daemon logger's `SENSITIVE_SUBSTRINGS`, not the wire normalizer, and `k` is the one name guaranteed *not* to be redacted while `privateKeyPkcs8B64` normalizes to contain `privatekey`. Keep `v: 1` — zero devices are enrolled today, so there is no v1 corpus to migrate. |
| `identity-store.ts` | Generalize to `createOsRecordStore({runner, ref, platform, codec})`; keep `createOsIdentityStore` as a thin alias bound to the identity codec so existing exports and tests are unchanged. Require the success sentinel for `"stored"`. Correct the comment at `:30-34`: nothing in the daemon keys on the error *name*; the fail-closed property comes entirely from the throw being uncaught, and §3/I3 makes that explicit rather than aspirational. |
| `index.ts` / `package.json` | Export `resolveVaultRefs`, the receipt codec, and `createOsRecordStore`; add `"bin": {"aoa-worker-desktop": "./dist/bin/aoa-worker-desktop.js"}`. |
| `scripts/check-worker-keystore-boundary.mjs` + its test | Add `existsSync` to the banned-import list for `command-runner.ts` so the boolean oracle cannot creep back; add an adversarial corpus case for `bin/aoa-worker-desktop.ts` importing `node:child_process` (must be rejected). |

**Verification step before the first commit:** confirm `@armyofagents/worker-daemon` is present both in `ALLOWED_BARE` (`worker-keystore-boundary.mjs:54-57`) **and** in the manifest runtime-dep union checked by `evaluateManifest` (`:138-163`). If the union does not already include it, that is a one-line manifest edit plus the matching expected-union entry, in the same commit, called out in the PR body. Do not assume; the checker is exact-equality.

---

## 2. Ordering and crash points

```
S0  loadWorkerConfig                                   bin/worker-daemon.ts:107-114
S1  resolveCustody(mode, identityStore, receiptStore)  ← I11. PURE. BEFORE any socket.
S2  startHealth                                        :128  ← first and only socket
S3  runStartupSteps                                    :131-136
S4  enrollOnce:
    a. identity = identityStore.load()      ← FIRST store I/O. Throws ⇒ fatal, zero mints, ticket unread.
    b. receipt  = receiptStore.load()       ← same fault discipline.
    c. if (identity && receipt) → return {skipped:true, …receipt}
                                              NO ticket read. NO network. EVER AGAIN.   ◄ steady state
    d. input = readEnrollmentInput(config.enrollmentCodeSource, env)   ← credential enters memory HERE
    e. if (identity && identity.targetId !== input.targetId) → REFUSE, exit non-zero, zero mints
    f. if (identity === null):
         workerId = randomWorkerId(); key = generateKey()
         record   = {v:1, workerId, targetId: input.targetId, deviceGeneration: 1,
                     privateKeyPkcs8Der: exportDevicePrivateKeyPkcs8Der(key)}
         switch (identityStore.saveIfAbsent(record)) {              ◄ THE DURABILITY POINT
           "stored"          → minted = true
           "already_present" → identity = identityStore.load()
                               if (identity === null) THROW  // contradiction, never a re-mint
                               minted = false
         }
       else minted = false
    g. key   = deviceKeyFromPkcs8Der(identity.privateKeyPkcs8Der)
    h. hello = buildDesktopHello({...identity, platform, arch})
    i. idem  = deriveEnrollmentIdempotencyKey(identity.workerId, identity.targetId,
                                              identity.deviceGeneration)
    j. result = await createEnroller({keyStore: frozenDeviceKeyView(key), client})
                      .renew({hello, code: input.enrollmentCode, idempotencyKey: idem})  ◄ THE NETWORK POINT
    k. receiptStore.saveIfAbsent({v:1, workerId, targetId, deviceGeneration,
                                  deviceThumbprint: result.deviceThumbprint})
    l. drop result.session; return the frozen outcome
```

Five orderings are load-bearing, and four of them are inversions of the obvious:

- **S4a before S4d.** The store verdict precedes any read of the credential, so a fault-store boot never materializes a live single-use code — and, with the non-local-path rejection in `enrollment-input.ts`, never performs *any* file or network I/O for it. This is the repair for §5/A5.
- **S4c short-circuits before S4d.** After one successful enrolment the device never reads the code again and never contacts the control plane again. This is the repair for §5/A4 and it is what makes the 10-minute code TTL, the `deviceGeneration + 1` rebind rule, and the 503 retry trap all unreachable on the ordinary boot path.
- **S4f-persist strictly before S4j.** The mint-then-enrol-then-persist shape is the F13 lockout generator: crash after the server commits but before the persist and the next boot mints a second `workerId`, denied forever.
- **S4f discards on `already_present`.** The CAS loser adopts the winner's *complete record* — `workerId` and key together — so two processes never present two identities.
- **S4g re-derives the key from the persisted bytes even on the freshly-minted path.** Both paths then execute identical code, so an envelope round-trip bug surfaces on the *first* run, before the server has committed anything.

### `renew()`, not `enroll()`

`enroll()` mints a fresh idempotency key per call (`enroll.ts:230`) and only *returns* it (`:89,:219`); nothing persists it, so a lost response across a restart hits `stored.semanticIdempotencyKey !== request.idempotencyKey` (`worker-enrollment.ts:325-327`) → **400 malformed, terminal, forever**, on a code that can never be re-consumed. `renew()` accepts a caller-supplied key (`enroll.ts:112,:232-234`) and `submit` builds a byte-identical body either way (`:146-226`); the server decides fresh-vs-replay from `stored.consumedAt` (`:324`). `EnrollResult.replay` is a cosmetic local label and `enrollOnce` does not surface it. **Do not** inject `randomProofId`/`randomNonce`/`randomUuid` for determinism: `recordProof` runs before the consumed-branch and rejects a duplicate `(deviceThumbprint, proofId)` (`:315-322`) → 401. Byte-stability is required of `hello` **only**, never of the transport envelope.

### Crash-point table

| Gap | On-disk state | Next-start behaviour |
|---|---|---|
| **G0** — before S4f | pre-existing slots, or nothing | identical run |
| **G1** — S4f mint in memory → `saveIfAbsent` | nothing new | `load()` → absent → mint a **different** `workerId`. **Safe by construction:** no bytes reached the server, so neither `findWorkerForBinding` nor `findWorker` can collide. This is safe *only because* persist precedes network. |
| **G2(i)** — inside `saveIfAbsent`, before the `CreateNew` directory entry is on the platter | identity slot absent | `absent` → clean re-mint. Safe. |
| **G2(ii)** — `CreateNew` committed, `Write`/`Flush($true)` not | identity slot present, **zero bytes** | probe reports *present* (correctly), `Unprotect` on empty throws → exit 3 → `locked` → `DeviceKeyStoreError` → **fatal, zero mints, zero network**. A recoverable brick, not a silent second identity. Because persist precedes network, a zero-length identity slot with **no** receipt slot provably predates any control-plane contact, so `--reset-identity` in exactly that state is safe and the guard says so (§3/I7). |
| **G3** — after `Flush` returns / exit 0, before S4j | identity slot complete, receipt absent | same `workerId`, same key, byte-identical hello, same derived idempotency key; server has nothing; fresh consume. **I7 holds.** |
| **G4** — S4j request sent, response lost | identity complete, receipt absent; server may or may not have committed | identical identity → identical derived key → if the server committed, the replay branch's four preconditions all hold (`:325-327` key, `:328-330` thumbprint, `:331-333` digest, `:336-353` authority) → 200 + fresh session → receipt written. If the transaction rolled back (`:520-526`), a clean fresh consume. |
| **G5** — after 200, before S4k | identity complete, receipt absent; server enrolled | replay → 200 → receipt written. **Past the 10-minute route TTL** (`CODE_TTL_MS`, `:22`, gated at `:295-297` *before* the replay branch) → 401 → **non-fatal** (the identity pre-existed), one attempt, no retry, daemon runs idle. Documented steady state; see §7/OQ-2 for the rebind path. |
| **G6** — after S4k | both slots complete | S4c short-circuits: no ticket read, no network, no failure surface. |
| **concurrent processes** (not a crash) | one identity slot | both load `null`, both mint; `Open(…,'CreateNew')` is a real OS CAS → one `"stored"`, one exit 4 → the loser adopts the winner's record → both derive the same idempotency key → `lockCode`'s `SELECT … FOR UPDATE` serializes them → one consume, one replay. One identity, one `workers` row, two valid sessions. |
| **snapshot revert / reimage / profile delete** | both slots gone; server row intact | mint W2 → `worker_transfer_denied`, permanent. **R5. Unfixable client-side** — no local state can be made as durable as a committed server row. Server-side follow-up in §7/OQ-1. |

---

## 3. Invariants: mechanism and proof

### I3 — a store that cannot open never yields a new identity

**Mechanism, four independent layers.**

1. **`load()` is the first statement and is not wrapped.** `enroll-once.ts` contains no `try`/`catch` around S4a/S4b. A throw propagates out of `enrollOnce`, is caught only by bootstrap's D4 block, and exits non-zero. `generateKey` (S4f) sits lexically inside the `identity === null` branch of that same expression's result — it is not on the throw path.
2. **`null` now has exactly one origin, and it is a real ENOENT.** After the C4 fix, `createOsRecordStore.load()`'s single `return null` is guarded by `outcome.kind === "absent"`, which is reachable only through `absenceSignalled`, which the runner sets only when the errno-discriminating probe returns `"absent"` — i.e. `ENOENT` and nothing else. Every other errno becomes `unavailable`/`denied` and **throws**. Before this fix the chain terminated in `existsSync`, a boolean, and a denied blob read as "never enrolled".
3. **Fail-closed keys on "anything thrown", never on a class and never on a name.** There are two unrelated `DeviceKeyStoreError` classes (`identity/key-store.ts:25-30`, `worker-keystore/src/identity-store.ts:35-40`) with `instanceof` false across them; `deviceKeyFromPkcs8Der` throws a **plain `Error`** (`identity/device-key.ts:75-83`); and `planVaultCommand` throws a plain `Error` on any non-`win32` platform (`command-plan.ts:164-169`) *before* the runner is ever invoked, because `load()` evaluates the plan inside the `runner.run(...)` argument. Any narrow catch anywhere in the coordinator silently regresses I3. **Rule: `enroll-once.ts` may catch only `EnrollmentError` from `client.enroll`, at the single S4j call site, and nowhere else.**
4. **The enroller cannot mint behind our back.** `frozenDeviceKeyView(key)` returns `Object.freeze({load: () => key, save: throws, clear: throws})`. `loadOrCreateKey` (`enroll.ts:131-137`) does a truthiness check at `:133`, so `generateDeviceKey()` at `:134` and the non-CAS `keyStore.save(created)` at `:135` are unreachable — on the `renew()` path as well as `enroll()`, since `submit` calls it at `:147` for both. `save`/`clear` **throw** rather than no-op: a no-op would silently swallow a future regression in `loadOrCreateKey`; a throw makes it loud, at zero cost because neither is reachable.

**Proof.** `T-I3` (`enroll-once.fail-closed.test.ts`): a store whose `load()` throws, run over **five** error identities — the daemon's `DeviceKeyStoreError`, the keystore's same-named class, a plain `Error`, a foreign object carrying `name === "DeviceKeyStoreError"`, and a record whose PKCS8 is garbage so the throw originates in `deviceKeyFromPkcs8Der`. In every case: `enrollOnce` rejects, and the `generateKey`, `randomWorkerId`, `saveIfAbsent`, `readFileText` and `fetchImpl` spies each record **0** calls. `T-I3b` (`command-runner.test.ts`, a file with **zero tests today**): inject the probe returning `ENOENT` → `absenceSignalled: true`; `EPERM`/`EACCES`/`EBUSY`/`ENOTDIR`/`UNKNOWN` → `absenceSignalled: false` and `load()` **throws**, `clear()` **throws**. `T-I3c`: a store composed over the *real* `createCommandRunner` with a faulting probe → `generateKey` 0 calls. (Today's `identity-store.test.ts` hand-sets `absenceSignalled` on fabricated result literals, so it can never reach this path.)

### I6 — `workerId` and the private key are one artifact

**Mechanism.** One envelope, one write. `DeviceIdentityRecord` carries `{v, workerId, targetId, deviceGeneration, privateKeyPkcs8B64}`; `decodeIdentityEnvelope` throws on a partial record and never decodes half. The write is a single exclusive `CreateNew` + `Write` + **`Flush($true)`** + `Dispose`, so exit 0 means the bytes are on stable storage, not merely in the page cache. The only representable intermediate states are "final path absent" (→ `absent`, clean re-mint, safe because no network call preceded it) and "final path present, zero bytes" (→ `locked`, fatal). There is no state that decodes to half a record.

**Proof.** `T-I6a` (`store-atomicity.test.ts`, keystore): a scripted runner over a modelled filesystem, one case per interrupt point — every intermediate state must classify as `absent` or decode as a complete record. Non-vacuity: a variant script without `Flush($true)` whose data is discarded must produce a state that is neither, and fail. `T-I6b` (`command-plan.test.ts`, extended): byte-equality of the corrected `store` script and argv against the regenerated fixture; assert the script contains `Flush($true)`, contains `'CurrentUser'` and not `'LocalMachine'`, does **not** contain `Move` (a byte-lock against the tempting temp+rename regression, §5/A1), and that `argv[0]` is the absolute System32 path with `-NoProfile -NonInteractive -EncodedCommand`.

### I7 — `workerId` is minted at most once per store and is byte-stable across restarts, including after a failed enroll

**Mechanism, five parts.**

1. **The mint is gated on `identity === null` and nothing else** (S4f). On every later boot `load()` returns the record and the branch is skipped entirely.
2. **Persist precedes network** (S4f before S4j), so a 401 (`mapErrorStatus` → terminal + `stopAndBackoff`, `enroll.ts:247-254`) or a 503 (`:259-260`) is raised *after* durable state exists.
3. **Nothing on the failure path calls `clear()`.** This is a stated rule, not an omission: a lost response can mean the server committed the identity, so a local wipe would *guarantee* the `worker_transfer_denied` lockout on the next attempt. `enrollOnce` has no retry loop and no compensating delete.
4. **`clear()` has exactly one caller in the tree** — the `--reset-identity` subcommand in `bin/desktop-host.ts` — and it is **guarded**. It requires an explicit acknowledgement argument, logs the `workerId` and `targetId` it is about to destroy, and states that the target becomes permanently unenrollable (the bound-worker branch at `worker-enrollment.ts:418-423` will deny any subsequent `workerId`, and there is no reset route). In the one provably-safe state — identity slot present but zero-length **and** receipt slot absent, i.e. a G2(ii) crash before any network call — the guard prints a different, non-alarming message and proceeds. `clear()` wipes both slots.
5. **A ticket for a different target is a refusal, not a mint** (S4e). This is why the record carries `targetId` (C2) and why the blob path is fixed rather than `targetId`-keyed (§5/A4).

**Restated (C11):** `workerId` is the byte-stable quantity. The *hello* is additionally byte-stable across every retry of the same enrolment — which is what the replay path requires (`:340,:347`) — but not across a legitimate rebind, which must send `deviceGeneration + 1`.

**Proof.** `T-I7a` (`enroll-once.mint-once.test.ts`): one in-memory CAS store pair, four sequential `enrollOnce` runs — 200, restart, forced 401, restart — with injected `randomWorkerId`/`generateKey` spies. Assert **exactly one** call each, and four captured request bodies whose `hello` serializes byte-identically. `T-I7b` (`enroll-once.no-clear.test.ts`): for 401 / 400 / 503 / transport failure, `clear` spy = 0 calls and the stored bytes are unchanged; plus a source assertion that `clear(` has exactly one call site outside tests. `T-I7c` (`enroll-once.replay-recovery.test.ts`): a fake plane that consumes the code and records `semanticIdempotencyKey` on attempt 1 then drops the response; a fresh coordinator over the same store must present the *same* key and the same hello, and the plane's replay branch must accept. Non-vacuity: substituting `randomUUID` for the derived key must fail the test. `T-I7d` (`enroll-once.steady-state.test.ts`): with both slots populated, `readFileText`, `fetchImpl` and `randomWorkerId` spies all record **0** calls and the outcome is `{skipped: true}`. `T-I7e`: identity slot with `targetId: T1` plus a ticket for `T2` → rejects, `generateKey` 0 calls, `fetchImpl` 0 calls.

### I8 — the ticket carries `{v, targetId, code}` and nothing else

**Mechanism.** Exhaustive key equality (`Object.keys(x).sort()` deep-equals `["code","targetId","v"]`), not a destructure; bounded charset/length check *before* decoding; `v === 1`; branded-UUID `targetId`; the server's own code regex; fixed serialization key order for byte-exact round-trip.

**Proof.** `T-I8` (`ticket.test.ts`): a vector table covering round-trip, extra key, missing key, `v:2`, non-UUID `targetId`, code failing the server regex, >512 bytes, non-base64url, empty, decoded array, decoded string. Plus the canary from §3/I13.

### I11 — `os_keychain` with no injected identity store exits non-zero before any network I/O

**Mechanism.** `resolveCustody` is **pure** and runs at `bin/worker-daemon.ts:114`, immediately after the config catch block and **before** `makeMetrics` (`:127`) and `startHealth` (`:128`) — the only socket in the process (`health/health-server.ts:62`). It is a four-row truth table (§4/D3), including the deliberate strengthening that `mounted_secret` **with** an injected store also exits non-zero (silently ignoring an injected OS store because an env var disagrees is the same "make the mode a lie" fail-open, in the other direction). The first outbound call in the package is `doFetch` (`transport/client.ts:200`), reachable only from `client.enroll`; `createControlPlaneClient` performs zero I/O at construction (`:196-215` builds a URL string and reads descriptor constants).

**Polarity warning, to be stated in the docblock.** Every existing optional seam in this file degrades to `[]` when absent (`:135`, `:142`, `:143`) — fail-**open**. `identityStore` is fail-**closed**. Composing it as a fifth `deps.X ? … : []` would satisfy the file's convention and violate the invariant.

**Proof.** `T-I11` (`entrypoint-enrollment.test.ts`): a sibling `describe` to `entrypoint-signals.test.ts:109-127`, reusing `baseEnv`/`noopLogger`/`fakeProc` (`:8-39`). Case (a) `AOA_WORKER_KEY_STORE_MODE=os_keychain`, no `identityStore` → `ok === false`, `startHealth` **not called**, `listeners.size === 0`, exactly one non-zero exit, and `fetchImpl`/`readFileText`/`readStdin` spies all **0** — the assertion block transfers verbatim from `:118-126` and the four spies close the "the invariant only checked the socket" gap. Case (b) `mounted_secret` + injected store → same. Case (c) `mounted_secret`, no store → `ok: true`, health opened, `createClient` spy 0 calls (the shipped-container non-regression). Case (d) happy path → custody verdict, then health, then enrolment, in that order.

### I12 — a DSK-001 desktop worker can never be matched work

**Mechanism.** `reportedCapabilities: []` is the **unconditional** axis: `workerSatisfiesRequirements` computes `effective = capabilityCeiling ∩ reportedCapabilities` and returns `false` unless `effective` contains `workload.<type>` (`capabilities.ts:481-486`). With an empty reported set, `effective` is empty for *any* server ceiling, and `workloadType` is a closed three (`states.ts:30-31`), so the check is always a non-empty string against an empty set. `policyHash: UNPROVISIONED_POLICY_HASH` is the independent secondary axis (`:475`). Both survive to the real call sites because both read the **stored enrolled hello**: the lease path passes `parsedStoredHello.data` (`job-leasing.ts:636-641`) and the placement path spreads it (`job-placement.ts:544-546`) after re-verifying `sha256(JSON.stringify(worker)) === candidate.workerProfileHash` (`:542-543`), so a later poll cannot rewrite the capability set. Nothing on the enroll path validates `policyHash`, `reportedCapabilities` or `capacity` — the hello is hashed and stored verbatim as `profileSnapshot` (`worker-enrollment.ts:409,459-472`).

**C6, restated as a test rule:** all-zero `capacity` contributes **zero** unmatchability and must never carry an I12 assertion.

**Proof.** `T-I12` (`desktop-hello.test.ts`): N generated `JobCapabilityRequirementsV1` × registered profiles through the **real** `workerSatisfiesRequirements` → 0 matches. Non-vacuity 1: repopulating `reportedCapabilities` from the ceiling *and* aligning `policyHash` must produce ≥1 match. Non-vacuity 2: re-run the entire suite with `capacity` slots forced to 1 and still assert 0 matches, proving the result rides on `reportedCapabilities` rather than on a field both real call sites overwrite. Plus: `workerHelloV1Schema.parse` succeeds; two builds are `JSON.stringify`-identical; `arch: "ia32"` and `platform: "aix"` throw named errors; `UNPROVISIONED_POLICY_HASH` recomputes from its documented preimage.

An end-to-end I12 test is vacuous by construction and must not be written: `bin/worker-daemon.ts:48-54` documents that the poll loop is deliberately not wired, so **no** daemon can be matched work today regardless of hello shape.

### I13 — the session token is never persisted and is dropped after enrollment

**Mechanism.** The token exists only as `WorkerSession.token`, read from the `aoa-worker-session` response header (`transport/client.ts:384`) into `EnrollResult` (`enroll.ts:204,218`). `EnrollmentOutcome` has a frozen key allowlist with no `session`/`token`; `BootstrapResult` (`bin/worker-daemon.ts:89-96`) gains **no** new field; the receipt slot stores `deviceThumbprint`, never a bearer. An exhaustive grep of non-test daemon and keystore sources for `writeFileSync|writeFile|appendFile|createWriteStream` finds three sites (`events/event-outbox-kek.ts:84`, `identity/key-store.ts:94`, `events/event-outbox-store.ts:22` — a `chmodSync`), none on this path, and `frozenDeviceKeyView.save` throws so `MountedSecretKeyStore.save` is never reached.

**Three redaction rules, because the key-name redactor demonstrably cannot cover this path:**

- **R-a.** `redactBindings` returns `Error` instances **untouched** (`logging/logger.ts`, `if (value instanceof Error) return value`), and `pino.stdSerializers.err` copies every enumerable own and inherited property with no key filtering. The only enrolment failure log is `logger.error({ err }, …)`. **Therefore: every error thrown by `ticket.ts`, `enrollment-input.ts`, `desktop-hello.ts` and `enroll-once.ts` names the failing constraint and never interpolates the input, never sets it as an own property, and never attaches it via `cause`.** This deliberately breaks with the house idiom in `config/env.ts` (`${name}=${JSON.stringify(env[name])}`), which is safe there only because every variable it handles is a non-secret enum or integer.
- **R-b.** The credential field is named `enrollmentCode` throughout (`enrollmentcode` is a `SENSITIVE_SUBSTRINGS` needle; the daemon's own `EnrollInput.code` name is **not**, and neither is `ticket`). It is mapped to `code` only in the inline object literal at the S4j call site, which is never logged.
- **R-c.** The key field is named `privateKeyPkcs8Der` / `privateKeyPkcs8B64` (both normalize to contain `privatekey`), never `der`, `bytes`, or `k`. `redactBindings` recurses into typed arrays index-by-index, so `{der: <Uint8Array>}` would log the complete key byte by byte; only the field *name* prevents it.

**Proof.** `T-I13` (`enroll-once.canaries.test.ts`): **three** canaries — `AOA-CANARY-SESSION-TOKEN` as the session header, `AOA-CANARY-ENROLLMENT-CODE` as the code, and a marked PKCS8 byte pattern as the key. Assert each appears **zero** times across: `JSON.stringify(outcome)`; `Object.keys(outcome)` against a frozen allowlist; every record on an injected real `createWorkerLogger` destination; a `console.error` spy (the `invokedDirectly` guard bypasses the logger entirely); the argv and stdin of every `runner.run` call; the bytes handed to `receiptStore.saveIfAbsent`; and `Object.keys(bootstrapResult)`. Run across all five failure branches — store fault, malformed ticket, missing source, 401, 503 — because R-a's exposure is the error path, and today's `logger-redaction.test.ts:82-89` deliberately asserts that error messages are emitted verbatim.

### Test matrix

| # | File | Invariant | Required ubuntu lane |
|---|---|---|---|
| T-I3 / a,b,c | `enroll-once.fail-closed.test.ts`; keystore `command-runner.test.ts` | I3 | ✅ |
| T-I6a/b | keystore `store-atomicity.test.ts`; `command-plan.test.ts` | I6, I9 | ✅ |
| T-I7a–e | `enroll-once.{mint-once,no-clear,replay-recovery,steady-state}.test.ts` | I7, I4 | ✅ |
| T-I8 | `ticket.test.ts` | I8 | ✅ |
| T-I11 | `entrypoint-enrollment.test.ts` | I11 | ✅ |
| T-I12 | `desktop-hello.test.ts` | I12 | ✅ |
| T-I13 | `enroll-once.canaries.test.ts` | I13 | ✅ |
| T-X1 | `enroll-once.ordering.test.ts` — call-order `load → load → (read) → saveIfAbsent → enroll → saveIfAbsent`; a throwing `saveIfAbsent` yields 0 `client.enroll` | persist-before-network | ✅ |
| T-X2 | `enrollment-input.test.ts` — path/env arms, trailing-newline trim, **UNC and mapped-drive rejection**, errors echo no file contents | §5/A5 | ✅ |
| T-X3 | `idempotency.test.ts` — UUID-shaped, lowercase, stable, distinct per input | G4 | ✅ |
| T-X4 | `custody.test.ts` — the four-row `resolveCustody` truth table | I11 | ✅ |
| T-X5 | keystore `port-compat.test.ts` — `createOsRecordStore(...)` is assignable to the daemon's `DeviceRecordStore` | C1 | ✅ |
| T-X6 | `dependency-boundary.test.ts` (extend) — no daemon source names `@armyofagents/worker-keystore`; dep union still `["@armyofagents/worker-protocol","pino"]` | I23 | ✅ (`verify` + `policy`) |
| T-X7 | `check-worker-keystore-boundary.test.mjs` (extend) — `existsSync` banned in `command-runner.ts`; the new bin importing `node:child_process` is rejected | I23, §5/A2 | ✅ (`policy`) |
| T-W1..3 | `scripts/probe-os-vault.mjs` on Windows | I10, I9 | ❌ — see §6 |
| T-M1 | Live enrol against a flag-on server | ticket outcome | ❌ — manual, EVID-04 |

**Test-authoring trap, to encode in review.** `classifyRuntimeSourceFileName` (`scripts/lib/worker-protocol-boundary.mjs:94-99`) classifies any `.ts` not ending in `.test.ts` as *runtime source*. A shared fake runner at `packages/worker-keystore/src/__tests__/support/fake-runner.ts` would be scanned as runtime, subjected to `ALLOWED_BARE` (so it could not import `vitest`), and covered by the `command-runner.ts` basename confinement. Keep helpers inline or inside `*.test.ts`.

---

## 4. The `packages/worker-daemon` diff, line by line

The pin at `worker-daemon-boundary.mjs:153-159` is on the **dependency union**, not on file count. New modules that import only `node:*`, `@armyofagents/worker-protocol` and in-package paths are free. The expensive surface is `bin/worker-daemon.ts` and `index.ts`, and `package.json` is untouched.

**D1 — imports, after `bin/worker-daemon.ts:31. 3 lines.**
```ts
import { resolveCustody, type DeviceIdentityStore, type DeviceReceiptStore } from "../identity/device-identity-store.js";
import { createControlPlaneClient } from "../transport/client.js";
import { enrollOnce, readEnrollmentInput } from "../enrollment/enroll-once.js";
```
*Unavoidable.* F6: this file is the shipped entrypoint (`docker/worker/Dockerfile:112`, asserted at `docker/images/__tests__/dockerfile-static.test.mjs:212`) and sits inside the scanned tree, so it can never name `@armyofagents/worker-keystore`; every symbol must be in-package. `createControlPlaneClient` gains its **first production caller** here (today: only the barrel re-export and six test files).

**D2 — `BootstrapDeps`, after `:86`. 4 fields.**
```ts
readonly identityStore?: DeviceIdentityStore;
readonly receiptStore?: DeviceReceiptStore;
readonly createClient?: typeof createControlPlaneClient;
readonly readEnrollmentInputFn?: typeof readEnrollmentInput;
```
*Unavoidable.* Injection is the only legal path for an OS binding. The latter two follow the `createLogger?` / `createMetricsFn?` / `startHealth?` precedent at `:42-44` and are what let T-I11, T-I13 and the 401/503 cases run with no network and no filesystem. **Docblock must state the fail-closed polarity break** (§3/I11).

**D3 — the I11 gate, between `:114` and `:116`. ~9 lines.**
```ts
const custody = resolveCustody(config.keyStoreMode, deps.identityStore, deps.receiptStore);
if (!custody.ok) {
  logger.error({ keyStoreMode: config.keyStoreMode, reason: custody.reason },
    "worker-daemon key-store custody unsatisfiable; refusing to start");
  deps.proc.exit(1);
  return { ok: false, logger };
}
```

| `keyStoreMode` | stores injected | verdict |
|---|---|---|
| `os_keychain` | both | `{ok:true, mode:"enrolling"}` |
| `os_keychain` | either missing | `os_keychain_requires_identity_store` → exit 1, **pre-socket** (I11) |
| `mounted_secret` | none | `{ok:true, mode:"inert"}` — **byte-identical to today** |
| `mounted_secret` | any | `mounted_secret_rejects_identity_store` → exit 1, pre-socket |

*Unavoidable, and at this line specifically* — C5. Splitting the *configuration verdict* (pre-socket) from the *network attempt* (post-socket) is the only shape that satisfies both I11's literal wording and D14's argument that the compose healthcheck must answer during enrolment.

**D4 — the enrolment block, after `:136`. ~26 lines.**
```ts
if (custody.mode === "enrolling") {
  let outcome;
  try {
    const readInput = deps.readEnrollmentInputFn ?? readEnrollmentInput;
    const makeClient = deps.createClient ?? createControlPlaneClient;
    outcome = await enrollOnce({
      identityStore: custody.identityStore,
      receiptStore: custody.receiptStore,
      client: makeClient({ baseUrl: config.controlPlaneBaseUrl }),
      readInput: () => readInput(config.enrollmentCodeSource, deps.env),
    });
  } catch (err) {                                   // custody or ticket fault — ALWAYS fatal
    logger.error({ err }, "worker-daemon device custody unusable; refusing to start");
    await health.close().catch(() => {});
    deps.proc.exit(1);
    return { ok: false, logger, config };
  }
  if (outcome.skipped)      logger.info({ workerId: outcome.workerId, targetId: outcome.targetId }, "worker-daemon already enrolled; skipping control-plane enrollment");
  else if (outcome.enrolled) logger.info({ workerId: outcome.workerId, targetId: outcome.targetId, deviceGeneration: outcome.deviceGeneration, deviceThumbprint: outcome.deviceThumbprint }, "worker-daemon enrolled");
  else if (outcome.minted)  { logger.error({ failure: outcome.failure, workerId: outcome.workerId }, "worker-daemon enrollment failed"); await health.close().catch(() => {}); deps.proc.exit(1); return { ok: false, logger, config }; }
  else                       logger.error({ failure: outcome.failure, workerId: outcome.workerId }, "worker-daemon could not obtain authority; running idle with the existing device identity");
}
```
*Unavoidable.* `createEnroller` (`enroll.ts:139`) has zero production callers; this is the only seam that can give it one. `readInput` is passed as a **thunk** so `enrollOnce` controls *when* the credential is materialized (S4a/S4b before S4d) — the repair for §5/A5.

The fatal/non-fatal split is deliberate. `minted === true` + failure ⇒ exit 1: a fresh device that could not enrol is useless, the failure is actionable, and the loop is bounded because the next boot loads the record. `minted === false` + failure ⇒ **log and run idle**: the identity is intact, there is no poll loop to feed, R1 already documents "enrolled and authority-less" as the steady state, and exiting would convert a documented steady state into a restart loop that pressures the operator toward the second mint (§5/A4). `.catch(() => {})` on `health.close()` matters because a rejected close would otherwise escape bootstrap into the entry guard's `console.error(err.stack)`, bypassing the redactor (§3/I13, R-a).

**D5 — `BootstrapResult` (`:89-96`): no change.** That is half of I13, held by omission.

**D6 — `index.ts`:** re-export `resolveCustody`, `frozenDeviceKeyView`, `enrollOnce`, `readEnrollmentInput`, `buildDesktopHello`, `UNPROVISIONED_POLICY_HASH`, `encodeEnrollmentTicket`, `parseEnrollmentTicket`, `deriveEnrollmentIdempotencyKey`, and the types `DeviceIdentityStore`, `DeviceReceiptStore`, `DeviceIdentityRecord`, `DeviceEnrollmentReceipt`, `CustodyVerdict`, `EnrollmentOutcome`. The type exports are what let T-X5 assert assignability from the keystore side.

**D7 — recommended, 1 line, `logging/logger.ts` `redactBindings`:** `if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[bytes]";` at the top. It closes R-c structurally rather than by naming discipline. Not load-bearing — the plan does not depend on it — but it is the cheapest hardening in the ticket.

### What the diff deliberately does not do

- **`enroll.ts`: zero lines.** Custody is resolved by the coordinator; the enroller receives `frozenDeviceKeyView`. The derived idempotency key travels through the **existing** `renew(input)` signature. This is strictly better than D8, whose body contradicts its header.
- **`config/config.ts`: zero lines.** No `{kind:"stdin"}` arm (D15). Adding one edits an already-required, already-tested exactly-one-of validator (`:103-121`, asserted at `__tests__/config.test.ts:34,68`), and the stdin ordering is a live hazard: `parseEnrollmentCodeSource` *throws* when neither var is set, so a stdin host must read the secret **before** `loadWorkerConfig` can run — i.e. before the I11 gate. Deferred to DSK-003, which has an interactive host to justify it.
- **No new environment variable.** Not `AOA_WORKER_KEY_STORE_PATH`, not `AOA_WORKER_TARGET_ID`. The ticket always carries `targetId`, and the blob path is fixed. Note also that `AOA_WORKER_TARGET_PROFILE_ID` is already occupied in the namespace with a different meaning (`docker-compose.d1.yml:297-304`, read by nothing), so a target-id variable would need a deliberate name.
- **No `mounted_secret` enrolment.** `MountedSecretKeyStore` persists PKCS8 DER only (`identity/key-store.ts:89-101`) with no `workerId` slot, so wiring enrolment to it would ship exactly the torn-identity hazard I6 exists to prevent. It also has zero production constructors today, so D14's "constructs the existing store" describes work that does not exist. Row 3 of the D3 truth table guarantees **zero shipped-container behaviour change**; `docker-compose.d1.yml` and `docker-compose.staging.yml` are untouched.
- **`package.json`, `vitest.config.ts`, `Dockerfile`, `pr.yml`: zero lines** (C10).

---

## 5. Attacks that succeeded, and the repair

| # | Attack | Where it landed | Repair in this plan |
|---|---|---|---|
| **A1** | **`saveIfAbsent → "stored"` is not a durability barrier.** No `Flush`/`WriteThrough` anywhere; exit 0 means page cache. Power loss after the server commits → the blob is absent (silent double-mint → permanent `worker_transfer_denied`) or zero-length (permanent brick). | mint-once-first, fail-closed-first | §1D `command-plan.ts` (c): `$fs.Flush($true)` before `Dispose`, so exit 0 means FlushFileBuffers has returned. The remaining window (`CreateNew` → `Flush`) strictly precedes any network call, so both of its outcomes are safe (G2(i) clean re-mint; G2(ii) fail-closed brick with a provably-safe guarded reset). Byte-locked by T-I6b. |
| **A1′** | **The proposed temp+`Move` "fix" is worse than the bug.** `Move` places the publish step after the last flushable point, and .NET offers no directory-fsync — converting a fail-closed brick into a silent, permanent, fail-open double-mint. It also demotes the CAS to `File.Move` + `File.Exists`, a *second* exception-swallowing boolean. | mint-once-first §2, fail-closed-first §1.9 | **Rejected explicitly.** Keep the exclusive `CreateNew` on the final path. T-I6b asserts the script does **not** contain `Move`, so the tempting regression fails CI. |
| **A2** | **The absence oracle is `existsSync`**, which collapses EPERM/EACCES/EBUSY/ENOTDIR/UNKNOWN into `false`. Measured live: a present-but-denied blob yields `load() → null` → mint. `clear()` inherits the same oracle (`plan.stdin === "none"` matches `delete`) and reports a failed wipe as success, contradicting its own contract. `command-runner.ts` has **zero tests**, and the injectable seam's boolean type cannot express a fault. | **all three designs** | §1D `command-runner.ts`: a three-valued errno-discriminating probe, `ENOENT` only for absence, everything else routed to `unavailable`/`denied` so `load()` and `clear()` both throw. The seam's *type* changes so fakes can express faults. New `command-runner.test.ts` (T-I3b). `existsSync` banned in the boundary checker (T-X7). The two false comments (`command-runner.ts:22-28` and the design's I3 argument) are corrected to say what the code does. |
| **A3** | **`--reset-identity` is advertised as the recovery and is itself the permanent lockout.** On the same target it lands in `worker_transfer_denied` (`:418-423`); the doc frames the hazard only as presenting one `workerId` to a *second* target. | mint-once-first §3 | §3/I7 point 4: `clear()` is guarded, states the permanence, names the `workerId`/`targetId` being destroyed, and only relaxes in the one provably-safe state (zero-length identity slot, no receipt slot). The failure diagnosis for a pre-existing identity explicitly says **do not** reset. |
| **A4** | **Per-boot enrolment is the steady-state double-mint generator.** `enrollOnce` runs unconditionally on every boot → boot 2 past the 10-minute code TTL → 401 → cannot start → operator issues a fresh code → the rebind branch demands `deviceGeneration + 1` with no client oracle → 401 → the documented remedy is "create a new target" → with a `targetId`-keyed blob path that silently mints a second identity. Repeats forever. | minimal-diff | Four coupled changes: (i) **S4c short-circuit** — with both slots present, no ticket read and no network, ever again; (ii) the **receipt slot** so "did the server accept" is durable, giving G4/G5 replay recovery without per-boot enrolment; (iii) a **single fixed blob path**, not `targetId`-keyed; (iv) `targetId` in the record (C2) so a ticket for another target is an **explicit refusal** (T-I7e), never a silent second mint. The failure branch for a pre-existing identity is non-fatal, so the operator is never *forced* toward a new target. |
| **A5** | **Network I/O before the store verdict.** A `{kind:"path"}` enrollment-code source is validated only for non-emptiness, so a UNC path performs an authenticated SMB round-trip *before* the store is ever probed — on a host that was never going to enrol. Structurally forced when the blob path is keyed on `ticket.targetId`. | minimal-diff | The fixed blob path removes the dependency, so **S4a/S4b precede S4d**: the store verdict is reached before the credential source is touched. `enrollment-input.ts` additionally rejects UNC, `\\?\UNC\`, non-absolute and network-mapped-drive paths before reading. T-I11's `readFileText` spy asserts 0 calls; T-X2 covers the rejection table. The stdin arm is deferred, so its "secret before `loadWorkerConfig`" inversion never arises. |
| **A6** | **`identity-store.ts:123` maps `corrupt && exitCode === 0` → `"stored"`**, inferring a successful persist from the exact fail-open shape the package documents. | secondary finding, fault-becomes-absence | §1D: the store script emits a fixed success sentinel after `Dispose`, and `"stored"` requires `outcome.kind === "present"` with that sentinel. |
| **A7** | **`catch [IO.IOException] { exit 4 }` reports disk-full, network-path-not-found and sharing violations as `already_present`**, i.e. "another enroller won" when nothing was stored. `DirectoryNotFoundException` (an `IOException`) hits it too. | secondary finding | §1D: `CreateDirectory` before `Open`; the catch narrows to HResult `0x80070050`, everything else falls through to `exit 3`. |
| **A8** | **The redactors disagree, and the gap lands on this ticket's secrets.** `code`/`ticket`/`env`/`k` are in neither `SENSITIVE_SUBSTRINGS` nor `FORBIDDEN_WIRE_KEYS`; `redactBindings` passes `Error` instances through untouched while `pino.stdSerializers.err` copies every enumerable property; typed arrays are expanded index-by-index; the `envelope.ts:31-35` comment cites the wrong list. | residuals on all three | §3/I13 rules R-a/R-b/R-c: value-free errors, `enrollmentCode` naming, `privateKeyPkcs8*` naming, the `envelope.ts` rename and comment correction, the recommended one-line typed-array guard (D7), and the **three-canary** T-I13 run across all five failure branches — the only test that can catch a slip on the error path. |
| **A9** | **503 is `terminal=false, stopAndBackoff=false`** (`enroll.ts:259-260`), i.e. retry forever — and a plainly-created desktop target 503s on every enrol because nothing writes `capabilities.providerConstraints` (C8). Unattended infinite retry with no diagnosis. | server-enrollment-wire | `enrollOnce` performs **one attempt and never retries**. On `httpStatus === 503` the failure names `execution_targets.capabilities.providerConstraints`; on `404` it names "distributed execution disabled" (`server/src/app.ts:438-461`, where `mapErrorStatus`'s default arm would otherwise emit an opaque `"unexpected"`). The operator prerequisite is stated in §7/OQ-3. No diff to `mapErrorStatus`. |

---

## 6. What the ubuntu-only required lane cannot prove

Everything that **decides identity** is on the required lane, because the mint, the persist ordering, the idempotency derivation, the hello builder, the ticket codec, the failure classifier, the command planner, the probe table and the envelope codec are all pure or fully injected. `packages/worker-daemon` and `packages/worker-keystore` are both in `vitest.config.ts:24`; the boundary checkers run in the always-on `policy` job (`pr.yml:164-165`); both feed the single required `ci-required` aggregator.

The following are **not** proven by CI. They are listed here so they are not discovered as surprises during EVID-04.

1. **That `FileStream.Flush($true)` actually reaches stable storage.** This is documented .NET/Win32 behaviour (`FlushFileBuffers`), not a measured property, and no CI lane in this repo can measure it. A1's repair rests on it. Windows probe leg T-W1; record the transcript in the PR.
2. **That `[IO.File]::Open(path,'CreateNew')` is a true cross-process CAS on NTFS, and that the file-exists HResult is `0x80070050`.** T-W1. The `exit 4` narrowing in §1D depends on the constant.
3. **Real DPAPI semantics.** That wrong-entropy, tampered-blob, missing-blob and locked-profile are four distinguishable outcomes under real PowerShell 5.1, and that the exit-3/exit-4 mapping survives `-EncodedCommand`. This is I10, and it is the reason `classifyStoreOutcome` takes absence only from an explicit flag: the same `CryptographicException` was measured as exit 0 under `-File` and exit 1 under `-EncodedCommand` with identical empty stdout. T-W2.
4. **The actual errno Windows produces for a denied, locked or unreachable blob.** The probe *table* is fully testable by injection (T-I3b), but which of `EPERM`/`EACCES`/`EBUSY`/`UNKNOWN` a given ACL or lock produces is not. This matters only for the diagnostic string, never for the verdict — every non-`ENOENT` code takes the same fail-closed branch.
5. **That a stripped `env:` still lets `powershell.exe` start and DPAPI unprotect.** §1D passes an explicit allowlist to `execFileSync`; if the Windows probe shows it breaks, widen the allowlist there and record why. T-W3.
6. **`%LOCALAPPDATA%` semantics** — folder redirection, roaming profiles, and elevated-vs-standard token differences. `blob-path.ts` refuses `APPDATA` and non-absolute values, but the machine-level behaviour is untested.
7. **End-to-end enrolment against a live, flag-on control plane** — including the 10-minute code TTL, the replay branch, and the `providerConstraints` prerequisite (C8). CI proves these only against a fake plane that models the branch conditions from `worker-enrollment.ts:324-382`. Manual, EVID-04, `docs/replatform/epics/E10-desktop/qa/`.
8. **Windows CI generally.** The Windows `verify` lane is advisory with four tests skipped (Issues #113/#127) and Windows `e2e` is skipped at the Playwright config level because embedded-postgres cannot start on the `runneradmin` runner (Issue #114). Promoting T-W1..3 to a PR-time gate is a CI-topology change (OQ-4), not the ticket author's to assume.

None of the eight can silently produce a second identity, because all of them sit behind the six-valued classifier whose only route to `null` is — after C4 — a genuine `ENOENT`.

---

## 7. Open questions and follow-ups

- **OQ-1 (server, blocking for R5).** `findWorkerForBinding` (`packages/db/src/repositories/tenant/worker-enrollment.ts:274-287`) has no `status`/`revokedAt` predicate and there is no `delete(workers)` and no binding-reset route, so a device that loses its store — snapshot revert, reimage, profile deletion — is permanently locked out of its target. No client-side design can fix this; no local state is as durable as a committed server row. File a follow-up for a status predicate or a target-scoped binding-reset route.
- **OQ-2 (protocol).** `deviceGeneration` has no client source (C7). Lane A hardcodes `1`, persists it, and refuses to guess. A legitimate rebind needs `target.deviceGeneration + 1` — note that a *first* enrol does **not** advance the generation (`advanceTargetGeneration` has one call site, `worker-enrollment.ts:429`, inside the bound-worker branch), so the first rebind must send `2`. Proposal: `POST …/enrollment-codes` returns `{code, expiresAt, targetId, deviceGeneration}` and a ticket `v:2` carries them; an explicit `--reenroll` subcommand consumes it. Until then, the 401 diagnosis must name generation mismatch as one of its causes, because on the wire it is indistinguishable from a mistyped code (both are the generic `"Worker control request denied"` with `redaction: "secret"` and `detail: {}`, `worker-protocol-http.ts:39-48`).
- **OQ-3 (operator).** A desktop target created through the normal route 503s on every enrol until its row carries `capabilities.providerConstraints: {profileId, version, digest}` (C8). Either document the create-time step in the ticket result, or file the server fix (`providerConstraints` nullable, or a typed error instead of an escaping ZodError). The transaction rolls back cleanly, so it is retryable once corrected.
- **OQ-4 (CI).** Whether T-W1..3 become a Tier 2 gated Windows lane or stay Tier 3 manual. Lane A **does not depend on the answer** — nothing in the required matrix is Windows-only — so DSK-001a can land while OQ-4 is open.
- **OQ-5 (scope reduction).** C9: D11(a)/I15(a) are assertions, not builds. Lane B shrinks accordingly.
- **Deferred deliberately:** `{kind:"stdin"}` ticket delivery (DSK-003), a record-shaped POSIX file store to give `mounted_secret` a real enrolment path, and the `--reenroll` subcommand (gated on OQ-2).