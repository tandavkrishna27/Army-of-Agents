---
title: "Wire-compat reference"
summary: "Identifiers that intentionally still say paperclip and why"
---

> **CI enforcement.** The `brand-check` job in `.github/workflows/pr.yml` (lines 99–260) is the runtime enforcement layer. It maintains an inline allow-list of every category below. If you add a new wire-compat surface, you must add it to that allow-list **and** document it here. If you remove one, remove it from both places.

---

## 1. `paperclipai` CLI bin alias

**What.** A secondary `bin` entry that lets users invoke the CLI as `paperclipai` (in addition to `aoa`).

**Where.**
- `cli/package.json:8` — `"paperclipai": "dist/index.js"` in the `bin` map
- Root `package.json:27` — workspace-level alias forwarding

**Why kept.** The alias preserves repository-local scripts and remains part of
the intended future scoped CLI artifact. It does not make `npx paperclipai`
safe: that npm package belongs to the upstream Paperclip project, while the
MeteoriteLabs AoA scoped CLI is not currently published.

**Retire when.** Usage telemetry shows zero `paperclipai` invocations for two consecutive minor version windows. Retirement is a one-line deletion in both `package.json` files; no migration is needed.

---

## 2. `PAPERCLIP_*` environment variables

**What.** Any `PAPERCLIP_*` env var is automatically mirrored to its `AOA_*` counterpart at module load, so existing shell profiles and `.env` files keep working.

**Where.**
- `server/src/env-compat.ts` — server-side mirror (runs at process startup)
- `cli/src/config/env-compat.ts` — CLI-side mirror (runs at process startup)

**Why kept.** Operators who set `PAPERCLIP_PORT`, `PAPERCLIP_DATA_DIR`, etc. in Docker Compose files, systemd units, or CI pipelines would have silent breakage if these were dropped without a migration window. The mirror is a one-time O(n) loop at startup and adds no ongoing cost.

**Note.** The mirror runs only in spawned Node processes. Bash scripts that directly `source` project shell helpers must be updated to `AOA_*` — the compat layer does not apply there.

**Retire when.** `PAPERCLIP_*` vars are documented as deprecated for one full release cycle, and a survey of public shell profiles / Docker Hub configurations shows no remaining usage.

---

## 3. Plugin wire protocol

**What.** Three identifiers that form the internal plugin host/guest boundary:
- `paperclipPlugin` — the manifest key in a plugin's `package.json` that declares the plugin entry point
- `__paperclipPluginBridge__` — global injected into the plugin sandbox for two-way message passing
- `__paperclipPluginToolDispatcher` and `__paperclip_*` — additional sandbox globals set by the plugin loader

**Where.**
- `packages/plugins/sdk/src/` — SDK-side references
- `ui/src/` plugin loader infrastructure (bridge injection)

**Why kept.** Every plugin ever published targets these wire names. Renaming them would silently break all existing plugins with no user-visible error — the plugin would load without the bridge and fail at first tool call. This is the highest-blast-radius wire-compat item in the codebase.

**Retire when.** A plugin SDK major version bump ships with a parallel-name support window (both `paperclipPlugin` and `aoaPlugin` manifest keys accepted, both bridge globals injected). After a documented deprecation period of at least one major version, the old names can be removed. Coordinate with any community plugin authors before cutting.

---

## 4. DB sentinels

**What.** Two sentinel values written into JSON payloads and workspace paths:
- `_paperclipWakeContext` — JSON key in `agent_wakeup_requests.payload` identifying the heartbeat wake context block (legacy constant)
- `/__paperclip_repo_only__` — workspace `cwd` sentinel meaning "use the repo root, not a per-task workspace path"

**Where.**
- `server/src/services/heartbeat.ts:85` — `LEGACY_WAKE_CONTEXT_KEY` constant; code dual-reads both `_paperclipWakeContext` and `_aoaWakeContext`; new rows are written with `_aoaWakeContext`
- `server/src/services/heartbeat.ts:87` and `server/src/routes/projects.ts` — `/__paperclip_repo_only__` sentinel; read path accepts both old and new sentinel value

**Why kept.** Existing rows in production databases were written with the old keys. Dropping the old read path before a backfill migration would cause heartbeat context to silently be `undefined`, producing incorrect agent behavior with no error log.

**Retire when.** Migration `0060_aoa_sentinels.sql` has been confirmed run on all production deployments (or included in the standard upgrade path for a full release). At that point the `LEGACY_WAKE_CONTEXT_KEY` constant and the legacy read branch in both files can be deleted.

---

## 5. `X-Paperclip-Run-Id` HTTP header

**What.** An HTTP request header that agents include in callbacks to identify the heartbeat run they belong to.

**Where.**
- `server/src/middleware/auth.ts:27` — read and forwarded to run-context middleware

**Why kept.** Deployed agents compiled against earlier SDK versions send this header name. The header is also documented in `HEARTBEAT.md` and the public API reference. Renaming requires updating every agent binary that performs callbacks, which cannot be done atomically.

**Retire when.** A new SDK ships `X-AoA-Run-Id`, agents are rebuilt against it, and a dual-read window (accepting both header names) has completed for at least one full release. The middleware change is a one-liner once that window closes.

---

## 6. `paperclipApiUrl` adapter-config field

**What.** A field name stored in the `agents.adapterConfig` JSON column for the OpenClaw adapter. It holds the base URL that the adapter calls back to.

**Where.**
- `ui/src/adapters/openclaw/config-fields.tsx` — wire-compat note in the field definition; UI renders this field name as the storage key

**Why kept.** The value is stored as-is in the database JSON column. Renaming requires a Drizzle migration that rewrites every OpenClaw agent's `adapterConfig` blob. Without a migration, renaming the UI field would silently read `undefined` for every existing agent.

**Retire when.** A Drizzle migration backfills `paperclipApiUrl` → `aoaApiUrl` in all `adapterConfig` blobs, and the read path in the OpenClaw adapter is updated to use the new key. Coordinate migration timing with the `0060_aoa_sentinels.sql` window if convenient.

---

## 7. Feedback envelope schemaVersion strings

**What.** Two version-string constants that tag outgoing feedback bundles:
- `paperclip-feedback-envelope-v2`
- `paperclip-feedback-bundle-v2`

**Where.**
- `server/src/services/feedback-bundles.ts:29–30`

**Why kept.** Any external feedback receiver (analytics pipeline, telemetry backend) that was configured during the Paperclip era parses on the exact string `paperclip-feedback-envelope-v2`. Changing the version string unilaterally would cause those receivers to discard or misparse the bundles. The version string is the contract, not a display label.

**Retire when.** A v3 envelope shape is designed, the new `aoa-feedback-envelope-v3` string is shipped, and receivers are updated to accept both. Deprecation timeline and the migration procedure are documented in `docs/deploy/telemetry.md`. Drop v2 only after the deprecation window is closed.

---

## 8. OpenClaw wire fields `paperclip_session_key` / `paperclip_stream_transport`

**What.** Two JSON field names included in the wire payload sent to running Hermes / OpenClaw deployments during agent execution.

**Where.**
- `packages/adapters/openclaw/src/server/execute-webhook.ts`
- `packages/adapters/openclaw/src/server/execute-sse.ts`

**Why kept.** The field names are part of the wire format consumed by external Hermes and OpenClaw processes. Renaming them unilaterally would silently break any deployment whose Hermes version predates the rename. This is **Phase 6 of the rename plan** and is explicitly deferred pending upstream coordination with the Hermes/OpenClaw maintainers (locked as **Decision #92** — see `docs/architecture/decisions.md`).

**Retire when.** Upstream Hermes/OpenClaw ships a version that accepts the new `aoa_session_key` / `aoa_stream_transport` field names (or supports both), the minimum required Hermes version in `package.json` is bumped to that release, and the old field names are removed from the execute files.

---

## 9. `PaperclipPluginManifestV1` type alias

**What.** A TypeScript type exported from the plugin SDK that describes the shape of a plugin manifest.

**Where.**
- `packages/plugins/sdk/src/types.ts` — exported as `PaperclipPluginManifestV1` (and re-exported from the SDK index)

**Why kept.** Every plugin that imports from the SDK types this as `PaperclipPluginManifestV1`. Removing or renaming the export is a compile-time breaking change for all plugin authors. The type alias currently re-exports the same underlying shape as `AoAPluginManifestV1`.

**Retire when.** Plugin SDK bumps to a major version, `AoAPluginManifestV1` becomes the canonical name, and `PaperclipPluginManifestV1` is kept as a deprecated re-export for one major version before deletion. Announce via SDK release notes.

---

## 10. `local@paperclip.local` synthetic actor identifier

**What.** A synthetic user identifier string used as the actor for unauthenticated local-trusted requests in audit log and access log rows.

**Where.**
- `server/src/routes/access.ts:1336` — string literal assigned to the synthetic actor

**Why kept.** Renaming would create a discontinuity in audit history: rows before the rename show `local@paperclip.local`, rows after show a new identifier. Log queries and compliance audits that match on the actor string would silently miss the pre-rename history. The identifier is in a non-user-visible position (audit log only) but the history split is the blocker.

**Retire when.** A decision is made to formally split audit history at a version boundary (e.g. a major release), a migration appends a note to historical rows, and the codebase write path is updated. This is low priority; leave until a major audit-log schema revision makes the migration necessary anyway.

---

## 11. `@paperclipai/*` published npm package scope

**What.** The npm organization scope `@paperclipai` under which packages such as `hermes-paperclip-adapter` and `@paperclipai/create-paperclip-plugin` are published.

**Where.** External npm registry — not owned by this repository.

**Why kept.** These packages are upstream Paperclip publications. AoA cannot rename them. Package consumers reference them directly by scope; any rename requires the upstream Paperclip project to publish under a new scope and update all downstream install instructions.

**Retire when.** Not actionable from this repo. Track via the upstream Paperclip project.

---

## 12. In-container `/paperclip` path and `paperclip` database name

**What.** Two infrastructure-level identifiers baked into the Docker image:
- `AOA_HOME=/paperclip` — the home directory path inside the container
- `paperclip` — the PostgreSQL database name created by the embedded-postgres bootstrap

**Where.**
- `Dockerfile` — `ENV AOA_HOME=/paperclip` and related `RUN mkdir` / `WORKDIR` directives
- `server/src/index.ts:331–366` — embedded-postgres bootstrap passes `database: 'paperclip'` to `initdb`

**Why kept.** Existing Docker volume mounts point to `/paperclip` (e.g. `-v aoa-data:/paperclip`). Renaming the path orphans those volumes silently — the container starts healthy but with a fresh empty database. Renaming the database name requires users to either drop and recreate, or run `ALTER DATABASE paperclip RENAME TO aoa` before upgrading.

**Retire when.** A major version migration guide is published that walks operators through remounting volumes to `/aoa` and renaming the database. The Docker image publishes both a legacy path symlink (`/paperclip → /aoa`) and the new canonical path for one major version, then removes the symlink. Gate this on a coordinated release announcement.
