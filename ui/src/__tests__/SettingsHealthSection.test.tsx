import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HealthSection } from "@/components/settings/sections/HealthSection";
import { healthApi } from "@/api/health";
import { mockCompanyContext, renderWithProviders } from "./test-utils";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => mockCompanyContext,
}));

vi.mock("@/api/health", () => ({
  healthApi: {
    company: vi.fn(),
  },
}));

describe("HealthSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyContext.selectedCompanyId = "comp-1";
    vi.mocked(healthApi.company).mockResolvedValue({
      scope: "company",
      companyId: "comp-1",
      status: "needs_attention",
      summary: {
        errorCount: 0,
        warningCount: 1,
        infoCount: 1,
        checkedAt: "2026-05-25T00:00:00.000Z",
      },
      findings: [
        {
          id: "w",
          scope: "company",
          category: "openclaw",
          severity: "warning",
          title: "OpenClaw endpoint warning",
          message: "Endpoint uses loopback.",
          detectedAt: "2026-05-25T00:00:00.000Z",
        },
        {
          id: "i",
          scope: "company",
          category: "runtime",
          severity: "info",
          title: "Company health checks ran",
          message: "Checks ran.",
          detectedAt: "2026-05-25T00:00:00.000Z",
        },
      ],
      sections: { liveOperations: { activeRunCount: 1, recentFailureCount: 0 } },
    });
  });

  it("renders needs attention findings and refresh control", async () => {
    renderWithProviders(<HealthSection />);

    expect((await screen.findAllByText(/Needs attention/i)).length).toBeGreaterThan(0);
    expect(screen.getByText(/OpenClaw endpoint warning/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Refresh checks/i }));
    expect(healthApi.company).toHaveBeenCalledWith("comp-1");
  });
});
