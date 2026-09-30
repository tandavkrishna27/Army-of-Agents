# WRK-001 Result — Worker daemon bootstrap (config, health, metrics, boundary)

**Status:** `complete`
**Disposition:** `pass`
**Date opened (UTC):** `2026-08-12`
**Epic:** `E4-worker-daemon`
**Plan task:** `WRK-001 — Worker daemon package + config/health/metrics bootstrap + dependency-boundary gate (M)`
**Implementer:** `Claude (session worktree C:\e3)`
**Reviewer:** `Claude adversarial-review pass (independent-check acceptance model)`
**Start SHA:** `22eb79c1c995255b266abbc1e2f9e376806ea989`

The Start SHA is the committed Batch A plan revision (`docs(replatform): Batch A plans`).
The frozen E1 v1 protocol, the E2 tenant kernel, and E3 job-control are immutable inputs;
WRK-001 adds a **new leaf package** `packages/worker-daemon` and its dependency-boundary
gate and touches no existing runtime code. Distributed execution remains default-off.

## Acceptance model

Per the operator's chosen Wave-3 acceptance model, the multi-agent **adversarial review
pass is the independent check**. This ledger records the implementer attempt, the
adversarial findings, the fix round, and the fresh green evidence. No push is claimed here.

## Dependency and scope state

- WRK-001 is the E4 bootstrap. It creates `packages/worker-daemon` as a **leaf package**
  whose only runtime dependencies are `@armyofagents/worker-protocol` (frozen E1) and
  `pino` (structured logging). It adds no database access, no HTTP client, no provider
  contact, and **never reads a database URL** (a test asserts a set `*_DATABASE_URL` is
  ignored, not required, and not echoed).
- Deliverables: `config/` (env → frozen `WorkerConfig`), `health/` (loopback-only
  `/healthz` + payload-free `/metrics`), `metrics/` (bounded-label counter surface),
  `logger` (fail-closed field redaction), `shutdown`/`entrypoint-signals` (awaited
  teardown), and the standalone dependency-boundary gate
  (`scripts/lib/worker-daemon-boundary.mjs` + `scripts/check-worker-daemon-boundary.mjs`
  + `.test.mjs`) that mirrors the E1 `worker-protocol-boundary` pattern but permits Node
  globals for a daemon runtime.
- Scope stops at bootstrap. No poll loop, lease acquisition, device proof, or job
  execution (those are WRK-002/003/004+). Per **E4-D10**, custody and scope are
  orthogonal — there is no config-load trust/scope coupling.

## Implementation attempt 1 — 2026-08-12 — Claude

RED-first TDD across the bootstrap surface:

- `config.test.ts` / `config-matrix.test.ts` — env parsing, frozen output, defaults,
  loopback health host, DB-URL ignore, and the custody⊥scope acceptance matrix.
- `health-server.test.ts` — loopback bind enforcement (numeric-only; `localhost` name
  rejected), `/healthz` 200, payload-free `/metrics`, 404 for unknown paths.
- `metrics.test.ts` — bounded label-key allow-list.
- `logger-redaction.test.ts` — fail-closed sensitive-field redaction.
- `shutdown.test.ts` / `entrypoint-signals.test.ts` — awaited teardown ordering.
- `dependency-boundary.test.ts` — the package satisfies its own boundary gate.
- `scripts/check-worker-daemon-boundary.test.mjs` — the gate's mutation corpus (relative
  escape, symlink, extra/missing/forbidden dependency, wrong name, unreadable source).

## Independent adversarial review — 2026-08-12

The adversarial review pass found **1 blocking, 4 should-fix, and 3 nit** findings. The
blocking finding is a genuine security-theater defect: the boundary gate was blind to
`require()` — the exact class of bypass the E1 gate exists to prevent.

- **B1 (blocking) — boundary gate blind to `require()`/`createRequire`.** To permit Node
  globals (`process`, `Buffer`) for a daemon runtime, the initial gate dropped the shared
  `findForbiddenGlobals` scan entirely — which also silently removed CommonJS-`require`
  detection. A runtime source file could `const x = require("child_process")` or
  `import { createRequire } from "node:module"` and pass the gate, defeating the static
  import allow-list. **Fixed:** re-import `findForbiddenGlobals`; reject any `require(`
  token and the `node:module`/`module` bridge builtins, while still allowing the Node
  runtime globals. New REDs B1a/B1b/B1c cover `require()`, `module.require()` + its
  `node:module` import, and a bare `node:module` (createRequire source).
- **S1 (should-fix) — manifest dependency union incomplete.** The gate validated only
  `dependencies`; a forbidden dep hidden in `optionalDependencies`/`peerDependencies`/
  `bundledDependencies` would slip through. **Fixed:** the manifest check now unions all
  five dependency maps. New REDs cover each hiding place.
- **S2 (should-fix) — config error echoed the raw control-plane URL.** A malformed
  `AOA_WORKER_CONTROL_PLANE_URL` was interpolated verbatim into the thrown message (a
  credential-in-URL leak into logs). **Fixed:** the message names the env var and echoes
  only `url.protocol`, never the raw value.
- **S3 (should-fix) — invented custody↔scope coupling contradicted the model.** The
  initial config invented `os_keychain ⟹ owner` — a coupling absent from
  `worker-enrollment.ts`, `execution_targets`, and `workerPlatformSchema`. **Fixed:**
  removed the coupling; ratified the orthogonality as **E4-D10** in `decisions.md` and
  aligned the plan text; rewrote the config tests to accept every custody×scope pair.
- **S4 (should-fix) — bare-import allow-list traversal hole.** `pino/..` could escape the
  `pino/` subpath allowance. **Fixed:** reject any specifier containing a `..` segment.
  New RED covers `pino/..`.
- **N1 (nit, deferred) — logger passes `Error` objects through untouched.** Defense in
  depth: a future error carrying a secret in its message would render verbatim. The one
  **reachable** instance (S2) is fixed; a blanket message scrub is deferred to a WRK-002+
  hardening pass and noted here so it is not lost.
- **N2 (nit) — `localhost` in the loopback set.** A hosts-file could remap `localhost`.
  **Fixed:** loopback set is numeric-only (`127.0.0.1`, `::1`); the name is rejected.
- **N3 (nit) — metrics validated label keys but not values.** A caller could smuggle a
  tenant id/UUID in as a label **value**, blowing cardinality on `/metrics`. **Fixed:**
  `assertBoundedLabels` now also validates each value against a bounded low-cardinality
  token (`/^[a-z][a-z0-9_]{0,39}$/`) and never echoes the rejected value.

## Authority and failure behavior

- The worker daemon has **no tenant authority** and no database reach; it is a control-only
  runtime shell. Config load fails closed before any I/O on a bad endpoint, unparseable
  enum/boolean, or non-loopback health host.
- Health binds loopback only; `/metrics` is payload-free with bounded label keys **and**
  values — no organization/company/job identifier, secret, token, or session byte can
  appear as a metric label.
- The dependency-boundary gate is the fail-closed supply-chain seam: only the frozen E1
  package and `pino` are permitted; `require()`, the `node:module` bridge, relative
  escapes, symlinks, `..` traversal, and forbidden deps in any dependency map are rejected.

## Operator-directed Windows-local evidence

All commands ran from `C:\e3`. Linux CI remains the formal DEC-03 authority.

| Command / lane | Result |
|---|---|
| `pnpm --filter @armyofagents/worker-daemon exec vitest run` | PASS — 7 files, **45/45** |
| `node --test scripts/check-worker-daemon-boundary.test.mjs` | PASS — **46/46** (incl. new B1a/b/c, S1×3, S4 REDs now green) |
| `pnpm check:worker-daemon-boundary` | PASS — `worker daemon boundary: PASS` |
| `pnpm --filter @armyofagents/worker-daemon exec tsc --noEmit` | PASS — exit 0 |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870ce7509d8baa75409e0ab19da375c88a` | PASS — zero changed `packages/worker-protocol` file |
| `pnpm install --frozen-lockfile` | PASS — lockfile in sync (pino addition recorded) |

No focused lane failed. Frozen E1 has no changed file. The boundary gate's blocking-class
bypass (B1) is closed with executable RED coverage, and every should-fix and applicable nit
is resolved; the single deferred nit (N1) is defense-in-depth beyond the reachable S2 leak.

## Decision

WRK-001 is `complete` / `pass`. This ticket is not the E4 integration gate and authorizes
no push on its own; it is committed as part of the cumulative Wave-3 branch. Next: **WRK-002**
(worker enrollment + device proof consumption), which gates on JOB-002 acceptance.
