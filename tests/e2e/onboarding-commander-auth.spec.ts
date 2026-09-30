import { test, expect, type Page } from "@playwright/test";
import {
  freshOnboardingState,
  fillFounderProfileStep,
  fillOrganizationStep,
} from "./helpers/onboarding-e2e";

/**
 * Track C visual + interaction coverage (Plan 3 / §6, Task 5).
 *
 * Drives VerifyStep through its `needs_auth` affordances via Playwright route
 * interception — the verify probe + commander-key/login endpoints are mocked so
 * each state is deterministic in CI WITHOUT a real `claude login` / `codex
 * login` device flow (that flow is dogfood-verified only; see the honesty note
 * in the Plan 3 doc). What CI asserts here: the needs_auth panel renders, the
 * API-key paste path re-verifies, and the interactive-login path surfaces the
 * verification URL and completes on poll.
 */

test.beforeEach(async ({ request }) => {
  await freshOnboardingState(request);
});

/** Walk profile → org → environment → commander(provider) → the Verify step. */
async function walkToVerify(page: Page, commander: "Claude" | "Codex"): Promise<void> {
  await page.goto("/onboarding");
  await fillFounderProfileStep(page, "Track C Founder");
  await expect(page.getByRole("button", { name: /continue/i })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: /continue/i }).click();

  // Organization (Phase-2 tenant step) precedes the company step.
  await fillOrganizationStep(page, `E2E-TrackC-Org-${Date.now()}`);

  await expect(page.getByRole("heading", { name: /your company/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByLabel("Company name").fill(`E2E-TrackC-${Date.now()}`);
  await expect(page.getByRole("button", { name: /continue/i })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: /continue/i }).click();

  await expect(page.getByRole("heading", { name: /set up your environment/i })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByRole("button", { name: /verify & continue/i })).toBeEnabled({
    timeout: 15_000,
  });
  await page.getByRole("button", { name: /verify & continue/i }).click();

  await expect(page.getByRole("heading", { name: /bring your engine online/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByText(commander, { exact: true }).click();
  await expect(page.getByRole("button", { name: /continue/i })).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("button", { name: /continue/i }).click();

  await expect(page.getByRole("heading", { name: /verify your tooling/i })).toBeVisible({
    timeout: 20_000,
  });
}

test("needs_auth → API-key paste re-verifies to completion", async ({ page }) => {
  const shot = (name: string) =>
    page.screenshot({ path: `test-results/onboarding/trackc-${name}.png`, fullPage: true });

  // First verify → needs_auth; after the key is saved, verify → verified.
  let verifyCalls = 0;
  await page.route("**/internal-agent/verify", async (route) => {
    verifyCalls += 1;
    if (verifyCalls === 1) {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          outcome: "needs_auth",
          result: { status: "fail", checks: [{ code: "claude_hello_probe_auth_required", message: "sign in" }] },
        }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ outcome: "verified", result: { status: "pass" } }),
      });
    }
  });
  await page.route("**/internal-agent/commander-key", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, secretId: "sec-e2e" }) }),
  );

  await walkToVerify(page, "Claude");
  await page.getByRole("button", { name: /^verify$/i }).click();

  // exact: the probe message span — substring matching also hits the
  // "Sign in with Claude" / "I'll sign in myself in the CLI" buttons (strict
  // mode violation), same as the interactive-login test below.
  await expect(page.getByText("sign in", { exact: true })).toBeVisible();
  await shot("01-needs-auth");
  const keyField = page.getByPlaceholder(/sk-ant/i);
  await expect(keyField).toBeEnabled();
  await keyField.fill("sk-ant-e2e-secret");
  await page.getByRole("button", { name: /save key & verify/i }).click();

  // Re-verify succeeded → the spine completes and hands off to Home's first-run
  // Map fork (department/agent moved into the in-flight tail behind it).
  await expect(page.getByRole("heading", { name: /where are you starting from/i })).toBeVisible({ timeout: 20_000 });
});

test("needs_auth → interactive login surfaces the URL and completes on poll", async ({ page }) => {
  const shot = (name: string) =>
    page.screenshot({ path: `test-results/onboarding/trackc-${name}.png`, fullPage: true });

  let verifyCalls = 0;
  await page.route("**/internal-agent/verify", async (route) => {
    verifyCalls += 1;
    await route.fulfill({
      status: verifyCalls === 1 ? 422 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        verifyCalls === 1
          ? { outcome: "needs_auth", result: { checks: [{ message: "sign in" }] } }
          : { outcome: "verified", result: { status: "pass" } },
      ),
    });
  });
  await page.route("**/internal-agent/commander-login/capabilities", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        topology: {
          platform: "linux",
          installProfile: "local_single_user",
          networkLocation: "local",
          trustBoundary: "single_user",
          executionOwnership: "user_hosted",
        },
        providers: {
          openai: {
            provider: "openai",
            mode: "device_code",
            enabled: true,
            browserSafeRemotely: true,
            reason: null,
            cliInstalled: true,
            cliVersion: "0.145.0",
            cliVersionSupported: true,
          },
          anthropic: {
            provider: "anthropic",
            mode: "paste_code",
            enabled: true,
            browserSafeRemotely: true,
            reason: null,
            cliInstalled: true,
            cliVersion: "2.1.220",
            cliVersionSupported: true,
          },
        },
      }),
    }),
  );
  await page.route("**/commander-login/start", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        challengeId: "ch-e2e",
        loginUrl: "https://chatgpt.com/device",
        mode: "device_code",
        userCode: "E2E1-CODE",
        expiresAt: "2026-07-27T14:00:00.000Z",
      }),
    }),
  );
  // First poll: pending (the URL panel must stay mounted long enough to be
  // seen/screenshotted); next poll: completed → auto re-verify. Returning
  // "completed" on the immediate first poll is a race — the panel can unmount
  // before the visibility assertion runs.
  let statusCalls = 0;
  await page.route("**/commander-login/ch-e2e", (route) => {
    statusCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: statusCalls === 1 ? "pending" : "completed",
        loginUrl: "https://chatgpt.com/device",
      }),
    });
  });

  await walkToVerify(page, "Codex");
  await page.getByRole("button", { name: /^verify$/i }).click();
  // exact: the probe message paragraph — substring matching would also hit
  // the "Sign in with Codex" button (strict-mode violation).
  await expect(page.getByText("sign in", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /sign in with codex/i }).click();
  await expect(page.getByRole("link", { name: /continue securely at chatgpt\.com/i })).toHaveAttribute(
    "href",
    "https://chatgpt.com/device",
  );
  await expect(page.getByLabel("Codex device code")).toHaveText("E2E1-CODE");
  await shot("02-login-url");

  // Immediate poll → completed → auto re-verify → spine completes and hands off
  // to Home's first-run Map fork (the post-verify landing after the redesign).
  await expect(page.getByRole("heading", { name: /where are you starting from/i })).toBeVisible({ timeout: 20_000 });
});
