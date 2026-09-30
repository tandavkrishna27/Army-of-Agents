import { describe, it, expect, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./test-utils";
import { BackupsTab } from "../components/settings/BackupsTab";
import type { InstanceGeneralSettings } from "@armyofagents/shared";

function makeSettings(overrides: Partial<InstanceGeneralSettings> = {}): InstanceGeneralSettings {
  return {
    censorUsernameInLogs: false,
    keyboardShortcuts: false,
    feedbackDataSharingPreference: "not_allowed",
    backupRetention: { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 },
    ...overrides,
  };
}

describe("BackupsTab", () => {
  it("renders three retention groups with presets", () => {
    renderWithProviders(
      <BackupsTab
        settings={makeSettings()}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
      />,
    );

    const daily = screen.getByRole("radiogroup", { name: /daily retention/i });
    const weekly = screen.getByRole("radiogroup", { name: /weekly retention/i });
    const monthly = screen.getByRole("radiogroup", { name: /monthly retention/i });

    expect(within(daily).getAllByRole("radio")).toHaveLength(3);
    expect(within(weekly).getAllByRole("radio")).toHaveLength(3);
    expect(within(monthly).getAllByRole("radio")).toHaveLength(3);
  });

  it("marks the current values as checked", () => {
    renderWithProviders(
      <BackupsTab
        settings={makeSettings({ backupRetention: { dailyDays: 14, weeklyWeeks: 2, monthlyMonths: 6 } })}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
      />,
    );

    const daily = screen.getByRole("radiogroup", { name: /daily retention/i });
    expect(within(daily).getByRole("radio", { name: /14 days/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const weekly = screen.getByRole("radiogroup", { name: /weekly retention/i });
    expect(within(weekly).getByRole("radio", { name: /2 weeks/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const monthly = screen.getByRole("radiogroup", { name: /monthly retention/i });
    expect(within(monthly).getByRole("radio", { name: /6 months/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("calls onChange with merged backupRetention on preset click", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <BackupsTab
        settings={makeSettings()}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={onChange}
      />,
    );

    const daily = screen.getByRole("radiogroup", { name: /daily retention/i });
    await user.click(within(daily).getByRole("radio", { name: /14 days/i }));

    expect(onChange).toHaveBeenCalledWith({
      backupRetention: { dailyDays: 14, weeklyWeeks: 4, monthlyMonths: 1 },
    });
  });

  it("preserves other tiers when one tier changes", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <BackupsTab
        settings={makeSettings({ backupRetention: { dailyDays: 14, weeklyWeeks: 2, monthlyMonths: 3 } })}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={onChange}
      />,
    );

    const monthly = screen.getByRole("radiogroup", { name: /monthly retention/i });
    await user.click(within(monthly).getByRole("radio", { name: /6 months/i }));

    expect(onChange).toHaveBeenCalledWith({
      backupRetention: { dailyDays: 14, weeklyWeeks: 2, monthlyMonths: 6 },
    });
  });

  it("disables all presets while saving", () => {
    renderWithProviders(
      <BackupsTab
        settings={makeSettings()}
        isLoading={false}
        error={null}
        isSaving={true}
        onChange={vi.fn()}
      />,
    );

    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
  });

  it("falls back to default retention when settings is undefined", () => {
    renderWithProviders(
      <BackupsTab
        settings={undefined}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
      />,
    );

    const daily = screen.getByRole("radiogroup", { name: /daily retention/i });
    expect(within(daily).getByRole("radio", { name: /7 days/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("shows loading state", () => {
    renderWithProviders(
      <BackupsTab
        settings={undefined}
        isLoading={true}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/loading backup settings/i)).toBeInTheDocument();
  });
});
