# DSK-001 Lane A — result

**Date:** 2026-08-21
**Branch:** `docs/replatform-program` (PR #323)
**Start SHA (design committed before code):** `8c454177e`
**Lane A tip:** `d88d21740`
**Covers:** design D1–D8, D13 (host), D14, D15; plan §1A–§1D, §4 D1–D7; amendment A1

---

## 1. What Lane A is

Device custody and the enrollment client: a Windows DPAPI-backed identity store,
an atomic device-identity envelope, a coordinator that mints at most once, and
the daemon wiring that actually enrols. Everything downstream of "the device has
an identity and can prove it" is Lanes B–D and is **not done** — §6 states that
plainly rather than by omission.

## 2. The failure mode everything is organized around

A second device identity is a **permanent lockout**. The server denies the new
`workerId` at `worker-enrollment.ts:418-423` (`worker_transfer_denied`), and
`findWorkerForBinding` (`packages/db/src/repositories/tenant/worker-enrollment.ts:274-287`)
filters on scope / target / organization / owner with **no status predicate** —
so even the revoked row keeps matching and blocks re-enrolment forever, with no
reset route.

Every decision below is downstream of that. It is also why the recurring defect
shape in this ticket is worth naming: **a value carrying less information than
the code assumed it did.**

| The impoverished value | What it could not express | Where it led |
|---|---|---|
| `existsSync` → boolean | a fault, as distinct from absence | permission-denied read as "never enrolled" → second mint |
| `catch [IO.IOException]` | which of four conditions fired | disk-full reported as "already present" |
| empty stdout on exit 0 | success vs. silent crypto failure | a failed write reported as stored |
| exit code under `-File` vs `-EncodedCommand` | anything stable at all | the failure oracle depended on invocation shape |
| `k` as a field name | that it holds a private key | invisible to the logger's redactor |
| `as never` at the composition root | a genuine record-shape mismatch | three fields silently dropped |
| a thrown enrolment error | whether this boot minted | fatal/non-fatal split impossible |

The fix is the same every time: make the value richer, then make the caller
consume the richer thing.

---

## 3. Acceptance, clause by clause

| Clause | Evidence |
|---|---|
| **I2** a fault never becomes `null` | `outcome.ts` six-valued classifier; `identity-store.ts` `load()` throws on all four fault kinds; `outcome.test.ts` |
| **I3** a store that cannot open never yields an identity | `enroll-once.test.ts` "refuses when the identity store throws, with ZERO mints" — proven by counting the `randomWorkerId`/`generateKey` spies, not by mocking |
| **I4** compare-and-set resolved by the OS | `[IO.File]::Open(path,'CreateNew')` + distinct exit 4; live-verified (second store → exit 4) |
| **I5** key material crosses stdin only | `planVaultCommand` takes no secret parameter — structural, not a discipline; plus `selectChildEnv` (§4.3) |
| **I6** `workerId` and key are ONE artifact | five-field envelope; 14 damaged-input cases all throw; a property test over every input that decodes |
| **I7** mint-once, and the wipe is guarded | `enroll-once` spy counts; `--reset-identity` guard (§4.2) |
| **I9** CurrentUser scope, absolute interpreter path | `command-plan.test.ts`, byte-locked fixture |
| **I11** custody before the socket | `custody-bootstrap.test.ts` — asserts `startHealth` was **not called**, which is the property that matters |
| **I12** the hello is unmatchable | `desktop-hello.ts` `reportedCapabilities: []` |
| **I13** no session/token escapes; no credential in a log | frozen outcome key allowlist; `enrollment-bootstrap.test.ts` credential cases; D7 byte masking; entry-guard redaction |
| **I23** subprocess confined to one file | `check-worker-keystore-boundary.mjs` + an 18-case adversarial corpus |
| **D14** enrolment at the existing startup seam | `enrollment-bootstrap.test.ts` "enrols AFTER the health server is up" |
| **D15** ticket over the existing source config | `enrollment-input.ts`; `config/config.ts` unchanged |

---

## 4. What the adversarial review found, and what it cost

Five findings survived. All five are fixed; three of them turned out to be worse
than the review stated.

### 4.1 Subprocess confinement keyed on a BASENAME (`12dd5a12e`)

Demonstrated live before the fix: `src/sneaky/command-runner.ts` importing
`node:child_process` passed the checker with exit 0. Anyone who made a
subdirectory inherited spawn permission. Now keyed on the full package-relative
path. The 13-case corpus should have caught it and did not — no case had ever put
a file in a subdirectory — so it is now case 14.

### 4.2 `--reset-identity` shipped with no guard at all (`2210b3b39`)

One argument performed the irreversible act the whole ticket exists to prevent,
and it is the argument an operator reaches for when a start is failing. The wipe
now reads the identity first, names the `workerId`/`targetId` at stake, states
the permanence, says **do NOT reset** when a start is failing with an identity
present, and requires `--i-understand-this-is-permanent`.

Relaxed in exactly one state — the slot is **provably absent** — which rests on
the one signal this package trusts (ENOENT, never inferred).

**Deferred, and recorded at the site:** plan §3/I7 point 4 also relaxes for a
G2(ii) crash (slot present but zero-length, receipt absent). That state is **not
distinguishable** with the current vocabulary: `ReadAllBytes` on a zero-length
blob gives an empty array, `Unprotect` throws, `harden` reports exit 3, and the
classifier says `locked` — identically to a locked or ACL-denied slot holding a
perfectly good key. Relaxing on `locked` would drop the guard precisely where the
lockout is real. Splitting it needs a distinct empty-slot exit code, which buys
only a friendlier message in one bricked state.

### 4.3 Three defects found while fixing the above

- **The key field was named to dodge the wrong scanner** (`81c79ffc9`). `k` was
  justified by the frozen *wire-safety* normalizer, which never runs on this
  object. The guard that applies to a stray diagnostic is the daemon logger's
  `SENSITIVE_SUBSTRINGS`, and `k` normalizes to `k`, matching nothing, while
  `privatekey` is in the list. The old test **enforced the wrong property** and
  would have resisted the fix.
- **The PowerShell child inherited the whole environment** (`6beae3899`),
  credential included. A denylist cannot work: the credential lives in an
  *operator-named* variable. `selectChildEnv` is an allowlist, pure so it is
  provable on the ubuntu lane, and **live-verified against real DPAPI** because
  the required lane could not catch a PowerShell that fails to start under a
  trimmed environment.
- **`resolveCustody` accepted `mounted_secret` with stores injected**
  (`f23a2d158`). Plan §4/D3 row 2 never shipped. Found by a *surviving mutant*,
  not by reading.

### 4.4 The enrollment client was wired to nothing (`f23a2d158`, `d88d21740`)

`enrollOnce` had zero callers outside its own tests. D4 and D6 did not ship. Now
wired per amendment A1, which was committed **before** the code because four of
D4's premises were wrong.

---

## 5. Verification

- **Fail-first on every guard.** Counts per increment are in the commit messages.
  Where a new test passed against existing code it is labelled a **regression
  guard**, not claimed as a new proof.
- **Mutation-tested: 28 mutants, 27 killed, 1 documented survivor.**
  - Survivor: D3, removing the `keyStoreMode` gate from the enrolment block. It
    is redundant *by construction* now that `resolveCustody` refuses the
    contradictory pair one layer out (that gate is itself mutation-proven, R1/R2).
    Recorded as a survivor and documented at the site rather than dressed up.
  - Reclassified: V1 (renaming only the interface field) survived and is a **weak
    mutant** — TypeScript types are erased, so vitest could never have seen it.
    The behavioural equivalent V1b is killed by two tests.
- **The mutation harness itself had two bugs, both of which produced wrong
  answers, and both are worth carrying forward.** It wrote mutants with an
  unclosed file handle, so a subprocess could read the *previous* mutant —
  exposed only because two mutants with identical text reported different kills.
  And anchors written with `\n` silently failed to match CRLF files, so those
  mutants never ran. **A mutation harness that lies is worse than none: it
  certifies a guard that was never tested.**
- **A guard was born dead.** The `existsSync` ban was first written with raw 0x08
  BACKSPACE bytes where `\b` was intended (a shell heredoc ate the escape). The
  corpus reported 17/17 green while the guard did nothing, and the bytes render
  as `\b` in every diff.
- **Suites at the Lane A tip:** 495 worker-daemon, 110 worker-keystore, 18
  boundary-corpus. `tsc --noEmit` clean in both packages. All three boundary
  gates PASS.
- **Live Windows DPAPI** (controller-run, not CI): 13-check probe plus an
  8-check round-trip under the trimmed environment.
- `docker/d1/campaign.env` **not** bumped: nothing here touches `server/src`.

---

## 6. Not done — honestly

**Lanes B, C and D are not started.** Lane A is device custody and enrolment;
none of the following ships in it:

| Deferred | Design ref | State |
|---|---|---|
| `DeviceLocalCredentialBroker` (activation, never bytes) | D10 | not started; DAT-004 residual B open |
| Owner-membership pull enforcement | D11 | not started |
| The four `ref_id ↔ provider_credentials` sub-contracts | D12 | not started |
| DSK-00 negative closure | D16 | not started; parts FAIL today |
| Device listing / Settings surface | D17 | not started |
| Exported conformance battery + named-mode fault injector | D9 | not started |
| macOS and Linux production key stores | D4 | ports and command plans only, by design; `planVaultCommand` throws for non-win32 |

Also outstanding, and **not** ours to close:

- **macOS is entirely unverified** (design R2, OQ-3). Every macOS claim is
  inference from documented interfaces. Needs real hardware before DSK-003 plans
  its installer. This is an operator lead-time item.
- **Code-signing certificates** (Apple Developer ID + Windows) for DSK-003.
- The `packages/worker-protocol/src/capabilities.test.ts` TEST-ONLY addition
  still needs an operator ruling: all three frozen gates pass and it is
  contractually inert, but the package is frozen.

## 7. Known-weaker-than-ideal, stated rather than glossed

- The non-fatal enrolment branch is **narrower than amendment A1's wording
  implies**: the `identity && receipt` steady state returns before the network,
  so it is reached only by a device that crashed between the identity write and
  the receipt write — not by an enrolled device refreshing authority. The branch
  is correct and correctly shaped for a future refresh; it is just rarer today.
- `bin/desktop-host.ts` and `bin/aoa-worker-desktop.ts` are a **developer host,
  not a product**. Packaging, signing, notarization, autostart and uninstall are
  DSK-003.
- The required CI lanes are ubuntu-only. Everything security-critical here is
  pure so it is provable there, but the DPAPI evidence in §5 is
  controller-measured on one Windows machine, not continuously verified.
