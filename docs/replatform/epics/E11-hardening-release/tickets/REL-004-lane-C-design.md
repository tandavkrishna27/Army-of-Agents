# REL-004 Lane C — wire the kill switch (clause 3a: stop new leases)

**Ticket** REL-004 · **Clause** 3a · **Epic** E11 · **Branch** `docs/replatform-program` (PR #323)
· **Parent design** [`REL-004-design.md`](./REL-004-design.md) · **Parent result**
[`REL-004-result.md`](./REL-004-result.md) §4.

**Goal:** make the landed, caller-less kill-switch decision function actually stop new
leases, so Wave 4 does not move live execution onto a platform with no stop button.

**Architecture:** the poll answers a killed placement with the frozen protocol's `drain`
outcome. The policy document is read once per poll from a new `instance_settings.kill_switches`
column under the `aoa_app` serving role; the verdict is computed by the existing pure
`evaluateKillSwitches` inside the poll's tenant transaction, where the target's `kind` is
already in scope and no new repository selection is needed. The worker daemon learns to
treat a drain that carries a `retryAfterMs` as a reversible pause rather than a terminal stop.

**Tech stack:** TypeScript, Express 5, Drizzle ORM + PostgreSQL (non-owner `aoa_app` role
under FORCE RLS), Vitest (+ embedded PostgreSQL for integration), the frozen
`@armyofagents/worker-protocol` v1.

---

## 1. Terrain — verified, and it corrects the inherited notes in three places

Everything below was read in source at `3ef2cf6e7`, then re-read (process step 2). Three
inherited claims did not survive that.

### 1.1 What is already built

| Fact | Evidence |
|---|---|
| `evaluateKillSwitches` is pure, fail-closed on an unreadable document, and mutation-tested 18/18 | `server/src/services/execution-kill-switches.ts`, `server/src/__tests__/execution-kill-switches.test.ts` |
| It has **zero callers** | `evaluateKillSwitches` appears in exactly 3 files: its module, its test, and the handoff |
| Nothing in `server/src` emits `outcome: "drain"` | the only producers are `packages/worker-daemon/src/__tests__/support/fake-control-plane.ts` and the protocol's own test |
| The poll is the only lease-creation path | `offerLease` is called from `job-leasing.ts` and nowhere else in `server/src` |
| `execution_targets.kind` is readable by `aoa_app` | `APP_JOB_PLACEMENT_TARGET_SELECT_COLUMNS` includes `kind` |
| The poll's tenant body already holds the target's `kind` | `lockWorkerLeaseAuthority` selects `placementTargetColumns`, which includes `kind` (`packages/db/src/repositories/tenant/job-control.ts:914`) |

### 1.2 CORRECTION 1 — the template axis is not knowable in the control plane

The parent result doc and the handoff both say: *"The template axis is the pinned E2B alias
in `packages/sandbox-e2b-provider`'s capability matrix (`templateId: "aoa-base"`)."*

That pin is real (`packages/sandbox-e2b-provider/src/capability-matrix.ts:63`) but it is
**worker-side**, and `scripts/check-sandbox-e2b-provider-boundary.mjs` keeps that package out
of `server/src`. The control plane holds no template fact for a distributed worker:

- the frozen `workerHelloV1Schema` has no template field (`policyHash` is
  `UNPROVISIONED_POLICY_HASH` — all zeros — for desktop workers);
- `providerConstraintProfileV1Schema` is deliberately expressed "WITHOUT provider-specific
  field names" and has none;
- `registeredTargetProfileV1Schema` has none;
- `execution_targets` has no template column.

The one place a template *is* known server-side is the **legacy** sandbox path
(`server/src/services/sandbox-provider-runtime.ts:530`, `template: readString(raw.template) ?? "base"`,
from `environments.config`) — a different seam that creates no `leases` row and is not what
clause 3a's "new leases" means.

**Why this matters and is not cosmetic.** `evaluateKillSwitches` distinguishes
`template: null` (DEFINITELY NONE) from `template: undefined` (UNKNOWN → fail closed). Wiring
it with `null` would make every template switch a **silent no-op** — the exact hazard the
module's own header refuses for a mistyped `dimension` ("ignoring it means the switch they
just threw does nothing at all"), and the exact failure class REL-004 Lane A was written to
kill ("a false claim of enforcement is worse than a missing check"). Wiring it with
`undefined` under today's contract makes *any* existing document unreadable, so throwing a
`provider` switch on `pooled_gvisor` would drain e2b workers too.

Neither is acceptable, so the decision function gains one precision fix — D2 below.

### 1.3 CORRECTION 2 — `instance_settings.general` silently erases unknown keys

The parent result doc specifies storage at `instance_settings.general.killSwitches`.
`instanceSettingsService.updateGeneral` writes

```ts
general: { ...nextGeneral, ...operationalMetadata }
```

where `nextGeneral` is the **fixed four-field** output of `normalizeGeneralSettings`
(`censorUsernameInLogs`, `keyboardShortcuts`, `feedbackDataSharingPreference`,
`backupRetention`) and `operationalMetadata` carries only `migrationSnapshots`
(`server/src/services/instance-settings.ts:19-33,140-150`). A `killSwitches` key in `general`
is therefore **deleted the next time anyone PATCHes instance settings** — an operator throws a
kill switch, someone toggles a checkbox in Settings, and the switch evaporates with no error.

The carve-out mechanism exists precisely because this already bit `migrationSnapshots` once.
Rather than add a second squatter to a UI-owned bag, the switch gets its own column — D3.

### 1.4 CORRECTION 3 — a poll `drain` is, today, a ONE-WAY fleet stop

`packages/worker-daemon/src/poll/poll-loop.ts:651-654`:

```ts
} else if (attempt.kind === "drain") {
  emitPoll("drain");
  drainRequested = true;
  stopLeasingRequested = true;
}
```

and the loop is `while (stopReason === null && !stopLeasingRequested)`. A drained worker
finishes in-flight work and **never polls again**; `run()` returns `"drained"`. The protocol's
`retryAfterMs` on the drain outcome is parsed (`poll-loop.ts:257`) and then **read by nothing**
— another value with no consumer.

The handoff's rationale for the kill switch is that "a bad cutover is reversible in seconds".
With a one-way drain, un-throwing a switch requires restarting every worker process. That is a
grenade, not a switch, and discovering it mid-cutover is exactly what §4 of the handoff
forbids. D5 fixes it, using the nullable `retryAfterMs` the frozen protocol already models.

### 1.5 The two flows, drawn

```
WORKER POLL (server side) — where the kill check sits
────────────────────────────────────────────────────────────────────────────
  POST /worker-control/poll
        │
        ├─ pollRequestV1Schema.safeParse ─────────── malformed ─▶ 400
        ├─ verifyWorkerOperationProof ────────────── bad proof ─▶ 401
        ├─ pollRateLimiter.admit (DEP-009, shared) ─ over cap ──▶ 429 throttled
        │
        ▼   leasing.poll()
    ┌───────────────────────────────────────────────────────────────────┐
    │  killSwitchDocument = killSwitches.read()      ◀── OUTSIDE the tx │
    │     row missing / column NULL  ─▶ undefined  (absent = permitted) │
    │     read threw                 ─▶ SENTINEL   (unreadable = kill)  │
    │     no reader wired            ─▶ SENTINEL   (no stop button =    │
    │                                               NOT "nothing kills")│
    └───────────────────────────────────────────────────────────────────┘
        │
        ▼   for (restartAttempt = 0..2)  runInTenant(appDb, orgId)      ── FROZEN
             ├─ cleanupExpiredProofs / recordProof / lockWorkerLeaseAuthority
             ├─ guardPlatformAuthority ──▶ authorityCurrent
             ├─ touchWorkerLeaseProfile              ◀── D7: a paused worker is ALIVE
             │
             ├─ evaluateKillSwitches({                ◀── THE CHECK (pure, no new SELECT)
             │      document, provider: currentTarget.kind,
             │      template: undefined, knownProviders: EXECUTION_TARGET_KINDS })
             │        killed ─▶ return { outcome: "drain", retryAfterMs, reason }
             │
             ├─ normalizePlacementRegistryTarget
             ├─ lockEligibleLeaseCandidates   ◀── the ONE repository selection
             ├─ evaluateStaticLeaseEligibility loop  ◀── NOT here (certificates)
             └─ offerLease ─▶ { outcome: "offer" }   or   { outcome: "no_work" }

  UNTOUCHED, and that is the point: ack + renew have no kill check, so a lease
  offered one millisecond before the switch still completes (I12).
```

```
WORKER DAEMON — what a drain means (D5)
────────────────────────────────────────────────────────────────────────────
                       ┌──────────────┐
              ┌───────▶│   POLLING    │◀────────────┐
              │        └──────┬───────┘             │
   resume after cadence       │                     │ offer / no_work
              │               ▼                     │
              │        outcome = "drain"            │
              │               │                     │
              │      ┌────────┴────────┐            │
              │      │ retryAfterMs?   │            │
              │      └────┬───────┬────┘            │
              │      set  │       │  null           │
              │           ▼       ▼                 │
              │     ┌─────────┐  ┌──────────────┐   │
              └─────┤ PAUSED  │  │  DRAINED     │   │
                    │ drain   │  │ (terminal —  │   │
                    │ in-flight  │  loop exits) │   │
                    └─────────┘  └──────────────┘   │
                                                    │
   BEFORE this change both arrows went to DRAINED, so un-throwing a kill
   switch would have required restarting every worker process.
```

### 1.6 Where enforcement may and may not go

- **Not** in `evaluateStaticLeaseEligibility`'s loop — it records
  `static_requirements_mismatch` negative certificates, and a kill switch is not a
  requirements mismatch (parent result §4; handoff §3).
- **Not** as a new repository selection inside the poll's `runInTenant` body. The JOB-003
  contract is AST-guarded by `server/src/__tests__/job-leasing-contract.test.ts`
  (`candidate:exactly-one-selection-call`, `candidate:awaited-top-level-repository-selection`,
  `binding:protected-value-escape` with an allow-list of reviewed calls). JOB-007 already
  deferred live org-capacity enforcement for this reason (`job-leasing.ts:658-664`).
- **Permitted**: a *pure* decision call inside that body over values already in scope. The
  allow-list already carries `evaluateStaticLeaseEligibility`, `deriveAdmissibleWorkloadTypes`,
  `authorityCurrent` and friends — it is a register of reviewed calls, not a freeze. Adding
  one more is the mechanism working as designed, and D4 pays for it with a mutation test
  proving the guard still refuses an *unreviewed* call.

---

## 2. Decisions

**D1 — the enforcement seam is the poll's `drain` outcome, evaluated inside the poll's tenant
transaction, with the policy document read once before it.**
The document read happens in `poll()` *before* `runInTenant`, so the frozen body gains no
repository selection. The verdict is computed inside the body, where the locked,
authority-revalidated target's `kind` is already in hand — so the decision is made against the
same row the lease would have used, not a separately-read row that could differ. Cost: one
extra single-row primary-key read per poll, against a poll that already issues eight-plus
statements.

*Rejected:* a pre-authority gate in the route beside DEP-009's rate limiter. It is the closer
stylistic precedent, but the route holds no target row, so it would need **a second database
read** (the target) on top of the policy read, and it would decide against a row that the
authority chain had not yet revalidated.

**D2 — an unknown template refuses only when a template switch is actually present.**
Today `evaluateKillSwitches` validates `template` before scanning the document, so
`template: undefined` refuses every non-absent document. That is imprecise: if no switch names
the template dimension, the template value cannot change the verdict, so refusing is pure
loss. The validation moves into the scan and fires only for a `template` entry. Safety is
unchanged (an unevaluatable switch still refuses); precision improves.

Consequence, stated plainly and tested: **a template kill switch drains the entire fleet**,
because the control plane cannot tell which workers use which template (§1.2). That is
over-broad and *loud*, which beats narrow and *false*. The refusal carries a distinct reason,
`placement_unknown`, so the operator is told why rather than being handed a generic
`policy_unreadable`.

**D3 — the document lives in a new nullable `instance_settings.kill_switches` jsonb column,
with a table-level `SELECT` grant to `aoa_app`.**
- A dedicated column is immune to §1.3's normalizer erasure by construction — no carve-out
  constant to remember, no future Settings refactor that eats the policy.
- **Nullable with NO default.** A `DEFAULT '{}'::jsonb` would be a plain object whose
  `schema` is not `1`, which `evaluateKillSwitches` correctly treats as *unreadable* — i.e.
  the column default alone would drain every fleet on every install. SQL `NULL` is the absent
  document, which is the permitted steady state. This is a real trap and gets its own test.
- Table-level rather than column-level grant, following the reviewed reasoning in
  `0259_provider_credentials_app_select.sql`: column-level exists to keep a *writeable,
  worker-owned* table narrow and carries its own allow-list constant plus a
  `has_column_privilege` pass; "adding a second such mechanism for a read-only lookup would be
  more machinery, not less exposure". `instance_settings` stores no secret — its `general` and
  `experimental` bags hold UI flags, a feedback-sharing preference, a retention policy and
  migration snapshots.

**D4 — a read failure is not an absent document, and it is routed through the single
unreadable path.**
`document === undefined | null` means "no policy has ever been set", which is every fresh
install and must not stop work. A failed *read* is a different fact. The reader returns an
exported `KILL_SWITCH_POLICY_UNREADABLE` sentinel that is deliberately not a plain object, so
the existing `isPlainObject` guard refuses it. One decision site, not two — a second
hand-written verdict beside the function would be a second thing to keep correct.

**D5 — a drain carrying `retryAfterMs` is a reversible pause; `retryAfterMs: null` stays
terminal.**
The frozen protocol already models this (`retryAfterMs: nonNegativeIntSchema.nullable()`); only
the daemon collapses both into a terminal stop. Split them: a paused worker drains in-flight
work, sleeps the server's cadence, and resumes polling. The kill switch sends a non-null hint,
so lifting a switch restores the fleet within one cadence with no restart. The operator-issued
local `drain` CLI command and shutdown path are untouched — they set `stopLeasing()` directly
and never travel through a poll response.

**D6 — a `provider` switch whose value is outside the closed placement-provider vocabulary is
refused.**
The module already refuses an unknown `dimension` because "`providers` for `provider` is
exactly the shape of an operator typo, and ignoring it means the switch they just threw does
nothing at all". The identical argument applies to a mistyped `value`: `E2B` or `e2b-prod`
matches nothing and silently permits. The vocabulary is **passed in** so the module stays
dependency-free, and it is *derived* from the existing `TARGET_KIND_BY_CLASS` map so it cannot
drift from the kinds the resolver accepts.

The *observed* provider is deliberately **not** required to be a member: an unrecognized
`execution_targets.kind` is an enrollment problem that `normalizePlacementRegistryTarget`
already fails closed on a few lines later, and coupling the kill switch to it would widen this
change into placement validation.

**D7 — a drained poll still touches worker liveness.**
`touchWorkerLeaseProfile` runs before the kill check. A drained worker is alive and
authorized; drain is a policy answer, not a liveness statement, and suppressing the touch
would make a paused fleet look dead to every heartbeat-age guard.

---

## 3. Invariants

| # | Invariant | Proven by |
|---|---|---|
| I1 | A killed provider stops NEW leases: the poll answers `drain`, no `leases` row is created | integration (real poll path) |
| I2 | An absent document (row missing, or `kill_switches IS NULL`) permits | unit + integration |
| I3 | The column's own default cannot kill: the column is nullable with no default, and `{}` is refused | schema test + unit |
| I4 | A failed policy read refuses — it is never expressible as an absent document | unit (sentinel) + reader unit |
| I5 | A template switch refuses (drains) rather than silently permitting; a document with only provider switches evaluates normally despite an unknown template | unit |
| I6 | A provider switch naming a value outside the closed vocabulary refuses | unit |
| I7 | A kill switch does not revoke targets, and JOB-007 revocation does not kill providers | separation test, both directions |
| I8 | A drain with `retryAfterMs` resumes polling; a drain with `null` stays terminal | daemon unit |
| I9 | The kill check adds no repository selection to the frozen poll authority chain | `job-leasing-contract.test.ts` stays green with only reviewed allow-list additions |
| I10 | The JOB-003 contract guard still refuses an *unreviewed* call in the tenant body after the allow-list is widened | mutation test on the contract guard |
| I11 | `aoa_app` can actually read the document at runtime | integration under the `aoa_app` role; startup authority assertion |
| I12 | **In-flight work survives the switch**: a lease offered before a switch is thrown can still be ACKed and renewed | integration, two cases (see §5 Task 6) |

Every guard is mutation-tested before the lane lands.

**On I12 — added by the plan review, and it is not padding.** The plan originally proved
only "no NEW lease". Clause 3a's other half, "in-flight work finishes rather than being
orphaned", holds today purely because `ack` (`job-leasing.ts`) and renewal
(`job-fencing.ts`) are separate code paths that nobody added a kill check to. A property that
holds by omission is the *vacuously true* class this programme has been bitten by four times.
It gets a test.

---

## 4. File structure

| File | Change | Responsibility |
|---|---|---|
| `packages/db/src/schema/instance_settings.ts` | modify | add nullable `killSwitches` jsonb column |
| `packages/db/src/migrations/0260_*.sql` | create (drizzle) | `ADD COLUMN IF NOT EXISTS kill_switches jsonb` (C14 guard hand-appended) |
| `packages/db/src/migrations/0261_instance_settings_app_select.sql` | create (hand, C14) | `REVOKE ALL … FROM PUBLIC` + `GRANT SELECT … TO aoa_app` |
| `server/src/db/job-control-legacy-grants.ts` | modify | 3 manifest entries (grants, plan-derived relation ACL, ACL-nullness) |
| `server/src/__tests__/job-control-legacy-grants.contract.test.ts` | modify | the 2 independent hand-transcribed copies |
| `server/src/services/execution-kill-switches.ts` | modify | D2 + D6 precision |
| `server/src/services/execution-kill-switch-policy.ts` | create | the `aoa_app` reader + the unreadable sentinel |
| `server/src/services/execution-target-resolver.ts` | modify | export `EXECUTION_TARGET_KINDS`, derived from `TARGET_KIND_BY_CLASS` |
| `server/src/services/job-leasing.ts` | modify | read the policy before the tx; emit `drain` inside it |
| `server/src/routes/worker-control.ts` | modify | inject the reader into `createJobLeasingService` |
| `server/src/__tests__/job-leasing-contract.test.ts` | modify | register `evaluateKillSwitches` as a reviewed call |
| `packages/worker-daemon/src/poll/poll-loop.ts` | modify | D5 resumable drain |
| `docker/d1/campaign.env` | modify | nonce bump — this changes runtime behaviour on the `server/src` path |

---

## 5. Tasks

### Task 1 — export the closed placement-provider vocabulary

**Files:** modify `server/src/services/execution-target-resolver.ts`; test
`server/src/__tests__/execution-target-kinds.test.ts` (create).

- [ ] **Step 1: write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { EXECUTION_TARGET_KINDS } from "../services/execution-target-resolver.js";

describe("EXECUTION_TARGET_KINDS", () => {
  it("is the closed placement-provider vocabulary, sorted and deduped", () => {
    expect([...EXECUTION_TARGET_KINDS]).toEqual([
      "desktop", "dedicated_worker", "e2b", "local_host", "pooled_gvisor",
    ].sort());
  });

  it("is DERIVED from TARGET_KIND_BY_CLASS, so it cannot drift from what the resolver accepts", () => {
    // Non-vacuity: every kind the resolver will map must be offerable as a kill-switch value.
    for (const kind of EXECUTION_TARGET_KINDS) {
      expect(typeof kind).toBe("string");
      expect(kind.length).toBeGreaterThan(0);
    }
    expect(new Set(EXECUTION_TARGET_KINDS).size).toBe(EXECUTION_TARGET_KINDS.length);
  });
});
```

- [ ] **Step 2: run it and watch it fail**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/execution-target-kinds.test.ts`
Expected: FAIL — `EXECUTION_TARGET_KINDS` is not exported.

- [ ] **Step 3: implement**

In `server/src/services/execution-target-resolver.ts`, immediately after
`TARGET_KIND_BY_CLASS`:

```ts
/**
 * The closed placement-provider vocabulary, DERIVED from the class map above so it cannot
 * drift from the kinds normalization will accept. REL-004 Lane C (D6) passes this to
 * `evaluateKillSwitches` so a mistyped switch value is refused rather than silently matching
 * nothing.
 */
export const EXECUTION_TARGET_KINDS: readonly string[] = Object.freeze(
  [...new Set(Object.values(TARGET_KIND_BY_CLASS).flatMap((kinds) => [...kinds]))].sort(),
);
```

- [ ] **Step 4: run it and watch it pass**

Run: same command. Expected: PASS 2/2.

- [ ] **Step 5: commit**

```bash
git add server/src/services/execution-target-resolver.ts server/src/__tests__/execution-target-kinds.test.ts
git commit -m "feat(rel-004): derive the closed placement-provider vocabulary from the class map"
```

---

### Task 2 — D2 + D6 precision in the decision function

**Files:** modify `server/src/services/execution-kill-switches.ts`; modify
`server/src/__tests__/execution-kill-switches.test.ts`.

- [ ] **Step 1: write the failing tests**

Append to the existing suite (the existing 16 cases stay green — they are the non-vacuity
base). `placement` gains `knownProviders`:

```ts
const KNOWN = ["desktop", "dedicated_worker", "e2b", "local_host", "pooled_gvisor"];

describe("REL-004 Lane C/D2 — an unknown template refuses ONLY when a template switch exists", () => {
  it("evaluates a provider-only document normally when the template is UNKNOWN", () => {
    // The control plane holds no template fact for a distributed worker; refusing here
    // would drain e2b workers because someone killed pooled_gvisor.
    expect(evaluateKillSwitches({
      document: doc([{ dimension: "provider", value: "pooled_gvisor", reason: "incident" }]),
      provider: "e2b",
      template: undefined,
      knownProviders: KNOWN,
    })).toEqual({ killed: false });
  });

  it("still kills a matching provider switch when the template is UNKNOWN", () => {
    expect(evaluateKillSwitches({
      document: doc([{ dimension: "provider", value: "e2b", reason: "incident" }]),
      provider: "e2b",
      template: undefined,
      knownProviders: KNOWN,
    })).toEqual({ killed: true, dimension: "provider", value: "e2b", reason: "incident" });
  });

  it("REFUSES a template switch when the template is UNKNOWN, naming the reason", () => {
    // Over-broad and loud beats narrow and false: a silent no-op would tell an operator a
    // compromised template was blocked when nothing was checked.
    expect(evaluateKillSwitches({
      document: doc([{ dimension: "template", value: "aoa-base", reason: "cve" }]),
      provider: "e2b",
      template: undefined,
      knownProviders: KNOWN,
    })).toEqual({ killed: true, dimension: null, value: null, reason: "placement_unknown" });
  });

  it("still evaluates a template switch normally when the template IS known", () => {
    expect(evaluateKillSwitches({
      document: doc([{ dimension: "template", value: "aoa-base", reason: "cve" }]),
      provider: "e2b",
      template: "aoa-base",
      knownProviders: KNOWN,
    })).toEqual({ killed: true, dimension: "template", value: "aoa-base", reason: "cve" });
  });

  it("permits a non-matching template switch when the template is DEFINITELY NONE", () => {
    expect(evaluateKillSwitches({
      document: doc([{ dimension: "template", value: "aoa-base", reason: "cve" }]),
      provider: "pooled_gvisor",
      template: null,
      knownProviders: KNOWN,
    })).toEqual({ killed: false });
  });

  it("refuses a template that is neither a string, null, nor undefined, only when scanned", () => {
    expect(evaluateKillSwitches({
      document: doc([{ dimension: "template", value: "aoa-base", reason: "cve" }]),
      provider: "e2b",
      template: 7,
      knownProviders: KNOWN,
    })).toEqual({ killed: true, dimension: null, value: null, reason: "policy_unreadable" });
  });
});

describe("REL-004 Lane C/D6 — a provider value outside the closed vocabulary is refused", () => {
  it("refuses a mistyped provider value rather than matching nothing", () => {
    expect(evaluateKillSwitches({
      document: doc([{ dimension: "provider", value: "E2B", reason: "incident" }]),
      provider: "e2b",
      template: null,
      knownProviders: KNOWN,
    })).toEqual({ killed: true, dimension: null, value: null, reason: "policy_unreadable" });
  });

  it("refuses when the vocabulary itself is missing or malformed", () => {
    for (const knownProviders of [undefined, null, [], "e2b", [""], [1]]) {
      expect(evaluateKillSwitches({
        document: doc([{ dimension: "provider", value: "e2b", reason: "incident" }]),
        provider: "e2b",
        template: null,
        knownProviders,
      })).toEqual({ killed: true, dimension: null, value: null, reason: "policy_unreadable" });
    }
  });

  it("does NOT require the OBSERVED provider to be in the vocabulary", () => {
    // An unrecognized execution_targets.kind is an enrollment fault that
    // normalizePlacementRegistryTarget fails closed on; it is not a kill-switch question.
    expect(evaluateKillSwitches({
      document: doc([{ dimension: "provider", value: "e2b", reason: "incident" }]),
      provider: "some_legacy_kind",
      template: null,
      knownProviders: KNOWN,
    })).toEqual({ killed: false });
  });

  it("leaves the vocabulary irrelevant to a template switch", () => {
    expect(evaluateKillSwitches({
      document: doc([{ dimension: "template", value: "anything-at-all", reason: "cve" }]),
      provider: "e2b",
      template: "anything-at-all",
      knownProviders: KNOWN,
    })).toEqual({ killed: true, dimension: "template", value: "anything-at-all", reason: "cve" });
  });
});
```

Also update the shared `placement` helper in the existing suite to
`const placement = { provider: "e2b", template: "aoa-base", knownProviders: KNOWN };`
so the 16 pre-existing cases keep passing unchanged.

- [ ] **Step 2: run and watch it fail**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/execution-kill-switches.test.ts`
Expected: FAIL — the new cases return `policy_unreadable`/`{killed:false}` at the wrong times.

- [ ] **Step 3: implement**

In `execution-kill-switches.ts`:

```ts
export interface KillSwitchInput {
  readonly document: unknown;
  readonly provider: unknown;
  /**
   * The pinned sandbox template alias.
   *
   * `null` means DEFINITELY NONE. `undefined` means UNKNOWN — the caller could not determine
   * it — and is fail-closed, but ONLY against a switch that actually names the template
   * dimension (D2): a template it cannot read cannot change the verdict of a provider switch.
   */
  readonly template: unknown;
  /**
   * The closed placement-provider vocabulary (D6). A `provider` switch naming a value outside
   * it is an operator typo and is REFUSED, never silently unmatched. Passed in so this module
   * stays dependency-free; the caller derives it from `TARGET_KIND_BY_CLASS`.
   */
  readonly knownProviders: unknown;
}

function unreadable(): KillSwitchVerdict {
  return { killed: true, dimension: null, value: null, reason: "policy_unreadable" };
}

/** A switch this caller structurally cannot evaluate. Distinct from a malformed document so
 *  the operator is told which of the two happened. */
function unevaluatable(): KillSwitchVerdict {
  return { killed: true, dimension: null, value: null, reason: "placement_unknown" };
}
```

and in `evaluateKillSwitches`, replace the pre-scan template validation with per-entry checks:

```ts
  if (typeof provider !== "string" || provider.length === 0) return unreadable();
  // The vocabulary is required whenever a document exists: without it a mistyped provider
  // value cannot be told from a real one.
  if (!Array.isArray(knownProviders) || knownProviders.length === 0 ||
      knownProviders.some((kind) => typeof kind !== "string" || kind.length === 0)) {
    return unreadable();
  }

  for (const entry of document.switches) {
    if (!isPlainObject(entry)) return unreadable();
    const { dimension, value, reason } = entry;
    if (typeof dimension !== "string"
        || !(KILL_SWITCH_DIMENSIONS as readonly string[]).includes(dimension)) {
      return unreadable();
    }
    if (typeof value !== "string" || value.length === 0) return unreadable();
    if (!isStatedReason(reason)) return unreadable();

    if (dimension === "provider") {
      // D6 — a value outside the closed vocabulary is a typo, not a miss.
      if (!(knownProviders as readonly string[]).includes(value)) return unreadable();
      if (provider === value) {
        return { killed: true, dimension: "provider", value, reason };
      }
      continue;
    }

    // D2 — the template checks happen HERE, so an unknown template only refuses a document
    // that actually names the template dimension.
    if (template === undefined) return unevaluatable();
    if (template !== null && typeof template !== "string") return unreadable();
    if (template !== null && template === value) {
      return { killed: true, dimension: "template", value, reason };
    }
  }

  return { killed: false };
```

- [ ] **Step 4: run and watch it pass**

Run: same command. Expected: PASS (16 pre-existing + 10 new).

- [ ] **Step 5: mutation-test the decision function**

For each mutant, apply, run the suite, revert. Every one must be KILLED, or documented as an
equivalent mutant with the reason.

| # | Mutation | Must be killed by |
|---|---|---|
| M1 | `if (dimension === "provider")` → `!==` | provider kill case |
| M2 | drop the `knownProviders.includes(value)` refusal | mistyped-provider case |
| M3 | `knownProviders.length === 0` → `< 0` | empty-vocabulary case |
| M4 | `template === undefined` → `template == null` | DEFINITELY-NONE permits case |
| M5 | `unevaluatable()` → `unreadable()` | reason-string assertion |
| M6 | `unevaluatable()` → `{ killed: false }` | template-unknown refusal case |
| M7 | move the `template === undefined` check back above the loop | provider-only-with-unknown-template case |
| M8 | `continue` after a non-matching provider → `return { killed: false }` | a two-entry document where the second entry matches |
| M9 | `provider === value` → `provider.startsWith(value)` | existing prefix case |
| M10 | drop `if (typeof value !== "string" ...)` | existing malformed-value case |

Note M8 requires a two-entry case; add it if the existing suite lacks one.

- [ ] **Step 6: commit**

```bash
git add server/src/services/execution-kill-switches.ts server/src/__tests__/execution-kill-switches.test.ts
git commit -m "feat(rel-004): refuse only evaluatable dimensions and mistyped provider values"
```

---

### Task 3 — the `kill_switches` column

**Files:** modify `packages/db/src/schema/instance_settings.ts`; create
`packages/db/src/migrations/0260_*.sql`; test
`server/src/__tests__/instance-settings-kill-switches-schema.test.ts` (create).

- [ ] **Step 1: write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { instanceSettings } from "@armyofagents/db";

describe("REL-004 Lane C/I3 — the kill-switch column cannot kill by default", () => {
  it("exposes a kill_switches jsonb column", () => {
    const column = getTableColumns(instanceSettings).killSwitches;
    expect(column).toBeDefined();
    expect(column.name).toBe("kill_switches");
    expect(column.dataType).toBe("json");
  });

  it("is NULLABLE with NO default", () => {
    // A DEFAULT '{}' would be a plain object whose `schema` is not 1 — which
    // evaluateKillSwitches correctly reads as UNREADABLE, draining every fleet on every
    // install. SQL NULL is the absent document, which is the permitted steady state.
    const column = getTableColumns(instanceSettings).killSwitches;
    expect(column.notNull).toBe(false);
    expect(column.hasDefault).toBe(false);
  });
});
```

- [ ] **Step 2: run and watch it fail**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/instance-settings-kill-switches-schema.test.ts`
Expected: FAIL — `killSwitches` is undefined.

- [ ] **Step 3: implement the schema change**

In `packages/db/src/schema/instance_settings.ts`, inside the column list after `experimental`:

```ts
    /**
     * REL-004 Lane C — the provider/template kill-switch policy document, read on the worker
     * poll path by `aoa_app` (grant: migration 0261).
     *
     * DELIBERATELY nullable with NO default. SQL NULL is "no policy has ever been set", the
     * permitted steady state of every fresh install. A `DEFAULT '{}'::jsonb` would be a
     * document that EXISTS and cannot be understood, which `evaluateKillSwitches` refuses —
     * i.e. the default alone would drain every fleet. It is also NOT stored inside `general`,
     * because `instanceSettingsService.updateGeneral` rewrites that bag from a fixed field
     * list and would erase an unknown key on the next Settings PATCH.
     */
    killSwitches: jsonb("kill_switches").$type<Record<string, unknown>>(),
```

- [ ] **Step 4: generate the migration**

```bash
pnpm --filter @armyofagents/db build && pnpm db:generate
```

Expected: a new `packages/db/src/migrations/0260_<name>.sql` containing
`ALTER TABLE "instance_settings" ADD COLUMN "kill_switches" jsonb;` and a matching
`_journal.json` entry. **Never hand-author the DDL** — only the C14 guard below is appended.

- [ ] **Step 5: hand-append the C14 idempotency guard**

Edit the generated file so the statement reads:

```sql
-- C14: drizzle-kit cannot emit an idempotency guard; ADD COLUMN IF NOT EXISTS is idempotent.
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "kill_switches" jsonb;
```

- [ ] **Step 6: run the test and the idempotency lanes**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/instance-settings-kill-switches-schema.test.ts`
Expected: PASS 2/2.

- [ ] **Step 7: commit**

```bash
git add packages/db/src/schema/instance_settings.ts packages/db/src/migrations server/src/__tests__/instance-settings-kill-switches-schema.test.ts
git commit -m "feat(rel-004): add the nullable instance_settings.kill_switches policy column"
```

---

### Task 4 — the `aoa_app` SELECT grant and its five manifest couplings

**Files:** create `packages/db/src/migrations/0261_instance_settings_app_select.sql`; modify
`server/src/db/job-control-legacy-grants.ts` (3 sites); modify
`server/src/__tests__/job-control-legacy-grants.contract.test.ts` (2 sites).

A grant without a manifest entry, or a manifest entry without the grant, throws
`distributed_execution_app_authority` and **both replicas refuse to start**. All six edits land
in one commit.

- [ ] **Step 1: write the failing test**

Append to `server/src/__tests__/job-control-legacy-grants.contract.test.ts`:

```ts
describe("REL-004 Lane C/I11 — instance_settings is reachable by aoa_app", () => {
  it("grants exactly SELECT to aoa_app and nothing to aoa_operator", () => {
    expect(appTablePrivileges().instance_settings).toEqual(["SELECT"]);
    expect(operatorTablePrivileges().instance_settings).toBeUndefined();
  });

  it("appears in the app serving inventory", () => {
    expect(APP_SERVING_RELATIONS).toContain("instance_settings");
  });

  it("carries no RLS — it is an instance singleton with no organization column", () => {
    expect(RLS_RELATIONS).not.toContain("instance_settings");
    expect(POLICY_COUNTS).not.toHaveProperty("instance_settings");
  });
});
```

(The file's existing plan-derived-matrix parity assertions will independently fail until both
hand-transcribed copies are updated — that is the point of the independent copies.)

- [ ] **Step 2: run and watch it fail**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-control-legacy-grants.contract.test.ts`
Expected: FAIL — `appTablePrivileges().instance_settings` is undefined.

- [ ] **Step 3: add the grant manifest entries**

In `server/src/db/job-control-legacy-grants.ts`, in `JOB_CONTROL_LEGACY_GRANTS` beside
`provider_credentials`:

```ts
  // REL-004 Lane C — the provider/template kill-switch policy document. The worker poll reads
  // `instance_settings.kill_switches` on the aoa_app pool BEFORE opening the lease transaction;
  // without this grant the read fails at RUNTIME with permission denied, not at compile time.
  // Table-level for the reason 0259 records: the column-level form exists to keep a WRITEABLE,
  // worker-owned table narrow and carries its own allowlist plus a has_column_privilege pass.
  // Exposure verified, not assumed: instance_settings stores NO secret — UI flags, a
  // feedback-sharing preference, a retention policy, and migration snapshots.
  instance_settings: ["SELECT"],
```

In `PLAN_DERIVED_ACL_MATRIX.relations` (production copy):

```ts
    instance_settings: { aoa_app: ["SELECT"], aoa_operator: [] },
```

In `RELATION_ACL_NULLNESS_CERTIFICATE`:

```ts
  instance_settings: false,
```

- [ ] **Step 4: mirror both hand-transcribed copies in the contract test**

In `server/src/__tests__/job-control-legacy-grants.contract.test.ts`, add to its own
`PLAN_DERIVED_ACL_MATRIX.relations`:

```ts
    // REL-004 Lane C — read-only kill-switch policy lookup on the poll path (migration 0261).
    instance_settings: { aoa_app: ["SELECT"], aoa_operator: [] },
```

and to `PLAN_DERIVED_RELATION_ACL_NULLNESS`:

```ts
  instance_settings: false,
```

- [ ] **Step 5: write the migration**

Create `packages/db/src/migrations/0261_instance_settings_app_select.sql`:

```sql
-- REL-004 Lane C (clause 3a) custom security DDL. drizzle-kit cannot express role grants;
-- every statement below is naturally idempotent per C14.
--
-- WHY. The worker poll must know whether placement on this target's provider has been killed
-- before it offers a lease. It reads `instance_settings.kill_switches` on the NON-OWNER
-- `aoa_app` pool (NOSUPERUSER / NOBYPASSRLS), and `instance_settings` has never had an
-- `aoa_app` grant of any kind. `assertExactServingRoleAuthority` enforces EXACT ACLs across
-- every non-system table, so today the role holds ZERO privileges on it and the read would
-- fail at RUNTIME.
--
-- WHY TABLE-LEVEL, NOT COLUMN-LEVEL. Mirrors 0259 (`provider_credentials`) and
-- `company_memberships` (0214): the column-level form used for `execution_targets` (0221)
-- exists to keep a WRITEABLE, worker-owned table narrow and carries a bespoke column-allowlist
-- constant plus a separate `has_column_privilege` assertion pass. A second such mechanism for
-- a read-only singleton lookup would be more machinery, not less exposure.
--
-- The exposure is proportionate and was verified rather than assumed: `instance_settings`
-- stores NO secret. Its columns are id, singleton_key, general, experimental, kill_switches and
-- timestamps; `general`/`experimental` hold UI flags, a feedback-sharing preference, a backup
-- retention policy, and migration snapshots.
--
-- NO RLS POLICY. The table is an instance singleton with no organization column, and it is
-- absent from RLS_RELATIONS. `assertExactCatalogCertificate` enumerates every relation with
-- row security enabled and requires exact equality with that list, so enabling RLS here would
-- itself be the drift.
--
-- MANIFEST COUPLING — this file alone is not enough, and getting it wrong is a BOOT CRASH
-- rather than a test failure. The matching entries land in the same commit:
--   - JOB_CONTROL_LEGACY_GRANTS            (server/src/db/job-control-legacy-grants.ts)
--   - PLAN_DERIVED_ACL_MATRIX.relations    (same file, production copy)
--   - RELATION_ACL_NULLNESS_CERTIFICATE    (same file)
--   - PLAN_DERIVED_ACL_MATRIX              (the INDEPENDENT copy in the contract test)
--   - PLAN_DERIVED_RELATION_ACL_NULLNESS   (a third hand-transcribed list, same test)

-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; REVOKE is idempotent.
REVOKE ALL ON "instance_settings" FROM PUBLIC;
--> statement-breakpoint
-- C14 hand-authored security DDL: drizzle-kit cannot emit this statement; GRANT is idempotent.
GRANT SELECT ON "instance_settings" TO "aoa_app";
```

Add the matching `_journal.json` entry (tag `0261_instance_settings_app_select`), following the
exact shape of the `0259` entry.

- [ ] **Step 6: run and watch it pass**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/job-control-legacy-grants.contract.test.ts`
Expected: PASS.

- [ ] **Step 7: mutation-test the manifest coupling**

| # | Mutation | Must be killed by |
|---|---|---|
| M11 | remove `instance_settings` from `JOB_CONTROL_LEGACY_GRANTS` only | plan-derived parity assertion |
| M12 | remove it from the production `PLAN_DERIVED_ACL_MATRIX` only | the same parity assertion, other direction |
| M13 | change the contract test's copy to `["SELECT","INSERT"]` | parity assertion |
| M14 | remove the `RELATION_ACL_NULLNESS_CERTIFICATE` entry | `Missing PostgreSQL 18 relacl nullness certificate` throw |

- [ ] **Step 8: commit**

```bash
git add packages/db/src/migrations server/src/db/job-control-legacy-grants.ts server/src/__tests__/job-control-legacy-grants.contract.test.ts
git commit -m "feat(rel-004): grant aoa_app SELECT on instance_settings for the kill-switch read"
```

---

### Task 5 — the policy reader

**Files:** create `server/src/services/execution-kill-switch-policy.ts`; create
`server/src/__tests__/execution-kill-switch-policy.test.ts`.

- [ ] **Step 1: write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import {
  KILL_SWITCH_POLICY_UNREADABLE,
  createKillSwitchPolicyReader,
} from "../services/execution-kill-switch-policy.js";
import { evaluateKillSwitches } from "../services/execution-kill-switches.js";

const KNOWN = ["e2b", "pooled_gvisor"];

function dbReturning(rows: unknown[] | (() => never)) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (typeof rows === "function" ? rows() : rows),
        }),
      }),
    }),
  } as never;
}

describe("REL-004 Lane C/I2+I4 — reading the kill-switch policy", () => {
  it("maps a MISSING singleton row to an absent document", async () => {
    const reader = createKillSwitchPolicyReader({ appDb: dbReturning([]) });
    expect(await reader.read()).toBeUndefined();
  });

  it("maps a NULL column to an absent document", async () => {
    const reader = createKillSwitchPolicyReader({ appDb: dbReturning([{ killSwitches: null }]) });
    expect(await reader.read()).toBeUndefined();
  });

  it("returns the stored document verbatim", async () => {
    const document = { schema: 1, switches: [] };
    const reader = createKillSwitchPolicyReader({ appDb: dbReturning([{ killSwitches: document }]) });
    expect(await reader.read()).toEqual(document);
  });

  it("maps a READ FAILURE to the unreadable sentinel, NOT to an absent document", async () => {
    const reader = createKillSwitchPolicyReader({
      appDb: dbReturning(() => { throw new Error("connection reset"); }),
    });
    expect(await reader.read()).toBe(KILL_SWITCH_POLICY_UNREADABLE);
  });

  it("the sentinel is refused by the ONE unreadable path in the decision function", async () => {
    // The whole point of the sentinel: a failed read must not be expressible as "no policy".
    expect(evaluateKillSwitches({
      document: KILL_SWITCH_POLICY_UNREADABLE,
      provider: "e2b",
      template: null,
      knownProviders: KNOWN,
    })).toEqual({ killed: true, dimension: null, value: null, reason: "policy_unreadable" });
  });

  it("an absent document permits — a fresh install is not a stopped fleet", async () => {
    const reader = createKillSwitchPolicyReader({ appDb: dbReturning([]) });
    expect(evaluateKillSwitches({
      document: await reader.read(),
      provider: "e2b",
      template: null,
      knownProviders: KNOWN,
    })).toEqual({ killed: false });
  });
});
```

- [ ] **Step 2: run and watch it fail**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/execution-kill-switch-policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: implement**

```ts
// server/src/services/execution-kill-switch-policy.ts
//
// REL-004 Lane C — the `aoa_app` read of the kill-switch policy document.
//
// Read OUTSIDE a tenant transaction: `instance_settings` is an instance singleton with no
// organization column and no RLS, so a tenant context would add a SET LOCAL and mean nothing.
// This mirrors MIG-008's app-side read of `legacy_resource_reconciliation`.
//
// A FAILED READ IS NOT AN ABSENT DOCUMENT. "No policy has ever been set" is the steady state of
// every fresh install and must not stop work; "I could not load the policy" is the case a kill
// switch exists for. The two are kept apart by returning a sentinel that is deliberately NOT a
// plain object, so `evaluateKillSwitches` refuses it through its single unreadable path rather
// than through a second, hand-written verdict here.

import { eq } from "drizzle-orm";
import { instanceSettings, type Db } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";

export const KILL_SWITCH_POLICY_UNREADABLE: unique symbol = Symbol(
  "kill-switch-policy-unreadable",
);

const SINGLETON_KEY = "default";

export interface KillSwitchPolicyReader {
  /** The stored document, `undefined` when none has ever been set, or the unreadable sentinel. */
  read(): Promise<unknown>;
}

export function createKillSwitchPolicyReader(input: { appDb: Db }): KillSwitchPolicyReader {
  return {
    async read(): Promise<unknown> {
      try {
        const rows = await input.appDb
          .select({ killSwitches: instanceSettings.killSwitches })
          .from(instanceSettings)
          .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
          .limit(1);
        return rows[0]?.killSwitches ?? undefined;
      } catch {
        logger.error({
          action: "execution.kill_switch.policy_read_failed",
          reasonCode: "kill_switch_policy_unreadable",
        }, "kill-switch policy unreadable");
        return KILL_SWITCH_POLICY_UNREADABLE;
      }
    },
  };
}
```

- [ ] **Step 4: run and watch it pass**

Run: same command. Expected: PASS 6/6.

- [ ] **Step 5: mutation-test the reader**

| # | Mutation | Must be killed by |
|---|---|---|
| M15 | `catch { return undefined; }` | the read-failure case |
| M16 | `catch { throw error; }` | the read-failure case (rejects instead of resolving) |
| M17 | `rows[0]?.killSwitches ?? undefined` → `rows[0]?.killSwitches ?? {}` | absent-document-permits case |
| M18 | drop the `.where(eq(singletonKey, ...))` | a two-row fixture where the non-default row carries a switch |
| M19 | `KILL_SWITCH_POLICY_UNREADABLE` → `{}` (a plain object) | sentinel-refused case still passes, so ALSO assert `read()` returns the exported symbol identity |

M19 is the reason the test asserts `toBe(KILL_SWITCH_POLICY_UNREADABLE)` and not merely that
the verdict is `policy_unreadable`.

- [ ] **Step 6: commit**

```bash
git add server/src/services/execution-kill-switch-policy.ts server/src/__tests__/execution-kill-switch-policy.test.ts
git commit -m "feat(rel-004): read the kill-switch policy on the aoa_app pool, fail-closed"
```

---

### Task 6 — emit `drain` from the poll

**Files:** modify `server/src/services/job-leasing.ts`; modify
`server/src/routes/worker-control.ts`; modify `server/src/__tests__/job-leasing-contract.test.ts`.

- [ ] **Step 1: write the failing integration test**

Create `server/src/__tests__/execution-kill-switch-poll.integration.test.ts`. **Reuse the
existing harness rather than reinventing it** — copy the fixture scaffolding from
`server/src/__tests__/job-leasing.integration.test.ts`, which already provides everything
needed: `const integration = describe.skipIf(...)` (line 60), `allocateEmbeddedPgPort`
(`./helpers/embedded-pg-port.js`), `provisionTenantAppRoleLoginSql` (`../db/rls-tenant.js`),
`applyPendingMigrations`, `runInTenant`, `createJobControlRepository`, and the
`providerProfile` / `registeredProfile` / `workerHello` / `pollRequest` / `ackRequest`
builders plus the `ORG` / `COMPANY` / `TARGET` / `WORKER` UUID constants.

It must exercise the REAL poll — not the decision function — per handoff §4 clause 1, and the
service must be constructed with a real `createKillSwitchPolicyReader({ appDb })`, not a stub.

```ts
// Cases 1-7 each assert BOTH the poll response and the presence/absence of a `leases` row.
//  1. no document (kill_switches IS NULL)  -> "offer", a lease row exists
//  2. a switch on a DIFFERENT provider     -> "offer", a lease row exists          (non-vacuity)
//  3. a switch on THIS target's kind       -> "drain", reason = the stated reason,
//                                             retryAfterMs = KILL_SWITCH_DRAIN_RETRY_AFTER_MS,
//                                             and NO new lease row
//  4. kill_switches = '{}'::jsonb          -> "drain", reason "policy_unreadable"
//  5. a template switch                    -> "drain", reason "placement_unknown"
//  6. after the switch is REMOVED          -> "offer" again, a lease row exists
//  7. I7 separation: none of the above changed execution_targets.status or
//     device_generation, and no execution_target_revocations row was written
//
// I12 — in-flight work finishes. These are the cases the plan review added.
//  8. offer a lease, THEN throw the switch, THEN ACK that lease
//        -> the ACK still succeeds (outcome "acknowledged"); the lease activates.
//           A kill switch stops PLACEMENT, not work that was already placed.
//  9. with the lease active and the switch still thrown, RENEW it
//        -> renewal still succeeds. Killing renewal would orphan the run inside the
//           sandbox and leave the attempt to the lease reaper — the opposite of "drains".
// 10. the SAME worker's next poll while the switch is thrown -> "drain"
//        (proves 8 and 9 are about the existing lease, not a hole in the gate)
```

- [ ] **Step 2: run and watch it fail**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/execution-kill-switch-poll.integration.test.ts`
Expected: FAIL — case 3 returns `offer`; nothing emits `drain`.

- [ ] **Step 3: implement the leasing change**

In `server/src/services/job-leasing.ts`:

```ts
import { EXECUTION_TARGET_KINDS, normalizePlacementRegistryTarget, ... } from "./execution-target-resolver.js";
import { evaluateKillSwitches } from "./execution-kill-switches.js";
import type { KillSwitchPolicyReader } from "./execution-kill-switch-policy.js";

/** A kill switch is a reversible PAUSE, not a shutdown: the hint is non-null so a drained
 *  worker resumes one cadence after the switch is lifted, with no restart. */
export const KILL_SWITCH_DRAIN_RETRY_AFTER_MS = 30_000;
```

`createJobLeasingService(input: { …; killSwitches?: KillSwitchPolicyReader })`.

At the top of `poll()`, before the `restartAttempt` loop and outside `runInTenant` — so the
frozen authority chain gains no repository selection.

**Verified during the plan review:** the JOB-003 contract guard constrains statements *after*
the restart loop (`statementsAfterLoop.length === 1`, the exhaustion throw) and the loop's own
shape, but places **no constraint on statements before the loop**
(`job-leasing-contract.test.ts:3079-3220`). A pre-loop `await` is therefore admissible.
If that reading turns out to be wrong at implementation time, the fallback — in order — is
(a) read it in `worker-control.ts` and pass it as a new key on the single `pollInput` object
(`pollMethod.parameters.length === 1` is asserted, so it must stay ONE parameter, but its keys
are not enumerated), then (b) stop and re-derive. Do not widen the guard to admit the read.

```ts
      // REL-004 clause 3a. Read once per poll, before the lease transaction. An absent reader
      // (a composition root that has not wired one) is UNREADABLE, never "no policy": a
      // missing stop button must not read as "nothing is stopped".
      const killSwitchDocument = input.killSwitches
        ? await input.killSwitches.read()
        : KILL_SWITCH_POLICY_UNREADABLE;
```

Inside the `runInTenant` body, immediately after `await repos.jobControl.touchWorkerLeaseProfile(touchContext);`
(D7 — a drained worker is alive) and before `normalizePlacementRegistryTarget`:

```ts
            // REL-004 clause 3a — a killed provider answers `drain`, so new leases stop while
            // in-flight work finishes. Evaluated HERE, against the locked and revalidated
            // target, and never inside evaluateStaticLeaseEligibility's loop: that loop writes
            // `static_requirements_mismatch` certificates and a kill switch is not a
            // requirements mismatch.
            const killVerdict = evaluateKillSwitches({
              document: killSwitchDocument,
              provider: guardedAuthority.currentTarget.kind,
              // Structurally UNKNOWN: no control-plane surface carries the sandbox template
              // (the E2B alias is pinned worker-side in packages/sandbox-e2b-provider and the
              // frozen hello/profile schemas have no field for it). `null` would be a lie that
              // silently no-ops every template switch.
              template: undefined,
              knownProviders: EXECUTION_TARGET_KINDS,
            });
            if (killVerdict.killed) {
              return pollResponseV1Schema.parse({
                protocolVersion: 1,
                correlationId: parsedRequest.correlationId,
                serverTime: databaseNow.toISOString(),
                outcome: "drain",
                retryAfterMs: KILL_SWITCH_DRAIN_RETRY_AFTER_MS,
                reason: killVerdict.reason,
              });
            }
```

In `server/src/routes/worker-control.ts`, wire the reader:

```ts
  const leasing = createJobLeasingService({
    appDb: opts.appDb,
    operatorDb: opts.operatorDb,
    scheduler: opts.jobReadyScheduler,
    metrics: opts.jobControlMetrics,
    // REL-004 clause 3a — the stop button. Wired at the composition root so the poll can
    // never silently run without one (an absent reader is treated as UNREADABLE).
    killSwitches: createKillSwitchPolicyReader({ appDb: opts.appDb }),
  });
```

- [ ] **Step 4: register the reviewed call in the JOB-003 contract guard**

`server/src/__tests__/job-leasing-contract.test.ts` will fail with
`binding:protected-value-escape` because `guardedAuthority` is a protected context name. Add
`evaluateKillSwitches` to **both** reviewed lists:

- `auditedProtectedCallPath`'s array, beside `evaluateStaticLeaseEligibility`;
- the `approvedContainer` parent-call list, beside `evaluateStaticLeaseEligibility` (the input
  is an object literal that references a protected value).

Add a comment at both sites naming REL-004 clause 3a and stating that the call is pure and adds
no repository selection.

- [ ] **Step 5: run and watch everything pass**

```bash
pnpm --filter @armyofagents/server exec vitest run src/__tests__/execution-kill-switch-poll.integration.test.ts src/__tests__/job-leasing-contract.test.ts src/__tests__/job-leasing.integration.test.ts
```

Expected: PASS. If `job-leasing-contract.test.ts` reports any violation other than the two
allow-list entries above, STOP: the change has moved something the contract protects, and the
right answer is to move the change, not to widen the guard further.

- [ ] **Step 6: mutation-test the wiring AND the widened guard**

| # | Mutation | Must be killed by |
|---|---|---|
| M20 | delete the whole `if (killVerdict.killed)` block | integration case 3 |
| M21 | `if (killVerdict.killed)` → `if (false)` | integration case 3 |
| M22 | `template: undefined` → `template: null` | integration case 5 |
| M23 | absent reader → `undefined` document instead of the sentinel | a unit case constructing the service with no `killSwitches` |
| M24 | `retryAfterMs: KILL_SWITCH_DRAIN_RETRY_AFTER_MS` → `null` | integration case 3 asserts the exact value; the daemon test (Task 7) asserts null is terminal |
| M25 | move the read INSIDE `runInTenant` as `repos.*` | `job-leasing-contract.test.ts` must fail — proves I9 |
| M26 | **guard mutation:** add an unreviewed call `Math.max(guardedAuthority.currentTarget.deviceGeneration, 1)` in the tenant body | `job-leasing-contract.test.ts` must STILL fail with `binding:protected-value-escape` — proves the widened allow-list did not disable the guard (I10) |

M26 is the one that matters most: widening an allow-list to admit your own change is exactly
how a guard is quietly retired.

- [ ] **Step 7: commit**

```bash
git add server/src/services/job-leasing.ts server/src/routes/worker-control.ts server/src/__tests__/
git commit -m "feat(rel-004): the poll answers drain when placement is killed (clause 3a)"
```

---

### Task 7 — the daemon honours a resumable drain

**Files:** modify `packages/worker-daemon/src/poll/poll-loop.ts`; modify
`packages/worker-daemon/src/__tests__/poll-loop*.test.ts` (the existing drain case) and add
cases.

- [ ] **Step 1: write the failing tests**

```ts
describe("REL-004 Lane C/I8 — a drain with a retry hint is a reversible PAUSE", () => {
  it("stops permanently when retryAfterMs is NULL (operator drain)", async () => {
    // poll #1 -> drain{retryAfterMs:null}; assert run() resolves "drained" and polled once.
  });

  it("drains in-flight work, sleeps the hint, and RESUMES polling when retryAfterMs is set", async () => {
    // poll #1 -> drain{retryAfterMs:30000}; poll #2 -> no_work; poll #3 -> offer.
    // Assert: >=3 polls, an offer was ACKed on poll #3, and run() does NOT resolve "drained".
    //
    // The observed sleep is NOT 30000 unless the fixture's backoff.maxMs allows it.
    // `cadenceSleep` (poll-loop.ts:502-507) clamps every honored delay into
    // [min(baseMs, maxMs), maxMs], so assert the CLAMP, not the literal:
    //   expect(sleptMs).toBe(Math.max(Math.min(30_000, backoff.maxMs), Math.min(backoff.baseMs, backoff.maxMs)))
    // Also run one fixture with maxMs > 30_000 so the un-clamped path is covered too —
    // otherwise a mutant that hardcodes the cap would survive.
  });

  it("finishes in-flight handoffs BEFORE resuming", async () => {
    // A slow in-flight handoff must settle before the next poll is issued.
  });

  it("does not leak an offer that arrives while paused", async () => {
    // Existing offer-drop behaviour under stopLeasing() must be unchanged.
  });
});
```

- [ ] **Step 2: run and watch it fail**

Run: `pnpm --filter @armyofagents/worker-daemon exec vitest run src/__tests__/poll-loop.test.ts`
Expected: FAIL — the resumable case sees exactly one poll and `"drained"`.

- [ ] **Step 3: implement**

Replace the drain branch in `packages/worker-daemon/src/poll/poll-loop.ts`:

```ts
      } else if (attempt.kind === "drain") {
        if (attempt.retryAfterMs === null) {
          // No hint = an operator/terminal drain: stop leasing and let the loop exit.
          emitPoll("drain");
          drainRequested = true;
          stopLeasingRequested = true;
        } else {
          // REL-004 clause 3a — a hint makes the drain a REVERSIBLE PAUSE. The frozen protocol
          // has always modelled this (`retryAfterMs` is nullable on drain); nothing read it.
          // Without this, a kill switch could only be un-thrown by restarting every worker.
          emitPoll("drain_paused");
          await drainInFlight();
          consecutiveRecoveries = 0;
          resetBackoff();
          await cadenceSleep(attempt.retryAfterMs);
        }
      }
```

- [ ] **Step 4: run and watch it pass**

Run: same command. Expected: PASS, and the pre-existing terminal-drain and shutdown-ordering
tests (`entrypoint-signals.test.ts`, `control-execute.test.ts`) stay green — the local `drain`
CLI command and shutdown path go through `stopLeasing()`, never through a poll response.

- [ ] **Step 5: mutation-test the branch**

| # | Mutation | Must be killed by |
|---|---|---|
| M27 | `=== null` → `!== null` | both drain cases |
| M28 | drop `await drainInFlight()` on the paused path | the in-flight-settles-first case |
| M29 | drop `await cadenceSleep(...)` | the observed-sleep assertion |
| M30 | set `stopLeasingRequested = true` on the paused path too | the resumes-polling case |
| M31 | `emitPoll("drain_paused")` → `emitPoll("drain")` | a metric assertion distinguishing the two |

- [ ] **Step 6: commit**

```bash
git add packages/worker-daemon/src/poll/poll-loop.ts packages/worker-daemon/src/__tests__/
git commit -m "feat(rel-004): a drain carrying retryAfterMs is a reversible pause, not a stop"
```

---

### Task 8 — separation, D1 nonce, and the result doc

- [ ] **Step 1: prove I7 in both directions**

Add to the integration suite: throwing a provider switch leaves
`execution_targets.status`/`device_generation` untouched and creates no
`execution_target_revocations` row; and JOB-007 `revokeExecutionTarget` leaves
`instance_settings.kill_switches` untouched.

- [ ] **Step 2: bump the D1 nonce**

This changes runtime behaviour on the `server/src` path, and that path is not on the D1 lane's
push filter — without a bump the two-replica lane never exercises it.

```bash
# edit docker/d1/campaign.env — bump the nonce
git add docker/d1/campaign.env
git commit -m "chore(d1): bump the campaign nonce for the REL-004 kill-switch poll path"
```

- [ ] **Step 3: run the full local gate**

```bash
pnpm typecheck && pnpm --filter @armyofagents/server exec vitest run src/__tests__/execution-kill-switches.test.ts src/__tests__/execution-kill-switch-policy.test.ts src/__tests__/job-control-legacy-grants.contract.test.ts src/__tests__/job-leasing-contract.test.ts && node scripts/check-guard-inventory.mjs && node scripts/check-test-inventory.mjs
```

- [ ] **Step 4: write `REL-004-lane-C-result.md`**

It must carry the Start SHA (this design's commit), the acceptance table from §6 with each
clause mapped to a **named executable artifact**, the full mutant ledger with any survivor
either fixed or documented as equivalent, and the deferrals in §7 stated honestly.

- [ ] **Step 5: fast-forward push and watch CI to green**

`ci-required` is the verdict.

---

## 6. Acceptance → named executable artifact

| Clause | Artifact |
|---|---|
| 3a — a kill switch stops new leases | `server/src/__tests__/execution-kill-switch-poll.integration.test.ts` cases 1–3, 6 (real poll path, asserts the absence of a `leases` row) |
| the switch does not revoke targets, and revocation does not kill providers (I7) | same file, case 7 |
| an absent policy permits (I2) | `execution-kill-switch-policy.test.ts`; integration case 1 |
| an unreadable policy refuses (I4) | `execution-kill-switch-policy.test.ts` sentinel cases; integration case 4 |
| the column default cannot kill (I3) | `instance-settings-kill-switches-schema.test.ts` |
| the template axis refuses rather than silently permitting (I5) | `execution-kill-switches.test.ts` D2 block; integration case 5 |
| a mistyped provider value refuses (I6) | `execution-kill-switches.test.ts` D6 block |
| in-flight work finishes (I12) | `execution-kill-switch-poll.integration.test.ts` cases 8–10 |
| `aoa_app` can reach the document (I11) | `job-control-legacy-grants.contract.test.ts` (manifest↔manifest↔startup-spread) **plus** `distributed-execution-db-startup.integration.test.ts`, which applies the migrations, provisions the real roles and calls `openDistributedExecutionDatabases` — that is the only artifact that proves manifest↔**database**, i.e. that the GRANT in 0261 actually exists. The contract test alone would pass with the migration missing. |
| the frozen authority chain is unchanged (I9, I10) | `job-leasing-contract.test.ts` green, plus mutants M25 and M26 |
| the switch is reversible without a fleet restart (I8) | `packages/worker-daemon/src/__tests__/poll-loop.test.ts` D5 block |
| every guard is mutation-tested | the M1–M31 ledger in the result doc |

---

## 7. Out of scope, and the deferrals this lane must state

- **Clause 3b — reconciling active provider resources on kill.** Lane D, next ticket in Wave 3;
  it builds on MIG-008's `legacy-resource-reconciliation.ts` seam.
- **A write path / UI for throwing a switch.** Parent design §5 puts it in REL-001/005. Until
  then a switch is set by an operator writing `instance_settings.kill_switches` directly. The
  result doc must say so plainly rather than implying an operator surface exists.
- **The template axis is NOT enforceable at the poll**, and this lane ships that as a loud
  refusal rather than a silent no-op (D2). Closing it properly requires a control-plane
  template fact — the natural home is an operator-declared pin in `execution_targets.config`,
  bound the way `registeredProfileHash` binds the rest of the placement profile. Out of scope
  here; it is a placement-registry change, not a kill-switch change.
- **The legacy sandbox seam.** `sandbox-provider-runtime.acquire` creates E2B sandboxes today
  from `environments.config.template` and is untouched. That is correct for the Wave-4 gate: the
  switch exists to stop placement on the platform being cut over to, with legacy as the
  fallback. If a later ticket wants to kill legacy placement too, that is a second seam and
  should be stated as such rather than assumed covered.
- **Caching the policy read.** One indexed single-row read per poll, against a poll that
  already issues eight-plus statements. A cache would add per-replica staleness for a
  negligible saving; revisit only with a measurement.

---

## 8. Plan review (process step 4) — what it changed

Run against this document before any code. Findings, with the source line that motivated each:

| # | Sev | Conf | Finding | Resolution |
|---|---|---|---|---|
| F1 | P1 | 9/10 | Clause 3a has two halves and the plan only proved one. "In-flight work finishes" held **by omission** — `ack` and renewal simply have no kill check — which is the vacuously-true class. | New invariant I12 + integration cases 8–10 |
| F2 | P2 | 9/10 | The daemon test asserted the literal `30000`. `cadenceSleep` clamps into `[min(baseMs,maxMs), maxMs]` (`poll-loop.ts:506-507`: `const floor = Math.min(deps.backoff.baseMs, deps.backoff.maxMs); const delay = Math.max(Math.min(Math.max(retryAfterMs, 0), deps.backoff.maxMs), floor);`), so that assertion would have failed for the wrong reason. | Assert the clamp; add an un-clamped fixture so a hardcoded-cap mutant dies |
| F3 | P2 | 8/10 | No diagrams for a change whose whole risk is control flow. | §1.5 poll data flow + daemon drain state machine |
| F4 | P2 | 8/10 | Task 6 assumed a pre-loop `await` is admissible without checking. | Verified admissible (`job-leasing-contract.test.ts` constrains only the loop shape and `statementsAfterLoop.length === 1`); recorded, with a named fallback and an explicit "do not widen the guard" |
| F5 | P3 | 9/10 | The integration task named no harness, inviting a reinvented fixture. | Named the real helpers in `job-leasing.integration.test.ts` |
| F6 | P3 | 7/10 | I11's artifact was the contract test, which compares manifest to manifest — it would stay green with the GRANT missing from the migration. | Named `distributed-execution-db-startup.integration.test.ts` as the manifest↔database artifact |
| F7 | P3 | 6/10 | `scheduler.consume()` burns the ready signal before a drain, so the first poll after un-killing gets the 750 ms cadence instead of 100 ms. | Accepted, not fixed — the check needs the target `kind`, which only exists inside the transaction |

**Scope call recorded here rather than deferred.** Task 7 changes the worker daemon, which is
wider than "wire the kill switch". It is included deliberately: the handoff's stated reason for
building this before Wave 4 is that "a bad cutover is reversible in seconds", and §1.4 shows a
poll drain is currently one-way. Shipping a stop button that can only be un-pressed by
restarting every worker would satisfy the ticket's words and fail its purpose. The change is
contained in one branch of one loop in a package whose poll loop has no production caller yet.

## 9. Self-review

- **Spec coverage.** Clause 3a maps to Tasks 3–7; every invariant I1–I11 has a task and a named
  artifact in §6. Clause 3b is explicitly deferred to Lane D.
- **Placeholders.** None: every code step carries the actual code, every test step the actual
  assertions or the exact case list, every command its expected output. The integration file is
  specified as a case list rather than full source because it must be modelled on the existing
  embedded-PostgreSQL harness in `job-leasing.integration.test.ts`; the cases and their exact
  assertions are enumerated.
- **Type consistency.** `KillSwitchInput` gains `knownProviders` in Task 2 and every call site
  (Tasks 5, 6) passes it. `KILL_SWITCH_POLICY_UNREADABLE` is defined in Task 5 and consumed in
  Tasks 5 and 6. `EXECUTION_TARGET_KINDS` is defined in Task 1 and consumed in Task 6.
  `KILL_SWITCH_DRAIN_RETRY_AFTER_MS` is defined in Task 6 and asserted in Tasks 6 and 7.

---

## 10. What the BUILD changed in this design — two decisions moved

Recorded here rather than silently edited above, so the audit trail survives. Both changes were
forced by guards that were right and a plan that was wrong.

### 10.1 D1 amended — the check sits AFTER the canonical chain, not before it

The plan put the kill check before `normalizePlacementRegistryTarget`, reasoning that a killed
provider should cost one pure function call rather than a candidate scan. The JOB-003 contract
guard refused it with `candidate:canonical-chain-dominates-return`
(`job-leasing-contract.test.ts:4226-4241`): **any** return from the poll's tenant transaction
before the canonical chain (locked authority → revalidated target → static context → candidate
selection) is a violation, so that every poll outcome is provably derived from the validated
context.

The guard is right and the plan's optimisation was worth less than the invariant. The check now
sits immediately after `metrics.certificateScan(...)` and before the eligibility loop. A drained
poll performs one extra already-indexed query; the invariant is untouched.

### 10.2 D1 amended — the reader is NOT injected, and the guard that said so was right

The plan added `killSwitches?: KillSwitchPolicyReader` to `createJobLeasingService`. The contract
guard refused it with `service:no-context-or-guard-injection`, which carries an explicit
allow-list of service options (`ackTimeoutMs`, `appDb`, `leaseDurationMs`, `maxHeartbeatAgeMs`,
`metrics`, `operatorDb`, `scheduler`).

The tempting move was to add an eighth key. That would have been widening a guard *named for
exactly the thing I was doing*. And the guard's objection is substantive, not bureaucratic: **a
reader the caller supplies is a reader the caller can substitute**, and a substituted reader that
always reports "no policy" turns the stop button off for the entire fleet with no trace. That is
strictly worse than the hazard the option was meant to avoid.

So the reader is constructed inside `createJobLeasingService` from the same `input.appDb` the
authority chain runs on. Three consequences, all improvements:

- there is no injectable override, so a permissive reader is unrepresentable;
- there is no "a composition root forgot to wire it" hole, so the wiring test no longer has to
  walk `server/src` looking for constructions that omit an option — it pins the internal
  construction instead (`job-leasing-kill-switch-wiring.test.ts`);
- `worker-control.ts` is unchanged, so the frozen service-option set stays frozen.

The plan's I10 still holds and is now evidenced: mutant **M33** inserts an *unreviewed* call over
a protected value into the tenant body and the guard still fails, so registering
`evaluateKillSwitches` as a reviewed call did not retire `binding:protected-value-escape`.

### 10.3 One harness defect worth recording

The first mutation run over the poll wiring reported M28 and M31 as survivors. Both were false:
the harness did not set `AOA_RUN_WIN_INTEGRATION=1`, so the integration suite was **skipped** and
only the structural wiring test ran. A skipped suite kills nothing. With the env var set, 7/7
died. *A kill — or a survival — proves nothing until you have checked which tests actually ran.*
