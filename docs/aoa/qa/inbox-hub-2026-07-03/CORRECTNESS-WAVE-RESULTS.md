# Inbox Correctness Wave — Execution Results (2026-07-04)

Plan: `docs/aoa/plans/2026-07-04-inbox-correctness-wave-plan.md`. Investigation: `ROOT-CAUSE-INVESTIGATION.md`. Founder decisions: Decision #107. Executed subagent-driven (batched by file-independence), Claude staff-eng plan review (3 P1s folded; Codex was rate-limited).

## Commits (feat/inbox-hub-tabbed)
| Task | Commit | What |
|---|---|---|
| 6 | `2b687d970` | crew gate: explicit authorization overrides the dial (payload-keyed, both dispatch paths) |
| 3 | `8502c9d69` | Approvals removed from primary nav; /approvals routes kept |
| 1 | `864e29667` | mirror-model lifecycle guard (R3+H1); recordAndAct dead code removed |
| 9 | `60d1987d7` | suggestion dedupe: stable patternId + partial-unique index w/ pre-index collapse |
| 4 | `b13c0d7e3` | run teardown: win32 tree-kill + terminal-status latch + zombie-decision guard |
| 5 | `1712345a5` | work_question: honest 409 on dead-run answer + stranded-answer sweeper |
| 2 | `77ac7878b` | dismissed/snoozed "N hidden" chip (dismiss-hole safety net) |
| 7 | `70b50c176` | run-tab producer relatedEntity + hire in-tx emit + Needs-you-most |
| 8 | `24075ac75` | budget_alert reconciler closes on normalized spend + heals in place |
| 10 | `f24768da4` | build extraction_failed + routine-failure; prune 2 dead types; hide legacy_other |
| 11 | `911e9d9d4` | Decision #107 + honest proactive-scheduler note |
| 12 | `bb5d7517a` | wave integration fixes (badges best-effort reconcile + stale test mocks) |

## Suite: 11,330 passed / 221 skipped / 0 failed (full workspace).

## Live-verified on qa-inbox-e2e (:3399, migration 0164 applied on real data):
- **D107.2 Approvals nav removed** — sidebar = [Home, Inbox, Commander, Discussions, Tasks, Crew Board, Agents, …]; **/QAL/approvals/:id still 200** (routes kept).
- **D107.1 mirror model** — approval_request reading pane hides Resolve/Archive, keeps Dismiss/Snooze/Open-full; POST archive on a pending approval item → **409**; dismiss → allowed.
- **Task 2 dismiss chip** — dismiss → "**1 hidden**" chip in the waiting-lane header; hidden-count API `{"hiddenOpen":1}`.
- **H3 budget reconciler** — at 154% over-budget the item stays **open + heals summary in place** ("154.68% used (13921/9000 cents)"); at budget=0 it **archives**.
- **H5a run tab** — fresh run_complete item carries `relatedEntityType=agent, relatedEntityId=agentId` → the Run viewer (previously 100% unreachable) opens.
- **H4 dedupe migration** — `0164` applied cleanly on the live DB (dedupe_key column + partial unique index created; pre-index collapse-DML ran — no crash despite the pre-existing dup pair; IF NOT EXISTS added for idempotency).

## Unit/integration-verified (not driven live, strong coverage):
R1 zombie teardown (393 server tests + latch), R2 stranded-answer sweeper, Task 6 crew dispatch at Manual (dispatcher suite), extraction_failed + routine_outcome producers (Task 10), the mirror 409 across both source classes.

## Still deferred (Decision #107): work_question adapter caller (agents can't yet ask a product question in-run); reminder + proactive schedulers (1.1); BUG-6 codex empty turn (separate).
