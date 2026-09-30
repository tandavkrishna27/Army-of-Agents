---
title: Public docs style guide
summary: How to write public Army of Agents documentation for Mintlify
---

This guide keeps the public Army of Agents docs useful, accurate, and easy to scan. Use it for every page that appears in `docs/docs.json`.

## Documentation principles

- **Start with the reader's job.** Explain what the reader is trying to accomplish before explaining product internals.
- **Write from shipped behavior.** Verify every claim against source code, `CLAUDE.md`, `AGENTS.md`, or a current product doc. If something is planned, label it as planned.
- **Use public names first.** Write “Army of Agents” on first use, then “AoA”. Use UI labels such as Home, Task, Discussion, Team, Budget, and Commander in operator docs.
- **Keep wire names where they matter.** API docs may mention route names such as `/issues` because the wire contract uses that name, but explain that the UI calls them Tasks.
- **Show the next step.** Every guide should end with links to the next useful page.

## Page types

### Tutorial

Use tutorials when the reader should reach a concrete result.

Required sections:

1. What you will build or verify
2. Prerequisites
3. Steps
4. Expected result
5. Troubleshooting
6. Next steps

### How-to guide

Use how-to guides for repeatable operating tasks.

Required sections:

1. When to use this page
2. Before you start
3. Steps
4. How to verify it worked
5. Troubleshooting
6. Related docs

### Reference

Use reference pages for exact contracts.

Required sections:

1. Purpose
2. Authentication and permissions
3. Request shape or configuration fields
4. Response or output shape
5. Errors and edge cases
6. Examples
7. Related workflows

### Explanation

Use explanation pages for product concepts and architecture.

Required sections:

1. What problem this solves
2. How Army of Agents models it
3. The main objects and relationships
4. Safety or governance boundaries
5. Links to tutorials and how-to guides

## Mintlify components

Use Mintlify components when they reduce reading effort:

- `Steps` for installation, onboarding, and operational workflows
- `Tabs` for local, Docker, and production variants
- `CardGroup` for navigation choices
- `Info`, `Warning`, and `Check` callouts for constraints and verification
- Mermaid diagrams for architecture and workflows when the relationship matters

Do not add screenshots until they have been checked for secrets, local paths, private names, and tokens.

## Brand and terminology

| Use this | Avoid in public prose |
| --- | --- |
| Army of Agents on first mention | AoA as the first word on a page |
| Home | Dashboard, except API route references |
| Task | Issue, except API route references |
| Discussion | Debrief or Brief |
| Company Brain or Memory | Unexplained internal memory tables |
| Crew | Internal agent implementation names without context |

## Quality checklist

Before publishing a docs change:

- [ ] The page has frontmatter with `title` and `summary`.
- [ ] The first paragraph says who the page is for and what it helps them do.
- [ ] Commands include expected output or a verification step.
- [ ] Product claims are source-verified.
- [ ] Links use public Mintlify routes.
- [ ] The page does not contain stale organization names or private setup details.
- [ ] A repository scan returns zero matches for the retired brand term.
