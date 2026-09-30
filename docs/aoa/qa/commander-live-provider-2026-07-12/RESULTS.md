# Commander Live-Provider E2E Results

**Date:** 2026-07-12
**Instance:** `commander-live-provider`
**Review URL:** `http://127.0.0.1:3202/HAR/commander`
**Company:** Harbor Launch Studio (`HAR`)
**Overall:** `FAIL` - real providers and the structured question work, but the full task-to-review lifecycle is not production-ready.

## Scenario summary

| Scenario | Result | Evidence |
|---|---|---|
| Fresh isolated company | PASS | New DB, company, department, project, two humans, one Claude agent, and one Codex agent on port 3202. The synthetic instance on 3201 was not reused. |
| Provider readiness | PASS | Supported environment probes returned live responses for `claude_local` and `codex_local`. |
| Real Discussion and tasks | PASS | Discussion `Choose the first customer segment`; HAR-1, HAR-2, and HAR-3 were created through supported APIs with source context and acceptance criteria. |
| Claude structured question | PASS | Maya created a real `work_question`; the answer was submitted through Inbox UI and relayed into the same live run. |
| Commander question visibility | PARTIAL | The question appeared in Commander Triage with useful context, but the center empty state still said everything was fine. Clicking once opened an empty viewer home instead of the question. |
| Question synchronization | FAIL | Task Work/execution workspace did not expose the actionable question. Hub ownership routed to Priya even though the task named `local-board` as responsible user and reviewer. |
| Claude supervised execution | FAIL | Nine routine approvals consumed the run lifetime. HAR-2 wrote a real 6.7 KB plan, but the 600-second run timed out before review transition. |
| AoA MCP task access | FAIL | `ask_founder` worked, but `upsert-task-document` and `get-task-document` returned `Task not found`; `list-tasks` returned an empty list for Maya's active assigned task. |
| Automatic continuation | FAIL | A comment-triggered continuation received only `Continue your AoA work`, lost task context, searched upward for config, and attempted to inspect `.env`/AoA environment values. Those permissions were denied and the run was cancelled. |
| Review-required lifecycle | BLOCKED | Neither Claude task could reach `in_review`, so Awaiting Review, task slide-over review, and human acceptance could not be validated honestly. |
| Codex bounded task | BLOCKED | Startup plugin sync hit Windows path-length errors. The first approved workspace listing then failed in app-server; the run produced no useful task output and was cancelled. |
| Commander explanation | BLOCKED | Persisted work was incomplete/inconsistent, so judging Commander retrieval would have rewarded a broken source state. |

## Real lifecycle

### HAR-1 - customer segment recommendation

- Task: `0da52a6a-c1ac-4da3-babf-726a4b961c31`
- Initial Claude run: `ad5e6648-678e-4f50-8b74-6d9ba21d2e97`
- Question: `345df3a2-08cf-4cb0-9dd0-1d8bf41f8a7a`
- Founder answer: Boutique agencies
- Outcome: answer relayed, then the process timed out at 300 seconds before output/review.
- Continuation: `2759a99d-4cca-42a9-84bf-e8a09936c5a0`; cancelled after context loss and unsafe upward environment discovery.

### HAR-2 - boutique agency interview plan

- Task: `f8c7ac0d-12b6-44fb-ad4e-2ec4cbc66569`
- Claude run: `6a1db946-7850-4b47-9aaf-14ad003a1b70`
- Question: `5ffcd90e-9ad4-4fed-8072-b297e20df0c2`
- UI answer: Founder-led
- Workspace output: `.aoa-qa/live-provider-20260712/workspaces/harbor/maya/boutique-agency-interview-plan.md`
- Outcome: useful real artifact created; MCP could not see the task; run timed out at 600 seconds; task remains `in_progress`.

### HAR-3 - validation tracker

- Task: `558018c5-dd42-4dec-902d-dbd3381313b9`
- Codex run: `461ff1b2-03a0-49e6-bd5d-5200646badfc`
- Outcome: startup/plugin failures and app-server command failure; cancelled with no artifact; task remains `in_progress`.

## Highest-priority product findings

1. **Make waiting time pause the run timeout.** Human questions and supervised permissions must not consume the model execution budget.
2. **Give agent MCP the same scoped active task the REST heartbeat supplied.** The current bridge supports `ask_founder` but cannot read/update the assigned task, so end-to-end work cannot complete.
3. **Preserve task context in continuations.** Resume prompts need task, answer, source Discussion, workspace, and remaining steps. Never encourage workspace discovery through parent config/environment inspection.
4. **Fix Commander truthfulness.** Any open question, failed run, blocked task, or active work must suppress the “Everything looks good” empty state.
5. **Unify the item-open interaction.** A Commander triage card should open its actionable viewer on the first click without collapsing the cockpit or showing viewer Home.
6. **Route questions from task ownership fields.** Explicit recipient, responsible human, and reviewer must beat the agent's reporting manager.
7. **Make safe internal reads ergonomic.** Trusted, company-scoped AoA reads should not require a separate shell approval each time; mutating or external actions should remain governed.
8. **Harden Codex startup on Windows.** Avoid full curated-plugin checkout in every run and eliminate path-length-sensitive startup work.

## Browser evidence

- `commander-final.png` shows the final contradictory state: timed-out Maya update and three active tasks beside the “Everything looks good” center message.
- The fresh app is intentionally left running at the review URL above.
