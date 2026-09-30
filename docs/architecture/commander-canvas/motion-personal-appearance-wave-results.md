# B09 — motion and personal appearance results

**Implemented:** 2026-09-20
**Packages:** E8.1/1.b, E8.1/2.a, E1.1/5, E1.4/2

## Delivered

- Added the missing revisioned, company-and-user-scoped Universe preference producer. Reads return an acknowledged snapshot; patch and reset use compare-and-swap revisions and return the latest acknowledged snapshot on conflict.
- Added the generated `universe_preferences` migration and kept the storage contract limited to presentation preferences. Activity records contain changed preference keys, not preference values or workspace content.
- Added one Universe settings section covering appearance, canvas, Commander presentation, captions, tray behavior and rail visibility. Draft edits are separate from acknowledged values, with explicit save, discard, reset and conflict recovery.
- Applied only acknowledged preference revisions to the Universe route. Theme, accent, density, grid, blob treatment, motion and shell visibility are presentation changes and do not probe media devices or start providers.
- Added deliberate viewport navigation for user and Commander references. Off-screen work moves into a readable viewport only for deliberate requests, defers while the user types or manipulates the canvas, rejects stale generations and highlights the resolved panel after navigation.
- Added shared full, subtle and reduced motion tokens. Operating-system reduced-motion preference overrides animated modes; reduced motion updates state immediately without a misleading visual clone.
- Minimize now commits durable layout state before rendering a short, noninteractive visual proxy. The proxy cannot receive focus or dispatch panel actions.
- Added AA-oriented light/dark theme surfaces and accent choices with a minimum 3:1 non-text boundary contrast in the supported theme matrix.

## Boundaries retained

- Preferences do not contain chat text, file contents, credentials, task data or canvas geometry.
- Camera movement never runs for background notifications and is cancelled by direct user camera input.
- Saved preferences are the source of truth; unsaved drafts never affect the active Universe presentation.
- Voice/media capability and provider readiness remain separate from blob and caption presentation preferences.

## Verification

- Focused UI regression: 63 tests passed across workspace navigation, viewport math, settings ownership and preference behavior.
- Recursive workspace typecheck passed.
- Production build passed with the repository's existing Vite dynamic-import and large-chunk warnings.
- Full repository suite: 18,144 passed, 98 skipped and 176 failed. The failed-test count is unchanged from B08 and remains attributable to the known Windows Node 24/Drizzle ESM collection cycle plus unfinished worker-placement/session suites. The new UI tests passed; the new server route suite is covered by typecheck but is part of the same Windows Drizzle collection limitation.
