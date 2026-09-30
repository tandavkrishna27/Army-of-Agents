# CLI-002 Design — Full workspace staging and adapter execution

**Status:** `design` (reviewable artifact; implementation via fail-first TDD + distinct adversarial review). **Scope: no-key core (lands on the PR gate) + keyed real-E2B tail** (the fake-CLI-modifies-a-file-in-E2B one-liner + W8 live-validation ride the operator-dispatched `keyed-e2b-conformance.yml`, matching CLI-001).
**Epic:** `E7 — Coding/CLI workload on E2B` (second ticket). **Authoritative source:** `program-design.md:762-767`.
**Depends on (status verified):** CLI-001 (E2B provider — **landed, CI-green** `bce3314c1`), DAT-002 (presigned transfer-grant + fenced commit — landed). **DAT-007 caveat:** the brokered run-JWT tool surface CLI-002 would "exercise end-to-end" has its **core DEFERRED** (`DAT-007-result.md`: PARTIAL / blocked on out-of-worktree substrate) — so CLI-002 delivers the memory context as a **pre-staged actor-gated bundle**, and the *live* brokered in-VM pull defers to DAT-007 completion. Frozen worker-protocol v1 SHA `b7a842870ce7509d8baa75409e0ab19da375c88a` + the frozen worker-daemon `SandboxProvider` port — consumed, never edited.
**Grounded by:** the CLI-002 terrain-map (5 readers + synth) with load-bearing claims **independently re-verified** in `C:\e3`: **no file-put primitive exists** — the `E2bTransport` seam is `create/runCommand/signal/terminate/getInfo/list/setTimeout/isRunning/pause/resume` (`transport.ts:116-125`), `CreateSandboxSpec` has no files field, and `MockE2bTransport` models no filesystem; **no per-adapter-TYPE execute gate exists** (`registry.ts` gates on execution target/probe, not adapter type); the U5 `buildSandboxEnvAllowlist` is a from-scratch positive allowlist keyed on provider (anthropic/openai/gemini/xai/cursor) that fails closed to `[]` on unknown/empty and excludes `E2B_API_KEY`/`DATABASE_URL`/secrets by construction; the actor-gated memory path is `actorForAgentRun → memoryAccessConditions → canActorSee` (fail-closed) as used by `buildCrewContextBundle`, NOT `context-packaging.ts assembleContext` (no RBAC gate → #118/#119 leak). CLI-002 owns no `DE-*`; it co-owns CM-007/CM-013 (adapter readiness + company-key-on-shared-pool) with the CLI/CM tickets.

---

## 1. Scope + framing

**Outcome (program-design.md:765):** stage a declared snapshot + actor-authorized context bundle, install only approved runtime inputs, run one existing CLI adapter (v1 = `claude_local` + `codex_local`), and record exact adapter/tool/context versions; every registered adapter has an explicit disposition.

**Acceptance (program-design.md:766):** the agent sees the expected source, instructions, and memory-derived context allowed by Decisions #118/#119; the worker has no memory/database access; host paths are absent; unsupported files fail before execution; a coding adapter outside the v1 sandboxed scope fails closed with an attributable reason — never a silent host fallback.

**The thesis that shapes the design.** CLI-002 is a **new host+orchestration layer ABOVE the CLI-001 provider** — not an edit to the frozen protocol/port. Two already-built lineages must be bridged: (A) the legacy/#320 host-side staging + adapter-exec (U5 allowlist + brokered MCP into the VM for `claude_local`/`codex_local`), and (B) the CLI-001 per-op E2B provider (runs one tenant command; no file-staging, no adapter selection, no version recording). The pivotal decision is that **the "modifies a known file inside E2B" test is unprovable against today's doubles** — so CLI-002 adds a **file-staging primitive to the transport seam and models a filesystem in the mock**, keeping most of the ticket provable without a key. What lands on the no-key PR gate is the staging + memory-bundle + disposition + version machinery against an fs-modeling double; the real-E2B end-to-end rides the keyed lane.

| Workstream | Lane | Kind | Responsibility |
|---|---|---|---|
| `writeFiles` staging primitive on the transport seam (+ real + fs-modeling mock) | `packages/sandbox-e2b-provider` | new | put staged bytes into a sandbox; the mock models an in-memory fs so staging + file-mutation are no-key-testable |
| Staging orchestrator (snapshot + context bundle + approved inputs) | new host layer | new | assemble a DAT-001 declared manifest + the actor-gated memory bundle + approved runtime inputs, stage them, reject unsupported files BEFORE exec |
| Actor-gated **pre-staged** memory bundle | new host layer | new (reuse) | `actorForAgentRun → memoryAccessConditions → canActorSee` (fail-closed to zero memory); staged as a `## Context` block; NOT `assembleContext`; live DAT-007 pull deferred |
| Per-adapter-TYPE disposition gate (execute path) | new host layer | new | fail closed with an attributable reason on out-of-scope adapters BEFORE execute; admit v1 `claude_local`+`codex_local`; record Follow-up |
| Version recording + U5 env allowlist wiring | new host layer | new (reuse) | record adapter/tool/context versions; assert host paths + secrets (`DATABASE_URL`/master-key/GitHub-PAT/`E2B_API_KEY`) absent from staged env |
| CI wiring + keyed lane | CI | additive | pr.yml glob + vitest projects + policy disposition/boundary checker; keyed lane runs the real-E2B fake-CLI-modifies-file + W8 |

**Additive.** No frozen worker-protocol or worker-daemon-port edit; no `DE-*` threat edit; reuse (never re-implement) U5, the actor-gated memory path, and DAT-001/002; keep the seam provider-neutral.

---

## 2. Adapter disposition matrix (every registered type dispositioned)

Grounded in `registry.ts` (12 types) + `sandbox-env-allowlist.ts` (provider map) + `program-design.md:765`:

- **v1 sandboxed (admit):** `claude_local` (→anthropic), `codex_local` (→openai) — the two #320-wired (U5 key + brokered MCP), W8 live-validates.
- **Follow-up (recorded, not admitted yet):** `gemini_local` (gemini), `opencode_local` (model-prefix), `cursor` (cursor), `grok_local` (xai), `pi_local` (model-prefix) — pass a `sandboxProvider` but not in the readiness-probe map; admit once in-VM MCP staging + model→provider mapping are proven.
- **Out-of-scope (fail closed under `cloud_auth`, attributable reason):** `acpx_local`, `openclaw` (no sandbox provider-key mapping), `cursor_cloud` (runs on Cursor's cloud, not a local CLI in-VM), `openclaw_gateway` (gateway transport), `hermes_local` (PAPERCLIP wire-protocol external runtime).
- **Infra (outside the coding-CLI matrix):** `process`, `http`.

---

## 3. Invariants (each gets a test; real-E2B rerun is the keyed lane)

1. **Memory bundle honors #118/#119 + fails closed.** Assembled via the actor-gated path against a mocked DB; asserts the tiers (identity→agents; company-visibility; ambient fully-unscoped; scope-matched domain/active_context; excludes invalidated + others' private) and **zero memory when no actor resolves**. Never sources from `assembleContext`.
2. **Staging + reject-unsupported-before-exec.** The orchestrator stages a declared DAT-001 manifest + context bundle + approved inputs into the fs-modeling double; unsupported files are rejected BEFORE exec (`skipped[]`-with-reason), never silently dropped.
3. **Worker has no memory/DB access; host paths + secrets absent.** The staged env passes the U5 allowlist — `DATABASE_URL`/master-key/GitHub-PAT/`E2B_API_KEY` are absent even if an overlay carried them; host paths are absent (positive allowlist + cwd rewrite).
4. **Out-of-scope adapter fails closed.** The disposition gate rejects every out-of-scope type with an attributable reason BEFORE execute; only v1 `claude_local`/`codex_local` are admitted; never a silent host fallback.
5. **Versions recorded.** Adapter/tool/context versions are captured on the run.
6. **File mutation (keyed lane).** A deterministic fake CLI modifies a KNOWN file inside the sandbox — proven against the fs-modeling mock in the no-key lane AND against real E2B in the keyed lane.

---

## 4. Decisions

### D1 — Add a `writeFiles` staging primitive to the `E2bTransport` seam (+ real + fs-modeling mock)
Neither the seam nor `CreateSandboxSpec` can put bytes into a sandbox, and the mock models no fs — so the file-mutation test is otherwise keyed-only (a thin no-key core). Add `writeFiles(sandboxId, files: {path, bytes}[])` (and a `readFile`/`listDir` as needed for assertions) to `E2bTransport`; implement it on `real-transport.ts` via the `e2b` SDK filesystem API (`sandbox.files.write`), and extend `MockE2bTransport` with a deterministic in-memory filesystem so staging + a fake CLI's file mutation are **no-key-testable**. This stays inside the CLI-001 package (the seam is CLI-001's, not the frozen worker-protocol/port).

### D2 — Pre-staged, actor-gated memory bundle (DAT-007 live pull deferred)
Assemble the memory-derived context through the **actor-gated** path (`actorForAgentRun → memoryAccessConditions → canActorSee`, the `buildCrewContextBundle` lineage, fail-closed to zero memory) and stage it as a `## Context` block into the sandbox — **do not** use `context-packaging.ts assembleContext` (no RBAC gate → #118/#119 leak). Because DAT-007's brokered run-JWT surface has its core deferred, CLI-002 delivers the **pre-staged** bundle now; the *live* in-VM brokered pull is a documented deferral to DAT-007. The sandbox never receives DB/memory-table access (the no-DB boundary is static: U5 drops DB creds; worker-daemon reads no `DATABASE_URL`).

### D3 — Per-adapter-TYPE disposition gate on the execute path (new, fail-closed)
No execute-path adapter-TYPE gate exists (today's gates are on execution target / probe). Add a gate that runs BEFORE execute and, under `cloud_auth`, admits only the v1 set (`claude_local`/`codex_local`), records Follow-up, and **fails closed with an attributable reason** on every out-of-scope type — never a silent host fallback. A static disposition-lint (mirroring CLI-001's capability-matrix lint) asserts every registered type is dispositioned and no v1/out-of-scope type is mis-bucketed.

### D4 — Install only approved runtime inputs; reject unsupported before exec
Extend the `run-input-bundles` `skipped[]`-with-reason precedent (`unsupported_type`/`missing_source_id`/`not_found`/`materialize_failed`) to the staging path: only approved inputs are installed; unsupported files fail BEFORE execution with an attributable reason. Env is filtered through the U5 allowlist (host paths + secrets absent).

### D5 — Record adapter/tool/context versions
Capture the adapter type + version, the CLI tool version, and a context-bundle digest on the run record (a typed fixture/output), so the run is reproducible and auditable.

### D6 — CI wiring + keyed lane
Add the new package/orchestrator paths to the `pr.yml:102` provider glob + `vitest.config.ts` projects + a `policy` disposition/boundary checker (or the new code gates vacuously — the DEP-000/CLI-001 lesson, plus the Dockerfile deps-stage COPY). The no-key core lands on `verify` + `distributed-contract` + `policy`. The keyed lane extends `keyed-e2b-conformance.yml` (`workflow_dispatch` + `secrets.E2B_API_KEY` + `e2b_template`): the deterministic fake CLI modifies a known file inside **real** E2B, and W8 live-validates `claude_local`/`codex_local` end-to-end. SKIPs cleanly without the key; never faked.

---

## 5. Non-goals / scope honesty

1. **No live DAT-007 brokered in-VM memory pull** (core deferred) — CLI-002 pre-stages the actor-gated bundle; the live brokered surface is DAT-007's to finish.
2. **No Follow-up adapters admitted** (`gemini_local`/`opencode_local`/`cursor`/`grok_local`/`pi_local`) — recorded, admitted once in-VM MCP staging + model→provider mapping are proven.
3. **No `codex_local` sandbox-docker MCP staging** (unwritable `CODEX_HOME`, MX3 follow-up) — provider-sandbox/remote targets covered.
4. **No live DAT-005 sandbox→proxy egress channel** (inert seam, E4-D12) — the company-key delivery model is reconciled in the design (server-side egress-header materialization vs in-VM U5 overlay) but the live channel is downstream.
5. **No frozen worker-protocol / worker-daemon-port edit; no `DE-*` threat edit.**

---

## 6. CI + acceptance mapping

| Acceptance clause (L766) | Where satisfied | Gate |
|---|---|---|
| agent sees source/instructions/memory context (#118/#119) | actor-gated pre-staged bundle | no-key: mocked-DB unit; real: keyed lane |
| worker has no memory/DB access | U5 allowlist + no `DATABASE_URL` | `verify` + `policy` |
| host paths absent | U5 positive allowlist + cwd rewrite | `verify` |
| unsupported files fail before execution | `skipped[]`-with-reason staging gate | `verify` |
| out-of-scope adapter fails closed with attributable reason | execute-path disposition gate + lint | `verify` + `policy` |
| adapter/tool/context versions recorded | run record | `verify` |
| **deterministic fake CLI modifies a known file inside E2B** | fs-modeling mock (no-key) + real E2B (keyed) | `verify` + **keyed lane** |

**Gate recommendation for implementation:** fail-first — write the disposition-gate + memory-bundle + staging (fs-mock) tests RED before the code, then GREEN; author the keyed real-E2B fake-CLI-file-mutation case SKIP-guarded + parse-verified; wire pr.yml/vitest/policy + the Dockerfile deps stage; distinct adversarial review before the result doc. Disposition = scope-honest `pass` on in-process + static + Linux-CI evidence for the no-key core, with the real-E2B rerun runnable on operator key.
