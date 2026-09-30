# DAT-010 Result — retention is control-plane-owned at commit

**Status:** LANDED. **Start SHA:** `b569176b0` ([`DAT-010-design.md`](./DAT-010-design.md)).
**Closes:** [`FINDING-retention-authority-and-DE-11.md`](../../../FINDING-retention-authority-and-DE-11.md) §3
(the authority inversion). **Does NOT close** §1/§2 (the document overclaims) or the
enforcement follow-up.

---

## 1. What landed

`artifact-commit.ts` no longer stores `manifest.retention`. It derives the class from the
frozen `kind` via `resolveStoredRetention` → `browserArtifactRetention`, and **ignores what
the manifest claims**.

That gives `browser-artifact-retention.ts` — which had **zero production callers** — the
caller it was written for, and makes its own stated invariant true: retention is
*"control-plane-owned, and never caller- or worker-supplied"*.

**A worker can no longer choose the retention of its own `browser_cookie_state` or
`browser_storage_state` artifact** — bytes the module describes as *"a usable credential"*.

## 2. Acceptance

| Clause | Artifact | State |
|---|---|---|
| A worker-declared class is IGNORED | `audit` declared for `browser_cookie_state` → stores `ephemeral` | ✅ |
| Both credential-bearing kinds covered | `browser_storage_state` likewise | ✅ |
| An unknown kind fails **SAFE** | unrecognised kind → `ephemeral`, the shortest class | ✅ |
| Total over the frozen enum | table-driven across all 12 `ARTIFACT_KINDS` | ✅ |
| No spurious signal on the common path | matching declaration → not flagged | ✅ |
| A disagreement is observed | including the harmless direction | ✅ |
| An absent declaration is not "agreement" | flagged, not silently accepted | ✅ |
| No behaviour change elsewhere | `artifact-transfer-commit.integration` 17/17, run for real | ✅ |

**Mutation: 5 mutants, 5 killed**, including **M1 — reverting to the worker's declared
value** and **M5 — flipping the fail-safe from `ephemeral` to `audit`**. 7 unit tests.

## 3. Two decisions worth keeping

**Override, not reject.** The security property comes from *ignoring* the declared value, so
refusing a disagreeing manifest would add a failure mode for no additional security — on the
commit path, which is where real work is lost. The disagreement is reported instead.

**`declarationIgnored`, not `downgradeAttempt`.** A worker declaring a *shorter* class than
derived is not an attack, but it is the same bug class: the worker computed something the
control plane did not. Naming the flag for the hostile case only would train readers to
dismiss the benign one.

## 4. `sensitivity` deliberately unchanged

`artifactSensitivitySchema` is a **single-valued literal**, so the frozen schema already makes
it unforgeable and deriving it would compute a constant. The reason is recorded **at the call
site**, so the next reader does not "fix" the asymmetry with a no-op — and so that if
`sensitivity` ever gains a second value, that comment is the reminder it must move to the
control plane the same day.

## ★ 5. What this does NOT do

- **It does not enforce retention.** Nothing reads the column to act. This makes the stored
  value **trustworthy**, not **effective**. The enforcement follow-up now has a sound
  foundation — and, per the finding, must not have started before this.
- **The mismatch signal is a log line, not an audit record.** DE-11 claims *"retention are
  audited"*; nothing audits. A log is honest and cheap; it is not that audit trail and does
  not pretend to be.
- **It does not correct DE-11 or the five other overclaiming documents.** That is a
  security-register change and belongs with its owner.

## 6. Verification

`tsc` clean. Full **server suite run before pushing** — 1305 files pass; the 5 failures are
pre-existing Windows-local ones (`e2e-company-seed-contract`,
`release-smoke-google-only-contract`, `runtime-service-control`, `sweep-steward`,
`workspace-runtime`, plus `crew-post-e2e.live` which needs a real CLI). Attribution was done
by stashing and re-running earlier in this session: identical failures with and without the
change, and Linux CI shows only unrelated ones.

Running the full suite here is the direct correction to the previous slice, where targeted
tests missed a closed-surface contract in a file I had never opened.
