# Memory Page Redesign — Design Spec

**Date:** 2026-05-02
**Phase:** Phase 6 (UI redesign on the `memory` branch)
**Status:** Draft — pending user review

---

## Overview

Replace the current single-page filter-list `ui/src/pages/Memory.tsx` (2306 LOC, Notion-database paradigm) with an Obsidian + Windows-Explorer-inspired three-pane file-explorer experience. The new memory page shows uploaded source files (PDF, DOCX, image, video, PPT) and `.md` memory items side-by-side in a single navigable folder tree, scoped per department, with a tabbed viewer that adapts per file type.

The redesign keeps every existing memory capability — 4-layer architecture, approval workflow, version history, semantic search, file import, starter templates, pinned-to-skill — and surfaces them through the new navigational shape. Backend services and database schemas are mostly preserved; the changes are additive (folder paths + new asset metadata + LiveEvents subscription).

---

## Goals

1. Provide a familiar file-explorer mental model (tree + list + viewer) for browsing and managing memory.
2. Make the founder's governance gate (Pending Review) visually anchored and impossible to miss.
3. Treat raw uploaded files (PDF/DOCX/image/video/PPT) and extracted memory items as first-class siblings in the same tree, linked bidirectionally via metadata.
4. Preserve the Phase 0–5 backend (multi-pathway search, MCP tools, skill materialization, lifecycle, file import) without rewriting any of it.
5. Keep the architecture cloud-ready and multi-user-ready by default — DB-native folder paths, LiveEvents-driven updates, companyId-scoping everywhere.
6. Provide a memory home page that doubles as a department launcher, a triage dashboard, and a recents strip.

## Non-Goals (deferred to v2 or later)

1. Materializing memory items as `.md` files on disk (Future-A in brainstorming) — DB-only is intentional.
2. Manual highlight-to-extract from PDF viewer (select text → save as memory item).
3. Obsidian-style `[[wikilinks]]` graph view. Basic backlinks + mention-link footer ship; full graph is deferred.
4. Smart re-extract merge logic. Re-extract creates a new pending set; founder reconciles manually.
5. Mobile / narrow-viewport layout. Spec optimizes for desktop and tablet-wide.
6. Real-time collaborative editing (operational transforms, presence cursors). Multi-user is supported via LiveEvents-driven refresh + version-on-save; concurrent editing of the same item produces a new version, not a live merge.
7. Renaming the existing `pinnedToSkill` field. Display strings can change; the schema column stays.

---

## Architecture Summary

### High-level UI shape

```
┌─────────────────────────────────────────────────────────────────────┐
│ Top bar:  🧠 Memory · breadcrumb  | 🔍 search ⌘K | + New ▾ | ⬆ Import│
├──────────────┬──────────────────┬───────────────────────────────────┤
│ Tree         │  File list       │  Tabbed viewer                    │
│ (collapsible)│  (list / grid)   │  (browser-style tabs · split)     │
│              │                  │                                   │
│ 📌 Pinned    │  📄 auth-strat…  │  [📄 auth-strategy.md][🖼 png][+]│
│ 🏛 Company   │  🖼️ arch-diag…   │  ┌─────────────────────────────┐  │
│ 📁 Eng       │  📕 rfc-9421.pdf │  │  Status chips · v3 · 2d ago │  │
│  ⏳ Pending  │  🎬 walk.mp4     │  │  Auth strategy              │  │
│  📁 Decisions│  📊 review.pptx  │  │  -----------                │  │
│  📁 Files    │                  │  │  Why JWT over sessions…     │  │
│ 📁 Marketing │                  │  └─────────────────────────────┘  │
│ 📁 Support   │                  │  ↗ Source: rfc-9421.pdf · p.4    │
└──────────────┴──────────────────┴───────────────────────────────────┘
```

The home page (separate route) replaces this layout when no folder is selected. See [Home Page](#home-page) below.

### Routes

| Route | Component | Notes |
|---|---|---|
| `/:companyPrefix/memory` | `MemoryHome` | Landing — pending banner · search · dept tiles · recents |
| `/:companyPrefix/memory/explore` | `MemoryExplorer` | 3-pane explorer · last-opened folder restored from `localStorage` |
| `/:companyPrefix/memory/explore/:deptSlug?` | `MemoryExplorer` | Optional dept scope · `?folder=`/`?file=`/`?tab=` query params drive selection |

Both routes share a sidebar entry `🧠 Memory` (already exists).

### File model — hybrid

The tree holds two kinds of nodes, indistinguishable in mechanics, distinguishable by viewer:

| Node kind | Backed by | Lives in |
|---|---|---|
| `.md` memory item | `memory_items` row | DB only; content + embedding inline |
| Raw asset | New `memory_assets` row + StorageService blob | DB row + `storage/{companyId}/file-imports/…` |

Both gain a new `folderPath` text column that places them in the tree. Both can be moved, renamed, deleted with the same operations.

---

## Tree structure

### Top level

```
📌 Pinned                — system-curated, items the founder pinned for quick access
🏛 Company               — identity-layer items (vision, mission, values, brand decks)
📁 [Department 1]
📁 [Department 2]
…
⏷ Working                — collapsed by default, dimmed; auto-archives after 7 days
+ New folder
```

`📌 Pinned` is a **virtual folder** — its contents are computed (memory items where `founderPinnedToTop: true`, see [Schema](#database-schema)). It's not a real path; pinning sets a flag.

`🏛 Company` is a **real folder** at company root, distinct from any department. Its items have `folderPath` like `Company/vision.md`. Identity-layer items default here.

Departments use their existing slug (e.g. `Engineering`, `Marketing`).

`⏷ Working` is a virtual folder showing all items with `layer: "working"`. Visible but dimmed; users rarely interact directly. Auto-archive lifecycle is unchanged from Phase 5.

### Per-department seed (varies by `functionType`)

When a department is created, it is seeded with default sub-folders matching its function type. Folders are created on demand (lazy `memory_folders` rows) the first time something is filed into them, but they appear in the tree from creation. Users can rename, delete, or add folders freely.

| Function type | Seed folders |
|---|---|
| `software_development` | `⏳ Pending Review` (virtual) · `Decisions` · `Playbooks` · `References` · `Architecture` · `Active Goals` (virtual) · `Files` |
| `marketing` | `⏳ Pending Review` · `Decisions` · `Brand` · `Campaigns` · `References` · `Active Goals` · `Files` |
| `support` | `⏳ Pending Review` · `Playbooks` · `Macros` · `References` · `Active Goals` · `Files` |
| `finance`, `hr`, `legal`, `research`, `operations`, `general`, `custom` | `⏳ Pending Review` · `Decisions` · `Policies` · `References` · `Active Goals` · `Files` |

All seed-folder content reuses the 11 starter templates already shipped in Phase 4 (`memory-starter-templates.ts`).

### Virtual folders

Three folders per department are **virtual** — they're computed views, not real paths:

1. **`⏳ Pending Review`** — items where `status = 'pending'` and `departmentId = X`. Sorted by createdAt desc. Yellow tint in tree.
2. **`🎯 Active Goals`** — items where `goalId IS NOT NULL` and the linked goal is `status: 'active' | 'at_risk'`. Grouped by goal name when expanded. Items move out automatically when their goal completes (Phase 5 lifecycle).
3. **`📁 Files`** (per dept) — `memory_assets` rows with `folderPath = '<Dept>/Files'` (and any user-created subpaths under it).

Virtual folders cannot be renamed or deleted (the tree shows them with reduced affordance).

### Path semantics

`folderPath` is a normalized POSIX-style string with `/` separators. Examples: `Company`, `Engineering/Decisions`, `Engineering/Files/RFCs`. The leading segment is always either `Company` or a department slug. There is no leading `/`.

A `memory_folders` row exists for every user-created folder (to support empty folders + ordering). Seeded folders only get a row when first used.

### Drag-and-drop

- Drag `.md` item or asset between folders → updates `folderPath` (DB-only, no file moves).
- Drag a folder → renames its path prefix on every contained item (atomic transaction).
- Cannot drag virtual folders or drag items into them (the move would be a no-op).

---

## Layout

### Three panes — desktop default

| Pane | Width (default) | Behavior |
|---|---|---|
| Left — Tree | 240px, resizable, collapsible to 0 | `localStorage` remembers width + expanded folders |
| Middle — File list | 320px, resizable | List view default; grid toggle for image-heavy folders |
| Right — Viewer | flex remaining | Tabs at top, body adapts per file type |

Panel resizing uses the existing `react-resizable-panels` already in workspace UI.

### Top bar

```
🧠 Memory · breadcrumb (e.g. Engineering › Decisions › auth-strategy.md)
                                              [🔍 Search this folder…  ⌘K]
                                                          [+ New ▾] [⬆ Import]
```

- **Breadcrumb** — clickable; clicking a segment navigates to that level.
- **Search** — scoped to the current folder when focused via click; `⌘K` (or `Ctrl+K`) opens a global quick switcher overlay across the whole company. Both wire through `searchMultiPath`.
- **+ New ▾** — dropdown: `New memory item` · `New folder here` · `Upload file`. Items are filed in the currently selected folder.
- **⬆ Import** — opens the existing Phase 4.5 file import dialog (PDF/DOCX/TXT today; image/video/PPT extensions stub seam).

### File list (middle pane)

- List view (default): rows of `[icon] [name + metadata] [modified] [status pill]`. Click to select → opens in viewer.
- Grid view (toggle): tile thumbnails (auto-generated for images, page-1 thumbnail for PDF/PPT, video poster frame).
- Sort options: recent · name · status · size.
- Multi-select via shift/cmd-click for bulk operations (approve, archive, move, delete).
- Empty folder: shows the folder summary view in the viewer pane (see below).

### Tabbed viewer (right pane)

- Browser-style tabs with `✕` close, `+` new, drag-to-reorder, `⌘W` to close active.
- Split-view button (`⬚`) opens a second viewer pane below; `⌘\` is the shortcut.
- Tabs persist across navigation (in `localStorage` until explicitly closed); reopening the page restores them.
- Maximum 8 tabs open simultaneously; oldest closes when limit hit.

---

## Home page

Route: `/:companyPrefix/memory`

```
┌────────────────────────────────────────────────────────────────────┐
│ ⏳ 17 items waiting for your review                       [Review ▶] │
│    Engineering 14 · Marketing 2 · Support 1                         │
├────────────────────────────────────────────────────────────────────┤
│ 🔍 Search across all memory…                              ⌘K         │
├────────────────────────────────────────────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────┐  │
│ │📌 Pin│ │🏛 Co │ │📁 Eng    │ │📁 Mkt    │ │📁 Support│ │+ New │  │
│ │   8  │ │   5  │ │ 142 ⏳14 │ │  37 ⏳2  │ │  23 ⏳1  │ │ Dept │  │
│ └──────┘ └──────┘ └──────────┘ └──────────┘ └──────────┘ └──────┘  │
├────────────────────────────────────────────────────────────────────┤
│ Recent                                                              │
│ 📄 auth-strategy.md · 2d                                            │
│ 📕 rfc-9421.pdf · 5d                                                │
│ 📄 brand-voice.md · 1w                                              │
└────────────────────────────────────────────────────────────────────┘
```

### Sub-decisions (locked)

1. **Smart landing** — first visit lands on home; subsequent visits restore last-opened folder via `localStorage["aoa:memory:last-explored"]`. A `🏠 Home` segment in the breadcrumb of the explorer view returns here.
2. **Pending banner self-hides** when zero across all depts. Reduces nag.
3. **Empty state** — first-time user (zero memory items, no departments) sees onboarding cards: "Add company vision" (opens `CreateMemoryDialog` pre-scoped to identity) · "Browse 11 starter templates" (opens existing `StarterTemplatesDialog`) · "Upload a doc to extract from" (opens import dialog). Reuses existing components; no new flow.
4. **Recents** = the founder's last 5–10 items opened in the explorer (tracked via `memory_items.lastAccessedAt` filtered by `accessedByUserId`). NOT what agents read — agent activity stays in the workspace `MemorySection` shipped in Phase 3.
5. **Search on home** = global ⌘K-style overlay; on explorer = scoped to current dept (matches the [Search](#search) section).

---

## File-type viewers

All viewers share the same tab strip + status header + toolbar. The body changes by MIME type. Status header (per locked decision Q5/Q6):

```
[Approved/Pending/Draft pill] [layer chip · scope chip · category chip]   [v3 · 2d ago]
                              [Title]
[👁 Preview] [✎ Edit] [📜 Versions(3)] [🔗 Backlinks(2)]                  [⋯]
```

### `.md` memory item

- **Adaptive default** (per Q5):
  - `status === 'approved'` (any layer) → Preview mode
  - `status IN ('pending', 'draft', 'rejected')` → Editor mode with prominent action buttons (`✓ Approve` · `Edit & Approve` · `Reject`)
- Preview = rendered Markdown (existing `ReadmeRender` from marketplace M.3a, or a sibling `MemoryMarkdownRender` if app-specific link transforms are needed).
- Editor = `@uiw/react-md-editor` or similar (TBD in implementation; existing AoA stack inspection during planning). Auto-saves draft to a new `memory_item_versions` row with `status: 'draft'` after 1.5s of idle (debounced).
- "Submit for approval" → version `status` flips to `pending`; item appears in dept's Pending Review folder. Original approved version remains current.
- Versions drawer (`📜 Versions (N)` button) shows full history with diff viewer + restore.
- Backlinks panel (`🔗 Backlinks (N)` button) lists items that mention this one (from existing `memory_relations` table).
- **Source footer** — present iff `sourceFileId IS NOT NULL`; renders `↗ Source: <filename> · p.X ¶Y` chip + `⤢ Show source text` button. Click opens [SourceTextDrawer](#source-text-drawer).

### PDF (and DOCX rendered as HTML)

- PDF.js viewer with page thumbnails strip on the left of the viewer body.
- Right rail: **Extracts sidebar** — list of all `memory_items` where `sourceFileId = thisFile.id`, each row showing `name · status · current folder path · color-coded highlight chip`.
- Hover an extract row → highlight the corresponding span on the rendered page (uses `charStart/charEnd` from `memory_extractions` table, already in Phase 0 schema).
- Click a row → opens the .md item in a new viewer tab.
- Toolbar additions: `⤢ Re-extract` (creates a new pending set, does not touch existing approved items) · `⬇ Download` · `📄 Extracted text` (raw text view).
- DOCX renders via `mammoth.convertToHtml` (already a dependency from Phase 4.5) with the same extracts sidebar.

### Image

- Viewer body shows the image with zoom (mousewheel) + pan (drag).
- Toolbar: `🔍 OCR` button (stub for v2 — pipes through the same Stage-2 extraction seam).
- Extracts sidebar present if any items have `sourceFileId` matching.

### Video

- HTML5 `<video>` element with native controls.
- Toolbar: `🎙 Transcribe` button (stub for v2).
- Extracts sidebar shows items with timestamp anchors when transcription seam ships.

### PPTX

- Slide thumbnail grid (3-up by default).
- Click a slide → enlarged preview.
- Toolbar: `⬇ Download` · `↗ Open in PowerPoint/Slides` (if integration exists, otherwise hidden).
- For now, slide rendering = page-level thumbnails generated server-side via `mammoth` or `pdf-parse` after PPTX→PDF conversion (libreoffice). Implementation note: this generation is **out of scope for the v1 redesign**; PPTX shows a generic file viewer with download/open-with options until a slide-renderer ships.

### Generic / unknown MIME

- Fallback: file metadata (name, size, type, uploaded by/when) + download button.

---

## Source-text drawer

Opens from the source footer of any `.md` viewer when the item has `sourceFileId`.

- Slides in from the right side of the viewer pane (over the body, not over the tree/list).
- Renders the source file's relevant page using PDF.js (or DOCX HTML render).
- Highlights the originating passage in yellow using `charStart/charEnd` from the `memory_extractions` row.
- Multiple highlights if the extract pulled from multiple pages — `◀ prev / N of M / next ▶` controls.
- `↗ Open file` button switches to the source file's tab in the viewer.
- `⤢ Re-extract` button on the drawer footer kicks off a fresh extraction (same behavior as the PDF viewer's button).

---

## Lifecycle: upload → extract → approve → route

1. **Upload** via top bar `⬆ Import` → file goes through `fileImportService.upload` (existing Phase 4.5 path) → stored at `storage/{companyId}/file-imports/{hash}-{name}.{ext}`.
2. A new `memory_assets` row is created with `folderPath: '<Dept>/Files'` (or wherever the user dropped it). The asset is **immediately** visible in the tree.
3. The `file_import_jobs` worker picks up the job, runs Stage 1 (text extraction) + Stage 2 (LLM extraction or paragraph chunking fallback) — unchanged from Phase 4.5.
4. Each extracted candidate becomes a `memory_items` row with `status: 'pending'`, `sourceFileId: <assetId>`, and a **predicted** `folderPath` derived from its `category` (e.g. `Engineering/Decisions`). The predicted path is the proposed destination once approved.
5. The dept's `⏳ Pending Review` virtual folder shows them via a query on `status = 'pending'` regardless of `folderPath`. The home-page banner increments. LiveEvents pushes `memory.item.created` so other tabs/users see it.
6. Founder reviews each item:
   - **✓ Approve** → `status: 'approved'`. The predicted `folderPath` becomes effective (founder can override the destination via the kebab menu before approving). Item disappears from Pending Review and appears in the destination folder.
   - **Edit & Approve** → editor opens; on save, item is approved with edits in a single transaction.
   - **Reject** → `status: 'rejected'`. Item removed from Pending Review, hidden by default (visible in archived view).
7. The source PDF in `<Dept>/Files/` retains a backlink-style metadata count (`extractedItemCount`); its viewer's Extracts sidebar lists the new locations.

### Approving an already-approved item (re-edit)

1. Founder opens approved item → toolbar shows `✎ Edit`.
2. Click `✎ Edit` → editor opens, status banner becomes `⏳ Editing draft (unpublished)`.
3. Auto-save debounced 1.5s → new `memory_item_versions` row with `status: 'draft'`. Approved version remains current; agents continue to see it.
4. `Submit for approval` → version `status: 'pending'`. Item shows up again in Pending Review (with a "Re-edit of approved item" badge).
5. `Approve` → new version becomes current; older approved version moves to history (`📜 Versions` shows it, restorable).

---

## Search

| Surface | Trigger | Scope | Backed by |
|---|---|---|---|
| Top-bar input on explorer | click input or `/` | Current folder + descendants | `searchMultiPath` |
| ⌘K global overlay | `⌘K` / `Ctrl+K` from anywhere on the page | All memory across all departments | `searchMultiPath` (semantic if available) + recent items |
| Home-page central search | click input on home | All memory across all departments | Same as ⌘K |

The ⌘K overlay (component: `MemoryQuickSwitcher`) shows:

- Top section: **Recent items** (last 5 the founder opened).
- Live results: filename match (substring, fuzzy ranked) + content match (semantic via `memory.search`).
- Each result row: icon + title + folder path + status pill.
- Enter → opens in viewer tab; `⌘+Enter` → opens in new tab; arrow keys to navigate.

Top-bar search is incremental (debounced 200ms) and filters the file list in real-time. Tree nodes that don't contain matches are dimmed.

---

## Folder click → folder summary view

When a folder (real or virtual) is selected and no file is open in the active tab, the viewer pane shows a `MemoryFolderSummary` instead of an empty state:

```
📁 Engineering / Decisions
                                                    [+ New here ▾]
12 items · 8 approved · 4 pending
Last modified: 2 days ago by you
Total size: 47 KB · 12,400 tokens estimated
Pinned-to-skill: 3 items

Recent activity
─────────────────
✎ auth-strategy.md  edited by you · 2d
✓ db-choice.md      approved by you · 5d
+ token-revocation.md  added (extracted from rfc-9421.pdf) · 1w
```

For virtual folders (`Pending Review`, `Active Goals`, `Pinned`):
- Pending Review summary shows triage stats (X from file imports, Y from agents) and a `Review all ▶` button that walks through every item sequentially.
- Active Goals summary groups items by goal with each goal's status badge.
- Pinned summary lists items with their original folder paths.

---

## Pinned-to-skill

The existing `pinnedToSkill` field on `memory_items` is preserved as-is. UI changes:

1. **Removed from file list rows** — no more 📌 chip in the middle pane (clutter, low signal).
2. **Removed from viewer status header chips** — no more `📌 pinned-to-skill` chip alongside category/layer.
3. **Kept in viewer kebab menu (`⋯`)** — `📌 Pin to skill ▶` opens a sub-menu with the skill picker. Toggles `pinnedToSkill` and the target `pinnedSkillKey`.
4. **Surfaced on the folder summary view** as a count line (`Pinned-to-skill: 3 items`).
5. **Workspace `MemorySection` (Phase 3)** remains the primary surface where this state matters — its "Skill-materialized" group already shows pinned items per agent run, unchanged.

User-facing copy can be revised later (e.g. "Always include in agent context"); the column name `pinnedToSkill` stays in the schema.

---

## Database schema changes

### Modified: `memory_items`

| New column | Type | Notes |
|---|---|---|
| `folderPath` | `text` not null default `''` | POSIX-style; e.g. `Engineering/Decisions`. Empty string means uncategorized (rare; visible in dept root). |
| `lastAccessedByUserId` | `uuid` nullable | Tracks who last opened this in the explorer (for Recents). Distinct from `lastAccessedAt` (already exists, used by staleness detection). |
| `founderPinnedToTop` | `boolean` default false | Drives the `📌 Pinned` virtual folder. NOT the same as `pinnedToSkill`. |

Migration: backfill `folderPath` for every existing item using a deterministic rule:
- `layer === 'identity'` AND `departmentId IS NULL` → `Company`
- `departmentId IS NOT NULL` → `<DeptSlug>/<CategoryToFolder(category)>` where `CategoryToFolder` is the seed map (e.g. `decision → Decisions`, `policy → Policies`, etc.)
- Working layer items → `<DeptSlug>/Working` (a hidden virtual sub-path).
- Anything that doesn't fit → `<DeptSlug>` (root of dept; founder can move).

### New: `memory_assets`

Holds raw uploaded files (PDFs, images, videos, PPTs, etc.) as first-class tree nodes. Distinct from `memory_items` because their content is a blob, not text.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `companyId` | `uuid` FK → companies | cascade delete |
| `departmentId` | `uuid` nullable FK → projects | scope; null for company-level assets |
| `folderPath` | `text` not null | e.g. `Engineering/Files`, `Company/Brand` |
| `fileName` | `text` not null | display name; user can rename without changing storage |
| `mimeType` | `text` not null | standard MIME; drives viewer selection |
| `fileSize` | `integer` not null | bytes |
| `storageKey` | `text` not null | StorageService object key (e.g. `{companyId}/file-imports/{hash}-{name}.pdf`) |
| `importJobId` | `uuid` nullable FK → file_import_jobs | for files that came in via the import pipeline |
| `extractedItemCount` | `integer` default 0 | denormalized; updated when extraction completes / re-runs |
| `metadata` | `jsonb` nullable | per-MIME extras (page count, duration, slide count, OCR status…) |
| `uploadedByUserId` | `uuid` nullable FK → users | |
| `createdAt`, `updatedAt` | `timestamp` | |

Indexes: `(companyId, departmentId)`, `(companyId, folderPath)`, `(importJobId)`.

### New: `memory_folders`

Holds user-created folder rows. Seeded folders are lazy — created on first use. Required so empty user folders persist across reloads and so we can store ordering / icons.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `companyId` | `uuid` FK → companies | cascade delete |
| `departmentId` | `uuid` nullable FK → projects | null for `Company` and root |
| `path` | `text` not null | normalized POSIX path (e.g. `Engineering/Decisions/RFCs`) |
| `displayName` | `text` not null | rendered in tree (defaults to last segment of path) |
| `icon` | `text` nullable | optional emoji/icon override |
| `sortOrder` | `integer` default 0 | within parent folder |
| `seedKey` | `text` nullable | identifies seeded folders so we know which not to delete |
| `createdAt`, `updatedAt` | `timestamp` | |

Unique index on `(companyId, path)`.

### Migration steps

1. Add columns + tables (additive).
2. Backfill `memory_items.folderPath` per the deterministic rule above.
3. Create `memory_folders` seed rows for every existing department per its `functionType`.
4. Convert any existing imported files referenced from `memory_items.sourceFileId` to `memory_assets` rows (currently `sourceFileId` points at `file_import_jobs.id`; we shift it to point at `memory_assets.id` and link the import job via `memory_assets.importJobId`).
5. Drop nothing in this migration. Old `Memory.tsx` route remains accessible at `/:companyPrefix/memory/legacy` for one minor version as a safety net.

---

## API additions

### REST routes (`/api/companies/:companyId/memory/...`)

All scoped to the company implicitly. RBAC: founder + team_lead can write; team_member is read-only by default (overrides via `executionWorkspacePolicy`-style settings — TBD per dept config in implementation plan).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/folders` | List `memory_folders` for the company. Optional `?departmentId=`. |
| `POST` | `/folders` | Create a folder. `{ departmentId?, path, displayName, icon? }`. Validates path normalization. |
| `PATCH` | `/folders/:id` | Rename / move / re-icon. |
| `DELETE` | `/folders/:id` | Delete folder; items inside reassigned to parent path. |
| `GET` | `/assets` | List assets. Filters: `?folderPath=`, `?departmentId=`, `?mimeType=`. |
| `POST` | `/assets/upload` | Upload a raw asset (multipart). Wraps the existing `fileImportService.upload` — same StorageService write, same `file_import_jobs` row created, plus a `memory_assets` row inserted in the same transaction. The legacy `POST /file-imports/upload` route stays as a thin alias for one minor version. |
| `GET` | `/assets/:id` | Asset metadata + signed URL for content. |
| `GET` | `/assets/:id/content` | Stream the file (proxy through StorageService). |
| `PATCH` | `/assets/:id` | Rename / move / update metadata. |
| `DELETE` | `/assets/:id` | Delete asset; orphans extracted items unless cascade requested. |
| `POST` | `/assets/:id/re-extract` | Kick off a fresh extraction; new pending items, existing untouched. |
| `GET` | `/quick-switcher` | Combined search across items + assets, paged. |
| `PATCH` | `/items/:id/move` | Update `folderPath` on a memory item (separate from generic update for clarity + LiveEvents). |
| `PATCH` | `/items/:id/pin-to-top` | Toggle `founderPinnedToTop`. |

### LiveEvents

New event types broadcast to all connected clients on the same company:

- `memory.item.created` · `memory.item.updated` · `memory.item.moved` · `memory.item.deleted`
- `memory.asset.created` · `memory.asset.updated` · `memory.asset.deleted`
- `memory.folder.created` · `memory.folder.updated` · `memory.folder.deleted`
- `memory.import.progress` (delta during file extraction)

The tree subscribes to all of them and updates optimistically; the file list and viewer subscribe to the events relevant to their currently open path/file.

---

## Component inventory (UI)

New components under `ui/src/components/memory/` and `ui/src/pages/`:

- `MemoryHome.tsx` — page; pending banner + search + dept tiles + recents
- `MemoryExplorer.tsx` — page; 3-pane layout shell, panel resize state, route param parsing
- `MemoryTree.tsx` — left pane; recursive tree component with virtual-folder support
- `MemoryFileList.tsx` — middle pane; list/grid toggle
- `MemoryViewer.tsx` — right pane; tab strip + body slot
- `MemoryViewerTabs.tsx` — tab strip with reorder + close + split
- `MemoryFolderSummary.tsx` — folder-click view in viewer pane
- `MemoryEmptyState.tsx` — first-time onboarding cards on home
- Per-MIME viewer bodies under `ui/src/components/memory/viewers/`:
  - `MarkdownItemViewer.tsx` (preview/edit toggle, source footer, versions drawer, backlinks)
  - `PdfFileViewer.tsx` (PDF.js + thumbnails + extracts sidebar)
  - `DocxFileViewer.tsx` (mammoth render + extracts sidebar)
  - `ImageFileViewer.tsx` (zoom/pan)
  - `VideoFileViewer.tsx` (HTML5 player + transcript stub)
  - `PptxFileViewer.tsx` (slide grid stub)
  - `GenericFileViewer.tsx` (metadata + download fallback)
- `SourceTextDrawer.tsx` — slides in from right of viewer body
- `ExtractsSidebar.tsx` — right rail of file viewer; lists extracted items
- `MemoryQuickSwitcher.tsx` — ⌘K overlay
- `MemoryNewMenu.tsx` — top-bar `+ New ▾` dropdown
- `PendingReviewBanner.tsx` — home page banner
- `DepartmentTile.tsx` · `RecentItemRow.tsx` — home composition
- `MemoryBreadcrumb.tsx` — top-bar breadcrumb
- `FolderTreeNode.tsx` — single tree row with expand/select/drag

Reused (no changes needed):
- `CreateMemoryDialog`, `MemoryDetailPanel`, `VersionCard`, `SimpleDiff`, `SuggestionQueue`, `StarterTemplatesDialog`, `ArchiveSuggestionCard` — all from existing `Memory.tsx`. Each gets extracted into its own file as part of the refactor.

Hooks:
- `useMemoryTree(companyId, deptId?)` — fetches folders + items + assets and shapes them into a tree.
- `useMemoryViewerTabs()` — manages open tabs in `localStorage`.
- `useMemoryQuickSwitcher()` — debounced fuzzy + semantic search.
- `useMemoryLiveEvents(companyId)` — subscribes to all `memory.*` events and invalidates relevant queries.

---

## Visual design language

### Color tokens (existing AoA palette, dark mode primary)

| Use | Token | Hex (dark) |
|---|---|---|
| Page entity accent | `var(--entity-memory)` | existing AoA token |
| Status: approved | green family | `#0e3a1c` bg / `#7ee0a3` fg |
| Status: pending | amber family | `#3a2c0e` bg / `#e0c97e` fg |
| Status: archived/draft | gray family | existing tokens |
| Tree selection | blue family | `#1c2540` bg |
| Source highlight (drawer) | yellow `#fff59d` (dark mode adapts) | |
| Extract category color codes | varied per item, deterministic from id | |

### Typography

| Element | Size | Weight |
|---|---|---|
| Viewer body (markdown) | 14px / 1.65 line-height | 400 |
| Viewer title | 18-20px | 600 |
| Tree row | 12px / 1.7 | 400; 600 for folders |
| File list row title | 12px | 600 |
| File list row metadata | 11px | 400, 60% opacity |
| Tab label | 11px | 400 |
| Status / metadata chips | 10px | 500 uppercase letter-spacing 0.05em |
| Top-bar / breadcrumb | 11-12px | 400 |

Font stack: existing AoA `ui-sans-serif, system-ui` for body; `ui-monospace, Menlo, monospace` for tree rows and code blocks.

### Spacing

8px base grid. Tree rows 28px tall, file list rows 48px tall, viewer toolbar 36px tall, status header 56px tall.

### Motion

| Interaction | Duration | Easing |
|---|---|---|
| Tree expand/collapse | 180ms | `ease-out` |
| Tab open/close | 150ms | `ease-out` |
| Source drawer slide | 240ms | `cubic-bezier(0.2, 0, 0, 1)` |
| Hover states | 80ms | `ease-out` |
| Quick switcher fade | 100ms | `ease-out` |

Reduced-motion media query disables transitions per AoA convention.

### Iconography

Lucide icons (existing dependency). MIME-specific icons:
- `.md` / memory item → `📄` (or Lucide `FileText`)
- PDF → `📕` (or `FileType`)
- Image → `🖼️` (or `Image`)
- Video → `🎬` (or `Film`)
- PPTX → `📊` (or `Presentation`)
- DOCX → `📘` (or `FileText` variant)
- Folder → Lucide `Folder` / `FolderOpen` (chevron-driven state)

Status badges use Lucide `Check`, `Clock`, `Archive`, `XCircle`.

---

## Cloud-readiness bake-ins (verbatim from brainstorming)

1. **Folder paths stored in DB column** on `memory_items` and `memory_assets` — single source of truth, no filesystem sync required.
2. **`memory_folders` table** scoped per company — supports empty/named folders + ordering metadata; lives entirely in the DB.
3. **LiveEvents subscription** on the memory tree, file list, and viewer — multi-user updates are immediate without page refresh.
4. **Optimistic UI for moves/renames/edits** — reverts cleanly on server reject (already the AoA pattern via `react-query` mutations).
5. **All queries companyId-scoped** — already the AoA convention; new routes follow it.
6. **Storage paths for uploads remain provider-abstract** — uploads go through `StorageService.putFile`; UI never references local-disk-specific paths.

When AoA flips to cloud (S3 storage + managed Postgres + multi-user auth), this page works without a rewrite — only deployment/auth surfaces change.

---

## Migration / coexistence

1. The new explorer ships behind the same `/:companyPrefix/memory` route. The old `Memory.tsx` is renamed to `MemoryLegacy.tsx` and mounted at `/:companyPrefix/memory/legacy` for one minor version as a safety net.
2. Existing memory items get default `folderPath` per the [migration backfill rule](#migration-steps).
3. Existing imported files (currently lookup-only via `memory_items.sourceFileId → file_import_jobs`) become `memory_assets` rows during migration; the `file_import_jobs` table stays for the import pipeline.
4. Existing UI affordances that haven't been redesigned yet (the "Suggestions" tab, archive suggestion cards, agent pending queue) port into the new layout as folder summary views or inline banners — no functionality lost.
5. The Workspace `MemorySection` (Phase 3) is unchanged; it continues to read `memory_retrievals` and surface what each agent saw per run.
6. The marketplace M.4 settings tab and per-company status tables (Memory plugin telemetry, etc.) are unchanged — they read the same DB, no surface conflicts.

---

## Implementation phasing guidance

This spec is intentionally end-state. The implementation plan should phase delivery so each phase is shippable and testable on its own. Suggested decomposition (the writing-plans skill will refine):

- **6.0 Foundation** — DB migrations (folderPath, memory_assets, memory_folders, backfill) · API routes for folders/assets/items/move · LiveEvents wiring.
- **6.1 Core explorer shell** — `MemoryExplorer` page · `MemoryTree` · `MemoryFileList` · `MemoryViewer` shell · `MarkdownItemViewer` (preview/edit, source footer, versions drawer).
- **6.2 PDF + DOCX viewers** — `PdfFileViewer` with PDF.js + extracts sidebar · `DocxFileViewer` · `SourceTextDrawer`.
- **6.3 Home page + search** — `MemoryHome` · `PendingReviewBanner` · dept tiles · `MemoryQuickSwitcher` · top-bar scoped search · breadcrumb.
- **6.4 Folder summary + remaining viewers** — `MemoryFolderSummary` · `ImageFileViewer` · `VideoFileViewer` · `PptxFileViewer` (download stub) · `GenericFileViewer`.
- **6.5 Polish + migration cutover** — empty states · LiveEvents debouncing · ⌘K ranking refinements · legacy route removal · accessibility audit.

Each phase keeps the tree navigable end-to-end; users always have a working page. The legacy `Memory.tsx` runs in parallel at `/legacy` until 6.5.

---

## Out of scope

| Item | Why deferred |
|---|---|
| Manual highlight-to-extract from PDF | Whole new input mode; powerful but not critical-path. v2. |
| Memory items as real `.md` files on disk (Future-A) | Cloud sync conflicts; better as a v3 pro-tier feature. |
| Obsidian `[[wikilinks]]` graph view | Basic backlinks ship; full graph navigation is a separate effort. |
| Smart re-extract merge | Re-extract creates new pending set; merging with existing approved items needs LLM dedup logic. v2. |
| Mobile / narrow viewport | Spec optimizes for desktop and tablet-wide. Mobile is separate. |
| Real-time collaborative editing (OT/CRDT) | Multi-user is supported via LiveEvents + version-on-save; live cursors are not. |
| Renaming `pinnedToSkill` → e.g. "Always-on memory" | Display-string-only change; defer until we settle naming with users. |
| OCR / video transcription / PPTX slide rendering | Stage-2 extraction seam exists; building these processors is its own scope. |

---

## Open questions / TBDs (resolve in implementation plan)

1. Markdown editor library choice — `@uiw/react-md-editor`, `monaco`, or a lighter-weight option. Test against AoA's existing dependencies and dark-mode tokens.
2. PPTX slide rendering — server-side libreoffice conversion vs. client-side library. Currently spec'd as a download-only stub for v1.
3. Exact debouncing / batching for LiveEvents tree updates when many items change in quick succession (e.g. 14-item batch import).
4. Whether the `📌 Pinned` virtual folder should also include items with `pinnedToSkill: true`, or strictly `founderPinnedToTop: true`. Lean toward strict separation; revisit during implementation.
5. RBAC granularity for folder operations (rename, delete) — likely team_lead+ for their dept, founder for cross-dept. Confirm against existing RBAC patterns.

---

## References

- Existing `ui/src/pages/Memory.tsx` (2306 LOC) — being replaced.
- `ui/src/components/workspace/sections/MemorySection.tsx` — Phase 3 component, unchanged.
- `server/src/services/file-import.ts` — Phase 4.5 pipeline, reused.
- `server/src/services/memory-skill-sync.ts` — Phase 2 skill materialization, unchanged.
- `server/src/services/memory-starter-templates.ts` — Phase 4 starter templates, surfaced in empty state.
- `docs/superpowers/specs/2026-05-01-memory-file-import-design.md` — Phase 4.5 design doc; this redesign sits on top.
- Brainstorming session screens (preserved in `.superpowers/brainstorm/968-1777707240/content/`):
  - `tree-shape.html`, `layout-3pane.html`, `extracted-items-relationship.html`, `edit-preview-mode.html`, `lifecycle-clarified.html`, `storage-architecture.html`, `cloud-readiness.html`, `design-recap.html`, `final-ui-reference.html`, `memory-home-page.html`.
