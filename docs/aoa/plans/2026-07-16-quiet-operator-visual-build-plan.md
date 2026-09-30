# Quiet Operator Visual Build — Implementation Plan (v2, post-review)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline, screenshot checkpoint per task). Visual work — every task ends with rendered proof, not just green tests.
>
> **Review status:** v1 was adversarially reviewed against the real codebase (fix-then-execute verdict); this v2 incorporates every correction. Key review findings baked in: NO `overflow-hidden` on the frame (clips in-frame mention popovers, invisible to Playwright `toBeVisible`); Workspace is already ComposerFrame-wrapped twice; CommentThread's frame wraps the whole panel (card must go around the composer region only); action labels + "Queued after current run" copy are NET-NEW (not "already implemented"); `byteSize` is dropped in `ThreadTab.handleUpload` and must be plumbed; no `progressPct` data source exists; Interrupt is a checkbox flag (restyle only — an immediate-Interrupt button is a semantic change, out of scope).

**Goal:** Make every composer match the approved Quiet Operator boards (`C:\Users\TK\.gstack\projects\aoa-2-5\designs\quiet-operator\*.png`) in the AoA dark theme: one bordered card frame (context strip → tray → editor → toolbar with red Send/Stop → recovery row) across Commander, Discussion, Workspace/Task slide-over, Task Comments.

**Architecture:** Centralize the card chrome (derived from Commander's proven `InternalAgentPanel.tsx:1961` styling, PLUS `shadow-sm` as an intentional addition) in `ComposerFrame chrome="card"`. Hosts keep their functional internals. Functionality is locked by 12 green e2e specs — no task may move `entry-composer-attachments` outside `[data-composer-frame]`, rename load-bearing testids (`entry-composer-submit` is also used by `full-discussion-to-workspace-cycle*.spec.ts` and `helpers/thread-flow.ts:75`), or alter send/mention/interrupt semantics.

**Popover rule (P1, from review):** the frame must NOT clip. Commander mentions (`CommanderInput.tsx:523`) and Discussion autocomplete (`EntryAutocompleteList.tsx:37,47`) are `absolute bottom-full` INSIDE the frame. Never add `overflow-hidden`/`overflow-clip` to the frame; verify popovers by screenshot at every surface checkpoint (Playwright toBeVisible passes on clipped elements).

---

### Task 1: ComposerFrame `chrome="card"`

**Files:** `ui/src/components/composer/ComposerFrame.tsx`, test `ComposerFrame.test.tsx`

- [ ] **Failing test:** `chrome="card"` renders `rounded-lg`, `border-border`, `focus-within:ring-2`; default (`bare`) does not; and the card variant does NOT contain `overflow-hidden`.
- [ ] Run → FAIL.
- [ ] Implement: `chrome?: "bare" | "card"` (default `bare`); card appends exactly:
  `rounded-lg border border-border bg-background shadow-sm focus-within:ring-2 focus-within:ring-brand-focus-ring focus-within:border-brand transition-shadow`
  (Commander's :1961 classes + `shadow-sm`; NO overflow property.)
- [ ] Run → PASS. Commit `feat(composer): ComposerFrame card chrome`.

### Task 2: `ComposerAttachmentCard` (board-accurate, honest about data)

**Files:** create `ui/src/components/composer/ComposerAttachmentCard.tsx` + test; modify `ui/src/pages/DesignGuide.tsx` (§10 obligation) + `.claude/skills/design-guide/references/component-index.md`

- [ ] **Failing test:** renders filename; renders `412 KB` when `byteSize` given and NOTHING when absent (artifact-upload path has no size); `state="ready"` → muted `Ready`; `state="failed"` → destructive `Failed to upload` + Retry (only when `onRetry` given) + Remove; image `previewUrl` → `<img>`; remove has `aria-label="Remove <name>"`.
- [ ] Props: `{ name, byteSize?, state: "uploading"|"ready"|"failed", previewUrl?, onRemove, onRetry? }`. **No `progressPct`** (no data source exists — uploads are single-await `postForm`, `assets.ts:42-54`). `formatBytes` helper (KB/MB, 1 decimal).
- [ ] Implement → PASS. Add a Design Guide section (variants: ready / uploading / failed / image / no-size). Commit `feat(composer): board-accurate attachment card + design-guide entry`.

### Task 3: Discussion (EntryComposer) — card frame + tokens (HIGHEST regression risk)

**Files:** `ui/src/components/threads/EntryComposer.tsx` (:356 frame, :407-438 chips, :535 send), **`ui/src/components/threads/ThreadTab.tsx`** (`handleUpload:416` drops `res.byteSize` — plumb it; extend `AssetRef` with optional `byteSize`), tests: `EntryComposer.test.tsx` + e2e `artifact-lifecycle composer-gaps mention-autocomplete full-discussion-to-workspace-cycle`

- [ ] Keep the outer host strip (`shrink-0 px-4 py-3` on `var(--card)`); render the frame as `chrome="card"` inside it (floating card, not full-bleed `border-t` bar). ALL testids preserved; tray stays inside the frame (containment spec).
- [ ] Chips → `ComposerAttachmentCard` (byteSize from the newly-plumbed field; uploading names → `state="uploading"`; no Retry here — failed-file retention is Commander-only until Task 7).
- [ ] **Token cleanup (design-guide §13):** replace the raw `#b82d1c` Send (:535) with brand-token classes (red Send per scope §14); replace inline `hsl(...)` hint styling with semantic tokens.
- [ ] Toolbar anatomy: 📎 (exists) stays left; Send right, red. (No new `@`/`/` buttons — the `@` trigger is typed; adding toolbar buttons for them is follow-up polish, noted not silently dropped.)
- [ ] UI unit + the four e2e specs green. **Screenshot checkpoint incl. the `@` mention popover open** (clipping check). Commit `feat(discussions): Quiet Operator card composer`.

### Task 4: Workspace chatbars — migrate the TWO existing frames

**Files:** `ui/src/components/workspace/WorkspaceTimeline.tsx` (ComposerFrame instances at **:625 assigned-agent and :711 no-agent fallback**, both with hand-rolled `border border-border rounded-lg overflow-hidden bg-background`), `ChatbarControls.tsx`; NEW unit test `ui/src/components/workspace/__tests__/WorkspaceChatbar.test.tsx` (none exists today — this surface currently has ZERO test coverage)

- [ ] Migrate BOTH instances to `chrome="card"`, deleting the duplicated hand-rolled classes (this REMOVES their `overflow-hidden` — verify no visual bleed; if a child needs corner rounding use `rounded-[inherit]` on that child, never overflow on the frame).
- [ ] Attachment chips → `ComposerAttachmentCard`.
- [ ] **Interrupt: restyle the existing checkbox row only** (`ChatbarControls.tsx:78-88`) — visually offset it below the editor per Board 1 §3, but it REMAINS a flag applied on next Send (`resolveTaskCommentAction`). An immediate-Interrupt button is a semantic change — explicitly out of scope; note for the 07-15 plan's action-label workstream.
- [ ] **"Queued after current run" is NET-NEW copy:** render as the frame's context strip when the task has a live run (derive from the existing `hasLiveRuns`/run state already available to WorkspaceTimeline).
- [ ] Send button → brand-token red.
- [ ] New unit test covers: card chrome present, action resolution (comment vs interrupt flag), queued-notice renders with live run. e2e `software-department-product` green. Screenshot (assigned + fallback chatbars). Commit `feat(workspace): Quiet Operator card chatbars`.

### Task 5: Task Comments — frame the COMPOSER REGION only (restructure)

**Files:** `ui/src/components/CommentThread.tsx` (+ its test)

- [ ] CommentThread's ComposerFrame (:394) wraps the WHOLE panel (heading + scrolling timeline + `sticky bottom-0` composer). **Do NOT put card chrome there** (borders everything; sticky+scroll break). Introduce the card frame around only the `task-comments-composer` region (:417), keeping sticky positioning OUTSIDE the card.
- [ ] Check `MarkdownEditor`'s own border — avoid double-bordering (drop the editor's border inside the card if doubled).
- [ ] Interrupt checkbox here too (:473-484): same restyle-only rule as Task 4.
- [ ] Attachment chips → `ComposerAttachmentCard`; Send → brand red. Unit green; screenshot; commit `feat(tasks): card composer in Comments tab`.

### Task 6: Commander adopts ComposerFrame (honest delta, popover-safe)

**Files:** `ui/src/components/InternalAgentPanel.tsx:1961`; tests: `InternalAgentPanel.inputRefs.test.tsx`, `CommanderInput.test.tsx`, e2e `commander-viewer composer-gaps`

- [ ] Swap the bespoke div for `<ComposerFrame chrome="card">`. **Honest delta (not a no-op):** +`shadow-sm`, +base `flex flex-col min-w-0`, +`data-composer-frame` attribute. Verify: mention popover (`CommanderInput.tsx:523`) renders above the frame unclipped; upload strip + refs tray `border-b` separators compose; SkillPicker anchor (`p-3 relative` at :1952, outside the frame) unaffected.
- [ ] Unit + e2e green (esp. composer-gaps runtime-delivery). **Screenshot with mention popover open.** Commit `refactor(commander): shared ComposerFrame chrome`.

### Task 7: Recovery-state deltas — concrete map (features labeled as features)

Reality anchors (from review):
| Board-2 state | Exists today | Work |
|---|---|---|
| Uploading disables Send | Commander (`InternalAgentPanel.tsx:2151`) + Discussion (`EntryComposer.tsx:332,533`) | Add to Task pane only |
| Upload-failed Retry/Remove | Commander only (:1979-1999) | Discussion/Task need failed-`File` retention state (behavior add — mirror Commander's `failedUploads`) |
| Send-failed banner + Retry/Edit/Discard | **Nowhere** (draft kept via throw, `ThreadTab.tsx:410-413`) | **Feature**: banner UI + Retry (re-submit snapshot) / Edit (restore focus) / Discard, per surface; component test each |
| Offline strip | Only generic `hint` prop | Wire `navigator.onLine` + reconnect listener → hint on all surfaces |
| Drag-over drop zone | WorkspaceTimeline textarea only (:667-668) | **Feature**: add drag/drop to EntryComposer + Commander with in-frame drop zone, copy "…up to **10 MB**" |
| Attachment-only label "Attached N files." | Nowhere as copy | Add fallback presentation label where attachment-only sends render |

- [ ] Implement each as its own commit with a component test; screenshot each state. (Send-failed banner and Discussion drag-drop are the two genuinely new features — TDD them.)

### Task 8: Verification sweep + evidence pack

- [ ] Full UI unit suite green; e2e set green: `artifact-lifecycle composer-gaps commander-viewer mention-autocomplete software-department-product thread-controls-and-viewer-regression full-discussion-to-workspace-cycle`.
- [ ] Screenshots: every surface × (empty / with-attachments / popover-open / failure state) × (1280 / compact / 375) → `test-results/composer-visual/`; present against the boards.
- [ ] Update the 07-15 plan §10 + completion-plan checklist; note descoped items (action labels, immediate-Interrupt, toolbar `@`// buttons) for their own workstream.
- [ ] Commit `docs(composer): Quiet Operator visual build evidence`.

---

## Self-review (v2)
- Every review finding (a)-(d) is incorporated; the two fabrications are corrected (labels, queued-copy = net-new); byteSize plumbing + ThreadTab is in Task 3's file list; progressPct removed; Task 5 is a restructure, not "same adoption"; Task 4 names both frame instances + creates the missing test coverage.
- Risk order preserved: Task 3 highest (7 spec dependencies) → executed with the full e2e set, popover screenshot mandatory.
- Design-guide obligations: §10 design-guide page entry (Task 2), §13 token violations fixed in-place (raw hex at EntryComposer:535).
