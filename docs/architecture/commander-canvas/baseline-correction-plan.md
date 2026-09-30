# Universe baseline correction implementation plan

> Execution skill after approval: use `superpowers:executing-plans` task by task. This document is a planning deliverable, not authorization to implement it.

**Goal:** Remove the three diagnosed baseline qualification blockers without changing Universe features, weakening security checks or hiding failed tests.

**Architecture:** Correct two test/environment assumptions and one existing route's launch-error handling. Author the small source correction separately from the Universe documentation branch, qualify its exact commit offline with real Git metadata, and present base adoption as a later explicit action.

**Tech stack:** Existing TypeScript, Express 5, Vitest, Supertest, Node 24.21.0, Corepack 0.36.0 and pnpm 9.15.4. No added dependencies.

**Spec:** [Observed retry results](baseline-retry-results.md), [F1/F2/F3 diagnosis](baseline-retry-findings.md), [bounded preparation constraints](bounded-engineering-preparation.md), [planning reset](planning-reset.md). Prepared September 12, 2026 after TK authorized this corrective planning and review; source execution remains unapproved.

**Execution update:** TK subsequently approved this batch. [Execution results](baseline-correction-results.md) supersede the pre-execution status below: Tasks 1–3 completed, Task 4 ran but failed on two different fixture issues and did not reach build; Task 5 adoption remains gated. The proposed correction is local only. No further fix or retry is authorized by that run.

## Global constraints

- Keep Universe source pinned at `183e46a9c65fc3105c7e3d125629276814df7dbb` during planning. Its documentation branch remains `codex/universe-interface`. The main project checkout is a different checkout; it is not the target for these edits.
- Proposed correction source base: the exact tested replatform candidate `9200a66c42633019349de937a8b97979acac0f7a`. Both revisions have the same diagnosed failures; the candidate's nine new admission-audit tests passed. This recommendation does not adopt that candidate into Universe.
- Proposed isolated author branch: `codex/universe-baseline-corrections`, in `.worktrees/universe-baseline-corrections` under the main repository. Read-only checks found both names unused at drafting. Recheck before a future creation; do not overwrite an existing branch/worktree. No such branch/worktree is created by this plan.
- Codex authors implementation/evidence only after explicit scope approval; TK owns acceptance; TK-managed Claude independently reviews material technical plans/changes. Those roles are already assigned. Record the named replatform landing owner and review path before landing or source-base adoption; this is not a prerequisite to the separately approved isolated authoring/qualification batch. Do not assign another replatform maintainer by assumption.
- No schema/migrations, shared domain contracts, permissions, dependency/lockfile updates, provider sessions, paid compute, GUI installation, production data or premature-draft reuse. Preserve the existing instance-admin gate and path-boundary checks. Do not rename APIs or change the UI naming map.
- No unrequested changes to production DNS resolution, connector environment scrubbing or the adversarial test assertions. No skip, exclusion, network enablement or fabricated Git result may turn the failing cases green.
- All code below is proposed and has not been compiled or executed. Runtime proof belongs to the future approved batch; the current author review is source-based.

## File and interface map

| File / resource | Change and authority |
|---|---|
| `server/src/__tests__/outbound-url-guard.test.ts` | Mock only this test module's DNS import; keep real guard code and real local HTTP tests. Add deterministic public/private resolution assertions. |
| `server/src/routes/filesystem.ts` | Change only the existing `/filesystem/reveal` launch block: wait for launch success/error, handle synchronous and asynchronous failures, preserve successful response shape. |
| `server/src/__tests__/filesystem-routes.test.ts` | Controlled child-process mock, exact success/failure assertions and pre-launch permission/path checks. No real desktop launch. |
| Disposable Linux Git checkout / evidence directory | Include real exact-commit Git metadata so the existing `git grep` assertions work. Preserve source identity, commands, counts, skips and error evidence. No environment script needs to be added to product source. |
| This directory's results/status records | Record approved scope, actual corrected commit, evidence and adoption disposition after execution. No passing result may be prefilled. |

The production function remains `filesystemRoutes(): Router`. The endpoint remains `POST /api/filesystem/reveal`, with body `{ path: string }`. Success remains HTTP 200 `{ ok: true }`, meaning the opener process **launched**, not that a user saw a window or the opener later completed successfully. Failed launch becomes HTTP 500 `{ error: "Unable to launch the file manager" }`. Existing malformed/forbidden/outside-home/missing-path responses remain 400/403/400/404 and must not spawn a process.

## Task 1 — qualification checkout with Git identity (F2)

**Consumes:** approved exact source revision and later the author branch's correction commit. **Produces:** a non-root, offline Linux checkout with valid `.git`, identical tracked bytes and recorded commit identity. No source change is necessary for F2.

- [ ] After scope approval, create the proposed isolated author worktree from the exact candidate, not the root checkout's current main and not a moving remote branch. Record its merge-base and clean starting diff. Stop on name collision or unexpected base.
- [ ] Export the approved branch's reachable Git objects to a task-owned bundle, copy the bundle into the disposable environment and clone from that file. Do not mount the host repository, home, SSH agent or Docker socket. Do not manufacture a new commit merely to fool `git grep`.
- [ ] Resolve the input SHA from the approved author branch after each candidate commit, store it in the run manifest, and compare the clone's `git rev-parse HEAD` to that exact recorded value. The eventual correction SHA is an output of authoring, not a guessed value in this plan.

The author worktree initially points to the already committed candidate `9200a66c42633019349de937a8b97979acac0f7a`; no correction commit is needed to establish the first Git-backed checkout. Before each export, verify the author worktree's branch and HEAD. Export its reachable objects directly to a newly created task-owned report directory under the host temporary directory, using the basename `baseline-correction.bundle`. Record that directory's absolute path and the resolved HEAD in the manifest; never place the bundle in tracked source. Copy it into the stopped/disconnected task container as `/tmp/baseline-correction.bundle` without mounting the host repository. Do not upload the bundle as public evidence.

The initial Linux checkout sequence, after that export and copy, is:

```sh
git clone --no-checkout /tmp/baseline-correction.bundle /workspace/corrected
git -C /workspace/corrected checkout --detach refs/remotes/origin/codex/universe-baseline-corrections
git -C /workspace/corrected rev-parse HEAD
git -C /workspace/corrected status --porcelain
git -C /workspace/corrected grep -l -e buildConnectorProcessEnv -e mergeConnectorEnv -- '*.ts'
```

Check for an existing `/workspace/corrected` before cloning; stop rather than overwriting it. The initial HEAD must equal the candidate above and status must be clean. The caller result must include `server/src/services/internal-agent/cli-mode.ts`. Git metadata's existence does not substitute for the unchanged caller assertions below.

For each subsequent red/green stage, export a **cumulative binary Git diff against the same candidate** from the isolated author worktree, restricted to the three allowlisted files. Save it as a separate named artifact (`dns-fixture.patch`, `opener-red.patch`, `opener-green.patch`) with SHA-256, author HEAD and changed-path list. Capture uncommitted changes before any commit; after committing, the same base-to-worktree diff must still contain those changes. Copy the patch to the container. In `/workspace/corrected`, verify that current modifications are exactly the previously applied task patch, restore only the three allowlisted paths from the candidate, then `git apply --check` and apply the new cumulative patch. Stop on unexpected changes or patch failure. Record Git HEAD plus patch hash and the post-application tracked-file manifest for each targeted run. Never describe these intermediate patched runs as clean-commit qualification. Do not use a whole-tree reset or clean operation. Final qualification uses a fresh committed clone in Task 4.

- [ ] Reuse the same immutable image `node@sha256:b977d0f785d96029d8d4c0790b6bf1c2a4c72e0f26319808e7ba2e9d966a1ac3` and task-owned package cache. Keep UID/GID 1000, the existing home-local pnpm shim, fresh `AOA_HOME=/workspace/home/aoa-corrected`, and disconnected network. Supply no provider/DB credentials. Verify Node and pnpm versions again.
- [ ] In `/workspace/corrected`, install with `corepack pnpm install --offline --frozen-lockfile`. This is a new, explicitly proposed setup command. Missing cached packages or lifecycle-download failures stop setup; they do not authorize downloads, dependency changes or another environment workaround.
- [ ] Run the five prebuilds listed in Task 4 before targeted tests. Establish F2 with the unchanged adversarial test in the new Git checkout:

```sh
corepack pnpm exec vitest run --project=@armyofagents/server server/src/__tests__/mcp-connector-install-adversarial.test.ts -t ESC-7
```

Expected: the two ESC-7 assertions pass, with actual caller discovery. Any other selected count, Git error, assertion failure or unhandled error needs attribution. No synthetic success output or modified adversarial assertion is accepted. Record prior archive failures as the negative evidence and this exact-checkout run as the correction evidence.

## Task 2 — deterministic credential-stripping test (F1)

**Consumes:** the real `validateAndResolveFetchUrl(urlString: string): Promise<ValidatedFetchTarget>` and its imported `node:dns/promises.lookup(hostname, { all: true })`. **Produces:** offline test evidence for credential stripping and resolution guard behavior. Production guard code is unchanged.

- [ ] In `outbound-url-guard.test.ts`, add `beforeEach` and `vi` imports. Partially mock the DNS module, retaining its other exports. The default lookup rejects unexpected use; no test silently falls through to public DNS.

```ts
const dnsMock = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: dnsMock.lookup };
});
beforeEach(() => {
  dnsMock.lookup.mockReset();
  dnsMock.lookup.mockRejectedValue(new Error("Unexpected DNS lookup in unit test"));
});
```

- [ ] In the existing credential-stripping case, set this one lookup result before its existing call. Keep all existing username/password/hostname/path/query/Host assertions, and add the resolver/pinned-target assertions:

```ts
dnsMock.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
const target = await validateAndResolveFetchUrl("https://user:pass@example.com/path?q=1");
expect(target.parsedUrl.username).toBe("");
expect(target.parsedUrl.password).toBe("");
expect(target.parsedUrl.hostname).toBe("example.com");
expect(target.parsedUrl.pathname).toBe("/path");
expect(target.parsedUrl.search).toBe("?q=1");
expect(target.hostHeader).toBe("example.com");
expect(target.resolvedAddress).toBe("8.8.8.8");
expect(target.tlsServername).toBe("example.com");
expect(dnsMock.lookup).toHaveBeenCalledWith("example.com", { all: true });
```

This resolves a fixture value only; no connection to that IP is made. Replace the existing case body rather than adding a duplicate that leaves the failing original intact.

- [ ] Add a resolved-private-address case and a resolver-failure case to prove the mock did not bypass the guard:

```ts
it("rejects an all-private DNS answer", async () => {
  dnsMock.lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
  await expect(validateAndResolveFetchUrl("https://example.com/"))
    .rejects.toThrow(/All resolved IPs/);
});
it("surfaces DNS failure without using an unvalidated target", async () => {
  dnsMock.lookup.mockRejectedValueOnce(new Error("fixture resolver failure"));
  await expect(validateAndResolveFetchUrl("https://example.com/"))
    .rejects.toThrow(/DNS resolution failed/);
});
```

- [ ] Run the whole file offline. The first retry's captured failure is the original negative evidence; this is a test-fixture correction, so do not claim the added mock exposes a production bug or invent a new red result.

```sh
corepack pnpm exec vitest run --project=@armyofagents/server server/src/__tests__/outbound-url-guard.test.ts
```

Expected: the original credential-stripping assertion and new deterministic cases pass; literal-address, protocol, local HTTP body and credential-forwarding cases still run. No external DNS, narrowed test selection, manual skip or production DNS change. Record the test-only commit separately for review.

## Task 3 — handle file-manager launch errors (F3)

**Consumes:** existing instance-admin and path checks, Node child-process `spawn`/`error` events. **Produces:** launch acknowledgment on success, generic failure on launch error, and no unhandled child error. Keep the router signature, endpoint and success response unchanged.

- [ ] In `filesystem-routes.test.ts`, partially mock `node:child_process` so only `spawn` is replaced. Preserve `execFile` for existing Git probes. Add `EventEmitter` from `node:events`, `randomUUID` from `node:crypto`, and `beforeEach`, `vi` from `vitest` and a controlled fake child with `unref = vi.fn()`. Default it to emit `spawn` on a microtask so the existing home-directory case cannot launch a real desktop utility.

```ts
const processMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: processMock.spawn };
});
class FakeChild extends EventEmitter {
  unref = vi.fn();
}
let child: FakeChild;
beforeEach(() => {
  child = new FakeChild();
  // Keeps the red test contained. Assertions below must prove that the route
  // also registers its own handler; this observer must not hide a missing fix.
  child.on("error", () => {});
  processMock.spawn.mockReset();
  processMock.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
});
```

- [ ] Replace the loose home-directory assertion with exact 200/body, one spawn and one unref assertions. Add a regression expecting HTTP 500 for asynchronous launch failure and another for synchronous throw. Run these against the unchanged route first; the asynchronous case must fail its HTTP assertion instead of killing the test process. Save the failing command, exact source/patch identity and test output before implementing the route fix.

```ts
it("reports asynchronous opener launch failure", async () => {
  processMock.spawn.mockImplementation(() => {
    queueMicrotask(() => child.emit("error", new Error("fixture missing opener")));
    return child;
  });
  const res = await request(makeApp(instanceAdmin))
    .post("/api/filesystem/reveal").send({ path: os.homedir() });
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ error: "Unable to launch the file manager" });
  expect(processMock.spawn).toHaveBeenCalledTimes(1);
  expect(child.unref).not.toHaveBeenCalled();
  expect(child.listenerCount("error")).toBeGreaterThan(1);
});
it("reports a synchronous opener launch failure", async () => {
  processMock.spawn.mockImplementation(() => { throw new Error("fixture spawn failure"); });
  const res = await request(makeApp(instanceAdmin))
    .post("/api/filesystem/reveal").send({ path: os.homedir() });
  expect(res.status).toBe(500);
  expect(res.body).toEqual({ error: "Unable to launch the file manager" });
});
```

- [ ] Replace only the existing spawn/unref/immediate-response block with the following proposed implementation. Preserve the platform command selection and every guard above it.

```ts
const launched = await new Promise<boolean>((resolve) => {
  let settled = false;
  try {
    const child = spawn(cmd, [target], { detached: true, stdio: "ignore" });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(true);
    });
  } catch {
    settled = true;
    resolve(false);
  }
});
if (!launched) {
  res.status(500).json({ error: "Unable to launch the file manager" });
  return;
}
res.json({ ok: true });
```

The initial launch contract is Node’s `spawn` event on successful launch or `error` on failed launch; this is not a lifetime guarantee of exactly one event or a wall-clock deadline. Later child-process errors remain possible ([Node documentation](https://nodejs.org/api/child_process.html#event-error)). The error listener stays attached so a later error cannot become an uncaught exception. A late event cannot send a second HTTP response or imply automatic retry. Do not wait for a desktop process to exit: it may be intentionally long-lived. The acknowledgment is limited to process launch, with no claim about later GUI success.

- [ ] Complete regression coverage in the same file: success returns exact 200/body and one unref; asynchronous and synchronous failures return exact generic 500; after success, emit two errors and assert the route's error listener remains beyond the test observer and no exception is thrown; unauthorized and outside-home requests call no spawn; a unique nonexistent child path beneath the disposable HOME returns 404 and calls no spawn. Keep the sibling-prefix denial test.

```ts
it("keeps an error handler after successful launch", async () => {
  const res = await request(makeApp(instanceAdmin))
    .post("/api/filesystem/reveal").send({ path: os.homedir() });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ ok: true });
  expect(child.unref).toHaveBeenCalledTimes(1);
  expect(child.listenerCount("error")).toBeGreaterThan(1);
  expect(() => {
    child.emit("error", new Error("fixture late error"));
    child.emit("error", new Error("fixture second late error"));
  }).not.toThrow();
});
```

- [ ] Add `expect(processMock.spawn).not.toHaveBeenCalled()` to the existing non-admin reveal, outside-home reveal and sibling-prefix reveal cases. Replace the existing home-success case as described above; also assert the preserved platform command and options:

```ts
expect(processMock.spawn).toHaveBeenCalledWith(
  process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open",
  [os.homedir()],
  { detached: true, stdio: "ignore" },
);
```

Add the two pre-launch validation regressions without creating the nonexistent path:

```ts
it("rejects a missing reveal path without spawning", async () => {
  const res = await request(makeApp(instanceAdmin))
    .post("/api/filesystem/reveal").send({});
  expect(res.status).toBe(400);
  expect(processMock.spawn).not.toHaveBeenCalled();
});
it("returns 404 for an absent in-home path without spawning", async () => {
  const missingPath = path.join(os.homedir(), `aoa-reveal-missing-${randomUUID()}`);
  const res = await request(makeApp(instanceAdmin))
    .post("/api/filesystem/reveal").send({ path: missingPath });
  expect(res.status).toBe(404);
  expect(processMock.spawn).not.toHaveBeenCalled();
});
```

- [ ] Run the full route test file, require no unhandled errors, then rerun all three affected test files together. Record the route/test correction separately from the DNS fixture change. No real desktop utility is invoked by these tests.

```sh
corepack pnpm exec vitest run --project=@armyofagents/server server/src/__tests__/filesystem-routes.test.ts
corepack pnpm exec vitest run --project=@armyofagents/server server/src/__tests__/filesystem-routes.test.ts server/src/__tests__/outbound-url-guard.test.ts server/src/__tests__/mcp-connector-install-adversarial.test.ts
```

## Task 4 — final corrected-source qualification

**Consumes:** the correction commit containing exactly the three source/test files above, plus the reviewed environment. **Produces:** an attributed baseline report for that actual commit, not for the unmodified candidate.

- [ ] Review the net diff against the pinned candidate. Only the named route and two test files may change outside documentation. Source authoring/red-green tests use the Task 1 recorded base plus cumulative patch hash, but final qualification must run a clean exact commit. Commit the reviewed corrections, export a new branch bundle named `baseline-correction-final.bundle`, and copy it as `/tmp/baseline-correction-final.bundle`. Clone it into the unused `/workspace/qualified` directory, detach at its exported correction branch and compare HEAD to the host-recorded correction SHA. Stop on path collision or a dirty/different checkout. This fresh directory avoids the patched targeted-test checkout and its generated state. Reuse only the offline package cache and environment conventions; use a fresh `AOA_HOME=/workspace/home/aoa-qualified`. Record clean Git status and tracked-file hashes before final checks.
- [ ] Keep the original two-revision evidence. Do not repeat both unchanged full suites just to reproduce already attributed failures. Qualify the corrected candidate once; compare unchanged cases, new tests, skipped-file inventory and failure identities with the recorded runs. Any unexpected diff or new failure blocks readiness.
- [ ] In `/workspace/qualified`, the fresh offline exact-commit checkout, execute:

```sh
node --version
corepack pnpm --version
corepack pnpm install --offline --frozen-lockfile
corepack pnpm --filter @armyofagents/worker-protocol build
corepack pnpm --filter @armyofagents/sandbox-fake-provider build
corepack pnpm --filter @armyofagents/worker-daemon build
corepack pnpm --filter @armyofagents/sandbox-provider-contract build
corepack pnpm --filter @armyofagents/sandbox-e2b-provider build
corepack pnpm -r typecheck
corepack pnpm exec vitest run --shard=1/4
corepack pnpm exec vitest run --shard=2/4
corepack pnpm exec vitest run --shard=3/4
corepack pnpm exec vitest run --shard=4/4
corepack pnpm build
```

- [ ] Setup bound: 15 minutes. Targeted red/green qualification: 30 minutes total. Final full sequence: 150 minutes. One intended red run and one green run per affected correction, one combined targeted run, and one final full sequence are proposed; no open-ended retries. An unrelated failure permits diagnosis/reporting only. Failed setup/prebuild/typecheck blocks dependent work; if test shards are reached, retain all four outcomes, and any failure or unhandled error blocks build.
- [ ] Allow only the suite's own temporary DB/loopback fixtures, as observed in the prior run; no separate migration rehearsal, live DB, provider trial, Docker socket or real desktop launch. Skipped/provider/browser/role obligations remain explicitly unproved. Do not enable networking to make build or tests pass.
- [ ] Record exact commit and image, source bytes/links before and after, command ledger, exit/timeout, test counts, skipped files, all unhandled errors, targeted red/green evidence and final build output. Success requires all intended assertions and build passing with zero unhandled errors; explain all remaining skips without upgrading them to passes.
- [ ] Stop the disposable runtime after preserving logs. Publish source correction and evidence only to its explicitly approved review destination. Do not merge into replatform, main or Universe as part of qualification.

## Task 5 — reviewed adoption proposal and implementation boundary

- [ ] Codex self-reviews source diff, mock fidelity, no guard weakening, logs/counts, scope and runtime integrity. TK-managed Claude reviews the material plan/source/evidence; verify findings before accepting or rejecting them.
- [ ] If the corrected source is qualified, present TK the exact correction commit, its parent candidate, net diff, known skips, branch topology and proposed merge order. Prefer landing the inherited fix through the replatform review path, then adopt that exact accepted descendant into Universe. Do not silently choose current main or a newer moving upstream head.
- [ ] If upstream advances or takes an equivalent fix first, inspect that exact change and its evidence. Update the proposal and identify which checks need repeating; do not duplicate the fix or assume the earlier green run covers new source.
- [ ] Obtain separate approval for the concrete base integration. Preserve the Universe planning documents and excluded premature draft. On integration, verify the resulting ancestry and source diff; a docs-only current branch is not permission to integrate code.
- [ ] Only then present the separate E1.1 implementation batch with remaining DESIGN/React Flow/host obligations. This correction plan neither implements Universe nor closes those gates. No V1 scope or accepted UX/privacy decision changes.

## Author self-review and current disposition

Coverage: F1 maps to Task 2; F2 to Task 1; F3 to Task 3; exact-commit verification and full build to Task 4; source-base adoption and implementation approval to Task 5. The source pins and original failed evidence are retained. The proposed branch/path were checked for collisions, and the three source/test paths and API signatures were read at the Universe source pin; their relevant contents are unchanged in the tested candidate.

Review corrections made while drafting: DNS mock uses the actual `{ all: true }` signature and does not contact the fixture IP; Git identity comes from real branch objects rather than a fabricated commit; opener errors after success retain a listener; the red test uses an explicit protective observer and checks for the route's additional listener so it cannot conceal the missing fix; source authoring, qualification and base adoption are separate scopes. Full-suite comparison uses test identity because shard allocation changed with the added replatform test file. The self-review also removed the bootstrap dependency on a not-yet-created correction commit, separated patched targeted runs from the clean final checkout, made patch transfer and path-collision behavior explicit, and added exact pre-launch denial/missing-path assertions.

**Not yet performed:** source edits, branch creation, bundle/checkout setup, targeted regressions, another full suite/build, base integration or E1.1 implementation. The code sketches are uncompiled proposals. Current deliverable: source-checked plan with [Claude review received and author-verified](baseline-correction-review-report.md), ready for explicit bounded execution-scope approval. The ownership and event-lifecycle clarifications do not change the proposed code or test scope. No new unchanged review round is required.

## Approved correction execution outcome

TK explicitly approved the isolated correction batch after the reviewed plan. [Results](baseline-correction-results.md) record local correction commit `b5cc42643223c433a8263564c7142761472a13d9`, passing typecheck and all 247 targeted cases, plus all four full shards. F1/F2/F3 are corrected in that isolated tree; full qualification remains failed due to a confirmed blocked-task fixture port collision and a separate backup setup timeout. Totals: 24,242 passed, 4 failed, 78 skipped; two failed suites, no unhandled-error summary. Build was blocked. No additional fixes/retries followed.

The runtime is stopped. Correction commits are local only; Universe remains on its original replatform pin. Prior “execution approval pending” statements describe the pre-approval stage and are superseded for this bounded batch only. New fixture corrections, source publication, base integration and Universe implementation remain separate decisions. See the report’s next-decision section.
