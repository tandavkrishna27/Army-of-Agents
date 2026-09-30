# Item 5 — Memory Rework Implementation Plan (v2, Codex-corrected)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` checkboxes.

**Goal:** Turn the onboarding memory step into a multi-scope "seed your knowledge" surface — a **company-wide** card (→ identity-layer proposals) + one per **department** (→ domain-layer), each with **drop-any-files** + text. Text-like files are **read server-side and folded into the Librarian's prompt**; images/binaries are **attached as memory assets** (not read). The Librarian synthesizes `.md` memory items **filed into the seeded folder tree** and proposes them (pending); the founder approves.

**Scope decision (2026-07-20):** **Repo code-reading is DEFERRED** to a dedicated follow-up (it needs workspace clone/sync + execution-target plumbing that direct crew runs lack). This plan ships files + text + company/department scopes.

**Design spec:** `docs/aoa/plans/2026-07-19-onboarding-improvements-design.md` (Item 5).

## Why v2 — Codex review corrections (all P1s addressed)

| Codex P1 | Fix in this plan |
|----------|-------------------|
| Files are **opaque storage keys**, not readable paths | Phase 5c: the **server** reads asset bytes via `StorageService` and injects **text-like** file content into the prompt (bounded). Images/binaries: attach-only, never "read". No CLI file-path reading. |
| **Repo `repoUrl` isn't a checkout**; crew runs have no workspace | **Deferred** (out of scope). The UI shows the repo chip but the Librarian does not read it in v1. |
| `write_memory` has **no `folderPath`** | Phase 5b: extend the `write_memory` tool + `memory.create` to accept + persist `folderPath`. |
| **NULL idempotency** (Postgres NULL distinct) | Phase 5a: **two partial unique indexes** (dept: where `department_id IS NOT NULL`; company: where `IS NULL`) + `isNull()` conflict lookups. |
| Validator requires non-empty text | Phase 5a: require **≥1 source** (`content` non-empty **or** `assetIds` non-empty). |
| Asset linkage: no ownership/dedup/atomicity | Phase 5a: validate each `assetId` belongs to the company; dedup `memory_assets` per `(companyId, storageKey)`; link inside the capture transaction. |
| Dispatch omits new context | Phase 5c: `braindump.ts` (the dispatcher) passes scope/layer/folder-list/file-text into `runAoaAgent` → the prompt. |
| Company root is `"Company"`, dept has seeded children | Phase 5b/5c: resolve the real folder — company root = `COMPANY_SEED_FOLDERS[0].path`; a department's proposals default to its seeded root, Librarian may pick a child. |
| LibrarianStep can't find company/identity proposals | Phase 5e: new company-wide list route/API + `isNull` correlation + **identity + domain** retrieval + scope grouping. |
| `ensure-librarian.ts` hardcodes domain | Phase 5c: make the Librarian instruction **layer-aware** (accept the passed layer). |
| Migration head is `0120` | Phase 5a: generated migration will be `0121_*` (never hand-number; `pnpm db:generate` assigns it). |

**Also (P2):** abandoned-upload cleanup is a **known v1 limitation** (onboarding is low-volume; documented, not blocking); dispatch stays synchronous (no repo scan → fast); real-Postgres idempotency + route + folderPath + identity-correlation tests added.

### v3 — second Codex round corrections
Codex **cleared**: Phase 5e, the 5a partial-index + `isNull` idempotency, and the 5c `braindump.ts → runAoaAgent → AoaTriggerPayload → aoa-trigger-prompt.ts` context transport. Remaining fixes now folded in:

| Codex (round 2) | Fix |
|---|---|
| Validator `content` is `.trim().min(1)` → file-only still 400s | 5a: **explicitly drop `.min(1)`** (allow empty, still bounded) *then* apply the ≥1-source refine. |
| **Asset linkage targets the wrong table** — `/memory/assets/upload` already creates a `memory_assets` row and returns its id; `assetService.getById` reads the *generic* `assets` table; inserting another row duplicates | 5a/5d: the UI uploads via **`/memory/assets/upload` with the scope's folderPath**; submission **validates those existing `memory_assets` ids belong to `companyId`, dedupes, and stores the ids on the capture** — it does **NOT** insert new `memory_assets` rows. |
| `StorageService` has **`getObject(companyId, storageKey)` → `Readable` stream**, not `get()` → bytes; braindump has no storage dep | 5c: wire `StorageService` into braindump; use `getObject` with a **bounded stream reader that stops at the remaining aggregate cap** (never buffer a full 50 MB then truncate). |
| Department folder root is **`projects.urlKey`** (children `${urlKey}/${seed.path}`); no "department seeded root" record; normalization alone allows bogus/cross-scope paths | 5b/5c: use `COMPANY_SEED_FOLDERS[0].path` (`"Company"`) for company and **`projects.urlKey`** for a department; **validate any `folderPath` against the allowed folder set for that scope** (reject nonexistent/cross-scope). |
| Wrong tool target: the Librarian uses the **internal-agent** `write_memory` (`services/internal-agent/tools/memory-write.ts`), not `mcp/tools/index.ts`'s `memory.write`; and **`memoryService.create` already persists `folderPath`** | 5b: change **only** `memory-write.ts` (schema + parse + normalize + forward). No `memory.create` change needed — smaller than planned. |
| Migration head is **0175** | 5a: use whatever `pnpm db:generate` emits; never hand-number. |

**Architecture:** extend the braindump pipeline. `BraindumpStep`/`LibrarianStep` (`ui/src/onboarding/inflight/`) + `braindumpApi` → `braindump` service/route → extended `braindump_captures` + `memory_assets` → `braindump.ts` dispatcher passes context → `aoa-trigger-prompt.ts` builds the Librarian prompt (typed text + server-extracted file text + scope layer + seeded folder list) → `write_memory(folderPath, layer)` → pending → founder approves.

**Global commands:** UI `cd ui && npx vitest run <p>`; server `cd server && npx vitest run <p>`; migration `pnpm db:generate`; typecheck `npx tsc --noEmit`; live-verify on `journey3` (`:3100`). Commit after each green step.

**Ordering:** 5a schema/capture → 5b `write_memory` folderPath → 5c dispatch + prompt (layer/folder/file-text) → 5d multi-scope UI → 5e LibrarianStep discovery/grouping.

---

## Phase 5a — Schema, capture, idempotency, ownership

**Files:** `packages/db/src/schema/braindump_captures.ts`; generated `packages/db/src/migrations/0121_*.sql`; `packages/shared/src/validators/braindump.ts`; `ui/src/api/braindump.ts`; `server/src/services/braindump.ts` + `server/src/routes/braindump.ts`; `server/src/services/assets.ts` (ownership lookup); test `server/src/__tests__/braindump.test.ts` + a real-Postgres idempotency test.

- [ ] **1. Read** `braindump.ts` (service + route + `submit` signature + dispatch to `runAoaAgent`), the **`/memory/assets/upload`** route + service (it creates the `memory_assets` row and returns its id — note the params, incl. whether it accepts a `folderPath`), and `memory_folders` seeding (`COMPANY_SEED_FOLDERS`, `seedForDepartment` → `${projects.urlKey}/${seed.path}`). Pin exact names. **Do not** use `assetService.getById` (that's the generic `assets` table, not `memory_assets`).
- [ ] **2. Schema** — make `department_id` nullable; add `scope text notNull default "department"`, `assetIds jsonb $type<string[]> notNull default []` (these hold **`memory_assets` ids**). Replace the single unique index with **two partial** unique indexes: `(companyId, departmentId, idempotencyKey) WHERE department_id IS NOT NULL` and `(companyId, idempotencyKey) WHERE department_id IS NULL`. (`repoIngest` **omitted** — repo deferred.)
- [ ] **3. Generate migration** `pnpm db:generate` → review the emitted file (head is `0175`, so it will be `0176_*` or later — **use whatever is generated; never hand-number**). Verify: nullable drop + 2 columns + both partial indexes.
- [ ] **4. Validator** (TDD) — `scope: enum["company","department"]`, `departmentId: uuid.nullable()`, `assetIds: array(uuid).default([])`. **Explicitly drop `.min(1)` from `content`** (allow empty; keep the max/bounded length) so file-only captures validate. Then `.refine` company⇒deptId null / department⇒deptId set, and `.refine` **≥1 source** (`content.trim()` non-empty OR `assetIds.length > 0`). Unit-test: text-only ✓, file-only ✓, neither ✗, wrong scope/deptId combos ✗.
- [ ] **5. Service test (TDD, sequence-db)** — submit `scope:"company"` (deptId null) persists scope + assetIds; submit `scope:"department"` likewise; a `memory_assets` id belonging to **another company is rejected**; duplicate ids in one payload are **deduped**; the idempotency conflict lookup uses `isNull(departmentId)` for company scope. Run → fail.
- [ ] **6. Implement** — service accepts the new fields; **validates each `assetIds` entry is an existing `memory_assets` row for this `companyId`** (reject otherwise), **dedupes** the id list, and **stores the ids on the capture**. It must **NOT insert new `memory_assets` rows** — the upload route already created them (inserting again duplicates the asset). Conflict lookup uses `isNull(departmentId)` for company scope. Run → pass.
- [ ] **7. Real-Postgres idempotency test** — follow the Windows embedded-pg integration pattern (memory: `initdbFlags` + `skipIf(false)`): apply migration, insert a company capture twice with the same idempotencyKey → exactly one row; a dept capture likewise; a company + dept capture with the same key coexist. Run.
- [ ] **8. API client** — `braindumpApi.submit` sends `scope`/`departmentId`/`assetIds`. Typecheck.
- [ ] **9. Commit.**

## Phase 5b — `write_memory` gains `folderPath`

**Files:** **`server/src/services/internal-agent/tools/memory-write.ts` ONLY** — this is the `write_memory` the Librarian actually calls. Do **NOT** edit `server/src/mcp/tools/index.ts` (that defines a different tool, `memory.write`, and changing it would not affect Librarian runs). **`memoryService.create` already accepts + persists `folderPath`**, so no `memory.ts` change is needed. Test: the memory-write tool test.

- [ ] **1. Read** `memory-write.ts` (its `parameters` schema, arg parsing, and the object it forwards to `memoryService.create`) and confirm `memoryService.create` already threads `folderPath` onto `memory_items`.
- [ ] **2. Failing test** — calling the internal `write_memory` with `folderPath: "Company"` persists that `folderPath` on the created (pending) item; a `folderPath` **not in the allowed set for the scope** is rejected; omitting it keeps today's default. Run → fail.
- [ ] **3. Implement** — add optional `folderPath` to the tool's `parameters`, parse + normalize via `normalizeMemoryFolderPath`, **validate it against the allowed folder set passed for this run** (company: `COMPANY_SEED_FOLDERS[0].path`; department: `projects.urlKey` + its `${urlKey}/${seed.path}` children — reject nonexistent/cross-scope), and forward it to `memoryService.create`. Run → pass.
- [ ] **4. Commit.**

## Phase 5c — Dispatch context + Librarian prompt (layer, folder, file-text)

**Files:** `server/src/services/braindump.ts` (dispatch payload); `server/src/services/internal-agent/aoa-agents/aoa-trigger-prompt.ts` (directive); `server/src/services/internal-agent/aoa-agents/ensure-librarian.ts` (layer-aware instruction); `server/src/services/storage*.ts` (read asset bytes); tests `server/src/__tests__/aoa-trigger-prompt.test.ts` + a braindump-dispatch test.

- [ ] **1. Read** how `braindump.ts` builds the `runAoaAgent` payload today (the `AoaTriggerPayload` shape that reaches `aoa-trigger-prompt.ts` — Codex confirmed this transport is sound), and **`StorageService.getObject(companyId, storageKey)`** — it returns a **`Readable` stream**, NOT bytes, and braindump currently has **no storage dependency wired**. Pin the `TEXT_LIKE` set (mime/ext: txt, md, csv, json, common code) vs. attach-only (images, pdf, docx, binaries).
- [ ] **2. Failing test** — the `braindump.ingest` prompt includes: the target **layer** (`identity` company / `domain` department), the **allowed folder set** for `write_memory folderPath` (company: `"Company"`; department: `projects.urlKey` + its `${urlKey}/${seed.path}` children), the typed `content`, AND the **extracted text of text-like dropped files**, with the **aggregate total bounded by `BRAINDUMP_CONTENT_PROMPT_CAP`**; image/binary assets are listed as "attached (not read)"; guardrail preserved (propose-only, nothing invented, binaries never converted to `.md`). Run → fail.
- [ ] **3. Implement** —
  - Wire `StorageService` into the braindump service (new dependency).
  - For each **text-like** asset, read via `getObject(companyId, storageKey)` using a **bounded stream reader**: accumulate decoded UTF-8 only up to the **remaining** aggregate budget and **stop/destroy the stream** at the cap — never buffer a whole (up to 50 MB) object and truncate afterwards.
  - Resolve the scope's allowed folder set (company root vs. `urlKey` + seeded children) and pass it, the layer, the file text, and the attached-asset list into the dispatch payload.
  - Extend `aoa-trigger-prompt.ts` to render them; make `ensure-librarian.ts`'s instruction **layer-aware** (stop hardcoding `domain`). Run → pass.
- [ ] **4. Commit.**

## Phase 5d — Multi-scope drop UI

**Files:** `ui/src/onboarding/inflight/BraindumpStep.tsx`; maybe `ui/src/onboarding/inflight/FileDropZone.tsx`; test `BraindumpStep.test.tsx`.

- [ ] **1. Read** current `BraindumpStep` + the **`/memory/assets/upload`** client call (this is the upload to use — it creates the `memory_assets` row and returns its id; check whether it takes a `folderPath`/scope param) + an existing upload UI for the chip/progress pattern.
- [ ] **2. Failing test** — renders a **Company** card + one card per department; each has textarea + drop zone + sub-text ("notes, docs, a logo, diagrams, PDFs…"); a software dept shows its repo/folder chip **as read-only context** (no read in v1); submit posts one capture per non-empty card (text OR files) with the right `scope`/`departmentId`/`assetIds`; Skip fires `onDone`. Run → fail.
- [ ] **3. Implement** the multi-scope cards + `FileDropZone` — each upload goes to **`/memory/assets/upload` with that card's scope folderPath** (company: `"Company"`; department: the dept's `urlKey`) so the `memory_assets` row lands in the right folder; collect the returned **`memory_assets` ids** into `assetIds` and show chips. Add the sub-text. Software dept repo chip is informational only ("reading coming soon"). Run tests + typecheck → pass.
- [ ] **4. Live-verify** on `journey3` (company + dept cards, drop a file → chip, submit) + **commit**.

## Phase 5e — LibrarianStep discovery + grouping

**Files:** `server/src/routes/braindump.ts` + `server/src/services/braindump.ts` (company-wide + all-scope list); `ui/src/api/braindump.ts` (`listByCompany`); `ui/src/onboarding/inflight/LibrarianStep.tsx`; tests.

- [ ] **1. Failing test (server)** — a list endpoint returns captures for a company **across scopes** (company + all departments), and proposal correlation uses `isNull(departmentId)` for company captures. Run → fail.
- [ ] **2. Implement** the company-wide list route/service + `braindumpApi.listByCompany`. Run → pass.
- [ ] **3. Failing test (UI)** — `LibrarianStep` fetches captures across scopes, retrieves proposed items across **identity + domain** layers, groups them under **Company** / each **Department**, shows attached files, and Approve works per item. Run → fail.
- [ ] **4. Implement** — `LibrarianStep` uses `listByCompany`, fetches memory items with `layer in (identity, domain)` filtered to the run's `proposedMemoryItemIds`, renders grouped sections + attached assets; approve unchanged. Run tests + typecheck → pass.
- [ ] **5. Live-verify the whole loop** on `journey3`: submit company + department braindumps (+ a dropped text note + a logo image). Confirm the Librarian fires per scope, proposes **identity** items (company, filed at `Company`) + **domain** items (department, filed in seeded folders), the logo is attached (not converted), and all appear grouped in LibrarianStep + approve into Memory. **Commit.**

---

## Deferred (follow-up, out of this plan)
- **Repo code-reading** for software departments — needs workspace resolve → clone/sync → CLI execution-target plumbing (direct crew runs have none). Own spec + review.
- **Text extraction for pdf/docx** — v1 reads plain-text-like files only; pdf/docx are attach-only. Add an extractor later.
- **Abandoned-upload cleanup** — v1 tolerates orphaned assets on skip/abandon (low-volume onboarding); add a sweep later.

## Self-review coverage map
| Corrected requirement | Phase |
|-----------------------|-------|
| Company (identity) + department (domain) scopes | 5a (scope) · 5c (layer) · 5e (discovery) |
| NULL-safe idempotency | 5a (partial indexes + real-PG test) |
| ≥1-source validation | 5a (validator) |
| Asset ownership + dedup + atomic linkage | 5a (service) |
| `write_memory` folder placement | 5b |
| Server reads text files → prompt; images attach-only | 5c |
| Dispatch passes scope/layer/folders/file-text | 5c |
| Layer-aware Librarian instruction | 5c |
| Company/identity discovery + grouping + approve | 5e |
