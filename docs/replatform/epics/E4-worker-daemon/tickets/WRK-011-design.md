# WRK-011 — Design: a provisioned worker can be OFFERED work and can ACCEPT it

**Ticket node:** to be added to `docs/replatform/program-design.md` under `### E4 — Worker daemon`
(`#### WRK-011`). **This document does not write it** — the graph node, the ownership manifest and
the go-book are wired by a separate step (§7 Step 9 states what that step must contain).
**OWNS — and is scoped to close — finding:** `E4-F010`
(`docs/replatform/epics/E4-worker-daemon/findings.md`, section *"E4-F010 — A composed worker cannot
be OFFERED work — and would refuse it if it were"*, **`open`**, HIGH).
**Depends on:** WRK-010 slice 1 (Sprint 1 — the `SESSION_MAX_MS` export and the mint pattern),
WRK-010 slice 2 (Sprint 2.5 — the daemon `SessionStore` this route's response must land in),
WRK-008 slice 1 (the self-model read this ticket's provisioning facts come from).
**Size:** L · **server + daemon, in one ticket** — §2 argues why splitting them ships a route that
breaks its caller.
**Sprint:** recommended **new Sprint 2.75**, between Sprint 2.5 and Sprint 3. The argument is §13,
and it is an argument, not a preference note.
**Epic ownership: E4.** Both halves live in E4 files; the server route is E4's because its only
consumer is E4's daemon, the same reasoning go-book §8 **D-2** applied to WRK-010.

---

## ★ 0. Verified state at tip, before designing around it

Every claim below was read at tip (`d8f489315`) in the file cited. **Where E4-F010 and the code
disagree, the code wins and it is said so.** Three corrections follow, then four facts the finding
does not carry at all — one of which changes the shape of the fix.

### (a) CORRECTION — the production hello emits NO capabilities, not `sandbox.*`

E4-F010 says *"the only production hello builder emits `sandbox.*` capabilities"*. The builder
**can**; production **does not**. `buildDesktopHello` writes
`reportedCapabilities: [...capabilitiesForIsolation(input.isolation ?? "none")]`
(`packages/worker-daemon/src/enrollment/desktop-hello.ts:144`), and `CAPABILITIES_BY_MECHANISM.none`
is `[]` (`enrollment/isolation-capabilities.ts:50`). The **only** production call site
(`enrollment/enroll-once.ts:255-261`) passes **no `isolation` argument**, and
`detectIsolationMechanism` (`isolation-capabilities.ts:86`) has **zero production callers** — the
only references outside its own module are `src/index.ts:243` (a re-export) and
`__tests__/isolation-capabilities.test.ts`. So the shipped hello's `reportedCapabilities` is the
empty array.

The finding's *conclusion* is unaffected and in fact stronger: `effective = ceiling ∩ reported`
(`packages/worker-protocol/src/capabilities.ts:483`) is empty for **any** server ceiling, so
`effective.has("workload.batch")` at `:486` is false. Recording the correction anyway, because a
reader who greps for `sandbox.` in the shipped hello finds nothing and concludes the finding is
stale. It is not; the sentence is.

### (b) CORRECTION — the self-check is false for 100% of offers, but **zero offers reach it today**

E4-F010's worker half is exactly right about the code: `poll-loop.ts:538` is
`if (!offerSatisfiesWorker(deps.self, capacity, offer))`, and `offerSatisfiesWorker`
(`poll/capacity.ts:143-157`) substitutes only `capacity` into `self.report` at `:150` before
handing it to the frozen matcher. But **count the callers before believing the quantifier**:

| Symbol | Production callers | Evidence |
|---|---|---|
| `createPollLoop` | **0** | only `src/index.ts:303` (re-export) and eight `__tests__/poll-*.ts` files |
| `assembleWorkerSelfModel` | **0** | only `src/index.ts` and `__tests__/self-model-assembly.test.ts` |
| `decideDispatchComposition` | 1 | `bin/worker-daemon.ts:337`, called with `hasSelfModelReader: false` and `selfModel: null` hard-coded at `:344-345` |

`decideDispatchComposition` therefore returns `{compose:false, reason:"no_provider"}` or
`"no_self_model_reader"` on every boot (`lifecycle/compose-dispatch.ts:62-65`), and no poll loop is
ever constructed. **"False for 100% of offers" is true of the code and vacuous in production —
there are no offers.** It is a correct *prediction* about the daemon Sprint 3 composes, not a
description of a live failure. Stated here because this ticket's acceptance must not claim to have
fixed a live symptom that nothing was exhibiting.

### (c) CORRECTION — `workers.profile_snapshot` HAS an update channel; it is just unreachable twice

E4-F010 says the column *"has no update channel"*. At the service layer its statement of the
writers is right — `server/src/services/worker-enrollment.ts:444` (rotate) and `:470` (insert).
At the repository layer those are two **different** operations:
`packages/db/src/repositories/tenant/worker-enrollment.ts:309` `insertWorker` and `:313`
`rotateWorker`, the latter writing `profileSnapshot: input.profileSnapshot` at `:319` **as an
`UPDATE`** alongside `profileHash`, `deviceGeneration`, `enrolledAt`, `revokedAt: null` and
`status`.

So the accurate statement is: **the only update channel is enrolment rotation, and a daemon can
never travel it a second time.** Two independent reasons, both code-proven:

1. **A second enrolment on the same code is refused.** After the first consume, `stored.consumedAt`
   is set and the replay branch demands
   `stored.semanticIdempotencyKey !== request.idempotencyKey → malformed`
   (`services/worker-enrollment.ts:325-327`). The daemon derives its key from
   `(workerId, targetId, deviceGeneration)` (`enrollment/enroll-once.ts:262-266`,
   `deriveEnrollmentIdempotencyKey`), and a rotation **advances the generation**
   (`services/worker-enrollment.ts:427-436`), so the next call presents a different key and takes a
   terminal 400 on a code that can never be re-consumed.
2. **The daemon never asks.** On the steady-state boot — identity and receipt both on disk —
   `enrollOnce` returns at `enrollment/enroll-once.ts:193-202` with `skipped: true`, **before** the
   ticket is read and before any network call. Its own comment: *"(2b) Steady state. No ticket read,
   no network — ever again."*

A fresh code is an operator action. **The fix therefore cannot be "reach the existing channel"; it
has to be a new one.** That is a materially different design space from the one "no update channel"
suggests, which is why the correction is here and not in a footnote.

### ★ (d) NOT IN THE FINDING — a THIRD blocker, on the server, that fires BEFORE either half

The enrolled snapshot's `capacity` is all zeros (`desktop-hello.ts:146-153`). On the live lease path
that is not cosmetic:

```
job-leasing.ts:566   const effectiveCapacity = minCapacity(parsedStoredHello.data.capacity,
                                                           parsedRequest.capacity);
job-leasing.ts:575   const admissibleWorkloadTypes = deriveAdmissibleWorkloadTypes(effectiveCapacity, …)
job-leasing.ts:483-486   if (capacity.batchSlots > live.batch) workloadTypes.push("batch");  // 0 > 0 is false
job-control.ts:1810-1812 if (input.admissibleWorkloadTypes.length === 0)
                            return { candidates: [], certificateMetrics: emptyMetrics };
```

`minCapacity` is `Math.min` field by field (`job-leasing.ts:175-184`), so the **stored** capacity is
a hard ceiling on whatever the worker polls with. Zero stored slots ⇒ zero effective slots ⇒ an
empty workload list ⇒ `lockEligibleLeaseCandidates` **early-returns zero candidates**. The static
matcher at `job-leasing.ts:723-728` — the one E4-F010's server half is about — is never reached,
because the loop it feeds has nothing to iterate. `deriveAdmissibleWorkloadTypes` also returns `[]`
outright when `capacity.freeCpuMillis < demand.resources.cpuMillis` (`:480`), which zeros satisfy
against any job demanding any CPU.

**★ And two documents in the tree assert the opposite.** `desktop-hello.ts:28` — *"The all-zero
capacity is kept for byte-stability, not for safety"* — and `:145` — *"NOT a safety property — the
matcher overwrites it"* — and the test that pins the belief,
`__tests__/desktop-hello.test.ts` (*"does NOT rely on capacity for unmatchability"*, whose comment
reads *"the matcher overwrites this, so the assertion above is documentation, NOT the guarantee"*).

All three are **true of `evaluateStaticLeaseEligibility`**, which substitutes
`NEUTRAL_LEASE_MATCHER_CAPACITY` — three slots of 1 — at `job-lease-eligibility.ts:213`, with the
constant at `:20-27`. They are **false of the poll path**, where the stored capacity is a clamp and
not a discard. Code wins: capacity is a third, independent, and *earlier* blocker. A WRK-011 that
refreshed only capabilities and `policyHash` would ship, go green on every matcher test, and offer
exactly as much work as today: none.

### ★ (e) NOT IN THE FINDING — `profile_hash` and `profile_snapshot` are cryptographically bound

`server/src/services/job-placement.ts:542-543`:

```ts
if (!SHA256.test(candidate.workerProfileHash) ||
    createHash("sha256").update(JSON.stringify(worker)).digest("hex") !== candidate.workerProfileHash) return false;
```

with the docblock above it at `:538-541` — *"The proof-bound enrolled snapshot is immutable. A
caller may supply current capacity only by replacing worker.capacity after session auth; every other
member must still hash to the stored profile."* The same intent is written into the schema:
`packages/db/src/schema/workers.ts:36-38` — *"the exact proof-bound E1 hello whose digest is
profile_hash. Dynamic poll capacity may only replace the capacity member after session proof; it
cannot widen these enrolled capabilities or policy facts."*

Consequence: **writing one column without the other makes the worker permanently unplaceable**, at a
line no test in this ticket's obvious blast radius touches. The two columns move together or not at
all.

The hash is over `JSON.stringify` of the **zod-parsed** hello — `sha256(JSON.stringify(request.hello))`
at `services/worker-enrollment.ts:409`, where `request` came from
`enrollmentRequestV1Schema.parse` (`:89`), and the re-derivation at `job-placement.ts:543` runs over
`workerHelloV1Schema.safeParse(snapshot.worker.profileSnapshot)` output
(`job-placement-transaction.ts:53`). Both sides are zod output, so key order agrees. **Hashing a raw
parsed body instead would produce a value that never matches again.** §8 M11 is that mutant.

### ★ (f) NOT IN THE FINDING — changing `profile_hash` KILLS every live session

`profileHash` is a session claim, and three separate authorities compare it to the row:

| Site | Comparison | Effect |
|---|---|---|
| `server/src/middleware/worker-session-auth.ts:167` | `current.worker.profileHash !== claims.profileHash` | `fail()` → `unauthorized` on **every** device-session operation |
| `server/src/services/job-leasing.ts:259` | `worker.profileHash === auth.profileHash` inside `authorityCurrent` | poll → `target_revoked` |
| `server/src/services/job-leasing.ts:297` | same, in `ackAuthorityCurrent` | ACK → refused |

So a refresh that writes a new hash and returns nothing locks the worker out **immediately and with
no recovery**: there is no renewal route until WRK-010 slice 1, no first-session path until slice 2
(`E4-F012`; `enroll-once.ts:310` — *"`result.session` is dropped here and never returned (I13)"*),
and the enrolment code is dead ten minutes after issue (`services/worker-enrollment.ts:22`
`CODE_TTL_MS`). **This single fact determines the whole architecture** (§3.2) and the sprint
placement (§13).

### (g) The admin-owned ceiling this design leans on already exists and is already served

- `PUT /organizations/:orgId/execution-targets/:targetId/placement-profile` — `assertOrgAdmin`,
  `server/src/routes/execution-targets.ts:288-315`.
- `PUT /operator/execution-targets/:targetId/placement-profile` — `assertCanManageInstanceSettings`,
  `:318-341`.
- `POST /execution-targets/self/placement-profile` — the worker reads its own ceiling under session
  auth, `:379-447`, backed by `loadWorkerSelfModel` (`services/execution-targets.ts:604-638`) and
  the pure `admitSelfModelRead` (`services/worker-self-model-admission.ts:80`). Client side:
  `SELF_MODEL_READ_PATH` (`packages/worker-daemon/src/transport/client.ts:73`) and
  `selfModelRead` (`:313-321`). **Zero production callers** on the daemon side today — Sprint 2.5/3
  give it one.

The registered profile it serves carries `capabilityCeiling` and `policyHash`
(`packages/worker-protocol/src/capabilities.ts` — `registeredTargetProfileV1Schema`). Those are the
two facts a worker needs in order to build a hello that can match, and it can already fetch them.

---

## 1. The facts this ticket exists to change

| Fact | Evidence |
|---|---|
| The stored snapshot reports no capabilities | `desktop-hello.ts:144` + `isolation-capabilities.ts:50`; only production call site `enroll-once.ts:255-261` passes no isolation |
| …so `ceiling ∩ reported` is empty and no `workload.*` is effective | `capabilities.ts:483`, `:486` |
| The stored snapshot carries a 64-zero policy hash no ratified profile carries | `desktop-hello.ts:53`, `:154`; matcher `capabilities.ts:475` |
| The stored snapshot's zero capacity empties the workload list | `job-leasing.ts:566`, `:175-184`, `:483-486` |
| …and an empty workload list returns zero candidates before any matching | `job-control.ts:1810-1812` |
| The snapshot is only writable through enrolment | `services/worker-enrollment.ts:444`, `:470` → repo `insertWorker` `:309` / `rotateWorker` `:313` |
| …and a daemon can never re-enter enrolment | `enroll-once.ts:193-202` (steady state short-circuits) + `services/worker-enrollment.ts:325-327` (replay demands the same idempotency key) |
| The worker's own self-check re-runs the same frozen matcher against the same unmatchable hello | `poll-loop.ts:538` → `capacity.ts:143-157` |

**Net:** a desktop that enrols perfectly, and whose admin has ratified a perfectly good placement
profile, is invisible to the scheduler on three independent axes and would refuse an offer on a
fourth. Not an edge case — **the steady state of every worker the programme can currently produce.**

---

## 2. The fix, in one sentence

**A worker that already holds a live session and can still sign with its enrolled device key may
present a REFRESHED hello, and — if that hello stays inside the ceiling an administrator ratified —
the server replaces `profile_snapshot` and `profile_hash` together and hands back a new session
bound to the new hash, in one transaction.** The daemon builds that refreshed hello from facts it
reads over the self-model route it already has, and does it once per boot before it starts polling.

### 2.1 Why this is ONE ticket and not two

The obvious split — "server route now, daemon caller later", the shape WRK-010 uses — is wrong here,
and §0(f) is why. WRK-010 slice 1 could ship a route with no callers because a route nobody calls is
**inert**. This route is not inert on success: it changes `profile_hash`, and by
`worker-session-auth.ts:167` / `job-leasing.ts:259` / `:297` that invalidates the caller's session.
A worker that calls it and discards the response is **worse off than before it called**. So the
first caller and the response handling are part of the same deliverable, and the honest unit of
rollback is both halves together (§12).

### 2.2 Rejected alternatives, with the reason each fails

**Rejected — let the SERVER author the snapshot at ratification time.** When an admin ratifies a
placement profile, rewrite every enrolled worker's `profile_snapshot` to something matchable.
Fails on three counts: it destroys the "proof-bound enrolled snapshot" property that
`job-placement.ts:538-541` and `workers.ts:36-38` both state in prose; the server does not know the
device's real capacity or isolation and would have to invent them; and fabricating a claim on a
device's behalf is strictly worse than letting the device make it under a ceiling.

**Rejected — carry `reportedCapabilities`/`policyHash` on the poll request.** This is the tidy one,
and it is a frozen-protocol edit. `pollRequestV1Schema` (`packages/worker-protocol/src/transport.ts:225-236`)
is `.strict()` and carries `capacity` and nothing else of the hello. Adding fields to it edits
`packages/worker-protocol`, which is FROZEN. **Rejected on that ground alone** — recorded here so
the freeze is refused explicitly rather than routed around silently. See §2.3.

**Rejected — re-enrol (rotate) to refresh.** `rotateWorker` really is an update channel (§0c), but
reaching it needs a fresh operator-issued enrolment code: the same-code replay is refused at
`services/worker-enrollment.ts:325-327` once the generation advances, and the code dies at ten
minutes (`:22`). "Ask the operator to re-paste a code every time a policy changes" is the human step
E4-F007 and WRK-010 exist to remove.

**Rejected — clamp instead of refuse.** Accept any hello and intersect it down to the ceiling. The
matcher would do that anyway (`capabilities.ts:483`), so the placement outcome is identical — but
the durable snapshot would then record a claim the device never earned, and the snapshot is the
audit record of what the device asserted under its own key. Refuse (§4.2 G4), and keep the
intersection as belt-and-braces.

### 2.3 ★ THE FREEZE QUESTION, answered — this is NOT a STOP, and here is the argument

`packages/worker-protocol` is FROZEN: consume it, never edit it. This ticket **consumes** it:

- `workerHelloV1Schema` is imported and used as a field of a **server-local** envelope schema. That
  is the established pattern, twice over: WRK-008 slice 1's `selfModelReadBody`
  (`server/src/routes/execution-targets.ts`, `validate(selfModelReadBody)` at `:382`) and WRK-010
  slice 1's `sessionRenewRequestSchema` (`WRK-010-design.md` §3.1). Neither edited the frozen
  package.
- The route is **not** an eleventh frozen worker-control operation. E4-D02 keeps the ten closed, and
  the self-model read already established the "LOCAL op with a local descriptor" shape — its own
  header says so in as many words (`packages/worker-daemon/src/transport/client.ts:60-72`). WRK-011
  mounts beside it, not under `/api/worker-control/`.
- `KNOWN_WORKER_CAPABILITIES` already contains `workload.batch`, `workload.browser_session` and
  `workload.service` (`capabilities.ts:47-59`). Nothing new needs to enter the vocabulary.

**What WOULD be a STOP, stated so it is recognisable if review pushes there.** If an adversarial
review rejects the local-op route and requires the refresh to be an eleventh **frozen** operation —
a new audience literal, a new request/response pair in `transport.ts`, a new entry in
`OPERATION_DESCRIPTORS` — then this ticket **halts and the freeze decision goes to the go-book §8
ledger before any code is written.** Do not "just add one field". The same STOP applies to the
rejected poll-request option in §2.2: if a reviewer prefers it, that preference is a protocol
change and must be argued as one.

---

## 3. Architecture

```
POST /api/execution-targets/self/hello
  ├─ global express.json({verify: captureRawBody})      (app.ts:385 — rawBody for the proof)
  ├─ requireWorkerHeartbeatAuthority(db, workerSession)  (execution-targets.ts:66-117)
  │     → legacy worker token SHORT-CIRCUITS at :85-92 and never reaches the authenticator
  │     → otherwise createWorkerSessionAuthenticator().authenticate()  ◄── 9 guards, shipped
  ├─ authority.kind !== "session"  → deny()             ◄── MUST be present; see §5.1 layer 0
  ├─ selfHelloRequestSchema.safeParse (server-local; composes the FROZEN workerHelloV1Schema)
  ├─ loadWorkerSelfModel(db, principal.targetId)        (services/execution-targets.ts:604)
  ├─ admitHelloRefresh(facts)   ◄── PURE. identity · ceiling subset · policy equality · idempotency
  └─ runInTenant(… ) ONE transaction:
         UPDATE workers SET profile_snapshot = <hello>, profile_hash = <sha256(zod(hello))>
         createWorkerSessionToken(… profileHash: <new hash> …)     ← throws ⇒ the UPDATE rolls back
         → 200 { protocolVersion:1, profileHash, serverTime } + the session on the response header
```

### 3.1 Files

| Action | Path |
|---|---|
| create | `server/src/services/worker-hello-refresh-admission.ts` — the pure decision |
| create | `server/src/services/worker-hello-refresh.ts` — local schema + descriptor + the transaction + the mint |
| create | `server/src/__tests__/worker-hello-refresh-admission.test.ts` — the unit matrix |
| create | `server/src/__tests__/worker-hello-refresh.integration.test.ts` — embedded PostgreSQL; **carries the "an offer is actually produced" clause** |
| create | `packages/worker-daemon/src/enrollment/hello-provisioning.ts` — derive the provisioning facts from a self-model response |
| create | `packages/worker-daemon/src/__tests__/hello-provisioning.test.ts` |
| create | `tests/fixtures/worker-provisioned-target.json` — ONE ratified profile pair, read by **both** suites (§9) |
| modify | `server/src/routes/execution-targets.ts` — one route inside the existing `if (opts.workerSession)` region |
| modify | `packages/db/src/repositories/tenant/worker-enrollment.ts` — one repo method, `refreshWorkerProfile`, writing **both** columns |
| modify | `packages/worker-daemon/src/enrollment/desktop-hello.ts` — an **optional** `provisioning` input (§6.1) |
| modify | `packages/worker-daemon/src/transport/client.ts` — `SELF_HELLO_PATH`, descriptor, `selfHelloRefresh()` |
| modify | `scripts/check-worker-path-parity.mjs` — one `PAIRS` entry (`:26-35`) |
| modify | `server/src/__tests__/desktop-disabled.negative.test.ts` — one source-scan clause for the new route |
| modify | `scripts/test-inventory.json` — bump `packages/worker-daemon`; it is **`pinned` at 131** (`:47-50`) and does not self-heal. `server` is `floor` at 1467 (`:63-66`) and needs no bump |
| modify | `docs/replatform/epics/E4-worker-daemon/findings.md` — E4-F010 → `resolved` **in the result commit only** (§7 Step 9) |

**No migration. No new column. No new table. No frozen-contract change.**

### 3.2 ★ The atomic triple — snapshot, hash and session move together or not at all

This is the load-bearing decision, and §0(e) and §0(f) are jointly why:

- write `profile_snapshot` alone → `job-placement.ts:543` re-derives the digest, it no longer equals
  `profile_hash`, and the worker is **permanently unplaceable**;
- write `profile_hash` alone → the same line fails from the other side, identically;
- write both, return no session → `worker-session-auth.ts:167` refuses the worker's very next
  request, and it has no route back (§0f);
- write both, mint a session **after** the transaction commits → a mint failure leaves a committed
  refresh with no live credential, i.e. exactly the previous bullet, on a rarer path.

So: **the mint happens INSIDE the transaction, before commit.** `createWorkerSessionToken` throws a
`WorkerSessionError` on a ceiling violation (`worker-session-auth.ts:80`), and inside the
transaction that throw rolls the `UPDATE` back. §7 Step 5 tests exactly that ordering by injecting a
throwing signer and asserting the row is unchanged.

The session's TTL is `SESSION_MAX_MS` (`worker-session-auth.ts:15`), which **WRK-010 slice 1
exports** — one of the two reasons this ticket sequences after Sprint 1 (§13). Every other claim in
the minted token is copied from the authenticated principal, never re-derived: `scope` is
`principal.scope`, already proven equal to the row at `worker-session-auth.ts:165`; `generation` is
`principal.targetGeneration`; `deviceThumbprint` is `principal.deviceThumbprint`. **Only
`profileHash` changes.** A second derivation of any of the others would be a second authority
surface — the failure WRK-010 §0(c) caught in its own draft.

### 3.3 Dormancy here is WEAKER than under `/worker-control/`, and that is stated, not hidden

`workerControlRoutes` mounts inside `if (opts.distributedExecutionEnabled)` (`server/src/app.ts:483`,
mount `:496-505`) and its body parsers are gated on the same flag (`:361-378`), so flag-off the path
does not exist and does not even buffer.

`executionTargetRoutes` is **outside** that block — `app.ts:588` — with `workerSession` computed as
`opts.distributedExecutionEnabled && opts.tenantAppDb && opts.operatorDb && opts.workerSessionSigningKey ? {…} : undefined`
(`:590-597`). The app.ts comment at `:507-509` names this exact asymmetry: *"Contrast F27, where
executionTargetRoutes sits outside this block and needed an explicit desktop refusal instead."*

So the new route's dormancy rests on **one conditional registration**, `if (opts.workerSession)
router.post(...)` — the same guard the self-model read uses at `execution-targets.ts:379`. That is
weaker than a structural non-mount, and the honest mitigation is to prove it by **source scan** in
`desktop-disabled.negative.test.ts` (the house pattern, §7 Step 6) rather than by asking express
about a router we chose not to register. Risk R6 records what remains.

### 3.4 The route carries no identifier — deliberately

`POST /api/execution-targets/self/hello`. No worker id, target id or org id, in path **or** body.
Identity comes entirely from the authenticated principal, exactly as
`/execution-targets/self/placement-profile` does and for the stated reason
(`execution-targets.ts:391-397`): cross-tenant reach is answered **by construction**, not by a check
that can drift from the middleware.

The body carries the hello, and the hello's own `workerId`/`targetId`/`deviceGeneration` fields are
**not** an identity source — they are a **claim to be checked against the principal and refused on
mismatch** (§4.2 G1). The distinction matters: an implementation that read them would have two
identity sources; one that refuses on disagreement has one, plus a consistency check.

**The path is frozen the moment it ships.** The device proof signs the **normalized** path —
`normalizedPath(input.path)` is line 3 of the canonical input at
`server/src/services/worker-device-proof.ts:44-53`, with the normalizer at `:30-38` — so a later
rename is not a 404; it is a signature that can never verify on a request that reached the right
handler. `check-worker-path-parity.mjs:12-15` states the same consequence in the same words. `req.originalUrl` is passed, as every other
worker-authenticated route does, so `/api` is part of the signed contract. `PAIRS`
(`scripts/check-worker-path-parity.mjs:26-35`) gains the second entry in its history.

### 3.5 What the shipped authenticator already proves

Identical to WRK-010 §3.4, which maps all ten authority guards onto
`createWorkerSessionAuthenticator` (`server/src/middleware/worker-session-auth.ts:109-207`) row by
row. **This ticket does not restate that map and does not re-implement a single one of those
guards.** What matters here is what the authenticator does **not** decide, which is §4.

One guard is worth naming because this route depends on it directly: the authenticator refuses when
`current.worker.profileHash !== claims.profileHash` (`:167`). So a worker presenting a session minted
against the OLD snapshot can refresh **once**; a second refresh with a stale session is refused by
shipped middleware before this ticket's code runs. That is the replay bound, and it is free.

---

## 4. The pure admission function

### 4.1 What is left to decide

After §3.5 the caller is a proven, live, non-revoked worker on a non-disabled target at the current
generation, bound to the enrolled device key. `admitHelloRefresh` decides four things the
authenticator does not know about, and produces one:

1. Is the presented hello **about this worker** (§4.2 G1)?
2. Are the presented capabilities **within the admin-ratified ceiling** (G2)?
3. Does the presented `policyHash` **equal the ratified policy** (G3)?
4. Is this refresh a **no-op** (G4 — the idempotency short-circuit)?

It **produces** the canonical digest to write, computed over the zod-parsed hello, so the route
never has a second opinion about what the hash is.

It is a pure function in its own file for the reason `compose-dispatch.ts:3-7` gives for its own:
each refusal has a different operator remedy (fix the daemon; ask an admin to widen the ceiling;
sync the policy), and deciding them inline makes them unreachable from a test without an HTTP
harness.

### 4.2 The four guards

**G1 — identity.** `hello.workerId !== principal.workerId || hello.targetId !== principal.targetId ||
hello.deviceGeneration !== principal.targetGeneration` → `identity_mismatch`.
The generation arm is not decoration: the matcher compares
`worker.deviceGeneration !== profile.deviceGeneration` (`capabilities.ts:460`) and placement compares
`worker.deviceGeneration !== registry.targetGeneration` (`job-placement.ts:533`). A snapshot written
at the wrong generation is unplaceable in exactly the way this ticket exists to end.

**G2 — capability ceiling, as a SUBSET and not an intersection.**
`hello.reportedCapabilities ⊄ registeredProfile.capabilityCeiling` → `capability_not_granted`.
Refuse, do not clamp (§2.2). Two properties this buys that the matcher's intersection does not:
the durable snapshot records only claims the device was entitled to make, and the refusal names
which capability was ungranted for the operator log (§5.3).

**G3 — policy coherence.** `hello.policyHash !== registeredProfile.policyHash` → `policy_stale`.
The matcher demands `String(worker.policyHash) !== String(profile.policyHash) → false`
(`capabilities.ts:475`), so a snapshot that fails this can never match anything. Refusing here turns
a silent permanent non-match into a named, retryable refusal a daemon can act on by re-reading its
self-model.

**★ G3 is an ANTI-STALENESS check, not an authorisation check, and saying otherwise would be
false.** The worker learns `policyHash` from the self-model route it is entitled to read
(`execution-targets.ts:379-447`), so it can always satisfy G3 by echoing what it was just told. Its
value is that a worker which has *not* synced cannot accidentally overwrite a good snapshot with a
stale one. It is not a secret and it authorises nothing. §5 is where the authorisation actually
lives.

**G4 — idempotency.** If the computed digest equals the row's current `profile_hash`, admit with
`{ changed: false }`: **write nothing, mint nothing, answer 204.** Without this, every boot of every
worker rewrites the row and mints a session, and a fleet restart becomes a session-churn storm
against a table under FORCE RLS. With it, the steady state costs one authenticated read.

### 4.3 Source, abridged to the load-bearing lines

```ts
export type HelloRefusalReason =
  | "identity_mismatch" | "capability_not_granted" | "policy_stale" | "profile_unratified";

export type HelloRefreshDecision =
  | { admit: true; changed: false }
  | { admit: true; changed: true; profileHash: string }
  | { admit: false; reason: HelloRefusalReason };

export function admitHelloRefresh(input: {
  principal: { workerId: string; targetId: string; targetGeneration: number };
  hello: WorkerHelloV1;                 // ALREADY zod-parsed by the caller
  ratified: { capabilityCeiling: readonly string[]; policyHash: string } | null;
  currentProfileHash: string | null;
  digestOf: (hello: WorkerHelloV1) => string;   // injected; production = sha256(JSON.stringify(h))
}): HelloRefreshDecision {
  if (!input.ratified) return { admit: false, reason: "profile_unratified" };
  const h = input.hello;
  if (String(h.workerId) !== input.principal.workerId ||
      String(h.targetId) !== input.principal.targetId ||
      h.deviceGeneration !== input.principal.targetGeneration) {
    return { admit: false, reason: "identity_mismatch" };
  }
  const ceiling = new Set(input.ratified.capabilityCeiling.map(String));
  for (const cap of h.reportedCapabilities) {
    if (!ceiling.has(String(cap))) return { admit: false, reason: "capability_not_granted" };
  }
  if (String(h.policyHash) !== String(input.ratified.policyHash)) {
    return { admit: false, reason: "policy_stale" };
  }
  const profileHash = input.digestOf(h);
  if (profileHash === input.currentProfileHash) return { admit: true, changed: false };
  return { admit: true, changed: true, profileHash };
}
```

`digestOf` is injected so the unit matrix can drive G4 both ways without computing sha256 in the
test, and so the production wiring — the single place `JSON.stringify` meets the zod-parsed hello —
has exactly one call site to mutate (§8 M11).

---

## 5. The security surface: what stops a worker widening its own placement eligibility

### 5.1 Four layers, each with a line behind it

**Layer 0 — a legacy token may not do this at all.** `requireWorkerHeartbeatAuthority` resolves a
legacy rotatable worker token **first** and short-circuits before the session authenticator ever
runs (`server/src/routes/execution-targets.ts:85-92`). That credential carries **no device proof**.
The self-model read refuses it explicitly at `:406-409`, and this route must do the same, in the
same place, for a stronger reason: reading a ceiling is disclosure; rewriting a snapshot is a
durable authority write. §8 M1 is that mutant, and it is the highest-severity one in the table.

**Layer 1 — the ceiling is administrator-owned, and no worker route writes it.** `capabilityCeiling`
and `policyHash` live in `executionTargets.registeredProfile`, written only by the two ratification
routes in §0(g), behind `assertOrgAdmin` and `assertCanManageInstanceSettings`. Nothing on the
worker surface writes that column. This ticket adds no route that does.

**Layer 2 — refuse, don't clamp (G2/G3).** A hello outside the ceiling is rejected rather than
narrowed, so the durable snapshot never records an ungranted claim.

**Layer 3 — the frozen matcher intersects anyway.** Even if layers 0-2 all failed, the placement
decision computes `effective = capabilityCeiling ∩ reportedCapabilities`
(`capabilities.ts:481-483`) and requires the workload capability to be in the intersection at `:486`.
The frozen module's own header states the invariant: *"a worker CANNOT advertise its way into a
higher trust / provider / credential / locality / capability class… the worker report can only ever
narrow, never widen"* (`capabilities.ts:28-34`). This ticket **does not weaken that**, and it is the
reason the residual in §5.2 is bounded by the ceiling rather than unbounded.

**On capacity specifically — over-claiming is self-harming, not widening.**
`deriveAdmissibleWorkloadTypes` returns `[]` when `capacity.freeCpuMillis > provider.resourceCeiling.cpuMillis`
(`job-leasing.ts:477-479`), and the live poll capacity is still `Math.min`'d against the stored value
at `:566`. A worker that inflates its nameplate reduces its own eligibility or leaves it unchanged;
it cannot raise what the poll advertises above what the poll advertises.

### 5.2 ★ OPEN QUESTION — the residual, who it affects, and who decides

**The residual, stated plainly.** Within the ratified ceiling, this route lets an *already-enrolled*
device flip itself from unmatchable to matchable **with no further operator action**, the moment an
admin ratifies a profile carrying a `workload.*` capability. An admin ratifying a profile for a
future, better-isolated device thereby enables **every** device already enrolled on that target.

That is the same hazard shape `E4-F011` names for DEP-010 — *"the day a provider lands in it, every
installed desktop running the build is one environment variable from taking real leases"* — at a
different seam. It is not created by this ticket; this ticket makes it **reachable**, which is worse
in exactly the way that matters.

**The options, none free:**

| Option | Cost | Effect |
|---|---|---|
| (a) accept it; the TARGET is the unit of admin intent | an audit log line | admin ratification means "devices on this target may take this work" |
| (b) per-worker activation flag | new column + admin route + UI + migration + a new refusal reason | admin approves each device once |
| (c) refreshed capabilities ⊆ ENROLLED capabilities | none | **self-defeating** — the enrolled set is `[]` (§0a), so nothing could ever be added |

**Recommendation: (a), with a structured audit record** (`action: "worker.hello.refreshed"`, worker
id, target id, old hash, new hash, the capability delta) at the same log site style as
`execution_target.placement_profile.ratified` (`execution-targets.ts:305-310`). The argument for (a):
the device is the thing that would execute the job either way, the ceiling is per-target, and a
target is already the granularity at which an admin expresses placement intent.

**This is a product decision, not an implementation detail, and it is NOT mine to take.**
**Decider: the go-book §8 decisions ledger, at Sprint 2.75 planning** — the same authority that took
D-2 and D-3. **If (b) is chosen, this design changes materially**: the admission function gains a
fifth guard, the schema gains a column, and the size goes from L to XL. Take the decision **before**
Step 1, not during Step 7.

### 5.3 Refusals are coarse on the wire, specific in the log

All four refusals answer the same `unauthorized` protocol code, via the same
`sendWorkerProtocolError` helper the self-model route uses, for the reason its comment gives at
`execution-targets.ts:391-397`: a differentiated response turns the route into an oracle for target
existence and configuration state. The **reason** goes to the structured log, where an operator can
read it and a caller cannot. `profile_unratified` is retryable (an admin has not configured the
target yet); the other three are not, and the daemon must not retry them in a loop — §6.3.

---

## 6. The worker half

### 6.1 `buildDesktopHello` gains provisioning — and DSK-001's guarantee survives BY DEFAULT

```ts
export interface HelloProvisioning {
  readonly reportedCapabilities: readonly WorkerCapability[];
  readonly policyHash: string;
  readonly capacity: WorkerCapacity;   // NAMEPLATE, not free-at-this-instant
}

export function buildDesktopHello(input: { …existing…; provisioning?: HelloProvisioning }): WorkerHelloV1
```

**Absent ⇒ byte-identical to today.** Empty capabilities from
`capabilitiesForIsolation(input.isolation ?? "none")`, `UNPROVISIONED_POLICY_HASH`, all-zero
capacity. Every existing assertion in `__tests__/desktop-hello.test.ts` — *"reports NO
capabilities"*, *"carries a policy hash no provisioned target profile would match"*, *"is
byte-stable for identical inputs"* — stays green **unmodified**, and §9 makes "they stayed green" an
acceptance clause rather than an assumption. That is the DSK-001/I12 guarantee: an unprovisioned
desktop still cannot be matched work.

Three constraints the new parameter must not break, all from the existing docblocks
(`desktop-hello.ts:82-86` — *"Deliberately takes NO clock, NO random, and NO `process`"* — and
`:43-45`, on why even the runtime label is a constant) and `isolation-capabilities.ts:18-25`:

1. **No clock, no random, no `process`.** Provisioning is passed in, exactly as `isolation` is, for
   the stated replay reason: `enroll-once` replays the same hello byte-for-byte on retry, and any
   per-call variation converts a replay into a new submission.
2. **Stable ordering.** `reportedCapabilities` must be emitted in a deterministic order or the digest
   moves between two calls that should agree. Sort against `KNOWN_WORKER_CAPABILITIES` order.
3. **`capacity` is a nameplate.** It is `Math.min`'d against the live poll capacity at
   `job-leasing.ts:566`, so it is a declared maximum, not a reservation and not a measurement. §10
   records that a capacity *reservation* model is not this ticket.

### 6.2 Where the provisioning facts come from

`hello-provisioning.ts` folds a self-model read response into a `HelloProvisioning`:

- `reportedCapabilities` = `registeredProfile.capabilityCeiling ∩ (what this device can actually
  provide)`. Today the second set is `workload.*` for the workloads the daemon can supervise, plus
  `capabilitiesForIsolation(mechanism)` — and the mechanism is `"none"` until DSK-003 lands the
  per-OS probes (`isolation-capabilities.ts:33-37` says DSK-003 owns them; §10 carries it as a
  non-goal). **The intersection is deliberate and is the daemon's own D4 fail-toward-absent rule**:
  a device never reports a capability merely because the ceiling permits it.
- `policyHash` = `registeredProfile.policyHash`, verbatim. G3 then compares it to itself, which is
  the point (§4.2): the check catches a worker that did **not** re-read.
- `capacity` = the nameplate from `measureCapacity` (`poll/capacity.ts:90-101`) with an empty
  reservation set and the provider ceiling applied — the same clamp the poll uses, so the stored
  ceiling can never sit below what the poll would legitimately advertise.

The self-model read already exists on both sides (§0g). This ticket gives `client.selfModelRead`
(`packages/worker-daemon/src/transport/client.ts:313-321`) **its first production caller** — worth
saying out loud, since a re-export and a test suite are what it has today.

### 6.3 What this ticket does NOT make work, said before §9 says it

The refreshed hello is what a *composed* poll loop would self-check against. **No poll loop is
composed until Sprint 3** (§0b: `createPollLoop` has zero production callers,
`bin/worker-daemon.ts:344-345` hard-codes the refusal). So after WRK-011:

- the **server** will produce an offer for a provisioned worker — provable today, and §9 proves it
  against the real `poll` service, not against the matcher in isolation;
- the **daemon's self-check** will admit that offer — provable today as a unit, against an offer
  captured from the server suite (§9's shared fixture);
- the **composed** sequence *poll → offer → self-check → ACK → supervise* remains Sprint 3's to
  compose and Sprint 5's to demonstrate on real E2B.

E4-F010's own statement of the defect — *a worker can enrol correctly, assemble a valid self-model,
self-check correctly, and dispatch nothing, forever* — is **false** after this ships, on both of its
halves and on the third one it does not name. That is what "closes the finding" means here, and it
is not the same claim as "a distributed worker executes real work", which is Sprint 5's.

---

## 7. Implementation — fail-first RED/GREEN steps, one action each

Every step: write the failing test → **run it and watch it fail for the stated reason** → minimal
implementation → run it and watch it pass → commit. *A step whose RED does not fail for the reason
written down proved nothing; stop and find out why.*

```bash
pnpm --filter @armyofagents/server test:run -- src/__tests__/worker-hello-refresh-admission.test.ts
# ★ THE ENV PREFIX IS NOT OPTIONAL — see the note below.
AOA_RUN_WIN_INTEGRATION=1 \
  pnpm --filter @armyofagents/server test:run -- src/__tests__/worker-hello-refresh.integration.test.ts
pnpm --filter @armyofagents/server test:run -- src/__tests__/desktop-disabled.negative.test.ts
pnpm --filter @armyofagents/worker-daemon test:run
pnpm --filter @armyofagents/server typecheck && pnpm --filter @armyofagents/server build
node scripts/check-worker-path-parity.mjs
node scripts/check-guard-inventory.mjs && node scripts/check-test-inventory.mjs
node scripts/check-finding-ownership.mjs
```

**★ Without `AOA_RUN_WIN_INTEGRATION=1` the integration RED cannot be observed on this worktree's
platform.** The embedded-PostgreSQL harness is wrapped in
`describe.skipIf(process.platform === "win32" && process.env.AOA_RUN_WIN_INTEGRATION !== "1")`, and
vitest renders a skipped file as **green**. §9 records that **five of the nine acceptance clauses
have that suite as their only evidence**. In PowerShell the prefix is
`$env:AOA_RUN_WIN_INTEGRATION = "1"` on its own line.

**★ `packages/worker-daemon` is `pinned` at 131 in `scripts/test-inventory.json:47-50`.** Adding
daemon tests without bumping it reds `check-test-inventory.mjs`. `server` is `floor` at `:63-66` and
needs nothing.

### ★ Step 0 — RED: the POSITIVE CONTROL, first

The suite **opens** with a positive control, and the reason goes in the file:

> E1-F008 found five placement guards whose own named tests still PASSED with the guard deleted:
> every fixture was refusing earlier for an unrelated reason, and each test asserted a bare
> `toBe(false)` and got it from the wrong refusal. **A refusal suite with no positive control cannot
> tell "correctly refused" from "never got there".**

Two rules, enforced by construction: **(1)** the shared `input()` fixture is asserted to **ADMIT
with `changed: true` and a specific `profileHash`** before any refusal case is built on it;
**(2)** every refusal case asserts its **specific reason**, never a bare `admit: false`.

Cases: a provisioned org-scope worker admits; the same input with a matching `currentProfileHash`
admits with `changed: false`.
**GREEN:** create the module returning `{ admit: true, changed: true, profileHash: input.digestOf(input.hello) }`.
**Commit:** `WRK-011: pure hello-refresh admission skeleton with a positive control`.

### Step 1 — the four guards

G1 three arms, each with the other two fields **correct** (an arm whose fixture also breaks another
arm passes for the wrong reason and lets §8's mutant survive); G2 with one ungranted capability among
several granted ones; G3 with a hash differing in one nibble; G4 both directions.
**Anti-vacuity:** a hello whose capabilities are a **strict subset** of the ceiling must ADMIT — a
G2 written as equality instead of subset would pass every refusal case and break every real worker
(§8 M6).
Plus exhaustiveness: every reason in the union maps to `unauthorized` on the wire.

### Step 2 — the repository method that writes BOTH columns

`refreshWorkerProfile({ workerId, executionTargetId, expectedProfileHash, profileSnapshot,
profileHash, now })` in `packages/db/src/repositories/tenant/worker-enrollment.ts`, mirroring
`rotateWorker` (`:313-330`) in shape: one `UPDATE … RETURNING`, `rows.length === 1`.
Two deliberate differences from `rotateWorker`, both tested: it does **not** touch
`deviceGeneration`, `devicePublicKey`, `deviceThumbprint`, `status`, `revokedAt` or `enrolledAt`;
and its `WHERE` carries `expectedProfileHash` as a compare-and-set, so two concurrent refreshes
cannot interleave into a snapshot/hash pair from different helloes.

### Step 3 — the local schema, the descriptor and the digest

`selfHelloRequestSchema` = `{ protocolVersion: z.literal(1), correlationId, hello: workerHelloV1Schema }`,
`.strict()`. The descriptor mirrors the self-model read's 64 KiB / 15 s
(`packages/worker-daemon/src/transport/client.ts:77-80`), and the assertion that pins it is that
`maxRequestBytes` is **strictly below** the global body limit — otherwise express refuses first, the
handler's guard is dead code, and the refusal ships in the wrong (non-protocol) shape.

**Here, and only here, the digest is defined:** `sha256(JSON.stringify(parsed.hello))` over the
**zod-parsed** value. The test asserts it equals what
`server/src/services/worker-enrollment.ts:409` would have produced for the same hello, and that a
key-reordered raw body produces the **same** digest — which is only true if the parse happens first
(§0e).

### Step 4 — the route

Mounted inside the existing `if (opts.workerSession)` region of `execution-targets.ts`, behind
`requireWorkerHeartbeatAuthority`, with the `authority.kind !== "session"` refusal **before any
database read** — mirroring `:406-409` and for the stronger reason in §5.1 layer 0.

### ★ Step 5 — the transaction, and the ordering that is the whole point

Inside one `runInTenant`: load the ratified profile → `admitHelloRefresh` → on `changed: false`
answer 204 → on `changed: true` call `refreshWorkerProfile`, then `createWorkerSessionToken`, then
return. **The mint is inside the transaction and after the update**, so a mint throw rolls the
update back.

RED for this step is specifically: inject a signer that throws, drive the route, and assert the
`workers` row is **byte-identical** to before. A version that mints after commit passes every other
test in this file and fails only this one.

### Step 6 — dormancy, proved STRUCTURALLY

Extend the source scan in `server/src/__tests__/desktop-disabled.negative.test.ts`: the new
`router.post("/execution-targets/self/hello"` registration must lie inside an
`if (opts.workerSession)` block in `routes/execution-targets.ts`. **Not** by building an express app
and asserting a 404 — that only proves express 404s a router you declined to mount, which is the
vacuous test WRK-010 §7 Step 4 replaced. §3.3 records that this guarantee is weaker than
worker-control's, and the test comment must say so too.

### ★ Step 7 — the embedded-PostgreSQL suite: an OFFER IS ACTUALLY PRODUCED

The clause this ticket exists for, and it must be driven through the **real** `poll` service, not
through the matcher:

1. seed an org, a target with the ratified profile pair from `tests/fixtures/worker-provisioned-target.json`,
   and a worker whose `profile_snapshot` is the **unprovisioned** hello;
2. seed a `pending`/`selected`/`active`/`leaseEligible` attempt for a `batch` job;
3. **PRECONDITION CONTROL — poll now and assert `outcome: "no_work"`.** Without this the suite
   cannot distinguish "the refresh made it work" from "it always worked";
4. call the refresh route with the provisioned hello; assert 200, a new session header, and that
   `sha256(JSON.stringify(zod(hello)))` equals the row's new `profile_hash`;
5. **poll with the NEW session and assert `outcome: "offer"`**;
6. poll with the **OLD** session and assert refusal — the §0(f) coupling, proven rather than
   asserted;
7. write the returned `body` (a `LeaseOfferV1`) to the shared fixture for Step 8.

Plus the refusal matrix: revoked target, disabled target, generation-superseded, legacy token,
ungranted capability, stale policy, unratified profile — each answering the same coarse code, each
asserting the **log reason**, and each with the admit case above as its positive control.

### Step 8 — the daemon half

(a) `buildDesktopHello` with `provisioning` → a hello carrying `workload.*` and the ratified policy
hash; **and the existing DSK-001 default-path assertions still green, unmodified**.
(b) `hello-provisioning.ts` folds a self-model response into a `HelloProvisioning`, intersecting the
ceiling with what the device can provide, and fails toward absent on a malformed response (returns
`null`, never throws — the `self-model.ts:8-9` rule).
(c) `offerSatisfiesWorker(provisionedSelfModel, measuredCapacity, offer)` returns **true** for the
offer Step 7 captured — parsed through `leaseOfferV1Schema`, not hand-built — and **false** for the
same offer against the unprovisioned self-model. The second half is the positive control's mirror:
without it the assertion cannot tell a working matcher from a permissive one.
(d) `client.selfHelloRefresh()` + the `PAIRS` entry in `scripts/check-worker-path-parity.mjs:26-35`.

### Step 9 — the mutation sweep, then docs

Mutation sweep per §8. Then:

1. **`epics/E4-worker-daemon/findings.md` — E4-F010 → `**Status:** resolved`,** with a dated
   `WRK-011 closure` note recording: the three corrections in §0(a)(b)(c); the **third blocker** in
   §0(d) that the finding never named and that fires first; what closes it (the atomic triple + the
   provisioned builder); and what it explicitly does **not** claim (§6.3 — Sprint 3 composes,
   Sprint 5 demonstrates).
2. **★ The manifest key `E4-F010` must be DELETED in the SAME commit.** `evaluateFindingOwnership`
   computes `openIds` from findings whose parsed status is exactly `open`
   (`scripts/lib/finding-ownership.mjs:79-80`) and then pushes `{kind: "stale_declaration"}` for
   **every** manifest key not in that set (`:132-136`); any problem makes `ok:false` (`:138`) and
   `check-finding-ownership.mjs` exits non-zero, in the always-on `policy` job. So flipping the
   status while the key stands reddens `ci-required` on this ticket's last step. **This design does
   not make that edit** — the manifest is wired by a separate step (see the header). This paragraph
   is the requirement that step must satisfy, and the ordering it must satisfy it in: the key is set
   to `owned`/`WRK-011` when the ticket is wired, and **removed** when the result lands.
3. A **new finding (LOW)** for the two stale comments §0(d) falsifies — `desktop-hello.ts:28` and
   `:145`, plus the `desktop-hello.test.ts` comment that repeats them — since this ticket corrects
   the *code* they describe but a dated design record is not rewritten. **A new open finding is born
   UNDECLARED and undeclared fails** (`scripts/lib/finding-ownership.mjs:83-90`), so it needs its own
   manifest key in the same commit.
4. **Result doc**, carrying the three things a description of what shipped would lose: the third
   blocker the finding never named; the §5.2 decision as taken (or as still open, with who owes it);
   and the mutation line in the §8 form.

---

## 8. Mutation table — DELETE each guard, never rewrite it

**Positive control first.** Step 0's admit case runs before any mutant is applied, and is re-run
after every restore. A harness that cannot produce a GREEN admit is a harness measuring nothing, and
the E1-F008 precedent is that five guards passed their own tests while deleted.

| # | Mutant (a DELETION) | Killed by | Reachable in production? |
|---|---|---|---|
| M0 | *(control — not a mutant)* run the suite unmutated | Step 0 admits; Step 7 offers | — |
| M1 | delete the `authority.kind !== "session"` refusal in the route | Step 7's legacy-token case | **yes** — highest severity: a proofless bearer token rewrites a snapshot |
| M2 | delete G1's `workerId` arm | Step 1 G1 case A | **yes** |
| M3 | delete G1's `targetId` arm | Step 1 G1 case B | **yes** |
| M4 | delete G1's `deviceGeneration` arm | Step 1 G1 case C | **yes** |
| M5 | delete G2 entirely | Step 1's ungranted-capability case; Step 7's wire case | **yes** — a worker writes a capability no admin granted |
| M6 | delete the `ceiling.has(...)` conjunct so G2 becomes "the sets are equal" | **Step 0's positive control** (a strict subset must still admit) | **yes** — this mutant breaks every real worker |
| M7 | delete G3 | Step 1's one-nibble case | **yes** |
| M8 | delete G4's short-circuit | Step 7's "second identical refresh answers 204 and leaves `updated_at` unchanged" | **yes** — session churn on every boot of every worker |
| M9 | delete the `profile_hash` assignment from `refreshWorkerProfile`'s `SET` | Step 7 clause 4, which re-derives the digest exactly as `job-placement.ts:543` does | **yes** — permanent unplaceability |
| M10 | delete the `profile_snapshot` assignment from the same `SET` | the same assertion, from the other side | **yes** |
| M11 | delete the zod-parse before the digest (hash the raw parsed body) | Step 3's key-reordered-body case | **yes** |
| M12 | delete the mint from the 200 path (answer without a new session) | Step 7 clause 5 — the poll with the new session finds none | **yes** |
| M13 | move the mint outside the transaction (delete the `await` that keeps it inside) | Step 5's throwing-signer case | **yes** |
| M14 | delete `expectedProfileHash` from `refreshWorkerProfile`'s `WHERE` | Step 2's concurrent-refresh case | **yes** |
| M15 | delete the `provisioning` branch from `buildDesktopHello` | Step 8(a) provisioned case — **and the DSK-001 default assertions must stay green**, which is what proves the branch is additive | **yes** |
| M16 | delete the ceiling intersection in `hello-provisioning.ts` (report the ceiling verbatim) | Step 8(b) — a device with `isolation: "none"` must not report `sandbox.*` merely because the ceiling permits it | **yes** |
| M17 | delete the sort in `reportedCapabilities` | Step 8(a)'s byte-stability assertion over two calls with set-order-differing input | **yes** |
| M18 | delete the new route's registration from inside the `if (opts.workerSession)` block | Step 6's source scan | **yes** |

**Eighteen mutants, all deletions, all reachable, ZERO declared equivalents.** If a mutant will not
compile, it is **not** an equivalent mutant and must not be counted — WRK-010 §7 Step 6 retracted six
on exactly that ground, and `WRK-008-slice-2b-design.md` §7 Step 6 retracted a seventh. Report the
sweep as *N mutants, N killed, zero survivors, zero documented equivalents, zero false kills*, or say
plainly which survived and why.

---

## 9. Acceptance mapping — every clause to a test that can turn RED

**COUNT THE CALLERS.** No clause below is satisfiable by a function nothing calls, and the two
places where that temptation exists are called out.

| Acceptance clause | Test that can turn RED | Tier |
|---|---|---|
| **A provisioned worker IS OFFERED work** | Step 7 clauses 3→5: a `no_work` precondition control, then a refresh, then `outcome: "offer"` — driven through the **real `poll` service**, so `admissibleWorkloadTypes` (§0d) is on the path | **embedded-PG only** |
| **The daemon's self-check ADMITS that offer** | Step 8(c): `offerSatisfiesWorker` over the offer **captured from Step 7**, parsed by `leaseOfferV1Schema`; plus the false case against the unprovisioned model | unit (daemon) + shared fixture |
| Both columns move together | Step 7 clause 4 re-derives the digest the way `job-placement.ts:543` does; M9/M10 | **embedded-PG only** |
| A refresh returns a usable session and the old one dies | Step 7 clauses 5 and 6; M12 | **embedded-PG only** |
| A failed mint leaves no committed refresh | Step 5's throwing-signer case; M13 | **embedded-PG only** |
| A worker cannot claim an ungranted capability | Step 1 G2 + Step 7's wire case; M5, M6 | unit + **embedded-PG** |
| A legacy worker token cannot refresh | Step 7's legacy-token case; M1 | **embedded-PG only** |
| A no-op refresh writes nothing and mints nothing | Step 7's repeat case (`updated_at` unchanged, 204); M8 | **embedded-PG only** |
| The route is not registered when distributed execution is off | Step 6 source scan; M18. ★ §3.3 records this is a **weaker** guarantee than worker-control's structural non-mount | unit |
| The unprovisioned desktop stays unmatchable | the **unmodified** DSK-001 assertions in `__tests__/desktop-hello.test.ts` staying green under M15 | unit (daemon) |
| The path the proof signs matches the route | `scripts/check-worker-path-parity.mjs` with the new `PAIRS` entry | repo guard |

**★ TWO clauses this ticket deliberately does NOT write, because they would be satisfiable by
nothing that runs.**

1. *"A composed daemon polls, receives the offer, ACKs it and supervises a sandbox."* `createPollLoop`
   has **zero** production callers (§0b) and gets its first in Sprint 3. A clause asserting this
   would be proven by a component test wiring the loop by hand — which measures the test's wiring,
   not the daemon's.
2. *"Work executes end to end."* Sprint 5, on real E2B, per go-book §4 *"Sprint 5 — prove ONE real
   journey"*.

**★ FIVE of the eleven clauses have the embedded-PostgreSQL suite as their only evidence**, and that
suite is `describe.skipIf(win32 && AOA_RUN_WIN_INTEGRATION !== "1")`, which a default Windows-local
run reports as **skipped, i.e. green**. Stated next to the table, because this is the table an author
signs off against: on this worktree's platform a plain `pnpm test` signs off five of eleven clauses
against a run that evaluated nothing. Linux CI runs it unconditionally, so the gap is a
local-verification gap — which is the kind discovered after the push.

**The shared fixture is the link between two packages that cannot import each other.**
`packages/worker-daemon` may import only `@armyofagents/worker-protocol`, `pino` and Node builtins
(E4-D01), and `server` does not depend on it — the constraint
`scripts/check-worker-path-parity.mjs:4-10` exists for. `tests/fixtures/worker-provisioned-target.json`
holds one ratified `registeredProfile` + `providerConstraintProfile` pair and (written by Step 7) one
captured `LeaseOfferV1`. Both suites parse it through the **frozen** schemas, so a drifted fixture
reds both sides rather than silently decoupling them.

---

## 10. Non-goals, named with owners

| Not delivered | Owner | Why |
|---|---|---|
| Composing the poll loop / supervisor / event outbox | **WRK-008 slice 2b — Sprint 3** | §6.3. This ticket makes composition worth doing; it does not do it. |
| Per-OS isolation probes, so a desktop can honestly report `sandbox.*` | **DSK-003** — `isolation-capabilities.ts:33-37` says so | Until then `detectIsolationMechanism` stays uncalled and the mechanism is `none`. The matcher only needs `sandbox.*` when a job's `requiredCapabilities` asks for one (`capabilities.ts:487-489`), so `workload.*` alone is sufficient for the batch journey. |
| Periodic re-refresh / drift detection while running | **Sprint 9 hardening** | Boot-time refresh plus the self-model's `knownSelfModelHash` 304 (`execution-targets.ts:432-436`) covers the common case. A policy change mid-run currently costs one restart. |
| A capacity **reservation** model | **JOB-007 successor** — `job-leasing.ts:747-753` already defers live org-capacity enforcement | Capacity here stays a declared nameplate `Math.min`'d at poll (`:566`). |
| Refresh for a **platform PHYSICAL** worker | follow-up / DEP-00x | Its authority sits behind `acquirePlatformTargetAuthorityExclusive` and a materially different transaction shape — the same non-goal, for the same reason, as WRK-010 §9. Shared-platform **tenant** workers are covered. |
| Heartbeat liveness | already shipped | `candidateFits` needs `registry.lastSeenAt` inside `maxHeartbeatAgeMs` (`job-placement.ts:530-532`) and poll needs the same (`job-leasing.ts:269-270`). `POST /execution-targets/heartbeat` serves it (`execution-targets.ts:454`). Not this ticket's, but a worker that does not heartbeat still gets nothing — say it in the result doc. |
| The §5.2 per-worker activation flag, if chosen | **go-book §8 ledger** | If (b) is taken this design changes materially — §5.2. |

---

## 11. Risks

**R1 — the atomic triple is the ticket.** Get the ordering wrong (mint after commit, or one column
without the other) and the failure is *permanent worker lockout* or *permanent unplaceability*, both
silent, both at a line — `job-placement.ts:543`, `worker-session-auth.ts:167` — far from this
ticket's diff. Mitigation: M9, M10, M12, M13 are four separate deletion mutants over exactly this,
and Step 5's RED is the ordering itself.

**R2 — `packages/worker-daemon` is `pinned` at 131** (`scripts/test-inventory.json:47-50`). Adding
daemon tests without a bump reds `check-test-inventory.mjs`. `server` is `floor` and does not bite.

**R3 — digest fragility.** `sha256(JSON.stringify(hello))` depends on zod's stable key order on both
sides (§0e). It works today because both producers are zod output. A future refactor that hands the
digest a hand-built object breaks placement silently and forever. M11 is the guard; the result doc
should carry the fact.

**R4 — the §5.2 residual is real and is not closed by this ticket.** Recorded as an open question
with a named decider rather than papered over. If the decision is deferred past Step 1, this ticket
ships option (a) by default — which is a decision taken by omission, the thing §5.2 exists to
prevent.

**R5 — `requireWorkerHeartbeatAuthority` accepts a legacy token FIRST** (`execution-targets.ts:85-92`).
A route that omits the `kind !== "session"` refusal hands durable snapshot-write authority to a
bearer token with no device proof. M1, and it is the highest-severity mutant in §8.

**R6 — dormancy here is one conditional registration, not a structural non-mount** (§3.3). Step 6
proves it by source scan, which is the strongest available proof given `app.ts:588`. It is weaker
than what `/worker-control/` gets, and the result doc must say so rather than implying parity.

**R7 — the Windows-local integration skip** silently green-lights five of eleven clauses (§9).

**R8 — this ticket relies on WRK-010 slice 1's `SESSION_MAX_MS` export.** If §13's sequencing is
overridden and WRK-011 lands first, it must export the constant itself and Sprint 1 then edits a
line WRK-011 already touched — a merge conflict in shared authentication middleware, which is the
worst file in the repo to resolve under time pressure.

---

## 12. Rollback

The unit of rollback is **both halves together** (§2.1): reverting only the daemon leaves a route
nobody calls (harmless), but reverting only the server leaves a daemon that calls a 404 on every
boot and must therefore treat a 404 as non-fatal — which Step 8(d) requires anyway.

Revert order: daemon caller → route → repository method → hello-builder input → fixture → parity
`PAIRS` entry. The builder's `provisioning` parameter is optional and its absence is byte-identical
to today, so reverting it cannot change a shipped desktop's enrolment bytes.

**One artefact does not roll back, and it is fine.** Rows already refreshed keep their new
`profile_snapshot`/`profile_hash` pair. Those rows are *valid* — the pair is self-consistent, the
snapshot was signed by the device under the ratified ceiling, and `job-placement.ts:543` re-derives
cleanly. Sessions minted against them outlive the revert by at most `SESSION_MAX_MS`
(`worker-session-auth.ts:15` — 15 minutes) and then expire normally. The observable effect of a
revert is that such workers stop being *refreshable*, not that they become broken.

---

## 13. ★ Where this belongs in the go-book sequence, and why

**Recommendation: a new Sprint 2.75, between Sprint 2.5 (WRK-010 slice 2) and Sprint 3
(WRK-008 slice 2b).**

**It cannot go earlier than Sprint 2.5 — this is a hard dependency, not a preference.** The route's
success response is a new session, and by §0(f) the *old* session is dead the instant the row is
written. Until Sprint 2.5 the daemon has nowhere to put the new one: `enroll-once.ts:310` drops the
enrolment session in as many words, and `E4-F012` records that nothing acquires a first session at
all. Slice 2 is where that is fixed — `WRK-010-design.md` §9.1.1 *"`E4-F012`, DECIDED"* specifies
the `enrollOnce` session **sink** and the `renew(current: WorkerSession)` signature that give the
daemon a `SessionStore` holding a live token. **That store is this route's landing site**, and it
does not exist before Sprint 2.5. A WRK-011 landed before Sprint 2.5 does not merely have no caller — **its success path breaks
any worker that calls it.** That is categorically different from WRK-010 slice 1's honest dormancy,
and it is why the two tickets cannot be sequenced the same way. R8 adds a second, smaller reason:
WRK-010 slice 1 owns the `SESSION_MAX_MS` export this ticket mints against.

**It should go before Sprint 3, and the reason is Sprint 3's own acceptance.** Go-book §4
*"Sprint 3 — WRK-008 slice 2b"* is currently forced to write, in its Done-when block: *"It does NOT
mean 'a worker leases, executes and reports' … E4-F010: the worker self-checks every offer against
its own hello … so the check is `false` for 100% of offers"*, and to downgrade E4 gate clause 1 to
*reachability only* — promoting `E4-2` while leaving `E4-1-leases-through-protocol` unwired or
caveated in a `reason` field the wiring checker never reads (the go-book says that too). If WRK-011
lands first, Sprint 3 composes a loop that can be offered work on its first boot, and `E4-1` is
promotable on evidence. That converts a caveat into a capability, which is the difference the whole
register exists to preserve.

**The brief's observation is correct and does not change the answer.** Both halves *are* writable
against today's tree: the route, the repository method, the admission function, the hello builder
and the provisioning fold all compile and test without a composed poll loop, and §9 proves each at
its own seam. So this is not late-sprint work waiting on Sprint 3's composition. But "writable now"
answers *can it be built*, not *when should it land* — and the session coupling above answers the
second question with Sprint 2.5, unambiguously.

**Rejected — fold it into Sprint 3 as its Step 0.** Sprint 3 is already re-scoping four of its own
assertions against DEP-010 (`WRK-008-slice-2b-design.md` §0.1), already carries the go-book's
*"Largest risk in the whole plan"* label, and already budgets time to re-baseline D1's harness.
Adding a new authenticated durable-write surface with eighteen mutants to that sprint is how a
mutation budget gets quietly halved and a positive control gets skipped.

**Rejected — defer to Sprint 5 planning**, which is where the ownership manifest's `reason` field
currently sends it (*"the ticket that owns it should be written at Sprint 5 planning at the latest"*).
That was the right call when nobody had traced the fix; it is the wrong call now, because Sprints 3
and 4 would both execute against a fleet that provably cannot be offered work, and Sprint 5's
single-journey proof would be the first place anyone discovered whether the fix was even feasible.

**Consequences for the wiring step** (which this document does not perform):

- go-book §3's sequence block gains `S2.75 WRK-011 a worker can be offered work (E4) ── closes E4-F010`;
- go-book §4 gains a Sprint 2.75 section, and Sprint 3's Done-when block **loses** the E4-F010 caveat
  and its E4-1 downgrade — that edit is the visible payoff and must not be forgotten;
- go-book §"One consequence worth reading before Sprint 3" is superseded and should say so rather
  than be deleted, since it is the record of how the gap was found;
- `scripts/finding-ownership.json` key `E4-F010` → `{"status":"owned","ticket":"WRK-011"}` with an
  `ownerStillOpen` naming §6.3's limits, **and removed** when the result lands (§7 Step 9.2);
- `scripts/gate-clause-wiring.json` is **not** touched by this ticket: `E4-1-leases-through-protocol`
  stays `unwired` because `createPollLoop` still has zero production callers after WRK-011 (§0b).
  Sprint 3 promotes it. Writing anything else here would be the false claim of wiring the checker
  exists to prevent.
