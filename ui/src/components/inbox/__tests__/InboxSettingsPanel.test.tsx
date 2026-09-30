import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  HubAutopilotPolicy,
  HubPreferences,
  NotificationPreferences,
} from "@armyofagents/shared";
import { InboxSettingsPanel } from "../InboxSettingsPanel";
import type { HubItemListRow } from "@/api/hub-items";

function preferences(over: Partial<HubPreferences> = {}): HubPreferences {
  return {
    defaultLanding: "waiting_on_you",
    visibleLanes: ["waiting_on_you", "notifications", "suggestions"],
    groupMode: "auto",
    density: "comfortable",
    showAutopilotEntry: true,
    updatedAt: null,
    ...over,
  };
}

function autopilotPolicy(over: Partial<HubAutopilotPolicy> = {}): HubAutopilotPolicy {
  return {
    mode: "off",
    handledToday: 0,
    lastHandledAt: null,
    rules: [
      { semanticType: "approval_request", action: "none", minTrustScore: 100, enabled: false },
      { semanticType: "run_complete", action: "none", minTrustScore: 100, enabled: false },
    ],
    updatedAt: null,
    ...over,
  };
}

function notificationPreferences(
  over: Partial<NotificationPreferences> = {},
): NotificationPreferences {
  return {
    rules: [
      { semanticType: "approval_request", deliveryMode: "realtime", toastEnabled: true },
      { semanticType: "reminder", deliveryMode: "realtime", toastEnabled: true },
    ],
    quietHours: { enabled: false, start: "18:00", end: "09:00", timezone: "UTC" },
    digest: { enabled: true, cadence: "daily" },
    updatedAt: null,
    ...over,
  };
}

function renderPanel(over: Partial<React.ComponentProps<typeof InboxSettingsPanel>> = {}) {
  const props: React.ComponentProps<typeof InboxSettingsPanel> = {
    preferences: preferences(),
    onPreferencesChange: vi.fn(),
    autopilotPolicy: autopilotPolicy(),
    autopilotPending: false,
    onUpdateAutopilotPolicy: vi.fn(),
    onResetAutopilotPolicy: vi.fn(),
    notificationPreferences: notificationPreferences(),
    notificationPreferencesPending: false,
    onUpdateNotificationPreferences: vi.fn(),
    onResetNotificationPreferences: vi.fn(),
    digestItems: [] as HubItemListRow[],
    onAckDigest: vi.fn(),
    ...over,
  };
  return render(<InboxSettingsPanel {...props} />);
}

describe("InboxSettingsPanel", () => {
  it("renders the preference controls with the supplied values", () => {
    renderPanel();
    expect(screen.getByRole("combobox", { name: /default landing/i })).toHaveValue(
      "waiting_on_you",
    );
    expect(screen.getByRole("combobox", { name: /density/i })).toHaveValue("comfortable");
    expect(screen.getByRole("checkbox", { name: /autopilot entry/i })).toBeChecked();
  });

  it("disables the layout controls while a preferences save is pending", () => {
    // Prevents the rapid-toggle lost-update on the server-controlled selects and
    // signals the save is in flight (mirrors the Autopilot/Notification guards).
    renderPanel({ preferencesPending: true });
    expect(screen.getByRole("combobox", { name: /default landing/i })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /grouping/i })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /density/i })).toBeDisabled();
  });

  it("emits a preferences patch when density changes", async () => {
    const user = userEvent.setup();
    const onPreferencesChange = vi.fn();
    renderPanel({ onPreferencesChange });
    await user.selectOptions(screen.getByRole("combobox", { name: /density/i }), "compact");
    expect(onPreferencesChange).toHaveBeenCalledWith({ density: "compact" });
  });

  it("updates and resets Autopilot mode", async () => {
    const user = userEvent.setup();
    const onUpdateAutopilotPolicy = vi.fn();
    const onResetAutopilotPolicy = vi.fn();
    renderPanel({ onUpdateAutopilotPolicy, onResetAutopilotPolicy });
    await user.selectOptions(screen.getByRole("combobox", { name: /autopilot mode/i }), "drive");
    expect(onUpdateAutopilotPolicy).toHaveBeenCalledWith({ mode: "drive" });
    await user.click(screen.getByRole("button", { name: /reset autopilot/i }));
    expect(onResetAutopilotPolicy).toHaveBeenCalled();
  });

  it("keeps founder-gated categories out of auto-handle configuration", async () => {
    renderPanel();
    // "Approval Request" is a per-type row in BOTH the Autopilot rules and the
    // Notifications delivery table (both cards are now always-visible), so scope
    // the assertion to the Autopilot card to avoid a double-match.
    const autopilotCard = screen.getByRole("heading", { name: /^Autopilot$/ }).closest("section");
    expect(autopilotCard).not.toBeNull();
    expect(within(autopilotCard as HTMLElement).getByText("Approval Request")).toBeInTheDocument();
    expect(within(autopilotCard as HTMLElement).getByText(/founder-gated/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: /approval request autopilot action/i }),
    ).not.toBeInTheDocument();
  });

  it("opens notification preferences and changes delivery + toast + quiet hours", async () => {
    const user = userEvent.setup();
    const onUpdateNotificationPreferences = vi.fn();
    renderPanel({ onUpdateNotificationPreferences });
    // Notifications live in their own always-visible card now (no reveal click).
    expect(
      screen.getByRole("heading", { name: /^Notifications$/ }),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/reminder delivery/i), "digest");
    expect(onUpdateNotificationPreferences).toHaveBeenCalledWith({
      rules: expect.arrayContaining([
        expect.objectContaining({ semanticType: "reminder", deliveryMode: "digest" }),
      ]),
    });
    await user.click(screen.getByRole("checkbox", { name: /reminder toast/i }));
    expect(onUpdateNotificationPreferences).toHaveBeenCalledWith({
      rules: expect.arrayContaining([
        expect.objectContaining({ semanticType: "reminder", toastEnabled: false }),
      ]),
    });
    await user.click(screen.getByRole("checkbox", { name: /quiet hours/i }));
    expect(onUpdateNotificationPreferences).toHaveBeenCalledWith({
      quietHours: { enabled: true, start: "18:00", end: "09:00", timezone: "UTC" },
    });
  });

  it("acknowledges and resets from the notification panel", async () => {
    const user = userEvent.setup();
    const onAckDigest = vi.fn();
    const onResetNotificationPreferences = vi.fn();
    renderPanel({
      digestItems: [{ id: "digest-1", title: "Digest reminder" } as HubItemListRow],
      onAckDigest,
      onResetNotificationPreferences,
    });
    expect(screen.getByText("Digest reminder")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /acknowledge digest/i }));
    expect(onAckDigest).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /reset notification preferences/i }));
    expect(onResetNotificationPreferences).toHaveBeenCalled();
  });
});

describe("InboxSettingsPanel explanations", () => {
  it("explains each setting group in plain language", async () => {
    renderPanel();
    expect(
      screen.getByText(/which view opens when you land on the inbox/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/choose which lanes appear in the rail/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/how items are grouped in each lane/i)).toBeInTheDocument();
    expect(screen.getByText(/row height/i)).toBeInTheDocument();
    expect(
      screen.getByText(/let the hub act on items automatically/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/how and when each kind of update reaches you/i),
    ).toBeInTheDocument();
  });
});

describe("InboxSettingsPanel card structure", () => {
  it("renders the three settings cards", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: /^Layout$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Autopilot$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Notifications$/ })).toBeInTheDocument();
  });

  it("shows the Autopilot mode pill reflecting the current mode", () => {
    const { rerender } = renderPanel();
    expect(screen.getByTestId("autopilot-mode-pill")).toHaveTextContent(/^Off$/);
    rerender(
      <InboxSettingsPanel
        {...({
          preferences: preferences(),
          onPreferencesChange: vi.fn(),
          autopilotPolicy: autopilotPolicy({ mode: "drive" }),
          autopilotPending: false,
          onUpdateAutopilotPolicy: vi.fn(),
          onResetAutopilotPolicy: vi.fn(),
          notificationPreferences: notificationPreferences(),
          notificationPreferencesPending: false,
          onUpdateNotificationPreferences: vi.fn(),
          onResetNotificationPreferences: vi.fn(),
          digestItems: [],
          onAckDigest: vi.fn(),
        } as React.ComponentProps<typeof InboxSettingsPanel>)}
      />,
    );
    expect(screen.getByTestId("autopilot-mode-pill")).toHaveTextContent(/^Drive$/);
  });
});
