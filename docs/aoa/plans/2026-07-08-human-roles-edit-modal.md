# Human Roles Edit Modal Implementation Plan

**Goal:** Move human role hierarchy editing out of the Roles tab body and into a focused modal launched from the Authority card.

**Architecture:** Keep the existing team role API, query invalidation, and save mutation. The Roles tab becomes read-first: Authority and Responsibilities stay visible, while role, department, and reports-to controls render only inside a `Dialog`.

**Tech Stack:** React, TanStack Query, local Dialog/Select/Button components, Vitest + Testing Library, and Playwright for UI verification.

## Scope

- Add an `Edit roles` action to the Authority card.
- Remove the inline Role & Department editor from the Roles tab.
- Add an `Edit Roles` modal containing Role, Department, Reports-to, Cancel, and Save.
- Preserve self-founder lock behavior and permission messaging inside the modal.
- Close the modal on successful save and reset draft state when canceled.
- Update UI and E2E tests to drive the modal flow.

## Test Plan

- RED: update `ui/src/__tests__/HumanDetail.test.tsx` to expect no inline role comboboxes and a modal launched by `Edit roles`.
- GREEN: implement the modal and make focused UI tests pass.
- Update `tests/e2e/human-profile.spec.ts` so the role CRUD path opens the modal before changing role, department, and reports-to.
- Run `pnpm exec vitest run ui/src/__tests__/HumanDetail.test.tsx`.
- Run `pnpm --filter @armyofagents/ui typecheck`.
- Run `pnpm exec vitest run server/src/__tests__/team-role-routes.test.ts`.
- Run focused Playwright E2E for `tests/e2e/human-profile.spec.ts`.
- Run live browser verification against `http://127.0.0.1:3207`:
  - self-founder modal shows all controls disabled with lock note.
  - a fresh human can be changed to Team Lead, assigned to a department, assigned a manager, saved, reloaded, and verified.
- Run `pnpm build`.

## Product Follow-Up

After this modal edit pass, the next larger discussion is the human knowledge/profile layer: structured profile fields plus markdown-backed bio/resume/skills/responsibilities context that agents can use later.
