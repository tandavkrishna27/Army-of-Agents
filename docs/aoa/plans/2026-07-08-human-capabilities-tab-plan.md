# Human Capabilities Tab Plan

Date: 2026-07-08
Branch: `codex/humans-page-research`

## Goal

Add a production-grade `Capabilities` tab to the human detail page. The tab should capture durable, company-scoped knowledge about what a human knows, has done, prefers, and can help with, without duplicating the top profile card or prematurely wiring this into Memory/RAG.

The immediate product job:

- Let the company view a human's capabilities as structured markdown documents.
- Let authorized users edit those documents safely.
- Make the content easy for future agents to consume as profile context.
- Keep Roles/authority separate from capabilities/responsibility knowledge.

## Current Research

### Existing Human Surface

The human detail page currently lives primarily in `ui/src/pages/HumanDetail.tsx`.

Current tabs:

- `Overview`: operational dashboard with tasks, direct reports, agent tree, and activity.
- `Roles`: authority card with role, department, reports-to, access, grants, team reports, agent hierarchy, and tasks.
- `Settings`: removal/admin related controls.

The top profile card already owns identity/profile snapshot:

- display name
- avatar
- title
- bio
- location
- timezone
- social links

Capabilities should not duplicate those fields.

### Existing Human Data Model

Company-specific human profile fields are stored in `company_user_profiles`:

- company scoped by `company_id`
- user scoped by `user_id`
- unique per `(company_id, user_id)`
- asset-owned avatar via `avatar_asset_id`

Team read/write flows are already centered in:

- `packages/db/src/schema/company_user_profiles.ts`
- `packages/shared/src/types/team.ts`
- `packages/shared/src/validators/team.ts`
- `server/src/services/team.ts`
- `server/src/routes/team.ts`
- `ui/src/api/team.ts`

### Existing Permissions Precedent

Human profile editing currently allows:

- self
- founder / `canManageRoles`
- company system admin

Team detail read is available to company-accessible board context. The user has already chosen company-wide visibility for profile-level information.

Capabilities should reuse the same MVP permission shape:

- all company members can view capabilities
- self, founder, and system admin can edit capabilities
- future RBAC can split this into explicit `humans:capabilities:update` grants

### Existing Agent Markdown Pattern

Agent instructions are filesystem-backed bundles:

- route family: `/agents/:id/instructions-bundle`
- service: `server/src/services/agent-instructions.ts`
- files have path, language, markdown, editable, virtual/deprecated flags
- mutations activity-log updates

This is useful as UX and contract inspiration, but not the right storage substrate for humans. Agent instructions are local runtime material; human capabilities are company data and should be portable, hosted-friendly, and RBAC-governed.

## Product Shape

Add a fourth tab:

- `Overview`
- `Roles`
- `Capabilities`
- `Settings`

Capabilities should feel like a document library/editor, not another profile form.

Recommended standard documents:

- `resume.md`: resume/CV, education, work history, major achievements.
- `skills.md`: structured skills, domains, tools, languages, industries, strengths.
- `responsibilities.md`: what this person owns or is responsible for operationally.
- `preferences.md`: working style, communication preferences, escalation preferences.
- `availability.md`: working hours, timezone notes, contact windows, capacity notes.
- `background.md`: narrative context that does not fit a resume, such as founder story, past projects, domain context.

Standard documents should be seeded or ensured for every active company member. They should be editable and clearable, but not deletable. Custom `.md` documents should be creatable, renamable, editable, and deletable.

Standard documents should not start as completely blank files. Each standard document should be created with a small markdown scaffold so the human knows what belongs there and future agent readers get consistent headings. Existing members should receive these standard documents lazily when the Capabilities tab/API is first loaded. Newly direct-added members should have the same standard documents seeded during member creation.

Recommended initial templates:

- `resume.md`: headings for summary, experience, education, achievements, certifications.
- `skills.md`: headings for core skills, tools, domains, languages, learning areas.
- `responsibilities.md`: headings for owned areas, recurring responsibilities, decision rights, escalation notes.
- `preferences.md`: headings for communication, collaboration, decision-making, focus/work style.
- `availability.md`: headings for working hours, response expectations, planned constraints, capacity notes.
- `background.md`: headings for professional background, domain context, notable projects, personal operating notes.

## Architecture Decision

Store human capability documents in Postgres, not the filesystem.

Rationale:

- Humans belong to company data, not local adapter runtime data.
- The future auth model has one account across multiple companies, so capability docs must be company-specific.
- Hosted deployments and exports should work without local bundle paths.
- Company access checks and activity logs are straightforward.
- Agents can read this later through an explicit API/context step without bypassing Memory approval rules.

Do not auto-index capabilities into Memory in this scope. Future agent consumption should be an explicit follow-up that answers:

- which agents may read which human capability docs
- whether docs become context snippets, Memory candidates, or both
- whether founder/admin approval is needed before agent-wide reuse
- how stale content and version history are handled

## Data Model

Add `company_user_capability_documents`.

Proposed columns:

- `id uuid primary key defaultRandom`
- `company_id uuid not null references companies(id) on delete cascade`
- `user_id text not null`
- `slug text not null`
- `filename text not null`
- `title text not null`
- `kind text not null`
- `content text not null default ''`
- `sort_order integer not null default 0`
- `is_standard boolean not null default false`
- `created_at timestamptz not null default now`
- `updated_at timestamptz not null default now`
- `created_by_user_id text`
- `updated_by_user_id text`

Indexes/constraints:

- unique `(company_id, user_id, slug)`
- index `(company_id, user_id, sort_order)`

Validation:

- slug/filename must be normalized and safe
- only `.md` filenames in MVP
- standard slugs reserved
- content max size: recommend 100 KB per doc for MVP
- title max size: recommend 120 characters

Open schema detail for implementation:

- Consider foreign key to active membership if a stable table-level FK exists for `(company_id, principal_id)`. If not, enforce membership in service reads/writes to avoid awkward cross-table constraints.

## Shared Contracts

Add team capability types:

- `HumanCapabilityDocumentSummary`
- `HumanCapabilityDocumentDetail`
- `HumanCapabilityDocumentKind`
- `HumanCapabilityBundle`

Add validators:

- `createHumanCapabilityDocumentSchema`
- `updateHumanCapabilityDocumentSchema`
- `reorderHumanCapabilityDocumentsSchema` if reorder is included

Recommended response shape:

```ts
interface HumanCapabilityBundle {
  companyId: string;
  userId: string;
  documents: HumanCapabilityDocumentSummary[];
}
```

## API Plan

Add routes under the existing team route family:

- `GET /companies/:companyId/team/users/:userId/capabilities`
- `GET /companies/:companyId/team/users/:userId/capabilities/:documentId`
- `POST /companies/:companyId/team/users/:userId/capabilities`
- `PATCH /companies/:companyId/team/users/:userId/capabilities/:documentId`
- `DELETE /companies/:companyId/team/users/:userId/capabilities/:documentId`

Service responsibilities:

- assert company access
- assert target user is an active company member
- ensure standard docs on list/detail
- seed standard docs with default markdown templates when absent
- seed standard docs during direct member creation when possible
- enforce edit permission
- prevent deletion of standard docs
- validate document ownership `(company_id, user_id, document_id)`
- activity log all mutations:
  - `team.capability_document_created`
  - `team.capability_document_updated`
  - `team.capability_document_deleted`

## UI Plan

In `HumanDetail`:

- add `capabilities` tab route handling
- fetch capability bundle only when active tab is `capabilities`
- show a left document rail or compact list of documents
- show selected document preview by default
- provide edit mode with markdown textarea/editor
- provide `Add Document` for custom `.md` documents
- provide delete only for custom documents
- keep standard documents visible even when empty, with a quiet empty state

Recommended MVP layout:

- full-width section, not card-in-card
- left rail: standard docs first, custom docs after
- main pane: document title, filename, preview/edit toggle, save/cancel actions
- mobile: document selector becomes a dropdown/stacked list above editor

Reuse patterns:

- `MarkdownBody`/markdown rendering patterns for preview
- existing dialog/button/tab styles from `HumanDetail`
- existing query invalidation style through `queryKeys.team`

Do not include the top profile snapshot in this tab.

## TDD Implementation Order

1. Shared contract tests
   - validators accept standard document update payloads
   - validators reject non-`.md`, path traversal, reserved duplicate slugs, overlong content/title

2. DB schema test
   - table exists
   - company/user/slug unique index exists
   - company cascade exists
   - standard/custom columns exist

3. Server service tests
   - listing ensures standard docs
   - standard docs are idempotently ensured
   - custom docs can be created
   - custom docs can be updated
   - custom docs can be deleted
   - standard docs cannot be deleted
   - cross-company document access is rejected/not found
   - inactive/non-member target user is rejected/not found
   - edit permission allows self/founder/system admin and denies other members

4. Server route tests
   - GET bundle returns standard docs
   - POST/PATCH/DELETE validate payloads
   - mutation routes activity-log expected action names
   - permission failures return consistent status

5. UI unit tests
   - tab appears and routes correctly
   - standard documents render in rail/list
   - empty standard doc state is useful
   - edit/save sends correct API payload
   - add custom document flow works
   - delete custom document hides for standard docs
   - permission read-only mode disables editing

6. E2E tests
   - create/add a human or use seeded member
   - open human detail > Capabilities
   - verify standard docs are present
   - edit `skills.md`, save, reload, content persists
   - add custom `portfolio.md`, save content, reload, content persists
   - delete custom doc and verify it disappears
   - verify standard doc delete is unavailable
   - verify Overview/Roles still load after capability changes

7. Full verification
   - `pnpm db:generate`
   - focused DB/shared/server/UI tests
   - focused Playwright E2E
   - `pnpm -r typecheck`
   - `pnpm test:run`
   - `pnpm build`

## Non-Goals For This Scope

- No automatic Memory creation or Memory indexing.
- No agent runtime context injection yet.
- No resume parsing/import automation.
- No LinkedIn scraping/import.
- No fine-grained capability RBAC.
- No version history beyond `updated_at` and activity log.
- No file uploads for resume PDFs.

## Follow-Up Scopes

### Scope 3A: Agent Consumption

Build an explicit context assembly path where agents can receive selected human capability docs for tasks, routing, and escalation.

### Scope 3B: Capability Search

Search humans by capability, skill, responsibility, or availability across company members.

### Scope 3C: Imports

Add resume paste/import, LinkedIn/profile import, and optional PDF attachment pipeline.

### Scope 3D: RBAC Hardening

Add explicit grants for capability editing and sensitive document visibility.

### Scope 3E: Version History

Add document revisions, restore, and diff.

## Product Decisions Needed

Recommended defaults:

- Standard docs: `resume.md`, `skills.md`, `responsibilities.md`, `preferences.md`, `availability.md`, `background.md`.
- Standard docs cannot be deleted.
- Custom docs are allowed and must end in `.md`.
- All company members can view.
- Self/founder/system admin can edit.
- Store markdown in DB.
- Do not wire into Memory or agent prompts in this scope.

If these defaults are accepted, implementation can start without further product questions.

## Plan Review

### Engineering Review

The plan is executable and aligns with the existing codebase. The most important correction from the initial idea is storage: human capabilities should not reuse agent filesystem bundles. A DB table keeps company scoping, exports, hosted deployments, and future RBAC sane.

Key risks and mitigations:

- Risk: capabilities become a backdoor Memory layer.
  - Mitigation: no auto-indexing or agent prompt injection in this scope.
- Risk: company/user isolation bugs.
  - Mitigation: service-level active membership checks and route tests for cross-company access.
- Risk: standard docs duplicate profile fields.
  - Mitigation: no snapshot/profile section in the tab; profile remains in the header modal.
- Risk: markdown editor complexity balloons the scope.
  - Mitigation: start with preview/edit/save plus custom doc CRUD; defer revisions/import/search.
- Risk: future auth/RBAC refactor conflicts.
  - Mitigation: mirror current profile permissions and isolate permission checks in service helpers.

### Test Review

The test plan covers all required layers for this scope:

- schema/contract tests
- service unit tests
- route integration tests
- UI component/page tests
- Playwright E2E
- full typecheck/test/build verification

The highest-value E2E path is edit `skills.md`, add/delete `portfolio.md`, reload, and verify Overview/Roles still work. That proves persistence, CRUD, tab routing, and no regression to the earlier human page scopes.

### Product Review

`Capabilities` is the right tab name because it can hold resume, skills, responsibilities, preferences, and availability without turning the page into HR software too early.

The plan should not create additional tabs yet. `Roles` is authority. `Capabilities` is knowledge. `Overview` is operational state. `Settings` is administrative controls.
