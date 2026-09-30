# WRK-015 — POSIX enrolment input + a CI-exercised first container-enrol (on d1)

**Epic:** E4 · **Plan node:** `docs/replatform/program-design.md`, `#### WRK-015`
**Depends on:** WRK-014 · **Size:** M · **Status:** design **v2** (2026-08-28, post 3-agent adversarial review — §10)
**Terrain of record:** [`WAVE-4-RESEQUENCE.md`](../../../WAVE-4-RESEQUENCE.md) §3.2 · [`SPIKE-worker-walking-skeleton.md`](../../../SPIKE-worker-walking-skeleton.md) F5
**Reconciliation:** [`qa/2026-08-28-worker-dispatch-chain-reconciled.md`](../../../qa/2026-08-28-worker-dispatch-chain-reconciled.md) (link 3.2)

---

## Why this ticket exists (TWO parts) — reframed by the review

WRK-014 shipped the container custody code **inert**. WRK-015:
1. **Part 1 — the POSIX path-validation fix.** `assertLocalAbsolutePath` (`enrollment/enrollment-input.ts`)
   is a Windows-only syntactic allowlist; every POSIX absolute path is rejected. The instant a container
   reaches enrolment it throws → `exit(1)`. This is WRK-015's chartered core.
2. **Part 2 — a CI-EXERCISED first container-enrol, on d1** (reframed from a staging canary — §0). Switch
   ONE d1 worker to `file_record` + the container host, and have the d1 harness enrol it, so a real
   container reads a POSIX code, mints+persists a `DeviceIdentityRecord`, and enrols **in CI** — proving
   WRK-014+WRK-015 end to end.

**★ Scope boundary (carried):** this reaches ENROL, not dispatch (that needs DEP-012/DEP-011 +
`AOA_WORKER_DISPATCH_ENABLED=1` + an outbox path). WRK-015 lets the built session/hello/self-model/loop
links run for the first time.

## 0. The reframe the review forced: prove on d1, DEFER the staging canary

v1 activated via a new **staging** `worker-canary` service. Three verified reasons that is wrong:
- **It boots nowhere in CI.** The staging compose is a deploy-intent template no CI lane brings up (only
  `docker compose config` renders it); d1 is the stack that actually boots worker containers
  (`d1-merge-train.yml` `docker compose … up -d --wait`, with named `d1-worker-*-state` volumes).
- **It crash-loops as specified** — the 4-key delta omitted `AOA_WORKER_CONTROL_PLANE_URL` (required,
  `config.ts` `parseControlPlaneUrl` throws) and `AOA_WORKER_TARGET_SCOPE` (required, no default), so
  `loadWorkerConfig` `exit(1)`s pre-socket.
- **The reconciliation already sequences the staging enrolled-worker as a CAMPAIGN-TIME operator step** (C0,
  downstream of the code links; CLI-006 runbook §2.3/§3 enrols a worker at campaign time). It is not a code
  landing.

**So: Part 2 is a d1 `file_record` switch (CI-exercised). The STAGING canary is DEFERRED** to campaign time
(an operator step alongside DEP-012, per the reconciliation §4 + the CLI-006 runbook) — dropping the
premature/broken canary, the singleton-worker manifest-checker complexity, and the runbook coordination
gap. (The manifest-category findings F1–F5 the activation review raised are thereby MOOT for WRK-015; they
belong to whoever lands the campaign-time staging canary.)

## 1. Part 1 — the POSIX validator (the security core)

- **Platform-awareness** — mirror `identity/file-custody.ts` `ownerOnlyViolation`: add an optional
  `platform: NodeJS.Platform = process.platform` to `assertLocalAbsolutePath` (threaded from
  `readEnrollmentInput`), so the composition-root thunk (`bin/worker-daemon.ts:321`) stays 3-arg and both
  arms are testable on either OS. `win32` → the existing arm unchanged; else → the POSIX arm.
- **The POSIX arm — mirror `worker-protocol/policy.ts isSandboxSecretFilePath`'s SHAPE, minus the fixed
  root, but ★ ADD AN EXPLICIT LEADING-`/` CHECK** (review MED-1, verified): that function's
  `startsWith(SANDBOX_SECRET_ROOT)` line does DOUBLE DUTY — confinement AND absoluteness (the segment loop
  does `.slice(1)` assuming a leading `/`). Deleting the root line naively **accepts relative paths**
  (`rel/path` → `["el","path"]` → accepted). So the POSIX arm must: require a leading `/`
  (`charCodeAt(0)===0x2f`); reject `..`/`.` segments, `//` empty segments (incl. trailing `/`), backslashes,
  control/NUL bytes (`< 0x20 || 0x7f`), and length > 1024. `worker-protocol` is FROZEN — mirror the shape,
  do NOT call it (it is also module-private).
- **`/dev`, `/proc`, `/sys`, symlinks, network mounts are OUT of scope** — valid absolute paths; denylisting
  is the "losing game" the Windows arm refuses. This is **honest parity**: the Windows arm has the identical
  residual via a junction/reparse point at a `C:\`-rooted path.
- **Preserve the 3 properties, structurally:** the POSIX arm slots INSIDE the `{kind:"path"}` branch at
  `:102-103` (locality BEFORE the read); throws the same **content-free** `EnrollmentInputError`; the return
  field stays `enrollmentCode` (`:124`, logger-redacted).

## 2. The security rationale (state it — review MED-2)

The safety of accepting an arbitrary absolute path does NOT rest on confinement (the root is gone) — it
rests on: **an arbitrary read is INERT here.** `readFileText`'s result flows only into
`decodeEnrollmentTicket` (a strict `aoa_tkt_<base64url>` codec), and every failure is content-free — even a
symlink to `/etc/shadow` yields a content-free `EnrollmentInputError`. Plus check-before-read + a single-use
10-min code + an operator-owned mount. **★ Invariant to state (review MED-2, answers old §8 Q2):**
`enrollmentCodeSource` must remain operator/config-sourced, NEVER wire/remote-sourced — if a future change
ever let an untrusted channel set it, "minus the root" becomes an arbitrary-file-read primitive with no
confinement backstop. (The read is also unbounded on both arms — `/dev/zero`/FIFO is an availability
residual, not new in kind; harden with a size-bounded read at the injected-reader seam if ever needed, not
`lstat` — review LOW-1.)

## 3. Part 2 — the d1 first-enrol proof (CI-exercised)

Switch **one** d1 worker (`worker-a`, `docker-compose.d1.yml`) from `mounted_secret` to the container path:
`AOA_WORKER_KEY_STORE_MODE: "file_record"`, `AOA_WORKER_STATE_DIR: "/worker"` (its named volume
`d1-worker-a-state:/worker` already exists), keep its POSIX `AOA_WORKER_ENROLLMENT_CODE_FILE`, and add
`command: ["node","dist/bin/container-host.js"]` (**Correction 1 — NOT an image-CMD repoint**, which would
crash-loop every still-`mounted_secret` container: `container-host.ts` injects stores unconditionally and
`resolveCustody("mounted_secret", stores)` refuses → `exit(1)`; verified end-to-end). Leave `worker-b` on
`mounted_secret` (regression control).

- **Step 0 — confirm the d1 harness can ENROL a worker** (mint a valid `aoa_enr_` code into the code file +
  register an ACTIVE execution target with a ratified placement profile). The d1 stack exercises the
  distributed journey (CLI-006 D1), so target-registration + code-minting utilities exist or are a small
  add — but a `file_record` worker that boots with no code/target enrols nowhere (`issueTenantCode` throws
  `unauthorized` with no target). If the harness cannot enrol a worker, STOP and split Part 2 out.
- **The proof:** the d1 merge-train boots `worker-a` on `file_record`; it reads the POSIX code (Part 1),
  `enrollOnce` mints+persists a `DeviceIdentityRecord`+receipt to `/worker`, and enrols; a re-boot
  short-circuits (no second enrol). `worker-b` stays `mounted_secret` and does NOT enrol (control).
- **Dockerfile** — add a build-stage `test -f …/dist/bin/container-host.js` guard (the command override
  needs the bin present). Do NOT change the image `CMD`.

## 4. Sequencing / split

Part 1 alone is harmless (only widens acceptance; nothing exercises the `{kind:"path"}` arm on a container
until Part 2). Part 2 CANNOT ship without Part 1 (the d1 worker would crash-loop at
`assertLocalAbsolutePath`). Land **Part 1 then Part 2** (or atomically). If Part 2's d1-harness enrol flow
proves large (Step 0), land Part 1 alone and file Part 2 as a successor — Part 1 is independently valuable
and the chartered core. **The staging canary is not in WRK-015** either way.

## 5. TDD plan (fail-first)

1. **POSIX validator — unit (`enrollment-input.test.ts`).** RED (`platform:"linux"`): accept
   `/run/secrets/worker-enrollment-code`; reject `ticket.txt` (relative — the MED-1 leading-`/` case, assert
   `readFileText` NOT called), `/a/../b`, `//x`, `/a\\b`, a control-byte path, a >1024 path — each content-free.
   **Pin `platform:"win32"` on EVERY existing Windows case** (they stay green), and **add a `platform:"linux"`
   twin of the codec-no-echo tests** (`enrollment-input.test.ts:95-119` use `C:\…` and would short-circuit
   before the read on Linux — review LOW-3): a `linux` path whose `readFileText` returns a malformed ticket,
   asserting the message echoes no bytes.
2. **`readEnrollmentInput` POSIX round-trip.** RED: `{kind:"path","/run/secrets/…"}` on `linux` → a valid
   ticket → `{targetId, enrollmentCode}`.
3. **d1 first-enrol — integration** (`tests/d1/…`, `AOA_D1_LIVE`). RED: with `worker-a` on `file_record` +
   an enrolled code+target, the d1 stack brings `worker-a` to healthy AND it enrols (a persisted identity in
   its volume); `worker-b` (`mounted_secret`) does not. (Gated on Step 0.)
4. Mutation-test every guard (DELETE, positive control first). `packages/worker-protocol` is FROZEN.

## 6. When done — the FULL guard list (WRK-014's + this review's missed-guard lesson)

Run ALL of: the five registers + `check-worker-daemon-boundary` (green — POSIX fix adds no new import;
`node:process`/`node:path` are built-ins + pure string) + **`check-test-inventory`** (bump the `worker-daemon`
pin; revert any `--write` over-reach into unrelated floor trees, per the DSK-003 lesson) +
`check-boot-roots-provider-free` (green — the d1 `command:` reuses WRK-014's already-declared
`container-host.ts`, no new source boot root) + **`dockerfile-static.test.mjs`** ("Split-image Dockerfile
static checks" — the Dockerfile changes; review F7, confirmed green) + `check-image-deps-stages` (green —
CMD-blind). d1 changes do NOT touch `check-staging-manifest` (staging manifest untouched). Confirm
brand-check green (no new `process.env.AOA_*` literal; `AOA_WORKER_STATE_DIR` already documented). Commit,
push, report CI honestly (`verify` 4-shard; `ci-required` should PASS).

## 7. Security summary

Syntactic ceiling = honest parity with Windows (symlink/device/network-mount out of scope, mitigated by
check-before-read + inert-read + single-use code + operator mount). No `lstat`/`realpath` (TOCTOU + breaks
the no-read-on-reject property + `O_NOFOLLOW`, not lstat, is what would actually close symlink TOCTOU).
Content-free faults; the `enrollmentCode` redaction name; pre-read ordering — all preserved. The device key
stays local (WRK-014); the enrolment code is single-use. The MED-2 invariant: `enrollmentCodeSource` stays
operator-sourced.

## 8. Open questions for the implementer

1. Step 0 — does the d1 harness already mint a code + register a target for a worker, or is that a small
   add? (If large, split Part 2.)
2. The MED-1 leading-`/` check — a `charCodeAt(0)===0x2f` guard plus the segment loop; confirm the trailing-`/`
   and `//` cases fall out of the empty-segment rejection exactly as `isSandboxSecretFilePath` does.
3. Should `worker-b` also switch (two enrolled d1 workers), or stay `mounted_secret` as the regression
   control? (Recommend: control.)

## 9. Deferred (named, not built here)

- **The staging `worker-canary`** — a campaign-time operator step alongside DEP-012 (per the reconciliation
  §4 + CLI-006 runbook). If ever committed to the staging manifest, it needs the FULL worker env (not a
  delta) and a **positive singleton-worker invariant** in `staging-manifest-invariants.mjs` (assert
  `replicas===1`, no autoscale labels, a named `/worker` volume; add to `EXPECTED_FAILURE_DOMAINS` as
  `shared`, `IMAGE_INJECTION_TOKENS`, `EXPECTED_NETWORKS`, `checkWorkerDrain`) — bare exemptions leave the
  canary's defining properties unpoliced (activation review F1–F5). Not WRK-015's scope.

## 10. Review round — three-agent adversarial pass (2026-08-28), all verified against source

- **Security skeptic — the syntactic allowlist SURVIVES** (no attacker-reachable harm; the read is inert:
  content never escapes the strict codec; symlink/device is honest Windows parity; no `lstat`). Refinements
  folded: **MED-1 explicit leading-`/` check** (verified — "minus the root" drops absoluteness); **MED-2 the
  inert-read rationale + the operator-config invariant** (§2); the codec-no-echo Linux test twin (§5.1).
- **Completeness — the staging canary is premature/mis-placed** (crash-loops at config parse — VERIFIED
  `config.ts` required env; boots nowhere in CI — VERIFIED staging is render-only, d1 boots in the
  merge-train; needs an unnamed target+code+secret; the reconciliation sequences it as campaign-time). →
  **Part 2 reframed to a d1 first-enrol proof; staging canary DEFERRED** (§0, §3, §9). Missed Dockerfile-static
  guard folded (§6).
- **Activation/manifest — Correction 1 (canary `command:` override, image CMD untouched) CONFIRMED correct
  end to end** (reaches `ok`, avoids the fleet crash-loop); `checkProviderControlBoundary` auto-guards any
  canary's E2B-key boundary. Its singleton-worker F1–F5 gaps are recorded for the deferred staging canary
  (§9), moot for the d1-based WRK-015.
- **CONFIRMED:** the POSIX mirror shape; the `file-custody.ts` platform precedent; the 3 properties; the
  test-regression (platform-blind ACCEPT cases red on Linux under a real branch → the win32 pin is required).
