import { test, expect } from "@playwright/test";

/**
 * E2E: Onboarding smoke.
 *
 * The old 6-step OnboardingWizard Dialog was deleted (commit 8fda3be0e, C13);
 * onboarding is now the read-only FlowEngine at the `/onboarding` route, driven
 * by the two-layer onboarding_progress state machine. The founder journey walks
 * profile → org → environment → commander → verify → department → agent → review.
 *
 * The e2e suite boots in local_trusted mode with the dev escape hatch
 * (AOA_DEV_LOCAL_IDENTITY=1, set in playwright.config.ts), so the synthetic
 * local-board admin is the actor and landing on `/` resolves the founder journey
 * → `/onboarding` → the "Set up your profile" step.
 *
 * The full deterministic click-through (profile → … → review) is tracked as A12
 * and is skipped below: the environment step performs a real mkdir+write probe
 * and the commander-verify step shells out to a CLI, so a faithful walk-through
 * needs the fake-claude/fake-codex fixtures (wired) plus a stable filesystem
 * sandbox and progress reset between runs. It is built in the A12 batch rather
 * than asserted here unverified.
 */

test.describe("Onboarding", () => {
  // The founder happy-path A12 walk now lives in onboarding-founder-happy-path.spec.ts
  // (with resume + visual variants). This file keeps the boot/health smoke test.

  test("health endpoint responds (server boots in local_trusted + escape hatch)", async ({ request }) => {
    // Also guards playwright.config.ts's AOA_DEV_LOCAL_IDENTITY=1: if the escape
    // hatch weren't set, the redesigned local_trusted server would still boot,
    // but board-authenticated requests would 401 — this pairs with the other
    // specs that seed via the local-implicit board actor.
    const res = await request.get("/api/health");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body).toHaveProperty("status");
    expect(body.deploymentMode).toBe("local_trusted");
  });
});
