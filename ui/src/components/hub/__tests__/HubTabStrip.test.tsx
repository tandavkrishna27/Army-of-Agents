import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HubTabStrip, HUB_TABPANEL_ID } from "../HubTabStrip";
import { HOME_TAB, approvalTab, browserTab, threadTab, type HubTab } from "../hubViewerModel";
import { HUB_TABS_MAX } from "../useHubTabs";

const TABS: HubTab[] = [
  HOME_TAB,
  approvalTab("approval-1", "Review hire"),
  threadTab("thread-1", "Roadmap thread"),
];

function tabsAtCapacity() {
  const closeables = Array.from({ length: HUB_TABS_MAX - 1 }, (_, i) =>
    browserTab(`https://x/${i}`, `T${i}`),
  );
  return [HOME_TAB, ...closeables];
}

function renderStrip(overrides: Partial<React.ComponentProps<typeof HubTabStrip>> = {}) {
  const props = {
    tabs: TABS,
    activeKey: "approval:approval-1",
    onActivate: vi.fn(),
    onClose: vi.fn(),
    onAddBrowser: vi.fn(),
    ...overrides,
  } satisfies React.ComponentProps<typeof HubTabStrip>;
  return { ...render(<HubTabStrip {...props} />), props };
}

describe("HubTabStrip", () => {
  it("renders a tablist with one tab per tab and correct aria-selected", () => {
    renderStrip();

    expect(screen.getByRole("tablist", { name: /open hub tabs/i })).toBeInTheDocument();

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(TABS.length);

    const active = screen.getByRole("tab", { name: /review hire/i });
    expect(active).toHaveAttribute("aria-selected", "true");

    const home = screen.getByRole("tab", { name: /home/i });
    expect(home).toHaveAttribute("aria-selected", "false");
    const thread = screen.getByRole("tab", { name: /roadmap thread/i });
    expect(thread).toHaveAttribute("aria-selected", "false");
  });

  it("gives every tab aria-controls pointing at the viewer body panel", () => {
    renderStrip();

    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toHaveAttribute("aria-controls", HUB_TABPANEL_ID);
    }
  });

  it("calls onActivate with the tab key when a tab is clicked", async () => {
    const user = userEvent.setup();
    const { props } = renderStrip();

    await user.click(screen.getByRole("tab", { name: /roadmap thread/i }));

    expect(props.onActivate).toHaveBeenCalledWith("thread:thread-1");
  });

  it("closes a closeable tab via its × without also activating it", async () => {
    const user = userEvent.setup();
    const { props } = renderStrip();

    const thread = screen.getByRole("tab", { name: /roadmap thread/i });
    await user.click(within(thread).getByRole("button", { name: /close roadmap thread/i }));

    expect(props.onClose).toHaveBeenCalledWith("thread:thread-1");
    expect(props.onActivate).not.toHaveBeenCalled();
  });

  it("does not render a close button on the non-closeable Home tab", () => {
    renderStrip();

    const home = screen.getByRole("tab", { name: /home/i });
    expect(within(home).queryByRole("button", { name: /close/i })).not.toBeInTheDocument();
  });

  it("calls onAddBrowser when the + button is clicked", async () => {
    const user = userEvent.setup();
    const { props } = renderStrip();

    await user.click(screen.getByRole("button", { name: /open browser tab/i }));

    expect(props.onAddBrowser).toHaveBeenCalledTimes(1);
  });

  it("renders the collapsed icon rail with an expand control", async () => {
    const user = userEvent.setup();
    const onToggleCollapse = vi.fn();
    renderStrip({ collapsed: true, onToggleCollapse });

    // No horizontal tablist in collapsed mode.
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    // One icon button per tab.
    expect(screen.getByRole("button", { name: /home/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /review hire/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /expand tabs/i }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it("activates a tab from the collapsed rail", async () => {
    const user = userEvent.setup();
    const { props } = renderStrip({ collapsed: true, onToggleCollapse: vi.fn() });

    await user.click(screen.getByRole("button", { name: /roadmap thread/i }));

    expect(props.onActivate).toHaveBeenCalledWith("thread:thread-1");
  });

  it("shows a '12 max' indicator only when at capacity", () => {
    const { rerender, props } = renderStrip({ tabs: [HOME_TAB], activeKey: "home" });
    expect(screen.queryByText(/12 max/i)).toBeNull();

    rerender(<HubTabStrip {...props} tabs={tabsAtCapacity()} />);
    expect(screen.getByText(/12 max/i)).toBeInTheDocument();
  });
});
