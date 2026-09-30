# Viewer Upgrade — Phase 4: Workspace Hybrid Attachment Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Workspace timeline's plain attachment chips (`TimelineAttachments`) to a hybrid card: **inline image preview** + **pop-to-panel** (open any attachment in `WorkspacePreviewPanel`). Extract the shared eligibility helper so Discussions and Workspace share one copy.

**Architecture (revised after Codex review):** Markdown is already everywhere in the Workspace and outputs/artifacts already render richly — the **only** plain-chip surface is `TimelineAttachments.tsx`. Unlike Discussions (`InlineArtifactCard`, which embeds `SharedContentViewer` inline for text), the Workspace timeline body sits under a `not-prose` wrapper, and the typography plugin does **not** support a nested `prose` (which `SharedContentViewer`'s text viewer creates) inside `not-prose`. So **Workspace inlines images only** (a plain lazy `<img>` — no prose), and routes text/pdf/docs to **pop-to-panel** where the panel's `WorkProductViewer` renders them richly. This is cleaner than fighting the prose nesting and is the coherent Workspace UX (the panel IS the workspace viewer). No schema change; `IssueAttachment` already carries `{contentType, byteSize, assetId, originalFilename, contentPath}`.

**Tech Stack:** React, Vitest + jsdom + @testing-library/react, TypeScript. `@/` alias resolves in ui (tsconfig + vite).

**Design source:** [Master scope §D](./2026-07-18-viewer-upgrade-master-scope.md); mirrors [Phase 3](./2026-07-19-viewer-upgrade-phase3-discussions-cards.md).

**Codex-confirmed facts:** `IssueAttachment` fields (`assetId`, `contentType: string`, `byteSize: number`, `originalFilename`, `contentPath`) exist at `packages/shared/src/types/issue.ts:210`. `resolveOutputViewer({contentType, filename, assetId, assetUrl})` matches `ViewerInput`; `WorkProductViewer` requires `viewer` + `filename` (optional `inlineTextContent`). `openPreviewTab(tab, source)` — `source` is `"center" | "right-panel"` (`WorkspaceLayout.tsx:38`). `TimelineUserMessage`/`TimelineTaskBrief` have no other callers; `WorkspaceTimeline` also renders in `TaskDetail` (an optional callback keeps that compiling with direct-link fallback).

**Scope / deferred:** Markdown parity nit (bare `react-markdown`→`MarkdownBody`) — out of scope. Outputs/artifacts — already rich, untouched. Inline TEXT preview in the timeline — deliberately routed to pop-to-panel (not-prose conflict). ShowRef non-attachment channel — Tier-3.

---

## Task 1: Extract inline-preview helpers to a shared util

**Files:** Create `ui/src/lib/inline-preview.ts` + `ui/src/lib/inline-preview.test.ts`; Modify `ui/src/components/threads/InlineArtifactCard.tsx`.

- [ ] **Step 1: Create the util** (move the exact logic from `InlineArtifactCard.tsx:18-33`, plus an image-only helper for Workspace):

```ts
// ui/src/lib/inline-preview.ts
// Shared inline-preview eligibility for attachment cards. Pure fns, no React.
export function normalizeMime(contentType: string | null): string | null {
  if (!contentType) return null;
  const base = contentType.split(";")[0]!.trim().toLowerCase();
  return base || null;
}
export const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const INLINE_TEXT_MAX_BYTES = 256 * 1024;

/** Raster image safe to render inline as <img> (matches server inline allowlist). */
export function isInlineImage(contentType: string | null): boolean {
  const ct = normalizeMime(contentType);
  return ct != null && INLINE_IMAGE_TYPES.has(ct);
}

/** Small/previewable via SharedContentViewer (Discussions, which is not under not-prose). */
export function isInlinePreviewable(contentType: string | null, byteSize: number | null): boolean {
  const ct = normalizeMime(contentType);
  if (!ct) return false;
  if (INLINE_IMAGE_TYPES.has(ct)) return true;
  const isText = (ct.startsWith("text/") && ct !== "text/html") || ct === "application/json";
  if (isText) return byteSize != null && byteSize <= INLINE_TEXT_MAX_BYTES;
  return false;
}
```

- [ ] **Step 2: Move the tests** — create `ui/src/lib/inline-preview.test.ts` with the `isInlinePreviewable` cases (copy from `InlineArtifactCard.test.tsx`: png/case/svg+params/text-cap/null-size/pdf/zip/html) importing from `./inline-preview.js`, plus a couple `isInlineImage` cases (png true, svg false, text/plain false).

- [ ] **Step 3: Re-point `InlineArtifactCard.tsx` — import ALL symbols it uses**

`InlineArtifactCard` calls `isInlinePreviewable` AND `normalizeMime`/`INLINE_IMAGE_TYPES` (e.g. the `isImagePreview` check ~L151). Delete the local copies and add:
```ts
import { isInlinePreviewable, normalizeMime, INLINE_IMAGE_TYPES } from "@/lib/inline-preview";
```
To avoid touching the Discussions test's import, add a re-export in `InlineArtifactCard.tsx`: `export { isInlinePreviewable } from "@/lib/inline-preview";`. Behavior unchanged.

- [ ] **Step 4: Verify + commit**

Run: `pnpm test:run ui/src/lib/inline-preview.test.ts ui/src/components/threads/__tests__/InlineArtifactCard.test.tsx` → PASS.
Run: `pnpm --filter @armyofagents/ui typecheck` → PASS.
```bash
git add ui/src/lib/inline-preview.ts ui/src/lib/inline-preview.test.ts ui/src/components/threads/InlineArtifactCard.tsx
git commit -m "refactor(viewer): extract inline-preview helpers to shared ui/lib/inline-preview"
```

---

## Task 2: Add an `asset` preview-tab kind (model + icon + body + handler)

**Files:** Modify `ui/src/components/workspace/WorkspacePreviewPanel.tsx`, `ui/src/components/workspace/WorkspaceLayout.tsx`.

- [ ] **Step 1: Tab model** (`WorkspacePreviewPanel.tsx:26-74`): add `"asset"` to `PreviewTabKind` + the union arm `{ id; kind:"asset"; title; assetId; contentType: string | null; filename; byteSize?: number | null }`.

- [ ] **Step 2: Icon arm** — `previewTabIcon()` (~L316) has no default; add `case "asset": return FileText;` (import `FileText` if not already) so `<Icon>` is never undefined.

- [ ] **Step 3: Tab body** — in the body dispatch (~L150-193), add an `asset` case mirroring `OutputPreviewView`/`ArtifactVersionPreviewView` (~L762-838): `<WorkProductViewer viewer={resolveOutputViewer({ contentType: tab.contentType, filename: tab.filename, assetId: tab.assetId, assetUrl: '/api/assets/' + tab.assetId + '/content' })} filename={tab.filename} />` inside the standard tab-body container. Read `output-viewer-registry.ts` + `WorkProductViewer` + the neighboring bodies for exact props/layout.

- [ ] **Step 4: Open handler** (`WorkspaceLayout.tsx`, near `handlePreview*` ~L159-207):

```ts
  const handleOpenAttachment = useCallback((att: IssueAttachment) => {
    openPreviewTab(
      {
        id: `asset:${att.assetId}`,
        kind: "asset",
        title: att.originalFilename ?? "Attachment",
        assetId: att.assetId,
        contentType: att.contentType ?? null,
        filename: att.originalFilename ?? "file",
        byteSize: att.byteSize ?? null,
      },
      "center",
    );
    // Mobile: openPreviewTab sets state but applyPreviewFocus no-ops on mobile and the
    // preview stays hidden while mobileTab==="timeline" — force the Preview tab.
    setMobileTab("preview");
  }, [openPreviewTab, setMobileTab]);
```
Read `WorkspaceLayout.tsx:38` (`openPreviewTab` signature — `source` is `"center"|"right-panel"`), `:136` (`applyPreviewFocus` mobile no-op), and how `mobileTab`/`setMobileTab` are defined (~L350/372) — call `setMobileTab("preview")` using the real setter (guard to mobile only if `setMobileTab` is always present it's fine to call unconditionally). Import `IssueAttachment` from `@armyofagents/shared` and `useCallback` if needed.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter @armyofagents/ui typecheck` → PASS (the new union member forces the icon + body arms).
```bash
git add ui/src/components/workspace/WorkspacePreviewPanel.tsx ui/src/components/workspace/WorkspaceLayout.tsx
git commit -m "feat(workspace): add asset preview tab (icon+body) + open-attachment handler (mobile-safe)"
```

---

## Task 3: Hybrid card in `TimelineAttachments` + thread the callback

**Files:** Modify `TimelineAttachments.tsx`, `WorkspaceTimeline.tsx`, `TimelineUserMessage.tsx`, `TimelineTaskBrief.tsx`, `WorkspaceLayout.tsx`; Test `TimelineAttachments.test.tsx`; fix `ui/src/__tests__/WorkspaceTimeline.test.tsx`.

- [ ] **Step 1: Thread `onOpenAttachment` down (types)**

- `WorkspaceLayout.tsx`: pass `onOpenAttachment={handleOpenAttachment}` to `<WorkspaceTimeline>` at BOTH render sites (desktop ~L485, mobile ~L362).
- `WorkspaceTimeline.tsx`: add `onOpenAttachment?: (att: IssueAttachment) => void`; forward to `TimelineUserMessage` (comment render ~L746) and `TimelineTaskBrief`.
- `TimelineUserMessage.tsx` + `TimelineTaskBrief.tsx`: add the same optional prop; pass `onOpen={onOpenAttachment}` into `<TimelineAttachments>`.

- [ ] **Step 2: Write the failing test — `ui/src/components/workspace/TimelineAttachments.test.tsx`** (use a typed `IssueAttachment` factory, not `as any`):

```tsx
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import type { IssueAttachment } from "@armyofagents/shared";
import { TimelineAttachments } from "./TimelineAttachments";

afterEach(cleanup);
function att(o: Partial<IssueAttachment>): IssueAttachment {
  return { id: "a1", assetId: "asset-1", originalFilename: "pic.png", contentType: "image/png",
    byteSize: 1024, contentPath: "/api/assets/asset-1/content", ...(o as any) } as IssueAttachment;
}
const img = att({});
const zip = att({ id: "a2", originalFilename: "x.zip", contentType: "application/zip" });

describe("TimelineAttachments hybrid", () => {
  it("renders an inline lazy image for an image attachment", () => {
    const { container } = render(<TimelineAttachments attachments={[img]} testId="t" />);
    const el = container.querySelector('img[loading="lazy"][src="/api/assets/asset-1/content"]');
    expect(el).not.toBeNull();
    expect(container.querySelector('[data-testid="attachment-inline-preview"]')).not.toBeNull();
  });
  it("no inline image region for a non-image attachment", () => {
    const { container } = render(<TimelineAttachments attachments={[zip]} testId="t" />);
    expect(container.querySelector('[data-testid="attachment-inline-preview"]')).toBeNull();
  });
  it("fires onOpen when provided (pop-to-panel)", () => {
    const onOpen = vi.fn();
    const { getByTestId } = render(<TimelineAttachments attachments={[img]} testId="t" onOpen={onOpen} />);
    fireEvent.click(getByTestId("attachment-open-a1"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
  it("falls back to a direct link when onOpen is absent", () => {
    const { getByTestId } = render(<TimelineAttachments attachments={[img]} testId="t" />);
    expect(getByTestId("attachment-open-a1").getAttribute("href")).toBe("/api/assets/asset-1/content");
  });
});
```

- [ ] **Step 3: Run — confirm FAIL** (`pnpm test:run ui/src/components/workspace/TimelineAttachments.test.tsx`).

- [ ] **Step 4: Implement the hybrid card** (`TimelineAttachments.tsx`)

Add `onOpen?: (att: IssueAttachment) => void` to the props (`import { isInlineImage } from "@/lib/inline-preview";`). For each attachment (`assetUrl = '/api/assets/' + attachment.assetId + '/content'`):
- **Image (`isInlineImage(attachment.contentType)`):** a `data-testid="attachment-inline-preview"` wrapper with `<img src={assetUrl} alt={label} loading="lazy" className="max-h-72 w-auto rounded-md border border-border" />`.
- **Open control (all attachments):** when `onOpen` is provided, a `<button data-testid={"attachment-open-" + attachment.id} onClick={() => onOpen(attachment)}>{label}</button>`; else the existing `<a data-testid={"attachment-open-" + attachment.id} href={assetUrl} target="_blank" rel="noreferrer">{label}</a>` (note: href is now the assetId URL, not `contentPath`). Add a small Download `<a href={assetUrl} download>`.
- Keep the `not-prose` wrapper (still correct — `<img>`/buttons aren't prose; no `SharedContentViewer` is used here, so no nested-prose conflict). Non-image attachments render the chip/open row without a preview wrapper.

- [ ] **Step 5: Fix the pre-existing timeline test**

`ui/src/__tests__/WorkspaceTimeline.test.tsx:309` asserts the old `contentPath` image URL and its fixtures omit `assetId`. Update: add `assetId` to the attachment fixtures and change the asserted image `src` to `/api/assets/<assetId>/content`. Report the exact change.

- [ ] **Step 6: Run PASS + typecheck + no regression**

Run: `pnpm test:run ui/src/components/workspace/TimelineAttachments.test.tsx` → PASS.
Run: `pnpm test:run ui/src/components/workspace ui/src/__tests__/WorkspaceTimeline.test.tsx` → PASS (report any other test updated + why).
Run: `pnpm --filter @armyofagents/ui typecheck` → PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/workspace/TimelineAttachments.tsx ui/src/components/workspace/WorkspaceTimeline.tsx ui/src/components/workspace/TimelineUserMessage.tsx ui/src/components/workspace/TimelineTaskBrief.tsx ui/src/components/workspace/WorkspaceLayout.tsx ui/src/components/workspace/TimelineAttachments.test.tsx ui/src/__tests__/WorkspaceTimeline.test.tsx
git commit -m "feat(workspace): hybrid timeline attachment card — inline image + pop-to-panel"
```

---

## Task 4: Completion gate

- [ ] **Step 1:** `pnpm -r typecheck` → PASS.
- [ ] **Step 2:** `pnpm test:run ui/src/components/workspace ui/src/components/threads ui/src/lib/inline-preview.test.ts ui/src/__tests__/WorkspaceTimeline.test.tsx` → PASS.
- [ ] **Step 3:** `pnpm build` → PASS.
- [ ] **Step 4: Scope discipline** — `git grep -n "output_refs\|showRefSchema" -- ui/src/components/workspace` → no matches.

---

## Self-Review

**Codex P1s fixed:** (1) import `normalizeMime`+`INLINE_IMAGE_TYPES`+`isInlinePreviewable`; (2) `previewTabIcon` `asset` arm + explicit body; (3) `source:"center"`; (4) `setMobileTab("preview")` in the handler; (5) no `SharedContentViewer` inline in the timeline (images-only `<img>` → no `not-prose`/nested-prose conflict). Plus the `WorkspaceTimeline.test.tsx:309` fixture/URL fix (P2).

**Spec coverage:** shared helper (T1); asset tab + handler (T2); hybrid card + threading + test fix (T3); scope gate (T4). Markdown + outputs/artifacts already done — untouched.

**Deferred:** inline TEXT preview in the timeline (pop-to-panel instead, by design); the markdown-parity nit; the ShowRef channel.

---

## Execution Handoff

**Subagent-driven**, spec + code-quality review per task. UI-only; the `pnpm --filter @armyofagents/ui typecheck` gate enforces the new-union-member exhaustiveness + prop-threading consistency.
