# E7-F011 — Networked staged-file wire route (design + plan)

**Epic:** E7 — Coding/CLI workload on E2B · **Owns:** closes **E7-F011** · **Plan node:** `#### CLI-008`
**Status:** `design` — approved, buildable · **Size:** S–M (2 source files + tests; no codec, no
worker-daemon, no frozen-vocabulary change) · Authored 2026-09-18 against `docs/replatform-program`.

> **For agentic workers:** implement with TDD. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the NETWORKED/container lane a worker→adapter-manager wire route for `stage_files`, so a
distributed E2B run can stage the control-plane's task-context input file into the sandbox before
execute. Today `NetworkedProviderDriver.stageFiles` throws `UnsupportedProviderOperation("stage_files")`
and `fileStagingMode="none"`, so **every distributed run that carries a staged input terminates
`stage_input_failed`** (proven live: E7-1 canary, artifact-transfer-grant returns 200, then the write
arm fails closed).

---

## 1. Background — the gap is PURELY the wire

Everything else in the staged-input pipeline already exists and is proven on the desktop lane:

- **CP producer** stages the object + commits the `job_artifacts` row and rides a `critical:false`
  staged-input pointer on the frozen envelope `extensions[]` (`server/src/services/job-input-staging.ts`).
- **Worker resolver** is lane-agnostic: `createStagedInputResolver` (`worker-daemon/src/lease/staged-input.ts`)
  reads the pointer and mints one `artifact_transfer_grant` download grant per file, producing
  `StagedFileRequest[] = { path, grant }`. Wired once into the supervisor regardless of lane
  (`dispatch-runtime.ts`).
- **Provider target** already works: `E2bSandboxProvider.stageFiles` (`sandbox-e2b-provider/src/e2b-provider.ts:707`,
  `fileStagingMode="grant_download"`) redeems each grant, verifies sha256 + maxBytes, then
  `transport.writeFiles` into the sandbox. The adapter-manager composition root already injects this
  provider (`adapter-manager/src/bin/adapter-manager.ts`).
- **Supervisor** calls `run.effect.stageFiles(created.sandboxId, staged, ctx)` provider-agnostically
  (`worker-daemon/src/supervisor/supervisor.ts:708`) and fails closed on a throw.

The only missing hop: on the networked lane `run.effect` is the `NetworkedProviderDriver`, whose
`stageFiles` has no wire route because `#post` is typed to the frozen `ProviderOperation` vocabulary
(`worker-protocol/src/capabilities.ts`), which **deliberately** excludes `stage_files`; and the AM
server (`adapter-manager/src/server.ts`) has no `stage_files` route.

## 2. Locked decisions this honors (do NOT relitigate)

- **Frozen wire vocabulary untouched (E4-D02).** `stage_files` MUST NOT be added to
  `PROVIDER_OPERATIONS`/`CORE_PROVIDER_OPERATIONS` (adding it reds 27 conformance tests by design). The
  driver's `#post` op type is widened LOCALLY to `ProviderOperation | "stage_files"`, mirroring the
  existing `DeclinableOperation` widening.
- **Bytes never cross the daemon (E4-D01).** The worker ships the download GRANT (a pointer/bearer
  capability), not bytes. The AM's provider redeems + verifies + writes. No codec change — `args` is
  opaque and the owned-labels capability already rides the envelope.
- **Fail-closed is correct (E7-F011).** The refusal-on-missing-context is intentional; the *missing
  route* is the defect. The supervisor's `stage_input_failed` terminal + cleanup escalation stays.
- **No worker-daemon change.** The networked driver lives in `provider-wire`, outside `worker-daemon`,
  so `check-worker-daemon-boundary` stays clean.

## 3. Design

### 3.1 Client — `packages/provider-wire/src/driver.ts`
- Widen `#post`'s `op` param: `op: ProviderOperation | "stage_files"`. Additive/local; every existing
  caller still passes a `ProviderOperation`.
- Implement `NetworkedProviderDriver.stageFiles(sandboxId, files, ctx)`:
  `return this.#post<StageFilesResult>("stage_files", { sandboxId, files }, ctx, this.#capability)`.
  (Two port params packed into one opaque `args` object, exactly as `execute` embeds `sandboxId` in
  `ExecuteInput`.)
- Flip `fileStagingMode` `"none" → "grant_download"` — **together** with the route (the supervisor
  stages whenever `staged.length > 0` and relies on `stageFiles` throwing when unsupported, so the mode
  and the route must ship as one change).

### 3.2 Server — `packages/adapter-manager/src/server.ts`
- Add `"stage_files"` to `GATE_REQUIRED_OPS`.
- Add a `routeGated` case for `stage_files`: destructure `{ sandboxId, files }` from `args`, then
  `gateOwnedOp(deps, sandboxId, ctx, capability, () => provider.stageFiles(sandboxId, files, ctx))`.
- **Gated-only** — do NOT add a keyless raw handler (leave it out of the `handlers` map). An ungated
  (Unit-A / not-deploy-safe) server 404s it, consistent with the B2 teardown ops, because it carries a
  bearer grant.

### 3.3 Security
- The `ArtifactDownloadGrantV1` becomes the first bearer capability to cross the worker→AM request
  body. It rides the same authenticated hop as the owned-labels capability today. The grant is
  `redaction:"secret"` and MUST NOT reach a log line, projection, or error. The AM's existing
  error-leak fence (`server.ts` `isModelledWireError` → generic `WireProtocolError`) already covers the
  response direction; `StageFilesResult` returns only paths.

## 4. Non-goals
- Sibling non-frozen ops (`export_artifact`, `digest_artifact`, the SVC-008a process trio) stay
  throwing. This unit only wires `stage_files` and establishes the pattern.
- No `capabilityProven` movement (that is Units C/D/F, gated behind their own work).

## 5. Implementation plan (TDD)
- [ ] **Task 1 — client driver.** Widen `#post` op type; implement `stageFiles`; flip
  `fileStagingMode`. Unit test: `NetworkedProviderDriver.stageFiles` POSTs `/op/stage_files` with
  `{sandboxId, files}` + capability, and returns the decoded `StageFilesResult`; `fileStagingMode` is
  `"grant_download"`. (`provider-wire/src/__tests__/`.)
- [ ] **Task 2 — server route.** Add `stage_files` to `GATE_REQUIRED_OPS` + the `routeGated` case.
  Component test (`adapter-manager/src/__tests__/component.test.ts` harness): a GATED server round-trips
  `NetworkedProviderDriver → server → provider.stageFiles` (mock provider) with a valid capability and
  returns `{stagedPaths}`; an UNGATED (keyless) server 404s `stage_files`; a wrong-owner capability is
  refused by `gateOwnedOp`.
- [ ] **Task 3 — end-to-end.** Extend/mirror `cli-008-unit-b-staging-channel.integration.test.ts` (or a
  new networked-lane test) so `NetworkedProviderDriver → server → E2bSandboxProvider(mock-transport).stageFiles`
  redeems the grant, verifies sha256, and `writeFiles`.
- [ ] **Task 4 — guards.** `check-frozen-worker-protocol-v1` (frozen vocab byte-identical),
  `check-worker-daemon-boundary`, deps-stage/manifest, test-inventory. Re-anchor any threat-register
  citations my line shifts move.

## 6. Acceptance criteria
- A distributed (networked) run with a staged input reaches `stage_files → success` and proceeds to
  execute; `pnpm verify:e7-1-distributed-run <runId>` advances past staging.
- `PROVIDER_OPERATIONS` / `CORE_PROVIDER_OPERATIONS` are byte-identical (frozen guard green).
- An ungated server still 404s `stage_files`; a foreign-owner capability is still refused.
- `check-worker-daemon-boundary` green (no worker-daemon → provider import introduced).
