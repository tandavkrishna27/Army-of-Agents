# MEASUREMENT — DE-01's read half does not need `BYPASSRLS`, and `client.ts:325` must not be amended

**Date:** 2026-09-09
**Unit:** MIG-010 Unit D (the read-half measurement).
**Findings referenced:** `E0-F010` (the eight absent audit clauses), `E0-F013` (Group D, "no
amount of interception closes them").
**Status changes made by this document:** **none.** No finding is closed, struck, enrolled or
re-dispositioned here. This document measures one load-bearing premise inside two open findings
and records what it found.
**Production code written by this unit:** **none.** The only file added is a measurement harness
under `server/src/__tests__/`.
**Revision, same day (post-review):** an external review on PR #400 (`chatgpt-codex-connector`, P2,
against `de01-read-half-alternatives.integration.test.ts:135`) observed that ALT-A(ii)'s green was
being attributed to *ownership* when it is in fact carried by the owner's **superuser** attribute.
That is correct. The precondition is now stated wherever ALT-A is recommended and is **pinned by a
test** — `ALT-A(iii)`, the non-superuser-table-owner control — rather than by this prose. **The
verdict is unchanged**: it never depended on ALT-A, because **ALT-B needs no privileged role
anywhere** and the `revocation`-clause self-contradiction in §2 is independently sufficient.

---

## 1. The standing claim

`E0-F010` and `E0-F013` both carry it, in near-identical words. `E0-F013`, Group D:

> **DE-01's READ half — the hard one.** PostgreSQL emits **no event** when an RLS `USING` clause
> filters rows [...] Detecting it requires re-running the query without the policy and diffing —
> i.e. a `BYPASSRLS`/owner connection, exactly the privilege `packages/db/src/client.ts:325`
> throws at boot to forbid [...] **Recommend AMENDING the clause, not building it.**

and `E0-F010`:

> DE-01's read half is confirmed unbuildable by interception — [...] detecting it needs a
> `BYPASSRLS` comparator, i.e. exactly the privilege `packages/db/src/client.ts:325` throws at
> boot to forbid.

The claim decomposes into three propositions. **The first is true. The second is true. The third
is FALSE, and it is the one the recommendation rests on.**

| # | Proposition | Verdict |
|---|---|---|
| 1 | An RLS-filtered read raises no error and is indistinguishable from an empty result. | **TRUE** — measured, P1 below. |
| 2 | `client.ts:325` refuses a `BYPASSRLS` serving connection at boot. | **TRUE** — measured, POSITIVE CONTROL below. |
| 3 | Therefore a cross-tenant comparator read **requires** `BYPASSRLS`, so the guard must be amended. | **FALSE** — measured twice over: **ALT-B** below, unconditionally, and **ALT-A(ii)** under the precondition stated immediately after this table and controlled for by ALT-A(iii). |

Proposition 3 is a non-sequitur: it treats `BYPASSRLS` as the only way a connection can see rows
outside its tenant. It is not, and this tree already ships two other ways.

**★ ALT-A CARRIES A PRECONDITION, AND IT IS NOT OPTIONAL.** `SECURITY DEFINER` relocates authority
to the function's **owner**; under `FORCE ROW LEVEL SECURITY` an ordinary table owner is **still
subject to its own policies**. So ALT-A reads across tenants only when the owner is *itself*
exempt — i.e. **owner-owned AND owner-privileged** (`SUPERUSER` or `BYPASSRLS`). Measured both
ways: ALT-A(ii) green with a superuser owner, **ALT-A(iii) the same function returning zero rows
under a `NOSUPERUSER NOBYPASSRLS` owner of `jobs`**. **ALT-B carries no such precondition** — a
role-targeted policy needs no privileged role anywhere — which is why proposition 3 is false
regardless of how ALT-A's precondition is resolved.

---

## 2. What DE-01's register row actually requires, clause by clause

From `docs/architecture/distributed-execution-threat-controls.json`, verbatim:

- `"audit": "query and policy-denial events recorded in the control-plane audit log"`
- `"revocation": "session tenant variable cleared at transaction end; the role holds no BYPASSRLS"`

**The audit clause is a conjunction, and only one conjunct is contested.**

- **"query [...] events recorded"** — pure instrumentation of the serving path.
  `server/src/db/with-tenant-tx.ts` is the single **file** holding every writer of the tenant GUC —
  `withTenantTx` at `:36` and `withReadOnlyTenantTx` at `:75`, two functions, and a whole-tree grep
  for `set_config('aoa.organization_id'` outside tests returns those two lines and nothing else.
  Recording who queried what, under which organization, needs **no database privilege whatsoever**.
  Nothing about this half is blocked by anything.
- **"policy-denial events recorded"** — this splits again. The **write** half raises catchable
  SQLSTATE `42501` and `E0-F013` already classes it as "genuinely closable". The **read** half is
  the contested one.

**★ The revocation clause independently refutes the proposed amendment.** DE-01's own row asserts,
as a delivered control, that *"the role holds no BYPASSRLS"*. Amending `client.ts:325` to admit a
`BYPASSRLS` serving role in order to satisfy DE-01's `audit` clause would **falsify DE-01's
`revocation` clause in the same register row**. A remedy that breaks the crossing it is remedying
is not a remedy. This alone is sufficient to reject the amendment, before any measurement.

---

## 3. What `client.ts:325` forbids — to whom, and when

`packages/db/src/client.ts:325`, inside `assertNonOwnerConnection(db, expectedRole?)`:

```
if (row.rolsuper || row.rolbypassrls) {
  throw new Error(
    `Refusing to serve tenant queries as a privileged role (rolsuper=${row.rolsuper}, ` +
      `rolbypassrls=${row.rolbypassrls}); the serving pool must be a non-owner NOSUPERUSER ` +
      "NOBYPASSRLS role so forced RLS can filter it.",
  );
}
```

Three facts about its scope, each measured against source, all of which the standing claim elides:

1. **It forbids the ATTRIBUTE on the connection it is handed — not a role by name.** The predicate
   is `pg_roles.rolsuper OR pg_roles.rolbypassrls` resolved for `current_user` of the passed
   transaction.
2. **It is not a cluster-wide gate and not a boot-only gate.** It is a per-connection assertion
   with **exactly two production call sites**, both in
   `server/src/db/distributed-execution-databases.ts` — `:1754` for `aoa_app` and `:1769` for
   `aoa_operator`. It runs at startup on those two pools. **It says nothing about, and does not
   run against, any other connection.** A cluster is free to hold a `BYPASSRLS` role; the guard's
   claim is narrower and stronger — *the two serving pools are not it*.
3. **Neither alternative below touches it.** Both are DDL changes (a policy, or a function plus
   its ACL). The guard inspects role attributes, and role attributes are what neither alternative
   changes. Measured: the guard passes for `aoa_operator` *after* both alternatives are applied
   (test `GUARD` below).

The guard is load-bearing exactly as the brief says: E2's tenant kernel rests on `aoa_app` being a
non-owner `NOSUPERUSER NOBYPASSRLS` role under FORCE RLS
(`packages/db/src/migrations/0211_tenant_rls_enforcement.sql:16`,
`0214_e2_serving_role_hardening.sql:16`).

---

## 4. Is `BYPASSRLS` actually required? — measured against real PostgreSQL

Harness: `server/src/__tests__/de01-read-half-alternatives.integration.test.ts`, on embedded
PostgreSQL through the shared `startMigratedDatabase` bootstrap, with the whole migration chain
applied. Two organizations, one `jobs` row each. `jobs` is `ENABLE` + `FORCE ROW LEVEL SECURITY`
with a single policy targeted `TO "aoa_app"`. Run locally under `AOA_RUN_WIN_INTEGRATION=1`:
**10/10 pass** (test wall-clock 6.7–9.7s across runs).

**★ AND IT RUNS IN CI, so this is not a harness that only ever ran on one laptop.** The
`AOA_RUN_WIN_INTEGRATION` hatch gates **Windows only**; Linux runs the suite unconditionally, and
the `verify (1)` shard on PR #400's run `34381776576` logs
`✓ src/__tests__/de01-read-half-alternatives.integration.test.ts (10 tests) 10245ms`.

**The bootstrap's migration owner is the embedded-postgres SUPERUSER** (`startMigratedDatabase`
connects as `test`). That is stated here because it is load-bearing for exactly one row below —
ALT-A(ii) — and ALT-A(iii) is the control that makes the dependence visible rather than assumed.

| Test | What it establishes | Result |
|---|---|---|
| **P1 — premise** | `aoa_app` under `ORG_A`'s GUC selecting `ORG_B`'s job by id returns `[]`, no error; its own row still returns. | **The claim's proposition 1 holds.** The read half really is a silent filter. |
| **P2** | `aoa_operator` selecting `jobs` with no `GRANT` raises SQLSTATE **`42501`**. | A missing grant is a *loud* refusal, not a filter — the two failure shapes are distinct. |
| **P3** | After `GRANT SELECT ON jobs TO aoa_operator`, `aoa_operator` sees **zero rows**. | **`GRANT` alone is not enough.** Under FORCE RLS a granted role matched by no policy is default-denied. This is the fact the standing claim generalised from — correctly, as far as it goes. |
| **ALT-A(i)** | A `SECURITY DEFINER` function **owned by a `NOSUPERUSER NOBYPASSRLS` role matched by no policy** returns **zero rows**. | **`SECURITY DEFINER` is not magic.** It relocates authority to the function's owner; if that owner is itself filtered, nothing is gained. Stated because the opposite is the natural assumption. |
| **ALT-A(ii)** | A `SECURITY DEFINER` function **owned by the migration owner — who here is also `SUPERUSER`**, `REVOKE ALL FROM PUBLIC` and from `aoa_app`, `GRANT EXECUTE` to `aoa_operator` only: `aoa_operator` reads **both** organizations' rows. Its own `pg_roles` row is asserted in the same test to be `rolsuper=false, rolbypassrls=false`, and the **function owner's** `rolsuper OR rolbypassrls` is asserted **true** in the same test so the precondition cannot be read out of the result. `aoa_app` calling the same function is refused **`42501`**. | **A cross-tenant read by a NON-`BYPASSRLS`, non-owner CALLER — under an owner-privileged owner. Proposition 3 is false.** |
| **ALT-A(iii) — CONTROL** | `jobs` is re-owned to `de01_tabowner` (`LOGIN NOSUPERUSER NOBYPASSRLS`, attributes asserted; `relrowsecurity`/`relforcerowsecurity` asserted still true), and the **identical** definer function owned by that table owner, `EXECUTE` granted to `aoa_operator` alone, returns **zero rows**. Ownership is restored in a `finally`. | **★ ALT-A IS NOT PORTABLE TO A NON-SUPERUSER MIGRATION OWNER.** Under FORCE RLS the table owner is not exempt from its own policies, so "owner-owned" is **not** sufficient — "owner-owned **and** owner-privileged" is. **Mutation-checked:** adding `ALTER ROLE de01_tabowner BYPASSRLS` before the function is created turns this case red (`expected [ {…}, {…} ] to deeply equal []`), so the green is caused by the missing privilege and nothing else. |
| **ALT-A(iv) — VIEW** | A plain (non-`security_invoker`) view over `jobs`, `SELECT` granted to `aoa_operator`: reads **both** organizations while its owner is the superuser (owner privilege asserted in-test); re-owned to `de01_tabowner`, the same view returns **zero rows**. | **A view is ALT-A in different spelling, and inherits ALT-A(iii) exactly.** A view executes as *its* owner, so it is the same mechanism with the same precondition — not a third alternative. |
| **ALT-B** | `CREATE POLICY ... ON jobs FOR SELECT TO "aoa_operator" USING (true)`: `aoa_operator` reads both organizations' rows, while `aoa_app` under `ORG_A`'s GUC in the same database **still sees only its own**. | **A second, independent cross-tenant read with no `BYPASSRLS`, and the tenant boundary for the serving pool is untouched.** |
| **GUARD** | `assertNonOwnerConnection(operatorDb, "aoa_operator")` **resolves** after both ALT-A and ALT-B have been applied. | Neither alternative requires, implies, or survives-by-weakening `client.ts:325`. |
| **POSITIVE CONTROL** | A purpose-made `LOGIN NOSUPERUSER BYPASSRLS` role is refused by `assertNonOwnerConnection` with the exact `:325` message and `rolbypassrls=true`. | The guard is live and the harness can see it bite. Without this, all nine greens above would be consistent with a guard that does nothing. |

**Both alternatives are already shipped patterns in this tree — this unit invented neither.**

- **ALT-B is in production, on FORCE-RLS tables, today.** `distributed_cutover_markers` is `ENABLE`
  + `FORCE ROW LEVEL SECURITY` (`:40`, `:43`) and carries `CREATE POLICY
  "distributed_cutover_markers_operator_write" ... TO "aoa_operator" USING (true) WITH CHECK (true)`
  (`0233_distributed_cutover_marker_rls.sql:49-51`). Siblings:
  `0239_execution_target_revocations_rls.sql:56`, `0256_dizzy_bedlam.sql:93`,
  `0269_groovy_lila_cheney.sql:98`, and a `FOR SELECT ... USING (true)` discovery policy at
  `0221_worker_enrollment_rls.sql:112`. Fourteen `aoa_operator` policies exist across the chain.
- **ALT-A(ii) is the exemplar Decision #122's 2026-09-01 amendment was written for.**
  `0268_legacy_reconciliation_lease_read.sql` is a fully-worked instance: owner-owned `SECURITY
  DEFINER`, `LANGUAGE sql STABLE`, `SET search_path = ''`, every relation schema-qualified,
  `REVOKE ALL FROM PUBLIC` and from `aoa_app`, `GRANT EXECUTE` to `aoa_operator` alone, and a
  deliberately narrowed column projection with the exclusions written out as decisions. Its own
  header states the rule that governs here: *"THE GRANTEE is the boundary, not the parameter."*
  **Read that migration before writing another one.**

**★ One correction to the record, so this document is not itself over-read.** `0268`'s function
reads `environment_leases`, which has **no RLS at all** (zero `ROW LEVEL SECURITY`/`POLICY`
statements anywhere in the migration chain mention it). `0268` therefore solves a **`GRANT`**
problem, not an **RLS** problem, and on its own it does **not** demonstrate that `SECURITY
DEFINER` defeats FORCE RLS. That is what **ALT-A(ii)** was run to establish, on `jobs`, which *is*
FORCE-RLS'd. The existing migration alone would not have proved it.

**★ AND THE TRANSFER IS CONDITIONAL — this is the correction to the correction.** `SECURITY
DEFINER` does not "defeat" FORCE RLS; it *substitutes the owner for the caller*, and FORCE RLS then
applies to the owner. ALT-A(ii) reads across tenants because this bootstrap's migration owner is a
`SUPERUSER`, not because the function is owner-owned. **ALT-A(iii) is the control**: the same
function, owned by a `NOSUPERUSER NOBYPASSRLS` owner of `jobs`, returns **zero rows**. So the
`0268` shape is portable to a FORCE-RLS relation **only where the migration owner is `SUPERUSER` or
`BYPASSRLS`**. Any future unit that adopts it must either (a) establish that precondition for its
own deployment and assert it in a test, or (b) use **ALT-B**, which needs no privileged role at
all. Getting this wrong does not fail loudly — it produces a comparator that reads `[]` and reports
"no divergence" forever, which is this programme's own "a check that nothing runs".

---

## 5. Verdict, and the question this measurement does NOT answer

### 5.1 On the guard — settled

**`packages/db/src/client.ts:325` is not the obstacle, and must not be amended.** The recommendation
to amend it should be treated as withdrawn on measurement. Per the unit's own rule: an alternative
works, so recommend the alternative and leave the guard alone. Concretely, were a cross-tenant read
ever chartered for this purpose, it takes one of two shapes, both C14 class (b) under Decision #122,
both hand-authored into a delta-free `--custom` migration, and **neither** touching a role attribute:

- a narrow owner-owned `SECURITY DEFINER` function on the model of `0268`, `EXECUTE` granted to
  `aoa_operator` alone and explicitly `REVOKE`d from `aoa_app` — **admissible against a FORCE-RLS
  relation ONLY where the function's owner is itself `SUPERUSER` or `BYPASSRLS` (ALT-A(iii)); a
  chartering unit must assert that precondition in its own test, because failing it yields zero
  rows silently, not an error.** A view is the same shape with the same precondition (ALT-A(iv)),
  not an escape from it; or
- a role-targeted `CREATE POLICY ... TO "aoa_operator"` on the model of `0233` — **no precondition,
  no privileged role anywhere. Prefer this one** unless the projection narrowing a definer function
  gives is specifically needed.

Detecting abuse of either is a bounded problem, and the machinery already exists. Both boot
certificates run on the two serving pools at `distributed-execution-databases.ts:1754-1770`:
`assertExactCatalogCertificate` (`:684`) pins the exact `SECURITY DEFINER` function set together
with each function's `proconfig`, `proacl` and `sha256(prosrc)` (the catalog read is
`readSecurityDefinerCatalog`, `:377-433`), so a widened projection, a changed body or a re-granted
`EXECUTE` fails startup; `assertExactServingRoleAuthority` (`:144`) pins the serving role's
relation-level authority. A
`BYPASSRLS` amendment has no comparable detector: the attribute is global to the role, invisible in
a diff of any relation, and grants everything at once to every statement the pool ever runs. That
asymmetry — a bounded, certificate-pinned grant versus an unbounded, uncertifiable one — is the
substantive reason to prefer the alternatives, over and above the fact that they work.

### 5.2 On DE-01's read half — deliberately left open

**"Not blocked by the guard" is not "therefore build a comparator", and this unit does not
promote it to one.** The brief's own distinction decides the shape of the remaining question:

> A verifier that needs to read ACROSS tenants to check an invariant is a different requirement
> from a SERVICE that needs to. Which is this?

DE-01's `audit` clause asks for **service-path** recording — denial events, as they happen, on the
live tenant query path. The mechanism the standing claim imagined (re-run every query without the
policy and diff) is therefore a comparator on the **hot path of every tenant read**, across all
24+ relations, holding owner authority. That is a materially worse control surface than anything
it would detect, and the alternatives above make it *possible* without making it *advisable*. By
contrast, an offline **verifier** — one narrow, org-bound, column-projected function answering a
specific invariant — is exactly what `0268` already is, and is well within what the alternatives
support.

So the honest state of DE-01's read half after this measurement is:

- Its **query** conjunct is unblocked and always was — no privilege needed.
- Its **write**-side denial conjunct is closable via `42501` at `with-tenant-tx.ts`, as `E0-F013`
  already says.
- Its **read**-side denial conjunct is still undelivered, and the open decision is the one
  `E0-F013` filed as its Decision 1 — *deliver it, or amend the clause wording to what the
  programme intends*. **That is a founder ruling and is not taken here.** What has changed is only
  that "the boot guard forbids it" is off the table as a reason, in either direction.

**No finding's status is changed by this document.** `E0-F010` and `E0-F013` both remain open,
with their existing dispositions.
