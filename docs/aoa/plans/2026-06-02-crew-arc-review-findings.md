# Crew Arc — Staff Review Findings & Fix Disposition

Adversarial review of the full crew arc (`HEAD~118..HEAD`, 5 domains, 106 source files). Architecture sound; XSS clean; cross-company isolation clean; A1–A5 + scope + routing + reactive chat fixes all verified correct & tested. Findings below are the deltas. User chose: **fix everything incl. LOW nits.**

## Disposition table

| # | Sev | File | Finding | Fix | Status |
|---|-----|------|---------|-----|--------|
| 1 | CRITICAL | server/src/routes/issues.ts:356 `enqueueIssueCommentWakeups` | Comment-driven crew wakeups silently dropped (raw `heartbeat.wakeup`, no kind check); PATCH path at :1197 is kind-aware | Route the wakeup loop through `resolveAgentKinds`→`enqueueAoaMentionWakeup`/`heartbeat.wakeup` | ☐ |
| 2 | HIGH | server/src/services/issue-agent-status-guard.ts | Ownership enforced only for in_review/done; crew agent can move any non-owned task to cancelled/backlog | Enforce `assigneeAgentId===actor` for ALL agent status moves | ☐ |
| 3 | HIGH | ui/src/pages/ActiveAgents.tsx:55 | Live Agents page fetches tasks org-only → crew live run shows raw UUID not title | `taskScope:'all'` + distinct `scope-all` key (mirror ActiveAgentsPanel) | ☐ |
| 4 | MED | server/src/services/internal-agent/tools/attach-task-artifact-tool.ts | No ownership check → crew agent overwrites artifactId on non-owned task | Gate on task ownership | ☐ |
| 5 | MED | server/src/services/issues.ts:2342 `staleCount` | Omits `notCrewAssigned` → stuck crew task inflates founder org Inbox badge | Add `notCrewAssigned(companyId)` | ☐ |
| 6 | MED | controller-adjutant-runner.ts / thread-orchestration.ts | Dial-as-experience enforced at single gate (fragile) | Cheap dial re-check (defense-in-depth) | ☐ |
| 7 | MED | server/src/routes/discussions.ts:170 | create→`processMentions` route dispatch untested | Add route-level test | ☐ |
| 8 | MED | server/src/services/inbox-producer.ts:63 | Dedup key is content-hash → silent-drops identical re-sends; schema comment misleading | Correct comment / document collision semantics | ☐ |
| 9 | MED(refuted) | crew-board-filter.test.ts | "crew-org-scope.integration.test.ts missing" | **FALSE POSITIVE** — file exists (11 real-row tests, Linux-gated) | ✅ refuted |
| L1 | LOW | ui/src/components/crew/CrewTaskAuditCard.tsx | Retired dead component + test | Delete | ☐ |
| L2 | LOW | dispatcher.ts:601 | `effectiveAutonomy` spread BEFORE payload → future footgun | Spread payload first, then effectiveAutonomy | ☐ |
| L3 | LOW | server/src/services/issue-assignee-wakeup.ts | Crew wakeup branch un-wrapped (org path has `.catch`) | Wrap crew branch best-effort | ☐ |
| L4 | LOW | packages/shared/src/types/issue.ts:89 | `originKind` doc says crewBoard-only but always returned | Reword comment | ☐ |
| L5 | LOW | server/src/services/discussions.ts:135 `emitEntryCreatedSideEffects` | Crew-mention lookup runs for non-human entries (wasted query) | Short-circuit when not human | ☐ |
| L6 | LOW | reconcile-autonomy-scale.ts:24 | Only clamps >2; no 1→0/2→1 remap (stale-data soft fail-open) | Verify no 1-based data; fix comment or add remap | ☐ |
| L7 | LOW | aoa-trigger-prompt.ts / EntryRow.tsx | systemNotice suppression prompt-only | (optional) server-side strip for adjutant conversational posts | ☐ |
| L8 | LOW | server/src/services/discussions.ts:457 `create()` | First entry seq=0 (catch-up `gt(seq,0)` skips it) | Assign seq=1/entrySeq=1 | ☐ |
| L9 | LOW | inbox-attach-to-thread.ts:122 | suggest-path lacks `escalated` first-writer guard | Add guard | ☐ |
| L10 | LOW | ui/src/api/heartbeats.ts:21 | Heartbeat-only fields non-optional but crew leaves undefined | Mark optional | ☐ |
| L11 | LOW | ui/src/context/LiveUpdatesProvider.tsx:781 | `unsubscribeThread` doesn't clear `workingAgentsByThread` | Mirror presence delete | ☐ |
| L12 | LOW | ui/src/components/KanbanBoard.tsx:579 | 1 Hz ticker re-renders whole board | Memoize cards / scope ticker | ☐ |
| L13 | LOW | ensure-engineer.ts:68 | Maker→Engineer rename can hit unique constraint if both rows exist | Guard the rename | ☐ |

## Fix status (commits on feat/thread-chat-experience)
- ✅ #1 `e92666bc9` · ✅ #2/#4 `ec736fc58` · ✅ #3 `1a04f89b8` · ✅ #5/L4 `c756fb92d` · ✅ L1/L10/L11/L12 (ui-nits commit)
- ⏳ #6, #7, #8, L2, L3, L5, L6, L8, L9, L13 — server-nits batch (in progress)
- #9 refuted (false positive) · L7 intentionally left prompt-level (server strip risks over-stripping)

## VERIFIED CORRECT (no action)
XSS clean · cross-company event isolation clean · scope fail-safe default + predicate SQL + per-consumer classification + distinct cache keys + card gating · A1–A5 dispatch hardening · routing atomic-claim/fail-closed/cross-tenant · BUG-1/BUG-2/follow-up/systemNotice/de-dup · Decision #100 · Drizzle-only migrations · seeding idempotency · marketplace-rename safety · company-portability all-scope.
