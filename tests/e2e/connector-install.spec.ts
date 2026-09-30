import { expect, test, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";

/**
 * E2E: the connector journey — browse + install in MARKETPLACE → "Needs setup"
 * in SETTINGS → bind a credential → active.
 *
 * SURFACE SPLIT. Browsing and installing live on Marketplace → Connectors, the
 * sibling of Skills/Plugins/Agents/Teams; Settings → Connectors manages what is
 * already installed. This spec walks that hand-off end to end, because the seam
 * between two routes is exactly what unit tests cannot see.
 *
 * WHAT THIS IS FOR. The connector unit suite (172 adversarial tests) already
 * pins the security matrix: the D7 host-exec gate, consent-token binding, RBAC,
 * status derivation. None of that is re-litigated through a browser here.
 * What only a browser can prove is that the four surfaces the founder actually
 * touches are wired to each other: the shelf renders the server's decorated
 * catalog, Install posts the right entry, the resulting row reports the state
 * the server put it in, and the credential affordance on that row is the thing
 * that moves it to `active`. A connector installed but silently stuck at
 * `needs_credentials` with no visible next step was a real defect (P3a-11), and
 * it is invisible to every layer below this one.
 *
 * SHELF DETERMINISM. `connectors.json` is a remote file on a 6h TTL, so the
 * server serves `tests/e2e/fixtures/connectors.json` instead
 * (AOA_E2E_CONNECTOR_CATALOG_PATH, wired in playwright.config.ts). It goes
 * through the same parse/cache path as the CDN — the fixture replaces the bytes,
 * not the logic. Installing has to hit the server's own catalog, so intercepting
 * the response in the browser would not have worked.
 *
 * DEPLOYMENT MODE. The e2e instance boots `local_trusted`, so D7 admits stdio
 * and every install is implicitly approved. The refused-entry card (`installable:
 * false` + `unavailableReason`) is therefore unreachable here by construction —
 * it needs an `authenticated` host, and it is covered by the route and shelf
 * unit tests.
 */

const NOTES_ENTRY_ID = "e2e-notes-http";
const STDIO_ENTRY_ID = "e2e-local-stdio";
const NOTES_SECRET = "mcp:e2e-notes";

/** A registered-connector row, located by the connector's display name. */
function connectorRow(page: Page, displayName: string) {
  return page.locator('[data-testid^="connector-row-"]').filter({ hasText: displayName });
}

test.describe("connector shelf install journey", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Connectors-/);
  });
  test.afterEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-Connectors-/);
  });

  test("browse → install → needs setup → bind credential → active", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Connectors-${Date.now()}`);

    // The credential the founder will bind. Seeded through the API because the
    // Secrets surface has its own spec — this journey starts at the shelf.
    const secretRes = await request.post(`/api/companies/${company.id}/secrets`, {
      data: { name: NOTES_SECRET, value: "e2e-notes-token", description: "e2e" },
    });
    expect(secretRes.ok()).toBe(true);

    // Start where a founder with nothing installed starts. Landing on the
    // company-prefixed route is also what makes the seeded company the SELECTED
    // company, which is what the (company-scoped) marketplace surface installs
    // into — so the empty-state CTA is both the journey and the setup.
    await page.goto(`/${company.issuePrefix}/settings?tab=connectors`);
    await expect(page.getByRole("heading", { level: 2, name: /^Connectors\.$/ })).toBeVisible();
    const emptyState = page.getByTestId("connectors-empty-state");
    await expect(emptyState).toBeVisible();
    await emptyState.getByRole("link", { name: /browse connectors in marketplace/i }).click();

    await expect(page).toHaveURL(/\/marketplace\/connectors$/);
    await expect(page.getByRole("heading", { level: 1, name: /^Connectors\.$/ })).toBeVisible();

    // ── Browse (Marketplace) ────────────────────────────────────────────────
    const card = page.getByTestId(`connector-shelf-card-${NOTES_ENTRY_ID}`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    // The card must say the credential is coming BEFORE the install, not after.
    await expect(card).toContainText("Needs a credential: Notes API token");
    // Verified http entry: no consent interstitial, no refusal notice.
    await expect(card.getByTestId("verified-check")).toBeVisible();
    await expect(page.getByTestId("connector-unavailable-reason")).toHaveCount(0);

    // ── Install ─────────────────────────────────────────────────────────────
    await card.getByRole("button", { name: "Install E2E Notes" }).click();

    // The post-install notice must NAME the next step. Silence here is the
    // failure mode the whole credential affordance exists to close.
    await expect(page.getByText(/is installed but needs a credential/i)).toBeVisible();

    // Installed twice is a 409, so the shelf must stop offering it.
    await expect(card.getByText("Installed", { exact: true })).toBeVisible();

    // ── "Needs setup" (Settings) ────────────────────────────────────────────
    await page.goto(`/${company.issuePrefix}/settings?tab=connectors`);
    await expect(page.getByRole("heading", { level: 2, name: /^Connectors\.$/ })).toBeVisible();
    // Settings must no longer render a browsable catalog.
    await expect(page.getByTestId(`connector-shelf-card-${NOTES_ENTRY_ID}`)).toHaveCount(0);
    const row = connectorRow(page, "E2E Notes");
    await expect(row).toBeVisible();
    await expect(row.getByText("Needs setup", { exact: true })).toBeVisible();
    await expect(row).toContainText("This connector needs a credential before agents can use it.");

    // ── Bind the credential ─────────────────────────────────────────────────
    await row.getByRole("button", { name: "Add credential" }).click();
    await row.getByLabel("Secret reference").fill(NOTES_SECRET);
    await row.getByRole("button", { name: /^save credential$/i }).click();

    // ── Active ──────────────────────────────────────────────────────────────
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    await expect(row.getByText("Needs setup", { exact: true })).toHaveCount(0);
    // The next-step prompt must clear with the state it described.
    await expect(row).not.toContainText("needs a credential before agents can use it");
  });

  test("unverified stdio entry installs only through the command-consent dialog", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-Connectors-Stdio-${Date.now()}`);

    // Select the seeded company (the marketplace surface installs into the
    // selected company) before hopping to the global marketplace route.
    await page.goto(`/${company.issuePrefix}/settings?tab=connectors`);
    await expect(page.getByRole("heading", { level: 2, name: /^Connectors\.$/ })).toBeVisible();
    await page.goto(`/marketplace/connectors`);
    await expect(page.getByRole("heading", { level: 1, name: /^Connectors\.$/ })).toBeVisible();

    const card = page.getByTestId(`connector-shelf-card-${STDIO_ENTRY_ID}`);
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("verified-check")).toHaveCount(0);

    await card.getByRole("button", { name: "Install E2E Local Tool" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // The argv shown must be the literal argv the token is bound to — anything
    // prettified or truncated would be a lie about what executes on the host.
    // WS2: the fixture package is exact-version pinned (the create-time
    // command-safety gate requires it), so the consent line shows the pin too.
    await expect(dialog.getByTestId("connector-consent-command")).toHaveText(
      "npx -y @e2e/local-tool@1.0.0",
    );

    // Install stays disabled until the founder actually ticks the box.
    const confirmBtn = dialog.getByRole("button", { name: /^install$/i });
    await expect(confirmBtn).toBeDisabled();
    await dialog.getByRole("checkbox").click();
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("connector-install-notice")).toBeVisible();

    // No credential required, local_trusted ⇒ implicitly approved ⇒ active.
    await page.goto(`/${company.issuePrefix}/settings?tab=connectors`);
    const row = connectorRow(page, "E2E Local Tool");
    await expect(row).toBeVisible();
    await expect(row.getByText("Active", { exact: true })).toBeVisible();
    await expect(row).toContainText("npx");
  });
});
