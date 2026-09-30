# WRK-015 — result: POSIX enrolment input SHIPPED (Part 1); the d1 first-enrol proof SPLIT to WRK-017 (Part 2)

**Epic:** E4 · **Status:** Part 1 SHIPPED · Part 2 SPLIT → WRK-017 · **Design (Start SHA):** `fbcc48281` (design v2, post 3-agent review)
**Terrain of record:** `WAVE-4-RESEQUENCE.md` §3.2 · `SPIKE-worker-walking-skeleton.md` F5
**Reconciliation:** `qa/2026-08-28-worker-dispatch-chain-reconciled.md` (link 3.2)

---

## 0. Outcome in one paragraph

Part 1 — the **POSIX enrolment-input validator**, WRK-015's chartered security core — SHIPPED.
`assertLocalAbsolutePath` (`packages/worker-daemon/src/enrollment/enrollment-input.ts`) was a Windows-only
syntactic allowlist that rejected every POSIX absolute path, so a container crash-looped at enrolment the
instant it read a `/worker/...` ticket path (SPIKE F5). It is now **platform-aware**: `win32` keeps the
drive-letter arm byte-unchanged; every other platform gets a POSIX arm that accepts a `/`-rooted absolute
path and rejects the rest. Part 2 — the **CI-exercised d1 first-enrol proof** — hit WRK-015's own Step-0
gate (§3/§4/§8 Q1): the d1 harness has **no worker-enrol flow** and adding one is **LARGE**, so it is SPLIT
into successor ticket **WRK-017** (filed: node + design doc + graph edge). Part 1 is independently valuable
and lands alone, exactly as the design sanctioned (§4). No deployed container changed; the container path
stays UNWIRED (the image CMD is untouched — WRK-017 wires it via a compose `command:` override, not a CMD
repoint).

## 1. Part 1 — what shipped (the POSIX validator)

| # | Deliverable | File | Kind |
|---|---|---|---|
| 1 | `assertLocalAbsolutePath(path, platform = process.platform)` — platform-aware (mirrors `file-custody.ts` `ownerOnlyViolation`'s injected `platform`). `win32` → the existing drive-letter arm, UNCHANGED (early `return`); else → the POSIX arm. | `packages/worker-daemon/src/enrollment/enrollment-input.ts` | MOD |
| 2 | The POSIX arm — mirrors `worker-protocol/policy.ts isSandboxSecretFilePath`'s SHAPE (length ≤1024, no backslash, no control/NUL bytes `< 0x20 \|\| 0x7f`, no empty/`.`/`..` segments) **MINUS** the fixed root **PLUS** an explicit leading-`/` check (`charCodeAt(0) !== 0x2f`). Each rejection is a content-free `EnrollmentInputError`. | same | MOD |
| 3 | `readEnrollmentInput(source, env, readFileText, platform = process.platform)` — `platform` threaded to `assertLocalAbsolutePath`, DEFAULTED so the composition-root thunk (`bin/worker-daemon.ts:321`) stays a 3-arg call and a real Linux container (`process.platform === "linux"`) hits the POSIX arm. | same | MOD |
| 4 | Header + function docs: the inert-read security rationale + the `EnrollmentCodeSource` operator-sourced invariant (§2 below). | same | MOD |
| 5 | Stale-comment correction: `container-host.ts` no longer says `assertLocalAbsolutePath` is "Windows-only" (Part 1 landed the fix); records that activation is WRK-017 via a compose `command:` override (Correction 1, not a CMD repoint). | `packages/worker-daemon/src/bin/container-host.ts` | MOD (comment) |

**The MED-1 leading-`/` fix (the one non-obvious point):** `isSandboxSecretFilePath`'s
`startsWith(SANDBOX_SECRET_ROOT)` line did DOUBLE DUTY — confinement AND absoluteness (its segment loop
`.slice(1)` assumes a leading `/`). Deleting the root line naively **accepts a relative path**
(`"rel/x".slice(1)` → `["l","x"]` → accepted → READ). The explicit leading-`/` check restores absoluteness.
This is proven load-bearing by mutation M-leading-slash (below), whose deletion reddens the relative-path
reject test (`readFileText` gets called).

## 2. The security rationale (design MED-2, stated in code + here)

Accepting an arbitrary POSIX absolute path is safe **not by confinement** (the root is gone) but because
**the read is INERT**: `readFileText`'s result flows only into `decodeEnrollmentTicket` (a strict
`aoa_tkt_<base64url>` codec, `ticket.ts`), and every failure is content-free — even a symlink to
`/etc/shadow` yields a content-free `EnrollmentInputError`. Plus check-before-read, a single-use 10-minute
code, and an operator-owned mount. **Invariant (stated in code):** `EnrollmentCodeSource` must remain
operator/config-sourced (`parseEnrollmentCodeSource`, from `AOA_WORKER_ENROLLMENT_CODE_FILE`/`_ENV`), NEVER
wire/remote-sourced — if an untrusted channel could ever set the path, "minus the root" becomes an
arbitrary-file-read primitive with no confinement backstop. `/dev`, `/proc`, symlinks, network mounts are
valid absolute paths and OUT of scope — **honest parity** with the win32 arm (identical residual via a
junction/reparse point under a `C:\` root). No `lstat`/`realpath` (TOCTOU + would break the no-read-on-reject
property; `O_NOFOLLOW`, not `lstat`, is what would actually close symlink TOCTOU — a future need, not this
ticket — design LOW-1).

## 3. Tests (fail-first, TDD) + fixture/mutation table

`enrollment-input.test.ts`: **12 → 27 tests** (+15). Full worker-daemon suite after the change:
**873 passed / 1 skipped / 142 files**. `tsc --noEmit` clean. `check-worker-daemon-boundary` PASS
(no new import — `process.platform` is a global, `NodeJS.Platform` a type).

Fail-first was observed: with the POSIX arm absent, the accept test + the codec-no-echo linux twin went RED
for the right reason (a `/`-rooted path rejected by the win32-only body; the read never ran), then GREEN.

New / changed coverage:
- **Accept + round-trip** (`platform:"linux"`): `/run/secrets/worker-enrollment-code` → `{targetId, enrollmentCode}`, `readFileText` called with the path.
- **Accept at the 1024-char boundary** (`platform:"linux"`): a length-1024 clean path is accepted (pins the off-by-one against the over-1024 reject — the check is `> 1024`).
- **Reject, content-free, NOT read** (`platform:"linux"`): relative `ticket.txt` (the MED-1 case), `/a/../b`, `/a/./b`, `//x`, trailing `/run/secrets/`, backslash `/a\b`, control byte (0x01), NUL byte (0x00), **DEL byte (0x7f)**, >1024, bare root `/`. Each asserts `EnrollmentInputError`, a content-free message, and `readFileText` NOT called.
- **Codec-no-echo linux twins** (design LOW-3): a `/run/secrets/code` path whose `readFileText` returns a malformed ticket / junk — the read DID run, the codec rejected, the message echoes none of the bytes. One twin is `v:1` + a malformed code so it reaches the codec's **code-shape branch** — the only branch that inspects the credential value. (The win32 `C:\…` twins short-circuit at locality on Linux, so these are the only coverage of the POSIX read→codec no-echo path.)
- **Every existing win32 path case pinned `platform:"win32"`** — without it they redden on a Linux runner (the default would hit the POSIX arm and reject `C:\…`). Env-arm cases are untouched (they never reach the path arm).

**Mutation sweep — DELETE each POSIX guard clause (and each OR-ARM), positive control FIRST; every anchor matched exactly once; source restored byte-for-byte:**

| Mutant | Killing test | Result |
|---|---|---|
| **PC** — POSIX arm accepts everything (`return` before all checks) | every reject test (each reads a hostile path) | **KILLED** |
| M-length — drop the `>1024` bound | over-1024 reject | **KILLED** |
| **M-leading-slash (MED-1)** — drop the `charCodeAt(0)!==0x2f` check | relative `ticket.txt` reject (read now happens) | **KILLED** |
| M-backslash — drop `path.includes("\\")` | backslash reject | **KILLED** |
| M-control — drop the whole control/NUL/DEL-byte throw | control + NUL + DEL rejects | **KILLED** |
| M-empty-segment — drop the empty-segment check | `//x` + trailing-`/` + bare-root rejects | **KILLED** |
| M-traversal — drop the whole `.`/`..` check | `/a/../b` + `/a/./b` rejects | **KILLED** |
| **SUBARM-DEL** — drop ONLY `\|\| c === 0x7f` (arm granularity) | **DEL-byte reject** (added after the R3 review found this arm untested) | **KILLED** |
| SUBARM-CTRL — drop ONLY `c < 0x20` | control + NUL rejects | **KILLED** |
| SUBARM-DOT — drop ONLY `seg === "."` | `/a/./b` reject | **KILLED** |
| SUBARM-DOTDOT — drop ONLY `seg === ".."` | `/a/../b` reject | **KILLED** |

No survivors (11/11 killed). The arm-granularity mutants (SUBARM-*) honour this program's E7-1 lesson — *"mutate each ARM, not just the clause."* SUBARM-DEL **survived** in the first pass (no test used a `0x7f` byte); the R3 reviewer caught it, the DEL-byte reject case was added, and it is now killed. (Harness: `scripts`-external, re-runnable; asserts each anchor is unique and restores the file in a `finally`.)

## 4. Part 2 — SPLIT to WRK-017 (Step 0 found no enrol flow; adding one is LARGE)

Per WRK-015-design §3 Step 0 / §4 / §8 Q1, Part 2 required confirming the d1 harness can ENROL a worker.
A source-cited investigation found it **cannot**, and adding it is **LARGE**. Evidence (all re-verified at tip):

- **No d1 test boots a real worker-daemon enrol.** The harness header (`tests/d1/lib/e6f-harness.mjs`) says
  outright: "There is NO live worker-daemon loop: enroll/poll/ack are ordinary authenticated HTTP calls the
  harness makes itself." Both containers boot `AOA_WORKER_KEY_STORE_MODE: mounted_secret` and idle as
  `docker exec` network vantage points; `/enrollment-code` is "only the SOURCE at load (not read)" and no
  volume mounts it (`docker-compose.d1.yml`).
- **Target registration is org-scope only, fresh-UUID, via superuser SQL, AFTER `up`.** `seedScenario`
  inserts `execution_targets` with `scope='organization'` and `targetId = uuid()` — never the container
  profile ids. There is **no platform-scope seed**.
- **`worker-a` is `platform` scope** (`docker/d1/worker-a.profile.json`; compose `AOA_WORKER_TARGET_SCOPE:
  "platform"`). The platform mint path `issuePlatformCode` (`server/src/services/worker-enrollment.ts`) runs
  on the **operator DB** via a distinct authority repo (`acquirePlatformTargetAuthorityExclusive` /
  `retireBootstrapCredential`) never exercised by the org-scope harness, and has **no HTTP route** (only
  `issueTenantCode` does, and it needs a board session the d1 harness cannot obtain). No test-only
  mint/register route exists (only `_test/reap`).
- **No ticket-file delivery mechanism** into the container (no `docker cp`, init container, volume, or
  ticket-encoder helper).
- **A first-boot enrol failure is terminal for `up --wait`** — the workers have no `restart:` policy, and a
  `file_record` enrol failure that isn't the narrow already-had-identity network case calls `proc.exit(1)`
  (`bin/worker-daemon.ts`). Seeding runs only via `docker compose exec` AFTER the stack is up, so a single
  `up --wait` cannot both seed and enrol.

Concrete work WRK-017 must land (a–g), verbatim in `WRK-017-design.md`: (a) DONE = Part 1; (b) compose
switch + Dockerfile `container-host.js` guard; (c) a NEW platform-scope target seed; (d) a bound code +
operator-side routes/codes; (e) a NEW ticket-file delivery; (f) resolve the seed-vs-enrol ordering
(migrate-time seed or phased bring-up) under the 10-min code TTL; (g) the persisted-identity assertion +
`worker-b` control. This is not "reuse existing harness functions" — it is a never-existed platform seed + a
new file-delivery mechanism + a bring-up restructure, with the daemon hard-crashing `up --wait` on imperfect
ordering. **This squarely meets the design's STOP-and-split gate.** The staging `worker-canary` remains
DEFERRED to campaign time (design §9) — untouched here.

## 5. Registers (all green at tip)

```
check-worker-daemon-boundary   : PASS (POSIX fix adds NO import; process.platform is a global, NodeJS.Platform a type)
check-ticket-graph-coverage    : OK (103 ticket ids from files, all present among 117 graph nodes; WRK-017 seen)
check-dependency-graph         : OK (0 dangling, 0 cycles; WRK-017 → WRK-015 clean; 3 pre-existing CM-* declared gaps)
check-finding-ownership        : OK (WRK-015 filed NO finding; WRK-017 owns none)
check-guard-inventory          : OK (40 — no new check-*.mjs)
check-gate-clause-wiring       : OK (5 wired / 9 dormant — WRK-015 flips NO clause; enrol-not-dispatch)
check-execution-census         : OK (unchanged — I added no *.test.mjs)
check-test-inventory           : OK (NO pin bump — I added NO new *.test.ts, only modified the existing file)
check-boot-roots-provider-free : OK (3 boot roots; the container-host.ts comment edit adds no provider)
check-image-deps-stages        : PASS
dockerfile-static.test.mjs     : 25/0 pass (Dockerfile untouched — Part 2 split)
brand-check                    : clean (no new process.env.AOA_* literal in code; no Paperclip regression)
```

**Guard note (honouring the WRK-014 missed-guard lesson):** `check-test-inventory` needed **NO** bump —
unlike WRK-014 (which added 2 new `*.test.ts`), Part 1 only MODIFIED the existing `enrollment-input.test.ts`,
so the `worker-daemon` file count is unchanged. `check-boot-roots-provider-free` stays green because the
`container-host.ts` change is comment-only (no new source boot root; no provider construction). The
d1/Dockerfile/staging guards are green because Part 2 (which would touch them) is split out — Part 1 changes
none of those files.

## 6. Claims I could NOT prove here (owed downstream, stated plainly)

- **A real container actually enrolling on the POSIX path in CI.** That is exactly WRK-017 (Part 2). The unit
  tests prove the validator accepts/rejects the right shapes and preserves the security properties with an
  injected reader; no live daemon reads a real POSIX ticket file against a real control plane here.
- **Symlink / device-file / network-mount behavior.** Deliberately OUT of scope (honest Windows parity, §2).
  A real container using a symlinked ticket path is accepted syntactically; the inert-read + single-use-code
  mitigations carry it. Closing symlink TOCTOU would need `O_NOFOLLOW` at the reader seam (design LOW-1), a
  future ticket.
- **The unbounded read** (`/dev/zero`/FIFO) is an availability residual on BOTH arms, not new in kind
  (design LOW-1). Not hardened here.

## 7. Adversarial review — independent reviewers per dimension + a refutation skeptic

Five read-only subagents, one per dimension changed, each told to attack from SOURCE (run the tests, the
guards, the mutation harness themselves); plus a skeptic charged to REFUTE each claim and default to refuted
if it could not reproduce it.

| Reviewer | Verdict | Findings |
|---|---|---|
| Security (the 3 properties, inert-read, invariant) | **0 HIGH / 0 MED** | All 3 DSK-001 properties CONFIRMED preserved on the POSIX arm (reject-before-read; content-free faults; `enrollmentCode` redaction name); inert-read traced end to end (`raw` → the strict content-free codec; the credential is never logged); the `EnrollmentCodeSource` operator-sourced invariant verified real + held today. 3 LOW, all design-disclosed (below). |
| Correctness (the POSIX arm logic) | **0 findings** | Accept/reject exactness verified across every edge (`/`, `/a/`, `//`, `/a/./b`, `/a/../b`, `/worker/ticket.txt`, `/worker/file..name`, unicode, bare root); the MED-1 leading-`/` fix closes the hole with safe ordering; the diff vs the FROZEN mirror is correct (both substitutions justified; the omitted lower-bound subsumed); threading keeps `bin:321` a valid 3-arg call; the win32 arm is byte-equivalent. |
| Test / mutation rigor | **1 MED (FIXED) + 3 LOW** | Re-ran the harness (7/7 killed, restored); win32-pinning CORRECT + NECESSARY; accept test a genuine round-trip; message-only content-free scan legitimate. **MED FIXED** (below). LOWs handled below. |
| Scope / tracking + Step 0 | **1 MED (FIXED) + 1 LOW (folded)** | Split JUSTIFIED at HIGH confidence (4/4 Step-0 claims re-verified at source; "M–L" honest; the easy migrate-time path was considered, not missed); WRK-017 filed correctly (graph guards pass, node matches precedent, owns no finding); zero scope creep. **MED FIXED** + **LOW folded** (below). |
| Skeptic (refute all 9 claims) | **0 REFUTED** | All 9 UPHELD, reproduced from source: 7/7 mutants killed + `git hash-object` proving the source is unmodified after the run; the 3 properties; `bin:321` 3-arg; inert read; win32 behaviour byte-unchanged; the split's largeness; boundary/suite/tsc green; brand-check clean; graph guards pass. |

**What I FIXED (survived review):**
- **MED (test rigor) — the control-byte clause's `0x7f` (DEL) OR-arm was untested.** `M-control` deletes the
  whole `c < 0x20 || c === 0x7f` clause and is killed by the `< 0x20` cases, but dropping ONLY `|| c === 0x7f`
  SURVIVED — the exact failure mode of this program's E7-1 lesson ("mutate each ARM, not just the clause").
  Fixed: added a **DEL-byte reject case** + four **arm-granularity mutants** (SUBARM-DEL/CTRL/DOT/DOTDOT) to
  the sweep. Now **11/11 killed**, SUBARM-DEL among them.
- **MED (tracking) — the stale-claim sweep was incomplete.** I had corrected the "WRK-015 activates the
  container path / CMD repoint" wording in the primary prose but left it in the GO-BOOK critical-path table
  (`:210`, a self-contradiction with the same file's §1.5), the reconciled-chain closing summary (`:235-236`),
  `worker-daemon.ts:284`, and `container-host.test.ts:12` (which re-asserted the debunked CMD-repoint). All
  corrected to "WRK-015 shipped the POSIX validator; WRK-017 wires the container path via a compose
  `command:` override (Correction 1)". The two now-false "Windows-only" claims in the WRK-014 **design** doc
  (`:49`, `:192`) got a minimal dated correction; WRK-014's shipped **result** doc is left as a point-in-time
  record (its §5 already forward-points correctly).
- **LOW (test rigor) — the no-echo twin reached only the codec's version check.** Strengthened one linux twin
  to `v:1` + a malformed code so it reaches the **code-shape branch** (the only branch that inspects the
  credential). Also added the **1024-accept boundary** test (pins the off-by-one against the over-1024 reject).
- **LOW (tracking, folded) — the cheaper enrol lever for WRK-017 is org-scope `worker-b`, not platform
  `worker-a`** (it reuses the harness's existing org seed + `issueTenantCode` and avoids the operator-DB
  platform-authority path). Folded into `WRK-017-design.md` (§c + OQ#3).

**What I KILLED / accepted (with reasons):**
- **LOW (security ×3) — all design-disclosed residuals.** The unbounded/device read (`/dev/zero`/FIFO) is an
  availability residual on BOTH arms (design LOW-1, §6); the "invariant is convention, not code" point is the
  design's MED-2, stated in the code comment; the win32-lexical-block vs POSIX-no-lexical-form asymmetry is
  immaterial (both keep device/off-machine residuals; it only bites if the operator-sourced invariant is
  already broken, in which case both arms are a full read primitive). No change — these are honest parity.
- **LOW (test rigor) — the default-`platform` resolution is unit-untested.** Inherent to the DI design
  (mirrors `file-custody.ts`); a mutant hardcoding `="win32"` would pass the unit suite. It is
  integration-covered by the 3-arg `bin:321` call on a real Linux container — i.e. WRK-017. Accepted.
- **LOW (test rigor) — the shared `path.length === 0` guard is non-load-bearing.** It predates this change; an
  empty string is re-caught by the leading-`/` (POSIX) / drive-letter (win32) checks. Kept as a
  message-clarity defensive guard (a WRK-014-style "documented equivalent"), not removed (out of scope).

No HIGH/BLOCKING finding survived; the two MEDs are fixed and (for the DEL arm) mutation-proven; every LOW is
a documented, design-consistent accept or a folded improvement.
