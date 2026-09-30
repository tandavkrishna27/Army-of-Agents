# Fake-Crew CI Harness (Path B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the W1 scope→dispatch pipeline (`propose_crew_work` → `create_scope_draft` action → outbox seal → commit → autonomy gate → `crew_dispatch` Inbox approval → approve → `planning→standard` flip) CI-testable end-to-end without any real CLI, by teaching the existing fake-crew harness a controller-mode Adjutant turn. (The dispatched crew RUN that follows the flip is out of scope — the fake can't execute a task; that leg stays with the gated real-crew soak spec.)

**Architecture:** The fake-crew harness (`fake-crew-llm.ts`) already intercepts crew adapter execution in CI (`AOA_E2E_FAKE_CREW_LLM=1`, wired in `playwright.config.ts`), but its Adjutant branch calls the *legacy* `crewTaskService.proposeWork` directly — bypassing the entire action-gated pipeline W1 shipped. We add an **additive** controller-mode branch that queues a real `create_scope_draft` thread action (exactly what the real `propose_crew_work` tool does in controller mode), selected via a **control file** (`AOA_E2E_FAKE_CREW_CONTROL`, mirroring the fake-claude/fake-codex control-file pattern) so the three existing CI specs that depend on legacy fake behavior are untouched. The fake calls the SAME primitives the real tool does — `threadAgentActionService.proposeThreadAction` + the already-shared `buildScopeDraftIdempotencyKey` (`thread-action-keys.ts`) — with NO extraction of production tool code (eng-review D5: the only drift-prone contract is the key, and it is already a shared function; a parity unit test enforces byte-identical keys, so refactoring the Codex-hardened tool to serve a test is blast-radius pointing the wrong way). A new CI Playwright spec then drives the full Assist round-trip: mention → fake scope action → seal → commit → planning tasks + `crew_dispatch` approval → approve → `planning→standard` flip; plus a Drive variant (no approval, task standard directly).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Vitest (sequence-mock style for services, injectable-deps style for the fake), Playwright e2e (workers:1, control files in `os.tmpdir()`), Drizzle (no schema changes in this plan).

**Explicitly OUT of scope:** D17 ("Ask Adjutant to scope" button) — separate follow-on. The fake-extraction seam (`extractViaCli`) — not needed because `proposedTasks` skips extraction (Codex #270 round-3 behavior). The real-crew spec `team-aoa-crew-dispatch-approval.spec.ts` **stays** gated behind `AOA_E2E_REAL_CREW_FLOW=1` as the live-fidelity soak; this plan adds a CI sibling, it does not un-gate the real one.

**The pipeline under test (eng-review diagram):**

```
spec writes control file            ┌────────────────────────────────────────────┐
{adjutant: controller_scope, tasks} │ PRODUCTION CODE (unchanged by this plan)   │
        │                           └────────────────────────────────────────────┘
        ▼
"@Adjutant scope this" ──► mention wakeup ──► dispatcher gates ──► runAoaAgent
                            (adjutant role     (pause/autonomy/       │
                             min autonomy 0)    rate/budget)          ▼
                                                          maybeExecuteFakeCrewTurn
                                                                      │
                                            control+gated+runId?  ────┤
                                                yes │                 │ no → legacy fake
                                                    ▼                 ▼   (3 old CI specs)
                                       queueScopeDraftAction    proposeWork / reply
                                       (SHARED with real tool)
                                                    │ + best-effort confirmation entry (1A)
                                                    ▼
                              thread_agent_actions row (proposed)
                                                    │  run succeeds
                                                    ▼
                              SEAL (runner.ts:597) proposed → ready
                                                    ▼
                              COMMIT (runner direct / orchestration)
                              = W1a role resolution → W2 compile
                                                    │
                                     Assist(1) ─────┼───── Drive(2)
                                         ▼                    ▼
                              tasks planning +        tasks standard +
                              ONE crew_dispatch       auto-dispatch
                              approval (Inbox)        (budget preflight)
                                         │
                              POST /approvals/:id/approve
                                         ▼
                              planning → standard + dispatchCreatedCrewTasks
```

---

## Context for an engineer with zero AoA background

- **Crew agents** (`agents.kind='aoa'`) execute via `runAoaAgent` (`server/src/services/internal-agent/aoa-agents/runner.ts`), NOT the org-agent heartbeat. At `runner.ts:499-514` the adapter call is short-circuited: `maybeExecuteFakeCrewTurn(...) ?? adapter.execute(...)`.
- **Action gate (Decision #99):** in a discussion-triggered run (`payload.source` ∈ `thread.controller | thread.participation | mention | agent.dispatch`, computed at `runner.ts:261-268` as `discussionRunMode = "controller_action_gate"`), crew tools do NOT write side effects directly. They queue rows in `thread_agent_actions` via `proposeThreadAction` (status `proposed`). On run success the runner SEALS the run's rows (`proposed→ready`, `runner.ts:597-629`) and — for non-controller sources like `mention` — COMMITS them (`runner.ts:636-648` → `commitThreadAgentActions`). The commit is where W1/W2 live: role→agent resolution, extract-then-scope, draft compile, autonomy gate, `crew_dispatch` approval.
- **Autonomy:** Manual(0) = draft only; Assist(1) = tasks auto-created as `workMode='planning'` + ONE pending `crew_dispatch` approval (payload `{taskIds}`); Drive(2) = `standard` + auto-dispatch. Thread `autonomyLevel` overrides company config.
- **The gap this plan closes:** `fake-crew-llm.ts:175-193` (Adjutant + `wantsScope` regex) calls legacy `proposeWork` → a `scope_proposal` entry card — the pre-W1 pipeline. Three CI specs depend on that legacy behavior (`full-discussion-to-workspace-cycle.spec.ts` asserts the `scope-proposal-card` testid; `onboarding-thread-pipeline.spec.ts`; `mention-autocomplete.spec.ts` relies on plain fake replies). So the new behavior must be opt-in per test, not a replacement.
- **Control-file pattern to copy:** `tests/e2e/helpers/fake-claude.ts:19-22` — a deterministic `os.tmpdir()` path shared by the playwright config (exports it to the webServer env) and the specs (rewrite the file before acting). `workers: 1` + `reuseExistingServer: false` make one global control file race-free.
- **Run this plan's server tests:** `pnpm --filter @armyofagents/server exec vitest run <files>`. Typecheck: `pnpm --filter @armyofagents/server exec tsc --noEmit`. E2E locally on Windows: `AOA_E2E_FORCE_WINDOWS=1 pnpm exec playwright test <spec> --config tests/e2e/playwright.config.ts` from the repo root.
- **Branch:** create `feat/fake-crew-harness` off latest `origin/main`. Commit style: `type(scope): subject` + `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

### Task 1: `buildFakeScopeDraftInput` — the fake's key/payload parity with the real tool (no production refactor, D5)

**Eng-review D5:** the fake does NOT extract or touch `propose-crew-work.ts`. The only contract that must be byte-identical between fake and real is the idempotency key, and its recipe (`buildScopeDraftIdempotencyKey`) is ALREADY a shared function. So the fake computes its `proposeThreadAction` input the same way the tool does — including the `latestHumanSeq → String` turn-anchor derivation — and a **parity unit test** pins that the fake's derived key equals the tool's for the same inputs. Production tool code stays untouched (blast radius stays inside the test harness); the parity test is the guard, not a shared-helper refactor.

This task builds a tiny pure input-builder in the fake module (so the fake branch in Task 3 stays readable and the parity test can target it in isolation). It does NOT call the DB.

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/fake-crew-llm.ts` (add the pure builder + its type)
- Modify: `server/src/__tests__/fake-crew-llm.test.ts` (parity test)

- [ ] **Step 1: Write the failing parity test**

Append to `server/src/__tests__/fake-crew-llm.test.ts` (add `buildFakeScopeDraftInput` to the import from the fake module, and import `buildScopeDraftIdempotencyKey` from `../services/internal-agent/tools/thread-action-keys.js`):

```ts
describe("buildFakeScopeDraftInput — key/payload parity with propose_crew_work", () => {
  it("derives the BYTE-IDENTICAL turn-anchored key the real tool would", () => {
    const input = buildFakeScopeDraftInput({
      companyId: "co-1",
      threadId: "thr-1",
      runId: "run-1",
      agentId: "agent-adj",
      summary: "Auth scope",
      proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
      threadFreshness: { latestHumanSeq: 7 },
    });

    expect(input).toMatchObject({
      companyId: "co-1",
      threadId: "thr-1",
      runId: "run-1",
      agentId: "agent-adj",
      actionType: "create_scope_draft",
      payload: {
        summary: "Auth scope",
        proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
      },
      freshness: { latestHumanSeq: 7 },
    });
    // The tool derives its key from the RAW proposedTasks + turnAnchor (propose-crew-work.ts:132-141).
    // The fake MUST match byte-for-byte, or the same-turn re-proposal dedupe silently breaks.
    expect(input.idempotencyKey).toBe(
      buildScopeDraftIdempotencyKey({
        threadId: "thr-1",
        agentId: "agent-adj",
        summary: "Auth scope",
        proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
        turnAnchor: "7",
      }),
    );
  });

  it("null freshness → noanchor key + empty freshness (snapshot_unavailable contract)", () => {
    const input = buildFakeScopeDraftInput({
      companyId: "co-1",
      threadId: "thr-1",
      runId: "run-1",
      agentId: null,
      summary: "S",
      proposedTasks: [{ title: "T" }],
      threadFreshness: null,
    });
    expect(input.freshness).toEqual({});
    expect(input.idempotencyKey).toBe(
      buildScopeDraftIdempotencyKey({
        threadId: "thr-1",
        agentId: null,
        summary: "S",
        proposedTasks: [{ title: "T" }],
        turnAnchor: null,
      }),
    );
  });

  it("eng-review-fix-4: passes RAW proposedTasks to the key builder (empty assigneeRole ≠ dropped)", () => {
    // The tool feeds the raw tasks to buildScopeDraftIdempotencyKey (propose-crew-work.ts:136);
    // an assigneeRole:"" must produce the tool's key, NOT a mapped-to-null variant. Regression
    // pin for the challenger's finding 4.
    const raw = [{ title: "T", assigneeRole: "" }];
    const input = buildFakeScopeDraftInput({
      companyId: "co-1", threadId: "thr-1", runId: "run-1", agentId: "a",
      summary: "S", proposedTasks: raw, threadFreshness: { latestHumanSeq: 2 },
    });
    expect(input.idempotencyKey).toBe(
      buildScopeDraftIdempotencyKey({ threadId: "thr-1", agentId: "a", summary: "S", proposedTasks: raw, turnAnchor: "2" }),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/fake-crew-llm.test.ts`
Expected: FAIL — `buildFakeScopeDraftInput` is not exported.

- [ ] **Step 3: Add the pure builder to `fake-crew-llm.ts`**

```ts
import { buildScopeDraftIdempotencyKey } from "../tools/thread-action-keys.js";

export interface FakeScopeDraftContext {
  companyId: string;
  threadId: string;
  runId: string;
  agentId: string | null;
  summary: string;
  proposedTasks: Array<{ title: string; assigneeRole?: string }>;
  threadFreshness: Record<string, unknown> | null;
}

/**
 * Build the EXACT `proposeThreadAction` input the real propose_crew_work tool
 * produces in controller mode (propose-crew-work.ts:118-144). The fake calls
 * proposeThreadAction with this — no production tool refactor (eng-review D5).
 *
 * Parity contract: the idempotency KEY must be byte-identical to the tool's, so
 * BOTH derive it from the RAW proposedTasks (NOT a mapped copy — mapping would
 * turn assigneeRole:"" into null and change the key; challenger finding 4) and
 * the same turnAnchor (latestHumanSeq → String, or null). The parity unit test
 * pins this; drift is caught there, not by a shared helper.
 */
export function buildFakeScopeDraftInput(ctx: FakeScopeDraftContext): {
  companyId: string; threadId: string; runId: string; agentId: string | null;
  actionType: "create_scope_draft"; payload: Record<string, unknown>;
  idempotencyKey: string; freshness: Record<string, unknown>;
} {
  const latestHumanSeq = (ctx.threadFreshness as { latestHumanSeq?: number } | null)?.latestHumanSeq;
  return {
    companyId: ctx.companyId,
    threadId: ctx.threadId,
    runId: ctx.runId,
    agentId: ctx.agentId,
    actionType: "create_scope_draft",
    payload: {
      summary: ctx.summary,
      proposedTasks: ctx.proposedTasks.map((task) => ({
        title: task.title,
        ...(task.assigneeRole ? { assigneeRole: task.assigneeRole } : {}),
      })),
    },
    // RAW tasks to the key builder — mirrors propose-crew-work.ts:136 exactly.
    idempotencyKey: buildScopeDraftIdempotencyKey({
      threadId: ctx.threadId,
      agentId: ctx.agentId,
      summary: ctx.summary,
      proposedTasks: ctx.proposedTasks,
      turnAnchor: latestHumanSeq != null ? String(latestHumanSeq) : null,
    }),
    freshness: ctx.threadFreshness ?? {},
  };
}
```

Verify the relative import path `../tools/thread-action-keys.js` against a sibling in `aoa-agents/` that imports from `tools/` (e.g. `ensure-command-staff.ts`), and match its specifier.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/fake-crew-llm.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/fake-crew-llm.ts server/src/__tests__/fake-crew-llm.test.ts
git commit -m "feat(e2e): buildFakeScopeDraftInput — fake mirrors propose_crew_work's key/payload (no prod refactor)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> **Note (challenger finding 3):** because this task does NOT modify `propose-crew-work.ts`, the production tool's gated branch and its existing pin `server/src/__tests__/thread-action-gated-tools.test.ts` are untouched. That test is still added to Task 7's sweep as a guard that nothing downstream disturbed the branch.

---

### Task 2: Control file — spec-side helper + server-side reader

Mirrors the fake-claude control-file contract: a deterministic `os.tmpdir()` path, exported to the webServer env by the playwright config, rewritten by specs, read fresh by the server on every fake turn. Absent/invalid file ⇒ legacy behavior (the three existing CI specs never notice).

**Files:**
- Create: `tests/e2e/helpers/fake-crew-control.ts`
- Modify: `server/src/services/internal-agent/aoa-agents/fake-crew-llm.ts` (reader + types only in this task)
- Modify: `server/src/__tests__/fake-crew-llm.test.ts` (reader tests)
- Modify: `tests/e2e/playwright.config.ts` (env wiring)

- [ ] **Step 1: Write the failing reader tests**

Append to `server/src/__tests__/fake-crew-llm.test.ts` (imports at top of file gain `readFakeCrewControl` from the same module, plus `mkdtempSync, writeFileSync` from `node:fs` and `tmpdir` from `node:os` and `join` from `node:path`):

```ts
describe("readFakeCrewControl", () => {
  it("returns null when the env var is unset (legacy behavior)", () => {
    expect(readFakeCrewControl({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("returns null for a missing file or malformed JSON (never throws)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aoa-fake-crew-ctl-"));
    expect(
      readFakeCrewControl({ AOA_E2E_FAKE_CREW_CONTROL: join(dir, "missing.json") } as NodeJS.ProcessEnv),
    ).toBeNull();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(readFakeCrewControl({ AOA_E2E_FAKE_CREW_CONTROL: bad } as NodeJS.ProcessEnv)).toBeNull();
  });

  it("parses a controller_scope control", () => {
    const dir = mkdtempSync(join(tmpdir(), "aoa-fake-crew-ctl-"));
    const file = join(dir, "control.json");
    writeFileSync(
      file,
      JSON.stringify({
        adjutant: {
          mode: "controller_scope",
          summary: "Token endpoint scope",
          proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
        },
      }),
    );
    expect(readFakeCrewControl({ AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv)).toEqual({
      adjutant: {
        mode: "controller_scope",
        summary: "Token endpoint scope",
        proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
      },
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/fake-crew-llm.test.ts`
Expected: FAIL — `readFakeCrewControl` is not exported.

- [ ] **Step 3: Implement the reader in `fake-crew-llm.ts`**

Add near the top of `server/src/services/internal-agent/aoa-agents/fake-crew-llm.ts` (after the existing interfaces):

```ts
export interface FakeCrewAdjutantControl {
  mode?: string;
  summary?: string;
  proposedTasks?: Array<{ title: string; assigneeRole?: string }>;
}

export interface FakeCrewControl {
  adjutant?: FakeCrewAdjutantControl;
}

/**
 * Per-test scripting for the fake harness, mirroring the fake-claude control-file
 * contract (tests/e2e/helpers/fake-claude.ts): AOA_E2E_FAKE_CREW_CONTROL points at
 * a JSON file rewritten by specs before they trigger a crew turn; we read it FRESH
 * on every turn. Absent env var, missing file, or malformed JSON all mean "no
 * control" → the legacy fake branches run unchanged, so the pre-existing CI specs
 * (full-discussion-to-workspace-cycle, onboarding-thread-pipeline,
 * mention-autocomplete) are structurally unaffected.
 */
export function readFakeCrewControl(env: NodeJS.ProcessEnv = process.env): FakeCrewControl | null {
  const controlPath = env.AOA_E2E_FAKE_CREW_CONTROL;
  if (!controlPath) return null;
  try {
    const parsed = JSON.parse(readFileSync(controlPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as FakeCrewControl;
  } catch {
    return null;
  }
}
```

Add the module import at the top of `fake-crew-llm.ts` (it is pure ESM):

```ts
import { readFileSync } from "node:fs";
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/fake-crew-llm.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Create the spec-side helper**

Create `tests/e2e/helpers/fake-crew-control.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Shared contract between the playwright config (exports this path to the
 * webServer env as AOA_E2E_FAKE_CREW_CONTROL) and specs (rewrite before
 * triggering a crew turn). The server-side fake harness
 * (server/src/services/internal-agent/aoa-agents/fake-crew-llm.ts
 * readFakeCrewControl) reads it fresh on every fake turn. workers:1 +
 * reuseExistingServer:false make the single global file race-free.
 * Mirrors tests/e2e/helpers/fake-claude.ts.
 */
export const FAKE_CREW_CONTROL_PATH = path.join(
  os.tmpdir(),
  "aoa-e2e-fake-crew-control.json",
);

export interface FakeCrewControlFile {
  adjutant?: {
    mode?: "controller_scope";
    summary?: string;
    proposedTasks?: Array<{ title: string; assigneeRole?: string }>;
  };
}

/** Write (overwrite) the control file. */
export function writeFakeCrewControl(control: FakeCrewControlFile): void {
  fs.writeFileSync(FAKE_CREW_CONTROL_PATH, JSON.stringify(control), "utf8");
}

/** Remove the control file → the harness reverts to legacy behavior. */
export function resetFakeCrewControl(): void {
  try {
    fs.unlinkSync(FAKE_CREW_CONTROL_PATH);
  } catch {
    /* already absent */
  }
}
```

- [ ] **Step 6: Wire the env var in `tests/e2e/playwright.config.ts`**

Add the import next to the fake-claude/fake-codex imports (config lines 6-7):

```ts
import { FAKE_CREW_CONTROL_PATH } from "./helpers/fake-crew-control";
```

Add to the `webServer.env` block, directly under `AOA_E2E_FAKE_CREW_LLM: "1"`:

```ts
          AOA_E2E_FAKE_CREW_CONTROL: FAKE_CREW_CONTROL_PATH,
```

**Eng-review fix 2 (challenger finding 2): the startup cleanup is UNCONDITIONAL, not precedent-gated.** A leftover `aoa-e2e-fake-crew-control.json` in `os.tmpdir()` (from a SIGKILL/Ctrl-C'd prior run — `afterEach` does not run on signal death, and tmpdir persists across local runs) would silently rewire the Adjutant for specs that never touch the control file: `full-discussion-to-workspace-cycle.spec.ts:112` waits 75s for a `scope-proposal-card` the controller-mode branch never produces → a mystifying legacy-spec failure. Unlike fake-claude (whose control file only affects specs that script it), this control file changes the DEFAULT Adjutant behavior, so a stale file is actively dangerous. In `playwright.config.ts`, before the server launches (top of the config module, next to the other pre-launch fs work — verify the exact location, e.g. where `FAKE_CLAUDE_CONTROL_PATH` files are cleared if such a block exists; otherwise add a fresh `try { fs.unlinkSync(FAKE_CREW_CONTROL_PATH); } catch {}`), delete the file unconditionally:

```ts
try { fs.unlinkSync(FAKE_CREW_CONTROL_PATH); } catch { /* absent — fine */ }
```

This runs once at config load (before any worker), so no spec ever inherits a stale control file even if the previous run died mid-test.

- [ ] **Step 7: Typecheck + commit**

Run: `pnpm --filter @armyofagents/server exec tsc --noEmit` → 0 errors.

```bash
git add server/src/services/internal-agent/aoa-agents/fake-crew-llm.ts server/src/__tests__/fake-crew-llm.test.ts tests/e2e/helpers/fake-crew-control.ts tests/e2e/playwright.config.ts
git commit -m "feat(e2e): fake-crew control file (AOA_E2E_FAKE_CREW_CONTROL) — per-test scripting seam

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: The controller-mode Adjutant branch in `fake-crew-llm.ts`

The heart of the harness. Keyed on THREE conditions so it can never hijack the legacy specs: control file says `controller_scope` AND the run is action-gated AND a runId exists. Calls `proposeThreadAction` directly with `buildFakeScopeDraftInput` (Task 1 — no production refactor), then posts a visible Adjutant entry (the e2e's wait target). Placed BEFORE the legacy `wantsScope` branch.

**Concurrency note (challenger finding 5):** at Assist the mention entry drives BOTH a participation run and the proactive inline controller drain (`thread-events.ts:268-279`), so two Adjutant runs can hit this branch for one message. Both queue the SAME action — harmless because identical control-file input + identical `latestHumanSeq` → identical idempotency key → `onConflictDoNothing` collapses them (and the round-10 no-op revive handles a same-key retry). A future spec that rewrites the control file mid-thread WITHOUT a new human entry would mint two DISTINCT keys and the second draft would block behind `existing_draft`; the control-file helper doc and this branch's comment call that out so nobody trips it.

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/fake-crew-llm.ts`
- Modify: `server/src/__tests__/fake-crew-llm.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Append to `server/src/__tests__/fake-crew-llm.test.ts`:

```ts
describe("controller-mode Adjutant branch (fake-crew harness Path B)", () => {
  function controlFileWith(adjutant: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "aoa-fake-crew-ctl-"));
    const file = join(dir, "control.json");
    writeFileSync(file, JSON.stringify({ adjutant }));
    return file;
  }

  const gatedArgsBase = {
    db,
    agent: { id: "agent-adj", name: "Adjutant" },
    payload: {
      companyId: "co-1",
      source: "mention",
      threadId: "thr-1",
      effectiveAutonomy: 1,
    },
    runId: "run-1",
    discussionRunMode: "controller_action_gate" as const,
    threadFreshness: { latestHumanSeq: 3 },
  };

  it("queues create_scope_draft via proposeThreadAction + posts a visible confirmation entry", async () => {
    const proposeThreadAction = vi.fn(async () => ({ id: "action-1" }));
    const addEntry = vi.fn();
    const proposeWork = vi.fn();
    const loadLatestHumanEntry = vi.fn(async () => ({
      id: "e-1",
      rawContent: "please scope this into tracked tasks",
      seq: 3,
    }));
    const file = controlFileWith({
      mode: "controller_scope",
      summary: "Token endpoint scope",
      proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
    });

    const result = await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      env: { AOA_E2E_FAKE_CREW_LLM: "1", AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, addEntry, proposeWork, loadLatestHumanEntry },
    });

    expect(result).toMatchObject({ exitCode: 0, resultJson: { fakeCrewLlm: true, action: "queue_scope_draft" } });
    expect(proposeThreadAction).toHaveBeenCalledTimes(1);
    // The fake calls proposeThreadAction with buildFakeScopeDraftInput's output —
    // the SAME shape the real tool produces (parity pinned in Task 1's tests).
    const arg = proposeThreadAction.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      companyId: "co-1",
      threadId: "thr-1",
      runId: "run-1",
      agentId: "agent-adj",
      actionType: "create_scope_draft",
      payload: {
        summary: "Token endpoint scope",
        proposedTasks: [{ title: "Build token endpoint", assigneeRole: "engineer" }],
      },
      freshness: { latestHumanSeq: 3 },
    });
    expect(typeof arg.idempotencyKey).toBe("string");
    // The LEGACY path must not fire.
    expect(proposeWork).not.toHaveBeenCalled();
    // Visible confirmation entry for waitForVisibleAgentEntry in the e2e.
    expect(addEntry).toHaveBeenCalledTimes(1);
    const entry = addEntry.mock.calls[0][2] as { rawContent: string; authorAgentId: string };
    expect(entry.authorAgentId).toBe("agent-adj");
    expect(entry.rawContent).toMatch(/queued a scope draft/i);
  });

  it("falls back to LEGACY proposeWork when the run is NOT action-gated, even with control set", async () => {
    const proposeThreadAction = vi.fn();
    const proposeWork = vi.fn();
    const loadLatestHumanEntry = vi.fn(async () => ({
      id: "e-1",
      rawContent: "please scope this into tracked tasks",
      seq: 3,
    }));
    const file = controlFileWith({ mode: "controller_scope" });

    await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      discussionRunMode: null,
      runId: null,
      env: { AOA_E2E_FAKE_CREW_LLM: "1", AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, proposeWork, loadLatestHumanEntry, addEntry: vi.fn() },
    });

    expect(proposeThreadAction).not.toHaveBeenCalled();
    expect(proposeWork).toHaveBeenCalledTimes(1); // legacy branch (wantsScope matches)
  });

  it("no control file → legacy behavior byte-for-byte (regression pin for existing CI specs)", async () => {
    const proposeThreadAction = vi.fn();
    const proposeWork = vi.fn();
    const loadLatestHumanEntry = vi.fn(async () => ({
      id: "e-1",
      rawContent: "please scope this into tracked tasks",
      seq: 3,
    }));

    await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      env: { AOA_E2E_FAKE_CREW_LLM: "1" } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, proposeWork, loadLatestHumanEntry, addEntry: vi.fn() },
    });

    expect(proposeThreadAction).not.toHaveBeenCalled();
    expect(proposeWork).toHaveBeenCalledTimes(1);
  });

  it("eng-review: gated + control but runId MISSING → legacy fallback (never half-queues)", async () => {
    const proposeThreadAction = vi.fn();
    const proposeWork = vi.fn();
    const loadLatestHumanEntry = vi.fn(async () => ({
      id: "e-1",
      rawContent: "please scope this into tracked tasks",
      seq: 3,
    }));
    const file = controlFileWith({ mode: "controller_scope" });

    await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      runId: null, // gated run whose run-row insert failed
      env: { AOA_E2E_FAKE_CREW_LLM: "1", AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, proposeWork, loadLatestHumanEntry, addEntry: vi.fn() },
    });

    expect(proposeThreadAction).not.toHaveBeenCalled();
    expect(proposeWork).toHaveBeenCalledTimes(1);
  });

  it("eng-review: control omits proposedTasks → shared defaults are queued", async () => {
    const proposeThreadAction = vi.fn(async () => ({ id: "action-1" }));
    const loadLatestHumanEntry = vi.fn(async () => ({
      id: "e-1",
      rawContent: "scope it",
      seq: 3,
    }));
    const file = controlFileWith({ mode: "controller_scope", summary: "S" });

    await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      env: { AOA_E2E_FAKE_CREW_LLM: "1", AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, loadLatestHumanEntry, addEntry: vi.fn() },
    });

    const arg = proposeThreadAction.mock.calls[0][0] as { payload: { proposedTasks: Array<{ title: string }> } };
    expect(arg.payload.proposedTasks).toEqual([
      { title: "Clarify the accepted scope handoff", assigneeRole: "planner" },
      { title: "Implement the scoped thread cycle", assigneeRole: "engineer" },
    ]);
  });

  it("eng-review 1A: a FAILING confirmation entry does not sink the queued action (best-effort)", async () => {
    const proposeThreadAction = vi.fn(async () => ({ id: "action-1" }));
    const addEntry = vi.fn(async () => {
      throw new Error("db blip");
    });
    const loadLatestHumanEntry = vi.fn(async () => ({
      id: "e-1",
      rawContent: "scope it",
      seq: 3,
    }));
    const file = controlFileWith({ mode: "controller_scope" });

    const result = await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      env: { AOA_E2E_FAKE_CREW_LLM: "1", AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, addEntry, loadLatestHumanEntry },
    });

    // The action queued, the run result still reports success — the decoration
    // failure is logged, not propagated (a failed run would never seal the action).
    expect(proposeThreadAction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ exitCode: 0, resultJson: { action: "queue_scope_draft" } });
  });

  it("non-Adjutant agents ignore controller_scope control (plain fake reply)", async () => {
    const proposeThreadAction = vi.fn();
    const addEntry = vi.fn();
    const file = controlFileWith({ mode: "controller_scope" });

    await maybeExecuteFakeCrewTurn({
      ...gatedArgsBase,
      agent: { id: "agent-scout", name: "Scout" },
      env: { AOA_E2E_FAKE_CREW_LLM: "1", AOA_E2E_FAKE_CREW_CONTROL: file } as NodeJS.ProcessEnv,
      deps: { proposeThreadAction, addEntry, loadLatestHumanEntry: vi.fn(async () => null) },
    });

    expect(proposeThreadAction).not.toHaveBeenCalled();
    expect(addEntry).toHaveBeenCalledTimes(1); // Scout's normal fake reply
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/fake-crew-llm.test.ts`
Expected: FAIL — unknown args (`runId`, `discussionRunMode`, `threadFreshness`) / `proposeThreadAction` dep not used / no `queue_scope_draft` action.

- [ ] **Step 3: Implement the branch**

In `server/src/services/internal-agent/aoa-agents/fake-crew-llm.ts`:

(a) Widen `FakeCrewDeps` with the new injectable — the fake calls `proposeThreadAction` DIRECTLY (D5: no production-tool refactor). The default binding imports `threadAgentActionService` at call time:

```ts
  /** D5: the fake calls the SAME primitive the real tool does. Default binding
   *  below imports threadAgentActionService; tests inject a spy. */
  proposeThreadAction?: (input: ReturnType<typeof buildFakeScopeDraftInput>) => Promise<unknown>;
```

(b) Widen `maybeExecuteFakeCrewTurn`'s args:

```ts
export async function maybeExecuteFakeCrewTurn(args: {
  db: Db;
  agent: FakeCrewAgent;
  payload: FakeCrewPayload;
  /** From runner.ts:148-158 — required for the controller-mode branch (the queued
   *  action's key self-appends to internal_agent_runs.proposedActionKeys so the
   *  runner's seal/commit machinery works with zero extra bookkeeping). */
  runId?: string | null;
  /** From runner.ts:267-268 — the controller-mode branch only fires on action-gated runs. */
  discussionRunMode?: "controller_action_gate" | null;
  /** From runner.ts:269-284 — snapshot at run start; threads through to freshness + turn anchor. */
  threadFreshness?: Record<string, unknown> | null;
  env?: NodeJS.ProcessEnv;
  deps?: FakeCrewDeps;
}): Promise<AdapterExecutionResult | null> {
```

(c) Insert the new branch AFTER the `latest` load and BEFORE the legacy `wantsScope` branch (currently line 175):

```ts
  // ── Controller-mode Adjutant (fake-crew harness Path B) ──────────────────────
  // Replays EXACTLY what the real propose_crew_work tool does in controller mode:
  // queue a create_scope_draft thread action (Decision #99 outbox) that the
  // runner's post-turn seal + commit then drives through the FULL W1/W2 pipeline
  // (role resolution → compile → autonomy gate → crew_dispatch approval). Opt-in
  // per test via the control file so the legacy branches below keep serving the
  // pre-existing CI specs untouched. All three keys are required:
  //   control mode  — the spec explicitly asked for the gated path
  //   action-gated  — mirrors the real tool's ctx.discussionRunMode check
  //   runId present — proposeThreadAction needs it for the seal key-set
  const control = readFakeCrewControl(args.env);
  const adjutantControl = control?.adjutant;
  if (
    agent.name === "Adjutant" &&
    adjutantControl?.mode === "controller_scope" &&
    args.discussionRunMode === "controller_action_gate" &&
    typeof args.runId === "string" &&
    args.runId
  ) {
    const summary =
      adjutantControl.summary ??
      `E2E fake controller scope: ${latest?.rawContent.slice(0, 160) ?? "thread"}`;
    const proposedTasks =
      adjutantControl.proposedTasks && adjutantControl.proposedTasks.length > 0
        ? adjutantControl.proposedTasks
        : FAKE_DEFAULT_PROPOSED_TASKS;

    // D5: build the EXACT input the real tool produces, then call proposeThreadAction
    // directly — no production-tool refactor. buildFakeScopeDraftInput's parity is
    // pinned in Task 1's unit tests (byte-identical key to propose_crew_work).
    const scopeInput = buildFakeScopeDraftInput({
      companyId: payload.companyId,
      threadId,
      runId: args.runId,
      agentId: agent.id,
      summary,
      proposedTasks,
      threadFreshness: args.threadFreshness ?? null,
    });
    await (deps?.proposeThreadAction ?? (async (input: ReturnType<typeof buildFakeScopeDraftInput>) => {
      const { threadAgentActionService } = await import("../../thread-agent-actions.js");
      return threadAgentActionService(db).proposeThreadAction(input);
    }))(scopeInput);

    // Visible confirmation entry — the e2e's waitForVisibleAgentEntry target.
    // Direct insert (not action-gated) matches the harness's existing precedent
    // for fake replies; an AGENT entry does not bump latestHumanSeq, so it cannot
    // stale-suppress the scope action queued above.
    //
    // Eng-review 1A: BEST-EFFORT. The entry is decoration; the queued action is
    // cargo. An un-guarded throw here would fail the run, and a failed run's
    // proposed rows are never sealed (runner.ts:596 — by design), permanently
    // stranding the action a cosmetic insert failure. Log and continue.
    try {
      await (deps?.addEntry ?? ((companyId, id, data, actorId) => defaultAddEntry(db, companyId, id, data, actorId)))(
        payload.companyId,
        threadId,
        {
          inputType: "agent",
          rawContent: `Adjutant: I queued a scope draft with ${proposedTasks.length} task(s) for this thread.`,
          authorAgentId: agent.id,
          sourceInfo: { e2eFakeCrewLlm: true },
        },
        agent.id,
      );
    } catch (entryErr) {
      logger.warn(
        { err: entryErr, threadId },
        "fake-crew: confirmation entry failed (best-effort) — scope action stays queued",
      );
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: { fakeCrewLlm: true, action: "queue_scope_draft" },
    };
  }
```

Supporting edits in the same file: hoist the default task pair (it already exists verbatim in the LEGACY Adjutant branch at lines 181-184 — replace that literal too, aggressive-DRY):

```ts
/** Shared by the legacy proposeWork branch and the controller-mode branch. */
const FAKE_DEFAULT_PROPOSED_TASKS: Array<{ title: string; assigneeRole?: string }> = [
  { title: "Clarify the accepted scope handoff", assigneeRole: "planner" },
  { title: "Implement the scoped thread cycle", assigneeRole: "engineer" },
];
```

and add the logger import next to the new `readFileSync` import:

```ts
import { logger } from "../../../middleware/logger.js";
```

(verify the relative path against a sibling in `aoa-agents/` that already imports the middleware logger; match its specifier exactly).

Check the relative import path: `fake-crew-llm.ts` lives in `aoa-agents/`, the helper in `tools/` — from `aoa-agents/` the path is `../tools/queue-scope-draft-action.js`. Verify against how sibling files in `aoa-agents/` import from `tools/` (e.g. `ensure-command-staff.ts`) and match their convention.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/fake-crew-llm.test.ts`
Expected: PASS — all pre-existing tests (the harness stayed legacy-compatible) + all new ones.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/fake-crew-llm.ts server/src/__tests__/fake-crew-llm.test.ts
git commit -m "feat(e2e): controller-mode fake Adjutant — queues real create_scope_draft actions

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Runner call-site — pass runId / discussionRunMode / threadFreshness

All three values are already computed and in scope at the intercept site.

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/runner.ts:499-503`

- [ ] **Step 1: Widen the call**

Replace (runner.ts:498-503):

```ts
    const adapterResult =
      (await maybeExecuteFakeCrewTurn({
        db,
        agent: { id: agent.id, name: agent.name },
        payload,
      })) ??
```

with:

```ts
    const adapterResult =
      (await maybeExecuteFakeCrewTurn({
        db,
        agent: { id: agent.id, name: agent.name },
        payload,
        // Controller-mode fake turns queue real create_scope_draft actions; the
        // seal (below) and direct-run commit then treat them exactly like a real
        // agent's tool calls — no fake-specific bookkeeping anywhere downstream.
        runId,
        discussionRunMode,
        threadFreshness,
      })) ??
```

- [ ] **Step 2: Typecheck + full fake/runner suite**

Run: `pnpm --filter @armyofagents/server exec tsc --noEmit` → 0 errors.
Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/fake-crew-llm.test.ts src/__tests__/aoa-runner-task-execution.test.ts src/__tests__/aoa-dispatcher.test.ts`
Expected: ALL PASS (the widened args are optional — existing runner tests that stub the fake are unaffected).

- [ ] **Step 3: Commit**

```bash
git add server/src/services/internal-agent/aoa-agents/runner.ts
git commit -m "feat(e2e): runner passes runId/discussionRunMode/threadFreshness to the fake-crew turn

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: The CI Playwright spec — full Assist round-trip without any CLI

A CI-runnable sibling of the gated real-crew spec: same assertions, fake turn instead of a real CLI. Runs in every `pr.yml` e2e job (fake harness env is already on).

**Files:**
- Create: `tests/e2e/team-aoa-crew-dispatch-approval-ci.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
/**
 * E2E (fake-crew harness Path B): Assist Inbox crew_dispatch approval round-trip
 * — CI-runnable sibling of team-aoa-crew-dispatch-approval.spec.ts.
 *
 * The gated real-crew spec proves the flow with a live CLI (AOA_E2E_REAL_CREW_FLOW=1,
 * skipped in CI). This spec proves the SAME server-side pipeline in normal CI by
 * scripting the fake Adjutant's controller-mode turn via the control file:
 *   mention wakeup → fake queues create_scope_draft (real thread action, real
 *   idempotency key, real freshness) → runner seals + commits → W1b Assist gate
 *   creates the task as planning + ONE crew_dispatch approval → approve →
 *   planning→standard flip.
 * Everything from proposeThreadAction onward is PRODUCTION code — only the LLM
 * turn is fake.
 */

import { expect, test } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import {
  resetFakeCrewControl,
  writeFakeCrewControl,
} from "./helpers/fake-crew-control";
import {
  createThreadFromUi,
  patchThreadAutonomy,
  sendThreadMessage,
  waitForVisibleAgentEntry,
} from "./helpers/thread-flow";

type CrewDispatchApproval = {
  id: string;
  type: string;
  status: string;
  payload: { taskIds?: string[] };
};

type CrewIssue = { id: string; workMode?: string | null; title?: string };

type AgentRow = { id: string; name: string; kind: string };

async function jsonOf<T>(response: { ok: () => boolean; status: () => number; json: () => Promise<unknown> }, label: string): Promise<T> {
  if (!response.ok()) throw new Error(`${label} failed: HTTP ${response.status()}`);
  return (await response.json()) as T;
}

async function poll<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}

test.describe("Team AoA — fake-crew Assist crew_dispatch approval round-trip (CI)", () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ request }) => {
    resetFakeCrewControl();
    await cleanupTestCompanies(request, /^E2E-FakeDispatch-/);
  });

  test.afterEach(() => {
    // The control file is global (workers:1) — ALWAYS reset so later specs get
    // the legacy fake behavior they were written against.
    resetFakeCrewControl();
  });

  test("Assist: fake Adjutant scope → planning task + Inbox approval → approve → dispatched", async ({
    page,
    request,
  }) => {
    // ── 1. Company (crew auto-seeded by companyService.create) at Assist ──────
    const company = await seedCompany(request, `E2E-FakeDispatch-${Date.now()}`);
    // Eng-review fix 1 (challenger finding 1): the /agents route defaults to
    // kind:"org" (agents.ts:470) — the crew agents are ONLY returned with
    // ?kind=aoa (real-crew.ts:202 does exactly this). Without it, this list is
    // empty and the Adjutant lookup below fails deterministically.
    const agents = await jsonOf<AgentRow[]>(
      await request.get(`/api/companies/${company.id}/agents?kind=aoa`),
      "list crew agents",
    );
    const adjutant = agents.find((a) => a.name === "Adjutant");
    expect(adjutant, "auto-seeded Adjutant crew agent").toBeTruthy();

    // ── 2. Script the fake Adjutant's next turn BEFORE triggering it ──────────
    writeFakeCrewControl({
      adjutant: {
        mode: "controller_scope",
        summary: "Build the token endpoint for the auth rewrite",
        proposedTasks: [{ title: "Implement the token endpoint", assigneeRole: "engineer" }],
      },
    });

    // ── 3. Thread at Assist (autonomy 1) + @Adjutant mention trigger ──────────
    await page.goto(`/${company.issuePrefix}/discussions`);
    await expect(page.getByRole("heading", { name: /Discussions/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    const threadId = await createThreadFromUi(
      page,
      `Fake dispatch approval ${Date.now()}`,
      "We need to build the token endpoint for the auth rewrite, including refresh rotation.",
    );
    await patchThreadAutonomy(request, company.id, threadId, 1); // Assist
    await sendThreadMessage(page, "@Adjutant please scope this into tracked tasks.");

    // The fake turn posts a visible confirmation entry once it queued the action.
    await waitForVisibleAgentEntry(
      page,
      request,
      company.id,
      threadId,
      adjutant!.id,
      "Adjutant",
      "fake Adjutant queued-scope entry",
      120_000,
    );

    // ── 4. ONE pending crew_dispatch approval referencing the planning task ───
    const dispatchApproval = await poll<CrewDispatchApproval[]>(
      async () =>
        jsonOf<CrewDispatchApproval[]>(
          await request.get(`/api/companies/${company.id}/approvals?status=pending`),
          "list pending approvals",
        ),
      (approvals) =>
        approvals.some((a) => a.type === "crew_dispatch" && (a.payload.taskIds?.length ?? 0) > 0),
      "pending crew_dispatch approval",
      120_000,
    ).then((approvals) => approvals.find((a) => a.type === "crew_dispatch")!);

    const taskIds = dispatchApproval.payload.taskIds ?? [];
    expect(taskIds.length, "crew_dispatch approval carries the created task ids").toBe(1);
    const dispatchedTaskId = taskIds[0];

    // ── 5. The task exists on the crew board, parked as planning, with the
    //       CONTROL-FILE title (agent-authored naming path, not a heuristic) ────
    const before = await jsonOf<CrewIssue[]>(
      await request.get(`/api/companies/${company.id}/issues?taskScope=crew`),
      "list crew issues (before)",
    );
    const parked = before.find((i) => i.id === dispatchedTaskId);
    expect(parked?.workMode).toBe("planning");
    expect(parked?.title).toBe("Implement the token endpoint");

    // ── 6. Approve → planning→standard flip (dispatch side-effect) ────────────
    await jsonOf(
      await request.post(`/api/approvals/${dispatchApproval.id}/approve`, {
        data: { decisionNote: null },
      }),
      "approve crew_dispatch",
    );
    const after = await poll<CrewIssue[]>(
      async () =>
        jsonOf<CrewIssue[]>(
          await request.get(`/api/companies/${company.id}/issues?taskScope=crew`),
          "list crew issues (after)",
        ),
      (issues) => issues.find((i) => i.id === dispatchedTaskId)?.workMode === "standard",
      "crew task flipped to standard after approve",
      30_000,
    );
    expect(after.find((i) => i.id === dispatchedTaskId)?.workMode).toBe("standard");
  });

  // Eng-review 2A: Drive (autonomy 2) — the no-human-gate mode. Highest blast
  // radius, so it gets full-pipeline CI coverage too: NO approval is created and
  // the task lands dispatchable (standard) directly.
  //
  // Eng-review fix 7 (challenger finding 7): pin Drive at the THREAD level only.
  // patchThreadAutonomy sets discussions.autonomyLevel (the thread override), NOT
  // company config, so the company stays at its Manual default — a stray sweep.*
  // Adjutant run (legacy branch, no thread override in its payload) can't
  // auto-approve legacy tasks at company-Drive mid-test. The thread override is
  // what the create_scope_draft commit reads for THIS thread's gate. (Verify
  // patchThreadAutonomy targets the thread row, not company config, before relying
  // on this — thread-flow.ts.)
  test("Drive: fake Adjutant scope → task standard immediately, NO crew_dispatch approval", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-FakeDispatch-Drive-${Date.now()}`);
    writeFakeCrewControl({
      adjutant: {
        mode: "controller_scope",
        summary: "Drive-mode scope",
        proposedTasks: [{ title: "Ship the drive-mode task", assigneeRole: "engineer" }],
      },
    });

    await page.goto(`/${company.issuePrefix}/discussions`);
    await expect(page.getByRole("heading", { name: /Discussions/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    const threadId = await createThreadFromUi(
      page,
      `Fake drive dispatch ${Date.now()}`,
      "We need to ship the drive-mode task end to end.",
    );
    await patchThreadAutonomy(request, company.id, threadId, 2); // Drive (thread override only)
    await sendThreadMessage(page, "@Adjutant please scope this into tracked tasks.");

    // The task appears ALREADY dispatchable — no planning parking, no approval.
    const issues = await poll<CrewIssue[]>(
      async () =>
        jsonOf<CrewIssue[]>(
          await request.get(`/api/companies/${company.id}/issues?taskScope=crew`),
          "list crew issues (drive)",
        ),
      (rows) => rows.some((i) => i.title === "Ship the drive-mode task" && i.workMode === "standard"),
      "drive-mode task created as standard",
      120_000,
    );
    expect(issues.find((i) => i.title === "Ship the drive-mode task")?.workMode).toBe("standard");

    const approvals = await jsonOf<CrewDispatchApproval[]>(
      await request.get(`/api/companies/${company.id}/approvals?status=pending`),
      "list pending approvals (drive)",
    );
    expect(
      approvals.filter((a) => a.type === "crew_dispatch"),
      "Drive must NOT raise a crew_dispatch approval",
    ).toHaveLength(0);
  });
});
```

Adjust to reality while implementing (check, don't assume): the exact `waitForVisibleAgentEntry` signature in `tests/e2e/helpers/thread-flow.ts`; whether the approvals list route is `/api/companies/:cid/approvals?status=pending` (copy whatever `team-aoa-crew-dispatch-approval.spec.ts` uses — it is the reference); whether `seedCompany` returns `issuePrefix`; **whether `patchThreadAutonomy` writes the thread row vs company config** (finding 7 relies on thread-only). If the sibling real spec uses `jsonOrThrow`/`poll` from `./helpers/real-crew`, prefer importing those two helpers from there instead of redefining (they have no real-CLI dependency) — delete the local `jsonOf`/`poll` above in that case. **The `/agents?kind=aoa` query param is REQUIRED (finding 1) — do not drop it.**

**Scope note (challenger finding 6):** this spec asserts the `planning→standard` FLIP (Assist) and `standard`-at-creation (Drive) — NOT the crew-run dispatch that follows. The fake harness structurally cannot cover the dispatched run: a fake crew turn never calls `set_task_status`, so a dispatched task trips the runner's silent-stuck guard (`runner.ts:548-574`) → task released `in_progress→todo`, run marked failed. That failed-run noise is harmless to these assertions (they check `workMode`, not run outcome) but means the actual agent-executes-the-task leg stays covered ONLY by the gated real-crew soak spec. The verification table reflects "flip", not "dispatch".

- [ ] **Step 2: Run the spec locally**

Run (repo root, Windows local run):
`AOA_E2E_FORCE_WINDOWS=1 pnpm exec playwright test tests/e2e/team-aoa-crew-dispatch-approval-ci.spec.ts --config tests/e2e/playwright.config.ts`
Expected: 1 passed. Debug artifacts on failure: `playwright-report/` → `error-context.md`.

- [ ] **Step 3: Prove non-regression of the legacy-dependent specs**

Run: `AOA_E2E_FORCE_WINDOWS=1 pnpm exec playwright test tests/e2e/full-discussion-to-workspace-cycle.spec.ts tests/e2e/onboarding-thread-pipeline.spec.ts tests/e2e/mention-autocomplete.spec.ts --config tests/e2e/playwright.config.ts`
Expected: ALL PASS (the control file is absent for these — legacy behavior byte-for-byte).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/team-aoa-crew-dispatch-approval-ci.spec.ts
git commit -m "test(e2e): CI Assist crew_dispatch round-trip via the fake-crew controller turn

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Docs + stale-comment hygiene

**Files:**
- Modify: `docs/deploy/environment-variables.md` (new `AOA_E2E_FAKE_CREW_CONTROL` row — brand-check guard #338 FAILS the build if an `AOA_*` var appears in `server/src` undocumented)
- Modify: `tests/e2e/team-aoa-crew-dispatch-approval.spec.ts:19-23` (header comment now stale)
- Modify: `docs/aoa/plans/2026-07-03-discussions-end-to-end-design.md` (sequence item ① status)

- [ ] **Step 1: Document the env var**

In `docs/deploy/environment-variables.md`, find the row documenting `AOA_E2E_FAKE_CREW_LLM` and add directly below it (match the table/format of the surrounding rows exactly):

```markdown
| `AOA_E2E_FAKE_CREW_CONTROL` | E2E only | Path to a JSON control file that scripts the fake-crew harness per test (e.g. the controller-mode Adjutant scope turn). Read fresh on every fake turn; absent/invalid ⇒ legacy fake behavior. Set by `tests/e2e/playwright.config.ts`. No effect unless `AOA_E2E_FAKE_CREW_LLM=1`. |
```

- [ ] **Step 2: Fix the real spec's stale header**

In `tests/e2e/team-aoa-crew-dispatch-approval.spec.ts`, the header sentence "The fake-crew LLM harness (AOA_E2E_FAKE_CREW_LLM=1) also bypasses this path — it calls the legacy `crewTaskService.proposeWork` directly, not `propose_crew_work`." is now wrong. Replace that sentence with:

```
 * The fake-crew harness now ALSO covers this path in normal CI via its
 * controller-mode turn (see team-aoa-crew-dispatch-approval-ci.spec.ts) — this
 * spec remains the LIVE-fidelity soak (real CLI, real MCP bridge, real tool
 * registry gating), gated behind AOA_E2E_REAL_CREW_FLOW=1 exactly like
 * real-crew-discussion-flow.spec.ts, and is skipped in normal CI.
```

- [ ] **Step 3: Mark sequence item ① in the design doc**

In `docs/aoa/plans/2026-07-03-discussions-end-to-end-design.md`, NEXT-PHASE SEQUENCE item 1, append: `— **DONE** (PR #<this PR>): control-file-scripted controller-mode fake turn + CI spec; W1 approve→dispatch now CI-covered.` (fill the PR number at ship time).

- [ ] **Step 4: Commit**

```bash
git add docs/deploy/environment-variables.md tests/e2e/team-aoa-crew-dispatch-approval.spec.ts docs/aoa/plans/2026-07-03-discussions-end-to-end-design.md
git commit -m "docs(e2e): document AOA_E2E_FAKE_CREW_CONTROL + refresh stale harness notes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Full verification sweep + ship

- [ ] **Step 1: Server unit sweep**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/fake-crew-llm.test.ts src/__tests__/thread-action-gated-tools.test.ts src/__tests__/propose-crew-work-tool.test.ts src/__tests__/thread-agent-actions.test.ts src/__tests__/aoa-runner-task-execution.test.ts src/__tests__/aoa-dispatcher.test.ts src/__tests__/w1b-auto-accept.test.ts src/__tests__/crew-dispatch-approval.test.ts`
Expected: ALL PASS. **`thread-action-gated-tools.test.ts` is the ACTUAL pin for `propose-crew-work.ts`'s gated branch (challenger finding 3 — it asserts `actionType: "create_scope_draft"` + the idempotency key at :90-138).** D5 means this plan does NOT touch `propose-crew-work.ts`, so this test must stay green as proof the tool branch is undisturbed. (`queue-scope-draft-action.test.ts` is GONE — the D5 decision replaced the extracted helper with `buildFakeScopeDraftInput`, tested inside `fake-crew-llm.test.ts`.)

- [ ] **Step 2: Typecheck + brand-check**

Run: `pnpm --filter @armyofagents/server exec tsc --noEmit` → 0 errors.
Run the brand-check the same way CI does (search `.github/workflows/pr.yml` for the brand-check job's command and run it locally) — the new `AOA_E2E_FAKE_CREW_CONTROL` reference in `server/src` must pass against the doc row added in Task 6.

- [ ] **Step 3: E2E — new spec + the three legacy-dependent specs (again, post-docs)**

Run: `AOA_E2E_FORCE_WINDOWS=1 pnpm exec playwright test tests/e2e/team-aoa-crew-dispatch-approval-ci.spec.ts tests/e2e/full-discussion-to-workspace-cycle.spec.ts tests/e2e/onboarding-thread-pipeline.spec.ts tests/e2e/mention-autocomplete.spec.ts --config tests/e2e/playwright.config.ts`
Expected: ALL PASS.

- [ ] **Step 4: Push + PR + Codex loop**

```bash
git push -u origin feat/fake-crew-harness
gh pr create --title "feat(e2e): fake-crew controller-mode harness — W1 scope→dispatch CI-covered (Path B)" --body "<summary of the four commits; note the additive control-file design + untouched legacy specs; mention this unlocks D17>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Then the standard loop: watch CI + `@codex review` rounds until a clean pass; merge is the user's call.

---

## Verification summary (what proves what)

| Layer | Artifact | Proves |
|---|---|---|
| Unit | `fake-crew-llm.test.ts` — `buildFakeScopeDraftInput` (3) | Key/payload byte-parity with `propose_crew_work` (incl. raw-tasks empty-role, finding 4) |
| Unit | `fake-crew-llm.test.ts` — controller branch (7) | Branch selection (control+gated+runId → queue; every other combination → legacy, incl. runId-null), default-tasks fallback, best-effort entry guard (1A) |
| Unit | `thread-action-gated-tools.test.ts` (existing, finding 3) | The real tool's gated branch is UNDISTURBED (D5: no prod refactor) |
| E2E (CI) | `team-aoa-crew-dispatch-approval-ci.spec.ts` (2 tests) | The production pipeline from `proposeThreadAction` onward: Assist (seal → commit → W1a role resolution → W1b gate → W1c approval → approve → **planning→standard flip**) AND Drive (2A: standard-at-creation, zero approvals). The dispatched crew RUN is NOT asserted (finding 6 — the fake can't execute a task; that leg stays with the gated soak). |
| E2E (CI) | 3 legacy specs re-run | Zero regression for control-file-absent behavior |
| E2E (gated) | `team-aoa-crew-dispatch-approval.spec.ts` (unchanged) | Live fidelity: real CLI, MCP bridge, tool-registry gating, AND the actual dispatched-run leg — the drift + execution check the fake can't provide |

## Known risks (from the gap-analysis + Codex-subagent challenge, addressed in-plan)

1. **Legacy-spec regression** → control-file opt-in + UNCONDITIONAL config-load cleanup (finding 2) + non-regression runs (Task 5/7) + unit pin ("no control file → legacy byte-for-byte").
2. **Freshness flake shape** → the spec posts NO human message between the mention and the commit (the fake's confirmation entry is an AGENT entry — does not bump `latestHumanSeq`).
3. **Fake-vs-real drift** → the real gated spec stays alive; the ONLY must-match contract (the idempotency key) is pinned byte-for-byte by `buildFakeScopeDraftInput`'s parity test (D5 keeps prod code untouched); what remains un-faked (CLI, MCP bridge, allowlist gating, task execution) is exactly what the gated spec covers.
4. **Idempotency-key collision on repeated triggers** → single-shot spec; two-runs-per-message at Assist collapse via same key + `onConflictDoNothing` (finding 5); control-file scripting varies summary/tasks if a future multi-step spec needs distinct keys; round-10 no-op revive un-wedges same-key retries.
5. **Budget preflight on approve** → `seedCompany` creates no budget policies, so `preflightCrewDispatch` cannot hard-stop in this spec.
6. **Adjutant lookup empty** → `/agents?kind=aoa` is required (finding 1); the crew list is org-default without it.
7. **Drive company-autonomy contamination** → Drive is set at the THREAD level only (finding 7); company stays Manual so stray sweeps can't auto-approve mid-test.

## What already exists (reused, not rebuilt)

| Capability | Where | This plan's use |
|---|---|---|
| Fake-crew interception seam | `runner.ts:499` (`maybeExecuteFakeCrewTurn(...) ?? adapter.execute(...)`), gated by `AOA_E2E_FAKE_CREW_LLM=1` already set in `playwright.config.ts:113` | Extended with a controller-mode branch — no new seam |
| Idempotency-key contract | `buildScopeDraftIdempotencyKey` (`thread-action-keys.ts`), already shared, already Codex-hardened (#198) | The fake reuses it verbatim (D5) — the one thing that must match |
| Outbox seal + commit | `runner.ts:597` (seal) + `:636` (direct-run commit) — fire for any gated run regardless of fake/real | The queued fake action rides these unchanged — zero fake-specific bookkeeping |
| W1a/W1b/W1c pipeline | role resolution, autonomy gate, `crew_dispatch` approval, `planning→standard` flip — all merged | The e2e exercises them as production code — the whole point |
| Control-file test pattern | `fake-claude.ts` / `fake-codex.ts` deterministic-tmpdir contract | Copied for `AOA_E2E_FAKE_CREW_CONTROL` |
| Real-crew e2e helpers | `thread-flow.ts` (`createThreadFromUi`, `sendThreadMessage`, `patchThreadAutonomy`, `waitForVisibleAgentEntry`), `seed-company.ts`, `real-crew.ts` (`jsonOrThrow`, `poll`) | Reused directly by the CI spec |
| Gated real-crew spec | `team-aoa-crew-dispatch-approval.spec.ts` | Stays as the live-fidelity soak; this plan forks a CI sibling, does not replace it |

**Nothing here is a parallel rebuild.** The one net-new production symbol is `buildFakeScopeDraftInput` (a pure input-shaper in the fake module); everything else is test/config/docs.

## Parallelization strategy

Sequential implementation, minimal parallelization opportunity. Tasks 1→3 all modify the same file (`fake-crew-llm.ts`) and build on each other (Task 3 calls Task 1's `buildFakeScopeDraftInput` and Task 2's `readFakeCrewControl`); Task 4 depends on Task 3's widened signature; Task 5 depends on Tasks 2-4 existing; Tasks 6-7 are docs/verification over everything. The only independent lane is the spec-side helper `tests/e2e/helpers/fake-crew-control.ts` (Task 2 Step 5), which could be written in parallel with Task 1 — not worth a worktree for one ~40-line file. Execute in order.

## Failure modes (per new codepath)

| Codepath | Realistic failure | Test? | Error handling? | Visible? |
|---|---|---|---|---|
| `buildFakeScopeDraftInput` key derivation | Drifts from the tool's key recipe | ✅ parity unit test (Task 1) | N/A (pure) | CI fail (loud) |
| Controller-mode branch selection | Hijacks a legacy spec's Adjutant turn | ✅ "no control file → legacy" pin + unconditional cleanup (finding 2) | control-file absent → legacy | CI fail (loud) |
| Confirmation entry insert | Transient DB error strands the queued action | ✅ best-effort unit test (1A) | try/catch + log.warn | run still succeeds; e2e visibility-wait times out with action safely committed |
| Queued action never sealed | Fake run reports failure | ✅ covered by runner seal tests | run-success gates the seal | task never dispatches; e2e times out |
| Drive company-autonomy leak | Stray sweep auto-approves mid-test | mitigated structurally (thread-only autonomy, finding 7) | N/A | flaky assertion if mis-set — hence the verify-patchThreadAutonomy note |

**No critical gaps** (a failure that is silent AND untested AND unhandled). The one degradation-not-failure is the confirmation-entry timeout, which surfaces loudly as an e2e failure with the underlying action intact.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | not run (test-infra work, no product surface) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 2 issues (D5 architecture: no prod refactor; scope gate passed), 0 critical gaps |
| Outside Voice | Codex→Claude subagent | Independent 2nd opinion | 1 | issues_found | 8 findings (3×P2, 5×P3), all folded; SOUND-WITH-FIXES |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | n/a (no UI) |

- **OUTSIDE VOICE:** Codex hit its usage limit → fell back to an independent Claude subagent (fresh context, verified all claims against the repo). Found 1 deterministic bug the review missed (`/agents` needs `?kind=aoa`), 2 more P2s (unconditional control-file cleanup; wrong test file in verify lists), 5 P3s. All 8 folded into the plan.
- **CROSS-MODEL TENSION:** Finding 8 (extract vs direct-call) — the challenger argued the extraction refactors Codex-hardened production code to serve a test when the only shared contract (the key builder) is already shared. Resolved D5 in favor of the challenger: fake calls `proposeThreadAction` + the existing key builder directly via a pure `buildFakeScopeDraftInput`; a parity unit test is the guard; `propose-crew-work.ts` stays untouched.
- **UNRESOLVED:** none.
- **VERDICT:** ENG CLEARED — plan ready to implement. Scope gate passed (5 code files / 7 test-doc), 2 eng-review issues resolved (1A best-effort entry, 2A Drive variant), 8 outside-voice findings folded, 0 critical gaps.
