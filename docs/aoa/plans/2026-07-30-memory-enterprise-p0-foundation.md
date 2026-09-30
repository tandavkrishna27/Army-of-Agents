# P0 · Memory Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. See `2026-07-30-memory-enterprise-overview.md` for the full suite and shared conventions.

**Goal:** Lay the non-behavioral substrate for the enterprise memory model — additive schema, the tier-policy engine, and the RBAC memory-access filter — with zero change to any live run path.

**Architecture:** Extend `memory_items` with nullable columns; add two pure, dependency-free service modules (`memory-tier-policy.ts`, `memory-access.ts`) that later phases wire into the read/write paths. Nothing here changes runtime behavior; it only adds building blocks + their tests.

**Tech Stack:** Drizzle ORM (`packages/db`), Vitest, TypeScript.

**Scope note:** The Settings → Memory UI scaffold (originally listed under P0) is folded into **P1-T10**, where the first real dials are wired — an empty settings tab that does nothing for a whole phase is YAGNI.

---

### Task 1: Additive schema on `memory_items`

**Files:**
- Modify: `packages/db/src/schema/memory_items.ts` (add columns after `founderPinnedToTop`, before `createdAt`)
- Generated: `packages/db/src/migrations/0188_*.sql` (name auto-assigned by drizzle)

- [ ] **Step 1: Add the nullable columns**

In `packages/db/src/schema/memory_items.ts`, insert these fields immediately after the `founderPinnedToTop` line (line ~92) and before `createdAt`:

```ts
    // --- Enterprise memory model (P0, additive/non-breaking) ---
    // Typed ownership. Today ownership is inferred from scope; these make it explicit.
    ownerType: text("owner_type"), // "company" | "department" | "project" | "user" | "agent"
    ownerId: uuid("owner_id"),
    // Autonomy tier. Null → derived from `layer` at policy time (see memory-tier-policy.ts).
    tier: text("tier"), // "protected" | "durable" | "ephemeral" | "consolidation" | "derived"
    confidence: integer("confidence"), // 0..100 extraction/consolidation confidence (integer pct)
    // Provenance / evidence pointer.
    provenanceKind: text("provenance_kind"), // "human" | "discussion" | "braindump" | "run" | "external" | "consolidation"
    sourceRef: text("source_ref"), // freeform source id (run id, thread id, doc id)
    trust: text("trust"), // "observed" | "extracted" | "proposed" | "approved" | "verified"
    // Temporal validity.
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    // Correction/forgetting: retrieval excludes rows with a non-null value (history preserved).
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
```

(`text`, `uuid`, `integer`, and `timestamp` are already imported at the top of the file.)

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file `packages/db/src/migrations/0188_*.sql` is created containing only `ALTER TABLE "memory_items" ADD COLUMN ...` statements (10 additive columns, no `DROP`, no `NOT NULL` without default). Drizzle also updates `packages/db/src/migrations/meta/`.

- [ ] **Step 3: Verify the migration is additive-only**

Run: `git diff --stat packages/db/src/migrations`
Expected: one new `.sql` migration + updated `meta/` snapshot. Open the `.sql` and confirm every statement is `ADD COLUMN` (no `DROP COLUMN`, no `ALTER COLUMN ... SET NOT NULL`).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @armyofagents/db typecheck`
Expected: PASS (exit 0).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/memory_items.ts packages/db/src/migrations
git commit -m "feat(memory): additive schema for enterprise memory model (P0)"
```

---

### Task 2: Tier-policy engine (pure)

**Files:**
- Create: `server/src/services/memory-tier-policy.ts`
- Test: `server/src/__tests__/memory-tier-policy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-tier-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  tierForItem,
  resolveWriteDisposition,
} from "../services/memory-tier-policy.js";

describe("tierForItem", () => {
  it("maps layers to tiers", () => {
    expect(tierForItem({ layer: "identity" })).toBe("protected");
    expect(tierForItem({ layer: "working" })).toBe("ephemeral");
    expect(tierForItem({ layer: "domain" })).toBe("durable");
    expect(tierForItem({ layer: "active_context" })).toBe("durable");
    expect(tierForItem({ layer: null })).toBe("durable");
  });

  it("prefers an explicit valid tier override", () => {
    expect(tierForItem({ layer: "working", tier: "protected" })).toBe("protected");
    expect(tierForItem({ layer: "domain", tier: "bogus" })).toBe("durable"); // invalid → derive
  });
});

describe("resolveWriteDisposition", () => {
  it("protected is always human", () => {
    for (const lvl of ["manual", "supervised", "trusted", "policy"] as const) {
      expect(resolveWriteDisposition("protected", lvl)).toBe("human");
    }
  });

  it("derived and ephemeral are always auto", () => {
    for (const lvl of ["manual", "supervised", "trusted", "policy"] as const) {
      expect(resolveWriteDisposition("derived", lvl)).toBe("auto");
      expect(resolveWriteDisposition("ephemeral", lvl)).toBe("auto");
    }
  });

  it("consolidation is propose until trusted, then auto", () => {
    expect(resolveWriteDisposition("consolidation", "manual")).toBe("propose");
    expect(resolveWriteDisposition("consolidation", "supervised")).toBe("propose");
    expect(resolveWriteDisposition("consolidation", "trusted")).toBe("auto");
    expect(resolveWriteDisposition("consolidation", "policy")).toBe("auto");
  });

  it("durable escalates manual→human, supervised/trusted→propose, policy→auto", () => {
    expect(resolveWriteDisposition("durable", "manual")).toBe("human");
    expect(resolveWriteDisposition("durable", "supervised")).toBe("propose");
    expect(resolveWriteDisposition("durable", "trusted")).toBe("propose");
    expect(resolveWriteDisposition("durable", "policy")).toBe("auto");
  });

  it("durable at trusted auto-approves only a promoted class", () => {
    expect(resolveWriteDisposition("durable", "trusted", { classPromoted: true })).toBe("auto");
    expect(resolveWriteDisposition("durable", "manual", { classPromoted: true })).toBe("human");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-tier-policy.test.ts`
Expected: FAIL — `Cannot find module '../services/memory-tier-policy.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/services/memory-tier-policy.ts`:

```ts
/**
 * Risk-tiered memory autonomy policy (enterprise memory model, P0).
 * Pure, dependency-free. Consumed by every write path in P5 and by the
 * Settings → Memory dials. See docs/aoa/plans/2026-07-30-memory-enterprise-overview.md.
 */
export type MemoryTier = "derived" | "ephemeral" | "consolidation" | "durable" | "protected";
export type AutonomyLevel = "manual" | "supervised" | "trusted" | "policy";
export type WriteDisposition = "auto" | "propose" | "human";

const VALID_TIERS: readonly string[] = ["derived", "ephemeral", "consolidation", "durable", "protected"];

/** Effective tier for an item: explicit `tier` override wins, else derived from `layer`. */
export function tierForItem(item: { layer: string | null; tier?: string | null }): MemoryTier {
  if (item.tier && VALID_TIERS.includes(item.tier)) return item.tier as MemoryTier;
  switch (item.layer) {
    case "identity":
      return "protected";
    case "working":
      return "ephemeral";
    case "domain":
    case "active_context":
      return "durable";
    default:
      return "durable"; // safe default: gate unknown layers like durable
  }
}

/** How a write of `tier` should be handled at company autonomy `level`. */
export function resolveWriteDisposition(
  tier: MemoryTier,
  level: AutonomyLevel,
  opts: { classPromoted?: boolean } = {},
): WriteDisposition {
  if (tier === "protected") return "human";
  if (tier === "derived" || tier === "ephemeral") return "auto";
  if (tier === "consolidation") {
    return level === "trusted" || level === "policy" ? "auto" : "propose";
  }
  // durable
  switch (level) {
    case "manual":
      return "human";
    case "supervised":
      return "propose";
    case "trusted":
      return opts.classPromoted ? "auto" : "propose";
    case "policy":
      return "auto";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-tier-policy.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/memory-tier-policy.ts server/src/__tests__/memory-tier-policy.test.ts
git commit -m "feat(memory): tier-policy engine — risk-tiered write disposition (P0)"
```

---

### Task 3: RBAC memory-access filter (pure)

**Files:**
- Create: `server/src/services/memory-access.ts`
- Test: `server/src/__tests__/memory-access.test.ts`

**Note (review-adjusted):** this is the *single* RBAC filter for the whole system. P1-T5 routes the MCP read tools (`server/src/mcp/tools/scope.ts`, `read-tools.ts`) through it and deletes the older `filterMemoryForScope`. P1-T2 adds a companion `memoryAccessConditions(actor)` that returns Drizzle `WHERE` conditions so RBAC runs *inside* the query; this pure filter stays as the post-fetch safety net.

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/memory-access.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  filterMemoryForActor,
  type AccessibleMemoryRow,
  type MemoryActor,
} from "../services/memory-access.js";

function row(overrides: Partial<AccessibleMemoryRow> = {}): AccessibleMemoryRow {
  return {
    layer: "domain",
    visibility: "scoped",
    departmentId: "deptA",
    projectId: null,
    ownerType: null,
    ownerId: null,
    agentId: null,
    invalidatedAt: null,
    ...overrides,
  };
}

const founder: MemoryActor = { kind: "founder" };
const agentA: MemoryActor = { kind: "agent", agentId: "ag1", departmentIds: ["deptA"] };
const agentB: MemoryActor = { kind: "agent", agentId: "ag2", departmentIds: ["deptB"] };
const leadA: MemoryActor = { kind: "team_lead", userId: "u1", departmentIds: ["deptA"] };

describe("filterMemoryForActor", () => {
  it("founder sees all non-private, any department", () => {
    const items = [row({ departmentId: "deptA" }), row({ departmentId: "deptB" })];
    expect(filterMemoryForActor(items, founder)).toHaveLength(2);
  });

  it("agent sees own-department scoped memory but not another department's", () => {
    const items = [row({ departmentId: "deptA" }), row({ departmentId: "deptB" })];
    const seen = filterMemoryForActor(items, agentA);
    expect(seen).toHaveLength(1);
    expect(seen[0].departmentId).toBe("deptA");
  });

  it("identity memory is company core — visible to any actor", () => {
    const items = [row({ layer: "identity", departmentId: null, visibility: "scoped" })];
    expect(filterMemoryForActor(items, agentB)).toHaveLength(1);
  });

  it("company-visibility memory is visible cross-department", () => {
    const items = [row({ visibility: "company", departmentId: "deptB" })];
    expect(filterMemoryForActor(items, agentA)).toHaveLength(1);
  });

  it("agent-private memory is visible only to the owning agent", () => {
    const items = [row({ ownerType: "agent", ownerId: "ag1", agentId: "ag1", departmentId: null })];
    expect(filterMemoryForActor(items, agentA)).toHaveLength(1);
    expect(filterMemoryForActor(items, agentB)).toHaveLength(0);
    expect(filterMemoryForActor(items, founder)).toHaveLength(0); // hidden in normal path
  });

  it("user-private memory is visible only to the owning user", () => {
    const items = [row({ ownerType: "user", ownerId: "u1", departmentId: null })];
    expect(filterMemoryForActor(items, leadA)).toHaveLength(1);
    expect(filterMemoryForActor(items, agentA)).toHaveLength(0);
    expect(filterMemoryForActor(items, founder)).toHaveLength(0);
  });

  it("invalidated memory is hidden from everyone", () => {
    const items = [row({ invalidatedAt: new Date("2026-01-01"), visibility: "company" })];
    expect(filterMemoryForActor(items, founder)).toHaveLength(0);
    expect(filterMemoryForActor(items, agentA)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-access.test.ts`
Expected: FAIL — `Cannot find module '../services/memory-access.js'`.

- [ ] **Step 3: Write the implementation**

Create `server/src/services/memory-access.ts`:

```ts
/**
 * RBAC memory-access filter (enterprise memory model, P0).
 * Pure, dependency-free. Wired into ORG + CREW run paths in P1 as a
 * pre-ranking gate so an actor never sees — nor can rank/leak — memory it
 * isn't entitled to. See docs/aoa/plans/2026-07-30-memory-enterprise-overview.md.
 */
export type MemoryActor =
  | { kind: "founder" }
  | { kind: "team_lead"; userId: string; departmentIds: string[] }
  | { kind: "team_member"; userId: string; departmentIds: string[] }
  | { kind: "commander"; userId: string; departmentIds: string[] }
  | { kind: "agent"; agentId: string; departmentIds: string[] };

export interface AccessibleMemoryRow {
  layer: string | null;
  visibility: string;
  departmentId: string | null;
  projectId: string | null;
  ownerType?: string | null;
  ownerId?: string | null;
  agentId: string | null;
  invalidatedAt?: Date | null;
}

function isPrivate(item: AccessibleMemoryRow): boolean {
  return item.ownerType === "user" || item.ownerType === "agent" || item.agentId != null;
}

/** True iff `actor` is entitled to see `item` in normal retrieval. */
export function canActorSee(item: AccessibleMemoryRow, actor: MemoryActor): boolean {
  // Correction/forgetting: invalidated items never surface (history stays in the row).
  if (item.invalidatedAt != null) return false;

  if (isPrivate(item)) {
    if (actor.kind === "agent") return item.agentId === actor.agentId;
    if (actor.kind === "founder") return false; // others' private hidden in the normal path (break-glass is separate)
    return item.ownerType === "user" && item.ownerId === actor.userId;
  }

  // Non-private:
  if (item.layer === "identity") return true; // company core, everyone
  if (item.visibility === "company") return true; // explicitly company-wide
  if (actor.kind === "founder") return true; // founder sees all non-private
  // scoped → department match
  return item.departmentId != null && actor.departmentIds.includes(item.departmentId);
}

export function filterMemoryForActor<T extends AccessibleMemoryRow>(
  items: T[],
  actor: MemoryActor,
): T[] {
  return items.filter((it) => canActorSee(it, actor));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-access.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter ./server typecheck`
Expected: PASS.

```bash
git add server/src/services/memory-access.ts server/src/__tests__/memory-access.test.ts
git commit -m "feat(memory): RBAC memory-access filter (P0)"
```

---

## P0 exit criteria

- [ ] `pnpm db:generate` produced an additive-only migration; `pnpm --filter @armyofagents/db typecheck` green.
- [ ] `memory-tier-policy.test.ts` and `memory-access.test.ts` green.
- [ ] `pnpm --filter ./server typecheck` green.
- [ ] No live run path imports the new modules yet (grep confirms zero non-test importers) — behavior is unchanged. P1 wires them in.

## Self-review (done)

- **Spec coverage:** P0 in the overview = schema + tier-policy + RBAC filter → Tasks 1–3. Settings scaffold explicitly moved to P1-T7 (noted).
- **Placeholders:** none — every code step has full code; every command has expected output.
- **Type consistency:** `MemoryTier` / `AutonomyLevel` / `WriteDisposition` (Task 2) and `MemoryActor` / `AccessibleMemoryRow` (Task 3) match the overview's shared-interface block exactly. `tierForItem` accepts optional `tier` (superset of the overview signature — compatible).
