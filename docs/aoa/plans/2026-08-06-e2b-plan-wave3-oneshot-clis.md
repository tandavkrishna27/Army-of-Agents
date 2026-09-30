# E2B Cloud Execution Isolation — Implementation Plan (Wave 3: wave3-oneshot-clis)

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` to execute this wave task-by-task. Steps use `- [ ]` checkboxes.
>
> **Spec:** `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md`. **Shared seams:** the INDEX. Execute waves 0→7; U8/guard-flip LAST.

---

## Wave 3 — Host one-shot CLIs in a sandbox (U13)

**Goal:** the three host-side one-shot provider-CLI families that fail closed on cloud today — **(a)** extraction (`extractViaCli`), **(b)** Commander history-compaction (`summarizeViaCli`), **(c)** readiness probes (`adapter.testEnvironment`) — instead run inside an **ephemeral** E2B sandbox authenticated with the **company's own** provider key, so discussion→task extraction, Commander compaction, and BYO-key onboarding verify all work on `cloud_auth`. **Covers U13 only.**

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` to execute this wave task-by-task. Steps use `- [ ]` checkboxes.
>
> **Spec (authoritative):** `docs/aoa/plans/2026-08-05-cloud-execution-isolation-e2b-spec.md`. **Execute waves in order 0→7; U8 / guard-flip is LAST.** Each wave is an independently testable PR-cut candidate.

**Depends on prior waves' seams** (import them; conform to the exact shapes below — do **not** invent variants):

- **U12 catch-mapper — `mapCloudProviderKeyError(err, { provider, sink })` + `CloudProviderKeyMissingError`** in `server/src/services/internal-agent/require-cloud-provider-key.js`. U12 builds **only this mapper** (a `try/catch` translator, *not* an assertion): `resolveProviderCredential` already throws `ProviderUnavailableError` on cloud when no company key resolves, and `mapCloudProviderKeyError` re-labels that thrown error into a `CloudProviderKeyMissingError` carrying the sink/provider for founder-facing copy. There is **no** `assertCloudProviderKeyResolved` — never reference it (dead code). **U12 does NOT export a `resolveCompanyProviderCredential`** — this wave builds it (task **U13.0**).
- **`resolveProviderCredential(db, args, deps)`** (existing, `server/src/services/provider-resolution.ts:307`) → `ResolvedProviderCredential` (`{ source: "connection"|"legacy"|…, envPatch?, … }`); throws **`ProviderUnavailableError`** (`provider-resolution.ts:283`) on multi-tenant with no resolvable key. Deps come from `buildResolveDeps(db, topology)` (`provider-resolution-deps.ts:26`), which exposes `envVarForProvider` (`providers/provider-key.ts`). **U13.0 wraps this** into the S3 shape; **U12's `mapCloudProviderKeyError` sits over the same throw** at the sink call-sites.
- **`acquireExecutionContext(db, input)`** (U4, `server/src/services/acquire-execution-context.js`) — the single sandbox-lease entry point. Passes `environmentId: input.environmentId ?? null` straight into `orchestrator.acquireForRun`; when `environmentId == null`, `resolveEnvironment` (`environment-run-orchestrator.ts:123`) resolves the platform default via **`resolvePlatformDefaultEnvironment(companyId, deploymentMode, env)`** (`server/src/services/platform-default-environment.ts`, returns `Environment | null`). Returns an `EnvironmentAcquisitionResult`; the acquisition **driver is read at `acquisition.environment.driver === "sandbox"`** (S5 — there is **no** top-level `driver`), and the acquired lease is `acquisition.lease`, an **`EnvironmentLease`** (`packages/shared/src/types/environment.ts:30`) whose relevant fields are `provider: string | null`, `providerLeaseId: string | null`, and `metadata: Record<string,unknown> | null` (**not** `providerKey`, **not** `leaseMetadata`). There is **no** `resolvePlatformSandboxTarget` and **no** sentinel environment id.
- **`buildSandboxEnvAllowlist(overlay, { provider })`** (U5, `packages/adapter-utils/src/sandbox-env-allowlist.ts`, re-exported from the package index) — signature `(overlay: Record<string,string>, opts: { provider: string }): Record<string,string>`. It **filters the caller-supplied `overlay`** down to the positive allowlist and drops the never-in-VM set; it does **not** inject any credential. Callers **build the overlay first** (`{ [credential.envName]: credential.value, … }`) then pass it in.
- **Provider execution — `executeRunLeaseCommand`** (`server/src/services/environment-runtime.ts:512`, on `environmentRuntimeService(db)`) is the reference implementation for running a command on a provider lease. It reads `provider = readString(lease.provider)`, `providerMetadata = readObject(readObject(lease.metadata).providerMetadata)`, resolves a provider config via **`resolveRuntimeProviderConfig({ companyId, provider, config: readObject(environment.config), runtimeProviderKeys, … })`** (`environment-runtime.ts:277`), then calls `providerRuntime.execute(provider, { providerLeaseId, leaseMetadata: providerMetadata, config: providerConfig, command, args, env, stdin, timeoutMs })`. The one-shot helper (U13.1) resolves config **the same way** — it does **not** hand-build a shape or call `execute` with no `config`.
- **`sandboxProviderRuntime()`** (existing, `server/src/services/sandbox-provider-runtime.ts`) — `.acquireLease(provider, input)`, `.releaseLease(provider, input)`, `.execute(provider, { command, args, env, stdin, cwd, timeoutMs, providerLeaseId, leaseMetadata, config })` → `{ exitCode, stdout, stderr, timedOut }`. The first positional arg is the provider dispatch key (i.e. `lease.provider`); `leaseMetadata` and `config` are the values resolved as above. `execute` already stages `stdin` as a temp file inside the VM and injects `env`; the `importE2b` seam is where the CI fake mounts. Ephemeral teardown = `releaseLease` with `config.reuseLease: false` (kill, never pause).

---

### Task: U13.0 — `resolveCompanyProviderCredential` (the S3 resolver this wave owns)

U12 built only the *catch-mapper* (`mapCloudProviderKeyError`). The three one-shot families need the *value*: the company's own model-provider key + its env var name + resolved model. Build the thin adapter over `resolveProviderCredential` here.

**Files:**
- Create: `server/src/services/one-shot-provider-credential.ts` (`resolveCompanyProviderCredential`)
- Create (test): `server/src/__tests__/one-shot-provider-credential.test.ts`

**Steps:**

1. Write the failing test `one-shot-provider-credential.test.ts`. Inject a fake `resolveProviderCredential` (spy) and a fake `internal_agent_config` model row. Assert:
   - `resolveCompanyProviderCredential(db, companyId, { cliTool: "claude" })` maps `cliTool → provider` (`"claude" → "anthropic"`, `"codex" → "openai"`) and calls `resolveProviderCredential` with `actorKind: "crew"`, `provider`, `currentEnv: {}` (never the host env), `companyId`.
   - On a `{ source: "connection", envPatch: { ANTHROPIC_API_KEY: "sk-co" } }` result it returns `{ envName: "ANTHROPIC_API_KEY", value: "sk-co", provider: "anthropic", model }` — `envName` is exactly `envVarForProvider(provider)` and `value` is `envPatch[envName]`.
   - On a `{ source: "legacy", envPatch }` result carrying the company key it returns the same shape (legacy company-key path still yields a real value).
   - When `resolveProviderCredential` throws **`ProviderUnavailableError`** (cloud, no key), `resolveCompanyProviderCredential` **propagates it unchanged** (do not wrap/rename — U12's `mapCloudProviderKeyError` + this resolver share the one `ProviderUnavailableError` taxonomy; the *mapper* re-labels it only at the sink boundary).
2. Run it — expect FAIL (module does not exist).
3. Implement `server/src/services/one-shot-provider-credential.ts`:
   ```ts
   export interface CompanyProviderCredential {
     envName: string; value: string; provider: string; model: string;
   }
   export async function resolveCompanyProviderCredential(
     db: Db, companyId: string, opts: { cliTool: string },
   ): Promise<CompanyProviderCredential> { … }
   ```
   Flow: `provider = opts.cliTool === "codex" ? "openai" : "anthropic"`; `deps = buildResolveDeps(db, resolveCliAuthTopology(loadConfig()))`; `resolved = await resolveProviderCredential(db, { organizationId: null, companyId, agentId: null, actorKind: "crew", adapterType: opts.cliTool === "codex" ? "codex_local" : "claude_local", provider, executionTargetId: "control-plane", currentEnv: {}, context: { consumerType: "agent", consumerId: companyId, actorType: "agent", actorId: companyId } }, deps)`. `envName = deps.envVarForProvider(provider)`; take `value = resolved.envPatch?.[envName]` (only `connection`/`legacy`/`enterprise_gateway` produce an `envPatch`; on cloud those are the only sources short of the throw). If no `value`, throw `ProviderUnavailableError(provider, "empty_credential", null)`. `model = (internal_agent_config.model for companyId) ?? providerDefaultModel(provider)`. Return `{ envName, value, provider, model }`.
   - `resolveProviderCredential` already throws `ProviderUnavailableError` on multi-tenant no-key — **do not** re-check `tenantIsolationEnforced()` here; let it throw.
4. Run — expect PASS.
5. Commit: `feat(exec-isolation): add resolveCompanyProviderCredential over resolveProviderCredential (U13.0, S3)`.

---

### Task: U13.1 — Shared ephemeral-sandbox one-shot CLI helper

The single seam all three families route through: acquire a fresh sandbox via the U4 execution-context seam, inject **only** the company key via the U5 allowlist (S2), run one CLI command **through the same provider-config resolution `executeRunLeaseCommand` uses** (S6), tear the sandbox down (kill, never pause), return stdout + stderr + exit + timing.

**Files:**
- Create: `server/src/services/one-shot-sandbox-cli.ts`
- Modify: `server/src/services/environment-runtime.ts` (export the module-private `resolveRuntimeProviderConfig` — line 277 — so the one-shot helper resolves provider config identically to `executeRunLeaseCommand`; no behavior change)
- Create (test): `server/src/__tests__/one-shot-sandbox-cli.test.ts`

**Steps:**

1. Write the failing test `one-shot-sandbox-cli.test.ts`. Inject fakes for `acquireExecutionContext`, `sandboxProviderRuntime` (spy `execute`/`releaseLease`), `resolveRuntimeProviderConfig`, and `resolveCompanyProviderCredential`. The injected `acquireExecutionContext` returns an `EnvironmentAcquisitionResult`-shaped object that **mirrors S5 + the real `EnvironmentLease` shape (S6)**: `{ environment: { driver: "sandbox", config: {} }, lease: { id: "lease-1", companyId, environmentId: "env-1", issueId: null, heartbeatRunId: null, provider: "e2b", providerLeaseId: "plid-1", metadata: { providerMetadata: {} }, … }, … }` — the lease uses `provider` + `providerLeaseId` + `metadata.providerMetadata`, **never** `providerKey`/`leaseMetadata`. Assert:
   - `runOneShotCliInSandbox` calls `acquireExecutionContext` **once** with `environmentId: null` (platform-default resolution), then resolves config via `resolveRuntimeProviderConfig` once, then `execute` once, then `releaseLease` once with `config.reuseLease: false` (ephemeral — killed, never paused).
   - It gates on `acquisition.environment.driver === "sandbox"`; when the fake returns `driver: "local"` it throws `OneShotSandboxError` with `kind:"sandbox_unavailable"` and does **not** call `execute`.
   - `execute` is invoked as `execute(acquisition.lease.provider, …)` (first arg = `lease.provider`), with `providerLeaseId: acquisition.lease.providerLeaseId`, `leaseMetadata` = `readObject(readObject(acquisition.lease.metadata).providerMetadata)`, and `config` = the `resolveRuntimeProviderConfig` output — assert the helper reads **none** of `lease.providerKey` / `lease.leaseMetadata` (they don't exist) and never calls `execute` with `config: undefined`.
   - The `env` passed to `execute` is exactly `buildSandboxEnvAllowlist(overlay, { provider })` output — assert `DATABASE_URL`, `DIRECT_DATABASE_URL`, `GITHUB_PAT`, `CLAUDE_CODE_OAUTH_TOKEN`, `BETTER_AUTH_SECRET`, `AOA_AGENT_JWT_SECRET`, and the embeddings `OPENAI_API_KEY` are **absent**, and the company's resolved provider key **is present** under its `envName`. (Because the caller-built overlay carries only the credential, this holds by construction *and* by the allowlist filter.)
   - `stdinContent` is forwarded to `execute({ stdin })`; when `stagedFile` is passed instead, `execute` is called with `stdin: undefined` and the helper first writes the file into the VM (see U13.5) — for this task assert only the stdin branch.
   - On `execute` returning `{ timedOut:true }`, the helper throws `OneShotSandboxError` with `kind:"timeout"`; on `acquireExecutionContext` throwing, it throws `OneShotSandboxError` with `kind:"sandbox_unavailable"` and still does **not** call `execute`.
2. Run it — expect FAIL (module does not exist).
3. Implement `server/src/services/one-shot-sandbox-cli.ts`:
   ```ts
   export type OneShotSandboxErrorKind = "sandbox_unavailable" | "timeout" | "nonzero_exit";
   export class OneShotSandboxError extends Error {
     constructor(message: string, readonly kind: OneShotSandboxErrorKind, readonly exitCode: number | null = null, readonly stderr = "") { super(message); this.name = "OneShotSandboxError"; }
   }
   export interface OneShotCliResult { stdout: string; stderr: string; exitCode: number; durationMs: number; }
   export interface RunOneShotCliInput {
     db: Db; companyId: string; cliTool: string;      // "claude" | "codex"
     command: string; args: string[];
     stdinContent?: string;                            // extraction/compaction prompt content
     stagedFile?: { remotePath: string; content: string }; // U13.5 file-import
     timeoutMs: number;
     sandboxHandle?: OneShotSandboxHandle;             // U13.3 pre-acquired batch lease (skip own acquire)
     deps?: Partial<OneShotDeps>;                      // test injection
   }
   export interface OneShotSandboxHandle { environment: EnvironmentAcquisitionResult["environment"]; lease: EnvironmentLease; providerConfig: Record<string, unknown>; }
   export async function runOneShotCliInSandbox(input: RunOneShotCliInput): Promise<OneShotCliResult> { … }
   ```
   Flow: `credential = resolveCompanyProviderCredential(db, companyId, { cliTool })` (U13.0) → obtain the lease: if `input.sandboxHandle` is supplied (batch reuse, U13.3) use `{ environment, lease, providerConfig }` from it and **skip** `acquireExecutionContext`; otherwise `acquisition = acquireExecutionContext(db, { companyId, environmentId: null, … })` (U4; wrap acquire failures as `sandbox_unavailable`) and **assert `acquisition.environment.driver === "sandbox"`** (S5; otherwise `sandbox_unavailable`). Resolve provider config **exactly as `executeRunLeaseCommand`** (S6):
   ```ts
   const provider = readString(lease.provider);
   if (!provider) throw new OneShotSandboxError("lease missing provider", "sandbox_unavailable");
   const providerMetadata = readObject(readObject(lease.metadata).providerMetadata);
   const providerConfig = handle?.providerConfig ?? await resolveRuntimeProviderConfig({
     companyId, provider, config: readObject(environment.config), runtimeProviderKeys, issueId: null, heartbeatRunId: null,
   });
   ```
   Then build the overlay **first** and filter it (S2):
   ```ts
   const overlay: Record<string,string> = { [credential.envName]: credential.value };
   // one-shot CLIs have no MCP loopback / run identity, so no AOA_RUN_ID / AOA_API_URL is injected
   const env = buildSandboxEnvAllowlist(overlay, { provider: credential.provider }); // S2
   ```
   → if `stagedFile`, write it into the VM first (helper composes a `files.write` step; reuse the provider's own staging path shape — see U13.5) → `sandboxProviderRuntime().execute(provider, { command, args, env, stdin: stagedFile ? undefined : stdinContent, providerLeaseId: readString(lease.providerLeaseId), leaseMetadata: providerMetadata, config: providerConfig, timeoutMs })` inside a `try/finally` whose `finally` — **only when the helper acquired its own lease** (not a reused `sandboxHandle`) — calls `releaseLease(provider, { providerLeaseId: readString(lease.providerLeaseId), leaseMetadata: providerMetadata, config: { ...providerConfig, reuseLease: false } })` (kill). Map `timedOut` → `OneShotSandboxError("timeout")`; `exitCode !== 0` → `OneShotSandboxError("nonzero_exit", exitCode, stderr)`.
   Do **not** read `process.env` for the child env — the caller-built overlay + allowlist is the only source (U5 invariant). Do **not** hand-build a lease shape or call `execute` without a resolved `config` — mirror `executeRunLeaseCommand` (environment-runtime.ts:512-540) exactly.
4. Run — expect PASS.
5. Commit: `feat(exec-isolation): add ephemeral-sandbox one-shot CLI helper resolving provider config like executeRunLeaseCommand (U13.1, S6)`.

---

### Task: U13.2 — U13.0 key resolution in the extraction context + thread it through the discussion-entry extractor + drop the operator-cred KEEP-list

`resolveCliExtractionContext` (`extraction.ts:120`) today returns `{ cliTool, codexModel }` with **zero** provider-key (auth = ambient host login). U13 adds the company key. Crucially, the **launch-critical discussion→task path** runs through `extractFromDiscussionEntry` (`extraction.ts:310`), which resolves `cliTool` at `:461` and calls `extractViaCli` at `:473` — it is the extractor driven by `extractThreadEntriesAwait` (`:652`) that the Adjutant invokes (`thread-agent-actions.ts:791`). If the company key + per-batch sandbox handle are **not** threaded into `extractFromDiscussionEntry`, discussion→task fails closed on cloud. And the local (desktop) path must stop carrying the operator creds `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` when the run targets a sandbox.

**Files:**
- Modify: `server/src/services/extraction.ts`:
  - `resolveCliExtractionContext` (line 120)
  - `extractFromDiscussionEntry` (line 310; `cliTool` at `:461`; `extractViaCli` call at `:473`) — accept + forward `credential` + a per-batch `sandboxHandle`
  - the `extractOne` seam in `extractThreadEntriesAwait` — typed signature (`:657`) + default wrapper (`:680`)
- Modify: `server/src/services/extraction-cli.ts` (`extractViaClaude` env at line 251; `ExtractViaCliOptions` at line 97)
- Create (test): `server/src/__tests__/extraction-cli-sandbox-env.test.ts`

**Steps:**

1. Write the failing test `extraction-cli-sandbox-env.test.ts`. Cases:
   - **Cloud sandbox path (discussion entry):** with `tenantIsolationEnforced()` true and a resolved company credential, drive `extractFromDiscussionEntry` and assert its `extractViaCli` call routes through `runOneShotCliInSandbox` (spy) and the env handed to the sandbox does **not** contain `CLAUDE_CODE_OAUTH_TOKEN` or a host-ambient `ANTHROPIC_API_KEY` that is not the company's own key; it contains only the company's resolved key (present under its `envName`).
   - **Batch-handle reuse:** when `extractFromDiscussionEntry` is called with a `sandboxHandle` (as the batch path in U13.3 does), assert `runOneShotCliInSandbox` receives that same handle (the helper reuses the lease and does **not** call `acquireExecutionContext`).
   - **Desktop path unchanged:** with `tenantIsolationEnforced()` false, `extractViaCli` still spawns locally via `buildScrubbedCliEnv(["ANTHROPIC_API_KEY","CLAUDE_CODE_OAUTH_TOKEN"])` (`extraction-cli.ts:251`) — assert the local branch is taken (no sandbox helper call). (The desktop KEEP-list is legitimate there; U13 only drops it for the sandbox branch.)
2. Run it — expect FAIL.
3. Implement:
   - In `extraction.ts`, extend `resolveCliExtractionContext` to also resolve the company provider credential on cloud: `const credential = tenantIsolationEnforced() ? await resolveCompanyProviderCredential(db, companyId, { cliTool }) : null;` and return `{ cliTool, codexModel, credential }`.
   - **Thread the credential + `sandboxHandle` into `extractFromDiscussionEntry`.** Extend its signature to `extractFromDiscussionEntry(companyId, entryId, sandboxHandle?)`; inside, resolve `credential` via `resolveCliExtractionContext` (already returning it) and pass `{ codexModel, credential, companyId, db, sandboxHandle }` into the `extractViaCli(cliTool, prompt, userContent, { … })` call at `:473`. Extend the injectable **`extractOne` seam** in `extractThreadEntriesAwait`: the typed option (`:657`) becomes `extractOne?: (companyId: string, entryId: string, sandboxHandle?: OneShotSandboxHandle) => Promise<unknown>` and the default wrapper (`:680`) becomes `((c, e, h) => extractionService(db).extractFromDiscussionEntry(c, e, h))`. (The batch acquire that produces `h` lands in U13.3; here just plumb the parameter end-to-end so it is inert until U13.3 supplies it.)
   - Thread `credential` into the other CLI callers too — `extractFromDebrief` (`:195`), `extractFromRawText` (`:871`), `extractMemoryCandidates` (`:999`) — via `ExtractViaCliOptions`.
   - In `extraction-cli.ts`, add `credential?: CompanyProviderCredential`, `companyId?: string`, `db?: Db`, and `sandboxHandle?: OneShotSandboxHandle` to `ExtractViaCliOptions` (line 97). The **sandbox** branch (added in U13.3) builds its overlay and calls `buildSandboxEnvAllowlist(overlay, { provider })` inside `runOneShotCliInSandbox` and **never** `buildScrubbedCliEnv`. Leave the existing local `spawn("claude", …, { env: buildScrubbedCliEnv([...]) })` (`:247`/`:251`) for the desktop branch only.
4. Run — expect PASS.
5. Commit: `feat(exec-isolation): resolve company provider key for extraction, thread it (+ batch sandbox handle) through the discussion-entry extractor; drop operator-cred KEEP-list on sandbox path (U13.2)`.

---

### Task: U13.3 — Route extraction through the sandbox; sandbox-per-batch; acquire outside the deadline; `sandbox_unavailable` failure class

Replace the hard `tenantIsolationEnforced()` throw at `extraction-cli.ts:127` with a sandbox execution branch, and make `extractThreadEntriesAwait` (`extraction.ts:652`) acquire **one** sandbox for the whole batch, **before** the 180s clock (`EXTRACT_SCOPE_DEADLINE_MS`, `extraction.ts:24`), and reuse it per entry via the `sandboxHandle` seam plumbed in U13.2.

**Files:**
- Modify: `server/src/services/extraction-cli.ts` (cloud branch at line 127; `CliErrorKind` at line 42; `claudeFailureMessage`/`codexFailureMessage` helpers at `:344`/`:363`)
- Modify: `server/src/services/extraction.ts` (`extractThreadEntriesAwait` at line 652; `extractFromDiscussionEntry` retry loop at `:471`; failure copy)
- Modify: `ui/src/pages/DiscussionDetail.tsx` (extraction failure copy — `sandbox_unavailable` guidance)
- Create (test): `server/src/__tests__/extraction-sandbox-batch.integration.test.ts` (embedded-PG)
- Create (test): `server/src/__tests__/extraction-sandbox-failure.test.ts`

**Steps:**

1. Write the failing unit test `extraction-sandbox-failure.test.ts`:
   - Add `"sandbox_unavailable"` to `CliErrorKind` (`extraction-cli.ts:42`). Assert `extractViaCli` on cloud, when the injected sandbox helper throws `OneShotSandboxError("sandbox_unavailable")`, throws `CliExtractionError` with `kind:"sandbox_unavailable"` (not `"not_authed"` — replacing the current line-127 behavior).
   - Assert the classified failure carries cloud copy that points at provider-key/config, e.g. `"Extraction could not run: no isolated sandbox was available. Check your provider key and execution environment in Settings."` — and that it does **not** contain the substring `"install"` (that copy is desktop-only).
2. Run — expect FAIL.
3. Write the failing integration test `extraction-sandbox-batch.integration.test.ts` (real embedded-PG, fake sandbox provider at the `importE2b` seam per §10):
   - Seed a discussion with 3 never-extracted entries. Set `cloud_auth`. Spy the injected `acquireExecutionContext`.
   - Assert `extractThreadEntriesAwait` produces extracted items for all 3 entries **and** `acquireExecutionContext` was called **exactly once** (one sandbox per batch/pass, not per entry) — i.e. entries 2 and 3 ran on the reused `sandboxHandle`.
   - Assert the batch lease is released **exactly once** after the loop (`releaseLease(provider, { config: { reuseLease: false } })`), not per entry.
   - Assert the sandbox acquire happens **before** the extraction deadline clock: mock the acquire to consume 30s and assert all 3 entries still get their full per-entry timeout budget (encode by asserting `now()` at the first `extractOne` call is measured from *after* acquire, i.e. `EXTRACT_SCOPE_DEADLINE_MS` is not eaten by acquire — inject `now`).
4. Run — expect FAIL.
5. Implement:
   - `extraction-cli.ts`: replace the `if (tenantIsolationEnforced()) throw new CliExtractionError(…, "not_authed")` block (`:127`) with: on cloud, delegate to `runOneShotCliInSandbox({ db: options.db, companyId: options.companyId, cliTool, command, args, stdinContent: content, timeoutMs, sandboxHandle: options.sandboxHandle })`, then `parseExtractedItems(result.stdout)`; map `OneShotSandboxError` → `CliExtractionError` (kinds `sandbox_unavailable`, `timeout`, `nonzero_exit`). Add `claudeFailureMessage`/`codexFailureMessage` cases (`:344`/`:363`) for `sandbox_unavailable` with the cloud copy. When `options.sandboxHandle` is present the helper reuses the pre-acquired batch lease and skips its own `acquireExecutionContext` (per U13.1/U13.2).
   - `extraction.ts` `extractThreadEntriesAwait`: on cloud, acquire the batch sandbox via `acquireExecutionContext(db, { companyId, environmentId: null })` **before** `startedAt = now()`, assert `acquisition.environment.driver === "sandbox"`, resolve `providerConfig` once via `resolveRuntimeProviderConfig` (so per-entry calls don't re-resolve), build the `sandboxHandle = { environment: acquisition.environment, lease: acquisition.lease, providerConfig }`, pass it into each `extractOne(c, e, sandboxHandle)`→`extractFromDiscussionEntry`→`extractViaCli` (as `options.sandboxHandle`), and release it once (`sandboxProviderRuntime().releaseLease(readString(acquisition.lease.provider), { providerLeaseId: readString(acquisition.lease.providerLeaseId), leaseMetadata: readObject(readObject(acquisition.lease.metadata).providerMetadata), config: { ...providerConfig, reuseLease: false } })`) in a `finally` after the loop. On acquire failure, mark **every** selected entry the same failed-path as today (each entry's `extractFromDiscussionEntry` surfaces `sandbox_unavailable`) — the range-cap invariant (`rangeEndCap`) still holds because a failed entry caps the draft range before it.
   - Keep the existing `extractFromDiscussionEntry` retry loop (`:471`); `sandbox_unavailable` is treated as **non-retryable structural** (like `not_installed`), so it terminalizes to `extractionStatus:"failed"` + `emitExtractionFailureItem` (`extraction.ts:137`, notification preserved) — assert this in the failure test.
   - `DiscussionDetail.tsx`: add a `sandbox_unavailable` branch to `extractionFailureMessage` with the config-pointing copy (never "install the CLI").
6. Run both — expect PASS.
7. Commit: `feat(exec-isolation): run extraction in an ephemeral sandbox; one sandbox per batch, acquire outside the deadline; add sandbox_unavailable class (U13.3)`.

---

### Task: U13.4 — Budget preflight before spawn + `cost_events` emission

One-shot spawns must fail **before** sandbox spend when the company is over budget, and must record their model spend as a `cost_event`. `cost_events.agentId` is `NOT NULL` today (`packages/db/src/schema/cost_events.ts:14`) and one-shot extraction/compaction/readiness have no agent — make `agentId` nullable and add a dedicated company-scoped insert path.

**Files:**
- Modify: `packages/db/src/schema/cost_events.ts` (make `agentId` nullable — line 14)
- Generate: migration via `pnpm db:generate` (Drizzle only — never hand-write DDL; CLAUDE.md rule 1)
- Create: `server/src/services/one-shot-cli-budget.ts` (`preflightOneShotCliSpend`, `recordOneShotCliCost`)
- Modify: `server/src/services/one-shot-sandbox-cli.ts` (call preflight before `acquireExecutionContext`; record cost after)
- Create (test): `server/src/__tests__/one-shot-cli-budget.test.ts`
- Modify (test): `extraction-sandbox-batch.integration.test.ts` to assert a `cost_events` row lands

**Steps:**

1. Write the failing test `one-shot-cli-budget.test.ts`:
   - `preflightOneShotCliSpend(db, { companyId })` returns `{ allowed:false, reasonCode:"budget_exhausted" }` when the active company-scoped hard-stop policy's observed cents ≥ cap; `{ allowed:true }` otherwise. Reuse the exact query shape as `preflightCrewDispatch`/`getObservedCents` **company scope** (companyId-only `sum(cost_cents)` over the calendar-month window) — assert no per-agent condition is applied.
   - `runOneShotCliInSandbox` throws `OneShotSandboxError("sandbox_unavailable")` **without** calling `acquireExecutionContext` when preflight returns `allowed:false` (fail-before-spend). When a `sandboxHandle` is supplied (batch reuse), preflight still runs but skips the acquire step it would otherwise gate.
   - `recordOneShotCliCost(db, { companyId, provider, model, inputTokens, outputTokens, source })` inserts a `cost_events` row with `agentId:null`, `costCents = computeCostCents(provider, model, in, out)`, and `billingType` = the `source` (`"extraction" | "compaction" | "readiness"`), rolling up **company** `spentMonthlyCents` only (no agent update).
2. Run — expect FAIL.
3. Implement:
   - Schema: `agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" })` (drop `.notNull()` at line 14). Run `pnpm db:generate`; verify the only drift is the nullable-`agentId` migration.
   - `one-shot-cli-budget.ts`: `preflightOneShotCliSpend` (company hard-stop policy lookup + observed-cents check, copied from `crew-budget.ts` §2–3 but with **no** thread entry side-effect — it's headless); `recordOneShotCliCost` (direct `insert(costEvents)` with `agentId: null` + company rollup, bypassing `costService.createEvent`'s agent lookup).
   - Wire both into `runOneShotCliInSandbox`: preflight → (acquire, unless a `sandboxHandle` was supplied) → execute → on success `recordOneShotCliCost` (estimate tokens from the CLI's reported usage when available, else `computeCostCents` with `rateModelForCliTool`).
4. Run — expect PASS.
5. Commit: `feat(exec-isolation): budget-preflight one-shot CLI spawns and record cost_events (nullable agentId) (U13.4)`.

---

### Task: U13.5 — File-import stages the uploaded file as a file, not stdin

The file-import extraction sink (`extractFromRawText`, `extraction.ts:871`, called at `file-import.ts:189`) must deliver the uploaded file content **into the VM as a file** and point the CLI at it, not pipe it via stdin (spec §5/U13 behavior).

**Files:**
- Modify: `server/src/services/extraction.ts` (`extractFromRawText`, line 871)
- Modify: `server/src/services/extraction-cli.ts` (accept a `stagedFile` mode on `ExtractViaCliOptions`)
- Modify: `server/src/services/one-shot-sandbox-cli.ts` (stage-file branch — `files.write` before the command runs)
- Create (test): `server/src/__tests__/extraction-file-import-sandbox.test.ts`

**Steps:**

1. Write the failing test. On cloud, `extractFromRawText` should call the sandbox helper with a `stagedFile` (remote path under `/tmp`, content = the file text) and **not** `stdinContent`; assert the CLI `args` reference the staged path (content passed as a file argument), and assert the fake sandbox's `files.write` was invoked with the file content before `execute` (`commands.run`).
2. Run — expect FAIL.
3. Implement: add a `stagedFile` option to `ExtractViaCliOptions`; `extractFromRawText` sets it on cloud. In `one-shot-sandbox-cli.ts`, when `stagedFile` is present, `files.write(remotePath, content)` first (via the sandbox provider's file-staging path, same seam `execute` uses for `stdin`), then run the CLI with the file path (claude: `--system-prompt-file` stays the system prompt; the **user content** rides as the staged file read into the prompt). Pass `stdin: undefined` in this branch. Leave the desktop path unchanged.
4. Run — expect PASS.
5. Commit: `feat(exec-isolation): stage file-import content as a VM file, not stdin (U13.5)`.

---

### Task: U13.6 — Commander compaction (`summarizeViaCli`) through the sandbox + founder notification on failure

`summarizeViaCli` fails closed on cloud (`cli-summarizer.ts:27`); its sole caller `agent-loop.ts` silently skips compaction on any throw (R3 silent-degrade). Route it through the sandbox helper and raise a founder notification when compaction fails on cloud.

**Files:**
- Modify: `server/src/services/internal-agent/cli-summarizer.ts` (remove the hard cloud throw at `:27`; route to `runOneShotCliInSandbox`)
- Modify: `server/src/services/internal-agent/agent-loop.ts` (on compaction failure, emit a `notifications` row)
- Create (test): `server/src/__tests__/cli-summarizer-sandbox.test.ts`
- Modify (test): `server/src/__tests__/commander-degradation.test.ts` (assert the notification is raised)

**Steps:**

1. Write the failing test `cli-summarizer-sandbox.test.ts`: on cloud with a resolved company credential, `summarizeViaCli` returns the sandbox stdout summary (spy `runOneShotCliInSandbox`), env free of operator creds (`CLAUDE_CODE_OAUTH_TOKEN` absent, company key present under its `envName`). On sandbox failure it throws. `summarizeViaCli` must accept `db` + `companyId` (needed for `resolveCompanyProviderCredential`) — thread them from the caller.
2. Write the failing assertion in `commander-degradation.test.ts`: when compaction throws on cloud, `agent-loop` inserts one `notifications` row (founder-visible "Commander could not compact this conversation…") — proving R3's silent degrade is fixed. Assert the run still continues (compaction is best-effort; only the surface is added).
3. Run — expect FAIL.
4. Implement: `summarizeViaCli` — delete the `tenantIsolationEnforced()` throw (`:27–31`); add `db`/`companyId` to `SummarizeArgs`; on cloud build `command/args` (claude `-p …`/codex `exec`) and call `runOneShotCliInSandbox({ db, companyId, cliTool: args.cliTool, command, args: argv, stdinContent: prompt, timeoutMs })`; on desktop keep the existing local spawn (`:57–83`). In `agent-loop.ts`, wrap the compaction call so a throw on cloud (`tenantIsolationEnforced()`) emits a founder `notifications` row before falling through to "skip compaction this turn" (never fail the Commander run).
5. Run — expect PASS.
6. Commit: `feat(exec-isolation): run Commander compaction in a sandbox; notify founder on compaction failure (U13.6, R3)`.

---

### Task: U13.7 — Readiness probes: restore BYO-key verify on cloud via the sandbox

The three `adapter.testEnvironment` probes (`agents.ts`, `providers.ts`, `commander-verify.ts`) short-circuit to `readiness_unavailable_on_cloud` under the D1 guard (`assertUnsandboxedMultitenantAllowed`). U13 restores them on cloud by running the probe generation inside the ephemeral sandbox with the company key — the onboarding BYO-key verify we made launch-critical.

**Files:**
- Modify: `server/src/routes/agents.ts` (test-environment route — the `assertUnsandboxedMultitenantAllowed` short-circuit)
- Modify: `server/src/routes/providers.ts` (`POST /:providerId/test`)
- Modify: `server/src/routes/commander-verify.ts` (~line 68 guard block)
- Create: `server/src/services/sandbox-readiness-probe.ts` (`probeReadinessInSandbox` — runs the adapter's hello-probe command through `runOneShotCliInSandbox` and maps stdout/exit to the adapter's `EnvironmentTestResult` shape)
- Modify (test): `server/src/__tests__/adapter-probe-cloud-guard.test.ts` (add cloud-with-key cases)
- Create (test): `server/src/__tests__/sandbox-readiness-probe.test.ts`

**Steps:**

1. Write the failing test `sandbox-readiness-probe.test.ts`: `probeReadinessInSandbox` with a resolved company key returns `{ status:"pass" }` when the sandboxed hello-probe exits 0; `{ status:"fail", checks:[{ code:"readiness_unavailable_on_cloud" }] }` only when no company key is configured (i.e. `resolveCompanyProviderCredential` throws `ProviderUnavailableError`, surfaced via `mapCloudProviderKeyError`) — not merely because cloud. Assert the sandbox env carries the company key and **no** operator creds.
2. Update `adapter-probe-cloud-guard.test.ts`: keep the existing "refuse without a key" behavior, but add a case per route — **cloud_auth WITH a resolved company provider key** now returns `200`/`verified` and **does** run the probe through the sandbox (spy `probeReadinessInSandbox` called; the old `assertUnsandboxedMultitenantAllowed` no-key path still returns `readiness_unavailable_on_cloud`). This encodes the "restore BYO-key verify" requirement.
3. Run — expect FAIL.
4. Implement: in each route, replace the unconditional cloud short-circuit with: if `tenantIsolationEnforced()`, attempt `resolveCompanyProviderCredential`; if a key resolves, run `probeReadinessInSandbox(...)` and return its classified result (providers.ts still calls `recordReadiness`; commander-verify still applies `redactChecks` + `classifyCommanderProbe` and the 200/422 split); if it throws `ProviderUnavailableError`, use `mapCloudProviderKeyError` to keep the existing `readiness_unavailable_on_cloud` blocking result with copy pointing at provider-key config. Preserve the `tryAcquireAdapterProbeSlot` concurrency gate and role checks. Never call `verifyAndBindCommanderSubscriptionCredential` on the shared pool (subscription is designed out on `aoa_hosted`, §14) — only bind the API-key outcome.
5. Run — expect PASS.
6. Commit: `feat(exec-isolation): run readiness probes in a sandbox to restore BYO-key verify on cloud (U13.7)`.

---

**Wave 3 exit criteria:**
- On `cloud_auth` with a fake sandbox provider mounted at the `importE2b` seam, an embedded-PG integration test proves: a discussion with N never-extracted entries yields extracted items via **one** `acquireExecutionContext` (per batch, not per entry) reused across entries via the `sandboxHandle` seam, the sandbox is acquired **before** the `EXTRACT_SCOPE_DEADLINE_MS` clock, and the `discussion→extract→scope-draft` path (Adjutant → `extractThreadEntriesAwait` → `extractFromDiscussionEntry`) no longer fails closed.
- A security unit test asserts the sandbox env for all three families is `buildSandboxEnvAllowlist(overlay, { provider })` output — excluding `DATABASE_URL`/`DIRECT_DATABASE_URL`, the secrets master key, `GITHUB_PAT`, `BETTER_AUTH_SECRET`/`AOA_AGENT_JWT_SECRET`, the embeddings `OPENAI_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and any host-ambient `ANTHROPIC_API_KEY` that is not the company's own key — and including **only** the company's resolved provider key. The caller-built overlay never contains the excluded keys, and the `buildScrubbedCliEnv` KEEP-list is gone from every sandbox path.
- Provider execution resolves config **the same way `executeRunLeaseCommand` does** (S6): reads `lease.provider` + `readObject(lease.metadata).providerMetadata`, resolves `resolveRuntimeProviderConfig`, and never calls `execute` with a hand-built lease shape or `config: undefined`.
- Over-budget companies fail **before** any `acquireExecutionContext` (`preflightOneShotCliSpend`), and every successful one-shot spawn records a company-scoped `cost_events` row (`agentId` nullable).
- Sandbox/broker failure preserves the existing entry-failed + `notifications` path, classified as `sandbox_unavailable`, with cloud guidance copy that points at provider-key/config (never "install the CLI").
- File-import stages content as a VM file (not stdin); Commander compaction runs on cloud and raises a founder notification on failure (R3); all three readiness probes return `verified` on cloud when a company key is configured.
- `pnpm --filter @armyofagents/db db:generate` shows no unintended drift beyond the nullable-`agentId` migration; typecheck + `brand-check` clean.

**PR-cut note:** Wave 3 is a natural PR-cut point per the spec's build order (§11 step 4) — U13 sits on the U4/U5/U12 seams and is the unit that "unblocks discussion→task on cloud, keeps Commander from overflowing, and restores BYO-key verify," independently reviewable from the U6 file-movement wave that follows.
