# NewIssueDialog: Stale-Draft Sanitization + Error Toast

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the New Task modal from silently failing when its persisted draft references a deleted agent/project, and surface any future create-task error to the user.

**Architecture:** Two surgical changes in `ui/src/components/NewIssueDialog.tsx`, supported by one new pure helper in `ui/src/lib/issueDraft.ts`:
1. After the agents and projects queries resolve, prune any rehydrated `assigneeId` / `projectId` whose target entity no longer exists. Done in a second `useEffect` that depends on the loaded query data — the existing rehydration `useEffect` keeps its current responsibility.
2. Add `onError` to the `createIssue` mutation so failures surface as a toast with `tone: "error"` (the toast API and `useToast` hook are already imported in the file).

**Tech Stack:** React 18, `@tanstack/react-query`, Vitest + `@testing-library/react`, `useToast` from `@/context/ToastContext`.

**Out of scope (deferred):**
- Server-side: making the issue-create route return a structured error body (currently 404 with no detail). The toast on the client will still work because `apiClient` rejects the promise on non-2xx responses, but a richer message would help. Note in PR description.
- Persisting *valid* draft state across DB nukes (won't fix — DB nuke is a dev-only operation).

---

## File Structure

| File | Status | Responsibility |
|------|--------|----------------|
| `ui/src/lib/issueDraft.ts` | **Create** | Export `pruneStaleId(id, validIds)` — pure helper that returns the id only if it's in the live set, otherwise `""`. |
| `ui/src/__tests__/issueDraft.test.ts` | **Create** | Unit tests for `pruneStaleId`. |
| `ui/src/components/NewIssueDialog.tsx` | **Modify** | Add `useEffect` that calls `pruneStaleId` against `agents` / `projects` once loaded. Add `onError` to the existing `createIssue` mutation. |

No new tests added at the component level — the failure mode is well covered by the pure helper plus a manual browser check. A full RTL test for the dialog would need to mock `useDialog`, `useCompany`, `useToast`, the two queries, and several other contexts the file already pulls in; the ROI is poor for this bug.

---

## Task 1: Pure helper with unit tests

**Files:**
- Create: `ui/src/lib/issueDraft.ts`
- Test:   `ui/src/__tests__/issueDraft.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/__tests__/issueDraft.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pruneStaleId } from "../lib/issueDraft";

describe("pruneStaleId", () => {
  const validIds = new Set(["agent-a", "agent-b"]);

  it("returns the id when it is in the valid set", () => {
    expect(pruneStaleId("agent-a", validIds)).toBe("agent-a");
  });

  it("returns empty string when the id is not in the valid set", () => {
    expect(pruneStaleId("agent-ghost", validIds)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(pruneStaleId("", validIds)).toBe("");
  });

  it("returns empty string for null input", () => {
    expect(pruneStaleId(null, validIds)).toBe("");
  });

  it("returns empty string for undefined input", () => {
    expect(pruneStaleId(undefined, validIds)).toBe("");
  });

  it("returns empty string when valid set is empty", () => {
    expect(pruneStaleId("agent-a", new Set<string>())).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/issueDraft.test.ts`

Expected: FAIL — module `../lib/issueDraft` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/lib/issueDraft.ts`:

```ts
/**
 * Returns `id` if it exists in `validIds`, otherwise `""`.
 *
 * Used when rehydrating persisted form drafts (e.g. from localStorage) to
 * drop references to entities that have since been deleted on the server.
 * Sending a stale foreign-key id otherwise produces an opaque 404 from the
 * create endpoint with no actionable error for the user.
 */
export function pruneStaleId(
  id: string | null | undefined,
  validIds: ReadonlySet<string>,
): string {
  if (!id) return "";
  return validIds.has(id) ? id : "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @armyofagents/ui exec vitest run src/__tests__/issueDraft.test.ts`

Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/issueDraft.ts ui/src/__tests__/issueDraft.test.ts
git commit -m "ui: add pruneStaleId helper for sanitizing rehydrated draft ids"
```

---

## Task 2: Use `pruneStaleId` in NewIssueDialog rehydration

**Files:**
- Modify: `ui/src/components/NewIssueDialog.tsx` (add import; add new `useEffect` after the existing rehydration block at lines 334–365)

- [ ] **Step 1: Add the import**

In `ui/src/components/NewIssueDialog.tsx`, find the existing imports near the top of the file and add:

```ts
import { pruneStaleId } from "../lib/issueDraft";
```

(Place it next to other `../lib/...` imports. The exact line will depend on the surrounding imports — keep alphabetical order if the file uses it.)

- [ ] **Step 2: Add the validation effect**

In `ui/src/components/NewIssueDialog.tsx`, immediately AFTER the closing `}, [newIssueOpen, newIssueDefaults]);` of the existing rehydration `useEffect` (currently around line 365), insert:

```tsx
  // Drop rehydrated assigneeId / projectId once we know the live agent &
  // project lists, in case the persisted draft was pointing at an entity
  // that has since been deleted (DB nuke, manual delete, etc).
  useEffect(() => {
    if (!newIssueOpen || !agents || !projects) return;
    const agentIds = new Set(agents.map((a) => a.id));
    const projectIds = new Set(projects.map((p) => p.id));
    setAssigneeId((prev) => pruneStaleId(prev, agentIds));
    setProjectId((prev) => pruneStaleId(prev, projectIds));
  }, [newIssueOpen, agents, projects]);
```

Notes:
- Use the functional form of `setAssigneeId` / `setProjectId` so `assigneeId` / `projectId` themselves don't need to be in the dependency list — that would cause the effect to re-run after each prune and is unnecessary.
- The effect short-circuits while `agents` or `projects` is `undefined` (queries still loading). It will run again automatically when the data arrives.

- [ ] **Step 3: Verify the type imports compile**

Run: `pnpm --filter @armyofagents/ui exec tsc --noEmit`

Expected: PASS — no type errors. (If `agents`/`projects` types complain about `.map((a) => a.id)`, consult the existing usage at `NewIssueDialog.tsx:228` which already does `(agents ?? []).find((agent) => agent.id === assigneeId)?.adapterType` and matches the same shape.)

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/NewIssueDialog.tsx
git commit -m "ui: prune stale assignee/project ids from rehydrated NewIssueDialog draft

Fixes silent 404 when localStorage draft references a deleted agent or
project. The two ids are now cleared when the live agents/projects
queries resolve and the rehydrated value isn't found."
```

---

## Task 3: Add `onError` toast to the create-issue mutation

**Files:**
- Modify: `ui/src/components/NewIssueDialog.tsx` (extend `useMutation` block at lines 265–283)

- [ ] **Step 1: Extend the mutation**

In `ui/src/components/NewIssueDialog.tsx`, replace the existing `createIssue` mutation (lines 265–283) with:

```tsx
  const createIssue = useMutation({
    mutationFn: ({ companyId, ...data }: { companyId: string } & Record<string, unknown>) =>
      issuesApi.create(companyId, data),
    onSuccess: (issue) => {
      newIssueDefaults.onCreated?.(issue);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(effectiveCompanyId!) });
      if (draftTimer.current) clearTimeout(draftTimer.current);
      clearDraft();
      reset();
      closeNewIssue();
      pushToast({
        dedupeKey: `activity:issue.created:${issue.id}`,
        title: `${issue.identifier ?? "Task"} created`,
        body: issue.title,
        tone: "success",
        action: {
          label: `View ${issue.identifier ?? "task"}`,
          href: `/issues/${issue.identifier ?? issue.id}`,
        },
      });
    },
    onError: (error: unknown) => {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Something went wrong. Please try again.";
      pushToast({
        title: "Couldn't create task",
        body: message,
        tone: "error",
      });
    },
  });
```

The only change vs. the current code is the new `onError` block — `mutationFn` and `onSuccess` are unchanged, copied verbatim above for grep-replace clarity.

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter @armyofagents/ui exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/NewIssueDialog.tsx
git commit -m "ui: surface create-task errors via toast in NewIssueDialog

Previously the createIssue mutation had no onError handler, so server
errors (e.g. 404 from a stale assigneeId FK) silently kept the modal
open with no feedback. Now they show as an error-tone toast."
```

---

## Task 4: Manual browser verification

**Files:** none (manual)

- [ ] **Step 1: Reload the running dev server**

The preview server is already up at `http://127.0.0.1:3100`. After Task 2 + Task 3 land, hard-reload the page in the preview browser to pick up the Vite HMR / fresh module graph.

- [ ] **Step 2: Verify stale-draft sanitization**

In the preview browser console:

```js
localStorage.setItem('paperclip:issue-draft', JSON.stringify({
  title: 'Stale draft test',
  description: 'should still submit',
  status: 'todo',
  priority: '',
  assigneeId: '00000000-0000-0000-0000-000000000000',
  projectId:  '00000000-0000-0000-0000-000000000001',
  assigneeModelOverride: '',
  assigneeThinkingEffort: '',
  assigneeChrome: false,
  assigneeUseProjectWorkspace: true,
}));
```

Then navigate to `/TES/projects/dev/issues`, click **+ New Task**, then click **Create Task**.

Expected:
- POST `/api/companies/<cid>/issues` returns **201**
- Modal closes
- Success toast: "TES-N created"
- Task appears on the Dev board

- [ ] **Step 3: Verify error toast on real failure**

To force a server error, override the project id with a guaranteed-bad UUID at submit time. In the preview console with the dialog open:

```js
// patch fetch once to swap projectId to a bogus uuid for the next POST
const orig = window.fetch;
window.fetch = function (url, init) {
  if (typeof url === 'string' && /\/issues$/.test(url) && init?.method === 'POST') {
    const body = JSON.parse(init.body);
    body.projectId = '00000000-0000-0000-0000-deadbeefdead';
    init = { ...init, body: JSON.stringify(body) };
    window.fetch = orig; // restore for next calls
  }
  return orig.apply(this, arguments);
};
```

Click Create Task.

Expected:
- POST returns 4xx (404 or 400)
- Modal **stays open** (so user can fix and retry)
- **Error-tone toast** appears with title "Couldn't create task" and a body message

- [ ] **Step 4: Document the result**

Add a short note to the PR description listing the two manual checks performed and their outcomes.

---

## Self-Review

Per the writing-plans skill, the following checks were performed against this plan:

**1. Spec coverage:**
- "Stop silent 404 from stale draft" → Tasks 1 + 2.
- "Surface create-task errors to the user" → Task 3.
- "Verify in browser" → Task 4.
No gaps.

**2. Placeholder scan:** No "TBD", "implement later", or "handle edge cases" without code. Every code step has the actual code or command to run.

**3. Type / name consistency:** `pruneStaleId(id, validIds)` is defined in Task 1 and called with the same signature in Task 2. The mutation's `onError` signature `(error: unknown)` matches `@tanstack/react-query` v5 conventions, and `pushToast({ title, body, tone })` matches the recorded `ToastInput` shape from `ui/src/context/ToastContext.tsx:99–144`.

**4. Risk notes:**
- The new `useEffect` adds `agents` and `projects` to a deps array. These are query results that change reference on refetch. Using the **functional setter** form (`setX(prev => ...)`) ensures we only re-prune; no infinite loop because pruning a stale id to `""` is idempotent on the next run.
- The `onError` handler does not call `closeNewIssue()` — intentional, so the user can fix and retry.
