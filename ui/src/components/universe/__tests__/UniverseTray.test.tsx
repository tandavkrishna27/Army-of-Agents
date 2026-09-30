import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UniverseTray, type UniverseTrayProps } from "../UniverseTray";
import type { OpenPanelTile } from "../OpenPanelsOverview";

const openPanels: OpenPanelTile[] = [
  { key: "k-c", title: "Gamma", kind: "artifact", openedOrdinal: 3, minimized: true },
  { key: "k-a", title: "Alpha", kind: "task", openedOrdinal: 1, minimized: false },
  { key: "k-b", title: "Beta", kind: "task", openedOrdinal: 2, minimized: false },
];

function renderTray(props: Partial<UniverseTrayProps> = {}) {
  const onOpenReference = vi.fn();
  const onOpenPanel = vi.fn();
  const onCommanderPrimary = vi.fn();
  const onToggleCommander = vi.fn();
  const utils = render(
    <UniverseTray
      openPanels={openPanels}
      menuItems={{
        work: [
          { key: "w1", label: "Ship the tray" },
          { key: "w2", label: "Write the tests" },
        ],
        inbox: [{ key: "i1", label: "Approve dispatch" }],
      }}
      counts={{ inbox: 3, work: 0 }}
      commanderConversations={[{ key: "conv1", label: "Planning chat" }]}
      commanderToggles={{ chat: true, blob: false, captions: false }}
      onOpenReference={onOpenReference}
      onOpenPanel={onOpenPanel}
      onCommanderPrimary={onCommanderPrimary}
      onToggleCommander={onToggleCommander}
      {...props}
    />
  );
  return { ...utils, onOpenReference, onOpenPanel, onCommanderPrimary, onToggleCommander };
}

describe("UniverseTray", () => {
  it("opens a menu with accessible ownership (aria-expanded + aria-controls → popup)", async () => {
    const user = userEvent.setup();
    renderTray();
    const work = screen.getByRole("button", { name: "Work" });
    expect(work).toHaveAttribute("aria-expanded", "false");
    await user.click(work);
    const popup = screen.getByRole("dialog", { name: "Work" });
    expect(work).toHaveAttribute("aria-expanded", "true");
    expect(work).toHaveAttribute("aria-controls", popup.id);
  });

  it("opening Work then Inbox replaces the menu (only one open)", async () => {
    const user = userEvent.setup();
    renderTray();
    await user.click(screen.getByRole("button", { name: "Work" }));
    await user.click(screen.getByRole("button", { name: "Inbox" }));
    expect(screen.getByRole("dialog", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Work" })).toBeNull();
  });

  it("renders a badge only for nonzero counts", () => {
    renderTray();
    // Inbox count is 3 → badge; Work count is 0 → none.
    expect(within(screen.getByRole("button", { name: "Inbox" })).getByText("3")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: "Work" })).queryByText("0")).toBeNull();
  });

  it("Escape dismisses the menu and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    renderTray();
    const work = screen.getByRole("button", { name: "Work" });
    await user.click(work);
    expect(screen.getByRole("dialog", { name: "Work" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Work" })).toBeNull();
    expect(work).toHaveFocus();
  });

  it("selecting a library item resolves the reference and closes the menu", async () => {
    const user = userEvent.setup();
    const { onOpenReference } = renderTray();
    await user.click(screen.getByRole("button", { name: "Work" }));
    await user.click(screen.getByRole("button", { name: "Ship the tray" }));
    expect(onOpenReference).toHaveBeenCalledWith("work", "w1");
    expect(screen.queryByRole("dialog", { name: "Work" })).toBeNull();
  });

  it("scoped search filters the menu list", async () => {
    const user = userEvent.setup();
    renderTray();
    await user.click(screen.getByRole("button", { name: "Work" }));
    await user.type(screen.getByRole("searchbox", { name: "Search Work" }), "tests");
    expect(screen.getByRole("button", { name: "Write the tests" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ship the tray" })).toBeNull();
  });

  it("Commander primary acts without opening a menu; options exposes the toggles", async () => {
    const user = userEvent.setup();
    const { onCommanderPrimary } = renderTray();
    await user.click(screen.getByRole("button", { name: "Commander" }));
    expect(onCommanderPrimary).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Commander options" }));
    const popup = screen.getByRole("dialog", { name: "Commander options" });
    expect(within(popup).getByRole("checkbox", { name: "Chat" })).toBeChecked();
    expect(within(popup).getByRole("checkbox", { name: "Blob" })).not.toBeChecked();
    expect(within(popup).getByRole("checkbox", { name: "Captions" })).toBeInTheDocument();
  });

  it("the open-panels overview lists tiles sorted by openedOrdinal and restores on select", async () => {
    const user = userEvent.setup();
    const { onOpenPanel } = renderTray();
    await user.click(screen.getByRole("button", { name: "Open panels" }));
    const tiles = screen.getAllByRole("button").filter((b) =>
      b.className.includes("universe-overview-tile")
    );
    expect(tiles.map((t) => t.querySelector(".universe-overview-title")?.textContent)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    await user.click(tiles[0]!);
    expect(onOpenPanel).toHaveBeenCalledWith("k-a");
  });

  it("the logo collapses the wings (menus and icons hidden)", async () => {
    const user = userEvent.setup();
    renderTray();
    expect(screen.getByRole("button", { name: "Work" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Universe menu" }));
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull();
  });

  it("dismisses an open menu when its authorization scope changes", async () => {
    const user = userEvent.setup();
    const view = renderTray({ scopeKey: "company-a:conversation-a" });
    await user.click(screen.getByRole("button", { name: "Work" }));
    expect(screen.getByRole("dialog", { name: "Work" })).toBeInTheDocument();
    view.rerender(<UniverseTray {...({
      openPanels: [], onOpenReference: vi.fn(), onOpenPanel: vi.fn(), onCommanderPrimary: vi.fn(),
      scopeKey: "company-a:conversation-b",
    } satisfies UniverseTrayProps)} />);
    expect(screen.queryByRole("dialog", { name: "Work" })).toBeNull();
  });

  it("auto-hides after pointer leave and reveals on the next entry", () => {
    renderTray({ dockHiding: "auto" });
    const tray = screen.getByRole("navigation", { name: "Universe" });
    fireEvent.pointerLeave(tray);
    expect(screen.queryByRole("button", { name: "Work" })).toBeNull();
    fireEvent.pointerEnter(tray);
    expect(screen.getByRole("button", { name: "Work" })).toBeInTheDocument();
  });
});
