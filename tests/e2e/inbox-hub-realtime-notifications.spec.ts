import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { cleanupTestCompanies, seedCompany } from "./helpers/seed-company";
import { seedHubItem } from "./helpers/seed-hub-item";
import {
  ensureLocalBoardUser,
  seedNotificationDigestItem,
} from "./helpers/seed-notification-digest";
import { expectActiveHubTab } from "./helpers/hub-tabs";

type DeliveryMode = "realtime" | "digest" | "silent";

test.describe("Inbox Hub realtime notifications", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupTestCompanies(request, /^E2E-HUB-W2L3-/);
  });

  test("operator sees realtime toasts, digest suppression, silent suppression, and quiet-hours fallback", async ({
    page,
    request,
  }) => {
    const company = await seedCompany(request, `E2E-HUB-W2L3-${Date.now()}`);
    await ensureLocalBoardUser();

    await installLiveSocketProbe(page, company.id);
    await page.goto(`/${company.issuePrefix}/inbox/notifications`);
    await expect(page.getByRole("navigation", { name: /hub lanes/i })).toBeVisible();
    await waitForLiveSocket(page, company.id);

    await updateNotificationPreferences(request, company.id, {
      deliveryMode: "realtime",
      quietHours: { enabled: false, start: "18:00", end: "09:00", timezone: "UTC" },
    });

    const realtime = await seedRealtimeHubItem(company.id, {
      sourceId: "realtime",
      title: "W2 realtime reminder toast",
    });
    await publishHubItemChange(request, company.id, realtime);
    await expect(toast(page, "W2 realtime reminder toast")).toBeVisible({
      timeout: 15_000,
    });
    await page.goto(`/${company.issuePrefix}/inbox/notifications/${realtime.id}`);
    await expectActiveHubTab(page, /W2 realtime reminder toast/i);
    await dismissToasts(page);

    // The in-hub settings gear was removed (its controls moved to Settings →
    // Inbox). This test must keep the hub mounted so the live socket stays open,
    // so delivery-mode changes are driven via the same preferences PATCH the
    // panel calls — the suppression decision is made server-side at publish time.
    await updateNotificationPreferences(request, company.id, {
      deliveryMode: "digest",
      quietHours: { enabled: false, start: "18:00", end: "09:00", timezone: "UTC" },
    });

    const digest = await seedRealtimeHubItem(company.id, {
      sourceId: "digest",
      title: "W2 digest reminder summary",
    });
    await seedNotificationDigestItem({
      companyId: company.id,
      hubItemId: digest.id,
      semanticType: "reminder",
    });
    await publishHubItemChange(request, company.id, digest);

    await expect(page.getByRole("button", { name: /W2 digest reminder summary/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(toast(page, "W2 digest reminder summary")).toHaveCount(0);

    await updateNotificationPreferences(request, company.id, {
      deliveryMode: "silent",
      quietHours: { enabled: false, start: "18:00", end: "09:00", timezone: "UTC" },
    });

    const silent = await seedRealtimeHubItem(company.id, {
      sourceId: "silent",
      title: "W2 silent reminder hidden",
    });
    await publishHubItemChange(request, company.id, silent);

    await expect(page.getByRole("button", { name: /W2 silent reminder hidden/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(toast(page, "W2 silent reminder hidden")).toHaveCount(0);
    await expect(page.getByText("W2 silent reminder hidden")).toHaveCount(1);

    await updateNotificationPreferences(request, company.id, {
      deliveryMode: "realtime",
      quietHours: { enabled: true, start: "00:00", end: "00:00", timezone: "UTC" },
    });
    await page.reload();
    await expect(page.getByRole("navigation", { name: /hub lanes/i })).toBeVisible();
    await waitForLiveSocket(page, company.id);

    const quiet = await seedRealtimeHubItem(company.id, {
      sourceId: "quiet-hours",
      title: "W2 quiet hours digest fallback",
    });
    await seedNotificationDigestItem({
      companyId: company.id,
      hubItemId: quiet.id,
      semanticType: "reminder",
    });
    await publishHubItemChange(request, company.id, quiet);

    await expect(page.getByRole("button", { name: /W2 quiet hours digest fallback/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(toast(page, "W2 quiet hours digest fallback")).toHaveCount(0);

    expect(realtime.id).toBeTruthy();
  });
});

async function updateNotificationPreferences(
  request: APIRequestContext,
  companyId: string,
  options: {
    deliveryMode: DeliveryMode;
    quietHours: { enabled: boolean; start: string; end: string; timezone: string };
  },
) {
  const res = await request.patch(
    `/api/companies/${companyId}/notifications/preferences/me`,
    {
      data: {
        rules: [
          {
            semanticType: "reminder",
            deliveryMode: options.deliveryMode,
            toastEnabled: true,
          },
        ],
        quietHours: options.quietHours,
        digest: { enabled: true, cadence: "daily" },
      },
    },
  );
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function seedRealtimeHubItem(
  companyId: string,
  input: { sourceId: string; title: string },
) {
  return seedHubItem({
    companyId,
    semanticType: "reminder",
    sourceType: `w2-layer3-e2e-${input.sourceId}`,
    sourceId: input.sourceId,
    title: input.title,
    ownerPool: "board",
  });
}

function liveSocketPath(companyId: string) {
  return `/api/companies/${encodeURIComponent(companyId)}/events/ws`;
}

async function installLiveSocketProbe(page: Page, companyId: string) {
  const expectedPath = liveSocketPath(companyId);
  await page.addInitScript(({ expectedPath }) => {
    const win = window as typeof window & {
      __aoaLiveSocketOpen?: Record<string, boolean>;
    };
    const NativeWebSocket = window.WebSocket;
    win.__aoaLiveSocketOpen = win.__aoaLiveSocketOpen ?? {};

    function PatchedWebSocket(url: string | URL, protocols?: string | string[]) {
      const socket =
        protocols === undefined
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols);
      if (String(url).includes(expectedPath)) {
        win.__aoaLiveSocketOpen![expectedPath] = false;
        socket.addEventListener("open", () => {
          win.__aoaLiveSocketOpen![expectedPath] = true;
        });
        socket.addEventListener("close", () => {
          win.__aoaLiveSocketOpen![expectedPath] = false;
        });
      }
      return socket;
    }

    Object.setPrototypeOf(PatchedWebSocket, NativeWebSocket);
    PatchedWebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket = PatchedWebSocket as unknown as typeof WebSocket;
  }, { expectedPath });
}

async function waitForLiveSocket(page: Page, companyId: string) {
  const expectedPath = liveSocketPath(companyId);
  await page.waitForFunction(
    (path) => {
      const win = window as typeof window & {
        __aoaLiveSocketOpen?: Record<string, boolean>;
      };
      return win.__aoaLiveSocketOpen?.[path] === true;
    },
    expectedPath,
    { timeout: 15_000 },
  );
}

async function publishHubItemChange(
  request: APIRequestContext,
  companyId: string,
  item: Awaited<ReturnType<typeof seedHubItem>>,
) {
  const res = await request.post(`/api/companies/${companyId}/hub-items/${item.id}/action`, {
    data: { action: "claim", expectedVersion: item.version },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

function toast(page: Page, title: string) {
  return page.locator('[role="status"]').filter({ hasText: title });
}

async function dismissToasts(page: Page) {
  const buttons = page.getByRole("button", { name: /dismiss notification/i });
  while ((await buttons.count()) > 0) {
    await buttons.first().click();
  }
}
