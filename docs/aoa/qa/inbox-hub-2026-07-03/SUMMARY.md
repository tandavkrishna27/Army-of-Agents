# Inbox/Approvals Hub — Live E2E QA Summary (2026-07-03)

Instance: http://localhost:3399 (local_trusted, AOA_RUNTIME_DECISION_ROUTING=1)
Driver: gstack /browse (real Chromium) + API side-doors. Codex 0.130 + Claude 2.1.126 both authed.

## Headline verdict — the crown-jewel permission loop

The runtime-decision permission loop WORKS end-to-end via the claude_local adapter.
Permission raised -> agent_runtime_decision hub item in "Waiting on you" -> RuntimeDecisionPanel
renders (Allow once / Allow always / Deny + tool + command + risk) -> answer -> decision
answered->relayed (no relayError) -> the blocked run CONTINUES (does not die) -> allow_always creates
a scoped, revocable trust rule. Deny, timeout/expire, and run-cancel all reach terminal decision
states correctly server-side. Evidence: SHOT-6.5-runtime-decision-panel.png; decisions ea7aba4f
(allow relayed), 35877bf6 (deny relayed); trust rule a6367e3b.

The same loop is BLOCKED for codex_local (BUG-1, BLOCKER). The codex app-server JSON-RPC handshake
dies at startup ("Invalid request: missing field `params`") because driver.ts:305 sends `initialize`
with no params and codex 0.130 requires it. The run fails in ~250ms; no command executes; no
permission item is raised. Supervised path IS engaged (bypass flag correctly ignored) — it just
can't complete the handshake. This is the W5c codex app-server bridge, non-functional on this branch.

## Pass tallies (attempted scenarios)
- Phase 6: PASS 6.1-claude, 6.2, 6.3, 6.5, 6.6, 6.7(backend); FAIL/BLOCKER 6.1-codex; GAP 6.4, 6.8, 6.9
- Phase 2: PASS 2.2, 2.4b, 2.6, 9.3; PARTIAL 2.1, 2.4, 2.5, 2.7
- Phase 3: PASS 3.1, 3.2; GAP 3.3
- Phase 4: BLOCKED 4.1-4.4 (extraction dependency)
- Phase 5: PARTIAL 5.1; GAP 5.2, 5.3, 5.4
- Phase 7: PARTIAL 7.1
- Phase 8: GAP 8.1, 8.2, 8.3
- Phase 9: PASS 9.1, 9.3; MIXED 9.2

## Blocker list
1. BUG-1 (BLOCKER) — codex_local runtime-decision runs die at app-server handshake.
   Suspected: packages/adapters/codex-local/src/server/app-server/driver.ts:305 (initialize with no
   params) + jsonrpc-client.ts:212-219 (undefined params key omitted from frame).

## Major/minor bugs (triage only, not fixed)
2. BUG-2 (MAJOR) — runtime_decision hub items never reconcile to resolved when the decision
   terminates (superseded/expired/cancelled). Phantom "Waiting on you" items pile up, inflate the
   badge, and 409 on click. Approval hub items DO reconcile — fix scoped to the runtime_decision projector.
3. BUG-3 (MAJOR) — InboxHub floods the browser with counts/badges/digest/per-item polling ->
   ERR_INSUFFICIENT_RESOURCES; the founder's Allow/Deny POST stalls pending under load (3222 bg
   requests/session). Suspected InboxHub.tsx refetch effects.
4. BUG-4 (MINOR) — server SPA fallback 404s on hard-nav/reload/bookmark of deep /:prefix/... routes
   (/ is 200; client-nav works). Verify vs prod build.
5. BUG-5 (MINOR) — no run_complete notification for a succeeded claude run (only run_failed wired).

## Launch-readiness verdict — Inbox/Approvals hub surface
The hub SURFACE is launch-viable; the codex runtime-decision PATH is not.
- The hub (lanes, filters, lifecycle, approvals, runtime-decision panel, suggestions, deep links,
  empty states) is functional; the two make-or-break founder loops (answer a permission; approve a
  hire) work end-to-end.
- Two MAJOR hub-side bugs should gate a confident runtime-decision launch: BUG-2 (stale phantom
  permission items) and BUG-3 (polling storm dropping the Allow/Deny click). Both fixable, independent
  of BUG-1.
- BUG-1 means codex_local cannot ship as a supervised adapter. If claude_local-first is acceptable
  for the initial runtime-decision launch, the surface is ready pending BUG-2/BUG-3.

## Coverage gaps (not product bugs)
- 6.4/6.8/6.9 not driven (codex blocked / quota / needs 3rd agent).
- Phase 4 crew autonomy blocked on extraction bring-up (0 items -> placeholder path).
- 5.4 quiet-hours/digest write + 8.2 autopilot rules: no settings UI (unbuilt; backend present).
- 8.3 org-reporting: routes 404 at tried paths (API-level W6, not UI).
- RBAC non-founder denial: needs an authenticated multi-human instance.
