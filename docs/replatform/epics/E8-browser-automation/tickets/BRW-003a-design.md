# BRW-003a — Split `findCommitted` — DESIGN

**Epic:** E8 · **Lane:** B · **Start SHA:** the commit that adds this file
**Index:** [`BRW-003-design.md`](./BRW-003-design.md) · **Blocks:** 003b, 003c
**Discharges:** no Outcome clause of its own. It is the **structural precondition** for 003c's
retention enforcement, and its mutation tests gate 003b.

---

## 1. The defect: one function answering two opposite questions

`repos.jobArtifacts.findCommitted` (`packages/db/src/repositories/tenant/index.ts:216-228`) filters
`status = 'committed'` and has exactly two callers, which want **opposite** answers:

```
                    findCommitted(job, attempt, identifier)
                    filters status = 'committed'
                              │
          ┌───────────────────┴───────────────────┐
          ▼                                       ▼
 artifact-transfer-grant.ts:111          artifact-transfer-grant.ts:149
 "did this identity EVER commit?"        "is it still READABLE?"
 Rule #7 immutability guard              download branch
 → must count 'expired'  ✅              → must NOT count 'expired'  ❌
```

Their own comments state the intent. The guard: *"never re-grant an upload for an ALREADY-committed
artifact — a re-PUT to the committed key would silently overwrite immutable bytes a reader still
trusts."* The download branch: *"object must already be committed under this tenant."*

**No status value satisfies both**, which is why "pick a better tombstone status" is the wrong move
and the function must split.

## 2. ★ LATENT, not live — stated plainly so nobody over- or under-reacts

**The hole is not open today.** Verified rather than assumed: the only non-`committed` terminal
status is `quarantined`, and `quarantine-finalize.ts:5-9` says the path *"is STRUCTURALLY incapable
of touching the committed attempt row (it calls only `recordOrphanQuarantine`, which writes a row
whose `status='quarantined'` is excluded from the committed partial-unique)."* Quarantine **inserts a
separate orphan row**; it never transitions a committed artifact. So a committed identity only ever
holds `status='committed'`, `findCommitted` finds it, and the guard works.

**The hole opens the moment `'expired'` exists** — which is 003c's write. This ticket lands the clean
shape *before* that write, so 003c never introduces a regression it then has to chase.

An earlier framing called this "a live security fix shipped first". That was an overstatement and is
corrected here.

## 3. The change

**3.1 — Split the repository function.**

| Function | Predicate | Caller |
|---|---|---|
| `findCommitted` | `status = 'committed'` (unchanged) | download readability (`:149`) |
| `findEverCommitted` | `status IN ('committed','expired')` | immutability guard (`:111`) |

Both stay tenant-scoped on `(jobId, attempt, identifier)` exactly as today. No behaviour changes
while `'expired'` does not yet exist — **that is the point**: this ticket is a pure refactor whose
observable behaviour is identical, which is what makes it safe to land first.

**Shape: ONE query, TWO names.** (plan-eng-review D3)

```
  findByIdentity(input, status)        <- private, scoped INSIDE the jobArtifacts block.
        |                                 Holds the tenant/identity predicate ONCE:
        |                                 (jobId, attempt, identifier) + ONE status.
        +-- findCommitted(input)       -> findByIdentity(input, 'committed')
        |
        +-- findEverCommitted(input)   -> findByIdentity(input, 'committed')
                                          ?? findByIdentity(input, 'expired')
```

**Two sequential single-status lookups, NOT one `status IN (...)` query.** (plan-eng-review D4,
performance.) `job_artifacts_committed_identity_uidx` is **partial** — `WHERE status = 'committed'`
(`schema/job_artifacts.ts:92-94`) — so it serves today's `findCommitted` exactly. An `IN` predicate
**cannot use that partial index**: the planner would fall back to `job_artifacts_job_idx` (jobId
only) plus a filter, and there is no expired partial index to BitmapOr with until 003c.

Sequential lookups keep the hot path on its exact index: the common case — the identity IS
committed — costs precisely what it costs today, one indexed hit. Only the miss pays a second
lookup, and after 003c that second lookup lands on its own partial index too. The shape composes
forward instead of needing revisiting.

**Non-obvious dependency, recorded because it is invisible at the call site:** the index leads with
`organization_id`, but the query does **not** filter it. The leading column is supplied by RLS —
`job_artifacts_tenant_isolation` with `organization_id = current_setting('aoa.organization_id')`
(`job-control-legacy-grants.ts:496`). So this lookup is index-served **because it runs inside a
tenant context**. Run it outside one and it loses both the scoping and the index.

The private helper is scoped **inside the `jobArtifacts` block**, not at module level: every other
member of `tenant/index.ts` is a flat self-contained method, and a file-wide helper would introduce
a pattern the file has no precedent for.

Two independent full queries were rejected: the predicate that must never diverge is the
tenant/identity clause, and this repo has already paid three CI rounds for two hand-maintained
lists disagreeing silently (`POLICY_COUNTS` vs `RLS_RELATIONS`).

A single exported lookup taking a status set was rejected for a sharper reason: **the original
defect was that CALL SITES had to know the predicate meant two different things.** A status-set
parameter does not fix that — it relocates it from a shared predicate to a shared signature, and a
reviewer at the call site would have to reason about what a set of status strings implies. The
exported names state the QUESTION, so no caller ever handles a status set.

**3.2 — The second partial unique moves to 003c.** (plan-eng-review D2)

`job_artifacts_committed_identity_uidx` is `WHERE status = 'committed'`
(`schema/job_artifacts.ts:92-94`), so an expired row drops out of it and the identity becomes
re-insertable. That needs a matching `job_artifacts_expired_identity_uidx` — **but it lands in
003c, not here**, for three reasons:

1. **An assertion that cannot fail is not an assertion.** Nothing writes `'expired'` until 003c, so
   the only test available here is schema introspection — *does the index exist*. In 003c you can
   insert two expired rows for one identity and watch the second be rejected. Same DDL; one version
   is proof, the other is paperwork.
2. **A constraint belongs with its first writer.** A 003c reviewer sees the `'expired'` write and
   the index protecting it in ONE diff and can judge whether it is right.
3. **003a stays a provable refactor.** Its value is that nothing observable changes, which is what
   makes it safe to land ahead of two dependent tickets.

Costs nothing in schedule: 003c is blocked on Lane A's edit, not on migration count.

**3.3 — No migration in 003a.** With the index moved to 003c, this ticket touches no schema at all
— it is a pure TypeScript refactor over the repository layer. That is the strongest possible form
of "behaviour-preserving", and it removes the migration-number collision risk with Lane A entirely.

## 4. ★ Mutation tests — the gate for 003b

Both directions are mandatory. Each names the hole it keeps shut:

| Mutant | Must be | Hole it opens if it survives |
|---|---|---|
| immutability query **excludes** `expired` | **killed** | re-grant + re-commit over immutable bytes — Rule #7 |
| download query **includes** `expired` | **killed** | expiry deletes the bytes and still hands out a grant for them |

**A surviving mutant here blocks 003b**, because 003b builds capture on top of these semantics.

## 5. Tests, and their red states

All three are **server-side**, per the index's rule — the worker half has no production boot root, so
a worker-only proof would be vacuous.

| Test | Assertion | Red state |
|---|---|---|
| guard counts expired | an `expired` identity is **refused** a new upload grant | `findEverCommitted` does not exist |
| download excludes expired | an `expired` identity is **refused** a download grant | same |
| unchanged today | with no `expired` rows, both functions agree on every existing fixture | — behaviour-preserving refactor, asserted rather than assumed |
| ★ short-circuit | `findEverCommitted` issues **ONE** query when the identity is committed, **TWO** only on a miss | the two-lookup shape is currently a rationale with no assertion |

The third is the one that makes this landable first: it pins that **today's behaviour is unchanged**,
so the refactor cannot quietly alter grant or download decisions before 003c arrives.

The fourth closes a gap the coverage diagram surfaced: **the two-lookup shape is a performance claim,
and a claim with no assertion is the shape this programme keeps shipping.** Without it, someone
later "simplifies" the two lookups into one `status IN (...)` query, every test still passes, and
the hot path silently loses its partial index. Counting queries is the only thing that fails.

## 6. Surfaces (2 files)

`repositories/tenant/index.ts` (the interface at `:83` **and** the implementation at `:216`) and
`services/artifact-transfer-grant.ts` (the two call sites, verified by count: `:111` guard and
`:149` download, with no others in production). Plus tests. **No schema, no migration.**

Well inside the complexity gate — which is what a structural ticket should look like.

## 6a. A stale comment this change creates — fixed in the same commit

`schema/job_artifacts.ts:61-62` currently reads: *"`status='quarantined'` (a value `findCommitted`
never returns, so the `job_artifacts_committed_identity_uidx WHERE status='committed'`
partial-unique ...)"*.

After the split that comment misleads: `findEverCommitted` also never returns `quarantined`, but the
comment names only one function, so a reader would reasonably infer the other one does. **Comment
and diagram maintenance is part of the change, not a follow-up** — a stale comment is worse than no
comment because it actively misinforms. Updated in the same commit.

## 7. Checked, and deliberately not absorbed

- **`packages/shared` DTOs enumerating `job_artifacts.status`** — **DISCHARGED during review.**
  `grep -ran "job_artifacts|JobArtifactStatus|jobArtifact" packages/shared/src` returns **nothing**,
  and no file outside `packages/db` / `server/src` types the status union. Widening the status set
  is therefore not a type-level break. The adversarial review flagged this as unverified by anyone
  including itself; it is now verified rather than carried forward as a promise.
- **Lane A's `isSweepEligible`** — not touched here. It is 003c's blocker and Lane A's edit.
- **`'expired'` is never written by this ticket.** Nothing sets it; 003c does. This ticket only makes
  the shape correct for when it is.

---

## 8. What already exists (and is reused, not rebuilt)

| Exists | Reused how |
|---|---|
| `findCommitted` query shape | kept verbatim as the private helper's body; only the status becomes a parameter |
| `job_artifacts_committed_identity_uidx` | unchanged. The sequential-lookup shape exists specifically so this index keeps serving the hot path |
| RLS `job_artifacts_tenant_isolation` | supplies the index's leading column; nothing new is added for scoping |
| the two call sites' reject paths | unchanged — both already handle a null return correctly |

Nothing here is rebuilt. The ticket is a rename-and-parameterise over one existing query.

## 9. NOT in scope — considered and deferred, with reasons

| Deferred | Why |
|---|---|
| `job_artifacts_expired_identity_uidx` | → 003c, where a uniqueness violation is constructible. Here the only possible assertion is *does the index exist* (plan-eng-review D2) |
| Writing `'expired'` anywhere | → 003c. This ticket only makes the shape correct for when something does |
| Lane A's `isSweepEligible` edit | Lane A's file and 003c's blocker. Not forked, not pre-empted |
| Any browser capture work | → 003b. A structural and a behavioural change must not share a ticket |
| A non-partial covering index | Rejected: a third index on a write-heavy table to serve a path the sequential lookups already keep on its exact index |

## 10. Failure modes — one realistic production failure per new codepath

| Codepath | Realistic failure | Test? | Error handling? | Silent? |
|---|---|---|---|---|
| `findByIdentity` | called outside a tenant context → RLS returns nothing AND the index is unusable | partially — the tenant-scoped repo makes this structurally hard to reach | RLS fails closed (returns no rows) | **would be silent**: a null read as "never committed" |
| `findEverCommitted` | someone collapses it to `status IN (...)` → partial index lost | **yes** — the short-circuit query-count test | none needed | would have been silent; the test is what makes it loud |
| `findCommitted` | accidentally widened to include `expired` → download grant for deleted bytes | **yes** — mutation, must be killed | reject path unchanged | would be silent |
| guard call site `:111` | narrowed back to `committed` only → re-grant over immutable bytes | **yes** — mutation, must be killed | reject path unchanged | would be silent |

**★ One critical gap, named rather than hidden:** the first row. A call outside a tenant context
returns `null`, which both call sites read as *"never committed"* — the fail-OPEN reading of a
fail-closed mechanism. It is structurally hard to reach (the repository is only constructed inside
`runInTenant`), which is why it is a gap and not a defect. **003a does not add a guard for it**; it
is recorded here so the next person to widen the repository's construction surface sees it first.

## 11. Parallelization

**Sequential implementation, no parallelization opportunity.** Two files, one logical change, and
003b/003c both depend on it. Splitting it across worktrees would cost more coordination than the
whole ticket contains.

## 12. Implementation Tasks

Synthesized from this review's findings. Each derives from a specific finding above.

- [ ] **T1 (P1, human: ~30min / CC: ~5min)** — repositories — add the private `findByIdentity` and split into `findCommitted` / `findEverCommitted`
  - Surfaced by: §1 — one function answering two opposite questions; D3 — shared helper, two names
  - Files: `packages/db/src/repositories/tenant/index.ts` (interface `:83` AND implementation `:216`)
  - Verify: `pnpm --filter @armyofagents/db exec tsc --noEmit`
- [ ] **T2 (P1, human: ~15min / CC: ~3min)** — grant service — re-point `:111` to `findEverCommitted`, leave `:149` on `findCommitted`
  - Surfaced by: §1 — the two call sites want opposite answers
  - Files: `server/src/services/artifact-transfer-grant.ts`
  - Verify: the four tests in §5
- [ ] **T3 (P1, human: ~45min / CC: ~10min)** — tests — four tests + two mutants, all server-side
  - Surfaced by: §4, §5, and the §3 coverage gap (query-count short-circuit)
  - Files: `server/src/__tests__/` (new)
  - Verify: `AOA_RUN_WIN_INTEGRATION=1 pnpm --filter @armyofagents/server exec vitest run <file>`
- [ ] **T4 (P2, human: ~5min / CC: ~1min)** — schema comment — update the stale `findCommitted` reference
  - Surfaced by: §6a — the split makes the existing comment misleading
  - Files: `packages/db/src/schema/job_artifacts.ts:61-62`
  - Verify: read it back; it must name both functions or neither
- [x] **T5 (P1) — DISCHARGED IN REVIEW** — preflight: no `packages/shared` DTO enumerates `job_artifacts.status`
  - Surfaced by: §7 — flagged unverified by the adversarial review
  - Result: `grep -ran` over `packages/shared/src` returns nothing; no file outside `packages/db` /
    `server/src` types the status union. Not a type-level break.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 4 issues, 1 critical gap |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not applicable (no UI) |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**Scope:** REDUCED. The complexity gate triggered at ~15 surfaces + a cross-lane edit (threshold 8).
BRW-003 split into 003a/003b/003c on dependency lines, not arbitrary ones. 003a is now **2 files, no
schema, no migration**.

**Findings folded in:** D2 moved the expired partial unique to 003c so its test can actually fail.
D3 chose a shared private helper with two named wrappers over copy-paste or a status-set parameter.
Performance review changed `findEverCommitted` to two sequential single-status lookups, because an
`IN` predicate cannot use the partial index the hot path depends on. The coverage diagram surfaced
one gap — the two-lookup shape was a performance claim with no assertion — closed by a query-count
test. A stale schema comment created by this change is fixed in the same commit. T5 was discharged
during review rather than deferred.

**Critical gap (1):** a call outside a tenant context returns `null`, which both call sites read as
*"never committed"* — the fail-OPEN reading of a fail-closed mechanism. Structurally hard to reach
(the repository is only constructed inside `runInTenant`), so it is recorded rather than guarded.

**VERDICT:** ENG CLEARED for 003a — ready to implement. 003b and 003c are designed but not reviewed;
each gets its own review before implementation.

**UNRESOLVED DECISIONS:**
- 003b: whether video ships (with a fail-first deadlock-ordering test) or splits (with `recordVideo=true` refusing the job). Not 003a's to resolve.
