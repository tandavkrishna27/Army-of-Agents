# WRK-002 Result — Device identity and session lifecycle

**Status:** `complete`
**Disposition:** `pass` (with escalation E4-F007 filed; does not block WRK-002 CORE)
**Date opened (UTC):** `2026-08-12`
**Epic:** `E4-worker-daemon`
**Plan task:** `WRK-002 — Device identity and session renewal (M; three slices)`
**Implementer:** `Claude subagent (opus) — worktree C:\e3`
**Reviewer:** `Claude adversarial-review Workflow (4 dimensions → dedup → refute-by-default verify) + fix-round verification`
**Start SHA:** `d3a490a18` (JOB-003 acceptance commit)

## Acceptance model

Per the Wave-3 acceptance model, a multi-agent **adversarial-review Workflow is the independent
check**: 4 dimension finders (contract-fidelity, security-keys-proof, test-integrity,
boundary-packaging-build) → dedup → independent refute-by-default verifiers. It returned 3
confirmed findings (1 blocking, 1 should-fix, 1 nit-dup); all are resolved below.

## Dependency and scope state

- Consumes JOB-002 (`complete`/`pass`) as-built enroll/session HTTP contract + the frozen E1
  transport/schemas + the neutral shared device-proof vectors (`tests/fixtures/device-proof/v1/
  vectors.json`, E4-F001). Additive worker-only modules; **no server/db/migration change**;
  frozen `packages/worker-protocol` untouched.
- Runtime `dependencies` remain **exactly** `@armyofagents/worker-protocol` + `pino`;
  `@armyofagents/shared` is a **devDependency** (header contract cross-check only), which the
  boundary gate correctly ignores.
- Scope (amended per **E4-D11**): device-bound Ed25519 key + key store, transport-boundary device
  proof, enroll, **lost-response recovery** via replay within the code-route window, and
  rotation/revocation/terminal-401 handling. **Sustained session renewal past the 10-min
  code-route window is OUT of scope** (unsupported by the as-built JOB-002 server; escalated as
  **E4-F007**).

## Implementation (3 slices, subagent TDD)

- Slice A — vendored `aoa-*` headers + Ed25519 device key + canonical device proof, cross-checked
  against the shared vectors fixture. RED then GREEN.
- Slice B — mounted-secret + os-keychain(stub) key stores (fail-closed on corrupt) + enroll flow
  against a fake control-plane. The fake is an **independent verifier** (recompute canonical +
  `crypto.verify`); non-vacuousness proven by sabotaging the signer (`${canonical}SABOTAGE`) →
  4 component tests went RED, then reverted.
- Slice C — session lifecycle (recovery/rotation/terminal-401) + revocation.

## Independent adversarial review + fix round

**Confirmed finding 1 (BLOCKING, contract-fidelity):** the worker's replay-based session
*renewal* is rejected by the real server after the 10-min code-route TTL, but the green
renewal test passed only because the fake omitted that TTL — a test modeling a WRONG contract.
Independently verified against the real server: `worker-enrollment.ts:295` gates every enroll
(incl. replay) on `route.expiresAt < now()` (`CODE_TTL_MS=10min`, never extended);
`SESSION_TTL_MS=15min`; poll/ack never re-issue the session; enroll always needs the code header.

**Root cause = a JOB-002 server gap, not a code bug.** Resolution:
- Ratified **E4-D11**: replay-enroll is *lost-response recovery* (not sustained renewal);
  enroll-path denials (revoked/expired/proof-reuse/key-mismatch) all surface as **401
  `unauthorized`** (`target_revoked`/409 is poll/ack-only). Amended E4-D05 + the plan RED wording.
- Filed **E4-F007** escalation: sustained worker-session renewal is unsupported by the as-built
  server (10-min code route < 15-min session; no sliding renewal; no device-proof reauth). Needs
  an E3/JOB-002 server follow-up (does not block WRK-002 CORE).
- Fixed the code: the fake now stamps a code-route TTL at issuance and returns 401 for expired
  routes on both consume AND replay (faithful to `worker-enrollment.ts:295`); `SessionStore`
  drops the near-expiry renewal scheduler — a live session is returned unchanged, an absent/
  expired one triggers a lost-response recovery replay, and any enroll-path 401 makes the store
  **terminal**: it drops the identity, fails closed (`SessionStoppedError` — never spins), and
  emits a bounded-label `session_reenrollment_required_total{reason="enroll_unauthorized"}` +
  warn line. `session-renewal.test.ts` rewritten to assert within-window recovery (no
  double-consume) and post-window 401 → terminal stop; non-vacuous (RED without the fake's TTL
  rejection).

**Confirmed finding 2 (SHOULD-FIX, packaging; + nit dup):** `dist/` shipped the test-support
fake-control-plane because `tsconfig.json` excluded only `*.test.ts`. Fixed: `exclude` now
covers `src/__tests__`; `tsc --listFilesOnly` emits **0** files under `src/__tests__`.

## Authority and failure behavior

- The worker has no tenant/DB authority; it is a control-plane client. The private Ed25519 key
  never enters logs, metrics (bounded label keys+values), config, or serialized output; the key
  store fails closed on corrupt/unreadable content.
- Enroll-path 401 (revoked/replaced generation, expired code route, proof reuse, key mismatch) is
  terminal: the worker stops using the identity, backs off, and signals `reenrollment_required`.
- Lost-response recovery: a replay with the same code + retained idempotencyKey + unchanged digest
  + a fresh proof recovers the stored identity within the code window without double-consume.

## Operator-directed Windows-local evidence (from `C:\e3`; Linux CI = DEC-03 authority)

| Lane | Result |
|---|---|
| `pnpm --filter @armyofagents/worker-daemon exec vitest run` | PASS — **15 files, 90/90** (44 WRK-001 + 46 WRK-002 incl. rewritten recovery test) |
| `pnpm check:worker-daemon-boundary` + `node --test scripts/check-worker-daemon-boundary.test.mjs` | PASS — boundary PASS + 46/46 |
| `pnpm --filter @armyofagents/worker-daemon exec tsc --noEmit` | PASS — exit 0 |
| `npx tsc --listFilesOnly` (packages/worker-daemon) | PASS — 0 files under `src/__tests__` emitted; all 16 runtime sources present |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870…` | PASS — zero changed worker-protocol files |
| `pnpm install --frozen-lockfile` | PASS — no-op |
| runtime `dependencies` purity | PASS — exactly `@armyofagents/worker-protocol` + `pino` |

## Decision

WRK-002 is `complete` / `pass` for its CORE (enroll + device identity + key store + device proof
+ lost-response recovery + revocation/terminal-401). The sustained-session-renewal gap is a real
JOB-002 server limitation tracked as **E4-F007** (not a WRK-002 code defect). Not the E4
integration gate; carried on the cumulative Wave-3 branch. Next: **WRK-003** (poll/lease/ACK).
