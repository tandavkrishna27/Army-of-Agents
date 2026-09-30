# Embedded PostgreSQL Port Sweep

**Status:** Independent maintenance track
**Repository:** `MeteoriteLabs/AoA`

## Outcome

Remove Linux CI port-collision flakes by migrating embedded PostgreSQL tests to
the shared port allocator without changing production behavior.

## Scope

- Replace probe-only fixed/random port selection with
  `allocateEmbeddedPgPort()`.
- Migrate the identified embedded-PG test files mechanically.
- For hub suites that reuse one server for the module, keep one module-level
  `let port` and release ownership only after teardown.
- Preserve Windows skip behavior and validate the real integration path in
  Linux CI.

## Isolation

This work shares no runtime dependency with marketplace recovery, connector
publication, or team-template updates. It may run in a separate worktree after
the incident branch is stable and must not be used as a reason to delay A1/A2.

## Verification

1. Focused migrated suites pass repeatedly under parallel Linux load.
2. No fixed embedded-PG port remains in the target files.
3. Port ownership is released after success and failure teardown.
4. `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` pass.

## Exit Criteria

- All scoped suites use the shared allocator.
- A high-contention Linux CI sweep shows no address-in-use failure.
- No production server or database path changes.

The original file inventory and per-suite notes remain in
`archive/2026-07-28-testing-marketplace-recovery-and-followups-umbrella.md`
until implementation pickup.
