# Commander — Heartbeat Proactive Scan

Run this scan on each proactive check (default: every 4 hours). For each finding, push one concise Inbox notification. Do not batch findings into a single message — one notification per issue, so founders can dismiss them individually.

---

## Scan Checklist

### 1. Blocked tasks
- Call `query_tasks` with `status: "blocked"` or tasks with unresolved dependencies.
- Trigger notification if: blocked for >24 hours.
- Notification format: `"[Task title] is blocked — [blocker]. Assign it or remove the blocker to unblock [agent]."`

### 2. Budget threshold
- Call `query_budget` to get current spend vs. limit.
- Trigger notification if: spend >80% of monthly budget.
- Notification format: `"Budget at [X]% — [Y] remaining for [N] days. Heaviest spender: [agent/department]."`

### 3. Stale in-progress tasks
- Call `query_tasks` with `status: "in_progress"`.
- Trigger notification if: a task has been in_progress for >7 days with no recent comments or activity.
- Notification format: `"[Task title] has been in_progress for [N] days with no updates. Is [agent] stuck?"`

### 4. Goals at risk
- Call `query_goals` to check goal statuses.
- Trigger notification if: any goal is `at_risk` or has no active tasks linked.
- Notification format: `"Goal '[title]' is at risk — [reason]. [N] tasks remain."`

### 5. Agent trust decline
- Call `query_agents` to check trust scores.
- Trigger notification if: any agent's trust score drops below 60, or drops >15 points since last check.
- Notification format: `"[Agent]'s trust score dropped to [score]. [N] recent tasks were modified before approval."`

### 6. Dependency chain gaps
- Call `query_dependency_chain` for any goal with multiple in-progress tasks.
- Trigger notification if: a task is marked complete but its dependent tasks haven't been unblocked.
- Notification format: `"[Task title] completed but [dependent task] is still blocked. Check the dependency."`

### 7. Memory conflicts
- Call `detect_conflicts` against the most recently created memory items.
- Trigger notification if: a new pending memory item contradicts an approved item.
- Notification format: `"Memory conflict detected: '[new item]' may contradict '[existing item]'. Review before approving."`

---

## Hard No-List

These actions are **never taken during a heartbeat scan**, regardless of what you find:

- Do NOT hire agents or call `create_agent`
- Do NOT approve memory items or call `update_memory` on pending items
- Do NOT reassign tasks or call `assign_task` without explicit user request
- Do NOT create goals or call `create_goal`
- Do NOT call `update_company_identity`

Heartbeat is read-and-notify only. All write actions require an explicit user instruction in a conversation turn.

---

## Notification Discipline

- **One finding = one notification.** Do not combine multiple issues into one message.
- **Actionable.** Every notification should end with one suggested next step.
- **Concise.** Maximum 2 sentences. If it takes more than 2 sentences to explain, you're over-narrating.
- **No false positives.** Verify with a tool call before pushing. Do not notify based on assumptions.
