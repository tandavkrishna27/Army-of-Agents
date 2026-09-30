import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { freshOnboardingState } from "./helpers/onboarding-e2e";
import { seedCompany } from "./helpers/seed-company";
import { newIdentityContext } from "./helpers/second-identity";

/**
 * Invited-teammate journey e2e (N3).
 *
 * Founder side = the default cookie-less request fixture (the local-board
 * escape-hatch actor — creates companies/invites and approves/rejects join
 * requests via API, like the seed helpers). Teammate side = a SECOND browser
 * context authenticated via the test-support session mint (a real better-auth
 * session cookie for a fresh verified user — see helpers/second-identity.ts).
 *
 * Each spec mints a UNIQUE teammate email, so no cross-spec identity state
 * leaks; founder-side state is reset by freshOnboardingState (progress reset +
 * E2E-company cleanup).
 */

test.beforeEach(async ({ request }) => {
  await freshOnboardingState(request);
});

/** Founder API: create an email-targeted human company-join invite. */
async function createHumanInvite(
  request: APIRequestContext,
  companyId: string,
  email: string,
  role: "team_member" | "team_lead" = "team_member",
): Promise<{ id: string; token: string }> {
  const res = await request.post(`/api/companies/${companyId}/invites`, {
    data: {
      allowedJoinTypes: "human",
      defaultsPayload: { teamInvite: { email, role } },
    },
  });
  if (!res.ok()) {
    throw new Error(`createHumanInvite failed: ${res.status()} ${await res.text().catch(() => "")}`);
  }
  const body = (await res.json()) as { id: string; token: string };
  if (!body.token) throw new Error(`invite response missing token: ${JSON.stringify(body)}`);
  return { id: body.id, token: body.token };
}

/** Founder API: list a company's join requests. */
async function listJoinRequests(
  request: APIRequestContext,
  companyId: string,
  status?: string,
): Promise<Array<{ id: string; status: string; requestType: string }>> {
  const url = `/api/companies/${companyId}/join-requests${status ? `?status=${status}` : ""}`;
  const res = await request.get(url);
  if (!res.ok()) {
    throw new Error(`listJoinRequests failed: ${res.status()} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as Array<{ id: string; status: string; requestType: string }>;
}

/** Drive the shared Human Operating Profile step (Name + Title + Timezone). */
async function completeProfileStep(page: Page, name = "E2E Invitee") {
  await expect(page.getByRole("heading", { name: /first,\s*you/i })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Title", { exact: true }).selectOption("Engineer");
  await page.getByLabel("Timezone", { exact: true }).selectOption("UTC");
  await page.getByRole("button", { name: /continue/i }).click();
}

/** The admitted teammate lands on "/" INSIDE the company (not the empty lobby). */
async function expectInsideCompany(page: Page, companyName: string, timeout = 30_000) {
  // Post-admission the invited journey shows a "Welcome to {company}" terminal
  // (a MiniMap of the company you're joining) gated behind an explicit
  // "Enter {company}" button — click through it to reach the returning-user
  // Lobby. companyName is `E2E-…-${Date.now()}` (letters/digits/hyphens only),
  // so it needs no regex escaping.
  await page
    .getByRole("button", { name: new RegExp(`enter ${companyName}`, "i") })
    .click({ timeout });
  await expect(page.getByRole("heading", { name: /welcome back/i })).toBeVisible({ timeout });
  // .first(): the company name may legitimately render more than once on the
  // landed page (card title, subtitles, …) — any visible occurrence proves the
  // membership rendered, and strict mode must not flake on a second mention.
  await expect(page.getByText(companyName).first()).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
}

test("link accept → profile → auto-admit lands inside the company", async ({
  request,
  browser,
}) => {
  const companyName = `E2E-Invited-Admit-${Date.now()}`;
  const company = await seedCompany(request, companyName);
  const email = `e2e-invitee-admit-${Date.now()}@example.com`;
  const invite = await createHumanInvite(request, company.id, email);

  const { context } = await newIdentityContext(browser, request, {
    email,
    name: "E2E Invitee",
  });
  try {
    const tPage = await context.newPage();

    // Invite landing (already signed in via the minted cookie) — the landing
    // names the company being joined.
    await tPage.goto(`/invite/${invite.token}`);
    await expect(tPage.getByRole("heading", { name: `Join ${companyName} on AoA` })).toBeVisible({
      timeout: 20_000,
    });
    await tPage.getByRole("button", { name: /join as a human/i }).click();
    await tPage.getByRole("button", { name: /submit join request/i }).click();

    // Accept hands off into the guided invited onboarding.
    await expect(tPage).toHaveURL(/\/onboarding\/join\?company=/, { timeout: 15_000 });
    await completeProfileStep(tPage);

    // Verified email matches the invite → the invitation carried the approval.
    await expectInsideCompany(tPage, companyName);

    // Server-side: the join request was auto-approved (no founder action).
    const requests = await listJoinRequests(request, company.id);
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe("approved");
  } finally {
    await context.close();
  }
});

test("tokenless entry shows the consent card and only joins on explicit click", async ({
  request,
  browser,
}) => {
  const companyName = `E2E-Invited-Consent-${Date.now()}`;
  const company = await seedCompany(request, companyName);
  const email = `e2e-invitee-consent-${Date.now()}@example.com`;
  await createHumanInvite(request, company.id, email);

  const { context } = await newIdentityContext(browser, request, {
    email,
    name: "E2E Consent Invitee",
  });
  try {
    const tPage = await context.newPage();

    // Never touches the invite link: the ROOT gate detects the open invite by
    // verified-email match and routes into the guided join flow.
    await tPage.goto("/");
    await completeProfileStep(tPage, "E2E Consent Invitee");

    // The CONSENT card (naming the company) — detection alone must not file or
    // claim anything. Scoped to the heading: the Join button repeats the name.
    await expect(
      tPage.getByRole("heading", {
        name: new RegExp(`you've been invited to join ${companyName}`, "i"),
      }),
    ).toBeVisible({ timeout: 20_000 });
    expect(await listJoinRequests(request, company.id)).toHaveLength(0);

    // Reload the root: still consent-gated, still no admission.
    await tPage.goto("/");
    await expect(
      tPage.getByRole("heading", { name: /you've been invited to join/i }),
    ).toBeVisible({ timeout: 20_000 });
    expect(await listJoinRequests(request, company.id)).toHaveLength(0);

    // Explicit consent → tokenless claim + auto-admit.
    await tPage.getByRole("button", { name: `Join ${companyName}` }).click();
    await expectInsideCompany(tPage, companyName);

    // The claim filed a join request and the email match auto-approved it.
    const requests = await listJoinRequests(request, company.id);
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe("approved");
  } finally {
    await context.close();
  }
});

test("email mismatch stays pending; founder approval auto-enters via polling", async ({
  request,
  browser,
}) => {
  const companyName = `E2E-Invited-Approve-${Date.now()}`;
  const company = await seedCompany(request, companyName);
  const invitedEmail = `e2e-someone-else-${Date.now()}@example.com`;
  const teammateEmail = `e2e-invitee-mismatch-${Date.now()}@example.com`;
  const invite = await createHumanInvite(request, company.id, invitedEmail);

  const { context } = await newIdentityContext(browser, request, {
    email: teammateEmail,
    name: "E2E Mismatch Invitee",
  });
  try {
    const tPage = await context.newPage();
    await tPage.goto(`/invite/${invite.token}`);
    await expect(tPage.getByRole("heading", { name: `Join ${companyName} on AoA` })).toBeVisible({
      timeout: 20_000,
    });
    await tPage.getByRole("button", { name: /submit join request/i }).click();
    await expect(tPage).toHaveURL(/\/onboarding\/join\?company=/, { timeout: 15_000 });
    await completeProfileStep(tPage, "E2E Mismatch Invitee");

    // No verified-email match → finalize leaves the request with the admin.
    await expect(tPage.getByRole("heading", { name: /you're joining/i })).toBeVisible({
      timeout: 20_000,
    });
    // Pending copy (distinct from the invite_invalid phase, which also mentions
    // the admin but starts "Your invite link is no longer valid").
    await expect(
      tPage.getByText(/^Your request is with the admin for approval/),
    ).toBeVisible();

    // Founder approves via API.
    const pending = await listJoinRequests(request, company.id, "pending_approval");
    expect(pending).toHaveLength(1);
    const approveRes = await request.post(
      `/api/companies/${company.id}/join-requests/${pending[0].id}/approve`,
    );
    expect(approveRes.ok()).toBe(true);

    // The polling terminal (7s tick) auto-navigates into the company.
    await expectInsideCompany(tPage, companyName, 20_000);
  } finally {
    await context.close();
  }
});

test("rejection surfaces the not-approved terminal", async ({ request, browser }) => {
  const companyName = `E2E-Invited-Reject-${Date.now()}`;
  const company = await seedCompany(request, companyName);
  const invitedEmail = `e2e-someone-else-${Date.now()}@example.com`;
  const teammateEmail = `e2e-invitee-reject-${Date.now()}@example.com`;
  const invite = await createHumanInvite(request, company.id, invitedEmail);

  const { context } = await newIdentityContext(browser, request, {
    email: teammateEmail,
    name: "E2E Reject Invitee",
  });
  try {
    const tPage = await context.newPage();
    await tPage.goto(`/invite/${invite.token}`);
    await expect(tPage.getByRole("heading", { name: `Join ${companyName} on AoA` })).toBeVisible({
      timeout: 20_000,
    });
    await tPage.getByRole("button", { name: /submit join request/i }).click();
    await expect(tPage).toHaveURL(/\/onboarding\/join\?company=/, { timeout: 15_000 });
    await completeProfileStep(tPage, "E2E Reject Invitee");

    await expect(tPage.getByRole("heading", { name: /you're joining/i })).toBeVisible({
      timeout: 20_000,
    });

    // Founder rejects via API.
    const pending = await listJoinRequests(request, company.id, "pending_approval");
    expect(pending).toHaveLength(1);
    const rejectRes = await request.post(
      `/api/companies/${company.id}/join-requests/${pending[0].id}/reject`,
    );
    expect(rejectRes.ok()).toBe(true);

    // The next poll tick lands on the not-approved terminal.
    await expect(tPage.getByRole("heading", { name: /request not approved/i })).toBeVisible({
      timeout: 20_000,
    });
  } finally {
    await context.close();
  }
});
