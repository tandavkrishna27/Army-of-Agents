import { test, expect, type APIRequestContext, type Page, type Route } from "@playwright/test";
import { seedCompany, cleanupTestCompanies } from "./helpers/seed-company";
import {
  freshOnboardingState,
  fillFounderProfileStep,
  fillOrganizationStep,
} from "./helpers/onboarding-e2e";

/**
 * E2E: Settings -> Providers readiness (Provider Readiness initiative, Task 15).
 *
 * WHY THE BACKEND IS INTERCEPTED, AND WHERE IT IS NOT
 * ---------------------------------------------------
 * `POST /providers/:id/test` spawns a REAL CLI, and `POST /login/start` opens a
 * REAL OAuth flow that writes to the developer's host credential store. Neither
 * may run from a test. So the two side-effecting routes are always mocked.
 *
 * `GET /providers` is NOT hand-written. Every scenario below fetches the REAL
 * response from the REAL server (`route.fetch()`) — real catalog descriptors,
 * real seeded agents, real `existingKey` resolution — and then rewrites only the
 * readiness verdicts. A hand-built fixture would let the catalog drift out from
 * under these specs, and the whole feature exists because two renderings of one
 * auth state drifted apart.
 *
 * The eighth scenario ("fresh company") rewrites NOTHING: it asserts against
 * whatever a brand-new company genuinely returns. That is deliberate — the two
 * real bugs this feature shipped with were both found in default/first-load
 * states that every explicit fixture had specified away.
 */

const PREFIX = /^E2E-Providers-/;

/* ── wire shapes (mirrors of ui/src/api/providers.ts) ─────────────────────── */

interface ScopedReadinessDto {
  scopeType: "company_default" | "agent";
  scopeId: string | null;
  agentName?: string;
  outcome: string;
  testedAt: string | null;
  checks: { code: string; level: string; message: string }[];
}

interface ProviderRowDto {
  descriptor: { id: string; label: string; adapterType: string };
  companyDefault: ScopedReadinessDto;
  agents: ScopedReadinessDto[];
  existingKey: { configured: boolean; source: string | null; secretName: string | null; envVar: string | null };
}

interface ProviderListDto {
  providers: ProviderRowDto[];
}

/** A recorded probe. The COUNT is the assertion that matters (see D3). */
interface ProbeCall {
  providerId: string;
  scope: string;
  agentId: string | null;
}

interface ProviderBackend {
  /** Every `GET /providers` served, in order. */
  listCalls: number;
  /** Every `POST /:id/test` served, in order. A probe STORM shows up here. */
  probes: ProbeCall[];
  /** Every `POST /login/:challengeId/cancel` served. */
  cancels: string[];
  /** Number of `POST /:id/key` writes served. */
  keySaves: number;
  /** Number of login status polls served. */
  polls: number;
}

interface BackendOptions {
  /**
   * Rewrite the REAL list response. Omit entirely to assert against the
   * server's genuine output (the fresh-company scenario does exactly that).
   */
  shapeList?(body: ProviderListDto, callIndex: number): void;
  /** Verdict returned by a probe. Defaults to an honest "nothing observed". */
  testResult?(call: ProbeCall): { outcome: string; checks?: unknown[]; testedAt?: string };
  /** Login challenge start. Omit to leave `login/start` unmocked. */
  startLogin?(providerId: string): { challengeId: string; loginUrl: string };
  /** Login poll. `pollIndex` is 1-based. */
  loginStatus?(pollIndex: number): { status: string; loginUrl: string | null; readiness: unknown };
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const MINUTES = 60_000;
/** Comfortably past PROVIDER_READINESS_STALE_MS (5 min). */
const STALE = iso(10 * MINUTES);
const FRESH = iso(2_000);

function rowOf(body: ProviderListDto, providerId: string): ProviderRowDto {
  const row = body.providers.find((p) => p.descriptor.id === providerId);
  if (!row) throw new Error(`provider ${providerId} missing from the real catalog response`);
  return row;
}

/**
 * Install the provider-API interception for one page.
 *
 * Route predicates rather than globs: the list path is a strict prefix of every
 * other path here, and a glob that also matched `/providers/openai/test` would
 * silently serve a probe from the list handler.
 */
async function installProviderBackend(
  page: Page,
  companyId: string,
  opts: BackendOptions = {},
): Promise<ProviderBackend> {
  const state: ProviderBackend = { listCalls: 0, probes: [], cancels: [], keySaves: 0, polls: 0 };
  const base = `/api/companies/${companyId}/providers`;
  const pathOf = (raw: string) => new URL(raw).pathname;
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  // GET / — served from the REAL server, then rewritten.
  await page.route(
    (url) => url.pathname === base && !url.pathname.endsWith("/test"),
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      state.listCalls += 1;
      const real = await route.fetch();
      const body = (await real.json()) as ProviderListDto;
      opts.shapeList?.(body, state.listCalls);
      await json(route, body);
    },
  );

  // POST /:providerId/test — NEVER reaches the real route; that spawns a CLI.
  await page.route(
    (url) => url.pathname.startsWith(`${base}/`) && url.pathname.endsWith("/test"),
    async (route) => {
      const url = new URL(route.request().url());
      const providerId = pathOf(route.request().url()).split("/").at(-2) as string;
      const call: ProbeCall = {
        providerId,
        scope: url.searchParams.get("scope") ?? "company_default",
        agentId: url.searchParams.get("agentId"),
      };
      state.probes.push(call);
      const result = opts.testResult?.(call) ?? { outcome: "unknown" };
      await json(route, {
        outcome: result.outcome,
        checks: result.checks ?? [],
        testedAt: result.testedAt ?? new Date().toISOString(),
      });
    },
  );

  // POST /:providerId/key — no real secret is written.
  await page.route(
    (url) => url.pathname.startsWith(`${base}/`) && url.pathname.endsWith("/key"),
    async (route) => {
      state.keySaves += 1;
      await json(route, { ok: true, secretId: "sec-e2e", reprobed: [], invalidated: [] });
    },
  );

  // POST /:providerId/login/start — NEVER real. A real one opens a browser
  // OAuth flow and writes to the host credential store.
  await page.route(
    (url) => url.pathname.startsWith(`${base}/`) && url.pathname.endsWith("/login/start"),
    async (route) => {
      const providerId = pathOf(route.request().url()).split("/").at(-3) as string;
      const started = opts.startLogin?.(providerId);
      if (!started) {
        return json(route, { error: "login unavailable in this scenario", canLogin: false }, 400);
      }
      await json(route, started);
    },
  );

  // POST /login/:challengeId/cancel — must be matched BEFORE the poll route,
  // since the poll predicate would otherwise also match the cancel path.
  await page.route(
    (url) => url.pathname.startsWith(`${base}/`) && url.pathname.endsWith("/cancel"),
    async (route) => {
      state.cancels.push(pathOf(route.request().url()).split("/").at(-2) as string);
      await json(route, { ok: true });
    },
  );

  // GET /:providerId/login/:challengeId
  await page.route(
    (url) => /\/login\/[^/]+$/.test(url.pathname) && url.pathname.startsWith(`${base}/`),
    async (route) => {
      if (pathOf(route.request().url()).endsWith("/login/start")) return route.fallback();
      state.polls += 1;
      const res = opts.loginStatus?.(state.polls) ?? {
        status: "pending",
        loginUrl: null,
        readiness: null,
      };
      await json(route, res);
    },
  );

  return state;
}

/* ── seeding ──────────────────────────────────────────────────────────────── */

async function seedAgent(
  request: APIRequestContext,
  companyId: string,
  name: string,
  adapterType: string,
): Promise<{ id: string; name: string }> {
  const res = await request.post(`/api/companies/${companyId}/agents`, {
    data: { name, adapterType },
  });
  expect(res.status(), await res.text()).toBe(201);
  const agent = (await res.json()) as { id: string; name: string };
  expect(agent.id).toBeTruthy();
  return { id: agent.id, name };
}

async function openProvidersTab(page: Page, issuePrefix: string): Promise<void> {
  await page.goto(`/${issuePrefix}/settings?tab=providers`);
  await expect(page.getByTestId("providers-section")).toBeVisible({ timeout: 20_000 });
}

/** Select a provider in the left rail; its detail pane then carries data-provider. */
async function selectProvider(page: Page, providerId: string): Promise<void> {
  await page.locator(`[data-testid="provider-list-item"][data-provider="${providerId}"]`).click();
  await expect(page.locator(`[data-testid="provider-detail"][data-provider="${providerId}"]`)).toBeVisible();
}
// `data-provider` appears on BOTH the rail item and the detail wrapper, so scope
// `card()` to the detail pane. A bare `[data-provider="id"]` double-matches the
// selected provider (its rail button + its detail); descendant testids happen to
// be detail-only today, but a direct .click()/.toBeVisible()/count on the bare
// locator would strict-violate. Do not rely on the coincidence.
const card = (page: Page, providerId: string) =>
  page.locator(`[data-testid="provider-detail"][data-provider="${providerId}"]`);
const badgeOf = (page: Page, providerId: string) =>
  card(page, providerId).getByTestId("provider-status-badge");

/* ── specs ────────────────────────────────────────────────────────────────── */

test.describe("Settings -> Providers readiness", () => {
  test.afterEach(async ({ request }) => {
    await cleanupTestCompanies(request, PREFIX);
  });

  /**
   * SPEC 1 — decision D3, verbatim.
   *
   * Every card renders IMMEDIATELY from cache, and the load auto-refreshes ONLY
   * providers that are both IN USE and STALE.
   *
   * The assertion is the probe COUNT, because the regression this pins is a
   * probe STORM: eight CLI spawns behind one page load. A test that merely
   * asserted "google got probed" would pass just as happily against the storm.
   */
  test("renders every card from cache and probes only the in-use + stale provider", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Providers-D3-${Date.now()}`);
    // Two providers put IN USE by a real agent; the other six have no agent.
    await seedAgent(request, company.id, "Claude Worker", "claude_local");
    await seedAgent(request, company.id, "Gemini Worker", "gemini_local");

    const backend = await installProviderBackend(page, company.id, {
      shapeList(body) {
        // IN USE + FRESH  -> must NOT be re-probed.
        Object.assign(rowOf(body, "anthropic").companyDefault, {
          outcome: "verified",
          testedAt: FRESH,
          checks: [],
        });
        // IN USE + STALE  -> the ONE provider that may be probed.
        Object.assign(rowOf(body, "google").companyDefault, {
          outcome: "verified",
          testedAt: STALE,
          checks: [],
        });
        // STALE but NOT in use -> must NOT be probed. This row is the whole
        // point: staleness alone is not a licence to spawn a CLI.
        Object.assign(rowOf(body, "openai").companyDefault, {
          outcome: "verified",
          testedAt: STALE,
          checks: [],
        });
        // The remaining five keep the server's genuine never-probed state
        // (unknown / testedAt null), which `isReadinessStale` also calls stale.
      },
      testResult: () => ({ outcome: "verified", testedAt: new Date().toISOString() }),
    });

    await openProvidersTab(page, company.issuePrefix);

    // Rendered from cache: the full catalog is on screen, and the fresh row is
    // already showing its cached verdict.
    // All eight render in the rail, immediately, from cache.
    await expect(page.getByTestId("provider-list-item")).toHaveCount(8);
    // anthropic is in use (a seeded claude agent) so it is the default detail —
    // but select it explicitly so this assertion does not depend on defaulting.
    await selectProvider(page, "anthropic");
    await expect(badgeOf(page, "anthropic")).toContainText("Ready");
    await expect(card(page, "anthropic").getByTestId("provider-checked-at")).toContainText(
      "checked just now",
    );

    // Exactly ONE probe, and it is google's. Not eight.
    await expect.poll(() => backend.probes.length, { timeout: 15_000 }).toBe(1);
    expect(backend.probes[0]).toMatchObject({ providerId: "google", scope: "company_default" });

    // And it stays one. Each probe invalidates the list, which re-runs the
    // auto-refresh effect; without the ledger this would loop forever.
    await page.waitForTimeout(4_000);
    expect(backend.probes.map((p) => p.providerId)).toEqual(["google"]);
  });

  /** SPEC 2 — pressing Test updates the badge and the "checked …" timestamp. */
  test("Test updates the badge and the checked-at timestamp", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Providers-Test-${Date.now()}`);
    /*
      Google, deliberately, NOT Claude. A newly seeded company already ships
      nine hidden crew agents on `claude_local`, so `anthropic` is IN USE from
      the first millisecond and D3 auto-refreshes it — which would make the
      founder's own Test press indistinguishable from the automatic one. No
      seeded agent runs `gemini_local`, so this probe count is unambiguous.
    */
    let verified = false;

    const backend = await installProviderBackend(page, company.id, {
      shapeList(body) {
        Object.assign(rowOf(body, "google").companyDefault, {
          outcome: verified ? "verified" : "needs_auth",
          testedAt: verified ? new Date().toISOString() : STALE,
          checks: verified ? [] : [{ code: "auth", level: "error", message: "Run claude auth login" }],
        });
      },
      /*
        Scoped to google's probe. Flipping on ANY probe would let the automatic
        `anthropic` refresh turn google green before the founder ever pressed
        Test — the spec would then pass without observing the thing it names.
      */
      testResult: (call) => {
        if (call.providerId === "google") verified = true;
        return { outcome: "verified", testedAt: new Date().toISOString() };
      },
    });

    await openProvidersTab(page, company.issuePrefix);
    await selectProvider(page, "google");
    await expect(badgeOf(page, "google")).toHaveText("Needs sign-in");
    await expect(card(page, "google").getByTestId("provider-checked-at")).toContainText("10m ago");
    // Nobody has probed GOOGLE yet. (`anthropic` is legitimately auto-probed
    // here — the hidden crew agents put it in use and it has never been
    // checked — which is D3 behaving, and spec 1 owns that assertion.)
    expect(backend.probes.filter((p) => p.providerId === "google")).toHaveLength(0);

    await card(page, "google").getByTestId("provider-test").click();

    await expect(badgeOf(page, "google")).toHaveText("Ready");
    await expect(card(page, "google").getByTestId("provider-checked-at")).toContainText(
      "checked just now",
    );
    expect(backend.probes.filter((p) => p.providerId === "google")).toEqual([
      { providerId: "google", scope: "company_default", agentId: null },
    ]);
  });

  /** SPEC 3 — saving an API key flips the COMPANY-DEFAULT badge to Ready. */
  test("saving an API key flips the company default to Ready", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Providers-Key-${Date.now()}`);
    let keyed = false;

    const backend = await installProviderBackend(page, company.id, {
      shapeList(body) {
        const row = rowOf(body, "google");
        Object.assign(row.companyDefault, {
          outcome: keyed ? "verified" : "needs_auth",
          testedAt: keyed ? new Date().toISOString() : STALE,
          checks: [],
        });
        row.existingKey = { ...row.existingKey, configured: keyed };
      },
    });

    await openProvidersTab(page, company.issuePrefix);
    await selectProvider(page, "google");
    const google = card(page, "google");
    await expect(badgeOf(page, "google")).toHaveText("Needs sign-in");
    await expect(google.getByText("Add an API key")).toBeVisible();

    await google.getByTestId("provider-key-input").fill("AIza-e2e-not-a-real-key");
    // Flip the served state only once the write is accepted, so a badge that
    // went green without a successful save would still fail this spec.
    keyed = true;
    await google.getByTestId("provider-key-save").click();

    await expect(badgeOf(page, "google")).toHaveText("Ready");
    await expect(google.getByText("Replace API key")).toBeVisible();
    expect(backend.keySaves).toBe(1);
  });

  /**
   * SPEC 4 — the P1-1 regression, and the reason this whole surface is scoped
   * per-agent instead of one row per provider.
   *
   * The company default authenticates. One agent's OWN `adapterConfig.env`
   * binding does not. A bare green "Ready" here would hide an agent that cannot
   * run — the exact false-green the feature exists to remove.
   */
  test("P1-1: a verified company default never hides a failing in-use agent", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Providers-P11-${Date.now()}`);
    const agent = await seedAgent(request, company.id, "Revoked Key Agent", "claude_local");

    await installProviderBackend(page, company.id, {
      shapeList(body) {
        const row = rowOf(body, "anthropic");
        // The COMPANY key works.
        Object.assign(row.companyDefault, {
          outcome: "verified",
          // Fresh, so D3 does not auto-probe and muddy the scenario.
          testedAt: FRESH,
          checks: [],
        });
        // This agent's OWN binding does not.
        const scoped = row.agents.find((a) => a.scopeId === agent.id);
        if (!scoped) throw new Error(`agent ${agent.id} missing from the anthropic row`);
        Object.assign(scoped, {
          outcome: "needs_auth",
          testedAt: FRESH,
          checks: [{ code: "auth", level: "error", message: "401 from the agent's own key" }],
        });
      },
    });

    await openProvidersTab(page, company.issuePrefix);
    await selectProvider(page, "anthropic");

    const badge = badgeOf(page, "anthropic");
    // The load-bearing assertion: NOT a bare "Ready".
    await expect(badge).not.toHaveText("Ready");
    await expect(badge).toHaveText("Ready, 1 agent failing");
    // Amber, not green — the pill's colour is read before its text.
    await expect(badge).toHaveClass(/amber/);

    // The failing agent is named, with its own verdict.
    const failing = card(page, "anthropic").getByTestId("provider-failing-agents");
    await expect(failing).toBeVisible();
    await expect(failing).toContainText("Revoked Key Agent");
    await expect(failing).toContainText("Needs sign-in");
  });

  /**
   * SPEC 5 — the agent config page shows THIS AGENT'S scope and links to the tab.
   *
   * Also pins the no-fallback rule: the company default is `verified` in this
   * fixture, so a badge reading "Ready" here would mean the badge fell back to
   * the company scope for an agent that cannot run.
   */
  test("agent config shows the agent-scoped badge and links to the Providers tab", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Providers-Agent-${Date.now()}`);
    const agent = await seedAgent(request, company.id, "Config Badge Agent", "claude_local");

    await installProviderBackend(page, company.id, {
      shapeList(body) {
        const row = rowOf(body, "anthropic");
        Object.assign(row.companyDefault, { outcome: "verified", testedAt: FRESH, checks: [] });
        const scoped = row.agents.find((a) => a.scopeId === agent.id);
        if (!scoped) throw new Error(`agent ${agent.id} missing from the anthropic row`);
        Object.assign(scoped, { outcome: "needs_auth", testedAt: FRESH, checks: [] });
      },
    });

    await page.goto(`/${company.issuePrefix}/agents/${agent.id}/configure`);

    // The badge lives inside the collapsible "Adapter & model" card, which the
    // Config tab renders collapsed.
    const adapterSection = page.getByRole("button", { name: /adapter & model/i });
    await expect(adapterSection).toBeVisible({ timeout: 20_000 });
    await adapterSection.click();

    const readiness = page.getByTestId("agent-readiness");
    await expect(readiness).toBeVisible({ timeout: 20_000 });
    const badge = page.getByTestId("agent-readiness-badge");
    // The AGENT's verdict, not the company default's.
    await expect(badge).toHaveText("Needs sign-in");
    await expect(badge).not.toHaveText("Ready");
    await expect(readiness.getByRole("link", { name: /Manage in Settings/i })).toHaveAttribute(
      "href",
      /tab=providers/,
    );
  });

  /**
   * SPEC 6a — login lifecycle against a MOCKED backend.
   *
   * No real `codex login` is ever executed: a real one opens a browser OAuth
   * flow and writes to the host credential store.
   */
  test("Sign in starts a challenge, polls, and re-probes on completion", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Providers-Login-${Date.now()}`);
    let signedIn = false;

    const backend = await installProviderBackend(page, company.id, {
      shapeList(body) {
        Object.assign(rowOf(body, "openai").companyDefault, {
          outcome: signedIn ? "verified" : "needs_auth",
          testedAt: signedIn ? new Date().toISOString() : STALE,
          checks: [],
        });
      },
      startLogin: () => ({ challengeId: "ch-e2e", loginUrl: "https://example.test/oauth?code=E2E" }),
      // First poll pending (so the progress panel is observable rather than a
      // race), then completed. `readiness: null` on purpose — that is the branch
      // where the client must run its own re-probe.
      loginStatus: (n) => {
        if (n === 1) return { status: "pending", loginUrl: "https://example.test/oauth?code=E2E", readiness: null };
        signedIn = true;
        return { status: "completed", loginUrl: null, readiness: null };
      },
    });

    await openProvidersTab(page, company.issuePrefix);
    await selectProvider(page, "openai");
    const openai = card(page, "openai");
    await expect(badgeOf(page, "openai")).toHaveText("Needs sign-in");

    await openai.getByTestId("provider-signin").click();

    // The challenge is live: the founder is given the URL and a way out.
    await expect(openai.getByTestId("provider-login-progress")).toBeVisible();
    await expect(openai.getByRole("link", { name: /finish sign-in/i })).toHaveAttribute(
      "href",
      "https://example.test/oauth?code=E2E",
    );
    await expect(openai.getByTestId("provider-signin")).toHaveText(/waiting for sign-in/i);

    // Completion: polling stops, the client re-probes (readiness was null), the
    // card lands on the fresh verdict.
    await expect(badgeOf(page, "openai")).toHaveText("Ready", { timeout: 20_000 });
    await expect(openai.getByTestId("provider-login-progress")).toHaveCount(0);
    expect(backend.probes.map((p) => p.providerId)).toContain("openai");

    // Polling really stopped — a poll count that keeps climbing means the
    // interval outlived its terminal status.
    const settled = backend.polls;
    await page.waitForTimeout(4_000);
    expect(backend.polls).toBe(settled);
  });

  /**
   * SPEC 6b — navigating away releases the HOST-SHARED login slot.
   *
   * A stranded pending challenge 409s every other company on the machine, so
   * "we forgot to cancel" is not a cosmetic leak.
   */
  test("navigating away cancels a pending login challenge", async ({ page, request }) => {
    const company = await seedCompany(request, `E2E-Providers-Cancel-${Date.now()}`);

    const backend = await installProviderBackend(page, company.id, {
      shapeList(body) {
        Object.assign(rowOf(body, "openai").companyDefault, {
          outcome: "needs_auth",
          testedAt: STALE,
          checks: [],
        });
      },
      startLogin: () => ({ challengeId: "ch-leak", loginUrl: "https://example.test/oauth?code=LEAK" }),
      loginStatus: () => ({ status: "pending", loginUrl: null, readiness: null }),
    });

    await openProvidersTab(page, company.issuePrefix);
    await selectProvider(page, "openai");
    await card(page, "openai").getByTestId("provider-signin").click();
    await expect(card(page, "openai").getByTestId("provider-login-progress")).toBeVisible();

    /*
      Leave via an IN-APP link, not `page.goto`. A full document navigation
      tears the renderer down without running React's unmount effects, so it
      would exercise the browser rather than the cleanup this spec is about —
      and would pass or fail for reasons unrelated to the code.
    */
    await page.getByRole("button", { name: "General", exact: true }).click();
    await expect(page.getByTestId("providers-section")).toHaveCount(0);

    await expect.poll(() => backend.cancels, { timeout: 10_000 }).toContain("ch-leak");
  });

  /**
   * SPEC 7 — onboarding's Verify step still completes after the shared-card
   * refactor, and now speaks the shared vocabulary.
   */
  test("onboarding Verify still completes and uses the shared outcome vocabulary", async ({
    page,
    request,
  }) => {
    await freshOnboardingState(request);
    await page.route("**/internal-agent/verify", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ outcome: "verified", result: { status: "pass" } }),
      }),
    );

    await page.goto("/onboarding");
    await fillFounderProfileStep(page, "E2E-Providers Founder");
    await page.getByRole("button", { name: /continue/i }).click();

    // Organization — the Phase-2 multi-tenant tenant step ("Your organization"),
    // inserted before the company step.
    await fillOrganizationStep(page, `E2E-Providers-Org-${Date.now()}`);

    // Company — heading is "Your company" (#295 onboarding redesign).
    await expect(page.getByRole("heading", { name: /your company/i })).toBeVisible({ timeout: 20_000 });
    await page.getByLabel("Company name").fill(`E2E-Providers-Onboard-${Date.now()}`);
    await expect(page.getByRole("button", { name: /continue/i })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole("button", { name: /continue/i }).click();

    await expect(page.getByRole("heading", { name: /set up your environment/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByRole("button", { name: /verify & continue/i })).toBeEnabled({
      timeout: 15_000,
    });
    await page.getByRole("button", { name: /verify & continue/i }).click();

    // Commander — heading is "Bring your engine online" (#295 redesign).
    await expect(page.getByRole("heading", { name: /bring your engine online/i })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByText("Claude", { exact: true }).click();
    await expect(page.getByRole("button", { name: /continue/i })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole("button", { name: /continue/i }).click();

    await expect(page.getByRole("heading", { name: /verify your tooling/i })).toBeVisible({
      timeout: 20_000,
    });
    // No verdict before the first probe — a placeholder badge would be a claim
    // about nothing.
    await expect(page.getByTestId("verify-outcome-badge")).toHaveCount(0);

    await page.getByRole("button", { name: /^verify$/i }).click();

    // Verify completes and the spine auto-advances into Home's first-run fork
    // (#295 redesign: Department/Agent/Review left the wizard). The shared
    // outcome vocabulary was already asserted above (verify-outcome-badge
    // absent pre-probe); reaching this heading proves Verify unblocked the step.
    await expect(page.getByRole("heading", { name: /where are you starting from/i })).toBeVisible({
      timeout: 20_000,
    });
  });

  /**
   * SPEC 8 — THE FRESH COMPANY. Not in the plan; added because this is the
   * state a real founder sees first and the one every explicit fixture
   * specifies away.
   *
   * Live driving of a brand-new company found the tab announcing
   * "9 agents failing" and "These agents can't run on this provider" about
   * agents nobody had ever probed. `unknown` had been folded into the failing
   * bucket. Nothing was broken; we had simply never looked.
   *
   * So this spec rewrites NOTHING in the list response. It asserts against a
   * genuinely fresh company: never-probed agents must read as NOT CHECKED, and
   * must not be described as failing or unable to run.
   */
  test("a fresh company reports never-probed agents as unchecked, not failing", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Providers-Fresh-${Date.now()}`);
    const agent = await seedAgent(request, company.id, "Brand New Agent", "claude_local");

    const backend = await installProviderBackend(page, company.id, {
      // shapeList deliberately omitted: the server's REAL fresh-company output.
      // The agent is in use and has never been probed, so D3 will auto-refresh
      // the company default — this mock keeps that from spawning a real CLI, and
      // returns the honest verdict of a probe that observed nothing.
      testResult: () => ({ outcome: "unknown" }),
    });

    await openProvidersTab(page, company.issuePrefix);
    await selectProvider(page, "anthropic");
    const anthropic = card(page, "anthropic");

    // The never-probed agent is listed under its own neutral heading...
    const unchecked = anthropic.getByTestId("provider-unchecked-agents");
    await expect(unchecked).toBeVisible();
    await expect(unchecked).toContainText("Not checked yet");
    await expect(unchecked).toContainText(agent.name);

    // ...and NOWHERE is it called failing, on any card on the page.
    await expect(page.getByTestId("provider-failing-agents")).toHaveCount(0);
    await expect(page.getByText(/can't run on this provider/i)).toHaveCount(0);
    await expect(page.getByText(agent.name, { exact: false })).toHaveCount(1);

    // The company default itself is honestly "we haven't checked", not a
    // failure and not a green claim.
    await expect(badgeOf(page, "anthropic")).toHaveText("Not verified");

    // And still no probe storm on a fresh company: one in-use provider, one probe.
    await expect.poll(() => backend.probes.length, { timeout: 15_000 }).toBe(1);
    expect(backend.probes[0]?.providerId).toBe("anthropic");
  });
});
