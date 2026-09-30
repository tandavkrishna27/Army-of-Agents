# Keyless-Except-Embeddings Implementation Plan (rev. 2 — post Codex + self review)

> **Update 2026-06-27 (partial supersede):** the "selectable server-side engine
> (`cli` one-shot | dormant `api`)" architecture below was superseded — extraction
> is now **CLI-only** everywhere; the `api` engine + engine-status route are
> deleted. See `docs/aoa/plans/2026-06-27-decouple-extraction-from-keys-spec.md`
> + PLAN and Decision #104's 2026-06-27 amendment. The embeddings/queue/status
> tasks still hold.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make discussion extraction (and Commander) run keyless via the local CLI, leaving the OpenAI key needed only for embeddings, with enterprise-grade retry/circuit-break/status behavior, graceful degradation, and full unit + UI e2e coverage.

**Architecture:** Extraction = selectable server-side engine (`cli` one-shot | dormant `api`), engine chosen BEFORE any hosted-key check. CLI prompts delivered via stdin (Windows-safe, verify-first). A single `writeMemoryAndIndex` closes the embedding gap. The embedding queue gains per-company keys, backoff+jitter, a per-company circuit breaker, dead-letter + manual re-index, and visible two-axis status. Determinism via existing `fake-claude`/`fake-codex` + a new `fake-embedder` seam.

**Tech Stack:** Express 5 + Drizzle ORM + PostgreSQL/pgvector (server), React + Vite + Tailwind v4 (ui), Vitest + Playwright. Companion design (incl. §9 review reconciliation): `docs/aoa/plans/2026-06-25-keyless-except-embeddings-design.md`.

**Conventions:** Drizzle only (`pnpm db:generate`, never raw SQL). Server unit tests mirror `server/src/__tests__` (mock `@armyofagents/db` + `drizzle-orm`); integration tests use embedded-postgres (Linux only); e2e uses `tests/e2e` with `local_trusted` + fakes. One branch, one PR; commit per task.

**CI reality:** Linux `verify` + `e2e` are required gates; Windows e2e is skipped (embedded-postgres). Commander-on-Windows is therefore a **manual** gate + a unit/contract test on invocation shape.

---

## Task 0: Branch

- [ ] `git checkout main && git pull && git checkout -b feat/keyless-except-embeddings`

---

## W1 — Windows CLI prompt delivery (verify-first; also fixes Commander)

### Task 1: SPIKE — empirically determine the Windows-safe invocation (P0)

**Files:** `docs/aoa/plans/keyless-cli-spike-findings.md` (new, notes only)

- [ ] **Step 1:** On a Windows dev box, with `claude` logged in, run each shape from a Node `spawn` harness (shell:true, cwd=tmp) and record which delivers the prompt and returns output:
  - (a) `claude -p "<query>"` (argv) — current; confirm it's the broken one.
  - (b) `printf '%s' "<content>" | claude -p "<fixed instruction>"` then **close stdin** (documented `cat file | claude -p` shape).
  - (c) `claude -p "<query>" --output-format stream-json --include-partial-messages` with stdin closed.
  - (d) persistent: spawn once, write turn-1 to stdin (no close), read stream — does claude start without EOF?
- [ ] **Step 2:** Record findings: the working one-shot shape (expect (b)/(c)) and whether the persistent chat can use stdin turn-1 without hanging. If persistent-stdin hangs, the Commander fix is "argv with corrected escaping" or "temp-file prompt"; document the decision.
- [ ] **Step 3:** Commit the findings doc. `git commit -am "docs: windows CLI invocation spike findings"`

> The remaining W1 tasks implement the **proven** shape from this spike. Do not implement before Step 2 is recorded.

### Task 2: Harden fake-claude to record stdin + argv

**Files:**
- Modify: `tests/e2e/fixtures/fake-claude/fake-claude.mjs`, `tests/e2e/helpers/fake-claude.ts`
- Test: `tests/e2e/helpers/__tests__/fake-claude-records.spec.ts` (or assert within an e2e)

- [ ] **Step 1:** Mirror `fake-codex`'s invocation log: write `{ argv, stdin, cwd }` JSONL to `AOA_E2E_FAKE_CLAUDE_INVOCATIONS` on every spawn; add `readFakeClaudeInvocations()` / `clearFakeClaudeInvocations()` helpers.
- [ ] **Step 2:** Add the env wiring in `tests/e2e/playwright.config.ts` (`AOA_E2E_FAKE_CLAUDE_INVOCATIONS=<tmp>`).
- [ ] **Step 3:** Commit. `git commit -am "test(e2e): fake-claude records stdin+argv (parity with fake-codex)"`

### Task 3: Implement claude stdin delivery (proven shape)

**Files:**
- Modify: `server/src/services/internal-agent/cli-mode.ts` (claude branch ~396-435; spawn ~644-732)
- Test: `server/src/services/internal-agent/__tests__/cli-invocation-stdin.test.ts`

- [ ] **Step 1: Failing test** — claude invocation carries no user content in argv; `stdinPrompt` carries it.

```ts
const inv = await resolveCliInvocation("claude_cli", baseParams(), "SENTINEL", undefined, undefined, true);
expect(inv!.args.join(" ")).not.toContain("SENTINEL");
expect(inv!.stdinPrompt).toBe("SENTINEL");
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** per spike: export `resolveCliInvocation`; claude args become the proven shape (e.g. `-p "<fixed extraction/turn instruction>"` for one-shot, or corrected for chat); add `stdinPrompt`; remove the argv content positional + its Windows escaping. Spawn block writes `invocation.stdinPrompt` to stdin and closes it for one-shot (`config.cliTool` one-shot context); for the persistent chat follow the spike's decision.
- [ ] **Step 4: Run — PASS** + full `cli-mode` suite green (no Commander regression in unit tests).
- [ ] **Step 5: Manual Windows verify (REQUIRED):** Commander chat returns a real response; record evidence in PR.
- [ ] **Step 6:** Commit. `git commit -am "fix(cli): deliver claude prompt via stdin (Windows-safe) per spike findings"`

---

## W3a — Schema + backfill (early; W4 depends on it)

### Task 4: embedding_queue.company_id + next_retry_at + backfill

**Files:**
- Modify: `packages/db/src/schema/embedding_queue.ts`; Generate via `pnpm db:generate`
- Create: `server/src/services/embeddings-backfill.ts` (`backfillQueueCompanyIds`)
- Test: `server/src/__tests__/embedding-queue-schema-contract.test.ts`

- [ ] **Step 1: Failing contract test** — `embeddingQueue.companyId` + `.nextRetryAt` defined.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** columns (`company_id uuid` nullable, `next_retry_at timestamptz` nullable) + index `(status, next_retry_at)`. `pnpm db:generate` (review generated SQL).
- [ ] **Step 4:** `backfillQueueCompanyIds(db)` derives company for existing null rows by joining target table → company (memory_items/discussions/discussion_extracted_items); rows that can't resolve stay null (env-key only). Call it once at worker startup.
- [ ] **Step 5: Run — PASS.**
- [ ] **Step 6:** Commit. `git commit -am "feat(db): embedding_queue company_id + next_retry_at + company backfill"`

---

## W2 — Keyless CLI extraction (Option B)

### Task 5: One-shot CLI extractor (claude + factored codex) with classified errors

**Files:**
- Create: `server/src/services/extraction-cli.ts`
- Modify: `server/src/services/internal-agent/cli-mode.ts` (export a factored `runCodexExecJson()` reusing model+auth hardening) — or new `server/src/services/internal-agent/codex-exec.ts`
- Test: `server/src/__tests__/extraction-cli.test.ts`

- [ ] **Step 1: Failing tests** — `classifyCliError` + happy path (mock spawn).

```ts
expect(classifyCliError({ code: "ENOENT" }, "", null)).toBe("not_installed");
expect(classifyCliError(null, "Missing bearer authentication", 1)).toBe("not_authed");
expect(classifyCliError({ timedOut: true }, "", null)).toBe("timeout");
expect(classifyCliError(null, "boom", 2)).toBe("nonzero_exit");
// happy: mocked claude stdout = '[{"type":"task","title":"x","description":"y"}]' → parseExtractedItems → 1 item
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `extractViaCli(cliTool, systemPrompt, content, {timeoutMs=60000})`:
  - claude: spawn proven one-shot shape from Task 3; system prompt via `--system-prompt-file`; content via stdin (closed); capture stdout text.
  - codex: call `runCodexExecJson(systemPrompt, content)` — factored from `cli-mode.ts` so it **reuses** `readSharedCodexModel`/`resolveCodexChatModel` + `ensureCodexAuthInHome` and returns the final assistant text via `parseCodexJsonl`.
  - `parseExtractedItems(text)` (import from `extraction.ts`).
  - timeout → kill+grace; throw `CliExtractionError { kind: classifyCliError(...) }`.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5:** Commit. `git commit -am "feat(extraction): one-shot CLI extractor (claude + factored codex) with classified errors"`

### Task 6: Engine router — resolve BEFORE the hosted-key precheck (P0)

**Files:**
- Create: `server/src/services/extraction-engine.ts` (`resolveExtractionEngine`, `probeExtractionCli`)
- Modify: `server/src/services/extraction.ts` (run engine resolution before the `extraction.ts:466` precheck; CLI bypasses it; precheck lives only in the `api` branch)
- Test: `server/src/__tests__/extraction-engine.test.ts`, extend `extraction` tests

- [ ] **Step 1: Failing tests:**

```ts
expect(await resolveExtractionEngine(db, cid, { cliAvailable: true })).toBe("cli");
expect(await resolveExtractionEngine(db, cid, { cliAvailable: false, apiKey: true })).toBe("api");
await expect(resolveExtractionEngine(db, cid, { cliAvailable: false, apiKey: false })).rejects.toThrow(/no extraction engine/i);
// integration-shaped: no hosted key + fake CLI available → entry 'completed' + items inserted (NOT 'skipped')
```

- [ ] **Step 2: Run — FAIL** (today no key → `skipped`).
- [ ] **Step 3: Implement** `resolveExtractionEngine(db, companyId)` (auto: `probeExtractionCli()` → cli; else provider key present → api; else throw) and `probeExtractionCli()` (reuse `detectCliTool`). In `extractFromDiscussionEntry`, **move engine resolution above the precheck block (lines 466-493)**: if `cli`, skip provider resolution entirely and call `extractViaCli`; if `api`, keep the existing `resolveAvailableProvider` precheck + `callLLM`. Preserve the existing terminalize/write path for both.
- [ ] **Step 4: Run — PASS** + existing extraction tests green (api path unchanged).
- [ ] **Step 5:** Commit. `git commit -am "feat(extraction): engine router runs before hosted-key precheck; CLI bypasses provider resolution"`

### Task 7: Pre-flight probe endpoint + Settings status + failure UX

**Files:**
- Modify: a routes file (add `GET /companies/:cid/extraction/engine-status`)
- Modify: `server/src/services/extraction.ts` (CLI failure → `sourceInfo.extractionError={kind,message}`; transient `timeout` bounded-retry ≤2 then `failed`; others `failed` immediately)
- Modify: `ui/src/pages/DiscussionDetail.tsx` (CLI-specific banner + how-to-fix link + `data-testid="extraction-failure-banner"`; keep Reprocess + manual create)
- Modify: Settings (CLI engine status row, `data-testid="settings-extraction-engine-status"`)
- Test: `server/src/__tests__/extraction-engine-status-route.test.ts`, `extraction-failure-classify.test.ts`, `ui/src/__tests__/DiscussionDetail*.test.tsx`

- [ ] **Step 1: Failing tests** — route returns `{ engine, cli:{available,tool}, apiKey:boolean }` (RBAC founder/team_lead); `not_installed` failure → entry `failed` (no retry loop) with kind recorded.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** route + failure classification + UI banner/Settings status with the data-testids above.
- [ ] **Step 4: Run — PASS** (server + ui).
- [ ] **Step 5:** Commit. `git commit -am "feat(extraction): engine-status probe, Settings status, actionable CLI failure UX"`

---

## W3b/c — Unified write-memory + index

### Task 8: writeMemoryAndIndex + status-agnostic enqueue (reconciles P1)

**Files:**
- Create: `server/src/services/memory-write.ts` (`writeMemoryAndIndex`, `enqueueMemoryEmbedding`)
- Modify: `server/src/services/memory.ts` (`create`, `update` content-change, `approve` → enqueue via helper, deduped)
- Modify: `server/src/services/internal-agent/tools/memory-propose.ts` (route through helper)
- Test: `server/src/__tests__/memory-write-index.test.ts`; update existing memory-propose tests

- [ ] **Step 1: Failing tests** — create (any status, with text) enqueues exactly one row (`targetTable='memory_items'`, id, `company_id`, `inputText=title+"\n"+content`); a second enqueue for the same item with a live `pending` row is a **no-op** (dedup); approve of an already-enqueued item does not double-enqueue.

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `enqueueMemoryEmbedding(db, companyId, item)` (guards: pgvector present, non-empty text; dedup: skip if a `pending`/`processing` queue row already exists for the target). Invariant = **status-agnostic** enqueue on create + content-change + approve. `writeMemoryAndIndex` = create + enqueue. Route `memory-propose` through the helper (preserves its existing pending-enqueue behavior; now deduped + company-scoped).
- [ ] **Step 4: Run — PASS** + existing memory + memory-propose suites green (update expectations to the shared helper).
- [ ] **Step 5:** Commit. `git commit -am "feat(memory): shared write+index; status-agnostic deduped enqueue on create/update/approve (closes coverage gap)"`

### Task 9: Crew tool + MCP tool wrappers

**Files:**
- Create: `server/src/services/internal-agent/tools/memory-write.ts` (crew `write_memory`)
- Modify: `server/src/services/internal-agent/tool-registry.ts` (register)
- Modify: `server/src/mcp/tools/write-tools.ts` (`memory.write`; route `memory.retain`/`suggest-memory` through `writeMemoryAndIndex`)
- Test: `server/src/__tests__/memory-write-tools.test.ts`

- [ ] **Step 1: Failing tests** — crew `write_memory` + MCP `memory.write` both produce a memory row + enqueue via the shared service; each enforces its auth (crew allowlist; MCP actor/RBAC); `memory.retain` now enqueues.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** thin wrappers over `writeMemoryAndIndex`; register crew tool; update MCP write tools.
- [ ] **Step 4: Run — PASS** (+ `tool-registry`, `write-tools` suites green).
- [ ] **Step 5:** Commit. `git commit -am "feat(memory): write+index exposed via crew tool and MCP tool; unify write paths"`

---

## W4 — Embedding pipeline: per-company key + resilience

### Task 10: Per-company embedder refactor (P0)

**Files:**
- Modify: `server/src/services/embeddings.ts` (`processQueue` resolves embedder per row; `EmbeddingService` accepts `resolveCompanyKey`)
- Modify: `server/src/services/embeddings-worker.ts` (`startEmbeddingWorker(db, { resolveCompanyKey })`)
- Modify: `server/src/services/internal-agent/service-container.ts` (sync embed takes `companyId`; resolve per company)
- Modify: `server/src/index.ts` (wire a `resolveCompanyKey(companyId)` = `llm:openai` secret → env fallback)
- Test: `server/src/__tests__/embedding-key-resolution.test.ts`

- [ ] **Step 1: Failing tests** — a queue row with `company_id=A` embeds with A's `llm:openai` secret; falls back to env when A has no secret; two companies in one batch use their own keys (no cross-use); missing-everywhere → systemic.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `processQueue({ resolveCompanyKey })`: per row, resolve+cache a company embedder (`createProvider`-style or a thin OpenAI client keyed by company); call `embed` with it. Sync callers (`find_similar_*`) pass `companyId`. Reuse `resolveApiKey`/`getProviderApiKey` for `openai`/`llm:openai`.
- [ ] **Step 4: Run — PASS** (+ existing embeddings tests adapted to the new signature).
- [ ] **Step 5:** Commit. `git commit -am "refactor(embeddings): resolve embedder per-company per-row (Settings secret -> env fallback)"`

### Task 11: Backoff+jitter, per-company circuit breaker, dead-letter, SKIP LOCKED

**Files:**
- Modify: `server/src/services/embeddings.ts` (helpers + worker logic)
- Test: `server/src/__tests__/embeddings-resilience.test.ts` (pure helpers); `server/src/__tests__/embeddings-circuit.integration.test.ts` (mixed-company, embedded-pg + fake embedder)

- [ ] **Step 1: Failing pure-helper tests:**

```ts
expect(classifyEmbeddingError({ status: 429, type: "rate_limit_exceeded" })).toBe("transient");
expect(classifyEmbeddingError({ status: 401 })).toBe("systemic");
expect(classifyEmbeddingError({ type: "insufficient_quota" })).toBe("systemic");
expect(classifyEmbeddingError({ status: 400 })).toBe("row_permanent");
for (let n=1;n<=8;n++){ const ms=computeBackoffMs(n,()=>0.5); expect(ms).toBeGreaterThan(0); expect(ms).toBeLessThanOrEqual(300_000); }
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `classifyEmbeddingError`, `computeBackoffMs(attempt, rng=Math.random)` (base 2000 ×2^(n-1), full jitter, cap 300000). `processQueue`: atomic claim `status='pending' AND (next_retry_at IS NULL OR next_retry_at<=now())` with `FOR UPDATE SKIP LOCKED`; honor `Retry-After`. On error by class: `transient` → `pending` + `next_retry_at=now()+computeBackoffMs(attempts)` until ~6 then `failed`; `row_permanent` → `failed`; `systemic` → **restore row to `pending`, do NOT bump attempts, record per-company circuit (reason+TTL), skip that company's remaining rows this tick**.
- [ ] **Step 4: Integration test** (Linux) — company A (bad key → systemic) rows stay `pending`; company B (fake embedder) rows `completed` in the same batch.
- [ ] **Step 5: Run — PASS.**
- [ ] **Step 6:** Commit. `git commit -am "feat(embeddings): backoff+jitter, per-company circuit breaker, dead-letter, SKIP LOCKED"`

### Task 12: Backfill on key-add + reconciliation sweep + manual re-index

**Files:**
- Modify: `server/src/services/embeddings-backfill.ts` (`reindexCompany(companyId)`, `reconcileNullVectors()`)
- Modify: `server/src/index.ts` (schedule the sweep)
- Modify: `server/src/routes/memory.ts` (`POST /memory/:id/reindex`, `POST /memory/reindex-failed`)
- Modify: secrets route (on `llm:openai` create/rotate → `reindexCompany`)
- Test: `server/src/__tests__/memory-reindex-routes.test.ts`, `embeddings-backfill.test.ts`

- [ ] **Step 1: Failing tests** — `:id/reindex` resets a `failed` queue row → `pending` (clears `next_retry_at`); `reindex-failed` re-enqueues all `failed` for the company; saving an `llm:openai` secret triggers `reindexCompany`; sweep enqueues null-vector rows lacking a live queue row. RBAC founder/team_lead.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the routes + sweep + key-add hook.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5:** Commit. `git commit -am "feat(embeddings): key-add backfill, reconciliation sweep, manual re-index endpoints"`

---

## W5 — Status UI (two-axis)

### Task 13: Derive index status (item) + semantic availability (company)

**Files:**
- Create: `server/src/services/memory-index-status.ts` (`deriveIndexStatus`)
- Modify: `server/src/services/memory.ts` (attach `indexStatus` per item; add company `semanticAvailable` to list response)
- Test: `server/src/__tests__/memory-index-status.test.ts`

- [ ] **Step 1: Failing tests** (two axes, vector wins):

```ts
expect(deriveIndexStatus({ vector: [/*…*/], queue: null })).toBe("indexed");      // indexed regardless of key
expect(deriveIndexStatus({ vector: null, queue: "failed" })).toBe("failed");
expect(deriveIndexStatus({ vector: null, queue: "pending" })).toBe("pending");
expect(deriveIndexStatus({ vector: null, queue: null })).toBe("not_indexed");
// company-level: semanticAvailable === hasKey (separate field; banner driver)
```

- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** `deriveIndexStatus` (vector present → `indexed`; else by latest queue row → `failed`/`pending`; else `not_indexed`). In list/get: left-join latest `embedding_queue` row per item, compute per-item `indexStatus`, and a top-level `semanticAvailable` (company has a resolvable key). Guard non-pgvector installs.
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5:** Commit. `git commit -am "feat(memory): two-axis index status (per-item) + semantic availability (company)"`

### Task 14: Badge + banner + re-index actions (UI)

**Files:**
- Create: `ui/src/components/memory/MemoryIndexBadge.tsx` (`data-testid="memory-index-status"`)
- Modify: `MemoryItemCard.tsx`/`MemoryItemRow.tsx`/`MemoryItemTable.tsx` (render badge; `data-testid="memory-reindex-button"` on failed)
- Modify: `ui/src/pages/Memory.tsx` (banner `data-testid="no-llm-key-banner"` when `!semanticAvailable`, founder/team_lead only, dismissible)
- Modify: `ui/src/api/memory.ts` (`reindexItem`, `reindexFailed`)
- Test: `ui/src/components/memory/__tests__/MemoryIndexBadge.test.tsx`

- [ ] **Step 1: Failing test** — badge renders icon+text per state; `failed` shows a Re-index button wired to the API; banner shows only when `!semanticAvailable`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** badge (● indexed / ◐ pending / ⚠ failed+Re-index / ○ not_indexed), render in card/row/table, page banner (role-gated, dismissible), api calls. Mirror existing memory component styling + design system.
- [ ] **Step 4: Run — PASS** (`pnpm test:run memory`).
- [ ] **Step 5:** Commit. `git commit -am "feat(ui): memory index-status badges, no-key banner, re-index actions"`

---

## Determinism seam + E2E (the coverage you asked for)

### Task 15: fake-embedder env seam

**Files:**
- Modify: `server/src/services/embeddings-worker.ts` + `service-container.ts` (when `AOA_E2E_FAKE_EMBEDDER=1` && `NODE_ENV!=='production'`, use a deterministic in-process embedder returning a fixed 1536-vector; an injectable failure mode via a control file for circuit tests)
- Modify: `tests/e2e/playwright.config.ts` (set `AOA_E2E_FAKE_EMBEDDER=1` + a control path)
- Test: `server/src/__tests__/fake-embedder-guard.test.ts` (never active in production)

- [ ] **Step 1: Failing test** — fake embedder active only under the env+NODE_ENV guard; returns a 1536-vector; control file can force a `systemic`/`transient` error.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the guarded seam (mirror `fake-crew-llm.ts` defense-in-depth).
- [ ] **Step 4: Run — PASS.**
- [ ] **Step 5:** Commit. `git commit -am "test: env-gated fake embedder seam for deterministic CI"`

### Task 16: Playwright e2e — every CI-feasible scenario

**Files:** new specs in `tests/e2e/` (model after `team-aoa-tasks-crew-board.spec.ts`, `provider-switching.spec.ts`, `commander-*.spec.ts`); helpers in `tests/e2e/helpers/`

- [ ] **Step 1:** `keyless-extraction.spec.ts` — seed company; write fake-claude control to emit a JSON array; create a discussion entry via API; assert `discussion_extracted_items` appear + entry `completed`; UI shows items; approve → task/memory created. Assert (via `readFakeClaudeInvocations`) **no user content in argv** + content on stdin.
- [ ] **Step 2:** `extraction-failure.spec.ts` — fake-claude `fail` modes → `data-testid="extraction-failure-banner"` with the right message; Reprocess present; manual-create still works.
- [ ] **Step 3:** `memory-index-status.spec.ts` — no key: `data-testid="no-llm-key-banner"` + ○ badges; with `AOA_E2E_FAKE_EMBEDDER=1` + key configured: create memory → badge flips to ● after the worker drains.
- [ ] **Step 4:** `embedding-reindex.spec.ts` — force a `failed` row (fake embedder control) → ⚠ badge → click `memory-reindex-button` → returns to ◐/● .
- [ ] **Step 5:** `embedding-circuit.integration.test.ts` is covered in Task 11 (integration, not e2e). Add `key-add-backfill` assertion to `memory-index-status.spec.ts` (configure key after memory exists → backlog drains).
- [ ] **Step 6: Run** the e2e suite locally on Linux/macOS (`pnpm e2e` or the project's e2e command); all green.
- [ ] **Step 7:** Commit. `git commit -am "test(e2e): keyless extraction, failure UX, index status, re-index, backfill"`

> **Not e2e-coverable in CI:** Commander-on-Windows (Windows e2e skipped) — gated by Task 3 unit/contract test + manual verification.

---

## Wrap-up

### Task 17: Docs + decisions

- [ ] `docs/architecture/decisions.md` (new decision: extraction selectable engine, CLI default desktop, engine-before-precheck; amends #100 context). `CLAUDE.md` (hosted key only for embeddings; engine `cli|api`; per-company embedding key + circuit-breaker/backfill). `docs/api/` (engine-status + reindex endpoints).
- [ ] Commit. `git commit -am "docs: record keyless-except-embeddings decision + behavior"`

### Task 18: Full verification + re-review

- [ ] `pnpm test:run` (server + ui) green; e2e green on Linux.
- [ ] Run the acceptance scenario (design §8) on a desktop instance (no keys → CLI extraction + no-key banner + Commander-on-Windows; add key → drain; kill key → pause-not-fail).
- [ ] Codex re-review of the diff (expect previous P0/P1 resolved); then open the PR.

---

## Self-Review notes

- **Review coverage:** P0 precheck → T6; P0 Windows verify-first → T1/T2/T3; P0 per-company embedder → T10; P1 circuit breaker → T11; P1 codex hardening → T5; P1 enqueue invariant → T8; P1 company backfill → T4/T12; P2 e2e + fake-claude record → T2/T15/T16; P2 two-axis status → T13/T14.
- **Type consistency:** `indexStatus ∈ {indexed,pending,failed,not_indexed}` (T13/T14); `semanticAvailable: boolean` (T13/T14); `classifyEmbeddingError → {transient,row_permanent,systemic}` (T11); `classifyCliError → {not_installed,not_authed,timeout,nonzero_exit,unparseable}` (T5/T7).
- **Ordering:** T1 spike gates T3 (don't implement Windows delivery before it's proven). T4 schema gates T10/T11/T12. T10 (per-company embedder) gates T11 (circuit per company).
- **Manual-only gate:** Commander-on-Windows (CI can't run Windows e2e) — explicit in T3 + T18.

---

## Rev. 3 — Codex re-review fixes (all 9 prior findings RESOLVED; these 5 new ones folded in)

**A1 (P1) — pgvector is not present in the embedded-postgres used by e2e.** Vector columns are conditionally created (migration `0038_marvelous_vapor.sql`; gated by `db-capabilities.ts`), so a fake embedder alone cannot make a badge flip to ● indexed in a non-pgvector DB. **Split the coverage:**
- **T16 e2e (embedded-pg, no pgvector):** covers no-key banner, `not_indexed`/`disabled` badges, extraction happy-path + failure UX, manual re-index *request* round-trip. These do NOT assert a stored vector.
- **New T11b / T12 integration (pgvector-enabled Postgres):** the vector-dependent assertions — badge → ● indexed, key-add backfill drains, circuit-break leaves `pending`. Run against a pgvector Postgres (Docker `pgvector/pgvector` image on Linux CI, or `skipIf(!hasVectorSupport)`). Add a CI step/job that provides pgvector for this lane. Acceptance §8 items 4-5 are validated here, not in embedded-pg e2e.

**A2 (P1) — shared API contracts.** T7 (`engine-status`), T12 (reindex endpoints), T13 (`indexStatus`, `semanticAvailable`) must add their types/validators to **`packages/shared/src`** and have the UI (T14, T7 Settings) consume those shared types — not ad-hoc local shapes. Add a `packages/shared` modify + a shared-contract test to T7/T12/T13.

**A3 (P1) — centralize the fake-embedder seam.** T15 must place the env-gated seam **inside `embeddings.ts`** at the single embedding-client creation point, so `generateEmbedding()`, `generateEmbeddingsBatch()`, the worker, AND `service-container` all flow through it. Note: `memory.ts:300` calls `generateEmbedding()` directly for query-time semantic search — it must hit the same seam. (Otherwise query embeddings still call real OpenAI in CI.)

**A4 (P2) — activity logging.** T12's mutating endpoints (`POST /memory/:id/reindex`, `POST /memory/reindex-failed`) must call `activityService`/`logActivity` (repo rule for mutating actions). Add an assertion to the T12 route tests.

**A5 (P2) — avoid a circular import.** T5 imports `parseExtractedItems` from `extraction.ts`, while T6 makes `extraction.ts` call the CLI module → cycle. **Fix:** add **Task 4b — create `server/src/services/extraction-parser.ts`** holding `parseExtractedItems` + `ExtractedItem`/`ExtractedItemType` types; `extraction.ts` re-exports them for back-compat; `extraction-cli.ts` imports from `extraction-parser.ts`. (Alternative: CLI returns raw text and `extraction.ts` parses — but the dedicated parser module is cleaner and unit-testable in isolation.)

> Codex verdict on rev. 2: prior P0/P1/P2 all RESOLVED; these 5 are mechanical refinements. After folding A1-A5 in, the plan is implementation-ready; a final Codex **code** review (T18) is the remaining gate.
