---
title: Memory
summary: Memory Explorer, layers, review, uploads, graph, folders, and embeddings
---

Memory is the knowledge base agents and Commander use for durable context. The canonical UI is **Memory Explorer** at `/memory/explore`; `/memory` redirects there.

## Explorer Layout

Memory Explorer has three resizable areas:

- Folder/tree rail
- List pane
- Tabbed viewer

The top shortcuts include Home, Pinned, Pending Review, Recent, and Archived.

## Layers

| Layer | Meaning |
|-------|---------|
| Identity | Company-wide identity, mission, values, and durable facts |
| Domain | Department-scoped operating knowledge |
| Active Context | Goal/project-scoped temporary context |
| Working | Task-chain-scoped ephemeral memory |

Domain expands by department. Active Context expands by active goal. Working memory is short-lived and auto-archived by lifecycle jobs.

## Pending Review

Agents can suggest memory, but founder approval gates identity and domain layers. Team leads may approve active-context memory for their departments. Pending Review is where these suggestions are accepted, rejected, edited, or scoped.

## Search and Embeddings

Semantic memory search uses embeddings. If embeddings are unavailable, Memory Explorer shows a warning and links to **Settings -> Memory**.

The OpenAI key in Settings -> Memory is for embeddings only. Extraction is CLI-only and does not use this key.

## Uploads, Files, and Folders

The list pane supports scoped search, upload where allowed, new memory items, view modes, subfolder navigation, and per-item re-index.

The Local tree can browse the configured company root folder or home path.

## Graph and Backlinks

The viewer supports memory items, assets, graph view, open/recent collections, folder summaries, and collapsed tabs. Use graph/backlink views to inspect how memory items relate before approving or editing long-lived knowledge.
