# DECISION REQUEST — where a denial with no FK-valid tenant goes

**Answers:** `E0-F013` → *"Decisions this slice did not take"* → **Decision 2**
(`docs/replatform/epics/E0-foundation/findings.md`).
**Date:** 2026-09-09. **Measured at:** `fffc7e1de` (PR #396, the DE-06 landing + re-triage merge).
**Status:** OPEN — awaiting a founder ruling. **Changes no finding's status and wires no code.**

> **★ ADDENDUM, 2026-09-09 — the two "needs a unit, not a ruling" groups are now WIRED (Unit C).**
> The scheduling consequence in the headline below has been acted on: DE-06's `:122` tuple-integrity
> throw and DE-21's agent-key disjuncts (`:395` in full, `:376`'s tenant-mismatch arm only) now write
> durable attributable rows, provoked through the real path against real PostgreSQL. **This changes
> nothing this decision owns.** DE-03 in full, FIVE of DE-06's six fence throws, and DE-15 are still
> blocked here; DE-21's board/session half is still Decision 3's; neither DE-06 nor DE-21 closes,
> and no cohort count moves. Two of the addendum's measurements correct this paper:
> **(a)** §1.2's suggestion that `:358` may be includable is REJECTED — measured at the line, the
> membership array is EMPTY in the probe shape and plural-and-unrelated otherwise, so `:358` stays
> with Decision 3; **(b)** at `:122` only ONE of the seven mismatch conjuncts
> (`provider_constraint_hash`) can be provoked by a legal row — five are inside
> `lockLeaseAckContext`'s own WHERE and land on `:110`, and `target_authority_key` is FK-pinned from
> both sides. Full record: `epics/E0-foundation/findings.md`, "★ UNIT C".

**Queued behind this decision:** four clause-halves — **DE-03**, **DE-21's board/session half**,
**DE-15**, and **DE-06's fence-resolution throws** (the fourth was added by PR #396's own
measurement). ★ **None of the four is wholly unblocked by the measurement below** — an earlier draft
of this paper claimed two were, and the headline that follows retracts it. What the measurement does
move is *individual deny sites* inside them, and DE-21's board half's *blocker*.

---

## ★ THE HEADLINE — ONE THROW OF SIX IS ALREADY RESOLVABLE, DE-21'S AGENT-KEY BRANCHES WERE NEVER QUEUED, AND DE-21'S BOARD HALF IS BLOCKED BY DECISION 3

**★ RETRACTED AND RE-COUNTED, 2026-09-09.** The first draft of this paper headlined *"two of the
four are not blocked"*. That is arithmetic this paper's own §1 refutes, and it errs in the direction
that flatters the recommendation, so it is withdrawn here rather than footnoted. It counted **one**
of DE-06's **six** throws as unblocking the DE-06 half (§1.4's own verdict is 1-of-6 resolvable,
5-of-6 residue), and it counted DE-21's **agent-key** branches — which the register's own
2026-09-09 amendment had already placed *outside* the queued half ("DE-21's share of this decision
is its board/session half only … because its agent-key branches DO resolve an FK-valid prober
tenant"). **On the register's own four halves — DE-03, DE-21's board/session half, DE-15, DE-06's
fence-resolution throws — ZERO are wholly unblocked by this decision.**

The finding underneath the bad arithmetic is real, and it is this:

1. **DE-06's fence half is 1/6 resolvable — and therefore still blocked as a half.**
   `resolveWorkerFenceContext` has **six** throw sites, not one. At the sixth
   (`worker-fence-context.ts:122`, the post-resolution tuple-integrity branch)
   `context.lease.companyId` is **DB-resolved and FK-valid** (`leases.company_id` is *nullable* in
   the schema — see §1.4 for why that branch nevertheless cannot be reached with a null). That one
   throw needs a unit, not a ruling; the other five stay in the residue.
2. **DE-21's agent-key branches are resolvable today — confirming, not subtracting.**
   `authorizeUpgrade` has **seven** `return null` deny branches, not one. At `live-events-ws.ts:395`
   both `key.companyId` and `agent.companyId` are DB-resolved and FK-valid; at `:376` the
   `key.companyId !== companyId` **disjunct** is, but its `!key` disjunct is not (see §1.2). PR #396
   and the register had already excluded this half from the four; measuring it at the line adds
   precision and removes nothing from the count.
3. **DE-21's board/session half is blocked — but by Decision 3, not by this decision.** This is the
   only one of the four whose *blocker* moves wholesale, and it moves rather than clears: its
   company is decidable by one SELECT (§1.2), so what is undecided is *whose log a probe lands in*.
4. **DE-15's "no tenant at all" is FALSE as written.** At the drain return
   (`job-leasing.ts:731-740`) the poll holds a token-attested `organizationId` **and** a
   `candidates` array whose rows carry the **full `jobs` row** including a NOT NULL, FK-valid
   `companyId` (`job-control.ts:1930-1941`, `select({ job: jobs, … })`). The right description is
   **"an organization and zero-or-many companies"**, not "no tenant". That is a different
   blocker and it argues for a different fix.

**The scheduling consequence survives the recount, and it is the point.** Two pieces of work that
are recorded as waiting on a founder ruling are not waiting on anything: DE-06's `:122` throw and
DE-21's agent-key branches can be wired today. And one of the four halves is queued against the
wrong decision. None of that is "two of four unblocked", and the register should say what is
actually true.

**What this decision genuinely owns is the ORGANIZATION-ONLY RESIDUE.** DE-03 in full, five of
DE-06's six fence throws, and DE-15's kill verdict all hold a
**verified organization** and no singular company — because `organization → company` is **1:N and
therefore not a function**: `companies.organization_id` is `notNull().references(organizations.id)`
(`companies.ts:20`) and the only unique constraint over it is the composite
`companies_org_id_uq (organization_id, id)` (`companies.ts:87`). There is no reverse lookup to
select, not merely one not currently selected.

---

## §1 — The four sinks, measured at the deny site

Legend for the provenance column, which is a **three-way** distinction and not the two-way one the
finding's prose uses:

- **caller-supplied** — arrives on the wire, unvalidated at that point.
- **token-attested** — carried in a signed artefact the control plane itself minted and verified
  (`verifyWorkerOperationProof` → `verifyWorkerSessionToken`, `worker-operation-proof.ts:47-60`).
  Trustworthy for attribution; **not** proof that a matching row still exists.
- **DB-resolved** — read out of a row in this transaction. Only this class is FK-valid by
  construction.

### 1.1 DE-03 — replay rejection / unenrolled worker

`recordProof` (`packages/db/src/repositories/tenant/worker-enrollment.ts:267-277`, the
`onConflictDoNothing().returning()` → `rows.length === 1`), refused at **nine** production call
sites: `worker-session-auth.ts:151`, `job-control-ack.ts:93`, `job-events.ts:169`,
`job-fencing.ts:133`, `job-leasing.ts:546` and `:816`, `worker-enrollment.ts:315`,
`worker-fence-context.ts:68` and `:162`.

| In hand at the throw | Provenance | Tenant axis |
|---|---|---|
| `auth.organizationId`, `auth.workerId`, `auth.targetId`, `auth.deviceThumbprint`, `auth.proofId` (~~eight~~ **SEVEN** session-bound sites — see the correction below) | **token-attested** | organization |
| `authoritativeOrganizationId` (the enrollment site, `worker-enrollment.ts:315`) | **DB-resolved** from `worker_enrollment_code_routes.candidate_organization_id` (`:289-294`) — **but typed `string \| null`** | organization, or none |
| Any company | — | **absent** |

A pre-code refusal (`worker-enrollment.ts:295`, expired/unknown route) has **no organization
either**. `workers.organization_id` (`workers.ts:26`) and `execution_targets.organization_id`
(`execution_targets.ts:25`) are the only tenant columns on the identities in play, and both are
themselves nullable for platform scope.

**Verdict: genuinely unresolvable on the company axis.** Resolvable on the organization axis at
eight of nine sites, and at the ninth only when the enrollment code was org-routed.

> ★ **CORRECTION, 2026-09-09 (PR #403, the sink unit).** The two sentences above are wrong in the
> ruling's favour and are corrected here rather than left for a reader to inherit. Re-measured at
> the nine `recordProof` call sites: **SEVEN** always carry a non-null, token-attested organization
> (`job-control-ack.ts:93`, `job-events.ts:169`, `job-fencing.ts:133`, `job-leasing.ts:546` and
> `:816`, `worker-fence-context.ts:68` and `:162`). **TWO** are conditionally doubly-null, not one:
> `worker-enrollment.ts:315` (unrouted enrollment code) **and**
> `server/src/`**`middleware`**`/worker-session-auth.ts:151`, which this paper lists above among the
> session-bound sites — it is in `middleware/`, not `services/`, its
> `authoritativeOrganizationId` is typed `string | null`, and its
> `claims.organizationId === null` branch (`:183-185`) passes an explicit `null` for a
> platform-scope worker (invariant at `:72`). The separate pre-code refusal at
> `worker-enrollment.ts:295` is doubly null too and is **not** one of the nine. The ruling and the
> landed schema are unaffected; the count of what (a2) buys is. Full measurement:
> `docs/replatform/epics/E0-foundation/findings.md`, E0-F013 Decision 2.

### 1.2 DE-21 — WebSocket upgrade refusal, `authorizeUpgrade` (`live-events-ws.ts:251-407`)

Seven `return null` branches. The finding treats them as one; they are not one shape — and branch 6
is itself a two-arm `||` whose arms differ, so the table below has **eight** rows for seven
`return`s.

| # | Branch | What is in hand | Provenance | FK-valid company? |
|---|---|---|---|---|
| 1 | `:293` mode has no session resolver | `companyId` from `parseCompanyId(url.pathname)` | caller-supplied | **verifiable, not verified** |
| 2 | `:304` untrusted / missing `Origin` | `companyId`, `origin` | caller-supplied | same |
| 3 | `:311` no session → no `userId` | `companyId` | caller-supplied | same |
| 4 | `:322` `cloud_auth`, `hasActiveCloudMembership` false | **`userId`** | **DB-resolved** (session) | probed company: verifiable. Actor's own: not selected |
| 5 | `:358` `authenticated`, no `instance_admin` row **and** no membership | **`userId`** and **`memberships[]`** — the actor's own company ids, already SELECTed at `:343-352` | **DB-resolved** | ★ **YES — the actor's own company ids are literally in the local variable** |
| 6a | `:376` `!key` — token matches no live `agent_api_keys` row | `companyId` from the path only. **No key row, so no DB-resolved company at all** | caller-supplied | **NO** |
| 6b | `:376` `key.companyId !== companyId` — key exists, wrong tenant | **`key.companyId`** | **DB-resolved** (`agent_api_keys`) | ★ **YES** |
| 7 | `:395` agent missing / wrong tenant / `terminated` / `pending_approval` | **`key.companyId`**, and `agent.companyId` on the tenant-mismatch disjunct | **DB-resolved** — `key` is non-null on *every* disjunct of `:391-394`, because `:376` already returned | ★ **YES** |

★ **THE UNIT OF CORRECTION IS THE DISJUNCT, NOT THE BRANCH.** Branch 6 is a two-arm `||` and the
two arms differ on exactly the axis this decision turns on. `!key` — an unknown, revoked or
malformed token — is the **dominant probe case**, and it resolves *nothing*: the SELECT returned no
row, so there is no `key.companyId` to attribute to, and only the caller-supplied path segment is in
hand. Branch 6 therefore **splits**; it does not close. Branch 7 does close on every disjunct,
because control only reaches `:391` when `key` is non-null.

**Verdict: branch 7 closes; branch 6 splits; branches 1–5 are Decision 3's.** The agent-key half is
wireable today with no schema change and no ruling **for `:395` and for `:376`'s tenant-mismatch arm
only** — `:376`'s `!key` arm lands in the same bucket as branches 1–4 (caller-supplied, decidable by
one SELECT, and then a *disclosure* question rather than a storage one). Branch 5 holds an FK-valid company of
a *different kind* (the actor's own tenants, plural) — usable, but it needs an attribution rule.
Branches 1–4 hold a **caller-supplied but decidable** company: one `SELECT id FROM companies WHERE
id = :companyId` separates "probe against a real tenant" (the interesting case, FK-valid) from
"probe against a random uuid" (uninteresting). **So what actually blocks DE-21's board half is not
Decision 2 (no FK-valid tenant) — it is Decision 3 (whose log does a cross-tenant probe land in).**
The register should say the true blocker.

### 1.3 DE-15 — kill-switch drain (`job-leasing.ts:731-740`)

| In hand at the `return` | Provenance | Notes |
|---|---|---|
| `pollInput.auth.organizationId` | **token-attested** | present on every call |
| `guardedAuthority.currentTarget.kind`, `normalizedCurrentTarget.*` | **DB-resolved** | `execution_targets` — organization axis only |
| `candidates[].job` — **the whole `jobs` row**, including `companyId` (NOT NULL) | **DB-resolved** | `lockEligibleLeaseCandidates`, `job-control.ts:1930-1941`. ★ **0..N of them** |

The kill verdict is evaluated **after** candidate selection and **before** any claim, so the array
is in scope and may be empty.

**Verdict: the tenant is not ABSENT, it is NOT SINGULAR.** And attributing a fleet-wide provider
kill to one arbitrary queued job's company would be a **category error**: no company was refused
anything — the *worker* was told to drain, and the audited fact ("image admission, scan, and kill
events") is a property of the provider, not of a tenant. DE-15's correct home is the organization
axis, which `activity_log` has no column for.

### 1.4 DE-06 — the fence-resolution throws (added by PR #396)

`resolveWorkerFenceContext` (`worker-fence-context.ts:59-135`), shared by **four** services:
`artifact-commit.ts:162`, `artifact-transfer-grant.ts:115`, `patch-apply.ts:101`,
`secret-broker.ts:269`.

| Throw | Code | In hand | Provenance | Company? |
|---|---|---|---|---|
| `:75` | `unauthorized` (proof replay) | `auth.*` | token-attested | **no** |
| `:89` (`!authority`) | `unauthorized` | `auth.*` | token-attested | **no** |
| `:89` (`authority` present) | `target_revoked` | `authority.worker` + `authority.target` | **DB-resolved** (`lockWorkerLeaseAuthority`, `job-control.ts:1846-1895`) — **organization only**, verified against the selected column list | **no** |
| `:92` | `target_revoked` (target inactive) | same | **DB-resolved**, organization only | **no** |
| `:97` | `target_revoked` (profile drift) | same | **DB-resolved**, organization only | **no** |
| `:110` | `stale_fence` (`!context`) | same — the lease is exactly what failed to resolve | **DB-resolved**, organization only | **no** |
| `:122` | `stale_fence` (tuple integrity) | ★ **`context.lease.companyId`** | **DB-resolved** | ★ **YES — but see the correction below; NOT because the column is `NOT NULL`** |

★ **CORRECTED: `leases.company_id` is NULLABLE, and `!context.lease.companyId` is the FIRST arm of
the very condition that throws at `:122`.** An earlier draft justified this row with "the column is
NOT NULL". That is schema-false: `packages/db/src/schema/leases.ts:28` declares
`companyId: uuid("company_id")` with **no `.notNull()`** — deliberately, for pre-JOB-003 kernel rows
(the `leases_authority_atomic_check` all-or-nothing CHECK at `:53` is what keeps the rich tuple
complete). And `worker-fence-context.ts:111` reads
`if (!context.lease.companyId || … ) throw new JobLeasingError("stale_fence")` — so a null company is
one of the eleven disjuncts that *causes* the `:122` throw.

**The verdict survives; the reason has to change.** A lease with a null `company_id` cannot reach
`:122` at all, because `lockLeaseAckContext`
(`packages/db/src/repositories/tenant/job-control.ts:2397-2418`) resolves the context through
`innerJoin(jobAttempts, … eq(jobAttempts.companyId, leases.companyId) …)`, and
`jobAttempts.companyId` is `NOT NULL` (`job_attempts.ts:19`). SQL `NULL = <anything>` is never true,
so a null-company lease **never joins**, `context` is null, and the refusal lands on **`:110`**
(`!context`) — which is already counted in the org-only residue. Every lease that arrives at `:122`
has a joined, FK-valid company.
★ **What this costs the wiring unit:** the TypeScript type at `:122` is still `string | null`, so a
recorder call there needs a **runtime narrow** (and a test that pins the `:110` vs `:122` landing —
§3(d) already warns that PR #396 got exactly that fixture wrong once).

★ **One more thing is in hand and the finding does not say so:** `presented.jobId` is
caller-supplied, and the whole call runs inside `runInTenant` under the worker's own org GUC.
`jobs` is `FORCE ROW LEVEL SECURITY` with
`USING (organization_id = current_setting('aoa.organization_id', true)::uuid)`
(`0211_tenant_rls_enforcement.sql:20-28`). **A `jobs → company_id` lookup therefore CANNOT be aimed
at a foreign tenant: RLS fails it closed.** That narrows option (c)'s attack (see §3.3) — it does
not eliminate it.

**Verdict: 1 of 6 resolvable today; 5 of 6 are organization-only residue.**

### 1.5 The measured summary

**The rows are conjuncts and disjuncts, not clause-halves.** A half is only unblocked when *every*
deny site inside it is, and on that test **none of the four queued halves is unblocked** — the
rightmost column below is per deny site, and the roll-up follows it.

| Deny site | Company FK-valid at the deny site? | Blocked by Decision 2? |
|---|---|---|
| DE-06 fence, `:122` (1 of 6) | **Yes**, DB-resolved via the `job_attempts` join (not via a NOT NULL column) | **No.** Needs a unit, not a ruling |
| DE-06 fence, `:75/:89×2/:92/:97/:110` (5 of 6) | No — organization only | **Yes** |
| DE-21 branch 7 (`:395`, agent key) | **Yes**, DB-resolved on every disjunct | **No.** Needs a unit — **and was never inside the queued half** |
| DE-21 branch 6b (`:376`, `key.companyId !== companyId`) | **Yes**, DB-resolved | **No.** Same — outside the queued half |
| DE-21 branch 6a (`:376`, `!key` — the dominant probe case) | No — **no key row exists**, only the caller-supplied path segment | **No — Decision 3**, with branches 1–4 |
| DE-21 branch 5 (`:358`, `authenticated` board) | **Yes**, but plural (actor's own tenants) | Needs an attribution rule; not a storage ruling |
| DE-21 branches 1–4 (board/session probe) | Caller-supplied, **decidable** by one SELECT | **No — blocked by Decision 3**, not Decision 2 |
| DE-03 (all nine sites) | No — organization only, sometimes none | **Yes** |
| DE-15 | No — organization + 0..N companies | **Yes** |

**Roll-up onto the register's four halves:**

| Queued half | Status after this measurement |
|---|---|
| DE-03 | **Blocked by Decision 2**, in full |
| DE-15 | **Blocked by Decision 2** — and its clause is *also* mis-worded ("no tenant at all") |
| DE-06's fence-resolution throws | **Still blocked** — 5 of 6 throws are residue. One throw (`:122`) leaves early |
| DE-21's board/session half | **Blocked — by Decision 3**, not by this decision. The blocker moves; the half does not clear |

**Zero of the four are wholly unblocked by Decision 2.** DE-21's agent-key branches are resolvable
but were already excluded from the four by the register's own amendment, so they subtract nothing.

---

## §2 — What `activity_log` actually is (storage facts, measured)

| Fact | Evidence |
|---|---|
| `company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE` | `packages/db/src/schema/activity_log.ts:10` |
| **No `organization_id` column** | same file, whole table |
| **Not in the RLS kernel** — no `ENABLE`/`FORCE ROW LEVEL SECURITY`, no policy, ever | `0245_job_activity_audit_rls.sql:15-18` states it deliberately; a sweep of all migrations for `activity_log` + `ROW LEVEL`/`POLICY` returns **zero** hits |
| `aoa_app` holds **`SELECT, INSERT` only** — no `UPDATE`, no `DELETE` | `0213_e2_serving_role_correction.sql:98`, `0214_e2_serving_role_hardening.sql:166` |
| ★ **CORRECTED. 14** `.from(activityLog)` read sites outside tests; **12** filter `eq(activityLog.companyId, …)` | `activity.ts:39` (`list`) and `:143` (`issuesForRun`), `cockpit.ts:514`, `costs.ts:230`, `home.ts:181`, `proactive.ts:478`, `memory-feedback.ts:54`, `productivity-review.ts:227/:239/:253`, `github.ts:74`, `seed-commander-review.ts:270` (dev seed). *An earlier draft said 11 and 10, and missed `activity.ts:143` in the scoped set and `forIssue` entirely* |
| ★ **TWO** company-unscoped readers, not one | `marketplace-reconcile.ts:1649-1656` (`entityType='marketplace_reconciliation'` + `entityId`) **and `activityService.forIssue`, `services/activity.ts:60-70`** |
| ★ **`forIssue` is a LIVE cross-company read path.** It filters **only** `eq(entityType,'issue')` + `eq(entityId, issueId)` — no company predicate at all — and is exposed at `GET /issues/:id/activity`, which gates on **the ISSUE's** company (`assertCompanyAccess(db, req, issue.companyId)`), not on the row's | `services/activity.ts:60-70`, `routes/activity.ts:88-98` |
| ★ …and `entityType`/`entityId` are **caller-supplied free text on the denial recorder**, constrained by nothing | `security-denial-audit.ts:103` and `:105` (the interface fields), `:145-146` (passed straight into the insert), `:170-171` (echoed on the failure log) |
| ★ **No production reader of `security.denied.*` exists anywhere** | grep over `server/src` + `ui/src`: only the two writers, the namespace guard, and prose |
| …but denial rows **do** surface in the generic company Activity feed: `activityService.list` applies **no** action-prefix filter, and `GET /companies/:cid/activity` gates on `assertCompanyAccess` — **any company member**, not founder-only | `services/activity.ts:18-57`, `routes/activity.ts:45-47` |
| **Attribution precedent already set**: both live writers attribute to the **actor's own** tenant, never the probed one | DE-19 uses `ctx.companyId` (`read-tools.ts:299`); DE-06 uses the **locked lease's** company and its test asserts the probed tenant's `activity_log` is **empty** |
| There is **no sentinel/system company row** to borrow. `organizations` has a `slug = 'default'` sentinel; `companies` has none | `organizations.ts:11`, `companies.ts:11-20` |

**One adjacent observation, deliberately not claimed as a resolution.** Decision 3(b) says a hostile
tenant can cascade-delete their own denial history. `aoa_app` has **no `DELETE` on `activity_log`
and no `DELETE` on `companies`** (`0213:68`, `0214:136` grant `SELECT, UPDATE` only), while
`companies.ts:656-659` contains an application delete path that explicitly issues
`tx.delete(activityLog)`. Those two facts do not agree, and which role that transaction runs as was
**not measured here**. It belongs to Decision 3 and needs its own unit. It is recorded so nobody
reads the grant fact alone as an exoneration.

---

## §3 — The options

Each is scored against the **residue** that Decision 2 actually owns (DE-03, DE-15, DE-06's five
org-only throws) and against the individual **deny sites** §1 showed are already resolvable — deny
sites, not clause-halves; §1.5's roll-up shows why the distinction matters.

### (a) Make `activity_log.company_id` nullable

- **Unblocks:** the whole residue — DE-03, DE-15, DE-06's five throws — as *tenantless* rows.
- **Cost:** one `db:generate` migration (`ALTER COLUMN company_id DROP NOT NULL`). Drizzle emits it;
  **no hand-authored DDL**, so C14 is not engaged.
- **RLS posture:** unchanged — the table is outside the kernel by design (`0245:15-18`), so there is
  no policy to widen and no `USING` clause to reason about. A tenantless row is readable by
  `aoa_app` with no gate.
- ★ **RETRACTED: "readable by nobody, through any existing surface".** That sentence was in the first
  draft of this option and it is **false**. It rested on a reader inventory that had missed
  `activityService.forIssue` (`services/activity.ts:60-70`), which filters **only**
  `entityType='issue'` + `entityId` and is served at `GET /issues/:id/activity` behind
  `assertCompanyAccess` on **the issue's** company (`routes/activity.ts:88-98`). `entityType` and
  `entityId` are **caller-supplied free text** on `recordSecurityDenial`
  (`security-denial-audit.ts:103/:105 → :145-146`), so a **tenantless row typed `issue` whose
  `entityId` is a real issue's uuid is returned to every member of that issue's company** — a route
  gated on someone else's tenant, reading a row that has none.
- **What can actually read a tenantless row, corrected:** the **twelve** company-scoped readers
  cannot (a NULL never matches `eq(companyId, X)`); `marketplace-reconcile.ts:1649` needs
  `entityType='marketplace_reconciliation'`; **`forIssue` needs only `entityType='issue'` and a
  matching `entityId`.** Today's two live writers type their rows `memory_item`
  (`read-tools.ts:305`) and `job_artifact` (`artifact-commit.ts:358`,
  `artifact-transfer-grant.ts:343`), so the collision is **latent, not live** — but nothing in the
  recorder, the namespace guard or a test prevents the next writer from typing a refused task
  `issue`, and a refused task read is an obvious next crossing.
- ★ **What that means for this paper's recommendation** (and not as a footnote): the claim
  *"non-disclosure of tenantless evidence is the default rather than something to build"* — a load-
  bearing bullet in §4's case for (a2) — **does not hold**. Non-disclosure has to be **built**. This
  does not disqualify (a2): the exposure is a pre-existing property of `forIssue`, it is latent
  under today's writers, and option (b) inherits *nothing* here only because a new table has no
  reader at all. It does two things. First, it adds a **third acceptance condition** to the ruling
  (§4.4c): either `forIssue` becomes company-scoped, or the denial namespace is barred from
  entity types that an unscoped reader keys on — with a test. Second, it shows that
  **Decision 3's question re-enters through the option this paper recommends**: a tenantless row is
  not automatically undisclosed, so "whose log does this land in" is not deferrable merely by
  declining to name a company.
- **Cascade semantics:** a NULL row **does not cascade**. For the evidence class most exposed to
  Decision 3(b), that is a strict improvement.
- **Breaks:** nothing at read time. What it costs is an **invariant**: today `NOT NULL` is the only
  thing that catches a product writer omitting `companyId`, across **34** direct
  `insert(activityLog)` sites — and `E0-F013` has already recorded the decision **not** to ship a
  static guard over those writers. Relaxing the column relaxes it for all thirty-four.
- **Proof:** a migration test that the column is nullable; a recorder test that a null-company
  denial inserts; a **positive control** that every company-scoped reader still returns the same
  rows with a tenantless row present; ★ and a **negative control on the unscoped path** — a
  tenantless denial typed `issue` against a real issue's id must not come back from
  `GET /issues/:id/activity` (§4.4c).

### (a2) Nullable `company_id` **and** a new nullable `organization_id` ★

Everything in (a), plus `organization_id uuid REFERENCES organizations(id)`.

- **Unblocks:** the same residue, **but attributably at most of it**. This is the only option that
  records what is actually known at those sites: DE-03's ~~eight~~ **seven** organization-attested
  refusals (corrected 2026-09-09 — see §1.1), DE-15's drain,
  and DE-06's five org-only throws all hold a verified organization. Under (a) they become "some
  denial happened somewhere"; under (a2) they become "this organization was refused."
- ★ **NOT all of it — two DE-03 sites this paper itself measured stay DOUBLY null under (a2).** At
  the enrollment refusal (`server/src/services/worker-enrollment.ts:315`) the value in hand is
  `authoritativeOrganizationId`, typed **`string | null`** at its declaration (`:300`), so an
  unrouted enrollment code yields no organization either; and the pre-code refusal (`:295`,
  expired/unknown route) fires **before** any organization is resolved at all. Under (a2) both write
  a row with `company_id` null **and** `organization_id` null — attributable to nothing but the
  device thumbprint and proof id in `details`. §1.1 says this; the "attributably" claim must not be
  read past it, and §4's acceptance language is scoped accordingly.
  ★ **CORRECTION, 2026-09-09:** the pair named here is wrong. `:295` is doubly null but is **not one
  of the nine**; the second doubly-null site *among the nine* is
  `middleware/worker-session-auth.ts:151` at platform scope. The count of doubly-null sites is
  unchanged (two of the nine, plus `:295`); which sites they are is not. See §1.1's correction.
- ★ **Inherits (a)'s retraction in full.** `forIssue` reads without a company predicate, so an (a2)
  row is not undisclosed by construction either — the org column changes what is *recorded*, not who
  can *read* it. The third acceptance condition in §4.4c applies to (a2) exactly as to (a).
- **Extra cost over (a):** one `ADD COLUMN` + one index in the same generated migration. ★ Note the
  programme's own lesson that `ADD COLUMN` is not idempotent — which is precisely why this must be
  `db:generate` output and must not be hand-appended.
- **Breaks:** the same invariant relaxation as (a), plus a second nullable tenant column that the
  other thirty-three writers will never populate — a column that is null on ~100% of rows is a
  standing invitation to misread.
- **Proof:** as (a), plus an assertion that the organization on the row equals the one the refusing
  control verified (read from the branch, not stamped — the DE-19 discipline).

### (b) A separate unattributed-denial table

- **Unblocks:** the same residue, with any column set one likes (`organization_id` nullable,
  `company_id` nullable, actor, reason, control).
- **Cost:** a schema unit (Drizzle + `db:generate`) **plus** a Decision #122 posture call —
  RLS/GRANT DDL is hand-authored `--custom` and must be argued, not guessed. The closest analogue
  (`activity_log`) is deliberately non-RLS, and this table would hold **cross-tenant evidence**,
  which `E0-F013` itself flags as "a live-fire question". Also: a second recorder, a second
  redaction path, a second namespace convention, and a second thing that can be silently broken.
- **Who reads it:** **nobody** — no *deliberate* reader of `security.denied.*` exists anywhere today
  (§2), so the "who reads it" objection is a cost the whole class already carries and not a cost of
  (b) relative to (a)/(a2). ★ **But the comparison is no longer symmetric, corrected:** (a)/(a2) rows
  live in a table with two **company-unscoped** readers, one of which (`forIssue`) keys on
  caller-controllable `entityType`/`entityId`; a new table has none. (b)'s "nobody reads it" is a
  property; (a2)'s has to be built (§4.4c).
- **Breaks:** nothing existing. Preserves `activity_log`'s `NOT NULL` invariant intact — and its
  freedom from any existing unscoped reader. Both were advantages over (a2); the first is largely
  neutralised by the generated partial CHECK (see the counter-argument below), the second is not.
- **Proof:** the same provocation discipline, against a new table.

### (c) Resolve the company from a caller-supplied id (e.g. `jobId`)

- **Unblocks:** DE-06's five org-only throws only — and only the three that occur *after* a `jobId`
  is presented. It does **nothing** for DE-03 (no job in the request) or DE-15 (the drain is not
  about a job).
- **★ The attack, stated plainly, and not presented as neutral.** The prober **chooses the record's
  destination.** It supplies a `jobId`, the recorder resolves that job's `company_id`, and the
  evidence of its own refusal lands wherever it aimed. It can therefore **dilute** its history
  across many of its own companies, **flood** one company's Activity feed (which any member of that
  company can read, §2) to bury a real signal, or **omit** a resolvable `jobId` to force the record
  back into the tenantless bucket. A prober that controls the attribution controls the audit.
- **The one mitigation, measured:** the lookup runs under the worker's own org GUC and `jobs` is
  `FORCE RLS` on `organization_id` (`0211:20-28`), so the destination cannot be **another
  organization**. The true statement is *"a prober chooses which of the companies inside its own
  already-authenticated organization absorbs the record"* — narrower than cross-tenant, still an
  attacker-chosen audit destination. The register should carry the true statement, not the loose
  one.
- **Cost:** near zero in code. The cost is the property.
- **Proof:** you cannot prove this one *safe*; you can only bound it. Any wiring would need a test
  that a foreign-org `jobId` resolves to nothing (RLS fail-closed), which pins the bound and not the
  property.

### (d) Widen the post-resolution tuple-integrity branch (`worker-fence-context.ts:111-123`)

- **Unblocks:** exactly **one** throw of DE-06's six (`:122`). Nothing else — not DE-03, not DE-15,
  not the five earlier throws.
- **Cost:** ★ measured blast radius — the helper is shared by **four** services
  (`artifact-commit.ts:162`, `artifact-transfer-grant.ts:115`, `patch-apply.ts:101`,
  `secret-broker.ts:269`). Any signature change (adding a `db` handle or a denial-intent sink)
  touches all four; any behaviour change on that branch changes the refusal semantics of four
  independent surfaces at once, two of which (`patch-apply`, `secret-broker`) have no denial-audit
  wiring at all today.
- **The cheaper shape the blast radius suggests:** do **not** widen the helper. Catch
  `JobLeasingError` at the **caller** — outside `runInTenant`, on the pool handle, where each of the
  four already knows its own surface slug — exactly the drain shape PR #396 built for the
  `rejected` path. But a caller-side catch has only the `JobLeasingError` code and **not**
  `context.lease.companyId`, which never leaves the helper. So closing `:122` attributably really
  does require touching the helper: either returning the resolved company alongside the throw, or
  moving the tuple check out.
- **Breaks:** nothing, if the four callers are updated together. The risk is the usual one — a
  shared helper changed for one caller's benefit.
- **Proof:** a provocation per branch. PR #396 already demonstrated that this class of fixture is
  easy to get wrong: its DE-06 test *appeared* to cover `:122` while its lease tuple still matched,
  so the refusal actually landed on a later catch. Any unit here must pin **which** throw it reached.

### (e) Record nothing, and say so in the register

- **Unblocks:** nothing. **Closes** the ambiguity, which is not nothing.
- **Cost:** an amendment to each affected `audit` clause in
  `docs/architecture/distributed-execution-threat-controls.json`, plus the finding text.
- **Breaks:** nothing in code. What it costs is coverage: DE-03's replay rejection is *the* signal
  for a stolen worker session, and choosing not to record it means an attacker replaying proofs
  leaves the same durable trace as a worker with a clock skew — none.
- **Why it is on the list anyway:** it is the only option that is honest by construction. This
  programme's stated failure class is a mechanism that covers part of a class while the register
  asserts all of it. If (a2)/(b) are not funded, (e) is **mandatory** — the alternative is not
  "nothing happens", it is "the register keeps claiming coverage that does not exist".
- **Proof:** the register diff, and no gate-clause enrolment.

---

## §4 — Recommendation

**Rule (a2) with a generated CHECK, and re-record the four.**

**1. Rule (a2) for the residue.** Make `activity_log.company_id` nullable, add a nullable
`organization_id`, **and add the partial `CHECK (company_id IS NOT NULL OR action LIKE
'security.denied.%')`** — all three as `check()`/column declarations in
`packages/db/src/schema/activity_log.ts`, emitted by one `db:generate` migration. Reasoning:

- It is the only option that records **what is actually known** at the residual sinks. DE-03's eight
  session-bound sites, DE-15's drain and DE-06's five org-only throws hold a *verified organization*.
  Options (a) and (b)-with-only-a-nullable-company throw that away and produce "someone was refused";
  (c) invents an attribution the attacker picks; (e) records nothing. ★ **Scope, honestly:** the two
  DE-03 sites with no organization (`worker-enrollment.ts:315` with a null
  `authoritativeOrganizationId`, and the `:295` pre-code refusal) stay attributable to **neither**
  axis even under (a2), and the ruling's acceptance language must not claim otherwise.
- ★ **The invariant objection is answered inside (a2), not traded away.** §3's counter-argument
  correction shows the partial CHECK is ordinary `db:generate` output (`0135:3-4` is the existing
  proof of an `ADD CONSTRAINT … CHECK` on a live table) and costs nothing under C14. With it, the
  `NOT NULL` guarantee is **retained for all ~34 product writers** and relaxed only inside the
  reserved denial namespace that `assertUnreservedActivityNamespace` already fences off. This is the
  single biggest change from the first draft, and it moves the balance toward (a2) rather than away.
- ★ **It does NOT come with non-disclosure for free** (corrected). `forIssue`
  (`services/activity.ts:60-70`) reads with no company predicate, so a tenantless row typed `issue`
  is readable through `GET /issues/:id/activity` by members of that issue's company. Twelve of the
  fourteen readers are company-scoped and a NULL never matches them; two are not. Condition 4c below
  exists because of this, and it is a build item, not a property.
- It needs **no RLS or GRANT decision**. `activity_log` is deliberately outside the kernel
  (`0245:15-18`) with `SELECT, INSERT`-only grants — the exact posture a cross-tenant denial sink
  wants, already argued and already shipped. Option (b) re-opens that argument on a new table under
  Decision #122 and must win it again.
- Cascade improves for the residue: a tenantless row does not cascade with any company.
- It is one migration and one recorder change, against (b)'s table + recorder + redaction path +
  namespace + posture argument.

**2. Do NOT hold the resolvable DENY SITES behind it — but do not claim they are halves.** DE-06's
`:122` throw and DE-21's `:395` plus `:376`'s tenant-mismatch arm need a **unit, not a ruling**, and
should be scheduled now — with §3(d)'s warning about the four-service helper, with a **runtime narrow
for the `string | null` type at `:122`** (§1.4), and with a test that pins **which** throw was
reached. Scheduling them does not unblock DE-06's fence half (five throws remain) and does not
subtract anything from DE-21's queued board/session half, which never contained them.

**3. Send DE-21's board/session branches to Decision 3, where they belong.** Their company is
decidable (§1.2); what is undecided is *whose log a cross-tenant probe lands in*. `:376`'s `!key`
arm — the dominant probe case — travels with them, since it resolves no company either. Both live
writers already answer the analogous question the same way — attribute to the actor's own tenant,
never the probed one — so Decision 3 has a precedent to ratify or overturn, and Decision 2 should
stop being recorded as their blocker.

**4. THREE acceptance conditions on the ruling, or it becomes the failure it is meant to fix.**

   a. **A reader must ship in the same wave.** §2 measured that **no production reader of
      `security.denied.*` exists**. Adding a fourth writer to a store nobody queries produces
      evidence that is present and unreachable — a claim of coverage with no observation behind it.
   b. **The register must be amended for DE-15 in the same commit.** Even under (a2), an
      organization-attributed drain record does **not** satisfy "image admission, scan, and kill
      events are audited" as a *tenant* fact, and DE-15's clause should say what the programme
      actually intends before any row is written against it.
   c. ★ **The unscoped-reader path must be closed, with a test.** A null-company row is **not**
      undisclosed by construction: `activityService.forIssue` keys on `entityType='issue'` +
      `entityId` alone and is served behind a check on *the issue's* company
      (`services/activity.ts:60-70`, `routes/activity.ts:88-98`), while `entityType`/`entityId` are
      caller-supplied free text on the recorder (`security-denial-audit.ts:103/:105/:145-146`).
      Either scope `forIssue` by company, or bar the denial namespace from entity types an unscoped
      reader keys on — and prove it with a **provocation**: write a tenantless denial typed `issue`
      against a real issue's id and assert it does **not** come back from
      `GET /issues/:id/activity`. Without this, (a2) hands Decision 3's disclosure question back
      through the door this decision was meant to shut.

### The strongest argument AGAINST this recommendation

**A nullable tenant column turns `activity_log` into two tables wearing one name, and pays for four
sinks with a weakening that lands on thirty-four writers.**

`NOT NULL` on `company_id` is, today, the **only** enforcement that every product row in that table
belongs to a company. There are **34** direct `insert(activityLog)` sites, and `E0-F013` has already
recorded — with reasons this paper does not dispute — the decision **not** to ship a static guard
over them. Drop the constraint and the next writer that forgets `companyId` inserts a row that
silently vanishes from all ten company-scoped readers, and **no test, no guard and no constraint
fires**. That is this programme's signature defect: a thing that appears to work and observes
nothing. Option (b) pays one table to keep that invariant whole, and one table is cheap next to a
class of silent product-data loss.

Two things push back. The first only narrows it: 32 of the 34 writers hard-code their values and pass
`companyId` explicitly (`activity-namespace.ts` docblock, re-derived at `12660dbd6`), so the exposure
is narrower than 34.

★ **The second was MISPRICED, and the correction cuts AGAINST this paper — which is why it is stated
here rather than buried.** The first draft priced
`CHECK (company_id IS NOT NULL OR action LIKE 'security.denied.%')` at *"the cost of hand-authored
DDL under C14"*. **That is false, and it is a mispricing that flattered this paper's own
recommendation — a worse fault than one that harms it.** Drizzle's `check()` primitive is in active
use in this schema (`leases.ts:49` `leases_status_check`, and 20+ further declarations across
`job_attempts.ts`, `execution_targets.ts`, `company_brain_edges.ts`, `job_events.ts`, …), and
`db:generate` emits CHECK constraints in **48** migrations — both inline at create
(`0207_tenant_kernel_jobs.sql:14/:24/:36`, `0134`, `0219`) and, decisively for this case, as a bare
`ALTER TABLE … ADD CONSTRAINT … CHECK (…)` against an **existing** table
(`0135_loose_pete_wisdom.sql:3-4`). The constraint goes in
`packages/db/src/schema/activity_log.ts` as a `check(...)` and comes out of `db:generate`. **C14 is
not engaged at all** — and hand-authoring it would *violate* the migration workflow, not satisfy an
exception to it.

**The mitigation is therefore FREE, and it materially strengthens (a2) against (b).** The
counter-argument's whole force is that dropping `NOT NULL` relaxes the invariant for the other ~34
writers; a generated partial CHECK **restores it for every one of them**, admitting a null company
only on rows in the reserved `security.denied.` namespace that the recorder alone can write
(`assertUnreservedActivityNamespace` already bars the HTTP and service writers from that prefix).
What survives of the objection is smaller but real: a `LIKE` predicate over a text column is a weaker
guarantee than `NOT NULL`, and it must be enrolled with a **provocation test** — insert a
non-denial row with a null company and see it rejected — or it becomes exactly the check-that-
enforces-nothing this programme keeps finding. **If the founder still weighs the invariant above the
storage saving, (b) remains the correct ruling and this paper's recommendation should be
overturned.** The measurement in §1 stands either way.

---

## DECISION BLOCK — for founder signature

> **Decision 2 of `E0-F013`: where a denial with no FK-valid tenant goes.**
>
> **The count is corrected first, and NOT in the direction the first draft claimed.** Of the four
> clause-halves recorded as queued behind this decision, **none is wholly unblocked by it.** What is
> true: **one of DE-06's six fence throws** (`worker-fence-context.ts:122`) is resolvable today —
> the other five are residue; **DE-21's agent-key deny sites** (`live-events-ws.ts:395`, and `:376`'s
> `key.companyId !== companyId` arm — **not** its `!key` arm) are resolvable today, and the register
> had already placed them outside the queued half; and **DE-21's board/session half is blocked by
> Decision 3**, not by this one. The residue this decision owns is **DE-03**, **DE-15**, and **five
> of DE-06's six fence throws** — all of which hold a verified *organization* and no singular
> company, and two DE-03 sites (`worker-enrollment.ts:295`, `:315` with a null
> `authoritativeOrganizationId`) hold neither.
>
> Choose ONE:
>
> - [ ] **(a2) — RECOMMENDED.** `activity_log.company_id` becomes nullable, a nullable
>       `organization_id` is added, **and a partial `CHECK (company_id IS NOT NULL OR action LIKE
>       'security.denied.%')` retains the NOT NULL guarantee for every non-denial writer** — all by
>       `db:generate` (Drizzle `check()`; no hand-authored DDL, C14 not engaged). Residual denials
>       are recorded organization-attributed where an organization exists. **Conditional on all
>       three:** a reader for `security.denied.*` ships in the same wave; DE-15's register clause is
>       amended in the same commit; and the unscoped `forIssue` read path is closed with a
>       provocation test (§4.4c).
> - [ ] **(b)** A separate unattributed-denial table is minted, keeping `activity_log`'s `NOT NULL`
>       invariant intact. Its RLS/GRANT posture is argued under Decision #122 before it lands.
>       Conditions (a) and (b) apply; (c) does not, since a new table has no unscoped reader.
> - [ ] **(a)** Nullable `company_id` only; residual denials are recorded tenantless.
> - [ ] **(c)** REJECTED unless explicitly overridden — resolution from a caller-supplied id lets a
>       prober choose which of its own organization's companies absorbs the record.
> - [ ] **(e)** Nothing is recorded for the residue, and the `audit` clauses of DE-03, DE-15 and
>       DE-06 are AMENDED in `distributed-execution-threat-controls.json` to say so.
>
> And separately:
>
> - [ ] DE-06 `:122`, DE-21 `:395`, and DE-21 `:376`'s `key.companyId !== companyId` arm are
>       scheduled as units **now**, not behind this ruling — noting that this leaves DE-06's fence
>       half blocked on its other five throws.
> - [ ] DE-21 branches 1–5 **and `:376`'s `!key` arm** are re-recorded against **Decision 3**.
>
> Signed: ____________________  Date: ____________

**No finding status is changed by this document.** `E0-F010` and `E0-F013` remain `open`; no
`deliveryStatus` moves; nothing is enrolled in `scripts/gate-clause-wiring.json`.
