# PRT-007 Result — Transport, Control, Error, and Frozen Cross-version Contract

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E1-worker-protocol`
**Plan task:** `Task 7: PRT-007 — Transport, Control, Error, and Frozen Cross-version Contract`
**Implementer:** `PRT-007 implementer subagent (Claude)`
**Start SHA:** 279d46abb83804d5b753b02954b2fa73a1a35fd7
**BASELINE_SOURCE_SHA:** b7a842870ce7509d8baa75409e0ab19da375c88a

The implementer leaves `Status` at `gate_review`. A separate reviewer completes the Independent review section and is the only role that may change it to `complete`.

PRT-007 is a reviewed TWO-COMMIT sequence; neither commit alone completes the ticket:
1. **Source commit** `feat: define worker protocol transport contract` = `BASELINE_SOURCE_SHA` above (the complete v1 transport/control/error surface).
2. **Freeze commit** `test: freeze worker protocol v1 baseline` (the independent hash-pinned frozen consumer + the bidirectional `cross-version.test.ts` + final manifests + this result).

`HEAD` equalled `BASELINE_SOURCE_SHA` throughout the freeze, and `git diff --exit-code b7a842870ce7509d8baa75409e0ab19da375c88a -- packages/worker-protocol/src` was clean after the freeze (no runtime source changed between the source commit and the freeze).

## Delivered scope

- **`transport.ts`** — framework-neutral operation request/response wrappers that NEST the strict PRT-003/004/005 domain payloads (a bare payload is never an authenticated request). Ten operations: `enrollment`, `poll` (offer | no_work | drain), `lease_ack`, `lease_renew` (renewed body echoes the renewal identity), `event_upload` (returns the cumulative `WorkerEventAckV1`), `artifact_transfer_grant` (upload_granted | download_granted | rejected, CLOSED pairing via `isTransferGrantResponsePairedV1`), `artifact_commit` (committed | rejected — never auto-converts to quarantine), `quarantine_grant` (device_session; quarantine_upload_granted | rejected), `quarantine_finalize` (quarantined(receipt) | rejected), and `control_command`. Every request carries `protocolVersion`, correlationId, a bound audience literal, an anti-replay `issuedAt` + `nonce`, and (mutating) an `idempotencyKey`; responses carry `serverTime` and `retryAfterMs` where a retry is meaningful. Payload ceilings, client timeouts, retry rules, and stable errors are contract facts in `OPERATION_DESCRIPTORS` + `operations.md`, not wire fields.
- **Control channel** — `ControlCommandV1` = cancel | product_approval_result | runtime_decision_result | checkpoint | graceful_stop | drain (audience `control_channel`, not worker-creatable), plus `ControlCommandAckV1` (accepted | completed | rejected | stale; unknown status fails closed).
- **Product approvals vs runtime decisions are SEPARATE, versioned, idempotent, and NOT conflatable.** `productApprovalResultV1Schema` binds a durable approvalId + kind/version + typed deciding principal + a specific `governedActionRef` — it cannot authorize a different governed action (`productApprovalAuthorizesActionV1`). `runtimeDecisionResultV1Schema` is a strict `permission | work_question` union: permission decision ∈ `allow_once | allow_run | allow_always | deny | expired | cancelled`; work_question outcome ∈ `answered | expired | cancelled` (answer required only for `answered`, bounded ≤16 KiB canonical, depth ≤8 via the shared `canonicalizeJsonV1`). `matchRuntimeDecisionResultToRequestV1` re-binds a result to its `runtime_decision_requested` request and FAILS CLOSED on missing request / cross-kind / requestId+nonce+digest+schemaVersion+sourceRevision+expiry+timeoutPolicy mismatch / late positive answer. A discriminated union + `.strict()` make the two controls unconflatable; the worker may REQUEST a runtime decision but never mints the authoritative result.
- **Pure receiver-decision functions** — `decideControlReceiverV1` (accept | replay | gap | conflict | stale) and `decideEventReceiverV1` (accept | replay | gap | hash_mismatch | stale_fence | terminal; recomputes the digest first, then applies fence/terminal/sequence/idempotency). Zod alone is not claimed to remember prior state.
- **`errors.ts`** — the stable CLOSED `ProtocolErrorV1` code set `malformed | unauthorized | incompatible_protocol | incompatible_capability | incompatible_policy | stale_fence | sequence_gap | target_revoked | event_hash_mismatch | throttled | payload_too_large | attempt_terminal | internal_unavailable`. Unknown code fails closed; only `throttled`/`internal_unavailable` carry `retryAfterMs`; detail is bounded, redaction-marked, credential-keys rejected recursively, and no code discloses foreign-tenant existence.
- **`operations.md`** — one row per operation (request, success/no-work response, audience, correlation/idempotency, retry rule, payload ceiling, client timeout, stable errors, redaction/existence, control ACK). The contract test proves the documented set equals the exported `WORKER_PROTOCOL_OPERATIONS` (no operation silently undocumented).
- **Frozen independent baseline** (`tests/fixtures/worker-protocol-consumers/v1/`) + **freeze/check scripts** + **bidirectional `cross-version.test.ts`** — see Freeze + Cross-version sections below.

Non-goals preserved: no HTTP method/path/status in the package; runtime source imports only `zod` + relative modules and uses `TextEncoder` (never `Buffer`/`node:*`); `index.ts` stays explicit named exports; `job.ts`/`artifacts.ts` payload schemas were REUSED (nested), not redefined.

## Changed files

| File | Responsibility |
|---|---|
| `packages/worker-protocol/src/transport.ts` | NEW — operation/control wrappers, product/runtime-decision results, receiver-decision functions, operation registry |
| `packages/worker-protocol/src/transport.test.ts` | NEW — 52 transport/control/receiver vectors |
| `packages/worker-protocol/src/errors.ts` | NEW — stable `ProtocolErrorV1` vocabulary + envelope |
| `packages/worker-protocol/src/errors.test.ts` | NEW — 14 error-code/envelope vectors |
| `packages/worker-protocol/src/cross-version.test.ts` | NEW (freeze commit) — bidirectional current↔frozen corpus |
| `packages/worker-protocol/src/contract.test.ts` | MODIFIED — routes the new operation/control/error conformance cases + operations.md coverage + multi-file manifest integrity |
| `packages/worker-protocol/src/index.ts` | MODIFIED — explicit named exports of the transport + errors surface |
| `docs/contracts/worker-protocol/v1/conformance.json` | MODIFIED — +26 transport/control/error cases (42 total) |
| `docs/contracts/worker-protocol/v1/operations.md` | NEW — the operation matrix |
| `docs/contracts/worker-protocol/v1/manifest.sha256` | MODIFIED — now pins conformance.json + operations.md |
| `scripts/freeze-worker-protocol-consumer.mjs` | NEW — deterministic one-way freeze |
| `scripts/check-frozen-worker-protocol-consumer.mjs` | NEW — independent recompute + smoke import |
| `scripts/check-frozen-worker-protocol-consumer.test.mjs` | NEW — mutation corpus (isolated temp copy) |
| `scripts/update-worker-protocol-contract-manifest.mjs` | MODIFIED — hash operations.md alongside conformance.json |
| `.gitattributes` | MODIFIED — LF pin for the frozen fixture (before freeze) |
| `.gitignore` | MODIFIED (freeze commit) — negation so the frozen `dist/` is tracked despite the global `dist/` ignore |
| `package.json` | MODIFIED — `freeze:worker-protocol-v1` + `check:frozen-worker-protocol-v1` |
| `tests/fixtures/worker-protocol-consumers/v1/**` | NEW (freeze commit) — hash-pinned frozen consumer |
| `docs/replatform/epics/E1-worker-protocol/tickets/PRT-007-result.md` | NEW — this ledger |

`job.ts` / `artifacts.ts` required NO modification: PRT-003/005 already used the canonical `…PayloadV1` / `…RequestV1` payload names, so transport nests them directly (no rename, no colliding public name). This is the one deviation from the plan's file list — see Deviations.

## Freeze — independent baseline

Frozen at `tests/fixtures/worker-protocol-consumers/v1/` from the reviewed source commit `b7a842870ce7509d8baa75409e0ab19da375c88a`, with `HEAD == BASELINE_SOURCE_SHA` and `git diff --exit-code b7a842870… -- packages/worker-protocol/src` CLEAN.

- **Bundled runtime:** `dist/index.js` = the built package index PLUS its exact **Zod 3.24.2** runtime, bundled by the locked root **esbuild 0.28.1** with fixed deterministic options (`bundle:true, format:"esm", platform:"neutral", target:"es2022", sourcemap:false, legalComments:"none", minify:false`), no banner/timestamp, relative paths only. Bundle size 239,198 bytes; `dist/index.js` SHA-256 `3c854028f3f1c0e7a792bda328515dc4c801e41bf0b0f3c3ee79a3ac7b7294e9`.
- **Determinism:** re-running the identical esbuild build produced BYTE-IDENTICAL output (a === b, same SHA-256) — confirmed against the frozen `dist/index.js` hash above.
- **Independence:** the frozen `dist/index.js` contains ZERO `import`/`export … from`/`require`/`import()` module specifiers (fully self-contained); the frozen `package.json` declares NO `dependencies`/`peer`/`optional` (no runtime dependency); no frozen file references `packages/worker-protocol/src`, an absolute path, a `sourceMappingURL`, or a test file.
- **Metadata + lock:** `dependency-lock.json` records `sourceSha b7a842870…`, `zodVersion 3.24.2`, `esbuildVersion 0.28.1`, `lockfileIntegrity 134169fe…`, `packageIntegrity 41acbb80…`, and the bundler options. The complete 15-file declaration tree is copied (sourceMappingURL stripped).
- **Manifest:** `manifest.sha256` pins 18 files (dependency-lock.json + 15 `.d.ts` + `dist/index.js` + `package.json`), sorted POSIX paths, excluding itself. The repo's global `dist/` ignore is negated for this fixture in `.gitignore` so all 19 fixture files (16 under `dist/` + package.json + dependency-lock.json + manifest.sha256) are tracked; verified `git ls-files` = 19 and the committed `dist/index.js` blob is LF (239,198 bytes).
- **Checker:** `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870…` independently recomputes every hash, validates the recorded SHA/versions/lock/bundler config, rejects runtime deps / current-source imports / absolute paths / test files / sourceMappingURL, and imports the frozen root in isolated **server** and **worker** smoke child processes → OK. The `.test.mjs` mutation corpus proves a mutated byte / dependency record / source SHA / bundlerOptions / version / path order / line ending / runtime dep / current-source import / absolute path / test file / current-source declaration each FAIL (12/12).

## Cross-version — bidirectional harness

`cross-version.test.ts` imports the CURRENT consumer (`./index.js`) and the FROZEN consumer (the bundled fixture) INDEPENDENTLY — distinct module instances, the frozen one carrying its own bundled Zod (asserted `frozen.jobEnvelopeV1Schema !== current.jobEnvelopeV1Schema`).

- **Result: `baseline_established`.** All 42 corpus cases reach the SAME verdict on BOTH consumers (current producer → frozen consumer AND frozen producer → current consumer), covering every execution-source/job combination, lease offer/ACK/renew, events + service events, artifacts, quarantine, secret/policy refs, registered target/worker capabilities, product approvals, runtime decisions, every control, and every error.
- Proven additionally: safe-optional-extension byte-semantic preservation on both; unknown-critical-extension rejection on both; unknown poll-outcome/control-kind/error-code rejection on both; renewal identity echo agreement; duplicate-ID+same-digest → `replay` and duplicate-ID+different-digest → `hash_mismatch`/`conflict` agreement across both receiver-decision functions; source independence; the frozen-consumer `manifest.sha256` byte-for-byte equals an independent recomputation; `dependency-lock.json.sourceSha` equals the `BASELINE_SOURCE_SHA` recorded in this result; and the contract manifest pins conformance.json + operations.md.
- 53 cross-version assertions green.

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| RED before GREEN | `transport.test.ts` + `errors.test.ts` failed with "Cannot find module ./transport.js" before implementation | `pass` |
| Ten operations, closed vocabularies | `transport.test.ts` locks `WORKER_PROTOCOL_OPERATIONS`, audiences, poll/grant/commit/control/receiver vocabularies | `pass` |
| Product vs runtime-decision separation, not conflatable | union + `.strict()`; a product payload in a runtime-decision command is rejected | `pass` |
| Unknown error/control/status fail closed | error code enum, control kind, control-ack status all reject unknowns | `pass` |
| operations.md documents exactly the exported operations | `contract.test.ts` operation-document coverage | `pass` |
| Frozen baseline independence / determinism / hashes | `check:frozen-worker-protocol-v1` OK + re-freeze byte-identical + `.test.mjs` 12/12 | `pass` |
| Bidirectional cross-version `baseline_established` | `cross-version.test.ts` 53/53 (42 corpus × both consumers + independence/manifest/baseline) | `pass` |
| No runtime source changed between source commit and freeze | `git diff --exit-code b7a842870… -- packages/worker-protocol/src` clean | `pass` |

## Commands

_Pre-freeze (Step 2/4):_

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm --filter @armyofagents/worker-protocol exec vitest run src/transport.test.ts src/errors.test.ts` (pre-impl) | `1` | RED — modules do not exist |
| `pnpm --filter @armyofagents/worker-protocol test:run` | `0` | 490 passed (16 files) |
| `pnpm --filter @armyofagents/worker-protocol typecheck` | `0` | clean |
| `pnpm --filter @armyofagents/worker-protocol build` | `0` | clean |
| `pnpm check:worker-protocol-boundary` | `0` | PASS |
| `pnpm check:distributed-foundation` | `0` | PASS |
| `node --test scripts/check-frozen-worker-protocol-consumer.test.mjs` | `0` | 12 passed |
| `node --test scripts/update-worker-protocol-contract-manifest.test.mjs` | `0` | 13 passed |

_Freeze (Step 5) — while `HEAD == BASELINE_SOURCE_SHA`:_

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm --filter @armyofagents/worker-protocol build` | `0` | tsc clean |
| `pnpm freeze:worker-protocol-v1 -- --source-sha b7a842870…` | `0` | froze baseline (zod 3.24.2, esbuild 0.28.1) |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870…` | `0` | OK |
| `git diff --exit-code b7a842870… -- packages/worker-protocol/src` | `0` | src unchanged after baseline |

_Full verify (Step 7):_

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm gen:worker-protocol-contract` | `0` | manifest byte-stable (no diff) |
| `pnpm --filter @armyofagents/worker-protocol test:run` | `0` | 543 passed (17 files, incl. cross-version 53) |
| `pnpm --filter @armyofagents/worker-protocol typecheck` | `0` | clean |
| `pnpm --filter @armyofagents/worker-protocol build` | `0` | clean |
| `pnpm check:worker-protocol-boundary` | `0` | PASS |
| `pnpm check:distributed-foundation` | `0` | PASS |
| `node --test scripts/check-frozen-worker-protocol-consumer.test.mjs` | `0` | 12 passed |
| `pnpm check:frozen-worker-protocol-v1 -- --source-sha b7a842870…` | `0` | OK |
| `git diff --check` | `0` | no whitespace errors |

## Deviations

`job.ts` and `artifacts.ts` are listed as Modify targets in the plan but required no change: PRT-003/005 already used the canonical payload schema names (`leaseAckV1Schema`, `leaseRenewRequestV1Schema`, `leaseRenewResponseV1Schema`, `artifactTransferGrantRequestV1Schema`, `artifactCommitPayloadV1Schema`, `quarantineGrantPayloadV1Schema`, `quarantineFinalizePayloadV1Schema`, `quarantineUploadReceiptV1Schema`), so the Step-2 rename was already satisfied and transport nests them directly. No colliding public name was created.

Manifest-generation reading: the plan's "extend manifest generation to hash conformance, operations, the frozen-consumer manifest, and the recorded baseline source revision" is realized by TWO coordinated generators — the contract manifest (`update-worker-protocol-contract-manifest.mjs`) hashes conformance.json + operations.md, and the frozen fixture's own `manifest.sha256` + `dependency-lock.json` pin the frozen-consumer bytes + the baseline source revision. `cross-version.test.ts` recomputes and binds all four; a manifest or source-independence mismatch fails the suite.

## Findings

State `None` or link stable IDs from `../findings.md`. (Implementer: `None` at draft; the reviewer records any.)

## Follow-up tickets

`None`.

## Gate recommendation

`ready for independent review`. The complete v1 transport/control/error surface is implemented via strict TDD (RED proven before GREEN), the independent frozen baseline is hash-pinned and byte-deterministic with no runtime dependency and no current-source import, and the bidirectional cross-version harness classifies the first freeze as `baseline_established`. All focused acceptance commands exit 0. The reviewer should confirm: (1) the source commit `b7a842870…` and the separate freeze commit together form the two-commit sequence; (2) the frozen bytes were generated by the freeze script, not hand-edited; (3) product-approval vs runtime-decision separation and the closed operation pairing hold; and (4) the two-generator reading of "manifest generation" (see Deviations) is acceptable.

## Independent review

**Reviewer:** `PRT-007 independent reviewer subagent (Claude)`
**Reviewed revision:** `c68053421ac53c5b49066b041c8fbcdd920dad62`
**Disposition:** `approved`
**Review evidence:**

Adversarial, independent re-verification on the reviewed revision (`git rev-parse HEAD` = `c68053421ac53c5b49066b041c8fbcdd920dad62`; working tree clean). Implementer tests were not trusted; every claim was reproduced or independently re-derived.

- **Full verify block — all exit 0, counts confirmed:** `gen:worker-protocol-contract` (byte-stable, `git status` empty after); `test:run` **543 passed / 17 files** (transport 52, errors 14, cross-version 53, contract 47); `typecheck`; `build`; `check:worker-protocol-boundary` PASS; `check:distributed-foundation` PASS; `node --test check-frozen-worker-protocol-consumer.test.mjs` **12/12**; `node --test update-worker-protocol-contract-manifest.test.mjs` **13/13**; `check:frozen-worker-protocol-v1 --source-sha b7a842870…` OK; `git diff --check` clean; `git status --porcelain` empty.
- **Frozen fixture crux (independent re-derivation):** (a) committed `dist/index.js` has **0** import/export-from/require/import() specifiers, no `sourceMappingURL`, no absolute/`file://`/drive paths, no `src` reference, 0 CR bytes; (b) frozen `package.json` declares no dependencies/peer/optional; (c) **DETERMINISM** — an independent re-bundle of the current built `dist/index.js` + zod with the same esbuild options produced SHA-256 `3c854028f3f1c0e7a792bda328515dc4c801e41bf0b0f3c3ee79a3ac7b7294e9`, **byte-identical** (239,198 bytes) to the committed frozen bundle and the recorded hash; (d) independent manifest recompute (sorted POSIX, excl. self, 18 files) is **byte-equal** to the committed `manifest.sha256`; (e) `dependency-lock.json.sourceSha` == `b7a842870…` == this ledger's `BASELINE_SOURCE_SHA`, records zod 3.24.2 + esbuild 0.28.1 + lockfile/package integrity matching the live repo.
- **Clone-safety (deviation #1):** all **19** fixture files git-tracked; `.gitignore` negation `!tests/fixtures/worker-protocol-consumers/v1/dist/**` present; committed `dist/index.js` blob is LF (0 CR); the **freeze commit tree** (`c68053421`) carries all 19 files incl. every `dist/*`, and `git archive` extracts the dist bytes.
- **Two-commit protocol:** runtime (non-test) `src` diff between `b7a842870` and `c68053421` is **empty**; the fixture and `cross-version.test.ts` are **absent** from the source commit and present only in the freeze commit; `BASELINE_SOURCE_SHA` is a bare 40-hex == `b7a842870…`. Neither commit alone completes the ticket.
- **Bidirectional cross-version:** the harness imports current and frozen as **distinct** instances (asserts `frozen.jobEnvelopeV1Schema !== current.jobEnvelopeV1Schema`), evaluates all 42 corpus cases on **both** consumers in both directions, and agrees on extension preservation, unknown critical-extension/poll-outcome/control-kind/error-code rejection, renewal-identity echo, and duplicate-ID replay/`hash_mismatch`/`conflict` — first freeze correctly classified **`baseline_established`** (53/53).
- **Product vs runtime-decision separation (independently probed against the built module, non-trivial positives + negatives in one run):** the discriminated `ControlCommandV1` **rejects** a product payload in a `runtime_decision_result` command and a runtime payload in a `product_approval_result` command while **accepting** each correct pairing; `productApprovalAuthorizesActionV1` authorizes exactly the bound governed action (rejects a different id/kind and any non-`approved` decision); `runtimeDecisionResultV1Schema` is a strict `permission | work_question` union (answer required only for `answered`, ≤16 KiB canonical / depth ≤8); `matchRuntimeDecisionResultToRequestV1` **fails closed** on missing request / cross-kind / nonce / requestDigest / schemaVersion / sourceRevision / expiresAt / timeoutPolicy mismatch / late positive answer.
- **Errors + operations.md:** exactly the **13** stable codes, closed, unknown fails closed; only `throttled`/`internal_unavailable` carry `retryAfterMs`; `.strict()` blocks existence side-channels and credential-bearing detail keys; `redaction: "secret"` required. `operations.md` has one row per operation and `contract.test.ts` enforces the documented set == exported `WORKER_PROTOCOL_OPERATIONS` (no duplicate, no undocumented operation) and pins both files in the manifest.
- **Deviation #4 verdict — ACCEPTABLE (not a defect):** the control-command **envelope**'s recursive credential-key scan reaches into opaque work-question answer content and rejects forbidden keys (`token`, `environment`, nested `apiKey` all rejected at the envelope; benign keys pass). This is consistent fail-closed secret containment matching PRT-004 event-option scanning and HARD invariant H-04; the narrow false-positive risk (an answer key literally `token`/`env`) resolves in the safe direction and is rephrasable. On the wire a runtime decision always travels inside a control command, so the scan always fires.
- **Housekeeping:** transport nests the existing PRT-003/004/005 payloads (no redefinition/colliding name); runtime source uses `TextEncoder` (no `Buffer`/`node:*`); runtime dependency is exactly `{"zod":"3.24.2"}`; `index.ts` uses explicit named exports (no real `export *`); ledger conventions correct (Status backtick, Start SHA + BASELINE_SOURCE_SHA bare, implementer identity, empty attempt table before this review).
- **Mutation corpus (spot-confirmed on isolated copies):** 12/12 synthetic cases fail on tamper; additionally, an independent adversarial test on a **copy of the real fixture** confirmed a mutated byte (`manifest.sha256 does not match`) and a mutated `sourceSha` are rejected while an untouched copy passes.

No accepted findings. `Status` set to `complete`.

## Review attempt history

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
<!-- First independent reviewer appends attempt 1. -->
| 1 | PRT-007 independent reviewer subagent (Claude) | `c68053421ac53c5b49066b041c8fbcdd920dad62` | `approved` | Full verify block all exit 0 (543 tests / 17 files; mutation 12/12; manifest 13/13; boundary + distributed PASS; frozen OK; gen byte-stable; git clean). Independent re-bundle SHA `3c854028…7294e9` byte-identical (239,198 B) to the committed frozen bundle; manifest recompute byte-equal; lock sourceSha == BASELINE_SOURCE_SHA (zod 3.24.2, esbuild 0.28.1). Clone-safety proven (19 tracked files, .gitignore negation, LF, freeze-commit tree carries dist). Two-commit protocol confirmed (runtime src diff empty; fixture + cross-version only in freeze). Bidirectional `baseline_established` (distinct instances, 53/53). Product/runtime separation + matcher fail-closed independently probed. 13 error codes closed; operations.md bijection enforced. Deviation #4 judged ACCEPTABLE (envelope-level fail-closed secret containment, H-04). No findings. |
