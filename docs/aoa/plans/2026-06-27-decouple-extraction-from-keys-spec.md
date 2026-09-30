# Spec — Decouple extraction from hosted keys; keys are embeddings-only

**Date:** 2026-06-27
**Branch:** `feat/keyless-except-embeddings` (PR #235, NOT yet merged — this corrects its design before merge)
**Status:** Spec for review (spec → plan → eng+codex review → implement → verify)

---

## Context

The "keyless-except-embeddings" thesis is: **the only hosted API key AoA ever needs is for embeddings.** Extraction, agents, and Commander run keyless off the operator's local `claude`/`codex` login.

The current build on this branch violates that thesis in two ways the founder rejected on review:
1. **Extraction is coupled to hosted keys.** The engine router falls back to a hosted-API extraction path when no CLI is found, and three other extraction paths (debrief-push, file-import, crew memory-candidate tool) *always* use a hosted key.
2. **The Settings UI presents keys as powering extraction.** A "LLM providers" page shows an extraction engine-status banner ("Local CLI ready (claude_cli)") and copy reading "Used by Discussion extraction and memory embeddings." This surfaces background plumbing the user should never see and frames keys as an extraction concern.

PR #235 is not merged, so we fix this on the branch — `main` must never receive the coupled/confusing design.

**Who is affected:** founders / board operators configuring AoA. Today they see a keys page that implies extraction needs a key (it doesn't) and can't find where embeddings is configured (it's mislabeled).

**Done when:** (a) no extraction code path reads a hosted provider key; (b) hosted keys are consumed only by embeddings; (c) the embeddings key lives in a Settings → Memory section with status + re-index; (d) the extraction engine-status banner is gone; (e) full typecheck + suite green + a live isolated-instance e2e proves extraction works with NO key set.

---

## Current State (verified via file:line investigation, 2026-06-27)

### Extraction ↔ key coupling — 9 call-sites
| # | file:line | What |
|---|---|---|
| 1 | `server/src/services/extraction-engine.ts:30` | `ExtractionEngine = "cli" \| "api"` — the `"api"` member |
| 2 | `extraction-engine.ts:149-164` | Step 2 "api" fallback: `resolveAvailableProvider` → engine `"api"` |
| 3 | `extraction-engine.ts:27` | `resolveAvailableProvider` import |
| 4 | `extraction.ts:458` | `useApiPath = engine === "api"` |
| 5 | `extraction.ts:506-531` | CLI→API fallback on `not_authed`/`not_installed` |
| 6 | `extraction.ts:561-642` | the hosted-API extraction branch (`createProvider` + `provider.chat`) |
| 7 | `extraction.ts:230` | `extractFromDebrief` → `callLLM` (debrief-push, MCP) |
| 8 | `extraction.ts:746` | `extractFromRawText` → `callLLM` (file import) |
| 9 | `extraction.ts:960` | `extractMemoryCandidates` → `callLLM` fallback (crew/MCP tool) |
| + | `extraction.ts:98-195` | `callLLM`/`callAnthropic`/`callOpenAI` (hosted plumbing) |
| + | `routes/extraction.ts:39-91` | engine-status route (`apiKey` via `hasProviderKey` ×3) |

### Keys: who uses what (the decoupling map)
- **EMBEDDINGS (keep, all `"openai"`):** `index.ts:971` (worker), `memory.ts:410/596/794` (search), `service-container.ts:126` (Commander embedSync), `memory-index-status.ts:62` (`resolveSemanticAvailable`), `embeddings.ts:124` (legacy worker via `resolveApiKey`).
- **EXTRACTION (remove):** the 9 above.
- **No agent/Commander *execution* reads these keys** (API-mode adapters removed, Decision #91; guard test `internal-agent-cli-only.test.ts`). Confirmed: after decoupling, the only `llm:*` consumer is the OpenAI embeddings key.

### Embeddings (unchanged by this spec)
OpenAI-locked: `embeddings.ts` `createOpenAiEmbedder` (`:509`), `DEFAULT_EMBED_MODEL="text-embedding-3-small"` (`:427`), vector columns fixed `vector(1536)` (`memory_items.ts:29`, `discussions.ts:32`). The secrets reindex-on-key-add trigger already keys on `llm:openai` only (`secrets.ts:257/300`). **No embeddings logic changes here.**

### UI
- Engine banner + extraction copy live ONLY in `LLMProvidersSection.tsx` (banner block `:208-244`, query `:84-94`, invalidation `:118-120`) + wrapper copy `LLMProvidersSectionWrapper.tsx:15`.
- Settings nav defined in `SettingsLayout.tsx:10-13,32-41` + `SettingsPage.tsx:19-22,28-69`. No "Memory" section exists.
- Canonical Memory page = `MemoryExplorer.tsx` (`/memory/explore`) — has per-item index badges (`MemoryIndexBadge.tsx`), NO semantic banner, NO embeddings config. The "add an OpenAI key" banner exists only in legacy `Memory.tsx:379-402` (`/memory/legacy`).
- `reindexFailed` API client exists (`api/memory.ts:223`) with NO UI consumer.
- Dead-after-removal: `ui/src/api/extraction.ts`, `queryKeys.extraction.engineStatus` (`queryKeys.ts:241-244`), shared `ExtractionEngineStatusResponse` (`packages/shared/src/types/extraction-engine.ts`).

---

## Proposed Change

### Decisions locked with founder (2026-06-27)
- **D1 — Extraction is CLI-only everywhere.** Route ALL extraction (Discussion + debrief-push + file-import + crew memory-candidate tool) through `extractViaCli`. Delete `callLLM`/`callAnthropic`/`callOpenAI` + the `"api"` engine branch. No extraction code reads a hosted key.
- **D2 — Keys are embeddings-only.** Keep the 7 OpenAI embeddings consumers untouched.
- **D3 — Embeddings provider = OpenAI-only now.** Gemini/multi-provider is OUT OF SCOPE (separate project; dimension/embedding-space minefield).
- **D4 — Settings → Memory section.** Rename "LLM providers" → "Memory". Contents: OpenAI embeddings key (Anthropic + Google dropped from the UI for now) + a "semantic search: on/off" status line + a "Re-index all" button (wires `reindexFailed`).
- **D5 — Memory page banner.** Add a dismissible "Semantic search off — add an embeddings key in Settings → Memory" banner to the canonical `MemoryExplorer`. Update legacy banner copy too.
- **D6 — Amend Decision #104.** It currently says the `"api"` engine is "retained dormant." Founder overrides: it is removed. Update `decisions.md` + `CLAUDE.md` Rule #11.

### Implementation details

**Server — extraction CLI-only**
1. `extraction-engine.ts`: `resolveExtractionEngine` returns `"cli"` or throws (delete Step 2 `:149-164`, the `"api"` type member `:30`, the `resolveAvailableProvider` import `:27`). Update the throw message to drop "set a provider key in Settings → LLM Providers" → "Install a CLI (e.g. Claude Code) and run its login."
2. `extraction.ts` `extractFromDiscussionEntry`: delete `useApiPath` (`:458`), the CLI→API fallback (`:506-531`), and the hosted branch (`:561-642`). On CLI failure → entry `failed`/`skipped` with the CLI-guidance message (no key mention).
3. `extraction.ts` convert to CLI: `extractFromDebrief`, `extractFromRawText`, `extractMemoryCandidates` all call `extractViaCli` (resolve the company CLI tool via `resolveCompanyCliTool`). The crew memory-candidate tool keeps its distinct system-prompt + output parser, but the transport becomes the CLI (build a `extractMemoryCandidatesViaCli` using the existing memory-candidate prompt; parse via the existing candidate parser).
4. Delete `callLLM`/`callAnthropic`/`callOpenAI` (`:98-195`) and the now-unused imports (`getProviderApiKey`, `createProvider`, `resolveAvailableProvider`) at `extraction.ts:6`. Keep `providers/index.ts` intact (embeddings + Commander still use it).
5. Delete the engine-status route (`routes/extraction.ts`) and unregister it; delete the shared `ExtractionEngineStatusResponse` type + re-exports. (No consumer remains.)

**Server — embeddings:** no change.

**UI**
6. Delete from `LLMProvidersSection.tsx`: the banner block (`:208-244`), the `engineStatus` query (`:84-94`), the extraction half of `invalidateProviderState` (`:118-120`), the `extractionApi` import + now-unused icons. Delete `ui/src/api/extraction.ts` + `queryKeys.extraction.engineStatus`.
7. Rename the section component → embeddings/Memory; `LLM_PROVIDERS` → OpenAI only (drop `anthropic` + `google`). Add a "semantic search: on/off" status line (from `memory-list` `semanticAvailable`) + a "Re-index all" button calling `memoryApi.reindexFailed`.
8. Settings nav: rename "LLM providers" → "Memory" id+label+icon in `SettingsLayout.tsx` + `SettingsPage.tsx` (`?tab=llm` → `?tab=memory`; keep `llm` as a redirect alias to avoid dead bookmarks).
9. `MemoryExplorer.tsx`: add a dismissible "Semantic search off — add an embeddings key in **Settings → Memory**" banner (port the pattern from `Memory.tsx:379-402`, gated on `semanticAvailable === false`). Update legacy `Memory.tsx` banner copy to the new path.

**Docs**
10. `decisions.md`: amend Decision #104 (api engine removed, extraction CLI-only). `CLAUDE.md`: Rule #11 + the extraction/adapters notes. Update `docs/aoa/plans/2026-06-25-keyless-except-embeddings-*.md` references and any "Settings → LLM Providers" doc strings → "Settings → Memory".

---

## Acceptance Criteria
1. No file under `server/src/services/extraction*.ts` or `routes/extraction.ts` references `getProviderApiKey` / `resolveAvailableProvider` / `createProvider` / `callLLM` (enforced by a new guard test).
2. With NO hosted key configured, all four extraction paths (Discussion reprocess, debrief-push, file-import, crew memory-candidate tool) run via the CLI and produce items on a machine with `claude`/`codex` logged in.
3. With NO CLI installed AND no key, extraction fails with a CLI-install message that does NOT mention provider keys.
4. Embeddings unchanged: with an OpenAI key, items index; without, `semanticAvailable=false` and search degrades to keyword (existing behavior).
5. Settings has a "Memory" section (no "LLM providers"); it shows the OpenAI embeddings key, a semantic on/off line, and a working "Re-index all" button. No Anthropic/Google key fields. No extraction engine-status banner anywhere in the app.
6. `MemoryExplorer` shows the "add a key → Settings → Memory" banner when `semanticAvailable=false`.
7. `decisions.md` #104 + `CLAUDE.md` Rule #11 reflect CLI-only extraction.
8. `pnpm -r typecheck` clean; full `pnpm test:run` green; live isolated-instance e2e passes (extraction with no key; Settings → Memory renders; no engine banner).

## Testing Plan
| Layer | What | Δ |
|---|---|---|
| Unit | Guard test: extraction modules reference no provider-key helpers | +1 |
| Unit | `resolveExtractionEngine` returns "cli" or throws (no "api") | rewrite `extraction-engine.test.ts` |
| Unit | debrief / file-import / crew paths call `extractViaCli` (mock spawn) | +3 |
| Unit | Delete/rewrite api-path tests: `extraction-refactor.test.ts`, `extraction-atomic-claim.test.ts` (pin "cli"), `extraction-cli-path.test.ts` (drop fallback case), `extraction-debrief-key.test.ts` | rewrite |
| Unit (UI) | `SettingsPage-redesign.test.tsx` → "Memory" label, OpenAI-only, no engine banner | rewrite |
| UI | Memory section: key + status + Re-index all; MemoryExplorer banner | +2 |
| E2E | `tests/e2e/memory-index-status.spec.ts` — banner copy/path | update |
| Live | isolated instance: keyless extraction (no key) end-to-end; Settings → Memory; no banner | manual |

## Rollback
All changes are on `feat/keyless-except-embeddings` pre-merge. Rollback = revert the commit(s). No DB migration, no data change (embeddings schema untouched).

## Effort (CC-scale)
Server decouple + delete plumbing (moderate) · crew memory-tool CLI conversion (the one tricky path) · UI section move + Memory controls + banner (moderate) · docs amend (small) · test rewrites (moderate).

## Out of Scope
- Gemini / any second embedding provider; embedder provider-abstraction; vector-dimension migration (separate project).
- Any change to embeddings logic, the embedding model, or vector schema.
- Merging PR #235 (blocked until this lands on the branch).
- Converting Commander/agent execution (already keyless).

## Related
- PR #235 (the keyless-except-embeddings feature this corrects)
- Decision #104 / `docs/architecture/decisions.md` (to amend)
- CLAUDE.md Rule #11

---

## Revision 1 (post-Codex review, 2026-06-27) — supersedes above where it conflicts

Codex review scored the draft 6/10 and surfaced 10 findings. Resolutions:

**R1 — Crew scope is all 4 extraction tools, not one.** `extractMemoryCandidates` is the shared engine for `extract_memory_candidates` AND `extract_decisions` / `extract_insights` / `extract_references` (`extraction.ts:978/990/1002`; tools `memory-extract-{candidates,decisions,insights,references}.ts`). All 4 route through the CLI path and all 4 must get CLI-failure-aware error handling (their current provider-missing messages updated).

**R2 — The `ExtractionLlm` injection seam is RETAINED as test/eval-only; production is CLI-only.** `extractMemoryCandidates(content, { llm? })`: if `llm` is injected → use it (tests/evals only); if not → `extractViaCli`. Production callers (the 4 crew tools) inject NO `llm` → always CLI. `callLLM`/`callAnthropic`/`callOpenAI` are deleted (the no-`llm` branch becomes CLI, not hosted). Add a guard test asserting no production tool passes a hosted `llm`. This keeps production keyless without breaking deterministic evals.

**R3 — memory-keeper eval stays as-is (real-LLM injection).** `server/src/eval/memory-keeper-extraction/suite.ts:119-186` injects a real OpenAI `ExtractionLlm` to measure extraction quality deterministically — it uses the retained test/eval seam (R2), so it keeps working. It is NOT a production path. Documented, not changed.

**R4 — "Re-index all" gets a REAL endpoint (not the failed-only one).** The existing `/memory/reindex-failed` only retries failed rows — mislabeling it "Re-index all" misleads users. Add `POST /companies/:cid/memory/reindex-all` (founder-only) that re-enqueues EVERY company memory item for embedding (extend `embeddings-backfill.reindexCompany` to a full re-enqueue). The button is "Re-index all" with a confirm dialog warning it re-embeds all memory (cost/time). (If we descope the endpoint, the button must instead read "Retry failed indexing" and call the existing route — but default is the real endpoint to match founder intent.)

**R5 — Re-index button is founder-only in the UI.** Both reindex endpoints are board+founder-only (`memory.ts:1142-1147`). The Settings → Memory button is hidden/disabled for non-founders and handles 403 gracefully (no broken button for team_leads).

**R6 — Per-path CLI-failure behavior (corrects AC#3):**
- **Discussion reprocess** → entry terminalizes `failed`/`skipped` with a CLI-install message (NO key mention). *(AC#3 applies here.)*
- **debrief-push** → same terminalize + notification as today, message updated to CLI-guidance.
- **file-import** → KEEP the existing graceful fallback: `extractFromRawText` returns `[]` on CLI failure and `file-import.ts:187-218` falls back to paragraph chunking. File import still works with no CLI; it does NOT hard-fail. *(AC#3 does NOT apply to file-import.)*
- **crew tools** → return a tool error to the agent with CLI-guidance.

**R7 — Settings tab alias, exact behavior.** `VALID_SECTIONS` replaces `"llm"` with `"memory"`; add a normalization map so `?tab=llm` resolves to `memory` (no dead bookmarks, no hidden-active-section fallthrough to General); tab-change writes `"memory"`; `SettingsSectionId` union updated.

**R8 — Test/cleanup checklist additions (dead contracts):** delete `server/src/__tests__/extraction-engine-status-route.test.ts`; remove `ExtractionEngineStatusResponse` re-exports (`packages/shared/src/index.ts:326-328`, `types/index.ts:3-6`) + the type file; delete `ui/src/lib/queryKeys.ts:241-244` (`extraction.engineStatus`) + `ui/src/api/extraction.ts`.

**R9 — Update legacy key-error UI copy.** `ui/src/pages/__tests__/DiscussionDetail.extraction.test.ts:81-88` (and the `EntryRow`/MeBubble error copy it covers) expect provider/API-key messages pointing to Settings. Once server extraction errors stop mentioning keys, update these assertions + copy to CLI-guidance.

**R10 — Doc/comment scope.** Update `extraction-cli.ts:2-14` header (CLI extractor now serves debrief/file-import/crew too, not just discussion) and `extraction.ts:764-778` (no provider fallback chain). Include in the docs pass.

### Corrected Acceptance Criterion #3
> With NO CLI installed AND no key: **Discussion reprocess and debrief-push** terminalize with a CLI-install message that does NOT mention provider keys; **file-import** still succeeds via paragraph chunking (graceful, no hard error); **crew tools** return a CLI-guidance tool error. No path consults a hosted key.

---

## Revision 2 (post-Codex re-review, 8/10) — final refinements

**R11 — `reindex-all` MUST use a NEW helper, NOT extend `reindexCompany`.** `reindexCompany` is auto-fired on OpenAI key create/rotate (`secrets.ts:257/300`) and is intentionally a *drain missing+failed* operation. Changing its semantics to a full re-enqueue would make every key add/rotate re-embed the entire company (expensive, surprising). Instead add a separate `reindexAllCompany(db, companyId)` in `embeddings-backfill.ts` (re-enqueue ALL company memory items) used ONLY by the new founder-only `POST /companies/:cid/memory/reindex-all`. `reindexCompany` is left unchanged.

**R12 — Remove the `llm` lookup from all 4 production tool wrappers.** Today `memory-extract-{candidates,decisions,insights,references}.ts` read `ctx.services.extraction?.llm` (`memory-extract-candidates.ts:61`, `-decisions.ts:46`, `-insights.ts:42`, `-references.ts:42`). Delete that lookup in all 4 — production tools call `extractMemoryCandidates(content)` with NO `llm`, so they always use `extractViaCli`. The `llm` injection param on `extractMemoryCandidates` survives ONLY for direct test/eval calls (R2). The guard test asserts no tool wrapper references `ctx.services.extraction?.llm`.

**Spec status: reviewed (Codex 6 → 8/10, all findings resolved). Ready to plan tasks + implement.**

