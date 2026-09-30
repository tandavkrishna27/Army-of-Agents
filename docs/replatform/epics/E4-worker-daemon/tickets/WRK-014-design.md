# WRK-014 — Container device identity: an enrol-enablement path for a `mounted_secret` container

**Epic:** E4 · **Plan node:** `docs/replatform/program-design.md`, `#### WRK-014`
**Depends on:** WRK-002 · **Size:** M · **Status:** design **v2** (2026-08-28, post 3-agent adversarial review — §10)
**Terrain of record:** [`WAVE-4-RESEQUENCE.md`](../../../WAVE-4-RESEQUENCE.md) §3.1 · [`SPIKE-worker-walking-skeleton.md`](../../../SPIKE-worker-walking-skeleton.md) F1
**Reconciliation:** [`qa/2026-08-28-worker-dispatch-chain-reconciled.md`](../../../qa/2026-08-28-worker-dispatch-chain-reconciled.md) (link 3.1)

---

## Why this ticket exists (scope: ENROL-enablement, not dispatch)

The chain's first BUILD link (WAVE-4-RESEQUENCE §5 step 2). A shipped **container** worker holds **no device
identity and no key**, so it can **never enrol**: `MountedSecretKeyStore` has zero production constructors
(no runtime key-load path); the only production `DeviceRecordStore` (`createOsRecordStore`) lives in
`worker-keystore`, which the image never copies; and `bin/worker-daemon.ts`'s enrolment block is gated
`keyStoreMode === "os_keychain" && identityStore && receiptStore`, which a `mounted_secret` container never
enters.

**★ Scope boundary (review F3, verified):** WRK-014 makes a container **enrol and persist an identity** — it
does **not** reach the dispatch loop. After enrolment, composition is gated three more times, all on things
WRK-014 does not provide: `shouldComposeSession({provider,dispatchEnabled})`,
`decideDispatchComposition({provider,dispatchEnabled,eventOutboxPath})`, and the provider itself
(DEP-011/DEP-012, unbuilt; the in-process E2B provider is forbidden on a worker by
`checkProviderControlBoundary`). So after WRK-014, "dispatch ON" is reachable **for enrol**, still not for
execution. Dispatch additionally needs DEP-012/DEP-011 + `AOA_WORKER_DISPATCH_ENABLED=1` +
`AOA_WORKER_EVENT_OUTBOX_PATH`. WRK-014 unblocks links 3.3/3.4/3.5/3.6 (already built) to run for real.

## 0. The two design-defining pivots (verified against source, survived review)

**Pivot 1 — build a `DeviceRecordStore`, NOT a `MountedSecretKeyStore`.** `enrollOnce` consumes
`identityStore: DeviceRecordStore<DeviceIdentityRecord>` + `receiptStore` (`enroll-once.ts:120-121`); the
device key is `generateKey()`'d and persisted **inline** in the `DeviceIdentityRecord` before the network
call (`:232-263`). No separate mounted device-key file — the only mounted secret is the one-shot enrolment
**code**. (`MountedSecretKeyStore` is the *other* port `DeviceKeyStore` — keyless — and becomes definitively
dead code after this ticket; deletion is out of scope, tracked in §9.)

**Pivot 2 — the container custody code lives in `worker-daemon`.** A filesystem-backed `DeviceRecordStore`
needs only `node:fs`/`node:crypto`, which `worker-daemon-boundary.mjs` allows; the file is picked up by the
existing `COPY packages/worker-daemon/` and ships in the image (no image-deps risk — `check-image-deps-stages`
validates deps-stage manifests, not source). It must NOT reuse `createOsRecordStore` (lives in the
un-copied `worker-keystore`, and needs an OS keychain). *(Rationale corrected per review: desktop's store is
out of the daemon because it lives in `worker-keystore` outside the daemon's 2-dep pin — not because
`child_process` is forbidden.)*

## 1. What it builds — INERT (review F1: does NOT activate the container path)

**★ WRK-014 lands the code but does NOT flip the entrypoint.** If it repointed the Dockerfile CMD now, every
deployed `mounted_secret` container would enter enrolment and hit `readEnrollmentInput` on its POSIX
code-path, which `assertLocalAbsolutePath` rejects (Windows-only **at WRK-014 time; WRK-015 shipped the POSIX
arm**) → `exit(1)` → crash-loop. So WRK-014 ships provably-correct-but-inert; **WRK-015 shipped the POSIX fix,
and WRK-017 activates the container path** (a compose `command:` override — NOT a CMD repoint, per WRK-015
Correction 1). WRK-014's
tests use the env-arm code + the new mode directly.

1. **`FileRecordStore<T>`** (`worker-daemon/src/identity/file-record-store.ts`) — a `DeviceRecordStore<T>`
   over `node:fs`: `load()` (ENOENT → `null`; corrupt/insecure-perms → **fail-closed throw with a
   content-free, path-free message** — review F3, I13-adjacent: the file holds `privateKeyPkcs8Der`),
   `saveIfAbsent()` = **crash-atomic exclusive-create** (review MED: NOT bare `wx` — write a unique temp file
   → `fsync` → atomic `link()` (EEXIST preserves the CAS → `"already_present"`) → unlink temp, so the final
   path only ever appears fully-formed), `clear()`. **A `Uint8Array`-safe codec** (review F4: base64/hex, the
   daemon's own — `worker-keystore`'s codec is import-forbidden; a naive JSON round-trip corrupts the key →
   crash-loop on every post-enrol boot).
2. **A new custody MODE** `file_record` in `KEY_STORE_MODES` (`config.ts:21`, today `["mounted_secret","os_keychain"]`)
   — see §3. *(Review F4: do NOT add `config.stateDir`; the container host reads `AOA_WORKER_STATE_DIR` from
   env directly — `bootstrapWorkerDaemon` runs `loadWorkerConfig` AFTER the host has already built the
   stores, so a config field has no consumer under seam (a).)*
3. **A container host** `worker-daemon/src/bin/container-host.ts` (§2) — `runContainerHost({env,proc})` reads
   `AOA_WORKER_STATE_DIR` (default `/worker`), constructs the two `FileRecordStore`s + a **writable-state-dir
   assert** (fail-closed diagnostic), injects them into `bootstrapWorkerDaemon`, plus a thin `invokedDirectly`
   guard mirroring `aoa-worker-desktop.ts` **including the enrolment-code redaction last-line-of-defence**.
   **CMD stays `worker-daemon.js`** (repoint is WRK-015).
4. **The enrolment-gate `file_record` arm** (`bin/worker-daemon.ts` ~:304): `(os_keychain || file_record) &&
   identityStore && receiptStore`. Rewrite the now-invalidated `:285-292` honest-note (review F7: the mode
   arm becomes the real enrol discriminator).

## 2. The seam decision — (a) a container host inside `worker-daemon`

Chosen: **(a)** — the analogue of `runDesktopHost` (a host constructs custody + injects it; the daemon is a
pure sink), living in-package because the file store carries no confined capability (Pivot 2). Rejected (b) a
`mounted_secret` branch inside `bootstrapWorkerDaemon` (dissolves the sink/host separation). The container
host is testable (`runContainerHost`) with a thin `invokedDirectly` entry, exactly like the desktop pair.

## 3. The custody mode — a distinct `file_record` mode (review BLOCKER + F2)

**v1's "amend `mounted_secret` to admit a `DeviceRecordStore` but refuse a `DeviceKeyStore`" was INFEASIBLE**
(verified): `resolveCustody(mode, identityStore?, receiptStore?)` types both params as `DeviceRecordStore`
(`device-identity-store.ts:104-105`) — a `DeviceKeyStore` cannot reach it; the arm refuses on **presence**,
not type. So instead **add a distinct mode**:

- `resolveCustody` gains a `file_record` arm: **both** stores present → `ok`; **exactly one** → `refuse` (the
  torn-config hazard); **none** → `refuse` (a `file_record` container with no stores is a misconfiguration —
  unlike bare `mounted_secret`, which stays inert-ok).
- **Bare `mounted_secret` is UNCHANGED** — it keeps refusing any present store, so the three mutation-hardened
  `custody-bootstrap.test.ts` cases stay GREEN (nothing deleted). The TDD **ADDS** `file_record` cases; it
  does not flip the `mounted_secret` guards (review HIGH: the store-less `mounted_secret` "does NOT enrol"
  assertion also stays true — WRK-014 adds a `file_record`-with-stores sibling).
- Verdict stays **pre-socket + fail-closed for unknown modes** (I11 intact — review confirms no socket opens
  before the verdict).

## 4. Durability — a SINGLETON canary worker now; the replicated-fleet identity-granularity is DEFERRED (review F1)

A recreated container that lost its `DeviceIdentityRecord` re-mints a `workerId` and cannot re-bind the same
target (`worker_transfer_denied`); the container has **no `--reset-identity`** (unlike desktop), so a bad
identity crash-loops rather than silently re-minting — the failure is loud, not a silent takeover.

**★ The replicated staging fleet breaks "one named volume per worker" (review F1, verified):**
`docker-compose.staging.yml` workers declare `deploy.replicas: 2` + autoscale 2–8 and share one enrolment
code — so N replicas of one service cannot each own a distinct durable identity via a named volume. That is a
real **identity-granularity decision** (per-container vs per-replica vs per-target under autoscaling +
deny-transfer), and it is **out of scope for WRK-014**.

- **WRK-014 targets a SINGLETON canary worker** — which is exactly what the E7-1 campaign needs (it enrols
  **one** worker). Mandate a **named, persistent volume for that singleton** (like d1's `d1-worker-*-state`),
  a **boot-time writable-state-dir assert** (fail-closed, EACCES/perms → `exit(1)`, a loud diagnostic — not a
  silent re-mint), and a **`docs/deploy` operator note** that the state dir MUST be a durable named volume and
  that a container identity, once revoked, is retired (there is no reset).
- **DEFER to a named successor (WRK-016):** identity granularity for the replicated/autoscaled fleet + the
  deliberate-retirement/replacement runbook (orphaned `workers` rows on scale-down). File the stub so the
  graph sees it. Do NOT author a replicated-fleet manifest checker in WRK-014 — its shape isn't decided.

## 5. The WRK-015 (POSIX input) relationship — WRK-015 ACTIVATES

The POSIX file-arm is **universal** (every d1 + staging worker uses `AOA_WORKER_ENROLLMENT_CODE_FILE` with a
POSIX path that `assertLocalAbsolutePath` rejects), so WRK-015 is a hard co-requisite for a live container.
**WRK-014 tests use the env arm** (`AOA_WORKER_ENROLLMENT_CODE_ENV`, works today) to isolate identity custody
from the input-path bug. **WRK-015 lands the POSIX fix AND the activation** (repoint the Dockerfile CMD →
`container-host.js` + its build-stage `test -f` guard; switch the singleton canary worker's compose
`AOA_WORKER_KEY_STORE_MODE: mounted_secret → file_record`). Ship 014→015 back-to-back (or 014+015 atomically).
Do NOT switch compose to the env arm as an interim (secret-in-env + hides the dependency).

## 6. TDD plan (fail-first; RED → GREEN → commit)

Pure unit + component tests (file I/O against a tmp dir; no embedded-PG), mirroring
`custody-bootstrap.test.ts`/`enrollment-bootstrap.test.ts`.

1. **`FileRecordStore` round-trip + fail-closed + crash-atomic.** RED: absent → `null`; `saveIfAbsent` then
   `load()` byte-equal **with a real Ed25519 key fixture** (review F4 — proves the codec); second
   `saveIfAbsent` → `"already_present"` (no overwrite); corrupt/`0644` → throws a **content-free, path-free**
   `DeviceKeyStoreError`-class (review F3 — assert the key bytes + path appear in NO thrown message, parity
   with `enrollment-bootstrap.test.ts` I13). A simulated crash (temp exists, final absent) → next `load()`
   returns `null`, not a partial (review MED — the temp+link write).
2. **`resolveCustody` `file_record` arm.** RED: `file_record` + both stores → `ok`; + one → `refuse`; + none →
   `refuse`; `os_keychain` + both → `ok`; `mounted_secret` + any store → `refuse` (UNCHANGED — the three
   pinned cases stay green); unknown → `refuse`. Mutation: revert the `file_record` admit → the with-stores
   enrol test reddens (NOT a DeviceKeyStore-refusal — that arm doesn't exist).
3. **Container host + gate arm — component test.** RED: `keyStoreMode="file_record"` + the two
   `FileRecordStore`s + the **env-arm** code + a fake `ControlPlaneClient` → `bootstrapWorkerDaemon` **calls
   `enrollOnce`**, persists identity+receipt to the tmp dir; re-boot **short-circuits** (no second network
   enrol). Assert I13 (code + minted session never logged / never in the outcome). Add the `file_record`
   sibling to the `enrollment-bootstrap` suite; keep the store-less `mounted_secret` negative.
4. **Durability guard (singleton).** RED: a boot-time writable-state-dir assert fails closed on a
   non-writable state dir. (The replicated-fleet manifest checker is deferred — §4.)
5. Mutation-test every guard (DELETE, don't rewrite) + a POSITIVE CONTROL first. **Do NOT** build against
   WRK-015; the container test uses the env arm.

**Registers/CI:** new `*.ts` + `*.test.ts` trip neither guard-inventory nor the census. Confirm
`check-worker-daemon-boundary` + `check-image-deps-stages` stay green. Document `AOA_WORKER_STATE_DIR` in
`docs/deploy/environment-variables.md` (`checkEnvDocumented` fails on an undocumented staging-set key).
`packages/worker-protocol` is FROZEN.

## 7. Security

Device key generated locally (`generateDeviceKey`, Ed25519), never leaves the host — persisted inline in
`identity.json` at `0600` on the worker's own volume (`0600` enforceable via the live POSIX
`ownerOnlyViolation` check on the non-root-`node`/read-only-root/writable-`/worker` container). The enrolment
code is single-use, named `enrollmentCode` (logger redaction), redacted again by the container host's
`invokedDirectly` last-line-of-defence. **Precision (review F6):** the custody *verdict* is pre-socket (I11);
the content fail-closed load is inside `enrollOnce`, POST-health-server (D14, same as `os_keychain`) — the
verdict, not the load, is the pre-socket guarantee.

## 8. Open questions for the implementer (narrowed)

1. Confirm the crash-atomic write (`temp → fsync → link`) preserves the `saveIfAbsent` CAS semantics on the
   container FS, and that the `enrollOnce` lost-race path (`load()` after `!=="stored"`) reads only a
   fully-formed winner file.
2. Confirm the writable-state-dir assert's placement (container host, pre-`bootstrapWorkerDaemon`) fails
   closed before any socket.
3. The `file_record` mode name — is it the clearest, or `mounted_secret_record`? (`file_record` chosen:
   honest, mode-string-discriminated.)

## 9. Consciously-touched / tracked

- Rewrite `bin/worker-daemon.ts:285-292` honest-note (the mode check is no longer redundant-by-construction).
- `MountedSecretKeyStore` is now definitively dead (zero prod constructors, and Pivot 1 persists the key
  inline). Deletion out of scope; track a cleanup successor.
- File the **WRK-016** stub: replicated/autoscaled-fleet identity granularity + retirement runbook (§4).

## 10. Review round — three-agent adversarial pass (2026-08-28), all verified against source

- **BLOCKER (grounding) — `resolveCustody` can't distinguish store types** (both params typed
  `DeviceRecordStore`) → **distinct `file_record` mode** (§3), not an in-place amendment. Preserves the three
  mutation-hardened `mounted_secret` guards. **Verified** (`device-identity-store.ts:104-134`).
- **HIGH (security) — repointing the CMD in WRK-014 crash-loops every POSIX compose** → **WRK-014 lands
  inert; WRK-015 shipped the POSIX fix, WRK-017 activates the container path** (§1, §5). **Verified** at
  WRK-014 time (`assertLocalAbsolutePath` was Windows-only; WRK-015 made it platform-aware).
- **HIGH (completeness) — the volume mandate doesn't survive the replicated staging fleet** (`replicas:2`,
  autoscale) → **singleton canary now; replicated-fleet granularity DEFERRED to WRK-016** (§4). **Verified**
  (`docker-compose.staging.yml` `deploy.replicas`).
- **MED — bare `wx` is not crash-atomic** (a partial write → crash-loop = the lockout) → **temp+fsync+link**
  (§1.1).
- **MED — `Uint8Array` codec** (naive JSON corrupts the key) → base64/hex codec + real-key fixture (§1.1, §6.1).
- **MED — error messages must not echo the key/path** (I13-adjacent) → content-free faults + a test (§1.1, §6.1).
- **MED — `config.stateDir` has no consumer under seam (a)** → host reads `AOA_WORKER_STATE_DIR` from env (§1.2).
- **MED — "reaches the poll loop" over-claims** → enrol-not-dispatch scope boundary (Why-section).
- **LOW — entrypoint shape / pivot-2 rationale / honest-note / dead class** → §1.3, §0, §9.
- **CONFIRMED:** both pivots; §5 (POSIX universal → WRK-015 hard co-req); no pre-existing file store; 0600
  enforceable; I13 preservation; boundary-legal + no image-deps risk.
