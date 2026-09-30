# Session 5: Department Function Picker + Workspace Policy Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a function type picker to NewProjectDialog for departments, and a Workspace Policy section to ProjectProperties.

**Architecture:** Two self-contained UI changes. NewProjectDialog gains department-only function picker state + conditional workspace section. ProjectProperties gains a policy section that reads/writes `executionWorkspacePolicy` via the existing `onUpdate` prop. Both are independently testable.

**Tech Stack:** React, TypeScript, Vitest, @testing-library/react, @tanstack/react-query (mocked in tests), TailwindCSS

**Spec:** `docs/superpowers/specs/2026-04-04-session5-function-picker-workspace-policy-design.md`

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `ui/src/components/NewProjectDialog.tsx` | Modify | Add functionType state, function picker grid, conditional workspace section, mode toggle, updated submit |
| `ui/src/components/ProjectProperties.tsx` | Modify | Add Workspace Policy section after Workspaces |
| `ui/src/__tests__/NewProjectDialog-functionType.test.tsx` | Create | 4 tests for function picker behavior |
| `ui/src/__tests__/ProjectProperties-workspacePolicy.test.tsx` | Create | 2 tests for policy section visibility |

---

## Task 1: NewProjectDialog — Add function picker state + grid

**Files:**
- Modify: `ui/src/components/NewProjectDialog.tsx`

### Context

The dialog is at `ui/src/components/NewProjectDialog.tsx`. It already has a `projectType` variable derived from `newProjectDefaults.type ?? "project"`. The function picker should only appear when `projectType === "department"`.

Currently the file has these state variables at the top of the component — add two more after `workspaceError`:

```ts
const [functionType, setFunctionType] = useState<string | null>(null);
const [workspaceMode, setWorkspaceMode] = useState<"isolated" | "shared">("isolated");
```

Also add them to the `reset()` function.

- [ ] **Step 1: Add state variables**

In `NewProjectDialog.tsx`, add after the `workspaceError` state declaration (line ~61):

```ts
const [functionType, setFunctionType] = useState<string | null>(null);
const [workspaceMode, setWorkspaceMode] = useState<"isolated" | "shared">("isolated");
```

- [ ] **Step 2: Update reset()**

The `reset()` function currently (lines ~87-98) ends with `setWorkspaceError(null)`. Add after it:

```ts
setFunctionType(null);
setWorkspaceMode("isolated");
```

- [ ] **Step 3: Add FUNCTION_TYPES constant above the component**

Add this above the `NewProjectDialog` function declaration (after the existing `REPO_ONLY_CWD_SENTINEL` constant):

```ts
const FUNCTION_TYPES = [
  { value: "software_development", label: "Product (Software)", icon: "💻" },
  { value: "marketing", label: "Marketing", icon: "📢" },
  { value: "finance", label: "Finance", icon: "💰" },
  { value: "support", label: "Support", icon: "🎧" },
  { value: "hr", label: "HR", icon: "👥" },
  { value: "legal", label: "Legal", icon: "⚖️" },
  { value: "research", label: "Research", icon: "🔬" },
  { value: "operations", label: "Operations", icon: "📊" },
  { value: "general", label: "General", icon: "📋" },
  { value: "custom", label: "Custom", icon: "⚙️" },
] as const;
```

- [ ] **Step 4: Insert function picker block in JSX**

The JSX has a `{/* Description */}` block ending around line ~286, followed immediately by the workspace `<div className="px-4 pb-3 space-y-3 border-t border-border">`. Insert this block **between** the description div and the workspace div:

```tsx
{/* Function picker — departments only */}
{projectType === "department" && (
  <div className="px-4 pb-3 space-y-3 border-t border-border">
    <div className="pt-3">
      <p className="text-sm font-medium">What does this department do?</p>
    </div>
    <div className="grid grid-cols-3 gap-2">
      {FUNCTION_TYPES.map((ft) => (
        <button
          key={ft.value}
          type="button"
          className={cn(
            "rounded-lg border px-3 py-2.5 text-left transition-colors",
            functionType === ft.value
              ? "border-foreground bg-accent/40"
              : "border-border hover:bg-accent/30",
          )}
          onClick={() => setFunctionType(ft.value)}
        >
          <div className="flex items-center gap-2 text-sm font-medium">
            <span>{ft.icon}</span>
            <span>{ft.label}</span>
          </div>
        </button>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/NewProjectDialog.tsx
git commit -m "feat: add function type picker state and grid to NewProjectDialog"
```

---

## Task 2: NewProjectDialog — Conditional workspace section + mode toggle

**Files:**
- Modify: `ui/src/components/NewProjectDialog.tsx`

### Context

The existing workspace block starts at line ~288 with `<div className="px-4 pb-3 space-y-3 border-t border-border">` containing the "Where will work be done..." heading and local/repo/both buttons. This block currently always shows. We need to:
1. Hide it entirely when `projectType === "department"` and `functionType === null`
2. For departments with a non-software function type, replace the three-button setup with a single working directory input
3. Add a workspace mode toggle below the workspace input (for all function types once selected)

- [ ] **Step 1: Wrap existing workspace section with department/project conditional**

The workspace section div (starts `<div className="px-4 pb-3 space-y-3 border-t border-border">` containing "Where will work be done") needs to be wrapped so it shows:
- Always for `projectType === "project"`
- For departments: only when `functionType === "software_development"`

Replace the opening condition so the entire existing workspace block renders as:

```tsx
{/* Workspace setup */}
{(projectType === "project" || functionType === "software_development") && (
  <div className="px-4 pb-3 space-y-3 border-t border-border">
    <div className="pt-3">
      <p className="text-sm font-medium">Where will work be done on this project?</p>
      <p className="text-xs text-muted-foreground">Add local folder and/or GitHub repo workspace hints.</p>
    </div>
    {/* ... all the existing local/repo/both buttons, inputs, error ... */}
  </div>
)}
```

Keep all the existing content inside unchanged.

- [ ] **Step 2: Add working directory block for non-software department types**

After the workspace setup block (but still inside the overall form area), add:

```tsx
{/* Working directory for non-software departments */}
{projectType === "department" && functionType !== null && functionType !== "software_development" && (
  <div className="px-4 pb-3 space-y-3 border-t border-border">
    <div className="pt-3">
      <p className="text-sm font-medium">Working directory <span className="text-muted-foreground font-normal">(optional)</span></p>
    </div>
    <div className="rounded-md border border-border p-2">
      <label className="mb-1 block text-xs text-muted-foreground">Local folder (full path)</label>
      <div className="flex items-center gap-2">
        <input
          className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
          value={workspaceLocalPath}
          onChange={(e) => setWorkspaceLocalPath(e.target.value)}
          placeholder="/absolute/path/to/workspace"
        />
        <ChoosePathButton />
      </div>
    </div>
  </div>
)}
```

Note: `workspaceLocalPath` state already exists in the component.

- [ ] **Step 3: Add workspace mode toggle**

Add this block after the two workspace blocks above (before the property chips `<div className="flex items-center gap-1.5...">`), visible whenever a function type has been selected for a department:

```tsx
{/* Workspace mode toggle — departments with a function type selected */}
{projectType === "department" && functionType !== null && (
  <div className="px-4 pb-3 border-t border-border">
    <div className="pt-3 mb-2">
      <p className="text-sm font-medium">Workspace mode</p>
    </div>
    <div className="flex gap-2">
      <button
        type="button"
        className={cn(
          "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors",
          workspaceMode === "isolated"
            ? "border-foreground bg-accent/40 text-foreground"
            : "border-border hover:bg-accent/30 text-muted-foreground",
        )}
        onClick={() => setWorkspaceMode("isolated")}
      >
        🔒 Isolated <span className="text-muted-foreground">(default)</span>
      </button>
      <button
        type="button"
        className={cn(
          "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors",
          workspaceMode === "shared"
            ? "border-foreground bg-accent/40 text-foreground"
            : "border-border hover:bg-accent/30 text-muted-foreground",
        )}
        onClick={() => setWorkspaceMode("shared")}
      >
        🔗 Shared
      </button>
    </div>
  </div>
)}
```

- [ ] **Step 4: Update handleSubmit to include functionType and workspaceModeHint**

In `handleSubmit`, the `createProject.mutateAsync` call currently sends `name`, `description`, `status`, `type`, `color`, `goalIds`, `targetDate`. Add:

```ts
...(projectType === "department" && functionType ? { functionType } : {}),
...(projectType === "department" && functionType ? { workspaceModeHint: workspaceMode } : {}),
```

Also add the working directory workspace creation for non-software departments. After the existing `workspacePayloads` loop, the logic already handles `localRequired`. For non-software departments, `workspaceSetup` stays `"none"` so no workspace is auto-created from the existing logic. We need to handle the optional working directory separately:

```ts
// For non-software departments: create workspace from optional working directory
if (
  projectType === "department" &&
  functionType !== null &&
  functionType !== "software_development" &&
  workspaceLocalPath.trim() &&
  isAbsolutePath(workspaceLocalPath.trim())
) {
  const cwd = workspaceLocalPath.trim();
  await projectsApi.createWorkspace(created.id, {
    name: deriveWorkspaceNameFromPath(cwd),
    cwd,
  });
}
```

Place this block after the existing `for (const workspacePayload of workspacePayloads)` loop and before the `queryClient.invalidateQueries` calls.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/NewProjectDialog.tsx
git commit -m "feat: conditional workspace section and mode toggle in NewProjectDialog"
```

---

## Task 3: Tests for NewProjectDialog function picker

**Files:**
- Create: `ui/src/__tests__/NewProjectDialog-functionType.test.tsx`

### Context

Follow the mock pattern in `ui/src/__tests__/TaskSlideOver.test.tsx`. Key mocks needed:
- `@mdxeditor/editor` — the MarkdownEditor used in the dialog
- `../context/CompanyContext`
- `../context/DialogContext`
- `@tanstack/react-query`
- `../api/projects`
- `../api/goals`
- `../api/assets`
- `./PathInstructionsModal` (ChoosePathButton)

The dialog reads `newProjectOpen` (must be `true`) and `newProjectDefaults.type` from DialogContext.

- [ ] **Step 1: Create the test file with mocks**

Create `ui/src/__tests__/NewProjectDialog-functionType.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@mdxeditor/editor", () => ({
  CodeMirrorEditor: {},
  MDXEditor: () => null,
  headingsPlugin: () => ({}),
  listsPlugin: () => ({}),
  quotePlugin: () => ({}),
  thematicBreakPlugin: () => ({}),
  markdownShortcutPlugin: () => ({}),
  toolbarPlugin: () => ({}),
  BoldItalicUnderlineToggles: () => null,
  ListsToggle: () => null,
  BlockTypeSelect: () => null,
  CreateLink: () => null,
  linkPlugin: () => ({}),
  linkDialogPlugin: () => ({}),
  codeBlockPlugin: () => ({}),
  codeMirrorPlugin: () => ({}),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    selectedCompany: { name: "Acme Corp" },
  }),
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    create: vi.fn().mockResolvedValue({ id: "proj-1" }),
    createWorkspace: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../api/goals", () => ({
  goalsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

vi.mock("./PathInstructionsModal", () => ({
  ChoosePathButton: () => <button type="button">Choose</button>,
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: [], isLoading: false, error: null })),
    useMutation: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue({ id: "proj-1" }),
      isPending: false,
      isError: false,
    }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
}));

// Helper: render dialog as a department
function renderDepartmentDialog() {
  const dialogContextValue = {
    newProjectOpen: true,
    newProjectDefaults: { type: "department" as const },
    closeNewProject: vi.fn(),
    // other dialog methods stubbed
    newIssueOpen: false, newIssueDefaults: {}, openNewIssue: vi.fn(), closeNewIssue: vi.fn(),
    newGoalOpen: false, newGoalDefaults: {}, openNewGoal: vi.fn(), closeNewGoal: vi.fn(),
    newAgentOpen: false, openNewAgent: vi.fn(), closeNewAgent: vi.fn(),
    onboardingOpen: false, onboardingOptions: {}, openOnboarding: vi.fn(), closeOnboarding: vi.fn(),
    discussionCaptureOpen: false, discussionCaptureDefaults: {}, openDiscussionCapture: vi.fn(), closeDiscussionCapture: vi.fn(),
    openNewProject: vi.fn(),
  };

  // We need to provide DialogContext — import and mock it
  const DialogContext = require("../context/DialogContext").DialogContext;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  return render(
    <QueryClientProvider client={qc}>
      <DialogContext.Provider value={dialogContextValue}>
        <NewProjectDialog />
      </DialogContext.Provider>
    </QueryClientProvider>
  );
}
```

Wait — `DialogContext` is not exported directly. The component uses `useDialog()` hook. Mock `../context/DialogContext` module instead:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NewProjectDialog } from "../components/NewProjectDialog";

vi.mock("@mdxeditor/editor", () => ({
  CodeMirrorEditor: {},
  MDXEditor: () => null,
  headingsPlugin: () => ({}),
  listsPlugin: () => ({}),
  quotePlugin: () => ({}),
  thematicBreakPlugin: () => ({}),
  markdownShortcutPlugin: () => ({}),
  toolbarPlugin: () => ({}),
  BoldItalicUnderlineToggles: () => null,
  ListsToggle: () => null,
  BlockTypeSelect: () => null,
  CreateLink: () => null,
  linkPlugin: () => ({}),
  linkDialogPlugin: () => ({}),
  codeBlockPlugin: () => ({}),
  codeMirrorPlugin: () => ({}),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "comp-1",
    selectedCompany: { name: "Acme Corp" },
  }),
}));

const mockCloseNewProject = vi.fn();

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newProjectOpen: true,
    newProjectDefaults: { type: "department" },
    closeNewProject: mockCloseNewProject,
  }),
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    create: vi.fn().mockResolvedValue({ id: "proj-1" }),
    createWorkspace: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../api/goals", () => ({
  goalsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

vi.mock("../components/PathInstructionsModal", () => ({
  ChoosePathButton: () => <button type="button">Choose</button>,
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: [], isLoading: false, error: null })),
    useMutation: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue({ id: "proj-1" }),
      isPending: false,
      isError: false,
    }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NewProjectDialog />
    </QueryClientProvider>
  );
}

describe("NewProjectDialog — function type picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all 10 function type options for departments", () => {
    renderDialog();
    expect(screen.getByText("Product (Software)")).toBeInTheDocument();
    expect(screen.getByText("Marketing")).toBeInTheDocument();
    expect(screen.getByText("Finance")).toBeInTheDocument();
    expect(screen.getByText("Support")).toBeInTheDocument();
    expect(screen.getByText("HR")).toBeInTheDocument();
    expect(screen.getByText("Legal")).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.getByText("Operations")).toBeInTheDocument();
    expect(screen.getByText("General")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });

  it("selecting Product (Software) shows repo setup", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByText("Product (Software)"));
    expect(screen.getByText("A local folder")).toBeInTheDocument();
    expect(screen.getByText("A github repo")).toBeInTheDocument();
    expect(screen.getByText("Both")).toBeInTheDocument();
  });

  it("selecting a non-software type shows working directory input, not repo setup", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByText("Marketing"));
    expect(screen.queryByText("A local folder")).not.toBeInTheDocument();
    expect(screen.queryByText("A github repo")).not.toBeInTheDocument();
    expect(screen.getByText("Working directory")).toBeInTheDocument();
  });

  it("workspace mode toggle renders and Shared can be selected", async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByText("Marketing"));
    const sharedBtn = screen.getByRole("button", { name: /shared/i });
    await user.click(sharedBtn);
    // After click, the shared button should have the active border class
    expect(sharedBtn.className).toContain("border-foreground");
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail (component not yet updated)**

```bash
cd ui && pnpm test src/__tests__/NewProjectDialog-functionType.test.tsx --reporter=verbose
```

Expected: All 4 tests FAIL — "Product (Software)" is not in the document yet.

- [ ] **Step 3: Commit the test file**

```bash
git add ui/src/__tests__/NewProjectDialog-functionType.test.tsx
git commit -m "test: add failing tests for NewProjectDialog function type picker"
```

---

## Task 4: Run tests after Task 1+2 implementation — verify they pass

**Files:** (no new files)

- [ ] **Step 1: Run the function picker tests**

```bash
cd ui && pnpm test src/__tests__/NewProjectDialog-functionType.test.tsx --reporter=verbose
```

Expected: All 4 tests PASS.

If a test fails, check:
- "Product (Software)" not found → FUNCTION_TYPES constant not added or picker block has wrong condition
- "Working directory" not found → non-software block condition wrong (check `functionType !== "software_development"`)
- "border-foreground" not on button → mode toggle selected class not applied

- [ ] **Step 2: Commit**

```bash
git add ui/src/components/NewProjectDialog.tsx
git commit -m "feat: NewProjectDialog function picker + conditional workspace section complete"
```

---

## Task 5: ProjectProperties — Workspace Policy section

**Files:**
- Modify: `ui/src/components/ProjectProperties.tsx`

### Context

`ProjectProperties` receives a `project: Project` prop. `project.executionWorkspacePolicy` is of type `ProjectExecutionWorkspacePolicy | null` (from `packages/shared/src/types/workspace-runtime.ts`). The interface has:

```ts
interface ProjectExecutionWorkspacePolicy {
  enabled: boolean;
  defaultMode?: "isolated_workspace" | "shared_workspace";
  allowIssueOverride?: boolean;
  workspaceStrategy?: {
    type?: string;
    baseRef?: string | null;
    branchTemplate?: string | null;
    provisionCommand?: string | null;
    teardownCommand?: string | null;
  } | null;
}
```

The `onUpdate` prop is `(data: Record<string, unknown>) => void`. Existing usage: `onUpdate({ status })`, `onUpdate({ goalIds: [...] })`. For policy: `onUpdate({ executionWorkspacePolicy: { ...policy, field: value } })`.

The existing Workspaces section ends at a `<Separator />` before the Created/Updated rows. Add the policy section after the Workspaces closing div and before that final `<Separator />`.

- [ ] **Step 1: Add local state for advanced section toggle**

In `ProjectProperties`, add this state after the existing `workspaceError` state:

```ts
const [policyAdvancedOpen, setPolicyAdvancedOpen] = useState(false);
```

- [ ] **Step 2: Add helper to merge policy updates**

Add this inline helper inside the component (after `updateWorkspace` mutation):

```ts
const updatePolicy = (patch: Partial<ProjectExecutionWorkspacePolicy>) => {
  if (!onUpdate) return;
  onUpdate({
    executionWorkspacePolicy: {
      ...(project.executionWorkspacePolicy ?? { enabled: true }),
      ...patch,
    },
  });
};

const updatePolicyStrategy = (strategyPatch: Record<string, unknown>) => {
  if (!onUpdate) return;
  const existing = project.executionWorkspacePolicy ?? { enabled: true };
  onUpdate({
    executionWorkspacePolicy: {
      ...existing,
      workspaceStrategy: {
        type: "git_worktree",
        ...(existing.workspaceStrategy ?? {}),
        ...strategyPatch,
      },
    },
  });
};
```

You'll need to import `ProjectExecutionWorkspacePolicy` from the shared types. Add to imports:

```ts
import type { ProjectExecutionWorkspacePolicy } from "@armyofagents/shared";
```

Check if this type is re-exported from `@armyofagents/shared`. If not, import directly:

```ts
import type { ProjectExecutionWorkspacePolicy } from "@armyofagents/shared/src/types/workspace-runtime";
```

To check what's exported: `grep -r "ProjectExecutionWorkspacePolicy" packages/shared/src/index.ts` — if not there, use the path import.

- [ ] **Step 3: Insert the Workspace Policy JSX block**

The existing structure (around line ~519) is:

```tsx
          {/* ... workspaceError/mutation errors ... */}
        </div>

        <Separator />

        <PropertyRow label="Created">
```

Insert the policy block between the closing workspace `</div>` and the `<Separator />` before Created:

```tsx
      {/* Workspace Policy */}
      {project.executionWorkspacePolicy && (
        <>
          <Separator />
          <div className="py-1.5 space-y-3">
            <p className="text-xs text-muted-foreground">Workspace Policy</p>

            {/* Default mode toggle */}
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Default mode</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors",
                    project.executionWorkspacePolicy.defaultMode === "isolated_workspace" || !project.executionWorkspacePolicy.defaultMode
                      ? "border-foreground bg-accent/40 text-foreground"
                      : "border-border hover:bg-accent/30 text-muted-foreground",
                  )}
                  onClick={() => updatePolicy({ defaultMode: "isolated_workspace" })}
                  disabled={!onUpdate}
                >
                  🔒 Isolated
                </button>
                <button
                  type="button"
                  className={cn(
                    "flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors",
                    project.executionWorkspacePolicy.defaultMode === "shared_workspace"
                      ? "border-foreground bg-accent/40 text-foreground"
                      : "border-border hover:bg-accent/30 text-muted-foreground",
                  )}
                  onClick={() => updatePolicy({ defaultMode: "shared_workspace" })}
                  disabled={!onUpdate}
                >
                  🔗 Shared
                </button>
              </div>
            </div>

            {/* Per-task override checkbox */}
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <input
                type="checkbox"
                checked={project.executionWorkspacePolicy.allowIssueOverride ?? false}
                onChange={(e) => updatePolicy({ allowIssueOverride: e.target.checked })}
                disabled={!onUpdate}
                className="h-3.5 w-3.5"
              />
              Allow tasks to override workspace mode
            </label>

            {/* Advanced — software_development only */}
            {project.functionType === "software_development" && (
              <div className="border-t border-border/60 pt-2 space-y-2">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => setPolicyAdvancedOpen((o) => !o)}
                >
                  {policyAdvancedOpen ? "▾ Hide advanced" : "▸ Advanced"}
                </button>
                {policyAdvancedOpen && (
                  <div className="space-y-2">
                    {[
                      { key: "baseRef", label: "Base ref", placeholder: "main" },
                      { key: "branchTemplate", label: "Branch template", placeholder: "{{issue.identifier}}-{{slug}}" },
                      { key: "provisionCommand", label: "Provision command", placeholder: "npm install" },
                      { key: "teardownCommand", label: "Teardown command", placeholder: "" },
                    ].map(({ key, label, placeholder }) => (
                      <div key={key}>
                        <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
                        <input
                          className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                          defaultValue={(project.executionWorkspacePolicy?.workspaceStrategy as Record<string, unknown>)?.[key] as string ?? ""}
                          onBlur={(e) => updatePolicyStrategy({ [key]: e.target.value || null })}
                          placeholder={placeholder}
                          disabled={!onUpdate}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/ProjectProperties.tsx
git commit -m "feat: add Workspace Policy section to ProjectProperties"
```

---

## Task 6: Tests for ProjectProperties workspace policy

**Files:**
- Create: `ui/src/__tests__/ProjectProperties-workspacePolicy.test.tsx`

### Context

`ProjectProperties` takes `project: Project` and `onUpdate?: (data) => void`. We render it with a minimal project object. The component imports `goalsApi`, `projectsApi`, uses `@tanstack/react-query`, and `@/lib/router` (Link). Mock all of these.

- [ ] **Step 1: Create the test file**

Create `ui/src/__tests__/ProjectProperties-workspacePolicy.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectProperties } from "../components/ProjectProperties";
import type { Project } from "@armyofagents/shared";

vi.mock("@/lib/router", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, Link: actual.Link };
});

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "comp-1" }),
}));

vi.mock("../api/goals", () => ({
  goalsApi: { list: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    createWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQuery: vi.fn(() => ({ data: [], isLoading: false, error: null })),
    useMutation: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue({}),
      isPending: false,
      isError: false,
      isSuccess: false,
    }),
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock("../components/PathInstructionsModal", () => ({
  ChoosePathButton: () => <button type="button">Choose</button>,
}));

const baseProject: Project = {
  id: "proj-1",
  companyId: "comp-1",
  urlKey: "ENG",
  goalId: null,
  goalIds: [],
  goals: [],
  type: "department",
  name: "Engineering",
  description: null,
  status: "active",
  leadAgentId: null,
  targetDate: null,
  color: null,
  functionType: "software_development",
  executionWorkspacePolicy: null,
  workspaces: [],
  primaryWorkspace: null,
  archivedAt: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

function renderProperties(project: Project) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProjectProperties project={project} onUpdate={vi.fn()} />
    </QueryClientProvider>
  );
}

describe("ProjectProperties — Workspace Policy section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Workspace Policy section when executionWorkspacePolicy is present", () => {
    const project = {
      ...baseProject,
      executionWorkspacePolicy: {
        enabled: true,
        defaultMode: "isolated_workspace" as const,
        allowIssueOverride: true,
      },
    };
    renderProperties(project);
    expect(screen.getByText("Workspace Policy")).toBeInTheDocument();
    expect(screen.getByText("🔒 Isolated")).toBeInTheDocument();
    expect(screen.getByText("🔗 Shared")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it("hides Workspace Policy section when executionWorkspacePolicy is null", () => {
    renderProperties(baseProject); // executionWorkspacePolicy: null
    expect(screen.queryByText("Workspace Policy")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
cd ui && pnpm test src/__tests__/ProjectProperties-workspacePolicy.test.tsx --reporter=verbose
```

Expected: Both tests PASS.

If "Workspace Policy" not found: check the JSX condition `project.executionWorkspacePolicy &&` — make sure the text is exactly "Workspace Policy".

- [ ] **Step 3: Run the full UI test suite to check for regressions**

```bash
cd ui && pnpm test --reporter=verbose
```

Expected: All tests pass. Watch for regressions in `ProjectDetailBoard.test.tsx` or `TaskSlideOver.test.tsx`.

- [ ] **Step 4: Commit**

```bash
git add ui/src/__tests__/ProjectProperties-workspacePolicy.test.tsx
git commit -m "test: add ProjectProperties workspace policy section tests"
```

---

## Task 7: Final verification

**Files:** (no changes)

- [ ] **Step 1: Start the dev server and verify the dialog**

```bash
cd ui && pnpm dev
```

1. Open the app → click "+ New" → select "Department" → NewProjectDialog opens
2. Confirm the function type picker grid appears with 10 options
3. Click "Product (Software)" → local/repo/both workspace setup appears + mode toggle appears
4. Click "Marketing" → working directory input appears (no repo setup) + mode toggle appears
5. Click "🔗 Shared" → it becomes selected (darker border)
6. Click "🔒 Isolated (default)" → it becomes selected again

- [ ] **Step 2: Create a department and verify Properties**

1. Create a "Marketing" department (no working directory needed)
2. Open the department → go to Properties panel
3. Confirm Workspace Policy section appears with Isolated/Shared toggle and checkbox
4. Confirm Advanced section does NOT appear (Marketing is not software_development)
5. Create a "Product (Software)" department
6. Open Properties → Workspace Policy → confirm Advanced section appears
7. Click "▸ Advanced" → base ref / branch template / provision / teardown inputs appear
8. Type in Base ref → tab/click away → no error, field persists on re-open

- [ ] **Step 3: Final commit if any polish was needed**

```bash
git add -p  # review any remaining changes
git commit -m "feat: session 5 complete — function picker and workspace policy"
```
