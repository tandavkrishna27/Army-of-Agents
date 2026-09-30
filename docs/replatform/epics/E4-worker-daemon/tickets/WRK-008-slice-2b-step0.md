# WRK-008 slice 2b — Step 0: the scoping gate, executed against the tree as it now is

**This is the committed action the go-book §4 Sprint 3 checklist and design §6 Step 0 require
BEFORE any code.** It reformulates the four §0.1 assertions the pre-DEP-010 draft got wrong,
confirms §2's per-root gate table still matches reality, re-derives the two places the plan reasons
from `E4-F010` (whose premise Sprint 2.75 removed), and records the §4/Step 2 re-scoping against the
two predecessors that now run before this slice. Every claim below was verified by opening source on
this branch (`docs/replatform-program`, tip carrying WRK-011 shipped); where the design doc and the
disk disagreed, the disk won and this note says so.

---

## A. Predecessors have SHIPPED — I am in sequence (design §6 Step 0.1/0.2)

| Predecessor | Required state | Verified |
|---|---|---|
| **Sprint 2.5 (WRK-010 slice 2)** | result doc on disk; the production session lifecycle it owns exists in source | `WRK-010-slice-2-result.md` present; `identity/worker-session-lifecycle.ts` exports `createWorkerSessionLifecycle(deps) → { store, onSessionMinted }`; `SessionStoreDeps.renew(current)` + required `bootstrap()` in `identity/session.ts`; `shouldComposeSession` in `lifecycle/compose-dispatch.ts:84`; the boot root already constructs the lifecycle (option c) at `bin/worker-daemon.ts:294-309` |
| **Sprint 2.75 (WRK-011)** | `E4-F010` `resolved` with its manifest key deleted; the provisioning symbols exist | `findings.md:239` reads `Status: resolved (WRK-011, go-book Sprint 2.75)`; **no `E4-F010` key in `scripts/finding-ownership.json`**; `enrollment/hello-provisioning.ts` exports `deriveHelloProvisioning` + `HelloProvisioning`; `desktop-hello.ts` has the optional `provisioning` input; `client.selfHelloRefresh()` + `SELF_HELLO_PATH` exist in `transport/client.ts` |

Neither predecessor is pending. This slice **composes on top of** both; it does not build the session
lifecycle (2.5 owns it) and does not author the refresh route or the provisioning fold (2.75 owns
them). Had either still been open, design §6 Step 0 says STOP — they are not.

---

## B. The four §0.1 assertions, reformulated against the current tree

Each row: what the pre-DEP-010 draft asserted · why DEP-010 (Sprint 2) invalidated it · the verified
current fact · the assertion this slice tests instead.

### B1 — Step 8b's `"provider" in call === false` → a VALUE assertion

- **Was:** the desktop bootstrap call passes no `provider` key at all.
- **Now (verified):** `packages/worker-keystore/src/bin/desktop-host.ts:292-299` passes
  `provider` **unconditionally as a key** (`let provider = deps.provider` at `:281`, resolver at
  `:283`, `provider,` in the `bootstrap({...})` argument at `:297`). So `"provider" in call` is
  **`true`**; the old assertion goes red on arrival.
- **Reformulate as:** `call.provider === undefined` under an env this test builds explicitly with
  DEP-010's real switches — `AOA_WORKER_SANDBOX_PROVIDER` (the constant `PROVIDER_ENV`,
  `sandbox-provider.ts:32`) and `AOA_WORKER_E2B_TEMPLATE` (`TEMPLATE_ENV`, `:34`) — **removed**.
  Knowingly the *weaker* of the two properties (a value under one env, falsifiable by an env var),
  because after Sprint 2 the weaker one is the true one. This is the honest content of `E4-F011`.

### B2 — Step 9b's guard property → "no root constructs a provider UNCONDITIONALLY; the shipped default resolves to none"

- **Was:** the guard fails if any boot root passes a `provider` key.
- **Now (verified):** `desktop-host.ts:297` passes a `provider` key, so a guard asserting the
  absence of the key would be **red on every PR** — and this guard lands in the **always-on `policy`
  job**, which has **no docs-only skip** (`pr.yml` `policy` job gated on draft status only). This is
  the assertion the brief flagged: *"one of them is a guard that lands in the always-on policy job
  and would be red on every PR, docs-only ones included."* Writing it against the old wording would
  redden the branch for everyone.
- **Reformulate as:** for each declared boot root, either (a) it passes no `provider` key, or (b) the
  value it passes is produced by a **declared resolver whose default is `{kind:"none"}`** and which is
  confined to DEP-010's `PROVIDER_HOST_PATH`. A root that hardcodes a provider, or defaults its
  resolver to one, fails. Do **not** keep the old wording and pass because the matcher only ever
  recognised the bare identifier.

### B3 — §2 row 1's desktop cell "no — E4-D01 makes it unconstructable here" → an ENV RESOLUTION

- **Was:** gate 1 (`no_provider`) is structural on the desktop because no code path can construct a
  provider.
- **Now (verified):** E4-D01 still holds for the **daemon** package (`worker-daemon` may not import a
  provider; DEP-010 left `worker-daemon-boundary.mjs` byte-unchanged), but the **keystore** root
  gained `bin/sandbox-provider.ts` and constructs one. The shipped desktop default refuses because
  `AOA_WORKER_SANDBOX_PROVIDER` is **unset** (resolver returns no provider ⇒ `provider` stays
  `undefined` ⇒ `no_provider`), not because construction is impossible.
- **Reformulate the desktop cell as:** *"no today; an ENV RESOLUTION after Sprint 2 — the shipped
  default resolves to `{kind:"none"}` because `AOA_WORKER_SANDBOX_PROVIDER` is unset."* Gate 1 stops
  being structural on the desktop root.

### B4 — Step 9a's `AOA_WORKER_PROVIDER_URL` gate → DEAD ENV, not a gate

- **Was:** treat `AOA_WORKER_PROVIDER_URL` as (part of) D1's provider gate; declare
  `providerUrl: "http://fake-provider:8080"`.
- **Now (verified):** DEP-010's resolver reads `AOA_WORKER_SANDBOX_PROVIDER` + `AOA_WORKER_E2B_TEMPLATE`
  and **never** `AOA_WORKER_PROVIDER_URL`. A full-tree grep for `AOA_WORKER_PROVIDER_URL` across
  `packages/`, `server/src/`, `scripts/` returns **zero code readers** — only the two compose lines
  `docker-compose.d1.yml:304` and `:343`.
- **Reformulate as:** Step 9a's D1 declaration records `AOA_WORKER_PROVIDER_URL` as **present-and-dead**
  (set on both workers, read by no code, **not** a gate) AND that the variables that *would* construct
  a provider (`AOA_WORKER_SANDBOX_PROVIDER`, `AOA_WORKER_E2B_TEMPLATE`) are **absent**, with the reason
  recording that D1 runs `bin/worker-daemon.js` (`docker/worker/Dockerfile:112`), which has no resolver
  at all. Author that row against DEP-010's shipped constant names.

---

## C. §2's per-root gate table — confirmed against reality

Verified the six gates and the per-root landable split. Nothing in the design's §2 table is stale;
the reformulations in B1–B4 are already reflected in the current §2 (row 1 desktop cell, the
three-landable count, gate 4). Confirming the counts against source so nothing is assumed:

- **Container root** (`docker/worker/Dockerfile:112` → `bin/worker-daemon.ts:398`, injects `{env, proc}`
  only): gate 1 `no_provider` **structural** (DEP-010 does not touch this root — its §5 lists only
  `desktop-host.ts`, and `worker-daemon-boundary.mjs` is byte-unchanged, so `bin/worker-daemon.js` has
  no resolver); gate 3 `no_worker_identity` unsatisfied (`mounted_secret`, no stores). **Four landable
  gates outstanding** (provider, flag, custody+enrolment, outbox path) of six total.
- **Desktop root** (`bin/desktop-host.ts` → `aoa-worker-desktop`): builds both OS-custody stores
  unconditionally (`:114-125`) and passes them every non-control boot (`:254-260` region), and
  `resolveCustody` makes `mounted_secret`+store a fatal exit — so **gate 3 is ALREADY SATISFIED** on
  every boot. Gate 1 is now an env resolution (B3). **Three landable gates outstanding** (provider,
  flag, outbox path) of five total.
- The two runtime gates — gate 5 `no_session` (a live session) and gate 6 `no_self_model` (an
  admin-set placement profile) — gate dispatch equally hard on both roots and are **not** in the
  landable subset. Say "four/three landable of six/five total" every time; never "four and three" as
  if it were the whole table.

**D1 gate story (design §8 / §2), confirmed:** `docker-compose.d1.yml` — both workers have
`AOA_WORKER_KEY_STORE_MODE: "mounted_secret"` (`:312`, `:348`), **no** `AOA_WORKER_DISPATCH_ENABLED`,
**no** `AOA_WORKER_SANDBOX_PROVIDER`/`AOA_WORKER_E2B_TEMPLATE`/`AOA_WORKER_EVENT_OUTBOX_PATH`, and a
present-but-dead `AOA_WORKER_PROVIDER_URL`. **D1's gate 1 stays structural through Sprint 2** because
the D1 image runs the container root, which DEP-010 never modified. The round-2 refutation ("D1's
provider gate does not become an env var") holds against the current tree.

---

## D. Re-derive the two places the plan reasoned from E4-F010 — now ON EVIDENCE, not a forced downgrade

Sprint 2.75 closed `E4-F010`: a provisioned worker IS matchable and its own `offerSatisfiesWorker`
ADMITS a valid offer (WRK-011-result §2, §4). So the two places slice 2b concluded a clause "must
stay `unwired` because the worker refuses 100% of offers" have lost that premise. Re-derived:

### D1 — §2 gate story (§1.1(c)'s "false for 100% of offers")

That is the **pre-2.75** fact and is kept in the design only to show what the provisioning must
overturn. In the executed slice the composed hello is the **provisioned** one (folded from the
self-model read via `deriveHelloProvisioning`, built with `buildDesktopHello({…, provisioning})`), so
`offerSatisfiesWorker` returns **TRUE** for a valid `workload.batch` offer. Step 6's self-check test
therefore asserts the WRK-011 Step 8(c) mirror — `true` over the provisioned self-model, `false` over
an **unprovisioned** one as the negative control — and **must not** reproduce the bare-hello
`=== false` assertion revision 3 carried.

### D2 — §9 / Step 10 E4-1 promotion row

`E4-1-leases-through-protocol` (symbol `createPollLoop`) still stays **`unwired` with
`expectedReferences: 1`** in this slice — but **the reason is NOT "E4-F010 / unmatchable"** any more.
The honest reason is that this slice **composes** the loop (giving it its first production caller) but
does **not demonstrate** a lease actually taken in its own suite. Per the go-book §4 Sprint 3
checklist, `E4-1` is promotable **on evidence** — a composed loop that took a lease in this sprint's
own suite — never on caller count and never on a caveat parked in a `reason` field (the wiring checker
validates a `wired` entry on caller count alone and never reads `reason`:
`lib/gate-clause-wiring.mjs:81-88`). Composing is not demonstrating; Sprint 5 is the journey. The
register entry's `reason` is rewritten to say exactly this (drop the E4-F010 wording).

### D2b — E4-2 stays `unwired` for a REASON THE BRIEF EMPHASISES

`E4-2-supervises-sandboxes` (symbol `createSupervisor`) stays **`unwired` with
`expectedReferences: 1`**. Do **not** promote it on the strength of a composed supervisor: production
reaches the supervisor only **after an ACK** (`poll-loop.ts:538` self-checks and returns
`{kind:"continue"}` before `ackLease` at `:549`; the supervisor is reached only via `trackHandoff` at
`:559`), and **no production ACK path exists at this sprint's tip**. Promoted on composition alone it
would go green over **zero supervised sandboxes**. It needs an actually-supervised sandbox — Sprint 5.

---

## E. §4 / Step 2 re-scoping (design §0.2 A/B, go-book §4 Sprint 3 checklist)

**(A) Sprint 2.5 owns the `SessionStore` + identity session lifecycle; this slice consumes it.** This
slice does **not** construct `SessionStore(..., initial=null)`, does not author the `renew`/`bootstrap`
wiring, and does not derive the device key *for the session*. `createWorkerIdentity` (Step 2)
**receives** the lifecycle Sprint 2.5 built (`createWorkerSessionLifecycle`, which surfaces `store`)
and threads `lifecycle.store` into `createSessionProvider` → the poll loop. Every place the design's
§4 diagram / Step 2 / Step 6 / Step 7 / §7 row 7b still shows this slice *building* the store is
pre-2.5 wording; the construction and its zero-residue obligation are Sprint 2.5's.

**GAP-1 (Sprint 2.5 result §5, named for me):** `lifecycle` is today a **block-scoped `const` inside
the `os_keychain` enrolment block** (`bin/worker-daemon.ts:298`). Step 7 must **hoist** it (or move
the composition) so `lifecycle.store` is in scope where the dispatch branch composes the poll loop.
Sprint 3 re-derives the device key + hello via the exported `deviceKeyFromPkcs8Der` + `buildDesktopHello`
(the lifecycle surfaces only `store`).

**(B) Sprint 2.75 makes the worker matchable; this slice composes its provisioning.** The hello
threaded into `PollLoopDeps.self` carries WRK-011's **provisioning** (folded from the self-model read
via `deriveHelloProvisioning`), **not** the bare `buildDesktopHello({workerId, targetId, deviceGeneration,
platform, arch})`. This slice owns the wiring WRK-011 left uncomposed: call `client.selfHelloRefresh()`
at boot (refresh the snapshot + take the new session bound to the new `profile_hash`) before polling,
fold the provisioning into the assembled `WorkerSelfModel`, and thread that model into
`PollLoopDeps.self`. WRK-011's file list touches no composition root; wiring it into boot is E4-D12's
live-dispatch seam, which is this slice.

**Consequence for Step 6's self-check test:** it can no longer assert `offerSatisfiesWorker === false`
for a valid `workload.batch` offer — it asserts `true` over the provisioned self-model and `false`
over an unprovisioned one (the D1 re-derivation above).

---

## F. Findings this slice must dispose of at result time (design §11, §9.1)

`E4-F008` and `E4-F009` are **owned by WRK-008** in `scripts/finding-ownership.json` and neither is
fixed by this slice. `finding-ownership.mjs:118` checks only that `ownerStillOpen` is a **non-empty
string** (the `E4-F013` hole), so the moment WRK-008 has a result doc **both keys read as
owned-and-handled while nothing handled them** — silent false ownership (`E4-F013`). The result commit
must, for **each**, either resolve it (only if genuinely done — it is not) or **transfer** it to a
**named successor ticket that exists on disk** (none exists today, so the successor ticket(s) must be
filed first). Recorded here so it is a planned gating action, not a surprise at result time.

---

## G. Registers this slice will turn red on arrival unless handled in the same commit (design §0.1, §5, §11)

- **`scripts/test-execution-census.json`** — Step 9 adds two `*.test.mjs` under `scripts/`;
  `check-execution-census.mjs` (always-on `policy` job) fails on any `*.test.mjs` with no entry, and
  the entry must name the real `pr.yml` step. Manifest entry + workflow step + test files ride in one
  commit.
- **`docs/deploy/environment-variables.md`** — `AOA_WORKER_EVENT_OUTBOX_PATH` (Step 5) ships with **no
  guard firing** (brand-check guard 9 greps `process.env.AOA_[A-Z_]+`; `config.ts` reads through the
  `ENV` map). Add the row by discipline in the Step 5 commit.
- **`public-surface-dispatch.test.ts`** (Sprint 2's file) — Step 4/7 retire `no_self_model_reader`,
  replace `hasSelfModelReader` with `hasWorkerIdentity`, add `hasEventOutboxPath`, swap `selfModel`
  for `selfModelRead`. Update the pinned surface in the commit that changes it.
- **DEP-010's Step 8 supporting case** — its `no_self_model_reader` assertion is deleted by this
  slice (DEP-010 marked it "demoted; retires with slice 2b"). Find it by grepping the token.
- **`check-gate-clause-wiring.mjs`** — `E4-4 → wired`; `E4-1`/`E4-2` stay `unwired` with
  `expectedReferences: 1` (D above); `E4-3` stays `unwired` with a rewritten reason (§4.2 one blocker).

---

**Step 0 verdict:** in sequence; the four assertions are reformulated and confirmed against disk; the
§2 gate table matches reality; the E4-1/E4-2 dispositions are re-derived on evidence (not on the
removed E4-F010 premise); §4/Step 2 are re-scoped to compose on Sprint 2.5's lifecycle and WRK-011's
provisioning. Proceed to Step 1.
