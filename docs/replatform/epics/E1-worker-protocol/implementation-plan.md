# Cloud Control Plane Worker E1 Protocol Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a versioned, dependency-light worker wire-contract package that defines identities, distinct delivery/workload lifecycles, job/lease envelopes, sequenced events, artifact/quarantine/workspace/secret/network policies, registered-target capability negotiation, transport/control/error messages, and frozen cross-version conformance.

**Architecture:** `@armyofagents/worker-protocol` is a leaf workspace package shared by future control-plane and worker packages. Runtime source imports only Zod and local modules; it imports no Node APIs and no AoA server, database, adapter, UI, or shared package. Security-critical objects are strict; safe additive data travels only through bounded namespaced extensions. Unknown states, controls, errors, policy versions, and critical extensions fail closed.

**Tech Stack:** TypeScript 5.7, Zod 3.24, Vitest 3.2, Node.js 24 for tests/contract hashing only, pnpm 9.15.4, JSON conformance vectors.

## Global Constraints

- E0 must be complete on main before E1 begins.
- Canonical source design: `docs/replatform/program-design.md`, tickets PRT-001 through PRT-007.
- Canonical lifecycle values come from `docs/architecture/distributed-execution-lifecycles.json` and its Markdown peer; do not rename or add states without an E1 decision and Decision #121 update.
- Decisions #118/#119 govern enterprise-memory visibility. Protocol envelopes may carry authorized context artifact references, but never memory-table credentials, unscoped memory dumps, or a replacement memory-visibility model.
- The existing MCP OAuth broker owns connector discovery, refresh leases, token bundles, rotation, and revocation. Protocol envelopes carry opaque secret handles only and never OAuth access or refresh tokens.
- Protocol v1 supports `batch`, `browser_session`, and `service`; provider implementations remain out of scope.
- Every envelope includes Organization, Company, a discriminated execution source, job, attempt, and lease/fence identity as appropriate. `runId` and `issueId` are mandatory only for `task_run`; no workload fabricates them.
- Platform-managed secrets appear only as opaque handles; reserved credential-bearing keys are rejected recursively. This does not claim that arbitrary user-provided strings can never contain a secret. Every producer must scan all string values against registered secret canaries before persistence/dispatch.
- Unknown enum/state/control/error/policy values fail closed. Safe additions are bounded namespaced extensions with explicit `critical`/`mustUnderstand` behavior.
- Runtime source under `packages/worker-protocol/src/` excluding `*.test.ts` may import only `zod` and relative modules.
- Do not add database schemas, HTTP routes, schedulers, workers, provider SDKs, browser code, or UI.
- Package changes include `package.json` and regenerated `pnpm-lock.yaml` in the same commit.
- Every ticket writes `docs/replatform/epics/E1-worker-protocol/tickets/<TICKET-ID>-result.md` using the repository template.
- Every contract/integration campaign writes an immutable record under `docs/replatform/epics/E1-worker-protocol/qa/`.
- `docs/replatform/test-gates.md`, `accepted-caveats.md`, and `agent-execution-guide.md` are normative inputs.

---

## File responsibility map

| File | Responsibility |
|---|---|
| `packages/worker-protocol/src/ids.ts` | Branded UUID domain IDs, opaque principal IDs, attempt/sequence integers, fence token, SHA-256 digest. |
| `packages/worker-protocol/src/states.ts` | Workload/state constants and legal transition predicates. |
| `packages/worker-protocol/src/wire-safety.ts` | Recursive rejection of plaintext-credential-bearing keys. |
| `packages/worker-protocol/src/source.ts` | Typed principals and the strict discriminated execution-source provenance union. |
| `packages/worker-protocol/src/job.ts` | V1 workload-specific job and lease wire envelopes. |
| `packages/worker-protocol/src/canonical-json.ts` | Dependency-free RFC 8785 canonical JSON used to derive immutable event digest input. |
| `packages/worker-protocol/src/events.ts` | V1 event discriminated union, contiguous batches, cumulative ACK. |
| `packages/worker-protocol/src/artifacts.ts` | Workspace/artifact/patch manifests, upload grants, object-prefix fencing. |
| `packages/worker-protocol/src/policy.ts` | Resource, network, secret materialization, retention, and offline policy schemas. |
| `packages/worker-protocol/src/capabilities.ts` | Worker hello/capacity/capabilities and requirement matching. |
| `packages/worker-protocol/src/version.ts` | Current/minimum version constants and overlap negotiation. |
| `packages/worker-protocol/src/transport.ts` | Enrollment, poll/offer/no-work, renew, upload, command, command-ACK, correlation, retry, and anti-replay schemas. |
| `packages/worker-protocol/src/errors.ts` | Stable machine-readable protocol error codes and safe details. |
| `packages/worker-protocol/src/index.ts` | Explicit public exports only. |
| `docs/contracts/worker-protocol/v1/conformance.json` | Frozen valid/invalid producer-consumer vectors. |
| `tests/fixtures/worker-protocol-consumers/v1/` | Hash-pinned frozen complete-v1 baseline consumer, independent from current source and retained for future bidirectional compatibility tests. |
| `docs/contracts/worker-protocol/v1/manifest.sha256` | Exact contract byte hashes. |
| `scripts/check-worker-protocol-boundary.mjs` | Dependency/import/process-global boundary check for the always-on policy job. |
| `scripts/update-worker-protocol-contract-manifest.mjs` | Deterministically regenerates the hash manifest. |
| `vitest.config.ts` | Registers the package as a root Vitest project. |

## Approved protocol hardening amendment

This section is normative and replaces any conflicting passthrough, state, duplicate-event, secret, renewal, compatibility, or integration-gate instruction later in the plan.

### PRT-002 — separate lifecycle machines

- Generate transition constants/predicates from the E0 JSON authority or validate byte-for-byte semantic parity with it.
- Export distinct `JobStatus`, `AttemptStatus`, and `LeaseStatus` plus browser/service state. `dead_letter` belongs only to job policy exhaustion. Retry creates a new attempt. Service-instance `healthy|stopped|lost` never enters generic attempt terminal payloads.
- Job transitions carry `reason: normal | cancel | non_retryable_failure | policy_exhausted`; only `policy_exhausted` permits `dead_letter`, and only `non_retryable_failure` permits aggregate `failed`. The E0 JSON owns these edge conditions, not only the from/to pairs.
- Exhaustively test every from/to/reason combination and every forbidden cross-lifecycle mapping.
- Brand Better Auth and other principal identifiers as opaque non-empty text, not UUID-only. Reject leading or trailing whitespace and preserve accepted bytes exactly; do not trim, normalize, or otherwise rewrite an identity. Domain row identifiers that are actually UUIDs remain separately UUID-branded; do not make one parser stand in for both kinds.

### PRT-003 — honest envelope and extension safety

- Security-critical identity, placement, target, lease, and secret-handle objects are `.strict()`.
- Additive data uses `{ namespace, schemaVersion, critical, value }`. V1 permits at most 16 extensions; namespace is lowercase reverse-DNS plus optional slash name, 1–100 UTF-8 bytes; schema version is 1–1,000,000; each value has at most 8 container levels, 128 array items, 64 object keys, 100 UTF-8 bytes per key, and 16,384 RFC-8785-canonical UTF-8 bytes; the combined canonical value budget is 65,536 bytes. Boundary counting occurs after UTF-8 encoding, not JavaScript code-unit length. Unknown `critical: true` fails closed; safe optional extensions may be preserved byte-semantically.
- Workload commands/arguments remain bounded literals, but the plan does not call arbitrary plaintext secrets “unrepresentable.” Export a pure recursive string visitor/canary-match helper so control-plane producers can reject known secret values before persistence/dispatch.
- Export one canonical target-requirements schema and embed it in every job envelope. Lock V1 enums: target class `managed_cloud | organization_dedicated | owner_desktop`; target scope `platform | organization | owner`; trust class `shared_isolated | organization_isolated | owner_local_trusted`; credential kind `none | platform_brokered | organization_brokered | owner_bound`; locality `transfer_allowed | organization_target_only | owner_device_only`; fallback mode `forbidden | ordered_explicit`. Compatibility is an explicit matrix, never ordinal string comparison.
- Add a strict `ExecutionSourceV1` discriminated union for `task_run`, `commander_turn`, `crew_run`, `one_shot`, `browser_request`, and `service_reconcile`. Only `task_run` contains mandatory `runId` and `issueId`; one-shot includes `extraction | compaction | readiness_probe`; service includes service/generation/reconciliation identity. Every variant carries a typed requester principal and, where applicable, the authoritative assignee/executor identity. Unknown source kinds fail closed.
- Carry typed requester/executor principal identity plus authoritative placement-policy and provider-constraint references and the canonical target requirements. Principal types are `user | agent | service | system`, and IDs are opaque branded text. Dynamic WorkerHello facts cannot set trust/owner/provider/credential/locality ceilings.
- Freeze valid and invalid structural provenance vectors for every source kind, including missing/extra `runId`/`issueId`, task execution-principal/assignee mismatch, unsupported readiness kind, and fabricated task provenance. Requester authorization and equality to the authenticated/domain authority are context-dependent checks owned by JOB-001/JOB-010, not claims made by the context-free wire schema. The same source object is retained in job audit/cost/output projections; events need only echo the job delivery identity because the authoritative job owns immutable provenance.
- Treat worker usage as metering evidence, never an authoritative charge. The `usage` event carries bounded non-negative token/runtime quantities only; provider, model, biller, billing type, rate/version, rounding, and authoritative cost remain control-plane registry/policy facts projected by JOB-012. Reject worker-supplied pricing or charge fields.
- Workload-supplied workspace paths are branded sandbox-relative paths. The only sandbox-absolute path form is the typed `file` secret-materialization target under `/run/aoa-secrets/`. Both reject Windows/POSIX host paths and all escape forms.
- The strict PRT-003 lease objects are domain payloads. `LeaseRenewResponseV1` echoes `protocolVersion`, `workerId`, `jobId`, `attempt`, `leaseId`, and `fenceToken`, plus expiry/cancel fields. PRT-007 nests these payloads in distinct operation envelopes; the bare payload is never sent as an authenticated request.

The V1 placement matrix is closed:

| Target class | Required target scope | Trust class | Permitted credentials | Permitted locality |
|---|---|---|---|---|
| `managed_cloud` | `platform` | `shared_isolated` | `none`, `platform_brokered` | `transfer_allowed` |
| `organization_dedicated` | `organization` | `organization_isolated` | `none`, `platform_brokered`, `organization_brokered` | `transfer_allowed`, `organization_target_only` |
| `owner_desktop` | `owner` | `owner_local_trusted` | `none`, `platform_brokered`, `owner_bound` | `transfer_allowed`, `owner_device_only` |

`owner_bound` and `owner_device_only` require the same non-null owner on the job and profile and forbid fallback to any other logical target. `organization_brokered` and `organization_target_only` require the same Organization and may target only `organization_dedicated`. `ordered_explicit` is allowed only for `none` or `platform_brokered` with `transfer_allowed`; every ordered class must already be in `allowedTargetClasses` and satisfy its exact matrix row. All unlisted combinations fail closed.

Credential kind identifies who may authorize use; it never authorizes raw credential delivery. In v1, every governed remote effect for `platform_brokered`, `organization_brokered`, or `owner_bound` uses `fence_proxy` or `remote_server_fenced`. `sandbox_local_only` cannot reach a network destination, and direct sandbox materialization of a platform/provider credential is unrepresentable.

### PRT-004 — event identity and service semantics

- Every event carries `eventDigest`, the lowercase SHA-256 of RFC 8785 canonical JSON for the complete immutable event object with `eventDigest` omitted. Export dependency-free `canonicalizeJsonV1`, `canonicalEventDigestInputV1`, and async `verifyWorkerEventDigestV1(event, sha256Fn)`; producer and receiver inject platform crypto to hash those exact UTF-8 bytes. RFC 8785 does not add Unicode normalization, so code-point content is preserved exactly.
- A receiver rejects a supplied digest that does not match recomputation before persistence or idempotency handling. Retransmitted previously committed ID+recomputed-digest is idempotent; the same ID with a different recomputed digest is `hash_mismatch`; duplicate IDs inside one submitted batch are invalid.
- **Cross-implementation digest equivalence (closes the two-canonicalizer seam).** RFC 8785 canonical JSON is implemented twice by hard necessity: the E0 checker `scripts/check-distributed-execution-foundation.mjs` (dependency-free Node, no package import) and this package's `canonical-json.ts` (zero-node-import runtime source). The FND-004 golden fixtures already carry committed `eventDigest` values computed by the E0 implementation. `events.test.ts` MUST load every expected event from `tests/fixtures/distributed-execution/*.json` and assert that this package's `canonicalEventDigestInputV1` + injected Node SHA-256 recomputes each fixture's exact committed `eventDigest`; a single mismatch fails the suite. This is a bidirectional cross-check, not two independent copies of the same vectors: the E0 checker owns the fixtures' bytes, and E1 proves byte-for-byte agreement against them. If the two implementations ever diverge on an edge case (lone surrogates, unsafe-integer boundary, duplicate semantic keys, `-0`), this test fails at PRT-004 rather than silently in production. It is a required PRT-004 acceptance item, not deferred to PRT-006's Ajv golden-journey pass.
- Add exact event names `service_instance_started`, `service_health`, `service_checkpoint_prepared`, `service_checkpoint_restored`, `service_graceful_stop_observed`, `service_instance_stopped`, `service_instance_lost`, `service_provider_interrupted`, and `service_provider_resumed`. Each carries service ID, instance ID, generation, and delivery identity.
- Generic attempt terminal payloads remain `succeeded|failed|cancelled|expired`; service `stopped|failed|lost` uses service-instance transition events.

### PRT-005 — explicit quarantine contract

- The strict PRT-005 artifact/commit objects are domain payloads. Ordinary `ArtifactCommitPayloadV1` always requires the current fence; PRT-007 supplies the distinct authenticated operation envelope.
- Add a device-authenticated two-step quarantine transfer: `QuarantineGrantPayloadV1` obtains an exact short-lived PUT grant for the quarantine prefix/hash/size, then `QuarantineFinalizePayloadV1` verifies the uploaded object and returns `QuarantineUploadReceiptV1`. Reasons include `stale_fence`, `late_output`, `hash_mismatch`, `wrong_prefix`, `size_mismatch`, `unknown_artifact`, and `corrupt_checkpoint`.
- Quarantine preserves observed identity/hash/size/sensitivity/provenance but has no auto-apply, attempt mutation, or checkpoint-selection operation.

### PRT-006 — registered target and negotiation

- Separate `RegisteredTargetProfileV1` (server authority) from `WorkerHelloV1` (dynamic claims). A physical device may own multiple Organization-scoped logical profiles. `platform` profiles require null Organization/owner and operator-managed enrollment; `organization` profiles require Organization and null owner; `owner` profiles require both Organization and owner. Requirement matching uses their intersection without exposing another tenant's job details.
- Add a server-owned versioned `ProviderConstraintProfileV1` plus `{ profileId, version, digest }` wire reference. It expresses normalized runtime/idle/resource/concurrency/locality and supported-operation ceilings without provider-specific field names; provider-native regions/templates remain in the control-plane registry. JOB-009 resolves the referenced profile before leasing.
- `ProviderConstraintProfileV1.digest` is the lowercase SHA-256 of RFC 8785 canonical JSON for the strict profile with `digest` omitted. Export canonical digest input plus injected-hash `verifyAndBrandProviderConstraintProfileV1`; it returns a non-serializable `VerifiedProviderConstraintProfileV1` only on a match. Requirement matching accepts that verified type, never a raw parsed/self-asserted profile. A field mutation with the old digest fails before matching.
- Include must-understand capabilities/policy versions; malicious capability advertisement cannot elevate trust or placement.
- Existing same-parser “N-1” arithmetic is only a negotiation unit test. It is not the cross-version release proof.

### PRT-007 — transport/control/error and frozen compatibility

- Add framework-neutral schemas for enrollment, poll/offer/no-work, ACK, renew, event upload, artifact/quarantine control, cancel, approval, checkpoint, graceful stop, drain, sequenced control commands and command ACKs.
- Every operation defines correlation/idempotency, authentication audience, anti-replay timestamp/nonce, payload limit, timeout, retry, `retryAfter`, and `serverTime` where relevant.
- Stable errors distinguish malformed, unauthorized, incompatible protocol/capability/policy, stale fence, gap, revoked target, throttled, oversized, and terminal attempt without existence disclosure.
- Finish the complete PRT-007 v1 surface before freezing it. Check in that hash-pinned independent consumer and run the full corpus in both producer/consumer directions. The initial release records `baseline_established`, not a fictional prior-version proof. The first and every later contract change must run the current candidate against the oldest supported frozen consumer in both directions over jobs, leases, events, service events, artifacts, quarantine, secrets, policies, capabilities, controls, and errors; unsupported critical behavior must fail during negotiation.

---

### Task 1: PRT-001 — Leaf Protocol Package and Boundary Gate

**Files:**
- Create: `packages/worker-protocol/package.json`
- Create: `packages/worker-protocol/tsconfig.json`
- Create: `packages/worker-protocol/vitest.config.ts`
- Create: `packages/worker-protocol/src/version.ts`
- Create: `packages/worker-protocol/src/index.ts`
- Create: `packages/worker-protocol/src/index.test.ts`
- Create: `scripts/check-worker-protocol-boundary.mjs`
- Create: `scripts/lib/worker-protocol-boundary.mjs`
- Create: `scripts/check-worker-protocol-boundary.test.mjs`
- Create: `scripts/check-worker-protocol-package.mjs`
- Create: `tests/fixtures/worker-protocol-import/server-consumer.mjs`
- Create: `tests/fixtures/worker-protocol-import/worker-consumer.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `vitest.config.ts`
- Modify: `.github/workflows/pr.yml`

**Interfaces:**
- Consumes: pnpm `packages/*` workspace glob and root TS/Vitest conventions.
- Produces: package `@armyofagents/worker-protocol`; `PROTOCOL_VERSION = 1`; `MIN_PROTOCOL_VERSION = 1`; `pnpm check:worker-protocol-boundary`.

- [ ] **Step 1: Add a failing boundary checker**

Add this root package script:

```json
"check:worker-protocol-boundary": "node scripts/check-worker-protocol-boundary.mjs"
```

Create `scripts/check-worker-protocol-boundary.mjs`:

```js
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const packageRoot = path.join(root, "packages", "worker-protocol");
const sourceRoot = path.join(packageRoot, "src");
const errors = [];

function extractModuleSpecifiers(source) {
  const values = [];
  const patterns = [
    /(?:^|[;\n])\s*(?:import|export)\s+(?:[^"'()]*?\s+from\s*)?["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) values.push(match[1]);
  }
  return values;
}

let manifest;
try {
  manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
} catch {
  errors.push("packages/worker-protocol/package.json: missing or invalid");
}

if (manifest) {
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {}).sort();
  if (JSON.stringify(runtimeDependencies) !== JSON.stringify(["zod"])) {
    errors.push(`runtime dependencies must equal [\"zod\"], got ${JSON.stringify(runtimeDependencies)}`);
  }
  if (manifest.name !== "@armyofagents/worker-protocol") {
    errors.push(`unexpected package name ${JSON.stringify(manifest.name)}`);
  }
}

const forbiddenGlobal = /\b(?:process|Buffer|globalThis|global|Deno|Bun)\b|\b(?:__dirname|__filename)\b|\brequire\s*\(|\bmodule\s*\.\s*require\s*\(/;

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute);
    } else if (entry.isSymbolicLink()) {
      errors.push(`${path.relative(root, absolute)}: runtime-source symlinks are forbidden`);
    } else if (/\.(?:d\.ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) {
      errors.push(`${path.relative(root, absolute)}: alternate runtime-source extensions are forbidden; use .ts`);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      const source = await readFile(absolute, "utf8");
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      // Extract static imports, side-effect imports, dynamic import(...), and
      // export ... from specifiers. Runtime source may import only "zod" or
      // a relative path; bare Node builtins, node:, AoA packages, and every
      // other external package fail. The checker test corpus includes one
      // bypass attempt for each syntax/builtin form.
      for (const specifier of extractModuleSpecifiers(source)) {
        if (specifier === "zod") continue;
        if (specifier.startsWith("./") || specifier.startsWith("../")) {
          if (/\.test(?:\.[cm]?js|\.[cm]?ts)?$/.test(specifier)) {
            errors.push(`${relative}: runtime import of test source is forbidden: ${JSON.stringify(specifier)}`);
            continue;
          }
          const resolved = path.resolve(path.dirname(absolute), specifier);
          if (resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${path.sep}`)) continue;
          errors.push(`${relative}: relative import escapes package src: ${JSON.stringify(specifier)}`);
        } else {
          errors.push(`${relative}: forbidden runtime import ${JSON.stringify(specifier)}`);
        }
      }
      if (forbiddenGlobal.test(source)) errors.push(`${relative}: forbidden Node process global`);
    }
  }
}

try {
  await walk(sourceRoot);
} catch {
  errors.push("packages/worker-protocol/src: missing");
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("worker protocol boundary: PASS");
```

Keep parsing and source validation in `scripts/lib/worker-protocol-boundary.mjs` as dependency-free pure exports; the command file supplies filesystem bytes. It accepts `--root <fixture-directory>` only for the test harness and otherwise checks `process.cwd()`. Runtime source is `.ts` only; reject `.d.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs` anywhere under `src` so an alternate extension cannot bypass scanning. Test files are excluded from `tsc` output, and production files may not import or re-export a `.test` source; the pack checker rejects any emitted test file. The production extractor and forbidden-global detector must use a small lexical scanner that ignores comments and non-specifier string/template contents and handles multiline syntax; the seed regexes above are not by themselves the finished bypass boundary. Report filesystem read/parse errors with the exact path and cause separately from import-policy violations. `scripts/check-worker-protocol-boundary.test.mjs` uses `node:test` and a temporary fixture root to prove rejection of every alternate extension, test-source import, Node/runtime globals, `node:fs`, bare `fs`/`crypto`, `require()`/`module.require()`, every non-`zod` bare package, runtime-source symlinks, and relative escapes such as `../../../server/...` or `../../shared/...` across static imports, side-effect imports, `export ... from`, and literal dynamic `import(...)`. It allows `zod` and only relative specifiers whose normalized path remains inside `packages/worker-protocol/src`. Add multiline/comment/string decoys and one bypass attempt for every supported syntax. It also proves a missing or unreadable source reports its actual path/error rather than being mislabeled as a policy result.

- [ ] **Step 2: Run the boundary checker and verify RED**

Run:

```powershell
pnpm check:worker-protocol-boundary
```

Expected: exit 1 naming the missing package manifest and source directory.

- [ ] **Step 3: Add the package manifest and build configuration**

Create `packages/worker-protocol/package.json`:

```json
{
  "name": "@armyofagents/worker-protocol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit",
    "test": "vitest",
    "test:run": "vitest run"
  },
  "dependencies": {
    "zod": "3.24.2"
  },
  "devDependencies": {
    "@types/node": "^24.6.0",
    "typescript": "^5.7.3",
    "vitest": "^3.2.6"
  }
}
```

Create `packages/worker-protocol/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

Create `packages/worker-protocol/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node" },
});
```

Add `"packages/worker-protocol"` to the root `vitest.config.ts` project list.

- [ ] **Step 4: Write a failing public-entry test**

Create `packages/worker-protocol/src/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from "./index.js";

describe("worker protocol package", () => {
  it("exports the initial version range", () => {
    expect(MIN_PROTOCOL_VERSION).toBe(1);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
```

Run:

```powershell
pnpm --filter @armyofagents/worker-protocol test:run
```

Expected: FAIL because `src/index.ts` and version exports do not exist.

- [ ] **Step 5: Implement the initial version entrypoint**

Create `packages/worker-protocol/src/version.ts`:

```ts
export const MIN_PROTOCOL_VERSION = 1 as const;
export const PROTOCOL_VERSION = 1 as const;
```

Create `packages/worker-protocol/src/index.ts`:

```ts
export { MIN_PROTOCOL_VERSION, PROTOCOL_VERSION } from "./version.js";
```

- [ ] **Step 6: Regenerate, pack, and verify dependency/API boundaries**

Run:

```powershell
pnpm install --no-frozen-lockfile
pnpm install --frozen-lockfile
pnpm --filter @armyofagents/worker-protocol test:run
pnpm --filter @armyofagents/worker-protocol typecheck
pnpm --filter @armyofagents/worker-protocol build
pnpm check:worker-protocol-boundary
node --test scripts/check-worker-protocol-boundary.test.mjs
node scripts/check-worker-protocol-package.mjs
```

`check-worker-protocol-package.mjs` packs the built package into a temporary directory, verifies the tarball contains only declared metadata plus `dist`, installs or links that exact tarball into minimal server and worker consumers without network access, and imports only the public root export from both. It fails if a `src` path, wildcard/private subpath, undeclared runtime dependency, or missing declaration/runtime file is exposed. Expected: all commands exit 0.

- [ ] **Step 7: Add the always-on policy check**

In `.github/workflows/pr.yml`, after the E0 foundation-contract step in the `policy` job, add:

```yaml
      - name: Worker protocol dependency boundary
        run: |
          node scripts/check-worker-protocol-boundary.mjs
          node --test scripts/check-worker-protocol-boundary.test.mjs
```

This uses no installed dependencies and must remain in the always-on policy job.

- [ ] **Step 8: Record and commit PRT-001**

Create `docs/replatform/epics/E1-worker-protocol/tickets/PRT-001-result.md`. Record the intentional missing-package RED result, manifest/lockfile change, package test/typecheck/build/pack results, both exact-tarball import smokes, boundary bypass corpus, and policy-job change.

```powershell
git add package.json pnpm-lock.yaml vitest.config.ts .github/workflows/pr.yml scripts/check-worker-protocol-boundary.mjs scripts/lib/worker-protocol-boundary.mjs scripts/check-worker-protocol-boundary.test.mjs scripts/check-worker-protocol-package.mjs tests/fixtures/worker-protocol-import packages/worker-protocol docs/replatform/epics/E1-worker-protocol/tickets/PRT-001-result.md
git commit -m "feat: scaffold worker protocol package"
```

---

### Task 2: PRT-002 — Branded Identities and Lifecycle State Machines

**Files:**
- Create: `packages/worker-protocol/src/ids.ts`
- Create: `packages/worker-protocol/src/ids.test.ts`
- Create: `packages/worker-protocol/src/states.ts`
- Create: `packages/worker-protocol/src/states.test.ts`
- Modify: `packages/worker-protocol/src/index.ts`

**Interfaces:**
- Consumes: E0 lifecycle status sets and FND-007 source/principal authority.
- Produces: branded UUID domain IDs, opaque `PrincipalId`, source-specific ID schemas/types, `attemptNumberSchema`, `eventSequenceSchema`, `fenceTokenSchema`, `sha256DigestSchema`, workload/status schemas, and `canTransition*` functions.

- [ ] **Step 1: Write failing identity tests**

Create `packages/worker-protocol/src/ids.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  attemptNumberSchema,
  eventSequenceSchema,
  fenceTokenSchema,
  jobIdSchema,
  organizationIdSchema,
  sha256DigestSchema,
} from "./ids.js";

describe("wire identities", () => {
  it("accepts UUID identities and positive counters", () => {
    expect(organizationIdSchema.parse("00000000-0000-4000-8000-000000000001")).toBeTruthy();
    expect(jobIdSchema.parse("00000000-0000-4000-8000-000000000002")).toBeTruthy();
    expect(attemptNumberSchema.parse(1)).toBe(1);
    expect(eventSequenceSchema.parse(1)).toBe(1);
  });

  it("rejects malformed identities and non-positive counters", () => {
    expect(jobIdSchema.safeParse("job-1").success).toBe(false);
    expect(attemptNumberSchema.safeParse(0).success).toBe(false);
    expect(eventSequenceSchema.safeParse(-1).success).toBe(false);
  });

  it("accepts only bounded base64url fences and lowercase SHA-256", () => {
    expect(fenceTokenSchema.safeParse("a".repeat(43)).success).toBe(true);
    expect(fenceTokenSchema.safeParse("short").success).toBe(false);
    expect(sha256DigestSchema.safeParse("f".repeat(64)).success).toBe(true);
    expect(sha256DigestSchema.safeParse("F".repeat(64)).success).toBe(false);
  });
});
```

- [ ] **Step 2: Write failing exhaustive transition tests**

Create `packages/worker-protocol/src/states.test.ts`. Define expected transition records matching E0 and assert every Cartesian pair:

```ts
import { describe, expect, it } from "vitest";
import {
  BROWSER_SESSION_STATUSES,
  ATTEMPT_STATUSES,
  JOB_STATUSES,
  LEASE_STATUSES,
  SERVICE_DESIRED_STATES,
  SERVICE_INSTANCE_STATUSES,
  canTransitionBrowserSessionStatus,
  canTransitionAttemptStatus,
  canTransitionJobStatus,
  canTransitionLeaseStatus,
  canTransitionServiceDesiredState,
  canTransitionServiceInstanceStatus,
  workloadTypeSchema,
} from "./states.js";

const jobExpected = {
  queued: ["running", "cancel_requested", "cancelled"],
  running: ["cancel_requested", "succeeded", "failed", "dead_letter"],
  cancel_requested: ["cancelled", "failed", "dead_letter"],
  succeeded: [], failed: [], cancelled: [], dead_letter: [],
} as const;

describe("protocol state machines", () => {
  it("accepts only the three locked workload types", () => {
    expect(workloadTypeSchema.parse("batch")).toBe("batch");
    expect(workloadTypeSchema.parse("browser_session")).toBe("browser_session");
    expect(workloadTypeSchema.parse("service")).toBe("service");
    expect(workloadTypeSchema.safeParse("daemon").success).toBe(false);
  });

  it("matches every allowed and forbidden job transition", () => {
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        const permittedBySomeReason = ["normal", "cancel", "non_retryable_failure", "policy_exhausted"].some(
          (reason) => canTransitionJobStatus(from, to, { reason }),
        );
        expect(permittedBySomeReason, `${from} -> ${to}`).toBe((jobExpected[from] as readonly string[]).includes(to));
      }
    }
  });

  it("keeps all terminal states immutable", () => {
    for (const status of ["succeeded", "failed", "cancelled", "dead_letter"] as const) {
      expect(JOB_STATUSES.every((to) => !canTransitionJobStatus(status, to, { reason: "normal" }))).toBe(true);
    }
  });

  it("guards terminal failure reasons", () => {
    expect(canTransitionJobStatus("running", "dead_letter", { reason: "normal" })).toBe(false);
    expect(canTransitionJobStatus("running", "dead_letter", { reason: "policy_exhausted" })).toBe(true);
    expect(canTransitionJobStatus("running", "failed", { reason: "normal" })).toBe(false);
    expect(canTransitionJobStatus("running", "failed", { reason: "non_retryable_failure" })).toBe(true);
  });
});
```

In the same file, add explicit expected maps and Cartesian assertions for:

- attempt: `pending→offered|cancelled|expired`; `offered→leased|expired|cancelled`; `leased→running|cancel_requested|expired|cancelled`; `running→cancel_requested|succeeded|failed|expired`; `cancel_requested→cancelled|succeeded|failed|expired`; terminals immutable;
- lease: `offered→active|expired|revoked`; `active→released|expired|revoked`; terminals immutable;
- browser: `queued→leased|cancelled|expired`; `leased→starting|cancel_requested|cancelled|expired`; `starting→active|cancel_requested|failed|cancelled|expired`; `active→waiting_approval|cancel_requested|succeeded|failed|cancelled|expired`; `waiting_approval→active|cancel_requested|failed|cancelled|expired`; `cancel_requested→cancelled|succeeded|failed|expired`; terminals immutable;
- service desired: `running→paused|stopped|deleted`; `paused→running|stopped|deleted`; `stopped→running|deleted`; `deleted→[]`;
- service instance: `pending→leased|failed|lost`; `leased→starting|stopping|failed|lost`; `starting→healthy|unhealthy|stopping|failed|lost`; `healthy→unhealthy|stopping|failed|lost`; `unhealthy→healthy|stopping|failed|lost`; `stopping→stopped|failed|lost`; terminals `stopped|failed|lost` immutable.

These maps are illustrative; the machine-readable `docs/architecture/distributed-execution-lifecycles.json` is authoritative (E1-D001). `states.test.ts` MUST additionally load that JSON at test time and assert byte-for-byte semantic parity: for each machine, the embedded `states.ts` transition map (grouped by `from`), reason `guards`, and `terminal` set equal the JSON's `allowed` edges, `guards`, and `terminal` arrays exactly — no missing edge, no extra edge, no mismatched guard. This is the PRT-002 counterpart to PRT-004's canonicalizer cross-check and is a required acceptance item.

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
pnpm --filter @armyofagents/worker-protocol exec vitest run src/ids.test.ts src/states.test.ts
```

Expected: FAIL because identity and state modules do not exist.

- [ ] **Step 4: Implement branded identities**

Create `ids.ts` with separate UUID-domain and opaque-principal schemas and these exact exports:

```ts
import { z } from "zod";

const uuidSchema = z.string().uuid();
const opaquePrincipalTextSchema = z.string().min(1).superRefine((value, ctx) => {
  if (value !== value.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "principal ID must not contain leading or trailing whitespace" });
  }
  if (new TextEncoder().encode(value).byteLength > 200) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "principal ID exceeds 200 UTF-8 bytes" });
  }
});
export const organizationIdSchema = uuidSchema.brand<"OrganizationId">();
export const companyIdSchema = uuidSchema.brand<"CompanyId">();
export const agentIdSchema = uuidSchema.brand<"AgentId">();
export const runIdSchema = uuidSchema.brand<"RunId">();
export const issueIdSchema = uuidSchema.brand<"IssueId">();
export const internalAgentRunIdSchema = uuidSchema.brand<"InternalAgentRunId">();
export const conversationIdSchema = uuidSchema.brand<"ConversationId">();
export const crewRunIdSchema = uuidSchema.brand<"CrewRunId">();
export const oneShotOperationIdSchema = uuidSchema.brand<"OneShotOperationId">();
export const browserRequestIdSchema = uuidSchema.brand<"BrowserRequestId">();
export const reconciliationIdSchema = uuidSchema.brand<"ReconciliationId">();
export const jobIdSchema = uuidSchema.brand<"JobId">();
export const workerIdSchema = uuidSchema.brand<"WorkerId">();
export const targetIdSchema = uuidSchema.brand<"TargetId">();
export const leaseIdSchema = uuidSchema.brand<"LeaseId">();
export const eventIdSchema = uuidSchema.brand<"EventId">();
export const artifactIdSchema = uuidSchema.brand<"ArtifactId">();
export const secretHandleIdSchema = uuidSchema.brand<"SecretHandleId">();
export const serviceIdSchema = uuidSchema.brand<"ServiceId">();
export const serviceInstanceIdSchema = uuidSchema.brand<"ServiceInstanceId">();
export const principalIdSchema = opaquePrincipalTextSchema.brand<"PrincipalId">();
export const sandboxIdSchema = z.string().min(1).max(200).brand<"SandboxId">();
export const attemptNumberSchema = z.number().int().positive().max(1_000_000);
export const eventSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const fenceTokenSchema = z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/).brand<"FenceToken">();
export const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/).brand<"Sha256Digest">();

export type OrganizationId = z.infer<typeof organizationIdSchema>;
export type CompanyId = z.infer<typeof companyIdSchema>;
export type AgentId = z.infer<typeof agentIdSchema>;
export type RunId = z.infer<typeof runIdSchema>;
export type IssueId = z.infer<typeof issueIdSchema>;
export type InternalAgentRunId = z.infer<typeof internalAgentRunIdSchema>;
export type ConversationId = z.infer<typeof conversationIdSchema>;
export type CrewRunId = z.infer<typeof crewRunIdSchema>;
export type OneShotOperationId = z.infer<typeof oneShotOperationIdSchema>;
export type BrowserRequestId = z.infer<typeof browserRequestIdSchema>;
export type ReconciliationId = z.infer<typeof reconciliationIdSchema>;
export type JobId = z.infer<typeof jobIdSchema>;
export type WorkerId = z.infer<typeof workerIdSchema>;
export type TargetId = z.infer<typeof targetIdSchema>;
export type LeaseId = z.infer<typeof leaseIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type ArtifactId = z.infer<typeof artifactIdSchema>;
export type SecretHandleId = z.infer<typeof secretHandleIdSchema>;
export type ServiceId = z.infer<typeof serviceIdSchema>;
export type ServiceInstanceId = z.infer<typeof serviceInstanceIdSchema>;
export type PrincipalId = z.infer<typeof principalIdSchema>;
export type SandboxId = z.infer<typeof sandboxIdSchema>;
export type FenceToken = z.infer<typeof fenceTokenSchema>;
export type Sha256Digest = z.infer<typeof sha256DigestSchema>;
```

- [ ] **Step 5: Implement state constants and predicates**

Create `states.ts` with `as const` arrays, Zod enums, inferred types, transition maps, guarded job-edge reasons, and six named predicates. Validate all maps and edge conditions against `distributed-execution-lifecycles.json`. The job predicate takes `{ reason }`; no default is allowed, so callers cannot accidentally dead-letter or fail without an explicit cause. Use the generic helper below only for unguarded machines:

```ts
function canTransition<S extends string>(
  transitions: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
): boolean {
  return (transitions[from] as readonly string[]).includes(to);
}
```

Export exactly:

```ts
WORKLOAD_TYPES, workloadTypeSchema, type WorkloadType
JOB_STATUSES, jobStatusSchema, type JobStatus, canTransitionJobStatus
ATTEMPT_STATUSES, attemptStatusSchema, type AttemptStatus, canTransitionAttemptStatus
LEASE_STATUSES, leaseStatusSchema, type LeaseStatus, canTransitionLeaseStatus
BROWSER_SESSION_STATUSES, browserSessionStatusSchema, type BrowserSessionStatus, canTransitionBrowserSessionStatus
SERVICE_DESIRED_STATES, serviceDesiredStateSchema, type ServiceDesiredState, canTransitionServiceDesiredState
SERVICE_INSTANCE_STATUSES, serviceInstanceStatusSchema, type ServiceInstanceStatus, canTransitionServiceInstanceStatus
```

Populate transition maps with the exact values asserted in Step 2.

- [ ] **Step 6: Export, verify, record, and commit PRT-002**

Export every schema, constant, predicate, and type from `index.ts`. Run:

```powershell
pnpm --filter @armyofagents/worker-protocol exec vitest run src/ids.test.ts src/states.test.ts
pnpm --filter @armyofagents/worker-protocol typecheck
pnpm --filter @armyofagents/worker-protocol build
pnpm check:worker-protocol-boundary
```

Expected: PASS.

Create `docs/replatform/epics/E1-worker-protocol/tickets/PRT-002-result.md` with the exhaustive transition counts and identity validation evidence.

```powershell
git add packages/worker-protocol/src docs/replatform/epics/E1-worker-protocol/tickets/PRT-002-result.md
git commit -m "feat: define worker protocol identities and states"
```

---

### Task 3: PRT-003 — Job, Workload, and Lease Envelopes

**Files:**
- Create: `packages/worker-protocol/src/wire-safety.ts`
- Create: `packages/worker-protocol/src/wire-safety.test.ts`
- Create: `packages/worker-protocol/src/source.ts`
- Create: `packages/worker-protocol/src/source.test.ts`
- Create: `packages/worker-protocol/src/job.ts`
- Create: `packages/worker-protocol/src/job.test.ts`
- Modify: `packages/worker-protocol/src/index.ts`

**Interfaces:**
- Consumes: protocol version, branded IDs, FND-007 execution-source/parity authority, workload type.
- Produces: `principalV1Schema`, `executionSourceV1Schema`, `jobEnvelopeV1Schema`, workload-specific envelopes, strict lease-offer/ACK/renew domain payload schemas, and inferred payload types later nested in PRT-007 operation envelopes.

- [ ] **Step 1: Write failing recursive wire-safety tests**

Create `wire-safety.test.ts` asserting:

```ts
import { describe, expect, it } from "vitest";
import { findForbiddenWireKeys } from "./wire-safety.js";

describe("wire safety", () => {
  it("finds credential-bearing keys recursively", () => {
    expect(findForbiddenWireKeys({
      future: { apiKey: "x" },
      oauth: { accessToken: "y", refreshToken: "z" },
      rows: [{ password: "w" }],
    })).toEqual([
      "future.apiKey",
      "oauth.accessToken",
      "oauth.refreshToken",
      "rows.0.password",
    ]);
  });

  it("does not reject opaque handle identifiers", () => {
    expect(findForbiddenWireKeys({ secretHandleIds: ["id"], policyHash: "hash" })).toEqual([]);
  });
});
```

Forbidden keys are compared case-insensitively after removing punctuation and underscores, so camelCase OAuth fields fail too. The normalized forbidden set is exactly:

```ts
["env", "environment", "apikey", "password", "token", "accesstoken", "refreshtoken", "cookie", "authorization", "credential", "credentials", "secretvalue"]
```

- [ ] **Step 2: Write failing job/lease schema tests**

Create `job.test.ts` with one valid envelope per workload. Use fixed UUIDs, RFC3339 timestamps, lowercase 64-character hashes, and a 43-character fence. Assert:

- matching `workloadType`/workload payload parses;
- `batch` with a browser payload fails;
- attempt `0` fails;
- deadline before `createdAt` fails;
- a bounded `extensions` entry with `critical: false` is accepted and preserved; an unknown critical extension fails;
- extension count, namespace, schemaVersion, canonical UTF-8 bytes, container depth, array length, object key count, and key-byte limits pass at the boundary and fail at boundary+1;
- exact target/trust/credential/locality/fallback enums reject unknown values and the compatibility matrix rejects an invalid class/trust/owner/credential combination;
- a provider-constraint profile reference is mandatory and protected by the placement-policy digest;
- nested `apiKey`, `env`, `cookie`, `accessToken`, or `refreshToken` fails;
- only handle IDs appear in `secretHandleIds`;
- lease ACK/renew messages require the same job/attempt/lease/fence identity shape;
- ACK deadline must precede lease expiry;
- renewal response contains server-selected `expiresAt` and durable cancellation state.
- every execution-source variant round-trips with a typed requester and execution principal; only `task_run` accepts/requires `runId` and `issueId`;
- task assignee and execution principal must match; fabricated run/issue fields on Commander, crew, one-shot, browser, or service sources fail;
- opaque Better Auth-style principal IDs pass, blank/oversized IDs fail, and `system` is a valid principal kind;
- one-shot operation kind is exactly `extraction | compaction | readiness_probe`; unknown source and operation kinds fail closed;
- a seeded deterministic generator covers at least 10,000 recursive string values across argv, URLs, headers, nested arrays, and extensions; registered canaries always fail and the seed/count are recorded. PRT-005 owns the separate 10,000-case canonical path corpus.

Use this valid batch fixture in the test:

```ts
const batchJob = {
  protocolVersion: 1,
  jobId: "00000000-0000-4000-8000-000000000010",
  attempt: 1,
  organizationId: "00000000-0000-4000-8000-000000000011",
  companyId: "00000000-0000-4000-8000-000000000012",
  source: {
    kind: "task_run",
    runId: "00000000-0000-4000-8000-000000000013",
    issueId: "00000000-0000-4000-8000-000000000014",
    requestedBy: { principalType: "user", principalId: "better-auth-user-17" },
    executionPrincipal: { principalType: "agent", principalId: "00000000-0000-4000-8000-000000000017" },
    assigneeAgentId: "00000000-0000-4000-8000-000000000017",
  },
  createdAt: "2026-08-07T00:00:00.000Z",
  notBefore: null,
  deadline: "2026-08-07T01:00:00.000Z",
  inputHash: "a".repeat(64),
  policyHash: "b".repeat(64),
  placement: {
    policyId: "owner-or-managed",
    version: 1,
    digest: "d".repeat(64),
    targetRequirements: {
      allowedTargetClasses: ["owner_desktop", "managed_cloud"],
      allowedTrustClasses: ["owner_local_trusted", "shared_isolated"],
      requiredOwnerPrincipalId: null,
      credentialKind: "platform_brokered",
      dataLocality: "transfer_allowed",
      fallback: { mode: "ordered_explicit", orderedTargetClasses: ["owner_desktop", "managed_cloud"] },
      providerConstraints: { profileId: "standard", version: 1, digest: "e".repeat(64) }
    }
  },
  adapter: { type: "codex_local", version: "0.2.7", configArtifactId: null },
  requiredCapabilities: ["workload.batch", "provider.lifecycle_v1", "sandbox.filesystem_isolated", "sandbox.filtered_egress"],
  workspace: {
    manifestArtifactId: "00000000-0000-4000-8000-000000000015",
    base: { kind: "git_commit", algorithm: "git_sha1", revision: "0123456789abcdef0123456789abcdef01234567" },
    manifestHash: "f".repeat(64),
    mode: "read_write",
  },
  secretHandleIds: ["00000000-0000-4000-8000-000000000016"],
  resourceLimits: { cpuMillis: 2000, memoryMiB: 4096, pids: 512, diskMiB: 10240 },
  networkPolicy: { policyId: "provider-only", version: 1, digest: "c".repeat(64) },
  offlinePolicy: "cancel",
  extensions: [],
  workloadType: "batch",
  workload: {
    command: "codex",
    args: ["exec", "--json"],
    stdinArtifactId: null,
    maxRuntimeSeconds: 3600,
  },
};
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
pnpm --filter @armyofagents/worker-protocol exec vitest run src/wire-safety.test.ts src/source.test.ts src/job.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 4: Implement recursive forbidden-key detection**

Create `wire-safety.ts` exporting:

```ts
import { z } from "zod";

export const FORBIDDEN_WIRE_KEYS: ReadonlySet<string>;
export function findForbiddenWireKeys(value: unknown): string[];
export function addForbiddenWireKeyIssues(value: unknown, ctx: z.RefinementCtx): void;
```

Traverse plain objects and arrays, sort object keys for deterministic output, compare normalized keys against the exact Step 1 set, and report `z.ZodIssueCode.custom` at the offending path. Also export the pure recursive string visitor/canary matcher and dependency-free seeded generator required by the hardening amendment; producer tests inspect every string value and record 10,000-case seeds/counts. Do not reject the known key `secretHandleIds`.

- [ ] **Step 5: Implement principals, execution sources, and workload-specific job envelopes**

Create `source.ts` with a strict principal schema `{ principalType: "user" | "agent" | "service" | "system", principalId: PrincipalId }` and a strict `z.discriminatedUnion("kind", ...)` with these variants:

```ts
task_run: { runId, issueId, requestedBy, executionPrincipal, assigneeAgentId: AgentId }
commander_turn: { internalAgentRunId, conversationId, requestedBy, executionPrincipal }
crew_run: { crewRunId, requestedBy, executionPrincipal }
one_shot: { operationId, operationKind: "extraction" | "compaction" | "readiness_probe", requestedBy, executionPrincipal }
browser_request: { browserRequestId, parentJobId nullable, requestedBy, executionPrincipal }
service_reconcile: { serviceId, generation positive, reconciliationId, requestedBy, executionPrincipal }
```

Extend this test with `principalIdSchema`: accept representative Better Auth text IDs and UUID-shaped agent IDs; reject empty, whitespace-only, leading/trailing-whitespace, over-200-UTF-8-byte, or non-string values. Include 200/201-byte ASCII and multibyte boundary cases so JavaScript code-unit length cannot become the frozen cross-language rule. Assert that accepted principal IDs round-trip byte-for-byte without normalization or trimming. Assert every source-specific domain ID uses its declared UUID brand and cannot be substituted for `PrincipalId` at the TypeScript boundary.

Every variant includes its literal `kind`. Reject unknown keys. For `task_run`, require an agent execution principal whose opaque principal ID has byte-for-byte string-value equality with the UUID-branded `assigneeAgentId`. Do not add optional `runId` or `issueId` to the common envelope or any non-task variant. The source object is immutable provenance, not authorization by itself; JOB-001 validates `requestedBy` against authenticated/domain authority and JOB-010 through JOB-014 revalidate current domain policy.

In `job.ts`, define strict common security-critical schemas plus the bounded namespaced extension container from the hardening amendment for:

```ts
timestamp: RFC3339 with offset
adapter: { type: non-empty max 100, version: non-empty max 100, configArtifactId: ArtifactId | null }
source: ExecutionSourceV1
targetRequirements: { allowedTargetClasses, allowedTrustClasses, requiredOwnerPrincipalId nullable, credentialKind, dataLocality, fallback: { mode, orderedTargetClasses }, providerConstraints: { profileId, version, digest } }
placement: { policyId, version, digest, targetRequirements }
workspace: { manifestArtifactId: ArtifactId, base: { kind: "git_commit" | "content_manifest", algorithm: "git_sha1" | "git_sha256" | "sha256", revision with matching 40/64 format }, manifestHash: Sha256Digest, mode: "read_only" | "read_write" } | null
resourceLimits: { cpuMillis: 100–128000, memoryMiB: 128–1048576, pids: 16–100000, diskMiB: 128–10485760 }
networkPolicy: { policyId: slug, version: positive integer, digest: Sha256Digest }
offlinePolicy: "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry"
```

Define three strict envelope objects with the explicit bounded `extensions` field and combine them with `z.discriminatedUnion("workloadType", ...)`:

```ts
batch workload: { command, args max 256, stdinArtifactId nullable, maxRuntimeSeconds 1–86400 }
browser workload: { engine: "chromium", viewport width/height, locale, timezone, recordTrace, recordVideo, maxSessionSeconds 1–43200 }
service workload: { serviceId, serviceInstanceId, generation positive, command, args max 256, checkpointArtifactId nullable, gracefulStopSeconds 1–300 }
```

The common envelope contains every field in `batchJob` above. It has no common `runId`, `issueId`, or free-standing `actor` field. Add a final `superRefine` that:

- calls `addForbiddenWireKeyIssues`;
- rejects `deadline <= createdAt`;
- rejects `notBefore > deadline`;
- rejects duplicate `requiredCapabilities` or `secretHandleIds`.
- rejects duplicate target/trust/fallback classes or extensions, fallback classes outside the allowed set, forbidden fallback with a non-empty order, and owner-bound credentials without a matching owner-desktop requirement;
- rejects every unknown placement enum and any class/trust/credential/locality combination not present in the exported compatibility matrix;
- rejects unknown critical extensions and every exact extension count/depth/item/key/canonical-UTF-8 byte overflow.

Export each workload schema, the union, and inferred types.

- [ ] **Step 6: Implement lease messages**

Create strict V1 schemas with the explicit bounded `extensions` field where safe additions are permitted:

```ts
LeaseOfferV1 = { protocolVersion: 1, workerId, leaseId, fenceToken, ackDeadline, expiresAt, job: JobEnvelopeV1 }
LeaseAckV1 = { protocolVersion: 1, workerId, jobId, attempt, leaseId, fenceToken, ackedAt }
LeaseRenewRequestV1 = { protocolVersion: 1, workerId, jobId, attempt, leaseId, fenceToken, observedAt }
LeaseRenewResponseV1 = { protocolVersion: 1, workerId, jobId, attempt, leaseId, fenceToken, expiresAt, cancelRequested, cancelReason nullable }
```

`LeaseOfferV1` rejects `ackDeadline >= expiresAt` and recursively forbidden keys. Other messages reject forbidden keys. Export inferred types.

- [ ] **Step 7: Export, verify, record, and commit PRT-003**

Run:

```powershell
pnpm --filter @armyofagents/worker-protocol exec vitest run src/wire-safety.test.ts src/source.test.ts src/job.test.ts
pnpm --filter @armyofagents/worker-protocol typecheck
pnpm --filter @armyofagents/worker-protocol build
pnpm check:worker-protocol-boundary
```

Expected: PASS.

Create `docs/replatform/epics/E1-worker-protocol/tickets/PRT-003-result.md`, recording every source-kind valid/invalid vector, opaque principal coverage, task-only run/issue enforcement, task execution-principal/assignee mismatch denial, and the explicit handoff of requester authorization to JOB-001/JOB-010; also record safe additive-field preservation, exact extension boundary±1 results, placement-matrix coverage, the 10,000-case secret-canary generator seed/count, and every forbidden credential-key/canary test.

```powershell
git add packages/worker-protocol/src docs/replatform/epics/E1-worker-protocol/tickets/PRT-003-result.md
git commit -m "feat: define worker job and lease envelopes"
```

---

### Task 4: PRT-004 — Sequenced Worker Events and Cumulative ACK

**Files:**
- Create: `packages/worker-protocol/src/canonical-json.ts`
- Create: `packages/worker-protocol/src/canonical-json.test.ts`
- Create: `packages/worker-protocol/src/events.ts`
- Create: `packages/worker-protocol/src/events.test.ts`
- Read (E0 fixtures, for cross-implementation digest equivalence): `tests/fixtures/distributed-execution/*.json`
- Modify: `packages/worker-protocol/src/index.ts`

**Interfaces:**
- Consumes: job/attempt/lease/fence/event identities and lifecycle states.
- Produces: RFC 8785 canonicalization/event-digest input helpers, `workerEventV1Schema`, `workerEventBatchV1Schema`, `workerEventAckV1Schema`, event payload types, and contiguous-sequence validation.

- [ ] **Step 1: Write failing event tests**

Create `events.test.ts` with a helper that fills common event fields:

```ts
const base = {
  protocolVersion: 1,
  eventId: "00000000-0000-4000-8000-000000000021",
  organizationId: "00000000-0000-4000-8000-000000000030",
  companyId: "00000000-0000-4000-8000-000000000031",
  workerId: "00000000-0000-4000-8000-000000000032",
  jobId: "00000000-0000-4000-8000-000000000022",
  attempt: 1,
  leaseId: "00000000-0000-4000-8000-000000000023",
  fenceToken: "d".repeat(43),
  seq: 1,
  occurredAt: "2026-08-07T00:00:01.000Z",
};
```

Assert:

- every event type below parses with its required payload;
- unknown event type fails;
- log message over 65,536 characters fails;
- nested credential-bearing key fails;
- safe additive fields survive parsing;
- RFC 8785 canonical bytes are stable across object-key insertion order and the required number, escape, and Unicode cases;
- the test SHA-256 of `canonicalEventDigestInputV1` equals `eventDigest`; changing identity, timestamp, type, payload, or extensions without recomputing fails receiver validation;
- **cross-implementation equivalence with the E0 fixtures (amendment: closes the two-canonicalizer seam):** load every expected event carrying an `eventDigest` from each `tests/fixtures/distributed-execution/*.json` (resolve from the repo root, same pattern PRT-006 `golden-journeys.test.ts` uses to read `schema-v1.json`) and assert this package's `canonicalEventDigestInputV1` + injected Node SHA-256 recomputes each fixture's exact committed digest; any mismatch fails the suite. This proves the E0 checker's `.mjs` canonicalizer and this package's `.ts` canonicalizer agree byte-for-byte on the locked golden vectors (lone surrogates, unsafe-integer boundary, duplicate keys, `-0` are included by FND-004);
- duplicate sequence/event ID inside one submitted batch fails; a retransmission of an already committed ID plus the same recomputed event digest is idempotent at the receiver;
- a gap from 1 to 3 fails;
- cumulative ACK requires `expectedNextSeq = acceptedThroughSeq + 1`;
- rejection ACK names the expected sequence and rejects negative values.

- [ ] **Step 2: Run event tests and verify RED**

Run:

```powershell
pnpm --filter @armyofagents/worker-protocol exec vitest run src/canonical-json.test.ts src/events.test.ts
```

Expected: FAIL because `canonical-json.ts` and `events.ts` do not exist.

- [ ] **Step 3: Implement the event discriminated union**

Implement dependency-free RFC 8785 canonical JSON in `canonical-json.ts`, with conformance vectors covering property order, numbers, escapes, and Unicode. `canonicalEventDigestInputV1` accepts a parsed event, removes only `eventDigest`, canonicalizes every remaining immutable field, and returns UTF-8 bytes. It must not accept an already stringified or unvalidated event. `verifyWorkerEventDigestV1` accepts an injected synchronous or asynchronous SHA-256 function and returns false on any supplied/recomputed mismatch. The package remains hash-provider neutral; tests use Node SHA-256, while worker and control-plane callers inject their platform implementation.

Define a strict base with `protocolVersion`, `eventId`, `organizationId`, `companyId`, `workerId`, `jobId`, `attempt`, `leaseId`, `fenceToken`, positive `seq`, `eventDigest`, `occurredAt`, and the explicit bounded extension field. The receiver authorizes all self-presented tenant/worker identities against its lease record; they are correlation fields, never independent authority. Extend it into these event/payload pairs:

```ts
attempt_started: { sandboxId }
log: { stream: "stdout" | "stderr" | "system", level: "debug" | "info" | "warn" | "error", message: string max 65536 }
progress: { message: string max 2000, percent: integer 0–100 nullable }  // integer, not float: the FND-004-locked eventDigest canonical subset (finite safe integers only) rejects floats, so a fractional percent would be undigestable / diverge between the two canonicalizers. Widening to a real number requires a Decision #121 change to the locked digest subset, not an E1-local edit.
usage: { inputTokens, outputTokens, cachedInputTokens, runtimeMillis; all non-negative integers }
artifact_prepared: { artifactId, kind: artifact-kind string }
browser_observation: { artifactIds, url nullable max 4096, title nullable max 1000 }
browser_approval_requested: { approvalId UUID, action max 200, summary max 4000 }
runtime_decision_requested: PermissionRuntimeDecisionRequestV1 | WorkQuestionRuntimeDecisionRequestV1
service_instance_started: { serviceId, serviceInstanceId, generation positive, providerResourceId }
service_health: { serviceId, serviceInstanceId, generation positive, status: "healthy" | "unhealthy", detail nullable max 4000 }
service_checkpoint_prepared: { artifactId, serviceId, serviceInstanceId, generation positive }
service_checkpoint_restored: { artifactId, serviceId, serviceInstanceId, generation positive }
service_graceful_stop_observed: { serviceId, serviceInstanceId, generation positive, deadline }
service_instance_stopped: { serviceId, serviceInstanceId, generation positive, exitCode nullable }
service_instance_lost: { serviceId, serviceInstanceId, generation positive, reason }
service_provider_interrupted: { serviceId, serviceInstanceId, generation positive, reason }
service_provider_resumed: { serviceId, serviceInstanceId, generation positive, providerResourceId }
network_denied: { destinationClass: "metadata" | "private" | "control_plane" | "not_allowlisted", reason max 1000 }
terminal: { status: "succeeded" | "failed" | "cancelled" | "expired", exitCode nullable integer, errorCode nullable max 100, errorMessage nullable max 4000 }
```

Add the service-instance transition and provider interruption/resume event payloads in the approved hardening amendment; do not encode `healthy`, `stopped`, or `lost` in `terminal`.

Combine them with `z.discriminatedUnion("eventType", ...)`. Apply recursive wire-safety refinement to every event.

Keep `usage` explicitly evidentiary: its strict payload rejects `costMicros`, provider, model, biller, billing type, rate/version, and rounding fields. JOB-012 joins the accepted event to immutable job/adapter/provider-registry facts and creates the idempotent authoritative charge server-side.

`runtime_decision_requested` is the request side of PRT-007's durable control. Define a strict union discriminated by `decisionKind`:

```ts
common: { requestId, nonce max 200 UTF-8 bytes, requestDigest: Sha256Digest, schemaVersion positive, sourceRevision non-negative safe integer, expiresAt, title max 500, summary nullable max 4000 }
permission: common & { decisionKind: "permission", timeoutPolicy: "deny" | "cancel_run" | "park_run" | "continue_with_default" | "escalate", defaultDecision: "allow_once" | "allow_run" | "deny" | null, toolName/command/cwd/path/networkTarget/riskClass nullable and individually bounded }
work_question: common & { decisionKind: "work_question", timeoutPolicy: "cancel_run" | "park_run" | "continue_with_default" | "escalate", promptText max 8000, options: max 32 strict { optionId max 200 UTF-8 bytes, label max 1000 UTF-8 bytes, value bounded JSON with canonical UTF-8 bytes <= 16 KiB and depth <= 8, isDefault boolean } }
```

The control plane stores and authorizes the request before returning `runtime_decision_result`; request ID, kind, nonce, digest, schema version, source revision, timeout policy, expiry, and any bound default must match exactly. For permission, `continue_with_default` requires non-null `defaultDecision`, every other timeout policy requires null, and `allow_always` is never a timeout default. For a work question, `continue_with_default` requires exactly one `isDefault: true` option; every other policy requires zero defaults. The default option's bounded `value` is the answer payload on timeout. The browser-specific product-approval event cannot substitute for this generic runtime-decision round trip. Reject unknown kinds, extra cross-kind fields, invalid timeout/default combinations, missing or multiple defaults, over-limit options, and digest reuse after any bound field changes. Permission `deny` and all non-default timeout paths fail closed before the governed effect.

- [ ] **Step 4: Implement batch and ACK constraints**

Define:

```ts
WorkerEventBatchV1 = {
  protocolVersion: 1;
  organizationId: OrganizationId;
  companyId: CompanyId;
  workerId: WorkerId;
  jobId: JobId;
  attempt: number;
  leaseId: LeaseId;
  fenceToken: FenceToken;
  events: WorkerEventV1[]; // 1–500
}

WorkerEventAckV1 = {
  protocolVersion: 1;
  organizationId: OrganizationId;
  companyId: CompanyId;
  workerId: WorkerId;
  jobId: JobId;
  attempt: number;
  leaseId: LeaseId;
  fenceToken: FenceToken;
  acceptedThroughSeq: number;
  expectedNextSeq: number;
  status: "accepted" | "gap" | "hash_mismatch" | "stale_fence" | "target_revoked" | "terminal";
  rejectedEventId?: EventId;
}
```

Batch refinement verifies every event repeats the batch Organization/Company/worker/job/attempt/lease/fence, event IDs are unique, and sequences are contiguous. ACK refinement echoes the same complete identity, verifies `expectedNextSeq === acceptedThroughSeq + 1`; `hash_mismatch` requires the conflicting `rejectedEventId`, and non-conflict statuses forbid it. Export canonicalization helpers, schemas, and inferred types. PRT-007 conformance vectors require receiver-side recomputation before ACK; JOB-005 must authorize every identity against the active lease and compare the recomputed digest with both the supplied digest and any stored event-ID digest in the same transaction.

- [ ] **Step 5: Export, verify, record, and commit PRT-004**

Run:

```powershell
pnpm --filter @armyofagents/worker-protocol exec vitest run src/canonical-json.test.ts src/events.test.ts
pnpm --filter @armyofagents/worker-protocol typecheck
pnpm --filter @armyofagents/worker-protocol build
pnpm check:worker-protocol-boundary
```

Create `docs/replatform/epics/E1-worker-protocol/tickets/PRT-004-result.md` with RFC 8785 vectors, digest recomputation/mutation, event-type coverage, sequence-gap, duplicate, ACK, additive, forbidden-key, and E0-fixture cross-implementation digest-equivalence evidence (record the fixture count checked and confirm every committed `eventDigest` was reproduced byte-for-byte).

```powershell
git add packages/worker-protocol/src docs/replatform/epics/E1-worker-protocol/tickets/PRT-004-result.md
git commit -m "feat: define worker event protocol"
```

---

### Task 5: PRT-005 — Workspace, Artifact, Secret, Resource, and Network Contracts

**Files:**
- Create: `packages/worker-protocol/src/policy.ts`
- Create: `packages/worker-protocol/src/policy.test.ts`
- Create: `packages/worker-protocol/src/artifacts.ts`
- Create: `packages/worker-protocol/src/artifacts.test.ts`
- Modify: `packages/worker-protocol/src/index.ts`

**Interfaces:**
- Consumes: branded IDs, digests, fence identity, and wire-safety refinement.
- Produces: validated resource/network/secret/retention/offline policies, attributable workspace/artifact/patch manifests, scoped upload/download grants, fenced artifact-commit payload, and separate device-auth quarantine grant/finalize/receipt payloads.

- [ ] **Step 1: Write failing policy tests**

Create `policy.test.ts` asserting:

- default network action must be `deny`;
- `denyPrivateNetworks`, `denyMetadata`, and `denyControlPlane` must all be true in v1;
- allow rules accept HTTPS host/port only, with lowercase DNS names and no IP literals;
- resource limits reject zero, negative, and above-ceiling values;
- secret refs contain handle ID, materialization kind, use policy, and target name but reject values/credentials;
- connector OAuth access/refresh tokens and broker token bundles are rejected recursively, while an opaque handle with proxy materialization is accepted;
- env targets match `^[A-Z_][A-Z0-9_]*$`;
- file targets are absolute sandbox paths under `/run/aoa-secrets/` and contain no `..`;
- proxy materialization has no env/file target;
- remote credential use is `fence_proxy` or `remote_server_fenced`; `sandbox_local_only` cannot authorize a network destination, and raw direct-provider materialization is unrepresentable;
- offline and retention enums contain only locked values.

- [ ] **Step 2: Write failing artifact/workspace tests**

Create `artifacts.test.ts` asserting:

- workspace paths are relative POSIX paths with no empty, `.`, `..`, backslash, absolute, drive, or NUL segment;
- a dependency-free seeded path generator runs at least 10,000 POSIX/Windows/UNC/traversal/symlink/case candidates with a recorded seed/count and zero escape acceptance;
- symlink entries are rejected in v1;
- duplicate/case-colliding workspace paths fail;
- object keys must equal `organizations/<org>/jobs/<job>/attempts/<attempt>/...`;
- wrong Organization/job/attempt prefix fails at commit;
- artifact size/hash and active fence fields are required;
- every V1 artifact kind, including `other`, requires `sensitivity: "restricted"`; relabeling customer/browser/secret-bearing bytes cannot obtain a weaker policy. A future normal/public kind requires a named schema addition and policy decision;
- patch manifest requires base/result hashes and describes create/modify/delete/rename operations;
- upload, download, and quarantine grant expiration is after issuance, method matches operation, bytes/hash/prefix are bound, grants are marked secret for redaction, and headers reject credential-bearing keys;
- ordinary commit schema requires complete active-fence identity. Staleness is authoritative receiver state, so PRT-007/JOB-004/DAT-002 tests reject a mismatching current fence; a Zod object alone must not claim to know staleness;
- quarantine grant uses its distinct attempt prefix, authenticates target/device generation rather than a live lease, and binds exact Organization/job/attempt/observed lease+fence/artifact/hash/size with a maximum five-minute expiry;
- quarantine finalize is idempotent, HEAD-verifies object prefix/hash/size before issuing a receipt, and accepts only a declared quarantine reason;
- no quarantine schema contains an apply, promote, select-checkpoint, or attempt-mutation field; a stale worker cannot use the ordinary transfer-grant or commit operation.

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
pnpm --filter @armyofagents/worker-protocol exec vitest run src/policy.test.ts src/artifacts.test.ts
```

Expected: FAIL because both modules do not exist.

- [ ] **Step 4: Implement policy schemas**

Create `policy.ts` with strict security-critical schemas, explicit bounded extensions only where the amendment permits them, and inferred types:

```ts
resourceLimitsSchema
networkAllowRuleSchema = { scheme: "https", host, port: 443 | positive <= 65535 }
networkPolicyV1Schema = { policyId, version, digest, defaultAction: "deny", allow, denyPrivateNetworks: true, denyMetadata: true, denyControlPlane: true }
networkPolicyRefSchema = { policyId, version, digest }
secretMaterializationSchema = discriminated union "proxy" | "env" | "file"
secretHandleRefSchema = { handleId, materialization, usePolicy: "fence_proxy" | "remote_server_fenced" | "sandbox_local_only" }
artifactRetentionClassSchema = "ephemeral" | "run" | "audit" | "checkpoint"
offlinePolicySchema = "cancel" | "finish_without_remote_effects" | "continue_until_lease_expiry"
```

Every object uses recursive wire-safety. `secretHandleRefSchema` is provider-neutral: connector OAuth discovery, refresh leases, token bundles, rotation, and revocation remain owned by the existing control-plane broker; the wire contract exposes no OAuth token fields. Remote governed use is admitted only through a per-request fence proxy or a remote capability whose server validates the live fence; `env`/`file` may contain only that opaque capability or sandbox-local material. Keep the v1 limits equal to the job envelope limits from PRT-003. Export inferred types.

- [ ] **Step 5: Implement artifact and workspace schemas**

Create `artifacts.ts` exporting:

```ts
WORKSPACE_ENTRY_KINDS = ["file", "directory"]
ARTIFACT_KINDS = ["workspace_snapshot", "workspace_patch", "log", "screenshot", "dom_snapshot", "browser_cookie_state", "browser_storage_state", "playwright_trace", "browser_video", "download", "service_checkpoint", "other"]
RESTRICTED_ARTIFACT_KINDS = every V1 artifact kind, including "other"
artifactSensitivitySchema = "restricted"
workspaceBaseV1Schema
workspaceEntrySchema
workspaceManifestV1Schema
patchOperationSchema
workspacePatchManifestV1Schema
artifactManifestV1Schema
artifactTransferGrantRequestV1Schema
artifactUploadGrantV1Schema
artifactDownloadGrantV1Schema
artifactCommitPayloadV1Schema
quarantineGrantPayloadV1Schema
quarantineUploadGrantV1Schema
quarantineFinalizePayloadV1Schema
quarantineUploadReceiptV1Schema
expectedAttemptObjectPrefix(input): string
expectedQuarantineObjectPrefix(input): string
```

Use these required shapes:

```ts
WorkspaceBaseV1 = { kind: "git_commit" | "content_manifest", algorithm: "git_sha1" | "git_sha256" | "sha256", revision, dirty, caseMode: "sensitive" | "insensitive_preserving", ignorePolicy: { kind: "gitignore_plus_aoa" | "explicit", digest }, inclusion: { tracked: true, untracked: "include" | "exclude", ignored: false } }
WorkspaceEntry = { path, kind, provenance: "tracked" | "untracked" | "generated", sizeBytes, sha256 nullable, executable }
WorkspaceManifestV1 = { protocolVersion: 1, organizationId, companyId, artifactId, base, snapshotProvenance: { capturedAt, sourceTargetId, folderGrantId nullable, captureToolVersion }, entries }
PatchOperation = create/modify/delete with path, or rename with path/fromPath; create/modify/rename include resultSha256 and sizeBytes
WorkspacePatchManifestV1 = { protocolVersion: 1, organizationId, companyId, jobId, attempt, artifactId, base: WorkspaceBaseV1, baseManifestHash, resultManifestHash, operations }
ArtifactManifestV1 = { protocolVersion: 1, organizationId, companyId, jobId, attempt, artifactId, kind, sensitivity, retention, objectKey, sizeBytes, sha256, contentType, createdAt }
ArtifactTransferGrantRequestV1 = { protocolVersion: 1, operation: "upload" | "download", workerId, jobId, attempt, leaseId, fenceToken, artifactId, expectedObjectKey, expectedSha256, maxBytes }
ArtifactUploadGrantV1 = { protocolVersion: 1, operation: "upload", artifactId, method: "PUT", url, headers, issuedAt, expiresAt, maxBytes, expectedSha256, objectKey, redaction: "secret" }
ArtifactDownloadGrantV1 = { protocolVersion: 1, operation: "download", artifactId, method: "GET", url, headers, issuedAt, expiresAt, maxBytes, expectedSha256, objectKey, redaction: "secret" }
ArtifactCommitPayloadV1 = { protocolVersion: 1, workerId, jobId, attempt, leaseId, fenceToken, manifest }
QuarantineGrantPayloadV1 = { protocolVersion: 1, workerId, targetId, deviceGeneration, organizationId, companyId, jobId, attempt, observedLeaseId, observedFenceToken, reason, artifactId, expectedObjectKey, expectedSha256, sizeBytes }
QuarantineUploadGrantV1 = { protocolVersion: 1, operation: "quarantine_upload", artifactId, method: "PUT", url, headers, issuedAt, expiresAt max five minutes, maxBytes equals sizeBytes, expectedSha256, quarantineObjectKey, redaction: "secret" }
QuarantineFinalizePayloadV1 = { protocolVersion: 1, workerId, targetId, deviceGeneration, organizationId, companyId, jobId, attempt, observedLeaseId, observedFenceToken, reason, artifactId, quarantineObjectKey, expectedSha256, sizeBytes, manifest }
QuarantineUploadReceiptV1 = { protocolVersion: 1, receiptId, quarantineObjectKey, observed: { workerId, targetId, deviceGeneration, jobId, attempt, leaseId, fenceToken }, artifact: { artifactId, sha256, sizeBytes, sensitivity, provenance }, reason, receivedAt, disposition: "quarantined" }
```

Add the base-kind/algorithm/revision, inclusion/provenance/ignore/case, prefix, path, case-collision, sensitivity, transfer-operation, timestamp, and forbidden-key refinements from Step 2. An ordinary grant payload carries the active fence but does not itself decide whether that fence is current. Quarantine uses only the device-auth operation wrappers from PRT-007, never an ordinary lease grant.

- [ ] **Step 6: Reuse canonical policy schemas from job envelopes**

Modify `job.ts` to import `resourceLimitsSchema`, `networkPolicyRefSchema`, `secretHandleRefSchema`, and `offlinePolicySchema` from `policy.ts`. Change `secretHandleIds` to `secretHandles: secretHandleRefSchema.array().max(64)`. Update job tests so the batch fixture uses:

```ts
secretHandles: [{
  handleId: "00000000-0000-4000-8000-000000000016",
  materialization: { kind: "proxy" },
  usePolicy: "fence_proxy",
}]
```

This is the one planned additive refinement to PRT-003 before the contract is frozen. Do not retain both fields.

- [ ] **Step 7: Export, verify, record, and commit PRT-005**

Run:

```powershell
pnpm --filter @armyofagents/worker-protocol exec vitest run src/job.test.ts src/policy.test.ts src/artifacts.test.ts
pnpm --filter @armyofagents/worker-protocol typecheck
pnpm --filter @armyofagents/worker-protocol build
pnpm check:worker-protocol-boundary
```

Create `docs/replatform/epics/E1-worker-protocol/tickets/PRT-005-result.md` with the 10,000-case path seed/count, malicious path/prefix, sensitivity, secret materialization, network denial, and canonical job-schema evidence.

```powershell
git add packages/worker-protocol/src docs/replatform/epics/E1-worker-protocol/tickets/PRT-005-result.md
git commit -m "feat: define worker data and policy contracts"
```

---

### Task 6: PRT-006 — Registered Target, Capability Negotiation, and Initial Conformance Corpus

**Files:**
- Create: `packages/worker-protocol/src/capabilities.ts`
- Create: `packages/worker-protocol/src/capabilities.test.ts`
- Modify: `packages/worker-protocol/src/version.ts`
- Create: `packages/worker-protocol/src/version.test.ts`
- Create: `packages/worker-protocol/src/contract.test.ts`
- Create: `packages/worker-protocol/src/golden-journeys.test.ts`
- Modify: `packages/worker-protocol/src/index.ts`
- Create: `docs/contracts/worker-protocol/v1/conformance.json`
- Create: `docs/contracts/worker-protocol/v1/README.md`
- Create: `docs/contracts/worker-protocol/v1/manifest.sha256`
- Create: `scripts/update-worker-protocol-contract-manifest.mjs`
- Create: `scripts/update-worker-protocol-contract-manifest.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.gitattributes`
- Modify: `.github/workflows/pr.yml`

**Interfaces:**
- Consumes: all PRT-001–PRT-005 schemas and E0 golden journeys.
- Produces: scoped registered target and normalized provider-constraint profiles, dynamic worker hello/capacity schemas, intersection matching, protocol-range/must-understand negotiation, initial v1 vectors/hashes, and public exports consumed by PRT-007.

- [ ] **Step 1: Write failing capability and version tests**

Create `capabilities.test.ts` covering:

```ts
capability names: workload.batch, workload.browser_session, workload.service,
provider.lifecycle_v1, provider.cleanup_v1, provider.checkpoint_v1, provider.health_v1,
artifact.direct_upload, secret.proxy,
sandbox.filesystem_isolated, sandbox.process_isolated, sandbox.filtered_egress
```

Assert `registeredTargetProfileV1` requires server-assigned scope/class, conditional Organization/owner binding, trust/credential/locality ceilings, provider-constraint reference, device generation, revocation state, and provider-neutral capability ceiling. Provider identity/allowlist, region, template, and credentials remain in the control-plane registry and never appear in job/lease/hello fields or a closed capability enum. Cover every allowed and forbidden row in the closed V1 placement matrix, valid/invalid `platform`, `organization`, and `owner` field combinations, and multiple Organization-scoped logical profiles for one device. Recompute the provider-profile digest through the injected SHA-256 verifier; changing runtime, resource, operation, locality, checkpoint, or health data while reusing the old digest returns no verified profile and cannot enter matching. Add a compile-time negative case proving the matcher rejects a raw parsed profile. Every profile supports the core provider operations `create`, `execute`, `cancel`, `kill`, `destroy`, `list`, `inspect`, and `reconcile_cleanup`; optional values are `checkpoint`, `restore`, and `health`. Checkpoint and restore appear together and require a non-`none` checkpoint mode; health requires a non-`none` health mode. Unknown operations and a profile missing a core operation fail. Worker hello requires worker/target IDs, device generation, agent version, protocol min/max, platform OS/arch, reported provider-neutral capabilities, and non-negative slots/resources. `workerSatisfiesRequirements` returns false for a report outside the registered or resolved provider ceiling, profile hash mismatch, runtime/resource/operation/locality mismatch, owner/generation mismatch, revocation, missing capability, insufficient capacity, policy mismatch, or non-overlapping protocol range. A malicious claim of stronger isolation/lifecycle/cleanup/checkpoint capability, a larger runtime, or a different locality never changes the registered profile.

Create `version.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { negotiateProtocolVersion } from "./version.js";

describe("protocol version negotiation", () => {
  it("chooses the highest overlapping version", () => {
    expect(negotiateProtocolVersion({ min: 1, max: 3 }, { min: 2, max: 4 })).toBe(3);
  });
  it("negotiates an N-1 range for a safe additive rollout (not the frozen-consumer proof)", () => {
    expect(negotiateProtocolVersion({ min: 1, max: 2 }, { min: 1, max: 1 })).toBe(1);
  });
  it("returns null without overlap", () => {
    expect(negotiateProtocolVersion({ min: 2, max: 3 }, { min: 1, max: 1 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm --filter @armyofagents/worker-protocol exec vitest run src/capabilities.test.ts src/version.test.ts
```

Expected: FAIL because capability schemas and negotiation do not exist.

- [ ] **Step 3: Implement worker hello and requirement matching**

Create `capabilities.ts` exporting:

```ts
KNOWN_WORKER_CAPABILITIES
workerCapabilitySchema
workerCapacitySchema = { batchSlots, browserSessionSlots, serviceSlots, freeCpuMillis, freeMemoryMiB, freeDiskMiB }
workerPlatformSchema = { os: "linux" | "darwin" | "windows", arch: "x64" | "arm64", runtime: non-empty max 100 }
providerConstraintProfileRefV1Schema = { profileId, version positive, digest }
PROVIDER_OPERATIONS = ["create", "execute", "cancel", "kill", "destroy", "list", "inspect", "reconcile_cleanup", "checkpoint", "restore", "health"]
providerConstraintProfileV1Schema = { profileId, version, digest, maxContinuousRuntimeSeconds, maxIdleSeconds, resourceCeiling, maxConcurrentOperations, supportedOperations, localityTags, checkpointMode: "none" | "snapshot" | "application", healthMode: "none" | "poll" | "stream" }
canonicalProviderConstraintProfileDigestInputV1(profile): Uint8Array
verifyAndBrandProviderConstraintProfileV1(profile, sha256Fn): Promise<VerifiedProviderConstraintProfileV1 | null>
registeredTargetProfileV1Schema = { protocolVersion: 1, targetId, targetClass, scope: "platform" | "organization" | "owner", organizationId nullable, ownerPrincipalId nullable, trustCeiling, credentialCeiling, dataLocalityCeiling, providerConstraints, capabilityCeiling, deviceGeneration, revokedAt nullable, policyHash }
workerHelloV1Schema = { protocolVersion: 1, workerId, targetId, deviceGeneration, agentVersion, supportedProtocol: { min, max }, platform, reportedCapabilities, capacity, policyHash }
targetRequirementsV1Schema = the canonical PRT-003 target-requirements schema
jobCapabilityRequirementsSchema = { protocol: { min, max }, capabilities, workloadType, targetRequirements, policyHash, mustUnderstand }
workerSatisfiesRequirements(profile, verifiedProviderConstraints: VerifiedProviderConstraintProfileV1, worker, requirements): boolean
```

Conditional scope validation is strict: `platform` has null Organization/owner, `organization` has an Organization and null owner, and `owner` has both. The matcher first verifies target identity/generation/revocation, profile/reference hash equality, and server ceilings; then protocol/policy/must-understand overlap; then the intersection of normalized provider runtime/resource/operation/locality ceilings, registered/reported capabilities, owner/locality/credential constraints, and available workload resources/slots. Provider-native region/template IDs never enter a common job or worker message.

- [ ] **Step 4: Implement range negotiation**

Extend `version.ts`:

```ts
export interface ProtocolVersionRange { min: number; max: number }

export function negotiateProtocolVersion(
  controlPlane: ProtocolVersionRange,
  worker: ProtocolVersionRange,
): number | null {
  const highest = Math.min(controlPlane.max, worker.max);
  const lowest = Math.max(controlPlane.min, worker.min);
  return highest >= lowest ? highest : null;
}
```

Reject invalid ranges in the Zod schemas that consume them; the pure function assumes validated positive integer ranges.

- [ ] **Step 5: Create the checked-in conformance corpus**

Before creating any contract bytes, add `docs/contracts/worker-protocol/v1/** text eol=lf` to `.gitattributes`. Generate and verify the manifest only after a fresh checkout/renormalization confirms those inputs are LF; hashes must be identical on Windows and Linux.

Create `docs/contracts/worker-protocol/v1/conformance.json` with `contractVersion: "1.0.0"` and these named cases:

1. `valid task-run batch job` — full final PRT-005 batch envelope with task-only run/issue and matching assignee, accepted by `jobEnvelopeV1Schema`.
2. `valid Commander-turn batch job` — conversation/internal-run provenance with no issue/run fields, accepted.
3. `valid crew-run batch job` — crew provenance with typed requester/executor, accepted.
4. `valid one-shot extraction job` — operation provenance with no fabricated issue/run, accepted.
5. `valid browser-request job with safe optional extension` — accepted, and `extensions[{namespace:"aoa.example", critical:false}]` remains in parsed output.
6. `valid service-reconcile job` — service/generation/reconciliation provenance plus workload fields, accepted.
7. `reject fabricated non-task run and issue` — extra task-only identity on a non-task source, rejected.
8. `reject task executor or assignee mismatch` — an agent execution principal whose string value differs from the UUID-branded assignee is rejected; authenticated/domain requester authorization is exercised later by JOB-001/JOB-010.
9. `reject unknown source or workload` — unknown discriminants, rejected.
10. `reject nested plaintext api key and known secret canary` — reserved key is rejected by schema and a canary inside argv is rejected by the producer-safety helper.
11. `valid lease offer` — matching offer/job identity and ACK-before-expiry, accepted.
12. `reject inverted lease times` — ACK deadline equal to or later than expiry, rejected.
13. `valid contiguous event batch` — sequences 1 and 2, accepted.
14. `reject event sequence gap` — sequences 1 and 3, rejected.
15. `valid registered target plus worker hello intersection` — batch/provider-lifecycle/filesystem-isolation/filtered-egress/direct-upload/proxy capabilities are inside the server ceiling and one batch slot is reported; provider identity remains registry-side.
16. `reject unknown job terminal state vector` — a terminal event with status `done`, rejected.
Each case has:

```ts
{
  name: string;
  schema: "job" | "lease_offer" | "event_batch" | "target_worker_pair";
  valid: boolean;
  preserveKeys?: string[];
  input: unknown;
}
```

Use the fixed UUID/timestamp/hash/fence values from PRT-003 and PRT-004 tests. Do not use real credentials or URLs.

The syntax schema deliberately accepts any well-formed Organization UUID; it cannot know whether an ID is reserved, mapped, or authorized. Do not add a false sentinel-rejection case to this four-schema corpus. TEN-006 removes and backfills the sentinel default, and JOB-001/JOB-010 own policy conformance that rejects sentinel/unmapped admission and requester-authority mismatch before job creation.

Create `docs/contracts/worker-protocol/v1/README.md` documenting additive-only v1 evolution, unknown enum rejection, manifest regeneration, and Protocol Custodian approval for byte changes.

- [ ] **Step 6: Write failing conformance and E0 golden-journey tests**

Create `contract.test.ts` that loads `conformance.json`, maps `schema` to the four schemas, asserts `safeParse().success === valid`, checks `preserveKeys` on accepted objects, and verifies `manifest.sha256` against exact bytes with `node:crypto`.

Add exact test-only validators to the package and lockfile:

```powershell
pnpm --filter @armyofagents/worker-protocol add --save-dev --save-exact ajv@8.18.0 ajv-formats@3.0.1
```

Create `golden-journeys.test.ts` using `Ajv2020` from `ajv/dist/2020.js` plus `ajv-formats`. Read and compile `tests/fixtures/distributed-execution/schema-v1.json` once, fail with formatted Ajv errors, and validate all nine fixture objects before semantic assertions. Add an invalid-mutation table for a missing tenant/owner, bad UUID/timestamp/digest, duplicate/dangling event identity, cross-tenant artifact prefix, cost overflow, and absent cleanup/forbidden-effects field so a skipped or permissive schema cannot pass. Then assert:

- schemaVersion is 1;
- ID matches filename;
- workload type parses through `workloadTypeSchema`;
- the fixture's declared `source.kind` is a member of the `ExecutionSourceV1` discriminant set and satisfies the FND-007 parity reference (E1-D002). This is kind/enum-membership parity, not a full-object parse: the FND-004 fixture `source` is `{ kind, runId?, issueId? }` with ULID-style IDs and no typed principals, so it deliberately does not round-trip through the full `executionSourceV1Schema`;
- every `emits` value is a member of the exported known distributed-execution emission vocabulary — the worker-event type union PLUS the frozen non-event operation/receipt emission names present in the FND-004 fixtures: `artifact_transfer_rejected`, `quarantine_grant_issued`, `quarantine_receipt_finalized`, `replacement_lease_activated`. Journey-level `expectedEvents[].eventType` values that are control-plane events rather than worker wire events (`budget_exhausted`, `lease_lost`, `cancel_requested`, `producer_safety_rejected`, `provider_pause_observed`) are NOT forced into the worker-event union;
- expected terminal state belongs to the relevant batch/browser/service terminal/status set;
- forbidden effects and audit actions are non-empty.

Run both tests before creating `manifest.sha256`.

Expected: conformance test FAILS because the manifest is missing; golden journeys pass once the emission vocabulary spans the worker-event union plus the frozen non-event operation/receipt names (`network_denied` is inside the worker-event union; `artifact_transfer_rejected`, `quarantine_grant_issued`, `quarantine_receipt_finalized`, `replacement_lease_activated` are the operation/receipt additions).

- [ ] **Step 7: Add deterministic manifest generation**

Create `scripts/update-worker-protocol-contract-manifest.mjs`. It exports pure `validateContractTextBytes()` and `buildManifestBytes()` helpers for the mutation corpus and supports a non-writing `--check` mode:

```js
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const directory = path.join(process.cwd(), "docs", "contracts", "worker-protocol", "v1");
const files = ["conformance.json"].sort((a, b) => a.localeCompare(b, "en"));
const lines = [];
for (const file of files) {
  if (file.includes("\\") || path.posix.basename(file) !== file) throw new Error(`non-POSIX contract path: ${file}`);
  const bytes = await readFile(path.join(directory, file));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) throw new Error(`${file}: UTF-8 BOM is forbidden`);
  if (text.includes("\r")) throw new Error(`${file}: CR/CRLF is forbidden; contract bytes must be LF`);
  if (!text.endsWith("\n")) throw new Error(`${file}: final LF is required`);
  lines.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`);
}
const manifest = new TextEncoder().encode(`${lines.join("\n")}\n`);
// In --check mode compare manifest byte-for-byte and exit nonzero; otherwise write it.
```

`scripts/update-worker-protocol-contract-manifest.test.mjs` uses isolated temporary inputs and proves valid UTF-8/LF bytes produce the same digest independent of host OS while CRLF, lone CR, BOM, invalid UTF-8, missing final LF, unsorted/Windows-style paths, altered bytes, and a stale manifest all fail. The generator never hashes `manifest.sha256` into itself.

Add:

```json
"gen:worker-protocol-contract": "node scripts/update-worker-protocol-contract-manifest.mjs"
```

Run:

```powershell
pnpm gen:worker-protocol-contract
node --test scripts/update-worker-protocol-contract-manifest.test.mjs
node scripts/update-worker-protocol-contract-manifest.mjs --check
pnpm --filter @armyofagents/worker-protocol exec vitest run src/capabilities.test.ts src/version.test.ts src/contract.test.ts src/golden-journeys.test.ts
```

Expected: PASS.

Add a dependency-free `worker-protocol-contract-bytes` matrix in `.github/workflows/pr.yml` for `ubuntu-latest` and `windows-latest`. Each checkout runs the mutation test and generator `--check` mode against the committed bytes. Either platform rejecting bytes or producing a manifest mismatch fails the job; no generated bytes are committed from CI.

- [ ] **Step 8: Export the complete public API and verify the epic**

Update `index.ts` to explicitly export every public constant, schema, predicate, helper, and inferred type from `ids`, `states`, `job`, `events`, `policy`, `artifacts`, `capabilities`, and `version`. Do not use `export *`; explicit exports make review of wire-surface changes visible.

Run:

```powershell
pnpm --filter @armyofagents/worker-protocol test:run
pnpm --filter @armyofagents/worker-protocol typecheck
pnpm --filter @armyofagents/worker-protocol build
pnpm check:worker-protocol-boundary
pnpm check:distributed-foundation
```

Expected: PASS.

- [ ] **Step 9: Record and commit PRT-006**

Create `docs/replatform/epics/E1-worker-protocol/tickets/PRT-006-result.md`. Record registered-vs-reported capability/provider-policy matrices, all initial conformance vectors, manifest digest, all nine E0 fixtures, package build/typecheck/tests, and boundary result. State that PRT-007 owns transport/errors and the complete-v1 frozen baseline/future compatibility harness.

```powershell
git add packages/worker-protocol/src docs/contracts/worker-protocol/v1 scripts/update-worker-protocol-contract-manifest.mjs scripts/update-worker-protocol-contract-manifest.test.mjs package.json pnpm-lock.yaml .gitattributes .github/workflows/pr.yml docs/replatform/epics/E1-worker-protocol/tickets/PRT-006-result.md
git commit -m "feat: define worker capability negotiation"
```

---

### Task 7: PRT-007 — Transport, Control, Error, and Frozen Cross-version Contract

**Files:**
- Create: `packages/worker-protocol/src/transport.ts`
- Create: `packages/worker-protocol/src/transport.test.ts`
- Create: `packages/worker-protocol/src/errors.ts`
- Create: `packages/worker-protocol/src/errors.test.ts`
- Create: `packages/worker-protocol/src/cross-version.test.ts`
- Modify: `packages/worker-protocol/src/job.ts`
- Modify: `packages/worker-protocol/src/artifacts.ts`
- Modify: `packages/worker-protocol/src/contract.test.ts`
- Modify: `packages/worker-protocol/src/index.ts`
- Extend: `docs/contracts/worker-protocol/v1/conformance.json`
- Create: `docs/contracts/worker-protocol/v1/operations.md`
- Create: `tests/fixtures/worker-protocol-consumers/v1/package.json`
- Create: `tests/fixtures/worker-protocol-consumers/v1/dist/` from the reviewed complete PRT-007 v1 source commit created in Step 4; it must import no current protocol source
- Create: `tests/fixtures/worker-protocol-consumers/v1/manifest.sha256`
- Create: `tests/fixtures/worker-protocol-consumers/v1/dependency-lock.json`
- Create: `scripts/freeze-worker-protocol-consumer.mjs`
- Create: `scripts/check-frozen-worker-protocol-consumer.mjs`
- Create: `scripts/check-frozen-worker-protocol-consumer.test.mjs`
- Modify: `.gitattributes`
- Modify: `scripts/update-worker-protocol-contract-manifest.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: every PRT-001 through PRT-006 schema and the registered target/worker negotiation result.
- Produces: framework-neutral operation schemas, stable error/control codes, command sequencing/ACK, an independent complete-v1 baseline, and the bidirectional compatibility harness required for later contract changes.

- [ ] **Step 1: Write failing transport/control/error tests**

Define tests for these exact schema families:

```ts
EnrollmentRequestV1 / EnrollmentResponseV1
PollRequestV1 / PollResponseV1 = offer | no_work | drain
LeaseAckOperationRequestV1(body: LeaseAckV1) / LeaseAckOperationResponseV1
LeaseRenewOperationRequestV1(body: LeaseRenewRequestV1) / LeaseRenewOperationResponseV1(body: LeaseRenewResponseV1)
EventUploadOperationRequestV1(body: WorkerEventBatchV1) / EventUploadOperationResponseV1
ArtifactTransferGrantOperationRequestV1(body: ArtifactTransferGrantRequestV1) / ArtifactTransferGrantOperationResponseV1 = upload_granted | download_granted | rejected
ArtifactCommitOperationRequestV1(body: ArtifactCommitPayloadV1) / ArtifactCommitOperationResponseV1 = committed | rejected
QuarantineGrantOperationRequestV1(body: QuarantineGrantPayloadV1) / QuarantineGrantOperationResponseV1 = quarantine_upload_granted | rejected
QuarantineFinalizeOperationRequestV1(body: QuarantineFinalizePayloadV1) / QuarantineFinalizeOperationResponseV1 = quarantined(receipt) | rejected
ControlCommandV1 = cancel | product_approval_result | runtime_decision_result | checkpoint | graceful_stop | drain
ControlCommandAckV1
ControlReceiverStateV1 / ControlReceiverDecisionV1 = accept | replay | gap | conflict | stale
EventReceiverStateV1 / EventReceiverDecisionV1 = accept | replay | gap | hash_mismatch | stale_fence | terminal
ProtocolErrorV1
```

Every operation request/response wrapper includes `protocolVersion`, correlation ID, idempotency key where mutation can be retried, and the full delivery identity applicable to the operation. Its `body` is the strict domain payload owned by PRT-003/004/005; payloads are never transmitted bare and are not structurally spread/extended. Enrollment and polling include audience and target/device generation. Mutating requests include a bounded anti-replay timestamp and nonce. `no_work`, throttling, and retryable errors carry bounded `retryAfterMs` and `serverTime`.

Export pure receiver-decision functions taking prior accepted sequence plus bounded command/event ID and idempotency records. Assert command sequence is monotonic; the same ID/key/body returns `replay`, changed body returns `conflict`, a skipped sequence returns `gap`, and ACK echoes command ID/sequence plus `accepted | completed | rejected | stale`. Event decision first recomputes `eventDigest`, then applies fence/terminal/sequence/idempotency rules; the same ID/digest replays and a changed digest is `hash_mismatch`. These functions specify receiver behavior for later transactional implementations; Zod alone is not claimed to remember prior state. Cancellation, product approval, runtime decision, checkpoint, graceful stop, and drain are durable controls; a lost response can be retried without duplicating the effect.

Keep product approvals and runtime decisions separate. `product_approval_result` carries the durable approval ID, approval kind/version, `approved | rejected | expired`, typed deciding principal, decision timestamp, and idempotency identity; it cannot authorize a different governed action. `runtime_decision_result` answers a previously accepted `runtime_decision_requested` event and repeats the bound request ID, kind, nonce, request digest, schema version, source revision, expiry, timeout policy, typed deciding principal, decision timestamp, and idempotency identity. It is a strict kind union: permission carries exactly `allow_once | allow_run | allow_always | deny | expired | cancelled`; work-question carries `answered | expired | cancelled` and a required answer only for `answered`, bounded to canonical UTF-8 bytes <= 16 KiB and depth <= 8. The control plane owns run-scoped and persistent trust-grant effects of `allow_run`/`allow_always`; the worker receives the exact decision but gains no authority beyond the current fenced command. Missing request state, cross-kind fields, source-revision/nonce/digest/version/timeout mismatch, over-limit answer, or a late answer fails closed. The worker may request a runtime decision but cannot create the authoritative decision or self-approve it. Neither control overrides budget/completion policy or treats an ACK as product authorization.

Operation pairing is closed: ordinary commit can return only `committed | rejected`; device-authenticated quarantine grant can return only an exact short-lived PUT grant or rejection, and finalize can return only its verified receipt or rejection; no stale ordinary commit is automatically converted to quarantine. Ordinary transfer grants require a current fence and return exactly the matching GET/PUT grant or rejection. Quarantine wrappers use a device-session audience/target generation, exact idempotency, a separate prefix, and no live-lease claim; finalize verifies stored hash/size/prefix before receipt.

Stable errors are:

```ts
malformed | unauthorized | incompatible_protocol | incompatible_capability |
incompatible_policy | stale_fence | sequence_gap | target_revoked |
event_hash_mismatch | throttled | payload_too_large | attempt_terminal |
internal_unavailable
```

Unknown error/control/status codes fail closed. Error details are bounded, redacted, and never disclose whether a foreign tenant resource exists.

- [ ] **Step 2: Verify RED, then implement strict schemas**

Run:

```powershell
pnpm --filter @armyofagents/worker-protocol exec vitest run src/transport.test.ts src/errors.test.ts
```

Expected RED: modules do not exist. Implement strict operation wrappers with only the approved extension container, nest the canonical job/lease/event/artifact payload schemas, and keep HTTP method/path/status concerns out of the package. Rename the PRT-005 commit/quarantine request objects to the payload names above; do not create a second schema with a colliding public name. Extend `contract.test.ts` so every new operation/control/error conformance vector maps to its exact wrapper/response/error schema and operation-document row. Re-run `transport.test.ts`, `errors.test.ts`, `artifacts.test.ts`, `job.test.ts`, and `contract.test.ts` until GREEN.

- [ ] **Step 3: Document the operation matrix**

Create `operations.md` with one row per operation: request, success/no-work response, authentication audience, correlation/idempotency, retry rule, payload ceiling, client timeout, stable errors, secret/existence redaction, and control ACK behavior. The checker/test compares every exported operation to a row so documentation cannot silently omit an operation.

- [ ] **Step 4: Complete and commit the v1 source surface**

Add valid/invalid vectors for no-work, retry-after/server-time, lost response/replay/conflict, every execution-source variant, product-approval versus runtime-decision separation, permission and work-question request/result round trips, all four permission decisions, bounded work-question answers/options, every timeout policy, valid permission/work-question defaults, missing/multiple/invalid defaults, forbidden `allow_always` timeout default, initial `sourceRevision=0`, stale/wrong revision, absent runtime-decision request, cross-kind/nonce/digest/version/TTL/default mismatch, command/ACK, transfer-grant operation mismatch, quarantine grant/finalize pairing, commit-versus-quarantine separation, revocation, stale fence, gap, event hash mismatch, oversized payload, and unknown code. Explicitly export `transport` and `errors` from `index.ts`; update operation/conformance manifest inputs. Retain the PRT-006 contract LF rule and add `tests/fixtures/worker-protocol-consumers/v1/** text eol=lf` before generating frozen bytes.

Create two dependency-pinned commands in root `package.json`:

```json
"freeze:worker-protocol-v1": "node scripts/freeze-worker-protocol-consumer.mjs",
"check:frozen-worker-protocol-v1": "node scripts/check-frozen-worker-protocol-consumer.mjs"
```

`freeze-worker-protocol-consumer.mjs --source-sha <40-hex>` must: require `HEAD` equals the supplied commit and `packages/worker-protocol/src` has no diff; require the v1 output directory does not already exist; read the exact protocol/Zod/esbuild versions and lockfile integrity; use the locked root esbuild with fixed `bundle: true`, `format: "esm"`, `platform: "neutral"`, `target: "es2022"`, no sourcemap/banner/timestamp, and deterministic path settings to bundle built `dist/index.js` plus Zod into the frozen `dist/index.js`; copy the complete emitted declaration tree and minimal package metadata with no runtime dependency; write `dependency-lock.json` containing source SHA, package/lock integrity, exact Zod/esbuild versions, and bundler options; normalize declared text files to UTF-8/LF; and write the sorted POSIX-path SHA-256 manifest excluding itself. It refuses overwrite or `--force`.

`check-frozen-worker-protocol-consumer.mjs --source-sha <40-hex>` independently recomputes every hash, checks the recorded SHA/version/lock/bundler config, rejects runtime dependencies/current-source imports/absolute paths/test files/timestamps, and imports the frozen root in isolated server and worker smoke processes. `check-frozen-worker-protocol-consumer.test.mjs` proves that mutating any frozen byte, dependency record, source SHA, path order, or line ending fails. The test imports pure checker functions and uses an isolated temporary copy; it never mutates the checked-in fixture.

Run the focused tests, package test/typecheck/build, boundary check, both freeze-script mutation tests, and distributed-foundation check. Then make the source commit and capture it explicitly:

```powershell
pnpm --filter @armyofagents/worker-protocol exec vitest run src/transport.test.ts src/errors.test.ts src/artifacts.test.ts src/job.test.ts src/contract.test.ts
if ($LASTEXITCODE -ne 0) { throw 'PRT-007 focused protocol tests failed' }
node --test scripts/check-frozen-worker-protocol-consumer.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'frozen-consumer checker mutation tests failed' }
pnpm --filter @armyofagents/worker-protocol typecheck
if ($LASTEXITCODE -ne 0) { throw 'worker protocol typecheck failed' }
pnpm --filter @armyofagents/worker-protocol build
if ($LASTEXITCODE -ne 0) { throw 'worker protocol build failed' }
pnpm check:worker-protocol-boundary
if ($LASTEXITCODE -ne 0) { throw 'worker protocol boundary failed' }
pnpm check:distributed-foundation
if ($LASTEXITCODE -ne 0) { throw 'distributed foundation check failed' }
git add packages/worker-protocol/src docs/contracts/worker-protocol/v1 .gitattributes scripts/update-worker-protocol-contract-manifest.mjs scripts/freeze-worker-protocol-consumer.mjs scripts/check-frozen-worker-protocol-consumer.mjs scripts/check-frozen-worker-protocol-consumer.test.mjs package.json pnpm-lock.yaml
git commit -m "feat: define worker protocol transport contract"
$baselineSourceSha = git rev-parse HEAD
if ($baselineSourceSha -notmatch '^[0-9a-f]{40}$') { throw 'invalid BASELINE_SOURCE_SHA' }
```

Immediately create or update `tickets/PRT-007-result.md` from the ticket-result template and record `$baselineSourceSha` in a line whose exact field name is `**BASELINE_SOURCE_SHA:**` and whose value is the 40-hex commit, while its status remains `gate_review`. This draft is the cross-session source of truth and is committed only after the frozen fixture and independent review are complete. No runtime source may change between this commit and the freeze in Step 5.

- [ ] **Step 5: Freeze the complete independent v1 baseline**

While `HEAD` still equals `BASELINE_SOURCE_SHA`, run:

```powershell
$prt007 = Get-Content docs/replatform/epics/E1-worker-protocol/tickets/PRT-007-result.md -Raw
$sourceMatch = [regex]::Match($prt007, '(?m)^\*\*BASELINE_SOURCE_SHA:\*\*\s*`?([0-9a-f]{40})`?\s*$')
if (-not $sourceMatch.Success) { throw 'PRT-007 result has no exact BASELINE_SOURCE_SHA field' }
$baselineSourceSha = $sourceMatch.Groups[1].Value
if ((git rev-parse HEAD) -ne $baselineSourceSha) { throw 'HEAD moved after the reviewed PRT-007 source commit' }
pnpm --filter @armyofagents/worker-protocol build
if ($LASTEXITCODE -ne 0) { throw 'worker protocol build failed before freeze' }
pnpm freeze:worker-protocol-v1 -- --source-sha $baselineSourceSha
if ($LASTEXITCODE -ne 0) { throw 'worker protocol v1 freeze failed' }
pnpm check:frozen-worker-protocol-v1 -- --source-sha $baselineSourceSha
if ($LASTEXITCODE -ne 0) { throw 'frozen worker protocol verification failed' }
git diff --exit-code $baselineSourceSha -- packages/worker-protocol/src
if ($LASTEXITCODE -ne 0) { throw 'worker protocol source changed after BASELINE_SOURCE_SHA' }
```

The generated baseline includes the exact Zod runtime used at that revision, its complete declaration tree, minimal package metadata, dependency lock, and manifest. The frozen package has no runtime dependency and imports no current protocol source. Never mutate this fixture; a future breaking protocol version adds another versioned fixture. If runtime source changes after the recorded commit, create a reviewed replacement source commit and regenerate the fixture rather than editing frozen bytes.

- [ ] **Step 6: Add bidirectional tests and finalize conformance hashes**

`cross-version.test.ts` imports the current consumer and frozen consumer independently and covers current producer→frozen consumer plus frozen producer→current consumer for every execution-source/job combination, lease offer/ACK/renew, events and service events, artifacts, quarantine, secret/policy refs, registered target/worker capabilities, product approvals, runtime decisions, every other control, and every error.

Prove safe optional extension preservation, unknown critical-extension rejection, unknown state/control/error rejection, renewal identity echo, duplicate ID+same digest idempotency, duplicate ID+different digest failure, source independence, and exact manifest hashes. On the first v1 freeze the two consumers intentionally implement the same contract, so the QA result is `baseline_established`. On the first and every subsequent contract change, these same tests must use non-identical current and frozen builds and classify each vector as common-and-accepted, safely additive-and-preserved, or unsupported-critical-and-rejected during negotiation.

Add the cross-version valid/invalid vectors and extend manifest generation to hash conformance, operations, the frozen-consumer manifest, and the recorded baseline source revision. A manifest or source-independence mismatch fails the suite.

- [ ] **Step 7: Verify, record, and commit PRT-007**

Run:

```powershell
$prt007 = Get-Content docs/replatform/epics/E1-worker-protocol/tickets/PRT-007-result.md -Raw
$sourceMatch = [regex]::Match($prt007, '(?m)^\*\*BASELINE_SOURCE_SHA:\*\*\s*`?([0-9a-f]{40})`?\s*$')
if (-not $sourceMatch.Success) { throw 'PRT-007 result has no exact BASELINE_SOURCE_SHA field' }
$baselineSourceSha = $sourceMatch.Groups[1].Value
pnpm gen:worker-protocol-contract
if ($LASTEXITCODE -ne 0) { throw 'worker protocol contract generation failed' }
pnpm --filter @armyofagents/worker-protocol test:run
if ($LASTEXITCODE -ne 0) { throw 'worker protocol tests failed' }
pnpm --filter @armyofagents/worker-protocol typecheck
if ($LASTEXITCODE -ne 0) { throw 'worker protocol typecheck failed' }
pnpm --filter @armyofagents/worker-protocol build
if ($LASTEXITCODE -ne 0) { throw 'worker protocol build failed' }
pnpm check:worker-protocol-boundary
if ($LASTEXITCODE -ne 0) { throw 'worker protocol boundary failed' }
pnpm check:distributed-foundation
if ($LASTEXITCODE -ne 0) { throw 'distributed foundation check failed' }
node --test scripts/check-frozen-worker-protocol-consumer.test.mjs
if ($LASTEXITCODE -ne 0) { throw 'frozen-consumer checker mutation tests failed' }
pnpm check:frozen-worker-protocol-v1 -- --source-sha $baselineSourceSha
if ($LASTEXITCODE -ne 0) { throw 'frozen worker protocol verification failed' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'PRT-007 diff has whitespace errors' }
```

Create `tickets/PRT-007-result.md` recording operation/error/control coverage, `BASELINE_SOURCE_SHA`, frozen-baseline independence/hash, exact bundled-Zod identity, both producer/consumer directions, whether the result is `baseline_established` or a non-identical compatibility proof, all commands/exit codes, and any finding. Commit the frozen fixture, cross-version tests, final manifests, and result explicitly:

```powershell
git add tests/fixtures/worker-protocol-consumers/v1 packages/worker-protocol/src/cross-version.test.ts docs/contracts/worker-protocol/v1 scripts/update-worker-protocol-contract-manifest.mjs .gitattributes docs/replatform/epics/E1-worker-protocol/tickets/PRT-007-result.md
git commit -m "test: freeze worker protocol v1 baseline"
```

PRT-007 is the reviewed two-commit sequence; neither commit alone completes the ticket.

---

### Task 8: E1 Integration Gate and Evidence Handoff

**Files:**
- Read: all E1 package, contract, script, plan, and ticket-result files
- Create: date-derived QA result under `docs/replatform/epics/E1-worker-protocol/qa/`
- Create: date-derived completion handoff under `docs/replatform/epics/E1-worker-protocol/handoffs/`
- Modify: `docs/replatform/epics/E1-worker-protocol/README.md`
- Modify: `docs/replatform/epics/README.md`

**Interfaces:**
- Consumes: PRT-001 through PRT-007 and their committed result records.
- Produces: the reviewed protocol artifact that unblocks E2/E3/E4/E6 planning.

- [ ] **Step 1: Verify ticket-result and contract completeness**

Run:

```powershell
Get-ChildItem docs/replatform/epics/E1-worker-protocol/tickets/*-result.md | Select-Object -ExpandProperty Name
Get-Content docs/contracts/worker-protocol/v1/manifest.sha256
$ticketResults = Get-ChildItem docs/replatform/epics/E1-worker-protocol/tickets/PRT-*-result.md
$expectedNames = 1..7 | ForEach-Object { "PRT-{0:D3}-result.md" -f $_ }
$actualNames = @($ticketResults.Name | Sort-Object)
if (Compare-Object $expectedNames $actualNames) { throw "E1 ticket-result filename set is not PRT-001 through PRT-007" }
foreach ($result in $ticketResults) {
  $body = Get-Content -LiteralPath $result.FullName -Raw
  if ($body -notmatch '(?m)^\*\*Status:\*\*\s*`complete`\s*$' -or
      $body -notmatch '(?m)^\*\*Disposition:\*\*\s*`approved`\s*$') {
    throw "$($result.Name) is not independently approved complete"
  }
  $implementer = [regex]::Match($body, '(?m)^\*\*Implementer:\*\*\s*(.+?)\s*$').Groups[1].Value
  $reviewer = [regex]::Match($body, '(?m)^\*\*Reviewer:\*\*\s*(.+?)\s*$').Groups[1].Value
  $reviewedShaMatch = [regex]::Match($body, '(?m)^\*\*Reviewed revision:\*\*\s*`?([0-9a-f]{40})`?\s*$')
  if (-not $implementer -or -not $reviewer -or $implementer -match '^<.*>$' -or
      $reviewer -match '^<.*>$' -or $implementer.Trim().ToLowerInvariant() -eq $reviewer.Trim().ToLowerInvariant()) {
    throw "$($result.Name) lacks an independent reviewer"
  }
  if (-not $reviewedShaMatch.Success) { throw "$($result.Name) lacks an exact reviewed revision" }
  $reviewedSha = $reviewedShaMatch.Groups[1].Value
  git cat-file -e "${reviewedSha}^{commit}"
  if ($LASTEXITCODE -ne 0) { throw "$($result.Name) reviewed revision is not a commit" }
  git merge-base --is-ancestor $reviewedSha HEAD
  if ($LASTEXITCODE -ne 0) { throw "$($result.Name) reviewed revision is not an ancestor of HEAD" }
}
git status --short
```

Expected: exactly PRT-001-result.md through PRT-007-result.md, current and frozen-consumer manifest hashes, and a clean worktree.

- [ ] **Step 2: Run focused and repository gates**

Run:

```powershell
function Invoke-NativeGate([string]$label, [scriptblock]$command) {
  & $command
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) { throw "$label failed with exit code $exitCode" }
}

$prt007 = Get-Content docs/replatform/epics/E1-worker-protocol/tickets/PRT-007-result.md -Raw
$sourceMatch = [regex]::Match($prt007, '(?m)^\*\*BASELINE_SOURCE_SHA:\*\*\s*`?([0-9a-f]{40})`?\s*$')
if (-not $sourceMatch.Success) { throw 'PRT-007 result has no exact BASELINE_SOURCE_SHA field' }
$baselineSourceSha = $sourceMatch.Groups[1].Value
Invoke-NativeGate 'baseline source commit lookup' { git cat-file -e "${baselineSourceSha}^{commit}" }
Invoke-NativeGate 'baseline source is in candidate history' { git merge-base --is-ancestor $baselineSourceSha HEAD }
Invoke-NativeGate 'distributed foundation check' { pnpm check:distributed-foundation }
Invoke-NativeGate 'worker protocol boundary check' { pnpm check:worker-protocol-boundary }
Invoke-NativeGate 'worker protocol boundary mutation corpus' { node --test scripts/check-worker-protocol-boundary.test.mjs }
Invoke-NativeGate 'worker protocol test suite' { pnpm --filter @armyofagents/worker-protocol test:run }
Invoke-NativeGate 'worker protocol typecheck' { pnpm --filter @armyofagents/worker-protocol typecheck }
Invoke-NativeGate 'worker protocol build' { pnpm --filter @armyofagents/worker-protocol build }
Invoke-NativeGate 'packed protocol import smoke' { node scripts/check-worker-protocol-package.mjs }
Invoke-NativeGate 'contract-manifest byte mutation corpus' { node --test scripts/update-worker-protocol-contract-manifest.test.mjs }
Invoke-NativeGate 'contract-manifest exact-byte check' { node scripts/update-worker-protocol-contract-manifest.mjs --check }
Invoke-NativeGate 'frozen-consumer checker mutation corpus' { node --test scripts/check-frozen-worker-protocol-consumer.test.mjs }
Invoke-NativeGate 'frozen-consumer integrity check' { pnpm check:frozen-worker-protocol-v1 -- --source-sha $baselineSourceSha }
Invoke-NativeGate 'frozen lockfile install' { pnpm install --frozen-lockfile }
Invoke-NativeGate 'repository typecheck' { pnpm -r typecheck }
Invoke-NativeGate 'repository test suite' { pnpm test:run }
Invoke-NativeGate 'same-revision recursive build' { pnpm -r build }
Invoke-NativeGate 'authoritative repository build' { pnpm build }
Invoke-NativeGate 'whitespace check' { git diff --check }
1..3 | ForEach-Object {
  Invoke-NativeGate "D0 worker-protocol boundary run $_" { pnpm check:worker-protocol-boundary }
  Invoke-NativeGate "D0 worker-protocol boundary mutation run $_" { node --test scripts/check-worker-protocol-boundary.test.mjs }
  Invoke-NativeGate "D0 worker-protocol critical suite run $_" { pnpm --filter @armyofagents/worker-protocol test:run }
  Invoke-NativeGate "D0 worker-protocol package smoke run $_" { node scripts/check-worker-protocol-package.mjs }
}
$dirtyAfterGate = git status --porcelain
if ($LASTEXITCODE -ne 0) { throw 'git status failed after E1 gate' }
if ($dirtyAfterGate) { throw "E1 gate changed the worktree: $dirtyAfterGate" }
Invoke-NativeGate 'final E1 tracked diff check' { git diff --exit-code }
```

E1 starts only after FND-005 makes authoritative root `pnpm build` deterministic and aligns it with AGENTS/CI; `pnpm -r build` remains direct same-revision package evidence. Both are required. Expected: all commands exit 0 and the tracked/untracked worktree remains clean after the gate. Any repository-baseline failure is recorded without weakening protocol checks or changing the E1 completion decision to pass.

- [ ] **Step 3: Create immutable QA and handoff records**

Create paths with:

```powershell
$repoRoot = (git rev-parse --show-toplevel).Trim()
$utcDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$sha12 = (git rev-parse HEAD).Substring(0, 12)
$qaDir = "docs/replatform/epics/E1-worker-protocol/qa"
$handoffDir = "docs/replatform/epics/E1-worker-protocol/handoffs"

function Get-E1RecordAttempts([string]$directory, [string]$namePattern) {
  if (-not (Test-Path -LiteralPath $directory)) { return @() }
  return @(Get-ChildItem -LiteralPath $directory -File | ForEach-Object {
    if ($_.Name -match $namePattern) {
      [pscustomobject]@{
        Attempt = [int]$Matches['attempt']
        Path = $_.FullName.Substring($repoRoot.Length + 1).Replace('\', '/')
      }
    }
  } | Sort-Object Attempt, Path)
}

# Attempts are monotonic for the stable lane/scope and gate slug across every
# date and revision, not merely collision-free for today's SHA.
$qaPrior = @(Get-E1RecordAttempts $qaDir '^\d{4}-\d{2}-\d{2}-d0-e1-completion-[0-9a-f]{12}-a(?<attempt>\d+)\.md$')
$handoffPrior = @(Get-E1RecordAttempts $handoffDir '^\d{4}-\d{2}-\d{2}-epic-completion-[0-9a-f]{12}-a(?<attempt>\d+)\.md$')
$priorAttempts = @($qaPrior | ForEach-Object Attempt) + @($handoffPrior | ForEach-Object Attempt)
$selectedAttempt = if ($priorAttempts.Count -eq 0) { 1 } else { [int](($priorAttempts | Measure-Object -Maximum).Maximum) + 1 }
$qaRecord = "$qaDir/$utcDate-d0-e1-completion-$sha12-a$selectedAttempt.md"
$handoffRecord = "$handoffDir/$utcDate-epic-completion-$sha12-a$selectedAttempt.md"
$qaSupersedes = if ($qaPrior.Count -eq 0) { 'none' } else { $qaPrior[-1].Path }
$handoffSupersedes = if ($handoffPrior.Count -eq 0) { 'none' } else { $handoffPrior[-1].Path }
```

Populate `$qaRecord` from the QA template with its immutable path/attempt fields, `Supersedes: $qaSupersedes`, exact 40-character revision, commands, exit codes, test counts, current/frozen contract hashes, every execution-source direction, product/runtime approval vectors, cross-version directions, boundary result, both build commands, every applicable REQUIRED/HARD/INITIAL/OBSERVED value, and three consecutive same-revision critical-suite passes. Populate `$handoffRecord` from the handoff template with `Supersedes: $handoffSupersedes`, pinning all seven ticket-result blob and reviewed implementation SHAs plus `$qaRecord`. Failed, blocked, corrected, later-date, and later-revision campaigns advance the same monotonic attempt sequence and never create another `a1`.

Set the handoff decision to `pass` only if Step 2 and every applicable D0 REQUIRED condition plus HARD/INITIAL threshold passed on the recorded revision. Otherwise set it to `fail` or `blocked_external` under `test-gates.md`, keep the epic in `gate_review`, and create stable finding IDs for every blocker.

- [ ] **Step 4: Update status only on a passing gate and commit evidence**

Ticket owners move E1 from `planned` to `in_progress` when execution starts; the Integration Gate Owner moves it to `gate_review` only after all seven result records are independently reviewed with status `complete` and disposition `approved`. For a passing gate, change E1 from `gate_review` to `complete` in its README and the epic index. Leave E2/E3/E4/E6 statuses unchanged; their planning becomes unblocked but their implementation dependencies are not automatically satisfied.

```powershell
git add docs/replatform/epics/E1-worker-protocol docs/replatform/epics/README.md
git commit -m "docs: record E1 protocol completion evidence"
```

- [ ] **Step 5: Report the next planning order**

The completion handoff records E2's independent status rather than serializing it behind E1. If E2 is not already running, it may start from the E0 handoff without waiting for E1. Once both E1 and E2 are green, list the next work in this order:

1. E3/E4 core planning against both accepted handoffs.
2. JOB-001/JOB-002/WRK-001 core bootstrap, followed by JOB-009/JOB-003/WRK-004.
3. E6 DEP-000 through DEP-004 and the named `E6-D1-FOUNDATION` gate.

No downstream implementation begins merely because E1 types compile; its dependency epic gates must be green on main.
