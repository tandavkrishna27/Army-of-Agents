import { test, expect } from "@playwright/test";
import {
  freshOnboardingState,
  fillFounderProfileStep,
  fillOrganizationStep,
} from "./helpers/onboarding-e2e";

// Selectors below were validated against the live app during Plan-1 planning
// (the full founder flow was driven end-to-end in a browser).
test.beforeEach(async ({ request }) => {
  await freshOnboardingState(request);
});

test("founder completes the spine → Map fork → in-flight tail → lands in the app", async ({
  page,
  request,
}) => {
  // Force a clean "verified" outcome so the happy path exercises the full flow
  // past the spine. The verify probe itself (needs_auth, key paste, interactive
  // login) is covered exhaustively by onboarding-commander-auth.spec.ts; the
  // fake-claude fixture returns a non-"hello" probe by default, which the server
  // classifies as needs_auth on every platform.
  await page.route("**/internal-agent/verify", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ outcome: "verified", result: { status: "pass" } }),
    }),
  );

  await page.goto("/onboarding");

  // Profile — founders get the full Human Operating Profile step (Name +
  // Title + Timezone required; the bare name-only step was retired).
  await fillFounderProfileStep(page, "E2E Founder");
  await page.getByRole("button", { name: /continue/i }).click();

  // Organization — the Phase-2 multi-tenant tenant step ("Your organization"),
  // inserted before the company step. Creates the Organization that owns the
  // company created next.
  await fillOrganizationStep(page, `E2E-Test-OrgTenant-${Date.now()}`);

  // Company — heading is now "Your company" (redesign).
  const orgName = `E2E-Test-Org-${Date.now()}`;
  await expect(page.getByRole("heading", { name: /your company/i })).toBeVisible();
  await page.getByLabel("Company name").fill(orgName);
  await page.getByRole("button", { name: /continue/i }).click();

  // Environment — the prefilled ~/AoA path under the temp home is writable.
  await expect(page.getByRole("heading", { name: /set up your environment/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /verify & continue/i }).click();

  // Commander — heading is now "Bring your engine online"; pick Claude
  // (fake-claude fixture verifies in CI).
  await expect(page.getByRole("heading", { name: /bring your engine online/i })).toBeVisible();
  await page.getByText("Claude", { exact: true }).click();
  await page.getByRole("button", { name: /continue/i }).click();

  // Verify tooling
  await expect(page.getByRole("heading", { name: /verify your tooling/i })).toBeVisible();
  await page.getByRole("button", { name: /^verify$/i }).click();

  // Spine complete auto-advances (SpineCompleteStep) into Home's first-run:
  // the Map fork. Department/Agent/Review are no longer wizard steps — they
  // live in the in-flight tail behind the "Bring a project in motion" door.
  await expect(page.getByRole("heading", { name: /where are you starting from/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /bring a project in motion/i }).click();

  // In-flight surface 1 — Departments ("Shape your departments"). The default
  // "Software" row prefills its local folder async; wait for it before Continue
  // or create throws "Local folder must be an absolute path".
  await expect(page.getByRole("heading", { name: /shape your departments/i })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByLabel(/local folder path for software/i)).toHaveValue(/[\\/]software$/i, {
    timeout: 15_000,
  });
  await page.getByRole("button", { name: /^continue$/i }).click();

  // Surface 2 — Integrations ("Connect your codebase"). Optional; skip.
  await expect(page.getByRole("heading", { name: /connect your codebase/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /skip for now/i }).click();

  // Surface 3 — Braindump ("Braindump what you know"). Optional; skip.
  await expect(page.getByRole("heading", { name: /braindump what you know/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /skip for now/i }).click();

  // Surface 4 — Librarian ("Organizing…" → "Your domain memory is ready").
  await expect(
    page.getByRole("heading", { name: /organizing your knowledge|domain memory is ready/i }),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: /^continue$/i }).click();

  // Surface 5 — CreateAgents ("Staff your departments"). Optional; skip.
  await expect(page.getByRole("heading", { name: /staff your departments/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /skip for now/i }).click();

  // Surface 6 — FirstJob ("Give it a first job"). Skip straight to Home.
  await expect(page.getByRole("heading", { name: /give it a first job/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /skip to home/i }).click();

  // Landed in the app: since the Lobby redesign, "/" is the returning-user
  // Lobby (LobbyOrOnboardingRedirect) — the new organization must be listed.
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(orgName).first()).toBeVisible();

  // Progress assertion (Plan 1 P2 #12): the user layer records PROFILE_SET.
  const progress = await (await request.get("/api/onboarding/progress")).json();
  expect(progress?.progress?.completedStates ?? []).toContain("PROFILE_SET");
});
