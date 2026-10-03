---
title: "Moving to the AoA clean break"
summary: "Current installation and contract guidance"
---

AoA adopted AoA-only runtime and distribution contracts on 2026-09-30. There are no existing AoA product installations to migrate. Historical upgrade records remain under `docs/archive/` for reference.

For a source checkout, run `pnpm install` and `pnpm dev`. The API and UI run at `http://localhost:3100`. Leave `DATABASE_URL` unset to use embedded PostgreSQL. Use `pnpm aoa` for CLI commands in this repository. See [local development](local-development.md), [environment variables](environment-variables.md), and [wire contracts](../architecture/wire-compat.md) for current configuration.

Before restoring an older database or company bundle, review the current import behavior and create an explicit backup. AoA does not promise compatibility with undocumented or obsolete formats.
