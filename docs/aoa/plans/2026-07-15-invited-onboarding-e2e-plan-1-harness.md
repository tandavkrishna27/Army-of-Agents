# Plan 1 — Founder E2E Coverage + Reset Harness (Workstream 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Spec:** `docs/aoa/plans/2026-07-15-invited-onboarding-e2e-design.md` (Workstream 1).
> **Worktree/branch:** `feat/invited-onboarding-e2e`.

**Goal:** Give the already-merged founder onboarding flow automated end-to-end coverage (happy-path + resume-after-abandon), with a test-only reset so specs are isolated.

**Architecture:** The founder flow runs faithfully as the existing `local-board` synthetic admin (the suite already sets `AOA_DEV_LOCAL_IDENTITY=1`), so no per-user identity is needed here — that arrives in Plan 2 for the invited cross-user flow. We add one test-only route to clear a user's `onboarding_progress` between specs, then two Playwright specs driving the real step UI. Windows e2e skip is untouched; specs are CI/Linux (or `AOA_E2E_FORCE_WINDOWS=1` locally).

**Tech Stack:** Playwright, Express 5, Drizzle (Postgres), Vitest, `pnpm`.

---

## File Structure

- Create: `server/src/routes/test-support.ts` — test-only routes (gated); here: `DELETE /api/test/onboarding-progress`.
- Modify: `server/src/app.ts` — mount `testSupportRoutes(db)` only when the test flag is on.
- Create: `server/src/__tests__/test-support-route.test.ts` — route gating + behavior.
- Create: `tests/e2e/helpers/onboarding-e2e.ts` — `resetOnboarding(request)` + small step helpers.
- Create: `tests/e2e/onboarding-founder-happy-path.spec.ts`.
- Create: `tests/e2e/onboarding-resume.spec.ts`.
- Reference (do not modify): `tests/e2e/playwright.config.ts` (already sets `AOA_DEV_LOCAL_IDENTITY=1`, fake-claude/codex fixtures, a writable temp home).

> **Gating flag:** reuse the existing e2e signal. The webServer sets `AOA_DEV_LOCAL_IDENTITY=1`; test-support routes mount only when `process.env.AOA_DEV_LOCAL_IDENTITY === "1"` AND `config.deploymentMode === "local_trusted"` (fail-closed — never in `authenticated`).

---

## Task 1: Test-only reset route (`DELETE /api/test/onboarding-progress`)

**Files:**
- Create: `server/src/routes/test-support.ts`
- Modify: `server/src/app.ts` (mount, gated)
- Test: `server/src/__tests__/test-support-route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/__tests__/test-support-route.test.ts
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzleOperatorStubs, makeTableProxy } from "./helpers/drizzle-mock.js";

vi.mock("drizzle-orm", () => drizzleOperatorStubs());
vi.mock("@armyofagents/db", () => ({ onboardingProgress: makeTableProxy("onboarding_progress") }));

import { testSupportRoutes } from "../routes/test-support.js";

function makeApp(db: unknown, actor: Record<string, unknown> = { type: "board", userId: "local-board" }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as { actor: unknown }).actor = actor as never;
    next();
  });
  app.use("/api", testSupportRoutes(db as never));
  return app;
}

describe("DELETE /api/test/onboarding-progress", () => {
  let deleted: unknown[];
  beforeEach(() => {
    deleted = [];
  });
  const db = () =>
    ({ delete: () => ({ where: async (w: unknown) => { deleted.push(w); } }) }) as never;

  it("401 for a non-board actor", async () => {
    const res = await request(makeApp(db(), { type: "none" })).delete("/api/test/onboarding-progress");
    expect(res.status).toBe(401);
  });

  it("clears the actor's onboarding_progress rows and returns ok", async () => {
    const app = makeApp(db());
    const res = await request(app).delete("/api/test/onboarding-progress");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deleted).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm test:run src/__tests__/test-support-route.test.ts`
Expected: FAIL — `../routes/test-support.js` does not exist.

- [ ] **Step 3: Implement the route**

```ts
// server/src/routes/test-support.ts
import { Router, type Request, type Response } from "express";
import type { Db } from "@armyofagents/db";
import { onboardingProgress } from "@armyofagents/db";
import { eq } from "drizzle-orm";

/**
 * Test-only routes for e2e isolation. MOUNTED ONLY in local_trusted + the e2e
 * escape hatch (see app.ts) — never in authenticated mode. Each route is
 * self-scoped to req.actor (a spec can only reset its own state).
 */
export function testSupportRoutes(db: Db): Router {
  const router = Router();

  // Clear the acting user's onboarding_progress (user + org layers) so the next
  // spec starts clean.
  router.delete("/test/onboarding-progress", async (req: Request, res: Response) => {
    const actor = req.actor;
    if (actor.type !== "board" || !actor.userId) {
      res.status(401).json({ error: "authentication required" });
      return;
    }
    await db.delete(onboardingProgress).where(eq(onboardingProgress.userId, actor.userId));
    res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm test:run src/__tests__/test-support-route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Mount the route in `app.ts`, gated**

Find where the other onboarding routers are mounted (search `app.use("/api", onboardingRoutes(db))`). Add the import near the other route imports:

```ts
import { testSupportRoutes } from "./routes/test-support.js";
```

And mount it immediately after `onboardingRoutes`, gated:

```ts
  app.use("/api", onboardingRoutes(db));
  // Test-only e2e support — fail-closed: never in authenticated mode.
  if (config.deploymentMode === "local_trusted" && process.env.AOA_DEV_LOCAL_IDENTITY === "1") {
    app.use("/api", testSupportRoutes(db));
  }
```

> Confirm `config` is in scope at the mount site (it is — the app factory receives it). If the local name differs, use the in-scope config variable.

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @armyofagents/server typecheck`
Expected: clean.

```bash
git add server/src/routes/test-support.ts server/src/app.ts server/src/__tests__/test-support-route.test.ts
git commit -m "test(e2e): gated test-only onboarding-progress reset route"
```

---

## Task 2: E2E helper — `resetOnboarding` + step helpers

**Files:**
- Create: `tests/e2e/helpers/onboarding-e2e.ts`

(No unit test — this is test infrastructure, exercised by the specs in Tasks 3–4.)

- [ ] **Step 1: Write the helper**

```ts
// tests/e2e/helpers/onboarding-e2e.ts
import type { APIRequestContext, Page } from "@playwright/test";

/** Clear the local-board user's onboarding progress so a spec starts clean. */
export async function resetOnboarding(request: APIRequestContext): Promise<void> {
  const res = await request.delete("/api/test/onboarding-progress");
  if (!res.ok()) {
    throw new Error(`resetOnboarding failed: ${res.status()} ${await res.text().catch(() => "")}`);
  }
}

/**
 * Click a step's primary "continue" control and wait for the next heading.
 * `nextHeading` is a case-insensitive RegExp for the heading that should appear.
 */
export async function advanceStep(
  page: Page,
  buttonName: RegExp,
  nextHeading: RegExp,
): Promise<void> {
  await page.getByRole("button", { name: buttonName }).click();
  await page.getByRole("heading", { name: nextHeading }).waitFor({ state: "visible", timeout: 15_000 });
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/helpers/onboarding-e2e.ts
git commit -m "test(e2e): onboarding reset + step-advance helpers"
```

---

## Task 3: Founder happy-path spec

Drives the full founder flow as the local-board admin: profile → org → environment → commander → verify → department → agent → review. Uses the fake-claude fixture (already on PATH) so Commander verify passes, and the temp writable home for the environment root.

**Files:**
- Create: `tests/e2e/onboarding-founder-happy-path.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
// tests/e2e/onboarding-founder-happy-path.spec.ts
import { test, expect } from "@playwright/test";
import { resetOnboarding } from "./helpers/onboarding-e2e";
import { cleanupTestCompanies } from "./helpers/seed-company";

test.beforeEach(async ({ request }) => {
  await cleanupTestCompanies(request);
  await resetOnboarding(request);
});

test("founder completes profile → org → environment → commander → verify → department → agent → review", async ({
  page,
}) => {
  await page.goto("/onboarding");

  // Profile
  await expect(page.getByRole("heading", { name: /your profile/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("textbox").first().fill("E2E Founder");
  await page.getByRole("button", { name: /continue/i }).click();

  // Organization
  await expect(page.getByRole("heading", { name: /create your organization/i })).toBeVisible();
  await page.getByRole("textbox").first().fill(`E2E-Test-Org-${Date.now()}`);
  await page.getByRole("button", { name: /continue/i }).click();

  // Environment — the prefilled ~/AoA path under the temp home is writable.
  await expect(page.getByRole("heading", { name: /set up your environment/i })).toBeVisible();
  await page.getByRole("button", { name: /verify & continue/i }).click();

  // Commander — pick Claude (fake-claude fixture verifies).
  await expect(page.getByRole("heading", { name: /choose your commander/i })).toBeVisible();
  await page.getByText("Claude", { exact: true }).click();
  await page.getByRole("button", { name: /continue/i }).click();

  // Verify tooling — fake-claude reports installed + authed → verified.
  await expect(page.getByRole("heading", { name: /verify your tooling/i })).toBeVisible();
  await page.getByRole("button", { name: /^verify$/i }).click();

  // Department
  await expect(page.getByRole("heading", { name: /create your first department/i })).toBeVisible({
    timeout: 20_000,
  });
  // The name is prefilled "Engineering"; the local-folder path prefills ASYNC
  // (loads the company root first). Wait for it before clicking, or the create
  // throws "Local folder must be an absolute path" (Codex P1 #10).
  await expect(page.getByDisplayValue(/[\\/]engineering$/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /create department/i }).click();

  // Agent
  await expect(page.getByRole("heading", { name: /create your first agent/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /create & assign/i }).click();

  // Review (terminal)
  await expect(page.getByRole("heading", { name: /you're set up/i })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /go to dashboard/i }).click();

  // Landed in the app (a company-prefixed home).
  await expect(page).toHaveURL(/\/[A-Z0-9]+\/home/i, { timeout: 15_000 });
});
```

- [ ] **Step 2: Run the spec, verify it passes**

Run (Linux/CI, or locally with `AOA_E2E_FORCE_WINDOWS=1` + a `DATABASE_URL`):
`pnpm test:e2e onboarding-founder-happy-path`
Expected: PASS. If a step heading selector differs from the rendered markup, adjust the RegExp to match the real `<h1>` (headings authored in `ui/src/onboarding/steps/*Step.tsx`).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/onboarding-founder-happy-path.spec.ts
git commit -m "test(e2e): founder onboarding happy path"
```

---

## Task 4: Resume-after-abandon spec

**Files:**
- Create: `tests/e2e/onboarding-resume.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
// tests/e2e/onboarding-resume.spec.ts
import { test, expect } from "@playwright/test";
import { resetOnboarding } from "./helpers/onboarding-e2e";
import { cleanupTestCompanies } from "./helpers/seed-company";

test.beforeEach(async ({ request }) => {
  await cleanupTestCompanies(request);
  await resetOnboarding(request);
});

test("leaving after the profile step and returning resumes at the org step (not profile)", async ({ page }) => {
  await page.goto("/onboarding");

  // Complete PROFILE_SET.
  await expect(page.getByRole("heading", { name: /your profile/i })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("textbox").first().fill("Resumer");
  await page.getByRole("button", { name: /continue/i }).click();
  await expect(page.getByRole("heading", { name: /create your organization/i })).toBeVisible();

  // Abandon, then return.
  await page.goto("/");
  await page.goto("/onboarding");

  // Resumes at the org step — profile is NOT shown again.
  await expect(page.getByRole("heading", { name: /create your organization/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole("heading", { name: /your profile/i })).toHaveCount(0);
});
```

- [ ] **Step 2: Run the spec, verify it passes**

Run: `pnpm test:e2e onboarding-resume`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/onboarding-resume.spec.ts
git commit -m "test(e2e): onboarding resume-after-abandon"
```

---

## Task 5: Wire the specs into the suite + confirm Windows skip

**Files:**
- Reference: `tests/e2e/playwright.config.ts`, `tests/e2e/onboarding.spec.ts`

- [ ] **Step 1: Check whether `onboarding.spec.ts` is a stale skip to remove**

Run: `grep -n "test.skip\|test.describe" tests/e2e/onboarding.spec.ts`
If it is a `test.skip` placeholder superseded by Tasks 3–4, delete the file; if it holds distinct coverage, leave it. Decide based on its contents.

- [ ] **Step 2: Confirm the two new specs are picked up + Windows still skips**

Run: `grep -n "testMatch\|windows-embedded-postgres-skip\|WINDOWS_WITH_EMBEDDED_POSTGRES" tests/e2e/playwright.config.ts`
Expected: the new specs match the default glob; Windows-without-DATABASE_URL still routes to the skip spec (no change needed). Do NOT add a `branches:`/`paths` filter.

- [ ] **Step 3: Commit any cleanup**

```bash
git add -A
git commit -m "test(e2e): tidy onboarding spec suite"
```

---

## Task 6: Visual flow capture + regression baseline (founder)

Capture every founder step as a screenshot artifact, and pin a visual-regression baseline for the stable terminal screen. This is the "flow taken and tested visually" layer.

**Files:**
- Create: `tests/e2e/onboarding-founder-visual.spec.ts`

- [ ] **Step 1: Write the visual spec**

```ts
// tests/e2e/onboarding-founder-visual.spec.ts
import { test, expect } from "@playwright/test";
import { resetOnboarding } from "./helpers/onboarding-e2e";
import { cleanupTestCompanies } from "./helpers/seed-company";

test.beforeEach(async ({ request }) => {
  await cleanupTestCompanies(request);
  await resetOnboarding(request);
});

test("captures each founder onboarding step + pins the review screen baseline", async ({ page }) => {
  const shot = (name: string) =>
    page.screenshot({ path: `test-results/onboarding/founder-${name}.png`, fullPage: true });

  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: /your profile/i })).toBeVisible({ timeout: 15_000 });
  await shot("01-profile");
  await page.getByRole("textbox").first().fill("Visual Founder");
  await page.getByRole("button", { name: /continue/i }).click();

  await expect(page.getByRole("heading", { name: /create your organization/i })).toBeVisible();
  await shot("02-org");
  await page.getByRole("textbox").first().fill(`E2E-Test-Vis-${Date.now()}`);
  await page.getByRole("button", { name: /continue/i }).click();

  await expect(page.getByRole("heading", { name: /set up your environment/i })).toBeVisible();
  await shot("03-environment");
  await page.getByRole("button", { name: /verify & continue/i }).click();

  await expect(page.getByRole("heading", { name: /choose your commander/i })).toBeVisible();
  await shot("04-commander");
  await page.getByText("Claude", { exact: true }).click();
  await page.getByRole("button", { name: /continue/i }).click();

  await expect(page.getByRole("heading", { name: /verify your tooling/i })).toBeVisible();
  await shot("05-verify");
  await page.getByRole("button", { name: /^verify$/i }).click();

  await expect(page.getByRole("heading", { name: /create your first department/i })).toBeVisible({ timeout: 20_000 });
  await shot("06-department");
  // Wait for the async local-folder prefill before creating (Codex P1 #10).
  await expect(page.getByDisplayValue(/[\\/]engineering$/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /create department/i }).click();

  await expect(page.getByRole("heading", { name: /create your first agent/i })).toBeVisible({ timeout: 20_000 });
  await shot("07-agent");
  await page.getByRole("button", { name: /create & assign/i }).click();

  await expect(page.getByRole("heading", { name: /you're set up/i })).toBeVisible({ timeout: 20_000 });
  await shot("08-review");

  // Visual-regression baseline for the stable review screen. Mask the summary
  // rows (org/dept/agent names + generated ids vary run to run).
  await expect(page).toHaveScreenshot("founder-review.png", {
    maxDiffPixelRatio: 0.02,
    mask: [page.locator("[data-testid='review-summary']")],
  });
});
```

- [ ] **Step 2: Add a stable hook for the masked region**

In `ui/src/onboarding/steps/ReviewStep.tsx`, add `data-testid="review-summary"` to the summary container `<div>` (the one wrapping the org/environment/commander/department/agent rows) so the visual mask can target it.

- [ ] **Step 3: Generate the baseline, then run to verify**

Run (first time, to write the baseline): `pnpm test:e2e onboarding-founder-visual --update-snapshots`
Then re-run to confirm it matches: `pnpm test:e2e onboarding-founder-visual`
Expected: PASS; a `founder-review.png` baseline is written under the spec's snapshot dir and step screenshots land in `test-results/onboarding/`.

- [ ] **Step 4: Commit (including the committed baseline)**

```bash
git add tests/e2e/onboarding-founder-visual.spec.ts ui/src/onboarding/steps/ReviewStep.tsx tests/e2e/onboarding-founder-visual.spec.ts-snapshots
git commit -m "test(e2e): founder onboarding visual flow capture + review baseline"
```

> **Note (baselines are OS-specific):** Playwright snapshots differ across OS/browser. Generate baselines on the SAME platform CI uses (Linux). If baselines are generated on Windows locally, do NOT commit them as the CI baseline — let CI generate/verify, or scope the visual assertion to `test.skip(process.platform !== 'linux')`. Step screenshots (Step 1's `page.screenshot`) are artifacts, not assertions, so they're safe everywhere.

---

## Codex-review deltas

- **P1 #10 department race — APPLIED in the snippets above** (Tasks 3 & 6): wait for the async local-folder prefill (`getByDisplayValue(/…engineering$/)`) before clicking Create. (Confirmed live: the path prefills only after the company-root fetch.)
- **P2 #12 strict cleanup + progress assertions — APPLY DURING EXECUTION** (not yet in the snippets): make `beforeEach` strict — after `cleanupTestCompanies` + `resetOnboarding`, assert **zero** `E2E-`-prefixed companies remain (`GET /api/companies`) before starting, so a stale company can't be reused instead of proving org-creation. After the happy path, assert both progress layers via `GET /api/onboarding/progress`: user layer (`companyId` omitted) contains `PROFILE_SET`; the new company layer contains the founder sequence through `SETUP_COMPLETE`.
- **P2 #13 first-user honesty:** this fast e2e runs as the `local-board` escape-hatch admin — it does NOT cover "first Google user → admin (RB3)". Do not claim it does; RB3 stays a separate authenticated/live test.
- **P2 #14 visual baseline scope:** Plan 1 pins only the review baseline; the full per-screen baseline set (profile/org/environment/verify/review) lands with WS2's visual pass, generated on the pinned Linux/Chromium CI image (never `--update-snapshots` in CI).
- **P2 #15 fake-CLI:** when this runs in CI (fake-claude/codex, not the real authed CLIs used in the live walkthrough), script the fake response to emit `hello` so the verify assertion is genuine (its default `Done` only passes via the generic-warn-as-verified path).

## Self-review notes

- **Spec coverage (WS1):** injectGoogleSession is intentionally deferred to Plan 2 (per-user identity is only needed for the invited cross-user flow); WS1's founder specs run under the existing `local-board` escape hatch. Founder happy-path (Task 3) + resume (Task 4) cover the two WS1 specs. The reset route (Task 1) provides the "progress reset between runs" the spec calls for.
- **Gating:** the test-support route is fail-closed (local_trusted + `AOA_DEV_LOCAL_IDENTITY=1` only), so it can never expose a reset in a hosted deployment.
- **Selectors:** headings/buttons match the authored step components (`*Step.tsx`); if the live markup differs, adjust the RegExp (Task 3 Step 2 notes this).
