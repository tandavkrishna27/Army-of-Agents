---
title: Inbox
summary: Hub lanes, tabs, actions, runtime decisions, notifications, and preferences
---

Inbox is the operator queue for things that need attention. It is powered by the Hub API and opens at `/inbox`. Deep links use `/inbox/{lane}/{itemId}`. The legacy `/inbox-hub` route redirects here.

## Lanes

| Lane | What appears there |
|------|--------------------|
| Home | Counts, shortcuts, "Needs you most", and autopilot status |
| Waiting on you | Approvals, runtime decisions, work questions, and other blockers |
| Notifications | Informational events and alerts |
| Suggestions | Memory suggestions, improvement suggestions, and reviewable recommendations |

## Tabs and Deep Links

Clicking a row opens a dedicated tab. Deep links hydrate the matching item and open it as a tab, so links from emails, notifications, or task comments land in the same review surface.

## Actions

Common actions include mark unread, dismiss, snooze, resolve/archive where allowed, and claim/release where allowed.

Some items mirror source state. For example, open approvals and runtime decisions hide generic resolve/archive while the source row is still pending. Runtime decision items also hide claim/release because the owning run is the authority.

## Runtime Decisions and Work Questions

Runtime decision cards are where agents ask for permission or input while a run is active. Answer them from the item tab. If the backing run expires or the source revision changes, the stale answer is rejected.

For questions that pause agent work, including takeover, reassignment, cancellation, and continuation recovery, see [How to Resolve Work Questions](work-questions.md).

## Preferences

The Inbox settings panel controls:

- Default landing lane
- Visible lanes
- Grouping
- Density
- Autopilot settings
- Notification preferences
- Quiet hours
- Digest settings

## Keyboard

In lane views:

- `/` focuses search
- `j` / `k` move selection
- `Enter` opens the selected item
- `Escape` clears selection or closes the mobile rail
