---
title: "Moving to the AoA clean break"
summary: "Current installation and contract guidance"
---

AoA adopted AoA-only runtime and distribution contracts on 2026-09-30. There are no existing AoA product installations to migrate. Historical upgrade records remain under `docs/archive/` for reference.

For a source checkout, run `pnpm install` and `pnpm dev`. The API and UI run at `http://localhost:3100`. Leave `DATABASE_URL` unset to use embedded PostgreSQL. Use `pnpm aoa` for CLI commands in this repository. See [local development](local-development.md), [environment variables](environment-variables.md), and [wire contracts](../architecture/wire-compat.md) for current configuration.

If restoring an older database or company bundle from the upstream project, review the source's current import behavior and use an explicit backup before trying it. The clean break does not promise automatic compatibility with inherited brand-specific formats.
