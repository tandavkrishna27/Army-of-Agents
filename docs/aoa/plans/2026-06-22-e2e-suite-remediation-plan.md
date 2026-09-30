# e2e Suite Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the `feat/v1-combined` e2e suite from 11 failing / 69 passing to fully green by fixing one test-infrastructure flaw, a set of stale tests, two genuine product bugs, and one product regression — all root-caused by a 7-agent investigation on 2026-06-22.

**Architecture:** The e2e suite was never CI-gated, so tests drifted from the evolved UI and the suite's per-spec cleanup leaks state under `workers:1`. This plan fixes the harness first (so failures stop cascading), then the stale tests, then the real product issues. Each task is independently committable. Verification is **Docker-Linux** (the only place the full e2e can boot — see "Verification environment" below); Windows runs the unit suites only.

**Tech Stack:** React + Vite + Tailwind (ui/), Express 5 + Drizzle (server/), Playwright e2e (tests/e2e/), embedded-postgres, vitest.

---

## Context: the investigation result (the "spec")

11 e2e failures, root-caused and classified (full evidence in the 2026-06-22 session). Founder product decisions are baked in below.

| # | Spec | Class | Decision |
|---|------|-------|----------|
| 4,5 | onboarding.spec.ts:48 / onboarding-thread-pipeline.spec.ts:36 | TEST-ISOLATION | Fix harness cleanup |
| 3 | mention-autocomplete.spec.ts:71 | TEST-ISOLATION | Stop re-seeding Scout |
| 1 | commander-reasoning.spec.ts:43 | STALE-TEST | Expand before asserting reasoning text |
| 7 | software-department-product.spec.ts:144 | STALE-TEST | Expect proxy preview URL |
| 8 | team-aoa-tasks-crew-board.spec.ts:19 | STALE-TEST | Fix kanban selectors |
| 9 | thread-crew-response-cycle.spec.ts:104 | STALE-TEST + new UX | Card persists, show "Scoped" state |
| 6 | software-department-product.spec.ts:53 | OVER-STRICT TEST + cosmetic CODE-BUG | Exclude truncating spans; fix `Â·` mojibake |
| 2 | marketplace-install-flow.spec.ts:240 | CODE-BUG | Default install modal to active company |
| 10,11 | visibility-and-share.spec.ts:61 / :119 | **REGRESSION** | Restore visibility + share-link on thread page |

Plus cross-cutting: dead `AOA_E2E_SKIP_LLM` flag (C1), background "Thread not found" log noise (C2), cross-platform e2e CDN stall + verify debt (C3).

Already shipped this session (do NOT redo): the Playwright-CDN→Google-storage fallback (`3e6c74c9a`) and the embedding-worker keyless-boot fix (`29dfed0e1`).

## Verification environment

The full e2e suite cannot run on Windows (embedded-postgres won't start) and the `aoa-lx` Docker container cannot boot the app (incomplete deps). **The only reliable full-suite verification is GitHub Actions CI** (now unblocked, with the CDN fallback in place). Per-task: verify the unit tests on Windows (`vitest`), and gate the *whole plan* on a final green CI e2e run (Task 14). For UI changes, also run the relevant `ui/` vitest unit tests on Windows.

## Sequencing

Phase 1 (harness) MUST land first — it removes the cross-spec leakage that masks/cascades other failures. Phases 2–4 are independent of each other. Task 14 (final CI e2e) is the gate.

---

## Phase 1 — Test infrastructure

### Task 1: Broaden onboarding `beforeEach` cleanup to stop cross-spec leakage (B1 → fixes #4, #5; stabilizes #2)

**Root cause:** specs clean their own prefix in `beforeEach` with no `afterEach`; under `workers:1` + one shared embedded-postgres, every spec leaves its companies in the DB. By the time `onboarding.spec.ts` runs (alphabetical pos ~18), the lobby is non-empty, so `LobbyEmptyState` (which holds the "Create organization" button) never renders.

**The real fix is the broadened `beforeEach` (Step 1).** A global-teardown runs *after the whole suite* and does NOTHING for the in-suite ordering bug — it's optional hygiene only (Step 2). If the teardown's request-context plumbing proves fiddly, ship Step 1 alone; it is sufficient for #4/#5.

**Files:**
- Modify: `tests/e2e/onboarding.spec.ts:43` (beforeEach filter), `tests/e2e/onboarding-thread-pipeline.spec.ts:33` (beforeEach filter)
- (Optional) Create: `tests/e2e/global-teardown.ts`; Modify: `tests/e2e/playwright.config.ts`
- Reference (do not change): `tests/e2e/helpers/seed-company.ts` (`cleanupTestCompanies` takes an `APIRequestContext`), `ui/src/pages/Lobby.tsx:56,73-77` (empty-state gate)

- [ ] **Step 1 (the fix): Broaden the two onboarding specs' `beforeEach`.** In `tests/e2e/onboarding.spec.ts:43` change the delete filter from `/^E2E-(Test|MCP)-/` to `/^E2E-/`; in `tests/e2e/onboarding-thread-pipeline.spec.ts:33` change `/^E2E-Onboard-/` to `/^E2E-/`. Both currently clean only their own prefix — that is the bug. Now they clear ALL leftover `E2E-` companies before navigating to the lobby, so the empty state renders.

- [ ] **Step 2 (optional hygiene): global teardown.** Only if you want post-run cleanup too. `cleanupTestCompanies` requires an `APIRequestContext` (a test fixture) that `globalTeardown` does NOT have — so the teardown must build its own: `const ctx = await request.newContext({ baseURL })` then call the delete loop. There is no existing globalSetup/globalTeardown in `playwright.config.ts`. Register via `globalTeardown: "./global-teardown.ts"`. SKIP this step if it's fiddly — Step 1 alone fixes the failures.

- [ ] **Step 3: Commit.**
```bash
git add tests/e2e/onboarding.spec.ts tests/e2e/onboarding-thread-pipeline.spec.ts
git commit -m "test(e2e): broaden onboarding beforeEach cleanup to all E2E- companies (stop cross-spec leakage)"
```

**Verify (CI, Task 14):** the two onboarding specs pass; no other spec regresses (serial `workers:1` means no concurrent spec depends on a company `beforeEach` would delete — each spec re-seeds its own in its own `beforeEach`).

---

## Phase 2 — Stale test fixes (no product change)

### Task 2: Stop the mention-autocomplete Scout self-seed (B2 → #3)

**Root cause:** `seedAoaAgent(request, company.id, "Scout")` re-seeds an agent named "Scout", but Scout is auto-provisioned on every company create (`server/src/services/companies.ts:175` → `ensureScout`). The duplicate-shortname guard correctly returns 409.

**Files:** Modify `tests/e2e/mention-autocomplete.spec.ts` (the `seedAoaAgent(..., "Scout")` call, ~line 76)

- [ ] **Step 1:** Read `tests/e2e/mention-autocomplete.spec.ts` lines 26–80 and confirm the composer's AoA-agent suggestion list comes from `agentsApi.listAoa` (which returns the auto-seeded Scout: `kind:"aoa"`, `status:"idle"`).
- [ ] **Step 2:** Delete the `await seedAoaAgent(request, company.id, "Scout")` call (~line 76). Scout already exists on the created company. Keep the rest of the test (it asserts `@Sc` → autocomplete → `entry-autocomplete-option-Scout` → dispatch).
- [ ] **Step 3: Commit.**
```bash
git add tests/e2e/mention-autocomplete.spec.ts
git commit -m "test(e2e): rely on auto-provisioned Scout in mention-autocomplete (was re-seeding → 409)"
```
**Verify (CI):** mention-autocomplete spec reaches the UI assertions (no 409 in setup).

### Task 3: Fix the commander-reasoning live assertion race (B3 → #1)

**Root cause:** the reasoning block collapses on settle (intentional; unit-tested in `CommanderReasoningBlock.test.tsx:51-65`). The live assertion at `commander-reasoning.spec.ts:67` calls `getByText(THINKING_TEXT)` without expanding, so the text leaves the DOM before the assertion polls. The reload branch (lines 89-93) already expands first — the live branch must do the same.

**Files:** Modify `tests/e2e/commander-reasoning.spec.ts` (~lines 62-69)

- [ ] **Step 1:** Read `tests/e2e/commander-reasoning.spec.ts:43-95`. Note the reload branch clicks the reasoning toggle (`getByTestId("commander-reasoning").getByRole("button")`) before asserting text.
- [ ] **Step 2:** In the live branch, after the block container is visible (line 63), click the expand toggle, THEN assert `getByText(THINKING_TEXT)`. Replace the bare assertion at ~67 with:
```ts
const block = page.getByTestId("commander-reasoning");
await expect(block).toBeVisible({ timeout: 10_000 });
await block.getByRole("button").first().click(); // expand (collapsed-on-settle hides the <p>)
await expect(block.getByText(THINKING_TEXT)).toBeVisible({ timeout: 10_000 });
```
- [ ] **Step 3: Commit.**
```bash
git add tests/e2e/commander-reasoning.spec.ts
git commit -m "test(e2e): expand reasoning block before asserting text (collapses on settle)"
```
**Verify (CI):** commander-reasoning passes both live + reload.

### Task 4: Update preview-URL assertion to the proxy path (B4 → #7)

**Root cause:** previews now route through an AoA-origin proxy (`server/src/services/preview-url.ts:9-11` → `/preview/services/<id>/`); the spec still expects the raw `http://127.0.0.1:<port>/`. Intended behavior is the proxy path (unit-tested in `WorkspacePreviewPanel.test.tsx:1088-1090`).

**Files:** Modify `tests/e2e/software-department-product.spec.ts` (~line 166 `previewUrl`, asserts ~574-575, and the same stale pattern ~671-672)

- [ ] **Step 1:** Read `software-department-product.spec.ts:160-175` and `:570-576` and `:665-675`. Identify how the service object is obtained (it carries `url`, `previewUrl`, `localTargetUrl`).
- [ ] **Step 2:** Change the expectation so `previewUrl` is read from the service's `previewUrl` field (the proxy path) for the URL-input + iframe `src` assertions; assert the raw loopback `service.url` only against the "Local target" hint (`preview-browser-local-target`) if the test checks it. Apply the same correction at ~671-672 (`assertWorkspaceViewers`).
- [ ] **Step 3: Commit.**
```bash
git add tests/e2e/software-department-product.spec.ts
git commit -m "test(e2e): expect proxy preview URL (/preview/services/<id>/), not raw loopback"
```
**Verify (CI):** the preview-URL assertion passes.

### Task 5: Fix kanban-board selectors (B5 → #8)

**Root cause:** `kanban-column-done` / `kanban-card-<id>` testids do not exist on `ui/src/components/KanbanBoard.tsx` (the board `CrewBoard` renders). The testids only exist on a different component (`CommanderKanbanTab.tsx`). The PATCH→done→reload flow itself works.

**Files:** Modify `ui/src/components/KanbanBoard.tsx` (add stable testids) AND/OR `tests/e2e/team-aoa-tasks-crew-board.spec.ts` (selectors). Preferred: add the testids to the board so the assertion has a stable hook.

- [ ] **Step 1:** Read `ui/src/components/KanbanBoard.tsx` — find the `KanbanColumn` render (`boardStatuses.map`, ~line 664) and the card render. Note there are currently no `kanban-column-*` / `kanban-card-*` testids.
- [ ] **Step 2:** Add `data-testid={\`kanban-column-${status}\`}` to each `KanbanColumn` root and `data-testid={\`kanban-card-${issue.id}\`}` to each card root. (This matches what the spec — and likely future specs — expect.)
- [ ] **Step 3:** Re-run the board unit test if one exists (`ui/src/__tests__/` grep `KanbanBoard`) to confirm no snapshot breaks. Run on Windows: `pnpm --filter @armyofagents/ui test run KanbanBoard`.
- [ ] **Step 4: Commit.**
```bash
git add ui/src/components/KanbanBoard.tsx
git commit -m "feat(ui): add stable kanban-column/kanban-card testids to the crew board"
```
**Verify (CI):** team-aoa-tasks-crew-board spec finds the done column + card.

### Task 6: Exclude truncating summary spans from the overflow guard (B6 → #6 test part)

**Root cause:** the spec's overflow guard (`software-department-product.spec.ts:640-653`) measures EVERY `[data-testid^="cockpit-section-"]` element and only filters `trigger`. The `cockpit-section-summary-*` spans carry `truncate` (`text-overflow:ellipsis`), so `scrollWidth > clientWidth` ALWAYS for long text — by design, not a layout break.

**Files:** Modify `tests/e2e/software-department-product.spec.ts` (~line 641 filter)

- [ ] **Step 1:** Read `software-department-product.spec.ts:640-655` (the overflow helper).
- [ ] **Step 2:** Change the element filter to skip summary spans too — e.g. from `!id.includes("trigger")` to `!id.includes("trigger") && !id.includes("summary")`, or restrict the guard to exact structural containers only (`[data-testid="cockpit-section-${id}"]`). Truncating spans must never be subject to `scrollWidth ≤ clientWidth`.
- [ ] **Step 3: Commit.**
```bash
git add tests/e2e/software-department-product.spec.ts
git commit -m "test(e2e): overflow guard must not measure truncating cockpit summary spans"
```
**Verify (CI):** cockpit-overflow assertion no longer false-positives.

---

## Phase 3 — Product fixes

### Task 7: Fix the `Â·` mojibake separator (A4 → #6 code part)

**Root cause:** `ui/src/components/workspace/WorkspaceRightPanel.tsx:281` contains bytes `C3 82 C2 B7` (renders `Â·`) instead of the intended `·` (`C2 B7`, used correctly on line 246). Cosmetic; introduced in `126b04f89`.

**Files:** Modify `ui/src/components/workspace/WorkspaceRightPanel.tsx:281`

- [ ] **Step 1:** Read `WorkspaceRightPanel.tsx:275-285`. Confirm line 281 renders the outputs summary `${plural(...)} · ${primary.title}` with a corrupted middot.
- [ ] **Step 2:** Replace the corrupted `Â·` with a correct `·` (U+00B7), matching the correct usage elsewhere in the same file (e.g. line 246).
- [ ] **Step 3:** Run the relevant UI unit test on Windows if present (grep `WorkspaceRightPanel` in `ui/src/__tests__/`): `pnpm --filter @armyofagents/ui test run WorkspaceRightPanel`.
- [ ] **Step 4: Commit.**
```bash
git add ui/src/components/workspace/WorkspaceRightPanel.tsx
git commit -m "fix(ui): correct mojibake middot in workspace outputs summary"
```

### Task 8: Default install modals to the selected/active company (A2 → #2)

**Root cause:** `PackageInstallModal.tsx:42-46` only auto-fills `companyId` when `activeCompanies.length === 1`; with 2+ companies it stays `null` → `canInstall` false (`:53`) → button disabled forever. `PluginInstallModal.tsx:43` already resolves robustly. Founder decision: default to the selected/first-active company. `SnapshotInstallModal.tsx:52-57` has the identical latent bug — fix both.

**Files:**
- Modify: `ui/src/components/marketplace/install/PackageInstallModal.tsx:42-46`
- Modify: `ui/src/components/marketplace/install/SnapshotInstallModal.tsx:52-57`
- Test: `ui/src/components/marketplace/install/__tests__/PackageInstallModal.test.tsx` (add a 2-company case)

- [ ] **Step 1: Write the failing unit test.** In `PackageInstallModal.test.tsx`, add a case: render with `CompanyContext` providing `selectedCompanyId: null` and TWO active companies; assert the "Install all" button is **enabled** (defaults to the first active company). Model existing tests in that file.
- [ ] **Step 2: Run it, expect FAIL.** `pnpm --filter @armyofagents/ui test run PackageInstallModal` → the new case fails (button stays disabled).
- [ ] **Step 3: Fix `PackageInstallModal.tsx`.** Replace the restrictive effect (lines 42-46):
```ts
useEffect(() => {
  if (!companyId) {
    const fallback = selectedCompanyId ?? activeCompanies[0]?.id ?? null;
    if (fallback) setCompanyId(fallback);
  }
}, [companyId, selectedCompanyId, activeCompanies]);
```
- [ ] **Step 4: Apply the same fix to `SnapshotInstallModal.tsx:52-57`:**
```ts
useEffect(() => {
  if (!companyId) {
    const active = companies.filter((c) => c.status !== "archived");
    const fallback = selectedCompanyId ?? active[0]?.id ?? null;
    if (fallback) setCompanyId(fallback);
  }
}, [companyId, selectedCompanyId, companies]);
```
- [ ] **Step 5: Run unit tests, expect PASS.** `pnpm --filter @armyofagents/ui test run PackageInstallModal SnapshotInstallModal`.
- [ ] **Step 6: Harden the e2e** so it never depends on company count: in `tests/e2e/marketplace-install-flow.spec.ts` (~line 240 flow), after opening the package modal, the button should now be enabled; no spec change needed beyond confirming. If desired, explicitly select a company via the `CompanyPicker` for robustness.
- [ ] **Step 7: Commit.**
```bash
git add ui/src/components/marketplace/install/PackageInstallModal.tsx ui/src/components/marketplace/install/SnapshotInstallModal.tsx ui/src/components/marketplace/install/__tests__/PackageInstallModal.test.tsx
git commit -m "fix(marketplace): default Package/Snapshot install modal to active company (not only when exactly 1)"
```
**Verify (CI):** marketplace-install-flow:240 clicks an enabled "Install all" button.

### Task 9: Scope-proposal "Scoped" done-state (A3 → #9) + test update (B7)

**Root cause + decision:** the inline `scope_proposal` card persists by design (pending approval at autonomy 1) — but should visibly reflect that it has been acted on. Founder decision: persist the card, show a "Scoped" / "Converted to draft" state (ideally linking to the Scope-tab draft). Test #9 then asserts persistence + the done marker.

**IMPORTANT data-source constraint (verified in review):** there is **no per-proposal "scoped" back-reference** in the data model. `ThreadScopeVersionSummary` (`ui/src/api/discussions.ts:159-172`) exposes only `sourceStartSeq`/`sourceEndSeq` (a seq range), not a link to the originating `scope_proposal` entry. The only available signal is **thread-level**: "a scope version draft exists for this thread" (`scopeVersions.length > 0`). This is acceptable because the e2e has exactly one proposal — but the implementation cannot distinguish *which* proposal was scoped. State this limitation in the code comment.

**The scope-version data must be prop-drilled 3 levels:** it lives in `ThreadDetail.tsx:234` (`scopeVersionsQuery`), is passed to `ScopeTab` (line 1328) but **NOT** to `ThreadTab` (line 1293), which is what renders `<EntryRow>` (`ThreadTab.tsx:500`), which renders `<ScopeProposalCard>` (`EntryRow.tsx:282`). So thread `ThreadDetail → ThreadTab → EntryRow → ScopeProposalCard`.

**Files:**
- Modify: `ui/src/components/threads/ScopeProposalCard.tsx` (add a `scoped?: boolean` prop + "Scoped" badge; hide/disable action buttons when scoped)
- Modify: `ui/src/components/threads/EntryRow.tsx:282` (accept + forward the `scoped` flag to ScopeProposalCard)
- Modify: `ui/src/components/threads/ThreadTab.tsx` (~line 500; accept `hasScopeDraft` and pass to EntryRow)
- Modify: `ui/src/pages/ThreadDetail.tsx` (~line 1293; derive `hasScopeDraft = (scopeVersions?.length ?? 0) > 0` and pass to ThreadTab)
- Test: `ui/src/components/threads/__tests__/EntryRow.test.tsx` — assert the "Scoped" badge renders when `scoped` is true
- Modify: `tests/e2e/thread-crew-response-cycle.spec.ts:104`

- [ ] **Step 1: Confirm the data source.** Read `ThreadDetail.tsx:234` (`scopeVersionsQuery`) and `:1293,1328` to confirm scope versions reach ScopeTab but not ThreadTab. The "scoped?" signal is thread-level: `(scopeVersions?.length ?? 0) > 0`. There is no per-proposal link — proceed with the thread-level proxy.
- [ ] **Step 2: Write the failing unit test.** In the ScopeProposalCard/EntryRow test, render a proposal with a new `scoped`/`resolvedState="scoped"` prop true; assert a `data-testid="scope-proposal-scoped-badge"` is visible and the approve/reject buttons are hidden or disabled.
- [ ] **Step 3: Run it, expect FAIL.**
- [ ] **Step 4: Implement.** Add an optional prop to `ScopeProposalCard` (e.g. `scoped?: boolean` or `resolvedState?: "scoped" | null`). When true: render a "Scoped ✓" badge (`data-testid="scope-proposal-scoped-badge"`) in the header (alongside/instead of the "Active Proposal" badge), and hide/disable the approve/reject/edit actions (the work is done). Keep the card + its task list visible (audit trail).
- [ ] **Step 5: Prop-drill the flag.** In `ThreadDetail.tsx` (~line 1293) derive `const hasScopeDraft = (scopeVersions?.length ?? 0) > 0;` and pass `hasScopeDraft` to `<ThreadTab>`. In `ThreadTab.tsx` accept `hasScopeDraft` and pass it to each `<EntryRow>` (~line 500). In `EntryRow.tsx` (~line 282) forward `scoped={hasScopeDraft}` to `<ScopeProposalCard>`.
- [ ] **Step 6: Run unit tests, expect PASS.**
- [ ] **Step 7: Update the e2e** `tests/e2e/thread-crew-response-cycle.spec.ts:104`: replace `await expect(page.getByTestId("scope-proposal-card")).toHaveCount(0)` with assertions that the card **persists** and shows the scoped state, e.g.:
```ts
await expect(page.getByTestId("scope-proposal-card")).toHaveCount(1);
await expect(page.getByTestId("scope-proposal-scoped-badge")).toBeVisible();
```
- [ ] **Step 8: Commit.**
```bash
git add ui/src/components/threads/ScopeProposalCard.tsx ui/src/components/threads/EntryRow.tsx ui/src/components/threads/ThreadTab.tsx ui/src/pages/ThreadDetail.tsx ui/src/components/threads/__tests__/EntryRow.test.tsx tests/e2e/thread-crew-response-cycle.spec.ts
git commit -m "feat(threads): show 'Scoped' state on inline scope-proposal card once a scope draft exists"
```
**Verify (CI):** thread-crew-response-cycle passes asserting persistence + scoped badge.

### Task 10: Restore thread visibility + share-link on the thread page (A1 → #10, #11) — REGRESSION

**Root cause + decision:** the thread group-chat redesign (`39556013b`) dropped `OriginCard` from the render tree; `ThreadDetail` has no visibility selector or share-link. Founder decision: **regression — restore it.** The `OriginCard` component still exists and is fully functional (visibility dropdown + share-link block with all testids + mutations). The fix is to re-home the visibility + share-link UI into the redesigned `ThreadDetail` header.

**Files:**
- Reference (working, has the UI): `ui/src/components/threads/OriginCard.tsx:457-560` (visibility dropdown + share-link block + their handlers/mutations)
- Modify: `ui/src/pages/ThreadDetail.tsx` (the `thread-center-header`, ~lines 933-1132) to mount the visibility selector + share-link
- Extract the visibility + share sub-UI from OriginCard into a small reusable `ThreadVisibilityControls` and mount it in `ThreadDetail` (clean boundary).
- Test: migrate the relevant assertions from `ui/src/components/threads/__tests__/OriginCard.test.tsx` (36 tests, currently the ONLY thing that renders OriginCard) into a new `ThreadVisibilityControls.test.tsx`. The e2e `visibility-and-share.spec.ts` verifies end-to-end.

**Verified context (review):** OriginCard is rendered NOWHERE in the app — only in its own 36-test file. Its visibility/share handlers call `threadsApi.setVisibility(companyId, …)` / share mutations (`OriginCard.tsx:220,308,326`), so the extracted component needs **`companyId`** as well as `thread`. In `ThreadDetail`, `companyId` is `selectedCompanyId!` (`ThreadDetail.tsx:915,1295`). ThreadDetail currently has NO visibility/share testids, so no collision.

- [ ] **Step 1: Read `ThreadDetail.tsx:933-1132`** (redesigned header) to choose placement, and read `OriginCard.tsx:1-120,200-330,455-560` to extract the visibility/share handlers (`handleVisibilityChange`, `handleGenerateShareToken`, `handleCopyShareUrl`, the `threadsApi.setVisibility`/share mutations, `VISIBILITY_META`).
- [ ] **Step 2: Create `ui/src/components/threads/ThreadVisibilityControls.tsx`** with props `{ thread, companyId }` containing the visibility dropdown (`data-testid="visibility-selector"`, options `visibility-option-*`, menu `visibility-menu`) and the share-link block (`data-testid="share-link-block"`, `generate-share-token`, `share-link-url`, `copy-share-token`, `copy-share-token`) — lifted verbatim from OriginCard so the existing testids + behavior are preserved.
- [ ] **Step 3: Write `ThreadVisibilityControls.test.tsx`** by migrating the visibility/share assertions from `OriginCard.test.tsx`: render with a `company`-visibility thread + a companyId, assert `visibility-selector` visible + changing to Private fires `setVisibility`; assert `share-link-block` + `generate-share-token` visible (founder). Run: `pnpm --filter @armyofagents/ui test run ThreadVisibilityControls`.
- [ ] **Step 4: Mount `<ThreadVisibilityControls thread={thread} companyId={selectedCompanyId!} />`** in `ThreadDetail.tsx`'s header at the chosen spot.
- [ ] **Step 5: Delete the now-dead OriginCard + its test.** Since OriginCard renders nowhere else, delete `ui/src/components/threads/OriginCard.tsx` AND `ui/src/components/threads/__tests__/OriginCard.test.tsx` (its 36 tests are migrated in Step 3). Grep `OriginCard` first to confirm zero remaining importers, then remove. (If you prefer to keep OriginCard, instead make it render `<ThreadVisibilityControls>` so its tests still pass — but deletion is cleaner.)
- [ ] **Step 6: Run UI unit tests** for ThreadDetail + the new component; confirm no dangling import of the deleted OriginCard. Expect PASS.
- [ ] **Step 7: Confirm e2e selectors match.** `tests/e2e/visibility-and-share.spec.ts` uses `visibility-selector`, `visibility-option-private`, `share-link-block`, `generate-share-token` — all preserved by Step 2, so no spec change should be needed. Adjust only if placement changes a `.first()` assumption.
- [ ] **Step 8: Commit.**
```bash
git add ui/src/components/threads/ThreadVisibilityControls.tsx ui/src/components/threads/__tests__/ThreadVisibilityControls.test.tsx ui/src/pages/ThreadDetail.tsx
git rm ui/src/components/threads/OriginCard.tsx ui/src/components/threads/__tests__/OriginCard.test.tsx
git commit -m "fix(threads): restore per-thread visibility selector + share-link (lost in group-chat redesign)"
```
**Verify (CI):** both visibility-and-share specs pass.

---

## Phase 4 — Hygiene

### Task 11: Clarify `AOA_E2E_SKIP_LLM` (C1) — documentation only

**Corrected understanding (review):** the flag is NOT dead. `server/src` never reads it, but **4 spec files do** — `onboarding.spec.ts:27`, `onboarding-thread-pipeline.spec.ts:29`, `mention-autocomplete.spec.ts:24`, and `planning-mode.spec.ts:21` (which `test.skip(SKIP_LLM, …)` at :75). It correctly gates LLM-dependent e2e behavior. It is set only in `.github/workflows/pr.yml` (the `Run e2e tests` step env, ~`:445` and `:527`), NOT in `playwright.config.ts`. The only real issue was a *misconception* that it made the server keyless-safe — it never did; the embedding-worker fix (`29dfed0e1`) does that.

**Action:** do NOT remove the spec-side guards. The flag works. The only change is a clarifying comment so the next person doesn't conflate it with server boot safety.

- [ ] **Step 1:** Grep `AOA_E2E_SKIP_LLM` to confirm the 4 spec readers + the 2 pr.yml env entries; verify removing the workflow env would default `SKIP_LLM` to skip (do NOT change it if removal would un-skip real-provider tests).
- [ ] **Step 2:** Add a one-line comment at the pr.yml `Run e2e tests` env (and/or near the spec readers) noting: `AOA_E2E_SKIP_LLM` gates LLM-dependent e2e specs; server keyless-boot safety is handled separately by the embedding-worker fix. No behavior change.
- [ ] **Step 3: Commit.**
```bash
git add .github/workflows/pr.yml
git commit -m "docs(e2e): clarify AOA_E2E_SKIP_LLM gates LLM specs (server keyless-boot is separate)"
```

### Task 12: Silence background "Thread not found" log noise (C2)

**Root cause:** background sweeps (proactive / freshness / chronicler) throw a plain `throw new Error("Thread not found: …")` (NOT `notFound(…)`) when a thread's company was torn down by test cleanup — `thread-agent-action-freshness.ts:66` (`captureFreshnessSnapshot`) and `thread-agent-actions.ts:317`. Harmless but noisy.

**Files:** Modify `server/src/services/thread-agent-action-freshness.ts:66` and `server/src/services/thread-agent-actions.ts:317` (the background callers).

- [ ] **Step 1:** Read `thread-agent-action-freshness.ts:55-75` and `thread-agent-actions.ts:305-325`. Identify which calls are BACKGROUND (sweep/tick) vs request-path. Both throw a generic `Error`, not an HttpError.
- [ ] **Step 2:** For background callers only, treat a missing thread as a silent no-op (return/skip) rather than throwing — guard with a "thread still exists" check, or catch and `log.debug` instead of letting the generic `Error` surface. Do NOT change request-path 404 behavior.
- [ ] **Step 3:** Add/extend a unit test for the freshness sweep asserting a deleted thread is skipped without throwing.
- [ ] **Step 4: Commit.**
```bash
git add server/src/services/thread-agent-action-freshness.ts server/src/services/thread-agent-actions.ts server/src/__tests__/
git commit -m "fix(threads): background sweeps no-op on a missing thread instead of throwing"
```

### Task 13: Extend the CDN fallback to cross-platform e2e + document verify debt (C3)

**Root cause:** only the required Linux `e2e` job got the Google-storage fallback; the advisory macOS/Windows `e2e-cross-platform` lanes still stall on `cdn.playwright.dev` (~35 min each). Separately, the macOS/Windows `verify` lanes carry pre-existing platform test debt (7 + 3 files) — a parallel backlog.

**Files:** Modify `.github/workflows/pr.yml` (the cross-platform e2e "Install Playwright" steps, ~line 486). The existing `tests/e2e/scripts/install-chromium-from-google.sh` is Linux-only; cross-platform needs mac/win URLs (`.../<ver>/mac-x64/chrome-mac-x64.zip`, `.../win64/chrome-win64.zip`).

- [ ] **Step 1:** Decide scope: either (a) generalize `install-chromium-from-google.sh` to detect platform and use the right Google CfT path, applied to the cross-platform install steps; or (b) accept that advisory lanes may stall and add `timeout-minutes` reduction so they fail fast instead of burning 35 min. Recommended: (b) short-term (lower the cross-platform e2e timeout to ~10 min so a CDN stall fails fast), file a 1.1 issue for (a).
- [ ] **Step 2:** Implement the chosen change in `.github/workflows/pr.yml`.
- [ ] **Step 3:** Add a short note to `docs/architecture/` or `CLAUDE.md` CI Platform Status documenting: required Linux e2e uses the Google-storage fallback; cross-platform e2e + verify remain advisory with known platform debt (track as 1.1).
- [ ] **Step 4: Commit.**
```bash
git add .github/workflows/pr.yml docs/
git commit -m "ci(e2e): bound advisory cross-platform e2e timeout + document platform CI debt"
```

---

## Phase 5 — Gate

### Task 14: Full green CI e2e run (the gate)

- [ ] **Step 1:** Push the accumulated commits to `origin/feat/v1-combined`.
- [ ] **Step 2:** Watch the `e2e` (required Linux) job: `gh run watch <id>`.
- [ ] **Step 3:** Confirm **0 e2e failures** (69 + the 11 now-fixed = full pass, minus the deliberately-skipped `full-discussion-to-workspace-cycle.real-provider.spec.ts` + the `SKIP_LLM`-gated test in `planning-mode.spec.ts`). If any spec still fails, return to systematic-debugging Phase 1 for THAT spec — do not bulk-patch.
- [ ] **Step 4:** Confirm the required gate set is fully green: `verify`, `migrations`, `policy`, `brand-check`, `e2e`.

---

## Self-Review (completed)

**Spec coverage** — every investigation finding maps to a task:
- #4,#5 → Task 1 · #3 → Task 2 · #1 → Task 3 · #7 → Task 4 · #8 → Task 5 · #6(test) → Task 6 · #6(code) → Task 7 · #2 → Task 8 · #9 → Task 9 · #10,#11 → Task 10. Cross-cutting C1 → Task 11 · C2 → Task 12 · C3 → Task 13. Gate → Task 14. No finding is unassigned.

**Sequencing:** Task 1 first (removes leakage that cascades). Task 9 depends on its own UI change before the e2e update (same task). Task 10 restores the feature the #10/#11 specs need. Tasks are otherwise independent.

**Type/name consistency:** new testids (`scope-proposal-scoped-badge`, `kanban-column-${status}`, `kanban-card-${id}`) are defined where introduced and referenced consistently in their e2e updates. The reused visibility/share testids (`visibility-selector`, `visibility-option-*`, `share-link-block`, `generate-share-token`) are preserved verbatim from OriginCard in Task 10.

**Open design points flagged for the implementer (not placeholders — decisions deferred to read-current-code):** Task 1 (afterEach vs globalTeardown — pick based on `seed-company.ts` helper shape), Task 5 (add testids vs change selectors — plan picks add-testids), Task 10 (placement in `ThreadDetail` header + extract-vs-mount — plan picks extract), Task 13 (generalize script vs bound timeout — plan picks bound timeout short-term). Each names the exact file to read to finalize.

**Risk note:** Task 10 (regression restore) is the largest and touches the redesigned `ThreadDetail`; it warrants the closest review. Tasks 1–7 are low-risk and shrink the failure set fastest.
