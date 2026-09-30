import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryCollapsedTabStrip } from "../MemoryCollapsedTabStrip";
import type { MemoryTab, TabKey } from "../../../lib/memoryTabs";

const tabs: MemoryTab[] = [
  { id: "memory-home", kind: "home", title: "Memory Home" },
  { id: "a", kind: "memory_item", title: "README.md" },
  { id: "b", kind: "asset", title: "logo.png" },
];

const activeKey: TabKey = { id: "a", kind: "memory_item" };

const baseProps = {
  tabs,
  activeKey,
  onActivate: () => {},
  onExpand: () => {},
};

describe("MemoryCollapsedTabStrip", () => {
  it("renders one icon per open tab", () => {
    const { container } = render(<MemoryCollapsedTabStrip {...baseProps} />);
    expect(container.querySelectorAll("[data-tab-id]")).toHaveLength(3);
  });

  it("activates and expands the Memory Home tab from the collapsed rail", () => {
    const onActivate = vi.fn();
    const { container } = render(
      <MemoryCollapsedTabStrip {...baseProps} onActivate={onActivate} />,
    );
    const homeBtn = container.querySelector(
      "[data-tab-id='memory-home'][data-tab-kind='home']",
    ) as HTMLElement;
    fireEvent.click(homeBtn);
    expect(onActivate).toHaveBeenCalledWith("memory-home", "home");
  });

  it("marks the active tab with data-active and brand wash", () => {
    const { container } = render(<MemoryCollapsedTabStrip {...baseProps} />);
    const active = container.querySelector("[data-active='true']");
    expect(active?.getAttribute("data-tab-id")).toBe("a");
    expect(active?.getAttribute("data-tab-kind")).toBe("memory_item");
    expect(active?.className).toContain("bg-brand/[0.08]");
  });

  it("disambiguates active by both id AND kind", () => {
    const tabs2: MemoryTab[] = [
      { id: "x", kind: "memory_item", title: "Item X" },
      { id: "x", kind: "asset", title: "Asset X" },
    ];
    const { container } = render(
      <MemoryCollapsedTabStrip
        {...baseProps}
        tabs={tabs2}
        activeKey={{ id: "x", kind: "asset" }}
      />,
    );
    const actives = container.querySelectorAll("[data-active='true']");
    expect(actives.length).toBe(1);
    expect(actives[0].getAttribute("data-tab-kind")).toBe("asset");
  });

  it("calls onActivate(id, kind) when an icon is clicked", () => {
    const onActivate = vi.fn();
    const { container } = render(
      <MemoryCollapsedTabStrip {...baseProps} onActivate={onActivate} />,
    );
    const inactiveBtn = container.querySelector(
      "[data-tab-id='b'][data-tab-kind='asset']",
    ) as HTMLElement;
    fireEvent.click(inactiveBtn);
    expect(onActivate).toHaveBeenCalledWith("b", "asset");
  });

  it("renders no tab icons when tabs is empty", () => {
    const { container } = render(
      <MemoryCollapsedTabStrip {...baseProps} tabs={[]} activeKey={null} />,
    );
    expect(container.querySelectorAll("[data-tab-id]")).toHaveLength(0);
  });

  it("renders an internal expand button in a 42px header", () => {
    const onExpand = vi.fn();
    const { getByTestId, getByLabelText } = render(
      <MemoryCollapsedTabStrip {...baseProps} onExpand={onExpand} />,
    );
    expect(getByTestId("memory-viewer-collapsed-header").className).toContain("h-[42px]");
    fireEvent.click(getByLabelText("Open viewer"));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});
