# Composer B-States Implementation Plan (approved mock §5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Failure never eats your work" — the four failure/edge states from the approved mock §5 (send-failed banner with Retry/Edit/Discard, offline strip, drag-over with 10 MB copy, per-file upload Retry) land identically on all four composer surfaces, plus the F7/F8 polish deferrals.

**Architecture:** Three new shared pieces in `ui/src/components/composer/` (`ComposerSendFailedBanner`, `ComposerOfflineStrip`, `useComposerDragDrop`+`ComposerDropOverlay`) that the four surfaces consume — same shared-first strategy that killed toolbar drift. Send-failure state is host-owned (each surface already preserves drafts on failure; the banner is presentation + actions over that existing behavior). Offline comes from the existing `useLiveUpdates().connectionState` (app-wide provider). CRITICAL INVARIANT: ComposerFrame must NEVER gain `overflow` (locked P1 — mention popovers render `absolute bottom-full` inside it); the drop overlay is `absolute inset-0` INSIDE the frame, which needs no overflow.

**Tech Stack:** React 19 + Tailwind v4 tokens, vitest + @testing-library/react, Playwright e2e (`AOA_E2E_PORT=3179 AOA_E2E_FORCE_WINDOWS=1`, fake-claude CLI harness, `page.context().setOffline`, `page.route` for send/upload failure injection).

**Current-state facts the plan builds on (verified 2026-07-16):**
- Discussion (`ThreadTab.tsx:409,497` + `EntryComposer.tsx:343`): failure keeps text/mentions/attachments (clears are post-await), `onSubmitError` → `sendReceipt="failed"` → small "Not sent. Try again." text. Offline hint exists (`thread-composer-offline-hint`, `useLiveUpdates`).
- Workspace (`WorkspaceTimeline.tsx:395`): `onError` keeps draft+files, sets `composerError` string rendered inside the frame. Textarea-only `onDrop` exists (no visual overlay, no frame-wide target).
- Comments (`CommentThread.tsx:334 handleSubmit`): `try { await onAdd… clears } finally {}` — **no catch**: draft survives but the user gets ZERO feedback (silent unhandled rejection). Worst surface today.
- Commander (`InternalAgentPanel.tsx:567`): `failedUploads` retention + per-file Retry ALREADY exists (the model for Discussion). Send-failure catch sites ~1374/1402.
- `COMPOSER_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024` (`packages/shared/src/constants.ts:6`) — the "10 MB" copy source.
- `ComposerAttachmentCard` already supports `state="failed"` + `onRetry`.
- Per-file upload Retry only applies to surfaces that upload EAGERLY on pick: Discussion + Commander. Workspace/Comments send `File[]` with the message — their "retry" is the send-failed banner. The plan reflects this reality; mock §5's "retry per file" row maps to the eager-upload surfaces.

---

## File Structure

| File | Responsibility |
|---|---|
| Create `ui/src/components/composer/ComposerSendFailedBanner.tsx` | The §5 banner: message + Retry/Edit/Discard |
| Create `ui/src/components/composer/ComposerOfflineStrip.tsx` | The §5 offline strip (offline/reconnecting variants) |
| Create `ui/src/components/composer/useComposerDragDrop.ts` | dragenter/leave depth-counter hook → `isDragActive` + drop→files |
| Create `ui/src/components/composer/ComposerDropOverlay.tsx` | `absolute inset-0` dashed overlay with the 10 MB copy |
| Create `ui/src/components/composer/ComposerBStates.test.tsx` | Unit tests for all four pieces |
| Modify `ui/src/components/threads/ThreadTab.tsx` | banner wiring (receipt→banner), Retry payload, drag-drop |
| Modify `ui/src/components/threads/EntryComposer.tsx` | failed-upload retention + per-file Retry; drop overlay mount; clearSignal |
| Modify `ui/src/components/workspace/WorkspaceTimeline.tsx` | banner (replaces composerError for send), offline strip, frame-wide drop overlay |
| Modify `ui/src/components/CommentThread.tsx` | catch + banner (fixes silent failure), offline strip, drop overlay |
| Modify `ui/src/components/InternalAgentPanel.tsx` | banner for send-init failure, offline strip, drop overlay; F7 |
| Modify `ui/src/components/composer/ComposerIconButton.tsx` | F7 default-title fix |
| Modify `ui/src/components/composer/ComposerMentionMenu.tsx` + `useComposerMention.ts` | F8 loading row |
| Create `tests/e2e/composer-b-states.spec.ts` | offline / send-fail / drag / upload-retry, cross-surface |

---

### Task 1: Shared components — banner + offline strip (TDD)

**Files:** Create `ComposerSendFailedBanner.tsx`, `ComposerOfflineStrip.tsx`, `ComposerBStates.test.tsx`

- [ ] **Step 1: failing tests**

```tsx
// ComposerBStates.test.tsx (banner + strip blocks)
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ComposerSendFailedBanner } from "./ComposerSendFailedBanner";
import { ComposerOfflineStrip } from "./ComposerOfflineStrip";

describe("ComposerSendFailedBanner", () => {
  it("renders the locked copy and fires the three actions", () => {
    const onRetry = vi.fn(); const onEdit = vi.fn(); const onDiscard = vi.fn();
    render(<ComposerSendFailedBanner onRetry={onRetry} onEdit={onEdit} onDiscard={onDiscard} />);
    expect(screen.getByTestId("composer-send-failed-banner").textContent)
      .toContain("Failed to send. Your message is saved.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onDiscard).toHaveBeenCalledOnce();
  });
  it("disables Retry while retrying", () => {
    render(<ComposerSendFailedBanner onRetry={() => {}} onEdit={() => {}} onDiscard={() => {}} retrying />);
    expect((screen.getByRole("button", { name: /Retry/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ComposerOfflineStrip", () => {
  it("renders offline copy", () => {
    render(<ComposerOfflineStrip state="offline" />);
    expect(screen.getByTestId("composer-offline-strip").textContent)
      .toContain("You're offline — draft saved. We'll send when you're back.");
  });
  it("renders reconnecting copy and nothing when connected", () => {
    const { rerender, container } = render(<ComposerOfflineStrip state="reconnecting" />);
    expect(screen.getByTestId("composer-offline-strip").textContent).toContain("Reconnecting");
    rerender(<ComposerOfflineStrip state="connected" />);
    expect(container.querySelector('[data-testid="composer-offline-strip"]')).toBeNull();
  });
});
```

- [ ] **Step 2: run — expect FAIL (modules missing).** `npx vitest run ui/src/components/composer/ComposerBStates.test.tsx`

- [ ] **Step 3: implement**

```tsx
// ComposerSendFailedBanner.tsx
/** Approved mock §5: failure never eats your work — the draft/files/tokens
 *  stay in the card; the banner offers Retry / Edit / Discard. Renders INSIDE
 *  the ComposerFrame, above the tray. Host owns the failure state. */
import { AlertTriangle } from "lucide-react";
export function ComposerSendFailedBanner({ onRetry, onEdit, onDiscard, retrying = false }: {
  onRetry: () => void; onEdit: () => void; onDiscard: () => void; retrying?: boolean;
}) {
  return (
    <div role="alert" data-testid="composer-send-failed-banner"
      className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">Failed to send. Your message is saved.</span>
      <span className="flex shrink-0 items-center gap-1.5">
        <button type="button" onClick={onRetry} disabled={retrying}
          className="rounded-md bg-brand px-2.5 py-1 font-semibold text-white disabled:opacity-40">
          {retrying ? "Retrying…" : "Retry"}
        </button>
        <button type="button" onClick={onEdit}
          className="rounded-md border border-border px-2.5 py-1 text-foreground hover:bg-muted/60">Edit</button>
        <button type="button" onClick={onDiscard}
          className="rounded-md border border-border px-2.5 py-1 text-muted-foreground hover:bg-muted/60">Discard</button>
      </span>
    </div>
  );
}
```

```tsx
// ComposerOfflineStrip.tsx
/** Approved mock §5 offline strip. `state` mirrors useLiveUpdates().connectionState. */
import { CloudOff } from "lucide-react";
export type ComposerConnectionState = "connected" | "reconnecting" | "offline";
export function ComposerOfflineStrip({ state }: { state: ComposerConnectionState }) {
  if (state === "connected") return null;
  return (
    <div data-testid="composer-offline-strip"
      className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
      <CloudOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {state === "offline"
        ? "You're offline — draft saved. We'll send when you're back."
        : "Reconnecting… your draft is saved."}
    </div>
  );
}
```

- [ ] **Step 4: run — expect PASS.**
- [ ] **Step 5: commit** `feat(composer): shared send-failed banner + offline strip (mock §5)`

### Task 2: Shared drag-drop — hook + overlay (TDD)

**Files:** Create `useComposerDragDrop.ts`, `ComposerDropOverlay.tsx`; extend `ComposerBStates.test.tsx`

- [ ] **Step 1: failing tests** — dragenter on the container sets `isDragActive`; dragleave (depth-balanced) clears; drop with files calls `onDropFiles` and clears; drop with no files is a no-op; overlay renders the exact copy `Drop files to attach — up to 10 MB each` derived from `COMPOSER_MAX_ATTACHMENT_BYTES` (no hardcoded "10").

```tsx
// ComposerBStates.test.tsx (drag block)
import { renderHook, act } from "@testing-library/react";
import { useComposerDragDrop } from "./useComposerDragDrop";
import { ComposerDropOverlay } from "./ComposerDropOverlay";

function dragEvent(types: string[], files: File[] = []) {
  return {
    preventDefault: vi.fn(), stopPropagation: vi.fn(),
    dataTransfer: { types, files },
  } as unknown as React.DragEvent;
}

describe("useComposerDragDrop", () => {
  it("tracks enter/leave depth and fires onDropFiles", () => {
    const onDropFiles = vi.fn();
    const { result } = renderHook(() => useComposerDragDrop({ onDropFiles }));
    act(() => result.current.dragHandlers.onDragEnter(dragEvent(["Files"])));
    act(() => result.current.dragHandlers.onDragEnter(dragEvent(["Files"]))); // nested child
    expect(result.current.isDragActive).toBe(true);
    act(() => result.current.dragHandlers.onDragLeave(dragEvent(["Files"])));
    expect(result.current.isDragActive).toBe(true); // still inside (depth 1)
    const f = new File(["x"], "a.txt", { type: "text/plain" });
    act(() => result.current.dragHandlers.onDrop(dragEvent(["Files"], [f])));
    expect(onDropFiles).toHaveBeenCalledWith([f]);
    expect(result.current.isDragActive).toBe(false);
  });
  it("ignores non-file drags (text selection)", () => {
    const { result } = renderHook(() => useComposerDragDrop({ onDropFiles: vi.fn() }));
    act(() => result.current.dragHandlers.onDragEnter(dragEvent(["text/plain"])));
    expect(result.current.isDragActive).toBe(false);
  });
});

describe("ComposerDropOverlay", () => {
  it("renders the 10 MB copy from the shared constant", () => {
    render(<ComposerDropOverlay active />);
    expect(screen.getByTestId("composer-drop-overlay").textContent)
      .toContain("Drop files to attach — up to 10 MB each");
  });
  it("renders nothing when inactive", () => {
    const { container } = render(<ComposerDropOverlay active={false} />);
    expect(container.querySelector('[data-testid="composer-drop-overlay"]')).toBeNull();
  });
});
```

- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement**

```tsx
// useComposerDragDrop.ts
/** Frame-wide drag-drop (mock §5). Depth counter because dragenter/leave fire
 *  per child element. Spread `dragHandlers` on the ComposerFrame wrapper div.
 *  File VALIDATION stays in each surface's existing add-files path — this hook
 *  only detects + hands over the File[]. */
import { useCallback, useRef, useState } from "react";
export function useComposerDragDrop({ onDropFiles, disabled = false }: {
  onDropFiles: (files: File[]) => void; disabled?: boolean;
}) {
  const depth = useRef(0);
  const [isDragActive, setDragActive] = useState(false);
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (disabled || !hasFiles(e)) return;
    e.preventDefault(); depth.current += 1; setDragActive(true);
  }, [disabled]);
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (disabled || !hasFiles(e)) return; e.preventDefault();
  }, [disabled]);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (disabled || !hasFiles(e)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragActive(false);
  }, [disabled]);
  const onDrop = useCallback((e: React.DragEvent) => {
    if (disabled || !hasFiles(e)) return;
    e.preventDefault(); depth.current = 0; setDragActive(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) onDropFiles(files);
  }, [disabled, onDropFiles]);
  return { isDragActive, dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
```

```tsx
// ComposerDropOverlay.tsx
/** absolute inset-0 INSIDE the frame — the frame stays overflow-free (P1). */
import { COMPOSER_MAX_ATTACHMENT_BYTES } from "@armyofagents/shared";
const MB = Math.round(COMPOSER_MAX_ATTACHMENT_BYTES / (1024 * 1024));
export function ComposerDropOverlay({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div data-testid="composer-drop-overlay" aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-brand bg-background/85 text-sm font-medium text-foreground">
      Drop files to attach — up to {MB} MB each
    </div>
  );
}
```

- [ ] **Step 4: run — PASS.**  **Step 5: commit** `feat(composer): shared drag-drop hook + overlay (mock §5)`

### Task 3: Discussion — banner, Retry/Edit/Discard, drop overlay, per-file upload Retry

**Files:** Modify `ThreadTab.tsx` (banner state + retry payload + wiring), `EntryComposer.tsx` (failedFiles retention + Retry, drop overlay mount, clearSignal), test in `ui/src/components/threads/__tests__/`

Wiring design (host-owned failure):
- `ThreadTab` keeps `lastFailedPayload` (the exact payload object handed to `handleComposerSubmit`) + `sendFailed: boolean`. On mutation failure: set both (replaces `sendReceipt="failed"` — the "Not sent. Try again." branch is DELETED; "sending/sent" receipts stay).
- **Retry idempotency (REVIEW CHANGE 1 — the client never sends the key today!):** the server replay path exists (`routes/discussions.ts:707` reads `clientSubmissionId`) but NO ui code sends it — the shipped server idempotency is dead from the UI side. Task 3 wires it: (a) mint `clientSubmissionId` via `createComposerSubmissionId()` from `@armyofagents/shared` ONCE per submission inside `handleComposerSubmit`; (b) extend `discussionsApi.addEntry` body + mutation payload to carry it; (c) store it in `lastFailedPayload` so **Retry re-sends the identical body** — an ambiguous failure (request landed, response lost) replays the original instead of double-posting. Do NOT use `buildComposerIdempotencyKey` — it is not the wire field.
- **Edit** clears the banner only (draft + attachments already sit in the composer).
- **Discard** clears banner + `onDraftTextChange?.("")` (ThreadTab does NOT own draft state — `draftText` is an optional pass-through; REVIEW CHANGE 5) + bumps a numeric `clearSignal` prop; `EntryComposer` watches it and clears text/mentions/attachments/failedFiles (covers its uncontrolled-text fallback).
- **Both failure sites feed the banner (REVIEW CHANGE 6):** the `handleComposerSubmit` catch (ThreadTab:409) AND the `onSubmitError` callback (ThreadTab:497) both set `sendFailed` — deleting the "Not sent. Try again." branch (ThreadTab:520) without converting BOTH would silently drop EntryComposer-thrown rejections.
- EntryComposer eager-upload failure (line ~315 catch): instead of dropping the file, push `{ name, file }` to new `failedFiles` state; render `ComposerAttachmentCard state="failed" onRetry={() => retryUpload(file)}` in the tray (retry = remove from failedFiles + run the same upload path). This mirrors Commander's `failedUploads`.
- Drop (REVIEW CHANGE 3 — mechanism decided NOW): `ComposerFrame` does NOT spread rest props. Task 1 therefore ALSO adds an optional `dragHandlers` prop (Pick of onDragEnter/onDragOver/onDragLeave/onDrop) to `ComposerFrameProps`, spread onto the wrapper div, plus `relative` added to the frame's base class list (REVIEW CHANGE 4 — today only Discussion's host className is relative; Workspace :648/:774, Commander :1967, Comments :426 are NOT — without `relative` the inset-0 overlay escapes to an outer ancestor, worst case covering the whole workspace timeline). Update ComposerFrame.test.tsx accordingly. `onDropFiles` → a NEW `handleFiles(files: File[])` extracted from `handleFileChange`'s validation+upload loop (`EntryComposer.tsx:295-320` — that function does not exist yet; REVIEW CHANGE 7); the input handler and drop both call it.
- Offline: keep the existing `thread-composer-offline-hint` behavior but render it through `ComposerOfflineStrip` for visual parity (`state={isOffline ? "offline" : isReconnecting ? "reconnecting" : "connected"}`), replacing the current hint span.

- [ ] Step 1: failing tests — banner appears on submit failure with draft intact; Retry re-submits same payload; Discard clears composer (clearSignal); failed upload renders failed card whose Retry re-uploads; drop overlay activates on dragenter.
- [ ] Step 2: run — FAIL. Step 3: implement per design above. Step 4: run threads suite — PASS (`npx vitest run ui/src/components/threads`). Step 5: commit `feat(discussions): B-states — send-failed banner, upload retry, drag-drop`.

### Task 4: Workspace — banner, offline strip, frame-wide drop overlay

**Files:** Modify `WorkspaceTimeline.tsx`, test `ui/src/__tests__/WorkspaceTimeline.test.tsx`

- Send failure: `onError` sets `sendFailed=true` (KEEP `composerError` for validation errors like size caps — banner is only for transport/submit failure). Banner renders inside the frame above the tray; Retry calls `handleSend()` again (chatInput+selectedFiles kept — verified; the `sendInFlightRef` guard at :450 permits re-invocation); Edit dismisses; Discard clears chatInput/selectedFiles/draft (existing `composerDraft.clearDraft()`).
- **Retry idempotency (REVIEW CHANGE 2):** wire `clientSubmissionId` into `issuesApi.addComment` (JSON body) — server reads it at `routes/issues.ts:1575`. Mint once per submission, reuse on Retry.
- Offline: `useLiveUpdates().connectionState` → `ComposerOfflineStrip`; disable Send when offline. **Mapping rule (REVIEW CHANGE 9):** the REAL union is `"connecting" | "open" | "reconnecting" | "offline"` (`LiveUpdatesProvider.tsx:19` — there is NO "connected") — map BOTH `open` AND `connecting` → `connected` (no strip), else every composer flashes "Reconnecting…" on initial load.
- Drag: replace the textarea-only handlers with the shared hook spread on the frame wrapper (both chatbars); keep `handleComposerDrop`'s validation by routing `onDropFiles={addComposerFiles}`; mount `ComposerDropOverlay` as a direct frame child. NOTE (REVIEW CHANGE 4): the workspace frame is NOT relative today — the mention popover anchors to the INNER editor div (:678/:800), not the frame; relativity comes from the ComposerFrame base-class change in Task 1.
- [ ] Steps: failing tests (banner-on-error + retry resend + offline disables send + overlay) → implement → suite PASS → commit `feat(workspace): B-states wiring`.

### Task 5: Comments — catch the silent failure + full wiring

**Files:** Modify `CommentThread.tsx`, test `ui/src/components/CommentThread.test.tsx`

- `handleSubmit` gets `catch { setSendFailed(true); }` — TODAY'S SILENT FAILURE FIX (body/files survive: clears are post-await; `reopen`/`interrupt`/`reassignTarget` also stay un-reset so Retry re-resolves the same action — correct). Banner above the editor inside the inner card frame; Retry = `handleSubmit()` again; Discard = clear body/files/draft (existing `clearDraft(draftKey)`).
- **Retry idempotency (REVIEW CHANGE 2):** wire `clientSubmissionId` into `issuesApi.addComment` AND `addCommentWithAttachments` (multipart: `form.append("clientSubmissionId", …)`) — server reads both at `routes/issues.ts:1575, 1670`. Mint once per submission, reuse on Retry.
- Offline strip via `useLiveUpdates` + disable Comment button.
- Drag: shared hook on the inner ComposerFrame div; `onDropFiles` routes through the SAME validation as `handleAttachFile` (extract its checks into a local `addCommentFiles(files: File[])` so picker + drop share it — DRY).
- [ ] Steps: failing tests (catch→banner, retry, drop validation reuse) → implement → PASS → commit `feat(tasks): B-states in Comments — silent send failure fixed`.

### Task 6: Commander — banner + offline + drop

**Files:** Modify `InternalAgentPanel.tsx`, tests in `ui/src/__tests__/` (existing InternalAgentPanel suites)

- (REVIEW CHANGE 8 — verified reality) The input is NOT cleared optimistically: `submitCommanderInput` (`InternalAgentPanel.tsx:1057-1073`) clears only `if (accepted)`; failure keeps the text and sets `attachmentError("Message was not sent…")`. The banner REPLACES that fallback message; no restore needed. Real send catch = `InternalAgentPanel.tsx:1016-1028` (NOT 1374/1402). CAVEAT: `accepted === false` also covers mid-stream failures where the server already persisted the user turn — Retry is only safe because Task 6 wires `clientSubmissionId` into `streamAgentChat`'s body (server reads it at `routes/internal-agent.ts:233`; REVIEW CHANGE 2), so a re-send replays instead of duplicating an LLM turn. Discard clears input + attachments.
- Offline strip + disable send.
- Drag: shared hook on the frame; `onDropFiles` → existing `validateCommanderAttachmentFiles` + upload path (same as the attach input's handler).
- [ ] Steps: failing tests → implement → commander suites PASS → commit `feat(commander): B-states wiring`.

### Task 7: F7 + F8 polish

**Files:** Modify `ComposerIconButton.tsx`, `InternalAgentPanel.tsx` (mic), `ComposerMentionMenu.tsx`, `useComposerMention.ts`; tests in `ComposerMentionMenu.test.tsx`

- F7a: `ComposerIconButton` default — `title={comingSoon ? (title ? `${title} — coming soon` : "Coming soon") : title}` (kills "Coming soon — coming soon").
- F7b: Commander mic — drop the native `title` (keep `aria-label`); the Radix `TooltipContent` remains the single tooltip. Same check on the other three mics (they have native title only — fine, keep).
- F8: `useComposerMention` returns `loading` (from `useQuery.isLoading && open`); `ComposerMentionMenu` gains `loading?: boolean` → renders a `composer-mention-loading` row ("Loading teammates…") INSTEAD of the empty state while loading. Wire in WorkspaceTimeline (both menus).
- [ ] Steps: failing tests (no-double-coming-soon; loading row precedence over empty) → implement → PASS → commit `fix(composer): F7 tooltip dedup + F8 mention loading row`.

### Task 8: E2E + full verification + evidence

**Files:** Create `tests/e2e/composer-b-states.spec.ts`

Spec cases (all on Discussion as the canonical surface, one cross-check on Comments):
1. **Send failed → Retry succeeds:** `page.route("**/discussions/*/entries", once abort)` → type+send → banner visible, draft intact → unroute → click Retry → entry appears, banner gone.
2. **Offline:** `page.context().setOffline(true)` → offline strip visible + send disabled (provider flips on the window `offline` event, `LiveUpdatesProvider.tsx:932-941` — Chromium's setOffline fires it) → `setOffline(false)` → strip clears via offline→reconnecting→open, which rides the WS reconnect backoff (1s/2s/…/15s, `LiveUpdatesProvider.tsx:959-963`) — assert "strip gone" with a ≥20s timeout. Fallback if flaky: dispatch `window.dispatchEvent(new Event("offline"))` directly.
3. **Drag-over (FIRST-OF-KIND — no repo precedent for drag dispatch; REVIEW CHANGE 10):** build the DataTransfer IN PAGE CONTEXT — `const dt = await page.evaluateHandle(() => { const d = new DataTransfer(); d.items.add(new File(["x"], "a.txt", { type: "text/plain" })); return d; })` — then `page.dispatchEvent(frameSel, "dragenter", { dataTransfer: dt })` → overlay visible with "10 MB" copy → `"drop"` → attachment card appears. Do NOT attempt mouse-move drags (OS file drags cannot be synthesized).
4. **Upload retry:** `page.route("**/assets/files", once 500)` → pick file → failed card with Retry → unroute → Retry → card flips to Ready.
5. **Comments silent-failure regression:** route-abort the comments POST → banner appears (this is the case that was fully silent before Task 5).

- [ ] Run the new spec: `AOA_E2E_PORT=3179 AOA_E2E_FORCE_WINDOWS=1 npx playwright test --config=tests/e2e/playwright.config.ts composer-b-states --project=chromium` — PASS.
- [ ] Full gates: `npx vitest run server/src ui/src packages` green; composer e2e set (artifact-lifecycle composer-gaps mention-autocomplete commander-viewer agent-context-delivery software-department-product) green.
- [ ] Playwright screenshots of each state vs mock §5 (send-failed, offline, drag-over, failed-upload card) on :3377 — present to the user.
- [ ] Commit `test(e2e): composer B-states spec` + update this plan checkboxes + memory file.

---

## Self-review notes (done at write time)
- Spec coverage: §5 rows — banner ✓ (T1,3-6), offline ✓ (T1,3-6), drag ✓ (T2,3-6), upload-retry ✓ (T3; Commander already has it; Workspace/Comments = banner by design, documented) + F7/F8 ✓ (T7) + evidence ✓ (T8).
- No placeholders: shared-component code is complete; surface wiring specifies exact states/actions and where validation reuse comes from. Two explicit VERIFY-at-impl notes (idempotency-key minting site; ComposerFrame div-prop passthrough; offline-detection latency) are investigation steps, not hand-waves — each has a stated fallback.
- Type consistency (CORRECTED by adversarial review): real union is `"connecting" | "open" | "reconnecting" | "offline"`; every surface maps `open|connecting → "connected"` before passing to `ComposerOfflineStrip`.
