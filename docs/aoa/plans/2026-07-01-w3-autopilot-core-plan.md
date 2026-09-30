# W3 Autopilot Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the W3 Autopilot core: trust-gated hub auto-handle vs escalate policy, server-side autonomous hub actions, auto-action audit, undo, and a small operator control surface.

**Architecture:** W3 extends the existing hub control plane rather than adding a second automation system. Autopilot policy is company-scoped, category-aware, and evaluated server-side; accepted auto-actions go through the same optimistic-concurrency hub lifecycle path as human actions and write `hub_audit.actorType = "autonomy"` before effects. The company policy row is the explicit delegated-authority grant for deterministic W3 auto-handling; Autopilot never acts as `"system"`. W3 does not implement W4 Steward intelligence or W5 adapter bridges; it only creates the deterministic policy/audit foundation they will call later.

**Tech Stack:** Drizzle/Postgres schema + generated migrations, Express 5 routes/services, shared Zod contracts, React/Vite/TanStack Query hub UI, Vitest unit/integration tests, Playwright e2e.

**Execution status:** Implemented on `codex/w3-autopilot-planning` through Task 7. Task 8 added focused Playwright acceptance coverage and roadmap updates; final local verification is tracked below before PR handoff.

---

## Scope Boundary

W3 is the autonomy layer described by the master scope:

- Trust-gated auto-handle vs escalate per hub category.
- Autopilot control in Hub Home/settings.
- Auto-action audit and undo.
- Gradual onboarding through trust score and explicit operator policy.

W3 explicitly excludes:

- W4 Steward agent, LLM reasoning, grouping intelligence, drafting, or explanations beyond deterministic policy reasons.
- W5 runtime adapter bridges and CLI permission relay.
- Email/Mail lane work.
- New source-specific approve/reject side effects for approvals, marketplace installs, runtime prompts, or task workflows. This first PR only auto-handles hub lifecycle actions that are already safe in the hub action layer: `resolve` and `archive`.

## Product Decisions

1. **Default is Off.** New companies start with Autopilot disabled. No auto-action runs until a founder/operator explicitly enables a category policy.
2. **Autopilot is company-scoped.** Hub layout preferences remain per-user; autonomy policy is a company control-plane setting.
3. **Founder-gated categories are not auto-handled in W3 Core.** `approval_request`, `join_request`, and reserved `agent_runtime_decision` stay escalation-only until source-specific authority grants exist.
4. **Trust score is a floor, not a recommendation.** A category policy may require minimum trust, but W3 never silently raises the policy.
5. **Audit lands before state change side effects.** Every autonomous action writes a hub audit row with autonomy level, reason, prior state, idempotency key, undo deadline, and policy/evaluation details in reversible `decisionContext` metadata. Do not store W3 policy metadata in `relayResult`; `undoAction` treats `relayResult` as external relay state and blocks undo when it is present.
6. **Escalate means "keep visible and explain why."** W3 Core does not create a separate escalation item unless a future source needs one; it records the deterministic reason on the evaluation result and leaves the item in the hub.
7. **One server-side entry point.** Clients can read/update policy, but cannot request "act as autonomy." Autopilot evaluation is invoked from trusted server paths only.
8. **Reviewable means listable.** Auto-handled items may leave the open hub list immediately, so W3 must expose a recent Autopilot actions read model that the Home card can show and undo from.

## File Structure

### Shared Contracts

- Modify `packages/shared/src/hub.ts`
  - Add `HUB_AUTOPILOT_MODES`, `HUB_AUTOPILOT_ACTIONS`, policy category helpers, and mode/action types.
- Modify `packages/shared/src/validators/hub.ts`
  - Add `hubAutopilotPolicySchema`, `updateHubAutopilotPolicySchema`, evaluation result schema, and response types.
- Modify `packages/shared/src/index.ts`
  - Export the new hub autopilot contracts.
- Modify `packages/shared/src/__tests__/hub-contract.test.ts`
  - Contract coverage for modes, category map, validation, defaults, and rejected unsafe policies.

### Database

- Create `packages/db/src/schema/hub_autopilot_policies.ts`
  - Company-scoped category policy table.
- Modify `packages/db/src/schema/hub_audit.ts`
  - Add reversible `decisionContext` metadata for autonomy evaluation/policy details. This is separate from `relayResult` because relay results can make an action non-undoable.
- Modify `packages/db/src/schema/index.ts`
  - Export `hubAutopilotPolicies`.
- Generate migration with `pnpm db:generate`.

### Server

- Create `server/src/services/hub-autopilot.ts`
  - Default policy, get/upsert/reset, evaluate, and apply-safe-action service.
- Modify `server/src/services/hub-items.ts`
  - Allow `actorType: "autonomy"` in lifecycle/undo/bulk-compatible internal service types.
  - Persist `autonomyLevel` in lifecycle audit rows when supplied.
- Modify `server/src/services/index.ts`
  - Export `hubAutopilotService`.
- Create `server/src/routes/hub-autopilot.ts`
  - `GET /companies/:companyId/hub-autopilot/policy`
  - `GET /companies/:companyId/hub-autopilot/actions`
  - `PATCH /companies/:companyId/hub-autopilot/policy`
  - `POST /companies/:companyId/hub-autopilot/policy/reset`
  - Dev/test-only evaluation endpoint only if needed for e2e seeding; prefer service-level tests.
- Modify `server/src/app.ts`
  - Mount `hubAutopilotRoutes(db)` near hub/notification routes.
- Modify `server/src/routes/hub-items.ts`
  - Invoke Autopilot after list/count emitters hydrate W1/W2 source items, bounded and idempotent.
  - Do not invoke Autopilot from client action routes.

### UI

- Modify `ui/src/api/hub-items.ts`
  - Add `hubItemsApi.autopilotPolicy.get/update/reset` and `hubItemsApi.autopilotActions.list`.
- Modify `ui/src/lib/queryKeys.ts`
  - Add `queryKeys.hubItems.autopilotPolicy(companyId)` and `queryKeys.hubItems.autopilotActions(companyId)`.
- Modify `ui/src/components/hub/HubHome.tsx`
  - Replace the preview Autopilot card with a live status card: Off/Assist/Drive, handled-today count, recent handled actions, undo buttons inside the undo window, and settings button.
- Modify `ui/src/components/hub/HubShell.tsx`
  - Add an Autopilot settings panel inside Hub settings with category controls.
- Modify `ui/src/pages/InboxHub.tsx`
  - Query/mutate Autopilot policy and pass it into `HubShell`/`HubHome`.

### Tests

- Shared: `packages/shared/src/__tests__/hub-contract.test.ts`
- DB: `packages/db/src/__tests__/schema-exports.test.ts` or existing schema export test file if present
- Server unit: `server/src/__tests__/hub-autopilot.test.ts`
- Server route: `server/src/__tests__/hub-autopilot-routes.test.ts`
- Hub route integration: extend `server/src/__tests__/hub-items-routes.test.ts` only for invocation wiring if service mocking is already used there
- UI API: `ui/src/api/__tests__/hub-items-api.test.ts`
- UI component/page: `ui/src/components/hub/__tests__/HubShell.test.tsx`, `ui/src/__tests__/InboxHub.test.tsx`
- E2E: `tests/e2e/inbox-hub-autopilot.spec.ts`

---

## Task 1: Shared Autopilot Contracts

**Files:**
- Modify: `packages/shared/src/hub.ts`
- Modify: `packages/shared/src/validators/hub.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/hub-contract.test.ts`

- [ ] **Step 1: Write failing shared contract tests**

Add tests that lock the public policy shape:

```ts
import {
  HUB_AUTOPILOT_ACTIONS,
  HUB_AUTOPILOT_MODES,
  HUB_SEMANTIC_TYPES,
  hubAutopilotPolicySchema,
  updateHubAutopilotPolicySchema,
} from "../index.js";

describe("hub autopilot contracts", () => {
  it("exposes W3 autopilot modes and actions", () => {
    expect(HUB_AUTOPILOT_MODES).toEqual(["off", "assist", "drive"]);
    expect(HUB_AUTOPILOT_ACTIONS).toEqual(["none", "resolve", "archive"]);
  });

  it("accepts a company policy with category rules", () => {
    const parsed = hubAutopilotPolicySchema.parse({
      mode: "assist",
      handledToday: 0,
      lastHandledAt: null,
      rules: [
        {
          semanticType: "run_complete",
          action: "resolve",
          minTrustScore: 80,
          enabled: true,
        },
      ],
      updatedAt: null,
    });

    expect(parsed.rules[0].semanticType).toBe("run_complete");
  });

  it("rejects auto-handle for founder-gated categories in W3 core", () => {
    expect(() =>
      updateHubAutopilotPolicySchema.parse({
        rules: [
          {
            semanticType: "approval_request",
            action: "resolve",
            minTrustScore: 80,
            enabled: true,
          },
        ],
      }),
    ).toThrow();
  });

  it("has explicit rule coverage for every hub semantic type", () => {
    const covered = new Set(
      hubAutopilotPolicySchema.parse({
        mode: "off",
        handledToday: 0,
        lastHandledAt: null,
        rules: HUB_SEMANTIC_TYPES.map((semanticType) => ({
          semanticType,
          action: "none",
          minTrustScore: 100,
          enabled: false,
        })),
        updatedAt: null,
      }).rules.map((rule) => rule.semanticType),
    );

    expect(covered.size).toBe(HUB_SEMANTIC_TYPES.length);
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
corepack pnpm@9.15.4 --filter @armyofagents/shared test:run packages/shared/src/__tests__/hub-contract.test.ts
```

Expected: FAIL because `HUB_AUTOPILOT_MODES`, `HUB_AUTOPILOT_ACTIONS`, and policy schemas do not exist.

- [ ] **Step 3: Implement shared constants and validators**

In `packages/shared/src/hub.ts` add:

```ts
export const HUB_AUTOPILOT_MODES = ["off", "assist", "drive"] as const;
export type HubAutopilotMode = (typeof HUB_AUTOPILOT_MODES)[number];

export const HUB_AUTOPILOT_ACTIONS = ["none", "resolve", "archive"] as const;
export type HubAutopilotAction = (typeof HUB_AUTOPILOT_ACTIONS)[number];

export const HUB_AUTOPILOT_FOUNDER_GATED_TYPES = [
  "approval_request",
  "join_request",
  "agent_runtime_decision",
] as const satisfies readonly HubSemanticType[];

export function isFounderGatedAutopilotType(type: HubSemanticType): boolean {
  return (HUB_AUTOPILOT_FOUNDER_GATED_TYPES as readonly string[]).includes(type);
}
```

In `packages/shared/src/validators/hub.ts` add imports for `HUB_AUTOPILOT_ACTIONS`, `HUB_AUTOPILOT_MODES`, `HUB_SEMANTIC_TYPES`, and `isFounderGatedAutopilotType`, then add:

```ts
export const hubAutopilotRuleSchema = z
  .object({
    semanticType: z.enum(HUB_SEMANTIC_TYPES),
    action: z.enum(HUB_AUTOPILOT_ACTIONS),
    minTrustScore: z.number().int().min(0).max(100),
    enabled: z.boolean(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.enabled && rule.action !== "none" && isFounderGatedAutopilotType(rule.semanticType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "Founder-gated hub categories cannot be auto-handled in W3 core",
      });
    }
  });

export type HubAutopilotRule = z.infer<typeof hubAutopilotRuleSchema>;

export const hubAutopilotPolicySchema = z
  .object({
    mode: z.enum(HUB_AUTOPILOT_MODES),
    handledToday: z.number().int().nonnegative(),
    lastHandledAt: z.string().datetime().nullable(),
    rules: z.array(hubAutopilotRuleSchema),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((policy, ctx) => {
    const seen = new Set<string>();
    for (const [index, rule] of policy.rules.entries()) {
      if (seen.has(rule.semanticType)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "semanticType"],
          message: "Autopilot policy cannot contain duplicate semantic type rules",
        });
      }
      seen.add(rule.semanticType);
    }
  });

export type HubAutopilotPolicy = z.infer<typeof hubAutopilotPolicySchema>;

export const updateHubAutopilotPolicySchema = z
  .object({
    mode: z.enum(HUB_AUTOPILOT_MODES).optional(),
    rules: z.array(hubAutopilotRuleSchema).optional(),
  })
  .strict()
  .superRefine((patch, ctx) => {
    const seen = new Set<string>();
    for (const [index, rule] of (patch.rules ?? []).entries()) {
      if (seen.has(rule.semanticType)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "semanticType"],
          message: "Autopilot policy cannot contain duplicate semantic type rules",
        });
      }
      seen.add(rule.semanticType);
    }
  });

export type UpdateHubAutopilotPolicyInput = z.infer<typeof updateHubAutopilotPolicySchema>;

export const hubAutopilotEvaluationResultSchema = z
  .object({
    decision: z.enum(["noop", "auto_handle", "escalate"]),
    action: z.enum(HUB_AUTOPILOT_ACTIONS),
    reason: z.string().min(1),
    autonomyLevel: z.enum(HUB_AUTOPILOT_MODES),
  })
  .strict();

export type HubAutopilotEvaluationResult = z.infer<typeof hubAutopilotEvaluationResultSchema>;
```

Export the new validators from `packages/shared/src/index.ts`.

Patch semantics: `updateHubAutopilotPolicySchema` accepts sparse rule arrays, but the server must merge them over defaults/current policy so the effective response always has exactly one rule per `HUB_SEMANTIC_TYPES` entry.

- [ ] **Step 4: Run shared tests**

Run:

```powershell
corepack pnpm@9.15.4 --filter @armyofagents/shared test:run packages/shared/src/__tests__/hub-contract.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/shared/src/hub.ts packages/shared/src/validators/hub.ts packages/shared/src/index.ts packages/shared/src/__tests__/hub-contract.test.ts
git commit -m "feat(shared): add W3 autopilot hub contracts"
```

---

## Task 2: DB Policy Table

**Files:**
- Create: `packages/db/src/schema/hub_autopilot_policies.ts`
- Modify: `packages/db/src/schema/hub_audit.ts`
- Modify: `packages/db/src/schema/index.ts`
- Generated: `packages/db/src/migrations/<generated>.sql`
- Test: use existing db schema export test if present; otherwise add a focused export assertion in the nearest db test file.

- [ ] **Step 1: Write failing schema export test**

Add or extend a db test with:

```ts
import { hubAudit, hubAutopilotPolicies } from "../schema/index.js";

describe("schema exports", () => {
  it("exports W3 hub autopilot policies", () => {
    expect(hubAutopilotPolicies).toBeDefined();
  });

  it("exposes reversible hub audit decision context metadata", () => {
    expect(hubAudit).toHaveProperty("decisionContext");
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```powershell
corepack pnpm@9.15.4 --filter @armyofagents/db test:run
```

Expected: FAIL because `hubAutopilotPolicies` is not exported.

- [ ] **Step 3: Add table**

Create `packages/db/src/schema/hub_autopilot_policies.ts`:

```ts
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { HubAutopilotMode, HubAutopilotRule } from "@armyofagents/shared";
import { companies } from "./companies.js";

export const hubAutopilotPolicies = pgTable(
  "hub_autopilot_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    mode: text("mode").$type<HubAutopilotMode>().notNull().default("off"),
    rules: jsonb("rules").$type<HubAutopilotRule[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("hub_autopilot_policies_company_idx").on(table.companyId),
    companyUq: uniqueIndex("hub_autopilot_policies_company_uq").on(table.companyId),
  }),
);
```

Export it from `packages/db/src/schema/index.ts`.

In `packages/db/src/schema/hub_audit.ts`, add:

```ts
decisionContext: jsonb("decision_context"),
```

This field is for reversible audit metadata such as Autopilot policy/evaluation context. Do not overload `relayResult`; existing undo semantics treat relay results as source-side effects and reject undo when present.

- [ ] **Step 4: Generate migration**

Run:

```powershell
corepack pnpm@9.15.4 db:generate
```

Expected: one generated migration creates `hub_autopilot_policies` with `company_id`, `mode`, `rules`, timestamps, and indexes, and adds nullable `decision_context` to `hub_audit`. `handledToday` and `lastHandledAt` remain derived response fields from `hub_audit`, not stored policy columns.

- [ ] **Step 5: Run db tests and typecheck package**

Run:

```powershell
corepack pnpm@9.15.4 --filter @armyofagents/db test:run
corepack pnpm@9.15.4 --filter @armyofagents/db typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/db/src/schema/hub_autopilot_policies.ts packages/db/src/schema/index.ts packages/db/src/migrations
git commit -m "feat(db): add hub autopilot policy table"
```

---

## Task 3: Autopilot Service

**Files:**
- Create: `server/src/services/hub-autopilot.ts`
- Modify: `server/src/services/hub-items.ts`
- Modify: `server/src/services/index.ts`
- Test: `server/src/__tests__/hub-autopilot.test.ts`

- [ ] **Step 1: Write failing service tests**

Create tests for:

```ts
describe("hubAutopilotService", () => {
  it("returns an off default policy when no row exists", async () => {});
  it("rejects auto-handle for founder-gated categories", async () => {});
  it("evaluates off policy as escalate/noop", async () => {});
  it("evaluates enabled drive policy with enough trust as resolve", async () => {});
  it("evaluates enabled policy with low trust as escalate", async () => {});
  it("records autonomous resolve through the hub lifecycle action path", async () => {});
  it("uses deterministic idempotency keys for autonomous actions", async () => {});
  it("keeps autonomous lifecycle actions undoable when only decisionContext is present", async () => {});
  it("lists recent autonomous actions with item summary and undo metadata", async () => {});
});
```

The action-path test must assert `recordLifecycleAction` receives:

```ts
{
  actorType: "autonomy",
  actorId: "autopilot",
  authorityBasis: "autopilot_policy:run_complete:drive",
  autonomyLevel: "drive",
  action: "resolve",
}
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
corepack pnpm@9.15.4 --filter server test:run server/src/__tests__/hub-autopilot.test.ts
```

Expected: FAIL because the service does not exist and `recordLifecycleAction` does not accept `actorType: "autonomy"` or `autonomyLevel`.

- [ ] **Step 3: Implement service default policy**

`server/src/services/hub-autopilot.ts` should export:

```ts
export const DEFAULT_HUB_AUTOPILOT_POLICY: HubAutopilotPolicy = {
  mode: "off",
  handledToday: 0,
  lastHandledAt: null,
  rules: HUB_SEMANTIC_TYPES.map((semanticType) => ({
    semanticType,
    action: "none",
    minTrustScore: 100,
    enabled: false,
  })),
  updatedAt: null,
};
```

Implement `get(companyId)`, `upsert(companyId, patch)`, and `reset(companyId)` using the same merge/default pattern as `hubPreferencesService`. `upsert` must validate the merged effective policy, reject duplicate semantic rules, and return a policy with exactly one effective rule per `HUB_SEMANTIC_TYPES` entry. `get` and mutation responses must compute `handledToday` and `lastHandledAt` from `hub_audit` rows where `actorType = "autonomy"` and `action in ("resolve", "archive")`; use UTC day boundaries for `handledToday` until a company/user timezone source exists.

Also implement `listRecentActions(companyId, { limit })`, returning recent `hub_audit.actorType = "autonomy"` rows joined to their hub item where present:

```ts
{
  items: Array<{
    auditId: string;
    hubItemId: string | null;
    title: string;
    semanticType: HubSemanticType | null;
    action: "resolve" | "archive";
    autonomyLevel: HubAutopilotMode | null;
    reason: string | null;
    decisionContext: unknown;
    undoDeadline: string | null;
    itemStatus: HubItemStatus | null;
    itemVersion: number | null;
    createdAt: string;
  }>;
}
```

- [ ] **Step 4: Implement evaluation**

Add:

```ts
export interface AutopilotEvaluationInput {
  companyId: string;
  hubItemId: string;
  semanticType: HubSemanticType;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceAgentId?: string | null;
  version: number;
}

export interface AutopilotEvaluationResult {
  decision: "noop" | "auto_handle" | "escalate";
  action: HubAutopilotAction;
  reason: string;
  autonomyLevel: HubAutopilotMode;
}
```

Rules:

- `mode === "off"` returns `noop`.
- No enabled rule returns `noop`.
- `action === "none"` returns `noop`.
- Founder-gated semantic type returns `escalate`.
- Missing trust score returns `escalate`.
- Missing source-agent context returns `escalate`. For W3 Core, only source types that can be mapped to an agent trust score are eligible for auto-handle; W4/W5 may add richer principal resolution later.
- Trust score below `minTrustScore` returns `escalate`.
- `mode === "assist"` returns `escalate` for enabled rules; Assist may explain but not auto-handle.
- `mode === "drive"` and trust passes returns `auto_handle`.

- [ ] **Step 5: Add autonomous action path**

Extend `hubItemsService.recordLifecycleAction` argument type:

```ts
actorType: "user" | "agent" | "system" | "autonomy";
autonomyLevel?: string;
decisionContext?: unknown;
```

Persist:

```ts
autonomyLevel: args.autonomyLevel ?? null,
decisionContext: args.decisionContext ?? null,
```

Do not write W3 Autopilot metadata to `relayResult`; `undoAction` already blocks rows with `relayResult` because those represent external/source relays. Add a regression test that an autonomous resolve with `decisionContext` and no `relayResult` can be undone through the existing undo path.

Add `hubAutopilotService.applyEvaluation(input)` that calls `hubItemsService(db).recordLifecycleAction` only for `auto_handle` with `resolve` or `archive`, using:

```ts
idempotencyKey: `autopilot:${companyId}:${hubItemId}:${version}:${action}`,
actorType: "autonomy",
actorId: "autopilot",
actorIsFounder: false,
authorityBasis: `autopilot_policy:${semanticType}:${evaluation.autonomyLevel}`,
autonomyLevel: evaluation.autonomyLevel,
reason: evaluation.reason,
decisionContext: {
  autopilot: true,
  semanticType,
  sourceType,
  sourceId,
  sourceAgentId,
  minTrustScore,
},
```

- [ ] **Step 6: Run service tests**

Run:

```powershell
corepack pnpm@9.15.4 --filter server test:run server/src/__tests__/hub-autopilot.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add server/src/services/hub-autopilot.ts server/src/services/hub-items.ts server/src/services/index.ts server/src/__tests__/hub-autopilot.test.ts
git commit -m "feat(server): add hub autopilot policy service"
```

---

## Task 4: Autopilot Routes

**Files:**
- Create: `server/src/routes/hub-autopilot.ts`
- Modify: `server/src/app.ts`
- Test: `server/src/__tests__/hub-autopilot-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Route tests must cover:

```ts
it("GET policy returns the company policy for board users", async () => {});
it("PATCH policy requires founder authority", async () => {});
it("PATCH policy logs an activity row", async () => {});
it("PATCH policy rejects founder-gated auto-handle rules", async () => {});
it("POST reset restores off defaults", async () => {});
it("GET actions returns recent autonomous actions with undo metadata", async () => {});
it("GET actions never returns another company's autonomy audit rows", async () => {});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
corepack pnpm@9.15.4 --filter server test:run server/src/__tests__/hub-autopilot-routes.test.ts
```

Expected: FAIL because route is absent.

- [ ] **Step 3: Implement route**

Create `hubAutopilotRoutes(db)` mirroring `notification-preferences.ts` and `hub-items.ts` auth patterns:

- `assertCompanyAccess(req, companyId)` for every route.
- Board auth required.
- `GET /policy` and `GET /actions` are readable by board users with company access.
- `PATCH` and `reset` require founder authority through `permissionService.isFounder` or implicit founder authority.
- Activity rows:
  - `hub_autopilot_policy.updated`
  - `hub_autopilot_policy.reset`
- `GET /actions` calls `hubAutopilotService.listRecentActions(companyId, { limit })` with a bounded limit (`1..50`, default `10`).

- [ ] **Step 4: Mount route**

In `server/src/app.ts`, import and mount near hub/notification routes:

```ts
import { hubAutopilotRoutes } from "./routes/hub-autopilot.js";
```

and:

```ts
app.use(API_PREFIX, hubAutopilotRoutes(db));
```

- [ ] **Step 5: Run route tests**

Run:

```powershell
corepack pnpm@9.15.4 --filter server test:run server/src/__tests__/hub-autopilot-routes.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add server/src/routes/hub-autopilot.ts server/src/app.ts server/src/__tests__/hub-autopilot-routes.test.ts
git commit -m "feat(server): expose hub autopilot policy routes"
```

---

## Task 5: Safe Server Invocation

**Files:**
- Modify: `server/src/routes/hub-items.ts`
- Modify: `server/src/services/hub-autopilot.ts`
- Test: `server/src/__tests__/hub-items-routes.test.ts` or `server/src/__tests__/hub-autopilot.test.ts`

- [ ] **Step 1: Write failing invocation tests**

Add tests that prove:

```ts
it("runs bounded autopilot evaluation after list source hydration", async () => {});
it("runs bounded autopilot evaluation after counts source hydration", async () => {});
it("does not invoke autopilot from client action routes", async () => {});
it("swallows stale-version autopilot conflicts and leaves user actions authoritative", async () => {});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
corepack pnpm@9.15.4 --filter server test:run server/src/__tests__/hub-items-routes.test.ts server/src/__tests__/hub-autopilot.test.ts
```

Expected: FAIL because invocation is not wired.

- [ ] **Step 3: Implement bounded evaluation**

In `hubAutopilotService`, add:

```ts
evaluateOpenItems(args: {
  companyId: string;
  limit: number;
}): Promise<{ evaluated: number; handled: number; escalated: number }>;
```

Behavior:

- Query only open hub items in the company.
- Limit to `Math.min(args.limit, 25)`.
- Skip founder-gated categories.
- Resolve source-agent context only for known W3-safe source types. Heartbeat-backed hub items can join `heartbeat_runs.agent_id`; other source types without a trustworthy agent principal escalate/noop instead of auto-handle.
- Apply only safe `resolve`/`archive` actions.
- Catch 409 conflicts and continue.
- Re-throw unexpected errors in tests; in production route invocation, log and continue so hub list/counts never fail because Autopilot failed.

- [ ] **Step 4: Wire list/counts after source hydration**

In `hub-items.ts`, create `const autopilot = hubAutopilotService(db);` and after `emitOpenApprovalHubItems`/`emitStaleWorkHubItems`, invoke:

```ts
await autopilot.evaluateOpenItems({ companyId, limit: query.limit });
```

For counts use a small cap:

```ts
await autopilot.evaluateOpenItems({ companyId, limit: 25 });
```

Do not call it from `POST /action`, `POST /undo`, `PATCH /state`, or `bulk-action`.

- [ ] **Step 5: Run invocation tests**

Run:

```powershell
corepack pnpm@9.15.4 --filter server test:run server/src/__tests__/hub-items-routes.test.ts server/src/__tests__/hub-autopilot.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add server/src/routes/hub-items.ts server/src/services/hub-autopilot.ts server/src/__tests__/hub-items-routes.test.ts server/src/__tests__/hub-autopilot.test.ts
git commit -m "feat(hub): invoke autopilot on hub refresh"
```

---

## Task 6: UI API and Query Wiring

**Files:**
- Modify: `ui/src/api/hub-items.ts`
- Modify: `ui/src/lib/queryKeys.ts`
- Test: `ui/src/api/__tests__/hub-items-api.test.ts`

- [ ] **Step 1: Write failing API tests**

Add:

```ts
it("reads, updates, and resets hub autopilot policy", async () => {
  get.mockResolvedValueOnce({ mode: "off", handledToday: 0, lastHandledAt: null, rules: [], updatedAt: null });
  patch.mockResolvedValueOnce({ mode: "drive", handledToday: 0, lastHandledAt: null, rules: [], updatedAt: null });
  post.mockResolvedValueOnce({ mode: "off", handledToday: 0, lastHandledAt: null, rules: [], updatedAt: null });
  get.mockResolvedValueOnce({ items: [] });

  await hubItemsApi.autopilotPolicy.get("company-1");
  await hubItemsApi.autopilotPolicy.update("company-1", { mode: "drive" });
  await hubItemsApi.autopilotPolicy.reset("company-1");
  await hubItemsApi.autopilotActions.list("company-1");

  expect(get).toHaveBeenCalledWith("/companies/company-1/hub-autopilot/policy");
  expect(patch).toHaveBeenCalledWith("/companies/company-1/hub-autopilot/policy", { mode: "drive" });
  expect(post).toHaveBeenCalledWith("/companies/company-1/hub-autopilot/policy/reset", {});
  expect(get).toHaveBeenCalledWith("/companies/company-1/hub-autopilot/actions");
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```powershell
corepack pnpm@9.15.4 test:run ui/src/api/__tests__/hub-items-api.test.ts
```

Expected: FAIL because `autopilotPolicy` is absent.

- [ ] **Step 3: Add client methods and query key**

In `ui/src/api/hub-items.ts` add:

```ts
autopilotPolicy: {
  get: (companyId: string) =>
    api.get<HubAutopilotPolicy>(`/companies/${companyId}/hub-autopilot/policy`),
  update: (companyId: string, patch: UpdateHubAutopilotPolicyInput) =>
    api.patch<HubAutopilotPolicy>(`/companies/${companyId}/hub-autopilot/policy`, patch),
  reset: (companyId: string) =>
    api.post<HubAutopilotPolicy>(`/companies/${companyId}/hub-autopilot/policy/reset`, {}),
},
autopilotActions: {
  list: (companyId: string) =>
    api.get<HubAutopilotActionsResponse>(`/companies/${companyId}/hub-autopilot/actions`),
},
```

In `queryKeys.ts` add:

```ts
autopilotPolicy: (companyId: string) => ["hub-items", companyId, "autopilot-policy"] as const,
autopilotActions: (companyId: string) => ["hub-items", companyId, "autopilot-actions"] as const,
```

- [ ] **Step 4: Run API tests**

Run:

```powershell
corepack pnpm@9.15.4 test:run ui/src/api/__tests__/hub-items-api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add ui/src/api/hub-items.ts ui/src/lib/queryKeys.ts ui/src/api/__tests__/hub-items-api.test.ts
git commit -m "feat(ui): add hub autopilot API client"
```

---

## Task 7: Hub Autopilot UI

**Files:**
- Modify: `ui/src/components/hub/HubHome.tsx`
- Modify: `ui/src/components/hub/HubShell.tsx`
- Modify: `ui/src/pages/InboxHub.tsx`
- Test: `ui/src/components/hub/__tests__/HubShell.test.tsx`
- Test: `ui/src/__tests__/InboxHub.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Add tests for:

```ts
it("renders live Autopilot status on Hub Home", async () => {});
it("updates Autopilot mode from hub settings", async () => {});
it("prevents founder-gated categories from being configured for auto-handle", async () => {});
it("resets Autopilot policy from hub settings", async () => {});
it("shows recent Autopilot actions and can undo an autonomous action", async () => {});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
corepack pnpm@9.15.4 test:run ui/src/components/hub/__tests__/HubShell.test.tsx ui/src/__tests__/InboxHub.test.tsx
```

Expected: FAIL because UI props/API wiring do not exist.

- [ ] **Step 3: Query/mutate policy in `InboxHub.tsx`**

Add policy `useQuery` with:

```ts
queryKey: selectedCompanyId
  ? queryKeys.hubItems.autopilotPolicy(selectedCompanyId)
  : ["hub-items", "autopilot-policy", "none"],
queryFn: () => hubItemsApi.autopilotPolicy.get(selectedCompanyId!),
enabled: !!selectedCompanyId,
```

Add actions `useQuery` with:

```ts
queryKey: selectedCompanyId
  ? queryKeys.hubItems.autopilotActions(selectedCompanyId)
  : ["hub-items", "autopilot-actions", "none"],
queryFn: () => hubItemsApi.autopilotActions.list(selectedCompanyId!),
enabled: !!selectedCompanyId,
```

Add update/reset mutations mirroring notification preferences:

- optimistic update optional for `mode`;
- rollback on error;
- invalidate `queryKeys.hubItems.autopilotPolicy(selectedCompanyId)`;
- invalidate `queryKeys.hubItems.autopilotActions(selectedCompanyId)` after successful auto-action undo or policy changes;
- invalidate `["hub-items", selectedCompanyId]` and counts after successful policy changes because visible item volume may change after evaluation.

- [ ] **Step 4: Render Home status**

Replace the preview status in `HubHome.tsx` with:

```tsx
<span>{autopilotPolicy.mode === "off" ? "Off" : autopilotPolicy.mode === "assist" ? "Assist" : "Drive"}</span>
```

Keep the card compact; do not introduce a landing-page style hero.

Render a compact "Handled today" list under the status when `autopilotActions.items` is non-empty:

- title/semantic type;
- action and autonomy level;
- reason;
- undo button when `undoDeadline` is still open and `hubItemId`/`itemVersion` are present.

The undo button should reuse the existing `hubItemsApi.undo(companyId, itemId, { auditId, expectedVersion })` path; no new undo route is required.

- [ ] **Step 5: Add settings controls**

In `HubShell.tsx`, add an Autopilot settings panel:

- mode select: Off, Assist, Drive;
- category rows for safe categories only;
- action select: None, Resolve, Archive;
- min trust score numeric input 0-100;
- enabled checkbox;
- reset button.

Founder-gated categories must render as disabled/escalate-only text in this PR.

- [ ] **Step 6: Run UI tests**

Run:

```powershell
corepack pnpm@9.15.4 test:run ui/src/components/hub/__tests__/HubShell.test.tsx ui/src/__tests__/InboxHub.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add ui/src/components/hub/HubHome.tsx ui/src/components/hub/HubShell.tsx ui/src/pages/InboxHub.tsx ui/src/components/hub/__tests__/HubShell.test.tsx ui/src/__tests__/InboxHub.test.tsx
git commit -m "feat(hub): add Autopilot policy controls"
```

---

## Task 8: E2E and Roadmap Update

**Files:**
- Create: `tests/e2e/inbox-hub-autopilot.spec.ts`
- Modify: `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md`
- Modify: `docs/aoa/plans/2026-07-01-w3-autopilot-core-plan.md`

- [x] **Step 1: Add Playwright coverage**

Create a W3 e2e that covers:

1. open Inbox Hub Home;
2. open Hub settings;
3. switch Autopilot from Off to Drive;
4. enable a safe category such as `run_complete` with `resolve` and min trust `0`;
5. seed or trigger an open hub item in that category;
6. refresh hub list/counts;
7. assert the item is auto-resolved or no longer appears in open list;
8. assert Hub Home shows the handled action in the Autopilot "Handled today" list with Autopilot/autonomy attribution;
9. undo the action from that list and assert the item returns open.

- [x] **Step 2: Update roadmap**

In `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md`:

- mark W2 Layer 3 merged in PR #248;
- mark W3 Autopilot active on `codex/w3-autopilot-planning`;
- state W4 Steward and W5 runtime bridges remain unplanned/unbuilt after W3 Core.

- [x] **Step 3: Run local focused verification**

Run:

```powershell
corepack pnpm@9.15.4 test:run packages/shared/src/__tests__/hub-contract.test.ts server/src/__tests__/hub-autopilot.test.ts server/src/__tests__/hub-autopilot-routes.test.ts ui/src/api/__tests__/hub-items-api.test.ts ui/src/components/hub/__tests__/HubShell.test.tsx ui/src/__tests__/InboxHub.test.tsx
corepack pnpm@9.15.4 -r typecheck
corepack pnpm@9.15.4 test:run
corepack pnpm@9.15.4 build
```

Expected: PASS.

- [x] **Step 4: Run e2e where supported**

Run:

```powershell
corepack pnpm@9.15.4 test:e2e inbox-hub-autopilot.spec.ts
```

If local Windows embedded-Postgres e2e skips by repo policy, note that CI remains the Linux Playwright gate and run any available Windows sentinel command.

Local result on 2026-07-01: Windows without `DATABASE_URL` matched the documented
sentinel only (`windows-embedded-postgres-skip.spec.ts`, 1 skipped). The focused
`inbox-hub-autopilot.spec.ts` is therefore delegated to the Linux/CI Playwright
gate unless an external `DATABASE_URL` is provided locally.

- [ ] **Step 5: Commit**

```powershell
git add tests/e2e/inbox-hub-autopilot.spec.ts docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md docs/aoa/plans/2026-07-01-w3-autopilot-core-plan.md
git commit -m "test(hub): add W3 Autopilot acceptance coverage"
```

---

## Final Verification

Before opening the PR, run:

```powershell
corepack pnpm@9.15.4 -r typecheck
corepack pnpm@9.15.4 test:run
corepack pnpm@9.15.4 build
corepack pnpm@9.15.4 test:e2e inbox-hub-autopilot.spec.ts
```

Expected:

- Typecheck passes for all packages.
- Unit/integration test suite passes.
- Build passes.
- W3 e2e passes locally or is explicitly delegated to CI with the documented local skip reason.

## PR Checklist

- [ ] W3 stays limited to Autopilot policy/evaluation/audit/undo.
- [ ] No W4 Steward agent, LLM curation, or background worker enters this PR.
- [ ] No W5 adapter bridge or runtime CLI relay enters this PR.
- [ ] Founder-gated semantic types cannot be auto-handled.
- [ ] Auto-action audit rows use `actorType = "autonomy"` and include `autonomyLevel`.
- [ ] Auto-action audit metadata uses reversible `decisionContext`, not `relayResult`.
- [ ] Recent Autopilot actions are visible from Hub Home and undoable inside the undo window.
- [ ] Auto-actions use idempotency keys and optimistic concurrency.
- [ ] Undo works for autonomous resolve/archive actions.
- [ ] UI communicates Off/Assist/Drive without implying unsafe full autonomy.
- [ ] Roadmap updated with W2-L3 merged and W3 active/in PR.

## Review Plan

After implementation and before PR handoff:

1. Run `/review` or `codex review` against the branch diff.
2. Address all legitimate findings using `superpowers:receiving-code-review`.
3. Rerun CI if needed and watch until `ci-required` passes.
4. Comment on any GitHub review threads with the verified fix summary.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | Not run | Scope follows master W3 boundary; run if product scope changes before implementation. |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | Not run | No implementation diff exists yet; run before PR handoff. |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | Clear | 5 issues found and fixed: derived handled counters stay out of policy storage; W3 policy metadata moved from non-undoable `relayResult` to reversible `decisionContext`; policy updates reject duplicate category rules and normalize sparse patches; `handledToday` uses UTC day boundaries until timezone support exists; recent Autopilot actions now have an explicit read model and Home undo flow. |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | Not run | Recommended after UI implementation if Autopilot settings grow beyond the compact Hub settings panel. |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | Not run | Not needed for this internal feature plan. |

- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED - ready for implementation planning/execution after user approval.
