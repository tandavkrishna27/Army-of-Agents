# E6 Deployment / test harness — findings

Scoped discoveries and plan-review deltas for the E6-D1-FOUNDATION partial. Source:
Batch A adversarial plan-review (2026-08-12).

## E6-F001 — DEP-001 package path corrected — RESOLVED

**Status:** `resolved` (plan text fixed). The worker package is
`packages/worker-daemon` (`@armyofagents/worker-daemon`), not `packages/worker`.
All DEP-001 image `COPY` targets and the deps-parity validator reference it.

## E6-F002 — DEP-001 worker-image dependency closure corrected — RESOLVED

**Status:** `resolved` (plan text fixed). Per **E4-D01** the worker image closure
is exactly `worker-daemon` + `worker-protocol` + the `pino` runtime dep (zod
transitive); no `adapter-utils`; no server/db/shared/drizzle.

## E6-F003 — the networked worker→provider driver API is unspecified

**Status:** `open` · Severity: HIGH (cross-plan seam; mirrors E4-F002).

★ NARROWED and DEFERRED by DEP-010 (Sprint 2); DEP-010 does not build the wire and
does not pretend to. See `DEP-010-design.md` §2.1.

**What DEP-010 answered.** *Which port* a networked worker→provider driver speaks: the
per-op `SandboxProvider` (`packages/worker-daemon/src/supervisor/provider.ts`),
transport-agnostic by construction, named THE authoritative port by decision D1. The
networked driver is a **binding of that port**, not a third port — which removes the
entanglement with E6-F008/E6-F004 that once made all three look like one question. Those
two are resolved; this one is not.

**What is still open.** The wire itself — the request/response shapes a containerized
worker's provider driver speaks to `adapter-manager`. No transport, no schema, no client.
DEP-010 wires the **desktop/self-hosted lane only**.

**★ Which network, stated correctly — the register carries this sentence, so a wrong name
would be a durable false statement no guard can contradict.** In
`docker-compose.staging.yml` the worker↔adapter-manager conversation is on **`control-net`**:
workers are `[control-net, store-egress-net]`, `adapter-manager` is
`[control-net, provider-ctl-net]` (`scripts/lib/staging-manifest-invariants.mjs`,
`checkWorkerServiceNetworks`). **`provider-ctl-net` is adapter-manager-only** — the
adapter-manager→E2B leg — and a worker attached to it is a hard `PROVIDER-CONTROL
VIOLATION`. ★ The name is OVERLOADED across two compose files: in
`docker-compose.d1.yml` both D1 workers ARE on `provider-ctl-net` (its topology matrix says
so), because D1's fake provider is a container the workers reach directly. Both files are
correct for their own topology; the name is not portable between them.

**Precondition (when this becomes REQUIRED).** The moment a containerized worker under
`docker-compose.staging.yml` must dispatch: §2.5 forbids `E2B_API_KEY` on any worker
surface, so that worker's provider cannot be key-backed and MUST be networked, reaching
`adapter-manager` over `control-net`. There is no consumer today — `adapter-manager` has
**zero implementation** (`DECISION-byte-egress-and-provider-topology.md` §4 residual 4.2)
and no worker dispatches (flag default-off, no `compose:true` branch) — so specifying a wire
against an unimplemented peer for an unbuilt caller is the failure this programme keeps
re-learning. Deferring is correct, not convenient.

**Resolution owner:** filed to a successor at DEP-010 completion (`DEP-011`, the containerized
worker→provider wire) rather than left `owned` by the shipped DEP-010 — an open finding owned
by shipped work reads as owned by nobody (finding **E4-F013**). DEP-010 repoints the manifest
`ticket`, not merely the prose (`DEP-010-design.md` §2.1).

## E6-F004 — DEP-000 provider-driver port import source — RESOLVED

**Status:** `resolved` (DEP-010, Sprint 2) · Severity: MED-HIGH (mirrors E4-F003).

★ RESOLVED with the OPPOSITE answer to the one this finding proposed. The finding said the
fake should import the port from `@armyofagents/worker-daemon` and the boundary should be
widened to ALLOW it. **Rejected.** DEP-010's decision D2 demotes the contract's
`SandboxProviderDriver` to a conformance-harness surface, and the DEP-000 fake
(`packages/sandbox-fake-provider`) already implements THAT harness port **structurally**
(`fake-driver.ts`) — so it needs no import from worker-daemon at all.
`scripts/lib/sandbox-fake-provider-boundary.mjs` therefore stays **exactly**
`["@armyofagents/worker-protocol","zod"]`: widening it would put the daemon's whole provider
surface inside a leaf whose entire point is that it has none. Proved mechanically by
`DEP-010-design.md` Step 9 positive controls 4a (a `worker-daemon` dep in the fake's manifest
fails `check-sandbox-fake-provider-boundary.mjs`) and 4b (an `import type` from worker-daemon
in `fake-driver.ts` is caught lexically) — against the fake's OWN guard, which is the guard
that actually reads the fake.

## E6-F005 — Gate control-plane path transitive deps (nit)

**Status:** `open` · note at **E6-D1-FOUNDATION gate** · Severity: LOW.

Gate closure requires TEN-002/JOB-003/WRK-004 (program-design L700). E6F-01/E6F-04
exercise submit→placement→enroll→lease→ACK, which transitively needs
JOB-001/JOB-002/JOB-009 `complete`. Add one line noting `JOB-003 complete`
transitively implies those via their dep chain so the campaign path is fully backed.

## E6-F006 — DEP-000 missing explicit REDs (nit)

**Status:** `open` · resolve at **DEP-000** · Severity: LOW. Acceptance names
"unschema-valid fixture rejected" and "unknown op rejected" but no dedicated RED
files exist. Add explicit REDs or fold-and-note.

## E6-F007 — DEP-003 RLS migration mechanism citation (nit)

**Status:** `open` · resolve at **DEP-003** · Severity: LOW. Cite the drizzle
`--custom` mechanism (E2-D01 precedent, product Decision #122/C14) for the RLS
marker migration; confirm both slugs (`distributed_cutover_marker` + `_rls`)
generate after `0231`.

## E6-F008 — DEP-000 contract port is provider-neutral, NOT WRK-004's authoritative `SandboxProvider` — RESOLVED

**Status:** `resolved` (DEP-010, Sprint 2) · Severity: MED (contravened a plan STOP; harness self-consistent). Source: DEP-000 adversarial review (CONFIRMED should-fix).

★ RESOLVED, one direction only. DEP-010's decision **D1** names ONE authoritative port —
worker-daemon's per-op `SandboxProvider` (`packages/worker-daemon/src/supervisor/provider.ts`),
the port the security core speaks and the only one the sole real implementation
(`E2bSandboxProvider`) implements. Decision **D2** states the contract's
`SandboxProviderDriver` is NOT retired and NOT authoritative: it is kept as the surface the two
conformance suites drive (`runSandboxProviderContract`, `runSandboxIsolationConformance`),
reached through the shipped adapter `perOpToInvokeDriver` (`per-op-adapter.ts`, header "CLOSES
finding E6-F008") that shipped in CLI-001. Direction is single and stated: **authoritative
per-op port → adapter → harness driver port**, never the reverse.

**★ Option (b)'s totality bar is SUPERSEDED in writing, not earned by a new test.** This
finding's resolution offered (a) relocate the port to a shared leaf, or (b) a tested
`SandboxProvider → SandboxProviderDriver` adapter *with a totality assertion over all 11 ops +
result shapes*. That bar was written when the adapter was **the** reconciliation. D1 changes
the frame: it demotes the driver port to a harness surface, so per-op coverage of that surface
is the two conformance suites' problem, not the port-authority question's — and the existing
`per-op-adapter.test.ts` already covers the vocabulary case-by-case (routing of the eight
core ops, `reconcile_cleanup`, and the optional trio through the advertisement gate). Naming
one authority is the reconciliation E6-F008 asked for; a `for (const op of PROVIDER_OPERATIONS)`
loop is not part of that decision. (`DEP-010-design.md` §2.2b.)

**★ What this resolution does NOT buy — recorded before the manifest entry is deleted.** The
bridge runs `per-op → driver` only; there is no `driver → per-op` adapter, so the DEP-000 fake
CANNOT stand in as the daemon's provider. The repository therefore keeps **two independent
provider doubles** — `packages/sandbox-fake-provider` for the conformance suites and
`packages/worker-daemon/src/__tests__/support/fake-provider.ts` for the supervisor — and the
DEP-000 harness never drives the daemon's supervisor. Building a `driver → per-op` adapter would
put a fabricating provider one import from a production path (the WRK-009 defect shape), so it is
deliberately NOT done here. Residual, `DEP-010-design.md` §8.9.

The original "reconcile before CLI-001/D2" schedule is moot: CLI-001 shipped, and this is the
composition-root decision the reconciliation was waiting on.

DEP-000's `@armyofagents/sandbox-provider-contract` defines a provider-neutral
`SandboxProviderDriver` (single `invoke(op, args)` over the frozen worker-protocol
`PROVIDER_OPERATIONS` vocabulary). This is **structurally unrelated** to WRK-004's authoritative
`SandboxProvider` (`packages/worker-daemon/src/supervisor/provider.ts`, a per-op method surface
exported per E4-F003). The DEP-000 boundary forbids importing `@armyofagents/worker-daemon`, so
the two ports cannot be mechanically linked as built.

**Why it happened:** the E6 plan has an internal tension — §2.1 wants DEP-000 provider-neutral
with deps limited to worker-protocol+zod+Node (no worker-daemon), while §0 (lines 66-74) STOPs on
"inventing a second provider-driver interface" as requiring an E4 amendment. The orchestrator
resolved toward §2.1 (provider-neutral) when directing DEP-000; the review flagged that this
improvised past the §0 STOP.

**Impact:** NONE on `E6-D1-FOUNDATION` — real-provider conformance is explicitly out of that
gate's scope (plan lines 37-38, 83, 102-103); the harness is internally consistent (deterministic
fixture replay against the fake, which conforms to the driver). The gap is that a real E2B
provider implementing `SandboxProvider` cannot be passed to `runSandboxProviderContract` as-is, so
a green contract does not (yet) prove real-supervisor conformance.

**Resolution (do at CLI-001/D2, before a real provider is validated by this suite):** either
(a) relocate the `SandboxProvider` port + result types to a shared worker-protocol-only leaf that
BOTH `@armyofagents/worker-daemon` and the contract import (the E4-F003 "shared leaf" option), so
the contract validates the authoritative per-op port; OR (b) add a tested
`SandboxProvider → SandboxProviderDriver` adapter with a totality assertion over all 11 ops + their
result shapes. The misleading "satisfies this shape" comment in `port.ts` was corrected in the
DEP-000 fix round; this finding records the deferred reconciliation.

## E6-F009 — D1 worker↔data isolation is direct-path + no-credentials + RLS; toxiproxy is a deliberate multi-homed bridge — RESOLVED

**Status:** `resolved` (DEP-002 fix round, 2026-08-13) · Severity: MED (harness-claim honesty) · Source: DEP-002 adversarial review (2 confirmed: control-endpoint static coverage; toxiproxy porosity).

The DEP-002 review found that the "workers cannot reach PostgreSQL" claim was porous: the plan §2.3
specifies a SINGLE toxiproxy multi-homed on data-net + worker-net, whose control-plane→postgres
proxy listens `0.0.0.0:15432`, so a worker can reach `toxiproxy:15432 → postgres:5432` indirectly
even though it is off data-net. The direct-path live test passed but the indirect path was
unprobed, so the gate would falsely advertise full network isolation.

**Decision (proportionate — no plan deviation):** the D1 harness does NOT split toxiproxy (the
plan deliberately specifies one multi-homed instance). Instead the enforced worker↔data isolation
is defined precisely as the conjunction of:
1. **No DIRECT worker→postgres path** — worker services are off data-net (static invariant
   `checkWorkerNotOnDataNet`) and a direct `connect(5432,'postgres')` is refused (live test).
2. **Workers carry NO database credentials** — a new static invariant asserts worker services
   declare no `DATABASE_URL`/`*_DATABASE_URL`/`aoa_app` credential env, so even reaching
   `toxiproxy:15432` a worker cannot AUTHENTICATE to postgres. (Reject fixture: a worker with a
   `DATABASE_URL` fails the validator.)
3. **E2 FORCE-RLS** gates any data access regardless of network path.

toxiproxy's `:15432` listener being TCP-reachable from workers is documented as **by design** (a
deliberate data-tier bridge), not a hidden port; a CI-deferred live assertion documents that a
worker reaching it without `aoa_app` credentials cannot authenticate. The control-plane-must-not-
script-the-fake boundary also gained a static invariant (fake `AOA_FAKE_PROVIDER_CTL_ALLOW`
non-empty + excludes control-plane) and the fake control endpoint now fails CLOSED on an empty
allowlist. A stricter network-layer split (dedicated cp↔pg toxiproxy on a control-plane-only net +
interface-bound listener) is a possible E6 follow-up but is NOT required — the credential + RLS
boundary is the meaningful guarantee.

## E6-F010 — the D1 merge-train lane had been RED for five days and three merges; the control-plane image could not build — RESOLVED

**Status:** `resolved` (WRK-017, 2026-09-03) · Severity: **HIGH** (the D1 lane is the ONLY thing
that boots the split images, and it validated nothing for three merges) · Source: WRK-017 Step 0 —
the ticket's premise is "a CI-exercised first container-enrol", so the first question was whether
the lane runs at all.

**Measured.** `gh run list --workflow=d1-merge-train.yml` → `failure` on `c3d26657d` (2026-08-29),
`07ed2cc42` (2026-08-30) and `b6e02a478` (2026-08-31); last `success` `50380b6f7` (2026-08-25).
The failing step is *Build split D1 images*, and the failure is identical on all three:

```
packages/sandbox-fake-provider build: src/hash.ts(11,28): error TS2307: Cannot find module 'node:crypto'
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL @armyofagents/sandbox-fake-provider@0.1.0 build: `tsc`
#40 ERROR: process "/bin/sh -c pnpm --filter \"@armyofagents/server...\" --filter \"@armyofagents/ui...\" build" did not complete successfully
```

Reproduced byte-for-byte on a local Docker Desktop against `203853b3a` before any WRK-017 change.

**Root cause — a guard that was green because it guards a different set.** The control-plane
`deps` stage COPYs the workspace manifests in `@armyofagents/server`'s **production** closure, and
`scripts/check-image-deps-stages.mjs` enforces that COPY set exactly — its `computeRuntimeClosure`
walks `.dependencies` alone, by design, to mirror pnpm's `--filter-prod`. The `build` stage,
however, runs `pnpm --filter "@armyofagents/server..." build`, and `pkg...` traverses
**`devDependencies` too**. The two sets were equal until DEP-011 Slice 1 (`c3d26657d`) added
`@armyofagents/adapter-manager` to `server`'s **devDependencies**, whose graph reaches
`provider-wire → sandbox-e2b-provider → sandbox-provider-contract → (devDep) sandbox-fake-provider`.
Five packages the deps stage never installed entered the build selection, and `tsc` died in a
package with no `node_modules`. `node scripts/check-image-deps-stages.mjs` **stays PASS** through
all of it, correctly: the manifest it guards is still exactly right.

**Why nobody noticed.** `d1-merge-train.yml` is not among the required checks — branch protection
requires only `ci-required` (`pr.yml`), and `d1-merge-train` runs on `push` to the integration
branch, after the merge. A red there is a red nobody is waiting on. This is the programme's own
"a check that nothing runs is not a check" class, one lane over: the check ran and went red, and
the absence of a *consumer* for that verdict made it equivalent to not running.

**Resolved** by the fix the WORKER image already uses for the identical reason (its "8th manifest"
note): re-install in the build stage, against the manifest set that stage actually has after
`COPY . .`, so the build selection and the installed set are the same set. Non-prod, because the
workspace `typescript` devDep must resolve; `pnpm deploy --prod` still prunes every dev package
back out, so nothing extra reaches production. Verified locally: both images build and
`docker/images/digests.env` is populated. NOT fixed by switching the build line to `--filter-prod`
— `provider-capability`'s only edge to `worker-daemon` is a devDependency and that edge is what
yields the correct topological order, a trap the worker Dockerfile already records.

**Residual, stated plainly.** The class is not closed. Any future workspace **devDependency** added
to `server` or `ui` widens the build selection again; the re-install absorbs that, but nothing
warns when the two sets diverge, and no PR-time check builds either image. A deps-stage guard that
also compared the dev closure — or a `ci-required` consumer for the image build — would close it.
Not attempted here: WRK-017 needed the lane green, not a new gate.

## E6-F011 — the D1 control plane would have refused every real worker request: `toxiproxy` was never in its hostname allowlist — RESOLVED

**Status:** `resolved` (WRK-017, 2026-09-03) · Severity: MED (latent; unreachable until a worker
container actually issued a request, which WRK-017 is the first thing to do) · Source: WRK-017
source trace of the enrol path before the first bring-up.

`docker-compose.d1.yml` set `AOA_ALLOWED_HOSTNAMES: "control-plane,localhost,127.0.0.1"` with the
comment *"The E6F harness + the workers reach the control plane by its in-compose service name"*.
The workers do **not**. `AOA_WORKER_CONTROL_PLANE_URL` is `http://toxiproxy:13100` — and that
routing is itself a load-bearing static invariant (`checkToxiproxyInPath`), so it is not a mistake
to be corrected on the worker side. A worker's HTTP `Host` header is therefore literally
`toxiproxy:13100`, `privateHostnameGuard` is ENABLED on this stack (`authenticated` mode plus the
control-plane image's default `AOA_DEPLOYMENT_EXPOSURE=private`), and `/api/worker-control/*` does
not bypass it — so every enrol/poll/ack from a real worker would have been answered **403**.

The comment was true of the only client that existed: the E6F harness dials
`http://control-plane:3100` from `test-runner`, which was in the allowlist all along. The claim
about *workers* had never been executed by anything.

**Resolved** by adding `toxiproxy` to `AOA_ALLOWED_HOSTNAMES` on BOTH control-plane replicas, with
the reasoning recorded at the line. No product code changed: the guard behaved exactly as designed;
the harness's allowlist was simply wrong about who its clients are.

## E6-F012 — the deps-stage parity guard compares the PRODUCTION closure while the build stage traverses dev edges too — RESOLVED

**Status:** `resolved` (2026-09-04) · Severity: MED · Source: WRK-017 (2026-09-03), promoted out of E6-F010's residual
so it is countable by `check-finding-ownership.mjs` — a residual recorded inside a `resolved` finding
is invisible to the guard, which is its own small instance of this programme's failure class.

`scripts/check-image-deps-stages.mjs` enforces that each split image's `deps` stage COPYs EXACTLY the
workspace manifests in that image's **runtime** closure. Its `computeRuntimeClosure`
(`scripts/lib/image-deps-stage.mjs`) walks `.dependencies` **only** — deliberately, and the module's
own header says so, because that is what makes it byte-equal to pnpm's `--filter-prod "X..."`.

The BUILD stage does not run `--filter-prod`. It runs `pnpm --filter "@armyofagents/server..."
--filter "@armyofagents/ui..." build`, and `pkg...` traverses **`devDependencies` too**. The two sets
were equal until DEP-011 Slice 1 (`c3d26657d`) added a workspace DEVdependency
(`@armyofagents/adapter-manager`) to `server`, whose graph reaches
`provider-wire → sandbox-e2b-provider → sandbox-provider-contract → (devDep) sandbox-fake-provider`.
Five packages the deps stage never installed entered the build selection and `tsc` died on
`Cannot find module 'node:crypto'` in a package with no `node_modules` — **and the parity guard stayed
PASS throughout, correctly**, because the manifest it guards was still exactly right.

**What WRK-017 did and did not close.** It fixed the break, using the mechanism the worker Dockerfile
already used for the identical reason: re-install in the build stage against the manifest set that
stage actually has after `COPY . .`. That **absorbs** the divergence. It does **not detect** it. The
next workspace devDependency added to `server` or `ui` widens the build selection again, silently,
with no guard saying so and no PR-time job that builds either image.
*(★ AS-FILED TEXT, SUPERSEDED — see the RESOLUTION below. "No guard saying so" is no longer true;
and the widening on `server`/`ui` specifically turned out not to be a defect at all, for a reason
this paragraph did not know. The paragraph is kept verbatim because the resolution argues with it.)*

**Blocks:** nothing today — the re-install makes the current tree build. It is filed `unowned` because
no ticket is building the detector, and because the honest remediation is a design choice, not a line:
either teach the deps-stage guard to compare the DEV closure as a second, separately-reported set, or
give the image build a PR-time consumer. Note the relationship to **DEP-013** without conflating them:
DEP-013 makes the next occurrence LOUD within a bounded time; this finding's successor would make it
IMPOSSIBLE. Neither substitutes for the other, which is why WRK-017's designer declined to fold this
into DEP-013.

**RESOLUTION (2026-09-04).** Both halves closed, and the second half was worse than filed.

> ★ **READ THE CORRECTION BELOW BEFORE QUOTING ANYTHING IN THIS SECTION.** Review refuted this
> resolution's headline on 2026-09-05 — twice. The measurements below stand; two of the claims made
> about them did not. The corrected statement of what actually ships is at the end of this entry.

**Measured first.** The divergence was never hypothetical — every one of the three split images
already diverges at `da1a90597`:

| image | runtime (prod) closure | build (dev) closure | build-only |
|---|---|---|---|
| control-plane | 19 | 25 | 6 — adapter-manager, provider-wire, sandbox-e2b-provider, sandbox-fake-provider, sandbox-provider-contract, worker-daemon |
| worker | 7 | 8 | 1 — sandbox-fake-provider |
| adapter-manager | 7 | 8 | 1 — sandbox-fake-provider |

Measured alongside it: **0 of 33** workspace manifests declare an `optionalDependencies` block at
all, so the neighbouring hazard the module header warns about (`--filter-prod` traverses them,
`indexPackages` does not) is still dormant and is deliberately left where it is.

**Half 1 — the detector.** `scripts/lib/image-deps-stage.mjs` gains a SECOND, separately-reported
verdict (`evaluateBuildStageAbsorption`) beside the deps-stage one. The invariant is deliberately
NOT "the deps stage must COPY the dev closure" — that would destroy the least-privilege property
the file exists to enforce and would push the fake provider and the worker daemon into the
control-plane install. It is conditional, and it lives one stage later:

> IF the build closure is strictly larger than the runtime closure, THEN the `build` stage must
> absorb the difference — **(a)** by re-installing (`RUN pnpm install`, not `--prod`/`--filter-prod`,
> which would re-select the runtime closure and absorb nothing) and **(b)** with the divergent
> packages' manifests actually present in that stage, or the re-install has nothing to resolve.

`computeRuntimeClosure` is untouched: its `.dependencies`-only walk is a load-bearing mirror of
`--filter-prod` and must not grow a mode flag, so `computeBuildClosure` is a separate function and
`indexPackages` records `devWorkspaceDeps` as a separate field.

Clause (b) is what makes the rule bite. The worker build stage deliberately does not `COPY . .` —
a whole-tree copy would make every `dockerfile-static` exclusion grep vacuous — so for that image a
new workspace devDependency is a real break, and clause (a) alone would not see it. Clause (b) also
promotes the worker's "8th manifest" note from prose to a checked rule.

**Half 2 — the consumer that could not fire.** The only lane that builds these images is
`d1-merge-train.yml`, and its `paths:` filter listed the workflow, the compose files, `docker/**`,
`.dockerignore`, `tests/d1/**` and seven scripts — and **nothing matching `package.json`,
`pnpm-lock.yaml` or `pnpm-workspace.yaml`**. So the exact commit class that widens the build
selection could not fire even the POST-merge consumer. `c3d26657d` reddened the lane only because
it happened to touch `docker/**` as well. This finding was filed as "no PR-time consumer"; it was
NO CONSUMER AT ANY TIME. That same file already carried the identical lesson for `.dockerignore`
("a change to it could alter the contents of both shipped images without the image-building lane
ever running") — the manifests were simply never given the same treatment. They now are, with the
queueing cost stated in the comment rather than hidden.

**Proved by mutation, on the REAL tree, each one restored and the restore verified green:**

| # | mutation | result |
|---|---|---|
| 1 | `packages/worker-networked-host` gains a workspace devDependency on `shared` | RED — clause (b): "build-only closure package @armyofagents/shared has no manifest in the 'build' stage". The deps-stage verdict is untouched, which is the point. |
| 2 | `server` gains a workspace devDependency on `cli` | **GREEN — and correctly so.** |
| 3 | the control-plane build stage's re-install line deleted (WRK-017's fix reverted) | RED — clause (a), naming all six build-only packages. |
| 4 | that same line changed `--filter` → `--filter-prod` | RED — "absorbs nothing". |
| 5 | the worker build stage's two `sandbox-fake-provider` COPY lines deleted | RED — clause (b). |

**★ Mutation 2 is the honest limit, and it revises this finding's own headline.** "The next
workspace devDependency added to `server` or `ui` re-widens the build selection" is still true, but
it is no longer a defect there: the control-plane and adapter-manager build stages do `COPY . .`
plus a non-prod re-install, so any dev-closure widening is absorbed *by construction* and the image
still builds. The guard returns green because there is nothing wrong, not because it is blind — and
mutations 3 and 4 are what distinguish those two readings. What the guard newly makes impossible is
(i) removing or `--prod`-ing an absorber that is load-bearing, and (ii) a widening on an image whose
build stage copies selectively — i.e. the worker.

**Not claimed.** This is static text analysis over the Dockerfiles and the manifests. It does not
build an image. The stated remedy in every error message points at the `build` stage and says
"never to deps", because a guard whose message advises the least-privilege violation is worse than
no guard. DEP-013's verdict consumer remains the mechanism that makes an actual image-build failure
loud; this makes one class of it impossible to introduce silently, and the trigger fix is what lets
the lane observe the class at all.

---

### ★★★ CORRECTION (2026-09-05) — the shipped HEADLINE overstated the shipped MECHANISM, twice

Review refuted this entry's claim, not its measurements. Both corrections are recorded here in full,
because a future reader believes the headline and only reaches the body once the headline has already
misled them.

**Correction 1 — a FALSE CLAIM OF ENFORCEMENT in the one file a filter-editor reads.** The comment
added to `.github/workflows/d1-merge-train.yml` said `check-image-deps-stages.mjs` "now detects the
divergence statically on every PR", directly beneath an antecedent naming *"a single workspace
devDependency added to `server`"*. **On exactly that class the script is silent** —
`evaluateBuildStageAbsorption` returns `[]` before any report once the divergence is absorbed, and
the only passing output is the single line `split-image deps-stage parity: PASS`. No divergence is
ever printed. This register said so in the same commit (mutation 2 green, "no longer a defect
there"), so the workflow comment contradicted its own evidence. Worse than wrong: it sat directly
above the paragraph that costs 45 minutes of CI, where it reads as the reassurance that would
license trimming the `**/package.json` trigger. The comment now states what the guard checks, states
that it stays green on the antecedent class *and why that is correct*, and says plainly that the
static guard is **not** grounds for trimming these entries.

**Correction 2 — clause (a) tested the wrong half, and that was not disclosed.** Clause (a) asks
"is there a `pnpm install` in the build stage without `--prod`/`--filter-prod`?" — a question about
a FLAG. It is satisfied by an install that absorbs nothing. **Measured on `da1a90597`:** replacing
the control-plane build stage's re-install with
`RUN pnpm install --frozen-lockfile --filter "@armyofagents/worker-protocol..."`, leaving its
`--filter "…/server…" --filter "…/ui…" build` line untouched, left the whole gate GREEN — and that
is `c3d26657d`'s failure mode exactly (the build selection strictly exceeding the installed
selection). Disclosing that would have left a guard whose name promises more than it does, so it is
FIXED: `evaluateBuildSelectionCoverage` (clause **a2**) compares the two SELECTIONS. Every package a
`pnpm … build` line selects must have been selected by an install visible to that stage. It is
unconditional — "build only what you installed" holds with no dev/prod divergence at all.

Three subtleties the fix had to get right, each of which is a test:

* **Discovery bounds a selection.** `--filter "…/server…"` in a `deps` stage holding only the 19
  runtime manifests installs 19, not the 25 the same flag selects against the whole tree — pnpm's
  `...` walks the DISCOVERED workspace. Unbounded, the deps filter would vouch for packages it never
  installed and the fix would be vacuous.
* **`COPY --from=<stage> <workdir>` IS an install.** The control-plane and adapter-manager build
  stages take deps' node_modules wholesale, so reporting those packages is a FALSE POSITIVE. Credit
  is given only for a copy of that stage's own workdir (or its `node_modules`) — an unrelated
  `COPY --from=deps /app/patches ./patches` earns none, or a narrowed re-install could hide behind it.
  Finding this cost the first draft of clause (a2): it would have red-flagged a correct Dockerfile.
  ★ Note the deliberate asymmetry with clause (b), which still does **not** count a `COPY --from=`
  as manifest delivery: a cross-stage copy moves an *installed tree*, which is what (a2) asks about,
  and does not move *source manifests*, which is what (b) asks about. The same line legitimately
  answers one question and not the other; collapsing them would make (b) vacuous for both
  `COPY . .` images.
* **An ABSENT package is clause (b)'s, not (a2)'s.** A package whose directory never entered the
  stage cannot be selected by the build line either. Double-reporting one gap with two different
  remedies sends the reader to the wrong fix.

Also removed while proving this: an `isPnpmBuildLine` exclusion for lines containing `deploy`. It
could not change a verdict on any realistic line (a `pnpm deploy --prod` line carries no whole-token
`build`) and would have SUPPRESSED a real build on a compound `RUN pnpm deploy … && pnpm build`.

**Measured, on the real tree, each mutation restored and the restore verified green:**

| # | mutation | result |
|---|---|---|
| a2-1 | worker build-stage install narrowed to `worker-protocol...` | RED — "BUILDS 1 package(s) that no install there selected (sandbox-fake-provider)" |
| a2-2 | adapter-manager build-stage install narrowed to `provider-capability...` | RED — 5 packages |
| a2-3 | control-plane install covers `server` only; the build line still selects server+ui | RED — 1 package (`ui`) |
| a2-4 | a glob selector (`--filter "@armyofagents/*"`) on the build line | RED — reported as unparseable, never read as "selects nothing" |
| 3′ | control-plane build-stage re-install DELETED | RED — clause (a), unchanged |
| 4′ | that line `--filter` → `--filter-prod` | RED — clauses (a) AND (a2) |
| 5′ | worker build stage loses both `sandbox-fake-provider` COPYs | RED — clause (b), unchanged |

And eleven mutations of the guard's own source, each restored: neutering `evaluateBuildSelectionCoverage`,
dropping the unparseable-selector report, dropping the present-set filter, dropping `FROM <stage>`
install inheritance, dropping `COPY --from=` install credit, widening that credit to any source,
un-bounding a selection by its stage's discovery, making a bare install select nothing, making
build lines invisible, and matching `build` as a substring — **all red**.

**What clause (a2) still does NOT cover, stated rather than implied.** pnpm filter syntax beyond a
plain package name with an optional `...` (`^...`, `...^`, globs, path and changed-since selectors)
is REPORTED as unparseable rather than silently treated as empty — loud, but not understood.
ORDERING is invisible: an install placed *after* the build line reads the same as one before it. And
nothing here builds an image.

**The claim, at its weakest fully-supported strength.** This PR does two things. It gives
`d1-merge-train.yml` a manifest/lockfile trigger, so the commit class that re-widens the build
selection can fire the only lane that builds these images — verified, and the valuable half. And it
adds a static guard that makes three specific evasions impossible: removing or `--prod`-ing a
load-bearing absorber, narrowing a re-install below what the build line compiles, and a widening on
an image whose build stage copies selectively. It does **not** detect "a workspace devDependency
was added", it prints no divergence, and it is not a substitute for building the image.

Corpus: 19 new cases in `scripts/check-image-deps-stages.test.mjs` (34 total, all green).

## E6-F013 — the verdict consumer has never been OBSERVED publishing: DEP-013's live control is owed, and the reader is in its one tolerated state until it is

**Status:** `open` · Severity: MED · Source: DEP-013 build (2026-09-04), filed by the builder
against its own work rather than discovered later.

DEP-013 ships the consumer, the reconciler workflow and the terminating reader in `policy`.
Three of the design's controls were executed and are recorded in `DEP-013-result.md`: PC-1 (a
12-mutant sweep over the pure evaluator, 12/12 killed and the source restored byte-identical),
PC-2 (the replay against the **recorded** 08-25 → 09-03 `d1-merge-train` history, which reports
from `c3d26657d` and stops at `ee74f9c8c`), and a LIVE evaluation of all eleven watched streams
against the real GitHub API, which correctly reports `cross-platform-weekly.yml@main` as
`not_success (cancelled)` — §6's free positive control, fired with nothing broken to arrange it.

**What is NOT proven, and it is the half that involves a write.** The reconciler has never
published. Two independent reasons, and neither is a shortcut:

1. **The builder may not publish.** `MeteoriteLabs/AoA` is a PUBLIC repository, and opening the
   tracking issue is publishing public content — outside an automated builder's authority. It
   was therefore run as `--dry-run`, which performs the entire evaluation and prints the exact
   issue body it would post. Everything except the `POST` is measured; the `POST` is not.
2. **The workflow cannot fire from this branch anyway.** GitHub registers `schedule` and
   `workflow_dispatch` only from the DEFAULT branch. That is not an assumption: this repository
   already states it at the line in `d1-merge-train.yml` ("workflow_dispatch is omitted
   deliberately: it requires the workflow on the default branch (main)") and in
   `keyed-e2b-conformance.yml`, and every scheduled run of `cross-platform-weekly`,
   `catalog-audit` and `thread-v2-e2e` in the API is on `main`. The `push` trigger added for
   exactly this reason makes the reconciler's FIRST real run the push that merges it.

**What that means for the gate today — stated plainly, because a false claim of enforcement is
worse than a missing check.** `policy` runs the reader on every PR and the reader FAILS the job
(proven by six spawned vectors asserting real exit codes). But with no published issue and no
completed reconciler run, its verdict today is `not_bootstrapped`, which PASSES. **So the
blocking half of DEP-013 is wired and exercised but has not yet blocked anything.** The
tolerance is deliberately the narrowest possible and it is not a dial: it is removed by the
FIRST completed reconciler run, automatically, with no manifest edit and nobody to remember —
after that, a missing issue is `ran_but_never_published` and reds `policy`. It cannot mask any
other failure: with the issue present, a wiped marker, an unparseable marker and a stale marker
all fail regardless.

**Blocks:** nothing merging. It leaves one claim unmade — *the consumer has published and the
reader has been seen going red on real silence*.

**What would have to change, precisely.** After this lands on `docs/replatform-program`: (a) the
merge push runs `verdict-reconcile.yml`, which opens the tracking issue — confirm the run is
`success` and that the issue carries a `verdict-consumer:v1` marker; (b) confirm the next PR's
`policy` prints `OK (fresh)` rather than `OK (not_bootstrapped)`, which is the observation that
the tolerance is gone; (c) for PC-3(2), re-run the reader against a marker older than
`consumer.toleratedSilenceHours` — the `--self-test-case=stale` vector already does this locally
and exits 1, so the live version adds only the CI surface; (d) when `verdict-reconcile.yml`
reaches `main` and its 6h cron is observed firing, drop `consumer.toleratedSilenceHours` from
72 to 26, which the manifest's own `toleratedSilenceReason` already names as its successor
condition.

**Filed rather than fudged.** The alternative was to wire the reader as a no-op until someone
flips a manifest flag. That is the shape this programme has already had to delete once — a gate
nobody can pass, or a dial nobody remembers — and it would have made the enforcement claim false
in a way no guard could see.

## E6-F014 — `Setup pnpm` in the `policy` job grew ~40× (4s → 195s) and nobody noticed until it cancelled a required check

**Status:** `open` — NARROWED 2026-09-04 by TRACK A (see the second addendum below). The LEAK is
closed: the raise had covered 1 of the 9 `pr.yml` jobs carrying this step, and all 9 are now handled —
1 by deleting the step outright, 8 by splitting the job cap into a work budget plus a named
infrastructure allowance, behind a guard that refuses an undeclared cap. **The cause is still
undiagnosed and PR #321 is still untested**, which is what keeps this open.
**Severity:** MED · Source: DEP-013 build (2026-09-04). Found because DEP-013's
own PR was the run that finally crossed the cap.

`policy` is the only job branch protection's `ci-required` aggregator needs on **every** PR. On
run `33858466826` it was **cancelled at exactly 5:04** against its `timeout-minutes: 5`, with no
guard having failed and most having never started. The whole budget went to one step:

| step | duration |
|---|---|
| Checkout | 6s |
| **Setup pnpm** | **4m 47s** |
| everything else (5 guard steps reached before the cancel) | 6s |

**The step used to cost nothing.** Measured across the last six `policy` runs on
`docs/replatform-program` (`gh api …/actions/jobs/<id>`), newest last:

| run | `Setup pnpm` | job total |
|---|---|---|
| 33769476886 | 4s | 74s |
| 33799136579 | 4s | 74s |
| 33799234615 | 5s | 84s |
| 33840970676 | **135s** | 206s |
| 33842573550 | **195s** | 265s |
| 33847376840 | **149s** | 208s |

**So the job total moved from 74s to 265s against a 300s cap.** Every PR in this repository was
one slow registry response away from a cancelled required check, on all four live tracks, for a
reason having nothing to do with any of their commits.

**This is the third instance in three days of one class:** *a required check whose verdict is a
function of something the commit does not contain.* The other two are E3-F034 (a runner's fsync
against a 750 ms `lock_timeout`) and E3-F036 (npm-registry latency against a 30s `testTimeout`,
where the install is allowed 120,000 ms and the test awaiting it gets 30,000 — an inverted
budget). The standing response to all three — re-run until green — is **indistinguishable from
ignoring a real regression**, which is the same sentence DEP-013 was chartered to write about
verdicts.

**Absorbed, not detected.** DEP-013 raised the cap to 12 minutes on this measurement, with the
reasoning at the line. That stops the cancellations; it does **not** detect the next 40×. A cap
raised without a filed cause is exactly how this one went unnoticed for three runs, and the
distinction matters — a 60-minute `verify` cap once masked a real hang here for weeks, so raising
a cap is a legitimate move only when the cause is measured and is not a hang. It is measured, and
it is not a hang.

★ **It is still growing, and the raise was not generous — it was necessary.** The very next run
after the cap went to 12 minutes (`33859560367`, sha `da8abcc2f`) recorded `Setup pnpm` at
**424s** — worse than the 287s that caused the cancellation, ~100× the 4s baseline — for a job
total of **499s**. An 8-minute cap would also have failed. DEP-013's own two steps in that job
cost **1s each**, so nothing in this ticket is the load.

**Blocks:** nothing, now that the cap is raised.

**What would have to change.** Two candidate remediations, and choosing between them is a real
decision rather than a line: (a) find and fix the growth — the step is
`pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271` with `run_install: false`, so 195s is
almost entirely the action's own download/cache work rather than dependency installation, and a
pinned-binary or cached-store approach would remove it; or (b) if the cost is irreducible, give
job durations a consumer — the same argument as DEP-013 one register over, since a step time is a
verdict nobody reads until it crosses a cap. Filed `unowned` because no ticket is doing either.

★ **One free lead for whoever takes it:** PR **#321** (`bump pnpm/action-setup from 6.0.9 to
6.0.10`) is open and untouched. It is a CANDIDATE, not a diagnosis — the correlation has not been
measured, and the growth could equally be CDN-side. But it is the cheapest thing to test first,
and it is already sitting in the queue: check whether 6.0.10 restores the 4s step before
attempting anything larger.

---

### ★ Addendum (2026-09-04, independent track) — the misdiagnosis this causes, and one correction

Filed from a separate investigation that was handed the *symptom* — "the `policy` step
`Worker route-path parity (WRK-008)` hangs for ~5 minutes" — and measured its way to the same step
E6-F014 already names. **It reproduces this finding rather than adding a defect**, so it is recorded
here instead of taking a second id: an id must name one thing, and so must a defect. What follows is
only what was *not* already above. It was filed as a separate finding first and withdrawn on contact
with this one; `check-register-id-uniqueness.mjs` refused the duplicate id, which is the guard doing
exactly its job.

**Independent confirmation of the baseline.** `Setup pnpm` measured **3 s** on run `33871439141`
(job total 1m 10s) — consistent with the 4 s / 4 s / 5 s above, from a different track on a
different day's tip.

#### ★★★ 1. The cancellation is reported against an ARBITRARY INNOCENT STEP — which is how it gets misdiagnosed

E6-F014 says "no guard having failed and most having never started". The sharper and more damaging
fact is that GitHub does not report the job as timing out: **it marks whichever step happened to be
executing at the wall as `cancelled`**, and that step is a coincidence of scheduling. Across the
**eight** cancelled `policy` attempts measured on four shas, the accused step was **four different
steps**:

| accused step | times accused | its own cost on a normal run |
|---|---|---|
| `#4 Setup pnpm` | 5 | 3 s |
| `#10 Sandbox e2b provider dependency boundary` | 1 (run `33858466826`, the one cited above) | <1 s |
| `#16 Frozen worker-protocol v1 consumer (E1)` | 1 | 37 s |
| `#18 Worker route-path parity (WRK-008)` | 1 | **0 s** |

**This is not theoretical — it already produced a wrong bug report.** `#18` was escalated as a
five-minute hang. On a green run it costs **zero seconds** (`07:05:51 -> 07:05:51`), and on the
attempt where it was accused it was cancelled at zero seconds too (`06:39:53 -> 06:39:53`): the wall
arrived one second after it started. `scripts/check-worker-path-parity.mjs` performs **ten**
`readFileSync` calls over four files (counted by instrumenting a copy) and **spawns nothing, reads
no stdin, globs nothing and touches no network**. It cannot stall. Anyone taking the report at face
value searches `scripts/check-*.mjs` — the one place the defect is not.

So this failure does not merely *misattribute* the way E3-F034 and E3-F036 do (a real red on the
thing that was genuinely slow); it **misdirects**, pointing at a file that is not involved. That is
worth knowing before the next one is triaged, and it is the reason the symptom reached a second
track as "a hang" at all. **Nothing hangs**: every step runs to its ordinary cost and the job's
fixed wall arrives first.

#### ★★ 2. It is per-runner, not a uniform slowdown — measured inside a single run

The series above is across runs, which is equally consistent with a global CDN degradation. It is
not global. Within **one run** (`33842573550` attempt 1), the identical pinned action ran in five
jobs starting inside a 20-second window:

| job | `Setup pnpm` | its own report |
|---|---|---|
| `distributed-contract` | **11 s** | `added 1 package, and audited 2 packages in 11s` |
| `browser` | 2m 14s | — |
| `migrations` | 3m 03s | `in 3m` |
| `lint` | 3m 27s | `in 3m` |
| `policy` | **>= 4m 58s** | cancelled before it could report |

**A 27× spread at one minute, against one registry, from one pinned action.** An outage would slow
all five alike. This bears on the choice between remediations (a) and (b): the cost is not a new
fixed price that could be re-budgeted, it is a **heavy tail on each runner independently**, so no
cap chosen against typical behaviour is safe while the dependency stands. It also explains why only
`policy` ever dies — it holds the smallest budget of any job that runs the step
(`policy` was 5m; `brand-check` 10m, `lint`/`migrations` 15m, `distributed-contract`/`browser` 20m,
`e2e-pgvector` 25m, `e2e` 30m, `verify` 60m). `lint` and `migrations` absorbed the same three-minute
install on that very run with eleven minutes to spare. The two other five-minute jobs, `changes` and
`worker-protocol-contract-bytes`, do not run the step at all.

#### 3. The blast radius is two jobs wider than "policy went red"

Observed on all eight cancelled attempts (steps 1 and 2 on 8/8; step 3 as `failure` on 7/8 and as
`cancelled` on the eighth — never `success`, which is the only value branch protection accepts):

1. `policy` is cancelled at the wall.
2. `brand-check` (`needs: [policy]`) is **skipped**, and GitHub stamps the skipped job with
   `completed_at` **before** `started_at` (e.g. started `06:05:12`, completed `06:05:11`). A reader
   who checks that job sees an inverted timestamp and reasonably suspects a second, unrelated fault.
   It is an artefact of the cancel path.
3. `ci-required` requires `policy` **and** `brand-check` in its **always-on** arm — not the
   `code=true`-gated one — so it emits two `::error::` lines and fails. (On run `33858466826`
   `ci-required` was itself `cancelled` rather than `failure`; the gate is red either way.)

No compute is lost (re-running the failed jobs carries the green ones forward — `verify (2)` keeps
its original timestamps across attempts). The cost is latency, attention, and the re-run reflex:
**PR #353 needed five attempts** to get a green `policy`, and the integration tip `717475f63` was
cancelled too. Occurrences on four shas: `46c27e38b`, `5d91afff5` (#353), `717475f63` (the integration tip), and
`f5daf62fc` — DEP-013's own build branch, the run `33858466826` cited above.

#### ★★★ 4. ONE CORRECTION — "it is still growing" is not sustained, and that is a trap for the PR #321 lead

The section above records `Setup pnpm` at **424 s** on run `33859560367` (09:41Z) and concludes it
is *still growing*. Measured **2.5 hours later**, on run `33871439141` (12:10Z), the same step on the
same branch took **3 seconds** — back to baseline, with no change to the action, the pin, or the
workflow in between.

So the distribution is **episodic with a heavy tail, not monotonic growth**. Every cancellation and
every multi-minute sample falls inside one window on 2026-09-04 (roughly 05:34Z–09:48Z); the **18**
`policy` runs on `docs/replatform-program` that PRECEDE that day are green to a run, and the run
after the window is 3 s. (The remaining three greens are ON 09-04 and two of them are the degraded
135 s / 149 s samples above — the episode shows up in the greens as well as the reds, which is why
"all the greens are before it" would have been the wrong summary.)

**Why this matters more than a corrected adjective.** The free lead above suggests testing whether
`pnpm/action-setup` 6.0.10 (PR #321) "restores the 4s step". Outside an episode **the step reads
~4 s with or without the bump**, so a single post-episode measurement will look like a fix whatever
the bump does. Testing that lead needs either a paired comparison (both versions in the same run, so
they see the same runner conditions) or a sample large enough to contain a tail — otherwise the
likely outcome is a confident, wrong "fixed", which costs more than the open question does. The
correlation remains unmeasured either way, and the growth may still be CDN-side.

**Method note, since the addendum corrects the section above.** This addendum's own first draft made
the same error one scale down: it took a *degraded* run (`33842573550` attempt 3 — job 4m 25s, step
3m 15s) for "the green baseline", and asserted a failure rate of "roughly one sha in two" from two
shas that had been handed to it *because* both were red. Measuring the population instead — the last
25 `PR` runs on `docs/replatform-program`, 23 with attempt-1 `policy` data — gives **21 success, 2
cancelled**, of which 18 (5 on 09-02, 13 on 09-03) precede the episode and the other 5 are inside it. Selection bias in the same direction is what
produced both the withdrawn rate and the "still growing" reading: **a sample drawn from an episode
describes the episode, not the distribution.**

---

### ★ Addendum (2026-09-04, TRACK A) — the raise closed one of nine exposures; the remaining eight are now split budgets behind a guard

**Status: still `open`, and NARROWED rather than closed.** What this addendum closes is the *leak*
(the cap was raised on one job out of nine that carry the same step) and the *absence of detection*
(nothing would have caught a tenth instance). What it does NOT close is this finding's headline
question — **why the step grew** — which is still undiagnosed.

#### 1. The leak, counted at the tip `da1a90597`

`pnpm/action-setup` appears in **nine jobs in `pr.yml`**: `policy`, `brand-check`, `verify` (4-shard
matrix), `lint`, `e2e`, `migrations`, `e2e-pgvector`, `distributed-contract`, `browser`. DEP-013's
raise covered `policy`. Repo-wide the step appears 21 times across 12 workflows.

#### 2. The correction to "it is still growing" is confirmed, and sharpened

This finding's own addendum withdrew the "still growing" reading and warned that a sample drawn from
an episode describes the episode. Measuring the whole 13-run window confirms it and puts a shape on
it: the slow setups are confined to **four consecutive runs between 05:34Z and 11:42Z on 2026-09-04**
(10, 10, 12 and 7 of the 12 job instances above 60 s). The five runs before and the four runs after
show `Setup pnpm` at **4–22 s in every job**. So the step is not on a trend and is not permanently
expensive — it had a ~6-hour episode. The 424 s that this finding cites as "worse than the 287 s that
caused the cancellation" is inside that window, and reads as its peak rather than as a next point on a
curve.

★ **This makes the case for splitting the budget stronger, not weaker.** A permanent 400 s cost would
justify raising every cap once. An intermittent episode that leaves no trace in any commit is exactly
what a single cap cannot represent: it absorbs the episode silently when it fits, and when it does not
it kills the job and GitHub names an innocent step — the misdiagnosis this finding's addendum already
documents.

**And a control fell out of the same data.** Per-job WORK (wall clock minus `Setup pnpm`) inside the
episode versus outside it: `verify` 857 s vs 909 s, `e2e` 1003 vs 989, `policy` 71 vs 73, `browser`
60 vs 59, `lint` 56 vs 57 — identical within noise, in both directions. **The episode was in the
registry fetch, not in the runners.**

#### 3. What shipped — remedy (a), partially, plus the detection this finding said the raise did not provide

This finding named two candidate remediations. What shipped is a third that sits between them and
takes one bite of (a):

- **`brand-check`'s exposure is REMOVED, not capped.** That job never ran `pnpm install`; its lone
  `pnpm exec node scripts/check-forbidden-tokens.mjs` was equivalent to plain `node` (the script
  imports only `node:` builtins). The step existed to make `pnpm exec` resolvable and bought nothing,
  while exposing a required check to registry latency — measured here at 3 s median and **234 s**
  worst. Deleted; cap 10 → 5. **Nine exposures → eight.** This is remedy (a) in its cheapest form: the
  fetch that is not needed does not happen.
- **The remaining eight get a SPLIT budget.** Each `Setup pnpm` step now carries its own
  `timeout-minutes: 8`, and each job's cap is derived as
  `ceil((workBudgetSeconds + setupAllowanceSeconds) / 60)` in `.github/ci-timeout-budgets.json`.
  This is what the finding asks for under (b) — a step duration finally has a consumer — but as a
  *gate* rather than a report: the next episode fails a step whose **name is the diagnosis**, instead
  of consuming an unrelated step's budget.
- **Seven caps go DOWN** (`policy` 12→11, `lint` 15→10, `migrations` 15→11, `browser` 20→12,
  `distributed-contract` 20→10, `e2e-pgvector` 25→18, `verify` 60→37) and **one goes up** (`e2e`
  30→33, the thinnest genuine margin of the nine at 323 s). `policy` moving 12 → 11 is not a revert of
  DEP-013's raise: the same total wall clock is preserved, with 480 s of it named as infrastructure
  and failing under its own name, so 11 is more protective than 12 rather than less.

#### 4. The guard — and the fact that it went red on the real tree first

`scripts/check-ci-timeout-budgets.mjs` (pure logic in `scripts/lib/ci-timeout-budgets.mjs`, 15-case
corpus in `scripts/check-ci-timeout-budgets.test.mjs`), wired into `policy`. Run against the
**unmodified** tip before any edit it produced **17 findings across all 9 jobs**. Two mutations against
the fixed tree, both restored: raising `verify` back to 60 alone → `job_cap_mismatch`; raising the cap
*and* the work budget together to make it arithmetically legal → `work_budget_unjustified`, because a
work budget may not exceed **2× its own recorded `measuredMaxWorkSeconds`**.

★★★ **CORRECTED 2026-09-05.** This paragraph first concluded that "*passing therefore requires editing
a dated, run-id-attributed measurement in the same diff*". **It did not — not on the dial that
mattered most.** The ceiling covered `workBudgetSeconds` only. `setupAllowanceSeconds` was validated
as a positive number and nothing else, so editing that one **uniform** value 480 → 3000 plus the two
caps it derives — a three-line diff with no measurement in it — took `policy` from an 11-minute cap to
**53**, and its step cap from 8 to **50**, on **all eight jobs at once**, and the guard printed OK.
That is the same failure mode this finding filed against DEP-013's raise, one level up. The manifest
now carries a `setupAllowance` measurement (431 s worst over 156 observations, dated, 13 run ids)
and a **1.5×** ceiling, deliberately tighter than the work budget's 2× because this one number is
additive into all eight caps. **No cap changed**, so the live evidence in item 4 below still holds.
Six new test cases pin the refuting diff; all six were RED against the pre-correction library.

★★★ **CORRECTED AGAIN, same day, and this time the correction is a WITHDRAWAL.** The paragraph above
first continued "*the cost was declared, not charged — it is charged now*", and the register said
raising a cap costs a re-measurement on BOTH dials. **That is false too, and computable from the
shipped manifest without running anything.** Each clause compares a **declared** number to a
measurement **declared in the same file**; none compares anything to a **previously committed**
value. So 3000 is refused and 646 is not: the shipped 480 sits **166.5 s** below its 646.5 s ceiling,
uniformly across the eight jobs, and every `workBudgetSeconds` sits below its own 2× ceiling too
(`verify` 1700/2184, `e2e` 1500/2092). MEASURED: pushing every declared number to its ceiling with
**no `measured*` field edited** moves the eight derived caps from **142 to 187 minutes** and every
step cap **8 → 11**, and the guard prints OK. Full residue table, and the reason a previous-value
clause cannot live in this guard, in the **E3-F036 addendum §5c**. A second miss found in the same
read — a required-lane job with no `timeout-minutes` at all is skipped by the coverage clause
entirely — is in **§5d**. Neither is closed, and no third claim replaces them.

#### 5. ★ What is still open

1. **The cause.** Nothing here explains the six hours. **PR #321 (`pnpm/action-setup` 6.0.9 → 6.0.10),
   this finding's own free lead, is still open and was NOT tested by this track.** The split budget
   makes the next episode legible; it does not prevent one.
2. **12 of the 21 repo-wide uses are untouched** — every non-required lane (`release.yml`,
   `release-smoke.yml`, `cross-platform-weekly.yml` ×2, five `keyed-e2b-*`, `llm-evals.yml`,
   `catalog-audit.yml`, `thread-v2-e2e.yml`).
3. **The other half of the E3-F036 class is untouched.** The guard covers workflow jobs and steps, not
   *tests* that reach the network — so E3-F036's own instance would not have been caught by it.
3b. ★ **This finding's remedy (b) is answered as a GATE, not as a bound on the work.** The step cap
   makes the infrastructure half fail under its own name — which is what this finding asked for. It
   does **not** make the job cap bound the work: GitHub's `timeout-minutes` covers every step, so the
   480 s allowance is additive and **unreserved**, and a job whose setup is fast may spend the whole
   cap on work (`lint` 9.8× its measured worst work, `policy` 7.5×). The magnitudes improved; the
   shape did not. See E3-F036 addendum §4 and §6 item 4 for the full ratios and what closing it
   would take.
3c. ★ **Two further things the guard does not see**, both stated rather than left for the next
   reader: a raise that stays **inside** either ceiling (E3-F036 §5c — up to +166.5 s of allowance
   on all eight jobs at once, and +484 s / +592 s of work budget on `verify` / `e2e`, with no
   measurement edited), and a required-lane job that arrives with **no `timeout-minutes` at all**
   (E3-F036 §5d — skipped by the coverage clause, inheriting GitHub's 360-minute default).
4. ~~**No live CI evidence at the time of writing.**~~ **SUPERSEDED.** Run **`33902312371`** on
   `claude/ci-timeout-class` is fully green including `ci-required`; every job landed inside both its
   new cap and its declared work budget (full table in the E3-F036 addendum), and `brand-check`
   recorded **no `Setup pnpm` step at all**, confirming the deletion in CI. ★ It landed in a QUIET
   window — `Setup pnpm` was 3–7 s — so **the 8-minute step cap has not yet fired.** The first real
   test of it is the next episode, which is also the first time this finding's remaining question
   (why the step grows) will be legible instead of showing up as a cancelled job blaming an innocent
   step.

**Disposition:** stays `unowned`. Item 1 is the remaining defect and is a diagnosis, not a line.

## E6-F015 — The committed staging manifest boots a control plane against two NOLOGIN roles, and nothing in the manifest or any clause mints their credentials

**Status:** open
**Severity:** MEDIUM — corrected DOWN from the HIGH this was reported at; the correction is the
substance of the finding and is stated first.
**Filed:** 2026-09-06 (W5U1), measured at `e1f723df2`. Cross-links E7-F018 (the class: an
operator/deployment precondition of a capability, recorded by no clause).

### ★ FIRST — what was reported, and what measurement REFUTED

This was handed over as: *"migrations `0211_tenant_rls_enforcement.sql:16` and
`0213_e2_serving_role_correction.sql:11/:17` create `aoa_app` and `aoa_operator` NOLOGIN with no
password. The only thing that mints credentials is
`docker/control-plane/provision-d1-serving-roles.mjs`."*

**The migration half is exactly right** and was re-measured:

```
sed -n '16p' packages/db/src/migrations/0211_tenant_rls_enforcement.sql
sed -n '11p;17p' packages/db/src/migrations/0213_e2_serving_role_correction.sql
```

all three are `DO $$ … CREATE ROLE "aoa_app|aoa_operator" NOLOGIN NOSUPERUSER NOBYPASSRLS …`.

**The "only minter" half is FALSE.** There is a second, in-repo, deployment-agnostic minter:
`maybeProvisionDistributedExecutionRoles` (`server/src/index.ts:303`, called at `:562`), which runs
`ALTER ROLE … WITH LOGIN PASSWORD …` on the owner connection immediately before
`openDistributedExecutionDatabases` — gated on `config.distributedExecutionEnabled` AND on
`AOA_APP_DB_PASSWORD` / `AOA_OPERATOR_DB_PASSWORD` being set. `0211`'s own header comment says so
("the login credential is provisioned at boot from env (E2-D03, server/src/index.ts)"), and the
campaign terrain doc records it as the RECOMMENDED route:
`docs/replatform/qa/2026-08-31-campaign-blockers-and-fleet-terrain.md:161-166` lists **both** ways
to grant LOGIN, calls the boot-env one "RECOMMENDED (works anywhere)", and warns that the passwords
must match the ones embedded in the role URLs. Both env vars are also documented in
`docs/deploy/environment-variables.md:110-111`.

So "recorded by no clause" is true only in the narrowest sense (no `gate-clause-wiring.json` entry),
and "recorded nowhere an operator looks" — the thing that would make it E7-F018-shaped — is **not**
true. That is why the severity is MEDIUM, not HIGH.

### What survives, and it is narrow

The committed staging manifest cannot bring its own control plane up after its own `migrate` step.

- `docker-compose.staging.yml:48-57` runs `migrate` with the owner URL. Migrations create both roles
  **NOLOGIN**.
- `docker-compose.staging.yml:61-86` and `:115-137` then start two control-plane replicas with
  `AOA_DISTRIBUTED_EXECUTION_ENABLED: "true"` and `AOA_APP_DATABASE_URL` /
  `AOA_OPERATOR_DATABASE_URL`.
- Neither replica is given `AOA_APP_DB_PASSWORD` or `AOA_OPERATOR_DB_PASSWORD`
  (`grep -n "AOA_APP_DB_PASSWORD\|AOA_OPERATOR_DB_PASSWORD" docker-compose.staging.yml` → **0 hits**),
  so `maybeProvisionDistributedExecutionRoles` is a strict no-op there. No service in the manifest
  runs `provision-d1-serving-roles.mjs` either — that script is reachable only from
  `docker-compose.d1.yml`, whose own comment scopes it "D1 harness ONLY" (`:118`).
- `server/src/index.ts:600-611` then opens both bounded pools with, in its own words, "deliberately
  no owner fallback". So the boot **fails closed** on two roles that cannot log in.

**The distinguishing detail, and why it is worth a finding at all rather than "one more `${…}`".**
Every other operator input in that file appears in the file — as a named `${AOA_STAGING_*}`
placeholder an operator reading the manifest can see and fill. The credential MINT is a *step*, not
a variable: it appears nowhere in the manifest, in no comment in it, and in no checked-in guard.
`scripts/check-staging-manifest.mjs` grades this exact file and prints "OK:
docker-compose.staging.yml satisfies the DEP-006 staging config contract" without asking the
question.

### Why the error direction is benign, and why it is still worth recording

The failure is loud: startup aborts before serving. Nothing runs unsafely, and no capability is
over-claimed. What it costs is a deploy attempt and the time to rediscover a precondition that is
written down two directories away and nowhere the operator is looking. That is a MEDIUM.

**What would close it.** A comment in `docker-compose.staging.yml` beside the two role URLs pointing
at `…campaign-blockers-and-fleet-terrain.md` §8, or the two password vars added as
`${AOA_STAGING_*}` placeholders so the manifest names its own precondition. Not done here: W5U1's
charter is "do not touch docker/ or the D1 compose files (another unit owns those)", and
`docker-compose.staging.yml` is close enough to that boundary that editing it belongs to the
deployment track.
## E6-F016 — `scripts/ci-local.mjs`'s "skip `pnpm install`" guard had never once been in effect, and its own comment said otherwise — RESOLVED

**Status:** resolved
**Severity:** MEDIUM — a local-runner-only defect (no CI lane is affected), but its side effect is
lockfile mutation in the DEFAULT fast gate, which the `policy` job then fails the PR for.
**Filed and resolved:** 2026-09-08 (W19), measured at `3814b90f3`. Cross-links the same class in
`scripts/lib/worker-keystore-boundary.mjs` (fixed earlier) and
`server/src/__tests__/w17-ipv6-range-closeout.test.ts` (fixed on another branch).

### What was wrong

`scripts/ci-local.mjs` carried, in source:

```
if (/^pnpm install<0x08>/.test(cmd)) continue;
```

a literal 0x08 backspace byte where the two characters backslash-b belonged — the signature of a
file written through a shell heredoc, `echo`, `printf` or `sed`, all of which collapse those two
characters into one control byte. The regex therefore demanded a real backspace character after
`install` and matched nothing.

The comment three lines above it read: *"Running `pnpm install --frozen-lockfile` locally costs
minutes and can churn node_modules; the local runner assumes a working tree that already installs.
This is the ONE deliberate deviation from CI, and it is stated in `--list`."* Measured with the
script's own parser, **eight** `pnpm install` steps survived that guard and were executed as steps:

```
policy               :: pnpm install --lockfile-only --ignore-scripts --no-frozen-lockfile
verify               :: pnpm install --frozen-lockfile
lint                 :: pnpm install --frozen-lockfile
e2e                  :: pnpm install --frozen-lockfile
migrations           :: pnpm install --frozen-lockfile
e2e-pgvector         :: pnpm install --frozen-lockfile
distributed-contract :: pnpm install --frozen-lockfile
browser              :: pnpm install --frozen-lockfile
```

The `policy` one is lockfile-MUTATING and `policy` is in the default fast gate, so every
`node scripts/ci-local.mjs` ran a command that can rewrite `pnpm-lock.yaml` in the working tree —
which the `Block manual lockfile edits` step in that same job then fails the PR for.

### ★★★ THE SECOND DEFECT, which the byte hid

Fixing the byte alone moved the surviving-install count **8 → 7, not 8 → 0.** The guard had only
ever sat on the multi-line `run: |` path, while **seven of the eight** installs are inline
`run: pnpm install --frozen-lockfile` steps that `parseJobs` pushes and `continue`s on, several
lines ABOVE the guard. So even a correctly-written regex could only ever have skipped ONE job's
install, and the premise that "the intended regex would have skipped all 8" is false.

That is the substance of this finding: a dead escape is visible once you know to look for it with
`cat -A`; a guard on the wrong code path is invisible in any rendering, and only a test that
asserts the CONSEQUENCE — the count — can see it. A byte-only fix, or a byte-only regression test,
would have gone green over a guard that still covered one eighth of its cases.

### ★ A third inaccuracy in the same three lines

The comment claimed the deviation "is stated in `--list`". It was not: `--list` printed job names,
step counts, env-gated counts and unrepresentable counts, and said nothing about installs — and
after the byte fix the skipped steps were dropped silently, so it still would not have. Three
claims in one comment, none of them true of the running code.

### The decision that was made deliberately rather than inherited

`policy`'s `--lockfile-only` install is skipped **too**, and not for the cost reason the original
comment gives. In CI that command sits behind two conditions this parser cannot see: a step-level
`if: github.event_name == 'pull_request'`, and a shell `if` that runs it only when a manifest file
changed. `parseJobs` keeps lines starting with `node`/`pnpm`/`npx` and drops the `changed=` / `if` /
`fi` scaffolding around them, so running it locally does not reproduce CI — it runs a command CI
would usually NOT run, with a side effect on a tracked file. Skipping it is the faithful behaviour.

### What changed

- The byte is now `\b`, and the predicate is a named `IS_INSTALL_STEP` consulted on **both** parser
  paths. Measured 8 → 0.
- Install steps are RECORDED as deliberate deviations rather than dropped, so `--list` and the run
  summary state the deviation the comment had only claimed they stated.
- `scripts/lib/__tests__/ci-local-install-guard.test.mjs` pins the consequence (0 surviving), the
  mechanism (both paths, ≥8 recorded), and the byte. All four mutants observed RED: re-inject the
  0x08; remove the inline-path guard; remove the block-path guard; over-broaden to all `pnpm`.
- `scripts/check-invisible-control-chars.mjs` generalises the byte half to the whole tree, wired
  into `policy`. See E6-F017.

---

## E6-F017 — sixteen raw control bytes sat in nine tracked text files, six of them corrupting explanatory prose including the post-mortem for this very defect — RESOLVED

**Status:** resolved
**Severity:** LOW individually; the reason it is filed is the CLASS, which has shipped three times,
twice after its own post-mortem was written down.
**Filed and resolved:** 2026-09-08 (W19). Census measured at `3814b90f3` and re-measured at this
PR's parent `c78a6827d`; the two trees give byte-for-byte the same result, so the rev is not what
moved the number.

### What was measured

A byte scan of every tracked text file found **16 raw control bytes in 9 files**. Every one of them
is the same shell-eaten-escape corruption or an authored byte written raw; **none** required
deleting an explanation to fix. The `bytes` column is the unit — a file can hold more than one:

| file | bytes | raw byte(s) | disposition |
|---|---|---|---|
| `docs/aoa/plans/2026-07-20-cli-auth-detection-plan.md` | 4 | 4× 0x08 BS | prose meant `` `\b5\d{2}\b` ``; the four `\b` were eaten, leaving the sentence naming a character it could not show. **Restored.** |
| `docs/replatform/qa/2026-08-31-blocker-ab-fix-design.md` | 1 | 0x08 BS | a Windows path `C:\pn\blockab\` with `\b` eaten. **Restored.** |
| `scripts/lib/worker-keystore-boundary.mjs` | 1 | 0x08 BS | the POST-MORTEM comment for this defect class, reading "where `<0x08>` was intended". **Restored.** |
| `packages/worker-daemon/src/supervisor/provider.ts` | 1 | 0x00 NUL | authored join separator → `"\0"` |
| `scripts/lib/__tests__/embedded-secret-scan.test.mjs` | **3** | 0x00 NUL, 0x01 SOH, 0x02 STX | authored fixture → `"\x00\x01\x02\uFFFD"` |
| `server/src/services/asset-content-guard.ts` | **3** | 0x00 NUL, 0x1f, 0x7f DEL | authored strip class → `/[\x00-\x1f\x7f]/` |
| `server/src/services/mcp-connectors.ts` | 1 | 0x00 NUL | authored sentinel → `"\u0000bound"` |
| `packages/browser-runtime/src/__tests__/path-adapter.test.ts` | 1 | 0x7f DEL | authored test input → `"evil\x7f.pdf"`; the two lines above it already used `\u0000` and `\n` |
| **subtotal repaired under this finding** | **15** | | across **8** files |
| `scripts/ci-local.mjs` | 1 | 0x08 BS | not this finding's repair — it is E6-F016's defect, filed and fixed directly above. Counted here because the scan does not know the difference. |
| **TOTAL, full-tree scan** | **16** | | across **9** files |

### ★★★ How to re-derive this census in one step

The number below is stated so it does not have to be trusted. **Banned set** is the guard's own
unit, `isBannedByte()` in `scripts/check-invisible-control-chars.mjs`: every C0 control byte
(0x00–0x1f) EXCEPT TAB 0x09, LF 0x0a and CR 0x0d, plus DEL 0x7f. **Scanned set** is every tracked
file `classifyPath()` calls `text`, decided by path and extension only, never by content — so the
62 binary blobs (PNG screenshots and the like), which hold ~800k of these bytes between them, are
out of scope by construction, and an unclassified type FAILS rather than being skipped.

Run the guard *from this branch* against a checkout of the parent, because the parent tree does not
contain the guard:

```
git worktree add --detach ../w19-parent c78a6827d
node scripts/check-invisible-control-chars.mjs --root ../w19-parent   # exits 1
git worktree remove ../w19-parent
```

It prints **one line per BYTE**, `path:line:col  NAME`. Verbatim, 2026-09-08:

```
invisible control characters in 9 file(s):
  docs/aoa/plans/2026-07-20-cli-auth-detection-plan.md:283:7  BS
  docs/aoa/plans/2026-07-20-cli-auth-detection-plan.md:283:14  BS
  docs/aoa/plans/2026-07-20-cli-auth-detection-plan.md:283:65  BS
  docs/aoa/plans/2026-07-20-cli-auth-detection-plan.md:283:72  BS
  docs/replatform/qa/2026-08-31-blocker-ab-fix-design.md:400:57  BS
  packages/browser-runtime/src/__tests__/path-adapter.test.ts:52:34  DEL
  packages/worker-daemon/src/supervisor/provider.ts:213:11  NUL
  scripts/ci-local.mjs:145:25  BS
  scripts/lib/__tests__/embedded-secret-scan.test.mjs:131:39  NUL
  scripts/lib/__tests__/embedded-secret-scan.test.mjs:131:40  SOH
  scripts/lib/__tests__/embedded-secret-scan.test.mjs:131:41  STX
  scripts/lib/worker-keystore-boundary.mjs:117:44  BS
  server/src/services/asset-content-guard.ts:77:16  NUL
  server/src/services/asset-content-guard.ts:77:18  0x1f
  server/src/services/asset-content-guard.ts:77:19  DEL
  server/src/services/mcp-connectors.ts:563:33  NUL
```

Sixteen lines, nine distinct paths — that is the whole derivation. Substituting `3814b90f3` for
`c78a6827d` prints the identical sixteen lines. Substituting this PR's head prints
`invisible control characters: PASS` and exits 0.

### ★ The number this record carried before, and why it was wrong

This finding first said "eight raw control bytes in seven text files". **Both numbers were wrong,
and wrong in the same way: they counted SITES, not BYTES** — one row per file-and-repair — so the
two files carrying three bytes each (`embedded-secret-scan.test.mjs` NUL/SOH/STX and
`asset-content-guard.ts` NUL/0x1f/DEL) were each counted as one, and an eight-row table was
summarised as "seven files". The total is precisely what hid them, which is why the per-file
breakdown above is now part of the record rather than a total standing alone.

It is worth stating plainly that this was the **third** count of the same corpus and the first
re-derivable one: 11-in-8 (which included a binary `.docx` and missed three bytes), then 8-in-7
(sites, not bytes), and only the external review on PR #384 noticed that neither reproduced from
the parent blobs. Three attempts to count invisible characters by eye produced three different
answers — the best argument this guard could have, and the reason a command now sits beside the
number. A false figure in the record justifying a guard is the exact class the guard exists to
prevent.

The hand-picked six-byte reconnaissance list (00 07 08 0b 0c 1b) would have **missed five of the
sixteen bytes**, and one file entirely: the 0x01 and 0x02 in `embedded-secret-scan.test.mjs` (whose
NUL it would have caught, so the file would have looked handled), the 0x1f and the 0x7f in
`asset-content-guard.ts` (likewise), and the `path-adapter.test.ts` hit, which is 0x7f alone and so
invisible to the list at file level too. (The earlier "missed three" here was the same
site-counting error, carried through.) That is why the guard bans a RANGE — C0 minus tab/LF/CR,
plus DEL — rather than a list.

### The objective harm, independent of taste

git classifies a file containing a NUL as BINARY and refuses to show its diff. **Four source files
were in that state**, so every change to them was unreviewable. Repairing them took the
repository's NUL-bearing file count from 66 to 62 — the four are diffable text again. "The author
meant it" is therefore not a sufficient defence for the raw byte.

### The guard, and why it is not the checker that gets deleted

The same post-mortem warns: *"a plain substring scan over raw source … flagged `command-runner.ts`
for the COMMENTS explaining why existsSync was removed: a checker that makes you delete the
explanation of a bug is a bad checker."*

`scripts/check-invisible-control-chars.mjs` bans the raw BYTE and permits every ESCAPE that denotes
the same character. Because the scan reads bytes, escapes are invisible to it by construction — no
exception machinery, no allowlist, no intent-reading. The repair for a legitimate use is a rewrite
to an escape denoting the identical character; the repair for a corrupted one restores meaning.
**The tree reached zero hits with no allowlist, no suppression comment, and not one word of
explanation removed. Three explanations were restored.** An allowlist of the day's findings was
rejected outright: it catches nothing new.

File type is decided by path and **never** by content. The usual NUL-sniff for binaries is
self-defeating here — the NUL being hunted would exempt its own file, which is exactly the state
the three `.ts` files above were in. Classification is default-deny: a tracked file whose type is in
neither list fails until someone classifies it. That rule earned its keep on its first run,
surfacing sixteen unclassified types, most of them text (`.mts`, `.jsonl`, `.npmrc`, `.mailmap`,
`.webmanifest`, PEM `.key`/`.crt`) that a hand-written list had silently skipped.

### ★★★ The evasion, stated rather than claimed away

The guard was measured EVADED at zero cost by three invisible characters that are not bytes:
U+200B ZWSP, U+202E RLO and U+00AD SHY each passed a full run. Two were then closed, chosen by
measurement: bidi overrides (U+202A–U+202E, U+2066–U+2069) and SHY have **zero** legitimate uses in
the tree and are a documented exploit class (Trojan Source, CVE-2021-42574). **U+200B, U+00A0 and
U+FEFF remain legal**, deliberately — the tree has six legitimate uses and one of them (a ZWSP
writing a close-comment sequence inside a JSDoc block) has no escape-based repair.

So the honest verdict: this guard is **complete against the accident it was built for** — a shell
can only ever emit a C0 byte — and it is **not a security boundary**. Anyone who wants to hide a
character can still do it with one zero-width space. `scripts/lib/__tests__/invisible-control-chars.test.mjs`
asserts that limit as a passing test so it cannot quietly be forgotten or over-claimed later.

---

## E6-F018 — the new control-character guard's ENTRY POINT was unpinned: deleting `process.exit(1)` kept every test and a clean-tree CI run green — RESOLVED

**Status:** resolved
**Severity:** MEDIUM — the guard's library was covered by eighteen tests; its EXECUTABLE, which
is the thing the workflow calls, was covered by none. The consequence is a CI step that reports
success over a planted control byte it has just printed to the screen.
**Filed and resolved:** 2026-09-08 (W19 round 2), on the same PR that introduced the guard. Found
by an adversarial mutation pass: sixteen mutants were landed against E6-F016/E6-F017's work,
fourteen went red and **two survived** — this and E6-F019, the same shape twice.

### What was wrong

`scripts/check-invisible-control-chars.mjs` ends its `main()` with

```
  if (violations.length > 0 || unclassified.length > 0) process.exit(1);
  console.log(`invisible control characters: PASS (...)`);
```

Delete that one line and **every test still passed**, `node --test` exit 0, and a clean-tree run
of the script still exited 0 — because on a clean tree the exit code is 0 either way. Neither
`invisible-control-chars.test.mjs` nor `ci-local-install-guard.test.mjs` contained the word
`spawn`; both import the module and exercise `evaluateTree`, `scanBuffer`, `classifyPath` and the
byte tables. None of them can observe an exit code, because an exit code does not exist inside the
module.

Measured against a throwaway git tree holding one file with a planted 0x08, the mutant printed
**both halves at once**:

```
--- stdout ---
invisible control characters: PASS (1 text files scanned, 0 raw control bytes)
--- stderr ---
invisible control characters in 1 file(s):
  scripts/planted.mjs:1:19  BS
--- exit status: 0 ---
```

So the `policy` step would have gone GREEN on a dirty tree while naming the violation on screen.
That is the repository's own "a check that nothing runs is not a check", one layer down: the
library was checked, the executable never was, and the executable is what CI invokes.

### ★ Why the library tests could not have caught it, in principle

This is not an oversight that more library tests would fix. The defect lives in the two lines
between "the library computed the right answer" and "the process told the operating system about
it". A test that imports the module has no process boundary to observe, so the ONLY instrument
that can see this is a subprocess with a status code. Import-only coverage of a CLI is a
structural blind spot, not a thin spot.

### What changed

`invisible-control-chars.test.mjs` gained one test that spawns the real script three times over a
throwaway git repository (one `git init`, ~250 ms total) and asserts the exit STATUS each time:

| fixture | expected | what it pins |
|---|---|---|
| a planted raw 0x08 | exit **1**, the file+`BS` named on **stderr**, and `PASS` absent from stdout | the mutant above |
| the same line written `\b` (two characters) | exit **0**, `PASS` on stdout | the POSITIVE CONTROL — without it a red is not a verdict about the byte, only about the harness |
| an unclassified `.rb` | exit **1**, `DEFAULT-DENY` on stderr | the second disjunct of the same `if`, which a narrower mutant drops |

The fixture must be a git repository: `listTrackedFiles` follows the index, so pointing `--root`
at a plain directory would scan zero files and pass vacuously — the same failure in a new costume.

**Four mutants observed RED against the new pin** (all previously green): delete `process.exit(1)`;
drop the `|| unclassified.length > 0` disjunct; make the exit unconditional (caught by the positive
control, not by a negative one); and break `invokedDirectly` so `main()` never runs.

---

## E6-F019 — the `invokedDirectly` conditional this PR ADDED could turn `scripts/ci-local.mjs` into a silent no-op that exits 0 with no output — RESOLVED

**Status:** resolved
**Severity:** LOW-MEDIUM — `ci-local.mjs` is a developer runner, not a CI lane, so no gate depends
on it. It is filed anyway because the failure mode is the one this programme keeps paying for: a
tool that returns the success code having executed nothing, which reads to its operator as "your
tree is clean".
**Filed and resolved:** 2026-09-08 (W19 round 2). **This hole did not exist before this PR** — it
was opened to make E6-F016's pin possible, and is closed in the same change.

### What was wrong

`main()` in `scripts/ci-local.mjs` used to be unconditional. Exporting `parseJobs` so the pin could
call the REAL parser (rather than re-implement it, which cannot catch a parser regression) required
guarding the call:

```
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
```

That conditional is a new place for a regression to hide, and the mutation pass proved it. Drop the
`fileURLToPath` call — a plausible refactor, since the two sides look comparable — and the predicate
compares a filesystem path to a `file://` URL, which is false on every platform forever. Measured:

```
$ node scripts/ci-local.mjs --list   ->  exit 0, zero bytes of output
$ node scripts/ci-local.mjs          ->  exit 0, zero bytes of output
$ node --test scripts/lib/__tests__/ci-local-install-guard.test.mjs  ->  5/5 pass
```

All five tests imported the module; none ran the script.

### What changed

Two tests, both spawning the real entry point, ~75 ms combined:

- `--list` from the repository root: exit **0**, and — the assertion that matters — the stdout must
  actually contain `jobs in pr.yml:`, name six real jobs from the workflow, carry at least ten job
  lines, and print `INSTALL_SKIP_REASON` **verbatim**. Status alone cannot distinguish "ran and
  passed" from "never ran": the mutant returns 0 too. Output is the only discriminator.
- run from an empty directory: exit **2** with `no workflow at …` on stderr and nothing on stdout,
  pinning `main()`'s other exit code against the same deletion E6-F018 describes.

`--list` is chosen because it is the only invocation that reaches `main()` without executing a CI
job — a real `node scripts/ci-local.mjs` run is the fast gate and takes minutes, a cost this suite
may not impose — while still exercising `existsSync`, `readFileSync`, `parseJobs`, the
`CANNOT_RUN_HERE` table and the deviation reporting.

**Three mutants observed RED** (all previously green): the `invokedDirectly` no-op (reds BOTH
tests); deleting `process.exit(2)`; and — from E6-F018's pass — the same class on the sibling script.

### ★ The class, and the census of it in this change

Two of sixteen mutants surviving is a class, not a pair, so the rest of the PR was swept for the
same shape. Of the seventeen files it touches, exactly **two** contain an entry point
(`#!`/`import.meta.url`/`main()`): these two scripts. The others are prose, data manifests, or
escape rewrites inside libraries. A third entry point — the `pr.yml` step itself — was tested by
deleting its whole `run:` body: `check-guard-inventory.mjs` exits 1 with *"declared 'ci' but no
workflow invokes it"* and `check-execution-census.mjs` exits 1 with `not_named_in_step` for both
test files. That wiring was already pinned; the two script entry points were the whole gap.

## E6-F020 — the invisible-character guard's OWN documented gap recurred within hours, and its stated reason for leaving the gap open ("no repair exists") is refuted by the repair made here

**Status:** `resolved` · **Severity:** MED · **Owner:** `unowned` (at filing; closed by ruling, not
by an owner)
**Filed:** 2026-09-08, by SVC-002 design review (branch `replatform/svc-002-design`), against work
done in the same PR that hit it.
**RESOLVED 2026-09-09 by founder ruling, via resolution option 2 (§4), NOT option 1.**

> ★★★ **THE RULING, and the principle that decides it.** The guard is **NOT widened** — ZWSP, NBSP
> and BOM stay legal. What was wrong was the guard's *description of itself*, and that is what was
> repaired.
>
> The guard's rule is **"ban the raw byte, permit the ESCAPE."** That rule can only be applied
> where an escape can be written — and **inside a block comment there IS no escape, only a
> REWRITE.** So the byte scan covers the **ACCIDENT class** (a shell injecting a C0 byte, which has
> shipped here three times and which the scan is complete against) and **not the AUTHORED class**
> (a human typing an invisible codepoint on purpose). Those are different classes with different
> remedies; the byte scan was never a candidate for the second. That boundary is now stated in the
> header as **deliberate scope, not a known hole**.
>
> The one ZWSP found in practice was **load-bearing** (§1: deleting it stops the file parsing), which
> is what makes this a scope question rather than a hygiene one.
>
> **The rewrite recipe is now recorded in both places** (`scripts/check-invisible-control-chars.mjs`
> header, `scripts/lib/__tests__/invisible-control-chars.test.mjs` `THE DOCUMENTED LIMIT`): *convert
> the block comment to `//` line comments* — line comments have no terminator, so a star followed by
> a slash is written literally and no invisible character is needed. That is the four-character
> repair §2 item 2 demonstrated, and the next author now finds it instead of reaching for a ZWSP.
> Both narration sites were also corrected on the two claims this finding refuted: **"2 uses"** no
> longer reads as a fixed grandfathered set (it is a **recurring pattern**), and **"no escape-based
> repair exists"** no longer stands in for **"no repair exists"**.
>
> **Option 1 was considered and REFUSED, not deferred:** banning ZWSP/NBSP/BOM without a rewrite for
> every legitimate use is the cry-wolf failure that gets a guard switched off — which is strictly
> worse than a stated boundary. §4's option-1 text is retained below as the recorded path if it is
> ever revisited.
>
> **What this ruling does NOT claim.** The residual in §2 is unchanged and still true: one
> zero-width space still evades this guard, it is still not a security boundary against a deliberate
> adversary, and nothing counts the authored class. The ruling changes what the repository *says*
> about that, not what it *catches*.


**Affected tickets:** none on disk. See "Why `unowned`".
**Blocks gate:** no. Nothing is currently mis-enforced; the character is gone and the file's 24 tests
pass.

### 1. What happened, and the first draft of this finding got the cause wrong

`scripts/check-threat-control-audit-debt.test.mjs:97` shipped a **U+200B ZERO WIDTH SPACE** inside a
JSDoc comment, between the `*` and the `/` of a glob path:

```
/** An id no `docs/replatform/epics/*<U+200B>/tickets/` file can ever start with, so "not on disk" …
```

**It was not a stray keystroke.** Delete the ZWSP and the file **stops parsing** — `*/` closes the
block comment, and `node --test` fails with `SyntaxError: Unexpected identifier 'findTicketIds'`.
The character was load-bearing. It is therefore a third instance of **exactly the use
`check-invisible-control-chars.mjs` counted and excused**: *"U+200B ZWSP (2 uses — one writes a
close-comment sequence inside a JSDoc block, which cannot be expressed as an escape because it is a
comment)."*

That is recorded because the first draft of this finding said the character *"was introduced while
writing the comment"*, framing it as an authoring slip. **That was wrong, and it was refuted by
running the file rather than by reading it.** The correct statement is narrower and worse: the
guard's documented exception is not a fixed set of two grandfathered sites, it is a **recurring
pattern** — anyone writing a glob or a regex inside a JSDoc block reaches for it — and nothing in
the repository counts it, because it is invisible by construction.

**The repair, which is the load-bearing part.** The comment is now a run of `//` line comments, which
have no terminator, so the glob is written literally and no invisible character is needed. The file's
24 tests pass. The guard's parenthetical *"cannot be expressed as an escape"* is true and is **not
the same claim** as "no repair exists": a rewrite repair exists, costs four characters, and is the
one the guard's own design constraint asks for (*"the repair for a legitimate use is a rewrite that
denotes the identical character. Nothing is ever deleted."*).

**Scan of the whole PR**, by codepoint, over all changed files
(`docs/architecture/distributed-execution-audit-debt.json`, `SVC-002-design.md`,
`SVC-002-terrain.md`, `scripts/check-threat-control-audit-debt.test.mjs`, and this register plus
`docs/replatform/epics/E9-service-agents/findings.md`):

| Codepoint | Count before | Count after |
|---|---|---|
| U+200B ZWSP | **1** | 0 |
| U+00A0 NBSP | 0 | 0 |
| U+FEFF BOM | 0 | 0 |
| U+2028 LS | 0 | 0 |
| U+2029 PS | 0 | 0 |
| U+0085 NEL | 0 | 0 |
| U+2060 WJ | 0 | 0 |
| U+180E MVS | 0 | 0 |

One character, one file, one line. It was found by an explicit codepoint scan, not by review and not
by CI.

### 2. ★ Why this is a finding and not a typo

`scripts/check-invisible-control-chars.mjs` bans raw **C0/DEL bytes** and states, in its own header,
that this set does not:

> *"STILL LEGAL, DELIBERATELY (legitimate uses found, and no escape-based repair exists for some of
> them): U+200B ZWSP (2 uses …), U+00A0 NBSP (4 uses …), U+FEFF BOM (3 files). … the residual is
> real and is stated rather than papered over: anyone who WANTS to hide a character in this
> repository can still do it with one zero-width space."*

That limit is pinned by a **passing** test —
`scripts/lib/__tests__/invisible-control-chars.test.mjs:224-241`,
*"★ THE DOCUMENTED LIMIT: ZWSP, NBSP and BOM still evade this guard, on purpose"* — which asserts
that a ZWSP produces **zero** violations, and whose comment says: *"If that ever needs to change, the
change is to ban ZWSP/NBSP and repair the six legitimate uses; this test is the place that decision
gets recorded."*

**So the gap was measured, documented and pinned — and the very use it excused recurred within
hours, in a new file, without anybody deciding to use it.** Two things follow, and they are the whole
content of this finding.

1. **The census is not a fixed set.** *"2 uses"* reads like two grandfathered sites to be repaired
   once. It is not: it is a pattern that regenerates whenever someone writes a glob or a regex
   inside a JSDoc block, and **nothing counts it**, because the character is invisible in every
   terminal, editor, diff view and code-review UI. This instance was found by an explicit codepoint
   scan run for an unrelated review — not by CI, not by a reader, and not by the author.
2. **"No escape-based repair exists" is not "no repair exists", and the difference decides the
   question.** The header's parenthetical is literally true — an escape cannot appear in a comment —
   and it is doing the work of a much stronger claim in the decision to leave ZWSP legal. The repair
   in this PR is four characters: `/** … */` becomes `// …`, the glob is written literally, and the
   file's 24 tests pass. If that generalises to the other ZWSP site, option 1 below is materially
   cheaper than the guard's own note assumes.

### 3. What is deliberately NOT done here

**The guard is not widened in this PR.** The PR is a design document for service reconciliation;
widening a repository-wide policy guard inside it is exactly the smuggling this programme's registers
exist to prevent — and it would be the second time in two waves that a policy change rode a ticket
about something else. The cost is also not zero: the guard's census found **six legitimate uses**
(2 ZWSP, 4 NBSP) plus 3 BOM files, and each needs a rewrite, not a deletion — *"a checker whose only
remedy is deletion gets deleted itself"* is that guard's own founding constraint. Banning without an
answer for every one of them is the cry-wolf failure that gets a guard switched off.

### 4. Why `unowned`, and what would close it

`unowned`: no ticket on disk owns the invisible-character guard's scope. E6-F017/F018/F019 (its
ancestors) are all RESOLVED, and naming a shipped ticket would be the false-ownership claim E4-F013
exists to refuse. NOT `accepted`: accepting would re-assert the rationale this occurrence is evidence
against, and the decision is a real one with a real cost, not a nit.

**Resolution — one of these two, decided deliberately.** ★ **DECIDED 2026-09-09: option 2. See the
ruling block at the head of this finding.** Option 1 is retained below as the recorded path if the
decision is ever revisited; it was refused, not deferred.

1. Add U+200B / U+00A0 (and a BOM rule) to `BANNED_CODEPOINTS`, repair the remaining legitimate uses
   the way this PR repaired its own (block comment → line comments; the rewrite, not an escape), and
   **invert** the `THE DOCUMENTED LIMIT` test so it asserts the ban with a positive control; or
2. Record, with reasons, that the residual stays open — and amend the guard header and that test so
   the census reads as a **recurring pattern with a known rewrite**, not as two grandfathered sites
   with no repair.

Either way, flip this Status and DELETE the `scripts/finding-ownership.json` key in the SAME commit.
