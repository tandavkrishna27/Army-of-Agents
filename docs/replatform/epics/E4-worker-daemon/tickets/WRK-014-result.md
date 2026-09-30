# WRK-014 — result: container device identity, landed INERT

**Epic:** E4 · **Status:** SHIPPED (inert) · **Design (Start SHA):** `eabd3733e` (design v2, post 3-agent review)
**Terrain of record:** `WAVE-4-RESEQUENCE.md` §3.1 · `SPIKE-worker-walking-skeleton.md` F1
**Reconciliation:** `qa/2026-08-28-worker-dispatch-chain-reconciled.md` (link 3.1)

---

## 1. What shipped (ENROL-enablement, INERT — no deployed container changed)

A shipped `mounted_secret` container holds a key but **no device identity**, so it can never enrol
(SPIKE F1). WRK-014 gives a container a way to enrol and persist an identity, and lands it **provably-
correct-but-unwired**: the Dockerfile CMD still runs `worker-daemon.js`, no compose switched a worker to
the new mode, and `mounted_secret`'s behaviour is byte-identical. WRK-015 activates the path (the POSIX
enrolment-input fix + the CMD repoint + a canary compose switch).

| # | Deliverable | File | Kind |
|---|---|---|---|
| 1 | `FileRecordStore<T>` — a `DeviceRecordStore` over `node:fs`: crash-atomic `saveIfAbsent` (unique temp → `fsync` → atomic `link()` CAS → unlink temp), fail-closed `load()` (ENOENT→null; corrupt/insecure/empty→throw), `clear()` | `packages/worker-daemon/src/identity/file-record-store.ts` | NEW |
| 2 | The daemon's OWN `Uint8Array`-safe codec (base64 key field `privateKeyPkcs8B64`, redactor-catchable) — NOT `worker-keystore`'s (import-forbidden) | `packages/worker-daemon/src/identity/record-codec.ts` | NEW |
| 3 | The container host `runContainerHost({env,proc})` — reads `AOA_WORKER_STATE_DIR` (default `/worker`) directly, boot-time writable-state-dir assert (fail-closed, pre-socket), builds the two stores, injects into `bootstrapWorkerDaemon`; a thin `invokedDirectly` guard with enrolment-code redaction. CMD **not** repointed. | `packages/worker-daemon/src/bin/container-host.ts` | NEW |
| 4 | A distinct `file_record` custody MODE in `KEY_STORE_MODES` | `packages/worker-daemon/src/config/config.ts` | MOD |
| 5 | `resolveCustody`'s `file_record` arm — both stores→ok; exactly one→refuse; none→refuse. `mounted_secret` arm UNTOUCHED. | `packages/worker-daemon/src/identity/device-identity-store.ts` | MOD |
| 6 | The enrol-gate `file_record` arm `(os_keychain \|\| file_record) && identityStore && receiptStore`; honest-note rewritten (§9) | `packages/worker-daemon/src/bin/worker-daemon.ts` | MOD |
| 7 | WRK-016 scoping stub (replicated-fleet identity granularity + retirement runbook) — node + file | `docs/replatform/program-design.md`, `.../tickets/WRK-016-design.md` | NEW |
| 8 | `AOA_WORKER_STATE_DIR` documented; `AOA_WORKER_KEY_STORE_MODE` row names `file_record` | `docs/deploy/environment-variables.md` | MOD |

**Two design-defining pivots, both held:** (1) it builds a `DeviceRecordStore` (identity persisted inline
by `enrollOnce`), NOT a `MountedSecretKeyStore` (keyless); (2) the custody code lives IN `worker-daemon`
(only `node:fs`/`node:crypto`, boundary-legal), not in the un-copied `worker-keystore`.

## 2. Tests (fail-first, TDD §6) + fixture/mutation table

30 new tests across 4 suites (all watched RED for the right reason, then GREEN):

| Suite | Tests | Covers |
|---|---|---|
| `file-record-store.test.ts` | 13 | round-trip vs a REAL Ed25519 key (byte-equal + key reconstructs), CAS/no-overwrite, the full durable-publish sequence (temp → fsync → link → **parent-dir fsync**) + crash-before-link → `null`, EEXIST → already_present, fail-closed corrupt/insecure/empty content-free + path-free |
| `custody-bootstrap.test.ts` (+4) | 14 | `file_record` arm (both→ok, one→refuse, none→refuse) + the 3 pinned `mounted_secret` cases still green |
| `enrollment-bootstrap.test.ts` (+1) | 12 | enrols under `file_record`; store-less `mounted_secret` still does NOT enrol |
| `container-host.test.ts` | 12 (1 skip) | state-dir resolution, stores rooted at the dir + injected, no provider (E4-D01), writable assert fails closed pre-bootstrap (+ real POSIX chmod 0500, skipped on win32), real `enrollOnce`+FileRecordStore persist→re-boot short-circuit, I13, redaction |

Full worker-daemon suite after the change: **858 passed / 1 skipped / 142 files**. `tsc --noEmit` clean.

**Mutation sweep (DELETE each guard; positive control FIRST; every anchor matched exactly once):**

| Mutant | Target test | Result |
|---|---|---|
| **PC** — `saveIfAbsent` → no-op write | file-record-store | **KILLED** (9 red) — the suite exercises the store |
| M-fsync — drop `fsync` before `link` | file-record-store | **KILLED** |
| M-link-eexist — EEXIST no longer → already_present | file-record-store | **KILLED** |
| M-corrupt-wrapper — let a decode fault escape unwrapped | file-record-store | **KILLED** |
| M-perms — drop the insecure-permissions guard | file-record-store | **KILLED** |
| M-custody-identity — drop `file_record` identity refuse | custody-bootstrap | **KILLED** |
| M-custody-receipt — drop `file_record` receipt refuse | custody-bootstrap | **KILLED** |
| M-custody-admit — `file_record` both-present → refuse not ok | custody + enrollment | **KILLED** (cross-cuts enrol) |
| M-gate-disjunct — drop the `file_record` arm from the enrol gate | enrollment-bootstrap | **KILLED** |
| M-writable — drop the container-host writable-state-dir guard | container-host | **KILLED** |
| M-dir-fsync — drop the parent-dir fsync (the review-driven durability fix) | file-record-store | **KILLED** |
| M-empty — drop the empty-file guard | file-record-store | **SURVIVED — documented equivalent** |

**The one survivor, resolved honestly.** The empty-file guard produces a clearer message ("empty") but
its fail-closed CONTRACT (throw `DeviceKeyStoreError`, never `null`/partial) is enforced by the
corrupt-wrapper — proven by deleting BOTH the empty guard AND the corrupt-wrapper, which then reddens the
empty test. So the empty guard is an equivalent kept for message clarity + parity with
`MountedSecretKeyStore`; the load-bearing guard (M-corrupt-wrapper) is independently KILLED.

## 3. Registers (all green at tip)

```
check-worker-daemon-boundary : PASS (new files import only node builtins + relative)
check-image-deps-stages      : PASS
check-ticket-graph-coverage  : OK (102 ticket ids from files, all among 116 nodes; WRK-016 seen)
check-finding-ownership      : OK (11 open; UNOWNED unchanged — WRK-014 filed no findings)
check-guard-inventory        : OK (40 — no new check-*.mjs)
check-gate-clause-wiring     : OK (5 wired / 9 dormant — WRK-014 flips NO clause; enrol-not-dispatch)
check-execution-census       : OK (unchanged — new tests are vitest *.test.ts, not *.test.mjs)
check-dependency-graph       : OK (114 tickets, 0 dangling, 0 cycles; WRK-016 edge → WRK-014 clean)
check-test-inventory         : OK (packages/worker-daemon pin bumped 147 → 149 — my 2 new *.test.ts)
check-boot-roots-provider-free : OK (container-host.ts declared providerPosture "none" — a new boot root)
```

**★ Two guards §6 MISSED, caught by the FIRST CI `policy` red (honest correction).** §6 said "new `*.ts`
+ `*.test.ts` trip neither guard-inventory nor the census" — true, but INCOMPLETE. The `policy` job also runs:
- `check-test-inventory.mjs`, which PINS the `packages/worker-daemon` test-file count (exact). My two new
  `*.test.ts` files failed it. Fixed by bumping ONLY that pin (147 → 149); I explicitly REVERTED the
  `--write`'s over-reach into two unrelated `floor` trees (`packages/db`, `server` — pre-existing legal
  drift where the tree grew above its floor), per the [[dsk-003]] "a deletion can hide in an inventory
  bump" lesson.
- `check-boot-roots-provider-free.mjs`, which enumerates every file obtaining `bootstrapWorkerDaemon`.
  `container-host.ts` is a NEW boot root, so it had to be DECLARED in `boot-roots-expectation.json` with
  `providerPosture: "none"` (structural — E4-D01 forbids worker-daemon importing a provider; the shipped
  `runContainerHost({env,proc})` passes none). The guard doing its job: a new boot root cannot slip in
  silently.

Both fixed in the follow-up commit; the ENTIRE `policy` suite (every `check-*.mjs` runner + `--test` unit
suite) then runs green locally, so the second CI push is validated against the same checks CI runs.

No migration; `packages/worker-protocol` untouched (FROZEN); no runtime code wires dispatch.

## 4. Scope boundary held — what this does NOT do

WRK-014 is **enrol-enablement, not dispatch.** After enrolment, composition is still gated on things
WRK-014 does not provide: a `SandboxProvider` (DEP-011/DEP-012, unbuilt), `AOA_WORKER_DISPATCH_ENABLED=1`,
and `AOA_WORKER_EVENT_OUTBOX_PATH`. The change set wires none of these. The container path is UNWIRED
(WRK-015 activates it).

## 5. Claims I could NOT prove here (owed downstream, stated plainly)

- **A container actually enrolling against a real control plane.** The tests prove the custody + gate +
  persistence with a fake enroller/spy (the established daemon convention — bootstrap tests use a spy
  `enrollOnceFn`; real `enrollOnce` persistence is proven with the sanctioned `createEnrollerFn` seam over
  a real `FileRecordStore`). The real daemon↔real-server↔real-E2B run is Sprint 5 / E7-1 (operator).
- **The POSIX enrolment path.** The container tests use the **env arm** (`AOA_WORKER_ENROLLMENT_CODE_ENV`)
  deliberately — `assertLocalAbsolutePath` rejects every POSIX path (SPIKE F5). WRK-015 fixes it; until
  then a live container on the file arm would crash-loop, which is exactly why WRK-014 lands inert.
- **Replicated/autoscaled-fleet durability.** WRK-014 targets a SINGLETON canary (named volume + writable
  assert + a retire-not-reset operator note). Per-replica identity granularity + the retirement runbook
  are DEFERRED to WRK-016 (filed, on the graph). No replicated-fleet manifest checker was authored — its
  shape is undecided.
- **`mounted_secret` is now definitively dead code** (zero prod constructors; Pivot 1 persists the key
  inline). Deletion is out of scope; tracked as a cleanup successor (§9 of the design).

## 6. Adversarial review — 5 independent subagents + a refutation skeptic

Five reviewers, one per dimension changed, each read-only and told to attack from SOURCE; plus a skeptic
charged to REFUTE each guard/claim and default to refuted if it could not reproduce it. Reviewers ran the
suite, the registers, `tsc`, and the boundary guard themselves.

| Reviewer | Verdict | Findings |
|---|---|---|
| Security / I13 | **0 HIGH** | I13 (code + session never logged / in-outcome / on-disk — and for the shipped container the session is never even minted, no provider), content-free + path-free faults (bare `catch` discards the codec message), 0600 perms + perms-check-before-trust, I11 verdict pre-socket, redactor-catchable field name — all CONFIRMED + regression-locked. 2 LOW (below). |
| Correctness / crash-atomicity | **0 HIGH** | Never-a-partial + never-overwrite CAS + byte-exact codec + `null`-only-on-ENOENT all CONFIRMED on NTFS + Linux (empirical probes). **1 MED (FIXED, below)** + 3 LOW. |
| Inertness / boundary | **0 HIGH** | CMD unchanged, all 6 workers still `mounted_secret`, `mounted_secret` byte-identical (26/26 green), both boundary guards PASS, container-host ships dead. The whole-mode-check-deletion survivor is disclosed in the honest-note + §6.2 (expected). |
| Completeness / tracking | **0 HIGH** | WRK-016 node+file+single-justified-edge+no-finding, all 6 registers exit 0, env var documented, pure enrol-enablement (no dispatch wiring), worker-protocol frozen. No MED/LOW. |
| Skeptic (refute all 10 claims) | **0 REFUTED** | All ten claims UPHELD, reproduced directly (registers exit 0, boundary PASS, `tsc` exit 0, 857/857). Ruled out a latent generation-reject lockout. |

**What I FIXED (survived review):**
- **MED — the parent directory was not `fsync`'d after `link()`** (correctness reviewer). A successfully-
  "stored" identity could be lost to power loss in the FS metadata-commit window → re-mint → permanent
  `worker_transfer_denied` — the exact lockout the crash-atomic write exists to prevent. Fixed:
  `fsyncParentDir()` (best-effort, seam-routed) completes the durable-publish idiom. New RED→GREEN test
  (`durable-publish sequence`) + a killing mutant (**M-dir-fsync**). The design specified only
  `temp→fsync→link`; the precedent (`MountedSecretKeyStore`) fsyncs nothing — so this is strictly stronger
  than both, and the review is what surfaced it.

**What I KILLED / did NOT change (accepted, with reasons):**
- **LOW (security ×2)** — `redactEnrollmentCodes` masks only the `aoa_enr_` code shape (not a session token
  / `aoa_tkt_` envelope), and the host's stdout `log` bypasses the pino redactor. Both are UNREACHABLE for
  the shipped container (no provider ⇒ no session minted; the log only ever emits the non-secret state-dir
  path + an errno) and both **mirror the desktop precedent verbatim** — which is exactly what §1.3 asked
  for. Revisit if a future ticket wires container session composition; not in this INERT scope.
- **LOW (correctness) — lenient base64 (`Buffer.from` doesn't throw like the precedent's `atob`).** The
  reviewer confirmed NO invariant breaks: a malformed key is caught by the `der.length===0` guard or
  downstream by `deviceKeyFromPkcs8Der`'s throw (never a second mint — the record was loaded non-null, so
  the mint branch is skipped). Deliberately NOT "hardened": adding strictness risks a false-reject of a
  VALID key, which is the *worse* failure (a crash-loop) — the safer choice is leniency + the proven
  downstream throw.
- **LOW (correctness) — unwrapped `mkdir`/`encode`/`close` can escape `saveIfAbsent` carrying the dir path.**
  The private key never leaks (encode faults are content-free); I13's content-free guarantee is scoped to
  `load()` (which holds the key), and this matches the `MountedSecretKeyStore.save()` precedent.
- **LOW (correctness) — a `closeSync`-failure orphan is a key-bearing temp with no sweeper.** Correctness-
  harmless (`load()` reads only the final path; each save uses a fresh uuid); hygiene only.
- **Skeptic observation — no single end-to-end `runContainerHost`→real-bootstrap→real-`enrollOnce`→real-
  `FileRecordStore` chain.** Deliberate component strategy + the established daemon convention (bootstrap
  tests use a spy `enrollOnceFn`; real `enrollOnce` persistence is proven with the sanctioned
  `createEnrollerFn` seam over a real store) — the composition is type-checked. The skeptic itself rated it
  "low risk, not a defect."

No HIGH/BLOCKING finding survived; the one MED is fixed and mutation-proven; every LOW is a documented,
precedent-consistent accept.
