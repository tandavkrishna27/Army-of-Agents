# E2B Cloud Execution Isolation — Implementation Plan (Wave 4: wave4-files)

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` to execute this wave task-by-task. Steps use `- [ ]` checkboxes.
>
> **Spec:** `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md`. **Shared seams:** the INDEX. Execute waves 0→7; U8/guard-flip LAST.

---

## Wave 4 — File movement + workspace capture

**Goal:** make run outputs survive the VM boundary — org agents get host-clone → upload → in-VM `git diff` → pull-out → host commit/push/PR, and crew agents get their in-sandbox working dir captured to `task_outputs` (artifacts still founder-gated per Decision #67), with in-VM dev servers exposed as preview URLs, and each agent's own skill bundles staged into the VM (never the shared managed marketplace-skills root). This wave covers **U6** only, decomposed into seven tasks. It assumes Waves 1–3 have landed the U4 `acquireExecutionContext` seam (`AdapterProviderSandboxRunner`), the U2 broker, the U3 crew run-JWT, and the U5 env allowlist (`buildSandboxEnvAllowlist`, S2).

**Grounding note (read before starting):** the sandbox provider (`server/src/services/sandbox-provider-runtime.ts`) stages **nothing** in or out today — `createE2bSandboxRuntimeProvider` only `execute`s commands and its `E2bSandbox` type exposes `commands.run`, `files.write`/`files.remove`, `setTimeout`, `kill`, `pause` — **no `files.read`, no `getHost`**. The provider seam is `SandboxRuntimeProvider` (`:73`) with `acquireLease`/`releaseLease`/`execute`; `SandboxProviderAcquireInput` (`:5`) is the create/resume input and `SandboxProviderLease.metadata` (`:17`) is the lease-metadata slot. The two host-side git guards are `assertLocalWorkspaceCommandAllowed` (`local-workspace-command-guard.ts`, hardcodes `{type:"local"}` → `assertUnsandboxedMultitenantAllowed` refuses on cloud) called at `output-detection.ts:288` and `workspace-runtime.ts:528`. Crew capture is hardcoded empty: `resolveCrewRunSummaryArgs` returns `detectedFiles: []` (`crew-run-outcome.ts:107`) and `resolveCrewExecutionWorkspace` returns the shared `project_primary` checkout with `detectedFiles`/PR unsupported.

**Cross-wave seams this wave conforms to (do not invent variants):**
- **S4 — egress allowlist:** the sandbox provider create/resume path takes an optional `egressAllowlist?: string[]` recorded in **lease metadata** (best-effort on managed E2B — §11 documents managed egress is not fully lockable). **U6 introduces the param + threads it through stage-in; U11 unions connector hosts + npm into it.**
- **S5 — acquisition driver:** to decide "did this run target a provider sandbox?", read `acquisition.environment.driver === "sandbox"` (`EnvironmentAcquisitionResult extends EnvironmentRuntimeLeaseRecord`, which has `environment: Environment`; there is **no** top-level `driver` on the acquisition result — driver lives on `environment`, values `"local"|"sandbox"`, `environment-runtime.ts:456`). Mocks mirror `{ environment: { driver }, lease, … }`.

**Blocker resolved in this revision (crew capture FK):** `task_outputs.createdByRunId` **FKs `heartbeat_runs`** (`task_outputs.ts:46`) and `taskOutputService(...).upsertForIssue` **asserts** it against `heartbeatRuns` (`task-outputs.ts:123`, `assertCompanyOwnedRef(db, heartbeatRuns, input.createdByRunId, …)`). But a **crew** run id is minted into `internal_agent_runs` (`runner.ts:225`, `runId = inserted[0]?.id` off `db.insert(internalAgentRuns)…returning()`) — a *different* table. Passing a crew run id as `createdByRunId` FK-fails (and the pre-insert assertion 404s). Crew captures therefore pass **`createdByRunId: null`** (the FK is nullable and `assertCompanyOwnedRef` returns early on null, `task-outputs.ts:83`) and carry the crew run id in **`metadata.crewRunId`** plus **`createdByAgentId`** for provenance. The original U6.5 test stubbed `taskOutputService`, so it never exercised the FK/assertion and was **false-green** — U6.5 now adds a **real-PG** crew-capture integration test.

---

### Task: U6.1 — Host-orchestration git guard sink

The blocker from §5/U6: all host-side workspace git flows through `assertLocalWorkspaceCommandAllowed`, which refuses on cloud. U8 flips only the D1 *execution-target* guard, not this one. We add a **distinct** guard for AoA-authored git on a host clone (clone/diff-base/commit/push — never tenant-CLI shell) that is permitted on cloud, while keeping the tenant-command refusal intact.

**Files:**
- Modify: `server/src/services/unsandboxed-multitenant-guard.ts`
- Modify: `server/src/services/local-workspace-command-guard.ts`
- Create: `server/src/__tests__/host-orchestration-git-guard.test.ts`

1. **Write the failing test.** In the new test file, import (to-be-added) `assertHostOrchestrationGitAllowed` from `../services/local-workspace-command-guard.js` and the existing `assertLocalWorkspaceCommandAllowed`. Assert the two diverge on cloud:
   ```ts
   import { assertHostOrchestrationGitAllowed, assertLocalWorkspaceCommandAllowed } from "../services/local-workspace-command-guard.js";
   // Simulate cloud_auth by mocking tenantIsolationEnforced() → true
   // (mock ../config/deployment-mode.js like the sibling output-detection-cloud-guard.test.ts does)
   it("permits host-orchestration git on cloud but refuses tenant workspace commands", () => {
     expect(() => assertHostOrchestrationGitAllowed("org clone")).not.toThrow();
     expect(() => assertLocalWorkspaceCommandAllowed("tenant workspace Git command")).toThrow(/without genuine per-tenant isolation/);
   });
   ```
   Model the deployment-mode mock on the existing `server/src/__tests__/output-detection-cloud-guard.test.ts`.
2. **Run it — expect FAIL** (`assertHostOrchestrationGitAllowed` does not exist). `pnpm --filter @armyofagents/server test host-orchestration-git-guard`.
3. **Implement.** In `unsandboxed-multitenant-guard.ts` add an exported target sentinel + predicate carve-out:
   ```ts
   /** AoA-authored git on a host clone (clone/diff-base/commit/push). NOT a tenant CLI shell. */
   export type HostOrchestrationTarget = { type: "host_orchestration_git" };
   export function isHostOrchestrationGitTarget(t: AdapterExecutionTarget | HostOrchestrationTarget | null | undefined): boolean {
     return !!t && (t as { type?: string }).type === "host_orchestration_git";
   }
   ```
   In `requiresSandboxRefusal`, return `false` early when `isHostOrchestrationGitTarget(target)` (it is host-controlled AoA code, not tenant model output — the blast-radius reframe §9 makes this safe). In `local-workspace-command-guard.ts` add:
   ```ts
   export function assertHostOrchestrationGitAllowed(sink: string): void {
     assertUnsandboxedMultitenantAllowed(
       { type: "host_orchestration_git" } as never,
       { tenantIsolationEnforced: tenantIsolationEnforced(), sink },
     );
   }
   ```
   Leave `assertLocalWorkspaceCommandAllowed` exactly as-is (tenant-command sink stays refused).
4. **Run — expect PASS.**
5. **Commit.** `git commit -m "feat(exec-isolation): add host-orchestration git guard sink permitted on cloud (U6.1)"`

---

### Task: U6.2 — Org stage-in: host clone → upload working tree into the VM (+ S4 egress-allowlist param)

The host clones the company repo (PAT host-side, reusing `resolveGitHubAuth`/existing worktree infra), then uploads the working tree **including `.git`** into the sandbox `remoteCwd` so `git diff HEAD` works in-VM. This requires extending the sandbox provider seam with a file-write/read path, a host-resolution path, the **S4 `egressAllowlist` param**, and a new file-movement module.

**Files:**
- Modify: `server/src/services/sandbox-provider-runtime.ts` (extend `SandboxRuntimeProvider` + `E2bSandbox` type + `SandboxProviderAcquireInput` + fake provider)
- Modify: `server/src/services/environment-run-orchestrator.ts` (surface `writeFiles`/`readFiles`/`resolveHost` on `AdapterProviderSandboxRunner`; pass `egressAllowlist` at acquire)
- Create: `server/src/services/sandbox-file-movement.ts`
- Create: `server/src/__tests__/sandbox-file-movement-stagein.test.ts`
- Create: `server/src/__tests__/sandbox-egress-allowlist.test.ts`

1. **Write the failing tests.**
   - `sandbox-file-movement-stagein.test.ts`: against a `createFakeSandboxRuntimeProvider()` extended with an in-memory FS, drive the new `stageRepoIntoSandbox` and assert the working tree (incl. `.git`) lands under `remoteCwd`:
     ```ts
     import { createFakeSandboxRuntimeProvider } from "../services/sandbox-provider-runtime.js";
     import { stageRepoIntoSandbox } from "../services/sandbox-file-movement.js";
     it("uploads the host clone working tree + .git into remoteCwd", async () => {
       const runner = /* provider runner over fake sandbox, exposing writeFiles+execute */;
       await stageRepoIntoSandbox({ runner, hostClonePath: fixtureRepo, remoteCwd: "/home/user/aoa-workspace" });
       const ls = await runner.execute({ command: "sh", args: ["-c", "ls -a /home/user/aoa-workspace && test -d /home/user/aoa-workspace/.git"], cwd: null, env: {}, stdin: null, timeoutSec: 30 });
       expect(ls.exitCode).toBe(0);
     });
     ```
   - `sandbox-egress-allowlist.test.ts` (**S4**): drive `acquireLease` on the fake provider with `egressAllowlist: ["api.github.com", "registry.npmjs.org"]` and assert it is recorded verbatim in the returned `lease.metadata.egressAllowlist`; drive it with no allowlist and assert the key is absent/empty (best-effort — no throw when the provider cannot enforce it):
     ```ts
     const lease = await provider.acquireLease({ /* …base acquire input… */, egressAllowlist: ["api.github.com"] });
     expect(lease.metadata.egressAllowlist).toEqual(["api.github.com"]);
     ```
2. **Run it — expect FAIL** (module + `writeFiles`/`egressAllowlist` seam absent).
3. **Implement.**
   - In `sandbox-provider-runtime.ts`:
     - Extend `E2bSandbox.files` with `read(path): Promise<Uint8Array | string>` and add optional `getHost?(port: number): Promise<string> | string`. Add optional methods to `SandboxRuntimeProvider`:
       ```ts
       writeFiles?(input: { providerLeaseId: string; leaseMetadata: Record<string, unknown> | null; config?: Record<string, unknown> | null; files: Array<{ path: string; content: Buffer }> }): Promise<void>;
       readFiles?(input: { providerLeaseId: string; leaseMetadata: ...; config?: ...; paths: string[] }): Promise<Array<{ path: string; content: Buffer }>>;
       resolveHost?(input: { providerLeaseId: string; leaseMetadata: ...; config?: ...; port: number }): Promise<string>;
       ```
       Implement them on the E2B provider by `connect()`-ing (same reconnect pattern as `execute`) and calling `sandbox.files.write`/`sandbox.files.read`/`sandbox.getHost(port)`. Implement the fake-provider versions over an in-memory `Map<string,Buffer>` so CI exercises the full path (mirrors the `AOA_E2E_FAKE_EMBEDDER` seam, §10).
     - **S4:** add `egressAllowlist?: string[]` to `SandboxProviderAcquireInput` (`:5`). In both `acquireLease` implementations record it in the returned `SandboxProviderLease.metadata` (`metadata.egressAllowlist = input.egressAllowlist ?? []`). On the E2B provider, ALSO pass it through the `Sandbox.create` `metadata` options for managed best-effort recording; **do not throw** if managed E2B cannot enforce it (§11 — managed egress is not fully lockable; enforcement is a self-hosted concern). U11 will union connector hosts + npm into the array supplied at acquire.
   - In `environment-run-orchestrator.ts` `buildProviderRunner`: add `writeFiles`, `readFiles`, `resolveHost` to the returned `AdapterProviderSandboxRunner`, each delegating to `runtime.<method>` bound to `leaseRecord.lease`/`environment` (guard with `typeof runtime.writeFiles === "function"` like the existing `executeRunLeaseCommand` check). At the acquire call, thread an `egressAllowlist: []` placeholder into the acquire input (U11 populates it) so the field is wired end-to-end now.
   - New `sandbox-file-movement.ts`: `stageRepoIntoSandbox({ runner, hostClonePath, remoteCwd })` — tar the host clone (`tar -cf` over `hostClonePath`, wrapped in `assertHostOrchestrationGitAllowed("org stage-in tar")`), `runner.writeFiles([{ path: "/tmp/aoa-repo.tar", content: tarBuffer }])`, then `runner.execute({ command: "sh", args: ["-c", `mkdir -p ${q(remoteCwd)} && tar -xf /tmp/aoa-repo.tar -C ${q(remoteCwd)} && rm -f /tmp/aoa-repo.tar`] })`.
4. **Run — expect PASS** (both suites).
5. **Commit.** `git commit -m "feat(exec-isolation): sandbox file-movement seam + org repo stage-in + S4 egress-allowlist param (U6.2)"`

---

### Task: U6.3 — Org in-VM diff + stage-out; re-point output detection

Changed-file discovery must consume the **in-VM diff**, not the host mtime/git scan (else org `detectedFiles` silently zeroes, §5). We add `collectSandboxDiff` and route `output-detection.ts` through it for sandboxed runs, preserving the existing host-side path for desktop/local.

**Files:**
- Modify: `server/src/services/sandbox-file-movement.ts` (add `collectSandboxDiff`)
- Modify: `server/src/services/output-detection.ts` (inject a changed-file source)
- Modify: `server/src/services/heartbeat.ts` (pass the sandbox source at the `detectAndCapture` call, line ~5186)
- Create: `server/src/__tests__/sandbox-file-movement-diff.test.ts`
- Modify: `server/src/__tests__/output-detection.test.ts` (add sandboxed-source case)

1. **Write the failing tests.**
   - `sandbox-file-movement-diff.test.ts`: seed the fake sandbox with a git repo where two files changed + one untracked; assert `collectSandboxDiff` returns exactly those paths with their byte contents, and that the git invocations it issues include a **hooks-neutralizing** flag (security — a pulled/committed file must not run a host hook, and the same protection applies to git run in the VM):
     ```ts
     const diff = await collectSandboxDiff({ runner, remoteCwd });
     expect(diff.map((d) => d.path).sort()).toEqual(["new.txt", "src/a.ts"]);
     expect(runner.execute).toHaveBeenCalledWith(expect.objectContaining({ args: expect.arrayContaining([expect.stringContaining("-c core.hooksPath=")]) }));
     ```
   - `output-detection.test.ts`: add a case where `detectAndCaptureImpl` is given a `changedFileSource` (the sandbox provider); assert it **does not** call the host `execGitCommand`/mtime walk and that captured `DetectedOutput[]` come from the injected source. Assert `status: "pending"` and `confirmedArtifactId: null` are preserved (Decision #67 — capture stays review-gated).
2. **Run — expect FAIL.**
3. **Implement.**
   - `collectSandboxDiff({ runner, remoteCwd })`: run `runner.execute` with `git -c core.hooksPath= -C <remoteCwd> diff --name-only HEAD` and `git -c core.hooksPath= -C <remoteCwd> ls-files --others --exclude-standard`, dedupe (reuse the shape from `output-detection.ts:160-178`), apply `isNoisePath` + `MAX_FILES_PER_RUN`, then `runner.readFiles({ paths })` to pull contents out. Return `Array<{ path; content: Buffer }>`.
   - `output-detection.ts`: add an optional `changedFileSource?: () => Promise<Array<{ path: string; content: Buffer }>>` to `OutputDetectionInput`. When present, **bypass** the `isGitRepo`/`detectChangedFilesGit`/mtime branch (lines 285–297) and the `fs.readFile`/`fs.stat` reads in the capture loop (lines 373–401) — source bytes from the provided list instead, but keep the identical `storage.putFile` + `assets` insert + `DetectedOutput` shaping (so artifacts stay `status:"pending"`). The `assertLocalWorkspaceCommandAllowed` call at line 288 is only reached on the host path and stays intact for local runs.
   - `heartbeat.ts` (~5186): when `acquisition.environment.driver === "sandbox"` (**S5**), pass `changedFileSource: () => collectSandboxDiff({ runner, remoteCwd })` into `detectAndCapture`; otherwise leave the call unchanged.
4. **Run — expect PASS** (both new/updated suites).
5. **Commit.** `git commit -m "feat(exec-isolation): in-VM git diff feeds org output detection on cloud (U6.3)"`

---

### Task: U6.4 — Org host commit/push/PR from the pulled diff

After the in-VM diff is pulled out (U6.3), the **host** applies those files onto the host clone branch, commits, pushes, and opens the PR with the company PAT — reusing `createPullRequest` (`github-pr.ts:190`) and the workspace branch/commit infra. All git here runs through the U6.1 host-orchestration guard, never the tenant guard.

**Files:**
- Create: `server/src/services/sandbox-workspace-pr.ts`
- Modify: `server/src/services/workspace-runtime.ts` (allow `executeProcess` git under the host-orchestration guard when the caller is host-orchestration, not tenant)
- Create: `server/src/__tests__/sandbox-workspace-pr.test.ts`

1. **Write the failing test.** With `createPullRequest` mocked and a temp host clone, drive `finalizeSandboxOrgWorkspace` with a set of pulled `{path, content}` and assert it: writes the files into the clone, runs `git -c core.hooksPath= add/commit/push` (hooks disabled — a malicious pulled file cannot execute on the host at commit time), and calls `createPullRequest` once with the branch as `head`. Also assert the guard: when `tenantIsolationEnforced()` is true the commit/push still proceeds (host-orchestration sink permitted), proving U6.1 is wired.
   ```ts
   expect(gitCalls).toEqual(expect.arrayContaining([expect.arrayContaining(["-c", "core.hooksPath="])]));
   expect(createPullRequest).toHaveBeenCalledTimes(1);
   ```
2. **Run — expect FAIL.**
3. **Implement.**
   - `sandbox-workspace-pr.ts`: `finalizeSandboxOrgWorkspace({ db, companyId, repoUrl, hostClonePath, branchName, baseRef, files, prTitle, prBody })` — write each `files[]` entry to `hostClonePath` (path-traversal-guarded against the clone root, mirroring `isInsideWorkspace` in `output-detection.ts:125`), then run git via a helper that shells `git -c core.hooksPath= …` wrapped in `assertHostOrchestrationGitAllowed("org host commit/push")`: `add -A`, `commit -m`, `push origin <branch>`, then `createPullRequest(db, { companyId, repoUrl, base: baseRef, head: branchName, title, body, draft: false })`. On PR failure, still return the pushed branch (partial-success surface, §8 — never discard produced work).
   - `workspace-runtime.ts`: `executeProcess` (line 527) currently hard-refuses all git via `assertLocalWorkspaceCommandAllowed`. Thread an `orchestration: "host" | "tenant"` flag (default `"tenant"` — no behavior change for existing callers) so the host-orchestration git path calls `assertHostOrchestrationGitAllowed` instead. The tenant/default path stays refused on cloud exactly as today.
4. **Run — expect PASS.**
5. **Commit.** `git commit -m "feat(exec-isolation): host commits/pushes/opens PR from pulled in-VM diff (U6.4)"`

---

### Task: U6.5 — Crew A+ capture: sandbox working dir → `task_outputs`, artifacts founder-gated

The crew A+ model (R1): the sandbox's own working dir **is** the per-run workspace — no host worktree, no crew PR in v1. Produce files in-VM → capture to `task_outputs.detectedFiles`; artifact **versions still route through founder review-confirmation (Decision #67), never auto-minted**. This wires the currently-hardcoded `detectedFiles: []` and writes rows via `taskOutputService`.

**Crew run-id provenance (blocker, see wave header):** a crew run id lives in `internal_agent_runs` (`runner.ts:225`), NOT `heartbeat_runs`, but `task_outputs.createdByRunId` FKs `heartbeat_runs` and is asserted against it (`task-outputs.ts:123`). Crew captures therefore pass **`createdByRunId: null`** and carry the crew run id in **`metadata.crewRunId`** + set **`createdByAgentId`** (which FKs `agents`, a real ref). This is the divergence from the org path (U6.3), which does have a `heartbeat_runs` run id.

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/crew-run-outcome.ts` (thread real `detectedFiles`)
- Modify: `server/src/services/internal-agent/aoa-agents/runner.ts` (capture after `adapter.execute`, ~line 947)
- Create: `server/src/services/internal-agent/aoa-agents/crew-output-capture.ts`
- Create: `server/src/__tests__/crew-output-capture.test.ts` (unit; injectable-shape assertions)
- Create: `server/src/__tests__/crew-output-capture.integration.test.ts` (**real embedded-PG — proves the FK path**)

1. **Write the failing tests.**
   - **Unit** (`crew-output-capture.test.ts`): against a fake sandbox with two produced files and a stub `taskOutputService`, drive `captureCrewOutputs` and assert the *shape* passed to `upsertForIssue`:
     - It requests `assets` + `task_outputs` (`type: "detected_file"`, `createdByAgentId` set, **`createdByRunId: null`**, **`metadata.crewRunId === runId`**) for each captured file.
     - It **does NOT** insert any `artifactVersions` / `artifacts` row — the security/decision invariant (Decision #67, founder-gated). Encode explicitly:
       ```ts
       expect(insertedTables).not.toContain("artifact_versions");
       expect(insertedTables).not.toContain("artifacts");
       expect(upsertCalls.map((c) => c.reviewState)).toEqual(["needs_review", "needs_review"]);
       expect(upsertCalls.map((c) => c.createdByRunId)).toEqual([null, null]);
       expect(upsertCalls.map((c) => c.metadata?.crewRunId)).toEqual([runId, runId]);
       ```
     - The returned `detectedFiles` array is `[{ path, type? }, …]`, non-empty.
   - **Integration** (`crew-output-capture.integration.test.ts`, real embedded-PG — the unit stub was false-green because it never touched the `heartbeat_runs` FK/assertion): insert a real company + issue + crew **`internal_agent_runs`** row + agent, then drive `captureCrewOutputs` against the **real** `taskOutputService(db)` and assert the rows actually persist:
     ```ts
     // A crew run id passed as createdByRunId would FK-fail (heartbeat_runs) — this
     // test proves the null-run-id + metadata.crewRunId path persists cleanly.
     const rows = await taskOutputService(db).listForIssue(companyId, issueId);
     expect(rows).toHaveLength(2);
     expect(rows.every((r) => r.createdByRunId === null)).toBe(true);
     expect(rows.every((r) => r.metadata?.crewRunId === crewRunId)).toBe(true);
     expect(rows.every((r) => r.createdByAgentId === agentId)).toBe(true);
     expect(rows.every((r) => r.reviewState === "needs_review")).toBe(true);
     expect(rows.every((r) => r.type === "detected_file")).toBe(true);
     // Negative control: passing the crew run id as createdByRunId must be rejected.
     await expect(
       taskOutputService(db).upsertForIssue(companyId, issueId, {
         type: "detected_file", assetId, title: "x", createdByRunId: crewRunId,
       }),
     ).rejects.toThrow(/Heartbeat run/);
     ```
     (Run on Windows embedded-PG per the project's `initdbFlags: ["--encoding=UTF8","--locale=C"]` pattern; on Linux CI it runs as a normal integration test.)
2. **Run — expect FAIL** (both).
3. **Implement.**
   - `crew-output-capture.ts`: `captureCrewOutputs({ db, companyId, issueId, agentId, runId, runner, remoteCwd })` → call `collectSandboxDiff` (U6.3) to pull produced files out of the crew sandbox, `storage.putFile` + insert `assets` (reuse the exact shaping in `output-detection.ts:394-416`), then for each call
     ```ts
     taskOutputService(db).upsertForIssue(companyId, issueId, {
       type: "detected_file",
       assetId,
       title: basename,
       status: "active",
       reviewState: "needs_review",
       createdByAgentId: agentId,
       createdByRunId: null,            // crew runs live in internal_agent_runs, NOT heartbeat_runs
       metadata: { crewRunId: runId },  // provenance for the crew run id
     })
     ```
     Return `Array<{ path; type? }>`. Guard `issueId == null` (thread-only crew runs) → return `[]`. Never throw (best-effort, matching `crew-run-outcome` philosophy).
   - `runner.ts`: after a successful `adapter.execute` for an issue-linked crew run (~947), call `captureCrewOutputs` (only when the run targeted a provider sandbox, i.e. `acquisition.environment.driver === "sandbox"`, **S5**) and thread the result into the success loopback.
   - `crew-run-outcome.ts`: change `resolveCrewRunSummaryArgs` to accept a `detectedFiles` param (default `[]` for back-compat) instead of hardcoding `[]` at line 107; `postCrewRunSuccess` forwards the captured list.
4. **Run — expect PASS** (both).
5. **Commit.** `git commit -m "feat(exec-isolation): crew in-sandbox outputs captured to task_outputs (null run-id + metadata.crewRunId), artifacts founder-gated (U6.5)"`

---

### Task: U6.6 — Preview URLs via E2B `getHost(port)` → `task_outputs`

R4 (A): in-VM dev servers on `software_development` runs fail the host loopback path on cloud. Expose the sandbox port as a preview URL via `getHost(port)` (added to the provider seam in U6.2) and record it as a `task_outputs` row of `type: "preview_url"`.

**Files:**
- Modify: `server/src/services/sandbox-file-movement.ts` (add `resolveSandboxPreviewUrl`)
- Modify: `server/src/services/heartbeat.ts` (emit a preview `task_output` when a runtime service port is detected on a sandboxed run)
- Create: `server/src/__tests__/sandbox-preview-url.test.ts`

1. **Write the failing test.** Fake provider `resolveHost({ port: 3000 })` returns `"3000-fakesandbox.e2b.app"`; assert `resolveSandboxPreviewUrl({ runner, port: 3000 })` returns `https://3000-fakesandbox.e2b.app`, and that emitting it upserts a `task_outputs` row with `type: "preview_url"`, `url` set, and `healthStatus` defaulted. Assert the URL is derived **only** from `getHost` (never the control-plane host / never an internal IP):
   ```ts
   expect(url).toBe("https://3000-fakesandbox.e2b.app");
   expect(url).not.toMatch(/127\.0\.0\.1|localhost|internal/);
   ```
2. **Run — expect FAIL.**
3. **Implement.**
   - `resolveSandboxPreviewUrl({ runner, port })` → `const host = await runner.resolveHost({ port }); return \`https://${host}\`;` (E2B `getHost` returns host without scheme).
   - `heartbeat.ts`: for a sandboxed (`acquisition.environment.driver === "sandbox"`, **S5**) `software_development` run that started a runtime service (reuse the existing `workspaceRuntimeServices` port discovery), call `resolveSandboxPreviewUrl` and `taskOutputService(db).upsertForIssue(companyId, issueId, { type: "preview_url", url, title: "Preview", status: "active" })`. Gate on `issueId != null` and on the run having targeted a provider sandbox.
4. **Run — expect PASS.**
5. **Commit.** `git commit -m "feat(exec-isolation): expose in-VM dev server as preview task_output via getHost (U6.6)"`

---

### Task: U6.7 — Stage the agent's own skill bundles into the VM (managed marketplace-skills root excluded)

§9/§14 invariant (spec lines 153, 222): skill **files** are staged into the VM via the existing remote-dir sync (`syncAdapterExecutionTargetDirectory`), but **the managed marketplace-skills root — with its cross-company siblings on disk — is never mounted.** Today `claude-local` already builds a per-run tmp `.claude/skills/` from the agent's *own* resolved `RuntimeSkillEntry[]` (`buildSkillsDir` over `context.skills`) and syncs it to the remote target (`packages/adapters/claude-local/src/server/execute.ts:628`, `syncAdapterExecutionTargetDirectory` → `effectiveRemoteSkillsDir`). Each entry's ancillary files are read **per-skill** from `skill.sourceLocator` / `metadata.catalogBundleInstallPath` via `readAncillarySkillFiles` (`company-skills.ts:2571-2578`), and the agent's list is already scoped to its `skillKeys` (`listRuntimeSkillEntries`, `company-skills.ts:2546`) — so the shared managed install **root** is never walked wholesale. This task **encodes that invariant as a regression test** (currently unencoded) and adds the same explicit skill-staging step to any sandbox-targeted crew run that resolves skills but does not go through the claude-local `buildSkillsDir` path.

**Files:**
- Modify: `server/src/services/internal-agent/aoa-agents/runner.ts` (stage resolved crew skills into the sandbox for provider-sandbox targets, reusing `syncAdapterExecutionTargetDirectory`)
- Create: `server/src/__tests__/sandbox-skill-staging.test.ts`

1. **Write the failing test.** Build a fixture managed marketplace-skills root on disk containing **two** company subtrees — the run agent's own skill (e.g. `<root>/companyA/my-skill/SKILL.md` + `references/x.md`) and a **cross-company sibling** (`<root>/companyB/other-skill/SKILL.md`). Resolve the agent's `RuntimeSkillEntry[]` (only `my-skill`), stage it into a fake sandbox via the U6.7 helper, then assert:
   - the agent's own `SKILL.md` + `references/x.md` land under `<remoteCwd>/.claude/skills/my-skill/…`;
   - the cross-company sibling path is **absent** from everything staged:
     ```ts
     const stagedPaths = await listSandboxFiles(runner, `${remoteCwd}/.claude/skills`);
     expect(stagedPaths).toEqual(expect.arrayContaining(["my-skill/SKILL.md", "my-skill/references/x.md"]));
     expect(stagedPaths.some((p) => p.includes("other-skill"))).toBe(false);
     expect(stagedPaths.some((p) => p.includes("companyB"))).toBe(false);
     ```
   - a negative assertion that the managed root itself is never a `syncAdapterExecutionTargetDirectory` `localDir` (only the per-run built `.claude/skills` tmp dir is), guarding against a future refactor mounting the root:
     ```ts
     expect(syncCalls.every((c) => !isManagedMarketplaceRoot(c.localDir))).toBe(true);
     ```
2. **Run — expect FAIL** (staging helper + invariant unencoded).
3. **Implement.** Extract the claude-local staging shape into a small reusable step: build a per-run `.claude/skills/` tmp dir from the resolved `RuntimeSkillEntry[]` (`entry.markdown` → `SKILL.md`, `entry.files[]` → sibling files, **per skill key only**), then `syncAdapterExecutionTargetDirectory({ runId, target, localDir: <tmp>/.claude/skills, remoteDir: <remoteCwd>/.claude/skills, cwd: remoteCwd })`. Wire it into `runner.ts` for sandbox-targeted crew runs (`acquisition.environment.driver === "sandbox"`, **S5**) right where `agentSkills` is already resolved (`runner.ts:905-933`) — the managed root is never passed as a `localDir`; only per-agent, per-skill content is materialized into the tmp dir first. Leave claude-local's existing `buildSkillsDir`/`:628` path unchanged (it already satisfies the invariant); this task adds the same behavior for any sandbox path that lacked it and locks it with the test.
4. **Run — expect PASS.**
5. **Commit.** `git commit -m "feat(exec-isolation): stage per-agent skill bundles into sandbox, exclude managed marketplace-skills root (U6.7)"`

---

**Wave 4 exit criteria:**
- `assertHostOrchestrationGitAllowed` permits AoA-authored git on cloud while `assertLocalWorkspaceCommandAllowed` still refuses tenant workspace commands (U6.1 test green).
- The sandbox provider create/resume path accepts `egressAllowlist?: string[]` and records it in lease metadata (best-effort; no throw on managed E2B), threaded from acquire (**S4**; U11 will union hosts into it).
- An org run on a fake sandbox stages the repo in, produces a change, the in-VM diff is pulled out, and `output-detection` captures it from the **sandbox source** (selected via `acquisition.environment.driver === "sandbox"`, **S5**) — `detectedFiles` is non-empty and every captured output is `status:"pending"` / unconfirmed (Decision #67).
- The host commits/pushes/opens exactly one PR from the pulled diff via `createPullRequest`, with git run under `-c core.hooksPath=` (no host hook execution) and under the host-orchestration guard.
- A crew run captures its in-sandbox files to `assets` + `task_outputs` (`reviewState:"needs_review"`, `createdByRunId: null`, `metadata.crewRunId` + `createdByAgentId` set) and inserts **no** `artifacts`/`artifact_versions` rows; the **real embedded-PG** integration test proves the rows persist (and that passing the crew run id as `createdByRunId` is rejected against `heartbeat_runs`); `postCrewRunSuccess` carries the real `detectedFiles`.
- A sandboxed `software_development` run records a `type:"preview_url"` `task_output` whose URL comes solely from `getHost(port)`.
- An agent's own skill bundles are staged into the sandbox via `syncAdapterExecutionTargetDirectory`, and the regression test proves the managed marketplace-skills root's cross-company siblings are **never** staged (spec §9/§14).
- Full path (stage-in → in-VM diff → stage-out → capture → PR/preview, plus skill staging) runs against the fake provider in CI with no live E2B (§10).

**PR-cut note:** Wave 4 is a natural **PR-cut point** — it is U6 in its entirety and lands the largest single build gap (file movement, "the biggest build gap" per the reference §7.4) on top of the already-tested sandbox/broker foundation from Waves 1–3. It depends on the U4 `acquireExecutionContext` seam and the U2/U3 broker+crew-JWT but adds no new runtime-auth surface, so it reviews cleanly as a self-contained "outputs survive the VM" change. It introduces the S4 `egressAllowlist` param but leaves it empty (U11 populates); it does **not** require U7 (warm reuse), U8 (D1 flip), U10, or U11 to be correct.
