# QA - D0 - E1 frozen-consumer checker correction - `01ad1ab554fe` - a6

## Record identity

| Field | Value |
|---|---|
| Date (UTC) | `2026-08-10` |
| Scope | Prerequisite P2 frozen-checker correction, independent final acceptance |
| Revision | `01ad1ab554fe25c5178c7552ec047d4df45b7dcf` |
| Candidate code revision | `7d649a01802bc2062e91ded370ec7d6385c72931` |
| Supersedes | `qa/2026-08-10-d0-e1-frozen-checker-correction-7d649a01802b-a5.md` |
| Reviewer | `Codex distinct reviewer (/root/e1_checker_correction_review)` |
| Environment | `operator-directed Windows-local`, Node `v24.14.0`, pnpm `9.15.4`, Git `2.50.0.windows.2`; local Docker Linux `node:24-bookworm` for zero-environment probes |
| Formal authority | Linux CI under DEC-03; the local Linux container is focused evidence, not a replacement for CI |
| Result | **`pass`** |

This file is immutable from its first commit. It supersedes the a5 awaiting-review
candidate and preserves all earlier failed/awaiting-review records.

## Independent acceptance

| Requirement | Evidence | Result |
|---|---|---|
| Exact review scope | Scoped package diff payload is byte-identical to fresh unified-10 `2bf5297b6..01ad1ab55`; SHA-256 `4c78460221ccd42a916cdaef89b0238105189d88ed67af32783a5161386037b8` | `pass` |
| Empty smoke environment | Windows and Linux hostile probes observe zero keys; parent secret absent; `NODE_OPTIONS` preload sentinel absent; `NODE_PATH` package not resolvable | `pass` |
| Owned cleanup under concurrency | Isolation suite `2/2`; two staggered full `30/30` corpora; A cannot remove B's live repo; both owned parents absent; two unrelated temp sentinels unchanged | `pass` |
| Retained checker corpus | Default and inherited-signing focused runs each `30/30`; coordinated artifact/manifest, replacement, pre-execution sentinel, timeout, CRLF, dependency, missing-object, later-consumer, and clean-clone cases green | `pass` |
| Bounds | Infinite loop terminated at focused timeout; over-1-MiB output returns bounded `ENOBUFS` in about `52ms` with a 108-character diagnostic | `pass` |
| Actual recorded source | `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870ce7509d8baa75409e0ab19da375c88a` exits `0`; Zod `3.24.2`, esbuild `0.28.1` | `pass` |
| Boundary/package/manifest | Boundary Node suite `50/50`; boundary CLI, package smoke, and contract-manifest check all exit `0` | `pass` |
| Typecheck/build | Worker-protocol typecheck/build and repository `pnpm -r typecheck` / `pnpm build` all exit `0` | `pass` |
| Immutable evidence | Source and anchor are exact commits; anchor is the direct sole-parent child of source; fixture tree `e62b3b...`, worker tree `73aeaae...`, contract tree `7d895c...`, and bundle blob `260bf29...` are unchanged; protected diff empty | `pass` |
| Cleanup/diff | Zero owned corpus/isolation parents remain; scoped `git diff --check` clean; worktree clean before evidence edits | `pass` |

## Windows-local / DEC-03 statement

The independently rerun worker-protocol `test:run` exits `1` on the documented
Windows-local collection SyntaxError at `src/cross-version.test.ts:12`; `16` files and
all `490` collected tests pass. This is recorded as a non-passing local command, not
converted into green. The correction's dependency-free checker passes on Windows and
its focused zero-environment behavior passes in Linux Node 24. Linux CI remains the
formal DEC-03 repository-suite authority.

## Failures and residuals

No product, checker, security, immutable-boundary, or required focused-acceptance
failure. One informational test-maintenance note remains: emergency failure cleanup in
the isolation orchestrator may leave its child test process running briefly after the
controller is killed. The successful required path leaves zero owned parents and does
not touch unrelated temp paths; this note is not Critical/Important and does not alter
the result.

## Gate effect

E1 remains complete, E1-F008 is resolved, and prerequisite P2 moves to `complete` /
`pass` on revision `01ad1ab554fe25c5178c7552ec047d4df45b7dcf`. This QA record does
not implement JOB-001 or any other E3 ticket.
