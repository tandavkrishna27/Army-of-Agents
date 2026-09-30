# Inbox Hub Final Cutover And Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy flat Inbox route with the new Inbox/Approvals Hub and prove the full founder operator flow before starting W2/W3/W4/W5.

**Architecture:** Keep the W1a/W1b/W1c/W1d hub stack as the canonical attention surface. The final cutover is a route, navigation, badge, parity, and acceptance pass: `/inbox` should land on the hub, old `/inbox/new` and `/inbox/all` should deep-link into equivalent hub states, Approvals remains a canonical deep-link surface, and the legacy `Inbox.tsx` surface becomes removable only after tests prove no W1 source category is lost.

**Tech Stack:** React/Vite/TanStack Query UI, Express hub/sidebar badge routes, shared hub contracts, Vitest unit/component tests, Playwright e2e acceptance tests, existing W1a-W1d hub services.

---

## Scope

### In

- Make `/inbox` the user-facing Inbox Hub entry.
- Preserve old `/inbox/new` and `/inbox/all` links through redirects or hub query state.
- Remove the "Hub preview" sidebar item and make "Inbox" point to the hub.
- Keep `/approvals/pending`, `/approvals/all`, and `/approvals/:approvalId` as canonical approval pages.
- Verify every legacy Inbox category has a hub lane, source emitter, or explicit deferral.
- Align sidebar badge behavior with hub counts for the active W1 phase.
- Add final acceptance e2e coverage for desktop and mobile.
- Record final test evidence and remaining explicit deferrals in the roadmap.

### Out

- W2 notification registry/realtime/toast bridge/preferences.
- W3 Autopilot policy or auto-actions.
- W4 Steward curation agent.
- W5 runtime decision adapter bridges.
- Mail/email lane implementation.
- Full route/reassign/escalate/delegation automation beyond existing W1c affordances.

## Current State

- PR #242 W6 is merged.
- PR #243 W1a is merged.
- PR #244 is merged into `main` and includes W1b/W1c/W1d code paths.
- Current working branch is `feat/inbox-hub-integration`, based on the merged `main`.
- `ui/src/App.tsx` still routes `/inbox` -> `/inbox/new` -> legacy `Inbox`.
- `ui/src/components/Sidebar.tsx` still shows both `Inbox` and `Hub preview`.
- `tests/e2e/` contains W1b/W1c/W1d specs but not the final operator acceptance spec.

## Product Decisions

1. **The route name remains Inbox.** The sidebar label stays "Inbox"; the implementation behind it becomes the hub. "Hub preview" disappears.

2. **Old links do not break.** `/inbox/new` maps to the active/open Waiting on you hub view. `/inbox/all` maps to a route-backed all/history mode that survives reload; if implementation chooses a nearest-lane fallback, the exact route target and gap must be documented in the parity matrix. Compatibility redirects from `/inbox-hub/*` must preserve the company prefix and `location.search`.

3. **Approvals remains canonical.** The hub can view and act on approvals, but `/approvals/*` stays available for full details, comments, and external deep links.

4. **No new attention store.** Sidebar badges and any header peek must read hub counts or the existing W1 compatibility path. The cutover must not add another per-source aggregator.

5. **Legacy Inbox is removed only after parity tests.** Delete or unroute `Inbox.tsx` only when tests prove the W1 categories are covered and stale shortcuts/storage helpers are addressed. If removal causes excessive churn, keep the file unreferenced for one PR and schedule deletion as cleanup.

6. **User-facing name is Inbox.** The internal implementation may remain `InboxHub`, but sidebar label, breadcrumb, main page heading, and mobile lane drawer copy should present the surface as "Inbox" unless a specific control needs the word "Hub" for clarity.

## Legacy Inbox Parity Matrix

| Legacy Inbox Category | Hub Outcome | Required Test |
|---|---|---|
| Discussion items pending review | Waiting on you | Seed discussion-pending hub item, assert lane row and viewer/full link. |
| Thread notifications | Notifications or Waiting on you by semantic type | Seed each supported thread semantic type, assert registry lane mapping. |
| Approvals needing action | Waiting on you | Seed approval request, open in hub viewer, open canonical approval page. |
| Join requests | Waiting on you | Seed join request hub item or assert explicit W2/source deferral if emitter is absent. |
| Failed runs | Notifications | Seed failed-run hub item, assert notification lane and source link. |
| Alerts: agent errors and budget | Notifications | Seed alert hub item or assert explicit deferred source coverage. |
| Stale work | Suggestions | Run stale work materializer and assert suggestion lane. |
| My recent tasks | Removed from hub by master scope | Assert Tasks page remains reachable; no hub row required. |
| Dismissed legacy alert state | Hub personal dismissed state | Assert dismiss hides only for actor and old local-storage migration no longer gates the hub. |

## File Map

### UI Routes And Navigation

- Modify `ui/src/App.tsx`
  - Route `/inbox`, `/inbox/new`, `/inbox/all` to `InboxHub` or redirects into hub lane/history state.
  - Keep `/inbox-hub/*` as compatibility redirects to `/inbox/*` for PR #244 links and browser history.
  - Remove the direct legacy `Inbox` route from board routes after tests pass.
- Modify `ui/src/components/Sidebar.tsx`
  - Point the `Inbox` nav item at `/inbox`.
  - Remove the `Hub preview` nav item and unused `LayoutDashboard` import.
  - Keep Approvals visible in the Work section.
- Modify `ui/src/pages/InboxHub.tsx`
  - Accept both `/inbox/*` and compatibility `/inbox-hub/*` route params.
  - Normalize lane paths so canonical navigation writes `/inbox/...`.
  - Replace all internal `/inbox-hub` navigations with canonical `/inbox` navigation.
  - Add a route-backed history/all mapping for `/inbox/all` and any `status` query state; do not keep all/history only in component memory.
  - Preserve `location.search` when redirecting or canonicalizing compatibility links.
- Modify `ui/src/lib/company-routes.ts`
  - Ensure `inbox` remains a company route root.
  - Keep `inbox-hub` only if compatibility redirects need company prefixing.

### Badge And Count Consistency

- Modify `server/src/routes/sidebar-badges.ts`
  - Prefer the same board-user role resolution and `hubCounterSnapshotsService.getOrRefresh` pattern used by `server/src/routes/hub-items.ts` for W1 hub counts where safe.
  - Do not create fake counter snapshots for agent/MCP actors; use board-only hub counts and keep legacy fallback behavior for non-board callers if this route still serves them.
  - Keep existing source-specific counts only for explicitly deferred sources not yet emitted to hub.
- Modify `ui/src/components/Sidebar.tsx`
  - Keep badge display unchanged visually, but source it from the cutover badge contract.
- Modify `server/src/__tests__/sidebar-badges.test.ts` or create it if absent.
  - Cover hub-count badge behavior and deferred-source add-ons.

### Tests And Acceptance

- Modify `ui/src/__tests__/InboxHub.test.tsx`
  - Add route canonicalization tests for `/inbox`, `/inbox/new`, `/inbox/all`, and `/inbox-hub/*`.
- Modify `ui/src/components/hub/__tests__/HubShell.test.tsx`
  - Add no-regression checks for mobile shell, bulk bar, undo, settings, and route changes if needed.
- Modify or create `ui/src/__tests__/Sidebar.test.tsx`
  - Assert one Inbox nav item, no Hub preview item, and Approvals remains reachable.
- Create `tests/e2e/inbox-hub-operator.spec.ts`
  - Final desktop and mobile user-flow acceptance.
- Modify `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md`
  - Mark PR #244 merged.
  - Mark final cutover plan active.
  - Record final verification evidence after implementation.

## Implementation Tasks

### Task 0: Route Contract Tests First

**Files:**
- Modify `ui/src/__tests__/InboxHub.test.tsx`
- Modify `ui/src/App.tsx`

- [ ] **Step 1: Add failing route tests**

Add test cases with memory-router entries:

```tsx
it("renders the hub at the canonical /inbox route", async () => {
  renderInboxHubRoute("/ACME/inbox");
  expect(await screen.findByRole("heading", { name: /Inbox/i })).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: /Hub lanes/i })).toBeInTheDocument();
});

it("maps legacy /inbox/new to the active hub view", async () => {
  renderInboxHubRoute("/ACME/inbox/new");
  expect(await screen.findByRole("button", { name: /Waiting on you/i })).toHaveAttribute("aria-current", "true");
});

it("maps legacy /inbox/all to hub history without mounting the legacy Inbox", async () => {
  renderInboxHubRoute("/ACME/inbox/all");
  expect(await screen.findByRole("button", { name: /History/i })).toBeInTheDocument();
  expect(screen.queryByText(/All categories/i)).not.toBeInTheDocument();
});

it("redirects old /inbox-hub deep links to canonical /inbox links", async () => {
  const router = renderInboxHubRoute("/ACME/inbox-hub/waiting/hub-item-1?q=approval&status=archived");
  await waitFor(() => expect(router.state.location.pathname).toBe("/ACME/inbox/waiting/hub-item-1"));
  expect(router.state.location.search).toBe("?q=approval&status=archived");
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/ui test -- InboxHub.test.tsx
```

Expected: tests fail because `/inbox` still mounts legacy `Inbox` and `/inbox-hub` is still canonical.

- [ ] **Step 3: Implement route cutover**

In `ui/src/App.tsx`, replace the legacy route block with this shape:

```tsx
<Route path="inbox" element={<InboxHub />} />
<Route path="inbox/new" element={<InboxHubLegacyRedirect mode="new" />} />
<Route path="inbox/all" element={<InboxHubLegacyRedirect mode="all" />} />
<Route path="inbox/:lane" element={<InboxHub />} />
<Route path="inbox/:lane/:itemId" element={<InboxHub />} />
<Route path="inbox-hub" element={<InboxHubCompatibilityRedirect />} />
<Route path="inbox-hub/:lane" element={<InboxHubCompatibilityRedirect />} />
<Route path="inbox-hub/:lane/:itemId" element={<InboxHubCompatibilityRedirect />} />
```

Create small redirect components in `ui/src/pages/InboxHub.tsx` that read `companyPrefix`, params, and `location.search`, then return `<Navigate replace />` to the company-prefixed canonical path:

```tsx
function prefixedInboxPath(companyPrefix: string | undefined, suffix = "") {
  return `/${companyPrefix ?? ""}/inbox${suffix}`.replace("//", "/");
}
```

Use project router helpers where available. Do not use raw absolute `/inbox` redirects that drop the company prefix.

- [ ] **Step 3a: Refactor internal canonical navigation**

In `ui/src/pages/InboxHub.tsx`, update every internal navigation path:

- default landing redirect;
- hidden-lane fallback;
- unknown-lane fallback;
- `handleLaneChange`;
- `handleSelectItem`;
- compatibility redirects.

Add route tests for lane click, item click, hidden-lane fallback, default landing redirect, unknown lane, and search/query preservation.

- [ ] **Step 4: Run route tests**

Run:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/ui test -- InboxHub.test.tsx
```

Expected: route tests pass and no legacy Inbox text appears in hub route tests.

### Task 1: Sidebar Cutover

**Files:**
- Modify `ui/src/components/Sidebar.tsx`
- Create or modify `ui/src/__tests__/Sidebar.test.tsx`

- [ ] **Step 1: Add failing sidebar tests**

Add tests:

```tsx
it("shows a single Inbox nav item that opens the hub", () => {
  renderSidebar();
  expect(screen.getAllByRole("link", { name: /Inbox/i })).toHaveLength(1);
  expect(screen.getByRole("link", { name: /Inbox/i })).toHaveAttribute("href", "/ACME/inbox");
  expect(screen.queryByText(/Hub preview/i)).not.toBeInTheDocument();
});

it("keeps Approvals reachable from Work nav", () => {
  renderSidebar();
  expect(screen.getByRole("link", { name: /Approvals/i })).toHaveAttribute("href", "/ACME/approvals/pending");
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/ui test -- Sidebar.test.tsx
```

Expected: the test fails because "Hub preview" still renders.

- [ ] **Step 3: Update sidebar**

Remove the `Hub preview` item:

```tsx
<SidebarNavItem
  to="/inbox"
  label="Inbox"
  icon={Inbox}
  badge={sidebarBadges?.inbox}
  badgeTone={sidebarBadges?.failedRuns ? "danger" : "default"}
  alert={(sidebarBadges?.failedRuns ?? 0) > 0}
  collapsed={collapsed}
/>
```

Remove the unused `LayoutDashboard` import. Keep:

```tsx
<SidebarNavItem to="/approvals/pending" label="Approvals" icon={ShieldCheck} collapsed={collapsed} />
```

- [ ] **Step 4: Run sidebar tests**

Run:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/ui test -- Sidebar.test.tsx
```

Expected: PASS.

### Task 2: Legacy Category Parity Tests

**Files:**
- Modify `server/src/__tests__/hub-old-inbox-parity.test.ts`
- Modify `server/src/__tests__/hub-materializers.test.ts`
- Modify `ui/src/components/hub/__tests__/hubRegistry.test.tsx`
- Modify `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md`

- [ ] **Step 1: Add parity assertions**

Assert that each W1 legacy category has a hub semantic mapping:

```ts
import { HUB_SEMANTIC_TO_LANE } from "@armyofagents/shared";

it.each([
  ["approvals", "approval_request", "waiting_on_you"],
  ["discussion pending review", "discussion_pending", "waiting_on_you"],
  ["thread human input", "human_input_needed", "waiting_on_you"],
  ["failed runs", "run_failed", "notifications"],
  ["budget alert", "budget_alert", "notifications"],
  ["stale work", "stale_work", "suggestions"],
])("%s maps to a hub lane", (_label, semanticType, expectedLane) => {
  expect(HUB_SEMANTIC_TO_LANE[semanticType]).toBe(expectedLane);
});
```

Use `HUB_SEMANTIC_TYPES`, `HUB_SEMANTIC_TO_LANE`, and the actual exported registry helper names from `ui/src/components/hub/hubRegistry.tsx` or `packages/shared/src/hub.ts`; do not duplicate the lane map inside the test. Dotted source event names may be tested only in source-to-semantic translation tests, not as hub semantic types.

- [ ] **Step 2: Add source-materializer checks**

For materialized sources such as stale work and approval requests, assert the service emits or reconciles into `hub_items`:

```ts
it("materializes stale work into the suggestions lane", async () => {
  const emitted = await emitStaleWorkHubItems(db, companyId, null);
  expect(emitted.some((item) => item.semanticType === "stale_work")).toBe(true);
});
```

For categories intentionally deferred, add a named assertion in the roadmap:

```md
- Join request hub emission is deferred to W2-L2 if no W1 source producer exists; `/approvals` and `/access` canonical routes remain reachable.
```

Only use a deferral when code inspection proves no W1 emitter exists.

- [ ] **Step 3: Run parity tests**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/hub-old-inbox-parity.test.ts server/src/__tests__/hub-materializers.test.ts
corepack pnpm@9.15.4 --filter @armyofagents/ui test -- hubRegistry.test.tsx
```

Expected: PASS with every legacy category either mapped or explicitly recorded.

### Task 3: Sidebar Badge Alignment

**Files:**
- Modify `server/src/routes/sidebar-badges.ts`
- Create or modify `server/src/__tests__/sidebar-badges.test.ts`
- Modify `ui/src/components/Sidebar.tsx` only if the badge response shape changes

- [ ] **Step 1: Add failing badge tests**

Add route tests:

```ts
it("uses hub counts for the Inbox badge after cutover", async () => {
  mockHubCounterSnapshots.getOrRefresh.mockResolvedValue({ open: 7, unread: 3 });
  const res = await request(app).get(`/api/companies/${companyId}/sidebar-badges`);
  expect(res.status).toBe(200);
  expect(res.body.inbox).toBe(7);
});

it("keeps failed-run danger tone data available for the sidebar", async () => {
  mockSidebarBadgeService.get.mockResolvedValue({ failedRuns: 2, inbox: 0, pendingDiscussions: 0 });
  mockHubCounterSnapshots.getOrRefresh.mockResolvedValue({ open: 5, unread: 4 });
  const res = await request(app).get(`/api/companies/${companyId}/sidebar-badges`);
  expect(res.body.failedRuns).toBe(2);
  expect(res.body.inbox).toBe(5);
});

it("uses founder visibility for local implicit and instance-admin board actors", async () => {
  mockPermissionService.getEffectiveRole.mockResolvedValue("team_member");
  await request(app).get(`/api/companies/${companyId}/sidebar-badges`);
  expect(mockHubCounterSnapshots.getOrRefresh).toHaveBeenCalledWith(
    expect.objectContaining({ companyId, userId: "local-board", role: "founder" }),
  );
});

it("uses scoped role visibility for team leads and team members", async () => {
  mockPermissionService.getEffectiveRole.mockResolvedValueOnce("team_lead");
  await request(app).get(`/api/companies/${companyId}/sidebar-badges`);
  expect(mockHubCounterSnapshots.getOrRefresh).toHaveBeenCalledWith(
    expect.objectContaining({ role: "team_lead" }),
  );
});

it("does not create hub counter snapshots for agent callers", async () => {
  await request(agentApp).get(`/api/companies/${companyId}/sidebar-badges`);
  expect(mockHubCounterSnapshots.getOrRefresh).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run failing badge tests**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/sidebar-badges.test.ts
```

Expected: tests fail because the current route still manually sums legacy source counts.

- [ ] **Step 3: Implement badge alignment**

In `server/src/routes/sidebar-badges.ts`, fetch hub counts for board actors by mirroring the `server/src/routes/hub-items.ts` pattern:

```ts
function hasImplicitFounderAuthority(req: Request): boolean {
  return req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true;
}

async function resolveHubBadgeRole(req: Request, companyId: string, userId: string): Promise<UserRole> {
  if (hasImplicitFounderAuthority(req)) return "founder";
  return permissionService(db).getEffectiveRole(companyId, userId);
}

if (req.actor.type === "board" && req.actor.userId) {
  await emitOpenApprovalHubItems(db, companyId);
  await emitStaleWorkHubItems(db, companyId, null);
  const role = await resolveHubBadgeRole(req, companyId, req.actor.userId);
  const hubCounts = await counterSnapshots.getOrRefresh({ companyId, userId: req.actor.userId, role });
  badges.inbox = hubCounts.open;
}
```

If the service requires a richer actor/role object, extract a shared helper from `hub-items.ts` instead of duplicating divergent logic. Keep legacy add-ons only for source categories recorded as deferred in Task 2. For non-board callers, do not write hub counter snapshots with fake user IDs.

- [ ] **Step 4: Run badge tests**

Run:

```sh
corepack pnpm@9.15.4 test:run server/src/__tests__/sidebar-badges.test.ts server/src/__tests__/hub-counter-snapshots.test.ts
```

Expected: PASS.

### Task 4: Final Operator E2E

**Files:**
- Create `tests/e2e/inbox-hub-operator.spec.ts`
- Modify `tests/e2e/inbox-hub-w1b.spec.ts`, `tests/e2e/inbox-hub-w1c.spec.ts`, or `tests/e2e/inbox-hub-w1d.spec.ts` only for route changes

- [ ] **Step 1: Add acceptance flow**

Create a Playwright spec with these flows:

```ts
test("founder clears the Inbox Hub operator flow", async ({ page }) => {
  await seedInboxHubOperatorScenario(page);
  await page.goto("/ACME/inbox");
  await expect(page.getByRole("heading", { name: /Inbox/i })).toBeVisible();
  await page.getByRole("button", { name: /Waiting on you/i }).click();
  await page.getByRole("row", { name: /Approval/i }).click();
  await page.getByRole("button", { name: /Open full/i }).click();
  await expect(page).toHaveURL(/\/approvals\//);
  await page.goBack();
  await page.getByRole("button", { name: /Resolve/i }).click();
  await expect(page.getByRole("button", { name: /Undo/i })).toBeVisible();
  await page.getByRole("button", { name: /Undo/i }).click();
  await page.getByRole("button", { name: /Archive/i }).click();
  await page.getByRole("button", { name: /History/i }).click();
  await expect(page.getByText(/Archived/i)).toBeVisible();
});
```

Use existing e2e helper style and fixtures from `tests/e2e/inbox-hub-w1b.spec.ts`, `tests/e2e/inbox-hub-w1c.spec.ts`, and `tests/e2e/inbox-hub-w1d.spec.ts`. Before adding `seedInboxHubOperatorScenario` or `seedInboxHubStaleActionScenario`, inspect those specs and extract/reuse the existing seed helpers or shared API factories. Do not hand-roll a second seeding pattern with different semantic types, actor setup, or company prefixes.

- [ ] **Step 2: Add stale and permission recovery flow**

Add assertions:

```ts
test("stale and permission states recover without losing context", async ({ page }) => {
  await seedInboxHubStaleActionScenario(page);
  await page.goto("/ACME/inbox/waiting");
  await page.getByRole("row", { name: /Stale version/i }).click();
  await page.getByRole("button", { name: /Resolve/i }).click();
  await expect(page.getByText(/Changed elsewhere/i)).toBeVisible();
  await expect(page.getByRole("row", { name: /Stale version/i })).toBeVisible();
  await page.getByRole("row", { name: /Founder only/i }).click();
  await expect(page.getByText(/Route/i)).toBeVisible();
  await expect(page.getByText(/Escalate/i)).toBeVisible();
});
```

- [ ] **Step 3: Add founder-authority acceptance flow**

Add explicit founder/non-founder coverage for authority-gated semantic types:

```ts
test("founder-authority hub items reject non-founder actions without losing context", async ({ page }) => {
  await seedInboxHubOperatorScenario(page, { role: "team_member" });
  await page.goto("/ACME/inbox/waiting");
  await page.getByRole("row", { name: /Founder only approval/i }).click();
  await page.getByRole("button", { name: /Resolve/i }).click();
  await expect(page.getByText(/permission/i)).toBeVisible();
  await expect(page.getByRole("row", { name: /Founder only approval/i })).toBeVisible();
  await expect(page.getByText(/Route/i)).toBeVisible();
  await expect(page.getByText(/Escalate/i)).toBeVisible();
});

test("founder can act on founder-authority hub items", async ({ page }) => {
  await seedInboxHubOperatorScenario(page, { role: "founder" });
  await page.goto("/ACME/inbox/waiting");
  await page.getByRole("row", { name: /Founder only approval/i }).click();
  await page.getByRole("button", { name: /Resolve/i }).click();
  await expect(page.getByRole("button", { name: /Undo/i })).toBeVisible();
});
```

The semantic types under test must include `approval_request` and `join_request` if the source producer exists. If `join_request` remains explicitly deferred after Task 2, test the deferral route and keep the non-founder action test on `approval_request`.

- [ ] **Step 4: Add approvals canonical-route coverage**

Add route and registry assertions:

```ts
test("approval canonical routes remain available", async ({ page }) => {
  await page.goto("/ACME/approvals/pending");
  await expect(page.getByRole("heading", { name: /Approvals/i })).toBeVisible();
  await page.goto("/ACME/approvals/all");
  await expect(page.getByRole("heading", { name: /Approvals/i })).toBeVisible();
  await page.goto("/ACME/approvals/approval-1");
  await expect(page).toHaveURL(/\/ACME\/approvals\/approval-1/);
});
```

In a UI/unit test, assert `HUB_REGISTRY.approval_request.fullLink(item)` returns `/approvals/:sourceId`.

- [ ] **Step 5: Add mobile flow**

Add a mobile viewport scenario:

```ts
test("mobile Inbox Hub navigation has no overlap", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seedInboxHubOperatorScenario(page);
  await page.goto("/ACME/inbox");
  await page.getByRole("button", { name: /Open lanes/i }).click();
  await page.getByRole("button", { name: /Notifications/i }).click();
  await page.getByRole("row").first().click();
  await expect(page.getByRole("complementary", { name: /Hub viewer/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Close viewer/i })).toBeVisible();
});
```

- [ ] **Step 6: Run focused e2e when environment supports it**

Run:

```sh
corepack pnpm@9.15.4 exec playwright test tests/e2e/inbox-hub-w1b.spec.ts tests/e2e/inbox-hub-w1c.spec.ts tests/e2e/inbox-hub-w1d.spec.ts tests/e2e/inbox-hub-operator.spec.ts --config tests/e2e/playwright.config.ts
```

Expected on Linux CI or local external Postgres: PASS.

Expected on Windows without `DATABASE_URL`: the config may select `windows-embedded-postgres-skip.spec.ts`; record the exact output and rely on Linux CI for browser acceptance.

### Task 5: Legacy Surface Cleanup

**Files:**
- Modify `ui/src/pages/Inbox.tsx`
- Modify `ui/src/App.tsx`
- Modify `ui/src/__tests__/Inbox-nesting.test.tsx`
- Modify `ui/src/__tests__/useInboxBadge.test.tsx`
- Modify `ui/src/hooks/useInboxBadge.ts` only if no remaining consumer exists
- Modify or verify `ui/src/lib/inbox.ts`
- Modify or verify `ui/src/lib/keyboard-shortcuts-config.ts`
- Modify or verify any command-palette/go-to-inbox registration if present

- [ ] **Step 1: Check references**

Run:

```sh
rg "from \"\\.\\/pages\\/Inbox\"|from \"\\.\\.\\/pages\\/Inbox\"|<Inbox|useInboxBadge|Inbox-nesting" ui/src tests server packages
rg "aoa:inbox|inbox-hub|Hub preview|Inbox nesting|go to inbox|Go to Inbox|keyboard.*inbox" ui/src tests docs
```

Expected: after route cutover, `Inbox.tsx` should have no production route references.

- [ ] **Step 2: Choose cleanup path**

If only tests reference legacy Inbox, delete:

```sh
ui/src/pages/Inbox.tsx
ui/src/__tests__/Inbox-nesting.test.tsx
```

Delete `ui/src/hooks/useInboxBadge.ts` and `ui/src/__tests__/useInboxBadge.test.tsx` only if no production surface still consumes the legacy dismissal migration. Update or delete `ui/src/lib/inbox.ts` and shortcut labels when the legacy Inbox nesting/dismissal model is gone.

- [ ] **Step 3: Run affected tests**

Run:

```sh
corepack pnpm@9.15.4 --filter @armyofagents/ui test -- InboxHub.test.tsx Sidebar.test.tsx
corepack pnpm@9.15.4 --filter @armyofagents/ui typecheck
```

Expected: PASS.

### Task 6: Roadmap And PR Evidence

**Files:**
- Modify `docs/aoa/plans/2026-06-29-inbox-hub-integration-roadmap.md`
- Modify this plan

- [x] **Step 1: Update roadmap status**

Record:

```md
- PR #244 merged W1b/W1c/W1d into `main`.
- `feat/inbox-hub-integration` now tracks final cutover and acceptance.
- Final cutover replaced `/inbox` with the hub and preserved `/approvals/*`.
```

- [x] **Step 2: Record verification evidence**

Exact command results recorded after implementation:

- `corepack pnpm@9.15.4 --filter @armyofagents/ui test -- InboxHub.test.tsx --reporter=basic` - PASS, 23 tests.
- `corepack pnpm@9.15.4 --filter @armyofagents/ui test -- Sidebar.test.tsx --reporter=basic` - PASS, 4 files / 38 tests.
- `corepack pnpm@9.15.4 test:run server/src/__tests__/hub-old-inbox-parity.test.ts server/src/__tests__/hub-materializers.test.ts` - PASS, 2 files / 10 tests.
- `corepack pnpm@9.15.4 --filter @armyofagents/ui test -- hubRegistry.test.tsx --reporter=basic` - PASS, 5 tests.
- `corepack pnpm@9.15.4 test:run server/src/__tests__/sidebar-badges.test.ts server/src/__tests__/hub-counter-snapshots.test.ts` - PASS, 2 files / 7 tests.
- `corepack pnpm@9.15.4 --filter @armyofagents/ui typecheck` - PASS.
- `corepack pnpm@9.15.4 --filter @armyofagents/server typecheck` - PASS.
- `corepack pnpm@9.15.4 test:run` - PASS, 1254 files passed / 35 skipped, 10580 tests passed / 189 skipped.
- `corepack pnpm@9.15.4 exec playwright test --config tests/e2e/playwright.config.ts` - PASS for the local Windows sentinel, 1 skipped. The Windows config did not select the real browser specs without `DATABASE_URL`; Linux CI remains the browser acceptance gate.
- `corepack pnpm@9.15.4 -r typecheck` - BLOCKED locally by nested pnpm install/build-script approval state in `packages/plugins/sdk` (`ERR_PNPM_IGNORED_BUILDS` after earlier no-TTY/frozen-lockfile install checks). Focused UI and server typechecks passed.
- `corepack pnpm@9.15.4 build` - BLOCKED locally during prebuild dependency resolution by pnpm ignored-build-script approval (`@embedded-postgres/windows-x64`, `es5-ext`, `esbuild`, `sqlite3`). No build artifact claim made from this workstation.

Execution notes:

- Final cutover routes `/inbox`, `/inbox/new`, `/inbox/all`, and `/inbox-hub/*`
  to the Hub while preserving company prefixes and query strings.
- Sidebar now has one Inbox entry, no Hub preview entry, and keeps Approvals in
  the Work section.
- Sidebar Inbox badges use RBAC-scoped hub counter snapshots for board users and
  do not create fake hub counter snapshots for non-board actors.
- Legacy `Inbox.tsx`, `useInboxBadge`, and their UI tests were deleted after
  parity and route tests proved W1 categories are covered or explicitly routed.
- Playwright operator coverage was added in `tests/e2e/inbox-hub-operator.spec.ts`.
  Local Windows verification uses the repository's embedded-Postgres skip spec
  unless `DATABASE_URL` is provided.

### Task 7: Final Verification

Run:

```sh
corepack pnpm@9.15.4 -r typecheck
corepack pnpm@9.15.4 test:run
corepack pnpm@9.15.4 build
corepack pnpm@9.15.4 exec playwright test tests/e2e/inbox-hub-w1b.spec.ts tests/e2e/inbox-hub-w1c.spec.ts tests/e2e/inbox-hub-w1d.spec.ts tests/e2e/inbox-hub-operator.spec.ts --config tests/e2e/playwright.config.ts
```

If the local Windows e2e caveat triggers, also run:

```sh
corepack pnpm@9.15.4 exec playwright test windows-embedded-postgres-skip.spec.ts --config tests/e2e/playwright.config.ts
```

Expected: typecheck, Vitest, and build pass locally. Browser acceptance must pass in Linux CI or a local environment with explicit `DATABASE_URL`.

## Risk Register

| Risk | Impact | Mitigation |
|---|---:|---|
| `/inbox` cutover breaks old bookmarks | High | Keep `/inbox/new`, `/inbox/all`, and `/inbox-hub/*` redirects/tests. |
| Compatibility redirect drops company prefix or query string | High | Use company-aware redirect helpers and assert `/ACME/...` plus `location.search` preservation. |
| Legacy Inbox category disappears | High | Parity matrix plus source materializer/registry tests before deleting legacy surface. |
| Sidebar badge count changes unexpectedly | High | Route tests pin hub count source and deferred-source add-ons. |
| Sidebar badge bypasses hub RBAC | High | Mirror `hub-items.ts` board-user role resolution; no fake user snapshots for agent/MCP actors. |
| Semantic type tests use stale dotted source names | High | Use `HUB_SEMANTIC_TYPES` and `HUB_SEMANTIC_TO_LANE`; dotted names only belong in source translation tests. |
| Approvals become reachable only through hub | Medium | Keep `/approvals/*` routes and sidebar Work nav entry. |
| Non-founder users see dead founder-only controls | High | Acceptance tests must cover non-founder rejection, clear recovery copy, Route/Escalate affordance, and preserved context. |
| Acceptance e2e duplicates W1b/W1c/W1d too much | Medium | Operator spec covers integration flow; W1 phase specs keep focused behavior. |
| Local Windows e2e cannot run real browser specs | Medium | Record sentinel result locally and require Linux CI for Playwright gate. |
| Cutover accidentally starts W2/W3/W4/W5 | High | This plan only changes route/nav/badge/parity/acceptance. |

## Review Checklist

- [ ] `/inbox` opens the Hub.
- [ ] `/inbox/new` and `/inbox/all` remain valid.
- [ ] `/inbox-hub/*` compatibility links redirect to canonical company-prefixed `/inbox/*` and preserve query string.
- [ ] `InboxHub.tsx` internal navigation writes canonical `/inbox` paths, not `/inbox-hub`.
- [ ] Sidebar has one Inbox item and no Hub preview item.
- [ ] Approvals remains reachable from sidebar and `/approvals/*`.
- [ ] Legacy Inbox parity matrix is fully tested or explicitly deferred.
- [ ] Legacy parity tests use shipped hub semantic types, not placeholder source event names.
- [ ] Sidebar badge matches RBAC-scoped hub counts for W1-visible items.
- [ ] Operator e2e covers desktop, stale/permission recovery, founder/non-founder authority, and mobile.
- [ ] Approval `Open full` and `/approvals/pending|all|:id` canonical routes are tested.
- [ ] Legacy cleanup covers stale local-storage, shortcut, and command/navigation references.
- [ ] Full verification evidence is recorded before PR handoff.
- [ ] No W2/W3/W4/W5 implementation enters this cutover.

## Review Notes

### Independent Codex Review

Ran a read-only Codex review of this plan after the first draft. Findings were applied in-place:

- Company-prefixed `/inbox-hub/*` redirects must preserve `/ACME` and query strings.
- `InboxHub.tsx` needs an internal canonical navigation refactor, not only route changes in `App.tsx`.
- Parity examples must use shipped semantic types such as `approval_request`, `run_failed`, and `stale_work`.
- Sidebar badge alignment must mirror `hub-items.ts` role resolution and avoid fake snapshots for agent/MCP actors.
- Acceptance must cover founder-authority failures for non-founder users and success for founders.
- `/inbox/all` needs explicit route-backed behavior.
- Approval canonical routes and `approval_request` full-link behavior need tests.
- Legacy cleanup must check shortcut/local-storage helpers, not just `Inbox.tsx`.
- E2E operator fixtures must reuse existing W1b/W1c/W1d seed helpers.
- User-facing copy should consistently present the surface as Inbox.

## Execution Recommendation

Use subagent-driven development:

1. Route/sidebar cutover agent.
2. Parity/badge agent.
3. Operator e2e agent.
4. Cleanup/verification agent.

Review after each agent before moving to the next task group.
