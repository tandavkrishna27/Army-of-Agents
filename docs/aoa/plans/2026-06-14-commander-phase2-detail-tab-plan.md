# Commander Phase 2 — Interactive Detail Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extract `TaskSlideOver`'s inner content into a Sheet-agnostic `<TaskDetail>` and add a `task` viewer-tab kind + `openTask()` API, so a task can render as a Commander viewer tab — **the capability only; the cockpit (Phase 3) is the trigger.**

**Architecture:** `TaskSlideOver` becomes a thin Sheet wrapper around `<TaskDetail issueId active onDismiss>`. The `open` prop (used today *only* to gate queries) maps to `active`; `onClose()` calls inside the content map to `onDismiss?.()`. The Sheet chrome (Radix Dialog shell, Escape/backdrop, `onPointerDownOutside`, sr-only title) stays in the wrapper. The viewer gets a `task` tab kind whose body renders `<TaskDetail active>`; because the viewer's `TabBodySwitch` mounts only the active tab, `<TaskDetail>` fetches (incl. its 3–5s polling) only while visible.

**Tech Stack:** React + Tailwind v4; @tanstack/react-query (query-key dedup matters — see Task 1).

**Scope decision (locked with founder): PURE ENABLER.** No user-facing trigger this phase (no task chips, no ref-kind changes). `openTask()` + the `task` tab kind are built and unit/component-tested; Phase 3's cockpit calls `openTask`. **No changes to `packages/shared/commander-output-refs.ts`, `server/.../output-refs.ts`, or the codex parser mirror.** Verified by: regression (the 3 existing `TaskSlideOver` call sites + `TaskSlideOver.test` unchanged) + new component/unit tests + a light live slide-over regression.

**Verified anchors (read before editing):**
- `ui/src/components/TaskSlideOver.tsx`: props `:204-208` `{issueId, open, onClose}`; context hooks `:213-216` (`useCompany`/`useToast`/`useQueryClient`/`useNavigate`); UI state `:217-233`; **`sidebarMode` state `:235-236`** (`"task"|"workspace"`, toggled internally); reset effect `:754-764`; the ~19 queries `:240-378,:417-424,:728-734` (most gated `enabled: !!issueId && open`); render `:781-1858`; **Sheet shell** `:781-805` (open) + `:1857-1858` (close), incl. `onOpenChange` `:782`, `onPointerDownOutside` `:788-793`, sr-only `SheetTitle`/`SheetDescription` `:799-805`; **workspace-mode inner content `:807-851`**; **task-mode inner content `:854-1856`**; `onClose()` call sites inside content: `:831`, `:838`, `:950` (mutation `onSuccess`), `:962`.
- Usages (must keep working, ZERO behavior change): `ui/src/components/crew/CrewBoard.tsx:138-141`, `ui/src/pages/Issues.tsx:168-171`, `ui/src/pages/ProjectDetail.tsx:1112-1115`, `ui/src/__tests__/TaskSlideOver.test.tsx`.
- Viewer model `ui/src/components/commander/viewer/commanderViewerModel.ts:5-17` (`ViewerTab`, kinds `artifact|reply|browser`), `:38-53` `openRefTab`.
- `ui/src/components/commander/viewer/useCommanderViewer.ts:15-29` (`CommanderViewerApi`), `:63-88` (the returned API).
- `ui/src/components/commander/viewer/CommanderViewerPanel.tsx`: `ArtifactTabBody` `:102-150` (query gated `enabled: Boolean(tab.refId)`), `TabBodySwitch` `:357-391`, `buildViewerTabModels` (added in Phase 1), `CommanderViewerDetail` (has `viewer`), the `TabBodySwitch` call site inside it.
- Barrel `ui/src/components/commander/viewer/index.ts`.

---

## Task 1: Extract `<TaskDetail>`; make `TaskSlideOver` a thin Sheet wrapper

**Files:**
- Create: `ui/src/components/TaskDetail.tsx`
- Modify: `ui/src/components/TaskSlideOver.tsx`

This is a **mechanical extraction** — move the body, rename two things, keep the Sheet shell. Read the whole `TaskSlideOver.tsx` first.

- [ ] **Step 1: Create `TaskDetail.tsx` via COPY-THEN-CARVE.** (Codex #1: `TaskSlideOver.tsx` defines module-level helpers/types/sub-components ABOVE the component that the body uses — `CommentReassignment` :78, `asRecord` :113, `usageNumber` :118, `truncate` :127, `formatAction` :132, `ActorIdentity` :168, `SourceBadge` :189 (+ possibly others). A "move lines :213-1856" approach would leave these behind and `TaskDetail` won't compile. Copy-then-carve guarantees they come along.)
  1. **Copy the ENTIRE `TaskSlideOver.tsx` → `TaskDetail.tsx`** (all imports + all module-level helpers/types/sub-components + the component).
  2. In `TaskDetail.tsx`, change the export name + props:
     ```ts
     interface TaskDetailProps {
       issueId: string | null;   // mirror current null-handling exactly
       active: boolean;          // replaces `open` — gates queries
       onDismiss?: () => void;   // replaces the in-content onClose() calls
     }
     export function TaskDetail({ issueId, active, onDismiss }: TaskDetailProps) { ... }
     ```
  3. **Renames in the body:** prop `open` → `active` everywhere (every `enabled: !!issueId && open` → `… && active`; Codex confirmed `open` is query-gate-only, so no effect/JSX behavior changes); each `onClose()` call (`:831`, `:838`, mutation `onSuccess` `:950`, header button `:962`) → `onDismiss?.()`.
  4. **Remove the Sheet shell** from `TaskDetail`'s return: drop `<Sheet>`/`<SheetContent>`/`<SheetTitle>`/`<SheetDescription>`, `onOpenChange`, and `onPointerDownOutside`; replace with a root `<div className="flex h-full min-h-0 flex-col overflow-hidden">` wrapping the workspace-mode block (`:807-851`) + task-mode block (`:854-1856`) — reproduces `SheetContent`'s `flex flex-col overflow-hidden`; `h-full` fills the Sheet or the viewer Panel. Remove the now-unused `@/components/ui/sheet` imports (`Sheet`,`SheetContent`,`SheetTitle`,`SheetDescription`). **Keep** the content-level `Dialog` at `:1223` — it is NOT a Sheet (it's an in-content dialog) and stays in `TaskDetail`.
  5. `cd ui ; pnpm tsc -b` → `TaskDetail.tsx` must compile with ZERO missing references (proves every helper came along).

- [ ] **Step 2: Reduce `TaskSlideOver.tsx` to the wrapper.** Delete everything now living in `TaskDetail` — ALL module-level helpers/types/sub-components and every import used only by the content (they moved in Step 1). Keep only `TaskSlideOverProps` `:204-208`, the Sheet shell, and what the wrapper needs (`Sheet`/`SheetContent`/`SheetTitle`/`SheetDescription`, `useQuery`, `queryKeys`, `issuesApi`, `TaskDetail`). Render `<TaskDetail>` as the body. `pnpm tsc -b` must show ZERO unused imports/symbols in `TaskSlideOver.tsx`. Preserve the sr-only `SheetTitle` identifier via a **dedup-shared** issue query (same `queryKey` as `TaskDetail`'s `issues.detail` → react-query serves both from one fetch, zero extra network):

```tsx
import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { queryKeys } from "../lib/queryKeys";
import { issuesApi } from "../api/issues"; // confirm the exact import path used today
import { TaskDetail } from "./TaskDetail";

interface TaskSlideOverProps {
  issueId: string | null;
  open: boolean;
  onClose: () => void;
}

export function TaskSlideOver({ issueId, open, onClose }: TaskSlideOverProps) {
  // Title-only, deduped with TaskDetail's issues.detail query (same key → one fetch).
  const { data: issue } = useQuery({
    queryKey: queryKeys.issues.detail(issueId!),
    queryFn: () => issuesApi.get(issueId!),
    enabled: !!issueId && open,
  });

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        className="w-[560px] sm:w-[600px] sm:max-w-[600px] p-0 gap-0 overflow-hidden flex flex-col"
        onPointerDownOutside={(event) => {
          const target = event.detail.originalEvent.target as HTMLElement | null;
          if (target?.closest("[data-radix-popper-content-wrapper]")) {
            event.preventDefault();
          }
        }}
      >
        <SheetTitle className="sr-only">
          {issue?.identifier ? `${issue.identifier}: ` : ""}
          {issue?.title ?? "Task details"}
        </SheetTitle>
        <SheetDescription className="sr-only">
          Task details, comments, and workspace actions
        </SheetDescription>
        <TaskDetail issueId={issueId} active={open} onDismiss={onClose} />
      </SheetContent>
    </Sheet>
  );
}
```
(Confirm the real `issuesApi`/`queryKeys.issues.detail` symbols by reading the moved query at `TaskSlideOver.tsx:240-244`; reuse exactly those.)

- [ ] **Step 3: Verify the extraction is behavior-preserving.**
  - `cd ui ; pnpm tsc -b` → clean for these files.
  - `cd ui ; pnpm vitest run src/__tests__/TaskSlideOver.test.tsx` → **PASS** (this renders `TaskSlideOver` → exercises `TaskDetail`; it's the regression gate proving the move is correct). If the test imports internals that moved, update the import; do NOT weaken assertions.
  - The 3 call sites are untouched (wrapper API identical) — confirm they still typecheck.

- [ ] **Step 4: Commit**
```bash
git add ui/src/components/TaskDetail.tsx ui/src/components/TaskSlideOver.tsx
git commit -m "refactor(task): extract TaskDetail; TaskSlideOver becomes a thin Sheet wrapper (Phase 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Add the `task` tab kind to the viewer model (TDD)

**Files:**
- Modify: `ui/src/components/commander/viewer/commanderViewerModel.ts`
- Modify/Create test: `ui/src/components/commander/viewer/commanderViewerModel.test.ts` (append if it exists)

- [ ] **Step 1: Failing test**
```ts
import { describe, it, expect } from "vitest";
import { emptyViewerState, openTaskTab } from "./commanderViewerModel";

describe("openTaskTab", () => {
  it("opens a task tab (kind=task, refId=issueId), expands, activates", () => {
    const s = openTaskTab(emptyViewerState(), "issue-1", "Fix login");
    expect(s.expanded).toBe(true);
    expect(s.activeId).toBe("task:issue-1");
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({ id: "task:issue-1", kind: "task", refId: "issue-1", title: "Fix login" });
  });
  it("re-activates an existing task tab instead of duplicating", () => {
    const a = openTaskTab(emptyViewerState(), "issue-1", "Fix login");
    const b = openTaskTab({ ...a, activeId: "home", expanded: false }, "issue-1", "Fix login");
    expect(b.tabs).toHaveLength(1);
    expect(b.activeId).toBe("task:issue-1");
    expect(b.expanded).toBe(true);
  });
});
```
Run: `cd ui ; pnpm vitest run src/components/commander/viewer/commanderViewerModel.test.ts` → FAIL.

- [ ] **Step 2: Implement.** In `commanderViewerModel.ts`:
  - Extend the union (`:8`): `kind: "artifact" | "reply" | "browser" | "task";`. Update the `refId` doc comment to add "issue id for task tabs". (Reuse `refId` = issueId; no new field.)
  - Add:
    ```ts
    export function openTaskTab(
      state: ConversationViewerState,
      issueId: string,
      title: string,
    ): ConversationViewerState {
      const id = `task:${issueId}`;
      if (state.tabs.some((t) => t.id === id)) return { ...state, activeId: id, expanded: true };
      const tab: ViewerTab = { id, kind: "task", title, refId: issueId };
      return { tabs: [...state.tabs, tab], activeId: id, expanded: true };
    }
    ```
Run the test → PASS.

- [ ] **Step 3: Commit**
```bash
git add ui/src/components/commander/viewer/commanderViewerModel.ts ui/src/components/commander/viewer/commanderViewerModel.test.ts
git commit -m "feat(commander): task tab kind + openTaskTab in viewer model (Phase 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `openTask()` on the viewer API

**Files:**
- Modify: `ui/src/components/commander/viewer/useCommanderViewer.ts`

- [ ] **Step 1:** Import `openTaskTab` (add to the existing import from `./commanderViewerModel`). Add to `CommanderViewerApi` (`:15-29`):
```ts
  /** Open a task as a viewer tab (Phase 3 cockpit / future task chips call this). */
  openTask: (issueId: string, title: string) => void;
```
Add to the returned object (near `openRef`, `:65`):
```ts
    openTask: (issueId, title) => update(openTaskTab(readState(), issueId, title)),
```

- [ ] **Step 2:** `cd ui ; pnpm tsc -b` → clean. Commit:
```bash
git add ui/src/components/commander/viewer/useCommanderViewer.ts
git commit -m "feat(commander): openTask() on viewer API (Phase 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Render task tabs — `TaskDetailTabBody` + `TabBodySwitch` + tab-model icon

**Files:**
- Modify: `ui/src/components/commander/viewer/CommanderViewerPanel.tsx`

- [ ] **Step 1: `TaskDetailTabBody`** (alongside `ArtifactTabBody`). Imports: `import { TaskDetail } from "../../TaskDetail";` and a task icon (`ListTodo` from lucide-react). The switch mounts only the active body, so `active` is always true here:
```tsx
interface TaskDetailTabBodyProps {
  tab: ViewerTab;
  onDismiss: () => void;
}
function TaskDetailTabBody({ tab, onDismiss }: TaskDetailTabBodyProps) {
  // tab.refId is the issueId. Only mounted while active → active is true; TaskDetail
  // gates its own (incl. polling) queries on `active`.
  return <TaskDetail issueId={tab.refId} active onDismiss={onDismiss} />;
}
```

- [ ] **Step 2: `TabBodySwitch`** — add the `task` case + thread a close handler. Add `onCloseTab: (id: string) => void` to `TabBodySwitchProps`. **Pass `onCloseTab={viewer.close}` at BOTH `TabBodySwitch` call sites** — the desktop one in `CommanderViewerDetail` (~:267) AND the mobile one inside the Sheet (~:438). (Codex #2: both render `TabBodySwitch`; missing either fails TypeScript.) New branch (before the `UnavailableBody` fallback):
```tsx
  if (activeTab.kind === "task") {
    return <TaskDetailTabBody tab={activeTab} onDismiss={() => onCloseTab(activeTab.id)} />;
  }
```

- [ ] **Step 3: `buildViewerTabModels`** — give task tabs an icon:
```tsx
      icon: t.kind === "browser" ? Globe : t.kind === "task" ? ListTodo : FileText,
```
(Import `ListTodo` from `lucide-react`.)

- [ ] **Step 4:** `cd ui ; pnpm tsc -b` → clean. Commit:
```bash
git add ui/src/components/commander/viewer/CommanderViewerPanel.tsx
git commit -m "feat(commander): render task tabs via TaskDetailTabBody + TabBodySwitch (Phase 2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Component test for the task tab + full verification

**Files:**
- Create: `ui/src/components/commander/viewer/TaskDetailTabBody.test.tsx` (or extend an existing viewer test)

- [ ] **Step 1: Component test** — mock `TaskDetail` (we test wiring, not re-test TaskDetail) and assert the switch renders it for a `task` tab and passes the issueId:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("../../TaskDetail", () => ({
  TaskDetail: ({ issueId, active }: { issueId: string | null; active: boolean }) => (
    <div data-testid="task-detail-mock" data-issue={issueId} data-active={String(active)} />
  ),
}));
// Render the smallest unit that dispatches a task tab — import TabBodySwitch (export it if not
// already) OR render CommanderViewerDetail with a task tab in state. Assert:
it("renders TaskDetail for a task tab with active=true and the issueId", () => {
  // ...render with a task tab (id 'task:issue-1', kind 'task', refId 'issue-1')...
  const el = screen.getByTestId("task-detail-mock");
  expect(el).toHaveAttribute("data-issue", "issue-1");
  expect(el).toHaveAttribute("data-active", "true");
});
```
(If `TabBodySwitch` isn't exported, export it for testability — it's an internal pure switch.) Run → PASS.

- [ ] **Step 2: Full static + unit verification**
  - `cd ui ; pnpm tsc -b` → clean.
  - `cd ui ; pnpm vitest run src/components/commander/ src/__tests__/TaskSlideOver.test.tsx` → all green (model + new tab test + the slide-over regression).

- [ ] **Step 3: Light live regression (real browser)** — since there's no Commander trigger this phase, verify the **slide-over still works** (proves `TaskDetail` renders correctly in a real browser after extraction). Throwaway e2e (deleted after): seed a company + a task via `POST /api/companies/:cid/issues`, navigate to the Tasks/Issues page, open the task row → assert the slide-over shows the task title/description; screenshot. (If opening a row in the harness is impractical, fall back to asserting `TaskSlideOver.test` + the existing `commander-viewer` e2e stay green and note that the live trigger arrives in Phase 3.)

- [ ] **Step 4:** Tear down throwaway DB/specs; confirm clean tree (only Phase 2 commits). Do NOT run `finishing-a-development-branch` (Phase 3 remains).

---

## Self-review (run after drafting; fix inline)

- **Spec coverage (§4):** `TaskDetail` = extract-existing ✅ (Task 1); `task` tab kind in model + `TabBodySwitch` ✅ (Tasks 2, 4); `open`→`active` gate ✅ (Task 1 rename + TaskDetailTabBody passes active); Goal/Approval NOT tabs ✅ (untouched). Trigger deferred to Phase 3 per the locked scope decision ✅.
- **Zero-behavior-change risk (the big one):** the extraction is mechanical (move + two renames); the sr-only title is preserved via a deduped query (no double fetch); `onPointerDownOutside`/Escape/backdrop stay in the wrapper. Gate = `TaskSlideOver.test` + tsc + the 3 unchanged call sites.
- **`active` gate correctness:** the switch mounts only the active tab, so `<TaskDetail active>` (and its 3–5s polling) runs only while visible; switching tabs unmounts it (polling stops). `onDismiss` in a tab → `viewer.close(tab.id)`.
- **Type consistency:** `openTaskTab`(Task 2) used by `openTask`(Task 3) + the test(Task 5); `ViewerTab.kind` union updated once; `refId` reused as issueId (no new field); `onCloseTab` added to `TabBodySwitchProps` and supplied by `CommanderViewerDetail`.
- **No out-of-scope edits:** shared ref-kinds, server output-refs, codex parser mirror all untouched (pure-enabler scope).
