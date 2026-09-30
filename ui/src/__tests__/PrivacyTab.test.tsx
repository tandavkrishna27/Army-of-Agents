import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./test-utils";
import { PrivacyTab } from "../components/settings/PrivacyTab";
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

describe("PrivacyTab", () => {
  it("renders all three sharing options", () => {
    renderWithProviders(
      <PrivacyTab
        settings={makeSettings()}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Always allow")).toBeInTheDocument();
    expect(screen.getByText("Don't allow")).toBeInTheDocument();
    expect(screen.getByText("Ask each time")).toBeInTheDocument();
  });

  it("marks the current preference as checked", () => {
    renderWithProviders(
      <PrivacyTab
        settings={makeSettings({ feedbackDataSharingPreference: "allowed" })}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
      />,
    );

    const allowed = screen.getByRole("radio", { name: /always allow/i });
    const notAllowed = screen.getByRole("radio", { name: /don't allow/i });
    expect(allowed).toHaveAttribute("aria-checked", "true");
    expect(notAllowed).toHaveAttribute("aria-checked", "false");
  });

  it("defaults to not_allowed when settings is undefined (privacy-first)", () => {
    renderWithProviders(
      <PrivacyTab
        settings={undefined}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
      />,
    );

    const notAllowed = screen.getByRole("radio", { name: /don't allow/i });
    expect(notAllowed).toHaveAttribute("aria-checked", "true");
  });

  it("calls onChange with the selected preference on click", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <PrivacyTab
        settings={makeSettings({ feedbackDataSharingPreference: "not_allowed" })}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /always allow/i }));
    expect(onChange).toHaveBeenCalledWith({ feedbackDataSharingPreference: "allowed" });

    await user.click(screen.getByRole("radio", { name: /ask each time/i }));
    expect(onChange).toHaveBeenCalledWith({ feedbackDataSharingPreference: "prompt" });
  });

  it("disables buttons while saving", () => {
    renderWithProviders(
      <PrivacyTab
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

  it("shows loading state", () => {
    renderWithProviders(
      <PrivacyTab
        settings={undefined}
        isLoading={true}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/loading privacy settings/i)).toBeInTheDocument();
  });

  it("shows error state", () => {
    renderWithProviders(
      <PrivacyTab
        settings={undefined}
        isLoading={false}
        error={new Error("boom")}
        isSaving={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/failed to load privacy settings/i)).toBeInTheDocument();
  });

  it("describes the local bundle path when sharing is allowed", () => {
    renderWithProviders(
      <PrivacyTab
        settings={makeSettings()}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
      />,
    );
    // F.4 removed the "not yet wired" banner — sharing is live now (bundles
    // write to local fs; transmission destination is still a deferred decision).
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByText(/~\/\.aoa\/feedback-exports\//)).toBeInTheDocument();
  });

  // ── Recent shared bundles (F.4) ──────────────────────────────────────────

  it("renders the 'Recent shared bundles' section heading", () => {
    renderWithProviders(
      <PrivacyTab
        settings={makeSettings()}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /recent shared bundles/i }),
    ).toBeInTheDocument();
  });

  it("shows empty state when bundleHistory is empty", () => {
    renderWithProviders(
      <PrivacyTab
        settings={makeSettings()}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
        bundleHistory={[]}
      />,
    );
    expect(screen.getByText(/no bundles shared yet/i)).toBeInTheDocument();
  });

  it("renders a row per bundle with timestamp + exportId + size", () => {
    renderWithProviders(
      <PrivacyTab
        settings={makeSettings()}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
        bundleHistory={[
          {
            id: "row-1",
            exportId: "fbexp_0123456789abcdef01234567",
            companyId: "c1",
            issueId: "i1",
            projectId: null,
            authorUserId: "u1",
            vote: "down",
            status: "local_only",
            destination: null,
            createdAt: "2026-04-22T10:23:00Z",
            sizeBytes: 4200,
          },
          {
            id: "row-2",
            exportId: "fbexp_abc",
            companyId: "c1",
            issueId: "i2",
            projectId: null,
            authorUserId: "u1",
            vote: "up",
            status: "local_only",
            destination: null,
            createdAt: "2026-04-21T16:15:00Z",
            sizeBytes: 2800,
          },
        ]}
      />,
    );
    // Two list rows.
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    // Truncated export id shown (slice(0, 18) + ellipsis).
    expect(screen.getByText(/fbexp_0123456789ab/)).toBeInTheDocument();
    // Formatted size.
    expect(screen.getByText(/4\.1 KB/)).toBeInTheDocument();
    expect(screen.getByText(/2\.7 KB/)).toBeInTheDocument();
  });

  it("shows loading state for the bundle history section", () => {
    renderWithProviders(
      <PrivacyTab
        settings={makeSettings()}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
        bundleHistoryLoading
      />,
    );
    expect(screen.getByText(/loading bundle history/i)).toBeInTheDocument();
  });

  it("shows error state for the bundle history section", () => {
    renderWithProviders(
      <PrivacyTab
        settings={makeSettings()}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={vi.fn()}
        bundleHistoryError={new Error("boom")}
      />,
    );
    expect(screen.getByText(/failed to load bundle history/i)).toBeInTheDocument();
  });

  it("preference toggle still works alongside bundle history", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <PrivacyTab
        settings={makeSettings({ feedbackDataSharingPreference: "not_allowed" })}
        isLoading={false}
        error={null}
        isSaving={false}
        onChange={onChange}
        bundleHistory={[]}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /always allow/i }));
    expect(onChange).toHaveBeenCalledWith({ feedbackDataSharingPreference: "allowed" });
  });
});
