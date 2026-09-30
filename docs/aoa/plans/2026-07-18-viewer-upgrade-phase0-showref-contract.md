# Viewer Upgrade — Phase 0: Versioned ShowRef Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define a versioned, backward-compatible `ShowRef` contract (a superset of the existing `CommanderOutputRef`) with validators and unit tests — **pure types + schemas, zero integration, zero runtime behavior change.** Nothing imports it into a runtime path yet; that happens in Phase 2.

**Architecture:** `ShowRef` is additive. The existing `v:1` `CommanderOutputRef` (kind `"artifact"`) is preserved untouched in `commander-output-refs.ts`. A new `v:2` shape adds the expanded kind set, a `viewerKind` hint, and a required `provenance` block. A Zod discriminated union on `v` accepts both. This phase only adds the module + tests + a package export — no emitter, no parser, no persistence, no codex mirror change.

**Tech Stack:** TypeScript (NodeNext module resolution — relative imports use `.js`), Zod, Vitest (root runner `pnpm test:run <path>`), pnpm workspaces (`@armyofagents/shared`).

**Design source:** [Build 1 (A/D/E) Design Spec §3.1](./2026-07-18-viewer-upgrade-build1-design.md). **Reviewed by Codex 2026-07-18** — this revision scopes Phase 0 to pure contract and defers all integration to Phase 2 (see "Deferred to Phase 2" below).

---

## File Structure

- **Create** `packages/shared/src/viewer-show-ref.ts` — v:2 types + Zod schemas + the combined `showRefSchema`/`showRefsSchema` union. Imports (does not modify) `commander-output-refs.js`.
- **Create** `packages/shared/src/viewer-show-ref.test.ts` — validation + back-compat unit tests.
- **Modify** `packages/shared/src/index.ts` — add one `export * from "./viewer-show-ref.js"`.

Nothing else is touched in Phase 0. `commander-output-refs.ts` stays the canonical v:1 shape; v:2 lives beside it.

---

## Task 1: v:2 ShowRef types + Zod schemas (shared)

**Files:**
- Create: `packages/shared/src/viewer-show-ref.ts`
- Test: `packages/shared/src/viewer-show-ref.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/viewer-show-ref.test.ts
import { describe, it, expect } from "vitest";
import { showRefSchema, showRefsSchema, SHOW_REF_KINDS } from "./viewer-show-ref.js";
import type { ShowRef } from "./viewer-show-ref.js";

describe("showRefSchema", () => {
  it("accepts a legacy v:1 artifact ref unchanged", () => {
    const legacy = { v: 1, kind: "artifact", id: "a1", action: "created" };
    expect(showRefSchema.safeParse(legacy).success).toBe(true);
  });

  it("accepts a v:2 ref with expanded kind + provenance", () => {
    const ref: ShowRef = {
      v: 2,
      kind: "discussion",
      id: "d1",
      title: "Q3 planning",
      viewerKind: "markdown",
      action: "referenced",
      provenance: {
        surface: "commander",
        entityId: "conv-1",
        seq: 3,
        emittedAt: "2026-07-18T10:00:00.000Z",
      },
    };
    expect(showRefSchema.safeParse(ref).success).toBe(true);
  });

  it("requires action on a v:2 ref", () => {
    const noAction = { v: 2, kind: "task", id: "t1" };
    expect(showRefSchema.safeParse(noAction).success).toBe(false);
  });

  it("exposes the full v:2 kind set", () => {
    expect([...SHOW_REF_KINDS]).toEqual([
      "artifact", "asset", "output", "task", "discussion", "approval", "memory_item", "url",
    ]);
  });

  it("rejects an unknown kind", () => {
    expect(showRefSchema.safeParse({ v: 2, kind: "nope", id: "x", action: "created" }).success).toBe(false);
  });

  it("rejects a v:2 ref whose provenance is missing required fields", () => {
    const bad = { v: 2, kind: "task", id: "t1", action: "created", provenance: { surface: "commander" } };
    expect(showRefSchema.safeParse(bad).success).toBe(false);
  });

  it("caps arrays at 20", () => {
    const one = { v: 2, kind: "artifact", id: "a", action: "created" };
    expect(showRefsSchema.safeParse(Array(21).fill(one)).success).toBe(false);
    expect(showRefsSchema.safeParse(Array(20).fill(one)).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test:run packages/shared/src/viewer-show-ref.test.ts`
Expected: FAIL — `Cannot find module './viewer-show-ref.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/shared/src/viewer-show-ref.ts
// Viewer Upgrade ShowRef — a versioned superset of CommanderOutputRef.
// v:1 (legacy, artifact-only) lives in commander-output-refs.ts and still
// validates here. v:2 adds the expanded kind set + viewerKind + provenance.
// A ref is a presentation pointer — never content, never a capability grant.
// NOTE: a structural mirror (LiftedOutputRef) in
// packages/adapters/codex-local/src/server/parse-shared.ts is widened for v:2
// in Phase 2 (with emission) — not in this phase.
import { z } from "zod";
import {
  MAX_OUTPUT_REFS_PER_MESSAGE,
  MAX_OUTPUT_REF_TITLE_LENGTH,
  commanderOutputRefSchema,
  type CommanderOutputRef,
} from "./commander-output-refs.js";

export const SHOW_REF_KINDS = [
  "artifact",
  "asset",
  "output",
  "task",
  "discussion",
  "approval",
  "memory_item",
  "url",
] as const;
export type ShowRefKind = (typeof SHOW_REF_KINDS)[number];

export const SHOW_REF_SURFACES = ["commander", "discussion", "workspace"] as const;
export type ShowRefSurface = (typeof SHOW_REF_SURFACES)[number];

export interface ShowRefProvenance {
  agentId?: string | null;
  surface: ShowRefSurface;
  entityId: string;
  runId?: string | null;
  messageId?: string | null;
  seq: number;
  emittedAt: string; // ISO-8601
}

export interface ShowRefV2 {
  v: 2;
  kind: ShowRefKind;
  id: string;
  versionId?: string | null;
  versionNumber?: number | null;
  title?: string | null;
  mimeType?: string | null;
  viewerKind?: string | null;
  action: "created" | "referenced"; // REQUIRED (avoids the mergeOutputRefs cap-drop hazard)
  toolCallId?: string | null;
  provenance?: ShowRefProvenance | null;
}

// A ShowRef is either a legacy v:1 CommanderOutputRef or a v:2 ShowRefV2.
export type ShowRef = CommanderOutputRef | ShowRefV2;

export const showRefProvenanceSchema = z.object({
  agentId: z.string().min(1).max(256).nullish(),
  surface: z.enum(SHOW_REF_SURFACES),
  entityId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256).nullish(),
  messageId: z.string().min(1).max(256).nullish(),
  seq: z.number().int().nonnegative(),
  emittedAt: z.string().datetime(),
});

export const showRefV2Schema = z.object({
  v: z.literal(2),
  kind: z.enum(SHOW_REF_KINDS),
  id: z.string().min(1).max(2048), // URLs live in id for kind:"url"
  versionId: z.string().min(1).max(256).nullish(),
  versionNumber: z.number().int().positive().nullish(),
  title: z.string().max(MAX_OUTPUT_REF_TITLE_LENGTH).nullish(),
  mimeType: z.string().min(1).max(256).nullish(),
  viewerKind: z.string().min(1).max(64).nullish(),
  action: z.enum(["created", "referenced"]),
  toolCallId: z.string().min(1).max(256).nullish(),
  provenance: showRefProvenanceSchema.nullish(),
});

// Discriminated on `v`: accepts legacy v:1 (commanderOutputRefSchema) AND v:2.
export const showRefSchema = z.discriminatedUnion("v", [
  commanderOutputRefSchema,
  showRefV2Schema,
]);

export const showRefsSchema = z.array(showRefSchema).max(MAX_OUTPUT_REFS_PER_MESSAGE);

// Compile-time guard: schema output stays assignable to the union type.
showRefSchema satisfies z.ZodType<ShowRef>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test:run packages/shared/src/viewer-show-ref.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/viewer-show-ref.ts packages/shared/src/viewer-show-ref.test.ts
git commit -m "feat(viewer): add versioned ShowRef contract (v2 superset of CommanderOutputRef)"
```

---

## Task 2: Export ShowRef from the shared package index

**Files:**
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add the re-export**

Add this line with the other `export * from "./...js"` lines in `packages/shared/src/index.ts` (match the file's existing `.js`-suffixed NodeNext export style):

```ts
export * from "./viewer-show-ref.js";
```

- [ ] **Step 2: Verify it type-checks and imports resolve**

Run: `pnpm --filter @armyofagents/shared typecheck`
Expected: PASS. (No symbol collision: `viewer-show-ref.ts` imports the commander names but does not re-export them.)

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "chore(viewer): export ShowRef contract from @armyofagents/shared"
```

---

## Task 3: Workspace typecheck + no-behavior-change gate

**Files:** none (verification task)

- [ ] **Step 1: Typecheck everything that consumes shared**

Run: `pnpm -r typecheck`
Expected: PASS. Adding an unused export cannot break consumers.

- [ ] **Step 2: Run the shared suite**

Run: `pnpm test:run packages/shared/src/viewer-show-ref.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 3: Prove nothing wired ShowRef into a runtime path (no behavior change)**

Run: `git grep -n "viewer-show-ref\|showRefSchema\|ShowRefV2" -- packages/ server/ ui/ | grep -v "packages/shared/src/viewer-show-ref"`
Expected: **no matches.** Only the new module + its own test reference the contract. If any runtime file imports it, that is Phase 2 work — revert it out of Phase 0.

- [ ] **Step 4: Commit (only if an incidental fix was needed)**

```bash
git add -A
git commit -m "test(viewer): phase-0 ShowRef contract gate green"
```

---

## Deferred to Phase 2 (Commander onto the contract) — carried forward from the Codex review

These were incorrectly placed in the first Phase-0 draft. They land in Phase 2, together with actual v:2 emission, so the whole round-trip changes in one coherent slice:

1. **Codex-local mirror** (`parse-shared.ts` `LiftedOutputRef` + `liftOutputRefs`): widen to accept v:2 **including `provenance`** (the mirror must not silently drop it); keep the v:1 branch byte-for-byte unchanged (256-cap, no `viewerKind`); add a lift test asserting **deep equality** on a v:2 ref (incl. provenance) and unchanged v:1 behavior. Parity test path: `packages/adapters/codex-local/src/server/__tests__/appserver-parse-events.test.ts`. Package filter: `@armyofagents/adapter-codex-local`.
2. **Claude lift gate** (`parse-stream-json.ts`): migrate `commanderOutputRefsSchema` → `showRefsSchema`.
3. **Emission** (`buildOutputRefs`, `output-refs.ts`): emit v:2 with provenance for the relevant tools.
4. **Upstream type widening**: `mergeOutputRefs` signature, `AgentStreamChunk.refs`, `collectChunkRefs` widen `CommanderOutputRef[]` → `ShowRef[]`; and `mergeOutputRefs` dedup/cap must be provenance-aware and must not drop refs (action is now required, removing the actionless-drop hazard).
5. **Persistence** (`conversation.ts:80-86`): migrate the per-ref `commanderOutputRefSchema.safeParse` → `showRefSchema.safeParse`; extend the **real** boundary test `server/src/services/internal-agent/__tests__/conversation-output-refs.test.ts` (do not test a helper redefined inside the test file).

---

## Self-Review

**Spec coverage (design §3.1):** versioned superset with v:1 preserved (Task 1); `versionId`/`versionNumber`/`title`/`mimeType` preserved + `provenance` added + `viewerKind` present + `reply` excluded (Task 1); backward-compatible discriminated-union loader (Task 1); exported for consumers (Task 2); proven inert (Task 3). Integration (mirror/gate/emit/persist/type-widening) is explicitly Phase 2. ✅

**Placeholder scan:** none — every code step is complete.

**Type consistency:** `showRefSchema`/`showRefsSchema`/`SHOW_REF_KINDS`/`ShowRef`/`ShowRefV2`/`ShowRefProvenance`/`SHOW_REF_SURFACES` used identically across tasks. `action` is required on v2 in both the type and schema.

**Command correctness (per Codex):** root runner `pnpm test:run <path>`; `pnpm -r typecheck`; NodeNext `.js` on all relative imports/exports. No `@armyofagents/codex-local` filter appears (that package is `@armyofagents/adapter-codex-local` and is untouched in Phase 0).

---

## Execution Handoff

Plan complete. Execution: **subagent-driven** — a fresh subagent per task with two-stage review between tasks. Phase 0 is 3 small TDD tasks with zero integration, an ideal first slice to validate the execute→review loop before Phase 1 (URL security slice) and Phase 3 (delivery channels).
