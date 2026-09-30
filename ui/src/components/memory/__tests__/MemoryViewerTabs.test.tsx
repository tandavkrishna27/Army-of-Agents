import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryViewerTabs } from "../MemoryViewerTabs";
import type { MemoryTab, TabKey } from "../../../lib/memoryTabs";

const tabs: MemoryTab[] = [
  { id: "a", kind: "memory_item", title: "README.md" },
  { id: "b", kind: "asset", title: "logo.png" },
  { id: "c", kind: "memory_item", title: "Operating principles" },
];

const activeKey: TabKey = { id: "a", kind: "memory_item" };

const baseProps = {
  tabs,
  activeKey,
  onActivate: () => {},
  onClose: () => {},
};

describe("MemoryViewerTabs", () => {
  it("renders one tab per entry with the title visible", () => {
    const { getByText } = render(<MemoryViewerTabs {...baseProps} />);
    expect(getByText("README.md")).toBeInTheDocument();
    expect(getByText("logo.png")).toBeInTheDocument();
    expect(getByText("Operating principles")).toBeInTheDocument();
  });

  it("marks the active tab via data-active and applies brand classes", () => {
    const { container } = render(<MemoryViewerTabs {...baseProps} />);
    const activeTab = container.querySelector("[data-active='true']");
    expect(activeTab?.textContent).toContain("README.md");
    expect(activeTab?.className).toContain("bg-brand/[0.08]");
  });

  it("disambiguates the active tab by both id AND kind", () => {
    const tabs2: MemoryTab[] = [
      { id: "x", kind: "memory_item", title: "Item X" },
      { id: "x", kind: "asset", title: "Asset X" },
    ];
    const { container } = render(
      <MemoryViewerTabs
        {...baseProps}
        tabs={tabs2}
        activeKey={{ id: "x", kind: "asset" }}
      />,
    );
    const activeTabs = container.querySelectorAll("[data-active='true']");
    expect(activeTabs.length).toBe(1);
    expect(activeTabs[0].textContent).toContain("Asset X");
  });

  it("calls onActivate(id, kind) when a tab body is clicked", () => {
    const onActivate = vi.fn();
    const { getByText } = render(
      <MemoryViewerTabs {...baseProps} onActivate={onActivate} />,
    );
    fireEvent.click(getByText("logo.png"));
    expect(onActivate).toHaveBeenCalledWith("b", "asset");
  });

  it("calls onClose(id, kind) when the close button is clicked, without triggering onActivate", () => {
    const onActivate = vi.fn();
    const onClose = vi.fn();
    const { container } = render(
      <MemoryViewerTabs
        {...baseProps}
        onActivate={onActivate}
        onClose={onClose}
      />,
    );
    const closeBtn = container.querySelector(
      "[data-tab-id='b'][data-tab-kind='asset'] [data-slot='close']",
    ) as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn!);
    expect(onClose).toHaveBeenCalledWith("b", "asset");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("renders no tabs when tabs is empty", () => {
    const { container } = render(
      <MemoryViewerTabs {...baseProps} tabs={[]} activeKey={null} />,
    );
    expect(container.querySelectorAll("[data-tab-id]")).toHaveLength(0);
  });
});
