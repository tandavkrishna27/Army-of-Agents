# WRK-008 slice 2b — Design: compose the poll loop and supervisor so the daemon dispatches

**Status:** DESIGN, **revision 3** — round-2 adversarial review plus the cross-plan completeness
critic — **★ plus an `E4-F012` amendment (2026-08-25)**, which is not a fourth review pass but a
targeted correction: an independent review found that the composed daemon cannot obtain a FIRST
session, and WRK-010 §9.1.1 decided the fix. Everything it touches is marked. Throughout this
document *"the first draft"* means revision 1 and *"revision 2"* means the
version reviewed; every correction says which one it is correcting and why, because a design pass
that quietly overwrites its own reasoning teaches the next reader nothing.
**Start SHA:** the commit that adds this file.
**Epic:** `E4-worker-daemon`. **Closes:** the daemon half of E4-D12 that slice 2a left open.
**Predecessors:** [`WRK-008-slice-2-design.md`](./WRK-008-slice-2-design.md) ·
[`WRK-008-slice-2-result.md`](./WRK-008-slice-2-result.md) (landed as **2a**) ·
[`E4-D12-live-dispatch-terrain.md`](./E4-D12-live-dispatch-terrain.md)
**Depends on:** DEP-010 (a provider, Sprint 2) — SOFT · WRK-010 **slice 1** (the renewal route,
Sprint 1) — SOFT · ★ **WRK-010 slice 2 (Sprint 2.5) — HARD for §4's session composition, and after
`E4-F012` that means the whole session LIFECYCLE, not just the renewal body.** §3.2 says why; §0.1
says what Sprint 2 changes underneath this document. · ★ **WRK-011 (Sprint 2.75) — HARD.** It closes
`E4-F010` and makes the worker MATCHABLE; this slice composes ON TOP of it, threading WRK-011's
provisioning into the hello it self-checks with. **Step 0** re-scopes §4 and Step 2 against both
predecessors; without it this slice ships WRK-011's daemon half with zero callers.
**Sprint:** 3 (see `docs/replatform/GO-BOOK.md`), which runs **after** Sprint 2.75 (WRK-011)

---

## 0. What this slice is, in one paragraph

Slice 2a made the daemon *explain* why it does not dispatch. This slice makes the
`compose: true` branch **reachable**: it threads a device identity, the **provisioned** worker hello
(★ Step 0: composed ON TOP of WRK-010 slice 2's session lifecycle and WRK-011's provisioning, not
built here) and a session **store** through boot (★ `E4-F012`: the store and its first live session
are Sprint 2.5's — §3.2, §4), calls `client.selfModelRead`, assembles the
`WorkerSelfModel`, and constructs the durable event outbox, the supervisor, the lease-renewal
driver and the poll loop behind the existing default-OFF flag. After this slice `createPollLoop`
and `createSupervisor` have their **first production callers in the programme's history**. ★ Note
`client.selfModelRead` is **not** in that list: WRK-011 (Sprint 2.75) gives it its first production
caller (WRK-011 §6.2, reading the provisioning facts), one sprint before this one — §0.2 corrects
the "zero callers" wording revision 3 carried.

**It does not turn dispatch on.** Every gate that holds today still holds for **both** shipped boot
roots, and §8 proves that with executable artifacts rather than a paragraph.

> **★ Read §1.1(b) before §8.** There are **two** production boot roots — the container
> (`bin/worker-daemon.ts:398`) and the desktop (`bin/desktop-host.ts` → `aoa-worker-desktop`) — and
> they do not stand on the same number of gates. The desktop injects OS custody on every boot, so
> the identity gate is **already satisfied there**. The container's **four-LANDABLE-gate** posture
> is real (of **six** total — four you land plus two runtime conditions, §2); it is not the whole
> picture, and an earlier revision of this document asserted it as if it were. Say which set every
> time: the desktop is **three** landable of **five** total (custody already satisfied).

---

## ★ 0.1 WRITTEN AGAINST THE PRE-DEP-010 TREE — read this before Steps 8b, 9 and §5

This document was designed before DEP-010 existed, and the go-book runs DEP-010 (**Sprint 2**)
**before** this slice. DEP-010 Step 3 adds `provider: deps.provider` to the `bootstrap({...})` call
in `packages/worker-keystore/src/bin/desktop-host.ts:254-260` — today that call passes `env`,
`proc`, `identityStore`, `receiptStore`, `logFilePath` and **no `provider` key at all** — and its
Step 2 makes `decideDispatchComposition` + `DISPATCH_REFUSAL_MESSAGES` a **public export** of
`packages/worker-daemon`. Four assertions written below stop being true at that moment.

| # | Written here | What Sprint 2 does to it | Reformulate as |
|---|---|---|---|
| 1 | Step 8b's `"provider" in call === false` | the key is **present** with value `undefined`, so `in` is `true` and the assertion goes red | a **value** assertion — `call.provider === undefined` — under an env the test builds explicitly, with DEP-010's `PROVIDER_ENV` (`AOA_WORKER_SANDBOX_PROVIDER`) and `AOA_WORKER_E2B_TEMPLATE` removed |
| 2 | Step 9b's declared property — "fails if any call site passes a `provider` key" | `desktop-host.ts` will pass one. The guard lands in the **always-on `policy` job** (`pr.yml:124-127` — gated on draft status only, with no `changes.outputs.code` gate), so it would be red on **every** PR, docs-only ones included | "no boot root constructs a provider **unconditionally**; the shipped default resolves to none" — Step 9b carries the rewrite |
| 3 | §2 row 1's desktop cell — "**no** — E4-D01 makes it unconstructable here" | E4-D01 still holds for the **daemon** package (it may not import a provider, and DEP-010 leaves `worker-daemon-boundary.mjs` byte-unchanged), but the **keystore** root gains `bin/sandbox-provider.ts` and can construct one. Gate 1 stops being structural on that root | "the shipped default **resolves** to `{kind:"none"}` because `AOA_WORKER_SANDBOX_PROVIDER` is unset" |
| 4 | Step 9a's `providerUrl: "http://fake-provider:8080"` declaration, and §8 caveat (i) | DEP-010's resolver reads `AOA_WORKER_SANDBOX_PROVIDER` + `AOA_WORKER_E2B_TEMPLATE` and **never** reads `AOA_WORKER_PROVIDER_URL`. A full-tree grep still finds that name at exactly two lines — `docker-compose.d1.yml:304` and `:343` — and in no code whatsoever | declare it as **dead env**, not as a gate, and declare the container root's real provider posture instead — Step 9a carries the rewrite |

**★ Say the weakening out loud.** Items 1 and 2 are strictly **weaker** than what this document
originally promised. *"This root passes no provider"* is a property of the SHAPE of a call and is
falsifiable only by a code change. *"This root's shipped default resolves to no provider"* is a
property of a VALUE under one environment, and is falsifiable by an environment variable. **That
weakening is the honest content of `E4-F011`** — the finding says DEP-010 may not land a provider in
that root without a written decision about the flag's default on desktops, and Sprint 2 lands one.
Do not paper over it by writing a guard that asserts the stronger property and passes for the weaker
reason; that is the "green means nothing" shape this programme has been bitten by five times.

**★ Write the end state down before it arrives, not after Sprint 3.** Today the desktop's inertness
rests on one structural fact — no code path anywhere can construct a provider — plus environment.
After Sprint 2 it rests on **environment alone**: `AOA_WORKER_SANDBOX_PROVIDER`,
`AOA_WORKER_DISPATCH_ENABLED` and `AOA_WORKER_EVENT_OUTBOX_PATH`, with gate 3 already satisfied on
every boot (§1.1b). E4-F011's gate count becomes *"three environment variables and zero structural
gates."* That is a real posture change on the root DSK-003 ships as a signed installer, and it
belongs in the register rather than in a reviewer's head.

**★ One thing Sprint 3 inherits that §5 did not budget for.** DEP-010 publishes
`decideDispatchComposition`, `DISPATCH_REFUSAL_MESSAGES` and the input/refusal types from
`packages/worker-daemon/src/index.ts`, pinned by a new
`packages/worker-daemon/src/__tests__/public-surface-dispatch.test.ts`. Step 4 below **retires**
`no_self_model_reader` from `DispatchRefusalReason`, Step 7 replaces `hasSelfModelReader` with
`hasWorkerIdentity`, and Step 4 adds `hasEventOutboxPath` and swaps `selfModel` for `selfModelRead`
(today's shape is `compose-dispatch.ts:22-49`). **This slice therefore breaks Sprint 2's published
surface**, and must edit that test plus DEP-010's Step 8 supporting case ("the same boot reports
`no_self_model_reader`") — which DEP-010 itself marks *"demoted; retires with slice 2b"*, so the
expectation is agreed; only the edit was unassigned. Both are now in §5.

**Two registers this slice turns red, named by neither the original §5 nor Step 11.**

- **`scripts/test-execution-census.json`.** Step 9 adds two `*.test.mjs` files under `scripts/`.
  `scripts/check-execution-census.mjs:3-8` **fails when a `*.test.mjs` exists on disk with no entry
  in that manifest**; its `SEARCH_ROOTS` are `["scripts","docker"]` (`:28`); and it runs in the
  always-on `policy` job (`pr.yml:317-324`). A `"runs"` entry must also name the workflow **step**,
  and the checker verifies that step still names the file — so the `pr.yml` step and the manifest
  entry ride in the same commit as the test files. `scripts/test-inventory.json` is a **different**
  manifest and covers neither. (DEP-010 spotted this hazard — for itself, in its §0.1 — and the note
  was correct and in the wrong plan.)
- **`docs/deploy/environment-variables.md`.** `AOA_WORKER_EVENT_OUTBOX_PATH` (Step 5) would ship
  undocumented **with no guard firing at all**: brand-check guard 9 (`pr.yml:648-663`) greps for the
  literal `process.env.AOA_[A-Z_]+` in `*.ts`, and `config/config.ts` reads every worker variable
  through the `ENV` map (`:63-79`) against an injected `env`. The existing
  `AOA_WORKER_DISPATCH_ENABLED` row (`environment-variables.md:192`) is there by discipline, not by
  enforcement. Add the row in the same commit as Step 5, in that row's style.

---

## ★ 0.2 TWO SPRINTS RUN BEFORE THIS ONE — read this before §1.1(c), §4 and Step 2

This document was first drafted before **Sprint 2.5 (WRK-010 slice 2)** and **Sprint 2.75
(WRK-011)** existed. The go-book now sequences both between Sprint 2 and this slice, and each
changes the tree this slice composes against. Neither is optional; both are **HARD** predecessors.
**Step 0 (below, in §6) is the scoping gate that re-scopes §4 and Step 2 against them** — the
go-book §4 Sprint 3 checklist orders exactly that. The two re-scopings:

**(A) Sprint 2.5 owns the production identity + `SessionStore` construction — this slice does not
build one.** The go-book states it flatly (§4 Sprint 3 checklist): *"Sprint 2.5 now owns the
production identity + SessionStore construction … compose ON TOP of it rather than … build it."* So
2b does not construct `SessionStore`, does not derive the device key **for the session**, and does
not author the `initial = null` / renewal-thunk wiring — Sprint 2.5 built that lifecycle (the
`renew(current: WorkerSession)` signature, the required first-session bootstrap dependency, the
near-expiry threshold — all WRK-010 §9.1.1's). 2b receives that lifecycle and threads it into the
poll loop. **Anywhere below still reading as 2b constructing `SessionStore(..., initial = null)` —
§4's diagram, Step 2, Step 6, Step 7, §7 row 7b, §10's zero-residue box — is pre-2.5 wording; the
construction and its zero-residue obligation are Sprint 2.5's, and this slice composes over the
result.** (§3.2 already carries the lifecycle detail; §0.2(A) is the ownership line the go-book made
authoritative.)

**(B) Sprint 2.75 (WRK-011) makes the worker MATCHABLE, and this slice composes its provisioning.**
WRK-011 **owns and closes `E4-F010`** (`scripts/finding-ownership.json` key `E4-F010` reads
`owned`/`WRK-011`; it flips `findings.md` to `resolved` and deletes the manifest key in its own
result commit). It ships `packages/worker-daemon/src/enrollment/hello-provisioning.ts` — fold a
self-model read into a `HelloProvisioning` — and an **optional** `provisioning` input on
`buildDesktopHello` that is byte-identical when absent (WRK-011 §6.1). WRK-011's file list touches
**no composition root** (WRK-011 §3.1), and its §6.3 hands *"the composed sequence poll → offer →
self-check → ACK → supervise"* to **this** sprint. So:

- The hello this slice threads into `PollLoopDeps.self` must carry WRK-011's **provisioning** —
  folded from the self-model read via `hello-provisioning.ts` — **not** the bare
  `buildDesktopHello({workerId, targetId, deviceGeneration, platform, arch})`. Composing the bare
  hello would ship a worker that still self-rejects 100% of offers (the **pre-2.75** state §1.1(c)
  records) in the sprint whose predecessor exists to make it matchable — the exact zero-caller
  failure WRK-011 was written to avoid.
- **This slice owns the wiring WRK-011 left uncomposed:** calling `client.selfHelloRefresh()` at
  boot (refresh the snapshot + take the new session bound to the new `profile_hash`) before polling,
  and folding the provisioning into the assembled `WorkerSelfModel`. WRK-011 built the daemon and
  server halves; composing them into the boot sequence is E4-D12's live-dispatch seam, which is this
  slice.
- **Reconciled downstream:** §1.1(c)'s "false for 100% of offers" is the pre-2.75 fact and is marked
  so; §4's diagram note folds provisioning; the **Step 6 self-check test can no longer assert
  `offerSatisfiesWorker === false`** for a valid `workload.batch` offer — it asserts the mirror
  WRK-011 Step 8(c) pins (`true` over the provisioned self-model, `false` over an **unprovisioned**
  one as the negative control); §7 rows 8b/12 and Step 10's `E4-1` disposition move with it.

---

## ★ 1. Verified state — where slice 2a actually left the tree

| # | Fact | Evidence |
|---|---|---|
| 1 | `bootstrapWorkerDaemon` composes **no** loop; the **container** invocation injects nothing | `bin/worker-daemon.ts:398` |
| 2 | ★ **There is a SECOND boot root, and it injects both custody stores unconditionally** | `worker-keystore/src/bin/desktop-host.ts:114-125` (built) → `:254-260` (passed to `bootstrap`) |
| 3 | `compose: true` is **unreachable** — the decision is called with two hardcoded literals | `bin/worker-daemon.ts:337-346` (`hasSelfModelReader: false, selfModel: null`) |
| 4 | `createPollLoop` has zero production callers | `poll/poll-loop.ts:469` + one `index.ts` re-export |
| 5 | `createSupervisor` has zero production callers | `supervisor/supervisor.ts:161` |
| 6 | `client.selfModelRead` exists and has zero callers **at this document's tip** (★ WRK-011/Sprint 2.75 gives it its FIRST production caller, before this slice — §0.2(B), WRK-011 §6.2) | `transport/client.ts:313` |
| 7 | `SupervisorDeps.provider` REQUIRED; `redactionCanaries` REQUIRED (no `?? []`) | `supervisor/supervisor.ts:88`, `:123` |
| 8 | `PollLoopDeps` needs client, self, key, session, limiter, measure, supervisor, backoff | `poll/poll-loop.ts:438-454` |
| 9 | The startup reconciler is gated on a dep nothing supplies | `bin/worker-daemon.ts:355` |
| 10 | The event outbox is gated the same way | `bin/worker-daemon.ts:363` |
| 11 | `AOA_WORKER_DISPATCH_ENABLED` parses strictly, defaults OFF, throws on an unrecognised value | `config/config.ts:150-162` |

### ★ 1.1 Three things the brief did not have, found by reading rather than citing

**(a) There is no production `CapacityProbes` implementation.** `poll/capacity.ts:45-50` declares
the port; its own header says *"real impl reads `node:os` / `node:fs`"*. No such implementation
exists outside tests. **`PollLoopDeps.measure` cannot be built from what is there.** Step 1 writes
the probes.

**(b) THE CONTAINER HAS NO DEVICE KEY EITHER — a FOURTH gate. But it is a gate for the
CONTAINER ONLY, and the first draft of this document got that boundary wrong.**

For the container the argument holds. `MountedSecretKeyStore` (`identity/key-store.ts:61`) is
constructed **nowhere** outside tests. The only boot path yielding a device key is the enrolment
block, gated on `keyStoreMode === "os_keychain" && deps.identityStore && deps.receiptStore`
(`bin/worker-daemon.ts:267`) — three conditions the container's `bootstrapWorkerDaemon({env, proc})`
invocation (`:398`) satisfies zero of.

> ### ★★★ AND THE DESKTOP ROOT SATISFIES ALL THREE, ON EVERY BOOT.
>
> `packages/worker-keystore/src/bin/desktop-host.ts` builds **both** OS-custody stores
> unconditionally (`:114-125`) and passes **both** to `bootstrapWorkerDaemon` on every
> non-control, non-reset boot (`:254-260`). It is not a developer toy: `aoa-worker-desktop.ts:3`
> calls itself *"the real entry point"*, it is the package's declared `bin`
> (`worker-keystore/package.json:14-16`), and DSK-003 stages `dist/bin/aoa-worker-desktop.js`
> into the signed installer (`scripts/lib/__tests__/staging-manifest.test.mjs:142`).
>
> And the mode cannot save it. `resolveCustody` **fatally refuses** `mounted_secret` with any
> store injected (`identity/device-identity-store.ts:128-133`), and the bin turns that verdict
> into `proc.exit(1)` before the socket opens (`bin/worker-daemon.ts:213-218`). An unknown mode
> refuses too (`:138`). **Therefore any desktop host that boots at all is running `os_keychain`
> with both stores present** — the enrolment block at `:267` is entered, and **gate 3 is not a
> gate there.**
>
> The desktop is standing on **three** gates, not four: no provider, the flag, and the outbox path
> (gate 4, which this slice introduces — §2 row 4). The day DEP-010 lands a provider in a
> composition root that also builds these stores, the desktop drops to **two env vars**. That is
> precisely the risk §8 claims to have retired — and §8's claim is true only for the containerised
> D1 workers.
>
> **★ Three, not two — and revision 2 of this document said two in seven places.** The count is
> §8's own enumeration standard applied to this root: §8 counts the container at four (the flag, a
> provider-bearing root, custody + a real enrolment, an outbox path), and the desktop is that list
> minus custody, which is **three**. Gates 5 and 6 are deliberately outside that enumeration on both
> roots — a session comes from enrolling this device and a self-model comes from a different person,
> and neither is a change somebody lands. **Note the direction of the correction:** three
> *understates* nothing. Saying "two" made the desktop sound **closer** to live dispatch than the
> code has it, so the fix moves the risk posture down, not up. What it repairs is a number recorded
> in a HIGH finding (`E4-F011` in `findings.md`) and a number that would have sent the DEP-010
> implementer looking for dispatch after flipping one variable and finding
> `no_event_outbox_path` instead.

And `enrollOnce` **deliberately discards the session** (`enrollment/enroll-once.ts:310`, I13)
because `EnrollResult` is a plain literal containing `session.token` and one
`logger.info({ result })` would log a live bearer token.

So "thread a SESSION so `selfModelRead` can be called" is not passing a value along: **no session
exists after boot, by design, on either root.** §4 says where it comes from without regressing I13.

**(c) ★ PRE-2.75 STATE — read `E4-F010`, now OWNED and CLOSED by WRK-011 (Sprint 2.75), which runs
before this slice.** Everything in this subsection describes the tree BEFORE Sprint 2.75. It is kept
because it is the fact the composed hello must *stop* being true of, and because §4/Step 6 assert
the provisioned replacement against it. **A composed worker built with the BARE hello cannot be
offered work — and would REJECT the offer anyway.** The only production hello builder is
`buildDesktopHello`, whose header says it exists to emit a desktop that *"can never be matched
work"* (`enrollment/desktop-hello.ts:7-8`): with no `isolation` argument (the only production call
site, `enroll-once.ts:255-261`, passes none) its `reportedCapabilities` is the **empty array** —
`[...capabilitiesForIsolation(input.isolation ?? "none")]` at `:144`, and
`CAPABILITIES_BY_MECHANISM.none` is `[]` (`isolation-capabilities.ts:50`). ★ **Not `sandbox.*`** —
revision 3 said `sandbox.*`, which is what the builder emits under `docker`/`os_native` isolation,
never under the shipped `none`; WRK-011 §0(a) makes the same correction, and the conclusion is
*stronger*: `ceiling ∩ reported` is empty for **any** ceiling, so it can never contain the
`workload.<type>` name the frozen matcher requires. Its `policyHash` is 64 zeros (`:53`, `:154`).

★ **What WRK-011 changes:** it lets a worker present a **provisioned** hello (capabilities inside
the admin-ratified ceiling, the ratified `policyHash`, a nameplate capacity) over a new route, so
the stored snapshot becomes matchable. **This slice composes THAT hello** (§0.2(B), Step 0), not the
bare one — so the two consequences below hold for the bare hello and are exactly what Step 6's
provisioned self-check must NOT reproduce.

Two consequences, and the second is the one the first draft missed:

- **Server side.** The matcher runs over `workers.profile_snapshot`, whose only writers are
  `worker-enrollment.ts:444,470` — **there is no update channel**, so no offer is ever produced.
- **★ Worker side.** `poll-loop.ts:538` runs `offerSatisfiesWorker(deps.self, capacity, offer)`
  before ACKing, and that is the SAME frozen `workerSatisfiesRequirements`
  (`poll/capacity.ts:143-157`) over the worker's own `self.report`. Composed with the **bare**
  hello (pre-2.75), **the worker's own defense-in-depth check returns `false` for 100% of
  offers** — even a hand-crafted one. Every poll would emit `poll{outcome:"incompatible"}` and
  nothing would ever be ACKed.

**This is why §4.1 and §5 name the hello source explicitly, and why Step 6 asserts it.** ★ Post-2.75
the honest composed hello is the **provisioned** one — real facts folded from the self-model read
via `hello-provisioning.ts` (§0.2(B)), not a hand-crafted test fixture. Reaching for the poll
**fixture** hello (`__tests__/support/poll-fixtures.ts:88-93` `REPORTED_CAPABILITIES`, which *does*
contain `workload.batch`, and `:134` `policyHash: POLICY_HASH` — the same constant the registered
target profile commits at `:110`) would still be a lie: a fixture is not what boot builds. Step 6
therefore asserts the composed `self.report` is the **provisioned production hello**
`createWorkerIdentity` builds from the folded self-model, and drives `offerSatisfiesWorker` over
*that*, never over `poll-fixtures`.

---

## ★ 2. The flag stays default-OFF — and it holds a different number of gates on each root

| # | Gate (refusal token) | Fixed by | Container (D1) | ★ Desktop (`aoa-worker-desktop`) |
|---|---|---|---|---|
| 1 | a `SandboxProvider` was injected (`no_provider`) | DEP-010 | **no** — E4-D01 makes it unconstructable here, and DEP-010 leaves this root untouched (its §5 does not list `bin/worker-daemon.ts`) | **no today; an ENV RESOLUTION after Sprint 2** — DEP-010 gives this root `bin/sandbox-provider.ts`, so the shipped default refuses because `AOA_WORKER_SANDBOX_PROVIDER` is unset, not because nothing can construct a provider (§0.1 item 3) |
| 2 | `AOA_WORKER_DISPATCH_ENABLED=1` (`dispatch_disabled`) | editing env | yes, but gate 1 refuses first | yes, but gate 1 refuses first |
| 3 | a device identity exists (`no_worker_identity`) | a root injecting OS-custody stores + enrolling | **no** — `mounted_secret`, no stores (§1.1b) | ★ **ALREADY SATISFIED** on every boot (§1.1b) |
| 4 | `AOA_WORKER_EVENT_OUTBOX_PATH` is set (`no_event_outbox_path`) | editing env | yes, but 1/3 refuse first | ★ **yes — a real gate here**, though gate 1 refuses first. `runDesktopHost` forwards `env: deps.env` verbatim into the same `bootstrapWorkerDaemon` (`desktop-host.ts:254-260`), so both roots hit this gate identically, and Step 5 forbids a default. Contrast row 3, which is how this table marks a **non**-gate |
| 5 | a live session (`no_session`) | a fresh enrolment code **while the pre-2.5 code-replay body is wired** (WRK-010 **slice 2** removes the ceiling — §3.2). ★ `E4-F012`: once slice 2's device-proof body is wired, a code no longer fixes this gate at all — the first session comes from the enrolment **sink** or the bootstrap dependency (WRK-010 §9.1.1), and this row's "fixed by" moves with it | needs 3 first | reachable within 10 min of code issuance (§3.2) |
| 6 | the target has an admin-set placement profile (`no_self_model`) | an org admin | needs 1–5 first | needs 1–5 first |

**Of the four gates somebody has to LAND, the container stands on all four and the desktop on
three: gate 1, the flag, and the outbox path.** That is the correction §1.1(b) makes, and it is the
reason §8's "four simultaneous changes" answer is scoped to D1 and says so.

> **★★ THIRD CORRECTION TO THIS SENTENCE, and this time to its FRAME.** Revision 2 said *two* under
> a table that implied three. Revision 3 said *three* — right about the landable subset, and still
> wrong as a sentence, because it read as the count of the table above it and **the table has six
> rows.** Gates 5 (`no_session`) and 6 (`no_self_model`) gate dispatch exactly as hard as the other
> four; they are simply not fixed by landing a change. So: **six outstanding conditions on the
> container, five on the desktop; four landable and three landable respectively.** An independent
> review caught this after two adversarial rounds had passed over it. Say which enumeration you mean
> every single time — this document has now got that wrong three ways.

> **★ The count in this sentence must match row 4, and in revision 2 it did not.** The table
> introduced gate 4 and marked the desktop as gated on it; the sentence underneath then counted the
> desktop at two. Both cannot be right, and the table was. Apply the same enumeration §8 uses —
> flag, provider-bearing root, custody + enrolment, outbox path — and the desktop is that list minus
> custody: **three**. Anywhere this document, `E4-F011` or the gate-clause register says "two",
> it is the pre-correction number.

**The flag is still non-vacuous — and on the desktop it is doing more work than anywhere else.**
Gate 1 is structural and protects *today's* build on both roots; gate 3 protects only the
container; gate 4 is an env edit on this host and protects both. The flag is what stands between
"DEP-010 landed a provider in the desktop composition root" and "every installed desktop running
that build starts taking real leases". In tests it is reached by injection, the only way it is
reachable at all. **★ After Sprint 2, gate 1 stops being structural on the desktop** (§0.1 item 3),
so on that root the flag and the outbox path become the whole of it — three environment variables,
zero structural gates.

**Ordering, extending 2a's "deepest fact first."** `no_provider` and `no_worker_identity` are
BUILD/deployment facts no env edit fixes. `dispatch_disabled` is an explicit operator choice —
reporting anything past it for a worker deliberately switched off is noise.
`no_event_outbox_path` is an env edit **on this host**. `no_session` and `no_self_model` both come
out of the same authenticated read, and they are ordered by causality: the session is what
authenticates the read, so a dead session is discovered *before* a missing profile can be. It is
also the fixable-here-first order — a lapsed session is repaired by re-enrolling **this device**,
while `no_self_model` needs a **different person** (an org admin).

**Why `no_event_outbox_path` is a refusal rather than a default.** The supervisor's `eventSink` is
required. Composing with a no-op sink would silently drop every `attempt_started`/`terminal` event
a run emits — an evidence path failing open, invisibly, in exactly the case it matters. Same
defect class that made `redactionCanaries` required rather than `?? []`.

> **★ And the composition must not commit that defect itself, one component over.**
> `LeaseRenewalDriverDeps.eventSink` is **optional** and falls back to a literal
> `NOOP_SINK` (`lease/lease-renewal.ts:305-306`, `:342`, `:361`). The argument above is only
> honest if the driver gets the real sink too — otherwise this section refuses a boot to protect an
> evidence path while the very next line of the composition drops a different one. §4.1.1 and
> Step 6 carry the wiring and the mutant.

---

## ★ 3. Dependencies — hard or soft, answered

### 3.1 DEP-010 (the provider) — **SOFT. Ships behind the flag.**
2b is provable today by injecting `createFakeSandboxProvider` at the existing
`BootstrapDeps.provider` seam. Without DEP-010 the `compose: true` branch stays unreachable in
production — the guarantee, not the gap. DEP-010's own acceptance says the same from the other
side. Neither blocks the other.

> **★ But DEP-010 inherits a decision this slice cannot make for it (finding `E4-F011`).** The
> provider is the *last* structural gate on the desktop root (§1.1b): the moment
> `desktop-host.ts` — or anything that, like it, builds OS custody — also constructs a provider,
> that root goes from three gates to **two env vars** (the flag and the outbox path), and **zero**
> of what remains is structural. DEP-010 must state, explicitly, which root(s) it lands a provider
> in and what the flag defaults to there. 2b's contribution is that the question is on the table
> with an artifact behind it (Step 8b's refusal-token ladder) rather than being discovered from a
> desktop that started taking leases after an update.
>
> **★ In the go-book's sequence this has already happened.** DEP-010 is Sprint 2 and runs *before*
> this slice, and it does land a provider path in exactly that root. So read this paragraph as the
> statement of a decision that was made, not one that is pending: §0.1 records what it cost, and
> `E4-F011` closes only when DEP-010's own acceptance proves the shipped desktop **default**
> constructs no provider — a value property, not the structural one this finding was filed against.

### 3.2 WRK-010 — **slice 1 is SOFT; slice 2 (Sprint 2.5) is HARD for §4's composition**

> **Without WRK-010 SLICE 2, a composed worker dies at the ten-minute code-route boundary and
> cannot come back — and WRK-010's route ends up with zero production callers.**

**★ THE CORRECTION REVISION 3 MAKES, AND IT IS THE LARGEST ONE IN THIS DOCUMENT.** Revision 2 wired
§4's seam to `enroller.renew({hello, code, idempotencyKey})`. That function
(`enrollment/enroll.ts:119`) is the **enrolment code replay**, not a renewal client. Its own module
header says so in as many words: *"there is NO dedicated renew route/audience"*, *"Replay is a
lost-response RECOVERY mechanism … NOT sustained session renewal"*, and the server *"gates every
enroll — replay included — on the enrollment CODE ROUTE TTL (`CODE_TTL_MS = 10 min` …), so a replay
only succeeds while the code route is live"* (`enroll.ts:4-16`). Composing that thunk means the
worker still loses authority at ten minutes — and it means **WRK-010's route, the entire product of
Sprint 1, ships with no production caller.** That is the exact shape of the 17 unprovable gate
clauses this programme's audit exists to fix, re-committed by the ticket that was supposed to give
the route its first caller.

**Therefore: Sprint 2.5 (WRK-010 slice 2) is a HARD dependency of §4's session composition.** The
go-book inserts it between Sprints 2 and 3 for precisely this reason. §4's `renew` thunk points at
**slice 2's worker-side renewal client** — a device-proof exchange against the WRK-010 route that
needs no enrolment code at all — and not at `Enroller.renew`.

> **★ If you choose to run 2b WITHOUT 2.5, say what you are shipping.** It is a legal thing to do
> (dispatch is off by construction, so nothing is exposed), but then: the thunk falls back to the
> code replay, **the ten-minute ceiling remains in full**, `E4-F007` **stays open** and must not be
> touched, WRK-010's route still has zero callers, and §4's admission below — that the composed
> daemon re-reads a bearer credential at arbitrary later times — stands rather than being retired.
> The result doc must say all five things in its first section. What is NOT legal is composing the
> replay thunk and describing it as the WRK-010 seam being filled.
>
> **★ And there is a lifecycle change that belongs to slice 2, not to a footnote here.**
> `SessionStore.ensureFresh` (`identity/session.ts:103-107`) returns the current session while
> `now() < expiresAtMs` and calls `forceRefresh()` **only once the session is absent or already
> expired**; its own docblock states *"This is NOT a near-expiry renewal scheduler"*. The WRK-010
> route refuses an expired session by construction. So a thunk pointed at that route **from today's
> store fires exactly when the credential it must present is already dead** — the route would be
> unusable by its only caller. Slice 2 adds the near-expiry threshold (WRK-010 §3.5(i) derives a
> ≥5-minute headroom; below that a proof-replay window of up to ~4.9 minutes opens). **Step 2 below
> composes `SessionStore` unchanged**, which is correct for this slice and is stated here rather
> than composed over silently: 2b builds the injection point, 2.5 changes when it fires.
>
> **★ And a second lifecycle change, added by `E4-F012` (WRK-010 §9.1.1): slice 2 also supplies the
> FIRST session.** `enrollOnce` drops the enrolment session (`enroll-once.ts:310`) and this slice
> composes `initial = null`, so with a device-proof body the first `ensureFresh()` has no bearer to
> present. 2.5's resolution changes `SessionStoreDeps.renew` to take the session it is renewing and
> adds a required bootstrap dependency alongside it — so *when it fires* is not the only thing that
> moves. **The type this slice injects into is not the type slice 2 ships.**

**The mechanism behind the box, verified against source.** Code route 10 min, session 15
(`worker-enrollment.ts:22-23`); a session is minted **only** by enrolment; **and there is no
device-session renewal route the worker calls** — Sprint 1 ships the route server-side, and until
slice 2 nothing in `packages/worker-daemon` dials it. `SessionStore.forceRefresh`
(`identity/session.ts:125`) replays the *enroll* op, so it recovers a session **only while the
code route is live** — ≤10 min from issuance. Past that the replay 401s, the store STOPS,
`reenrollment_required` is emitted, and the poll loop stops permanently
(`poll-loop.ts:697-720`).

Worse for restarts: a worker restarted more than 10 minutes after its code was issued reaches
steady state in `enrollOnce` (identity+receipt present ⇒ `skipped`, no network), so its **first**
`ensureFresh()` 401s. It never obtains a session at all.

**Decision: 2b hard-depends on WRK-010 SLICE 2 for the session LIFECYCLE — not merely for what one
thunk points at. ★ REVISED after `E4-F012`.** The two halves used to be conflated, and revision 3
then under-corrected: it said *"the seam is one injected zero-argument thunk satisfying
`SessionStoreDeps.renew` (`identity/session.ts:52-55`) — 2b's to create, testable with an injected
fake"*, and that **is now false**. `E4-F012` established that a device-proof renewal thunk has
nothing to present on the call that matters most — the first one — and WRK-010 §9.1.1 resolves it by
changing the shape of the seam itself: **`SessionStoreDeps.renew` gains a `current: WorkerSession`
parameter, and first-session acquisition becomes a SEPARATE, REQUIRED dependency.** So:

* **(1) The lifecycle is Sprint 2.5's to define, and 2b composes ON TOP of it.** 2b does not build a
  session lifecycle; it consumes one. The seam it creates is `createWorkerIdentity`'s injection
  point (Step 2), and the shape of what gets injected is WRK-010 §9.1.1's, not this document's.
* **(2) The *body* is slice 2's**, and pointing it at `Enroller.renew` instead is not a degraded
  version of the same thing: it is a different mechanism with a ten-minute ceiling that leaves
  Sprint 1 with no caller. Dispatch being off by construction bounds the exposure, not the
  dishonesty.

> **★ Why two adversarial rounds passed over this, stated because the shape recurs.** With the
> **code-replay** body the zero-argument thunk really does mint a first session from nothing — the
> enrol route takes a *code*, not a session — so every test and every read of the pre-2.5 fallback
> is consistent. The precondition only bites once the body becomes a device-proof exchange **over a
> live session**, i.e. exactly at the hand-off this document defers. A defect that is invisible on
> the fallback and fatal on the production body is one no amount of reading the fallback will find.

**What 2b owes in exchange — acceptance items, not good intentions:**
- The `renew` thunk is the **named WRK-010 seam** (Step 2) — ★ **no longer "single-line"**, and no
  longer a thunk on its own: WRK-010 §9.1.1 pairs it with a required first-session acquisition
  dependency. DSK-001 described this as `IdentityLifecycle.acquireSession()`; **that symbol does not
  exist in code** — it appears only in two documents — but the *shape* it named is the one
  `E4-F012` forces back into existence, which is worth recording rather than quietly re-deriving.
  2b creates the injection point for real; 2.5 defines what fills it.
- ★ **2b does NOT resolve `E4-F007`.** Sprint 2.5 does, and the finding's register entry already
  says so. Resolving it here would convert a live problem into a settled one on a worker that still
  loses authority at ten minutes.
- Composing emits a **boot WARN naming the ceiling**, so no operator discovers it from a dead
  worker (Step 7).
- The result doc states the ceiling in its first section, not a footnote.

---

## ★ 4. Architecture — where the session comes from without regressing I13

> **★ READ §0.2 AND STEP 0 FIRST — this diagram is drawn against the PRE-2.5 / PRE-2.75 tree.** Two
> things below are re-scoped by predecessors that now run before this slice, and the corrections are
> §0.2's, not this diagram's: **(A)** the `SessionStore` construction is **Sprint 2.5's**, not this
> slice's (go-book §4 Sprint 3 checklist) — read `SessionStore(..., initial = null)` here as "the
> lifecycle Sprint 2.5 constructs, which this slice threads in"; **(B)** the hello
> `createWorkerIdentity` builds must carry **WRK-011's provisioning** (folded from the self-model
> read), so `offerSatisfiesWorker` ADMITS a valid offer — the `FALSE for every offer` annotation
> below is the pre-2.75 bare-hello fact, kept only to show what the provisioning must overturn.

```
enrollOnce (unchanged)              ← still returns NO session (I13 intact)
      │
      ├─ identityStore.load() ──► DeviceIdentityRecord {workerId,targetId,gen,pkcs8}
      │                                   └─ deviceKeyFromPkcs8Der(...) ──► DeviceKey
      ▼
createWorkerIdentity()              ← NEW: identity/worker-identity.ts
      ├─ buildDesktopHello({workerId, targetId, deviceGeneration, platform, arch,
      │       │              provisioning})   ← ★ POST-2.75: provisioning folded from the self-model
      │       ▲   enrollment/desktop-hello.ts:87 — THE SAME BUILDER enroll-once.ts:255 uses.
      │       └── ★ §0.2(B): WITH provisioning, offerSatisfiesWorker is TRUE for a valid offer.
      │           (Pre-2.75, the BARE hello made it FALSE for every offer — §1.1(c).)
      │           The provisioned hello is real production data, not a test fixture.
      ├─ SessionStore({now, renew, metrics, logger}, initial = null)   ← ★ CONSTRUCTED BY SPRINT 2.5 (§0.2A)
      │       └── renew: () => renewSession()      ← ★ THE WRK-010 SEAM, as 2b composes it TODAY:
      │                    ▲                          typed by SessionStoreDeps.renew
      │                    │                          (identity/session.ts:52-55), zero-argument.
      │                    │                          ★ SPRINT 2.5 CHANGES THIS TYPE — E4-F012 /
      │                    │                          WRK-010 §9.1.1: renew takes (current:
      │                    │                          WorkerSession) and a SEPARATE, REQUIRED
      │                    │                          bootstrap dependency supplies the FIRST
      │                    │                          session. Not "one thunk, swap the body".
      │                    │
      │                    ├── ★ SPRINT 2.5 (WRK-010 slice 2) — the PRODUCTION body: the
      │                    │   worker-side renewal client. A device proof over the live
      │                    │   session buys a fresh 15-minute one. NO enrolment code, no
      │                    │   ten-minute ceiling, nothing re-read off disk.
      │                    │
      │                    └── ✗ NOT `enroller.renew({hello, code, idempotencyKey})`.
      │                        That is the ENROLMENT CODE REPLAY (enroll.ts:119); its module
      │                        header (:4-16) says there is no dedicated renew route and that
      │                        the replay only succeeds while CODE_TTL_MS (10 min) is live.
      │                        Wiring it here keeps the ceiling AND leaves WRK-010's route
      │                        with zero callers (§3.2). If 2b runs before 2.5 anyway, this
      │                        is the fallback, and the "where the renewal CODE comes from"
      │                        note below is the price — read that note as PRE-2.5 ONLY.
      └─ createSessionProvider(store) ──► SessionProvider
             ├──► readWorkerSelfModel()   (client.selfModelRead)
             │       └─ assembleWorkerSelfModel({response, report: hello, sha256Fn})
             │              ▲                                        ▲
             │              │ identity/self-model.ts:45 (EXISTS)     └─ sha256Hex,
             │              └─ its `report` is the hello above          identity/device-proof.ts:101
             ├──► createEventOutboxDrain()
             └──► createPollLoop()   (deps.self = the assembled model; poll-loop.ts:538 self-checks it)
```

**★ Where the hello and the `sha256Fn` come from — the first draft named neither.**
`assembleWorkerSelfModel` REQUIRES `report: WorkerHelloV1` and `sha256Fn`
(`identity/self-model.ts:32-38`), and `PollLoopDeps.self` is that model. There is exactly one
production hello builder (`buildDesktopHello`) and exactly one production byte-digest helper
(`sha256Hex`), and the composition uses both. Note that `enrollOnce` builds its hello at
`enroll-once.ts:255` only on the ENROLLING path — a steady-state boot returns `skipped` at `:194`
before ever reaching it — so the composition builds its own from the same function and the same
persisted record, rather than receiving one.

**★ Where the renewal CODE comes from, and what that costs — PRE-SPRINT-2.5 ONLY.** Everything in
this subsection describes the fallback body (`Enroller.renew`) and evaporates the moment slice 2's
device-proof client replaces it. It is kept because a reader who ships 2b before 2.5 is entitled to
the full price list, and because a claim that the body is cheaply swappable is only credible if the
expensive body is written down as well as the cheap one. (★ The wording here used to be *"the seam
is one thunk"*; `E4-F012` retired it — WRK-010 §9.1.1, §7 clause 20. The price list is unaffected:
it describes the pre-2.5 fallback, which is where the code read lives.) `Enroller.renew` takes
`RenewInput extends EnrollInput`, which requires `code: string` (`enrollment/enroll.ts:106-113`).
In steady state `enrollOnce` returns `skipped` at `enroll-once.ts:194-204` **before**
`deps.readInput?.()` at `:207`, so **nothing in the composed path is already holding a code**. The
thunk therefore re-invokes `readEnrollmentInput(config.enrollmentCodeSource, env, readFileText)` —
the same reader, the same source, the same lazy-thunk discipline the enrolment block uses at
`bin/worker-daemon.ts:281`.

State the consequence plainly rather than leaving it implied: **the composed daemon re-reads a
bearer credential at arbitrary later times**, not only during the boot window. §4's whole argument
is an I13 argument, so this cost belongs in it and not in a footnote. Four properties keep it
acceptable, and all four are asserted in Step 2:

1. **Lazy** — a daemon never asked for a session never touches the file (a `readCode` spy at 0
   calls after construction).
2. **Named for the redactor for as long as the type permits — and revision 2 asked for something
   the type forbids.** The reader returns `enrollmentCode`, never `code`, precisely because the
   logger's redactor keys off that field name: `SENSITIVE_SUBSTRINGS` (`logging/logger.ts:57-69`)
   contains `"enrollmentcode"` and does **not** contain `"code"`, so the same bytes print in full
   under a `code` key and `[redacted]` under an `enrollmentCode` one — the property
   `enrollment/enrollment-input.ts:11-17` exists to state (`:40`, `:124`). Revision 2 then said the
   thunk "must keep that name all the way to `RenewInput`". **It cannot.** `RenewInput extends
   EnrollInput`, and `EnrollInput` declares the field literally as `code: string`
   (`enroll.ts:106-109`, `:111-113`). The achievable property — and the one Step 2 asserts — is
   that the hop into a `code` key happens **exactly once, inline in the `enroller.renew({...})`
   argument position**: never bound to a local, never placed in an object that is logged, returned
   or aggregated. That is precisely what the shipped enrolment path already does
   (`enroll-once.ts:274-278`, `code: input.enrollmentCode`), and copying its shape is the whole
   mitigation. Stating an unachievable property and then testing a weaker one is how a security
   argument rots; the weaker one is the real one, so it is the one written down.
3. **Never aggregated** — the value goes into `SessionStore`'s private field and never appears in
   a returned literal (I13, the same rule `enroll-once.ts:310` follows for the session).
4. **A read failure is a transient rethrow, not a mint** — the store does not stop, and nothing
   generates a new identity.

**WRK-010 slice 2 removes this entire subsection**: its device-proof renewal needs no code at all,
so there is no lazy read, no redactor-naming discipline, and no bearer credential re-read at
arbitrary later times. That is the second reason Sprint 2.5 is a hard dependency rather than a
nicety, beyond the ceiling in §3.2.

**Why `SessionStore` rather than returning the session from `enrollOnce`.** The store already owns
every property this slice needs — expiry, lazy acquisition (`ensureFresh`, `:103`), recovery
(`forceRefresh`, `:125`), terminal-401 stop with the `reenrollment_required` metric + warn, and
rotation detection. **★ It does not own the one property SPRINT 2.5 needs**, and this slice does not
add it: `ensureFresh` refreshes only when the session is absent or **already expired**
(`:103-107`), and its docblock says it is not a near-expiry scheduler. Composing the store
unchanged is the right call for 2b and the wrong call for a route that refuses expired sessions —
which is why the threshold is slice 2's first line of work and not a footnote here (§3.2). It holds the token in a private field and never returns it in a loggable
aggregate, so **I13 stays intact**. Changing `enrollOnce`'s **return type** to carry a session would
put a live bearer token one `logger.info` away from the log — the exact defect I13 prevents.

> **★ That last sentence is still true, and `E4-F012` did NOT overturn it — read the distinction.**
> WRK-010 §9.1.1 has `enrollOnce` gain an optional **sink** (`onSessionMinted?: (session:
> WorkerSession) => void`), invoked where `result.session` is dropped today
> (`enroll-once.ts:310`), and wired to the store. `EnrollmentOutcome` does **not** change: still
> frozen, still the same key allowlist (`:146-154`), still no `session` and no `token` key. The
> docblock's property is about the RETURNED AGGREGATE — *"a single `logger.info({ result })` would
> put a live bearer token in the logs. Nothing downstream can log what it never receives"*
> (`:140-145`) — and the outcome still never receives it. **A store is not a value anyone logs.**
> This paragraph's argument for `SessionStore` over a return type therefore stands unchanged; what
> changes is that the store now gets its first session from somewhere. ★ *How* the sink reaches a
> store from the shipped boot root is not as simple as "wire it to `set()`" — enrolment runs strictly
> before any store exists, and §10's box states the three options and their costs.

**★ RETRACTED — *"the session is minted lazily, on first `ensureFresh()`"*.** Revision 3 said that,
and `E4-F012` falsified it. With a device-proof renewal body there is nothing to mint *with* on the
first call: the store is empty, the route requires a live bearer (`worker-session-auth.ts:125-126`),
and an expired one is refused at `:100-101`. Even with the pre-2.5 code-replay body the claim only
holds inside the ten-minute code-route window, and **not at all** on a restart past it — §3.2 says
so in its own words (*"its **first** `ensureFresh()` 401s. It never obtains a session at all"*), so
this document already contained the refutation of its own sentence. What survives is the narrower,
true claim: **construction performs no acquisition** — a daemon that composes but is never asked for
a session touches neither the network nor the code file. *Where the first session comes from* is
Sprint 2.5's, per WRK-010 §9.1.1.

### 4.1 What gets composed, and what does not

| Piece | Composed? | Why |
|---|---|---|
| `ConcurrencyLimiter` | ✅ | from `config.concurrency` |
| Capacity probes | ✅ **NEW** | §1.1(a) — no production implementation exists |
| `buildDesktopHello(...)` | ✅ | §4 — `assembleWorkerSelfModel` requires a `report`, and this is the only production builder (§1.1c) |
| `SessionStore` + `SessionProvider` | ✅ **consumed** | §4, §0.2(A). ★ **Sprint 2.5 OWNS the `SessionStore` construction (go-book §4 Sprint 3 checklist); this slice does NOT build one — it threads the constructed lifecycle into the poll loop.** First-session acquisition, the `initial` seed and the `SessionStoreDeps.renew` signature are all WRK-010 §9.1.1's (`E4-F012`). Anywhere below that still shows `SessionStore(..., initial = null)` being built here is pre-2.5 wording (§0.2A) |
| Self-model **reader** | ✅ **NEW** | ★ `selfModelRead`'s **first** production caller is WRK-011 (Sprint 2.75, §0.2(B)); this slice adds the composition-path caller (`readWorkerSelfModel`, to assemble `PollLoopDeps.self`). The **assembler** is NOT new: `assembleWorkerSelfModel` already exists at `identity/self-model.ts:45` (2a shipped it with zero callers). Only `readWorkerSelfModel` is written here. |
| `sha256Hex` as the assembler's `sha256Fn` | ✅ | `identity/device-proof.ts:101` — the existing production digest helper, not a new one |
| `openEventOutboxStore` + `DurableWorkerEventSink` | ✅ | the sink is required; a no-op sink is a fail-open (§2). ★ **ONE instance, passed to BOTH the supervisor and the renewal driver** — see below |
| `createEventOutboxDrain` | ✅ | **E4 gate clause 4** |
| `createSupervisor` (`eventSink`, `redactionCanaries`, **no** `observeRun`) | ✅ | **E4 gate clause 2** |
| `createLeaseRenewalDriver` (`schedule`, **`eventSink`**) | ✅ | it DECORATES the supervisor seam; omitting it means ACKed leases are never renewed |
| `createRealRenewalSchedule()` | ✅ | ★ `LeaseRenewalDriverDeps.schedule` is **REQUIRED** (`lease/lease-renewal.ts:300`) and has no default; `:238` is the intended production value |
| `createPollLoop` | ✅ | **E4 gate clause 1** |
| `createStartupReconciler` | ❌ **DEFERRED** | §4.2 — one structural blocker (revised) |

### ★ 4.1.1 The renewal driver's `eventSink` is OPTIONAL, and that is a trap

`LeaseRenewalDriverDeps.eventSink` is `eventSink?:` (`lease/lease-renewal.ts:305-306`) and falls
back to `NOOP_SINK` (`:342`) at the one site that consumes it: the per-lease fence-close proxy
factory, `eventSink: deps.eventSink ?? NOOP_SINK` (`:361`).

That sink is where a **post-close governed-egress denial** emits its `network_denied` event — the
evidence that a run tried to reach the network after its lease was lost. Composing the driver
without it does not fail, does not warn, and does not typecheck differently. It **silently drops a
security-evidence stream**, which is the *exact* failure mode §2 uses to justify making
`no_event_outbox_path` a refusal rather than a default, and the same defect class that made
`SupervisorDeps.redactionCanaries` required. Listing `eventSink` only under `createSupervisor` —
as the first draft of §4.1 and Step 6 did — would have shipped it.

**One `DurableWorkerEventSink` instance serves both.** Its `emit` derives the delivery identity
from the event's own fields (`events/durable-event-sink.ts:40-50`, called at `:69`), so it carries
no per-consumer state and there is nothing to keep in step between two instances. Step 6 asserts
the driver's proxy reaches the same store, and carries the mutant that drops it.

### ★ 4.2 The startup reconciler is DEFERRED — for ONE reason, not two

E4's gate clause 3 is *"survives restart"*. Slice 2b **cannot honestly wire it**. The first draft
gave two blockers; **only one survives contact with the code**, and saying so matters because an
over-broad deferral is how a wireable clause stays unwired for a sprint it did not need to.

**THE BLOCKER: `leaseCandidates` has no durable local source.** `StartupReconcilerDeps` requires
`leaseCandidates: readonly LeaseOfferV1[]`, annotated *"reconstructed from durable local state
(test-injected)"* (`supervisor/startup-reconcile.ts:256-257`). There is no durable lease store —
the outbox persists *events*, not offers. The lease-authority probe would run over `[]` every
boot: **a guard that passes because it could not evaluate anything**, the failure this programme
has now hit five times. Reconstructing offers from the event stream is its own ticket, not a line
in this one.

**~~(2) `OwnershipSelector.organizationId` is not constructible at boot.~~ WITHDRAWN — it is.**
`StartupReconcilerDeps.ownershipSelector` (`:248`) requires
`{organizationId: string, targetId, workerId}` (`supervisor/provider.ts:114-119`), and
`labelsMatchSelector` (`:135-141`) requires all three to match. But `organizationId` **is** a field
of the registered target profile this slice now reads:
`RegisteredTargetProfileV1.organizationId`, and the frozen schema's own `superRefine`
**guarantees it is non-null** for `scope === "organization"` and `scope === "owner"`
(`worker-protocol/src/capabilities.ts:307-321`) — it is null only for `scope === "platform"`
(`:300-306`). D1's `worker-b` is exactly the org-scoped case:
`AOA_WORKER_TARGET_SCOPE: "organization"` (`docker-compose.d1.yml:349`) against
`docker/d1/worker-b.profile.json` `"scope": "organization"` with a non-null `organizationId`. The
first draft cited `poll-fixtures.ts:100-102` — which is a **platform-scoped** fixture, and
generalising one fixture into "not constructible" is exactly the inference this programme has been
burned by before.

**So the honest shape is conditional, and the register should say so:** wireable when
`selfModel.registeredTargetProfile.organizationId !== null`, skipped **with a named reason** when
the target is platform-scoped. That is not a placeholder org and not a silent pass. It still does
not happen in 2b, because blocker (1) holds for both scopes.

**Disposition.** `E4-3-survives-restart` stays `unwired` in `scripts/gate-clause-wiring.json`, its
`reason` rewritten to name the ONE real blocker (`leaseCandidates`) and to record that
`organizationId` is available on the self-model for org- and owner-scoped targets. A finding is
filed (§9). Recorded here rather than discovered during implementation, which is what the design
pass is for — including the part where the design pass refuted half of its own first answer.

**Partial credit is deliberately refused.** The reconciler's outbox half *is* constructible. Wiring
only that half would let the clause read as reconciling restart state while the sandbox pass — the
half the clause is about — silently did nothing. Instead Step 6 calls `drain.recover()` directly at
boot, the honest narrowly-scoped subset, attributed to **clause 4, not clause 3**.

---

## 5. Files touched

Paths are relative to `packages/worker-daemon/src` unless the package is named.

**New:** `poll/host-probes.ts` · `identity/worker-identity.ts` · `identity/self-model-read.ts` ·
`lifecycle/dispatch-runtime.ts` · `scripts/check-d1-dispatch-declared.mjs` ·
`scripts/d1-dispatch-expectation.json` · `scripts/check-boot-roots-provider-free.mjs` (Step 9b) ·
`scripts/lib/boot-roots-provider-free.mjs` (its pure half) ·
`scripts/boot-roots-expectation.json` (its declaration)

**Modified:** `lifecycle/compose-dispatch.ts` (retire `no_self_model_reader`; add
`no_worker_identity`, `no_event_outbox_path`, `no_session`; take the read RESULT rather than a bare
`selfModel`) · `config/config.ts` (`AOA_WORKER_EVENT_OUTBOX_PATH`) · `bin/worker-daemon.ts` (thread
identity → decide → read → decide → compose → register lifecycles) · `index.ts` (barrels) ·
`__tests__/support/fake-control-plane.ts` (the self-model route) ·
`scripts/gate-clause-wiring.json` (`E4-4` → `wired`; `E4-1`, `E4-2` and `E4-3` stay `unwired` —
`E4-1`/`E4-2` with `expectedReferences: 1` and rewritten reasons — see Step 10 and §4.2) ·
`scripts/guard-inventory.json` · `.github/workflows/pr.yml` · `scripts/test-inventory.json`

**★ Modified, and added in revision 3 — §5 previously presented itself as exhaustive and was not:**

| File | Why it is here |
|---|---|
| **`scripts/test-execution-census.json`** | Step 9 adds two `*.test.mjs` files under `scripts/`. `check-execution-census.mjs:3-8` fails on any `*.test.mjs` with no entry (`SEARCH_ROOTS = ["scripts","docker"]`, `:28`), and it runs in the always-on `policy` job (`pr.yml:317-324`). A `"runs"` entry must name the `pr.yml` **step**, and the checker re-verifies that the step still names the file — so manifest entry, workflow step and test file land in ONE commit. This is a **different** manifest from `scripts/test-inventory.json`, which covers neither |
| **`docs/deploy/environment-variables.md`** | one new row for `AOA_WORKER_EVENT_OUTBOX_PATH`, in the style of the `AOA_WORKER_DISPATCH_ENABLED` row at `:192`. **No guard will catch its absence** — brand-check guard 9 (`pr.yml:648-663`) greps for literal `process.env.AOA_[A-Z_]+`, and `config/config.ts` reads through the `ENV` map (`:63-79`). Discipline is the only mechanism |
| **`packages/worker-daemon/src/__tests__/public-surface-dispatch.test.ts`** | ★ **Sprint 2's file, broken by Sprint 3.** DEP-010 Step 2 publishes `decideDispatchComposition`, `DISPATCH_REFUSAL_MESSAGES` and the input/refusal types from `index.ts` and pins them with this test. Step 4 retires `no_self_model_reader`, Step 7 replaces `hasSelfModelReader` with `hasWorkerIdentity`, and the input gains `hasEventOutboxPath` and swaps `selfModel` for `selfModelRead`. Update the pinned surface here, in the commit that changes it |
| **DEP-010's Step 8 supporting case** | its *"the same boot reports `no_self_model_reader`, and **not** `no_provider`"* case asserts a token this slice deletes. DEP-010 already marks the paired mutation *"demoted; retires with slice 2b"*, so the expectation was agreed and only the edit was unassigned. DEP-010 adds no new file at Step 8 (its keystore test-inventory pin moves 18 → 20 across Steps 3 and 7), so **find it by grepping the token, not by the filename** — most likely `packages/worker-keystore/src/__tests__/desktop-host-provider.test.ts`, which is where its Step 4 says its cases land |
| **`docs/replatform/epics/E4-worker-daemon/findings.md`** | `E4-F011`'s title and body say **two** gates; §1.1(b) and §2 now say **three**. A HIGH finding carrying a number the owning design has corrected is exactly the "one document asserting what another has retracted" failure this register exists to stop. Status stays `open`, the manifest key stays, ownership stays DEP-010 — text only. Also add `E4-F008`'s disposition per §9 |

**Deliberately NOT modified by THIS slice:** `packages/worker-keystore/src/bin/desktop-host.ts`.
★ **Read that as "this slice adds nothing to it", not as "it passes no provider" — after Sprint 2 it
does** (§0.1). Step 9b's guard turns the shipped *default* into a checked property, and Step 8b
turns it into an assertion; neither can any longer assert the absence of the key itself.

**New tests:** `host-probes.test.ts` · `worker-identity.test.ts` ·
`self-model-read.component.test.ts` · `dispatch-runtime.test.ts` ·
`dispatch-composition-2b.test.ts` · `shipped-binary-refuses.test.ts` ·
`scripts/lib/__tests__/d1-dispatch-declared.test.mjs` ·
`scripts/lib/__tests__/boot-roots-provider-free.test.mjs` ·
★ `packages/worker-keystore/src/__tests__/desktop-host-refuses-dispatch.test.ts`

**★ Why that last one lives in the keystore package and cannot live beside the others.** The
dependency arrow is keystore → daemon and never back:
`packages/worker-daemon/package.json:27-30` declares exactly
`@armyofagents/worker-protocol` + `pino`, and `worker-keystore/package.json:27-30` is what declares
the arrow the other way. A daemon-side test importing `runDesktopHost` would be an undeclared
dependency **and** a workspace cycle. The desktop boot root is therefore proven from the side that
owns it — which is also the side that would break it.

> **★ Revision 2 cited a checker that would not have caught it, and the citation is withdrawn.**
> That draft said `check-worker-daemon-boundary.mjs` "rejects a bare specifier under
> `packages/worker-daemon/src`", offering the guard as the enforcement behind the placement. Its
> directory walk **skips test sources entirely** — `if (kind !== "runtime") continue; // test source
> + non-source files are skipped` (`check-worker-daemon-boundary.mjs:118`), and
> `classifyRuntimeSourceFileName` returns `"test"` for any `*.test.ts`
> (`scripts/lib/worker-protocol-boundary.mjs:94-99`). A `.test.ts` under that tree is never read, so
> no import inside it is ever evaluated. The **conclusion** is unchanged and the guard is still
> named by clause 23 — for the half it does enforce: the same checker requires the manifest to
> declare **exactly** those two runtime dependencies (`:5-8`), so *declaring* the keystore dep would
> go red in `policy`. What is caught by module resolution alone, and by nothing in `policy`, is an
> **undeclared** bare import inside a daemon-side test. Say which mechanism does which; a guard
> credited with a check it does not perform is the failure class this programme keeps hitting, and
> here it was pointed at a paragraph rather than at CI.

---

## 6. The TDD steps

Each step is **RED → GREEN → mutants**, committed separately.

### ★ Step 0 — the scoping gate (NO CODE): re-scope §4 and Step 2 against the two predecessors
The go-book §4 Sprint 3 checklist orders this before any code: *"Re-scope §4 and Step 2 at Step 0 to
compose ON TOP of"* Sprint 2.5, and Sprint 2.75 (WRK-011) adds a second re-scoping. **The full
statement is §0.2; this step is the gate that makes reading it a committed action, not a footnote.**
Before writing Step 1, confirm on disk:

1. **Sprint 2.5 (WRK-010 slice 2) has SHIPPED** (its result doc is on disk) and the `SessionStore` +
   identity lifecycle it owns exists in source — this slice **consumes** it, does not construct it
   (§0.2A). If it has not, you are out of sequence; STOP.
2. **Sprint 2.75 (WRK-011) has SHIPPED** — `E4-F010` is `resolved` with its manifest key deleted
   (`scripts/finding-ownership.json`), and `packages/worker-daemon/src/enrollment/hello-provisioning.ts`
   + `buildDesktopHello`'s `provisioning` input exist (§0.2B). If not, you are out of sequence; STOP
   — composing the bare hello would ship WRK-011's daemon half with an unmatchable worker, the exact
   failure Sprint 2.75 exists to prevent.
3. **Re-scope the affected sections to match**, per §0.2's two blanket corrections: §4's diagram,
   Step 2, Step 6, Step 7 and §7 row 7b treat `SessionStore` as **Sprint 2.5's construction** this
   slice threads in; §4 and **Step 6** compose and self-check the **provisioned** hello — Step 6's
   `offerSatisfiesWorker` ADMITS a valid offer and its mirror over the unprovisioned hello REFUSES
   (the shape WRK-011 Step 8(c) pins) — never the bare one and never a poll fixture.

**What this slice OWNS that WRK-011 left uncomposed:** the boot sequence that calls
`client.selfHelloRefresh()` (refresh the snapshot, take the new session bound to the new
`profile_hash`) before polling, folds the provisioning into the assembled `WorkerSelfModel`, and
threads that model into `PollLoopDeps.self`. WRK-011 built both halves and its file list touches no
composition root (WRK-011 §3.1, §6.3); wiring them into boot is E4-D12's live-dispatch seam, which
is this slice.

### Step 1 — the production capacity probes
`createHostCapacityProbes({cpuCount, freeMemoryBytes, diskFree})`, each wrapped in
`zeroOnThrow`. **★ Every probe fails to ZERO.** A throwing probe is a host quirk (an unusual
filesystem, a container without `statfsSync`), not a reason to kill a daemon mid-poll. Zero is
fail-closed: the worker advertises no capacity and is offered nothing. Inventing a number is the
dangerous direction. **★ POSITIVE CONTROL** with working injected probes reporting the real
numbers — without it the throw test would pass equally against a stub that always returns 0.
Plus: the result satisfies the frozen `workerCapacitySchema` through `measureCapacity`.
*Mutants (4):* delete the `try`; `catch` returns 1; delete the `<= 0 → 0` clamp; change
`MILLIS_PER_CORE`.

### Step 2 — the worker identity + session lifecycle (**the WRK-010 seam**)

> **★ RE-SCOPED BY §0.2 / Step 0 — read this before the paragraph below.** As written, this step has
> 2b construct `SessionStore(..., initial = null)`. **Sprint 2.5 now owns that construction**
> (§0.2A, go-book §4 Sprint 3 checklist), so in the executed slice `createWorkerIdentity` **receives**
> the constructed session lifecycle rather than building it; the `initial` seed and the
> `SessionStoreDeps.renew` signature are WRK-010 §9.1.1's. And the hello it builds must carry
> **WRK-011's `provisioning`** (§0.2B), so `buildDesktopHello({…, provisioning})`, not the bare call.
> The rest of this step (key re-derivation from persisted bytes, hello-here-not-in-the-reader,
> no-acquisition-at-construction) is body-independent and stands.

`createWorkerIdentity({record, platform, arch, now, readCode, renewSession, metrics, logger})` →
`{key, workerId, targetId, deviceGeneration, hello, session, store}`. Re-derives the key from the
**persisted** bytes (the same rule enroll-once follows, so an envelope round-trip bug surfaces on
first boot rather than after the server committed). `SessionStore` with `initial = null` — ★ per the
box above, constructed by Sprint 2.5 and threaded in here, not built by this slice.

**★ It also builds the hello**, via `buildDesktopHello({…, provisioning})` — the same function
`enroll-once.ts:255` uses, from the same persisted record, ★ now with WRK-011's folded provisioning
(§0.2B). It lives here rather than in the reader because both the reader
(`assembleWorkerSelfModel`'s `report`) and any future renewal (`RenewInput.hello`) need the
identical value, and two construction sites are two things to keep byte-identical.

**★ `renewSession` is the WRK-010 seam**, and in production it is **slice 2's device-proof renewal
client** (Sprint 2.5), not `Enroller.renew` — §3.2. `createWorkerIdentity` never constructs the body
itself; it takes the thunk and hands it straight to `SessionStoreDeps.renew`.

> **★ CORRECTED by `E4-F012` — "swapping it changes nothing else" is RETIRED, not weakened.**
> Revision 3 called this *"ONE injected thunk — swapping it changes nothing else"* and made that an
> asserted property. It is **false** under WRK-010 §9.1.1: slice 2 changes `SessionStoreDeps.renew`
> to `(current: WorkerSession) => Promise<WorkerSession>` and adds a **separate, required**
> first-session dependency, so swapping the body changes the injected *type* — `createWorkerIdentity`'s
> parameter list moves with it, and a composition root that supplies only a renewal body will
> **fail to compile**. That is the intended outcome (`E4-F012` survived two adversarial rounds
> precisely because nothing forced the question), but it means 2b must stop advertising a
> zero-cost swap. What 2b still owns and still asserts is the narrower property: **the body is
> injected, never constructed here** — no code path in `createWorkerIdentity` builds a renewal
> request, so slice 2 replaces the body without rewriting this module's logic, only its signature.

**★ `readCode` is the enrolment-code thunk and is PRE-2.5 ONLY**, invoked per renew, never at
construction — §4's "where the renewal CODE comes from". Once slice 2's client is the body, nothing
in the composed path reads a code and this parameter goes away with it.

Tests: key re-derived from persisted DER; **★ the hello comes from `buildDesktopHello`, not a
fixture** — asserted by equality against a direct call with the same record **and (post-2.75) the
same folded `provisioning`** (§0.2B): this is what makes the composed worker's `offerSatisfiesWorker`
honestly *matchable* on the real provisioned facts, where a poll fixture would silently make three
acceptance rows green over a worker production never builds; **★ acquires
NOTHING AT CONSTRUCTION** (constructing performs no renew **and no code read** — a spy on `readCode`
at 0 calls); **★ POSITIVE CONTROL** — the first `get()` DOES obtain a session, DOES read the code
exactly once, and returns it (without it, laziness is indistinguishable from never-wired). ★ **This
control passes only because the injected fake is a code-replay body, which mints from a *code*.
`E4-F012`: with slice 2's device-proof body the first `get()` has no bearer to present and this
control is exactly the test that would have caught it** — WRK-010 §9.1.1's S2-A1/S2-A3 are its
real-database successors, and a fake session injected here proves neither; same session while
live; **★ E4-F007** — a lapsed code route goes TERMINAL rather than spinning; a **transient**
failure rethrows unchanged and the store does **not** stop (otherwise one blip retires a worker);
**★ I13** — no returned value and no emitted log record contains the session token or the code;
**★ the renewal body is INJECTED, never constructed here** — asserted rather than promised in prose:
run the whole suite twice over two different thunk bodies (the code-replay fake and a device-proof
fake) and assert **every non-renew behaviour is identical**. ★ Note precisely what that proves and
what it does not: it proves this module contains no body-specific logic, **not** that slice 2 is a
drop-in — WRK-010 §9.1.1 changes the injected signature and adds a required first-session
dependency, so this test's own fixtures move with it. The retired wording (*"ONE injected thunk —
swapping it changes nothing else"*) is corrected in the box above and in §7 clause 20.

> **★ Which of these tests are PRE-2.5 ONLY.** The `readCode` laziness pair, the positive control's
> *"reads the code exactly once"* clause, and the `E4-F007` lapsed-code-route terminal case all
> describe the code-replay body. Once slice 2's client is the thunk they are deleted, not adapted —
> there is no code to read and no code route to lapse. The key re-derivation, the hello equality,
> the no-acquisition-at-construction assertion, the transient-rethrow, the I13 assertion and the
> body-injection test above are body-independent and survive **in substance** — ★ but two of them
> move mechanically at 2.5: the body-injection test's fixtures take the new `renew(current)`
> signature, and the suite gains the first-session dependency `E4-F012` makes required. "Survives"
> here means the property survives, not that the file compiles untouched.
*Mutants (6):* fabricate an `initial` session (★ **2b-scoped**: this slice composes `initial = null`,
so fabricating one is a lie. At 2.5 a first session arrives legitimately — from the sink or the
bootstrap dependency, WRK-010 §9.1.1 — and this mutant must be **re-derived**, not carried forward.
The count here is unchanged: 2b ships six); **pass `Date.now` instead of the injected `now`**;
swallow the `EnrollmentError`; use `generateDeviceKey()` instead of the persisted DER; replace
`createSessionProvider` with a raw `{get}` lacking the terminal wrap; **read the code eagerly at
construction instead of per renew**.

> **★ On mutant 2, which revision 2 got wrong in the way this document corrects one step later.**
> That draft listed "drop `now`". `SessionStoreDeps.now` is declared `readonly now: () => number;`
> with no `?` and no internal default (`identity/session.ts:51`), and it is read unguarded at `:93`
> (`isExpired`) and `:105` (`ensureFresh`) — so omitting it is a **type error**. That is exactly the
> defect Step 6 retracts for "omit `redactionCanaries`": a mutant that cannot compile never runs,
> and counting it inflates the 51-mutant denominator with something no harness evaluated. Making
> the same mistake in the same document, two steps apart, is worth the correction being loud.
> `Date.now` satisfies `() => number`, so the substitution **compiles and runs**, and it is killed
> by the same property "drop `now`" was reaching for: advance the injected fake clock past
> `expiresAtMs` and assert the store re-mints. Clause 21's *"all compiling"* stays true on the
> record.

### Step 3 — the self-model reader (`selfModelRead`'s composition-path caller; ★ its FIRST caller is WRK-011/Sprint 2.75)
Harness first: add the self-model route to `fake-control-plane.ts`, mirroring the client's vendored
constant so the proof is verified over the **exact** path it signs — a fake accepting a proof over
a different path would hide the one failure mode the repo-level parity guard exists for.

`readWorkerSelfModel` takes `{report: WorkerHelloV1, sha256Fn}` alongside the client + session — the
values §4 names — and returns a discriminated result: `ok{selfModel}` | `refused{no_profile |
unassemblable | session_terminal | unavailable}`. **★ NOTHING THROWS** — a daemon that throws on a
bad server response dies instead of staying up inert, which is 2a's Q3 state. **One** 401 recovery
then give up (a recover→retry→recover spin with no backoff is how a worker hammers a control plane
with a dead identity). 401/403/404 all collapse to `no_profile` **deliberately**: the route answers
the same coarse code for "no such target", "never configured", "revoked" and "stale generation" so
it is never an oracle — the worker cannot distinguish them and must not pretend it can.

**★ The four-way union is CONSUMED, not decorative.** Step 4 takes this whole result, maps
`session_terminal` to its own refusal token, and puts the remaining sub-reason in the log payload.
Computing a four-way discrimination and then collapsing it into one message was the first draft's
plan, and §3.2 makes `session_terminal` the *most likely* real refusal on any worker older than
ten minutes — so that message would have sent an operator to an org admin for a placement profile
that was fine. A union nothing reads should be deleted, not shipped; this one is read.

Tests: **★ POSITIVE CONTROL** — a live 200 assembles a **branded** self-model **whose `report` is
the hello that was passed in** (identity, not a copy — the composition-level version of that
assertion is Step 6's); **★ the proof is signed over the SAME path** the request is sent to (the
fake verifies independently; a mismatch 401s); **★ a TAMPERED provider profile fails the brand** —
refused, not degraded; a 401 asks the provider to recover **once**; a 404 is `no_profile`, distinct
from transport failure; **★ a terminal session yields `session_terminal`, NOT `no_profile`** — the
discrimination Step 4 depends on; **★ nothing throws** on garbage.
*Mutants (6):* delete the recovery branch; delete the second attempt; change 404 → `unassemblable`;
delete the `selfModel === null` check; remove the `SessionTerminalError` rethrow; **sign over
`client.pollPath` instead of `selfModelReadPath`** — this last one dies with a 401 and is the
mutant that **proves the parity guard's premise is real rather than asserted**.

### Step 4 — retire `no_self_model_reader`; add the three real reasons
**★ The slice-2a placeholder reason is GONE.** 2a's message said this build "cannot read its own
self-model yet (WRK-008 slice 2b)". 2b threads the session, so that sentence is now false. **A
refusal message describing a state the code has left is worse than none** — it sends an operator to
wait for a slice that has landed. The token is retired, not reworded; a test asserts no message
matches `/slice 2b/i`.

**★ `no_worker_identity` is distinct from `no_self_model` — different people fix them.** A daemon
with no device identity cannot AUTHENTICATE a read at all. Reporting `no_self_model` would send an
operator to an org admin for a profile that may already be set, for a host whose real problem is
that no OS-custody store was injected — exactly the mistake 2a's §5 caught, one layer down.

**★ `no_session` is distinct from `no_self_model` for the SAME reason, one layer down again — and
this one bit the first draft of THIS document.** That draft had Step 3 compute a four-way refusal
and Step 4 collapse all four into `no_self_model`, whose message is *"this target has no placement
profile; an admin must set one"* (`lifecycle/compose-dispatch.ts:79-80`). Combined with §3.2 —
where a worker older than its ten-minute code route can obtain **no session at all** — the single
most likely refusal in practice would have printed the single most misleading message available.
This document's own rule, quoted from 2a at `compose-dispatch.ts:43-44`, is that *a message that
points at the wrong person is worse than no message*. Writing the rule and then breaking it one
layer down is worse than not having written it.

So the input becomes the read RESULT rather than a bare model:

```ts
/** `null` = the read was NOT ATTEMPTED (the cheap-gates pass — see Step 7). */
readonly selfModelRead: SelfModelReadResult | null;
```

and the mapping is:

| `selfModelRead` | reason | log payload |
|---|---|---|
| `null` (not attempted) | `no_self_model` | `{ attempted: false }` |
| `refused{session_terminal}` | **`no_session`** | `{ readRefusal: "session_terminal" }` |
| `refused{no_profile}` | `no_self_model` | `{ readRefusal: "no_profile" }` |
| `refused{unassemblable}` | `no_self_model` | `{ readRefusal: "unassemblable" }` |
| `refused{unavailable}` | `no_self_model` | `{ readRefusal: "unavailable" }` |
| `ok{selfModel}` | — composes | — |

`unassemblable` and `unavailable` do **not** get their own tokens: both mean "the control plane
answered something this build could not use", the operator action is the same (retry, then read the
log), and a token per server misbehaviour is how a five-way refusal becomes a fifteen-way one. They
are not discarded either — the sub-reason rides in the structured log payload, so the four-way
discrimination Step 3 computes is never thrown away. `no_session`'s message names re-enrolling
**this device** and points at §3.2's ceiling; it must not mention placement profiles.

Six gates, precedence tested by switching one off at a time against an otherwise-composable input
with every earlier gate **also** off, plus a **★ POSITIVE CONTROL** that all six satisfied
composes, plus **★ a `session_terminal` result never produces a message matching `/admin/i`**.
*Mutants (8):* reorder each adjacent pair (5); collapse the two identity/profile messages; delete
the outbox gate; **map `session_terminal` to `no_self_model`** (the first draft's behaviour — this
mutant is the one that proves the paragraph above is a guard rather than a story).

### Step 5 — `AOA_WORKER_EVENT_OUTBOX_PATH`
Absent → `null`. **★ Not defaulted to a path:** a default the container cannot write turns every
existing deployment's inert boot into a failure. Whitespace is absence — `openEventOutboxStore("")`
would open an anonymous database that vanishes on restart, a durable outbox that is not durable.
*Mutants (2):* `|| null` → `?? null`; default to `"outbox.db"`.

### Step 6 — the dispatch runtime (the composition itself)

`composeDispatchRuntime` is **`async`**, and not by taste: `openEventOutboxStore` returns a
`Promise` (`events/event-outbox-store.ts:197`, async because it dynamically imports `node:sqlite`
under a warning filter). Step 7's call site therefore awaits it, which is also why it sits after
the health server rather than in the synchronous pre-socket block.

**Order is load-bearing, and four edges are not obvious:**
1. The outbox store opens **first** and is **recovered** (`uploading → pending`,
   `events/event-outbox-drain.ts:93`) before anything can emit into it. Recovering after the
   supervisor exists would race a fresh run's rows against the sweep.
2. The poll loop's `supervisor` seam is the **renewal driver**, not the supervisor. The driver is
   itself a `SupervisorSeam` decorating the real one. Wiring the raw supervisor **typechecks
   perfectly and silently never renews a lease** — every lease would expire mid-run and read as a
   server bug.
3. **★ The SAME `DurableWorkerEventSink` goes to BOTH `createSupervisor` and
   `createLeaseRenewalDriver`.** §4.1.1: the driver's `eventSink` is optional and defaults to
   `NOOP_SINK` (`lease/lease-renewal.ts:305-306`, `:342`, `:361`), so omitting it drops the
   post-close `network_denied` evidence stream with no error, no warning and no type change. One
   instance suffices — `emit` derives identity from the event
   (`events/durable-event-sink.ts:40-50`).
4. The KEK derives from the **device key**, not a new secret file, so a re-enrolled device cannot
   open a prior device's rows — they quarantine, fail closed.

`schedule: createRealRenewalSchedule()` is passed explicitly. `LeaseRenewalDriverDeps.schedule` is
**required and has no default** (`lease/lease-renewal.ts:300`); `:238` is the production
implementation (node timers + `Date.now`). It is named here because the first draft's dependency
list omitted it, and a required dep discovered at typecheck time is a dep nobody reasoned about.

**★ `redactionCanaries: []` is a decision, and the first draft's REASON for it was factually
wrong.** That draft said the field is *"read once at construction"*, so a construction-time array
"cannot carry a per-lease secret". It is read **per run**: `supervisor.ts:285` builds a fresh
`EventSequencer` on every accepted lease and reads `deps.redactionCanaries` at `:294`. A mutable
array passed at construction would in fact take effect per-lease. The conclusion happened to be
right; the argument for it was not, and an argument that does not hold is worse than none because
the next reader inherits it.

**The reason `[]` is actually safe today** is that nothing secret-bearing reaches the sequencer.
Every `events.terminal(...)` call in `supervisor.ts` passes `errorMessage: null`
(`:304`, `:314`, `:324`, `:353`, `:371`, `:381`) except `:410-411`, which emits
`signal:${exec.signal}` — a POSIX signal name. The one hook that *would* carry sandbox
stdout/stderr into the event stream is `SupervisorDeps.observeRun` (`:131`, consumed at
`:390-392`), and **this composition does not pass it** — it has zero production callers today. So
`[]` is correct because there is nothing to redact, not because of when the field is read. Step 6
asserts the composition passes no `observeRun`, which is what makes that reason a checked property
rather than a second story.

Capacity clamps to the self-model's **server-owned** provider ceiling
(`verifiedProviderConstraints.resourceCeiling`) — a worker advertising above it is rejected by the
frozen matcher, so composing without the clamp produces a worker that polls forever and is never
matched. `reserved` is zeroed deliberately: the limiter's slot counts are the backpressure
mechanism, and inventing a reservation number would be a second, weaker capacity authority.

Tests: **★ the loop's seam is the renewal driver**; **★ the driver's fence proxy emits into the
SAME durable store the supervisor does** (drive a post-close denial through
`driver.proxyFor(leaseId)` and read the row back — the assertion §4.1.1 exists for); **★ an event
the supervisor emits is DURABLE before it is drainable** (the one property neither component's own
tests can observe); **★ the outbox is recovered at composition**; **★ `redactionCanaries` is `[]`
and `observeRun` is `undefined`**; **★ `self.report` is the PROVISIONED hello `createWorkerIdentity`
built** (from the folded self-model, §0.2B) — asserted by identity against a direct
`buildDesktopHello({…, provisioning})` call, never a `poll-fixtures` fixture; **★ POST-2.75:
`offerSatisfiesWorker` over that provisioned `self.report` returns `TRUE` for an otherwise-valid
`workload.batch` offer parsed through `leaseOfferV1Schema`, and `FALSE` for the same offer against an
UNPROVISIONED `self.report`** (the negative control that distinguishes a working matcher from a
permissive one — WRK-011 Step 8(c)'s mirror). ★ This **replaces** revision 3's `offerSatisfiesWorker
=== false` assertion, which was the pre-2.75 bare-hello fact and is now false: WRK-011 makes the
provisioned worker matchable (§0.2B, §1.1c), so the composed worker ADMITS a valid offer;
limiter ceilings from config with live slots; **★ capacity clamped**; stop order.
*Mutants (6):* `supervisor: renewal` → `supervisor`; move recovery after the sink; drop `ceiling`;
drop `kek` from the sink but keep it on the drain; **drop the driver's `eventSink`** (it compiles,
it is silent, and only the round-trip test above kills it); constant `limiter.snapshot()`.

> **★ On the mutant that was dropped.** The first draft listed a seventh — "omit
> `redactionCanaries`" — and called it a *documented equivalent*. It is not: it does not compile,
> so it never runs, and a mutant that cannot execute is not a mutant that survived. This repo's
> convention is 2a's *"26 mutants, 26 killed, 0 survivors, 0 false kills"*; counting a compile
> error inflates the denominator with something no harness evaluated — the same "a check that
> nothing runs is not a check" failure this programme keeps hitting, pointed at the mutation score
> instead of at CI. The property is real and is still proven: **the typecheck in Step 11 is its
> artifact**, and §7 row 22 now cites that.

### Step 7 — wire it into `bootstrapWorkerDaemon`

> **★ THIS STEP RETIRES SPRINT 2's PRIMARY INERTNESS PROOF, and Sprint 2 says so itself.** DEP-010's
> §4.1 structural lock is *"nothing consumes `compose === true`; `bin/worker-daemon.ts:347-349` has
> no `else`"*, and its Step 8 mutation (a) — *"add an `else` branch at `:349` that composes anything
> observable"* — is labelled **"this is the load-bearing one — it is the mutation slice 2b will make
> for real."* Step 7 is that mutation, landed. So Sprint 2's headline acceptance is provable exactly
> once and then expires, and **nothing in the set replaces it**: after this step, inertness is
> carried by the six refusal gates and by the two artifacts in Step 8, not by a structural absence.
> Write that transfer of custody into the result doc rather than letting a reader assume DEP-010's
> proof still holds.

**★ The decision function is called TWICE, and that is the design.** The self-model read is an
authenticated round trip; performing it before the cheap gates would waste it and put a network
result in front of purely local decisions. But the bin must not re-implement the gate ORDER to know
when to skip — two copies of an ordering is how they drift. So the **same pure function** decides
twice: pass `selfModelRead: null` ("not attempted") first, and because both read-derived reasons
are **last** in the refusal order, a first answer of exactly `no_self_model` means every earlier
gate passed and only the read remains. `no_session` can never come out of the first call — it
requires a `refused{session_terminal}` result, which only the read produces.

**★ The identity gate takes a BOOLEAN, not the identity.** `decideDispatchComposition` is pure over
VALUES, so a `workerIdentity: WorkerIdentity | null` field would force `identityStore.load()` +
`deviceKeyFromPkcs8Der` + `createWorkerIdentity` to be constructed **above** the branch on every
boot — including every boot that then refuses with `no_provider`. §10's "zero residue" claim would
be false, and false in the direction that matters: a refusing daemon deriving a private key it will
not use. So the input mirrors what 2a already does for the reader
(`hasSelfModelReader: boolean`, `lifecycle/compose-dispatch.ts:46`):

```ts
readonly hasWorkerIdentity: boolean;
```

**And it costs no extra I/O, because the enrolment block already knows the answer.** Hoist one
`let workerIdentityPresent = false` above the `os_keychain` block and set it true on **both** exits
that imply an identity: the `outcome!` success path (`bin/worker-daemon.ts:311-323`) *and* the
survivable `EnrollmentAuthorityError && !err.minted` path (`:295-299`), which logs *"running idle
with the existing device identity"* and therefore has one. A container leaves it `false` without
touching anything — the block is never entered. **Do not** compute this with a fresh
`deps.identityStore?.load()`: that is a second read of the OS keychain per boot for a fact already
in scope, and the two could disagree.

The identity itself — the record load, the PKCS8 re-derivation, the hello, the `SessionStore` — is
constructed **inside** the `compose: true` branch, in `composeDispatchRuntime`. A test asserts that
a boot refusing with `no_provider` derives **no** device key and constructs **no** `SessionStore`,
and that a `mounted_secret` boot performs **zero** `identityStore` calls of any kind.

`composeDispatchRuntime` is `async` (Step 6), so the call site awaits it. Composing emits the
**★ WRK-010 ceiling WARN** — ★ **conditional on which body the seam is pointed at.** It is emitted
when the `renew` thunk is the enrolment-code replay, i.e. 2b shipped ahead of Sprint 2.5, and it
names the ten-minute code-route boundary. Once slice 2's device-proof client is the body there is no
ceiling to warn about, and the WARN is **deleted, not left in place saying something false** — a
warning describing a state the code has left is the same defect Step 4 retires
`no_self_model_reader` for. The loop is **not awaited** — a terminal stop does not exit the
process; the daemon stays up serving health, the same "healthy and inert" degradation every other
failure lands in, and what lets an operator see `/healthz` while diagnosing.

**★ Refuses to start when BOTH a composed runtime and an injected leasing seam exist** — two
leasing lifecycles is a double-lease hazard. Reachable only by injection, tested by injection.

`BootstrapDeps.composeDispatch?` is an **observation seam, deliberately, not a behaviour seam**: it
exists so a test can prove the composition was *not* entered, which is the only way "the shipped
binary still refuses" is falsifiable.
*Mutants (7):* delete the `reason === "no_self_model"` guard; delete the second decision;
**await the loop**; delete the WRK-010 warn; delete `drain.start()`; delete the double-lifecycle
refusal; construct the worker identity above the branch instead of inside `composeDispatchRuntime`.

> **★ How the "await the loop" mutant is killed, and why not by timeout.** The first draft killed
> it by letting the suite **time out**. A timeout is indistinguishable from a flake: it produces
> the same red, on the same job, with the same message, and the standing instruction everywhere
> else in this programme is that two identical failures mean *stop re-running and diagnose*. A
> mutation score that depends on a signal we have trained ourselves to ignore is not a score.
> Instead: inject a `run()` returning a promise that **never settles**, then assert
> `bootstrapWorkerDaemon` **resolves** while that promise is still pending (`ok: true`, a live
> `health` handle, `shutdown` callable). The mutant hangs the awaited bootstrap; the assertion
> fails deterministically at the first tick rather than at the suite deadline.

### ★ Step 8 — prove **both** shipped boot roots still refuse
Its own file, because the Wave-4 plan named this **the largest single risk in the wave**: *"composing
the loop therefore turns dispatch on unconditionally, for every daemon running that build, including
both D1 workers, the moment it merges."* 2a showed the risk did not arise because no provider could
be acquired. **2b adds the pieces that were missing, so the question is live again and deserves an
artifact rather than an argument.** The env is **read from `docker-compose.d1.yml`**, so it cannot
drift.

**★ And there are TWO roots.** The first draft of this step proved one of them. §1.1(b): the
container and the desktop stand on a different number of gates, so a suite that exercises only
`bootstrapWorkerDaemon({env, proc})` proves nothing about the root that ships in the installer.

**8a — the container root** (`packages/worker-daemon/src/__tests__/shipped-binary-refuses.test.ts`).
Cases: the REAL production invocation refuses (`composeDispatch` spy at 0 calls); `it.each` over
both D1 workers, refusing with **exactly** `["no_provider"]`; **D1 with the flag FORCED ON still
refuses** (the counterfactual the plan asked for); **D1 + a provider + the flag STILL refuses** —
`no_worker_identity`, because the third gate is `mounted_secret` with no injected stores, exactly
how both D1 workers are configured (`docker-compose.d1.yml:312`, `:348`); **★ POSITIVE CONTROL** —
the SAME spy IS called once every gate is satisfied, without which all four refusal assertions
would pass against an unreachable spy and "provably inert" would be indistinguishable from "never
wired".
*Mutants (3):* move the provider gate below identity; default `composeDispatch` to a no-op;
hardcode `d1WorkerEnv` instead of parsing (add a fixture assertion that the parsed env contains
`AOA_WORKER_KEY_STORE_MODE: "mounted_secret"` — a hardcoded env would be a fixture asserting itself).

**★ 8b — the desktop root**
(`packages/worker-keystore/src/__tests__/desktop-host-refuses-dispatch.test.ts`; §5 explains why it
cannot live beside 8a). `runDesktopHost` already injects its `bootstrap`
(`DesktopHostDeps.bootstrap?`, `bin/desktop-host.ts:81`), so the whole root is drivable without a
process.

Cases:
- **`runDesktopHost` DOES pass both custody stores** — the fact §1.1(b) turns on, asserted rather
  than cited: spy on `deps.bootstrap`, assert `identityStore` and `receiptStore` are both present
  and are the objects built from `resolveVaultRefs`. Without this, every assertion below is about a
  host that may have stopped injecting them.
- **`runDesktopHost`'s shipped default RESOLVES to no provider** — `call.provider === undefined`,
  under an env this test builds explicitly with DEP-010's `AOA_WORKER_SANDBOX_PROVIDER` and
  `AOA_WORKER_E2B_TEMPLATE` **removed**. ★ Revision 2 wrote `"provider" in call === false`; after
  Sprint 2 the key is present with value `undefined` and `in` is `true`, so that assertion goes red
  on arrival (§0.1 item 1). The replacement is deliberately the weaker of the two properties,
  because after Sprint 2 the weaker one is the true one.
- **the composed spy is at 0 calls** for a realistic desktop env (`os_keychain`, no
  `AOA_WORKER_DISPATCH_ENABLED`, no provider switch) driven through the REAL
  `bootstrapWorkerDaemon` with the real stores — refusing with **exactly** `no_provider`.
- **★ THE REFUSAL-TOKEN LADDER — this replaces revision 2's positive control, which was
  unsatisfiable as specified.** **TWO** assertions on the same real `bootstrapWorkerDaemon`, adding
  one variable at a time and pinning the **exact** token each time:
  1. shipped env ⇒ exactly `no_provider`;
  2. **+ a provider + the flag ⇒ exactly `no_event_outbox_path`.** This one carries §1.1(b)'s whole
     point as an executable fact: reaching gate 4 means gate 3 **did not refuse**, i.e. the device
     identity is already there on this root. It is a stronger statement than the old positive
     control and it needs no control plane.
  > **★ Why there is NO rung 3 — revision 3 wrote one that cannot go green.** That rung read
  > *"+ `AOA_WORKER_EVENT_OUTBOX_PATH` ⇒ exactly `no_session`"*. It is unsatisfiable in this suite.
  > Step 4's mapping table (`selfModelRead`) produces `no_session` **only** from a
  > `refused{session_terminal}` read result, and `identity/session.ts:133-138` produces
  > `session_terminal` **only** on an `EnrollmentError` with `stopAndBackoff` — a **401 from a
  > control plane**. With the outbox path added and no control plane, the renewal attempt fails as a
  > **transient/connection error**, which the read maps to `refused{unavailable}` → **`no_self_model`,
  > not `no_session`** (Step 4's table). To pin `no_session` here the keystore suite would need a
  > **fake control plane returning a 401** — gates 5 and 6 need exactly that, and §5 does not budget
  > one for `packages/worker-keystore` (it is why the 8b test cannot live beside the daemon suite,
  > whose `__tests__/support/fake-control-plane.ts` is daemon-side). Rung 2 is the last token this
  > setup can pin **exactly**, so the ladder stops there. Deterministic proof of `no_session` /
  > `no_self_model` is 8a's job, on the side where the fake control plane lives.
- a control command (`status`) and `--reset-identity` each return **without** calling `bootstrap`
  at all (`bin/desktop-host.ts:132-160`, `:164-245`) — the two argv paths that must never fall
  through to a boot.

> **★ Why the old positive control could not have gone green, and why nobody would have noticed
> until implementation.** It read *"inject a provider **and** the flag and the same spy IS
> reached"* — with no *"once every gate is satisfied"* qualifier, unlike its correctly-worded twin
> in 8a. But this slice introduces gate 4 and Step 5 forbids a default, so provider + flag on a
> root whose gate 3 is already satisfied yields `no_event_outbox_path`, and `composeDispatch` is
> never invoked. Adding the outbox path is not enough either: gates 5 and 6 need a live session and
> an admin-set placement profile, i.e. a fake control plane inside `packages/worker-keystore`, which
> §5 does not budget for and which is exactly why the 8b test cannot live beside the daemon suite.
> Non-vacuity of the composed spy is carried by **8a's** positive control, on the side where
> `__tests__/support/fake-control-plane.ts` lives. A ladder that pins exact tokens proves more here
> and costs nothing.

*Mutants (4):* make `runDesktopHost` resolve a real provider by default; delete the `identityStore`
argument from the `bootstrap` call; let the `control` branch fall through to `bootstrap` instead of
returning; **reorder gate 4 ahead of gate 3 in `decideDispatchComposition`** — ladder rung 2 must
fail, because a desktop that reported `no_worker_identity` there would mean gate 3 was a gate on
this root after all, which is the fact §1.1(b) and `E4-F011` turn on.

### Step 9 — the two declaration guards

**9a — the D1 declaration guard.** `scripts/d1-dispatch-expectation.json` declares each D1 worker's
expected dispatch state with a reason. The checker parses `docker-compose.d1.yml` and fails on
**either** divergence direction — declared off but set, **or** declared on but absent. Both matter:
a guard that only caught accidental enabling would let a *deliberate* enable land silently once the
declaration flipped, then quietly regress. This is the plan's *"D1 must enable it in its own compose
file as a separate, attributable change"* made mechanical.

> **★ It must declare ALL FOUR gates, not just the flag** — and revision 2 named the wrong variable
> for one of them. §8's reason 2 ("no provider is injected") is thinner than it reads, and the
> compose file shows why: `AOA_WORKER_PROVIDER_URL: "http://fake-provider:8080"` is **already set on
> both D1 workers** (`docker-compose.d1.yml:304`, `:343`), pointing at a live `fake-provider`
> service, and **nothing in the repository reads that variable** — a full-tree grep still finds
> exactly those two lines and no code. A checker that parses only `AOA_WORKER_DISPATCH_ENABLED`
> would stay green through the event it exists to catch, and that argument stands.
>
> **★ What does NOT stand is treating `AOA_WORKER_PROVIDER_URL` as D1's provider gate.** DEP-010's
> resolver reads `AOA_WORKER_SANDBOX_PROVIDER` + `AOA_WORKER_E2B_TEMPLATE` (its Step 6) and never
> touches `AOA_WORKER_PROVIDER_URL`, so after Sprint 2 that variable is still read by nothing. And
> the D1 image does not run the root DEP-010 modifies at all: `docker/worker/Dockerfile:112` is
> `CMD ["node", "dist/bin/worker-daemon.js"]` — the **container** root — while DEP-010's §5 touches
> only `packages/worker-keystore/src/bin/desktop-host.ts` and explicitly leaves
> `worker-daemon-boundary.mjs` and `compose-dispatch.ts` untouched. **So D1's gate 1 stays
> structural through Sprint 2, and revision 2's headline scenario — "the day DEP-010's composition
> root reads it, D1's gate 1 flips with zero compose diff" — does not happen.** Where the review and
> the code disagreed, the code won: the hazard is real in shape and mis-aimed in target.
>
> The declaration therefore carries a row per gate per worker — `dispatchEnabled`, `provider`,
> `keyStoreMode`, `eventOutboxPath` — each with the expected value and a reason, and the checker
> fails on any divergence in either direction. The `provider` row declares **two** things, because
> one without the other is the mistake above: (a) `AOA_WORKER_PROVIDER_URL` is **present and dead**
> — set on both workers, read by no code, and **not** a gate; and (b) the variables that would
> actually construct one, `AOA_WORKER_SANDBOX_PROVIDER` and `AOA_WORKER_E2B_TEMPLATE`, are
> **absent**, with the reason recording that D1 runs `bin/worker-daemon.js`, which has no resolver
> at all — so the first thing to re-examine is not a compose diff but **the day the container root
> gains a provider path**. Author this row **after** Sprint 2, against DEP-010's shipped constant
> names rather than against this paragraph.

**★ 9b — the boot-roots guard** (`scripts/check-boot-roots-provider-free.mjs`). Step 8b proves the
desktop root's shipped default resolves to no provider *at this commit*; this makes it a standing
property. The checker enumerates the repository's boot roots — the files that obtain
`bootstrapWorkerDaemon`, today `bin/worker-daemon.ts:398` (the only bare call expression) and
`bin/desktop-host.ts`, where it is imported at `:26`, typed at `:81`, aliased at `:101` and invoked
as `await bootstrap({...})` over `:254-260` — and fails if a boot root appears that the declaration
does not name. That second direction is the important one: a third boot root added quietly is
exactly how a three-gate root becomes a zero-gate one, and an enumeration that silently ignores what
it has not seen before is the "empty result set = pass" failure mode this repo has hit five times.
It is declaration-based for the same reason `check-guard-inventory.mjs` is — which runs **both**
directions off a cheap syntactic enumeration (`check-guard-inventory.mjs:36` readdirs `scripts/`;
`lib/guard-inventory.mjs:80-83` default-denies an undeclared script, `:114-116` flags a stale
declaration, `:48-55`/`:90-95` confirm the declared side) rather than inferring anything. The
enumeration 9b needs is equally cheap: a new boot root must **name the identifier** to obtain the
function, so a non-test file mentioning `bootstrapWorkerDaemon` is the easy direction. The declared
range `:254-260` is the argument object itself, so a key added there is directly readable —
the alias is a seam the declaration already points at, not a hole in it.

> **★ THE DECLARED PROPERTY CHANGES AT SPRINT 2, and it must change before this step is written.**
> Revision 2 said the checker "fails if any of them passes a `provider` key". DEP-010 Step 3 adds
> `provider: deps.provider` to `desktop-host.ts:254-260`, so that property is **false on arrival**,
> and this guard lands in the always-on `policy` job (`pr.yml:124-127`) — red on every PR, docs-only
> ones included (§0.1 item 2). The property becomes: **no boot root constructs a provider
> UNCONDITIONALLY, and the shipped default resolves to none.** Concretely, for each declared root
> either (a) it passes no `provider` key at all, or (b) the value it passes is produced by a
> declared resolver whose default is `{kind:"none"}` and which is confined to
> `PROVIDER_HOST_PATH` — DEP-010's own confinement, which its Step 5 makes a boundary-checker
> property. A root that hardcodes a provider, or defaults its resolver to one, fails. **This is
> weaker than what revision 2 promised and §0.1 says so out loud**; do not write a matcher that
> keeps the old wording and passes because it only ever recognised the bare identifier.

Both are registered in `scripts/guard-inventory.json`, invoked from the `policy` job, and entered in
`scripts/test-execution-census.json` alongside the `pr.yml` step that names their `*.test.mjs`
self-tests (§0.1).
*Mutants (7):* 9a — invert each direction (2); return `ok` on an unparseable compose file (an empty
result set must be a broken checker, per the TRACK-001 convention); check only `dispatchEnabled` and
ignore the other three declared gates. 9b — pass on an unreadable source file; accept an
undeclared boot root; **★ accept a root whose resolver defaults to a provider** (the direction the
reformulated property exists for, and the one a matcher written against revision 2's wording would
miss).

### Step 10 — the gate-clause register (**this fails the build if skipped**)
`check-gate-clause-wiring.mjs` treats `unwired_but_now_has_caller` as an **error**
(`lib/gate-clause-wiring.mjs:105-113`), so the moment Step 6 lands, `createPollLoop`,
`createSupervisor` and `createEventOutboxDrain` have production callers and the guard fails. The
register is edited **in the same commit**.

**★ THE PROMOTION DECISION, MADE DELIBERATELY RATHER THAN BY DEFAULT.** Revision 2 promoted `E4-1`,
`E4-2` and `E4-4` to `wired` and parked the caveat in `E4-1`'s `reason`. Read what the guard does
with that field:

- a `wired` entry is validated on **caller count alone** — `if (count === 0) → claimed_wired_but_no_caller`, then `wiredCount += 1` (`lib/gate-clause-wiring.mjs:81-88`). `reason` is **not required** on a `wired` entry, is **never read**, and is **never printed**;
- only the `unwired` branch requires a reason at all (`hasReason(entry.reason)`, `:91`), and even the green run prints just the dormant clause **ids**, not their reasons (`check-gate-clause-wiring.mjs:129-135`).

So "the nuance goes in the reason field, not hidden" was **false as stated**: a caveat on a `wired`
entry is a caveat no code path reads and no run prints. That is the aggregation failure this
register was built to prevent, re-committed one level down. Therefore:

| Clause | Symbol | Disposition |
|---|---|---|
| `E4-2-supervises-sandboxes` | `createSupervisor` | ★ **stays `unwired`, with `expectedReferences: 1`** and a reason. Revision 3 promoted it to `wired` / *"true without qualification"*; the go-book §4 Sprint 3 checklist **explicitly prohibits** that. The clause is *"supervises only sandboxes"*, and production reaches the supervisor **only after an ACK**: `poll-loop.ts:538` self-checks the offer and returns `{kind:"continue"}` before `ackLease` at `:549`, and the supervisor is reached only via `trackHandoff` at `:559` — after a successful ACK. Composing `createSupervisor` gives it one production caller (`lifecycle/dispatch-runtime.ts`) but **no production ACK path exists at this sprint's tip** (that is the composed *poll → offer → ACK → supervise* sequence this slice wires but does not demonstrate). `wired` here asserts a supervising capability that never supervises, into a field the checker never reads. It needs an **actually-supervised sandbox**, which is Sprint 5's journey. `expectedReferences: 1` absorbs the composition's one caller and still fires on a second |
| `E4-4-event-outbox-replay` | `createEventOutboxDrain` | → **`wired`**. The clause is *"replays its encrypted outbox"*; Step 6 recovers at composition and `drain.start()` runs at boot, independently of leasing or ACK. True without qualification |
| `E4-1-leases-through-protocol` | `createPollLoop` | ★ **stays `unwired`, with `expectedReferences: 1`** and a reason. It acquires exactly one production caller (`lifecycle/dispatch-runtime.ts`), which the acknowledged count absorbs, so the guard stays silent about the known reference **and still fires the moment a second appears** — the mechanic `E8-1-sandbox-local-browser` already uses for `runBrowserSession` (`gate-clause-wiring.json:75-81`). ★ **The reason is NOT "E4-F010 unowned/unmatchable"** — WRK-011 (Sprint 2.75) closes E4-F010 before this slice, so the worker IS matchable here (§0.2(B)). The honest reason is that this slice **composes** the loop but does not **demonstrate** a lease actually being taken in its own suite; per the go-book §4 Sprint 3 checklist, `E4-1` is promotable **on evidence** — a composed loop that took a lease in this sprint's suite — never on caller count and never on a caveat in a `reason` field. Composing is not demonstrating; Sprint 5 is the journey |
| `E4-3-survives-restart` | `createStartupReconciler` | stays `unwired`, reason rewritten per §4.2 (ONE blocker: `leaseCandidates`) |

**Why not promote `E4-1` or `E4-2` and rely on the reason.** Because the promote-check is the only
mechanism that keeps a dormant clause visible: `unwired` clauses are printed by name on every green
run, deliberately (`check-gate-clause-wiring.mjs:130-135`), while `wired` ones vanish into a count.
The honest register keeps both clauses in the printed list until a sprint **demonstrates** a lease
taken and a sandbox supervised (Sprint 5), rather than resting on the fact that the loop and
supervisor are *composed*.

**What the reasons must still say**, because the guard's header is explicit that a count > 0 is
*"NECESSARY BUT NOT SUFFICIENT for reachability"*: for `E4-4` (the only clause this slice promotes),
that "reachable" means "reachable from a boot root", **not** "runs by default" — dispatch is still
off by construction.
And — ★ because §1.1(b) makes it materially different per root — that the CONTAINER holds four
**landable** gates and the DESKTOP **three** landable (§2's six/five total, four/three landable
split). A reason field that averaged the two roots into one
number would be the same class of half-truth as the `unwired_but_now_has_caller` error this guard
exists to raise; and revision 2 asked for **two**, which was the wrong number as well as the wrong
place.

### Step 11 — mutation sweep, inventories, result doc
`check-test-inventory.mjs --write` (it must pick up the **keystore-package** test from Step 8b, not
only the daemon ones); the **53** mutants above **plus 2a's 26** must all still die —
4+6+6+8+2+6+7+(3+4)+7 by step, every one of them a mutant that COMPILES and RUNS and is killed by
an ASSERTION rather than by a suite deadline (see Step 2's, Step 6's and Step 7's notes); typecheck
**as the named artifact for §7 row 22**, since `SupervisorDeps.redactionCanaries` being required is
a type-level property and the typecheck is the thing that evaluates it;
`check-worker-daemon-boundary.mjs` (the new daemon files import only `node:os`, `node:fs`,
`node:crypto` and relative modules) and `check-worker-keystore-boundary.mjs` for the keystore side;
`check-worker-path-parity.mjs` — unchanged and now backed by a **live component test** (Step 3's
sixth mutant); the two new guards from Step 9 run in `policy`. **Do not bump
`docker/d1/campaign.env`** — no `server/src` file changes in this slice.

> **★ The mutant total moved from 51 to 53 in revision 3, and the arithmetic is the point.** Step 2
> **substituted** a non-compiling mutant rather than dropping it (`drop now` → `pass Date.now`), so
> its 6 is unchanged. Step 8b gains a fourth (gate 4 ahead of gate 3, which is what makes the new
> refusal-token ladder load-bearing) and Step 9b a seventh (a resolver defaulting to a provider,
> the direction §0.1's reformulated property exists for). Both additions are evaluated by suites
> that exist in this slice. A denominator that changes for a stated reason is a denominator; one
> that changes silently is a score.

**★ Two `policy` guards added to this list in revision 3, both of which this slice would otherwise
turn red on arrival** (§0.1): **`check-execution-census.mjs`** — Step 9's two `*.test.mjs` files
must each have an entry in `scripts/test-execution-census.json`, and the entry's declared `pr.yml`
step must actually name the file; and the **brand-check env-doc guard**, which will **not** fire for
`AOA_WORKER_EVENT_OUTBOX_PATH` (`config.ts` reads through the `ENV` map, `pr.yml:648-663` greps for
`process.env.AOA_…`), so `docs/deploy/environment-variables.md` is a manual step in the Step 5
commit and there is no mechanism behind it. Run `node scripts/check-execution-census.mjs` and
`node scripts/check-guard-inventory.mjs` locally before pushing; both are in the always-on `policy`
job, which has no docs-only skip.

**★ Finding disposition — `E4-F008` AND `E4-F009`, both owned by WRK-008, in the result commit.**
`scripts/finding-ownership.json` names **WRK-008** as owner of both (`E4-F008`: reconcile a rotated
provider-constraint digest against in-flight leases; `E4-F009`: `createStartupReconciler` needs a
durable lease-candidate source). Neither is fixed by this slice — §9.1 keeps `E4-F008` open, §4.2
keeps `E4-F009` open. `finding-ownership.mjs:118` checks only that `ownerStillOpen` is a **non-empty
string** (the `E4-F013` hole), so the moment WRK-008 has a result doc **both keys read as
owned-and-handled while nothing handled them** — silent false ownership. The result commit MUST
therefore, for **each** of `E4-F008` and `E4-F009`, do exactly one of:

- **resolve** it — flip `findings.md` to `resolved` and **delete** the manifest key — only if the
  work is genuinely done (it is not, for either, in this slice); or
- **transfer** it to a **named successor ticket that EXISTS on disk** — re-point the manifest
  `ticket` to that file and record the mechanism (§9.1's for `E4-F008`; §4.2's `leaseCandidates`
  blocker for `E4-F009`) in its register entry.

★ **No such successor ticket exists on disk today** (the tickets/ directory carries WRK-001..011 and
the E4-D12 terrain doc, none of which owns a self-model refresh channel or a durable lease-candidate
source). So this disposition is a **gating action for the result doc**: file the successor
ticket(s) first, then transfer. Leaving either key on a shipped WRK-008 is the exact `E4-F013`
failure and is not an option. `check-finding-ownership.mjs` will not catch it — that is why the step
is spelled out here rather than left to the guard.

Result doc §1 states **which renewal body the seam is pointed at** — slice 2's client (Sprint 2.5),
or, if 2b shipped ahead of it, the code replay together with all five consequences §3.2 lists; §2
states §1.1(c) **including the worker-side self-check**, and that this slice composes WRK-011's
**provisioned** hello (Sprint 2.75) so the self-check ADMITS a valid offer rather than refusing it;
§3 states the desktop root's **three-landable-gate** posture from §1.1(b) and, if Sprint 2 has
landed, that none of the three landable gates is structural any more; §4 states the `E4-F008` **and**
`E4-F009` dispositions from the step above.

---

## 7. Acceptance table — clause → the test that proves it

> **★ WHAT "DONE" MEANS HERE, STATED BEFORE THE TABLE.** With a provider injected **and** the flag
> on, the daemon composes a real poll loop, supervisor, lease-renewal driver and durable event
> outbox — first production callers for `createPollLoop`, `createSupervisor` and
> `createEventOutboxDrain` in the programme's history — and with either absent it is **provably**
> inert. **It does NOT mean "a worker leases, executes and reports."** An earlier version of the
> go-book's Sprint 3 line said that. ★ The reason is **no longer `E4-F010`** — WRK-011 (Sprint 2.75)
> closes it before this slice, so the composed worker is **matchable** and `offerSatisfiesWorker`
> ADMITS a valid offer (§0.2B, rows 8b/12). The reason "done" here still excludes leasing is that
> this slice **composes** the loop, supervisor and driver but does not **demonstrate** a lease taken
> or a sandbox supervised in its own suite: `E4-1` and `E4-2` are promotable **on evidence** (a lease
> actually taken, a sandbox actually supervised — Sprint 5's journey), never on caller count. Rows 12
> and 13 record that as *not claimed* rather than as a caveat, and Step 10 explains why a caveat
> would have been invisible. A design document whose acceptance table over-claims what it composed is
> the aggregation failure the gate-clause register exists to catch, one level down.

| # | Clause | Proving artifact |
|---|---|---|
| 1 | flag stays default-OFF | `dispatch-flag-config.test.ts` (2a) + `compose-dispatch.test.ts` |
| 2 | **the CONTAINER root still refuses** | `shipped-binary-refuses.test.ts` (8a) + the spy at 0 calls |
| 3 | …and the refusal is not vacuous | its **★ POSITIVE CONTROL** |
| 4 | both D1 workers refuse on their real compose env | `it.each(["worker-a","worker-b"])`, env parsed from the compose file |
| 5 | D1 cannot be enabled without an attributable change **on any of the four gates** | `check-d1-dispatch-declared.mjs` (9a) + its self-test |
| 5b | ★ **the DESKTOP root still refuses, and its shipped default resolves to no provider** | `desktop-host-refuses-dispatch.test.ts` (8b) — spy on `deps.bootstrap`, **`call.provider === undefined`** under an explicitly-built env with `AOA_WORKER_SANDBOX_PROVIDER`/`AOA_WORKER_E2B_TEMPLATE` removed (★ **not** `"provider" in call`; §0.1 item 1), composed spy at 0 calls |
| 5c | ★ …and it stays that way | `check-boot-roots-provider-free.mjs` (9b) — declared boot roots, both directions, property = **"no root constructs a provider unconditionally; the shipped default resolves to none"** (§0.1 item 2). ★ Weaker than revision 2's property, and knowingly so |
| 5d | ★ **the desktop's remaining gate count is stated, not implied — THREE landable of five total** | 8b's **two-rung** refusal-token ladder, whose **rung 2** (`provider + flag ⇒ exactly no_event_outbox_path`) is the executable proof that gate 3 is already satisfied on this root, + §1.1(b) + §2's per-root column. ★ There is no rung 3: `no_session` needs a 401 from a control plane the keystore suite does not budget (§8b's note); revision 3's rung 3 was unsatisfiable and is dropped |
| 6 | `no_self_model_reader` retires | `compose-dispatch.test.ts` "the placeholder reason is GONE" |
| 7 | `hasSelfModelReader` becomes real | `dispatch-composition-2b.test.ts` read-attempted + its negative twin |
| 7b | ★ the identity gate leaves **zero residue** on a refusing boot | Step 7's `hasWorkerIdentity` boolean (derived from the enrolment outcome, not a second store read) + "no key derived, no `SessionStore`" on a `no_provider` refusal + zero `identityStore` calls under `mounted_secret` + Step 7 mutant 7 |
| 8 | `client.selfModelRead` acquires its composition-path caller (★ not its FIRST — WRK-011/Sprint 2.75 is) | `self-model-read.component.test.ts` — real socket, real proof, branded result |
| 8b | ★ **the composed `self.report` is the PROVISIONED production hello, and it is MATCHABLE** | Step 2's equality-against-`buildDesktopHello({…, provisioning})` test + Step 6's `offerSatisfiesWorker === TRUE` (provisioned) / `=== false` (unprovisioned negative control) test — ★ replaces revision 3's `=== false`-only assertion, which was the pre-2.75 bare-hello fact (§0.2B) |
| 9 | the proof is signed over the served path | same suite + parity guard + Step 3 mutant 6 |
| 10 | a tampered profile fails closed | same suite |
| 11 | a failed read leaves the daemon healthy and inert (2a Q3) | `dispatch-composition-2b.test.ts` |
| 11b | ★ a dead session is reported as `no_session`, never as "ask an admin" | Step 4's precedence test + the `/admin/i` assertion + Step 4 mutant 8 |
| 12 | **E4 clause 1** — leases through the protocol | ★ **NOT CLAIMED.** `dispatch-runtime.test.ts` proves `createPollLoop` is composed and reachable; `E4-1` stays **`unwired` with `expectedReferences: 1`** (Step 10). ★ The reason is **NOT** "E4-F010 / unmatchable" — WRK-011 (Sprint 2.75) closes E4-F010 first, so the composed worker IS matchable (row 8b). The clause says *leases*, and this slice **composes** the loop but does not **demonstrate** a lease being taken in its own suite; per the go-book §4 Sprint 3 checklist, `E4-1` is promotable **on evidence** (a lease actually taken here), never on caller count or a caveat in a `reason` field — Sprint 5 is the journey |
| 13 | **E4 clause 2** — supervises only sandboxes | `dispatch-runtime.test.ts`: `createSupervisor` is composed with the injected provider and NO `observeRun`, and the loop's handoffs reach it through the driver (Step 6 mutant 1). ★ `E4-2` stays **`unwired` with `expectedReferences: 1`** (Step 10): the supervisor is reached only after an ACK (`poll-loop.ts:549`/`:559`), and no production ACK path exists at this sprint's tip — composing is not supervising. NOT promoted |
| 14 | **E4 clause 4** — replays its encrypted outbox | durable-before-drainable + recovered-at-composition + `E4-4: wired` — true without qualification |
| 14c | ★ **a caveat is not parked where nothing reads it** | Step 10's disposition table. `evaluateGateClauseWiring` validates a `wired` entry on caller count alone (`lib/gate-clause-wiring.mjs:81-88`); `reason` is unrequired, unread and unprinted there, and only `unwired` clauses are named on a green run (`check-gate-clause-wiring.mjs:130-135`) |
| 14b | ★ the renewal driver's denial events reach the SAME durable store | Step 6's `proxyFor` round-trip test + Step 6 mutant 5 |
| 15 | **E4 clause 3** — survives restart | **DEFERRED**, §4.2; stays `unwired`; ONE blocker (`leaseCandidates`); finding filed |
| 16 | the renewal driver decorates, not replaces | Step 6 mutant 1 |
| 17 | capacity clamped to the server-owned ceiling | `dispatch-runtime.test.ts` |
| 18 | shutdown stops leasing before draining | stop-order test |
| 19 | WRK-010's ceiling surfaced at boot | the WARN test. ★ Applies **only** where the seam is pointed at the code replay, i.e. 2b shipped ahead of Sprint 2.5. With slice 2's client wired there is no ten-minute ceiling and the WARN is deleted, not silenced |
| 20 | ★ **CORRECTED (`E4-F012`)** — WRK-010's renewal **body** is injected, never constructed here | `worker-identity.test.ts` — the thunk is injected and handed straight to `SessionStoreDeps.renew` (`identity/session.ts:52-55`), and the suite runs over two different bodies with identical non-renew behaviour. ★ The retired clause read *"the integration surface is one thunk … swapping the body changes nothing else"*. **False:** WRK-010 §9.1.1 changes `renew` to take `(current: WorkerSession)` and adds a **required** first-session dependency, so the injected type moves and a root supplying only a renewal body will not compile. 2b composes on top of a lifecycle 2.5 builds; it does not build one |
| 20b | ★ the renewal code is read lazily and never logged | `worker-identity.test.ts` — `readCode` spy at 0 calls at construction, 1 on first `get()`, and the credential's single hop into a `code` key happens **inline in the `enroller.renew({...})` argument** and nowhere else (§4 property 2 — ★ the "keep the `enrollmentCode` name all the way to `RenewInput`" wording is retracted; the type forbids it). PRE-2.5 only |
| 20c | ★ **the near-expiry gap is recorded, not composed over** | §3.2's note — `ensureFresh` (`identity/session.ts:103-107`) refreshes only when absent-or-expired and says so in its own docblock; this slice composes `SessionStore` unchanged, and Sprint 2.5 owns the threshold. No artifact here **on purpose**: an assertion that today's store lacks a threshold would be a test of the absence of slice 2 |
| 20d | ★ **the FIRST-session gap is recorded too** (`E4-F012`) | §3.2 + §4's retraction. `enrollOnce` drops the enrolment session (`enroll-once.ts:310`) and this slice composes `initial = null`, so with a device-proof body the first `ensureFresh()` has no bearer to present (`worker-session-auth.ts:125-126`). **Owned by WRK-010 slice 2 and DECIDED there** (§9.1.1: a session sink on `enrollOnce`, a `renew(current)` signature, a required bootstrap dependency). No artifact here, for the same reason as 20c — and the proof is real-database by construction, so a fake session injected in this slice's unit tier could not carry it |
| 21 | every new guard mutation-checked | **53** mutants, all compiling, all executed, none killed by timeout; recorded in the result doc with the 51 → 53 arithmetic (Step 11) |
| 22 | `redactionCanaries: []` is a decision | the **typecheck** (Step 11) — a required field is a type-level property; the first draft cited a non-compiling "mutant", see Step 6's note |
| 22b | ★ …and it is safe for the stated reason | Step 6's `observeRun === undefined` assertion |
| 23 | the E4-D01 boundary holds | `check-worker-daemon-boundary.mjs` (the **manifest** half — it requires exactly `worker-protocol` + `pino`) + `check-worker-keystore-boundary.mjs`. ★ Its **source** half skips `*.test.ts` (`:118`), so the 8b placement rests on the manifest and on module resolution, not on the import scan — §5's withdrawn citation |
| 24 | ★ **Sprint 2's published surface is repaired, not left broken** | `public-surface-dispatch.test.ts` updated for the retired/renamed fields + DEP-010's Step 8 `no_self_model_reader` case removed (§0.1, §5) |
| 25 | ★ **the always-on `policy` job is green for the files this slice ADDS** | `check-execution-census.mjs` with both new `*.test.mjs` entered in `scripts/test-execution-census.json` and named by a real `pr.yml` step + `check-guard-inventory.mjs` for the two new guards (Step 11) |

---

## ★ 8. THE D1 QUESTION, ANSWERED DIRECTLY

> *"Composing the loop changes what the D1 lane observes. What does D1 see, and does anything need
> re-baselining?"*

**D1 sees nothing change, and nothing needs re-baselining.** Five independent reasons, each verified,
each with an artifact:

1. **`AOA_WORKER_DISPATCH_ENABLED` is absent from `docker-compose.d1.yml`** (`worker-a` `:296-313`,
   `worker-b` `:338-349`) → strict parse → `false`. *Artifact:* Step 9a's declaration guard.
2. **No provider is injected, and `no_provider` refuses first.** *Artifact:* Step 8a row 2.
   **★ This reason is thinner than it reads — see the second caveat below.**
3. **Both D1 workers have no device identity** — `AOA_WORKER_KEY_STORE_MODE: "mounted_secret"`
   (`:312`, `:348`) with no injected stores, so the enrolment block (`bin/worker-daemon.ts:267`) is
   never entered. *Artifact:* Step 8a's last case — provider **and** flag both forced on, and it
   **still** refuses. ★ This is the reason that **does not** transfer to the desktop root (§1.1b).
4. **They never enrolled**, so there is no baseline of daemon-originated traffic to shift.
   `tests/d1/e6f-03-networked-smoke.test.mjs:8-9` says it outright: *"There is NO live worker-daemon
   loop — the harness plays the worker with HTTP calls + real proofs."* That stays true.
5. **Even a fully unlocked D1 worker would be offered nothing, and would reject an offer if it
   were** (§1.1c — both the server-side snapshot gap and `poll-loop.ts:538`).

**★ SCOPE, stated because the first draft of this section did not.** Every reason above is about the
**containerised** boot root. Reason 3 is false for `aoa-worker-desktop`, which injects both custody
stores on every boot (§1.1b). "D1 is safe" and "the shipped software is safe" are different claims;
this section makes the first, and §2's per-root column makes the second honestly.

**What WOULD change D1's observations:** enabling dispatch there requires **four** simultaneous
changes — the flag, a provider-bearing composition root in the worker image (DEP-010), OS-custody
stores + a real enrolment (`mounted_secret` → `os_keychain`), and an outbox path on the existing
`d1-worker-*-state:/worker` volume. Not a diff anyone lands accidentally, and Step 9a makes **all
four** reviewable and attributable.

### The honest caveats

**(i) The provider gate can flip with no compose diff at all — but NOT via the variable revision 2
named.** `AOA_WORKER_PROVIDER_URL: "http://fake-provider:8080"` is **already set on both D1
workers** (`:304`, `:343`) and points at a live `fake-provider` service that D1 depends on for
health. **No code reads that variable** — a full-tree grep still finds those two lines and nothing
else. Revision 2 concluded: *"the day DEP-010's composition root reads it, D1's gate 1 flips with a
diff to `packages/` and none to `docker-compose.d1.yml`."*

**★ That specific scenario does not happen, and the correction matters more than the sentence.**
DEP-010's resolver reads `AOA_WORKER_SANDBOX_PROVIDER` + `AOA_WORKER_E2B_TEMPLATE`, never
`AOA_WORKER_PROVIDER_URL`; and DEP-010 lands the resolver in
`packages/worker-keystore/src/bin/desktop-host.ts`, whereas the D1 image runs the **container**
root — `docker/worker/Dockerfile:112` is `CMD ["node", "dist/bin/worker-daemon.js"]`, and DEP-010's
§5 leaves `bin/worker-daemon.ts` untouched. **So D1's gate 1 remains structural through Sprint 2.**

The class of hazard survives intact, re-aimed: a gate can move because a *variable D1 already sets
becomes read*, or because the *container root gains a provider path* — and in both cases
`docker-compose.d1.yml` is byte-identical, so a checker that parses only
`AOA_WORKER_DISPATCH_ENABLED` stays green straight through it. That is why Step 9a's declaration
covers all four gates rather than the flag alone, and why its `provider` row must record **both**
that `AOA_WORKER_PROVIDER_URL` is present-and-dead **and** that the variables which would actually
construct one are absent. Write that row against DEP-010's shipped constant names, after Sprint 2.

**(ii) If a live daemon ever enrolled on D1, the collision is at ENROLMENT, not at offer-matching.**
The first framing was "a live daemon and the harness would compete for the same offers". The
mechanism is sharper and worse than competition. `findWorkerForBinding` scopes by
`(scope, organizationId, ownerUserId, executionTargetId)` — **per target, not per worker id**
(`server/src/services/worker-enrollment.ts:410-415`) — and then:

- if a worker is already bound to that target and its id differs from the incoming hello's, the
  enrolment is refused outright as `worker_transfer_denied` (`:418-423`) — and
  `findWorkerForBinding` carries no status predicate, so that refusal is permanent;
- if the target is unbound, `insertWorker` takes the binding and writes
  `profileSnapshot: request.hello` (`:459-474`, snapshot at `:470`); a rotation writes it at `:444`.

So a daemon minting a fresh `randomWorkerId()` (`enroll-once.ts:221`) against a target the harness
already holds is **denied**, and against a target the harness has not yet claimed it **takes the
binding and installs the unmatchable desktop hello as that target's `profile_snapshot`** — after
which the harness's own enrolment is denied. Either way the failure is a red at enrol, not a flaky
offer count.

This does not arise today for a further, independent reason: neither D1 worker mounts anything at
`/enrollment-code`, so `readEnrollmentInput` could not produce a code even if gate 3 were open. The
suites are also insulated in practice — E6F-03 seeds fresh per-run ids (`newScenarioIds()`,
`e6f-03-networked-smoke.test.mjs:67`) rather than reusing the compose targets. Recorded so that the
day DEP-010/D1 decides to run a live daemon there, the cost is a known one rather than a surprising
red, and so that nobody re-derives "they just compete for offers" from the earlier framing.

---

## 9. Findings — ALREADY FILED, not filed by this slice

| Id | Severity | Statement |
|---|---|---|
| `E4-F009` | MED | **`createStartupReconciler` is not composable at boot — for ONE reason.** `leaseCandidates` (`supervisor/startup-reconcile.ts:256-257`) has no durable local source: the outbox persists events, not offers, so the lease-authority probe would run over `[]` every boot. `ownershipSelector.organizationId` is **NOT** a blocker — it is on the self-model this slice reads and the frozen schema guarantees it non-null for org- and owner-scoped targets (`worker-protocol/src/capabilities.ts:307-321`); wiring is conditional on scope, not impossible. E4 clause 3 waits on a durable lease-candidate source. |
| `E4-F010` | HIGH | **A composed worker cannot be offered work — and would refuse it if it were. ★ NOW OWNED AND CLOSED by WRK-011 (Sprint 2.75), which runs BEFORE this slice.** *Server side:* `workers.profile_snapshot`'s only writers are `worker-enrollment.ts:444,470` — one enrolment-rotation channel a daemon can never re-travel (WRK-011 §0(c)). *Worker side:* `poll-loop.ts:538` runs `offerSatisfiesWorker` over the worker's OWN `self.report`, and the shipped hello emits an **empty `reportedCapabilities`** — `[...capabilitiesForIsolation(input.isolation ?? "none")]` at `enrollment/desktop-hello.ts:144` with `CAPABILITIES_BY_MECHANISM.none = []` (`isolation-capabilities.ts:50`), and a 64-zero `policyHash` (`:154`). ★ **Not `sandbox.*`** — that is the `docker`/`os_native` output, never the shipped `none`; WRK-011 §0(a) makes the same correction, and the conclusion is *stronger* (`ceiling ∩ reported` is empty for any ceiling). So the self-check returns `false` for **100% of offers**. WRK-011 closes both halves plus a third capacity blocker it names (§0(d)): it resolves the finding in `findings.md` and DELETES the `E4-F010` manifest key in its own result commit. **This slice composes WRK-011's PROVISIONED hello** (§0.2(B), Step 0) — the state this row describes is the tree BEFORE Sprint 2.75. MIG-005/006/007 ACTIVE inherit this until WRK-011 ships. |
| `E4-F011` | HIGH | **The desktop boot root is THREE LANDABLE gates from live dispatch (of five total; custody is already satisfied), not four.** `worker-keystore/src/bin/desktop-host.ts:114-125` builds both OS-custody stores and `:254-260` passes them on every boot; `resolveCustody` (`identity/device-identity-store.ts:128-133`) makes `mounted_secret` + stores a fatal refusal, so **any desktop host that boots is running `os_keychain` with custody present** and `bin/worker-daemon.ts:267` is entered. `no_provider`, the flag and `no_event_outbox_path` remain. DEP-010 must not land a provider in that root without an explicit decision about the flag's default on desktops. **Owner: DEP-010.** ★ **The `E4-F011` entry in `findings.md` now states the INVARIANT** (one of the container's four landable gates is already satisfied on the desktop) rather than a bare count — this slice and §1.1(b)/§2 use the same six-gate model (four landable + two runtime). §5 lists no register edit here; status, key and owner do not move |

**★ These three were filed into `docs/replatform/epics/E4-worker-daemon/findings.md` at planning
time, not deferred to execution**, with entries in `scripts/finding-ownership.json`. They are facts
about the tree as it stands today, and this programme's own worst failure mode is a HIGH that was
noticed, written into a design document, and never reached a register where anything could fail
because of it. E4-F009 and E4-F011 are `owned` (WRK-008 and DEP-010). ★ **E4-F010 is now `owned` —
by WRK-011** (`scripts/finding-ownership.json` key `E4-F010` reads `owned`/`WRK-011`; revision 3 of
this document said `unowned`, and `check-finding-ownership.mjs` now prints only `E4-F013`). It is
**still `open`**, because WRK-011 has a design doc and no result doc — nothing has shipped, so a
provisioned/matchable worker does not exist at THIS document's tip. But WRK-011 is **Sprint 2.75**,
which runs before this slice, so by the time 2b executes E4-F010 is resolved and its manifest key
deleted (WRK-011 §7 Step 9). **This slice therefore neither owns nor closes E4-F010** — it composes
on top of the matchable worker WRK-011 delivers (§0.2(B), Step 0). Do not touch its status or key
here; do not reason from "unowned" (the pre-Sprint-2.75 record); and do not force-fit it onto 2b.

### ★ 9.1 `E4-F008` — owned by WRK-008, and revision 2 of this document never mentioned it

`scripts/finding-ownership.json` names **WRK-008** as the owner of `E4-F008`, with the reason
*"A rotated provider-constraint digest going stale on a long-lived worker must be reconciled against
in-flight leases when 2b composes the loop"* and the `ownerStillOpen` note *"Slice 2b — composing
the poll loop and supervisor — is the live-dispatch wiring seam this finding names."* The register
therefore expects an answer from **this ticket**, and §9's table gave three findings and not this
one. A finding whose owning ticket ships without disposing of it does not fail any guard — it just
rots in place, which is the failure mode the register exists to end.

**Disposition: `E4-F008` SURVIVES this slice, and here is the mechanism rather than a shrug.**
`assembleWorkerSelfModel` produces a `WorkerSelfModel` **once**, from one authenticated read
(`identity/self-model.ts:45-67`), and `PollLoopDeps.self` is a plain value, not a getter
(`poll/poll-loop.ts:440`, consumed at `:533` and `:538`). Step 6 clamps capacity to
`selfModel.verifiedProviderConstraints.resourceCeiling` at composition time. **Nothing in this
composition ever re-reads the self-model**, so a provider-constraint rotation after boot cannot be
observed, and in-flight leases cannot be reconciled against it. Composing the loop is exactly the
seam the finding named, and the seam now exists — but the reconciliation does not.

**Two things keep it LOW rather than promoting it.** First, the direction of failure is closed:
`workerSatisfiesRequirements` compares the worker's verified constraints against **both** the
target's registered ref and the job's requested ref (`worker-protocol/src/capabilities.ts:466-467`),
so a stale digest makes the worker **unmatchable**, not wrongly matched — the robust reason, which
does not depend on any other ticket. ★ Second, historically: while `E4-F010` was open the worker was
unmatchable anyway, so there was no in-flight-lease window at all. WRK-011 (Sprint 2.75) closes
`E4-F010`, so that second reason lapses once a provisioned worker can lease — but the first reason
(direction closed) keeps `E4-F008` LOW regardless, which is why the recommendation to re-point it at
a self-model-refresh ticket stands rather than resolving it here.

**What closes it, and it is not this ticket:** a self-model refresh channel (a periodic or
poll-triggered re-read) plus a stated policy for leases in flight when the digest changes —
finish the run under the old constraints, or fence it. Both are design decisions with a blast
radius, and neither is a line in a composition ticket. **Recommendation: re-point `E4-F008` at the
ticket that adds the refresh channel, and record the mechanism above in its register entry so the
next reader does not have to re-derive it.** Leaving it on WRK-008 through 2b's result doc would be
the false claim of ownership `check-finding-ownership.mjs` exists to prevent — and because
`finding-ownership.mjs:118` checks only that `ownerStillOpen` is a **non-empty string** (the
`E4-F013` hole), the moment WRK-008 has a result doc this key would read as owned-and-handled while
nothing handled it. **The result-doc step that forces the disposition is Step 11's new
finding-disposition item** (below), which covers `E4-F008` and `E4-F009` together.

---

## ★ 10. Rollback — turning dispatch back off in one step

**Unset `AOA_WORKER_DISPATCH_ENABLED`** (or set `0`). `decideDispatchComposition` returns
`dispatch_disabled`, no runtime is composed, no loop runs, no outbox is opened, and the shutdown step
list degrades to exactly the pre-2b `[health-server]`. One restart. No rebuild, no redeploy, no data
unwind.

| Depth | Action | Effect | Cost |
|---|---|---|---|
| **1** | unset the flag, restart | identical to a 2a-era boot | one restart |
| 1b | ★ unset `AOA_WORKER_EVENT_OUTBOX_PATH`, restart | `no_event_outbox_path`, and no outbox file is opened | one restart |
| 2 | the composition root stops passing `provider` | `no_provider` regardless of env | a host redeploy. ★ **After Sprint 2 this is depth 1 on the desktop, not depth 2** — unsetting `AOA_WORKER_SANDBOX_PROVIDER` reaches the same state with one restart, because gate 1 stopped being structural there (§0.1) |
| 3 | revert the commit | tree returns to 2a; `E4-4` back to `unwired`; `E4-1`'s and `E4-2`'s `expectedReferences` back to `0`; `E4-3` unchanged | a build |

**Why the flag is a genuine rollback rather than a partial one.** Composition is the *last* thing boot
does before signal registration, and everything it builds is constructed **inside**
`composeDispatchRuntime` and reachable only through the returned handle. Nothing is constructed above
the branch and nothing is registered outside it, so `compose:false` leaves **zero residue**. The one
durable artefact, the SQLite outbox file, is only *opened* inside the branch; a rolled-back daemon does
not touch it and a re-enabled one recovers it rather than discarding it.

> **★ "Zero residue" is a claim Step 7 has to EARN, and the first draft of this document would have
> made it false.** `decideDispatchComposition` is pure over VALUES. Had the identity gate taken a
> `workerIdentity: WorkerIdentity | null`, the record load, the PKCS8 re-derivation and the
> `SessionStore` would all have been built **above** the branch on every boot — including boots that
> immediately refuse with `no_provider`. A refusing daemon would be reading its device key off the
> custody store for nothing, and §10 would be describing a shape the code did not have. Step 7
> passes `hasWorkerIdentity: boolean` instead — mirroring 2a's own `hasSelfModelReader`
> (`lifecycle/compose-dispatch.ts:46`) — and constructs inside the branch, with a test asserting
> zero `identityStore.load()` calls past the presence probe on a refusing boot. The claim above is
> true because of that choice, not in spite of it.

> **★ AND THAT CHOICE COLLIDES WITH `E4-F012`'s SINK — recorded here because §10 is where it bites,
> and because it is not answered by WRK-010 §9.1.1's one-line version of the wiring.** Verified
> ordering in the shipped boot root: enrolment runs at `bin/worker-daemon.ts:267` (gated on
> `keyStoreMode === "os_keychain"` **and** both stores; the call is `:274-284`), and
> `decideDispatchComposition` runs at `:337` — **strictly after**. Zero residue requires the
> `SessionStore` to be constructed *inside* the dispatch branch, i.e. later still. So *"production
> wires `onSessionMinted` to the store's `set()`"* is **not directly executable at the only
> production `enrollOnce` call site**: at the moment the sink would fire, no store exists. Three
> ways out, each with a cost, and **Sprint 2.5 must pick one in writing** rather than discover it
> at the keyboard:
>
> * **(a) construct the identity/store before enrolment** — reintroduces exactly the residue this
>   box was written to prevent: a boot that refuses with `no_provider` derives a device key and
>   builds a store for nothing;
> * **(b) a boot-scope one-shot cell** the sink writes and the composition later passes as
>   `initial` — no early store, but a live bearer token then sits in a boot-scope variable on
>   **every** `os_keychain` boot, including ones that refuse. That is new residue of a
>   security-relevant kind, and the cell would need the store's own non-loggable shape (private
>   field, nothing that serializes);
> * **(c) compute the dispatch decision BEFORE enrolment** — it is pure over config values — and
>   pass `onSessionMinted` **only** when the daemon will compose, so a refusing boot has no sink by
>   construction. Cost: a reordering of `bootstrapWorkerDaemon`, in the file Step 7 already edits.
>
> Two facts bound the problem and belong next to it: on `mounted_secret` custody — **every shipped
> compose file** — the enrolment block at `:267` never runs, so the sink is structurally absent
> there; and a steady-state boot returns `skipped` at `enroll-once.ts:194-204` **before** the
> network call, so nothing is minted to sink. On both of those paths the **bootstrap dependency**,
> not the sink, is the only first-session source (WRK-010 §9.1.1, cost item 6).

**What rollback does NOT undo:** an event batch already ACKed by the control plane. That is correct —
those events are the record of work that actually ran.

---

## 11. Out of scope, stated

- **The composition root (DEP-010).** 2b ships the seam. ★ It also ships `E4-F011`: DEP-010 owns the
  decision about what the flag defaults to on a desktop root that has only ever had **three** gates
  — and that, after DEP-010, has three **environment variables** and no structural gate at all
  (§0.1).
- **Session renewal — WRK-010 SLICE 2, i.e. Sprint 2.5, which is a HARD dependency of §4 and not an
  out-of-scope item.** What is out of scope is the *session lifecycle itself*: 2b creates and tests
  the injection point and **composes on top of** a lifecycle slice 2 builds. Slice 2 supplies the
  device-proof renewal client, the near-expiry threshold in `SessionStore.ensureFresh`, and — ★
  added by `E4-F012`, decided in WRK-010 §9.1.1 — **first-session acquisition**: a session sink on
  `enrollOnce`, a `renew(current: WorkerSession)` signature, and a required bootstrap dependency.
  The last of those changes the type this slice injects into, so *"2b builds the seam, 2.5 swaps the
  body"* is retired wording (§3.2, Step 2, §7 clause 20). ★ If 2b ships first, it inherits §4's admission that the composed
  daemon re-reads an enrolment code at arbitrary later times, keeps the ten-minute ceiling, and
  leaves WRK-010's route with zero production callers. **2b does not resolve `E4-F007` under any
  ordering.**
- **`E4-F008` — reconciling a rotated provider-constraint digest against in-flight leases.** §9.1.
  The register names WRK-008 as owner; the seam it waited for now exists and the reconciliation does
  not, so the finding stays open and should be re-pointed at the ticket that adds a self-model
  refresh channel.
- **The startup reconciler** — §4.2, ONE named structural blocker (the second was withdrawn on a
  re-read of the frozen schema).
- **A matchable worker hello / a `profile_snapshot` update channel** — ★ **owned and delivered by
  WRK-011 (Sprint 2.75), not out of scope for the programme; only for THIS slice's authorship.**
  WRK-011 ships the `self/hello` refresh route, the provisioned builder and `hello-provisioning.ts`,
  and closes `E4-F010`. This slice **consumes** them (§0.2B, Step 0): it composes the **provisioned**
  (matchable) hello WRK-011 makes possible and wires `selfHelloRefresh` into boot. It does not author
  the refresh route or the provisioning fold.
- **DAT-008 slice 5.** Between 2b and slice 5 a composed daemon starts a CLI with **no credential**
  and the run fails auth. Both the distributed flag and the rollout dial are default-off, so there is
  no production exposure — but the intermediate state is real, and the result doc says so rather than
  leaving it implied.
- **The per-run canary registry** — `redactionCanaries` stays `[]` and stays typed out.
