# Human Operating Profiles - Master Scope

**Status:** Draft scope for review; per-scope design begins after approval
**Date:** 2026-07-07
**Type:** Master scope / decomposition, not an implementation plan
**Branch:** `codex/humans-page-research`
**Authors:** Founder + Codex research session

> This document is the map for making the Humans surface enterprise-grade. It
> decomposes the work into scopes. Each scope should get its own investigation,
> design, implementation plan, build, tests, and commit before moving to the next
> scope.

---

## 1. Context

AoA is a Hybrid Workforce OS. The Team surface is not only a directory and not
only an org chart. It is where humans, agents, agent teams, and the AoA crew fit
into one operating system.

Today the Humans page is mostly an org-control surface:

- Team -> Humans roster with member cards, invite cards, role filters, and search.
- Human detail page with Overview and Settings tabs.
- Overview shows report counts, agent-tree counts, assigned task count, and
  created task count.
- Settings edits role, department, reports-to, and removal.
- `/me` lets the current signed-in user edit their own display name and avatar
  URL.

That is useful, but it does not yet answer the operating questions:

- What is this human responsible for?
- What work currently flows through them?
- What should agents know before asking them, routing work to them, or choosing
  them as a reviewer?
- What can founders/team leads safely edit?
- What can members edit about themselves?
- Which parts are visible to other humans, Commander, and worker agents?

## 2. Product Principle

Human profiles should answer:

> How does work move through this person, and what should agents know when
> collaborating with them?

This is deliberately not a generic HRIS. HR-like features can come later, but
the first product shape should serve AoA's control-plane loop: assign work,
route decisions, ask the right human, review output, and preserve approved
operating context.

## 3. Vocabulary

Use these terms consistently:

| Term | Meaning |
| --- | --- |
| Team | The UI umbrella for humans, agents, agent teams, and the AoA crew. |
| Human | A company member who can own, review, approve, or perform work. |
| Human Operating Profile | Company-scoped profile data used to understand how work flows through a human. |
| Capability | A human's expertise, tools, domains, or strengths. Do not call this "Skills" in the UI, because AoA Skills are agent-executable packages. |
| Agent-readable summary | A curated, approved profile summary safe to include in Commander/agent context. |
| Profile document | A markdown-style human profile document with version/review metadata. |

## 4. External Alignment

The target shape should align with durable enterprise identity/profile patterns:

- SCIM's enterprise user extension includes org-oriented fields such as
  department and manager. See RFC 7643.
- Microsoft Graph and Google Workspace model people as identity plus
  organization, contact/profile data, photos, and admin-controlled source data.
- Schema.org `Person` includes useful concepts for external identity and
  discoverability, including `jobTitle`, `affiliation`, `sameAs`, and
  `knowsAbout`.

References:

- https://datatracker.ietf.org/doc/html/rfc7643
- https://learn.microsoft.com/en-us/graph/api/resources/user
- https://developers.google.com/workspace/admin/directory/reference/rest/v1/users
- https://schema.org/Person

These are references, not requirements. AoA should stay simpler than a full
identity provider or HR system.

## 5. Current Grounding

Current implementation areas:

- `ui/src/pages/TeamPage.tsx` - Team shell sections: Organization, Agents,
  Humans, Teams, AoA Team.
- `ui/src/components/team/HumansTab.tsx` - human roster, filters, invite cards,
  add-member/admin-transfer actions.
- `ui/src/pages/HumanDetail.tsx` - current human Overview and Settings tabs.
- `ui/src/pages/Me.tsx` - self profile editor for display name and avatar URL.
- `ui/src/api/team.ts` - team summary/member/dependency/admin API client.
- `server/src/routes/team.ts` - company-scoped human team routes.
- `server/src/services/team.ts` - membership, role, reporting, dependencies,
  offboarding, and admin transfer behavior.
- `packages/db/src/schema/auth.ts` - global Better Auth user table.
- `packages/db/src/schema/company_memberships.ts` - company membership and human
  reporting parent.
- `packages/db/src/schema/user_roles.ts` - company role and department scope.
- `server/src/services/memory-folder-seeds.ts` - already seeds
  `Company/People/Humans`, `Company/People/Teams`, and `Company/People/Roles`.

Important current constraints:

- UI says Team. DB/API names stay as-is.
- `authUsers` is global identity, not company-specific operating profile data.
- Current role/department/reporting mutations are founder-gated.
- Founder promotion/direct founder add requires system admin.
- Last founder and system admin removal are blocked.
- Humans can only report to humans.
- Offboarding revokes the removed user's MCP API keys for that company.
- No dedicated `/companies/:companyId/humans` API exists today.
- No MCP human-profile tools/resources exist today.

## 6. Target Information Architecture

Each human detail should eventually have these conceptual areas:

### 6.1 Overview

The founder/operator's fast read:

- Identity header: avatar, display name, title, role, department, manager.
- Current work: assigned tasks, created tasks, review/approval queue, overdue or
  blocked work.
- Responsibility summary: what this person owns and who/what reports to them.
- Direct reports: humans and direct agent trees.
- Recent activity: decisions, comments, tasks, approvals, memory actions.
- Authority: permissions, role scope, system admin marker, approval rights.

### 6.2 Profile

Human-editable and founder-visible profile information:

- Title/headline.
- Short bio.
- Working style.
- Preferred communication.
- Timezone/location.
- Social/profile links.
- Personal website/portfolio.

### 6.3 Responsibilities

Company-operating ownership:

- Department responsibilities.
- Goal/project ownership.
- Review lanes.
- Approval authority areas.
- Memory/domain ownership.
- Agent teams supervised.
- Recurring decisions or workflows they own.

### 6.4 Capabilities

Expertise and routing data:

- Domains.
- Tools.
- Functions.
- Languages.
- Certifications.
- Review strengths.
- "Ask me about" topics.
- "Do not route to me for" topics.

### 6.5 Availability

Routing and interruption data:

- Timezone.
- Working hours.
- Out-of-office status.
- Response expectations.
- Escalation rules.
- Current capacity/load.

### 6.6 Agent Context

Curated context safe for Commander and worker agents:

- Agent-readable summary.
- Routing notes.
- Collaboration preferences.
- Review/approval areas.
- When to ask this person.
- What context to include when asking.
- Visibility/source/review metadata.

## 7. Data Model Direction

Do not overload `authUsers` for company-specific profile data. Keep the model
split:

| Area | Existing / future home |
| --- | --- |
| Login/global identity | `authUsers` |
| Company membership/reporting | `company_memberships` |
| RBAC role/scope | `user_roles` |
| Rich company profile | New `company_user_profiles` or `human_profiles` table |
| Avatar files | Existing `assets` plus optional profile avatar asset reference |
| Markdown profile docs | Later profile-document/version table, artifact, or document-backed model |
| Durable company knowledge | Memory, only after explicit approval/promotion |

Recommended future `company_user_profiles` shape:

- `companyId`
- `userId`
- `title`
- `headline`
- `bio`
- `timezone`
- `location`
- `workingHours`
- `workingStyle`
- `preferredCommunication`
- `responsibilities` as structured JSON
- `capabilities` as structured JSON
- `socialLinks` as structured JSON
- `agentReadableSummary`
- `routingNotes`
- `visibility`
- `lastReviewedAt`
- `reviewCadenceDays`
- `avatarAssetId`
- `createdAt`, `updatedAt`
- `updatedByUserId`

Exact schema should be decided in Scope 1, not in this master scope.

## 8. Permissions Model

Initial direction:

- A signed-in user can edit their own basic personal profile fields.
- Founder/system admin can edit company-scoped operating profile fields for any
  human.
- Role, department, reporting parent, founder promotion, system admin transfer,
  and offboarding keep the current stricter founder/system-admin rules.
- Team leads may eventually edit scoped responsibility/capability data for their
  departments, but not in the first schema-changing scope unless explicitly
  designed.
- Agent-readable fields require explicit visibility and review metadata.
- Any mutation must write `activity_log`.

Open design decision for Scope 1:

- Whether a founder can override another user's display name/avatar, or only the
  company-scoped title/headline/avatar used inside AoA.

## 9. Agent-Readable Profile Rules

Agent-readable does not mean every agent can read every profile.

Rules:

- Agent-readable content must be explicit, not inferred from private fields.
- The system should include profile snippets in context only when relevant to a
  task, assignment, review, routing decision, or question.
- Commander is the first and safest consumer because it already inherits the
  current user's RBAC context.
- Worker-agent access should be introduced through context packaging before
  adding broad MCP profile search/read tools.
- Profile facts should not silently become Memory. Promotion to Memory remains
  approval-gated.
- Sensitive fields should never be included in agent context by default.

## 10. Social/Profile Links

Social links are useful, but they should be structured and typed.

Recommended link types:

- LinkedIn
- GitHub
- X/Twitter
- Instagram
- Facebook
- Substack
- Website
- Portfolio
- YouTube
- Medium
- Other

Each link should carry:

- `type`
- `url`
- `label`
- `visibility`
- optional `verifiedAt`
- optional `source`

Use Schema.org's `sameAs` idea as inspiration: these links help identify the
same person across external surfaces, but AoA does not need public SEO semantics
inside the product.

## 11. Workstreams / Scopes

### Scope 0 - Human Profile Foundation + Operating Polish

Add the first company-scoped profile foundation and make the existing page useful
as an operating surface. This scope intentionally includes basic profile editing
because name/avatar/title/bio/location/timezone/social links are part of the
Human page's core enterprise identity surface.

Candidate work:

- Add `company_user_profiles` with company/user uniqueness.
- Add company-scoped display name, upload-backed avatar asset, title/headline,
  bio, location, timezone, and social links.
- Use existing company-scoped image assets for avatar upload; render initials as
  the deterministic default avatar when no uploaded/auth image exists.
- Keep social links visible to all company members in Scope 0.
- Add profile read/update API and shared validators/types.
- Allow members to edit their own basic company profile fields.
- Allow founder/system admin to edit any human's company profile fields.
- Keep role, department, reports-to, offboarding, and admin transfer on existing
  stricter role-management permissions.
- Add assigned task and created task lists, not just counts.
- Show directly assigned human tasks and tasks the human is responsible for
  through their reporting/agent context where the existing model can support it.
- Add recent activity for the selected human.
- Add an authority/permissions panel.
- Show manager, human reports, and direct agent reports more clearly.
- Improve empty/error/loading states.
- Hide or soften Edit affordances when the user lacks permission.
- Investigate and fix the `/team?tab=requests` mismatch if it affects join
  request management.

Likely files:

- `packages/db/src/schema/company_user_profiles.ts`
- `packages/db/src/schema/index.ts`
- generated Drizzle migration
- `packages/shared/src/types/team.ts`
- `packages/shared/src/validators/team.ts`
- `ui/src/pages/HumanDetail.tsx`
- `ui/src/components/team/HumansTab.tsx`
- `ui/src/api/team.ts`
- `server/src/routes/team.ts`
- `server/src/services/team.ts`
- shared team types/validators if API shape changes

Success signal:

- A founder opening a human profile can understand what the person owns, what is
  currently on their plate, what profile identity is shown inside the company,
  and what authority they have.

### Scope 1 - Responsibilities, Capabilities, and Agent-Ready Profile Context

Build on the Scope 0 profile foundation with richer operating profile data.

Candidate work:

- Capabilities and responsibilities.
- Working style and preferred communication.
- Availability/working hours.
- Review areas and escalation notes.
- Visibility/review metadata for future agent consumption.
- Audit logging.

Success signal:

- Humans have structured operating profiles that can later be safely packaged
  for Commander/agents.

### Scope 2 - Agent-Readable Human Context

Make profile data useful to Commander and agents safely.

Candidate work:

- `agentReadableSummary`.
- Routing notes.
- Collaboration preferences.
- "Ask me about" and review/approval areas.
- Visibility rules.
- Context packaging integration.
- Commander routing/reviewer suggestions.

Success signal:

- Agents can receive a safe, relevant human-context snippet when they need to ask,
  route, assign, or request review.

### Scope 3 - Profile Documents / Markdown

Add governed markdown-style profiles.

Candidate work:

- Versioned profile document.
- Frontmatter for owner, visibility, role, department, review cadence.
- Markdown body for narrative context.
- Last-reviewed and stale-profile badges.
- Optional "promote to Memory" flow, with approval.
- No silent ingestion into Memory.

Success signal:

- A human can maintain a durable, reviewable operating profile that can be used as
  context but remains governed.

### Scope 4 - Enterprise/Admin/HR Future

Do not build this first. Reserve the path.

Candidate future work:

- Employment history.
- Education/certifications as richer records.
- Onboarding/offboarding workflows.
- SCIM/identity-provider sync.
- Profile source precedence.
- HR privacy/compliance controls.
- Audit exports.
- Data subject export/delete flows.
- Compensation/performance, only if AoA intentionally enters HRIS territory.

Success signal:

- AoA can integrate with enterprise identity/HR systems without turning the v1
  Humans page into a bloated HR record.

## 12. Recommended Sequence

1. Approve this master scope.
2. Investigate Scope 0 in detail.
3. Write a Scope 0 implementation plan.
4. Build Scope 0 with tests.
5. Review and commit Scope 0.
6. Repeat for Scope 1, then Scope 2.
7. Defer Scope 3 until the schema/profile model has real usage.
8. Keep Scope 4 as future enterprise expansion.

One branch and one PR can contain multiple scopes, but each scope should land as
its own coherent commit. This keeps review possible while preserving the founder's
preferred single-PR flow.

## 13. Verification Expectations

Each implementation scope should run the repo's normal gate before hand-off:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If UI behavior changes materially, add targeted component tests and consider an
e2e happy path for the Human detail page. If schema/API changes land, update all
layers: `packages/db`, `packages/shared`, `server`, and `ui`.

## 14. Open Questions

These should be decided before or during the relevant scope:

1. Should a founder be able to edit another human's display name/avatar, or only
   company-scoped profile fields?
2. Should social links be visible to all company members by default, or private
   until explicitly shared?
3. Should team leads be able to edit profile/responsibility fields for members in
   their department?
4. Should agent-readable summaries be manually written only, or can Commander
   suggest updates that a human/founder approves?
5. Should profile documents use the existing documents/artifacts system, Memory
   assets, or a dedicated versioned profile-document table?
6. What is the minimum agent context that helps routing without leaking private
   profile data?

## 15. Initial Recommendation

Start with **Scope 0**.

Reason: Scope 0 gives immediate product value and forces a careful read of the
existing Humans page, task filters, activity data, and permission model before
committing to new schema. Scope 1 should follow only after Scope 0 confirms the
operating-view shape.
