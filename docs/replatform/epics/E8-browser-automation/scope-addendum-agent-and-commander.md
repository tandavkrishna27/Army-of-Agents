# E8 scope addendum — BRW-007 and BRW-008

**Added:** 2026-08-23, Lane B (`C:\e8`), during BRW-002 terrain.
**Authority:** programme owner decision, recorded here because a decision that lives only in
a session transcript is not tracked — this programme's own rule is that prose in a
transcript is not evidence.

---

## Why these tickets exist

E8's six BRW tickets build the browser as a governed **workload type** (`browser_session`)
and the founder-facing surface for it. Terrain during BRW-002 found that this delivers the
capability and its governance but leaves **two entry points missing**, which together mean
E8-as-specified ships a capability that nothing can invoke — the `checks-that-nothing-runs`
shape this programme has been bitten by repeatedly.

**Gap 1 — no agent can ask for a browser.** `browser_request` exists as a submit source and
carries `parentJobId`, clearly designed for a session spawned from another job, and
`job-submission.ts` already injects `requiredCapabilities: ["browser.chromium"]` for it. But
no MCP tool exists for an agent to request one. Verified: no production producer of a
`browser_request` source exists anywhere in the tree. Org and crew agents inherit the
plumbing, not the entry point.

**Gap 2 — Commander is not covered.** Commander's `browser_use` capability spawns
`@playwright/mcp@0.0.75` via `npx --headless` **on the control-plane host**
(`server/src/services/internal-agent/cli-mode.ts:347-350`), inside Commander's own
subprocess. It has no sandbox, no tenant boundary, no evidence capture, no approval gate, no
credential brokering, and no cancellation semantics. `commander_turn` is a real job source
but maps to workload `batch`, so Commander has a job path and its browser does not use it.

**Consequence if both are left open:** two browser mechanisms coexist — one governed, one
not — sharing the reserved `playwright` MCP name (`RESERVED_MCP_SERVER_NAMES`), with the
ungoverned one being the easier to reach by accident.

## Decision on the host-side path

**Retire it once the governed path is proven**, not before. The host-side spawn stays
functional until a sandboxed browser session works end to end, then it is removed so exactly
one browser mechanism exists. Keeping both permanently was rejected: it leaves an
unsandboxed Chromium running on the control-plane host with no tenant boundary, which is the
configuration most likely to be selected by accident.

---

## BRW-007 — Agent-facing browser session request (M)

- **Depends on:** BRW-002, BRW-004, BRW-006.
- **Outcome:** Give org, crew, and one-shot agents a governed way to REQUEST a browser
  session — a tool that submits a `browser_request` job bound to the requesting agent's
  identity, task, and tenant, with the browser configuration validated at submit (BRW-001)
  and the session's evidence returned through the same durable sequence the founder view
  reads.
- **Acceptance:** A browser session may be requested only by an agent with an active task
  run — the `ask_human` precedent (`actorType:"agent"` with a live `agentId`/`runId`) — and
  is scoped to that agent's Organization, Company, and task. The request inherits the
  requester's authority: an agent can neither request a session for another tenant nor
  escalate its own credential, trust, or locality class. `parentJobId` binds the session to
  the requesting job so evidence, budget, and cancellation cascade. Requests fail closed when
  browser capability, budget, or concurrency is unavailable. **No agent ever receives browser
  control credentials or a CDP endpoint.**
- **Test:** Per-actor authorization matrix (agent kinds × sources), cross-tenant request
  denial, parent-job binding plus cancellation cascade, budget/concurrency refusal,
  fail-closed on a missing active run, and a log-leak test proving no control endpoint
  reaches the agent.

## BRW-008 — Commander on the governed browser; retire the host-side path (M)

- **Depends on:** BRW-007.
- **Outcome:** Route Commander's `browser_use` capability to a governed `browser_session` job
  instead of spawning `@playwright/mcp` via `npx` on the control-plane host, then remove the
  host-side spawn.
- **Acceptance:** With `browser_use` enabled, Commander obtains a sandboxed session through
  the same broker, approval, evidence, and retention path as every other agent. **No Chromium
  process is started on the control-plane host.** The reserved `playwright` MCP name resolves
  to the governed tool surface. A Company with `browser_use` disabled can reach no browser at
  all, by either path. Removal is proven by an **anti-orphan check that fails if a host-side
  browser spawn is reachable from a boot root** — the pattern REL-004 established after three
  admission verifiers shipped with zero callers; a deleted line is not a proof of removal.
- **Test:** Config-shape tests proving no host spawn under any capability combination, an
  end-to-end Commander browser journey through the governed path, a disabled-capability
  denial covering both paths, and the boundary check that no host-side spawn has a caller.

## Revised E8 chain

```
BRW-001 → BRW-002 → BRW-003 ─┬→ BRW-005
              (done)         │
                  → BRW-004 ─┴→ BRW-006 → BRW-007 → BRW-008
```

BRW-007 needs the runtime (BRW-002) and the credential/approval path (BRW-004) to be
meaningful, and the durable evidence sequence (BRW-006) to return anything useful.
BRW-008 needs BRW-007's tool surface to route Commander onto.

**Lane B is now 15 tickets:** BRW-001..008 + SVC-001..007.
