# DSK-001 Lane B — design

**Date:** 2026-08-21
**Branch:** `docs/replatform-program` (PR #323)
**Start SHA:** the commit that lands this file, before any Lane B code
**Amends:** `DSK-001-design.md` D10, D11, D12 — see §2, which refutes one of them outright
**Terrain map:** 8 parallel readers + 40 adversarial verifiers over `db997bf8b`; 16 claims
came back IMPRECISE, none REFUTED. Every load-bearing claim below was then re-read
first-hand rather than taken from a subagent.

---

## 1. What Lane B is, and what it is not

D10 (a device-local credential broker returning an activation, never bytes), D11 (owner
membership enforcement) and D12 (four `ref_id ↔ provider_credentials` sub-contracts).

**It is not end-to-end wiring, and this document says so up front so nobody discovers it
later.** `device_local` has exactly one production consumer today —
`createFenceAwareEgressProxy` — and that consumer *denies* it:

```ts
// server/src/services/egress-proxy.ts:217
if (resolved.outcome !== "resolved") return deny("malformed");
// A non-network (device-local) handle can never authorize egress.
```

That denial is correct: the server is declining to egress a value it cannot hold. The real
consumer is device-side and belongs to **DSK-002**. Worse, `createFenceAwareEgressProxy`
itself has **zero production callers**. So Lane B ships an authorization and typing
foundation whose consumer does not exist yet.

This is the same shape as the Lane A finding "the enrollment client is built and wired to
nothing" — with one difference that matters: there it was an oversight, here it is the
plan. Stating it in the design is what keeps that distinction true.

---

## 2. Corrections to `DSK-001-design.md`

### C-1 (CRITICAL) — F17 is REFUTED. D11(a) already exists, and is already tested.

`DSK-001-design.md:107` (F17), `:21` and `:300` all assert that `issueTenantCode` performs
**no** organization-membership check on `ownerUserId`, and that closing that is new work.
The code contradicts this.

`issueTenantCode` (`server/src/services/worker-enrollment.ts:195`) calls
`repos.workerEnrollment.findActiveTarget(...)` inside exactly the `runInTenant` block D11
names, and that callee asserts the membership
(`packages/db/src/repositories/tenant/worker-enrollment.ts:224-234`):

```ts
if (input.scope === "owner") {
  const [membership] = await tx.select({ id: organizationMemberships.id })
    .from(organizationMemberships)
    .where(and(
      eq(organizationMemberships.organizationId, target.organizationId!),
      eq(organizationMemberships.userId, input.ownerUserId!),
      eq(organizationMemberships.status, "active"),
    ))
    .limit(1);
  if (!membership) return null;   // → issueTenantCode throws "unauthorized"
}
```

It is proven green at `server/src/__tests__/worker-enrollment.integration.test.ts:2018` —
"revokes owner-scoped session and new issuance when Organization membership is removed" —
which suspends the membership and asserts `issueTenantCode` rejects `unauthorized`. That
is invariant **I15(a)** verbatim.

**How this was missed twice.** The design was written 2026-08-20; the check landed
2026-08-10. And the controller's own first read of `issueTenantCode` concluded "zero
membership checks" because it read the **caller** and stopped — the assertion is one call
deep, in the callee. An adversarial reader found it. This is precisely the failure the
per-ticket process exists to catch, and it is worth recording that it caught it here.

**Decision (OQ-5): ACCEPT D11(a) as done.** Lane B writes no membership query. It records
the finding and cites the existing test as the proof. An implementer following D11
literally would have written a redundant second query against the same table.

### C-2 (HIGH) — the D12 cost statement is short by ~8 files

`DSK-001-design.md:326` names three coordinated files. The real minimum atomic set is
**eleven**, because it omits two whole surfaces:

- the `aoa_app` grant surface for `provider_credentials` (§4 — five artifacts, boot-crash
  coupling), and
- the embedded-PG integration fixtures that currently admit `device_local` (§5).

### C-3 (HIGH) — "the compiler forces the migration" is false where it matters most

`server/tsconfig.json` carries `"exclude": ["src/__tests__"]` (verified), and vitest does
no typechecking. So `server/src/__tests__/secret-resolve-authz.test.ts`'s explicitly-typed
`SecretResolveAuthzInput` literals **will not error** on a new required field — they will
silently pass `undefined`.

The *only* compile-time forcing function is
`packages/db/src/repositories/tenant/job-control.ts:2726`. And an **optional** field
(`field?: T`) forces nothing anywhere at all.

### C-4 — path and line corrections

- **`server/src/services/job-control.ts` does not exist.** The fenced transaction and the
  `authorizeSecretResolve` call are at
  `packages/db/src/repositories/tenant/job-control.ts:2726`. The design's bare
  "job-control.ts" is the `packages/db` file throughout.
- `SecretBrokerSet` is at `secret-broker.ts:108-115`, not `:107-114`.
- The `if (ownerBound)` membership block is `:2707-2721`; the insertion point for a
  sibling check is **line 2722**.

### C-5 — three D12 asks already exist in code

| Design asks | State |
|---|---|
| `network_destination_missing` reject (I21) | **EXISTS** — rule 4b (`job-fence.ts:270-272`) + vector `network_use_missing_destination`. It uses `provider_key`, so a device_local-flavoured one is a *fixture* addition only. |
| `device_local` ⇒ never `remote_server_fenced` | **EXISTS** — rule 3b (`:256-258`) + vector. |
| admit `device_local + proxy + fence_proxy` w/ destination | **the RULE already admits it**; only the *vector* is missing. |
| `device_local` not routed into `SecretBrokerSet` | **ALREADY TRUE** — `dispatchResolvedSecret` short-circuits on `refKind` alone, before either broker call. |
| `DeviceLocalHandoff` has no `value` field | **ALREADY TRUE.** |

### C-6 (HIGH, and it is a hole in the gate itself) — the rejection-reason union is unguarded

`SecretResolveRejectionReason` has **no exhaustiveness assertion anywhere** (verified: four
references repo-wide, none of them a gate). An eleventh member with zero vectors leaves
every lane green. Any Lane B increment that adds a reason must therefore also close this,
or the addition is unguarded by construction. §6/B1 does it first.

### C-7 — `destination` is dropped too, and for `device_local + fence_proxy` it is load-bearing

D12(2) lists three fields. `AuthorizedSecretResolution.destination` is *also* dropped at
`secret-broker.ts:142-149`, and rule 4b guarantees it non-null on exactly the `fence_proxy`
path D10's `proxy_endpoint` arm exists to serve. Omitting it forces DSK-002 to widen the
type immediately — the very outcome the design's own "note the `proxy` arm" paragraph is
trying to avoid. **Lane B carries `destination` as a fourth field.**

### C-8 — an existing test is already vacuous and will stay green for the wrong reason

`server/src/__tests__/egress-proxy.integration.test.ts:523` claims a `device_local` handle
"never dispatches". Its handle is owner-bound, and that suite seeds **zero**
`company_memberships` rows (verified). So it is refused `owner_membership_lost` at
authorization and never reaches the line it is named for. Lane B fixes the fixture so the
test starts testing its own name.

### C-9 — lane conflict on the device listing

`DSK-001-design.md:65` puts the owner-scoped device listing in Lane B;
`DSK-001-lane-A-result.md` tabulates it under D17/Lane D. **Resolved: Lane D.** D17 is the
design's own decision number for it and it is a server-side allowlist projection — a
different concern from credential custody.

### C-10 — the mirror and the real function diverge on `undefined`, dormantly

`check-secret-resolve-vectors.mjs` treats `undefined` as absent at three sites; `job-fence.ts`
does not. Every current vector sets all nine handle keys, and the vitest bridge normalizes
with `?? null`, so the axis is unreachable today. **Every new vector must set all nine
keys.** Stated as a rule here so it does not have to be rediscovered.

---

## 3. Decisions

### D-B1 — `DeviceLocalCredentialBroker` lives **server-side, beside `secret-broker.ts`** (OQ-1)

It is a **port**, not an implementation: the control plane declares the shape and something
else implements it, exactly as `SecretBrokerSet` + `failClosedSecretBrokers` already do
(`secret-broker.ts:108-126`), which the design explicitly says to mirror.

Rejected — `packages/worker-keystore`: that package is device-side and has no DB access,
and placing the port there would drag the D2 keystore boundary checker across a server-side
type for no benefit. Rejected — `packages/worker-daemon/src`: its runtime manifest is
pinned to `["@armyofagents/worker-protocol","pino"]` and the boundary checker rejects any
bare specifier beyond that.

### D-B2 — `ref_id` shape is checked in the PURE function; existence/state/owner in the tx (OQ-2)

A DB-level FK is **not available**: `job_secret_handles` is org-scoped and
`provider_credentials` is company-scoped, and a cross-scope FK is precisely the cross-tenant
existence oracle E2-F013 already removed once. So the contract is runtime-only.

Split it deliberately:

- **UUID shape** → the pure `authorizeSecretResolve`. Pure means the **vector gate** can
  exercise it with no database, on the always-on `policy` lane.
- **Existence + `state === "verified"` + the owner triple** → the fenced tx, where the row is.

This maximises what the cheapest, most-gated surface can prove. It also means the existing
`device_local` admit vector (`refId: "provider-credential-1"`, not a UUID) flips to reject —
which is why fixtures are reseeded in B5, one increment *before* the rule lands in B6.

### D-B3 — the grant is **table-level**, no RLS policy (OQ-3)

> **AMENDED 2026-08-21, during B4.** This decision originally said *column-level*,
> reasoning from the `execution_targets` precedent. Reading the code while
> implementing reversed it, on two pieces of evidence:
>
> 1. **`has_table_privilege` does not see a column grant.** I claimed it did. It does
>    not — and `execution_targets` proves it: it carries column grants and its
>    `PLAN_DERIVED_ACL_MATRIX` entry is `aoa_app: []`. Column privileges are checked by
>    a *separate* `has_column_privilege` pass.
> 2. **Column-level is more machinery, not less exposure.** It exists solely for
>    `execution_targets` and carries a bespoke `APP_ENROLLMENT_TARGET_SELECT_COLUMNS`
>    constant wired into two DDL emitters *and* the column-assertion pass. Inventing a
>    second one for a read-only lookup on a table with no secret in it trades real
>    complexity for no real containment.

```sql
REVOKE ALL ON "provider_credentials" FROM PUBLIC;
GRANT SELECT ON "provider_credentials" TO "aoa_app";
```

This mirrors `company_memberships` (`0214`), which is the same class of read: a legacy
company-scoped authorization fact consulted inside the fence. Scoping is enforced by
the query filtering on the **LOCKED lease's** `companyId`, never a wire value — exactly
as the sibling membership re-check already does. No RLS policy, matching that
precedent.

Verified rather than assumed: `provider_credentials` stores **no secret value** —
"logical credential ownership only", with provider-native subscription files remaining
in the owning execution target.

### D-B8 — a SEVENTH surface: the immutable-artifact reconstructions

The terrain map counted five artifacts for the grant. There are **seven**. Two
functions in `rls-tenant.ts` RECONSTRUCT the bodies of migrations 0213 and 0214 by
walking the live grant map, and applied migrations are immutable — so adding one entry
to `JOB_CONTROL_LEGACY_GRANTS` retroactively rewrote two migrations that already ran.

A byte-identity test caught it immediately, which is the system working. Worth
recording anyway: **0214's builder had no exclusion list at all**, so it was one
addition away from this the whole time. Both are now gated on named sets
(`GRANTED_AFTER_0213`, `GRANTED_AFTER_0214`) rather than a growing chain of
`table === "..."` clauses, so the next addition has one obvious home.

### D-B4 — the third leg binds the credential to its DEVICE, not to a target owner (OQ-4)

> **AMENDED 2026-08-21, during B6.** The design's third owner leg compared
> `provider_credentials.owner_user_id === execution_targets.owner_user_id`. Implementing
> it showed that is both weaker and wrong-shaped:
>
> 1. **It says nothing about which device holds the value.** A `device_local` credential
>    lives in exactly one machine's OS keystore, named by
>    `provider_credentials.execution_target_id`. If the job is placed anywhere else, that
>    machine cannot read it. Owner equality does not express this.
> 2. **It can never hold for an organization-scoped target**, whose `owner_user_id` is
>    NULL — so it would reject every handle on a shared worker rather than the ones that
>    are actually mis-bound. Both integration suites use organization-scoped targets, and
>    the rule as designed would have forced a fixture rewrite to accommodate a check that
>    was not the right check.
>
> **Ships instead:** `credential.executionTargetId === input.liveTargetId`, where
> `liveTargetId` is the lease's target — already proven under lock by `guardActiveFence`.
> This subsumes the owner comparison: a credential and a target that disagree about the
> device are mis-bound whoever owns them. The reason is `credential_target_mismatch`.
>
> It also removed a query: the transaction no longer reads `execution_targets` at all,
> so the column-projection trap OQ-4 flagged (table-level privileges are `[]`) does not
> arise.

Legs 1 and 2 are unchanged: `ownerPrincipalKind === "user"` (because
`provider_credentials.owner_user_id` references the `user` table, so a worker or agent
principal can never own a device credential), and
`ownerPrincipalId === provider_credentials.owner_user_id`.

Leg 1 is checked **before** the owner-binding rule, deliberately: it is a property of the
handle alone, and placing it after would make `owner_principal_kind_invalid` unreachable
whenever the job's executor is itself a non-user principal — which is exactly the case
that motivates it.

### D-B5 — the credential read is read-committed, deliberately (OQ-6)

The `provider_credentials` read at line 2722 is **not** locked, so a concurrent `state` flip
is not serialized against the audit UPDATE.

This is accepted, because it is the guarantee its two siblings already give: neither
`handle.status` nor `ownerMembershipActive` is locked either, and revocation for both takes
effect on the **next** resolve. Taking `FOR SHARE` on a company-scoped credentials table
from inside an org-scoped transaction that already holds a `leases` + `job_attempts` lock
would introduce a new lock-ordering surface for a strictly narrower window than the
mechanism already tolerates elsewhere. Recorded as a decision, not left to be discovered.

### D-B6 — `expiresAt` is declared but its bound is NOT enforced (OQ-7)

D10 specs `expiresAt <= lease deadline`. No lease deadline reaches the broker today:
neither `SecretResolveRequestV1` nor `AuthorizedSecretResolution` carries one. Threading it
would widen two more types for a port nothing consumes.

The field is declared; the bound is **an explicit deferral to DSK-002**, and the deferral is
safe by construction because `failClosedDeviceLocalBroker` throws — no activation can be
minted, so no unbounded activation can exist. The result doc repeats this rather than
letting the type imply a guarantee it does not have.

### D-B7 — close the exhaustiveness hole FIRST, in `packages/db` (C-6)

Add `SECRET_RESOLVE_REJECTION_REASONS` as an exported runtime array in **`job-fence.ts`**,
with a compile-time exhaustiveness assertion beside it, and have the policy-lane vector
checker assert every reason has at least one reject vector.

It must live in `packages/db/src`, **not** a test file: `server/src/__tests__` is excluded
from `tsc` (C-3), so a type-level assertion placed there would be inert — exactly the
"guard born dead" failure Lane A hit.

This lands **before** any new reason, so every reason B6 adds is forced to carry a vector.

---

## 4. The grant is five artifacts, and a mismatch is a BOOT CRASH

Verified: `assertExactServingRoleAuthority`
(`server/src/db/distributed-execution-databases.ts:133`) runs at startup (`:1436`),
enumerates `has_table_privilege` for **every** table in every non-system schema, and
compares against the manifest. A grant without a manifest entry — or a manifest entry
without the grant — throws `distributed_execution_app_authority` and **both replicas fail to
boot**. This is not a test failure.

The five surfaces that must agree:

1. a new C14 `--custom` migration (0214 is immutable; follow the 0253+ pattern);
2. `JOB_CONTROL_LEGACY_GRANTS` — `server/src/db/job-control-legacy-grants.ts`;
3. `PLAN_DERIVED_ACL_MATRIX.relations` in production — same file;
4. the **independently hand-transcribed** copy in
   `server/src/__tests__/job-control-legacy-grants.contract.test.ts` (deliberately
   duplicated so a production change cannot rewrite its own certificate);
5. `appTablePrivileges()` — `server/src/db/distributed-execution-databases.ts`.

**This is why B4 lands alone**, before any consumer.

Also verified and worth stating: there is **no `migration-idempotency` or `readiness` job**
in `pr.yml` on this branch — `migrations` runs "apply from scratch" + "chain integrity"
only. So C14 idempotency guards on the new migration are **not CI-enforced here**; they are
written correctly because MIG-008 already proved what happens when they are not.

---

## 5. Landing order

Each increment is independently verifiable and independently green.

| # | Increment | Risk |
|---|---|---|
| **B0** | Record the D11/F17 refutation (docs only). Removes a deliverable and prevents a redundant query. | none |
| **B1** | Close the exhaustiveness hole (D-B7) + pin the already-correct `device_local` policy surface with vectors. No production logic changes. | none — pure gate strengthening |
| **B2** | Widen `DeviceLocalHandoff` with `companyId`, `handleId`, `boundTargetGeneration`, `destination` (C-7); replace the `not.toContain("value")` check with a **frozen key allowlist** (I19). Pure pass-through, no DB read. | low |
| **B3** | Declare `DeviceLocalCredentialBroker` + `failClosedDeviceLocalBroker` (D-B1). Greenfield — zero naming collisions repo-wide. Meta-test: no type reachable from the port carries a value-bearing field, and the port is not assignable to `SecretBrokerSet`. | low |
| **B4** | The `provider_credentials` grant, **alone**, before any consumer — all five surfaces (§4). | boot-crash class; isolated deliberately |
| **B5** | Reseed the integration fixtures to UUID `refId` + `state='verified'`, add the required `user` row (FK `authUsers`), and fix C-8's vacuous test. **Assertions do not change** — green before and after B6. | low |
| **B6** | The coordinated rule change: `job-fence.ts` input + rules + reasons, `job-control.ts:2722` read, the hand-mirrored `decideResolve`, new vectors (all nine keys), `secret-resolve-authz.test.ts` literals (the compiler will NOT tell you — C-3), and the `docker/d1/campaign.env` bump. | the real one |

B4 and B5 landing first is the highest-value sequencing decision here: it makes B6's diff
pure decision logic, so review can focus on the rule instead of on grant bookkeeping.

---

## 6. Scope explicitly NOT in Lane B

- **D11.** Already done (C-1). Recorded, not rebuilt.
- **The device listing / Settings surface.** Lane D (C-9).
- **A real `DeviceLocalCredentialBroker` implementation.** DSK-002 — Lane B ships the port
  and the fail-closed default only.
- **`expiresAt <= lease deadline` enforcement.** DSK-002 (D-B6).
- **Making `device_local` reach a consumer.** DSK-002. The egress proxy's `malformed`
  denial is correct and stays.
