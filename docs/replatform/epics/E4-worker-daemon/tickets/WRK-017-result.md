# WRK-017 — result: a real worker container ENROLS on d1 (and the lane that would prove it was red)

**Epic:** E4 · **Status:** BUILT · **Design (Start SHA):** `203853b3a`
**Terrain of record:** `WAVE-4-RESEQUENCE.md` §3.2 · `SPIKE-worker-walking-skeleton.md` F5
**Depends on:** WRK-014 (container identity) · WRK-015 Part 1 (POSIX enrolment input)

---

## 0. Outcome in one paragraph

`worker-b` in `docker-compose.d1.yml` now boots the **container custody root**
(`dist/bin/container-host.js`, via a compose `command:` override — never an image-CMD repoint),
reads a POSIX enrolment ticket from a read-only mount, and **enrols against the live control plane**,
persisting a `DeviceIdentityRecord` + receipt to its own named volume. `worker-a` stays
`mounted_secret` as the negative control. The authority it enrols against is seeded by the
**privileged migrate job** — the only place early enough, because a first-boot enrol failure is
`proc.exit(1)` with no `restart:` policy, which fails `up --wait` outright. That makes the enrol
**load-bearing for bring-up in every campaign scope**, not merely asserted by a test. Before any of
that could be true, WRK-017 had to fix something it did not expect: **the D1 merge-train lane had
been red for five days and three merges** — the control-plane image could not build at all — and the
D1 control plane's hostname allowlist would have answered **403** to every request a real worker
made. Both are filed (E6-F010, E6-F011) and both are fixed here.

## 1. Step 0 — the lane this ticket was supposed to be "CI-exercised" by was RED

The ticket's premise is a *CI-exercised* enrol, so the first thing measured was whether the lane
runs. It did not.

| run | sha | verdict |
|---|---|---|
| 2026-08-31 | `b6e02a478` | **failure** |
| 2026-08-30 | `07ed2cc42` | **failure** |
| 2026-08-29 | `c3d26657d` | **failure** |
| 2026-08-25 | `50380b6f7` | success (the last one) |

All three fail in *Build split D1 images*, identically, and the failure reproduces **byte-for-byte
on a local Docker Desktop against the unmodified tip**:

```
packages/sandbox-fake-provider build: src/hash.ts(11,28): error TS2307: Cannot find module 'node:crypto'
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @armyofagents/sandbox-fake-provider@0.1.0 build: `tsc`
ERROR: process "/bin/sh -c pnpm --filter \"@armyofagents/server...\" --filter \"@armyofagents/ui...\" build" ... exit code: 2
```

**Root cause (E6-F010): a green guard defined on a different set.** The control-plane `deps` stage
COPYs `server`'s **production** manifest closure, and `check-image-deps-stages.mjs` enforces that
COPY set exactly — its `computeRuntimeClosure` walks `.dependencies` alone, deliberately, to mirror
`--filter-prod`. The `build` stage runs `pnpm --filter "@armyofagents/server..." build`, and `pkg...`
traverses **devDependencies too**. DEP-011 Slice 1 (`c3d26657d`) gave `server` a workspace
**devDependency** on `@armyofagents/adapter-manager`, whose graph reaches
`provider-wire → sandbox-e2b-provider → sandbox-provider-contract → (devDep) sandbox-fake-provider`.
Five packages the deps stage never installed entered the build selection. The parity guard stays
**PASS** throughout, correctly — the manifest it guards is still right.

**Why it went unnoticed for three merges:** `d1-merge-train` is not a required check (branch
protection requires only `ci-required`, from `pr.yml`) and it runs on `push` to the integration
branch, i.e. after merge. A red nobody is waiting on is operationally the same as a check that does
not run.

**Fixed** with the mechanism the WORKER Dockerfile already uses for the identical reason (its "8th
manifest" note): re-install in the build stage against the manifest set that stage actually has
after `COPY . .`. Verified locally — both images build, `digests.env` populated. Explicitly NOT
fixed with `--filter-prod` on the build line: `provider-capability`'s only edge to `worker-daemon`
is a devDependency, and that edge is what yields the correct topological order.

## 2. The second thing that would have failed: `Host: toxiproxy`

Traced before the first bring-up (E6-F011). `AOA_WORKER_CONTROL_PLANE_URL` is
`http://toxiproxy:13100` — routing that is itself a load-bearing invariant (`checkToxiproxyInPath`),
so it cannot be "fixed" on the worker side. A worker's HTTP `Host` is therefore literally
`toxiproxy:13100`; `privateHostnameGuard` is enabled on this stack (`authenticated` +
the image default `AOA_DEPLOYMENT_EXPOSURE=private`); `/api/worker-control/*` does not bypass it.
Every enrol from a real worker would have been **403**.

The compose comment claimed the opposite — *"the workers reach the control plane by its in-compose
service name"* — and it was true of the only client that existed: the E6F harness dials
`http://control-plane:3100` from `test-runner`, which was allowlisted all along. Fixed by adding
`toxiproxy` to `AOA_ALLOWED_HOSTNAMES` on both replicas. No product code changed; the guard behaved
exactly as designed.

## 3. The decisions this ticket had to make (the design's open questions)

| OQ | Answer | Why |
|---|---|---|
| **#3 which worker** | **`worker-b`, org scope** | The design's own cheaper-lever note (§c), and two more reasons: the org enrol path is already live-proven end to end by `e6f-03`, while the platform authority repo (`acquirePlatformTargetAuthorityExclusive` / `retireBootstrapCredential`) has never executed; and org scope needs no operator-DB authority rows, so #1 does not arise. `worker-a` stays the control. |
| **#2 ticket delivery** | **A committed fixture**, bind-mounted `:ro` into BOTH the migrate job and the worker | ONE artifact read twice. The migrate job DECODES it to learn which code to authorize; the worker presents it. No runtime hand-off, no shared writable volume, and — the deciding point — the whole coupling becomes checkable **before merge**, which the live lane cannot be. |
| **#1 operator-DB platform authority** | **Moot** | Consequence of #3. |
| **(f) ordering** | **Migrate-time seed** | The design's preference, and no merge-train restructure. `migrate` is a run-to-completion service holding the OWNER DSN on data-net that every other service gates on. |
| **TTL** | Seeded at **120 min** (explicit input) | The seed runs at migrate time; the worker enrols after the control plane has built, booted and gone healthy. Racing the product's 10-minute TTL would make the lane flaky and prove nothing extra — expiry is a server property with its own coverage. |

## 4. What shipped

| # | Deliverable | File | Kind |
|---|---|---|---|
| 1 | **The lane fix (E6-F010).** Build-stage `pnpm install` against the post-`COPY . .` manifest set, with the trap recorded. | `docker/control-plane/Dockerfile` | MOD |
| 2 | **The allowlist fix (E6-F011).** `toxiproxy` added to `AOA_ALLOWED_HOSTNAMES` on both replicas. | `docker-compose.d1.yml` | MOD |
| 3 | **The enrolment seed.** Decodes the committed ticket, registers the target ACTIVE with a ratified `registered_profile` + hash + `provider_constraint_profile`, and authorizes the code's two hashes. Idempotent. | `docker/control-plane/seed-d1-worker-enrolment.mjs` | NEW |
| 4 | Seed invoked as migrate step **1c**, gated on `AOA_D1_SEED_WORKER_ENROLMENT=1` — the same strict shape `provision-d1-serving-roles.mjs` uses. | `docker/control-plane/migrate-entrypoint.sh` + `Dockerfile` | MOD |
| 5 | **The committed ticket** `aoa_tkt_<base64url({v,targetId,code})>`, LF-pinned. | `docker/d1/worker-b.enrollment-ticket`, `.gitattributes` | NEW |
| 6 | **worker-b becomes the enroller** — `file_record`, `AOA_WORKER_STATE_DIR: /worker`, the `command:` override, the ticket `:ro` mount. `worker-a` untouched. | `docker-compose.d1.yml` | MOD |
| 7 | **Build guards** for `container-host.js` on BOTH the build tree and the deploy tree (a `command:` naming an absent file is not a build failure — it is an unhealthy service with no hint). | `docker/worker/Dockerfile` | MOD |
| 8 | **`checkWorkerCustodyBootRoot`** — custody mode ⇄ boot root as an EQUIVALENCE, plus a ticket mount that exists and is `:ro`, plus a state dir on a writable named volume. | `scripts/lib/d1-compose-invariants.mjs` | MOD |
| 9 | **`checkEnrolmentSeedWiring`** — an enrolling worker implies migrate seeds, seeding implies an enrolling worker, and both must name the SAME committed ticket. | same | MOD |
| 10 | 12 corpus cases for 8+9, incl. an anti-vacuity enrolling baseline. | `scripts/check-d1-compose.test.mjs` | MOD |
| 11 | **The pre-merge guard** — the ticket decodes, names the profile's target, matches the SERVER's own `parseCode` regex, and the seed's mirror of the daemon's codec has not drifted. 22 cases. | `docker/d1/__tests__/enrolment-seed.test.mjs` | NEW |
| 12 | **The live assertions** — identity+receipt on the volume, one enrolled `workers` row, the code consumed once, worker-a holding nothing, and a restart that short-circuits. | `tests/d1/container-enrol.test.mjs` | NEW |
| 13 | The dispatch declaration: `worker-b.keyStoreMode` → `file_record`, with what that does and does NOT change. | `scripts/d1-dispatch-expectation.json` | MOD |
| 14 | Wiring: pr.yml step, execution census, docker test-inventory pin, BOUNDED set, campaign bump, env-var docs. | 6 files | MOD |

## 5. The one thing to understand about the compose change

**`AOA_WORKER_KEY_STORE_MODE: file_record` and `command: ["node","dist/bin/container-host.js"]` are
one change with two halves, and either half alone is a crash loop.** `resolveCustody` refuses
`file_record` with no stores injected (the daemon bin injects none) and refuses `mounted_secret`
WITH stores (`runContainerHost` injects them unconditionally) — both pre-socket, both `exit 1`,
both reported by `up --wait` only as "an unhealthy service". The halves live in different compose
keys and are trivially separable in a rebase or a partial revert, so the coupling is a static
invariant (`checkWorkerCustodyBootRoot`) stated as an **equivalence** in both directions. A
one-directional check would stay green through the other crash loop — which is precisely the one an
image-CMD-repoint instinct produces, and precisely what WRK-014's own header warns about.

## 6. Evidence — every claim, and how it was measured

### 6.1 Mutation sweep (each guard made to FAIL on purpose, then restored)

**Against the REAL `docker-compose.d1.yml`** (`node scripts/check-d1-compose.mjs`):

| Mutant | Killed by |
|---|---|
| delete worker-b's `command:` | `declares 'AOA_WORKER_KEY_STORE_MODE: file_record' but does not enter the container-host bin` |
| custody back to `mounted_secret` | `enters the container-host bin but declares ... mounted_secret` |
| delete the worker's ticket `:ro` mount | `names 'AOA_WORKER_ENROLLMENT_CODE_FILE: /enrollment-code' but mounts nothing at that path` |
| delete migrate's `AOA_D1_SEED_WORKER_ENROLMENT` | `'migrate' does not set 'AOA_D1_SEED_WORKER_ENROLMENT: 1'` |
| delete `AOA_WORKER_STATE_DIR` | `is file_record but declares no 'AOA_WORKER_STATE_DIR'` |

**5/5 killed**, source restored.

**Against the dispatch declaration** (`node scripts/check-d1-dispatch-declared.mjs`): flipping the
declared `worker-b.keyStoreMode` back to `mounted_secret` → `FAILED … = "file_record", but is
declared "mounted_secret"`, exit 1. **Killed.**

**Against the cross-file pins** (`node --test docker/d1/__tests__/enrolment-seed.test.mjs`), each
mutating a DIFFERENT file so the pin is proven to reach across the boundary it claims to:

| Mutant | File mutated | Killed by |
|---|---|---|
| ticket prefix `aoa_tkt_` → `aoa_tk2_` | `packages/worker-daemon/.../ticket.ts` | *the seed's ticket-codec constants still match the daemon's* |
| exhaustive key set gains a 4th key | same | same test |
| `parseCode` locator bound `{16,64}` → `{20,64}` | `server/src/services/worker-enrollment.ts` | *the committed ticket's code matches the SERVER's own parseCode regex* |
| ticket rewritten for a different targetId | `docker/d1/worker-b.enrollment-ticket` | *the committed ticket decodes and names the worker's own target* |
| seed hashes the SECRET half as the locator | `docker/control-plane/seed-d1-worker-enrolment.mjs` | *hashEnrollmentCode splits and hashes EXACTLY as the server's parseCode does* |

**5/5 killed**, all sources restored, control run afterwards `fail 0`.

### 6.2 Suites

```
node --test scripts/check-d1-compose.test.mjs          60 pass / 0 fail   (was 48)
node --test docker/d1/__tests__/enrolment-seed.test.mjs 22 pass / 0 fail   (new)
node scripts/check-d1-compose.mjs                       OK
node scripts/check-d1-dispatch-declared.mjs             OK
node scripts/check-image-deps-stages.mjs                PASS
node scripts/check-execution-census.mjs                 OK (55 files; +1 declared running)
node scripts/check-test-inventory.mjs                   OK (docker pin 4 → 5, hand-edited: `--write` also raises unrelated FLOOR counts, which are not this ticket's to move)
node scripts/check-guard-inventory.mjs                  OK (41; no new check-*.mjs)
node scripts/check-finding-ownership.mjs                OK (17 open; both new findings are `resolved`, which needs no ownership entry)
```

### 6.3 The image assertions (measured on a built image, not asserted in a comment)

`docker run --entrypoint node <worker image> -e "readdirSync('/worker-app/dist/bin')"` →
`container-host.js` present alongside `worker-daemon.js`. The Dockerfile guards were then added so a
future build that drops it fails at BUILD time rather than at container start.

### 6.4 The live bring-up

**A real container enrolled.** Docker Desktop 29.2.1 / Compose v5.0.2, Windows host, Linux
containers; images built by `docker/images/build.sh` from this branch; full
`docker compose -f docker-compose.d1.yml up -d --wait`. Every service reached healthy —
`UP_EC=0` — including `worker-b`.

`migrate` (the seed ran, in order, inside the privileged job):

```
migrate-job: [D1 harness] provisioning aoa_app / aoa_operator LOGIN
provision-d1-serving-roles: granted LOGIN to aoa_app + aoa_operator
migrate-job: [D1 harness] seeding the worker enrolment target + code
seed-d1-worker-enrolment: target 22222222-2222-4222-8222-222222222222 (organization) registered ACTIVE; single-use enrolment code authorized for 120m
migrate-job: complete
```

`worker-b` (the enrolling worker — note `keyStoreMode:"file_record"`):

```
{"workerVersion":"0.1.0","keyStoreMode":"file_record","targetScope":"organization","msg":"worker-daemon starting"}
{"workerId":"e441091f-…","targetId":"22222222-2222-4222-8222-222222222222","deviceGeneration":1,
 "deviceThumbprint":"964a3a75…","msg":"worker-daemon enrolled"}
{"reason":"no_provider","msg":"worker-daemon: no sandbox provider injected; this build cannot dispatch work"}
```

`worker-a` (the control) logged `keyStoreMode:"mounted_secret"` and **no enrolment line at all**.

On `worker-b`'s volume, `/worker` contains `identity.json`, `receipt.json`, `tmp` — and the two
records agree, with the key present under the redactor-visible field name:

```
receipt : {"v":1,"workerId":"e441091f-…","targetId":"2222…","deviceGeneration":1,"deviceThumbprint":"964a3a75…"}
identity: {"v":1,"workerId":"e441091f-…","targetId":"2222…","deviceGeneration":1,"privateKeyPkcs8B64":"<64 b64 chars>"}
```

`AOA_D1_LIVE=1 node --test tests/d1/container-enrol.test.mjs` → **6 pass / 0 fail**, twice (once on
the first bring-up, once after the positive controls below).

**Positive controls — the lane was made RED on purpose, twice.** A green bring-up is not evidence
that the enrol is load-bearing unless breaking it is shown to break the lane:

| control | change | result |
|---|---|---|
| **PC-1** | revert the E6-F011 fix (`toxiproxy` out of `AOA_ALLOWED_HOSTNAMES`) | `worker-b` **Exited (1)**, `UP_EC=1`. Log: `EnrollmentAuthorityError … caused by: EnrollmentError: unexpected enrollment status 403`. **The 403 is measured, not inferred** — and this is what every real worker request would have met before this ticket. |
| **PC-2** | delete `AOA_D1_SEED_WORKER_ENROLMENT` from `migrate` | `worker-b` **Exited (1)**, `UP_EC=1`. Log: `EnrollmentError: enrollment unauthorized`. The migrate-time seed is genuinely what authorizes the enrol. |
| **restore** | the shipped compose | `UP_EC=0`, both workers healthy, `worker-daemon enrolled`, 6/6 live assertions pass. |

Both controls confirm the structural claim this ticket rests on: **a failed enrol takes the whole
bring-up down (`up --wait` → exit 1) in every campaign scope**, before any test runs. That, not
`container-enrol.test.mjs`, is the primary gate.

★ One honest caveat about the harness, not the product: when `AOA_D1_LIVE=1` is set with **no stack
up**, `container-enrol.test.mjs` FAILS rather than skips. That is deliberate and was observed (the
first bring-up attempt mis-set the compose image vars, and the suite went red with `no result from
worker-b`). Without `AOA_D1_LIVE` it skips cleanly, exactly like the other D1 suites.

## 7. What I could NOT establish

- **A green D1 merge-train run on this change.** The lane fires on `push` to
  `docs/replatform-program` and on `merge_group` — **not on pull requests**. So no PR, including
  this one, can carry a verdict from it; the run happens after the orchestrator merges. That is a
  property of the lane, not of this ticket, and it is why §6.1's pre-merge guards were built at all.
  ★ It also means the FIRST honest verdict this lane produces since 2026-08-25 will be the run
  triggered by this merge. If it is red, read §1 before assuming WRK-017 caused it.
- **`capabilityProven`.** Nothing here touches it (that is CLI-008 Unit F). A green enrol proves
  custody and the enrolment mechanism; it proves nothing about dispatch, which stays refused by
  gates 1 and 4 exactly as declared.
- **The platform-scope enrol path.** `issuePlatformCode`,
  `acquirePlatformTargetAuthorityExclusive` and `retireBootstrapCredential` remain unexercised by
  any live lane — the design's higher-fidelity option, deliberately not taken (§3).
- **That the deps-stage class is closed.** It is not. Any future workspace **devDependency** on
  `server`/`ui` widens the build selection again; the re-install absorbs it, but nothing warns when
  the prod and dev closures diverge, and no PR-time check builds either image. Named in E6-F010's
  residual.
- **Build-time cost.** The build-stage re-install resolves ~1000 packages on a cold layer. Measured
  locally as tolerable; not measured on a GitHub runner.

## 8. The mistake CI caught, and what came out of it

The first PR run failed `policy` with `ERR_MODULE_NOT_FOUND` on
`docker/control-plane/seed-d1-worker-enrolment.mjs`. **`.gitignore` carries an unanchored
`seed-*.mjs`** (a scratch-script convention, alongside `check-*.mjs`, which is negated for
`scripts/`) and it had silently swallowed the seed — a real, shipped file the control-plane image
COPYs and the migrate job runs.

Nothing local could have noticed, and the reason is the interesting part: **the Docker build
context obeys `.dockerignore`, not `.gitignore`**, so the image built and the entire live enrol —
including both positive controls — ran green on a working tree that HAD the file. `git status`
showed nothing, because the file was ignored rather than untracked. Every measurement in §6 was
true of the code; none of it was true of the commit.

The guard that caught it was the pre-merge one this ticket added, which is the argument for having
built it. What came out of it:

1. `!docker/**/seed-*.mjs` — un-ignore the whole `docker/` tree rather than one path, so the next
   such file is not caught by the same rule.
2. A new `dockerfile-static.test.mjs` clause: **every local path a split Dockerfile COPYs must
   exist on disk AND be tracked by git.** It asks `git ls-files --error-unmatch`, not
   `git check-ignore` — check-ignore SKIPS already-tracked paths, so it answers "not ignored" for
   a force-added file and stops biting the moment the mistake is half-fixed. Outside a checkout it
   FAILS rather than skips. Proven by mutation (untrack the file; point a COPY at a nonexistent
   one) and anti-vacuous (the parser must find ≥5 COPYed files).

Verified afterwards by `git clone`-ing the branch into a clean directory: the seed is present and
110/110 of the three static suites pass there.

## 9. The second thing CI caught: a test that PARSES the compose

`verify (4)` failed on `packages/worker-daemon/src/__tests__/shipped-binary-refuses.test.ts`
(WRK-008 slice 2b Step 8a). It reads `docker-compose.d1.yml` **for real** — deliberately, so its
assertions cannot be fixtures asserting themselves — and it asserted that **both** D1 workers are
`mounted_secret`. Changing worker-b broke two of its cases. Correct behaviour by the test; my miss.

`node scripts/ci-local.mjs` (the standing local gate) runs policy, lint, brand-check and
contract-bytes — **not `verify`**, i.e. not the vitest shards. The standing rule "`tsc -p server`
does not cover `server/src/__tests__`; run the actual suite" applies to `packages/*` too, and I ran
only the D1 static suites. Recorded so the next builder does not repeat it.

The update **strengthens** the test rather than relaxing it:

- The anti-fixture case now asserts the two workers carry **DIFFERENT** custody modes
  (`worker-a` `mounted_secret`, `worker-b` `file_record`) plus dispatch-off for both. A hardcoded
  parser cannot satisfy two different values with one constant, so this is a sharper anti-hardcode
  property than "both are the same string" ever was.
- The shared `it.each` is split, because worker-b's env now has two genuinely different outcomes,
  and both are worth pinning **in the daemon**, where the refusal happens:
  - **under the DAEMON bin** (the state a partial revert produces: `file_record` in `environment:`
    with the `command:` override gone) — refuses at CUSTODY, pre-socket, `exit 1`, with the exact
    reason string. This is the daemon-side proof of the crash loop that
    `checkWorkerCustodyBootRoot` forbids statically.
  - **WITH the container host's stores** (what `runContainerHost` composes) — gets past custody and
    refuses with EXACTLY `no_provider`. Without this arm, "worker-b never dispatches" would rest on
    a custody refusal rather than on the dispatch gate, which is a different claim.

Mutation-proven: reverting worker-b to `mounted_secret` in the real compose reddens **3 of the 8**
cases; restored, 8/8 pass. Full `packages/worker-daemon` suite: **950 passed / 1 skipped / 149
files**.
