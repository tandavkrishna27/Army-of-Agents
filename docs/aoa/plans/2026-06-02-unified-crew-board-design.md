# Crew Board — Separation & Enrichment (Design)

**Status:** design v2 (2026-06-02) — rewritten after an architecture investigation. Enterprise-quality separation is the core; card enrichment rides on top.

**Goal:** The Crew Board is the crew agents' **dedicated, complete** board — every crew-agent task, from any source, in one place. Crew-agent tasks appear **ONLY** there. The main Tasks board, **all** department/project boards, and **every other task list, count, search, and rollup** are for **org agents + humans** and must **never** show or count crew tasks.

---

## The two worlds (locked)

| | Crew world | Org / human world |
|---|---|---|
| Workers | crew agents — `kind='aoa'` (Scout, Engineer, Planner, Adjutant, Chronicler, Navigator, Memory Keeper, Commander) | org agents (`kind='org'`) + humans |
| Execution | dispatcher, `internal_agent_runs` (Decision #100) | heartbeat, `heartbeat_runs` |
| Surface | **Crew Board only** (Team→Tasks) | main Tasks board + department/project boards + Home + search + counts |

A task is a **crew task** iff its current `assigneeAgentId` points at a **non-terminated `kind='aoa'`** agent. It is **assignee-derived and mutable** — reassigning a task between worlds moves it automatically. There is no stored "class" today (see Hardening).

---

## Why the band-aid was wrong, and the architecture that's right

**Root cause (from the investigation):** crew-ness is implicit and the predicate lives inline in exactly **one** place (the `crewBoard` branch). Every *other* query forgot to apply its negation, so the safe state depends on every caller remembering to filter. The current "hiding" relies on the org-only agent dropdown — a silent accident, not a guarantee.

**Enterprise principle: define it once, default to safe.**

1. **One definition.** A single shared predicate builder lives next to the issues service:
   - `crewAssigneeExists(companyId)` → `EXISTS(SELECT 1 FROM agents WHERE agents.id = issues.assignee_agent_id AND agents.company_id = :cid AND agents.kind = 'aoa' AND agents.status <> 'terminated')`
   - `notCrewAssigned(companyId)` → `NOT (…above…)` (assignee is null, or human, or a non-aoa agent)
   Replaces the inline block at `server/src/services/issues.ts:660-672`. **The only place "crew task" is defined.**

2. **Fail-safe default.** Add `taskScope: 'org' | 'crew' | 'all'` to `IssueFilters`, **default `'org'`**:
   - `'org'` (default) → pushes `notCrewAssigned`. **Every generic `issuesApi.list(companyId)` caller becomes org/human-only with ZERO per-call changes.** A forgotten filter now *hides* crew (safe) instead of leaking it.
   - `'crew'` → pushes `crewAssigneeExists` (this is what the Crew Board passes; replaces the `crewBoard` boolean, keeping the `sourceThreadTitle` LEFT JOIN).
   - `'all'` → no predicate. Explicit escape hatch (admin/debug/Commander self-monitoring).

3. **Server-enforced, everywhere.** Apply the same `notCrewAssigned` to the **count/scan** queries that leak today (one-line `.push(...)` or `AND NOT EXISTS` each). This is the part the band-aid missed entirely.

4. **Mutually exclusive + exhaustive by construction.** Because both sides use the same predicate, every task is crew (aoa assignee) or org (everything else, incl. unassigned). No double-show, no gap.

---

## The leak inventory (what v2 must close)

**UI lists** (all call `issuesApi.list(companyId)` → become org-only via the new default): main Tasks board (`Issues.tsx`), its search + subtitle counts, **department/project board** (`ProjectDetail.tsx`), Home/Dashboard task picker, **global search cmd+K** (`CommandPalette.tsx`), Inbox, Agent detail "assigned tasks", Active-Agents panel, TaskSlideOver children/siblings, workspace task nav, Settings → Activity, Memory task pickers. → fixed automatically by the `'org'` default; the **Crew Board** flips to `taskScope:'crew'`.

**Server counts/scans — classify by intent (NOT a blanket exclude — eng-review correction):**
- **`org` (org workload counts):** `countUnreadTouchedByUser` (sidebar badge), `home.ts` in-review/blocked, `dashboard.ts` status + stale counts.
- **`all` (the task GRAPH — must NOT drop crew):** `goals.ts` + `home.ts` **goal-progress rollups** (crew does goal work — excluding it *under-counts* goals), `projects.ts` **delete gate** (don't silently orphan crew tasks — warn on any), `search.ts` **task search** (crew tasks are discoverable), the slide-over **dependency / children / sibling** lists, the **Active-Agents live panel** (labels crew runs), and Commander `proactive.ts` (monitors its own crew).

> **The rule the review locked:** board surface = `org`/`crew`; the **task graph** (dependencies, rollups, search, safety, live-run labeling) = `all`. A blanket `notCrewAssigned` would break cross-world dependencies, the slide-over's child lists, crew-run labeling, and **under-count goal progress** — those are correctness bugs, not the goal.

**Already correct (no change):** `MyIssues.tsx` (targets unassigned), per-user counts in `team.ts`, Goal detail (renders no task list). Note the existing asymmetry: `home.ts`/`dashboard.ts` already exclude non-org *agents* but not *tasks* — we're finishing that pattern.

---

## The card (crew enrichment is crew-only)

The shared `KanbanCard` is rendered by **3 board surfaces** via 2 components: `IssuesList` (→ main board + project boards) and `CrewBoard`. So:

- **Gate the v1 enrichment** (owner avatar · source badge · artifact chip) behind a `variant`/prop that **only the Crew Board passes.** The main + department board cards render **exactly as before** — org/human cards untouched (your explicit requirement).
- The Crew Board card keeps the enriched look + click → full `TaskSlideOver`.

---

## Edge cases (resolved by the predicate algebra)

- **Unassigned task** → `notCrewAssigned` true → org world. Correct fail-safe.
- **Reassignment crew↔org** → recomputed every query → moves worlds automatically. No migration/event.
- **Crew task with `goalId`/`projectId`** → excluded from project boards, goal rollups, and the project-delete gate by the same `notCrewAssigned`. **This is the big leak the default closes.**
- **`in_review` crew task reviewed by a human** → executor stays the crew agent (`reviewerUserId` is separate) → **stays crew-classed** (review surfaces via Inbox/approvals, not the org board). Product note, not a code branch.

---

## Tests — full matrix (today: 1)

**Types covered:** unit · contract · integration (real DB) · UI/component · regression · edge-case · E2E. *(No eval — this is data-scoping + UI, not an LLM/prompt change.)*

1. **Predicate unit** — `crewAssigneeExists` / `notCrewAssigned` SQL shape (extend `crew-board-filter.test.ts`).
2. **Per-scope contract** *(mocked-DB, existing pattern)* — `list()` pushes `NOT EXISTS` for default `'org'`, `EXISTS` for `'crew'`, neither for `'all'`.
3. **Integration — real DB (e2e harness, embedded pg)** — seed 1 crew + 1 org + 1 unassigned task: `list('org')` → org + unassigned (NOT crew); `list('crew')` → crew only; `list('all')` → all three. The real-query proof, not just predicate shape.
4. **Per-consumer scope — enumerate EVERY non-default surface** — boards/dashboard/badge inherit `org` (one default test); Crew Board → `'crew'`; and each `all` opt-in is its OWN test: dependency picker, slide-over children/siblings, slide-over up/downstream deps, goal-progress rollup (`goals.ts` + `home.ts`), `search.ts` task group, Active-Agents panel, Commander `proactive.ts`. *(A forgotten `all` opt-in is exactly where a leak hides.)*
5. **Leak regression** — a crew task is absent from the org board + org workload counts; present in deps, search, the crew board, and **its goal's progress %**; reassign crew→org makes it appear org-side and vanish from crew.
6. **Edge cases** — unassigned → org; reassignment crew↔org moves surfaces; cross-world dependency (human ↔ crew) resolves + unblocks; crew task counts toward its goal %.
7. **UI / card variant** — enriched chips render only under the crew variant; the org/project `KanbanCard` snapshot is **byte-unchanged**.
8. **E2E (REQUIRED, Linux CI — Windows e2e skipped per CLAUDE.md)** — (a) main board renders zero crew cards; (b) Crew Board renders all crew tasks; (c) reassigning crew→org moves a card from Crew Board to the main board live.

```
SURFACE                                  SCOPE   TESTS
issues.ts list() predicate               —       [#1 unit]
          taskScope default = org        org     [#2 contract] + [#3 real rows]
  ├ boards / dashboard / badge           org     [#4 default] [#5 absent] [#7 card] [#8a]
  ├ goals.ts/home.ts goal rollup         all     [#4] [#5 counts-toward-goal] [#6]
  ├ projects.ts delete gate              all     [#4]
  ├ search.ts task group                 all     [#4] [#5 discoverable]
  └ proactive.ts                         all     [#4]
  CrewBoard                              crew    [#4] [#8b]
  TaskSlideOver children / deps          all     [#4]
  Active-Agents panel                    all     [#4]
  reassign crew→org moves boards         —       [#6] [#8c]
TYPES: unit✓ contract✓ integration✓ component✓ regression✓ edge✓ E2E✓ (eval N/A)
```

---

## Implementation plan (v2 — bite-sized)

**T-A — Centralize + fail-safe default (server core).** Add the shared `crewAssigneeExists`/`notCrewAssigned` predicate; add `taskScope:'org'|'crew'|'all'` to `IssueFilters` (default `'org'`); wire it into `issueService.list()` (replace the inline `crewBoard` block; keep the `sourceThreadTitle` JOIN for `'crew'`). Migrate the `crewBoard` query-param → `taskScope`. Tests.

**T-B — Scope the count/scan queries per the classification (server).** Apply **`org`** (push `notCrewAssigned`) ONLY to the org-workload counts: `countUnreadTouchedByUser` (badge), `home.ts` in-review/blocked, `dashboard.ts` status/stale. Leave the **task graph on `all`** (NO change): `goals.ts` + `home.ts` goal-progress rollups, `projects.ts` delete gate, `search.ts` task search, slide-over deps/children/siblings, Active-Agents panel, Commander `proactive.ts`. Per-site scope tests assert the right choice.

**T-C — Crew Board opts in; everyone else inherits safe default (UI).** Crew Board passes `taskScope:'crew'`. Confirm main board + project boards now exclude crew with **no UI change** (the default does it). Verify counts/badges drop crew.

**T-D — Gate the card enrichment to crew-only (UI).** Put the owner/source/artifact chips behind a Crew-Board-only variant; main + department cards revert to their original rendering. Card snapshot tests.

**T-E — Verify live + design pass.** Restart; confirm: main board **empty** in this all-crew company, crew board shows all crew tasks (enriched), Home/goal/project counts exclude crew, project-delete gate ignores crew. Screenshot; polish card aesthetics; empty-column handling.

---

## Deferred / optional hardening

- **Materialize `assignee_kind` (or generated `is_crew`) on `issues`**, written on every assignee change (the write path exists at `services/issues.ts:1194-1199` / `routes/issues.ts:1193`). Turns the EXISTS subquery into an indexed column compare and makes "class" a first-class, introspectable field. Heavier (migration + write-path invariant); do only if query-time joins become a perf/consistency concern.
- **Board consolidation** (collapse the two board tabs) — still a later call.
- **Command-center** (non-task crew activity on a board) — still deferred.

---

## Decisions locked by eng-review (2026-06-02)

1. **Enforcement = query-time derived predicate** (NOT a materialized column). Correct-by-construction, can't drift, no migration; and the per-consumer scopes all reuse the one predicate, which a materialized `is_crew` column would only complicate (the column would still need the same scope logic on top). Revisit materialization only on a *measured* perf need (Deferred).
2. **Scope per consumer, not a blanket exclude** — board surfaces = `org`/`crew`; the task graph (dependencies, goal rollups, search, delete-safety, live-run labeling) = `all`. *(The review's main catch: a blanket exclude under-counts goal progress and breaks cross-world dependencies.)*
3. **Commander proactive scans = `all`** (monitors its own crew).
4. **`in_review` crew task stays crew-classed** — human review surfaces via Inbox/approvals, not the org board.
5. **Ship complete (Option A)** — one branch: predicate + fail-safe default + per-consumer scoping + card gating + the 6-type test matrix. Phasing wouldn't save the hard classification work.

---

## NOT in scope (deferred)

- **Materialized `is_crew` column** — query-time predicate is correct-by-construction; materialize only on a measured perf need.
- **Board consolidation** (collapse the two board tabs into one) — separate call.
- **Command-center** (non-task crew activity as board items) — bigger feature.
- **Re-seeding crew personas / marketplace catalog** — unrelated follow-up.

## What already exists (reuse, don't rebuild)

- The crew-assignee `EXISTS` predicate (`services/issues.ts:660-672`, `crewBoard=true`) — **centralize it**, don't duplicate.
- The org-default agent filter (`services/agents.ts:384`) — the *accidental* current hiding; the new server scope makes it explicit + reliable.
- The rich `TaskSlideOver` + the shared `KanbanBoard`/`KanbanCard` — reused; the card only gains a crew variant.
- `liveRunsForCompany` (UNIONs crew runs) — already feeds the live pill.

## Failure modes (each needs a test + the right scope)

- **Cross-world dependency dropped** (silent) → blocked task never unblocks. Covered by the `all` dep scope + edge-case test.
- **Goal % under-counts crew work** (silent) → goals look stalled, founders misjudge progress. Covered by `all` goal rollup + the crew-counts-toward-goal test.
- **Project delete orphans crew tasks** (silent) → dangling `projectId`. Covered by `all` delete gate.
- **Org card visually drifts** (regression) → the card-variant snapshot test asserts byte-unchanged.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | hardened | 1 architecture catch — a blanket exclude would **under-count goals** + break **cross-world dependencies**; resolved via per-consumer scope (board=`org`/`crew`, graph=`all`). Enforcement locked = query-time predicate. 6-type test matrix added. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **UNRESOLVED:** none — architecture, per-consumer scope, query-time enforcement, and the test matrix are locked. Final go/no-go on building (Option A) is the user's nod.
- **VERDICT:** **ENG CLEARED** — plan hardened, ready to implement (T-A … T-E). Blast radius: the shared card (gated) + ~30 consumers (mostly the free `org` default-flip + ~6 `all` opt-ins). No CEO/Design review needed (no new product surface; the UI change is card-gating only).
