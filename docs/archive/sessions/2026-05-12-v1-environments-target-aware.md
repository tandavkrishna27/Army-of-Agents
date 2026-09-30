# feat/v1-environments-target-aware Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bridge D2 execution targets and D3 environments so a company environment can select `local` or `sandbox-docker`, and heartbeat runs use that target when an issue/default environment resolves to one.

**Architecture:** Add a nullable JSONB `environments.target` field that stores the same adapter execution target contract introduced by D2. Keep `connectionTarget` as descriptive infrastructure metadata. The heartbeat resolves the normal environment chain (`issue.executionEnvironmentId` > `agent.defaultEnvironmentId` > none), injects env vars as before, and overlays `executionTarget` from the resolved environment when present.

**Tech Stack:** Drizzle ORM | TypeScript | Express services/routes | Vitest | React + TanStack Query | existing Settings Environments tab

**Integration branch:** `v1-upgrade` via feature branch `feat/v1-environments-target-aware`.

**Migration slot:** Master plan reserves `0096_*` for this feature. Current verified `origin/v1-upgrade` (`5f18e329`, 2026-05-13) contains migrations through `0093_*`; if `0094/0095` are still absent when generating, Drizzle will create the next sequential migration. Do not hand-write SQL or fabricate empty migration gaps.

---

## Source Context

- `docs/archive/sessions/2026-05-11-v1-upgrade-master.md`: Phase E #10, target-aware environments bridge D2 + D3.
- `docs/archive/sessions/2026-05-12-v1-environments-lite.md`: D3 created company-scoped environments with `envVars` and `connectionTarget`; heartbeat already injects environment env vars.
- `docs/archive/sessions/2026-05-12-v1-execution-target.md`: D2 introduced `AdapterExecutionTarget` with `local` and `sandbox-docker`, plus `resolveAdapterExecutionTarget`.
- `memory/project_v1_to_v2_roadmap.md`: requested but missing in this checkout; plan follows the master/session docs and live code.

## File Map

| Action | Path | Responsibility |
|---|---|---|
| Modify | `packages/db/src/schema/environments.ts` | Add nullable JSONB `target` column |
| Generate | `packages/db/src/migrations/<next>_*.sql` | Drizzle-generated target column migration |
| Modify | `packages/shared/src/types/environment.ts` | Expose `target` on `Environment` |
| Modify | `packages/shared/src/validators/environment.ts` | Validate create/update target payload |
| Modify | `server/src/services/environment-resolver.ts` | Resolve environment env vars plus target in one company-scoped query |
| Modify | `server/src/services/heartbeat.ts` | Overlay env target into runtime adapter config before D2 target resolution |
| Modify | `server/src/services/environments.ts` | Persist target through CRUD service |
| Modify | `server/src/__tests__/heartbeat-env-injection.test.ts` | Cover target resolution and merge priority |
| Modify | `server/src/__tests__/environments-service.test.ts` | Cover service target create/update |
| Modify | `server/src/__tests__/environments-routes.test.ts` | Cover route target payloads |
| Modify | `ui/src/components/settings/sections/EnvironmentsSection.tsx` | Add target picker to management dialog and list summary |
| Modify | `ui/src/__tests__/EnvironmentsSection.test.tsx` | Cover target picker render and create payload |

---

## Task 1: Schema And Shared Contract

**Files:**
- Modify: `packages/db/src/schema/environments.ts`
- Modify: `packages/shared/src/types/environment.ts`
- Modify: `packages/shared/src/validators/environment.ts`
- Generate: `packages/db/src/migrations/<next>_*.sql`

- [ ] Add `target: jsonb("target").$type<Record<string, unknown>>()` to the `environments` table after `connectionTarget`.
- [ ] Add `target: Record<string, unknown> | null;` to the shared `Environment` type.
- [ ] Add `target: z.record(z.unknown()).optional().nullable()` to create and update environment schemas.
- [ ] Run `pnpm db:generate`; verify the generated migration only adds `environments.target`.
- [ ] Run `pnpm --filter @armyofagents/db typecheck` and `pnpm --filter @armyofagents/shared typecheck`.

## Task 2: Server Resolution And Heartbeat Overlay

**Files:**
- Modify: `server/src/services/environment-resolver.ts`
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/services/environments.ts`
- Modify: `server/src/__tests__/heartbeat-env-injection.test.ts`
- Modify: `server/src/__tests__/environments-service.test.ts`
- Modify: `server/src/__tests__/environments-routes.test.ts`

- [ ] Replace the env-var-only resolver internals with a `resolveEnvironmentRuntimeConfig(db, opts)` helper that returns `{ envVars, target, environmentId }`.
- [ ] Keep `resolveEnvironmentEnvVars(...)` as a compatibility wrapper returning only `envVars`.
- [ ] In heartbeat, use the runtime resolver once and merge `environmentRuntime.target` into `mergedConfig.executionTarget` when present.
- [ ] Preserve adapter config target when no environment target exists.
- [ ] Add tests proving issue environment target overrides adapter config, default environment target works, and no target preserves current behavior.
- [ ] Run `pnpm --filter server test:run -- heartbeat-env-injection.test.ts environments-service.test.ts environments-routes.test.ts`.

## Task 3: Settings UI Target Picker

**Files:**
- Modify: `ui/src/components/settings/sections/EnvironmentsSection.tsx`
- Modify: `ui/src/__tests__/EnvironmentsSection.test.tsx`

- [ ] Add a compact target select in the create/edit dialog with options `Local` and `Sandbox Docker`.
- [ ] When `Sandbox Docker` is selected, show fields for image, workdir, shell, network, remove container, and optional install command.
- [ ] Serialize local as `{ type: "local" }`; serialize Docker as `{ type: "sandbox-docker", image, workdir, shell, network, remove, installCommand }`.
- [ ] Show a terse list-row summary: `local target` or `sandbox-docker: <image>`.
- [ ] Add UI tests for opening the picker and creating an environment with a Docker target.
- [ ] Run `pnpm --filter ui test:run -- EnvironmentsSection.test.tsx`.

## Task 4: Documentation, Review, Verification

**Files:**
- Modify: `docs/archive/sessions/2026-05-12-v1-environments-target-aware.md`

- [ ] Self-review the implementation against this plan.
- [ ] Dispatch code-reviewer subagent with base/head SHAs and this plan.
- [ ] Fix Critical/Important findings.
- [ ] Run targeted checks:

```bash
pnpm --filter @armyofagents/db typecheck
pnpm --filter @armyofagents/shared typecheck
pnpm --filter server test:run -- heartbeat-env-injection.test.ts environments-service.test.ts environments-routes.test.ts
pnpm --filter ui test:run -- EnvironmentsSection.test.tsx
```

- [ ] Run full handoff checks when time allows:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

## Task 5: PR And Merge

**Files:** none

- [ ] Commit the feature branch.
- [ ] Push `feat/v1-environments-target-aware`.
- [ ] Open PR to `v1-upgrade` titled `feat(D2+D3): make environments target-aware`.
- [ ] Address review/CI.
- [ ] Merge PR into `v1-upgrade` if checks and permissions allow.

---

## Self-Review

**Spec coverage:** The plan covers schema target storage, heartbeat target resolution from selected/default environments, UI target selection, explicit local override, and sandbox-docker per-environment selection.

**Placeholder scan:** No task uses TBD/TODO placeholders. Migration numbering is intentionally conditional on the verified current branch state and must be produced by Drizzle.

**Type consistency:** The persisted shape is `environments.target`; runtime type names remain D2's `local` and `sandbox-docker`; heartbeat uses the same `executionTarget` config key already consumed by `resolveAdapterExecutionContext`.
