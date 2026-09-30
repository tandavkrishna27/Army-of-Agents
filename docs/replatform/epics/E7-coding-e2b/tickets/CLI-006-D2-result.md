# CLI-006 / D2 — Sprint 5 result: the real-E2B coding journey

**Status:** **harness extended; the full distributed coding journey on real E2B is UNPROVEN.** No
dispatched run cites the distributed journey against real E2B, so **E7-1 stays `unwired`** — the
honest "harness ready, journey unproven" state the go-book blesses, not a failure.
**Epic:** E7 (exit gate). **Plan:** `CLI-006-D2-execution-plan.md`. **Start SHA:** `ba30b2ba4`.
**Frozen, untouched:** `packages/worker-protocol`, the worker-daemon `SandboxProvider` port, the
`DE-*`/threat docs. No new hosted-API call (Rule #11).

---

## 1. What this sprint did — and the boundary it stopped at

Sprint 5 was to **run CLI-006's D2 lane on real E2B** end to end. The terrain finding that shapes the
whole result: **the "D2 lane" the go-book points at (`keyed-e2b-conformance.yml`) proves only the E2B
provider/adapter primitives; the CLI-006 distributed journey is proven only on the D1 lane against the
fixture FAKE provider. No single dispatched run ties the distributed journey to real E2B.** The
session therefore:

1. Wrote the execution plan mapping each hop to its evidence and the session/operator boundary
   (`CLI-006-D2-execution-plan.md`, Start SHA `ba30b2ba4`).
2. Built the one buildable, session-verifiable, genuinely-missing hop: the keyed real-E2B
   **artifact-commit / patch-integrity** case (D2-02's sixth class, named by the E7 exit gate),
   fail-first with a mutation-pinned pure predicate (`88c6a8b66`).
3. Applied adversarial-review fixes and filed **E7-F001** (`c43e7ae35`).
4. **Stopped at the dispatch boundary.** The session did **not** bump `.github/keyed-e2b-trigger` and
   did **not** trigger any real-E2B run — supplying the `E2B_API_KEY` and triggering are the
   operator's actions (real spend, outward-facing). See §5.

| Commit | What |
|---|---|
| `ba30b2ba4` | Execution plan (Start SHA) |
| `88c6a8b66` | Keyed artifact-commit case + `evaluatePatchIntegrity` predicate (fail-first, mutation-proven) |
| `c43e7ae35` | Adversarial-review fixes + E7-F001 (canary credential gap) |

---

## 2. Which hops are proven where (the honest evidence chain)

| Hop | Real E2B today? | Where the evidence actually terminates |
|---|---|---|
| create | **No** | PR mock + D1 **fake** provider |
| schedule | **No** | PR + D1 **fake** |
| lease | **No** | D1 (real worker, **fake** provider) |
| stage | **Provider leg only** | keyed CLI-002 `writeFiles`/`readFile` on real E2B; distributed staging on D1-fake |
| execute | **Provider leg only, and the canary credential hop is INERT** | keyed CLI-001/003 run `true`/`sh` (not a coding CLI) on real E2B; **the canary mints no credential — E7-F001** |
| stream | **Provider leg only** | keyed CLI-003 real stdout/stderr; distributed stream on D1-fake |
| produce (patch) | **Provider leg only, pending dispatch** | keyed **artifact-commit case built this sprint** (`88c6a8b66`) — reaches real E2B only once dispatched; server apply guard `patch-apply.ts` + D1 remain not-real-E2B |
| review | **No** | PR + D1 **fake** |
| cancel | **Provider leg only** | keyed CLI-003 `terminate` on real E2B; distributed cancel on D1-fake; D2-04 latency = campaign |
| audit | **Provider leg only** | PR (JOB-008) + keyed inspect redacted/zero-leak on real E2B |

**Distributed hops (create/schedule/lease/review) are proven ONLY by the fake provider — a mock.**
The keyed lane cannot stand up a control plane/worker/tenant DB, so it can never prove them; the D1
lane runs them on the fake provider, which the go-book rules out as evidence.

---

## 3. E7-1 disposition — held `unwired`, deliberately

`E7-1-coding-journey` stays **`unwired`** (`gate-clause-wiring.json`; symbol `E2bSandboxProvider`,
`expectedReferences: 2`, production caller count unchanged). It was **not** promoted, because no
dispatched run completed the **distributed** journey on real E2B. Promotion is owed to a **cited
dispatched real-E2B run that completes the distributed journey** — never a composed loop, the D1 fake
provider, the keyed provider-primitive lane, the keyed artifact-commit case (§2 hop 7 — provider leg
only), or a green-by-skip lane. This is the programme's central vacuous-green trap; the sprint did not
spring it.

---

## 4. The mid-sprint finding — E7-F001 (HIGH, filed unowned)

Terrain re-verification of the CLI-006 ↔ DAT-008 seam found that **the canary mints no
execution-secret handle**: the canary credential binding returns `credentialKind: null` by design,
which trips DAT-008's mint owner-authority gate (`owner_authority_disagreement`), so the canary
sandbox receives no provider credential — on real E2B just as on the fake. This is the same bound
`CLI-006-result.md` deferral 2 records, with a **corrected mechanism** (that deferral's "no production
writer" is stale — DAT-008 landed the writer). Filed HIGH/unowned as **E7-F001**
(`epics/E7-coding-e2b/findings.md`), the stale deferral and a stale
`canary-credential-binding.ts` comment corrected to point at it. **Consequence:** even a dispatched
real-E2B canary run could not exercise "execute a credentialed coding task" until E7-F001 is owned —
a real, additional blocker to the full-journey milestone, fail-closed, blocking nothing shipped.

---

## 5. The exact operator step still owed

**Two distinct real-E2B legs are owed, and they are not the same run.**

**(a) The keyed provider lane (small, cheap, ready now).** Proves the provider/adapter hops on real
E2B, including the artifact-commit case built this sprint. `workflow_dispatch` is unavailable on this
branch (the workflow is not on `main`), so the **only** trigger is the sentinel push:

```bash
# operator, with E2B_API_KEY already in repo secrets:
printf '\nkeyed-e2b re-trigger #4 (Sprint 5): CLI-006/D2 artifact-commit + patch-integrity real-E2B case.\n' >> .github/keyed-e2b-trigger
git commit -am "keyed-e2b: fire Sprint 5 artifact-commit case" && git push origin docs/replatform-program
```

Capture: the run id/URL; the keyed suite result (the **artifact-commit case must PASS, not skip**);
and that no `E2B_API_KEY`/redeemed value appears in any log. This does **not** promote E7-1 (provider
leg only).

**(b) The full distributed journey (large, real spend, blocked by E7-F001).** The substrate exists but
is dormant/deploy-only: `docker-compose.staging.yml` (real-E2B distributed topology, render-checked
only) and the `testing.armyofagents.org` cloud_auth instance (`deploy-testing.yml`, real key +
CLI-loaded template). The E7 exit gate names a **staging/testing-instance canary campaign** — set one
Organization `mode:"canary"`, run the coding journey, capture D2 evidence. **This is owed BOTH the
operator campaign AND resolving E7-F001** (until the canary mints a credential, the coding CLI in the
sandbox cannot authenticate). A Sprint 5-continuation ticket owns wiring the journey assertion onto
that substrate; the campaign and its spend are the operator's.

**Until a dispatched run is cited, the real-E2B leg is UNPROVEN. E7-1 stays unwired.**

---

## 6. Registers + CI

- **Five registers green** on the tip (`gate-clause-wiring`, `finding-ownership` — now 11 open / 4
  unowned incl. E7-F001, `ticket-graph-coverage`, `guard-inventory`, `execution-census`).
- **The `policy` gate job** — its register/boundary/finding-ownership/gate-clause steps passed on CI
  on the first push (`c0e4426c4`, steps 1–22). One step failed: **"Test-suite inventory"**
  (`check-test-inventory.mjs`) — a policy-job guard **outside the five registers** that pins
  per-package test-file counts; the new `patch-integrity.test.ts` took `sandbox-e2b-provider` 8→9.
  Fixed by bumping the pin (`bef0fb505`, `--write`), verified green locally (2645 files / 18 trees).
  The lesson: a test-file add/remove must bump `scripts/test-inventory.json`, and the full policy
  checker set is broader than the five registers.
- **`sandbox-e2b-provider`**: 44 pass / 19 keyed-skip; `tsc` clean; boundary checker PASS.
- **`verify` inherits the §2.0 red** (pre-Sprint-0 CI timeout regression). Not raised, not masked.

## 7. Adversarial review — what it caught

Three independent reviewers (plan-facts, keyed-case/predicate, completeness critic), refute-by-default;
the controller re-traced each finding from source (the skeptic pass). **No HIGH survived against the
deliverable itself.** The completeness critic's MED (owed-work census under-cited the dormant staging
substrate) was applied — plan §3/§5 reframed to a staging-canary campaign. The plan-facts reviewer
confirmed all six load-bearing claims from source. The keyed-case reviewer confirmed non-vacuity + full
boundary safety and flagged two surviving `wellFormed` mutants, both now killed. The controller's own
re-trace surfaced **E7-F001** (the canary credential gap), filed rather than absorbed.
