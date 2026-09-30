import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../__tests__/test-utils";
import { RoutingDialControl } from "../RoutingDialControl";

// --- API mock ---

const mockGetConfig = vi.fn();
const mockUpdateConfig = vi.fn();

vi.mock("../../../api/internal-agent", () => ({
  internalAgentApi: {
    getConfig: (...args: unknown[]) => mockGetConfig(...args),
    updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
  },
}));

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: "cfg-1",
    executionMode: "cli",
    provider: null,
    model: null,
    cliTool: null,
    autonomyLevel: 1,
    enabledCapabilities: [],
    notificationPreference: "all",
    contextTokenBudget: 8000,
    budgetMonthlyCents: null,
    spentMonthlyCents: 0,
    proactiveIntervalMinutes: 240,
    lastProactiveRunAt: null,
    cheapModel: null,
    runtimeApprovalsEnabled: false,
    runtimeAllowAlwaysEnabled: false,
    vendorCliBypassEnabled: false,
    inboundRoutingLevel: "off",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue(makeConfig());
  mockUpdateConfig.mockResolvedValue(makeConfig());
});

describe("RoutingDialControl", () => {
  it("renders all 4 routing level options with their names", async () => {
    renderWithProviders(<RoutingDialControl companyId="comp-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("routing-dial")).toBeInTheDocument();
    });

    const select = screen.getByTestId("routing-dial") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.text);

    expect(options).toContain("Off");
    expect(options).toContain("Suggest");
    expect(options).toContain("Auto-attach");
    expect(options).toContain("Full-auto");
    expect(options).toHaveLength(4);
  });

  it("reflects the current routing level returned by getConfig", async () => {
    mockGetConfig.mockResolvedValue(makeConfig({ inboundRoutingLevel: "suggest" }));

    renderWithProviders(<RoutingDialControl companyId="comp-1" />);

    await waitFor(() => {
      const select = screen.getByTestId("routing-dial") as HTMLSelectElement;
      expect(select.value).toBe("suggest");
    });
  });

  it("uses 'off' as the default when config returns off", async () => {
    mockGetConfig.mockResolvedValue(makeConfig({ inboundRoutingLevel: "off" }));

    renderWithProviders(<RoutingDialControl companyId="comp-1" />);

    await waitFor(() => {
      const select = screen.getByTestId("routing-dial") as HTMLSelectElement;
      expect(select.value).toBe("off");
    });
  });

  it("calls updateConfig with the new level when a different option is selected", async () => {
    const user = userEvent.setup();
    mockGetConfig.mockResolvedValue(makeConfig({ inboundRoutingLevel: "off" }));
    mockUpdateConfig.mockResolvedValue(makeConfig({ inboundRoutingLevel: "auto_attach" }));

    renderWithProviders(<RoutingDialControl companyId="comp-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("routing-dial")).toBeInTheDocument();
    });

    await user.selectOptions(screen.getByTestId("routing-dial"), "auto_attach");

    expect(mockUpdateConfig).toHaveBeenCalledWith("comp-1", {
      inboundRoutingLevel: "auto_attach",
    });
  });

  it("option values match the INBOUND_ROUTING_LEVELS value keys", async () => {
    renderWithProviders(<RoutingDialControl companyId="comp-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("routing-dial")).toBeInTheDocument();
    });

    const select = screen.getByTestId("routing-dial") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);

    expect(values).toContain("off");
    expect(values).toContain("suggest");
    expect(values).toContain("auto_attach");
    expect(values).toContain("full_auto");
  });

  it("does not call updateConfig when the same option is re-selected", async () => {
    const user = userEvent.setup();
    mockGetConfig.mockResolvedValue(makeConfig({ inboundRoutingLevel: "suggest" }));

    renderWithProviders(<RoutingDialControl companyId="comp-1" />);

    await waitFor(() => {
      expect(screen.getByTestId("routing-dial")).toBeInTheDocument();
    });

    // Re-select the same value — onChange fires but we guard against it
    await user.selectOptions(screen.getByTestId("routing-dial"), "suggest");

    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("does not render the dial when canEdit is false (select is disabled)", async () => {
    renderWithProviders(<RoutingDialControl companyId="comp-1" canEdit={false} />);

    await waitFor(() => {
      expect(screen.getByTestId("routing-dial")).toBeInTheDocument();
    });

    const select = screen.getByTestId("routing-dial") as HTMLSelectElement;
    expect(select).toBeDisabled();
  });
});
