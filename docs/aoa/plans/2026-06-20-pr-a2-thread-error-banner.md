# PR-A2 — Thread error banner Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax. TDD throughout. Spec: `docs/aoa/plans/2026-06-20-pr-a2-thread-error-banner-design.md`.

**Goal:** Surface a thread's coordination-level `lastError` to the founder as a self-clearing banner in the thread header.

**Architecture:** Backend adds the orchestration `lastError` + `consecutiveCommitFailures` to the existing `discussionService.getById` response (one small read, no schema change). Frontend adds those fields to the `DiscussionDetail` type and renders a new `ThreadErrorBanner` (mirroring `TranscriptErrorBlock`) in the thread header; it shows only when `lastError` is set and self-clears (the controller nulls `lastError` on the next success).

**Tech Stack:** Express + Drizzle (server), React + Vite + Tailwind (ui), Vitest + @testing-library/react (ui unit), embedded-postgres in node:24 Docker (server integration), Playwright (e2e).

**Test-design note:** `getById` runs ~7 DB queries; a mock-DB *unit* test would be brittle and low-value. The backend change is verified at the **integration** layer (real Postgres). The UI component is unit-tested; the wiring is e2e-tested. That's unit + integration + e2e coverage, by the right layer.

---

## File Structure

- **Modify** `server/src/services/discussions.ts` — `getById` (~`:450-637`): add an orchestration read + two return fields.
- **Modify** `ui/src/api/discussions.ts` — `DiscussionDetail` (`:125-142`): add `lastError`, `consecutiveCommitFailures`.
- **Create** `ui/src/components/threads/ThreadErrorBanner.tsx` — the banner (mirrors `TranscriptErrorBlock`).
- **Modify** `ui/src/pages/ThreadDetail.tsx` — render the banner in `thread-center-header` (~`:1102`).
- **Create** `ui/src/components/threads/ThreadErrorBanner.test.tsx` — UI unit test.
- **Create** `server/src/__tests__/discussion-detail-lasterror.integration.test.ts` — real-DB test.
- **Create** `tests/e2e/thread-error-banner.spec.ts` — e2e.

---

## Task 1: Backend — `getById` returns `lastError`

**Files:**
- Modify: `server/src/services/discussions.ts:450-637`
- Test: `server/src/__tests__/discussion-detail-lasterror.integration.test.ts`

- [ ] **Step 1: Write the failing integration test.** Copy the embedded-postgres harness setup from `server/src/__tests__/thread-commit-idempotency.integration.test.ts` (the `beforeAll`/`afterAll` block that boots embedded-pg, runs `applyPendingMigrations`, seeds a company; reuse `createDb`, `companyService`, `rowsOf`). Then:

```ts
it("getById surfaces the thread's orchestration lastError, and null when cleared", async () => {
  if (setupError) throw new Error(String(setupError));
  const svc = discussionService(db);
  const [d] = rowsOf(await db.execute(sql`
    INSERT INTO discussions (id, company_id, status, created_by)
    VALUES (gen_random_uuid(), ${companyId}, 'active', 'integration-test') RETURNING id`));
  const threadId = String(d.id);

  // No orchestration row yet → lastError is null.
  const before = await svc.getById(companyId, threadId);
  expect(before?.lastError ?? null).toBeNull();

  // Controller recorded an error.
  await db.execute(sql`
    INSERT INTO thread_orchestration_state (thread_id, pending_run, last_error, consecutive_commit_failures)
    VALUES (${threadId}, false, 'action_commit_failed_skipped: boom', 2)`);
  const withErr = await svc.getById(companyId, threadId);
  expect(withErr?.lastError).toBe("action_commit_failed_skipped: boom");
  expect(withErr?.consecutiveCommitFailures).toBe(2);

  // Recovered → cleared.
  await db.execute(sql`UPDATE thread_orchestration_state SET last_error = NULL WHERE thread_id = ${threadId}`);
  const cleared = await svc.getById(companyId, threadId);
  expect(cleared?.lastError ?? null).toBeNull();
});
```

Import `discussionService` from `../services/discussions.js`.

- [ ] **Step 2: Run it in Docker, verify it FAILS** (the field doesn't exist yet):
```bash
docker compose run ... npx vitest run src/__tests__/discussion-detail-lasterror.integration.test.ts
```
Expected: FAIL — `withErr?.lastError` is `undefined`.

- [ ] **Step 3: Implement.** In `discussions.ts`, ensure `threadOrchestrationState` is imported from `@armyofagents/db` (and `eq` from `drizzle-orm` — already used). In `getById`, just before the `return { ...discussion, ... }` (~`:626`), add:

```ts
      const [orch] = await db
        .select({
          lastError: threadOrchestrationState.lastError,
          consecutiveCommitFailures: threadOrchestrationState.consecutiveCommitFailures,
        })
        .from(threadOrchestrationState)
        .where(eq(threadOrchestrationState.threadId, id))
        .limit(1);
```

and add to the returned object (alongside `derivedStage`):

```ts
        lastError: orch?.lastError ?? null,
        consecutiveCommitFailures: orch?.consecutiveCommitFailures ?? 0,
```

- [ ] **Step 4: Run in Docker, verify PASS.** Same command. Expected: PASS.

- [ ] **Step 5: Commit.**
```bash
git add server/src/services/discussions.ts server/src/__tests__/discussion-detail-lasterror.integration.test.ts
git commit -m "feat(threads): expose orchestration lastError on getById (PR-A2)"
```

---

## Task 2: UI — type + `ThreadErrorBanner` component

**Files:**
- Modify: `ui/src/api/discussions.ts:125-142`
- Create: `ui/src/components/threads/ThreadErrorBanner.tsx`
- Test: `ui/src/components/threads/ThreadErrorBanner.test.tsx`

- [ ] **Step 1: Add the type fields.** In `DiscussionDetail` (after `derivedStage?: ThreadDerivedStage;`, `:141`):
```ts
  lastError?: string | null;
  consecutiveCommitFailures?: number;
```

- [ ] **Step 2: Write the failing UI unit test** `ThreadErrorBanner.test.tsx` (mirror `ui/src/components/commander/cockpit/CockpitApprovalsCard.test.tsx`):
```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("renders nothing when error is null", () => {
    const { container } = render(<ThreadErrorBanner error={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when error is empty", () => {
    const { container } = render(<ThreadErrorBanner error="" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the friendly headline and reveals the raw error on expand", () => {
    render(<ThreadErrorBanner error={"action_commit_failed_skipped: boom"} consecutiveFailures={3} />);
    expect(screen.getByTestId("thread-error-banner")).toBeInTheDocument();
    expect(screen.getByText(/didn't go through/i)).toBeInTheDocument();
    // raw error hidden until expanded
    expect(screen.queryByText(/action_commit_failed_skipped/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(screen.getByText(/action_commit_failed_skipped: boom/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it, verify FAILS** (component doesn't exist):
```bash
cd ui && npx vitest run src/components/threads/ThreadErrorBanner.test.tsx
```
Expected: FAIL — cannot resolve `./ThreadErrorBanner`.

- [ ] **Step 4: Implement the component** `ui/src/components/threads/ThreadErrorBanner.tsx` (mirrors `TranscriptErrorBlock`):
```tsx
import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ChevronDown, AlertCircle } from "lucide-react";

interface ThreadErrorBannerProps {
  error: string | null | undefined;
  consecutiveFailures?: number;
  className?: string;
}

export function ThreadErrorBanner({ error, consecutiveFailures, className }: ThreadErrorBannerProps) {
  const [expanded, setExpanded] = useState(false);
  if (!error) return null;

  return (
    <div
      data-testid="thread-error-banner"
      className={cn("border-l-2 border-l-red-500 bg-red-500/5 rounded-r-lg my-2 px-3 py-2", className)}
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">An agent action on this thread didn't go through</div>
          <div className="text-xs text-muted-foreground mt-0.5">
            The coordinator retried and paused after repeated failures. It will resume automatically on the next run.
          </div>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-1.5 flex items-center gap-1 text-xs text-red-500/80"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Show details
          </button>
          {expanded && (
            <div className="mt-1.5 font-mono text-[11.5px] text-red-400/80 bg-muted rounded px-2 py-1.5 max-h-[200px] overflow-auto whitespace-pre-wrap">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```
(`consecutiveFailures` is accepted for future detail but not rendered now — YAGNI; remove the prop if lint flags it unused, or prefix `_`.)

- [ ] **Step 5: Run the test, verify PASS.** Same command. Expected: PASS (3 tests).

- [ ] **Step 6: Commit.**
```bash
git add ui/src/api/discussions.ts ui/src/components/threads/ThreadErrorBanner.tsx ui/src/components/threads/ThreadErrorBanner.test.tsx
git commit -m "feat(threads): ThreadErrorBanner component + DiscussionDetail.lastError (PR-A2)"
```

---

## Task 3: UI — render the banner in the thread header

**Files:**
- Modify: `ui/src/pages/ThreadDetail.tsx` (~`:1102`, inside `data-testid="thread-center-header"`)

- [ ] **Step 1: Import** at the top of `ThreadDetail.tsx`:
```ts
import { ThreadErrorBanner } from "@/components/threads/ThreadErrorBanner";
```

- [ ] **Step 2: Render** immediately after the title/controls row closes (~`:1102`), before the "Scoped to" meta (the thread detail object is `data`/`thread` in scope — use the variable the file already uses for the loaded detail; it has `.lastError` now):
```tsx
        <ThreadErrorBanner error={thread.lastError} consecutiveFailures={thread.consecutiveCommitFailures} />
```
(Match the existing local variable name for the loaded thread detail — confirm whether it's `thread`, `data`, or `detail` at that scope and use it.)

- [ ] **Step 3: Type-check + build.**
```bash
cd ui && npx tsc --noEmit && npm run build
```
Expected: clean.

- [ ] **Step 4: Commit.**
```bash
git add ui/src/pages/ThreadDetail.tsx
git commit -m "feat(threads): render ThreadErrorBanner in the thread header (PR-A2)"
```

---

## Task 4: E2E — banner appears for a thread with an error

**Files:**
- Create: `tests/e2e/thread-error-banner.spec.ts`

- [ ] **Step 1: Write the spec** (mirror an existing thread/discussion spec's setup — auth + seed). Seed a discussion + a `thread_orchestration_state` row with `last_error` set (via the test DB helper used by other e2e specs), open the thread, assert the banner:
```ts
import { test, expect } from "@playwright/test";
// reuse the e2e auth/seed helpers used by other specs in tests/e2e/

test("thread with a coordination error shows the error banner", async ({ page }) => {
  // 1. seed: a discussion + thread_orchestration_state.last_error = 'boom...' (via the e2e seed helper / API)
  // 2. navigate to the thread detail page
  // 3. assert:
  await expect(page.getByTestId("thread-error-banner")).toBeVisible();
  await page.getByRole("button", { name: /details/i }).click();
  await expect(page.getByText(/boom/)).toBeVisible();
});

test("a clean thread shows no error banner", async ({ page }) => {
  // seed a clean discussion (no orchestration error), open it
  await expect(page.getByTestId("thread-error-banner")).toHaveCount(0);
});
```
> Fill the seed/auth from the closest existing spec (e.g. `tests/e2e/commander-error-states.spec.ts` for the error-state pattern, and a discussion/thread spec for the thread-detail navigation). E2E is **skipped on Windows in CI** (project setup) — write it; it runs on Linux CI.

- [ ] **Step 2: Run locally if a browser is available** (`npx playwright test tests/e2e/thread-error-banner.spec.ts`), else rely on Linux CI. Expected: both assertions pass.

- [ ] **Step 3: Commit.**
```bash
git add tests/e2e/thread-error-banner.spec.ts
git commit -m "test(e2e): thread error banner visibility (PR-A2)"
```

---

## Task 5: Full verification + push

- [ ] **Step 1: Backend** — Docker integration (Task 1's test) green; `tsc --noEmit` (server) clean.
- [ ] **Step 2: UI** — `cd ui && npx vitest run src/components/threads/ThreadErrorBanner.test.tsx` green; `tsc --noEmit` + `npm run build` clean.
- [ ] **Step 3: Push** the branch and open the PR (base `feat/v1-combined`), title `feat(threads): PR-A2 — thread error banner (lastError UI surface)`. Include the design doc reference.

---

## Self-Review

- **Spec coverage:** backend exposure → Task 1; type + component → Task 2; placement → Task 3; e2e → Task 4; all four test layers present (integration T1, unit T2, e2e T4; server-unit deliberately omitted per the test-design note). Self-clearing is inherent (controller nulls `lastError`; banner returns null) — covered by Task 1's "cleared → null" assertion + Task 2's "null → renders nothing".
- **Type consistency:** `lastError?: string | null` and `consecutiveCommitFailures?: number` are added in Task 2 (UI type) and produced in Task 1 (server return) with matching names; `ThreadErrorBanner` prop is `error` (matches `thread.lastError`) + `consecutiveFailures` (matches `thread.consecutiveCommitFailures`).
- **Placeholder scan:** the only soft spots are intentional "match the existing local variable name" (T3) and "fill seed/auth from the closest existing spec" (T4) — both are because the exact local identifier / e2e seed helper must be read at execution time; every code block is otherwise complete and copy-ready.
