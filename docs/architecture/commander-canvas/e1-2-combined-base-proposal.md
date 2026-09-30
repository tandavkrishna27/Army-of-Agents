# E1.2 combined-base proposal

Status: **qualified and adopted locally**; latest evidence below supersedes earlier failed qualification runs.

## Exact composition

- Universe branch: `codex/universe-interface`, HEAD `a996d507bb54fa9d4623ffd6ca9a9c95d321d550`.
- Existing adopted replatform ancestor: `b48132dac0f3435e017915e1e21ef1d66a39d0cd`.
- Proposed replatform input: `75350f1f634aec9b679d715aeefeb45287aa36e7`.
- Preserve the current uncommitted Universe implementation and planning files.
- Reconcile unpublished Universe migration numbers after upstream 0281/0282:
  generated combined 0283 persistence and 0284 receipts/checkpoints. No published
  upstream migration is rewritten. Drizzle detects no schema drift.
- One isolated test-only correction resolves `playwright-core` through the declared
  `playwright` dependency, preserving the image/runtime version assertion under pnpm.
  It changes no manifest, lockfile or runtime code. Source review found no blocker.

The qualification checkout is detached and separate from both active branches.
See [source hashes and checks](evidence/reconciliation-2026-09-19/combined-candidate-checks.json)
and [takeover record](takeover-reconciliation-2026-09-19.md).

## Evidence and limits

Combined build, recursive typecheck and all 28 focused route/PostgreSQL tests pass.
Fresh migration and upgrade from upstream 0282 each produce 285 journal entries
and all four Universe tables; rerunning migration applies nothing extra.

The first full Linux run passed 24,835 tests and failed eight. Seven failures
were caused by omitted Git index/executable permissions in the copied qualification
source; those suites pass after restoring the harness metadata. The remaining
failure was the unchanged upstream Playwright test; its four-test suite passes
with the reviewed test-only correction. The clean rerun is complete; see final results below.

These checks qualify code and migrations. They do not claim production-entry
or user acceptance for E1.2; those remain explicit joins with their owning route
and renderer packages in the execution sequence.

## Proposed adoption after qualification and user decision

1. Verify active Universe source still matches the reviewed current-source snapshot;
   preserve any new unrelated work. Record a recoverable source checkpoint before
   integration; do not discard, reset or recreate the existing worktree.
2. Integrate exactly the proposed replatform revision into Universe, preserving
   current feature work and documentation. Resolve migration history using the
   qualified generated lineage; carry the isolated test correction explicitly.
3. Verify the resulting source against the qualified candidate, run applicable
   integration checks for any difference, and record the actual adopted commit.
4. Leave the ongoing replatform branch untouched. Any upstream submission of the
   test-only correction is a separate coordination action.
5. Continue the next ready approved V1 package; do not label whole E1.2 accepted
   until its retained actual-entry and experience acceptance checks pass.

The existing execution sequence states: “adopting a different upstream source ...
requires the appropriate user decision.” This proposal makes that decision concrete;
preparing or qualifying it does not itself grant adoption.

## Earlier qualification results before fixture repair

Second full Linux run: **24,842 passed, 1 failed, 76 skipped** (675.64s).
The sole failure occurred before the security assertion: PostgreSQL reported IPv4
port 58592 already in use, then the fixture received ECONNREFUSED. Its port probe
is released before initialization, leaving a binding race; the colliding process
is unidentified. No assertion or shared helper was changed. The unchanged full
security manifest suite subsequently passed **19/19** (79.07s). This is not an
all-green full run. Build, typecheck, 28 focused tests and migration proofs passed.
Base adoption and production-entry/UAT acceptance remain outstanding.

## Approved continuation

On 2026-09-19 the user approved repairing the isolated fixture, qualifying it,
and adopting exact replatform `75350f1` only if required checks pass.
The pending decision is resolved; qualification remains a gate.

The fixture recognizes confirmed partial IPv4 bind collisions before migration,
stops that ephemeral cluster and retries at most three times. Migration and
assertion failures remain failures. Unit regression RED/GREEN and a real
occupied-socket test prove this behavior; read-only review found no blocker.
The final full qualification is running. Active source is preserved in checkpoint
`dd60d42b7`; the ongoing replatform branch remains untouched.

## Adopted qualified base — latest result

The user-approved replatform revision `75350f1f634aec9b679d715aeefeb45287aa36e7`
is now adopted locally by merge `7bcf81596ebf59c30dbb417aca411e84b6925de2`.
The prior Universe work is preserved in checkpoint `dd60d42b7` and its history.
The active source matches all 6,759 normalized candidate application/configuration
files, with no extra source files. The migration conflicts were exactly the three
rehearsed metadata conflicts; generated Universe 0283/0284 follow upstream 0281/0282.

Final combined qualification: **24,847 passed, zero failed, 76 skipped**, 2,643
passing test files and ten skipped files, 700.05 seconds. Recursive typecheck and
full build passed. Frozen dependency installation on the adopted Windows checkout
passed. All **five persistence browser fixture journeys passed again** there.
Earlier failed runs above remain historical evidence, not the current result.
Fresh/upgrade/repeated migration proofs remain applicable: migration bytes did not
change after those proofs. A real occupied-port regression and bounded unit tests
verify the fixture repair; the source review found no blocker.

This clears the base qualification/adoption gate, not whole E1.2 acceptance.
Production-entry integration and user acceptance remain outstanding; controlled
browser transport is not a substitute. The remote replatform branch advanced to
`77f4bf9` during qualification; it was deliberately not adopted or modified.
These commits are local; no deployment or remote push occurred in this step.
