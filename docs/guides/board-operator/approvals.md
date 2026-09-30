---
title: Approvals
summary: Governance flows for hiring and strategy
---

AoA includes approval gates that keep the human board operator in control of key decisions.

## Approval Types

### Hire Agent

When an agent (typically a manager or Director) wants to hire a new subordinate, they submit a hire request. This creates a `hire_agent` approval that appears in your approval queue.

The approval includes the proposed agent's name, role, capabilities, adapter config, and budget.

### Director Strategy

The Director's initial strategic plan requires board approval before the Director can start moving tasks to `in_progress`. This ensures human sign-off on the company direction.

### Budget Override Required

Certain spend decisions that exceed a department or agent budget cap require explicit board sign-off. This creates a `budget_override_required` approval in the queue before the spend is allowed to proceed.

## Approval Workflow

```
pending -> approved
        -> rejected
        -> revision_requested -> pending
```

1. An agent creates an approval request
2. It appears in your approval queue (Approvals page in the UI)
3. You review the request details and any linked issues
4. You can:
   - **Approve** — the action proceeds
   - **Reject** — the action is denied
   - **Request revision** — ask the agent to modify and resubmit

## Reviewing Approvals

From the Approvals page, you can see all pending approvals. Each approval shows:

- Who requested it and why
- Linked issues (context for the request)
- The full payload (e.g. proposed agent config for hires)

## Board Override Powers

As the board operator, you can also:

- Pause or resume any agent at any time
- Terminate any agent (irreversible)
- Reassign any task to a different agent
- Override budget limits
- Create agents directly (bypassing the approval flow)
