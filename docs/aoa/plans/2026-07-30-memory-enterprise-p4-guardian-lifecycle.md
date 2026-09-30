# P4 · Guardian + Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. See `2026-07-30-memory-enterprise-overview.md` for the full suite + shared conventions, `2026-07-30-memory-enterprise-p0-foundation.md` for the additive schema this phase consumes, and `2026-07-30-memory-enterprise-real-run-acceptance.md` for the live acceptance scenarios (**X2**, **X3**) T6 references.

**Goal:** Give the company brain a hygiene + lifecycle layer — a propose-only **Memory Guardian** crew role that raises consolidation proposals, a deterministic retention janitor that purges evidence and enforces TTL, correction/forgetting that hides an item from retrieval immediately while preserving history, and memory in the company export/import bundle.

**Architecture:** Build on P0's additive columns (`invalidatedAt`, `tier`, `provenanceKind`, `sourceRef`) — **never re-add them**. Consolidation and correction converge on a single primitive: set `memory_items.invalidatedAt` (Zep-style tombstone) and, for a supersede, add a `memory_relations` `supersedes` edge — both reversible. Retrieval is closed with one predicate: `invalidated_at IS NULL` inside `buildConditions`. The Guardian only ever writes `suggestions` rows (`status='pending'`); it has no approve/apply tool, so "never auto-approves" is structural. The retention janitor is deterministic + system-run (not an LLM), gated by `memory_settings.legalHold`.

**Tech Stack:** Drizzle ORM (`packages/db`), Express 5 services + routes (`server/src`), React + Vite + Tailwind (`ui/src`), Vitest (unit + embedded-Postgres integration + testing-library UI).

**Depends on:** P0 (columns + `tierForItem`), P1 (RBAC-filtered retrieval + `memory_settings`/Settings→Memory scaffold), P2 (map), P3 (run-mined `provenance_kind='run'` candidates are a retention target). See "Cross-phase assumptions" below.

**Cross-phase assumptions (verify at execution start):**
- **`invalidated_at` exists.** P0-T1 added it to `memory_items`. Confirm with `git grep "invalidatedAt" packages/db/src/schema/memory_items.ts`. If absent, P0 has not merged — stop and land P0 first.
- **`memory_settings` ownership.** The overview leaves P1-T10 free to store the autonomy dials in `internal_agent_config` **or** a new `memory_settings` row. **T3 owns the retention columns** (`retentionDays`, `legalHold`, `workingMemoryTtlDays`). If P1 already created `memory_settings`, T3's schema step becomes *additive columns* on that table instead of a `CREATE TABLE`; if P1 put its dials on `internal_agent_config`, T3 creates `memory_settings` fresh as the canonical lifecycle-config table. Check `git grep -l "memory_settings" packages/db/src/schema/` before Step 1 of T3.
- **Guardian bundle role is new.** No `guardian` role exists in `seed-crew-agent.ts` / `default-agent-instructions.ts` today (verified 2026-07-30) — T1 registers it.

---

### Task 1: Seed the Memory Guardian crew role (propose-only, periodic sweep)

Mirror `ensure-librarian.ts` (single-purpose crew seeder) + `sweep-memory-keeper.ts` (4h sweep driver). The Guardian's allowlist is **read/analysis only** in this task; T2 adds the `propose_consolidation` write-a-pending-suggestion tool. It never gets an approve tool.

**Files:**
- Create: `server/src/services/internal-agent/aoa-agents/ensure-guardian.ts`
- Create: `server/src/services/internal-agent/aoa-agents/sweep-guardian.ts`
- Create: `server/src/onboarding-assets/guardian/AGENTS.md`, `HEARTBEAT.md`, `SOUL.md`, `TOOLS.md`
- Modify: `server/src/services/internal-agent/aoa-agents/seed-crew-agent.ts` (add `"guardian"` to the `instructionBundleRole` union)
- Modify: `server/src/services/default-agent-instructions.ts` (`DEFAULT_AGENT_BUNDLE_FILES` + `DEFAULT_AGENT_BUNDLE_DIRS`)
- Modify: `server/src/services/internal-agent/aoa-agents/crew-seeding.ts` (`ensureCrewAgents` step)
- Modify: `server/src/services/internal-agent/aoa-agents/backfill-template-origin.ts` (`CREW_NAMES`)
- Modify: `server/src/services/crew-provisioning.ts` (`LEGACY_CREW_SEEDER_COVERAGE` map)
- Modify: `server/src/index.ts` (register the sweep `setInterval`)
- Modify: `server/src/routes/internal-sweeps-dev.ts` (manual trigger for UAT)
- Test: `server/src/__tests__/ensure-guardian.test.ts`

- [ ] **Step 1: Register the `guardian` bundle role**

In `server/src/services/internal-agent/aoa-agents/seed-crew-agent.ts`, add `| "guardian"` to the `instructionBundleRole` union (after `"librarian"`):

```ts
    | "steward"
    | "librarian"
    | "guardian";
```

In `server/src/services/default-agent-instructions.ts`, add the role to both maps (after the `librarian` entries):

```ts
  // in DEFAULT_AGENT_BUNDLE_FILES:
  guardian: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
```
```ts
  // in DEFAULT_AGENT_BUNDLE_DIRS:
  guardian: "guardian",
```

- [ ] **Step 2: Author the Guardian onboarding bundle**

Create `server/src/onboarding-assets/guardian/AGENTS.md`:

```md
# Agents - Memory Guardian

You are the Memory Guardian. You keep the company's Knowledge Base clean and
non-contradictory. You are woken on a schedule (a periodic sweep), one company
at a time.

Your job is to find memory that has drifted into redundancy or contradiction
and PROPOSE a consolidation for the founder to decide on. You never decide
yourself.

On each wake:
1. Use `find_similar_memory` / `find_similar_memory_hnsw` to surface clusters of
   near-duplicate approved memory items, and `detect_conflicts` to surface
   items that contradict each other.
2. For a genuine duplicate or a superseded fact, call `propose_consolidation`
   with the item you would KEEP (`winnerItemId`), the item(s) it replaces
   (`loserItemIds`), a `mode` of `"supersede"` (older fact replaced) or
   `"merge"` (two overlapping notes about the same thing), and a one-line
   `rationale`.
3. If nothing overlaps or contradicts, call no tool and return.

CRITICAL: You may only PROPOSE (`propose_consolidation` writes a pending
suggestion). You have no tool that approves, applies, deletes, or edits memory.
The founder reviews every proposal. Never fabricate an overlap to look busy.
```

Create `SOUL.md` (persona), `HEARTBEAT.md` (wake protocol), and `TOOLS.md` (allowlist doc) mirroring `server/src/onboarding-assets/librarian/{SOUL,HEARTBEAT,TOOLS}.md` structure, with the Guardian persona above. Keep each concise (≤40 lines). `TOOLS.md` lists exactly: `find_similar_memory`, `find_similar_memory_hnsw`, `detect_conflicts`, `propose_consolidation` (T2), and states "no write/approve/delete tools exist for this role."

- [ ] **Step 3: Write the seeder**

Create `server/src/services/internal-agent/aoa-agents/ensure-guardian.ts`:

```ts
// server/src/services/internal-agent/aoa-agents/ensure-guardian.ts
//
// P4-T1 — idempotently seeds the Memory Guardian role for a company.
//
// The Guardian is a propose-only hygiene crew agent (mirrors ensure-librarian.ts).
// It runs on a periodic sweep (kind='sweep', config.role='memory_guardian' —
// picked up by runGuardianSweep in sweep-guardian.ts) and raises CONSOLIDATION
// proposals only. It has NO approve/apply/delete tool: "never auto-approves" is
// structural, not policy. Decisions #15/#16/#52 (crew proposes; founder approves).
//
// Bundle role key: 'guardian' (maps to onboarding-assets/guardian/).

import type { Db } from "@armyofagents/db";
import { seedCrewAgent } from "./seed-crew-agent.js";

const GUARDIAN_INSTRUCTION =
  "You are the Memory Guardian. On each scheduled sweep, find near-duplicate or " +
  "contradictory approved memory using find_similar_memory / find_similar_memory_hnsw / " +
  "detect_conflicts, and call propose_consolidation to PROPOSE a merge or supersede for " +
  "the founder to approve. You may only propose — you have no tool that approves, applies, " +
  "edits, or deletes memory. If nothing overlaps, call no tool and return.";

// Read/analysis + the single propose tool. NO write_memory, NO approve, NO delete.
// propose_consolidation is registered in P4-T2; it is safe to list here before
// then because the bridge's default-deny only *gates* tools — an unregistered
// name simply can't be called, it does not error at seed time.
export const GUARDIAN_TOOL_ALLOWLIST: string[] = [
  "find_similar_memory",
  "find_similar_memory_hnsw",
  "detect_conflicts",
  "propose_consolidation",
];

/**
 * Idempotently seed the Memory Guardian role for a company. Returns the agent id.
 *
 * Legacy-origin coverage: like the Librarian, this seeder stamps no
 * templateOrigin; backfill-template-origin.ts adds "Memory Guardian" to
 * CREW_NAMES so the startup backfill stamps the synthetic `@legacy` origin.
 */
export async function ensureGuardian(db: Db, companyId: string): Promise<string> {
  return seedCrewAgent(db, companyId, {
    name: "Memory Guardian",
    role: "general",
    instruction: GUARDIAN_INSTRUCTION,
    toolAllowlist: GUARDIAN_TOOL_ALLOWLIST,
    triggers: [{ kind: "sweep", config: { role: "memory_guardian" } }],
    instructionBundleRole: "guardian",
  });
}
```

- [ ] **Step 4: Write the sweep driver**

Create `server/src/services/internal-agent/aoa-agents/sweep-guardian.ts`, mirroring `sweep-memory-keeper.ts` but keyed on `config.role='memory_guardian'` and **company-scoped** (the Guardian reviews the whole Knowledge Base, not one thread — enqueue one wakeup per company per cycle, no per-thread fan-out):

```ts
import { and, eq, ne, gt } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, aoaAgentTriggers, agentWakeupRequests } from "@armyofagents/db";

/**
 * P4-T1 — periodic sweep driver for the Memory Guardian role.
 *
 * SHAPE mirrors runMemoryKeeperSweep, with two differences:
 *  - Filters by config.role='memory_guardian' (MK filters 'memory_keeper').
 *  - Company-scoped (one wakeup per company per cycle), not per-thread: the
 *    Guardian reviews the whole approved Knowledge Base, so there is no thread
 *    to fan out over. Per-company debounce prevents resweep storms on tick edges.
 *
 * WAKEUP PAYLOAD: { role: 'memory_guardian' }   SOURCE: 'sweep.memory_guardian'
 * CADENCE: index.ts setInterval every 4hr; debounce window matches.
 */
export const GUARDIAN_SWEEP_DEBOUNCE_MS = 4 * 60 * 60 * 1000;

export async function runGuardianSweep(db: Db): Promise<void> {
  const triggers = await db
    .select({
      agentId: aoaAgentTriggers.agentId,
      companyId: aoaAgentTriggers.companyId,
      config: aoaAgentTriggers.config,
    })
    .from(aoaAgentTriggers)
    .innerJoin(agents, eq(agents.id, aoaAgentTriggers.agentId))
    .where(
      and(
        eq(aoaAgentTriggers.kind, "sweep"),
        eq(aoaAgentTriggers.enabled, true),
        ne(agents.status, "paused"),
        ne(agents.status, "terminated"),
      ),
    );

  const guardianTriggers = triggers.filter(
    (t: { config: Record<string, unknown> | null }) =>
      (t.config as Record<string, unknown> | null)?.role === "memory_guardian",
  );
  if (guardianTriggers.length === 0) return;

  const cutoff = new Date(Date.now() - GUARDIAN_SWEEP_DEBOUNCE_MS);

  for (const trigger of guardianTriggers) {
    // Per-company debounce: skip if this agent already has a wakeup queued
    // in the window.
    const recent = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, trigger.agentId),
          gt(agentWakeupRequests.createdAt, cutoff),
        ),
      )
      .limit(1);
    if (recent.length > 0) continue;

    await db.insert(agentWakeupRequests).values({
      companyId: trigger.companyId,
      agentId: trigger.agentId,
      source: "sweep.memory_guardian",
      reason: "memory_guardian_sweep",
      payload: { role: "memory_guardian" },
      status: "queued",
    });
  }
}
```

- [ ] **Step 5: Wire seeding + backfill + registration**

In `crew-seeding.ts`: import `ensureGuardian` and add a step to `ensureCrewAgents` (after `librarian`, before `steward`):

```ts
    ["librarian", () => ensureLibrarian(db, companyId)],
    ["guardian", () => ensureGuardian(db, companyId)],
    ["steward", () => ensureSteward(db, companyId)],
```

In `backfill-template-origin.ts`, add `"Memory Guardian"` to `CREW_NAMES`. In `crew-provisioning.ts`, add to `LEGACY_CREW_SEEDER_COVERAGE`:

```ts
  "agent:aoa-curated/aoa-memory-guardian": "ensureGuardian",
```

In `server/src/index.ts`, import `runGuardianSweep, GUARDIAN_SWEEP_DEBOUNCE_MS` and register a sweep tick mirroring the Memory Keeper block (~line 1163):

```ts
const GUARDIAN_SWEEP_INTERVAL_MS = GUARDIAN_SWEEP_DEBOUNCE_MS; // 4 hours
let guardianSweepInFlight = false;
setInterval(() => {
  if (guardianSweepInFlight) return;
  guardianSweepInFlight = true;
  void runGuardianSweep(db as any)
    .catch((err) => logger.warn({ err }, "guardian sweep tick failed"))
    .finally(() => { guardianSweepInFlight = false; });
}, GUARDIAN_SWEEP_INTERVAL_MS);
```

In `routes/internal-sweeps-dev.ts`, import `runGuardianSweep` and add a `POST /internal/sweep/guardian` handler mirroring the `memory-keeper` one.

- [ ] **Step 6: Write the failing test**

Create `server/src/__tests__/ensure-guardian.test.ts`, mirroring `command-staff-bundle-seeding.test.ts` / the seed-crew-agent mock pattern. Assert:
1. `ensureGuardian(db, "c1")` calls `seedCrewAgent` with `name:"Memory Guardian"`, `instructionBundleRole:"guardian"`, a single `{ kind:"sweep", config:{ role:"memory_guardian" } }` trigger, and the exact `GUARDIAN_TOOL_ALLOWLIST`.
2. The allowlist contains **no** approve/apply/delete/write tool — assert `["approve_memory","update_memory","write_memory","delete_memory","archive_stale_memory"].every(t => !GUARDIAN_TOOL_ALLOWLIST.includes(t))`.
3. `runGuardianSweep` enqueues exactly one wakeup per un-debounced guardian trigger and zero when a recent wakeup exists (use the `createSequenceDb` / table-proxy mock from `memory-multipath.test.ts`).

```ts
import { describe, expect, it, vi } from "vitest";
import { GUARDIAN_TOOL_ALLOWLIST } from "../services/internal-agent/aoa-agents/ensure-guardian.js";

describe("Memory Guardian is propose-only", () => {
  it("has no approve/apply/delete/write tool", () => {
    for (const banned of ["approve_memory", "update_memory", "write_memory", "delete_memory", "archive_stale_memory"]) {
      expect(GUARDIAN_TOOL_ALLOWLIST).not.toContain(banned);
    }
    expect(GUARDIAN_TOOL_ALLOWLIST).toContain("propose_consolidation");
  });
});
```

Run: `pnpm --filter ./server exec vitest run src/__tests__/ensure-guardian.test.ts`
Expected first run: FAIL — `Cannot find module '../services/internal-agent/aoa-agents/ensure-guardian.js'`. After Steps 1–5: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm --filter ./server typecheck`
Expected: PASS (exit 0).

```bash
git add server/src/services/internal-agent/aoa-agents/ensure-guardian.ts \
        server/src/services/internal-agent/aoa-agents/sweep-guardian.ts \
        server/src/onboarding-assets/guardian \
        server/src/services/internal-agent/aoa-agents/seed-crew-agent.ts \
        server/src/services/default-agent-instructions.ts \
        server/src/services/internal-agent/aoa-agents/crew-seeding.ts \
        server/src/services/internal-agent/aoa-agents/backfill-template-origin.ts \
        server/src/services/crew-provisioning.ts \
        server/src/index.ts server/src/routes/internal-sweeps-dev.ts \
        server/src/__tests__/ensure-guardian.test.ts
git commit -m "feat(memory): seed propose-only Memory Guardian crew role + 4h sweep (P4-T1)"
```

---

### Task 2: Consolidation proposals + the forgetting primitive

Deliver the reversible tombstone primitive (`invalidatedAt` + `supersedes` edge), close retrieval against it, add the pure proposal builder, the Guardian's `propose_consolidation` tool, and the founder apply/revert path. This task owns the **retrieval-exclusion patch** because a supersede must hide the loser immediately — T4's "outdated" correction reuses the same primitive.

**Files:**
- Create: `server/src/services/memory-forget.ts` (invalidate / restore primitive)
- Create: `server/src/services/memory-consolidation.ts` (pure builder + apply/revert)
- Create: `server/src/services/internal-agent/tools/memory-propose-consolidation.ts` (Guardian tool)
- Modify: `server/src/services/memory.ts` (`buildConditions` in `searchMultiPath` + `searchSemantic` conditions)
- Modify: `server/src/services/internal-agent/tools/memory-find-similar.ts` (add `isNull(invalidatedAt)` guard)
- Modify: the tool registry that lists memory tools (`server/src/services/internal-agent/tools/memory-tools.ts` or `tool-registry.ts`) to register `proposeConsolidationTool`
- Modify: `server/src/routes/memory.ts` (apply/revert routes)
- Test: `server/src/__tests__/memory-consolidation.test.ts` (unit — builder)
- Test: `server/src/__tests__/memory-forget-retrieval.integration.test.ts` (embedded-pg)

- [ ] **Step 1: Retrieval-exclusion patch (write the failing integration test first)**

Create `server/src/__tests__/memory-forget-retrieval.integration.test.ts` (copy the embedded-Postgres boot header verbatim from `memory-version-race.integration.test.ts` — same `EmbeddedPostgres` ctor, `applyPendingMigrations`, Windows collect-and-skip, `initdbFlags: ["--encoding=UTF8","--locale=C"]`). Core case:

```ts
it("an item with invalidated_at set never returns from searchMultiPath", async () => {
  if (setupError) return; // Windows skip
  const svc = memoryService(db);
  const id = freshItemId("100000000001");
  await db.execute(sql`
    INSERT INTO memory_items (id, company_id, title, content, category, source, status, created_by, layer)
    VALUES (${id}, ${companyId}, 'Deploys use blue-green', 'blue-green rollout', 'reference', 'founder', 'approved', 'founder-1', 'domain')
  `);
  // Visible before invalidation.
  const before = await svc.searchMultiPath(companyId, "blue-green", { enableSemantic: false });
  expect(before.some((r) => r.id === id)).toBe(true);
  // Tombstone it.
  await db.execute(sql`UPDATE memory_items SET invalidated_at = now() WHERE id = ${id}`);
  // Gone from the very next retrieval; row still present in the table (history).
  const after = await svc.searchMultiPath(companyId, "blue-green", { enableSemantic: false });
  expect(after.some((r) => r.id === id)).toBe(false);
  const [row] = await db.execute(sql`SELECT id, invalidated_at FROM memory_items WHERE id = ${id}`) as any;
  expect(row).toBeTruthy(); // preserved
});
```

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-forget-retrieval.integration.test.ts`
Expected (Linux/embedded-pg): FAIL — the tombstoned row still returns.

Then patch `server/src/services/memory.ts`. In `searchMultiPath`'s `buildConditions()` (~line 585), add the guard to the base `conds` array:

```ts
        const conds = [
          eq(memoryItems.companyId, companyId),
          eq(memoryItems.status, "approved"),
          or(isNull(memoryItems.expiresAt), gt(memoryItems.expiresAt, sql`now()`))!,
          // P4: correction/forgetting — tombstoned items never surface (history kept).
          isNull(memoryItems.invalidatedAt),
        ];
```

Apply the same `isNull(memoryItems.invalidatedAt)` line to the `searchSemantic` conditions block (~line 505-524) and to the `conditions` array in `memory-find-similar.ts` (`find_similar_memory_hnsw`, ~line 101 — `isNull` is already imported there). Re-run the integration test → PASS. (`isNull` is already imported in `memory.ts`.)

- [ ] **Step 2: The forgetting primitive**

Create `server/src/services/memory-forget.ts`:

```ts
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { memoryItems, memoryRelations } from "@armyofagents/db";
import { logActivity } from "./activity-log.js";

export type ForgetReason = "wrong" | "outdated" | "superseded";

export interface ForgetOptions {
  reason: ForgetReason;
  /** Winner item that replaces this one (only for reason='superseded'). */
  supersededByItemId?: string | null;
  actor: { actorType: string; actorId: string; agentId?: string | null };
}

/**
 * Tombstone a memory item: set invalidatedAt so retrieval excludes it
 * immediately, while the row (history) stays. For a supersede, also add a
 * memory_relations `supersedes` edge (from = winner, to = this loser).
 * Idempotent: re-forgetting an already-invalidated item is a no-op.
 * Reversible via restoreInvalidatedItem.
 */
export async function invalidateMemoryItem(
  db: Db,
  companyId: string,
  itemId: string,
  opts: ForgetOptions,
): Promise<{ ok: boolean }> {
  const [item] = await db
    .select({ id: memoryItems.id, title: memoryItems.title, invalidatedAt: memoryItems.invalidatedAt })
    .from(memoryItems)
    .where(and(eq(memoryItems.companyId, companyId), eq(memoryItems.id, itemId)))
    .limit(1);
  if (!item) return { ok: false };
  if (item.invalidatedAt != null) return { ok: true }; // already forgotten

  await db
    .update(memoryItems)
    .set({ invalidatedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(memoryItems.companyId, companyId), eq(memoryItems.id, itemId)));

  if (opts.reason === "superseded" && opts.supersededByItemId) {
    await db
      .insert(memoryRelations)
      .values({
        companyId,
        fromItemId: opts.supersededByItemId,
        toItemId: itemId,
        kind: "supersedes",
        createdBy: opts.actor.agentId ?? opts.actor.actorId,
      })
      .onConflictDoNothing(); // memory_relations_from_to_kind_uq
  }

  await logActivity(db, {
    companyId,
    actorType: opts.actor.actorType,
    actorId: opts.actor.actorId,
    agentId: opts.actor.agentId ?? null,
    action: "memory.invalidated",
    entityType: "memory_item",
    entityId: itemId,
    details: { title: item.title, reason: opts.reason, supersededByItemId: opts.supersededByItemId ?? null },
  });
  return { ok: true };
}

/** Reverse invalidateMemoryItem: clear the tombstone + drop any supersedes edge. */
export async function restoreInvalidatedItem(
  db: Db,
  companyId: string,
  itemId: string,
  actor: { actorType: string; actorId: string; agentId?: string | null },
): Promise<{ ok: boolean }> {
  const [item] = await db
    .select({ id: memoryItems.id, title: memoryItems.title })
    .from(memoryItems)
    .where(and(eq(memoryItems.companyId, companyId), eq(memoryItems.id, itemId)))
    .limit(1);
  if (!item) return { ok: false };

  await db
    .update(memoryItems)
    .set({ invalidatedAt: null, updatedAt: new Date() })
    .where(and(eq(memoryItems.companyId, companyId), eq(memoryItems.id, itemId)));

  await db
    .delete(memoryRelations)
    .where(and(
      eq(memoryRelations.companyId, companyId),
      eq(memoryRelations.toItemId, itemId),
      eq(memoryRelations.kind, "supersedes"),
    ));

  await logActivity(db, {
    companyId,
    actorType: actor.actorType,
    actorId: actor.actorId,
    agentId: actor.agentId ?? null,
    action: "memory.restored",
    entityType: "memory_item",
    entityId: itemId,
    details: { title: item.title, reason: "un-forgotten" },
  });
  return { ok: true };
}
```

- [ ] **Step 3: Pure consolidation-proposal builder (write the failing unit test first)**

Create `server/src/__tests__/memory-consolidation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildConsolidationProposal } from "../services/memory-consolidation.js";

describe("buildConsolidationProposal", () => {
  it("builds a pending memory_gap suggestion payload for a supersede", () => {
    const p = buildConsolidationProposal({
      winnerItemId: "w1",
      loserItemIds: ["l1", "l2"],
      mode: "supersede",
      rationale: "l1/l2 are stale copies of w1",
    });
    expect(p.category).toBe("memory_gap");
    expect(p.actionType).toBe("consolidate_memory");
    expect(p.actionPayload).toMatchObject({ winnerItemId: "w1", loserItemIds: ["l1", "l2"], mode: "supersede" });
    expect(p.relatedMemoryItemId).toBe("w1");
    expect(p.dedupeKey).toBe("memory_gap:consolidate:w1:l1,l2"); // sorted, deterministic
  });

  it("throws when a loser equals the winner or the loser list is empty", () => {
    expect(() => buildConsolidationProposal({ winnerItemId: "w1", loserItemIds: [], mode: "merge" })).toThrow();
    expect(() => buildConsolidationProposal({ winnerItemId: "w1", loserItemIds: ["w1"], mode: "merge" })).toThrow();
  });

  it("dedupeKey is order-independent", () => {
    const a = buildConsolidationProposal({ winnerItemId: "w", loserItemIds: ["b", "a"], mode: "supersede" });
    const b = buildConsolidationProposal({ winnerItemId: "w", loserItemIds: ["a", "b"], mode: "supersede" });
    expect(a.dedupeKey).toBe(b.dedupeKey);
  });
});
```

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-consolidation.test.ts`
Expected: FAIL — `Cannot find module '../services/memory-consolidation.js'`.

- [ ] **Step 4: Implement the builder + apply/revert**

Create `server/src/services/memory-consolidation.ts`:

```ts
import { and, eq } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { suggestions } from "@armyofagents/db";
import { invalidateMemoryItem, restoreInvalidatedItem } from "./memory-forget.js";

export type ConsolidationMode = "merge" | "supersede";

export interface ConsolidationProposalInput {
  winnerItemId: string;
  loserItemIds: string[];
  mode: ConsolidationMode;
  rationale?: string | null;
}

export interface ConsolidationProposal {
  category: "memory_gap";
  actionType: "consolidate_memory";
  dedupeKey: string;
  title: string;
  evidence: string;
  relatedMemoryItemId: string;
  actionPayload: {
    winnerItemId: string;
    loserItemIds: string[];
    mode: ConsolidationMode;
    rationale: string | null;
  };
}

/** Pure: normalize + validate a Guardian consolidation into a pending suggestion payload. */
export function buildConsolidationProposal(input: ConsolidationProposalInput): ConsolidationProposal {
  const losers = [...new Set(input.loserItemIds)].sort();
  if (losers.length === 0) throw new Error("consolidation needs at least one loser item");
  if (losers.includes(input.winnerItemId)) throw new Error("winner cannot also be a loser");
  if (input.mode !== "merge" && input.mode !== "supersede") throw new Error(`invalid mode '${input.mode}'`);
  return {
    category: "memory_gap",
    actionType: "consolidate_memory",
    dedupeKey: `memory_gap:consolidate:${input.winnerItemId}:${losers.join(",")}`,
    title: `Consolidate ${losers.length} memory item${losers.length === 1 ? "" : "s"} into one`,
    evidence: input.rationale?.trim() || `${input.mode === "supersede" ? "Supersede" : "Merge"} ${losers.length} item(s) under ${input.winnerItemId}.`,
    relatedMemoryItemId: input.winnerItemId,
    actionPayload: { winnerItemId: input.winnerItemId, loserItemIds: losers, mode: input.mode, rationale: input.rationale ?? null },
  };
}

/**
 * Founder-approved apply: tombstone every loser + add a supersedes edge to the
 * winner. Content is NOT auto-rewritten (v1) — a 'merge' surfaces the winner to
 * the founder for a manual edit; this keeps apply fully reversible. Returns the
 * loser ids that were invalidated.
 */
export async function applyConsolidation(
  db: Db,
  companyId: string,
  payload: ConsolidationProposal["actionPayload"],
  actor: { actorType: string; actorId: string; agentId?: string | null },
): Promise<{ invalidated: string[] }> {
  const invalidated: string[] = [];
  for (const loserId of payload.loserItemIds) {
    const r = await invalidateMemoryItem(db, companyId, loserId, {
      reason: "superseded",
      supersededByItemId: payload.winnerItemId,
      actor,
    });
    if (r.ok) invalidated.push(loserId);
  }
  return { invalidated };
}

/** Reverse applyConsolidation: restore every loser (clears tombstone + drops edge). */
export async function revertConsolidation(
  db: Db,
  companyId: string,
  payload: ConsolidationProposal["actionPayload"],
  actor: { actorType: string; actorId: string; agentId?: string | null },
): Promise<{ restored: string[] }> {
  const restored: string[] = [];
  for (const loserId of payload.loserItemIds) {
    const r = await restoreInvalidatedItem(db, companyId, loserId, actor);
    if (r.ok) restored.push(loserId);
  }
  return { restored };
}
```

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-consolidation.test.ts` → PASS.

- [ ] **Step 5: The Guardian's `propose_consolidation` tool**

Create `server/src/services/internal-agent/tools/memory-propose-consolidation.ts` (shape mirrors `memory-archive-stale.ts` — an `AgentTool`). It calls `buildConsolidationProposal`, then inserts a `suggestions` row with `status:"pending"` and `.onConflictDoNothing()` (dedupeKey). `requiresConfirmation: false` (proposing is safe), `requiredRole: "team_member"`:

```ts
import { suggestions } from "@armyofagents/db";
import type { AgentTool } from "../types.js";
import { buildConsolidationProposal, type ConsolidationMode } from "../../memory-consolidation.js";

export const proposeConsolidationTool: AgentTool = {
  name: "propose_consolidation",
  description:
    "Propose consolidating duplicate/superseded memory items. Writes a PENDING suggestion " +
    "for the founder to approve; never applies changes itself.",
  parameters: {
    type: "object",
    properties: {
      winnerItemId: { type: "string", description: "Item to KEEP (required)" },
      loserItemIds: { type: "array", items: { type: "string" }, description: "Item(s) it replaces (required)" },
      mode: { type: "string", enum: ["merge", "supersede"], description: "supersede | merge (required)" },
      rationale: { type: "string", description: "One-line why" },
    },
    required: ["winnerItemId", "loserItemIds", "mode"],
  },
  category: "memory",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const p = (params ?? {}) as { winnerItemId?: string; loserItemIds?: string[]; mode?: string; rationale?: string };
    let proposal;
    try {
      proposal = buildConsolidationProposal({
        winnerItemId: String(p.winnerItemId ?? ""),
        loserItemIds: Array.isArray(p.loserItemIds) ? p.loserItemIds.map(String) : [],
        mode: p.mode as ConsolidationMode,
        rationale: p.rationale ?? null,
      });
    } catch (err: any) {
      return { success: false, data: null, summary: err?.message ?? "invalid proposal", error: "INVALID_PARAMS" };
    }
    await ctx.db.insert(suggestions).values({
      companyId: ctx.companyId,
      category: proposal.category,
      actionType: proposal.actionType,
      dedupeKey: proposal.dedupeKey,
      title: proposal.title,
      evidence: proposal.evidence,
      status: "pending",
      relatedMemoryItemId: proposal.relatedMemoryItemId,
      actionPayload: proposal.actionPayload,
    }).onConflictDoNothing();
    return { success: true, data: proposal.actionPayload, summary: proposal.title };
  },
};
```

Register `proposeConsolidationTool` alongside the other memory tools (find the array that includes `archiveStaleMemoryTool` in `memory-tools.ts` / `tool-registry.ts` and add it). Confirm `pnpm gen:tools:check` still passes if the generated tool list is enforced (`server/src/onboarding-assets/commander/TOOLS.md` is generated — regenerate with `pnpm gen:tools:md` if drift is reported; the Guardian tool is crew-scoped, not a Commander tool, so verify whether it must appear in `tools.json` before regenerating).

- [ ] **Step 6: Apply/revert routes**

In `server/src/routes/memory.ts`, add two founder-gated routes (mirror the `/approve` handler's `assertMemoryApproval` + `getActorInfo` + `logActivity` pattern). They load the pending `consolidate_memory` suggestion by id, call `applyConsolidation` / `revertConsolidation`, and flip the suggestion `status` to `accepted` / `pending`:

```ts
router.post("/companies/:companyId/memory/consolidations/:suggestionId/apply", async (req, res) => {
  const companyId = req.params.companyId as string;
  assertCompanyAccess(req, companyId);
  await assertMemoryApproval(db, req, companyId, { layer: "domain", departmentId: null }); // founder/lead authority
  // ...load suggestion by id (category='memory_gap', actionType='consolidate_memory', status='pending')…
  const actor = getActorInfo(req);
  const result = await applyConsolidation(db, companyId, suggestion.actionPayload, actor);
  // …UPDATE suggestions SET status='accepted' WHERE id=:suggestionId…
  res.json({ ok: true, ...result });
});
// …/revert mirrors this, calling revertConsolidation and setting status back to 'pending'.
```

- [ ] **Step 7: Integration assertions for apply/revert**

Extend `memory-forget-retrieval.integration.test.ts` with a supersede round-trip:

```ts
it("apply supersede tombstones the loser + adds a supersedes edge; revert undoes both", async () => {
  if (setupError) return;
  const winner = freshItemId("200000000001");
  const loser = freshItemId("200000000002");
  // …INSERT both approved domain items…
  const payload = { winnerItemId: winner, loserItemIds: [loser], mode: "supersede" as const, rationale: null };
  const actor = { actorType: "user", actorId: "founder-1" };
  await applyConsolidation(db, companyId, payload, actor);
  // loser gone from retrieval; edge exists
  const after = await memoryService(db).searchMultiPath(companyId, "", { enableSemantic: false, enableKeyword: false });
  expect(after.some((r) => r.id === loser)).toBe(false);
  const [edge] = await db.execute(sql`SELECT * FROM memory_relations WHERE from_item_id=${winner} AND to_item_id=${loser} AND kind='supersedes'`) as any;
  expect(edge).toBeTruthy();
  // revert restores it + drops the edge
  await revertConsolidation(db, companyId, payload, actor);
  const back = await memoryService(db).searchMultiPath(companyId, "", { enableSemantic: false, enableKeyword: false });
  expect(back.some((r) => r.id === loser)).toBe(true);
  const edges = await db.execute(sql`SELECT * FROM memory_relations WHERE to_item_id=${loser} AND kind='supersedes'`) as any;
  expect(edges.length ?? edges.rowCount ?? 0).toBe(0);
});
```

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-forget-retrieval.integration.test.ts` (Linux/embedded-pg) → PASS. `pnpm --filter ./server typecheck` → PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/memory-forget.ts server/src/services/memory-consolidation.ts \
        server/src/services/internal-agent/tools/memory-propose-consolidation.ts \
        server/src/services/memory.ts server/src/services/internal-agent/tools/memory-find-similar.ts \
        server/src/services/internal-agent/tools/memory-tools.ts server/src/routes/memory.ts \
        server/src/__tests__/memory-consolidation.test.ts \
        server/src/__tests__/memory-forget-retrieval.integration.test.ts
git commit -m "feat(memory): consolidation proposals + reversible forgetting primitive; exclude invalidated from retrieval (P4-T2)"
```

---

### Task 3: Retention sweeper (evidence purge + working-memory TTL, legal-hold gated)

Deterministic, system-run janitor (no LLM). Purges the unbounded audit/evidence trail and tombstoned rows once past the retention window, and enforces the working-memory TTL via the existing `memory-lifecycle` logic. Gated per-company by `legalHold`.

**Files:**
- Create: `packages/db/src/schema/memory_settings.ts` (or **add columns** if P1 already created it — see cross-phase note)
- Modify: `packages/db/src/schema/index.ts` (export `memorySettings`)
- Generated: `packages/db/src/migrations/0NNN_*.sql`
- Create: `server/src/services/memory-retention.ts` (pure predicates + `runMemoryRetentionSweep`)
- Modify: `server/src/services/memory-lifecycle.ts` (add `purgeInvalidatedItems` + reuse `archiveExpiredWorkingMemory`) — optional if `runMemoryRetentionSweep` composes them directly
- Modify: `server/src/index.ts` (register the retention `setInterval`)
- Modify: `server/src/routes/internal-sweeps-dev.ts` (manual trigger)
- Test: `server/src/__tests__/memory-retention.test.ts` (unit — predicates)
- Test: `server/src/__tests__/memory-retention-sweep.integration.test.ts` (embedded-pg)

- [ ] **Step 1: Schema — `memory_settings`** *(check `git grep -l "memory_settings" packages/db/src/schema/` first)*

If the table does **not** exist, create `packages/db/src/schema/memory_settings.ts`:

```ts
import { pgTable, uuid, integer, boolean, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

/**
 * P4-T3 — per-company memory lifecycle config (one row per company).
 * If P1-T10 already landed this table for the autonomy dials, ADD only the
 * three retention columns below instead of creating it.
 */
export const memorySettings = pgTable(
  "memory_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Retention window for evidence + tombstoned rows (days). Default mirrors the
    // memory_retrievals doc ("trim after 90 days").
    retentionDays: integer("retention_days").notNull().default(90),
    // When true, the retention sweeper purges NOTHING for this company.
    legalHold: boolean("legal_hold").notNull().default(false),
    // Working-memory archive TTL (days). Matches memory-lifecycle WORKING_MEMORY_TTL_DAYS.
    workingMemoryTtlDays: integer("working_memory_ttl_days").notNull().default(7),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyUq: uniqueIndex("memory_settings_company_uq").on(table.companyId),
  }),
);
```

Export it from `packages/db/src/schema/index.ts`:

```ts
export { memorySettings } from "./memory_settings.js";
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new `packages/db/src/migrations/0NNN_*.sql` (number auto-assigned — **do not hardcode**; whatever is next after P0–P3's migrations) containing `CREATE TABLE "memory_settings"` (or `ADD COLUMN` statements if the table pre-existed), plus a `meta/` snapshot update. If drizzle reports a numbering collision, take the next free index.

Run: `pnpm --filter ./db typecheck` → PASS.

- [ ] **Step 3: Pure retention predicates (write the failing unit test first)**

Create `server/src/__tests__/memory-retention.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { shouldPurgeItem, shouldPurgeRetrieval } from "../services/memory-retention.js";

const now = new Date("2026-07-30T00:00:00Z");
const old = new Date("2026-01-01T00:00:00Z");   // ~210 days before now
const recent = new Date("2026-07-20T00:00:00Z"); // 10 days before now

describe("retention predicates", () => {
  it("legal hold blocks all purging", () => {
    const cfg = { retentionDays: 90, legalHold: true };
    expect(shouldPurgeItem({ status: "rejected", invalidatedAt: old, updatedAt: old }, cfg, now)).toBe(false);
    expect(shouldPurgeRetrieval({ createdAt: old }, cfg, now)).toBe(false);
  });

  it("purges invalidated/rejected items older than the window", () => {
    const cfg = { retentionDays: 90, legalHold: false };
    expect(shouldPurgeItem({ status: "approved", invalidatedAt: old, updatedAt: old }, cfg, now)).toBe(true);   // tombstoned + old
    expect(shouldPurgeItem({ status: "rejected", invalidatedAt: null, updatedAt: old }, cfg, now)).toBe(true);  // rejected + old
    expect(shouldPurgeItem({ status: "approved", invalidatedAt: recent, updatedAt: recent }, cfg, now)).toBe(false); // within window
    expect(shouldPurgeItem({ status: "approved", invalidatedAt: null, updatedAt: old }, cfg, now)).toBe(false); // live, never purge
  });

  it("purges audit rows older than the window", () => {
    const cfg = { retentionDays: 90, legalHold: false };
    expect(shouldPurgeRetrieval({ createdAt: old }, cfg, now)).toBe(true);
    expect(shouldPurgeRetrieval({ createdAt: recent }, cfg, now)).toBe(false);
  });
});
```

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-retention.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement predicates + the sweep**

Create `server/src/services/memory-retention.ts`:

```ts
import { and, eq, lt, or, isNotNull, inArray } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { companies, memoryItems, memoryRetrievals, memorySettings } from "@armyofagents/db";
import { memoryLifecycleService } from "./memory-lifecycle.js";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "memory-retention" });

export interface RetentionConfig { retentionDays: number; legalHold: boolean; }

function cutoff(cfg: RetentionConfig, now: Date): Date {
  return new Date(now.getTime() - cfg.retentionDays * 86_400_000);
}

/** A tombstoned OR rejected item is purgeable once its terminal timestamp is past the window. */
export function shouldPurgeItem(
  item: { status: string; invalidatedAt: Date | null; updatedAt: Date },
  cfg: RetentionConfig,
  now: Date,
): boolean {
  if (cfg.legalHold) return false;
  const terminal = item.invalidatedAt != null || item.status === "rejected";
  if (!terminal) return false;
  const ts = item.invalidatedAt ?? item.updatedAt;
  return ts < cutoff(cfg, now);
}

/** Audit rows are pure evidence — purge once older than the window. */
export function shouldPurgeRetrieval(row: { createdAt: Date }, cfg: RetentionConfig, now: Date): boolean {
  if (cfg.legalHold) return false;
  return row.createdAt < cutoff(cfg, now);
}

const DEFAULTS: RetentionConfig & { workingMemoryTtlDays: number } = {
  retentionDays: 90, legalHold: false, workingMemoryTtlDays: 7,
};

/**
 * Deterministic, system-run retention janitor. For every company:
 *  1) DELETE memory_retrievals older than retentionDays (unbounded audit log).
 *  2) DELETE memory_items that are tombstoned/rejected past retentionDays.
 *  3) Archive expired working memory (delegates to memory-lifecycle).
 * All skipped when the company's legalHold is set. Archived items (the restore
 * surface) are deliberately NOT purged.
 */
export async function runMemoryRetentionSweep(db: Db): Promise<void> {
  const lifecycle = memoryLifecycleService(db);
  const companyRows = await db.select({ id: companies.id }).from(companies);

  for (const c of companyRows) {
    const [row] = await db
      .select({ retentionDays: memorySettings.retentionDays, legalHold: memorySettings.legalHold, workingMemoryTtlDays: memorySettings.workingMemoryTtlDays })
      .from(memorySettings)
      .where(eq(memorySettings.companyId, c.id))
      .limit(1);
    const cfg: RetentionConfig = { retentionDays: row?.retentionDays ?? DEFAULTS.retentionDays, legalHold: row?.legalHold ?? DEFAULTS.legalHold };
    const now = new Date();

    if (!cfg.legalHold) {
      const cut = cutoff(cfg, now);
      await db.delete(memoryRetrievals).where(and(eq(memoryRetrievals.companyId, c.id), lt(memoryRetrievals.createdAt, cut)));
      await db.delete(memoryItems).where(and(
        eq(memoryItems.companyId, c.id),
        or(isNotNull(memoryItems.invalidatedAt), inArray(memoryItems.status, ["rejected"]))!,
        // terminal-ts guard: only rows whose invalidatedAt (or updatedAt for rejected) is past the window.
        lt(memoryItems.updatedAt, cut),
      ));
    }
    // Working-memory TTL (archive, not purge) — always runs; it is not a delete.
    try { await lifecycle.archiveExpiredWorkingMemory(c.id); } catch (err) { log.warn({ err, companyId: c.id }, "working-memory ttl archive failed"); }
  }
}
```

> **Implementation note:** the item-DELETE `WHERE` above approximates `shouldPurgeItem` in SQL (using `updatedAt` as the terminal proxy for tombstoned rows, since `invalidatedAt` is set on the same `updatedAt` write in T2). The pure predicate is the source of truth for the unit tests; keep the SQL guard's window equal to `retentionDays`. If you prefer exactness, add `lt(memoryItems.invalidatedAt, cut)` as an alternative branch.

Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-retention.test.ts` → PASS.

- [ ] **Step 5: Register the sweep + dev trigger**

In `server/src/index.ts`, add a retention tick (daily is enough — this is cheap deletes; use `24h`):

```ts
const MEMORY_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
let memoryRetentionSweepInFlight = false;
setInterval(() => {
  if (memoryRetentionSweepInFlight) return;
  memoryRetentionSweepInFlight = true;
  void runMemoryRetentionSweep(db as any)
    .catch((err) => logger.warn({ err }, "memory retention sweep tick failed"))
    .finally(() => { memoryRetentionSweepInFlight = false; });
}, MEMORY_RETENTION_SWEEP_INTERVAL_MS);
```

In `routes/internal-sweeps-dev.ts`, add `POST /internal/sweep/memory-retention` calling `runMemoryRetentionSweep` (mirror the memory-keeper handler).

- [ ] **Step 6: Integration test (embedded-pg)**

Create `server/src/__tests__/memory-retention-sweep.integration.test.ts` (copy the embedded-pg header). Cases:
1. A `memory_retrievals` row + a tombstoned item, both aged past `retentionDays`, are **gone** after `runMemoryRetentionSweep`; a recent tombstoned item **survives**.
2. With `memory_settings.legalHold = true`, nothing is purged even when aged.
3. A live (`invalidatedAt IS NULL`, `status='approved'`) item is never deleted.

Insert aged rows with explicit timestamps (`created_at`/`updated_at`/`invalidated_at = now() - interval '200 days'`). Run: `pnpm --filter ./server exec vitest run src/__tests__/memory-retention-sweep.integration.test.ts` (Linux) → PASS. `pnpm --filter ./server typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/memory_settings.ts packages/db/src/schema/index.ts packages/db/src/migrations \
        server/src/services/memory-retention.ts server/src/index.ts server/src/routes/internal-sweeps-dev.ts \
        server/src/__tests__/memory-retention.test.ts server/src/__tests__/memory-retention-sweep.integration.test.ts
git commit -m "feat(memory): retention janitor — evidence purge + working TTL, legal-hold gated (P4-T3)"
```

---

### Task 4: Correction / forgetting UX + routes

Founder-facing "this is wrong / outdated / superseded" over the T2 primitive: a route that sets `invalidatedAt` (→ excluded from retrieval immediately, history preserved) and a menu action + dialog in the Memory UI. This is the human half of **X2**.

**Files:**
- Modify: `server/src/routes/memory.ts` (forget + un-forget routes)
- Modify: `ui/src/api/memory.ts` (`memoryApi.forget` / `memoryApi.unforget`)
- Modify: `ui/src/components/memory/MemoryItemActions.tsx` (menu item + confirm dialog)
- Test: `ui/src/components/memory/__tests__/MemoryItemActions.test.tsx`

- [ ] **Step 1: Routes**

In `server/src/routes/memory.ts`, add (mirroring `/approve`'s gate + `getActorInfo` + `logActivity`; `invalidateMemoryItem`/`restoreInvalidatedItem` already log activity, so the route just enforces authority):

```ts
router.post("/companies/:companyId/memory/:id/forget", validate(forgetMemorySchema), async (req, res) => {
  const companyId = req.params.companyId as string;
  const id = req.params.id as string;
  assertCompanyAccess(req, companyId);
  const existing = await svc.getById(companyId, id);
  if (!existing) { res.status(404).json({ error: "Memory item not found" }); return; }
  // Forgetting durable knowledge is founder/lead authority (parallels /approve gating).
  await assertMemoryApproval(db, req, companyId, { layer: existing.layer, departmentId: existing.departmentId });
  const actor = getActorInfo(req);
  const result = await invalidateMemoryItem(db, companyId, id, {
    reason: req.body.reason,                       // "wrong" | "outdated" | "superseded"
    supersededByItemId: req.body.supersededByItemId ?? null,
    actor: { actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId },
  });
  if (!result.ok) { res.status(404).json({ error: "Memory item not found" }); return; }
  res.json({ ok: true });
});

router.post("/companies/:companyId/memory/:id/unforget", async (req, res) => {
  const companyId = req.params.companyId as string;
  const id = req.params.id as string;
  assertCompanyAccess(req, companyId);
  const existing = await svc.getById(companyId, id);
  if (!existing) { res.status(404).json({ error: "Memory item not found" }); return; }
  await assertMemoryApproval(db, req, companyId, { layer: existing.layer, departmentId: existing.departmentId });
  const actor = getActorInfo(req);
  await restoreInvalidatedItem(db, companyId, id, { actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId });
  res.json({ ok: true });
});
```

Add `forgetMemorySchema` (zod) near the other memory validators (`reason` enum `["wrong","outdated","superseded"]`, optional `supersededByItemId` uuid). Import `invalidateMemoryItem`, `restoreInvalidatedItem` from `../services/memory-forget.js`.

- [ ] **Step 2: API client**

In `ui/src/api/memory.ts`, add to the `memoryApi` object (mirror `setPinnedToTop`'s POST style):

```ts
  forget: (companyId: string, itemId: string, body: { reason: "wrong" | "outdated" | "superseded"; supersededByItemId?: string }) =>
    api.post<{ ok: boolean }>(`/companies/${companyId}/memory/${itemId}/forget`, body),
  unforget: (companyId: string, itemId: string) =>
    api.post<{ ok: boolean }>(`/companies/${companyId}/memory/${itemId}/unforget`, {}),
```

- [ ] **Step 3: UI action (write the failing test first)**

Create `ui/src/components/memory/__tests__/MemoryItemActions.test.tsx` (mirror `MemoryItemCard`/`MemoryItemRow` test setup — QueryClientProvider + ToastContext wrappers; spy on `memoryApi.forget`). Assert: opening the menu shows "Mark outdated…", clicking it and confirming calls `memoryApi.forget(companyId, itemId, { reason: "outdated" })`.

```ts
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
// …standard wrapper imports…
import { memoryApi } from "../../../api/memory";
import { MemoryItemActions } from "../MemoryItemActions";

describe("MemoryItemActions — forgetting", () => {
  it("Mark outdated calls memoryApi.forget with reason=outdated", async () => {
    const spy = vi.spyOn(memoryApi, "forget").mockResolvedValue({ ok: true });
    render(<Wrapper><MemoryItemActions companyId="c1" itemId="m1" currentFolderPath="" currentDepartmentId={null} founderPinnedToTop={false} item={fakeItem} /></Wrapper>);
    fireEvent.click(screen.getByLabelText("More actions"));
    fireEvent.click(screen.getByText(/mark outdated/i));
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("c1", "m1", { reason: "outdated" }));
  });
});
```

Run: `pnpm --filter ./ui exec vitest run src/components/memory/__tests__/MemoryItemActions.test.tsx` → FAIL (no such menu item yet).

- [ ] **Step 4: Implement the menu item + dialog**

In `MemoryItemActions.tsx`, add a `forget` mutation (`memoryApi.forget`, invalidate queries + success toast on settle — mirror the `pin` mutation) and a `DropdownMenuItem` ("Mark outdated…", using a `Ban`/`Archive` lucide icon) that opens a small confirm dialog. On confirm, call `forget.mutate({ reason: "outdated" })`. Keep the reason set minimal (outdated) for v1; wire the full `wrong | outdated | superseded` selector only if the design calls for it — the route already accepts all three.

Run: `pnpm --filter ./ui exec vitest run src/components/memory/__tests__/MemoryItemActions.test.tsx` → PASS. Then `pnpm --filter ./ui exec vitest run src/components/memory/__tests__/MemoryItemCard.test.tsx` (regression on the sibling that renders actions) → PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter ./server typecheck` → PASS.

```bash
git add server/src/routes/memory.ts ui/src/api/memory.ts \
        ui/src/components/memory/MemoryItemActions.tsx \
        ui/src/components/memory/__tests__/MemoryItemActions.test.tsx
git commit -m "feat(memory): correction/forgetting — mark wrong/outdated/superseded routes + UI (P4-T4)"
```

---

### Task 5: Export / import includes memory + folders

Add a `memory` section to the company portability bundle: approved memory items (mapped `departmentId → projectSlug`, with `folderPath`) + `memory_folders`. Import is **warn-and-continue** and idempotent (skip exact `(layer,title,folderPath)` dupes). Mirror the `workflowTemplates` optional-section wiring.

**Files:**
- Modify: `packages/shared/src/types/company-portability.ts` (include flag, manifest entries, counts)
- Modify: `server/src/services/company-portability.ts` (`DEFAULT_INCLUDE`, `KNOWN_SECTIONS`, `resolveInclude`, export serialize, import loop, preview counts)
- Test: `server/src/__tests__/company-portability-memory.integration.test.ts` (embedded-pg round-trip)

- [ ] **Step 1: Shared types**

In `packages/shared/src/types/company-portability.ts`:
- Add `memory?: boolean;` to `CompanyPortabilityInclude`.
- Add two manifest-entry interfaces + wire them into `CompanyPortabilityManifest` and the preview counts:

```ts
export interface CompanyPortabilityMemoryFolderManifestEntry {
  path: string;
  displayName: string;
  projectSlug: string | null;   // null = company-root folder
  icon: string | null;
  sortOrder: number;
  seedKey: string | null;
}

export interface CompanyPortabilityMemoryItemManifestEntry {
  title: string;
  content: string;
  category: string;
  source: string;
  layer: string | null;         // identity | domain | active_context
  visibility: string;
  priority: number;
  tags: string[];
  projectSlug: string | null;   // from departmentId
  folderPath: string;
  provenanceKind?: string | null;
}
```
```ts
// in CompanyPortabilityManifest:
  memory?: { folders: CompanyPortabilityMemoryFolderManifestEntry[]; items: CompanyPortabilityMemoryItemManifestEntry[] } | null;
// in CompanyPortabilityExportPreviewCounts:
  memoryFolders?: number;
  memoryItems?: number;
```

- [ ] **Step 2: Export serialize**

In `company-portability.ts`: add `memory: false` to `DEFAULT_INCLUDE`, `"memory"` to `KNOWN_SECTIONS`, and `memory: input?.memory ?? DEFAULT_INCLUDE.memory` to the include resolver (mirror the `workflowTemplates` lines). Add an export block after the `workflowTemplates` block (~line 1567). Export **approved** items in `identity|domain|active_context` (skip `working`/archived/invalidated — ephemeral/noise), mapping `departmentId → projectSlug` via the existing `projectIdToSlug` map:

```ts
if (include.memory) {
  const folderRows = (await db.select().from(memoryFolders).where(eq(memoryFolders.companyId, companyId))) as Record<string, unknown>[];
  const itemRows = (await db.select().from(memoryItems).where(and(
    eq(memoryItems.companyId, companyId),
    eq(memoryItems.status, "approved"),
    isNull(memoryItems.invalidatedAt),
    inArray(memoryItems.layer, ["identity", "domain", "active_context"]),
  ))) as Record<string, unknown>[];
  manifest.memory = {
    folders: folderRows.map((r) => serializeMemoryFolderRow(r, projectIdToSlug)),
    items: itemRows.map((r) => serializeMemoryItemRow(r, projectIdToSlug)),
  };
}
```

Add `serializeMemoryFolderRow` / `serializeMemoryItemRow` helpers (near `serializeWorkflowTemplateRow`) that map ids→slugs and null out anything not portable. Add the two counts to `previewExport`.

- [ ] **Step 3: Import (warn-and-continue)**

Add an import block after the `workflowTemplates` import (~line 3337). Guard `include.memory === true && sourceManifest.memory`. Create folders first (`memory_folders`, resolving `projectSlug → departmentId` via the target company's slug map; `.onConflictDoNothing()` on the unique path index), then items (`memory_items`, `status: "approved"`, `createdBy: actorUserId ?? "importer"`), **skipping** any item whose `(layer,title,folderPath)` already exists in the target (idempotent). On an unresolvable `projectSlug`, file the item at company root (`departmentId: null`) and push a `deprecated_field` warning — never throw. Unknown-section handling is already covered by `KNOWN_SECTIONS` (adding `"memory"` stops the spurious `unknown_section` warning for bundles that carry it).

```ts
if (include.memory === true && sourceManifest.memory) {
  const projectSlugToId = /* invert the target company's project slug map */;
  let importedItems = 0, importedFolders = 0;
  for (const f of sourceManifest.memory.folders) {
    const departmentId = f.projectSlug ? (projectSlugToId.get(f.projectSlug) ?? null) : null;
    await db.insert(memoryFolders).values({ companyId: targetCompany.id, departmentId, path: f.path, displayName: f.displayName, icon: f.icon ?? null, sortOrder: f.sortOrder ?? 0, seedKey: f.seedKey ?? null }).onConflictDoNothing();
    importedFolders++;
  }
  for (const it of sourceManifest.memory.items) {
    const departmentId = it.projectSlug ? (projectSlugToId.get(it.projectSlug) ?? null) : null;
    if (it.projectSlug && departmentId === null) {
      warnings.push({ kind: "deprecated_field", section: "memory", message: `Memory item "${it.title}" referenced unknown department "${it.projectSlug}"; filed at company root.` });
    }
    // idempotent skip on (layer,title,folderPath)
    const [dup] = await db.select({ id: memoryItems.id }).from(memoryItems).where(and(
      eq(memoryItems.companyId, targetCompany.id), eq(memoryItems.title, it.title),
      it.layer ? eq(memoryItems.layer, it.layer) : isNull(memoryItems.layer), eq(memoryItems.folderPath, it.folderPath ?? ""),
    )).limit(1);
    if (dup) continue;
    await db.insert(memoryItems).values({
      companyId: targetCompany.id, title: it.title, content: it.content, category: it.category, source: it.source,
      status: "approved", layer: it.layer ?? null, visibility: it.visibility ?? "scoped", priority: it.priority ?? 0,
      tags: it.tags ?? [], departmentId, folderPath: it.folderPath ?? "", provenanceKind: it.provenanceKind ?? null,
      createdBy: actorUserId ?? "importer",
    } as never);
    importedItems++;
  }
  if (importedItems > 0 || importedFolders > 0) {
    warnings.push({ kind: "large_volume", section: "memory", message: `Imported ${importedFolders} folders + ${importedItems} memory items.`, count: importedItems });
  }
}
```

> **Scope note:** memory import intentionally uses a **simpler** collision model than agents/workflow-templates (skip exact dupes; no rename/replace strategies, no per-item plan rows). Memory is additive knowledge — a skip-on-dup insert is the right idempotency contract and keeps T5 tractable. Document this in the import warning copy.

- [ ] **Step 4: Integration round-trip test**

Create `server/src/__tests__/company-portability-memory.integration.test.ts` (copy the embedded-pg header; reference `company-portability-internal-agent.test.ts` for the export→import harness). Seed a source company with a department, two approved memory items (one `domain` scoped to the department with a `folderPath`, one `identity` at company root) and one seeded folder. Export with `{ memory: true }`, import into a fresh company, assert:
1. Both memory items exist in the target with the correct `layer`, `folderPath`, and the domain item mapped to the target's department id.
2. The folder round-trips.
3. Re-importing the same bundle adds **zero** new items (idempotent skip).

Run: `pnpm --filter ./server exec vitest run src/__tests__/company-portability-memory.integration.test.ts` (Linux) → PASS. `pnpm --filter ./server typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/company-portability.ts server/src/services/company-portability.ts \
        server/src/__tests__/company-portability-memory.integration.test.ts
git commit -m "feat(memory): export/import includes memory items + folders, warn-and-continue (P4-T5)"
```

---

### Task 6: Real-run acceptance (X2 + X3)

The live real-CLI gate for P4, on top of the automated tests. References `2026-07-30-memory-enterprise-real-run-acceptance.md` scenarios **X2** and **X3**. This is a runbook + a recorded result, not new code.

**Files:**
- Create: `docs/aoa/plans/2026-07-30-memory-enterprise-p4-realrun-log.md` (fill in during the run)

- [ ] **Step 1: Preconditions**

Boot a `local_trusted` instance with a real CLI logged in (Windows: detached-worktree + embedded-pg, short path, `AOA_HOME`/`PORT`/`AOA_EMBEDDED_POSTGRES_PORT`). Set `llm:openai` in Settings → Memory (embeddings on; else note keyword-only degrade). Seed the fixture from the runbook (company `Acme`, depts **Alpha**/**Beta**, `org-alpha`, crew incl. **Memory Guardian**, Commander). Confirm the Guardian seeded: `GET /api/internal/triggers/:companyId` shows a `kind:'sweep', config.role:'memory_guardian'` row for "Memory Guardian".

- [ ] **Step 2: X2 — correction / forgetting**

Add an approved Alpha `domain` item (Quick Add). Confirm an `org-alpha` run (O2) retrieves it (context dump / `memory_retrievals`). Then in the Memory UI use the item's **Mark outdated…** action (T4). Verify:
- **DB:** `memory_items.invalidated_at` is now non-null for that row; the row still exists (history preserved).
- **Next retrieval:** re-run `org-alpha` (or ask Commander a question whose answer was that item) → the item is **absent** from context and from any `memory.search` the agent makes.
- Record both observations (with the row id + timestamps) in the run log. **X2 passes** iff invalidated → gone from next retrieval, still in the table.

- [ ] **Step 3: X3 — Guardian consolidation proposal**

Create a near-duplicate of an existing approved memory item (e.g. two items stating the same convention slightly differently). Fire the Guardian sweep on demand: `POST /api/internal/sweep/guardian`, then let the queued wakeup run (check `GET /api/internal/wakeups/:agentId`). Verify:
- A **pending** `suggestions` row appears (`actionType='consolidate_memory'`, payload naming a `winnerItemId` + `loserItemIds`) — surfaced in Home/Inbox.
- **No** memory item changed: the near-duplicate is still `approved`, `invalidated_at IS NULL` (the Guardian never auto-applied).
- Approve the proposal via the apply route (T2) → the loser gets `invalidated_at` + a `memory_relations` `supersedes` edge; revert restores it.
- Record in the run log. **X3 passes** iff the Guardian only ever raised a pending proposal and never mutated memory itself.

- [ ] **Step 4: Record + commit the log**

Fill `2026-07-30-memory-enterprise-p4-realrun-log.md` with the fixture, the exact DB rows/ids observed, and PASS/FAIL for X2 + X3.

```bash
git add docs/aoa/plans/2026-07-30-memory-enterprise-p4-realrun-log.md
git commit -m "docs(memory): P4 real-run acceptance log — X2 + X3 (P4-T6)"
```

---

## P4 exit criteria

- [ ] **Guardian is propose-only.** `ensure-guardian.test.ts` green; `GUARDIAN_TOOL_ALLOWLIST` contains no approve/apply/delete/write tool; the Guardian seeds with a `sweep`/`memory_guardian` trigger and appears in `ensureCrewAgents` + `CREW_NAMES`.
- [ ] **Consolidation proposals appear as pending.** `propose_consolidation` writes a `status='pending'` `suggestions` row (X3, automated builder unit test + real-run).
- [ ] **Invalidated items vanish from retrieval but stay in history.** `memory-forget-retrieval.integration.test.ts` green: a row with `invalidated_at` set never returns from `searchMultiPath`, and the row is still present. (X2.)
- [ ] **Supersede is reversible.** apply → tombstone + `supersedes` edge; revert → restored + edge dropped (integration green).
- [ ] **Retention respects window + legal hold.** `memory-retention.test.ts` (predicates) + `memory-retention-sweep.integration.test.ts` green; working-memory TTL still archives.
- [ ] **Export round-trips memory.** `company-portability-memory.integration.test.ts` green; import is idempotent + warn-and-continue.
- [ ] `pnpm --filter ./server typecheck`, `pnpm --filter ./db typecheck`, and `pnpm --filter ./ui exec vitest run` for the touched UI test all green.
- [ ] `pnpm db:generate` produced an additive migration (new `memory_settings` table or additive columns only — no `DROP`).

## Self-review checklist

- **Spec coverage:** overview P4 T1–T5 → Tasks 1–5; the required real-run task (X2+X3) → Task 6. Every requirement item (Guardian seed, consolidation dedup/merge/supersede, retention + legal-hold + working-TTL, correction/forget routes + UI, export/import memory+folders) maps to a step.
- **No placeholders:** every code step shows real code grounded in the read files (`ensure-librarian.ts`, `sweep-memory-keeper.ts`, `memory-lifecycle.ts`, `memory.ts` `buildConditions`, `memory_relations`, `company-portability.ts` workflowTemplates section, `MemoryItemActions.tsx`); every command shows expected output.
- **Type consistency:** consumes P0's `invalidatedAt`; reuses `MemoryTier`/`tierForItem` naming from P0 where referenced; `confidence` untouched (integer). New `ConsolidationMode`/`ForgetReason`/`RetentionConfig` are local and named once.
- **Reversibility:** every destructive-looking op (supersede, consolidation apply, correction) has a paired revert/unforget; retention purge is the only true delete and is gated by `legalHold` + a configurable window, and never touches `archived` (the restore surface).
- **Locked-decision guards:** crew stays propose-only (Decisions #15/#16/#52 — Guardian has no approve tool); Drizzle-only schema + `pnpm db:generate`; no new hosted-API call (Rule #11 — the Guardian's dedup uses existing embedding-backed `find_similar_memory`); `issues`/wire-protocol untouched.
- **Cross-scope safety:** retrieval exclusion is applied inside `buildConditions` (pre-ranking), consistent with P1's "RBAC-in-SQL before search" principle — a forgotten item can't leak via ranking.
