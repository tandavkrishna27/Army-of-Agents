import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { MarketplacePrefsSection } from "../MarketplacePrefsSection";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/hooks/useMarketplaceSettings", () => ({
  useMarketplaceSettings: () => ({
    data: {
      pluginUpdatePolicy: "notify_all",
      skillUpdatePolicy: "notify",
      agentUpdatePolicy: "notify",
      teamUpdatePolicy: "notify",
      showTrustBadges: true,
      showSourceInfo: true,
      allowTeamLeadPlugins: false,
      teamMemberCanRequestInstall: false,
      requireFounderApproval: false,
      catalogRefreshHours: 6,
      updateCheckHours: 24,
      updateWindow: "anytime",
    },
    isLoading: false,
  }),
  usePatchMarketplaceSettings: () => ({
    mutateAsync: vi.fn().mockResolvedValue({}),
  }),
}));

vi.mock("../MarketplaceUpdatesPanel", () => ({
  MarketplaceUpdatesPanel: () => <div>Marketplace updates</div>,
}));

function renderSection(initialPath = "/MAR/settings?tab=marketplace") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <TooltipProvider>
          <MarketplacePrefsSection />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MarketplacePrefsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders marketplace section tabs and preference controls by default", () => {
    renderSection();

    expect(screen.getByRole("tab", { name: "Preferences" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Updates" })).toBeInTheDocument();
    expect(screen.getByText("Plugin update policy")).toBeInTheDocument();
  });

  it("selects the updates section from the section query param", () => {
    renderSection("/MAR/settings?tab=marketplace&section=updates");

    expect(screen.getByRole("tab", { name: "Updates" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Marketplace updates")).toBeInTheDocument();
  });
});
