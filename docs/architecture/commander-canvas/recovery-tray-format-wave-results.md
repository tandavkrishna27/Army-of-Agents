# Universe recovery, tray and format wave results

**Status:** B06 source boundary complete; integrated UI/UAT and external converter qualification remain in their scheduled consumer waves.

## Delivered scope

| Planned package | Delivered behavior | Remaining acceptance join |
|---|---|---|
| `E1.3/2` | Structured question/runtime/approval attempt state; exact-snapshot acknowledgement; newer edits survive; question/runtime source idempotency is mandatory; runtime nonce is read only at submit; approval uses local correlation with no invented idempotency/CAS | The five destination panels consume these adapters when E7.3/E2.4 mount their actual routes. Reload UAT remains a consumer test. |
| `E1.4/1` | One stable tray menu owner; scope changes dismiss stale menus; auto-hide waits for pointer leave after a manual collapse; keyboard/click behavior remains explicit | Panel overview and Commander presentation continue in B07. |
| `E4.2/1` | Explicit extension capability registry; executable formats denied; unsupported formats remain download-only; ArtifactPanel resolves only authorized asset content URLs and always retains original download when preview fails | Real converter builds, media codecs and fixture qualification are not claimed. Processor/index work remains E4.2/2 in B13. |

## Recovery invariants

- A work-question or runtime-decision attempt retains one source-supported idempotency key for its frozen payload.
- Runtime nonces and credentials are never persisted in a draft. The adapter re-reads the canonical nonce and rejects a changed source revision.
- Approval submission maps only to the existing approve/reject routes. A timeout is unknown until the canonical approval is observed; there is no automatic repost.
- Canonical acknowledgement clears an answer only when revision and payload still equal the sent snapshot. A later edit is retained.

## Format truth boundary

The registry reports what the current source can actually do. Native viewers may be ready; named but unqualified converters carry no build identity and remain unavailable. Ordinary unknown formats are downloadable, and executable formats are denied. This wave does not turn a documentary converter name into runtime evidence.

## Verification

- UI focused suites: **43/43 passed** across ArtifactPanel, structured recovery/adapters, tray state/component and Universe page behavior.
- Server focused suites: **16/16 passed** across the format matrix and existing XLSX/XSS renderer boundaries.
- Recursive workspace typecheck: **passed**.
- Production build: **passed**. Vite reported the existing large-chunk/dynamic-import warnings but produced the complete build.
- Full `pnpm test:run`: **18,123 passed, 98 skipped and 175 failed** across 18,396 tests. This is not a green repository certificate. The failures match the recorded Windows Node 24 Drizzle `require(esm)` cycle and pre-existing unfinished worker/session/placement contracts; all new B06 focused suites pass independently.

No deployment or provider/worker qualification is part of this wave.
