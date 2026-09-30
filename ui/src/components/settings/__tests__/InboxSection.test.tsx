import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SETTINGS_SECTIONS } from "../SettingsLayout";
import { VALID_SECTIONS } from "@/pages/SettingsPage";
import { InboxSection } from "../sections/InboxSection";
import { hubItemsApi } from "@/api/hub-items";

vi.mock("@/api/hub-items", () => ({
  hubItemsApi: {
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
    autopilotPolicy: { get: vi.fn(), update: vi.fn(), reset: vi.fn() },
    notificationPreferences: { get: vi.fn(), update: vi.fn(), reset: vi.fn() },
    notificationDigest: { list: vi.fn(), ack: vi.fn() },
  },
}));

const COMPANY_ID = "company-1";
const useCompanyMock = vi.fn(() => ({ selectedCompanyId: COMPANY_ID as string | null }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => useCompanyMock() }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: vi.fn() }) }));

function prefs() {
  return {
    defaultLanding: "home",
    visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
    groupMode: "auto",
    density: "comfortable",
    showAutopilotEntry: true,
    updatedAt: null,
  };
}
function policy() {
  return {
    mode: "off",
    handledToday: 0,
    lastHandledAt: null,
    rules: [{ semanticType: "run_complete", action: "none", minTrustScore: 100, enabled: false }],
    updatedAt: null,
  };
}
function notif() {
  return {
    rules: [{ semanticType: "reminder", deliveryMode: "realtime", toastEnabled: true }],
    quietHours: { enabled: false, start: "18:00", end: "09:00", timezone: "UTC" },
    digest: { enabled: true, cadence: "daily" },
    updatedAt: null,
  };
}

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <InboxSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useCompanyMock.mockReturnValue({ selectedCompanyId: COMPANY_ID });
  vi.mocked(hubItemsApi.getPreferences).mockResolvedValue(prefs() as never);
  vi.mocked(hubItemsApi.updatePreferences).mockResolvedValue(prefs() as never);
  vi.mocked(hubItemsApi.autopilotPolicy.get).mockResolvedValue(policy() as never);
  vi.mocked(hubItemsApi.autopilotPolicy.update).mockResolvedValue(policy() as never);
  vi.mocked(hubItemsApi.autopilotPolicy.reset).mockResolvedValue(policy() as never);
  vi.mocked(hubItemsApi.notificationPreferences.get).mockResolvedValue(notif() as never);
  vi.mocked(hubItemsApi.notificationPreferences.update).mockResolvedValue(notif() as never);
  vi.mocked(hubItemsApi.notificationPreferences.reset).mockResolvedValue(notif() as never);
  vi.mocked(hubItemsApi.notificationDigest.list).mockResolvedValue({ items: [] } as never);
  vi.mocked(hubItemsApi.notificationDigest.ack).mockResolvedValue({ acked: 0 } as never);
});

describe("Settings -> Inbox registration", () => {
  it("registers an Inbox entry in the Operations group", () => {
    const ops = SETTINGS_SECTIONS.find((g) => g.group === "Operations");
    expect(ops?.items.map((i) => i.id)).toContain("inbox");
  });
  it("accepts every registered section id as a ?tab= value", () => {
    for (const group of SETTINGS_SECTIONS) {
      for (const item of group.items) {
        expect(VALID_SECTIONS).toContain(item.id);
      }
    }
  });
});

describe("InboxSection", () => {
  it("renders the settings panel with the fetched values", async () => {
    renderSection();
    expect(
      await screen.findByRole("combobox", { name: /default landing/i }),
    ).toHaveValue("home");
    expect(screen.getByRole("heading", { name: /^inbox/i })).toBeInTheDocument();
  });

  it("persists a density change through updatePreferences", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.selectOptions(
      await screen.findByRole("combobox", { name: /density/i }),
      "compact",
    );
    await waitFor(() => {
      expect(hubItemsApi.updatePreferences).toHaveBeenCalledWith(COMPANY_ID, {
        density: "compact",
      });
    });
  });

  it("persists an autopilot mode change", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.selectOptions(
      await screen.findByRole("combobox", { name: /autopilot mode/i }),
      "drive",
    );
    await waitFor(() => {
      expect(hubItemsApi.autopilotPolicy.update).toHaveBeenCalledWith(COMPANY_ID, {
        mode: "drive",
      });
    });
  });

  // C3 (a): a miswired onUpdateNotificationPreferences would ship green without this.
  it("persists a notification delivery change through notificationPreferences.update", async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole("button", { name: /notification preferences/i }),
    );
    await user.selectOptions(
      await screen.findByRole("combobox", { name: /reminder delivery/i }),
      "digest",
    );
    await waitFor(() => {
      expect(hubItemsApi.notificationPreferences.update).toHaveBeenCalledWith(
        COMPANY_ID,
        expect.objectContaining({
          rules: expect.arrayContaining([
            expect.objectContaining({ semanticType: "reminder", deliveryMode: "digest" }),
          ]),
        }),
      );
    });
  });

  // C3 (b): a miswired onAckDigest would ship green without this.
  it("acknowledges a pending digest item through notificationDigest.ack", async () => {
    vi.mocked(hubItemsApi.notificationDigest.list).mockResolvedValue({
      items: [{ id: "digest-1", title: "Digest reminder" }],
    } as never);
    const user = userEvent.setup();
    renderSection();
    await user.click(
      await screen.findByRole("button", { name: /notification preferences/i }),
    );
    await user.click(await screen.findByRole("button", { name: /acknowledge digest/i }));
    await waitFor(() => {
      expect(hubItemsApi.notificationDigest.ack).toHaveBeenCalledWith(COMPANY_ID);
    });
  });

  it("shows the company-selection guard when no company is selected", () => {
    useCompanyMock.mockReturnValue({ selectedCompanyId: null });
    renderSection();
    expect(screen.getByText(/select a company/i)).toBeInTheDocument();
    expect(hubItemsApi.getPreferences).not.toHaveBeenCalled();
  });
});
