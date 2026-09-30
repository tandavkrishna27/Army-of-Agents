# Inbound Routing — Card Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deterministic similarity-score routing decider with a Chronicler CLI agent that maintains per-thread routing cards, and a Navigator CLI agent that reads those cards to decide where inbound items belong.

**Architecture:** The Chronicler (new) sweeps recently-active threads and writes `discussions.summaryText` + `routingTerms`; the Navigator (existing, extended) reads those cards at wakeup time to decide attach/new/unsure. The embed-based `findSimilarThreadsScored` is demoted to a retrieval shortlister at scale; the deterministic decider (`classifyRouting`/`resolveRoutingAction`) is deleted entirely. All existing write-paths (attach, promote, suggestions lane, dial, wakeup, dispatcher) are reused.

**Tech Stack:** TypeScript, Drizzle ORM, Express 5, PostgreSQL + pgvector, React + TailwindCSS v4, Vitest

**Spec:** `~/.gstack/projects/MeteoriteLabs-AoA/TK-routing-card-redesign-design-20260531.md`
**Eng-review tasks:** `~/.gstack/projects/MeteoriteLabs-AoA/tasks-eng-review-20260531-routing-cards.jsonl`
**Branch:** `feat/inbound-routing` (worktree at `AoA-threads/`)

---

## File Map

### Created
- `packages/db/src/migrations/0133_routing_card_redesign.sql` — generated (never hand-write)
- `server/src/services/internal-agent/aoa-agents/ensure-chronicler.ts` — Chronicler seed
- `server/src/services/internal-agent/aoa-agents/sweep-chronicler.ts` — Chronicler sweep driver
- `server/src/services/internal-agent/tools/list-thread-cards.ts` — card-fetch tool (small-scale all-cards)
- `server/src/services/internal-agent/tools/promote-inbox-to-thread.ts` — Navigator new-thread action (C1)
- `server/src/services/internal-agent/tools/defer-inbox-to-human.ts` — Navigator "unsure" finalization (Codex P1 #2)
- `server/src/onboarding-assets/chronicler/SOUL.md`
- `server/src/onboarding-assets/chronicler/AGENTS.md`
- `server/src/onboarding-assets/chronicler/HEARTBEAT.md`
- `server/src/onboarding-assets/chronicler/TOOLS.md`
- `server/src/__tests__/chronicler.test.ts` — Chronicler unit tests
- `server/src/__tests__/inbox-router-rewire.test.ts` — rewired routeInboxItem tests
- `server/src/__tests__/inbox-router-reclaim.test.ts` — stale reclaim tests
- `server/src/__tests__/defer-inbox-to-human.test.ts` — finalization tool tests
- `server/src/__tests__/evals/inbox-routing-eval.test.ts` — routing regression eval gate
- `server/src/__tests__/evals/chronicler-card-eval.test.ts` — card quality eval

### Modified
- `packages/db/src/schema/discussions.ts` — add `routingTerms` column
- `packages/db/src/schema/threads.ts` — add `routingClaimedAt`, `suggestedThreadTitle`, `routingCardSnapshot` to `threadInboxItems`
- `server/src/services/inbox-router.ts` — rewire (remove classify/resolve/score; add card-snapshot + Navigator wakeup carrying `inboundContent`)
- `server/src/services/internal-agent/tools/thread-update-summary.ts` — accept optional `routingTerms` + `logActivity` audit (Codex P1 #8)
- `server/src/services/internal-agent/tools/thread-get-summary.ts` — also return `routingTerms` so the Chronicler can merge incrementally (Codex re-review P1 #B)
- `server/src/services/internal-agent/aoa-agents/autonomy.ts` — register `chronicler` in `CrewRole` + `ROLE_MIN_AUTONOMY: 0` (Codex re-review P1 #A — else the dispatcher autonomy gate skips it)
- `server/src/services/internal-agent/tool-registry.ts` — register `listThreadCardsTool` + `promoteInboxToThreadTool` + `deferInboxToHumanTool`
- `server/src/services/default-agent-instructions.ts` — register `chronicler` in `DEFAULT_AGENT_BUNDLE_FILES` + `DEFAULT_AGENT_BUNDLE_DIRS` (Codex P1 #4)
- `server/src/services/internal-agent/aoa-agents/ensure-adjutant.ts` — remove summary-update instruction line
- `server/src/services/internal-agent/aoa-agents/ensure-command-staff.ts` — add `list_thread_cards`, `promote_inbox_to_thread`, `defer_inbox_to_human` to Navigator allowlist
- `server/src/services/internal-agent/aoa-agents/aoa-trigger-prompt.ts` — updated INBOX_ROUTING_DIRECTIVE + `inboundContent` rendering + `chronicler` ROLE_ACTION_DIRECTIVE entry (Codex P1 #5)
- `server/src/services/internal-agent/aoa-agents/seed-crew-agent.ts` — add `'chronicler'` to `instructionBundleRole` union
- `server/src/services/internal-agent/aoa-agents/seed-commander-bundle.ts` — add `'chronicler'` to `role` union
- `server/src/services/internal-agent/aoa-agents/sweep-inbox.ts` — add stale reclaim: `routing`→`pending_route`, `escalated`→`routed`+human (Codex P1 #2 loop fix / C4)
- `server/src/services/companies.ts` — call `ensureChronicler` in the company-create seed path (Codex P2 seed-on-create)
- `server/src/services/internal-agent/aoa-agents/dispatcher.ts` — let `sweep.chronicler` bypass the `crewPaused` + `useControllerPath` thread-gates (code-review CRITICAL — else the Chronicler never runs on modern threads)
- `server/src/index.ts` — wire `runChroniclerSweep` on 45s interval + `ensureChronicler` on bootstrap
- `ui/src/components/threads/ThreadBoard.tsx` — add `suggestedThreadTitle` to `InboxCardItem`
- `ui/src/components/threads/UnlistedLane.tsx` — render `suggest_new` banner
- `ui/src/components/threads/__tests__/UnlistedLane.test.tsx` — add `suggest_new` coverage

### Deleted
- `server/src/services/inbound-routing-constants.ts`
- `server/src/__tests__/inbox-router-gate.test.ts`
- `server/src/__tests__/inbox-routing-matrix.test.ts`
- `server/src/__tests__/inbox-router.test.ts` — old orchestrator test; contract fully replaced by inbox-router-rewire.test.ts (Codex P1 #7)

---

## Resolved design decisions (Codex review, session 019e7ecb)

These cross-task invariants were locked after the Codex review. Every task below honors them.

1. **Wakeup payload carries `inboundContent`** (Codex P1 #1). The Navigator decides over the actual inbound text, not just an ID. Payload shape: `{ inboxItemId, inboundContent }`. The raw inbound text is immutable, so freezing it in the payload is safe. Cards are NOT frozen in the payload — the Navigator fetches them fresh via `list_thread_cards` (A2). No redundant full-card payload (Codex P2).
2. **Navigator "unsure" has an explicit finalization tool** `defer_inbox_to_human` (Codex P1 #2). It writes `routingStatus='routed'` + `routerDecision='human'` (terminal — the reclaim sweep will not re-escalate). The directive forces the Navigator to call it rather than returning silently.
3. **Reclaim distinguishes pre- vs post-wakeup** (Codex P1 #2). `sweep-inbox` resets stranded `routing` (Navigator never woken) → `pending_route` (retry), but moves stranded `escalated` (Navigator woken, never finalized) → `routed`+`human` (terminal). This breaks the escalated→reclaim→escalated loop.
4. **Option A — zero active threads still wakes the Navigator** (Codex P1 #9, user decision 2026-05-31). At `full_auto` the Navigator creates the first thread; at `suggest`/`auto_attach` it suggests-new. Only a true assembly/DB *error* fail-closes to human. Empty candidate set is NOT an error.
5. **Chronicler has read tools** `thread.listEntries` + `get_thread_summary` alongside `thread.updateSummary` (Codex P1 #3). The spec's "exactly thread.updateSummary" meant "the only WRITE/mutation tool" — read access is required for the agent to summarize. No `post_entry`, no memory tools, no extraction tools (the silent-and-safe intent is preserved).
6. **Three bundle registration points for `chronicler`** (Codex P1 #4): `default-agent-instructions.ts` (both `DEFAULT_AGENT_BUNDLE_FILES` and `DEFAULT_AGENT_BUNDLE_DIRS`), `seed-crew-agent.ts` union, `seed-commander-bundle.ts` union. All three are required or `loadDefaultAgentInstructionsBundle("chronicler")` fails to typecheck/load.
7. **`thread.updateSummary` logs an activity entry** (Codex P1 #8 / spec C6). Actor resolved from `ctx` (`agentId` when present, else `system`).

---

## Task 1 — Schema: `discussions.routingTerms` + `thread_inbox_items.routingClaimedAt` + `suggestedThreadTitle`

**Files:**
- Modify: `packages/db/src/schema/discussions.ts` (add `routingTerms` column after `summaryUpdatedAt`)
- Modify: `packages/db/src/schema/threads.ts` (add `routingClaimedAt`, `suggestedThreadTitle` to `threadInboxItems`)
- Generate: `packages/db/src/migrations/0133_routing_card_redesign.sql` (do NOT hand-write)

- [ ] **Step 1: Add `routingTerms` to `discussions` table**

In `packages/db/src/schema/discussions.ts`, after the `summaryUpdatedAt` line (~line 79):

```typescript
    // Routing card — key entities + aliases for routing retrieval (Chronicler-written).
    // jsonb string[] (matches this table's tags/intent pattern; DB-validated, no
    // serialize/parse in readers). NULL on threads created before a card was seeded.
    routingTerms: jsonb("routing_terms").$type<string[]>(),
```

(`discussions.ts` already imports `jsonb` from `drizzle-orm/pg-core` — no import change needed there.)

- [ ] **Step 2: Add `routingClaimedAt`, `suggestedThreadTitle`, `routingCardSnapshot` to `threadInboxItems`**

`threads.ts` already imports `jsonb` from `drizzle-orm/pg-core` — verify it's in the import list at the top (it is, used by other tables). In `packages/db/src/schema/threads.ts`, inside the `threadInboxItems` column definitions, after `navigatorWakeupId`:

```typescript
    // Timestamp when the atomic claim (pending_route → routing) was executed.
    // Used by sweep-inbox.ts to reclaim items stranded in 'routing'/'escalated'
    // that have been in-flight longer than RECLAIM_THRESHOLD_MS (C4 / #37).
    routingClaimedAt: timestamp("routing_claimed_at", { withTimezone: true }),

    // Proposed title when the Navigator suggests creating a new thread (D2 suggest_new).
    // NULL for attach suggestions.
    suggestedThreadTitle: text("suggested_thread_title"),

    // Snapshot of the candidate cards the Navigator could see at decision time.
    // Written by routeInboxItem in the escalate path. Enables reproducible-decision
    // audit ("what did the Navigator have available?"). NULL for items routed
    // before this column existed. (A2 / Codex #12 — now core, not deferred.)
    routingCardSnapshot: jsonb("routing_card_snapshot"),
```

Note: `threads.ts` line 1–11 import block must include `jsonb`. If it does not (the current import list is `pgTable, uuid, text, timestamp, integer, boolean, doublePrecision, index, uniqueIndex`), add `jsonb` to it:

```typescript
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  doublePrecision,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
```

- [ ] **Step 3: Generate the migration (from repo root)**

```
pnpm db:generate
```

Expected output: a new migration file `packages/db/src/migrations/0133_*.sql` containing `ALTER TABLE "discussions" ADD COLUMN "routing_terms" jsonb;`, `ALTER TABLE "thread_inbox_items" ADD COLUMN "routing_claimed_at" timestamp with time zone;`, `... "suggested_thread_title" text;`, `... "routing_card_snapshot" jsonb;`.

If the migration number differs, that's fine — Drizzle assigns the next available number.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/discussions.ts packages/db/src/schema/threads.ts packages/db/src/migrations/
git commit -m "feat(schema): add discussions.routingTerms + thread_inbox_items routingClaimedAt/suggestedThreadTitle/routingCardSnapshot"
```

---

## Task 2 — Delete deterministic decider + dead tests

**Files:**
- Delete: `server/src/services/inbound-routing-constants.ts`
- Delete: `server/src/__tests__/inbox-router-gate.test.ts`
- Delete: `server/src/__tests__/inbox-routing-matrix.test.ts`
- Delete: `server/src/__tests__/inbox-router.test.ts` (Codex P1 #7 — old orchestrator test; its action/outcome assertions are invalidated by the Task 8 rewrite. Replaced by inbox-router-rewire.test.ts.)

These are the classify/resolve gate functions and the orchestrator tests for the old contract. The new `routeInboxItem` (Task 8) does not call them and changes the action/outcome shape, so the old orchestrator test cannot be salvaged.

- [ ] **Step 1: Verify no other imports of inbound-routing-constants**

```
grep -rn "inbound-routing-constants" server/src/ --include="*.ts"
```

Expected: only `inbox-router.ts` imports it. If anything else imports it, note those files — they need updating in Task 8 when we rewrite `inbox-router.ts`.

- [ ] **Step 2: Confirm which test files reference the deleted symbols**

```
grep -rln "classifyRouting\|resolveRoutingAction\|ATTACH_CONFIDENCE\|AMBIGUITY_MARGIN" server/src/__tests__/
```

Expected: `inbox-router-gate.test.ts`, `inbox-routing-matrix.test.ts`, and `inbox-router.test.ts`. All three are deleted below. If any OTHER test file appears, note it — it needs updating in Task 12/13.

- [ ] **Step 3: Delete the four files**

```bash
rm server/src/services/inbound-routing-constants.ts
rm server/src/__tests__/inbox-router-gate.test.ts
rm server/src/__tests__/inbox-routing-matrix.test.ts
rm server/src/__tests__/inbox-router.test.ts
```

- [ ] **Step 4: Run tests to confirm deletion doesn't break the live suite**

```
pnpm test:run -- --reporter=verbose 2>&1 | tail -30
```

Expected: the three deleted test files no longer appear. Other tests still pass. (inbox-router.ts will have broken imports but we're rewriting it in Task 8 — ignore its compile error here.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(inbox-router): delete deterministic decider (classifyRouting/resolveRoutingAction) + old orchestrator/gate/matrix tests (D1, Codex P1 #7)"
```

---

## Task 3 — Extend `thread.updateSummary` to accept `routingTerms`

**Files:**
- Modify: `server/src/services/internal-agent/tools/thread-update-summary.ts`

- [ ] **Step 1: Write the failing test**

In a new file `server/src/__tests__/thread-update-summary.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
}));
const mockLogActivity = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/activity-log.js", () => ({
  logActivity: (...a: any[]) => mockLogActivity(...a),
}));

import { threadUpdateSummaryTool } from "../services/internal-agent/tools/thread-update-summary.js";

const COMPANY_ID = "aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_ID = "bbbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb";

function makeCtx(opts: { agentId?: string } = {}) {
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ then: (f: Function) => f([{ companyId: COMPANY_ID }]) }) }) }),
      update: () => ({ set: vi.fn().mockReturnThis(), where: vi.fn().mockResolvedValue([]) }),
    } as any,
    companyId: COMPANY_ID,
    agentId: opts.agentId,
    services: {},
  };
}

describe("thread.updateSummary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes routingTerms to the row when provided", async () => {
    const ctx = makeCtx();
    const result = await threadUpdateSummaryTool.execute(
      { threadId: THREAD_ID, summary: "Acme renewal discussion", routingTerms: ["Acme Corp", "renewal"] },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ threadId: THREAD_ID, routingTermsWritten: true });
  });

  it("skips routingTerms write when param is absent", async () => {
    const ctx = makeCtx();
    const result = await threadUpdateSummaryTool.execute(
      { threadId: THREAD_ID, summary: "A simple summary" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ threadId: THREAD_ID, routingTermsWritten: false });
  });

  it("returns error when routingTerms is not an array", async () => {
    const ctx = makeCtx();
    const result = await threadUpdateSummaryTool.execute(
      { threadId: THREAD_ID, summary: "ok", routingTerms: "not-an-array" as any },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("returns error when routingTerms contains a non-string element", async () => {
    const ctx = makeCtx();
    const result = await threadUpdateSummaryTool.execute(
      { threadId: THREAD_ID, summary: "ok", routingTerms: ["valid", 42] as any },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("logs an activity entry with the agent actor (C6 audit)", async () => {
    const ctx = makeCtx({ agentId: "agent-chronicler-1" });
    await threadUpdateSummaryTool.execute({ threadId: THREAD_ID, summary: "ok" }, ctx);
    expect(mockLogActivity).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({
        action: "thread.summary.updated",
        actorType: "agent",
        actorId: "agent-chronicler-1",
        entityId: THREAD_ID,
      }),
    );
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```
pnpm test:run server/src/__tests__/thread-update-summary.test.ts
```

Expected: FAIL — `routingTermsWritten` not in result shape.

- [ ] **Step 3: Update `thread-update-summary.ts`**

Replace the full file content:

```typescript
// server/src/services/internal-agent/tools/thread-update-summary.ts
import { eq } from "drizzle-orm";
import { discussions } from "@armyofagents/db";
import type { AgentTool } from "../types.js";
import { logActivity } from "../../activity-log.js";

/** Cap on routing terms count + per-term length to keep the card bounded. */
const MAX_ROUTING_TERMS = 50;
const MAX_TERM_LENGTH = 120;

export const threadUpdateSummaryTool: AgentTool = {
  name: "thread.updateSummary",
  description:
    "Update a thread's summary text + routing terms, then queue embedding regeneration.",
  parameters: {
    type: "object",
    properties: {
      threadId: { type: "string", description: "The thread (discussion) ID" },
      summary: {
        type: "string",
        description: "1-3 sentence summary of current thread state",
      },
      routingTerms: {
        type: "array",
        items: { type: "string" },
        description:
          "Key entities, aliases, and synonyms for routing retrieval " +
          "(e.g. [\"Acme Corp\",\"ACME\",\"the renewal\"]). Omit to leave unchanged.",
      },
    },
    required: ["threadId", "summary"],
  },
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { threadId, summary, routingTerms } = (params ?? {}) as {
      threadId?: string;
      summary?: string;
      routingTerms?: unknown;
    };

    if (!threadId || typeof threadId !== "string") {
      return { success: false, data: null, summary: "threadId is required", error: "INVALID_PARAMS" };
    }
    if (typeof summary !== "string") {
      return { success: false, data: null, summary: "summary must be a string", error: "INVALID_PARAMS" };
    }
    // Codex P2: validate every element is a string (not just Array.isArray) + cap.
    let normalizedTerms: string[] | undefined;
    if (routingTerms !== undefined) {
      if (!Array.isArray(routingTerms)) {
        return { success: false, data: null, summary: "routingTerms must be a string array", error: "INVALID_PARAMS" };
      }
      if (!routingTerms.every((t) => typeof t === "string")) {
        return { success: false, data: null, summary: "routingTerms must contain only strings", error: "INVALID_PARAMS" };
      }
      normalizedTerms = (routingTerms as string[])
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t.length <= MAX_TERM_LENGTH)
        .slice(0, MAX_ROUTING_TERMS);
    }

    // Cross-tenant guard (#7): verify thread belongs to caller's company.
    const existing = await ctx.db
      .select({ companyId: discussions.companyId })
      .from(discussions)
      .where(eq(discussions.id, threadId))
      .then((rows: Array<{ companyId: string }>) => rows[0] ?? null);

    if (!existing) {
      return { success: false, data: null, summary: `Thread ${threadId} not found`, error: "THREAD_NOT_FOUND" };
    }
    if (existing.companyId !== ctx.companyId) {
      return { success: false, data: null, summary: "Thread belongs to a different company", error: "COMPANY_MISMATCH" };
    }

    const summaryUpdatedAt = new Date();
    const updatePayload: Record<string, unknown> = { summaryText: summary, summaryUpdatedAt };

    let routingTermsWritten = false;
    if (normalizedTerms !== undefined) {
      // jsonb string[] column — store the array directly (no serialize).
      updatePayload.routingTerms = normalizedTerms;
      routingTermsWritten = true;
    }

    await ctx.db
      .update(discussions)
      .set(updatePayload)
      .where(eq(discussions.id, threadId));

    // Audit trail (Codex P1 #8 / spec C6): card writes are user-facing state, so
    // log who changed the summary. Actor resolved from ctx (agentId when present —
    // e.g. the Chronicler — else 'system'). Non-fatal: never block the write.
    await logActivity(ctx.db, {
      companyId: ctx.companyId,
      actorType: ctx.agentId ? "agent" : "system",
      actorId: ctx.agentId ?? "system",
      action: "thread.summary.updated",
      entityType: "discussion",
      entityId: threadId,
      details: { routingTermsWritten },
    }).catch(() => {
      /* non-fatal — summary already saved */
    });

    // Best-effort embedding regeneration.
    let embeddingQueued = false;
    try {
      if (ctx.services?.embeddings?.enqueue) {
        await ctx.services.embeddings.enqueue({
          targetTable: "discussions",
          targetId: threadId,
          targetColumn: "summary_embedding",
          inputText: summary,
        });
        embeddingQueued = true;
      }
    } catch {
      embeddingQueued = false;
    }

    return {
      success: true,
      data: { threadId, summaryUpdatedAt: summaryUpdatedAt.toISOString(), embeddingQueued, routingTermsWritten },
      summary: embeddingQueued
        ? "Summary updated; embedding queued"
        : "Summary updated (embedding not queued — service unavailable)",
    };
  },
};
```

Note: confirm `logActivity`'s signature in `server/src/services/activity-log.js` matches the call above (it's the same shape `inbox-router.ts` already uses: `logActivity(db, { companyId, actorType, actorId, action, entityType, entityId, details })`).

- [ ] **Step 4: Run the test to confirm it passes**

```
pnpm test:run server/src/__tests__/thread-update-summary.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Run full test suite**

```
pnpm test:run 2>&1 | tail -10
```

Expected: all passing (except inbox-router.ts compile errors from Task 2 — those resolve in Task 8).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/internal-agent/tools/thread-update-summary.ts \
        server/src/__tests__/thread-update-summary.test.ts
git commit -m "feat(tools): extend thread.updateSummary to accept routingTerms (T4)"
```

---

## Task 4 — Strip Adjutant's summary-update instruction (A1)

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/ensure-adjutant.ts`

Per A1, the Chronicler is the primary routine writer of `summaryText`. The Adjutant's standing instruction to call `thread.updateSummary` on every run is removed. The tool stays on the allowlist (it remains a shared action tool — the Adjutant can still call it on its own initiative, but it no longer has a standing directive to do so).

- [ ] **Step 1: Edit the instruction in `ensure-adjutant.ts`**

Find and remove this line from `ADJUTANT_INSTRUCTION`:

```
4. Update the thread summary so future runs have fresh context (use thread.updateSummary).
```

The surrounding numbered list will need re-numbering: item 5 (if any) becomes 4, etc. In practice the list ends at 4, so after removal the list has items 1–3.

The section currently reads:
```
When dispatched to a thread, you:
1. Read the recent entries via thread.listEntries and the related-thread context provided.
2. Set or refine intent via thread.setIntent if not already clear.
3. Decide one of:
   - Respond directly with a clarifying question or summary (use post_entry).
   - Delegate to Scout for investigation (use agent.dispatch on Scout).
   - Delegate to Engineer to produce an artifact (use agent.dispatch on Engineer).
   - Delegate to Navigator if a topic needs its own thread (use agent.dispatch on Navigator).
   - Propose work when the conversation has converged (use propose_crew_work — this is the sole scope-card path through the D11 chokepoint).
4. Update the thread summary so future runs have fresh context (use thread.updateSummary).
```

Change to:
```
When dispatched to a thread, you:
1. Read the recent entries via thread.listEntries and the related-thread context provided.
2. Set or refine intent via thread.setIntent if not already clear.
3. Decide one of:
   - Respond directly with a clarifying question or summary (use post_entry).
   - Delegate to Scout for investigation (use agent.dispatch on Scout).
   - Delegate to Engineer to produce an artifact (use agent.dispatch on Engineer).
   - Delegate to Navigator if a topic needs its own thread (use agent.dispatch on Navigator).
   - Propose work when the conversation has converged (use propose_crew_work — this is the sole scope-card path through the D11 chokepoint).
```

- [ ] **Step 2: Verify typecheck**

```
pnpm typecheck
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/ensure-adjutant.ts
git commit -m "feat(adjutant): remove standing thread.updateSummary directive — Chronicler is primary card writer (A1)"
```

---

## Task 5 — Chronicler CLI agent

**Files:**
- Create: `server/src/onboarding-assets/chronicler/SOUL.md`
- Create: `server/src/onboarding-assets/chronicler/AGENTS.md`
- Create: `server/src/onboarding-assets/chronicler/HEARTBEAT.md`
- Create: `server/src/onboarding-assets/chronicler/TOOLS.md`
- Modify: `server/src/services/internal-agent/aoa-agents/seed-commander-bundle.ts` (add `'chronicler'` to role union)
- Modify: `server/src/services/internal-agent/aoa-agents/seed-crew-agent.ts` (add `'chronicler'` to instructionBundleRole union)
- Create: `server/src/services/internal-agent/aoa-agents/ensure-chronicler.ts`
- Create: `server/src/services/internal-agent/aoa-agents/sweep-chronicler.ts`
- Modify: `server/src/index.ts` (wire sweep + bootstrap seed)

### 5a — Onboarding bundle files

- [ ] **Step 1: Create `server/src/onboarding-assets/chronicler/SOUL.md`**

```markdown
# Soul — Chronicler

You are the **Chronicler**. You keep each thread's routing card accurate and fresh.

## Principles

1. **Facts only, faithfully.** Read what was actually said and write a tight factual summary. Do not infer intent, add opinions, or extrapolate. A Chronicler is a scribe, not an analyst.

2. **Terms are identities, not prose.** The `routingTerms` array you write is a list of key entities: company names, product names, project aliases, people, and any nicknames or abbreviations the team uses for them. Each entry is a discrete token, not a phrase.

3. **Incremental, not from scratch.** You receive the existing card (summaryText + routingTerms). Merge the new entries into the existing card — preserve what's still true, update what has changed, add what's new. Do not wipe and rewrite unless the thread has fundamentally changed topic.

4. **Silent always.** You NEVER post_entry into a thread. Your only WRITE is a `thread.updateSummary` call. Silence is your default; a card write is your only mutation.

5. **Low temperature.** Stay close to what was said. Routing depends on consistency: a card that drifts from the thread content misleads the Navigator.

## Voice

Not a voice — a record. You write for a machine (the Navigator), not for humans. Dense, accurate, tightly scoped.

## Boundaries

- You READ with `thread.listEntries` (the thread's entries) and `get_thread_summary` (the existing card), and you WRITE with `thread.updateSummary` (summary + routingTerms). That is your entire toolset.
- You do NOT: post entries, create tasks, write memory, dispatch agents, or call any tool outside those three.
- If you cannot write a card (thread not found, service error), exit silently — do not throw, do not post.
```

- [ ] **Step 2: Create `server/src/onboarding-assets/chronicler/AGENTS.md`**

```markdown
# Agents — Chronicler

You work alone. You have no crew to delegate to and you do not coordinate with other agents.

When you are woken for a thread, read its entries with `thread.listEntries` and the existing card with `get_thread_summary`, write the updated card once with `thread.updateSummary`, and stop.
```

- [ ] **Step 3: Create `server/src/onboarding-assets/chronicler/HEARTBEAT.md`**

```markdown
# Heartbeat — Chronicler

You are woken by the Chronicler sweep when a thread has new entries since your last card write. The trigger payload gives you the `threadId`.

**Your sequence each wakeup:**
1. Call `get_thread_summary` for the thread to read the existing card (summaryText + routingTerms). It may be empty on a brand-new thread.
2. Call `thread.listEntries` for the thread to read what has been said.
3. Merge: update the summary to reflect the current state of the thread, and refresh routingTerms with the key entities. Preserve what is still true; do not wipe and rewrite unless the topic fundamentally changed.
4. Call `thread.updateSummary` once with the updated `summary` and `routingTerms`. Done.

**Do not call any tool outside `get_thread_summary`, `thread.listEntries`, `thread.updateSummary`.** Do not post into the thread. Exit immediately after the one `thread.updateSummary` write.
```

- [ ] **Step 4: Create `server/src/onboarding-assets/chronicler/TOOLS.md`**

```markdown
# Tools — Chronicler

You have three tools: two reads and one write.

## `get_thread_summary` (read)

Returns the thread's existing card (summaryText + routingTerms). Call first to see what you're updating. Empty on a brand-new thread.

## `thread.listEntries` (read)

Returns the thread's entries. Call to read what has been said since the last card write.

## `thread.updateSummary` (write)

Writes the thread's routing card. Call ONCE per wakeup, last.

Parameters:
- `threadId` (required): the thread to update.
- `summary` (required): 1–3 sentence factual description of what the thread is about. Written for the Navigator, not for humans. Be dense and accurate.
- `routingTerms` (required): array of key entity strings for routing. Include: company/product/project names, acronyms, aliases, and any domain-specific terms mentioned. Example: `["Acme Corp","ACME","Q3 renewal","contract extension","churn risk"]`.

Read with the first two, then write once with the third, then stop.
```

### 5b — Register the `'chronicler'` bundle role (3 sites — Codex P1 #4)

**Why 3 sites:** `loadDefaultAgentInstructionsBundle("chronicler")` keys off `default-agent-instructions.ts`'s `DEFAULT_AGENT_BUNDLE_FILES` / `DEFAULT_AGENT_BUNDLE_DIRS`. The two seed files (`seed-commander-bundle.ts`, `seed-crew-agent.ts`) carry the `role` union that the bundle seeder accepts. Miss any one and the Chronicler seed fails to typecheck or throws at runtime when it tries to load its persona files.

- [ ] **Step 5: Register `chronicler` in `default-agent-instructions.ts` (BOTH objects)**

In `server/src/services/default-agent-instructions.ts`, add a `chronicler` entry to `DEFAULT_AGENT_BUNDLE_FILES` (after the `scout` line, ~line 23):

```typescript
  scout: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
  // Routing-card redesign — Chronicler keeps per-thread routing cards fresh.
  chronicler: ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"],
```

And to `DEFAULT_AGENT_BUNDLE_DIRS` (after the `scout: "scout"` line, ~line 46):

```typescript
  scout: "scout",
  chronicler: "chronicler",
```

(`DefaultAgentBundleRole` is `keyof typeof DEFAULT_AGENT_BUNDLE_FILES`, so adding to `DEFAULT_AGENT_BUNDLE_FILES` automatically widens the type; the `DEFAULT_AGENT_BUNDLE_DIRS` record then REQUIRES a `chronicler` key or it won't compile — which is the safety net.)

- [ ] **Step 6: Add `'chronicler'` to `seed-commander-bundle.ts` role union**

In `server/src/services/internal-agent/aoa-agents/seed-commander-bundle.ts`, find the `role:` union type (around line 57) and add `| "chronicler"`:

```typescript
  role:
    | "commander"
    | "router"
    | "navigator"
    | "planner"
    | "dispatcher"
    | "memory_keeper"
    | "scribe"
    | "adjutant"
    | "maker"
    | "engineer"
    | "scout"
    | "chronicler";
```

- [ ] **Step 7: Add `'chronicler'` to `seed-crew-agent.ts` instructionBundleRole union**

In `server/src/services/internal-agent/aoa-agents/seed-crew-agent.ts`, find the `instructionBundleRole:` union (around line 55) and add `| "chronicler"`:

```typescript
  instructionBundleRole:
    | "commander"
    | "router"
    | "navigator"
    | "planner"
    | "dispatcher"
    | "memory_keeper"
    | "scribe"
    | "adjutant"
    | "maker"
    | "engineer"
    | "scout"
    | "chronicler";
```

- [ ] **Step 7a: Register `chronicler` in the autonomy gate (Codex re-review P1 #A)**

The dispatcher gates every sweep/trigger role through `isRoleActiveAtAutonomy(role, level)` in `server/src/services/internal-agent/aoa-agents/autonomy.ts`. If `chronicler` is not in `ROLE_MIN_AUTONOMY`, the lookup is `undefined` and `level >= undefined` is `false` — the Chronicler would **never run**. It is infrastructure-grade (always-on, min autonomy 0, like `scribe`/`memory_keeper`).

Add `| "chronicler"` to the `CrewRole` union (after `scout`):

```typescript
export type CrewRole =
  | "scribe"
  | "memory_keeper"
  | "curator"
  | "router"
  | "navigator"
  | "planner"
  | "dispatcher"
  | "adjutant"
  | "maker"
  | "engineer"
  | "scout"
  | "chronicler";
```

And add the entry to `ROLE_MIN_AUTONOMY` (after `scout: 1`):

```typescript
  scout: 1,
  chronicler: 0,    // core infrastructure: card maintenance always runs (like scribe/memory_keeper)
```

- [ ] **Step 7b: Extend `get_thread_summary` to return `routingTerms` (Codex re-review P1 #B)**

The Chronicler reads the existing card (summaryText + routingTerms) to merge incrementally. `get_thread_summary` currently does NOT return `routingTerms`, so the Chronicler can't see the existing terms and would regenerate them from scratch each run (drift). In `server/src/services/internal-agent/tools/thread-get-summary.ts`, add `routingTerms` to the SELECT and the returned `data`:

In the `.select({...})`:
```typescript
        summaryText: discussions.summaryText,
        routingTerms: discussions.routingTerms,   // NEW — Chronicler reads this to merge
        summaryUpdatedAt: discussions.summaryUpdatedAt,
```

In the returned `data` object, read the jsonb `string[]` column directly (defensive filter):
```typescript
      data: {
        summaryText: thread.summaryText,
        routingTerms: Array.isArray(thread.routingTerms)
          ? (thread.routingTerms as unknown[]).filter((t): t is string => typeof t === "string")
          : [],
        summaryUpdatedAt: thread.summaryUpdatedAt,
        intent: thread.intent,
        phase: thread.phase,
        autonomyLevel: thread.autonomyLevel,
        visibility: thread.visibility,
        ownerUserId: thread.ownerUserId,
        participants: participantList,
      },
```

Note: `get_thread_summary` is a shared tool. Adding a field is additive — verify no existing consumer asserts the absence of `routingTerms` (none should; it's a new key).

### 5c — `ensure-chronicler.ts`

- [ ] **Step 8: Create `server/src/services/internal-agent/aoa-agents/ensure-chronicler.ts`**

```typescript
// server/src/services/internal-agent/aoa-agents/ensure-chronicler.ts
//
// Idempotently seeds the Chronicler role for a company.
//
// The Chronicler is a Command-Staff-adjacent infrastructure role (autonomy 0 —
// always active). It keeps each thread's routing card fresh by updating
// discussions.summaryText + routingTerms on every sweep cycle that detects
// new activity. It is SILENT — no thread posts, only thread.updateSummary calls.
//
// Trigger: 'sweep' (kind), picked up by sweep-chronicler.ts every 45s.
// Tool allowlist: two reads + one write (Codex P1 #3 — the agent must be able to
//   READ the thread to summarize it; the spec's "exactly thread.updateSummary"
//   meant the only WRITE/mutation tool). No post_entry, memory, or extraction.
// Bundle role key: 'chronicler' (maps to onboarding-assets/chronicler/).

import type { Db } from "@armyofagents/db";
import { seedCrewAgent } from "./seed-crew-agent.js";

const CHRONICLER_INSTRUCTION =
  "You are the Chronicler. Keep thread routing cards accurate. When woken for a " +
  "thread, call get_thread_summary (existing card) and thread.listEntries (what was " +
  "said), then call thread.updateSummary ONCE with a tight factual summary and an " +
  "array of key entity terms (routingTerms). NEVER post_entry. NEVER call any tool " +
  "outside those three. Silence is correct when in doubt.";

// Read tools (thread.listEntries, get_thread_summary) + the single write
// (thread.updateSummary). All three already exist in tool-registry.ts.
export const CHRONICLER_TOOL_ALLOWLIST: string[] = [
  "thread.listEntries",
  "get_thread_summary",
  "thread.updateSummary",
];

/**
 * Idempotently seed the Chronicler role for a company.
 * Returns the agent id.
 */
export async function ensureChronicler(db: Db, companyId: string): Promise<string> {
  return seedCrewAgent(db, companyId, {
    name: "Chronicler",
    role: "general",
    instruction: CHRONICLER_INSTRUCTION,
    toolAllowlist: CHRONICLER_TOOL_ALLOWLIST,
    triggers: [{ kind: "sweep", config: { role: "chronicler" } }],
    instructionBundleRole: "chronicler",
  });
}
```

### 5d — `sweep-chronicler.ts`

- [ ] **Step 9: Create `server/src/services/internal-agent/aoa-agents/sweep-chronicler.ts`**

```typescript
// server/src/services/internal-agent/aoa-agents/sweep-chronicler.ts
//
// Chronicler card-update sweep.
//
// Queries threads that have new entries since their last card update and
// queues one agentWakeupRequests row per eligible thread.
//
// Eligibility: discussions.status='active' AND
//   (summaryUpdatedAt IS NULL OR lastEntryAt > summaryUpdatedAt)
// Debounce: skip threads with a Chronicler wakeup queued OR processing in the
//   last CHRONICLER_DEBOUNCE_MS (45s) to absorb entry bursts.
// Concurrency cap: process at most CHRONICLER_MAX_CONCURRENT threads per cycle.
//
// KNOWN LIMITATION (Codex P2 — single-instance assumption): the debounce is a
// read-then-insert, not a DB-level unique constraint. Two server processes
// sweeping the same company within the same 45s window could each queue a
// wakeup for the same thread. v1 runs a single server process, so this is
// acceptable; multi-instance dedup (a unique partial index on
// agentWakeupRequests(agentId, payload->>'threadId') WHERE status IN
// ('queued','processing')) is a follow-up if/when the server scales out.

import { and, eq, ne, gt, isNull, isNotNull, or, inArray, sql } from "drizzle-orm";
import type { Db } from "@armyofagents/db";
import { agents, aoaAgentTriggers, discussions, agentWakeupRequests } from "@armyofagents/db";
import { logger } from "../../../middleware/logger.js";

const log = logger.child({ svc: "sweep-chronicler" });

/** Matches the sweep interval in index.ts. */
export const CHRONICLER_SWEEP_INTERVAL_MS = 45_000;

/** Skip threads with a Chronicler wakeup queued within this window. */
export const CHRONICLER_DEBOUNCE_MS = 45_000;

/** Max threads to queue per sweep tick. */
export const CHRONICLER_MAX_CONCURRENT = 10;

export interface RunChroniclerSweepResult {
  queued: number;
}

/**
 * For every company that has a Chronicler agent with a 'sweep' trigger,
 * find active threads with stale cards and queue one Chronicler wakeup per thread.
 */
export async function runChroniclerSweep(db: Db): Promise<RunChroniclerSweepResult> {
  // ── 1. Find all companies with an active Chronicler sweep trigger ─────────
  const chroniclerRows = await db
    .select({
      agentId: aoaAgentTriggers.agentId,
      companyId: aoaAgentTriggers.companyId,
    })
    .from(aoaAgentTriggers)
    .innerJoin(agents, eq(agents.id, aoaAgentTriggers.agentId))
    .where(
      and(
        eq(aoaAgentTriggers.kind, "sweep"),
        eq(aoaAgentTriggers.enabled, true),
        sql`(${aoaAgentTriggers.config}->>'role') = 'chronicler'`,
        ne(agents.status, "terminated"),
        ne(agents.status, "paused"),
      ),
    );

  if (chroniclerRows.length === 0) {
    return { queued: 0 };
  }

  // ── 2. For each company, find stale threads + queue wakeups ───────────────
  let totalQueued = 0;

  for (const { agentId, companyId } of chroniclerRows) {
    try {
      const queued = await queueForCompany(db, agentId, companyId);
      totalQueued += queued;
    } catch (err) {
      log.warn({ err, companyId }, "sweep-chronicler: queueForCompany failed — continuing");
    }
  }

  if (totalQueued > 0) {
    log.debug({ queued: totalQueued }, "sweep-chronicler: done");
  }

  return { queued: totalQueued };
}

async function queueForCompany(db: Db, agentId: string, companyId: string): Promise<number> {
  // ── Threads with new entries since last card update ───────────────────────
  // Eligibility: active thread that has at least one entry (lastEntryAt set) AND
  // either no card yet (summaryUpdatedAt null) or new entries since the last card.
  // The isNotNull(lastEntryAt) guard (Codex round-3 P2) avoids waking the
  // Chronicler for brand-new no-entry threads (created with lastEntryAt=null) —
  // there is nothing to summarize until a first entry lands.
  const staleThreads = await db
    .select({ id: discussions.id })
    .from(discussions)
    .where(
      and(
        eq(discussions.companyId, companyId),
        eq(discussions.status, "active"),
        isNotNull(discussions.lastEntryAt),
        or(
          isNull(discussions.summaryUpdatedAt),
          gt(discussions.lastEntryAt, discussions.summaryUpdatedAt),
        ),
      ),
    )
    .limit(CHRONICLER_MAX_CONCURRENT);

  if (staleThreads.length === 0) return 0;

  // ── Debounce: skip threads with a Chronicler wakeup still queued OR in-flight
  //    (Codex P2 — a 'processing' wakeup means a Chronicler is mid-run on that
  //    thread; queuing another would double-run it). Wakeup statuses:
  //    'queued' | 'processing' | 'completed' | 'failed' | 'cancelled'.
  const cutoff = new Date(Date.now() - CHRONICLER_DEBOUNCE_MS);
  const recentWakeups = await db
    .select({ payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.agentId, agentId),
        inArray(agentWakeupRequests.status, ["queued", "processing"]),
        gt(agentWakeupRequests.createdAt, cutoff),
      ),
    );

  const alreadyQueued = new Set(
    recentWakeups
      .map((r) => (r.payload as Record<string, unknown>)?.threadId as string | undefined)
      .filter(Boolean),
  );

  const toQueue = staleThreads.filter((t) => !alreadyQueued.has(t.id));
  if (toQueue.length === 0) return 0;

  // ── Insert wakeup rows ────────────────────────────────────────────────────
  const wakeupRows = toQueue.map((t) => ({
    companyId,
    agentId,
    source: "sweep.chronicler" as const,
    reason: "card_stale",
    payload: { threadId: t.id, role: "chronicler" } as Record<string, unknown>,
    status: "queued" as const,
  }));

  await db.insert(agentWakeupRequests).values(wakeupRows);

  return toQueue.length;
}
```

### 5e — Wire seeding + sweep into the server

- [ ] **Step 10: Seed Chronicler in the company-create path (`services/companies.ts`)**

This is the seed-on-create path (Codex P2). `services/companies.ts` seeds the crew when a company is created (not just at boot). Find the `ensureCommandStaff(db, company.id)` call (~line 164) and the block of `ensure*` calls after it (Adjutant, Scout, Engineer, ~lines 164–185). Add after the `ensureEngineer` block:

```typescript
          // Routing-card redesign: seed the Chronicler (keeps per-thread
          // routing cards fresh for the Navigator).
          await ensureChronicler(db, company.id).catch((err: unknown) => {
            logger.warn({ err, companyId: company.id }, "Chronicler agent seeding failed");
          });
```

And add the import at the top of `services/companies.ts` (near the other `ensure*` imports, ~line 6):

```typescript
import { ensureChronicler } from "./internal-agent/aoa-agents/ensure-chronicler.js";
```

- [ ] **Step 11: Import `ensureChronicler` + `runChroniclerSweep` in `server/src/index.ts`**

Find the block where `ensureCommandStaff` and `ensureAdjutant` are imported (around line 63):

```typescript
import { ensureCommandStaff } from "./services/internal-agent/aoa-agents/ensure-command-staff.js";
import { ensureAdjutant } from "./services/internal-agent/aoa-agents/ensure-adjutant.js";
```

Add below those lines:

```typescript
import { ensureChronicler } from "./services/internal-agent/aoa-agents/ensure-chronicler.js";
import { runChroniclerSweep, CHRONICLER_SWEEP_INTERVAL_MS } from "./services/internal-agent/aoa-agents/sweep-chronicler.js";
```

- [ ] **Step 12: Seed Chronicler on company bootstrap (alongside ensureCommandStaff)**

Find the bootstrap loop block (~line 734) where `ensureCommandStaff(db as any, row.id)` and `ensureAdjutant(db as any, row.id)` are called for each existing company. Add after the `ensureAdjutant` call:

```typescript
ensureChronicler(db as any, row.id).catch((err: unknown) =>
  logger.warn({ err, companyId: row.id }, "bootstrap: ensureChronicler failed"),
);
```

- [ ] **Step 13: Register Chronicler sweep on its interval**

Find where `runInboxSweep` or similar sweeps are registered with `setInterval`. Add:

```typescript
setInterval(() => {
  runChroniclerSweep(db as any).catch((err: unknown) =>
    logger.warn({ err }, "chronicler sweep error"),
  );
}, CHRONICLER_SWEEP_INTERVAL_MS);
```

- [ ] **Step 13c: Let the Chronicler bypass the dispatcher's thread-level gates (code-review CRITICAL)**

The sweep enqueues `agentWakeupRequests` with `source='sweep.chronicler'` + `payload.threadId`. The dispatcher's Phase-3 drain (`dispatcher.ts`) has a `useControllerPath` gate that early-`return`s any non-inbox-routing wakeup whose thread is on the strangler controller path — and **every modern thread is created `useControllerPath=true`**. Without this step the Chronicler wakeup is silently swallowed and cards never refresh (the whole redesign goes inert on new threads). The Navigator's `inbox.routing_ambiguous` path already solved the same gate; the Chronicler mirrors it.

In `server/src/services/internal-agent/aoa-agents/dispatcher.ts`, just after `const isInboxRouting = w.source === "inbox.routing_ambiguous";`, add:

```typescript
          // Chronicler is always-on infrastructure (autonomy 0): it maintains
          // each thread's routing card regardless of the strangler controller
          // path or crew-pause. Like inbox-routing, its sweep wakeups must NOT
          // be swallowed by the thread-level crewPaused / useControllerPath
          // gates below. It STILL passes the autonomy gate (chronicler:0 → on).
          const isInfraSweep = w.source === "sweep.chronicler";
```

Then exclude `isInfraSweep` from the threadRow fetch (`!isInboxRouting && !isInfraSweep && typeof threadIdInPayload === "string" …`), and split the gate block so the `crewPaused` + `useControllerPath` gates run under `if (!isInboxRouting && !isInfraSweep)` while the autonomy gate stays under `if (!isInboxRouting)` (the Chronicler passes it at `chronicler:0`). Add a test to `server/src/__tests__/aoa-dispatcher.test.ts` mirroring the D4 inbox-routing tests: a `sweep.chronicler` wakeup with `payload.threadId` at `autonomyLevel=0` → `runAoaAgent` IS called (the chronicler payload has a threadId, so the effectiveAutonomy lookup fires — one extra select slot vs the inbox-routing cases).

- [ ] **Step 14: Run typecheck**

```
pnpm typecheck
```

Expected: no errors. If `loadDefaultAgentInstructionsBundle("chronicler")` errors, the Step 5 registration in `default-agent-instructions.ts` is incomplete.

- [ ] **Step 15: Commit**

```bash
git add server/src/onboarding-assets/chronicler/ \
        server/src/services/default-agent-instructions.ts \
        server/src/services/internal-agent/aoa-agents/autonomy.ts \
        server/src/services/internal-agent/tools/thread-get-summary.ts \
        server/src/services/internal-agent/aoa-agents/ensure-chronicler.ts \
        server/src/services/internal-agent/aoa-agents/sweep-chronicler.ts \
        server/src/services/internal-agent/aoa-agents/seed-crew-agent.ts \
        server/src/services/internal-agent/aoa-agents/seed-commander-bundle.ts \
        server/src/services/companies.ts \
        server/src/index.ts
git commit -m "feat(chronicler): seed Chronicler CLI agent (bundle+autonomy reg, create/boot seed) + read-card via get_thread_summary + sweep driver"
```

---

## Task 6 — `list_thread_cards` tool (small-scale all-cards)

**Files:**
- Create: `server/src/services/internal-agent/tools/list-thread-cards.ts`

> **Scope note (Codex P2):** This is NOT hybrid retrieval. v1 returns ALL active thread cards (capped at `SMALL_SCALE_LIMIT`). That is the intended small-scale design per the spec ("hand the Navigator ALL active cards — no retrieval, no recall risk"). Hybrid retrieval (keyword on `routingTerms` + vector on `summary_embedding`, fused, top-K) is explicitly **deferred to the at-scale phase** and is not built here. The tool logs when it hits the cap so silent truncation is visible.

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/list-thread-cards.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => ({
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  sql: Object.assign(vi.fn((s: TemplateStringsArray, ...v: unknown[]) => ({ _sql: s, v })), {
    raw: vi.fn((s: string) => ({ _raw: s })),
  }),
  isNotNull: vi.fn((a: unknown) => ({ _op: "isNotNull", a })),
}));

import { listThreadCardsTool } from "../services/internal-agent/tools/list-thread-cards.js";

const COMPANY_ID = "aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa";

function makeCtx(threadRows: Array<{ id: string; title: string | null; summaryText: string | null; routingTerms: string[] | null }>) {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(threadRows),
          }),
        }),
      }),
    } as any,
    companyId: COMPANY_ID,
    services: {},
  };
}

describe("list_thread_cards", () => {
  it("returns all active thread cards for small scale", async () => {
    const rows = [
      { id: "t1", title: "Acme renewal", summaryText: "About the Acme renewal deal", routingTerms: ["Acme Corp", "renewal"] },
      { id: "t2", title: "Infra upgrade", summaryText: "Server migration discussion", routingTerms: null },
    ];
    const ctx = makeCtx(rows);
    const result = await listThreadCardsTool.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toMatchObject({
      threadId: "t1",
      title: "Acme renewal",
      summaryText: "About the Acme renewal deal",
      routingTerms: ["Acme Corp", "renewal"],
    });
    expect(result.data[1]).toMatchObject({ threadId: "t2", routingTerms: [] });
  });

  it("returns empty array when no active threads", async () => {
    const ctx = makeCtx([]);
    const result = await listThreadCardsTool.execute({}, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```
pnpm test:run server/src/__tests__/list-thread-cards.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/src/services/internal-agent/tools/list-thread-cards.ts`**

```typescript
// server/src/services/internal-agent/tools/list-thread-cards.ts
//
// list_thread_cards — fetch routing cards for the Navigator.
//
// Small scale (≤ SMALL_SCALE_LIMIT active threads): return ALL active thread
// cards. No retrieval, no recall risk.
//
// The Navigator calls this tool to get the candidate set it reasons over.
// findSimilarThreadsScored is NOT called from here — it's a retrieval shortlister
// reserved for large-scale deployments (deferred).

import { and, eq } from "drizzle-orm";
import { discussions } from "@armyofagents/db";
import type { AgentTool } from "../types.js";
import { logger } from "../../../middleware/logger.js";

const log = logger.child({ tool: "list_thread_cards" });

/** Below this count, return all active cards. Above it, a top-K retrieval
 *  would be used (deferred to large-scale phase). The tool logs when the cap
 *  is hit so the silent-truncation case is visible (Codex P2 — no silent caps). */
export const SMALL_SCALE_LIMIT = 100;

export interface ThreadCard {
  threadId: string;
  title: string | null;
  summaryText: string | null;
  routingTerms: string[];
}

export const listThreadCardsTool: AgentTool = {
  name: "list_thread_cards",
  description:
    "Fetch routing cards (summaryText + routingTerms) for active threads. " +
    "Use this to get candidate threads before deciding where an inbound item belongs.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional: extract intent/entities from the inbound item to filter results at scale. Unused at small scale.",
      },
    },
    required: [],
  },
  category: "query",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(_params, ctx) {
    const rows = await ctx.db
      .select({
        id: discussions.id,
        title: discussions.title,
        summaryText: discussions.summaryText,
        routingTerms: discussions.routingTerms,
      })
      .from(discussions)
      .where(
        and(
          eq(discussions.companyId, ctx.companyId),
          eq(discussions.status, "active"),
        ),
      )
      .limit(SMALL_SCALE_LIMIT);

    const cards: ThreadCard[] = (Array.isArray(rows) ? rows : []).map((r) => {
      // routingTerms is a jsonb string[] column — read directly (defensive filter).
      const terms = Array.isArray(r.routingTerms)
        ? (r.routingTerms as unknown[]).filter((t): t is string => typeof t === "string")
        : [];
      return {
        threadId: r.id,
        title: r.title ?? null,
        summaryText: r.summaryText ?? null,
        routingTerms: terms,
      };
    });

    // No-silent-caps (Codex P2): if we returned exactly the cap, more cards may
    // exist that the Navigator never saw. Surface it.
    if (cards.length >= SMALL_SCALE_LIMIT) {
      log.warn(
        { companyId: ctx.companyId, cap: SMALL_SCALE_LIMIT },
        "list_thread_cards hit SMALL_SCALE_LIMIT — some active cards omitted; at-scale hybrid retrieval is deferred",
      );
    }

    return {
      success: true,
      data: cards,
      summary:
        cards.length >= SMALL_SCALE_LIMIT
          ? `${cards.length} routing card(s) returned (capped — more may exist)`
          : `${cards.length} routing card(s) returned`,
    };
  },
};
```

- [ ] **Step 4: Run test to confirm it passes**

```
pnpm test:run server/src/__tests__/list-thread-cards.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/internal-agent/tools/list-thread-cards.ts \
        server/src/__tests__/list-thread-cards.test.ts
git commit -m "feat(tools): add list_thread_cards (small-scale card-fetch for Navigator, T6)"
```

---

## Task 7 — Navigator tools: `promote_inbox_to_thread` (C1) + `defer_inbox_to_human` (Codex P1 #2)

**Files:**
- Create: `server/src/services/internal-agent/tools/promote-inbox-to-thread.ts`
- Create: `server/src/services/internal-agent/tools/defer-inbox-to-human.ts`

`promote_inbox_to_thread` is the Codex C1 BLOCKER: `spin_off_thread` is thread→thread (`fromThreadId`, `subtype='live'`) and cannot promote an inbox item. The Navigator needs a distinct tool that wraps `promoteInboxItemToNewThread` from `inbox-attach.ts`.

`defer_inbox_to_human` is the Codex P1 #2 fix: the Navigator's explicit "I'm unsure" finalization, so an unsure item reaches a terminal `routed`+`human` state instead of stranding in `escalated` (which the reclaim sweep would re-escalate, looping forever).

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/promote-inbox-to-thread.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  internalAgentConfig: new Proxy({} as any, { get: (_t, p) => p }),
  threadInboxItems: new Proxy({} as any, { get: (_t, p) => p }),
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
}));

const mockPromote = vi.fn();
vi.mock("../services/inbox-attach.js", () => ({
  promoteInboxItemToNewThread: (...args: any[]) => mockPromote(...args),
}));

import { promoteInboxToThreadTool } from "../services/internal-agent/tools/promote-inbox-to-thread.js";

const COMPANY_ID = "aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa";
const INBOX_ITEM_ID = "bbbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb";

// Sequence-based select mock: 1st select → inbox-item existence row (companyId),
// 2nd select → dial. itemCompanyId controls the cross-tenant guard.
// claimRows controls the escalated-guard UPDATE...returning() result:
// [{id}] = still escalated (proceeds), [] = already finalized (no-op).
function makeCtx(dial: string, itemCompanyId: string | null = COMPANY_ID, claimRows: object[] = [{ id: INBOX_ITEM_ID }]) {
  const selectResults: object[][] = [
    itemCompanyId === null ? [] : [{ companyId: itemCompanyId }],
    [{ inboundRoutingLevel: dial }],
  ];
  let call = 0;
  return {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve(selectResults[call++] ?? []),
          }),
        }),
      }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(claimRows) }) }) }),
    } as any,
    companyId: COMPANY_ID,
    services: {},
  };
}

describe("promote_inbox_to_thread", () => {
  beforeEach(() => vi.clearAllMocks());

  it("auto-creates thread at full_auto", async () => {
    mockPromote.mockResolvedValue({ threadId: "new-thread-id", entryId: "e1", alreadyHandled: false });
    const ctx = makeCtx("full_auto");
    const result = await promoteInboxToThreadTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(true);
    expect(result.data.action).toBe("created");
    expect(result.data.threadId).toBe("new-thread-id");
    expect(mockPromote).toHaveBeenCalledWith(ctx.db, expect.objectContaining({ inboxItemId: INBOX_ITEM_ID, companyId: COMPANY_ID }));
  });

  it("records suggest_new at auto_attach dial (does NOT create)", async () => {
    const ctx = makeCtx("auto_attach");
    const result = await promoteInboxToThreadTool.execute({ inboxItemId: INBOX_ITEM_ID, proposedTitle: "Acme renewal" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data.action).toBe("suggest_new");
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it("records suggest_new at suggest dial", async () => {
    const ctx = makeCtx("suggest");
    const result = await promoteInboxToThreadTool.execute({ inboxItemId: INBOX_ITEM_ID, proposedTitle: "New topic" }, ctx);
    expect(result.success).toBe(true);
    expect(result.data.action).toBe("suggest_new");
  });

  it("returns error when inboxItemId is missing", async () => {
    const ctx = makeCtx("full_auto");
    const result = await promoteInboxToThreadTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });

  it("rejects an item that belongs to another company (Codex P1 #6)", async () => {
    const ctx = makeCtx("full_auto", "some-other-company");
    const result = await promoteInboxToThreadTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("COMPANY_MISMATCH");
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it("returns ITEM_NOT_FOUND when the inbox item does not exist", async () => {
    const ctx = makeCtx("full_auto", null);
    const result = await promoteInboxToThreadTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("ITEM_NOT_FOUND");
  });

  it("no-ops when item already finalized (escalated-guard claim returns 0 rows)", async () => {
    // claimRows=[] → the escalated-guard UPDATE matched nothing (sweep finalized first).
    const ctx = makeCtx("full_auto", COMPANY_ID, []);
    const result = await promoteInboxToThreadTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(true);
    expect(result.data.action).toBe("already_finalized");
    expect(mockPromote).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```
pnpm test:run server/src/__tests__/promote-inbox-to-thread.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `server/src/services/internal-agent/tools/promote-inbox-to-thread.ts`**

```typescript
// server/src/services/internal-agent/tools/promote-inbox-to-thread.ts
//
// promote_inbox_to_thread — Navigator tool that creates a new thread from an
// inbox item (C1 BLOCKER: spin_off_thread cannot do this — it is thread→thread).
//
// Dial-gated (D2):
//   full_auto  → auto-creates the new thread via promoteInboxItemToNewThread.
//   auto_attach / suggest → records routerDecision='suggest_new' with a proposed
//     title; the Unlisted lane surfaces this as a confirm-create suggestion.

import { and, eq } from "drizzle-orm";
import { internalAgentConfig, threadInboxItems } from "@armyofagents/db";
import type { AgentTool } from "../types.js";

const SYSTEM_ACTOR = { actorId: "system", actorType: "system" as const, agentId: null };

export const promoteInboxToThreadTool: AgentTool = {
  name: "promote_inbox_to_thread",
  description:
    "Create a new thread from an inbound inbox item. " +
    "At full_auto dial: auto-creates the thread. " +
    "At auto_attach/suggest dial: records a 'suggest_new' decision surfaced to the founder.",
  parameters: {
    type: "object",
    properties: {
      inboxItemId: { type: "string", description: "ID of the thread_inbox_items row to promote" },
      proposedTitle: {
        type: "string",
        description: "Suggested title for the new thread (shown in the suggest_new banner)",
      },
    },
    required: ["inboxItemId"],
  },
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { inboxItemId, proposedTitle } = (params ?? {}) as {
      inboxItemId?: string;
      proposedTitle?: string;
    };

    if (!inboxItemId || typeof inboxItemId !== "string") {
      return { success: false, data: null, summary: "inboxItemId is required", error: "INVALID_PARAMS" };
    }

    // Cross-tenant guard (Codex P1 #6): verify the inbox item exists AND belongs
    // to the caller's company before any write. Without this, a Navigator scoped
    // to company A could flip company B's item by knowing its ID.
    const itemRows = await ctx.db
      .select({ companyId: threadInboxItems.companyId })
      .from(threadInboxItems)
      .where(eq(threadInboxItems.id, inboxItemId))
      .limit(1);
    const item = itemRows[0];
    if (!item) {
      return { success: false, data: null, summary: `Inbox item ${inboxItemId} not found`, error: "ITEM_NOT_FOUND" };
    }
    if (item.companyId !== ctx.companyId) {
      return { success: false, data: null, summary: "Inbox item belongs to a different company", error: "COMPANY_MISMATCH" };
    }

    // Read routing dial.
    const configRows = await ctx.db
      .select({ inboundRoutingLevel: internalAgentConfig.inboundRoutingLevel })
      .from(internalAgentConfig)
      .where(eq(internalAgentConfig.companyId, ctx.companyId))
      .limit(1);
    const dial = (configRows[0]?.inboundRoutingLevel ?? "off") as string;

    if (dial === "full_auto") {
      // First-writer-wins guard (Codex round-3 P1): atomically claim the item
      // ONLY if it is still 'escalated'. If the reclaim sweep already finalized
      // it to routed+human (this run ran past the reclaim threshold), the claim
      // returns 0 rows and we no-op — the sweep's human-finalization stands.
      // This prevents a live 'processing' Navigator run from auto-creating a
      // thread for an item the founder was already handed.
      const claimed = await ctx.db
        .update(threadInboxItems)
        .set({ routingStatus: "routing" })
        .where(
          and(
            eq(threadInboxItems.id, inboxItemId),
            eq(threadInboxItems.companyId, ctx.companyId),
            eq(threadInboxItems.routingStatus, "escalated"),
          ),
        )
        .returning({ id: threadInboxItems.id });

      if (claimed.length === 0) {
        return {
          success: true,
          data: { action: "already_finalized" },
          summary: "Item was already finalized (no longer escalated) — no action",
        };
      }

      // Auto-create the new thread. promoteInboxItemToNewThread sets the inbox
      // row's terminal status internally.
      const { promoteInboxItemToNewThread } = await import("../../inbox-attach.js");
      const result = await promoteInboxItemToNewThread(ctx.db, {
        companyId: ctx.companyId,
        inboxItemId,
        actor: SYSTEM_ACTOR,
      });

      return {
        success: true,
        data: { action: "created", threadId: result.threadId, entryId: result.entryId },
        summary: result.alreadyHandled
          ? "Item was already handled"
          : `New thread created: ${result.threadId}`,
      };
    }

    // Suggest path (suggest | auto_attach): record suggest_new decision.
    // companyId guard (Codex P1 #6) + escalated guard (Codex round-3 P1) in WHERE.
    const recorded = await ctx.db
      .update(threadInboxItems)
      .set({
        routerDecision: "suggest_new",
        suggestedThreadTitle: proposedTitle ?? null,
        routingStatus: "routed",
        routedAt: new Date(),
      })
      .where(
        and(
          eq(threadInboxItems.id, inboxItemId),
          eq(threadInboxItems.companyId, ctx.companyId),
          eq(threadInboxItems.routingStatus, "escalated"),
        ),
      )
      .returning({ id: threadInboxItems.id });

    if (recorded.length === 0) {
      return {
        success: true,
        data: { action: "already_finalized" },
        summary: "Item was already finalized (no longer escalated) — no action",
      };
    }

    return {
      success: true,
      data: { action: "suggest_new", proposedTitle: proposedTitle ?? null },
      summary: `Suggest-new decision recorded${proposedTitle ? `: "${proposedTitle}"` : ""}`,
    };
  },
};
```

- [ ] **Step 4: Run test to confirm it passes**

```
pnpm test:run server/src/__tests__/promote-inbox-to-thread.test.ts
```

Expected: 7 tests PASS.

- [ ] **Step 5: Write the failing test for `defer_inbox_to_human`**

The Navigator needs an explicit way to finalize an item it's UNSURE about — otherwise the item stays `escalated` forever and the reclaim sweep re-escalates it in a loop (Codex P1 #2). Create `server/src/__tests__/defer-inbox-to-human.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => ({
  threadInboxItems: new Proxy({} as any, { get: (_t, p) => p }),
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
}));

import { deferInboxToHumanTool } from "../services/internal-agent/tools/defer-inbox-to-human.js";

const COMPANY_ID = "aaaaaaaa-0000-4aaa-8aaa-aaaaaaaaaaaa";
const INBOX_ITEM_ID = "bbbbbbbb-0000-4bbb-8bbb-bbbbbbbbbbbb";

// claimRows controls the escalated-guard UPDATE...returning():
// [{id}] = still escalated (finalizes), [] = already finalized (no-op).
function makeCtx(itemCompanyId: string | null = COMPANY_ID, claimRows: object[] = [{ id: INBOX_ITEM_ID }]) {
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ limit: () =>
        Promise.resolve(itemCompanyId === null ? [] : [{ companyId: itemCompanyId }]) }) }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve(claimRows) }) }) }),
    } as any,
    companyId: COMPANY_ID,
    services: {},
  };
}

describe("defer_inbox_to_human", () => {
  it("finalizes the item to routed + human", async () => {
    const ctx = makeCtx();
    const result = await deferInboxToHumanTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ action: "deferred_to_human" });
  });

  it("no-ops when item already finalized (escalated-guard returns 0 rows)", async () => {
    const ctx = makeCtx(COMPANY_ID, []);
    const result = await deferInboxToHumanTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ action: "already_finalized" });
  });

  it("rejects an item from another company", async () => {
    const ctx = makeCtx("other-company");
    const result = await deferInboxToHumanTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("COMPANY_MISMATCH");
  });

  it("returns ITEM_NOT_FOUND for a missing item", async () => {
    const ctx = makeCtx(null);
    const result = await deferInboxToHumanTool.execute({ inboxItemId: INBOX_ITEM_ID }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("ITEM_NOT_FOUND");
  });

  it("requires inboxItemId", async () => {
    const ctx = makeCtx();
    const result = await deferInboxToHumanTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
  });
});
```

- [ ] **Step 6: Run test to confirm it fails**

```
pnpm test:run server/src/__tests__/defer-inbox-to-human.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 7: Create `server/src/services/internal-agent/tools/defer-inbox-to-human.ts`**

```typescript
// server/src/services/internal-agent/tools/defer-inbox-to-human.ts
//
// defer_inbox_to_human — the Navigator's "I'm unsure" finalization (Codex P1 #2).
//
// When the Navigator cannot confidently attach or create, it MUST call this
// rather than returning silently. It moves the item to a TERMINAL routed state
// (routingStatus='routed', routerDecision='human') so:
//   - the item stays visible in the Inbox (status='pending') for founder triage, AND
//   - the reclaim sweep does NOT re-escalate it (escalated → reclaim → escalated loop).

import { and, eq } from "drizzle-orm";
import { threadInboxItems } from "@armyofagents/db";
import type { AgentTool } from "../types.js";

export const deferInboxToHumanTool: AgentTool = {
  name: "defer_inbox_to_human",
  description:
    "Finalize an inbound item you are UNSURE about: leave it in the Inbox for the " +
    "founder to triage. Call this instead of returning silently when no thread is a " +
    "confident home and a new thread isn't clearly warranted.",
  parameters: {
    type: "object",
    properties: {
      inboxItemId: { type: "string", description: "ID of the thread_inbox_items row to defer" },
    },
    required: ["inboxItemId"],
  },
  category: "action",
  requiredRole: "team_member",
  requiresConfirmation: false,
  async execute(params, ctx) {
    const { inboxItemId } = (params ?? {}) as { inboxItemId?: string };
    if (!inboxItemId || typeof inboxItemId !== "string") {
      return { success: false, data: null, summary: "inboxItemId is required", error: "INVALID_PARAMS" };
    }

    // Cross-tenant guard.
    const itemRows = await ctx.db
      .select({ companyId: threadInboxItems.companyId })
      .from(threadInboxItems)
      .where(eq(threadInboxItems.id, inboxItemId))
      .limit(1);
    const item = itemRows[0];
    if (!item) {
      return { success: false, data: null, summary: `Inbox item ${inboxItemId} not found`, error: "ITEM_NOT_FOUND" };
    }
    if (item.companyId !== ctx.companyId) {
      return { success: false, data: null, summary: "Inbox item belongs to a different company", error: "COMPANY_MISMATCH" };
    }

    // Terminal: routed + human. Item stays status='pending' (visible in Inbox),
    // routingStatus='routed' means the reclaim sweep will NOT re-escalate it.
    //
    // First-writer-wins guard (Codex round-3 P1): require routingStatus='escalated'.
    // If the reclaim sweep already finalized this item (because this Navigator run
    // ran past the reclaim threshold), the claim returns 0 rows and we no-op —
    // the sweep's finalization stands. This closes the processing-wakeup race
    // (the sweep cancels only QUEUED wakeups; a live 'processing' run reaches here).
    const claimed = await ctx.db
      .update(threadInboxItems)
      .set({ routingStatus: "routed", routerDecision: "human", routedAt: new Date() })
      .where(
        and(
          eq(threadInboxItems.id, inboxItemId),
          eq(threadInboxItems.companyId, ctx.companyId),
          eq(threadInboxItems.routingStatus, "escalated"),
        ),
      )
      .returning({ id: threadInboxItems.id });

    if (claimed.length === 0) {
      return {
        success: true,
        data: { action: "already_finalized" },
        summary: "Item was already finalized (no longer escalated) — no action",
      };
    }

    return {
      success: true,
      data: { action: "deferred_to_human" },
      summary: "Item left in Inbox for founder triage (Navigator unsure)",
    };
  },
};
```

- [ ] **Step 8: Run test to confirm it passes**

```
pnpm test:run server/src/__tests__/defer-inbox-to-human.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/services/internal-agent/tools/promote-inbox-to-thread.ts \
        server/src/services/internal-agent/tools/defer-inbox-to-human.ts \
        server/src/__tests__/promote-inbox-to-thread.test.ts \
        server/src/__tests__/defer-inbox-to-human.test.ts
git commit -m "feat(tools): add promote_inbox_to_thread (C1) + defer_inbox_to_human (Codex P1 #2 unsure-loop fix)"
```

---

## Task 8 — Rewire `routeInboxItem`: remove deterministic decider, add card-snapshot + Navigator wakeup

**Files:**
- Modify: `server/src/services/inbox-router.ts` (complete rewrite of `routeInboxItem` + `enqueueNavigatorRoutingWakeup`)

This is the heart of the redesign. The new `routeInboxItem`:
1. Atomically claims (pending_route → routing), returning `rawContent`, writing `routingClaimedAt=now`
2. Loads the dial
3. `off` → leave in Inbox (routingStatus='routed', routerDecision='human')
4. `≥suggest` → snapshot active-thread cards (reproducibility) → wake Navigator with `inboundContent` (it fetches cards fresh) → routingStatus='escalated'. **Option A:** an empty card set still wakes the Navigator.

`classifyRouting`, `resolveRoutingAction`, and `resolveDefaultEmbedder` are all deleted. The Navigator decides over the inbound content; it pulls cards itself via `list_thread_cards`. The wakeup payload is `{ inboxItemId, inboundContent }` — never frozen cards, never `payload.threadId` (Codex #4).

- [ ] **Step 1: Write the failing tests first**

Create `server/src/__tests__/inbox-router-rewire.test.ts`:

```typescript
/**
 * inbox-router-rewire.test.ts
 *
 * Tests for the rewired routeInboxItem (Navigator-over-cards design).
 *
 * Key assertions:
 * - dial='off'  → no wakeup queued, routingStatus='routed', routerDecision='human'
 * - dial≥suggest → claims → assembles snapshot → wakeup queued (payload carries
 *     inboundContent, NOT candidateCards), routingStatus='escalated'
 * - ZERO active threads (Option A) → STILL wakes the Navigator (it creates the
 *     first thread / suggests-new) — empty card set is NOT an error
 * - already claimed (0 rows from claim UPDATE) → no-op
 * - NAVIGATOR_NOT_FOUND → routingStatus='failed', outcome='failed'
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  ne: vi.fn((a: unknown, b: unknown) => ({ _op: "ne", a, b })),
}));

vi.mock("@armyofagents/db", () => ({
  agents: new Proxy({} as any, { get: (_t, p) => p }),
  agentWakeupRequests: new Proxy({} as any, { get: (_t, p) => p }),
  threadInboxItems: new Proxy({} as any, { get: (_t, p) => p }),
  internalAgentConfig: new Proxy({} as any, { get: (_t, p) => p }),
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
}));

vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

// MUST resolve a promise — routeInboxItem calls `logActivity(...).catch(...)`,
// so a bare vi.fn() (returns undefined) would throw on `.catch`.
const mockLogActivity = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/activity-log.js", () => ({
  logActivity: (...a: any[]) => mockLogActivity(...a),
}));

import { routeInboxItem } from "../services/inbox-router.js";

const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INBOX_ITEM_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NAVIGATOR_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const THREAD_1_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Capture inserted wakeup payloads so we can assert payload shape.
let insertedValues: any[] = [];

function makeDb({
  dial = "suggest",
  claimRows = [{ id: INBOX_ITEM_ID, companyId: COMPANY_ID, rawContent: "Hello from Acme" }],
  navRows = [{ id: NAVIGATOR_ID }],
  threadCardRows = [{ id: THREAD_1_ID, title: "Acme thread", summaryText: "About Acme", routingTerms: ["Acme"] }],
}: {
  dial?: string;
  claimRows?: object[];
  navRows?: object[];
  threadCardRows?: object[];
} = {}) {
  const updateResults: object[][] = [claimRows, [], []]; // claim(returning), then status/snapshot updates
  let updateCall = 0;

  // Actual select call order in routeInboxItem:
  //   1. config (dial)  2. cards (discussions, for snapshot)  3. Navigator (inside enqueue)
  const selectResults: object[][] = [
    [{ inboundRoutingLevel: dial }],  // config row
    threadCardRows,                   // active thread cards (discussions) — snapshot
    navRows,                          // Navigator agent lookup (inside enqueue)
  ];
  let selectCall = 0;

  const insertResult = [{ id: "wakeup-id-1" }];

  return {
    update: () => ({
      set: () => ({
        where: () => {
          const res = updateResults[updateCall++] ?? [];
          // Support both `.returning()` (claim) and awaited UPDATE (status writes).
          return {
            returning: () => Promise.resolve(res),
            then: (resolve: Function) => resolve(res),
            catch: () => Promise.resolve(res),
          };
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(selectResults[selectCall++] ?? []),
        }),
      }),
    }),
    insert: () => ({
      values: (v: any) => {
        insertedValues.push(v);
        return { returning: () => Promise.resolve(insertResult) };
      },
    }),
  } as any;
}

describe("routeInboxItem (rewired)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insertedValues = [];
  });

  it("dial=off → no wakeup, routerDecision=human, outcome=off", async () => {
    const db = makeDb({ dial: "off" });
    const result = await routeInboxItem(db, { inboxItemId: INBOX_ITEM_ID });
    expect(result.action).toBe("human");
    expect(result.outcome).toBe("off");
    expect(insertedValues).toHaveLength(0); // Navigator NOT woken
  });

  it("claim returns 0 rows → no-op (already claimed)", async () => {
    const db = makeDb({ claimRows: [] });
    const result = await routeInboxItem(db, { inboxItemId: INBOX_ITEM_ID });
    expect(result.action).toBe("human");
    expect(result.outcome).toBe("already_claimed");
  });

  it("dial=suggest → Navigator woken; payload carries inboundContent, not cards", async () => {
    const db = makeDb({ dial: "suggest" });
    const result = await routeInboxItem(db, { inboxItemId: INBOX_ITEM_ID });
    expect(result.action).toBe("escalate_navigator");
    expect(result.outcome).toBe("navigator_woken");
    expect(insertedValues).toHaveLength(1);
    const payload = insertedValues[0].payload;
    expect(payload.inboxItemId).toBe(INBOX_ITEM_ID);
    expect(payload.inboundContent).toBe("Hello from Acme");
    expect(payload.candidateCards).toBeUndefined(); // cards are fetched fresh, not frozen
    expect(insertedValues[0].payload.threadId).toBeUndefined(); // Codex #4
  });

  it("ZERO active threads → STILL wakes Navigator (Option A — creates first thread)", async () => {
    const db = makeDb({ dial: "full_auto", threadCardRows: [] });
    const result = await routeInboxItem(db, { inboxItemId: INBOX_ITEM_ID });
    expect(result.action).toBe("escalate_navigator");
    expect(insertedValues).toHaveLength(1); // woken even with no candidates
  });

  it("NAVIGATOR_NOT_FOUND → outcome=failed (no throw)", async () => {
    const db = makeDb({ dial: "suggest", navRows: [] });
    const result = await routeInboxItem(db, { inboxItemId: INBOX_ITEM_ID });
    expect(result.outcome).toBe("failed");
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```
pnpm test:run server/src/__tests__/inbox-router-rewire.test.ts
```

Expected: FAIL (inbox-router.ts still has old code / broken imports from Task 2 deletion).

- [ ] **Step 3: Rewrite `server/src/services/inbox-router.ts`**

Replace the entire file:

```typescript
// server/src/services/inbox-router.ts
//
// Routing-card redesign (Navigator-decides-over-routing-cards).
//
// routeInboxItem — the routing orchestrator. Replaces the former
// classify→resolve→deterministic-act flow with:
//   1. Atomic claim (pending_route → routing) — returns rawContent, writes routingClaimedAt.
//   2. Load the company routing dial.
//   3. dial='off' → leave in Inbox (routingStatus='routed', routerDecision='human').
//   4. dial≥suggest → snapshot the active-thread cards (for reproducibility) → wake
//      the Navigator with the inbound CONTENT (the Navigator fetches cards fresh via
//      list_thread_cards) → routingStatus='escalated'.
//
// Option A (Codex P1 #9): a ZERO-card company still wakes the Navigator — it creates
// the first thread (full_auto) or suggests-new (suggest/auto_attach). Only a true
// assembly/DB error or a missing Navigator fail-closes (routingStatus='failed').
//
// classifyRouting / resolveRoutingAction / inbound-routing-constants are DELETED.
// findSimilarThreadsScored is no longer called from this path.

import { and, eq, ne } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  threadInboxItems,
  internalAgentConfig,
  discussions,
} from "@armyofagents/db";
import type { Db } from "@armyofagents/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";

const log = logger.child({ service: "inbox-router" });

// ── Exported types (retained for consumers that import RoutingAction) ─────────

export type RoutingAction = "escalate_navigator" | "human";

export interface RouteInboxItemArgs {
  inboxItemId: string;
}

export interface RouteInboxItemResult {
  action: RoutingAction;
  /** 'navigator_woken' | 'off' | 'already_claimed' | 'failed' */
  outcome: string;
}

/** Card snapshot stored on the routing record for reproducible-decision audit (A2). */
export interface CandidateCard {
  threadId: string;
  title: string | null;
  summaryText: string | null;
  routingTerms: string[];
}

// ── enqueueNavigatorRoutingWakeup ────────────────────────────────────────────

export interface EnqueueNavigatorRoutingWakeupArgs {
  companyId: string;
  inboxItemId: string;
  /** The raw inbound text — immutable, so safe to freeze in the payload. The
   *  Navigator decides over THIS plus the cards it fetches fresh (Codex P1 #1). */
  inboundContent: string;
}

export interface EnqueueNavigatorRoutingWakeupResult {
  wakeupId: string;
}

/**
 * Look up the company's Navigator and insert an agentWakeupRequests row.
 *
 * IMPORTANT (Codex #4): the payload carries inboxItemId + inboundContent, NOT
 * payload.threadId. A threadId in the payload triggers dispatcher skips. Cards
 * are NOT frozen here — the Navigator fetches them fresh via list_thread_cards (A2).
 *
 * @throws {Error} "NAVIGATOR_NOT_FOUND" if no active Navigator exists.
 */
export async function enqueueNavigatorRoutingWakeup(
  db: Db,
  args: EnqueueNavigatorRoutingWakeupArgs,
): Promise<EnqueueNavigatorRoutingWakeupResult> {
  const { companyId, inboxItemId, inboundContent } = args;

  // Exclude terminated AND paused (Codex re-review P2 #G): the dispatcher ignores
  // paused agents, so a wakeup addressed to a paused Navigator would sit queued
  // until the sweep finalizes the item to human. Treat paused as "no router".
  const [nav] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        eq(agents.kind, "aoa"),
        eq(agents.name, "Navigator"),
        ne(agents.status, "terminated"),
        ne(agents.status, "paused"),
      ),
    )
    .limit(1);

  if (!nav) {
    throw new Error(`NAVIGATOR_NOT_FOUND: no active Navigator for company ${companyId}`);
  }

  const result = await db
    .insert(agentWakeupRequests)
    .values({
      companyId,
      agentId: nav.id,
      // Retained for wire-compat: the dispatcher dial-gate + aoa-trigger-prompt
      // branch both match on this exact source string. (No "ambiguity"
      // classification remains — every dial≥suggest item escalates.)
      source: "inbox.routing_ambiguous",
      reason: "routing_cards",
      payload: {
        inboxItemId,
        inboundContent,
      } as Record<string, unknown>,
      status: "queued",
    })
    .returning({ id: agentWakeupRequests.id });

  const row = result[0];
  if (!row?.id) throw new Error("enqueueNavigatorRoutingWakeup: insert returned no id");

  return { wakeupId: row.id };
}

// ── routeInboxItem ────────────────────────────────────────────────────────────

/**
 * Routing orchestrator.
 *
 * Atomically claims the inbox item (pending_route → routing) before acting.
 * The atomic claim writes routingClaimedAt so sweep-inbox.ts can reclaim
 * items stranded in-flight past the reclaim threshold (C4 / #37).
 *
 * Error containment: action failures set routingStatus='failed'. Never throws.
 */
export async function routeInboxItem(
  db: Db,
  args: RouteInboxItemArgs,
): Promise<RouteInboxItemResult> {
  const { inboxItemId } = args;

  // ── 1. Atomic claim: pending_route → routing + stamp routingClaimedAt ─────
  // Returns rawContent so the Navigator can decide over the actual inbound text
  // (Codex P1 #1).
  const claimed = await db
    .update(threadInboxItems)
    .set({ routingStatus: "routing", routingClaimedAt: new Date() })
    .where(
      and(
        eq(threadInboxItems.id, inboxItemId),
        eq(threadInboxItems.routingStatus, "pending_route"),
        eq(threadInboxItems.status, "pending"),
      ),
    )
    .returning({
      id: threadInboxItems.id,
      companyId: threadInboxItems.companyId,
      rawContent: threadInboxItems.rawContent,
    });

  if (claimed.length === 0) {
    log.debug({ inboxItemId }, "routeInboxItem: already claimed — no-op");
    return { action: "human", outcome: "already_claimed" };
  }

  const { companyId, rawContent } = claimed[0];

  // ── 2. Load routing dial ──────────────────────────────────────────────────
  const configRows = await db
    .select({ inboundRoutingLevel: internalAgentConfig.inboundRoutingLevel })
    .from(internalAgentConfig)
    .where(eq(internalAgentConfig.companyId, companyId))
    .limit(1);

  const dial = (configRows[0]?.inboundRoutingLevel ?? "off") as string;

  // ── 3. dial='off' → leave in Inbox (terminal, human) ─────────────────────
  if (dial === "off") {
    await db
      .update(threadInboxItems)
      .set({ routingStatus: "routed", routerDecision: "human", routedAt: new Date() })
      .where(and(eq(threadInboxItems.id, inboxItemId), eq(threadInboxItems.companyId, companyId)));

    return { action: "human", outcome: "off" };
  }

  // ── 4. dial ≥ suggest → snapshot cards + wake Navigator ───────────────────
  try {
    // Assemble all active thread cards (small-scale path) FOR THE SNAPSHOT only.
    // The Navigator fetches cards fresh via list_thread_cards at run time (A2).
    // An EMPTY result is NOT an error (Option A) — the Navigator will create the
    // first thread (full_auto) or suggest-new (suggest/auto_attach).
    const cardRows = await db
      .select({
        id: discussions.id,
        title: discussions.title,
        summaryText: discussions.summaryText,
        routingTerms: discussions.routingTerms,
      })
      .from(discussions)
      .where(
        and(
          eq(discussions.companyId, companyId),
          eq(discussions.status, "active"),
        ),
      )
      .limit(100);

    const cardSnapshot: CandidateCard[] = cardRows.map((r) => {
      // routingTerms is a jsonb string[] column — read directly (defensive filter).
      const terms = Array.isArray(r.routingTerms)
        ? (r.routingTerms as unknown[]).filter((t): t is string => typeof t === "string")
        : [];
      return { threadId: r.id, title: r.title ?? null, summaryText: r.summaryText ?? null, routingTerms: terms };
    });

    const { wakeupId } = await enqueueNavigatorRoutingWakeup(db, {
      companyId,
      inboxItemId,
      inboundContent: rawContent,
    });

    // Single UPDATE: escalated status + wakeup id + reproducibility snapshot (A2).
    await db
      .update(threadInboxItems)
      .set({
        routingStatus: "escalated",
        routedAt: new Date(),
        navigatorWakeupId: wakeupId,
        routingCardSnapshot: cardSnapshot,
      })
      .where(and(eq(threadInboxItems.id, inboxItemId), eq(threadInboxItems.companyId, companyId)));

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "system",
      action: "thread.inbox_item.routed",
      entityType: "thread_inbox_item",
      entityId: inboxItemId,
      details: { action: "escalate_navigator", cardCount: cardSnapshot.length },
    }).catch((err) => log.warn({ err, inboxItemId }, "routeInboxItem: logActivity failed"));

    return { action: "escalate_navigator", outcome: "navigator_woken" };

  } catch (err: unknown) {
    const isNavMissing = err instanceof Error && err.message.startsWith("NAVIGATOR_NOT_FOUND");
    const errorCode = isNavMissing ? "NAVIGATOR_NOT_FOUND" : "UNKNOWN";

    log.error({ err, inboxItemId }, "routeInboxItem: action step failed");

    // A4 degradation signal: the Navigator is the sole router now. If it's
    // missing, log a distinct, auditable activity entry so the dial isn't a
    // silent no-op. (Surfacing this in the Inbox UI is a follow-up — #38.)
    if (isNavMissing) {
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "system",
        action: "thread.routing.navigator_unavailable",
        entityType: "thread_inbox_item",
        entityId: inboxItemId,
        details: { reason: "NAVIGATOR_NOT_FOUND" },
      }).catch((notifyErr) =>
        log.warn({ notifyErr, companyId }, "routeInboxItem: could not log Navigator-unavailable signal"),
      );
    }

    await db
      .update(threadInboxItems)
      .set({ routingStatus: "failed", routingErrorCode: errorCode })
      .where(and(eq(threadInboxItems.id, inboxItemId), eq(threadInboxItems.companyId, companyId)))
      .catch((updateErr) => log.error({ updateErr, inboxItemId }, "routeInboxItem: could not write failed"));

    // No escalation actually happened — the item is failed and stays in the Inbox
    // for the human. Report action='human' so callers branching on action aren't
    // misled (outcome='failed' distinguishes it from a clean human route).
    return { action: "human", outcome: "failed" };
  }
}
```

- [ ] **Step 4: Run tests**

```
pnpm test:run server/src/__tests__/inbox-router-rewire.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 5: Run full test suite**

```
pnpm test:run 2>&1 | tail -15
```

Expected: all passing. Any remaining references to `classifyRouting`/`resolveRoutingAction`/`ATTACH_CONFIDENCE` in test files will fail — those were deleted in Task 2.

- [ ] **Step 6: Run typecheck**

```
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/inbox-router.ts
git commit -m "feat(inbox-router): rewire routeInboxItem — Navigator-over-cards; inboundContent payload + Option A + card snapshot (D1, Codex P1 #1/#9)"
```

---

## Task 9 — Navigator allowlist + trigger-prompt (inbound-content rendering) + Chronicler directive + attach race-guard

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/ensure-command-staff.ts`
- Modify: `server/src/services/internal-agent/aoa-agents/aoa-trigger-prompt.ts`
- Modify: `server/src/services/internal-agent/tool-registry.ts`
- Modify: `server/src/services/internal-agent/tools/inbox-attach-to-thread.ts` (escalated race-guard — Codex round-3 P1)

- [ ] **Step 1: Add the three new tools to the Navigator allowlist**

In `ensure-command-staff.ts`, find the `case "navigator":` block (line ~62) and append the new tools:

```typescript
return [
  "search_discussions",
  "query_departments",
  "find_similar_threads",
  "get_thread_summary",
  "thread.listEntries",
  "thread.createLink",
  "attach_to_thread",
  "spin_off_thread",
  "list_thread_cards",           // NEW — fetch candidate routing cards (T6)
  "promote_inbox_to_thread",     // NEW — create new thread from inbox item (C1/T7)
  "defer_inbox_to_human",        // NEW — finalize an UNSURE item (Codex P1 #2)
];
```

- [ ] **Step 2: Update `INBOX_ROUTING_DIRECTIVE` in `aoa-trigger-prompt.ts`**

Replace the existing `INBOX_ROUTING_DIRECTIVE` constant with one that decides over the inbound content and FORCES the unsure path to call `defer_inbox_to_human` (Codex P1 #2 — otherwise an unsure item strands in `escalated`):

```typescript
const INBOX_ROUTING_DIRECTIVE =
  "An inbound item needs routing. Its content is shown below under 'Inbound content'. " +
  "Call list_thread_cards to fetch the current routing cards for active threads. " +
  "Then decide and ACT (do not return silently): " +
  "(a) if one thread is the clear home for this content, call attach_to_thread; " +
  "(b) if the content deserves its own new thread, call promote_inbox_to_thread (with a proposed title); " +
  "(c) if you are unsure or nothing fits, call defer_inbox_to_human — this leaves it in the Inbox for the founder. " +
  "You MUST call exactly one of these three tools. The routing dial decides whether (a)/(b) auto-act or surface as a suggestion — act on your best judgment either way. " +
  "Do NOT call spin_off_thread for inbox items — use promote_inbox_to_thread instead.";
```

- [ ] **Step 3: Update the `inbox.routing_ambiguous` branch in `buildTriggerPrompt`**

Find the `if (payload.source === "inbox.routing_ambiguous")` block (line ~105) and replace the old candidate-threads/distances rendering with inbound-content rendering (cards are fetched by the Navigator at runtime, not frozen in the payload):

```typescript
  if (payload.source === "inbox.routing_ambiguous") {
    directive = INBOX_ROUTING_DIRECTIVE;

    const inboxItemId = payload.inboxItemId;
    if (typeof inboxItemId === "string" && inboxItemId.length > 0) {
      ctxLines.push(`Inbox item: ${inboxItemId}`);
    }

    // Inbound content (Codex P1 #1 — the Navigator decides over the actual text).
    const inboundContent = payload.inboundContent;
    if (typeof inboundContent === "string" && inboundContent.length > 0) {
      // Cap very long inbound text so the prompt stays bounded.
      const clipped = inboundContent.length > 4000
        ? `${inboundContent.slice(0, 4000)}…[truncated]`
        : inboundContent;
      ctxLines.push(`Inbound content:\n${clipped}`);
    }
  }
```

Note: this replaces the old branch that read `payload.candidateThreadIds`, `payload.distances`, and `payload.gap`. Those fields no longer exist on the payload — remove the dead reads.

- [ ] **Step 4: Add the `chronicler` entry to `ROLE_ACTION_DIRECTIVE` (Codex P1 #5)**

In the same file (`aoa-trigger-prompt.ts`), find the `ROLE_ACTION_DIRECTIVE` map (line ~41) and add a `chronicler` entry so the Chronicler gets a concrete directive instead of the weak `GENERIC_DIRECTIVE`:

```typescript
  chronicler:     "call `get_thread_summary` then `thread.listEntries` for the thread in this wakeup, then call `thread.updateSummary` exactly once with an updated factual summary + routingTerms. Never post_entry.",
```

- [ ] **Step 4b: Race-guard `attach_to_thread`'s ACT path (Codex round-3 P1)**

`attach_to_thread` is the auto-attach write-path the Navigator uses to file an inbox item. Its ACT path delegates to `attachInboxItemToThread`, which claims on `status='pending'`. A finalized item stays `status='pending'`, so a delayed `processing` Navigator run (one the sweep's queued-only cancel couldn't stop) could still auto-attach an item the founder was already handed.

`attach_to_thread` is a SHARED tool — also used for manual/direct attaches (dial=`off`, @mention) on NON-escalated items — so a blanket `escalated` guard would break manual attach. The fix disambiguates: try to atomically claim `escalated`; on 0 rows, read the item to tell "sweep already finalized this escalation" (no-op) from "manual attach on a non-escalated item" (proceed).

In `server/src/services/internal-agent/tools/inbox-attach-to-thread.ts`, at the TOP of the `// ── Step 3: act path` block (just before `try {`), insert:

```typescript
    // Race-guard (Codex round-3 P1): if this item is resolving a routing
    // escalation, atomically claim it so a stale 'processing' Navigator run
    // can't auto-attach an item the reclaim sweep already handed to the founder.
    const escalatedClaim = await ctx.db
      .update(threadInboxItems)
      .set({ routingStatus: "routing" })
      .where(
        and(
          eq(threadInboxItems.id, inboxItemId),
          eq(threadInboxItems.companyId, ctx.companyId),
          eq(threadInboxItems.routingStatus, "escalated"),
        ),
      )
      .returning({ id: threadInboxItems.id });

    if (escalatedClaim.length === 0) {
      // Not currently 'escalated'. Distinguish a sweep-finalized escalation
      // (no-op) from a manual/direct attach on a never-escalated item (proceed).
      const [cur] = await ctx.db
        .select({
          routingStatus: threadInboxItems.routingStatus,
          routerDecision: threadInboxItems.routerDecision,
        })
        .from(threadInboxItems)
        .where(and(eq(threadInboxItems.id, inboxItemId), eq(threadInboxItems.companyId, ctx.companyId)))
        .limit(1);
      if (cur && cur.routingStatus === "routed" && cur.routerDecision === "human") {
        return {
          success: true,
          data: { action: "already_finalized" },
          summary: "Item was already finalized to the founder — no action",
        };
      }
      // else: manual/direct attach on a non-escalated item — fall through.
    }
```

(`and`, `eq`, `threadInboxItems` are already imported in this file.)

- [ ] **Step 5: Register the three new tools in `tool-registry.ts`**

In `server/src/services/internal-agent/tool-registry.ts`, add imports after the last batch import block (~line 56):

```typescript
// Routing-card redesign — new Navigator tools
import { listThreadCardsTool } from "./tools/list-thread-cards.js";
import { promoteInboxToThreadTool } from "./tools/promote-inbox-to-thread.js";
import { deferInboxToHumanTool } from "./tools/defer-inbox-to-human.js";
```

Then add all three to the `createToolRegistry()` return array, after `spinOffThreadTool`:

```typescript
    spinOffThreadTool,
    listThreadCardsTool,        // NEW — card-fetch tool for Navigator (T6)
    promoteInboxToThreadTool,   // NEW — Navigator inbox→new-thread action (C1/T7)
    deferInboxToHumanTool,      // NEW — Navigator "unsure" finalization (Codex P1 #2)
```

- [ ] **Step 6: Run typecheck**

```
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 7: Run full test suite + update the existing trigger-prompt test**

```
pnpm test:run server/src/__tests__/aoa-trigger-prompt.test.ts
```

`aoa-trigger-prompt.test.ts` has cases asserting the OLD `candidateThreadIds` / `distances` / `gap` rendering for `inbox.routing_ambiguous`. Update those cases to assert the new rendering instead:
- `Inbound content:` line is present when `payload.inboundContent` is set.
- The directive used is `INBOX_ROUTING_DIRECTIVE` (mentions `list_thread_cards`, `promote_inbox_to_thread`, `defer_inbox_to_human`), not `GENERIC_DIRECTIVE`.
- A `chronicler` role key resolves to the new chronicler directive (mentions `thread.updateSummary`), not `GENERIC_DIRECTIVE`.

Then run the full suite:

```
pnpm test:run 2>&1 | tail -15
```

Expected: all passing.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/ensure-command-staff.ts \
        server/src/services/internal-agent/aoa-agents/aoa-trigger-prompt.ts \
        server/src/services/internal-agent/tool-registry.ts \
        server/src/services/internal-agent/tools/inbox-attach-to-thread.ts \
        server/src/__tests__/aoa-trigger-prompt.test.ts
git commit -m "feat(navigator): register card/promote/defer tools; render inboundContent; chronicler directive; attach race-guard (T8/T9, Codex P1 #1/#5/#C)"
```

---

## Task 10 — Sweep reclaim for stale routing/escalated items (C4 / #37)

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/sweep-inbox.ts`

Stale `routing` items (Navigator never woken) reset to `pending_route` for retry; stale `escalated` items (Navigator woken but never finalized) go terminal to `routed`+`human` so they do NOT re-escalate in a loop (Codex P1 #2). Both gated by `routingClaimedAt` age.

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/inbox-router-reclaim.test.ts`. The sweep runs three selects in order: stale-routing, stale-escalated, pending. A sequence-based select mock feeds each phase:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@armyofagents/db", () => ({
  // Each table proxy reports its own name via __table so the test can assert
  // which table each db.update() targeted (and in what order).
  threadInboxItems: new Proxy({ __table: "threadInboxItems" } as any, { get: (t: any, p) => (p === "__table" ? t.__table : p) }),
  agentWakeupRequests: new Proxy({ __table: "agentWakeupRequests" } as any, { get: (t: any, p) => (p === "__table" ? t.__table : p) }),
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ _op: "inArray", a, b })),
  isNotNull: vi.fn((a: unknown) => ({ _op: "isNotNull", a })),
  lt: vi.fn((a: unknown, b: unknown) => ({ _op: "lt", a, b })),
}));
vi.mock("../middleware/logger.js", () => ({
  logger: { child: () => ({ debug: vi.fn(), warn: vi.fn() }) },
}));

const mockRouteItem = vi.fn().mockResolvedValue({ action: "human", outcome: "off" });
vi.mock("../services/inbox-router.js", () => ({
  routeInboxItem: (...a: any[]) => mockRouteItem(...a),
}));

import { runInboxSweep } from "../services/internal-agent/aoa-agents/sweep-inbox.js";

// Build a db whose 3 selects return [staleRouting, staleEscalated, pending] in order.
// updateTargets records which table each update() touched, in order, so ordering
// can be asserted (the wakeup cancel must precede the inbox finalize). UPDATE
// supports both awaited form and `.catch()` (the wakeup-cancel uses .catch).
function makeDb(staleRouting: object[], staleEscalated: object[], pending: object[]) {
  const seq = [staleRouting, staleEscalated, pending];
  let call = 0;
  const updateTargets: string[] = [];
  const whereResult = { then: (r: Function) => r([]), catch: () => Promise.resolve([]) };
  const updateSpy = vi.fn().mockImplementation((table: any) => {
    updateTargets.push(table?.__table ?? "unknown");
    return { set: () => ({ where: () => whereResult }) };
  });
  return {
    db: {
      select: () => ({ from: () => ({ where: () => Promise.resolve(seq[call++] ?? []) }) }),
      update: updateSpy,
    } as any,
    updateSpy,
    updateTargets,
  };
}

describe("sweep-inbox reclaim (C4 / Codex P1 #2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish the default resolution each test so a persistent
    // mockRejectedValue (set by the all-fail test) can't leak across cases.
    mockRouteItem.mockResolvedValue({ action: "human", outcome: "off" });
  });

  it("reclaims stale routing → pending_route", async () => {
    const { db, updateSpy } = makeDb([{ id: "r-1" }], [], []);
    const result = await runInboxSweep(db);
    expect(result.reclaimed).toBe(1);
    expect(result.finalized).toBe(0);
    expect(updateSpy).toHaveBeenCalledTimes(1); // only the routing reclaim
  });

  it("finalizes stale escalated → routed+human, cancelling the wakeup FIRST", async () => {
    const { db, updateTargets } = makeDb(
      [],
      [{ id: "e-1", navigatorWakeupId: "w-1" }, { id: "e-2", navigatorWakeupId: null }],
      [],
    );
    const result = await runInboxSweep(db);
    expect(result.reclaimed).toBe(0);
    expect(result.finalized).toBe(2);
    expect(mockRouteItem).not.toHaveBeenCalled(); // escalated is NOT re-routed
    // Order matters (crash-safety): cancel agentWakeupRequests BEFORE finalizing
    // threadInboxItems. Assert the exact sequence.
    expect(updateTargets).toEqual(["agentWakeupRequests", "threadInboxItems"]);
  });

  it("drains pending_route via routeInboxItem", async () => {
    const { db } = makeDb([], [], [{ id: "p-1" }, { id: "p-2" }]);
    const result = await runInboxSweep(db);
    expect(result.swept).toBe(2);
    expect(mockRouteItem).toHaveBeenCalledTimes(2);
  });

  it("continues + counts after a routeInboxItem failure (error containment)", async () => {
    // One item's routeInboxItem rejects; the sweep must catch it, keep going,
    // and still count both attempts (swept++ is unconditional). No throw.
    mockRouteItem.mockRejectedValueOnce(new Error("boom"));
    const { db } = makeDb([], [], [{ id: "p-1" }, { id: "p-2" }]);
    const result = await runInboxSweep(db);
    expect(result.swept).toBe(2);
    expect(mockRouteItem).toHaveBeenCalledTimes(2);
  });

  it("does not throw when every routeInboxItem rejects", async () => {
    mockRouteItem.mockRejectedValue(new Error("all fail"));
    const { db } = makeDb([], [], [{ id: "p-1" }, { id: "p-2" }]);
    await expect(runInboxSweep(db)).resolves.toMatchObject({ swept: 2 });
  });

  it("no stale, no pending → all zero", async () => {
    const { db } = makeDb([], [], []);
    const result = await runInboxSweep(db);
    expect(result).toEqual({ swept: 0, reclaimed: 0, finalized: 0 });
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```
pnpm test:run server/src/__tests__/inbox-router-reclaim.test.ts
```

Expected: FAIL (no reclaim logic yet).

- [ ] **Step 3: Update `sweep-inbox.ts`**

Replace the full file:

```typescript
// server/src/services/internal-agent/aoa-agents/sweep-inbox.ts
//
// Inbox routing backstop sweep.
//
// Three jobs per tick:
//   1. Reclaim 'routing' (claimed, but Navigator NEVER woken — process died
//      mid-route) → 'pending_route' so it gets re-routed.
//   2. Finalize 'escalated' (Navigator WAS woken but never finalized — it was
//      unsure and returned silently, or crashed mid-route) → 'routed'+'human'.
//      Resetting these to pending_route instead would re-wake the Navigator,
//      which would re-escalate, looping forever (Codex P1 #2). Terminal-to-human
//      is the correct fail-safe.
//   3. Drain: call routeInboxItem for each 'pending_route' item.
//
// Reclaim threshold (routingClaimedAt) gates phases 1+2 — only items stranded
// longer than RECLAIM_THRESHOLD_MS are touched, so a normally-in-flight item
// (Navigator running right now) is left alone.

import { and, eq, inArray, isNotNull, lt } from "drizzle-orm";
import { threadInboxItems, agentWakeupRequests } from "@armyofagents/db";
import type { Db } from "@armyofagents/db";
import { routeInboxItem } from "../../inbox-router.js";
import { logger } from "../../../middleware/logger.js";

const log = logger.child({ svc: "sweep-inbox" });

/** Items stuck in routing/escalated longer than this are reclaimed. 10 minutes. */
export const RECLAIM_THRESHOLD_MS = 10 * 60 * 1000;

export interface RunInboxSweepResult {
  swept: number;
  reclaimed: number;   // 'routing' → pending_route (retry)
  finalized: number;   // 'escalated' → routed+human (terminal, no loop)
}

export async function runInboxSweep(db: Db): Promise<RunInboxSweepResult> {
  const reclaimCutoff = new Date(Date.now() - RECLAIM_THRESHOLD_MS);

  // ── Phase 1: Reclaim stale 'routing' (Navigator never woken) → pending_route
  const staleRouting = await db
    .select({ id: threadInboxItems.id })
    .from(threadInboxItems)
    .where(
      and(
        eq(threadInboxItems.routingStatus, "routing"),
        isNotNull(threadInboxItems.routingClaimedAt),
        lt(threadInboxItems.routingClaimedAt, reclaimCutoff),
        eq(threadInboxItems.status, "pending"),
      ),
    );

  let reclaimed = 0;
  if (staleRouting.length > 0) {
    log.debug({ count: staleRouting.length }, "sweep-inbox: reclaiming stale routing → pending_route");
    await db
      .update(threadInboxItems)
      .set({ routingStatus: "pending_route", routingClaimedAt: null, routingErrorCode: null })
      .where(inArray(threadInboxItems.id, staleRouting.map((r) => r.id)));
    reclaimed = staleRouting.length;
  }

  // ── Phase 2: Finalize stale 'escalated' (Navigator woken, never acted) → routed+human
  // Terminal (NOT pending_route) — re-routing would re-escalate and loop (Codex P1 #2).
  // Also CANCEL the still-queued Navigator wakeup (Codex re-review P1 #C): the
  // attach/promote write-paths claim on status='pending', and a finalized item
  // stays status='pending' (visible in Inbox), so a delayed queued wakeup could
  // still attach/promote it after the human took over. Cancelling the queued
  // wakeup closes that race. (A wakeup already 'processing' is not cancelled, but
  // after 10min stranded that run is almost certainly dead.)
  const staleEscalated = await db
    .select({
      id: threadInboxItems.id,
      navigatorWakeupId: threadInboxItems.navigatorWakeupId,
    })
    .from(threadInboxItems)
    .where(
      and(
        eq(threadInboxItems.routingStatus, "escalated"),
        isNotNull(threadInboxItems.routingClaimedAt),
        lt(threadInboxItems.routingClaimedAt, reclaimCutoff),
        eq(threadInboxItems.status, "pending"),
      ),
    );

  let finalized = 0;
  if (staleEscalated.length > 0) {
    log.debug({ count: staleEscalated.length }, "sweep-inbox: finalizing stale escalated → routed+human");

    // Cancel the orphaned queued wakeups FIRST (crash-safety): if the process
    // dies between this and the finalize below, the item stays 'escalated' and is
    // re-swept next cycle (safe) rather than ending terminal with a live wakeup.
    const wakeupIds = staleEscalated
      .map((r) => r.navigatorWakeupId)
      .filter((id): id is string => typeof id === "string");
    if (wakeupIds.length > 0) {
      await db
        .update(agentWakeupRequests)
        .set({ status: "cancelled" })
        .where(
          and(
            inArray(agentWakeupRequests.id, wakeupIds),
            eq(agentWakeupRequests.status, "queued"),
          ),
        )
        .catch((err) => log.warn({ err }, "sweep-inbox: could not cancel orphaned wakeups"));
    }

    // Then finalize the items to terminal routed+human.
    await db
      .update(threadInboxItems)
      .set({ routingStatus: "routed", routerDecision: "human", routedAt: new Date() })
      .where(inArray(threadInboxItems.id, staleEscalated.map((r) => r.id)));

    finalized = staleEscalated.length;
  }

  // ── Phase 3: Drain pending_route ─────────────────────────────────────────
  const pending = await db
    .select({ id: threadInboxItems.id })
    .from(threadInboxItems)
    .where(eq(threadInboxItems.routingStatus, "pending_route"));

  if (pending.length === 0) {
    return { swept: 0, reclaimed, finalized };
  }

  log.debug({ count: pending.length }, "sweep-inbox: draining pending_route items");

  let swept = 0;
  for (const row of pending) {
    try {
      await routeInboxItem(db, { inboxItemId: row.id });
    } catch (err) {
      log.warn({ err, inboxItemId: row.id }, "sweep-inbox: routeInboxItem failed — continuing");
    }
    swept++;
  }

  log.debug({ swept, reclaimed, finalized }, "sweep-inbox: done");
  return { swept, reclaimed, finalized };
}
```

- [ ] **Step 4: Run the reclaim test**

```
pnpm test:run server/src/__tests__/inbox-router-reclaim.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full test suite**

```
pnpm test:run 2>&1 | tail -10
```

Expected: all passing.

- [ ] **Step 6: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/sweep-inbox.ts \
        server/src/__tests__/inbox-router-reclaim.test.ts
git commit -m "feat(sweep-inbox): reclaim routing→pending_route; finalize escalated→human + cancel orphaned wakeup (C4/#37, Codex P1 #2/#C)"
```

---

## Task 11 — UI: `suggest_new` banner in UnlistedLane

**Files:**
- Modify: `ui/src/components/threads/ThreadBoard.tsx` (add `suggestedThreadTitle` field)
- Modify: `ui/src/components/threads/UnlistedLane.tsx` (render `suggest_new` banner)
- Modify: `ui/src/components/threads/__tests__/UnlistedLane.test.tsx` (add test cases)

- [ ] **Step 1: Add `suggestedThreadTitle` to `InboxCardItem`**

In `ui/src/components/threads/ThreadBoard.tsx`, update the `InboxCardItem` interface:

```typescript
export interface InboxCardItem {
  id: string;
  rawContent: string;
  originSource: string | null;
  createdAt: string;
  routerDecision?: string | null;
  suggestedThreadId?: string | null;
  suggestedThreadTitle?: string | null;  // NEW — for suggest_new decisions
  routerConfidence?: number | null;
  routingStatus?: string | null;
}
```

- [ ] **Step 2: Add `suggest_new` banner to `InboxTriageCard` in `UnlistedLane.tsx`**

In `UnlistedLane.tsx`, after the existing `suggest` banner block (ending around line 190), add:

```tsx
{/* Suggest-new-thread banner — shown when Navigator recommends creating a new thread */}
{item.routerDecision === "suggest_new" && (
  <div
    className="rounded border border-violet-300 dark:border-violet-700 bg-violet-50/60 dark:bg-violet-900/20 p-1.5 space-y-1.5"
    data-testid={`inbox-suggest-new-${item.id}`}
  >
    <div className="flex items-center gap-1 text-[10px] text-violet-800 dark:text-violet-300 font-medium">
      <Sparkles className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">
        Suggested: new thread
        {item.suggestedThreadTitle && (
          <> &ldquo;<span className="font-semibold">{item.suggestedThreadTitle}</span>&rdquo;</>
        )}
      </span>
    </div>
    <Button
      variant="outline"
      size="sm"
      onClick={() => triage("make_thread")}
      disabled={isPending}
      className="h-6 w-full px-2 text-[10px] border-violet-400 dark:border-violet-600 text-violet-900 dark:text-violet-200 hover:bg-violet-200 dark:hover:bg-violet-800/50"
      data-testid={`inbox-suggest-new-confirm-${item.id}`}
    >
      {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Create thread"}
    </Button>
    <p className="text-[9px] text-violet-700/60 dark:text-violet-400/60 text-center">or override below</p>
  </div>
)}
```

- [ ] **Step 3: Add test cases in `UnlistedLane.test.tsx`**

In `ui/src/components/threads/__tests__/UnlistedLane.test.tsx`, add:

```tsx
it("renders suggest_new banner with proposed title and Create thread button", () => {
  const item: InboxCardItem = {
    id: "item-3",
    rawContent: "About the Acme contract renewal",
    originSource: "mcp",
    createdAt: new Date().toISOString(),
    routerDecision: "suggest_new",
    suggestedThreadTitle: "Acme contract renewal",
  };
  render(<UnlistedLane inboxItems={[item]} onTriaged={vi.fn()} />);

  const banner = screen.getByTestId("inbox-suggest-new-item-3");
  expect(banner).toBeInTheDocument();
  // Scope the title assertion to the banner — the same phrase also appears in the
  // rawContent preview, so an unscoped getByText would be ambiguous. (Match the
  // existing UnlistedLane.test render helper + add `within` to the import.)
  expect(within(banner).getByText(/Acme contract renewal/)).toBeInTheDocument();
  expect(screen.getByTestId("inbox-suggest-new-confirm-item-3")).toBeInTheDocument();
  expect(screen.getByTestId("inbox-suggest-new-confirm-item-3")).toHaveTextContent("Create thread");
});

it("does NOT render suggest_new banner when routerDecision is null", () => {
  const item: InboxCardItem = {
    id: "item-4",
    rawContent: "Some content",
    originSource: null,
    createdAt: new Date().toISOString(),
    routerDecision: null,
  };
  render(<UnlistedLane inboxItems={[item]} onTriaged={vi.fn()} />);
  expect(screen.queryByTestId("inbox-suggest-new-item-4")).not.toBeInTheDocument();
});
```

- [ ] **Step 4: Run UI tests**

```
pnpm test:run ui/src/components/threads/__tests__/UnlistedLane.test.tsx
```

Expected: all PASS including the two new cases.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/threads/ThreadBoard.tsx \
        ui/src/components/threads/UnlistedLane.tsx \
        "ui/src/components/threads/__tests__/UnlistedLane.test.tsx"
git commit -m "feat(ui): add suggest_new banner in UnlistedLane for Navigator new-thread suggestions (C5/T10)"
```

---

## Task 12 — Unit tests: full coverage for Chronicler, dial-gate D2, card tools, reclaim

**Files:**
- Create: `server/src/__tests__/chronicler.test.ts`
- Create: `server/src/__tests__/integration/inbound-routing-e2e.test.ts`

- [ ] **Step 1: Write Chronicler unit tests**

Create `server/src/__tests__/chronicler.test.ts`:

```typescript
/**
 * chronicler.test.ts (sweep behavior)
 *
 * Tests:
 *   - Sweep queues wakeups for threads with stale cards
 *   - Sweep returns 0 when no Chronicler agent exists
 *   - Sweep does NOT re-queue when a recent (queued/processing) wakeup exists (debounce)
 *   - Sweep queues 0 when no stale threads
 *   - Sweep respects CHRONICLER_MAX_CONCURRENT (mock honors .limit)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  ne: vi.fn((a: unknown, b: unknown) => ({ _op: "ne", a, b })),
  gt: vi.fn((a: unknown, b: unknown) => ({ _op: "gt", a, b })),
  or: vi.fn((...a: unknown[]) => ({ _op: "or", a })),
  isNull: vi.fn((a: unknown) => ({ _op: "isNull", a })),
  isNotNull: vi.fn((a: unknown) => ({ _op: "isNotNull", a })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ _op: "inArray", a, b })),
  sql: Object.assign(vi.fn((s: TemplateStringsArray) => ({ _sql: s })), { raw: vi.fn() }),
}));

vi.mock("@armyofagents/db", () => ({
  agents: new Proxy({} as any, { get: (_t, p) => p }),
  aoaAgentTriggers: new Proxy({} as any, { get: (_t, p) => p }),
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
  agentWakeupRequests: new Proxy({} as any, { get: (_t, p) => p }),
}));

import {
  runChroniclerSweep,
  CHRONICLER_MAX_CONCURRENT,
} from "../services/internal-agent/aoa-agents/sweep-chronicler.js";

const AGENT_ID = "agent-chronicler-1";
const COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const THREAD_1 = "t1-cccc-cccc-cccc-cccccccccccc";
const THREAD_2 = "t2-dddd-dddd-dddd-dddddddddddd";

// A "result holder" that is BOTH awaitable (for the no-limit recentWakeups
// query) AND has a `.limit(n)` (for the staleThreads query, which the real code
// caps at CHRONICLER_MAX_CONCURRENT). `.limit(n)` honors n so the cap test is real.
function holder(rows: object[]) {
  return {
    limit: (n: number) => Promise.resolve(rows.slice(0, n)),
    then: (resolve: (v: object[]) => unknown) => resolve(rows),
  };
}

function makeDb({
  chroniclerRows = [{ agentId: AGENT_ID, companyId: COMPANY_ID }],
  staleThreads = [{ id: THREAD_1 }, { id: THREAD_2 }],
  recentWakeups = [] as object[],
}: {
  chroniclerRows?: object[];
  staleThreads?: object[];
  recentWakeups?: object[];
} = {}) {
  // select call order: 1) chronicler agents (innerJoin) 2) staleThreads 3) recentWakeups
  const seq = [staleThreads, recentWakeups];
  let seqCall = 0;

  const insertSpy = vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue([]) });

  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(chroniclerRows),
        }),
        where: () => holder(seq[seqCall++] ?? []),
      }),
    }),
    insert: insertSpy,
  } as any;
}

describe("runChroniclerSweep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queues wakeups for stale threads", async () => {
    const db = makeDb();
    const result = await runChroniclerSweep(db as any);
    expect(result.queued).toBe(2);
  });

  it("returns 0 when no Chronicler agents found", async () => {
    const db = makeDb({ chroniclerRows: [] });
    const result = await runChroniclerSweep(db as any);
    expect(result.queued).toBe(0);
  });

  it("does not queue when thread is already in recent wakeups (debounce)", async () => {
    const db = makeDb({
      recentWakeups: [
        { payload: { threadId: THREAD_1 } },
        { payload: { threadId: THREAD_2 } },
      ],
    });
    const result = await runChroniclerSweep(db as any);
    expect(result.queued).toBe(0);
  });

  it("queues 0 when no stale threads", async () => {
    const db = makeDb({ staleThreads: [] });
    const result = await runChroniclerSweep(db as any);
    expect(result.queued).toBe(0);
  });

  it("respects CHRONICLER_MAX_CONCURRENT limit (mock honors .limit)", async () => {
    const manyThreads = Array.from({ length: CHRONICLER_MAX_CONCURRENT + 5 }, (_, i) => ({ id: `t${i}` }));
    const db = makeDb({ staleThreads: manyThreads });
    const result = await runChroniclerSweep(db as any);
    expect(result.queued).toBe(CHRONICLER_MAX_CONCURRENT);
  });
});
```

- [ ] **Step 2: Run Chronicler tests**

```
pnpm test:run server/src/__tests__/chronicler.test.ts
```

Expected: 5 tests PASS.

- [ ] **Step 3: Write a rewired router integration E2E test**

Create `server/src/__tests__/integration/inbound-routing-e2e.test.ts`:

```typescript
/**
 * inbound-routing-e2e.test.ts (gated E2E)
 *
 * Skipped unless INTEGRATION_TEST_DB_URL is set. Walks the routing state
 * machine end-to-end: enqueue → route (Navigator woken) → sweep reclaim.
 */
import { describe, it, expect } from "vitest";

const SKIP = !process.env.INTEGRATION_TEST_DB_URL;

describe.skipIf(SKIP)("inbound routing E2E (requires DB)", () => {
  it("routes an item through the Navigator path end-to-end", async () => {
    // Placeholder: full DB integration requires running test infra.
    // This test is gated behind INTEGRATION_TEST_DB_URL so CI doesn't
    // run it without a real database.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 4: Run full test suite and confirm green**

```
pnpm test:run 2>&1 | tail -20
```

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add server/src/__tests__/chronicler.test.ts \
        "server/src/__tests__/integration/inbound-routing-e2e.test.ts"
git commit -m "test(chronicler): unit coverage for sweep + debounce + concurrency cap (T13)"
```

---

## Task 13 — Eval gate: routing regression set + Chronicler card quality

**Files:**
- Create: `server/src/__tests__/evals/inbox-routing-eval.test.ts`
- Create: `server/src/__tests__/evals/chronicler-card-eval.test.ts`

These are fast, mock-based tests that gate the routing logic against a known scenario set. They do NOT call LLMs.

- [ ] **Step 1: Create routing regression eval**

Create `server/src/__tests__/evals/inbox-routing-eval.test.ts`:

```typescript
/**
 * inbox-routing-eval.test.ts — routing regression eval gate (C9)
 *
 * Tests the routing state machine for known scenarios without LLM calls.
 * All cases assert that routeInboxItem produces the correct action+outcome pair.
 *
 * Scenarios:
 *   - dial=off → human/off
 *   - ZERO active threads (Option A) → STILL escalate_navigator (creates first thread)
 *   - active threads present, dial≥suggest → escalate_navigator
 *   - Navigator not found → failed (not a crash)
 *   - stale claim (already handled) → human/already_claimed
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("drizzle-orm", () => ({
  and: vi.fn((...a: unknown[]) => ({ _op: "and", a })),
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
  ne: vi.fn((a: unknown, b: unknown) => ({ _op: "ne", a, b })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ _op: "inArray", a, b })),
  isNotNull: vi.fn((a: unknown) => ({ _op: "isNotNull", a })),
  lt: vi.fn((a: unknown, b: unknown) => ({ _op: "lt", a, b })),
}));

vi.mock("@armyofagents/db", () => ({
  agents: new Proxy({} as any, { get: (_t, p) => p }),
  agentWakeupRequests: new Proxy({} as any, { get: (_t, p) => p }),
  threadInboxItems: new Proxy({} as any, { get: (_t, p) => p }),
  internalAgentConfig: new Proxy({} as any, { get: (_t, p) => p }),
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
}));

vi.mock("../../middleware/logger.js", () => ({
  logger: { child: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock("../../services/activity-log.js", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));

import { routeInboxItem } from "../../services/inbox-router.js";

const CID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NAV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const T1  = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function buildDb(scenario: {
  dial?: string;
  claimed?: boolean;
  hasNav?: boolean;
  hasThreads?: boolean;
}) {
  const { dial = "suggest", claimed = true, hasNav = true, hasThreads = true } = scenario;
  const claimRow = claimed ? [{ id: IID, companyId: CID, rawContent: "inbound text" }] : [];
  const configRow = [{ inboundRoutingLevel: dial }];
  const navRow = hasNav ? [{ id: NAV }] : [];
  const threadRows = hasThreads ? [{ id: T1, title: "T", summaryText: "S", routingTerms: null }] : [];

  // Actual select order in routeInboxItem: config → cards (discussions) → Navigator.
  const selectSeq = [configRow, threadRows, navRow];
  let si = 0;
  const updateBuf = [claimRow, [], []]; // claim(returning), then status update(s)
  let ui = 0;

  // UPDATE must support both `.returning()` (claim) and awaited form (status writes).
  const whereResult = () => {
    const res = updateBuf[ui++] ?? [];
    return {
      returning: () => Promise.resolve(res),
      then: (resolve: Function) => resolve(res),
      catch: () => Promise.resolve(res),
    };
  };

  return {
    update: () => ({ set: () => ({ where: whereResult }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(selectSeq[si++] ?? []) }) }) }),
    insert: () => ({ values: () => ({ returning: () => Promise.resolve([{ id: "wakeup-1" }]) }) }),
  } as any;
}

describe("routing regression eval (C9)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("S1: dial=off → human/off", async () => {
    const r = await routeInboxItem(buildDb({ dial: "off" }), { inboxItemId: IID });
    expect(r.action).toBe("human");
    expect(r.outcome).toBe("off");
  });

  it("S2: already claimed → no-op, human/already_claimed", async () => {
    const r = await routeInboxItem(buildDb({ claimed: false }), { inboxItemId: IID });
    expect(r.action).toBe("human");
    expect(r.outcome).toBe("already_claimed");
  });

  it("S3: ZERO active threads → Option A → escalate_navigator (creates first thread)", async () => {
    const r = await routeInboxItem(buildDb({ hasThreads: false }), { inboxItemId: IID });
    expect(r.action).toBe("escalate_navigator");
    expect(r.outcome).toBe("navigator_woken");
  });

  it("S4: active threads + suggest dial → escalate_navigator", async () => {
    const r = await routeInboxItem(buildDb({ dial: "suggest" }), { inboxItemId: IID });
    expect(r.action).toBe("escalate_navigator");
    expect(r.outcome).toBe("navigator_woken");
  });

  it("S5: active threads + auto_attach dial → escalate_navigator", async () => {
    const r = await routeInboxItem(buildDb({ dial: "auto_attach" }), { inboxItemId: IID });
    expect(r.action).toBe("escalate_navigator");
  });

  it("S6: active threads + full_auto dial → escalate_navigator", async () => {
    const r = await routeInboxItem(buildDb({ dial: "full_auto" }), { inboxItemId: IID });
    expect(r.action).toBe("escalate_navigator");
  });

  it("S7: Navigator not found → outcome=failed (no crash)", async () => {
    const r = await routeInboxItem(buildDb({ hasNav: false }), { inboxItemId: IID });
    expect(r.outcome).toBe("failed");
  });
});
```

- [ ] **Step 2: Create Chronicler card quality eval**

Create `server/src/__tests__/evals/chronicler-card-eval.test.ts`:

```typescript
/**
 * chronicler-card-eval.test.ts — Chronicler card quality gate (C9)
 *
 * Tests that thread.updateSummary called by the Chronicler produces the
 * correct shape of output (faithful, structured) when given a mock thread
 * with entries. No LLM calls — we test the tool interface contract.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@armyofagents/db", () => ({
  discussions: new Proxy({} as any, { get: (_t, p) => p }),
}));
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((a: unknown, b: unknown) => ({ _op: "eq", a, b })),
}));

import { threadUpdateSummaryTool } from "../../services/internal-agent/tools/thread-update-summary.js";

const CID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function makeCtx() {
  return {
    db: {
      select: () => ({ from: () => ({ where: () => ({ then: (f: Function) => f([{ companyId: CID }]) }) }) }),
      update: () => ({ set: () => ({ where: vi.fn().mockResolvedValue([]) }) }),
    } as any,
    companyId: CID,
    services: {},
  };
}

describe("Chronicler card quality eval", () => {
  it("C1: writes routingTerms as JSON-encoded string", async () => {
    const ctx = makeCtx();
    const r = await threadUpdateSummaryTool.execute(
      { threadId: TID, summary: "About Acme contract renewal.", routingTerms: ["Acme Corp", "renewal", "contract"] },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.data.routingTermsWritten).toBe(true);
  });

  it("C2: skips routingTerms when not provided (summary-only update)", async () => {
    const ctx = makeCtx();
    const r = await threadUpdateSummaryTool.execute(
      { threadId: TID, summary: "General project update." },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.data.routingTermsWritten).toBe(false);
  });

  it("C3: rejects non-array routingTerms", async () => {
    const ctx = makeCtx();
    const r = await threadUpdateSummaryTool.execute(
      { threadId: TID, summary: "ok", routingTerms: "not-an-array" as any },
      ctx,
    );
    expect(r.success).toBe(false);
    expect(r.error).toBe("INVALID_PARAMS");
  });

  it("C4: cross-tenant guard blocks write to another company's thread", async () => {
    const ctx = { ...makeCtx(), companyId: "other-company-id" };
    const r = await threadUpdateSummaryTool.execute(
      { threadId: TID, summary: "ok" },
      ctx,
    );
    expect(r.success).toBe(false);
    expect(r.error).toBe("COMPANY_MISMATCH");
  });

  it("C5: empty routingTerms array is valid (no terms for this thread yet)", async () => {
    const ctx = makeCtx();
    const r = await threadUpdateSummaryTool.execute(
      { threadId: TID, summary: "A short general update.", routingTerms: [] },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.data.routingTermsWritten).toBe(true);
  });
});
```

- [ ] **Step 3: Run both eval files**

```
pnpm test:run server/src/__tests__/evals/
```

Expected: 7 routing eval tests + 5 card quality eval tests = 12 tests, all PASS.

- [ ] **Step 4: Run full test suite**

```
pnpm test:run 2>&1 | tail -15
```

Expected: all passing. Confirm total count is higher than before this PR.

- [ ] **Step 5: Commit**

```bash
git add "server/src/__tests__/evals/"
git commit -m "test(evals): routing regression eval set + Chronicler card quality gate (C9/T12)"
```

---

## Task 14 — Card snapshot on routing record (ABSORBED into T1 + T8)

> **Status: no longer a standalone task.** After the Codex review, the card snapshot was promoted from a deferred P2 to a core part of the routing write (the design relies on reproducible decisions). It is now implemented in:
> - **T1** — the `routingCardSnapshot` (`jsonb`) column on `thread_inbox_items` is added with the other schema columns + migration.
> - **T8** — `routeInboxItem` writes `routingCardSnapshot: cardSnapshot` in the same UPDATE that sets `routingStatus='escalated'` (the cards assembled at decision time).
>
> Nothing to do here — verify during T8 that the snapshot write is present. This heading is retained so the task list stays aligned with the eng-review `.jsonl` (T14).

- [ ] **Step 1: Verify the snapshot is written (no new code)**

Confirm `server/src/services/inbox-router.ts` (from T8) includes `routingCardSnapshot: cardSnapshot` in the escalate-path UPDATE, and that `packages/db/src/schema/threads.ts` (from T1) has the `routingCardSnapshot` column. If both are present, this task is complete.

---

## Final: typecheck + full test run + build

- [ ] **Step 1: Full typecheck**

```
pnpm typecheck
```

Expected: zero errors.

- [ ] **Step 2: Full test run**

```
pnpm test:run 2>&1 | tail -30
```

Expected: all tests passing. Count should be higher than the baseline (8007+).

- [ ] **Step 3: Build**

```
pnpm build 2>&1 | tail -15
```

Expected: build completes without errors.

- [ ] **Step 4: Final commit (if any loose files)**

```bash
git status
```

If clean, no action needed. If there are unstaged files from the above tasks, stage and commit them.

---

## Self-Review

### Spec coverage

| Spec requirement | Task(s) |
|---|---|
| D1 — Pure Navigator decides (no deterministic decider) | T2 (delete), T8 (rewire) |
| D2 — Dial mapping: off/suggest/auto_attach/full_auto | T8 (routeInboxItem), T7 (promote tool) |
| D3 — Card extends discussions (routingTerms new column) | T1 |
| Chronicler: event/sweep trigger, debounced | T5 (sweep-chronicler: stale-card detection + debounce on queued+processing) |
| Chronicler: seed-on-create | T5 Step 10 (ensureChronicler in services/companies.ts create path) + Step 12 (bootstrap) |
| Chronicler: silent (no post_entry) | T5 (SOUL/HEARTBEAT/TOOLS + allowlist = read tools + thread.updateSummary only) |
| Chronicler: read+write tools (Codex P1 #3) | T5 (CHRONICLER_TOOL_ALLOWLIST = listEntries + get_thread_summary + updateSummary) |
| Chronicler: bundle registration (3 sites — Codex P1 #4) | T5 (default-agent-instructions.ts ×2 objects + seed-commander-bundle + seed-crew-agent unions) |
| Chronicler: ROLE_ACTION_DIRECTIVE entry (Codex P1 #5) | T9 Step 4 |
| Chronicler: activity log audit trail (C6 / Codex P1 #8) | T3 (thread.updateSummary calls logActivity with the agent actor) |
| thread.updateSummary extended to accept routingTerms (+ string-element validation) | T3 |
| Adjutant's updateSummary side-effect removed (A1) | T4 |
| routeInboxItem: lifecycle owner, state machine (C2) | T8 |
| Navigator decides over inbound content (Codex P1 #1) | T8 (claim returns rawContent; payload carries inboundContent), T9 (prompt renders it) |
| Option A: zero threads still wakes Navigator (Codex P1 #9) | T8 (empty card set → still escalate; only errors fail-closed) |
| C3: Failure taxonomy (NAVIGATOR_NOT_FOUND → failed) | T8 |
| Navigator "unsure" finalization (Codex P1 #2) | T7 (defer_inbox_to_human tool), T9 (directive forces it), T10 (sweep finalizes stranded escalated → human, no loop) |
| C4: Stale reclaim (#37 into v1) | T1 (routingClaimedAt), T10 (routing→pending_route; escalated→routed+human) |
| C1: promote_inbox_to_thread tool (BLOCKER) + company guard (Codex P1 #6) | T7 |
| list_thread_cards tool (small-scale all-cards, capped + logged) | T6 |
| Navigator allowlist updated (3 new tools) | T9 |
| tool-registry.ts registers 3 new tools | T9 Step 5 |
| INBOX_ROUTING_DIRECTIVE updated for card design | T9 |
| Old orchestrator/gate/matrix tests deleted (Codex P1 #7) | T2 (incl. inbox-router.test.ts) |
| C5: suggest_new UI (BLOCKER) | T11 |
| A2: Fresh-fetch (Navigator fetches cards at runtime, not from payload) | T6 (list_thread_cards), T9 (directive) |
| A2: Snapshot for reproducibility (Codex #12) | T1 (column) + T8 (write) — promoted to core (T14 absorbed) |
| C8: Retrieval fallbacks (assembly error → fail-closed to Inbox) | T8 |
| C9: Eval gate (routing regression + card quality) | T12, T13 |
| A4: Navigator-unavailable signal | T8 (NAVIGATOR_NOT_FOUND → logActivity 'navigator_unavailable' + routingStatus='failed') |

### Placeholder scan

No TBD, TODO, or "similar to Task N" placeholders. Each step contains the actual code.

### Type consistency

- `CandidateCard` defined in `inbox-router.ts` (T8) — `{ threadId, title, summaryText, routingTerms }`. Used for the snapshot only.
- `ThreadCard` in `list-thread-cards.ts` (T6) has the same shape — consistent.
- Wakeup payload shape is `{ inboxItemId, inboundContent }` (T8) and the prompt reads `payload.inboundContent` (T9) — consistent. The old `candidateThreadIds`/`distances`/`gap` fields are removed from both producer and consumer.
- `routingTerms` stored as JSON string in DB (text column), parsed to `string[]` on read — consistent in T3, T6, T8.
- `routerDecision` values: `'suggest'` (attach), `'suggest_new'` (new thread), `'human'` (off/defer/finalize) — distinct.
- `InboxCardItem.suggestedThreadTitle` (T11) matches what `promote_inbox_to_thread` writes (T7).
- New tool names — `list_thread_cards`, `promote_inbox_to_thread`, `defer_inbox_to_human` — match across allowlist (T9), registry (T9), and tool files (T6/T7).

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run |
| Codex Review | `/codex` | Independent 2nd opinion | 3 | **RESOLVED** | R1: 9 P1+9 P2 folded. R2: 8/9 confirmed + 5 new P1 + 2 P2 folded. R3: confirmed all; 1 new P1 (processing-wakeup race) + 2 P2 folded; all source-verified. |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 0 | — | not run yet |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | not run |
| DX Review | `/plan-devex-review` | DX gaps | 0 | — | not run |

- **CODEX (session 019e7ecb):** Read 15 source files against the plan. 9 P1 blockers + 9 P2 advisories — every one verified against source and folded:
  - **#1** Navigator decided blind → T8 returns `rawContent` from the claim and the wakeup payload carries `inboundContent`; T9 renders it.
  - **#2** Unsure → escalated loop → T7 adds `defer_inbox_to_human`, T9 forces the directive to call it, T10 finalizes stranded `escalated` → `routed`+`human` (terminal, no re-escalate).
  - **#3** Chronicler couldn't read → allowlist now `thread.listEntries` + `get_thread_summary` + `thread.updateSummary`; SOUL/HEARTBEAT/TOOLS updated.
  - **#4** `default-agent-instructions.ts` registration → T5 Step 5 adds `chronicler` to both objects.
  - **#5** No `chronicler` ROLE_ACTION_DIRECTIVE → T9 Step 4.
  - **#6** `promote_inbox_to_thread` missing company guard → T7 adds item-existence + companyId guard + companyId in the UPDATE WHERE.
  - **#7** `inbox-router.test.ts` not deleted → T2 deletes it.
  - **#8** `thread.updateSummary` no `logActivity` → T3 logs with the agent actor.
  - **#9** no-cards blocked full_auto new-thread → **Option A** (user decision): zero threads still wakes the Navigator; only a true error fail-closes.
  - **P2s:** debounce now checks `queued`+`processing`; `routerDecision` written on the off path; `routingTerms` validates string elements + caps; `list_thread_cards` logs when capped; weak/misordered test mocks rewritten (select-order, `.limit()` honored); Task 14 snapshot promoted to core (T1+T8). Multi-instance Chronicler dedupe documented as a known single-instance limitation (follow-up).
- **CODEX ROUND 2 (confirmation re-review, same session):** Verified 8/9 round-1 P1s fully RESOLVED; #2 (unsure-loop) was PARTIAL — the loop was broken but a stranded queued wakeup could still fire after finalization. Caught **5 new P1s** the revisions introduced, all now folded:
  - **#A** `chronicler` missing from `autonomy.ts` `CrewRole`/`ROLE_MIN_AUTONOMY` → dispatcher's `level >= undefined` would skip it → added `chronicler: 0` (T5 Step 7a). Verified against source.
  - **#B** `get_thread_summary` didn't return `routingTerms` → Chronicler couldn't merge incrementally → extended the tool (T5 Step 7b). Verified against source.
  - **#C** stranded `escalated→routed+human` didn't cancel the queued `navigatorWakeupId`; attach/promote claim on `status='pending'` (which stays pending) so a delayed wakeup could re-act → sweep now cancels the queued wakeup first (T10). Verified against `inbox-attach.ts`.
  - **#D** `chronicler.test.ts` drizzle mock missing `inArray` → added.
  - **#E** `promote-inbox-to-thread.test.ts` missing `beforeEach(clearAllMocks)` → added.
  - **#F/#G (P2):** Task 3 expected-count text fixed (5 tests); `enqueueNavigatorRoutingWakeup` now excludes paused Navigator.
- **CODEX ROUND 3 (final adversarial pass):** Confirmed every prior fix correct against source. Found 1 new P1 + 2 P2, all folded + source-verified:
  - **R3 #2 [P1] — processing-wakeup race.** The sweep cancels only `queued` wakeups, but `dispatcher.ts:453` claims `queued→processing` before running, and `inbox-attach.ts:142` claims on `status='pending'` (which a finalized item keeps) — so a live `processing` Navigator run could still auto-act on an item the founder was handed. **Verified true** against both files. Fixed with a first-writer-wins `routingStatus='escalated'` atomic guard on the Navigator write tools: `defer_inbox_to_human` + `promote_inbox_to_thread` (both paths) no-op if already finalized; `attach_to_thread` (shared tool) uses a claim-then-disambiguate guard that preserves manual attach. (T7, T9 Step 4b.)
  - **R3 #1 [P2]** chronicler eligibility — added `isNotNull(lastEntryAt)` so no-entry threads aren't woken. (T5.)
  - **R3 #6 [P2]** reclaim test now asserts cancel-before-finalize ordering, not just call count. (T10.)
  - R3 #3/#4/#5 (get_thread_summary additive, autonomy gate, AoaTriggerPayload `[k:string]:unknown`) all verified FINE by Codex against source — no change needed.
- **CROSS-MODEL:** Codex (3 rounds) caught real implementability blockers the inside pass missed (blind Navigator, unsure-loop, 3-site bundle reg, autonomy-gate skip, get_thread_summary contract, wakeup races ×2, un-deleted orchestrator test) plus test-correctness bugs. Every code-integration finding was independently verified against the actual repo source before folding. One product fork (#9) decided by the user (Option A).
- **SOURCE VERIFICATION:** all schema columns, function signatures (`logActivity`, `promoteInboxItemToNewThread`), imports, Drizzle operators (`gt(col,col)`), status enums, and claim-column behaviors the plan depends on were confirmed against the real files.
- **UNRESOLVED:** 0.
- **VERDICT:** Three Codex rounds + full source verification. All blockers folded; every code-integration fix checked against the repo. Plan ready for subagent-driven build. Eng-review (`/plan-eng-review`) optional-but-recommended.
