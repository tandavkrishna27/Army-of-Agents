# W4 Steward Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first W4 Steward slice: a dedicated `kind='aoa'` Steward crew agent plus deterministic hub curation plumbing for grouping, priority/SLA explanation, and "why you are seeing this" fields. This PR must not build W5 runtime prompt bridges or Mail drafting.

**Architecture:** W4 extends the shipped hub control plane. Deterministic curation runs in a server-side service/sweep and writes bounded denormalized metadata onto existing hub items. The Steward crew agent is seeded like Chronicler through `seedCrewAgent`, has a minimal tool allowlist, and is woken only for explanation/summarization work that needs language judgment. Autopilot remains the authority gate: deterministic curation can suggest or explain, but auto-handling still flows through the W3 Autopilot policy/evaluation/audit path.

**Tech Stack:** Drizzle/Postgres schema + generated migrations, Express 5 services/routes where needed, shared hub contracts/validators, AoA crew seeding and wakeup requests, React/Vite hub UI, Vitest unit/integration tests, Playwright e2e.

**Roadmap position:** W4 follows W3 Autopilot Core. W5 runtime decision routing remains a later workstream and requires a per-adapter feasibility matrix before code.

---

## Scope Boundary

In scope:

- Seed one dedicated AoA crew agent named `Steward`.
- Add Steward onboarding assets and bundle registration.
- Add a deterministic hub curation service and scheduled sweep.
- Add hub curation metadata needed by the UI:
  - stable curated group label/summary on top of the existing hub `groupKey`
  - deterministic priority reason
  - deterministic SLA/escalation reason where available
  - optional Steward explanation text
  - curation revision/timestamps for stale-write protection
- Wake Steward for bounded, mostly silent explanation/group-summary jobs.
- Surface explanation/group summary in the existing hub list/viewer/Home surfaces.
- Add tests across shared contracts, DB schema, services, routes if added, UI, and one final operator e2e flow.

Out of scope:

- W5 adapter bridges, CLI permission interception, runtime prompt relay, nonce/answer tables, and allow-always policy.
- Mail/email drafting.
- Source-specific approve/reject side effects.
- New autonomous actions beyond the W3 safe hub lifecycle actions.
- Conversational "operate my queue" Commander tools unless the implementation needs a read-only hook for visibility.
- Cross-company global hub.

## Product Decisions

1. **Steward is the name.** The master scope left Steward/Dispatcher/Aide/Concierge open. This plan locks `Steward` for W4 to avoid colliding with the existing Dispatcher crew role.
2. **Worker first, agent second.** Deterministic curation owns grouping, dedup, priority/SLA explanation, and stale metadata repair. The LLM Steward only writes language judgment: group summaries and concise explanation prose.
3. **Autopilot stays the action gate.** Steward does not directly resolve/archive hub items. If a future Steward decision wants to act, it must call the W3 Autopilot service path so audit/undo/trust gates stay intact.
4. **No source table ownership changes.** Hub curation metadata lives on the hub index or a hub-owned companion table. The source viewer remains authoritative for source-specific details.
5. **Metadata is bounded and redacted.** Steward prompts receive only redacted hub summaries and source pointers, never raw secrets. Stored explanations are short, display-ready, and safe to show in the hub.
6. **Stale-write safe.** Curation writes must include a revision/version guard or a deterministic recompute check so a delayed Steward wakeup cannot overwrite newer hub metadata.
7. **Marketplace-managed crews are respected.** Startup/company backfill must not seed legacy Steward into companies whose crew is governed by a marketplace package.
8. **Curation does not bump lifecycle version.** Display-only curation writes use `curationRevision`, not `hub_items.version`, so a background explanation update cannot make a human lifecycle action 409.
9. **W4a is reason-only for priority/SLA.** This slice may write priority/SLA explanation metadata, but it must not change `priority`, `slaAt`, ownership, assignment, escalation, resolve, or archive state unless the plan is amended with explicit audit/activity/reconciliation requirements.

## Steward Execution Contract

Steward wakeups and tools must be locked before implementation so the runner, sweep, and tests agree on one durable contract.

- **Wakeup source:** `sweep.steward`.
- **Wakeup reason:** `hub_curation_summary`.
- **Payload shape:**
  - `role: "steward"`
  - `targetType: "item" | "group"`
  - `hubItemId?: string`
  - `groupKey?: string`
  - `companyId: string`
  - `expectedCurationRevision: number`
  - `evidence: Array<{ hubItemId: string; semanticType: string; sourceType: string | null; sourceId: string | null }>`
- **Targeting rule:** use `targetType: "item"` for one-off explanations and `targetType: "group"` for grouped rows. Group wakeups must include a bounded evidence list and the deterministic `groupKey`.
- **Dedup key format:** `steward:${companyId}:${targetType}:${hubItemIdOrGroupKey}:queued`.
- **Read contract:** Steward may read only redacted hub item envelopes and bounded source pointers required to explain the item/group. Raw source bodies are out of scope for W4a.
- **Write contract:** Steward may write only curation summary/reason fields through a narrow tool such as `hub.updateCurationSummary`. The write must include `expectedCurationRevision`.
- **Conflict behavior:** stale curation writes return a conflict result and do not retry immediately; the next deterministic sweep recomputes and queues a fresh wakeup if still needed.
- **Failure behavior:** failed Steward wakeups leave deterministic curation metadata intact and may be retried by the next sweep subject to dedup/debounce. No lifecycle action is taken on failure.
- **Live update behavior:** successful curation writes publish a hub live event or another existing query-invalidation signal so open hub clients refresh metadata without changing lifecycle version or counters.

## File Structure

### Shared Contracts

- Modify `packages/shared/src/hub.ts`
  - Add curation metadata types/constants if they are needed outside validators.
- Modify `packages/shared/src/validators/hub.ts`
  - Add hub curation metadata schema and response types if routes/UI consume structured fields.
- Modify `packages/shared/src/index.ts`
  - Export new hub curation contracts.
- Modify `packages/shared/src/__tests__/hub-contract.test.ts`
  - Contract tests for metadata shape, string limits, and total semantic-type compatibility.

### Database

- Modify `packages/db/src/schema/notifications.ts`
  - Add hub curation columns to the existing physical `notifications`/`hubItems` table if metadata is simple and queried with the hot list:
    - `curationGroupLabel`
    - `curationGroupSummary`
    - `curationReason`
    - `curationPriorityReason`
    - `curationRevision`
    - `curatedAt`
    - `curatedByAgentId`
  - Reuse the existing `groupKey` column for deterministic grouping unless implementation proves it needs a separate candidate key. Do not introduce a parallel group-key field without documenting why the existing W1d grouping contract is insufficient.
  - Keep names aligned with existing camelCase schema conventions.
- Or create `packages/db/src/schema/hub_curation.ts` only if the first implementation needs multi-row history or larger payloads. Prefer columns for W4a unless investigation proves a table is safer.
- Modify `packages/db/src/schema/index.ts` if a new table is used.
- Generate migration with `pnpm db:generate`.
- Add/extend schema tests in `packages/db/src/__tests__/hub-items-schema.test.ts`.

### Server - Steward Crew

- Create `server/src/services/internal-agent/aoa-agents/ensure-steward.ts`
  - Seed `Steward` with `kind='aoa'`, `role='general'`, `runtimeConfig.aoa.role='member'`, and `heartbeat.enabled=false`.
  - Use `seedCrewAgent`.
  - Trigger: `kind='sweep'`, `config: { role: "steward" }`.
  - Tool allowlist should be minimal. Initial target:
    - read hub item/group context
    - write Steward explanation/summary only
    - no `post_entry`, no generic memory writes, no source-specific approval/action tools.
- Modify `server/src/services/internal-agent/aoa-agents/seed-crew-agent.ts`
  - Add `"steward"` to `instructionBundleRole`.
- Modify `server/src/services/internal-agent/aoa-agents/ensure-all-crew.ts`
  - Add Steward to the legacy ensure list after Chronicler.
- Modify `server/src/services/default-agent-instructions.ts`
  - Register `steward` bundle files and directory.
- Add `server/src/onboarding-assets/steward/{AGENTS.md,HEARTBEAT.md,SOUL.md,TOOLS.md}`.
- Add tests:
  - `server/src/__tests__/steward.test.ts`
  - extend `server/src/__tests__/default-agent-instructions-crew-roles.test.ts`
  - extend seed/marketplace-managed coverage at the caller seam. `ensureAllCrewAgents` itself does not perform the marketplace gate; startup/company-create callers are responsible for checking `isCrewMarketplaceManaged`.

### Server - Curation Worker

- Create `server/src/services/hub-curation.ts`
  - Deterministically select open hub items needing curation.
  - Derive stable group keys/labels from semantic type, scope, source, and related entities.
  - Score priority/SLA reasons without LLM, without mutating `priority` or `slaAt` in W4a.
  - Redact and bound text before persisting.
  - Write metadata with `curationRevision` protection. Do not bump `hubItems.version` for display-only curation.
  - Publish a hub metadata-change live event or existing invalidation signal for clients after curation metadata changes.
  - Queue Steward wakeups only when language judgment is needed.
- Create `server/src/services/internal-agent/aoa-agents/sweep-steward.ts`
  - Find enabled Steward sweep triggers.
  - Skip paused/terminated agents and crew-paused companies.
  - Run deterministic curation for each company.
  - Queue bounded Steward wakeups for groups/items with stale explanation metadata.
  - Use `agentWakeupRequests.dedupKey` for queued cross-process dedup where practical.
  - Use an in-flight guard in `server/src/index.ts`.
- Modify `server/src/index.ts`
  - Import and schedule `runStewardSweep`, with a conservative cadence such as 2 minutes for deterministic curation and no immediate LLM storm.
- Modify `server/src/services/index.ts`
  - Export `hubCurationService` if other server surfaces need it.
- Add tests:
  - `server/src/__tests__/hub-curation.test.ts`
  - `server/src/__tests__/hub-curation.integration.test.ts`
  - `server/src/__tests__/sweep-steward.test.ts`
  - update `server/src/__tests__/hub-items-query.integration.test.ts` for curated group output.

### Server - Steward Write Tool

- Add a narrow internal-agent tool only if existing thread/hub tools cannot safely update hub curation metadata:
  - Candidate file: `server/src/services/internal-agent/tools/hub-curation-tools.ts`
  - Tool names should be specific, for example `hub.updateCurationSummary`.
  - Inputs must require `companyId`, `hubItemId` or group key, `expectedCurationRevision`, summary/reason fields, and source evidence pointers.
  - The tool must enforce company scope and reject source-side lifecycle actions.
- Register the tool in `server/src/services/internal-agent/tool-registry.ts`.
- Add tests:
  - `server/src/services/internal-agent/__tests__/` or `server/src/__tests__/hub-curation-tools.test.ts`
  - allowlist regression test proving Steward cannot call non-curation tools.

### UI

- Modify `ui/src/components/hub/HubList.tsx`
  - Prefer curated group labels/summaries when present.
  - Show compact "why" text without increasing row height unpredictably.
- Modify `ui/src/components/hub/HubViewer.tsx` or registry viewer components
  - Surface "Why you are seeing this" when curation metadata exists.
- Modify `ui/src/components/hub/HubHome.tsx`
  - Show curated high-priority/needs-you-most reasons when available.
- Modify `ui/src/components/hub/hubTypes.ts` and `ui/src/api/hub-items.ts`
  - Add curation fields to typed hub rows if generated from shared types.
- Add tests:
  - `ui/src/components/hub/__tests__/HubShell.test.tsx`
  - `ui/src/components/hub/__tests__/HubList.test.tsx` if present or create it.
  - `ui/src/__tests__/InboxHub.test.tsx`

### E2E

- Add `tests/e2e/inbox-hub-steward-curation.spec.ts`
  - Seed or trigger several open hub items.
  - Verify the hub shows curated group/priority explanation.
  - Open an item and verify "Why you are seeing this".
  - Verify lifecycle actions still use existing hub actions and Autopilot audit/undo still behaves.
  - Include mobile viewport assertion for readable explanation text.

---

## Task 1: Shared and DB Curation Contract

**Files:**
- `packages/shared/src/hub.ts`
- `packages/shared/src/validators/hub.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/__tests__/hub-contract.test.ts`
- `packages/db/src/schema/notifications.ts`
- `packages/db/src/__tests__/hub-items-schema.test.ts`

- [x] Write failing shared contract tests for curation metadata:
  - group key/label/reason fields are optional and bounded
  - curation revision is non-negative
  - curation metadata does not add a new hub semantic type
  - stored explanation strings reject unbounded text
- [x] Run focused shared tests and confirm failure:

```powershell
corepack pnpm@9.15.4 test:run packages/shared/src/__tests__/hub-contract.test.ts
```

- [x] Add shared contracts/validators.
- [x] Write failing DB schema tests for exported curation columns.
- [x] Add DB schema columns or table.
- [x] Generate migration:

```powershell
corepack pnpm@9.15.4 db:generate
```

- [x] Run focused DB tests:

```powershell
corepack pnpm@9.15.4 test:run packages/db/src/__tests__/hub-items-schema.test.ts
```

## Task 2: Steward Crew Agent Seed

**Files:**
- `server/src/services/internal-agent/aoa-agents/ensure-steward.ts`
- `server/src/services/internal-agent/aoa-agents/ensure-all-crew.ts`
- `server/src/services/internal-agent/aoa-agents/seed-crew-agent.ts`
- `server/src/services/default-agent-instructions.ts`
- `server/src/onboarding-assets/steward/AGENTS.md`
- `server/src/onboarding-assets/steward/HEARTBEAT.md`
- `server/src/onboarding-assets/steward/SOUL.md`
- `server/src/onboarding-assets/steward/TOOLS.md`
- `server/src/__tests__/steward.test.ts`
- `server/src/__tests__/default-agent-instructions-crew-roles.test.ts`

- [x] Write failing tests that `ensureSteward` creates exactly one `kind='aoa'` Steward per company with a `sweep` trigger `{ role: "steward" }`.
- [x] Write failing tests that rerunning `ensureAllCrewAgents` backfills Steward for legacy-managed companies.
- [x] Write failing tests at the startup/company-create seam, or against the existing gate helper, proving marketplace-managed companies do not receive legacy Steward seeding.
- [x] Write failing tests that the Steward instruction bundle loads.
- [x] Implement `ensure-steward.ts`, bundle registration, and onboarding assets.
- [x] Add `"steward"` to the `seedCrewAgent` bundle role union.
- [x] Add Steward to `ensureAllCrewAgents`.
- [x] Run focused tests:

```powershell
corepack pnpm@9.15.4 test:run server/src/__tests__/steward.test.ts server/src/__tests__/default-agent-instructions-crew-roles.test.ts server/src/__tests__/ensure-all-crew.test.ts server/src/__tests__/internal-agent-config-reensure.test.ts
```

## Task 3: Deterministic Hub Curation Service

**Files:**
- `server/src/services/hub-curation.ts`
- `server/src/services/index.ts`
- `server/src/__tests__/hub-curation.test.ts`
- `server/src/__tests__/hub-curation.integration.test.ts`
- `server/src/__tests__/hub-items-query.integration.test.ts`

- [x] Write failing unit tests for group-key derivation:
  - explicit existing `groupKey` wins
  - source/scope/type fallback stays deterministic
  - board-pool and owner-specific items are not merged unsafely
  - cross-company items never group together
- [x] Write failing unit tests for priority/SLA reasons:
  - urgent priority and near-SLA items get visible reasons
  - normal items do not get noisy explanations
  - stale source metadata does not overwrite newer curation revision
- [x] Write failing tests proving display-only curation updates do not bump `hubItems.version` and do not cause lifecycle action `expectedVersion` conflicts.
- [x] Write failing tests proving curation writes publish a metadata refresh signal without changing counters.
- [x] Write failing integration test that `hubItemsService.query` returns curated group fields when present.
- [x] Implement `hubCurationService`.
- [x] Wire exports only where needed.
- [x] Run focused tests:

```powershell
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-curation.test.ts server/src/__tests__/hub-curation.integration.test.ts server/src/__tests__/hub-items-query.integration.test.ts
```

## Task 4: Steward Sweep and Wakeup Dedup

**Files:**
- `server/src/services/internal-agent/aoa-agents/sweep-steward.ts`
- `server/src/index.ts`
- `server/src/__tests__/sweep-steward.test.ts`

- [x] Write failing tests that the sweep:
  - finds enabled Steward triggers only
  - skips paused/terminated Steward agents
  - skips crew-paused companies
  - runs deterministic curation per company
  - queues bounded Steward wakeups only for stale explanation/group-summary work
  - uses queued dedup protection so repeated sweeps do not flood wakeups
- [x] Implement `runStewardSweep`.
- [x] Schedule it in `server/src/index.ts` with an in-flight guard.
- [x] Run focused tests:

```powershell
corepack pnpm@9.15.4 test:run server/src/__tests__/sweep-steward.test.ts
```

## Task 5: Steward Curation Write Tool

**Files:**
- `server/src/services/internal-agent/tools/hub-curation-tools.ts`
- `server/src/services/internal-agent/tool-registry.ts`
- `server/src/__tests__/hub-curation-tools.test.ts`

- [x] First verify whether an existing hub tool can do the narrow write safely. Existing thread/hub tools cannot safely perform display-only hub curation writes, so W4 adds a narrow `hub.updateCurationSummary` tool.
- [x] If needed, write failing tests for `hub.updateCurationSummary`:
  - requires company scope
  - requires `expectedCurationRevision`
  - rejects lifecycle/source-side actions
  - bounds and redacts text
  - stale revision returns conflict
- [x] Register the tool and include it only in the Steward allowlist.
- [x] Run focused tests:

```powershell
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-curation-tools.test.ts
```

## Task 6: Hub UI Explanation Surface

**Files:**
- `ui/src/api/hub-items.ts`
- `ui/src/components/hub/hubTypes.ts`
- `ui/src/components/hub/HubList.tsx`
- `ui/src/components/hub/HubViewer.tsx`
- `ui/src/components/hub/HubHome.tsx`
- `ui/src/components/hub/__tests__/HubShell.test.tsx`
- `ui/src/components/hub/__tests__/HubList.test.tsx`
- `ui/src/__tests__/InboxHub.test.tsx`

- [x] Write failing UI tests that curated group labels/summaries render in the list without breaking actions.
- [x] Write failing UI tests that the viewer shows "Why you are seeing this" only when metadata exists.
- [x] Write failing UI tests that Home "needs you most" uses curation reason when available.
- [x] Implement UI/API type handling.
- [x] Run focused UI tests:

```powershell
corepack pnpm@9.15.4 test:run ui/src/components/hub/__tests__/HubShell.test.tsx ui/src/__tests__/InboxHub.test.tsx ui/src/components/hub/__tests__/hubRegistry.test.tsx
```

## Task 7: Final E2E and Verification

**Files:**
- `tests/e2e/inbox-hub-steward-curation.spec.ts`
- `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md`

- [x] Add Playwright coverage for the operator flow:
  - open Inbox Hub
  - see curated grouped/priority item
  - open viewer and read explanation
  - perform a normal lifecycle action
  - confirm no W5 runtime prompt UI is implied
  - confirm no Mail/draft UI or action surface is implied
  - verify mobile viewport explanation does not overflow
- [x] Update the integration roadmap status after implementation.
- [x] Run focused e2e:

```powershell
corepack pnpm@9.15.4 test:e2e -- tests/e2e/inbox-hub-steward-curation.spec.ts
```

Local Windows note: the plan command forwards a literal `--` through pnpm and
Playwright reports "No tests found"; rerunning as
`corepack pnpm@9.15.4 test:e2e tests/e2e/inbox-hub-steward-curation.spec.ts`
still reports "No tests found" because `tests/e2e/playwright.config.ts` limits
Windows-without-`DATABASE_URL` runs to the embedded-Postgres skip sentinel.
Linux CI remains the required browser gate for the real W4 spec.

- [ ] Run full handoff verification:

```powershell
corepack pnpm@9.15.4 -r typecheck
corepack pnpm@9.15.4 test:run
corepack pnpm@9.15.4 build
```

## PR Readiness Gate

Before opening or marking the PR ready:

- [ ] Plan has been reviewed against `CLAUDE.md`, `docs/architecture/decisions.md`, and the master scope.
- [ ] No W5 runtime decision bridge code is present.
- [ ] No Mail/drafting code or UI is present.
- [ ] No new dependency is added unless manifest and lockfile policy is followed.
- [ ] Every new mutation is company-scoped; any mutation that affects hub lifecycle, assignment, priority, SLA, ownership, or escalation is audited and explicitly in scope.
- [ ] Steward tool allowlist is default-deny and narrow.
- [ ] Focused unit/integration/e2e tests pass.
- [ ] Full verification commands pass or failures are documented with exact cause.
