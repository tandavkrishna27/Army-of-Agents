---
title: Work with Commander
summary: Use Commander's cockpit, conversations, context, skills, files, and governed actions
---

Commander is AoA's company-scoped coordination assistant. It can inspect company context, help organize work, and use governed tools through a streamed conversation. Commander does not bypass company access, role permissions, approval gates, or tool trust rules.

## Start and Verify Commander

Open **Commander** from the sidebar. If the selected CLI is not ready, use the
setup prompt to authenticate and verify the connection. The onboarding UI offers
interactive sign-in for Codex; Claude currently uses the API-key path because
its paste-code login bridge is not implemented there. The server API supports
founder board users starting or cancelling either Anthropic or OpenAI login
challenges, as well as saving the corresponding Commander credential.
Challenges and credentials are company-scoped.

Connection verification reports whether the configured CLI and authentication are usable. A successful sign-in does not grant Commander permissions beyond those of its authenticated operator context.

## Use the Cockpit

The Cockpit summarizes work accountable to the current user:

- **Mine**: work directly assigned or accountable to you
- **Managed**: work in your human and agent responsibility hierarchy
- **Awaiting review**: work that expects your review

Cockpit sections are independently bounded. If one source fails, Commander marks the result partial instead of presenting an all-clear state.

## Manage Conversations

Create separate conversations for separate work streams. You can rename, pin, archive, delete, and drag conversations into a manual order. Resetting the order returns unpinned conversations to recency grouping.

Commander persists user, assistant, and tool messages. Long histories may be summarized for context management. Page and department context can be included with a turn; choose the narrowest useful context to reduce noise.

## Compose a Turn

The Commander composer supports:

- `@` mentions for company agents
- `/` skill tokens or skills selected from the add menu
- up to five supported attachments
- Retry, Edit, and Discard after a failed request

Plain text, Markdown, and JSON attachments can contribute up to 32 KB of text to the runtime turn. Images and PDFs are stored but are not currently shown to the model. Attachment content is not copied into the persisted user-message row. See [Compose messages and comments](composer.md) and [Commander attachment runtime](../../architecture/commander-attachment-runtime.md).

## Tools, Permissions, and Trust

Commander tools remain company-scoped and pass normal role and entity checks. Governed actions can stop for confirmation. Tool permissions determine which capabilities are available; trust rules can remember an approved decision for eligible repeated actions. Review or remove trust rules in Commander settings when the operating boundary changes.

Skills are inserted as readable tokens and expanded only on send. The generated tool manifest is the source of truth for the current Commander tool catalog; do not rely on a hand-maintained tool count.

## Questions, Review, and Completion

Agent questions, review requests, task state, and run completion are separate concepts:

- A work question remains durable and can appear in Commander, Inbox, Task Work, a workspace, or its source Discussion.
- Answering a question can request continuation of the parked work.
- A technically completed run does not automatically mean the task is complete.
- Review and acceptance follow the task's assigned reviewer and completion policy.

Use the Cockpit's **Awaiting review** queue for accountable review work. Check the task and its output rather than inferring completion from a streamed Commander response.

For request and stream details, see the [Commander API](../../api/internal-agent.md).
