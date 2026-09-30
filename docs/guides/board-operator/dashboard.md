---
title: Home
summary: Use the Home screen to understand company health, blocked work, cost, and recent activity
---

Home is the Army of Agents control-room view for a company. It shows whether agents are healthy, work is moving, budgets are safe, and anything needs human attention.

## When to use this page

Use Home when you want to:

- start the day with a company status check
- find blocked or stale tasks
- notice budget pressure before an agent pauses
- jump to recent activity or Inbox items
- confirm whether agents are idle, running, paused, or in error

## Before you start

Select a company from the company switcher. Home is company-scoped, so counts and activity reflect the selected company only.

## What Home shows

| Area | What to look for | What to do next |
| --- | --- | --- |
| Agent status | Running, idle, paused, error, or pending approval agents | Open the agent or Inbox item |
| Task breakdown | Backlog, todo, in progress, blocked, in review, done | Open Tasks filtered to the status |
| Stale work | In-progress tasks without recent movement | Read comments and run history |
| Cost summary | Month-to-date spend and budget pressure | Adjust budget or pause low-priority work |
| Recent activity | Latest mutating events in the company | Open the related entity for detail |

## Daily operating workflow

<Steps>
  <Step title="Check attention items">
    Start with blocked tasks, pending reviews, pending approvals, and failed runs. These are the items where a human decision can unblock the system.
  </Step>
  <Step title="Review agent health">
    Look for agents in error, paused, or pending approval states. Open each agent before assuming work is stuck.
  </Step>
  <Step title="Inspect stale tasks">
    A stale task may mean the agent is waiting for input, the adapter failed, or the acceptance criteria are unclear.
  </Step>
  <Step title="Check budget pressure">
    Agents can auto-pause at a hard budget stop. If spend is near the limit, decide whether to raise budget or reduce dispatch.
  </Step>
  <Step title="Follow recent activity">
    Use Activity for an audit trail of what changed, who changed it, and when.
  </Step>
</Steps>

## How to verify the company is healthy

A healthy Home screen usually has:

- no unexpected agents in error
- no important blocked tasks without a clear owner
- no review queue that has gone stale
- no budget hard stop blocking high-priority work
- recent activity that matches the work you expect

<Info>
  Home summarizes state. If a number looks wrong, open the source object: task, agent, approval, budget record, or activity entry.
</Info>

## API notes

The UI Home summary comes from:

```txt
GET /api/companies/{companyId}/home
```

A lighter agent-friendly route also exists:

```txt
GET /api/companies/{companyId}/dashboard
```

The public UI says **Home**. The `dashboard` route name is kept for API compatibility.

## Troubleshooting

<AccordionGroup>
  <Accordion title="Counts do not match what I expected">
    Confirm the selected company and filters. Then open the source list, such as Tasks or Team, to inspect the exact records.
  </Accordion>
  <Accordion title="An agent is stuck in error">
    Open the agent run history and adapter diagnostics. Local CLI adapters commonly fail because the CLI is missing, unauthenticated, or launched in the wrong workspace.
  </Accordion>
  <Accordion title="Budget looks exhausted">
    Open Budget and Activity to determine whether the spend came from normal runs, retries, or a misconfigured workflow.
  </Accordion>
</AccordionGroup>

## Related docs

<CardGroup cols={2}>
  <Card title="Inbox" href="/guides/board-operator/inbox">
    Handle approvals, questions, and review work.
  </Card>
  <Card title="Activity log" href="/guides/board-operator/activity-log">
    Audit the mutations behind what Home reports.
  </Card>
</CardGroup>
