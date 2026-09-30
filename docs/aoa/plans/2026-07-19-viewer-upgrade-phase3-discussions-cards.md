# Viewer Upgrade — Phase 3: Discussions Markdown + Hybrid Content Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Discussions thread display: (1) render entry content as **markdown** (plain text today), and (2) render entry attachments as a **hybrid adaptive card** — an inline content preview for small/previewable files, with pop-to-panel for everything. Reuses data and plumbing that already exist (attachments + `openAttachmentInViewer`); **no schema change, no new emission path.**

**Architecture (render-upgrade, chosen over a full delivery channel):** Agent-created artifacts already arrive on entries as `attachments[]` (via the crew `sameRunArtifacts` → `discussion_entry_attachments` machinery) and already carry `{filename, contentType, byteSize, assetId}` (`InlineArtifactCard.fileMetaFor`). Pop-to-panel already exists (`ThreadDetail.openAttachmentInViewer` ← `ThreadTab.onOpenAttachment` ← the card's `onOpen`). So this phase is purely a UI render upgrade: swap raw-text nodes for the XSS-safe `MarkdownBody`, and add an inline preview to the attachment card driven by the metadata it already has. The ShowRef `output_refs` channel + crew emission of non-attachment kinds (url/task/memory) are deferred to the Tier-3 emission phase, where they aren't redundant with attachments.

**Tech Stack:** React, Vitest + jsdom + `@testing-library/react`, TypeScript.

**Design source:** [Master scope §D](./2026-07-18-viewer-upgrade-master-scope.md), [Build-1 §3.4/§3.6](./2026-07-18-viewer-upgrade-build1-design.md). **Revised after Codex review (2026-07-19).**

**Codex-confirmed facts (rely on these):** the 3 raw-text sites are `EntryRow.tsx` self **L496**, human **L586**, agent **L679**; `MarkdownBody` accepts `className`, renders block elements (so replace the agent `<p>`, never nest inside it), is XSS-safe (omits `rehype-raw`; react-markdown 10.1 rewrites a `javascript:` href to `""` — the anchor remains with an empty href, not removed); attachment fixture field names all match `DiscussionEntryAttachment`; `resolveViewer({contentType, filename, assetId, assetUrl})` is the correct input shape and a PNG resolves to exactly `<img src="/api/assets/<id>/content">`; PNG is served `Content-Disposition: inline` (so the img selector is reachable); SVG/unsupported images are served as attachments (correctly excluded from inline).

**Behavior change we explicitly accept (not "structure-only"):** rendering entry text as markdown means single newlines collapse and literal `*`/`_`/`#`/`~`/list-prefixes gain formatting. This is the intended markdown-on-all-entries decision.

**Scope / deferred (intentional):**
- **`output_refs` column + crew ShowRef emission + non-attachment kinds (url/task/memory/approval refs)** → Tier-3 emission phase (there's no crew ref-emitting bridge today; building one is net-new and only pays off for non-attachment kinds).
- **The `approval` Thread viewer tab + a `openRef(ShowRef)` adapter** → same later phase (attachments are artifact/asset only; no approval refs flow here yet).
- **`onLinkOpen`→in-panel browser** for markdown links → deferred; markdown links render as normal sanitized anchors (react-markdown strips `javascript:` via its uriTransformer). Not a gate.

---

## File Structure
- **Modify** `ui/src/components/threads/EntryRow.tsx` — swap 3 raw-text nodes (self L496, human L587, agent L679) → `<MarkdownBody>`.
- **Create** `ui/src/components/threads/EntryRow.markdown.test.tsx` — markdown renders, raw HTML escaped, links safe.
- **Modify** `ui/src/components/threads/InlineArtifactCard.tsx` — add an inline preview block for inline-previewable attachments (image / small text) above the existing chip; keep chip + open + download; non-previewable unchanged.
- **Create** `ui/src/components/threads/InlineArtifactCard.test.tsx` — inline preview for image, chip-only for non-previewable, `onOpen` pop-to-panel fires.

**Reused as-is:** `ui/src/components/MarkdownBody.tsx` (XSS-safe: omits `rehype-raw`, comment at `:52-58`); `ui/src/components/viewers/SharedContentViewer.tsx` + `resolveViewer` (`viewer-registry.ts`); `ThreadDetail.openAttachmentInViewer` (`ThreadDetail.tsx:376`) via the existing `onOpen` prop. **Not touched:** `threadViewerModel`, `ThreadDetail` open seam, any server/schema.

---

## Task 1: Markdown rendering in thread entries

**Files:**
- Modify: the shared test harness `renderWithProviders` (find it — used by `ui/src/components/threads/__tests__/EntryRow.test.tsx`; likely `ui/src/test/*` or `ui/src/**/test-utils*`) — add `ThemeProvider`.
- Modify: `ui/src/components/threads/EntryRow.tsx`
- Test: `ui/src/components/threads/__tests__/EntryRow.markdown.test.tsx`

`entry.rawContent` renders as plain `whitespace-pre-wrap` in three bubbles: self (`MeBubble`, L496), other-human (`HumanBubble`, L586), agent (`AgentCard`, L679). Swap all three to `MarkdownBody`. **`MarkdownBody` calls `useTheme()`** — so any test rendering a real `EntryRow` needs a `ThemeProvider`, and the existing `EntryRow.test.tsx` + `ThreadTab.test.tsx` (which render real `EntryRow` via `renderWithProviders`) **will break** unless the harness provides one.

- [ ] **Step 1: Add `ThemeProvider` to `renderWithProviders` (harness fix — prevents existing-test breakage)**

Locate `renderWithProviders` (grep for its definition; it's imported by `EntryRow.test.tsx`). It currently wraps with `QueryClientProvider` + Router but no `ThemeProvider` (from `ui/src/context/ThemeContext.tsx`). Wrap its children with `<ThemeProvider>` (import from the same path `MarkdownBody` uses — `ui/src/context/ThemeContext`). This is additive and fixes both the new test and the existing `EntryRow`/`ThreadTab` suites that will otherwise throw `useTheme` outside a provider. (`ThreadDetail.test.tsx` already mocks `MarkdownBody`, so it's insulated — leave it.)

- [ ] **Step 2: Write the failing test — render real `EntryRow` variants**

Model the fixtures/props on the existing `ui/src/components/threads/__tests__/EntryRow.test.tsx` (reuse its `renderWithProviders` + a base entry factory; read it for the exact `EntryRow` props and the `DiscussionEntry` shape). Assert markdown renders inside each of the three bubbles:

```tsx
// ui/src/components/threads/__tests__/EntryRow.markdown.test.tsx
import { describe, it, expect } from "vitest";
import { renderWithProviders } from "<same import path EntryRow.test.tsx uses>";
import { EntryRow } from "../EntryRow";
// Reuse the base-entry factory / props pattern from EntryRow.test.tsx.

function entry(overrides: any) {
  return { /* copy the minimal valid DiscussionEntry from EntryRow.test.tsx */ ...overrides };
}

describe("EntryRow markdown", () => {
  for (const [label, inputType, isMe] of [["agent","agent",false],["human","write",false],["self","write",true]] as const) {
    it(`renders markdown in the ${label} bubble`, () => {
      const { container } = renderWithProviders(
        <EntryRow /* ...required props; set author/inputType so it routes to the target bubble; isMe via the same mechanism EntryRow.test uses */
          entry={entry({ inputType, rawContent: "**bold** and\n\n- a\n- b" })} />,
      );
      expect(container.querySelector("strong")?.textContent).toBe("bold");
      expect(container.querySelectorAll("li").length).toBeGreaterThanOrEqual(2);
    });
  }
  it("escapes raw HTML in an agent entry (no injected img)", () => {
    const { container } = renderWithProviders(
      <EntryRow entry={entry({ inputType: "agent", rawContent: "<img src=x onerror=alert(1)>hi" })} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("hi");
  });
});
```

Note: read `EntryRow.test.tsx` to get the EXACT required props (companyId, handlers, `isMe` routing, author objects) and the entry factory — the pseudo-fixture above is a template; make it real. The three routing cases must actually reach `MeBubble` / `HumanBubble` / `AgentCard`.

- [ ] **Step 3: Run — confirm FAIL**

Run: `pnpm test:run ui/src/components/threads/__tests__/EntryRow.markdown.test.tsx`
Expected: FAIL — bubbles still render literal text (`**bold**`), so `querySelector("strong")` is null.

- [ ] **Step 4: Swap the three raw-text nodes in `EntryRow.tsx`**

Import: `import { MarkdownBody } from "../MarkdownBody";`. Replace:
- Self (`MeBubble`, L496) and other-human (`HumanBubble`, L586): swap the raw `{entry.rawContent}` text node for `<MarkdownBody className="prose-sm prose-invert">{entry.rawContent}</MarkdownBody>`. **`prose-invert` is REQUIRED here** — these bubbles have dark backgrounds, and `MarkdownBody` only adds `prose-invert` itself when the global theme is dark, so on a light theme these would render dark-on-dark without it. Keep the outer layout wrapper.
- Agent (`AgentCard`, L679): replace the `<p ...>{entry.rawContent}</p>` with `<MarkdownBody className="prose-sm">{entry.rawContent}</MarkdownBody>` (theme-driven invert is correct here; do NOT nest inside `<p>`).

Read `MarkdownBody`'s `className` handling first. Leave the system-notice pill (L362), scope-proposal, and dedicated cards UNCHANGED.

- [ ] **Step 5: Run — confirm PASS + no regression**

Run: `pnpm test:run ui/src/components/threads/__tests__/EntryRow.markdown.test.tsx` → PASS.
Run: `pnpm test:run ui/src/components/threads` → PASS. The existing `EntryRow.test.tsx`/`ThreadTab.test.tsx` should pass now that the harness has `ThemeProvider` (Step 1). If any assert exact bubble-body DOM, update to the MarkdownBody output and report it.
Run: `pnpm --filter @armyofagents/ui typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/test <renderWithProviders file> ui/src/components/threads/EntryRow.tsx ui/src/components/threads/__tests__/EntryRow.markdown.test.tsx
git commit -m "feat(discussions): render thread entry content as markdown (XSS-safe MarkdownBody + prose-invert on dark bubbles)"
```

---

## Task 2: Hybrid content card — inline preview for attachments

**Files:**
- Modify: `ui/src/components/threads/InlineArtifactCard.tsx`
- Modify: the **existing** `ui/src/components/threads/__tests__/InlineArtifactCard.test.tsx` (do NOT create a duplicate) — it already uses `renderWithProviders`; add the new cases there.

`InlineArtifactCard` renders each attachment as a metadata chip today. Add an **inline content preview** above the chip for inline-previewable attachments, using `resolveViewer` + `SharedContentViewer` with the metadata `fileMetaFor` already returns. `SharedContentViewer` uses `useQuery` and requires **both `viewer` and `filename`** props, so tests must render through `renderWithProviders` (QueryClient). Keep the chip + `onOpen` pop-to-panel unchanged; non-previewable attachments render exactly as before.

- [ ] **Step 1: Sound inline-eligibility rule (normalize MIME; raster allowlist matching server; require known in-cap size for text)**

```ts
// exported from InlineArtifactCard.tsx for the test
function normalizeMime(ct: string | null): string | null {
  if (!ct) return null;
  const base = ct.split(";")[0]!.trim().toLowerCase(); // strip ";charset=..."; lowercase
  return base || null;
}
// Match the server's inline-image allowlist (asset-serving-safety): png/jpeg/gif/webp only.
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const INLINE_TEXT_MAX_BYTES = 256 * 1024;

export function isInlinePreviewable(contentType: string | null, byteSize: number | null): boolean {
  const ct = normalizeMime(contentType);
  if (!ct) return false;
  if (INLINE_IMAGE_TYPES.has(ct)) return true; // svg + unsupported images excluded (served as attachment)
  const isText = ct.startsWith("text/") || ct === "application/json";
  if (isText) return byteSize != null && byteSize <= INLINE_TEXT_MAX_BYTES; // unknown size => NOT inline
  return false;
}
```

- [ ] **Step 2: Add the failing tests to the existing `__tests__/InlineArtifactCard.test.tsx`**

Reuse the file's existing `renderWithProviders` + attachment fixtures (read it for the exact fixture factory; the field names below are confirmed to match `DiscussionEntryAttachment`). Add:

```tsx
import { isInlinePreviewable } from "../InlineArtifactCard";
// (renderWithProviders, fireEvent, and a base attachment factory already exist in this file)

const imgAtt = /* factory */ { id: "att-img", assetId: "asset-1", assetOriginalFilename: "pic.png",
  assetContentType: "image/png", assetByteSize: 1024, artifactId: null, artifactType: null,
  artifactTitle: null, artifactStatus: null, currentVersionStorageKind: null, currentVersionAssetId: null,
  currentVersionFilename: null, currentVersionContentType: null, currentVersionByteSize: null } as any;
const zipAtt = { ...imgAtt, id: "att-zip", assetOriginalFilename: "a.zip", assetContentType: "application/zip" } as any;
const txtAtt = { ...imgAtt, id: "att-txt", assetOriginalFilename: "n.md", assetContentType: "text/markdown", assetByteSize: 2000 } as any;

describe("isInlinePreviewable", () => {
  it("raster images + small text inline; svg(+params)/pdf/zip/unknown-size-text not", () => {
    expect(isInlinePreviewable("image/png", 9e9)).toBe(true);
    expect(isInlinePreviewable("IMAGE/PNG", 10)).toBe(true);            // case
    expect(isInlinePreviewable("image/svg+xml; charset=utf-8", 10)).toBe(false); // params + svg
    expect(isInlinePreviewable("text/markdown", 1000)).toBe(true);
    expect(isInlinePreviewable("text/plain", 300 * 1024)).toBe(false); // over cap
    expect(isInlinePreviewable("text/plain", null)).toBe(false);       // unknown size
    expect(isInlinePreviewable("application/pdf", 10)).toBe(false);
    expect(isInlinePreviewable("application/zip", 10)).toBe(false);
  });
});

describe("InlineArtifactCard hybrid preview", () => {
  it("renders an inline image preview (lazy) for an image attachment", () => {
    const { container } = renderWithProviders(<InlineArtifactCard attachments={[imgAtt]} onOpen={() => {}} />);
    const img = container.querySelector('img[src="/api/assets/asset-1/content"]');
    expect(img).not.toBeNull();
    expect(img!.getAttribute("loading")).toBe("lazy");
    expect(container.querySelector('[data-testid="attachment-inline-preview"]')).not.toBeNull();
  });
  it("mounts an inline preview region for a small text attachment", () => {
    const { container } = renderWithProviders(<InlineArtifactCard attachments={[txtAtt]} onOpen={() => {}} />);
    expect(container.querySelector('[data-testid="attachment-inline-preview"]')).not.toBeNull();
  });
  it("chip-only (no preview region) for a non-previewable attachment", () => {
    const { container } = renderWithProviders(<InlineArtifactCard attachments={[zipAtt]} onOpen={() => {}} />);
    expect(container.querySelector('[data-testid="attachment-inline-preview"]')).toBeNull();
    expect(container.querySelector('[data-testid="artifact-file-chip"]')).not.toBeNull();
  });
  it("still fires onOpen (pop-to-panel) from the filename button", () => {
    const onOpen = vi.fn();
    const { getByTestId } = renderWithProviders(<InlineArtifactCard attachments={[imgAtt]} onOpen={onOpen} />);
    fireEvent.click(getByTestId("inline-artifact-card-att-img"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run — confirm FAIL**

Run: `pnpm test:run ui/src/components/threads/__tests__/InlineArtifactCard.test.tsx`
Expected: FAIL — no `attachment-inline-preview` region / no `<img>` yet; `isInlinePreviewable` export missing.

- [ ] **Step 4: Implement the inline preview block**

In `InlineArtifactCard.tsx`, in the `file` branch (`fileMetaFor` non-null, ~L130), when `isInlinePreviewable(file.contentType, file.byteSize)` is true, render an inline preview wrapper (`data-testid="attachment-inline-preview"`, `max-h-72 overflow-auto rounded-md border border-border`) ABOVE the existing chip:
- Build `resolveViewer({ contentType: file.contentType, filename: file.filename, assetId: file.assetId, assetUrl: '/api/assets/' + file.assetId + '/content' })` (read `viewer-registry.ts` for the exact input type) → `<SharedContentViewer viewer={resolution} filename={file.filename} />` (BOTH props are required). For an image this yields `<img src="/api/assets/<id>/content">`.
- **Add `loading="lazy"`** to the inline image: if `SharedContentViewer`'s image renderer doesn't already set it, prefer a direct height-capped `<img src={'/api/assets/' + file.assetId + '/content'} alt={file.filename} loading="lazy" className="max-h-72 ..." />` for the image case (satisfies the test's `loading` assertion and avoids eager loads in long threads); use `SharedContentViewer` for the text case. Whichever path, both must sit inside the `attachment-inline-preview` wrapper.
- Keep the existing chip (`artifact-file-chip`), `onOpen` filename button, byte size, Download link, and `actions` row UNCHANGED beneath the preview. The non-`file` (artifact-type chip, ~L174) branch is UNCHANGED.

- [ ] **Step 5: Run — confirm PASS + typecheck**

Run: `pnpm test:run ui/src/components/threads/__tests__/InlineArtifactCard.test.tsx` → PASS.
Run: `pnpm --filter @armyofagents/ui typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/threads/InlineArtifactCard.tsx ui/src/components/threads/__tests__/InlineArtifactCard.test.tsx
git commit -m "feat(discussions): hybrid attachment card — inline preview (lazy) + pop-to-panel"
```

---

## Task 3: Completion gate

**Files:** none (verification)

- [ ] **Step 1: Full typecheck** — `pnpm -r typecheck` → PASS.
- [ ] **Step 2: Thread + viewer suites** — `pnpm test:run ui/src/components/threads` → PASS (markdown + card + no regression in existing thread tests).
- [ ] **Step 3: Build** — `pnpm build` → PASS.
- [ ] **Step 4: Confirm scope discipline** — `git grep -n "output_refs\|showRefSchema\|ShowRef" -- ui/src/components/threads server/src/services/discussions.ts packages/db/src/schema/discussions.ts` → **no matches** (this phase adds no ShowRef channel / no schema change; it's a pure render upgrade of existing attachments).
- [ ] **Step 5: Commit (if any incidental fix)** — explicit paths only.

---

## Self-Review

**Spec coverage (D):**
- Markdown in Discussion threads (all entries), XSS-safe → Task 1. ✅
- Hybrid adaptive card: inline preview (small/previewable) + pop-to-panel (existing `onOpen`), metadata-driven (from `fileMetaFor`, no fetch) → Task 2. ✅
- Reuses attachments + `openAttachmentInViewer`; no schema/emission change → Task 3 Step 4 proves scope discipline. ✅

**Deferred (intentional, per the chosen shape):** `output_refs` column + crew ShowRef emission + non-attachment ref kinds + the `approval` Thread tab + a `openRef(ShowRef)` adapter → Tier-3 emission phase.

**Risk:** Task 1 could break an existing EntryRow snapshot/DOM assertion (content unchanged, element structure differs) — Step 4 handles it explicitly. Task 2's inline `SharedContentViewer` wiring depends on its real props — the implementer reads them; the image path has a plain-`<img>` fallback so the test is satisfiable regardless.

**Placeholder note:** Task 2 Step 3 says "read `SharedContentViewer`/`resolveViewer` props first" because the exact call shape must match current code; the *behavior* (inline preview for eligible types, chip otherwise, onOpen preserved) is fully specified and test-locked.

---

## Execution Handoff

Plan complete. Execution: **subagent-driven**, spec + code-quality review per task. Small and UI-only (2 component changes + tests); no server, no schema, no running app required (jsdom render tests + typecheck + build).
