# DEP-010 — The provider seam: one authoritative port and a composition root that supplies it

**Epic:** E6 · **Plan node:** `docs/replatform/program-design.md`, `#### DEP-010`
**Depends on:** DEP-000, WRK-004, CLI-001 (all shipped) · **Size:** M · **Status:** design
**Sprint:** 2 (see `docs/replatform/GO-BOOK.md`)
**Revision:** 2 — round-2 review + the cross-plan completeness critic applied; see §-2. Revision 1
(GO-BOOK decision **D-4**) is kept below at §-1.

---

## ★ -2. REVISION 2 — the citations rotted, a finding went unowned, and the primary proof expires

Round 2 was two passes: a re-review of this plan, and a **completeness critic** that read the three
Sprint 1–3 plans *as a set* — which is the only vantage from which three of these are visible at all.
Revision 1's motto was *a mitigation nothing performs is not a mitigation*. Revision 2 adds two more
of the same family: **a citation that no longer resolves is not evidence**, and **a proof with an
expiry date is not a standing property** unless the expiry is written down.

| # | What was wrong | Where it is fixed |
|---|---|---|
| **E1** | **Every citation of go-book decision D-3 pointed at the wrong line** — five `:404`s and two `:394`s, plus two stale `:127`/`:236-237`s. The pointers were *correct when written*; revision 1 inserted 22 lines above the ledger in **the same commit** that claimed re-verification, and has since moved again (the ledger is now §8 at a third set of coordinates). | §0's citation convention, and every occurrence — **fixed as a class, not as seven instances** |
| **E2** | **E4-F011 (HIGH) is `owned` by DEP-010 and this plan never mentioned it.** §2 was headed "all three". The finding asks for something no guard can check: a *written* decision about which root gets a provider and what the dispatch flag defaults to there. | §2 (fourth row), **§4.3** (the written decision), §5, Step 11, §9 |
| **E3** | **D12's "explicit env" does not remove the credential from the path that reads it.** `requireApiKey` reads the **ambient** `process.env.E2B_API_KEY` (`real-transport.ts:54`); filtering a *copy* changes nothing it observes. D12 recorded a hazard as closed by a mechanism that does not touch the read site. | Step 6 ★D12 (rewritten and narrowed), §8 residual 5 |
| **E4** | **§4.1's structural lock expires at Sprint 3 and nothing in the set replaces it.** The plan half-said this ("the mutation slice 2b will make for real") and never drew the consequence. | **§4.2** — new, and it is the sentence the critic asked for |
| **E5** | **This ticket invalidates four WRK-008 slice 2b assertions on arrival**, including a guard that would land in the always-on `policy` job. 2b was written against the pre-DEP-010 tree; the go-book runs it after. | **§10** — new, addressed to the Sprint 3 operator |
| **E6** | **Naming coordination:** slice 2b Step 9a declares the D1 provider gate as `AOA_WORKER_PROVIDER_URL`; this ticket's resolver never reads it. | **§10.2** |
| **E7** | **Step 5's three-element dependency pin turns the always-on `policy` job red** — 15 of the self-test's 18 cases share one two-dependency fixture. Reproduced. | Step 5, §5, §6's standing-rule table |
| **E8** | **§4.1/Step 8 named `BootstrapResult` as the observation surface** for "no loop was composed". It carries no such information. | §4.1, Step 8 (the observable is now named) |

**Three findings revision 2 handles DIFFERENTLY from the way they were filed, and why:**

1. **"Step 8 mutation (c) on `selfModel: null` cannot fail."** Refuted. The plan prescribes **(b)+(c)
   jointly** — the "Required failure" cell says so in its own words — and that pair is the *only*
   prescribed state in which the real `bootstrapWorkerDaemon` is observed at `compose === true`,
   which is the only state where the §4.1 primary proof is non-vacuous. Dropping (c) would leave the
   inertness lock asserted only where nothing would have composed anyway. **One clause was still
   over-broad and is corrected in §4.1:** the fourth gate is *not* untested — `compose-dispatch.ts:65`
   is falsified today by `packages/worker-daemon/src/__tests__/compose-dispatch.test.ts:54-59`. What
   was missing is a **root-level** entry, and (c) alone is inert because `compose-dispatch.ts:64`
   short-circuits while `bin/worker-daemon.ts:344` is `false` (pinned at `compose-dispatch.test.ts:92-100`).
2. **"`GO-BOOK.md:236-237` is cited for a claim it does not make."** True, and subsumed by E1 — but
   the *substantive* half is a bigger correction than the citation: **slice 2b is no longer the very
   next sprint.** The go-book inserted **Sprint 2.5** (WRK-010 slice 2) between this ticket and it.
   §4.1 said "the very next sprint"; it now says what the sequence actually is.
3. **"14 of 17 cases fail"** (E7). Close, and measured here as **15 of 18** — the count matters
   because the fifteenth is `the REAL package on disk passes clean`, which Step 5's own
   `package.json` edit fixes, while the other fourteen need the *fixture* bumped. Two different
   edits, one commit.

---

## ★ -1. REVISION 1 — the plan was right about the tree and wrong about CI

Adversarial review could not falsify any of §0's core grounding claims (`PROVIDER_HOST_PATH` was
checked against the scanner and works exactly as described). Every defect it found was in one of
two places: **CI mechanics the plan would break**, and **mitigations the plan asserted that do not
exist**. Both classes are the same failure the guard-inventory work named — *a check that nothing
runs is not a check*, and here, *a mitigation nothing performs is not a mitigation*.

| # | What was wrong | Where it is fixed |
|---|---|---|
| D1 | The plan makes `check-gate-clause-wiring.mjs` go RED and Step 11 told you to let it. | §0.1, §5, Step 6 |
| D2 | `scripts/test-inventory.json` pins the two packages this ticket adds tests to. | §0.1, §5, Steps 2/3/6, Step 11 |
| D3 | `sandbox-e2b-provider` is never pre-built in CI, and its exports resolve to `./dist`. Green locally, red in CI. | §0.1, §5, Step 5 |
| D4 | Step 9's positive control #4 tested the wrong guard — a mislabelled duplicate of #2. | Step 9 |
| D5 | "The staging manifest regenerates, so nothing drifts silently" — the assembler REFUSES to run. | §3.3.5, §8.2 |
| D6 | The inertness proof keyed on a scaffold Sprint 3 deletes. | §4, Step 8 |
| D7 | §3.2's "worker-keystore never names the credential" had zero enforcement. | §3.2, Step 5, Step 6 |
| D8 | Step 10's new invariant was narrower than the one it sits beside. | Step 10, §7 |
| D9 | The E6-F003 rewrite named the wrong network — in staging that sentence describes a violation. | §2.1 |
| D10 | E6-F008 was closed against the wrong half, and against a weaker bar than its own resolution text. | §2.2, §8 |
| D11 | The crosswalk edit could hard-fail `check-dependency-graph.mjs`. | Step 11 |
| D12 | Step 6's default-loader test was environment-dependent. | Step 6 — **and the revision-1 fix for it did not work; see §-2 E3** |
| D13 | §8.3 understated what relocating the adapter costs. | §8.3 |
| D14 | The two new operator switches would go undocumented with no guard firing. | §5, Step 11 |
| D15 | Two off-by-one citations. | §0 |

**Two places the code disagreed with the review, and the code wins:**

1. **D3 said "add the build to BOTH pre-build steps."** Only the `verify` job's list
   (`.github/workflows/pr.yml:743-751`) is load-bearing: it is the one that runs `pnpm -r typecheck`
   and the root `pnpm test:run`, and the root vitest project list includes
   `packages/worker-keystore` (`vitest.config.ts:24`). The `distributed-contract` job's list
   (`:1168-1173`) runs only the three provider packages' own suites plus two server files, none of
   which resolves `@armyofagents/sandbox-e2b-provider` by name — so adding the line there is
   symmetry, not necessity. Both are added anyway (the two lists have been kept identical since
   CLI-001, and a divergence is a future trap), but §7 marks only the `verify` one as required.
2. **D15's `finding-ownership.mjs` correction is right and slightly conservative.** The stale loop
   is `:132-136`; `:130-131` is its explanatory comment. `:129` (which the old text included) is a
   blank line. Cited as `:132-136`.

**And one thing neither the plan nor the review had.** Step 0 was written as "present the case and
obtain approval". **The approval already exists.** Go-book decision **D-3** (`GO-BOOK.md`
**§8**, the decisions ledger headed *"settled 2026-08-25, do not relitigate"*) approves the keystore widening
on **three named conditions** — and, independently of this review, records the same D5 defect: *"the
earlier approval leaned partly on the staging-manifest mitigation — that build refuses to run, so it
mitigates nothing."* Step 0 is rewritten from a request into a **conditions check**, mapped
condition-by-condition to the steps that satisfy each. A plan that re-asks a settled question is how
a settled question comes unsettled.

---

## 0. Grounded by — every load-bearing claim re-verified

**★ Citation convention (revision 2).** Source files are cited by `path:line`, because a line in
`packages/…` moves only when someone edits the code the claim is about, and the diff then shows it.
**Living documents are cited by section and id, never by line** — the go-book (`§8`, decision `D-3`),
the findings registers (`E4-F011`, `E6-F008`), the crosswalk (`CM-010`), the plan graph
(`#### MIG-008`), `environment-variables.md` (the row's variable name). This is not style. Revision 1
cited `GO-BOOK.md:404` for D-3 five times and `:394` twice; the same commit that wrote those
re-verified pointers inserted twenty-two lines above the ledger, and the pointers have since moved a
second time. The decision **id** is the primary key of a table; a `grep` resolves it in any revision.
A line number into a document that is still being written is a claim with a half-life.

| Claim | Verified at |
|---|---|
| worker-daemon DEFINES a per-op `SandboxProvider`, implements it **zero** times | `packages/worker-daemon/src/supervisor/provider.ts:330`; the only `implements` in-package is the test double `src/__tests__/support/fake-provider.ts` |
| The port is declared authoritative **in worker-daemon**, deliberately not relocated | `provider.ts:10-14` — "The port stays authoritative HERE in worker-daemon" |
| The port is **transport-agnostic**, so a networked driver can bind it later | `provider.ts:16-21` |
| The contract package defines a **structurally different** port | `packages/sandbox-provider-contract/src/port.ts:146` (`SandboxProviderDriver`, one `invoke(op,args)`), mismatch spelled out at `:14-26`, tracked as E6-F008 |
| The only production implementation is `E2bSandboxProvider` | `packages/sandbox-e2b-provider/src/e2b-provider.ts:136` |
| …in a package that **depends on** worker-daemon | `packages/sandbox-e2b-provider/package.json:26` |
| …so the daemon importing it is an **E4-D01 breach AND a cycle** | `packages/worker-daemon/src/lifecycle/compose-dispatch.ts:9-17` |
| `@armyofagents/sandbox-e2b-provider` is in **no other** package.json dependency list | `grep -rn "sandbox-e2b-provider" --include=package.json .` returns only its own `name` (`package.json:2`) |
| The bridge between the two ports **already exists and is shipped** | `packages/sandbox-e2b-provider/src/per-op-adapter.ts:112` — `perOpToInvokeDriver`, header "CLOSES finding E6-F008" |
| …and it bridges **per-op → driver only**; there is no driver → per-op direction | `per-op-adapter.ts:112-115` (`(provider: SandboxProvider) => SandboxProviderDriver`) |
| The fake implements the **contract** port structurally, importing neither | `packages/sandbox-fake-provider/src/fake-driver.ts:5-8` |
| A composition root **already exists** and passes no provider | `packages/worker-keystore/src/bin/desktop-host.ts:101`, `:254-260` |
| …and its deps are daemon + protocol only | `packages/worker-keystore/package.json:27-30` |
| The daemon already has the `provider` seam and refuses without it | `bin/worker-daemon.ts:159`, `:338`; `compose-dispatch.ts:62` |
| The daemon boundary pins deps to exactly two | `scripts/lib/worker-daemon-boundary.mjs:53` **(was cited `:52`)** |
| The **keystore** boundary pins deps to two…| `scripts/lib/worker-keystore-boundary.mjs:56-59` **(was cited `:47-60`)** |
| …and calls any addition a **STOP** | same file `:20-24` (module header), **not** at the constant |
| …rejects every other bare specifier | `:94-97` (`ALLOWED_BARE`), applied at `:152` |
| …and confines subprocess execution to ONE PATH | `:71` (`SUBPROCESS_HOST_PATH`), applied at `:144-151` |
| The fake/contract boundary pins deps to exactly two | `scripts/lib/sandbox-fake-provider-boundary.mjs:45` |
| `AOA_WORKER_DISPATCH_ENABLED` is default-OFF, refuses an unrecognised value | `packages/worker-daemon/src/config/config.ts:69`, `:150-162` **(was cited `:142-162`)** |
| The `compose:true` branch **does not exist** — that is WRK-008 slice 2b | `bin/worker-daemon.ts:337-349` **(was cited `:331-350`)**; the `if (!dispatch.compose)` at `:347-349` has **no `else`** |
| `hasSelfModelReader` is hardcoded `false` — and there is a SECOND hardcoded falsy beside it | `bin/worker-daemon.ts:344`; `selfModel: null` at `:345` |
| …and `hasSelfModelReader` is scaffolding Sprint 3 removes | `compose-dispatch.ts:44` — "This reason retires when 2b lands"; `GO-BOOK.md` **§3** (the spine: `S3  WRK-008/2b dispatch COMPOSED (not live)`) and **§4** *Sprint 3* |
| Staging forbids `E2B_API_KEY` on every worker; it lives only on `adapter-manager` | `docker-compose.staging.yml:23-28`, `:316-323`; `scripts/lib/staging-manifest-invariants.mjs:120`, `:436-493` **(was cited `:436-470`; the command/entrypoint arm is `:476-481`)** |
| `adapter-manager` has **zero implementation** | `docs/replatform/DECISION-byte-egress-and-provider-topology.md` **§4 residual 4.2** |
| The findings register is CI-enforced; a stale entry FAILS | `scripts/lib/finding-ownership.mjs:132-136` **(was cited `:129-136`)**; `.github/workflows/pr.yml:288-298` |

**The one-sentence problem.** A port with zero implementations, an implementation no process can
construct, and a root that never asks for one: three independently-correct pieces and nothing that
joins them.

### 0.1 The CI mechanics this plan must not break — the half revision 1 added

Every row below is a fact about *this repository's gates*, not about the provider seam. The first
three are the ones that would have turned a correct implementation red.

| Fact | Verified at |
|---|---|
| The `policy` job is **always-on** — no `changes` gate, so it runs on a docs-only PR too | `.github/workflows/pr.yml:124-126` |
| `gate-clause-wiring.json` declares `E7-1-coding-journey` **`unwired`**, symbol `E2bSandboxProvider`, with **no `expectedReferences`** | `scripts/gate-clause-wiring.json` (`E7-1-coding-journey` block) |
| …so the count today is **0**, and any production file naming the symbol makes it ≥1 | `node scripts/check-gate-clause-wiring.mjs --counts` → `0  E2bSandboxProvider` |
| …and `count > expected` raises **`unwired_but_now_has_caller`** → `process.exit(1)` | `scripts/lib/gate-clause-wiring.mjs:105-113`; `scripts/check-gate-clause-wiring.mjs:126` |
| …the counter blanks imports and re-export blocks but counts an **interface property** and a **`new mod.X(...)`** line | `check-gate-clause-wiring.mjs:66-90` |
| `test-inventory.json` **pins** `packages/worker-daemon` at **131** and `packages/worker-keystore` at **18** | `scripts/test-inventory.json:47-54`; disk count confirms 18 keystore files |
| …and membership counts **any code file under a `__tests__` directory**, not just `.test.ts` | `scripts/lib/test-inventory.mjs:65-72` |
| …a pinned tree is an exact contract in BOTH directions; adding a file is `pinned_mismatch` | `scripts/check-test-inventory.mjs:109-112` |
| `scripts` is pinned at **46** — but only NEW `.mjs` test *files* count, and this ticket adds none | `scripts/test-inventory.json:59-62` |
| `sandbox-e2b-provider` exports resolve to **`./dist`** and it is **never pre-built** in CI | `packages/sandbox-e2b-provider/package.json:6-13`; `.github/workflows/pr.yml:743-751`, `:1168-1173` |
| …and `verify` runs Typecheck + Run tests **BEFORE** Build | `.github/workflows/pr.yml:753-760` |
| …and the root vitest project list **includes `packages/worker-keystore`** | `vitest.config.ts:24` |
| A lockfile edit is allowed **only when a manifest change rides with it** in the same PR | `.github/workflows/pr.yml:134-145` |
| `check-sandbox-fake-provider-boundary.mjs` covers **only** the two DEP-000 packages; it never reads worker-daemon's manifest | `scripts/check-sandbox-fake-provider-boundary.mjs:38-41` |
| …and its scanner catches **`import type`** lexically (a static import is found by scanning forward to `from`) | `scripts/lib/worker-protocol-boundary.mjs:368-379` |
| `build-desktop-staging.mjs` **REFUSES to run** — producing its input is an unsolved step | `scripts/build-desktop-staging.mjs:21-30` |
| …and the only thing CI runs is its unit test | `.github/workflows/pr.yml:365` |
| …and the embedded-secret scan already had to prune third-party READMEs/benchmarks to stay green | `scripts/lib/staging-manifest.mjs:41-51` |
| In **staging**, workers are on `[control-net, store-egress-net]`; `adapter-manager` on `[control-net, provider-ctl-net]` | `scripts/lib/staging-manifest-invariants.mjs:63-70` |
| …so a worker on `provider-ctl-net` is a hard `PROVIDER-CONTROL VIOLATION` | same file `:438-443` |
| In **`docker-compose.d1.yml`** the same name means the opposite: `worker-a` (`:332`) and `worker-b` (`:368`) ARE on `provider-ctl-net` | `docker-compose.d1.yml:14-22` (the matrix comment), `:332`, `:368`; also `control-plane` `:218`, `control-plane-b` `:289`, `fake-provider` `:398` |
| `worker-keystore-boundary.mjs` has **no credential-token rule** — its only token ban is `existsSync` | `scripts/lib/worker-keystore-boundary.mjs:88`, `:171-177` |
| …while the e2b leaf has exactly the rule this plan needs, over **raw source** (so a comment counts) | `scripts/lib/sandbox-e2b-provider-boundary.mjs:56`, `:126-128` |
| …and both keystore and e2b scanners **skip `.test.ts`** entirely | `scripts/lib/worker-protocol-boundary.mjs:94-99`; `scripts/check-worker-keystore-boundary.mjs:112` |
| `createRealE2bTransport` throws **synchronously in the constructor** when no key, with `E2B_API_KEY` in the text | `packages/sandbox-e2b-provider/src/real-transport.ts:53-59`, `:84`, `:238` |
| …reading `process.env.E2B_API_KEY` directly, so a developer's exported key changes the outcome | `real-transport.ts:54` |
| brand-check guard 9 matches **only** literal `process.env.AOA_[A-Z_]+` in `*.ts` | `.github/workflows/pr.yml:648-663` |
| …which is why `AOA_WORKER_DISPATCH_ENABLED` (read via the `ENV` map at `config.ts:69`) is documented by discipline, not by a guard | `docs/deploy/environment-variables.md`, the `AOA_WORKER_DISPATCH_ENABLED` row |
| `checkProviderControlBoundary` spans environment **and** env_file **and** secrets/configs/volumes **and** command/entrypoint | `scripts/lib/staging-manifest-invariants.mjs:452-482` |
| CM-010's owner cell is `CLI-001, CLI-004, MIG-008, DEP-006, DEP-008`, dominated today by **MIG-008** | `docs/replatform/current-main-crosswalk.md`, the **CM-010** row; `docs/replatform/program-design.md`, `#### MIG-008` → `Depends on:` |
| …and the owner cell is located by an **"exclusively a ticket list"** regex, so a prose cell is never read as one | `scripts/lib/dependency-graph.mjs:72-88` |
| …and an undominated row with no `crosswalk-coverage.json` declaration is `exit 1` | `scripts/lib/dependency-graph.mjs:135-147`; `scripts/check-dependency-graph.mjs:59-64` |
| `check-guard-inventory.mjs` tracks `scripts/check-*.mjs` **files**; this ticket adds none, so it stays green | `scripts/check-guard-inventory.mjs:32-40` |
| `check-execution-census.mjs` declares per-**file** status, not per-case; adding cases to an existing `.test.mjs` is invisible to it | `scripts/test-execution-census.json:112-131` |

---

## 1. DECISION D1 — worker-daemon's per-op `SandboxProvider` is THE authoritative port

**`packages/worker-daemon/src/supervisor/provider.ts:330` is the provider port. There is no other.**

1. **It is what the consumer consumes.** The supervisor programs against the per-op surface;
   `SupervisorDeps.provider` is typed to it and is required. Nothing in production calls
   `invoke(op, args)`. A port the security core does not speak is a second vocabulary, not the
   authority.
2. **It is what the only real implementation implements.** Declaring the other port authoritative
   would orphan the only real provider in the repo.
3. **It carries the security semantics.** `ResourceLabels` + `hashResourceLabels` (`:104-160`), the
   deliberately-sensitive `InspectResult` that makes cleanup redaction non-vacuous (`:244-262`), the
   byte-free `ArtifactUploadGrantV1`/`ArtifactExportResult` pair (`:358-378`),
   `UnsupportedProviderOperation` (`:297`), `SandboxNotFoundError` (`:311`). The driver's
   `ProviderOpArgs` is an opaque `params` bag (`port.ts:58-65`) carrying none of it — correct for a
   *neutral* conformance harness, wrong for a security core.
4. **The tree already says so twice in prose.** DEP-010's contribution is to make it a decision of
   record, enforced in the findings register, rather than a comment two files repeat and a third
   contradicts.

### D2 — the contract driver port is KEPT, demoted to a conformance-harness surface, reached through the shipped adapter

`SandboxProviderDriver` is **not retired and not authoritative**. It is retained as the surface the
two conformance suites drive (`runSandboxProviderContract` DEP-000, `runSandboxIsolationConformance`
DEP-008) and nothing else.

- **Not retired** — retiring means rewriting both suites and the fake against a port whose
  `ProviderOpContext` has no `params` channel for the fault vocabulary they depend on
  (`withdrawEffectAuthority`, `authority:"cleanup"`, `lifecycleFault`, `targetGeneration`,
  `egress.classification` — `per-op-adapter.ts:14-33`). Large, risky, buys a tidier diagram.
- **Not authoritative** — nothing in production calls it.
- **The bridge is `perOpToInvokeDriver`** (`per-op-adapter.ts:112`): generic, provider-agnostic,
  already tested, already green on both suites against
  `perOpToInvokeDriver(new E2bSandboxProvider(mockTransport))`
  (`docs/replatform/current-main-crosswalk.md`, CM-010's last column).

Direction is now single and stated: **authoritative per-op port → adapter → harness driver port.**
Never the reverse. §2.2 says what that costs.

**Structural residual, named:** the adapter lives in `packages/sandbox-e2b-provider`, so a *non-E2B*
provider wanting harness conformance would depend on the E2B package for a file with nothing to do
with E2B. DEP-010 does **not** move it — a package move for a provider that does not exist is
speculative, and §8.3 now records what the move would actually cost. Recorded in §8.

---

## 2. Findings disposition — all FOUR, explicitly

Revision 1 headed this section "all three". It was wrong by one, and the missing one is the only
**HIGH** in the set. `scripts/finding-ownership.json` declares **E4-F011** `owned`, `ticket:
"DEP-010"` — this ticket — and a 986-line plan that never typed the string is not the owner of
anything. §2.3 is that row.

| Finding | Disposition |
|---|---|
| **E6-F008** — two structurally distinct ports | **RESOLVED, one direction only.** D1 names the authority; D2 states the driver's retained role; the mechanism shipped in CLI-001. §2.2 states what is NOT bought and what the resolution text must therefore say. Status `open → resolved`; entry **deleted** from `scripts/finding-ownership.json`. |
| **E6-F004** — where the fake imports the port from | **RESOLVED, with the OPPOSITE answer to the one proposed.** The finding said the fake should import the port from worker-daemon and the boundary should allow it. **Rejected.** The fake implements the *harness* port, so it needs no import; it stays structural and `sandbox-fake-provider-boundary.mjs:45` stays **exactly** `["@armyofagents/worker-protocol","zod"]`. Widening it would put the daemon's whole surface inside a leaf whose entire point is that it has none. Proved mechanically by Step 9's control #4 — **against the fake's own guard**, which is a different guard from #2 (see Step 9). |
| **E6-F003** — the networked driver API | **EXPLICITLY DEFERRED, and currently OWNED by DEP-010 in the manifest.** Half is answered by D1 and recorded; the wire itself is not, and this ticket does not pretend otherwise. Because DEP-010 defers rather than resolves it, DEP-010's completion must **repoint** its manifest key to the successor that builds the wire (not merely rewrite its `reason`) — §2.1. See §2.1. |
| **★ E4-F011** (HIGH) — *one of the container's four landable gates is already satisfied on the desktop boot root* | **RESOLVED, but only because §4.3 writes the decision the guards cannot express.** The provider half of its bar is already built (Step 4's lock, Step 6's *loader never called*, Step 7's control/`--reset-identity` cases, Step 8's structural lock). The half nobody had done is the sentence: **which boot root(s) get a provider, and what the dispatch flag defaults to there.** §4.3 states it. Status `open → resolved` in `epics/E4-worker-daemon/findings.md` (cited by section/heading, never by line); entry **deleted** from `scripts/finding-ownership.json` — **in Step 11, not Step 1** (§2.3 says why). |

### 2.1 E6-F003 in full — because "deferred" without a reason is how it got orphaned once already

**What D1 answers.** Which port a networked worker→provider driver speaks: the per-op
`SandboxProvider`, transport-agnostic by construction (`provider.ts:16-21`). The networked driver is
a **binding of the authoritative port**, not a third port. That removes the entanglement with
E6-F008/F004 that made all four one question.

**What DEP-010 does NOT answer.** The wire itself — request/response shapes a worker's provider
driver speaks to `adapter-manager`. No transport, no schema, no client.

**★ Which network, stated correctly — the first draft had this backwards.** In
`docker-compose.staging.yml` the worker↔adapter-manager conversation happens on **`control-net`**:
workers are `[control-net, store-egress-net]` and `adapter-manager` is
`[control-net, provider-ctl-net]` (`staging-manifest-invariants.mjs:63-70`). **`provider-ctl-net` is
adapter-manager-only**, and a worker attached to it is a hard `PROVIDER-CONTROL VIOLATION`
(`:438-443`) — so the earlier sentence "workers speak to adapter-manager over `provider-ctl-net`"
described the exact thing the manifest gate exists to reject. `provider-ctl-net` is the
*adapter-manager → E2B* leg, not the *worker → adapter-manager* leg.

**★ And the name is overloaded across two compose files.** `docker-compose.d1.yml` uses
`provider-ctl-net` to mean something different: there, `worker-a` (`:332`) and `worker-b` (`:368`)
**are** on it — the file's own topology matrix says so in prose (`:14-22`) — because D1's fake
provider is a container the workers must reach directly. Both files are correct for their own
topology; the name is not portable between them.

**Why the correction matters more than a typo would.** The corrected sentence is about to be written
into a **CI-enforced register** (`scripts/finding-ownership.json`, "Register action" below), where a
wrong network name stops being a slip and becomes a durable false statement — one the next reader
designs a wire against, and one no guard can contradict because no guard reads prose.

**Why deferring is correct, not convenient.** There is no consumer: `adapter-manager` is declared
and enforced against but has **zero implementation** (DECISION-byte-egress… **§4 residual 4.2**); no worker
dispatches (flag default-off, no `compose:true` branch). Specifying a wire against an unimplemented
peer for an unbuilt caller is the failure this programme keeps re-learning.

**Its precondition, written down.** E6-F003 becomes *required* the moment a containerized worker
under `docker-compose.staging.yml` must dispatch — because §2.5 forbids `E2B_API_KEY` on any worker
surface, so that worker's provider **cannot** be key-backed and **must** be networked, reaching
`adapter-manager` over `control-net`. **DEP-010 therefore wires the desktop/self-hosted lane only**,
and §3.3 states that as a consequence, not an oversight.

**Register action.** Stays `open` (permitted for HIGH; may never be `accepted`). It is **not
unowned**: `scripts/finding-ownership.json` currently carries E6-F003 as `status: "owned",
ticket: "DEP-010"` — this ticket — because DEP-010 is the composition-root decision the entry was
waiting on. Its `ownerStillOpen`/`reason` are rewritten to: the narrowed question (a wire, not a
port), the removed entanglement, the precondition above, and the correct network — with the
d1-vs-staging overload called out in one clause so the next reader does not have to rediscover it.

**★ But a reason-only rewrite is not enough, and that is finding E4-F013.** DEP-010 *defers* E6-F003;
it does not build the wire. The ownership guard fires `stale_declaration` only when a manifest key's
status is not `open` (`finding-ownership.mjs:130-136`); it does **not** fire when an `open` entry
names a ticket that has since shipped, because `:118` only tests that `ownerStillOpen` is non-empty
(`hasReason`, `:53-55`). So the moment `DEP-010-result.md` lands, E6-F003 would read as `owned` by a
shipped ticket that never resolved it — the exact false-ownership hole E4-F013 describes, which names
`E6-F003 -> DEP-010` as one of its three live instances. **DEP-010's completion must therefore
REPOINT E6-F003's manifest `ticket` to the successor that actually builds the containerized wire (the
E6-F003 precondition above), not merely rewrite its prose.** Repoint, because the finding stays open;
delete only belongs to a finding this ticket resolves.

### 2.2 ★ What "E6-F008 resolved" does NOT buy — recorded before the entry is deleted

Deleting a register entry is the moment to be precise about what the deletion claims, because
nothing re-checks it afterwards.

**(a) The bridge runs one way, and the useful-for-DEP-010 direction is the one that exists.**
`perOpToInvokeDriver(provider: SandboxProvider): SandboxProviderDriver` (`per-op-adapter.ts:112-115`)
takes the daemon's per-op port and produces the harness's driver port. DEP-010 needs exactly that
direction — it must hand the daemon a **per-op** provider, and `E2bSandboxProvider` already is one
(`e2b-provider.ts:136`). So the root has something to inject. What does **not** exist is
`driver → per-op`, and that absence is load-bearing in the opposite way: **the DEP-000 fake cannot
stand in as the daemon's provider.** `packages/sandbox-fake-provider` implements the driver port
structurally (`fake-driver.ts:5-8`); nothing adapts it onto `SandboxProvider`. That is *correct*
(§3.4 rejects shipping a fabricating provider on a production path) but it means the harness and the
daemon exercise **two independent provider doubles** — `packages/sandbox-fake-provider` for the
suites, `packages/worker-daemon/src/__tests__/support/fake-provider.ts` for the supervisor. The
DEP-000 harness never drives the daemon's supervisor. Recorded as residual §8.9; **not** fixed here.

**(b) F008's own resolution text set a bar the shipped adapter does not clear.** The finding's
option (b) is "a tested `SandboxProvider → SandboxProviderDriver` adapter **with a totality
assertion over all 11 ops + their result shapes**" (`epics/E6-deployment-test-harness/findings.md`,
E6-F008's **Resolution** paragraph, option (b)).
`PROVIDER_OPERATIONS` has 11 entries (`packages/worker-protocol/src/capabilities.ts:125-137`). The
adapter routes them with hand-written `switch` arms (`per-op-adapter.ts:308-392`) and the suite
checks them **case by case** — `per-op-adapter.test.ts:92` names eight in one test, `:110` covers
`reconcile_cleanup`, `:231`/`:243` cover the optional trio through the advertisement gate. There is
**no** `for (const op of PROVIDER_OPERATIONS)` assertion anywhere in the package.

**Do one of these two in Step 1, not both:**

- **Preferred — earn it.** Add a totality case to
  `packages/sandbox-e2b-provider/src/__tests__/per-op-adapter.test.ts` that iterates
  `PROVIDER_OPERATIONS` and asserts every op either routes to its per-op method or raises
  `UnsupportedProviderOperation` (never "silently returns"), so a twelfth op added to the frozen
  vocabulary fails here rather than in production. Note this adds **no file** — the tree is pinned
  per file, not per case, so `test-inventory.json` is unaffected.
- **Or supersede it, in writing.** State in the `findings.md` resolution that D1/D2 supersede option
  (b): the totality bar was written when the adapter was *the* reconciliation, and D1 demotes the
  driver port to a harness surface whose per-op coverage is the suites' problem, not the port
  question's.

Silently closing at a lower bar than the finding's own text is the aggregation failure
`gate-clause-wiring.mjs` was built for. Whichever branch is taken must appear in the resolution
paragraph.

### 2.3 ★ E4-F011 — the finding this plan owned and never named

**Its register entry, verbatim** (`scripts/finding-ownership.json`, key `E4-F011`):

> `"status": "owned"`, `"ticket": "DEP-010"`,
> `"ownerStillOpen": "DEP-010 has a design doc and no result doc. The finding is the constraint on
> its acceptance, so it closes when DEP-010 ships with a guard proving the shipped desktop default
> constructs no provider."`

**Why nothing would have failed.** `scripts/lib/finding-ownership.mjs:118` is
`if (completed.has(entry.ticket) && !hasReason(entry.ownerStillOpen))`, and `hasReason` (`:53-55`)
is a **trim-length test**. So the moment `DEP-010-result.md` lands — `findCompletedTicketIds`
(`scripts/check-finding-ownership.mjs:53-67`) keys "shipped" on the result-doc filename — the
register would carry, for an **open HIGH**, the permanently false sentence *"DEP-010 has a design
doc and no result doc"*, and `check-finding-ownership.mjs` would exit **0**. That is exactly the
state the guard's own comment at `:106-117` says it exists to catch (*"An open finding owned by
SHIPPED work is owned by nothing"*), defeated by the non-emptiness calibration one line below it.
It is also the failure §2.1 argues at length about for E6-F003's network name: *a durable false
statement in a CI-enforced register that no guard can contradict, because no guard reads prose.*
Applying that principle to three findings and not to the plan's own fourth is the defect.

**What the finding actually asks for** (`epics/E4-worker-daemon/findings.md`, `## E4-F011`, its
*Consequence for DEP-010* paragraph): DEP-010 *"may not put a provider in that composition root
without an explicit, written decision about the flag's default on desktops. Its acceptance must
prove the shipped desktop default constructs **no provider at all** — not merely that the flag is
off."* The second sentence is a guard, and it is built. **The first sentence is prose, and prose is
the one thing no guard in this repository can produce.** §4.3 is that prose.

**Why it closes in Step 11 and not in Step 1.** E6-F008 and E6-F004 resolve in Step 1 because their
resolution *is* a decision (D1/D2) and the decision is complete the moment it is written. E4-F011's
own closure condition is *"ships **with a guard**"* — and the guards land in Steps 4, 6, 7, 8 and 10.
Flipping it to `resolved` in Step 1 would claim a guard three commits before it exists, which is the
same shape as the mitigation revision 1 deleted. Step 11 is the first commit at which the sentence
is true.

**And note what closing it does NOT claim.** E4-F011 was **filed** with a "two gates" headline and
that count has since been **retracted** — the finding's title now states the invariant (*one of the
container's four landable gates is already satisfied on the desktop*) precisely because the count
kept moving. §4.2 records, in the six-gate model the finding now uses, that this ticket plus Sprint 3
drives the desktop's **structural** gate count to **zero** while five gates remain (three landable
env vars, plus a live session and an admin-set placement profile as runtime conditions). Resolving
the finding closes the *decision* it demanded of DEP-010. It does not close the underlying exposure,
which §4.2 hands forward in writing rather than leaving inside a finding whose count would read as
reassuring and be out of date.

---

## 3. DECISION D3 — the root is the existing `desktop-host.ts`; the provider package is confined to one new file

### 3.1 The constraint that decides the shape

`scripts/lib/worker-keystore-boundary.mjs:56-59` pins `worker-keystore` to **exactly**
`{worker-daemon, worker-protocol}`, and the module header (`:20-24`) says: *"Adding anything is a
STOP for controller approval — a native keychain binding must never arrive here by accident, because
this package is injected INTO the daemon's process."* `ALLOWED_BARE` (`:94-97`, applied at `:152`)
rejects every other bare specifier in runtime source, **including `import type`** (the scanner is
lexical — `worker-protocol-boundary.mjs:368-379` reaches `from` regardless of the `type` modifier)
and **including a literal dynamic import** (`extractModuleSpecifiers` emits `kind:"dynamic"` with a
value, which flows through the same allow check).

There is no clever way in. **Adding the provider package to this package IS a controller STOP**, and
this design asks for it explicitly. The go-book has already granted it, **conditionally**, as
decision **D-3** (`GO-BOOK.md` **§8**) — so Step 0 is the check that the three conditions hold, not
a fresh request.

### 3.2 Pay for the widening by making the guard tighter than it was

The concern is real: the provider package transitively pulls the `e2b` network SDK into the process
that holds the device private key. So the widening is **paired with two new confinement rules**, both
modelled on files that already exist — `SUBPROCESS_HOST_PATH` (`:71`), whose own history (a basename
check that let any `command-runner.ts` inherit permission) is why it keys on the full
package-relative path, and the e2b leaf's `CREDENTIAL_TOKEN` (`sandbox-e2b-provider-boundary.mjs:56`,
`:126-128`).

- `REQUIRED_RUNTIME_DEPENDENCIES` → the three-element sorted list.
- `ALLOWED_BARE` gains the specifier.
- **New (path):** `PROVIDER_HOST_PATH = "src/bin/sandbox-provider.ts"` — the provider package may be
  named from **exactly one path**; every other runtime file is rejected, with the reason in the error
  text.
- **★ New (credential):** `FORBIDDEN_CREDENTIAL_TOKENS = ["E2B_API_KEY"]` — the token may appear in
  **ZERO** runtime source files in this package. Not "one host file": zero. This package has no
  legitimate reason to name the credential, which is precisely what §3.2 claimed and nothing checked.

**Why the credential ban is not decorative.** Steps 6 and 7 require a refusal message that mentions
`E2B_API_KEY`, and the obvious implementation writes the literal into `sandbox-provider.ts` or
`desktop-host.ts`. That would put the credential's name into the key-holding package and nothing
would object. The rule makes the obvious implementation fail, and the correct one is forced:

> **The `E2B_API_KEY` mention arrives by PROPAGATING the transport's own error text.**
> `createRealE2bTransport()` throws synchronously from its constructor
> (`real-transport.ts:84` → `requireApiKey` `:53-59`) with the message
> *"RealE2bTransport requires E2B_API_KEY (provider-control credential) …"*. `sandbox-provider.ts`
> catches, wraps as `{kind:"refused", reason: <the caught message>}` and **never types the token**.
> The assertion that the operator really sees it lives in
> `packages/worker-keystore/src/__tests__/sandbox-provider.test.ts` — a `.test.ts`, which both
> scanners skip by classification (`worker-protocol-boundary.mjs:94-99`;
> `check-worker-keystore-boundary.mjs:112`).

Note the e2b leaf's precedent scans **raw source** (`sandbox-e2b-provider-boundary.mjs:126`), so a
comment naming the token counts. Mirror that. It means the Step 6 header must explain the credential
confinement **without spelling the variable** — say "the transport reads the provider-control
credential itself (DEP-006 confinement point, `real-transport.ts:53-59`)". This is a real
constraint on the prose, not an accident, and it is the point: a package that must not carry a
credential should not carry its name either.

Net: one more allowed specifier, two more confinement rules. The dangerous capability lands in one
reviewable file instead of becoming ambient, and the credential's name never lands at all.

- **Lazy load.** `sandbox-provider.ts` uses a **literal dynamic** `import(...)`. A static import
  would load the SDK on **every** boot including the default boot that constructs nothing
  (`index.ts` statically re-exports `real-transport.js`, which imports `e2b` at module scope).
- **The credential never crosses the root.** `createRealE2bTransport()` is called with no `apiKey`;
  it reads the credential itself (`real-transport.ts:53-59`, called from the constructor at `:84`),
  the DEP-006 confinement point. `worker-keystore` never names it — now enforced.

### 3.3 Dependency-direction consequences

1. **New arrow `worker-keystore → sandbox-e2b-provider`.** With the existing
   `sandbox-e2b-provider → worker-daemon`, the graph stays a DAG. No cycle.
2. **`worker-keystore` becomes the only package naming daemon + OS custody + a provider.** The
   DSK-001 arrangement extended by one.
3. **The daemon's arrow is untouched.** `worker-daemon-boundary.mjs:53` is not edited; Step 9 proves
   it with positive controls.
4. **The fake's arrow is untouched** — that is E6-F004's answer.
5. **★ The desktop artifact grows, and by how much is now MEASURED rather than assumed.** The
   first draft said the DSK-003 staging manifest "regenerates by the build, so nothing drifts
   silently." **That mitigation does not exist.** `scripts/build-desktop-staging.mjs` refuses to run
   — its own header (`:21-30`) records that producing its link-free input is an unsolved packaging
   step, `pnpm deploy --prod` yields 36 symlinks and the hoisted variant yields no `node_modules` at
   all — and the only thing CI executes is its unit test (`.github/workflows/pr.yml:365`). Nothing
   regenerates a manifest today, so nothing would have caught the growth. **The go-book had already
   reached the same conclusion independently:** decision **D-3** (`GO-BOOK.md` **§8**) records that "the
   earlier approval leaned partly on the staging-manifest mitigation — that build **refuses to run**,
   so it mitigates nothing." Two documents arriving at it separately is the reason it is stated here
   in the plan's own voice rather than left as a cross-reference.

   Measured instead, on this workspace at revision time (`pnpm why e2b` + the lockfile's `e2b@2.30.5`
   snapshot, closed transitively):

   | | |
   |---|---|
   | direct dependency | `e2b@2.30.5` (`packages/sandbox-e2b-provider/package.json:28`) |
   | transitive closure | **36 packages** — incl. `undici`, `tar`, `glob`, `@bufbuild/protobuf`, `@connectrpc/connect{,-web}`, `dockerfile-ast`, `openapi-fetch`, `chalk`, `cross-spawn` |
   | on disk, unpruned | **~15.2 MiB across ~1,752 files** |

   That is the *pre-prune* number: `isShippableStagingPath` would drop docs/benchmarks/READMEs
   (`staging-manifest.mjs:33-52`), so the shipped figure is smaller — by an amount nobody can compute
   until an assembler runs. Record the measured number in the DEP-010 result doc so the first real
   assembly has a baseline to compare against.

   **★ The real handoff is the secret scan, and it goes to DSK-003 packaging by name.**
   `build-desktop-staging.mjs` step 4 scans the assembled bytes for embedded credentials, and that
   scan **already had to prune third-party READMEs and benchmarks** to stay green — pino's README and
   `@pinojs/redact`'s benchmarks contain `password: "hunter2"`-style examples
   (`staging-manifest.mjs:41-51`). The `e2b` closure is **36 new packages of unscanned third-party
   bytes** entering that scan for the first time. Expect false positives; the correct response is
   another prune rule, never a weaker scan. **Flag this to DSK-003 explicitly** — not as "the
   artifact is bigger", but as "an unmeasured new input to a scan that has already been widened once
   to survive its existing inputs."
6. **This is the desktop/self-hosted lane ONLY.** A staging containerized worker cannot use it:
   `E2B_API_KEY` on a worker is a hard `PROVIDER-CONTROL VIOLATION`. The containerized lane needs
   E6-F003. The boundary of this ticket, not a gap in it.

### 3.4 Alternatives rejected

| Alternative | Why not |
|---|---|
| New package `@armyofagents/worker-desktop-host` owning the bin | Moves `bin/aoa-worker-desktop` out of `worker-keystore/package.json:15`, reaching DSK-003 install layout, autostart `execPath`, and the staging manifest. It would also mint a new tree that `test-inventory.json` must adopt (default-deny: an unmanaged tree with tests is a violation — `lib/test-inventory.mjs:24-26`). Far larger blast radius to avoid one reviewed guard edit — and it writes a root when one already exists. **Reconsider only if a controller withdraws D-3 on the measured cost (Step 0).** |
| Relocate the per-op port to a shared leaf (E6-F008 option (a)) | Contradicts the explicit E4-F003 choice at `provider.ts:10-14`; churns the port every consumer imports; buys nothing, since the adapter already bridges. |
| Make the fake the daemon's provider | It implements the other port, and no `driver → per-op` adapter exists (§2.2a). Building one would ship a fabricating provider on a production path — the WRK-009 defect shape. |
| Fall back to `MockE2bTransport` when no key is present | A worker that fabricates provider success is byte-identical to a real one on every gate. Never in production. |
| Degrade to "no provider" when an explicitly-requested provider cannot be built | The operator would see `no_provider` — the message for a build that *cannot* have one — and rebuild something that is fine. An explicit opt-in that cannot be honoured is a **refusal**. |
| Avoid the gate-clause-wiring failure by not naming `E2bSandboxProvider` (structural access, `Reflect.get`) | This is evasion of a guard, not compliance with it. The register's whole purpose is that a capability acquiring a caller becomes visible; hiding the reference to keep a stale `unwired` entry green is the exact behaviour `gate-clause-wiring.mjs:95-104` was written to surface. Update the declaration instead (Step 6). |

---

## 4. What this ticket does NOT do — and how that is proven

DEP-010 wires the **seam** and the **root**. It does **not** turn dispatch on. Three independent
facts keep the shipped default inert; Steps 7/8/10 prove each:

1. **`AOA_WORKER_SANDBOX_PROVIDER` unset by default** → resolver returns `{kind:"none"}` →
   `provider: undefined` → `no_provider`. The `e2b` SDK is never loaded (Step 7 asserts the loader is
   called zero times).
2. **`AOA_WORKER_DISPATCH_ENABLED` stays default-off**, unset in every deployment surface; Step 10
   makes setting it on a staging worker a CI failure.
3. **★ Nothing consumes `compose === true` — a STRUCTURAL fact, not a flag value.** This is the
   revised form of the third proof, and it replaces the previous one for a reason worth stating.
   **It is also the one with an expiry date: §4.2.**

**Read §4.1, §4.2 and §4.3 as one argument.** §4.1 is the proof and the observable it needs; §4.2 is
the date it stops being true and what is left afterwards; §4.3 is the written decision E4-F011 asked
this ticket for, which is the part no guard in this repository can produce.

### 4.1 ★ Why the old third proof was anchored to sand

The first draft proved inertness by keying on `hasSelfModelReader: false`
(`bin/worker-daemon.ts:344`). That literal is **documented scaffolding that Sprint 3 deletes**:
`compose-dispatch.ts:44` says in so many words *"This reason retires when 2b lands"*, and slice 2b is
**Sprint 3** (`GO-BOOK.md` §3, the spine line `S3  WRK-008/2b dispatch COMPOSED (not live)`; §4
*Sprint 3*). *Revision 1 said "the very next sprint" and that is no longer true* — the go-book
inserted **two** sprints between this ticket and 2b: **Sprint 2.5** (WRK-010 slice 2, the renewal
route's first caller) and **Sprint 2.75** (WRK-011, the self-model refresh), which buys two sprints
of margin and changes nothing about the argument. A lock whose mutation target is removed by a
later ticket stops locking anything the moment that ticket lands, silently — nobody re-derives what a
deleted line was holding up.

**The structural lock, which survives 2b's arrival:**

> With provider **and** flag **and** a self-model reader **and** a self-model all satisfied,
> `decideDispatchComposition` returns `{compose: true}` (`compose-dispatch.ts:59-67`) — and
> `bootstrapWorkerDaemon` **still composes no supervisor and no poll loop**, because the only thing
> reading the decision is `if (!dispatch.compose) { logger.info(...) }` at
> `bin/worker-daemon.ts:347-349`. **There is no `else`.** The seams that would build a loop stay
> empty by presence-gating on deps the shipped binary never passes: `deps.reconciler` (`:355`),
> `deps.leasing` (`:362`), `deps.eventOutbox` (`:363`) each degrade to `[]`.

That is the honest statement of "does not turn dispatch on": not *the daemon cannot reach
`compose:true`*, but *reaching it changes nothing, because nothing is listening*. It stays true when
`hasSelfModelReader` becomes real, and it stops being true exactly when slice 2b writes the `else` —
which is when it *should* stop being true.

**★ Name the observable, or the lock is a wish (revision 2).** Revision 1 wrote *"assert on the
returned `BootstrapResult` + the injected logger"*. **`BootstrapResult` cannot carry this claim.** It
is `{ ok, config?, logger?, metrics?, health?, shutdown? }` (`bin/worker-daemon.ts:165-172`), and not
one of those fields distinguishes a composed loop from an uncomposed one: `startupSteps` (`:355`),
`leaseSteps` (`:362`) and `outboxSteps` (`:363`) are consumed **locally** into `runStartupSteps` and
`createShutdownHandler` (`:364-380`) and never surface on the result. An implementer told to "assert
on the `BootstrapResult`" will fall back to *"the refusal log line is present and no other dispatch
line is"* — which is the assertion the demoted `:344` check already makes, and which
`dispatch-composition-bootstrap.test.ts:83-84` already ships. The lock would be indistinguishable
from the one it replaced.

The **two** real observables, both reachable from what `bootstrapWorkerDaemon` already returns and
already logs, and both named so mutation (a) has a fixed target:

> **(i) Startup steps.** `runStartupSteps` logs `{step: <name>}` per step
> (`lifecycle/startup-steps.ts`, `runStartupSteps`). With no `deps.reconciler`, `startupSteps` is
> `[]` and **zero** `startup:` lines are emitted. Assert zero.
> **(ii) Shutdown steps.** Invoke `result.shutdown("SIGTERM")` — with an injected `proc` whose
> `exit` is a spy, because the handler always exits (`lifecycle/shutdown.ts`,
> `createShutdownHandler` → `opts.exit(0)`). Each step logs `{signal, step: <name>}` before it runs.
> On the shipped shape the recorded names must be **exactly `["health-server"]`** — no
> `lease-stop`, no `lease-drain`, no `event-outbox-stop`/`-flush`/`-close`.

**★ REVISION 2 — the mutant's MECHANISM, pinned, because the obvious `else` does not move (i) or
(ii).** Observables (i) and (ii) read `deps.reconciler` (`:355`), `deps.leasing` and `deps.eventOutbox`
(`:362-363`) — and those three `const`s are declared **after** the `if (!dispatch.compose)` block,
not inside it. An `else` at `:349` that composes a supervisor or poll loop **into a local variable**
therefore changes neither observable: `leaseSteps`/`outboxSteps`/`startupSteps` still read the
untouched `deps`, so the shutdown names stay `["health-server"]` and the mutant does not fail. (Slice
2b's real change is not a bare `else` either — it restructures `:355-380` to build those steps from
the composed loop.) So mutation (a) must be written as an `else` that **assigns a lifecycle dep** —
e.g. `deps.leasing = <a fake leasing lifecycle>` (or `deps.reconciler` / `deps.eventOutbox`) — which
> **Implementer note (mutant a):** `deps.leasing`/`deps.reconciler`/`deps.eventOutbox` are `readonly` on `BootstrapDeps`, so the mutation is `(deps as any).leasing = <fake>` to compile — standard for a mutation edit, no effect on killability.
the post-if-block `const` at `:362` then reads, moving (ii) from `["health-server"]` to something
longer. That is a mutation with a *real, defined* kill, and it is stated as the mechanism rather than
left to "compose anything observable", which the `const`-after-the-block structure makes false.

**The `:344` mutation is DEMOTED to a supporting check.** Keep it (it is cheap and it documents
today's behaviour), but it is no longer what §9 maps the acceptance clause to.

**And note the second hardcoded falsy the ROOT-LEVEL matrix never mutated.** `selfModel: null` at
`bin/worker-daemon.ts:345` is a separate literal on the same call, gating a separate refusal
(`no_self_model`, `compose-dispatch.ts:65`). The old matrix mutated `:344` and never `:345`.
**Revision 1 wrote that the fourth gate "had no falsifying test at all"; that was over-broad and is
corrected here.** The *decision function's* fourth gate is falsified today —
`packages/worker-daemon/src/__tests__/compose-dispatch.test.ts:54-59` asserts
`{provider, dispatchEnabled: true, hasSelfModelReader: true, selfModel: null}` →
`{compose:false, reason:"no_self_model"}`. What was missing is a **root-level** entry, and Step 8
adds one. Note also that mutating `:345` **alone** is inert: `compose-dispatch.ts:64` short-circuits
on `!hasSelfModelReader` before `:65` reads `selfModel`, and `:344` is hardcoded `false` — pinned by
`compose-dispatch.test.ts:92-100`. That is precisely why Step 8 prescribes it **with (b)**, and why
(b)+(c) is the only prescribed state in which the real `bootstrapWorkerDaemon` is observed at
`compose === true` — the only state in which the structural lock above is non-vacuous.

### 4.2 ★ The primary proof EXPIRES at Sprint 3, and nothing in the set replaces it

This is the sentence the cross-plan completeness critic asked for, and it belongs here — **before
Sprint 2 runs** — rather than being rediscovered after Sprint 3.

§4.1's structural lock is a claim about the *shape of the tree*: nothing consumes `compose === true`
because `bin/worker-daemon.ts:347-349` has no `else`. **It is true only until WRK-008 slice 2b writes
that `else`,** which is the whole point of Sprint 3 and which this plan already says out loud (§7
marks mutation (a) *"the mutation slice 2b will make for real"*). So DEP-010's headline acceptance —
*does not by itself turn dispatch on* — is provable exactly once, and then it is gone.

**What is left holding the line after Sprint 3, stated plainly** — in the **six-gate model** the
`E4-F011` finding now uses (six gates total: **four landable** — provider, flag, custody+enrolment,
outbox path — and **two runtime conditions** — a live session, an admin-set placement profile; the
container stands on all six, the desktop already satisfies custody so **five** remain):

| Before Sprint 3 (desktop) | After Sprint 3 (desktop) |
|---|---|
| **A structural gate** — no `else` exists, so `compose:true` cannot compose anything, whatever the environment says | **No structural gate.** The `else` exists and composes a real poll loop, supervisor, renewal driver and event outbox |
| plus `AOA_WORKER_SANDBOX_PROVIDER` unset (`no_provider`, landable) | `AOA_WORKER_SANDBOX_PROVIDER` unset (`no_provider`) |
| plus `AOA_WORKER_DISPATCH_ENABLED` unset (`dispatch_disabled`, landable) | `AOA_WORKER_DISPATCH_ENABLED` unset (`dispatch_disabled`) |
| — | `AOA_WORKER_EVENT_OUTBOX_PATH` unset (`no_event_outbox_path`, slice 2b's new landable gate; **not** defaulted to a path) |
| — | plus a live session absent (`no_session`, a **runtime condition**, not an env var) |
| — | plus an admin-set placement profile absent (`no_self_model`, a **runtime condition** fixed by an org admin, **not** an env var, and it does **not** retire with slice 2b — only `no_self_model_reader` does) |

The identity gate (`no_worker_identity`) is not on that list because any desktop that boots at all
already satisfies it — E4-F011's own invariant.

**After Sprint 3 the shipped desktop's inertness rests on those five remaining gates, and the
structural one is gone.** Three of the five are unset environment variables (provider, flag, outbox
path) — things an operator, an installer, a service definition or a support script can set. The
other two are runtime conditions: an absent live session and an absent admin-set placement profile,
neither of which an env var controls. E4-F011's retracted *"two gates"* count is exactly why the
finding's title now states the invariant rather than a number — **say which enumeration you mean,
every time**: the desktop's *landable* gates after custody are three (provider, flag, outbox path),
its total remaining gates are five, and its *structural* gates are zero.

**Three consequences, none of which are this ticket's to fix, all of which are this ticket's to
write down:**

1. **Sprint 3 must replace the proof, not inherit it.** The go-book's Sprint 3 *"Done when … with
   either absent it is provably inert"* is a claim about **env-var absence**, not about structure.
   That is a strictly weaker property and it must be labelled as one where slice 2b records it.
2. **The env-var gates need a guard on the desktop lane, which does not exist.** Step 10's invariant
   is real and it is **container-only** (`docker-compose.staging.yml`). There is no equivalent
   assertion that a DSK-003 installer, autostart entry, service definition or support bundle does
   not carry `AOA_WORKER_SANDBOX_PROVIDER` or `AOA_WORKER_DISPATCH_ENABLED`. Today that gap is
   harmless because the structural gate is doing the work. **After Sprint 3 it is the whole
   exposure**, and it belongs to whoever owns the desktop packaging surface at that point.
3. **The register will read better than the tree.** Slice 2b promotes `E4-1-leases-through-protocol`
   to `wired`, and `evaluateGateClauseWiring` validates a `wired` entry on **caller count alone**
   (`scripts/lib/gate-clause-wiring.mjs:81-88` — `count === 0` is the only failure; `reason` is
   required for `unwired` and never read for `wired`, `:90-92`), while the green run prints reasons
   for the **DORMANT list only** (`scripts/check-gate-clause-wiring.mjs:130-136`). A caveat parked in
   `reason` on a `wired` entry is a caveat no code path reads and no green run prints. Whoever
   writes that promotion should know the caveat is decoration — the same aggregation failure this
   register was built to surface, re-committed one level down.

### 4.3 ★ The written decision E4-F011 demanded: which root gets a provider, and what the flag defaults to there

E4-F011 says DEP-010 *"may not put a provider in that composition root without an explicit, written
decision about the flag's default on desktops."* This is that decision. It is prose on purpose:
`check-finding-ownership.mjs` cannot verify it, `check-boot-roots-provider-free.mjs` (slice 2b) will
not exist until Sprint 3, and the thing being decided — a default — is a choice, not a fact a scanner
can read back.

**(1) Exactly one boot root gets a provider path, and it is `desktop-host.ts`.** The tree has two
boot roots that call `bootstrapWorkerDaemon`:

| Root | Provider after DEP-010 | Why |
|---|---|---|
| `packages/worker-daemon/src/bin/worker-daemon.ts:398` — `bootstrapWorkerDaemon({env: process.env, proc: process})`, the direct-invocation branch | **NONE, and structurally cannot have one.** | This is the container entrypoint (`docker/worker/Dockerfile`, `CMD ["node","dist/bin/worker-daemon.js"]`). The image's runtime closure was worker-daemon + worker-protocol + `pino` only (DEP-001); **Blocker B widened it to seven packages** (adding worker-networked-host, provider-wire, provider-capability, sandbox-e2b-provider, sandbox-provider-contract) so `sandbox-e2b-provider` IS now in the image — but in the SEPARATE `/worker-net-app` deploy tree, reachable only from the networked-host bin, which this CMD does not enter. `worker-keystore` is still absent, and `worker-daemon-boundary.mjs:53` pins the daemon's runtime deps to `["@armyofagents/worker-protocol","pino"]`, so it may not name a provider package at all (E4-D01). Not a policy — an unreachable code path. |
| `packages/worker-keystore/src/bin/desktop-host.ts` (`bootstrap({...})`, `:254-260`) | **A provider *path*, opt-in, resolving to `{kind:"none"}` on the shipped default.** | This is the DSK-003 desktop binary. It is the only root outside the daemon package, which is the entire reason D1 puts the seam here. |

**(2) On that root, `AOA_WORKER_SANDBOX_PROVIDER` defaults to UNSET, and unset means the provider
package is never even loaded.** Not "constructed and discarded" — `resolveSandboxProvider` returns
`{kind:"none"}` **before calling the loader**, so the `e2b` SDK does not enter the process image of a
default desktop boot. Step 6's first case asserts *"the loader is never called"*; Step 7 asserts the
same for a control command and for `--reset-identity`. This is the clause that satisfies E4-F011's
*"constructs no provider at all — not merely that the flag is off."*

**(3) On that root, `AOA_WORKER_DISPATCH_ENABLED` defaults to OFF, and DEP-010 does not change that
in either direction.** `runDesktopHost` forwards `deps.env` verbatim into `bootstrapWorkerDaemon`
(`desktop-host.ts:254-260`), so the desktop reads the same daemon-wide parser as the container:
`config.ts:69` via `ENV.dispatchEnabled`, `parseDispatchEnabled` at `:150-162` — **absent → `false`**,
empty → `false`, `"0"` → `false`, `"1"` → `true`, anything else → a **startup error** rather than a
silent disable. DEP-010 ships no default, no override and no per-root special case for this flag. The
desktop's default is the daemon's default because the desktop passes the daemon's env through.

**(4) The honest reading of the gate count, now that a provider path exists there.** E4-F011's own
analysis is right about the custody half: `desktop-host.ts` builds both OS-custody stores on every
non-control boot and passes them at `:254-260`, so `bin/worker-daemon.ts:267`
(`config.keyStoreMode === "os_keychain" && deps.identityStore && deps.receiptStore`) is entered and
**the identity gate is already satisfied on any desktop that boots at all** — that gate is
`no_worker_identity` in slice 2b's vocabulary and does not exist as a refusal reason today
(`compose-dispatch.ts` ships four: `no_provider`, `dispatch_disabled`, `no_self_model_reader`,
`no_self_model`). The finding's retracted "two gates" number is why its title now states that
invariant rather than a count. After DEP-010 the desktop's remaining refusals on the shipped default
are **(1) no provider, because the switch is unset, and (2) the flag, which is off** — and, until
Sprint 3, the structural fact that nothing consumes `compose === true`. **§4.2 records what that count becomes after Sprint 3
and why the number in the finding's title will be stale.** That is the reason E4-F011 is resolved
*with* §4.2 rather than by §4.3 alone: closing a finding whose headline number is about to change,
without writing down what it changes to, is how a settled question comes unsettled.

**(5) What would require a NEW decision, not an extension of this one.** Any of: a default value for
`AOA_WORKER_SANDBOX_PROVIDER` in an installer, service definition, autostart entry or support
script; a provider path on the container root; a second composition root; or a resolver kind that
does not require an explicit opt-in. None is in this ticket, and none should be added to it.

---

## 5. Files

| File | Change |
|---|---|
| `epics/E6-deployment-test-harness/findings.md` | E6-F008 + E6-F004 → `resolved`; E6-F008's resolution states the §2.2b branch taken; E6-F003 body rewritten to the narrowed question **on `control-net`** |
| **`epics/E4-worker-daemon/findings.md`** | **★ REQUIRED — `## E4-F011` → `Status: resolved`, citing §4.3 (the written decision) and §4.2 (what its retracted headline count becomes after Sprint 3, in the six-gate model — state the invariant, never a bare number). Landed in Step 11, not Step 1 — §2.3 says why** |
| `scripts/finding-ownership.json` | delete E6-F008, E6-F004 (Step 1); **delete `E4-F011` (Step 11)**; rewrite E6-F003 `ownerStillOpen`/`reason` (Step 1) and **repoint E6-F003's `ticket` to its successor at DEP-010 completion** (§2.1, E4-F013 — DEP-010 defers, does not resolve, E6-F003) |
| **`scripts/gate-clause-wiring.json`** | **★ REQUIRED — `E7-1-coding-journey` re-declared. Without this, `policy` goes red.** See Step 6 |
| **`scripts/test-inventory.json`** | **★ REQUIRED — `packages/worker-daemon` 131 → 132; `packages/worker-keystore` 18 → 20.** Bumped in the same commits that add the files |
| **`.github/workflows/pr.yml`** | **★ REQUIRED — `pnpm --filter @armyofagents/sandbox-e2b-provider build` appended to the `verify` pre-build list (`:743-751`); mirrored into the `distributed-contract` list (`:1168-1173`) for symmetry** |
| **`pnpm-lock.yaml`** | regenerated by `pnpm install` after the manifest change; **must ride in the same commit as `packages/worker-keystore/package.json`** (`pr.yml:134-145`) |
| **`docs/deploy/environment-variables.md`** | **★ two new rows — `AOA_WORKER_SANDBOX_PROVIDER`, `AOA_WORKER_E2B_TEMPLATE`** — **and one CORRECTION**: the existing `AOA_WORKER_DISPATCH_ENABLED` row ends *"Composition is ALSO gated on a sandbox provider being injected, **which the shipped binary cannot do**"*, and this ticket makes that half-sentence false for the desktop lane. Rewrite it to say the container binary cannot, and the desktop binary can only on an explicit opt-in (§4.3). No guard will catch any of the three (§0.1: brand-check guard 9 matches only literal `process.env.AOA_…`, and these are read through a string constant) |
| `packages/worker-daemon/src/index.ts` | **additive export** of `decideDispatchComposition` + `DISPATCH_REFUSAL_MESSAGES` + types. No new import, no new dependency |
| `packages/worker-daemon/src/supervisor/provider.ts` | header only: name the authority decision, point at the adapter |
| `packages/sandbox-provider-contract/src/port.ts` | header only: `:14-26` rewritten from "OPEN item" to the settled demotion |
| `packages/worker-keystore/src/bin/sandbox-provider.ts` | **new** — the ONLY file permitted to name the provider package, and it may not name the credential |
| `packages/worker-keystore/src/bin/desktop-host.ts` | `DesktopHostDeps.provider` + `.loadProviderModule`; resolve-then-inject before `bootstrap(...)` |
| `packages/worker-keystore/package.json` | add the provider dep |
| `scripts/lib/worker-keystore-boundary.mjs` | +1 dep, +1 bare, **+`PROVIDER_HOST_PATH` confinement**, **+`FORBIDDEN_CREDENTIAL_TOKENS` ban** |
| `scripts/check-worker-keystore-boundary.test.mjs` | +6 cases (4 path, 2 credential) — **★ and the shared `manifest()` fixture (`:31-44`) gains the third dependency, plus the keychain case's own `dependencies` literal (`:166-183`). Not a detail: 15 of the file's 18 cases go red without the fixture bump (Step 5 measures it)** |
| `scripts/lib/staging-manifest-invariants.mjs` | **new invariant**: dispatch/provider switches absent from every worker, across `environment` **and** `command`/`entrypoint` |
| `scripts/check-staging-manifest.test.mjs` | +4 cases |
| `packages/sandbox-e2b-provider/src/__tests__/per-op-adapter.test.ts` | +1 totality case, **iff** §2.2b's "earn it" branch is taken (no new file — the pin is per file) |
| `packages/worker-keystore/src/__tests__/sandbox-provider.test.ts` | **new** |
| `packages/worker-keystore/src/__tests__/desktop-host-provider.test.ts` | **new** |
| `packages/worker-daemon/src/__tests__/public-surface-dispatch.test.ts` | **new** |
| `docs/replatform/current-main-crosswalk.md` | CM-010 **LAST column only** — see Step 11 |
| **Untouched, deliberately** | `worker-daemon-boundary.mjs`, `sandbox-fake-provider-boundary.mjs`, `worker-daemon/package.json`, `compose-dispatch.ts`, frozen `worker-protocol`, **CM-010's owner cell** |

---

## 6. Implementation — bite-sized TDD steps

Every step: **write the failing test → run it and read the failure → minimal implementation → run it
→ commit.**

**Standing rule added in revision 1, extended in revision 2:** four always-on `policy` guards react
to files this ticket adds or edits, and each must be updated **in the commit that trips it**, never
later. A commit that lands red
and is fixed by the next one is a commit nobody can bisect through.

| Trips on | Fix in the same commit |
|---|---|
| a new file under any `__tests__` | `scripts/test-inventory.json` pin |
| production source naming `E2bSandboxProvider` | `scripts/gate-clause-wiring.json` `E7-1` declaration |
| `packages/worker-keystore/package.json` dependency change | `pnpm-lock.yaml` (same commit, or the lockfile step rejects it) |
| **★ `REQUIRED_RUNTIME_DEPENDENCIES` in `worker-keystore-boundary.mjs` gaining an element** | **BOTH the real `packages/worker-keystore/package.json` AND the self-test's shared `manifest()` fixture (`check-worker-keystore-boundary.test.mjs:31-44`). Two different edits — see Step 5** |

### Step 0 — the controller STOP is DISPOSITIONED; confirm the conditions, do not re-litigate
No code. **The keystore widening is already approved** — go-book decision **D-3**
(`GO-BOOK.md` **§8**), settled 2026-08-25 and explicitly listed under "do not relitigate". It
was approved **on three conditions**, and Step 0 is now the check that this plan satisfies each:

| D-3 condition | Where this plan satisfies it |
|---|---|
| (a) a `PROVIDER_HOST_PATH` confinement so **exactly one file** may name the provider | §3.2; Step 5's `PROVIDER_HOST_PATH` + the `bin/nested/` case that closes the basename hole |
| (b) the boundary checker is **tightened, not merely widened**, and its own test proves a **second naming file fails** | §3.2's *two* new rules (path + credential); Step 5's six cases; §7's five keystore mutations |
| (c) the shipped desktop default stays provider-less **and a guard asserts it** | Step 4's lock (2 mutations), Step 8's structural lock, Step 10's static deployment invariant |

D-3 also records *why* the earlier approval needed re-stating: it "leaned partly on the
staging-manifest mitigation — that build refuses to run, so it mitigates nothing." §3.3.5 now carries
the replacement (a **measured** cost, and a named handoff) rather than the phantom one, and Step 0's
presentation must lead with it: **36 packages, ~1,752 files, ~15.2 MiB unpruned**, all of it new
input to an embedded-secret scan that has already been widened once to survive its existing inputs.

If a controller nonetheless refuses on the measured cost, stop and re-plan as §3.4's new-package
alternative. Steps 1–4 are independent and may proceed regardless.

### Step 1 — the findings register records the decision (RED comes from the guard)
**RED.** Edit `findings.md` first: E6-F008 → `RESOLVED` with the D1/D2 text **and the §2.2b branch
stated explicitly** (totality case added, or option (b) superseded with a reason); E6-F004 →
`RESOLVED` with the rejection of its own proposed fix; E6-F003 stays `open`, body rewritten to the
narrowed question **on `control-net`**, with the `docker-compose.d1.yml` overload noted in one
clause.

If the "earn it" branch is chosen, add the `PROVIDER_OPERATIONS` totality case to
`packages/sandbox-e2b-provider/src/__tests__/per-op-adapter.test.ts` **in this commit** — the claim
and its evidence should not be separated by a commit boundary. It adds no file, so no pin moves.

Run `node scripts/check-finding-ownership.mjs` → **FAIL** twice with `stale_declaration`
(`finding-ownership.mjs:132-136`).

**GREEN.** Delete the E6-F008 and E6-F004 entries from `scripts/finding-ownership.json`; rewrite
E6-F003's `ownerStillOpen`/`reason` to the narrowed question + the §2.1 precondition + the correct
network, leaving it `status: "owned", ticket: "DEP-010"` (it stays open, so its key stays; the
**repoint** to a successor happens at DEP-010 completion, §2.1). Re-run → **PASS**.

**Mutation.** Re-add E6-F008 → must fail `stale_declaration`. Flip E6-F004 back to `open` in
`findings.md` → must fail `undeclared_finding`. Both directions, then restore.

**Commit:** `DEP-010: name the authoritative provider port; resolve E6-F008/E6-F004, narrow E6-F003`

### Step 2 — the dispatch decision joins worker-daemon's public surface
**Why.** The root lives outside the package and supplies the `provider` input; today it cannot import
the decision, so "the root works" would be a claim about a private function.

**RED.** `packages/worker-daemon/src/__tests__/public-surface-dispatch.test.ts` importing
`decideDispatchComposition`, `DISPATCH_REFUSAL_MESSAGES` from `../index.js`; assert
`{provider: undefined, dispatchEnabled: true, hasSelfModelReader: true, selfModel: null}` →
`{compose:false, reason:"no_provider"}`, and that with a fake provider the flag toggles
`compose:true` / `dispatch_disabled`. Run → **FAIL** (no such export).

**GREEN.** Append to `index.ts` a re-export of the function, the frozen message map, and the three
types, with a comment stating why it is public (the root is outside the package by E4-D01). Run →
**PASS**. Then `node scripts/check-worker-daemon-boundary.mjs` → **PASS** (nothing imported;
`index.ts` already re-exports from `./lifecycle/…` — `:566-567`).

**★ Same commit:** `scripts/test-inventory.json` `packages/worker-daemon` **131 → 132**. Verify with
`node scripts/check-test-inventory.mjs` → **PASS**; without the bump it reports
`packages/worker-daemon: 1 test file(s) added (132, pinned at 131) — bump the pin` and exits 1.

**Commit:** `DEP-010: export decideDispatchComposition so a composition root can assert it`

### Step 3 — the root gets a provider path (no new dependency)
**RED.** `packages/worker-keystore/src/__tests__/desktop-host-provider.test.ts` with a
`capturingBootstrap()` that records `deps.provider`; assert a directly-injected provider reaches
bootstrap. Run → **FAIL**.

**GREEN.** Widen the `@armyofagents/worker-daemon` import with `type SandboxProvider`; add
`readonly provider?: SandboxProvider` to `DesktopHostDeps` with a comment stating it is **absent for
the shipped binary**; pass `provider: deps.provider` in the `bootstrap({...})` call
(`desktop-host.ts:254-260`). Run → **PASS**; boundary checker → **PASS** (already-allowed specifier).

**★ Same commit:** `scripts/test-inventory.json` `packages/worker-keystore` **18 → 19**.

**Commit:** `DEP-010: give the desktop composition root a provider pass-through`

### Step 4 — LOCK the shipped default (green on arrival → mutation-checked)
**Honesty note: these pass the moment they are written.** They are regression locks, not REDs, and
earn their place only through the mutation check.

Add: the shipped shape passes **no** provider; and a **real** `bootstrapWorkerDaemon` booted from the
shipped env reports `no_provider` through a real logger.

**Mutation (both must fail, then revert):** (a) `provider: deps.provider ?? ({} as SandboxProvider)`
→ first test fails. (b) `compose-dispatch.ts:62` `if (!input.provider)` → `if (false)` → second
fails.

No new file (cases land in `desktop-host-provider.test.ts`), so no pin moves.

**Commit:** `DEP-010: lock the shipped default — no provider, no dispatch`

### Step 5 — the boundary guard: widen by one, confine to one path, ban the credential
**RED.** Add six cases to `scripts/check-worker-keystore-boundary.test.mjs`:

*Path confinement (4):* allowed from `src/bin/sandbox-provider.ts`; **rejected** from
`bin/desktop-host.ts`, from `identity-store.ts`, and from **`bin/nested/sandbox-provider.ts`** (the
exact hole the `SUBPROCESS_HOST_PATH` history taught); manifest must declare three deps.

*Credential ban (2):* a runtime file containing `E2B_API_KEY` **in code** is rejected; a runtime file
containing it **only in a comment** is *also* rejected (mirroring
`sandbox-e2b-provider-boundary.mjs:126`, which scans raw source). The second case is the one that
would otherwise pass by accident and is why the rule scans bytes, not tokens.

Run → **FAIL**.

**★ REVISION 2 — the fixture bump is part of this step, and it is bigger than the six new cases.**
`check-worker-keystore-boundary.test.mjs` has **one** shared `manifest()` helper (`:31-44`) whose
`dependencies` are hardcoded to `{worker-daemon, worker-protocol}`, and `checkTree()` (`:47-67`)
uses it as the default for **every** case. So the three-element pin below is not a change to one
assertion — it is a change to the fixture the whole file stands on. Measured, by applying the pin
verbatim and running `node --test scripts/check-worker-keystore-boundary.test.mjs` in this
worktree: **15 of 18 cases fail**, with

```
runtime dependencies must equal ["@armyofagents/sandbox-e2b-provider",
"@armyofagents/worker-daemon","@armyofagents/worker-protocol"],
got ["@armyofagents/worker-daemon","@armyofagents/worker-protocol"]
```

— including `accepts the legitimate shape`, all five subprocess-confinement cases, both `ACCEPTS`
cases (`statSync`, and the word inside a comment), and `the REAL package on disk passes clean`.
**Two different edits fix them.**

| Failing set | Fixed by |
|---|---|
| 14 synthetic cases (everything built through `checkTree`) | add `"@armyofagents/sandbox-e2b-provider": "workspace:*"` to the **`manifest()` fixture's `dependencies`** at `:31-44` |
| `the REAL package on disk passes clean` (`:241`, which reads the real manifest) | add the same dependency to **`packages/worker-keystore/package.json`** — item (1) below |

The three that survive unaided (`REJECTS existsSync ANYWHERE`, `REJECTS a native keychain binding`,
`REJECTS a dependency moved into peerDependencies`) do so for reasons of their own and are not
evidence the pin is safe. **One of them quietly loses meaning and should be repaired in the same
edit:** the keychain case (`:166-183`) overrides `dependencies` with its own literal
`{worker-daemon, worker-protocol, <keytar|@napi-rs/keyring|electron>}` and asserts one error matching
`/runtime dependencies must equal/`. After the pin that set is wrong in **two** ways — the extra
binding *and* the missing provider — so it would still go green if the keychain ban were removed
entirely. Add the provider to that literal too, so the only remaining difference is the keychain
binding and the case proves what its name says. This file runs at `.github/workflows/pr.yml:182-183`, inside the
**always-on** `policy` job (`:124-126`) — no `needs: changes`, no path filter — so a commit that
lands the pin without both edits is red on a required check, which is the exact thing §6's standing
rule exists to prevent. Revision 1's phrasing — *"manifest must declare three deps"*, buried among
four path-confinement assertions — did not convey that fourteen unrelated cases hang off it.

**GREEN.** In `scripts/lib/worker-keystore-boundary.mjs`: three-element
`REQUIRED_RUNTIME_DEPENDENCIES`, the specifier in `ALLOWED_BARE`, a new `PROVIDER_HOST_PATH` check in
`evaluateRuntimeSourceImports` after the `SUBPROCESS_SPECIFIERS` block (`:145-151`) whose error text
names the reason (the `e2b` SDK entering the key-holding process), and a
`FORBIDDEN_CREDENTIAL_TOKENS` scan beside the `existsSync` ban (`:171-177`) whose error text says
*zero files*, not *one host file*. **In the same edit, bump the `manifest()` fixture.** Run → the
seventeen synthetic cases **PASS**; `the REAL package on disk passes clean` still **FAILS** and the
real checker **FAILS** (manifest still two) — which is the correct intermediate state, and it is
closed by (1) below in this same commit.

**★ Then, in this same commit:**
1. add `"@armyofagents/sandbox-e2b-provider": "workspace:*"` to
   `packages/worker-keystore/package.json`;
2. `pnpm install` → `pnpm-lock.yaml` updates (the manifest change rides with it, which is what
   `pr.yml:134-145` requires);
3. append `pnpm --filter @armyofagents/sandbox-e2b-provider build` to the `verify` pre-build list at
   `.github/workflows/pr.yml:743-751`, **after** the `sandbox-provider-contract` line (it depends on
   worker-daemon + contract dist, both already built above it), and mirror it into the
   `distributed-contract` list at `:1168-1173`.

Re-run the checker → **PASS**.

**Why (3) is not optional.** `@armyofagents/sandbox-e2b-provider`'s exports resolve to `./dist`
(`package.json:6-13`) and nothing builds it before `verify` runs `pnpm -r typecheck` and
`pnpm test:run` (`pr.yml:753-760`). Step 6 requires a **literal** dynamic import, which NodeNext
type-resolves — so `worker-keystore`'s `tsc --noEmit` needs the `.d.ts`, and its vitest project
(`vitest.config.ts:24`) needs the `.js`. Locally both exist from an earlier `pnpm build`; on a fresh
CI checkout neither does. **Green locally, red in CI** is the exact failure this line prevents.

**Mutation.** (a) Drop `PROVIDER_HOST_PATH` from the comparison → the rejected-elsewhere case must
fail. (b) Remove the specifier from `ALLOWED_BARE` → the allow-at-path case must fail. (c) Narrow the
credential scan from raw source to code tokens → the comment case must fail. **(d) ★ Revert only the
`manifest()` fixture bump, leaving the pin and the real `package.json` in place → 14 synthetic cases
must fail while `the REAL package on disk passes clean` stays green.** That asymmetry is the whole
point of (d): it is the shape of the CI failure this step would otherwise have shipped, and running
it once means nobody has to take the measurement on faith. Revert all four.

**Commit:** `DEP-010: allow the provider package in worker-keystore, confined to one path, credential-free`

### Step 6 — `sandbox-provider.ts`: resolve or refuse, never guess
**RED.** `packages/worker-keystore/src/__tests__/sandbox-provider.test.ts`, pairing the **real**
`E2bSandboxProvider` with `createMockE2bTransport()` through the injected module seam (so the mock is
never reachable from production code). Cases:

- gate unset → `{kind:"none"}` **and the loader is never called**;
- explicit `"none"` → same;
- unrecognised value → `refused` (not off);
- `e2b` with no template → `refused`;
- opted-in with a template → **real** `E2bSandboxProvider` whose `advertisedOperations.has("create")`
  is true (non-vacuity);
- transport throws → `refused`, and the message **contains** `E2B_API_KEY` — asserted here, in a
  `.test.ts` the scanner skips, because §3.2 forbids the production files from typing it;
- **the default loader really is the provider package** (no injection → the real
  `@armyofagents/sandbox-e2b-provider` is what gets imported — proving the seam is not vacuous).

**★ D12, REVISED IN REVISION 2 — the explicit env was the wrong fix for the right hazard.**

Revision 1 diagnosed the hazard correctly and then prescribed a mechanism that does not touch the
site it names. Written out, the two halves do not meet:

> `requireApiKey` is `const key = explicit ?? process.env.E2B_API_KEY`
> (`packages/sandbox-e2b-provider/src/real-transport.ts:53-59`), called from the constructor at
> `:84`. **It reads the AMBIENT `process.env`.** `RealE2bTransportOptions` (`:45-51`) has exactly
> two fields — `apiKey?` and `enablePauseResume?` — **there is no `env` field**, so an env object
> cannot be forwarded through that seam at all. And §3.2 forbids the only route that could:
> `createRealE2bTransport()` is called with **no** `apiKey`, and `FORBIDDEN_CREDENTIAL_TOKENS` makes
> it illegal for any `worker-keystore` runtime file to so much as name `E2B_API_KEY`. So the
> resolver structurally cannot forward the filtered env's (absent) key.

**Deleting the key from a *copy* of `process.env` changes nothing about what `requireApiKey`
observes.** With the key exported, the seventh case would still construct a real `RealE2bTransport`
and a real `E2bSandboxProvider` — `E2bSandboxProvider`'s constructor is pure
(`e2b-provider.ts:159-175`: assign transport, default `templateId` to `"base"`, compute the
advertised-op set; no I/O) — and a `refused` assertion would fail. Revision 1 conceded this two
sentences later ("if a future refactor makes the transport read the injected env instead…") and
asserted the explicit env was the fix anyway. **That is the shape this programme keeps hitting: a
mitigation nothing performs, recorded as closed.**

**The narrowed, correct fix — change the ASSERTION, not the environment.** The seventh case exists
for one reason: to prove `loadProviderModule`'s default is really
`@armyofagents/sandbox-e2b-provider` and not a vacuous stub. That property has nothing to do with
the credential, and it can be asserted deterministically on any machine:

```ts
// Non-vacuity of the default loader — no credential on this path at all.
const mod = await loadProviderModule();
const real = await import("@armyofagents/sandbox-e2b-provider");
expect(mod.E2bSandboxProvider).toBe(real.E2bSandboxProvider);
```

The **refusal-when-no-key** behaviour is already covered, and better, by the sixth case, which
drives a transport that throws through the injected module seam and asserts the propagated message
contains `E2B_API_KEY`. Asserting it a second time through the *default* loader bought nothing except
a dependency on the ambient environment. Do not keep both.

**Keep the explicit env, for the other two variables, and say what it is for.** Passing

```ts
const { E2B_API_KEY: _omit, ...rest } = process.env;   // never mutate process.env
const env = { ...rest, AOA_WORKER_SANDBOX_PROVIDER: "e2b", AOA_WORKER_E2B_TEMPLATE: "t" };
```

to `resolveSandboxProvider(env, …)` is still right — it pins `AOA_WORKER_SANDBOX_PROVIDER` and
`AOA_WORKER_E2B_TEMPLATE` deterministically against a developer shell that happens to export either.
**It is inert with respect to the credential, which is the one variable D12 named as the reason for
the change.** Both facts go in the test's comment; a filter that reads as if it removes the
credential is worse than no filter, because the next reader stops looking.

**Lane scope, measured — this was never going to be a CI failure.** No current lane exports
`E2B_API_KEY` into the `worker-keystore` vitest project. `.github/workflows/pr.yml` never names it.
`keyed-e2b-conformance.yml` sets it but runs only
`vitest run src/__tests__/keyed-real-e2b.test.ts` inside `@armyofagents/sandbox-e2b-provider`;
`keyed-e2b-cdp-probe.yml` sets it but runs only `probe-e2b-port-exposure.mjs`. **The live exposure is
the developer machine the plan itself names, plus any future keyed lane that widens to the full
suite** — which is exactly the kind of change nobody would think to check against a test in another
package. That is why the fix is a deterministic assertion rather than an environment filter: the
filter has to be right forever, the assertion has to be right once.

Run → **FAIL**.

**GREEN.** Create the file. Exports `PROVIDER_ENV = "AOA_WORKER_SANDBOX_PROVIDER"`,
`TEMPLATE_ENV = "AOA_WORKER_E2B_TEMPLATE"`, `PROVIDER_KINDS`, `ProviderResolution`
(`none` | `provider` | `refused`), a **structural** `ProviderModule` interface, `loadProviderModule`
using a **literal dynamic** import, and `resolveSandboxProvider(env, load)`. Header states: why it is
confined, why the import is dynamic (the checker requires a literal; a static one would load the SDK
on every boot), why the provider-control credential is not named here (the transport reads it —
DEP-006 confinement, `real-transport.ts:53-59`; **and this package's boundary now forbids the token
outright**, so do not spell it even in prose), and why a bad configuration is a refusal.

**★ Same commit — `scripts/gate-clause-wiring.json`.** This is the commit in which production source
first names `E2bSandboxProvider` (the `ProviderModule` interface's property, and the `new
mod.E2bSandboxProvider(...)` construction). The counter at
`check-gate-clause-wiring.mjs:66-90` blanks imports and re-export blocks but counts both of those
lines, so `E7-1-coding-journey`'s count goes `0 → N` and
`gate-clause-wiring.mjs:105-113` raises `unwired_but_now_has_caller` → `exit 1` in the **always-on**
`policy` job. Worse than the red: the entry's stated reason — *"The package is in no other
package.json dependency list, so no production process can construct it"* — becomes **false**, and a
false reason in this register is the precise defect it was built to prevent.

Two admissible resolutions. **Pick the second unless Sprint 5 has already run:**

- **Promote to `wired`.** Honest only if you are claiming the coding journey RUNS. DEP-010 explicitly
  does not (§4): the provider is constructible, but nothing consumes `compose === true`. Promoting
  here would re-commit the aggregation error the register exists to catch.
- **★ Keep `unwired`, set `expectedReferences`, rewrite the reason.** Run
  `node scripts/check-gate-clause-wiring.mjs --counts`, read the measured number for
  `E2bSandboxProvider`, and type it into `expectedReferences` — the field exists precisely for
  "referenced but not reachable" (`gate-clause-wiring.mjs:99-104`, whose worked example is
  `runBrowserSession`). The number must be typed out, not computed, so a later reference still fires.
  Rewrite `reason` to something like:

  > *"DEP-010 (Sprint 2) gives the desktop composition root a dependency path and a one-file
  > construction seam (`packages/worker-keystore/src/bin/sandbox-provider.ts`), so the N references
  > below are that seam. It is still unreachable in a shipped boot: construction requires
  > `AOA_WORKER_SANDBOX_PROVIDER=e2b` plus a template, and even a provider-bearing daemon composes no
  > supervisor — `bin/worker-daemon.ts:347-349` has no `else` on `dispatch.compose`. Promote when
  > WRK-008 slice 2b (Sprint 3) composes the loop; the journey is proven in Sprint 5."*

  Then re-run the checker: **PASS**, and the clause is still printed on the green run's
  `DORMANT, on the record:` line — which is the outcome we want.

**★ Same commit:** `scripts/test-inventory.json` `packages/worker-keystore` **19 → 20**.

**Mutation.** (a) unrecognised-value branch → `{kind:"none"}` → its test fails. (b) missing template
→ `templateId ?? "base"` → its test fails. (c) `catch` → `{kind:"none"}` → the **transport-throws**
case fails. *(Revision 1 also claimed the default-loader case here. It no longer asserts a refusal —
see the revised D12 above — so claiming a kill for it would be a false kill.)* (d) point
`loadProviderModule`'s default at a local stub instead of the real specifier → the **non-vacuity**
case fails (this is what replaces the credential-dependent arm, and it is the mutation the seventh
case actually exists for). (e) `expectedReferences` lowered by one → `check-gate-clause-wiring.mjs`
must fail with `unwired_but_now_has_caller` (proving the number is load-bearing, not decorative).
Revert all.

**Commit:** `DEP-010: the one file that may construct a sandbox provider`

### Step 7 — wire the resolver into the root, after the control and reset branches
**RED.** Add: resolves from env and hands a real provider to bootstrap; **refuses to boot** when an
explicitly requested provider cannot be built (`ok:false`, `exit(1)`, bootstrap **never called**,
message mentions `E2B_API_KEY` — again asserted only in the `.test.ts`); **a control command must NOT
construct a provider**; **`--reset-identity` must NOT construct a provider**. Run → **FAIL**.

**GREEN.** Add `loadProviderModule?: ProviderModuleLoader` to `DesktopHostDeps`; insert the resolve
block **immediately before** `bootstrap(...)` (`desktop-host.ts:254`) — after the control branch and
after the reset branch, both of which return early. A direct `deps.provider` wins; a `refused`
resolution logs the propagated transport message, `exit(1)`, returns `{ok:false}`.

**Mutation.** Move the resolve block **above** the control branch → the two "must NOT construct"
tests must fail. Revert.

**Commit:** `DEP-010: the desktop host resolves and injects a real sandbox provider`

### Step 8 — acceptance: the provider arrives, and composition still happens nowhere
**RED/verify.** Boot the root, capture what it produced, feed **that** into the real decision:

- root-produced provider + flag on → `{compose:true}`; flag off → `dispatch_disabled`.
- shipped shape → provider `undefined` → `no_provider` for **both** flag values.
- **★ the structural lock (the primary proof, §4.1):** call the **real** `bootstrapWorkerDaemon` with
  the root-produced provider **and** `AOA_WORKER_DISPATCH_ENABLED=1`, and assert that **no supervisor
  and no poll loop were composed**. **★ REVISION 2 — the observable, named.** Revision 1 said "assert
  on the returned `BootstrapResult` + the injected logger", and `BootstrapResult`
  (`bin/worker-daemon.ts:165-172`) carries no field that distinguishes a composed loop from an
  uncomposed one (§4.1). Assert these two instead:
  - **zero `startup:` step lines** on the injected logger (`startupSteps` is `[]` with no
    `deps.reconciler` — `:355`), and
  - **`await result.shutdown("SIGTERM")`** with an injected `proc.exit` spy, then assert the
    recorded shutdown `step` names are **exactly `["health-server"]`** — no `lease-stop`, no
    `lease-drain`, no `event-outbox-*` (`:362-380`; the handler logs `{signal, step}` per step and
    always exits, `lifecycle/shutdown.ts`).

  …and that the only dispatch-related output is the refusal log line. This holds for any value of
  `hasSelfModelReader`, because `bin/worker-daemon.ts:347-349` has no `else`.
- **the reason today, as a supporting check:** the same boot reports **`no_self_model_reader`**, and
  **not** `no_provider` (the provider did arrive).

**Mutations.**

| # | Mutation | Required failure | Note |
|---|---|---|---|
| a | Add an `else` branch at `bin/worker-daemon.ts:349` that **assigns a lifecycle dep** — `deps.leasing = <a fake leasing lifecycle>` (or `deps.reconciler`/`deps.eventOutbox`), the only mechanism an `else` there can use to reach an observable (§4.1: the `const`s at `:355`/`:362-363` read `deps` *after* the block, so a locally-composed loop moves nothing) | the structural-lock case must fail — the recorded shutdown `step` names move off `["health-server"]`. **Reached only with (b)+(c) also applied**, since `compose === true` is otherwise unreachable at the root | **this is the load-bearing one** — it is the shape of the mutation slice 2b will make for real (which restructures `:355-380` rather than merely inserting an `else`) |
| b | `hasSelfModelReader: false → true` at `:344` | the supporting `no_self_model_reader` case must fail | demoted; retires with slice 2b |
| c | `selfModel: null` → a valid `WorkerSelfModel` at `:345` | with (b) also applied, the decision reaches `{compose:true}` and mutation (a)'s absence is what still holds the line | closes the fourth gate, which had **no** falsifying test before revision 1 |

Revert all three.

**Commit:** `DEP-010: prove the provider arrives and that nothing composes a loop`

### Step 9 — the daemon still cannot import a provider (positive controls, none committed)
Run all five boundary checkers + their self-tests; all **PASS** with `worker-daemon-boundary.mjs:53`
and `sandbox-fake-provider-boundary.mjs:45` **byte-unchanged** (`git diff --stat` proves it).

**Positive controls — applied, run, reverted, transcribed into the result doc:**

| # | Mutation | Guard that must fire | Required failure |
|---|---|---|---|
| 1 | provider import at the top of `packages/worker-daemon/src/supervisor/provider.ts` | `check-worker-daemon-boundary.mjs` | `forbidden runtime import` (also proves the checker walks `supervisor/`, not just `bin/`) |
| 2 | provider dep in `packages/worker-daemon/package.json` | `check-worker-daemon-boundary.mjs` | `runtime dependencies must equal ["@armyofagents/worker-protocol","pino"]` |
| 3 | non-literal dynamic import in a daemon runtime file | `check-worker-daemon-boundary.mjs` | `non-literal dynamic import is forbidden` |
| 4a | **`@armyofagents/worker-daemon` added to `packages/sandbox-fake-provider/package.json`** | **`check-sandbox-fake-provider-boundary.mjs`** | `runtime dependencies must equal ["@armyofagents/worker-protocol","zod"]` (`sandbox-fake-provider-boundary.mjs:130-135`) |
| 4b | **`import type { SandboxProvider } from "@armyofagents/worker-daemon"` added to `packages/sandbox-fake-provider/src/fake-driver.ts`** | **`check-sandbox-fake-provider-boundary.mjs`** | `forbidden runtime import "@armyofagents/worker-daemon"` — proving `import type` is caught **lexically** and E6-F004's rejection is mechanical, not stylistic |
| 5 | `process.env.E2B_API_KEY` in `packages/sandbox-e2b-provider/src/per-op-adapter.ts` | `check-sandbox-e2b-provider-boundary.mjs` | credential-confinement violation (`sandbox-e2b-provider-boundary.mjs:126-128`) |
| 6 | **`E2B_API_KEY` in `packages/worker-keystore/src/bin/sandbox-provider.ts`** | **`check-worker-keystore-boundary.mjs`** | the new zero-file credential ban (Step 5) |

**★ Why #4 was replaced.** The first draft's control #4 was *"`worker-daemon` dep on
`sandbox-fake-provider` → fake boundary manifest rule"*, and that guard would never have fired:
`check-sandbox-fake-provider-boundary.mjs` iterates `SANDBOX_BOUNDARY_PACKAGES`
(`:38-41`) — `sandbox-fake-provider` and `sandbox-provider-contract` — and **never reads
worker-daemon's manifest at all**. A dep added there is caught by `check-worker-daemon-boundary.mjs`,
i.e. control #4 was a mislabelled duplicate of control #2, and E6-F004's "answer, mechanically" was
unearned. 4a/4b mutate **the fake**, which is the package whose boundary is the answer.

**No commit** — evidence only.

### Step 10 — the deployment default is provably inert too
**RED.** Four cases in `scripts/check-staging-manifest.test.mjs`. For **each** of
`AOA_WORKER_DISPATCH_ENABLED` and `AOA_WORKER_SANDBOX_PROVIDER`:

1. rejected when present in a worker service's `environment`;
2. **rejected when present in that worker's `command` or `entrypoint`.**

**★ Why (2) is not optional.** The invariant this one sits beside — `checkProviderControlBoundary`
(`staging-manifest-invariants.mjs:436-493`) — spans `environment` (`:454-456`), `env_file`
(`:459-461`), `secrets`/`configs`/`volumes` (`:465-474`) **and** `command`/`entrypoint` (`:476-481`),
because a value delivered inline is a value delivered. A new invariant registered next to it that
covers only `environment` is weaker than its neighbour for no stated reason, and
`command: ["node", "worker.js"]` with `AOA_WORKER_DISPATCH_ENABLED=1` prefixed would pass it green.
Reuse the neighbour's `command`/`entrypoint` join idiom verbatim (`:477`) so the two stay in step.

Run → **FAIL**.

**GREEN.** Add `DISPATCH_SWITCH_ENVS = ["AOA_WORKER_DISPATCH_ENABLED", "AOA_WORKER_SANDBOX_PROVIDER"]`
+ `checkDispatchDefaultOff(services, v)` to `staging-manifest-invariants.mjs`, registered in
`evaluateStagingManifestInvariants` (`:600-612`) beside `checkProviderControlBoundary`. Run →
**PASS**; real manifest → **PASS**.

**Mutation.** (a) `WORKER_SERVICES` → `[]` inside the new function → all four new cases must fail
(anti-vacuity: it really iterates workers). (b) Drop the `command`/`entrypoint` arm → the two inline
cases must fail. (c) Confirm the pre-existing `E2B_API_KEY`-on-a-worker case still fires — DEP-006
unweakened.

**Commit:** `DEP-010: make "dispatch stays off" a static deployment invariant`

### Step 11 — the headers stop contradicting each other; docs; E4-F011 closes; full gate

**★ Register — E4-F011 (HIGH), the finding this ticket owns.** This is the first commit at which its
closure condition is true, because that condition is *"ships **with a guard**"* and the guards landed
in Steps 4, 6, 7, 8 and 10. Do all three parts together:

1. **`docs/replatform/epics/E4-worker-daemon/findings.md`, `## E4-F011` → `Status: resolved`,** with
   a resolution paragraph that says what was decided, not merely that it was: *exactly one boot root
   gets a provider path (`desktop-host.ts`); the container root structurally cannot have one
   (DEP-001's image closure + `worker-daemon-boundary.mjs:53`); on the desktop root the provider
   switch defaults UNSET and the loader is never called, and `AOA_WORKER_DISPATCH_ENABLED` defaults
   OFF through the daemon's own parser (`config.ts:69`, `:150-162`) because `runDesktopHost` forwards
   `deps.env` verbatim* — i.e. §4.3, in the register's voice. **And carry §4.2's framing forward by
   stating the invariant, not a count.** The `## E4-F011` entry's title already states the invariant
   (*one of the container's four landable gates is already satisfied on the desktop*), and its body
   already carries the six-gate model (four landable + two runtime conditions). Do **not** write any
   bare gate-count number — "two gates", "zero gates", "three env vars and a session" — into that
   entry: those counts were retracted hours ago, and re-introducing one regresses a register that was
   corrected to say *"say which enumeration you mean, every time."* Resolve E4-F011 by recording that
   DEP-010 supplied the written decision (§4.3) and the guards the finding's acceptance demanded, and
   that §4.2 hands the post-Sprint-3 structural-gate loss forward — then **delete the manifest key**
   (part 2). Cite `findings.md` by section/heading (`## E4-F011`), never by line.
2. **`scripts/finding-ownership.json` → delete the `E4-F011` key**, in this same commit. Not
   optional: once the status is not `open`, a surviving entry is `stale_declaration`
   (`scripts/lib/finding-ownership.mjs:130-136`) and `check-finding-ownership.mjs` exits 1 in the
   always-on `policy` job. The two edits are one atomic change.
3. **Do NOT leave it `owned` with a rewritten `ownerStillOpen`.** That is the other admissible
   ending, and it is the wrong one here: `finding-ownership.mjs:118` only tests that the sentence is
   non-empty (`hasReason`, `:53-55`), so a rewritten-but-stale sentence fails nothing forever. The
   register is only worth what its prose is worth, and prose nothing checks has to be *retired*, not
   *edited* (§2.3).

**Verify in this commit:** `node scripts/check-finding-ownership.mjs` → OK, with the open count down
by one from Step 1's number. Whatever the checker prints on its `UNOWNED, on the record:` line, the
requirement is that **no NEW unowned finding appears and `E4-F011` is not among them** — read the
current `unowned` set off the checker's own output at execution time rather than a number pinned
here, since it drifts as findings are filed (E4-F010 is now `owned` by WRK-011, not unowned).
Deleting the E4-F011 key must not add it to that line.

**Docs.**
- `packages/worker-daemon/src/supervisor/provider.ts` header names the authority + the adapter.
- **`packages/sandbox-provider-contract/src/port.ts:14-26` rewritten** from "OPEN item … E6-F008" to
  the settled demotion. This is the one edit that stops the tree contradicting itself — that
  paragraph is currently the repo's only assertion the question is open.
- **`docs/deploy/environment-variables.md`** gains `AOA_WORKER_SANDBOX_PROVIDER` and
  `AOA_WORKER_E2B_TEMPLATE`, in the style of the existing `AOA_WORKER_DISPATCH_ENABLED` row — default,
  accepted values, and the fact that setting the provider switch without a template is a **refusal to
  boot**, not a degrade. **No guard will catch the omission:** brand-check guard 9 greps for literal
  `process.env\.AOA_[A-Z_]+` in `*.ts` (`pr.yml:648-663`), and these are read through the `PROVIDER_ENV`
  / `TEMPLATE_ENV` string constants against an injected `env` — the same reason
  `AOA_WORKER_DISPATCH_ENABLED` (read via `config.ts:69`'s `ENV` map) is documented by discipline.
  `checkEnvDocumented` (`staging-manifest-invariants.mjs:496-504`) will not help either: it only
  documents keys that **appear in the staging compose**, and Step 10 forbids these from appearing there.
- **`docs/replatform/current-main-crosswalk.md` CM-010 — LAST column ONLY.**

  **★ Do NOT add `DEP-010` to CM-010's owner cell.** The owner cell today is
  `CLI-001, CLI-004, MIG-008, DEP-006, DEP-008` (the **CM-010** row) and it is **dominated by
  MIG-008**, which depends on all four others (`program-design.md`, `#### MIG-008` → `Depends on:`).
  `DEP-010`'s own `Depends on:` is `DEP-000, WRK-004, CLI-001` (`#### DEP-010`) and **nothing depends
  on DEP-010**, so adding it leaves the row
  with no dominator → `undeclaredUndominated` → `check-dependency-graph.mjs` **exit 1**
  (`lib/dependency-graph.mjs:135-147`; `check-dependency-graph.mjs:59-64`). The last column is prose
  and is never parsed as an owner list: the owner cell is found by an *"exclusively a ticket list"*
  regex (`lib/dependency-graph.mjs:81-84`), which a prose cell mentioning ticket ids cannot match —
  which is exactly how the existing DEP-006 and CLI-001 dispositions already live there. Write the
  DEP-010 disposition the same way.

**Then the full gate** — every command, and the reason each is on the list:

| Command | Why |
|---|---|
| `pnpm -r build` | the new dep must resolve topologically |
| `pnpm -r typecheck` | catches the missing `sandbox-e2b-provider` dist locally *before* CI does |
| `pnpm test:run` (or the five packages individually) | worker-keystore's project needs the built dist |
| all five boundary checkers + self-tests | Step 9's byte-unchanged claim |
| `node scripts/check-staging-manifest.mjs` + self-test | Step 10 |
| `node scripts/check-finding-ownership.mjs` | Steps 1 **and 11** — Step 1 deletes E6-F008/E6-F004, Step 11 deletes **E4-F011**. Both are `findings.md` + manifest in one commit, or the guard is red |
| **`node scripts/check-gate-clause-wiring.mjs`** | **★ Step 6's declaration. Must be GREEN, not tolerated red.** Confirm the run prints `E7-1-coding-journey` on its `DORMANT, on the record:` line |
| **`node scripts/check-test-inventory.mjs`** | **★ the three pin bumps (worker-daemon 132, worker-keystore 20)** |
| **`node scripts/check-dependency-graph.mjs`** | **★ the crosswalk edit — must still report `4 undominated rows all declared`** |
| **`node scripts/check-execution-census.mjs`** | green unchanged: this ticket adds **no** new `.mjs` test file, only cases. If that ever changes, `scripts/test-execution-census.json` needs a new entry |
| `node scripts/check-guard-inventory.mjs` | green unchanged: no new `scripts/check-*.mjs` |
| `node scripts/check-ticket-graph-coverage.mjs` | pre-existing gate |

**Commit:** `DEP-010: one authoritative provider port, documented where it was contradicted; close E4-F011`

---

## 7. Guard mutation matrix

| Guard | Touched? | Mutation | Expected |
|---|---|---|---|
| `check-finding-ownership.mjs` | data | re-add a deleted entry | `stale_declaration` |
| " | " | flip E6-F004 back to `open` | `undeclared_finding` |
| " | " | **★ resolve `E4-F011` in `findings.md` while its manifest key survives (Step 11)** | **`stale_declaration` — the two edits are one atomic change (§2.3, Step 11)** |
| **`check-gate-clause-wiring.mjs`** | **data** | **land `sandbox-provider.ts` without re-declaring E7-1** | **`unwired_but_now_has_caller` — the D1 blocker** |
| " | " | lower `expectedReferences` by one | `unwired_but_now_has_caller` (the number is load-bearing) |
| **`check-test-inventory.mjs`** | **data** | **omit any of the three pin bumps** | **`pinned_mismatch` … `— bump the pin`** |
| **`check-dependency-graph.mjs`** | **data** | **add `DEP-010` to CM-010's OWNER cell** | **`no ticket transitively completes […]` → exit 1** |
| `check-worker-keystore-boundary.mjs` | **yes** | provider import from a non-`PROVIDER_HOST_PATH` file (incl. `bin/nested/`) | one-path violation |
| " | " | drop the specifier from `ALLOWED_BARE` | allow-at-path fails |
| " | " | manifest declares only the old two | `runtime dependencies must equal` |
| **`check-worker-keystore-boundary.test.mjs`** | **yes** | **★ revert ONLY the shared `manifest()` fixture bump (`:31-44`), keeping the three-element pin and the real `package.json`** | **14 synthetic cases fail; `the REAL package on disk passes clean` stays green — the asymmetry that makes the fixture a same-commit requirement (Step 5)** |
| " | " | **`E2B_API_KEY` in a runtime file (code)** | **zero-file credential ban** |
| " | " | **`E2B_API_KEY` in a runtime file (comment only)** | **same — the scan is over raw source** |
| `check-worker-daemon-boundary.mjs` | **no** | provider import in `supervisor/provider.ts` | `forbidden runtime import` |
| " | " | provider dep in the daemon manifest | manifest rule |
| " | " | non-literal dynamic import | `non-literal dynamic import` |
| **`check-sandbox-fake-provider-boundary.mjs`** | **no** | **worker-daemon dep in the FAKE's manifest** | manifest rule *(replaces the old "daemon deps on the fake" control, which this guard never reads)* |
| " | " | **`import type` from worker-daemon in `fake-driver.ts`** | `forbidden runtime import` — lexical catch |
| `check-sandbox-e2b-provider-boundary.mjs` | **no** | `E2B_API_KEY` outside `real-transport.ts` | credential confinement |
| `check-staging-manifest.mjs` | **yes** | dispatch switch on a worker's `environment` | new `DISPATCH` violation |
| " | " | **dispatch switch in a worker's `command`/`entrypoint`** | **same — parity with `checkProviderControlBoundary`** |
| " | " | `WORKER_SERVICES` → `[]` inside the new function | all four new cases fail (anti-vacuity) |
| " | **no** | `E2B_API_KEY` on a worker | pre-existing violation still fires |
| `.github/workflows/pr.yml` | **yes** | remove the `sandbox-e2b-provider build` line from the **`verify`** list | `verify` red on a clean CI checkout (typecheck cannot resolve `./dist/index.d.ts`) — **the required lane** |
| " | " | remove it from the `distributed-contract` list | *no failure today* — that job resolves nothing by that name; the line is symmetry, not necessity, and this row records that honestly |
| `desktop-host.ts` resolve position | **yes** | move above the control branch | control/reset tests fail |
| `compose-dispatch.ts:62` | **no** | `if (!input.provider)` → `if (false)` | shipped-default lock fails |
| **`bin/worker-daemon.ts:349`** | **no** | **add an `else` that ASSIGNS a lifecycle dep — `deps.leasing = <fake leasing lifecycle>` (or `deps.reconciler`/`deps.eventOutbox`), applied WITH (b)+(c) so `compose === true` is reached** | **the structural inertness lock fails — `leaseSteps` at `:362` reads the assigned dep and the shutdown step names move off `["health-server"]` (§4.1). A locally-composed loop would NOT fail: the `const`s read `deps` after the if-block. The primary §4 proof** |
| `bin/worker-daemon.ts:344` | **no** | `hasSelfModelReader` → `true` | supporting check fails (retires with slice 2b) |
| **`bin/worker-daemon.ts:345`** | **no** | **`selfModel: null` → a valid self-model, APPLIED WITH the `:344` mutation** | **reaches `{compose:true}` at the real root — the only prescribed state in which the structural lock is non-vacuous. ★ Alone it is inert (`compose-dispatch.ts:64` short-circuits while `:344` is `false`), and the *decision function's* fourth gate is already falsified at `compose-dispatch.test.ts:54-59`; what revision 1 lacked was a ROOT-LEVEL entry, not any test at all (§4.1)** |

A guard whose failure nobody has seen is a guard nobody has tested — every positive control is
applied, run, reverted, and its failure text transcribed into the result doc.

---

## 8. Residual risk

1. **The `e2b` SDK now lives in the key-holding process.** Mitigated by one-file confinement, the
   lazy dynamic import (not loaded on the default path), and the credential's name being **banned
   outright** from `worker-keystore` runtime source. **Not eliminated** — this is the cost Step 0
   buys.
2. **★ The desktop artifact grows by an amount that is MEASURED but not VERIFIED, and nothing checks
   it.** The first draft said "the manifest regenerates, so nothing drifts silently." That was wrong:
   `scripts/build-desktop-staging.mjs` **refuses to run** (`:21-30` — producing its link-free input is
   an unsolved packaging step) and CI executes only its unit test (`pr.yml:365`) — the same conclusion
   go-book decision **D-3** reached independently (`GO-BOOK.md` **§8**). So:
   - **What is known:** the `e2b` closure is **36 packages, ~1,752 files, ~15.2 MiB unpruned** on this
     workspace (lockfile closure of `e2b@2.30.5`, measured at revision time). Post-prune it will be
     smaller by an uncomputable amount.
   - **What is NOT known:** the shipped size, the shipped file set, or whether the artifact's
     embedded-secret scan survives the new bytes.
   - **The handoff, explicit:** DSK-003 packaging owns this. Tell them the *scan*, not the *size*, is
     the risk — `isShippableStagingPath` already prunes third-party READMEs and benchmarks because
     pino's README and `@pinojs/redact`'s benchmarks tripped the scan with
     `password: "hunter2"`-style examples (`staging-manifest.mjs:41-51`). The e2b closure is 36
     packages of third-party bytes entering that scan for the first time. **The correct response to a
     hit is another prune rule; never a weaker scan.**
3. **`perOpToInvokeDriver` lives in the E2B package — and relocating it is not a file move.**
   The first draft called this "relocate when a second provider exists". That understates it. The
   adapter's fault vocabulary lives in `packages/sandbox-e2b-provider/src/directives.ts`, whose header
   states it
   is *"the ONE place the reserved key names live, shared by the adapter (encode) and the mock
   transport (decode) so they can never silently drift"* (`:16-17`). The **encoder** is
   `per-op-adapter.ts:61`, `:176-197`; the **decoder** is `mock-transport.ts:17`
   (`decodeCreateFaults`/`decodeExecuteFaults`). Moving the adapter out therefore means one of:
   (a) move `directives.ts` too and give the E2B mock transport a dependency on the new home;
   (b) duplicate the key names, reintroducing exactly the drift the header forbids; or
   (c) move the mock transport as well, which drags CLI-002/CLI-003's fs-write and stream directives
   with it. None is a file move. Cost this properly when a second provider actually exists.
4. **E6-F003 remains open and HIGH, by design.** Precondition written down so nobody re-derives it —
   including **which network** (`control-net`), and the warning that `docker-compose.d1.yml` uses
   `provider-ctl-net` to mean the opposite.
5. **★ Split env source — and revision 1's mitigation for it did not work.** The root reads
   `deps.env`; the transport reads `process.env` (`real-transport.ts:53-59`, called from the
   constructor at `:84`). Identical in production, and deliberate — it is what keeps the credential
   out of this package. Revision 1 then claimed the split was *"what makes Step 6's default-loader
   test environment-sensitive, which is why that test passes an explicit env with the key removed"*.
   **The explicit env does not reach that read.** `RealE2bTransportOptions` (`:45-51`) has no `env`
   field, and §3.2 forbids `worker-keystore` from forwarding a key it may not even name — so
   filtering a *copy* of `process.env` changes nothing `requireApiKey` observes. Revision 2 fixes
   this by changing the assertion, not the environment: the seventh Step 6 case now proves the
   default loader resolves the real package (identity, credential-free) and the refusal-when-no-key
   behaviour is left to the sixth case, which drives a throwing transport through the injected seam.
   The explicit env stays, for `AOA_WORKER_SANDBOX_PROVIDER` / `AOA_WORKER_E2B_TEMPLATE` only, and
   the test comment must say so — **a filter that reads as if it removes the credential is worse
   than no filter.** The split itself remains a real residual: the day the transport is refactored
   to read an injected env, the credential and the resolver finally agree on a source.
6. **`AOA_WORKER_SANDBOX_PROVIDER` is a new operator-facing switch**, and **no guard enforces that it
   is documented** (§0.1). Step 11 adds both rows to `docs/deploy/environment-variables.md` by hand;
   a reviewer must check that it happened, because CI will not.
7. **★ `AOA_WORKER_PROVIDER_URL` is a name in the D1 compose that nothing reads, and Sprint 3 was
   about to treat it as this ticket's gate.** See §10.2. Not a defect in DEP-010 — the variable
   predates it and DEP-010 adds no reader — but the coordination it needs is written down there
   rather than discovered when slice 2b's Step 9a declaration is authored.
8. **★ The desktop lane has no deployment-surface guard, and after Sprint 3 that is the whole
   exposure.** Step 10's invariant is real and container-only. §4.2 item 2 states the gap and who
   inherits it. Recorded here so it is in the residual list a reviewer actually reads, not only in
   the section about Sprint 3.
9. **★ The DEP-000 harness still never drives the daemon's supervisor.** DEP-010 resolves E6-F008 in
   the `per-op → driver` direction only (§2.2a). There is no `driver → per-op` adapter, so
   `packages/sandbox-fake-provider` cannot stand in as the daemon's provider — and the repository
   therefore maintains **two independent provider doubles**: that one for the conformance suites, and
   `packages/worker-daemon/src/__tests__/support/fake-provider.ts` for the supervisor. A behavioural
   divergence between them is invisible to every gate. Fixing it is not this ticket's job (building a
   `driver → per-op` adapter would put a fabricating provider one import away from a production path,
   §3.4), but pretending the doubles are one thing is how "the harness proves the daemon" would become
   a claim nobody checked.

---

## 9. Acceptance mapping

| Plan acceptance | Proven by |
|---|---|
| Exactly one port is authoritative and documented as such | §1 D1/D2; Step 1; Step 11 (the two headers stop contradicting) |
| The composition root injects a real `E2bSandboxProvider` via the `provider` seam | Steps 3 and 7 capture `deps.provider` through the `capturingBootstrap()` spy and assert the resolved provider reaches `bootstrap(...)`; Step 6's non-vacuity case asserts the resolved provider is a real `E2bSandboxProvider` via `advertisedOperations.has("create")` |
| The boundary checker still forbids the daemon importing a provider | Step 9 controls 1–3 — byte-unchanged guard (`worker-daemon-boundary.mjs:53`), green checker, three positive controls |
| The fake stays a leaf with no daemon surface (E6-F004's answer, mechanically) | Step 9 controls **4a + 4b**, both against `check-sandbox-fake-provider-boundary.mjs` — the guard that actually reads the fake |
| A worker with no injected provider still refuses; the shipped default is provably inert | Step 4 (lock + 2 mutations), Step 8's structural lock (real boot, provider **and** flag, **zero `startup:` steps and shutdown steps exactly `["health-server"]`**), Step 10 (static deployment invariant across `environment` + `command`/`entrypoint`) |
| Does NOT by itself turn dispatch on | §4.1's structural lock — **nothing consumes `compose === true`** (`bin/worker-daemon.ts:347-349`, no `else`); Step 8 mutation (a); Step 10. *(Not the `:344` literal, which Sprint 3 deletes.)* **★ And §4.2, which records that this proof expires when Sprint 3 writes the `else` — the clause is provable exactly once, and the plan says so rather than letting a later reader assume it still holds.** |
| Test: `compose:true` only with a real provider and the flag on | Step 8, driven by the **root-produced** provider; gate 3 (`no_self_model_reader`) is falsified by mutation (b), and gate 4 (`no_self_model`) only at the root by **(b)+(c) jointly** — (c) alone is inert because `compose-dispatch.ts:64` short-circuits on `!hasSelfModelReader` before `:65` reads `selfModel` (§4.1, §7) |
| Test: boundary run proving the daemon still cannot import | Step 9 |
| Test: port reconciliation documented against E6-F008 | Steps 1 + 11, **and** §2.2b — the resolution text must either add the `PROVIDER_OPERATIONS` totality case or state in writing that D1/D2 supersede option (b) |
| Resolves E6-F008 / E6-F004 / E6-F003 | §2 — resolved (one direction, §2.2), resolved (opposite answer, mechanically proven), explicitly deferred with its precondition and the correct network |
| **★ Resolves E4-F011 (HIGH) — the finding whose register entry names DEP-010 as owner** | §2.3 (why it was missed and what the guard cannot check); **§4.3** (the written decision: which root gets a provider, what the flag defaults to there); §4.2 (what its retracted headline count becomes after Sprint 3, in the six-gate model — state the invariant, never a bare number); Step 11 (`findings.md` → `resolved` **and** the manifest key deleted, one commit) |
| **★ Hands Sprint 3 what this ticket breaks, in writing** | **§10** — the four WRK-008 slice 2b assertions falsified on arrival, and the `AOA_WORKER_PROVIDER_URL` naming call |
| **CI is green on the commit that lands each step** | §6's standing rule + Step 11's gate table: `check-gate-clause-wiring.mjs`, `check-test-inventory.mjs`, `check-dependency-graph.mjs` all named, all in the **always-on** `policy` job (`pr.yml:124-126`) |

---

## ★ 10. What this ticket INVALIDATES downstream — read before Sprint 3

Sprint 3 is **WRK-008 slice 2b**, and its design document was written **before this one existed**.
The go-book runs it after (`GO-BOOK.md` §3, the spine; §4 *Sprint 3*). Four assertions **in that
plan's body** are true of today's tree and false the moment DEP-010 lands.

The reciprocal half is already written: `WRK-008-slice-2b-design.md` **§0.1 — "WRITTEN AGAINST THE
PRE-DEP-010 TREE"** carries the same four rows with the reformulations, and its §5 now names the two
files of ours that Sprint 3 must edit (§10.3). **The list is repeated here anyway**, because the
failure mode is asymmetric: a Sprint 3 operator who opens 2b first finds the warning; one who
arrives via this ticket's result doc, or via a red `policy` job, does not — and this is the ticket
that moved the tree. If the two lists ever disagree, 2b's is the one that must move.

**★ One register handoff runs the OTHER way — Sprint 3 relies on it, not the reverse.** DEP-010's
Step 11 flips `E4-F011` to `resolved` in `findings.md` **and deletes its `E4-F011` key** from
`scripts/finding-ownership.json`. Slice 2b's own body cites E4-F011 as *"closes only when DEP-010's
own acceptance proves the shipped desktop default constructs no provider"* and leaves the finding
`open` with its key intact (it is DEP-010's to close, not 2b's). So by the time Sprint 3 runs,
DEP-010 has already resolved E4-F011 and removed its manifest key — a downstream effect Sprint 3
cites and depends on, listed here so a Sprint 3 operator does not re-open it or re-file its key.

### 10.1 The four

| # | 2b's assertion | What this ticket does to it |
|---|---|---|
| 1 | **Step 8b's `"provider" in call === false`** — a spy on `deps.bootstrap` asserting the desktop root passes no `provider` key | **AS SHIPPED:** Steps 3+7 add a `provider` key to the `bootstrap({...})` call in `desktop-host.ts` (Step 3 added the pass-through; Step 7 moved a resolve-then-inject block **below the control/reset branches** and immediately before the bootstrap call, so the value passed is the *resolved* provider, not `deps.provider` directly — the design's original `:254-260` line moved). On the shipped default the resolver yields `{kind:"none"}`, so the key is **present with value `undefined`**, `in` is `true`, and 2b's assertion goes red. It must become a **value** assertion — `call.provider === undefined` — under an explicitly built env with `AOA_WORKER_SANDBOX_PROVIDER` and `AOA_WORKER_E2B_TEMPLATE` removed |
| 2 | **Step 9b's `check-boot-roots-provider-free.mjs`**, whose declared property is *"fails if any call site passes a `provider` key"* | `desktop-host.ts` will pass one. **This is the expensive one:** that guard lands in the **always-on `policy` job** (`.github/workflows/pr.yml:124-126` — gated on draft status only, no `changes.outputs.code` gate, no path filter), so it would be **red on every PR, docs-only ones included**. The property must be restated as *"no boot root constructs a provider **unconditionally**; the shipped default resolves to `{kind:"none"}`"* |
| 3 | **2b §2's gate table, row 1, desktop cell** — *"**no** — E4-D01 makes it unconstructable here"* | E4-D01 still holds for the **daemon package** — `worker-daemon-boundary.mjs:53` is byte-unchanged by this ticket and Step 9 proves it with three positive controls. But the **keystore** root gains `bin/sandbox-provider.ts` and can construct one. **Gate 1 stops being structural on that root** and becomes an env resolution. §4.3 is the written decision that makes that acceptable; §4.2 is what it costs |
| 4 | **Step 9a's D1 declaration**, which lists the provider gate as `providerUrl: "http://fake-provider:8080"` | This ticket's resolver never reads that variable. §10.2 |

**★ Say the weakening out loud, because rows 1 and 2 are weaker than what 2b promised.** *"This root
passes no provider"* is a property of the **shape of a call**, falsifiable only by a code change.
*"This root's shipped default resolves to no provider"* is a property of a **value under one
environment**, falsifiable by an environment variable. That is a real loss of strength, and it is
precisely the trade E4-F011 forced this ticket to write down rather than absorb quietly (§4.3), and
that §4.2 follows to its Sprint-3 conclusion.

### 10.2 Naming — `AOA_WORKER_SANDBOX_PROVIDER` is authoritative; `AOA_WORKER_PROVIDER_URL` is dead env

Slice 2b's Step 9a argues, correctly, that a D1 declaration guard parsing only
`AOA_WORKER_DISPATCH_ENABLED` *"would have stayed green straight through the event it exists to
catch"*, and therefore declares four gates per worker — one of them `providerUrl`, on the reasoning
that *"the day DEP-010's composition root reads it, D1's gate 1 flips with zero diff to
`docker-compose.d1.yml`"*. **That day does not arrive with this ticket, and 9a's declaration should
be authored knowing it.** The authoritative answer, so 9a can be written once:

| Variable | Read by | Status after DEP-010 |
|---|---|---|
| **`AOA_WORKER_SANDBOX_PROVIDER`** | `packages/worker-keystore/src/bin/sandbox-provider.ts` (`PROVIDER_ENV`), reached only from `runDesktopHost` | **THE provider switch.** Unset → `{kind:"none"}`, loader never called. This is the name a guard must parse |
| **`AOA_WORKER_E2B_TEMPLATE`** | same file (`TEMPLATE_ENV`) | Required alongside it; the switch without a template is a **refusal to boot**, not a degrade |
| **`AOA_WORKER_PROVIDER_URL`** | **nothing** | Set on both D1 workers (`docker-compose.d1.yml:304`, `:343`, commented *"declared provider execute API (fake), reachable directly"*). `grep -rn PROVIDER_URL` over `packages/`, `server/`, `scripts/` returns **zero** hits. **DEP-010 adds no reader**, and the resolver has no URL-shaped kind to add one to — `PROVIDER_KINDS` is `e2b` \| `none` |

**And D1's gate 1 does not flip when this ticket lands, for a reason stronger than "nothing reads the
variable".** The D1 workers run the **container** image: `docker/worker/Dockerfile` ends
`CMD ["node", "dist/bin/worker-daemon.js"]`, and that image's runtime closure is
`packages/worker-daemon` + `worker-protocol` + `pino` **only** (DEP-001, enforced by the daemon
boundary checker). `worker-keystore` and `sandbox-e2b-provider` are not in the image, so
`resolveSandboxProvider` is not reachable from a D1 worker process **at all** — regardless of which
environment variables that compose file sets. A containerised worker acquiring a provider needs
**E6-F003** (§2.1, §3.3 item 6), which stays open by design.

**So 9a should declare `AOA_WORKER_PROVIDER_URL` as *present and inert*, and declare
`AOA_WORKER_SANDBOX_PROVIDER` as *absent* — the gate that would actually have to move.** Declaring
the wrong name is the same defect 9a was written to prevent, aimed one variable to the left; and
declaring only the inert one would leave the real switch undeclared in both directions, which is
strictly worse than declaring nothing, because the file would *look* comprehensive.

### 10.3 A fifth item, this one already reciprocated: the public surface Step 2 publishes, Sprint 3 narrows

Step 2 makes `decideDispatchComposition`, `DISPATCH_REFUSAL_MESSAGES` and the input/refusal types a
**public export** of `packages/worker-daemon`, pinned by a new
`packages/worker-daemon/src/__tests__/public-surface-dispatch.test.ts`. Slice 2b then **changes that
surface**: it retires `no_self_model_reader` from `DispatchRefusalReason`, replaces
`hasSelfModelReader` with `hasWorkerIdentity`, adds `hasEventOutboxPath`, and swaps `selfModel` for
`selfModelRead`. Two artifacts of this ticket therefore have to move in Sprint 3:

- `public-surface-dispatch.test.ts` — the pinned surface changes shape;
- **Step 8's supporting case** (*"the same boot reports `no_self_model_reader`"*, landing in
  `packages/worker-keystore/src/__tests__/desktop-host-provider.test.ts`) — it asserts a token that
  slice 2b deletes.

**This one is not a surprise in either direction.** §4.1 already demotes that case and §7 already
marks its paired mutation *"demoted; retires with slice 2b"*, and 2b's §5 now carries a row for each
of the two files. It is listed here only so the set is complete: the expectation was always agreed;
what was unassigned was the edit, and it is now assigned to Sprint 3.

A public surface that exists so a root **outside** the package can assert against it is exactly why
Step 2 exists, and a later slice narrowing it is normal. It is a defect only when it is discovered
as a red test rather than read in advance — which is the same sentence as §10.1 row 2, and the reason
this whole section is in the plan rather than in a result doc.
