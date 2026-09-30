# Programme ground-truth audit — 2026-08-25

**Method:** five parallel investigations at branch tip, each instructed to verify in CODE and
report where a document and the disk disagree rather than repeat the document. Findings below
were spot-verified independently before being recorded.

**Headline:** the ticket documentation is honest; the aggregation built on top of it is not.

---

## 1. Counts

| | Claimed | Actual |
|---|---|---|
| Plan nodes | "95 implementation tickets" (`program-design.md:316`) | **103** at audit time (105 after Sprint 0 added WRK-010, DEP-010) |
| Landed | "72 / 95 landed, 23 remain" (`HANDOFF-wave-3-4.md:12`) | **88 ids with a result doc; 84 fully landed, 4 partial, 15 backlog** |

Wrong in numerator, denominator and remainder. `HANDOFF-wave-3-4.md` §8's claim that E8/E9
have "no designs written" is also false — 11 design docs exist.

## 2. Gate clauses: ~70 verdicted

~19 genuinely proven · ~17 proven weakly · ~17 not proven · **17 UNPROVABLE** (the named
production path has zero callers). Only E1, E2 and E6 have a majority genuinely proven, and
all three are infrastructure epics checkable without a live worker.

The 17 are now enumerated in `scripts/gate-clause-wiring.json` and enforced by
`check-gate-clause-wiring.mjs` (TRACK-004).

## 3. The three findings that changed the plan

**E0's gate rests on a forward reference never redeemed.** All **30 of 30** Critical/High
trust crossings name REL-001/002/003/005 as their release test. Four of those five have no
design, no result, no code. `check-distributed-execution-foundation.mjs:745-749` accepts a
`REL-*` owner id **or a non-empty `releaseTest` string** — it never checks the test exists. It
reports PASS and will keep doing so.

**E8's one falsifiable-negative clause is false.** *"No host-side browser spawn reachable from
a boot root"* — but `server/src/services/internal-agent/cli-mode.ts:347` adds
`npx @playwright/mcp --headless` whenever `browser_use` is enabled, reached from
`heartbeat-mcp.ts:165` and `aoa-agents/runner.ts:795`. **Independently verified.**

**D1 has never executed the worker.** `tests/d1/lib/e6f-harness.mjs` pipes a script into the
container (`agentVersion: "e6f-03-harness"`). No line of `packages/worker-daemon/src`
poll/lease/renew/supervise code runs in the proof lane; the `aoa-worker` image is a network
location. Every D1 verdict about worker behaviour is a verdict about the harness.

## 4. Security guards with no falsifiable test

Same class as finding E1-F008, now found in auth and egress code. **All protect the DORMANT
distributed path, so none is live-exploitable today — which is exactly why they must be fixed
before dispatch is wired (Sprint 3).**

- **`egress-policy.ts:199` — a real fail-open.** Deleting `if (!parseIp(addr)) return "private"`
  passes the suite; an unparseable address then falls through to *allowed*, the opposite of the
  module header's promise. **Reproduced independently**: positive control confirms the suite
  exercises the function, and no vector tests a malformed address.
- `worker-session-auth.ts` — 22 of 25 guards deletable with the suite green, including the
  15-minute TTL ceiling and the scope↔tenant coupling; replacing `assertClaims()` with a raw
  `JSON.parse` cast survives. *Not re-verified on Linux — reproduce before acting on the count.*
- `worker-device-proof.ts` — Ed448 keys accepted (`asymmetricKeyType` guard untested); a
  garbage `issuedAt` makes the skew window vacuous (`NaN > maxSkew` is false).
- `packages/worker-protocol/src/policy.ts` (FROZEN) — the sandbox secret-file path grammar
  admits backslashes, control characters, doubled slashes, and a 5017-char target.

## 5. CI, correctly read

`pr.yml` sets `cancel-in-progress: false` for this branch, so pushes **queue** and GitHub
discards all but the newest pending run. **22 of the last 30 runs executed zero jobs** and
carry no information. Of the 8 that ran, 10 of 12 jobs were 7-for-7 green and all local guards
passed. One test was blocking the branch: `browser-teardown` BRW-002(c), root-caused in
Sprint 0 to a fixture named `/slow` that returned instantly instead of holding the navigation.

## 6. The pattern

**A gate clause names a capability, a ticket delivers the mechanism, and nobody checks that a
boot root reaches it.** `bin/worker-daemon.ts` says "INERT" four times. CLI-006's result says
its volume clauses "are NOT claimed here". SVC-001 says "storage half only". The D1 harness
says the capacity race is "proven separately". Nobody over-claimed at the ticket level.

Sprint 0's answer is mechanical, not editorial: `check-gate-clause-wiring.mjs` gives "epic
complete" a definition a machine can refuse.
