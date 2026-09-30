# Unified Composer — Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. Steps use `- [ ]` checkboxes.

**Goal:** Take the unified-composer branch from "core built + idempotency + runtime text delivery done" to "meets every §6 acceptance gate of the implementation plan," including the full cross-surface E2E matrix.

**Architecture:** The composer UI, contracts, session isolation, posting authz, server idempotency (3 endpoints, migrations 0171-0173), and runtime text delivery (Commander) are already landed and committed (`d41693a70`). This plan closes the remaining review backlog (§9 P1/P2), extends runtime delivery to task/discussion agents, and adds the verification breadth (E2E, accessibility, responsive, observability) required to call the plan complete.

**Tech Stack:** React + Vite + Tailwind v4 (ui), Express 5 + Drizzle (server), Vitest (unit/contract/integration), Playwright (e2e, Linux-gated). Isolated QA instance: `AOA_CONFIG=C:\Users\TK\.aoa\iso-composer\config.json AOA_DEV_LOCAL_IDENTITY=1 AOA_MIGRATION_AUTO_APPLY=true AOA_UI_DEV_MIDDLEWARE=true pnpm exec tsx src/index.ts` (server :3399, PG :54399, company prefix `COM`).

**Prerequisite maps to the plan's §6 acceptance gates.** Each phase closes specific gates; Phase 9 re-runs all 11.

---

## Scope decisions (confirm before execution)

1. **Feature flags = capability gates, not old-path rollback.** The codex pass replaced the old composers *in place*; there is no dormant old path to toggle. Re-introducing old composer code purely for rollback is high-cost and low-value on a pre-release branch. Phase 5 therefore adds per-surface **capability gates** (instance-config booleans, default ON) that disable the *new attachment + runtime-delivery* behavior if a surface misbehaves — additive and cheap. If you want true old-path rollback instead, that is a separate, larger effort — flag it now.
2. **Vision delivery (images) stays Phase 2** (deferred; §23) — included here only as an optional final phase (Phase 10).
3. **Windows e2e self-skips** (embedded-postgres on the CI runner); Linux CI is the authoritative gate. Locally we run the matrix against the isolated :3399 instance via the escape-hatch (`AOA_E2E_FORCE_WINDOWS=1` or an external `DATABASE_URL`).

---

## Phase 0 — Green baseline + the 50 MB copy fix

**Files:**
- Modify: the approved mock reference copy + any UI string reading "50 MB" for composer attachments
- Verify only: `packages/shared`, `server`, `ui`

- [ ] **Step 1: Establish the current baseline.** Run and record:
  - `pnpm -r typecheck`
  - `npx vitest run` (whole monorepo) — expect green except the known flake `discussions-routes-contract.test.ts:47` (`performance.now() < 3000`).
  - `pnpm build`
  Expected: all green apart from the one documented wall-clock flake.

- [ ] **Step 2: Find the "50 MB" contract mismatch (P0#1).** Run:
  `git grep -n "50 MB\|50MB\|52428800\|50 \* 1024 \* 1024" ui server packages docs`
  The composer contract is **10 MB** (`COMPOSER_MAX_ATTACHMENT_BYTES`). The general-asset route legitimately allows 50 MB — do NOT change that. Only fix composer-facing copy/mocks that imply a 50 MB *composer attachment* limit.

- [ ] **Step 3: Fix composer-facing copy to 10 MB.** Edit the offending strings; if the approved mock PNG carries "Any file type up to 50 MB", note it in the plan doc as a design-asset correction (cannot edit a PNG in code — record the discrepancy and the intended copy).

- [ ] **Step 4: Add/adjust a contract test asserting the composer limit is 10 MB** in `packages/shared/src/__tests__/composer-contracts.test.ts` (assert `COMPOSER_MAX_ATTACHMENT_BYTES === 10 * 1024 * 1024`).

- [ ] **Step 5: Commit** — `test(composer): lock 10MB attachment contract; fix stray 50MB copy`.

---

## Phase 1 — Attachment security lifecycle (§9 P1#7)

**Goal:** Never trust the client's declared content type; normalize filenames; enforce limits server-side; authorize every read; reclaim abandoned uploads.

**Files:**
- Modify: `server/src/routes/assets.ts` (files upload handler ~154), the composer attachment validators
- Create: `server/src/services/asset-content-guard.ts` (MIME sniff + filename normalize) + test
- Modify: a sweeper (reuse the workspace TTL sweeper pattern) for abandoned composer uploads
- Test: `server/src/__tests__/asset-content-guard.test.ts`, route tests

- [ ] **Step 1: Write failing test — MIME sniffing rejects a spoofed type.** A `.png`-named file whose bytes are a shell script (`#!/bin/sh`) with `contentType: image/png` must be rejected (the server sniffs magic bytes, doesn't trust the header). Test the pure `sniffAndVerifyContentType(buffer, declaredType)` guard.

- [ ] **Step 2: Run it — FAIL** (guard not implemented). `npx vitest run server/src/__tests__/asset-content-guard.test.ts`

- [ ] **Step 3: Implement `asset-content-guard.ts`:** a `sniffAndVerifyContentType(buffer, declared)` using magic-byte checks for the allowlist (PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `47 49 46`, WebP `RIFF....WEBP`, PDF `25 50 44 46`; text/* and json validated as decodable UTF-8 without NUL bytes). Return the verified type or throw. Plus `normalizeFilename(name)` — strip path separators, control chars, leading dots; cap length; collapse to a safe basename.

- [ ] **Step 4: Run — PASS.**

- [ ] **Step 5: Wire the guard into both composer upload paths** (`/assets/files`, `/assets/images`, and the task `comments-with-attachments`). Add a route test: spoofed type → 422; oversize → 422; over-count → 422 (server-side, not just client).

- [ ] **Step 6: Authorization audit test.** Assert `/assets/:assetId/content` returns 404 (non-disclosing) for a cross-company asset, and that the runtime resolver (Phase 2) never reads a cross-company asset (already covered in `runtime-attachments.test.ts` — cross-reference it).

- [ ] **Step 7: Abandoned-upload reclaim.** Composer uploads that are never attached to a message/entry/comment (no `issue_attachments` / `discussion_entry_attachments` / commander asset-ref link within TTL, default 24h) are swept. Write a failing test for `reclaimAbandonedComposerAssets(db, storage, now)` (selects unlinked assets older than TTL created via composer upload, deletes object + row), implement, pass. Register it on the existing sweeper interval.

- [ ] **Step 8: Commit** — `feat(assets): MIME-sniff + normalize + reclaim abandoned composer uploads`.

---

## Phase 2 — Runtime text delivery parity for task/discussion agents

**Goal:** The resolver built for Commander (`runtime-attachments.ts`) also feeds text-readable attachment content to agents executing a **task** (heartbeat/crew) or summoned into a **discussion**, so an agent doing real work can read attached `.txt/.md/.json`.

**Files:**
- Modify: the heartbeat/crew context assembly that builds an agent run's prompt (`server/src/services/heartbeat.ts` wakeup context, and the crew runner `runAoaAgent`)
- Reuse: `server/src/services/internal-agent/runtime-attachments.ts`
- Test: integration tests in `server/src/__tests__/`

- [ ] **Step 1: Locate the attachment IDs already in wakeup context.** The task-comment wakeup already carries `attachments` metadata (see `enqueueIssueCommentWakeups` / `issues-comments-attachments.test.ts`). Confirm the asset IDs are available where the agent prompt is assembled.

- [ ] **Step 2: Write failing test** — when a task comment carries a text-readable attachment, the agent run's assembled context contains the file's decoded text (company-scoped), and a cross-company asset id is dropped.

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Implement** — in the run-context assembly, call `resolveRuntimeAttachments` + `formatRuntimeAttachmentBlock` with the run's `companyId` and the comment's asset IDs; append the block to the agent's task context. Best-effort (never fail the run).

- [ ] **Step 5: Run — PASS.** Add the discussion-summon parity path (agent summoned into a thread whose entry has attachments).

- [ ] **Step 6: Commit** — `feat(runtime): deliver text attachments to task/discussion agents`.

---

## Phase 3 — Mention delivery semantics (§9 P1#9)

**Goal:** Define and enforce that a mention's side effect (Discussion notify, agent summon, task wake) fires **at-most-once per (entity, mention, submission)**, so a retry or double-render can't double-notify/double-wake.

**Files:**
- Modify: the mention side-effect enqueue paths (`processMentions` in threads, `enqueueIssueCommentWakeups`)
- Reuse: the idempotency key already on the entry/comment (`clientSubmissionId`) + existing wakeup dedup (`agent_wakeup_requests`)
- Test: `server/src/__tests__/mention-debounce-dedup.test.ts` (extend)

- [ ] **Step 1: Audit current guarantees.** Document per path whether notify/summon/wake is deduped today (wakeups have `agent_wakeup_requests` dedup; discussion notifications may not). Record the matrix.

- [ ] **Step 2: Write failing test** — posting the same entry/comment twice (same `clientSubmissionId`, i.e. an idempotent replay) fires each mention's notify/summon/wake **once**, not twice. (Builds on Phases already done: the replay short-circuit should already prevent the second post's side effects — this test *proves* it end-to-end for mentions specifically.)

- [ ] **Step 3: Run — FAIL or PASS.** If it passes (replay short-circuit already covers it), convert to a regression guard and document the guarantee. If it fails (a mention path bypasses the replay gate), fix by routing that path through the same submission-scoped dedup.

- [ ] **Step 4: Add a receipt/observability line** — each mention side effect logs `{entity, mentionId, submissionId, outcome}` so duplicates are detectable (feeds Phase 6).

- [ ] **Step 5: Commit** — `fix(mentions): at-most-once notify/summon/wake per submission`.

---

## Phase 4 — Draft pending-upload rehydration (§9 P1#10)

**Goal:** `sessionStorage` drafts hold **upload references (asset IDs), never bytes**. On reload, ready uploads rehydrate from their asset IDs; missing/expired ones show a clear "this attachment is no longer available" state instead of a broken reference.

**Files:**
- Modify: the shared draft serialization (`ui/src/lib/composerDraft.ts`) + the attachment hook
- Test: `ui/src/lib/__tests__/composerDraft.test.ts`, a component test

- [ ] **Step 1: Write failing test** — a serialized draft stores only `{assetId, filename, contentType, byteSize, capability}` for ready uploads (no base64/bytes), and deserialization of a draft whose asset no longer exists yields an attachment in a `missing` state (not a crash, not a silent drop).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** — on rehydrate, HEAD/GET `/assets/:id/content` (or a lightweight `/assets/:id` metadata check) per ready ref; 404 → mark `missing`; ok → mark `ready`. Pending (still-uploading) refs from a prior session are dropped (their upload is gone). Add a byte-free assertion (already partially covered by `composerDraft.test.ts` "byte-free serialization").

- [ ] **Step 4: Run — PASS.** Component test: reloading with a missing upload shows the disclosure + lets the user remove it and still send.

- [ ] **Step 5: Commit** — `feat(composer): rehydrate/expire pending draft uploads on reload`.

---

## Phase 5 — Per-surface capability gates (§9 P1#12, right-sized)

**Goal:** Instance-config booleans that can disable the new attachment + runtime-delivery behavior per surface (Commander / Discussion / Task), default ON. Cheap kill-switch; not old-path rollback.

**Files:**
- Modify: instance config schema/service (follow `executionWorkspacePolicy`/instance-settings pattern)
- Modify: the three surface profiles to read the gate (hide attach control + skip runtime delivery when off)
- Test: contract + a UI test that the attach control is hidden when the gate is off

- [ ] **Step 1: Write failing contract test** — with `composerAttachments.commander = false`, the Commander profile reports `capabilities.files === false` and the server chat route ignores `attachmentAssetIds`.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** the gate resolution (instance config → profile capability + server-side guard). Default all three ON.

- [ ] **Step 4: Run — PASS.** UI test: gate off → no paperclip; gate on → paperclip present.

- [ ] **Step 5: Commit** — `feat(composer): per-surface capability gates (default on)`.

---

## Phase 6 — Observability (§9 P2#14)

**Goal:** Emit structured signals for the failure modes the reliability promise depends on.

**Files:**
- Modify: upload handlers, submission paths, idempotency replay points, runtime resolver, mention side effects

- [ ] **Step 1:** Add structured log/metric emit at each point (no test-first needed for pure logging, but assert presence in one route test):
  - upload failure by reason (`unsupported_type|oversize|over_count|sniff_mismatch|storage_error`)
  - send failure by surface + action
  - duplicate-submit suppressed (idempotency replay hit) by surface
  - runtime-attachment capability outcome (`text_delivered|stored_only_disclosed|dropped_cross_company`)
  - wake/summon/notify failure
  - draft recovery / missing-upload events
- [ ] **Step 2:** One route test asserting a duplicate-submit replay emits the `duplicate_suppressed` signal.
- [ ] **Step 3: Commit** — `feat(observability): composer reliability signals`.

---

## Phase 7 — E2E matrix (§6 gate #4) — the core verification

**Goal:** Prove every composer function works on every surface, in a real browser, at desktop + mobile widths, with API + UI assertions and screenshot artifacts. This is what makes "every chat box works" a fact, not a claim.

**Harness (do once):**
**Files:**
- Create: `tests/e2e/helpers/composer.ts` — shared helpers (`openCommander(page)`, `openThread(page, id)`, `openTaskSlideOver(page, id)`, `openTaskComments(page, id)`, `openWorkspace(page, id)`; `attachFile(page, path)`; `expectAttachmentInFrame(page)`; `sendWithEnter(page)`).
- Create: `tests/e2e/fixtures/` — `sample.txt`, `sample.png`, `sample.pdf`, `oversize.bin` (>10 MB).
- Reuse: `tests/e2e/helpers/seed-company.ts` (`seedCompany`), `playwright.config.ts`.

- [ ] **Step 1: Write the harness helpers** (exact selectors discovered from the running app; each composer shares the `ComposerFrame` root — add stable `data-testid="composer-frame"`, `data-testid="composer-attach"`, `data-testid="composer-editor"`, `data-testid="composer-send"` to the shared components if missing, so the matrix targets one contract).

- [ ] **Step 2: Add the test IDs to the shared composer components** (`ComposerFrame`, attach control, editor, send/stop). Unit-test unaffected; this is additive markup.

**The matrix.** For **each surface** S ∈ {Commander, Discussion-full, Discussion-embedded, Workspace, Task-slide-over, Task-comments} write specs for the applicable **flows** F (skip N/A cells, but `log()` the skip):

- [ ] **F1 — Type + Enter sends; draft clears only after acceptance.** Assert one durable record via API (comment/entry/message count +1) and the editor clears.
- [ ] **F2 — Shift+Enter inserts newline, does not send.** Assert no API write; editor contains `\n`.
- [ ] **F3 — Cmd/Ctrl+Enter also sends** (alias). One durable record.
- [ ] **F4 — Choose a mention** (`@agent`/`@human` per surface): correct identity token; routing side effect fires exactly once (assert via API/notification); menu is keyboard-navigable.
- [ ] **F5 — Slash:** Commander shows the skill registry and inserts an atomic token; Discussion/Task treat `/` as literal text (no dormant menu).
- [ ] **F6 — Pick a file:** card appears **inside** the frame (assert the card element is a descendant of `composer-frame`); shows filename + size + status.
- [ ] **F7 — Paste an image:** thumbnail + upload status inside the frame.
- [ ] **F8 — Drag/drop:** drop zone inside the frame; page does not navigate; card appears.
- [ ] **F9 — Upload failure + retry:** force a 500 on upload (route intercept), assert the card shows failed + Retry; retry succeeds; draft/other files retained.
- [ ] **F10 — Attachment-only send:** send with a file and empty text; assert the durable record persists with the accessible fallback label ("Attached N files"), not fake prose.
- [ ] **F11 — Send failure + retry:** force the create endpoint to 500; assert inline error with Retry/Edit/Discard; the snapshot (text+tokens+files) is preserved; newer text typed during the in-flight request survives.
- [ ] **F12 — Offline/reconnect:** toggle `context.setOffline(true)`; assert "Offline — draft saved"; already-uploaded files stay attached; reconnect restores send.
- [ ] **F13 — Streaming/Stop (Commander) / active-run Interrupt (Task):** assert Stop halts streaming; on Task, a normal send is a non-interrupting comment and Interrupt is a separate, governed action.
- [ ] **F14 — Idempotent retry (reliability):** fire the same send twice (double-click / rapid Enter) → exactly one durable record (ties the Phase-done server idempotency to the UI).
- [ ] **F15 — Host transition:** open the same entity in full + embedded/slide-over host; assert the draft (text+files) persists across the transition.
- [ ] **F16 — Narrow/mobile (375px) + tablet:** set viewport; assert Send/Stop reachable, attachment cards wrap **inside** the frame, no horizontal composer scroll, footer respects safe area.

Each spec: seed via `seedCompany`, drive the flow, assert **both** an API fact and a UI fact, and capture a screenshot artifact on the key state. Group specs per surface file: `tests/e2e/composer-commander.spec.ts`, `composer-discussion.spec.ts`, `composer-workspace.spec.ts`, `composer-task-comments.spec.ts`, `composer-embedded.spec.ts`.

- [ ] **Step 3 (per surface): write specs, run against :3399, iterate to green**, then commit per surface file (`test(e2e): composer matrix — <surface>`).

- [ ] **Step 4: Record the coverage table** (surface × flow, PASS/SKIP with reason) in the plan doc. No silent gaps — every SKIP is justified (e.g., "Discussion has no streaming Stop → F13 N/A").

---

## Phase 8 — Accessibility + responsive (§6 gate #9)

**Files:**
- Add: `@axe-core/playwright` checks into each surface spec; a dedicated `composer-a11y.spec.ts`

- [ ] **Step 1:** Automated axe scan on each composer host + state (empty, with-tokens, with-attachments, error, streaming) — zero serious/critical violations.
- [ ] **Step 2:** Keyboard-only completion of one full flow per surface (Tab order, listbox active-descendant on menus, keyboard token removal, Escape closes menu before pane).
- [ ] **Step 3:** Screen-reader name assertions for attach status, errors, send/stop (accessible names present).
- [ ] **Step 4:** Contrast (light/dark/high-contrast) + reduced-motion (upload shimmer/streaming pulse disabled) checks.
- [ ] **Step 5:** Screenshot baselines at comfortable / compact / tablet / 375px.
- [ ] **Step 6: Commit** — `test(e2e): composer accessibility + responsive`.

---

## Phase 9 — Performance (§9 P2#13) + final gate verification

**Files:** `tests/e2e/composer-perf.spec.ts` (or a benchmark harness)

- [ ] **Step 1:** Measure upload latency for a 10 MB file; streaming responsiveness while an attachment is present; composer rerender count on keystroke (React profiler assertion or a render-count guard). Record baselines; flag regressions, don't hard-fail on absolute numbers.
- [ ] **Step 2: Run the full §6 gate suite** and record each:
  1. `pnpm -r typecheck` ✅
  2. `npx vitest run` (whole repo) — green apart from documented flake ✅
  3. `pnpm build` ✅
  4. Every E2E matrix row has a test or documented skip (Phase 7 table) ✅
  5. 3 adapters pass idempotency + authz ✅ (done)
  6. Commander A/B/A isolation ✅ (done)
  7. Attachment states across full/embedded/slide-over/mobile ✅ (Phase 7)
  8. No silent loss on failure ✅ (Phase 7 F9/F11/F12)
  9. A11y + responsive ✅ (Phase 8)
  10. Activity-log/wakeup/summon/stop/attachment-access audit ✅ (Phases 3/6/7)
  11. Mockups + plan updated ✅
- [ ] **Step 3:** Update `docs/aoa/plans/2026-07-15-unified-composer-implementation-plan.md` §10 with the final gate status; update `docs/architecture/` as needed.
- [ ] **Step 4: Commit** — `docs(composer): mark acceptance gates met`.

---

## Phase 10 (optional, deferred) — Vision delivery (Option 2)

Only if you choose to pull vision forward. Deliver images to vision-capable adapters: server resolves image assets → writes to a per-run temp file the adapter can read (claude image input) or bridges via a governed read tool; non-vision adapters keep the stored-only disclosure. Requires per-adapter handling and its own test + live pass. Left as a separate phase so the branch can ship without it.

---

## Self-review notes

- **Spec coverage:** Every open §6 gate and §9 P1/P2 item maps to a phase (P0#1→P0, P1#7→P1, parity→P2, P1#9→P3, P1#10→P4, P1#12→P5, P2#14→P6, gate#4→P7, gate#9→P8, P2#13→P9, vision→P10). Already-done items (idempotency, runtime text, session isolation, authz) are referenced, not repeated.
- **Ordering rationale:** hardening + parity (P1-P4) before flags (P5) before verification (P7-P9), so E2E exercises the final behavior. Observability (P6) lands before E2E so failure signals exist during the matrix.
- **Risk:** Phase 7 is the largest; the shared `data-testid` contract (Step 2) is the leverage that keeps the matrix DRY across six surfaces.
