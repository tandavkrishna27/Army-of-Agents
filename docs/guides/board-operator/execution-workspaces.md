---
title: Execution Workspaces
summary: Per-task git-worktree isolation for engineering work
---

A practical reference for the per-task git-worktree isolation system that
powers engineering workflows in AoA. Companion to
[`workspace-decisions.md`](../../architecture/workspace-decisions.md)
(architectural rationale).

## What is a workspace?

An **execution workspace** is an isolated filesystem + runtime sandbox used by
an agent (or a human teammate) to execute a task. For engineering projects it
is a **git worktree** pinned to the project's base ref, branched onto a
task-scoped branch, with its own runtime services (dev server, watchers,
database). Each task gets its own worktree so concurrent runs never clobber
each other's files, branches, or ports. Non-engineering work types fall back
to `shared` or `none` modes.

Stored in [`execution_workspaces`](../../../packages/db/src/schema/execution_workspaces.ts)
with JSONB `metadata` (denormalized config snapshot, linked issues, PR info,
close-report) + JSONB `runtime` (service state, ports, logs).

## Enabling worktrees for a project

Three gates must line up:

1. **Instance setting** — `enableIsolatedWorkspaces` must be `true` (the default).
   Toggle in Settings → Instance → Experimental.
2. **Project type** — the project's `functionType` must be
   `software_development`. Settings → Project → Properties → Function Type.
3. **Project policy** — `executionWorkspacePolicy.defaultMode` must be
   `isolated_workspace` (the new-project default for software engineering).
   Also configurable under Project → Properties → Execution Workspace.

If any gate is off, the project falls back to shared-workspace mode (one
persistent directory for all tasks) or no-workspace mode (ephemeral).

## Per-task reuse_existing

A task can opt into a **different** execution mode than its project default via
the **Execution Workspace** card on the TaskSlideOver (see
[`IssueWorkspaceCard`](../../../ui/src/components/IssueWorkspaceCard.tsx)). Three
per-task choices:

- `shared_workspace` — run in the project's shared directory
- `isolated_workspace` — create a fresh worktree for this task (default)
- `reuse_existing` — pick an existing worktree from a dropdown; subsequent
  heartbeat runs short-circuit `realizeExecutionWorkspace` and reuse it

Reuse is useful when a follow-up task needs the uncommitted state of an
earlier run.

## Workspace lifecycle

1. **Auto-create** — on the first heartbeat run for an engineering task with
   `per_task` policy,
   [`workspace-runtime`](../../../server/src/services/workspace-runtime.ts)
   materializes the worktree (git branch + directory + provision command) and
   writes a config snapshot into `metadata.config`.
2. **Reuse** — subsequent runs on the same task (or any task set to
   `reuse_existing` on that workspace) short-circuit and hand the existing
   worktree to the adapter.
3. **Archive** — triggered manually via the close dialog (see below) or by a
   close workflow wired into task completion.
4. **TTL mark** — the optional TTL sweeper marks stale workspaces as
   `cleanupEligibleAt` once the project's `ttlDays` has elapsed since
   `lastUsedAt`. The sweeper does **not** auto-archive; a founder or team
   lead still confirms.

## The workspace cockpit

- **Company-wide list:** `/:companyPrefix/workspaces` (sidebar: WORK →
  Workspaces) — see [`WorkspacesList`](../../../ui/src/pages/WorkspacesList.tsx).
  Status chips, project grouping, last-used timestamp, kebab per row.
- **Detail view:** `/:companyPrefix/workspaces/:workspaceId` — 3-panel IDE-style cockpit
  ([`WorkspaceLayout`](../../../ui/src/components/workspace/WorkspaceLayout.tsx)):
  task nav + timeline/preview + context.
- **Header kebab menu:** Settings Sheet + Archive dialog.
- **Open in IDE:** VS Code / Cursor / Zed buttons + Reveal in Finder/Explorer
  + Copy path via [`OpenInIdeButton`](../../../ui/src/components/workspace/OpenInIdeButton.tsx).
  Preferred editor persists at `localStorage["aoa:workspace:preferred-editor"]`.
- **Runtime services:** start/stop/restart dev servers from the right panel's
  [`ServicesSection`](../../../ui/src/components/workspace/sections/ServicesSection.tsx)
  (gated to `software_development` projects).

## Configuration via Settings Sheet

Kebab → Settings opens
[`WorkspaceSettingsSheet`](../../../ui/src/components/workspace/WorkspaceSettingsSheet.tsx)
(three tabs: Configuration / Runtime Logs / Linked Issues). Editable fields:

- `name` — display name
- `repoUrl` + `baseRef` + `branchName` — git origin + checkout points
- `providerRef` — GitHub PR metadata (auto-filled by Create PR flow)
- `provisionCommand` — run after worktree creation (e.g. `pnpm install`)
- `cleanupCommand` — run before directory removal on archive
- `teardownCommand` — run on runtime stop (e.g. docker-compose down)

Changes are persisted via `PATCH /execution-workspaces/:id` (widened in
Task 10 to accept metadata-only updates).

## Archiving

Kebab → Archive opens the **close dialog**
([`ExecutionWorkspaceCloseDialog`](../../../ui/src/components/workspace/ExecutionWorkspaceCloseDialog.tsx)),
built on the AlertDialog primitive. Shows a preview of planned actions:

- `archive_record` — mark DB row archived
- `stop_runtime_services` — halt running services
- `cleanup_command` — run the configured cleanup command
- `teardown_command` — run the configured teardown command
- `git_worktree_remove` — `git worktree remove`
- `git_branch_delete` — delete the task branch
- `remove_local_directory` — `rm -rf` the worktree directory

The dialog blocks archive if any linked issue is active or git status is
dirty (with warnings listed). Operators get a 403 when a `team_member` tries
to archive outside their scope.

## Create PR

GitHub-only MVP.

1. Store a personal access token in Settings → Integrations → GitHub
   (per-company; encrypted in `company_secrets` as `github_pat`). PAT needs
   `repo` scope.
2. Open a workspace with a pushed branch on a GitHub repo.
3. GitPanel shows a **Create PR** button — opens
   [`CreatePrDialog`](../../../ui/src/components/workspace/CreatePrDialog.tsx)
   prefilled from the linked issue.
4. On success, the PR link persists to `workspace.metadata.pr` and a
   "Opened PR #N" comment is posted to the linked task. The button changes to
   "PR #N" (external link) on subsequent loads.

Errors map to clear banners: 401 (bad PAT), 403 (missing scope — common for
forked repos), 404 (repo not found / repo private without access), 412
(branch not pushed yet), 422 (PR already exists / base head identical).

## TTL sweeper

Opt-in in Settings → Instance → Experimental → `enableWorkspaceTtlSweeper`.
A scheduler runs every 6 hours and sets `cleanupEligibleAt` on workspaces
older than their project's `ttlDays` (set on Project → Properties →
Execution Workspace → TTL). The sweeper surfaces candidates in the
`/workspaces` list with a "Cleanup eligible" chip — it does **not**
auto-archive. Founders and team leads act on the list manually or via
future automation.

## Role-based permissions

Enforced server-side in `workspace-authz` + `assertBoard` (Task 9):

- **founder** — all operations on any workspace
- **team_lead** — all operations on workspaces in projects they lead
  (includes runtime control, archive, config PATCH, Create PR)
- **team_member** — read-only: can view `/workspaces`, open detail, read the
  operations log (`GET /execution-workspaces/:id/operations`). Cannot
  start/stop services, archive, edit config, or create PRs — those return 403

## Limitations / known issues

- **Create PR is GitHub-only** — GitLab/Bitbucket deferred; `providerRef`
  schema is multi-provider-ready
- **Worktree cleanup is advisory** — the TTL sweeper never deletes files;
  manual archive always required
- **Single-PAT-per-company model** — no per-user PATs; founder-owned token
  shared across team
- **IDE launchers use OS `open`** — no deep URL handlers; behavior depends on
  local associations
- **Workspaces page breadcrumb reads as "Discussions"** — backlog cleanup item
- **Radix DialogTitle warnings** appear in console on some dialogs (pre-existing)
- **No idempotency guard on Create PR** — double-click protected by button
  disable only; server-side idempotency key is a backlog item
