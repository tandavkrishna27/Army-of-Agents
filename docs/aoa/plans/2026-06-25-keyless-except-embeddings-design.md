# Keyless-Except-Embeddings — Design

> **Update 2026-06-27 (partial supersede):** the "selectable engine" model below
> (a `cli` engine with a **dormant `api` fallback** kept for crew/Adjutant
> extractors) was superseded. Extraction is now **CLI-only** everywhere and the
> `api` engine + engine-status route are deleted — see
> `docs/aoa/plans/2026-06-27-decouple-extraction-from-keys-spec.md` and Decision
> #104's 2026-06-27 amendment. The embeddings/resilience sections still hold.

**Status:** Draft (pending Codex review)
**Date:** 2026-06-25
**Branch:** one feature branch, one PR, multiple scoped commits
**Target:** Windows/Mac desktop app first; cloud is a separate later initiative.

---

## 1. Goal

The only hosted API key AoA needs at runtime is for **embeddings** (OpenAI
`text-embedding-3-small`). Everything else — agents, Commander/crew, and
**discussion extraction** — runs **keyless** through the user's local CLI
(Claude Code / Codex), which authenticates with the subscription the user
already has.

Nothing breaks without the embeddings key: semantic search degrades to
keyword/temporal, and the embedding/index state is shown to the user instead of
failing silently.

## 2. Why

- **Desktop distribution:** a user should not have to buy/configure an Anthropic
  or OpenAI API key just to use Discussions when they already pay for Claude.
- **Cost:** extraction runs on the local subscription, not metered API tokens.
- **Already-broken-today:** the CLI spawn path mangles the prompt on Windows
  (argv-through-cmd.exe), which currently produces empty Commander turns. Fixing
  it unblocks both Commander and keyless extraction.

## 3. Current state (verified)

| Area | Today | File |
|------|-------|------|
| Extraction engine | Direct hosted API call (`callLLM` → Anthropic/OpenAI HTTP) | `server/src/services/extraction.ts:123` |
| Why not crew-CLI | Decision #100 shelved the crew/agent extraction path: MCP bridge wired for `claude_local` only + the `claude` headless `submit_extracted_items` handshake hangs on Windows → entry stuck `processing` (silent loss) | `docs/architecture/decisions.md:678`, `server/src/services/internal-agent/subagents/extraction-consumer.ts:8` |
| CLI prompt delivery | `claude` gets the prompt as an **argv positional** through `cmd.exe` on Windows (mangled → empty turn); `codex` already feeds the prompt via **stdin** (`codex exec --json -`) and works | `server/src/services/internal-agent/cli-mode.ts:644`, `:728` |
| Embeddings | OpenAI `text-embedding-3-small` hardcoded; `createEmbeddingService` queue is reusable + table-agnostic but inconsistently used | `server/src/services/embeddings.ts:13`, `:293` |
| Memory write gap | `memory.create()` / `approve()` never enqueue an embedding → normally-approved memory may never be indexed | `server/src/services/memory.ts:197`, `:258` |
| Embedding key | Background worker + tool-time service read **env `OPENAI_API_KEY` only**, ignoring the Settings secret `llm:openai` | `server/src/services/embeddings-worker.ts:65`, `server/src/services/internal-agent/service-container.ts:67` |
| Embedding retry | 3 fixed-interval attempts (no backoff/jitter), then `failed` silently; no UI, no manual retry; queue rows carry no `company_id` | `server/src/services/embeddings.ts:397`, `packages/db/src/schema/embedding_queue.ts` |
| Status UI | None (silent degradation) | — |

## 4. Architecture

### 4.1 Extraction = selectable engine (Option B, server-side one-shot CLI)

Extraction stays a **server-side function that captures output and writes the
rows itself** (exactly today's structure), but the transport becomes pluggable:

```
extractFromDiscussionEntry(entry)
  → buildPrompt(entry)
  → runExtraction(prompt, content, {db, companyId})   // NEW router
       ├─ engine = 'cli'  → extraction-cli.ts  (spawn claude --print / codex exec, stdin in, stdout out)
       └─ engine = 'api'  → callLLM()          (existing direct-API, kept dormant)
  → parseExtractedItems(stdout)   // unchanged
  → write discussion_extracted_items + terminalize entry  // unchanged
```

Crucially this is **Option B**: NO MCP bridge, NO `submit_extracted_items`
handshake. The CLI is invoked headless (`--print` / `exec`), the model returns
the JSON array as text, the server parses and writes. This sidesteps both
Decision #100 blockers and is naturally provider-agnostic.

**Engine selection (`resolveExtractionEngine(db, companyId)`):**
- `auto` (default): use `cli` when a CLI is installed + authed; else `api` when a
  provider key is configured; else surface "no extraction engine available."
- Desktop default resolves to `cli`.
- The direct-API path is **not deleted** — it is the dormant `api` engine and the
  seed for the separate future "cloud provider-keys per user" initiative.

**One-shot invocation (no tools):**
- claude: `claude --print --output-format text --system-prompt-file <promptfile>`, entry text on **stdin**.
- codex: `codex exec --json -`, prompt on **stdin**, final assistant text parsed out.
- ~60s timeout + grace kill. cwd = tmpdir (never read the project CLAUDE.md).

### 4.2 Windows prompt delivery (W1, prerequisite)

Stop passing user content as an argv positional through cmd.exe. Deliver the
prompt over **stdin** (the pattern codex already uses) for claude too — both in
the new one-shot extractor and in the persistent Commander chat (turn 1). The
multi-line system context keeps using `--system-prompt-file` (temp file), which
is already Windows-safe. Net effect: **no user/content string ever rides argv on
Windows.**

### 4.3 Unified memory-write + RAG indexing (W3)

One service function is the single choke point for "persist a memory item and
index it for RAG":

```
writeMemoryAndIndex(db, companyId, data) :
  row = memoryService.create(...)            // Postgres write (keyless, always)
  if row.status === 'approved':
      enqueueMemoryEmbedding(db, companyId, row)   // RAG enqueue
  return row
```

- `enqueueMemoryEmbedding` is also called from `memory.approve()` (pending →
  approved) — closing the coverage gap.
- Exposed via **two thin wrappers** over the same service: a **crew tool**
  (internal `tool-registry`) and an **MCP outbound tool** (org agents). Both call
  `writeMemoryAndIndex`; auth differs (crew tool allowlist vs MCP actor/RBAC).
- Existing memory-write tools (`memory.retain`, `suggest-memory`,
  `propose_memory_from_thread`) are routed through the shared enqueue so all
  paths index consistently.

### 4.4 Embedding pipeline resilience (W4 + behavior)

The `embedding_queue` is a durable write-behind outbox. We add the enterprise
resilience layer on top.

**Per-row company + key resolution.** Add `embedding_queue.company_id`
(populated on enqueue). The worker resolves the **owning company's** key
(`llm:openai` Settings secret → env `OPENAI_API_KEY` fallback) per row, reusing
the existing secret resolver.

**Three-way error classification per attempt:**

| Class | Examples | Handling |
|-------|----------|----------|
| Transient | 429 `rate_limit_exceeded`, 5xx, timeout, network | retry with exponential backoff + **full jitter**, base 2s ×2, cap 5 min, ~6 attempts, honor `Retry-After` |
| Row-permanent | malformed/oversized input for one row | dead-letter fast (→ `failed` with error) |
| Systemic | no key / invalid key / `insufficient_quota` | **circuit-break**: pause the worker for that company, leave rows `pending` (NOT `failed`) so the backlog auto-drains when a valid key appears |

**Backoff persistence:** add `embedding_queue.next_retry_at`; the worker only
picks rows where `next_retry_at IS NULL OR next_retry_at <= now()`. Concurrency:
`SELECT … FOR UPDATE SKIP LOCKED`.

**Dead-letter = visible `failed` rows** + a manual **Re-index** action (per item
and "re-index all failed").

**Backfill / catch-up:** on key-add and via a periodic reconciliation sweep,
enqueue every row with a null vector (`memory_items`, `discussions`,
`discussion_extracted_items`) that has no live queue row.

### 4.5 Status model (W5)

Per-item derived `indexStatus`:

| Status | Derivation | Badge |
|--------|-----------|-------|
| `disabled` | company has no embeddings key configured | ○ Not indexed (no key) |
| `indexed` | vector column not null | ● Indexed |
| `pending` | live queue row `pending`/`processing` (or null vector, no key issue) | ◐ Indexing… |
| `failed` | latest queue row `failed` | ⚠ Failed — Re-index |

- Surfaced on memory card / row / table + a single dismissible banner on the
  Memory page when `disabled`. Icon **and** text (not color-only).
- Visible to **founder + team_lead**; hidden for team_member.

### 4.6 Extraction failure UX

Classify: `not_installed` / `not_authed` / `timeout` / `nonzero_exit` /
`unparseable`. Transient (timeout, transient exit) → bounded retry; the rest →
actionable banner ("Claude CLI not detected — install and run `claude login`")
with a how-to-fix link. Reprocess = manual retry. The founder can always
hand-create tasks/memory from the entry (never fully blocked). A pre-flight CLI
probe runs at startup and is shown in Settings so users fix setup before they
ever extract.

## 5. Data model changes

- `embedding_queue.company_id uuid` (nullable for back-compat; populated on new
  enqueues; backfill best-effort by resolving target → company).
- `embedding_queue.next_retry_at timestamptz null`.
- (Drizzle only — `packages/db/src/schema/embedding_queue.ts` + `pnpm
  db:generate`; never raw SQL.)

## 6. Out of scope (note only)

- Local/offline embedding model (removing even the OpenAI key) — later phase.
- Per-row embedding model/version + shadow-index reindex on model upgrade.
- Cloud "provider-keys per user (crew + org adapters)" — separate initiative; the
  dormant `api` engine is its seed.

## 7. Risks

- **claude `--print` stdin multi-turn semantics** for the persistent Commander
  chat — must be live-verified on Windows (manual step in plan). The one-shot
  extractor is lower risk (single prompt, process exits).
- **Per-company key in a global worker** — adding `company_id` to the queue is the
  clean fix; backfilling existing rows' company is best-effort.
- **Circuit-breaker correctness** — must pause (not fail) on systemic errors, or a
  missing key burns the whole backlog to `failed`.

## 8. Acceptance (measurable)

Fresh desktop install, only a Claude CLI login (no API keys):
1. A discussion entry extracts into items via CLI; approving creates Tasks/Memory.
2. Memory shows ○ "Not indexed (no key)"; Memory page shows the no-key banner.
3. Commander responds on Windows (no empty turns).

Then add `OPENAI_API_KEY` (or Settings `llm:openai`):
4. Backlog auto-indexes; badges flip to ● Indexed; semantic search returns results.
5. Kill the key mid-run → worker pauses, rows stay `pending` (not `failed`);
   restore key → backlog drains.

---

## Follow-ups / Deferred

Known gaps and deferred work from the shipped implementation. Not blocking merge.

1. **Crew-tool extractors still use `callLLM` (hosted fallback).** The three crew/Adjutant extractors in `extraction.ts` — `extractMemoryCandidates` and its two sibling callers — go through `callLLM` (the hosted provider path) as their fallback. They are not routed through the new selectable CLI engine. Autonomous discussion extraction IS keyless (the main `resolveExtractionEngine` path); the thread-native / Adjutant crew path is not yet converted.

2. **`reconcileNullVectors` / `reindexCompany` cover `memory_items` only.** The reconciliation sweep that enqueues null-vector rows does not yet handle `discussions.summary_embedding` or `discussion_extracted_items.embedding`. Those two columns remain unreconciled. Deferred to a follow-up sweep expansion.

3. **`detectCliTool` runs an `execSync` probe on every extraction.** There is no caching of the CLI availability result between requests. On busy instances this is an unnecessary repeated process spawn. A short-lived in-process cache (or a startup probe + periodic refresh) would eliminate the per-extraction overhead.

4. **`FOR UPDATE SKIP LOCKED` claim uses a raw-SQL CTE.** The embedding worker's atomic claim is exercised against real PostgreSQL in the pgvector integration/CI lane. Unit tests use a mock fallback path that does not exercise the SQL. Ensure the integration test lane (Linux CI) covers this path; do not rely on unit tests alone to validate the locking behavior.

5. **Codex one-shot uses a shared managed `CODEX_HOME`.** This is correct for the current single-tenant desktop deployment. If AoA moves to a multi-tenant server model, each company should have a per-company `CODEX_HOME` suffix to avoid cross-company config bleed.

6. **Local/offline embeddings (drop the OpenAI key entirely).** Running a local embedding model (e.g., via Ollama) would make AoA fully keyless end-to-end. Deferred to a future phase — the `createOpenAiEmbedder` chokepoint in `server/src/services/embeddings.ts` is the single swap point when this becomes viable.

---

## 9. Revisions from review (Codex + self) — folded into the plan

Both reviewers reached **needs-revisions**. Corrections, now authoritative:

1. **Engine selection must precede the hosted-key precheck (P0).** Today
   `extraction.ts:466-493` resolves a provider and marks the entry `skipped` when
   no key exists, *before* any extraction. `resolveExtractionEngine` must run
   first; the **CLI engine bypasses provider resolution entirely**; the precheck
   moves *inside* the `api` engine only. Without this the keyless path never runs.

2. **Windows CLI delivery is verify-first, not assume-first (P0).** `claude
   --print` is documented as `claude -p "<query>"` and `cat file | claude -p
   "<query>"` — not `--print` with no query and an open stdin stream. So:
   (a) **one-shot extraction** uses `printf '%s' "$content" | claude -p "<fixed
   instruction>"` and **closes stdin**; (b) the **persistent Commander chat** fix
   must be empirically proven on Windows before implementing (a spike task), since
   leaving stdin open mid-session is unproven. `fake-claude` must be hardened to
   **record stdin + argv** so the contract is e2e-assertable.

3. **Per-company embedding key is a service refactor, not a one-liner (P0).**
   `processQueue` calls `llm.embed(text)` with no company context; the worker +
   `service-container` each build ONE embedder from ONE env key. Fix:
   `processQueue({ resolveCompanyKey })` resolves/caches a **per-company embedder
   per row** (Settings `llm:openai` → env fallback). Sync callers pass
   `companyId`. Prevents cross-company key use and makes Settings keys work.

4. **Embedding-queue rows carry `company_id` + a backfill (P1).** New rows set it
   on enqueue; a one-time backfill derives company from
   `memory_items`/`discussions`/`discussion_extracted_items` for existing rows;
   rows that stay null fall back to env key only.

5. **Enqueue invariant = status-agnostic on write (reconciles P1).**
   `memory-propose` already enqueues *pending* items. New invariant: enqueue on
   **create + content-change + approve**, whenever text is non-empty, deduped
   against a live queue row. All memory-write paths (`create`, `approve`,
   `memory.retain`, `suggest-memory`, `propose_memory_from_thread`) route through
   the one shared helper. (Retrieval already filters by `approved` where needed.)

6. **Circuit breaker is per-company + restore-to-pending (P1).** On a systemic
   error: restore the in-flight row to `pending` **without** bumping `attempts`,
   record a per-company circuit (reason + TTL), and **skip only that company's
   rows** while other companies keep draining. Atomic claim via `FOR UPDATE SKIP
   LOCKED`. Tested with mixed-company batches.

7. **Codex one-shot reuses the hardened path (P1).** Factor `runCodexExecJson()`
   reusing model resolution (`readSharedCodexModel`/`resolveCodexChatModel`) and
   auth (`ensureCodexAuthInHome`) from `cli-mode.ts`, returning final assistant
   text; do not hand-roll a bare `codex exec`.

8. **Status model is two axes (P2).** Per-item index state (`indexed` if a vector
   exists, else `pending` / `failed` / `not_indexed`) is **independent** of company
   semantic availability (`enabled` / `disabled_no_key`). Precedence: a vector
   present → `indexed` regardless of key; "no key" is a **page-level banner**,
   never an override that hides an already-indexed item.

9. **Determinism seams for CI (P2).** Embeddings hit `api.openai.com` directly
   with no fake seam today. Add an env-gated **fake embedder**
   (`AOA_E2E_FAKE_EMBEDDER=1`, mirroring `AOA_E2E_FAKE_CREW_LLM`) so every
   embedding scenario is deterministically e2e/integration-testable on Linux CI.
   With the existing `fake-claude`/`fake-codex` PATH seam, all non-Windows
   scenarios are coverable.

### Scenario → test-level matrix

| Scenario | Coverage | CI |
|---|---|---|
| Keyless CLI extraction happy path | E2E (fake CLI emits JSON) + unit | Linux |
| Extraction failure (not-installed/not-authed/timeout/unparseable) | E2E (fake CLI fail modes) + unit classifier | Linux |
| No-key memory banner + per-item badges | E2E (no key) + unit deriver | Linux |
| Key-add backfill | E2E/integration (fake embedder) | Linux |
| Key-death circuit-break (pause, not fail) | integration (fake embedder + injected systemic error) | Linux |
| Manual re-index | E2E + route test | Linux |
| Commander-on-Windows stdin/argv | unit/contract (invocation shape) + manual | Windows e2e skipped — manual gate |
