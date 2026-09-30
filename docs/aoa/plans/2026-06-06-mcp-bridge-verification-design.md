# MCP Bridge Fix — Enterprise-Grade Verification Design

**Goal:** Prove, with fresh independent eyes and a real end-to-end run, that both
Transport-closed root causes on `fix/codex-mcp-bridge` are fixed and the
loud-failure net works — leaving behind a permanent regression test, a live
demonstration, and a written review record. No trimming: the full enterprise
standard.

**Branch under verification:** `fix/codex-mcp-bridge` (21 commits off
`origin/feat/v1-combined`). Two root causes fixed: (1) EOF-exit → watchdog-only
lifecycle + SDK transport; (2) pino→stdout leak → bridge logs routed to stderr.
Plus hardening + loud-failure detection.

---

## Enterprise-grade verification standard (what "best practice" means here)

1. **Full test pyramid** — unit + integration (already green) PLUS a real E2E of
   the actual user-facing flow (a crew agent posting through the bridge). One
   layer is never enough.
2. **Failure-path proof, not just happy-path** — prove the system fails *loudly
   and safely*. "No silent failures" is the headline enterprise property and is
   precisely what let this bug ship.
3. **Independent + cross-model review** — adversarial, by a reviewer that did not
   write the code, plus an outside model (codex).
4. **Realistic live verification** — real `codex` CLI + real DB + the actual UI,
   not mocks.
5. **Blast-radius containment + regression safety** — prove nothing else broke
   (untouched-path guards + full green suite).
6. **Observability + rollback** — loud-failure detection is the observability;
   atomic commits on an isolated branch are the rollback path.
7. **Documentation** — a consolidated review report + a known-gaps ledger.

---

## Workstream A — Detailed code review (fresh + cross-model)

- **A1. Fresh independent review.** A new reviewer (opus, no prior context) does a
  line-by-line adversarial pass over the full diff
  (`git diff origin/feat/v1-combined..HEAD`): correctness, edge cases, the
  cross-cutting stdout-discipline (console guard + pino→stderr + transport.onerror),
  the loud-failure logic, concurrency, and blast radius. Returns
  Critical/Important/Minor with file:line.
- **A2. codex cross-model review.** Run `codex` as an outside model on the core
  files (`mcp-bridge.ts`, `bridge-lifecycle.ts`, `logger.ts`, `aoa-run-result.ts`,
  `transport-failure.ts`, `cli-mode.ts`) with a focused review prompt. Independent
  second opinion; capture its output.
- **A3. Triage + fix.** Merge A1+A2 findings into one ledger. Fix every
  Critical/Important via focused subagents (TDD where code changes). Document/defer
  Minor with explicit rationale. Re-run the gate after fixes.

**Acceptance:** zero unresolved Critical/Important findings; all fixes have tests;
suite stays green.

---

## Workstream B — Whole E2E verification

- **B1. Programmatic happy-path E2E (permanent regression).** Drive a real codex
  crew agent through the **full `runAoaAgent` participation path** so it calls
  `post_entry` through the fixed bridge. Assert: a new `discussion_entries` row
  authored by that agent appears in the QA DB, AND the run persists as
  `succeeded`. Gated: codex runs; opencode/gemini skip loudly. Inline-seed a
  working codex crew agent if none exists.
- **B2. Induced-failure E2E (loud-failure proof).** Drive real codex with the
  bridge spec env overridden to `AOA_LOG_STDOUT=1` (re-enables the pino leak — the
  *real* failure mechanism, the exact bug). codex's output then carries the
  transport marker; feed the adapter result through `buildAoaRunResultFromAdapter`
  (mcpAttempted=true, markerSupported=true) and assert the run is marked
  **`failed`** — never silently `succeeded`. Proves the defense-in-depth fires on
  a real failure, not just synthetic input.
- **B3. Live UI walkthrough (`/browse`).** Boot the AoA server from the fix
  worktree against the QA DB (server :3300, vite :5373). Seed/confirm a working
  codex crew agent. Open the discussions UI, navigate to the thread, @mention the
  codex agent, and **watch the entry appear live**; capture screenshots. Optional:
  observe a failed run surfacing after an induced break.

**Acceptance:** B1 codex posts (DB row + run `succeeded`); B2 induced break →
run `failed`; B3 the entry is visibly posted by codex in the real UI (screenshot).

---

## Environment / order / deliverables

- **Environment:** QA DB up at `127.0.0.1:54440` (company
  `8d7569f2-43e9-4b57-8709-2a4687364e44`, thread
  `376592a2-91e6-4327-81fb-8fb7e498b6c4`). vitest + `runAoaAgent` for B1/B2;
  gstack `/browse` (canonical) for B3; real `codex` CLI (installed);
  opencode/gemini absent → skip loudly.
- **Order:** A1 + A2 (review, parallel) → A3 (triage + fix) → B1 + B2 (tests on
  the fixed code) → B3 (live walkthrough) → final gate (full server suite +
  workspace typecheck).
- **Deliverables:** (1) consolidated review report with findings + fixes;
  (2) a committed E2E test file (happy-path + induced-failure); (3) live-walkthrough
  screenshots + notes; (4) green final gate; (5) updated known-gaps ledger.

## Out of scope
- opencode/gemini live runs (CLIs not installed — gated skips, documented).
- The deferred `node mcp-bridge.js` production-entrypoint test (monorepo
  exports-map; tracked separately).
- The unrelated discussions findings (F1/F2/F4) — separate triage.

## Known gaps & follow-ups (post-verification)

Recorded so they are not lost. None block the fix; all of codex (the installed,
bug-exhibiting provider) is fully covered + tested.

1. **opencode/gemini loud-failure marker coverage — UNTESTED.** The pino→stderr
   stdout-discipline fix is provider-agnostic (`buildMcpBridgeSpec` sets
   `AOA_LOG_STDOUT=0` for all three consumers), so the "second Transport-closed
   cause" is closed for opencode/gemini too. But the loud-failure *detector*
   (`transport-failure.ts` `TRANSPORT_RE`) is marker-based: codex's
   `rmcp::transport … serde error` is now matched + unit-tested, and the generic
   `transport closed` / `connection closed` alternatives *probably* cover the
   JS-SDK-based clients — but opencode's and gemini's **actual** broken-bridge
   marker strings were never captured (those CLIs are not installed here).
   **Follow-up:** when opencode/gemini are exercised, run the B2 induced-break
   (`AOA_LOG_STDOUT=1`) against each, capture the real marker from their output,
   add it to `TRANSPORT_RE`, and pin it with a unit test. Until then, a genuinely
   dead bridge for those two providers could be classified `succeeded` if their
   client emits a string the regex does not recognize.
2. **gemini `resultJson` shape gap (already documented in `aoa-run-result.ts`).**
   gemini-local stores `resultJson = parsed.resultEvent ?? {stdout,stderr}`, so
   when a parsed event exists the raw streams are not in the detector's view →
   `markerSupported:false` → `unknown` (never a false-positive, but a real
   coverage hole for gemini specifically).
3. **Structural fallback (optional, larger — likely YAGNI).** A provider-agnostic
   alternative to marker-matching: flag a run where the agent was expected to use
   MCP and made **zero** successful tool calls. Immune to marker drift / new CLI
   versions; deferred unless marker drift becomes a recurring problem.
