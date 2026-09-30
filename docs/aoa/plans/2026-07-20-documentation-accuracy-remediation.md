# Documentation Accuracy Remediation Plan — 2026-07-20

## Goal

Resolve the contract mismatches found in PR #294 by making implementation,
tests, and current documentation agree with the repository's locked decisions
and with externally verifiable distribution state.

## Root causes

1. Artifact REST routes used `assertRole("founder")`, although that helper
   intentionally skips agent actors. The ordinary REST route therefore allowed
   same-company agents, while the legacy MCP-labelled REST route denied genuine
   MCP keys and allowed agents.
2. `humanQuestionSlaHours` was added after completion-governance fields, then
   omitted when the company and project authorization gates were hardened.
3. Package manifests and release automation were treated as proof of
   publication. The `@armyofagents/*` packages are absent from npm, the release
   workflow is disabled, release PR #227 was closed without merge, and its
   post-publish smoke job never ran.
4. Release guidance assumed Changesets creates a repository-level `v*` tag and
   maintained a partial package list by hand. Changesets creates per-package
   tags, while the Docker workflow needs a separate `v*` tag for versioned
   images; the hard-coded promotion list omitted public workspaces.

## Intended contracts

| Surface | Contract |
|---|---|
| `POST /api/artifacts/:id/versions` | Board actor with founder role. |
| `POST /api/mcp/artifacts/:id/versions` | Board founder or founder-owned MCP key; reject agents; force `source: "mcp"`. |
| JSON-RPC `attach-artifact-version` | Board or MCP caller with same-company, project-scope, and artifact-update permission; reject agent and Commander actors. |
| Company/project `humanQuestionSlaHours` | Human board operator with `tasks:assign`; local implicit and instance-admin bypasses remain. Presence checks include `null` clears. |
| Public install instructions | Source checkout plus `pnpm aoa` until the scoped CLI is actually published and smoke-tested. Never direct users to the unrelated `aoa` package or upstream `paperclipai` package. |

## Implementation

1. Harden artifact publishing.
   - Pair the ordinary REST version route with `assertBoard`.
   - Add a narrow founder-publisher check for the MCP-labelled REST route that
     understands board and MCP-key identities without changing generic RBAC.
   - Restrict JSON-RPC `attach-artifact-version` to board and MCP actors.
   - For this tool only, resolve an MCP key owner's user roles into founder or
     project scope, failing closed when the owner has no roles, and apply the
     same artifact scope filter used for board callers before the permission
     check. Keep generic MCP scope board-gated and unchanged.
2. Complete SLA governance.
   - Include `humanQuestionSlaHours` in the existing company update gate.
   - Gate project create/update when either completion default or SLA is
     present, including `null`.
   - Rename helper/error copy so it describes scope policy rather than only
     completion policy.
3. Correct current documentation and release configuration.
   - Distinguish the two REST artifact routes from the JSON-RPC tool.
   - Replace public npm quickstart commands with the tested source-checkout
     flow in README, quickstart, upgrade, distribution, and current release
     guidance.
   - Mark npm/GHCR destinations and smoke steps as configured future release
     behavior, not current availability.
   - Set Changesets' base branch to `main`.
   - Describe the actual per-package tag and Docker behavior, and make the
     local release script discover every owned, non-private
     `@armyofagents/*` pnpm workspace dynamically.
   - Keep the upstream-owned `@paperclipai/create-paperclip-plugin`
     compatibility workspace private so Changesets excludes it, and reuse the
     same owned-workspace discovery and package-specific versions for release
     and rollback.
   - Remove volatile MCP family counts from the API page.

## Regression tests

- Artifact route tests cover founder board success, non-founder denial, agent
  denial, founder-owned MCP-key success on the legacy ingress, non-founder MCP
  denial, forced source, and no service mutation on rejection.
- MCP tests cover the actor allowlist plus founder/scoped-lead/member,
  cross-company, and agent behavior for `attach-artifact-version`.
- Company/project authorization tests cover denied and allowed SLA writes,
  `null` clears, agent/MCP denial, local/admin bypasses, and unaffected ordinary
  updates.

## Verification

1. Run focused authorization and MCP tests.
2. Run documentation link/navigation and generated-contract drift checks.
3. Run `git diff --check`.
4. Run the repository hand-off gates:
   - `pnpm -r typecheck`
   - `pnpm test:run`
   - `pnpm build`
5. Run an independent pre-landing review against `origin/main`.
6. Push one intentional remediation commit, reply to every Codex thread with
   evidence, request `@codex review`, and wait for CI to reach a terminal state.

## Explicit exclusions

- Do not publish npm packages.
- Do not enable the disabled release workflow.
- Do not merge PR #294.
- Do not broaden generic MCP scope or generic `assertRole` behavior.
