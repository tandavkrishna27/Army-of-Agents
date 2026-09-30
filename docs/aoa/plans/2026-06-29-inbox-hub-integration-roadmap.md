# Inbox Hub Integration Roadmap

**Status:** Active integration roadmap; W1b/W1c/W1d merged in PR #244, final cutover merged in PR #246, W2 Layer 3 merged in PR #248, W3 Autopilot merged in PR #249, W4a Steward foundation merged in PR #256, W5a runtime decision core (+ hardening) merged in PR #259, W5b first real adapter bridge (`claude_local`, PreToolUse hook) merged in PR #264, W5c second adapter bridge (`codex_local`, app-server re-platform, command + file-change) merged in PR #268 (Decision #106). **W5 runtime decision routing is complete across the two primary adapters.** Remaining W5 follow-ups (deferred, unscheduled): work_question routing, remote targets, opencode/gemini/cursor bridge feasibility.
**Date:** 2026-06-29
**Type:** Integration roadmap / planning spine
**Design authority:** `docs/aoa/plans/2026-06-26-inbox-hub-master-scope.md`
**Prototype:** `docs/aoa/inbox-hub-prototype.html`

This document keeps the Inbox/Approvals Hub implementation sequenced after W6
and W1a. It does not replace the master scope. It translates that scope into
PR boundaries, plan order, verification gates, and "do not drift" lines so the
integration branch can be tested as one coherent product before it lands.

---

## 1. Current Baseline

Completed foundations:

- **W6 - Org reporting prerequisite:** merged in PR #242. Human-at-top ownership
  resolution is now available for hub ownership.
- **W1a - Hub data core:** merged in PR #243. The unified hub index, RBAC,
  audit, emit/query/action/reconcile service, REST routes, counts, and shared
  hub contracts are on `main`.

Current roadmap branch:

- **Branch:** `codex/w5-runtime-decision-routing`
- **Purpose:** plan and build W5 runtime decision routing after W4 Steward
  foundation landed.
- **Rule:** keep W5 scoped to runtime prompt durability, hub Waiting on you
  routing, answer relay, timeout/watchdog behavior, and proven adapter bridges.
  Keep Mail drafting out of this PR family.

Final cutover status:

- PR #244 merged W1b/W1c/W1d into `main`.
- PR #246 merged final Inbox cutover into `main`.
- Final cutover replaced `/inbox` with the hub, preserved `/inbox/new`,
  `/inbox/all`, `/inbox-hub/*`, and `/approvals/*`, removed the Hub preview
  sidebar entry, and deleted the unreferenced legacy `Inbox.tsx` UI surface.

Merged in PR #244:

- **W1b - Hub UI shell:** three-pane Inbox Hub shell, rail lanes, Home overview,
  registry-backed viewer, Approvals reachability, lane/item deep links, and W1b
  Playwright coverage.
- **W1c - Lifecycle:** read/unread, personal snooze/dismiss and inverse undo,
  shared resolve/archive, board-pool Claim/Release, server audit undo,
  deterministic bulk endpoint and UI controls, history/audit UI, compact bulk
  partial-result banner, and W1c Playwright coverage.
- **W1d - Grouping/search/settings/mobile/performance:** server-side search,
  keyset pagination, deterministic grouped rows, per-user hub preferences,
  mobile rail drawer and stacked viewer flow, keyboard shortcuts, per-user
  counter snapshots, and W1d Playwright coverage.

Completed W2 foundation:

- **W2 Layer 2:** implemented from
  `docs/aoa/plans/2026-06-30-w2-layer2-notifications-registry-plan.md`.
  Scope was persistent notification registry, canonical hub-backed create path,
  legacy route state sync, direct-write guard, cockpit proactive compatibility,
  and dead-type cleanup.
- **W2 Layer 3:** merged in PR #248 from
  `docs/aoa/plans/2026-06-30-w2-layer3-realtime-notifications-plan.md`.
  Scope was realtime hub events, toast bridge, preferences, quiet hours, digest
  queue integration, and focused e2e coverage.

Completed W3 foundation:

- **W3 Autopilot:** merged in PR #249 from
  `docs/aoa/plans/2026-07-01-w3-autopilot-core-plan.md` on
  `codex/w3-autopilot-planning`. Scope was deterministic policy/evaluation,
  trust-gated auto-handle vs escalate, autonomous audit, undo, Home/settings UI,
  and e2e acceptance coverage.

Completed W4 foundation:

- **W4 Steward:** W4a foundation merged in PR #256 from
  `docs/aoa/plans/2026-07-01-w4-steward-foundation-plan.md` on
  `codex/w4-steward-planning`. Scope was Steward crew seeding, deterministic hub
  curation, explanation/group-summary metadata, a narrow curation write tool,
  and focused operator acceptance coverage.

Active next:

- **W5a runtime decision core:** merged in PR #259 (durable runtime-decision
  core, hub viewer, heartbeat broker, timeout/sweep, scoped trust rules — inert).
- **W5b first real adapter bridge (`claude_local`):** **merged in PR #264**
  (plan: `docs/aoa/plans/2026-07-03-w5b-first-adapter-runtime-bridge-plan.md`,
  Decision #105). Permission prompts route to the hub via a `PreToolUse` hook +
  fail-closed command forwarder; per-agent flag + instance kill-switch +
  local-target guard, default OFF. Spike-proven on Claude Code 2.1.126.
- **W5c second adapter bridge (`codex_local`):** **merged in PR #268**
  (plan: `docs/aoa/plans/2026-07-03-w5c-codex-app-server-bridge-plan.md`,
  Decision #106). Dual-path: supervised runs re-platform to `codex app-server`
  (JSON-RPC over stdio, **in-process** approval callback — no HTTP/token/registry;
  the claude-only W5b machinery untouched), unsupervised runs keep `codex exec`
  byte-identical. Command **and file-change** approvals (out-of-tree writes
  declined at a cwd trust boundary), fail-closed v2 decision map, tracked child
  in `runningProcesses` via the new shared `spawnTrackedChild()` (cancellable +
  un-reaped while blocked on the 300s approval SLA). Same four-condition gate as
  W5b (allow-list + env kill-switch + local target + per-agent flag), default OFF.
  Live-spike-proven on codex-cli 0.130 (guarded harness `AOA_CODEX_APPSERVER_LIVE=1`;
  guarded e2e `AOA_E2E_RUNTIME_DECISION_BRIDGE_CODEX=1` — both skip in CI).
  Deferred: work_question (`item/tool/requestUserInput`), remote targets, other
  adapters (opencode/gemini/cursor feasibility unknown), live cross-path resume
  portability confirmation.

---

## 2. PR Strategy

### Completed Integration PRs

PR #244 carried the coherent W1 hub experience through W1b/W1c/W1d and is now
merged. PR #246 carried final Inbox route/navigation cutover and is now merged.
There is no remaining W1 cutover PR in this roadmap.

### Separate Later PRs

These stay in separate focused PRs:

- **W2 Layer 2:** implemented; notifications registry, canonical hub-backed
  persistent emit, legacy route state sync, and dead-type cleanup.
- **W2 Layer 3:** merged in PR #248; realtime, toast bridge, preferences,
  quiet hours, and digests.
- **W3:** merged in PR #249; Autopilot autonomy and auto-action audit/undo.
- **W4:** merged in PR #256; Steward crew
  agent, deterministic curation worker, narrow curation write tool, UI
  explanation surfaces, and focused acceptance coverage.
- **W5a:** runtime decision core merged in PR #259; per-adapter bridges (W5b+)
  planned in `docs/aoa/plans/2026-07-01-w5-runtime-decision-routing-plan.md`.

The roadmap tracks these later workstreams only as dependency boundaries. They
need their own investigation, implementation plans, tests, and PRs.

---

## 3. Plan Order

### Plan 1 - W1b Hub UI Shell

Goal: make the merged hub visible and useful on top of W1a.

Scope:

- Three-pane shell: rail, center lane list/Home overview, right collapsible
  tabbed viewer.
- Lanes: Home, Waiting on you, Notifications, Suggestions, Mail reserved.
- UI registry backed by shared hub semantic types.
- Source coverage/remap inventory for the old `Inbox.tsx` sections:
  approvals, discussions pending review, join requests, scope proposals,
  human-input items, notifications, failed runs, alerts, mentions, run-complete,
  stale work, and spinoff suggestions.
- Emit/backfill wiring for W1 lane sources not covered by W1a. W1a intentionally
  left the headline "Waiting on you" emitters for W1b, so W1b is not UI-only.
  Each remapped source must either emit into `hub_items` or be explicitly
  deferred with a testable reason and no lost user-visible item.
- Polling reads from W1a routes:
  - `GET /companies/:companyId/hub-items`
  - `GET /companies/:companyId/hub-items/counts`
  - `PATCH /companies/:companyId/hub-items/:id/state` only for minimal read
    state if needed.
- Viewer composition through existing surfaces instead of rebuilt detail UIs.
- Approvals reachable from sidebar and in-hub.
- Home overview with Autopilot display/control shell only.
- Deep-link basics for lanes and item selection.
- Baseline page-size/pagination handling for lane lists, plus cheap count usage
  from W1a counts. W1d can add virtualization and advanced high-volume UX, but
  W1b must not render an unbounded polling list.

Out of scope:

- True snooze-return mechanics.
- Undo timers.
- Bulk actions.
- Claim/reassign/escalate lifecycle.
- Realtime delivery.
- Autopilot decisions.
- W5 adapter bridges.

Exit criteria:

- The hub can replace the old flat Inbox in branch-level testing without losing
  the W1b remapped item categories.
- Seeded items for each W1b-remapped semantic type appear in the correct lane
  and open the correct viewer or canonical route.
- Approvals are reachable in one click and open in the hub viewer or their
  canonical detail route.
- Empty/loading/error states are explicit and company-scoped.
- The UI has focused component tests and at least one Playwright flow for lane
  navigation and item selection.
- The UI registry is total over `HUB_SEMANTIC_TYPES`, uses no local-only
  semantic strings, and any new semantic type includes shared-contract tests.

### Plan 2 - W1c Lifecycle

Goal: make daily triage reliable and reversible.

Implementation status: **implemented in PR #244**. Local focused verification
has covered shared contracts, DB schema, server route/service behavior, UI API
clients/hooks, page/component behavior, and targeted W1c Playwright spec authoring.
The local Windows embedded-Postgres e2e config switches to the documented skip
spec when `DATABASE_URL` is unset, so Linux CI remains the required Playwright
gate before marking the PR ready.

Scope:

- Read/unread interaction.
- Snooze controls and return behavior.
- Resolve, dismiss, and archive as distinct flows.
- Undo timer and recovery path for supported actions.
- Bulk selection and bulk action partial-failure semantics.
- History view for resolved/archived items.
- Owner display for every item.
- Authority-gated action states: hide or disable actions the actor cannot take,
  with Route/Escalate affordances instead of dead buttons.
- Claim/Release for board-pool items.
- Reassign, Escalate, and Route UI affordances with required reasons and audit
  expectations. Delegate/out-of-office automation stays later, but W1c must not
  erase the locked ownership model from the master scope.
- Action error recovery for stale version `409`, failed action, and source
  deleted.

Out of scope:

- Full realtime self-clearing.
- Autonomy auto-actions.
- Advanced grouping and search.

Exit criteria:

- Lifecycle actions call W1a action/state routes with `expectedVersion` and
  idempotency keys where required.
- Stale action and permission-denied states are visible and recoverable.
- Owner and authority are visually distinct, and non-authorized users are guided
  to Route/Escalate instead of seeing unusable decision controls.
- Bulk operations have deterministic success/partial/failure UI.
- Unit, route/client, and e2e tests cover the triage loop.

Explicit W1c deferrals:

- Full Route/Reassign/Escalate workflows and OOO/delegation automation remain
  W1d/W2+ work. W1c keeps Claim/Release scoped to board-pool items.
- Maintained counters, search, grouping, mobile hardening, and high-volume
  performance remain W1d.
- Realtime reconciliation, toast bridge, notification preferences, anti-spam,
  and digests remain W2.
- External source-side undo/relay behavior and runtime adapter bridges remain W5.
- Autopilot auto-actions and Steward curation/intelligence remain W3/W4.

### Plan 3 - W1d Grouping, Search, Settings, Mobile, Performance

Goal: make the hub usable at agent volume and on smaller screens.

Implementation status: **implemented in PR #244**. The branch now includes
server-side search and cursor pagination, deterministic grouping, hub
preferences, mobile/keyboard hardening, counter snapshots, and focused unit,
route, component, and Playwright coverage.

Scope:

- Grouping/categorization UX for high-volume items.
- Hub search across active and history surfaces.
- Settings: default landing lane, lane visibility, Autopilot entry point, and
  link/entry to future notification preferences.
- Mobile layout: rail drawer, list/viewer stack, safe touch targets.
- Keyboard and accessibility hardening.
- Performance: virtualization, advanced high-volume UX hardening, and no layout
  shifts. Baseline page-size handling and cheap counts are W1b requirements.

Out of scope:

- W2 realtime and notification preferences implementation.
- W3 Autopilot policy engine.
- W4 Steward grouping intelligence.

Exit criteria:

- The hub remains usable with seeded high-volume items.
- Mobile and desktop flows are covered by Playwright screenshots or assertions.
- Keyboard and screen-reader affordances are covered in component tests where
  practical.

### Plan 4 - Final Cutover and Acceptance

Goal: make the integration PR ready to review as one coherent replacement.

Scope:

- Replace or retire the old flat `Inbox.tsx` behavior behind the `/inbox` route.
- Keep canonical deep links for `/approvals/pending`, `/approvals/all`, and
  approval detail pages.
- Ensure sidebar badges and header notification peeks read the intended source
  for the phase.
- Remove dead UI paths only after tests prove the new paths cover them.
- Run final feature acceptance and visual QA.

Exit criteria:

- A founder can complete the full operator flow in the browser:
  1. Open the hub from sidebar.
  2. Review Home.
  3. Navigate Waiting on you, Notifications, and Suggestions.
  4. Open an approval in the viewer.
  5. Open the canonical full approval page.
  6. Return to the hub with selection state intact.
  7. Mark/read or perform lifecycle actions covered by W1c.
  8. Search/group/filter where W1d applies.
  9. Use the hub on a mobile viewport.
- The branch passes full verification commands listed in section 5.
- The PR description includes the phase checklist and test evidence for W1b,
  W1c, W1d, and final cutover.

---

## 4. Later Workstream Queue

### W2 - Notifications System

Layer 2 should lock the persistent notification registry and single emit path
against the shared hub semantic contract. Layer 3 should replace polling with
realtime and add the toast bridge plus preferences.

Current status: W2 Layer 3 merged in PR #248. W2 Layer 2 established the
registry and canonical hub-backed emit path. Layer 3 added RBAC-scoped live hub
events, query invalidation, toast hydration, notification preferences, quiet
hours, digest queueing, and focused browser coverage. Compatibility predicates
for old proactive notification rows (`internal_agent.proactive` and
`internal_agent_proactive`) remain until a separate backfill/migration plan
proves they can be removed.

Dependency boundary: W1 can use polling and W1a routes. W1 must not invent a
second notification store or toast system.

### W3 - Autopilot

Autopilot owns trust-gated auto-handle vs escalate behavior, delegated authority,
auto-action audit, and undo.

Current status: W3 Core merged in PR #249 from
`docs/aoa/plans/2026-07-01-w3-autopilot-core-plan.md`. Scope was deterministic
policy/evaluation, safe hub lifecycle auto-actions, audit/undo, and the Hub
Home/settings control surface.

Dependency boundary: W3 depends on W1 lifecycle and audit/action semantics being
stable.

### W4 - Steward

Steward is the dedicated curation agent and deterministic worker for grouping,
and triage explanations. Draft assistance is deferred to the future Mail work.

Current status: W4a foundation merged in PR #256 from
`docs/aoa/plans/2026-07-01-w4-steward-foundation-plan.md` on
`codex/w4-steward-planning`. W4a remained scoped to
Steward seeding, deterministic curation, explanation/group-summary metadata, a
narrow curation write tool, UI explanation surfaces, and operator acceptance
coverage.

Dependency boundary: W4 depends on stable hub item taxonomy, lifecycle, and
Autopilot policy.

### W5 - Runtime Decision Routing

W5 routes org-agent permission prompts and substantive work questions into
Waiting on you and relays answers back to blocked runs.

Current status: **W5a merged in PR #259** (plan:
`docs/aoa/plans/2026-07-01-w5-runtime-decision-routing-plan.md`; hardening plan:
`docs/aoa/plans/2026-07-02-w5a-hardening-plan.md`). W5a shipped the durable
runtime-decision core, hub viewer, heartbeat broker, timeout/watchdog + sweep,
and scoped allow-always trust rules, plus a post-review hardening pass
(non-null default expiry — permission 1h / work-question 24h; `continue_with_default`;
key-aware secret redaction; atomic allow-always with scope dedup + 90-day expiry;
resilient bounded sweep + `(status, expires_at)` index; nonce-replay guard).
Answering is **founder-only**.

**W5b (`claude_local`) merged in PR #264** (Decision #105): permission prompts
route to the hub via a `PreToolUse` hook + a fail-closed `type:"command"`
forwarder; per-agent `runtimeConfig.runtimeDecisionRoutingEnabled` + instance
kill-switch `AOA_RUNTIME_DECISION_ROUTING` + `executionTarget==="local"` guard,
default OFF; permission-only (`work_question` deferred). Spike-proven on Claude
Code 2.1.126 (finding: `PermissionRequest` is not a firing event → `PreToolUse`
with a scoped matcher is the mechanism).

**W5c (`codex_local`) merged in PR #268** (Decision #106, plan:
`docs/aoa/plans/2026-07-03-w5c-codex-app-server-bridge-plan.md`). The predicted
spawn-mode re-platform shipped as a **dual-path**: supervised runs drive
`codex app-server` (JSON-RPC over stdio) through a new shared `spawnTrackedChild()`
(registered in `runningProcesses` — cancellable + un-reaped while blocked on the
300s approval SLA) with the approval callback arriving **in-process** (no
HTTP/token/registry; the claude-only W5b machinery only gated, untouched);
unsupervised runs keep `codex exec` byte-identical. Ships **command +
file-change** approvals (file-change paths correlated `itemId → item/started`,
out-of-tree writes declined at a cwd trust boundary before ever prompting),
fail-closed v2 decision map (`allow_once→accept`, `allow_always→acceptForSession`,
everything else→`decline`). Same four-condition gate as W5b, default OFF.
Live-spike-proven on codex-cli 0.130; protocol reference:
`docs/adapters/codex-appserver-protocol.md`. Deferred: work_question
(`item/tool/requestUserInput`), remote targets, opencode/gemini/cursor
feasibility, live cross-path resume portability confirmation.

Dependency boundary: W5 requires a per-adapter feasibility matrix first. Start
with one adapter behind a feature flag. W1a reserves the type; W1b can render a
reserved/empty-state path but does not build bridges. (Satisfied: claude_local
W5b + codex_local W5c are live behind the shared flag; remaining adapters need
their own feasibility checks before any bridge work.)

---

## 5. Verification Strategy

Every implementation plan must include tests before implementation and must name
the exact test files and commands.

### Phase Gates

Each implementation PR must pass these gates before the next workstream starts:

- Focused unit/component/API/e2e tests for the phase are green.
- No later-workstream implementation has entered the branch outside the current
  scoped PR. For W5, Mail stays out and real adapter bridges must follow the
  feasibility gate.
- The old Inbox equivalence matrix is updated for every source category touched.
- Seeded demo/test data verifies the new lane/viewer behavior.
- `/inbox` remains the hub route after PR #246; do not reintroduce the legacy
  `Inbox.tsx` surface.
- `git diff --name-only origin/main...HEAD` is reviewed so the branch contains
  only intended roadmap, plan, and implementation files.

### Per-Phase Required Coverage

- **Shared/contracts:** when shared types or validators change, add tests under
  `packages/shared/src/__tests__` or `packages/shared/src/validators/__tests__`.
- **Server:** when routes, services, RBAC, or actions change, add tests under
  `server/src/__tests__`.
- **UI API clients:** when client functions change, add tests under
  `ui/src/api/__tests__`.
- **UI components/pages:** add Vitest/Testing Library coverage under
  `ui/src/__tests__`, `ui/src/pages/__tests__`, or component-local `__tests__`.
- **E2E:** add Playwright specs under `tests/e2e` for every user-visible phase.

### W1b Minimum Tests

- Hub API client builds correct URLs for list/counts/state.
- Lane registry maps every W1a semantic type to one lane and one viewer
  strategy.
- UI registry is total over `HUB_SEMANTIC_TYPES` and rejects unknown local-only
  semantic strings in tests.
- Source-remap tests prove every old Inbox category either emits to a hub lane
  or has an explicit, documented deferral.
- Sidebar exposes Inbox/Hub and Approvals reachability as specified.
- Hub page renders Home, lane list, empty states, loading states, and error
  states.
- Selecting an item opens a right-side viewer tab and preserves list context.
- "Open full" navigates to the canonical source page.
- Playwright: founder opens the hub, switches lanes, opens a seeded item, opens
  full detail, and returns.

### W1c Minimum Tests

- Read/unread, snooze, dismiss, resolve, archive client calls include the right
  route payload.
- Stale `409` action errors show a recovery state.
- Permission-denied actions do not leave dead buttons.
- Owner, authority, Claim/Release, Route, and Escalate states render distinctly.
- Bulk action partial failures are represented deterministically.
- Playwright: founder clears a mixed queue and sees undo/history behavior.

### W1d Minimum Tests

- Search filters active/history results without breaking lane state.
- Grouping collapses high-volume items and preserves item access.
- Settings persist default landing and lane visibility.
- Mobile viewport can navigate rail/list/viewer without overlap.
- Keyboard navigation covers lane movement and item selection.
- Playwright: desktop and mobile hub smoke with screenshots/assertions.

### Final Operator Acceptance Matrix

Create a focused Playwright acceptance spec:

`tests/e2e/inbox-hub-operator.spec.ts`

It covers or documents:

- Founder local-trusted browser flow for seeded hub items; authenticated
  non-founder Playwright coverage remains a follow-up because the current e2e
  harness runs in local-trusted mode.
- Each old Inbox category remapped to its W1 lane or documented as deferred.
- Approval open in hub viewer, approval action where supported, canonical full
  detail open, and return to hub with lane/selection state intact.
- Stale `409` action recovery.
- Permission-denied action state via route/unit coverage; authenticated browser
  coverage remains a follow-up with the multi-user e2e harness.
- Source-deleted or auto-resolved item state.
- Snooze return, undo/history, and bulk partial failure once W1c lands.
- Mobile lane/list/viewer navigation without overlap.
- Header bell and sidebar badge deep-linking into the hub.

### Final PR Verification Commands

Run before claiming the integration PR is ready:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
pnpm test:e2e -- inbox-hub-operator.spec.ts
```

If the final e2e is split across multiple specs, run the whole focused set:

```sh
pnpm test:e2e -- inbox-hub*.spec.ts
```

Known CI note: Windows e2e is skipped for embedded Postgres; Linux CI remains
the required gate for integration and e2e behavior.

Current final-cutover evidence on `feat/inbox-hub-integration`:

- Focused Inbox Hub, Sidebar, registry, parity/materializer, and sidebar-badge
  tests passed.
- Focused UI and server typechecks passed.
- Full Vitest passed: 1254 files passed / 35 skipped; 10580 tests passed / 189
  skipped.
- Local Windows Playwright ran the repository sentinel only: 1 skipped. Linux CI
  remains the browser acceptance gate for the real `inbox-hub*.spec.ts` specs.
- Recursive `pnpm -r typecheck` and `pnpm build` were blocked locally by pnpm
  ignored-build-script approval state during dependency/prebuild resolution, not
  by observed TypeScript or test failures in the touched UI/server surfaces.

---

## 6. Branch Hygiene

- Keep the active workstream branch rebased on `origin/main`.
- Before starting a new workstream PR and before final PR review, run:
  - `git fetch origin`
  - confirm `origin/main` includes the prior workstream merge
  - rebase the active workstream branch onto `origin/main` if needed
  - inspect `git diff --name-only origin/main...HEAD`
- Commit each implementation task separately.
- Do not mix Mail implementation into the W5 PR family.
- Do not rename DB tables or API routes for UI naming changes.
- Preserve company scoping and RBAC checks in every route or client behavior.
- Keep docs updated when behavior, commands, or phase boundaries change.
- No dependency additions are expected for W5a. If a dependency becomes
  necessary, follow the current `AGENTS.md` dependency workflow and commit
  manifest and lockfile changes together when required.

---

## 7. Open Planning Items

These must be resolved inside the relevant implementation plan, not improvised
mid-task:

- W5: verify the exact first-adapter hook contract before any real runtime
  bridge implementation.
- W5: decide final timeout policy defaults per prompt kind before implementation.
- W5: keep allow-always scoped; never blanket-allow shell/runtime actions.

---

## 8. Next Step

Proceed through the next queue in order:

1. Review and approve the W5 runtime decision routing plan.
2. Execute W5a: durable runtime decisions, hub viewer, heartbeat broker,
   timeout/watchdog behavior, scoped trust rules, and test bridge e2e.
3. Execute W5b only after the first real adapter hook contract is proven.

Each next workstream needs its own investigate -> implementation plan -> review
-> build cycle before code starts.
