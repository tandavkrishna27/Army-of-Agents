---
title: "Cloud plugin and external-adapter execution policy"
description: "Why AoA Cloud blocks host extension code until each execution path has an isolated runtime."
---

# Cloud plugin execution policy

AoA Cloud may display metadata for plugins installed before this policy, but it
rejects new plugin installs, reinstalls, and upgrades because JavaScript plugin
manifests are executable modules. It also does not execute plugin workers or
plugin-provided browser code in the shared control plane. All trust
tiers, including `core`, are blocked until plugin workers have an OS-isolated
runtime with an enforceable network boundary.

The policy is fail-closed and has no operator override. To run a plugin today,
use an AoA self-hosted deployment in `local_trusted` or `authenticated` mode.

## What is blocked

In `cloud_auth`, AoA rejects:

- worker activation at lifecycle entry and again at the process-manager and
  `fork()` sinks;
- package install, reinstall, upgrade, and executable manifest import before
  any npm/local package I/O reaches the loader;
- plugin UI contributions and same-origin `/_plugins/*/ui/*` bundles;
- plugin RPC bridge, stream, job, tool, and webhook runtime surfaces.
- external-adapter npm install, reinstall, and uninstall lifecycle scripts;
- external-adapter server imports, runtime reloads, and browser UI-parser code.

Persisted metadata and validated manifest JSON from pre-existing rows may remain
visible so operators can understand what was installed. AoA Cloud does not load
manifest JavaScript to obtain that metadata. A stale `ready` database row is never treated as
authority to execute code: runtime gates apply immediately, and server startup
reconciles the row to a blocked error.

External adapters are a separate host-extension boundary. They execute in the
server process and may also ship browser parser code. Those routes return code
`EXTERNAL_ADAPTER_EXECUTION_BLOCKED_IN_CLOUD` before npm, local-path I/O, or
dynamic `import()`. Isolating plugin workers alone is not sufficient to remove
the external-adapter block; adapters need their own reviewed execution and
browser-code isolation design.

## Stable error contract

Blocked HTTP surfaces return `503` with:

```json
{
  "error": "Plugin execution is blocked on AoA Cloud until isolated workers are available",
  "code": "PLUGIN_WORKER_BLOCKED_IN_CLOUD",
  "docs": "/docs/guides/cloud-plugin-execution"
}
```

The plugin row persists `status="error"`,
`statusReasonCode="PLUGIN_WORKER_BLOCKED_IN_CLOUD"`, and an actionable
`lastError`. A successful non-error lifecycle transition clears both failure
fields; ordinary plugin failures use a null structured reason.

External-adapter execution routes use the same HTTP status and docs pointer
with their distinct stable code:

```json
{
  "error": "External adapter installation and execution are blocked on AoA Cloud until isolated workers are available",
  "code": "EXTERNAL_ADAPTER_EXECUTION_BLOCKED_IN_CLOUD",
  "docs": "/docs/guides/cloud-plugin-execution"
}
```

## Operations and rollout

Deploy the generated database migration before the application code. On first
boot, verify that every previously-ready cloud plugin is reconciled and that no
worker PID, plugin UI bundle, bridge, or stream is available. Blocked activation
logs contain only plugin/company identifiers, activation source, sink, reason
code, and the process-local blocked-attempt count; plugin config and secrets are
never logged. The structured events are `plugin.worker.cloud_blocked` (bounded
source/reason diagnostic counters) and `plugin.worker.cloud_boot_reconciled`
(boot count and current process-local reconciliation gauge). Marketplace
operation rows retain `errorCode` and `errorDocs`, so clients key on the stable
code rather than human diagnostic text.

Agent gVisor work is a separate execution pool and does not isolate plugin
workers. Removing this cloud block requires a separately reviewed plugin-worker
isolation design and migration plan.
