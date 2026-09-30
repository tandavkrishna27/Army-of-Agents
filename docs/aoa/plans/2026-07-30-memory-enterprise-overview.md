# Enterprise Memory (Company Brain) — Master Plan / Overview

> **For agentic workers:** This is the **index** for a 6-phase plan suite. Each phase has (or will have) its own bite-sized execution plan in this folder: `2026-07-30-memory-enterprise-p<N>-<name>.md`. Implement each with superpowers:subagent-driven-development or superpowers:executing-plans. Do phases in order — later phases consume interfaces defined in P0/P1.

**Goal:** Turn AoA's memory into a permission-aware "company brain": one canonical DB, RBAC-correct retrieval, a generated per-agent memory map, run-mining that feeds pending candidates, a Guardian for consolidation/lifecycle, and a risk-tiered autonomy engine — all controlled from a new Settings → Memory panel.

**Architecture:** Extend (never replace) the live `memory_items` model with additive columns + a small set of new service modules. Every source produces a *candidate* (`status='pending'`) that passes screening → the tier-policy gate → the canonical DB → generated projections (map / skill files / retrieval). Every read goes through one RBAC filter applied **in the query** (before ranking). Autonomy is tiered by risk, not a single slider.

**Tech Stack:** PostgreSQL + Drizzle ORM (`packages/db`), Express 5 services (`server/src`), React + Vite + Tailwind (`ui/src`), pgvector embeddings (platform service), CLI-only extraction (keyless), Vitest.

**Review status:** plan-eng-review completed 2026-07-30 — 6 findings folded in (confidence type, single RBAC filter, RBAC-in-SQL, actor resolver, cross-scope leakage test, real-run acceptance tasks). `active_context` tier = **durable** (founder-approved).

---

## Scope: this is a plan suite (6 independently shippable phases)

| Phase | Ships | Depends on |
|-------|-------|-----------|
| **P0 · Foundation** | Additive schema, tier-policy engine, RBAC filter module | — |
| **P1 · Retrieval correctness** | RBAC-in-SQL for org+crew runs, actor resolver, always-on core, ORG dept-scope fix, CREW audit, single-filter convergence, leakage test, real-run acceptance, vision/mission→identity migration, Settings→Memory scaffold + tier dials | P0 |
| **P2 · Map + standard files** | Per-agent generated MEMORY_MAP, standard folder taxonomy, manifest API + MCP tool | P0, P1 |
| **P3 · Run-Miner (facts)** | Post-run CLI reflection → pending fact candidates, external/injection screening, conflict surfacing, real-run acceptance | P0, P1 |
| **P4 · Guardian + lifecycle** | Consolidation (dedup/merge/supersede), retention + legal hold, staleness, correction/forgetting, export-includes-memory | P0–P3 |
| **P5 · Autonomy + trust promotion** | Full tier autonomy engine wiring, trust-based class promotion, promotion panel | P0–P4 |

Deferred to a **separate follow-up session** (out of scope here): **procedural self-improvement** — agents authoring/rewriting their own instructions or skills from run outcomes. This plan's Run-Miner emits *fact* candidates only.

---

## Shared model (defined in P0, consumed everywhere)

### Additive schema on `memory_items` (P0)

All nullable / safe-defaulted → non-breaking. Existing 4 layers stay as the UI/data spine.

| Column | Type | Purpose |
|--------|------|---------|
| `owner_type` | `text` null | `company` \| `department` \| `project` \| `user` \| `agent` (typed ownership; today inferred from scope) |
| `owner_id` | `uuid` null | The owning entity id (for `user`/`agent` private memory) |
| `tier` | `text` null | Backfilled from `layer`: `protected` \| `durable` \| `ephemeral` (drives the autonomy gate) |
| `confidence` | `integer` null | 0–100 extraction/consolidation confidence (percent; matches trust-score convention) |
| `provenance_kind` | `text` null | `human` \| `discussion` \| `braindump` \| `run` \| `external` \| `consolidation` |
| `source_ref` | `text` null | Freeform source id (run id, thread id, doc id) — evidence pointer |
| `trust` | `text` null | `observed` \| `extracted` \| `proposed` \| `approved` \| `verified` |
| `effective_from` | `timestamptz` null | Temporal validity start |
| `effective_to` | `timestamptz` null | Temporal validity end |
| `invalidated_at` | `timestamptz` null | Correction/forgetting: retrieval excludes non-null (Zep-style, keeps history) |

No new tables in P0 (YAGNI): candidates reuse `status='pending'`; provenance lives on the row. `memory_conflicts` (P3) and any evidence table (P4) are added only when their phase needs them.

### Shared TypeScript interfaces (P0)

```ts
// server/src/services/memory-tier-policy.ts
export type MemoryTier = "derived" | "ephemeral" | "consolidation" | "durable" | "protected";
export type AutonomyLevel = "manual" | "supervised" | "trusted" | "policy";
export type WriteDisposition = "auto" | "propose" | "human";

export function tierForItem(item: { layer: string | null; tier?: string | null }): MemoryTier;
export function resolveWriteDisposition(
  tier: MemoryTier,
  level: AutonomyLevel,
  opts?: { classPromoted?: boolean },
): WriteDisposition;
```

```ts
// server/src/services/memory-access.ts
export type MemoryActor =
  | { kind: "founder" }
  | { kind: "team_lead"; userId: string; departmentIds: string[] }
  | { kind: "team_member"; userId: string; departmentIds: string[] }
  | { kind: "commander"; userId: string; departmentIds: string[] }
  | { kind: "agent"; agentId: string; departmentIds: string[] };

export interface AccessibleMemoryRow {
  layer: string | null; visibility: string; departmentId: string | null;
  projectId: string | null; ownerType?: string | null; ownerId?: string | null;
  agentId: string | null; invalidatedAt?: Date | null;
}
export function filterMemoryForActor<T extends AccessibleMemoryRow>(items: T[], actor: MemoryActor): T[];
```

`filterMemoryForActor` is the **single** RBAC gate. P1 routes the MCP read tools through it and **removes** the older `filterMemoryForScope` (`server/src/mcp/tools/scope.ts`) — two gates that can drift is the exact leak we are closing. Actor construction — `actorForAgentRun(db, agentId)` (departmentIds from `agent_projects`) / `actorForUser(db, userId)` (role + departmentIds from `user_roles`) — lands in P1-T1. `memoryAccessConditions(actor)` returns Drizzle `WHERE` conditions so RBAC runs **inside** the query (P1-T2); `filterMemoryForActor` remains the post-fetch safety net.

---

## Conventions (apply to every phase)

- **Drizzle only.** Schema edits in `packages/db/src/schema/`, then `pnpm db:generate` for the migration. Never hand-write SQL migration files. (CLAUDE.md Rule #1)
- **Follow existing patterns.** New service ≈ `server/src/services/goals.ts`; new route ≈ `server/src/routes/goals.ts`; new schema ≈ `packages/db/src/schema/goals.ts`.
- **Keyless-except-embeddings.** Run-Miner extraction is CLI-only (Decision #104). No new hosted-API call outside the `createOpenAiEmbedder` chokepoint.
- **Never break the wire protocol** (`PAPERCLIP_RUN_ID` / `X-Paperclip-Run-Id`). Memory is internal; don't touch adapter wire contracts.
- **Tests (from repo root):** `pnpm --filter ./server exec vitest run src/__tests__/<file>` · UI: `pnpm --filter ./ui exec vitest run <path>`
- **Typecheck:** `pnpm --filter ./server typecheck` (or root `pnpm typecheck` for all).
- **Migration:** `pnpm db:generate` after schema edits.
- **TDD, DRY, YAGNI, frequent commits.** Test first, watch it fail, minimal impl, watch it pass, commit.

---

## Test strategy (the "real work" gate)

Four layers, every phase carries the ones it touches:

1. **Unit / contract** — pure functions (`resolveWriteDisposition`, `tierForItem`, `filterMemoryForActor`, RRF ranking) with the `makeTableProxy`/`drizzleOperatorStubs` mock pattern from `server/src/__tests__/memory-multipath.test.ts`.
2. **Integration (embedded-Postgres)** — retrieval + RBAC-in-SQL + run-miner writes + settings dials, using the `*.integration.test.ts` embedded-pg pattern (Windows: `initdbFlags: ["--encoding=UTF8","--locale=C"]`).
3. **E2E (Playwright, Linux CI)** — the Settings → Memory panel and Memory UI changes. (Windows local skips e2e; validate on Linux via push.)
4. **Real-run verification (live instance)** — the acceptance gate, a **concrete task** in P1 (T8) and P3 (T6). Seed a company, run **real org + crew agents**, and confirm: (a) RBAC filtering (an agent in Dept A never sees Dept B's scoped memory), (b) the always-on core is present and small, (c) the Run-Miner produces **pending** candidates from a finished run (never auto-approved durable), (d) each Settings dial takes effect.

**Release gate: zero cross-scope leakage.** P1-T7 is the explicit integration test that attempts cross-department and cross-company retrieval and must return nothing.

---

## Phase task breakdowns

> P0 is fully expanded in `2026-07-30-memory-enterprise-p0-foundation.md`. P1–P5 list tasks here; each gets its own bite-sized plan just before execution.

### P0 · Foundation — see the dedicated plan
Tasks: (1) additive schema + migration, (2) tier-policy engine, (3) RBAC filter module. Exit: all three merged, `pnpm db:generate` additive-only, typecheck green, no live path imports the new modules yet.

### P1 · Retrieval correctness  *(use cases R1–R5, G1, G7)*
- **T1 — Actor resolver.** `actorForAgentRun(db, agentId)` + `actorForUser(db, userId)` in `memory-access.ts`: build a `MemoryActor`, resolving `departmentIds` from `agent_projects` (agents) / `user_roles` (humans). Everything below depends on this.
- **T2 — RBAC in the SQL (before search).** Add `memoryAccessConditions(actor)` to `buildConditions` in `server/src/services/memory.ts:585` so unreadable rows are never fetched — the real "before ranking" guarantee, and a fetch-less win. `filterMemoryForActor` stays as the post-fetch safety net.
- **T3 — Wire ORG.** In `server/src/services/heartbeat.ts` `fetchMemoryContext` (~1390): build the actor, pass `accessConditions` into `searchMultiPath`, apply the safety-net filter, and pass the agent's **department + current goal** as scope (fixes today's company-wide, goal-less dump).
- **T4 — Wire CREW + audit.** Same in `server/src/services/internal-agent/aoa-agents/crew-context-bundle.ts` `loadMemoryLines` (~406), and add `recordMemoryRetrievals` (CREW is currently unaudited).
- **T5 — One filter (DRY).** Route the MCP read tools (`server/src/mcp/tools/read-tools.ts`, `scope.ts`) through `filterMemoryForActor`; delete `filterMemoryForScope`. No two gates that can drift.
- **T6 — Always-on core.** A small deterministic block (agent role + current goal title + "identity/policies exist — use `memory.search`") added to both builders, independent of ranking.
- **T7 — Cross-scope leakage test (release gate).** Integration test on embedded-Postgres: seed two departments + a private agent item, retrieve as an agent in dept A, assert dept B's scoped rows and other agents' private rows never appear. Must be green to close P1.
- **T8 — Real-run acceptance.** Runbook + check: seed a company, run a real ORG + CREW agent, assert (a) RBAC filtering holds and (b) the always-on core is present and small. (Test strategy layer 4.)
- **T9 — Vision/mission → identity migration.** Copy `companies` vision/mission/values into `layer='identity'` memory items (idempotent backfill), point the Memory UI + identity reads at them, keep `companies` fields as a temporary mirror.
- **T10 — Settings → Memory (scaffold + first dials).** New company-settings section (`ui/src/pages/SettingsPage.tsx` + `ui/src/components/settings/sections/MemorySettingsSection.tsx`); wire the **Autonomy tier dials** (company default + department override) into `internal_agent_config` (or a new `memory_settings` row), consumed by `resolveWriteDisposition`. `active_context` tier = **durable** (founder-approved 2026-07-30).
- Exit: T7 green (zero cross-scope leakage), ORG + CREW both audited, T8 real-run (a)+(b) pass.

### P2 · Map + standard files  *(M1–M3)*
- **T1** Standard folder taxonomy seeder (extend `memory-folders.ts` `seedForDepartment`) — Decisions / Playbook / Standards / Risks per department.
- **T2** `buildMemoryManifest(actor)` service — spaces + counts + freshness, generated from `memory_folders` + counts, filtered by `filterMemoryForActor`.
- **T3** `GET /api/companies/:cid/memory/manifest` route + `list_memory_spaces` MCP tool.
- **T4** MEMORY_MAP projection: extend the `memory-skill-sync.ts` pipeline to materialize a per-agent `MEMORY_MAP` markdown alongside the pinned-knowledge skill (permission-scoped, regenerated each run).
- Exit: an agent run receives a map listing only its readable spaces; manifest API RBAC-tested.

### P3 · Run-Miner (facts)  *(I4, I5, G8)*
- **T1** `runMinerEligible(run)` predicate — completed / failed / corrected / high-cost / significant; per-company budget cap from Settings.
- **T2** Post-run hook: on run completion (`server/src/services/internal-agent/aoa-agents/crew-run-outcome.ts` + heartbeat completion) enqueue a CLI reflection extraction (reuse the CLI extractor; **keyless**).
- **T3** Reflection → `status='pending'` fact candidates with `provenance_kind='run'`, `source_ref=runId`, `confidence`.
- **T4** External/MCP ingestion screen: `screenUntrustedContent(text)` — instruction-injection + secret patterns → quarantine (`status='quarantined'`) + founder notification.
- **T5** `memory_conflicts` table + surface Memory Keeper's `detect_conflicts` output as a review item.
- **T6** Real-run acceptance (c): seed a company, run a real ORG + CREW agent to completion, assert the Run-Miner writes **pending** fact candidates (never auto-approved durable). Runbook in this plan.
- Exit: a real finished run yields pending fact candidates; untrusted content is quarantined; T6 passes.

### P4 · Guardian + lifecycle  *(I7, G4–G6, E1)*
- **T1** Seed the **Memory Guardian** crew role (mirror `ensure-command-staff.ts`; propose-only tools; never approves).
- **T2** Consolidation proposals: dedup (reuse `find_similar_memory`) / merge / supersede (`invalidated_at` + a `supersedes` relation) — reversible.
- **T3** Retention sweeper: run/evidence purge after the configured window unless legal-hold; working-memory TTL enforcement.
- **T4** Correction/forgetting UX + routes: mark wrong/outdated/superseded → sets `invalidated_at` → retrieval excludes immediately (history preserved).
- **T5** Export/import includes memory + folders (`server/src/services/company-portability.ts` — add the `memory` section; import warn-and-continue).
- Exit: Guardian proposals appear as pending; invalidated items vanish from retrieval but stay in history; export round-trips memory.

### P5 · Autonomy + trust promotion  *(G2, G3, S3)*
- **T1** Wire `resolveWriteDisposition` into every write path (discussion approve, Librarian, Run-Miner, Guardian, Commander, MCP) so the tier gate actually governs auto vs propose vs human.
- **T2** Trust-promotion policy: per (agent × memory-class × scope) approve-without-edit rate → eligibility; founder confirms promotion (reuse the `hub-autopilot.ts` trust-gate seam, extended from inbox items to memory classes).
- **T3** Promotion panel in Settings → Memory (S3): list eligible/promoted classes, promote/demote.
- **T4** `classPromoted` flows into `resolveWriteDisposition` (durable + trusted + promoted → auto).
- Exit: a promoted class auto-approves for a trusted agent; protected classes never promote; demote works; real-run check (d) passes.

---

## Cross-phase reconciliation (authoritative — resolves the parallel drafts' flagged seams)

The five phase drafts were written in parallel and came out largely self-consistent. Where they touch, these contracts win over any individual doc:

1. **Actor resolvers** live in `server/src/services/memory-access-sql.ts` (drizzle), NOT the pure `memory-access.ts` (P0) which stays dependency-free for its pure test. Signatures: `actorForAgentRun(db, companyId, agentId)` and `actorForUser(db, companyId, userId)` — both carry `companyId`. `filterMemoryForActor` (pure) imports from `memory-access.ts`; `memoryAccessConditions` (drizzle `WHERE`) from `memory-access-sql.ts`.
2. **`memory_settings` is created once, by P1-T10**, with the full column set: `companyId`, nullable `departmentId` (null = company default), `autonomyLevel`, `activeContextTier`, `retentionDays`, `legalHold`, `runMinerEnabled`, `runMinerBudgetCents`, `externalScreeningEnabled`, `privateMemoryEnabled`. Two unique indexes: `(companyId, departmentId)` + a **partial** unique on `(companyId) WHERE department_id IS NULL` (Postgres treats NULLs as distinct, so the plain unique doesn't stop duplicate company-default rows). P3 reads `runMinerBudgetCents`; P5 reads `autonomyLevel`; **P4 adds `workingMemoryTtlDays` via an additive `ALTER TABLE`** — it does NOT re-create the table.
3. **New tables, one owner each:** `memory_settings` (P1), `memory_conflicts` (P3), `memory_class_promotions` (P5). No overlap.
4. **Migration numbers in the phase docs are placeholders.** Let `pnpm db:generate` assign the next free index at execution time, in phase order (P0 first). Do not hardcode `0188`/`0189`.
5. **MEMORY_MAP (P2) is ORG-only at first** (mirrors the pinned-skill precedent); crew-agent map parity is a P2 follow-up, not required to close scenario O6.
6. **The Memory settings tab composes, not replaces,** the existing `LLMProvidersSectionWrapper` (embeddings/OpenAI key, Rule #11). `memory_settings.autonomyLevel` (text enum) is a distinct dial from `internal_agent_config.crew_autonomy_level` (int 0–2).

### Two decisions — RESOLVED (founder-approved 2026-07-30)
- **Promotion eligibility signal (P5): use the `activity_log` `memory.updated` proxy + the agent trust score** for v1. A dedicated approved-without-edit counter is a later add only if the proxy proves noisy.
- **`ephemeral → auto` (P5): intended.** Ephemeral/working memory auto-approves for crew + org agents (matches the locked tier model + existing Commander working-memory behavior). **P5 also adds a one-line note to CLAUDE.md Rule #6** so it does not read as a regression.

### Pre-flight per phase (founder-requested)
Before executing each phase, run a focused eng-check on that phase's doc: re-verify the file/line anchors are still valid on the current branch, confirm the task list covers the phase's use cases, and confirm the test tasks are real. Fix drift in the doc, then execute.

## Migration & rollout

- **Extend, not replace.** P0 adds only nullable columns; existing reads/writes keep working untouched. Each phase ships behind its own merge; nothing is big-bang.
- **Backfill.** `tier` is computed from `layer` at read time (no data backfill). P1-T9 backfills identity memory from `companies` fields (idempotent).
- **Feature-guarded behavior.** New autonomy/gate behavior is inert until Settings → Memory dials are set (default = today's behavior: everything `propose`/human except working=auto).
- **Divergence guards (don't regress):** keep `HEARTBEAT_MAX_CONCURRENT_RUNS_*` (D5); don't add hosted-key extraction (Rule #11); don't rename the Paperclip wire protocol; "Issues"=Tasks table stays `issues`.

## Self-review checklist (run before executing each phase)
1. Every use case in the phase maps to a task.
2. No placeholders — every code step shows real code; every command shows expected output.
3. Type consistency — `MemoryTier`/`AutonomyLevel`/`WriteDisposition`/`MemoryActor` names identical across tasks; `confidence` is `integer` everywhere.
4. Cross-scope leakage test exists and is green before the phase is "done".
