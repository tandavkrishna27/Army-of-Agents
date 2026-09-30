# Tenant Access-Required Polish — Design Spec

**Date:** 2026-07-31
**Branch:** `claude/multitenant-cloud` (same branch as the multi-tenant backend, PR #316 — this is complementary tenant-facing UI; keeps the one-PR-for-QA model).
**Status:** approved design, pre-implementation-plan.

## Context

The multi-tenant backend (P1–P5) is complete and Linux-CI-validated, and the app is already usable **company-centrically**: company invitations work end to end, per-company provider keys work, and organization membership auto-derives from company membership (one org per customer for the beta). A brainstorm YAGNI pass established that org-member management, org-settings, and the org-scoped providers connect/assign UI are **premature** for the beta (capabilities nothing enforces yet, or an enhancement gated on multi-company customers + missing backend routes). The one genuine, cheap gap is **access-required UX**.

This spec covers ONLY that gap. Explicitly out of scope: any org-management UI, any providers UI, the operator console (separate repo), any backend change.

## Current behaviour (verified)

- **Inaccessible company URL:** `ui/src/components/Layout.tsx:89-101` — when a `:companyPrefix` matches none of the user's accessible companies (`companiesApi.list()` returns only accessible companies), it **silently redirects** to the user's own first/selected company home. A shared link to a company you can't access bounces you elsewhere with no explanation.
- **403 mid-page:** a company-scoped API call the user lacks access to throws an `ApiError{status:403}` (`ui/src/api/client.ts`), which bubbles to the generic `ui/src/components/ErrorBoundary.tsx` — a generic error surface, not a friendly "no access." (Contrast: `ui/src/pages/InstanceSettingsPage.tsx:133-161` already renders a friendly panel on instance-admin 403.)
- **Naming collision:** the lobby labels the *companies* list "Organizations" — `ui/src/components/LobbySidebar.tsx:261` ("Organizations" heading), `:287` ("New organization" CTA → `/onboarding`, which creates a **Company**), and `ui/src/pages/Lobby.tsx:180` ("Your organizations"). Inconsistent with the rest of the app (which says "Company"/"Companies" everywhere), and now actively confusing because a real Organization entity exists (hidden, one-per-customer).

## Design

Three small pieces. No backend. No new routes on the server.

### 1. `AccessRequired` component

A single on-brand surface, composed from existing primitives (`components/ui/EmptyState` / `Card` / `Button`), rendered inside the normal app chrome where possible.

- **Message:** "You don't have access to this" + a secondary line naming what was requested when known (e.g. the company prefix from the URL, or a generic "this workspace" on a 403).
- **Primary action:** "Back to your companies" → navigates to the lobby (`/`).
- **No request-access affordance** in v1 — there is no org/company-level "request access to an existing company you're not in" flow today (join is invite-driven), so a request button would dead-end. (Noted as a possible follow-up if a self-serve request flow is ever added.)
- File: `ui/src/pages/AccessRequired.tsx` (page-level, so both triggers can render it), plus reuse as a component where a 403 is caught inside a laid-out page.

### 2. Membership-aware routing

Modify `ui/src/components/Layout.tsx`'s `companyPrefix` effect:

- Keep the existing **wrong-case / canonical redirect** (`:103-107`) — a prefix that DOES resolve to an accessible company but with different casing still auto-corrects.
- Keep the empty-companies path (`:85` → `/onboarding`) unchanged.
- Change the **no-match** branch (`:95-101`): instead of silently redirecting to the user's first company, render `AccessRequired` (with the requested prefix as context and "Back to your companies"). Rationale: a member landing on a company they can't access should be told, not silently bounced — this is the honest shared-link behaviour. (The user can still one-click to their own companies.)
  - Note the client cannot distinguish "company does not exist" from "exists but I'm not a member" (both are simply "not in my accessible list"); both correctly resolve to the same access-required surface.

### 3. 403 handling for company-scoped pages

- Add a small helper `isForbidden(err)` (checks `ApiError.status === 403`) if one doesn't already exist, and a lightweight boundary/handler so that a 403 from a company-scoped query renders the `AccessRequired` component instead of the generic `ErrorBoundary`. Prefer the smallest mechanism that fits the existing query/error pattern (e.g. a shared error-render branch keyed on `isForbidden`, mirroring `InstanceSettingsPage`'s existing 403 panel approach) rather than a broad new global boundary.
- Scope: company-scoped surfaces reached under `:companyPrefix`. Do not change instance-admin 403 handling (already good) or unrelated error handling.

### 4. Naming-collision fix

Copy-only edits (no behaviour change):
- `LobbySidebar.tsx`: "Organizations" → "Companies"; "New organization" → "New company".
- `Lobby.tsx`: "Your organizations" → "Your companies".
- Scan for any other user-facing "organization" string in the lobby surfaces that actually means Company and align it. Do NOT touch the real Organization concept (onboarding `CreateOrganizationStep`, the `organizations` API/types) — only the mislabeled company-list copy.

## Testing

- **Component test** (`AccessRequired`): renders the message + the "Back to your companies" action navigates to `/`. Vitest + RTL, mirroring `ui/src/onboarding/steps/__tests__/OrgStep.test.tsx`.
- **Routing test** (`Layout` no-match branch): given accessible companies A, B and a URL prefix for non-member company C, the `AccessRequired` surface renders (not a silent redirect to A). Keep/verify the existing wrong-case redirect still works (a lower-case prefix of an accessible company still auto-corrects).
- **403 handling test:** a company-scoped query rejecting with `ApiError{status:403}` renders `AccessRequired`, not the generic error.
- **Naming:** a small assertion (or snapshot) that the lobby renders "Companies"/"New company", not "Organizations". (Windows-runnable; UI tests run in jsdom.)
- Run from repo-root cwd: `pnpm exec vitest run --root ui <files>`.

## Files touched (anticipated)

- Create: `ui/src/pages/AccessRequired.tsx` (+ test).
- Modify: `ui/src/components/Layout.tsx` (no-match branch → AccessRequired) (+ test).
- Modify/add: a small `isForbidden` helper + the company-scoped 403 render branch (+ test).
- Modify: `ui/src/components/LobbySidebar.tsx`, `ui/src/pages/Lobby.tsx` (copy) (+ small naming assertion).
- Possibly: a route entry for `AccessRequired` under the company layout if a dedicated route is cleaner than conditional render.

## Out of scope (explicit)

- **Broad per-page 403 adoption is intentionally incremental.** Piece 3 ships a
  shared, tested `isForbidden` helper + `AccessRequiredBoundary` render-branch,
  wired live at ONE representative company-scoped page — the Tasks page
  (`ui/src/pages/Issues.tsx`), whose primary `issuesApi.list` 403 unambiguously
  means "no access to this workspace" (mirrors the `InstanceSettingsPage`
  inline-403 panel). There is no shared company-level query below `Layout` to
  wrap once (each page owns its queries), and a QueryClient-wide `throwOnError`
  or a global boundary is explicitly rejected (it would regress the existing
  instance-admin + lobby inline 403 panels). Remaining company pages adopt the
  ready helper page-by-page as needed — a 403 should only render AccessRequired
  where it means "no access to this company," never for a single forbidden
  action on a page you otherwise can access.
- Org member management, org invitations UI, org settings UI.
- The org-scoped `provider_connections` connect/assign UI (and its missing backend routes).
- The operator console (separate repo).
- Any server/API change. Any `personal_subscription` UI (disabled in multi_tenant anyway).
- A self-serve "request access to a company I'm not in" flow (no backend for it; noted as a future follow-up).
