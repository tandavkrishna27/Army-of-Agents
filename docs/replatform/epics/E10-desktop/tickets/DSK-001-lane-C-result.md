# DSK-001 Lane C — result

**Date:** 2026-08-21
**Branch:** `docs/replatform-program` (PR #323)
**Start SHA:** `c91423049` (the Lane C design, committed before any code)
**Lane C tip:** `d0d73042a` — PR gate green, including `ci-required`
**Covers:** design D16 and I22 (DSK-00 negative closure)

---

## 1. What shipped

| # | Increment | Evidence |
|---|---|---|
| C1 | `executionTargetToAdapterConfig` throws for `desktop`, `e2b`, and any unhandled kind (F28) | 4/4 mutants |
| C2 | flag-off create of a `desktop` target is refused 403 (F27) | 3/3 |
| C3 | I22 clauses 2, 4, 5 asserted + a seven-clause manifest | — |
| C4 | `scripts/check-desktop-surface-disabled.mjs` for clauses 6 and 7, in the always-on `policy` lane | 4/4 |

38 tests across the three touched suites, 10 corpus tests, `tsc` clean, the checker
green on 114 real route files.

## 2. The two holes, and what they actually were

**F27** — `executionTargetRoutes` is mounted 97 lines outside the distributed-execution
flag block, and the create handler inserted `...input` directly. Flag-off, an org
owner/admin could register an **active** desktop target.

**F28** — a bare `return null` caught `desktop`, `e2b`, and every future kind.

The framing improved while implementing, and the better version is the reason `e2b`
throws too. On a **pinned** run the adapter-config return value has **no effect at all**:
`mergeResolvedExecutionTarget` writes `resolvedConfig` at `heartbeat.ts:3617`, but
`applyEnvironmentAcquisitionConfig` is applied afterwards at `:4466` and the code's own
comment calls it "always the authoritative, LAST-applied one". A pin always implies an
environment, so that patch is non-empty and overwrites the adapter config.

So returning a config and returning null were **the same no-op** — a throw is the only
outcome that changes anything. That turned "should e2b throw?" from a judgement call into
the only available answer.

Three supports, verified: the throw lands on a clean path (`pre_spawn_failed`, run marked
failed, leases and workspaces released); `assertUnsandboxedMultitenantAllowed`
early-returns unless `cloud_auth`, so the self-hosted modes DSK-00 must keep inert have
**no downstream guard** and this is the only one on the reachable surface; and Decision
#117 §4 already fails closed for an explicit pin when routing *errors*, so degrading
silently when routing *succeeds* onto an unmapped kind was an asymmetry nobody designed.

## 3. D16(b) is NOT built, and should not be

The design lists three fixes. Two shipped. **(b) — "make the pin branch throw on a
desktop-kind target when disabled" — is deliberately not built**, for two verified
reasons:

1. **It is redundant.** C1's throw is unconditional: a pinned desktop target now fails the
   run whether or not distributed execution is enabled. The security property is already
   closed; (b) would only move the failure earlier and word it better.
2. **It is not the "two-line change, no new plumbing" the design describes.** That phrase
   attaches to (a), where `opts.workerSession` is genuinely in scope. It does not extend
   to (b): `chooseExecutionTargetRow` is a pure function with no flag input,
   `resolveExecutionTargetForRun` carries none either, and the flag is read exactly once
   (`config.ts`) and threaded by DI to `app.ts` — it is **never readable at heartbeat or
   service scope**. Building (b) means either a new threaded parameter through two callers
   or a `process.env` read at service scope, which breaks the DI pattern.

Adding plumbing to improve an error message, on a path that is already fail-closed, is not
worth the coupling. Recorded as a decision rather than an omission.

## 4. Verification

- **Fail-first on both behaviour changes.** F28: 4 RED, including "expected 'e2b' to be
  'local_host'" — the hole stated as a property. F27: 2 RED.
- **Mutation-tested: 11 mutants, 11 killed** — after **three** survived and every one
  found something:
  - **C1/X1 + X2** survived because disabling the named `desktop`/`e2b` branch *still
    threw*, via the generic unhandled-kind arm, so a loose `/desktop/` assertion could not
    tell them apart. Same security outcome, different operator-facing diagnosis. The
    assertions now pin the specific messages.
  - **C4/Z3** (removing comment-stripping) survived because my comment test used
    whole-line comments, which the route-registration filter skips anyway. Only a real
    registration with a *trailing* comment distinguishes the two mechanisms — the exact
    shape a reviewer writes when documenting why a route is absent.
- **The corpus caught a hole in my own pattern**: `/api/updates/desktop` escaped, because
  the alternation had `update` and could not absorb the plural. Fixed, with plural cases.
- **A false negative in my own structural scan**: these files are CRLF and my scan used
  bare `\n`, so it matched nothing and reported "the mount is not there" — which would
  have made clause 2 look satisfied for the worst possible reason. One normaliser now
  feeds every source-reading assertion.
- **The 7 unrelated failures in the full local server suite were verified pre-existing**
  by stashing the change and re-running the same files. They are the known Windows-local
  set that passes on the Linux lane.

## 5. Decisions recorded rather than taken silently

| Decision | Why |
|---|---|
| **403, not I22's literal 400** | This file already refuses a disabled registry twice with `forbidden(...)`. A schema-level refinement would have yielded 400; the two are incompatible and the choice is deliberate. A disabled capability is "you may not", not "your input is malformed". |
| **GET is not filtered** | D16 rejects it — hiding an already-enabled row is worse for incident review. There is a test pinning the rejected alternative, so nobody later "fixes" clause 1 by filtering. |
| **Clause 5 is structural, not a grep** | `ui/` holds ~104 "desktop" occurrences, all responsive breakpoints. A grep guard would be noise that someone eventually silences. The assertion pins the hardcoded closed union *and* that it is not derived from `EXECUTION_TARGET_KINDS`. |
| **No compile-time `never`** | `kind` is `text` with no CHECK constraint, so the DB really can hold an unknown kind. An exhaustiveness assertion would claim a guarantee the data layer does not provide. |

## 6. Operator-visible consequence

**This changes shipped behaviour and belongs in the release note.** Any deployment that
already created a `desktop` or `e2b` execution target and pinned a run to it will now see
that run **fail** (`pre_spawn_failed`) instead of silently executing on the control-plane
host. That is the intended outcome.

Scope of the blast radius, checked rather than assumed: nothing in the repo constructs an
`e2b`-kind row; the only migration that mints a `desktop` kind
(`0219_worker_enrollment.sql`) hardcodes `'disabled'` on the same INSERT, and
`chooseExecutionTargetRow` filters on `status === "active"` first, so those rows were
never routable.

The one hypothetical: an operator who paired an e2b *environment* with an e2b-*kind*
target as bookkeeping would see that run fail. Zero instances exist in code, tests,
fixtures, migrations or docs. If that pairing is ever wanted, the right shape is an
explicit branch proven by the acquire's resolved sandbox — not a restored fallthrough
indistinguishable from the dangerous case.

## 7. Noted for later, not fixed here

- **A stronger doc-pin primitive already exists.** `check-distributed-execution-foundation.mjs`
  has `requireNegatedMention` — needle present *and* every sentence mentioning it negated —
  which is a better fit for clause 6 than my two-phrase match. Mine has its own adversarial
  corpus and fails closed on a missing file; adopting the stronger primitive is a cheap
  follow-up, not a gap.
- **`pr.yml` line citations in the E10-desktop docs are stale by +2** below line 165. One
  is actively misleading: `:1016` now lands on a different, valid-looking variable. Cite by
  name rather than by number.
