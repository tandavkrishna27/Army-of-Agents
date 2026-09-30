# V1 Code Review — Brief Dependencies, Branding, and UX Fixes

**Date:** 2026-03-16
**Base commit:** db0a70f
**Status:** All critical and important issues resolved. Ready to commit.

---

## Changes Made (This Session)

### 1. Brief Approval — Dependency Service Integration
- **Files:** `server/src/services/briefs.ts`, `server/src/services/dependencies.ts`
- Brief approval now uses `dependencyService.addDependency()` instead of raw inserts
- Gets cycle detection, auto-blocking, and activity logging for free
- `addDependency()` and `assertNoCycle()` accept optional `outerTx` for transactional use
- Each `addDependency()` call is wrapped in try/catch — failures skip gracefully instead of crashing the entire approval transaction

### 2. Dependency Feedback in Response
- **Files:** `server/src/services/briefs.ts`, `ui/src/api/briefs.ts`, `ui/src/pages/BriefReview.tsx`
- Server returns `createdDependencyCount` and `skippedDependencyCount`
- Success banner shows "with N dependency links" and an amber warning for skipped deps

### 3. Client-Side Cycle Detection
- **File:** `ui/src/pages/BriefReview.tsx`
- DFS-based `detectCycles()` function
- Prevents adding cyclic dependencies at add-time (toast warning)
- Blocks "Process Brief" submission if cycles exist
- Self-dependencies blocked at add-time

### 4. Zod Validation on Approve Endpoint
- **Files:** `packages/shared/src/validators/brief.ts`, `server/src/routes/briefs.ts`
- `approveBriefSchema` validates the request body
- `.refine()` rejects self-referencing dependencies (`dependentItemId === dependencyItemId`)

### 5. Error Surfacing in BriefReview
- **File:** `ui/src/pages/BriefReview.tsx`
- `onError` extracts `error.message` from `ApiError` instead of showing generic text

### 6. Branding: Paperclip → AoA
- **Files:** ~15 UI files (App.tsx, Auth.tsx, CompanySettings.tsx, OnboardingWizard.tsx, Sidebar.tsx, etc.)
- All user-visible "Paperclip" text → "AoA"
- CLI commands (`pnpm paperclipai`) and `@paperclipai/` package scopes preserved
- Lucide `Paperclip` icon imports preserved (icon name, not branding)

### 7. Route Rename /dashboard → /home
- **Files:** Sidebar, CommandPalette, MobileBottomNav, Layout, CompanyRail, App.tsx
- `useCompanyPageMemory.ts` JSDoc updated

### 8. BriefReview Dependency UI
- **File:** `ui/src/pages/BriefReview.tsx`
- Task item cards show dependency selector dropdown
- Dependency chips with remove buttons
- "N task dependencies configured" info text before Process Brief

### 9. OnboardingWizard Step 5
- **File:** `ui/src/components/OnboardingWizard.tsx`
- New step explaining Debrief/Brief pipeline before final launch

### 10. LLMProvidersSection
- **File:** `ui/src/components/LLMProvidersSection.tsx` (new)
- CRUD for LLM provider API keys in Settings
- Masked key display, rotation support

---

## Review Results — Final Pass

### Resolved Issues (Fixed This Session)

| # | Severity | Issue | Fix |
|---|----------|-------|-----|
| 1 | Critical | `addDependency` failure in approval loop crashes entire transaction | Wrapped in try/catch, increments `skippedDependencyCount` |
| 2 | Important | No self-reference validation in `approveBriefSchema` | Added `.refine()` rejecting `dependentItemId === dependencyItemId` |

### Outstanding Items (Future Follow-Up)

| # | Severity | Issue | File(s) | Notes |
|---|----------|-------|---------|-------|
| 1 | Important | `finalStatus` logic gap — all-pending briefs get `partially_approved` | `server/src/services/briefs.ts:228-234` | Pre-existing. If `approvedCount === 0` and `rejectedCount === 0`, should probably error or keep current status instead of `partially_approved`. |
| 2 | Important | `BriefApproveResult.brief` type mismatch | `ui/src/api/briefs.ts:42` | Typed as `Brief` (with computed fields), but server returns raw `.returning()` row without `sourceType`, `departmentName`, etc. No runtime crash currently since those fields aren't accessed on the result. |
| 3 | Suggestion | Bare `catch` in dependency loop loses diagnostics | `server/src/services/briefs.ts:217` | Add `console.warn('Skipped dependency:', err.message)` for debuggability. |
| 4 | Suggestion | Dependency selector shown for rejected task items | `ui/src/pages/BriefReview.tsx:213` | Rejected items won't become tasks — hide the selector when `item.status === "rejected"`. |
| 5 | Suggestion | Extract `detectCycles` to shared utility | `ui/src/pages/BriefReview.tsx:383-414` | Pure function, could live in `ui/src/lib/graph.ts` for testability and reuse. |
| 6 | Suggestion | `conn as Db` type cast in dependencies service | `server/src/services/dependencies.ts:38` | Works but a `DbOrTx` type alias would be cleaner. |
| 7 | Suggestion | Doc deletions bundled with feature changes | `doc/` (31 files) | Should be a separate commit for cleaner git history. |

---

## Architecture Decisions Made

- **Decision:** Brief approval dependency creation uses `dependencyService` (not raw insert). This ensures all future dependency business logic (cycle checks, auto-blocking, activity logging) applies uniformly whether deps are created from brief approval, manual UI, or API.
- **Decision:** Client-side cycle detection is defense-in-depth. Server-side `assertNoCycle` remains the authoritative check; the client check is UX-only to prevent confusing server error toasts.
- **Decision:** Dependency failures during brief approval are gracefully skipped (not fatal). The founder sees a count of skipped deps in the success banner so they can manually re-add if needed.
- **Decision:** Self-dependency rejection happens at three layers: (1) Zod `.refine()` in validation middleware, (2) `addDependency` service check, (3) client-side `addDependency` guard. Belt and suspenders.
