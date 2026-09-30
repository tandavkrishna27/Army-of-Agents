# PRT-003 Result — Job, Workload, and Lease Envelopes

**Status:** `complete`
**Date (UTC):** `2026-08-09`
**Epic:** `E1-worker-protocol`
**Plan task:** `Task 3: PRT-003 — Job, Workload, and Lease Envelopes`
**Implementer:** `PRT-003 implementer subagent (Claude)`
**Start SHA:** 0c6b499d2fc028792d4101ba02dcb8329a4645ce

The implementer leaves `Status` at `gate_review`. A separate reviewer completes the section below and is the only role that may change it to `complete`.

This file is a controlled append-only review ledger until `complete`; do not delete or rewrite prior review attempts. Once `complete`, it is frozen. Ticket commands are focused acceptance evidence, not the immutable epic D0 rollup.

## Delivered scope

- **`packages/worker-protocol/src/wire-safety.ts`** — recursive plaintext-credential containment plus the pure producer-side secret-canary scanner:
  - `FORBIDDEN_WIRE_KEYS` = the exact locked normalized set `["env","environment","apikey","password","token","accesstoken","refreshtoken","cookie","authorization","credential","credentials","secretvalue"]`.
  - `normalizeWireKey` = lowercase then strip every non-`[a-z0-9]` char (so `accessToken`/`access_token`/`Access-Token` all normalize to `accesstoken`). Matching is **whole-normalized-key equality** against the set, never substring — so `policyHash`, `secretHandleIds`, and `myToken` are NOT flagged.
  - `findForbiddenWireKeys(value)` recurses plain objects (keys sorted for determinism) + arrays, returns dotted paths with numeric array indices (`rows.0.password`). `addForbiddenWireKeyIssues(value, ctx)` adds a `z.ZodIssueCode.custom` issue at each offending segment path.
  - `visitWireStrings(value, visit)` (pure recursive string visitor), `registerSecretCanaries` / `clearRegisteredSecretCanaries` / `getRegisteredSecretCanaries` (empty strings never registered), `findSecretCanaryStringMatches(value, canaries?)` (sorted dotted paths of every string that contains a registered/supplied canary substring).
  - Dependency-free **seeded deterministic generator**: `createSeededRng(seed)` (mulberry32) + `generateWireStringSample(rng, embedCanary?)` producing nested structures spanning argv, URLs, headers, nested arrays, and an extensions container; with `embedCanary` it splices the canary into exactly one string leaf and returns its dotted path.
- **`packages/worker-protocol/src/source.ts`** — typed principals + the strict `ExecutionSourceV1` discriminated union:
  - `PRINCIPAL_TYPES` = `["user","agent","service","system"]`; `principalV1Schema` = strict `{ principalType, principalId }` over the opaque byte-preserving `principalIdSchema`.
  - Strict variants `task_run` (runId/issueId/requestedBy/executionPrincipal/assigneeAgentId), `commander_turn`, `crew_run`, `one_shot` (`operationKind` ∈ `extraction|compaction|readiness_probe`), `browser_request` (nullable `parentJobId`), `service_reconcile` (positive `generation`). Only `task_run` declares `runId`/`issueId`; every other variant is `.strict()` and rejects them. Unknown source `kind` fails closed.
  - Union `.superRefine`: for `task_run`, `executionPrincipal.principalType` must be `agent` AND `String(executionPrincipal.principalId) === String(assigneeAgentId)` (byte-for-byte). Provenance only — requester authorization is the context-dependent JOB-001/JOB-010 check, not a claim of this schema.
- **`packages/worker-protocol/src/job.ts`** — strict V1 job/workload/lease envelopes:
  - Locked placement enums (`TARGET_CLASSES`, `TARGET_SCOPES`, `TRUST_CLASSES`, `CREDENTIAL_KINDS`, `DATA_LOCALITIES`, `FALLBACK_MODES`) + the **explicit closed `PLACEMENT_MATRIX`** (per-target-class `targetScope`/`trustClass`/`credentials`/`localities`) + `isTargetPlacementAllowed(...)` — row membership, never ordinal comparison.
  - Bounded namespaced extension container `wireExtensionSchema` `{ namespace, schemaVersion, critical, value }` (strict) + `KNOWN_CRITICAL_EXTENSION_NAMESPACES` (empty in V1 → every `critical:true` fails closed). All exact limits enforced: ≤16 extensions, namespace lowercase reverse-DNS `+/name` ≤100 UTF-8 bytes, `schemaVersion` 1–1,000,000, value ≤8 container levels / ≤128 array items / ≤64 object keys / ≤100 UTF-8 bytes-per-key / ≤16,384 RFC-8785-canonical UTF-8 bytes, combined ≤65,536 bytes. **Byte counts are taken after UTF-8 encoding** (`TextEncoder`), never JS code-unit length.
  - One canonical `targetRequirementsV1Schema` embedded in `placementV1Schema` and every job envelope; mandatory `providerConstraints { profileId, version, digest }`.
  - Common strict schemas: `timestampV1Schema` (RFC3339 w/ offset), `adapterRefV1Schema`, `workspaceV1Schema` (base revision format keyed to algorithm: git_sha1→40-hex, else 64-hex), `resourceLimitsV1Schema`, `networkPolicyRefV1Schema`, `offlinePolicySchema`.
  - Three workload payloads (`batchWorkloadV1Schema`, `browserWorkloadV1Schema`, `serviceWorkloadV1Schema`) combined via `z.discriminatedUnion("workloadType", …)` into `jobEnvelopeV1Schema`, with the final `superRefine` (forbidden-key scan, extension bounds, `deadline > createdAt`, `notBefore ≤ deadline`, duplicate `requiredCapabilities`/`secretHandleIds`, and the full placement-matrix/owner/organization/fallback ruleset).
  - Strict lease payloads `leaseOfferV1Schema` (rejects `ackDeadline ≥ expiresAt` + forbidden keys), `leaseAckV1Schema`, `leaseRenewRequestV1Schema`, `leaseRenewResponseV1Schema` (server-selected `expiresAt` + `cancelRequested`/`cancelReason`), each carrying an optional bounded `extensions` field.
- **`packages/worker-protocol/src/index.ts`** — explicit named re-exports (`export { … }` for values, `export type { … }` for types; no `export *`) of the full wire-safety/source/job surface.

**Non-goals preserved (per plan).** No canonical-json/event/artifact/policy/capability/transport/error schemas (PRT-004…PRT-007). `usage`/pricing/charge fields are out of scope (PRT-004). `secretHandleIds` are OPAQUE handle IDs only (UUID-branded), never plaintext, and `secretHandleIds`→`secretHandles` (PRT-005) was NOT pre-empted. Runtime source imports only `zod` + relative modules and touches no Node API (`TextEncoder` is a standard global, already used by the approved `ids.ts`). No DB schema, route, scheduler, worker, provider SDK, browser, or UI. `Status` left at `gate_review`; `findings.md`/`decisions.md` untouched.

## Changed files

| File | Responsibility |
|---|---|
| `packages/worker-protocol/src/wire-safety.ts` | Recursive forbidden-key detection + Zod issue injection; pure string visitor; secret-canary registry/scanner; dependency-free seeded corpus generator. |
| `packages/worker-protocol/src/wire-safety.test.ts` | Forbidden-key recursion + normalization + determinism; canary registry/scan; the ≥10,000-case seeded corpus (every string inspected, benign clean, registered canary always found). |
| `packages/worker-protocol/src/source.ts` | Strict principal schema + strict `ExecutionSourceV1` discriminated union (six variants) + task executor/assignee equality refinement. |
| `packages/worker-protocol/src/source.test.ts` | Principal vocab/strictness; opaque-principal byte coverage; six-variant round-trips; task-only run/issue enforcement; executor/assignee mismatch denial; one-shot operation-kind lock; fail-closed unknowns. |
| `packages/worker-protocol/src/job.ts` | Placement matrix + `isTargetPlacementAllowed`; bounded extension container + local RFC-8785 byte sizer; common strict schemas; workload discriminated union + `superRefine`; strict lease payloads. |
| `packages/worker-protocol/src/job.test.ts` | Workload discrimination; timestamp/dedup; provider-constraint mandate; recursive forbidden-key containment; extension boundary±1 (count/namespace/schemaVersion/canonical-bytes/depth/items/keys/key-bytes/combined); placement-matrix accept/reject + fallback rules; workspace revision; lease messages. |
| `packages/worker-protocol/src/index.ts` | Explicit named re-exports of the new wire surface (values via `export { … }`, types via `export type { … }`). |
| `docs/replatform/epics/E1-worker-protocol/tickets/PRT-003-result.md` | This ticket result ledger. |

## Acceptance evidence

| Acceptance condition | Evidence | Result |
|---|---|---|
| The three PRT-003 modules fail RED before they exist | Step 3: `vitest run src/wire-safety.test.ts src/source.test.ts src/job.test.ts` exit 1 — 3 failed suites, `Cannot find module './wire-safety.js' / './source.js' / './job.js'`, "no tests" collected | `pass` |
| `findForbiddenWireKeys` finds credential keys recursively with sorted dotted paths incl. array indices; does not flag `secretHandleIds` | `wire-safety.test.ts` "wire safety" + "reports deterministic sorted dotted paths" green (`["future.apiKey","oauth.accessToken","oauth.refreshToken","rows.0.password"]`) | `pass` |
| Normalized forbidden set is EXACTLY the 12-member set; every spelling caught after normalization; only whole-key matches | `wire-safety.test.ts` "forbidden wire-key normalization" (locked-set equality, 12/12 spellings, whole-key-not-substring) green | `pass` |
| `addForbiddenWireKeyIssues` adds a `custom` issue at each offending path | `wire-safety.test.ts` "addForbiddenWireKeyIssues" (`code === custom`, paths `["oauth.accessToken","rows.0.password"]`) green | `pass` |
| Pure string visitor reaches every string; canary scanner finds a registered canary substring anywhere | `wire-safety.test.ts` "visitWireStrings" + "secret canary scanning" green | `pass` |
| **≥10,000-case producer secret-scan corpus**: every string inspected, benign samples clean (no canary, no forbidden key), registered canary always found | `wire-safety.test.ts` "inspects every string across ≥10,000 recursive cases" green — **SEED `20260809`, COUNT `10000`** (10,000 benign + 10,000 canary-tainted = 20,000 generated samples), canary `CANARY_a1b2c3d4e5f6_SECRETVALUE` | `pass` |
| Four wire principal types locked; strict principal object; `system` valid | `source.test.ts` "principal vocabulary" (`user|agent|service|system`, unknown `founder` rejected, unknown-key rejected) green | `pass` |
| Opaque principal IDs: accept Better-Auth text + UUID-shaped; reject empty/whitespace/edge-whitespace/>200-UTF-8-byte/non-string; 200/201 ASCII + `€`×66/67 boundary; no normalization; UUID brand ≠ PrincipalId substitution | `source.test.ts` "opaque principal identity" (5 tests) green | `pass` |
| Six source kinds locked; every variant round-trips with typed requester + execution principal; unknown kind fails closed | `source.test.ts` "execution source discriminated union" green | `pass` |
| Only `task_run` accepts/requires `runId`/`issueId`; fabricated run/issue on the other five fails (strict); executor must be an agent byte-equal to `assigneeAgentId`; mismatch denied | `source.test.ts` "task_run run/issue exclusivity and executor/assignee binding" (missing run/issue fail, 5×2 fabricated-field rejections, mismatch + non-agent denial) green | `pass` |
| one-shot operation kind exactly `extraction|compaction|readiness_probe`; unknown fails closed | `source.test.ts` "one_shot operation kinds" green | `pass` |
| Valid batch/browser/service envelopes parse; `batch`+browser payload fails; attempt 0 fails; unknown top-level key fails (strict) | `job.test.ts` "workload discrimination" green | `pass` |
| `deadline ≤ createdAt` fails; `notBefore > deadline` fails / interior `notBefore` ok; duplicate `requiredCapabilities`/`secretHandleIds` fail; `secretHandleIds` opaque-only | `job.test.ts` "timestamps and dedupe" green | `pass` |
| `providerConstraints` mandatory inside `targetRequirements` | `job.test.ts` "provider-constraint reference" green | `pass` |
| Nested `apiKey`/`env`/`cookie`/`accessToken`/`refreshToken` hidden in an extension value fails (recursive scan catches where arbitrary JSON is allowed) | `job.test.ts` "recursive forbidden-key containment" (5/5) green | `pass` |
| Safe non-critical extension accepted **and preserved** (`value` deep-equals input); unknown `critical:true` fails closed | `job.test.ts` "bounded namespaced extensions" first two cases green | `pass` |
| Extension boundary±1: count 16/17, namespace 100/101 bytes + shape, schemaVersion 1·1e6 / 0·1e6+1, canonical value 16,384/16,385 bytes, combined 65,010/66,010 bytes, depth 8/9, array 128/129, object keys 64/65, key bytes 100/101 | `job.test.ts` "bounded namespaced extensions" (9 boundary tests) green | `pass` |
| Placement is an explicit matrix (not ordinal): matrix exposed row-by-row; `isTargetPlacementAllowed` row membership; coherent single-target placements accept; invalid class/trust, owner-bound-without-owner-desktop, owner-without-owner, org-brokered-off-org, unknown enum, duplicate classes reject | `job.test.ts` "placement compatibility is an explicit matrix" (10 tests) green | `pass` |
| Fallback rules: forbidden+non-empty-order rejects; ordered class outside allowed rejects; ordered_explicit with non-transfer cred/locality rejects; duplicate ordered classes reject | `job.test.ts` "placement fallback rules" (4 tests) green | `pass` |
| Workspace base revision keyed to algorithm; null workspace accepted | `job.test.ts` "workspace base revision format" green | `pass` |
| Lease offer/ack/renew-request/renew-response share identity shape; `ackDeadline ≥ expiresAt` rejects; server-selected `expiresAt` + durable cancel state; forbidden keys + malformed identity reject | `job.test.ts` "lease messages" (6 tests) green | `pass` |
| Public surface exported via explicit named re-exports (no `export *`); typecheck + build clean; no test file in `dist` | `index.ts` explicit exports; `typecheck`/`build` exit 0; `dist/` has no `*.test.*` | `pass` |
| Runtime boundary stays GREEN (only `zod` + relative; no Node API in runtime source) | `pnpm check:worker-protocol-boundary` → `worker protocol boundary: PASS` exit 0 | `pass` |

## Commands

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm --filter @armyofagents/worker-protocol exec vitest run src/wire-safety.test.ts src/source.test.ts src/job.test.ts` (Step 3 — RED) | `1` | 3 failed suites — `Cannot find module './wire-safety.js' / './source.js' / './job.js'`; "no tests" collected |
| `pnpm --filter @armyofagents/worker-protocol exec vitest run src/wire-safety.test.ts src/source.test.ts src/job.test.ts` (Step 7 — GREEN) | `0` | Test Files 3 passed (3); Tests **80 passed** (15 wire-safety + 18 source + 47 job) |
| `pnpm --filter @armyofagents/worker-protocol typecheck` (Step 7) | `0` | `tsc --noEmit` clean |
| `pnpm --filter @armyofagents/worker-protocol build` (Step 7) | `0` | `tsc` emitted `dist/{ids,index,job,source,states,version,wire-safety}.{js,d.ts,*.map}`; no test file in `dist` |
| `pnpm check:worker-protocol-boundary` (Step 7) | `0` | `worker protocol boundary: PASS` |
| `pnpm --filter @armyofagents/worker-protocol exec vitest run` (full-package sanity) | `0` | Test Files 6 passed (6); Tests **111 passed** — existing ids/states/index unaffected by the `index.ts` change |

### E1-F004 revision re-run (fail-closed on non-canonicalizable extension values)

| Command | Exit code | Result summary |
|---|---:|---|
| `pnpm --filter @armyofagents/worker-protocol exec vitest run src/wire-safety.test.ts src/source.test.ts src/job.test.ts` | `0` | Test Files 3 passed (3); Tests **93 passed** (15 wire-safety + 18 source + **60 job**, +13 E1-F004) |
| `pnpm --filter @armyofagents/worker-protocol typecheck` | `0` | `tsc --noEmit` clean |
| `pnpm --filter @armyofagents/worker-protocol build` | `0` | `tsc` clean; no `*.test.*` in `dist/` |
| `pnpm check:worker-protocol-boundary` | `0` | `worker protocol boundary: PASS` |
| `pnpm --filter @armyofagents/worker-protocol exec vitest run` (full package) | `0` | Test Files 6 passed (6); Tests **124 passed** — no regression |

Out-of-subset extension values now FAIL `safeParse` (`success:false`) for both `jobEnvelopeV1Schema` and `leaseOfferV1Schema`: `1.5`, `9007199254740992` (2^53 unsafe int), `"\uD800"` (lone high surrogate), `"\uDC00"` (stray low surrogate), `{ rate: 0.25 }`, `[9007199254740992]`. The failing issue path points at `extensions.0.value`. A valid in-subset value (`{ n: 42, s: "ok", b: true, list: [1,2,3], nested: { deep: -0 } }`) still PASSES on both schemas.

### Source-kind vector coverage (freeze detail)

| Source kind | Valid vector | Invalid vectors proven |
|---|---|---|
| `task_run` | runId+issueId+user requester+agent executor byte-equal to `assigneeAgentId` | missing runId; missing issueId; executor ID ≠ assignee; executor `principalType:"user"`; unknown extra key |
| `commander_turn` | internalAgentRunId+conversationId | fabricated `runId`; fabricated `issueId` |
| `crew_run` | crewRunId | fabricated `runId`; fabricated `issueId`; unknown extra key; blank/oversized requester principalId |
| `one_shot` | operationId + each of `extraction|compaction|readiness_probe` | fabricated `runId`/`issueId`; unknown `operationKind:"summarize"` |
| `browser_request` | browserRequestId + nullable parentJobId | fabricated `runId`/`issueId` |
| `service_reconcile` | serviceId+generation+reconciliationId; `system` requester + `service` executor | fabricated `runId`/`issueId` |
| (union) | — | unknown `kind:"mystery_kind"`; empty object `{}` |

### Placement-matrix combinations exercised

- **Accepted** (via `jobEnvelopeV1Schema`): the plan's dual-target `{owner_desktop, managed_cloud}` fixture with `ordered_explicit` fallback; single-target `managed_cloud/shared_isolated/platform_brokered/transfer_allowed`; `owner_desktop/owner_local_trusted/owner_bound/owner_device_only` (non-null owner, forbidden fallback); `organization_dedicated/organization_isolated/organization_brokered/organization_target_only`.
- **Accepted** (via `isTargetPlacementAllowed` row check): the three matrix rows' representative tuples.
- **Rejected**: `managed_cloud`+`owner_local_trusted` trust; `managed_cloud`+`owner_bound`; `managed_cloud`+`owner_device_only`; `owner_bound` credential without an `owner_desktop` requirement; `owner_bound`/`owner_device_only` without a non-null owner; `organization_brokered` targeting `managed_cloud`; unknown enum `credentialKind:"mystery_cred"`; duplicate `allowedTargetClasses`; forbidden fallback with a non-empty order; ordered fallback class outside the allowed set; `ordered_explicit` with `owner_bound`/`owner_device_only` (non-transfer); duplicate ordered fallback classes. All decided by explicit matrix membership + coherence rules, never ordinal string comparison.

## Deviations

The plan's PRT-003 text and the normative hardening amendment are consistent; the notes below record where a mechanism had to be sited to satisfy both, for the reviewer.

1. **Local RFC-8785 canonical byte sizer in `job.ts` (ordering reconciliation).** The extension value budget (`≤16,384 RFC-8785-canonical UTF-8 bytes` per value, `≤65,536` combined) requires RFC-8785 canonicalization, but the shared `canonical-json.ts` is a **PRT-004** deliverable and is out of PRT-003 scope. To enforce the budget now without pre-empting PRT-004 or breaching the leaf-package boundary, `job.ts` contains a small self-contained, dependency-free canonical serializer used **only to size values**. It is intentionally not exported and does not create `canonical-json.ts`. It matches the frozen E0 authority (`scripts/check-distributed-execution-foundation.mjs`) byte-for-byte in BOTH directions: in-subset values serialize identically (sorted keys, RFC-8785 string escaping, integer formatting, `-0`→`"0"`), and the locked v1 subset is enforced fail-closed — floats, unsafe integers, and lone/broken UTF-16 surrogates throw and are rejected as "not canonicalizable" (E1-F004 fix; the amendment names these as must-not-diverge). PRT-004 may later unify these; the byte semantics (post-UTF-8, not code-unit) already match the amendment.
2. **Wire principal vocabulary vs FND-007 domain-role vocabulary.** The context-free wire `principalType` is the amendment's coarse `user|agent|service|system` (plan lines 75/815). The FND-007 authority (`distributed-execution-legacy-parity.json`) declares per-kind **domain** requester/executor roles (`founder`/`team_lead`/`worker`/`sandbox`/`browser_worker`/`service_instance`/…) used by the E0 golden-journey checker. These are different layers, not a contradiction: the amendment (lines 76/828) explicitly assigns requester-authorization + domain-role equality to **JOB-001/JOB-010**, not to this schema. This ledger records the handoff; no domain-role validation is claimed by the wire schema.
3. **Optional bounded `extensions` on lease messages.** The amendment's exact lease field lists (plan lines 869–872) omit `extensions`, but Step 6 prose ("Create strict V1 schemas with the explicit bounded `extensions` field where safe additions are permitted") and the ticket brief require it. Resolved by adding an **optional** `extensions: z.array(wireExtensionSchema).optional()` to all four lease payloads — a lease with no extensions matches the exact field list, and a lease carrying bounded extensions matches "where safe". When present it runs the same bounded-extension refinement.
4. **Extra locked-vocabulary exports.** `TARGET_SCOPES`/`targetScopeSchema` are exported as the amendment's locked target-scope vocabulary even though scope is derived from target class via the matrix (no standalone wire field). The individual source-variant schemas, the three workload schemas, `PLACEMENT_MATRIX`, `isTargetPlacementAllowed`, and `KNOWN_CRITICAL_EXTENSION_NAMESPACES` are also exported so consumers and the reviewer can inspect the closed matrix and reuse the canonical shapes. No wire shape is widened.

## Findings

**E1-F004 (addressed in this revision).** The independent reviewer (attempt 1, `changes_requested`) proved that the local RFC-8785 byte sizer in `job.ts` FAILED OPEN on out-of-subset extension values: `jobEnvelopeV1Schema.safeParse` (and `leaseOfferV1Schema` via its nested job) returned `success:true` for extension `value`s the frozen E0 authority (`scripts/check-distributed-execution-foundation.mjs` `canonicalizeNumber`/`canonicalizeString`) REJECTS — floats (`1.5`, `{rate:0.25}`), unsafe integers (`9007199254740992`, also miscounting their bytes), and lone/broken UTF-16 surrogates (`"\uD800"`, `"\uDC00"`). That is a fail-open byte-budget bypass at a `.strict()` security-critical envelope, and the amendment (implementation-plan.md line ~97) names lone surrogates + the unsafe-integer boundary as must-not-diverge. **Fix in this revision:** `job.ts`'s `canonicalJson`/`canonicalString` now match the E0 authority byte-for-byte in the reject direction — numbers throw on `!Number.isInteger` and `!Number.isSafeInteger` (`-0`→`"0"` kept); strings throw on a lone high surrogate (not followed by a low) and on a stray low surrogate. The existing `addExtensionArrayIssues` try/catch converts the throw into a fail-closed "not canonicalizable" `custom` ZodIssue at the extension value path, so those values now fail `safeParse` for BOTH `jobEnvelopeV1Schema` and `leaseOfferV1Schema`. In-subset behavior is unchanged (the reviewer confirmed 23/23 byte-identical). Only `job.ts` (the sizer), `job.test.ts` (13 new assertions: 6 out-of-subset × job + lease-offer, plus an in-subset regression), and this ledger changed. See [E1-F004](../findings.md).

## Follow-up tickets

None. PRT-004 (sequenced worker events + cumulative ACK) is the next Epic E1 ticket and is out of scope here; it introduces the shared `canonical-json.ts` that may later subsume the local extension byte sizer (Deviation 1).

## Gate recommendation

`ready for re-review` — the single required change from attempt 1 (E1-F004: the local `job.ts` extension byte-sizer failed OPEN on out-of-subset extension values) is applied in this revision. `canonicalJson`/`canonicalString` now reject floats, unsafe integers, and lone/broken UTF-16 surrogates, matching the frozen E0 authority; those values fail `safeParse` for both `jobEnvelopeV1Schema` and `leaseOfferV1Schema` while in-subset values still pass. All four focused commands re-run at exit 0 (tests **93/93**, typecheck clean, build with no test file in `dist`, boundary PASS); the full package suite is **124/124**. Only `job.ts` (sizer) + `job.test.ts` (+13 assertions) + this ledger changed since the reviewed revision; every other adversarial the reviewer verified (placement matrix, wire-safety, source union, extension boundaries, leases, explicit index exports) is unchanged.

(The original first-submission recommendation was `ready for independent review`: RED captured at Step 3 (exit 1, 3 suites, no tests collected); the four Step-7 commands at exit 0 (tests 80/80, full 111/111). Scope was the six new PRT-003 files plus explicit `index.ts` re-exports; `secretHandleIds`→`secretHandles` (PRT-005) not pre-empted; no hosted-API/Node runtime dependency introduced.)

## Independent review

**Reviewer:** `PRT-003 independent reviewer subagent (Claude)`
**Reviewed revision:** `e62921b1743f9cbc33e6ecf79348a7f4bf5d5483`
**Disposition:** `approved`
**Review evidence:**

**Attempt 2 (`approved`) — re-review of the E1-F004 fix at reviewed revision `e62921b1743f9cbc33e6ecf79348a7f4bf5d5483`** (child of attempt-1's `changes_requested` commit `e9a432150`; `git rev-parse HEAD` confirmed):

- **Fix inspection.** `git diff e9a432150 e62921b17 --stat` touches ONLY `job.ts` (+26), `job.test.ts` (+43), and this ledger — `source.ts`/`wire-safety.ts`/`states.ts`/`ids.ts` and every other test are untouched, so attempt-1's 33/33 adversarial verification (placement matrix, wire-safety, source union, all boundaries, leases, explicit index exports) still holds unchanged. The `job.ts` change makes `canonicalString` throw on a lone high surrogate (not followed by a low) and on a stray low surrogate, and `canonicalJson` throw on `!Number.isInteger` (float) and `!Number.isSafeInteger` — byte-for-byte the E0 authority's `canonicalizeString`/`canonicalizeNumber` reject behavior; the existing `addExtensionArrayIssues` try/catch converts the throw into a fail-closed "not canonicalizable" `custom` issue at the extension value path.
- **Re-run (reviewed revision, tree clean):** focused `vitest run wire-safety/source/job` → exit `0`, **93 passed** (15 + 18 + **60 job**, +13 E1-F004); full `test:run` → exit `0`, **124 passed** (6 files, no regression); `typecheck` → `0`; `build` → `0` (no `*.test.*` in `dist/`); `pnpm check:worker-protocol-boundary` → `PASS` exit `0`; `git diff --check` clean.
- **Out-of-subset now REJECTED (independent cross-check vs E0 `canonicalizeJson`, 52/52 probe assertions green).** For each of `1.5`, `9007199254740992` (2⁵³ unsafe int), `"\uD800"` (lone high surrogate), `"\uDC00"` (stray low surrogate), `{ rate: 0.25 }`, `[9007199254740992]`: E0 rejects it, and `jobEnvelopeV1Schema.safeParse` **and** `leaseOfferV1Schema.safeParse` now return `success:false` — verified for the bad value both in a lease's nested job AND in the lease's own `extensions`, with the failing issue path at the extension `value`. The former fail-open gap is closed.
- **No over-rejection / no regression.** In-subset extension values still PASS (`null`, booleans, integers incl. the largest safe integer `2⁵³−1`, `-0`, ASCII, multibyte `é`, **valid astral emoji pairs** — not falsely flagged as lone surrogates, nested object/array). In-subset canonical output still agrees with E0 **byte-for-byte** (23-case battery, 0 divergences), and the value-budget boundary is still 16,384 pass / 16,385 fail for ASCII and multibyte (`é`).
- **E1-F004 resolved** at this revision; marked resolved in [findings.md](../findings.md). The long-term unification of the local sizer onto PRT-004's shared `canonical-json.ts` is recorded there as a separate **non-blocking** follow-up so the package ultimately carries a single canonicalizer.

---

**Attempt 1 (`changes_requested`, reviewed revision `d381a3a46f16f5ef05c26a0b8101be63509f927a`) evidence — preserved:**

*Re-run on the reviewed revision (`git rev-parse HEAD` = `d381a3a46f16f5ef05c26a0b8101be63509f927a`; working tree clean):*
- `vitest run src/wire-safety.test.ts src/source.test.ts src/job.test.ts` → exit `0`, **80 passed** (15 wire-safety + 18 source + 47 job).
- `test:run` (full package) → exit `0`, **111 passed** (6 files).
- `typecheck` → exit `0`; `build` → exit `0` (no `*.test.*` in `dist/`); `pnpm check:worker-protocol-boundary` → `PASS` exit `0`.
- `git diff --check` → clean exit `0`; `git status --porcelain` → empty (before this doc change).
- Changed-files (8), test counts (80/111), and the canary seed/count (`20260809` / `10000`, 20,000 samples) in the self-report all match the diff and a re-run.

*CONCERN #1 — canonicalizer cross-check (the single defect; see finding [E1-F004](../findings.md)):* Independently imported the E0 authority `canonicalizeJson` (`scripts/check-distributed-execution-foundation.mjs`) and drove the **built** `jobEnvelopeV1Schema`. **In-subset: 23/23 cases byte-for-byte identical** canonical strings + byte counts (nested objects/arrays, multibyte `é`/astral emoji, combining NFD, all control-char escapes, integers, `-0`, booleans, `null`, key-ordering, unicode keys); real-schema value-budget boundary matches E0's count exactly at 16,384 pass / 16,385 fail for ASCII **and** multibyte. **Out-of-subset DIVERGES on accept/reject:** E0 rejects floats, unsafe integers, and lone/broken surrogates; the local `canonicalJson` accepts all of them, and `jobEnvelopeV1Schema.safeParse` returns `success:true` for extension values `1.5`, `9007199254740992`, `"\uD800"`, `{rate:0.25}`, `[9007199254740992]` — every one non-canonicalizable per the frozen E0/RFC-8785 authority (amendment line 97 names lone surrogates + unsafe-integer boundary as must-not-diverge). Divergence also propagates through `leaseOfferV1Schema` (nested-job float extension accepted). Unsafe integers additionally **miscount** (`9007199254740995` → `"9007199254740996"`). This is verdict (b): a real fail-open defect at a `.strict()` security envelope → `changes_requested`. **Required fix (PRT-003 scope, no PRT-004 pre-emption):** make non-integer numbers, non-safe integers, and lone/broken surrogate strings in an extension value **fail closed** (match E0's `canonicalizeNumber`/`canonicalizeString` reject behavior) + add float/unsafe-int/lone-surrogate rejection tests.

*Everything else verified security-correct (independent probes, 33/33 adversarial checks green):*
- **Extension boundary±1:** count 16/17; schemaVersion 1·1e6 / 0·1e6+1; depth 8/9; array 128/129; object keys 64/65; per-key **byte** boundary 100/101 via `é` (byte-not-code-unit); per-value canonical 16,384/16,385; **combined exact 65,536 pass / 65,537 fail** (self-report tested 65,010/66,010 — I confirmed the exact ±1 boundary); unknown `critical:true` fails closed; safe `critical:false` value preserved deep-equal.
- **wire-safety:** forbidden set is exactly the 12 members; `secretHandleIds`/`policyHash`/`secretHandles` (PRT-005 name) NOT flagged; deterministic sorted dotted paths incl. array indices + deep nesting; a forbidden key **deeply nested inside an extension value** (`{a:{b:[{cookie}]}}`), plus `authorization` and `secret_value`, are caught by the job superRefine; canary corpus re-run with a **different seed (424242)** still inspects every string and always catches the canary with benign samples clean.
- **source union:** `task_run` requires runId+issueId and an `agent` executor byte-equal to `assigneeAgentId` (mismatch + non-agent rejected); the other five strict-reject fabricated `runId`/`issueId`; unknown `kind` and unknown `operationKind` fail closed; opaque principal rejects blank/whitespace/edge-whitespace/>200-UTF-8-byte and preserves bytes (200/201 ASCII + `€`×66/67).
- **placement matrix:** explicit row membership only — grep confirms no `<`/`>`/`localeCompare`/index ordinal comparison in the class/trust/credential/locality logic (`.includes()`/`===`/Set). Adversarials beyond the implementer's list all fail closed: `managed_cloud`+`organization_brokered`; `owner_desktop`+`organization_target_only`; `organization_dedicated`+`owner_bound`; dual-target `owner_device_only` (invalid for `managed_cloud`); `owner_bound` with two target classes; superfluous trust class. owner/organization/ordered_explicit coherence rules confirmed.
- **lease + housekeeping:** `leaseOfferV1Schema` rejects `ackDeadline ≥ expiresAt` + forbidden keys (incl. nested in extension value); ACK/renew echo full identity; renew response carries server `expiresAt` + `cancelRequested`/`cancelReason`. `index.ts` uses explicit `export { … }` / `export type { … }` (no `export *`). Ledger conventions correct (bare Start SHA, backtick Status, distinct implementer/reviewer identity).

For `approved`, verify the result describes the reviewed revision, all focused acceptance evidence passes, and every accepted finding is resolved; then change the top-level `Status` to `complete` and commit this disposition separately. Otherwise leave `Status` as `gate_review` or set `blocked`, and link stable findings.

## Review attempt history

The implementation author leaves the table body empty; the explicit pending summary above is not a review attempt. The first independent reviewer appends attempt 1, and later reviewers append monotonically increasing rows without replacing prior attempts. The summary fields above mirror the latest real attempt for existing gate tooling. Do not include a `Review commit` column: a row cannot embed the SHA of the commit that first contains it. Repository history identifies that commit, and handoffs pin the resulting ticket-result blob SHA.

| Attempt | Reviewer | Reviewed revision | Disposition | Evidence/findings |
|---:|---|---|---|---|
| 1 | PRT-003 independent reviewer subagent (Claude) | `d381a3a46f16f5ef05c26a0b8101be63509f927a` | `changes_requested` | Re-run green (focused 80/80, full 111/111, typecheck/build/boundary exit 0, tree clean). Defect: local `job.ts` extension byte-sizer diverges from the E0 RFC-8785 authority — `jobEnvelopeV1Schema` accepts floats / unsafe integers / lone-surrogate strings in extension values (fail-open; non-canonicalizable per E0/amendment line 97; propagates through lease offers; unsafe ints miscount). In-subset 23/23 byte-identical; all other adversarials 33/33 green (boundary±1 incl. exact combined 65,536/65,537, wire-safety, source union, explicit-matrix placement with no ordinal comparison, leases, explicit index exports). See [E1-F004](../findings.md). Fix: reject non-integer/non-safe-integer numbers + lone/broken surrogates in extension values (match E0), add tests. |
| 2 | PRT-003 independent reviewer subagent (Claude) | `e62921b1743f9cbc33e6ecf79348a7f4bf5d5483` | `approved` | E1-F004 fix verified. Diff scope = only `job.ts` (+26) / `job.test.ts` (+43) / ledger; `source.ts`/`wire-safety.ts`/`states.ts`/`ids.ts` untouched → attempt-1's 33/33 adversarials still hold. `canonicalString`/`canonicalJson` now reject floats, unsafe integers, and lone/broken surrogates byte-for-byte with the E0 authority; independent cross-check (52/52 probe assertions) confirms `1.5`, `9007199254740992`, `"\uD800"`, `"\uDC00"`, `{rate:0.25}`, `[9007199254740992]` now return `success:false` on BOTH `jobEnvelopeV1Schema` and `leaseOfferV1Schema` (nested-job + own-extensions), issue path at the extension value. No over-rejection: in-subset still passes, valid astral emoji pairs pass, 23/23 in-subset byte-identical with E0, value-budget boundary still 16,384/16,385. Re-run exit 0 (focused 93/93, full 124/124, typecheck/build/boundary). [E1-F004](../findings.md) resolved. |
<!-- Later reviewers append attempt 3, 4, … monotonically. -->
