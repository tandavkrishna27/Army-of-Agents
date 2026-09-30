---
title: Memory Explorer
summary: Search, review, scope, and maintain Company Brain memory
---

Memory Explorer is the UI for maintaining Company Brain context. Use it to search approved memory, review suggestions, upload useful knowledge, inspect graph relationships, and keep stale knowledge out of future agent runs.

## When to use Memory Explorer

Use Memory Explorer when you need to:

- find what Commander or agents may know
- approve, reject, or edit memory suggestions
- upload durable company knowledge
- inspect relationships between memory items
- diagnose why context did or did not appear in an agent run

The canonical route is `/memory/explore`; `/memory` redirects there.

## Explorer layout

Memory Explorer has three resizable areas:

- **Folder and tree rail** for scopes, layers, shortcuts, and local folder browsing
- **List pane** for search results, pending items, uploads, and selected collections
- **Tabbed viewer** for item detail, assets, graph view, backlinks, and open/recent context

Shortcuts include Home, Pinned, Pending Review, Recent, and Archived.

## Memory layers

| Layer | Meaning | Good examples |
| --- | --- | --- |
| Identity | Company-wide identity, mission, values, and durable facts | positioning, values, customer promise |
| Domain | Department-scoped operating knowledge | support playbook, engineering conventions |
| Active Context | Goal or project-scoped temporary context | launch constraints, current sprint priorities |
| Working | Task-chain-scoped ephemeral context | discoveries from the current task chain |

Working memory is short-lived and can be archived by lifecycle jobs. Identity and domain memory should be reviewed carefully because they may guide many future runs.

## Review pending memory

<Steps>
  <Step title="Open Pending Review">
    Use the top shortcut to see suggestions from agents, discussions, uploads, or other write paths.
  </Step>
  <Step title="Read the source">
    Open the related task, discussion, file, or run when available.
  </Step>
  <Step title="Edit for durability">
    Convert noisy prose into a clear fact, instruction, or operating rule.
  </Step>
  <Step title="Choose layer and scope">
    Pick the narrowest layer, department, project, goal, or task-chain scope that still helps future work.
  </Step>
  <Step title="Approve, reject, or archive">
    Approve only context that should influence future Commander or agent behavior.
  </Step>
</Steps>

## Search and embeddings

Semantic search uses embeddings. If embeddings are unavailable, Memory Explorer shows a warning and links to **Settings → Memory**.

The OpenAI key configured there is for embeddings only. Extraction is CLI-only and does not use this key.

## Uploads, files, and folders

The list pane supports scoped search, upload where allowed, new memory items, view modes, subfolder navigation, and per-item re-index.

The Local tree can browse the configured company root folder or home path.

## Graph and backlinks

Use graph and backlink views before approving long-lived memory. They help you see whether an item duplicates existing knowledge, contradicts an older item, or belongs under a narrower scope.

## How to verify it worked

After you approve or edit memory:

- it appears in the expected layer and scope
- Pending Review no longer shows it as unresolved
- search can find it after indexing
- Commander or an eligible agent can use it only when visibility rules allow it

## Troubleshooting

<AccordionGroup>
  <Accordion title="A useful item is missing from search">
    Check indexing status, embeddings configuration, archive state, and whether the item is scoped away from your current view.
  </Accordion>
  <Accordion title="An agent did not use memory I expected">
    Check actor visibility, scope, task/project/department match, and whether the item is approved rather than pending.
  </Accordion>
  <Accordion title="Memory is getting noisy">
    Reject one-off suggestions, narrow scopes, merge duplicates, and rewrite approved entries as durable facts or rules.
  </Accordion>
</AccordionGroup>

## Related docs

<CardGroup cols={2}>
  <Card title="Company Brain" href="/guides/board-operator/company-brain">
    Understand the operating model behind memory.
  </Card>
  <Card title="Commander" href="/guides/board-operator/commander">
    Learn how Commander uses visible company context.
  </Card>
</CardGroup>
