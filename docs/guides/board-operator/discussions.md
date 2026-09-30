---
title: Discussions
summary: Use threads to capture ideas, extract scope, create tasks, and keep Crew results connected
---

Discussions is the Army of Agents workspace for unstructured company context. Use it for ideas, meeting notes, transcripts, documents, customer feedback, planning threads, and agent output that is not yet a clean task.

## When to use Discussions

Use Discussions when:

- the input is messy or still being shaped
- several people or agents need to add context before work starts
- you want Crew to propose tasks from a thread
- you want decisions and execution results connected to the source conversation
- incoming material should be reviewed before it becomes Tasks or Memory

The route is `/discussions`. Legacy `/briefs` and `/debriefs` paths redirect here.

## Workspace layout

Discussions has:

- a thread rail for searching, creating, archiving, and reopening threads
- a Home overview for recent and grouped discussion work
- thread detail for posts, replies, attachments, scope cards, and linked outputs
- viewer tabs for thread content, files, artifacts, and selected items

Threads can move through groups such as Unlisted, Discuss, Scope, Assign, Done, and Archived.

## Turn a discussion into work

<Steps>
  <Step title="Create or open a thread">
    Start with a clear title and add the idea, transcript, note, or document. Include goals, constraints, and examples if you already know them.
  </Step>
  <Step title="Add enough context">
    Good scope drafts need concrete details. Add decisions, relevant files, desired outcome, acceptance criteria, and what should not happen.
  </Step>
  <Step title="Ask Crew to scope">
    Create a scope draft. Army of Agents extracts useful items and turns them into candidate task cards.
  </Step>
  <Step title="Review cards before accepting">
    Edit titles, descriptions, assignees, departments, projects, and acceptance criteria. Reject cards that are speculative or duplicate existing work.
  </Step>
  <Step title="Dispatch according to autonomy">
    Manual mode waits for you. Assist mode asks for dispatch approval. Drive mode dispatches when preflight checks pass.
  </Step>
  <Step title="Watch loopback">
    Crew-originated work stays linked to its source thread. Results, failure cards, and task links help the discussion remain the narrative record.
  </Step>
</Steps>

## Unlisted intake

Unlisted items are inbound material that has not become a normal thread yet. Convert useful material into a thread, or dismiss material that should not enter the operating system.

## Attachments

Posts and replies use the shared composer for drafts, mentions, attachments, and replay-safe retries. Thread entries can carry assets or artifacts, and the viewer can open linked files and selected item detail.

## How to verify it worked

After a discussion becomes work, check that:

- the source thread has the expected scope cards or linked tasks
- accepted cards created Tasks with the right assignee and scope
- Assist-mode dispatch requests appear in Inbox when required
- Crew results or failure cards point back to the originating thread
- any memory candidates are pending review instead of silently approved

## Troubleshooting

<AccordionGroup>
  <Accordion title="The scope draft is too vague">
    Add a clearer desired outcome, examples, constraints, and acceptance criteria, then create a new draft.
  </Accordion>
  <Accordion title="No tasks were dispatched">
    Check autonomy mode. Manual proposes only, Assist waits for approval, and Drive still respects budget, pause, and preflight checks.
  </Accordion>
  <Accordion title="A thread has too many unrelated topics">
    Split the work into separate threads. Clear source boundaries produce better task cards and memory candidates.
  </Accordion>
</AccordionGroup>

## Related docs

<CardGroup cols={2}>
  <Card title="Crew" href="/guides/board-operator/crew">
    Learn how Crew scopes and dispatches discussion work.
  </Card>
  <Card title="Company Brain" href="/guides/board-operator/company-brain">
    Review memory candidates that come from discussions.
  </Card>
</CardGroup>
