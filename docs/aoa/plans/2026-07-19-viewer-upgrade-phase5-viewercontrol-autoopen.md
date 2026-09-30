# Viewer Upgrade — Phase 5: viewerControl Setting + Governed Auto-Open — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the founder/user govern whether an agent's fresh output auto-opens in the Commander viewer, via a `viewerControl` setting (`manual` / `own_output` (default) / `full`), and fix the "auto-open every created ref → 20-tab storm" with **one-tab-per-turn** arbitration (non-opened refs remain as chips).

**Architecture:** Auto-open is 100% client-side (`shouldAutoOpen(ref,isMobile) = action==="created" && !isMobile`). This phase adds governance: a company default (`internal_agent_config.viewerControlLevel`) + a per-user override (`viewer_preferences` table), resolved server-side into an **effective level** the client fetches. `shouldAutoOpen` gains a `level` arg (`manual`→never). Focus arbitration: at most one ref auto-opens a tab per assistant turn; the rest are chips (already rendered via `OutputRefChips` from `msg.outputRefs`, so no access is lost). **No emission/contract change** — for Commander, "own output" ≡ `action:"created"`, so no provenance is needed.

**Tech Stack:** Drizzle (`pnpm db:generate`; migrations under `packages/db/src/migrations` — NEVER hand-write SQL, but DO hand-add `IF NOT EXISTS` per repo convention), Express, React, Vitest, Zod. Repo migrations at meta 0173.

**Design source:** [Build-1 §3.9](./2026-07-18-viewer-upgrade-build1-design.md).

**Deferred (intentional):** the company **guardrail clamp** (`companies.viewerControlMax` + its write path/auth) → later; v2 emission + provenance + `mergeOutputRefs` precedence + asset/output/memory_item tab bodies + `/assets/:id/meta` → Tier-3 (Phase 8); per-surface (discussion/project) tiers → later (only Commander auto-opens). The per-user override already gives each user control of their own screen, so the guardrail isn't needed for this slice.

---

## Task 1: Schema + shared type + validators (company default + per-user table)

**Files:** Create `packages/shared/src/viewer-control.ts` (+test), `packages/db/src/schema/viewer_preferences.ts`; Modify `packages/db/src/schema/internal_agent.ts`, `packages/db/src/schema/index.ts`, `packages/shared/src/validators/internal-agent.ts`, `packages/shared/src/index.ts`, **`server/src/routes/internal-agent.ts` (route-local PATCH schema ~L62)**, **`ui/src/api/internal-agent.ts` (the `AgentConfig` interface ~L36)**.

- [ ] **Step 1: Shared type** — `packages/shared/src/viewer-control.ts`:
```ts
export const VIEWER_CONTROL_LEVELS = ["manual", "own_output", "full"] as const;
export type ViewerControlLevel = (typeof VIEWER_CONTROL_LEVELS)[number];
export const DEFAULT_VIEWER_CONTROL_LEVEL: ViewerControlLevel = "own_output";
export function isViewerControlLevel(v: unknown): v is ViewerControlLevel {
  return typeof v === "string" && (VIEWER_CONTROL_LEVELS as readonly string[]).includes(v);
}
```
Export from `packages/shared/src/index.ts`. Add `viewer-control.test.ts` (isViewerControlLevel true/false cases; the 3-level tuple). (No `clamp` — the guardrail is deferred.)

- [ ] **Step 2: Company-default column** — `internal_agent.ts` (~L123, next to `inboundRoutingLevel`): `viewerControlLevel: text("viewer_control_level").notNull().default("own_output")`.

- [ ] **Step 3: Per-user table** — `packages/db/src/schema/viewer_preferences.ts`, cloning `sidebar_preferences.ts` **including its `userId` and `companyId` indexes AND the composite unique index** (not just the unique one): `(userId text→authUsers.id, companyId uuid→companies.id)`, nullable `viewerControlLevel: text("viewer_control_level")` (null = inherit), timestamps. Register in `packages/db/src/schema/index.ts`.

- [ ] **Step 4: Validators (THREE places, not one)**:
  - Shared: `validators/internal-agent.ts` `updateInternalAgentConfigSchema` — add `viewerControlLevel: z.enum(["manual","own_output","full"]).optional()`.
  - **Route-local:** `server/src/routes/internal-agent.ts:~62` — the PATCH handler validates against its OWN schema (GET/PATCH use `.select()`/`.returning()` so columns flow automatically, but the input schema is route-local). Add the field there too, or the PATCH silently strips it.
  - **UI type:** `ui/src/api/internal-agent.ts:~36` `AgentConfig` interface — add `viewerControlLevel: "manual"|"own_output"|"full"`.

- [ ] **Step 5: Generate migration** — `pnpm db:generate`. Output lands in **`packages/db/src/migrations`** as `0174_*.sql` + `meta/0174_snapshot.json` + updated `meta/_journal.json`. **Hand-add `IF NOT EXISTS`** to the generated `CREATE TABLE`/`CREATE INDEX` for `viewer_preferences` (repo convention — enforced by `packages/db/src/__tests__/migration-idempotency.test.ts`). The `ALTER TABLE ... ADD COLUMN` for `internal_agent_config` should likewise be idempotent per that test's rules.

- [ ] **Step 6: Verify + commit** — `pnpm --filter @armyofagents/db typecheck`, `pnpm --filter @armyofagents/shared typecheck`, `pnpm test:run packages/shared/src/viewer-control.test.ts packages/db/src/__tests__/migration-idempotency.test.ts` → PASS.
```bash
git add packages/shared/src/viewer-control.ts packages/shared/src/viewer-control.test.ts packages/shared/src/index.ts packages/shared/src/validators/internal-agent.ts packages/db/src/schema/viewer_preferences.ts packages/db/src/schema/internal_agent.ts packages/db/src/schema/index.ts packages/db/src/migrations server/src/routes/internal-agent.ts ui/src/api/internal-agent.ts
git commit -m "feat(viewer): viewerControl schema (company default + per-user table) + shared type + validators"
```

---

## Task 2: `resolveViewerControl` resolver service (absent-row + corrupted-value safe)

**Files:** Create `server/src/services/viewer-control.ts` (+test).

Resolution: company default (`internal_agent_config.viewerControlLevel`, **row may be absent** — seeded non-fatally at `companies.ts:111`) → per-user override (`viewer_preferences.viewerControlLevel`, absent/null = skip). Validate every stored text via `isViewerControlLevel`; anything absent/corrupt → `DEFAULT_VIEWER_CONTROL_LEVEL`. Pure fn + async DB wrapper (mirror `agent-completion-policy.ts:41-81` / `:83-137` split).

- [ ] **Step 1: Failing test** — pure resolver:
```ts
import { describe, it, expect } from "vitest";
import { resolveViewerControlLevel } from "../viewer-control.js";
describe("resolveViewerControlLevel", () => {
  it("company default when no user override", () => {
    expect(resolveViewerControlLevel({ companyLevel: "own_output", userLevel: null })).toMatchObject({ level: "own_output", source: "company" });
  });
  it("per-user override wins", () => {
    expect(resolveViewerControlLevel({ companyLevel: "own_output", userLevel: "manual" })).toMatchObject({ level: "manual", source: "user" });
  });
  it("absent company config falls back to own_output", () => {
    expect(resolveViewerControlLevel({ companyLevel: null, userLevel: null })).toMatchObject({ level: "own_output", source: "company" });
  });
  it("corrupted stored value falls back to own_output", () => {
    expect(resolveViewerControlLevel({ companyLevel: "garbage", userLevel: null })).toMatchObject({ level: "own_output" });
    expect(resolveViewerControlLevel({ companyLevel: "own_output", userLevel: "nonsense" })).toMatchObject({ level: "own_output", source: "company" });
  });
});
```

- [ ] **Step 2: Implement** `resolveViewerControlLevel({companyLevel, userLevel})` (pure — validates via `isViewerControlLevel`, user wins if valid, else company if valid, else default; returns `{level, source}`) + `resolveViewerControl(db, companyId, userId)` (async — reads the internal_agent_config row (may be absent) + the viewer_preferences row (may be absent), passes to the pure fn). Run test → PASS.

- [ ] **Step 3: Commit**
```bash
git add server/src/services/viewer-control.ts server/src/services/__tests__/viewer-control.test.ts
git commit -m "feat(viewer): resolveViewerControl service (absent-row + corrupted-value safe)"
```

---

## Task 3: `viewer_preferences` API (/me raw + resolved) + client hook

**Files:** Create `server/src/services/viewer-preferences.ts`, `server/src/routes/viewer-preferences.ts`, `ui/src/api/viewer-preferences.ts`, `ui/src/hooks/useViewerControl.ts`; Modify `server/src/app.ts`, `server/src/services/index.ts` (barrel, if the route imports via it), `ui/src/lib/queryKeys.ts`; Test `server/src/__tests__/viewer-preferences.test.ts`.

Clone the `sidebar-preferences` trio. **Both GET and PATCH `/companies/:companyId/viewer-preferences/me` return the same shape** `{ viewerControlLevel: string|null, effectiveLevel: ViewerControlLevel }` (PATCH upserts then re-resolves + returns), so the client always has fresh effective level. Prefer one `companies`-scoped read + the user row (or two indexed point reads); return `source` too so Settings can explain inheritance.

- [ ] **Step 1: Service + route** — mirror `sidebar-preferences.ts` (service `.onConflictDoUpdate({target:[userId,companyId]})`; route `GET`/`PATCH .../me` with `requireBoardUserId` + `assertCompanyAccess`). Both handlers call `resolveViewerControl(db, companyId, userId)` for `effectiveLevel`. PATCH body `{ viewerControlLevel: z.enum([...]).nullable() }`. Mount in `app.ts` beside the sidebar-preferences mount; export the service via `services/index.ts` if the route imports through the barrel.
- [ ] **Step 2: Client + hook** — `ui/src/api/viewer-preferences.ts` (`get`/`patch` → `/me`) + `ui/src/hooks/useViewerControl.ts` (React Query returning `{ effectiveLevel, userLevel, setUserLevel }`; add a query key). Model on `sidebar-preferences.ts` + `useSidebarOrder.ts`.
- [ ] **Step 3: Contract test** — `server/src/__tests__/viewer-preferences.test.ts` (repo route/contract pattern): GET returns raw + effective; PATCH upserts + returns re-resolved effective; per-user override changes effective; cross-company denial. Include a fail-safe: absent pref row → effective = company default.
- [ ] **Step 4: typecheck + commit**
```bash
git add server/src/services/viewer-preferences.ts server/src/routes/viewer-preferences.ts server/src/app.ts server/src/services/index.ts server/src/__tests__/viewer-preferences.test.ts ui/src/api/viewer-preferences.ts ui/src/hooks/useViewerControl.ts ui/src/lib/queryKeys.ts
git commit -m "feat(viewer): viewer_preferences API (/me raw+resolved) + useViewerControl hook"
```

---

## Task 4: Gate auto-open on the effective level + one-tab-per-turn arbitration

**Files:** Modify `commanderViewerModel.ts` (`shouldAutoOpen` + new pure `pickAutoOpenRef`), `useCommanderViewer.ts` (`onLiveRef` level arg), `InternalAgentPanel.tsx` (fail-closed ref + arbitration); Test `commanderViewerModel.test.ts`, and **UPDATE `useCommanderViewer.test.tsx`** (its L43 test asserts two live refs both become tabs — that behavior changes).

- [ ] **Step 1: Failing tests** (pure, in `commanderViewerModel.test.ts`):
```ts
import { shouldAutoOpen, pickAutoOpenRef } from "./commanderViewerModel";
const created = (id: string) => ({ v: 1, kind: "artifact", id, action: "created" } as any);
describe("shouldAutoOpen level gate", () => {
  it("manual never; own_output/full open created on desktop; mobile never; referenced never", () => {
    expect(shouldAutoOpen(created("a"), false, "manual")).toBe(false);
    expect(shouldAutoOpen(created("a"), false, "own_output")).toBe(true);
    expect(shouldAutoOpen(created("a"), false, "full")).toBe(true);
    expect(shouldAutoOpen(created("a"), true, "own_output")).toBe(false);
    expect(shouldAutoOpen({ ...created("a"), action: "referenced" }, false, "full")).toBe(false);
  });
});
describe("pickAutoOpenRef (one per batch)", () => {
  it("returns the first eligible created ref, or null", () => {
    expect(pickAutoOpenRef([created("a"), created("b")], "own_output", false)?.id).toBe("a");
    expect(pickAutoOpenRef([created("a")], "manual", false)).toBeNull();
    expect(pickAutoOpenRef([created("a")], "own_output", true)).toBeNull(); // mobile
    expect(pickAutoOpenRef([{ ...created("a"), action: "referenced" }], "own_output", false)).toBeNull();
  });
});
```

- [ ] **Step 2: Implement** — `shouldAutoOpen(ref, isMobile, level: ViewerControlLevel = "own_output") = level !== "manual" && ref.action === "created" && !isMobile`. Add pure `pickAutoOpenRef(refs, level, isMobile): ShowRef | null = refs.find(r => shouldAutoOpen(r, isMobile, level)) ?? null`. `onLiveRef(ref, isMobile, level)` passes `level` through.

- [ ] **Step 3: Wire + fail-closed + arbitration in `InternalAgentPanel.tsx`**
  - `const { effectiveLevel } = useViewerControl(companyId)`. Keep a **`effectiveLevelRef = useRef<ViewerControlLevel>("manual")`** updated in an effect (`effectiveLevelRef.current = effectiveLevel ?? "manual"`). **Default MANUAL while loading/errored (fail-closed).** The SSE handler reads `effectiveLevelRef.current` at event time (the loop is a stale closure — do NOT read the state var directly).
  - A **`autoOpenedTurnRef = useRef(false)`**, reset to `false` when a new user turn starts (in the send path). In the `for (const r of liveRefs)` batch (`~L1403-1412`): if `!autoOpenedTurnRef.current`, `const pick = pickAutoOpenRef(liveRefs, effectiveLevelRef.current, isMobile)`; if `pick`, call `viewer.onLiveRef(pick, isMobile, effectiveLevelRef.current)` (creates+focuses one tab) + the `:1408` choreography for `pick` + set `autoOpenedTurnRef.current = true`. **Do NOT call `onLiveRef` for the other refs** — they remain chips (already merged onto `msg.outputRefs` → `OutputRefChips`). This caps tabs at one per turn and eliminates the silent-add-creates-a-tab storm.
  - (Keep merging ALL refs onto the message via the existing `mergeRefs` — chips still show everything; only tab creation is arbitrated.)

- [ ] **Step 4: Update the existing hook test** — `useCommanderViewer.test.tsx:~43` currently asserts two desktop live refs BOTH become tabs + second steals focus. Update it to the new contract (onLiveRef opens the ref passed to it; arbitration lives in the panel now). Add a panel-level or pure `pickAutoOpenRef` assertion for "two created refs → one tab" (the pure fn test in Step 1 covers the selection; if feasible add an InternalAgentPanel integration test that two refs yield one open tab, else rely on the pure fn + the updated hook test).

- [ ] **Step 5: typecheck + tests + commit**
```bash
git add ui/src/components/commander/viewer/commanderViewerModel.ts ui/src/components/commander/viewer/useCommanderViewer.ts ui/src/components/InternalAgentPanel.tsx ui/src/components/commander/viewer/commanderViewerModel.test.ts ui/src/components/commander/viewer/useCommanderViewer.test.tsx
git commit -m "feat(commander): gate auto-open on viewerControl (fail-closed) + one-tab-per-turn arbitration"
```

---

## Task 5: Settings UI (company default + per-user override, both cache-correct)

**Files:** Modify `ui/src/components/settings/sections/CommanderSection.tsx`.

- [ ] **Step 1: Company `viewerControlLevel` Select** — Execution tab after the Autonomy block (~L940), following `runtimeApprovalsEnabled` wiring (state ~L229, hydrate ~L383, prop-thread ~L528/809/832, save ~L412). On save, **invalidate BOTH `agentConfig` AND the `viewerPreferences` query key** (~L400 currently only invalidates `agentConfig`; the effective level is stale otherwise).
- [ ] **Step 2: Per-user override Select** — a second control via `useViewerControl(companyId)`: options Inherit / Manual / Own output / Full → PATCH `/me` (which returns the re-resolved effective). Show the resolved `effectiveLevel` + `source` as helper text ("Effective: manual (your override)").
- [ ] **Step 3: typecheck + commit**
```bash
git add ui/src/components/settings/sections/CommanderSection.tsx
git commit -m "feat(settings): viewerControl company default + per-user override (invalidates both caches)"
```

---

## Task 6: Completion gate

- [ ] **Step 1:** `pnpm -r typecheck` → PASS.
- [ ] **Step 2:** `pnpm test:run packages/shared/src/viewer-control.test.ts packages/db/src/__tests__/migration-idempotency.test.ts server/src/services/__tests__/viewer-control.test.ts server/src/__tests__/viewer-preferences.test.ts ui/src/components/commander/viewer/commanderViewerModel.test.ts ui/src/components/commander/viewer/useCommanderViewer.test.tsx` → PASS.
- [ ] **Step 3:** `pnpm build` → PASS.
- [ ] **Step 4: No emission/contract change** — `git grep -n "buildOutputRefs\|showRefV2Schema\|output-refs.ts" -- server ui | grep -v test` shows nothing added by this phase (governance only).
- [ ] **Step 5: Migration sanity** — the generated migration adds only the column + table with `IF NOT EXISTS`; `migration-idempotency.test.ts` passes.

---

## Self-Review

**Codex P1s fixed:** (1) route-local PATCH schema + UI AgentConfig updated (not just shared). (2) company guardrail **dropped** (no dead write path). (3) resolver handles absent config row + corrupted values, explicit tests. (4) fail-closed to `manual` while loading + `effectiveLevelRef` read at event time (not the stale closure). (5) arbitration = one tab per TURN, non-winners are chips (not silent-added tabs); pure `pickAutoOpenRef` for testability. (6) update the existing `useCommanderViewer.test.tsx` all-tabs assertion. (7) PATCH `/me` returns raw+effective; both `agentConfig` + `viewerPreferences` caches invalidated on save. (8) migration path `packages/db/src/migrations` + hand-added `IF NOT EXISTS` + the idempotency test in the gate.

**Spec coverage (Build-1 §3.9, minus the deferred guardrail):** company default + per-user override + server resolver + effective-level delivery + gated auto-open + one-tab arbitration + settings UI. ✅

**Deferred:** guardrail clamp + v2 emission/provenance + carry-forwards → later phases.

**Risk:** Task 4 (SSE loop + arbitration) is the delicate one — the fail-closed `effectiveLevelRef` and the per-turn flag reset must be correct; the pure `pickAutoOpenRef` + updated hook test cover the logic. Task 1's migration must be `pnpm db:generate`d then hand-made idempotent.

---

## Execution Handoff

**Subagent-driven**, spec + code-quality review per task. Schema + server + UI; `pnpm -r typecheck` + the suites (incl. `migration-idempotency`) gate it; no running app required.
