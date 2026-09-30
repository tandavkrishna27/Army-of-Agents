# Agent Detail Page — PR #230 Follow-ups (Design)

**Date:** 2026-06-25
**Status:** Design — pending user review, then implementation plan (`writing-plans`) → Codex plan review
**Base:** `main` @ `f1dcf7905` (PR [#230](https://github.com/MeteoriteLabs/AoA/pull/230) merged)
**Worktree/branch:** `C:/Users/TK/.aoa/wt/agent-page-followups` · `docs/agent-page-followups-plan`

## Provenance

PR #230 (agent detail page redesign) shipped with four deliberately-deferred follow-ups. Each is independent and ships as its **own PR**. This document is the design for all four; the implementation plan (separate doc) breaks each into steps. Every root cause and every plan-critical assumption below was verified by hand against the merged code (file:line citations are to that tree).

## Scope & non-goals

- **In scope:** the four follow-ups (#1 router guard, #2 env-redaction de-dup, #3 agent-update concurrency, #4 true run count).
- **Out of scope (deferred to a 5th effort):** broad consolidation of the ~9 *other* secret-redaction copies (they have already diverged → behavior-changing → needs its own design + tests). See "Deferred work".
- **No DB schema change** is required by any of the four (#3 reuses the existing `updatedAt` column). Drizzle-only rules still apply if that changes.

## Decisions (locked)

| # | Area | Decision |
|---|------|----------|
| 1 | Router guard | **Option A** — incremental `createBrowserRouter` (catch-all rendering the existing `<Routes>`) + one `useUnsavedChanges` provider backed by `useBlocker`. Gated behind a runtime spike. |
| 2 | Redaction | **Env-only**: extract the byte-identical env key/value patterns to `packages/shared/src/redaction.ts`; server + UI re-import. Zero behavior change. Broad consolidation deferred. |
| 3 | Concurrency | **`updatedAt` token, whole-row, optional/opt-in** → atomic guarded UPDATE → 409. No migration. Opt in Skills + Config first. Lowest priority (hardening). |
| 4 | Run count | **Total-ever**: add `count(*)` `total` to the `/aoa-runs` response; fix hero KPI **and** Overview stat; relabel "Recent runs" → "Total runs". |

**Recommended PR sequence (independent, adjustable):** #4 → #2 → #1 → #3.

---

## Follow-up #4 — True AoA run count

### Root cause (verified)
`/aoa-runs` ([server/src/routes/agents.ts:552-564](server/src/routes/agents.ts)) reads `internal_agent_runs`, caps at `min(limit ?? 50, 200)`, and returns a **bare array** with no total. The hero KPI counts returned rows and shows `"50+"` at the cap ([AoaAgentDetail.tsx:255-264](ui/src/pages/AoaAgentDetail.tsx)); the Overview "Total runs" stat ([:398-401](ui/src/pages/AoaAgentDetail.tsx)) is capped the same way.

### Approach
Mirror the proven same-table precedent at [internal-agent.ts:861-895](server/src/routes/internal-agent.ts) (`count(*)::int` + `{ runs, total, limit, offset }`):
- **Server:** change the response from a bare array to `{ runs, total, limit }`. `total` = `count(*)` over `(companyId, agentId)` — index-backed by `ia_runs_agent_idx`, so cheap. Add `sql`/`count` to the drizzle import (currently `{ and, desc, eq }`). Semantics: **total ever**.
- **UI:** the client `getAoaRuns` ([api/agents.ts:60](ui/src/api/agents.ts)) returns `{ runs, total }`; consumers read `.runs` for lists and `.total` for the count. Relabel hero KPI "Recent runs" → "Total runs" (matches Overview).

### Blast radius (complete — verified by grep)
`getAoaRuns` consumers: client [api/agents.ts:60](ui/src/api/agents.ts), [AoaRunsPanel.tsx:30](ui/src/components/agent-detail/AoaRunsPanel.tsx), hero query [AoaAgentDetail.tsx:191](ui/src/pages/AoaAgentDetail.tsx), Overview query [:365](ui/src/pages/AoaAgentDetail.tsx), and the test mock in `AoaAgentDetail.test.tsx`. Nothing else.

### Error handling / compat
`/aoa-runs` is an internal endpoint consumed only by our own UI → the response-shape change is safe within this PR (all consumers updated atomically). `agentId` is nullable (`set null` on delete) but AoA agents are non-deletable, so the per-agent count is stable.

### Testing
- Server: returns correct `total` beyond the page cap (seed > 50 rows, assert `total` and `runs.length === 50`).
- UI: KPI shows the real number / "Total runs"; the existing `"50+"` assertion is replaced. Overview stat reads `total`.

### PR boundary
Server route + UI consumers + tests. One PR. **(decided)**

---

## Follow-up #2 — Shared redaction module (env-only)

### Root cause (verified)
Env-redaction logic is copy-pasted. The UI copy ([env-redaction.ts:10-31](ui/src/lib/env-redaction.ts)) is **byte-identical** to the server source ([server-utils.ts:97-130](packages/adapter-utils/src/server-utils.ts)) — same key regex, same 9 value patterns, same order. It was copied (not imported) because `server-utils.ts` is Node-only (`node:child_process/fs/os/path`). Other copies have **drifted** (e.g. [server/src/redaction.ts:1-3](server/src/redaction.ts) uses a different key regex that adds `api_key`/`access_token`/`jwt` and an anchored JWT pattern) — the divergence that makes a single source of truth worth it.

> Correction to the investigation: the claim that `redaction.ts` "omits the Slack `xox` pattern" was **wrong** — [redaction.ts:15](server/src/redaction.ts) has it. The real divergence is the key regex + JWT handling. This does not change the design (env-only first), but is recorded for honesty.

### Approach (zero behavior change)
- **New** `packages/shared/src/redaction.ts`: pure data + pure functions — `SENSITIVE_ENV_KEY`, `SENSITIVE_ENV_VALUE_PATTERNS`, `looksLikeSecretValue`, `shouldRedactSecretValue`, `redactEnvForLogs` — **copied verbatim** from `server-utils.ts`. Re-export from `packages/shared/src/index.ts` (the barrel).
- **`packages/adapter-utils/src/server-utils.ts`:** delete the inline constants/functions; `export { redactEnvForLogs, looksLikeSecretValue } from "@armyofagents/shared"`. Add `@armyofagents/shared` to adapter-utils `dependencies`.
- **`ui/src/lib/env-redaction.ts`:** import the patterns/`shouldRedactSecretValue` from `@armyofagents/shared`; keep the UI-only `redactEnvValue` (the `secret_ref` superset) and `formatEnvForDisplay` as thin wrappers.

### Why this is safe (verified)
- `packages/shared/src` imports **nothing** from `adapter-utils` → **no dependency cycle** when adapter-utils depends on shared.
- All UI imports of shared use the **root barrel** (`from "@armyofagents/shared"`) — so re-export from `index.ts` (not the unproven `./*` subpath) is the resolution-safe choice. (Redaction is tiny; bundle impact negligible.)
- `packages/shared` is browser-safe (only runtime dep is `zod`).
- The byte-identical mirror means existing tests are a **behavior oracle**: `packages/adapter-utils/src/__tests__/redact-env-for-logs.test.ts` and `ui/src/lib/__tests__/env-redaction.test.ts` must pass **unchanged**.

### Risks / de-risking
adapter-utils gaining a `shared` dep changes build topo order → run a full workspace `pnpm build` + both test suites to confirm. Add a focused test in `packages/shared` for the patterns.

### PR boundary
shared + adapter-utils + ui + tests. One PR. Zero behavior change.

---

## Follow-up #1 — Global unsaved-changes guard

### Root cause (verified)
App mounts plain `<BrowserRouter>` ([main.tsx:53](ui/src/main.tsx)); the agent-page guard ([AgentDetail.tsx:404-432](ui/src/pages/AgentDetail.tsx)) covers only in-page tab nav + hero KPIs + refresh. The comment at [:421](ui/src/pages/AgentDetail.tsx) states the gap: *"Cross-page sidebar/`<Link>` nav isn't guarded — that needs a data router + useBlocker."* Grep of all `ui/src` for `useBlocker|createBrowserRouter|RouterProvider` → **zero matches**. The app uses **no** data-router features (no loaders/actions/`errorElement`/`ScrollRestoration`), so the migration is low-risk.

### Approach (Option A — gated by a spike)
1. **Spike (throwaway, do FIRST):** convert `main.tsx` to `createBrowserRouter([{ path: "*", element: <App /> }])` + `RouterProvider`, add a temporary `useBlocker` somewhere with dirty state, and **verify in the running app via `/browse`** that BOTH a sidebar `<Link>` click and the **browser Back button** trigger the blocker. This is the one runtime behavior that can't be proven by reading. If it doesn't fire on descendant-`<Routes>` navigations, stop and reassess before building the real guard.
2. **Migrate the router:** `main.tsx` `<BrowserRouter>` → catch-all data router. The entire `<Routes>` tree in `App.tsx` rides along **untouched** (officially-supported nesting bridge).
3. **Guard primitive:** a `useUnsavedChanges(isDirty: boolean)` hook backed by **one** `useBlocker` in an `UnsavedChangesProvider` (mounted inside the router, outside `<Routes>`), with a centralized "Discard unsaved changes?" `ConfirmDialog`.
4. **Rewire** `AgentDetail`/`AoaAgentDetail` to the global guard; the bespoke `pendingNav`/`handleViewChange`/`onHeroNavigate` plumbing can be deleted (cleanup in the same PR, or a fast-follow). **Keep `useBeforeUnload`** — `useBlocker` does not cover tab-close.

### Other beneficiaries (future opt-in, trivial once the hook exists)
VisionMission, Memory `MarkdownEditorView`, RoutineDetail, ManifestEditor, etc. — out of scope for this PR but the provider makes them one-line opt-ins later.

### Risks / de-risking
- Provider/context ordering — guard provider must render inside `RouterProvider`. Verified the existing provider stack already nests everything under the router.
- Tests: existing `MemoryRouter` tests stay valid for non-blocking cases; new blocking tests use `createMemoryRouter`/`RouterProvider`.
- Parity tests: dirty + sidebar nav → dialog; dirty + Back → dialog; clean nav → no dialog; existing agent tab/hero guard still fires.

### PR boundary
Router migration + provider/hook + agent-detail rewire + tests. One PR. (Fanning out to other editors = optional later PRs.)

---

## Follow-up #3 — Optimistic concurrency for agent updates

### Root cause (verified)
The write is pure last-write-wins: [agents.ts:343-348](server/src/services/agents.ts) — `update(agents).set({...}).where(eq(agents.id, id))`, guarded by id only. Schema [agents.ts:46-47](packages/db/src/schema/agents.ts): has `updatedAt` (stamped on every write), **no version column**. Two simultaneous editors of the same agent (two tabs / two users) silently clobber. **Caveat: low live-severity today** — no MCP/automated path writes agents, so it needs two concurrent human editors. Hardening, not a live fire.

### Approach (best practice for human-edited config)
- **Token = `updatedAt`** (reuse; no migration). The `version`-column variant only matters for sub-millisecond machine races, which don't occur here.
- **Optional/opt-in:** add `expectedUpdatedAt` (ISO string, `.optional()`) to the update agent zod schema (shared validators). When absent → current last-write-wins (no caller breaks). When present → enforced.
- **Atomic guard (race-free):** thread `expectedUpdatedAt` into `svc.update`; the guarded write becomes `where(and(eq(agents.id, id), eq(agents.updatedAt, new Date(expectedUpdatedAt))))`. Zero rows returned **while the row still exists** → throw a conflict the route maps to **409** (body includes the current `updatedAt` so the client can refetch). A pre-read compare is rejected — it's TOCTOU; the guard lives in the WHERE.
- **Scope = whole-row:** the token guards the entire `agents` row (Skills vs Config conflicts too). False-positive 409s on non-overlapping fields are acceptable (a refetch resolves them); field-level reconciliation via `agent_config_revisions.changedKeys` is a possible v2, not now.
- **UI opt-in (first wave):** `AgentSkillsTab`, `AoaAgentDetail` skills toggle, `AgentConfigForm`. Each captures `agent.updatedAt` from the query cache, sends it, and on 409 → invalidate + refetch + toast ("changed elsewhere — reloaded, please redo") + let the user retry. The Skills tab already has rollback-on-failure scaffolding — the 409 branch slots into the existing `catch`.
- **Governance:** record a new **locked decision** in `docs/architecture/decisions.md` (this area is currently unlegislated; aligns with Decision #45 "surface conflicts, no auto-merge").

### `updatedAt` round-trip (verified sound)
Stored value originates from JS `new Date()` (ms precision) → serialized to ISO with ms → client sends it back → parsed to the same instant → Postgres `timestamptz` equality holds.

### Testing
- Server: no token → succeeds (back-compat); matching token → succeeds; stale token (row changed) → 409; token for a missing row → 404 not 409.
- UI: a 409 triggers refetch and does **not** clobber the other client's change; existing `AgentSkillsTab` payload tests still pass when no token is sent (back-compat) and updated for the token path.

### PR boundary
shared validator + server service/route + UI opt-in + `decisions.md` + tests. One PR. Lowest priority.

---

## Deferred work (not in these four PRs)

**Broad redaction consolidation (5th effort).** Unify the remaining ~9 secret-redaction copies — `server/src/redaction.ts`, `services/feedback-redaction.ts`, `services/prompt-snapshot.ts`, `services/health/redaction.ts`, `services/secrets.ts`, `services/company-portability.ts`, `middleware/redact-sensitive.ts`, `scripts/migrate-inline-env-secrets.ts`. These have **already diverged** (different key regexes, different value sets, some with email/phone PII rules, one needing `node:crypto`), so merging is **behavior-changing** and needs its own design + careful tests. Tracked as a separate initiative; not bundled with the safe env-only merge.

## Cross-cutting

- Each follow-up is an **independent PR**, independently green on the required `ci-required` gate.
- TDD per project rules (regression test proves the bug before the fix). Follow existing service/route/schema patterns. No OSS headers (AoA is not open source). Commit/PR trailers per repo convention.
- Suggested order #4 → #2 → #1 → #3, but any order works since they don't intersect.

## Open decisions for the user

1. **Sequence / batching:** four separate PRs in the suggested order — OK, or reprioritize / batch any?
2. **#1 cleanup scope:** delete the bespoke agent-page guard plumbing in the same PR as the migration, or as a fast-follow?
3. **#3 timing:** include it now, or hold it (lowest severity) until a multi-editor/MCP-write path actually exists?
