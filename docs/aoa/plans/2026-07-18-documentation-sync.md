# Documentation Sync Plan — 2026-07-18

## Goal

Bring authoritative documentation up to date with the user-facing and public
contract changes merged into `main` from 2026-07-04 through 2026-07-18.

The audit window is 2026-07-04 through 2026-07-18 on `origin/main`. The last
broad documentation sync was PR #275 on 2026-07-06. Since then, most feature branches
updated implementation plans and QA evidence, but several did not update stable
reference docs or operator guides.

## Evidence baseline

| Area | Shipped evidence | Current documentation gap | Priority |
|---|---|---|---|
| Auth and onboarding | PRs #288 and #292; `packages/shared/src/onboarding.ts`; `ui/src/onboarding/`; onboarding and Commander-login routes | Quickstart and company-creation guides still describe the retired manual flow. Authentication reference omits Google-only sign-in and first-admin bootstrap; onboarding, invitation, profile, and Commander-login contracts have no stable reference. Decisions #28, #34, and #37 contradict the shipped multi-user onboarding flow. | P0 |
| Unified composer | PR #291; `packages/shared/src/composer-contracts.ts`; composer components; comment/discussion/Commander routes | No operator guide. API docs omit `clientSubmissionId` replay, attachment limits/capabilities, attachment-only discussion entries, wake actions, and failure/retry behavior. | P0 |
| Artifact lifecycle | PR #276; `server/src/routes/artifacts.ts`; artifact validators/schema | No dedicated REST reference or operator guide for create/version/archive/unarchive, file-backed versions, permissions, or immutable history. | P0 |
| Humans and accountability | PR #284; team routes and human-profile/capability schemas | Task accountability is partly documented, but Human Operating Profiles, roles/authority, capability documents, workload, and team APIs are not. | P0 |
| Work questions and completion policy | PR #288; `work_questions` and continuation routes/services; Decision #109 | Concepts are in `CLAUDE.md`, but route contracts and completion-policy fields/precedence are absent from API docs. | P1 |
| Commander skills and tools | PR #286; generated tools manifest and drift checks | Public docs still describe 31 Commander tools and 36 MCP tools. The generated aggregate manifest currently contains 87 Commander-surface and 38 MCP-surface entries. Operators and contributors cannot find the generated source-of-truth or drift-check workflow. | P1 |
| Task detail workflow | PR #278 | Managing-tasks guide omits the resizable task detail, inline property editing, description autosave, workspace/work/comments/activity organization, and docked composer. | P2 |
| Schema inventory | Migrations and schema files added by PRs #284, #288, #291, and #292 | `CLAUDE.md` has a volatile hard-coded schema-file count and omits recent tables/outboxes. | P1 |
| Release-smoke wording | Auth/onboarding release-smoke changes in #287/#288 | Distribution docs still refer to the retired wizard and obsolete step coverage. | P2 |

## Diataxis coverage map

| Entity | Tutorial | How-to | Reference | Explanation |
|---|---:|---:|---:|---:|
| Founder and invited-user onboarding | Update quickstart | Rewrite company/onboarding guide | Expand authentication reference | Add locked decision amendment |
| Unified composer | Not needed | New cross-surface operator guide | Expand task, discussion, and Commander APIs | Existing attachment-runtime note, add concise cross-link |
| Artifact lifecycle | Not needed | New operator guide | New artifact REST reference | Existing immutable-version decisions |
| Human profiles and accountability | Not needed | Expand Team/operator guidance | New Team REST reference | Existing accountability decisions |
| Work questions/completion policy | Not needed | Expand task guidance | New work-questions reference; expand task/project/workflow references | Decision #109 already covers rationale |
| Commander skills/tools | Not needed | Expand Commander operator guidance | Update internal-agent reference and contributor commands | Generated manifest remains the source of truth |

## Authority map

- `docs/start/quickstart.md` is the tutorial and entry path.
- `docs/guides/**` owns user tasks and UI workflows. Guides link to reference
  pages instead of repeating field/default/permission tables.
- One domain page under `docs/api/**` owns wire fields, defaults, limits,
  status codes, permissions, and errors.
- `docs/architecture/decisions.md` owns rationale and locked invariants.
- `CLAUDE.md` owns contributor commands and a lean inventory, linking to deeper
  docs instead of restating user contracts.
- Plans and QA reports are historical evidence, never current authority.

## Implementation sequence

### 1. Correct the entry path and locked behavior

- Rewrite `docs/start/quickstart.md` around current CLI setup, Google sign-in,
  first-user bootstrap, and the route-driven founder onboarding flow.
- Rewrite `docs/guides/board-operator/creating-a-company.md` as the current
  founder workflow.
- Add `docs/guides/board-operator/inviting-and-joining.md` for invitation
  creation/resend/revoke, token and tokenless consent, verified-email matching,
  rejection/reinvite recovery, profile completion, and role/TTL constraints.
- Keep `docs/api/authentication.md` focused on auth modes, Google OAuth,
  sessions/cookies, bearer identities, and access boundaries.
- Add `docs/api/onboarding.md` for journey/progress, founder Phase 1,
  invited Phase 1, join finalization, environment setup, and user-profile
  contracts. Reserved `WALKTHROUGH_*` states must remain undocumented as
  shipped behavior.
- Put invite lifecycle in `docs/api/team.md` and Commander key/verify/device
  login routes in `docs/api/internal-agent.md`.
- Amend `docs/architecture/decisions.md` so Decisions #28, #34, and #37 are
  explicitly superseded by the shipped route-driven, multi-user model.

### 2. Fill critical reference and how-to gaps

- Add `docs/api/artifacts.md` and
  `docs/guides/board-operator/artifacts.md`.
- Add `docs/api/team.md` and expand
  `docs/guides/board-operator/org-structure.md`.
- Add `docs/api/work-questions.md` and expand task/completion-policy coverage.
- Add `docs/guides/board-operator/commander.md` for cockpit, conversations,
  notes, skills, attachments, work questions, review/completion behavior,
  Commander sign-in, permissions, and trust.
- Assign completion policy ownership explicitly:
  `docs/api/companies.md` owns company defaults/guardrails;
  `docs/api/goals-and-projects.md` owns scope defaults;
  `docs/api/workflow-templates.md` owns template overrides;
  a new `docs/api/routines.md` owns Routine overrides;
  `docs/api/issues.md` owns task snapshots, acceptance criteria, autonomy gate,
  tighten-only changes, and reviewer materialization;
  `docs/api/work-questions.md` owns question state/version/error/continuation
  contracts.
- Register every new page in `docs/docs.json`.

### 3. Document the unified composer

- Add `docs/guides/board-operator/composer.md`, framed around the user task
  “send messages, mentions, and files,” and covering retry/edit/discard,
  offline retention, drag/drop, wake/interrupt actions, and per-surface
  differences.
- Update `docs/api/issues.md`, `docs/api/discussions.md`, and
  `docs/api/internal-agent.md` with idempotency, attachment, mention, wake,
  retry, and limit contracts.
- Cross-link `docs/architecture/commander-attachment-runtime.md`.
- Verify fresh-versus-replay status codes, same-key concurrency, attachment
  counts/sizes/MIME validation, attachment-only entries, draft scoping, and
  durable outbox semantics separately for Commander, Discussion, task
  comments, and Workspace timeline. Describe outboxes as durable delivery
  infrastructure, not a promise of literal end-to-end exactly-once execution.

### 4. Synchronize authoritative agent/developer context

- Remove volatile hard-coded tool/schema counts from `CLAUDE.md`; link the
  generated manifest as canonical and document 87 Commander + 38 MCP only in
  the dated audit/plan evidence. Update composer/onboarding behavior and add
  the recent schema inventory (`onboarding_progress`, `user_profiles`,
  `company_user_profiles`, `company_user_capability_documents`,
  `user_entity_follows`, `user_notes`, `work_question_continuation_requests`,
  `commander_login_challenges`, `discussion_entry_attachments`,
  `discussion_mention_outbox`, and `comment_wakeup_outbox`).
- Document the generated Commander tool/skill source-of-truth and the
  `gen:tools*` / `gen:skills*` verification commands.
- Update the task operator guide for the current task-detail workflow.
- Update Discussions guidance with verified crew success/failure loopback and
  `autoRunSummary` semantics.
- Correct only the factual release-smoke wording in
  `docs/deploy/distribution.md` and the deleted `OnboardingWizard` reference in
  `docs/deploy/docker-runtime-research-changelog.md`.
- Fix high-confidence integrity issues found during the corpus audit: the
  broken execution-workspaces plan link and deleted company portability source
  paths.
- Review `README.md`, `docs/api/mcp.md`,
  `docs/start/paperclip-vs-aoa.md`, and adapter/nav entry points for stale
  onboarding or tool-surface claims.

### 5. Discoverability and lifecycle boundary

- Add contextual links, not only navigation entries: quickstart to founder and
  invite onboarding; API overview to onboarding/team/artifacts/work questions;
  Team guide to invites; task/discussion/Commander guides to composer; MCP,
  discussions, and workspaces to artifacts; task/Commander guides to work
  questions.
- Do not move historical plans in this change. Archive cleanup requires a
  separate change with an explicit old-to-new manifest, `git mv`, full link
  inventory, and redirect strategy. Record this bounded debt without treating
  plans or QA reports as current authority.

## Review gates

Before editing feature docs:

1. Independent reviewer checks scope against recent commits and PRs.
2. Independent reviewer checks Diataxis partitioning, discoverability, and
   whether the plan creates duplicate authorities.
3. Incorporate all high-confidence P0/P1 findings into this plan.

Plan-review amendments incorporated:

- Separated authentication, onboarding, invitations, Team, and Commander
  authorities.
- Added distinct invited-user and Commander guides.
- Removed archive moves from this behavioral documentation change.
- Replaced volatile tool/schema counts with generated authorities and explicit
  inventory.
- Expanded completion-policy, composer, artifact, navigation, and integrity
  verification scope.

Before hand-off:

- Validate every documented route, field, default, limit, permission, and
  command against code or tests.
- Maintain a source-to-doc acceptance matrix for routes in
  `server/src/routes/{artifacts,team,work-questions,onboarding*,
  commander-login,commander-key,user-profiles,issues,discussions,
  internal-agent}.ts`, including method/path, success/replay status, role gate,
  defaults, limits, and errors.
- Verify all relative Markdown links and every `docs/docs.json` page entry.
- Run a deterministic local Markdown-link/nav checker and assert each new page
  appears exactly once in `docs/docs.json`; run Mintlify validation/dev startup
  if dependencies and network permit.
- Check quickstart/authentication/Docker/deployment-mode claims for the
  Google-required authenticated path versus keyless loopback development.
- Run `git diff --check`.
- Run `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` as required by
  `AGENTS.md`, reporting any environment limitation.
- Run generated-contract drift checks:
  `pnpm gen:tools:check`, `pnpm gen:tools:md:check`, and
  `pnpm gen:skills:check`, before and after doc edits. Do not run generators
  that rewrite manifests.

## Not in scope

- Product or architecture changes.
- Rewriting archived plans or QA evidence.
- Changing generated Commander tool manifests by hand.
- Version bumps, publishing, pushing, or opening a pull request unless
  separately requested.
- A repository-wide historical archive migration unrelated to the last
  two weeks of shipped work.

## Post-implementation review

The read-only release-documentation review found and corrected these
high-confidence contract mismatches before hand-off:

- Commander login challenge status and cancel paths require a challenge ID.
- Issue priorities use `critical`, while routine priorities use `urgent`.
- Validation errors for artifacts and work questions use `400`; cross-company
  artifact assets are also rejected with `400`.
- `onboard --yes` is environment-aware, writes configuration, and immediately
  starts the server; `run` restarts or auto-bootstraps an instance later.
- The Director agent role is `cxo`, not the retired `ceo` value.
- Routine trigger delete and secret rotation do not currently add the
  task-assignment permission check.
- Generic `409` guidance must defer to each endpoint's concurrency,
  idempotency, or ownership contract.
- Founder invite authority differs between the intentionally narrower Team UI
  and the server API.
- Interactive onboarding sign-in is currently Codex-only; Claude onboarding
  uses the credential path.

### Follow-up execution plan

Close the two remaining Diataxis gaps in this worktree before opening the PR:

1. Add a Routines operator how-to that covers creation, variables and
   templating, activation, manual and scheduled/webhook execution, revision
   restore, run inspection, secret rotation, and failure recovery. Keep field
   and endpoint tables in the API reference rather than duplicating them.
2. Add a Work Questions operator how-to that covers answering, reassignment,
   takeover, cancellation, continuation state, failed-continuation retry,
   version conflicts, and where questions appear in the product.
3. Register both guides once in `docs/docs.json`, link them from their API
   references and relevant task/Commander guides, and keep every new page
   reachable from public navigation.
4. Verify each workflow claim against routes, validators, services, UI
   affordances, and tests. Run the repository gates, generated-contract checks,
   navigation/link checks, and a final read-only documentation release audit.
5. Stage only the intentional documentation patch, commit it, push
   `codex/docs-sync-20260718`, and open a draft PR against `main`.

Acceptance criteria:

- Routines and Work Questions each have reference plus operator how-to coverage.
- The how-tos contain verification and troubleshooting sections with
  endpoint-specific recovery guidance.
- No duplicated or contradictory authority is introduced.
- All public navigation entries resolve and occur exactly once.
- Typecheck, tests, build, generated tool checks, and `git diff --check` pass,
  with any environment-only limitation stated in the PR.

The artifact metadata PATCH also exposes an implementation governance concern:
it accepts direct status changes under ordinary company access without the
founder and transition checks used by the dedicated archive routes. This change
documents the current contract but does not alter product behavior.

### Final verification result

- Independent cross-review of the Routines and Work Questions guides corrected
  eight implementation-contract issues before the release audit.
- The document-release re-audit passed with no remaining P1 or P2 findings after
  corrections to quickstart execution, autonomy boundaries, release packaging
  and smoke scope, scheduler defaults, system-administrator transfer semantics,
  and the artifact operator workflow.
- Public navigation contains 85 entries with no missing files or duplicates.
  Every new public page appears exactly once; all relative links in the 36
  changed Markdown files resolve.
- `pnpm -r typecheck`, `pnpm build`, `pnpm gen:tools:check`,
  `pnpm gen:tools:md:check`, and `git diff --check` passed. The Mintlify local
  preview reached ready state.
- The full test run passed 12,859 tests and hit two import-duration thresholds
  under concurrent audit load. Both timing-only failures passed when rerun in
  isolation (7/7 tests).
- `pnpm gen:skills:check` could not run because the external
  `scratchpad/aoa-skills/skills` catalog is not present in this checkout.
