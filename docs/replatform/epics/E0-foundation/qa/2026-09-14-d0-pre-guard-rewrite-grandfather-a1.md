# QA Result — D0, pre-guard evidence-record rewrites: audit and founder-ruled grandfather, attempt 1

**Date (UTC):** `2026-09-14`
**Epic:** `E0-foundation`
**Record path:** `docs/replatform/epics/E0-foundation/qa/2026-09-14-d0-pre-guard-rewrite-grandfather-a1.md`
**Scope slug:** `pre-guard-rewrite-grandfather`
**Revision:** `1cf5839f23f0c758661a12d03628226105758e33`
**Attempt:** `1`
**Supersedes:** `none`
**Lane:** `D0`
**Result:** `pass`
**Failure class:** `none`
**Campaign start (UTC):** `not_applicable`
**Campaign end (UTC):** `not_applicable`

> This file is immutable from its first commit. A correction, rerun, changed decision, or changed revision creates a higher attempt and links this path through `Supersedes`.

## What this record is

The ledger's own account of three pre-guard in-place rewrites of evidence records, and of
the founder's ruling that pins them. The evidence-immutability guard
(`scripts/check-evidence-immutability.mjs`, armed as the deny's first production caller by
PR #390 on 2026-09-09) gained a pre-ledger-base arm on PR #462 so the program→main pull
request (#323, base=`main`, which holds no `docs/replatform/` tree) is checked against an
explicitly empty baseline instead of being refused. That unblinded the within-PR walk over
the program branch's full history, which found THREE genuine in-place rewrites of
QA/handoff records — each a breach of `docs/replatform/artifact-policy.md:54,67`
("write-once from its first commit"; a correction is a NEW attempt carrying `Supersedes`)
— all committed before the guard existed, on CI that was green at the time.

The three records were edited in place instead of being superseded; per the policy's own
correction rule this note is the appended corrective record: the story lives in the
ledger, not only in the guard's config.

## The three grandfathered events

| # | Record | Introduced by | Rewritten in place by | Account |
|---|---|---|---|---|
| 1 | `docs/replatform/epics/E5-workspaces-secrets/qa/2026-08-24-d0-e5-exit-gate-audit-a1.md` | `6fc46988a4aa1de851e27e9454ecfd5bbe280e77` | `4379a2c53447a861f0bd6398ecef8f70392e07b2` | The documented founding breach of E0-F014 item 3: a `★ CORRECTION` paragraph inserted in place (+24/-4) while the record's own `Supersedes` field still read "— (E5 has no prior QA record; this is the first)". |
| 2 | `docs/replatform/epics/E2-tenant-kernel/qa/2026-08-10-d0-e2-tenant-kernel-21335854f-a5.md` | `7843b86e25eb1ff9c520308aef7f123fec6997a7` | `6b1af52a4db8a0fa41514db564e8cb622b02e1ba` | Found by the PR #462 investigation the moment the pre-ledger arm unblinded the within-PR walk: the E2 epic-completion pass edited its own QA record in place. |
| 3 | `docs/replatform/epics/E2-tenant-kernel/handoffs/2026-08-10-epic-completion-21335854f-a5.md` | `7843b86e25eb1ff9c520308aef7f123fec6997a7` | `6b1af52a4db8a0fa41514db564e8cb622b02e1ba` | Same commit pair as row 2, handoff half. |

## The ruling and its shape

Grandfather allowlist ruled by the founder 2026-09-14: **explicit pinned pairs;
ratchet-from-now.** Enacted as `GRANDFATHERED_REWRITES` in
`scripts/check-evidence-immutability.mjs`:

- Each event is pinned by the RECORD PATH plus BOTH exact 40-character commit SHAs
  (introducing and rewriting) — never by path or pattern alone, so the exemption can only
  ever match these three immutable historical events; no future commit can collide into an
  entry.
- A grandfathered rewrite is RE-PINNED, not forgotten: from the rewriting commit onward
  the record's expected content is the rewritten blob, so any FOURTH rewrite — or any
  later touch of these three records — is still denied.
- The guard's self-test pins the allowlist's length at exactly three and verifies every
  entry against real history (both SHAs must exist as commits, the rewriting commit must
  descend from the introducing one, the record must exist at both, and the blobs must
  genuinely differ, with the rewriting commit itself touching the record). Growing or
  corrupting the list reds CI until deliberately reviewed.
- Green guard output discloses any grandfathered match in range; it is never silently
  absorbed.

## Commands

| Command | Exit code | Duration | Result summary |
|---|---:|---:|---|
| `node scripts/check-evidence-immutability.mjs --base origin/main` (pre-allowlist) | `1` | `29s` | 3 errors — exactly the three events above; no others in 1183 commits |
| `node scripts/check-evidence-immutability.mjs --base origin/main` (post-allowlist) | `0` | `31s` | OK (PRE-LEDGER BASE), 29 records, 3 grandfathered matches disclosed |
| `node --test scripts/check-evidence-immutability.test.mjs` | `0` | `~12s` | all tests pass, incl. allowlist-exactness and fourth-rewrite-still-denied controls |

## Assertions and evidence

| Requirement ID | Class | Required value/condition | Observed value | Evidence | Result |
|---|---|---|---|---|---|
| `GF-01` | `REQUIRED` | The within-PR walk over `origin/main..HEAD` reports exactly the three pinned events and nothing else before the allowlist lands | 3 errors, matching the table above | pre-allowlist CLI run recorded above | `pass` |
| `GF-02` | `REQUIRED` | With the allowlist, the same walk exits 0 and discloses the three matches | exit 0, 3 matches disclosed | post-allowlist CLI run recorded above | `pass` |
| `GF-03` | `HARD` | A rewrite NOT in the allowlist is still denied (the ratchet) | throwaway add-then-rewrite denied; re-pin covers later touches of the three records | guard self-test RED controls | `pass` |

## Failures

None.

## Cleanup

`not_applicable` — documentation-and-guard change; no sandboxes, databases, or artifacts.

## Gate effect

Permits the `policy` job's "Evidence-ledger immutability" step to evaluate the
program→main PR (#323) shape honestly: pre-ledger base handled, the three pre-guard
breaches pinned by ruling, and every record — including these three from their rewriting
commits onward — write-once from now.
