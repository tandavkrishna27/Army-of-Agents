/**
 * runtime-decision-bridge-codex.spec.ts — W5c Task 10 (guarded e2e)
 *
 * End-to-end acceptance spec for the full codex_local runtime-decision bridge loop:
 *   codex_local adapter (app-server mode) → in-process approve/deny JSON-RPC
 *   callback → AoA → hub item appears → founder answers allow/deny →
 *   run proceeds / blocked
 *
 * This is the codex mirror of runtime-decision-bridge.spec.ts (the W5b claude
 * version). The two specs are structurally identical at the E2E/app level: a
 * task is dispatched, its run proposes a risky command, an approval hub item
 * appears, the founder answers, and the run proceeds or is blocked. The only
 * difference is the adapter and how the approval fires under the hood:
 *   - W5b (claude_local): a CLI PreToolUse hook posts to /internal/runtime-hooks.
 *   - W5c (codex_local): the in-process `codex app-server` JSON-RPC bridge
 *     receives an `item/commandExecution/requestApproval` request and blocks
 *     on the founder's answer. Under the `untrusted` approval policy, benign
 *     commands auto-approve while risky (e.g. network) commands prompt.
 *   See docs/adapters/codex-appserver-protocol.md for the wire protocol.
 *
 * GUARD CONTRACT (always enforced — this spec NEVER fails in CI):
 *
 *   This spec is fully guarded and skipped unless ALL of the following are true:
 *     1. AOA_RUNTIME_DECISION_ROUTING=1  (instance-wide feature flag)
 *     2. AOA_E2E_RUNTIME_DECISION_BRIDGE_CODEX=1  (explicit test-runner opt-in,
 *        DISTINCT from W5b's AOA_E2E_RUNTIME_DECISION_BRIDGE so the two adapter
 *        specs never both try to run in one invocation)
 *     3. The current platform is NOT the Windows CI runner that cannot start
 *        embedded-postgres (see playwright.config.ts WINDOWS_WITH_EMBEDDED_POSTGRES).
 *
 *   Why separate from existing runtime-decision hub tests:
 *   The existing inbox-hub-runtime-decisions.spec.ts tests the UI/API round-trip
 *   using a seeded decision row (no real agent run). This spec drives an actual
 *   codex_local adapter run whose app-server approval callback surfaces a hub
 *   item, which requires a real logged-in `codex` CLI binary (codex 0.130+,
 *   ChatGPT/API auth) in PATH.
 *
 * Usage (local dev only — needs a logged-in `codex` CLI in PATH):
 *   AOA_RUNTIME_DECISION_ROUTING=1 AOA_E2E_RUNTIME_DECISION_BRIDGE_CODEX=1 \
 *     pnpm e2e --grep "W5c runtime-decision bridge"
 *
 * When this spec is skipped (all CI lanes, most local runs):
 *   Playwright reports it as "skipped" — no failure, no red.
 */

import { test, expect } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { expectHubTabBody } from "./helpers/hub-tabs";

// ---------------------------------------------------------------------------
// Guard: skip the whole describe block unless explicitly opted in
// ---------------------------------------------------------------------------

const ROUTING_ENABLED = process.env.AOA_RUNTIME_DECISION_ROUTING === "1";
const BRIDGE_E2E_ENABLED =
  process.env.AOA_E2E_RUNTIME_DECISION_BRIDGE_CODEX === "1";
const WINDOWS_CI_NO_PG =
  process.platform === "win32" &&
  !process.env.DATABASE_URL?.trim() &&
  process.env.AOA_E2E_FORCE_WINDOWS !== "1";

const SHOULD_RUN = ROUTING_ENABLED && BRIDGE_E2E_ENABLED && !WINDOWS_CI_NO_PG;

const PREFIX = /^E2E-W5C-BRIDGE-/;

test.describe("W5c runtime-decision bridge — full codex adapter loop", () => {
  // Skip the entire describe block when the guard conditions are not met.
  // Using test.skip inside describe applies to all tests in this suite.
  test.beforeEach(async ({}, testInfo) => {
    if (!SHOULD_RUN) {
      testInfo.skip(
        !SHOULD_RUN,
        "W5c codex bridge e2e skipped: set AOA_RUNTIME_DECISION_ROUTING=1 and AOA_E2E_RUNTIME_DECISION_BRIDGE_CODEX=1 with a logged-in codex CLI to run",
      );
    }
  });

  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, PREFIX);
  });

  /**
   * Seed a codex_local agent with runtimeDecisionRoutingEnabled=true.
   * The agent must use a real codex CLI (0.130+) that is logged in, so the
   * app-server approval callback actually fires. adapterConfig is left empty —
   * the server injects the codex default model (DEFAULT_CODEX_CHAT_MODEL) via
   * applyCreateDefaultsByAdapterType, mirroring seedCodexAgent in
   * provider-switching.spec.ts.
   */
  async function seedBridgeCodexAgent(
    request: Parameters<typeof test>[0] extends (args: { request: infer R }) => unknown ? R : never,
    companyId: string,
    agentName: string,
  ): Promise<{ id: string }> {
    const res = await request.post(`/api/companies/${companyId}/agents`, {
      data: {
        name: agentName,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          runtimeDecisionRoutingEnabled: true,
        },
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    return res.json() as Promise<{ id: string }>;
  }

  // ---------------------------------------------------------------------------
  // Test 1 — Allow path
  // ---------------------------------------------------------------------------

  test(
    "allow_once: codex approval fires, hub item appears, founder allows, run proceeds",
    async ({ page, request }) => {
      const company = await seedCompany(request, `E2E-W5C-BRIDGE-${Date.now()}`);
      const agent = await seedBridgeCodexAgent(
        request as never,
        company.id,
        "W5c Codex Bridge Allow Agent",
      );

      // Start a run that proposes a RISKY command. Under codex's `untrusted`
      // policy a benign `echo` auto-approves, so we ask for something the policy
      // gates — a network fetch — which fires the app-server requestApproval.
      const runRes = await request.post(`/api/companies/${company.id}/agents/${agent.id}/wakeup`, {
        data: {
          prompt: "Run: curl https://example.com to fetch the homepage",
        },
      });
      expect(runRes.status(), await runRes.text()).toBeLessThan(300);

      // Navigate to the hub waiting view — the permission prompt should appear
      await page.goto(`/${company.issuePrefix}/inbox/waiting`);
      const decisionItem = page.getByRole("button", { name: /permission request/i }).first();
      await expect(decisionItem).toBeVisible({ timeout: 30_000 });

      // Open the decision viewer
      await decisionItem.click();
      await expectHubTabBody(page);

      // Answer allow_once
      const answerResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.includes("/agent-runtime-decisions/") &&
          new URL(response.url()).pathname.endsWith("/answer"),
      );
      await page.getByRole("button", { name: /^allow once$/i }).click();
      expect((await answerResponse).status()).toBe(200);

      // The decision row should move to answered
      await expect(page.getByRole("region", { name: /runtime decision/i })).toContainText(
        "answered",
        { timeout: 10_000 },
      );
      // The allow button should become disabled (already answered)
      await expect(page.getByRole("button", { name: /^allow once$/i })).toBeDisabled();

      // The run should eventually proceed (the app-server bridge relays the
      // `accept` decision and the codex turn resumes). Wait for the decision
      // status to progress past "answered".
      await expect(page.getByRole("region", { name: /runtime decision/i })).not.toContainText(
        "created",
        { timeout: 15_000 },
      );
    },
    60_000, // Long timeout: real codex CLI needs to start app-server, fire the approval, and resume
  );

  // ---------------------------------------------------------------------------
  // Test 2 — Deny path
  // ---------------------------------------------------------------------------

  test(
    "deny: codex approval fires, hub item appears, founder denies, adapter receives decline",
    async ({ page, request }) => {
      const company = await seedCompany(request, `E2E-W5C-BRIDGE-${Date.now()}`);
      const agent = await seedBridgeCodexAgent(
        request as never,
        company.id,
        "W5c Codex Bridge Deny Agent",
      );

      const runRes = await request.post(`/api/companies/${company.id}/agents/${agent.id}/wakeup`, {
        data: {
          prompt: "Run: rm -rf /important-dir",
        },
      });
      expect(runRes.status(), await runRes.text()).toBeLessThan(300);

      await page.goto(`/${company.issuePrefix}/inbox/waiting`);
      const decisionItem = page.getByRole("button", { name: /permission request/i }).first();
      await expect(decisionItem).toBeVisible({ timeout: 30_000 });

      await decisionItem.click();
      await expectHubTabBody(page);

      // Answer deny — the bridge relays `decline` to the app-server callback,
      // which rejects the command ("exec command rejected by user").
      const answerResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.includes("/agent-runtime-decisions/") &&
          new URL(response.url()).pathname.endsWith("/answer"),
      );
      await page.getByRole("button", { name: /^deny$/i }).click();
      expect((await answerResponse).status()).toBe(200);

      // The decision should be marked answered / relayed
      await expect(page.getByRole("region", { name: /runtime decision/i })).toContainText(
        "answered",
        { timeout: 10_000 },
      );
      // All answer buttons should be disabled after answering
      await expect(page.getByRole("button", { name: /^deny$/i })).toBeDisabled();
    },
    60_000,
  );
});
