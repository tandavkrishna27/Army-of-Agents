# W5a Runtime Decision Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the correctness, safety, and reliability bugs in the (intentionally inert) W5a runtime-decision subsystem shipped in PR #259, so the machinery is provably correct the day W5b wires a real adapter bridge — without turning the feature on.

**Architecture:** All changes land on the existing PR branch `codex/w5-runtime-decision-routing` (amends #259). No adapter bridge is added (that stays W5b, gated on the CLI-hook spike per the feasibility matrix). Changes are confined to the runtime-decision service, its realRepo, the heartbeat broker default, the hub reconciler, the timeout sweep in `index.ts`, one additive DB index migration, and one UI nit. Every behavior change is locked by tests in the layer that owns it.

**Tech Stack:** Drizzle/Postgres (generated migration), Express 5 service/routes, shared Zod contracts, Vitest (service + repo + reconcile + UI), Playwright e2e (unchanged), TDD throughout.

**Locked product decisions (from brainstorming 2026-07-02):**
- Timeout policy defaults: permission → `deny`, work_question → `park_run`.
- Expiry SLA: permission `1h`, work_question `24h`; a null/infinite `expiresAt` is never persisted.
- Allow-always trust rules default to a `90-day` expiry.
- Answer authority stays **founder-only** (unchanged; matches `HUB_AUTHORITY_BY_TYPE`).

---

## Scope Check

Single subsystem (runtime decisions). One plan. No decomposition needed.

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `server/src/services/agent-runtime-decisions.ts` | Prompt lifecycle service + realRepo | Default expiry, `continue_with_default`, redaction, sweep resilience/order, trust-rule tx+dedup+90d, replay guard, `defaultTimeoutPolicy` export |
| `server/src/services/heartbeat.ts` | Broker default policy | Use `defaultTimeoutPolicy(kind)` instead of inline literal |
| `server/src/services/hub-items.ts` | Hub source reconciler | `reconcileRuntimeDecision` delegates to `runtimeDecisionSourceSnapshot` |
| `server/src/index.ts` | Timeout sweep tick | Drain loop (bounded), keeps in-flight guard |
| `packages/db/src/schema/agent_runtime_decisions.ts` | Schema | Add `(status, expires_at)` index |
| `packages/db/src/migrations/*` | Generated migration | `pnpm db:generate` → new migration |
| `ui/src/components/hub/HubViewer.tsx` | Runtime decision panel | Parenthesize `disabled` expression |
| `server/src/__tests__/agent-runtime-decisions.test.ts` | Service unit tests | Extend harness + new cases |
| `server/src/__tests__/agent-runtime-decisions-realrepo.test.ts` | realRepo tx/dedup tests (NEW) | Mock-db transaction coverage |
| `packages/db/src/__tests__/agent-runtime-decisions-schema.test.ts` | Schema/index contract (NEW) | Assert new index |
| `ui/src/components/hub/__tests__/HubShell.test.tsx` | UI behavior | Disabled-on-terminal assertion |

**Testing note (repo convention, per `CLAUDE.md` §Test Patterns):** service tests inject a fake `repo` via `ServiceDeps` (see `makeService()` in the existing test). realRepo (transaction/dedup) tests use a hand-rolled mock `db` object, following the `createSequenceDb` proxy pattern already used in `server/src/__tests__/aoa-runs-total.test.ts`.

---

## Task 1: Enforce a non-null default expiry (SLA)

Prevents the infinite-wait wedge: a prompt with no `expiresAt` currently never expires, and the broker's `waitForAnswer` would poll forever. After this task every prompt carries an expiry, so the sweep always has a backstop.

**Files:**
- Modify: `server/src/services/agent-runtime-decisions.ts` (constants near top ~line 18; `createPrompt` ~line 457)
- Test: `server/src/__tests__/agent-runtime-decisions.test.ts`

- [ ] **Step 1: Write failing tests for default expiry per kind**

Add to `server/src/__tests__/agent-runtime-decisions.test.ts` inside `describe("agentRuntimeDecisionService", ...)`:

```typescript
it("defaults permission prompt expiry to 1h when none supplied", async () => {
  const { service, repo } = makeService();
  await service.createPrompt({
    companyId: "company-1", agentId: "agent-1",
    runId: "11111111-1111-4111-8111-111111111111",
    adapterType: "claude_local", kind: "permission", nonce: "nonce-1",
    title: "Allow?", timeoutPolicy: "deny",
  });
  expect(repo.createDecision).toHaveBeenCalledWith(
    expect.objectContaining({
      expiresAt: new Date("2026-07-01T13:00:00.000Z"), // now (12:00) + 1h
    }),
  );
});

it("defaults work_question expiry to 24h when none supplied", async () => {
  const { service, repo } = makeService();
  await service.createPrompt({
    companyId: "company-1", agentId: "agent-1",
    runId: "11111111-1111-4111-8111-111111111111",
    adapterType: "claude_local", kind: "work_question", nonce: "nonce-2",
    title: "Which approach?", timeoutPolicy: "park_run",
  });
  expect(repo.createDecision).toHaveBeenCalledWith(
    expect.objectContaining({
      expiresAt: new Date("2026-07-02T12:00:00.000Z"), // now (12:00) + 24h
    }),
  );
});

it("honours an explicitly supplied expiry", async () => {
  const { service, repo } = makeService();
  const explicit = new Date("2026-07-01T12:05:00.000Z");
  await service.createPrompt({
    companyId: "company-1", agentId: "agent-1",
    runId: "11111111-1111-4111-8111-111111111111",
    adapterType: "claude_local", kind: "permission", nonce: "nonce-3",
    title: "Allow?", timeoutPolicy: "deny", expiresAt: explicit,
  });
  expect(repo.createDecision).toHaveBeenCalledWith(
    expect.objectContaining({ expiresAt: explicit }),
  );
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test:run agent-runtime-decisions`
Expected: FAIL — current code passes `expiresAt: null` for the first two.

- [ ] **Step 3: Add TTL constants + helper**

In `server/src/services/agent-runtime-decisions.ts`, after the `TERMINAL_STATUSES` block (~line 29), add:

```typescript
const PERMISSION_DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const WORK_QUESTION_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function defaultTtlMs(kind: RuntimeDecisionKind) {
  return kind === "permission" ? PERMISSION_DEFAULT_TTL_MS : WORK_QUESTION_DEFAULT_TTL_MS;
}

export function defaultTimeoutPolicy(kind: RuntimeDecisionKind): RuntimeDecisionTimeoutPolicy {
  return kind === "permission" ? "deny" : "park_run";
}
```

- [ ] **Step 4: Coerce null expiry in `createPrompt`**

In `createPrompt` (~line 457), replace the single `expiresAt: input.expiresAt ?? null,` line in the `repo.createDecision({...})` call with a computed value. Add above the `repo.createDecision` call:

```typescript
const nowDate = now();
const resolvedExpiresAt =
  input.expiresAt ?? new Date(nowDate.getTime() + defaultTtlMs(input.kind));
```

Then in the insert object change:

```typescript
expiresAt: resolvedExpiresAt,
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `pnpm test:run agent-runtime-decisions`
Expected: PASS (all three new + existing).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/agent-runtime-decisions.ts server/src/__tests__/agent-runtime-decisions.test.ts
git commit -m "fix(w5a): enforce non-null default expiry (permission 1h / work-question 24h)"
```

---

## Task 2: Complete `continue_with_default` and centralize the default policy

`continue_with_default` currently falls through to `status: "expired"`, which makes `waitForAnswer` throw and fails the run. Plan intent (W5 plan line 160): relay an explicit safe default when supplied, otherwise resolve to the kind's safe default policy (never silently fail).

**Files:**
- Modify: `server/src/services/agent-runtime-decisions.ts` (`expireDuePrompts` ~line 730)
- Modify: `server/src/services/heartbeat.ts` (broker default ~line 176)
- Test: `server/src/__tests__/agent-runtime-decisions.test.ts`

- [ ] **Step 1: Write failing tests for `continue_with_default`**

```typescript
it("continue_with_default relays an explicit default option when present", async () => {
  const due = baseDecision({
    id: "d-cwd-1", kind: "permission", timeoutPolicy: "continue_with_default",
    status: "shown", sourceRevision: 5,
    options: [{ label: "Allow once", value: "allow_once", isDefault: true }],
  });
  const updateDecision = vi.fn(async (_id, patch) => baseDecision(patch as Record<string, unknown>));
  const { service } = makeService({
    listDueForExpiry: vi.fn(async () => [due]),
    updateDecision,
  });
  await service.expireDuePrompts({ limit: 10 });
  expect(updateDecision).toHaveBeenCalledWith(
    "d-cwd-1",
    expect.objectContaining({ status: "answered", decision: "allow_once" }),
    expect.objectContaining({ sourceRevision: 5, statuses: ["created", "shown"] }),
  );
});

it("continue_with_default without a default falls back to deny for permission (never expired)", async () => {
  const due = baseDecision({
    id: "d-cwd-2", kind: "permission", timeoutPolicy: "continue_with_default",
    status: "shown", sourceRevision: 3, options: null,
  });
  const updateDecision = vi.fn(async (_id, patch) => baseDecision(patch as Record<string, unknown>));
  const { service } = makeService({
    listDueForExpiry: vi.fn(async () => [due]),
    updateDecision,
  });
  await service.expireDuePrompts({ limit: 10 });
  expect(updateDecision).toHaveBeenCalledWith(
    "d-cwd-2",
    expect.objectContaining({ status: "answered", decision: "deny" }),
    expect.anything(),
  );
});

it("continue_with_default without a default parks a work_question (never denies)", async () => {
  const due = baseDecision({
    id: "d-cwd-3", kind: "work_question", timeoutPolicy: "continue_with_default",
    status: "shown", sourceRevision: 1, options: null, decision: null,
  });
  const updateDecision = vi.fn(async (_id, patch) => baseDecision(patch as Record<string, unknown>));
  const runCanceller = vi.fn(async () => {});
  const { service } = makeService({
    listDueForExpiry: vi.fn(async () => [due]),
    updateDecision, runCanceller,
  });
  await service.expireDuePrompts({ limit: 10 });
  expect(updateDecision).toHaveBeenCalledWith(
    "d-cwd-3",
    expect.objectContaining({ status: "cancelled" }),
    expect.anything(),
  );
  expect(runCanceller).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test:run agent-runtime-decisions`
Expected: FAIL — `continue_with_default` currently produces `status: "expired"`.

- [ ] **Step 3: Refactor `expireDuePrompts` to a typed outcome**

In `server/src/services/agent-runtime-decisions.ts`, add these helpers above `agentRuntimeDecisionService` (near the other module functions, ~line 240):

```typescript
type TimeoutOutcome = {
  patch: Partial<typeof agentRuntimeDecisions.$inferInsert>;
  cancelsRun: boolean;
  parked: boolean;
};

function resolveExplicitDefault(row: AgentRuntimeDecisionRow):
  | { decision: RuntimeDecisionPermissionDecision }
  | { answer: Record<string, unknown> }
  | null {
  const options = Array.isArray(row.options) ? row.options : [];
  const def = options.find(
    (o): o is Record<string, unknown> =>
      Boolean(o) && typeof o === "object" && (o as Record<string, unknown>).isDefault === true,
  );
  if (!def) return null;
  const value = def.value;
  if (row.kind === "permission") {
    return typeof value === "string" &&
      (RUNTIME_DECISION_PERMISSION_DECISIONS as readonly string[]).includes(value)
      ? { decision: value as RuntimeDecisionPermissionDecision }
      : null;
  }
  return { answer: { selected: value ?? null } };
}

function fallbackPolicyOutcome(
  row: AgentRuntimeDecisionRow,
  policy: RuntimeDecisionTimeoutPolicy,
  bumpRev: number,
  nowDate: Date,
): TimeoutOutcome {
  if (row.kind === "permission" && policy === "deny") {
    return {
      patch: { status: "answered", decision: "deny", answeredAt: nowDate, sourceRevision: bumpRev },
      cancelsRun: false,
      parked: false,
    };
  }
  if (policy === "park_run" || policy === "escalate") {
    return {
      patch: {
        status: "cancelled",
        relayError: policy === "escalate"
          ? "timeout policy escalated the run"
          : "timeout policy parked the run",
        expiresAt: null,
        sourceRevision: bumpRev,
      },
      cancelsRun: true,
      parked: true,
    };
  }
  return {
    patch: {
      status: policy === "cancel_run" ? "cancelled" : "expired",
      relayError: policy === "cancel_run" ? "timeout policy cancelled the run" : undefined,
      sourceRevision: bumpRev,
    },
    cancelsRun: policy === "cancel_run",
    parked: false,
  };
}

function timeoutOutcome(row: AgentRuntimeDecisionRow, nowDate: Date): TimeoutOutcome {
  const bumpRev = row.sourceRevision + 1;
  if (row.timeoutPolicy === "continue_with_default") {
    const def = resolveExplicitDefault(row);
    if (def) {
      return {
        patch: {
          status: "answered",
          decision: "decision" in def ? def.decision : null,
          answerPayload: "answer" in def ? def.answer : null,
          answeredAt: nowDate,
          sourceRevision: bumpRev,
        },
        cancelsRun: false,
        parked: false,
      };
    }
    return fallbackPolicyOutcome(row, defaultTimeoutPolicy(row.kind), bumpRev, nowDate);
  }
  return fallbackPolicyOutcome(row, row.timeoutPolicy, bumpRev, nowDate);
}
```

Add the missing import at the top of the file: `RuntimeDecisionPermissionDecision` is already imported from `@armyofagents/shared`; confirm it is in the type import list (it is).

- [ ] **Step 4: Rewrite the `expireDuePrompts` loop to use `timeoutOutcome`**

Replace the body of `expireDuePrompts` (the `for (const row of due)` block, ~lines 733–782) with:

```typescript
async function expireDuePrompts(input: ExpireDueInput) {
  const nowDate = now();
  const due = await repo.listDueForExpiry({ companyId: input.companyId, now: nowDate, limit: input.limit });
  let expired = 0;
  let processed = 0;
  for (const row of due) {
    const outcome = timeoutOutcome(row, nowDate);
    const updated = await repo.updateDecision(row.id, outcome.patch, {
      sourceRevision: row.sourceRevision,
      statuses: ["created", "shown"],
    });
    if (!updated) continue;
    processed += 1;
    await activityLogger({
      companyId: updated.companyId,
      actorType: "system",
      actorId: "runtime_decision_timeout",
      action: outcome.parked ? "runtime_decision.timeout_parked" : "runtime_decision.expired",
      entityType: "agent_runtime_decision",
      entityId: updated.id,
      agentId: updated.agentId,
      runId: updated.runId,
      details: { sourceRevision: row.sourceRevision, timeoutPolicy: row.timeoutPolicy },
    });
    await emitHubItem(updated);
    if (outcome.cancelsRun) {
      try {
        await runCanceller?.({
          companyId: updated.companyId,
          runId: updated.runId,
          reason: updated.relayError ?? "runtime decision timeout policy cancelled the run",
        });
      } catch {
        // Run may already be gone (FK cascade / purge). The decision row is
        // already flipped, which is the durable effect; do not poison the batch.
      }
    }
    if (!outcome.parked) expired += 1;
  }
  return { expired, processed };
}
```

(Note: this step folds in Task 4's `runCanceller` try/catch and the `processed` counter used by Task 4's drain loop.)

- [ ] **Step 5: Centralize the broker default policy**

In `server/src/services/heartbeat.ts`, the broker `createPrompt` (~line 176) currently reads:

```typescript
timeoutPolicy: prompt.timeoutPolicy ?? (kind === "permission" ? "deny" : "park_run"),
```

Change to use the exported helper:

```typescript
timeoutPolicy: prompt.timeoutPolicy ?? defaultTimeoutPolicy(kind),
```

Add `defaultTimeoutPolicy` to the existing import from `./agent-runtime-decisions.js` (~line 99):

```typescript
import {
  agentRuntimeDecisionService,
  defaultTimeoutPolicy,
  RuntimeDecisionCancelledError,
  type AgentRuntimeDecisionRow,
} from "./agent-runtime-decisions.js";
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `pnpm test:run agent-runtime-decisions`
Run: `pnpm test:run heartbeat-runtime-decision-broker`
Expected: PASS. Existing deny/park/cancel/escalate timeout tests still pass (outcomes preserved).

- [ ] **Step 7: Commit**

```bash
git add server/src/services/agent-runtime-decisions.ts server/src/services/heartbeat.ts server/src/__tests__/agent-runtime-decisions.test.ts
git commit -m "fix(w5a): implement continue_with_default + centralize default timeout policy"
```

---

## Task 3: Complete secret redaction (toolName, adapterSessionParams)

`command`/`path`/`promptText`/`summary`/`title`/`networkTarget` are redacted before persistence, but `toolName` and `adapterSessionParams` are stored raw. Both can carry secrets (session params especially). Plan intent: "secrets are redacted before hub summary/message persistence."

**Files:**
- Modify: `server/src/services/agent-runtime-decisions.ts` (`createPrompt` insert object ~lines 468, 478)
- Test: `server/src/__tests__/agent-runtime-decisions.test.ts`

- [ ] **Step 1: Write failing redaction tests**

```typescript
it("redacts toolName and adapterSessionParams before persistence", async () => {
  const { service, repo } = makeService();
  await service.createPrompt({
    companyId: "company-1", agentId: "agent-1",
    runId: "11111111-1111-4111-8111-111111111111",
    adapterType: "claude_local", kind: "permission", nonce: "nonce-r",
    title: "Allow?", timeoutPolicy: "deny",
    toolName: "shell sk-ant-abc123DEF456ghi789",
    adapterSessionParams: { token: "sk-ant-abc123DEF456ghi789", mode: "run" },
  });
  const arg = repo.createDecision.mock.calls[0][0];
  expect(arg.toolName).toBe("shell ***REDACTED***");
  expect(arg.adapterSessionParams).toEqual({ token: "***REDACTED***", mode: "run" });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run agent-runtime-decisions`
Expected: FAIL — `toolName`/`adapterSessionParams` currently pass through unredacted.

- [ ] **Step 3: Redact both fields in `createPrompt`**

In the `repo.createDecision({...})` insert object, change:

```typescript
adapterSessionParams: input.adapterSessionParams ?? null,
```
to
```typescript
adapterSessionParams: input.adapterSessionParams
  ? (redactJsonSecrets(input.adapterSessionParams) as Record<string, unknown>)
  : null,
```

and change:

```typescript
toolName: input.toolName ?? null,
```
to
```typescript
toolName: safeText(input.toolName),
```

(`safeText` and `redactJsonSecrets` are already defined in this file and use `redactSecretsInString`, marker `***REDACTED***`.)

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm test:run agent-runtime-decisions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/agent-runtime-decisions.ts server/src/__tests__/agent-runtime-decisions.test.ts
git commit -m "fix(w5a): redact toolName and adapterSessionParams before persistence"
```

---

## Task 4: Sweep ordering + bounded drain

Task 2 already added the per-row `runCanceller` try/catch and the `processed` counter. This task adds a stable order to the due-list query and makes the `index.ts` sweep drain multiple batches per tick (bounded), so a backlog over 100 due prompts is not starved.

**Files:**
- Modify: `server/src/services/agent-runtime-decisions.ts` (`realRepo.listDueForExpiry` ~line 400, add `asc` import ~line 2)
- Modify: `server/src/index.ts` (sweep tick ~line 1058)
- Test: `server/src/__tests__/agent-runtime-decisions.test.ts`

- [ ] **Step 1: Write failing test for drain semantics of `expireDuePrompts` return**

```typescript
it("reports processed count for drain control", async () => {
  const rows = Array.from({ length: 3 }, (_, i) =>
    baseDecision({ id: `due-${i}`, status: "shown", timeoutPolicy: "cancel_run", sourceRevision: 1 }),
  );
  const { service } = makeService({
    listDueForExpiry: vi.fn(async () => rows),
    updateDecision: vi.fn(async (_id, patch) => baseDecision(patch as Record<string, unknown>)),
  });
  const result = await service.expireDuePrompts({ limit: 100 });
  expect(result.processed).toBe(3);
});

it("keeps sweeping after runCanceller throws for one run", async () => {
  const rows = [
    baseDecision({ id: "due-0", status: "shown", timeoutPolicy: "cancel_run", sourceRevision: 1 }),
    baseDecision({ id: "due-1", status: "shown", timeoutPolicy: "cancel_run", sourceRevision: 1 }),
  ];
  const runCanceller = vi.fn(async ({ runId }: { runId: string }) => {
    if (runId === rows[0].runId) throw new Error("Heartbeat run not found");
  });
  const emit = vi.fn(async () => ({ id: "hub-1", version: 0 }));
  const { service } = makeService({
    listDueForExpiry: vi.fn(async () => rows),
    updateDecision: vi.fn(async (_id, patch) => baseDecision(patch as Record<string, unknown>)),
    // hubItems is passed separately; override via makeService below
  });
  // both rows still processed despite the throw
  const result = await service.expireDuePrompts({ limit: 100 });
  expect(result.processed).toBe(2);
});
```

(The second test relies on the injected `runCanceller`; extend `makeService` to accept `runCanceller` override — it already constructs one, so pass it through `repoOverrides`-style. If `makeService` does not currently forward a `runCanceller` override, add a second optional arg. See Step 3.)

- [ ] **Step 2: Run tests, verify they fail/error**

Run: `pnpm test:run agent-runtime-decisions`
Expected: FAIL — `result.processed` is undefined before Task 2's change is present; the throw test fails if try/catch is absent.

- [ ] **Step 3: Ensure `makeService` forwards a `runCanceller` override**

In the test harness `makeService` (top of the test file), change the signature to accept overrides for deps:

```typescript
function makeService(
  repoOverrides: Record<string, unknown> = {},
  depOverrides: { runCanceller?: (i: { companyId: string; runId: string; reason: string }) => Promise<void> } = {},
) {
  // ...existing repo/hubItems/activityLogger construction...
  const runCanceller = depOverrides.runCanceller ?? vi.fn(async () => {});
  const service = agentRuntimeDecisionService({} as never, {
    repo: repo as never, hubItems: hubItems as never, activityLogger, runCanceller, now,
  });
  return { service, repo, hubItems, activityLogger, runCanceller };
}
```

Update the throw test to pass the canceller: `makeService({ listDueForExpiry: ..., updateDecision: ... }, { runCanceller })`.

- [ ] **Step 4: Add `asc` order to `listDueForExpiry`**

In `server/src/services/agent-runtime-decisions.ts`, extend the drizzle import (line 2):

```typescript
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
```

In `realRepo.listDueForExpiry` (~line 400), add ordering before `.limit`:

```typescript
return db
  .select()
  .from(agentRuntimeDecisions)
  .where(and(...conditions))
  .orderBy(asc(agentRuntimeDecisions.expiresAt))
  .limit(input.limit);
```

- [ ] **Step 5: Make the `index.ts` sweep drain (bounded)**

In `server/src/index.ts`, replace the sweep interval body (~lines 1058–1075) with a bounded drain:

```typescript
const RUNTIME_DECISION_TIMEOUT_SWEEP_INTERVAL_MS = 30 * 1000;
const RUNTIME_DECISION_TIMEOUT_SWEEP_LIMIT = 100;
const RUNTIME_DECISION_TIMEOUT_SWEEP_MAX_BATCHES = 10; // <= 1000 rows/tick ceiling
let runtimeDecisionTimeoutSweepInFlight = false;
const runtimeDecisionTimeoutHeartbeat = heartbeatService(db as any);
setInterval(() => {
  if (runtimeDecisionTimeoutSweepInFlight) return;
  runtimeDecisionTimeoutSweepInFlight = true;
  void (async () => {
    const svc = agentRuntimeDecisionService(db as any, {
      runCanceller: async ({ runId }) => {
        await runtimeDecisionTimeoutHeartbeat.cancelRun(runId);
      },
    });
    for (let batch = 0; batch < RUNTIME_DECISION_TIMEOUT_SWEEP_MAX_BATCHES; batch++) {
      const { processed } = await svc.expireDuePrompts({ limit: RUNTIME_DECISION_TIMEOUT_SWEEP_LIMIT });
      if (processed < RUNTIME_DECISION_TIMEOUT_SWEEP_LIMIT) break;
    }
  })()
    .catch((err: unknown) => logger.warn({ err }, "runtime decision timeout sweep failed"))
    .finally(() => {
      runtimeDecisionTimeoutSweepInFlight = false;
    });
}, RUNTIME_DECISION_TIMEOUT_SWEEP_INTERVAL_MS);
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `pnpm test:run agent-runtime-decisions`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/agent-runtime-decisions.ts server/src/index.ts server/src/__tests__/agent-runtime-decisions.test.ts
git commit -m "fix(w5a): stable sweep ordering + bounded drain + resilient run cancellation"
```

---

## Task 5: Additive DB index for the global sweep

The timeout sweep queries `status IN (...) AND expires_at <= now` with no `company_id`, so the leading-`company_id` composite index cannot serve it. Add a dedicated `(status, expires_at)` index. Additive-only migration.

**Files:**
- Modify: `packages/db/src/schema/agent_runtime_decisions.ts` (index block)
- Generate: `packages/db/src/migrations/*` (via `pnpm db:generate`)
- Test: `packages/db/src/__tests__/agent-runtime-decisions-schema.test.ts` (NEW)

- [ ] **Step 1: Write failing schema/index test**

Create `packages/db/src/__tests__/agent-runtime-decisions-schema.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { agentRuntimeDecisions } from "../schema/agent_runtime_decisions.js";

describe("agent_runtime_decisions schema", () => {
  it("has a (status, expires_at) index for the global timeout sweep", () => {
    const cfg = getTableConfig(agentRuntimeDecisions);
    const names = cfg.indexes.map((i) => i.config.name);
    expect(names).toContain("agent_runtime_decisions_status_expiry_idx");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run agent-runtime-decisions-schema`
Expected: FAIL — index not defined yet.

- [ ] **Step 3: Add the index to the schema**

In `packages/db/src/schema/agent_runtime_decisions.ts`, inside the `agentRuntimeDecisions` table's index callback (after `companyAgentCreatedIdx`, before `sourceUniqueIdx`), add:

```typescript
    statusExpiryIdx: index("agent_runtime_decisions_status_expiry_idx").on(
      table.status,
      table.expiresAt,
    ),
```

(`index` is already imported in this file.)

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`
Expected: creates a new `packages/db/src/migrations/0163_*.sql` containing `CREATE INDEX IF NOT EXISTS "agent_runtime_decisions_status_expiry_idx" ...`, a new `meta/0163_snapshot.json`, and an appended `meta/_journal.json` entry. Confirm the `.sql` contains only the new index (no unexpected drops).

- [ ] **Step 5: Run tests, verify they pass**

Run: `pnpm test:run agent-runtime-decisions-schema`
Expected: PASS (new index test).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/agent_runtime_decisions.ts packages/db/src/migrations packages/db/src/__tests__/agent-runtime-decisions-schema.test.ts
git commit -m "fix(w5a): add (status, expires_at) index for the global timeout sweep"
```

---

## Task 6: Trust-rule integrity — atomic write, scope dedup, 90-day default expiry

`allow_always` currently writes the answer and the trust rule as two separate statements (half-apply risk), never expires (contradicts plan's "expiring"), and accumulates duplicate rules. Make answer+rule one transaction, dedup by scope (refresh expiry), and default to a 90-day expiry.

**Files:**
- Modify: `server/src/services/agent-runtime-decisions.ts` (imports; `DecisionRepo` type; `realRepo`; `answerPrompt`; `createTrustRule`; add `buildTrustRuleInsert` + `TRUST_RULE_DEFAULT_TTL_MS`)
- Test: `server/src/__tests__/agent-runtime-decisions.test.ts` (service, fake repo)
- Test: `server/src/__tests__/agent-runtime-decisions-realrepo.test.ts` (NEW — mock-db transaction/dedup)

- [ ] **Step 1: Write failing service tests (fake repo)**

In `makeService`, add to the fake `repo`:

```typescript
    answerWithTrustRule: vi.fn(async (_id, patch) => ({
      decision: baseDecision(patch as Record<string, unknown>),
      rule: baseTrustRule(),
    })),
```

Then add:

```typescript
it("allow_always answers + creates a 90-day trust rule atomically", async () => {
  const row = baseDecision({ status: "shown", kind: "permission", sourceRevision: 2, riskClass: "medium" });
  const answerWithTrustRule = vi.fn(async (_id, patch) => ({
    decision: baseDecision(patch as Record<string, unknown>),
    rule: baseTrustRule(),
  }));
  const { service } = makeService({ getDecision: vi.fn(async () => row), answerWithTrustRule });
  await service.answerPrompt({
    companyId: "company-1", decisionId: row.id, actorUserId: "founder-1",
    expectedSourceRevision: 2, nonce: "nonce-1", kind: "permission", decision: "allow_always",
  });
  const trustArg = answerWithTrustRule.mock.calls[0][3];
  expect(trustArg).toEqual(expect.objectContaining({
    companyId: "company-1", adapterType: "claude_local", riskClass: "medium", enabled: true,
    expiresAt: new Date("2026-09-29T12:00:00.000Z"), // now (2026-07-01 12:00) + 90 days
  }));
});

it("does not use the transactional path for allow_once / deny", async () => {
  const row = baseDecision({ status: "shown", kind: "permission", sourceRevision: 2 });
  const answerWithTrustRule = vi.fn();
  const updateDecision = vi.fn(async (_id, patch) => baseDecision(patch as Record<string, unknown>));
  const { service } = makeService({ getDecision: vi.fn(async () => row), answerWithTrustRule, updateDecision });
  await service.answerPrompt({
    companyId: "company-1", decisionId: row.id, actorUserId: "founder-1",
    expectedSourceRevision: 2, nonce: "nonce-1", kind: "permission", decision: "allow_once",
  });
  expect(answerWithTrustRule).not.toHaveBeenCalled();
  expect(updateDecision).toHaveBeenCalled();
});

it("surfaces trust-rule failure without emitting success (rollback)", async () => {
  const row = baseDecision({ status: "shown", kind: "permission", sourceRevision: 2 });
  const answerWithTrustRule = vi.fn(async () => { throw new Error("insert failed"); });
  const { service, hubItems } = makeService({ getDecision: vi.fn(async () => row), answerWithTrustRule });
  await expect(service.answerPrompt({
    companyId: "company-1", decisionId: row.id, actorUserId: "founder-1",
    expectedSourceRevision: 2, nonce: "nonce-1", kind: "permission", decision: "allow_always",
  })).rejects.toThrow("insert failed");
  expect(hubItems.emit).not.toHaveBeenCalled();
});
```

**Also rewrite the existing allow_always test** at `agent-runtime-decisions.test.ts:521-576` ("answers permission prompts by moving to answered with incremented source revision"). Today it answers with `decision: "allow_always"` on the default `makeService()` and asserts BOTH `repo.updateDecision` AND `repo.createTrustRule` were called. After this task, `allow_always` routes through `repo.answerWithTrustRule`, so those two assertions must change to assert `answerWithTrustRule` was called with the answer patch + the `buildTrustRuleInsert` output (and that `updateDecision`/`createTrustRule` are NOT called on the allow_always path). Leave the `allow_once`/`deny` assertions (which still use `updateDecision`) intact.

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm test:run agent-runtime-decisions`
Expected: FAIL — `answerWithTrustRule` not yet on the repo/used by the service; the rewritten existing test also fails until Step 5.

- [ ] **Step 3: Add imports + constant + builder**

Extend the drizzle import to include `isNull`:

```typescript
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
```

Add near the TTL constants (Task 1):

```typescript
const TRUST_RULE_DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function buildTrustRuleInsert(
  row: AgentRuntimeDecisionRow,
  actorUserId: string,
  nowDate: Date,
): typeof agentRuntimeTrustRules.$inferInsert {
  return {
    companyId: row.companyId,
    agentId: row.agentId,
    adapterType: row.adapterType,
    toolName: row.toolName,
    commandHash: row.commandHash,
    pathScope: row.path,
    networkScope: row.networkTarget,
    riskClass: row.riskClass,
    enabled: true,
    expiresAt: new Date(nowDate.getTime() + TRUST_RULE_DEFAULT_TTL_MS),
    createdByUserId: actorUserId,
  };
}
```

- [ ] **Step 4: Add `answerWithTrustRule` to the repo interface + realRepo**

In the `DecisionRepo` type, add:

```typescript
  answerWithTrustRule(
    decisionId: string,
    patch: Partial<typeof agentRuntimeDecisions.$inferInsert>,
    guard: { sourceRevision: number; statuses: RuntimeDecisionStatus[] },
    trustRule: typeof agentRuntimeTrustRules.$inferInsert,
  ): Promise<{ decision: AgentRuntimeDecisionRow | null; rule: AgentRuntimeTrustRuleRow | null }>;
```

In `realRepo`, add the method:

```typescript
    async answerWithTrustRule(decisionId, patch, guard, trustRule) {
      return db.transaction(async (tx) => {
        const conditions = [
          eq(agentRuntimeDecisions.id, decisionId),
          eq(agentRuntimeDecisions.sourceRevision, guard.sourceRevision),
          inArray(agentRuntimeDecisions.status, guard.statuses),
        ];
        const [decision] = await tx
          .update(agentRuntimeDecisions)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(...conditions))
          .returning();
        if (!decision) return { decision: null, rule: null };
        const scopeConds = [
          eq(agentRuntimeTrustRules.companyId, trustRule.companyId),
          eq(agentRuntimeTrustRules.adapterType, trustRule.adapterType),
          eq(agentRuntimeTrustRules.enabled, true),
          trustRule.agentId ? eq(agentRuntimeTrustRules.agentId, trustRule.agentId) : isNull(agentRuntimeTrustRules.agentId),
          trustRule.toolName ? eq(agentRuntimeTrustRules.toolName, trustRule.toolName) : isNull(agentRuntimeTrustRules.toolName),
          trustRule.commandHash ? eq(agentRuntimeTrustRules.commandHash, trustRule.commandHash) : isNull(agentRuntimeTrustRules.commandHash),
          trustRule.pathScope ? eq(agentRuntimeTrustRules.pathScope, trustRule.pathScope) : isNull(agentRuntimeTrustRules.pathScope),
          trustRule.networkScope ? eq(agentRuntimeTrustRules.networkScope, trustRule.networkScope) : isNull(agentRuntimeTrustRules.networkScope),
          trustRule.riskClass ? eq(agentRuntimeTrustRules.riskClass, trustRule.riskClass) : isNull(agentRuntimeTrustRules.riskClass),
        ];
        const [existing] = await tx
          .select()
          .from(agentRuntimeTrustRules)
          .where(and(...scopeConds))
          .limit(1);
        let rule: AgentRuntimeTrustRuleRow;
        if (existing) {
          [rule] = await tx
            .update(agentRuntimeTrustRules)
            .set({ expiresAt: trustRule.expiresAt, enabled: true, updatedAt: new Date() })
            .where(eq(agentRuntimeTrustRules.id, existing.id))
            .returning();
        } else {
          [rule] = await tx.insert(agentRuntimeTrustRules).values(trustRule).returning();
        }
        return { decision, rule };
      });
    },
```

- [ ] **Step 5: Rewrite the `answerPrompt` allow_always branch**

After `assertAnswerMatches(row, input)` and the existing `allow_always` concrete-scope check, replace the single answer `repo.updateDecision(...)` write and the trailing post-emit `if (... allow_always) { await createTrustRule(...) }` block with:

```typescript
    const answerPatch: Partial<typeof agentRuntimeDecisions.$inferInsert> = {
      status: "answered",
      decision: input.kind === "permission" ? input.decision : null,
      answerPayload: input.kind === "work_question" ? input.answer : null,
      answerIdempotencyKey: input.idempotencyKey ?? null,
      answeredByUserId: input.actorUserId,
      answeredAt: now(),
      sourceRevision: row.sourceRevision + 1,
    };
    const guard = {
      sourceRevision: row.sourceRevision,
      statuses: ["created", "shown", "relay_failed"] as RuntimeDecisionStatus[],
    };

    let answered: AgentRuntimeDecisionRow | null;
    if (input.kind === "permission" && input.decision === "allow_always") {
      const trustRule = buildTrustRuleInsert(row, input.actorUserId, now());
      const result = await repo.answerWithTrustRule(row.id, answerPatch, guard, trustRule);
      answered = result.decision;
      if (answered && result.rule) {
        await activityLogger({
          companyId: input.companyId,
          actorType: "user",
          actorId: input.actorUserId,
          action: "runtime_decision_trust_rule.created",
          entityType: "agent_runtime_trust_rule",
          entityId: result.rule.id,
          details: {
            agentId: result.rule.agentId,
            adapterType: result.rule.adapterType,
            toolName: result.rule.toolName,
            pathScope: result.rule.pathScope,
            networkScope: result.rule.networkScope,
            riskClass: result.rule.riskClass,
            expiresAt: result.rule.expiresAt?.toISOString() ?? null,
          },
        });
      }
    } else {
      answered = await repo.updateDecision(row.id, answerPatch, guard);
    }
    if (!answered) throw conflict("Runtime decision prompt was already answered");
    await activityLogger({
      companyId: row.companyId,
      actorType: "user",
      actorId: input.actorUserId,
      action: "runtime_decision.answered",
      entityType: "agent_runtime_decision",
      entityId: row.id,
      agentId: row.agentId,
      runId: row.runId,
      details: {
        kind: row.kind,
        decision: input.kind === "permission" ? input.decision : null,
        sourceRevision: row.sourceRevision,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });
    await emitHubItem(answered);
    return answered;
```

(Delete the old **pre-`emitHubItem`** `allow_always` `createTrustRule` block — on the branch it sits at `agent-runtime-decisions.ts:629-641`, immediately *before* `await emitHubItem(answered)`, not after it. The rewrite preserves the rollback-before-emit invariant because `answerWithTrustRule` runs before the emit.)

- [ ] **Step 6: Apply the 90-day default in standalone `createTrustRule` too**

In `createTrustRule`, change the `expiresAt` line from `expiresAt: input.expiresAt ?? null,` to:

```typescript
      expiresAt: input.expiresAt ?? new Date(now().getTime() + TRUST_RULE_DEFAULT_TTL_MS),
```

If an existing test asserts a null `expiresAt` for `createTrustRule`, update it to expect `now()+90d`.

- [ ] **Step 7: Write the realRepo transaction/dedup coverage**

Create `server/src/__tests__/agent-runtime-decisions-realrepo.test.ts`. Prefer an integration test against embedded Postgres (reuse `tests/e2e/helpers/seed-runtime-decision.ts` patterns): answer a permission prompt with `allow_always` **twice** for the same scope, then assert exactly one enabled `agent_runtime_trust_rules` row remains with a refreshed `expiresAt` (dedup + atomicity). If embedded PG is unavailable in the unit lane, write a mock-`db` transaction test following the `createSequenceDb` proxy pattern in `server/src/__tests__/aoa-runs-total.test.ts`, queuing results `[[decision], [], [rule]]` (insert path) and `[[decision], [existing], [updatedRule]]` (dedup path) and asserting the returned `rule.id`. Keep whichever reliably proves dedup + single-transaction commit.

- [ ] **Step 8: Run tests, verify they pass**

Run: `pnpm test:run agent-runtime-decisions`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/src/services/agent-runtime-decisions.ts server/src/__tests__/agent-runtime-decisions.test.ts server/src/__tests__/agent-runtime-decisions-realrepo.test.ts
git commit -m "fix(w5a): atomic allow_always answer + trust-rule dedup + 90-day default expiry"
```

---

## Task 7: Guard `createPrompt` against re-driving a consumed decision

When a duplicate `(company, run, nonce)` hits an already-terminal/answered row, the upsert `setWhere` blocks the update and the realRepo fallback SELECT returns the stale row. A freshly created prompt is always `status: "created"` (or `"answered"` only when a trust rule auto-approved it, which the service tracks via `matchingTrustRule`). So the service can detect and reject the stale-fallback case.

**Files:**
- Modify: `server/src/services/agent-runtime-decisions.ts` (`createPrompt` after `repo.createDecision`)
- Test: `server/src/__tests__/agent-runtime-decisions.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
it("rejects re-driving a consumed decision (stale upsert fallback)", async () => {
  const consumed = baseDecision({ status: "relayed", sourceRevision: 4 });
  const { service } = makeService({ createDecision: vi.fn(async () => consumed) });
  await expect(service.createPrompt({
    companyId: "company-1", agentId: "agent-1",
    runId: "11111111-1111-4111-8111-111111111111",
    adapterType: "claude_local", kind: "permission", nonce: "nonce-1",
    title: "Allow?", timeoutPolicy: "deny",
  })).rejects.toThrow(/already consumed/i);
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `pnpm test:run agent-runtime-decisions`
Expected: FAIL — current code emits a hub item for the stale row and returns it.

- [ ] **Step 3: Add the guard in `createPrompt`**

Immediately after `const created = await repo.createDecision({...});` and before the `if (matchingTrustRule) { ... }` / `emitHubItem` lines, add:

```typescript
    if (!matchingTrustRule && created.status !== "created") {
      throw conflict("Runtime decision prompt already consumed for this nonce");
    }
```

**Also fix two existing db-mock `createPrompt` tests** that this guard would break: `agent-runtime-decisions.test.ts:221` ("guards nonce replay upserts…") and `:267` ("bumps the source revision…"). Both stub `onConflictDoUpdate(...).returning()` to resolve a row with `status: "shown"`, which trips the new guard. On the real branch the upsert `set.status` is `input.status` (`"created"`) on a refresh, so update those two mock `returning()` stubs to resolve `status: "created"` — this makes the mocks match real upsert behavior and keeps the tests green.

- [ ] **Step 4: Run test, verify it passes**

Run: `pnpm test:run agent-runtime-decisions`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/agent-runtime-decisions.ts server/src/__tests__/agent-runtime-decisions.test.ts
git commit -m "fix(w5a): reject re-driving a consumed runtime decision on nonce reuse"
```

---

## Task 8: Cleanups — reconciler DRY, UI nit, document dead status

**Files:**
- Modify: `server/src/services/hub-items.ts` (`reconcileRuntimeDecision`)
- Modify: `ui/src/components/hub/HubViewer.tsx`
- Modify: `packages/shared/src/hub.ts` (comment on `"shown"`)
- Test: `server/src/__tests__/hub-items-runtime-decision-reconcile.test.ts`, `ui/src/components/hub/__tests__/HubShell.test.tsx`

- [ ] **Step 1: Write failing reconciler-delegation test**

In `server/src/__tests__/hub-items-runtime-decision-reconcile.test.ts`, add a case asserting the reconciler output equals `runtimeDecisionSourceSnapshot` for a parked timeout follow-up (the branch most likely to drift), reusing the file's existing db-stub pattern for the `agentRuntimeDecisions` select:

```typescript
it("reconciler matches runtimeDecisionSourceSnapshot for parked timeouts", async () => {
  const row = baseDecision({ status: "cancelled", timeoutPolicy: "park_run", relayError: "timeout policy parked the run" });
  const expected = runtimeDecisionSourceSnapshot(row as never);
  const actual = await reconcileRuntimeDecisionFor(row); // helper that stubs db to return `row`
  expect(actual).toEqual(expected);
});
```

(`runtimeDecisionSourceSnapshot` is exported from the service.)

- [ ] **Step 2: Run test, verify it fails or is unstable**

Run: `pnpm test:run hub-items-runtime-decision-reconcile`
Expected: FAIL/unstable — confirms the two paths are separate implementations.

- [ ] **Step 3: Delegate the reconciler to the shared snapshot**

In `server/src/services/hub-items.ts`, import the snapshot with the other service imports:

```typescript
import { runtimeDecisionSourceSnapshot } from "./agent-runtime-decisions.js";
```

Replace the body of `reconcileRuntimeDecision` so it selects the full row and delegates:

```typescript
  const reconcileRuntimeDecision: SourceReconciler = async (companyId, sourceId) => {
    const row = await db
      .select()
      .from(agentRuntimeDecisions)
      .where(and(eq(agentRuntimeDecisions.id, sourceId), eq(agentRuntimeDecisions.companyId, companyId)))
      .limit(1)
      .then((r) => r[0] ?? null);
    return runtimeDecisionSourceSnapshot(row);
  };
```

- [ ] **Step 4: Fix the UI `disabled` readability nit**

In `ui/src/components/hub/HubViewer.tsx`, replace:

```typescript
  const disabled = answerMutation.isPending || detail.status !== "created" && detail.status !== "shown" && detail.status !== "relay_failed";
```
with:
```typescript
  const disabled =
    answerMutation.isPending ||
    (detail.status !== "created" && detail.status !== "shown" && detail.status !== "relay_failed");
```

- [ ] **Step 5: Add a UI test asserting controls disable on a terminal status**

In the runtime-decision panel test (`ui/src/components/hub/__tests__/HubShell.test.tsx` or the file that already renders the panel), add a case rendering the panel with `detail.status = "relayed"` and asserting the Allow/Deny buttons are `disabled`. Follow the file's existing render + query-client mock pattern.

- [ ] **Step 6: Document the reserved `"shown"` status**

In `packages/shared/src/hub.ts`, above `RUNTIME_DECISION_STATUSES`, add:

```typescript
// NOTE: "shown" is reserved for W5b founder-seen tracking. W5a never sets it
// (no adapter bridge marks a prompt as shown yet); it stays in the enum so the
// contract is stable when W5b wires it. Do not remove without updating guards.
```

- [ ] **Step 7: Run tests, verify they pass**

Run: `pnpm test:run hub-items-runtime-decision-reconcile`
Run: `pnpm test:run HubShell`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/services/hub-items.ts ui/src/components/hub/HubViewer.tsx packages/shared/src/hub.ts server/src/__tests__/hub-items-runtime-decision-reconcile.test.ts ui/src/components/hub/__tests__/HubShell.test.tsx
git commit -m "refactor(w5a): DRY hub reconciler, UI disabled nit, document reserved shown status"
```

---

## Task 9: Full verification + push

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole repo**

Run: `pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 2: Full unit/integration suite**

Run: `pnpm test:run`
Expected: PASS. Compare pass/skip counts to the PR baseline (1274 files / 10744 tests passed pre-change).

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: PASS (existing large-chunk warnings only).

- [ ] **Step 4: Focused e2e (Windows dev)**

Run: `AOA_E2E_FORCE_WINDOWS=1 pnpm test:e2e inbox-hub-runtime-decisions.spec.ts`
Expected: PASS — the answer→relay→resolve happy path is unchanged.

- [ ] **Step 5: Migration apply check**

Run the repo's migrations gate (e.g. `pnpm --filter @armyofagents/db test:run` plus the CI `migrations` job locally if available).
Expected: PASS — new `0163` index migration applies cleanly.

- [ ] **Step 6: Commit the plan doc + push the branch**

```bash
git add docs/aoa/plans/2026-07-02-w5a-hardening-plan.md
git commit -m "docs(w5a): add hardening remediation plan"
git push origin codex/w5-runtime-decision-routing
```

Confirm PR #259 shows the new commits and CI re-runs green before requesting third-party (Codex/Greptile) review.

---

## Self-Review

**Spec coverage** (every design unit maps to a task):
Expiry SLA → Task 1. `continue_with_default` + default policy → Task 2. Redaction → Task 3. Sweep resilience (try/catch) → Task 2; ordering/drain → Task 4. DB index → Task 5. Trust-rule tx/dedup/90d → Task 6. Replay guard → Task 7. Reconciler DRY + UI nit + reserved `shown` → Task 8. Verification → Task 9. RBAC: unchanged (founder-only, by design) — no task.

**Placeholder scan:** one intentional soft spot — Task 6 Step 7 offers integration-vs-mock realRepo coverage because a private-repo method is awkward to unit test; the service-level tests (Step 1) are the binding contract. Every other step has concrete code + commands.

**Type consistency:** `defaultTimeoutPolicy(kind)` (Task 1) consumed in Task 2 fallback + heartbeat broker. `buildTrustRuleInsert` returns `agentRuntimeTrustRules.$inferInsert`, matching `answerWithTrustRule`'s param. `expireDuePrompts` returns `{ expired, processed }` (Task 2) consumed by the drain loop (Task 4). `TimeoutOutcome`/`timeoutOutcome` defined once (Task 2), used only in `expireDuePrompts`.

**Scope guard:** no adapter bridge, no feature flag, no RBAC change. Inert-but-correct preserved.

**Independent eng review (2026-07-02):** verdict `needs-fixes → resolved`. Two blockers folded in — Task 6 rewrites the existing allow_always assertion (`updateDecision`+`createTrustRule` → `answerWithTrustRule`), Task 7 fixes two db-mock `createPrompt` stubs that returned `status:"shown"` (→ `"created"`, matching real upsert `set.status`). Pre/post-emit wording and the schema-test filename were corrected. Reviewer confirmed all proposed code compiles and every other existing timeout/broker/redaction test stays green under the refactor. Cited line numbers in task bodies are approximate (file is ~830 lines); anchor on the named code, not the numbers.
