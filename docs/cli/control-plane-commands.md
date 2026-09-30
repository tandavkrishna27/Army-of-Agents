---
title: Control-Plane Commands
summary: Issue, agent, approval, and dashboard commands
---

Client-side commands for managing issues, agents, approvals, and more.

## Issue Commands

```sh
# List issues
pnpm aoa issue list [--status todo,in_progress] [--assignee-agent-id <id>] [--match text]

# Get issue details
pnpm aoa issue get <issue-id-or-identifier>

# Create issue
pnpm aoa issue create --title "..." [--description "..."] [--status todo] [--priority high]

# Update issue
pnpm aoa issue update <issue-id> [--status in_progress] [--comment "..."]

# Add comment
pnpm aoa issue comment <issue-id> --body "..." [--reopen]

# Checkout task
pnpm aoa issue checkout <issue-id> --agent-id <agent-id>

# Release task
pnpm aoa issue release <issue-id>
```

## Company Commands

```sh
pnpm aoa company list
pnpm aoa company get <company-id>

# Export to portable folder package (writes manifest + markdown files)
pnpm aoa company export <company-id> --out ./exports/acme --include company,agents

# Preview import (no writes)
pnpm aoa company import \
  --from https://github.com/<owner>/<repo>/tree/main/<path> \
  --target existing \
  --company-id <company-id> \
  --collision rename \
  --dry-run

# Apply import
pnpm aoa company import \
  --from ./exports/acme \
  --target new \
  --new-company-name "Acme Imported" \
  --include company,agents
```

## Agent Commands

```sh
pnpm aoa agent list
pnpm aoa agent get <agent-id>
```

## Approval Commands

```sh
# List approvals
pnpm aoa approval list [--status pending]

# Get approval
pnpm aoa approval get <approval-id>

# Create approval
pnpm aoa approval create --type hire_agent --payload '{"name":"..."}' [--issue-ids <id1,id2>]

# Approve
pnpm aoa approval approve <approval-id> [--decision-note "..."]

# Reject
pnpm aoa approval reject <approval-id> [--decision-note "..."]

# Request revision
pnpm aoa approval request-revision <approval-id> [--decision-note "..."]

# Resubmit
pnpm aoa approval resubmit <approval-id> [--payload '{"..."}']

# Comment
pnpm aoa approval comment <approval-id> --body "..."
```

## Activity Commands

```sh
pnpm aoa activity list [--agent-id <id>] [--entity-type issue] [--entity-id <id>]
```

## Dashboard

```sh
pnpm aoa dashboard get
```

## Heartbeat

```sh
pnpm aoa heartbeat run --agent-id <agent-id> [--api-base http://localhost:3100]
```
