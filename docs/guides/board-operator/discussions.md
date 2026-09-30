---
title: Discussions
summary: Threads workspace, unlisted intake, scope drafts, crew loopback, and attachments
---

Discussions is AoA's thread workspace. It is the universal intake for ideas, transcripts, documents, agent output, and unstructured content. The route is `/discussions`; `/briefs` and `/debriefs` redirect here.

## Workspace Layout

The workspace has:

- A thread rail
- A Home overview
- A global viewer on Home
- Thread detail when a thread is selected

The rail groups threads into Unlisted, Discuss, Scope, Assign, Done, and Archived. It supports search, New Thread, archive, and unarchive.

## Unlisted Intake

Unlisted items are inbound material that has not become a thread yet. Operators can turn them into threads or dismiss them.

## New Thread Types

New Thread supports:

- Idea
- Discussion
- Goal
- Transcript
- Document

Goal threads can create a discussion, add an entry, and then promote the result to a goal.

## Scope Drafts and Crew Routing

Scope drafts turn extracted thread material into planned work. Autonomy controls how far AoA goes:

- Manual: propose only
- Assist: create planning tasks and request dispatch approval
- Drive: create standard tasks and dispatch when preflight checks pass

Crew work remains linked to its originating thread. Successful execution is
visible through the created task, its output, and the task's run-summary comment.
When a crew run fails, AoA also posts a failure card into the originating thread
with actions to retry or view the task. Run summaries can be disabled per agent
with `runtimeConfig.autoRunSummary`; failure-card delivery is a separate,
best-effort loopback.

## Attachments and Viewer Tabs

Thread entries can carry assets or artifacts. The viewer supports thread content, linked files, browser-style viewers, and selected-item detail.

Posts and replies use the shared composer for drafts, mentions, attachments, and
replay-safe retries. See [Compose messages and comments](composer.md) and the
[Discussions API](../../api/discussions.md).

## Legacy Status

Legacy Brief/Debrief tables remain for rollback safety. New operator work should happen in Discussions.
