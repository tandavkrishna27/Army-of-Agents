# Viewer Upgrade — Master Scope

**Status:** Draft for founder review
**Date:** 2026-07-18
**Baseline audited:** `origin/main` at `a490fc57d` (PR #291 unified composer + #292 invited-onboarding merged)
**Scope type:** Product and UX contract; not an implementation plan
**Surfaces:** Commander, Discussions, Workspace, Memory
**Companion document:** [Unified Composer — Product Scope](./2026-07-15-unified-composer-scope.md) (the *input* half)
**Build-1 design:** [Viewer Upgrade — Build 1 (A/D/E) Design Spec](./2026-07-18-viewer-upgrade-build1-design.md) (revised after Codex review, 2026-07-18)

---

## 1. Executive summary

AoA has one shared content-rendering engine but four independent viewer surfaces, all effectively read-only, none of which an agent can meaningfully drive. Content that agents and people produce — charts, documents, presentations, images, code, live previews — has no consistent lifecycle from **generate → view → edit → manual input → agent-driven display**.

The **Unified Composer** (PR #291) solved the *input* half of this: one shared `ComposerFrame` across surfaces, with attachments, structured mentions, `/skill`, drafts, and idempotency. It **deliberately deferred** the output/display side (its §6 non-goals exclude universal Markdown conversion, Office-document handling, and any redesign of viewers/timelines/run viewers).

**Viewer Upgrade is the complementary output half.** It establishes:

- One shared, extensible *show-a-ref* contract consumed by every surface without merging their independent tab models.
- A hybrid inline/panel display model for content in threads.
- Markdown rendering in threads (plain text today).
- Agents that can drive the viewer — show their own output and navigate you to existing entities — governed by a dedicated, separate control.
- A staged path to in-place **editing** and to **Office / Google document** view + edit + generation.
- URL/browser hardening that stays compatible with future agent-controlled browsing.

This scope does **not** merge the four viewer tab models into one, does **not** make every surface's bespoke tabs an agent target, and does **not** re-home organizational knowledge into ephemeral surfaces.

## 2. Problem statement

- **Read-only everywhere.** No in-app editor for file content exists (no Monaco/CodeMirror). "Editing" an artifact means appending a new immutable version. The only editors are memory-item markdown and discussion extracted-item metadata.
- **Four independent viewers.** Commander, Thread (Discussions), Workspace, and Memory each own a separate tab-state model. They share the *content renderer* (`SharedContentViewer` + `resolveViewer`) but nothing else; Workspace even uses a parallel renderer (`WorkProductViewer`). Behavior and fidelity differ per surface.
- **Threads are plain text.** Discussion and Workspace thread bubbles render `whitespace-pre-wrap` raw text — no markdown, no code highlighting, no inline previews. Only Commander renders markdown and offers the "chip under a message → opens side viewer" pattern.
- **Agents can barely drive the viewer.** The only agent→viewer path is Commander's output-refs, limited to a single hardcoded `"artifact"` kind, auto-opened by one rule. Discussions/Workspace/Memory have no agent-driven open path at all.
- **No Office / Google.** DOCX is view-only and only in Memory; PDF is viewable; PPTX/XLSX are download-only opaque blobs; Google Docs/Slides/Sheets have zero support; there are no document-generation libraries.
- **Browser URL handling is not a safety gate.** `normalizeBrowserUrl` shapes strings but passes `file:`/`javascript:` through unchanged, and the Workspace preview iframe path is even more permissive and un-sandboxed.

This makes narrow surfaces feel like reduced products, blocks agents from delivering a "show me" experience, and leaves the highest-value document formats unsupported.

## 3. Verified current-state map

| Concern | Current state | File anchors |
|---|---|---|
| Shared content engine | ~13 kinds: markdown, code, json, table(csv), image, video, audio, pdf, html-sandbox, svg-sandbox, mermaid, canvas, download. Metadata `viewerKind` hint with a safelist. | `ui/src/components/viewers/viewer-registry.ts`, `SharedContentViewer.tsx` |
| Commander viewer | Tabbed side panel: artifact/reply/browser/task/discussion/approval/inbox/note. Only surface wired to agent output-refs. | `ui/src/components/commander/viewer/` |
| Embedded discussion in Commander | **Full live `ThreadDetail embedded`** with compose box; `onOpenRequest` forwards content-opens into Commander's viewer. Landed in #291. | `ui/src/components/InternalAgentPanel.tsx:255` |
| Thread viewer (Discussions) | Own model: open/scope_item/task/task_output/memory/artifact_ref/artifact/asset/browser/map. User-click only. | `ui/src/components/threads/threadViewerModel.ts`, `ThreadViewer.tsx` |
| Workspace preview | Separate model: home/browser/changes/file/artifact/output/logs + legacy non-tabbed mode + live dev-server iframe. Content via `WorkProductViewer`, a ~11-line wrapper over `SharedContentViewer` (not a materially parallel renderer). Timeline comments **already** render GFM markdown. | `ui/src/components/workspace/WorkspacePreviewPanel.tsx`, `WorkspaceLayout.tsx`, `WorkProductViewer.tsx`, `TimelineUserMessage.tsx` |
| Memory viewer | Own model: home/open/memory_item/asset/graph/collection. DOCX short-circuit to bespoke `DocxFileViewer`. | `ui/src/components/memory/`, `ui/src/lib/memoryTabs.ts` |
| Agent → viewer | One `"artifact"` outputRef kind; `shouldAutoOpen` = created + desktop. Only Commander has a ref stream (rides `tool_result` SSE); Discussions/Workspace have **no** ref channel — they use thread live-events/refetch and comments/heartbeat runs. Cross-surface delivery is net-new, not "a callback." | `packages/shared/src/commander-output-refs.ts`, `server/src/services/internal-agent/output-refs.ts`, `ui/src/components/InternalAgentPanel.tsx` |
| Office/Google | DOCX view-only (Memory, mammoth→sanitized HTML); PDF via pdf.js; PPTX/XLSX download-only blobs; Google = none; no gen libs. | `server/src/services/file-import.ts`, `ui/src/components/memory/viewers/DocxFileViewer.tsx` |
| Browser/URL safety | `normalizeBrowserUrl` normalizes, does not gate schemes (and `initialUrl` bypasses even that); Workspace dev-server iframe has no sandbox and a more permissive normalizer; Inbox Hub is a **third** browser-tab model (`hubViewerModel`). `browser_use` = latent headless Playwright, un-granted. | `ui/src/components/viewers/BrowserViewer.tsx`, `ui/src/components/workspace/WorkspacePreviewPanel.tsx`, `ui/src/components/hub/hubViewerModel.ts`, `server/src/services/internal-agent/cli-mode.ts` |
| Composer groundwork (#291) | Shared `ComposerFrame`, attachments (image+file), structured mentions, `/skill`, drafts, `asset` input-ref kind, runtime text-attachment delivery, capability metadata. | `ui/src/lib/composerDraft.ts`, unified-composer docs |

## 4. Product principles

### 4.1 One engine, four models — extend, never merge
The content renderer is shared; the four tab-state models are intentionally independent (divergent tab-close focus rules, composite key namespaces, bespoke tabs). We add one thin translator per surface, not a universal dispatcher.

### 4.2 A ref is a pointer, never content or a capability grant
Agents surface content by emitting a pointer (`kind + id + label + optional viewerKind hint`). Every tab re-fetches through the viewing user's access-checked API, so an agent can never surface anything the user could not already open.

### 4.3 Bespoke tabs are off-limits to agents
ShowRef may target only safe kinds (artifact/asset/reply/task). Memory's DOCX path, the memory editors, scope-item workbenches, changes/file/logs, and graph stay reachable only through each surface's own launcher.

### 4.4 Viewer control is a distinct axis from acting-autonomy
Whether an agent may *act* (autonomy level) and whether it may *grab your screen* are different decisions with different risk. Viewer control gets its own setting.

### 4.5 Reuse the composer's contracts
Attachments, the `asset` input-ref kind, mention/token models, and runtime capability metadata already exist. Viewer Upgrade consumes them; it does not re-invent an attachment or asset pipeline.

### 4.6 Throwaway content reuses the durable path
Ephemeral agent output is a short-lived (TTL) artifact that auto-cleans and can be hidden from lists — not a new never-persisted transport. Preserves DA-22 (surfaces are not the accidental permanent home for knowledge) via deliberate promotion.

### 4.7 Safety that does not foreclose the future
URL handling enforces scheme-safety (http/https + about:blank + relative) with **no domain allowlist**, so future agent-controlled browsing (CDP/Playwright-mirrored) is not constrained.

## 5. The six workstreams

### A — Unified viewer foundation *(Build 1)*
Formalize the shared `ShowRef` contract and a per-surface `openRef()` adapter; extend content kinds as needed; wire the shared `toSafeBrowserUrl` validator. Foundation for everything else.

### B — In-place editing *(later build)*
A real in-app editor for file content (code → markdown → structured). Must reconcile the two divergent memory editors (Memory `MarkdownItemViewer` vs Thread `MemoryLinkedViewer`) and define the edit→version relationship against artifact immutability.

### C — Office & Google formats *(later build)*
View → edit → generate for Word / PowerPoint / Excel, in both Microsoft and Google variants. MS side is buildable with document engines; Google side is an OAuth + Drive/Docs/Slides/Sheets API integration. Requires a preview/extraction/runtime contract (the composer scope flagged Office types as needing this before acceptance).

### D — Inline preview cards + markdown in threads *(Build 1)*
Turn markdown ON in Discussion/Workspace threads; introduce the hybrid adaptive card (inline-expand ↔ pop-to-panel); bring the chip→panel pattern to every thread by extending the existing `onOpenRequest` seam.

### E — Agent → viewer control *(Build 1)*
Generalize the agent-drive path beyond Commander's single `"artifact"` kind: Tier 2 (show own output) + Tier 3 (navigate to existing task/discussion/approval/memory/URL) across Commander + Discussions + Workspace, governed by the `viewerControl` setting. **The real cost is the cross-surface delivery channel** (persist + live-deliver + replay + authorize refs) that Discussions and Workspace lack today, plus the **new tab bodies** those surfaces need — not the adapters. TTL-ephemeral is a **separate lifecycle slice**, not a flag.

### F — Rich input *(mostly delivered by the composer; opportunistic)*
Image paste, file tokens, structured mentions in Commander — largely delivered by #291. Any residual gaps ride along; not a build gate.

## 6. Build sequence

| Build | Contents | Rationale |
|---|---|---|
| **Build 1** | **A + D + E** across all four surfaces (agent-drive on the three active ones) | Cheapest high-leverage set; makes agents feel alive; foundation + read experience + agent-drive. One branch, phased. |
| **Build 2** | **B** in-place editing | Net-new capability; large; needs A's seam in place first. |
| **Build 3** | **C** Office/Google | Largest; MS then Google; needs editing (B) foundations for the edit story. |
| Ongoing | **F** residuals | Folded opportunistically. |

Each build lands after the prior one is proven clean. This document is the umbrella; each build gets its own design spec → implementation plan → review cycle.

## 7. Non-goals (master)

1. Merging the four viewer tab models into one universal model.
2. Making bespoke/customized tabs (Memory DOCX, memory editors, scope-item workbenches, changes/file/logs, graph) agent-targetable.
3. A never-persisted ephemeral content transport (we use TTL-artifacts).
4. A domain allowlist for agent-opened URLs.
5. Re-homing durable organizational knowledge into ephemeral surfaces.
6. Re-inventing the attachment/asset pipeline the composer already owns.
7. Building agent-controlled *live* browsing (navigate/click/fill) in this master arc — only leaving the door open architecturally.

## 8. Cross-cutting contracts

### 8.1 `ShowRef`
`{ kind, id, label, viewerKind? }`. Emitted by agents; consumed by per-surface `openRef()` adapters. `viewerKind?` flows into the existing `resolveViewer` metadata safelist, never into a tab model. Targets: artifact, asset, reply, task (Build 1); task/discussion/approval/url navigational (Build 1, Tier 3). Aligns with the composer's `asset` input-ref kind.

### 8.2 `viewerControl` setting
Dedicated, separate from `autonomyLevel`. Levels: `manual` (card only) / `own_output` (auto-open own fresh output; default) / `full` (auto-open navigational too). **Authority = company ceiling + per-user override:** the company sets the maximum (`internal_agent_config` + required guardrail), each user tunes within it (per-user preference), with per-surface overrides (Discussion, Workspace) as **explicit columns** (not jsonb). Server-resolved via the `agent-completion-policy` pattern (company default → project/dept → discussion → per-user → guardrail clamp). Memory has no separate setting.

### 8.3 Browser scheme-safety
One shared **isomorphic** `toSafeBrowserUrl` validator (server validation reuses it): allow http/https + about:blank; reject javascript:/file:/data:/blob:/protocol-relative/control-chars/others. Applied at **every** path — `BrowserViewer` (incl. `initialUrl`, not only submit), the Workspace dev-server iframe (which also gains a `sandbox` attribute), and the tab constructors in `commanderViewerModel`, `threadViewerModel`, and `hubViewerModel`. **Same-origin/relative policy is consistent across all callers**, not special-cased to agent refs. No domain allowlist. Agent-emitted URL refs additionally require confirmation.

## 9. Relationship to the Unified Composer

| Half | Owns | Status |
|---|---|---|
| Unified Composer | Input: shared composer frame, attachments, mentions, `/skill`, drafts, idempotency, runtime attachment delivery | Shipped (#291) |
| **Viewer Upgrade** | Output: display, preview, agent-drive; later editing + Office/Google | This scope |

Shared seams to honor: the `asset` input-ref kind, attachment records and previews, runtime capability metadata (text/vision/stored-only), and the embedded-`ThreadDetail` `onOpenRequest` seam.

## 10. Open questions / future

- Whether Build 2 (editing) reconciles the two memory editors by unifying them or keeping them domain-specific.
- The Office preview/extraction/runtime contract needed before Build 3.
- Whether the Google integration is per-company OAuth or a marketplace plugin.
- If and when agent-controlled *live* browsing (CDP mirror) becomes its own initiative.
- Whether true-ephemeral (never-persisted) content ever becomes a requirement over TTL-artifacts.
