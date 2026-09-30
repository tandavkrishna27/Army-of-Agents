# CLI real-E2B hardening — first keyed-lane run findings + driver fixes

**Status:** `driver fixes landed (no-key green) + keyed re-fire queued`. The FIRST real-E2B run of the keyed lane (operator supplied `E2B_API_KEY`) executed 18 cases → **10 pass / 8 fail**, surfacing genuine mock-vs-real divergences the no-key suite structurally could not (`MockE2bTransport` is directive-driven and never execs a shell). This doc records the divergences, their driver fixes, and the no-key regression coverage added so they cannot silently return.
**Date (UTC):** `2026-08-19`. **Lane:** `keyed-e2b-conformance.yml` run `32210852793` (build-fix run — the prior run failed at the build step before any test ran; see below).
**Scope:** `packages/sandbox-e2b-provider` only. No frozen `worker-protocol` / `SandboxProvider`-port / `DE-*` edits.

## Pre-req: keyed-lane build fix

The keyed lane's "Build dist-only leaves" step ran `tsc` on `sandbox-provider-contract`, whose tsconfig `files`-includes `port-conformance.test.ts` (a compile-time port-conformance assertion) that imports the `@armyofagents/sandbox-fake-provider` devDep. The selective build never built that devDep → `TS2307` + cascading `TS2344` **before any real-E2B test ran**. The full `verify` gate builds everything, so this only bit the keyed lane. **Fix:** build `sandbox-fake-provider` first in the step (`keyed-e2b-conformance.yml`). After this, the real-E2B tests actually ran → the 8 divergences below.

## The 8 divergences (real E2B, e2b SDK 2.30.5) → fixes

| # | Case | Real-E2B symptom | Root cause | Fix | No-key cover |
|--|--|--|--|--|--|
| 1 | happy path `create→execute→…` | `CommandExitError 127` — `run: command not found` | adapter's default `execute` command was the placeholder `run` (not a real binary); the mock ignores the command | `buildExecuteInput` default `run` → `true` (portable exit-0) | — (mock ignores command) |
| 2 | CLI-002 file mutation | `exit 2` — `printf: usage` | **argv collapse:** `runCommand` did `[command,...args].join(" ")`, so `sh -c "printf 'x' > f"` became `sh -c printf 'x' > f` — `sh -c` got only `printf` | `shellJoin` POSIX-quotes every token | `real-transport-helpers.test.ts` (mutation-proven) |
| 3 | CLI-003 streaming | stdout `''` (expected `out-line`) | same argv collapse — the `printf` script never ran intact | (same `shellJoin`) | same |
| 4 | CLI-003 forced-timeout | `exit 1` — `sleep: missing operand` | same argv collapse — `sh -c "sleep 30"` → `sleep` with no operand, exited before the budget | (same `shellJoin`) | same |
| 5 | §2.3 no-existence-oracle | `SandboxError` ≠ `ResourceNotAvailableError` | an absent/foreign sandbox surfaces as a **base `SandboxError`** carrying an unmapped 4xx (e2b maps only 400/404/429 to named classes) — `#isNotFound` matched names only | `isE2bNotFound` also maps a base `SandboxError` with a 4xx-prefixed message → not-found (5xx stays transient; `CommandExitError` excluded) | `real-transport-helpers.test.ts` |
| 6 | CLI-004 inspect-oracle guard | same as #5 | same | same `isE2bNotFound` | same |
| 7 | CLI-003 cancel idempotency | `undefined` ≠ `E2bTransportNotFoundError` | `Sandbox.kill` resolves `false` (not a throw) for a gone sandbox → `terminate` never signalled not-found | `terminate` treats `killed === false` as `E2bTransportNotFoundError` | — (keyed) |
| 8 | CLI-001 real TTL | `Test timed out in 5000ms` | the in-test 5s expiry wait == vitest's 5000ms default | explicit `it(…, 30_000)` per-test budget | — (keyed) |

**The through-line (recurring lesson):** the mock is directive-driven — it never execs a shell nor calls the real SDK — so `execute`/`runCommand`/`terminate`/not-found were **green on mock leniency, not driver logic**. Real E2B is the first exec of these paths. Two of the fixes (argv-quoting, not-found classification) are pure functions now pinned by a no-key regression test (`real-transport-helpers.test.ts`), so the highest-risk divergences are caught without the key going forward; the four keyed-only fixes (default command, terminate-false, TTL budget) are re-proven by the keyed lane itself.

## Insurance

The two not-found assertions (§2.3, inspect-oracle) now carry a diagnostic message (`received <name>: <message>`) so that IF real E2B returns a 5xx/unparseable status for an absent target (rather than the expected 4xx), the next run's log names the exact shape for a precise follow-up — instead of a bare `SandboxError` ≠ `ResourceNotAvailableError`.

## Local verification (controller, no key)

| Command | Result |
|---|---|
| `vitest run real-transport-helpers.test.ts` | **7 passed** |
| mutation: `shellJoin` → naive join | **2 failed** (assertions load-bearing) → restored **7 passed** |
| `sandbox-e2b-provider test:run` (full no-key) | **39 passed + 18 keyed-skip** (was 32+18; +7 helper) |
| `tsc --noEmit` (package) | clean |
| `check-sandbox-e2b-provider-boundary.mjs` | **PASS** (helper imports no `e2b`, holds no `E2B_API_KEY`) |
| `node --check` keyed test | parse OK |

## Residual risk

1. **Not-found status assumption:** the §2.3/inspect-oracle fix assumes real E2B returns a **4xx** for an absent/foreign sandbox lookup. If it returns 5xx, those two stay red — the diagnostic message will reveal it for a one-line follow-up. All other fixes are status-independent.
2. **Keyed-only re-proof:** the default-command, terminate-false, and TTL fixes are validated only by the keyed lane (no-key mock cannot exercise real exec/kill/TTL).
3. No frozen-contract edits; the argv-quoting is the correct serialization of the driver's `{command, args}` contract into e2b's single command-STRING API.
