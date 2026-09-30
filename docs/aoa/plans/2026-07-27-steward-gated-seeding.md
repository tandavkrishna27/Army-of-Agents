# Phase 4B — Steward Marketplace Ownership

**Date:** 2026-07-27

**Repositories:** `MeteoriteLabs/AoA`, `MeteoriteLabs/aoa-marketplace`
**Precondition:** Phase 4A legacy Steward adoption is on `AoA/main` (`299e8fbf`)

## Goal

Make Steward a normal member of the marketplace-managed default crew without
removing the offline/degraded legacy fallback.

The change is defense in depth:

1. The marketplace publisher refuses to produce a catalog when the protected
   default-crew/Steward relationship is broken.
2. AoA refuses a stale, incomplete, or inconsistent default-crew package before
   it can commit a managed roster without Steward.

## Verified Current State

- The marketplace source and live CDN both publish one active
  `agent:aoa-curated/aoa-steward`.
- The default crew contains ten agents and names Steward in:
  - `content/teams/default-crew/manifest.json` `requires[]`;
  - `content/teams/default-crew/team.json` `agents[]`;
  - `content/teams/default-crew/team.json` `manifest.installOrder`.
- Steward's marketplace template matches the application fallback on its role,
  sweep trigger, and two-tool allowlist.
- Phase 4A can adopt a historical NULL-origin legacy Steward in place.
- Today `ensureInfrastructureAgents` still runs `ensureSteward` for every
  company, including marketplace-managed companies.

## Ownership Boundary

```text
every company
└── ensureInfrastructureAgents
    └── Commander

marketplace-managed company
└── default-crew package
    └── 10 crew agents, including Steward

unmanaged / unavailable / incomplete marketplace
└── ensureCrewAgents
    └── legacy crew fallback, including Steward
```

Company creation must keep its existing ordering:

1. Read `isCrewMarketplaceManaged` before seeding.
2. Seed config and Commander.
3. Attempt marketplace provisioning when not already managed.
4. On a proven pre-commit failure, run the legacy crew fallback.

Startup and config-change paths continue to seed Commander first, then skip the
entire legacy crew half when the company is marketplace-managed.

## AoA PR

### Runtime guard

- Require the active default-crew catalog item to declare the active Steward
  agent dependency before starting an install.
- During team preflight, require the fetched default-crew `team.json` body to
  contain Steward before any writes.
- Treat either mismatch as an unavailable/failed marketplace bootstrap so
  company creation follows the existing legacy fallback.
- Do not perform post-commit validation followed by legacy seeding; that could
  overwrite a partially installed managed roster.

### Seeder move

- Remove `ensureSteward` from `ensureInfrastructureAgents`.
- Add `ensureSteward` to `ensureCrewAgents`.
- Preserve serial, per-step failure-tolerant execution.
- Add Steward to `LEGACY_CREW_SEEDER_COVERAGE`.

### Active contract cleanup

Update live comments and assertions that still describe Commander and Steward
as the unconditional infrastructure pair. Correct old clobber descriptions:
legacy re-seeding can rewrite adapter/runtime allowlist, while the current
instruction-bundle path preserves founder customization.

Do not rewrite historical plans wholesale. Add a dated amendment where a
locked architectural decision's present-tense contract is now inaccurate.

### AoA regressions

- Managed boot/config-change paths run Commander but not the legacy Steward.
- Unmanaged and degraded paths still produce Steward.
- A catalog missing Steward from `requires[]` degrades before install.
- A team body missing Steward fails during preflight before writes.
- Successful company creation installs exactly one marketplace-owned Steward.
- Re-running the managed startup boundary preserves a deliberately drifted
  Steward runtime sentinel, its published origin, trigger, and row identity.
- Legacy coverage diagnostics recognize Steward as provided by the fallback.

## Marketplace PR

Add a fatal source/publish invariant for the protected default crew:

- Steward package source exists with the canonical catalog id.
- Default-crew `manifest.json` requires Steward exactly once as an agent.
- Default-crew `team.json` contains Steward exactly once.
- `team.json` install order contains Steward exactly once.
- The final aggregated catalog still contains active Steward and an active
  default crew requiring it.

This validation must terminate aggregation/validation with a non-zero result.
Silently excluding the bad team and publishing the rest of the catalog is not
acceptable.

### Marketplace regressions

- Current repository content passes.
- Missing Steward package fails.
- Missing/duplicate/wrong-type manifest dependency fails.
- Missing/duplicate body member fails.
- Missing/duplicate install-order entry fails.
- A catalog-stage rejection of Steward/default-crew fails publication.

## Non-goals

- Full runtime schema validation for arbitrary team templates (Phase 4b-prime).
- Team update/reconcile implementation.
- Changes to Steward instructions, permissions, or trigger semantics.
- Chronicler migration.
- Database schema changes.

## Verification

### AoA

```sh
pnpm exec vitest run \
  server/src/__tests__/crew-seeding.test.ts \
  server/src/__tests__/crew-seeding-marketplace-gate.test.ts \
  server/src/__tests__/aoa-bootstrap-wiring.test.ts \
  server/src/__tests__/internal-agent-config-reensure.test.ts \
  server/src/__tests__/crew-provisioning.test.ts

pnpm exec vitest run server/src/__tests__/crew-marketplace-bootstrap.integration.test.ts
pnpm exec vitest run server/src/__tests__/crew-repair.integration.test.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

Windows may skip PostgreSQL integration files; Linux CI is the authoritative
proof for those cases.

### Marketplace

```sh
pnpm --filter @armyofagents/aoa-marketplace-builder test
pnpm --filter @armyofagents/aoa-marketplace-builder typecheck
pnpm validate
pnpm build
```

## Rollout

The two PRs are independently safe:

- The marketplace invariant can land first and protects future publications.
- The AoA guard still lands because old bundled/cached catalogs remain possible.
- Phase 4B's seeder move is enabled only with both AoA preflight checks present.

## GSTACK REVIEW REPORT

### Summary

The original line move was insufficient because the application accepts two
independent marketplace representations: the catalog manifest and the fetched
team body. Either can omit Steward while still allowing a managed team commit.
The reviewed design validates both before writes and retains legacy fallback.

| Runs | Status | Findings |
|---:|---|---:|
| 1 | PASS | 3 addressed, 0 unresolved |

**VERDICT:** READY TO IMPLEMENT — producer and consumer guards are paired,
legacy adoption/fallback remains intact, and no unresolved design decision
remains.

### Architecture

- No schema, API, or UI changes.
- Existing marketplace gate and fallback paths are reused.
- Existing company-create ordering is preserved.
- Producer and consumer enforce the same protected-roster invariant.

### Failure Modes

- Stale catalog: rejected before dispatch; legacy fallback runs.
- Divergent team body: rejected during preflight; no team/agent writes occur.
- Marketplace outage: existing legacy fallback runs, including Steward.
- Managed startup/config change: Commander is refreshed; marketplace Steward is
  untouched.
- Historical legacy Steward: Phase 4A adoption remains idempotent and available.

### Test Strategy

Unit tests cover branch selection, coverage diagnostics, and publisher
validation. Real PostgreSQL integration tests cover company creation, preflight
atomicity, ownership, identity preservation, and repeat execution. Linux CI is
required for authoritative integration proof.

### Scope Decision

The founder selected the complete behavior, tests, and active-contract cleanup
scope. Full generic team-template validation remains a separate phase.

NO UNRESOLVED DECISIONS
