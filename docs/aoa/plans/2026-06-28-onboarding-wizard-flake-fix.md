# Onboarding-Wizard E2E Flake Fix — Implementation Plan

> **For agentic workers:** test-only change. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the intermittent 10s timeout on the lobby "Create organization" button in the onboarding-wizard e2e flow, and de-duplicate the wizard-driving code that exists in three specs.

**Architecture:** The flake is a **test-timeout-too-tight artifact, not a product bug**. Measured evidence (2026-06-28): pure server-side `GET /companies` is fast (38–706 ms), but the lobby "Create organization" button is gated behind the full client app-load, and the e2e webServer serves the UI via `vite-dev-middleware`. The first wizard-driven test in a run therefore pays a one-time on-demand module compile + server warmup (~7.8 s observed cold on a fast unloaded machine) before the lobby paints — perilously close to the 10 s `toBeVisible` budget, so a slower/loaded CI runner tips over. Fix: lift the single cold-path wait to 30 s, and centralize the duplicated wizard code into two shared helpers so the budget lives in exactly one place.

**Tech Stack:** Playwright, TypeScript, existing `tests/e2e/helpers/` convention.

---

## File Structure

- `tests/e2e/helpers/seed-company.ts` — **Modify.** Add two exported helpers:
  - `openOnboardingWizard(page)` — `goto("/")` + click the lobby "Create organization" button with the **30 s** cold-path budget. The single source of the cold-path timeout. Used by all three specs.
  - `seedCompanyViaWizard(page, request, opts?)` — calls `openOnboardingWizard`, drives Steps 1–4 (the step that POSTs `/companies`), waits for the Step 5 heading, resolves the created company from `/api/companies`, returns `{ companyId, issuePrefix, companyName }`. Used by the two specs that need a created company.
- `tests/e2e/provider-switching.spec.ts` — **Modify.** Delete the local `seedCompanyViaWizard` (lines ~25–107); import the shared one; pass `{ companyName: \`E2E-PS-${Date.now()}\` }` to preserve the `E2E-PS-` prefix that `beforeEach` cleanup expects.
- `tests/e2e/onboarding-thread-pipeline.spec.ts` — **Modify.** Replace the inlined Steps 1–4 + API resolution (lines ~40–109) with a call to the shared `seedCompanyViaWizard`, passing `{ companyName: \`E2E-Onboard-${Date.now()}\` }`. Keep the thread-pipeline assertions.
- `tests/e2e/onboarding.spec.ts` — **Modify.** Replace the goto + lobby-button click (lines ~49–56) with `openOnboardingWizard(page)`. Keep the Step 1 → Step 2 assertions.

No product code changes. No new test cases — behavior-preserving refactor + one timeout bump.

---

## Task 1: Add shared wizard helpers

**Files:**
- Modify: `tests/e2e/helpers/seed-company.ts`

- [ ] **Step 1: Add imports + `openOnboardingWizard` + `seedCompanyViaWizard`**

Add `Page` + `expect` to the import, and append the two helpers. The 30 s budget on the lobby button is the fix; per-step headings stay at 10 s (only the first lobby wait pays the cold compile — once the bundle is compiled, step transitions are warm, measured 1–2.4 s).

```ts
import { expect, type APIRequestContext, type Page } from "@playwright/test";

// ... existing seedCompany / cleanupTestCompanies ...

/**
 * Open the OnboardingWizard from the lobby empty state.
 *
 * This is the cold-path interaction of the whole e2e suite: the webServer
 * serves the UI via vite-dev-middleware, so the FIRST test to visit the lobby
 * pays a one-time on-demand module compile + server warmup (~7.8s observed cold
 * on a fast unloaded machine) before the "Create organization" button paints.
 * The button itself is gated behind the companies query (Lobby.tsx) which is
 * fast (GET /companies measured 38-706ms) — the latency is app-load, not the
 * query. Budget 30s so a slow/loaded CI runner doesn't time out before paint.
 * Per-test timeout is 60s (playwright.config.ts), so 30s here is safe.
 */
export async function openOnboardingWizard(page: Page): Promise<void> {
  await page.goto("/");
  const createCompanyButton = page.getByRole("button", {
    name: /^create organization$/i,
  });
  await expect(createCompanyButton).toBeVisible({ timeout: 30_000 });
  await createCompanyButton.click();
}

/**
 * Drive the OnboardingWizard through Step 4 (the step that POSTs /companies),
 * then resolve the created company's { id, issuePrefix } from /api/companies.
 *
 * Step 5 needs a real local adapter CLI to advance, so specs that need a
 * created company bail out of the wizard after Step 4 and continue via the API
 * or by navigating directly.
 */
export async function seedCompanyViaWizard(
  page: Page,
  request: APIRequestContext,
  opts: { companyName?: string } = {},
): Promise<{ companyId: string; issuePrefix: string; companyName: string }> {
  const companyName = opts.companyName ?? `E2E-Wizard-${Date.now()}`;

  await openOnboardingWizard(page);

  // ── Step 1: company name ──
  await expect(
    page.locator("h3", { hasText: "Name your company" }),
  ).toBeVisible({ timeout: 10_000 });
  await page.locator('input[placeholder="Acme Corp"]').fill(companyName);
  await page.getByTestId("step1-next").click();

  // ── Step 2: workspace root (accept the auto-suggested path; fall back) ──
  await expect(
    page.locator("h3", { hasText: "Set up workspace root" }),
  ).toBeVisible({ timeout: 10_000 });
  const rootInput = page.locator(
    'input[placeholder="/path/to/company/workspace"]',
  );
  await expect(rootInput).toBeVisible({ timeout: 5_000 });
  if ((await rootInput.inputValue()).trim() === "") {
    await rootInput.fill("/tmp/aoa-e2e-wizard");
  }
  await page.getByTestId("step2-next").click();

  // ── Step 3: Commander pick ──
  await expect(
    page.locator("h3", { hasText: "Choose your Commander" }),
  ).toBeVisible({ timeout: 10_000 });
  await page
    .getByTestId("commander-provider")
    .selectOption({ value: "anthropic" });
  await page.getByTestId("commander-model").fill("claude-sonnet-4-6");
  await page.getByTestId("step3-next").click();

  // ── Step 4: Crew pick (this is the step that POSTs /companies) ──
  await expect(
    page.locator("h3", { hasText: "Choose your Crew" }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("crew-provider").selectOption({ value: "openai" });
  await page.getByTestId("crew-model").fill("gpt-5.5");
  await page.getByTestId("step4-next").click();

  // ── Wait for the company to land — Step 5 heading is the signal ──
  await expect(
    page.locator("h3", { hasText: "Create your first agent" }),
  ).toBeVisible({ timeout: 15_000 });

  // ── Resolve the created company from the API ──
  const companiesRes = await request.get("/api/companies");
  expect(companiesRes.ok()).toBe(true);
  const companies = (await companiesRes.json()) as Array<{
    id: string;
    name: string;
    issuePrefix: string;
  }>;
  const company = companies.find((c) => c.name === companyName);
  expect(company).toBeTruthy();
  expect(company?.id).toBeTruthy();
  expect(company?.issuePrefix).toBeTruthy();

  return {
    companyId: company!.id,
    issuePrefix: company!.issuePrefix,
    companyName,
  };
}
```

- [ ] **Step 2: typecheck the helpers compile** — `pnpm -C tests/e2e exec tsc --noEmit` is not configured; rely on the playwright run + repo typecheck in Task 5.

---

## Task 2: Point provider-switching.spec.ts at the shared helper

**Files:**
- Modify: `tests/e2e/provider-switching.spec.ts`

- [ ] **Step 1: Replace the local helper with an import.** Delete the local `seedCompanyViaWizard` function (and its leading doc-comment block). Update the import line:

```ts
import { cleanupTestCompanies, seedCompanyViaWizard } from "./helpers/seed-company";
```

- [ ] **Step 2: Preserve the E2E-PS- prefix at the 5 call sites.** Each `seedCompanyViaWizard(page, request)` becomes:

```ts
const { companyId, issuePrefix } = await seedCompanyViaWizard(page, request, {
  companyName: `E2E-PS-${Date.now()}`,
});
```

(`beforeEach` runs `cleanupTestCompanies(request, /^E2E-PS-/)` — the prefix must stay `E2E-PS-`.)

---

## Task 3: De-inline onboarding-thread-pipeline.spec.ts

**Files:**
- Modify: `tests/e2e/onboarding-thread-pipeline.spec.ts`

- [ ] **Step 1: Import the shared helper:**

```ts
import { cleanupTestCompanies, seedCompanyViaWizard } from "./helpers/seed-company";
```

- [ ] **Step 2: Replace the inlined Steps 1–4 + API resolution** (the block from `const companyName = ...` through the `expect(company?.issuePrefix).toBeTruthy();` sanity check) with:

```ts
const { issuePrefix } = await seedCompanyViaWizard(page, request, {
  companyName: `E2E-Onboard-${Date.now()}`,
});
```

Then update the subsequent navigation to use `issuePrefix` directly (was `company!.issuePrefix`):

```ts
await page.goto(`/${issuePrefix}/discussions`);
```

Keep everything from the discussions-list assertion onward unchanged.

---

## Task 4: Use openOnboardingWizard in onboarding.spec.ts

**Files:**
- Modify: `tests/e2e/onboarding.spec.ts`

- [ ] **Step 1: Import the helper:**

```ts
import { openOnboardingWizard } from "./helpers/seed-company";
```

- [ ] **Step 2: Replace the goto + lobby-button block** (lines ~49–56) with:

```ts
await openOnboardingWizard(page);
```

Keep the Step 1 heading + name-fill + "Next" + Step 2 heading assertions unchanged.

---

## Task 5: Verify

- [ ] **Step 1: Repo typecheck** — `pnpm typecheck` → 0 errors.
- [ ] **Step 2: Flake-detect the previously-flaky onboarding flow.** With Postgres + a dedicated port, run the three touched specs with `--repeat-each=10`:

```
DATABASE_URL=postgres://postgres:postgres@localhost:55437/aoa AOA_E2E_PORT=33xx \
  pnpm exec playwright test --config=tests/e2e/playwright.config.ts \
  tests/e2e/onboarding.spec.ts tests/e2e/onboarding-thread-pipeline.spec.ts \
  tests/e2e/provider-switching.spec.ts --repeat-each=10 --workers=1 --reporter=list
```

Expected: all green, no 10s lobby-button timeouts.

- [ ] **Step 3: Commit + push + open PR off main.** Branch `test/onboarding-wizard-flake-fix`. Track CI to green.

---

## Self-Review

- **Spec coverage:** the flake (lobby-button 10s timeout) → fixed by the 30s budget in `openOnboardingWizard`. The de-dupe ask → three specs now share two helpers. ✓
- **Behavior preservation:** company-name prefixes preserved per-spec via `opts.companyName` so each `beforeEach` cleanup regex still matches. The only behavioral change is the lobby-button timeout (10s→30s) and the Step-2 fallback path string (`/tmp/aoa-e2e-ps`/`/tmp/aoa-e2e-onboard` → `/tmp/aoa-e2e-wizard`) — a fallback only used when the auto-suggested path is empty; value is irrelevant to assertions. ✓
- **Type consistency:** `seedCompanyViaWizard` signature `(page, request, opts?)` and return `{ companyId, issuePrefix, companyName }` consistent across all call sites. ✓
