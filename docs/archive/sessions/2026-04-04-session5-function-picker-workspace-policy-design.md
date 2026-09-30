# Session 5: Department Function Picker + Workspace Policy Settings

**Date:** 2026-04-04
**Branch:** feature/workspace
**Plan reference:** `docs/workspace-implementation-plan.md` — Phase 2.5 and 2.6

---

## Scope

Two UI changes in this session:

1. **NewProjectDialog** — add a function type picker for departments, with conditional workspace setup and a workspace mode toggle
2. **ProjectProperties** — add a Workspace Policy section for departments that have `executionWorkspacePolicy` configured

---

## Context

Session 1 already added `functionType` and `executionWorkspacePolicy` to the DB schema and Project type. The backend auto-configures `executionWorkspacePolicy` from `functionType` on department creation. This session wires up the UI that drives those fields.

---

## Part 1 — NewProjectDialog: Function Picker

**File:** `ui/src/components/NewProjectDialog.tsx`

### Trigger condition

The function picker block only renders when `projectType === "department"` (derived from `newProjectDefaults.type`). Projects are unchanged.

### New state

```ts
const [functionType, setFunctionType] = useState<string | null>(null);
const [workspaceMode, setWorkspaceMode] = useState<"isolated" | "shared">("isolated");
```

Both are reset in the existing `reset()` function.

### Layout

Inserted **after** the description editor, **before** the workspace section:

```
┌─────────────────────────────────────────────────────────┐
│ What does this department do?                           │
│                                                         │
│ [💻 Product]  [📢 Marketing]  [💰 Finance]             │
│ [🎧 Support]  [👥 HR]         [⚖ Legal]                │
│ [🔬 Research] [📊 Operations] [📋 General] [⚙ Custom]  │
└─────────────────────────────────────────────────────────┘
```

Grid: `grid grid-cols-3 gap-2`. Each button uses the same card style already in the dialog (`rounded-lg border px-3 py-3`). Selected state: `border-foreground bg-accent/40`.

Function type values (matching DB enum):

| Label | functionType value |
|---|---|
| Product (Software) | `software_development` |
| Marketing | `marketing` |
| Finance | `finance` |
| Support | `support` |
| HR | `hr` |
| Legal | `legal` |
| Research | `research` |
| Operations | `operations` |
| General | `general` |
| Custom | `custom` |

### Conditional workspace section

Replaces the existing workspace block (which currently always shows) with:

- `functionType === null` → hide entire workspace section (nothing selected yet)
- `functionType === "software_development"` → show existing local/repo/both setup (unchanged)
- Any other value → show single "Working directory (optional)" folder input + `ChoosePathButton`

### Workspace mode toggle (all types, shown after workspace input)

```
Workspace mode
[🔒 Isolated (default)]  [🔗 Shared]
```

Two buttons side by side. Selected button: `bg-accent border-foreground text-foreground`. Unselected: `border-border hover:bg-accent/30 text-muted-foreground`.

### Submit

Add to the `createProject.mutateAsync` payload:

```ts
functionType: functionType ?? "general",
workspaceModeHint: workspaceMode,  // backend uses this; auto-configures executionWorkspacePolicy
```

Do **not** send `executionWorkspacePolicy` from the frontend — the backend derives it from `functionType`.

For non-software departments, if the user entered a working directory path, create a project workspace after creation (same `projectsApi.createWorkspace` call already used for local path, just without a `repoUrl`).

---

## Part 2 — ProjectProperties: Workspace Policy Section

**File:** `ui/src/components/ProjectProperties.tsx`

### Trigger condition

Only renders when `project.executionWorkspacePolicy` is non-null.

### Placement

After the existing Workspaces section (after its `<Separator />`), before the Created/Updated date rows.

### Structure

```
Workspace Policy                        [section label]

Default mode
  [🔒 Isolated]  [🔗 Shared]           (two toggle buttons)

Per-task override
  ☐ Allow tasks to override workspace mode

▸ Advanced  (collapsible — only if functionType === "software_development")
  Base ref:           [________________]  (placeholder: "main")
  Branch template:    [________________]  (placeholder: "{{issue.identifier}}-{{slug}}")
  Provision command:  [________________]  (placeholder: "npm install")
  Teardown command:   [________________]
```

### Save pattern

All fields save immediately on blur via the existing `onUpdate` prop:

```ts
onUpdate({
  executionWorkspacePolicy: {
    ...project.executionWorkspacePolicy,
    defaultMode: newValue,
  }
})
```

No save button. This matches the existing behavior for status, goals, etc.

### Type mapping

| UI | Policy field |
|---|---|
| Isolated | `defaultMode: "isolated_workspace"` |
| Shared | `defaultMode: "shared_workspace"` |
| Per-task override checkbox | `allowIssueOverride: boolean` |
| Base ref | `workspaceStrategy.baseRef` |
| Branch template | `workspaceStrategy.branchTemplate` |
| Provision command | `workspaceStrategy.provisionCommand` |
| Teardown command | `workspaceStrategy.teardownCommand` |

Advanced field inputs read from `project.executionWorkspacePolicy.workspaceStrategy` (may be null — default to empty string). On blur they write back a merged `workspaceStrategy` with `type: "git_worktree"`.

### Advanced collapsible

Local `useState<boolean>` (default `false`). No persistence needed.

---

## Tests

### `ui/src/__tests__/NewProjectDialog-functionType.test.tsx`

Follows the pattern in `TaskSlideOver.test.tsx`: mock CompanyContext, react-query, DialogContext, router.

1. **Function picker renders for departments** — open dialog with `type: "department"`, assert all 10 function type labels are visible
2. **Selecting "Product (Software)" shows repo setup** — click "Product (Software)", assert local/repo/both buttons appear
3. **Selecting other types shows working directory** — click "Marketing", assert repo setup is NOT present, working directory input IS present
4. **Workspace mode toggle works** — click "Shared", assert it becomes selected (aria/class check)

### `ui/src/__tests__/ProjectProperties-workspacePolicy.test.tsx`

1. **Policy section renders when executionWorkspacePolicy is present** — render with `project.executionWorkspacePolicy = { enabled: true, defaultMode: "isolated_workspace" }`, assert "Workspace Policy" heading visible
2. **Policy section hidden when executionWorkspacePolicy is null** — render with `null`, assert "Workspace Policy" heading absent

---

## Files Changed

| File | Change |
|---|---|
| `ui/src/components/NewProjectDialog.tsx` | Add function picker, conditional workspace section, mode toggle, update submit |
| `ui/src/components/ProjectProperties.tsx` | Add Workspace Policy section after Workspaces |
| `ui/src/__tests__/NewProjectDialog-functionType.test.tsx` | New test file |
| `ui/src/__tests__/ProjectProperties-workspacePolicy.test.tsx` | New test file |

---

## Verification

1. Create a new department → function picker appears
2. Select "Product (Software)" → repo setup (local/repo/both) + mode toggle appears
3. Select "Marketing" → working directory input + mode toggle appears
4. Create department → check Properties panel → Workspace Policy section visible with correct defaults
5. Toggle mode + check override → changes persist
6. Expand Advanced (software dev only) → fill fields, blur → saves
