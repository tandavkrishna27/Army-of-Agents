# Phase 3 — Viewer Completion — Implementation Plan

> **For agentic workers:** implement task-by-task. Each task: investigate → failing test → implement → review → fix round. One committing subagent per worktree at a time.

**Goal:** finish the artifact/file viewer so every common content type previews correctly and consistently across all surfaces (Commander, Thread, Workspace, Discussion, Memory).

**Architecture:** a canonical shared viewer already exists — `ui/src/components/viewers/SharedContentViewer.tsx` (the render switch) + `viewer-registry.ts` (`resolveViewer`: contentType/extension → `ViewerKind`) + `refBodies.tsx` (surface-agnostic self-fetching bodies). Phase 3 is **hardening, de-siloing, extending, and consolidating** — NOT greenfield. (Scoped 2026-07-25 against the live branch; corrects the "greenfield" memory blurb.)

**Tech stack:** React + Vite + Tailwind v4 (`ui/src/`), Express (`server/src/`), Vitest.

**Branch:** `feat/viewer-upgrade` (continues the viewer initiative; Phases 0–7B already shipped here).

**Locked decisions (product owner, 2026-07-25):**
- **Syntax highlighting → `highlight.js` / `lowlight`** (moderate, tree-shakeable, sync; wire into the code viewer + markdown fences via `rehype-highlight`). Not shiki (bundle/async), not prism.
- **Office → server-side render, extending `server/src/routes/memory-asset-render.ts`.** docx (exists) + **xlsx via sheetjs → sanitized HTML**; **de-silo DOCX** into the shared registry so it previews everywhere, not just Memory. **PPTX stays a download** (no good renderer; disproportionate effort — deferred).

---

## Current-state anchors (verified 2026-07-25 — do NOT re-derive, DO verify what you depend on)

- Registry dispatch ends: `viewer-registry.ts:200-213` — `isTextLike` → `code`, else `download`. Office MIME matches neither → download.
- Render switch: `SharedContentViewer.tsx:46-73`. Code viewer (no highlight): `:76-84`. Markdown (no fence highlight): `:86-94`. CSV table + naive parser: `:234-272`. Download fallback: `:395-413`.
- Server DOCX→HTML via `mammoth`, **rejects non-DOCX**: `server/src/routes/memory-asset-render.ts:46,60`. Memory-only client path: `ui/src/components/memory/viewers/DocxFileViewer.tsx`, reached from `MemoryViewer.tsx:46-49`.
- Divergent legacy workspace preview (bypasses shared viewer): `ui/src/components/workspace/WorkspacePreviewPanel.tsx:1061-1193` (`PreviewView`) — hand-rolls img/`<pre>`/download.
- Inline eligibility narrower than renderer capability: `ui/src/lib/inline-preview.ts:17-24` (excludes html/pdf/office; ≤256KB text/json + images only).
- Tests: `viewers/__tests__/viewer-registry.test.ts` (no Office/code assertions), `viewers/__tests__/SharedContentViewer.test.tsx` (no code/CSV/json/mermaid/canvas render tests).

---

## Standing rules (scars from Phases 1–2 — do not relearn them)

1. **`pnpm test:run` from repo root**, never bare root-level `vitest` (nested worktrees break resolution; they are off-limits).
2. **One committing subagent per worktree at a time.** Several Phase-3 tasks touch `SharedContentViewer.tsx` — they must be sequential, not parallel.
3. **Verify against reality, not the plan.** Line numbers here are a snapshot; re-derive after edits. The scoping map already corrected the memory blurb once.
4. **Discriminator discipline + ablation.** A test must only pass for the right reason; show the failure before the fix. Every ablation this project ran found something.
5. **Docblocks must not over-promise. Gates fail closed.**
6. **Bundle discipline.** This is a Vite UI. Do not add a dependency without justifying its weight; prefer server-side render or tiny hand-rolled code for one-off needs.
7. Known pre-existing/load-dependent failures: `codex-local-adapter` ×2, `github-integration`; UI load-dependent: `LobbySidebar`, `FlowEngine`, `DefineDepartments`, `ProjectDetailDiscussions`, `ProjectDetailWorkspaces`.

---

## Sequencing

`SharedContentViewer.tsx` is the contention point (P3.1, P3.2, P3.3, P3.4 all touch it). Serialize those. P3.5/P3.6/P3.7 are more independent.

Order: **P3.1 → P3.2 → P3.3 → P3.4 → P3.5 → P3.6 → P3.7.**

> **Progress (2026-07-25):** ✅ **P3.1** (CSV/TSV, `fdd4a259e`+`1ce190820` — sniffer
> dropped, TSV live via known delimiter, BOM fix) · ✅ **P3.5** (workspace
> mode-preview routed through the shared viewer, `5c1c36dfb`) · ✅ **P3.6**
> (inline-eligibility policy documented + exclusions pinned; no logic change —
> divergence is intentional because html/svg render under `allow-scripts`,
> `748aed50e`) · ✅ **P3.7** (ViewerKind coverage matrix closed, `620e151af`
> +`5562797b7` — every kind has a registry resolution assertion; every kind
> except mermaid-render, which stays an async dynamic import, has a render test.
> The final gap-fill added the `code` registry assertion and image/video/audio/
> svg_sandbox render tests).
>
> **Phase 3 COMPLETE** — all seven tasks (P3.1–P3.7) shipped on
> `feat/viewer-upgrade`. Syntax highlighting (highlight.js), DOCX+XLSX
> server-render de-silo, workspace-preview collapse, inline-eligibility
> alignment, and the closed test matrix are all in.
>
> **Held — subagents blocked org-side (no independent review available):**
> **P3.2** (adds highlight.js/lowlight), **P3.4** (adds sheetjs server-side), and
> **P3.3** (de-silo DOCX; no new dep but touches the shared viewer + server
> route). These are the dependency-adding / review-sensitive tasks; awaiting a
> product-owner call on proceeding inline without review vs. waiting for subagents.

---

## P3.1 — Robust CSV/TSV parsing — 🔄 IN PROGRESS

**Why:** `parseCsv` (`SharedContentViewer.tsx:267-272`) is a naive `line.split(",")` — breaks on quoted commas, embedded newlines, escaped quotes. The table UI is fine; only the parser is wrong.

- [ ] RFC-4180 parser (quoted fields, embedded commas/newlines, `""` escape, CRLF, trailing newline); TSV if the registry routes it. Prefer a tiny hand-rolled parser over `papaparse` (bundle). Dedicated unit test with the full edge-case set; ablation vs the naive parser.
- Commit: `fix(viewer): robust RFC-4180 CSV/TSV parsing in the shared content viewer`

## P3.2 — Syntax highlighting (highlight.js / lowlight)

**Why:** code renders as unstyled `<pre>` (`SharedContentViewer.tsx:76-84`); markdown fenced code has no highlight (`:86-94`). No highlighter lib present.

- [ ] Add `highlight.js`/`lowlight` (+ `rehype-highlight` for markdown). Tree-shake to a sensible common-language set; document which languages and how an unknown language degrades (plain `<pre>`, never throws). Theme must work in light + dark. Wire into BOTH the `code` viewer and markdown fences.
- [ ] **Decision to make + state:** async/dynamic-import the highlighter (keep it off the initial bundle) vs. static. Given bundle discipline, lean dynamic — the viewer is not first-paint critical.
- [ ] Tests: a code sample highlights (assert highlighted markup/tokens, not just "renders"); an unknown language degrades cleanly; markdown fence highlights. Discriminator: a JS keyword gets a token class that plain `<pre>` would not.
- Commit: `feat(viewer): syntax highlighting for code and markdown fences (highlight.js)`

## P3.3 — De-silo DOCX into the shared registry

**Why:** DOCX previews only in Memory (`MemoryViewer.tsx:46-49` → `DocxFileViewer` → server `mammoth`). Commander/Thread/Workspace/Discussion all download it. The server render route already exists and is XSS-tested.

- [ ] Add a `docx` `ViewerKind`: `viewer-registry.ts` resolves DOCX MIME/extension to it; `SharedContentViewer` renders it via the **existing server render route** (sanitized HTML), reusing `DocxFileViewer`'s fetch-and-inject approach but in the shared path. Keep the sanitization guarantee (`memory-asset-render-xss.test.ts` is the reference).
- [ ] Make `MemoryViewer` route DOCX through the shared path too (remove the silo) — or leave the Memory silo delegating to the same shared component. State which and why; do not duplicate the renderer.
- [ ] Tests: registry resolves docx → `docx` kind (currently asserts nothing for Office); the shared viewer renders docx via the route; sanitization preserved. Ablation: a docx MIME resolved to `download` before the change.
- Commit: `feat(viewer): render DOCX in the shared viewer on every surface (de-silo)`

## P3.4 — XLSX server render

**Why:** xlsx has no path anywhere → download. Consistent with the server-render decision.

- [ ] Extend `server/src/routes/memory-asset-render.ts` (currently rejects non-DOCX at `:46`) to also render xlsx → sanitized HTML table(s) via **sheetjs** (server-side; keep it off the client bundle). Preserve the DOCX path and its sanitization exactly. Consider multi-sheet output and a sane cell/row cap (a 100k-row sheet must not OOM the server or the browser — cap + note truncation, per the "no silent caps" rule).
- [ ] Wire xlsx into `viewer-registry.ts` (`xlsx` or reuse a generic server-rendered-office kind) + `SharedContentViewer`.
- [ ] Tests: server renders a small xlsx to a table; sanitization holds (reuse the xss test shape); registry resolves xlsx; a row/cell cap truncates loudly. Ablation: xlsx → download before the change.
- Commit: `feat(viewer): server-side XLSX rendering in the shared viewer`

## P3.5 — Collapse the divergent workspace preview

**Why:** `WorkspacePreviewPanel.PreviewView` (`:1061-1193`) hand-rolls img/`<pre>`/download and ignores `resolveViewer`/`SharedContentViewer`, so the same artifact previews richly in a tab but as raw `<pre>` in mode-preview.

- [ ] Route `PreviewView` through `resolveViewer` → `SharedContentViewer` (via `WorkProductViewer`, the existing pass-through), deleting the hand-rolled branches. Preserve the toolbar/mode UX; only the render body changes.
- [ ] Tests: an artifact that previews richly in a tab now previews identically in mode-preview. Ablation: the old `<pre>` path for a type the shared viewer renders richly (e.g. csv/markdown).
- Commit: `refactor(viewer): route workspace mode-preview through the shared viewer`

## P3.6 — Align inline eligibility with renderer capability

**Why:** `isInlinePreviewable` (`inline-preview.ts:17-24`) excludes html/pdf/office that `SharedContentViewer` can now render, and caps text/json at 256KB. What's *eligible* to appear inline is narrower than what the viewer can *render*, so discussion cards download things the viewer could show.

- [ ] Decide the honest inline policy: which now-renderable types should preview inline in discussion cards (weigh performance/layout — a full xlsx inline may be wrong; a PDF inline may be fine). Align `isInlinePreviewable` to that decision; document the intentional exclusions (don't silently drop a type). This is a **judgement call** — state the policy and why, don't just widen everything.
- [ ] Tests pinning the new policy per type. Discriminator: a type you intentionally keep download-only stays excluded.
- Commit: `fix(viewer): align inline-preview eligibility with shared-viewer capability`

## P3.7 — Close the viewer test-coverage gaps

**Why:** `SharedContentViewer.test.tsx` has no render tests for code/CSV/json/mermaid/canvas; `viewer-registry.test.ts` has no Office/code assertions. Phases 3.1–3.4 add some; this sweeps the rest so a future regression fails loudly.

- [ ] Render tests for each `ViewerKind` not already covered; registry resolution assertions for every content type including the new Office kinds. No weakening of existing tests.
- Commit: `test(viewer): cover every ViewerKind render + registry resolution`

---

## Exit criteria

Every common type (markdown, text, code+highlight, json, csv/tsv, image/av, pdf, html/svg, mermaid, canvas, docx, xlsx) previews correctly through the **one** shared path on **every** surface; pptx and truly-unknown types fall to an honest download card; inline eligibility matches renderer capability by stated policy; no divergent hand-rolled preview path remains; every kind has a render + resolution test. Full `pnpm test:run` no worse than baseline.
