# DECISION REQUEST — retention and disclosure of a denial record

**Answers:** `E0-F013` → *"Decisions this slice did not take"* → **Decision 3**
(`docs/replatform/epics/E0-foundation/findings.md:1073-1076`).
**Date:** 2026-09-10. **Measured at:** `6b39c77f6` (PR #404, the denial-prefix index + tenantless
disclosure unit).
**Status:** ★ **RULED 2026-09-11 (founder)** — best-practice throughout, per class. See the ruling
block immediately below. The decision is implemented in slices; **slice 1 (Q2/Q3 — disclosure to the
actor's own tenant) is shipped by this PR**; slice 2 (Q3-sites) by `decision3-tenantless-sink`; and
slice 3 by `decision3-retention` (Q5 — tamper-resistant delete — **WHOLE**; Q4 — retention window
**RECORDED**, enforcing purge **DEFERRED** to E0-F018).
The un-ruled framing below (`"What this document changes: NOTHING"`, `§9`) is the record of the
paper AS SUBMITTED and is left intact; the ruling block is the amendment.

---

## ★ RULED 2026-09-11 (founder)

Signed by the founder on 2026-09-11, **best-practice throughout** — i.e. the ★ RECOMMENDED option in
each of the three decision sub-blocks. The five questions of §1, and where each is delivered:

| # | Question | Ruling | Delivery |
|---|---|---|---|
| **Q1** | Attribution + disclosure to the **probed** tenant | **RATIFY** actor-tenant attribution; a cross-tenant refusal is filed under the **actor's own** tenant and the **probed** tenant is never told (no per-company denial feed). This is already the code's behaviour and what three suites assert. | already true; **slice 1** re-asserts it (the probed tenant stays blind). |
| **Q2 / Q3** | Disclosure to the **actor's OWN** tenant | ★ **RECOMMENDED (Decision 3.1)** — also do **NOT** disclose a `security.denied.*` row to the actor's own tenant. Exclude the denial namespace from **every tenant-facing `activity_log` reader** through ONE shared `notDenialNamespace()` predicate, with a provocation per reader observed RED first. The operator plane (`GET /instance/security-denials`) still sees everything. | ★ **IMPLEMENTED BY THIS PR (slice 1).** Readers: `activityService.list`, `homeService.summary`, `cockpitTeammatesActivity`, `morningDigest`. |
| **Q3-sites** | The **fourteen** tenant-less deny sites (six `authorizeUpgrade` + eight plugin cloud gate) | ★ **RECOMMENDED (Decision 3.2, option (c))** — an **operator-only sink**: `company_id` NULL, caller-supplied company in `entity_id`, readable only via the operator reader, **WITH a bound on the write** (per-source cap / sampling / aggregation) landing alongside it. | ★ **IMPLEMENTED BY SLICE 2** (`decision3-tenantless-sink`): all 14 sites now call the bounded recorder into the operator-only sink. |
| **Q4** | Lifetime of a denial record | ★ **RECOMMENDED (Decision 3.3)** — rule it **explicitly** (today it is unbounded and nothing records that): a bounded retention window whose purge itself leaves a record. | ★ **PARTIAL (slice 3) — explicit window RECORDED (Q4a); enforcing purge NOT shipped (Q4b → E0-F018).** `SECURITY_DENIAL_RETENTION_DAYS = 365` is named + documented in `activity-namespace.ts` (the recorded window), but nothing reads it to purge — rows past 365 days are retained indefinitely. The record-leaving purge is NOT wired (it collides with the partial CHECK — a company-less purge-audit row is rejected outside the denial namespace) and is filed as **E0-F018** (unowned). The window is **declared, not enforced.** |
| **Q5** | Tamper — can a suspect delete it? | ★ **RECOMMENDED (Decision 3.3)** — `security.denied.*` denial history **survives a company delete**: the `company_id` FK moves to `ON DELETE set null` (by `db:generate`) and `companyService.remove` nulls rather than deletes them, making the company axis agree with `organization_id`'s existing `restrict`. | ★ **IMPLEMENTED BY SLICE 3** (`decision3-retention`): FK → `ON DELETE set null` (migration `0280`); `companyService.remove` NULLs the `security.denied.*` rows and deletes the ordinary rows before the company delete; proven RED-first by `e0-f013-denial-retention-survives-delete.integration.test.ts`. |

**Slice map.** Slice 1 = Q2/Q3 (this PR). Slice 2 = Q3-sites operator-only sink + write bound
(**shipped** by `decision3-tenantless-sink`). Slice 3 = Q5 (tamper-resistant delete, **WHOLE**) + Q4
(retention window **RECORDED**, enforcing purge **DEFERRED** to E0-F018), by `decision3-retention`:
**Q5 whole** (FK `ON DELETE set null`, migration `0280`; `companyService.remove` nulls the denial rows
then deletes the ordinary rows), and **Q4 as a recorded-but-unenforced window**
(`SECURITY_DENIAL_RETENTION_DAYS = 365`, which nothing yet reads to purge) with the record-leaving
purge **deferred** to **E0-F018** because it collides with the partial CHECK (a company-less
purge-audit row is rejected outside the denial namespace — a further schema decision, not a
cron-wiring). The strongest
arguments-against recorded in §8 are accepted by the founder as the known costs of the best-practice
choice, and each later slice owes the provocation §8 names (the write bound for slice 2; the
`set null` / undeletable-company case for slice 3 — the latter is discharged by
`e0-f013-denial-retention-survives-delete.integration.test.ts` seeding an ordinary row alongside the
denial row and asserting the delete still succeeds).

---

**What this document changed AS SUBMITTED: NOTHING** (the paper below is preserved verbatim; the
ruling above is the amendment). No finding status, no `deliveryStatus`, no ownership, no
clause text in `docs/architecture/distributed-execution-threat-controls.json`, no
`scripts/gate-clause-wiring.json` enrolment, no production code. **Amending the register IS the
decision being requested**, so this paper did not pre-empt it by making the amendment.

**Method.** Nothing below is inherited — not from `E0-F013`, not from the Decision 1 paper
(`bd334ff50`), not from the Decision 2 paper (`bb0572f19`), not from the register's
`deliveryEvidence`. Every file:line is re-opened at `6b39c77f6`. Where a citation this paper was
handed turned out to be wrong, §2.2 says so at the citation rather than in a footnote.

---

## §0 — THE HEADLINE

**1. There is a de facto precedent, it is stronger than reported, and this paper ratifies half of it
and overturns the other half.** All four live denial writers attribute a cross-tenant refusal to the
**actor's own** tenant, never the probed one, and three integration suites assert the probed
tenant's `activity_log` is empty. That half is right and should be ratified.

**2. ★ THE HALF NOBODY MEASURED: actor-attribution DISCLOSES THE DETECTION TO THE PROBER.**
`activityService.list` (`server/src/services/activity.ts:113`) applies **no action-prefix
filter**, and `GET /companies/:companyId/activity` (`server/src/routes/activity.ts:95-109`) gates on
`assertCompanyAccess` — **any company member**. ★ **And it is not one reader** (corrected on review):
`homeService.summary` (`home.ts:72`) selects the last 24h of company activity with no action
filter and returns the row's full `details` (`:178`, `:319-322`) behind the same gate
(`routes/dashboard.ts:22-24`); the cockpit feed (`cockpitTeammatesActivity`, `cockpit.ts:477`)
carries the reason code; and Commander's proactive check (`morningDigest`, `proactive.ts:467`) takes
every column. So a `security.denied.*`
row filed under the actor's tenant is returned today through several live surfaces. The precedent protects the probed tenant and hands the attacker a read receipt.
Decision 2's paper measured the missing filter and read it as a *coverage* fact; it is a
*disclosure* fact, and it is the disclosure Decision 3's own text does not mention.

**3. ★ FOR EVERY SITE THIS DECISION ACTUALLY OWNS, "ACTOR'S TENANT ONLY" IS NOT AN OPTION.** The
cohort is **fourteen deny sites** — six in `authorizeUpgrade`, eight in the plugin cloud gate — and
at **none** of them is any actor tenant resolved. Option (a) is not "keep doing what we do" here; it
is a null. A ruling that ratifies the precedent and stops there answers Class 1 and leaves all
fourteen exactly where they are.

**4. The cohort is not "DE-21's board half".** It is fourteen sites across **two** crossings, and
DE-16's sinks split three ways: eight are Decision 3's, nine hold no company at all and are Decision
2's already-ruled residue, **one** (`plugin-lifecycle.ts:506`) holds a DB-resolved company and needs
a **unit, not a ruling**, and four were not traced by this paper and are recorded as unmeasured.

**5. Retention has two halves and the finding only asks one.** *How long* a denial record lives is
**unbounded** — measured: zero purge, prune, TTL or partition anywhere. And a founder of a tenant
can erase every denial row filed under it: `DELETE /api/companies/:companyId` reaches
`tx.delete(activityLog).where(company_id = id)`.

**6. ★ THE ADJACENT ITEM IS SETTLED, AND THE GRANT FACT IS NOT AN EXONERATION.** `aoa_app` holding
only `SELECT, INSERT` on `activity_log` is true and irrelevant: **that is not the role the delete
transaction runs as.** `companyService` is built on the pool `createDb(config.databaseUrl)` returns
— the same connection string `ensureMigrations` applies DDL through two lines earlier. The delete
path has `DELETE`. §7.3 shows the working.

**7. And half of Decision 3(b) has already been ruled without a paper.** `activity_log.organization_id`
is `onDelete: "restrict"`, in-code reason: *"denial evidence must not be deletable by deleting the
organization it incriminates."* `company_id` is `onDelete: "cascade"`. The same question is answered
in opposite directions on the two axes, and nobody recorded that as a decision.

---

## §1 — The decision, verbatim, and what it actually contains

Quoted whole from `docs/replatform/epics/E0-foundation/findings.md:1073-1076`:

> 3. **Retention and disclosure of a denial record.** (a) Whose log does a cross-tenant denial land
>    in? The probed company's `activity_log` discloses to them that they were probed and by whom.
>    (b) `activity_log` **cascade-deletes with its company**, so a hostile tenant can destroy the
>    evidence of their own probing by deleting their own company. An audit record a suspect can
>    delete is not an audit record.

**It is labelled (a) and (b) and it holds FIVE questions.** They have different answers, different
costs and different cohorts, which is why the decision block is per class.

| # | Question | Where it lives in the text | Status here |
|---|---|---|---|
| Q1 | **Attribution.** Whose tenant is the row filed under? | (a), sentence 1 | The cohort question. §4, §5. |
| Q2 | **Disclosure to the probed tenant.** | (a), sentence 2 | Answered by precedent; §2 ratifies. |
| Q3 | ★ **Disclosure to the ACTOR's tenant.** | **NOT ASKED ANYWHERE** | Live and open. §3. |
| Q4 | **Lifetime.** How long does the record live? | the heading word *"Retention"* only — the body never asks it | Unbounded. §7.1. |
| Q5 | **Tamper.** Can a suspect delete it? | (b) | Yes. §7.2, §7.3. |

★ **Q3 is the one that matters most and is the one the decision text does not contain.** (a)'s second
sentence reasons only about the *probed* company's log. It is silent on the actor's, and the actor's
is the log every live writer actually writes to.

★ **Q4 is a heading with no body.** "Retention" appears in the title of the item and nowhere in it.
Nothing in the finding asks how long a denial record lives absent a company delete, and nothing in
the system bounds it. Recorded so the ruling is not read as having covered it.

---

## §2 — The de facto precedent, measured at source

### 2.1 Every live denial writer attributes to the actor's own tenant

| Crossing | Writer | Tenant the row is filed under | Provenance |
|---|---|---|---|
| DE-19 | `server/src/mcp/tools/read-tools.ts:298-306` | `ctx.companyId` — the refusing/actor tenant | request context |
| DE-21 | `server/src/realtime/live-events-denial-audit.ts:113-124` | `input.companyId`, documented at `:96` as *"the DB-resolved owning tenant of the presented credential"*; `entity_id` at `:124` is the **requested** (probed) company | `agent_api_keys.company_id`, NOT NULL + FK |
| DE-06 | `server/src/services/artifact-denial-audit.ts:130-141` | the **locked lease's** company, *"never a caller-supplied field"* | `ResolvedFenceContext.companyId` |
| DE-03 | `server/src/services/worker-denial-audit.ts:200-204`, `:236-247` | `company_id` **null** + token-attested `organization_id` at the replay sink; `pending.companyId` where one exists | `VerifiedWorkerOperation` |

The call site that proves the DE-21 rule at the branch: `live-events-ws.ts:402-415` records
`companyId: key.companyId` for `agent_key_tenant_mismatch` — a key aimed at a company it does not
own is filed under the key's own tenant, with the probed company in `requestedCompanyId`.

### 2.2 The proving tests — and ★ the cited line numbers were wrong

The brief handed this paper *"DE-06's proving test asserts the probed tenant's `activity_log` is
EMPTY (arms at `:505`/`:555`/`:807`)"*. **Re-measured, none of those three is that arm.** In
`server/src/__tests__/de-06-artifact-denial-audit.integration.test.ts`: `:505` is a manifest fixture
literal, `:555` is inside `afterAll`, `:807` is an `UPDATE leases SET fence = …` in a
fence-supersede fixture. **The actual arm is `:1091-1101`** — *"★ THE PROBED TENANT LEARNS NOTHING
FROM A FENCE REFUSAL EITHER"*, asserting `count(*) = 0` for `OTHER_COMPANY`.

The precedent is asserted by **three suites at four arms**, which is a stronger base than the one
cited:

- `de-06-artifact-denial-audit.integration.test.ts:1091-1100` (count asserted `0` at `:1099`)
- `de-19-memory-denial-audit.integration.test.ts:454-484` — *"it lands in the REFUSING tenant, not
  the probed one"*, with the probed tenant's count asserted `0` at `:480-484`
- `de-21-live-events-upgrade-denial-audit.integration.test.ts:291-295` and `:452-471` — five rows,
  all `company_id = coA`, `activityRowCount(coB) === 0`

### 2.3 #402's operator plane was built on the precedent deliberately

`GET /instance/security-denials` (`server/src/routes/activity.ts:129-137`) is gated on
`assertCanManageInstanceSettings` — the operator plane, explicitly **not** `isInstanceAdmin`
(`:117-122`) — and its query (`server/src/services/activity.ts:414-470`) is cross-tenant by
construction, with `companyId` documented at `:24-25` as *"a FILTER here, never a scope"*. The unit
recorded its own reasoning at `findings.md:1573-1582`: *"This reader follows that precedent: it adds
no per-company denial feed… Whether a probed tenant is entitled to know is Decision 3's question and
is not pre-empted here."*

**So the reader exists.** Decision 2's acceptance condition (a) — *"no production reader of
`security.denied.*` exists anywhere"* — is **no longer true**, and any option below that assumes it
is, is costing something already paid for.

**Verdict on the precedent: sound on Q2. Ratify it.** Its cost is measured in §6 and it is real, but
every alternative on Q2 is worse (§5.2).

---

## §3 — ★ THE HALF OF THE PRECEDENT THAT IS UNSOUND, AND IS LIVE

`SECURITY_DENIAL_ACTION_PREFIX` (`server/src/services/activity-namespace.ts:55`) is used in
**four** production places — ★ **the first draft of this sentence said three, and that was wrong;
re-measured at `HEAD` and corrected here rather than footnoted:**

- `assertUnreservedActivityNamespace` — the write fence (`activity-namespace.ts:76`)
- ★ `recordSecurityDenial` — the recorder **composing** the action string, prefix concatenated with
  `input.surface` (`security-denial-audit.ts:260`). This is the site that makes the namespace a
  namespace at all, and omitting it made a census of the constant read as a census of *filters*.
- `activityService.securityDenials` — the operator reader, twice (`activity.ts:416`, `:423`)

**It is used nowhere as a read exclusion**, which is the load-bearing fact and is unchanged by the
correction: one of the four writes it, one fences it, and the other two are the operator plane
selecting *for* it.

`activityService.list` (`activity.ts:113-152`) builds its predicate from `company_id` plus optional
agent/actor/entity filters and a hidden-issue join. There is no `action` predicate of any kind. Its
route (`routes/activity.ts:95-109`) calls `assertCompanyAccess` and nothing else — not
`assertRole(founder)`, not the operator gate.

★ **AND IT IS NOT ONE READER. CORRECTED ON REVIEW — Codex P1 on PR #408, verified at source.** The
first draft of this section, and of §5.2 and §8, named `activityService.list` alone. That is a HALF,
and this programme's own rule is that half of a conjunction is not it. The tenant-facing read
surface, censused over all fifteen `.from(activityLog)` sites outside tests — **re-run at `HEAD`**,
whose `server/` tree is byte-identical to `6b39c77f6` (the only commits between are this document's
own):

★ **Cited by symbol, line as hint only.** Line numbers rot; the symbol is the handle. Where a
`.from(activityLog)` sits inside a service factory, the symbol is the method and the range is the
query.

| Reader (symbol) | Consumer / gate | Action filter | Carries `details`? |
|---|---|---|---|
| `activityService.list` (`activity.ts:113`; query `:113-152`) | `GET /companies/:cid/activity` — `assertCompanyAccess` (`routes/activity.ts:95-109`) | **none** | **yes** |
| ★ `homeService.summary` (`home.ts:72`; the `activity_log` select at `:167-189`) | `GET /companies/:cid/home` — `assertCompanyAccess` (`routes/dashboard.ts:22-24`) | **none** | ★ **yes** — projected at `:178`, returned at `:319-322` |
| `cockpitTeammatesActivity` (`cockpit.ts:477`; select at `:504-517`) | `GET /companies/:cid/cockpit*` | **none** | no — `action`/`entity_type`/`entity_id` only; scoped founder-or-lead-department at `:491-502` |
| ★ `morningDigest` (`proactive.ts:467`; select at `:476-484`) | Commander's overnight check — bare `select()`, every column | **none** | ★ **yes**, and it feeds an LLM rather than a screen |
| `productivityReviewService.reconcileCompany` — `churnLastHour` + `churnLastSixHours` (`productivity-review.ts:225-248`; **two** sites) | churn COUNTs keyed `entity_type='issue'` + one issue id | none | no — inflates a count, discloses no content |
| `costService.byProject` (`costs.ts:223`; select at `:230-244`) | INNER JOIN requiring `entity_type='issue'` **and** `run_id IS NOT NULL` | none | no |
| `fetchEdits` (`memory-feedback.ts:43`), `resolveGithubUserFromConnectActivity` (`routes/github.ts:66`), `inspectMarketplaceReconciliation` (`marketplace-reconcile.ts:1633`), ★ `reconcileCompany`'s `refreshStats` (`productivity-review.ts:250-262`) | exact-`action` equality | **contained by construction** | n/a |
| `activityService.forIssue` (`activity.ts:190`; query `:190-201`) | company-scoped since #402 | none | contained by `company_id` alone |

★ **THE FIFTEENTH SITE — this census claimed fifteen and accounted for only 14 of them.** (Reader
sites, not deny sites; the cohort's "fourteen" in §4 is an unrelated count that collides only in the
word.) The first draft's table held **eleven** rows-worth of sites and its next paragraph named
**three** more — 11 + 3 = 14, in a paper whose whole authority is measured completeness. Re-run at
`HEAD` — `grep -rn "\.from(activityLog)"` over `server/`, `packages/` and `ui/`, minus `__tests__`
— returns **fifteen**. The missing one is
`reconcileCompany`'s `refreshStats` (`productivity-review.ts:250-262`, `.from` at `:253`), an exact
equality on `action = 'issue.productivity_review_refreshed'` at `:257` scoped to one company and one
issue id, projecting `createdAt` alone. It is **contained by construction** and is now in the row
beside `memory-feedback` / `github` / `marketplace-reconcile`, which is where it always belonged —
so the omission changed no conclusion, and that is exactly why it survived a draft. The table now
covers **twelve** (`productivity-review` appears in two rows because it holds three of the fifteen
sites), and three are named below: **12 + 3 = 15.**

★ **The three of the fifteen not in the table, named so the census is complete rather than
selective:** `activityService.issuesForRun` (`activity.ts:255`; query `:266-284`), keyed `run_id` +
`entity_type='issue'` with an INNER JOIN to `issues` — a denial row carries no `run_id` today, but
the recorder does not forbid one; `activityService.securityDenials` (`activity.ts:414`; query
`:414-470`), the operator reader — the intended consumer, §2.3; and the top-level query in
`dev/seed-commander-review.ts:270`, an exact equality on `commander.review_completed` in a dev seed
that is not a production surface.

**Therefore, today:** a denial row filed under tenant A is returned to every member of tenant A —
with `details.requestedCompanyId`, `details.keyId`, `details.reason` and the actor id intact —
through **at least two** live routes (`/activity` via `ui/src/api/activity.ts:59`, and `/home`), a
third that hands the reason code to founders and leads (`/cockpit`), and a fourth that hands the
whole row to Commander.

**What that means for Q1.** Under actor-attribution, a cross-tenant probe mounted from inside tenant
A produces a durable, readable notice **inside tenant A** that the probe was detected, when, against
which company, with which credential, and under which machine-readable reason code. The prober is a
member of tenant A. **The audit record is a feedback channel to the attacker.**

★ This is not a hypothetical about a future writer. It is the current behaviour of the five DE-21
rows and the DE-19 and DE-06 rows that Unit C and PR #405 already wired. It is in scope for Decision
3 because it is precisely *"whose log does this land in, and who reads it"* — asked about the other
tenant.

---

## §4 — The cohort: which deny sites Decision 3 genuinely owns

★ **The unit is the deny site, not the clause-half.** Line numbers below are at `6b39c77f6` and
**have moved** from the Decision 2 paper's (`:293`/`:304`/`:311`/`:322`/`:358`/`:376` are now
`:297`/`:308`/`:315`/`:326`/`:372`/`:400`) — the wiring unit's comments shifted them. Do not inherit
either set.

### 4.1 Class 2 — DE-21, `authorizeUpgrade` (`server/src/realtime/live-events-ws.ts:255-460`): SIX sites

| Site | Branch | In hand at the deny | Actor tenant? |
|---|---|---|---|
| `:297` | mode has no session resolver | `companyId` from `parseCompanyId(url.pathname)` | **none** |
| `:308` | untrusted / missing `Origin` | + `origin` header | **none** |
| `:315` | session resolved, no `userId` | same | **none** |
| `:326` | `cloud_auth`, `hasActiveCloudMembership` false | **`userId`** (DB-resolved session) | **none** — a user is not a tenant |
| `:372` | `authenticated`, no `instance_admin` row **and** no membership | `userId` + `memberships[]` | **none** — the in-code note at `:362-371` records the array is **EMPTY in the probe shape**, and non-empty it holds the actor's *other* tenants, which were refused nothing |
| `:400` | `!key` — token matched no `agent_api_keys` row | caller-supplied path segment only | **none** — the SELECT returned no row |

**In hand at all six: a caller-supplied company id that one `SELECT id FROM companies WHERE id = $1`
separates into "a real tenant was probed" and "a random uuid was probed".** That is the whole
substrate this decision has to rule over.

### 4.2 Class 2 — DE-16, the plugin cloud gate: EIGHT sites

`recordCloudPluginBlock` (`server/src/services/cloud-plugin-execution.ts:225-247`) writes no row at
all today — it increments module-level process counters and emits one `logger.warn`. Its sinks split:

| Site | `companyId` source | Access checked before the sink? |
|---|---|---|
| `routes/plugins.ts:684` | `req.query.companyId` | **No** — `assertCompanyAccess` is at `:691`, *after* |
| `routes/plugins.ts:799` | `req.body.runContext.companyId` | not traced; caller-supplied |
| `routes/plugins.ts:1160`, `:1252`, `:1349`, `:1439` | `req.body.companyId` | not traced; caller-supplied |
| `routes/plugins.ts:1535` | `req.query.companyId` | **No** assertion in the handler |
| `routes/company-plugins.ts:333` | `req.params.companyId` | **No** — `assertCompanyAccess` is at `:343`, *after* |

All eight sit behind `assertBoard`, so **a board actor exists** — but no tenant is resolved for that
actor at the sink, and the company in hand is the one the caller named.

### 4.3 What is NOT Decision 3's, listed so it is not double-counted

- **Nine tenantless DE-16 sinks** — `plugins.ts:959`, `:1664`, `:1773`, `:2195`, `:2409`, `:2488`,
  `:2895`; `plugin-loader.ts:1285`, `:1777`. No `companyId` field at all. These are **Decision 2's
  residue and are already ruled** (a2, `activity_log.company_id` nullable, migration `0274`).
- **`plugin-lifecycle.ts:506`** — `plugin.companyId`, DB-resolved via `requirePlugin`. **Needs a
  unit, not a ruling** — the DE-06 `:122` shape.
- ★ **Four sinks this paper did NOT trace and does not claim:** `plugin-loader.ts:1689`
  (`installOptions.companyId`), `plugin-worker-manager.ts:623` and `:1264` (`options.companyId`),
  `marketplace-install/plugin-installer.ts:112`. Stated rather than implied.
  `plugin-worker-manager.ts:623` additionally sits inside a **synchronous** `spawnProcess()` and
  cannot await a durable write — a real blocker, and **not this decision's**.

### 4.4 The count

**FOURTEEN deny sites: six DE-21 + eight DE-16.** ★ **At none of the fourteen is any actor tenant
resolved.** Today's precedent — file it under the actor's tenant — has nothing to bind to here. That
is the finding that reshapes the options: (a) is a null for this whole cohort.

---

## §5 — The options, per class, with measured costs

### 5.1 The five, and what each does to whom

| | Discloses to the probed tenant | What an attacker learns | What a defender loses | Covers Class 1 | Covers Class 2 (14) |
|---|---|---|---|---|---|
| **(a)** actor's tenant only | nothing | ★ that it was detected, and how (§3) | the probed tenant's ability to defend itself | yes — it is today | **no — no actor tenant exists** |
| **(b)** both, probed copy redacted/delayed | that *something* was refused against them | that a probe reaches the target's log — a liveness oracle | a per-tenant feed to build, redact and delay | yes | yes |
| **(c)** operator-only sink | nothing | nothing | tenant self-defence | yes | **yes** |
| **(d)** probed tenant only | everything | the target is notified on demand | actor-side detection | no | yes |
| **(e)** record nothing, say so | nothing | nothing | the entire signal | n/a | n/a |

### 5.2 (a) — actor's tenant only (today's de facto)

- **Covers:** Class 1 only. **Zero of the fourteen.**
- **Cost:** zero — it is shipped.
- **What it discloses:** §3. Under today's `list`, the prober's own colleagues, and the prober,
  read the detection. ★ **Closing it is NOT one predicate** (corrected on review): it is a predicate
  at every tenant-facing reader in §3's census — `activityService.list`, `homeService.summary`,
  `cockpitTeammatesActivity` and `morningDigest` at minimum — each with its own provocation. Still no
  schema change and no new surface, but four call sites and four tests, not one.
- **Attacker:** with the `list` gap open, a full-fidelity oracle. With it closed, nothing.
- **Defender:** the probed tenant cannot defend itself (§6).

### 5.3 (b) — both tenants, probed copy redacted or delayed

- **Covers:** everything.
- **Cost, measured:** a second write per denial; a redaction path (the probed copy must not name the
  prober, or (b) collapses into (d)); a delay mechanism, which `activity_log` has no vocabulary for
  — no `visible_at`, no status column, and `aoa_app` holds no `UPDATE` on the table
  (`0213:98`, `0214:166`), so a "publish later" flip has no legal writer on the serving pool; and a
  per-company denial feed, which is exactly the surface #402 declined to build
  (`findings.md:1573-1578`).
- **★ The attack:** a **liveness oracle**. A prober that can observe the probed tenant (an
  ex-employee, a shared contractor, a compromised member) fires a probe and watches for the row. A
  redacted row still confirms *"this company id is real and its audit path is live."* Redaction
  removes the *by whom*; it cannot remove the *that*.
- **Defender:** gains the only thing (a)/(c) cannot give — the target can act.

### 5.4 (c) — an operator-only sink the probed tenant never sees

- **Covers:** Class 1 and **all fourteen of Class 2**.
- ★ **Cost: it is roughly 90% built already, and this is the measurement that matters.**
  - The storage exists: `company_id` is nullable inside the reserved namespace, `organization_id`
    exists, migration `0274` landed, and the partial CHECK
    (`activity_log.ts:126`, `companyOrDenial`) admits a NULL company only for `security.denied.%`.
  - The reader exists: `GET /instance/security-denials` (§2.3), with a keyset cursor and the `0276`
    partial index behind it.
  - Non-disclosure is enforced, not assumed: `activityService.list` filters `company_id = $1`, which
    a NULL never satisfies; `forIssue` was company-scoped by #402 (`activity.ts:190-201`, predicate
    at `:196`); and
    `e0-f013-denial-disclosure-path.integration.test.ts:691-713` provokes a tenantless denial row and
    asserts `GET /issues/:id/activity` does not return it.
  - **What is left is one `recordSecurityDenial` call per site**, with `company_id` NULL, the
    caller-supplied company in `entity_id`, and the reason code. No schema change, no new table, no
    new reader, no new posture argument under Decision #122.
  - **It also inherits cascade immunity**: a NULL-company row cascades with nothing (§7).
- **★ The attack, stated plainly:** `entity_type`/`entity_id` are caller-supplied free text on the
  recorder (`security-denial-audit.ts:168`, `:170`, passed straight into the insert at
  `:288-289`), and these fourteen sites are
  *unauthenticated-or-unvalidated by construction*. A prober can therefore mint denial rows at will —
  the deny paths have no rate limit — filling the operator's **only** denial surface with garbage.
  The `0276` partial index makes the flood cheap to write and cheap to page past; it does not make it
  cheap to triage. This is a real cost of (c) and it is not priced anywhere else in this programme.
- **Defender:** the operator sees everything; the tenant sees nothing (§6).

### 5.5 (d) — probed tenant only

- **Covers:** Class 2 (the probed company is the only company in hand). Wrong for Class 1, where it
  would *move* the row out of the tenant that actually refused.
- **★ It is the option Decision 2 already rejected under another name.** Decision 2 §3(c) measured
  that resolving the destination from a caller-supplied id lets the prober **choose where its own
  refusal is filed** — dilute, flood, or omit. Here it is worse: the company id is not merely
  caller-supplied, it is *unvalidated at the deny site* on at least three of the fourteen
  (`plugins.ts:684`, `:1535`, `company-plugins.ts:333`), and there is no RLS narrowing at all — the
  DE-06 mitigation (`jobs` is FORCE RLS on `organization_id`, `0211:20-28`) does not apply to an
  `authorizeUpgrade` path segment or a plugin route param.
- **Cost:** near zero in code. The cost is the property: **the prober picks the victim's log.**
- **Verdict: REJECT unless explicitly overridden.**

### 5.6 (e) — record nothing, and amend the register

- **Covers:** nothing. **Closes** the ambiguity, which is not nothing.
- **Cost:** amend `DE-21.audit` and `DE-16.audit` in
  `docs/architecture/distributed-execution-threat-controls.json` to say the board/session and
  caller-supplied-company deny paths are deliberately unrecorded.
- **What it costs in coverage:** DE-21's `:400` `!key` arm is the **dominant probe case** — an
  unknown, revoked or malformed token. Choosing not to record it means credential-stuffing against
  the realtime bus leaves the same durable trace as a client with a stale token: none. `logger.warn`
  is not durable and `recordCloudPluginBlock`'s counters reset on restart
  (`cloud-plugin-execution.ts:225-247`).
- **Why it is on the list:** it is the only option honest by construction. If (c) is not funded,
  **(e) is mandatory** — the alternative is a register that claims denial coverage the system does
  not have.

---

## §6 — ★ THE ASYMMETRY, NAMED PLAINLY

**A probed tenant who is never told cannot defend themselves.** They cannot rotate a credential they
do not know was aimed at them, cannot correlate a probe against their own access logs, cannot
escalate, and cannot know that the instance operator is holding evidence about them. Under (a) and
(c) the target of a cross-tenant probe is, structurally, the least-informed party in the system.

**A probed tenant who IS told learns they are a target and by whom — and that notification is itself
a disclosure to whoever triggered it.** An attacker who probes *deliberately to be recorded* writes
into the victim's audit stream: a message channel, a noise generator to bury a real signal in a feed
any company member can read, or a liveness oracle that confirms a company id is real. Redaction
removes *by whom* and leaves *that*; delay removes *when* and leaves *that*.

**There is no option that gives the defender the signal without giving the attacker the channel.**
That is why this is a decision and not a bug. The choice is which party is left blind, and the
recommendation below chooses the probed tenant — deliberately, and with the loss written down.

★ **And it is why §3 is not a side issue.** Today's arrangement manages to be the *worst* corner of
this asymmetry: the probed tenant is blind **and** the prober is informed. Whatever is ruled on Q1,
Q3 has to be closed.

---

## §7 — Retention

### 7.1 How long a denial record lives: UNBOUNDED

Measured at `6b39c77f6`: **no purge, prune, TTL, sweeper or partition touches `activity_log`
anywhere.** The only `delete(activityLog)` in `server/src` outside tests is
`services/companies.ts:656`. No migration under `packages/db/src/migrations` deletes from, or
partitions, the table. `activity_log` is also outside the RLS kernel by design
(`0245_job_activity_audit_rls.sql:15-18`).

**So the lifetime of a denial record is either forever or zero, with nothing in between**, and which
one it is depends entirely on §7.2. This is the half of "Retention" the finding's body never asks
(§1, Q4).

### 7.2 A hostile tenant can delete its own denial history: CONFIRMED

`DELETE /api/companies/:companyId` (`server/src/routes/companies.ts:479-492`) requires
`assertBoard` + `assertCompanyAccess` + `assertRole(db, req, companyId, "founder")` — i.e. **a
founder of that company, and nothing more.** It calls `svc.remove(companyId)`
(`services/companies.ts:577-664`), whose transaction reaches:

```
await tx.delete(activityLog).where(eq(activityLog.companyId, id));   // services/companies.ts:656
```

immediately before deleting the `companies` row. Both mechanisms are live: the explicit delete
above, and the FK `onDelete: "cascade"` on `activity_log.company_id`
(`packages/db/src/schema/activity_log.ts:54`; `0066_complete_fk_cascade_sweep.sql:30`).

**Every `security.denied.*` row filed under that tenant is destroyed — including the operator
plane's only copy.** `GET /instance/security-denials` reads `activity_log`; there is no second
store.

★ **Under the current precedent this is exactly aligned against the operator.** Actor-attribution
files the prober's refusals in the prober's own tenant; the prober's founder can then delete that
tenant and take the evidence with it. Attribution and tamper-resistance are pulling in opposite
directions, and that interaction is not recorded anywhere in the register.

### 7.3 ★ THE ADJACENT ITEM, SETTLED — the grant fact is about a different role

The record carries two facts that were said not to agree:

1. `aoa_app` holds `SELECT, INSERT` on `activity_log` (`0213_e2_serving_role_correction.sql:98`,
   `0214_e2_serving_role_hardening.sql:166`) and `SELECT, UPDATE` on `companies`
   (`0213:68`, `0214:136`). **Verified at source. No `DELETE` on either.**
2. `services/companies.ts:656` issues `tx.delete(activityLog)`. **Verified.** (The record cited this
   as `companies.ts:656-659`; it is `server/src/`**`services`**`/companies.ts`, not `routes/`.)

**They do not disagree, because (2) does not run as `aoa_app`. Measured:**

- `companyService(db)` (`services/companies.ts:112`) takes whatever `Db` it is handed;
  `routes/companies.ts:122` builds it from the router's `db`.
- That `db` is `createDb(config.databaseUrl)` — `server/src/index.ts:400`.
- **Two lines earlier, `index.ts:398` passes the same `config.databaseUrl` to `ensureMigrations`**
  (`index.ts:239-265`), which applies the migration chain. **A role that runs
  `packages/db/src/migrations` is not a non-owner role.**
- `createDb` (`packages/db/src/client.ts:47-58`) opens a plain `postgres(url)` and issues **no
  `SET ROLE`**.
- `aoa_app` lives in a **separate pool**: `createTenantAppDbConnection` → `createRequiredNonOwnerDbConnection(url, "aoa_app")`
  (`client.ts:125-131`, `:90-97`), built from `AOA_APP_DATABASE_URL` and constructed **only** when
  `config.distributedExecutionEnabled` (`index.ts:603-608`). It reaches `jobControlRoutes` and the
  worker-session paths (`app.ts:490-506`, `index.ts:985-986`) — **not** `companyService`.

**Conclusion: the delete path holds `DELETE`, and the `aoa_app` grant is not an exoneration.** Any
fix has to be in the application path or the FK, not in the grant table.

### 7.4 ★ Half of Q5 has already been ruled, in the opposite direction, without a paper

`activity_log.organization_id` is `onDelete: "restrict"`
(`packages/db/src/schema/activity_log.ts:55-62`; `0274_activity_log_denial_sink.sql:31`), with the
reason written into the schema: *"denial evidence must not be deletable by deleting the organization
it incriminates."*

So on the **organization** axis, evidence survives the tenant's deletion, by design. On the
**company** axis it does not. The same question, two axes, opposite answers, and only one of them was
ever written down as a decision. Whatever is ruled here should make them agree or say why they
differ.

★ **And note what Decision 2 already bought:** a tenantless (`company_id IS NULL`) denial row
cascades with nothing and cannot be reached by `tx.delete(activityLog).where(company_id = id)`. The
rows a hostile tenant can delete are **exactly** the rows the actor-attribution precedent files
under it. Option (c) makes the fourteen tamper-proof as a side effect.

---

## §8 — Recommendations: one per class, each with its strongest argument against

### CLASS 1 — the already-wired, actor-attributed sites (DE-19, DE-06 `:122`, DE-21 `:414`/`:455`, and the ten organization-attributed worker sinks)

**RATIFY actor-attribution — and close Q3 in the same wave.**

Ratify: the row is filed under the tenant that owns the refusing credential; the probed tenant's log
stays empty; `entity_id` names the company that was reached for. This is what three suites already
assert and what #402's reader was built on.

Close Q3: exclude the `security.denied.` namespace from **every tenant-facing `activity_log`
reader**, not from `activityService.list` alone. ★ **This sentence named one reader in the first
draft, and that was a half** — Codex P1 on PR #408, verified at source, corrected here rather than
footnoted (§3 carries the census). At minimum, by symbol: `activityService.list`
(`activity.ts:113`), `homeService.summary` (`home.ts:72`), `cockpitTeammatesActivity`
(`cockpit.ts:477`) and `morningDigest` (`proactive.ts:467`). The cheapest correct shape is ONE shared
`notDenialNamespace()` predicate exported beside `SECURITY_DENIAL_ACTION_PREFIX`, so that a future
reader which omits it is a visible omission rather than an invisible one; four independent
predicates drift.

**With a provocation PER READER**, each observed RED first: write one real denial row under company
A through the real recorder, then assert it is absent from `GET /companies/A/activity`, from
`GET /companies/A/home` **including its `details` payload**, from the cockpit feed, and from the
proactive check's input. ★ **A single test against `/activity` would have passed while `/home`
returned the whole row** — which is precisely the shape of defect this condition exists to catch.

> **★ THE STRONGEST ARGUMENT AGAINST.** *It blinds the one party who has a legitimate,
> non-adversarial need for the row.* A founder whose agent key was stolen and is being refused
> across the instance currently has one way to find out, and this removes it. The operator plane is
> not a tenant-facing channel, there is no notification path from it, and in self-hosted
> `local_trusted` the "operator" and the "founder" are the same human — so the exclusion buys
> nothing there and costs the same visibility. The honest counter-shape is a **founder-only**
> denial feed scoped to `company_id = own tenant`, which keeps the visibility and removes only the
> team-member read. This paper does not recommend it, because `assertRole(founder)` is a
> company-scoped check that a compromised founder session passes trivially, and the attacker in the
> §3 scenario is *inside* tenant A. **If the founder weighs tenant self-service above closing the
> oracle, the founder-only feed is the correct ruling and this recommendation should be overturned.**

### CLASS 2 — the fourteen sites with no actor tenant (DE-21 `:297`/`:308`/`:315`/`:326`/`:372`/`:400`; DE-16 `plugins.ts:684`/`:799`/`:1160`/`:1252`/`:1349`/`:1439`/`:1535`, `company-plugins.ts:333`)

**RULE (c) — an operator-only sink, `company_id` NULL, the caller-supplied company in `entity_id`.**

It is the only option that covers all fourteen without either inventing an attribution the attacker
picks (d) or building the per-tenant feed #402 declined (b). It needs **no schema change, no new
table, no new reader and no Decision #122 posture argument** — Decision 2's (a2) relaxation, `0274`,
`0276`, the `forIssue` fence and `GET /instance/security-denials` are already shipped (§5.4). What
remains is one recorder call per site and a provocation per site.

> **★ THE STRONGEST ARGUMENT AGAINST.** *It converts fourteen unauthenticated deny paths into
> fourteen unauthenticated **write** paths into the operator's only evidence surface.* Every one of
> these sites is reachable without a valid credential or without a validated tenant — that is what
> puts them in this class — and `entity_type`/`entity_id` are caller-supplied free text on the
> recorder. There is no rate limit on `authorizeUpgrade`'s reject path and none on the plugin cloud
> gate. A prober can therefore write unbounded rows into the one table `GET /instance/security-denials`
> reads, with attacker-chosen `entity_id`s, at a cost the `0276` partial index makes *lower* for the
> attacker than for the operator triaging it. **(c) should not be signed without a bound on the
> write** — a per-source cap, sampling with a counter, or aggregation — and if no bound will be
> funded, **(e) is the correct ruling for Class 2** and the register must be amended to say these
> paths are deliberately unrecorded.

### CLASS 3 — retention (Q4 and Q5)

**Q5 (tamper): stop the delete for the reserved namespace only.** In `companyService.remove`, do not
`DELETE` `security.denied.*` rows — set their `company_id` to NULL (they satisfy the partial CHECK
by construction, so the row stays legal) — and change the `company_id` FK from `ON DELETE cascade` to
`ON DELETE set null`, by `db:generate` from `packages/db/src/schema/activity_log.ts`. This makes the
company axis agree with the organization axis (§7.4). **Q4 (lifetime): rule it explicitly** — today
it is unbounded and nothing says so.

> **★ THE STRONGEST ARGUMENT AGAINST.** *A company delete is the product's erasure mechanism, and
> this deliberately makes evidence outlive it.* The surviving row names the deleted tenant's actor
> id, key id and requested company. That is a retention posture with a legal surface — erasure
> obligations, data-processing commitments — that this paper cannot price and that no measurement in
> this repository settles. Secondarily: `ON DELETE set null` is only safe **because** the partial
> CHECK confines NULL to the denial namespace; if a future writer ever lands a non-denial row with
> that FK path, the cascade produces a CHECK violation at delete time and the company becomes
> **undeletable** — a fail-closed outcome, but one discovered in production by a founder who cannot
> delete their company. Any unit here owes a provocation for exactly that case.

---

## DECISION BLOCK — for founder signature, three signatures not one

> **Decision 3 of `E0-F013`: retention and disclosure of a denial record.**
>
> **Measured first.** The item is labelled (a)/(b) and holds **five** questions (§1). The cohort it
> genuinely owns is **fourteen deny sites** — six in `authorizeUpgrade`
> (`:297`/`:308`/`:315`/`:326`/`:372`/`:400`) and eight in the plugin cloud gate — and **at none of
> them is any actor tenant resolved**, so today's de facto answer is not available for any of them.
> Nine further DE-16 sinks are Decision 2's already-ruled residue, one
> (`plugin-lifecycle.ts:506`) needs a unit rather than a ruling, and four were not traced.

---

### ☑ **DECISION 3.1 — CLASS 1: the already-attributed sites** — ★ RULED 2026-09-11 (founder): RECOMMENDED. **Implemented by this PR (slice 1).**

- ☑ **★ RECOMMENDED — CHOSEN** — **Ratify actor-attribution**, and **close Q3 in the same wave**: exclude the
  `security.denied.` namespace from **every tenant-facing `activity_log` reader** — at minimum, by
  symbol, `activityService.list`, `homeService.summary`, `cockpitTeammatesActivity` and
  `morningDigest` — through ONE shared predicate, **with a provocation per reader**, each observed
  RED first. **← shipped by this PR: `notDenialNamespace()` in `activity-namespace.ts`, wired into all four readers, four RED-first provocations in `e0-f013-denial-own-tenant-disclosure.integration.test.ts`.**
- ▢ **(alt, not chosen)** Ratify attribution, and expose the namespace to **founders of the owning tenant only**
  instead of excluding it. *Keeps tenant self-service; leaves the oracle open to a compromised
  founder session.*
- ▢ **(alt, not chosen)** Ratify attribution and leave the readers unchanged. *Explicitly accepts that the prober
  reads its own detection. Choose only with that written into the register.*

### ☑ **DECISION 3.2 — CLASS 2: the fourteen sites** — ★ RULED 2026-09-11 (founder): (c) with a write bound. ★ **IMPLEMENTED — slice 2** (`decision3-tenantless-sink`).

- ☑ **★ RECOMMENDED — (c) — CHOSEN** an operator-only sink: `company_id` NULL, the caller-supplied company in
  `entity_id`, readable only via `GET /instance/security-denials`. **Conditional on a bound on the
  write** (per-source cap, sampling, or aggregation) landing with it. **← SHIPPED by slice 2:** the six
  `authorizeUpgrade` tenant-less branches (`live-events-tenantless-denial-audit.ts`,
  surface `security.denied.live_events_upgrade_unattributed`) and the eight plugin-cloud-gate
  sites (`cloud-plugin-denial-audit.ts`, surface `security.denied.cloud_plugin_execution`) call the
  bounded recorder (`bounded-denial-recorder.ts`). The bound is a per-`(surface, coarse-source-key)`
  window cap with aggregation of the remainder into a suppressed-count row; the coarse key is the
  remote address (hashed), NEVER the caller-supplied company/entity id. M1 is in-memory /
  process-local (resets on restart; a durable / cross-replica bound is the follow-up). Proven by
  `bounded-denial-recorder.test.ts` (flood M≫N → ≤ N+1 rows + suppressed count, RED-first) and
  `decision3-tenantless-sink.integration.test.ts` (each site writes a real operator-sink row, and the
  operator reader surfaces them while the tenant feed does not).
- ▢ **(e, not chosen)** Record nothing for these fourteen, and **amend `DE-21.audit` and `DE-16.audit`** in
  `distributed-execution-threat-controls.json` to say so. *Mandatory only if (c)'s write bound will not
  be funded.*
- ▢ **(b, not chosen)** Both tenants, probed copy redacted or delayed. *Requires a per-company denial feed and a
  delay mechanism `activity_log` has no column for; `aoa_app` holds no UPDATE on the table.*
- ▢ **(d) REJECTED** — the probed company id is caller-supplied and
  unvalidated at the sink; this lets a prober choose whose log absorbs the record, with no RLS
  narrowing available.

### ☑ **DECISION 3.3 — CLASS 3: retention** — ★ RULED 2026-09-11 (founder): RECOMMENDED (Q5 set-null + Q4 explicit window). ★ **slice 3** (`decision3-retention`): **Q5 WHOLE**; **Q4 PARTIAL** — explicit window recorded, enforcing purge deferred to E0-F018 (declared, not enforced).

- ☑ **★ RECOMMENDED — Q5 — CHOSEN:** `security.denied.*` rows survive a company delete. `company_id` FK moves
  to `ON DELETE set null` (by `db:generate`) and `companyService.remove` nulls rather than deletes
  them, making the company axis agree with `organization_id`'s existing `restrict` (§7.4). **← SHIPPED
  by slice 3:** `packages/db/src/schema/activity_log.ts` FK is `ON DELETE set null` (migration
  `0280_classy_warstar.sql`, activity_log FK only); `server/src/services/companies.ts remove()` NULLs the
  `security.denied.*` rows (the partial CHECK admits null there) and deletes the ordinary rows BEFORE
  the company delete, so the FK's set-null never fires on a non-denial row. Proven RED-first by
  `server/src/__tests__/e0-f013-denial-retention-survives-delete.integration.test.ts`: a company with
  BOTH a real denial row and an ordinary row is deleted; the denial row survives with `company_id NULL`
  and is still returned by `activityService.securityDenials`, the ordinary row is gone, and the delete
  succeeds (no CHECK violation) — the undeletable-company case §8 names is discharged by the ordinary
  row's presence.
- ☑ **Q4 — CHOSEN:** rule the lifetime explicitly. Today it is **unbounded** and nothing records that.
  ▢ unbounded, stated · ☑ **bounded**, with a purge that itself leaves a record. **← SHIPPED by slice 3
  AS A RECORDED WINDOW, purge DEFERRED:** `SECURITY_DENIAL_RETENTION_DAYS = 365` is the named,
  documented policy constant (`server/src/services/activity-namespace.ts`) — the explicit window the
  ruling requires, replacing "unbounded and nothing says so". The bounded, record-leaving purge is NOT
  wired in this slice: a suitable recurring host exists (the sweeper block in `server/src/index.ts`),
  but the founder's "a purge that itself leaves a record" half collides with the partial CHECK
  `activity_log_company_or_denial_check` — an instance-wide purge has no single company, so its durable
  purge-audit row would carry a NULL `company_id` under a NON-`security.denied.` action, which the CHECK
  rejects. Making that record legal needs a further CHECK change or a separate operator-audit store — a
  schema sub-decision beyond wiring a cron — so it is filed as **E0-F018** (unowned) rather than
  half-built. A FALSE CLAIM OF ENFORCEMENT IS WORSE THAN A MISSING CHECK: the constant and E0-F018 both
  state plainly that the window is declared and not yet enforced.
- ▢ **(alt, not chosen)** Leave the cascade. *Records that a founder may delete the evidence of their own
  probing, and that the operator plane holds no second copy.*
- ☑ **Recorded either way:** the `aoa_app` `SELECT, INSERT`-only grant on `activity_log`
  (`0213:98`, `0214:166`) is **not** an exoneration — `services/companies.ts:656` runs on the
  `createDb(config.databaseUrl)` pool, the same connection string `ensureMigrations` applies DDL
  through (`server/src/index.ts:398-400`). §7.3 has the working.
>
> Signed: **founder** — Date: **2026-09-11** (best-practice throughout; see the ★ RULED block at the top of this paper)

---

## §9 — What this paper is not

It changes **no** finding status, **no** `deliveryStatus`, **no** ownership, **no** clause text and
**no** gate-clause enrolment. It wires nothing and writes no production code. `E0-F013` remains
`open`; `DE-16` and `DE-21` remain `partial` and stay in their cohorts; no count is struck.

It also does not claim the fourteen are the whole of DE-16 or DE-21. Both clauses are conjunctions —
DE-21's "subscribe" and "replay" conjuncts have no writer at all, and DE-16's "reconciliations"
conjunct is untouched here — so **ruling this decision closes neither crossing**, and four DE-16
sinks (§4.3) were not measured by this paper at all.
