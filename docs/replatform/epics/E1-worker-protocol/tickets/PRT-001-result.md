# PRT-001 Result — Leaf Protocol Package and Boundary Gate

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E1-worker-protocol`
**Plan task:** `Task 1: PRT-001 — Leaf Protocol Package and Boundary Gate`
**Implementer:** `PRT-001 implementer subagent (Claude)`
**Start SHA:** a29e6dfdc0350d07c04e822252b10d700c19f490

The implementer leaves `Status` at `gate_review`. A separate reviewer completes the section below and is the only role that may change it to `complete`.

This file is a controlled append-only review ledger until `complete`; do not delete or rewrite prior review attempts. Once `complete`, it is frozen. Ticket commands are focused acceptance evidence, not the immutable epic D0 rollup.

## Delivered scope

**E1 context.** E1 execution began at the E0-complete tip `c32bbe087`. The E1
implementation plan was amended for findings E1-F001/E1-F002 (which touch only
PRT-002 and PRT-006) at `a29e6dfdc`; PRT-001 is unaffected and was implemented
against the plan as it stands on disk. **PRT-001 Start SHA = `a29e6dfdc`.**

- Scaffolded the dependency-light leaf workspace package `@armyofagents/worker-protocol` (`packages/worker-protocol`): manifest, tsconfig (extends root, `outDir dist`, excludes `*.test.ts`), package-local Vitest config, and a single public surface exporting `PROTOCOL_VERSION = 1` and `MIN_PROTOCOL_VERSION = 1`. Registered it as a root Vitest project. The sole runtime dependency is `zod` (pinned `3.24.2`).
- Built an always-on dependency/import **boundary gate** as three layers:
  - `scripts/lib/worker-protocol-boundary.mjs` — pure, dependency-free (only `node:path`, no fs, no npm) boundary logic. Its module-specifier extractor and forbidden-global detector are built on ONE small lexical scanner (`tokenizeSource`) that understands line/block comments, single/double-quoted strings (with escapes), template literals (including `${…}` interpolation and nesting), and regex literals — so a specifier- or global-looking sequence inside a comment, a string, or a template's literal text is never mistaken for code, and multiline `import`/`export` is handled correctly.
  - `scripts/check-worker-protocol-boundary.mjs` — the filesystem/command layer. It supplies bytes + directory listings and delegates every decision to the pure lib. It walks `packages/worker-protocol/src`, rejects runtime-source symlinks and alternate extensions (`.d.ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs`), validates each `.ts` runtime file (excluding `*.test.ts`), and **reports filesystem read/parse errors separately from import-policy violations** (a missing/unreadable source is never mislabeled as a policy result). Runtime source may import ONLY `zod` or a relative path that normalizes inside `src`; everything else fails. Accepts `--root` only for the test harness (defaults to `process.cwd()`).
  - `scripts/check-worker-protocol-boundary.test.mjs` — a `node:test` mutation/decoy/bypass corpus (50 cases) run over temporary fixture roots.
- Added `scripts/check-worker-protocol-package.mjs` — packs the built package, asserts the tarball ships ONLY `package/package.json` + `package/dist/**` (no `src`, no emitted `*.test.*`, no stray path), asserts `dist/index.js` + `dist/index.d.ts` are present and the packed manifest declares exactly `["zod"]`, then extracts that exact tarball into minimal server + worker consumer fixtures' `node_modules` (no package manager, no network) and runs them. Consumers import only the public root export and confirm private/deep subpaths (`src/…`, deep `dist/…`, `package.json`) are NOT reachable through the `exports` map.
- Added the two consumer fixtures (`tests/fixtures/worker-protocol-import/{server,worker}-consumer.mjs`).
- Wired the gate into CI: a new **"Worker protocol dependency boundary"** step in the always-on `policy` job of `.github/workflows/pr.yml`, placed immediately after "Distributed execution foundation contracts", running the boundary checker + the `node --test` corpus (no installed dependencies).
- Added the root `check:worker-protocol-boundary` script and committed `package.json` + regenerated `pnpm-lock.yaml` together (AGENTS.md §7).

**Design note (fail-closed globals).** The forbidden-global detector exempts only `.member` access (`foo.process`); a BARE identifier equal to a Node/runtime global is flagged even in an ambiguous property-key/type-key position. This is deliberate: relaxing it to allow property-key positions would also let a real global read slip through a ternary (`cond ? process : x`). A false positive on a schema field literally named like a Node global is a safe, visible failure resolved by renaming.

**Non-goals preserved (per plan):** no protocol identities/states/job/lease/event/artifact/policy/capability/transport/error schemas (those are PRT-002 … PRT-007); no runtime dependency other than `zod`; no database schema, HTTP route, scheduler, worker, provider SDK, browser, or UI. Runtime source imports only `zod` + local modules and no Node API. `Status` left at `gate_review`; `findings.md` untouched.

## Changed files

| File | Responsibility |
|---|---|
| `packages/worker-protocol/package.json` | New leaf-package manifest; `zod` is the only runtime dependency; `exports` declares only `.`; `files: ["dist"]`. |
| `packages/worker-protocol/tsconfig.json` | Extends root tsconfig; `outDir dist`, `rootDir src`, `declaration`+`declarationMap`; excludes `src/**/*.test.ts`. |
| `packages/worker-protocol/vitest.config.ts` | Package-local Vitest config (node environment). |
| `packages/worker-protocol/src/version.ts` | `MIN_PROTOCOL_VERSION`/`PROTOCOL_VERSION` = 1 constants. |
| `packages/worker-protocol/src/index.ts` | Public surface: re-exports the version constants. |
| `packages/worker-protocol/src/index.test.ts` | Vitest proof of the public version range. |
| `scripts/lib/worker-protocol-boundary.mjs` | Pure, dependency-free boundary logic + the lexical scanner (specifier extractor, forbidden-global detector, manifest + runtime-source validators, file classifier). |
| `scripts/check-worker-protocol-boundary.mjs` | Filesystem/command layer; walks `src`, separates read/parse errors from import-policy violations; `--root` for tests. |
| `scripts/check-worker-protocol-boundary.test.mjs` | `node:test` mutation/decoy/bypass corpus (50 cases). |
| `scripts/check-worker-protocol-package.mjs` | Pack + tarball-shape check + exact-tarball import smoke into server/worker consumers (no network). |
| `tests/fixtures/worker-protocol-import/server-consumer.mjs` | Server consumer: imports the public root export; asserts private subpaths blocked. |
| `tests/fixtures/worker-protocol-import/worker-consumer.mjs` | Worker consumer: same, plus exact public-surface key set. |
| `package.json` | Added `check:worker-protocol-boundary` script. |
| `pnpm-lock.yaml` | Regenerated: added the `packages/worker-protocol` importer + `zod@3.24.2` (+30/−1). |
| `vitest.config.ts` | Added `"packages/worker-protocol"` to the root Vitest `projects` list. |
| `.github/workflows/pr.yml` | Added the always-on "Worker protocol dependency boundary" policy step after the E0 foundation-contract step. |
| `docs/replatform/epics/E1-worker-protocol/tickets/PRT-001-result.md` | This ticket result ledger. |

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| Boundary checker fails RED before the package exists, naming the missing manifest + src dir | Step 2: `pnpm check:worker-protocol-boundary` exit 1, printed `packages/worker-protocol/package.json: missing or unreadable (ENOENT)` + `packages/worker-protocol/src: missing (ENOENT)` | `pass` |
| Public-entry test fails RED before `index.ts`/`version.ts` exist | Step 4: `pnpm --filter @armyofagents/worker-protocol test:run` exit 1, `FAIL src/index.test.ts` — `Cannot find module './index.js'` | `pass` |
| Package exports the initial version range | Step 6: package `test:run` — 1 file / 1 test passed | `pass` |
| Runtime source imports only `zod` + local modules; boundary is GREEN post-implementation | `pnpm check:worker-protocol-boundary` → `worker protocol boundary: PASS` (exit 0) | `pass` |
| Boundary rejects every alternate extension, test-source import, Node/runtime globals + `require()`/`module.require()`, `node:fs`, bare `fs`/`crypto`, every non-`zod` bare package, runtime-source symlinks, and relative escapes across static/side-effect/`export … from`/dynamic `import(...)` | `node --test …boundary.test.mjs` → tests 50 / pass 50 / fail 0 | `pass` |
| Comment/string/template/multiline DECOYS never trip; one real bypass per syntax DOES | Corpus "valid baseline … decoys" + per-syntax bypass cases all green | `pass` |
| Missing/unreadable source reported as a read error (real path/cause), not a policy result | Corpus read-error cases (missing manifest / invalid JSON / missing src / injected EACCES source) green; policy arrays empty in those cases | `pass` |
| `zod` and relative specifiers inside `src` are ALLOWED | Corpus valid-baseline case: zero policy + zero read errors | `pass` |
| Tarball ships only declared metadata + `dist`; required decl/runtime files present; runtime deps == `["zod"]`; both consumers import only the public root export and private/deep subpaths are blocked | `node scripts/check-worker-protocol-package.mjs` → `worker protocol package: PASS` (exit 0) | `pass` |
| `dist` ships no `src` and no `*.test.*` file | tarball allow-list + `dist/` listing = `index`/`version` `.js/.d.ts/.map` only | `pass` |
| Manifest + regenerated lockfile committed together; `--frozen-lockfile` is a no-op | `pnpm install --frozen-lockfile` exit 0 ("Done in 3.3s"); lockfile diff +30/−1 | `pass` |
| Always-on policy step added after the E0 step | `pr.yml` `policy` job parses; step "Worker protocol dependency boundary" present after "Distributed execution foundation contracts" | `pass` |

## Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm check:worker-protocol-boundary` (Step 2 — RED, before the package existed) | `1` | Printed `packages/worker-protocol/package.json: missing or unreadable (ENOENT)` and `packages/worker-protocol/src: missing (ENOENT)` |
| `pnpm --filter @armyofagents/worker-protocol test:run` (Step 4 — RED, before src existed) | `1` | `FAIL src/index.test.ts` — `Cannot find module './index.js'`; Test Files 1 failed, no tests collected |
| `pnpm install --no-frozen-lockfile` (Step 6) | `0` | Regenerated lockfile: added `packages/worker-protocol` importer + `zod@3.24.2` (1 package downloaded, rest reused); pre-existing plugin-sdk dev-bin WARNs + pre-existing zod peer WARNs only |
| `pnpm install --frozen-lockfile` (Step 6) | `0` | No-op — lockfile in sync ("Done in 3.3s") |
| `pnpm --filter @armyofagents/worker-protocol test:run` (Step 6) | `0` | 1 test file / 1 test passed |
| `pnpm --filter @armyofagents/worker-protocol typecheck` (Step 6) | `0` | `tsc --noEmit` clean |
| `pnpm --filter @armyofagents/worker-protocol build` (Step 6) | `0` | Emitted `dist/{index,version}.{js,d.ts,js.map,d.ts.map}`; no test files in dist |
| `pnpm check:worker-protocol-boundary` (Step 6 — GREEN) | `0` | `worker protocol boundary: PASS` |
| `node --test scripts/check-worker-protocol-boundary.test.mjs` (Step 6) | `0` | tests 50 / pass 50 / fail 0 |
| `node scripts/check-worker-protocol-package.mjs` (Step 6) | `0` | `worker protocol package: PASS` (pack + tarball allow-list + both consumer smokes green) |

## Deviations

No deviation from the plan's substance. Two environment/portability notes for the reviewer:

1. **Step-ordering (environmental necessity).** The assigned worktree is a fresh `git worktree` with no `node_modules` (worktrees do not share the main checkout's install). The Step-6 `pnpm install --no-frozen-lockfile` was therefore run once BEFORE Step 4 so a resolvable Vitest existed to produce a genuine test-level RED. The Step-4 RED is still a real failing test (import of a non-existent `./index.js`), and the Step-6 `--frozen-lockfile` no-op re-verification confirms the lockfile is in sync. RED-before-GREEN was preserved at both gates (Step 2 boundary RED and Step 4 test RED).
2. **Pack-checker `tar` mechanics.** The plan describes `check-worker-protocol-package.mjs` in prose (not exact bytes). `tar` is invoked with `cwd` set to the tarball's directory and colon-free relative paths because GNU tar 1.35 (Git Bash) otherwise misparses a `C:\…` drive letter as a remote host; the two `pnpm` spawns use the string-command form to avoid Node's DEP0190. Consumer "install" is done by extracting the exact packed tarball into the consumers' `node_modules` (no package manager, no network), satisfying the plan's "links that exact tarball … without network access".

## Findings

None.

## Follow-up tickets

None. PRT-002 (branded identities + lifecycle state machines) is the next ticket in Epic E1 and is out of scope here.

## Gate recommendation

`ready for independent review` — both RED gates are recorded (Step 2 boundary RED naming the missing manifest + src dir; Step 4 test RED on the missing entrypoint), every Step-6 command exits 0 (package test/typecheck/build, boundary PASS, `node --test` 50/50, pack + dual consumer smoke PASS), the manifest + regenerated lockfile are committed together with `--frozen-lockfile` proven a no-op, the always-on CI policy step is in place and the workflow parses, and only the planned PRT-001 files are touched (`dist`/`node_modules` are gitignored and excluded from the commit).

## Independent review

**Reviewer:** `PRT-001 independent reviewer subagent (Claude)`
**Reviewed revision:** `7e0f37e1b1e78564ddbda9708485b592087a5380`
**Disposition:** `approved`
**Review evidence:** Independent re-run on the reviewed revision (`git rev-parse HEAD` = `7e0f37e1b…`; worktree clean before and after). Focused acceptance commands, all exit 0 / green:

- `pnpm check:worker-protocol-boundary` → `worker protocol boundary: PASS` (exit 0).
- `node --test scripts/check-worker-protocol-boundary.test.mjs` → tests 50 / pass 50 / fail 0 (exit 0).
- `node scripts/check-worker-protocol-package.mjs` → `worker protocol package: PASS` (exit 0); independent manual `pnpm pack` + `tar -tzf` confirmed the tarball ships ONLY `package/package.json` + `package/dist/**` (index/version `.js/.d.ts/.map`) — no `src`, no `*.test.*`.
- `pnpm --filter @armyofagents/worker-protocol test:run` → 1 file / 1 test passed (exit 0).
- `pnpm --filter @armyofagents/worker-protocol typecheck` → `tsc --noEmit` clean (exit 0).
- `pnpm --filter @armyofagents/worker-protocol build` → clean rebuild after `rm -rf dist` emitted exactly `dist/{index,version}.{js,d.ts,js.map,d.ts.map}` (no test files) (exit 0).
- `pnpm install --frozen-lockfile` → no-op, "Done in 3.3s" (exit 0) — committed lockfile in sync with manifests (pre-existing plugin-sdk dev-bin WARNs unrelated).
- `git diff --check` clean (exit 0); `git status --porcelain` empty; `git check-ignore` confirms `packages/worker-protocol/dist` + `node_modules` are gitignored.

Adversarial probing beyond the committed 50-case corpus (28 new fixtures via `runBoundaryCheck(--root)` + direct lib calls, all behaved correctly): multiline/tab-whitespace/no-space `import`/`export … from` specifiers rejected; `import * as fs from "node:fs"` rejected; string-concat dynamic `import('f'+'s')` / `import('z'+'od')` both fail closed (rejected as importing `"f"`/`"z"`, never resolved to an allowed specifier); non-literal template static import → "non-literal static import is forbidden"; TS `import x = require('fs')` caught via `require(`; comment/string/template specifier decoys never trip. Forbidden globals: object-literal key `{process:1}`, TYPE key `type T = { process: number }`, shorthand `{process}`, ternary `cond ? process : x`, and `${process}` interpolation all flagged (fail-closed as designed); `config.process` member access and `process` inside comments/strings NOT flagged. `new TextEncoder()` (used by the planned PRT-002 `ids.ts`) is NOT in the forbidden set and was verified clean. Alt extensions `.mts/.cts/.d.ts/.js/.jsx/.mjs/.cjs` rejected; relative escapes `../../../server/x` and `../../shared/y` rejected; in-`src` relative + `zod` allowed. Symlink-under-`src` rejection is covered by the checker code path + committed synthetic-dirent test (a real-symlink probe SKIPPED only due to Windows EPERM on symlink creation).

Verified: boundary lib `scripts/lib/worker-protocol-boundary.mjs` imports only `node:path` (dependency-free); all package/script/fixture files are newly ADDED in this commit (no pre-existing/required test was weakened — the fail-closed member-access test is part of the new corpus); root `package.json` + `pnpm-lock.yaml` committed together (AGENTS §7 lockfile-not-alone satisfied); the only runtime dependency is `zod@3.24.2`; the "Worker protocol dependency boundary" step sits in the always-on `policy` job immediately after "Distributed execution foundation contracts" and uses only `node`. Fail-closed-globals false-positive risk judged THEORETICAL for this protocol's vocabulary: no enumerated V1 field/key equals a forbidden global, enum values are string literals (never scanned as identifiers), and the one concrete near-miss (`TextEncoder`) is not forbidden. No findings.

## Review attempt history

The implementation author leaves the table body empty; the explicit pending summary above is not a review attempt. The first independent reviewer appends attempt 1, and later reviewers append monotonically increasing rows without replacing prior attempts. The summary fields above mirror the latest real attempt for existing gate tooling. Do not include a `Review commit` column: a row cannot embed the SHA of the commit that first contains it. Repository history identifies that commit, and handoffs pin the resulting ticket-result blob SHA.

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
<!-- First independent reviewer appends attempt 1. -->
| 1 | PRT-001 independent reviewer subagent (Claude) | `7e0f37e1b1e78564ddbda9708485b592087a5380` | `approved` | Re-ran all focused acceptance commands on the reviewed revision — boundary PASS (exit 0), `node --test` 50/50, pack checker PASS + independent `pnpm pack`/`tar` (dist-only, no src/test), package test:run 1/1, typecheck clean, clean rebuild emits only index/version `.js/.d.ts/.map`, `--frozen-lockfile` no-op, worktree clean. 28 new adversarial boundary probes all correct (specifier obfuscations, string-concat/non-literal dynamic imports, forbidden globals in key/type-key/shorthand/ternary/interpolation positions, alt extensions, relative escapes) + fail-closed-globals verified clean on `TextEncoder`. AGENTS §7 (manifest+lockfile together) and the always-on `policy`-job step both confirmed. No findings. |
