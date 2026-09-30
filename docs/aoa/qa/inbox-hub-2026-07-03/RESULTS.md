# Inbox/Approvals Hub — Live E2E QA Results (2026-07-03)

Instance: http://localhost:3399 (local_trusted, AOA_RUNTIME_DECISION_ROUTING=1)
Company A: QA-Loopback (QAL) a09f6b78-a9ac-4c54-81cc-eba3a14cf677
Agents: Scout-Codex (codex_local), Scout-Claude (claude_local) — both runtimeDecisionRoutingEnabled=true
Screenshots: scratchpad/qa-shots/ (SHOT-*.png)

Format: `<scenario> — PASS|FAIL|BLOCKED — note — evidence`

## Phase 6 — Runtime decisions (HEADLINE)
6.1 codex allow-once — FAIL (BLOCKER, BUG-1) — codex app-server JSON-RPC handshake dies at startup ("Invalid request: missing field `params`"); run fails in ~250ms; no command runs; NO permission item reaches the hub. Supervised path IS engaged (bypass flag correctly ignored). — run-log 8a5bdeba.ndjson, server.log:4075-4089
6.1-claude allow-once (SUBSTITUTE crown-jewel via claude_local) — PASS — permission item appeared in Waiting on you within ~15s; RuntimeDecisionPanel renders Allow once/Allow always/Deny with tool+command+risk; answering allow_once → decision answered→relayed (relayError null) → run CONTINUED (did not die) → hub item auto-archived. Loop proven end-to-end. — SHOT-6.5-runtime-decision-panel.png, SHOT-6.1-panel-fresh.png; decision ea7aba4f (relayed), hub item 6b563ec5 (archived)
6.2 claude deny — PASS — decision 35877bf6 answered(deny)→relayed(no error), hub item 8597c22b→archived; run continued. — decision 35877bf6
6.3 claude allow-always + trust rule — PASS — allow_always created trust rule a6367e3b (agentId+adapterType=claude_local+toolName=Bash+commandHashPrefix=53be0332+riskClass=shell+enabled+90d expiresAt). Revoke (DELETE trust-rules/:id) → 200, rules 1→0. Auto-answer-on-exact-repeat is mechanism-confirmed (commandHashPrefix match) but not naturally re-triggered (each bash probe differs). — trust-rules API
6.4 codex file-change + out-of-tree — BLOCKED — depends on codex path (BUG-1); could not reach any codex tool call. claude file-write not separately driven (time/quota). Coverage gap tied to BUG-1.
6.5 claude command permission — PASS — same loop as 6.1-claude (this IS the working adapter). — SHOT-6.5-runtime-decision-panel.png
6.6 timeout/SLA — PASS (observed real behavior) — decision 05778b47 (escalate policy, 5-min SLA) was NOT answered in time; at expiresAt it went status=cancelled and the blocked claude run was released and completed 2s later. Timeout→terminal decision confirmed. NOTE: its hub item stayed open (BUG-2). — decision 05778b47 (cancelled)
6.7 cancel mid-approval — PASS (backend) / partial (hub) — POST /api/heartbeat-runs/:id/cancel → run "Cancelled by control plane"; associated pending decision 208771e9 → status=cancelled (teardown coupled). BUT hub item stayed open (BUG-2). — decision 208771e9 (cancelled)
6.8 gating OFF — NOT RUN — needs a 3rd agent with runtimeDecisionRoutingEnabled=false + a codex/claude run; deferred (quota). Coverage gap.
6.9 blocked-run visibility in task detail — NOT VERIFIED IN-UI — task stayed in_progress while waiting_on_human; no dedicated blocked indicator confirmed in TaskSlideOver (matches investigation's known gap). Coverage gap / candidate MINOR.

## Phase 2 — Hub shell
2.1 lanes + legacy redirect — PARTIAL PASS — Home/Waiting/Notifications/Suggestions tabs render + filter; URL slug changes (/inbox, /inbox/waiting, /inbox/notifications, /inbox/suggestions). Legacy /inbox renders hub directly. NOTE: hard-navigation to deep SPA paths returns server 404 — SPA fallback gap (BUG-4, MINOR). — SHOT-2.1-inbox-waiting.png
2.2 status filter tabs — PASS — Open/Resolved/Archived tabs present on every lane; URL carries lane slug. Resolved/Archived empty initially (proper empty state). — SHOT-2.1-notifications.png
2.4 resolve/archive/undo — PARTIAL PASS — Resolve fires (PATCH /hub-items/:id/state → 200) and removes item from Open list; Undo toast not reliably observed (transient / possibly not wired); source-backed notifications can re-open (reconciler re-projects while source condition persists). Archive button present. — SHOT-2.4-resolve-toast.png, SHOT-2.4-notif-detail.png
2.4b snooze — PASS — UI "Snooze" → item hides + "Undo snooze" affordance; API confirmed: kind=snooze with `until` sets snoozedUntil and hides from Open (count 3→2), kind=unsnooze clears it. — SHOT-2.4b-snooze.png
2.5 claim/release — PARTIAL PASS — "Claim" button present in item viewer (@e42). Full claim→avatar→release cycle not deep-driven; button exists and is wired. — SHOT-3.1-hire-approval-detail.png
2.6 optimistic concurrency (409) — PASS (observed) — the answer endpoint uses expectedSourceRevision + nonce; a stale answer yields 409 (observed when answering an already-cancelled decision, BUG-2 path). State PATCH uses expectedVersion. Concurrency guard present. — network log 409 on ea7aba4f... path
2.7 read state — PARTIAL — "Mark unread"/read actions present (kind=read/unread in /state schema). UNREAD counter renders (badge). Not deep-driven per-item. 

## Phase 3 — Approvals
3.1 hire-agent approve — PASS — Company B (QAB, requireBoardApprovalForNewAgents=true via PATCH). Hire via POST /agent-hires → agent pending_approval + approval created pending → approval_request hub item "Review hire agent approval" in Waiting. Item viewer → "Open full" → ApprovalDetail with Approve/Reject. Approve → agent flips pending_approval→idle; hub item RESOLVED (waiting count→0). Approval hub items DO reconcile on approve (contrast BUG-2). — SHOT-3.1-approval-full.png, SHOT-3.1-after-approve.png
3.2 hire reject + resubmit — PASS — POST /approvals/:id/reject → agent stays pending_approval (not activated); resubmit route exists (POST /approvals/:id/resubmit responds). Reject UI button present. — API
3.2b harness note — the plain POST /companies/:cid/agents route always creates status=idle with NO approval gate; the gated hire path is POST /companies/:cid/agent-hires (reads company.requireBoardApprovalForNewAgents). Not a bug — two distinct endpoints. UI hire must use /agent-hires.
3.3 budget_override_required — NOT REACHED — no natural trigger without forced spend; deferred (see 4.4). Coverage gap.

## Phase 4 — Crew autonomy
4.x manual/assist/drive + crew_dispatch — BLOCKED (extraction dependency) — per memory + plan, discussion scope-draft needs CLI extraction to produce items; with 0 extracted items the compiler emits a placeholder and no real crew tasks/crew_dispatch approval. Extraction is off-by-default and the discussion→scope pipeline gates on it. Autonomy setAutonomyLevel PATCH exists (threads.ts:171). Not driven end-to-end this sweep. Coverage gap tied to extraction bring-up.

## Phase 5 — Notifications
5.1 run_failed / run_complete — PARTIAL — run_failed IS emitted (codex failures surfaced in Notifications lane). run_complete NOT emitted for a succeeded claude run (BUG-5, MINOR). — SHOT-2.1-notifications.png
5.2 realtime toast/bridge — NOT VERIFIED — polling storm (BUG-3) obscured clean toast observation; "Resolved" state changed live without full reload. Partial signal only.
5.3 extraction_failed — NOT DRIVEN — needs a discussion entry with broken extraction; deferred.
5.4 preferences (quiet hours/digest) — BLOCKED (no UI) — GET /notifications/digest/me → 200 (digest mechanism exists); notification-preferences write route 404 (no settings UI). Confirmed coverage gap, not a product bug (unbuilt UI).

## Phase 7 — Suggestions
7.1 suggestions lane + actions — PARTIAL PASS — Suggestions lane renders 2 real memory_gap suggestions ("No identity memory exists yet"). Generic lifecycle actions (Dismiss/Snooze/Resolve/Archive) + "Open full"/"Open" deep links work. NO category-specific action affordance (e.g. "Create identity memory") in the viewer — matches known dead-end. — SHOT-7.1-suggestions.png, SHOT-7.1-suggestion-detail.png

## Phase 8
8.1 steward curation — NOT DRIVEN — no UI to set priority/slaAt; item shows priority (high/normal) but curation reasons not naturally raised. Coverage gap.
8.2 autopilot rules — BLOCKED (no UI) — "Autopilot Off / 0 handled today" chip renders on hub home but no settings UI to configure rules. Confirmed coverage gap. — SHOT-2.1-inbox-waiting.png (autopilot chip)
8.3 org reporting — BLOCKED (route) — org-hierarchy/org-reporting routes 404 in this build; W6 is API-level and not exposed at the tried paths. Coverage gap.

## Phase 9
9.1 deep links + viewers — PASS — approval item → "Open full" → /QAB/approvals/:id (ApprovalDetail); runtime decision → /QAL/inbox/waiting/:id viewer; suggestion → Open link. Deep links resolve via client nav. — SHOT-3.1-approval-full.png
9.2 reconciliation — MIXED — approvals reconcile on approve (3.1 waiting→0); runtime_decision items DO NOT reconcile on terminal decision (BUG-2). 
9.3 empty states — PASS — "Nothing needs attention right now" (hub home), "No open items in this lane" (empty waiting), empty Resolved/Archived tabs render cleanly (no broken panels). — SHOT-6.1-hub-waiting.png
