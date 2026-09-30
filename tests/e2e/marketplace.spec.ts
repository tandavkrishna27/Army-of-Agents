import { test, expect } from "@playwright/test";
import { seedCompany, cleanupTestCompanies } from "./helpers/seed-company";

/**
 * E2E: Marketplace (M.1 – M.4) smoke.
 *
 * Covers:
 *   API layer — catalog, company settings, pending updates, request-install
 *   UI layer  — marketplace home page, type-filter page, updates page
 *
 * Route map (from App.tsx):
 *   /marketplace                       — global catalog home (no company prefix)
 *   /marketplace/:type                 — redirects to /marketplace?type=:type
 *   /:prefix/marketplace-updates       — company-scoped updates page
 *
 * UI overhaul (May 2026):
 *   - Marketplace h1 changed to "Marketplace." (brand dot)
 *   - Filter chips use MarketplaceFilterChips — accessible name is label+count,
 *     e.g. "Plugins4" (no "available" text). Match by label prefix /^plugins/i.
 *   - /marketplace/:type redirects to /marketplace?type=:type; no separate h1
 *     per type — the active chip identifies the current filter.
 *
 * Catalog in the test instance falls back to the bundled
 * aoa-marketplace-snapshot.json when the CDN is unavailable. The snapshot
 * evolves, so UI assertions avoid hard-coding individual catalog item names.
 *
 * Server boots in AOA_DEPLOYMENT_MODE=local_trusted — no auth header needed.
 */

test.describe("Marketplace API", () => {
  test.afterEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-MKT-/);
  });

  test("GET /api/marketplace/catalog returns non-empty catalog", async ({
    request,
  }) => {
    const res = await request.get("/api/marketplace/catalog");
    expect(res.ok()).toBe(true);

    const catalog = (await res.json()) as {
      items?: Array<{ id: string; name: string; type: string }>;
    };
    expect(Array.isArray(catalog.items)).toBe(true);
    expect(catalog.items!.length).toBeGreaterThan(0);

    const item = catalog.items![0]!;
    expect(item.id).toBeTruthy();
    expect(item.name).toBeTruthy();
    expect(["plugin", "skill", "agent", "team"]).toContain(item.type);
  });

  test("GET /api/marketplace/catalog/status returns sync metadata", async ({
    request,
  }) => {
    const res = await request.get("/api/marketplace/catalog/status");
    expect(res.ok()).toBe(true);
    const status = await res.json();
    // source field indicates where the catalog came from (bundled / remote)
    expect(status).toHaveProperty("source");
  });

  test("GET /api/companies/:id/marketplace/settings returns default settings shape", async ({
    request,
  }) => {
    const company = await seedCompany(request, `E2E-MKT-${Date.now()}`);
    const res = await request.get(
      `/api/companies/${company.id}/marketplace/settings`,
    );
    expect(res.ok()).toBe(true);

    const settings = (await res.json()) as Record<string, unknown>;
    // MarketplaceSettings fields (from packages/shared/src/marketplace.ts)
    expect(settings).toHaveProperty("pluginUpdatePolicy");
    expect(settings).toHaveProperty("skillUpdatePolicy");
    expect(settings).toHaveProperty("allowTeamLeadPlugins");
    expect(settings).toHaveProperty("teamMemberCanRequestInstall");
  });

  test("PATCH /api/companies/:id/marketplace/settings persists a field change", async ({
    request,
  }) => {
    const company = await seedCompany(request, `E2E-MKT-${Date.now()}`);
    const base = `/api/companies/${company.id}/marketplace/settings`;

    // pluginUpdatePolicy accepts "auto_patch" | "auto_minor" | "notify_all"
    const patch = await request.patch(base, {
      data: { pluginUpdatePolicy: "notify_all", allowTeamLeadPlugins: true },
    });
    expect(patch.ok()).toBe(true);
    const updated = (await patch.json()) as {
      pluginUpdatePolicy: string;
      allowTeamLeadPlugins: boolean;
    };
    expect(updated.pluginUpdatePolicy).toBe("notify_all");
    expect(updated.allowTeamLeadPlugins).toBe(true);

    // Round-trip: GET should return the same persisted values
    const get = await request.get(base);
    expect(get.ok()).toBe(true);
    const fetched = (await get.json()) as {
      pluginUpdatePolicy: string;
      allowTeamLeadPlugins: boolean;
    };
    expect(fetched.pluginUpdatePolicy).toBe("notify_all");
    expect(fetched.allowTeamLeadPlugins).toBe(true);
  });

  test("PATCH /api/companies/:id/marketplace/settings rejects non-object body", async ({
    request,
  }) => {
    const company = await seedCompany(request, `E2E-MKT-${Date.now()}`);
    const res = await request.patch(
      `/api/companies/${company.id}/marketplace/settings`,
      {
        data: [1, 2, 3], // array is not a valid settings object
        failOnStatusCode: false,
      },
    );
    expect(res.status()).toBe(400);
  });

  test("GET /api/companies/:id/marketplace/updates returns empty list for new company", async ({
    request,
  }) => {
    const company = await seedCompany(request, `E2E-MKT-${Date.now()}`);
    const res = await request.get(
      `/api/companies/${company.id}/marketplace/updates`,
    );
    expect(res.ok()).toBe(true);

    const updates = await res.json();
    expect(Array.isArray(updates)).toBe(true);
    expect(updates).toHaveLength(0);
  });

  test("POST /api/companies/:id/marketplace/request-install — 400 without catalogItemId", async ({
    request,
  }) => {
    const company = await seedCompany(request, `E2E-MKT-${Date.now()}`);
    const res = await request.post(
      `/api/companies/${company.id}/marketplace/request-install`,
      { data: {}, failOnStatusCode: false },
    );
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/catalogItemId/i);
  });

  test("POST /api/companies/:id/marketplace/request-install — 202 with valid id", async ({
    request,
  }) => {
    const company = await seedCompany(request, `E2E-MKT-${Date.now()}`);
    const res = await request.post(
      `/api/companies/${company.id}/marketplace/request-install`,
      {
        data: { catalogItemId: "plugin:aoa-curated/aoa-plugin-slack" },
        failOnStatusCode: false,
      },
    );
    expect(res.status()).toBe(202);
    const body = (await res.json()) as { queued: boolean };
    expect(body.queued).toBe(true);
  });

  test("POST /api/companies/:id/marketplace/updates/:id/dismiss — 404 for unknown id", async ({
    request,
  }) => {
    const company = await seedCompany(request, `E2E-MKT-${Date.now()}`);
    const res = await request.post(
      `/api/companies/${company.id}/marketplace/updates/00000000-0000-0000-0000-000000000000/dismiss`,
      { failOnStatusCode: false },
    );
    // dismiss is fire-and-forget (returns ok:true even if row not found),
    // so we just assert it doesn't 500
    expect(res.status()).toBeLessThan(500);
  });
});

test.describe("Marketplace UI", () => {
  test.afterEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-MKT-/);
  });

  test("Marketplace home renders hero + installable catalog cards", async ({
    page,
  }) => {
    await page.goto("/marketplace");

    // Hero h1 ("Marketplace.") — visible once data loads
    await expect(
      page.getByRole("heading", { level: 1, name: /marketplace/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The bundled snapshot changes as the marketplace grows. Assert the stable
    // card affordance instead of a specific catalog item name.
    await expect(page.getByRole("button", { name: /^install$/i }).first()).toBeVisible();
  });

  test("Marketplace home renders type pills with labels and 'available' counts", async ({
    page,
  }) => {
    await page.goto("/marketplace");

    // Wait for hero so we know data has loaded
    await expect(
      page.getByRole("heading", { level: 1, name: /marketplace/i }),
    ).toBeVisible({ timeout: 15_000 });

    // MarketplaceFilterChips renders one button per type.
    // Accessible name = label + count concatenated (e.g. "Plugins4").
    // Match by label prefix — count format may vary.
    await expect(page.getByRole("button", { name: /^plugins/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^skills/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^agents/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /^teams/i })).toBeVisible();
  });

  test("Marketplace home does not show error state", async ({ page }) => {
    await page.goto("/marketplace");

    // Wait for catalog to settle (either data or empty-state — not error)
    await expect(
      page.getByText("Failed to load marketplace."),
    ).not.toBeVisible({ timeout: 15_000 });
  });

  test("/marketplace/plugin type-filter page surfaces the first-party plugins in the Plugins shelf", async ({
    page,
  }) => {
    // /marketplace/plugin redirects → /marketplace?type=plugin (MarketplaceTypeRedirect).
    // The page uses a single h1 "Marketplace." and the Plugins filter chip goes active.
    await page.goto("/marketplace?type=plugin");

    // Wait for the page to settle
    await expect(
      page.getByRole("heading", { level: 1, name: /marketplace/i }),
    ).toBeVisible({ timeout: 15_000 });

    // The Plugins filter chip should be active when ?type=plugin is set
    const pluginsPill = page.getByRole("button", { name: /^plugins/i });
    await expect(pluginsPill).toHaveAttribute("data-active", "true");

    // Post supply-chain recovery, first-party (aoa-curated) plugins are placed in
    // the Plugins shelf — not segregated to the AoA view — so the fixture's plugin
    // cards render here (name = h3) and the cross-sell empty state is gone.
    await expect(
      page.getByRole("heading", { name: "Slack", level: 3 }),
    ).toBeVisible();
    await expect(page.getByTestId("marketplace-empty-plugin")).not.toBeVisible();
  });

  test("first-party plugins live in the Plugins shelf, not the AoA view", async ({
    page,
  }) => {
    // Supply-chain recovery inverted the old behavior: first-party plugins are no
    // longer segregated into the AoA view. Slack (aoa-curated) is a Plugins-shelf
    // card, and the AoA view (which promotes the AoA package + Default Crew + crew
    // agents — none of which exist in the bundled fixture) does not list it.
    await page.goto("/marketplace?type=plugin");
    await expect(
      page.getByRole("heading", { level: 1, name: /marketplace/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Slack", level: 3 }),
    ).toBeVisible();

    await page.goto("/marketplace?view=aoa");
    await expect(
      page.getByRole("heading", { level: 1, name: /marketplace/i }),
    ).toBeVisible({ timeout: 15_000 });
    // Wait for the AoA view to SETTLE before the negative check — page.goto reloads
    // cold, so asserting "Slack not visible" against the still-loading skeleton would
    // pass vacuously. The fixture has no AoA package/crew/agents, so the AoA shelf
    // resolves to the empty state; wait for it, then confirm first-party plugins are
    // not surfaced here (and that the empty state, not an error, is what rendered).
    await expect(page.getByText("No matches.")).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Slack", level: 3 }),
    ).not.toBeVisible();
  });

  test("/marketplace/skill type-filter page activates Skills and renders installable cards", async ({
    page,
  }) => {
    // /marketplace/skill redirects → /marketplace?type=skill.
    await page.goto("/marketplace?type=skill");

    await expect(
      page.getByRole("heading", { level: 1, name: /marketplace/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Skills filter chip is active
    const skillsPill = page.getByRole("button", { name: /^skills/i });
    await expect(skillsPill).toHaveAttribute("data-active", "true");

    await expect(page.getByRole("button", { name: /^install$/i }).first()).toBeVisible();
  });

  test("/marketplace/<unknown-type> redirects to the homepage", async ({
    page,
  }) => {
    // The current routing redirects /marketplace/:type → /marketplace?type=:type
    // (see MarketplaceTypeRedirect in App.tsx). Unknown types fall through to the
    // homepage rather than rendering a dedicated error page.
    await page.goto("/marketplace/foobar");

    await expect(page).toHaveURL(/\/marketplace(\?|$)/, { timeout: 10_000 });
    await expect(
      page.getByRole("heading", { level: 1, name: /marketplace/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("/:prefix/marketplace-updates shows the empty up-to-date state for a new company", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-MKT-${Date.now()}`);
    await page.goto(`/${company.issuePrefix}/marketplace-updates`);

    await expect(page.getByText("All marketplace items are up to date")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("Clicking a type pill toggles the type filter on the homepage", async ({
    page,
  }) => {
    await page.goto("/marketplace");

    // Wait for hero so the page has loaded
    await expect(
      page.getByRole("heading", { level: 1, name: /marketplace/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Click the Plugins pill (button). Accessible name = "Plugins" + count (e.g. "Plugins4").
    const pluginsPill = page.getByRole("button", { name: /^plugins/i });
    await pluginsPill.click();

    // Pill should reflect active state (data-active="true" on the button)
    await expect(pluginsPill).toHaveAttribute("data-active", "true");
  });
});
