# Commander Real-Life E2E Report

Date: 2026-07-11
Branch: `codex/commander-cockpit`
Review application: `http://127.0.0.1:3201/NOR/commander`

## Acceptance result

The current Commander entity-opening contracts work:

- Review and active-work task rows open the canonical task slide-over and keep the Commander URL.
- Discussion rows open the dedicated Discussion work pane with Thread, Scope, and Branches.
- Inbox rows open actionable Hub detail in the Commander viewer.
- The authenticated agent completion policy is enforced before the task reaches Commander.
- A review-required agent task rejects `done`, accepts `in_review` when a human review path exists, materializes the responsible human as reviewer, and appears under Awaiting Review.
- An `agent_can_complete` task can reach `done` only when acceptance criteria exist.

## Persistent review company

The isolated Northstar Operations company was created on a fresh embedded PostgreSQL instance. Its complete cockpit response contained:

| Surface | Count |
| --- | ---: |
| Running now | 1 |
| Active work: Mine | 1 |
| Active work: Managed | 4 |
| Awaiting review | 3 |
| Sticky notes | 1 |
| Inbox | 3 |
| Discussions | 1 |
| Approvals | 2 |
| Pinned | 3 |
| Goals at risk | 1 |
| Done today | 1 |
| Proactive findings | 1 |
| Teammate activity | 1 |

The cockpit response reported `partial: false`.

## Browser journeys

1. Opened `NOR-9`, an authenticated Atlas submission. It opened the task slide-over with Approve and Request Changes, Overview/Work/Comments/Sub-tasks/Activity tabs, and the Commander URL remained unchanged.
2. Opened Launch readiness working session. It opened a dedicated Discussion pane with the real thread composer and native Thread/Scope/Branches tabs.
3. Opened Commander source audit needs attention. It opened the Inbox/Hub viewer with Dismiss, Snooze, Resolve, and Archive actions.
4. Opened View all Managed. It navigated away from Commander to the Tasks page, exposing a product defect described below.

No browser console errors were present after returning to Commander.

## Findings

### P1: View all Managed leaves Commander

The agreed Commander behavior was in-place expansion. The current button navigates to `/NOR/issues?cockpitBucket=managed`, replacing the Commander workspace. This breaks the triage flow and should become an in-cockpit expanded queue or sheet.

### P1: Empty-state message contradicts cockpit attention

The center panel says `Everything looks good! No issues detected in the last 24 hours.` while the same screen has three unread Inbox items, three awaiting-review tasks, two pending approvals, and one running agent. The greeting must derive from the same attention model as the cockpit or use neutral copy.

### P2: Inbox viewer action text clips at the tested desktop width

The disabled Ask Commander to weigh in action was visibly clipped in the viewer toolbar. The action row needs wrapping, an overflow menu, or icon-first compact controls.

### P2: Approval cards lack useful context and duplicate similar labels

Both seeded approvals render as `approve ceo strategy`, and their Inbox mirrors render as `Review approve ceo strategy approval`. The underlying lifecycle is real, but the user cannot identify the requested decision without opening it. Approval cards should show the payload title, linked task, requester, and concise reason.

### Existing test gap: legacy Inbox fixture is stale

The pre-existing `cockpit inbox rows open actionable Hub detail without navigating` Playwright test did not find its directly inserted `Commander run completed` fixture. The real API-backed Inbox item opened correctly in manual browser verification. The old test fixture should be converted to a supported producer/API so reconciliation cannot remove or ignore it.

## Automated evidence

- New Playwright lifecycle spec: 1 passed.
- Existing focused Commander Playwright contracts: task slide-over, work categorization, and Discussion pane passed.
- Focused unit/integration suite: 77 passed across completion guard, reviewer resolution, cockpit classification, cockpit cards, and cockpit panel.
- Workspace typecheck: passed across all packages.

The full focused Playwright batch was not all green because the legacy Inbox fixture test above failed. This is reported as a test/data setup defect, not hidden as a successful run.
