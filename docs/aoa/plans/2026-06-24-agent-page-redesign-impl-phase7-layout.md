# Agent Page Redesign — Phase 7 (Layout / width / two-pane) Plan

> Follow-up from live user review. Goal: fix width usage + responsiveness across tabs, move Instructions to the real resizable panel system, and make the Save affordance obvious. Then proper feature testing.

**Goal:** Make Config / Skills / Instructions use the full content width responsively (no left-hugging / empty right), per the live review.

**Decisions (from user):** responsive + scalable with a *subtle* cap; Config = 2-column section-card grid; Instructions = our `react-resizable-panels` system (as in MemoryExplorer/Workspace); Skills = fill width; Save affordance = my call.

**Run from:** `C:/Users/TK/.aoa/wt/agent-page-redesign`. Verify: `pnpm --filter @armyofagents/ui exec tsc -p tsconfig.json --noEmit`, `pnpm --filter @armyofagents/ui test:run`, live via `/browse` on :3210 at narrow + wide viewports.

---

### Root cause (measured live)
Content area = 1060px. Overview fills it. **Config card = 768px (`max-w-3xl`, AgentDetail.tsx:916)** and **Skills = 768px (`max-w-3xl`, AgentSkillsTab.tsx:142)** → ~290px dead space on the right. Instructions is full-width but carries an extra "Loaded skills" card and a non-panel two-pane; Save bar floats top-right (easy to miss).

---

### Task 1 — Config: 2-column responsive grid
- `AgentConfigurePage` (AgentDetail.tsx:916): replace `max-w-3xl` with full width + a subtle cap (`max-w-[1400px]`).
- `AgentConfigForm` **cards (edit) layout**: wrap the five section cards (Identity, Adapter, Permissions & Configuration, Run Policy, Context) in a responsive grid `grid grid-cols-1 lg:grid-cols-2 gap-4 items-start`. Create-mode (inline) layout unchanged. Each section card already has `border rounded-lg`; they become grid cells.
- API-keys + Revisions accordions stay full-width below the grid.
- Verify: edit a field → Save bar still raises; 2 columns on ≥lg, 1 on narrow.

### Task 2 — Skills: fill width
- `AgentSkillsTab.tsx:142`: drop `max-w-3xl`; use full width with a subtle cap (`max-w-[1400px]`). Rows already span; on ≥xl, render Attached/Available lists in a 2-column grid of rows for very wide screens (optional, behind `xl:`). Keep readable.

### Task 3 — Instructions: panel-system two-pane + remove Loaded-skills + Save affordance
- **Remove** the "Loaded skills" card block (AgentInstructionsTab.tsx ~820–850) and its helper if now unused.
- **Two-pane:** replace the current flex file-panel + editor with `Group orientation="horizontal"` + `Panel` (file rail, `defaultSize="22%"`, `minSize="14%"`, collapsible) + `Separator` (col-resize) + `Panel` (editor, fills). Wrap in a height container so the panels have room: `h-[calc(100vh-19rem)] min-h-[480px]` (hero+tabs ≈ 19rem). Each pane content in a `rounded-xl border border-border bg-background` shell (matches MemoryExplorer). Mobile (`isMobile`) keeps the existing list↔editor toggle (no side-by-side).
- **Save affordance:** add an explicit Save/Cancel in the editor pane header, wired to the existing `isDirty` / `onSaveActionChange` / `onCancelActionChange` (the floating page bar stays too). Verify it appears the moment `draft !== currentContent`.
- **Verify create/edit/.md:** create a new `.md`, type, Save, reload → persists.

### Task 4 — Responsive pass
- Test all three tabs at 1920 / 1280 / 768 / 390 widths via `/browse viewport`. No horizontal scroll; 2-col collapses to 1-col on narrow; two-pane → stacked/toggle on mobile.

### Task 5 — Proper feature testing (the "test everything" ask)
- **Component tests:** Config renders all sections in a grid + Save-bar raise on edit; Skills fills width + toggle/rollback; Instructions Save button enables on edit + create-file flow.
- **Full UI suite** green (`pnpm --filter @armyofagents/ui test:run`).
- **Live E2E-style walkthrough** on :3210: Config edit → Save → revision; Skills toggle persists; Instructions create `.md` + edit + Save + reload persists; responsive at 3 widths. Screenshot each for the report.

---

### Self-review
- Width caps removed where they hurt; replaced with grid (Config) / fill (Skills) / panels (Instructions) + a subtle `max-w-[1400px]` so ultrawide stays readable.
- Risk: Config grid wrapping must not break the form's save wiring (sections stay inside the `<form>`); Instructions panel needs a height container or it collapses (react-resizable-panels needs bounded height). Both verified live before done.
