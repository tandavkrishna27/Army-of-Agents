---
title: Work with Commander
summary: Use Commander to inspect context, coordinate work, run skills, and trigger governed actions
---

Commander is Army of Agents' company-scoped coordination assistant. Use it when you want to ask about company context, plan work, inspect tasks, use skills, or trigger governed actions from a conversational cockpit.

Commander does not bypass company access, role permissions, approval gates, tool trust rules, memory visibility, or budget controls.

## When to use Commander

Use Commander to:

- ask questions about company work and context
- summarize tasks, discussions, goals, and memory
- plan the next set of tasks from a vague request
- invoke skills attached to Commander
- inspect your accountable work through the Cockpit
- trigger governed actions when your role allows them

## Start and verify Commander

<Steps>
  <Step title="Open Commander">
    Select Commander from the sidebar while the intended company is active.
  </Step>
  <Step title="Check runtime setup">
    If the selected runtime is not ready, follow the setup prompt to authenticate and verify the local CLI or configured provider path.
  </Step>
  <Step title="Send a small context question">
    Ask Commander to summarize the current company, open tasks, or your accountable work. This verifies streaming and context access before you ask it to take action.
  </Step>
</Steps>

Connection verification reports whether the configured runtime and authentication are usable. A successful sign-in does not grant Commander permissions beyond the authenticated operator context.

## Use the Cockpit

The Cockpit summarizes work accountable to the current user:

- **Mine**: work directly assigned or accountable to you
- **Managed**: work in your human and agent responsibility hierarchy
- **Awaiting review**: work that expects your review

If one source fails, Commander marks the result partial instead of presenting an all-clear state.

## Compose a useful turn

Good Commander requests include the outcome, scope, and constraints.

```txt
Review the current discussion about onboarding, propose the next three tasks, and keep them scoped to the CLI quickstart. Do not create tasks yet.
```

The composer supports:

- `@` mentions for company agents
- `/` skill tokens or skills selected from the add menu
- up to five supported attachments
- retry, edit, and discard after a failed request

Plain text, Markdown, and JSON attachments can contribute text to the runtime turn. Images and PDFs are stored but are not currently shown to the model.

## Tools, permissions, and trust

Commander tools remain company-scoped and pass normal role and entity checks. Governed actions can stop for confirmation. Tool permissions determine which capabilities are available; trust rules can remember an approved decision for eligible repeated actions.

Review or remove trust rules when the operating boundary changes.

<Warning>
  Treat trusted Commander actions like product permissions. If the context, role, or workflow changes, remove old trust rules and approve the action again.
</Warning>

## Questions, review, and completion

Agent questions, review requests, task state, and run completion are separate concepts:

- a work question can appear in Commander, Inbox, Task Work, Workspace, or its source Discussion
- answering a question can request continuation of parked work
- a technically completed run does not automatically mean the task is complete
- review and acceptance follow the task's assigned reviewer and completion policy

Use **Awaiting review** for accountable review work. Check the task and its output before inferring completion from a streamed Commander response.

## Troubleshooting

<AccordionGroup>
  <Accordion title="Commander cannot use a skill">
    Confirm the skill is installed, attached to Commander where required, and allowed by the current tool manifest.
  </Accordion>
  <Accordion title="Commander cannot see expected context">
    Check company selection, role permissions, page context, department context, and memory visibility.
  </Accordion>
  <Accordion title="A tool action asks for approval">
    This is expected for governed actions. Review the proposed action and approve only when the scope is correct.
  </Accordion>
</AccordionGroup>

## Related docs

<CardGroup cols={2}>
  <Card title="Company Brain" href="/guides/board-operator/company-brain">
    Understand the memory context Commander can use.
  </Card>
  <Card title="Commander API" href="/api/internal-agent">
    Review request and stream contracts.
  </Card>
</CardGroup>
