# B12 execution and browser qualification — current-source gate review

**Reviewed branch:** `codex/universe-interface`  
**Reviewed SHA:** `bfdca45dc9271180793c5e2731ceae6c28fe02ec`  
**Date:** 2026-09-20  
**Status:** blocked at named upstream and qualification gates; no B12 runtime activation performed.

## Result

B11 is complete. B12 cannot be honestly implemented as one complete wave against the current source. The planned acceptance requires an authoritative Commander result owner plus real, independent browser qualification environments. Those producers are still absent.

## E2.2/2.a — canonical output binding

The current code does not expose the transaction-aware Commander result-acceptance authority required by the plan:

- `server/src/services/job-admission-bridge.ts` documents and enforces `commander_turn` as inert. The application role has read-only access to `internal_agent_messages`, so the bridge cannot call `claimTurn` or produce a model/provider effect.
- `server/src/services/internal-agent/conversation.ts` exposes `claimTurn` and `finishTurn`, but `finishTurn` only fences the turn-status transition. It does not select and persist an accepted job attempt/output slot.
- `server/src/services/job-output-bridge.ts` projects a caller-authorized accepted output event into task outputs. It deliberately does not elect the accepted Commander attempt and therefore cannot substitute for the missing owner.

Creating `universe_output_bindings` without that owner would create a second, ungrounded acceptance authority. This increment remains blocked until replatform provides the exact admitted-job/attempt/slot, cancellation and claim-token transaction seam. When it exists, the planned replay, competing-attempt, stale-claim and cancel races must run against that real export.

## E6.0/1.b — contained Browser Use attachment

No Browser Use runtime/package is present in the current manifests or lockfile, and the existing browser runtime has no reviewed interactive attachment API. The current pipe-based Playwright runner remains contained; `packages/browser-runtime/src/launch-guard.ts` must continue rejecting CDP ports, remote-debugging switches and exposed endpoints.

Before implementation, qualification must pin the Browser Use version and prove it can attach to the worker-owned pipe/browser object without opening CDP or a remote WebSocket. If its supported API requires either endpoint, the adapter is blocked rather than weakening the guard.

## E6.0/2 and E6.0/3 — cloud and local qualification

These are evidence gates, not interchangeable unit-test work:

- Cloud needs the accepted cloud image/tier, authenticated media/input transport, metadata isolation, controller fencing and native-dialog/tab capability evidence.
- Local needs the actual desktop worker and a second authorized device, browser-only capture, disconnect/input denial and same-session reconnect evidence.

Neither environment is configured or authorized in this checkout. A local pass cannot certify cloud and a cloud pass cannot certify local.

## Required next inputs

1. Replatform lands and identifies the authoritative Commander distributed result-acceptance export and its cancellation/claim transaction.
2. The Browser Use package/version and pipe-attachment API are selected and reviewed without changing the launch guard.
3. Cloud and local qualification environments and accountable owners are named and authorized.
4. Re-run this gate review at the adopted replatform SHA, then implement E2.2/2.a and E6.0/1.b and execute E6.0/2 and /3 independently.

B13 generated-worker publication remains dependent on E2.2/2.a and must not be started through a fabricated binding. Independent work may continue only where the execution sequence has no dependency on this producer.
