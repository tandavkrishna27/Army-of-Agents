# Stage B — Onboarding State Machine + Step Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `2026-07-12-onboarding-auth-redesign-stage0-contracts.md` FIRST — it defines every shared type, table, and interface referenced here (§2.2 `onboarding_progress`, §3 `ONBOARDING_STATES`/journeys, §4 `StepDefinition`/`StepContext`, §6 file map, §7 testing conventions). Do not redefine any contract locally.

**Goal:** Ship the resumable onboarding spine — the `onboarding_progress` table, the shared state enums, a server service + route that upsert/advance/resume progress (board-actor self-scoped), the client-side `StepDefinition` registry + pure `resolveNextStep` engine contract, a `FlowEngine` that walks the registry / persists state / resumes on return / respects the two-layer (user vs org) split, the `/onboarding` + `/onboarding/join` routes, and Lobby "create-new-org" replay that re-enters only the org layer. Stage C fills the real step UIs into the (empty-but-typed) registry.

**Architecture:** One `onboarding_progress` row per `(userId, companyId)`; the user-layer row has `companyId = null`, org-layer rows carry a real company id. The service is a thin idempotent upsert/advance layer (append-to-`completedStates`, set `currentState`) plus a pure `firstIncompleteState` reducer. The route is board-actor-only and self-scoped to `req.actor.userId`. On the client, `resolveNextStep(registry, ctx)` is a pure function; `FlowEngine` unions the user-layer + org-layer completed states into one `StepContext`, resolves the current step, renders it, and on `onComplete` PATCHes the completion state to the correct layer then recomputes. Org-replay is the same engine started for the founder journey while the user-layer row already carries `AUTHENTICATED`+`PROFILE_SET`, so the reducer naturally skips the user steps.

**Tech stack:** Drizzle ORM (Postgres), Express 5, Vitest, React + Vite + Tailwind v4, `@armyofagents/shared`. Package manager: **pnpm**.

**Ships independently:** after Stage B, the DB persists onboarding progress; the server exposes `GET/PATCH /api/onboarding/progress`; the client has a working `FlowEngine` mounted at `/onboarding` + `/onboarding/join` and reachable from the Lobby in org-replay mode. Because the registry is intentionally empty in Stage B (Stage C populates it), the engine resolves to "complete" immediately for a fresh user — that is the correct, testable Stage B end-state (the pipes are laid; the steps are Stage C).

**Depends on (Stage A):** the shared file `packages/shared/src/onboarding.ts` (`PostAuthJourneyResult`) and the client `ui/src/api/onboarding.ts` (`fetchJourney`/`destinationForJourney`) are created in Stage A. Stage B **adds to** those files (idempotent/additive) — every task below that touches them checks-then-appends and never clobbers Stage A exports. If Stage A has not landed when Stage B executes, the additive tasks create the file fresh (the shared type block is duplicated verbatim from Stage 0 §3.2, so the result is identical either way).

---

## Pre-flight (once, before Task B1)

- [ ] **Confirm test/build/generate command names**

Run (repo root):
```
node -e "const p=require('./server/package.json');console.log('server scripts:',Object.keys(p.scripts).join(','))"
node -e "const p=require('./ui/package.json');console.log('ui scripts:',Object.keys(p.scripts).join(','))"
node -e "const p=require('./packages/shared/package.json');console.log('shared scripts:',Object.keys(p.scripts).join(','))"
```

Expected findings (verified in this worktree — use them in all `Run:` steps below):
- **Server has NO `test` script.** Server tests run through the ROOT vitest project config (`vitest.config.ts` lists `"server"` under `test.projects`). Run a single server file from repo root with: `pnpm test:run <path/to/file>`. (The Stage 0 §7 / Stage A note `pnpm test:run` does not exist here — see the reconciler note at the end of this doc.)
- **Shared** has `test` = `vitest run`. Single file: `pnpm test:run <relative-path>`.
- **UI** has `test` = `vitest` (watch). For deterministic single-file runs use: `pnpm test:run <relative-path>`.
- **DB migration generate:** `pnpm db:generate` (root) → `pnpm --filter @armyofagents/db generate` → `tsc -p tsconfig.json && drizzle-kit generate`. It compiles the schema to `dist/schema/*.js` first, then writes SQL to `packages/db/src/migrations/`.
- **Type/build gate:** `pnpm -r typecheck` (root) or `pnpm build`. There is no root `verify` script — use `pnpm -r typecheck` where Stage A said `pnpm typecheck`.

> Task author: the four `Run:` command families above are the only script-name unknowns in this stage; they are confirmed for this worktree. Re-confirm only if `package.json` changed since 2026-07-12.

---

## Task B1: `onboarding_progress` Drizzle table + exports + migration

**Files:**
- Create: `packages/db/src/schema/onboarding_progress.ts`
- Modify: `packages/db/src/schema/index.ts` (append one export line; alongside `environments` at ~:122)
- Generated: `packages/db/src/migrations/0166_*.sql` (+ `meta/_journal.json` entry) via `pnpm db:generate`
- Test: `packages/db/src/__tests__/onboarding-progress-schema.test.ts` (contract test — no DB)

- [ ] **Step 1: Write the failing test**

> Task author: confirm `packages/db` has a test dir + is in the vitest `projects` list (it is: `"packages/db"`). If `packages/db/src/__tests__/` does not exist, create it; a sibling schema contract test may already live under `packages/db/src/` — match its location if so.

```ts
// packages/db/src/__tests__/onboarding-progress-schema.test.ts
import { describe, it, expect } from "vitest";
import { onboardingProgress } from "../schema/onboarding_progress.js";
import * as dbIndex from "../index.js";

describe("onboarding_progress schema", () => {
  it("is a pg table named onboarding_progress with the Stage 0 §2.2 columns", () => {
    const cols = Object.keys(onboardingProgress);
    for (const c of [
      "id",
      "userId",
      "companyId",
      "journey",
      "currentState",
      "completedStates",
      "createdAt",
      "updatedAt",
    ]) {
      expect(cols).toContain(c);
    }
  });
  it("is re-exported from the db package root", () => {
    expect((dbIndex as Record<string, unknown>).onboardingProgress).toBe(onboardingProgress);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/onboarding-progress-schema.test.ts`
Expected: FAIL — `../schema/onboarding_progress.js` module not found.

- [ ] **Step 3: Create the schema file — EXACTLY per Stage 0 §2.2**

```ts
// packages/db/src/schema/onboarding_progress.ts
import { jsonb, pgTable, text, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const onboardingProgress = pgTable(
  "onboarding_progress",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull(),                 // better-auth user.id
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }), // null for user-layer-only progress
    journey: text("journey").notNull(),                // "founder" | "invited"
    currentState: text("current_state").notNull(),     // OnboardingState value
    completedStates: jsonb("completed_states").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyUq: uniqueIndex("onboarding_progress_user_company_uq").on(table.userId, table.companyId),
  }),
);
```

- [ ] **Step 4: Export from the schema barrel + package root**

In `packages/db/src/schema/index.ts`, add next to the `environments` export (~:122):

```ts
export { onboardingProgress } from "./onboarding_progress.js";
```

(`packages/db/src/index.ts` already re-exports `export * from "./schema/index.js";` — no edit needed there; the barrel line above is what surfaces `onboardingProgress` at the package root.)

- [ ] **Step 5: Run the schema/contract test, verify pass**

Run: `pnpm test:run src/__tests__/onboarding-progress-schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Generate the migration**

Run: `pnpm db:generate`
Expected: prints something like `Reading schema files… [✓] Your SQL migration file ➜ src/migrations/0166_<name>.sql`. It creates `packages/db/src/migrations/0166_*.sql` containing `CREATE TABLE "onboarding_progress"` + the `onboarding_progress_user_company_uq` unique index + the `company_id` FK to `companies(id) ON DELETE CASCADE`, and appends an `idx: 166` entry to `packages/db/src/migrations/meta/_journal.json`.

Verify (no new drift):
```
git status --short packages/db/src/migrations | head
```
Expected: exactly one new `0166_*.sql` + modified `meta/_journal.json` + a new `meta/0166_snapshot.json`. If `db:generate` emits changes to OTHER tables' SQL, STOP — the schema build picked up unrelated drift; investigate before committing.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/onboarding_progress.ts packages/db/src/schema/index.ts packages/db/src/migrations/ packages/db/src/__tests__/onboarding-progress-schema.test.ts
git commit -m "feat(onboarding): add onboarding_progress table + migration"
```

---

## Task B2: Shared state enums + `PostAuthJourneyResult` (additive / idempotent)

**Files:**
- Modify: `packages/shared/src/constants.ts` (append `ONBOARDING_STATES`, `ONBOARDING_JOURNEYS`, `FOUNDER_PHASE1_STATES` + their types)
- Modify: `packages/shared/src/index.ts` (re-export the new names)
- Create-or-verify: `packages/shared/src/onboarding.ts` (`PostAuthJourneyResult` — Stage A may already have created it)
- Test: `packages/shared/src/__tests__/onboarding-constants.test.ts`

> **Dependency note:** `packages/shared/src/onboarding.ts` and its re-export are Stage A's responsibility (Stage 0 §3.2, file map §6). If Stage A already landed, Step 3b is a no-op (verify only). If not, Step 3b creates the file verbatim from Stage 0. Either path yields the identical exported type — do NOT duplicate the `export type PostAuthJourneyResult` in two files.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/__tests__/onboarding-constants.test.ts
import { describe, it, expect } from "vitest";
import {
  ONBOARDING_STATES,
  ONBOARDING_JOURNEYS,
  FOUNDER_PHASE1_STATES,
} from "../constants.js";

describe("onboarding shared constants", () => {
  it("ONBOARDING_STATES holds the Phase 1 states in order + Phase 2 reserved tail", () => {
    // First nine are the Phase 1 founder-driven states, in order.
    expect(ONBOARDING_STATES.slice(0, 9)).toEqual([
      "AUTHENTICATED",
      "PROFILE_SET",
      "ORGANIZATION_CREATED",
      "ENVIRONMENT_READY",
      "COMMANDER_SELECTED",
      "COMMANDER_VERIFIED",
      "DEPARTMENT_CREATED",
      "AGENT_ASSIGNED",
      "SETUP_COMPLETE",
    ]);
    // Phase 2 states are reserved (present but not driven in Phase 1).
    expect(ONBOARDING_STATES).toContain("ONBOARDING_COMPLETE");
    expect(ONBOARDING_STATES).toContain("WALKTHROUGH_STARTED");
  });
  it("FOUNDER_PHASE1_STATES equals the first nine states", () => {
    expect(FOUNDER_PHASE1_STATES).toEqual(ONBOARDING_STATES.slice(0, 9));
  });
  it("ONBOARDING_JOURNEYS is exactly founder + invited", () => {
    expect(ONBOARDING_JOURNEYS).toEqual(["founder", "invited"]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/onboarding-constants.test.ts`
Expected: FAIL — `ONBOARDING_STATES` not exported.

- [ ] **Step 3a: Append the constants — EXACTLY per Stage 0 §3.1**

At the end of `packages/shared/src/constants.ts`, append:

```ts
export const ONBOARDING_STATES = [
  "AUTHENTICATED",
  "PROFILE_SET",
  "ORGANIZATION_CREATED",
  "ENVIRONMENT_READY",
  "COMMANDER_SELECTED",
  "COMMANDER_VERIFIED",
  "DEPARTMENT_CREATED",
  "AGENT_ASSIGNED",
  "SETUP_COMPLETE",
  // Phase 2 (reserved — not implemented in Phase 1):
  "WALKTHROUGH_STARTED",
  "DISCUSSION_ANALYZED",
  "CLARIFICATIONS_RESOLVED",
  "SCOPE_CREATED",
  "SCOPE_APPROVED",
  "MEMORY_SAVED",
  "TASKS_CREATED",
  "AGENT_EXECUTION_STARTED",
  "ONBOARDING_COMPLETE",
] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];

export const ONBOARDING_JOURNEYS = ["founder", "invited"] as const;
export type OnboardingJourney = (typeof ONBOARDING_JOURNEYS)[number];

// The ordered founder-journey states Phase 1 actually drives:
export const FOUNDER_PHASE1_STATES: OnboardingState[] = [
  "AUTHENTICATED",
  "PROFILE_SET",
  "ORGANIZATION_CREATED",
  "ENVIRONMENT_READY",
  "COMMANDER_SELECTED",
  "COMMANDER_VERIFIED",
  "DEPARTMENT_CREATED",
  "AGENT_ASSIGNED",
  "SETUP_COMPLETE",
];
```

> Note: Stage 0 §3.3 also specs `DEPARTMENT_FUNCTION_TYPES` in this file — that is **Stage C's** append (it pairs with the `NewProjectDialog` consolidation). Do NOT add it here; Stage B only needs the state/journey constants.

In `packages/shared/src/index.ts`, add the re-exports (place near the other `constants.ts` re-exports at the top block):

```ts
  ONBOARDING_STATES,
  ONBOARDING_JOURNEYS,
  FOUNDER_PHASE1_STATES,
```

and add the type re-exports wherever the file re-exports constant types (follow the existing `export type { … } from "./constants.js"` pattern; if a single grouped `export type` block exists, add `OnboardingState`, `OnboardingJourney`):

```ts
export type { OnboardingState, OnboardingJourney } from "./constants.js";
```

> Task author: `packages/shared/src/index.ts` mixes value re-exports (`export { … }`) and type re-exports (`export type { … }`). Add `ONBOARDING_STATES`/`ONBOARDING_JOURNEYS`/`FOUNDER_PHASE1_STATES` to a value block and `OnboardingState`/`OnboardingJourney` to a type block. Confirm the exact block boundaries in the file before editing (the head of the file shows the `export { … } from "./constants.js"` group).

- [ ] **Step 3b: Ensure `PostAuthJourneyResult` exists (Stage A dependency)**

Check: `ls packages/shared/src/onboarding.ts`.
- If it EXISTS (Stage A landed): verify it exports `PostAuthJourneyResult` and that `packages/shared/src/index.ts` re-exports it. No further edit. Skip to Step 4.
- If it does NOT exist: create it verbatim from Stage 0 §3.2 and re-export it:

```ts
// packages/shared/src/onboarding.ts
import type { OnboardingJourney } from "./constants.js";

export type PostAuthJourneyResult = {
  journey: OnboardingJourney | "returning";
  // For "invited": the company to join. For "returning": the company to land on. Null for "founder".
  targetCompanyId: string | null;
  inviteToken?: string | null;
};
```

In `packages/shared/src/index.ts` add:
```ts
export type { PostAuthJourneyResult } from "./onboarding.js";
```

- [ ] **Step 4: Run test + shared typecheck, verify pass**

Run: `pnpm test:run src/__tests__/onboarding-constants.test.ts` then `pnpm --filter @armyofagents/shared typecheck`
Expected: PASS (3 tests); no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/index.ts packages/shared/src/onboarding.ts packages/shared/src/__tests__/onboarding-constants.test.ts
git commit -m "feat(onboarding): shared ONBOARDING_STATES/JOURNEYS + FOUNDER_PHASE1_STATES"
```

---

## Task B3: `onboarding` service — upsert / advance / resume

**Files:**
- Create: `server/src/services/onboarding.ts`
- Modify: `server/src/services/index.ts` (export `onboardingService` — follow the barrel pattern of `goalService`)
- Test: `server/src/__tests__/onboarding-service.test.ts` (pure reducer + sequence-db mock)

The service exposes:
- `firstIncompleteState(completedStates, ordered)` — **pure** reducer used for resume.
- `getProgress(userId, companyId)` — null-company-aware read.
- `advanceState(userId, companyId, journey, state)` — idempotent upsert: creates the row on first advance (seeding `currentState`), else appends `state` to `completedStates` (deduped) and sets `currentState = state`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/onboarding-service.test.ts
import { vi, describe, it, expect } from "vitest";

const { mockEq, mockAnd, mockIsNull } = vi.hoisted(() => ({
  mockEq: vi.fn((..._a: unknown[]) => "eq"),
  mockAnd: vi.fn((..._a: unknown[]) => "and"),
  mockIsNull: vi.fn((..._a: unknown[]) => "isNull"),
}));

vi.mock("drizzle-orm", () => ({ eq: mockEq, and: mockAnd, isNull: mockIsNull }));

vi.mock("@armyofagents/db", () => {
  const makeTable = (name: string) => {
    const cols: Record<string, symbol> = {};
    return new Proxy({} as Record<string, unknown>, {
      get(_t, prop) {
        if (prop === "_") return { name };
        if (prop === "$inferSelect" || prop === "$inferInsert") return {};
        if (typeof prop === "string") {
          if (!cols[prop]) cols[prop] = Symbol(prop);
          return cols[prop];
        }
        return undefined;
      },
    });
  };
  return { onboardingProgress: makeTable("onboarding_progress") };
});

import { onboardingService, firstIncompleteState } from "../services/onboarding.js";
import { FOUNDER_PHASE1_STATES } from "@armyofagents/shared";

type MockRow = Record<string, unknown>;
function createSequenceDb(
  config: { selects?: MockRow[][]; inserts?: MockRow[][]; updates?: MockRow[][] } = {},
) {
  let s = 0, i = 0, u = 0;
  const selects = config.selects ?? [], inserts = config.inserts ?? [], updates = config.updates ?? [];
  const captured = { inserts: [] as MockRow[], updates: [] as MockRow[] };
  function chain(getResult: () => MockRow[], sink?: (v: MockRow) => void) {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "where", "returning", "orderBy", "limit"]) c[m] = () => c;
    c.values = (v: MockRow) => { sink?.(v); return c; };
    c.set = (v: MockRow) => { sink?.(v); return c; };
    c.then = (res: (v: MockRow[]) => unknown) => Promise.resolve(res(getResult()));
    return c;
  }
  const db = {
    select: () => chain(() => selects[s++] ?? []),
    insert: () => chain(() => inserts[i++] ?? [], (v) => captured.inserts.push(v)),
    update: () => chain(() => updates[u++] ?? [], (v) => captured.updates.push(v)),
  } as any;
  return { db, captured };
}

describe("firstIncompleteState (pure resume reducer)", () => {
  it("returns the first ordered state not in completedStates", () => {
    expect(firstIncompleteState(["AUTHENTICATED", "PROFILE_SET"], FOUNDER_PHASE1_STATES))
      .toBe("ORGANIZATION_CREATED");
  });
  it("returns the first state when nothing is complete", () => {
    expect(firstIncompleteState([], FOUNDER_PHASE1_STATES)).toBe("AUTHENTICATED");
  });
  it("returns null when every ordered state is complete", () => {
    expect(firstIncompleteState([...FOUNDER_PHASE1_STATES], FOUNDER_PHASE1_STATES)).toBeNull();
  });
  it("ignores unknown/extra completed states", () => {
    expect(firstIncompleteState(["AUTHENTICATED", "BOGUS"], FOUNDER_PHASE1_STATES)).toBe("PROFILE_SET");
  });
});

describe("onboardingService.getProgress", () => {
  it("returns the row for (userId, companyId)", async () => {
    const { db } = createSequenceDb({ selects: [[{ id: "p1", userId: "u1", companyId: "c1", completedStates: ["AUTHENTICATED"] }]] });
    const row = await onboardingService(db).getProgress("u1", "c1");
    expect(row?.id).toBe("p1");
  });
  it("returns null when no row exists (user-layer, null company)", async () => {
    const { db } = createSequenceDb({ selects: [[]] });
    expect(await onboardingService(db).getProgress("u1", null)).toBeNull();
  });
});

describe("onboardingService.advanceState", () => {
  it("INSERTs a new row on first advance (seeds currentState + completedStates)", async () => {
    const { db, captured } = createSequenceDb({
      selects: [[]], // no existing row
      inserts: [[{ id: "new", userId: "u1", companyId: null, journey: "founder", currentState: "PROFILE_SET", completedStates: ["PROFILE_SET"] }]],
    });
    const row = await onboardingService(db).advanceState("u1", null, "founder", "PROFILE_SET");
    expect(captured.inserts[0]).toMatchObject({ userId: "u1", journey: "founder", currentState: "PROFILE_SET" });
    expect((captured.inserts[0] as any).completedStates).toEqual(["PROFILE_SET"]);
    expect(row.currentState).toBe("PROFILE_SET");
  });
  it("UPDATEs an existing row: appends state (deduped) + sets currentState", async () => {
    const { db, captured } = createSequenceDb({
      selects: [[{ id: "p1", userId: "u1", companyId: "c1", journey: "founder", currentState: "PROFILE_SET", completedStates: ["AUTHENTICATED", "PROFILE_SET"] }]],
      updates: [[{ id: "p1", currentState: "ORGANIZATION_CREATED", completedStates: ["AUTHENTICATED", "PROFILE_SET", "ORGANIZATION_CREATED"] }]],
    });
    await onboardingService(db).advanceState("u1", "c1", "founder", "ORGANIZATION_CREATED");
    expect((captured.updates[0] as any).completedStates).toEqual(["AUTHENTICATED", "PROFILE_SET", "ORGANIZATION_CREATED"]);
    expect((captured.updates[0] as any).currentState).toBe("ORGANIZATION_CREATED");
  });
  it("is idempotent: re-advancing a completed state does not duplicate it", async () => {
    const { db, captured } = createSequenceDb({
      selects: [[{ id: "p1", userId: "u1", companyId: "c1", journey: "founder", currentState: "PROFILE_SET", completedStates: ["AUTHENTICATED", "PROFILE_SET"] }]],
      updates: [[{ id: "p1" }]],
    });
    await onboardingService(db).advanceState("u1", "c1", "founder", "PROFILE_SET");
    expect((captured.updates[0] as any).completedStates).toEqual(["AUTHENTICATED", "PROFILE_SET"]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run server/src/__tests__/onboarding-service.test.ts`
Expected: FAIL — `../services/onboarding.js` module not found.

- [ ] **Step 3: Implement the service**

```ts
// server/src/services/onboarding.ts
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { onboardingProgress } from "@armyofagents/db";
import type { OnboardingJourney, OnboardingState } from "@armyofagents/shared";

export type OnboardingProgressRow = typeof onboardingProgress.$inferSelect;

/**
 * Pure resume reducer: the first state in `ordered` that is NOT in
 * `completedStates`, or null when all ordered states are complete. Unknown
 * entries in `completedStates` are ignored. Used by the FlowEngine + tests to
 * drop the user at the first incomplete step.
 */
export function firstIncompleteState(
  completedStates: string[],
  ordered: readonly OnboardingState[],
): OnboardingState | null {
  const done = new Set(completedStates);
  for (const s of ordered) {
    if (!done.has(s)) return s;
  }
  return null;
}

/**
 * Resume-aware onboarding_progress service. Exactly one row per
 * (userId, companyId); the user-layer row has companyId = null. Postgres
 * unique indexes treat NULL distinctly, so the null-company path cannot use
 * onConflict — it is a read-then-insert/update guarded by the single-writer
 * (self-scoped board actor) route. All mutations are idempotent: re-advancing
 * a state that is already complete is a no-op on completedStates.
 */
export function onboardingService(db: Db) {
  function whereScope(userId: string, companyId: string | null) {
    return companyId === null
      ? and(eq(onboardingProgress.userId, userId), isNull(onboardingProgress.companyId))
      : and(eq(onboardingProgress.userId, userId), eq(onboardingProgress.companyId, companyId));
  }

  async function getProgress(
    userId: string,
    companyId: string | null,
  ): Promise<OnboardingProgressRow | null> {
    const rows = await db
      .select()
      .from(onboardingProgress)
      .where(whereScope(userId, companyId));
    return rows[0] ?? null;
  }

  async function advanceState(
    userId: string,
    companyId: string | null,
    journey: OnboardingJourney,
    state: OnboardingState,
  ): Promise<OnboardingProgressRow> {
    const existing = await getProgress(userId, companyId);
    if (!existing) {
      const [inserted] = await db
        .insert(onboardingProgress)
        .values({
          userId,
          companyId,
          journey,
          currentState: state,
          completedStates: [state],
        })
        .returning();
      return inserted;
    }
    const already = existing.completedStates ?? [];
    const completedStates = already.includes(state) ? already : [...already, state];
    const [updated] = await db
      .update(onboardingProgress)
      .set({ currentState: state, completedStates, updatedAt: new Date() })
      .where(eq(onboardingProgress.id, existing.id))
      .returning();
    return updated;
  }

  return { getProgress, advanceState, firstIncompleteState };
}
```

In `server/src/services/index.ts`, add the barrel export (follow the `goalService` line):

```ts
export { onboardingService, firstIncompleteState } from "./onboarding.js";
export type { OnboardingProgressRow } from "./onboarding.js";
```

> Task author: confirm `server/src/services/index.ts` re-exports services individually (it does — `goalService` is exported there and imported by `routes/goals.ts` as `{ goalService }` from `../services/index.js`). Add the two lines above near the other service exports.

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test:run server/src/__tests__/onboarding-service.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/onboarding.ts server/src/services/index.ts server/src/__tests__/onboarding-service.test.ts
git commit -m "feat(onboarding): onboarding_progress service (upsert/advance/resume)"
```

---

## Task B4: `onboarding` route — GET progress, PATCH advance (board-only, self-scoped)

**Files:**
- Create: `server/src/routes/onboarding.ts`
- Modify: `server/src/app.ts` (mount `onboardingRoutes(db)` next to `goalRoutes(db)` at ~:279)
- Test: `server/src/__tests__/onboarding-route.test.ts` (mock-router harness)

Contract:
- `GET /api/onboarding/progress?companyId=<uuid>` (omit `companyId` for the user layer) → `{ progress: OnboardingProgressRow | null }`. Board actor only; scoped to `req.actor.userId`.
- `PATCH /api/onboarding/progress` body `{ companyId: string | null, journey: "founder" | "invited", state: OnboardingState }` → `{ progress: OnboardingProgressRow }`. Board actor only; writes the row for `req.actor.userId` (a caller can never advance another user's progress — `userId` is taken from the actor, never the body).

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/onboarding-route.test.ts
import { vi, describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const advanceState = vi.fn();
const getProgress = vi.fn();

vi.mock("../services/index.js", () => ({
  onboardingService: vi.fn(() => ({ getProgress, advanceState })),
}));
// authz: assertBoard throws 401/403 for non-board; here we inject a board actor.
vi.mock("../routes/authz.js", () => ({
  assertBoard: vi.fn((req: any) => {
    if (req.actor?.type !== "board") {
      const e: any = new Error("Board access required");
      e.status = req.actor?.type === "none" ? 401 : 403;
      throw e;
    }
  }),
}));

import { onboardingRoutes } from "../routes/onboarding.js";

function appWith(actor: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.actor = actor; next(); });
  app.use("/api", onboardingRoutes({} as any));
  // Minimal error surface mirroring app.ts's error handler.
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}
const BOARD = { type: "board", userId: "u1" };

beforeEach(() => { advanceState.mockReset(); getProgress.mockReset(); });

describe("GET /api/onboarding/progress", () => {
  it("returns the user-layer progress (no companyId) scoped to the actor", async () => {
    getProgress.mockResolvedValue({ id: "p1", userId: "u1", companyId: null });
    const res = await request(appWith(BOARD)).get("/api/onboarding/progress");
    expect(res.status).toBe(200);
    expect(getProgress).toHaveBeenCalledWith("u1", null);
    expect(res.body.progress.id).toBe("p1");
  });
  it("passes companyId through for the org layer", async () => {
    getProgress.mockResolvedValue(null);
    const res = await request(appWith(BOARD)).get("/api/onboarding/progress?companyId=c9");
    expect(getProgress).toHaveBeenCalledWith("u1", "c9");
    expect(res.body.progress).toBeNull();
  });
  it("401 for an unauthenticated (type none) actor", async () => {
    const res = await request(appWith({ type: "none" })).get("/api/onboarding/progress");
    expect(res.status).toBe(401);
  });
  it("403 for a non-board actor (agent)", async () => {
    const res = await request(appWith({ type: "agent" })).get("/api/onboarding/progress");
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/onboarding/progress", () => {
  it("advances the actor's own progress and ignores any userId in the body", async () => {
    advanceState.mockResolvedValue({ id: "p1", currentState: "PROFILE_SET" });
    const res = await request(appWith(BOARD))
      .patch("/api/onboarding/progress")
      .send({ companyId: null, journey: "founder", state: "PROFILE_SET", userId: "ATTACKER" });
    expect(res.status).toBe(200);
    expect(advanceState).toHaveBeenCalledWith("u1", null, "founder", "PROFILE_SET");
    expect(res.body.progress.currentState).toBe("PROFILE_SET");
  });
  it("400 on an unknown state value", async () => {
    const res = await request(appWith(BOARD))
      .patch("/api/onboarding/progress")
      .send({ companyId: null, journey: "founder", state: "NOT_A_STATE" });
    expect(res.status).toBe(400);
    expect(advanceState).not.toHaveBeenCalled();
  });
  it("400 on an unknown journey value", async () => {
    const res = await request(appWith(BOARD))
      .patch("/api/onboarding/progress")
      .send({ companyId: null, journey: "hacker", state: "PROFILE_SET" });
    expect(res.status).toBe(400);
  });
});
```

> Task author: confirm `supertest` + `express` are importable in server tests (grep an existing route test that uses `supertest`; if the repo prefers the mock-router harness in `aoa-agents-api.test.ts` over a live express app, mirror that instead — the assertions above are harness-agnostic). If `supertest` is absent, drive the exported handlers directly with fake `req`/`res` objects.

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run server/src/__tests__/onboarding-route.test.ts`
Expected: FAIL — `../routes/onboarding.js` module not found.

- [ ] **Step 3: Implement the route**

```ts
// server/src/routes/onboarding.ts
import { Router } from "express";
import type { Db } from "@armyofagents/db";
import {
  ONBOARDING_STATES,
  ONBOARDING_JOURNEYS,
  type OnboardingJourney,
  type OnboardingState,
} from "@armyofagents/shared";
import { onboardingService } from "../services/index.js";
import { assertBoard } from "./authz.js";
import { badRequest } from "../errors.js";

const STATE_SET = new Set<string>(ONBOARDING_STATES);
const JOURNEY_SET = new Set<string>(ONBOARDING_JOURNEYS);

export function onboardingRoutes(db: Db) {
  const router = Router();
  const svc = onboardingService(db);

  // GET /api/onboarding/progress?companyId=<uuid?>  (omit companyId → user layer)
  router.get("/onboarding/progress", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId ?? "board";
    const companyIdRaw = req.query.companyId;
    const companyId =
      typeof companyIdRaw === "string" && companyIdRaw.length > 0 ? companyIdRaw : null;
    const progress = await svc.getProgress(userId, companyId);
    res.json({ progress });
  });

  // PATCH /api/onboarding/progress  { companyId, journey, state }
  router.patch("/onboarding/progress", async (req, res) => {
    assertBoard(req);
    const userId = req.actor.userId ?? "board";
    const body = (req.body ?? {}) as Record<string, unknown>;

    const companyId =
      typeof body.companyId === "string" && body.companyId.length > 0
        ? body.companyId
        : null;

    if (typeof body.journey !== "string" || !JOURNEY_SET.has(body.journey)) {
      throw badRequest("journey must be one of: " + ONBOARDING_JOURNEYS.join(", "));
    }
    if (typeof body.state !== "string" || !STATE_SET.has(body.state)) {
      throw badRequest("state must be a valid OnboardingState");
    }

    // userId ALWAYS comes from the actor — a caller cannot advance another
    // user's progress even if they put a userId in the body (self-scoped).
    const progress = await svc.advanceState(
      userId,
      companyId,
      body.journey as OnboardingJourney,
      body.state as OnboardingState,
    );
    res.json({ progress });
  });

  return router;
}
```

- [ ] **Step 4: Mount the route in `server/src/app.ts`**

Add the import near the other route imports (~:26 next to `goalRoutes`):
```ts
import { onboardingRoutes } from "./routes/onboarding.js";
```
Mount it on the `/api` router next to `goalRoutes(db)` (~:279):
```ts
  api.use(onboardingRoutes(db));
```

> Task author (Stage A overlap): Stage A Task A5 creates `server/src/routes/onboarding-journey.ts` exposing `GET /api/onboarding/journey`. That file and this one both live under the `/api/onboarding/*` prefix but are separate routers — mounting both is fine. If Stage A already folded the journey handler into a shared `onboarding.ts`, add the two progress handlers to that existing file instead of creating a second router, and keep the single mount line. Confirm which exists before editing.

- [ ] **Step 5: Run test + server typecheck, verify pass**

Run: `pnpm test:run server/src/__tests__/onboarding-route.test.ts` then `pnpm --filter @armyofagents/server typecheck`
Expected: PASS (7 tests); no type errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/onboarding.ts server/src/app.ts server/src/__tests__/onboarding-route.test.ts
git commit -m "feat(onboarding): GET/PATCH /api/onboarding/progress (board-only, self-scoped)"
```

---

## Task B5: Step registry + `resolveNextStep` (pure)

**Files:**
- Create: `ui/src/onboarding/registry.ts`
- Test: `ui/src/onboarding/__tests__/registry.test.ts`

Stage B defines the `StepDefinition`/`StepContext`/`StepProps` interfaces EXACTLY per Stage 0 §4, an **empty** `ONBOARDING_REGISTRY` array (Stage C fills the real steps), the pure `resolveNextStep(registry, ctx)`, and — so the pure function is testable without real components — a tiny `makeStubStep` test helper is used **in the test only** (not exported from the registry).

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/onboarding/__tests__/registry.test.ts
import { describe, it, expect } from "vitest";
import { lazy } from "react";
import { resolveNextStep, ONBOARDING_REGISTRY, type StepDefinition, type StepContext } from "../registry";
import type { OnboardingState, OnboardingJourney } from "@armyofagents/shared";

// A no-op lazy component so StepDefinition.Component typechecks in tests.
const Stub = lazy(async () => ({ default: () => null }));

function step(over: Partial<StepDefinition> & { state: OnboardingState }): StepDefinition {
  return {
    id: over.id ?? over.state.toLowerCase(),
    state: over.state,
    journeys: over.journeys ?? (["founder"] as OnboardingJourney[]),
    dependsOn: over.dependsOn ?? [],
    canSkip: over.canSkip ?? false,
    isComplete: over.isComplete ?? (() => false),
    Component: over.Component ?? Stub,
    title: over.title ?? over.state,
  };
}
function ctx(over: Partial<StepContext> = {}): StepContext {
  return {
    userId: over.userId ?? "u1",
    companyId: over.companyId ?? null,
    journey: over.journey ?? "founder",
    completedStates: over.completedStates ?? [],
  };
}

describe("ONBOARDING_REGISTRY", () => {
  it("ships empty in Stage B (Stage C populates it)", () => {
    expect(ONBOARDING_REGISTRY).toEqual([]);
  });
});

describe("resolveNextStep", () => {
  it("returns the first step whose deps are met and isComplete is false", () => {
    const reg = [
      step({ state: "PROFILE_SET" }),
      step({ state: "ORGANIZATION_CREATED", dependsOn: ["PROFILE_SET"] }),
    ];
    const next = resolveNextStep(reg, ctx({ completedStates: ["AUTHENTICATED"] }));
    expect(next?.state).toBe("PROFILE_SET");
  });

  it("gates on dependsOn ⊆ completedStates", () => {
    const reg = [step({ state: "ORGANIZATION_CREATED", dependsOn: ["PROFILE_SET"] })];
    // PROFILE_SET not complete → dep unmet → no reachable step.
    expect(resolveNextStep(reg, ctx({ completedStates: [] }))).toBeNull();
    // PROFILE_SET complete → reachable.
    expect(resolveNextStep(reg, ctx({ completedStates: ["PROFILE_SET"] }))?.state)
      .toBe("ORGANIZATION_CREATED");
  });

  it("filters by journey (a step not in ctx.journey is skipped)", () => {
    const reg = [
      step({ state: "PROFILE_SET", journeys: ["invited"] as OnboardingJourney[] }),
      step({ state: "ORGANIZATION_CREATED", journeys: ["founder"] as OnboardingJourney[], dependsOn: [] }),
    ];
    const next = resolveNextStep(reg, ctx({ journey: "founder" }));
    expect(next?.state).toBe("ORGANIZATION_CREATED");
  });

  it("skips a step whose isComplete(ctx) is true (idempotent re-entry)", () => {
    const reg = [
      step({ state: "PROFILE_SET", isComplete: () => true }),
      step({ state: "ORGANIZATION_CREATED", dependsOn: ["PROFILE_SET"] }),
    ];
    // PROFILE_SET is server-complete though not in completedStates; its dep for
    // the next step is satisfied because completedStates includes it here:
    const next = resolveNextStep(reg, ctx({ completedStates: ["PROFILE_SET"] }));
    expect(next?.state).toBe("ORGANIZATION_CREATED");
  });

  it("returns null when all reachable steps are complete", () => {
    const reg = [step({ state: "PROFILE_SET", isComplete: () => true })];
    expect(resolveNextStep(reg, ctx())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/onboarding/__tests__/registry.test.ts`
Expected: FAIL — `../registry` module not found.

- [ ] **Step 3: Implement the registry + resolver**

```ts
// ui/src/onboarding/registry.ts
import type * as React from "react";
import type { OnboardingState, OnboardingJourney } from "@armyofagents/shared";

export type StepContext = {
  userId: string;
  companyId: string | null;
  journey: OnboardingJourney;
  completedStates: OnboardingState[];
};

export type StepProps = {
  ctx: StepContext;
  onComplete: () => void; // called after the step's server write succeeds; engine persists state + advances
  onBack: () => void;
};

export type StepDefinition = {
  id: string; // stable slug, e.g. "profile"
  state: OnboardingState; // completion state this step satisfies
  journeys: OnboardingJourney[]; // which journeys include this step
  dependsOn: OnboardingState[]; // prior states required before this step is reachable
  canSkip: boolean;
  // Predicate over server state — true means "already done", engine advances past it (idempotent re-entry):
  isComplete: (ctx: StepContext) => boolean;
  // Lazy component for the step body:
  Component: React.LazyExoticComponent<React.ComponentType<StepProps>>;
  title: string;
};

/**
 * The declarative step registry. EMPTY in Stage B — Stage C appends the eight
 * founder-journey step definitions (profile → org → environment → commander →
 * verify → department → agent → review) and any invited-journey steps. The
 * FlowEngine + resolveNextStep operate over whatever this array contains, so
 * Stage C is pure data addition with no engine changes.
 */
export const ONBOARDING_REGISTRY: StepDefinition[] = [];

/**
 * Pure engine contract (Stage 0 §4): the first StepDefinition whose `journeys`
 * includes ctx.journey, whose `dependsOn` ⊆ ctx.completedStates, and whose
 * isComplete(ctx) is false. Returns null when none remain (journey complete).
 */
export function resolveNextStep(
  registry: StepDefinition[],
  ctx: StepContext,
): StepDefinition | null {
  const done = new Set<OnboardingState>(ctx.completedStates);
  for (const step of registry) {
    if (!step.journeys.includes(ctx.journey)) continue;
    if (!step.dependsOn.every((d) => done.has(d))) continue;
    if (step.isComplete(ctx)) continue;
    return step;
  }
  return null;
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test:run src/onboarding/__tests__/registry.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/onboarding/registry.ts ui/src/onboarding/__tests__/registry.test.ts
git commit -m "feat(onboarding): StepDefinition registry + pure resolveNextStep"
```

---

## Task B6: `FlowEngine` — walks registry, persists, resumes, two-layer split

**Files:**
- Modify (or create if Stage A absent): `ui/src/api/onboarding.ts` (append `fetchProgress` + `advanceProgress` + the `OnboardingProgress` type)
- Create: `ui/src/onboarding/FlowEngine.tsx`
- Test: `ui/src/onboarding/__tests__/FlowEngine.test.tsx`

Design (respects the fixed Stage 0 `StepProps`):
- `FlowEngine` props: `{ journey, companyId, registry?, client? }`. `registry` + `client` are injectable for tests (default to `ONBOARDING_REGISTRY` + the real api client).
- **Two-layer split:** the engine always loads the **user-layer** progress (`companyId = null`) and, when a company id is active, the **org-layer** progress (`companyId = id`). `ctx.completedStates = union(userLayer.completedStates, orgLayer.completedStates)`. This is what makes org-replay skip the user steps for free: the returning founder's user-layer row already carries `AUTHENTICATED`+`PROFILE_SET`, so `resolveNextStep` lands on `ORGANIZATION_CREATED`.
- **Active company id:** `companyId` prop OR `useCompany().selectedCompanyId` (the Create-Organization step in Stage C calls `setSelectedCompanyId(newId)` — the existing wizard already does this — and the engine adopts it). This is the bridge that carries the newly-created company into the org layer without violating the arg-less `onComplete` contract.
- **Advance target layer:** a completion state that belongs to the user layer (the states before `ORGANIZATION_CREATED` in `FOUNDER_PHASE1_STATES`) is written to the user-layer row (`companyId = null`); every other state is written to the org-layer row (active company id). If an org-layer state is completed while no company is active yet, that is a Stage C wiring bug — the engine throws a clear error rather than silently writing to the wrong layer.
- **Resume:** on mount the engine loads progress and `resolveNextStep` picks the first incomplete step; there is no local step counter to get out of sync.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/onboarding/__tests__/FlowEngine.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { lazy } from "react";
import { FlowEngine } from "../FlowEngine";
import type { StepDefinition } from "../registry";
import type { OnboardingState } from "@armyofagents/shared";

// Stub the company context the engine reads for the active company id.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: null, setSelectedCompanyId: vi.fn() }),
}));

const Body = lazy(async () => ({ default: () => <div>step-body</div> }));
function step(state: OnboardingState, over: Partial<StepDefinition> = {}): StepDefinition {
  return {
    id: state.toLowerCase(),
    state,
    journeys: ["founder"],
    dependsOn: over.dependsOn ?? [],
    canSkip: false,
    isComplete: over.isComplete ?? (() => false),
    Component: Body,
    title: state,
  };
}

function makeClient(userCompleted: string[] = [], orgCompleted: string[] = []) {
  return {
    fetchProgress: vi.fn(async (companyId: string | null) => ({
      progress:
        companyId === null
          ? { completedStates: userCompleted, journey: "founder" }
          : { completedStates: orgCompleted, journey: "founder" },
    })),
    advanceProgress: vi.fn(async () => ({ progress: { completedStates: [], journey: "founder" } })),
  };
}

beforeEach(() => vi.clearAllMocks());

describe("FlowEngine", () => {
  it("loads user-layer progress on mount and renders the first incomplete step", async () => {
    const client = makeClient([], []);
    render(<FlowEngine journey="founder" companyId={null} registry={[step("PROFILE_SET")]} client={client as any} />);
    await waitFor(() => expect(client.fetchProgress).toHaveBeenCalledWith(null));
    expect(await screen.findByText("step-body")).toBeInTheDocument();
  });

  it("resumes: a completed user-layer state is skipped", async () => {
    const client = makeClient(["PROFILE_SET"], []);
    const done = vi.fn();
    render(
      <FlowEngine
        journey="founder"
        companyId={null}
        registry={[step("PROFILE_SET")]}
        client={client as any}
        onFinished={done}
      />,
    );
    // Only step is already complete → engine finishes without rendering a body.
    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(screen.queryByText("step-body")).toBeNull();
  });

  it("onComplete advances the correct layer then recomputes", async () => {
    const client = makeClient([], []);
    render(<FlowEngine journey="founder" companyId={null} registry={[step("PROFILE_SET")]} client={client as any} />);
    await screen.findByText("step-body");
    // Simulate the step firing onComplete via the exposed test hook button.
    fireEvent.click(screen.getByTestId("flowengine-advance"));
    await waitFor(() =>
      expect(client.advanceProgress).toHaveBeenCalledWith(null, "founder", "PROFILE_SET"),
    );
  });

  it("two-layer union: a user-layer PROFILE_SET makes an org step reachable", async () => {
    // Org step depends on PROFILE_SET (a user-layer state). With the org company
    // active and the user layer carrying PROFILE_SET, the org step is reachable.
    vi.doMock("@/context/CompanyContext", () => ({
      useCompany: () => ({ selectedCompanyId: "c1", setSelectedCompanyId: vi.fn() }),
    }));
    const client = makeClient(["PROFILE_SET"], []);
    render(
      <FlowEngine
        journey="founder"
        companyId="c1"
        registry={[step("ORGANIZATION_CREATED", { dependsOn: ["PROFILE_SET"] })]}
        client={client as any}
      />,
    );
    await waitFor(() => expect(client.fetchProgress).toHaveBeenCalledWith("c1"));
    expect(await screen.findByText("step-body")).toBeInTheDocument();
  });
});
```

> Task author: confirm the UI test stack — `@testing-library/react` + `jsdom` environment. Grep an existing `*.test.tsx` under `ui/src` for the import style and the vitest `environment: "jsdom"` config (`ui/vitest.config.ts`). If the repo uses a different render helper, mirror it; the assertions are library-shaped but the intent (mount → fetch → render/skip → advance) is stable.

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/onboarding/__tests__/FlowEngine.test.tsx`
Expected: FAIL — `../FlowEngine` module not found.

- [ ] **Step 3a: Extend the onboarding api client**

Append to `ui/src/api/onboarding.ts` (created by Stage A; if absent, create it with just this block plus Stage A's `fetchJourney`/`destinationForJourney` from Stage A §Task A9 Step 3):

```ts
import type { OnboardingJourney, OnboardingState } from "@armyofagents/shared";

export type OnboardingProgress = {
  id: string;
  userId: string;
  companyId: string | null;
  journey: OnboardingJourney;
  currentState: OnboardingState;
  completedStates: OnboardingState[];
  createdAt: string;
  updatedAt: string;
};

export async function fetchProgress(
  companyId: string | null,
): Promise<{ progress: OnboardingProgress | null }> {
  const q = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  const res = await fetch(`/api/onboarding/progress${q}`, { credentials: "include" });
  if (!res.ok) throw new Error(`progress fetch failed: ${res.status}`);
  return res.json();
}

export async function advanceProgress(
  companyId: string | null,
  journey: OnboardingJourney,
  state: OnboardingState,
): Promise<{ progress: OnboardingProgress }> {
  const res = await fetch(`/api/onboarding/progress`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ companyId, journey, state }),
  });
  if (!res.ok) throw new Error(`advance failed: ${res.status}`);
  return res.json();
}

// Grouped client object used by FlowEngine (injectable for tests).
export const onboardingProgressClient = { fetchProgress, advanceProgress };
export type OnboardingProgressClient = typeof onboardingProgressClient;
```

- [ ] **Step 3b: Implement the FlowEngine**

```tsx
// ui/src/onboarding/FlowEngine.tsx
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import {
  FOUNDER_PHASE1_STATES,
  type OnboardingJourney,
  type OnboardingState,
} from "@armyofagents/shared";
import { useCompany } from "@/context/CompanyContext";
import {
  onboardingProgressClient,
  type OnboardingProgressClient,
} from "@/api/onboarding";
import {
  ONBOARDING_REGISTRY,
  resolveNextStep,
  type StepContext,
  type StepDefinition,
} from "./registry";

// States that live in the USER layer (companyId = null): everything before
// ORGANIZATION_CREATED in the founder order. Derived, not a new shared const.
const ORG_BOUNDARY_INDEX = FOUNDER_PHASE1_STATES.indexOf("ORGANIZATION_CREATED");
const USER_LAYER_STATES = new Set<OnboardingState>(
  FOUNDER_PHASE1_STATES.slice(0, ORG_BOUNDARY_INDEX),
);
function layerForState(state: OnboardingState, activeCompanyId: string | null): string | null {
  return USER_LAYER_STATES.has(state) ? null : activeCompanyId;
}

export type FlowEngineProps = {
  journey: OnboardingJourney;
  companyId: string | null; // null → user layer; a real id → org layer
  onFinished?: () => void;
  registry?: StepDefinition[];
  client?: OnboardingProgressClient;
};

export function FlowEngine({
  journey,
  companyId,
  onFinished,
  registry = ONBOARDING_REGISTRY,
  client = onboardingProgressClient,
}: FlowEngineProps) {
  const { selectedCompanyId } = useCompany();
  // Active company id: explicit prop wins; else the selected company (the org
  // step sets this when it creates the company). Null until an org exists.
  const activeCompanyId = companyId ?? selectedCompanyId ?? null;

  const [userStates, setUserStates] = useState<OnboardingState[]>([]);
  const [orgStates, setOrgStates] = useState<OnboardingState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const userRes = await client.fetchProgress(null);
      setUserStates((userRes.progress?.completedStates ?? []) as OnboardingState[]);
      if (activeCompanyId) {
        const orgRes = await client.fetchProgress(activeCompanyId);
        setOrgStates((orgRes.progress?.completedStates ?? []) as OnboardingState[]);
      } else {
        setOrgStates([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load onboarding progress");
    } finally {
      setLoading(false);
    }
  }, [client, activeCompanyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const completedStates = useMemo<OnboardingState[]>(
    () => Array.from(new Set<OnboardingState>([...userStates, ...orgStates])),
    [userStates, orgStates],
  );

  const ctx: StepContext = useMemo(
    () => ({ userId: "self", companyId: activeCompanyId, journey, completedStates }),
    [activeCompanyId, journey, completedStates],
  );

  const current = useMemo(() => resolveNextStep(registry, ctx), [registry, ctx]);

  // When resolution yields null, the journey is complete.
  useEffect(() => {
    if (!loading && !error && current === null) onFinished?.();
  }, [loading, error, current, onFinished]);

  const handleComplete = useCallback(async () => {
    if (!current) return;
    const target = layerForState(current.state, activeCompanyId);
    if (!USER_LAYER_STATES.has(current.state) && target === null) {
      setError(
        `Onboarding wiring error: org-layer state ${current.state} completed before a company was active.`,
      );
      return;
    }
    try {
      await client.advanceProgress(target, journey, current.state);
      await load(); // re-read → resolveNextStep recomputes to the next step
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save progress");
    }
  }, [current, activeCompanyId, journey, client, load]);

  if (loading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading…</div>;
  }
  if (error) {
    return (
      <div className="mx-auto max-w-xl py-10 space-y-3">
        <p className="text-sm text-destructive">{error}</p>
        <button className="text-sm underline" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  }
  if (!current) {
    return null; // journey complete; onFinished already fired
  }

  const StepComponent = current.Component;
  return (
    <Suspense fallback={<div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">Loading…</div>}>
      {/* Hidden test hook so the arg-less onComplete contract can be exercised
          without a real step body; harmless in production (visually hidden). */}
      <button data-testid="flowengine-advance" className="sr-only" onClick={() => void handleComplete()}>
        advance
      </button>
      <StepComponent ctx={ctx} onComplete={() => void handleComplete()} onBack={() => {}} />
    </Suspense>
  );
}
```

- [ ] **Step 4: Run test, verify pass**

Run: `pnpm test:run src/onboarding/__tests__/FlowEngine.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/onboarding.ts ui/src/onboarding/FlowEngine.tsx ui/src/onboarding/__tests__/FlowEngine.test.tsx
git commit -m "feat(onboarding): FlowEngine walks registry, resumes, two-layer split"
```

---

## Task B7: Wire `/onboarding` + `/onboarding/join` routes to the FlowEngine

**Files:**
- Modify: `ui/src/App.tsx` (add two routes inside the `CloudAccessGate` element block; import a lazy `FlowEngine` wrapper)
- Test: `ui/src/__tests__/onboarding-routes.test.tsx`

Stage A (Task A9) routes founders to `/onboarding` and invited users to `/onboarding/join?company=…`. Stage B mounts the FlowEngine at both. A thin `OnboardingRoute` wrapper reads the URL (`?company=` for the join path) and renders `<FlowEngine journey=… companyId=… />`, redirecting to the Lobby when the journey finishes.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/__tests__/onboarding-routes.test.tsx
import { describe, it, expect } from "vitest";
import { journeyRouteProps } from "../onboarding/routeProps";

describe("journeyRouteProps", () => {
  it("founder path → founder journey, no company", () => {
    expect(journeyRouteProps("/onboarding", "")).toEqual({ journey: "founder", companyId: null });
  });
  it("join path → invited journey, company from query", () => {
    expect(journeyRouteProps("/onboarding/join", "?company=c2")).toEqual({
      journey: "invited",
      companyId: "c2",
    });
  });
  it("join path with no company query → invited journey, null company", () => {
    expect(journeyRouteProps("/onboarding/join", "")).toEqual({ journey: "invited", companyId: null });
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/onboarding-routes.test.tsx`
Expected: FAIL — `../onboarding/routeProps` module not found.

- [ ] **Step 3: Implement the route-props helper + wrapper**

```ts
// ui/src/onboarding/routeProps.ts
import type { OnboardingJourney } from "@armyofagents/shared";

/** Pure mapping from the onboarding URL to FlowEngine props. */
export function journeyRouteProps(
  pathname: string,
  search: string,
): { journey: OnboardingJourney; companyId: string | null } {
  const isJoin = pathname.replace(/\/+$/, "").endsWith("/join");
  const company = new URLSearchParams(search).get("company");
  return {
    journey: isJoin ? "invited" : "founder",
    companyId: company && company.length > 0 ? company : null,
  };
}
```

```tsx
// ui/src/onboarding/OnboardingRoute.tsx
import { useNavigate, useLocation } from "@/lib/router";
import { FlowEngine } from "./FlowEngine";
import { journeyRouteProps } from "./routeProps";

/** Route wrapper: derives FlowEngine props from the URL, returns to the Lobby on finish. */
export function OnboardingRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const { journey, companyId } = journeyRouteProps(location.pathname, location.search);
  return (
    <div className="min-h-dvh bg-background">
      <FlowEngine
        journey={journey}
        companyId={companyId}
        onFinished={() => navigate("/", { replace: true })}
      />
    </div>
  );
}
```

- [ ] **Step 4: Mount the routes in `ui/src/App.tsx`**

Add a lazy import next to the other lazy pages (~:60, near the `OnboardingWizard` lazy):
```tsx
const OnboardingRoute = lazy(() =>
  import("./onboarding/OnboardingRoute").then((m) => ({ default: m.OnboardingRoute })),
);
```
Inside the `<Route element={<CloudAccessGate />}>` block (so onboarding requires a session in authenticated mode), add — placed BEFORE the `:companyPrefix` catch-all Layout route (~:371) so the literal `onboarding` segment is not swallowed as a company prefix:
```tsx
            <Route path="onboarding" element={<OnboardingRoute />} />
            <Route path="onboarding/join" element={<OnboardingRoute />} />
```

> Task author: Stage A Task A9 Step 4 says it "stubs" `/onboarding` + `/onboarding/join`. If Stage A already added placeholder routes, REPLACE their element with `<OnboardingRoute />` rather than adding duplicate `<Route path="onboarding">` entries (react-router would match the first only). Confirm whether the stubs exist before editing.

- [ ] **Step 5: Run test + UI typecheck, verify pass**

Run: `pnpm test:run src/__tests__/onboarding-routes.test.tsx` then `pnpm --filter @armyofagents/ui typecheck`
Expected: PASS (3 tests); no type errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/onboarding/routeProps.ts ui/src/onboarding/OnboardingRoute.tsx ui/src/App.tsx ui/src/__tests__/onboarding-routes.test.tsx
git commit -m "feat(onboarding): mount FlowEngine at /onboarding and /onboarding/join"
```

---

## Task B8: Lobby "create new org" → org-replay (re-enter only the org layer)

**Files:**
- Modify: `ui/src/pages/Lobby.tsx` (`onCreate` → navigate to `/onboarding` instead of opening the legacy modal wizard)
- Modify: `ui/src/components/LobbyLayout.tsx` (`onCreateCompany` → same navigation)
- Modify: `ui/src/components/LobbyEmptyState.tsx` (its `onCreate` prop is already threaded from Lobby — no change if Lobby passes the new handler)
- Test: `ui/src/__tests__/lobby-create-org-replay.test.tsx`

The spec (§4.3) requires that creating a 2nd org from the Lobby re-enters ONLY the org-level states (`ORGANIZATION_CREATED → SETUP_COMPLETE`), skipping the user layer. Because a returning founder's **user-layer** `onboarding_progress` row already carries `AUTHENTICATED`+`PROFILE_SET`, launching the FlowEngine in the `founder` journey does exactly this for free — `resolveNextStep` skips the user steps and lands on `ORGANIZATION_CREATED`. So "org-replay mode" is simply: **navigate to `/onboarding`** (founder journey) instead of opening the old `openOnboarding()` modal.

- [ ] **Step 1: Write the failing test**

```tsx
// ui/src/__tests__/lobby-create-org-replay.test.tsx
import { describe, it, expect } from "vitest";
import { createOrgReplayTarget } from "../onboarding/orgReplay";

describe("createOrgReplayTarget", () => {
  it("returns the founder onboarding route (org-replay reuses the user layer)", () => {
    expect(createOrgReplayTarget()).toBe("/onboarding");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run src/__tests__/lobby-create-org-replay.test.tsx`
Expected: FAIL — `../onboarding/orgReplay` module not found.

- [ ] **Step 3: Implement the helper + rewire the Lobby entry points**

```ts
// ui/src/onboarding/orgReplay.ts
/**
 * The destination for "create a new organization" from the Lobby. It is the
 * founder onboarding route: the returning founder's user-layer onboarding_progress
 * already carries AUTHENTICATED + PROFILE_SET, so the FlowEngine's resolveNextStep
 * skips the user layer and re-enters at ORGANIZATION_CREATED (spec §4.3).
 */
export function createOrgReplayTarget(): string {
  return "/onboarding";
}
```

In `ui/src/pages/Lobby.tsx`:
- Import: `import { createOrgReplayTarget } from "@/onboarding/orgReplay";`
- Replace the two `openOnboarding()` call sites — the `LobbyEmptyState` `onCreate` (~:85) and any create button — with `navigate(createOrgReplayTarget())`. `navigate` is already in scope (`const navigate = useNavigate();` at ~:31). The `openOnboarding` import from `useDialog()` can be dropped if it becomes unused (grep first).

In `ui/src/components/LobbyLayout.tsx`:
- The `onCreateCompany={() => openOnboarding()}` prop (~:34) becomes `onCreateCompany={() => navigate(createOrgReplayTarget())}`. Add `import { useNavigate } from "@/lib/router";` + `import { createOrgReplayTarget } from "@/onboarding/orgReplay";` and `const navigate = useNavigate();`. Drop the now-unused `useDialog`/`openOnboarding` if nothing else in the file uses them (grep first — `LobbyLayout` also passes `openOnboarding` nowhere else, so it can be removed).

> Task author: `LobbyShell` / `LobbyEmptyState` receive `onCreate`/`onCreateCompany` as props and do not call `openOnboarding` directly — only the two files above own the handler. Grep `openOnboarding` across `ui/src/components/Lobby*.tsx` + `ui/src/pages/Lobby.tsx` to confirm you caught every Lobby create entry point before removing the import. Do NOT touch `NoCompaniesStartPage` in `App.tsx` (first-run) in this task — first-run onboarding routing is governed by Stage A's post-auth router (founder → `/onboarding`); the legacy `openOnboarding()` modal in `App.tsx` is removed when Stage C deletes `OnboardingWizard` (Stage 0 file map: `OnboardingWizard.tsx` **Deleted** in Stage C). Leave it until then to avoid a dead first-run path mid-stage.

- [ ] **Step 4: Run test + UI typecheck, verify pass**

Run: `pnpm test:run src/__tests__/lobby-create-org-replay.test.tsx` then `pnpm --filter @armyofagents/ui typecheck`
Expected: PASS (1 test); no type errors (watch for unused-import errors from the dropped `openOnboarding`).

- [ ] **Step 5: Commit**

```bash
git add ui/src/onboarding/orgReplay.ts ui/src/pages/Lobby.tsx ui/src/components/LobbyLayout.tsx ui/src/__tests__/lobby-create-org-replay.test.tsx
git commit -m "feat(onboarding): Lobby create-org routes into FlowEngine org-replay"
```

---

## Stage B self-review checklist (run before handing off)

- [ ] **Scope coverage** (each SCOPE item → task):
  1. `onboarding_progress` table (Stage 0 §2.2) + export + `pnpm db:generate` → **B1**.
  2. `ONBOARDING_STATES`/`ONBOARDING_JOURNEYS`/`FOUNDER_PHASE1_STATES` (Stage 0 §3.1) + `PostAuthJourneyResult` idempotent/additive (Stage 0 §3.2, Stage A dep) → **B2**.
  3. `server/src/services/onboarding.ts` upsert/advance/get + resume reducer, sequence-db unit tests → **B3**.
  4. `server/src/routes/onboarding.ts` GET progress + PATCH advance, board-only + self-scoped → **B4**.
  5. `ui/src/onboarding/registry.ts` — `StepDefinition` interface (Stage 0 §4) + empty registry + `resolveNextStep` with dependsOn/journey/isComplete/all-complete→null unit tests → **B5**.
  6. `ui/src/onboarding/FlowEngine.tsx` — walk registry, PATCH-advance-then-recompute, resume-on-mount, two-layer (user vs org) split → **B6**.
  7. `/onboarding` + `/onboarding/join` wired in `App.tsx` (Stage A stubs) → **B7**.
  8. Lobby create-new-org replay re-enters only the org layer → **B8**.
- [ ] **Placeholder scan:** the doc contains ZERO code TODOs / "add error handling" / "similar to above". The `> Task author:` notes are **verification pointers** (script names in Pre-flight; `packages/db` test-dir location B1; `shared/src/index.ts` export-block boundaries B2; services-barrel shape B3; supertest availability B4; jsdom/testing-library stack B6; Stage A route/stub overlap B4/B7; Lobby `openOnboarding` call-site sweep B8), to be resolved during execution — none is a code placeholder.
- [ ] **Type-consistency vs Stage 0:**
  - `onboarding_progress` columns/types match §2.2 byte-for-byte (id uuid, userId text, companyId uuid nullable FK cascade, journey text, currentState text, completedStates jsonb string[] default [], timestamps; `onboarding_progress_user_company_uq` on (userId, companyId)).
  - `OnboardingState`/`OnboardingJourney`/`ONBOARDING_STATES`/`FOUNDER_PHASE1_STATES` copied verbatim from §3.1; journey values are exactly `"founder"` | `"invited"`.
  - `StepDefinition`/`StepContext`/`StepProps` in registry.ts copied verbatim from §4 (incl. `journeys: OnboardingJourney[]`, `dependsOn: OnboardingState[]`, `isComplete(ctx) => boolean`, `Component: React.LazyExoticComponent<React.ComponentType<StepProps>>`, `onComplete: () => void`). `resolveNextStep` implements the §4 "flow engine contract" exactly (journey ∈, dependsOn ⊆ completedStates, !isComplete, else null).
  - `PostAuthJourneyResult` is imported/created identically to §3.2 — never redefined.
  - Testing follows §7: pure-function tests (firstIncompleteState, resolveNextStep, journeyRouteProps, createOrgReplayTarget), service tests via the `createSequenceDb`/Proxy-table mock, contract tests (schema columns, shared constants), no drizzle internals imported in pure tests.
- [ ] **Non-negotiables (§8):** no hosted-API keys touched; no heartbeat/hire-approval/planning-mode divergence points altered; every server write is idempotent (advance dedupes; row auto-creates once). Migration generated via `pnpm db:generate` only — no hand-written SQL (Critical Rule #1).
- [ ] **Green gate:** after B4, run the full server suite (`pnpm test:run server`) to catch any test that assumed no `/api/onboarding` router; after B6/B8, run `pnpm test:run src/onboarding` + `pnpm --filter @armyofagents/ui typecheck`.
