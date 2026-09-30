# SVC-001 — Desired-state service schema and API — RESULT

**Epic:** E9 · **Lane:** B (`C:\e8`) · **Start SHA:** `70945d614` (design) · **Tip:** `2e7a8be15`
**Status:** **COMPLETE — CI GREEN** at `e974364d2` (all 13 jobs, run conclusion `success`).
**Docs:** [terrain](./SVC-001-terrain.md) · [design](./SVC-001-design.md)

---

## 1. Acceptance clause → named executable artifact

| Clause | Delivered | Evidence | Red state it went green from |
|---|---|---|---|
| (a) updates create a new immutable generation | **Yes**, by grant omission + `ON DELETE RESTRICT` | `service_generations` (0264); `SERVICE_GENERATIONS_NEW_PATH_GRANTS` = `SELECT, INSERT`; 4 tests in `service-desired-state-schema.integration.test.ts` | table did not exist |
| (b) desired state and memory/context tenant + actor scoped | **Storage half only** | FORCE RLS + triple-composite FK + `services_org_company_id_uq` | `services` had only `(org, id)`; nothing bound company |
| (c) workers get no DB credentials or memory-table access | **Structurally unchanged, still true** | no new grant to any worker role | n/a — no claim made |
| (d) no public port/ingress configuration accepted | **Yes**, at submission | `service` slot `not_enforced → enforced`; `SERVICE_INGRESS_DENY_KEYS`; 22 tests | `{"port": 8080}` was accepted **201** and then never leased |

Plus the ticket's four named tests — schema, authorization, generation, invalid-ingress — each
starting from a real red state, not a vacuous one.

## 2. The decision taken on the record: C-prime

The design's §2 fork is settled. **The envelope `deadline` is the bound on this attempt's leased
session, not the service's TTL.** Service TTL is control-plane state on `services`, enforced by
the reconciler; **leases stay SHORT at the 300 s default, precisely because the lease-renew
response is the only channel by which a stop reaches a worker.**

The terrain's own recommendation ("make service leases long") was **refuted during design** and is
corrected in place. It failed twice independently: `leaseDurationMs` has no per-workload seam
outside the do-not-touch file and the only lever outside it is global (a 72 h lease makes a crashed
**batch** worker's job unreclaimable for 72 hours), and it contradicts itself, since a long lease
makes renewals rare and therefore the TTL stop *slower*.

What makes C-prime honest rather than a rationalisation: **no worker reads `envelope.deadline`.**
`graceful_stop`/`checkpoint` even carry a `deadline` on the frozen wire that no delivery path can
convey. So the correct statement is not "the deadline is wrong for services" but **"the deadline is
not the enforcement mechanism for any workload class"** — recorded once here so SVC-003 does not
rediscover it.

**Residual, and it is real:** TTL granularity is the renewal cadence (~300 s), not an instant.
**SVC-005's acceptance must assert a bound, not immediacy.**

## 3. The HIGH defect the design review caught, proven by mutation

Two of three design lenses cascaded generations from `services`. `aoa_app` holds `DELETE` on
`services`, and **a referential action executes with the constraint's rights, not the caller's** —
so a cascade erases every row clause (a) declares immutable while `aoa_app` holds no `DELETE` on
the table.

Proven, not argued. With the FK mutated to `CASCADE`:

| Test | Under the CASCADE mutant |
|---|---|
| `aoa_app` may INSERT | ✅ still green |
| `aoa_app` may not UPDATE → 42501 | ✅ **still green** |
| `aoa_app` may not DELETE → 42501 | ✅ **still green** |
| ★ parent delete leaves generations intact | ❌ red |
| FK is not CASCADE | ❌ red |

The three obvious immutability tests **cannot see** the path that erases the rows.

**Measurement corrected the assertion:** the parent delete raises **`23001 restrict_violation`**,
not `23503`. That is *stricter* — Postgres raises 23001 only for an `ON DELETE RESTRICT` action,
while `NO ACTION` raises 23503 — so the code proves the FK is genuinely RESTRICT.

## 3a. ★ The defect that cost three CI rounds — a certificate that compares KEY ORDER

`verify` failed deterministically (32 failures, three runs, byte-identical) with every failure
wrapped as the opaque `distributed_execution_app_authority`. The cause was mine, in one commit
(`ea3064722`), traced by `git log -L` on both offending lines.

**`exactJson` is `JSON.stringify(a) === JSON.stringify(b)` — ORDER-SENSITIVE on object keys.**
`assertExactCatalogCertificate` builds `actualPolicyCounts` by mapping over `RLS_RELATIONS`, so its
key order IS that array's order, then compares it to `POLICY_COUNTS`. SVC-001 registered
`service_generations` **last** in `RLS_RELATIONS` (index 25) and **beside `services`** in
`POLICY_COUNTS` (index 5). Identical keys, identical values, different serialization →
`catalog certificate drift: policy counts`.

```
before:  exactJson equal? false | same keys? true
         first divergence idx 5: RLS='service_instances'  PC='service_generations'
after:   exactJson equal? true
```

### Why eight clean diagnostics missed it — the lesson worth keeping

Two diagnostics, run on both platforms, reported **every** comparison clean: table privileges,
schema privileges, RLS and FORCE RLS inventories, policy counts, policy rows, relation ACL tuples,
column ACL nullness. All empty, including on the failing Linux runner.

They compared policy counts **BY KEY** — `Object.entries(POLICY_COUNTS).filter(([k,v]) => actual[k]
!== v)` — which is **structurally blind to key order**. The right thing was measured the wrong way,
three times.

The deeper error was the search strategy: the failing comparison is a **pure in-process JS fact
with no database input at all**. Probing real databases — done extensively, on two platforms —
could never have found it. What found it was enumerating *what the code asserts* instead of *what
the database contains*.

### The guard existed, and was asymmetrically blind

`job-control-legacy-grants.contract.test.ts` mirrors both constants:

```js
expect(manifest.RLS_RELATIONS).toEqual(rls);      // ARRAY  → order-SENSITIVE
expect(manifest.POLICY_COUNTS).toEqual(counts);   // OBJECT → order-BLIND
```

The mirror carried the correct order all along; the production constant did not; and the only
assertion joining them could not see the difference. That asymmetry also **uniquely determines the
fix**: `POLICY_COUNTS` must move, because moving `RLS_RELATIONS` would fail the order-sensitive
array assertion instead.

**The fix is two parts and the second matters more:**

1. `POLICY_COUNTS`' key moved to the end, matching `RLS_RELATIONS`.
2. An order-sensitive assertion added beside the order-blind one —
   `expect(Object.keys(POLICY_COUNTS)).toEqual([...RLS_RELATIONS])` — which fails on the unfixed
   constant and passes on the fixed one. The next person to add a distributed table learns this in
   seconds. Both constants now carry a comment saying order is load-bearing.

**No second latent order fault:** `POLICY_COUNTS` was the only hand-ordered side of an
`assertExactJson`; the other eight call sites derive both sides from sorted lists — verified at
runtime, including the relation-ACL and column-ACL manifests that only become reachable once this
one passes.

**Refuted along the way, and recorded so nobody re-treads it:** the same suite's earlier failure at
`a4b7ed22f` (which predates SVC-001) is a *different* test with a different mechanism — a
port-collision flake — and passes in every post-SVC-001 run. The base-rate argument built on it was
unsound.

## 4. Mutation testing — and three checks that could not evaluate anything

Every new guard was mutated. Three findings were defects **in my own tests**, all caught before
merge:

1. **The deny-set's per-key tests SHRINK silently.** They are generated by iterating
   `SERVICE_INGRESS_DENY_KEYS`, so deleting `"port"` — the key this ticket's clause literally
   names — does not fail a test, it **deletes that key's test**, and the suite stays green with one
   fewer case (21 → 20). Fixed with an explicit core-key assertion outside the loop.
2. **The end-to-end stamping proof was vacuous, for two independent reasons.** The fixture sent the
   *same* `serviceId`/`generation` the source carried, so the stamp was a no-op — disabling
   stamping entirely left the suite green at 32/32. And the assertion had been placed inside a
   `test.each` whose source list does not include `service_reconcile`, so it never ran at all.
   Fixed by a decoy identity (`SERVICE_DECOY` / generation 99 vs the authorized `SERVICE_A` /
   generation 1) and by moving the assertion into the test that actually submits a service job. The
   same mutant now fails.
3. **One FALSE survivor, recorded as such.** The first attempt at emptying the deny-set wrote
   `[].length ? [] : [...]`, which evaluates to the original array — a no-op mutant, not a weak
   test. Re-run properly, it was killed.

**The named 0264 replay test earned its place immediately** by catching a real idempotency defect in
my own migration: a `UNIQUE` constraint materialises an **index**, so a replay raises
`duplicate_table`, not `duplicate_object`, and the guards caught only the latter. `migrations` would
have passed on first apply while `migration-idempotency` and `readiness` failed. Necessary rather
than belt-and-braces — the static check in that file matches only `CREATE TABLE|INDEX`, so
`ADD CONSTRAINT` and the data backfill are covered by nothing.

## 5. What clause (d) does NOT buy

It governs **declarative configuration, not reachability.** E2B serves arbitrary in-sandbox ports
to the public internet unauthenticated at a URL derivable from the sandboxId (measured,
`BRW-002-terrain.md` §1). **A service that merely LISTENS is publicly reachable with no ingress
configuration at all.** A green clause (d) must not be read as "services cannot be publicly
reached".

`args` is therefore deliberately **not** scanned for `--port`: it would not close the reachability
path and *would* break legitimate services that bind a port internally. A test asserts that
non-behaviour so nobody later hardens it into theatre.

## 6. Scope-outs — stated so the table above cannot be misread

- **Instance identity is TWO of THREE fields.** `serviceWorkloadV1Schema` requires `serviceId`,
  `serviceInstanceId` and `generation`; `serviceReconcileSourceSchema` carries **no
  `serviceInstanceId`**, so nothing authorized exists to stamp it from and it stays
  caller-controlled. Nothing downstream rescues it: `service_instances` has no `company_id` and
  `getById` filters on `id` alone. **A test asserts the attacker-supplied instance id survives.**
  → SVC-002/SVC-003.
- **Clause (b)'s memory/context half is NOT delivered.** No `actorContextPolicyId` column ships,
  because nothing would read it: `MemoryActor` has no `service` kind, no memory or context
  operation exists among the ten frozen worker operations, and the one candidate host-side
  pre-stage (`stageCodingRun`) has **zero production callers** — refuting the terrain's claim that
  a shipped substitute exists. → SVC-003 by name.
- **"instance" beyond two constraints.** The Outcome names it first-class; this delivers a CHECK
  reconciliation and `unique(organization_id, id)`. No `company_id`, no job/attempt/lease linkage.
- **Produced checkpoints.** Generations store a restore-*input* pointer only.
  `job_control_commands_kind_check` permits five of the frozen six kinds — **`checkpoint` was
  omitted** when `0240` widened three→five — so a checkpoint request cannot be persisted at all.
  → SVC-004, which depends on it. Also `job_artifacts` has only *partial* uniques, which cannot be
  FK targets.
- **The 3-attempt ceiling** → SVC-002. `allocateRetryAttempt` has zero production callers.
- **`ServiceHealthStatus`** narrowed to *removing* `interrupted` only; widening it would take
  SVC-003's scope on a governed fence mutator.

## 7. Deployment honesty and CI status

Clause (a)'s mechanism binds on the `aoa_app` pool. It is **"unexercised flag-off; enforced on the
`aoa_app` pool flag-on"** — *not* "unenforced by default": `app.ts:437-447` mounts the entire
job-control surface only when `distributedExecutionEnabled` and refuses owner fallback by name.

**Local:** 104 tests green across the five affected suites; `migration-idempotency` 7/7;
distributed-execution foundation PASS; guard + test inventories OK; typecheck clean.

**CI: GREEN.** All 13 jobs pass on `e974364d2`, run conclusion `success` — `verify`, `browser`,
`policy`, `migrations`, `e2e`, `e2e-pgvector`, `lint`, `brand-check`, `distributed-contract`,
`changes`, both `worker-protocol-contract-bytes` legs, and `ci-required`.

Getting there took two fixes after the implementation was done, both recorded above: the
`POLICY_COUNTS` key-order defect (§3a) that took `verify` from 32 failures to 0, and the browser
lane's SIGKILL-reaps bound, raised from an arbitrary 30s to 90s with a surviving-process dump on
failure. The assertion was not weakened — reaping is still required; only the bound moved, and the
next failure will say which of "slow" or "never" it is.

The D1 nonce was bumped to `svc-001-service-generations` AFTER the last `server/src` change, per
the rule that file keeps proving. The key-order fix in particular needs live proof: it governs
whether a distributed-execution server starts at all, and it failed only on the flag-ON path that
the D1 lane is the only thing to exercise.

## 8. Registration surfaces touched

`PLAN_DERIVED_ACL_MATRIX`, `POLICY_COUNTS`, `RLS_RELATIONS`, `RLS_POLICY_MANIFEST`,
`RELATION_ACL_NULLNESS_CERTIFICATE`, `appTablePrivileges()`, the schema barrel export, and the
contract test's **independent copies** of the same certificates.

**`JOB_CONTROL_NEW_PATH_GRANTS` was deliberately NOT touched** — it reconstructs the immutable
migration 0214 and has no exclusion mechanism. I checked which constant owned the line before
editing; it was that one.
