# P5 · Autonomy + Trust Promotion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. See `2026-07-30-memory-enterprise-overview.md` for the full suite and shared conventions, and `2026-07-30-memory-enterprise-real-run-acceptance.md` for the live acceptance scenarios (this phase gates **X1** and **X4**).

**Goal:** Make the risk-tiered autonomy engine actually govern memory writes. Every write path resolves an effective autonomy level (department override else company default, from `memory_settings`), runs the tier through `resolveWriteDisposition`, and honours the verdict — `auto` lands `approved`, `propose`/`human` stay `pending`. On top of that, a **trust-promotion** policy lets a founder promote a proven (agent × memory-class × scope) so its durable writes auto-approve for a trusted agent — with `protected` classes never eligible.

**Architecture:** P0 already shipped the pure policy (`memory-tier-policy.ts`: `tierForItem`, `resolveWriteDisposition(tier, level, {classPromoted})`, and the `MemoryTier`/`AutonomyLevel`/`WriteDisposition` types). P1 shipped `memory_settings` (company default + nullable-`departmentId` override row, `autonomyLevel`) and the Settings → Memory scaffold. This phase adds:
1. one additive table — `memory_class_promotions` (the founder's promote/demote decisions);
2. a pure eligibility policy (`≥20 reviewed items AND ≥90% approved-without-edit`, reusing the trust-score convention + `agent_trust_scores` as a corroborating signal);
3. one small gate module — `memory-autonomy.ts` (`resolveEffectiveAutonomy` + `gateMemoryWrite` + `applyWriteGate`) that composes settings + tier-policy + promotion;
4. a **uniform, minimal wiring**: every write path already inserts as `pending` (the safe default, untouched); each caller then calls `applyWriteGate`, which auto-approves via the existing `memoryService.approve()` **only** when the tier gate says `auto`. This is the exact pattern `memory.retain` PATH 1 already uses, generalised and driven by the tier policy instead of a hardcoded `isPersonalScope`. **No change to `memoryService.create`'s agent→pending default** — auto is always an explicit, gated, post-insert `approve()`.

**Tech Stack:** Drizzle ORM (`packages/db`), Express 5 (`server/src`), React + Vite + Tailwind (`ui/src`), Vitest + testing-library, embedded-Postgres for integration.

**Dependencies (must be merged before P5 executes — enforced by suite order):**
- **P0** — `server/src/services/memory-tier-policy.ts` (the pure policy this phase drives).
- **P1** — the `memory_settings` table (`companyId`, nullable `departmentId`, `autonomyLevel`) and `ui/src/components/settings/sections/MemorySettingsSection.tsx` (this phase mounts the promotion panel inside it). If P1 named the table/column differently, adjust the imports in Task 3/Task 5 — the shape assumed here is the one in the overview.
- **P3 / P4** — the Run-Miner writer (`provenance_kind='run'`) and Guardian consolidation writer. Task 4 wires the gate into them; if a writer is not yet present when P5 runs, its checkbox is a no-op to be completed when that writer lands (the gate module is the stable contract).

**Scope note:** `memory_settings` and `MemorySettingsSection.tsx` are **not** created here (P1 owns them). Working-memory (`ephemeral`) auto-approve is the one intentional default-behaviour delta introduced by the gate — see the Self-review.

---

### Task 1: `memory_class_promotions` table (additive schema + migration)

**Store decision (justified):** a **new table** `memory_class_promotions`, not a reuse.
- `hub_autopilot_policies` is **company-level inbox-item** rules (one row per company, `semanticType`→action). Wrong grain and wrong domain.
- `memory_settings` (P1) is the **autonomy dial** per company/department. It has no agent or class dimension.
- `agent_trust_scores` is the raw **signal** (per agent, task-review approval) — it is *read* by the eligibility policy, not the place to record a promotion decision.
- The promotion grain is **(company × agent × memory-class × scope)** with a demotable lifecycle (`promoted`/`demoted`) and an audit pointer (who/when). No existing table carries that composite key. A dedicated table sits beside `agent_trust_scores` as a sibling agent-scoped table, keeps promotions auditable and reversible, and answers the `classPromoted` lookup in one indexed read. Additive + nullable-safe → non-breaking.

**Files:**
- Create: `packages/db/src/schema/memory_class_promotions.ts`
- Modify: `packages/db/src/schema/index.ts` (add the `export * from "./memory_class_promotions.js";` line beside the other schema exports)
- Generated: `packages/db/src/migrations/<next>_*.sql` (name + number auto-assigned by drizzle; ≈`0193+` once P1–P4 have landed their migrations)

- [ ] **Step 1: Write the schema** (mirrors `packages/db/src/schema/agent_trust_scores.ts` exactly)

Create `packages/db/src/schema/memory_class_promotions.ts`:

```ts
import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { projects } from "./projects.js";

/**
 * Trust-promotion decisions (enterprise memory model, P5).
 *
 * One row per (company × agent × memoryClass × scope) the founder has acted on.
 * `memoryClass` is a memory LAYER (only durable-tier layers — "domain",
 * "active_context" — are ever promotable; identity is protected and rejected at
 * the route). `scopeDepartmentId` NULL = company-wide scope. `status='promoted'`
 * makes `resolveWriteDisposition(durable, trusted, {classPromoted:true})` → auto
 * for a trusted agent; `status='demoted'` reverts to the tier default.
 */
export const memoryClassPromotions = pgTable(
  "memory_class_promotions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // Memory layer, e.g. "domain" | "active_context". Never "identity" (protected).
    memoryClass: text("memory_class").notNull(),
    // NULL = company-wide scope; else a department (projects.type='department').
    scopeDepartmentId: uuid("scope_department_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    status: text("status").notNull().default("promoted"), // "promoted" | "demoted"
    // Founder who made the decision (from the route actor). No FK — matches the
    // freeform actor-id convention used elsewhere (e.g. memory_items.createdBy).
    promotedByUserId: uuid("promoted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("memory_class_promotions_company_idx").on(table.companyId),
    agentIdx: index("memory_class_promotions_agent_idx").on(table.agentId),
    // Fast lookup for the gate. NOTE: Postgres treats NULLs as DISTINCT in a
    // unique index, so a company-wide (NULL-scope) promotion is NOT deduped by
    // this constraint — `setPromotion` (Task 2) does an explicit select-then-
    // upsert so both NULL and non-NULL scopes stay single-rowed.
    lookupIdx: index("memory_class_promotions_lookup_idx").on(
      table.companyId,
      table.agentId,
      table.memoryClass,
      table.scopeDepartmentId,
    ),
  }),
);
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `packages/db/src/migrations/<next>_*.sql` containing a single `CREATE TABLE "memory_class_promotions" (...)` with the two `CREATE INDEX` statements, plus an updated `meta/` snapshot. No `ALTER`/`DROP` of any existing table.

- [ ] **Step 3: Verify additive-only**

Run: `git diff --stat packages/db/src/migrations`
Expected: one new `.sql` + updated `meta/`. Open the `.sql` and confirm it is only `CREATE TABLE` + `CREATE INDEX` (no change to any other table).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter ./db typecheck`
Expected: PASS (exit 0).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/memory_class_promotions.ts packages/db/src/schema/index.ts packages/db/src/migrations
git commit -m "feat(memory): memory_class_promotions table for trust promotion (P5)"
```

---

### Task 2: Promotion-eligibility policy + store reads

**Files:**
- Create: `server/src/services/memory-promotion.ts`
- Test: `server/src/__tests__/memory-promotion.test.ts`

- [ ] **Step 1: Write the failing unit test** (pure eligibility fn — the thresholds; `makeTableProxy` mocks the db import so the module loads)

Create `server/src/__tests__/memory-promotion.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  memoryItems: makeTableProxy("memory_items"),
  memoryClassPromotions: makeTableProxy("memory_class_promotions"),
  activityLog: makeTableProxy("activity_log"),
  agentTrustScores: makeTableProxy("agent_trust_scores"),
  agents: makeTableProxy("agents"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
  evaluatePromotionEligibility,
  isPromotableClass,
  PROMOTION_MIN_REVIEWED,
  PROMOTION_MIN_APPROVAL_RATE,
} from "../services/memory-promotion.js";

describe("evaluatePromotionEligibility", () => {
  it("requires BOTH ≥20 reviewed AND ≥90% approved-without-edit", () => {
    expect(evaluatePromotionEligibility({ reviewedCount: 20, approvedWithoutEditCount: 18 }).eligible).toBe(true); // 90%
    expect(evaluatePromotionEligibility({ reviewedCount: 20, approvedWithoutEditCount: 17 }).eligible).toBe(false); // 85%
    expect(evaluatePromotionEligibility({ reviewedCount: 19, approvedWithoutEditCount: 19 }).eligible).toBe(false); // <20
    expect(evaluatePromotionEligibility({ reviewedCount: 100, approvedWithoutEditCount: 95 }).eligible).toBe(true); // 95%
  });

  it("reports the approval rate as an integer-friendly percent and never divides by zero", () => {
    expect(evaluatePromotionEligibility({ reviewedCount: 0, approvedWithoutEditCount: 0 })).toEqual({
      eligible: false,
      approvalRate: 0,
      reviewedCount: 0,
    });
    expect(evaluatePromotionEligibility({ reviewedCount: 40, approvedWithoutEditCount: 36 }).approvalRate).toBe(90);
  });

  it("thresholds match the trust-score convention (percent scale)", () => {
    expect(PROMOTION_MIN_REVIEWED).toBe(20);
    expect(PROMOTION_MIN_APPROVAL_RATE).toBe(90);
  });
});

describe("isPromotableClass", () => {
  it("only durable-tier layers are promotable; protected + ephemeral are not", () => {
    expect(isPromotableClass("domain")).toBe(true);
    expect(isPromotableClass("active_context")).toBe(true);
    expect(isPromotableClass("identity")).toBe(false); // protected → never
    expect(isPromotableClass("working")).toBe(false); // ephemeral → auto anyway
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-promotion.test.ts`
Expected: FAIL — `Cannot find module '../services/memory-promotion.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/services/memory-promotion.ts`:

```ts
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { memoryItems, memoryClassPromotions, activityLog } from "@armyofagents/db";
import { tierForItem } from "./memory-tier-policy.js";
import { trustScoreService } from "./trust-scores.js";

/** Reuse the trust-score convention: last-window volume + percent approval scale. */
export const PROMOTION_MIN_REVIEWED = 20;
export const PROMOTION_MIN_APPROVAL_RATE = 90; // percent, matches agent_trust_scores.currentScore
/** Durable-tier layers are the only promotable classes (identity=protected, working=ephemeral). */
export const PROMOTABLE_CLASSES: readonly string[] = ["domain", "active_context"];

export interface PromotionStats {
  reviewedCount: number;
  approvedWithoutEditCount: number;
}
export interface PromotionEligibility {
  eligible: boolean;
  approvalRate: number; // percent
  reviewedCount: number;
}

/** Pure eligibility predicate. ≥20 reviewed AND ≥90% approved-without-edit. */
export function evaluatePromotionEligibility(stats: PromotionStats): PromotionEligibility {
  const { reviewedCount, approvedWithoutEditCount } = stats;
  const approvalRate = reviewedCount > 0 ? (approvedWithoutEditCount / reviewedCount) * 100 : 0;
  const eligible =
    reviewedCount >= PROMOTION_MIN_REVIEWED && approvalRate >= PROMOTION_MIN_APPROVAL_RATE;
  return { eligible, approvalRate, reviewedCount };
}

/** A memory class (layer) is promotable only if its tier is durable. */
export function isPromotableClass(memoryClass: string): boolean {
  return tierForItem({ layer: memoryClass }) === "durable";
}

/** Is this (agent × class × scope) currently promoted? Latest decision wins. */
export async function isClassPromoted(
  db: Db,
  companyId: string,
  agentId: string,
  memoryClass: string,
  scopeDepartmentId: string | null,
): Promise<boolean> {
  const rows = await db
    .select({ status: memoryClassPromotions.status })
    .from(memoryClassPromotions)
    .where(
      and(
        eq(memoryClassPromotions.companyId, companyId),
        eq(memoryClassPromotions.agentId, agentId),
        eq(memoryClassPromotions.memoryClass, memoryClass),
        scopeDepartmentId
          ? eq(memoryClassPromotions.scopeDepartmentId, scopeDepartmentId)
          : isNull(memoryClassPromotions.scopeDepartmentId),
      ),
    )
    .orderBy(memoryClassPromotions.updatedAt)
    .limit(1);
  return rows[rows.length - 1]?.status === "promoted";
}

/**
 * Per-(agent × class × scope) memory-review stats.
 *
 * `reviewedCount`  = the agent's own proposals in this class+scope that the
 *                    founder acted on (status approved | rejected).
 * `approvedWithoutEditCount` = approved ones with NO founder content-edit logged.
 *
 * Signal source (see plan's flagged uncertainty): "edited before approve" is
 * detected via the activity log, mirroring memory-feedback.ts's use of
 * activity_log `*.updated` rows. The action string below must match what the
 * memory PATCH route logs on a content edit — confirm it; the integration test
 * seeds approved items with NO activity rows, so it is robust to the string.
 */
export async function getClassApprovalStats(
  db: Db,
  companyId: string,
  agentId: string,
  memoryClass: string,
  scopeDepartmentId: string | null,
): Promise<PromotionStats> {
  const deptCond = scopeDepartmentId
    ? eq(memoryItems.departmentId, scopeDepartmentId)
    : isNull(memoryItems.departmentId);
  const reviewed = await db
    .select({ id: memoryItems.id, status: memoryItems.status })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.companyId, companyId),
        eq(memoryItems.createdBy, agentId), // agent-authored items set createdBy=agentId
        eq(memoryItems.source, "agent"),
        eq(memoryItems.layer, memoryClass),
        deptCond,
        inArray(memoryItems.status, ["approved", "rejected"]),
      ),
    );
  const reviewedCount = reviewed.length;
  const approvedIds = reviewed.filter((r) => r.status === "approved").map((r) => r.id);
  if (approvedIds.length === 0) return { reviewedCount, approvedWithoutEditCount: 0 };
  const edited = await db
    .select({ entityId: activityLog.entityId })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "memory_item"),
        eq(activityLog.action, "memory.updated"),
        inArray(activityLog.entityId, approvedIds),
      ),
    );
  const editedSet = new Set(edited.map((e) => e.entityId));
  const approvedWithoutEditCount = approvedIds.filter((id) => !editedSet.has(id)).length;
  return { reviewedCount, approvedWithoutEditCount };
}

export interface PromotionCandidate {
  agentId: string;
  memoryClass: string;
  scopeDepartmentId: string | null;
  reviewedCount: number;
  approvalRate: number;
  eligible: boolean;
  promoted: boolean;
}

/**
 * Eligible + already-promoted (agent × class × scope) rows for the panel.
 * Reuses trust-scores as a corroborating signal: eligibility requires the pure
 * predicate AND the agent's overall trust currentScore ≥ threshold (a broadly
 * trusted agent with a strong per-class record).
 */
export async function listPromotionCandidates(
  db: Db,
  companyId: string,
): Promise<PromotionCandidate[]> {
  const groups = await db
    .selectDistinct({
      agentId: memoryItems.createdBy,
      memoryClass: memoryItems.layer,
      scopeDepartmentId: memoryItems.departmentId,
    })
    .from(memoryItems)
    .where(
      and(
        eq(memoryItems.companyId, companyId),
        eq(memoryItems.source, "agent"),
        inArray(memoryItems.layer, [...PROMOTABLE_CLASSES]),
        inArray(memoryItems.status, ["approved", "rejected"]),
      ),
    );
  const trust = trustScoreService(db);
  const out: PromotionCandidate[] = [];
  for (const g of groups) {
    const memoryClass = g.memoryClass;
    const agentId = g.agentId;
    if (!memoryClass || !agentId || !isPromotableClass(memoryClass)) continue;
    const stats = await getClassApprovalStats(db, companyId, agentId, memoryClass, g.scopeDepartmentId);
    const elig = evaluatePromotionEligibility(stats);
    const promoted = await isClassPromoted(db, companyId, agentId, memoryClass, g.scopeDepartmentId);
    // Corroborating trust-score gate (reuse trust-scores signals).
    const score = await trust.getScore(companyId, agentId);
    const trustOk = (score?.currentScore ?? 0) >= PROMOTION_MIN_APPROVAL_RATE;
    if ((elig.eligible && trustOk) || promoted) {
      out.push({
        agentId,
        memoryClass,
        scopeDepartmentId: g.scopeDepartmentId,
        reviewedCount: elig.reviewedCount,
        approvalRate: elig.approvalRate,
        eligible: elig.eligible && trustOk,
        promoted,
      });
    }
  }
  return out;
}

/**
 * Record a founder promote/demote decision (explicit select-then-upsert so a
 * NULL scope stays single-rowed — see the schema note). Rejects protected /
 * ephemeral classes: only durable layers are ever promotable.
 */
export async function setPromotion(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    memoryClass: string;
    scopeDepartmentId: string | null;
    status: "promoted" | "demoted";
    promotedByUserId: string | null;
  },
): Promise<{ id: string; status: string }> {
  if (!isPromotableClass(input.memoryClass)) {
    throw new Error(`memory class "${input.memoryClass}" is not promotable (protected/ephemeral)`);
  }
  const scopeCond = input.scopeDepartmentId
    ? eq(memoryClassPromotions.scopeDepartmentId, input.scopeDepartmentId)
    : isNull(memoryClassPromotions.scopeDepartmentId);
  const [existing] = await db
    .select({ id: memoryClassPromotions.id })
    .from(memoryClassPromotions)
    .where(
      and(
        eq(memoryClassPromotions.companyId, input.companyId),
        eq(memoryClassPromotions.agentId, input.agentId),
        eq(memoryClassPromotions.memoryClass, input.memoryClass),
        scopeCond,
      ),
    )
    .limit(1);
  if (existing) {
    const [row] = await db
      .update(memoryClassPromotions)
      .set({ status: input.status, promotedByUserId: input.promotedByUserId, updatedAt: new Date() })
      .where(eq(memoryClassPromotions.id, existing.id))
      .returning({ id: memoryClassPromotions.id, status: memoryClassPromotions.status });
    return row;
  }
  const [row] = await db
    .insert(memoryClassPromotions)
    .values({
      companyId: input.companyId,
      agentId: input.agentId,
      memoryClass: input.memoryClass,
      scopeDepartmentId: input.scopeDepartmentId,
      status: input.status,
      promotedByUserId: input.promotedByUserId,
    })
    .returning({ id: memoryClassPromotions.id, status: memoryClassPromotions.status });
  return row;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-promotion.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/memory-promotion.ts server/src/__tests__/memory-promotion.test.ts
git commit -m "feat(memory): trust-promotion eligibility policy + store reads (P5)"
```

---

### Task 3: Autonomy gate — `memory-autonomy.ts`

**Files:**
- Create: `server/src/services/memory-autonomy.ts`
- Test: `server/src/__tests__/memory-autonomy.test.ts`

- [ ] **Step 1: Write the failing unit test** (sequence-mock db; asserts settings resolution + gate composition)

Create `server/src/__tests__/memory-autonomy.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { makeTableProxy, drizzleOperatorStubs } from "./helpers/drizzle-mock.js";

vi.mock("@armyofagents/db", () => ({
  memorySettings: makeTableProxy("memory_settings"),
  memoryClassPromotions: makeTableProxy("memory_class_promotions"),
  memoryItems: makeTableProxy("memory_items"),
  activityLog: makeTableProxy("activity_log"),
  agentTrustScores: makeTableProxy("agent_trust_scores"),
  agents: makeTableProxy("agents"),
}));
vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { gateMemoryWrite, DEFAULT_AUTONOMY_LEVEL } from "../services/memory-autonomy.js";

/** Minimal sequence-mock: each select() returns the next queued rows array. */
function seqDb(selects: Record<string, unknown>[][]) {
  let i = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit"]) {
    (chain as Record<string, (...a: unknown[]) => unknown>)[m] = () => chain;
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(selects[i++] ?? []);
  return { select: () => chain, selectDistinct: () => chain } as unknown as any;
}

describe("gateMemoryWrite", () => {
  it("founder source is always auto/approved (unchanged behaviour)", async () => {
    const res = await gateMemoryWrite(seqDb([]), "co1", { layer: "domain", source: "founder" });
    expect(res).toMatchObject({ disposition: "auto", status: "approved" });
  });

  it("supervised (default) + durable → propose → pending", async () => {
    // [dept override: none] then [company row: none] → DEFAULT (supervised)
    const db = seqDb([[], []]);
    const res = await gateMemoryWrite(db, "co1", {
      layer: "domain",
      departmentId: "deptA",
      agentId: "ag1",
      source: "agent",
    });
    expect(DEFAULT_AUTONOMY_LEVEL).toBe("supervised");
    expect(res).toMatchObject({ tier: "durable", level: "supervised", classPromoted: false, disposition: "propose", status: "pending" });
  });

  it("trusted + durable + promoted → auto → approved", async () => {
    // [dept override: trusted] then [promotion lookup: promoted]
    const db = seqDb([[{ level: "trusted" }], [{ status: "promoted" }]]);
    const res = await gateMemoryWrite(db, "co1", {
      layer: "domain",
      departmentId: "deptA",
      agentId: "ag1",
      source: "agent",
    });
    expect(res).toMatchObject({ level: "trusted", classPromoted: true, disposition: "auto", status: "approved" });
  });

  it("protected (identity) stays human/pending even at policy", async () => {
    const db = seqDb([[], [{ level: "policy" }]]); // no dept override, company=policy
    const res = await gateMemoryWrite(db, "co1", { layer: "identity", agentId: "ag1", source: "agent" });
    expect(res).toMatchObject({ tier: "protected", disposition: "human", status: "pending" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-autonomy.test.ts`
Expected: FAIL — `Cannot find module '../services/memory-autonomy.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/services/memory-autonomy.ts`:

```ts
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { memorySettings } from "@armyofagents/db";
import {
  tierForItem,
  resolveWriteDisposition,
  type AutonomyLevel,
  type MemoryTier,
  type WriteDisposition,
} from "./memory-tier-policy.js";
import { isClassPromoted, isPromotableClass } from "./memory-promotion.js";
import { memoryService } from "./memory.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "memory-autonomy" });

/**
 * Default when a company has set no dial. `supervised` (durable → propose →
 * pending) preserves today's "agent writes land pending for founder review"
 * behaviour and is the baseline the X1 acceptance scenario sets explicitly.
 */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = "supervised";
const VALID_LEVELS: readonly string[] = ["manual", "supervised", "trusted", "policy"];

function normalizeLevel(value: string | null | undefined): AutonomyLevel {
  return value && VALID_LEVELS.includes(value) ? (value as AutonomyLevel) : DEFAULT_AUTONOMY_LEVEL;
}

/** Effective autonomy: department override wins, else company default, else DEFAULT. */
export async function resolveEffectiveAutonomy(
  db: Db,
  companyId: string,
  departmentId?: string | null,
): Promise<AutonomyLevel> {
  if (departmentId) {
    const [dept] = await db
      .select({ level: memorySettings.autonomyLevel })
      .from(memorySettings)
      .where(and(eq(memorySettings.companyId, companyId), eq(memorySettings.departmentId, departmentId)))
      .limit(1);
    if (dept?.level) return normalizeLevel(dept.level);
  }
  const [company] = await db
    .select({ level: memorySettings.autonomyLevel })
    .from(memorySettings)
    .where(and(eq(memorySettings.companyId, companyId), isNull(memorySettings.departmentId)))
    .limit(1);
  return normalizeLevel(company?.level ?? null);
}

export interface GateInput {
  layer: string | null;
  tier?: string | null;
  departmentId?: string | null;
  agentId?: string | null;
  source?: string | null;
}
export interface GateResult {
  tier: MemoryTier;
  level: AutonomyLevel;
  classPromoted: boolean;
  disposition: WriteDisposition;
  status: "approved" | "pending";
}

/** Resolve the write disposition for a memory item under the tier-autonomy engine. */
export async function gateMemoryWrite(
  db: Db,
  companyId: string,
  input: GateInput,
): Promise<GateResult> {
  const tier = tierForItem({ layer: input.layer, tier: input.tier });
  // Founder authorship stays auto-approved — unchanged from memoryService.create.
  if (input.source === "founder") {
    return { tier, level: "policy", classPromoted: false, disposition: "auto", status: "approved" };
  }
  const level = await resolveEffectiveAutonomy(db, companyId, input.departmentId ?? null);
  const memoryClass = input.layer ?? "";
  const classPromoted =
    input.agentId != null && isPromotableClass(memoryClass)
      ? await isClassPromoted(db, companyId, input.agentId, memoryClass, input.departmentId ?? null)
      : false;
  const disposition = resolveWriteDisposition(tier, level, { classPromoted });
  return { tier, level, classPromoted, disposition, status: disposition === "auto" ? "approved" : "pending" };
}

/**
 * Apply the gate to an ALREADY-created (pending) item. Auto-approves via the
 * existing `memoryService.approve` ONLY when the tier gate says `auto`. This is
 * the sole mechanism that moves a write to `approved`; `memoryService.create`'s
 * agent→pending default is never touched, so an ungated write stays pending
 * (safe). Best-effort: an approve failure leaves the item pending.
 */
export async function applyWriteGate(
  db: Db,
  companyId: string,
  item: { id: string; layer: string | null; departmentId?: string | null; tier?: string | null },
  opts: { agentId?: string | null; source?: string | null } = {},
): Promise<GateResult> {
  const gate = await gateMemoryWrite(db, companyId, {
    layer: item.layer,
    tier: item.tier ?? null,
    departmentId: item.departmentId ?? null,
    agentId: opts.agentId ?? null,
    source: opts.source ?? null,
  });
  if (gate.disposition === "auto") {
    try {
      await memoryService(db).approve(companyId, item.id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ itemId: item.id, companyId, err: msg }, "applyWriteGate: auto-approve failed (left pending)");
      return { ...gate, status: "pending" };
    }
  }
  return gate;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-autonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter ./server typecheck`
Expected: PASS.

```bash
git add server/src/services/memory-autonomy.ts server/src/__tests__/memory-autonomy.test.ts
git commit -m "feat(memory): autonomy gate — resolve effective level + apply write disposition (P5)"
```

---

### Task 4: Wire the gate into every write path (integration-gated)

**Files (all Modify):**
- `server/src/services/internal-agent/tools/memory-write.ts` — crew `write_memory`
- `server/src/mcp/tools/write-tools.ts` — MCP `memory.write` (`handleMemoryWrite`), `memory.retain` (`handleMemoryRetain`), `suggest-memory` (`handleSuggestMemory`)
- `server/src/services/internal-agent/tools/memory-tools.ts` — Commander `suggest_memory`
- `server/src/services/internal-agent/tools/memory-propose.ts` — `propose_memory_from_thread` (direct-insert path only; the `controller_action_gate` queue path is a proposal and stays untouched)
- `server/src/services/suggestions.ts` — the `suggest_memory` apply case (~line 1197)
- P3 Run-Miner writer + P4 Guardian writer (see dependency note — wire if present)
- Test: `server/src/__tests__/memory-autonomy.integration.test.ts`

**Uniform edit pattern** — every caller already inserts as `pending`. After the insert returns a row, add:

```ts
import { applyWriteGate } from "../../memory-autonomy.js"; // path relative to the caller

// ...after the pending row is created (row.id in scope):
const gate = await applyWriteGate(ctx.db, ctx.companyId, {
  id: row.id,
  layer,                       // the item's layer
  departmentId: departmentId ?? null,
}, { agentId: ctx.agentId ?? null, source: "agent" });
// use gate.status in the response summary ("approved" | "pending")
```

Per-caller argument specifics:
- **crew `write_memory`** — `source:"agent"`, `agentId: ctx.agentId`, `departmentId`. Change the success summary to reflect `gate.status` ("added to Knowledge Base" when approved, "awaiting founder review" when pending).
- **MCP `memory.write`** — `source: isAgentActor ? "agent" : "mcp"`, `agentId: ctx.actor.agentId ?? null`, `departmentId: parsed.departmentId ?? parsed.projectId ?? null`. Return `{ id, status: gate.status }`.
- **MCP `memory.retain`** — keep the existing `isPersonalScope` auto-approve; for the **non-personal** path, replace the always-pending assumption with `applyWriteGate` (so an org-scoped durable retain auto-approves at policy/promoted). Personal working scope still auto-approves as today.
- **MCP `suggest-memory`** & **Commander `suggest_memory`** — `source: "mcp"` / `"commander"`, `agentId: null` (user-driven; `classPromoted` will be false, so only company `policy` auto-approves durable — intended). `departmentId` from the parsed/created row.
- **`propose_memory_from_thread`** (direct insert) — `source:"agent"`, `agentId: ctx.agentId`, `departmentId: scopeInherit.departmentId ?? null`.
- **`suggestions.ts` `suggest_memory` case** — after `memorySvc.create(...)`, `applyWriteGate(tx as any, companyId, { id: created.id, layer, departmentId }, { agentId: null, source:"agent" })`.
- **P3 Run-Miner** (`server/src/services/internal-agent/aoa-agents/crew-run-outcome.ts` + heartbeat completion, per P3-T3) — after writing the `provenance_kind='run'` pending candidate, `applyWriteGate(..., { agentId: <run agentId>, source:"run" })`. A run-mined **durable** fact stays pending at Supervised (X1) and only auto-approves when the class is promoted (trusted) or the company is `policy`.
- **P4 Guardian** (consolidation writer) — the item's effective `tier` is `consolidation`; pass `tier:"consolidation"` in the gate input so `resolveWriteDisposition` yields propose-until-trusted. Guardian never self-approves at manual/supervised.

- [ ] **Step 1: Apply the edits above** to each existing caller (crew `write_memory`, MCP `memory.write`/`retain`/`suggest-memory`, Commander `suggest_memory`, `propose_memory_from_thread`, `suggestions.ts`). For P3/P4 writers, apply if the file exists; otherwise leave a `// TODO(P5 gate): applyWriteGate once the P<N> writer lands` marker at the write site and check the box when that phase merges.

- [ ] **Step 2: Write the failing integration test** (embedded-Postgres; the three acceptance cases end-to-end through the real gate + real `approve`)

Create `server/src/__tests__/memory-autonomy.integration.test.ts` (boot boilerplate mirrors `d18-autonomy-dial-split.integration.test.ts` / `w1b-auto-accept.integration.test.ts` — `EmbeddedPostgres` ctor with `initdbFlags: ["--encoding=UTF8","--locale=C"]` on Windows, `applyPendingMigrations`, `createDb`, the `assertSetupOk()` loud-fail guard, and the Windows skip unless `AOA_RUN_WIN_INTEGRATION=1`):

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { applyPendingMigrations, createDb, type Db } from "@armyofagents/db";
import {
  companies, agents, projects, memoryItems, memorySettings, memoryClassPromotions,
} from "@armyofagents/db";
import { writeMemoryAndIndex } from "../services/memory-write.js";
import { applyWriteGate } from "../services/memory-autonomy.js";
import { setPromotion } from "../services/memory-promotion.js";

// ...embedded-pg boot (see d18 test); `db: Db` assigned in beforeAll, assertSetupOk() guard...

describe("memory autonomy gate (real Postgres)", () => {
  let companyId: string;
  let deptId: string;
  let agentId: string;

  beforeAll(async () => {
    // Minimal fixture — adjust required NOT-NULL columns to match current schema.
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Acme", deploymentMode: "local_trusted" } as any);
    deptId = randomUUID();
    await db.insert(projects).values({ id: deptId, companyId, name: "Alpha", type: "department" } as any);
    agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "org-alpha", shortName: "orgalpha", adapterType: "claude_local", status: "idle" } as any);
  });

  async function writePending(layer: string, dept: string | null) {
    const row = await writeMemoryAndIndex(db, companyId, {
      title: `t-${randomUUID()}`, content: "c", layer, category: "context",
      source: "agent", sourceContext: "run", status: "pending", visibility: "scoped",
      createdBy: agentId, departmentId: dept,
    } as any);
    return row!;
  }

  it("X1 baseline: Supervised + durable(domain) → stays pending", async () => {
    await db.insert(memorySettings).values({ companyId, departmentId: null, autonomyLevel: "supervised" } as any);
    const row = await writePending("domain", deptId);
    const gate = await applyWriteGate(db, companyId, { id: row.id, layer: "domain", departmentId: deptId }, { agentId, source: "agent" });
    expect(gate.status).toBe("pending");
    const [after] = await db.select({ status: memoryItems.status }).from(memoryItems).where(eq(memoryItems.id, row.id));
    expect(after.status).toBe("pending");
  });

  it("X1/X4: loosen dept to Trusted + promote the class → durable auto-approves", async () => {
    await db.insert(memorySettings).values({ companyId, departmentId: deptId, autonomyLevel: "trusted" } as any);
    await setPromotion(db, { companyId, agentId, memoryClass: "domain", scopeDepartmentId: deptId, status: "promoted", promotedByUserId: null });
    const row = await writePending("domain", deptId);
    const gate = await applyWriteGate(db, companyId, { id: row.id, layer: "domain", departmentId: deptId }, { agentId, source: "agent" });
    expect(gate).toMatchObject({ level: "trusted", classPromoted: true, status: "approved" });
    const [after] = await db.select({ status: memoryItems.status }).from(memoryItems).where(eq(memoryItems.id, row.id));
    expect(after.status).toBe("approved");
  });

  it("X4 negative: protected (identity) never auto-approves and cannot be promoted", async () => {
    const row = await writePending("identity", null);
    const gate = await applyWriteGate(db, companyId, { id: row.id, layer: "identity", departmentId: null }, { agentId, source: "agent" });
    expect(gate).toMatchObject({ tier: "protected", status: "pending" });
    await expect(
      setPromotion(db, { companyId, agentId, memoryClass: "identity", scopeDepartmentId: null, status: "promoted", promotedByUserId: null }),
    ).rejects.toThrow(/not promotable/);
  });
});
```

- [ ] **Step 3: Run the integration test to verify it fails, then passes**

Run (Windows dev box): `AOA_RUN_WIN_INTEGRATION=1 pnpm --filter ./server exec vitest run src/__tests__/memory-autonomy.integration.test.ts`
Run (Linux CI / default): `pnpm --filter ./server exec vitest run src/__tests__/memory-autonomy.integration.test.ts`
Expected first: FAIL (assertions unmet until Step 1 wiring + gate land). Expected after: PASS — pending at Supervised, approved at Trusted+promoted, pending + throw for protected.

- [ ] **Step 4: Typecheck + regression**

Run: `pnpm --filter ./server typecheck` → PASS.
Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-write-tools.test.ts src/__tests__/mcp-write-tools.test.ts src/__tests__/c2-memory-propose.test.ts src/__tests__/commander-memory-tools.test.ts`
Expected: PASS (existing write-path tests still green — default Supervised keeps agent durable/identity writes pending, so their `status:"pending"` assertions hold; update any that assumed a fixed summary string to accept the gate-aware summary).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/internal-agent/tools/memory-write.ts server/src/mcp/tools/write-tools.ts server/src/services/internal-agent/tools/memory-tools.ts server/src/services/internal-agent/tools/memory-propose.ts server/src/services/suggestions.ts server/src/__tests__/memory-autonomy.integration.test.ts
git commit -m "feat(memory): route every write path through the tier-autonomy gate (P5)"
```

---

### Task 5: Promotion API routes (founder-gated; protected rejected)

**Files:**
- Modify: `server/src/routes/memory.ts` (add three routes beside the existing approve/reject handlers; reuse `assertCompanyAccess` + `assertMemoryApproval` for the founder/lead gate, and `getActorInfo` for `promotedByUserId`)
- Test: `server/src/__tests__/memory-promotion-routes.test.ts`

- [ ] **Step 1: Write the failing contract test** (asserts the protected-class rejection + demote path; sequence-mock db)

Create `server/src/__tests__/memory-promotion-routes.test.ts` mocking `../services/memory-promotion.js` (`listPromotionCandidates`, `setPromotion`) and asserting:
- `POST …/memory/promotions` with `memoryClass:"identity"` → **400** (never reaches `setPromotion`) — the security assertion.
- `POST …/memory/promotions` with `memoryClass:"domain"` → calls `setPromotion(status:"promoted")`, returns `{ status:"promoted" }`.
- `POST …/memory/promotions/demote` → calls `setPromotion(status:"demoted")`.
- `GET …/memory/promotions` → returns `{ candidates }` from `listPromotionCandidates`.

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-promotion-routes.test.ts`
Expected: FAIL — routes not defined yet.

- [ ] **Step 2: Add the routes** in `server/src/routes/memory.ts`:

```ts
import { listPromotionCandidates, setPromotion, isPromotableClass } from "../services/memory-promotion.js";

// GET eligible + promoted (agent × class × scope) rows for the panel.
router.get("/companies/:companyId/memory/promotions", async (req, res) => {
  const companyId = req.params.companyId as string;
  assertCompanyAccess(req, companyId);
  // Read gate: founder/lead approval authority (identity scope = company-wide).
  await assertMemoryApproval(db, req, companyId, { layer: "identity", departmentId: null });
  const candidates = await listPromotionCandidates(db, companyId);
  res.json({ candidates });
});

// POST promote / POST demote share one handler shape.
for (const [path, status] of [["promotions", "promoted"], ["promotions/demote", "demoted"]] as const) {
  router.post(`/companies/:companyId/memory/${path}`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const { agentId, memoryClass, scopeDepartmentId } = req.body ?? {};
    if (!agentId || !memoryClass) {
      res.status(400).json({ error: "agentId and memoryClass are required" });
      return;
    }
    if (!isPromotableClass(memoryClass)) {
      res.status(400).json({ error: `memory class "${memoryClass}" cannot be promoted (protected/ephemeral)` });
      return;
    }
    // Authority scoped to the class's department (null = company-wide).
    await assertMemoryApproval(db, req, companyId, { layer: memoryClass, departmentId: scopeDepartmentId ?? null });
    const actor = getActorInfo(req);
    const row = await setPromotion(db, {
      companyId, agentId, memoryClass,
      scopeDepartmentId: scopeDepartmentId ?? null,
      status, promotedByUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await logActivity(db, {
      companyId, actorType: actor.actorType, actorId: actor.actorId,
      action: `memory.class_${status}`, entityType: "memory_class_promotion", entityId: row.id,
      details: { agentId, memoryClass, scopeDepartmentId: scopeDepartmentId ?? null },
    });
    res.json({ id: row.id, status: row.status });
  });
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-promotion-routes.test.ts`
Expected: PASS (protected → 400 before `setPromotion`; domain → promoted/demoted).

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm --filter ./server typecheck` → PASS.

```bash
git add server/src/routes/memory.ts server/src/__tests__/memory-promotion-routes.test.ts
git commit -m "feat(memory): promotion API — list/promote/demote, founder-gated, protected rejected (P5)"
```

---

### Task 6: Promotion panel in Settings → Memory (UI)

**Files:**
- Modify: `ui/src/api/memory.ts` (add `listMemoryPromotions`, `promoteMemoryClass`, `demoteMemoryClass` — follow the existing api-client pattern in that file)
- Create: `ui/src/components/settings/sections/MemoryPromotionPanel.tsx`
- Modify: `ui/src/components/settings/sections/MemorySettingsSection.tsx` (mount `<MemoryPromotionPanel companyId={companyId} />` under the autonomy dials — this file is created in P1-T10)
- Test: `ui/src/components/settings/sections/__tests__/MemoryPromotionPanel.test.tsx`

- [ ] **Step 1: Add the api client functions** in `ui/src/api/memory.ts`:

```ts
export interface MemoryPromotionCandidate {
  agentId: string;
  memoryClass: string;
  scopeDepartmentId: string | null;
  reviewedCount: number;
  approvalRate: number;
  eligible: boolean;
  promoted: boolean;
}
export async function listMemoryPromotions(companyId: string): Promise<MemoryPromotionCandidate[]> {
  const r = await apiFetch(`/companies/${companyId}/memory/promotions`);
  return (await r.json()).candidates;
}
export async function promoteMemoryClass(companyId: string, body: { agentId: string; memoryClass: string; scopeDepartmentId: string | null }) {
  return apiFetch(`/companies/${companyId}/memory/promotions`, { method: "POST", body: JSON.stringify(body) });
}
export async function demoteMemoryClass(companyId: string, body: { agentId: string; memoryClass: string; scopeDepartmentId: string | null }) {
  return apiFetch(`/companies/${companyId}/memory/promotions/demote`, { method: "POST", body: JSON.stringify(body) });
}
```

- [ ] **Step 2: Write the failing UI test** (testing-library; mirror `ui/src/components/settings/sections/__tests__/MarketplaceUpdatesPanel.test.tsx`)

Create `ui/src/components/settings/sections/__tests__/MemoryPromotionPanel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryPromotionPanel } from "../MemoryPromotionPanel";
import * as api from "../../../../api/memory";

vi.mock("../../../../api/memory");

describe("MemoryPromotionPanel", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lists eligible + promoted classes and promotes an eligible one", async () => {
    vi.mocked(api.listMemoryPromotions).mockResolvedValueOnce([
      { agentId: "ag1", memoryClass: "domain", scopeDepartmentId: "deptA", reviewedCount: 24, approvalRate: 96, eligible: true, promoted: false },
    ]);
    vi.mocked(api.promoteMemoryClass).mockResolvedValue({ ok: true } as any);
    render(<MemoryPromotionPanel companyId="co1" />);
    expect(await screen.findByText(/domain/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /promote/i }));
    await waitFor(() =>
      expect(api.promoteMemoryClass).toHaveBeenCalledWith("co1", {
        agentId: "ag1", memoryClass: "domain", scopeDepartmentId: "deptA",
      }),
    );
  });

  it("demotes an already-promoted class", async () => {
    vi.mocked(api.listMemoryPromotions).mockResolvedValueOnce([
      { agentId: "ag1", memoryClass: "domain", scopeDepartmentId: null, reviewedCount: 30, approvalRate: 100, eligible: true, promoted: true },
    ]);
    vi.mocked(api.demoteMemoryClass).mockResolvedValue({ ok: true } as any);
    render(<MemoryPromotionPanel companyId="co1" />);
    fireEvent.click(await screen.findByRole("button", { name: /demote/i }));
    await waitFor(() => expect(api.demoteMemoryClass).toHaveBeenCalled());
  });
});
```

- [ ] **Step 3: Implement `MemoryPromotionPanel.tsx`** — on mount `listMemoryPromotions`; render each candidate row (agent name, class, scope, `reviewedCount`/`approvalRate`, and a Promote button when `!promoted`, a Demote button when `promoted`); on click call the api then re-fetch. Follow the design-system section/card patterns used by the neighbouring settings panels.

- [ ] **Step 4: Run the UI test to verify it passes**

Run: `pnpm --filter ./ui exec vitest run src/components/settings/sections/__tests__/MemoryPromotionPanel.test.tsx`
Expected: PASS (promote + demote call the right endpoints).

- [ ] **Step 5: Commit**

```bash
git add ui/src/api/memory.ts ui/src/components/settings/sections/MemoryPromotionPanel.tsx ui/src/components/settings/sections/MemorySettingsSection.tsx ui/src/components/settings/sections/__tests__/MemoryPromotionPanel.test.tsx
git commit -m "feat(memory): trust-promotion panel in Settings → Memory (P5)"
```

---

### Task 7: Real-run acceptance (X1 + X4)

**Files:**
- Modify: this plan (record the runbook + tick the boxes on a live pass). No product code.

Boot a local `local_trusted` instance with a real CLI logged in (Windows: detached-worktree + embedded-pg short-path setup). Set the `llm:openai` key in Settings → Memory so embeddings run. Seed the acceptance fixture from `2026-07-30-memory-enterprise-real-run-acceptance.md` (company **Acme**; departments **Alpha**/**Beta**; org agent **`org-alpha`** on Alpha with a real CLI adapter; crew present).

- [ ] **X1 — Autonomy dial.** Settings → Memory: set the **company** autonomy to **Supervised**. Assign an Alpha task to `org-alpha` and let the real CLI run to completion (scenario I4). Verify the run-mined **durable** fact candidate lands `status='pending'` (`memory_items` row + Inbox `memory_review`) — **not** auto-approved. Then set the **Alpha department override** to a looser level (Trusted with the class promoted, or Policy) and re-run: confirm the disposition changes per the tier table (durable now auto-approves for Alpha while the company default is unchanged). Evidence: `memory_items.status` before/after + the `memory_settings` rows.

- [ ] **X4 — Trust promotion.** Drive `org-alpha`'s `domain` (or `active_context`) class in Alpha to a sustained record (≥20 reviewed, ≥90% approved-without-edit). Open Settings → Memory → the promotion panel: the (org-alpha × domain × Alpha) row shows **eligible**. Click **Promote**. Confirm a subsequent agent durable write in that class auto-approves (`memory_items.status='approved'`, a `memory_class_promotions` row `status='promoted'`). Then confirm **protected** never promotes: the identity/protected class shows **no Promote control**, and `POST …/memory/promotions {memoryClass:"identity"}` returns **400**. Click **Demote** on the promoted row and confirm the next write reverts to `pending`.

- [ ] **Record results** inline here (dates, row ids, before/after statuses) and tick the boxes. Any leakage or an unexpected auto-approve of a non-promoted durable class at Supervised is a **fail** — do not close P5.

---

## P5 exit criteria

- [ ] `pnpm db:generate` produced an additive-only `CREATE TABLE memory_class_promotions` migration; `pnpm --filter ./db typecheck` green.
- [ ] `memory-promotion.test.ts`, `memory-autonomy.test.ts`, `memory-promotion-routes.test.ts` green; `MemoryPromotionPanel.test.tsx` green.
- [ ] `memory-autonomy.integration.test.ts` green on embedded-Postgres: **durable @ Supervised → pending**, **durable @ Trusted + promoted → approved**, **protected → pending + `setPromotion` throws**.
- [ ] Every write path (crew `write_memory`, MCP `memory.write`/`retain`/`suggest-memory`, Commander `suggest_memory`, `propose_memory_from_thread`, `suggestions.ts`, and the P3 Run-Miner + P4 Guardian writers when present) calls `applyWriteGate`; a grep for the memory insert sites shows no un-gated non-founder durable write.
- [ ] `resolveWriteDisposition` is driven by the effective `autonomyLevel` (department override else company default from `memory_settings`) and by `classPromoted` (durable + trusted + promoted → auto). `protected` never auto-approves and never promotes.
- [ ] `pnpm --filter ./server typecheck` green; existing memory write-path tests still green.
- [ ] Real-run X1 + X4 pass on a live instance (Task 7 boxes ticked).

## Self-review (run before executing)

- **Spec coverage:** overview P5 T1→Task 4 (wire the gate into every path), T2→Tasks 1+2+5 (promotion policy + store + founder-confirm route), T3→Task 6 (panel), T4→Tasks 3+4 (`classPromoted` into `resolveWriteDisposition`). Real-run X1/X4 → Task 7. Test stack: UNIT (Task 2 pure fn + Task 3 gate), INTEGRATION (Task 4), UI (Task 6), REAL-RUN (Task 7). All present.
- **Placeholders:** none — every code step shows real code; every command shows expected output; the store decision is made and justified (Task 1).
- **Type consistency:** `MemoryTier` / `AutonomyLevel` / `WriteDisposition` re-used from `memory-tier-policy.ts` (P0) verbatim; `resolveWriteDisposition(tier, level, {classPromoted})`, `tierForItem` signatures unchanged; `confidence`/percent scale integers throughout; `memoryClass` = memory **layer** (durable layers only), aligning "protected never promotes" with the identity→protected tier mapping.
- **Safety / Rule #6:** `memoryService.create`'s agent→pending default is **untouched**; `auto` is only ever reached by an explicit, tier-gated post-insert `approve()`. Default `supervised` keeps every agent durable/identity write pending → today's behaviour. Auto-approve for durable requires a founder action (loosen the dial and/or promote the class). Protected is `human` at every level and rejected by `setPromotion` + the route.
- **Intentional behaviour delta:** `working` (ephemeral) crew/MCP writes now auto-approve (tier `ephemeral` → `auto` at all levels), matching the P0 tier table and the overview's "default = today's behaviour except working=auto". This is the only default-behaviour change; it is confined to ephemeral, task-scoped, 7-day-TTL memory.
- **No cross-scope leak introduced:** the gate only decides *disposition* (approve vs pending). RBAC-in-SQL retrieval (P1) is untouched — a promoted class does not widen who can read the item.
