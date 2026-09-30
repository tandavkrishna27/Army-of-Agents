# DSK-001 Lane C — design

**Date:** 2026-08-21
**Branch:** `docs/replatform-program` (PR #323)
**Start SHA:** the commit that lands this file, before any Lane C code
**Covers:** design D16 (three fixes) and I22 (seven negative clauses)

---

## 1. What Lane C is

Desktop support must be provably **inert** while it is disabled. Two of I22's seven
clauses **fail today**, and they are not test gaps — they are live holes. The design is
explicit that writing a test around current behaviour would enshrine it, so D16's fixes
come first and the assertions follow.

**This is a behaviour change to shipped code paths**, and it belongs in the release note:
a deployment that already created a desktop execution target will start seeing it
rejected. That is the point — today such a target silently runs work on the control plane.

---

## 2. The two live holes, verified first-hand

### F27 — an active desktop target can be created with the flag off

`executionTargetRoutes` is mounted at `server/src/app.ts:535`. The
`if (opts.distributedExecutionEnabled)` block opens at `:438` and closes at `:461` — the
mount is **97 lines outside it**. The POST create handler
(`server/src/routes/execution-targets.ts:130`) validates the schema, asserts org-admin,
and inserts `...input` directly. `createExecutionTargetSchema.kind` accepts `"desktop"`
and `status` defaults to `"active"`.

So flag-off, an org owner/admin can create an **active** desktop target, and `GET` lists it.

### F28 — a routed desktop or e2b target executes on the CONTROL PLANE

`executionTargetToAdapterConfig` (`server/src/services/execution-target-resolver.ts:254`)
handles `local_host` (returns null — the local driver, legitimately no override) and
`pooled_gvisor`/`dedicated_worker`, then ends in a bare `return null` at `:283`.

`desktop`, `e2b`, and **any future kind** hit that fallthrough. Null means "no adapter
override", so `mergeResolvedExecutionTarget` leaves the default config and the run
executes on the control-plane host.

Reachability, traced: the sole production caller is `server/src/services/heartbeat.ts:3620`,
which passes whatever `chooseExecutionTargetRow` returned. That function's **pin branch**
(`:180-186`) returns *any* active row, including desktop and e2b. The non-pin paths do
filter — `personal_subscription` to `dedicated_worker | local_host`, `company_api_key` to
`pooled_gvisor` — which is why clause 4 already holds.

---

## 3. Decisions

### D-C1 — `e2b` throws too, and the switch is exhaustive (the D16 audit)

The design says "`e2b` has the identical fallthrough and is audited in the same pass". The
audit's answer is **throw**.

`desktop` and `e2b` belong to the **distributed placement** system, not the legacy adapter
path: `TARGET_KIND_BY_CLASS` (`execution-target-resolver.ts:52-56`) maps
`managed_cloud → {pooled_gvisor, e2b}` and `owner_desktop → {desktop, local_host}`, and
E2B execution itself runs through `environments` with `provider: "e2b"`
(`server/src/services/environment-runtime.ts:348`) — a different mechanism entirely, keyed
on the *environment provider*, not the execution-target kind.

So there is no legacy adapter representation for either kind, and `return null` does not
mean "handled elsewhere" — it means "runs here, unsandboxed". Both throw.

> **STRENGTHENED after the terrain map (2026-08-21).** My original framing — "null
> means no adapter override, so the run executes on the control-plane host" — is
> directionally right but imprecise about *why*, and the precise version is a better
> argument for throwing.
>
> On a **pinned** run the adapter-config return value has **no effect at all**.
> `mergeResolvedExecutionTarget` writes `resolvedConfig` at `heartbeat.ts:3617`, but
> `applyEnvironmentAcquisitionConfig` is applied afterwards at `:4466` and the code's own
> comment at `:4460` calls it "always the authoritative, LAST-applied one". A pin always
> implies an environment (`executionTargetId` and `environmentId` are read from the same
> row and returned null together), so the environment's config patch is non-empty and
> overwrites whatever the adapter produced.
>
> So returning a config and returning null are **the same no-op**. A throw is the only
> outcome that changes anything — which turns "should e2b throw?" from a judgement call
> into the only available answer.
>
> Three further supports, verified: the throw lands on a clean path
> (`pre_spawn_failed`, run marked failed, leases and workspaces released, error run event
> appended, `heartbeat.ts:2769-2790`); `assertUnsandboxedMultitenantAllowed` early-returns
> unless `cloud_auth`, so the self-hosted modes DSK-00 must keep inert have **no
> downstream guard** and this throw is the only one on the reachable surface; and
> Decision #117 §4 already fails closed for an explicit pin when routing *errors*, so
> silently degrading when routing *succeeds* onto an unmapped kind was an asymmetry
> nobody designed.
>
> **The one honest caveat:** an operator who paired an e2b *environment* with an e2b-*kind*
> target as bookkeeping would see that run fail. Zero such instances exist in code, tests,
> fixtures, migrations or docs, and `docs/api/execution-targets.md:18` never mentions e2b.
> If that pairing is ever wanted, the right shape is an explicit branch proven by the
> acquire's resolved sandbox — not a bare fallthrough indistinguishable from the dangerous
> case.

The replacement is an **exhaustive switch**, so a sixth kind added to
`EXECUTION_TARGET_KINDS` fails loudly rather than inheriting the fallthrough. That is the
part with the longest shelf life: the bug was never really about desktop, it was about a
default branch that silently permits.

**Fail-closed is correct here.** The heartbeat's `handleExecutionTargetRoutingError` wraps
the *routing* `.catch()`, not the adapter-config call, so the throw propagates and fails
the run. A failed run beats a run executing on the control plane with a desktop target.

`local_host → null` stays, and its comment is accurate: the local driver *is* the default,
so no override is the right answer.

### D-C2 — the create guard rejects with **403**, not I22's literal 400

I22 clause 1 says "→ 400". The same file already refuses a disabled registry twice, at
`routes/execution-targets.ts:265` and `:293`:

```ts
if (!opts.workerSession) throw forbidden("Distributed execution registry is disabled");
```

`forbidden` is already imported (`:29`). A disabled capability is 403 ("you may not"), not
400 ("your input is malformed") — and matching the file's own idiom matters more than
matching a status code the design named in passing. **Deviation recorded here rather than
silently taken**; the test asserts the exact status either way.

`opts.workerSession` is the right signal: at `app.ts:537` it is computed as
`opts.distributedExecutionEnabled && tenantAppDb && operatorDb && workerSessionSigningKey`,
so truthy ⟺ distributed execution is actually usable. No new plumbing.

### D-C3 — GET is NOT filtered

D16 rejects filtering desktop rows out of `GET`: it hides an already-enabled row instead
of neutralising it, which is strictly worse for incident review. `listExecutionTargets`
(`server/src/services/execution-targets.ts:502`) does no kind filtering and keeps none.

Clause 1's GET half therefore means: **creation is blocked, so no desktop row exists to
list**. The test asserts that after a refused create — never that the list filters.

### D-C4 — clause 5 is a STRUCTURAL assertion, not a grep

`ui/` contains 104 occurrences of "desktop", and every one of them is a responsive
breakpoint ("desktop tier", "desktop width"). A grep-based checker would be pure noise.

The real property is narrower and stronger: `EnvironmentsSection.tsx:79` declares its own
**hardcoded closed union**

```ts
type EnvTargetType = "local" | "sandbox-docker" | "e2b" | "gvisor";
```

which contains no desktop **and is not derived from `EXECUTION_TARGET_KINDS`** (the UI
never imports that constant). So a desktop option cannot appear implicitly. The assertion
pins both halves: the union's members, and the fact that it is not generated from the
shared kind list.

### D-C5 — clause 6 is a one-line doc pin

`docs/deploy/distribution.md:16` (the design says `:17`) carries decision H.D1:
**"Docker + NPM only. No desktop installer in Phase H."** That file mentions "desktop"
exactly once, so the pin can be exact rather than fuzzy.

---

## 4. What already holds — assert, do not build

| Clause | State | Proof |
|---|---|---|
| 2 — enroll / enrollment-codes 404 flag-off | **holds** | `workerControlRoutes` is `await import`ed and mounted *inside* the flag block (`app.ts:438-461`); unmounted ⇒ 404 |
| 4 — no-pin routing never returns desktop | **holds** | `chooseExecutionTargetRow` filters to `dedicated_worker \| local_host` and `pooled_gvisor` on the non-pin paths |
| 5 — no desktop option in the environments UI | **holds** | the hardcoded union at `EnvironmentsSection.tsx:79` |
| 6 — the doc still says no desktop installer | **holds** | `distribution.md:16` |
| 7 — no desktop package/update/manifest route | **holds** | no match anywhere under `server/src/routes` |

## 5. What fails and must be fixed first

| Clause | Hole |
|---|---|
| 1 | F27 — create an active desktop target with the flag off |
| 3 | F28 — a pinned desktop/e2b target runs on the control-plane host |

---

## 6. Landing order

| # | Increment | Notes |
|---|---|---|
| **C1** | the exhaustive switch in `executionTargetToAdapterConfig` (F28) | behaviour change; pure function, fully unit-testable |
| **C2** | the create guard (F27) | behaviour change; route-level |
| **C3** | `desktop-disabled.negative.test.ts` — clauses 1–5 | 3 and 4 are pure; 1 and 2 are route-level |
| **C4** | `scripts/check-desktop-surface-disabled.mjs` — clauses 5, 6, 7 + its own adversarial corpus | policy lane, always-on |

C1 and C2 are separable and independently verifiable, so each behaviour change lands with
its own evidence rather than inside a bundle of new assertions.

## 7. Open question for the operator

This changes shipped behaviour. Any deployment that already created a desktop or e2b
execution target will see runs **fail** instead of silently executing on the control
plane. That is the intended outcome and belongs in the release note, but it is worth
naming before it lands rather than after.
