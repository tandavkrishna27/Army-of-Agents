# E8 — Browser Automation

**Status:** `backlog`
**Depends on:** E7; BRW-006 additionally requires `E10-REALTIME-FOUNDATION`
**Tickets:** BRW-001 through BRW-008 (007/008 added 2026-08-23 — see
[`scope-addendum-agent-and-commander.md`](./scope-addendum-agent-and-commander.md))
**Exit gate:** sandbox-local browser, evidence, approvals, network/secret policy, cancellation, cleanup, and D3 reconnect journey pass; agents can request a session and Commander runs on the governed path with no host-side browser spawn reachable from a boot root.

## Mandatory planning brief

The E8 plan keeps CDP/browser control inside the job sandbox and treats cookies, storage state, traces, video, and downloads as restricted artifacts. It defines approval command/ACK and timeout semantics through PRT-007, broker-owned connector refresh, fence-bound materialization, bounded payloads, retention, and clean-session versus explicitly approved checkpoint retry. D3 covers metadata/private/control-plane denial, redirects/DNS rebinding, credential rotation/revocation, stale fences, cancellation/cleanup, artifact authorization/digests/order, and `E10-REALTIME-FOUNDATION` reconnect/gap/duplicate behavior. Browser is a mandatory private-beta workload: E8/D3 blocks REL-005 even when its exposure flag is off.
