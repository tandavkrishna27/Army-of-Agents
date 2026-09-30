# Universe production-entry qualification

Run from the repository root on a non-root Linux host with the repository's
Playwright Chromium and system dependencies installed:

```sh
pnpm exec playwright test --config tests/universe-production/playwright.config.ts
```

The configuration starts its own private loopback server, new AoA home and
embedded PostgreSQL database. It rejects an ambient `DATABASE_URL` so it cannot
silently seed an existing database. `AOA_AUTH_E2E_PORT` and
`AOA_AUTH_E2E_DB_PORT` select unused test ports. Stop task-owned leftover processes
before reusing ports after an interrupted run; never stop an unrelated service.

`AOA_UNIVERSE_CHROMIUM_PATH` optionally points to a locally installed matching
Chromium executable. It changes browser launch only. Session setup uses the
existing token-gated test-support mint on this private test server; normal
Better Auth middleware validates subsequent requests. Google OAuth login and
real provider execution are not part of this qualification.

The test visits the company-scoped `/universe` application route, not a development
harness. Layouts and comments use real HTTP APIs and database transactions.
The lost-response case forwards the real PATCH, verifies its success, then drops
only the browser response to exercise uncertainty recovery; no synthetic layout
responses are supplied.

This is technical evidence for the bounded E1.2/E2.4 consuming join. It does not
complete all task entry routes, renderer-specific checkpoints, the final Universe
tray rollout or product UAT.
