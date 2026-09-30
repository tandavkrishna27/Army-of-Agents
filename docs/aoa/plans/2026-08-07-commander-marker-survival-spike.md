# Commander marker-survival live spike (pre-merge gate for W7.5e)

> **This is a manual, live-E2B gate — NOT an automated test.** The W7.5e
> automated tests (`commander-broker-approval.test.ts`,
> `commander-broker-trust-rule.test.ts`) use the fake provider + the in-process
> broker handler, which prove the AoA-side plumbing (the ⚡CONFIRM marker gate,
> the trust-rule short-circuit, the sandbox-agnostic confirm route). They CANNOT
> prove the one paper-unprovable item (spec §7 Q4 / OPEN-2): does the ⚡CONFIRM
> marker (and the live token stream) survive `claude` AND `codex` running INSIDE
> a real E2B sandbox and talking to the broker over HTTP? A CLI that summarizes
> or strips a tool result would silently drop the approval card. Only a live run
> proves CLI fidelity.

**Gate:** W7.5e MUST NOT merge until BOTH `claude` and `codex` pass steps 4, 5,
and 7 on a real E2B sandbox against a `cloud_auth` control plane. Record
PASS/FAIL for each CLI in the PR description. Do NOT substitute a passing unit
test for this gate.

## Setup

1. `cloud_auth` instance with a platform-default e2b environment; `E2B_API_KEY`,
   `AOA_AGENT_JWT_SECRET` (or `BETTER_AUTH_SECRET`), and a BYO model-provider key
   configured.
2. A Commander conversation with a governed tool permission requiring
   confirmation (e.g. `create_task` / `change_goal_status`,
   `requireConfirmation: true`), `runtimeApprovalsEnabled: true`, and no matching
   trust rule.

## claude

3. Send a Commander turn that induces a governed tool call.
4. VERIFY: the turn streams live tokens (SSE `text` events arrive incrementally,
   not one buffered blob at end-of-turn) — confirms W7.5b streaming end-to-end.
5. VERIFY: an `action_confirmation` SSE event fires with a real `confirmId` —
   confirms the ⚡CONFIRM marker survived the CLI → broker HTTP → CLI stdout
   round-trip and reassembled via `StreamJsonParser` (W7.5b).
6. Approve via `POST …/internal-agent/confirm` (`{ confirmId, decision:
   "allow_once" }`); VERIFY the tool executed HOST-SIDE and the result rendered.
   (Property under test in `internal-agent-confirm.test.ts` — this confirms it
   end-to-end from a real sandbox turn.)

## codex

7. Repeat 3–6 for `codex`. codex buffers stdout then parses (`parseCodexJsonl`),
   so ALSO VERIFY the marker survives its JSONL and surfaces as
   `action_confirmation`.
8. VERIFY codex `resume <sessionId>` continuity across two turns in the SAME warm
   conversation (the `~/.codex` session file persists on the warm disk — spec
   D-E).

## Warm lifecycle

9. VERIFY a second turn RESUMES the same `providerLeaseId` (no fresh
   `Sandbox.create`) and still streams + still surfaces the marker (spec D-C
   warm+streaming risk).
10. Kill / GC the sandbox between turns; VERIFY the next turn create-fresh's
    transparently (no errored turn) and still works.

## Reaper interaction (Task 4a live confirmation)

11. While a turn is IN FLIGHT (mid-stream, before the confirm), confirm the lease
    is `status='active'` and the idle reaper does NOT reap it, even if the idle
    TTL has elapsed since the previous turn. (The paused-only sweep excludes it
    by construction — `commander-warm-reaper-inflight.test.ts` locks the unit
    invariant; this is the live confirmation.)

## Result

- PASS both CLIs on 4 / 5 / 7 → the marker model is proven over the VM boundary;
  lock W7.5e.
- FAIL on any → the marker does not survive that CLI in-sandbox; escalate. The
  fallback is to surface approvals out-of-band (the confirm route already works
  host-side; the gap is only the mid-turn card). Do NOT merge W7.5e on a fail.
