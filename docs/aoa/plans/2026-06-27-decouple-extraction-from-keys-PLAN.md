# Decouple Extraction from Hosted Keys — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all discussion extraction CLI-only (no hosted key ever read by extraction) and relocate the embeddings API key into a Settings → Memory section; hosted keys become embeddings-only.

**Architecture:** Server — `resolveExtractionEngine` collapses to "cli or throw"; all 4 extraction entry points (Discussion, debrief-push, file-import, the 4 crew memory-extract tools) call `extractViaCli`; `callLLM`/`callAnthropic`/`callOpenAI` + the api branch + the engine-status route are deleted; embeddings code is untouched; a new founder-only `reindexAllCompany` backs a "Re-index all" button. UI — delete the extraction engine-status banner, rename the "LLM providers" settings section to "Memory" (OpenAI-only key + semantic status + re-index), add a semantic-off banner to MemoryExplorer.

**Tech Stack:** Express 5 + Drizzle (server), React + Vite + Tailwind (ui), Vitest (unit/integration/ui), Playwright (e2e), gstack `/browse` (live UI), pnpm workspace.

**Source spec:** `docs/aoa/plans/2026-06-27-decouple-extraction-from-keys-spec.md` (Codex-reviewed 6→8/10).

**Branch:** `feat/keyless-except-embeddings` (PR #235, do NOT merge until this lands).

**Commands reference:** `pnpm test:run <pattern>` (vitest, from worktree root) · `pnpm --filter @armyofagents/server typecheck` · `pnpm --filter @armyofagents/ui typecheck` · e2e: `pnpm --filter @armyofagents/ui exec playwright test <spec>` (Linux/CI; Windows e2e is skipped per repo config — live `/browse` covers Windows).

---

## File Structure (decomposition)

**Server (extraction → CLI-only):**
- `server/src/services/extraction-engine.ts` — `resolveExtractionEngine` returns `"cli"` or throws; `ExtractionEngine = "cli"`.
- `server/src/services/extraction.ts` — all paths via `extractViaCli`; delete `callLLM`/`callAnthropic`/`callOpenAI`; `extractMemoryCandidates(content,{llm?})` keeps `llm` as test-only seam.
- `server/src/services/internal-agent/tools/memory-extract-{candidates,decisions,insights,references}.ts` — drop `ctx.services.extraction?.llm` lookup.
- `server/src/routes/extraction.ts` — DELETE (engine-status route).
- `packages/shared/src/types/extraction-engine.ts` + re-exports — DELETE.

**Server (embeddings settings backend):**
- `server/src/services/embeddings-backfill.ts` — NEW `reindexAllCompany`.
- `server/src/routes/memory.ts` — NEW founder-only `POST /memory/reindex-all`.

**UI:**
- `ui/src/components/LLMProvidersSection.tsx` → renamed/retargeted to embeddings (OpenAI-only, status, reindex).
- `ui/src/components/settings/SettingsLayout.tsx` + `ui/src/pages/SettingsPage.tsx` — nav "LLM providers" → "Memory", `?tab=llm`→`memory` alias.
- `ui/src/components/settings/sections/LLMProvidersSectionWrapper.tsx` — heading/copy.
- `ui/src/pages/MemoryExplorer.tsx` — semantic-off banner.
- `ui/src/pages/Memory.tsx` — legacy banner copy.
- DELETE: `ui/src/api/extraction.ts`, `queryKeys.extraction.engineStatus`.
- `ui/src/api/memory.ts` — add `reindexAll`.

**Docs:** `docs/architecture/decisions.md` (#104), `CLAUDE.md` (Rule #11), doc comments.

---

## PHASE A — Server: extraction is CLI-only

### Task 1: `resolveExtractionEngine` → "cli" or throw

**Files:**
- Modify: `server/src/services/extraction-engine.ts` (`:27` import, `:30` type, `:149-164` step 2, `:166-171` throw)
- Test: `server/src/__tests__/extraction-engine.test.ts` (rewrite)

- [ ] **Step 1: Rewrite the test to expect cli-or-throw**

```ts
// extraction-engine.test.ts — replace the "api" expectations
it("returns 'cli' when a supported CLI is available", async () => {
  const engine = await resolveExtractionEngine({} as any, "co-1", { cliAvailable: true });
  expect(engine).toBe("cli");
});
it("THROWS when no CLI is available (no api fallback, key never consulted)", async () => {
  await expect(
    resolveExtractionEngine({} as any, "co-1", { cliAvailable: false }),
  ).rejects.toThrow(/install a cli|claude/i);
});
it("does not import or call resolveAvailableProvider", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync("server/src/services/extraction-engine.ts", "utf8"));
  expect(src).not.toMatch(/resolveAvailableProvider/);
});
```

- [ ] **Step 2: Run — FAIL**

Run: `pnpm test:run extraction-engine` → Expected: FAIL (still returns "api" / imports provider).

- [ ] **Step 3: Implement.** In `extraction-engine.ts`: remove the `resolveAvailableProvider` import (`:27`); change `ExtractionEngine` to `"cli"` (`:30`); delete Step 2 (`:149-164`); after the `if (cliAvailable) return "cli";` block, replace the api-resolution + final throw with a single throw: `"No extraction engine available. Install a CLI (e.g. the Claude Code CLI) and run its login flow (claude login)."` Drop the `opts.apiKey` param usage.

- [ ] **Step 4: Run — PASS.** `pnpm test:run extraction-engine`

- [ ] **Step 5: Commit.** `git commit -am "refactor(extraction): engine router is CLI-only (remove api fallback)"`

### Task 2: Discussion path — remove hosted branch + CLI→API fallback

**Files:**
- Modify: `server/src/services/extraction.ts` (`:458` useApiPath, `:506-531` CLI→API fallback, `:561-642` hosted branch)
- Test: `server/src/__tests__/extraction-failure-classify.test.ts` (extend), rewrite `extraction-refactor.test.ts` + `extraction-atomic-claim.test.ts` (pin "cli") + `extraction-cli-path.test.ts` (drop fallback case)

- [ ] **Step 1: Write/adjust failing tests**

```ts
// extraction (discussion) — no-CLI terminalizes WITHOUT consulting a key
it("no CLI + no key → entry skipped with CLI-install message, no key lookup", async () => {
  // resolveExtractionEngine throws; getProviderApiKey must NOT be called
  // (spy on providers module — assert 0 calls)
  // ...arrange a discussion entry, run extractFromDiscussionEntry
  expect(getProviderApiKeySpy).not.toHaveBeenCalled();
  expect(entry.extractionStatus).toBe("skipped");
  expect(entry.sourceInfo.extractionError).not.toMatch(/api key|provider key/i);
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm test:run extraction-refactor extraction-cli-path extraction-atomic-claim`

- [ ] **Step 3: Implement.** In `extractFromDiscussionEntry`: delete `useApiPath` (`:458`), the `not_authed`/`not_installed` CLI→API fallback block (`:506-531`), and the entire `if (useApiPath) { ... }` hosted branch (`:561-642`). The CLI failure (CliExtractionError) terminalizes the entry as today (failed/skipped) with `claudeFailureMessage`/`codexFailureMessage` (already key-free). Delete the api-path tests; repoint `extraction-atomic-claim.test.ts` to engine "cli".

- [ ] **Step 4: Run — PASS.** `pnpm test:run extraction`

- [ ] **Step 5: Commit.** `git commit -am "refactor(extraction): discussion path is CLI-only"`

### Task 3: Convert debrief-push + file-import to CLI

**Files:**
- Modify: `server/src/services/extraction.ts` (`extractFromDebrief` `:203-310`, `extractFromRawText` `:734-752`)
- Test: rewrite `server/src/__tests__/extraction-debrief-key.test.ts`; add `extraction-file-import-cli.test.ts`

- [ ] **Step 1: Failing tests**

> **Rev 3 (outside-voice fix):** these are METHODS on `extractionService(db)`, not free functions. Real signatures (`extraction.ts:203, 734`): `extractFromDebrief(companyId, debriefId): Promise<void>` (reads the debrief from DB, writes briefs) and `extractFromRawText(companyId, rawText): Promise<ExtractedItem[]>`.

```ts
const svc = extractionService(db);
// file-import path returns items; CLI-backed; graceful [] on failure
it("extractFromRawText routes through extractViaCli (no callLLM)", async () => {
  vi.mocked(extractViaCli).mockResolvedValue([{ type: "task", title: "T" }] as any);
  const items = await svc.extractFromRawText(companyId, "raw text");
  expect(extractViaCli).toHaveBeenCalled();
  expect(items[0].type).toBe("task");
});
it("extractFromRawText returns [] on CLI failure (file-import then chunks)", async () => {
  vi.mocked(extractViaCli).mockRejectedValue(new CliExtractionError("x", "not_installed"));
  expect(await svc.extractFromRawText(companyId, "text")).toEqual([]);
});
// debrief path: void method, reads debrief by id, uses CLI
it("extractFromDebrief routes through extractViaCli (no callLLM)", async () => {
  // arrange: mock the debrief fetch to return text; assert CLI is used
  vi.mocked(extractViaCli).mockResolvedValue([{ type: "task", title: "T" }] as any);
  await svc.extractFromDebrief(companyId, debriefId);
  expect(extractViaCli).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm test:run extraction-debrief extraction-file-import-cli`

- [ ] **Step 3: Implement.** In `extractionService(db)`, replace the `callLLM` call inside `extractFromDebrief` (`:230`) and `extractFromRawText` (`:746`) with `extractViaCli(cliTool, <systemPrompt>, content, { codexModel })` where `cliTool = await resolveCompanyCliTool(db, companyId)` and `codexModel` is the company's configured model (mirror the discussion path `extraction.ts:476-478` — do NOT drop the model). `extractFromRawText` keeps its `try/catch` returning `[]` on failure (graceful — `file-import.ts` then chunks). `extractFromDebrief` keeps its failure→notify path; update its message to CLI-guidance (no key mention).

- [ ] **Step 4: Run — PASS.** `pnpm test:run extraction-debrief extraction-file-import-cli file-import`

- [ ] **Step 5: Commit.** `git commit -am "refactor(extraction): debrief + file-import use the CLI extractor"`

### Task 4: Crew memory-extract tools → CLI; drop `llm` lookup; keep test-only seam

**Files:**
- Modify: `server/src/services/extraction.ts` (`extractMemoryCandidates` `:862-965`)
- Modify: `server/src/services/internal-agent/tools/memory-extract-{candidates,decisions,insights,references}.ts` (remove `ctx.services.extraction?.llm`)
- Test: `server/src/__tests__/extraction-memory-candidates-cli.test.ts` (new); guard test `server/src/__tests__/extraction-no-provider-keys.test.ts` (new); update `server/src/services/__tests__/extraction-refactored.test.ts` (canonical signature tests — Rev 3 #9)
- Blast radius (Rev 3 #8): `server/src/__tests__/privacy.test.ts` calls `extractMemoryCandidates(db, null, …)` — survives only via the empty-entries early return (`extraction.ts:928`); update its stale comment ("LLM never invoked" → "CLI never invoked") and confirm its mock returns `entryRows: []` so no real `claude` subprocess can spawn in a unit test.

- [ ] **Step 1: Failing tests**

> **Rev 3 (outside-voice fix):** real signature is `extractMemoryCandidates(db, llm: ExtractionLlm | null, { companyId, threadId, sinceEntryId? }): Promise<{ candidates: MemoryCandidate[] }>` (`extraction.ts:862`). It FETCHES entries by `threadId` and builds `userContent` internally. `ExtractionLlm` is `.generate(prompt, content): Promise<string>` (`:796`), NOT `.chat`. `extractViaCli` returns an `ExtractedItem[]` ARRAY (`extraction-cli.ts:113`), so the no-llm path must `.map(toMemoryCandidate)` over that array — NOT re-`parseExtractedItems` (that runs only on the llm's raw STRING). Also note the canonical signature tests live in `server/src/services/__tests__/extraction-refactored.test.ts` (already `M` in git, ~15 call-sites) — update THAT file, not the similarly-named `extraction-refactor.test.ts`.

```ts
// production path (no llm) → CLI; result mapped to MemoryCandidate[]
it("extractMemoryCandidates with no llm uses extractViaCli", async () => {
  vi.mocked(extractViaCli).mockResolvedValue([{ type: "insight", title: "I" }] as any);
  const { candidates } = await extractMemoryCandidates(db, null, { companyId, threadId });
  expect(extractViaCli).toHaveBeenCalled();
  expect(candidates[0].title).toBe("I");
});
// test/eval seam: injected llm.generate used, CLI not called
it("extractMemoryCandidates with injected llm uses .generate (eval seam)", async () => {
  const llm = { generate: vi.fn().mockResolvedValue('[{"type":"insight","title":"I"}]') };
  await extractMemoryCandidates(db, llm as any, { companyId, threadId });
  expect(llm.generate).toHaveBeenCalled();
  expect(extractViaCli).not.toHaveBeenCalled();
});
// RUNTIME guard: spy on the provider module; ZERO calls during keyless extraction
it("no extraction path calls getProviderApiKey/resolveAvailableProvider at runtime", async () => {
  const spyKey = vi.spyOn(providers, "getProviderApiKey");
  const spyResolve = vi.spyOn(providers, "resolveAvailableProvider");
  vi.mocked(extractViaCli).mockResolvedValue([{ type: "insight", title: "I" }] as any);
  const svc = extractionService(db);
  await svc.extractFromRawText(companyId, "text");
  await extractMemoryCandidates(db, null, { companyId, threadId }); // no llm
  expect(spyKey).not.toHaveBeenCalled();
  expect(spyResolve).not.toHaveBeenCalled();
});
// crew error mapping: a CliExtractionError maps to the CLI-unavailable code, not generic
it("crew tool maps CliExtractionError → EXTRACTION_LLM_UNAVAILABLE", async () => {
  vi.mocked(extractViaCli).mockRejectedValue(new CliExtractionError("claude CLI not found", "not_installed"));
  const res = await memoryExtractCandidatesTool.handler({ threadId }, ctx);
  expect(res.error).toBe("EXTRACTION_LLM_UNAVAILABLE");
});
// STATIC guard: no extraction module references provider-key helpers or callLLM
it("extraction modules never reference provider keys / callLLM", () => {
  const fs = require("node:fs");
  for (const f of ["extraction.ts","extraction-engine.ts"]) {
    const src = fs.readFileSync(`server/src/services/${f}`,"utf8");
    expect(src).not.toMatch(/callLLM|callAnthropic|callOpenAI|createProvider|resolveAvailableProvider/);
  }
  for (const t of ["candidates","decisions","insights","references"]) {
    const src = fs.readFileSync(`server/src/services/internal-agent/tools/memory-extract-${t}.ts`,"utf8");
    expect(src).not.toMatch(/ctx\.services\.extraction\?\.llm/);
  }
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm test:run extraction-memory-candidates-cli extraction-no-provider-keys extraction-refactored`

- [ ] **Step 3: Implement.** In `extractMemoryCandidates` (`extraction.ts:955-964`), replace the `else { items = await callLLM(...) }` branch with `else { items = await extractViaCli(await resolveCompanyCliTool(db, params.companyId), MEMORY_CANDIDATE_SYSTEM_PROMPT, userContent, { codexModel }); }` — `extractViaCli` already returns `ExtractedItem[]`, so the existing `return { candidates: items.map(toMemoryCandidate) }` is reused unchanged. Keep the `if (llm)` branch (`llm.generate` → `parseExtractedItems`) as the test/eval seam. In the 4 tool wrappers (`memory-extract-{candidates,decisions,insights,references}.ts`): (a) delete the `const llm = ctx.services.extraction?.llm` line and pass NO llm — call `extractMemoryCandidates(db, null, { companyId, threadId })`; (b) FIX the error mapping (`:79`) so a `CliExtractionError` (or kind `not_installed`/`not_authed`) maps to `EXTRACTION_LLM_UNAVAILABLE` with CLI-guidance, e.g. `const isCliUnavailable = err instanceof CliExtractionError && (err.kind === "not_installed" || err.kind === "not_authed")` (the old `/No LLM provider configured/i` regex is dead after the conversion). Update the same `extraction-refactored.test.ts` signatures.

- [ ] **Step 4: Run — PASS.** `pnpm test:run extraction-memory-candidates extraction-no-provider-keys mcp-write-tools`

- [ ] **Step 5: Commit.** `git commit -am "refactor(extraction): crew memory-extract tools are CLI-only; llm is test-only seam"`

### Task 5: Delete dead hosted plumbing + engine-status route + shared type

**Files:**
- Modify: `server/src/services/extraction.ts` (delete `callLLM`/`callAnthropic`/`callOpenAI` `:98-195`; clean imports `:6`)
- Delete: `server/src/routes/extraction.ts`; unregister in `server/src/app.ts`/`index.ts`
- Delete: `packages/shared/src/types/extraction-engine.ts`; remove re-exports (`packages/shared/src/index.ts:326-328`, `types/index.ts:3-6`)
- Delete: `server/src/__tests__/extraction-engine-status-route.test.ts`

- [ ] **Step 1: Failing test (route gone)**

```ts
it("engine-status route is removed (404)", async () => {
  const res = await request(app).get(`/api/companies/${CID}/extraction/engine-status`);
  expect(res.status).toBe(404);
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm test:run` (typecheck will also flag dead imports)

- [ ] **Step 3: Implement.** Delete the three `call*` functions + their imports; delete the route file + its registration; delete the shared type + re-exports; delete the route test.

- [ ] **Step 4: Run — PASS.** `pnpm --filter @armyofagents/server typecheck && pnpm test:run extraction`

- [ ] **Step 5: Commit.** `git commit -am "chore(extraction): delete dead hosted-LLM plumbing + engine-status route/type"`

---

## PHASE B — Server: Memory settings backend

### Task 6: `reindexAllCompany` + founder-only `POST /memory/reindex-all`

**Files:**
- Modify: `server/src/services/embeddings-backfill.ts` (new `reindexAllCompany`)
- Modify: `server/src/routes/memory.ts` (new route, after `reindex-failed`)
- Test: `server/src/__tests__/embeddings-backfill-service.test.ts` (extend), `server/src/__tests__/memory-reindex-routes.test.ts` (extend)

- [ ] **Step 1: Failing tests**

```ts
// service: re-enqueues company memory items that have NO live queue row
it("reindexAllCompany enqueues items without a live row", async () => {
  const db = makeDb({ items: [{id:"m1"},{id:"m2"}], liveRows: [] });
  const r = await reindexAllCompany(db, "co-1");
  expect(r.enqueued).toBe(2);
});
// Rev 3 dedup-safety: items already pending/processing are SKIPPED (no dup rows)
it("reindexAllCompany skips items that already have a live (pending/processing) row", async () => {
  const db = makeDb({ items: [{id:"m1"},{id:"m2"}], liveRows: [{targetId:"m1"}] });
  const r = await reindexAllCompany(db, "co-1");
  expect(r.enqueued).toBe(1); // only m2; m1 already queued
});
// guard: no-op without pgvector
it("reindexAllCompany returns 0 when pgvector is unavailable", async () => {
  caps.hasVectorSupport = false;
  expect((await reindexAllCompany(makeDb({items:[{id:"m1"}]}), "co-1")).enqueued).toBe(0);
});
// route: founder-only + board-only
it("POST /memory/reindex-all is founder-only (team_lead → 403)", async () => {
  mockAssertRole.mockRejectedValueOnce(forbidden("Requires one of: founder"));
  const res = await request(makeApp(leadActor)).post(`/api/companies/${CID}/memory/reindex-all`).send();
  expect(res.status).toBe(403);
  expect(mockAssertRole).toHaveBeenCalledWith(expect.anything(),expect.anything(),CID,"founder");
});
it("POST /memory/reindex-all rejects agents (assertBoard)", async () => {
  const res = await request(makeApp(agentActor)).post(`/api/companies/${CID}/memory/reindex-all`).send();
  expect(res.status).toBe(403);
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm test:run embeddings-backfill-service memory-reindex-routes`

- [ ] **Step 3: Implement (eng-review A1 + Rev 3 dedup-safety).** `reindexAllCompany(db, companyId)`:
  1. Guard `if (!getDbCapabilities().hasVectorSupport) return { enqueued: 0 };` (mirror `embeddings-backfill.ts:139`).
  2. Select all company memory item ids.
  3. **Dedup-safe (Rev 3):** a blind bulk insert would create a SECOND `pending` row for every item that already has a live one (the per-item `enqueueMemoryEmbedding` refreshes in place — `memory-write.ts:79-108`). So first select the set of memory `targetId`s that already have a live (`pending`|`processing`) embedding_queue row, and EXCLUDE them — same predicate `reindexCompany` uses (`embeddings-backfill.ts:166-179`). Only the remaining items get rows.
  4. Bulk `insert().values([...])` the remaining rows (chunk ~500/insert) — NOT a per-item loop (avoids N+1). Return `{ enqueued: N }`.
  The existing worker (circuit-breaker + backoff) paces the actual OpenAI calls. Do NOT touch `reindexCompany` (still auto-fires on key add/rotate). New route `POST /companies/:companyId/memory/reindex-all` with `assertCompanyAccess` + `assertBoard` + `assertRole(db, req, companyId, "founder")` → `reindexAllCompany` → `{ reindexed: N }` + activity log. UI confirm (Task 9) shows the count.

- [ ] **Step 4: Run — PASS.** `pnpm test:run embeddings-backfill-service memory-reindex-routes`

- [ ] **Step 5: Commit.** `git commit -am "feat(memory): founder-only reindex-all endpoint + reindexAllCompany"`

---

## PHASE C — UI

### Task 7: Delete engine-status banner + extraction client

**Files:**
- Modify: `ui/src/components/LLMProvidersSection.tsx` (banner `:208-244`, query `:84-94`, invalidation `:118-120`, imports)
- Delete: `ui/src/api/extraction.ts`; remove `queryKeys.extraction` (`ui/src/lib/queryKeys.ts:241-244`)
- Test: `ui/src/__tests__/SettingsPage-redesign.test.tsx` (remove engine-status assertions)

- [ ] **Step 1: Failing test**

```tsx
it("settings has NO extraction engine-status banner", () => {
  render(<SettingsPage/>, { route: "/co/settings?tab=memory" });
  expect(screen.queryByTestId("settings-extraction-engine-status")).toBeNull();
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm test:run SettingsPage-redesign`

- [ ] **Step 3: Implement.** Remove the banner block, the `engineStatus` query, the extraction invalidation (keep secrets invalidation), the `extractionApi` import + now-unused icons. Delete `api/extraction.ts` + `queryKeys.extraction`.

- [ ] **Step 4: Run — PASS.** `pnpm --filter @armyofagents/ui typecheck && pnpm test:run SettingsPage-redesign`

- [ ] **Step 5: Commit.** `git commit -am "refactor(ui): delete extraction engine-status banner + client"`

### Task 8: Rename Settings "LLM providers" → "Memory" (+ ?tab=llm alias)

**Files:**
- Modify: `ui/src/components/settings/SettingsLayout.tsx` (`:10-13` union, `:32-41` nav item)
- Modify: `ui/src/pages/SettingsPage.tsx` (`:19-22` VALID_SECTIONS, `:28-69` render case, `:76-77` alias)
- Test: `ui/src/__tests__/SettingsPage-redesign.test.tsx` (label + alias)

- [ ] **Step 1: Failing tests**

```tsx
it("nav shows 'Memory' not 'LLM providers'", () => {
  render(<SettingsPage/>); expect(screen.getByText("Memory")).toBeInTheDocument();
  expect(screen.queryByText("LLM providers")).toBeNull();
});
it("?tab=llm normalizes to the Memory section (no dead bookmark)", () => {
  render(<SettingsPage/>, { route: "/co/settings?tab=llm" });
  expect(screen.getByRole("heading", { name: /memory/i })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm test:run SettingsPage-redesign`

- [ ] **Step 3: Implement.** Canonical id `"memory"`: nav item `{ id:"memory", label:"Memory", icon: Brain }`; render case `"memory"`. **Rev 3 alias precision:** `isValidSection`/`VALID_SECTIONS` must STILL accept `"llm"` as valid INPUT (else `?tab=llm` fails validation and silently falls back to General — finding #10). On read, normalize: `const active = raw === "llm" ? "memory" : raw`. `handleSectionChange` writes the canonical `"memory"`. The `SettingsSectionId` union includes `"memory"` (and may retain `"llm"` as an accepted-input alias type). The mobile sub-nav renders from the same `SETTINGS_SECTIONS` array, so it updates automatically.

- [ ] **Step 4: Run — PASS.** `pnpm test:run SettingsPage-redesign`

- [ ] **Step 5: Commit.** `git commit -am "feat(ui): rename Settings LLM-providers section to Memory (alias ?tab=llm)"`

### Task 9: Memory section — OpenAI-only key + semantic status + founder-only Re-index-all

**Files:**
- Modify: `ui/src/components/LLMProvidersSection.tsx` (`LLM_PROVIDERS` → OpenAI only; add status line + reindex button)
- Modify: `ui/src/components/settings/sections/LLMProvidersSectionWrapper.tsx` (`:12` heading, `:15` copy)
- Modify: `ui/src/api/memory.ts` (add `reindexAll`)
- Test: `ui/src/__tests__/MemorySettingsSection.test.tsx` (new)

- [ ] **Step 1: Failing tests**

```tsx
it("shows only the OpenAI embeddings key (no Anthropic/Google)", () => {
  render(<MemorySettings/>);
  expect(screen.getByText(/OpenAI/)).toBeInTheDocument();
  expect(screen.queryByText(/Anthropic/)).toBeNull();
  expect(screen.queryByText(/Gemini|Google/)).toBeNull();
});
it("shows semantic status from semanticAvailable", () => {
  mockMemoryList({ semanticAvailable: false });
  render(<MemorySettings/>); expect(screen.getByText(/semantic search.*off/i)).toBeInTheDocument();
});
it("Re-index all is founder-only (hidden for team_lead)", () => {
  render(<MemorySettings/>, { role: "team_lead" });
  expect(screen.queryByRole("button", { name: /re-index all/i })).toBeNull();
});
it("Re-index all calls reindexAll + shows confirm", async () => {
  render(<MemorySettings/>, { role: "founder" });
  await userEvent.click(screen.getByRole("button", { name: /re-index all/i }));
  await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
  expect(memoryApi.reindexAll).toHaveBeenCalledWith(CID);
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm test:run MemorySettingsSection`

- [ ] **Step 3: Implement.** `LLM_PROVIDERS` = `[openai]`; heading "Memory", copy "API key for the embeddings model. Used only for semantic memory search."; add a status line bound to `memoryApi.list(...).semanticAvailable`; add a founder-gated "Re-index all" button → ConfirmDialog ("re-embeds all memory, may take a while") → `memoryApi.reindexAll(companyId)`; handle 403. Add `reindexAll: (cid) => post('/companies/'+cid+'/memory/reindex-all')` to `api/memory.ts`.

- [ ] **Step 4: Run — PASS.** `pnpm test:run MemorySettingsSection`

- [ ] **Step 5: Commit.** `git commit -am "feat(ui): Memory settings — OpenAI key + semantic status + founder reindex-all"`

### Task 10: MemoryExplorer semantic-off banner + legacy copy

**Files:**
- Modify: `ui/src/pages/MemoryExplorer.tsx` (add banner, gated on `semanticAvailable===false`)
- Modify: `ui/src/pages/Memory.tsx` (`:387-391` banner copy → "Settings → Memory")
- Test: `ui/src/__tests__/MemoryExplorer.banner.test.tsx` (new)

- [ ] **Step 1: Failing test**

```tsx
it("shows 'add key in Settings → Memory' banner when semantic off", () => {
  mockMemoryList({ semanticAvailable: false });
  render(<MemoryExplorer/>);
  const b = screen.getByTestId("no-llm-key-banner");
  expect(b).toHaveTextContent(/Settings.*Memory/);
});
it("no banner when semantic available", () => {
  mockMemoryList({ semanticAvailable: true });
  render(<MemoryExplorer/>); expect(screen.queryByTestId("no-llm-key-banner")).toBeNull();
});
```

- [ ] **Step 2: Run — FAIL.** `pnpm test:run MemoryExplorer.banner`

- [ ] **Step 3: Implement.** Port the dismissible banner pattern from `Memory.tsx:379-402` into `MemoryExplorer`, copy "Semantic search is off — add an embeddings key in Settings → Memory", deep-link to `?tab=memory`. Update legacy `Memory.tsx` copy to the new path.

- [ ] **Step 4: Run — PASS.** `pnpm test:run MemoryExplorer.banner`

- [ ] **Step 5: Commit.** `git commit -am "feat(ui): MemoryExplorer semantic-off banner → Settings → Memory"`

---

## PHASE D — Docs

### Task 11: Amend Decision #104, CLAUDE.md, doc comments

**Files:** `docs/architecture/decisions.md` (#104), `CLAUDE.md` (Rule #11 + adapters/extraction notes), `server/src/services/extraction-cli.ts:2-14` (header), `server/src/services/extraction.ts:764-778` (comment), `docs/aoa/plans/2026-06-25-keyless-except-embeddings-*.md` + any "Settings → LLM Providers" strings.

- [ ] **Step 1:** Amend Decision #104: api extraction engine removed; extraction is CLI-only; no hosted fallback. Update CLAUDE.md Rule #11 (hosted key for embeddings only; extraction CLI-only). Update the two code-comment headers. Grep-replace user-facing "Settings → LLM Providers" → "Settings → Memory".
- [ ] **Step 2:** Run: `pnpm test:run brand-check policy 2>/dev/null || true` + `node scripts/check-forbidden-tokens.mjs` (docs gates).
- [ ] **Step 3: Commit.** `git commit -am "docs: extraction CLI-only; amend Decision #104; keys are embeddings-only"`

---

## PHASE E — Tests: e2e + live UI (ALL scenarios)

### Task 12: Playwright e2e — update + add scenarios

**Files:** `tests/e2e/memory-index-status.spec.ts` (update banner copy/path); add `tests/e2e/keyless-extraction.spec.ts` (new, CI-feasible parts only — uses the fake-CLI/fake-embedder seams where real binaries aren't available in CI).

- [ ] **Step 1: Update** `memory-index-status.spec.ts`: banner testid `no-llm-key-banner` now on MemoryExplorer; copy references "Settings → Memory"; nav assertions updated.
- [ ] **Step 2: Add** `keyless-extraction.spec.ts` (CI-feasible): (a) Settings has "Memory" not "LLM providers"; (b) no `settings-extraction-engine-status` testid anywhere; (c) `?tab=llm` lands on Memory; (d) MemoryExplorer shows the no-key banner with no embeddings key. (Real-CLI extraction is covered by live verification, Task 13 — CI has no logged-in claude.)
- [ ] **Step 3: Run** (Linux/CI): `pnpm --filter @armyofagents/ui exec playwright test memory-index-status keyless-extraction`. (Windows e2e is skipped per `tests/e2e/playwright.config.ts`.)
- [ ] **Step 4: Commit.** `git commit -am "test(e2e): keyless-extraction + memory settings scenarios"`

### Task 13: Live UI verification matrix (isolated instance via /browse)

**Instance:** the running isolated QA instance (`:3275`, `AOA_CONFIG=C:/Users/TK/.aoa/qa-kl/config.json`) or a fresh one. Drive with gstack `/browse`. This is the human-equivalent "does it actually work" pass that CI can't do (CI has no logged-in CLI). Verify EACH row and capture a screenshot:

- [ ] **Extraction, keyless, NO key set:** post a Discussion entry → reprocess → 3+ items via `claude_cli` (server log: "Using CLI engine (keyless)"). PASS = items appear, no key configured.
- [ ] **debrief-push keyless:** MCP debrief-push (or the debrief route) with no key → items extracted via CLI.
- [ ] **file-import graceful:** import a text file with NO CLI reachable (temporarily rename PATH or use a company whose cliTool probe fails) → file still imports via paragraph chunking, no hard error.
- [ ] **crew memory tool keyless:** invoke the crew `extract_memory_candidates` (or a sibling) with no key → returns candidates via CLI; with no CLI → clean tool error mentioning CLI, not keys.
- [ ] **Settings → Memory:** renders; shows ONLY the OpenAI key field; `?tab=llm` redirects here; NO engine-status banner anywhere in the app.
- [ ] **Re-index all (founder):** button visible for founder; confirm → 200; hidden/disabled for a team_lead (and 403-safe if forced).
- [ ] **MemoryExplorer banner:** with no key → "Semantic search off → Settings → Memory" banner; deep-link works.
- [ ] **Embeddings still works (with key):** set an OpenAI key in Settings → Memory → items index (badge "indexed"), semantic search returns; remove key → degrades to keyword + banner returns.
- [ ] **Capture:** screenshots of Settings → Memory, the MemoryExplorer banner, and a successful keyless extraction; attach to the PR.

### Task 14: Full verification gate

- [ ] `pnpm -r typecheck` → 0 errors.
- [ ] `pnpm test:run` → full suite green (0 failed).
- [ ] `git diff main...HEAD --numstat | awk -F'\t' '$1=="-"&&$2=="-"'` → zero binary files.
- [ ] Re-run Codex review of the diff (`/code-review` or `@codex review`) → clean.
- [ ] Then (and only then) PR #235 is eligible to merge.

---

## Self-Review (against spec)

- **Spec coverage:** D1 (CLI-only extraction) → Tasks 1-5; D2 (embeddings untouched) → no task changes embeddings logic (✓); D3 (OpenAI-only) → Task 9; D4 (Memory section) → Tasks 8-9 + R4 reindex-all → Task 6; D5 (MemoryExplorer banner) → Task 10; D6 (docs) → Task 11; R1 (4 crew tools) → Task 4; R2/R12 (test-only seam, drop lookup) → Task 4; R11 (separate reindexAllCompany) → Task 6; R5 (founder-only button) → Tasks 6+9; R6 (per-path failure) → Tasks 2/3/4; R7 (tab alias) → Task 8; R8 (dead contracts) → Tasks 5+7; R9 (legacy key-error copy) → covered by Task 11 grep + DiscussionDetail.extraction.test.ts update in Task 2/11; R10 (doc comments) → Task 11. All test layers: unit (1-7,9,10), integration/route (2,3,6), UI component (7-10), e2e (12), live UI (13), full gate (14). ✓
- **Open item to confirm during R9:** `ui/src/components/threads/EntryRow.tsx` error copy that routes to Settings for key errors — update alongside Task 11 (add to its grep/replace).

---

## Failure modes (per new codepath)

| Codepath | Realistic prod failure | Test? | Error handling? | User sees? |
|---|---|---|---|---|
| Discussion extraction, no CLI | terminalizes `failed`/`skipped` | T2 | yes (classified) | clear CLI-install msg (no key) |
| file-import, no CLI | returns `[]` → paragraph chunk | T3 | yes (graceful) | file imports, no error (by design) |
| crew tool, no CLI | tool error to agent | T4 | yes | CLI-guidance tool error |
| `reindexAllCompany` on huge company | cost spike / DB flood | T6 | bulk insert + worker pacing + counted confirm (A1) | "Re-embed N items?" confirm |
| `reindex-all` by non-founder | 403 | T6 route | yes (assertBoard+assertRole) | button hidden; 403-safe |
| `?tab=llm` stale bookmark | dead section | T8 | alias→memory | lands on Memory |
No critical gaps (no failure is both untested AND silent).

## Parallelization

| Lane | Tasks | Modules | Depends on |
|---|---|---|---|
| A (server) | 1→2→3→4→5→6 | `server/src/services/extraction*`, `routes/extraction|memory`, `embeddings-backfill` | sequential (Task 5 deletes `callLLM` after 2-4 convert callers) |
| B (UI) | 7→8→9→10 | `ui/src/components/settings`, `pages/Memory*`, `api` | needs Task 6's `reindex-all` route for Task 9's button wiring |
| C (docs) | 11 | `docs/`, `CLAUDE.md`, code comments | after A (reflects final behavior) |
| D (tests) | 12→13→14 | `tests/e2e`, live, gate | after A+B+C |

Lane A and B can start in parallel (different module trees) EXCEPT Task 9 (UI reindex button) depends on Task 6 (route). Recommended: A first (or A+B parallel with B's Task 9 last), then C, then D. Single-developer/CC: sequential A→B→C→D is simplest and lowest-conflict.

---

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | Step 0 scope (one coherent change, accepted); Arch A1 (reindex-all → bulk+counted; **superseded by Rev 3 dedup-safe**); Test enhancement (runtime no-key spy) |
| Codex Review (spec) | `codex exec` ×2 | Independent 2nd opinion | 2 | CLEAR | spec 6/10 → 8/10; 12 findings folded into spec Rev 1+2 |
| Outside Voice (plan) | Claude subagent (Codex rate-limited) | Independent plan challenge | 1 | RESOLVED | plan 5/10; **10 findings, all VERIFIED against source by the author, all fixed in Rev 3** |

- **OUTSIDE VOICE (plan):** scored 5/10 — caught that the plan's `extractMemoryCandidates`/`extractFromDebrief`/`extractFromRawText` signatures were wrong (coded against non-existent APIs), `ExtractionLlm` is `.generate` not `.chat`, the CLI path needs `map(toMemoryCandidate)` not re-parse, the crew error-mapping regex is dead, and the reindex-all bulk insert bypassed dedup (correcting the eng-review's own A1). The author independently re-verified all 10 against source (`extraction.ts:862/796/955`, `memory-write.ts:79`, `memory-extract-candidates.ts:79`, both test files) — every claim confirmed — and applied **Revision 3** (Tasks 3, 4, 6, 8 corrected; codexModel passthrough; `privacy.test.ts` + `extraction-refactored.test.ts` added to blast radius).
- **CROSS-MODEL:** the prior reviews validated the spec's direction; the outside voice validated the plan's signatures against code and found real gaps — no contradiction, complementary coverage.
- **UNRESOLVED:** none. Codex plan-level review deferred (CLI usage limit; resets later) — the Claude outside-voice + author re-verification substituted.
- **VERDICT:** ENG CLEARED (post-Rev 3) — ready to implement. Signatures now match source; reindex-all is dedup-safe; test strategy spans unit + integration + route + UI-component + Playwright e2e + live-UI matrix (Task 13). CI's only gap (real-CLI extraction) is covered by the live matrix.
