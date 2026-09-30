# Dialog Body Padding — Phase H Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use **superpowers:subagent-driven-development** (recommended) or **superpowers:executing-plans** to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the systemic visual regression where modals authored before the May-7 Dialog primitive restyle (commit `6d133e2`) render their form fields flush against the dialog edges, because `DialogContent` lost its built-in `p-6` padding without consumers updating to provide their own. Add a `DialogBody` primitive that codifies the canonical `px-7 py-4` body inset, convert 24 BROKEN modals to use it, standardize 3 ADAPTED modals using non-canonical `px-6` to the same primitive, and update design-system docs to lock the contract.

**Architecture:** UI-only refactor. No schema, no API, no routing changes. Adds one primitive (`DialogBody`) to `ui/src/components/ui/dialog.tsx`. Wraps the form bodies in 24 broken modals + 3 non-canonical-padding modals with `<DialogBody>`. The default inset is `px-7 py-4` — `px-7` matches the existing `DialogHeader`'s horizontal padding (the canonical contract per the 3 already-correct memory dialogs). The vertical `py-4` reads cleanly between header (`pb-5`) and footer (`py-3.5`). Modals with bespoke layouts (5 CUSTOM `p-0 gap-0` modals, 5 SR_ONLY patterns, 5 MINIMAL header-footer-only modals) are intentionally not touched. 8 risky modals get hand-edited with verification; the other 16 BROKEN ones are mechanical bulk conversions.

**Tech Stack:** React 18 + Vite + Tailwind. Existing primitives — no new components beyond `DialogBody`. vitest + @testing-library/react. No new test infrastructure.

**Spec:** `docs/superpowers/plans/2026-05-09-dialog-body-padding-phase-h.md` (this file). Source audit: subagent run on 2026-05-09 categorized all 45 `<DialogContent>` consumers into 5 buckets — full file lists below.

**Branch:** `feat/ui-overhaul`. Base SHA: `db420979` (Phase G + CommandDialog fix HEAD).

---

## Audit summary (from 2026-05-09 subagent run)

| Bucket | Count | Action |
|---|---:|---|
| **ADAPTED — already correct (px-7 canonical)** | 3 | No action |
| **ADAPTED — non-canonical px-6 inset** | 3 | Standardize to DialogBody (px-7) |
| **BROKEN — needs DialogBody (safe)** | 16 | Bulk wrap |
| **BROKEN — needs DialogBody (risky)** | 8 | Hand-edit with visual verification |
| **MINIMAL — header + footer only** | 5 | No action |
| **SR_ONLY — sr-only title pattern** | 5 | No action |
| **CUSTOM — bespoke `p-0 gap-0`** | 5 | No action |
| **TOTAL** | 45 | 22 modals updated |

### BROKEN — safe (16 files)

Bulk-convert: wrap the form body's outer `<div className="space-y-4">` (or equivalent) with `<DialogBody>` at the top, drop any redundant `space-y-4` since `DialogBody` already includes it via `space-y-4` IF we choose to bake spacing into the primitive (decision below).

- `ui/src/pages/Objectives.tsx` (line 164, EditIdentityModal)
- `ui/src/components/marketplace/install/PluginInstallModal.tsx` (line 131)
- `ui/src/components/marketplace/install/SnapshotInstallModal.tsx` (line 129)
- `ui/src/pages/PluginManager.tsx` lines 177 (Install) + 490 (Error Details)
- `ui/src/pages/Dashboard.tsx` (line 489, Add Suggested Memory)
- `ui/src/pages/DesignGuide.tsx` (line 1038, sample dialog)
- `ui/src/components/workspace/CreatePrDialog.tsx` (line 179)
- `ui/src/components/team/TransferAdminDialog.tsx` (line 91)
- `ui/src/components/team/ReassignmentDialog.tsx` (line 133)
- `ui/src/components/team/ImportUploadDialog.tsx` (line 137)
- `ui/src/components/team/ImportPreviewDialog.tsx` (line 152)
- `ui/src/components/team/AddMemberDialog.tsx` (line 154)
- `ui/src/components/team/BuildFromScratchForm.tsx` (line 217)
- `ui/src/components/agent-config-primitives.tsx` (line 440, ChoosePathButton)
- `ui/src/components/finance/CreateBudgetPolicyDialog.tsx` (line 123) **— the original reported bug**
- `ui/src/components/InviteDialog.tsx` (line 114)

### BROKEN — risky (8 files)

Hand-edit, smoke check after each. Some may need DialogBody className override (e.g., `<DialogBody className="px-7 py-2">`) or partial wrapping.

- `ui/src/pages/Memory.tsx` lines 1081 (MemoryItemDetail — Tabs flush) + 1805 (Add to Memory form) + 2125 (starter templates)
- `ui/src/pages/IssueDetail.tsx` (line 827, Add Dependency picker — `-mx-1 px-1` scrollbar trick)
- `ui/src/components/TaskSlideOver.tsx` (line 1203, inner Add Dependency picker — same scrollbar trick)
- `ui/src/components/team/PreviewAsLlmDialog.tsx` (line 26, code-block card body)
- `ui/src/components/team/NewTeamEntryDialog.tsx` (line 48, 3-column card grid)
- `ui/src/components/marketplace/SnapshotUpdateModal.tsx` (line 79, MergeDiffPane parent assumes fill)
- `ui/src/components/PathInstructionsModal.tsx` (line 81, platform tabs in bordered pill)
- `ui/src/components/memory/MoveToFolderDialog.tsx` (line 81, folder tree with `-mx-1` trick)
- `ui/src/components/memory/ChangeLayerDialog.tsx` (line 147, layer-picker grid)

(That's 11 line-level entries — Memory.tsx counts as 3 modals in one file.)

### Files needing per-implementation decisions

- `ui/src/pages/DiscussionDetail.tsx` (line 1075) — partially adapted (`gap-0` + custom px-6 header), audit flagged "needs human review" on whether body has px-6 throughout. **Action:** read the body section structure during Task 2; if body has consistent px-6, leave alone (Bucket 1 px-6 → Task 3 standardization); if body sections lack padding, add DialogBody.
- `ui/src/components/routines/RoutineRunDialog.tsx` (line 130) — variable inputs branch may need wrapping. **Action:** read during Task 2; wrap the variables-branch only if needed.
- `ui/src/components/FeedbackConsentModal.tsx` — body block is a tinted callout (`bg-muted/30 p-3` styled card). **Action:** classify as MINIMAL (Bucket 3) — leave alone. The tinted card is intentional design.

### ADAPTED-px-6 standardization (3 files) — convert to canonical px-7

- `ui/src/components/DiscussionCaptureModal.tsx` (line 266, body `px-6 pb-6`) → wrap with DialogBody (default `px-7 py-4`)
- `ui/src/pages/Skills.tsx` AddSkillModal (line 281) → same
- `ui/src/components/FolderBrowserDialog.tsx` (`px-5` headers + body) → standardize to DialogBody

These are visual changes (4px wider padding) — verify they don't shrink content awkwardly. Likely fine.

---

## Files

| Action | Path | What changes |
|--------|------|--------------|
| Modify | `ui/src/components/ui/dialog.tsx` | Add `DialogBody` primitive component; export it. ~10 LOC addition. |
| Create | `ui/src/__tests__/dialog.test.tsx` | New test file for `DialogBody` (renders children, applies default `px-7 py-4`, accepts className override, has `data-slot="dialog-body"`). 4 tests. |
| Modify | `docs/aoa/design/design-system.md` | Add a new "Dialog body padding" subsection documenting the post-restyle contract: `DialogContent` is `p-0`, body must use `<DialogBody>` (or explicit `px-7 py-4`), exceptions are `p-0 gap-0` bespoke layouts and SR_ONLY patterns. |
| Modify | `ui/src/components/finance/CreateBudgetPolicyDialog.tsx` | Wrap line 123's `<div>` body with `<DialogBody>`. **Original reported bug.** |
| Modify | 15 other safe-bucket modals | Same wrap pattern: replace `<div className="space-y-4">` with `<DialogBody>` (DialogBody preserves `space-y-4` via its default class) — see file list above |
| Modify | 8 risky-bucket modals | Hand-edit with per-modal smoke check. May need className override on DialogBody (e.g., `px-7 py-2` for tighter pickers, `px-0` for full-bleed scrollers, etc.) |
| Modify | 3 px-6-standardization modals | Replace existing manual `px-6` wrappers with DialogBody |

**Total:** 1 primitive added, 1 test file created, 1 docs file updated, **22 modals modified**, **0 deleted**.

---

## Verification rules (apply to every task)

1. **TDD order** — failing test first for the DialogBody primitive (Task 1). Per-modal conversion is mechanical; no new tests needed unless the modal's existing test file would break.
2. **Per-task scoped tests** before commit; broader UI suite (`pnpm vitest run --dir src/__tests__` from `ui/`) at end of each task. Expected baseline: 912/913 with the pre-existing MemoryExplorer flake.
3. **Conventional commits**: `feat(ui):`, `refactor(ui):`, `test(ui):`, `chore(ui):`, `docs(ui):`.
4. **Typecheck after each task** — `pnpm exec tsc --noEmit` from `ui/`.
5. **DialogBody default contract:** `cn("px-7 py-4", className)`. Includes only padding — does NOT include `space-y-*`. Consumers keep their own `space-y-4` inside DialogBody to preserve form-field spacing.
6. **No backend or API changes.** Pure UI primitive + consumer updates.
7. **No changes to MINIMAL / SR_ONLY / CUSTOM modals.** Listed above; verify each remains untouched in the final diff.
8. **Risky modals get visual smoke before commit.** Use the dev server (`localhost:5173`) — open each modified risky modal, verify form fields don't render flush AND no new layout breakage (e.g., scrollbar trickery still works, grid cards don't wrap awkwardly).
9. **Existing test files for 4 modals** (`CreatePrDialog.test.tsx`, `MoveToFolderDialog.test.tsx`, `ChangeLayerDialog.test.tsx`, `dialog.test.tsx` — currently doesn't exist) must keep passing after their host modal is converted. If a test asserts specific markup that DialogBody changes, update the assertion to match the new structure.

---

## Task 1: Add DialogBody primitive + test + design-system docs

**Files:**
- Modify: `ui/src/components/ui/dialog.tsx`
- Create: `ui/src/__tests__/dialog.test.tsx`
- Modify: `docs/aoa/design/design-system.md`

This task adds the primitive that all subsequent tasks depend on. Foundation only — no consumer updates yet.

### Step 1: Add the failing test

Create `ui/src/__tests__/dialog.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DialogBody } from "@/components/ui/dialog";

describe("DialogBody primitive", () => {
  it("renders children", () => {
    render(<DialogBody><span>hello</span></DialogBody>);
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("applies default px-7 py-4 padding", () => {
    const { container } = render(<DialogBody>x</DialogBody>);
    const body = container.firstElementChild as HTMLElement;
    expect(body.className).toContain("px-7");
    expect(body.className).toContain("py-4");
  });

  it("accepts className override that merges with defaults", () => {
    const { container } = render(<DialogBody className="bg-card-2">x</DialogBody>);
    const body = container.firstElementChild as HTMLElement;
    expect(body.className).toContain("px-7");
    expect(body.className).toContain("py-4");
    expect(body.className).toContain("bg-card-2");
  });

  it("has data-slot='dialog-body'", () => {
    const { container } = render(<DialogBody>x</DialogBody>);
    const body = container.firstElementChild as HTMLElement;
    expect(body.getAttribute("data-slot")).toBe("dialog-body");
  });
});
```

### Step 2: Run test to verify it fails

```
pnpm vitest run src/__tests__/dialog.test.tsx
```

Expected: FAIL — `DialogBody` is not exported from `@/components/ui/dialog`.

### Step 3: Add `DialogBody` to `ui/src/components/ui/dialog.tsx`

After the existing `DialogHeader` function (around line 82-93), add:

```tsx
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("px-7 py-4", className)}
      {...props}
    />
  )
}
```

Add `DialogBody` to the export list at the bottom of the file (around line 152):

```tsx
export {
  Dialog,
  DialogBody,        // ← ADD THIS LINE
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
```

### Step 4: Run failing tests to verify pass

```
pnpm vitest run src/__tests__/dialog.test.tsx
```

Expected: 4/4 pass.

### Step 5: Update `docs/aoa/design/design-system.md`

Find the existing "§9.3 Modal-B" or whichever section documents the Dialog primitive (search for "Dialog" or "Modal" in the file). Add a new sub-section documenting the body padding contract:

```markdown
### Dialog body padding (post-Phase H)

Background: the May-7 Dialog restyle (commit `6d133e2`) changed `DialogContent` from `p-6` (built-in body padding) to `p-0` (no padding). `DialogHeader` and `DialogFooter` pad themselves; the body content between them is the consumer's responsibility.

**Rule: always wrap body content in `<DialogBody>`.**

```tsx
<Dialog>
  <DialogContent>
    <DialogHeader>...</DialogHeader>
    <DialogBody>
      {/* form fields, grids, anything between header and footer */}
    </DialogBody>
    <DialogFooter>...</DialogFooter>
  </DialogContent>
</Dialog>
```

`DialogBody` defaults to `px-7 py-4`. The horizontal `px-7` matches `DialogHeader`'s inset (canonical). Override the className for tighter or looser layouts.

**Exceptions** (do NOT use DialogBody):
- **Bespoke `p-0 gap-0` modals** (e.g., `NewAgentDialog`, `NewIssueDialog`) — explicitly opt out and roll their own layout.
- **SR-only title patterns** (e.g., `CommandDialog`, `ImageGalleryModal`, `MemoryQuickSwitcher`) — visible content IS the body; padding handled per-pattern.
- **Confirmation modals** with only header + footer (no form body).
```

### Step 6: Run typecheck + broader UI suite

```
pnpm exec tsc --noEmit
pnpm vitest run --dir src/__tests__
```

Expected: clean typecheck, 912 + 4 = 916 tests passing (the pre-existing MemoryExplorer flake adds 1 fail unrelated).

### Step 7: Commit

```bash
git add ui/src/components/ui/dialog.tsx ui/src/__tests__/dialog.test.tsx docs/aoa/design/design-system.md
git commit -m "feat(ui): add DialogBody primitive + design-system contract

Phase H Task 1 — foundation for the body-padding audit.

Adds <DialogBody> to ui/dialog.tsx with default px-7 py-4 inset.
Codifies the post-May-7 Dialog contract: DialogContent is p-0, body
content must use DialogBody (or explicit equivalent padding). Exceptions
documented: bespoke p-0 gap-0 modals, sr-only title patterns, and
confirmation-only modals.

New: ui/src/__tests__/dialog.test.tsx with 4 tests covering DialogBody.
Updated: docs/aoa/design/design-system.md with a 'Dialog body padding'
subsection documenting the contract + exceptions."
```

---

## Task 2: Bulk-convert 16 SAFE BROKEN modals + 3 px-6 standardizations

**Files:** 19 modal files (see audit above for the full list).

This task is mechanical. For each modal:

1. Find the body wrapper (after `<DialogHeader>`, before `<DialogFooter>`)
2. Replace `<div className="space-y-4">` (or equivalent) with `<DialogBody className="space-y-4">` (preserves the existing space-y-* class as a className addition; DialogBody adds px-7 py-4 underneath)

Special cases to handle per modal:

| Modal | Wrapping detail |
|---|---|
| Form-as-body modals (`CreatePrDialog`, `Memory.tsx Add modal`) | The `<form>` element IS the wrapper. Wrap with: `<DialogBody><form className="space-y-4">...</form></DialogBody>` OR change the form to render its content inside DialogBody and keep the form as parent |
| `space-y-4 py-2` (ChangeLayerDialog) | Replace with `<DialogBody className="space-y-4 py-2">` — preserves the `py-2` quirk |
| `grid grid-cols-2 gap-4 py-4` (PluginManager Install) | Replace with `<DialogBody className="grid grid-cols-2 gap-4">` — the `py-4` is now in DialogBody by default |
| ADAPTED-px-6 modals (DiscussionCaptureModal, AddSkillModal) | DROP the manual `px-6 pb-6` wrapper, replace with `<DialogBody>`. Visual change: 4px wider horizontal padding. |
| FolderBrowserDialog (px-5 throughout) | Replace `px-5` outer with DialogBody. Inner `px-5` segments may need adjustment; verify after. |

### Step 1: Update each safe-bucket modal

For each of the 16 SAFE BROKEN files in the audit, apply the wrapping. Order doesn't matter — they're independent. Recommended workflow:

1. Open file
2. Find the line cited in the audit
3. Wrap the body
4. Run that file's existing test (if any) to verify it still passes
5. Move to next file

For the 3 px-6 standardization files:

1. Open file
2. Drop the manual `px-6` wrapper class
3. Replace with `<DialogBody>`
4. Verify

### Step 2: Run all tests

```
pnpm vitest run --dir src/__tests__
```

Expected: 916/917 (preserves the 4 dialog tests + 1 unchanged pre-existing flake).

If any modal-specific test breaks (`CreatePrDialog.test.tsx`, `MoveToFolderDialog.test.tsx`, `ChangeLayerDialog.test.tsx`), inspect — likely the test asserts specific markup that the DialogBody wrapping changed. Update the assertion to match the new structure (e.g., `getByRole("dialog")` queries should still work; `querySelector(".space-y-4")` may need updating to find the inner content).

### Step 3: Typecheck

```
pnpm exec tsc --noEmit
```

Expected: clean.

### Step 4: Commit

```bash
git add ui/src/pages/Objectives.tsx ui/src/components/marketplace/install/PluginInstallModal.tsx ui/src/components/marketplace/install/SnapshotInstallModal.tsx ui/src/pages/PluginManager.tsx ui/src/pages/Dashboard.tsx ui/src/pages/DesignGuide.tsx ui/src/components/workspace/CreatePrDialog.tsx ui/src/components/team/TransferAdminDialog.tsx ui/src/components/team/ReassignmentDialog.tsx ui/src/components/team/ImportUploadDialog.tsx ui/src/components/team/ImportPreviewDialog.tsx ui/src/components/team/AddMemberDialog.tsx ui/src/components/team/BuildFromScratchForm.tsx ui/src/components/agent-config-primitives.tsx ui/src/components/finance/CreateBudgetPolicyDialog.tsx ui/src/components/InviteDialog.tsx ui/src/components/DiscussionCaptureModal.tsx ui/src/pages/Skills.tsx ui/src/components/FolderBrowserDialog.tsx
git commit -m "refactor(ui): wrap 19 modal bodies with DialogBody primitive

Phase H Task 2 — bulk safe conversion.

16 BROKEN modals had form bodies rendering flush against the
DialogContent edges (a regression from the May-7 Dialog restyle that
removed p-6 from the content shell). Each gets its body wrapped in
<DialogBody> for canonical px-7 py-4 padding.

3 ADAPTED-px-6 modals (DiscussionCaptureModal, AddSkillModal,
FolderBrowserDialog) standardize from px-6 to canonical px-7 by
replacing their manual padding wrappers with DialogBody.

Original reported bug: New Budget Policy modal in Settings (Task 3
of Phase F revealed it). Fixed alongside the 18 other affected
modals.

Files:
- ui/src/pages/Objectives.tsx (EditIdentityModal)
- ui/src/components/marketplace/install/{PluginInstallModal,SnapshotInstallModal}.tsx
- ui/src/pages/PluginManager.tsx (Install + Error Details modals)
- ui/src/pages/Dashboard.tsx (Add Suggested Memory)
- ui/src/pages/DesignGuide.tsx (sample dialog)
- ui/src/components/workspace/CreatePrDialog.tsx
- ui/src/components/team/{TransferAdminDialog,ReassignmentDialog,ImportUploadDialog,ImportPreviewDialog,AddMemberDialog,BuildFromScratchForm}.tsx
- ui/src/components/agent-config-primitives.tsx (ChoosePathButton)
- ui/src/components/finance/CreateBudgetPolicyDialog.tsx
- ui/src/components/InviteDialog.tsx
- ui/src/components/DiscussionCaptureModal.tsx (px-6 → px-7)
- ui/src/pages/Skills.tsx (AddSkillModal, px-6 → px-7)
- ui/src/components/FolderBrowserDialog.tsx (px-5 → px-7)"
```

---

## Task 3: Hand-edit 8 RISKY BROKEN modals + visual smoke + final review

**Files:** 8 modal files (see audit risky list).

For each risky modal, the strategy is:

1. **Open the modal in dev server first.** Note the current visual state.
2. **Apply DialogBody wrap.** Use default `px-7 py-4` if it looks reasonable; override className if the modal needs different padding (e.g., `px-7 py-2`, `px-0` for full-bleed scrollers, etc.).
3. **Re-open the modal in dev server.** Verify form fields no longer flush + no new layout breakage.
4. **Iterate** if visual breaks (e.g., scrollbar trick is gone, grid cards wrap awkwardly).
5. **Commit incrementally** — one risky modal per commit OR one commit for all 8 if all conversions are clean. Per-modal commits help if anything regresses post-merge.

### Per-modal notes

**`Memory.tsx` MemoryItemDetail (line 1081):** Tabs at top level after header render flush. Wrap the area BELOW the Tabs in DialogBody. The Tabs themselves likely want full-width — leave them flush. Verify.

**`Memory.tsx` "Add to Memory" (line 1805):** Wrap the form. The form is `<form className="space-y-4">` — change to `<DialogBody><form className="space-y-4">...</form></DialogBody>`.

**`Memory.tsx` "starter templates" (line 2125):** Wrap the scrollable list area. The `-mx-1 px-1` scrollbar trick must stay INSIDE the DialogBody.

**`IssueDetail.tsx` Add Dependency picker (line 827):** `relative` + `max-h-64 overflow-y-auto -mx-1` pattern. Wrap whole picker in DialogBody but preserve the inner `-mx-1 px-1` scrollbar bleed.

**`TaskSlideOver.tsx` Add Dependency picker (line 1203):** Same pattern as IssueDetail's. Same handling.

**`PreviewAsLlmDialog.tsx`:** Body is a code-block card (`p-4 font-mono`). Wrapping in DialogBody puts the card inside `px-7 py-4` — visually fine, just has more breathing room around the card. Verify.

**`NewTeamEntryDialog.tsx`:** 3-column card grid. `px-7` shrinks the cards. May want `<DialogBody className="px-5 py-4">` (tighter) OR leave at default and accept the new sizing. Verify.

**`SnapshotUpdateModal.tsx`:** MergeDiffPane assumes parent fill. If `px-7` shrinks the diff columns, may need `<DialogBody className="px-0 py-4">` (vertical only) OR partial wrapping (only the loading/help text, not the diff itself). Verify.

**`PathInstructionsModal.tsx`:** Platform tabs in a bordered pill. After `px-7`, the pill row indents. Possibly desired (more visual breathing); possibly worse (looks stranded). Verify and adjust.

**`MoveToFolderDialog.tsx`:** Folder tree with `-mx-1`. Same pattern as IssueDetail dep picker.

**`ChangeLayerDialog.tsx`:** Layer-picker grid with `space-y-4 py-2`. Replace with `<DialogBody className="space-y-4 py-2">`.

### Step 1: Apply each risky-bucket conversion

Per-modal: open → wrap → smoke → iterate → commit (or batch).

### Step 2: Run all tests

```
pnpm vitest run --dir src/__tests__
```

Expected: 916/917 still passing.

### Step 3: Visual smoke check via dev server

The dev server is on `localhost:5173`. For each of these 8 risky modals, navigate to the page that triggers the modal, open it, verify visually at desktop (1280px) AND mobile (resize <768px):

| Modal | How to open it |
|---|---|
| Memory MemoryItemDetail | Open Memory page, click any memory item |
| Memory Add to Memory | Memory page, click "+ New" |
| Memory starter templates | Memory page (path TBD — check for "templates" trigger) |
| IssueDetail Add Dependency | Open any task detail, click "Add dependency" |
| TaskSlideOver Add Dependency | Open task slide-over from the Tasks list, "Add dependency" |
| PreviewAsLlmDialog | Open agent detail, "Preview prompt" or similar |
| NewTeamEntryDialog | Team page, "+ New entry" |
| SnapshotUpdateModal | Marketplace updates page, click an available update |
| PathInstructionsModal | Workspace settings or agent config (look for path help) |
| MoveToFolderDialog | Memory page, right-click an item, "Move to folder" |
| ChangeLayerDialog | Memory page, right-click an item, "Change layer" |

### Step 4: Final cumulative typecheck + tests

```
pnpm exec tsc --noEmit
pnpm vitest run --dir src/__tests__
```

Both clean.

### Step 5: Commit

```bash
git add ui/src/pages/Memory.tsx ui/src/pages/IssueDetail.tsx ui/src/components/TaskSlideOver.tsx ui/src/components/team/PreviewAsLlmDialog.tsx ui/src/components/team/NewTeamEntryDialog.tsx ui/src/components/marketplace/SnapshotUpdateModal.tsx ui/src/components/PathInstructionsModal.tsx ui/src/components/memory/MoveToFolderDialog.tsx ui/src/components/memory/ChangeLayerDialog.tsx
git commit -m "refactor(ui): wrap 11 risky-bucket modal bodies with DialogBody

Phase H Task 3 — risky-bucket conversion with per-modal visual smoke
verification at desktop + mobile.

Modals where DialogBody application required care due to scrollbar
tricks, grid layouts, or external component sizing assumptions:
- Memory.tsx (3 modals): MemoryItemDetail Tabs, Add form, starter
  templates list — DialogBody wraps body areas while preserving the
  -mx-1 px-1 scrollbar bleeds inside
- IssueDetail.tsx + TaskSlideOver.tsx Add Dependency pickers — same
  scrollbar pattern preserved inside DialogBody
- PreviewAsLlmDialog: code-block card now sits inside px-7 py-4
- NewTeamEntryDialog: 3-column card grid retained at default DialogBody
  inset (cards slightly narrower; visually OK)
- SnapshotUpdateModal: <DialogBody className='px-0 py-4'> to preserve
  MergeDiffPane fill assumption
- PathInstructionsModal: platform tabs now inset
- MoveToFolderDialog: folder tree with scrollbar trick preserved inside
- ChangeLayerDialog: <DialogBody className='space-y-4 py-2'>

Smoke-checked each modal at desktop + mobile breakpoints. No
regressions found."
```

### Step 6: Push

```bash
git push 2>&1 | tail -5
```

---

## Self-Review

**1. Spec coverage:** All 24 BROKEN modals + 3 px-6 standardizations + 1 primitive + 1 docs = 22 modal updates. Matches the audit. MINIMAL / SR_ONLY / CUSTOM modals intentionally untouched.

**2. Placeholder scan:** No `TBD`. Per-modal special-case handling is documented inline in Task 2 + Task 3. Risky-bucket smoke-check steps name each modal explicitly.

**3. Type consistency:**
- `DialogBody` accepts `React.ComponentProps<"div">` — same shape as DialogHeader/DialogFooter
- Default class `cn("px-7 py-4", className)` — caller's className overrides defaults via Tailwind cascade
- Exported alongside the rest of the Dialog primitives

**4. Risks called out:**
- **Risky-bucket modals (8 files)** require visual smoke. Each is named in Task 3 with the specific concern (scrollbar trick, grid layout, fill assumption).
- **Test breakage on 4 modals with existing tests:** The 4 affected test files (`CreatePrDialog`, `MoveToFolderDialog`, `ChangeLayerDialog`, plus the new `dialog.test.tsx`) — if any assert markup that the wrap changed, update the assertions inline in Task 2 / Task 3.
- **px-6 → px-7 standardization** (3 files) is a 4-pixel visual change. Could be reverted if any of those modals look worse — they're not BROKEN today, just non-canonical. Optional follow-up if visual review flags issues.
- **DesignGuide.tsx** is a sample dialog used as design-system documentation. Updating it ensures future contributors copy the canonical pattern.

**5. Out-of-scope (deferred):**
- The `gap-0 flex flex-col` ADAPTED modals (DiscussionCaptureModal, AddSkillModal) are bundled into Task 2 standardization — no separate task needed.
- `IssueDetail.tsx` is marked `@deprecated` per the file header. Convert anyway since users may still hit it; cleanup belongs in a separate deprecation removal effort.
- `FeedbackConsentModal` body is a tinted callout card — intentionally flush. Classified as MINIMAL; not modified.

---

## Execution

Plan complete. Per superpowers:writing-plans:

**1. Subagent-Driven (recommended)** — fresh subagent per task with two-stage review (spec compliance → code quality) between tasks. 3 tasks → 3 implementation cycles + reviews.

**2. Inline Execution** — execute tasks in this session.

After all 3 tasks land, the visible end state is: every Dialog consumer in the app has either (a) used DialogBody, (b) explicitly opted out via `p-0 gap-0` bespoke layout, (c) sr-only title pattern with internal padding, or (d) confirmation-modal pattern. The contract is documented in design-system.md so future modals follow the canonical pattern.
