# W2 — Extract-Then-Scope + Kill the Placeholder Stub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adjutant scoping runs keyless CLI extraction over the thread's un-extracted entries **before** compiling the scope draft (so drafts compile from real items), and the compiler's keyword-stub placeholder titles are killed — Adjutant drafts with zero real items show **no fake card**, while the human create-draft flow keeps one honest fallback card whose title is **derived from the actual content**.

**Architecture:** Three hook points. (1) `extraction.ts` gains an **awaited, targeted** helper `extractThreadEntriesAwait` — selects only never-extracted entries (`pending`/`skipped`/`failed`, no existing items, not scope_proposals), flips them `pending`, and serially awaits `extractFromDiscussionEntry` (best-effort per entry). (2) The controller `create_scope_draft` handler (`thread-agent-actions.ts`) awaits that helper before `createDraftFromThread` and passes a new `suppressFallbackTask: true`. (3) The compiler (`thread-scope-draft-compiler.ts`) replaces `titleForGeneratedTask`/`memoryCandidateTitle` keyword stubs with content-derived titles, and skips fallback-task synthesis entirely when `suppressFallbackTask` is set. Human REST route is untouched (default `false` → derived fallback keeps the flow working).

**Tech Stack:** TypeScript, Express 5, Drizzle ORM, Vitest (unit + real-embedded-postgres integration with the UTF-8 `initdbFlags` local-Windows trick), Playwright e2e. Branch: `feat/w2-extract-then-scope` off current `main` (`9e6f9be3e`).

---

## Context & Locked Decisions (do not re-litigate)

From `docs/aoa/plans/2026-07-03-discussions-end-to-end-design.md`:

- **D6** — Extraction trigger is **deliberate**: phase=done / **Adjutant scoping** / reprocess. Adjutant = **extract-then-scope**. **Kill the placeholder stub so an empty thread never shows a fake card.**
- **W2 bullet** — "Remove/replace `titleForGeneratedTask` + `memoryCandidateTitle` placeholders; **derive from summary or suppress the synthetic item when there are zero real items**. Update the pinning test."
- **D16** (Settings extraction-trigger preference) is **W6 — NOT in scope here**. The "phase=done" extraction trigger is also **NOT in scope** (only Adjutant scoping changes).

**W2-specific decisions (LOCKED at eng-review 2026-07-03):**
- **Split behavior:** Adjutant path (extraction attempted) → suppress the synthetic fallback task when zero real items. Human create-draft route (no extraction — a synchronous HTTP request must not await minutes of CLI extraction) → keep ONE fallback task card, title derived from actual entry content (the fake keyword titles die everywhere).
- **Eng-review D3 (user-locked end-state):** ALL task titles must ultimately be **agent-authored**. Every crew path already is (proposedTasks / extracted items / no card). The human "Create scope draft" button is the only agent-free path; its derived title is an **interim stopgap**. The locked end-state — recorded in the design doc by Task 7 — is that the button becomes **"Ask Adjutant to scope"** (async crew run → agent-named draft), sequenced AFTER the fake-crew-harness CI follow-up (filed during W1c) that unblocks its e2e story. Do NOT build the unification in W2.
- **Eng-review D3 (title heuristic):** the derived title comes from the **longest** non-empty entry in the scoped range (first sentence, word-truncated to 80) — not the first entry, so greetings can't win. The Task 6 e2e locator derives from the same rule.
- **Eng-review D2 (wall-clock deadline):** the extraction pass has `EXTRACT_SCOPE_DEADLINE_MS = 180_000` in addition to the 25-entry cap — checked before each entry; when exceeded, stop, log, and return `deadlineHit: true`. A hung-but-installed CLI turns into "honest answer within ~4 minutes", never a ~50-minute silent pipeline stall.
- **Extraction selection is conservative:** only entries that have **no extracted items at all** and status `pending`/`skipped`/`failed` are extracted. Entries with pending/edited items a founder may be reviewing are **left untouched** (unlike `reprocessAllEntries`, which deletes + re-extracts — that stays reprocess-only semantics).
- **Best-effort:** extraction failure (CLI not installed / not authed / timeout) must **never block draft creation** — compile with whatever items exist.
- **Bounded:** cap at `MAX_EXTRACT_ENTRIES_PER_SCOPE = 25` entries per scoping pass, log when truncating (no silent caps).

## Verified mechanism (from investigation — do not re-derive)

- **Compiler** (`server/src/services/thread-scope-draft-compiler.ts`): `titleForGeneratedTask` (line ~97) returns keyword stubs ("scope"→"Implement real multi-message scope generation", "crew"→"Implement crew discussion roundtable flow", else "Turn discussion into a scoped work package"). `memoryCandidateTitle` (line ~104) similar stubs. Place-2 synthesis (line ~307): fires when `scopedEntries.length > 0 && !hasGeneratedWorkItem && !useProposedTasks`. Memory-candidate synthesis (line ~323) is **intent-gated** by `shouldSynthesizeMemoryCandidate` (explicit durable-memory/decision signals) — the synthesis stays; only its stub title changes. W1a's `proposedTasks` already suppress Place-2.
- **Extraction** (`server/src/services/extraction.ts`): `extractionService(db).extractFromDiscussionEntry(companyId, entryId)` atomically claims `pending → processing` (only processes entries whose status is `pending`, line ~273), runs the keyless CLI, sets `completed`/`failed`/`skipped`. It never touches `scope_proposal` entries. Awaitable.
- **Reset semantics** (`server/src/services/discussions.ts:1404-1613`): `reprocessEntry`/`reprocessAllEntries` reset failed/pending/skipped → `pending` (guarding scope_proposals + approved items), then trigger extraction **fire-and-forget**. W2's helper is a NEW method with narrower selection + awaited execution — not a reprocess mode.
- **Handler** (`server/src/services/thread-agent-actions.ts`): the `create_scope_draft` branch calls `scopeVersionCommitter.createDraftFromThread(...)` at ~line 744 (post-W1c: ~907 after the Assist-approval additions — search for `action.actionType === "create_scope_draft"`). Two OTHER `createDraftFromThread` call sites exist (`add_scope_item` ~line 902+ and an **in-transaction** one ~1080) — those get **no extraction** (never spawn CLIs inside a txn) and **no suppress flag** (default derived-fallback behavior).
- **`createDraftFromThread`** (`server/src/services/thread-scope-versions.ts:628`): W1a added `proposedTasks` to its input; `suppressFallbackTask` is added the same way and forwarded to the compiler. It selects extracted items that are still actionable (`pending` OR `edited`).
- **Zero-item drafts are safe downstream:** UI `ScopeTab.tsx:499,727` has `items.length === 0` empty states; `applyAcceptedDraft` returns `nothing_accepted`; W1b/W1c Assist guard is `createdTasks.length > 0` (no approval enqueued for an empty draft).
- **Placeholder-string pins that must change:** `server/src/__tests__/thread-scope-draft-compiler.test.ts` (line ~368 pins the legacy placeholder), `server/src/__tests__/thread-scope-accept.test.ts:1136` (fixture title), `tests/e2e/full-discussion-to-workspace-cycle.spec.ts:234` (clicks the placeholder card by name — the spec seeds known entry text, so the derived title is predictable).

---

## File Structure

**Modified:**
- `server/src/services/thread-scope-draft-compiler.ts` — derived titles; `suppressFallbackTask` in `CompileInput`; Place-2 guard.
- `server/src/services/thread-scope-versions.ts` — `createDraftFromThread` input + forward.
- `server/src/services/extraction.ts` — new `extractThreadEntriesAwait` method.
- `server/src/services/thread-agent-actions.ts` — extract-then-scope hook + `suppressFallbackTask: true` in the `create_scope_draft` branch; local `ScopeVersionCommitService` type extended.
- `server/src/__tests__/thread-scope-draft-compiler.test.ts` — pinning tests updated.
- `server/src/__tests__/thread-scope-accept.test.ts` — fixture title.
- `server/src/__tests__/w1b-auto-accept.test.ts` — handler mock gains the extraction spy (import breakage guard).
- `tests/e2e/full-discussion-to-workspace-cycle.spec.ts` — locator update to the derived title.

**New tests:**
- `server/src/__tests__/extract-thread-entries-await.test.ts` — unit: selection, serial await, best-effort, cap.
- `server/src/__tests__/w2-extract-then-scope.test.ts` — handler unit: extraction awaited before draft; failure doesn't block; suppress flag passed.
- `server/src/__tests__/w2-extract-then-scope.integration.test.ts` — real DB: seeded real items → real cards + no placeholder; failed extraction (no CLI) → zero-card draft in Adjutant path; human default → derived fallback card.

---

## Task 1: Compiler — derived titles + `suppressFallbackTask`

**Files:**
- Test: `server/src/__tests__/thread-scope-draft-compiler.test.ts` (modify)
- Modify: `server/src/services/thread-scope-draft-compiler.ts`

- [ ] **Step 1: Update/extend the pinning tests (failing first).** In `thread-scope-draft-compiler.test.ts`:

Replace the legacy pin (the test at ~line 368, `"falls back to extracted-item compilation when proposedTasks is absent"`) and add new cases. Use the file's existing fixture helpers (read the file first; it builds `CompileInput` objects inline):

```typescript
  it("derives the fallback task title from entry content — the keyword stubs are dead", () => {
    // Entry text deliberately contains 'scope' — the OLD stub would have returned
    // "Implement real multi-message scope generation". The derived title must come
    // from the actual content instead.
    const result = compileThreadScopeDraft(makeInput({
      entries: [makeEntry({ rawContent: "We need to scope the auth token endpoint rewrite before Friday." })],
      extractedItems: [],
    }));
    const tasks = result.items.filter((i) => i.kind === "task_proposal");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("We need to scope the auth token endpoint rewrite before Friday.");
    expect(tasks[0].title).not.toMatch(/Implement real multi-message|Implement crew discussion|Turn discussion into/);
  });

  it("truncates long derived titles at a word boundary (<= 80 chars)", () => {
    const long = "Rebuild the entire authentication and authorization pipeline including refresh token rotation, session revocation lists, and audit logging for every login path.";
    const result = compileThreadScopeDraft(makeInput({
      entries: [makeEntry({ rawContent: long })],
      extractedItems: [],
    }));
    const task = result.items.find((i) => i.kind === "task_proposal")!;
    expect(task.title.length).toBeLessThanOrEqual(80);
    expect(task.title.startsWith("Rebuild the entire authentication")).toBe(true);
  });

  it("derives from the LONGEST entry — a short greeting first entry cannot become the title (eng-review D3)", () => {
    const result = compileThreadScopeDraft(makeInput({
      entries: [
        makeEntry({ rawContent: "Hey team, quick one." }),
        makeEntry({ rawContent: "We need to rebuild the billing retry queue with dead-letter handling." }),
      ],
      extractedItems: [],
    }));
    const task = result.items.find((i) => i.kind === "task_proposal")!;
    expect(task.title).toBe("We need to rebuild the billing retry queue with dead-letter handling.");
    expect(task.title).not.toMatch(/Hey team/);
  });

  it("suppressFallbackTask: the intent-gated memory candidate still emits (it is derived, not fake)", () => {
    // Entry carries explicit durable-memory + decision intent — shouldSynthesizeMemoryCandidate
    // fires. suppressFallbackTask kills only the fallback TASK card, never the intent-derived
    // memory candidate (D6 targets fake cards; this one is authored by the user's own words).
    const result = compileThreadScopeDraft(makeInput({
      entries: [makeEntry({ rawContent: "Save this to durable memory: our decision rule is codex-first for extraction." })],
      extractedItems: [],
      suppressFallbackTask: true,
    }));
    expect(result.items.filter((i) => i.kind === "task_proposal")).toHaveLength(0);
    expect(result.items.filter((i) => i.kind === "memory_candidate")).toHaveLength(1);
  });

  it("suppressFallbackTask: zero real items → NO synthetic task card at all", () => {
    const result = compileThreadScopeDraft(makeInput({
      entries: [makeEntry({ rawContent: "let us scope the crew work" })],
      extractedItems: [],
      suppressFallbackTask: true,
    }));
    expect(result.items.filter((i) => i.kind === "task_proposal")).toHaveLength(0);
  });

  it("suppressFallbackTask does NOT suppress real extracted items or proposedTasks", () => {
    const result = compileThreadScopeDraft(makeInput({
      entries: [makeEntry({ rawContent: "scope this" })],
      extractedItems: [makeExtractedItem({ type: "task", title: "Real extracted task" })],
      suppressFallbackTask: true,
    }));
    const tasks = result.items.filter((i) => i.kind === "task_proposal");
    expect(tasks.map((t) => t.title)).toContain("Real extracted task");
  });
```

Also update the existing memory-candidate tests (~line 275): the synthesized memory candidate's title is now derived (first sentence of the matched content, truncated to 80) instead of `"Scoped discussion memory"` / `"Durable memory from scoped discussion"`. Adjust the assertions to the derived value from each test's fixture text.

**Note on helpers:** if `makeInput`/`makeEntry`/`makeExtractedItem` helpers don't exist in the file, follow whatever inline-object pattern the existing tests use — do NOT invent new helper layers.

- [ ] **Step 2: Run to verify the new tests fail** (`titleForGeneratedTask` still returns stubs; `suppressFallbackTask` unknown):

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/thread-scope-draft-compiler.test.ts`
Expected: new cases FAIL, old placeholder pin (now rewritten) FAILS.

- [ ] **Step 3: Implement in the compiler.**

In `server/src/services/thread-scope-draft-compiler.ts`:

(a) Add `suppressFallbackTask?: boolean` to `CompileInput` (next to `proposedTasks`), with a doc comment:
```typescript
  /** W2 (D6): when the caller ran extraction first (Adjutant extract-then-scope) and
   *  there are still zero real actionable items, suppress the synthetic fallback task —
   *  an extracted-and-empty thread must never show a fake card. Default false: the human
   *  create-draft route (which does not run extraction synchronously) keeps ONE honest
   *  fallback card whose title derives from the actual content. */
  suppressFallbackTask?: boolean;
```

(b) Replace both stub functions with content-derived versions:
```typescript
/** W2 (D6): titles derive from the actual discussion content — the keyword stubs
 *  ("Implement real multi-message scope generation", …) are dead. Eng-review D3: use the
 *  LONGEST non-empty entry (most content-bearing; greetings can't win), first sentence,
 *  word-truncated to 80 chars. Callers guarantee entries is non-empty (Place-2 requires
 *  scopedEntries.length > 0). Interim only — the locked end-state is agent-authored
 *  titles everywhere (human create-draft button → "Ask Adjutant to scope", queued). */
function derivedTitleFromEntries(entries: ScopeCompilerEntry[], fallback: string): string {
  let longest = "";
  for (const entry of entries) {
    const text = cleanText(entry.rawContent);
    if (text.length > longest.length) longest = text;
  }
  const sentence = longest ? firstSentence(longest) : "";
  return sentence ? truncateAtWord(sentence, 80) : fallback;
}

function titleForGeneratedTask(entries: ScopeCompilerEntry[]): string {
  return derivedTitleFromEntries(entries, "Scope work from this discussion");
}

function memoryCandidateTitle(entries: ScopeCompilerEntry[]): string {
  return derivedTitleFromEntries(entries, "Decision from this discussion");
}
```
(Reuse the file's existing `cleanText` / `firstSentence` / `truncateAtWord` helpers — they exist at lines ~72-86.)

(c) Guard Place-2 synthesis with the flag (line ~307):
```typescript
  // Place 2: fallback-task synthesis — title derived from content (W2 killed the keyword
  // stubs). Suppressed when proposedTasks exist (W1a) OR when the caller ran extraction
  // first and found nothing actionable (W2 suppressFallbackTask — no fake card, D6).
  if (
    scopedEntries.length > 0 &&
    !hasGeneratedWorkItem &&
    !useProposedTasks &&
    !input.suppressFallbackTask
  ) {
```

Do NOT change the memory-candidate synthesis gate (`shouldSynthesizeMemoryCandidate`) — it is intent-driven, not a fake card. Only its title derivation changes via (b).

- [ ] **Step 4: Run to verify all compiler tests pass:**

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/thread-scope-draft-compiler.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix the other unit fixture.** `server/src/__tests__/thread-scope-accept.test.ts:1136` uses `title: "Turn discussion into a scoped work package"` as a plain fixture string — that test doesn't exercise the compiler, so the title is arbitrary; rename it to `"Scope work from this discussion"` for consistency (or any non-stub string). Run that file to confirm no behavioral coupling:

Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/thread-scope-accept.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @armyofagents/server exec tsc --noEmit` (exit 0)
```bash
git add server/src/services/thread-scope-draft-compiler.ts server/src/__tests__/thread-scope-draft-compiler.test.ts server/src/__tests__/thread-scope-accept.test.ts
git commit -m "feat(scope): derive fallback titles from content + suppressFallbackTask flag — keyword stubs dead (W2)"
```
End the commit message with `Co-Authored-By:` per repo convention.

---

## Task 2: `createDraftFromThread` forwards `suppressFallbackTask`

**Files:**
- Test: `server/src/__tests__/thread-scope-assignment.test.ts` (extend — it already unit-tests `createDraftFromThread → compiler` forwarding for `proposedTasks`; read it first and mirror its mock pattern)
- Modify: `server/src/services/thread-scope-versions.ts`

- [ ] **Step 1: Write the failing test.** Mirror the existing `proposedTasks`-forwarding case: call `createDraftFromThread(companyId, threadId, { …existing shape…, suppressFallbackTask: true })` with a sequence-mock DB (one entry, zero extracted items) and assert the created draft's items contain **no** `task_proposal` (i.e. the flag reached the compiler). Keep the existing test proving the default (`undefined`) still synthesizes the derived fallback.

- [ ] **Step 2: Run to verify it fails** (input type doesn't accept the key / flag not forwarded):
Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/thread-scope-assignment.test.ts`

- [ ] **Step 3: Implement.** In `thread-scope-versions.ts`: add `suppressFallbackTask?: boolean` to `createDraftFromThread`'s options input (exactly where W1a put `proposedTasks` — read the signature at line ~628 first) and forward it into the `compileThreadScopeDraft(...)` call's `CompileInput`.

- [ ] **Step 4: Run to verify it passes + typecheck.** Same commands. Expected: PASS + tsc exit 0.

- [ ] **Step 5: Commit**
```bash
git add server/src/services/thread-scope-versions.ts server/src/__tests__/thread-scope-assignment.test.ts
git commit -m "feat(scope): createDraftFromThread forwards suppressFallbackTask to the compiler (W2)"
```

---

## Task 3: `extractThreadEntriesAwait` — awaited, targeted extraction helper

**Files:**
- Test: `server/src/__tests__/extract-thread-entries-await.test.ts` (create)
- Modify: `server/src/services/extraction.ts`

- [ ] **Step 1: Write the failing test.** Create the test file using the codebase's sequence-mock idiom (`makeTableProxy` + `drizzleOperatorStubs` from `./helpers/drizzle-mock.js` — model on `crew-dispatch-approval.test.ts`'s structure). The helper under test is a NEW method on `extractionService(db)`. Cases:

```typescript
// (a) selection: only entries with status pending/skipped/failed, inputType !== 'scope_proposal',
//     and ZERO existing extracted items are processed; others untouched.
// (b) skipped/failed entries are flipped to 'pending' BEFORE extractFromDiscussionEntry
//     (which only claims pending rows).
// (c) serial await: extractFromDiscussionEntry (spy on the service's own method — see
//     implementation note below) is awaited once per selected entry, in seq order.
// (d) best-effort: one entry's extraction throwing does not stop the rest; the helper
//     resolves with { attempted, failed } counts and never rejects.
// (e) cap: with MAX_EXTRACT_ENTRIES_PER_SCOPE+1 eligible entries, only the cap count is
//     attempted and the return value reports truncated: true.
// (f) deadline (eng-review D2): inject a `now` clock (see opts.now below) that advances
//     past EXTRACT_SCOPE_DEADLINE_MS after the first entry — only 1 entry attempted,
//     return reports deadlineHit: true, remaining entries untouched.
```

**Implementation note for testability:** `extractFromDiscussionEntry` is a sibling method on the same service object. To keep the helper unit-testable without a real CLI, structure the new method to call `service.extractFromDiscussionEntry` through the returned object (or accept an injectable `extractOne` param defaulting to the sibling). Prefer the injectable param — explicit over clever:

```typescript
    /** W2 (D6 extract-then-scope): extract the thread's never-extracted entries and WAIT.
     *  Selection is conservative — entries with any existing extracted items are left
     *  alone (a founder may be mid-review; reprocess semantics stay in reprocessAllEntries).
     *  Serial (one CLI at a time), best-effort per entry, capped by COUNT (25) and by
     *  WALL-CLOCK (eng-review D2: EXTRACT_SCOPE_DEADLINE_MS — a hung CLI must not stall
     *  the controller pipeline for ~50 min; give an honest answer within minutes).
     *  Never throws. */
    extractThreadEntriesAwait: async (
      companyId: string,
      discussionId: string,
      opts?: {
        extractOne?: (companyId: string, entryId: string) => Promise<unknown>;
        now?: () => number; // injectable clock for the deadline unit test
      },
    ): Promise<{ attempted: number; failed: number; truncated: boolean; deadlineHit: boolean }> => { ... }
```

- [ ] **Step 2: Run to verify it fails** (method doesn't exist):
Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/extract-thread-entries-await.test.ts`

- [ ] **Step 3: Implement in `extraction.ts`** (inside the `extractionService(db)` returned object):

```typescript
    extractThreadEntriesAwait: async (
      companyId: string,
      discussionId: string,
      opts?: {
        extractOne?: (companyId: string, entryId: string) => Promise<unknown>;
        now?: () => number;
      },
    ): Promise<{ attempted: number; failed: number; truncated: boolean; deadlineHit: boolean }> => {
      const log = logger.child({ service: "extraction", discussionId, companyId, mode: "scope-await" });
      const extractOne = opts?.extractOne ?? service.extractFromDiscussionEntry;
      const now = opts?.now ?? Date.now;
      const startedAt = now();
      try {
        // Eligible: prose entries never extracted — status pending/skipped/failed AND no
        // existing extracted items. Entries with items are a founder-review surface;
        // deleting/re-extracting them is reprocess-only semantics (discussions.ts).
        const rows = (await db
          .select({ id: discussionEntries.id, extractionStatus: discussionEntries.extractionStatus })
          .from(discussionEntries)
          .leftJoin(
            discussionExtractedItems,
            eq(discussionExtractedItems.discussionEntryId, discussionEntries.id),
          )
          .where(and(
            eq(discussionEntries.discussionId, discussionId),
            ne(discussionEntries.inputType, "scope_proposal"),
            inArray(discussionEntries.extractionStatus, ["pending", "skipped", "failed"]),
            isNull(discussionExtractedItems.id),
          ))
          .orderBy(asc(discussionEntries.seq))) as Array<{ id: string; extractionStatus: string }>;

        const truncated = rows.length > MAX_EXTRACT_ENTRIES_PER_SCOPE;
        const selected = rows.slice(0, MAX_EXTRACT_ENTRIES_PER_SCOPE);
        if (truncated) {
          log.warn({ eligible: rows.length, cap: MAX_EXTRACT_ENTRIES_PER_SCOPE },
            "extract-then-scope truncated eligible entries at cap");
        }

        let failed = 0;
        let attempted = 0;
        let deadlineHit = false;
        for (const row of selected) {
          // Eng-review D2: wall-clock deadline — a hung-but-installed CLI must never turn
          // one scoping pass into a ~50-minute controller-pipeline stall. Compile with
          // whatever was extracted so far; the founder gets an honest answer in minutes.
          if (now() - startedAt > EXTRACT_SCOPE_DEADLINE_MS) {
            deadlineHit = true;
            log.warn(
              { attempted, remaining: selected.length - attempted, deadlineMs: EXTRACT_SCOPE_DEADLINE_MS },
              "extract-then-scope deadline hit — compiling with items extracted so far",
            );
            break;
          }
          try {
            if (row.extractionStatus !== "pending") {
              // extractFromDiscussionEntry only claims 'pending' rows.
              await db.update(discussionEntries)
                .set({ extractionStatus: "pending", extractionRunId: null })
                .where(eq(discussionEntries.id, row.id));
            }
            attempted += 1;
            await extractOne(companyId, row.id);
          } catch (err) {
            failed += 1;
            log.warn({ err, entryId: row.id }, "extract-then-scope entry failed (best-effort)");
          }
        }
        return { attempted, failed, truncated, deadlineHit };
      } catch (err) {
        log.warn({ err }, "extract-then-scope selection failed (best-effort) — compiling without");
        return { attempted: 0, failed: 0, truncated: false, deadlineHit: false };
      }
    },
```

Add near the service's other constants (module scope, exported for the tests):
```typescript
export const MAX_EXTRACT_ENTRIES_PER_SCOPE = 25;
export const EXTRACT_SCOPE_DEADLINE_MS = 180_000; // eng-review D2 — see plan
``` Check the file's existing imports — `discussionExtractedItems`, `ne`, `isNull`, `asc` may need adding to the drizzle/db imports. **Note:** the returned object must be assigned to a `const service = { ... }` (or restructure minimally) so `extractOne` can default to the sibling method — follow whatever shape the file already has; if it returns an object literal today, bind via `opts?.extractOne ?? ((c, e) => extractionService(db).extractFromDiscussionEntry(c, e))` instead of restructuring.

**LEFT JOIN + isNull caveat:** a LEFT JOIN with multiple item rows per entry duplicates entries — but the `isNull(discussionExtractedItems.id)` filter keeps only zero-item entries, so no dedup is needed. If the existing drizzle version fights the join types, an `NOT EXISTS` subquery via `sql` is the fallback — keep it in drizzle operators if possible.

- [ ] **Step 4: Run to verify it passes + typecheck.** Expected: PASS + tsc exit 0.

- [ ] **Step 5: Commit**
```bash
git add server/src/services/extraction.ts server/src/__tests__/extract-thread-entries-await.test.ts
git commit -m "feat(extraction): awaited targeted extractThreadEntriesAwait for extract-then-scope (W2)"
```

---

## Task 4: Handler hook — extract-then-scope in `create_scope_draft`

**Files:**
- Test: `server/src/__tests__/w2-extract-then-scope.test.ts` (create)
- Test (guard): `server/src/__tests__/w1b-auto-accept.test.ts` (extend mocks)
- Modify: `server/src/services/thread-agent-actions.ts`

- [ ] **Step 1: Write the failing handler test.** Create `w2-extract-then-scope.test.ts` modeled on `w1b-auto-accept.test.ts` (same `vi.hoisted` mock stack — crew-task-service, crew-budget, crew-role-map, threads, approvals, hub-source-producers, activity-log — plus a new mock for `../services/extraction.js`):

```typescript
const { mockExtractThreadEntriesAwait } = vi.hoisted(() => ({
  mockExtractThreadEntriesAwait: vi.fn().mockResolvedValue({ attempted: 2, failed: 0, truncated: false }),
}));
vi.mock("../services/extraction.js", () => ({
  extractionService: () => ({ extractThreadEntriesAwait: mockExtractThreadEntriesAwait }),
}));
```

Cases (reuse the W1b file's `makeDb`/`scopeDraftAction`/`draftReturn` fixtures — copy them, don't import):
```typescript
// (a) create_scope_draft: extraction runs BEFORE createDraftFromThread —
//     assert call order via mock invocation order (mockExtractThreadEntriesAwait
//     invoked before the createDraftFromThread spy) and with (companyId, threadId).
// (b) createDraftFromThread receives suppressFallbackTask: true (assert on the
//     options argument the handler passes).
// (c) extraction REJECTING (mock rejects) does not prevent the draft: createDraftFromThread
//     still called, action still commits. (Defense-in-depth; the helper itself never
//     throws, but the handler must not depend on that.)
```

- [ ] **Step 2: Extend `w1b-auto-accept.test.ts` mocks.** That file imports the real `thread-agent-actions.js`, which will now import `extraction.js` — add the same `vi.mock("../services/extraction.js", …)` block (default resolved value) so the existing 11 tests keep passing. Run it to confirm current state (it fails to load until the source import exists — fine, proceed).

- [ ] **Step 3: Run the new test to verify it fails.**
Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/w2-extract-then-scope.test.ts`

- [ ] **Step 4: Implement in `thread-agent-actions.ts`.**

(a) Import: `import { extractionService } from "./extraction.js";`

(b) In the `create_scope_draft` branch, immediately BEFORE the `scopeVersionCommitter.createDraftFromThread(...)` call (search `action.actionType === "create_scope_draft"`; the call site is inside that branch):

```typescript
            // W2 (D6 extract-then-scope): run keyless CLI extraction over the thread's
            // never-extracted entries and WAIT, so the draft compiles from real items.
            // Best-effort — extraction failure (CLI missing/not authed/timeout) must never
            // block draft creation; the compiler then sees zero items and, because we pass
            // suppressFallbackTask below, emits NO fake card (D6).
            try {
              const extraction = await extractionService(
                actionDb as unknown as import("@armyofagents/db").Db,
              ).extractThreadEntriesAwait(input.companyId, input.threadId);
              log.info(
                { threadId: input.threadId, ...extraction },
                "extract-then-scope completed before draft compile",
              );
            } catch (err) {
              log.warn({ err, threadId: input.threadId },
                "extract-then-scope failed — compiling draft from existing items only");
            }
```

(c) Add `suppressFallbackTask: true` to the options object passed to `createDraftFromThread` in this branch (the same object that carries `proposedTasks` — read the exact shape first). Extend the local `ScopeVersionCommitService` type's `createDraftFromThread` signature with `suppressFallbackTask?: boolean` (this type was the W1a-T4 review catch — keep it in sync).

(d) Do NOT touch the other two `createDraftFromThread` call sites (`add_scope_item`, the in-transaction one) — no extraction, no flag.

- [ ] **Step 5: Run all three test files:**
Run: `pnpm --filter @armyofagents/server exec vitest run src/__tests__/w2-extract-then-scope.test.ts src/__tests__/w1b-auto-accept.test.ts src/__tests__/thread-scope-assignment.test.ts`
Expected: ALL PASS.

- [ ] **Step 6: Typecheck + commit**
```bash
git add server/src/services/thread-agent-actions.ts server/src/__tests__/w2-extract-then-scope.test.ts server/src/__tests__/w1b-auto-accept.test.ts
git commit -m "feat(scope): Adjutant extract-then-scope + no fake card on empty extraction (W2)"
```

---

## Task 5: Real-DB integration test

**Files:**
- Test: `server/src/__tests__/w2-extract-then-scope.integration.test.ts` (create)

Model VERBATIM on `w1c-inbox-dispatch-approval.integration.test.ts`: same embedded-postgres lifecycle **including `initdbFlags: ["--encoding=UTF8", "--locale=C"]`**, `describe.skipIf(process.platform === "win32")`, unique `mkdtemp` prefix (`aoa-w2-extract-scope-integ-`), unique PORT, and the `seedCompanyAndAgent` (SELECT-or-INSERT Engineer + founder user_roles seed) / `seedThreadWithInsight` / `seedRun` / `setThreadAutonomy` / `captureFreshnessSnapshot` helpers.

- [ ] **Step 1: Case 1 — real extracted items compile into real cards, no placeholder.** Seed a thread + entry, then INSERT a `discussion_extracted_items` row directly (type `task`, title `"Build the token endpoint"`, status `pending`) — the deterministic stand-in for a completed extraction. Seed a `create_scope_draft` action (NO `proposedTasks` in the payload) at autonomy 0 (Manual — keep W1b out of the way), commit, then assert: the scope version's `task_proposal` item has title `"Build the token endpoint"`, and NO item title matches `/Implement real multi-message|Implement crew discussion|Turn discussion into|Scope work from this discussion/`.

- [ ] **Step 2: Case 2 — Adjutant path with failed extraction → zero-card draft (no fake card).** Seed a thread + one prose entry with `extraction_status = 'skipped'` and zero extracted items. Commit a `create_scope_draft` action (no proposedTasks). On this machine there is no `claude` CLI configured for the seeded company → `extractFromDiscussionEntry` marks the entry `failed` (or the attempt errors) — either way best-effort proceeds. Assert: the action commits (`status = 'committed'`), a scope version exists, and it contains **zero `task_proposal` items** (memory_candidate also absent unless the entry text carries durable-memory intent — use neutral text). Also assert the entry's `extraction_status` is no longer `skipped` (it was attempted: `pending`/`processing`/`failed`/`completed`).

- [ ] **Step 3: Case 3 — human default still derives a fallback card.** Call `threadScopeVersionService(db).createDraftFromThread(companyId, threadId, {...})` directly WITHOUT `suppressFallbackTask` on a thread with one prose entry (text: `"Rework the billing retry queue."`) and zero items. Assert exactly one `task_proposal` whose title is `"Rework the billing retry queue."` (the derived title — proving the human flow keeps working and stubs are dead).

- [ ] **Step 4: Validate locally (Windows) + restore.** Temporarily flip `skipIf` to `false`, run:
`pnpm --filter @armyofagents/server exec vitest run src/__tests__/w2-extract-then-scope.integration.test.ts`
Expected: all 3 PASS locally (UTF-8 initdbFlags make embedded-pg locale-safe). **Flip `skipIf` back to `process.platform === "win32"` before committing.** Typecheck: exit 0.

- [ ] **Step 5: Commit**
```bash
git add server/src/__tests__/w2-extract-then-scope.integration.test.ts
git commit -m "test(scope): integration — extract-then-scope real items, no fake card, human fallback derived (W2)"
```

---

## Task 6: E2E — update the placeholder-dependent spec

**Files:**
- Modify: `tests/e2e/full-discussion-to-workspace-cycle.spec.ts`

- [ ] **Step 1: Update the locator.** Line ~234 clicks `getByRole("button", { name: /Implement real multi-message scope generation/i })`. The derived title is now the first sentence of the **LONGEST** seeded entry in the scoped range (eng-review D3), word-truncated to 80. Read the spec's seeded entries (first human entry ~line 85 plus any others), identify the longest, compute the expected derived title from that exact string, and update the locator to it. If that first sentence exceeds 80 chars, either shorten the seeded text (preferred — keeps the locator readable) or match on the truncated prefix.

- [ ] **Step 2: Sweep the spec for other stub-dependent assertions** (`grep -n "Implement real\|Implement crew\|Turn discussion\|Scoped discussion memory" tests/e2e/full-discussion-to-workspace-cycle.spec.ts`) and update each the same way. Also check the memory-candidate expectation (~line 118, "scope draft should include a memory candidate") — the seeded text must still trip `shouldSynthesizeMemoryCandidate` (needs an explicit durable-memory/decision phrase); if the current seeded text relies on it, keep that phrasing intact.

- [ ] **Step 3: Parse-check** (full e2e runs on CI; locally just confirm discovery):
Run: `npx playwright test tests/e2e/full-discussion-to-workspace-cycle.spec.ts --list`
Expected: the test is listed without errors.

- [ ] **Step 4: Commit**
```bash
git add tests/e2e/full-discussion-to-workspace-cycle.spec.ts
git commit -m "test(e2e): scope-cycle spec follows derived fallback title — keyword stub retired (W2)"
```

---

## Task 7: Docs

**Files:**
- Modify: `CLAUDE.md` (Discussion Pipeline section)
- Modify: `docs/aoa/plans/2026-07-03-discussions-end-to-end-design.md` (W2 status)

- [ ] **Step 1: CLAUDE.md.** In the Discussion Pipeline section, after the "Autonomy → dispatch" bullet, add:

```markdown
- **Extract-then-scope (W2, D6):** the controller `create_scope_draft` commit awaits `extractionService.extractThreadEntriesAwait` (never-extracted entries only — status pending/skipped/failed with zero items; capped at 25; best-effort) BEFORE compiling, then compiles with `suppressFallbackTask: true` — an Adjutant draft with zero real items shows **no synthetic task card**. The human create-draft route does not run extraction (synchronous request) and keeps ONE fallback card whose title derives from entry content (`derivedTitleFromEntries`); the keyword-stub titles ("Implement real multi-message scope generation", …) are dead. Reprocess (delete + re-extract) semantics stay in `discussions.ts reprocessAllEntries`.
```

- [ ] **Step 2: Design doc.** Under `### W2 — Extraction-then-scope + kill the stub`, append a `**STATUS (2026-07-03): SHIPPED**` block summarizing the split behavior (Adjutant suppress / human derived fallback), the conservative selection rule, and the count+deadline caps.

- [ ] **Step 2b: Record the D3 locked end-state as a new design decision.** In the design doc's decision table (after D16), add:

```markdown
| D17 | Task naming | **All task titles are agent-authored.** Crew paths already are (proposedTasks / extracted items / no card). The human "Create scope draft" button's derived title is an interim stopgap — the button becomes **"Ask Adjutant to scope"** (async crew run → agent-named draft). Sequenced AFTER the fake-crew-harness CI follow-up (filed during W1c) that unblocks its e2e story. (Locked at W2 eng-review, 2026-07-03) |
```

- [ ] **Step 3: Commit**
```bash
git add CLAUDE.md docs/aoa/plans/2026-07-03-discussions-end-to-end-design.md
git commit -m "docs(scope): record W2 extract-then-scope + derived/suppressed fallback (D6)"
```

---

## Task 8: Full verification sweep + PR

- [ ] **Step 1: Server unit suite (targeted):**
```bash
pnpm --filter @armyofagents/server exec vitest run \
  src/__tests__/thread-scope-draft-compiler.test.ts \
  src/__tests__/thread-scope-assignment.test.ts \
  src/__tests__/thread-scope-accept.test.ts \
  src/__tests__/extract-thread-entries-await.test.ts \
  src/__tests__/w2-extract-then-scope.test.ts \
  src/__tests__/w1b-auto-accept.test.ts \
  src/__tests__/crew-dispatch-approval.test.ts
```
Expected: ALL PASS.

- [ ] **Step 2: Full server suite** (catches transitive-import mock breakage — the W1c lesson):
`pnpm --filter @armyofagents/server exec vitest run` — expected: green except the known cwd-sensitive `sweep-steward.test.ts` source-inspection case under `--filter` (verify it's THAT failure only, if any).

- [ ] **Step 3: Typecheck all:** `pnpm --filter @armyofagents/server exec tsc --noEmit` + `pnpm --filter @armyofagents/shared exec tsc --noEmit` + `pnpm --filter @armyofagents/ui exec tsc --noEmit` (all exit 0).

- [ ] **Step 4: Integration re-run (local Windows flip + restore)** for the W2 + W1c + W1b integration files.

- [ ] **Step 5: Push + PR + Codex loop.** Push `feat/w2-extract-then-scope`, open the PR against main (title: `feat(discussions): W2 — extract-then-scope + kill the placeholder stub`), watch `ci-required` + Codex; fix findings per the W1c protocol (reply + `@codex review` re-trigger until clean).

---

## Self-Review

**Spec coverage:** D6 extract-then-scope (Task 3+4) ✓; kill-the-stub with "derive from summary or suppress" — both, split by path (Task 1) ✓; pinning test updated (Task 1) ✓; e2e updated (Task 6) ✓; reprocess untouched ✓; phase=done + Settings triggers explicitly out of scope ✓.

**Placeholder scan:** all steps carry real code or exact file:line targets; the two "read the file first" notes are deliberate (fixture helpers + exact input shapes vary) with the fallback behavior specified.

**Type consistency:** `suppressFallbackTask?: boolean` — same name in `CompileInput` (T1), `createDraftFromThread` input (T2), handler options + local `ScopeVersionCommitService` type (T4). `extractThreadEntriesAwait(companyId, discussionId, opts?) → { attempted, failed, truncated, deadlineHit }` with `opts.extractOne` + `opts.now` — same in T3 (impl + constants `MAX_EXTRACT_ENTRIES_PER_SCOPE`/`EXTRACT_SCOPE_DEADLINE_MS`), T4 (handler call logs the spread), T3/T4 tests. Derived-title helper: `derivedTitleFromEntries(entries, fallback)` (longest-entry rule) used by both title functions and the T6 e2e locator computation.

**Failure modes:** CLI missing/not authed → helper counts `failed`, handler proceeds, Adjutant draft has zero cards + entry marked `failed` with founder-facing notification via the existing extraction-failure path (Case 2 integration). Extraction slow → capped at 25 serial entries; controller commit path is background. Concurrent founder review → entries with existing items never touched. In-txn call site → never extracts (guarded by placement, not runtime check — noted in T4d).

**NOT in scope:** phase=done extraction trigger; Settings extraction-trigger preference (D16/W6); reprocess-semantics changes; W2's dead-code sweep items listed in the design doc's separate cleanup bullet (debrief path, Scribe-drain surface — tracked there); fake-extraction harness for e2e (the human-path derived fallback keeps existing e2e viable); **human create-draft button → "Ask Adjutant to scope" unification (D17 end-state — queued after the fake-crew harness, NOT built in W2)**.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 3 issues, all resolved into the plan; 0 critical gaps |
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — (design doc D1-D17 already locks product scope) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — (no new UI; zero-item empty states already exist) |
| Outside Voice | `/codex` | Independent 2nd opinion | 0 | — (deferred to Codex's PR review — proven adversarial loop on #265/#267) |

**Step 0 (scope):** >8-file gate tripped mechanically (11 files) — user accepted as-is (D1): 5 source files, 6 test files; splitting would decouple the coupled stub-kill/extract-first pair.

**Findings (all user-decided + folded in):**
- **D2 (P2, arch)** — no wall-clock bound on the serial CLI pass; a hung-but-installed CLI = up to ~50 min silent controller-pipeline stall. → `EXTRACT_SCOPE_DEADLINE_MS = 180_000` + `deadlineHit` return + injectable clock + unit case (f). User approved after UX walkthrough.
- **D3 (P2, quality/product)** — derived fallback title from the FIRST entry lets greetings become task titles; user's direction: titles must be agent-authored. → Interim: longest-entry heuristic (greetings can't win). End-state LOCKED as design decision **D17**: human create-draft button becomes "Ask Adjutant to scope" (async crew run), sequenced after the fake-crew-harness follow-up. NOT built in W2.
- **Test gaps (direct adds)** — memory-candidate-still-emits-under-suppress compiler case (pins the derived-vs-fake distinction); deadline unit case (f).

**Failure modes:** hung CLI → deadline (D2, tested); CLI missing/not-authed → fast-fail classification + founder notification (integration Case 2); concurrent scoping → atomic pending→processing claim (existing); founder mid-review items → never touched (conservative selection, unit case (a)); in-txn call site → never extracts (placement-guarded, noted T4d). No silent failures — deadline + truncation both logged.

**Parallelization:** Sequential implementation — Tasks 1→2→4 share the compiler/scope-versions/handler chain; T3 could run parallel to T1-2 but shares T4's integration point. No worktree split warranted.

**UNRESOLVED:** 0.

**VERDICT: ENG REVIEW CLEAR — ready to implement.** Branch `feat/w2-extract-then-scope` off main (`9e6f9be3e`).
