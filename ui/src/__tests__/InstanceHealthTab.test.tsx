import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HealthReport } from "@armyofagents/shared";
import { InstanceHealthTab } from "@/components/settings/InstanceHealthTab";
import { healthApi } from "@/api/health";
import { renderWithProviders } from "./test-utils";

vi.mock("@/api/health", () => ({
  healthApi: {
    instance: vi.fn(),
  },
}));

const report: HealthReport = {
  scope: "instance",
  status: "needs_attention",
  summary: {
    errorCount: 0,
    warningCount: 1,
    infoCount: 1,
    checkedAt: "2026-05-25T10:00:00.000Z",
  },
  findings: [
    {
      id: "plugin-linear",
      scope: "instance",
      category: "integration",
      severity: "warning",
      title: "Plugin Linear is error",
      message: "Linear worker reported a setup error.",
      detectedAt: "2026-05-25T10:00:00.000Z",
    },
    {
      id: "instance-health-ready",
      scope: "instance",
      category: "setup",
      severity: "info",
      title: "Instance health checks are available",
      message: "Instance health checks completed.",
      detectedAt: "2026-05-25T10:00:00.000Z",
    },
  ],
  sections: {
    platform: {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      plugins: {
        ready: 0,
        notReady: 1,
        plugins: [
          {
            id: "plugin-1",
            pluginKey: "linear",
            displayName: "Linear",
            status: "error",
            lastError: "Token missing.",
          },
        ],
      },
    },
  },
};

describe("InstanceHealthTab", () => {
  it("renders instance health and refreshes checks", async () => {
    vi.mocked(healthApi.instance).mockResolvedValue(report);
    const user = userEvent.setup();

    renderWithProviders(<InstanceHealthTab />);

    expect(await screen.findByText("Plugin Linear is error")).toBeInTheDocument();
    expect(screen.getByText("Linear")).toBeInTheDocument();
    expect(screen.getByText("local_trusted")).toBeInTheDocument();
    expect(screen.getByText("private")).toBeInTheDocument();
    expect(screen.queryByText(/\/10/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Refresh checks/i }));

    await waitFor(() => {
      expect(healthApi.instance).toHaveBeenCalledTimes(2);
    });
  });
});
