# WRK-010 slice 1 — Result: the renewal ROUTE lands, and NOTHING calls it (on purpose)

**Status:** LANDED — slice 1 (server-side only). **Sprint 1** of the go-book.
**Epic:** `E4-worker-daemon`. **Start SHA:** `02ff9b627` (sprint-start tip; the design was pre-written
and twice-reviewed — [`WRK-010-design.md`](./WRK-010-design.md), last touched `e81ccfb4d`).
**Commits:** `aff089665` → `c1c5530f5` (6: skeleton → guards → service → route+integration →
arm-1-isolation → review-fixes) + the docs commit that carries this file.
**Advances — does NOT close — finding:** `E4-F007` (stays **`open`**, HIGH).

---

## ★ 0. The headline, because an unread result doc is how a zero-caller route becomes a claimed capability

**This slice ships a route that has ZERO production callers, and that is correct.** `POST
/api/worker-control/session/renew` exists, authenticates, and mints — but nothing in production
POSTs to it, and nothing wires `SessionStoreDeps.renew` (`identity/session.ts:55`) to it until
**Sprint 2.5** (WRK-010 slice 2). So **E4-F007's own statement of the defect — a worker near expiry
has no path to a fresh session once the ten-minute code route lapses — remains TRUE of every worker
after this ticket ships.** Step 7 therefore left `E4-F007` **`open`** and touched no manifest status;
it appended a dated addendum instead. This is the exact shape of the 17 unprovable gate clauses the
programme's audit exists to fix — shipped alone it is honest dormancy, and it is labelled as such
everywhere it could be misread.

**The first design of this ticket would have shipped a duplicate authority surface.** It routed
through the transport-only `verifyWorkerOperationProof` and re-implemented every authority guard in a
new pure function. An adversarial review round refused it: the route it mirrors uses the shipped
`createWorkerSessionAuthenticator`, which already performs nine of the ten guards (including a `scope`
check the draft's list omitted). The revision adopts the authenticator and shrinks the owned decision
to the one guard the authenticator does **not** perform — a platform-physical denial (R1). One
re-used authenticator plus one denial is not a new authority system.

---

## 1. What shipped

| File | What |
|---|---|
| `services/worker-session-renewal-admission.ts` | NEW. Pure `admitSessionRenewal(input)`: R1 (platform-physical denial, reachable) + R2 (shared-platform-authority defence-in-depth, unreachable). Returns the IDENTITY half of the claims; the 15-min ceiling and iat/exp are deliberately absent. |
| `services/worker-session-renewal.ts` | NEW. `sessionRenewRequestSchema`, the LOCAL `SESSION_RENEW_DESCRIPTOR` (2 KiB, audience `device_session`), `mintRenewedSession` bound to `SESSION_MAX_MS`, and `createWorkerSessionRenewalService` — auth (via the injected authenticator) → admit → mint, in two separate try blocks so the mint/auth error split cannot collapse. |
| `routes/worker-control.ts` | MODIFIED. One route + one authenticator+service construction. Calls the authenticator DIRECTLY (never `requireWorkerHeartbeatAuthority`, so the legacy bearer credential can never reach a freshly-minted session). |
| `middleware/worker-session-auth.ts` | MODIFIED. `export` on `const SESSION_MAX_MS` + a comment. **The entire diff is one keyword** — zero behaviour change. |
| `__tests__/worker-session-renewal-admission.test.ts` | NEW. Positive-control-first unit matrix (R1/R2, exhaustiveness, anti-vacuity). |
| `__tests__/worker-session-renewal.test.ts` | NEW. Service tier: constant binding, descriptor, mint ceiling, the internal_unavailable/unauthorized split. *(Not in the plan's §3.1 file list — see §6; §7 Step 3 requires it.)* |
| `__tests__/worker-session-renewal.integration.test.ts` | NEW. Embedded-PostgreSQL — the SOLE home of the authority matrix (§10 R6). |
| `__tests__/worker-control-body-limits.test.ts` | MODIFIED. One parity assertion: the local descriptor mounts strictly below the prefix body limit (M8). |
| `__tests__/desktop-disabled.negative.test.ts` | MODIFIED. One structural dormancy clause (the conjunct this diff owns). |
| `epics/E4-worker-daemon/findings.md` | MODIFIED. E4-F007 addendum (Status stays `open`); new LOW **E4-F014** (the DSK-001 phantom-symbol claim). |
| `scripts/finding-ownership.json` | MODIFIED. E4-F007 key **untouched**; new `E4-F014` declaration (`unowned`). |

## 2. Acceptance mapping — what proves each clause, and at which tier

| Acceptance clause | Test | Tier |
|---|---|---|
| valid device proof → fresh session, no code, no human | integration `★ THE POINT` | embedded-PG only |
| revoked target refused, same coarse code | integration `refused once REVOKED` + revoked-by-`revoked_at` | embedded-PG only |
| disabled target refused, same coarse code | integration `refuses a DISABLED target` | embedded-PG only |
| generation-superseded refused (3-way, both directions) | integration `generation supersession` | embedded-PG only |
| not mounted when distributed execution is off | `desktop-disabled.negative.test.ts` clause (a) `worker-control.ts` holds the registration | unit |
| the ten-minute code route is never consulted | integration `never consults the enrollment code table` | embedded-PG only |
| the 15-minute ceiling is unchanged | `worker-session-renewal.test.ts` (mint boundary) + integration `exp-iat===900` | unit + integration |
| renewal issues a NEW session, not an extension | integration `s1 !== s0`, `iat >` | embedded-PG only |
| platform PHYSICAL renewal refused (enforced, not inherited) | admission R1 arm 1 + integration `platform PHYSICAL is refused` (now log-reason-isolated) | unit + integration |

**SIX of the nine clauses have the embedded-PG suite as their ONLY evidence, and that suite is
`describe.skipIf(win32 && AOA_RUN_WIN_INTEGRATION !== "1")` — which a plain `pnpm test` on Windows
renders GREEN by skipping.** Run it with `AOA_RUN_WIN_INTEGRATION=1` locally; Linux CI runs it
unconditionally. This is a local-verification gap, not a CI one.

## 3. Mutation table — 8 mutants, 8 killed, 0 survivors, 0 documented equivalents, 0 false kills

Every mutation was a DELETION or a value change (never a rewrite-to-equivalent), the anchor-match was
printed before each run, and a POSITIVE CONTROL ran first per file.

| # | Mutant | Killed by | Reachable in prod? |
|---|---|---|---|
| **posctrl A** | admission always-refuses | admission suite RED | (control) |
| M1 | delete R1 arm 1 (`=== null`) | admission arm-1 case (now scope-isolated) | yes |
| M2 | delete R1 arm 2 (`scope === "platform"`) | admission arm-2 case (NON-NULL org) | no — unreachable, labelled |
| M3 | delete R2 | admission R2 case | no — unreachable, labelled |
| M4 | R2 fires for EVERY target | admission org/owner positive controls | yes |
| M5 | collapse the narrowed identity scope | admission owner/organization identity assertions | yes |
| M6 | `TTL = SESSION_MAX_MS + 1000` | service mint test (dies at the mint helper) | yes |
| M7 | collapse the mint/auth split | service `MINT WorkerSessionError → unavailable` test | **no** — the mint-error branch is defensive/unreachable; killed by an INJECTED-mint seam |
| M8 | raise the descriptor `maxRequestBytes` | body-limits parity assertion | yes |
| **posctrl B** | service `renewed` → `unavailable` | service suite RED | (control) |

**★ M7 correction (adversarial review, completeness critic).** The plan's §10 table marked M7
"Reachable: yes." That is inconsistent with the disciplined "no" on M2/M3: the mint's
`WorkerSessionError` cannot occur in production (`WORKER_SESSION_RENEWAL_TTL_MS === SESSION_MAX_MS`
makes `exp-iat` always 900, and `assertClaims` cannot fail for an authenticator-validated identity),
so M7 is killed only through the `mint?:` test seam. The honest answer is "no," and the source comment
(`worker-session-renewal.ts`) now carries the same defensive/unreachable hedge R2 gets. No acceptance
clause maps to M7, so it was never over-counted as coverage.

**Fail-first was observed at every step:** module-absent RED (Steps 1, 3), skeleton-admits RED
(Step 2), and a route-rename positive control reddened both the dormancy clause and the integration
`THE POINT` (Step 4).

## 4. The adversarial review — 4 independent reviewers, 0 HIGH/BLOCKING, 3 LOW fixed

One reviewer per dimension changed (security/authority, integration-coverage honesty, plan-fidelity/
registers, and a completeness critic). All verified claims against source by opening files. **Zero
HIGH or BLOCKING findings — so no refutation skeptics were spawned** (that step is reserved for
HIGH/BLOCKING). Three LOW rigor gaps survived and were fixed in `c1c5530f5`:

1. **Integration (E1-F008 shape):** the platform-PHYSICAL 401 asserted only status, not the
   discriminating log reason — a regression moving the refusal earlier (`verifyCurrent` throwing
   `target_revoked`) would have passed. Fixed: a `warnSpy` now isolates
   `worker_session_renewal_platform_physical_unsupported`.
2. **Mint-error labelling:** the one defensive/unreachable path in the set was not hedged like
   R2/M2/M3. Fixed in the source comment and the M7 row above.
3. **Stale line citations:** the dormancy comment cited line numbers an inserted test had shifted.
   Fixed: cite by construct (the standing test names).

The security reviewer's transparency note (not a defect): a **pre-handler** parse error (malformed
JSON, or a body above the ~320 KB parser mount) is thrown by `express.json` before the handler sets
`res.locals.workerProtocolV1`, so it renders a bare `{error}` rather than a `ProtocolErrorV1`
envelope. This is identical pre-existing behaviour across all nine sibling worker-control routes,
leaks nothing (no correlationId can be echoed from an unparseable body), and the plan §7 Step 4
already discusses it. A legitimate ~200-byte renewal client never reaches it; the descriptor's 2 KiB
guard is genuinely live (well under the mount).

## 5. What this does NOT claim / deliberately NOT in this push

- **No caller.** `SessionStoreDeps.renew` still points at the enrolment code replay; the daemon
  client, the near-expiry threshold, and the first-session acquisition (E4-F012) are **Sprint 2.5**.
  Until then this route is inert and E4-F007 stays open.
- **No `check-worker-path-parity` entry.** Its `PAIRS` list gains the renewal pair only when slice 2
  adds the daemon constant; running it now proves nothing for this ticket.
- **The 15-minute ceiling is untouched.** Renewal mints a new session; `SESSION_MAX_MS` is unchanged
  and re-asserted at the mint helper.
- **Refusals collapse to two operator log classes, not nine** (`target_revoked`, `unauthorized`) plus
  the two admission reasons — a consequence of reusing the authenticator (§5/R4 of the design). Both
  render 401 on the wire; the split is log-only.
- **The replay-row-expiry / renewal-headroom invariant (≥5 min) is slice 2's**, pinned as a delivered
  requirement, not a scheduling preference (design §3.5(i), §9.1(2)).

## 6. Claims I could not fully prove, and deviations from the plan

- **The product control is weaker than the plan's prose.** §7 Step 5 says spend `s1` on poll and
  "get a **200** `no_work` … no fixture setup beyond what is already here." That is not achievable:
  the org poll requires a ratified placement profile AND a recent heartbeat measured against the DB's
  **real** clock (not the injected clock the renewal route uses), both orthogonal to the auth claim.
  The shipped control instead asserts the poll is NOT `401`/`unauthorized` — which genuinely proves
  `s1` satisfies `verifyWorkerOperationProof` (the OTHER verifier), because that verifier runs first
  and a rejected token would 401. Honest coverage of the mapped clause (the fresh session is directly
  asserted); the plan's "get a 200 / no setup" prose is contradicted by the shipped test's own
  comment. Reaching a real `200 no_work` is left for a sprint that stands up the placement+heartbeat
  scaffold.
- **A third test file was added** (`worker-session-renewal.test.ts`) that §3.1's file list does not
  enumerate. It is the service-unit tier §7 Step 3 requires; the separation is deliberate (the
  integration file declares itself the sole home of the authority matrix). Breaks no register
  (`test-inventory.json` is floor-mode for `server`; `check-execution-census` tracks only `*.test.mjs`).
- **The M7 reachability label** was wrong in the plan (§3 above); corrected here and in the source.
- **`draining`/`offline` renew successfully** is asserted at integration level only, not by a mutant
  (the guard lives in shared middleware; mutating it would kill unrelated tests). Weaker evidence than
  a mutant, labelled as such in the test.

## 7. Registers + CI

All five registers pass: `check-ticket-graph-coverage`, `check-finding-ownership` (14 open findings;
E4-F013 + E4-F014 unowned on the record; E4-F007 key untouched), `check-guard-inventory`,
`check-gate-clause-wiring` (E4-1 stays dormant — this ticket touches no gate clause),
`check-execution-census`. Typecheck clean; 69 worker-surface tests green with no regression.

**`verify` is RED on this branch for reasons that predate Sprint 1** (go-book §2.0: the job has hit
its 60-minute `timeout-minutes` cap on five consecutive runs, on SHAs pushed before any Sprint-0
commit). The timeout was **not** raised to make it green — that would convert a regression into a
permanently slower gate and hide its cause. Sprint 1's code is green (`policy`, `brand-check`,
`e2e`, `migrations`, and the rest); its definition of done inherits the pre-existing `verify` red,
stated out loud here per §2.0.
