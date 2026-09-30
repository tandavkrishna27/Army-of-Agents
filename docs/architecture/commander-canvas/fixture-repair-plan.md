# Database fixture investigation and repair plan

**Latest readiness (September 13):** [Base integration and adoption](base-integration-results.md) are complete with full local qualification, required PR CI and exact source comparison. The existing Universe branch now contains the verified replatform landing. TK's requested discussion and explicit batch approval remain before feature implementation. Earlier dated preparation results below are historical.

**Historical local qualification (September 13):** The [F5 repair and full baseline verification](f5-repair-results.md) passed at local source `fcab5a112`: repository typecheck, all four test shards (24,276 passed, 76 unchanged ordinary skips) and build. An interrupted shard-3 attempt is preserved separately and excluded from totals. No source drift or new skipped cases. Correction publication/landing, exact Universe base adoption and feature implementation remain unapproved. The remote replatform delta requires its own integration checks; no general epic replanning. Older dated records below are historical.

**Historical F4 checkpoint:** TK chose Codex review for this round and authorized proceeding with the bounded F4 repair. [Author review and F4 results](f4-repair-results.md): 12 lifecycle tests, strict test-file typecheck and 11 real integration cases passed; the original typecheck configuration failure is retained. Repair commit stays local. The [Universe readiness register](consolidated-plan-readiness.md) is current; no further unchanged Claude review is required. Next is separately approved full clean-commit baseline qualification, then base adoption and explicit Universe coding approval. Older dated records below are historical.

> **For agentic workers:** Use `superpowers:executing-plans` after explicit approval of the named stage. Steps use checkboxes for work not yet executed.

**Current status:** TK approved Stage A after independent review. [Diagnostic results](fixture-diagnostic-results.md) record both completed invocations: backup passed twice, but seven unrelated suites failed collection due to an omitted SDK build, limiting the workload comparison. The runtime is stopped. The source repair and full qualification stages remain unapproved. The unchecked steps below preserve the reviewed proposal; actual execution evidence is in the results record.

**Goal:** resolve F4/F5 without hiding failing assertions, weakening baseline qualification or guessing why backup setup timed out.

**Architecture:** first collect the missing backup-stage evidence in an isolated diagnostic checkout. The blocked-task failure already has a concrete source-level explanation and a narrow proposed correction. Review a combined repair diff after the diagnostic evidence establishes the backup change; only a subsequently approved clean-commit qualification can close BASE.

**Tech stack:** existing Vitest, embedded-postgres 18.1.0-beta.16 with the checked-in patch, postgres-js and Drizzle. No dependency or schema changes.

**Spec:** [baseline correction results](baseline-correction-results.md), especially F4/F5 and the next-decision boundary. [Original execution protocol](baseline-correction-plan.md) supplies the offline image, environment and transfer requirements; the stage-specific limits below replace its earlier run allowance.

## Scope and ownership

- Existing local correction source: `b5cc42643223c433a8263564c7142761472a13d9`, descended from tested replatform candidate `9200a66c42633019349de937a8b97979acac0f7a`. Do not use current main or a moving replatform head.
- Universe planning branch remains `codex/universe-interface`, application pin `183e46a9c65fc3105c7e3d125629276814df7dbb`. Earlier correction commits and the premature Universe draft remain untouched.
- Codex writes the plan, diagnostic evidence and eventual proposed repair; TK owns acceptance and supplies Claude's independent review. Replatform landing, remote source publication, base adoption and Universe implementation remain distinct later approvals.
- The current user request authorizes preparing/reviewing this plan and publishing documentation. Stage A below is proposed for approval, not already authorized by planning approval. Stage B source repair and Stage C full qualification are not bundled into Stage A.
- Preserve all four blocked-task assertions, both backup/restore assertions and existing platform skips. No new skip, retry-until-green, global timeout/worker change, package patch, lockfile or production-service change.

## Evidence and source trace

| Finding | Established | Still unproved |
|---|---|---|
| F4 port allocation | The blocked-task fixture chooses a random port without probing. Published logs show its PostgreSQL colliding with the runtime-provider-key fixture on 58293. | Adoption of a probe does not eliminate the subsequent bind race. |
| F4 lost setup error | The installed library's `start()` rejects with no value on child `close`; the fixture assigns that value to `setupError` and later checks its truthiness. `undefined` therefore permits access to an unset `db`. | The complete proposed correction and fault regressions have not run. |
| F4 cleanup hang | The installed library's `stop()` attaches a new `exit` listener even when the stored child has already exited. A failed start can leave that child stored; the observed teardown timeout is consistent with this exact path. | Other partial-start/stop failure paths must still fail visibly in qualification. |
| F5 setup | Backup `beforeAll` has no explicit timeout. The DB project has no hook override; the observed effective limit was 10,000 ms. Setup includes initdb, startup, database creation and seeding. | Which await exceeded the budget, whether it completed later, and whether load or a lifecycle defect caused it. |

Source read at the exact local correction commit:

- `server/src/__tests__/blocked-task-scan.integration.test.ts`: `PORT`, setup catch, `beforeEach`, `afterAll`.
- `packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts`: `allocatePort`, setup, `pgStarted` and teardown.
- `server/src/__tests__/helpers/embedded-pg-port.ts`: `allocateEmbeddedPgPort(preferred?): Promise<number>`, IPv4 availability probe with an acknowledged close-to-bind race.
- `server/src/__tests__/helpers/migrated-database.ts` and `runtime-provider-keys-with-secret.integration.test.ts`: existing port-helper usage. Do not import the migrated helper into the backup package or provision unrelated roles/databases merely to reuse it.
- `packages/db/src/client.ts`: `createDb(url)` returns a Drizzle handle with its postgres-js `$client`; existing integration fixtures close it via `$client.end()`.
- `vitest.config.ts`, `server/vitest.config.ts`, `packages/db/vitest.config.ts`: retain project configuration. Root timeout text is not evidence that the DB project inherited it; the actual failed hook reports 10 seconds.

The dependency implementation was copied read-only from the **stopped qualified container**, `/workspace/qualified/server/node_modules/embedded-postgres/dist/index.js`. SHA-256: `8a6395fcd8e552ee0f10f6abb5dace877946625666f6daf4bc31152856bd8736`. Host-installed text agrees after newline normalization; its raw hash differs. This is installed-source inspection, not a fresh reproduction. The checked-in package patch changes locale/environment inheritance, not the early-close rejection or stop listener. [Static evidence record](fixture-static-evidence.json) retains file/line/hash attribution. No dependency implementation is modified by this proposal.

## Stage A — bounded backup diagnostics, then stop

**Deliverable:** stage timings for the failing backup setup, under isolated and existing shard load, and an evidence-based repair disposition. This stage makes no production or committed fixture repair.

**Files:** diagnostic patch only to `packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts`. Temporary runner/patch/bundle/logs live outside tracked source. Published results go under this documentation directory. No changes to F4 or any other test in this stage.

**Interfaces:** consumes exact correction SHA plus a hashed diagnostic patch; produces named stage start/end/error records, PostgreSQL logs, exit/count/skip data and process cleanup evidence. No application API changes.

- [ ] Verify local correction branch HEAD equals the recorded SHA and is clean. Create a fresh task-owned diagnostic directory; export actual Git objects from that branch to a local bundle. Clone inside the offline runtime into a new `/workspace/fixture-diagnostics` directory, detached at the exact SHA. Stop if the directory already exists or identity differs; do not overwrite retained evidence.
- [ ] Verify the same image digest, UID/GID 1000, disconnected network, one task volume, allowlisted environment and no host repository/home/socket mounts from the original protocol. Use fresh `AOA_HOME=/workspace/home/aoa-fixture-diagnostics`. Do not start the runtime until this stage is approved.
- [ ] Run one offline frozen install and the same five prebuilds. Setup budget: 15 minutes; stop on missing cache or failure. No download, dependency repair or alternate image.
- [ ] Add the following diagnostic helper within the backup test file. This measures original awaits; it does not change their resolution, rejection or hook timeout:

```ts
async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const emit = (event: string) => console.info(JSON.stringify({
    fixture: "backup-non-system", stage: name, event,
    elapsedMs: Math.round(performance.now() - started),
    pid: process.pid, utc: new Date().toISOString(),
  }));
  emit("start");
  try {
    const result = await run();
    emit("end");
    return result;
  } catch (error) {
    emit("error");
    throw error;
  }
}
```

- [ ] Wrap the existing awaits without reordering them: `data-dir`, `backup-dir`, `port`, `initialise`, `start`, `create-database`, each of the five existing seed SQL calls (`schema`, `journal-table`, `journal-row`, `users-table`, `users-row`), `seed-client-end`, and teardown `stop`. For example `await stage("initialise", () => pg.initialise())`. Use `async () => await sql\`...\`` around postgres-js thenables to satisfy `Promise<T>`. Keep `pgStarted = true` in its existing position after successful start. Preserve default PostgreSQL output. Never log connection strings, credentials or environment dumps.
- [ ] Export a cumulative binary patch against the exact correction SHA, record SHA-256 and changed-path allowlist, and apply/check it in the clone. Record HEAD **and patch hash**, plus full tracked-file hashes. These are instrumented runs, not clean-commit acceptance evidence.
- [ ] Run these two commands once each, from that checkout, with the unchanged project timeouts, concurrency, test assertions and skip rules:

```sh
corepack pnpm exec vitest run --project=@armyofagents/db packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts
corepack pnpm exec vitest run --shard=4/4
```

The second command recreates the existing shard load; it is a diagnostic contrast, not a retry to obtain a green score. Confirm the backup file is selected in both outputs. Keep every other shard-4 outcome, including any unrelated failures. At this unchanged file inventory the existing shard assignment is expected; a missing target stops interpretation rather than silently changing filters.

- [ ] Per-command hard bound: 15 minutes; total diagnostics: 30 minutes. No hook-timeout increase or third run is included. Record current stage at timeout and preserve logs. A normal diagnostic hook timeout is evidence; a harness/process failure, changed source, missing target, or exhausted command deadline stops the stage and blocks the second command if it has not run.
- [ ] After **each** diagnostic command, preserve logs and stop the entire isolated container so a timed-out hook cannot leave late-starting PostgreSQL processes competing with the next run. A Promise timeout is not cancellation. Verify stopped state and network isolation before restarting for the second planned command. Do not delete DB directories or kill processes by port on the host. The existing volume/cache remains; tests create their own fresh temporary directories. Record any forced termination distinctly from test results.
- [ ] Hash all tracked files after each command and require equality to the pre-command instrumented manifest. Publish the commands, stage records, raw logs, counts/skips, image/source/patch identities and cleanup disposition. Leave the runtime stopped.
- [ ] Stop for repair selection. If both runs pass, record non-reproduction and the observed durations; do not declare F5 fixed. If an await does not end, name that stage without inventing a cause. If timing shows steady successful setup exceeding 10 seconds, a fixture-local budget can be proposed with measured justification, but is not changed in Stage A. If a query/startup hangs or errors, fix that lifecycle cause instead of increasing the budget. If these records are insufficient, propose a narrower next diagnostic with its exact scope rather than running it automatically.

## Stage B — proposed repair boundary, not executable yet

F4's intended production-neutral repair is confined to `server/src/__tests__/blocked-task-scan.integration.test.ts`. F5's eventual repair is confined initially to `packages/db/src/__tests__/backup-lib-non-system-schemas.test.ts`; expand that allowlist only through a separately reviewed explanation. No shared helper or dependency change is pre-approved.

### F4 proposed behavior

1. Allocate the port inside setup using the existing `allocateEmbeddedPgPort()` and connect on `127.0.0.1`. Keep migrations, seed values, company scoping and assertions unchanged. The probe reduces collision risk; startup must still fail visibly if another process wins the later bind.
2. Replace the swallowed error/truthiness protocol with a thrown Error from `beforeAll`. Use a named setup stage in the message and preserve the original cause, including `undefined`. Remove all `if (setupError)` branches so setup cannot be mistaken for success.
3. Record `pgStarted = true` only after `await pg.start()` resolves. Do not call the library's `stop()` on the already-closed failed-start child. Close the fixture-owned Drizzle client before stopping a successfully started cluster. Do not remove its temporary directory until shutdown is established; failed cleanup remains a failed test outcome and retained task data is handled inside the isolated runtime.

Proposed code shape (a review sketch, not applied or compiled):

```ts
let pgStarted = false;
let db: Db | undefined;
let setupStage = "not-started";
// within existing beforeAll, using the existing mkdtemp/import/constructor:
try {
  // Allocate with allocateEmbeddedPgPort() instead of the module-level PORT.
  setupStage = "initialise";
  await pg!.initialise();
  setupStage = "start";
  await pg!.start();
  pgStarted = true;
  // Existing migration, createDb and seeding follow, with stage names.
} catch (cause) {
  throw new Error(`blocked-task fixture failed during ${setupStage}`, { cause });
}
```

The final reviewed diff must include exact type narrowing for every `db` use and complete cleanup control flow; this sketch is not permission to implement only the happy path. Keep setup's 180-second and teardown's 60-second bounds; a shutdown hang is a failure, not a swallowed success. Do not copy the shared migrated fixture's catch-and-ignore teardown as a solution.

### Required repair regression evidence

| Case | Required result |
|---|---|
| Preferred port already occupied | Allocation avoids the occupied port while the original listener stays alive; no termination of a foreign fixture. |
| Start rejects `undefined` | Setup fails with a named Error; no seed/query calls; no `stop()` wait on the failed-start child. |
| Start rejects an Error | Original cause retained; same fail-closed setup behavior. |
| Failure after successful start | Client closure and owned-cluster shutdown attempted in order; cleanup failure retained. |
| Successful F4 real DB | All original four blocked-task assertions pass unchanged. |
| F4 with known competing fixture | Both suites run under normal file parallelism; outcomes and allocated ports recorded. One pass is not a proof of eliminating every race. |
| F5 real backup/restore | Both original journal/public-data and legacy-backup assertions run and pass; failed setup skips cannot be relabeled accepted skips. |
| F5 partial setup | No late-starting database or leaked client survives the run boundary; exact cleanup regression follows the identified failing stage. |

Choose deterministic fixture fault injection and its exact test-file scope in the Stage-A results/repair addendum before authoring the repair. Do not mutate global `Math.random`, weaken business assertions, or modify `embedded-postgres` in place. Required fault cases are separate from genuine DB qualification. The pending F5 cause makes a complete combined implementation diff unjustified today; this is an explicit evidence gate rather than an omitted coding task.

## Stage C — later clean-commit qualification and adoption

- [ ] After the repair diff, regression design, source destination and test bounds are reviewed and explicitly approved, author on an isolated descendant of `b5cc42643223c433a8263564c7142761472a13d9`. Preserve the earlier commits and record ancestry; no reset or rebase of the documentation branch.
- [ ] Run the reviewed deterministic red/green checks, the two affected real fixtures and the known competing fixture. Retain F1/F2/F3 regression coverage. No unlimited repetitions or assertion deletion.
- [ ] A separately approved final run uses a fresh Git-backed clone at the actual committed repair SHA: offline frozen install, five prebuilds, full `pnpm -r typecheck`, all four `pnpm exec vitest run --shard=N/4` partitions, then `pnpm build` only if all shards succeed without unhandled errors. Exact final commands/bounds are reconfirmed in the repair addendum; Stage A does not spend this allowance.
- [ ] Account for test identities as well as totals. The previous 78 skips include two failed-backup-setup skips; those must become executed tests, not silently persist. Other existing skips remain explicit unproved coverage. Do not compare counts without accounting for any new regression cases.
- [ ] Internal source review and TK-managed Claude review precede a proposal for replatform landing and exact Universe base adoption. Passing fixtures alone is not full baseline readiness, and a full baseline pass is not approval to implement Universe.

## Author self-review

Evidence coverage: F4 allocation, falsy rejection and stale exit-listener paths are traced to source; F5 is limited to the observed timeout. Scope coverage: Stage A names one patchable test file, two diagnostic invocations, unchanged timeout/concurrency, source identity and full runtime cleanup. Stage B preserves assertions and requires explicit failure/cleanup regressions; Stage C preserves all baseline gates.

Corrections made during review: used the installed dependency from the stopped qualified container rather than assuming the host installation was byte-identical; distinguished root config from observed DB project timeout; refused to treat a free-port probe as atomic reservation; did not import a server role-provisioning fixture into the DB backup package; preserved hook rejection instead of converting setup failure into a pass; required container shutdown between diagnostic commands because a timed-out promise can continue; separated diagnostic pass from repair/qualification acceptance. No new product decision is needed.

**Next handoff:** [focused Claude review](claude-review-handoff.md#focused-review-of-f4f5-fixture-plan). Ask whether the diagnostic stage and proposed repair boundary are sound, not whether unrun repairs are ready to merge.

## SDK follow-up disposition

TK approved the bounded SDK build/export-check/shard proposal. [Results and execution deviation](fixture-sdk-followup-results.md): SDK build passed; plain-Node import failed resolving a workspace TypeScript export. Codex then incorrectly launched the dependent shard before inspecting that failure and stopped the container on discovery. Its partial output is invalid; no final shard result or post-abort source manifest is claimed. No additional execution followed. The report proposes a TypeScript-aware loader plus a machine-enforced prerequisite gate, requiring a new bounded approval. F4/F5 repair, full qualification, source publication and base adoption remain open.

## Gated loader-aware diagnostic outcome

TK approved the corrected export check and one success-gated shard invocation. [Results](fixture-loader-check-results.md): both commands passed; shard 4 ran 6,031 passing tests with 3 existing skips, including all seven previously uncollected suites and both backup cases. Source/patch identity and all 7,664 tracked entries matched before/after; runtime stopped. The prior aborted run remains invalid historical evidence. SDK preparation/loading is now resolved for this environment; F5 did not reproduce (setup 6.233 seconds) and is not declared repaired. No additional backup-only rerun or speculative timeout change is recommended. Next is reviewing the exact F4 fixture repair and fault regressions, then separately approved source authoring/full qualification. No base adoption or Universe implementation.
