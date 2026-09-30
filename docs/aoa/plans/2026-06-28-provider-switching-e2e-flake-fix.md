# Provider-switching e2e flake fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline). Steps use checkbox (`- [ ]`).

**Goal:** Eliminate the intermittent 60s timeout in `tests/e2e/provider-switching.spec.ts:179` ("saving codex gpt-5.3-codex surfaces a 'using gpt-5.5' warning") so it can't redden unrelated PRs' `e2e` lane.

**Architecture:** Confirm the mechanism live in a browser, then apply the smallest robust fix. Investigation root cause (high confidence, proximate): the flaky test clicks the model-picker **trigger** with no `toBeVisible` synchronization, unlike its passing sibling test (`:147`). After the "Permissions & config" rail click, the trigger lives in a section toggled visible via a `hidden` class (`AgentConfigForm.tsx:808`) inside react-resizable-panels; on a slow/loaded CI run there's a window where the trigger isn't actionable, and the un-gated bare `.click()` auto-waits against the whole 60s test budget instead of failing fast. Fix = gate the trigger click the way `:147` does (and confirm via live UI whether anything deeper — a genuine section/panel settle race — also needs addressing).

**Tech Stack:** Playwright e2e, React (AgentDetail/AgentConfigForm), react-resizable-panels, Postgres, gstack `/browse` for live UI.

**Branch:** `fix/provider-switching-e2e-flake` off `main` @ `9ae8b9a8b`, worktree `C:/Users/TK/.aoa/wt/ps-flake-fix`.

**Local run (Windows e2e needs DATABASE_URL → plain postgres, no pgvector):**
`DATABASE_URL=postgres://postgres:postgres@localhost:55435/aoa AOA_E2E_PORT=33xx pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/provider-switching.spec.ts --reporter=list`

---

## Evidence (from /investigate)

- Playwright call log pinned the hang to `:197` (model-picker trigger click): element resolved (closed Radix popover-trigger) → "waiting for element to be visible, enabled and stable" → 60s test-timeout.
- Passing run: 6.5s. Failing run: 60s. So it's a real ~53s actionability stall, not budget creep.
- Sibling `:147` does `const trigger = …; await expect(trigger).toBeVisible({timeout:10_000}); await trigger.click();` — `:179` omits the gate and clicks directly.
- `formSection` (`AgentDetail.tsx:969`) defaults to `"identity"`, changes only via the rail click (`selectNav`, no reset effect). Trigger's section is `hidden` unless `formSection==="permissions"`.

---

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `tests/e2e/provider-switching.spec.ts` | The flaky test (`:179`) — add the trigger visibility gate + assert the section switched, mirroring `:147` | **Modify** |
| `ui/src/pages/AgentDetail.tsx` / `ui/src/components/AgentConfigForm.tsx` | ONLY if live observation shows a genuine UI race (e.g., section never settles) — otherwise untouched | **Maybe** |

---

### Task 1: Live-UI observation (confirm the mechanism before changing code)

**Files:** none (read-only investigation on a running instance).

- [ ] **Step 1: Stand up a local_trusted instance** on the built worktree (plain postgres or embedded), create a company + a `codex_local` agent (model `gpt-5.5`), and open `/{prefix}/agents/{id}/configure`.
- [ ] **Step 2: Drive the user flow via gstack `/browse`** exactly as the test does: click "Permissions & config" → observe the model-picker trigger (`gpt-5.5`). Note: does the section switch instantly? Is the trigger immediately visible+stable, or is there a transition/panel reflow? Open the picker → search `gpt-5.3-codex` → select → Save → confirm the `using gpt-5.5` alert appears.
- [ ] **Step 3: Decide fix depth.** If the trigger is reliably actionable once the section is selected (so the flake is purely the missing test-side gate) → Task 2 only. If the live UI shows a genuine settle/animation race (trigger visibly jitters or the section briefly re-hides) → also do Task 3.

---

### Task 2: Gate the trigger click in the flaky test (mirror `:147`)

**Files:** Modify `tests/e2e/provider-switching.spec.ts` (the `:179` test body).

- [ ] **Step 1: Replace the bare section+trigger clicks with a gated sequence.**

Current (`:190`–`:202`):
```ts
    await page
      .getByRole("button", { name: "Permissions & config" })
      .click();

    await page
      .getByRole("button", { name: "gpt-5.5", exact: true })
      .click();
    await page.getByPlaceholder("Search models...").fill("gpt-5.3-codex");
    await page
      .getByRole("button", { name: "gpt-5.3-codex", exact: true })
      .click();
```

New:
```ts
    await page
      .getByRole("button", { name: "Permissions & config" })
      .click();

    // Wait for the model-picker trigger to be actionable before clicking it.
    // The trigger lives in the "permissions" form section, which is revealed
    // (un-`hidden`ed) by the rail click above; without this gate a bare
    // .click() auto-waits against the whole 60s test budget if the section
    // hasn't rendered visible yet, surfacing as an opaque timeout flake.
    // (Mirrors the sibling test "codex model picker defaults to gpt-5.5".)
    const trigger = page.getByRole("button", { name: "gpt-5.5", exact: true });
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();

    await page.getByPlaceholder("Search models...").fill("gpt-5.3-codex");
    const codexOption = page.getByRole("button", {
      name: "gpt-5.3-codex",
      exact: true,
    });
    await expect(codexOption).toBeVisible({ timeout: 10_000 });
    await codexOption.click();
```

- [ ] **Step 2: Gate the Save click too** (the floating action bar appears only once dirty):
```ts
    const saveButton = page.getByRole("button", { name: "Save" });
    await expect(saveButton).toBeVisible({ timeout: 10_000 });
    await saveButton.click();
```

- [ ] **Step 3: Commit.**
```bash
git add tests/e2e/provider-switching.spec.ts
git commit -m "test(e2e): gate provider-switching model-picker clicks on visibility (fix :179 flake)"
```

---

### Task 3 (conditional): address a genuine UI settle race

Only if Task 1 Step 3 found a real UI race. Candidate fixes (pick per observation):
- Wait on a deterministic "section active" signal (e.g., the permissions panel container) rather than the trigger alone.
- If react-resizable-panels reflow causes instability, ensure the e2e disables CSS transitions (Playwright `reducedMotion: 'reduce'` in the config / a global stylesheet) so "stable" is reached immediately.

Document the chosen fix inline with a comment. Commit separately.

---

### Task 4: Local verification (the real proof)

- [ ] **Step 1: Spin a plain postgres (no pgvector needed for this spec):**
```bash
docker run -d --name aoa-ps-flake-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=aoa -p 55435:5432 postgres:16
```
- [ ] **Step 2: Run the spec 20× to confirm stability** (repeat-each catches timing flakes):
```bash
DATABASE_URL=postgres://postgres:postgres@localhost:55435/aoa AOA_E2E_PORT=3301 pnpm exec playwright test --config=tests/e2e/playwright.config.ts tests/e2e/provider-switching.spec.ts --repeat-each=20 --reporter=list
```
Expected: ALL iterations pass (esp. `:179`). Note total/worst-case duration per `:179` iteration (should stay ~6–10s, never approach 60s).
- [ ] **Step 3: Full e2e gate once** (no regressions from the change):
```bash
DATABASE_URL=postgres://postgres:postgres@localhost:55435/aoa AOA_E2E_PORT=3302 pnpm exec playwright test --config=tests/e2e/playwright.config.ts --reporter=line
```
- [ ] **Step 4: Live UI re-confirm** the full user flow once more via `/browse` (configure → Permissions & config → pick gpt-5.3-codex → Save → "using gpt-5.5" alert).

---

### Task 5: Ship

- [ ] Push branch; open PR off `main`; wait for CI green (incl. the `e2e` lane).
- [ ] Tear down: `docker rm -f aoa-ps-flake-pg`, any e2e dev-servers, worktree + branch.

---

## Self-Review

1. **Coverage:** mechanism confirmed live (T1), test gated (T2), deeper race handled if real (T3), proven via repeat-each + full gate + live (T4), shipped + cleaned (T5). ✓
2. **Placeholders:** none — exact code + commands. (T3 is intentionally conditional on T1's finding, with concrete candidate fixes.)
3. **Consistency:** locators (`gpt-5.5` trigger, `gpt-5.3-codex` option, `Save`) match the spec; `trigger`/`codexOption`/`saveButton` names consistent.
